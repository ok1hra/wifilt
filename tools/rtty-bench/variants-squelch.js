"use strict";
// O6 (noise-referenced squelch) and O11 (soft-confidence suppression) against
// today's absolute-magnitude squelch (threshold 4 = RttySettings default).
module.exports = {
  "SQL off (paletka)":   {opts: {}},
  "SQL abs 4 (dnes)":    {opts: {squelchThreshold: 4}},
  "O6 snrmin 3 dB":      {opts: {sql: {type: "snrmin", thDb: 3}}},
  "O6 snrmin 6 dB":      {opts: {sql: {type: "snrmin", thDb: 6}}},
  "O6 oob 3 dB":         {opts: {sql: {type: "oob", thDb: 3}}},
  "O6 oob 6 dB":         {opts: {sql: {type: "oob", thDb: 6}}},
  "O1 stop":             {opts: {stopCheck: true}},
  "O11 conf 0.2":        {opts: {stopCheck: true, confMin: 0.2}},
  "O11 conf 0.35":       {opts: {stopCheck: true, confMin: 0.35}},
  "O11 conf 0.5":        {opts: {stopCheck: true, confMin: 0.5}},
};
