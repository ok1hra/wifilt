"use strict";
// How much does each extra RX stream add when the OPERATOR picks the word?
// Stream A = production decoder (unchanged). Streams are added greedily: the
// next one is whichever candidate raises "at least one stream has the
// callsign right" the most. Chosen on seeds 301-303, reported on 401-403 so
// the pick is not tuned to the data it is scored on.
const C = require("./channel.js");
const {align, decodeProto, decodeProd, CANDIDATES, POINTS} = require("./complement.js");

const Cset = {windowSize: 188, window: "hann", decision: "atc", atcDecayBits: 4, limiter: "nb", usos: true};
const CANDS = Object.assign({}, CANDIDATES, {
  "C, integrace 50 % bitu":        Object.assign({}, Cset, {sample: "integrate", intFrac: 0.5}),
  "C, integrace + DPLL":           Object.assign({}, Cset, {sample: "integrate", dpll: true}),
  "C, okno 141 Hann":              Object.assign({}, Cset, {windowSize: 141}),
  "C, integrace, vzorek dřív":     Object.assign({}, Cset, {sample: "integrate", intFrac: 0.5, samplePhase: 0.35}),
});
delete CANDS["C, bez USOS"];
const CALL = /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}$/;
const sep = ch => ch === undefined || ch === " " || ch === "\r" || ch === "\n";

function tokens(expected, got) {
  const map = align(expected, got), out = [];
  const re = /[^ ]+/g; let m;
  while ((m = re.exec(expected))) {
    const s = m.index, e = s + m[0].length - 1;
    const js = []; for (let k = s; k <= e; k++) if (map[k] >= 0) js.push(map[k]);
    let tok = "";
    if (js.length) {
      let a = Math.min(...js), b = Math.max(...js);
      while (!sep(got[a - 1])) a--;
      while (!sep(got[b + 1])) b++;
      tok = got.slice(a, b + 1);
    }
    out.push({ref: m[0], tok, ok: tok === m[0], call: CALL.test(m[0]), point: null});
  }
  return out;
}

function collect(seeds) {
  const streams = {A: []};
  for (const k of Object.keys(CANDS)) streams[k] = [];
  for (const [pname, sc] of POINTS) for (const seed of seeds) {
    const {samples, expected} = C.buildScenario(sc, seed, {minChars: 500});
    const ta = tokens(expected, decodeProd(samples));
    ta.forEach(t => { t.point = pname; });
    streams.A.push(...ta);
    for (const [k, o] of Object.entries(CANDS)) {
      const tb = tokens(expected, decodeProto(o, samples));
      tb.forEach(t => { t.point = pname; });
      streams[k].push(...tb);
    }
    process.stderr.write(".");
  }
  return streams;
}

// share of callsigns (or all words) where at least one of `set` is right
function union(streams, set, onlyCalls = true, point = null) {
  const A = streams.A;
  let n = 0, ok = 0;
  for (let i = 0; i < A.length; i++) {
    if (onlyCalls && !A[i].call) continue;
    if (point && A[i].point !== point) continue;
    n++;
    if (set.some(k => streams[k][i].ok)) ok++;
  }
  return ok / n;
}
// callsigns where the right answer is on screen but another stream shows a
// DIFFERENT plausible callsign -- the operator has to guess between them
function guessRate(streams, set) {
  const A = streams.A;
  let n = 0, guess = 0;
  for (let i = 0; i < A.length; i++) {
    if (!A[i].call) continue;
    n++;
    const toks = set.map(k => streams[k][i]);
    if (!toks.some(t => t.ok)) continue;
    const plausible = new Set(toks.filter(t => CALL.test(t.tok)).map(t => t.tok));
    if (plausible.size > 1) guess++;
  }
  return guess / n;
}

const train = collect([301, 302, 303]);
process.stderr.write("\n");
const chosen = ["A"];
const pool = Object.keys(CANDS);
for (let step = 0; step < 3; step++) {
  let best = null, bestV = -1;
  for (const k of pool) {
    if (chosen.includes(k)) continue;
    const v = union(train, chosen.concat(k));
    if (v > bestV) { bestV = v; best = k; }
  }
  chosen.push(best);
}
const test = collect([401, 402, 403]);
process.stderr.write("\n");

const pc = x => (100 * x).toFixed(1).padStart(5) + " %";
console.log("Vybráno na seedech 301-303, změřeno na 401-403 (8 situací, " +
  test.A.filter(t => t.call).length + " značek, " + test.A.length + " slov)\n");
console.log("proudy".padEnd(58) + "značky   slova   hádání");
for (let k = 1; k <= chosen.length; k++) {
  const set = chosen.slice(0, k);
  console.log(("+ " + (k === 1 ? "A (současný dekodér)" : chosen[k - 1])).padEnd(58) +
    pc(union(test, set)) + pc(union(test, set, false)) + pc(guessRate(test, set)));
}
console.log("\nPo situacích, značky (A / A+B / A+B+C / A+B+C+D):");
for (const [pname] of POINTS)
  console.log("  " + pname.padEnd(24) + [1, 2, 3, 4].map(k => pc(union(test, chosen.slice(0, k), true, pname))).join(" "));
// the best third alternative, for comparison: all candidates as the 3rd
console.log("\nKaždý kandidát jako třetí proud k A + " + chosen[1] + " (značky):");
for (const k of pool.filter(k => k !== chosen[1]))
  console.log("  " + k.padEnd(34) + pc(union(test, ["A", chosen[1], k])));
