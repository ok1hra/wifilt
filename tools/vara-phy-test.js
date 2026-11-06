#!/usr/bin/env node
"use strict";
// VARA HF physical layer (data/vara-modem.js) against x0rro/xara's own vectors
// and tests (crates/xara-phy/tests/*.rs, ported one by one). Needs the pinned
// upstream checkout in xara/ (third_party/xara/README.md); XARA_DIR overrides.
// No browser, no radio. docs/vara-implementace.md §4 phase 1.
//
//   node tools/vara-phy-test.js            all groups
//   node tools/vara-phy-test.js turbo rx   only the named groups

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const M = require("../data/vara-modem.js");

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
const hexU32 = s => parseInt(String(s).replace(/^0x/, ""), 16) >>> 0;
const hexDec = s => Uint8Array.from(Buffer.from(s, "hex"));
const hexEnc = b => Buffer.from(b).toString("hex");
const sha = b => crypto.createHash("sha256").update(Buffer.from(b.buffer ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : b)).digest("hex");
const words = s => s.trim().split(/\s+/).map(Number);
const latin1 = s => Uint8Array.from(s, c => c.charCodeAt(0));
const num = v => typeof v === "number" ? v : Number(v);
const bwOf = v => M.bandwidth(num(v));
const u16be = v => { const o = new Uint8Array(v.length * 2); v.forEach((x, i) => { o[2 * i] = x >> 8; o[2 * i + 1] = x & 255; }); return o; };
const packbits = bits => { const o = new Uint8Array(Math.ceil(bits.length / 8)); bits.forEach((b, i) => { o[i >> 3] |= b << (7 - (i & 7)); }); return o; };
const packhex = bits => hexEnc(packbits(bits));

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
function randomFrame(rng, nbytes) {
  const f = new Uint8Array(nbytes);
  f.set(rng.bytes(nbytes - 2));
  const c = M.crc16(f, 0, nbytes - 2);
  f[nbytes - 2] = c >> 8; f[nbytes - 1] = c & 255;
  return f;
}
const close = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(Math.abs(b), 1);

const groups = {};

groups.crc_call = () => {
  const c = load("crc_hash_pack");
  for (const [name, v] of Object.entries(c.crc16_genibus))
    check("crc " + name, M.crc16(hexDec(v.hex)) === hexU32(v.crc));
  for (const [call, v] of Object.entries(c.call_hash)) {
    check("crc call " + call, M.crc16(latin1(call)) === hexU32(v.crc_call));
    check("hash " + call, M.callHash(latin1(call)) === hexU32(v.hash));
  }
  for (const [call, v] of Object.entries(c.packed_call)) check("pack " + call, hexEnc(M.packCall(latin1(call))) === v.hex);
  const a = load("alphabet_table");
  for (const [call, h] of Object.entries(a.call_hash)) check("alpha hash " + call, M.callHash(call) === hexU32(h));
  for (const [call, p] of Object.entries(a.packed_call)) check("alpha pack " + call, hexEnc(M.packCall(call)) === p);
  for (const c2 of ["N0CALL", "AB1CD-1", "AB1CD-11", "N0CALL-T", "N0CALL-R", "N0CALL-X", "N0CALL-L", "W1AW-15", "VE3ABCD-9"])
    check("ssid round trip " + c2, M.unpackCall(M.packCall(c2)) === c2);
  for (const bad of ["N0CALL-0", "N0CALL-Q", "N0CALL-20", "N0CALL-25", "N0CALL-"])
    check("bad ssid " + bad, eq(M.packCall(bad), M.packCall("N0CALL")));
};

groups.rnd = () => {
  const c = load("rnd");
  const setup = steps => {
    const r = new M.VbRnd();
    for (const s of steps) {
      if (s === "rnd(-1)") r.rnd(-1);
      else r.randomize(Number(s.slice("randomize(".length, -1)));
    }
    return r;
  };
  for (const [name, sq] of Object.entries(c.sequences)) {
    const r0 = setup(sq.setup);
    check("rnd state0 " + name, r0.state === hexU32(sq.state0));
    let r = r0.clone(), ok = true;
    for (const d of sq.draws) { if (r.nextF32() !== d[0] || r.state !== hexU32(d[1])) ok = false; }
    check("rnd draws " + name, ok);
    for (const [key, want] of Object.entries(sq)) {
      const m = /^randint_(\d+)_x48$/.exec(key);
      if (!m) continue;
      r = r0.clone();
      const got = Array.from({length: 48}, () => r.randInt(Number(m[1])));
      check("rnd " + name + " " + key, eq(got, want));
    }
  }
  for (const [x, want] of Object.entries(c.rnd_negative)) {
    const r = new M.VbRnd(), v = r.rnd(Number(x));
    check("rnd(" + x + ")", v === want.value && r.state === hexU32(want.state));
  }
  const z = c.rnd_zero, r = new M.VbRnd();
  check("rnd zero", r.nextF32() === z.rnd && r.rnd(0) === z.rnd0 && r.rnd(0) === z.rnd0_again && r.state === hexU32(z.state));
  for (const [d, want] of Object.entries(c.randomize_after_rnd_minus1))
    check("randomize(" + d + ")", M.VbRnd.stream(Number(d)).state === hexU32(want));
  for (const [x, want] of Object.entries(c.seed_rnd)) {
    const r2 = new M.VbRnd();
    r2.rnd(0.25); r2.seedRnd(Number(x));
    check("seed_rnd(" + x + ")", r2.state === hexU32(want.state) &&
      eq(Array.from({length: 8}, () => r2.randInt(6)), want.next_randint6_x8));
  }
  for (const e of c.rand_int_float32_edges) {
    const r3 = new M.VbRnd(hexU32(e.state_before)), got = r3.randInt(e.n);
    check("f32 edge " + e.state_before, got === e.rand_int && r3.state === hexU32(e.state_after));
  }
  const r4 = new M.VbRnd(0x123456); r4.advance(); r4.retreat();
  check("retreat inverts advance", r4.state === 0x123456);
};

groups.seq = () => {
  const c = load("sequences"), w = c.whitening;
  const bits = M.whitening(M.HF_SEED), bs = a => Array.from(a).join("");
  check("whitening n", bits.length === w.n);
  check("whitening ones", bits.reduce((a, b) => a + b, 0) === w.ones);
  check("whitening first 256", bs(bits.subarray(0, 256)) === w.first_256);
  check("whitening 10000", bs(bits.subarray(10000, 10064)) === w.bits_10000_10063);
  check("whitening tail", bs(bits.subarray(149936)) === w.bits_149936_149999);
  check("whitening sha", sha(packbits(Array.from(bits))) === w.sha256_packbits);
  check("fm whitening", bs(M.whitening(M.FM_SEED).subarray(0, 256)) === c.fm_whitening_randomize43_first_256);
  const v = c.psk_phasor_index, d = M.pskPhasorIndex();
  check("psk phasor rows", d.every((row, i) => !v.rows[i] || eq(Array.from(row, x => x % 128), words(v.rows[i]))));
  const flat = rows => Uint8Array.from(rows.flatMap(r => Array.from(r, x => x % 128)));
  check("psk phasor sha", sha(flat(d)) === v.sha256_int8);
  check("data_dat sha", sha(M.dataDat()) === c.data_dat.sha256);
  const o = c.ofdm_phasor_index, od = M.ofdmPhasorIndex();
  check("ofdm phasor sha", sha(flat(od)) === o.sha256_int8);
  for (let k = 8; k < 13; k++) check("ofdm bin " + k, eq(Array.from(od[k].subarray(0, 16)), words(o.bins_8_12_m_0_15[k - 8])));
  check("ofdm bin 8 400..420", eq(Array.from(od[8].subarray(400, 421)), words(o.bin_8_m_400_420)));
};

groups.dat = () => {
  const c = load("dat_tables");
  for (const bw of M.BANDWIDTHS) {
    const t = M.hfTables(bw), v = c[String(bw.hz)];
    for (const [r, rec] of Object.entries(v.records)) {
      const tr = t[Number(r) - 1], w = bw.hz + " r" + r;
      check(w + " chan", sha(u16be(tr.chan)) === rec.sha256_chan_u16be);
      check(w + " turbo", sha(u16be(tr.turbo)) === rec.sha256_turbo_u16be);
      check(w + " other", sha(u16be(tr.other)) === rec.sha256_other_u16be);
      const l = bw.level(Number(r)), hu = x => typeof x === "number" ? x : hexU32(x);
      check(w + " offset", M.datOffsets(bw)[Number(r) - 1] === hu(rec.offset) && l.n === hu(rec.N) &&
        l.k === hu(rec.K) && l.otherLen === hu(rec.other_len));
    }
    const d = M.hfDat(bw);
    check(bw.hz + " dat len", d.length === v.table_segment_len);
    check(bw.hz + " dat crc", ((d[d.length - 2] << 8) | d[d.length - 1]) === hexU32(v.crc_stored_be));
  }
  const want = {500: "020cf75a54c772ade64cdb45b52053beef3223b5bdb4847da1354d03627ed956",
    2300: "2c823ce719944dccf90194129b7c95f91b9add7c33a46bb0c80b8401d0edcfe5",
    2750: "e3e516f70f7710dc7992196573ce0141f5604d978e2701dced26eb06de3aede6"};
  for (const bw of M.BANDWIDTHS) check(bw.hz + " dat sha", sha(M.hfDat(bw)) === want[bw.hz]);
};

groups.levels = () => {
  const c = load("levels");
  for (const bw of M.BANDWIDTHS) {
    const key = String(bw.hz), offs = M.datOffsets(bw);
    check(key + " num levels", bw.numLevels === c.num_levels[key]);
    for (let r = 1; r <= M.RECORDS; r++) {
      const l = bw.level(r), v = c.modes[key][String(r)], w = key + " L" + r;
      if (l.wf === "fsk") check(w + " fsk", v.kind === "FSK" && eq([l.symbols, l.sps, l.first, l.last, l.step], [v.S, v.sps, v.first, v.last, v.step]));
      else if (l.wf === "psk") check(w + " psk", v.kind === "PSK" && eq([l.spf, l.markers, l.nc], [v.spf, v.markers, v.nc]) &&
        eq(l.fc, v.fc) && close(l.span, v.pulse_span, 1e-6));
      else check(w + " ofdm", v.kind === "OFDM" && eq([l.spf, l.markers, l.nc, l.first], [v.spf, v.markers, v.nc, v.first]));
      check(w + " fields", l.sps === v.sps && l.bps === v.bps && l.rate === v.rate && l.extra === v.extra &&
        (l.skip ? 1 : 0) === v.skip_on_step_down && close(l.thr, v.thr, 1e-6) && close(l.papr, v.papr_db, 1e-6));
      const got = [l.n, l.k, l.pad, l.otherLen, offs[r - 1], l.frameBytes, l.payload, l.leadIn, l.dataSymbols];
      const exp = [v.N, v.K, v.pad, v.other, v.offset, v.frameBytes, v.payload, v.lead, v.nsym];
      check(w + " sizes", eq(got, exp), JSON.stringify([got, exp]));
      check(w + " timing", close(l.symbolPeriod, v.T, 1e-6) && close(l.airtime, v.airtime, 1e-6) && close(l.netBps, v.netbps, 1e-6));
    }
  }
};

function chainEncode(bw, record, frame) {
  const l = bw.level(record), t = M.tables(bw)[record - 1];
  const info = M.frameBits(frame, l.k);
  M.whiten(info, M.hfWhitening());
  const coded = M.turboEncode(info, t.turbo, l.puncturePeriod, l.n);
  return [info, coded, M.interleave(coded, t.chan)];
}
function checkChain(f, what) {
  const bw = bwOf(f.mode), record = num(f.level), frame = hexDec(f.frame_hex);
  check(what + " crc", M.crcOk(frame));
  check(what + " len", frame.length === bw.level(record).frameBytes);
  const [info, coded, tx] = chainEncode(bw, record, frame);
  check(what + " info", packhex(Array.from(info)) === f.info_whitened_hex);
  check(what + " coded", packhex(Array.from(coded)) === f.coded_hex);
  check(what + " tx", packhex(Array.from(tx)) === f.tx_hex);
}

groups.frames = () => {
  const marker = M.termMarker("N0CALL");
  for (const name of ["frames_500", "frames_2300", "frames_2750"]) {
    for (const f of load(name).frames) {
      const bw = bwOf(f.mode), record = num(f.level), len = bw.level(record).frameBytes, what = name + " L" + record + " " + f.kind;
      const dataCtrl = {reply: 2, compressed: false, hint: 6};
      let built;
      if (f.kind === "data_full") built = M.buildFrame(len, Uint8Array.from({length: len - 3}, (_, i) => (167 * i + 13) % 256), dataCtrl, null, marker);
      else if (f.kind === "session_header") built = M.buildFrame(len, M.headerPayload("N0CALL", 0x80), {reply: 2, compressed: false, hint: 0}, record, marker);
      else built = M.buildFrame(len, latin1("HELLO VARA"), dataCtrl, null, marker);
      check(what + " build", hexEnc(built) === f.frame_hex);
      checkChain(f, what);
    }
  }
  const vf = load("vara_frames").frames;
  check("vara_frames count", vf.length === 39);
  vf.forEach((f, i) => checkChain(f, "vara_frames[" + i + "] " + f.mode + " L" + f.level + " " + f.kind));
  for (const b of [0x99, 0x89, 0x59, 0x19, 0x82, 0x4b, 0x0b, 0xa2]) {
    const [c, last, full] = M.ctrlFromByte(b);
    check("control byte " + b, M.ctrlByte(c, last, full) === b);
  }
};

groups.turbo = () => {
  let rng = new Rng(1);
  for (const bw of M.BANDWIDTHS) {
    const m = new M.Modulator(bw), d = new M.FrameDecoder(bw);
    for (const rec of bw.levels()) {
      const l = bw.level(rec), frame = randomFrame(rng, l.frameBytes), tx = m.encode(rec, frame);
      const llr = Float64Array.from(tx, b => (1 - 2 * b) * 2 + rng.gauss());
      const out = d.decode(rec, llr);
      check("turbo " + bw.hz + " L" + rec, out.ok && eq(out.bytes, frame) && out.iterations < 10, "iter " + out.iterations);
    }
  }
  rng = new Rng(2);
  const d = new M.FrameDecoder(M.BW2300);
  for (const rec of [1, 5, 12]) {
    const llr = Float64Array.from({length: M.BW2300.level(rec).n}, () => rng.gauss());
    const out = d.decode(rec, llr);
    check("turbo noise fails L" + rec, !out.ok && out.iterations === 10);
  }
};

const fmtSymbols = cw => cw.map(t => t.join("+")).join(" ");
groups.ctrl = () => {
  for (const bw of M.BANDWIDTHS) {
    const c = load("ctrl_codebooks_" + bw.hz);
    for (const b of c.codebooks) {
      const what = bw.hz + " " + b.station + " " + b.phase;
      const h = b.mycall_hashes.map(hexU32), role = b.role === 0 ? M.ROLE.ANSWERER : M.ROLE.CALLER;
      const cb = new M.Codebook(hexU32(b.seed), h, role, bw);
      if (b.connect_seed !== null && b.connect_seed !== undefined) cb.setConnectCodes(hexU32(b.connect_seed), role);
      let bad = 0, first = "";
      for (const [side, fmts] of Object.entries(b.codes))
        for (const [fmt, codes] of Object.entries(fmts)) {
          const f = Number(fmt.replace("fmt", ""));
          for (const [code, want] of Object.entries(codes)) {
            if (code === "45") continue;
            const got = side === "side0" ? cb.rx(f, Number(code)) : cb.tx(f, Number(code));
            if (fmtSymbols(got) !== want) { bad++; first = first || side + " " + fmt + " code " + code; }
          }
        }
      check("codebook " + what, bad === 0, bad + " wrong, first " + first);
    }
  }
  const lab = loadDoc("kiss/xara_lab"), grids = M.leadinGrids(), codes = lab.announce_codes;
  check("announce codes count", Object.keys(codes).length === 4);
  for (const bw of M.BANDWIDTHS) {
    const cb = new M.Codebook(0, [M.callHash("N0CALL"), 0, 0, 0, 0], M.ROLE.CALLER, bw);
    const listen = new M.Codebook(0, [M.callHash("N1CALL"), 0, 0, 0, 0], M.ROLE.ANSWERER, bw);
    for (const [code, a] of Object.entries(codes)) {
      const got = [grids[0][0]].concat(cb.tx(0, Number(code))).map(s => s[0]);
      check("announce " + bw.hz + " code " + code, eq(got, a.tones));
      for (let f = 0; f < 3; f++) check("announce rx=tx " + bw.hz + " " + code + " " + f, eq(cb.tx(f, Number(code)), listen.rx(f, Number(code))));
    }
  }
  const n0 = M.callHash("N0CALL"), n1 = M.callHash("N1CALL");
  const caller = new M.Codebook(n1, [n0, 0, 0, 0, 0], M.ROLE.CALLER, M.BW2300);
  const answerer = new M.Codebook(n1, [n1, 0, 0, 0, 0], M.ROLE.ANSWERER, M.BW2300);
  const w = load("alphabet_table").codewords_N0CALL_to_N1CALL_2300;
  check("spec caller 26", fmtSymbols(caller.tx(0, 26)) === w.caller_tx_code26_fmt0);
  check("spec answerer 18", fmtSymbols(answerer.tx(1, 18)) === w.answerer_tx_code18_fmt1);
  check("spec answerer 1", fmtSymbols(answerer.tx(2, 1)) === w.answerer_tx_code1_fmt2);
  const lg = load("ctrl_leadin_grids");
  for (let f = 0; f < 3; f++) {
    check("leadin grid fmt" + f, eq(grids[f].map(t => fmtSymbols([t])), lg.grids["fmt" + f]));
    const n = lg.leadin_symbols["fmt" + f];
    check("leadin symbols fmt" + f, M.leadinSymbols(f, 1, 0) === n.short && M.leadinSymbols(f, 49, 0) === n.long_14_21_49_50 &&
      M.leadinSymbols(f, 1, 9) === n["first_while_calling_+9"] && M.leadinSymbols(f, 1, 7) === n["first_while_answering_+7"]);
  }
  const refs = load("audio_2300");
  const normalise = x => {
    let s = 0;
    for (const v of x) s += v * v;
    const rms = Math.sqrt(s / x.length), n = x.length, ramp = i => Math.min(i / 240, 1), out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const v = Math.fround(Math.min(0.95, Math.max(-0.95, (x[i] / (rms + 1e-12) * 0.12) * ramp(i) * ramp(n - 1 - i))));
      const y = v * 32767, r = Math.round(y);
      out[i] = Math.abs(y % 1) === 0.5 ? 2 * Math.round(y / 2) : r;
    }
    return out;
  };
  for (const [id, mycall, remote, code, fmt, extra] of [
    ["ctrl_N2CALL_to_N1CALL_code26_fmt0_lead10", "N2CALL", "N1CALL", 26, 0, 9],
    ["ctrl_N2CALL_to_N1CALL_code54_fmt1", "N2CALL", "N1CALL", 54, 1, 0],
    ["ctrl_N2CALL_to_N1CALL_code49_fmt0", "N2CALL", "N1CALL", 49, 0, 0]]) {
    const hm = M.callHash(mycall), hr = M.callHash(remote);
    const cb = new M.Codebook(hr, [hm, 0, 0, 0, 0], M.ROLE.CALLER, M.BW2300);
    cb.setConnectCodes(hm, M.ROLE.CALLER);
    const x = normalise(M.ctrlSynth(grids[fmt].slice(0, M.leadinSymbols(fmt, code, extra)), cb.tx(fmt, code)));
    check("ctrl audio " + id, x.length === refs[id].n_samples && sha(x) === refs[id].sha256_int16le);
  }
};

function varaOrder(l, nframes, old) {
  const lead = l.leadIn;
  if (l.wf === "fsk") { let o = []; for (let i = 0; i < nframes; i++) o = o.concat(old); return o; }
  if (l.wf === "psk") {
    const nc = l.nc, block = lead + nframes, out = [];
    for (let f = 0; f < nframes; f++) for (let c = 0; c < nc; c++) out.push(old[c * block + lead + f]);
    for (let k = 0; k < lead; k++) for (let c = 0; c < nc; c++) out.push(old[c * block + k]);
    return out;
  }
  const nc = l.nc, set = [];
  for (let b = 0; b < nc; b++) for (let r = 0; r < lead; r++) set.push(old[r * nc + b]);
  let out = [];
  for (let i = 0; i < (nframes > 1 ? 3 : 1); i++) out = out.concat(set);
  return out;
}

groups.tx = () => {
  let checked = 0;
  for (const name of ["frames_500", "frames_2300", "frames_2750", "vara_frames"]) {
    for (const f of load(name).frames) {
      const want = f.fsk_tones_rows_2_S;
      if (want === undefined || want === null) continue;
      const bw = bwOf(f.mode), m = new M.Modulator(bw), record = num(f.level);
      const got = M.fskRows(bw.level(record), m.tables[record - 1].other, m.encode(record, hexDec(f.frame_hex)));
      const w = words(want);
      check("fsk rows " + name + " " + f.mode + " L" + record + " " + f.kind, eq(Array.from(got.subarray(0, w.length)), w));
      checked++;
    }
  }
  check("fsk rows checked > 40", checked > 40, checked);
  const m = new M.Modulator(M.BW2300), refs = load("audio_2300"), draws = load("xara_audio_draws");
  checked = 0;
  for (const [id, cs] of Object.entries(draws)) {
    const frames = cs.frames_hex.map(hexDec), rec = num(cs.level), l = m.bw.level(rec);
    const order = varaOrder(l, frames.length, cs.draws);
    let p = 0, bad = false;
    const rand = n => { const v = order[p++]; if (v === undefined || v >= n) bad = true; return v || 0; };
    const x = m.transmission(rec, frames, rand);
    check(id + " draws used", !bad && p === order.length);
    const r = refs[id], n = num(r.n_samples);
    let skip, tail, lo, hi;
    if (l.wf === "fsk") { check(id + " len", x.length === n); skip = l.leadIn * 16 * l.sps; tail = 16 * l.sps; lo = -99; hi = -75; }
    else if (l.wf === "psk") {
      check(id + " len", x.length === n, x.length + " vs " + n);
      [lo, hi] = l.span === 0.5 ? [-99, -75] : l.span === 1 ? [-40, -36] : [-53, -48];
      skip = 8 * 512 + 2560; tail = 4096;
    } else { check(id + " len", x.length + M.NWIN === n); skip = 240; tail = 1152; lo = -99; hi = -75; }
    const every = num(r.fingerprint_every), fp = r.fingerprint_int16;
    let ab = 0, aa = 0;
    const pts = [];
    for (let j = 0; j < fp.length; j++) { const i = j * every; if (i >= skip && i < x.length - tail) pts.push([x[i], fp[j]]); }
    for (const [a, b] of pts) { ab += a * b; aa += a * a; }
    const g = ab / aa;
    let e = 0, bb = 0;
    for (const [a, b] of pts) { e += (b - g * a) ** 2; bb += b * b; }
    const db = 10 * Math.log10(e / bb);
    check(id + " body residual", db > lo && db < hi, db.toFixed(1) + " dB, want " + lo + ".." + hi);
    checked++;
  }
  check("audio bodies checked", checked === 10, checked);
};

groups.tx_levels = () => {
  const doc = loadDoc("tx_levels"), grids = M.leadinGrids();
  const cb = new M.Codebook(1, [2, 0, 0, 0, 0], M.ROLE.CALLER, M.BW2300);
  cb.setConnectCodes(2, M.ROLE.CALLER);
  const mods = M.BANDWIDTHS.map(b => new M.Modulator(b)), rng = new Rng(3);
  const peak = x => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const rms = x => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  const cl = (a, b, tol, w) => check(w, Math.abs(a - b) <= tol * Math.abs(b), a + " vs " + b);
  let checked = 0;
  for (const r of doc.rows) {
    const w = r.waveform, d = r.drive_db, what = w + " at " + d;
    let m;
    if ((m = /^ctrl fmt(\d)/.exec(w))) {
      const fmt = Number(m[1]), x = M.frameAudio(grids, cb, fmt, 7, 0), g = M.ctrlGain(fmt, d);
      cl(rms(x), 1, 1e-9, what + " rms1");
      cl(g * 2 / M.FORMATS[fmt].norm, r.tone_amplitude, 1e-12, what + " amp");
      cl(rms(x) * g, r.rms, 1e-9, what + " rms");
      check(what + " peak", peak(x) * g <= r.peak_bound * (1 + 1e-12));
    } else if (w.startsWith("FSK")) {
      for (const mo of mods)
        for (let rec = 1; rec <= M.RECORDS; rec++) {
          if (!mo.bw.level(rec).isFsk) continue;
          const fr = randomFrame(rng, mo.bw.level(rec).frameBytes);
          const x = mo.transmission(rec, [fr], n => rng.below(n));
          cl(peak(x) * mo.gain(rec, d), r.tone_amplitude, 1e-3, what + " " + mo.bw.hz + " L" + rec + " amp");
          cl(rms(x) * mo.gain(rec, d), r.rms, 2e-3, what + " " + mo.bw.hz + " L" + rec + " rms");
        }
    } else if (w.startsWith("CW ID")) {
      const g = Math.pow(10, (d - M.CWID_BACKOFF_DB) / 20);
      cl(1.6 * g, r.amp_1500, 1e-12, what + " amp");
      cl(peak(M.cwSynth("N1CALL", 0, false)) * g, r.peak, 1e-6, what + " peak");
    } else if (w.startsWith("TUNE")) {
      cl(peak(M.tuneSymbol(d)), r.tone_amplitude, 1e-12, what);
    } else if ((m = /^ATU tone \(current ctrl format fmt(\d)/.exec(w))) {
      const fmt = Number(m[1]), x = M.atuTone(fmt);
      check(what + " len", x.length === (M.ATU_SYMBOLS + M.ATU_SILENT_SYMBOLS) * M.SYMBOL_SAMPLES);
      cl(peak(x) * M.ctrlGain(fmt, d), r.tone_amplitude, 1e-12, what);
      check(what + " i16", Math.round(M.quantise(peak(x) * M.ctrlGain(fmt, d)) * 32767) === r.peak_i16);
    } else {
      const p = w.split(/\s+/).slice(2), bw = M.bandwidth(p[0]), rec = Number(p[1].slice(1));
      const mo = mods.find(x => x.bw === bw);
      cl(mo.gain(rec, d), r.gain, 1e-6, what + " gain");
      cl(bw.ampNorm(rec), r.ampNorm, 1e-6, what + " ampNorm");
      if (d === -5) {
        const fr = randomFrame(rng, bw.level(rec).frameBytes);
        const x = mo.transmission(rec, [fr], n => rng.below(n));
        cl(rms(x), r.rms_expected / r.gain, 0.025, what + " rms");
      }
    }
    checked++;
  }
  check("tx_levels rows", checked === 5 * 43, checked);
  check("quantise", M.quantise(1.7) === 1 && M.quantise(-3) === -1 && M.quantise(2.5 / 32767) * 32767 === 2 && M.quantise(3.5 / 32767) * 32767 === 4);
  const a = loadDoc("tx_atu_tune").atu_tone, x = M.atuTone(1), n = a.samples;
  check("atu shape", M.ATU_SYMBOLS === a.symbols && M.ATU_SILENT_SYMBOLS === a.silent_tail_symbols);
  check("atu silent tail", x.subarray(n).every(v => v === 0));
  const k = a.freq_hz / 48000 * M.SYMBOL_SAMPLES, wv = 2 * Math.PI * k / M.SYMBOL_SAMPLES;
  check("atu tone", x.subarray(0, n).every((v, i) => Math.abs(v - Math.sin(wv * (i % M.SYMBOL_SAMPLES)) / Math.SQRT2) < 1e-12));
};

groups.cwid = () => {
  check("N0CALL units", M.cwUnits("N0CALL").length === 76 && M.cwSynth("N0CALL", 0, false).length === 76 * M.CW_UNIT);
  const x = M.cwSynth("N1CALL", 9, false), U = M.CW_UNIT;
  check("cwid len", x.length === (63 + 74) * U);
  check("cwid blanks", x.subarray(0, 63 * U).every(v => v === 0));
  const peak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  check("cwid peak", Math.abs(peak - 2.187664811) < 1e-6, peak);
  const w = 2 * Math.PI / U;
  check("cwid first sample", Math.abs(x[63 * U] - 1.6 * Math.sin(64 * w) - 0.8 * Math.sin(32 * w)) < 1e-12);
  check("cwid 750 Hz carries on", x.subarray((63 + 5) * U, (63 + 6) * U).some(v => v !== 0));
  check("cwid ra board", M.cwSynth("N1CALL", 0, true).subarray(5 * U, 6 * U).every(v => v === 0));
};


// ── receiver loopback (crates/xara-phy/tests/rx_loop.rs)
function normalise12(x) {
  let s = 0;
  for (const v of x) s += v * v;
  const rms = Math.sqrt(s / x.length);
  return Float64Array.from(x, v => v / (rms + 1e-12) * 0.12);
}
function burst(rng, m, rec, frames, noise) {
  const tx = normalise12(m.transmission(rec, frames, n => rng.below(n)));
  const x = new Float64Array(24000 + tx.length + 24000);
  x.set(tx, 24000);
  for (let i = 0; i < x.length; i++) x[i] += noise * rng.gauss();
  return x;
}
function runRx(rx, x) {
  let ev = [];
  for (let i = 0; i < x.length; i += 480) ev = ev.concat(rx.feed(x.subarray(i, Math.min(i + 480, x.length))));
  return ev.concat(rx.flush());
}
const decodedOk = ev => ev.filter(e => e.kind === "frame" && e.frame.ok).map(e => hexEnc(e.frame.bytes));
function shiftHz(x, hz) {
  let n = 1;
  while (n < x.length) n <<= 1;
  n *= 2;
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(x);
  M.fft(re, im, -1);
  for (let k = 0; k < n; k++) { const g = k === 0 ? 1 : k < n / 2 ? 2 : 0; re[k] *= g; im[k] *= g; }
  M.fft(re, im, 1);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const a = 2 * Math.PI * hz * i / 48000, c = Math.cos(a), s = Math.sin(a);
    out[i] = (re[i] / n) * c - (im[i] / n) * s;
  }
  return out;
}

groups.rx_single = () => {
  const rng = new Rng(7);
  for (const bw of M.BANDWIDTHS) {
    const m = new M.Modulator(bw);
    for (const rec of bw.levels()) {
      const frame = randomFrame(rng, bw.level(rec).frameBytes), x = burst(rng, m, rec, [frame], 0.002);
      const t0 = Date.now(), rx = new M.Receiver(bw, [rec], 1, null), ev = runRx(rx, x);
      const txs = ev.filter(e => e.kind === "tx").length, got = decodedOk(ev);
      check("rx single " + bw.hz + " L" + rec, eq(got, [hexEnc(frame)]) && txs === 1,
        got.length + " decoded, " + txs + " tx, " + (Date.now() - t0) + " ms for " + (x.length / 48000).toFixed(1) + " s");
    }
  }
};

groups.rx_double = () => {
  const rng = new Rng(8);
  for (const [bw, recs] of [[M.BW2300, [1, 4, 5, 9, 12, 15]], [M.BW500, [2, 4, 9]], [M.BW2750, [7, 16]]]) {
    const m = new M.Modulator(bw);
    for (const rec of recs) {
      const n = bw.level(rec).frameBytes, f1 = randomFrame(rng, n), f2 = randomFrame(rng, n);
      const ev = runRx(new M.Receiver(bw, [rec], 2, null), burst(rng, m, rec, [f1, f2], 0.002));
      const tx = ev.filter(e => e.kind === "tx");
      check("rx double " + bw.hz + " L" + rec, eq(decodedOk(ev), [hexEnc(f1), hexEnc(f2)]) && tx.length === 1 && tx[0].complete,
        decodedOk(ev).length + " decoded, " + tx.length + " tx");
    }
  }
  const rng2 = new Rng(9), m = new M.Modulator(M.BW2300);
  for (const rec of [3, 6, 10]) {
    const n = M.BW2300.level(rec).frameBytes, f1 = randomFrame(rng2, n), f2 = randomFrame(rng2, n);
    const ev = runRx(new M.Receiver(M.BW2300, [rec], 1, null), burst(rng2, m, rec, [f1, f2], 0.002));
    check("rx unexpected frame 2 L" + rec, eq(decodedOk(ev), [hexEnc(f1), hexEnc(f2)]), decodedOk(ev).length);
  }
};

groups.rx_offsets = () => {
  const rng = new Rng(10), bw = M.BW2300, m = new M.Modulator(bw);
  for (const rec of bw.levels()) {
    for (const hz of [-30, 25]) {
      const frame = randomFrame(rng, bw.level(rec).frameBytes);
      const x = shiftHz(burst(rng, m, rec, [frame], 0), hz);
      const l = bw.level(rec), noise = l.bps >= 4 && !l.isFsk ? 0.004 : 0.03;
      for (let i = 0; i < x.length; i++) x[i] += noise * rng.gauss();
      const near = [rec - 1, rec, rec + 1].filter(r => r >= 1 && r <= M.RECORDS);
      const ev = runRx(new M.Receiver(bw, near, 1, null), x);
      check("rx offset L" + rec + " " + hz + " Hz", decodedOk(ev).includes(hexEnc(frame)));
    }
  }
};

groups.rx_ctrl = () => {
  const rng = new Rng(11), grids = M.leadinGrids();
  for (const bw of M.BANDWIDTHS) {
    const cb = new M.Codebook(M.callHash("N1CALL"), [M.callHash("N2CALL"), 0, 0, 0, 0], M.ROLE.CALLER, bw);
    cb.setConnectCodes(M.callHash("N2CALL"), M.ROLE.CALLER);
    const entries = M.rxEntries(cb, 0);
    for (const [fmt, code, hz] of [[0, 1, 0], [1, 7, 30], [2, 49, -60], [0, 12, 90], [2, 5, 0]]) {
      const lead = grids[fmt].slice(0, M.leadinSymbols(fmt, code, 0));
      const sig = normalise12(M.ctrlSynth(lead, cb.rx(fmt, code)));
      const x0 = new Float64Array(24000 + sig.length + 24000);
      x0.set(sig, 24000);
      const x = shiftHz(x0, hz);
      for (let i = 0; i < x.length; i++) x[i] += 0.02 * rng.gauss();
      const ev = runRx(new M.Receiver(bw, [], 1, entries), x), got = ev.filter(e => e.kind === "ctrl");
      const w = bw.hz + " fmt" + fmt + " code " + code;
      check("rx ctrl " + w, got.length === 1 && got[0].det.code === code && got[0].det.fmt === fmt &&
        Math.abs(got[0].afcHz - hz) < 6 && got[0].det.hits >= M.FORMATS[fmt].minHits,
        JSON.stringify(got.map(g => [g.det.code, g.det.fmt, g.afcHz.toFixed(1), g.det.hits])));
    }
  }
};

groups.rx_noise_tail = () => {
  const rng = new Rng(11);
  for (const bw of M.BANDWIDTHS) {
    const m = new M.Modulator(bw);
    for (const rec of bw.levels()) {
      for (const [burstMs, clicks, lateOk] of [[30, 0, false], [100, 0, false], [0, 20, false], [1000, 0, true]]) {
        const frame = randomFrame(rng, bw.level(rec).frameBytes);
        const tx = normalise12(m.transmission(rec, [frame], n => rng.below(n)));
        const end = 24000 + tx.length, x = new Float64Array(end + 384000);
        x.set(tx, 24000);
        const tones = [];
        for (let k = 6; k < 60; k++) tones.push([k * 50, rng.below(1000) / 1000 * 2 * Math.PI]);
        const g = 0.12 / Math.sqrt(tones.length / 2);
        const noise = i => { const t = i / 48000; let s = 0; for (const [f, ph] of tones) s += Math.sin(2 * Math.PI * f * t + ph); return g * s; };
        for (let i = 0; i < burstMs * 48; i++) x[end + i] += noise(i);
        for (let k = 0; k < clicks; k++) { const at = end + Math.floor(k * 48000 / clicks); for (let i = 0; i < 96; i++) x[at + i] += noise(i); }
        for (let i = 0; i < x.length; i++) x[i] += 0.002 * rng.gauss();
        const rx = new M.Receiver(bw, [rec], 1, null), txs = [];
        for (let i = 0, b = 0; i < x.length; i += 480, b++)
          for (const e of rx.feed(x.subarray(i, Math.min(i + 480, x.length)))) if (e.kind === "tx") txs.push([e.ok, (b + 1) * 480 - end]);
        const ok = txs.length === 1 && eq(txs[0][0], [true]) && (lateOk || txs[0][1] < 24000);
        check("rx noise tail " + bw.hz + " L" + rec + " " + burstMs + "ms/" + clicks, ok, JSON.stringify(txs));
      }
    }
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
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
