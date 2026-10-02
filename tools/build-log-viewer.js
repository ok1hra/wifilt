#!/usr/bin/env node
"use strict";

// Build log-viewer/index.html -- the GitHub Pages log viewer -- as ONE file.
//
// One file because of who installs it: an operator copying it into their own
// log repository through GitHub's "Add file -> Upload files". Several files is
// several chances to forget one. So the page, its CSS, its script and the two
// scripts it shares with the interface (data/dxcc.js for the countries,
// data/log-export.js for ADIF/CSV) are inlined here.
//
// Inlined copies can go stale: dxcc.js gets a new country, the ADIF mapping a
// new mode, and the viewer quietly keeps the old ones. --check is the guard --
// it rebuilds in memory and fails when the committed index.html differs.
//
// The build stamp is a hash of the inputs, not a date, so building twice from
// the same sources gives the same file and --check can compare byte for byte.
//
//   node tools/build-log-viewer.js           # write log-viewer/index.html
//   node tools/build-log-viewer.js --check   # exit 1 if it is out of date

const fs = require("fs"), path = require("path"), crypto = require("crypto");

const root = path.resolve(__dirname, "..");
const src = path.join(root, "log-viewer", "src");
const out = path.join(root, "log-viewer", "index.html");
const read = p => fs.readFileSync(p, "utf8");

const parts = {
  CSS:    read(path.join(src, "viewer.css")),
  DXCC:   read(path.join(root, "data", "dxcc.js")),
  EXPORT: read(path.join(root, "data", "log-export.js")),
  VIEWER: read(path.join(src, "viewer.js")),
};
const template = read(path.join(src, "viewer.html"));

// An inlined script must not close its own <script> element by accident.
for (const k of ["DXCC", "EXPORT", "VIEWER"]) parts[k] = parts[k].replace(/<\/script/gi, "<\\/script");

const version = crypto.createHash("sha256")
  .update(template).update(parts.CSS).update(parts.DXCC).update(parts.EXPORT).update(parts.VIEWER)
  .digest("hex").slice(0, 8);

let html = template;
for (const k of Object.keys(parts)) {
  const mark = "/*@" + k + "@*/";
  if (!html.includes(mark)) { console.error("FAIL: " + mark + " missing in viewer.html"); process.exit(1); }
  html = html.split(mark).join(parts[k]);
}
html = html.split("@VERSION@").join(version);

if (process.argv.includes("--check")) {
  const have = fs.existsSync(out) ? read(out) : "";
  if (have === html) { console.log("PASS: log-viewer/index.html is up to date (build " + version + ")"); process.exit(0); }
  console.error("FAIL: log-viewer/index.html is out of date -- run node tools/build-log-viewer.js");
  process.exit(1);
}
fs.writeFileSync(out, html);
console.log("wrote log-viewer/index.html (" + html.length + " bytes, build " + version + ")");
