"use strict";
// quick probe: node probe.js '<json variants>' chan:x,chan:x ...
const C = require("./channel.js"), L = require("./lib.js");
const variants = JSON.parse(process.argv[2]);
const pts = process.argv[3].split(",").map(s => s.split(":"));
const SC = {awgn: x => ({kind: "awgn", snrDb: x}), fade05: x => ({kind: "fade", snrDb: x, spreadHz: 0.5}),
  fade2: x => ({kind: "fade", snrDb: x, spreadHz: 2}), impulse: x => ({kind: "impulse", snrDb: x}),
  qrm300: x => ({kind: "qrm", snrDb: 0, qrmOffsetHz: 300, qrmRelDb: x})};
console.log("variant".padEnd(22) + pts.map(p => (p[0] + ":" + p[1]).padStart(11)).join(""));
const cache = {};
for (const [name, v] of Object.entries(variants)) {
  let row = name.padEnd(22);
  for (const [c, x] of pts) {
    let tot = 0;
    for (const seed of [101, 102]) {
      const k = c + x + seed;
      const sc = cache[k] ||= C.buildScenario(SC[c](+x), seed, {minChars: 400});
      tot += L.cer(sc.expected, L.decode(sc.samples, v));
    }
    row += (100 * tot / 2).toFixed(1).padStart(11);
  }
  console.log(row);
}
