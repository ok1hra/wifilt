"use strict";
// Pack all result files into one compact JSON for the report page.
const {execSync} = require("child_process");
const fs = require("fs");
const load = p => JSON.parse(execSync("node summarize.js results-" + p + ".json --json", {cwd: __dirname, maxBuffer: 1 << 26}));
const pack = agg => {
  const o = {};
  for (const [ch, vs] of Object.entries(agg)) {
    o[ch] = {};
    for (const [v, pts] of Object.entries(vs))
      o[ch][v] = pts.map(p => [p.x, +p.mean.toFixed(4), +p.min.toFixed(4), +p.max.toFixed(4)]);
  }
  return o;
};
const round = s => JSON.parse(JSON.stringify(s, (k, v) => typeof v === "number" ? +v.toFixed(2) : v));
const out = {};
for (const p of ["singles", "combos", "squelch", "final"]) {
  const r = load(p);
  out[p] = {agg: pack(r.agg), summary: round(r.summary)};
}
out.cpu = round(JSON.parse(fs.readFileSync(__dirname + "/results-cpu.json")));
fs.writeFileSync(process.argv[2], JSON.stringify(out));
console.log("bytes", fs.statSync(process.argv[2]).size);
