// First real-AUD1-transport check for Mercury (E2, docs/mercury-implementace.md
// ch.4.2): runs inside a real browser Worker, connects to the REAL production
// AUD1 WebSocket (data/js8-aud1.js's Aud1WebSocketSession, imported unmodified
// from the real data/ tree -- not a copy) served by a REAL native `wifilt`
// binary against tools/icom-lan-fake-radio.py (see ../../../tools/
// native-integration-test.sh for that pairing's own track record).
//
// Does ONE real tx.prepare -> 20ms-paced TX_PCM16 stream -> tx-drained cycle
// for a real Mercury CALL frame (mode=DATAC16), built by the exact same
// host_tx_start() this prototype's other benches already proved. The 8 kHz
// freedv output has to become 48 kHz PCM16 for the wire -- freedv's native
// rate, fixed -- so this is also the first use of a resampler, deliberately
// simple (linear interpolation, no anti-imaging filter): adequate to prove
// the AUD1 slot/prebuffer/pacing state machine end to end, not a claim about
// real transmitted spectral cleanliness, which needs real hardware to judge.
//
// RX: whatever the fake radio's audio channel actually carries (silence, most
// likely -- it simulates the CI-V/network protocol, not real RF coupling) gets
// pushed into host_rx_push() too, just to prove that direction doesn't crash.
importScripts("mercury-host.js");
importScripts("js8-aud1.js");

const checks = [];
function check(name, pass, detail = "") { checks.push([name, Boolean(pass), String(detail)]); }
function report() { postMessage({ checks }); }

const params = new URLSearchParams(location.search);
const wsPort = params.get("wsPort");
const token = params.get("token");

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

// AUD1 v1 kind 3 (TX_PCM16) wire frame -- byte-for-byte the same layout
// wspr-core.js's nextPacket() already ships in production.
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

async function main() {
  if (!wsPort || !token) { check("worker got wsPort+token", false, `wsPort=${wsPort} token=${token}`); return report(); }

  const m = await createMercuryHost();
  check("wasm module instantiated", true);
  const cw = (name, ret, args) => m.cwrap(name, ret, args);
  const init = cw("host_init", null, []);
  const epCreate = cw("host_endpoint_create", "number", ["string", "string"]);
  const connect = cw("host_connect", null, ["number", "string"]);
  const takeOutframe = cw("host_take_outframe", "number", ["number"]);
  const ofLen = cw("host_of_len", "number", []);
  const ofMode = cw("host_of_mode", "number", []);
  const ofBuf = cw("host_of_buf", "number", []);
  const txStart = cw("host_tx_start", "number", ["number", "number", "number"]);
  const txRemaining = cw("host_tx_remaining", "number", []);
  const txPtr = cw("host_tx_ptr", "number", []);
  const rxSetMode = cw("host_rx_set_mode", null, ["number"]);
  const rxPush = cw("host_rx_push", "number", ["number", "number"]);

  init();
  const FREEDV_MODE_DATAC16 = 23;
  rxSetMode(FREEDV_MODE_DATAC16);
  const ep = epCreate("OK1HRA", "OK2XYZ");
  connect(ep, "OK2XYZ");
  const gotOutframe = takeOutframe(ep) === 1;
  check("connect() produced a CALL outframe", gotOutframe, `mode=${ofMode()} len=${ofLen()}`);
  if (!gotOutframe) return report();

  const mode = ofMode(), len = ofLen(), ptr = ofBuf();
  const sampleCount8k = txStart(mode, ptr, len);
  check("host_tx_start modulated the CALL frame", sampleCount8k > 0, `samples8k=${sampleCount8k}`);
  if (sampleCount8k <= 0) return report();

  const samples8k = new Int16Array(sampleCount8k);
  for (let i = 0; i < sampleCount8k; i++) samples8k[i] = m.HEAP16[(txPtr() >> 1) + i];
  const samples48k = upsample8kTo48k(samples8k);
  check("upsampled 8k->48k", samples48k.length === (sampleCount8k - 1) * 6 + 6, `48k samples=${samples48k.length}`);

  const rxScratchPtr = m._malloc(65535 * 2);
  let rxPacketsSeen = 0;

  const session = new Js8Aud1Transport.Aud1WebSocketSession({
    url: `ws://127.0.0.1:${wsPort}/audiows?token=${encodeURIComponent(token)}`,
    WebSocketImpl: WebSocket,
    wallNow: () => Date.now(),
  });

  const ready = new Promise((resolve) => session.onStatus((s) => { if (s.type === "ready") resolve(s); }));
  session.onSamples((floatSamples) => {
    rxPacketsSeen++;
    const n = Math.min(floatSamples.length, 65535);
    for (let i = 0; i < n; i++) m.HEAP16[(rxScratchPtr >> 1) + i] = Math.max(-32768, Math.min(32767, Math.round(floatSamples[i] * 32768)));
    rxPush(rxScratchPtr, n); // no assertion on the result -- the fake radio's RX content is not under test here
  });
  session.start();

  const helloOrTimeout = await Promise.race([
    ready.then(() => "ready"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 8000)),
  ]);
  check("AUD1 hello received (real WebSocket, real firmware)", helloOrTimeout === "ready", helloOrTimeout);
  if (helloOrTimeout !== "ready") return report();

  // The LAN client's OWN audio handshake to the radio (audioOpened/audioGotHere/
  // audioGotReady in icomLanClient.h) is separate from -- and can lag slightly
  // behind -- this browser-facing AUD1 hello, which only proves the WebSocket
  // itself is up. tx.prepare refuses until audioTxReady() is true on the
  // firmware side; give it a moment rather than racing it.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const SAMPLE_RATE = 48000, PACKET_MS = 20, SAMPLES_PER_PACKET = (SAMPLE_RATE * PACKET_MS) / 1000; // 960
  const packets = Math.ceil(samples48k.length / SAMPLES_PER_PACKET);
  const txId = 1;
  // Real round trips (Worker -> real WebSocket -> real ESP32-native process ->
  // real ICOM-LAN device) plus setTimeout scheduling jitter ate enough of a
  // 1500ms budget that the 1000ms prebuffer (see prebufferSamples below)
  // wasn't fully delivered by slotUtcMs on the first attempt against real
  // hardware ("TX prebuffer missed slot") -- give it real margin instead of
  // the bare minimum.
  const slotUtcMs = Date.now() + 4000; // inside the firmware's accepted 100ms-35s window
  const prebufferSamples = 48000; // 1s, matches production JS8LAN/WSPR

  let prepareOk = false, prepareErr = "";
  try {
    await session.prepare(txId, {
      slotUtcMs, prebufferSamples, packetMs: PACKET_MS,
      samples: samples48k.length, packets, mode: "MERCURY-DATAC16", toneHz: 0,
    });
    prepareOk = true;
  } catch (e) { prepareErr = e && e.message || String(e); }
  check("tx.prepare -> tx-ready", prepareOk, prepareErr);
  if (!prepareOk) return report();

  // Start streaming prebufferSamples/sampleRate before the slot, same as the
  // production contract (docs/aud1-audio-websocket-protocol.md's "safe TX
  // minimum"). Real-time paced: one 20ms packet every 20ms, no faster.
  const startAt = slotUtcMs - (prebufferSamples / SAMPLE_RATE) * 1000;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt - Date.now())));

  session.begin(txId);
  let sawPtt = false;
  const stopWatchingPtt = (() => {
    const handler = (msg) => { if (msg && msg.type === "tx-state" && msg.ptt) sawPtt = true; };
    session.onControl(handler);
    return () => {};
  })();

  let sent = 0, firstSample = 0, writeError = "";
  for (let seq = 0; seq < packets; seq++) {
    const offset = seq * SAMPLES_PER_PACKET;
    const chunk = samples48k.subarray(offset, offset + SAMPLES_PER_PACKET);
    const pcm = chunk.length === SAMPLES_PER_PACKET ? chunk : (() => {
      const padded = new Int16Array(SAMPLES_PER_PACKET); padded.set(chunk); return padded;
    })();
    const wire = buildTxPacket({
      streamId: session.hello.streamId, txId, sequence: seq, sampleRate: SAMPLE_RATE,
      firstSample, pcm, first: seq === 0, last: seq === packets - 1,
    });
    try { session.write(wire); sent++; } catch (e) { writeError = e && e.message || String(e); break; }
    firstSample += pcm.length;
    // Absolute-time scheduling, not relative: real WebSocket sends / Worker
    // scheduling overhead makes a plain "wait 20ms after each send" loop
    // compound drift (each iteration actually costs 20ms + overhead), which
    // starved the firmware's fixed prebuffer window and faulted the transfer
    // at ~44/165 packets regardless of how much slot margin was given.
    // Target wall-clock instants instead so overhead in one iteration doesn't
    // push out every iteration after it.
    const targetTime = startAt + (seq + 1) * PACKET_MS;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, targetTime - Date.now())));
  }
  check("streamed every TX_PCM16 packet", sent === packets && !writeError, `sent=${sent}/${packets} ${writeError}`);
  session.end(txId);

  const drainedOrTimeout = await Promise.race([
    new Promise((resolve) => {
      const check2 = () => { if (session.isDrained(txId)) resolve("drained"); else setTimeout(check2, 100); };
      check2();
    }),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 8000)),
  ]);
  check("tx-drained received", drainedOrTimeout === "drained", drainedOrTimeout);
  check("firmware reported PTT ON at some point during TX", sawPtt);

  session.complete(txId);
  check(`RX samples arrived from the fake radio's audio channel (informational)`, rxPacketsSeen > 0, `packets=${rxPacketsSeen}`);

  session.stop();
  report();
}

main().catch((e) => { check("worker ran without throwing", false, e && e.stack || String(e)); report(); });
