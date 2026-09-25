"use strict";
// Winners of the singles run stacked, tuned on probe seeds 101/102 only
// (the bench measures seeds 1-3), plus O10 multi-decoder diversity.
const A = {windowSize: 188, window: "hann", decision: "atc", atcDecayBits: 4};
const C = Object.assign({}, A, {limiter: "nb", usos: true});
module.exports = {
  "base":                 {opts: {}},
  "A hann188+atc4":       {opts: A},
  "B A+nb":               {opts: Object.assign({}, A, {limiter: "nb"})},
  "C A+nb+usos":          {opts: C},
  "D C+stop":             {opts: Object.assign({}, C, {stopCheck: true})},
  "E C+dpll":             {opts: Object.assign({}, C, {dpll: true})},
  "O10 C x3 ladeni":      {multi: [-10, 0, 10].map(d => Object.assign({}, C, {toneHz: 1500 + d}))},
  "O10 C+N96+h141":       {multi: [C, Object.assign({}, C, {windowSize: 96, window: "rect"}),
                                   Object.assign({}, C, {windowSize: 141})]},
};
