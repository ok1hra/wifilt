"use strict";
// Production decoder (data/rtty-codec.js) against the prototype it was built
// from: must land on the same numbers.
const C = {windowSize: 188, window: "hann", decision: "atc", atcDecayBits: 4, limiter: "nb", usos: true};
module.exports = {
  "proto C + SQL 3 dB": {opts: Object.assign({}, C, {sql: {type: "snrmin", thDb: 3}})},
  "prod squelchDb 3":   {prod: {squelchDb: 3}},
  "prod squelchDb 0":   {prod: {squelchDb: 0}},
};
