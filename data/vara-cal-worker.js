// XARA's own TX-gain calibration: data/mercury-cal-worker.js with an XARA
// carrier. The search is tx-gain-cal.js's TxGainCal, unmodified (bracket,
// bisect, hold, gated on the bytes the radio has actually played); what is
// XARA's is the waveform riding on the gain. A real OFDM data frame of the
// fastest level -- about 11 dB of crest factor, peak-normalised by the modem
// itself (Modulator.gain at 0 dB drive) -- looped for the whole run. A tone
// would put the knee somewhere the data never is, which is why JS8/WSPR's
// /txgain.json is not used either: results go to /vara-txgain.json.
//
// The gain found here multiplies that 0 dB-drive frame. The page turns it into
// the worker's multiplier for whatever Drive the station runs at
// (data/vara.js resolvedGain), so a calibrated station ignores Drive.
const ASSET_QUERY = self.location.search;
importScripts("js8-aud1.js" + ASSET_QUERY, "tx-gain-cal.js" + ASSET_QUERY, "vara-modem.js" + ASSET_QUERY);

const {TxGainCal: TxGainCalClass, TxGainStore, entryKey, bandOf} = self.TxGainCal;
const M = self.VaraModem;

const SAMPLE_RATE = 48000, PACKET_MS = 20, SAMPLES_PER_PACKET = SAMPLE_RATE * PACKET_MS / 1000;
const LOOP_MARGIN_S = 90; // declared length; the search ends it long before
const VARA_TXGAIN_URL = "/vara-txgain.json";

function post(fields) { postMessage(fields); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function buildTxPacket({streamId, txId, sequence, firstSample, pcm, first, last}) {
  const wire = new Uint8Array(40 + pcm.length * 2), view = new DataView(wire.buffer);
  wire.set([0x41, 0x55, 0x44, 0x31], 0);
  wire[4] = 1; wire[5] = 3;
  view.setUint16(6, (first ? 1 : 0) | (last ? 2 : 0), false);
  view.setUint16(8, 40, false);
  view.setUint32(12, streamId >>> 0, false);
  view.setUint32(16, sequence >>> 0, false);
  view.setUint32(20, SAMPLE_RATE, false);
  view.setBigUint64(24, BigInt(firstSample), false);
  view.setUint32(32, txId >>> 0, false);
  view.setUint32(36, pcm.length * 2, false);
  for (let i = 0; i < pcm.length; i++) view.setInt16(40 + i * 2, pcm[i], true);
  return wire;
}

// The fastest OFDM level of the bandwidth the station runs (record 17 is not a
// data level), one random frame: content does not matter, the shape does.
function calibrationFrame(bwHz) {
  const bw = M.bandwidth(bwHz) || M.BW2300, mo = new M.Modulator(bw);
  let rec = M.RECORDS - 1;
  while (rec > 1 && (!bw.level(rec) || bw.level(rec).isFsk)) rec--;
  const level = bw.level(rec);
  let seed = 0x5eed;
  const rand = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  const frame = new Uint8Array(level.frameBytes).map(() => rand(256));
  const x = mo.transmission(rec, [frame], rand), g = mo.gain(rec, 0);
  const unit = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) unit[i] = x[i] * g;
  return {unit, rec, bw: bw.hz};
}

let stopping = false;

async function main(config) {
  const {wsPort, token, model, frequencyHz, percent, knownKnee} = config;
  const band = bandOf(frequencyHz);
  const {unit, rec, bw} = calibrationFrame(Number(config.bw) || 2300);
  post({type: "log", line: `carrier: XARA ${bw} Hz level ${rec}, ${(unit.length / SAMPLE_RATE).toFixed(2)} s loop`});

  const session = new Js8Aud1Transport.Aud1WebSocketSession({
    url: `ws://${location.hostname}:${wsPort}/audiows?token=${encodeURIComponent(token)}`,
    WebSocketImpl: WebSocket, wallNow: () => Date.now(),
  });
  let resolveReady = null;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  session.onStatus(s => {
    if (s.type === "ready") resolveReady(s);
    else if (s.type === "closed" || s.type === "protocol-error") post({type: "error", reason: "audio session", detail: s.message || s.type});
  });
  session.start();
  const hello = await Promise.race([ready.then(() => "ready"), sleep(8000).then(() => "timeout")]);
  if (hello !== "ready") { session.stop(); post({type: "error", reason: "no AUD1 hello", detail: hello}); return; }
  await sleep(2000); // the firmware's audioTxReady() lag
  if (stopping) { session.stop(); return; }

  const cal = new TxGainCalClass();
  cal.begin({knownKnee: knownKnee || 0});
  let amplitude = cal.gain, ramp = null, sentSamples = 0;
  const amplitudeAt = at => {
    if (!ramp) return amplitude;
    if (at <= ramp.start) return ramp.from;
    if (at >= ramp.start + ramp.samples) return ramp.to;
    return ramp.from + (ramp.to - ramp.from) * ((at - ramp.start) / ramp.samples);
  };
  const setAmplitude = (target, rampSamples) => {
    ramp = {from: amplitudeAt(sentSamples), to: target, start: sentSamples, samples: rampSamples};
    amplitude = target;
  };

  const txId = 1;
  let done = false;
  session.onControl(msg => {
    if (msg.type !== "tx-level") return;
    // tx-level counts in 8 kHz µ-law-equivalent units whatever the wire is.
    cal.noteSent(Math.floor(sentSamples / 6));
    cal.noteLevel({consumed: msg.consumed, alc: msg.alc, alcSeq: msg.alcSeq});
    if (Math.abs(amplitude - cal.gain) > 1e-6) setAmplitude(cal.gain, cal.config.rampBytes * 6);
    post({type: "progress", state: cal.state, phase: cal.phase, gain: cal.gain, steps: cal.steps, alcMax: cal.alcMax});
    if (!done && (cal.state === "done" || cal.state === "failed")) { done = true; session.abort(txId, "operator"); }
  });

  const totalSamples = SAMPLE_RATE * LOOP_MARGIN_S, totalPackets = Math.ceil(totalSamples / SAMPLES_PER_PACKET);
  const slotUtcMs = Date.now() + 1500, prebufferSamples = 48000;
  try {
    await session.prepare(txId, {slotUtcMs, prebufferSamples, packetMs: PACKET_MS, alcFast: true,
      samples: totalSamples, packets: totalPackets, mode: "XARA-CAL", toneHz: 0});
  } catch (e) {
    post({type: "error", reason: "tx.prepare failed", detail: e && e.message || String(e)});
    session.stop(); return;
  }
  const startAt = slotUtcMs - prebufferSamples / SAMPLE_RATE * 1000;
  await sleep(Math.max(0, startAt - Date.now()));
  session.begin(txId);

  let firstSample = 0, aborted = false;
  for (let seq = 0; seq < totalPackets; seq++) {
    if (done || stopping) { aborted = true; break; }
    const pcm = new Int16Array(SAMPLES_PER_PACKET);
    for (let i = 0; i < SAMPLES_PER_PACKET; i++) {
      const at = firstSample + i, v = Math.round(unit[at % unit.length] * amplitudeAt(at) * 32767);
      pcm[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    try {
      session.write(buildTxPacket({streamId: session.hello.streamId, txId, sequence: seq, firstSample, pcm,
        first: seq === 0, last: seq === totalPackets - 1}));
    } catch (e) { post({type: "log", line: `write error: ${e.message}`}); aborted = true; break; }
    sentSamples += pcm.length; firstSample += pcm.length;
    await sleep(Math.max(0, startAt + (seq + 1) * PACKET_MS - Date.now()));
  }
  if (!aborted) session.end(txId);
  await Promise.race([
    new Promise(resolve => { const c = () => (session.isDrained(txId) || done ? resolve() : setTimeout(c, 100)); c(); }),
    sleep(8000),
  ]);
  session.complete(txId);
  session.stop();

  // A ceiling is not a knee (tx-gain-cal-ui.js finish()): nothing to store.
  if (cal.state === "done" && cal.result && !cal.result.reachedCeiling) {
    try {
      const store = new TxGainStore({url: VARA_TXGAIN_URL});
      const key = entryKey(model, band, percent);
      await store.put(key, {...cal.result, model, band, percent, modLevel: config.modLevel || 0, bw, record: rec});
      post({type: "stored", key});
    } catch (e) { post({type: "log", line: `store failed: ${e && e.message || e}`}); }
  }
  post({type: "done", ok: cal.state === "done", state: cal.state, error: cal.error, result: cal.result});
}

self.onmessage = event => {
  const msg = event.data || {};
  if (msg.type === "start") main(msg).catch(e => post({type: "error", reason: "threw", detail: e && e.stack || String(e)}));
  else if (msg.type === "stop") stopping = true;
};
