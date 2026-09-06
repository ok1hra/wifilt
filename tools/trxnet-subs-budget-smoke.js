#!/usr/bin/env node
"use strict";

// TrxNet's subscription table holds TRXNET_MAX_SUBS entries and subscribe()
// RETURNS SILENTLY when it is full -- no error, no log line, just a topic that
// never arrives again (TrxNet.cpp, subscribe(): the second loop falls through).
//
// The sketch subscribes to eight topics: /hz /mode /s-hz for the radios, and
// /pa-flags /fwd /ref /swr /band for the linear amplifier. That is the table
// exactly full. A ninth subscription anywhere -- a new device, a new topic on
// an existing one -- would compile, link, run, and quietly not work, and the
// symptom would be somebody's telemetry missing with nothing to point at.
//
// So the ceiling is checked here rather than discovered on the air. The same
// approach as tools/state-json-budget-smoke.js: read the bound out of the
// library, count the calls in the sketch, and fail while it is still cheap.

const fs = require("fs"), path = require("path");

const root = path.join(__dirname, "..");
const sketch = fs.readFileSync(path.join(root, "wifilt.ino"), "utf8");

const HEADER_CANDIDATES = [
  process.env.TRXNET_DIR && path.join(process.env.TRXNET_DIR, "TrxNet.h"),
  path.join(process.env.HOME || "", "Arduino/libraries/TrxNet/src/TrxNet.h"),
].filter(Boolean);

let failures = 0, checks = 0;
function ok(name, condition, detail = "") {
  checks++;
  if (condition) return true;
  failures++;
  console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  return false;
}

// ---- the ceiling, read from the library rather than restated here ----------

const headerPath = HEADER_CANDIDATES.find(p => fs.existsSync(p));
if (!headerPath) {
  console.error("SKIP trxnet subs budget -- TrxNet.h not found; set TRXNET_DIR");
  process.exit(0);
}
const header = fs.readFileSync(headerPath, "utf8");
const maxMatch = /#define\s+TRXNET_MAX_SUBS\s+(\d+)/.exec(header);
ok("TRXNET_MAX_SUBS is declared in TrxNet.h", Boolean(maxMatch), headerPath);
const maxSubs = maxMatch ? Number(maxMatch[1]) : 0;

// The sketch must not redefine it. TrxNet.cpp is compiled as its own translation
// unit with the library's own value, so a #define here would give the two halves
// different ideas of the array's size -- an ODR violation that corrupts memory
// rather than failing to build.
ok("the sketch does not redefine TRXNET_MAX_SUBS",
   !/#define\s+TRXNET_MAX_SUBS/.test(sketch),
   "TrxNet.cpp is a separate translation unit; redefining it here is an ODR trap");

// ---- what the sketch actually asks for -------------------------------------

// Comments and strings are stripped first: a topic named in a comment is not a
// subscription, and this file is heavily commented on purpose.
const code = sketch
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

const topics = [];
const callRe = /\bnet\.subscribe\s*\(\s*"([^"]*)"/g;
let m;
while ((m = callRe.exec(code)) !== null) topics.push(m[1]);

// subscribe() replaces an existing entry when the path repeats, so a topic
// subscribed from two places (boot and reconnect, say) costs one slot, not two.
const distinct = [...new Set(topics)];

ok("at least one subscription was found", topics.length > 0,
   "the regex found nothing -- has the call shape changed?");

console.log(`  TRXNET_MAX_SUBS   ${maxSubs}   (${path.relative(root, headerPath)})`);
console.log(`  net.subscribe()   ${topics.length} calls`);
console.log(`  distinct topics   ${distinct.length}   ${distinct.join(" ")}`);
console.log(`  headroom          ${maxSubs - distinct.length}`);

ok(`the sketch fits the subscription table (${distinct.length}/${maxSubs})`,
   distinct.length <= maxSubs,
   distinct.length > maxSubs
     ? `${distinct.length - maxSubs} topic(s) would be dropped in silence: ` +
       distinct.slice(maxSubs).join(" ")
     : "");

// Every topic the amplifier publishes has to be here, or the palette shows a
// dash where a number belongs and nothing says why.
for (const t of ["/pa-flags", "/fwd", "/ref", "/swr", "/band"]) {
  ok(`the amplifier's ${t} is subscribed`, distinct.includes(t));
}

console.log();
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
