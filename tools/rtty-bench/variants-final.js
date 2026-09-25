"use strict";
// The recommended set with the noise-referenced squelch, against what runs today.
const C = {windowSize: 188, window: "hann", decision: "atc", atcDecayBits: 4, limiter: "nb", usos: true};
module.exports = {
  "dnes: SQL off (paletka)": {opts: {}},
  "dnes: SQL abs 4 (stránka)": {opts: {squelchThreshold: 4}},
  "C bez SQL":               {opts: C},
  "C + SQL snrmin 3 dB":     {opts: Object.assign({}, C, {sql: {type: "snrmin", thDb: 3}})},
  "C + SQL snrmin 2 dB":     {opts: Object.assign({}, C, {sql: {type: "snrmin", thDb: 2}})},
};
