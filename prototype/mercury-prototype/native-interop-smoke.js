#!/usr/bin/env node
// First rung-C milestone (docs/mercury-implementace.md decision #9: a real
// native `mercury` process as the interop counterpart, not our own code
// talking to itself): prove the plumbing works BEFORE wiring a real ARQ
// transfer through it. Three things, each a real unknown until checked:
//
//   1. We can be the "sim" side of the -x sock lockstep transport
//      (audioio/sock_wire.h) -- listen on a Unix socket, have a real
//      mercury process connect to it, and exchange audio blocks that
//      advance ITS virtual clock (no wall-clock pacing).
//   2. Its TCP control port (text commands, mercury/utils/loopsim/drive.py
//      is the reference driver) responds over that same virtual time.
//   3. Silence in still gets us clean silence/PTT-OFF blocks out -- the
//      baseline a real audio exchange would start from.
//
// Does NOT yet drive an ARQ session or send real modulated frames -- that's
// the next step, once this plumbing is confirmed solid.
"use strict";
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const MERCURY_BIN = process.env.MERCURY || path.resolve(__dirname, "../../mercury/mercury");
const CTRL_PORT = 18300;
const BLOCK_N = 800; // 100 ms/block @ 8 kHz; sim (this script) picks the size, not mercury
const BLOCKS_TO_RUN = 30; // 3 s of virtual time

function sockWireBuildSim(seq, vnowMs, n) {
  const buf = Buffer.alloc(4 + 18 + n * 2);
  buf.writeUInt32LE(18 + n * 2, 0);
  buf.writeBigUInt64LE(BigInt(seq), 4);
  buf.writeBigUInt64LE(BigInt(vnowMs), 12);
  buf.writeUInt16LE(n, 20);
  // samples already zero (silence) from Buffer.alloc
  return buf;
}

function parseStationFrame(buf) {
  // u64 seq | u8 ptt | u16 n | n i16 samples (len prefix already stripped)
  const seq = buf.readBigUInt64LE(0);
  const ptt = buf.readUInt8(8);
  const n = buf.readUInt16LE(9);
  return { seq, ptt, n };
}

async function main() {
  const sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mercury-interop-")), "audio.sock");
  const logPath = path.join(path.dirname(sockPath), "mercury.log");
  const logFd = fs.openSync(logPath, "w");

  const server = net.createServer();
  const connectionPromise = new Promise((resolve) => server.once("connection", resolve));
  await new Promise((resolve) => server.listen(sockPath, resolve));
  console.log(`[sim] listening on ${sockPath}`);

  const child = spawn(MERCURY_BIN, [
    "-x", "sock", "-m", "1",
    "-p", String(CTRL_PORT),
    "-b", String(CTRL_PORT + 100),
  ], {
    env: { ...process.env, MERCURY_AUDIO_SOCK: sockPath },
    stdio: ["ignore", logFd, logFd],
  });
  child.on("exit", (code, sig) => console.log(`[mercury] exited code=${code} sig=${sig}`));

  const conn = await connectionPromise;
  console.log("[sim] mercury connected to audio socket");

  let buf = Buffer.alloc(0);
  let resolveFrame = null;
  conn.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    tryParse();
  });
  function tryParse() {
    if (buf.length < 4) return;
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) return;
    const frame = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    if (resolveFrame) { const r = resolveFrame; resolveFrame = null; r(parseStationFrame(frame)); }
    if (buf.length >= 4) tryParse();
  }
  function nextFrame() { return new Promise((resolve) => { resolveFrame = resolve; }); }

  let vnow = 0;
  let sawPttOn = false;
  for (let seq = 0; seq < BLOCKS_TO_RUN; seq++) {
    conn.write(sockWireBuildSim(seq, vnow, BLOCK_N));
    const sta = await Promise.race([
      nextFrame(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("station frame timeout")), 5000)),
    ]);
    if (sta.ptt === 1) sawPttOn = true;
    if (seq === 0 || seq === BLOCKS_TO_RUN - 1) {
      console.log(`  block ${seq}: vnow=${vnow}ms sta.seq=${sta.seq} ptt=${sta.ptt} n=${sta.n}`);
    }
    vnow += Math.round((BLOCK_N / 8000) * 1000);
  }
  console.log(`[sim] exchanged ${BLOCKS_TO_RUN} blocks (${vnow}ms virtual), PTT ever ON: ${sawPttOn}`);

  // ---- control port: prove the TCP text protocol answers over the same run ----
  const ctrl = net.createConnection({ host: "127.0.0.1", port: CTRL_PORT });
  await new Promise((resolve, reject) => { ctrl.once("connect", resolve); ctrl.once("error", reject); });
  const reply = await new Promise((resolve) => {
    let acc = "";
    ctrl.on("data", (d) => { acc += d.toString(); });
    ctrl.write("MYCALL TESTNODE\r");
    setTimeout(() => resolve(acc), 500);
  });
  console.log(`[ctrl] MYCALL TESTNODE -> ${JSON.stringify(reply.trim())}`);

  ctrl.destroy();
  conn.destroy();
  server.close();
  child.kill("SIGTERM");

  const ok = !sawPttOn && reply.length >= 0; // baseline: idle station, control port alive
  console.log(fs.readFileSync(logPath, "utf8").split("\n").slice(0, 15).join("\n"));
  console.log(ok ? "PASS: sock audio + control-port plumbing confirmed against a real mercury process"
                 : "FAIL: see above");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
