#!/usr/bin/env node
"use strict";
// JTTY modem test (data/jtty-modem.js, docs/jtty-implementace.md §4.2-§4.4):
// TX tones and FEC, then whole messages through the receiver -- clean, in
// white noise at the sensitivity target, two stations at once, the way the
// firmware brings 48 kHz TX down to 8 kHz, and the real WSJT-X sample
// recording when it is present (tools/fixtures/jtty/260807_134110.wav, not in
// git; JTTY_WAV=path overrides). Seeded noise, no browser.

const fs = require("fs");
const path = require("path");
const C = require("../data/jtty-codec.js");
const M = require("../data/jtty-modem.js");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log("FAIL " + name + (detail !== undefined ? "  " + detail : "")); }
}

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

// ── FEC
const p = C.packText("CQ OK1HRA CQ").frames[0];
const info = M.appendCrc(p);
check("CRC-12 closes over 46 bits", M.crcValid(info));
const bad = info.slice(); bad[5] ^= 1;
check("a flipped bit breaks the CRC", !M.crcValid(bad));
const tones = M.frameTones(p);
check("frame is 59 tones starting with the 13-symbol sync", tones.length === 59 &&
  Array.from(tones.subarray(0, 13)).join("") === "0223003213120");
check("tones are 0..3", tones.every(t => t <= 3));
const {zr, zi, hr} = (() => {
  const t46 = tones.subarray(13);
  const zr = new Float64Array(4 * 46), zi = new Float64Array(4 * 46), hr = new Float64Array(4 * 46);
  for (let j = 0; j < 46; j++) { zr[t46[j] * 46 + j] = 1; hr[t46[j] * 46 + j] = 1; }
  return {zr, zi, hr};
})();
const back = M._internal.decodeFrame(zr, zi, hr);
check("list-WAVA recovers a clean codeword", back && Array.from(back).join("") === Array.from(p).join(""));

// ── waveform
const pcm48 = M.synthesize(tones, {sampleRate: 48000, f0: 1500, amplitude: 0.5});
check("one frame at 48 kHz is 59*1536 samples", pcm48.length === 59 * 1536);
check("48 kHz frame is a multiple of 6 (firmware decimation)", pcm48.length % 6 === 0);
let peak = 0; for (const v of pcm48) peak = Math.max(peak, Math.abs(v));
check("amplitude 0.5 peaks at half scale", Math.abs(peak - 16384) < 200, peak);
// spectrum occupancy: 99 % of power inside ~127 Hz around the tone block
{
  const x = M.synthesize(M.messageTones(C.packText("THE QUICK BROWN FOX JUMPS OVER").frames), {sampleRate: 8000, f0: 1000, amplitude: 1});
  const n = 1 << 17, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < Math.min(n, x.length); i++) re[i] = x[i];
  M._internal.fft(re, im, n, -1);
  let total = 0, inside = 0;
  for (let k = 0; k < n / 2; k++) {
    const f = k * 8000 / n, pw = re[k] ** 2 + im[k] ** 2;
    total += pw;
    if (f >= 1000 + 46.875 - 63.5 && f <= 1000 + 46.875 + 63.5) inside += pw;
  }
  check("99 % of the power within 127 Hz", inside / total > 0.985, (inside / total).toFixed(4));
}

// ── receiver
function toFloat(pcm16) { return Float32Array.from(pcm16, s => s / 32768); }

function addNoise(x, snrDb, seed) {
  // snrDb in 2500 Hz: signal power vs noise power in 2500 Hz of an 8 kHz stream
  const r = rng(seed);
  let ps = 0; for (const v of x) ps += v * v; ps /= x.length;
  const sigma = Math.sqrt(ps / 10 ** (snrDb / 10) * (4000 / 2500));
  return Float32Array.from(x, v => v + sigma * r.gauss());
}

function receive(signal, opts) {
  const rx = new M.Receiver(Object.assign({rxHz: 1500, ftolHz: 100}, opts || {}));
  const all = new Map();
  for (let i = 0; i < signal.length; i += 1600) {
    for (const u of rx.push(signal.subarray(i, Math.min(signal.length, i + 1600)))) all.set(u.id, u);
  }
  for (const u of rx.gap(3 * 15104)) all.set(u.id, u);
  return {messages: Array.from(all.values()), rx};
}

function station(text, f0, leadS, amp, rate) {
  const packed = C.packText(text);
  const pcm = M.synthesize(M.messageTones(packed.frames), {sampleRate: rate || 8000, f0, amplitude: amp || 0.3});
  return {packed, pcm, leadS};
}

function mix(stations, totalS) {
  const out = new Float32Array(Math.round(totalS * 8000));
  for (const s of stations) {
    const x = toFloat(s.pcm), at = Math.round(s.leadS * 8000);
    for (let i = 0; i < x.length && at + i < out.length; i++) out[at + i] += x[i];
  }
  return out;
}

{
  const s = station("CQ OK1HRA CQ", 1500, 0.7);
  const {messages, rx} = receive(mix([s], 5));
  const m = messages.find(x => x.text === "CQ OK1HRA CQ");
  check("clean single frame decodes", m && m.complete, JSON.stringify(messages));
  check("frequency within 1 Hz", m && Math.abs(m.audioHz - 1500) < 1, m && m.audioHz);
  check("start time within 5 ms", m && Math.abs(m.startT - 0.7) < 0.005, m && m.startT);
  check("exactly one message", messages.length === 1, messages.length);
  console.log("  window time " + rx.stats().lastWindowMs + " ms");
}
{
  const s = station("TU NOW DL1ABC 599 102 GL OM", 1480, 0.3);
  const {messages} = receive(mix([s], 2 + s.pcm.length / 8000 + 1));
  const m = messages.find(x => x.complete);
  check("multi-frame message assembles", m && m.text === s.packed.text, JSON.stringify(messages.map(x => x.text)));
}
{
  // 48 kHz TX through the firmware's every-6th-sample decimation
  const s = station("OK1HRA 599 001", 1550, 0.4, 0.3, 48000);
  const pcm8 = new Int16Array(Math.floor(s.pcm.length / 6));
  for (let i = 0; i < pcm8.length; i++) pcm8[i] = s.pcm[6 * i];
  const {messages} = receive(mix([{pcm: pcm8, leadS: 0.4}], 6));
  check("48 kHz TX decimated by 6 decodes", messages.some(x => x.text === "OK1HRA 599 001" && x.complete),
    JSON.stringify(messages.map(x => x.text)));
}
{
  const a = station("CQ OK1HRA CQ", 1400, 0.5, 0.3);
  const b = station("CQ DL1ABC CQ", 1700, 0.9, 0.2);
  const {messages} = receive(mix([a, b], 5), {rxHz: 1400});
  check("two stations, RX channel + search channel", ["CQ OK1HRA CQ", "CQ DL1ABC CQ"].every(t => messages.some(x => x.text === t)),
    JSON.stringify(messages.map(x => x.text + "@" + x.audioHz)));
}
{
  // overlapping in time and 40 Hz apart: needs subtraction
  const a = station("CQ OK1HRA CQ", 1500, 0.5, 0.3);
  const b = station("CQ G4XYZ CQ", 1540, 0.6, 0.12);
  const {messages} = receive(mix([a, b], 5), {rxHz: 1500});
  check("weaker overlapping station 40 Hz away", ["CQ OK1HRA CQ", "CQ G4XYZ CQ"].every(t => messages.some(x => x.text === t)),
    JSON.stringify(messages.map(x => x.text + "@" + x.audioHz)));
}
{
  const runs = Number(process.env.JTTY_RUNS || 10);
  for (const snr of [-10, -14]) {
    let ok = 0;
    for (let k = 0; k < runs; k++) {
      const s = station("CQ OK1HRA CQ", 1500 + (k % 5) * 7, 0.6, 0.3);
      const x = addNoise(mix([s], 4.5), snr, 1000 + k + 100 * snr);
      if (receive(x).messages.some(m => m.text === "CQ OK1HRA CQ")) ok++;
    }
    console.log(`  ${snr} dB/2500 Hz: ${ok}/${runs}`);
    check(`decodes at ${snr} dB`, snr === -10 ? ok === runs : ok >= Math.ceil(runs * 0.8), ok + "/" + runs);
  }
  let falses = 0;
  const noise = addNoise(new Float32Array(8000 * 20), 0, 7);
  falses = receive(noise.map(v => v * 0.1)).messages.length;
  check("20 s of noise decodes nothing", falses === 0, falses);
}

// ── the real WSJT-X sample
function readWav(file) {
  const b = fs.readFileSync(file);
  const rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  let off = 12;
  while (off < b.length) {
    const id = b.toString("ascii", off, off + 4), len = b.readUInt32LE(off + 4);
    if (id === "data") {
      const n = len / 2, x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(off + 8 + 2 * i) / 32768;
      return {rate, bits, x};
    }
    off += 8 + len;
  }
  throw new Error("no data chunk");
}
// 12 kHz -> 8 kHz: up 2, windowed-sinc low-pass at 3.6 kHz, down 3.
function to8k(x) {
  const taps = 121, h = new Float64Array(taps), fc = 3600 / 24000;
  for (let i = 0; i < taps; i++) {
    const n = i - (taps - 1) / 2;
    const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1));
    h[i] = 2 * fc * (n === 0 ? 1 : Math.sin(2 * Math.PI * fc * n) / (2 * Math.PI * fc * n)) * w * 2;
  }
  const out = new Float32Array(Math.floor(x.length * 2 / 3));
  for (let k = 0; k < out.length; k++) {
    const m = 3 * k;
    let s = 0;
    for (let i = 0; i < taps; i++) {
      const u = m - i + (taps - 1) / 2;
      if (u % 2 !== 0) continue;
      const xi = u / 2;
      if (xi >= 0 && xi < x.length) s += h[i] * x[xi];
    }
    out[k] = s;
  }
  return out;
}
const wavPath = process.env.JTTY_WAV || path.join(__dirname, "fixtures", "jtty", "260807_134110.wav");
if (fs.existsSync(wavPath)) {
  const wav = readWav(wavPath);
  const x8 = to8k(wav.x);
  const t0 = Date.now();
  const {messages} = receive(x8, {rxHz: 1500, ftolHz: 500, searchLowHz: 200, searchHighHz: 2900});
  const ms = Date.now() - t0;
  console.log(`  WSJT-X sample (${(wav.x.length / wav.rate).toFixed(1)} s) in ${ms} ms:`);
  for (const m of messages) console.log(`    ${String(m.audioHz).padStart(7)} Hz ${String(m.snr).padStart(4)} dB ${m.complete ? "EOM" : m.status}  ${m.text}`);
  check("the WSJT-X sample decodes", messages.length > 0);
} else {
  console.log("  (no WSJT-X sample at " + wavPath + ", skipped)");
}

console.log(`JTTY MODEM ${fail ? "FAIL" : "PASS"} ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
