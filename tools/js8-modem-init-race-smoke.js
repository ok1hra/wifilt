#!/usr/bin/env node
"use strict";

// The modem worker's message queue does not wait for `init`.
//
// `init` is three fetches and two WASM instantiations deep, so an `async` message
// handler returns to the queue at its first await and the next message is
// dispatched into a worker whose `runtime` is still undefined. The DATA page
// ticks `expire` once a second from page load, so on 2026-08-12 the first tick
// landed at 2 % ("Loading Brotli decoder"), threw "runtime is undefined", and the
// adapter reported it the way it reports a dropped download: "Modem loading
// failed" on a modem that was downloading perfectly well. The fault was written
// on 2026-08-01 and stayed invisible until the content-derived `?v=` evicted the
// cached pre-`expire` worker, which had ignored the unknown message type.
//
// These checks drive the real data/js8-worker.js through its Node branch with
// stub modules, in the order the page produces. Point JS8_WORKER at another copy
// of the file to prove they go red on the version without the gate:
//
//   git show HEAD~1:data/js8-worker.js > /tmp/old-worker.js
//   JS8_WORKER=/tmp/old-worker.js node tools/js8-modem-init-race-smoke.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const workerPath = path.resolve(process.env.JS8_WORKER ||
  path.join(__dirname, "..", "data", "js8-worker.js"));

// ---- stub modules the worker will require ----------------------------------

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "js8-init-race-"));
const stubPath = name => path.join(stubDir, name);

fs.writeFileSync(stubPath("runtime.js"), `
"use strict";
const calls = [];
const control = {failConstruct: false};
class Js8WorkerRuntime {
  constructor() { if (control.failConstruct) throw new Error("stub runtime refused"); calls.push("construct"); }
  state() { return {}; }
  beginEpoch() { calls.push("epoch"); return {}; }
  pushAud1() { calls.push("audio"); return {}; }
  expire() { calls.push("expire"); }
  finish() { calls.push("finish"); return {}; }
  reset() { calls.push("reset"); }
  destroy() { calls.push("destroy"); }
}
module.exports = {Js8WorkerRuntime, calls, control};
`);

// Emscripten factories are asynchronous, and the gap is the whole point: it is
// where the handler hands control back to the message queue.
const factory = `module.exports = async () => { await new Promise(r => setTimeout(r, 5)); return {}; };\n`;
fs.writeFileSync(stubPath("portable.js"), factory);
fs.writeFileSync(stubPath("decoder.js"), factory);
fs.writeFileSync(stubPath("portable.wasm"), Buffer.alloc(4));
fs.writeFileSync(stubPath("decoder.wasm"), Buffer.alloc(4));

const stubRuntime = require(stubPath("runtime.js"));

const initMessage = {
  type: "init",
  runtimeJs: stubPath("runtime.js"),
  portableJs: stubPath("portable.js"),
  decoderJs: stubPath("decoder.js"),
  anchorUtcMs: 0,
};

// ---- fake worker_threads ----------------------------------------------------

let activePort = null;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "worker_threads") return {parentPort: activePort};
  return realLoad.apply(this, arguments);
};

// Each scenario gets a worker with a fresh module registration: the file is an
// IIFE that subscribes to whatever parentPort existed when it was required.
function startWorker() {
  const port = {
    sent: [],
    pending: [],
    handler: null,
    on(event, handler) { if (event === "message") this.handler = handler; },
    postMessage(value) { this.sent.push(value); },
    send(message) { this.pending.push(this.handler(message)); },
    settle() { return Promise.all(this.pending); },
  };
  activePort = port;
  stubRuntime.calls.length = 0;
  delete require.cache[require.resolve(workerPath)];
  require(workerPath);
  return port;
}

const types = port => port.sent.map(message => message.type);
const checks = {};

async function run() {
  // 1. The page's own order: init, then a reassembly tick one message later.
  {
    const port = startWorker();
    port.send(initMessage);
    port.send({type: "expire", nowMs: 1000});
    await port.settle();
    checks.raceReady = types(port).includes("ready");
    checks.raceNoError = !types(port).includes("error");
    checks.raceExpireRan = stubRuntime.calls.join(",") === "construct,expire";
    checks.raceExpireAfterReady = (() => {
      const ready = types(port).indexOf("ready");
      const state = types(port).indexOf("state");
      return ready >= 0 && state > ready;
    })();
  }

  // 2. Nothing is dropped and nothing is reordered: three early messages reach
  //    the runtime, in the order the page sent them.
  {
    const port = startWorker();
    port.send(initMessage);
    port.send({type: "epoch", streamId: 7, anchorUtcMs: 5});
    port.send({type: "audio", wire: "x", arrivalMs: 6});
    port.send({type: "expire", nowMs: 7});
    await port.settle();
    checks.queueOrdered = stubRuntime.calls.join(",") === "construct,epoch,audio,expire";
    checks.queueNoError = !types(port).includes("error");
  }

  // 3. An init that fails reports once. The ticks that follow must not turn one
  //    broken download into a failure report per second.
  {
    stubRuntime.control.failConstruct = true;
    const port = startWorker();
    port.send(initMessage);
    port.send({type: "expire", nowMs: 1000});
    port.send({type: "expire", nowMs: 2000});
    await port.settle();
    stubRuntime.control.failConstruct = false;
    checks.failReportedOnce = types(port).filter(type => type === "error").length === 1;
    checks.failNamesTheCause = port.sent.some(message =>
      message.type === "error" && /stub runtime refused/.test(message.message));
    checks.failTicksSilent = !types(port).includes("state");
  }

  // 4. After ready, a tick still does its job -- the gate must not become a mute.
  {
    const port = startWorker();
    port.send(initMessage);
    await port.settle();
    port.send({type: "expire", nowMs: 3000});
    await port.settle();
    checks.readyTickWorks = stubRuntime.calls.join(",") === "construct,expire" &&
      types(port).includes("state");
  }
}

run().then(() => {
  fs.rmSync(stubDir, {recursive: true, force: true});
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  const report = `JS8 MODEM INIT RACE ${failed.length ? "FAIL" : "PASS"} ${JSON.stringify(checks)}`;
  (failed.length ? console.error : console.log)(report);
  if (failed.length) process.exitCode = 1;
}, error => {
  console.error(`JS8 MODEM INIT RACE FAIL ${error && error.stack || error}`);
  process.exitCode = 1;
});
