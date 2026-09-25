"use strict";
// Two gates before any measurement counts:
//  1. the bench generator (no channel) is bit-identical to RttyCodec.Encoder
//     (which re-sends FIGS after a space since §20, hence txUsos = true)
//  2. ProtoDecoder with default switches == the FROZEN pre-§20 decoder
//     (baseline-rtty-codec.js), char for char, on noisy scenarios of every
//     channel kind (and with its abs squelch on) -- that is what "base" means
//     in every result file
const assert = require("assert");
const RttyCodec = require("../../data/rtty-codec.js");
const Baseline = require("./baseline-rtty-codec.js");
const C = require("./channel.js");
const {ProtoDecoder} = require("./proto-decoder.js");

// ---- gate 1 ----
{
  const text = "CQ TEST OK1HRA 599 001 K";
  const enc = new RttyCodec.Encoder(8000, {toneHz: 1500}).encode(text);
  const {frames} = C.overToFrames(text, "L", true);
  const g = C.synthFsk(C.fskSegments(frames), {toneHz: 1500, amp: 0.5});
  let pad = (6 - (g.pcm.length % 6)) % 6;
  assert.strictEqual(enc.length, g.pcm.length + pad, "length");
  for (let i = 0; i < g.pcm.length; i++) {
    const s = Math.max(-32768, Math.min(32767, Math.round(g.pcm[i] * 32767)));
    assert.strictEqual(s | 0, enc[i], "sample " + i);
  }
  console.log("gate1 generator == RttyCodec.Encoder: OK (" + g.pcm.length + " samples)");
}

// ---- gate 2 ----
const scenarios = [
  {kind: "awgn", snrDb: -12}, {kind: "awgn", snrDb: -6}, {kind: "fade", snrDb: -4, spreadHz: 1},
  {kind: "impulse", snrDb: -8}, {kind: "qrm", snrDb: -8, qrmOffsetHz: 300, qrmRelDb: 6},
  {kind: "cw", snrDb: -8, cwOffsetHz: 145, cwRelDb: 3}, {kind: "noise", seconds: 60},
];
let total = 0;
for (const sc of scenarios) for (const seed of [1, 2]) for (const sq of [0, 4, 0.5]) {
  const {samples} = C.buildScenario(sc, seed, {minChars: 200});
  const a = [], b = [];
  const ref = new Baseline.Decoder(8000, {squelchThreshold: sq});
  ref.onChar(ch => a.push(ch));
  const pro = new ProtoDecoder(8000, {squelchThreshold: sq});
  pro.onChar = ch => b.push(ch);
  // odd block sizes on purpose (decoder must not care)
  for (let i = 0; i < samples.length; i += 333) {
    const blk = samples.subarray(i, i + 333);
    ref.pushSamples(blk); pro.pushSamples(blk);
  }
  assert.strictEqual(b.join(""), a.join(""), JSON.stringify(sc) + " seed " + seed + " sq " + sq);
  total += a.length;
}
console.log("gate2 ProtoDecoder(defaults) == frozen pre-§20 Decoder: OK (" + total + " chars compared)");
