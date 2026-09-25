"use strict";
// RTTY decoder bench. node bench.js <phase> [outfile]
//   phase: singles | squelch | combos | cpu
// Parallel over worker_threads; each task = one (channel, x, seed) scenario,
// generated once and decoded by every variant.
const {Worker, isMainThread, parentPort, workerData} = require("worker_threads");
const os = require("os");
const fs = require("fs");
const path = require("path");

const range = (a, b, s) => { const r = []; for (let x = a; x <= b + 1e-9; x += s) r.push(+x.toFixed(3)); return r; };

// ---- channels: name -> {x axis name, grid, build(x)} ----
const CHANNELS = {
  awgn:    {axis: "snr", grid: range(-16, 2, 1),  sc: x => ({kind: "awgn", snrDb: x})},
  fade05:  {axis: "snr", grid: range(-10, 20, 2), sc: x => ({kind: "fade", snrDb: x, spreadHz: 0.5})},
  fade2:   {axis: "snr", grid: range(-10, 20, 2), sc: x => ({kind: "fade", snrDb: x, spreadHz: 2})},
  impulse: {axis: "snr", grid: range(-14, 4, 2),  sc: x => ({kind: "impulse", snrDb: x, impulseRate: 8, impulseRelDb: 26})},
  off15:   {axis: "snr", grid: range(-14, 2, 2),  sc: x => ({kind: "awgn", snrDb: x, toneOffsetHz: 15})},
  baud1:   {axis: "snr", grid: range(-14, 2, 2),  sc: x => ({kind: "awgn", snrDb: x, baudErr: 0.01})},
  qrm300:  {axis: "rel", grid: range(-6, 24, 3),  sc: x => ({kind: "qrm", snrDb: 0, qrmOffsetHz: 300, qrmRelDb: x})},
  qrm400:  {axis: "rel", grid: range(-6, 24, 3),  sc: x => ({kind: "qrm", snrDb: 0, qrmOffsetHz: 400, qrmRelDb: x})},
  // carrier gliding MARK+20..+260 Hz across the run (channel.js cwSweep)
  cw:      {axis: "rel", grid: range(-6, 24, 3),  sc: x => ({kind: "cw", snrDb: 0, cwSweep: true, cwRelDb: x})},
};

const {SINGLES} = require("./bench-variants.js");

function loadVariants(phase) {
  if (phase === "singles") return SINGLES;
  const f = path.join(__dirname, "variants-" + phase + ".js");
  return require(f);
}

if (isMainThread) {
  const phase = process.argv[2] || "singles";
  const out = process.argv[3] || path.join(__dirname, "results-" + phase + ".json");
  const seeds = [1, 2, 3];
  const variants = loadVariants(phase);
  const chanNames = (process.env.CHANNELS ? process.env.CHANNELS.split(",") : Object.keys(CHANNELS));
  const tasks = [];
  if (phase === "squelch" || phase === "final" || phase === "prod") {
    // noise-only garbage at several audio gains + AWGN sensitivity
    for (const g of [0.1, 0.3, 1, 3]) for (const seed of seeds)
      tasks.push({chan: "noise", x: g, seed, sc: {kind: "noise", seconds: 120, gain: g}});
    for (const g of [0.1, 1, 3]) for (const x of range(-14, 2, 2)) for (const seed of seeds)
      tasks.push({chan: "awgn_g" + g, x, seed, sc: {kind: "awgn", snrDb: x, gain: g}});
    for (const x of range(-6, 24, 3)) for (const seed of seeds)
      tasks.push({chan: "qrm300", x, seed, sc: CHANNELS.qrm300.sc(x, seed)});
    if (phase === "final" || phase === "prod") for (const c of ["fade05", "fade2", "impulse"])
      for (const x of CHANNELS[c].grid) for (const seed of seeds)
        tasks.push({chan: c, x, seed, sc: CHANNELS[c].sc(x, seed)});
  } else {
    for (const c of chanNames) for (const x of CHANNELS[c].grid) for (const seed of seeds)
      tasks.push({chan: c, x, seed, sc: CHANNELS[c].sc(x, seed)});
  }
  const minChars = Number(process.env.MINCHARS || 600);
  const results = [];
  let next = 0, done = 0;
  const t0 = Date.now();
  const nWorkers = Math.min(os.cpus().length, tasks.length);
  for (let w = 0; w < nWorkers; w++) {
    const worker = new Worker(__filename, {workerData: {phase, minChars}});
    const feed = () => { if (next < tasks.length) worker.postMessage(tasks[next++]); else worker.terminate(); };
    worker.on("message", r => {
      results.push(r); done++;
      if (done % 20 === 0 || done === tasks.length)
        process.stderr.write(`\r${done}/${tasks.length}  ${((Date.now() - t0) / 1000).toFixed(0)} s   `);
      feed();
    });
    worker.on("error", e => { console.error(e); process.exit(1); });
    feed();
  }
  process.on("exit", () => {
    if (done !== tasks.length) return;
    fs.writeFileSync(out, JSON.stringify({phase, variants: Object.keys(variants),
      channels: Object.fromEntries(Object.entries(CHANNELS).map(([k, v]) => [k, {axis: v.axis, grid: v.grid}])),
      results}));
    process.stderr.write(`\nwrote ${out}\n`);
  });
} else {
  const C = require("./channel.js");
  const L = require("./lib.js");
  const variants = loadVariants(workerData.phase);
  parentPort.on("message", task => {
    const sc = C.buildScenario(task.sc, task.seed, {minChars: workerData.minChars});
    const r = {chan: task.chan, x: task.x, seed: task.seed, n: sc.expected.length, dur: sc.durationSec, v: {}};
    for (const [name, v] of Object.entries(variants)) {
      const t = process.hrtime.bigint();
      const d = L.decodeDetailed(sc.samples, v);
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      const e = {ms};
      if (task.sc.kind === "noise") e.garbagePerMin = d.text.length / (sc.durationSec / 60);
      else e.cer = L.cer(sc.expected, d.text);
      if (d.snrEst != null) e.snrEst = d.snrEst;
      r.v[name] = e;
    }
    parentPort.postMessage(r);
  });
}
