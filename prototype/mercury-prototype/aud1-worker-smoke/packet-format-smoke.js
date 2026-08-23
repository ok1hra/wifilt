#!/usr/bin/env node
// Verifies worker.js's upsample8kTo48k()/buildTxPacket() WITHOUT a live AUD1
// socket (port 83 needs root/setcap in this sandbox -- same known gap
// tools/native-integration-test.sh already skips over; see this prototype's
// README). Round-trips the exact bytes worker.js would send through the REAL,
// unmodified data/js8-aud1.js parser (parseAud1) that the production page
// itself uses to validate every packet it receives -- so this is "does the
// real parser accept what this builder produces", not a reimplemented check.
"use strict";
const path = require("path");
const { parseAud1 } = require(path.resolve(__dirname, "../../../data/js8-aud1.js"));

let failures = 0;
function check(name, pass, detail = "") {
  console.log(`  ${pass ? "OK  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
  if (!pass) failures++;
}

// ---- same two functions as worker.js, copied rather than imported: worker.js
// runs in a Worker global scope (importScripts), this runs under Node. Kept
// byte-for-byte identical on purpose -- a divergence here would defeat the
// point of testing "what worker.js actually builds". ----
function upsample8kTo48k(int16In) {
  const n = int16In.length;
  const out = new Int16Array(Math.max(0, n - 1) * 6 + (n > 0 ? 6 : 0));
  for (let i = 0; i < n; i++) {
    const a = int16In[i];
    const b = i + 1 < n ? int16In[i + 1] : int16In[i];
    for (let j = 0; j < 6; j++) out[i * 6 + j] = Math.round(a + (b - a) * (j / 6));
  }
  return out;
}
function buildTxPacket({ streamId, txId, sequence, sampleRate, firstSample, pcm, first, last }) {
  const wire = new Uint8Array(40 + pcm.length * 2);
  const view = new DataView(wire.buffer);
  wire.set([0x41, 0x55, 0x44, 0x31], 0);
  wire[4] = 1; wire[5] = 3;
  view.setUint16(6, (first ? 1 : 0) | (last ? 2 : 0), false);
  view.setUint16(8, 40, false);
  view.setUint32(12, streamId >>> 0, false);
  view.setUint32(16, sequence >>> 0, false);
  view.setUint32(20, sampleRate >>> 0, false);
  view.setBigUint64(24, BigInt(firstSample), false);
  view.setUint32(32, txId >>> 0, false);
  view.setUint32(36, pcm.length * 2, false);
  for (let i = 0; i < pcm.length; i++) view.setInt16(40 + i * 2, pcm[i], true);
  return wire;
}

// ---- resampler math ----
const in8k = new Int16Array([0, 1000, -1000, 32767, -32768, 500]);
const out48k = upsample8kTo48k(in8k);
check("upsample ratio is exactly 6x", out48k.length === in8k.length * 6, `got ${out48k.length}`);
check("first output sample equals first input sample", out48k[0] === in8k[0]);
check("last output sample equals last input sample (edge hold)", out48k[out48k.length - 1] === in8k[in8k.length - 1]);
// Interpolated points must lie between their two neighbours (monotone segment).
let monotoneOk = true;
for (let i = 0; i < in8k.length - 1; i++) {
  const a = in8k[i], b = in8k[i + 1];
  const lo = Math.min(a, b), hi = Math.max(a, b);
  for (let j = 0; j < 6; j++) {
    const v = out48k[i * 6 + j];
    if (v < lo - 1 || v > hi + 1) monotoneOk = false; // +-1 for rounding
  }
}
check("every interpolated sample stays within its input segment's range", monotoneOk);

// ---- packet format, round-tripped through the REAL production parser ----
const SAMPLE_RATE = 48000, PACKET_MS = 20, SAMPLES_PER_PACKET = (SAMPLE_RATE * PACKET_MS) / 1000; // 960
const streamId = 0xC0FFEE, txId = 7;
const pcmFull = new Int16Array(SAMPLES_PER_PACKET);
for (let i = 0; i < pcmFull.length; i++) pcmFull[i] = ((i * 37) % 65536) - 32768;

const firstWire = buildTxPacket({ streamId, txId, sequence: 0, sampleRate: SAMPLE_RATE, firstSample: 0, pcm: pcmFull, first: true, last: false });
check(`packet length is 40 + payload, divisible by 12 (production's own constraint)`, (firstWire.length - 40) % 12 === 0 && firstWire.length === 40 + SAMPLES_PER_PACKET * 2, `len=${firstWire.length}`);

let parsed;
try { parsed = parseAud1(firstWire); } catch (e) { check("parseAud1() accepts the built packet", false, e.message); }
if (parsed) {
  check("parseAud1() accepts the built packet", true);
  check("kind is TX_PCM16 (3)", parsed.kind === 3, `kind=${parsed.kind}`);
  check("FIRST flag round-trips", (parsed.flags & 1) === 1, `flags=${parsed.flags}`);
  check("LAST flag is clear on the first packet", (parsed.flags & 2) === 0, `flags=${parsed.flags}`);
  check("streamId round-trips", parsed.streamId === streamId, `${parsed.streamId}`);
  check("txId round-trips", parsed.txId === txId, `${parsed.txId}`);
  check("sampleRate round-trips as 48000", parsed.sampleRate === SAMPLE_RATE, `${parsed.sampleRate}`);
  check("firstSample round-trips", parsed.firstSample === 0n, `${parsed.firstSample}`);
  check("payload sample count matches what was sent", parsed.payload.length === SAMPLES_PER_PACKET * 2, `${parsed.payload.length}`);
  // Decode the PCM16 payload back and compare against pcmFull.
  const view = new DataView(parsed.payload.buffer, parsed.payload.byteOffset, parsed.payload.byteLength);
  let pcmOk = true;
  for (let i = 0; i < pcmFull.length; i++) if (view.getInt16(i * 2, true) !== pcmFull[i]) { pcmOk = false; break; }
  check("PCM16 payload bytes decode back to the exact samples sent", pcmOk);
}

// A short final packet (padded to SAMPLES_PER_PACKET in worker.js, since the
// wire format has no "partial packet" concept) with LAST set and a nonzero
// firstSample continuing the sequence.
const lastWire = buildTxPacket({
  streamId, txId, sequence: 5, sampleRate: SAMPLE_RATE,
  firstSample: 5 * SAMPLES_PER_PACKET, pcm: pcmFull, first: false, last: true,
});
const parsedLast = parseAud1(lastWire);
check("LAST flag set and FIRST clear on the final packet", (parsedLast.flags & 3) === 2, `flags=${parsedLast.flags}`);
check("firstSample advances by one packet's worth of samples per sequence step",
  parsedLast.firstSample === BigInt(5 * SAMPLES_PER_PACKET));

console.log(failures === 0 ? "PASS: TX packet builder produces wire frames the real AUD1 parser accepts"
                            : `FAIL: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
