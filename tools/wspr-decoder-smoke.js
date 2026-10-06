#!/usr/bin/env node
"use strict";

// WSPR RX decoder (data/wspr-decoder.js) against WSJT-X's own wsprd, on the
// audio the page really gets: the AUD1 RX stream, i.e. mu-law at 8 kHz.
//
//   synthesise @8 kHz + calibrated noise -> mu-law -> expand -> Float32
//        ├── WsprDecoder.decode(…, 8000)                    (the port)
//        └── 8k -> 12k -> 120 s WAV -> wsprd                 (the reference)
//
// Both decoders see the same samples, so every difference is the port's.
// Also measures how long one cycle takes and what the sensitivity floor is,
// and that a hole in the stream (lost packets) does not cost the decode.
//
// Requires wsprd + wsprsim (WSJT-X). Exit 77 = skipped.

const {execFileSync} = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const Core = require("../data/wspr-core.js");
const Decoder = require("../data/wspr-decoder.js");

const RATE = 8000, NEED = 114 * RATE, DIAL_MHZ = 14.0956;
let failures = 0, checks = 0;
function ok(name, condition, detail = "") {
  checks++;
  if (condition) return true;
  failures++;
  console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  return false;
}

for (const tool of ["wsprd", "wsprsim"]) {
  try { execFileSync(tool, {stdio: "ignore"}); }
  catch (error) {
    if (error.code === "ENOENT") { console.error(`SKIP: ${tool} not found`); process.exit(77); }
  }
}

// ---- signal --------------------------------------------------------------

function symbolsFor(message) {
  const parts = message.split(" ");
  if (parts.length === 3 && !message.includes("/") && !message.startsWith("<"))
    return Core.encode({callsign: parts[0], locator: parts[1], powerDbm: Number(parts[2])}).symbols;
  let out;   // wsprsim exits 1 even after printing the symbols
  try { out = execFileSync("wsprsim", ["-c", message], {encoding: "utf8"}); }
  catch (error) { out = String(error.stdout || ""); }
  const row = out.split("\n").find(line => /^[0-3]( [0-3]){100,}/.test(line.trim()));
  return Uint8Array.from(row.trim().split(/\s+/).map(Number));
}

let seed = 12345;
function gaussian() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  const u = (seed + 1) / 0x80000000;
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  const v = (seed + 1) / 0x80000000;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 120 s at 8 kHz, int16 scale. SNR is WSPR's: signal power against noise in a
// 2500 Hz reference band, while the file carries noise across 0-4000 Hz.
function synthesise(signals, {sigma = 1500, noiseSeed = 12345} = {}) {
  seed = noiseSeed;
  const n = 120 * RATE, out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = sigma * gaussian();
  const noise2500 = sigma * sigma * 2500 / (RATE / 2);
  const symbolSeconds = 8192 / 12000;
  for (const s of signals) {
    const sym = symbolsFor(s.message);
    const amp = Math.sqrt(2 * noise2500 * Math.pow(10, s.snr / 10));
    const start = (1 + (s.dt || 0)) * RATE;
    let phase = 0;
    for (let k = Math.max(0, Math.ceil(start)); k < n; k++) {
      const i = Math.floor((k - start) / RATE / symbolSeconds);
      if (i >= 162) break;
      const f = 1500 + (s.freq || 0) + ((s.drift || 0) / 2) * (i - 81) / 81 + (sym[i] - 1.5) * 12000 / 8192;
      out[k] += amp * Math.sin(phase);
      phase += 2 * Math.PI * f / RATE;
    }
  }
  return out;
}

// The firmware's aud1Pcm16ToUlaw and G.711 expansion (as in wspr-audio-smoke.js).
function toUlaw(input) {
  let sample = Math.max(-32768, Math.min(32767, Math.round(input)));
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample += 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; exponent--, mask >>= 1) {}
  return (~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 0x0f))) & 0xff;
}
function fromUlaw(value) {
  const u = (~value) & 0xff;
  const magnitude = ((((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4)) - 0x84;
  return (u & 0x80) ? -magnitude : magnitude;
}
function throughAud1(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = fromUlaw(toUlaw(pcm[i])) / 32768;
  return out;
}

// ---- the two decoders ----------------------------------------------------

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wspr-rx-"));
function wsprd(samples8k) {
  const x12 = Decoder.to12k(samples8k, RATE);
  const pcm = new Int16Array(120 * 12000);
  for (let i = 0; i < Math.min(x12.length, pcm.length); i++)
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(x12[i] * 32768)));
  const runDir = fs.mkdtempSync(path.join(workDir, "run-"));
  const file = path.join(runDir, "261006_1200.wav");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length * 2, 4);
  header.write("WAVE", 8); header.write("fmt ", 12); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(12000, 24);
  header.writeUInt32LE(24000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length * 2, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(pcm.buffer)]));
  let output = "";
  try {
    output = execFileSync("wsprd", ["-a", runDir, "-f", String(DIAL_MHZ), file],
      {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
  } catch (error) { output = String(error.stdout || ""); }
  fs.rmSync(runDir, {recursive: true, force: true});
  // <date+time> <snr> <dt> <freq MHz> <drift> <message...>
  return output.split("\n").map(l => l.trim().split(/\s+/)).filter(f => f.length >= 7 && /^\d{4,}$/.test(f[0]))
    .map(f => ({snr: Number(f[1]), dt: Number(f[2]), audioHz: (Number(f[3]) - DIAL_MHZ) * 1e6,
      drift: Number(f[4]), message: f.slice(5).join(" ")}));
}

function messageOf(d) {
  return d.type === 2 ? `${d.call} ${d.power}` : `${d.call} ${d.grid} ${d.power}`;
}
const hashes = new Decoder.HashTable();
function port(samples8k, opts = {}) {
  const r = Decoder.decode(samples8k.subarray(0, NEED), RATE, Object.assign({osdDepth: 0}, opts), hashes);
  return Object.assign(r, {decodes: r.decodes.map(d => Object.assign(d, {message: messageOf(d)}))});
}

// ---- 1. a busy cycle: types 1 and 2, drift, DT spread, close spacing -------

const cycle1 = [
  {message: "K1ABC FN42 37", freq: -82, snr: -21, dt: 0.3, drift: 1},
  {message: "OK1HRA JN79 23", freq: -31, snr: -14},
  {message: "VK2AB QF56 33", freq: 6, snr: -24, dt: -0.6},
  {message: "PJ4/K1ABC 37", freq: 44, snr: -19},
  {message: "DL1XYZ JN58 30", freq: 49, snr: -22, dt: 1.1},
  {message: "JA1AAA PM95 40", freq: 88, snr: -23, drift: -2},
];
const audio1 = throughAud1(synthesise(cycle1));
const t0 = Date.now();
const ours1 = port(audio1);
const elapsed = Date.now() - t0;
const ref1 = wsprd(audio1);

console.log(`\n  cycle 1: port ${ours1.decodes.length} decodes in ${elapsed} ms, wsprd ${ref1.length}`);
for (const sig of cycle1) {
  const a = ours1.decodes.find(d => d.message === sig.message);
  const b = ref1.find(d => d.message === sig.message);
  ok(`cycle 1 port decodes "${sig.message}"`, a);
  if (!a || !b) { if (!b) console.log(`    note: wsprd missed "${sig.message}" too`); continue; }
  console.log(`    ${sig.message.padEnd(18)} port snr ${a.snr} dt ${a.dt} f ${a.audioHz.toFixed(1)} dr ${a.drift}` +
    `   wsprd snr ${b.snr} dt ${b.dt} f ${b.audioHz.toFixed(1)} dr ${b.drift}`);
  ok(`"${sig.message}" SNR matches wsprd ±1 dB`, Math.abs(a.snr - b.snr) <= 1, `${a.snr} vs ${b.snr}`);
  ok(`"${sig.message}" DT matches wsprd ±0.15 s`, Math.abs(a.dt - b.dt) <= 0.15, `${a.dt} vs ${b.dt}`);
  ok(`"${sig.message}" freq matches wsprd ±0.3 Hz`, Math.abs(a.audioHz - b.audioHz) <= 0.3,
    `${a.audioHz} vs ${b.audioHz.toFixed(2)}`);
  ok(`"${sig.message}" true freq ±0.5 Hz`, Math.abs(a.audioHz - 1500 - sig.freq) <= 0.5);
}
ok("cycle 1: no false decodes", ours1.decodes.every(d => cycle1.some(s => s.message === d.message)),
  ours1.decodes.map(d => d.message).join(", "));
ok("cycle 1: port finds at least as many as wsprd", ours1.decodes.length >= ref1.length,
  `${ours1.decodes.length} vs ${ref1.length}`);
ok("one cycle decodes in under 20 s", elapsed < 20000, `${elapsed} ms`);

// ---- 2. type 3 resolves through the hash learnt from cycle 1 --------------

const cycle2 = [{message: "<PJ4/K1ABC> FK52UD 37", freq: -10, snr: -18}];
const ours2 = port(throughAud1(synthesise(cycle2, {noiseSeed: 777})));
ok("type 3 decodes with the hashed call resolved",
  ours2.decodes.some(d => d.type === 3 && d.call === "<PJ4/K1ABC>" && d.grid === "FK52UD" && d.power === 37),
  ours2.decodes.map(d => d.message).join(", "));
const blank = Decoder.decode(throughAud1(synthesise(cycle2, {noiseSeed: 777})).subarray(0, NEED), RATE, {},
  new Decoder.HashTable());
ok("type 3 with an empty hash table shows <...>",
  blank.decodes.some(d => d.type === 3 && d.call === "<...>"), blank.decodes.map(messageOf).join(", "));

// ---- 3. a 2 s hole (lost AUD1 packets) mid-transmission --------------------

const holed = throughAud1(synthesise([{message: "OK1HRA JN79 37", freq: 20, snr: -22}], {noiseSeed: 99}));
holed.fill(0, 50 * RATE, 52 * RATE);
ok("decodes across a 2 s hole", port(holed).decodes.some(d => d.message === "OK1HRA JN79 37"));

// ---- 4. sensitivity floor: port vs wsprd on identical files ----------------

function floor(decodeFn) {
  let best = null;
  for (let snr = -24; snr >= -32; snr--) {
    const audio = throughAud1(synthesise([{message: "G4JNT IO90 30", freq: -40, snr}], {noiseSeed: 4242}));
    if (decodeFn(audio).some(d => d.message === "G4JNT IO90 30")) best = snr; else break;
  }
  return best;
}
const floorPort = floor(a => port(a).decodes), floorRef = floor(a => wsprd(a));
console.log(`  sensitivity floor: port ${floorPort} dB, wsprd ${floorRef} dB`);
ok("port floor within 1 dB of wsprd", floorPort !== null && floorRef !== null && floorPort <= floorRef + 1,
  `${floorPort} vs ${floorRef}`);

// ---- 5. decoder options do what they say -----------------------------------

const quick = port(audio1, {quick: true});
ok("quick mode still decodes the strong one", quick.decodes.some(d => d.message === "OK1HRA JN79 23"));
const wideOnly = throughAud1(synthesise([{message: "OK1HRA JN79 37", freq: 130, snr: -15}], {noiseSeed: 5}));
ok("±110 Hz window ignores a signal at +130 Hz", !port(wideOnly).decodes.length);
ok("wide window finds it", port(wideOnly, {wide: true}).decodes.some(d => d.message === "OK1HRA JN79 37"));

fs.rmSync(workDir, {recursive: true, force: true});
const mem = process.memoryUsage();
console.log(`  peak-ish RSS ${(mem.rss / 1e6).toFixed(0)} MB`);
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exitCode = failures ? 1 : 0;
