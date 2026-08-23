#!/usr/bin/env node
// The rung-C go/no-go proof (docs/mercury-implementace.md decision #9): our
// own WASM ARQ session (host-shim.c, unmodified arq_fsm.c/arq_protocol.c)
// calls a REAL native `mercury` process and transfers a file to it over
// REAL freedv-modulated audio, carried by the -x sock lockstep transport
// (see native-interop-smoke.js for the protocol basics this builds on).
//
// Our session is the ISS (caller); mercury is the IRS (listener). That
// means mercury only ever TRANSMITS control-mode (DATAC16) frames back
// (ACCEPT/ACK/...) -- it never originates DATA frames in this direction --
// so the RX decoder only ever needs to track one mode, set once.
"use strict";
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

delete global.fetch; // see run-loopback.js
const createMercuryHost = require(path.resolve(__dirname, "build-host/mercury-host.js"));

const MERCURY_BIN = process.env.MERCURY || path.resolve(__dirname, "../../mercury/mercury");
const CTRL_PORT = 18310 + (process.pid % 1000); // avoid colliding with a leftover instance from a prior run
const DATA_PORT = CTRL_PORT + 1;
const BLOCK_N = 800; // 100 ms/block @ 8 kHz -- arbitrary, we (the sim) pick it
const FREEDV_MODE_DATAC16 = 23;
const EV = { APP_LISTEN: 0, APP_DATA_READY: 4 };
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-transfer-"));
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
  // A bare `timeout N node ...` sends SIGTERM straight to this process without
  // running any of main()'s own cleanup, which otherwise leaves `mercury`
  // running and bound to CTRL_PORT for the next attempt (chased one real
  // instance of this down via `ss -ltnp` before adding this).
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
  let received = Buffer.alloc(0);
  dataConn.on("data", (d) => { received = Buffer.concat([received, d]); });

  // ---- audio framing helpers (mirrors native-interop-smoke.js) ----
  let audioBuf = Buffer.alloc(0);
  let resolveFrame = null;
  audio.on("data", (chunk) => {
    audioBuf = Buffer.concat([audioBuf, chunk]);
    tryParse();
  });
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
  const queueTx = cw("host_queue_tx", null, ["number", "number", "number"]);
  const connState = cw("host_conn_state", "number", ["number"]);
  const takeOutframe = cw("host_take_outframe", "number", ["number"]);
  const ofLen = cw("host_of_len", "number", []);
  const ofMode = cw("host_of_mode", "number", []);
  const ofBuf = cw("host_of_buf", "number", []);
  const timeoutMs = cw("host_timeout_ms", "number", ["number", "number"]);
  const fireDeadline = cw("host_fire_deadline_if_due", "number", ["number", "number"]);
  const clockNow = cw("host_clock_now_ms", "number", []);
  const clockAdvance = cw("host_clock_advance_to_ms", null, ["number"]);
  const deliver = cw("host_deliver", "number", ["number", "number", "number", "number"]);
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

  init();
  rxSetMode(FREEDV_MODE_DATAC16); // mercury (IRS here) only ever replies in control mode
  const ep = epCreate("NODESIM", "MERCURY1");

  const rxScratchPtr = m._malloc(65535 * 2);
  const txScratchPtr = m._malloc(65535 * 2);

  let vnow = 0;
  let blockSeq = 0;
  let sawPttOn = false;
  let lastRealSnr = null;

  async function exchangeOneBlock() {
    // ---- fill this block's outgoing (sim -> mercury) samples from whatever we're transmitting ----
    const avail = txRemaining();
    const take = Math.min(avail, BLOCK_N);
    if (take > 0) {
      const p = txPtr() >> 1;
      m.HEAP16.copyWithin(txScratchPtr >> 1, p, p + take);
      txAdvance(take);
    }
    // ARQ_EV_TX_COMPLETE (22, arq_fsm.h): without this the FSM never learns
    // PTT went off and sticks in its *_TX dflow state forever -- run-host-
    // bench.js's sim_core.c-style pending queue did this for every sender;
    // this streaming loop needs the same signal at the buffer-drained edge.
    if (avail > 0 && txRemaining() === 0) {
      if (process.env.HOST_DEBUG) console.log(`  t=${vnow}ms [tx_complete]`);
      dispatchSimple(ep, 22);
    }
    const buf = Buffer.alloc(4 + 18 + BLOCK_N * 2);
    buf.writeUInt32LE(18 + BLOCK_N * 2, 0);
    buf.writeBigUInt64LE(BigInt(blockSeq), 4);
    buf.writeBigUInt64LE(BigInt(vnow), 12);
    buf.writeUInt16LE(BLOCK_N, 20);
    for (let i = 0; i < take; i++) buf.writeInt16LE(m.HEAP16[(txScratchPtr >> 1) + i], 22 + i * 2);
    audio.write(buf);
    blockSeq++;

    const sta = await Promise.race([
      nextStationFrame(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("station frame timeout")), 5000)),
    ]);
    if (sta.ptt === 1) sawPttOn = true;

    // ---- feed mercury's reply samples into our RX decoder ----
    for (let i = 0; i < sta.n; i++) m.HEAP16[(rxScratchPtr >> 1) + i] = sta.body.readInt16LE(i * 2);
    if (sta.n > 0 && rxPush(rxScratchPtr, sta.n)) {
      const len = rxDecodedLen();
      const ptr = rxDecodedPtr();
      if (process.env.HOST_DEBUG) {
        const b0 = m.HEAPU8[ptr];
        console.log(`  t=${vnow}ms [rx-decoded] len=${len} ptype=${b0 >> 5} byte0=0x${b0.toString(16)}`);
      }
      // Real modem-measured SNR (freedv_get_modem_stats), not the 12.0
      // placeholder host-shim.c's comment used to warn about -- doc §6.2's
      // connection-test screen needs an actual number, not a stand-in.
      const snr = rxLastSnr();
      lastRealSnr = snr;
      const ok = deliver(ep, ptr, len, snr);
      if (process.env.HOST_DEBUG) console.log(`  t=${vnow}ms [deliver] ok=${ok} snr=${snr.toFixed(1)}dB conn=${CONN_STATE[connState(ep)]}`);
      rxClearDecoded();
    }

    vnow += Math.round((BLOCK_N / 8000) * 1000);
    clockAdvance(vnow);
    for (let i = 0; i < 8 && fireDeadline(ep, vnow); i++) { /* drain chained zero-delay transitions */ }
  }

  function startNextOutframeIfAny() {
    if (txRemaining() > 0) return; // still streaming the previous one
    if (!takeOutframe(ep)) return;
    const len = ofLen(), mode = ofMode(), ptr = ofBuf();
    const started = txStart(mode, ptr, len);
    if (process.env.HOST_DEBUG) console.log(`  t=${vnow}ms [tx] mode=${mode} len=${len} started=${started}`);
    if (started < 0) console.log(`  [tx] host_tx_start FAILED mode=${mode} len=${len} rc=${started}`);
  }

  console.log("[wasm] dialing MERCURY1...");
  connect(ep, "MERCURY1");

  const deadlineWall = Date.now() + 120000; // real-time safety net around the whole run
  let lastState = -1;
  while (Date.now() < deadlineWall && !childExited) {
    startNextOutframeIfAny();
    await exchangeOneBlock();
    const st = connState(ep);
    if (st !== lastState) { console.log(`  t=${vnow}ms state=${CONN_STATE[st]}`); lastState = st; }
    if (st === 4 /* CONNECTED */) break;
  }

  if (connState(ep) !== 4) {
    console.log(ctrlLog);
    console.log("FAIL: handshake with native mercury did not reach CONNECTED");
    process.exit(1);
  }
  console.log(`[wasm] CONNECTED at t=${vnow}ms`);

  const payload = Buffer.alloc(300);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 13 + 5) & 0xff;
  const payloadPtr = m._malloc(payload.length);
  m.HEAPU8.set(payload, payloadPtr);
  queueTx(ep, payloadPtr, payload.length);
  m._free(payloadPtr);
  dispatchSimple(ep, EV.APP_DATA_READY);
  console.log(`[wasm] queued ${payload.length}B for transfer`);

  const dflowState = cw("host_dflow_state", "number", ["number"]);
  const xferDeadlineWall = Date.now() + 180000;
  let iter = 0;
  while (Date.now() < xferDeadlineWall && !childExited && received.length < payload.length) {
    startNextOutframeIfAny();
    await exchangeOneBlock();
    if (process.env.HOST_DEBUG && (iter++ % 20 === 0)) {
      console.log(`  t=${vnow}ms heartbeat: conn=${CONN_STATE[connState(ep)]} dflow=${dflowState(ep)} txRemaining=${txRemaining()} received=${received.length}`);
    }
  }

  console.log(`transfer: sent=${payload.length}B received=${received.length}B t=${vnow}ms lastSnr=${lastRealSnr === null ? "n/a" : lastRealSnr.toFixed(1) + "dB"}`);
  // Real modem measurement, not the 12.0 placeholder this used to send to
  // deliver(): a real freedv decode over a direct in-WASM audio path (no
  // channel impairment modelled here) reads high and steady, but it must
  // still be a genuine, finite reading -- not NaN/0/exactly-12.0, which
  // would mean the getter silently fell back to nothing.
  const snrReal = lastRealSnr !== null && Number.isFinite(lastRealSnr) && lastRealSnr !== 12.0;
  const ok = received.length === payload.length && received.equals(payload) && snrReal;

  ctrl.destroy(); dataConn.destroy(); audio.destroy(); server.close();
  child.kill("SIGTERM");

  if (!ok) {
    console.log(fs.readFileSync(path.join(tmpDir, "mercury.log"), "utf8"));
  }
  if (!snrReal) console.log(`FAIL: SNR reading looks like a placeholder or missing (lastRealSnr=${lastRealSnr})`);
  console.log(ok
    ? "PASS: a real native mercury process received our WASM-encoded ARQ transfer byte-exact, with a real measured SNR"
    : "FAIL: see above / mercury.log");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
