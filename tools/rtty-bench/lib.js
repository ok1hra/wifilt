"use strict";
const {ProtoDecoder, MultiDecoder} = require("./proto-decoder.js");

function levenshtein(a, b) {
  const n = a.length, m = b.length;
  if (!n) return m; if (!m) return n;
  let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const c = ai === b.charCodeAt(j - 1) ? 0 : 1;
      let v = prev[j - 1] + c;
      if (prev[j] + 1 < v) v = prev[j] + 1;
      if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
      cur[j] = v;
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[m];
}

// variant: {opts} for a single decoder or {multi:[opts...]}
function decode(samples, variant) {
  if (variant.prod) {
    // the real data/rtty-codec.js Decoder, whatever it currently is
    const RttyCodec = require("../../data/rtty-codec.js");
    const d = new RttyCodec.Decoder(8000, variant.prod);
    let out = "";
    d.onChar(ch => { out += ch; });
    for (let i = 0; i < samples.length; i += 960) d.pushSamples(samples.subarray(i, i + 960));
    return out;
  }
  if (variant.multi) {
    const md = new MultiDecoder(8000, variant.multi);
    for (let i = 0; i < samples.length; i += 960) md.pushSamples(samples.subarray(i, i + 960));
    return md.text();
  }
  const d = new ProtoDecoder(8000, variant.opts || {});
  let out = "";
  d.onChar = ch => { out += ch; };
  for (let i = 0; i < samples.length; i += 960) d.pushSamples(samples.subarray(i, i + 960));
  return out;
}

// CER capped at 1 so a flood of garbage insertions can't push it past 100 %
function cer(expected, got) {
  return Math.min(1, levenshtein(expected, got) / expected.length);
}

module.exports = {levenshtein, decode, cer};

// Same as decode() plus the median O6 SNR estimate over emitted characters.
function decodeDetailed(samples, variant) {
  if (variant.multi || variant.prod) return {text: decode(samples, variant), snrEst: null};
  const d = new ProtoDecoder(8000, variant.opts || {});
  let out = "";
  const est = [];
  d.onChar = (ch, m) => { out += ch; if (Number.isFinite(m.snrEstDb)) est.push(m.snrEstDb); };
  for (let i = 0; i < samples.length; i += 960) d.pushSamples(samples.subarray(i, i + 960));
  est.sort((a, b) => a - b);
  return {text: out, snrEst: est.length ? est[est.length >> 1] : null};
}
module.exports.decodeDetailed = decodeDetailed;
