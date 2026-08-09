#!/usr/bin/env node
"use strict";

// Test layer 2 of docs/wspr-majak-implementace.md — the go/no-go for the whole
// design. It answers one question that cannot be answered on paper:
//
//   Does a WSPR signal survive the firmware's TX audio chain?
//
// The firmware does not forward what the browser sends. It decimates 48 kHz
// PCM16 by simply taking every sixth sample (no anti-alias filter at all) and
// then squeezes the result into 8-bit mu-law before handing it to the radio.
// This test rebuilds that exact chain in Node, using a port of the firmware's
// own aud1Pcm16ToUlaw, and then asks WSJT-X's independent decoder whether the
// message still comes out.
//
//   WsprStream 48k PCM16  ->  every 6th sample  ->  mu-law 8k  (firmware)
//                         ->  mu-law expand     ->  8k -> 12k  (test only)
//                         ->  120 s WAV         ->  wsprd
//
// Requires wsprd (WSJT-X). Skips with a clear message when it is absent.

const {execFileSync} = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const Wspr = require("../data/wspr-core.js");

const MESSAGE = {callsign: "OK1HRA", locator: "JN79", powerDbm: 37};
const DIAL_MHZ = "14.0956";
const BASE_HZ = 1500;
const GAINS = [0.1, 0.25, 0.8];       // the wsprTxGain range the UI offers

let failures = 0, checks = 0;
function check(name, actual, expected) {
  checks++;
  if (actual === expected) return true;
  failures++;
  console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
  return false;
}
function ok(name, condition, detail = "") {
  return check(name + (detail ? ` (${detail})` : ""), Boolean(condition), true);
}

// ---- the firmware's own routines, ported verbatim ---------------------------

// IC-705_Interface.ino:6176 — byte for byte, so a change there breaks this test.
function aud1Pcm16ToUlaw(input) {
  let sample = input;
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample += 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; exponent--, mask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

// Standard G.711 expansion — the exact inverse of the above. The radio does
// this internally; the test does it so the signal can be handed to wsprd.
function ulawToPcm16(value) {
  const u = (~value) & 0xff;
  const magnitude = ((((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4)) - 0x84;
  return (u & 0x80) ? -magnitude : magnitude;
}

// ---- the chain --------------------------------------------------------------

// Walks the real AUD1 packets the browser would put on the wire and applies
// exactly what aud1AcceptTxPacket does to each one, checking the wire format on
// the way through.
function firmwareChain(symbols, amplitude) {
  const stream = new Wspr.WsprStream(symbols, {baseHz: BASE_HZ, amplitude,
    streamId: 0x53505752, txId: 7});
  const ulaw = new Uint8Array(Math.ceil(Wspr.SIGNAL_SAMPLES / 6));
  let written = 0, packets = 0, sawFirst = false, sawLast = false;
  let expectedSequence = 0, expectedSample = 0, maxPacketBytes = 0;

  for (let packet; (packet = stream.nextPacket());) {
    const {wire} = packet;
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
    const payload = wire.length - 40;

    // The firmware aborts the transmission on any of these, so a violation here
    // is a silent failure on the air.
    if (String.fromCharCode(...wire.subarray(0, 4)) !== "AUD1" ||
        wire[4] !== 1 || wire[5] !== 3 ||
        view.getUint16(8, false) !== 40 || view.getUint16(10, false) !== 0 ||
        view.getUint32(20, false) !== 48000 || view.getUint32(36, false) !== payload ||
        payload === 0 || payload % 12 !== 0 ||
        view.getUint32(16, false) !== expectedSequence ||
        Number(view.getBigUint64(24, false)) !== expectedSample)
      throw new Error(`packet ${packets} violates the AUD1 contract`);

    const flags = view.getUint16(6, false);
    if ((flags & 1) !== 0) sawFirst = packets === 0;
    if ((flags & 2) !== 0) sawLast = true;
    maxPacketBytes = Math.max(maxPacketBytes, wire.length);

    // aud1AcceptTxPacket: for(i=0; i<samples; i+=6) ring <- ulaw(pcm[i])
    for (let i = 0; i < payload / 2; i += 6)
      ulaw[written++] = aud1Pcm16ToUlaw(view.getInt16(40 + i * 2, true));

    expectedSequence++;
    expectedSample += payload / 2;
    packets++;
  }
  return {ulaw: ulaw.subarray(0, written), packets, sawFirst, sawLast,
          maxPacketBytes, totalSamples: expectedSample};
}

// Windowed-sinc low-pass at 24 kHz, used for 8k -> 12k as upsample x3 /
// filter / decimate x2. Only the test needs this; the radio never resamples.
function lowPassTaps(count, cutoffHz, rateHz) {
  const taps = new Float64Array(count), middle = (count - 1) / 2;
  const omega = 2 * Math.PI * cutoffHz / rateHz;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const n = i - middle;
    const sinc = n === 0 ? omega : Math.sin(omega * n) / n;
    const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (count - 1));
    taps[i] = sinc * window;
    sum += taps[i];
  }
  for (let i = 0; i < count; i++) taps[i] /= sum;
  return taps;
}

function resample8kTo12k(pcm8k) {
  const taps = lowPassTaps(97, 3400, 24000);
  const out = new Int16Array(Math.floor(pcm8k.length * 3 / 2));
  for (let m = 0; m < out.length; m++) {
    const k = 2 * m;                       // index in the x3 upsampled stream
    let acc = 0;
    const from = Math.max(0, Math.ceil((k - taps.length + 1) / 3));
    const to = Math.min(pcm8k.length - 1, Math.floor(k / 3));
    for (let n = from; n <= to; n++) acc += taps[k - 3 * n] * pcm8k[n];
    acc *= 3;                              // zero-stuffing loses 1/3 of the gain
    out[m] = Math.max(-32768, Math.min(32767, Math.round(acc)));
  }
  return out;
}

// Reference branch: the same generated audio taken straight to 12 kHz without
// ever passing through decimation or mu-law. Decoding both and comparing the
// reported SNR is what turns "it decoded" into a number for what the firmware's
// audio path actually costs.
function resample48kTo12k(pcm48k) {
  const taps = lowPassTaps(129, 5000, 48000);
  const out = new Int16Array(Math.floor(pcm48k.length / 4));
  const middle = (taps.length - 1) >> 1;
  for (let m = 0; m < out.length; m++) {
    const centre = 4 * m;
    let acc = 0;
    for (let j = 0; j < taps.length; j++) {
      const at = centre + j - middle;
      if (at >= 0 && at < pcm48k.length) acc += taps[j] * pcm48k[at];
    }
    out[m] = Math.max(-32768, Math.min(32767, Math.round(acc)));
  }
  return out;
}

function generate48k(symbols, amplitude) {
  const stream = new Wspr.WsprStream(symbols, {baseHz: BASE_HZ, amplitude});
  const pcm = new Int16Array(Wspr.SIGNAL_SAMPLES);
  for (let at = 0; at < pcm.length;) {
    const block = stream.nextSamples(96000);
    pcm.set(block, at);
    at += block.length;
  }
  return pcm;
}

// Deterministic Gaussian noise, so a threshold check either always passes or
// always fails rather than flapping between runs.
let noiseSeed = 12345;
function gaussian() {
  noiseSeed = (noiseSeed * 1103515245 + 12345) & 0x7fffffff;
  const u = (noiseSeed + 1) / 0x80000000;
  noiseSeed = (noiseSeed * 1103515245 + 12345) & 0x7fffffff;
  const v = (noiseSeed + 1) / 0x80000000;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 12 kHz mono 16-bit, 120 s, signal starting one second in — the shape wsprd
// expects from a WSJT-X recording. `snrDb` adds noise calibrated to the WSPR
// convention (signal power against noise power in a 2500 Hz reference band,
// while the file itself carries noise across the full 0-6000 Hz).
function writeWav(file, pcm12k, snrDb = null) {
  const rate = 12000, total = rate * 120, lead = rate;
  const samples = new Int16Array(total);
  samples.set(pcm12k.subarray(0, Math.min(pcm12k.length, total - lead)), lead);
  if (snrDb !== null) {
    let power = 0;
    for (const sample of pcm12k) power += sample * sample;
    power /= pcm12k.length;
    const sigma = Math.sqrt(power / Math.pow(10, snrDb / 10) * (6000 / 2500));
    noiseSeed = 12345;
    for (let i = 0; i < total; i++)
      samples[i] = Math.max(-32768, Math.min(32767,
        Math.round(samples[i] + sigma * gaussian())));
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length * 2, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer)]));
  return samples.length;
}

// ---- run --------------------------------------------------------------------

let wsprd = true;
try { execFileSync("wsprd", {stdio: "ignore"}); }
catch (error) { if (error.code === "ENOENT") wsprd = false; }
if (!wsprd) {
  console.error("SKIP: wsprd not found — install WSJT-X to run the decode check");
  process.exitCode = 77;
  return;
}

const frame = Wspr.encode(MESSAGE);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wspr-audio-"));
const expectedText = `${MESSAGE.callsign} ${MESSAGE.locator} ${MESSAGE.powerDbm}`;

// wsprd takes the timestamp from the file name, so every run gets its own
// directory and the canonical YYMMDD_HHMM.wav rather than a decorated name.
function decode(label, pcm12k, snrDb = null) {
  const runDir = fs.mkdtempSync(path.join(workDir, "run-"));
  const file = path.join(runDir, "260725_2300.wav");
  writeWav(file, pcm12k, snrDb);
  let output = "";
  try {
    output = execFileSync("wsprd", ["-a", runDir, "-f", DIAL_MHZ, file],
                          {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
  } catch (error) { output = String(error.stdout || "") + String(error.stderr || ""); }
  fs.rmSync(runDir, {recursive: true, force: true});

  // wsprd line:  <time> <snr> <dt> <freq> <drift>  <message>
  const line = (output.split("\n").find(row => row.includes(MESSAGE.callsign)) || "").trim();
  const fields = line.split(/\s+/);
  const decoded = line.includes(expectedText);
  ok(`${label}: decoded by wsprd`, decoded, line || "no decode");
  return {decoded, line,
          snr: decoded ? Number(fields[1]) : NaN,
          dt: decoded ? Number(fields[2]) : NaN,
          drift: decoded ? Number(fields[4]) : NaN};
}

const results = [];
for (const gain of GAINS) {
  const chain = firmwareChain(frame.symbols, gain);

  check(`gain ${gain}: total samples`, chain.totalSamples, Wspr.SIGNAL_SAMPLES);
  check(`gain ${gain}: packets`, chain.packets, 5530);
  check(`gain ${gain}: mu-law bytes`, chain.ulaw.length, 884736);
  ok(`gain ${gain}: FIRST on packet 0`, chain.sawFirst);
  ok(`gain ${gain}: LAST seen`, chain.sawLast);
  ok(`gain ${gain}: packet fits Aud1WsParser::MaxPayload`, chain.maxPacketBytes <= 2048,
     `${chain.maxPacketBytes} B`);

  const pcm8k = new Int16Array(chain.ulaw.length);
  for (let i = 0; i < chain.ulaw.length; i++) pcm8k[i] = ulawToPcm16(chain.ulaw[i]);

  const radioPcm = resample8kTo12k(pcm8k);
  const cleanPcm = resample48kTo12k(generate48k(frame.symbols, gain));
  const radio = decode(`gain ${gain} through firmware chain`, radioPcm);
  const clean = decode(`gain ${gain} reference, no mu-law`, cleanPcm);
  results.push({gain, radio, clean, radioPcm, cleanPcm});
}

// The decisive check. wsprd's SNR readout on a noiseless file is an artifact of
// its own noise estimator (it reports about +42 dB for a clean signal and about
// -21 dB for the mu-law one, which would look alarming and mean nothing). What
// matters is whether the mu-law chain still decodes at a realistic weak-signal
// level. A one-off bisection measured the threshold at -28/-30/-29 dB for gains
// 0.1/0.25/0.8 and found it IDENTICAL for both chains, so mu-law costs 0 dB.
// This asserts one paired point of that at the default gain; -26 dB sits a
// couple of dB above the measured threshold, far enough not to flap.
{
  const {radioPcm, cleanPcm} = results.find(entry => entry.gain === 0.25);
  const weakRadio = decode("weak signal -26 dB through firmware chain", radioPcm, -26);
  const weakClean = decode("weak signal -26 dB reference, no mu-law", cleanPcm, -26);
  ok("mu-law costs nothing at the decode threshold",
     weakRadio.decoded === weakClean.decoded && weakRadio.decoded,
     `mu-law ${weakRadio.decoded ? "ok" : "FAIL"}, clean ${weakClean.decoded ? "ok" : "FAIL"}`);
}

// These SNR figures are NOT a measurement of anything. On a noiseless file
// wsprd has no noise to estimate, so it reports a ceiling for the clean branch
// and something arbitrary for the mu-law one. Printed only as a coarse
// regression tripwire; the real answer is the paired threshold check below.
console.log("\n  gain   firmware chain        clean reference      (SNR here is a wsprd");
console.log("                                                     artifact, not a loss)");
for (const {gain, radio, clean} of results)
  console.log(`  ${String(gain).padEnd(6)} SNR ${String(radio.snr).padStart(4)} dB drift ${String(radio.drift).padStart(2)}   ` +
              `SNR ${String(clean.snr).padStart(4)} dB drift ${String(clean.drift).padStart(2)}`);
console.log();

// Every gain the UI can produce must decode. A collapse at the top would mean
// clipping; one at the bottom would mean the mu-law floor is eating the signal.
ok("decodes across the whole wsprTxGain range",
   results.every(entry => entry.radio.decoded),
   results.map(entry => `${entry.gain}:${entry.radio.decoded ? "ok" : "FAIL"}`).join(" "));
// WSPR tolerates roughly 1 Hz of drift over a transmission; the generator itself
// must contribute none, so anything non-zero here is a generator bug.
ok("generator contributes no drift",
   results.every(entry => entry.radio.drift === 0 && entry.clean.drift === 0),
   results.map(entry => `${entry.gain}:${entry.radio.drift}/${entry.clean.drift}`).join(" "));

fs.rmSync(workDir, {recursive: true, force: true});
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
