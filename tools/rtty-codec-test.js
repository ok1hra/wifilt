#!/usr/bin/env node
"use strict";
// RTTY codec + settings unit test for the §20 decoder (docs/rtty-implementace.md):
// USOS on TX and RX, the noise-referenced squelch, the noise blanker, the
// squelch opening late inside a start bit, and the v1 -> v2 settings
// migration. Seeded, no browser. The dB-level evidence behind the design
// lives in tools/rtty-bench/ (bench.js, gate.js); this file only pins the
// behaviour down.

const RttyCodec = require("../data/rtty-codec.js");
const RttySettings = require("../data/rtty-settings.js");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log("FAIL " + name + (detail !== undefined ? "  " + detail : "")); }
}

// mulberry32 + Box-Muller, so the noise is the same on every run
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.gauss = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return next;
}

const toFloat = pcm16 => Float32Array.from(pcm16, s => s / 32767);
function withLead(signal, leadSamples = 1600) {
  const x = new Float32Array(leadSamples + signal.length);
  x.set(signal, leadSamples);
  return x;
}
function decode(samples, opts) {
  const d = new RttyCodec.Decoder(8000, opts);
  let out = "";
  d.onChar(ch => { out += ch; });
  for (let i = 0; i < samples.length; i += 333) d.pushSamples(samples.subarray(i, i + 333));
  return out;
}

// ---- TX: FIGS again after every space (USOS-safe), charStartTimes agrees ----
{
  const frames = RttyCodec.baudotToFrames(RttyCodec.textToBaudot("599 001"));
  const F = RttyCodec.CODE_FIGS;
  const c = ch => RttyCodec.textToBaudot(ch)[0].code;
  const want = [F, c("5"), c("9"), c("9"), 4, F, c("0"), c("0"), c("1")];
  check("FIGS is re-sent after a space before figures",
    JSON.stringify(frames) === JSON.stringify(want), JSON.stringify(frames));
  const letters = RttyCodec.baudotToFrames(RttyCodec.textToBaudot("CQ DE OK1HRA"));
  check("no extra shift between letters after a space",
    letters.filter(c => c === F).length === 1 && letters.length === "CQ DE OK1HRA".length + 2,
    JSON.stringify(letters));
  for (const text of ["599 001 599 001", "OK1HRA 5NN 123 TU", "A1 B2 C3", "73 73 GL"]) {
    const frameCount = RttyCodec.baudotToFrames(RttyCodec.textToBaudot(text)).length;
    const times = RttyCodec.charStartTimes(text);
    const lastFrame = Math.round(times[times.length - 1].startMs / RttyCodec.CHAR_DURATION_MS);
    check("charStartTimes matches the frame sequence: " + text, lastFrame === frameCount - 1,
      lastFrame + " vs " + (frameCount - 1));
  }
}

// ---- RX: clean round trip, squelch on, USOS on (the defaults) ----
const TEXT = "CQ TEST OK1HRA OK1HRA 599 001 TU 5NN 123 RYRY 73";
const clean = withLead(toFloat(new RttyCodec.Encoder(8000).encode(TEXT)));
check("clean round trip with the default decoder", decode(clean, {}) === TEXT, decode(clean, {}));
check("clean round trip with squelch off", decode(clean, {squelchDb: 0}) === TEXT);
check("clean round trip with USOS off", decode(clean, {usos: false}) === TEXT);

// The squelch averages over about a character, so on a signal that keys
// straight into a start bit it opens inside that start bit; the first
// character must still come from the start bit's real edge.
{
  const d = new RttyCodec.Decoder(8000, {});
  let first = null, openedAt = null;
  d.onEvent(e => { if (e.open && openedAt === null) openedAt = d.totalSamples; });
  d.onChar(ch => { if (first === null) first = ch; });
  d.pushSamples(clean);
  check("squelch opened only after the signal began", openedAt > 1600, String(openedAt));
  check("first character survives a squelch that opened inside its start bit", first === "C", String(first));
}

// ---- RX: USOS against a sender WITHOUT it ----
{
  // "599 001" as an old-style sender keys it: no FIGS after the space
  const F = RttyCodec.CODE_FIGS, L = RttyCodec.CODE_LTRS;
  const code = ch => RttyCodec.textToBaudot(ch)[0].code;
  const frames = [L, F, code("5"), code("9"), code("9"), 4, code("0"), code("0"), code("1")];
  // re-use the Encoder's modulator by mapping frames back through a 1:1 text
  // is not possible (it would add the FIGS), so synthesize directly
  const spb = 8000 / RttyCodec.BAUD;
  const bits = [];
  for (const c of frames) { bits.push([0, 1]); for (let b = 0; b < 5; b++) bits.push([(c >> b) & 1, 1]); bits.push([1, 1.5]); }
  let cum = 0, phase = 0, n = 0;
  const bounds = bits.map(([, u]) => Math.floor((cum += u) * spb));
  const pcm = new Float32Array(bounds[bounds.length - 1]);
  bits.forEach(([mark], i) => {
    const hz = 1500 + (mark ? 85 : -85);
    for (; n < bounds[i]; n++) { pcm[n] = 0.5 * Math.sin(phase); phase += 2 * Math.PI * hz / 8000; }
  });
  const x = withLead(pcm);
  check("USOS off reads a non-USOS sender right", decode(x, {usos: false}) === "599 001", decode(x, {usos: false}));
  check("USOS on reads it the documented wrong way", decode(x, {usos: true}) === "599 PPQ", decode(x, {usos: true}));
}

// ---- squelch against the noise: silent on pure noise at ANY audio level ----
{
  const r = rng(7);
  const seconds = 60, n = 8000 * seconds;
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = r.gauss();
  for (const level of [0.005, 0.05, 0.3]) {
    const x = Float32Array.from(noise, v => v * level);
    const gated = decode(x, {squelchDb: 3}).length;
    const open = decode(x, {squelchDb: 0}).length;
    check(`no garbage from pure noise at level ${level} with squelch 3 dB`, gated === 0, String(gated));
    check(`the same noise does decode to garbage with squelch off (level ${level})`, open > 50, String(open));
  }
}

// ---- noise blanker: static crashes on a clean signal ----
{
  const r = rng(11);
  const x = Float32Array.from(clean);
  for (let t = 2000; t < x.length; t += 400 + Math.floor(r() * 800))
    for (let j = 0; j < 30 && t + j < x.length; j++) x[t + j] += 8 * Math.exp(-j / 8) * r.gauss();
  const withNb = decode(x, {}), without = decode(x, {noiseBlanker: false});
  check("noise blanker decodes through static crashes", withNb === TEXT, withNb);
  check("without it the same crashes corrupt the text", without !== TEXT, without);
}

// ---- REVERSE and a detuned decoder still work on the new decision path ----
{
  const rev = withLead(toFloat(new RttyCodec.Encoder(8000, {reverse: true}).encode(TEXT)));
  check("REVERSE decodes an inverted sender", decode(rev, {reverse: true}) === TEXT);
  const off = withLead(toFloat(new RttyCodec.Encoder(8000, {toneHz: 1512}).encode(TEXT)));
  check("12 Hz of mistuning still decodes", decode(off, {}) === TEXT, decode(off, {}));
}

// ---- settings: schema v2, v1 migration ----
{
  const d = RttySettings.defaults();
  check("default squelch is 3 dB above the noise", d.squelchDb === 3 && d.squelchDb === RttySettings.SQUELCH_DB_DEFAULT);
  check("USOS defaults on", d.usos === true);
  check("schema is v2", RttySettings.SCHEMA_VERSION === 2 && d.v === 2);
  const n = RttySettings.normalize;
  check("v1 squelch OFF stays off", n({v: 1, squelchThreshold: 0}).squelchDb === 0);
  check("v1 squelch level becomes the v2 default", n({v: 1, squelchThreshold: 40}).squelchDb === 3);
  check("v1 store gets USOS on", n({v: 1, squelchThreshold: 4}).usos === true);
  check("v1 magnitude field is dropped", !("squelchThreshold" in n({v: 1, squelchThreshold: 4})));
  check("explicit USOS off survives", n({squelchDb: 5, usos: false}).usos === false);
  check("in-range level survives", n({squelchDb: 7}).squelchDb === 7);
  check("out-of-range level falls back to default", n({squelchDb: 27}).squelchDb === 3 && n({squelchDb: -2}).squelchDb === 3);
  check("0 means off", n({squelchDb: 0}).squelchDb === 0);
}

console.log(`RTTY CODEC ${fail ? "FAIL" : "PASS"} ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
