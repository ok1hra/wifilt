"use strict";
const SINGLES = {
  "base":        {opts: {}},
  "O1 stop":     {opts: {stopCheck: true}},
  "O2 hold":     {opts: {startHold: 0.33}},
  "O3 int":      {opts: {sample: "integrate", intFrac: 0.7}},
  "O4 N141":     {opts: {windowSize: 141}},
  "O4 N176":     {opts: {windowSize: 176}},
  "O4 N188":     {opts: {windowSize: 188}},
  "O4 hann141":  {opts: {windowSize: 141, window: "hann"}},
  "O4 hann188":  {opts: {windowSize: 188, window: "hann"}},
  "O5 atc":      {opts: {decision: "atc"}},
  "O5 atc4":     {opts: {decision: "atc", atcDecayBits: 4}},
  "O5 markonly": {opts: {decision: "markonly"}},
  "O7 dpll":     {opts: {dpll: true}},
  "O8 clip":     {opts: {limiter: "clip"}},
  "O8 nb":       {opts: {limiter: "nb"}},
  "O8 bpf+clip": {opts: {preBpf: 255, limiter: "clip"}},
  "O9 bpf":      {opts: {preBpf: 255}},
  "O12 usos":    {opts: {usos: true}},
};
module.exports = {SINGLES};
