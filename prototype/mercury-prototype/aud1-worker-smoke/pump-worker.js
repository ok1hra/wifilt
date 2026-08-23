// Generalized Worker-resident ARQ pump -- the successor to this directory's
// worker.js (which did exactly ONE hardcoded CALL-frame TX and stopped).
// Where worker.js proved the AUD1 wire contract, this proves the actual
// ongoing PUMP shape the real mercury-host.js Worker (docs/
// mercury-implementace.md ch.4.2) needs: real RX-audio-driven ticking (no
// separate timer -- each RX packet arrival IS the tick, matching the FSM's
// own sample-clock design in ch.4.3 and confirmed safe by
// run-native-transfer-realtime.js's real-time-pacing proof), real timer
// deadlines advanced by actual elapsed wall time, and TX bursts started
// on demand whenever the FSM produces an outframe (CALL, retries, ACCEPT,
// ACK, ...) rather than one canned frame -- using the exact same
// absolute-time-paced AUD1 streaming loop worker.js already proved live
// against the operator's real IC-705.
//
// Known, accepted scope limit: there is one radio, on a dummy load, with no
// second real Mercury station reachable over RF. This can prove real CALL
// initiation, continuous real-audio RX ticking, and a graceful timeout when
// nobody answers (role "call"), or real LISTEN-mode idling (role "listen") --
// never a real CONNECTED handshake, which needs either a second station or
// accepting run-native-transfer.js/-realtime.js's native-mercury proof as the
// protocol-correctness evidence (see this prototype's own memory notes).
importScripts("mercury-host.js");
importScripts("js8-aud1.js");

const EV = {
  APP_LISTEN: 0, APP_STOP_LISTEN: 1, APP_CONNECT: 2, APP_DISCONNECT: 3, APP_DATA_READY: 4,
  TX_COMPLETE: 22,
};
const CONN_STATE = ["DISCONNECTED", "LISTENING", "CALLING", "ACCEPTING", "CONNECTED", "DISCONNECTING"];
const FREEDV_MODE_DATAC16 = 23;
const SAMPLE_RATE = 48000, PACKET_MS = 20, SAMPLES_PER_PACKET = (SAMPLE_RATE * PACKET_MS) / 1000;

function log(line) { postMessage({ type: "log", line: String(line) }); }
function report(fields) { postMessage({ type: "done", ...fields }); }

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

// Byte-for-byte the AUD1 v1 kind 3 (TX_PCM16) wire frame -- same layout as
// worker.js/wspr-core.js's own nextPacket().
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
let nextTxId = 1;

async function main(config) {
  const { wsPort, token, myCall, peerCall, role, runMs } = config;

  const m = await createMercuryHost();
  const cw = (name, ret, args) => m.cwrap(name, ret, args);
  const init = cw("host_init", null, []);
  const epCreate = cw("host_endpoint_create", "number", ["string", "string"]);
  const dispatchSimple = cw("host_dispatch_simple", null, ["number", "number"]);
  const connectCall = cw("host_connect", null, ["number", "string"]);
  const connState = cw("host_conn_state", "number", ["number"]);
  const dflowState = cw("host_dflow_state", "number", ["number"]);
  const takeOutframe = cw("host_take_outframe", "number", ["number"]);
  const ofLen = cw("host_of_len", "number", []);
  const ofMode = cw("host_of_mode", "number", []);
  const ofBuf = cw("host_of_buf", "number", []);
  const fireDeadline = cw("host_fire_deadline_if_due", "number", ["number", "number"]);
  const clockAdvance = cw("host_clock_advance_to_ms", null, ["number"]);
  const deliver = cw("host_deliver", "number", ["number", "number", "number", "number"]);
  const txStart = cw("host_tx_start", "number", ["number", "number", "number"]);
  const txPtr = cw("host_tx_ptr", "number", []);
  const rxSetMode = cw("host_rx_set_mode", null, ["number"]);
  const rxPush = cw("host_rx_push", "number", ["number", "number"]);
  const rxDecodedPtr = cw("host_rx_decoded_ptr", "number", []);
  const rxDecodedLen = cw("host_rx_decoded_len", "number", []);
  const rxClearDecoded = cw("host_rx_clear_decoded", null, []);
  const rxLastSnr = cw("host_rx_last_snr", "number", []);

  init();
  const wallStart = Date.now();
  rxSetMode(FREEDV_MODE_DATAC16); // control mode until a real data phase is negotiated
  const ep = epCreate(myCall, peerCall || "");

  const rxScratchPtr = m._malloc(65535 * 2);
  let lastConnState = -1, lastDflowState = -1;
  let ticks = 0, decodesSeen = 0;

  const session = new Js8Aud1Transport.Aud1WebSocketSession({
    url: `ws://127.0.0.1:${wsPort}/audiows?token=${encodeURIComponent(token)}`,
    WebSocketImpl: WebSocket,
    wallNow: () => Date.now(),
  });

  const ready = new Promise((resolve) => session.onStatus((s) => { if (s.type === "ready") resolve(s); }));

  // doc risk #2: slotUtcMs -> millis() drift. Not the self-monitor sample-
  // clock method the doc names as the eventual fallback (needs MONI enabled
  // and on-signal detection, its own separate investigation) -- this is the
  // simpler measurement available with what already exists: timestamp our
  // own tx-state{ptt:true} receipt against the slotUtcMs we asked for. Real
  // WebSocket/event-loop latency between "firmware keyed" and "our onControl
  // handler ran" inflates this slightly, so treat it as an upper bound on
  // firmware scheduling error, not an exact figure.
  const slotDrifts = []; // [{txId, slotUtcMs, pttWallMs, driftMs}]
  const pendingSlot = new Map(); // txId -> slotUtcMs, cleared once ptt:true is seen
  session.onControl((msg) => {
    if (msg && msg.type === "tx-state" && msg.ptt && pendingSlot.has(msg.txId)) {
      const slotUtcMs = pendingSlot.get(msg.txId);
      pendingSlot.delete(msg.txId);
      const pttWallMs = Date.now();
      const driftMs = pttWallMs - slotUtcMs;
      slotDrifts.push({ txId: msg.txId, slotUtcMs, pttWallMs, driftMs });
      log(`[slot] txId=${msg.txId} requested=${slotUtcMs} actualPtt=${pttWallMs} drift=${driftMs}ms`);
    }
  });

  let txBusy = false;
  async function startTxBurst() {
    if (!takeOutframe(ep)) return;
    txBusy = true;
    const mode = ofMode(), len = ofLen(), ptr = ofBuf();
    try {
      const sampleCount8k = txStart(mode, ptr, len);
      if (sampleCount8k <= 0) { log(`[tx] host_tx_start failed rc=${sampleCount8k} mode=${mode} len=${len}`); return; }
      const samples8k = new Int16Array(sampleCount8k);
      for (let i = 0; i < sampleCount8k; i++) samples8k[i] = m.HEAP16[(txPtr() >> 1) + i];
      const samples48k = upsample8kTo48k(samples8k);
      const packets = Math.ceil(samples48k.length / SAMPLES_PER_PACKET);
      const txId = nextTxId++;
      const slotUtcMs = Date.now() + 1500; // margin proven sufficient once TX pacing is absolute-time, not relative
      pendingSlot.set(txId, slotUtcMs);
      const prebufferSamples = 48000;

      await session.prepare(txId, {
        slotUtcMs, prebufferSamples, packetMs: PACKET_MS,
        samples: samples48k.length, packets, mode: `MERCURY-${mode}`, toneHz: 0,
      });

      const startAt = slotUtcMs - (prebufferSamples / SAMPLE_RATE) * 1000;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt - Date.now())));
      session.begin(txId);

      let firstSample = 0;
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
        session.write(wire);
        firstSample += pcm.length;
        // Absolute-time scheduling -- see aud1-worker-smoke/worker.js's own
        // fix and its memory note: relative setTimeout(20ms) compounds real
        // overhead and starves the firmware's fixed prebuffer window.
        const targetTime = startAt + (seq + 1) * PACKET_MS;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, targetTime - Date.now())));
      }
      session.end(txId);
      await Promise.race([
        new Promise((resolve) => { const c = () => { if (session.isDrained(txId)) resolve(); else setTimeout(c, 50); }; c(); }),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
      session.complete(txId);
      log(`[tx] burst complete mode=${mode} packets=${packets}`);
    } finally {
      dispatchSimple(ep, EV.TX_COMPLETE);
      txBusy = false;
    }
  }

  function onRxTick(floatSamples) {
    ticks++;
    const n = Math.min(floatSamples.length, 65535);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-32768, Math.min(32767, Math.round(floatSamples[i] * 32768)));
      m.HEAP16[(rxScratchPtr >> 1) + i] = s;
    }
    if (n > 0 && rxPush(rxScratchPtr, n)) {
      decodesSeen++;
      const ptr = rxDecodedPtr(), len = rxDecodedLen();
      const snr = rxLastSnr();
      const ok = deliver(ep, ptr, len, snr);
      log(`[rx] decoded ${len}B snr=${snr.toFixed(1)}dB delivered=${ok}`);
      rxClearDecoded();
    }

    const vnow = Date.now() - wallStart;
    clockAdvance(vnow);
    for (let i = 0; i < 8 && fireDeadline(ep, vnow); i++) { /* drain chained zero-delay transitions */ }

    const cs = connState(ep), ds = dflowState(ep);
    if (cs !== lastConnState || ds !== lastDflowState) {
      lastConnState = cs; lastDflowState = ds;
      postMessage({ type: "status", connState: CONN_STATE[cs] || cs, dflowState: ds, tMs: vnow });
    }
    if (!txBusy) startTxBurst().catch((e) => log(`[tx] error: ${e && e.stack || e}`));
  }

  session.onSamples((floatSamples) => onRxTick(floatSamples));
  session.start();

  const helloOrTimeout = await Promise.race([
    ready.then(() => "ready"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 8000)),
  ]);
  if (helloOrTimeout !== "ready") { report({ ok: false, reason: "no AUD1 hello", detail: helloOrTimeout }); return; }
  await new Promise((resolve) => setTimeout(resolve, 2000)); // audioTxReady() lag, same as worker.js

  if (role === "listen") {
    dispatchSimple(ep, EV.APP_LISTEN);
    log("[fsm] LISTEN ON (armed)");
  } else {
    connectCall(ep, peerCall);
    log(`[fsm] dialing ${peerCall}...`);
  }

  const deadline = Date.now() + (runMs || 30000);
  while (!stopping && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  session.stop();
  report({
    ok: true,
    ticks, decodesSeen,
    finalConnState: CONN_STATE[connState(ep)] || connState(ep),
    finalDflowState: dflowState(ep),
    runMs: Date.now() - wallStart,
    slotDrifts,
  });
}

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === "start") main(msg).catch((e) => report({ ok: false, reason: "threw", detail: e && e.stack || String(e) }));
  else if (msg.type === "stop") stopping = true;
};
