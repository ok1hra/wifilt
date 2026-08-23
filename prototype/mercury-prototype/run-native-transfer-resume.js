#!/usr/bin/env node
// The real resume-negotiation proof: combines run-native-transfer.js's
// "we are ISS" mechanics with run-native-transfer-reverse.js's "native
// mercury becomes ISS mid-session" mechanics, chained through TWO real
// turn-swaps against a real native `mercury` process:
//
//   we ISS --QUERY--> native IRS
//   native ISS --REPLY--> we IRS      (native "replies" because the test
//                                      script, playing the peer's own
//                                      application, writes the reply bytes
//                                      into native's own DATA TCP port --
//                                      exactly what run-native-transfer-
//                                      reverse.js already does to make
//                                      native become ISS)
//   we ISS --resumed DATA (offset>0)--> native IRS
//
// This is not just "the wire format survives" (already proven by
// run-native-transfer-file.js) -- it proves arq_fsm.c's own automatic
// turn-taking (ARQ_EV_APP_DATA_READY while ARQ_DFLOW_IDLE_IRS -> TURN_REQ,
// confirmed by reading arq_fsm.c directly before writing this) correctly
// carries our two-new-flag-bit QUERY/REPLY resume protocol end to end
// against a real, independently-built peer, with BOTH directions of role
// swap exercised on OUR OWN WASM session (something neither earlier test
// needed: run-native-transfer.js is ISS the whole time, run-native-
// transfer-reverse.js is IRS the whole time -- here we are ISS, then IRS,
// then ISS again, on the same session).
"use strict";
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

delete global.fetch; // see run-loopback.js
const createMercuryHost = require(path.resolve(__dirname, "build-host/mercury-host.js"));
const mf = require(path.resolve(__dirname, "../../data/mercury-file.js"));

const MERCURY_BIN = process.env.MERCURY || path.resolve(__dirname, "../../mercury/mercury");
const CTRL_PORT = 18520 + (process.pid % 1000);
const DATA_PORT = CTRL_PORT + 1;
const BLOCK_N = 800;
const FREEDV_MODE_DATAC16 = 23;
const ARQ_DFLOW_IDLE_IRS = 3;
const EV = { APP_DATA_READY: 4 };
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-resume-"));
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
  audio.on("error", (e) => console.log(`[sim] audio socket error (likely native mercury was killed): ${e.message}`));
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
  let receivedByNative = Buffer.alloc(0); // everything native mercury has delivered to ITS OWN app-side data port
  dataConn.on("data", (d) => { receivedByNative = Buffer.concat([receivedByNative, d]); });

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
  const rxCtrlInit = cw("host_rx_ctrl_init", null, ["number"]);
  const rxPushCtrl = cw("host_rx_push_ctrl", "number", ["number", "number"]);
  const rxCtrlDecodedPtr = cw("host_rx_ctrl_decoded_ptr", "number", []);
  const rxCtrlDecodedLen = cw("host_rx_ctrl_decoded_len", "number", []);
  const rxCtrlClearDecoded = cw("host_rx_ctrl_clear_decoded", null, []);
  const rxCtrlLastSnr = cw("host_rx_ctrl_last_snr", "number", []);

  init();
  let currentRxMode = FREEDV_MODE_DATAC16;
  rxSetMode(currentRxMode);
  rxCtrlInit(FREEDV_MODE_DATAC16);
  const ep = epCreate("NODESIM", "MERCURY1");

  const rxScratchPtr = m._malloc(65535 * 2);
  const txScratchPtr = m._malloc(65535 * 2);
  const deliverBufPtr = m._malloc(4096);

  let vnow = 0;
  let blockSeq = 0;
  let lastRealSnr = null;
  let receivedByUs = Buffer.alloc(0); // whatever native mercury sends US (only happens while it's ISS -- the REPLY phase)
  let deliveredSoFar = 0; // host_delivered() is a cumulative PEEK, not a drain -- see [[mercury-e1-wasm-trim-progress]]

  async function exchangeOneBlock() {
    const avail = txRemaining();
    const take = Math.min(avail, BLOCK_N);
    if (take > 0) {
      const p = txPtr() >> 1;
      m.HEAP16.copyWithin(txScratchPtr >> 1, p, p + take);
      txAdvance(take);
    }
    if (avail > 0 && txRemaining() === 0) dispatchSimple(ep, 22); // ARQ_EV_TX_COMPLETE

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

    const wantMode = dflowState(ep) === ARQ_DFLOW_IDLE_IRS ? peerTxMode(ep) : FREEDV_MODE_DATAC16;
    if (wantMode !== currentRxMode && wantMode > 0) {
      currentRxMode = wantMode;
      rxSetMode(currentRxMode);
      if (process.env.HOST_DEBUG) console.log(`  t=${vnow}ms [rx-mode] -> ${currentRxMode}`);
    }

    for (let i = 0; i < sta.n; i++) m.HEAP16[(rxScratchPtr >> 1) + i] = sta.body.readInt16LE(i * 2);
    let anyDecoded = false;
    if (sta.n > 0) {
      if (rxPushCtrl(rxScratchPtr, sta.n)) {
        anyDecoded = true;
        const len = rxCtrlDecodedLen(), ptr = rxCtrlDecodedPtr(), snr = rxCtrlLastSnr();
        lastRealSnr = snr;
        deliver(ep, ptr, len, snr);
        rxCtrlClearDecoded();
      }
      if (rxPush(rxScratchPtr, sta.n)) {
        anyDecoded = true;
        const len = rxDecodedLen(), ptr = rxDecodedPtr(), snr = rxLastSnr();
        lastRealSnr = snr;
        deliver(ep, ptr, len, snr);
        rxClearDecoded();
      }
    }
    if (anyDecoded) {
      const totalLen = delivered(ep, deliverBufPtr, 4096);
      if (totalLen > deliveredSoFar) {
        const chunk = Buffer.from(m.HEAPU8.subarray(deliverBufPtr + deliveredSoFar, deliverBufPtr + totalLen));
        receivedByUs = Buffer.concat([receivedByUs, chunk]);
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
      console.log(`  t=${vnow}ms heartbeat: conn=${CONN_STATE[connState(ep)]} dflow=${dflowState(ep)} txRemaining=${txRemaining()} byNative=${receivedByNative.length} byUs=${receivedByUs.length}`);
    }
    if (txRemaining() > 0) return;
    if (!takeOutframe(ep)) return;
    const len = ofLen(), mode = ofMode(), ptr = ofBuf();
    const started = txStart(mode, ptr, len);
    if (process.env.HOST_DEBUG) console.log(`  t=${vnow}ms [tx] mode=${mode} len=${len} started=${started}`);
  }

  async function pumpUntil(predicate, label, timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !childExited) {
      startNextOutframeIfAny();
      await exchangeOneBlock();
      if (predicate()) return true;
    }
    console.log(`FAIL: timed out waiting for [${label}]`);
    return false;
  }

  console.log("[wasm] dialing MERCURY1...");
  connect(ep, "MERCURY1");
  if (!(await pumpUntil(() => connState(ep) === 4, "CONNECTED"))) {
    console.log(ctrlLog);
    process.exit(1);
  }
  console.log(`[wasm] CONNECTED at t=${vnow}ms`);

  // ---- the file being transferred, and the peer's simulated prior state ----
  const fileName = "resume-test.bin";
  const fileContent = Buffer.from(Array.from({ length: 120 }, (_, i) => (i * 7 + 11) & 0xff));
  const fileHash = await mf.sha256(fileContent);
  const resumeOffset = 50; // "the peer already has the first 50 bytes from an earlier interrupted attempt"
  console.log(`[setup] file=${fileContent.length}B name=${fileName} sha256=${mf.hex(fileHash)} simulated peer already has=${resumeOffset}B`);

  function queueOurBytes(bytes) {
    const ptr = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, ptr);
    queueTx(ep, ptr, bytes.length);
    m._free(ptr);
    dispatchSimple(ep, EV.APP_DATA_READY);
  }

  // ---- phase 1: we (ISS) send a QUERY ----
  const query = mf.queryHeader({ totalSize: fileContent.length, sha256: fileHash, name: fileName });
  queueOurBytes(query);
  console.log(`[phase1] queued QUERY (${query.length}B)`);
  if (!(await pumpUntil(() => receivedByNative.length >= query.length, "QUERY delivered to native"))) process.exit(1);
  const parsedQuery = mf.parseHeader(receivedByNative.subarray(0, query.length));
  console.log(`[phase1] native received QUERY: isQuery=${parsedQuery.isQuery} name=${parsedQuery.name} totalSize=${parsedQuery.totalSize}`);
  if (!parsedQuery.isQuery) { console.log("FAIL: delivered bytes did not parse as a QUERY"); process.exit(1); }

  // ---- phase 2: the "peer" (scripted here) replies by writing straight into
  // native mercury's own DATA port -- exactly run-native-transfer-reverse.js's
  // technique for making native become ISS. This is playing the role of the
  // real operator/app on that end deciding how to answer our QUERY. ----
  const reply = mf.replyHeader({ totalSize: fileContent.length, sha256: fileHash, name: fileName, haveBytes: resumeOffset });
  dataConn.write(reply);
  console.log(`[phase2] wrote REPLY (${reply.length}B, offset=${resumeOffset}) into native's data port -- it should turn ISS and send this to us`);
  if (!(await pumpUntil(() => receivedByUs.length >= reply.length, "REPLY received by us"))) process.exit(1);
  const parsedReply = mf.parseHeader(receivedByUs.subarray(0, reply.length));
  console.log(`[phase2] we received REPLY: isReply=${parsedReply.isReply} isResume=${parsedReply.isResume} offset=${parsedReply.offset}`);
  if (!parsedReply.isReply || parsedReply.offset !== resumeOffset) { console.log("FAIL: REPLY did not round-trip the negotiated offset"); process.exit(1); }

  // ---- phase 3: we (IRS right now) queue the REAL resumed data phase --
  // queuing while IDLE_IRS is exactly what arq_fsm.c's own
  // "case ARQ_DFLOW_IDLE_IRS: ... APP_DATA_READY -> TURN_REQ" path is for
  // (read directly from source before writing this test) -- it should turn
  // us back into ISS automatically. ----
  const remainder = fileContent.subarray(resumeOffset);
  const dataHeader = mf.dataHeader({ totalSize: fileContent.length, sha256: fileHash, name: fileName, offset: resumeOffset, deflated: false });
  const finalPayload = Buffer.concat([Buffer.from(dataHeader), remainder]);
  queueOurBytes(finalPayload);
  console.log(`[phase3] queued resumed DATA (${finalPayload.length}B, offset=${resumeOffset})`);
  const expectedNativeTotal = query.length + finalPayload.length;
  if (!(await pumpUntil(() => receivedByNative.length >= expectedNativeTotal, "resumed DATA delivered to native"))) process.exit(1);

  const finalBytes = receivedByNative.subarray(query.length, expectedNativeTotal);
  let parsedFinal = null;
  let ok = false;
  try {
    parsedFinal = mf.parseHeader(finalBytes);
    const recoveredContent = finalBytes.subarray(parsedFinal.headerLength);
    const nameOk = parsedFinal.name === fileName;
    const sizeOk = parsedFinal.totalSize === fileContent.length;
    const offsetOk = parsedFinal.offset === resumeOffset;
    const hashOk = mf.hex(parsedFinal.sha256) === mf.hex(fileHash);
    const contentOk = recoveredContent.equals(remainder);
    console.log(`[phase3] parsed final: name=${JSON.stringify(parsedFinal.name)} (${nameOk}) totalSize=${parsedFinal.totalSize} (${sizeOk}) offset=${parsedFinal.offset} (${offsetOk}) hash-match=${hashOk} content-match=${contentOk}`);
    ok = nameOk && sizeOk && offsetOk && hashOk && contentOk;
  } catch (e) {
    console.log(`FAIL parsing final header: ${e.message}`);
  }

  console.log(`t=${vnow}ms lastSnr=${lastRealSnr === null ? "n/a" : lastRealSnr.toFixed(1) + "dB"}`);
  ctrl.destroy(); dataConn.destroy(); audio.destroy(); server.close();
  child.kill("SIGTERM");

  if (!ok) console.log(fs.readFileSync(path.join(tmpDir, "mercury.log"), "utf8"));
  console.log(ok
    ? "PASS: real QUERY -> REPLY -> resumed-DATA negotiation completed across two real ARQ turn-swaps against native mercury, byte-exact from the negotiated offset"
    : "FAIL: see above / mercury.log");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
