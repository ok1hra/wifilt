#!/usr/bin/env node
"use strict";

// The QRPlog's CSV and ADIF exports, run in node against a fixed fixture and
// compared byte for byte with a golden file.
//
// The export code was moved out of log.js into data/log-export.js so that the
// GitHub Pages log viewer (log-viewer/) writes exactly the same ADIF as the
// interface does. A move like that has no visible failure: a dropped SUBMODE or
// a changed CSV quoting rule produces a file that still opens, it just no longer
// says what it used to. Hence a golden file, written once from the code BEFORE
// the move (`--write`) and checked after it.
//
// The export section of log.js is cut out between its two markers and run in a
// sandbox with LogDB stubbed, so this exercises log.js's own glue as well as
// log-export.js -- not a copy of either.
//
//   node tools/log-export-parity.js           # check against the golden file
//   node tools/log-export-parity.js --write   # (re)write the golden file

const fs = require("fs"), path = require("path"), vm = require("vm");

const root    = path.resolve(__dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "tools/fixtures/log-export-fixture.json"), "utf8"));
const golden  = path.join(root, "tools/fixtures/log-export-golden.txt");

const logJs = fs.readFileSync(path.join(root, "data/log.js"), "utf8");
const start = logJs.indexOf("  // ── CSV export");
const end   = logJs.indexOf("  function _triggerDownload");
if (start < 0 || end < 0 || end < start) {
  console.error("FAIL: export section markers not found in data/log.js");
  process.exit(1);
}

const LogDB = {
  getQsosForLog: id => Promise.resolve(
    fixture.stores.qso.filter(q => q.logId === id).map(q => Object.assign({}, q))),
};
const ctx = { LogDB, console, window: {} };
ctx.global = ctx.window;
vm.createContext(ctx);

const exportJs = path.join(root, "data/log-export.js");
if (fs.existsSync(exportJs)) {
  vm.runInContext(fs.readFileSync(exportJs, "utf8"), ctx, { filename: "log-export.js" });
  ctx.LogExport = ctx.window.LogExport;
}
vm.runInContext(
  "var __exp = (function(){\n" + logJs.slice(start, end) +
  "\nreturn { exportCsv: exportCsv, exportAdif: exportAdif };})();",
  ctx, { filename: "log.js(export section)" });

(async () => {
  let out = "";
  for (const log of fixture.stores.logs) {
    out += "=== CSV " + log.id + "\n" + await ctx.__exp.exportCsv(log.id) + "\n";
    out += "=== ADIF " + log.id + "\n" + await ctx.__exp.exportAdif(log) + "\n";
  }
  if (process.argv.includes("--write")) {
    fs.writeFileSync(golden, out);
    console.log("wrote " + path.relative(root, golden) + " (" + out.length + " bytes)");
    return;
  }
  const want = fs.readFileSync(golden, "utf8");
  if (want === out) {
    console.log("PASS: CSV + ADIF export byte-identical (" + out.length + " bytes, " +
                fixture.stores.logs.length + " logs)");
    return;
  }
  let i = 0;
  while (i < want.length && want[i] === out[i]) i++;
  console.error("FAIL: export differs at byte " + i);
  console.error("  want: " + JSON.stringify(want.slice(Math.max(0, i - 40), i + 40)));
  console.error("  got:  " + JSON.stringify(out.slice(Math.max(0, i - 40), i + 40)));
  process.exit(1);
})().catch(e => { console.error("FAIL: " + (e.stack || e)); process.exit(1); });
