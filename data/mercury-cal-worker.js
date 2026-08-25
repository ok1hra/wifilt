// Mercury's own TX-gain calibration (docs/mercury-implementace.md ch.8).
// Reuses tx-gain-cal.js's TxGainCal/TxGainStore UNMODIFIED -- the search
// itself (bracket up/down, bisect, hold, byte-gated not timer-gated) does
// not care what waveform is riding on the gain it is adjusting. What it
// must never reuse is JS8/WSPR's carrier: their TUNE is a single tone
// (~0dB PAPR); a real Mercury OFDM burst measures ~7.5dB PAPR even after
// freedv's own clipping (prototype/mercury-prototype/check-cal-burst.js).
// The same peak-normalised gain means a very different real drive level
// between the two, so calibrating with a tone and applying the result to
// data would let ALC "trample the data" (doc's own words) -- hence this
// modulates a REAL DATAC1 burst (no ARQ session/peer needed: content is
// arbitrary, only the mode's real waveform shape matters for a drive
// calibration) and stores the result under its OWN key
// (/mercury-txgain.json, not JS8/WSPR's /txgain.json).
importScripts("mercury-host.js");
importScripts("js8-aud1.js");
importScripts("tx-gain-cal.js");

const { TxGainCal: TxGainCalClass, TxGainStore, entryKey, bandOf } = self.TxGainCal;

const FREEDV_MODE_DATAC1 = 10;
const SAMPLE_RATE = 48000, PACKET_MS = 20, SAMPLES_PER_PACKET = (SAMPLE_RATE * PACKET_MS) / 1000;
const LOOP_MARGIN_S = 90; // generous declared duration -- doc's own gain search finishes well inside this; tx.abort ends it early once done
const MERCURY_TXGAIN_URL = "/mercury-txgain.json";

function post(fields) { postMessage(fields); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clamp16(v) { return Math.max(-32768, Math.min(32767, v)); }

function upsample8kTo48k(int16In) {
  const n = int16In.length;
  const out = new Int16Array(Math.max(0, n - 1) * 6 + (n > 0 ? 6 : 0));
  for (let i = 0; i < n; i++) {
    const a = int16In[i];
    const b = i + 1 < n ? int16In[i + 1] : int16In[i];
    for (let j = 0; j < 6; j++) out[i * 6 + j] = Math.round(a + (b - a) * (j / 6));
  }
  return out;
}

function buildTxPacket({ streamId, txId, sequence, sampleRate, firstSample, pcm, first, last }) {
  const wire = new Uint8Array(40 + pcm.length * 2);
  const view = new DataView(wire.buffer);
  wire.set([0x41, 0x55, 0x44, 0x31], 0);
  wire[4] = 1; wire[5] = 3;
  view.setUint16(6, (first ? 1 : 0) | (last ? 2 : 0), false);
  view.setUint16(8, 40, false);
  view.setUint32(12, streamId >>> 0, false);
  view.setUint32(16, sequence >>> 0, false);
  view.setUint32(20, sampleRate >>> 0, false);
  view.setBigUint64(24, BigInt(firstSample), false);
  view.setUint32(32, txId >>> 0, false);
  view.setUint32(36, pcm.length * 2, false);
  for (let i = 0; i < pcm.length; i++) view.setInt16(40 + i * 2, pcm[i], true);
  return wire;
}

let stopping = false;

async function main(config) {
  const { wsPort, token, model, frequencyHz, percent, knownKnee } = config;
  const band = bandOf(frequencyHz);

  let m;
  try { m = await createMercuryHost(); }
  catch (e) { post({ type: "error", reason: "wasm init failed", detail: e && e.message || String(e) }); return; }
  const cw = (name, ret, args) => m.cwrap(name, ret, args);
  const modePayloadBytes = cw("host_mode_payload_bytes", "number", ["number"]);
  const txStart = cw("host_tx_start", "number", ["number", "number", "number"]);
  const txPtrGet = cw("host_tx_ptr", "number", []);

  const payloadLen = modePayloadBytes(FREEDV_MODE_DATAC1);
  if (!(payloadLen > 0)) { post({ type: "error", reason: "bad DATAC1 payload length", detail: String(payloadLen) }); return; }
  // Content is arbitrary -- a calibration probe, not a real transfer -- so a
  // zero-filled dummy payload is exactly as valid as real data for this.
  const dummy = new Uint8Array(payloadLen);
  const dummyPtr = m._malloc(payloadLen);
  m.HEAPU8.set(dummy, dummyPtr);
  const sampleCount8k = txStart(FREEDV_MODE_DATAC1, dummyPtr, payloadLen);
  m._free(dummyPtr);
  if (!(sampleCount8k > 0)) { post({ type: "error", reason: "burst modulation failed", detail: String(sampleCount8k) }); return; }
  const samples8k = new Int16Array(sampleCount8k);
  for (let i = 0; i < sampleCount8k; i++) samples8k[i] = m.HEAP16[(txPtrGet() >> 1) + i];
  const unit48k = upsample8kTo48k(samples8k); // one loop unit, looped indefinitely below

  const session = new Js8Aud1Transport.Aud1WebSocketSession({
    url: `ws://${location.hostname}:${wsPort}/audiows?token=${encodeURIComponent(token)}`,
    WebSocketImpl: WebSocket, wallNow: () => Date.now(),
  });
  let resolveReady = null;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  session.onStatus((s) => {
    if (s.type === "ready") resolveReady(s);
    else if (s.type === "closed" || s.type === "protocol-error") post({ type: "error", reason: "audio session", detail: s.message || s.type });
  });
  session.start();

  const helloOrTimeout = await Promise.race([ready.then(() => "ready"), sleep(8000).then(() => "timeout")]);
  if (helloOrTimeout !== "ready") { session.stop(); post({ type: "error", reason: "no AUD1 hello", detail: helloOrTimeout }); return; }
  await sleep(2000); // audioTxReady() lag on the firmware side

  if (stopping) { session.stop(); return; }

  const cal = new TxGainCalClass();
  cal.begin({ knownKnee: knownKnee || 0 });

  let amplitude = cal.gain, ramp = null, sentSamples = 0;
  function amplitudeAt(at) {
    if (!ramp) return amplitude;
    if (at <= ramp.start) return ramp.from;
    if (at >= ramp.start + ramp.samples) return ramp.to;
    return ramp.from + (ramp.to - ramp.from) * ((at - ramp.start) / ramp.samples);
  }
  function setAmplitude(target, rampSamples) {
    if (!(rampSamples > 0)) { ramp = null; amplitude = target; return; }
    ramp = { from: amplitudeAt(sentSamples), to: target, start: sentSamples, samples: rampSamples };
    amplitude = target;
  }

  const txId = 1;
  let doneStopping = false;
  session.onControl((msg) => {
    if (msg.type !== "tx-level") return;
    // tx-level's `consumed`/`alc`/`alcSeq` are already in 8kHz-mu-law-
    // equivalent units regardless of the 48kHz PCM16 wire (same field the
    // firmware reports for JS8/WSPR's own ulaw TX) -- noteSent needs the
    // same units, so sentSamples (48kHz) is divided by 6.
    cal.noteSent(Math.floor(sentSamples / 6));
    cal.noteLevel({ consumed: msg.consumed, alc: msg.alc, alcSeq: msg.alcSeq });
    if (Math.abs(amplitude - cal.gain) > 1e-6) setAmplitude(cal.gain, cal.config.rampBytes * 6);
    post({ type: "progress", state: cal.state, phase: cal.phase, gain: cal.gain, steps: cal.steps, alcMax: cal.alcMax });
    if (!doneStopping && (cal.state === "done" || cal.state === "failed")) {
      doneStopping = true;
      session.abort(txId, "operator");
    }
  });

  const totalSamples = SAMPLE_RATE * LOOP_MARGIN_S;
  const totalPackets = Math.ceil(totalSamples / SAMPLES_PER_PACKET);
  const slotUtcMs = Date.now() + 1500;
  const prebufferSamples = 48000;

  let prepareOk = false;
  try {
    await session.prepare(txId, {
      slotUtcMs, prebufferSamples, packetMs: PACKET_MS, alcFast: true,
      samples: totalSamples, packets: totalPackets, mode: "MERCURY-CAL-DATAC1", toneHz: 0,
    });
    prepareOk = true;
  } catch (e) { post({ type: "error", reason: "tx.prepare failed", detail: e && e.message || String(e) }); }
  if (!prepareOk) { session.stop(); return; }

  const startAt = slotUtcMs - (prebufferSamples / SAMPLE_RATE) * 1000;
  await sleep(Math.max(0, startAt - Date.now()));
  session.begin(txId);

  let firstSample = 0, aborted = false;
  for (let seq = 0; seq < totalPackets; seq++) {
    if (doneStopping || stopping) { aborted = true; break; }
    const pcm = new Int16Array(SAMPLES_PER_PACKET);
    for (let i = 0; i < SAMPLES_PER_PACKET; i++) {
      const at = firstSample + i;
      pcm[i] = clamp16(Math.round(unit48k[at % unit48k.length] * amplitudeAt(at)));
    }
    const wire = buildTxPacket({
      streamId: session.hello.streamId, txId, sequence: seq, sampleRate: SAMPLE_RATE,
      firstSample, pcm, first: seq === 0, last: seq === totalPackets - 1,
    });
    try { session.write(wire); } catch (e) { post({ type: "log", line: `write error: ${e.message}` }); aborted = true; break; }
    sentSamples += pcm.length; firstSample += pcm.length;
    const targetTime = startAt + (seq + 1) * PACKET_MS;
    await sleep(Math.max(0, targetTime - Date.now()));
  }
  if (!aborted) session.end(txId);
  await Promise.race([
    new Promise((resolve) => { const c = () => { if (session.isDrained(txId) || doneStopping) resolve(); else setTimeout(c, 100); }; c(); }),
    sleep(8000),
  ]);
  session.complete(txId);
  session.stop();

  // A ceiling result is NOT a calibration -- same reasoning as
  // tx-gain-cal-ui.js's own finish(): "the level reached the ceiling and the
  // radio never limited" means no knee was found, so storing that gain as
  // usable would let a real burst go out at an unvalidated level the next
  // time this key is looked up.
  if (cal.state === "done" && cal.result && !cal.result.reachedCeiling) {
    try {
      const store = new TxGainStore({ url: MERCURY_TXGAIN_URL });
      const key = entryKey(model, band, percent);
      await store.put(key, { ...cal.result, model, band, percent, modLevel: config.modLevel || 0 });
      post({ type: "stored", key });
    } catch (e) { post({ type: "log", line: `store failed: ${e && e.message || e}` }); }
  }

  post({ type: "done", ok: cal.state === "done", state: cal.state, error: cal.error, result: cal.result });
}

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === "start") main(msg).catch((e) => post({ type: "error", reason: "threw", detail: e && e.stack || String(e) }));
  else if (msg.type === "stop") stopping = true;
};
