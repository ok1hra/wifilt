"use strict";
// node summarize.js results-<phase>.json [--json]
// Mean/min/max CER per (variant, channel, x); threshold where mean CER
// crosses 5 %; gain vs "base" (or the first variant) in dB.
const fs = require("fs");
const file = process.argv[2];
const R = JSON.parse(fs.readFileSync(file, "utf8"));
const THRESH = 0.05;

function aggregate(R) {
  const agg = {};   // chan -> variant -> x -> {mean,min,max,ms,dur}
  for (const r of R.results) {
    for (const [v, e] of Object.entries(r.v)) {
      const key = e.cer != null ? "cer" : "garbagePerMin";
      const a = ((agg[r.chan] ||= {})[v] ||= {});
      const c = (a[r.x] ||= {vals: [], ms: 0, dur: 0, est: []});
      c.vals.push(e[key]); c.ms += e.ms; c.dur += r.dur;
      if (e.snrEst != null) c.est.push(e.snrEst);
    }
  }
  const out = {};
  for (const [chan, vs] of Object.entries(agg)) for (const [v, xs] of Object.entries(vs)) {
    const pts = Object.entries(xs).map(([x, c]) => ({
      x: +x, mean: c.vals.reduce((s, y) => s + y, 0) / c.vals.length,
      min: Math.min(...c.vals), max: Math.max(...c.vals),
      nsPerSample: c.ms * 1e6 / (c.dur * 8000),
      snrEst: c.est.length ? c.est.reduce((s, y) => s + y, 0) / c.est.length : null,
    })).sort((a, b) => a.x - b.x);
    ((out[chan] ||= {})[v] = pts);
  }
  return out;
}

// SNR axes: lowest SNR at which mean CER is <= 5 % (scanning down from the
// top, linear interpolation at the crossing). 'rel' axes (interferer level):
// highest interferer level still <= 5 %.
function threshold(pts, axis) {
  if (axis === "snr") {
    const p = pts.slice().sort((a, b) => b.x - a.x);
    if (p[0].mean > THRESH) return null;
    for (let i = 1; i < p.length; i++) if (p[i].mean > THRESH) {
      const a = p[i - 1], b = p[i];
      return a.x + (b.x - a.x) * (THRESH - a.mean) / (b.mean - a.mean);
    }
    return p[p.length - 1].x;         // never crossed inside the grid
  } else {
    const p = pts.slice().sort((a, b) => a.x - b.x);
    if (p[0].mean > THRESH) return null;
    for (let i = 1; i < p.length; i++) if (p[i].mean > THRESH) {
      const a = p[i - 1], b = p[i];
      return a.x + (b.x - a.x) * (THRESH - a.mean) / (b.mean - a.mean);
    }
    return p[p.length - 1].x;
  }
}

const agg = aggregate(R);
const summary = {};
for (const [chan, vs] of Object.entries(agg)) {
  const axis = (R.channels[chan] && R.channels[chan].axis) || (chan === "noise" ? "gain" : "snr");
  if (axis === "gain") continue;
  const baseName = vs["base"] ? "base" : Object.keys(vs)[0];
  const tb = threshold(vs[baseName], axis);
  summary[chan] = {};
  for (const [v, pts] of Object.entries(vs)) {
    const t = threshold(pts, axis);
    const gain = t == null || tb == null ? null : (axis === "snr" ? tb - t : t - tb);
    const ns = pts.reduce((s, p) => s + p.nsPerSample, 0) / pts.length;
    summary[chan][v] = {thr: t, gain, ns};
  }
}

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify({agg, summary}));
} else {
  const chans = Object.keys(summary);
  const vars = Object.keys(summary[chans[0]] || {});
  const f = x => x == null ? "  -  " : (x >= 0 ? "+" : "") + x.toFixed(1);
  console.log("gain vs base [dB] at CER 5 % (snr: lower SNR is better, rel: stronger interferer tolerated)");
  console.log("variant".padEnd(20) + chans.map(c => c.padStart(9)).join("") + "   ns/smp");
  for (const v of vars) {
    console.log(v.padEnd(20) + chans.map(c => f(summary[c][v] && summary[c][v].gain).padStart(9)).join("") +
      (summary[chans[0]][v].ns).toFixed(0).padStart(9));
  }
  console.log("\nbase thresholds: " + chans.map(c => c + "=" + (summary[c].base || summary[c][vars[0]]).thr?.toFixed(1)).join("  "));
  if (agg.noise) {
    console.log("\ngarbage chars/min in pure noise, by audio gain:");
    for (const [v, pts] of Object.entries(agg.noise))
      console.log(v.padEnd(22) + pts.map(p => ("x" + p.x + ":" + p.mean.toFixed(0)).padStart(12)).join(""));
  }
}
