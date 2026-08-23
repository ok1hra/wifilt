#!/usr/bin/env node
// docs/mercury-implementace.md risk #1 ("Odolnost modemu proti šumu není
// změřena... můj vlastní sweep selhal a nelze z něj nic vyvozovat") --
// measured here instead against the REAL bridge from run-native-transfer.js
// (our WASM ARQ session vs. a real, independently-built native `mercury`
// process), not a synthetic erasure-probability model. Calibrated AWGN is
// added to the PCM samples crossing the bridge in both directions, at a
// swept list of target SNRs, and each run's outcome (reached CONNECTED?,
// bytes delivered byte-exact?, final mode, virtual ms) is reported.
//
// Noise calibration: REF_RMS is the actual measured RMS of a real DATAC16
// burst from this WASM build (see this file's own header history / README
// -- measured once via a throwaway script, not assumed), so
// noise_std = REF_RMS * 10^(-snrDb/20) is anchored to a real signal level,
// not a guess.
"use strict";
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

delete global.fetch;
const createMercuryHost = require(path.resolve(__dirname, "build-host/mercury-host.js"));

const MERCURY_BIN = process.env.MERCURY || path.resolve(__dirname, "../../mercury/mercury");
const BLOCK_N = 800;
const FREEDV_MODE_DATAC16 = 23;
const CONN_STATE = ["DISCONNECTED", "LISTENING", "CALLING", "ACCEPTING", "CONNECTED", "DISCONNECTING"];
const REF_RMS = 8059; // measured from a real DATAC16 CALL burst, this WASM build (see README)
const PAYLOAD_LEN = 300;
const WALL_TIMEOUT_MS = 90000;

// Mulberry32, seeded: reproducible across runs, unlike Math.random().
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeGaussian(rand) {
  let spare = null;
  return function () {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u, v, s;
    do { u = rand() * 2 - 1; v = rand() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const mul = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * mul;
    return u * mul;
  };
}

function clampI16(x) { return x < -32768 ? -32768 : x > 32767 ? 32767 : x | 0; }

async function connectRetry(port, tries = 30) {
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
function ctlSend(sock, cmd) {
  return new Promise((resolve) => {
    let acc = "";
    const onData = (d) => { acc += d.toString(); };
    sock.on("data", onData);
    sock.write(cmd + "\r");
    setTimeout(() => { sock.off("data", onData); resolve(acc); }, 400);
  });
}

async function runAt(snrDb) {
  const gauss = makeGaussian(mulberry32(0xC0FFEE ^ (Number.isFinite(snrDb) ? (snrDb * 1000) | 0 : 0)));
  const noiseStd = Number.isFinite(snrDb) ? REF_RMS * Math.pow(10, -snrDb / 20) : 0;
  // Unique-ish per (pid, snr) so a leftover process from a killed prior sweep
  // point can't collide with this one's control port (see run-native-transfer.js's
  // README note about exactly this bug).
  const CTRL_PORT = 19000 + ((process.pid + Math.round((Number.isFinite(snrDb) ? snrDb : 999) * 7)) % 4000);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-noise-"));
  const sockPath = path.join(tmpDir, "audio.sock");
  const logFd = fs.openSync(path.join(tmpDir, "mercury.log"), "w");

  const server = net.createServer();
  const connectionPromise = new Promise((resolve) => server.once("connection", resolve));
  await new Promise((resolve) => server.listen(sockPath, resolve));

  const child = spawn(MERCURY_BIN, ["-x", "sock", "-m", "1", "-p", String(CTRL_PORT), "-b", String(CTRL_PORT + 1000)], {
    env: { ...process.env, MERCURY_AUDIO_SOCK: sockPath },
    stdio: ["ignore", logFd, logFd],
  });
  let childExited = false;
  child.on("exit", () => { childExited = true; });
  const killChild = () => { try { child.kill("SIGKILL"); } catch (_) {} };
  const sigHandler = () => { killChild(); process.exit(1); };
  process.on("SIGINT", sigHandler); process.on("SIGTERM", sigHandler);

  const result = { snrDb, connected: false, delivered: 0, ok: false, finalMode: null, vnow: 0, error: null };
  try {
    const audio = await Promise.race([
      connectionPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("no audio connect")), 10000)),
    ]);
    const ctrl = await connectRetry(CTRL_PORT);
    await ctlSend(ctrl, "MYCALL MERCURY1");
    await ctlSend(ctrl, "LISTEN ON");
    const dataConn = await connectRetry(CTRL_PORT + 1);
    let received = Buffer.alloc(0);
    dataConn.on("data", (d) => { received = Buffer.concat([received, d]); });

    let audioBuf = Buffer.alloc(0);
    let resolveFrame = null;
    audio.on("data", (chunk) => {
      audioBuf = Buffer.concat([audioBuf, chunk]);
      while (audioBuf.length >= 4) {
        const len = audioBuf.readUInt32LE(0);
        if (audioBuf.length < 4 + len) break;
        const frame = audioBuf.subarray(4, 4 + len);
        audioBuf = audioBuf.subarray(4 + len);
        if (resolveFrame) {
          const r = resolveFrame; resolveFrame = null;
          r({ seq: frame.readBigUInt64LE(0), ptt: frame.readUInt8(8), n: frame.readUInt16LE(9), body: frame.subarray(11) });
        }
      }
    });
    const nextStationFrame = () => new Promise((resolve) => { resolveFrame = resolve; });

    const m = await createMercuryHost();
    const cw = (name, ret, args) => m.cwrap(name, ret, args);
    const init = cw("host_init", null, []);
    const epCreate = cw("host_endpoint_create", "number", ["string", "string"]);
    const dispatchSimple = cw("host_dispatch_simple", null, ["number", "number"]);
    const connect = cw("host_connect", null, ["number", "string"]);
    const queueTx = cw("host_queue_tx", null, ["number", "number", "number"]);
    const connState = cw("host_conn_state", "number", ["number"]);
    const payloadMode = cw("host_payload_mode", "number", ["number"]);
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

    init();
    rxSetMode(FREEDV_MODE_DATAC16);
    const ep = epCreate("NODESIM", "MERCURY1");
    const rxScratchPtr = m._malloc(65535 * 2);
    const txScratchPtr = m._malloc(65535 * 2);

    let vnow = 0, blockSeq = 0;

    async function exchangeOneBlock() {
      const avail = txRemaining();
      const take = Math.min(avail, BLOCK_N);
      if (take > 0) {
        const p = txPtr() >> 1;
        m.HEAP16.copyWithin(txScratchPtr >> 1, p, p + take);
        txAdvance(take);
      }
      if (avail > 0 && txRemaining() === 0) dispatchSimple(ep, 22);

      const buf = Buffer.alloc(4 + 18 + BLOCK_N * 2);
      buf.writeUInt32LE(18 + BLOCK_N * 2, 0);
      buf.writeBigUInt64LE(BigInt(blockSeq), 4);
      buf.writeBigUInt64LE(BigInt(vnow), 12);
      buf.writeUInt16LE(BLOCK_N, 20);
      for (let i = 0; i < BLOCK_N; i++) {
        let s = i < take ? m.HEAP16[(txScratchPtr >> 1) + i] : 0;
        if (noiseStd > 0) s = clampI16(Math.round(s + gauss() * noiseStd));
        buf.writeInt16LE(s, 22 + i * 2);
      }
      audio.write(buf);
      blockSeq++;

      const sta = await Promise.race([
        nextStationFrame(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("station frame timeout")), 8000)),
      ]);

      for (let i = 0; i < sta.n; i++) {
        let s = sta.body.readInt16LE(i * 2);
        if (noiseStd > 0) s = clampI16(Math.round(s + gauss() * noiseStd));
        m.HEAP16[(rxScratchPtr >> 1) + i] = s;
      }
      if (sta.n > 0 && rxPush(rxScratchPtr, sta.n)) {
        deliver(ep, rxDecodedPtr(), rxDecodedLen(), Number.isFinite(snrDb) ? snrDb : 20.0);
        rxClearDecoded();
      }

      vnow += Math.round((BLOCK_N / 8000) * 1000);
      clockAdvance(vnow);
      for (let i = 0; i < 8 && fireDeadline(ep, vnow); i++) { /* chained zero-delay transitions */ }
    }
    function startNextOutframeIfAny() {
      if (txRemaining() > 0) return;
      if (!takeOutframe(ep)) return;
      txStart(ofMode(), ofBuf(), ofLen());
    }

    connect(ep, "MERCURY1");
    const wallDeadline = Date.now() + WALL_TIMEOUT_MS;
    while (Date.now() < wallDeadline && !childExited) {
      startNextOutframeIfAny();
      await exchangeOneBlock();
      if (connState(ep) === 4) break;
    }
    result.connected = connState(ep) === 4;
    result.vnow = vnow;

    if (result.connected) {
      const payload = Buffer.alloc(PAYLOAD_LEN);
      for (let i = 0; i < payload.length; i++) payload[i] = (i * 13 + 5) & 0xff;
      const ptr = m._malloc(payload.length);
      m.HEAPU8.set(payload, ptr);
      queueTx(ep, ptr, payload.length);
      m._free(ptr);
      dispatchSimple(ep, 4 /* APP_DATA_READY */);

      const xferDeadline = Date.now() + WALL_TIMEOUT_MS;
      while (Date.now() < xferDeadline && !childExited && received.length < payload.length) {
        startNextOutframeIfAny();
        await exchangeOneBlock();
      }
      result.delivered = received.length;
      result.ok = received.length === payload.length && received.equals(payload);
      result.finalMode = payloadMode(ep);
      result.vnow = vnow;
    }
  } catch (e) {
    result.error = e.message;
  } finally {
    killChild();
    process.off("SIGINT", sigHandler); process.off("SIGTERM", sigHandler);
    server.close();
  }
  return result;
}

async function main() {
  const levels = process.argv.length > 2
    ? process.argv.slice(2).map((s) => (s === "clean" ? Infinity : Number(s)))
    : [Infinity, 20, 15, 10, 6, 3, 0, -3, -6, -9];
  const results = [];
  for (const snr of levels) {
    process.stdout.write(`SNR=${snr === Infinity ? "clean" : snr + "dB"}: running... `);
    const r = await runAt(snr);
    results.push(r);
    console.log(r.error
      ? `ERROR (${r.error})`
      : `connected=${r.connected} delivered=${r.delivered}/${PAYLOAD_LEN} ok=${r.ok} finalMode=${r.finalMode} t=${r.vnow}ms`);
  }
  console.log("\n| SNR | connected | delivered | byte-exact | final mode | virtual ms |");
  console.log("|---|---|---:|---|---|---:|");
  for (const r of results) {
    console.log(`| ${r.snrDb === Infinity ? "clean" : r.snrDb + " dB"} | ${r.connected} | ${r.delivered}/${PAYLOAD_LEN} | ${r.ok} | ${r.finalMode ?? "-"} | ${r.vnow} |`);
  }
  process.exit(0);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
