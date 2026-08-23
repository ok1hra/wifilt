#!/usr/bin/env node
// Prints raw/gzip/brotli sizes for the two build-wasm.sh variants, matching
// the table format in docs/mercury-implementace.md chapter 2.2. Uses Node's
// built-in zlib brotli (same approach as tools/brotli-js8-assets.js) so this
// has no dependency beyond emcc + node.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const buildDir = process.argv[2];
if (!buildDir) { console.error("usage: measure-sizes.js <build-dir>"); process.exit(2); }

const variants = ["full", "trim"];
const rows = [];
for (const v of variants) {
  const wasmPath = path.join(buildDir, `mercury-${v}.wasm`);
  const jsPath = path.join(buildDir, `mercury-${v}.js`);
  if (!fs.existsSync(wasmPath)) { console.error(`missing ${wasmPath}`); process.exit(1); }
  const wasm = fs.readFileSync(wasmPath);
  const js = fs.readFileSync(jsPath);
  rows.push({
    variant: v,
    wasm_raw: wasm.length,
    wasm_gzip: zlib.gzipSync(wasm, { level: 9 }).length,
    wasm_brotli: zlib.brotliCompressSync(wasm, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
    js_raw: js.length,
    js_brotli: zlib.brotliCompressSync(js, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  });
}

const fmt = n => n.toLocaleString("en-US");
console.log("");
console.log("| build | raw | gzip | brotli | js glue (brotli) |");
console.log("|---|---:|---:|---:|---:|");
for (const r of rows) {
  console.log(`| ${r.variant} | ${fmt(r.wasm_raw)} | ${fmt(r.wasm_gzip)} | **${fmt(r.wasm_brotli)}** | ${fmt(r.js_brotli)} |`);
}
console.log("");
