#!/usr/bin/env node
// DEC 1 vs DEC 2 on real air: scores the two RTTY decoders' recorded streams
// (tools/rtty-stream-record.py) against the QSOs actually logged.
//
// Grilled 2026-09-28. Only what the log can verify is scored: the worked
// station's CALLSIGN, and for W/VE the two-letter STATE/PROVINCE of its
// exchange. Everything else a decoder prints is unverifiable and ignored.
//
//   node tools/rtty-bench/stream-score.js <recordings dir> <log.csv> [out.json]
//
// Words are what the operator could CLICK: the recording is replayed through
// the real data/rtty-rxlog.js (the palette's tape) under a small DOM stand-in,
// and every word is read back through the tape's own click handler. The stream
// carries no sample times, so each character's `t` is reconstructed from its
// packet's arrival (one Baudot character, ~165 ms, apart, ending at arrival):
// the tape's row layout is therefore only approximate -- the words are not,
// they depend on the character order alone. A parallel tokenizer here gives
// each word its time; it is checked word for word against the tape's.
//
// Windows, anchored on this station's own transmissions (ev:"tx"):
//   RUN  CALL window = RX in the 40 s before our first exch to the station
//                      ("W1FM W1FM 599-15-15") -- a station often calls over
//                      two CQs, or over the previous QSO's end;
//        EXCH window = RX from there up to our "W1FM tu OK1HRA".
//        That first exch may carry a WRONG word the operator clicked and then
//        corrected before the "tu" (XE2WD for XE2AD) or aborted
//        (TESTSNOVZW4PJW): recorded, with which decoder showed that word.
//   S&P  CALL window = RX in the 30 s before our first "OK1HRA OK1HRA";
//        EXCH window = RX from there up to our "W1FM 599-15-15".
// Per decoder and window: EXACT (a clickable word == the call), EMBED (the
// call inside a longer word), NEAR (a callsign-shaped word one edit away),
// NONE. State: EXACT = a word \d*XX.
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const [dir, csvPath, outPath] = process.argv.slice(2);
if (!dir || !csvPath) {
  console.error("usage: stream-score.js <recordings dir> <log.csv> [out.json]");
  process.exit(2);
}

const CHAR_S = 7.5 / 45.45;          // one Baudot character, seconds
const RATE = 8000;                   // the decoders' sample rate (rtty-rxlog.js)
const SLACK_S = 0.6;                 // a feed batch is up to 500 ms old on arrival
const SP_BEFORE_S = 30;
const CALL_BEFORE_S = 40;            // RUN call window: RX this long before our exch
const MY_CALL = "OK1HRA";
const RXLOG = process.env.RXLOG || path.join(__dirname, "..", "..", "data", "rtty-rxlog.js");

// ---- a DOM just deep enough for rtty-rxlog.js --------------------------------
class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parentNode = null;
    this._cls = new Set(); this.dataset = {}; this._text = ""; this.hidden = false;
    this.style = {setProperty() {}, removeProperty() {}};
    this.listeners = {}; this.scrollTop = 0; this.scrollHeight = 0; this.clientWidth = 0;
    const self = this;
    this.classList = {
      add: (...c) => c.forEach(x => self._cls.add(x)),
      remove: (...c) => c.forEach(x => self._cls.delete(x)),
      toggle: (c, on) => { if (on === undefined ? !self._cls.has(c) : on) self._cls.add(c); else self._cls.delete(c); },
      contains: c => self._cls.has(c),
    };
  }
  get className() { return [...this._cls].join(" "); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = String(v); }
  _detach(c) { if (c.parentNode) c.parentNode.removeChild(c); }
  appendChild(c) { this._detach(c); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    this._detach(c); c.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, c);
    return c;
  }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  setAttribute() {}
  addEventListener(type, fn) { this.listeners[type] = fn; }
  removeEventListener() {}
  getBoundingClientRect() { return {width: 0}; }
  querySelectorAll() { return []; }
  closest(sel) {
    const cls = sel.replace(/^\./, "");
    for (let n = this; n; n = n.parentNode) if (n._cls && n._cls.has(cls)) return n;
    return null;
  }
  get isConnected() { return true; }
}
globalThis.document = {
  createElement: tag => new El(tag),
  createTextNode: text => { const n = new El("#text"); n._text = text; return n; },
  documentElement: new El("html"),
};
globalThis.RttyCodec = {charStartTimes: () => []};   // echo lighting only
const RttyRxLog = require(RXLOG);

// ---- input -------------------------------------------------------------------
function readJsonl(file) {
  const raw = fs.readFileSync(file);
  const text = file.endsWith(".gz") ? zlib.gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return text.split("\n").filter(Boolean).map(l => JSON.parse(l));
}

function readCsv(file) {
  const lines = fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(",");
  return lines.slice(1).map(l => {
    const v = l.split(",");
    return Object.fromEntries(head.map((h, i) => [h, v[i] || ""]));
  });
}

const files = fs.readdirSync(dir).filter(f => /_rtty[12]\.jsonl(\.gz)?$/.test(f)).sort();
const packets = [];            // {t, s, text}
const txs = [];                // {t, text}
const aborts = [];             // times of ev:"tx-abort"
const gaps = {1: 0, 2: 0}, pkts = {1: 0, 2: 0};
const txSeen = new Set();
for (const f of files) {
  const s = /_rtty1\./.test(f) ? 1 : 2;
  for (const x of readJsonl(path.join(dir, f))) {
    if (x.ev === "tx") {
      const key = x.t + "|" + x.seq;
      if (!txSeen.has(key)) { txSeen.add(key); txs.push({t: x.t, text: x.text}); }
    } else if (x.ev === "tx-abort") {
      aborts.push(x.t);
    } else if (!x.ev && typeof x.text === "string") {
      packets.push({t: x.t, s, text: x.text});
      pkts[s]++; gaps[s] += x.gap || 0;
    }
  }
}
txs.sort((a, b) => a.t - b.t);

// Characters with reconstructed times, both decoders merged in time order.
const chars = [];
const lastT = {1: -Infinity, 2: -Infinity};
for (const p of packets) {
  const n = p.text.length;
  for (let i = 0; i < n; i++) {
    let t = p.t - (n - 1 - i) * CHAR_S;
    if (t <= lastT[p.s]) t = lastT[p.s] + 1e-3;
    lastT[p.s] = t;
    chars.push({t, s: p.s, ch: p.text[i]});
  }
}
const timeline = chars.map(c => ({kind: "c", ...c}))
  .concat(txs.map(x => ({kind: "e", t: x.t, text: x.text})))
  .sort((a, b) => a.t - b.t || (a.kind === "e") - (b.kind === "e"));

// ---- replay through the palette's tape -----------------------------------------
const el = new El("div");
let clicked = null;
const tape = RttyRxLog.create({
  el, maxChars: Infinity, dual: true, columnChars: 40,
  floorRgb: [100, 100, 100], onToken: word => { clicked = word; },
});
const T0 = timeline.length ? timeline[0].t : 0;
const isBlank = ch => ch === " " || ch === "\n" || ch === "\r";
const words = [];              // mine: {id, s, word, t0, t1}
const open = {1: null, 2: null};
let nextId = 1;
for (const e of timeline) {
  if (e.kind === "e") {
    tape.echoTx(e.text);
    open[1] = open[2] = null;
    continue;
  }
  tape.pushChar(e.ch, {stream: e.s, t: (e.t - T0) * RATE});
  if (isBlank(e.ch)) { open[e.s] = null; continue; }
  if (!open[e.s]) { open[e.s] = {id: nextId++, s: e.s, word: "", t0: e.t, t1: e.t}; words.push(open[e.s]); }
  open[e.s].word += e.ch;
  open[e.s].t1 = e.t;
}

// Read every word back through the tape's own click handler.
const tapeWords = new Map();   // tok id -> {word, s}
const body = el.children.find(c => c._cls.has("rtty-tape-body"));
for (const row of body.children) {
  row.children.forEach((cell, ci) => {
    for (const span of cell.children) {
      const id = Number(span.dataset.tok);
      if (!id || tapeWords.has(id)) continue;
      clicked = null;
      el.listeners.click({target: span});
      tapeWords.set(id, {word: clicked, s: ci + 1});
    }
  });
}
let mismatches = 0;
for (const w of words) {
  const tw = tapeWords.get(w.id);
  if (!tw || tw.word !== w.word.trim() || tw.s !== w.s) {
    if (++mismatches <= 5) console.error("tokenizer mismatch", w, tw);
  }
}
if (mismatches || tapeWords.size !== words.length) {
  console.error(`tape words ${tapeWords.size}, mine ${words.length}, mismatches ${mismatches}`);
  process.exit(1);
}

// ---- scoring -------------------------------------------------------------------
function lev(a, b) {
  const d = Array.from({length: a.length + 1}, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const callShaped = w => /^[A-Z0-9/]{3,12}$/.test(w) && /\d/.test(w) && /[A-Z]/.test(w);

// words by start time, for window lookups
const wordsByT = words.slice().sort((a, b) => a.t0 - b.t0);
function wordsIn(s, a, b) {
  let lo = 0, hi = wordsByT.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (wordsByT[m].t0 < a) lo = m + 1; else hi = m; }
  const out = [];
  for (let i = lo; i < wordsByT.length && wordsByT[i].t0 <= b; i++) if (wordsByT[i].s === s) out.push(wordsByT[i]);
  return out;
}
const charsSorted = chars.slice().sort((a, b) => a.t - b.t);
function textIn(s, a, b) {
  let lo = 0, hi = charsSorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (charsSorted[m].t < a) lo = m + 1; else hi = m; }
  let out = "";
  for (let i = lo; i < charsSorted.length && charsSorted[i].t <= b; i++)
    if (charsSorted[i].s === s) out += charsSorted[i].ch;
  return out.replace(/\r/g, "").replace(/\n/g, " ⏎ ").replace(/ +/g, " ").trim();
}

function scoreCall(ws, call) {
  const exact = ws.filter(w => w.word === call);
  const embed = ws.filter(w => w.word !== call && w.word.includes(call));
  const near = ws.filter(w => w.word !== call && !w.word.includes(call) && callShaped(w.word) && lev(w.word, call) === 1);
  const cls = exact.length ? "EXACT" : embed.length ? "EMBED" : near.length ? "NEAR" : "NONE";
  return {cls, exact: exact.length, first: exact.length ? exact[0].t0 : null,
    embed: [...new Set(embed.map(w => w.word))], near: [...new Set(near.map(w => w.word))]};
}
function scoreState(ws, st) {
  const re = new RegExp("^\\d*" + st + "$");
  const exact = ws.filter(w => re.test(w.word));
  return {cls: exact.length ? "EXACT" : "NONE", exact: exact.length, first: exact.length ? exact[0].t0 : null};
}

// A transmission ends when its text has gone out -- or when it was aborted.
const txEnd = x => {
  const full = x.t + (x.text.length + 2) * CHAR_S;
  const cut = aborts.find(a => a > x.t && a < full);
  return cut !== undefined ? cut : full;
};
const txWords = x => x.text.toUpperCase().split(/\s+/).filter(Boolean);
const names = (x, call) => txWords(x).includes(call);
const isSpCall = x => x.text.trim() === `${MY_CALL} ${MY_CALL}`;
const isTu = (x, call) => names(x, call) && txWords(x).includes("TU");
const band = hz => hz < 8e6 ? "40m" : hz < 15e6 ? "20m" : hz < 22e6 ? "15m" : hz < 30e6 ? "10m" : "?";

// The call we actually sent, when it differs from the log: the TX nearest the
// logged minute whose call is 1-2 edits from the logged one.
function sentCall(logT, call) {
  const near = txs.filter(x => x.t >= logT - 300 && x.t <= logT + 90);
  if (near.some(x => names(x, call))) return call;
  let best = null;
  for (const x of near) {
    for (const w of txWords(x)) {
      if (w === MY_CALL || !callShaped(w)) continue;
      const d = lev(w, call);
      if (d <= 2 && (!best || d < best.d)) best = {w, d};
    }
  }
  return best ? best.w : null;
}

// Our exch was aimed at this station: its call, one to two edits off it (a
// wrong word clicked), or glued into a longer word (TESTSNOVZW4PJW).
const aimedAt = (w, call) => w === call || lev(w, call) <= 2 || w.includes(call) ||
  (call.length >= 4 && w.length > call.length && w.startsWith(call.slice(0, 3)));

const qsos = readCsv(csvPath);
const results = [];
const skipped = {noTx: 0};
for (const q of qsos) {
  const call = q.call.toUpperCase();
  const logT = Date.parse(`${q.dateUtc}T${q.timeUtc}:00Z`) / 1000;
  const sent = sentCall(logT, call);
  if (!sent) { skipped.noTx++; continue; }
  const inRange = txs.filter(x => x.t >= logT - 600 && x.t <= logT + 90);
  const tu = inRange.filter(x => isTu(x, sent)).pop() || null;
  let mode, callWin, exchWin, exchTx, firstSent = null, aborted = false;
  if (tu) {
    // RUN. Our exchange(s) to this station before the "tu" -- also the ones
    // sent with a wrong or glued call the operator then corrected or aborted.
    // ...but not an exch to ANOTHER station worked meanwhile (its own "tu").
    // Nor a word closer to another call logged around the same time.
    const others = qsos.filter(o => o.call.toUpperCase() !== call &&
      Math.abs(Date.parse(`${o.dateUtc}T${o.timeUtc}:00Z`) / 1000 - logT) <= 300).map(o => o.call.toUpperCase());
    const ownQso = w => w !== sent && (txs.some(y => Math.abs(y.t - tu.t) < 300 && isTu(y, w)) ||
      others.some(c => c === w || lev(w, c) < lev(w, sent)));
    const cands = txs.filter(x => x.t >= tu.t - 240 && x.t < tu.t && /599/.test(x.text) &&
      aimedAt(txWords(x)[0] || "", sent) && !ownQso(txWords(x)[0]));
    if (!cands.length) { skipped.noTx++; continue; }
    exchTx = cands[0];
    mode = "RUN";
    firstSent = txWords(exchTx)[0];
    aborted = cands.some(x => txEnd(x) < x.t + (x.text.length + 2) * CHAR_S - 0.01);
    callWin = [exchTx.t - CALL_BEFORE_S, exchTx.t + SLACK_S];
    exchWin = [txEnd(exchTx), tu.t + SLACK_S];
  } else {
    // S&P: our "OK1HRA OK1HRA" chain, then our exch naming the station.
    exchTx = inRange.filter(x => names(x, sent) && /599/.test(x.text))[0];
    if (!exchTx) { skipped.noTx++; continue; }
    const i = txs.indexOf(exchTx);
    let j = i - 1;
    while (j >= 0 && isSpCall(txs[j]) && exchTx.t - txs[j].t < 180) j--;
    const spFirst = j + 1 < i ? txs[j + 1] : null;
    if (!spFirst || !isSpCall(spFirst)) { skipped.noTx++; continue; }
    mode = "S&P";
    const prev = txs[j];
    callWin = [Math.max(prev ? txEnd(prev) : -Infinity, spFirst.t - SP_BEFORE_S), spFirst.t + SLACK_S];
    exchWin = [txEnd(txs[i - 1]), exchTx.t + SLACK_S];
  }
  const st = (/(?:^|\s|\d)([A-Z]{2})$/.exec(q.exchangeReceived.trim().toUpperCase()) || [])[1] || null;
  const win = ([a, b], s, fn) => fn(wordsIn(s, a, b));
  const r = {
    n: Number(q.qsoNumber), date: q.dateUtc, time: q.timeUtc, call, sent: sent === call ? null : sent,
    band: band(Number(q.frequencyHz)), country: q.country, mode, state: st,
    callWin, exchWin, firstSent, aborted,
    // a first exch sent with a word other than the call: which decoder showed that word
    wrongFirst: firstSent && firstSent !== call ? {
      word: firstSent,
      dec1: wordsIn(1, ...callWin).some(w => w.word === firstSent),
      dec2: wordsIn(2, ...callWin).some(w => w.word === firstSent),
    } : null,
    callEmpty: !wordsIn(1, ...callWin).length && !wordsIn(2, ...callWin).length,
    call1: win(callWin, 1, ws => scoreCall(ws, call)),
    call2: win(callWin, 2, ws => scoreCall(ws, call)),
    xcall1: win(exchWin, 1, ws => scoreCall(ws, call)),
    xcall2: win(exchWin, 2, ws => scoreCall(ws, call)),
    text: {call1: textIn(1, ...callWin), call2: textIn(2, ...callWin),
      exch1: textIn(1, ...exchWin), exch2: textIn(2, ...exchWin)},
  };
  if (st) {
    r.st1 = win(exchWin, 1, ws => scoreState(ws, st));
    r.st2 = win(exchWin, 2, ws => scoreState(ws, st));
  }
  results.push(r);
}

// ---- summary -------------------------------------------------------------------
function mcnemar(b, c) {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let p = 0, coef = 1;
  for (let i = 0; i <= k; i++) { if (i) coef = coef * (n - i + 1) / i; p += coef; }
  return Math.min(1, 2 * p / Math.pow(2, n));
}
function table(rows, a, b) {
  const t = {both: 0, only1: 0, only2: 0, neither: 0};
  for (const r of rows) {
    const x = r[a].cls === "EXACT", y = r[b].cls === "EXACT";
    t[x && y ? "both" : x ? "only1" : y ? "only2" : "neither"]++;
  }
  t.n = rows.length;
  t.p = mcnemar(t.only1, t.only2);
  return t;
}
function classes(rows, k) {
  const c = {EXACT: 0, EMBED: 0, NEAR: 0, NONE: 0};
  rows.forEach(r => c[r[k].cls]++);
  return c;
}
const scored = results.filter(r => !r.callEmpty);
const withState = results.filter(r => r.st1);
const anyExact = (r, a, b) => r[a].cls === "EXACT" || r[b].cls === "EXACT";
const combined = scored.map(r => ({
  c1: {cls: anyExact(r, "call1", "xcall1") ? "EXACT" : "NONE"},
  c2: {cls: anyExact(r, "call2", "xcall2") ? "EXACT" : "NONE"},
}));
const conflict = scored.filter(r =>
  (r.call1.cls === "EXACT" && r.call2.cls !== "EXACT" && r.call2.near.length) ||
  (r.call2.cls === "EXACT" && r.call1.cls !== "EXACT" && r.call1.near.length));
const nearAny = k => scored.filter(r => r[k].near.length).length;
const firsts = {dec1: 0, dec2: 0, same: 0};
for (const r of scored) {
  if (r.call1.first === null || r.call2.first === null) continue;
  const d = r.call1.first - r.call2.first;
  firsts[Math.abs(d) < 0.5 ? "same" : d < 0 ? "dec1" : "dec2"]++;
}
const bands = {};
for (const r of scored) (bands[r.band] = bands[r.band] || []).push(r);
const copies = k => scored.reduce((a, r) => a + r[k].exact, 0);

const run = scored.filter(r => r.mode === "RUN"), sp = scored.filter(r => r.mode === "S&P");
const summary = {
  run: {table: table(run, "call1", "call2"), dec1: classes(run, "call1"), dec2: classes(run, "call2"),
    either: table(run.map(r => ({
      c1: {cls: anyExact(r, "call1", "xcall1") ? "EXACT" : "NONE"},
      c2: {cls: anyExact(r, "call2", "xcall2") ? "EXACT" : "NONE"}})), "c1", "c2")},
  sp: {table: table(sp, "call1", "call2"), exch: table(sp, "xcall1", "xcall2")},
  wrongFirst: results.filter(r => r.wrongFirst).map(r => ({n: r.n, call: r.call, ...r.wrongFirst, aborted: r.aborted})),
  data: {files, packets: pkts, gaps, chars: {1: chars.filter(c => c.s === 1).length, 2: chars.filter(c => c.s === 2).length},
    tx: txs.length, words: words.length, tapeWordsChecked: tapeWords.size},
  qsos: qsos.length, matched: results.length, skipped, callWindowEmpty: results.length - scored.length,
  modes: {RUN: scored.filter(r => r.mode === "RUN").length, "S&P": scored.filter(r => r.mode === "S&P").length},
  busts: results.filter(r => r.sent).map(r => ({call: r.call, sent: r.sent})),
  callWindow: {table: table(scored, "call1", "call2"), dec1: classes(scored, "call1"), dec2: classes(scored, "call2"),
    exactCopies: {dec1: copies("call1"), dec2: copies("call2")},
    nearShown: {dec1: nearAny("call1"), dec2: nearAny("call2")}, conflict: conflict.length, firstShown: firsts},
  exchWindowCall: {table: table(scored, "xcall1", "xcall2"), dec1: classes(scored, "xcall1"), dec2: classes(scored, "xcall2")},
  callEitherWindow: table(combined, "c1", "c2"),
  state: {table: table(withState, "st1", "st2"), n: withState.length},
  bands: Object.fromEntries(Object.entries(bands).map(([b, rs]) => [b, table(rs, "call1", "call2")])),
};
console.log(JSON.stringify(summary, null, 2));
if (outPath) fs.writeFileSync(outPath, JSON.stringify({summary, results, conflict: conflict.map(r => r.n)}, null, 1));
