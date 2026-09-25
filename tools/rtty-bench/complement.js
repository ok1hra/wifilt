"use strict";
// Second RX stream study: the production decoder (data/rtty-codec.js, left
// as it is) is stream A; each candidate is a possible stream B shown beside
// it, with the OPERATOR choosing the word that came through. So the metric is
// per WORD (what the operator clicks), and what counts is the union:
//   A ok     share of reference words A printed exactly (as one token)
//   B ok     same for the candidate on its own
//   rescue   of the words A got wrong, the share B got right
//   gain     union(A ok or B ok) - A ok, in percentage points of all words
//   noise    of the words A got right, the share where B shows something else
//            (what the operator has to look past)
// node complement.js [seeds=3] [minChars=500]
const C = require("./channel.js");
const {ProtoDecoder} = require("./proto-decoder.js");
const RttyCodec = require("../../data/rtty-codec.js");

const SEEDS = Number(process.argv[2] || 3), MIN_CHARS = Number(process.argv[3] || 500);

const Cset = {windowSize: 188, window: "hann", decision: "atc", atcDecayBits: 4, limiter: "nb", usos: true};
const CANDIDATES = {
  "starý dekodér (před §20)":      {},
  "C, okno 96 obdélník":           Object.assign({}, Cset, {windowSize: 96, window: "rect"}),
  "C, jen mark":                   Object.assign({}, Cset, {decision: "markonly"}),
  "C, jen space":                  Object.assign({}, Cset, {decision: "spaceonly"}),
  "C, vzorek dřív (0,35 bitu)":    Object.assign({}, Cset, {samplePhase: 0.35}),
  "C, vzorek později (0,65 bitu)": Object.assign({}, Cset, {samplePhase: 0.65}),
  "C, DPLL setrvačník":            Object.assign({}, Cset, {dpll: true}),
  "C, integrace 70 % bitu":        Object.assign({}, Cset, {sample: "integrate"}),
  "C, bez USOS":                   Object.assign({}, Cset, {usos: false}),
  "FM diskriminátor":              {decision: "disc", limiter: "nb", usos: true},
  "FM diskriminátor, úzký":        {decision: "disc", discCutHz: 130, discAvg: 120, limiter: "nb", usos: true},
};
const POINTS = [
  ["šum −8 dB", {kind: "awgn", snrDb: -8}],
  ["šum −6 dB", {kind: "awgn", snrDb: -6}],
  ["únik 0,5 Hz, 0 dB", {kind: "fade", snrDb: 0, spreadHz: 0.5}],
  ["únik 0,5 Hz, +4 dB", {kind: "fade", snrDb: 4, spreadHz: 0.5}],
  ["únik 2 Hz, +4 dB", {kind: "fade", snrDb: 4, spreadHz: 2}],
  ["praskání −6 dB", {kind: "impulse", snrDb: -6}],
  ["soused 300 Hz +21 dB", {kind: "qrm", snrDb: 0, qrmOffsetHz: 300, qrmRelDb: 21}],
  ["rozladění 15 Hz, −6 dB", {kind: "awgn", snrDb: -6, toneOffsetHz: 15}],
];

// ref index -> got index (or -1) via Levenshtein backtrace
function align(ref, got) {
  const n = ref.length, m = got.length;
  const D = new Array(n + 1);
  for (let i = 0; i <= n; i++) { D[i] = new Int32Array(m + 1); D[i][0] = i; }
  for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) {
    const a = ref.charCodeAt(i - 1), row = D[i], up = D[i - 1];
    for (let j = 1; j <= m; j++) {
      let v = up[j - 1] + (a === got.charCodeAt(j - 1) ? 0 : 1);
      if (up[j] + 1 < v) v = up[j] + 1;
      if (row[j - 1] + 1 < v) v = row[j - 1] + 1;
      row[j] = v;
    }
  }
  const map = new Int32Array(n).fill(-1);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (ref[i - 1] === got[j - 1] && D[i][j] === D[i - 1][j - 1]) { map[i - 1] = j - 1; i--; j--; }
    else if (D[i][j] === D[i - 1][j - 1] + 1) { i--; j--; }
    else if (D[i][j] === D[i - 1][j] + 1) i--;
    else j--;
  }
  return map;
}
const isGap = ch => ch === undefined || ch === " " || ch === "\n" || ch === "\r";
// words of `ref` with start/end index; a word is ok in `got` iff every char
// maps, the mapped run is contiguous, and it stands alone as a token there
function wordOk(ref, got, map) {
  const out = [];
  const re = /[^ ]+/g;
  let mt;
  while ((mt = re.exec(ref))) {
    const s = mt.index, e = s + mt[0].length - 1;
    let ok = true;
    for (let k = s; k <= e && ok; k++) if (map[k] < 0 || (k > s && map[k] !== map[k - 1] + 1)) ok = false;
    if (ok) ok = isGap(got[map[s] - 1]) && isGap(got[map[e] + 1]);
    out.push({w: mt[0], ok, call: /[0-9]/.test(mt[0]) && /[A-Z]/.test(mt[0]) && mt[0].length >= 4});
  }
  return out;
}
function decodeProto(opts, x) {
  const d = new ProtoDecoder(8000, opts);
  let o = ""; d.onChar = ch => { o += ch; };
  for (let i = 0; i < x.length; i += 960) d.pushSamples(x.subarray(i, i + 960));
  return o;
}
function decodeProd(x) {
  const d = new RttyCodec.Decoder(8000, {squelchDb: 0});
  let o = ""; d.onChar(ch => { o += ch; });
  for (let i = 0; i < x.length; i += 960) d.pushSamples(x.subarray(i, i + 960));
  return o;
}

module.exports = {align, wordOk, decodeProto, decodeProd, CANDIDATES, POINTS};
if (require.main !== module) return;

const res = {};   // cand -> point -> counters
for (const [pname, sc] of POINTS) {
  for (let seed = 301; seed < 301 + SEEDS; seed++) {
    const {samples, expected} = C.buildScenario(sc, seed, {minChars: MIN_CHARS});
    const A = wordOk(expected, decodeProd(samples), align(expected, decodeProd(samples)));
    for (const [cname, opts] of Object.entries(CANDIDATES)) {
      const got = decodeProto(opts, samples);
      const B = wordOk(expected, got, align(expected, got));
      const r = ((res[cname] ||= {})[pname] ||= {n: 0, a: 0, b: 0, aw: 0, rescue: 0, noise: 0,
        cn: 0, ca: 0, caw: 0, crescue: 0});
      for (let k = 0; k < A.length; k++) {
        r.n++; r.a += A[k].ok; r.b += B[k].ok;
        if (!A[k].ok) { r.aw++; r.rescue += B[k].ok; } else r.noise += !B[k].ok;
        if (A[k].call) { r.cn++; r.ca += A[k].ok; if (!A[k].ok) { r.caw++; r.crescue += B[k].ok; } }
      }
    }
  }
  process.stderr.write(".");
}
process.stderr.write("\n");

const pc = (x, n) => n ? (100 * x / n).toFixed(0).padStart(4) : "   -";
console.log("Per point: A ok / B ok / rescue (A wrong -> B right) / gain in words, pp");
for (const [cname, pts] of Object.entries(res)) {
  console.log("\n" + cname);
  for (const [pname, r] of Object.entries(pts))
    console.log("  " + pname.padEnd(24) + " A" + pc(r.a, r.n) + "%  B" + pc(r.b, r.n) + "%  záchrana" + pc(r.rescue, r.aw) +
      "%  zisk +" + (100 * r.rescue / r.n).toFixed(1).padStart(4) + " pp   značky: záchrana" + pc(r.crescue, r.caw) + "%   šum" + pc(r.noise, r.a) + "%");
}
console.log("\nSouhrn přes všechny body (vážený počtem slov):");
console.log("kandidát".padEnd(32) + "B ok  záchrana  zisk pp  značky-záchrana  šum navíc");
const rows = Object.entries(res).map(([c, pts]) => {
  const t = Object.values(pts).reduce((s, r) => { for (const k in r) s[k] = (s[k] || 0) + r[k]; return s; }, {});
  return [c, t];
}).sort((x, y) => y[1].rescue / y[1].aw - x[1].rescue / x[1].aw);
for (const [c, t] of rows)
  console.log(c.padEnd(32) + pc(t.b, t.n) + "%" + pc(t.rescue, t.aw).padStart(8) + "%" + ("+" + (100 * t.rescue / t.n).toFixed(1)).padStart(9) +
    pc(t.crescue, t.caw).padStart(13) + "%" + pc(t.noise, t.a).padStart(10) + "%");
const t0 = rows[0][1];
console.log("\nA (produkce) ok: " + pc(t0.a, t0.n) + "% slov, " + pc(t0.ca, t0.cn) + "% značek");
