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
  squelchThreshold: 4,
});
let decoded = "";
decoder.onChar(ch => { decoded += ch; });
decoder.pushSamples(Float32Array.from(encoded, sample => sample / 32767));
assert.strictEqual(decoded, integrationText,
  `acquired offset did not restore decoding: ${JSON.stringify(decoded)}`);

console.log("RTTY AFC smoke: PASS");
