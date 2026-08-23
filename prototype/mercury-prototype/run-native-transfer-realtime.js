#!/usr/bin/env node
// Real-time-paced variant of run-native-transfer.js, proving the SAME ARQ
// session against the SAME real native `mercury` peer, but driven by an
// actual wall-clock timer instead of a synchronous "send one block, block on
// mercury's reply, immediately send the next" lockstep loop. That lockstep
// completed a ~60 virtual-second transfer in ~1-2 real seconds -- it never
// exercised real timer jitter or a genuinely decoupled send/receive path.
//
// This matters because the eventual Worker pump (docs/mercury-implementace.md
// ch.4.2) will be driven by REAL AUD1 audio arriving at true ~20ms cadence
// with real jitter, not a synchronous loop -- and this project has already
// found one real pacing bug from assuming "nominal" timing instead of
// measuring real elapsed time (aud1-worker-smoke's TX packet loop, fixed
// 2026-08-22: relative setTimeout(20ms) compounded real overhead). Cheaper to
// find the ARQ-pump equivalent of that bug here, against a deterministic
// native-mercury peer with no hardware/radio involved, than after wiring
// AUD1 -- same "isolate variables" discipline as the whole E1 test ladder.
//
// Real-time changes from run-native-transfer.js:
//   - A `setInterval` ticks every BLOCK_MS (nominal), but the FSM's clock is
//     advanced by the REAL elapsed wall time since the last tick, not the
//     nominal 100ms -- exactly like real AUD1 packets, whose arrival times
//     jitter around their nominal 20ms spacing.
//   - Sending this tick's outgoing block and consuming whatever station
//     frame(s) arrived are fully decoupled (a queue, not a single-slot
//     "await the next frame" promise) -- ticks never block on a reply.
"use strict";
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

delete global.fetch; // see run-loopback.js
const createMercuryHost = require(path.resolve(__dirname, "build-host/mercury-host.js"));

const MERCURY_BIN = process.env.MERCURY || path.resolve(__dirname, "../../mercury/mercury");
const CTRL_PORT = 18410 + (process.pid % 1000); // different base than run-native-transfer.js's, avoids collisions if both run at once
const DATA_PORT = CTRL_PORT + 1;
const BLOCK_N = 160; // 20ms/block @ 8kHz -- matches real AUD1's RX packet cadence, not the 100ms lockstep test used
const BLOCK_MS = (BLOCK_N / 8000) * 1000; // 20ms nominal
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-transfer-rt-"));
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
  let received = Buffer.alloc(0);
  dataConn.on("data", (d) => { received = Buffer.concat([received, d]); });

  // ---- audio framing: parse into a QUEUE, not a single-slot promise -- ticks
  // must never block waiting for a reply. ----
  let audioBuf = Buffer.alloc(0);
  const frameQueue = [];
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
    frameQueue.push({ seq: frame.readBigUInt64LE(0), ptt: frame.readUInt8(8), n: frame.readUInt16LE(9), body: frame.subarray(11) });
    if (audioBuf.length >= 4) tryParse();
  }

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
  const fireDeadline = cw("host_fire_deadline_if_due", "number", ["number", "number"]);
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

  let vnow = 0;             // virtual clock fed to the FSM, advanced by REAL elapsed ms each tick
  let blockSeq = 0;
  let sawPttOn = false;
  let lastRealSnr = null;
  let ticks = 0, maxTickGapMs = 0;
  const wallStart = Date.now();
  let lastTickWall = wallStart;

  function startNextOutframeIfAny() {
    if (txRemaining() > 0) return; // still streaming the previous one
    if (!takeOutframe(ep)) return;
    const len = ofLen(), mode = ofMode(), ptr = ofBuf();
    const started = txStart(mode, ptr, len);
    if (process.env.HOST_DEBUG) console.log(`  t=${vnow}ms [tx] mode=${mode} len=${len} started=${started}`);
    if (started < 0) console.log(`  [tx] host_tx_start FAILED mode=${mode} len=${len} rc=${started}`);
  }

  function tick() {
    ticks++;
    const wallNow = Date.now();
    const realGapMs = wallNow - lastTickWall;
    lastTickWall = wallNow;
    maxTickGapMs = Math.max(maxTickGapMs, realGapMs);

    startNextOutframeIfAny();

    // ---- outgoing (us -> mercury): pull up to BLOCK_N samples from whatever we're transmitting ----
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

    // ---- incoming (mercury -> us): drain whatever landed in the queue since the last tick ----
    while (frameQueue.length) {
      const sta = frameQueue.shift();
      if (sta.ptt === 1) sawPttOn = true;
      for (let i = 0; i < sta.n; i++) m.HEAP16[(rxScratchPtr >> 1) + i] = sta.body.readInt16LE(i * 2);
      if (sta.n > 0 && rxPush(rxScratchPtr, sta.n)) {
        const len = rxDecodedLen();
        const ptr = rxDecodedPtr();
        const snr = rxLastSnr();
        lastRealSnr = snr;
        const ok = deliver(ep, ptr, len, snr);
        if (process.env.HOST_DEBUG) console.log(`  t=${vnow}ms [deliver] ok=${ok} snr=${snr.toFixed(1)}dB conn=${CONN_STATE[connState(ep)]}`);
        rxClearDecoded();
      }
    }

    // ---- virtual clock advances by REAL elapsed time, not a nominal constant ----
    vnow += Math.max(1, realGapMs);
    clockAdvance(vnow);
    for (let i = 0; i < 8 && fireDeadline(ep, vnow); i++) { /* drain chained zero-delay transitions */ }
  }

  console.log("[wasm] dialing MERCURY1 (real-time paced)...");
  connect(ep, "MERCURY1");

  const timer = setInterval(tick, BLOCK_MS);
  let lastState = -1;

  async function waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (childExited) throw new Error(`mercury exited while waiting for ${label}`);
      const st = connState(ep);
      if (st !== lastState) { console.log(`  t=${vnow}ms state=${CONN_STATE[st]}`); lastState = st; }
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  const gotConnected = await waitFor(() => connState(ep) === 4, 120000, "CONNECTED");
  if (!gotConnected) {
    clearInterval(timer);
    console.log(ctrlLog);
    console.log("FAIL: handshake with native mercury did not reach CONNECTED (real-time pacing)");
    process.exit(1);
  }
  console.log(`[wasm] CONNECTED at t=${vnow}ms (${ticks} real ticks, ${(Date.now() - wallStart)}ms real elapsed, maxTickGap=${maxTickGapMs}ms)`);

  const payload = Buffer.alloc(300);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 13 + 5) & 0xff;
  const payloadPtr = m._malloc(payload.length);
  m.HEAPU8.set(payload, payloadPtr);
  queueTx(ep, payloadPtr, payload.length);
  m._free(payloadPtr);
  dispatchSimple(ep, EV.APP_DATA_READY);
  console.log(`[wasm] queued ${payload.length}B for transfer`);

  const gotTransfer = await waitFor(() => received.length >= payload.length, 180000, "transfer complete");
  clearInterval(timer);

  console.log(`transfer: sent=${payload.length}B received=${received.length}B t=${vnow}ms realElapsedMs=${Date.now() - wallStart} ticks=${ticks} maxTickGapMs=${maxTickGapMs} lastSnr=${lastRealSnr === null ? "n/a" : lastRealSnr.toFixed(1) + "dB"}`);
  const snrReal = lastRealSnr !== null && Number.isFinite(lastRealSnr) && lastRealSnr !== 12.0;
  const ok = gotTransfer && received.length === payload.length && received.equals(payload) && snrReal;

  ctrl.destroy(); dataConn.destroy(); audio.destroy(); server.close();
  child.kill("SIGTERM");

  if (!ok) console.log(fs.readFileSync(path.join(tmpDir, "mercury.log"), "utf8"));
  if (!snrReal) console.log(`FAIL: SNR reading looks like a placeholder or missing (lastRealSnr=${lastRealSnr})`);
  console.log(ok
    ? "PASS: real native mercury transfer completed under REAL wall-clock timer pacing (not lockstep), byte-exact, real SNR"
    : "FAIL: see above / mercury.log");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
