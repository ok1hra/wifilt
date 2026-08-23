#!/usr/bin/env node
// E3 go/no-go proof: the SAME real native-mercury ARQ transfer as
// run-native-transfer.js, but the bytes queued for transfer are now a real
// MRQ1-wrapped file (data/mercury-file.js) instead of a bare random payload.
// Native mercury has no idea MRQ1 exists -- it just carries opaque bytes,
// which is the whole point of putting the header inside the ARQ byte-pipe
// rather than asking ARQ itself to change. Proves the framing (magic,
// flags, 64-bit size/offset, sha256, name) survives byte-exact through a
// REAL freedv-modulated transfer, and that mercury-file.js's parseHeader()
// recovers exactly what buildHeader() put in on the other end.
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
const CTRL_PORT = 18310 + (process.pid % 1000);
const DATA_PORT = CTRL_PORT + 1;
const BLOCK_N = 800;
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-file-transfer-"));
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
  audio.on("error", () => {}); // a killed-mid-run timeout SIGKILLs mercury and slams this shut
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
  const fireDeadline = cw("host_fire_deadline_if_due", "number", ["number", "number"]);
  const clockAdvance = cw("host_clock_advance_to_ms", null, ["number"]);
  const deliver = cw("host_deliver", "number", ["number", "number", "number", "number"]);
  const txRemaining = cw("host_tx_remaining", "number", []);
  const txPtr = cw("host_tx_ptr", "number", []);
  const txAdvance = cw("host_tx_advance", null, ["number"]);
  const txStart = cw("host_tx_start", "number", ["number", "number", "number"]);
  const rxSetMode = cw("host_rx_set_mode", null, ["number"]);
  const rxPush = cw("host_rx_push", "number", ["number", "number"]);
  const rxDecodedPtr = cw("host_rx_decoded_ptr", "number", []);
  const rxDecodedLen = cw("host_rx_decoded_len", "number", []);
  const rxClearDecoded = cw("host_rx_clear_decoded", null, []);
  const rxLastSnr = cw("host_rx_last_snr", "number", []);

  init();
  rxSetMode(FREEDV_MODE_DATAC16);
  const ep = epCreate("NODESIM", "MERCURY1");

  const rxScratchPtr = m._malloc(65535 * 2);
  const txScratchPtr = m._malloc(65535 * 2);

  let vnow = 0;
  let blockSeq = 0;
  let lastRealSnr = null;

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

    for (let i = 0; i < sta.n; i++) m.HEAP16[(rxScratchPtr >> 1) + i] = sta.body.readInt16LE(i * 2);
    if (sta.n > 0 && rxPush(rxScratchPtr, sta.n)) {
      const len = rxDecodedLen();
      const ptr = rxDecodedPtr();
      const snr = rxLastSnr();
      lastRealSnr = snr;
      deliver(ep, ptr, len, snr);
      rxClearDecoded();
    }

    vnow += Math.round((BLOCK_N / 8000) * 1000);
    clockAdvance(vnow);
    for (let i = 0; i < 8 && fireDeadline(ep, vnow); i++) { /* drain chained zero-delay transitions */ }
  }

  function startNextOutframeIfAny() {
    if (txRemaining() > 0) return;
    if (!takeOutframe(ep)) return;
    const len = ofLen(), mode = ofMode(), ptr = ofBuf();
    txStart(mode, ptr, len);
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

  // ---- build a real MRQ1-framed file and queue THAT, not raw bytes ----
  // Kept in the same ~300B class as run-native-transfer.js's own baseline on
  // purpose: this harness paces audio in (near-)real time through a real
  // native mercury process, so a several-kB file would take on the order of
  // an hour at these established per-byte rates (~60-140s for 300B). Proving
  // the MRQ1 framing survives byte-exact does not need a bigger file --
  // header/name/hash/offset correctness is independent of payload size.
  const fileName = "qso-log.csv";
  const fileContent = Buffer.from(
    Array.from({ length: 6 }, (_, i) => `2026-08-2${i}T12:0${i},OK1HRA,OK2XYZ,-9,${i}\n`).join(""),
    "utf8"
  );
  const fileHash = await mf.sha256(fileContent);
  const header = mf.dataHeader({
    totalSize: fileContent.length, sha256: fileHash, name: fileName, offset: 0, deflated: false,
  });
  const payload = Buffer.concat([Buffer.from(header), fileContent]);
  console.log(`[mrq1] header=${header.length}B file=${fileContent.length}B total=${payload.length}B sha256=${mf.hex(fileHash)}`);

  const payloadPtr = m._malloc(payload.length);
  m.HEAPU8.set(payload, payloadPtr);
  queueTx(ep, payloadPtr, payload.length);
  m._free(payloadPtr);
  dispatchSimple(ep, EV.APP_DATA_READY);
  console.log(`[wasm] queued ${payload.length}B (MRQ1-wrapped) for transfer`);

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

  let ok = received.length === payload.length && received.equals(payload);
  let parsed = null;
  if (ok) {
    try {
      parsed = mf.parseHeader(received);
      const recoveredContent = received.subarray(parsed.headerLength);
      const nameOk = parsed.name === fileName;
      const sizeOk = parsed.totalSize === fileContent.length;
      const offsetOk = parsed.offset === 0;
      const hashOk = mf.hex(parsed.sha256) === mf.hex(fileHash);
      const contentOk = recoveredContent.equals(fileContent);
      console.log(`[mrq1] parsed name=${JSON.stringify(parsed.name)} (match=${nameOk}) totalSize=${parsed.totalSize} (match=${sizeOk}) offset=${parsed.offset} (match=${offsetOk}) hash-match=${hashOk} content-match=${contentOk}`);
      ok = nameOk && sizeOk && offsetOk && hashOk && contentOk;
    } catch (e) {
      console.log(`[mrq1] FAIL parsing header out of received bytes: ${e.message}`);
      ok = false;
    }
  }

  ctrl.destroy(); dataConn.destroy(); audio.destroy(); server.close();
  child.kill("SIGTERM");

  if (!ok) console.log(fs.readFileSync(path.join(tmpDir, "mercury.log"), "utf8"));
  console.log(ok
    ? "PASS: a real MRQ1-framed file survived a real native-mercury ARQ transfer byte-exact, header+hash+content all recovered correctly"
    : "FAIL: see above / mercury.log");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
