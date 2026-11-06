#!/usr/bin/env node
"use strict";
// VARA HF ARQ (data/vara-modem.js: session, adaptation, timing, text compression,
// busy detector) against x0rro/xara's vectors and tests (crates/xara-arq/tests/*.rs,
// crates/xara-phy/tests/busy.rs), including the golden session transcript
// tests/golden/hf_link.txt. Needs the pinned checkout in xara/ (XARA_DIR overrides).
// docs/vara-implementace.md §4 phase 2.
//
//   node tools/vara-arq-test.js              all groups
//   node tools/vara-arq-test.js golden        only the named groups

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const M = require("../data/vara-modem.js");

const XARA = process.env.XARA_DIR || path.join(__dirname, "..", "xara");
const VEC = path.join(XARA, "vectors");
if (!fs.existsSync(VEC)) {
  console.error("missing " + VEC + " -- clone x0rro/xara at the commit in third_party/xara/README.md");
  process.exit(2);
}

let pass = 0, fail = 0, skipped = 0;
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log("FAIL " + name + (detail !== undefined ? "  " + detail : "")); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const json = rel => JSON.parse(fs.readFileSync(path.join(VEC, rel), "utf8"));
const hex = s => Uint8Array.from(Buffer.from(s, "hex"));
const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0) & 255);
const bwOf = v => M.bandwidth(Number(v));
const C = M.CODE, SECOND = M.SECOND;

const groups = {};

// ───────────────────────── textcomp.rs, edge_inputs.rs
function packPad(bits) {
  const b = bits.slice(), p = b[b.length - 1] ? 0 : 1;
  const n = 8 - b.length % 8;
  for (let i = 0; i < n; i++) b.push(p);
  return M.packBits(b);
}
function varaExpansion(state, w) {
  const bits = [2, 1, 0].map(i => ((state - 1) >> i) & 1).concat(Array.from(w, c => c === "1" ? 1 : 0));
  for (let n = bits.length; n >= 4; n--) {
    const d = M.tcDecompress(packPad(bits.slice(0, n)));
    if (d) return d[0];
  }
  return new Uint8Array(0);
}
function stream(frame) {
  const ctrl = frame[frame.length - 3];
  let field = frame.slice(0, frame.length - (ctrl & 2 ? 4 : 3));
  if (!(ctrl & 1)) field = field.slice(0, field.lastIndexOf(0x14));
  return [(ctrl & 0x20) !== 0, field];
}
groups.textcomp = () => {
  const v = json("textcomp_blackbox.json");
  let n = 0;
  for (const p of v.decode) {
    const w = p.u + v.fingerprints[p.f];
    check("textcomp decode " + n, Buffer.from(varaExpansion(p.s, w)).toString("hex") === p.out, JSON.stringify(p));
    n++;
  }
  for (const p of v.check) {
    check("textcomp check " + n, Buffer.from(varaExpansion(p.s, p.w)).toString("hex") === p.out, JSON.stringify(p));
    n++;
  }
  check("textcomp decode count", n >= 1300, n);
  let e = 0;
  for (const enc of v.encode) {
    const text = hex(enc.text);
    let pos = 0;
    for (const f of enc.frames) {
      const [comp, data] = stream(hex(f));
      if (!comp) {
        check("textcomp raw at " + pos, eq(Array.from(text.slice(pos, pos + data.length)), Array.from(data)));
        pos += data.length;
        continue;
      }
      const start = (data[0] >> 5) + 1, end = Math.min(text.length, pos + 3 * 89 + 39);
      const c = M.tcCompress(text.subarray(pos, end), 89, start);
      check("textcomp encode at " + pos, eq(Array.from(c.bytes), Array.from(data)));
      const back = M.tcDecompress(c.bytes);
      check("textcomp encode back " + pos, back && eq(Array.from(back[0]), Array.from(text.slice(pos, pos + c.consumed))));
      pos += c.consumed;
      e++;
    }
    check("textcomp encode end", pos === text.length);
  }
  check("textcomp encode count", e >= 55, e);
  for (const enc of v.encode) {
    const text = hex(enc.text);
    for (let start = 1; start <= 8; start++) for (const cap of [8, 20, 47, 88, 89, 400]) {
      const c = M.tcCompress(text, cap, start), back = M.tcDecompress(c.bytes);
      check("textcomp round trip " + start + "/" + cap, c.bytes.length <= cap && back && eq(Array.from(back[0]), Array.from(text.slice(0, c.consumed))));
    }
  }
  const fr = json("textcomp_frames.json");
  let k = 0;
  for (const f of fr.onair.filter(f => f.b5 === 1)) {
    const d = M.tcDecompress(hex(f.data_hex));
    check("textcomp onair " + k, d && Buffer.from(d[0]).toString("hex") === f.text_hex);
    k++;
  }
  check("textcomp onair count", k === 15, k);
  const want = M.tcCompress(ascii("the message from the station"), 12, 1);
  for (const st of [0, 9, 200, Number.MAX_SAFE_INTEGER])
    check("textcomp unknown state " + st, eq(M.tcCompress(ascii("the message from the station"), 12, st), want));
  check("textcomp empty", eq(M.tcCompress(new Uint8Array(0), 4, 0), M.tcCompress(new Uint8Array(0), 4, 1)));
};

groups.frames = () => {
  for (const f of [[], [0x02], [0x00, 0x02]]) check("parse short " + f, M.parseFrame(Uint8Array.from(f), 0x55) === null);
  for (const f of [[0x02, 0, 0], [0x03, 0, 0]]) {
    const p = M.parseFrame(Uint8Array.from(f), 0x55);
    check("parse trailer only " + f, p && p.data === null && p.nextLevel === null);
  }
  let p = M.parseFrame(Uint8Array.from([0x14, 0x55, 0, 0, 0]), 0x55);
  check("parse empty field", p && !p.last && !p.full && p.data && p.data.length === 0);
  p = M.parseFrame(Uint8Array.from([0x07, 0x02, 0, 0]), 0x55);
  check("parse next level only", p && p.last && p.nextLevel === 7 && p.data === null);
  // cq.rs round trip
  for (const [call, bw] of [["N0CALL", M.BW2300], ["N0CALL-5", M.BW500], ["AB1C-15", M.BW2750]]) {
    const f = M.cqFrame(call, bw), c = M.cqParse(f);
    check("cq " + call, M.crcOk(f) && c.call === call && c.bw === bw, JSON.stringify(c));
  }
  check("cq bad call", M.cqFrame("n0call", M.BW2300) === null && M.cqFrame("N0CALL-16", M.BW2300) === null);
  check("cq host line", M.cqHostLine(M.cqParse(M.cqFrame("N0CALL-5", M.BW500))) === "CQFRAME N0CALL-5 500");
};

// compression.rs: received FILES chunks (miniz raw deflate; zlib's raw deflate stands in)
groups.compression = () => {
  const text = ascii("the quick brown fox jumps over the lazy dog ".repeat(40));
  const chunk = (deflated, body) => Uint8Array.of((deflated ? 0x80 : 0) | body.length >> 8, body.length & 255, ...body);
  for (const level of [0, 1, 6, 9]) {
    const z = zlib.deflateRawSync(text, {level});
    const r = new M.FilesReader(), got = r.push(chunk(true, z));
    check("inflate level " + level, got.length === 1 && Buffer.from(got[0]).equals(Buffer.from(text)));
  }
  const rnd = Buffer.alloc(3000);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 2654435761 >>> 13) & 255;
  check("inflate stored+dynamic", Buffer.from(M.inflateRaw(zlib.deflateRawSync(Buffer.concat([rnd, Buffer.from(text)])), 1e6))
    .equals(Buffer.concat([rnd, Buffer.from(text)])));
  let r = new M.FilesReader();
  check("files stored chunk", eq(r.push(M.filesChunk(ascii("xy"))).map(b => Array.from(b)), [[120, 121]]));
  r = new M.FilesReader();
  const bad = Uint8Array.of(...chunk(true, new Uint8Array(20).fill(0xFF)), ...chunk(false, ascii("next")));
  check("bad deflate dropped", eq(r.push(bad).map(b => Buffer.from(b).toString()), ["next"]));
  const fits = zlib.deflateRawSync(Buffer.alloc(M.MAX_INFLATED)), bomb = zlib.deflateRawSync(Buffer.alloc(M.MAX_INFLATED + 1));
  r = new M.FilesReader();
  check("inflate cap fits", r.push(chunk(true, fits)).map(b => b.length).join() === String(M.MAX_INFLATED));
  check("inflate cap bomb", r.push(chunk(true, bomb)).length === 0);
  check("inflate after bomb", eq(r.push(chunk(false, ascii("ok"))).map(b => Buffer.from(b).toString()), ["ok"]));
};

// ───────────────────────── hf_timing.rs, adapt.rs
groups.timing = () => {
  const v = json("hf/ack_timing.json");
  let steps = 0;
  for (const s of v.sequences) {
    const bw = bwOf(s.bw), wide = s.chat, t = new M.Timing(bw, wide);
    for (const st of s.steps) {
      if (st.ev === "reset") t.reset(wide);
      else if (st.ev === "ctrl") t.ctrl(st.t, st.state === 7);
      else t.ack(st.level, st.t);
      const a = st.after, ctx = s.name + " step " + steps + " " + st.ev;
      check(ctx, t.ctrlDelay === a.ctrl_delay && t.ctrlAllowance === a.ctrl_allowance && t.baseAllowance() === a.base_allowance &&
        eq(t.ackDelay, a.ack_delay) && eq(t.ackWindows, a.ack_windows) && eq(t.count, a.count) && t.unset === a.timing_unset,
        JSON.stringify([t.ctrlDelay, t.ackDelay, t.ackWindows]) + " vs " + JSON.stringify([a.ctrl_delay, a.ack_delay, a.ack_windows]));
      steps++;
    }
  }
  check("timing steps", steps >= 20, steps);
  const rf = json("hf/reply_format.json");
  let n = 0;
  for (const s of rf.sequences) {
    const r = new M.ReplyFormat();
    s.steps.forEach((st, i) => {
      const rx = st.rx_fmt, norm = st.raw_snr - (9.4 - M.FORMATS[rx].kDb);
      const [snr, f] = r.update(norm, st.hits, rx);
      check(s.name + " step " + i, snr === Math.fround(st.snr_held) && f === st.reply_fmt, snr + " " + f);
      n++;
    });
  }
  for (const c of rf.single) {
    check("reply single " + n, M.chooseReplyFormat(Math.fround(c.snr_held), c.missed_held, c.rx_fmt) === c.reply_fmt, JSON.stringify(c));
    n++;
  }
  check("reply count", n >= 40, n);
  const am = json("hf/adapt_margin.json");
  n = 0;
  const qamCode = q => q;
  for (const s of am.sequences) {
    const a = new M.Adaptation(bwOf(s.bw));
    s.events.forEach((e, i) => {
      if (e.ev === "ok") a.frameOk(e.level);
      else if (e.ev === "lost" && (e.state === null || e.state === undefined)) a.frameLost(e.level);
      else if (e.ev === "level_from_snr") a.levelFromSnr(-50, 1, 0);
      const f = e.after, close = (x, k) => Math.abs(x - f[k]) < 2e-5;
      check(s.name + " event " + i, close(a.margin, "A") && close(a.marginDecay, "decay") && close(a.marginPrev, "A_prev") &&
        a.okRun === f.n && qamCode(a.qam) === f.qam && a.last === f.last && a.failedClimbs === f.climb && a.lastGood === f.good,
        JSON.stringify(a) + " vs " + JSON.stringify(f));
      n++;
    });
  }
  check("adapt count", n >= 100, n);
  const th = json("hf/turn_hold.json");
  for (const c of th.cases) {
    const st = c.state;
    const t = {answererHold: st.is_answerer && st.hold, chat: st.chat, queued: st.Q, sinceHeaderMs: c.now_ms_since_header - st.t_header_ms,
      kind: st.kind, offered: st.offered, nextTx: st.next_tx, text: st.text_comp, lastHeld: st.last_held};
    const [got, held] = M.turnStart(bwOf(c.bw), t);
    const o = c.hint_override === null || c.hint_override === undefined ? 0 : c.hint_override;
    const want = c.action === "49" ? {start: "hold"} : c.action === "50" ? {start: "idle"} : {start: "data", hint: o};
    check("turn " + c.case, eq(got, want) && held === c.last_held_after, JSON.stringify([got, held]));
  }
  for (const [b, tabs] of Object.entries(th.hint_table_minimum)) {
    const bw = bwOf(b);
    for (const [k, text] of [["plain", false], ["text", true]])
      tabs[k].forEach((h, i) => check("hint min " + b + " " + k + " L" + (i + 1), M.hintTableMinimum(bw, i + 1, text) === h));
  }
  const bs = json("hf/b2f_snoop.json");
  for (const c of bs.host_snoop) {
    const s = new M.B2fSnoop();
    s.observe(hex(c.block_hex));
    check("b2f " + c.name, s.takeQuit() === (c.expect.fq_flag_set === true) && s.fs === (c.expect.fs_flag_set === true));
  }
  for (const c of bs.start_level_cap) {
    const cap = {registered: c.registered === true, fs: c.fs_flag === true, text: c.comp_text_active === true, headerSent: c.arq_state === 4};
    check("start cap " + JSON.stringify(c), M.startLevelCap(bwOf(c.bw), cap) === c.expect_hi);
  }
};

groups.adapt = () => {
  const v = json("xara_ack_replay.json");
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  let decisions = 0, agree = 0;
  for (const run of v.runs) {
    const tr = new M.SnrTrend(), ad = new M.Adaptation(bwOf(run.bw)), codes = [];
    run.ops.forEach((op, i) => {
      const at = run.name + " op " + i;
      if (op.op === "trend") check(at, close(tr.push(op.sn), op.out));
      else if (op.op === "ok") { ad.frameOk(op.level); check(at, close(ad.margin, op.A), ad.margin); }
      else if (op.op === "lost") { ad.frameLost(op.level); check(at, close(ad.margin, op.A), ad.margin); }
      else if (op.op === "margins") {
        const m = ad.margins(op.sn, op.level);
        check(at, m.every((x, k) => close(x, op.m[k])), JSON.stringify(m));
      } else if (op.op === "decide") {
        const d = M.ackDecision(bwOf(run.bw), op.level, op.m, op.hint, op.complete, op.M);
        check(at, d.code === op.code && d.level === op.new, JSON.stringify(d));
        codes.push(d.code);
      }
    });
    check(run.name + " decisions", codes.length === run.vara.length);
    decisions += run.vara.filter(c => c !== null).length;
    agree += codes.filter((c, i) => run.vara[i] === c).length;
  }
  check("ack replay agreement", decisions === 235 && agree === 234, decisions + "/" + agree);
  const ad = new M.Adaptation(M.BW2300), q = sn => ad.levelFromSnr(sn, 4, 6);
  check("level_from_snr", eq([-6.9, -7.1, -9.7, -9.9, -11.5, -11.7].map(q), [4, 3, 3, 2, 2, 1]));
};

// ───────────────────────── session.rs (unit) — driving one Session by hand
class Sim {
  constructor(cfg) { this.s = new M.Session(cfg); this.now = 0; this.host = []; this.txq = []; }
  static caller() { const c = M.hfConfig(M.BW2300, "N0CALL"); c.cwid = true; return new Sim(c); }
  drain() {
    let o;
    while ((o = this.s.pop())) {
      if (o.kind === "tx") this.txq.push(o.tx);
      else if (o.kind === "host") this.host.push(o.ev);
    }
    const t = this.txq;
    this.txq = [];
    return t;
  }
  tx() {
    const t = this.drain();
    if (t.length !== 1) throw new Error("expected one tx, got " + JSON.stringify(t));
    this.now += SECOND;
    this.s.onTxDone(this.now);
    return t[0];
  }
  none() { const t = this.drain(); if (t.length) throw new Error("unexpected tx " + JSON.stringify(t)); }
  ctrl(code, fmt) {
    this.now += SECOND / 5;
    this.s.onCtrl(this.now, {code, fmt, hits: [31, 15, 14][fmt], snrNorm: 20, tEnd: this.now});
  }
  wait(secs) {
    const end = this.now + Math.trunc(secs * SECOND);
    for (;;) {
      const t = this.s.nextDeadline();
      if (t === null || t > end) break;
      this.now = Math.max(this.now, t);
      this.s.poll(this.now);
      const q = this.drain();
      if (q.length) { this.txq = q; return; }
    }
    this.now = end;
    this.s.poll(this.now);
  }
  rx() { return this.host.filter(h => h.kind === "data").flatMap(h => Array.from(h.data)); }
}
const ctrlTx = (code, fmt, extra) => ({type: "ctrl", code, fmt, extra: extra || 0});
const isCtrl = (t, code, fmt) => t.type === "ctrl" && t.code === code && (fmt === undefined || t.fmt === fmt) && t.extra === 0;
function handshake(sim) {
  const n = sim.s.maxStartLevel() > 4 ? 56 : 54;
  sim.s.connect(0, null, "N1CALL");
  check("hs request", eq(sim.tx(), ctrlTx(26, 0, 9)));
  sim.ctrl(18, 1);
  const t = sim.tx();
  check("hs header level", t.type === "data" && t.level === 4);
  const f = t.frames[0];
  check("hs header bytes", eq(Array.from(f.slice(0, 7)), [0x39, 0xb0, 0xc1, 0x30, 0xc0, 0x00, 0x00]) && (f[7] & 0xfe) === 0x80);
  const p = M.parseFrame(f, M.termMarker("N0CALL"));
  check("hs header last", p && p.last && f[f.length - 3] === 0x82);
  check("hs header sent", sim.s.state === "HeaderSent");
  sim.ctrl(49, 2);
  check("hs start level", isCtrl(sim.tx(), n, 1));
  check("hs connected", sim.host.length && sim.host[sim.host.length - 1].kind === "connected" && sim.s.state === "Receiving");
  sim.ctrl(49, 2);
  check("hs start level again", isCtrl(sim.tx(), n, 0));
}
function dataSession(registered) {
  const cfg = M.hfConfig(M.BW2300, "N0CALL");
  cfg.host.registered = registered; cfg.host.compression = M.COMP.OFF;
  const sim = new Sim(cfg);
  handshake(sim);
  sim.s.send(sim.now, new Uint8Array(200000).fill(0x55));
  sim.ctrl(50, 2);
  check("data session break", isCtrl(sim.tx(), 49, 0));
  sim.ctrl(14, 2);
  return sim;
}
const dataFrame = (level, data, hint, last) =>
  M.buildFrame(M.BW2300.level(level).frameBytes, data, {reply: 2, compressed: false, hint}, last ? 4 : null, M.termMarker("N0CALL"));
groups.session = () => {
  let sim = Sim.caller();
  handshake(sim);
  sim.ctrl(50, 2);
  check("2300 idle", isCtrl(sim.tx(), 21, 0) && sim.s.state === "Idle");
  sim = Sim.caller();
  handshake(sim);
  sim.s.send(sim.now, ascii("hello"));
  sim.ctrl(50, 2);
  check("2300 break", isCtrl(sim.tx(), 49, 0) && sim.s.state === "Break");
  sim.ctrl(14, 2);
  let t = sim.tx(), p = M.parseFrame(t.frames[0], M.termMarker("N0CALL"));
  check("2300 data", t.level === 4 && t.frames.length === 1 && Buffer.from(p.data).toString() === "hello" && p.last &&
    p.ctrl.reply === 2 && p.ctrl.hint === 0);

  for (let r = 0; r < 3; r++) {
    sim = Sim.caller();
    handshake(sim);
    sim.s.send(sim.now, ascii("hello"));
    sim.ctrl(50, 2);
    check("backoff break " + r, eq(sim.drain(), [ctrlTx(49, 0)]));
    sim.s.setBreakDraw(r);
    sim.now += SECOND;
    sim.s.onTxDone(sim.now);
    check("backoff deadline " + r, sim.s.nextDeadline() === sim.now + (657 + (r + 1) * 1024) * 64);
  }

  sim = Sim.caller();
  handshake(sim);
  const data = Uint8Array.from({length: 145}, (_, i) => 97 + i % 26);
  sim.s.send(sim.now, data);
  sim.ctrl(50, 2);
  check("bulk break", isCtrl(sim.tx(), 49, 0));
  sim.ctrl(14, 2);
  const marker = M.termMarker("N0CALL");
  t = sim.tx(); p = M.parseFrame(t.frames[0], marker);
  check("bulk frame 1", t.level === 4 && p.full && !p.last && p.ctrl.hint === 2 && t.frames[0][t.frames[0].length - 3] === 0x89 &&
    eq(Array.from(p.data), Array.from(data.slice(0, 89))));
  sim.ctrl(1, 2);
  t = sim.tx(); p = M.parseFrame(t.frames[0], marker);
  check("bulk frame 2", t.level === 4 && t.frames[0][t.frames[0].length - 3] === 0x82 && p.last && p.nextLevel === 4 &&
    eq(Array.from(p.data), Array.from(data.slice(89))));
  sim.ctrl(49, 2);
  check("bulk go ahead", isCtrl(sim.tx(), 14, 1) && sim.host.some(h => h.kind === "buffer" && h.n === 0));
  sim.ctrl(50, 2);
  check("bulk no traffic", isCtrl(sim.tx(), 21, 1));
  sim.wait(10);
  sim.none();
  sim.ctrl(50, 2);
  check("bulk no traffic 2", isCtrl(sim.tx(), 21, 0));
  sim.s.disconnect(sim.now);
  sim.wait(0.5);
  check("bulk disc break", isCtrl(sim.tx(), 49, 0));
  sim.ctrl(14, 2);
  check("bulk qrt", isCtrl(sim.tx(), 3, 0));
  t = sim.tx();
  check("bulk cwid", t.type === "cwid" && t.blanks === 0);
  sim.none();
  check("bulk disconnected", sim.host[sim.host.length - 1].kind === "disconnected" && sim.s.state === "Listen");

  const cfg = M.hfConfig(M.BW2300, "N0CALL");
  cfg.host.retries = 3;
  sim = new Sim(cfg);
  sim.s.connect(0, null, "N1CALL");
  check("retry first", eq(sim.tx(), ctrlTx(26, 0, 9)));
  const t0 = sim.now;
  sim.wait(1.26); sim.none();
  sim.wait(0.02);
  check("retry second", isCtrl(sim.tx(), 26, 0) && sim.now - SECOND - t0 === 950 * 64, sim.now - SECOND - t0);
  sim.wait(1.3);
  check("retry third", isCtrl(sim.tx(), 26, 0));
  sim.wait(1.3);
  check("retry gives up", sim.tx().type === "cwid");
  sim.none();
  check("retry unable", sim.host.some(h => h.kind === "unableToConnect") && sim.s.state === "Listen" &&
    sim.host[sim.host.length - 1].kind === "disconnected");

  sim = dataSession(true);
  const frames = x => { if (x.type !== "data") throw new Error(JSON.stringify(x)); return [x.level, x.frames]; };
  let [l, f] = frames(sim.tx());
  check("acks first", l === 4 && f.length === 1 && f[0][f[0].length - 3] === 0x99);
  sim.ctrl(7, 2); check("ack up1", frames(sim.tx())[0] === 5);
  sim.ctrl(9, 2); check("ack up4", frames(sim.tx())[0] === 9);
  sim.ctrl(6, 2); check("ack down", frames(sim.tx())[0] === 8);
  for (let i = 0; i < 6; i++) { sim.ctrl(1, 2); check("stay " + i, frames(sim.tx())[1].length === (i < 5 ? 1 : 2)); }
  const before = sim.s.buffered(), pay = M.BW2300.level(8).payload;
  sim.ctrl(10, 2);
  [l, f] = frames(sim.tx());
  check("second only", l === 6 && f.length === 1 && sim.s.buffered() === before - pay);
  check("second only resend", M.parseFrame(f[0], M.termMarker("N0CALL")).data.length === Math.min(pay, M.BW2300.level(6).payload));
  sim.ctrl(2, 2); check("nack", frames(sim.tx())[0] === 5);
  sim.ctrl(19, 2); check("nack missed", frames(sim.tx())[0] === 3);

  sim = dataSession(false);
  frames(sim.tx());
  sim.wait(5); check("poll 12", isCtrl(sim.tx(), 12, 0));
  sim.wait(5); check("poll 12 again", isCtrl(sim.tx(), 12, 0));
  sim.ctrl(1, 2); frames(sim.tx());
  sim.wait(5); check("poll 13", isCtrl(sim.tx(), 13, 0));

  const rc = M.hfConfig(M.BW2300, "N0CALL");
  rc.host.registered = true; rc.host.compression = M.COMP.OFF;
  sim = new Sim(rc);
  handshake(sim);
  check("rx level", sim.s.level === 6);
  const got = [];
  [5, 9, 12].forEach((sn, i) => {
    const lv = sim.s.level, body = new Uint8Array(M.BW2300.level(lv).payload).fill(i);
    got.push(...body);
    sim.now += SECOND;
    sim.s.onData(sim.now, {level: lv, frames: [{ok: true, bytes: dataFrame(lv, body, 6, false), snrDb: sn}], tEnd: sim.now});
    const t = sim.tx(), step = {1: 0, 7: 1, 5: 2, 8: 3, 9: 4, 6: -1}[t.code];
    check("rx ack " + i, t.type === "ctrl" && t.fmt === 2 && step !== undefined && sim.s.level === lv + step, JSON.stringify(t));
  });
  sim.now += SECOND;
  const lv = sim.s.level;
  sim.s.onData(sim.now, {level: lv, frames: [{ok: true, bytes: dataFrame(lv, ascii("bye"), 0, true), snrDb: 12}], tEnd: sim.now});
  check("rx turn", isCtrl(sim.tx(), 49, 2) && sim.s.state === "Break");
  got.push(...ascii("bye"));
  check("rx data", eq(sim.rx(), got));
  sim.ctrl(14, 2);
  check("rx idle", isCtrl(sim.tx(), 50, 2) && sim.s.state === "IdleSent");

  sim = Sim.caller();
  handshake(sim);
  sim.now += SECOND;
  sim.s.onData(sim.now, {level: 4, frames: [{ok: false, bytes: new Uint8Array(0), snrDb: 0}], tEnd: sim.now});
  check("nack lost", isCtrl(sim.tx(), 2, 0) && sim.s.level === 3);
  sim.ctrl(12, 0); check("nack poll", isCtrl(sim.tx(), 2, 0));
  sim.ctrl(13, 0); check("nack missed poll", isCtrl(sim.tx(), 19, 0) && sim.s.level === 1);

  sim = Sim.caller();
  handshake(sim);
  sim.ctrl(12, 2); check("unseen req", isCtrl(sim.tx(), 19, 0));

  sim = Sim.caller();
  handshake(sim);
  sim.s.abort(sim.now);
  sim.wait(4); sim.none();
  sim.wait(4); check("abort window", isCtrl(sim.tx(), 3));

  sim = Sim.caller();
  handshake(sim);
  sim.s.abort(sim.now);
  sim.now += 2 * SECOND;
  sim.s.onData(sim.now, {level: 4, frames: [{ok: true, bytes: dataFrame(4, ascii("hello"), 6, false), snrDb: 10}], tEnd: sim.now});
  check("abort next frame", isCtrl(sim.tx(), 3) && !sim.host.some(h => h.kind === "data"));

  const tc = M.hfConfig(M.BW2300, "N0CALL");
  tc.host.registered = true; tc.host.compression = M.COMP.TEXT;
  sim = new Sim(tc);
  sim.s.connect(0, null, "N1CALL"); sim.tx();
  sim.ctrl(18, 1); sim.tx();
  sim.ctrl(49, 2); sim.tx();
  check("comp receiving", sim.s.state === "Receiving");
  const clv = sim.s.level, len = M.BW2300.level(clv).frameBytes, msg = ascii("[WL2K-5.0-B2FWIHJM$]\r");
  const e = M.tcCompress(msg, len - 8, 1);
  const bytes = M.buildFrame(len, e.bytes, {reply: 2, compressed: true, hint: 6}, null, M.termMarker("N0CALL"));
  sim.now += SECOND;
  sim.s.onData(sim.now, {level: clv, frames: [{ok: true, bytes, snrDb: 20}, {ok: false, bytes: new Uint8Array(0), snrDb: 0}], tEnd: sim.now});
  sim.drain();
  check("comp lost frame 2", eq(sim.rx(), Array.from(msg.slice(0, e.consumed))));

  // edge_inputs.rs: no callsign
  const nc = M.hfConfig(M.BW2300, "N0CALL");
  nc.host.mycalls = [];
  const s = new M.Session(nc);
  s.connect(0, null, "N1CALL");
  check("no call calling", s.state === "Calling");
  s.abort(0);
  s.poll(1000 * 48000);
  while (s.pop());
};

// ───────────────────────── link.rs: two sessions over a simulated channel (tests/sim/mod.rs)
class SimRng {
  constructor(seed) { this.s = BigInt(seed) & ((1n << 64n) - 1n); }
  uniform() {
    let s = this.s;
    const m = (1n << 64n) - 1n;
    s ^= (s << 13n) & m; s ^= s >> 7n; s ^= (s << 17n) & m;
    this.s = s;
    return Number(s >> 11n) / 9007199254740992;
  }
}
const payload = (n, seed) => { const r = new SimRng(seed); return Uint8Array.from({length: n}, () => Math.trunc(r.uniform() * 256)); };
const WORDS = ["the", "message", "Winlink", "station", "N0CALL", "report", "weather", "net", "check-in", "73", "de", "QSL",
  "frequency", "tonight", "\r\n", "Subject: "];
function text(n, seed) {
  const r = new SimRng(seed), out = [];
  while (out.length < n) { out.push(...ascii(WORDS[Math.trunc(r.uniform() * WORDS.length)])); out.push(32); }
  return Uint8Array.from(out.slice(0, n));
}
const digest = b => { let h = 0x811c9dc5; for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0; return "<" + b.length + " bytes " + h.toString(16).padStart(8, "0") + ">"; };
const fdbg = x => Number.isInteger(x) ? x.toFixed(1) : String(x);
const roleName = r => r === M.ROLE.CALLER ? "Caller" : "Answerer";
function hostDbg(h) {
  switch (h.kind) {
    case "pending": return "Pending";
    case "cancelPending": return "CancelPending";
    case "disconnected": return "Disconnected";
    case "unableToConnect": return "UnableToConnect";
    case "timedOut": return "TimedOut";
    case "sn": return "Sn(" + fdbg(h.sn) + ")";
    case "buffer": return "Buffer(" + h.n + ")";
    case "registered": return "Registered(" + h.registered + ")";
    case "data": return "Data(" + digest(h.data) + ")";
    case "connected": return `Connected { caller: "${h.caller}", answerer: "${h.answerer}", vias: [], bw: Hf(Hz${h.bw.hz}) }`;
  }
  throw new Error("host " + h.kind);
}
function goldenLine(o) {
  if (o.kind === "host") return "Host(" + hostDbg(o.ev) + ")";
  if (o.kind === "listen") {
    const l = o.listen, k = l.keys;
    const conn = k.connect ? `Some((${k.connect[0]}, ${roleName(k.connect[1])}))` : "None";
    return `Listen(Listen { bw: Hz${l.bw.hz}, keys: Keys { seed: ${k.seed}, mycalls: [${k.mycalls.join(", ")}], role: ${roleName(k.role)}, connect: ${conn} }, codes: [${l.codes.join(", ")}], levels: [${l.levels.join(", ")}], nframes: ${l.nframes}, linked: ${l.linked} })`;
  }
  const t = o.tx;
  if (t.type === "ctrl") return `Tx(Ctrl { code: ${t.code}, fmt: ${t.fmt}, extra: ${t.extra} })`;
  if (t.type === "data") return `Tx(Data { level: ${t.level}, frames: [${t.frames.map(digest).join(", ")}] })`;
  return `Tx(CwId { call: "${t.call}", blanks: ${t.blanks} })`;
}
const LATENCY = SECOND / 10;
function airtime(s, t) {
  let x;
  if (t.type === "ctrl") x = (M.leadinSymbols(t.fmt, t.code, t.extra) + M.FORMATS[t.fmt].nsym - 1) * 2048 / 48000;
  else if (t.type === "data") { const l = s.bw.level(t.level); x = l.airtime + (t.frames.length - 1) * l.dataSymbols * l.symbolPeriod; }
  else x = 3.0;
  return [Math.trunc(x * SECOND), 0];
}
const what = t => t.type === "ctrl" ? `c${t.code}f${t.fmt}`
  : t.type === "data" ? `L${t.level}x${t.frames.length}${t.frames.some(f => f[f.length - 3] & 0x20) ? "z" : ""}` : "cw";
class SimLink {
  constructor(a, b, ch, seed) {
    const mk = c => ({s: new M.Session(c), listen: null, host: [], got: 0, progress: 0, busy: [], sent: [], deaf: false});
    this.st = [mk(a), mk(b)]; this.now = 0; this.q = []; this.seq = 0; this.ch = ch; this.rng = new SimRng(BigInt(seed) | 1n);
    this.trace = []; this.slow = false;
    this.flush();
  }
  busyUntil(i) { const b = this.st[i].busy; return b.length ? b[b.length - 1][1] : 0; }
  push(t, e) {
    const k = [t, ++this.seq];
    let i = this.q.length;
    while (i > 0 && (this.q[i - 1].k[0] > t)) i--;
    this.q.splice(i, 0, {k, e});
  }
  flush() {
    for (let i = 0; i < 2; i++) {
      let o;
      while ((o = this.st[i].s.pop())) {
        this.trace.push(this.now + " " + i + " " + goldenLine(o));
        if (o.kind === "listen") this.st[i].listen = o.listen;
        else if (o.kind === "host") {
          if (o.ev.kind === "data") { this.st[i].got += o.ev.data.length; this.st[i].progress = this.now; }
          this.st[i].host.push(o.ev);
        } else this.transmit(i, o.tx);
      }
    }
  }
  transmit(i, tx) {
    const start = Math.max(this.now, this.busyUntil(i)), [sig, tail] = airtime(this.st[i].s, tx);
    const end = start + sig, done = end + tail;
    this.st[i].busy.push([start, done]);
    this.push(done, {kind: "txDone", i});
    this.st[i].sent.push(what(tx));
    let p = null;
    if (tx.type === "ctrl") { if (this.rng.uniform() >= this.ch.ctrlLoss) p = {kind: "ctrl", code: tx.code, f: tx.fmt}; }
    else if (tx.type === "data") {
      if (this.rng.uniform() >= this.ch.miss) p = {kind: "data", level: tx.level, frames: tx.frames.map(f => this.rng.uniform() >= this.ch.frameLoss ? f : null)};
    }
    if (p) this.push(end + LATENCY, {kind: "arrive", i: 1 - i, start, end, p});
  }
  arrive(i, tEnd, p) {
    const bu = this.busyUntil(i);
    if (bu > tEnd - SECOND / 2 && bu > this.now - SECOND / 10) return;
    const listen = this.st[i].listen;
    if (!listen) return;
    const snr = this.ch.snr;
    if (p.kind === "ctrl") {
      if (listen.codes.includes(p.code)) this.st[i].s.onCtrl(this.now, {code: p.code, fmt: p.f, hits: [31, 15, 14][p.f], snrNorm: snr, tEnd});
    } else if (listen.levels.includes(p.level)) {
      const frames = p.frames.map(f => f ? {ok: true, bytes: f, snrDb: snr - 6} : {ok: false, bytes: new Uint8Array(0), snrDb: 0});
      this.st[i].s.onData(this.now, {level: p.level, frames, tEnd});
    }
  }
  step(limit) {
    let dl = null;
    for (let i = 0; i < 2; i++) { const t = this.st[i].s.nextDeadline(); if (t !== null && (dl === null || t < dl[0])) dl = [t, i]; }
    const ev = this.q.length ? this.q[0] : null;
    if (ev && (dl === null || ev.k[0] <= dl[0]) && ev.k[0] <= limit) {
      this.q.shift();
      this.now = Math.max(this.now, ev.k[0]);
      const e = ev.e;
      if (e.kind === "txDone") this.st[e.i].s.onTxDone(this.now);
      else if (!this.st[e.i].deaf) this.arrive(e.i, e.end, e.p);
    } else if (dl && dl[0] <= limit) {
      this.now = Math.max(this.now, dl[0]);
      this.st[dl[1]].s.poll(this.now);
    } else return false;
    this.flush();
    return true;
  }
  runUntil(secs, done) {
    const limit = this.now + Math.trunc(secs * SECOND);
    while (!done(this) && this.step(limit));
  }
  rx(i) { return Uint8Array.from(this.st[i].host.filter(h => h.kind === "data").flatMap(h => Array.from(h.data))); }
  levels(i) { return this.st[i].sent.filter(t => t[0] === "L").map(t => +t.slice(1).split("x")[0]); }
}
const CLEAN = {snr: 25, frameLoss: 0, ctrlLoss: 0, miss: 0};
const connected = l => l.st.every(s => s.host.some(h => h.kind === "connected"));
const disconnected = l => l.st.every(s => s.host.some(h => h.kind === "disconnected"));
function cfgOf(call, registered) {
  const c = M.hfConfig(M.BW2300, call);
  c.host.registered = registered; c.host.compression = M.COMP.OFF;
  return c;
}
const bytesEq = (a, b) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
function transferWith(ch, seed, a, b, comp, secs, name) {
  const ca = cfgOf("N0CALL", true);
  ca.host.compression = comp;
  const l = new SimLink(ca, cfgOf("N1CALL", false), ch, seed);
  if (b.length) l.st[1].s.send(0, b);
  l.st[0].s.connect(0, null, "N1CALL");
  l.flush();
  l.runUntil(300, connected);
  if (!connected(l)) return null;
  l.st[0].s.send(l.now, a);
  const stalled = l => l.now - Math.max(l.st[0].progress, l.st[1].progress) > 900 * SECOND;
  l.runUntil(secs, l => (l.st[1].got >= a.length && l.st[0].got >= b.length) || stalled(l));
  const ra = l.rx(1), rb = l.rx(0);
  if (ra.length < a.length || rb.length < b.length) {
    check(name + " partial a", bytesEq(ra, a.slice(0, ra.length)));
    check(name + " partial b", bytesEq(rb, b.slice(0, rb.length)));
    l.slow = true;
    return l;
  }
  check(name + " delivered a", bytesEq(ra, a));
  check(name + " delivered b", bytesEq(rb, b));
  l.runUntil(5, () => false);
  l.st[0].s.disconnect(l.now);
  l.runUntil(120, disconnected);
  check(name + " disconnected", disconnected(l));
  return l;
}
const transfer = (ch, seed, na, nb, secs, name) => transferWith(ch, seed, payload(na, 7), payload(nb, 9), M.COMP.OFF, secs, name);
const dataFrames = (l, i) => { const d = l.st[i].sent.filter(t => t[0] === "L"); return [d.length, d.filter(t => t.endsWith("z")).length]; };
function up(ch, seed) {
  const l = new SimLink(cfgOf("N0CALL", false), cfgOf("N1CALL", false), ch, seed);
  l.st[0].s.connect(0, null, "N1CALL");
  l.flush();
  l.runUntil(300, connected);
  return l;
}
function b2f(seed, msgs) {
  const l = up(CLEAN, seed);
  for (const m of msgs) l.st[0].s.send(l.now, ascii(m));
  l.flush();
  l.runUntil(120, disconnected);
  return l;
}
function scripted(ca, cb, ch, seed, a, b, abort) {
  const l = new SimLink(ca, cb, ch, seed);
  if (b.length) l.st[1].s.send(0, b);
  l.st[0].s.connect(0, null, "N1CALL");
  l.flush();
  l.runUntil(300, connected);
  if (!connected(l)) return l;
  l.st[0].s.send(l.now, a);
  l.flush();
  if (abort) {
    const data = l => l.st.reduce((n, s) => n + s.sent.filter(t => t[0] === "L").length, 0);
    const n = data(l) + abort[1];
    l.runUntil(600, l => data(l) >= n);
    l.st[abort[0]].s.abort(l.now);
  } else {
    l.runUntil(600, l => l.st[1].got >= a.length && l.st[0].got >= b.length);
    l.runUntil(5, () => false);
    l.st[0].s.disconnect(l.now);
  }
  l.flush();
  l.runUntil(300, l => l.st.every(s => s.s.state === "Listen"));
  return l;
}

groups.golden = () => {
  const lossy = seed => [{snr: 20, frameLoss: 0.15, ctrlLoss: 0.1, miss: 0.05}, {snr: 12, frameLoss: 0.25, ctrlLoss: 0.2, miss: 0.1},
    {snr: 30, frameLoss: 0.05, ctrlLoss: 0.3, miss: 0.02}][seed % 3];
  const withCfg = (bw, call, registered, comp, chat) => { const c = cfgOf(call, registered); c.bw = bw; c.host.compression = comp; c.host.chat = chat; return c; };
  const reg = comp => withCfg(M.BW2300, "N0CALL", true, comp, false), ans = () => cfgOf("N1CALL", false);
  const O = M.COMP.OFF, T = M.COMP.TEXT, Fl = M.COMP.FILES, compName = c => ["Off", "Text", "Files"][c];
  const cases = [];
  const add = (name, mk, files) => cases.push({name, mk, files: !!files});
  add("clean off", () => scripted(reg(O), ans(), CLEAN, 1, payload(10000, 1), payload(2000, 2), null));
  add("clean unregistered", () => scripted(cfgOf("N0CALL", false), ans(), CLEAN, 2, payload(5000, 3), new Uint8Array(0), null));
  for (const [bw, n] of [[M.BW500, "Hz500"], [M.BW2750, "Hz2750"]])
    add("clean " + n, () => scripted(withCfg(bw, "N0CALL", true, O, false), withCfg(bw, "N1CALL", false, O, false), CLEAN, 3, payload(4000, 4), payload(1000, 5), null));
  add("clean chat", () => scripted(withCfg(M.BW2300, "N0CALL", true, T, true), withCfg(M.BW2300, "N1CALL", false, O, true), CLEAN, 4, text(2000, 1), text(500, 2), null));
  add("clean text", () => scripted(reg(T), ans(), CLEAN, 5, text(10000, 3), text(2000, 4), null));
  add("clean files", () => scripted(reg(Fl), ans(), CLEAN, 6, text(8000, 8), text(2000, 9), null), true);
  const sizes = [6000, 89, 178, 1, 0, 2873, 1364];
  for (let seed = 1; seed <= 6; seed++) {
    const a = payload(Math.max(sizes[seed % 7], 1), seed), b = payload(sizes[seed * 3 % 7], seed + 1);
    add("lossy off " + seed, () => scripted(reg(O), ans(), lossy(seed), seed, a, b, null));
  }
  for (let seed = 10; seed <= 17; seed++) {
    const comp = seed < 14 ? T : Fl;
    let a = text(Math.max(sizes[seed % 7], 1), seed);
    if (seed % 4 === 0) a = Uint8Array.of(...a, ...payload(300, seed));
    const b = text(sizes[seed * 3 % 7], seed + 1);
    add("lossy " + compName(comp) + " " + seed, () => scripted(reg(comp), ans(), lossy(seed), seed, a, b, null), comp === Fl);
  }
  for (let who = 0; who < 2; who++) for (const n of [1, 2, 4, 7])
    add(`clean abort by ${who} after ${n} frames`, () => scripted(reg(O), ans(), CLEAN, 7, payload(5000, 6), payload(1500, 7), [who, n]));
  for (let seed = 30; seed <= 37; seed++) {
    const abort = [seed % 2, 1 + seed % 7], comp = [O, T, Fl][seed % 3];
    add(`lossy ${compName(comp)} abort Some((${abort[0]}, ${abort[1]})) ${seed}`,
      () => scripted(reg(comp), ans(), lossy(seed), seed, text(6000, seed), text(1500, seed + 1), abort), comp === Fl);
  }
  for (const seed of [55, 58, 60, 66, 70, 75]) {
    const k = 1 + seed % 5;
    add(`two-frame abort after ${k} doubles ${seed}`, () => {
      const l = up({snr: 25, frameLoss: 0.2, ctrlLoss: 0, miss: 0}, seed);
      l.st[0].s.send(l.now, payload(3000, seed));
      l.flush();
      const doubles = l => l.st[0].sent.filter(t => t.endsWith("x2")).length;
      l.runUntil(600, l => doubles(l) >= k);
      l.st[0].s.abort(l.now);
      l.flush();
      l.runUntil(300, l => l.st.every(s => s.s.state === "Listen"));
      return l;
    });
  }
  add("b2f fq", () => b2f(4, ["FF\r", "FQ\r"]));
  add("b2f fq alone", () => b2f(5, ["FQ\r"]));

  const golden = fs.readFileSync(path.join(XARA, "crates/xara-arq/tests/golden/hf_link.txt"), "utf8");
  const want = new Map();
  let cur = null;
  for (const line of golden.split("\n")) {
    if (line.startsWith("## ")) { cur = line.slice(3); want.set(cur, []); }
    else if (line && cur !== null) want.get(cur).push(line);
  }
  check("golden case list", eq(cases.map(c => c.name), Array.from(want.keys())), cases.map(c => c.name).join("|"));
  for (const c of cases) {
    if (c.files) { skipped++; continue; } // FILES: frames carry miniz deflate output, which the JS port does not produce
    const got = c.mk().trace, w = want.get(c.name) || [];
    let i = 0;
    while (i < got.length && i < w.length && got[i] === w[i]) i++;
    check("golden " + c.name, i === got.length && i === w.length,
      `line ${i + 1}\n  got:  ${(got[i] || "<end>").slice(0, 300)}\n  want: ${(w[i] || "<end>").slice(0, 300)}`);
  }
};

groups.link = () => {
  let l = transfer(CLEAN, 1, 60000, 0, 300, "clean climb");
  const top = Math.max(...l.levels(0));
  check("clean climb top", top >= 14, top);
  check("clean climb x2", l.st[0].sent.some(t => t.endsWith("x2")));
  check("clean climb listen", l.st[1].s.state === "Listen" && l.st[1].host.some(h => h.kind === "registered" && h.registered));

  l = new SimLink(cfgOf("N0CALL", false), cfgOf("N1CALL", true), CLEAN, 3);
  l.st[0].s.connect(0, null, "N1CALL");
  l.flush();
  l.runUntil(60, connected);
  l.st[0].s.send(l.now, payload(5000, 1));
  l.runUntil(600, l => l.rx(1).length >= 5000);
  check("unregistered data", bytesEq(l.rx(1), payload(5000, 1)));
  check("unregistered caller", eq(l.st[0].sent.slice(0, 6), ["c26f0", "L4x1", "c54f1", "c54f0", "c49f0", "L4x1"]), l.st[0].sent.slice(0, 6));
  check("unregistered answerer", eq(l.st[1].sent.slice(0, 5), ["c18f1", "c49f2", "c49f2", "c50f2", "c14f2"]), l.st[1].sent.slice(0, 5));
  check("unregistered level 4", Math.max(...l.levels(0)) === 4);

  transfer(CLEAN, 2, 8000, 6000, 400, "both directions");

  const a = text(80000, 3), b = text(3000, 4);
  const raw = transferWith(CLEAN, 5, a, b, M.COMP.OFF, 3000, "text raw"), z = transferWith(CLEAN, 5, a, b, M.COMP.TEXT, 3000, "text z");
  const [rn, rz] = dataFrames(raw, 0), [zn, zz] = dataFrames(z, 0);
  const rt = raw.st[1].progress / SECOND, zt = z.st[1].progress / SECOND;
  check("text compression saves", rz === 0 && zz > 0 && zn <= rn && zt < rt, `raw ${rn} ${rt} text ${zn} (${zz}) ${zt}`);
  check("text answerer compressed", dataFrames(z, 1)[1] > 0);

  const ca = cfgOf("N0CALL", true);
  ca.host.compression = M.COMP.FILES;
  l = new SimLink(ca, cfgOf("N1CALL", false), CLEAN, 5);
  l.st[0].s.connect(0, null, "N1CALL");
  l.flush();
  l.runUntil(300, connected);
  const msg = text(500, 3);
  l.st[0].s.send(l.now, msg);
  l.st[0].s.disconnect(l.now);
  l.flush();
  l.runUntil(300, disconnected);
  check("files staged disconnect", disconnected(l) && bytesEq(l.rx(1), msg));

  l = b2f(4, ["FF\r", "FQ\r"]);
  const s0 = l.st[0].sent;
  check("b2f fq", disconnected(l) && Buffer.from(l.rx(1)).toString() === "FF\rFQ\r" && eq(s0.slice(-2), ["c3f0", "cw"]) &&
    !s0.slice(-4).some(t => t.startsWith("c14")), s0.slice(-6));

  // lossy_channel_delivers_exactly / text_and_files_survive_lossy_channels, a slice of the seeds (LOSSY_SEEDS=n for more)
  const nSeeds = +(process.env.LOSSY_SEEDS || 150);
  let linked = 0, slow = 0, tried = 0;
  for (let seed = 1; seed <= nSeeds; seed++) {
    const ch = [{snr: 20, frameLoss: 0.15, ctrlLoss: 0.1, miss: 0.05}, {snr: 10, frameLoss: 0.3, ctrlLoss: 0.2, miss: 0.1},
      {snr: 30, frameLoss: 0.05, ctrlLoss: 0.3, miss: 0.02}][seed % 3];
    const sizes = [15000, 89, 178, 1, 0, 2873, 341 * 4];
    const r = transfer(ch, seed, Math.max(sizes[seed % 7], 1), sizes[Math.floor(seed / 7) % 7], 30000, "lossy " + seed);
    tried++;
    if (r) { linked++; if (r.slow) slow++; }
  }
  check("lossy linked", linked >= Math.floor(tried * 0.99), linked + "/" + tried);
  check("lossy slow", slow <= Math.ceil(tried / 100), slow);
  linked = 0; tried = 0;
  for (let seed = 1; seed <= Math.min(nSeeds, 400); seed++) {
    const ch = [{snr: 20, frameLoss: 0.15, ctrlLoss: 0.1, miss: 0.05}, {snr: 15, frameLoss: 0.2, ctrlLoss: 0.15, miss: 0.05},
      {snr: 30, frameLoss: 0.05, ctrlLoss: 0.3, miss: 0.02}][seed % 3];
    const comp = seed % 2 === 0 ? M.COMP.TEXT : M.COMP.FILES, sizes = [6000, 89, 1, 0, 2873, 400];
    let a = text(Math.max(sizes[seed % 6], 1), seed);
    if (seed % 5 === 0) a = Uint8Array.of(...a, ...payload(500, seed));
    const b = text(sizes[Math.floor(seed / 6) % 6], seed + 1);
    tried++;
    if (transferWith(ch, seed, a, b, comp, 30000, "lossy comp " + seed)) linked++;
  }
  check("lossy comp linked", linked >= Math.floor(tried * 0.985), linked + "/" + tried);
};

// ───────────────────────── xara-phy/tests/busy.rs
class TRng {
  constructor(seed) { this.s = (BigInt(seed) * 0x9E3779B97F4A7C15n | 1n) & 0xFFFFFFFFFFFFFFFFn; }
  nextU64() {
    let s = this.s;
    s ^= s >> 12n; s ^= (s << 25n) & 0xFFFFFFFFFFFFFFFFn; s ^= s >> 27n;
    this.s = s;
    return (s * 0x2545F4914F6CDD1Dn) & 0xFFFFFFFFFFFFFFFFn;
  }
  uniform() { return Number(this.nextU64() >> 11n) / 9007199254740992; }
  below(n) { return Math.trunc(this.uniform() * n) >>> 0; }
  gauss() { const u = Math.max(this.uniform(), 1e-300), v = this.uniform(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
}
groups.busy = () => {
  const v = json("hf/busy.json");
  const spectrum = (o, n) => { const p = new Float64Array(n); for (const [k, x] of Object.entries(o)) p[+k] = x; return p; };
  for (const c of v.detector1.cases) {
    const bw = bwOf(c.bw);
    check("busy tone band " + c.bw, M.toneBand(bw)[0] === c.bins[0]);
    check("busy tone " + JSON.stringify(c.spectrum).slice(0, 40), M.detectTone(spectrum(c.spectrum, 128), bw) === c.busy);
  }
  const d2 = v.detector2;
  for (const bw of M.BANDWIDTHS) {
    const want = d2.signatures.filter(s => bwOf(s.bw) === bw).map(s => ({record: s.record, carriers: s.carrier_bins, gaps: s.gap_bins}));
    check("busy signatures " + bw.hz, eq(M.signatures(bw), want), JSON.stringify(M.signatures(bw)));
  }
  for (const c of d2.cases) {
    const bw = bwOf(c.bw), sig = M.signatures(bw).find(s => s.record === c.record);
    check("busy threshold", M.signatureThreshold(bw) === c.threshold);
    check("busy signature case", M.detectSignature(spectrum(c.S, 64), sig, M.signatureThreshold(bw)) === c.busy);
  }
  const noise = (r, n, rms) => Float64Array.from({length: n}, () => rms * r.gauss());
  const db = x => Math.pow(10, x / 20);
  const tone = (n, hz, amp) => Float64Array.from({length: n}, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / 48000));
  const add = (a, b) => a.map((x, i) => x + b[i]);
  const run = (b, x) => { const e = []; for (let i = 0; i < x.length; i += 480) { const c = x.subarray(i, i + 480); for (const ed of b.feed(c, false)) e.push([i + c.length, ed]); } return e; };
  for (const bw of M.BANDWIDTHS) {
    let b = new M.Busy(bw);
    check("busy silence " + bw.hz, run(b, new Float64Array(48000 * 3)).length === 0);
    b = new M.Busy(bw);
    run(b, noise(new TRng(7), 48000 * 20, db(-15)));
    check("busy noise " + bw.hz, b.hits[0] === 0 && b.hits[1] <= 3, b.hits);
  }
  {
    const b = new M.Busy(M.BW2300), n = new TRng(3);
    const x0 = noise(n, 48000, db(-30)), burst = add(tone(9600, 1500, db(-20)), noise(n, 9600, db(-30))), x2 = noise(n, 48000 * 3, db(-30));
    const x = new Float64Array(x0.length + burst.length + x2.length);
    x.set(x0); x.set(burst, x0.length); x.set(x2, x0.length + burst.length);
    const e = run(b, x);
    const off = e.length > 1 ? (e[1][0] - 57600) / 48000 : NaN, hang = M.BUSY_HANG * 2048 / 48000;
    check("busy tone hang", eq(e.map(x => x[1]), [true, false]) && off >= hang - 0.09 && off <= hang + 0.05 && e[0][0] < 48000 + 2 * 2048 + 480,
      JSON.stringify(e));
  }
  {
    const n = new TRng(11), sigma = db(-30);
    for (const [binDb, want] of [[8, false], [30, true]]) {
      const b = new M.Busy(M.BW2300), nz = noise(n, 48000 * 2, sigma);
      run(b, add(nz, tone(nz.length, 1500, sigma * Math.sqrt(db(binDb) * db(binDb) / 1024))));
      check("busy tone threshold " + binDb, (b.hits[0] > 0) === want, b.hits);
    }
  }
  {
    const b = new M.Busy(M.BW2300), n = new TRng(13), floor = x => add(x, noise(n, x.length, db(-75)));
    check("busy quiet gated", run(b, floor(tone(48000 * 3, 1500, db(-52)))).length === 0, b.hits);
    const e = run(b, floor(tone(48000, 1500, db(-40))));
    check("busy loud", e.length && e[0][1] === true);
  }
  {
    const rng = new TRng(1);
    for (const [bw, rec] of [[M.BW2300, 5], [M.BW2300, 8], [M.BW2750, 7], [M.BW500, 4]]) {
      const m = new M.Modulator(bw), len = bw.level(rec).frameBytes;
      const frame = Uint8Array.from({length: len}, (_, i) => (i * 37 + 11) & 255);
      const x = m.transmission(rec, [frame], k => rng.below(k));
      let s = 0;
      for (const v of x) s += v * v;
      const rms = Math.sqrt(s / x.length), n = new TRng(5);
      const sig = add(Float64Array.from(x, v => v / rms * db(-25)), noise(n, x.length, db(-25)));
      const b = new M.Busy(bw);
      run(b, noise(n, 48000 * 3, db(-25)));
      const quiet = !b.isOn() && b.hits[0] === 0 && b.hits[1] === 0;
      run(b, sig);
      check("busy psk " + bw.hz + " L" + rec, quiet && b.hits[1] > 0 && b.isOn(), b.hits);
    }
  }
  {
    const b = new M.Busy(M.BW2300);
    check("busy forced on", eq(b.feed(new Float64Array(480), true), [true]));
    let quiet = true;
    for (let i = 0; i < 100; i++) if (b.feed(new Float64Array(480), true).length) quiet = false;
    const e = run(b, new Float64Array(48000 * 2)), t = e.length ? e[0][0] / 48000 : NaN;
    check("busy forced release", quiet && e.length === 1 && !e[0][1] && t >= 1.40 && t <= 1.50, JSON.stringify(e));
  }
};

// ── run
const want = process.argv.slice(2);
for (const [name, fn] of Object.entries(groups)) {
  if (want.length && !want.includes(name)) continue;
  const t0 = Date.now(), f0 = fail;
  try { fn(); } catch (e) { fail++; console.log("FAIL " + name + " threw: " + (e.stack || e)); }
  console.log((fail === f0 ? "ok   " : "FAIL ") + name + " (" + (Date.now() - t0) + " ms)");
}
console.log(pass + " passed, " + fail + " failed" + (skipped ? ", " + skipped + " skipped" : ""));
process.exit(fail ? 1 : 0);
