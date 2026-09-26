#!/usr/bin/env node
"use strict";

const assert = require("assert");
const RttyAfc = require("../data/rtty-afc.js");
const RttyCodec = require("../data/rtty-codec.js");
const RttySettings = require("../data/rtty-settings.js");
const Spectrum = require("../data/spectrum.js");

const LOW_HZ = 500, HIGH_HZ = 2700;
const CENTRE_HZ = 1500, SHIFT_HZ = RttyCodec.SHIFT_HZ;
const MARK_HZ = CENTRE_HZ + SHIFT_HZ / 2;
const SPACE_HZ = CENTRE_HZ - SHIFT_HZ / 2;

function syntheticSpectrum(offsetHz, {mark = true, space = true,
                           lowHz = LOW_HZ, highHz = HIGH_HZ} = {}) {
  const values = new Float32Array(highHz - lowHz + 1);
  values.fill(-100);
  for (const enabledAndHz of [[mark, MARK_HZ + offsetHz], [space, SPACE_HZ + offsetHz]]) {
    if (!enabledAndHz[0]) continue;
    const peakHz = enabledAndHz[1];
    for (let dx = -2; dx <= 2; dx++)
      values[Math.round(peakHz + dx - lowHz)] = -10 - 3 * Math.abs(dx);
  }
  return values;
}

function find(values, maxDeviationHz = 180, lowHz = LOW_HZ, highHz = HIGH_HZ) {
  return RttyAfc.findOffset(values, {
    lowHz,
    highHz,
    markHz: MARK_HZ,
    spaceHz: SPACE_HZ,
    maxDeviationHz,
    prominenceDb: 8,
  });
}

for (const offsetHz of [-170, -120, -86, -60, 0, 60, 86, 120, 170]) {
  const found = find(syntheticSpectrum(offsetHz));
  assert.notStrictEqual(found, null, `paired carrier at ${offsetHz} Hz was not acquired`);
  assert.ok(Math.abs(found - offsetHz) <= 1,
    `paired carrier at ${offsetHz} Hz acquired as ${found} Hz`);
}

assert.strictEqual(find(syntheticSpectrum(120, {space: false})), null,
  "a lone carrier must not create an ambiguous wide-range lock");
assert.strictEqual(find(new Float32Array(HIGH_HZ - LOW_HZ + 1).fill(-100)), null,
  "a flat noise floor must not create a lock");
assert.strictEqual(RttyAfc.nextTarget(0, 120, false), 120,
  "a paired acquisition must override the detuned decoder's closed squelch");
assert.strictEqual(RttyAfc.nextTarget(75, null, true), 75,
  "an idle carrier with open squelch must hold the established lock");
assert.strictEqual(RttyAfc.nextTarget(75, null, false), 0,
  "no pair and closed squelch must spring back to centre");

const zoomLowHz = CENTRE_HZ - 275, zoomHighHz = CENTRE_HZ + 275;
for (const offsetHz of [-180, 180]) {
  const values = syntheticSpectrum(offsetHz, {lowHz: zoomLowHz, highHz: zoomHighHz});
  const found = find(values, 180, zoomLowHz, zoomHighHz);
  assert.notStrictEqual(found, null, `400% zoom did not acquire ${offsetHz} Hz`);
  assert.ok(Math.abs(found - offsetHz) <= 1,
    `400% zoom acquired ${offsetHz} Hz as ${found} Hz`);
}

assert.strictEqual(RttySettings.AFC_MAX_DEVIATION_HARD_CAP_HZ, 180,
  "the operator-visible AFC range must cover at least one complete shift");
assert.strictEqual(RttySettings.normalize({
  ...RttySettings.defaults(), afcMaxDeviationHz: 120,
}).afcMaxDeviationHz, 120, "an offset above half a shift must survive settings validation");

function fftValuesForText(text, offsetHz, amplitude = 0.5) {
  const canvas = {getContext: () => ({}), parentNode: {}};
  const waterfall = new Spectrum.Waterfall({
    canvas, container: {}, sampleRate: 8000,
    lowHz: LOW_HZ, highHz: HIGH_HZ,
  });
  const encoded = new RttyCodec.Encoder(8000, {
    toneHz: CENTRE_HZ + offsetHz,
    amplitude,
  }).encode(text);
  const pcm = Float32Array.from(encoded, sample => sample / 32767);
  waterfall.ring.set(pcm.slice(-waterfall.fftSize));
  waterfall.ringPos = 0;
  waterfall.fill = waterfall.fftSize;
  return waterfall.extractValues();
}

const integrationText = "RYRYRYRYRY";
const integrationOffsetHz = 120;
const acquiredHz = find(fftValuesForText(integrationText, integrationOffsetHz));
assert.notStrictEqual(acquiredHz, null, "real RTTY FFT did not acquire both carriers");
assert.ok(Math.abs(acquiredHz - integrationOffsetHz) <= 10,
  `real RTTY FFT offset error is too large: ${acquiredHz} Hz`);

const encoded = new RttyCodec.Encoder(8000, {
  toneHz: CENTRE_HZ + integrationOffsetHz,
  amplitude: 0.5,
}).encode(integrationText);
const decoder = new RttyCodec.Decoder(8000, {
  toneHz: CENTRE_HZ + acquiredHz,
  squelchDb: 3,
});
let decoded = "";
decoder.onChar(ch => { decoded += ch; });
// 0.2 s of silence first: the decoder's 23.5 ms window has to be full before
// it can place a start-bit edge, and on the air it always is -- it runs
// continuously. Only a decoder born on the very first sample of a signal
// that keys straight into a start bit (as this Encoder does) misses it.
decoder.pushSamples(new Float32Array(1600));
decoder.pushSamples(Float32Array.from(encoded, sample => sample / 32767));
assert.strictEqual(decoded, integrationText,
  `acquired offset did not restore decoding: ${JSON.stringify(decoded)}`);

// ---- AUTOTUNE buffer (QRPLog palette, kap. 23) -----------------------------
{
  const {AUTOTUNE, summarizeOffsets, createAutotune} = RttyAfc;
  const STEP = AUTOTUNE.sampleIntervalMs;
  let clock = 100000;
  const at = createAutotune({now: () => clock});
  const tick = (hz, ms = STEP) => { at.observe(hz); clock += ms; };
  const feed = list => list.forEach(hz => tick(hz));

  assert.deepStrictEqual(at.decide(), {action: "none", offsetHz: null},
    "nothing synced must not tune");
  tick(null);
  assert.strictEqual(at.summary().count, 0, "a frame without a pair is not a sample");

  // Decimation: the live tap delivers a frame every 16 ms; only one per
  // sampleIntervalMs is taken, and a frame without a pair does not use the slot.
  const start = clock;
  for (let i = 0; i < 40; i++) tick(40, 16);
  assert.strictEqual(at.summary().count, 2,
    `640 ms of 16 ms frames are two samples, not forty: ${at.summary().count}`);
  at.clear(0);
  clock = start;

  // THE requirement: no sync in under 2 s of steady signal, sync at 2 s.
  let syncedAfterMs = null;
  for (let ms = 0; ms <= 4000; ms += 16) {
    at.observe(40);
    if (syncedAfterMs === null && at.summary().synced) syncedAfterMs = ms;
    clock += 16;
  }
  assert.ok(syncedAfterMs >= 2000 && syncedAfterMs < 2100,
    `a steady signal syncs after 2 s, not before: ${syncedAfterMs} ms`);
  at.clear(0);

  feed([41, 39, 40, 41]);
  assert.ok(!at.summary().synced, "four samples (1.5 s) are not a sync yet");
  tick(95);   // one frame on a neighbour
  assert.ok(!at.summary().synced, "an outlier does not count towards a sync");
  tick(42);
  let s = at.summary();
  assert.ok(s.synced && s.syncHz === 41,
    `five within ±${AUTOTUNE.toleranceHz} Hz sync, the outlier ignored: ${JSON.stringify(s)}`);
  tick(-120);
  assert.ok(at.summary().synced, "a noise frame after a sync does not drop it");

  for (let i = 0; i < 20; i++) tick(40);
  assert.strictEqual(at.summary().count, AUTOTUNE.maxSamples, "the buffer is capped");

  clock += AUTOTUNE.maxAgeMs + 1;   // the station stopped; only noise since
  feed([7, -60, 130]);
  s = at.summary();
  assert.ok(!s.synced && s.lastSyncHz === 40,
    `with the signal gone it is no longer synced, but the last sync is kept: ${JSON.stringify(s)}`);
  assert.deepStrictEqual(at.decide(), {action: "tune", offsetHz: 40},
    "a press applies the last sync");

  feed([-30, -32, -31, -31, -30]);
  assert.strictEqual(at.decide().offsetHz, -31, "a new sync replaces the old one");

  at.clear(AUTOTUNE.holdoffMs);
  assert.strictEqual(at.summary().lastSyncHz, null, "a dial move forgets the last sync");
  tick(40, AUTOTUNE.holdoffMs / 2);
  assert.strictEqual(at.summary().count, 0, "frames inside the holdoff are ignored");
  clock += AUTOTUNE.holdoffMs;
  feed([3, -2, 1, 2, 0]);
  assert.strictEqual(at.decide().action, "on-mark",
    `under ${AUTOTUNE.deadBandHz} Hz the dial is left alone`);

  assert.deepStrictEqual(summarizeOffsets([], {nowMs: 0}),
    {count: 0, synced: false, syncHz: null});
  assert.strictEqual(summarizeOffsets([10, 20, 12, 18].map(hz => ({t: 0, hz})),
    {nowMs: 0, stableCount: 4}).syncHz, 15,
    "an even cluster takes the mean of the middle two");
}

console.log("RTTY AFC smoke: PASS");
