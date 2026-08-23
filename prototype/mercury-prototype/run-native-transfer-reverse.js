#!/usr/bin/env node
// The MIRROR of run-native-transfer.js: there, native `mercury` receives a
// file FROM our WASM ARQ session, and our RX decoder never needs to leave
// control mode (mercury, as IRS, only ever replies with control frames --
// see that file's own comment). This test reverses which side sends: after
// CONNECTED, WE write bytes to native mercury's own DATA port, so IT
// becomes the ISS and WE become the IRS receiving real DATA frames -- the
// one path this project had built (host_peer_tx_mode/host_dflow_state) but
// never actually exercised. This is the real, hardware-independent way to
// prove "RX mode-tracking for a real data phase" (docs/
// mercury-implementace.md, this project's own memory notes) actually
// works: mercury's own mode ladder decides the real DATA mode (typically
// starts at DATAC15, may upgrade), and our WASM side has to follow it
// live via host_peer_tx_mode(), not assume control mode forever.
"use strict";
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

delete global.fetch; // see run-loopback.js
const createMercuryHost = require(path.resolve(__dirname, "build-host/mercury-host.js"));

const MERCURY_BIN = process.env.MERCURY || path.resolve(__dirname, "../../mercury/mercury");
const CTRL_PORT = 18510 + (process.pid % 1000);
const DATA_PORT = CTRL_PORT + 1;
const BLOCK_N = 800; // 100ms/block @ 8kHz, same lockstep pacing as run-native-transfer.js
const FREEDV_MODE_DATAC16 = 23;
const ARQ_DFLOW_IDLE_IRS = 3; // arq_fsm.h: "IRS: waiting for peer data frame" -- the only state expecting a payload-mode frame
const CONN_STATE = ["DISCONNECTED", "LISTENING", "CALLING", "ACCEPTING", "CONNECTED", "DISCONNECTING"];

function ctlSend(sock, cmd) {
  return new Promise((resolve) => {
    let acc = "";
    const onData = (d) => { acc += d.toString(); };
    sock.on("data", onData);
    sock.write(cmd + "\r");
    setTimeout(() => { sock.off("data", onData); resolve(acc); }, 400);
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-reverse-"));
  const sockPath = path.join(tmpDir, "audio.sock");
  const logFd = fs.openSync(path.join(tmpDir, "mercury.log"), "w");

  const server = net.createServer();
  const connectionPromise = new Promise((resolve) => server.once("connection", resolve));
  await new Promise((resolve) => server.listen(sockPath, resolve));

  const child = spawn(MERCURY_BIN, [
    "-x", "sock", "-m", "1",
    "-p", String(CTRL_PORT),
    "-b", String(CTRL_PORT + 1000),
  ], {
    env: { ...process.env, MERCURY_AUDIO_SOCK: sockPath },
    stdio: ["ignore", logFd, logFd],
  });
  let childExited = false;
  child.on("exit", (code, sig) => { childExited = true; console.log(`[mercury] exited code=${code} sig=${sig}`); });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { try { child.kill("SIGKILL"); } catch (_) {} process.exit(1); });
  }

  console.log(`[sim] spawned mercury pid=${child.pid}, waiting for audio connect... (log: ${path.join(tmpDir, "mercury.log")})`);
  const audio = await Promise.race([
    connectionPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("mercury never connected to audio socket")), 10000)),
  ]);
  console.log("[sim] mercury connected to audio socket");

  async function connectRetry(port, tries = 20) {
    for (let i = 0; i < tries; i++) {
      try {
        const s = net.createConnection({ host: "127.0.0.1", port });
        await new Promise((resolve, reject) => { s.once("connect", resolve); s.once("error", reject); });
        return s;
      } catch (e) {
        if (i === tries - 1) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  const ctrl = await connectRetry(CTRL_PORT);
  console.log("[ctrl] MYCALL:", (await ctlSend(ctrl, "MYCALL MERCURY1")).trim());
  console.log("[ctrl] LISTEN ON:", (await ctlSend(ctrl, "LISTEN ON")).trim());
  let ctrlLog = "";
  ctrl.on("data", (d) => { ctrlLog += d.toString(); });

  const dataConn = await connectRetry(DATA_PORT);

  let audioBuf = Buffer.alloc(0);
  let resolveFrame = null;
  audio.on("data", (chunk) => {
    audioBuf = Buffer.concat([audioBuf, chunk]);
    tryParse();
  });
  // A run bounded by an external `timeout` SIGKILLs the native mercury
  // child mid-exchange, which slams this socket shut from the other end --
  // an ECONNRESET, not a bug, and without this handler it's an uncaught
  // exception that crashes with a stack trace instead of a clean exit.
  audio.on("error", (e) => { console.log(`[sim] audio socket error (likely native mercury was killed): ${e.message}`); });
  function tryParse() {
    if (audioBuf.length < 4) return;
    const len = audioBuf.readUInt32LE(0);
    if (audioBuf.length < 4 + len) return;
    const frame = audioBuf.subarray(4, 4 + len);
    audioBuf = audioBuf.subarray(4 + len);
    if (resolveFrame) {
      const r = resolveFrame; resolveFrame = null;
      r({ seq: frame.readBigUInt64LE(0), ptt: frame.readUInt8(8), n: frame.readUInt16LE(9), body: frame.subarray(11) });
    }
    if (audioBuf.length >= 4) tryParse();
  }
  function nextStationFrame() { return new Promise((resolve) => { resolveFrame = resolve; }); }

  const m = await createMercuryHost();
  const cw = (name, ret, args) => m.cwrap(name, ret, args);
  const init = cw("host_init", null, []);
  const epCreate = cw("host_endpoint_create", "number", ["string", "string"]);
  const dispatchSimple = cw("host_dispatch_simple", null, ["number", "number"]);
  const connect = cw("host_connect", null, ["number", "string"]);
  const connState = cw("host_conn_state", "number", ["number"]);
  const dflowState = cw("host_dflow_state", "number", ["number"]);
  const peerTxMode = cw("host_peer_tx_mode", "number", ["number"]);
  const takeOutframe = cw("host_take_outframe", "number", ["number"]);
  const ofLen = cw("host_of_len", "number", []);
  const ofMode = cw("host_of_mode", "number", []);
  const ofBuf = cw("host_of_buf", "number", []);
  const fireDeadline = cw("host_fire_deadline_if_due", "number", ["number", "number"]);
  const clockAdvance = cw("host_clock_advance_to_ms", null, ["number"]);
  const deliver = cw("host_deliver", "number", ["number", "number", "number", "number"]);
  const delivered = cw("host_delivered", "number", ["number", "number", "number"]);
  const txStart = cw("host_tx_start", "number", ["number", "number", "number"]);
  const txRemaining = cw("host_tx_remaining", "number", []);
  const txPtr = cw("host_tx_ptr", "number", []);
  const txAdvance = cw("host_tx_advance", null, ["number"]);
  const rxSetMode = cw("host_rx_set_mode", null, ["number"]);
  const rxPush = cw("host_rx_push", "number", ["number", "number"]);
  const rxDecodedPtr = cw("host_rx_decoded_ptr", "number", []);
  const rxDecodedLen = cw("host_rx_decoded_len", "number", []);
  const rxClearDecoded = cw("host_rx_clear_decoded", null, []);
  const rxLastSnr = cw("host_rx_last_snr", "number", []);
  // Second, PERMANENT control-mode (DATAC16) demodulator running in
  // parallel -- see host-shim.c's own comment on host_rx_ctrl_init: the
  // real reference (arq_modem_preferred_rx_mode/select_payload_rx_mode)
  // runs two demodulators at once because IDLE_IRS covers waiting for
  // EITHER a real DATA frame (payload mode) or a MODE_REQ (always control
  // mode) -- there's no way to know which is next without decoding it.
  const rxCtrlInit = cw("host_rx_ctrl_init", null, ["number"]);
  const rxPushCtrl = cw("host_rx_push_ctrl", "number", ["number", "number"]);
  const rxCtrlDecodedPtr = cw("host_rx_ctrl_decoded_ptr", "number", []);
  const rxCtrlDecodedLen = cw("host_rx_ctrl_decoded_len", "number", []);
  const rxCtrlClearDecoded = cw("host_rx_ctrl_clear_decoded", null, []);
  const rxCtrlLastSnr = cw("host_rx_ctrl_last_snr", "number", []);
  const rxCtrlAccumLen = cw("host_rx_ctrl_accum_len", "number", []);
  const rxCtrlNin = cw("host_rx_ctrl_nin", "number", []);
  const rxCtrlSync = cw("host_rx_ctrl_sync", "number", []);

  init();
  let currentRxMode = FREEDV_MODE_DATAC16;
  rxSetMode(currentRxMode); // payload-mode demodulator, follows dflow_state/peer_tx_mode
  rxCtrlInit(FREEDV_MODE_DATAC16); // control-mode demodulator, fixed for the session's whole lifetime
  const ep = epCreate("NODESIM", "MERCURY1");

  const rxScratchPtr = m._malloc(65535 * 2);
  const txScratchPtr = m._malloc(65535 * 2);
  const deliverBufPtr = m._malloc(4096);

  let vnow = 0;
  let blockSeq = 0;
  let lastRealSnr = null;
  let received = Buffer.alloc(0);
  let deliveredSoFar = 0; // sim_endpoint_delivered() is a PEEK at ep->rx (cumulative total), not a drain -- see host_delivered's fix note below
  let modeSwitches = []; // [{atMs, mode}] -- proof the RX side actually followed a real mode change

  async function exchangeOneBlock() {
    const avail = txRemaining();
    const take = Math.min(avail, BLOCK_N);
    if (take > 0) {
      const p = txPtr() >> 1;
      m.HEAP16.copyWithin(txScratchPtr >> 1, p, p + take);
      txAdvance(take);
    }
    if (avail > 0 && txRemaining() === 0) {
      if (process.env.HOST_DEBUG) console.log(`  t=${vnow}ms [tx_complete]`);
      dispatchSimple(ep, 22); // ARQ_EV_TX_COMPLETE
    }
    const buf = Buffer.alloc(4 + 18 + BLOCK_N * 2);
    buf.writeUInt32LE(18 + BLOCK_N * 2, 0);
    buf.writeBigUInt64LE(BigInt(blockSeq), 4);
    buf.writeBigUInt64LE(BigInt(vnow), 12);
    buf.writeUInt16LE(BLOCK_N, 20);
    for (let i = 0; i < take; i++) buf.writeInt16LE(m.HEAP16[(txScratchPtr >> 1) + i], 22 + i * 2);
    audio.write(buf);
    blockSeq++;

    const wallBefore = Date.now();
    const sta = await Promise.race([
      nextStationFrame(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("station frame timeout")), 5000)),
    ]);
    const wallAfter = Date.now();
    if (process.env.HOST_DEBUG && global.__postSwitchLogCount > 0) {
      global.__postSwitchLogCount--;
      console.log(`  t=${vnow}ms [block] realGapMs=${wallAfter - wallBefore} ptt=${sta.ptt} n=${sta.n} dflow=${dflowState(ep)} txRemaining=${txRemaining()}`);
    }

    // ---- decide the RX mode BEFORE pushing this block's samples: follow
    // dflow_state exactly the way host_peer_tx_mode's own comment
    // describes -- IDLE_IRS expects a real DATA frame in peer_tx_mode,
    // every other dflow state expects control mode. ----
    const wantMode = dflowState(ep) === ARQ_DFLOW_IDLE_IRS ? peerTxMode(ep) : FREEDV_MODE_DATAC16;
    if (wantMode !== currentRxMode && wantMode > 0) {
      currentRxMode = wantMode;
      rxSetMode(currentRxMode);
      modeSwitches.push({ atMs: vnow, mode: currentRxMode });
      if (process.env.HOST_DEBUG) console.log(`  t=${vnow}ms [rx-mode] -> ${currentRxMode}`);
      global.__postSwitchLogCount = 40; // unconditional per-block trace for the next 40 iterations
    }

    for (let i = 0; i < sta.n; i++) m.HEAP16[(rxScratchPtr >> 1) + i] = sta.body.readInt16LE(i * 2);
    let anyDecoded = false;
    if (sta.n > 0) {
      // Control-mode demodulator runs unconditionally, every block, for the
      // whole session -- it is what actually catches MODE_REQ (and every
      // other control frame) regardless of what the payload demodulator is
      // doing. Checked first: a MODE_REQ arriving the same block a stale
      // payload decode also completes should not get starved by ordering.
      if (rxPushCtrl(rxScratchPtr, sta.n)) {
        anyDecoded = true;
        const len = rxCtrlDecodedLen(), ptr = rxCtrlDecodedPtr(), snr = rxCtrlLastSnr();
        lastRealSnr = snr;
        const ok = deliver(ep, ptr, len, snr);
        if (process.env.HOST_DEBUG) console.log(`  t=${vnow}ms [deliver-ctrl] ok=${ok} snr=${snr.toFixed(1)}dB conn=${CONN_STATE[connState(ep)]} dflow=${dflowState(ep)}`);
        rxCtrlClearDecoded();
      }
      if (rxPush(rxScratchPtr, sta.n)) {
        anyDecoded = true;
        const len = rxDecodedLen(), ptr = rxDecodedPtr(), snr = rxLastSnr();
        lastRealSnr = snr;
        const ok = deliver(ep, ptr, len, snr);
        if (process.env.HOST_DEBUG) console.log(`  t=${vnow}ms [deliver] ok=${ok} mode=${currentRxMode} snr=${snr.toFixed(1)}dB conn=${CONN_STATE[connState(ep)]} dflow=${dflowState(ep)}`);
        rxClearDecoded();
      }
    }
    if (anyDecoded) {
      // Pull out whatever application bytes the FSM has now reassembled and
      // handed up -- this is OUR side receiving real DATA frames, the half
      // run-native-transfer.js never exercised. sim_endpoint_delivered() is
      // a PEEK at the endpoint's cumulative ep->rx buffer (a straight
      // memcpy, see mercury/tests/sim/sim_endpoint.c), not a drain -- it
      // never shrinks and calling it in a `while (gotLen > 0)` loop is a
      // real infinite loop (confirmed live: 100% CPU, no more progress, no
      // crash, right after the first successful DATA decode). Track the
      // cumulative total we've already copied out and only append the delta.
      const totalLen = delivered(ep, deliverBufPtr, 4096);
      if (totalLen > deliveredSoFar) {
        const chunk = Buffer.from(m.HEAPU8.subarray(deliverBufPtr + deliveredSoFar, deliverBufPtr + totalLen));
        received = Buffer.concat([received, chunk]);
        deliveredSoFar = totalLen;
      }
    }

    vnow += Math.round((BLOCK_N / 8000) * 1000);
    clockAdvance(vnow);
    for (let i = 0; i < 8 && fireDeadline(ep, vnow); i++) { /* drain chained zero-delay transitions */ }
  }

  let heartbeatIter = 0;
  function startNextOutframeIfAny() {
    if (process.env.HOST_DEBUG && (heartbeatIter++ % 100 === 0)) {
      console.log(`  t=${vnow}ms heartbeat: conn=${CONN_STATE[connState(ep)]} dflow=${dflowState(ep)} txRemaining=${txRemaining()} received=${received.length} ctrlAccum=${rxCtrlAccumLen()} ctrlNin=${rxCtrlNin()} ctrlSync=${rxCtrlSync()}`);
    }
    if (txRemaining() > 0) return;
    const took = takeOutframe(ep);
    if (process.env.HOST_DEBUG && took) console.log(`  t=${vnow}ms [outframe taken] mode=${ofMode()} len=${ofLen()}`);
    if (!took) return;
    const len = ofLen(), mode = ofMode(), ptr = ofBuf();
    const started = txStart(mode, ptr, len);
    if (process.env.HOST_DEBUG) console.log(`  t=${vnow}ms [tx] mode=${mode} len=${len} started=${started}`);
    if (started < 0) console.log(`  [tx] host_tx_start FAILED mode=${mode} len=${len} rc=${started}`);
  }

  console.log("[wasm] dialing MERCURY1...");
  connect(ep, "MERCURY1");

  const deadlineWall = Date.now() + 120000;
  let lastState = -1;
  while (Date.now() < deadlineWall && !childExited) {
    startNextOutframeIfAny();
    await exchangeOneBlock();
    const st = connState(ep);
    if (st !== lastState) { console.log(`  t=${vnow}ms state=${CONN_STATE[st]}`); lastState = st; }
    if (st === 4) break;
  }
  if (connState(ep) !== 4) {
    console.log(ctrlLog);
    console.log("FAIL: handshake with native mercury did not reach CONNECTED");
    process.exit(1);
  }
  console.log(`[wasm] CONNECTED at t=${vnow}ms`);

  // Now REVERSE roles for data: write to native mercury's own DATA port so
  // IT becomes ISS and queues a real transfer toward US.
  const payload = Buffer.alloc(300);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + 3) & 0xff;
  dataConn.write(payload);
  console.log(`[native] wrote ${payload.length}B to mercury's own data port -- it should now send this to us`);

  const xferDeadlineWall = Date.now() + 180000;
  while (Date.now() < xferDeadlineWall && !childExited && received.length < payload.length) {
    startNextOutframeIfAny();
    await exchangeOneBlock();
  }

  console.log(`transfer: sent=${payload.length}B received=${received.length}B t=${vnow}ms lastSnr=${lastRealSnr === null ? "n/a" : lastRealSnr.toFixed(1) + "dB"}`);
  console.log(`RX mode switches: ${JSON.stringify(modeSwitches)}`);
  const ok = received.length === payload.length && received.equals(payload) &&
             modeSwitches.some((s) => s.mode !== FREEDV_MODE_DATAC16); // proof we actually left control mode for a real data phase

  ctrl.destroy(); dataConn.destroy(); audio.destroy(); server.close();
  child.kill("SIGTERM");

  if (!ok) console.log(fs.readFileSync(path.join(tmpDir, "mercury.log"), "utf8"));
  if (!modeSwitches.some((s) => s.mode !== FREEDV_MODE_DATAC16))
    console.log("FAIL: RX side never left control mode -- peer_tx_mode/dflow_state tracking did not engage");
  console.log(ok
    ? "PASS: our WASM side received a real DATA-phase transfer FROM native mercury, following its real mode negotiation live"
    : "FAIL: see above / mercury.log");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
