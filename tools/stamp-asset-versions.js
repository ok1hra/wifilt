#!/usr/bin/env node
"use strict";

// Derive every cache-busting `?v=` from the CONTENT of the asset it points at.
//
// The firmware serves the two halves of a page with opposite cache policies
// (handleFileFromSPIFFS): `.html` is `no-cache, no-store` and therefore always
// fresh off the device, while `.js`/`.css` are `public, max-age=3600`. So for up
// to an hour after a flash the browser runs the OLD script against the NEW page,
// and the only thing standing between that and a working page is somebody having
// remembered to bump a hand-written date in a <script> tag.
//
// On 2026-08-11 that failed exactly as it had to: renaming an element id in both
// data.html and data.js without touching `data.js?v=20260808c` gave one operator
// a dead DATA page (`dom.operatorState is null`) while the same firmware worked
// in a browser with a cold cache. An audit then found 21 of the 41 tags on
// data.html already pointing at a version older than their own source, plus nine
// local assets carrying no `?v=` at all -- those cannot be invalidated by any
// means short of the operator knowing about Ctrl+Shift+R.
//
// A version that is derived cannot be forgotten, and it re-downloads only what
// actually changed: a firmware flash that touched one 4 kB script must not cost
// the operator the 865 kB JSC dictionary again over a link that carries one HTTP
// request at a time.
//
// Run BEFORE minify/gzip: this rewrites data.js (ASSET_REV) and every .html, and
// those are the files the later steps compress.
//
//   node tools/stamp-asset-versions.js [data-dir] [--check]
//
// --check writes nothing and exits non-zero if anything is out of date, which is
// the form to put in front of a build.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const positional = args.filter(argument => !argument.startsWith("--"));
const dataDir = path.resolve(positional[0] || path.join(__dirname, "..", "data"));

if (!fs.existsSync(dataDir)) {
  console.error(`ERROR: data directory not found: ${dataDir}`);
  process.exit(1);
}

// Long enough that a collision is not a thing anyone needs to think about, short
// enough to stay readable in a <script> tag next to the file name.
const VERSION_CHARS = 8;

// `src="/x.js"` / `href="/x.css"`, with or without an existing query. Only local
// paths and only code: images and fonts change on a different rhythm and pulling
// them in here would make every asset edit touch every page.
const TAG = /(\s(?:src|href)=")\/([A-Za-z0-9_.\-]+\.(?:js|css))(\?[^"]*)?"/g;
// The literals in data.js that reach an asset the page has no <script> tag for.
const ASSET_URL = /assetUrl\("(\/[A-Za-z0-9_.\-]+)"\)/g;
const ASSET_REV_LINE = /(const ASSET_REV = ")([^"]*)(";)/;

// Scripts the firmware GENERATES per request (webServer.on in wifilt.ino), not
// files in data/. They go out no-store, so a ?v= would buy nothing -- and there
// is no content to hash.
const GENERATED = new Set(["/ports.js"]);

const problems = [];
const changes = [];

function shortHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, VERSION_CHARS);
}

// What a served path is MADE OF, which is not always the file that ships.
// `/js8-jsc.bin.br` is produced from js8-jsc.bin by a later step in the same
// build, so its own bytes are one build stale while this runs; version it by its
// source and it moves exactly when the payload does.
function assetFile(assetPath) {
  const name = assetPath.replace(/^\//, "");
  if (name.endsWith(".br")) {
    const base = path.join(dataDir, name.slice(0, -3));
    if (fs.existsSync(base)) return base;
  }
  const direct = path.join(dataDir, name);
  return fs.existsSync(direct) ? direct : null;
}

function versionOf(assetPath, referrer) {
  const file = assetFile(assetPath);
  if (!file) {
    problems.push(`${referrer}: references ${assetPath}, which is not in ${path.basename(dataDir)}/`);
    return null;
  }
  return shortHash(fs.readFileSync(file));
}

function write(file, next) {
  const current = fs.readFileSync(file, "utf8");
  if (current === next) return false;
  changes.push(path.basename(file));
  if (!checkOnly) fs.writeFileSync(file, next);
  return true;
}

function tagPaths(html) {
  const found = new Set();
  for (const match of html.matchAll(TAG)) found.add(`/${match[2]}`);
  return found;
}

const htmlFiles = fs.readdirSync(dataDir).filter(name => name.endsWith(".html")).sort();

// ---- 0. worker revs, before the page scripts that carry them are hashed ------
//
// A Worker a page script starts itself (mercury.js: `new Worker(...)`) caches
// like any script, and so does everything it pulls in with importScripts() --
// none of it has a <script> tag, and the page is not data.js, so neither of the
// steps below reaches it. The page script carries one version for that whole set
// in a line of its own:
//
//   const MERCURY_WORKER_REV = "..."; // stamped from /mercury-worker.js
//
// derived from the worker, every literal it importScripts() (transitively) and,
// for an Emscripten glue script, the .wasm next to it -- a new mercury-host.wasm
// paired with a cached mercury-host.js does not even instantiate. The worker hands
// the ?v= on to its own loads.
const WORKER_REV_LINE = /(const [A-Z0-9_]+_REV = ")([^"]*)("; \/\/ stamped from (\/[A-Za-z0-9_.\-]+\.js))/g;
const IMPORT_CALL = /importScripts\(([^)]*)\)/g;
const SCRIPT_LITERAL = /"([A-Za-z0-9_.\-]+\.js)"/g;

function workerRev(workerPath, referrer) {
  const seen = new Set();
  const fingerprint = crypto.createHash("sha256");
  const visit = assetPath => {
    if (seen.has(assetPath)) return;
    seen.add(assetPath);
    const version = versionOf(assetPath, referrer);
    if (!version) return;
    fingerprint.update(`${assetPath} ${version}\n`);
    if (!assetPath.endsWith(".js")) return;
    const wasm = assetPath.replace(/\.js$/, ".wasm");
    if (assetFile(wasm)) visit(wasm);
    const text = fs.readFileSync(assetFile(assetPath), "utf8");
    for (const call of text.matchAll(IMPORT_CALL))
      for (const literal of call[1].matchAll(SCRIPT_LITERAL)) visit(`/${literal[1]}`);
  };
  visit(workerPath);
  return {rev: fingerprint.digest("hex").slice(0, VERSION_CHARS), count: seen.size};
}

for (const name of fs.readdirSync(dataDir).filter(name => name.endsWith(".js")).sort()) {
  const file = path.join(dataDir, name);
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes("// stamped from /")) continue;
  const next = text.replace(WORKER_REV_LINE, (whole, prefix, old, suffix, workerPath) => {
    const {rev, count} = workerRev(workerPath, name);
    console.log(`    ${name}  ${workerPath} ${rev}  (${count} assets)`);
    return `${prefix}${rev}${suffix}`;
  });
  write(file, next);
}

// ---- 1. ASSET_REV, before anything hashes data.js itself --------------------
//
// assetUrl() falls back to ASSET_REV only for assets the document never loads
// through a tag of its own -- the worker script, its runtime, the WASM blobs and
// the dictionary. Deriving that set the same way the browser does keeps it from
// drifting when an asset moves into or out of a <script> tag.
//
// One version for the whole set rather than one each: these files are the modem,
// they are built and replaced together, and giving them separate versions would
// buy nothing while requiring a generated table inside data.js.
const dataJsFile = path.join(dataDir, "data.js");
if (fs.existsSync(dataJsFile)) {
  const dataJs = fs.readFileSync(dataJsFile, "utf8");
  const dataHtmlFile = path.join(dataDir, "data.html");
  const documentAssets = fs.existsSync(dataHtmlFile)
    ? tagPaths(fs.readFileSync(dataHtmlFile, "utf8")) : new Set();

  const workerOnly = [...new Set([...dataJs.matchAll(ASSET_URL)].map(match => match[1]))]
    .filter(assetPath => !documentAssets.has(assetPath))
    .sort();

  const fingerprint = crypto.createHash("sha256");
  for (const assetPath of workerOnly) {
    const version = versionOf(assetPath, "data.js assetUrl()");
    if (version) fingerprint.update(`${assetPath} ${version}\n`);
  }
  const rev = fingerprint.digest("hex").slice(0, VERSION_CHARS);

  if (!ASSET_REV_LINE.test(dataJs))
    problems.push("data.js: no `const ASSET_REV = \"...\";` to stamp");
  else
    write(dataJsFile, dataJs.replace(ASSET_REV_LINE, `$1${rev}$3`));

  console.log(`    ASSET_REV ${rev}  (${workerOnly.length} worker-only assets)`);
}

// ---- 2. every <script>/<link> on every page ---------------------------------
for (const name of htmlFiles) {
  const file = path.join(dataDir, name);
  const html = fs.readFileSync(file, "utf8");
  let stamped = 0;
  const next = html.replace(TAG, (whole, prefix, asset, query) => {
    if (GENERATED.has(`/${asset}`)) return whole;
    const version = versionOf(`/${asset}`, name);
    if (!version) return whole;
    stamped++;
    // A tag that had no query at all is the worse case, not the harmless one:
    // it caches for an hour with nothing that can ever invalidate it.
    if (query === undefined) changes.push(`${name}: /${asset} had no ?v=`);
    return `${prefix}/${asset}?v=${version}"`;
  });
  write(file, next);
  console.log(`    ${name}  ${stamped} assets`);
}

// ---- report ------------------------------------------------------------------
if (problems.length) {
  for (const problem of problems) console.error(`ERROR: ${problem}`);
  process.exit(1);
}

if (checkOnly) {
  if (changes.length) {
    console.error("ERROR: asset versions are out of date:");
    for (const change of [...new Set(changes)]) console.error(`       ${change}`);
    console.error("       Run tools/stamp-asset-versions.js");
    process.exit(1);
  }
  console.log("==> Asset versions up to date");
} else {
  console.log(changes.length
    ? `==> Asset versions stamped (${[...new Set(changes)].length} files changed)`
    : "==> Asset versions already current");
}
