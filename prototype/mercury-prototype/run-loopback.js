#!/usr/bin/env node
// Runs shim.c's mercury_loopback_test() for every compiled-in DATAC mode
// against the "trim" build from build-wasm.sh. This is the functional half
// of docs/mercury-implementace.md ch. 2.3 ("Testovací shim moduluje jeden
// rámec... loopback OK") -- reproduced here as a checked-in, re-runnable
// script instead of a one-off claim in a markdown table.
"use strict";
const path = require("path");

// emcc 3.1.6's generated glue picks its WASM-loading branch on
// `typeof fetch == "function"`, not on the ENVIRONMENT_IS_NODE it also
// computes -- so under Node >=18 (which ships a global fetch) it takes the
// browser fetch() path and hands it a bare filesystem path, which throws
// ERR_INVALID_URL. Emscripten predates Node's global fetch; there is no
// build flag for this in 3.1.6. Hiding fetch for this process is the
// narrowest fix and only affects this throwaway driver script.
delete global.fetch;

const buildDir = process.argv[2];
if (!buildDir) { console.error("usage: run-loopback.js <build-dir>"); process.exit(2); }

const createMercury = require(path.resolve(buildDir, "mercury-trim.js"));

createMercury().then(m => {
  const modeCount = m.cwrap("mercury_mode_count", "number", [])();
  const payloadBytes = m.cwrap("mercury_mode_payload_bytes", "number", ["number"]);
  const loopback = m.cwrap("mercury_loopback_test", "number", ["number"]);

  console.log(`modes compiled in: ${modeCount}`);
  let allPass = true;
  for (let i = 0; i < modeCount; i++) {
    const bytes = payloadBytes(i);
    const t0 = process.hrtime.bigint();
    const r = loopback(i);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const label = r === 1 ? "OK" : r === 0 ? "NO DECODE" : r === -1 ? "MISMATCH" : "ERROR";
    if (r !== 1) allPass = false;
    console.log(`  mode ${i}: payload=${bytes}B loopback=${label} (${ms.toFixed(1)} ms)`);
  }
  if (!allPass) { console.error("FAIL: not every mode loopback-verified"); process.exit(1); }
  console.log("PASS: every compiled-in DATAC mode round-tripped a real modulated frame");
});
