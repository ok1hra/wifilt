#!/usr/bin/env node
"use strict";
// VARA FM (data/vara-modem.js, FM part) against x0rro/xara's own vectors and
// tests, ported one by one: crates/xara-phy/tests/fm_*.rs, crates/xara-arq/
// tests/fm_*.rs, crates/xara/tests/fm_*.rs. Needs the pinned upstream checkout
// in xara/ (third_party/xara/README.md); XARA_DIR overrides.
// docs/vara-implementace.md §4 phase 5.
//
//   node tools/vara-fm-test.js            all groups
//   node tools/vara-fm-test.js tx frames  only the named groups

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const M = require("../data/vara-modem.js");
const H = require("../data/vara-host.js");

const XARA = process.env.XARA_DIR || path.join(__dirname, "..", "xara");
const VEC = path.join(XARA, "vectors");
if (!fs.existsSync(VEC)) {
  console.error("missing " + VEC + " -- clone x0rro/xara at the commit in third_party/xara/README.md");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log("FAIL " + name + (detail !== undefined ? "  " + detail : "")); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const loadDoc = name => JSON.parse(fs.readFileSync(path.join(VEC, name + ".json"), "utf8"));
const load = name => loadDoc(name).content;
const hexDec = s => Uint8Array.from(Buffer.from(s, "hex"));
const hexEnc = b => Buffer.from(b).toString("hex");
const sha = b => crypto.createHash("sha256").update(Buffer.from(b.buffer ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : b)).digest("hex");
const latin1 = s => Uint8Array.from(s, c => c.charCodeAt(0));
const modeOf = v => v === "WIDE" ? M.FM_WIDE : v === "NARROW" ? M.FM_NARROW : (() => { throw new Error(v); })();
const toneRows = s => s.trim().split(/\s+/).map(r => r.split("+").map(Number));

// xara-testkit's xorshift64* test generator (crates/xara-phy/tests/common/mod.rs)
class Rng {
  constructor(seed) { this.s = (BigInt(seed) * 0x9E3779B97F4A7C15n | 1n) & 0xFFFFFFFFFFFFFFFFn; }
  nextU64() {
    let s = this.s;
    s ^= s >> 12n; s ^= (s << 25n) & 0xFFFFFFFFFFFFFFFFn; s ^= s >> 27n;
    this.s = s;
    return (s * 0x2545F4914F6CDD1Dn) & 0xFFFFFFFFFFFFFFFFn;
  }
  uniform() { return Number(this.nextU64() >> 11n) / 9007199254740992; }
  below(n) { return Math.trunc(this.uniform() * n) >>> 0; }
  gauss() {
    const u = Math.max(this.uniform(), 1e-300), v = this.uniform();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  bytes(n) { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = Number(this.nextU64() & 255n); return o; }
}

const groups = {};

// ---- crates/xara-phy/tests/fm_tx.rs ---------------------------------------------
groups.levels = () => {
  for (const r of loadDoc("fm/levels").records) {
    const bw = modeOf(r.mode), rec = r.record, l = bw.level(rec), id = bw.id + " " + rec;
    check(id + " frame_bytes", l.frameBytes === r.frame_bytes);
    check(id + " spf", l.spf === r.spf);
    check(id + " frame_ticks", l.frameTicks === r.frame_ticks);
    check(id + " payload", M.fmPayloadLen(rec, l.frameBytes, false) === r.payload_direct);
    if (r.payload_with_vias !== null && r.payload_with_vias !== undefined)
      check(id + " payload vias", M.fmPayloadLen(rec, l.frameBytes, true) === r.payload_with_vias);
    check(id + " thr", Math.abs(l.thr - r.snr_threshold_db) < 1e-6);
    check(id + " wide penalty", Math.abs(l.widePenalty - r.wide_penalty_db) < 1e-6);
    if (r.decode_allow_ticks !== null && r.decode_allow_ticks !== undefined) check(id + " decode allow", l.decodeAllow === r.decode_allow_ticks);
    if (r.net_bitrate !== null && r.net_bitrate !== undefined) check(id + " net bps", M.rint(l.netBps) === r.net_bitrate, l.netBps);
    const used = M.usedLen(l.k, l.puncturePeriod);
    check(id + " used", used <= l.n && l.n - used <= 2, used + " of " + l.n);
  }
};

groups.constellations = () => {
  for (const [name, c] of Object.entries(loadDoc("fm_constellations").constellations)) {
    const t = M.fmConstellation(c.bps), tol = c.bps <= 2 ? 1e-14 : 0;
    check(name + " size", t.length === c.points.length);
    let bad = 0;
    c.points.forEach((p, v) => { if (Math.abs(t[v][0] - p[0]) > tol || Math.abs(t[v][1] - p[1]) > tol) bad++; });
    check(name + " points", bad === 0, bad + " off");
  }
};

// Audio through the radix-2 FFT equals upstream's rustfft to rounding, not to
// the bit: a sample may land one LSB the other side of .5. So the length is
// exact, the fingerprint (every 1009th sample) within 1 LSB, and the hash is
// counted rather than required.
let shaExact = 0, shaTotal = 0;
function audio(id, got, want, strict) {
  check(id + " length", got.length === want.n_samples, got.length + " vs " + want.n_samples);
  let worst = 0;
  want.fingerprint.forEach((b, j) => { const a = got[j * 1009]; if (a !== undefined) worst = Math.max(worst, Math.abs(a - b)); });
  const hashOk = sha(got) === want.sha256_int16le;
  shaTotal++; if (hashOk) shaExact++;
  if (strict) check(id + " sha", hashOk, "fingerprint off by " + worst);
  else check(id + " fingerprint", worst <= 1, worst + " LSB");
}
function dataPcm(m, c) {
  const record = c.record, frames = c.frames_hex.map(hexDec), draws = c.draws || [];
  const lead = draws.length / m.bw.level(record).nc;
  let p = 0, bad = false;
  const rand = n => { const v = draws[p++]; if (v === undefined || v >= n) bad = true; return v || 0; };
  const x = M.fmToI16(m.transmission(record, c.key, frames, lead, {driveDb: -5}, rand));
  return [x, !bad && p === draws.length];
}
groups.tx = () => {
  const v = load("fm/fm_tx"), mods = {Narrow: new M.FmModulator(M.FM_NARROW), Wide: new M.FmModulator(M.FM_WIDE)};
  let n = 0;
  for (const c of v.l4) {
    const m = mods[modeOf(c.mode).id], id = `${c.run} ${c.dir} #${c.idx} rec ${c.record}`;
    const [x, used] = dataPcm(m, c);
    check(id + " draws", used);
    audio(id, x, c, false);
    n++;
  }
  check("l4 cases", n === 99, n);
  for (const c of v.levels) {
    const bw = modeOf(c.mode), m = mods[bw.id], id = `${bw.id} rec ${c.record} lead ${c.lead}`;
    const [x, used] = dataPcm(m, c);
    check(id + " draws", used);
    audio(id, x, c, false);
    const t = M.fmTables(bw)[c.record];
    check(id + " perm bytes", eq(c.perm_entry_bytes, [2 + (t.chan.length > 65536 ? 1 : 0), 2 + (t.turbo.length > 65536 ? 1 : 0)]));
  }
  // Control frames are a sum of sines from a table, no FFT: bit-exact.
  for (const c of v.ctrl) {
    const cb = M.FmCodebook.forLink(latin1(c.upstream), latin1(c.downstream));
    audio(`ctrl code ${c.code} lead ${c.lead}`, M.fmToI16(M.fmFrameAudio(cb, c.code, c.lead, -5)), c, true);
  }
  console.log(`  tx: ${shaExact}/${shaTotal} audio hashes bit-exact (the rest within 1 LSB)`);
};

groups.tune = () => {
  for (const d of [-30, -5, 0]) {
    const x = M.fmTuneBlock(d), rms = Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    check("tune len " + d, x.length === M.NFFT);
    check("tune rms " + d, Math.abs(20 * Math.log10(rms) - (d - M.FM_TUNE_BACKOFF_DB)) < 1e-9);
    check("tune peak " + d, x.every(v => Math.abs(v) < 1));
  }
};

// ---- crates/xara-phy/tests/fm_frames.rs ---------------------------------------
groups.frames = () => {
  const f = M.Record0.connect("N0CALL", "N1CALL", "", "", false, false).toBytes();
  check("record0 spec", hexEnc(f) === "004e3043414c4c2000202020202020200020202020202020004e3143414c4c200000080700f8f3", hexEnc(f));
  const r = new M.Record0({...M.Record0.connect("N0CALL-7", "N1CALL-T", "N9DIG", "", true, true),
    kind: M.R0_KIND.PING, hop: 1, compression: 1, aes: true, chainSnr: M.fmSnrByte(12.3)});
  check("record0 round trip", eq(M.Record0.parse(r.toBytes()), r));
  check("record0 too long", M.Record0.connect("N0CALL", "TOOLONGCALL", "", "", false, false).toBytes() === null);
  check("snr byte", eq([M.fmSnrByte(-3), M.fmSnrByte(0.5), M.fmSnrByte(40)], [1, 4, 245]));

  const v = loadDoc("fm/lab_frames");
  for (const c of v.record0) {
    const fr = hexDec(c.frame_hex[0]), p = M.Record0.parse(fr), w = c.record0;
    check("lab r0 parse", !!p);
    if (!p) continue;
    check("lab r0 fields " + w.source, p.source === w.source && p.target === w.target && p.via1 === w.via1 &&
      p.hop === w.hop && p.wide === (w.wide === 1));
    check("lab r0 bytes " + w.source, hexEnc(p.toBytes()) === hexEnc(fr));
  }
  let n = 0;
  for (const c of v.cases) {
    const record = c.record, bw = c.mode === "WIDE" ? M.FM_WIDE : M.FM_NARROW;
    c.frame_hex.forEach((h, i) => {
      const fr = hexDec(h), fl = c.fields[i], id = `lab ${c.mode} rec ${record} #${i}`;
      check(id + " len", fr.length === bw.level(record).frameBytes);
      const d = M.fmParseData(record, fr, false);
      check(id + " parse", !!d);
      if (!d) return;
      check(id + " fields", d.data.length === fl.data_len && d.control.hint === fl.hint &&
        d.control.last === (fl.last === 1) && d.control.full === (fl.full === 1));
      const p = M.fmPayloadLen(record, fr.length, false);
      check(id + " trailer", hexEnc(fr.subarray(p + 1, fr.length - 2)) === fl.trailer);
      const back = M.fmBuildData(record, fr.length, d.data, d.control.compressed, d.control.hint, d.control.last, d.trailer);
      check(id + " rebuild", hexEnc(back) === h);
      n++;
    });
  }
  check("lab data frames", n === 85, n);

  for (const record of [1, 2, 14, 15, 16]) {
    const len = M.FM_NARROW.level(record).frameBytes;
    for (const vias of [false, true]) {
      if (vias && record === M.FM_REC.BROADCAST) continue;
      const t = {leadReport: 27, level: 2, chainSnr: vias ? 99 : null};
      for (const n2 of [0, 1, 5, 400]) {
        const data = Uint8Array.from({length: n2}, (_, i) => i % 3 === 0 ? 0x14 : i & 255);
        const fr = M.fmBuildData(record, len, data, false, 5, true, t);
        const d = M.fmParseData(record, fr, vias), room = M.fmPayloadLen(record, len, vias), id = `layout ${record} ${vias} ${n2}`;
        check(id + " len", fr.length === len);
        check(id + " data", d && hexEnc(d.data) === hexEnc(data.subarray(0, Math.min(n2, room))));
        check(id + " full", d && d.control.full === n2 >= room);
        if (record !== M.FM_REC.BROADCAST)
          check(id + " trailer", d && eq(d.trailer, {...t, level: record === M.FM_REC.START ? 2 : 0}));
      }
    }
  }

  let l = new M.LeadIn();
  check("lead-in a", eq([l.report(8), l.report(29 - 11 + 7), l.report(29 - 8 + 7)], [11, 8, 8]));
  l = new M.LeadIn();
  check("lead-in b", eq([l.report(1), l.dataSymbols()], [1, 1]));
  l = new M.LeadIn();
  check("lead-in c", l.report(2) === 2 && new M.LeadIn().dataSymbols() === 25);
  l = new M.LeadIn();
  for (const r2 of [1, 1, 1]) l.report(r2);
  check("lead-in d", l.report(29) === 2 && l.report(29) === 2);

  let raw = M.Record0.connect("N0CALL", "N1CALL", "N9DIG", "", false, false).toBytes();
  raw = Array.from(raw);
  raw[34] = 0xC0 | 0x08 | 0x04 | 0x31;
  const c2 = M.crc16(raw, 0, raw.length - 2);
  raw[raw.length - 2] = c2 >> 8; raw[raw.length - 1] = c2 & 255;
  raw = Uint8Array.from(raw);
  const rr = M.Record0.parse(raw);
  check("relay bits parse", rr && rr.registered === false && rr.compression === 2);
  check("relay to_bytes", rr && rr.toBytes()[34] === 0x48);
  check("relay restamp", rr && rr.restamp(raw)[34] === 0xCC);
};

groups.codebooks = () => {
  const c = loadDoc("fm/ctrl_codebooks").content;
  const lead = c.leadin_table.flatMap(toneRows);
  check("lead-in table", eq(lead, M.fmLeadIn()));
  const tamper = M.fmCodes(M.TAMPER_KEY);
  for (const [k, r] of Object.entries(c.tamper_codebook_codes_1_22)) check("tamper " + k, eq(toneRows(r), tamper[Number(k) - 1]));
  let n = 0;
  for (const st of c.codebooks) {
    for (const [side, info] of Object.entries(st.sides)) {
      const key = f => parseInt(info[f].replace(/^0x/, ""), 16) >>> 0;
      const kd = key("key_codes_1_22"), ku = key("key_codes_23_24");
      check("kd hash", kd === M.callHash(latin1(info.key_call_1_22)));
      check("ku hash", ku === M.callHash(latin1(info.key_call_23_24)));
      const cb = new M.FmCodebook(kd, ku);
      for (const [code, r] of Object.entries(st.codes[side].fm)) { check(`${st.station} ${side} ${code}`, eq(toneRows(r), cb.code(Number(code)))); n++; }
    }
  }
  check("codebook codes", n === 240, n);
  const v = loadDoc("fm/lab_ctrl"), cb = M.FmCodebook.forLink(latin1("N0CALL"), latin1("N1CALL"));
  n = 0;
  for (const [code, e] of Object.entries(v.codes)) if (e.rows_codebook) { check("on air " + code, eq(toneRows(e.rows_codebook), cb.code(Number(code)))); n++; }
  check("on-air codes", n === 14, n);
  v.code24_wide.rows.forEach((r, i) => {
    check("code 24 row " + (i + 2), eq(r.slice().sort((a, b) => a - b), cb.code(24)[i].slice().sort((a, b) => a - b)));
  });
};

// ---- crates/xara-phy/tests/fm_rx.rs -------------------------------------------
class Stream {
  constructor() { this.x = new Array(12000).fill(0); this.bursts = []; this.rng = new Rng(99); }
  gap(n) { for (let i = 0; i < n; i++) this.x.push(0); }
  push(y) { for (const v of y) this.x.push(v); }
  data(m, record, key, frames, lead) {
    this.push(m.transmission(record, key, frames, lead, {driveDb: -5, preSignal: false}, n => this.rng.below(n)));
    this.bursts.push({record, code: null, frames});
    this.gap(9000);
  }
  ctrl(cb, code, lead) { this.push(M.fmFrameAudio(cb, code, lead, -5)); this.bursts.push({record: null, code, frames: []}); this.gap(9000); }
  noisy(rng, sigma) { return this.x.map(v => v + sigma * rng.gauss()); }
}
function rxRun(rx, x) {
  let ev = [];
  for (let i = 0; i < x.length; i += 480) ev = ev.concat(rx.feed(x.slice(i, i + 480)));
  return ev.concat(rx.flush());
}
function fmPayload(rng, record, bw, n, report) {
  const len = bw.level(record).frameBytes;
  return M.fmBuildData(record, len, rng.bytes(n), false, 3, false, {leadReport: report, level: 0, chainSnr: null});
}
function rxCheck(name, ev, s) {
  const frames = ev.filter(e => e.kind === "frame" && e.frame.ok).map(e => hexEnc(e.frame.bytes));
  const txs = ev.filter(e => e.kind === "tx"), codes = ev.filter(e => e.kind === "ctrl").map(e => e.det.code);
  const wantFrames = s.bursts.flatMap(b => b.frames.map(hexEnc)), wantCodes = s.bursts.filter(b => b.code !== null).map(b => b.code);
  const wantTx = s.bursts.filter(b => b.record !== null).map(b => [b.record, b.frames.length]);
  const gotTx = txs.map(t => [t.record, t.frames.length]);
  check(name + " transmissions", eq(gotTx, wantTx), JSON.stringify(gotTx));
  check(name + " complete", txs.every(t => t.complete));
  check(name + " frames", eq(frames, wantFrames), frames.length + " of " + wantFrames.length);
  check(name + " codes", eq(codes, wantCodes), JSON.stringify(codes));
}
groups.rx = () => {
  const bw = M.FM_NARROW, m = new M.FmModulator(bw), key = M.callHash(latin1("N1CALL"));
  const cb = M.FmCodebook.forLink(latin1("N0CALL"), latin1("N1CALL")), codes = Array.from({length: 24}, (_, i) => i + 1);
  {
    const rng = new Rng(7), s = new Stream();
    s.data(m, 0, 0, [M.Record0.connect("N0CALL", "N1CALL", "", "", false, false).toBytes()], 21);
    s.ctrl(cb, 23, 28); s.ctrl(cb, 14, 28);
    s.data(m, 15, key, [fmPayload(rng, 15, bw, 11, 1)], 25);
    s.ctrl(cb, 7, 1);
    s.data(m, 2, key, [fmPayload(rng, 2, bw, 705, 27)], 1);
    s.ctrl(cb, 1, 1);
    s.data(m, 2, key, [fmPayload(rng, 2, bw, 705, 27), fmPayload(rng, 2, bw, 300, 27)], 1);
    s.ctrl(cb, 6, 1);
    s.data(m, 1, key, [fmPayload(rng, 1, bw, 169, 27)], 1);
    s.data(m, 14, key, [fmPayload(rng, 14, bw, 89, 27)], 1);
    s.data(m, 1, key, [fmPayload(rng, 1, bw, 334, 27), fmPayload(rng, 1, bw, 334, 27)], 2);
    s.ctrl(cb, 4, 2);
    s.data(m, 16, key, [fmPayload(rng, 16, bw, 12, 0)], 9);
    s.ctrl(cb, 3, 2);
    for (const [sigma, seed] of [[0, 1], [0.01, 2], [0.03, 3]]) {
      const rx = new M.FmReceiver(bw, key, [0, 1, 2, 14, 15, 16], 1);
      rx.setCtrl(M.SIDE.SOURCE, cb, codes);
      rxCheck("loopback sigma " + sigma, rxRun(rx, s.noisy(new Rng(seed), sigma)), s);
      check("loopback unexpected frame2 sigma " + sigma, rx.stats.unexpectedFrame2 === 2, rx.stats.unexpectedFrame2);
    }
  }
  {
    const rng = new Rng(9), s = new Stream();
    s.data(m, 1, M.callHash(latin1("N2CALL")), [fmPayload(rng, 1, bw, 20, 1)], 3);
    s.ctrl(M.FmCodebook.forLink(latin1("N3CALL"), latin1("N2CALL")), 1, 3);
    const rx = new M.FmReceiver(bw, key, [1, 14, 15], 1);
    rx.setCtrl(M.SIDE.SOURCE, cb, codes);
    const ev = rxRun(rx, s.noisy(rng, 0.01));
    check("wrong key is silent", ev.length === 0, JSON.stringify(ev.map(e => e.kind)));
  }
  {
    const rng = new Rng(13), f = [fmPayload(rng, 2, bw, 705, 27), fmPayload(rng, 2, bw, 100, 27)];
    const tx = m.transmission(2, key, f, 2, {}, n => rng.below(n));
    const x = new Array(24000).fill(0), a = x.length + 2 * 1152;
    for (const v of tx) x.push(v);
    for (let i = a; i < a + 199 * 1152; i++) x[i] = 0;
    for (let i = 0; i < 24000; i++) x.push(0);
    const rx = new M.FmReceiver(bw, key, [1, 2], 2);
    rx.markTxEnd(20000);
    const txs = rxRun(rx, x).filter(e => e.kind === "tx");
    check("lost frame 1: one transmission", txs.length === 1, txs.length);
    if (txs.length === 1) {
      check("lost frame 1: missing + ok", eq(txs[0].frames.map(fr => [fr.frame.missing, fr.frame.ok]), [[true, false], [false, true]]),
        JSON.stringify(txs[0].frames.map(fr => [fr.frame.missing, fr.frame.ok])));
      check("lost frame 1: frame 2 bytes", hexEnc(txs[0].frames[1].frame.bytes) === hexEnc(f[1]));
    }
  }
};
groups.rx_levels = () => {
  for (const bw of [M.FM_NARROW, M.FM_WIDE]) {
    const m = new M.FmModulator(bw), rng = new Rng(11), key = M.callHash(latin1("N1CALL")), s = new Stream();
    const levels = Array.from({length: bw.numLevels}, (_, i) => i + 1);
    for (const r of levels) s.data(m, r, key, [fmPayload(rng, r, bw, bw.level(r).frameBytes - 10, 5)], 2);
    const rx = new M.FmReceiver(bw, key, levels, 1);
    rxCheck("all levels " + bw.id, rxRun(rx, s.noisy(new Rng(5), 0.002)), s);
  }
};
groups.rx_hiss = () => {
  const bw = M.FM_NARROW, m = new M.FmModulator(bw), key = M.callHash(latin1("N1CALL"));
  for (const [record, n] of [[15, 11], [14, 60], [1, 200]])
    for (const tailMs of [100, 300, 1000])
      for (const level of [0.3, 1.0]) {
        const rng = new Rng(5), s = new Stream(), start = s.x.length;
        s.data(m, record, key, [fmPayload(rng, record, bw, n, 1)], 25);
        const end = s.x.length - 9000;
        s.gap(tailMs * 48);
        let e2 = 0;
        for (let i = start; i < end; i++) e2 += s.x[i] * s.x[i];
        const rms = Math.sqrt(e2 / (end - start));
        const tones = [];
        for (let k = 6; k < 60; k++) tones.push([k * 50, rng.below(1000) / 1000 * 2 * Math.PI]);
        const g = level * rms / Math.sqrt(tones.length / 2);
        for (let i = 0; i < tailMs * 48; i++) {
          const t = i / 48000;
          let v = 0;
          for (const [f, ph] of tones) v += Math.sin(2 * Math.PI * f * t + ph);
          s.x[end + i] = g * v;
        }
        s.gap(48000);
        const rx = new M.FmReceiver(bw, key, [1, 14, 15], 1), txs = [];
        for (let i = 0; i * 480 < s.x.length; i++)
          for (const e of rx.feed(s.x.slice(i * 480, (i + 1) * 480))) if (e.kind === "tx") txs.push([e.frames.length, e.complete, (i + 1) * 480 - end]);
        const what = `hiss rec ${record} tail ${tailMs} ms x${level}`;
        check(what, eq(txs.map(t => [t[0], t[1]]), [[1, true]]) && txs[0][2] < 12000, JSON.stringify(txs));
      }
};

// ---- crates/xara-arq/tests/fm_vectors.rs + fm_session.rs ---------------------------
const r4 = x => { const y = Math.abs(x) * 1e4, r = Math.floor(y + 0.5); return Math.sign(x) * r / 1e4 || 0; };
const fmJson = name => JSON.parse(fs.readFileSync(path.join(VEC, name), "utf8"));
function frameOkAndDecide(bw, ad, h, snr, reg) {
  const s = ad.frameOk(snr, h.record >= 1 && h.record <= 13 ? h.record : 1, bw.numLevels);
  return M.fmDecide(bw, ad, h, s, reg);
}
groups.arq_vectors = () => {
  for (const c of fmJson("fm/hint.json").cases)
    check("hint " + JSON.stringify(c), M.fmQueueHint(modeOf(c.mode), c.level, c.queued_after, c.vias) === c.hint);
  let n = 0;
  const ack = fmJson("fm/ack.json");
  for (const sq of ack.sequences) {
    const bw = modeOf(sq.mode), reg = sq.registered, ad = new M.FmAdaptation();
    let lvl = 15;
    for (const st of sq.steps) {
      if (st.event !== undefined) { ad.frameLost(); lvl = lvl === 14 || lvl === 15 ? 1 : Math.max(lvl - 1, 1); continue; }
      const ctx = sq.name + " " + JSON.stringify(st);
      check(ctx + " level", lvl === st.level, lvl);
      const d = frameOkAndDecide(bw, ad, {record: lvl, hint: st.hint, complete: st.complete}, st.snr, reg);
      check(ctx + " code", d.code === st.code, d.code);
      check(ctx + " next", d.level === st.next_level, d.level);
      check(ctx + " stay reset", d.stayReset === st.explicit_stay_reset);
      check(ctx + " held", r4(d.held) === st.held_snr, d.held);
      ["m0", "m1", "m2", "m3", "m6"].forEach((k, i) => check(ctx + " " + k, r4(d.m[i]) === st[k], d.m[i]));
      check(ctx + " ratio", r4(ad.ratio()) === st.ratio, ad.ratio());
      lvl = d.level;
      n++;
    }
  }
  for (const c of ack.sender) { check("sender " + JSON.stringify(c), M.fmSenderLevelAfter(c.level, c.code) === c.next_level); n++; }
  check("ack cases", n >= 70, n);

  const tim = fmJson("fm/timing.json");
  for (const c of tim.cases) {
    const bw = modeOf(c.mode), vias = c.vias, top = bw.numLevels, ctx = c.mode + " vias " + vias;
    check(ctx + " connect window", M.callerConnectWindow(bw, vias, false) === c.caller_connect_window);
    check(ctx + " connect window scan", M.callerConnectWindow(bw, vias, true) === c.caller_connect_window_activescan);
    let t = new M.FmTiming(bw, vias);
    t.ack(400, 0);
    let sd = c.seed_from_23_24_at_400_ticks;
    check(ctx + " ack seed windows", eq(t.window.slice(1, top + 1), sd.ack_window), JSON.stringify(t.window));
    check(ctx + " ack seed ctrl", t.ctrlWindow() === sd.ctrl_window, t.ctrlWindow());
    check(ctx + " ack seed 14/15", eq(t.window.slice(14, 16), sd.ack_window_rec14_15));
    t = new M.FmTiming(bw, vias);
    t.ctrl(350);
    sd = c.seed_from_14_at_350_ticks;
    check(ctx + " ctrl seed windows", eq(t.window.slice(1, top + 1), sd.ack_window), JSON.stringify(t.window));
    check(ctx + " ctrl seed ctrl", t.ctrlWindow() === sd.ctrl_window);
    for (const w of c.receiver_sync_window) check(ctx + " sync " + w.level, eq(M.receiverSyncWindow(bw, w.level, vias, false), [w.lo, w.hi]));
    for (const w of c.receiver_sync_window_double || []) check(ctx + " sync2 " + w.level, eq(M.receiverSyncWindow(bw, w.level, 0, true), [w.lo, w.hi]));
  }
  const t = new M.FmTiming(M.FM_NARROW, 0);
  t.ack(400, 0);
  for (const sq of tim.ack_sequence_narrow_direct) {
    t.ack(sq.ack_ticks, sq.level);
    const ctx = "ack seq " + sq.level + " " + sq.ack_ticks;
    check(ctx + " means", eq(t.mean.slice(1, 12), sq.means), JSON.stringify(t.mean.slice(1, 12)));
    check(ctx + " windows", eq(t.window.slice(1, 12), sq.windows));
    check(ctx + " 14/15", eq(t.window.slice(14, 16), sq.rec14_15));
    check(ctx + " ctrl", t.ctrlWindow() === sq.ctrl_window);
  }

  // windows_match_lab_timing
  const lt = fmJson("fm/lab_timing.json"), ev = lt.events, bw = M.FM_NARROW;
  const ticks = sec => Math.trunc(Math.trunc(sec * M.SECOND) / M.FM_TICK) + M.DETECT_HOLD;
  const w3 = M.callerConnectWindow(bw, 0, false), retry = ev.find(e => e.what === "caller CONNECT retry, direct");
  check("lab retry", Math.abs(retry.observed_s_after_rec0_end - w3 * M.FM_TICK / M.SECOND - 0.02) < 0.1);
  const tt = new M.FmTiming(bw, 0);
  tt.ack(400, 0); tt.ctrl(128); tt.ack(129, 15);
  const w2 = tt.dataWindow(2), bnd = ev.find(e => e.what.startsWith("ACK window boundary"));
  for (const c of bnd.cases) check("lab ack boundary " + c.ack_end_after_data_end_s, (ticks(c.ack_end_after_data_end_s) <= w2) === c.accepted);
  check("watchdogs", eq([M.fmWatchdog(0), M.fmWatchdog(1), M.fmWatchdog(2)], [16400 * 48, 22400 * 48, 31400 * 48]));
};

function zeroed(rule) { const m = /^zero@([^-]+)-(.+)$/.exec(rule || ""); return m ? [Number(m[1]), Number(m[2])] : null; }
function lostBy(rule, fi, nf, single) {
  if (rule === "mute") return true;
  const z = zeroed(rule);
  if (!z) return false;
  const f2 = 5.376;
  return nf === 2 ? (z[0] < f2 && fi === 0) || (z[1] > f2 + 0.6 && fi === 1) : single(z[0], z[1]);
}
groups.arq_lab = () => {
  const v = fmJson("fm/lab_frames.json"), total = new Map(), delivered = new Map();
  for (const [k, d] of Object.entries(v.checks.delivered_bytes)) total.set(k, d.delivered);
  total.set("f17_poor:ba", 3000);
  let n = 0, ok = 0;
  for (const c of v.cases) {
    const key = c.run + ":" + c.dir, tot = total.get(key);
    if (tot === undefined || c.record === 0 || c.record === 16) continue;
    const bw = modeOf(c.mode), rule = c.rule || "", nf = c.fields.length, base = delivered.get(key) || 0;
    let taken = 0;
    c.fields.forEach((f, fi) => {
      taken += f.data_len;
      const q = Math.max(0, tot - (base + taken)), h = M.fmQueueHint(bw, c.record, q, false);
      n++; if (h === f.hint) ok++;
      check(`lab hint ${key} idx ${c.idx} frame ${fi}`, h === f.hint, h + " vs " + f.hint);
      check(`lab last ${key} idx ${c.idx}`, (q === 0 && (nf === 1 || fi === 1) ? 1 : 0) === f.last);
    });
    let got = 0;
    c.fields.forEach((f, fi) => { if (!lostBy(rule, fi, nf, (t1, t2) => t2 - t1 > 0.1)) got += f.data_len; });
    delivered.set(key, base + got);
  }
  check("lab hints 74/74", ok === 74 && n === 74, ok + "/" + n);

  const info = new Map();
  for (const c of v.cases) info.set(c.run + "|" + c.t.toFixed(4), [c.leadin, c.fields.map(f => f.last === 1)]);
  const ads = new Map();
  n = 0; ok = 0;
  for (const c of v.checks.ack_decisions.cases) {
    const bw = c.run === "f10_wide" ? M.FM_WIDE : M.FM_NARROW, k = c.run + "|" + c.rx;
    if (!ads.has(k)) ads.set(k, new M.FmAdaptation());
    const ad = ads.get(k), obs = c.obs, rec = c.record, nf = c.frames, rule = c.rule || "";
    n++;
    if (rule === "mute") { ad.frameLost(); if (obs === 2) ok++; continue; }
    const [lead, lasts] = info.get(c.run + "|" + c.t.toFixed(4));
    const dur = (lead + nf * bw.level(rec).nsym) * 1152 / 48000;
    const good = Array.from({length: nf}, (_, i) => !lostBy(rule, i, nf, t1 => t1 <= 0.75 * dur));
    const lv = rec >= 1 && rec <= 13 ? rec : 1;
    if (nf === 2) { if (good[0]) ad.frameOk(c.sn, lv, bw.numLevels); else ad.frameLost(); if (!good[1]) ad.frameLost(); }
    let pred;
    if (nf === 2 && good[0] && !good[1]) pred = 11;
    else if (nf === 1 && !good[0]) pred = 2;
    else if (lasts[lasts.length - 1]) { ad.frameOk(c.sn, lv, bw.numLevels); pred = 4; }
    else pred = frameOkAndDecide(bw, ad, {record: rec, hint: c.hint, complete: good[0]}, c.sn, false).code;
    check("lab ack " + JSON.stringify(c).slice(0, 80), pred === obs, pred + " vs " + obs);
    if (pred === obs) ok++;
  }
  check("lab ack decisions 68/68", ok === 68 && n === 68, ok + "/" + n);
};

groups.session = () => {
  const drain = s => { const out = []; let o; while ((o = s.pop())) out.push(o); return out; };
  const ctrlCodes = out => out.filter(o => o.kind === "tx" && o.tx.type === "ctrl").map(o => o.tx.code);
  const deliveredOf = out => out.filter(o => o.kind === "host" && o.ev.kind === "data").flatMap(o => Array.from(o.ev.data));
  const SEC = M.SECOND;
  function textReceiver() {
    const cfg = M.fmConfig(M.FM_NARROW, "N0CALL");
    cfg.host.registered = true; cfg.host.compression = M.COMP.TEXT;
    const s = new M.FmSession(cfg);
    check("session connect", s.connect(0, null, "N1CALL", []));
    drain(s);
    s.onTxDone(SEC);
    const t = SEC + SEC / 2;
    s.onCtrl(t, {code: M.FMC.CONNECT_REPLY_NARROW, leadRow: 1, tEnd: t});
    check("session go ahead", eq(ctrlCodes(drain(s)), [M.FMC.GO_AHEAD]));
    check("session receiving", s.state === "Receiving", s.state);
    s.onTxDone(2 * SEC);
    return [s, 3 * SEC];
  }
  const startFrame = data => {
    const len = M.FM_NARROW.level(15).frameBytes;
    const bytes = M.fmBuildData(15, len, data, true, 2, false, {leadReport: 1, level: 0, chainSnr: null});
    return {record: 15, frames: [{ok: true, bytes, snrDb: 30}], tEnd: 3 * SEC};
  };
  let [s, now] = textReceiver();
  let e = M.tcCompress(latin1("the message "), 10, 1);
  s.onData(now, startFrame(e.bytes));
  let out = drain(s);
  check("compressed expanded", Buffer.from(deliveredOf(out)).toString("latin1") === "the message ".slice(0, e.consumed));
  check("compressed acked", eq(ctrlCodes(out), [M.FMC.ACK_STAY]), JSON.stringify(ctrlCodes(out)));
  [s, now] = textReceiver();
  s.onData(now, startFrame(Uint8Array.of(0)));
  out = drain(s);
  check("bad compressed not delivered", deliveredOf(out).length === 0);
  check("bad compressed nacked", eq(ctrlCodes(out), [M.FMC.NACK]), JSON.stringify(ctrlCodes(out)));
  [s, now] = textReceiver();
  const msg = "[WL2K-5.0-B2FWIHJM$]\r";
  e = M.tcCompress(latin1(msg), 30, 1);
  const d = startFrame(e.bytes);
  d.frames.push({ok: false, bytes: new Uint8Array(0), snrDb: 0});
  s.onData(now, d);
  check("compressed with lost frame 2", Buffer.from(deliveredOf(drain(s))).toString("latin1") === msg.slice(0, e.consumed));
};

// ---- crates/xara/tests/fm_host.rs: two FM TNCs on an audio wire ---------------------
class Client {
  constructor(lab, i) { this.lab = lab; this.i = i; this.lines = []; this.bytes = []; }
  send(s) { this.lab.tnc[this.i].cmdBytes(latin1(s + "\r")); }
  write(b) { this.lab.tnc[this.i].dataBytes(typeof b === "string" ? latin1(b) : b); }
  saw(s) { return this.lines.includes(s); }
  since(i) { return this.lines.slice(i); }
}
class FmLab {
  constructor(bw, calls) {
    this.hosts = calls.map(() => {
      const h = {client: null};
      h.line = x => { if (h.client) h.client.lines.push(x); };
      h.data = x => { if (h.client) for (const v of x) h.client.bytes.push(v); };
      h.hasCmdClient = () => !!h.client; h.hasDataClient = () => !!h.client;
      return h;
    });
    this.tnc = calls.map((c, i) => new H.Tnc(new M.FmStation(M.fmConfig(bw, c), {driveDb: -5}), this.hosts[i]));
    this.wire = calls.map(() => [new Float64Array(480), new Float64Array(480)]);
  }
  attach(i) { const c = new Client(this, i); this.hosts[i].client = c; this.tnc[i].clientConnected(); this.tnc[i].clientConnected(); this.sync(); return c; }
  sync() { for (const t of this.tnc) while (t.input.length) t.service(); }
  step() {
    const n = this.tnc.length;
    for (let i = 0; i < n; i++) {
      const input = n === 2 ? this.wire[1 - i].shift() : new Float64Array(480), out = new Float64Array(480);
      this.tnc[i].process(input, out);
      this.wire[i].push(out);
    }
  }
  runUntil(secs, done) {
    const end = this.tnc[0].station.now + Math.trunc(secs * 48000);
    for (;;) { this.sync(); if (done(this)) return true; if (this.tnc[0].station.now >= end) return false; this.step(); }
  }
}
function firstLine(lab, c, line) {
  const n = c.lines.length;
  c.send(line);
  lab.runUntil(2.0, () => c.lines.length > n);
  return c.since(n)[0] || "";
}
const withoutStatus = c => c.lines.filter(l => !/^(PTT|BUSY|BUFFER) /.test(l) && l !== "IAMALIVE");
function subsequence(want, got) {
  let i = 0;
  return want.every(w => { while (i < got.length) { const g = got[i++]; if (g === w || (w.endsWith(" *") && g.startsWith(w.slice(0, -1)))) return true; } return false; });
}
groups.host = () => {
  {
    const lab = new FmLab(M.FM_NARROW, ["XX0A", "XX0B"]), c = lab.attach(0);
    lab.runUntil(0.1, () => false);
    check("fm mycall", firstLine(lab, c, "MYCALL N0CALL") === "OK");
    check("fm version", firstLine(lab, c, "VERSION") === "VERSION VARA FM v4.4.0");
    for (const l of ["BW2300", "BW500", "CWID ON", "GATEWAY N0CALL", "CONNECT N0CALL N1CALL VIA", "CONNECT N0CALL"])
      check("fm wrong " + l, firstLine(lab, c, l) === "WRONG");
    for (const l of ["CHAT OFF", "COMPRESSION TEXT", "LISTEN ON", "RETRIES 10", "WINLINK SESSION"])
      check("fm ok " + l, firstLine(lab, c, l) === "OK");
    check("fm connect via", firstLine(lab, c, "CONNECT N0CALL N1CALL VIA N9DIG") === "OK");
    const st = lab.tnc[0].station;
    check("fm calling", st.state === "Calling" && st.session.vias.length === 1, st.state);
    const n = c.lines.length;
    check("fm abort", firstLine(lab, c, "ABORT") === "OK");
    const closed = () => ["DISCONNECTED", "CANCELPENDING"].every(w => c.since(n).includes(w));
    check("fm abort closes", lab.runUntil(10, l => l.tnc[0].station.idle() && closed()), c.since(n).join(" | "));
    check("fm connect two vias", firstLine(lab, c, "CONNECT N0CALL N1CALL VIA N9DIG N8DIG") === "OK");
  }
  {
    const lab = new FmLab(M.FM_NARROW, ["XX0A", "XX0B"]), a = lab.attach(0), b = lab.attach(1);
    lab.runUntil(0.1, () => false);
    firstLine(lab, a, "MYCALL N0CALL"); firstLine(lab, b, "MYCALL N1CALL"); firstLine(lab, b, "LISTEN ON");
    const msg = Uint8Array.from({length: 1500}, (_, i) => (i * 7) % 251);
    b.write(msg);
    lab.runUntil(0.2, () => false);
    check("fm link connect", firstLine(lab, a, "CONNECT N0CALL N1CALL") === "OK");
    const got = lab.runUntil(60, () => a.bytes.length >= 1500);
    check("fm link 1500 B from the answerer", got && hexEnc(Uint8Array.from(a.bytes)) === hexEnc(msg),
      a.bytes.length + " B; A " + withoutStatus(a).slice(0, 14).join(" | ") + " ;; B " + withoutStatus(b).slice(0, 14).join(" | "));
    const ga = withoutStatus(a), gb = withoutStatus(b);
    check("fm caller host lines", subsequence(["OK", "UNENCRYPTED LINK", "BITRATE (1)  566 bps TX", "PENDING",
      "CONNECTED N0CALL N1CALL NARROW", "SN *", "BITRATE (1)  566 bps RX"], ga), ga.join(" | "));
    check("fm answerer host lines", subsequence(["UNENCRYPTED LINK", "SN *", "PENDING", "CONNECTED N0CALL N1CALL NARROW",
      "LINK UNREGISTERED", "BITRATE (1)  566 bps TX", "BITRATE (2)  1188 bps TX"], gb), gb.join(" | "));
    a.write("hello from the caller");
    check("fm link caller -> answerer", lab.runUntil(60, () => b.bytes.length >= 21) &&
      Buffer.from(b.bytes).toString("latin1") === "hello from the caller", withoutStatus(b).slice(-8).join(" | "));
    firstLine(lab, a, "DISCONNECT");
    check("fm link idle after disconnect", lab.runUntil(30, l => l.tnc.every(t => t.station.idle())));
    lab.runUntil(0.2, () => false);
    check("fm link disconnected both", a.saw("DISCONNECTED") && b.saw("DISCONNECTED"));
    check("fm link cancelpending", b.lines.slice(-3).includes("CANCELPENDING"), withoutStatus(b).slice(-5).join(" | "));
  }
};

// ---- run ----------------------------------------------------------------------------
const want = process.argv.slice(2);
for (const [name, fn] of Object.entries(groups)) {
  if (want.length && !want.includes(name)) continue;
  const t0 = Date.now(), f0 = fail;
  fn();
  console.log(`${fail === f0 ? "ok  " : "FAIL"} ${name} (${Date.now() - t0} ms)`);
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
