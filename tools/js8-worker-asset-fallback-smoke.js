#!/usr/bin/env node
"use strict";

// The .br copies of the decoder WASM and the JSC dictionary are not in git --
// tools/gzip-assets.sh makes them -- so a native build run straight from a
// checkout used to stop at "Modem loading failed" with "decoder WASM fetch
// failed: 404" and no file name. The worker now falls back to the plain files
// (which ARE in git) and, only when those are gone too, names both paths and the
// command. These checks run the worker's BROWSER branch in a vm with a scripted
// fetch(), because that branch is the one the page uses and the one no other
// test reaches.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WORKER = fs.readFileSync(path.resolve(__dirname, "../data/js8-worker.js"), "utf8");
const DECODER_SIZE = 64, JSC_SIZE = 96;

const INIT = {
  type: "init",
  runtimeJs: "/js8-worker-runtime.js?v=1",
  portableJs: "/js8-core.js?v=1", portableWasm: "/js8-core.wasm?v=1",
  decoderJs: "/js8-decoder.js?v=1",
  decoderWasmBr: "/js8-decoder.wasm.br?v=1", decoderWasmSize: DECODER_SIZE,
  protocolJs: "/js8-protocol.js?v=1",
  jscUrlBr: "/js8-jsc.bin.br?v=1", jscSize: JSC_SIZE,
  brotliJs: "/js8-brotli.js?v=1", brotliWasm: "/js8-brotli.wasm?v=1",
};

// files: path (no query) -> byte length. Anything absent answers 404.
// statuses: path -> HTTP status to answer instead (e.g. 500).
async function run(files, statuses = {}) {
  const posted = [], fetched = [];
  const context = {
    console, BigInt, Uint8Array, Promise, Error, Math, Number, String, Boolean,
    setTimeout,
  };
  context.self = context;
  context.postMessage = value => posted.push(value);
  context.fetch = async url => {
    const plain = String(url).split("?")[0];
    fetched.push(plain);
    if (statuses[plain]) return {ok: false, status: statuses[plain], headers: {get: () => null}};
    const size = files[plain];
    if (size === undefined) return {ok: false, status: 404, headers: {get: () => null}};
    return {ok: true, status: 200, headers: {get: () => String(size)}, body: null,
            arrayBuffer: async () => new Uint8Array(size).buffer};
  };
  context.importScripts = (...urls) => {
    for (const url of urls) {
      const name = String(url).split("?")[0];
      if (name === "/js8-worker-runtime.js") {
        context.Js8WorkerRuntime = class {
          constructor(audio, decoder, anchor, protocol) { this.decoderBytes = decoder.bytes; this.protocol = protocol; }
          state() { return {decoderBytes: this.decoderBytes, jscBytes: this.protocol.jscBytes}; }
        };
      } else if (name === "/js8-brotli.js") {
        context.createJs8Brotli = async () => {
          const heap = new Uint8Array(1 << 16);
          let next = 8;
          const module = {
            HEAPU8: heap, HEAPU32: new Uint32Array(heap.buffer),
            _malloc: size => { const at = next; next += (size + 7) & ~7; return at; },
            _free: () => {},
            // "Decompresses" to exactly the size the caller asked for.
            _BrotliDecoderDecompress: () => 1,
          };
          return module;
        };
      } else if (name === "/js8-core.js") {
        context.createJs8Prototype = async () => ({});
      } else if (name === "/js8-decoder.js") {
        context.createJs8DecoderProbe = async ({wasmBinary}) => ({bytes: wasmBinary.length});
      } else if (name === "/js8-protocol.js") {
        context.Js8Protocol = {
          JscDictionary: class { constructor(bytes) { this.bytes = bytes.length; } },
          ActivityStore: class { constructor(dictionary) { this.jscBytes = dictionary.bytes; } },
        };
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(WORKER, context);
  await context.onmessage({data: INIT});
  return {posted, fetched, ready: posted.find(m => m.type === "ready"),
          error: posted.find(m => m.type === "error")};
}

const base = {"/js8-decoder.wasm": DECODER_SIZE, "/js8-jsc.bin": JSC_SIZE};
const withBr = {...base, "/js8-decoder.wasm.br": 20, "/js8-jsc.bin.br": 30};

(async () => {
  const checks = {};

  const normal = await run(withBr);
  checks.brotliPathStillUsed = Boolean(normal.ready) &&
    !normal.fetched.includes("/js8-decoder.wasm") && !normal.fetched.includes("/js8-jsc.bin");

  const checkout = await run(base);
  checks.plainFallbackStarts = Boolean(checkout.ready) && !checkout.error;
  checks.plainFallbackFetchedPlain = checkout.fetched.includes("/js8-decoder.wasm") &&
    checkout.fetched.includes("/js8-jsc.bin");
  checks.plainFallbackRightBytes = Boolean(checkout.ready) &&
    checkout.ready.state.decoderBytes === DECODER_SIZE && checkout.ready.state.jscBytes === JSC_SIZE;

  const gone = await run({});
  const goneText = gone.error ? gone.error.message : "";
  checks.missingIsAnError = Boolean(gone.error) && !gone.ready;
  checks.missingNamesBothFiles = goneText.includes("/js8-decoder.wasm.br") &&
    goneText.includes("/js8-decoder.wasm ");
  checks.missingSaysWhatToRun = goneText.includes("./tools/gzip-assets.sh");
  checks.missingHasNoCacheKey = !goneText.includes("?v=");

  const wrong = await run({"/js8-decoder.wasm": DECODER_SIZE - 1, "/js8-jsc.bin": JSC_SIZE});
  checks.wrongSizeRefused = Boolean(wrong.error) && /expected 64/.test(wrong.error.message);

  // A 500 on the .br is a server failure, not a missing file: no fallback, and
  // the message keeps the status so nobody goes looking for a file that exists.
  const server = await run(withBr, {"/js8-decoder.wasm.br": 500});
  checks.serverErrorNotMaskedAsMissing = Boolean(server.error) &&
    /HTTP 500/.test(server.error.message) && !server.fetched.includes("/js8-decoder.wasm");

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  const total = Object.keys(checks).length;
  if (failed.length) {
    console.log(`JS8 WORKER ASSET FALLBACK FAIL ${total - failed.length}/${total}: ${failed.join(", ")}`);
    if (gone.error) console.log("  missing message: " + goneText);
    process.exit(1);
  }
  console.log(`JS8 WORKER ASSET FALLBACK PASS ${total}/${total}`);
})().catch(error => { console.error(error); process.exit(1); });
