// Mercury's Worker-resident ARQ pump (docs/mercury-implementace.md ch.4.2).
// Loads mercury-host.js (the WASM ARQ FSM + trimmed freedv modem, unmodified
// upstream C ported and verified against real native `mercury` -- see
// prototype/mercury-prototype/run-native-transfer.js/-realtime.js) and the
// real, unmodified data/js8-aud1.js, and drives them together: every
// incoming AUD1 RX audio packet IS the pump's tick (no separate timer --
// matches the FSM's own sample-clock design in ch.4.3, and the real
// hardware audio path stays live through TX too, see
// [ic705-rx-audio-during-tx]); the FSM's virtual clock advances by real
// elapsed wall time; a TX burst starts whenever the FSM produces a new
// outframe (CALL, retry, ACCEPT, ACK, ...), streamed via the same
// absolute-time-paced AUD1 TX_PCM16 loop proven live against a real IC-705.
//
// Ported from prototype/mercury-prototype/aud1-worker-smoke/pump-worker.js,
// generalized for production use: runs until told to stop (not a fixed test
// duration), and reports connection/SNR state for the connection-test
// screen instead of a one-shot pass/fail.
//
// File transfer (ch.5/E3, data/mercury-file.js) landed 2026-08-22, verified
// against real native mercury (prototype/mercury-prototype/
// run-native-transfer-file.js, run-native-transfer-resume.js) before being
// wired in here. Bringing that in also fixed a real gap this file had until
// now: RX mode was set ONCE to control mode and never re-checked, so a real
// DATA phase (payload mode, not control mode) would never actually decode --
// harmless while only CALL/LISTEN existed (nothing ever reached a data
// phase), fatal for a real file transfer. Ported the dual-demodulator +
// mode-tracking fix from run-native-transfer-reverse.js/host-shim.c's own
// comment on host_rx_ctrl_init: real mercury runs two demodulators at once
// (one permanent control-mode, one following peer_tx_mode) because
// IDLE_IRS covers waiting for EITHER a DATA frame or a MODE_REQ and there is
// no way to know which without already having decoded it.
importScripts("mercury-host.js");
importScripts("js8-aud1.js");
importScripts("js8-file-transfer.js");
importScripts("mercury-file.js");
// Production consumer of docs/mercury-implementace.md ch.8's TX-gain
// calibration (data/mercury-cal-worker.js finds and stores it, reusing
// tx-gain-cal.js's own store/search UNCHANGED). Until now nothing ever read
// /mercury-txgain.json back: the file got written, real bursts kept going
// out at raw, unscaled WASM-encoder amplitude regardless. icom-models.js +
// tx-gain-mod-level.js are pulled in too so this can read the radio's
// CURRENT MOD level itself (no UI, no operator step) -- a stored knee is a
// knee AT a MOD level, and reusing it after the level moved (this project's
// own operators keep hand-tuning it) would risk overdrive, not just a wrong
// number, exactly like tx-gain-cal.js's own entryStatus() staleness check
// warns about.
importScripts("icom-models.js");
importScripts("tx-gain-mod-level.js");
importScripts("tx-gain-cal.js");

const EV = {
  APP_LISTEN: 0, APP_STOP_LISTEN: 1, APP_CONNECT: 2, APP_DISCONNECT: 3, APP_DATA_READY: 4,
  TX_COMPLETE: 22,
};
const CONN_STATE = ["DISCONNECTED", "LISTENING", "CALLING", "ACCEPTING", "CONNECTED", "DISCONNECTING"];
const FREEDV_MODE_DATAC16 = 23;
const ARQ_DFLOW_IDLE_IRS = 3; // arq_fsm.h: "IRS: waiting for peer data frame" -- the only state expecting a payload-mode frame
const SAMPLE_RATE = 48000, PACKET_MS = 20, SAMPLES_PER_PACKET = (SAMPLE_RATE * PACKET_MS) / 1000;
// sim_endpoint.c (mercury/tests/sim/, upstream, unmodified) backs
// host_queue_tx()/host_delivered() with a fixed 256 KiB buffer for the
// WHOLE LIFETIME of one endpoint -- queuing past it is a hard C assert
// (SIM_TX_CAP), and RX delivery past it is silently truncated forever
// (SIM_RX_CAP, never resets). One Worker = one ep = one CALL/LISTEN cycle
// (mercury.js's startWorker() always makes a fresh one), so this is a
// per-connection ceiling, not a lifetime-of-the-app one -- but it is real,
// so a transfer is refused outright (honest error, matching this codebase's
// "no silent half-truths" rule -- WSPR's pledge, JS8's busy-card) rather
// than risking either failure mode. Kept well under 256 KiB to leave room
// for the QUERY/REPLY round trip and protocol overhead alongside it.
const MAX_TRANSFER_BYTES = 200 * 1024;
const SESSION_BYTE_CAP = 256 * 1024;

// freedv_api.h's real mode numbers (mercury/modem/freedv/freedv_api.h) with
// real, MEASURED throughput from docs/mercury-implementace.md ch.2.4's own
// table (arq_protocol.c's stop-and-wait cycle cost, ideal channel, zero
// retry -- real HF with ~20% retry runs a quarter slower). Only the three
// modes that table actually measured get a bps figure; every other mode
// (the DATAC15 floor, and anything faster than DATAC1) shows a name with no
// invented number rather than a guessed one -- this feeds doc ch.6.2's
// "recommended mode + B/s" line and the send-progress ETA below, both of
// which would be actively misleading with a made-up rate.
const MODE_INFO = {
  10: { name: "DATAC1", bps: 45.7 },
  12: { name: "DATAC3", bps: 12.4 },
  14: { name: "DATAC0", bps: null },
  18: { name: "DATAC4", bps: 4.4 },
  19: { name: "DATAC13", bps: null },
  20: { name: "DATAC14", bps: null },
  22: { name: "DATAC15", bps: null },
  23: { name: "DATAC16", bps: null },
  24: { name: "DATAC17", bps: null },
  25: { name: "QAM16C2", bps: null },
};
function describeMode(modeNum) { return MODE_INFO[modeNum] || { name: `mode ${modeNum}`, bps: null }; }

function post(fields) { postMessage(fields); }

function clamp16(v) { return Math.max(-32768, Math.min(32767, v)); }

// Peak-scale a burst's PCM by the calibrated TX gain -- same operation as
// mercury-cal-worker.js's own setAmplitude()/pcm[i]=clamp16(round(x*gain)),
// just applied once to a whole finished buffer instead of ramped sample by
// sample (nothing here is searching for the knee anymore, just applying an
// already-found one). gain=1.0 (uncalibrated fallback) is a no-op copy, not
// skipped, so callers never need an "is this scaled" branch.
function applyGain(samples, gain) {
  if (gain === 1) return samples;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = clamp16(Math.round(samples[i] * gain));
  return out;
}

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
// wspr-core.js's own nextPacket().
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
  const { wsPort, token, myCall, peerCall, role } = config;

  let m;
  try {
    m = await createMercuryHost();
  } catch (e) {
    post({ type: "error", reason: "wasm init failed", detail: e && e.message || String(e) });
    return;
  }
  const cw = (name, ret, args) => m.cwrap(name, ret, args);
  const init = cw("host_init", null, []);
  const epCreate = cw("host_endpoint_create", "number", ["string", "string"]);
  const dispatchSimple = cw("host_dispatch_simple", null, ["number", "number"]);
  const connectCall = cw("host_connect", null, ["number", "string"]);
  const connState = cw("host_conn_state", "number", ["number"]);
  const dflowState = cw("host_dflow_state", "number", ["number"]);
  const payloadMode = cw("host_payload_mode", "number", ["number"]);
  const localSnrX10 = cw("host_local_snr_x10", "number", ["number"]);
  const peerSnrX10 = cw("host_peer_snr_x10", "number", ["number"]);
  const peerSnrValid = cw("host_peer_snr_valid", "number", ["number"]);
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
  const peerTxMode = cw("host_peer_tx_mode", "number", ["number"]);
  const peerCallOf = cw("host_peer_call", "string", ["number"]);
  const rxCtrlInit = cw("host_rx_ctrl_init", null, ["number"]);
  const rxPushCtrl = cw("host_rx_push_ctrl", "number", ["number", "number"]);
  const rxCtrlDecodedPtr = cw("host_rx_ctrl_decoded_ptr", "number", []);
  const rxCtrlDecodedLen = cw("host_rx_ctrl_decoded_len", "number", []);
  const rxCtrlClearDecoded = cw("host_rx_ctrl_clear_decoded", null, []);
  const rxCtrlLastSnr = cw("host_rx_ctrl_last_snr", "number", []);
  const queueTxFn = cw("host_queue_tx", null, ["number", "number", "number"]);
  const deliveredFn = cw("host_delivered", "number", ["number", "number", "number"]);
  const setChannelGuardMs = cw("host_set_channel_guard_ms", null, ["number"]);
  const setIssPostAckGuardMs = cw("host_set_iss_post_ack_guard_ms", null, ["number"]);
  // Diagnostic-only, see host-shim.c's own comment: chasing a real split
  // where the ISS side declared a file fully delivered while the IRS side's
  // delivered-byte count never grew past the first message.
  const rxExpectedFn = cw("host_rx_expected", "number", ["number"]);
  const txSeqFn = cw("host_tx_seq", "number", ["number"]);
  // CQ (docs/mercury-implementace.md ch.10's E4 gate, last item) -- an
  // unaddressed, sessionless frame, deliberately NOT routed through
  // host_deliver()/arq_fsm_dispatch() on either end. See host-shim.c's own
  // comment on why: no PACKET_TYPE_ARQ_CQ case exists in sim_translate_frame(),
  // so an undetected CQ frame would fall through to the DATA/CONTROL header
  // path and get decoded as protocol garbage, not safely ignored.
  const cqTxPrepare = cw("host_cq_tx_prepare", "number", ["string", "number"]);
  const cqTxPtr = cw("host_cq_tx_ptr", "number", []);
  const framePacketType = cw("host_frame_packet_type", "number", ["number", "number"]);
  const cqRxParse = cw("host_cq_rx_parse", "number", ["number", "number"]);
  const cqRxCall = cw("host_cq_rx_call", "string", []);
  const cqRxBwHz = cw("host_cq_rx_bw_hz", "number", []);
  const PACKET_TYPE_ARQ_CQ = 5; // modem/framer.h -- 3 bits, [7:5] of frame[0]
  const CQ_BANDWIDTH_HZ = 2300; // ARQ_BANDWIDTH_FULL_HZ, arq.h -- same default CALL/ACCEPT already use

  init();
  // arq_protocol.h's own ARQ_CHANNEL_GUARD_MS_DEFAULT (700) and
  // ARQ_ISS_POST_ACK_GUARD_MS_DEFAULT (900) are tuned assuming ~340ms TX->RX
  // radio switching time -- real ICOM-over-LAN testing (two real radios,
  // S9+ both directions, so NOT a weak-signal problem) found both stations
  // keying simultaneously and one side stuck in ACCEPTING forever: PTT
  // ON/OFF here is an async CI-V command over the network, not a direct
  // line/VOX, and real round-trip latency was eating the built-in margin
  // this comment already warns is tight ("effective gap ~300ms... ~50% ACK
  // loss"). Doubled defensively; this only costs idle-air time per turn, not
  // correctness, and can come back down once real per-radio turnaround is
  // actually measured.
  setChannelGuardMs(1400);
  setIssPostAckGuardMs(1800);
  const wallStart = Date.now();
  let currentRxMode = FREEDV_MODE_DATAC16;
  rxSetMode(currentRxMode); // payload-mode demodulator, follows dflow_state/peer_tx_mode
  rxCtrlInit(FREEDV_MODE_DATAC16); // control-mode demodulator, fixed for the session's whole lifetime
  const ep = epCreate(myCall, peerCall || "");

  // Load ch.8's calibrated TX gain (data/mercury-cal-worker.js is the only
  // thing that writes /mercury-txgain.json; until now nothing ever read it
  // back). Fire-and-forget, not awaited: CALL/ACCEPT control frames going
  // out at gain=1.0 for the first second or two while this resolves is
  // harmless (small control frames, not what a knee search calibrates
  // against), and blocking session start on a network fetch + CI-V round
  // trip would make every connect feel slower for no real benefit -- the
  // real DATA phase this actually matters for is always several seconds in.
  let txGainMultiplier = 1.0;
  (async () => {
    try {
      const state = await (await fetch("/state", { cache: "no-store" })).json();
      const model = state.radioName || "";
      const band = TxGainCal.bandOf(state.frequency);
      const percent = state.rfPowerSeen ? Math.round((Number(state.rfPower) || 0) * 100 / 255) : 0;
      const store = new TxGainCal.TxGainStore({ url: "/mercury-txgain.json" });
      await store.load();
      // Read the radio's CURRENT MOD level ourselves -- a stored knee is a
      // knee AT a MOD level (tx-gain-cal.js's own entryStatus() comment),
      // and this project's own operators keep hand-tuning it between
      // sessions (real, not hypothetical: the IC-705/IC-7610 pair this was
      // verified against both had theirs changed mid-session more than
      // once). Reusing a knee measured at a different level risks real
      // overdrive, not just a wrong number, so this is worth the one extra
      // CI-V round trip even with no UI to show it in.
      const modClient = new TxGainModLevel.ModLevelClient({
        send: (msg) => fetch("/cmd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) }).then((r) => r.json()),
        model,
      });
      const modLevel = await modClient.readLevel();
      const key = TxGainCal.entryKey(model, band, percent);
      const usable = store.usableEntry(key, modLevel || 0);
      if (usable && usable.gain > 0) {
        txGainMultiplier = usable.gain;
        post({ type: "log", line: `tx-gain: using calibrated ${usable.gain.toFixed(4)} for ${key} (modLevel=${modLevel || "unknown"})` });
      } else {
        post({ type: "log", line: `tx-gain: no usable calibration for ${key} (modLevel=${modLevel || "unknown"}) -- sending uncalibrated` });
      }
    } catch (e) {
      post({ type: "log", line: `tx-gain: load failed, sending uncalibrated: ${e && e.message || e}` });
    }
  })();

  const rxScratchPtr = m._malloc(65535 * 2);
  const deliverBufPtr = m._malloc(SESSION_BYTE_CAP);
  let lastConnState = -1;
  let rxHeartbeatTickCount = 0; // diagnostic only -- see the heartbeat log in onRxTick
  let dispatched = false; // true once CALL/LISTEN has actually been dispatched to the FSM

  // ---- MRQ1 file layer state ----
  let deliveredSoFar = 0; // host_delivered() is a cumulative PEEK (sim_endpoint_delivered), not a drain
  let rxByteStream = new Uint8Array(0); // the whole app-byte stream delivered on this connection so far
  let rxConsumedOffset = 0; // how much of rxByteStream has already been parsed into complete frames
  const resumeStore = new MercuryFile.ResumeStore();
  let pendingSend = null; // { name, bytes, totalSize, sha256, sha256Hex, phase, offset }
  let activeReceive = null; // { name, startMs, startBytes } -- for the receive-side rate/ETA estimate
  let replyTimeoutHandle = null;
  let txBytesQueuedTotal = 0; // defensive cumulative guard, mirrors the C side's own SIM_TX_CAP assert

  function queueBytes(bytes) {
    txBytesQueuedTotal += bytes.length;
    if (txBytesQueuedTotal > SESSION_BYTE_CAP) {
      // Would trip host_queue_tx's own hard C assert (SIM_TX_CAP) -- refuse
      // before that, not after.
      post({ type: "log", line: `refusing to queue ${bytes.length}B: would exceed this session's ${SESSION_BYTE_CAP}B lifetime cap` });
      return false;
    }
    const ptr = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, ptr);
    queueTxFn(ep, ptr, bytes.length);
    m._free(ptr);
    dispatchSimple(ep, EV.APP_DATA_READY);
    return true;
  }

  function currentPeerCall() {
    const known = peerCallOf(ep);
    return (known && known.length) ? known : (peerCall || "UNKNOWN");
  }

  async function beginSend(name, bytes) {
    if (bytes.length > MAX_TRANSFER_BYTES) {
      post({ type: "send-error", reason: `file too large for one Mercury session (max ${Math.floor(MAX_TRANSFER_BYTES / 1024)} KiB)` });
      return;
    }
    const sha256 = await MercuryFile.sha256(bytes);
    pendingSend = { name, bytes, totalSize: bytes.length, sha256, sha256Hex: MercuryFile.hex(sha256), phase: "awaiting-reply", offset: 0 };
    const query = MercuryFile.queryHeader({ totalSize: bytes.length, sha256, name });
    if (!queueBytes(query)) { pendingSend = null; post({ type: "send-error", reason: "transfer too large" }); return; }
    post({ type: "send-progress", name, sentBytes: 0, totalBytes: bytes.length, phase: "asking peer what they already have" });
    // Not every Mercury station on the other end runs this same resume
    // protocol -- a plain `mercury -x ... | nc` receiver has no idea what a
    // QUERY is and will never answer one. Fall back to a full send from
    // offset 0 rather than hanging forever if no REPLY shows up.
    //
    // REPLY_TIMEOUT_MS must clear the WORST real per-mode frame cycle, not
    // just "feels generous": arq_protocol.c's own table gives DATAC15 (the
    // floor mode, real HF's actual worst case) a 12s retry_interval and only
    // ~22B of usable payload per frame, so a ~70B QUERY header can need 4+
    // frames -- 48s+ even with zero retries. The old 10s value fired WAY
    // before a real QUERY could ever finish, and firing this callback queues
    // a SECOND message on the SAME reliable byte stream while the first is
    // still in flight -- confirmed live against two real radios: the
    // receiver got stuck forever a few bytes into the QUERY because a
    // second, unrelated message had already been appended behind it,
    // corrupting the framing the receiver was waiting to complete. 90s
    // comfortably covers DATAC15's worst case plus one retry.
    const REPLY_TIMEOUT_MS = 90000;
    clearTimeout(replyTimeoutHandle);
    replyTimeoutHandle = setTimeout(() => {
      if (pendingSend && pendingSend.phase === "awaiting-reply") {
        post({ type: "log", line: `no resume REPLY within ${REPLY_TIMEOUT_MS}ms -- sending from the start (peer may not support resume)` });
        startRealDataPhase(0);
      }
    }, REPLY_TIMEOUT_MS);
  }

  function startRealDataPhase(offset) {
    if (!pendingSend) return;
    pendingSend.phase = "sending-data";
    pendingSend.offset = offset;
    pendingSend.sawBusy = false; // set once dflow_state actually leaves idle for this phase -- see the onRxTick completion check
    const remainder = pendingSend.bytes.subarray(offset);
    const header = MercuryFile.dataHeader({ totalSize: pendingSend.totalSize, sha256: pendingSend.sha256, name: pendingSend.name, offset, deflated: false });
    const frame = new Uint8Array(header.length + remainder.length);
    frame.set(header, 0); frame.set(remainder, header.length);
    if (!queueBytes(frame)) { post({ type: "send-error", reason: "transfer too large" }); pendingSend = null; return; }
    // Incremental progress (doc ch.6.2's own priority: "a real ETA before
    // anything runs for hours") comes from summing ofLen() as each outframe
    // is actually handed to the modem in startTxBurst() below -- an
    // approximation (a lost frame's bytes get counted again on retry, so
    // this can occasionally under-advance relative to real elapsed time,
    // never over-advance past 99% before the real dflow-idle completion
    // signal fires), not the peer's own ACK progress, which nothing here
    // exposes.
    pendingSend.queuedThisPhaseTotal = frame.length;
    pendingSend.bytesHandedToModem = 0;
    pendingSend.phaseStartMs = Date.now();
    post({ type: "send-progress", name: pendingSend.name, sentBytes: offset, totalBytes: pendingSend.totalSize, phase: "sending" });
  }

  async function handleIncomingFrame(header, content) {
    if (header.isQuery) {
      const existing = await resumeStore.get(currentPeerCall(), header.name, MercuryFile.hex(header.sha256));
      const haveBytes = existing ? existing.receivedBytes : 0;
      post({ type: "incoming-query", name: header.name, totalSize: header.totalSize, haveBytes });
      const reply = MercuryFile.replyHeader({ totalSize: header.totalSize, sha256: header.sha256, name: header.name, haveBytes });
      queueBytes(reply);
      return;
    }
    if (header.isReply) {
      if (pendingSend && pendingSend.phase === "awaiting-reply") {
        clearTimeout(replyTimeoutHandle);
        startRealDataPhase(header.offset);
      }
      return;
    }
    // A real incoming file from the peer -- ARQ never echoes our own sent
    // bytes back to us (that only happens in run-native-transfer-resume.js's
    // test harness, which plays "the peer's app" by writing straight into
    // native mercury's own data port; a real second station has no such
    // path). Our OWN send's completion is detected purely from our own
    // dflow_state returning to idle once transmission finishes -- see the
    // onRxTick completion check below, not here.
    if (header.totalSize > MAX_TRANSFER_BYTES) {
      post({ type: "receive-error", reason: `incoming file too large (${header.totalSize}B, max ${MAX_TRANSFER_BYTES}B)`, name: header.name });
      return;
    }
    const peer = currentPeerCall();
    const hashHex = MercuryFile.hex(header.sha256);
    if (header.offset === 0) {
      post({ type: "incoming-file", name: header.name, totalSize: header.totalSize });
      activeReceive = { name: header.name, startMs: Date.now(), startBytes: 0 };
    } else if (!activeReceive || activeReceive.name !== header.name) {
      // A resumed receive picking up mid-file (this Worker's own first
      // frame for it, offset > 0) -- start the rate clock from here, not
      // from a name we've never actually seen a byte of this session.
      activeReceive = { name: header.name, startMs: Date.now(), startBytes: header.offset };
    }
    const record = await resumeStore.append(peer, header.name, hashHex, header.totalSize, content);
    // Real observed rate (unlike the send side's doc-table estimate above --
    // here we can directly measure bytes actually decoded over elapsed
    // time, which is more accurate than assuming the mode's nominal rate).
    let modeName = null, remainingMs = null;
    if (activeReceive && activeReceive.name === header.name) {
      const elapsedS = (Date.now() - activeReceive.startMs) / 1000;
      const gotBytes = record.receivedBytes - activeReceive.startBytes;
      modeName = describeMode(peerTxMode(ep)).name;
      if (elapsedS > 0.5 && gotBytes > 0) {
        const rate = gotBytes / elapsedS;
        remainingMs = Math.round(((header.totalSize - record.receivedBytes) / rate) * 1000);
      }
    }
    post({ type: "receive-progress", name: header.name, receivedBytes: record.receivedBytes, totalBytes: header.totalSize, modeName, remainingMs });
    if (record.receivedBytes >= header.totalSize) {
      const fullBytes = new Uint8Array(await record.blob.arrayBuffer());
      const actualHash = MercuryFile.hex(await MercuryFile.sha256(fullBytes));
      if (actualHash !== hashHex) {
        post({ type: "receive-error", reason: "SHA-256 mismatch after full receive", name: header.name });
      } else {
        // Blob is structured-clonable on its own -- no transfer list needed.
        post({ type: "receive-complete", name: header.name, size: fullBytes.length, blob: record.blob });
      }
      await resumeStore.clear(peer, header.name, hashHex);
      if (activeReceive && activeReceive.name === header.name) activeReceive = null;
    }
  }

  function pumpDeliveredBytes() {
    const totalLen = deliveredFn(ep, deliverBufPtr, SESSION_BYTE_CAP);
    if (totalLen <= deliveredSoFar) return;
    const chunk = m.HEAPU8.slice(deliverBufPtr + deliveredSoFar, deliverBufPtr + totalLen);
    deliveredSoFar = totalLen;
    const merged = new Uint8Array(rxByteStream.length + chunk.length);
    merged.set(rxByteStream, 0); merged.set(chunk, rxByteStream.length);
    rxByteStream = merged;
    let result;
    try {
      result = MercuryFile.consumeFrames(rxByteStream, rxConsumedOffset);
    } catch (e) {
      post({ type: "log", line: `MRQ1 stream error: ${e.message}` });
      return;
    }
    rxConsumedOffset = result.offset;
    for (const frame of result.frames) handleIncomingFrame(frame.header, frame.content);
  }

  const session = new Js8Aud1Transport.Aud1WebSocketSession({
    url: `ws://${location.hostname}:${wsPort}/audiows?token=${encodeURIComponent(token)}`,
    WebSocketImpl: WebSocket,
    wallNow: () => Date.now(),
  });

  // Aud1WebSocketSession.onStatus() is a single callback slot, not a
  // subscriber list -- a second call silently REPLACES the first rather than
  // adding to it. Register exactly one handler covering everything this
  // Worker needs to react to (hello resolution here, closed/protocol-error
  // further down used to leave a second onStatus() call that clobbered this
  // one, so "ready" never resolved and the timed-out session leaked open
  // with no one ever calling session.stop() on it -- exactly the kind of
  // orphaned-reconnect-forever bug this comment exists to prevent someone
  // reintroducing).
  let resolveReady = null;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  // Aud1WebSocketSession's own onclose handler ALREADY schedules a real
  // reconnect (reconnectMs, default 1000ms) after every "closed"/
  // "protocol-error" -- self-healing is the whole point of that code path,
  // proven live: a real two-radio test hit a mid-session "closed" (a local
  // TCP hiccup between this Worker and the firmware, real but transient
  // under two simultaneous real LAN+audio sessions) that would have
  // recovered on its own within ~1s, except this handler used to treat
  // "closed" as immediately fatal and tore the whole session down before
  // the reconnect ever got a chance -- discarding the transport's own
  // recovery mechanism outright. Give it AUDIO_LOST_GRACE_MS to actually
  // reconnect (a fresh "ready") before escalating to a real error; still
  // fatal if it genuinely never comes back.
  const AUDIO_LOST_GRACE_MS = 10000;
  let audioLostGraceTimer = null;
  session.onStatus((s) => {
    if (s.type === "ready") {
      resolveReady(s);
      if (audioLostGraceTimer) { clearTimeout(audioLostGraceTimer); audioLostGraceTimer = null; post({ type: "log", line: "audio session recovered on its own" }); }
    } else if (s.type === "closed" || s.type === "protocol-error") {
      if (!audioLostGraceTimer) {
        post({ type: "log", line: `audio session ${s.type}, waiting up to ${AUDIO_LOST_GRACE_MS}ms for it to reconnect on its own` });
        audioLostGraceTimer = setTimeout(() => {
          audioLostGraceTimer = null;
          post({ type: "error", reason: "audio session", detail: "did not recover within " + AUDIO_LOST_GRACE_MS + "ms" });
        }, AUDIO_LOST_GRACE_MS);
      }
    }
  });

  let txBusy = false;
  async function startTxBurst() {
    if (!takeOutframe(ep)) return;
    txBusy = true;
    const mode = ofMode(), len = ofLen(), ptr = ofBuf();
    try {
      const sampleCount8k = txStart(mode, ptr, len);
      if (sampleCount8k <= 0) { post({ type: "log", line: `tx start failed rc=${sampleCount8k} mode=${mode}` }); return; }
      const samples8k = new Int16Array(sampleCount8k);
      for (let i = 0; i < sampleCount8k; i++) samples8k[i] = m.HEAP16[(txPtr() >> 1) + i];
      const samples48k = applyGain(upsample8kTo48k(samples8k), txGainMultiplier);
      const packets = Math.ceil(samples48k.length / SAMPLES_PER_PACKET);
      // Every packet on the wire is a fixed SAMPLES_PER_PACKET (960) samples
      // -- the last chunk gets zero-padded up to that size below, and
      // firstSample advances by the PADDED length each iteration. So the
      // total this burst actually delivers is packets*SAMPLES_PER_PACKET,
      // not the true (unpadded) samples48k.length whenever that isn't an
      // exact multiple of 960 -- the normal case, since burst length is set
      // by the freedv mode's frame size, not by a 20ms boundary. Declaring
      // the true, shorter length here made the firmware's own consistency
      // check (aud1TxExpectedSample+samples > aud1TxTotalSamples) correctly
      // reject the last packet on almost every burst whose length didn't
      // happen to land on a packet boundary -- confirmed live as "TX
      // FIRST/LAST/length/buffer failure" recurring on later bursts.
      const totalSamplesPadded = packets * SAMPLES_PER_PACKET;
      const txId = nextTxId++;
      // A full 1s prebuffer (WSPR/JS8's own default -- fine there, since a
      // transmission runs for minutes and a 1s head start is noise) turned
      // out to be the REAL cause of real two-station collisions: it forces a
      // ~1.5s gap between "the ARQ FSM decided to transmit now" and "the
      // radio actually keys", which the FSM's own collision-avoidance guard
      // times (700-900ms, tuned assuming near-immediate keying) know nothing
      // about. Confirmed directly, not guessed: timestamped native logs from
      // two real radios showed PTT_ON on one side landing 1-2s INSIDE the
      // other side's still-open PTT window, repeatedly, exactly matching
      // this gap. A short ARQ burst needs a short prebuffer -- 200ms is
      // still real anti-jitter margin, just not a disproportionate fixed tax
      // on every single turn the way 1s was.
      const prebufferSamples = 9600; // 200ms @ 48kHz
      const slotUtcMs = Date.now() + 600;

      await session.prepare(txId, {
        slotUtcMs, prebufferSamples, packetMs: PACKET_MS,
        samples: totalSamplesPadded, packets, mode: `MERCURY-${mode}`, toneHz: 0,
      });

      // wifilt.ino's aud1TxTick (~line 9088) checks "do I have >=
      // prebufferSamples queued?" AT slotUtcMs itself -- sending the last
      // prebuffer-filling packet at that exact instant leaves zero slack for
      // its own real network transit + firmware parse time. SEND_MARGIN_MS
      // pulls the whole send schedule earlier so it lands with real slack
      // before that check; slotUtcMs itself (what the firmware keys off of)
      // is untouched.
      const SEND_MARGIN_MS = 200;
      const startAt = slotUtcMs - (prebufferSamples / SAMPLE_RATE) * 1000 - SEND_MARGIN_MS;
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
        // Absolute-time scheduling, not relative delays -- see
        // aud1-worker-smoke/worker.js's own fix: relative setTimeout(20ms)
        // compounds real overhead and starves the firmware's prebuffer.
        const targetTime = startAt + (seq + 1) * PACKET_MS;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, targetTime - Date.now())));
      }
      session.end(txId);
      await Promise.race([
        new Promise((resolve) => { const c = () => { if (session.isDrained(txId)) resolve(); else setTimeout(c, 50); }; c(); }),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
      session.complete(txId);
    } catch (e) {
      post({ type: "log", line: `tx burst error: ${e && e.message || e}` });
    } finally {
      dispatchSimple(ep, EV.TX_COMPLETE);
      txBusy = false;
    }
  }

  // CQ (ch.10's E4 gate, last item): an unaddressed, sessionless broadcast,
  // sendable in ANY connection state (LISTENING, CALLING, even mid-transfer)
  // -- unlike startTxBurst() above, this never waits on takeOutframe(ep) and
  // never touches the FSM (no dispatchSimple/EV.TX_COMPLETE at the end: CQ
  // isn't an ARQ event, arq_fsm_dispatch() has no idea it exists). Still
  // shares txBusy with startTxBurst(): both key the same real radio over the
  // same AUD1 session, so they cannot run concurrently regardless of which
  // side "owns" the reason.
  async function sendCq() {
    if (txBusy) { post({ type: "log", line: "cq: refused, a burst is already in flight" }); return false; }
    txBusy = true;
    try {
      const frameLen = cqTxPrepare(myCall, CQ_BANDWIDTH_HZ);
      if (frameLen <= 0) { post({ type: "log", line: `cq: build failed rc=${frameLen}` }); return false; }
      const sampleCount8k = txStart(FREEDV_MODE_DATAC16, cqTxPtr(), frameLen);
      if (sampleCount8k <= 0) { post({ type: "log", line: `cq: modulate failed rc=${sampleCount8k}` }); return false; }
      const samples8k = new Int16Array(sampleCount8k);
      for (let i = 0; i < sampleCount8k; i++) samples8k[i] = m.HEAP16[(txPtr() >> 1) + i];
      const samples48k = applyGain(upsample8kTo48k(samples8k), txGainMultiplier);
      const packets = Math.ceil(samples48k.length / SAMPLES_PER_PACKET);
      const totalSamplesPadded = packets * SAMPLES_PER_PACKET; // see startTxBurst()'s own comment on why the padded total, not samples48k.length
      const txId = nextTxId++;
      const prebufferSamples = 9600; // 200ms @ 48kHz, same as startTxBurst()'s real-collision fix
      const slotUtcMs = Date.now() + 600;
      await session.prepare(txId, {
        slotUtcMs, prebufferSamples, packetMs: PACKET_MS,
        samples: totalSamplesPadded, packets, mode: "MERCURY-CQ", toneHz: 0,
      });
      const SEND_MARGIN_MS = 200;
      const startAt = slotUtcMs - (prebufferSamples / SAMPLE_RATE) * 1000 - SEND_MARGIN_MS;
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
        const targetTime = startAt + (seq + 1) * PACKET_MS;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, targetTime - Date.now())));
      }
      session.end(txId);
      await Promise.race([
        new Promise((resolve) => { const c = () => { if (session.isDrained(txId)) resolve(); else setTimeout(c, 50); }; c(); }),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
      session.complete(txId);
      post({ type: "log", line: `cq: sent as ${myCall}` });
      return true;
    } catch (e) {
      post({ type: "log", line: `cq send error: ${e && e.message || e}` });
      return false;
    } finally {
      txBusy = false;
    }
  }

  // Returns true (and has already posted a "cq-heard" if it decoded cleanly)
  // when `ptr`/`len` is a CQ frame -- callers must check this BEFORE
  // deliver()/host_deliver(): sim_translate_frame() has no
  // PACKET_TYPE_ARQ_CQ case (see host-shim.c's comment on host_cq_rx_parse),
  // so an undetected CQ frame would fall through to the DATA/CONTROL 8-byte
  // header path and get decoded as protocol garbage fed straight to the FSM.
  const heardCq = new Map(); // call -> {bwHz, lastMs} -- session-lifetime, no persistence needed
  function handleIfCq(ptr, len) {
    if (framePacketType(ptr, len) !== PACKET_TYPE_ARQ_CQ) return false;
    if (cqRxParse(ptr, len)) {
      const call = cqRxCall();
      if (call && call !== myCall) {
        const bwHz = cqRxBwHz();
        heardCq.set(call, { bwHz, lastMs: Date.now() });
        post({ type: "cq-heard", call, bwHz });
      }
    }
    return true;
  }

  function onRxTick(floatSamples) {
    const n = Math.min(floatSamples.length, 65535);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-32768, Math.min(32767, Math.round(floatSamples[i] * 32768)));
      m.HEAP16[(rxScratchPtr >> 1) + i] = s;
    }

    // Follow a real data phase's mode, exactly like host_peer_tx_mode()'s
    // own comment describes: IDLE_IRS expects a real DATA frame in
    // peer_tx_mode, every other dflow state expects control mode.
    const wantMode = dflowState(ep) === ARQ_DFLOW_IDLE_IRS ? peerTxMode(ep) : FREEDV_MODE_DATAC16;
    if (wantMode !== currentRxMode && wantMode > 0) {
      currentRxMode = wantMode;
      rxSetMode(currentRxMode);
      post({ type: "log", line: `rx-mode -> ${currentRxMode} (dflow=${dflowState(ep)})` });
    }

    let anyDecoded = false;
    if (n > 0) {
      // Control-mode demodulator runs unconditionally, every tick, for the
      // whole session -- it is what actually catches MODE_REQ (and every
      // other control frame) regardless of what the payload demodulator is
      // doing.
      if (rxPushCtrl(rxScratchPtr, n)) {
        anyDecoded = true;
        if (!handleIfCq(rxCtrlDecodedPtr(), rxCtrlDecodedLen())) {
          post({ type: "log", line: `decoded via CTRL demod, dflow=${dflowState(ep)}` });
          deliver(ep, rxCtrlDecodedPtr(), rxCtrlDecodedLen(), rxCtrlLastSnr());
        }
        rxCtrlClearDecoded();
      }
      if (rxPush(rxScratchPtr, n)) {
        anyDecoded = true;
        if (!handleIfCq(rxDecodedPtr(), rxDecodedLen())) {
          post({ type: "log", line: `decoded via PAYLOAD demod mode=${currentRxMode}, dflow=${dflowState(ep)}` });
          deliver(ep, rxDecodedPtr(), rxDecodedLen(), rxLastSnr());
        }
        rxClearDecoded();
      }
    }
    if (anyDecoded) pumpDeliveredBytes();

    // DIAGNOSTIC (doc/mercury-implementace.md's real 2-station test): a
    // periodic heartbeat is the only way to see, from outside, whether this
    // side's RX path is even alive during a long stall -- silence with no
    // heartbeat would mean onRxTick itself stopped firing (AUD1 dead), vs.
    // heartbeats with dflow/mode never changing meaning ticks arrive but
    // nothing ever decodes.
    rxHeartbeatTickCount++;
    if (rxHeartbeatTickCount % 250 === 0) {
      post({ type: "log", line: `rx-heartbeat dflow=${dflowState(ep)} conn=${connState(ep)} rxMode=${currentRxMode} peerTxMode=${peerTxMode(ep)} deliveredSoFar=${deliveredSoFar} streamLen=${rxByteStream.length} consumed=${rxConsumedOffset} rxExpected=${rxExpectedFn(ep)} txSeq=${txSeqFn(ep)}` });
    }

    const vnow = Date.now() - wallStart;
    clockAdvance(vnow);
    for (let i = 0; i < 8 && fireDeadline(ep, vnow); i++) { /* drain chained zero-delay transitions */ }

    // Our OWN send completes when dflow_state returns to an idle state after
    // having actually left one -- not from anything "arriving," since a real
    // peer never echoes our own bytes back to us. IDLE_ISS==0 and
    // IDLE_IRS==3 are the FSM's only two at-rest states (everything else,
    // 1/2/4-14, is a transfer, ack-wait, turn, mode, or keepalive exchange in
    // progress) -- accept either, since a post-transfer role settle isn't
    // pinned down without a second live station to observe it against.
    const dflowIsIdle = (ds) => ds === 0 || ds === 3;
    if (pendingSend && pendingSend.phase === "sending-data") {
      const ds = dflowState(ep);
      if (!dflowIsIdle(ds)) pendingSend.sawBusy = true;
      else if (pendingSend.sawBusy) {
        post({ type: "send-progress", name: pendingSend.name, sentBytes: pendingSend.totalSize, totalBytes: pendingSend.totalSize, phase: "delivered" });
        post({ type: "send-complete", name: pendingSend.name });
        pendingSend = null;
      } else {
        // Time+mode-based ETA (not byte-counted -- see startRealDataPhase's
        // own comment on why): estimated from the CURRENT mode's real
        // measured rate, clamped so it can never claim 100% before the
        // dflow-idle branch above actually fires. No rate for the current
        // mode (DATAC15 floor, or faster-than-DATAC1) means no estimate --
        // an honest "sending, ETA unknown" beats a fabricated number.
        const now = Date.now();
        if (now - (pendingSend.lastProgressPostMs || 0) >= 1000) {
          pendingSend.lastProgressPostMs = now;
          const mode = describeMode(payloadMode(ep));
          const elapsedS = (now - pendingSend.phaseStartMs) / 1000;
          let sentBytes = pendingSend.offset;
          let remainingMs = null;
          if (mode.bps) {
            const estimatedBytes = Math.min(pendingSend.queuedThisPhaseTotal - 1, Math.round(mode.bps * elapsedS));
            sentBytes = pendingSend.offset + Math.max(0, estimatedBytes);
            const remainingBytes = pendingSend.queuedThisPhaseTotal - estimatedBytes;
            remainingMs = Math.round((remainingBytes / mode.bps) * 1000);
          }
          post({ type: "send-progress", name: pendingSend.name, sentBytes, totalBytes: pendingSend.totalSize, phase: "sending", modeName: mode.name, modeBps: mode.bps, remainingMs });
        }
      }
    }

    const cs = connState(ep);
    if (cs !== lastConnState) {
      const wasConnected = lastConnState === 4;
      lastConnState = cs;
      post({ type: "status", connState: CONN_STATE[cs] || cs, tMs: vnow });
      if (cs === 4) {
        const mode = describeMode(payloadMode(ep));
        post({
          type: "connected",
          localSnrDb: localSnrX10(ep) / 10,
          peerSnrDb: peerSnrValid(ep) ? peerSnrX10(ep) / 10 : null,
          payloadMode: payloadMode(ep),
          modeName: mode.name, modeBps: mode.bps,
        });
      } else if (dispatched && (wasConnected || (cs === 0 && role === "call"))) {
        // `dispatched` guards against the very first tick: connState(ep) reads
        // DISCONNECTED (0) from host_init() before CALL/LISTEN is ever
        // dispatched (that dispatch waits out the hello + audioTxReady grace,
        // ~2s+ after this Worker starts, but RX ticks begin as soon as audio
        // arrives, well before that) -- without this guard, "disconnected"
        // fired on that very first tick, before connectCall() ever ran, and
        // mercury.js's real reaction to it (stop the worker, release the
        // session) aborted the call before it started every single time.
        post({ type: "disconnected", connState: CONN_STATE[cs] || cs });
      }
    }
    if (!txBusy) startTxBurst();
  }

  session.onSamples((floatSamples) => onRxTick(floatSamples));
  session.start();

  const helloOrTimeout = await Promise.race([
    ready.then(() => "ready"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 8000)),
  ]);
  if (helloOrTimeout !== "ready") {
    // Never leave a session that failed its own startup gate open behind us
    // -- Aud1WebSocketSession retries forever on its own (reconnectMs) once
    // `start()` has been called, and nothing else in this file would ever
    // tell it to stop if main() returns here without doing so itself.
    session.stop();
    post({ type: "error", reason: "no AUD1 hello", detail: helloOrTimeout });
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000)); // audioTxReady() lag on the firmware side

  if (stopping) { session.stop(); return; }

  dispatched = true;
  if (role === "listen") {
    dispatchSimple(ep, EV.APP_LISTEN);
    post({ type: "log", line: "LISTEN ON (armed)" });
  } else {
    connectCall(ep, peerCall);
    post({ type: "log", line: `dialing ${peerCall}...` });
  }

  // Exposed for self.onmessage's "send-file" case, set only once this
  // session's ep/beginSend actually exist (a message arriving before "start"
  // has run this far -- or after "stop" -- has nothing to act on).
  onSendFileRequested = (name, bytes) => {
    if (connState(ep) !== 4) { post({ type: "send-error", reason: "not connected" }); return; }
    if (pendingSend) { post({ type: "send-error", reason: "a transfer is already in progress" }); return; }
    beginSend(name, bytes).catch((e) => post({ type: "send-error", reason: e && e.message || String(e) }));
  };

  // Cancelling mid-transfer (either direction) means dropping the ARQ
  // connection -- there is no "abort just this queued backlog" API, and
  // Mercury's own design is one file per connection anyway (doc ch.5). A
  // cancelled RECEIVE deliberately does NOT clear resumeStore: the partial
  // bytes already have a real use -- a future QUERY/REPLY on a fresh
  // connection resumes from exactly this point, which is the whole point
  // of the resume layer. A cancelled SEND needs nothing preserved on this
  // side at all -- the receiver's own store (not ours) is what a future
  // resume attempt will ask about.
  // Sendable in ANY connection state, unlike onSendFileRequested above --
  // see sendCq()'s own comment on why (unaddressed, sessionless broadcast).
  onSendCqRequested = () => { sendCq(); };

  onCancelTransferRequested = () => {
    const wasSending = Boolean(pendingSend);
    const wasReceiving = Boolean(activeReceive);
    if (!wasSending && !wasReceiving) { post({ type: "log", line: "cancel requested but no transfer in progress" }); return; }
    clearTimeout(replyTimeoutHandle);
    pendingSend = null;
    activeReceive = null;
    post({ type: "transfer-cancelled" });
    if (connState(ep) === 4) dispatchSimple(ep, EV.APP_DISCONNECT);
  };

  while (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  onSendFileRequested = null;
  onCancelTransferRequested = null;
  onSendCqRequested = null;
  if (role === "listen") dispatchSimple(ep, EV.APP_STOP_LISTEN);
  else dispatchSimple(ep, EV.APP_DISCONNECT);
  session.stop();
  post({ type: "stopped" });
}

let onSendFileRequested = null;
let onCancelTransferRequested = null;
let onSendCqRequested = null;

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === "start") main(msg).catch((e) => post({ type: "error", reason: "threw", detail: e && e.stack || String(e) }));
  else if (msg.type === "stop") stopping = true;
  else if (msg.type === "send-file") {
    if (onSendFileRequested) onSendFileRequested(msg.name, new Uint8Array(msg.buffer));
    else post({ type: "send-error", reason: "not connected" });
  } else if (msg.type === "send-cq") {
    if (onSendCqRequested) onSendCqRequested();
    else post({ type: "log", line: "cq: not running yet" });
  } else if (msg.type === "cancel-transfer") {
    if (onCancelTransferRequested) onCancelTransferRequested();
  }
};
