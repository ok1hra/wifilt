"use strict";
// Single-threaded CPU cost per variant: ns per input sample and % of one core
// in real time at 8 kHz. Best of 3 runs over the same 60 s AWGN scenario.
const fs = require("fs");
const C = require("./channel.js"), L = require("./lib.js");
const sc = C.buildScenario({kind: "awgn", snrDb: -4}, 5, {minChars: 350});
const all = Object.assign({}, require("./bench-variants.js").SINGLES,
  require("./variants-combos.js"), require("./variants-squelch.js"));
const out = {};
for (const [name, v] of Object.entries(all)) {
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t = process.hrtime.bigint();
    L.decode(sc.samples, v);
    best = Math.min(best, Number(process.hrtime.bigint() - t));
  }
  const ns = best / sc.samples.length;
  out[name] = {ns, pct: ns * 8000 / 1e9 * 100};
  console.log(name.padEnd(24) + ns.toFixed(0).padStart(6) + " ns/smp " + out[name].pct.toFixed(2).padStart(6) + " % core");
}
fs.writeFileSync("results-cpu.json", JSON.stringify(out));
