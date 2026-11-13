#!/usr/bin/env node
// Waterfall AGC across the end of our own transmission (data/spectrum.js).
//
// Measured on wifilt-pi + local-trx + TS-480 (2026-11-13): RX audio sits at
// about -35 dBFS, the radio mutes it (~-72 dBFS, the codec's floor) while keyed
// AND for 1.75 s after RX; -- and comes back at the same level, not louder.
// The page used to reset the whole analyser at PTT release, so the first row
// of that muted tail set the AGC to silence and the real noise then painted
// white for seconds. This replays that sequence through the real FFT/AGC.
"use strict";
const path = require("path");
const Spectrum = require(path.join(__dirname, "..", "data", "spectrum.js"));

const RATE = 8000, HOP = 2048;
function canvasStub() {
  const context = {
    drawImage() {}, putImageData() {}, fillRect() {}, clearRect() {},
    createImageData: width => ({data: new Uint8ClampedArray(width * 4)}),
  };
  return {width: 320, height: 64, getContext: () => context, parentNode: {clientWidth: 320}};
}
let seed = 12345;
function noise(seconds, dbfs) {
  const out = new Float32Array(Math.round(seconds * RATE));
  const rms = Math.pow(10, dbfs / 20);
  for (let i = 0; i < out.length; i++) {
    // Box-Muller from a small LCG, so the run is deterministic.
    seed = (seed * 1103515245 + 12345) >>> 0; const u = (seed + 1) / 4294967297;
    seed = (seed * 1103515245 + 12345) >>> 0; const v = (seed + 1) / 4294967297;
    out[i] = rms * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  return out;
}
function run(afterTx) {
  const w = new Spectrum.Waterfall({canvas: canvasStub(), sampleRate: RATE, fftSize: 4096, hopSize: HOP});
  w.ingest(noise(20, -35));                  // settled RX
  const steadyLow = w.state().agcLow;
  afterTx(w);                                // TX ended (the analyser was paused while keyed)
  w.ingest(noise(1.75, -72));                // radio still muted after RX;
  const rowsBefore = w.state().rows;
  const lows = [];
  const back = noise(8, -35);
  for (let i = 0; i < back.length; i += HOP) { w.ingest(back.subarray(i, i + HOP)); lows.push(w.state().agcLow); }
  // Rows after audio returned until the floor is back within 4 dB of steady.
  const settle = lows.findIndex(low => Math.abs(low - steadyLow) <= 4);
  return {steadyLow, worst: Math.min(...lows), settleRows: settle < 0 ? Infinity : settle,
          rows: w.state().rows - rowsBefore};
}

const checks = [];
const check = (name, ok, detail) => { checks.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -- " + detail : ""}`); };

const old = run(w => w.reset());
const now = run(w => w.resetRing());
const holdRows = Math.ceil(Spectrum.AGC_HOLD_MS / 1000 * RATE / HOP);
check("old behaviour reproduces the burn (reset at PTT release)", old.settleRows >= 10,
  `floor fell to ${old.worst.toFixed(1)} dB from ${old.steadyLow.toFixed(1)}, ${old.settleRows} rows to recover`);
check("resetRing keeps the floor through the muted tail", now.worst >= now.steadyLow - 4,
  `floor ${now.steadyLow.toFixed(1)} -> worst ${now.worst.toFixed(1)} dB`);
check("no recovery time once audio returns", now.settleRows === 0, `${now.settleRows} rows`);

// A floor that really moved (a quieter band, preamp off) must still be followed
// once the hold has run out.
{
  const w = new Spectrum.Waterfall({canvas: canvasStub(), sampleRate: RATE, fftSize: 4096, hopSize: HOP});
  w.ingest(noise(20, -35));
  const before = w.state().agcLow;
  w.ingest(noise(Spectrum.AGC_HOLD_MS / 1000 * 0.75, -70));
  const held = w.state().agcLow;
  w.ingest(noise(20, -70));
  const after = w.state().agcLow;
  check("a real drop is held at first", Math.abs(held - before) < 1, `${before.toFixed(1)} -> ${held.toFixed(1)}`);
  check("...and followed after the hold", after < before - 25, `${before.toFixed(1)} -> ${after.toFixed(1)} (hold ${holdRows} rows)`);
}
// A rise is never held: a signal or a louder band shows at once as before.
{
  const w = new Spectrum.Waterfall({canvas: canvasStub(), sampleRate: RATE, fftSize: 4096, hopSize: HOP});
  w.ingest(noise(20, -60));
  const before = w.state().agcLow;
  w.ingest(noise(2, -35));
  check("a rise is followed immediately", w.state().agcLow > before + 5, `${before.toFixed(1)} -> ${w.state().agcLow.toFixed(1)}`);
}
const ok = checks.every(Boolean);
console.log(ok ? "SPECTRUM AGC HOLD PASS" : "SPECTRUM AGC HOLD FAIL");
process.exit(ok ? 0 : 1);
