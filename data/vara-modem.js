// VARA-compatible modem, HF: physical layer, ARQ session and station.
// SPDX-License-Identifier: MIT.
// JavaScript port of x0rro/xara (C) 2026 x0rro, MIT licence, pinned in
// third_party/xara/README.md: crates/xara-phy (crc, rnd, seq, call, fec,
// constellation, demap, eq, dat, dsp, ofdm, turbo/{engine,float}, decode,
// busy, cwid, hf/*), crates/xara-arq (session, link, textcomp, compression,
// cq, hf/*) and xara/src/station/{mod,hf,scheduler}.rs.
// Port (C) 2026 RemoteQTH.com. docs/vara-implementace.md.
//
// Bit-exact against xara's vectors/ and its golden session transcript
// (tools/vara-phy-test.js, tools/vara-arq-test.js): every integer
// path and every f32 step (VbRnd, the level tables) is reproduced as such;
// f64 arithmetic is kept in the same order as upstream. The FFT is a plain
// radix-2 one, so audio matches upstream to rounding (~1e-15), not to the bit.
//
// Runs as a library in the page, in a Worker (importScripts) and in Node.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VaraModem = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ───────────────────────────── crc / bytes
  function crc16(data, from, to) {
    let c = 0xFFFF;
    from = from || 0;
    to = to === undefined ? data.length : to;
    for (let i = from; i < to; i++) {
      c ^= data[i] << 8;
      for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
    }
    return c ^ 0xFFFF;
  }
  function crcOk(f) {
    const n = f.length;
    if (n < 3) return false;
    const c = crc16(f, 0, n - 2);
    return f[n - 2] === c >> 8 && f[n - 1] === (c & 0xFF);
  }
  const ascii = s => typeof s === "string" ? Uint8Array.from(s, ch => ch.charCodeAt(0) & 0xFF) : s;

  // ───────────────────────────── VbRnd (24-bit LCG, f32 outputs)
  const MASK = 0xFFFFFF, MUL = 0xFD43FD, INC = 0xC39EC3;
  const MUL_INV = (() => {
    let x = MUL;
    for (let i = 0; i < 5; i++) x = Math.imul(x, (2 - Math.imul(MUL, x)) | 0);
    return (x & MASK) >>> 0;
  })();
  const START_STATE = 0x050000;
  const f32buf = new DataView(new ArrayBuffer(8));
  const f32bits = x => { f32buf.setFloat32(0, x); return f32buf.getUint32(0); };
  const f64hi = x => { f32buf.setFloat64(0, x); return f32buf.getUint32(0); };
  const F = Math.fround;

  class VbRnd {
    constructor(state) { this.state = state === undefined ? START_STATE : (state & MASK) >>> 0; }
    static stream(seed) { const r = new VbRnd(); r.rnd(-1); r.randomize(seed); return r; }
    clone() { return new VbRnd(this.state); }
    rnd(x) {
      x = F(x);
      if (x < 0) { const b = f32bits(x); this.state = ((b + (b >>> 24)) & MASK) >>> 0; }
      if (x !== 0) this.advance();
      return this.value();
    }
    nextF32() { this.advance(); return this.value(); }
    randomize(d) {
      const hi = f64hi(d);
      const mid = ((hi & 0xFFFF) ^ (hi >>> 16)) & 0xFFFF;
      this.state = ((this.state & 0xFF0000FF) | (mid << 8)) >>> 0;
    }
    draw(m) { return Math.trunc(F(this.nextF32() * F(m))) >>> 0; }
    randInt(n) { return this.draw(n + 1); }
    seedRnd(x) {
      this.rnd(-1);
      this.randomize(x % 32768);
      for (let i = 0, n = Math.floor(x / 32768); i <= n; i++) this.advance();
    }
    advance() { this.state = ((Math.imul(this.state, MUL) + INC) & MASK) >>> 0; }
    retreat() { this.state = (Math.imul((this.state - INC) | 0, MUL_INV) & MASK) >>> 0; }
    value() { return this.state / 16777216; }
  }

  // ───────────────────────────── seq
  const HF_SEED = 292, FM_SEED = 43, WHITENING_LEN = 150000;
  const PSK_CARRIERS = 13, PSK_SYMBOLS = 471, OFDM_BINS = 128, OFDM_SYMBOLS = 469, DATA_DAT_LEN = 65000;
  function whitening(seed) {
    const r = VbRnd.stream(seed), out = new Uint8Array(WHITENING_LEN);
    for (let i = 0; i < WHITENING_LEN; i++) out[i] = r.randInt(1);
    return out;
  }
  function pskPhasorIndex() {
    const r = VbRnd.stream(HF_SEED);
    const d = Array.from({length: PSK_CARRIERS}, () => new Uint8Array(PSK_SYMBOLS));
    for (const [a, b] of [[0, 411], [411, PSK_SYMBOLS]])
      for (const row of d) for (let k = a; k < b; k++) row[k] = r.randInt(128);
    return d;
  }
  function dataDat() {
    const r = VbRnd.stream(HF_SEED), out = new Uint8Array(DATA_DAT_LEN);
    for (let i = 0; i < DATA_DAT_LEN; i++) out[i] = r.randInt(128);
    return out;
  }
  function ofdmPhasorIndex() {
    const d = dataDat();
    let p = 0;
    const out = Array.from({length: OFDM_BINS}, () => new Uint8Array(OFDM_SYMBOLS));
    for (const [a, b] of [[0, 409], [409, OFDM_SYMBOLS]])
      for (const row of out) for (let m = a; m < b; m++) row[m] = d[p++];
    return out;
  }

  // ───────────────────────────── call
  function callHash(call) {
    call = ascii(call);
    if (!call.length) return 0;
    const c1 = crc16(call), c2 = crc16(call, Math.max(0, call.length - 3));
    return (((c2 >> 8) << 16) | c1) >>> 0;
  }
  function ssidCode(s) {
    const m = {T: 0x10, R: 0x11, X: 0x12, L: 0x13};
    if (s in m) return m[s];
    return /^\+?\d+$/.test(s) && Number(s) <= 255 ? Number(s) : null;
  }
  function withSsid(base, code) {
    const m = {0x10: "-T", 0x11: "-R", 0x12: "-X", 0x13: "-L"};
    return code === 0 ? base : base + (m[code] || "-" + code);
  }
  function packCall(call) {
    call = ascii(call);
    let base = call, ssid = 0;
    const i = call.indexOf(0x2D);
    if (i >= 0) {
      base = call.subarray(0, i);
      const code = ssidCode(String.fromCharCode(...call.subarray(i + 1)));
      ssid = code !== null && code >= 1 && code <= 0x13 ? code : 0;
    }
    const codes = Array.from(base, c => c >= 65 && c <= 90 ? c - 64 : c >= 48 && c <= 57 ? c - 48 + 27 : 0);
    while (codes.length < 7) codes.push(0);
    codes.push(ssid);
    let bits = 0n;
    for (let j = 0; j < 8; j++) bits = (bits << 6n) | BigInt(codes[j] & 63);
    const out = new Uint8Array(6);
    for (let j = 5; j >= 0; j--) { out[j] = Number(bits & 0xFFn); bits >>= 8n; }
    return out;
  }
  function unpackCall(b) {
    if (!b || b.length < 6) return null;
    let v = 0n;
    for (let i = 0; i < 6; i++) v = (v << 8n) | BigInt(b[i]);
    let base = "";
    for (let i = 7; i >= 1; i--) {
      const c = Number((v >> BigInt(6 * i)) & 63n);
      base += c >= 1 && c <= 26 ? String.fromCharCode(64 + c) : c >= 27 && c <= 36 ? String.fromCharCode(48 + c - 27) : " ";
    }
    return withSsid(base.replace(/\s+$/, ""), Number(v & 0x1Fn));
  }

  // ───────────────────────────── fec
  function frameBits(frame, k) {
    const bits = new Uint8Array(k);
    for (let i = 0; i < frame.length && i * 8 < k; i++)
      for (let j = 0; j < 8 && i * 8 + j < k; j++) bits[i * 8 + j] = (frame[i] >> (7 - j)) & 1;
    return bits;
  }
  function whiten(bits, w) { for (let i = 0; i < bits.length && i < w.length; i++) bits[i] ^= w[i]; }
  function rsc(input, k) {
    const x = new Uint8Array(k + 3), p = new Uint8Array(k + 3);
    let r0 = 0, r1 = 0, r2 = 0;
    for (let t = 0; t < k + 3; t++) {
      const u = t < k ? input(t) : r0 ^ r1;
      const a = u ^ r0 ^ r1;
      x[t] = u; p[t] = a ^ r2 ^ r0;
      r0 = r1; r1 = r2; r2 = a;
    }
    return [x, p];
  }
  function turboEncode(info, perm, p, n) {
    const k = info.length;
    const [x1, p1] = rsc(t => info[t], k);
    const [x2, p2] = rsc(t => info[perm[t]], k);
    const out = new Uint8Array(n);
    let o = 0;
    const h = p >> 1;
    for (let t = 0; t < k; t++) {
      out[o++] = x1[t];
      if (p === 1 || t % p === 0) out[o++] = p1[t];
      if (p === 1 || t % p === h) out[o++] = p2[t];
    }
    for (let t = k; t < k + 3; t++) { out[o++] = x1[t]; out[o++] = p1[t]; out[o++] = x2[t]; out[o++] = p2[t]; }
    if (o > n) throw new Error("turbo output " + o + " exceeds N " + n);
    return out;
  }
  function interleave(coded, chan) {
    const out = new Uint8Array(chan.length);
    for (let i = 0; i < chan.length; i++) out[i] = coded[chan[i]];
    return out;
  }
  function puncturePeriod(rate) {
    const p = {2: 1, 3: 2, 4: 4, 5: 6, 6: 8, 7: 10}[rate];
    if (!p) throw new Error("codeRateIndex");
    return p;
  }
  function puncturedLen(k, p) {
    if (p === 1) return 3 * k + 12;
    const p1 = Math.ceil(k / p), half = p >> 1;
    const p2 = k > half ? Math.floor((k - half - 1) / p) + 1 : 0;
    return k + p1 + p2 + 12;
  }

  // ───────────────────────────── complex helpers (z = [re, im])
  const C = (re, im) => [re, im || 0];
  const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  const cconj = a => [a[0], -a[1]];
  const cnorm2 = a => a[0] * a[0] + a[1] * a[1];
  const hypot = (x, y) => {
    // libm hypot as used by num-complex norm(): scaled to avoid overflow; Math.hypot is the same function.
    return Math.hypot(x, y);
  };
  const cnorm = a => hypot(a[0], a[1]);
  const cdiv = (a, b) => {
    // num-complex Div: (a * conj(b)) / norm_sqr(b)
    const n = b[0] * b[0] + b[1] * b[1];
    const re = a[0] * b[0] + a[1] * b[1], im = a[1] * b[0] - a[0] * b[1];
    return [re / n, im / n];
  };
  const cscale = (a, s) => [a[0] * s, a[1] * s];
  const cdivs = (a, s) => [a[0] / s, a[1] / s];
  const polar = (r, th) => [r * Math.cos(th), r * Math.sin(th)];

  // ───────────────────────────── constellation
  const QAM16 = [-0.7778175, -0.2592725, 0.7778175, 0.2592725];
  const QAM32 = [0.2121320, 0.6363961, 1.0606602];
  const CONSTELLATIONS = (() => {
    const h = Math.SQRT1_2;
    const base = [[0, 0], [1, 0], [1, 2], [2, 0], [0, 1], [1, 1], [0, 2], [2, 1]].map(([i, q]) => C(QAM32[i], QAM32[q]));
    const qam32 = [].concat(base, base.map(cconj), base.map(z => [-z[0], z[1]]), base.map(z => [-z[0], -z[1]]));
    return [
      [],
      [C(1, 0), C(-1, 0)],
      [C(1, 0), C(0, 1), C(0, -1), C(-1, 0)],
      [C(1, 0), C(h, h), C(-h, h), C(0, 1), C(h, -h), C(0, -1), C(-1, 0), C(-h, -h)],
      Array.from({length: 16}, (_, v) => C(QAM16[v >> 2], QAM16[v & 3])),
      qam32,
    ];
  })();
  const constellation = bps => CONSTELLATIONS[bps] || [];
  function takeBits(tx, st, n) {
    let v = 0;
    for (let i = 0; i < n; i++) { v = 2 * v + (tx[st.p] || 0); st.p++; }
    return v;
  }

  // ───────────────────────────── dsp basics
  const PI = Math.PI;
  const dbAmp = db => Math.pow(10, db / 20);
  function quantise(x) {
    const ULP_ONE = 4503599627370496;
    const y = Math.min(1, Math.max(-1, x)) * 32767;
    const r = (Math.abs(y) + ULP_ONE) - ULP_ONE;
    return (y < 0 || Object.is(y, -0) ? -r : r) / 32767;
  }
  const SINES = new Map();
  function sine(k, period) {
    if (period !== 512 && period !== 1024 && period !== 2048) throw new Error("no sine table for period " + period);
    const key = period * 256 + k;
    let t = SINES.get(key);
    if (!t) {
      t = new Float64Array(period + 1);
      for (let n = 0; n <= period; n++) t[n] = Math.sin(2 * PI * k * n / period);
      SINES.set(key, t);
    }
    return t;
  }
  function fall(n) {
    const out = new Float64Array(n);
    for (let k = 1; k <= n; k++) out[k - 1] = 0.5 * (1 + Math.cos((k - 0.5) * PI / n));
    return out;
  }

  // In-place radix-2 complex FFT on (re, im); sign -1 forward, +1 inverse (unnormalised, as rustfft).
  const FFT_PLANS = new Map();
  function fftPlan(n) {
    let p = FFT_PLANS.get(n);
    if (p) return p;
    if (n & (n - 1)) throw new Error("FFT length " + n + " is not a power of two");
    const rev = new Uint32Array(n), bits = Math.log2(n) | 0;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n >> 1), sin = new Float64Array(n >> 1);
    for (let i = 0; i < n >> 1; i++) { cos[i] = Math.cos(2 * PI * i / n); sin[i] = Math.sin(2 * PI * i / n); }
    p = {n, rev, cos, sin};
    FFT_PLANS.set(n, p);
    return p;
  }
  function fft(re, im, sign) {
    const n = re.length, p = fftPlan(n), rev = p.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = p.cos[k], wi = sign * p.sin[k];
          const a = s + j, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  // ───────────────────────────── HF levels
  const RECORDS = 17, FSK_PILOTS = 24, HF_PP = 8;
  const NFFT = 1024, NCP = 128, NWIN = 32, FS = 48000, BIN_HZ = FS / NFFT, SYM_RATIO = (NFFT + NCP) / NFFT;
  const PSK_SPS = 32, PSK_SCALE = 178;

  class Level {
    constructor(o) {
      Object.assign(this, o);
      this.thr = F(o.thr); this.papr = F(o.papr); this.snrCorr = F(o.snrCorr || 0);
      this.extra = !!o.extra; this.skip = !!o.skip;
      const fsk = o.wf === "fsk", ofdm = o.wf === "ofdm";
      this.isFsk = fsk;
      this.isQam = ofdm && o.bps >= 4;
      this.spf = fsk ? o.symbols : o.spf;
      this.sps = fsk ? o.sps : o.wf === "psk" ? PSK_SPS : 64;
      this.nc = fsk ? 1 : o.wf === "psk" ? o.fc.length : o.nc;
      this.markers = fsk ? FSK_PILOTS : o.markers;
      const spf = this.spf;
      this.dataCells = fsk ? spf - 1 - FSK_PILOTS
        : this.isQam ? this.nc * (spf - 1 - this.markers - (Math.floor((spf - 3) / HF_PP) + 1))
          : this.nc * (spf - 2 - this.markers);
      this.puncturePeriod = puncturePeriod(o.rate);
      this.n = this.dataCells * o.bps;
      this.otherLen = fsk ? 3 * (o.symbols - 1) + FSK_PILOTS : this.nc * (this.markers + spf - 1);
      this.pad = this.n - puncturedLen(o.k, this.puncturePeriod);
      this.frameBytes = o.k >> 3;
      this.payload = this.frameBytes - 3;
      this.dataSymbols = spf - 1;
      this.symbolPeriod = this.sps * (ofdm ? SYM_RATIO : 1) / 3000;
      const t = o.bps < 4 ? 0.080 : 0.120;
      this.leadIn = Math.ceil(t / this.symbolPeriod - 1e-9);
      this.flushSymbols = o.wf === "psk" ? Math.round(2 * o.span) : 0;
      this.airtime = (this.leadIn + this.dataSymbols + this.flushSymbols) * this.symbolPeriod;
      this.netBps = 8 * this.frameBytes / (this.dataSymbols * this.symbolPeriod);
    }
  }
  const fsk = o => new Level(Object.assign({wf: "fsk", papr: 3, skip: false}, o));
  const psk = o => new Level(Object.assign({wf: "psk", rate: 3, skip: false}, o));
  const OFDM0 = {wf: "ofdm", spf: 150, skip: false};
  const O500 = Object.assign({}, OFDM0, {markers: 4, nc: 11, first: 27});
  const O2300 = Object.assign({}, OFDM0, {markers: 1, nc: 49, first: 8});
  const O2750 = Object.assign({}, OFDM0, {markers: 1, nc: 59, first: 3});
  const ofdm = (base, o) => new Level(Object.assign({}, base, o));
  const RC = 0.5, RRC1 = 1, RRC2 = 2;
  const OFDM_500_X = ofdm(O500, {spf: 51, bps: 5, rate: 6, thr: 5.4, papr: 8.7, k: 1704, snrCorr: -0.4, extra: true});

  const BW500_T = [
    fsk({symbols: 125, bps: 3, rate: 2, sps: 128, first: 54, last: 74, step: 2, thr: -13.6, k: 96}),
    fsk({symbols: 229, bps: 3, rate: 2, sps: 64, first: 27, last: 37, step: 1, thr: -11.2, skip: true, k: 200}),
    fsk({symbols: 227, bps: 3, rate: 3, sps: 64, first: 27, last: 37, step: 1, thr: -10.4, k: 297}),
    psk({spf: 394, bps: 1, markers: 18, fc: [1350, 1650], span: RC, thr: -8.4, papr: 4.4, k: 368}),
    psk({spf: 395, bps: 2, markers: 18, fc: [1350, 1650], span: RC, thr: -5.4, papr: 4.4, k: 744}),
    psk({spf: 376, bps: 2, markers: 12, fc: [1320, 1500, 1680], span: RRC2, thr: -3.8, papr: 7.2, k: 1080}),
    ofdm(O500, {bps: 2, rate: 3, thr: -1.2, papr: 8.3, k: 1578}),
    ofdm(O500, {bps: 2, rate: 4, thr: 0.6, papr: 8.3, k: 2104}),
    ofdm(O500, {bps: 2, rate: 6, thr: 2.6, papr: 8.3, k: 2524}),
    ofdm(O500, {bps: 3, rate: 4, thr: 5.0, papr: 8.2, skip: true, k: 3160}),
    ofdm(O500, {bps: 3, rate: 6, thr: 6.4, papr: 8.2, k: 3792}),
    ofdm(O500, {spf: 155, bps: 4, rate: 7, thr: 8.0, papr: 8.2, k: 4755, snrCorr: -1.59}),
    ofdm(O500, {spf: 155, bps: 5, rate: 6, thr: 10.6, papr: 8.2, k: 5708, snrCorr: -0.4}),
    psk({spf: 451, bps: 2, markers: 18, fc: [1350, 1650], span: RC, thr: -5.4, papr: 4.4, k: 856, extra: true}),
    fsk({symbols: 93, bps: 3, rate: 2, sps: 128, first: 54, last: 74, step: 2, thr: -13.6, k: 64, extra: true}),
    OFDM_500_X,
    OFDM_500_X,
  ];
  const BW2300_T = [
    fsk({symbols: 125, bps: 3, rate: 2, sps: 128, first: 33, last: 96, step: 2, thr: -13.6, k: 96}),
    fsk({symbols: 229, bps: 3, rate: 2, sps: 64, first: 17, last: 48, step: 2, thr: -11.2, k: 200}),
    fsk({symbols: 229, bps: 4, rate: 3, sps: 64, first: 17, last: 48, step: 2, thr: -9.4, k: 402}),
    fsk({symbols: 396, bps: 4, rate: 3, sps: 32, first: 9, last: 24, step: 1, thr: -6.6, k: 736}),
    psk({spf: 376, bps: 2, markers: 12, fc: [900, 1500, 2100], span: RC, thr: -3.6, papr: 6.1, k: 1080}),
    psk({spf: 365, bps: 2, markers: 9, fc: [750, 1250, 1750, 2250], span: RC, thr: -2.4, papr: 7.1, k: 1410}),
    psk({spf: 355, bps: 2, markers: 6, fc: [700, 1020, 1340, 1660, 1980, 2300], span: RRC2, thr: -0.6, papr: 8.5, skip: true, k: 2076}),
    psk({spf: 352, bps: 2, markers: 5, fc: [702, 930, 1158, 1386, 1614, 1842, 2070, 2298], span: RRC2, thr: 0.4, papr: 8.6, skip: true, k: 2754}),
    psk({spf: 349, bps: 2, markers: 4, fc: [555, 765, 975, 1185, 1395, 1605, 1815, 2025, 2235, 2445], span: RRC1, thr: 1.3, papr: 8.9, k: 3424}),
    ofdm(O2300, {bps: 2, rate: 3, thr: 5.4, papr: 9.4, k: 7197}),
    ofdm(O2300, {bps: 2, rate: 4, thr: 7.2, papr: 9.4, skip: true, k: 9596}),
    ofdm(O2300, {bps: 2, rate: 6, thr: 8.5, papr: 9.4, k: 11512}),
    ofdm(O2300, {bps: 3, rate: 4, thr: 11.2, papr: 9.4, k: 14398}),
    ofdm(O2300, {bps: 3, rate: 6, thr: 13.2, papr: 9.4, skip: true, k: 17276, snrCorr: -1.7}),
    ofdm(O2300, {spf: 155, bps: 4, rate: 7, thr: 14.2, papr: 9.3, k: 21710, snrCorr: -1.59}),
    ofdm(O2300, {spf: 155, bps: 5, rate: 6, thr: 17.2, papr: 9.3, k: 26056, snrCorr: -0.4}),
    OFDM_500_X,
  ];
  const BW2750_T = [
    fsk({symbols: 125, bps: 3, rate: 2, sps: 128, first: 24, last: 103, step: 2, thr: -13.6, k: 96}),
    fsk({symbols: 229, bps: 3, rate: 2, sps: 64, first: 12, last: 51, step: 2, thr: -11.2, k: 200}),
    fsk({symbols: 229, bps: 4, rate: 3, sps: 64, first: 12, last: 51, step: 2, thr: -9.4, k: 402}),
    fsk({symbols: 396, bps: 4, rate: 3, sps: 32, first: 6, last: 25, step: 1, thr: -6.6, k: 736}),
    psk({spf: 376, bps: 2, markers: 12, fc: [600, 1500, 2400], span: RC, thr: -3.6, papr: 6.1, k: 1080}),
    psk({spf: 365, bps: 2, markers: 9, fc: [510, 1170, 1830, 2490], span: RC, thr: -2.4, papr: 7.1, k: 1410}),
    psk({spf: 355, bps: 2, markers: 6, fc: [450, 870, 1290, 1710, 2130, 2550], span: RRC2, thr: -0.6, papr: 8.4, skip: true, k: 2076}),
    psk({spf: 352, bps: 2, markers: 5, fc: [380, 700, 1020, 1340, 1660, 1980, 2300, 2620], span: RRC2, thr: 0.4, papr: 8.7, skip: true, k: 2754}),
    psk({spf: 349, bps: 2, markers: 4, fc: [375, 625, 875, 1125, 1375, 1625, 1875, 2125, 2375, 2625], span: RRC1, thr: 1.3, papr: 8.8, skip: true, k: 3424}),
    psk({spf: 349, bps: 2, markers: 3, fc: [240, 450, 660, 870, 1080, 1290, 1500, 1710, 1920, 2130, 2340, 2550, 2760], span: RRC1, thr: 2.3, papr: 8.8, k: 4466}),
    ofdm(O2750, {bps: 2, rate: 3, thr: 6.0, papr: 9.3, k: 8667}),
    ofdm(O2750, {bps: 2, rate: 4, thr: 8.0, papr: 9.3, skip: true, k: 11556}),
    ofdm(O2750, {bps: 2, rate: 6, thr: 9.3, papr: 9.4, k: 13864}),
    ofdm(O2750, {bps: 3, rate: 4, thr: 11.8, papr: 9.5, k: 17338}),
    ofdm(O2750, {bps: 3, rate: 6, thr: 14.0, papr: 9.5, skip: true, k: 20804, snrCorr: -1.7}),
    ofdm(O2750, {spf: 155, bps: 4, rate: 7, thr: 15.0, papr: 9.3, k: 26145, snrCorr: -1.59}),
    ofdm(O2750, {spf: 155, bps: 5, rate: 6, thr: 18.0, papr: 9.3, k: 31376, snrCorr: -0.4}),
  ];
  const AMP_NORM_500 = [1.41, 1.41, 1.41, 0.61, 0.61, 1.22, 4.9678, 4.9678, 4.9678, 4.9678, 4.9678, 4.21, 4.67, 0.61, 1.41, 4.67, 4.67];
  const AMP_NORM_2300 = [1.41, 1.41, 1.41, 1.41, 0.75, 0.86, 1.73, 2.0, 2.23, 10.44435, 10.44435, 10.44435, 10.44435, 10.44435, 8.82035, 10.01805, 4.67];
  const AMP_NORM_2750 = [1.41, 1.41, 1.41, 1.41, 0.75, 0.86, 1.73, 2.0, 2.23, 2.5422, 11.4219, 11.4219, 11.4219, 11.4219, 11.4219, 9.6459, 10.9557];

  class Bandwidth {
    constructor(id, hz, numLevels, table, amp, startMax) {
      this.id = id; this.hz = hz; this.numLevels = numLevels; this.table = table;
      this.amp = amp.map(F); this.startLevelMax = startMax;
      this.topLevel = numLevels;
    }
    level(r) { return this.table[r - 1]; }
    ampNorm(r) { return this.amp[r - 1]; }
    passband() { const h = this.hz / 2; return [1500 - h, 1500 + h]; }
    levels() { return Array.from({length: this.numLevels}, (_, i) => i + 1); }
    toString() { return String(this.hz); }
  }
  const BW500 = new Bandwidth(0, 500, 13, BW500_T, AMP_NORM_500, 7);
  const BW2300 = new Bandwidth(1, 2300, 16, BW2300_T, AMP_NORM_2300, 6);
  const BW2750 = new Bandwidth(2, 2750, 17, BW2750_T, AMP_NORM_2750, 6);
  const BANDWIDTHS = [BW500, BW2300, BW2750];
  const bandwidth = hz => BANDWIDTHS.find(b => b.hz === Number(hz)) || null;
  function datOffsets(bw) {
    let p = 0;
    return bw.table.map(l => { const o = p; p += l.n + l.k + l.otherLen; return o; });
  }
  function qamLimit(bw) {
    let m = 0;
    for (let r = 1; r <= RECORDS; r++) if (!bw.level(r).isQam) m = r;
    return m;
  }

  // ───────────────────────────── dat (record tables, generated from a seed)
  const TABLE_SEED = 43, FM_RECORD16_SEED = 77;
  function perm(r, n) {
    const used = new Uint8Array(n), out = new Uint32Array(n);
    let i = 0;
    while (i < n) { const v = r.draw(n); if (!used[v]) { used[v] = 1; out[i++] = v; } }
    return out;
  }
  function markerMap(other, nc, markers, nsym) {
    const rows = [];
    for (let c = 0; c < nc; c++) {
      const a = nc * markers + c * nsym, row = new Uint8Array(nsym);
      for (let s = 0; s < nsym; s++) row[s] = other[a + s] ? 1 : 0;
      rows.push(row);
    }
    return rows;
  }
  function markerRows(nc, markers, next, gap) {
    const rows = [];
    for (let c = 0; c < nc; c++) {
      const row = [];
      while (row.length < markers) {
        const v = next(c);
        if (row.every(w => Math.abs(v - w) > gap)) row.push(v);
      }
      rows.push(row);
    }
    return rows;
  }
  function carrierOther(rows, spf) {
    const out = [];
    for (const row of rows) for (const v of row) out.push(v);
    for (const row of rows) {
      const m = new Array(spf - 1).fill(0);
      for (const v of row) m[v - 2] = 1;
      for (const x of m) out.push(x);
    }
    return Uint16Array.from(out);
  }
  function fskOther(r, l) {
    const s = l.symbols, nb = l.last - l.first + 1, step = l.step;
    const m = step > 1 ? Math.floor(nb / step) + 1 : nb;
    const out = [];
    for (let i = 0; i < s - 1; i++) out.push(l.first + (step > 1 && i % 2 === 0 ? 1 : 0) + step * r.draw(m));
    const inc = F(F(s - 2) / F(FSK_PILOTS));
    let acc = F(1);
    const rows = [];
    for (let i = 0; i < FSK_PILOTS; i++) { acc = F(acc + inc); rows.push(Math.trunc(acc)); }
    for (const x of rows) out.push(x);
    const scale = (1 << l.bps) / 8;
    const pilot = new Array(s - 1).fill(null);
    for (const row of rows) pilot[row - 2] = scale * r.draw(8);
    for (const p of pilot) { if (p === null) out.push(0, 0); else out.push(1, p); }
    return Uint16Array.from(out);
  }
  function pskOther(r, l) {
    const spf = l.spf, first = l.wf === "ofdm" ? l.first : 0, qam = l.isQam;
    const rows = markerRows(l.nc, l.markers,
      c => qam ? 3 + (first + c) % 2 + HF_PP * r.draw(Math.floor((spf - 3) / HF_PP)) : 5 + r.draw(spf - 8), 0);
    return carrierOther(rows, spf);
  }
  function hfTables(bw) {
    const r = VbRnd.stream(TABLE_SEED);
    return bw.table.map(l => {
      const chan = perm(r, l.n), turbo = perm(r, l.k);
      const other = l.isFsk ? fskOther(r, l) : pskOther(r, l);
      return {chan, turbo, other};
    });
  }
  function serializeTables(tables) {
    const out = [];
    const putPerm = p => {
      if (p.length > 65536) for (const v of p) out.push((v >> 16) & 255, (v >> 8) & 255, v & 255);
      else for (const v of p) out.push((v >> 8) & 255, v & 255);
    };
    for (const t of tables) {
      putPerm(t.chan); putPerm(t.turbo);
      for (const v of t.other) out.push(v >> 8, v & 255);
    }
    const crc = crc16(out, 0, out.length - 1);
    out.push(crc >> 8, crc & 255);
    return Uint8Array.from(out);
  }
  const hfDat = bw => serializeTables(hfTables(bw));

  const HF_CACHE = {tables: [], white: null, psk: null, ofdm: null};
  const tables = bw => HF_CACHE.tables[bw.id] || (HF_CACHE.tables[bw.id] = hfTables(bw));
  const hfWhitening = () => HF_CACHE.white || (HF_CACHE.white = whitening(HF_SEED));
  function phasors(idx) {
    return idx.map(row => Array.from(row, d => polar(1, 2 * PI * d / 128)));
  }
  const pskPhasors = () => HF_CACHE.psk || (HF_CACHE.psk = phasors(pskPhasorIndex()));
  const ofdmPhasors = () => HF_CACHE.ofdm || (HF_CACHE.ofdm = phasors(ofdmPhasorIndex()));
  function warm(bw) { tables(bw); hfWhitening(); pskPhasors(); ofdmPhasors(); }

  // ───────────────────────────── HF frame
  const TERMINATOR = 0x14;
  const ctrlByte = (c, last, full) =>
    ((c.reply << 6) | ((c.compressed ? 1 : 0) << 5) | ((c.hint & 7) << 2) | ((last ? 1 : 0) << 1) | (full ? 1 : 0)) & 255;
  const ctrlFromByte = b => [{reply: b >> 6, compressed: (b & 0x20) !== 0, hint: (b >> 2) & 7}, (b & 2) !== 0, (b & 1) !== 0];
  function termMarker(caller) {
    const m = crc16(ascii(caller)) >> 8;
    return m === 0 || m === TERMINATOR ? 1 : m;
  }
  const payloadCapacity = (len, last) => Math.max(0, len - 3 - (last ? 1 : 0));
  function buildFrame(frameLen, data, ctrl, last, marker) {
    const hasLast = last !== null && last !== undefined;
    const room = payloadCapacity(frameLen, hasLast);
    const full = data.length >= room;
    const out = Array.from(data.subarray ? data.subarray(0, Math.min(data.length, room)) : data.slice(0, room));
    if (!full) {
      out.push(TERMINATOR);
      if (out.length < room) out.push(marker);
      while (out.length < room) out.push(0);
      out.length = room;
    }
    if (hasLast) out.push(last);
    out.push(ctrlByte(ctrl, hasLast, full));
    const crc = crc16(out);
    out.push(crc >> 8, crc & 255);
    return Uint8Array.from(out);
  }
  function headerPayload(call, flags) {
    const p = packCall(call);
    return Uint8Array.of(p[0], p[1], p[2], p[3], p[4], p[5], 0, flags);
  }
  const Header = {
    flags: h => ((h.valid ? 1 : 0) << 7 | (h.comp & 3) << 1 | (h.registered ? 1 : 0)) & 255,
    toFrame(h, frameLen, hint, marker) {
      return buildFrame(frameLen, headerPayload(h.call, Header.flags(h)), {reply: h.reply, compressed: false, hint}, h.offer, marker);
    },
    parse(b) {
      if (b.length < 11) return null;
      const [ctrl, last] = ctrlFromByte(b[b.length - 3]);
      if (!last || ctrl.compressed || b[6] !== 0) return null;
      const flags = b[7];
      return {call: unpackCall(b.subarray(0, 6)) || "", valid: (flags & 0x80) !== 0, registered: (flags & 1) !== 0,
        comp: (flags >> 1) & 3, reply: ctrl.reply, offer: b[b.length - 4]};
    },
  };

  // ───────────────────────────── HF control frames (tone codewords)
  const CODE = {ACK_STAY: 1, NACK: 2, QRT: 3, ACK_UP2: 5, ACK_DOWN: 6, ACK_UP1: 7, ACK_UP3: 8, ACK_UP4: 9,
    ACK_SECOND_ONLY: 10, ACK_FIRST_ONLY: 11, ACK_REQ_0: 12, ACK_REQ_1: 13, GO_AHEAD: 14, CONNECT_REPLY_2300: 15,
    NACK_MISSED: 19, NO_TRAFFIC: 21, CONNECT_REPLY_500: 22, CONNECT_REQ_2300: 26, CONNECT_REQ_500: 31,
    CONNECT_REQ_2750: 36, CONNECT_REPLY_2750: 41, REJECT: 43, KISS_L1: 45, QRT_NO_CWID: 46, KISS_L2: 47, CQ: 48,
    BREAK: 49, IDLE: 50, START_LEVEL: 50, KISS_L4: 58, ALIASES: 5, QUALITIES: 4, START_LEVELS: 7};
  CODE.ACK_REQ = [CODE.ACK_REQ_0, CODE.ACK_REQ_1];
  CODE.QRT_ANY = [CODE.QRT, CODE.QRT_NO_CWID];
  CODE.KISS = [CODE.KISS_L1, CODE.KISS_L2, CODE.KISS_L4];
  CODE.LONG_LEADIN = [CODE.GO_AHEAD, CODE.NO_TRAFFIC, CODE.BREAK, CODE.IDLE];
  CODE.UNUSED = [4, 20];
  const REQ_BASE = [CODE.CONNECT_REQ_500, CODE.CONNECT_REQ_2300, CODE.CONNECT_REQ_2750];
  const REPLY_BASE = [CODE.CONNECT_REPLY_500, CODE.CONNECT_REPLY_2300, CODE.CONNECT_REPLY_2750];
  CODE.connectReq = (bw, alias) => alias + REQ_BASE[bw.id];
  CODE.connectReqAlias = code => {
    for (const bw of BANDWIDTHS) { const k = code - REQ_BASE[bw.id]; if (k >= 0 && k < CODE.ALIASES) return [bw, k]; }
    return null;
  };
  CODE.connectReply = (bw, q) => q - 1 + REPLY_BASE[bw.id];
  CODE.connectReplyQ = code => {
    for (const bw of BANDWIDTHS) { const k = code - REPLY_BASE[bw.id]; if (k >= 0 && k < CODE.QUALITIES) return [bw, k + 1]; }
    return null;
  };
  CODE.startLevelCode = n => CODE.START_LEVEL + n;
  CODE.startLevel = code => { const n = code - CODE.START_LEVEL; return n >= 1 && n <= CODE.START_LEVELS ? n : null; };
  CODE.connectReqs = (bw, aliases) => Array.from({length: aliases}, (_, k) => CODE.connectReq(bw, k));
  CODE.connectReplies = bw => [1, 2, 3, 4].map(q => CODE.connectReply(bw, q));
  CODE.startLevels = () => Array.from({length: CODE.START_LEVELS}, (_, i) => CODE.startLevelCode(i + 1));

  const SYMBOL_SAMPLES = 2048, NUM_CODES = 58, ATU_SYMBOLS = 70, ATU_SILENT_SYMBOLS = 24, TONE_BIN = 64, COMB = 14;
  const SEED_OFF = 10, SEED_OFF_REPLY_2750 = 300, SEED_OFF_LEVEL = 1500, KISS_L1_SEED = 0x02D277B0;
  const FORMATS = [
    {nsym: 32, ntones: 1, leadLongMs: 40, leadShortMs: 40, minHits: 19, snrDb: F(-15.5), kDb: F(3)},
    {nsym: 16, ntones: 1, leadLongMs: 80, leadShortMs: 40, minHits: 13, snrDb: F(-7.5), kDb: F(3)},
    {nsym: 8, ntones: 2, leadLongMs: 160, leadShortMs: 40, minHits: 12, snrDb: F(-3.5), kDb: F(6)},
  ];
  for (const f of FORMATS) f.norm = f.ntones === 1 ? Math.SQRT2 : 2;
  const ROLE = {ANSWERER: 0, CALLER: 1};
  const fmtMoreRobust = f => f === 2 ? 1 : 0;
  const bookOff = role => role === ROLE.ANSWERER ? 278 : 50;
  const connectOff = role => role === ROLE.ANSWERER ? 1078 : 850;
  const reqSeedOff = bw => [7, 0, 8][bw.id];
  const bwFamily = bw => bw.id + 1;
  const familyComb = v => v === 1 ? [1, 50] : v === 2 ? [4, 29] : [5, 22];
  function family(code, bw) {
    const q = CODE.connectReplyQ(code);
    if (q) return bwFamily(q[0]);
    const a = CODE.connectReqAlias(code);
    if (a) return a[0] === BW2750 ? bwFamily(BW2300) : bwFamily(a[0]);
    if (CODE.KISS.includes(code) || code === CODE.CQ) return 1;
    return bwFamily(bw);
  }
  function genCode(r, fmt, v) {
    const [n, off] = familyComb(v), f = FORMATS[fmt], out = [];
    for (let s = 2; s <= f.nsym; s++) {
      const bases = [];
      while (bases.length < f.ntones) {
        const b = r.randInt(n) * COMB + off;
        if (!bases.includes(b)) bases.push(b);
      }
      out.push(bases.map(b => b + (s % 2 === 0 && v !== 1 ? 1 : 0) + 2 * r.randInt(6)));
    }
    return out;
  }
  class Codebook {
    constructor(seedValue, mycallHashes, role, bw) {
      this.bw = bw;
      this.codes = [[[], [], []], [[], [], []]];
      const sideOff = [bookOff(1 - role), bookOff(role)];
      const r = new VbRnd();
      for (let u = 0; u < 2; u++) {
        for (let f = 0; f < 3; f++) {
          const fo = f + sideOff[u], book = this.codes[u][f];
          book.push([]);
          r.seedRnd(seedValue + SEED_OFF + fo);
          for (let c = 1; c <= NUM_CODES; c++) {
            const a = CODE.connectReqAlias(c);
            if (a) {
              const peer = u === 1 && a[1] === 0 ? seedValue : mycallHashes[a[1]];
              r.seedRnd(peer + fo + reqSeedOff(a[0]));
            }
            if (c === CODE.CONNECT_REPLY_2750) r.seedRnd(seedValue + SEED_OFF_REPLY_2750 + fo);
            else if (c === CODE.KISS_L2) r.seedRnd(0xCD80A4 + fo);
            else if (c === CODE.CQ) r.seedRnd(0xA3CE37 + fo);
            else if (c === CODE.KISS_L4) r.seedRnd(0x49E730 + fo);
            else if (c === CODE.startLevelCode(1)) r.seedRnd(seedValue + SEED_OFF_LEVEL + fo);
            const v = c === CODE.KISS_L1 ? bwFamily(bw) : family(c, bw);
            book.push(genCode(r, f, v));
          }
          r.seedRnd(KISS_L1_SEED + fo);
          book[CODE.KISS_L1] = genCode(r, f, family(CODE.KISS_L1, bw));
        }
      }
    }
    setConnectCodes(seedValue, role) { return this.setConnectCodesTxRnd(seedValue, role); }
    setConnectCodesTxRnd(seedValue, role) {
      const sideOff = [connectOff(1 - role), connectOff(role)];
      const r = new VbRnd();
      for (let u = 0; u < 2; u++)
        for (let f = 0; f < 3; f++) {
          r.seedRnd(f + seedValue + sideOff[u]);
          for (const c of [CODE.BREAK, CODE.IDLE]) this.codes[u][f][c] = genCode(r, f, family(c, this.bw));
        }
      return r;
    }
    rx(fmt, code) { return this.codes[0][fmt][code]; }
    tx(fmt, code) { return this.codes[1][fmt][code]; }
  }
  function leadinGrids() {
    const r = new VbRnd();
    return FORMATS.map(f => {
      const out = [];
      for (let i = 0; i < 100; i++) {
        const ts = [];
        while (ts.length < f.ntones) { const x = r.randInt(34) + 50; if (!ts.includes(x)) ts.push(x); }
        out.push(ts);
      }
      return out;
    });
  }
  function leadinSymbols(fmt, code, extra) {
    const f = FORMATS[fmt];
    const ms = CODE.LONG_LEADIN.includes(code) ? f.leadLongMs : f.leadShortMs;
    return Math.ceil(ms / (SYMBOL_SAMPLES / 48)) + (extra || 0);
  }
  function ctrlSynth(lead, codeword) {
    const syms = lead.concat(codeword), out = new Float64Array(syms.length * SYMBOL_SAMPLES);
    let o = 0;
    for (const tones of syms) {
      const rows = tones.map(k => sine(k, SYMBOL_SAMPLES));
      for (let n = 0; n < SYMBOL_SAMPLES; n++) {
        let s = 0;
        for (const r of rows) s += r[n];
        out[o++] = s / tones.length;
      }
    }
    return out;
  }
  const backoffDb = u => u + 2 + (10 - u) / 5;
  const txGain = (u, driveDb) => dbAmp(driveDb - backoffDb(u));
  const ctrlGain = (fmt, driveDb) => txGain(FORMATS[fmt].kDb, driveDb);
  function frameAudio(grids, cb, fmt, code, extra) {
    const f = FORMATS[fmt], scale = 2 * f.ntones / f.norm;
    const x = ctrlSynth(grids[fmt].slice(0, leadinSymbols(fmt, code, extra)), cb.tx(fmt, code));
    for (let i = 0; i < x.length; i++) x[i] *= scale;
    return x;
  }
  function atuTone(fmt) {
    const tone = ctrlSynth(new Array(ATU_SYMBOLS).fill([TONE_BIN]), []);
    const out = new Float64Array(tone.length + ATU_SILENT_SYMBOLS * SYMBOL_SAMPLES), scale = 1 / FORMATS[fmt].norm;
    for (let i = 0; i < tone.length; i++) out[i] = tone[i] * scale;
    return out;
  }

  // ───────────────────────────── HF FSK
  const GRAY = [0, 1, 3, 2, 7, 6, 4, 5, 15, 14, 12, 13, 8, 9, 11, 10];
  const fskGrid = l => ({symbols: l.symbols, sps: l.sps, first: l.first, nb: l.last - l.first + 1, step: l.step,
    bin(base, t) { return this.first + (base + this.step * t - this.first) % this.nb; }});
  function fskRows(l, other, tx) {
    const g = fskGrid(l), n = g.symbols - 1, pairs = n + FSK_PILOTS, st = {p: 0}, out = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const t = other[pairs + 2 * i] !== 0 ? other[pairs + 2 * i + 1] : GRAY[takeBits(tx, st, l.bps)];
      out[i] = g.bin(other[i], t);
    }
    if (st.p !== l.n) throw new Error("FSK rows consumed " + st.p + " of " + l.n);
    return out;
  }
  function fskModulate(l, other, txs, rand) {
    const g = fskGrid(l), lead = l.leadIn;
    let bins = [];
    for (let j = 0; j < txs.length; j++) {
      bins = [];
      for (let i = 0; i < lead; i++) bins.push(g.bin(other[i + 1], rand(1 << l.bps)));
    }
    for (const tx of txs) for (const b of fskRows(l, other, tx)) bins.push(b);
    const nsamp = 16 * g.sps, x = new Float64Array(bins.length * nsamp);
    let o = 0;
    for (const k of bins) { const s = sine(k, nsamp); for (let i = 0; i < nsamp; i++) x[o++] = 2 * s[i]; }
    const nf = nsamp / 32;
    if (x.length >= nf) { const fl = fall(nf); for (let i = 0; i < nf; i++) x[x.length - nf + i] *= fl[i]; }
    return x;
  }

  // ───────────────────────────── HF PSK
  function pulseTaps(span) {
    const out = [];
    if (span === RC) {
      const t = PSK_SPS / 2;
      for (let n = -16; n <= 16; n++) {
        let v;
        if (n === 0) v = 1;
        else if (Math.abs(n) === t / 2) v = 0.5 * Math.sin(PI / 2);
        else { const x = n / t; v = Math.sin(PI * x) * Math.cos(PI * x) / (x * PI * (1 - 4 * x * x)); }
        out.push(F(v));
      }
    } else {
      const t = PSK_SPS, half = Math.round(t * span);
      for (let n = -half; n <= half; n++) {
        let v;
        if (n === 0) v = 4 / PI;
        else if (Math.abs(n) === t / 4) v = 1 / Math.sqrt(2) * ((1 + 2 / PI) * Math.sin(PI / 4) + (1 - 2 / PI) * Math.cos(PI / 4));
        else { const x = n / t, y = 4 * x; v = 4 * x * Math.cos(PI * x * 2) / (PI * x * (1 - y * y)); }
        out.push(F(v));
      }
    }
    return Float64Array.from(out);
  }
  function txPulseTaps(span) { const h = pulseTaps(span); h[h.length - 1] = 0; return h; }
  function interp16Taps() {
    const f2 = 125 / 48000, out = new Float64Array(32);
    for (let i = 0; i < 32; i++) {
      const m = i - 16;
      const h = m === 0 ? 2 * f2 : Math.sin(2 * PI * f2 * m) / (PI * m);
      const w = F(0.54 - 0.46 * Math.cos(2 * PI * i / 32));
      out[i] = F(h * w);
    }
    return out;
  }
  const stagger = (c, nc) => nc === 3 ? [0, 11, 21][c] : c % 2 === 1 ? 16 : 0;
  const TAU32 = F(2 * PI);
  function ncoPhase(fc, n) {
    const step = F(2 * PI * fc / 48000), out = new Float32Array(n);
    let phi = F(0);
    for (let i = 0; i < n; i++) {
      phi = F(phi + step);
      if (phi > TAU32) phi = F(phi - TAU32);
      out[i] = phi;
    }
    return out;
  }
  function carrierAudio(sym, fc, delay, hp, hi) {
    // sym: Float64Array interleaved re,im
    const ns = sym.length >> 1, hl = hp.length;
    const len3 = ns * PSK_SPS + delay, ylen = len3 + hl - 1;
    const yr = new Float64Array(ylen), yi = new Float64Array(ylen), nz = new Uint8Array(ylen);
    for (let i = 0; i < ns; i++) {
      const vr = sym[2 * i], vi = sym[2 * i + 1];
      if (vr === 0 && vi === 0) continue;
      const base = delay + i * PSK_SPS;
      for (let j = 0; j < hl; j++) {
        if (base + j >= ylen) break;
        yr[base + j] += vr * hp[j]; yi[base + j] += vi * hp[j];
      }
    }
    for (let i = 0; i < ylen; i++) nz[i] = yr[i] !== 0 || yi[i] !== 0 ? 1 : 0;
    const n = ylen * 16 + hi.length - 1, ph = ncoPhase(fc, n), out = new Float64Array(n);
    for (let t = 0; t < n; t++) {
      let vr = 0, vi = 0;
      const i0 = Math.ceil(Math.max(0, t + 1 - hi.length) / 16), i1 = Math.min(t >> 4, ylen - 1);
      for (let i = i0; i <= i1; i++) {
        if (nz[i]) { const h = hi[t - 16 * i]; vr += yr[i] * h; vi += yi[i] * h; }
      }
      const p = ph[t];
      out[t] = vr * Math.cos(p) - vi * Math.sin(p);
    }
    return out;
  }
  const symbolMap = (l, other) => markerMap(other, l.nc, l.markers, l.spf - 1);
  function pskModulate(l, other, ph, txs, rand) {
    const cst = constellation(l.bps), m = cst.length, nsym = l.dataSymbols, map = symbolMap(l, other);
    const hp = txPulseTaps(l.span), hi = interp16Taps(), nc = l.fc.length;
    const refs = txs.map(() => Array.from({length: nc}, () => cst[rand(m)]));
    const lead = Array.from({length: l.leadIn}, () => Array.from({length: nc}, () => cst[rand(m)]));
    const ptrs = txs.map(() => ({p: 0}));
    let total = new Float64Array(0);
    for (let c = 0; c < nc; c++) {
      const xs = [];
      const push = z => xs.push(z[0], z[1]);
      lead.forEach((v, k) => push(cscale(cmul(v[c], cconj(ph[c][k])), PSK_SCALE)));
      txs.forEach((tx, j) => {
        let d = refs[j][c];
        push(cscale(cmul(d, cconj(ph[c][0])), PSK_SCALE));
        for (let s = 1; s < nsym; s++) {
          if (!(s >= 2 && map[c][s - 2])) d = cmul(d, cst[takeBits(tx, ptrs[j], l.bps)]);
          push(cscale(cmul(d, cconj(ph[c][s])), PSK_SCALE));
        }
      });
      xs.push(0, 0);
      const sig = carrierAudio(Float64Array.from(xs), l.fc[c], stagger(c, nc), hp, hi);
      if (sig.length > total.length) { const t = new Float64Array(sig.length); t.set(total); total = t; }
      for (let i = 0; i < sig.length; i++) total[i] += sig[i];
    }
    if (!ptrs.every(p => p.p === l.n)) throw new Error("PSK consumed the wrong number of bits");
    return total;
  }

  // ───────────────────────────── OFDM (shared HF/FM) and HF OFDM
  function ofdmSynth(first, rows, scale) {
    const fl = fall(NWIN), out = new Float64Array(rows.length * (NFFT + NCP));
    const saved = new Float64Array(NWIN), re = new Float64Array(NFFT), im = new Float64Array(NFFT);
    let start = 0;
    for (const row of rows) {
      re.fill(0); im.fill(0);
      for (let i = 0; i < row.length; i++) { re[first + i] = row[i][0]; im[first + i] = row[i][1]; }
      fft(re, im, 1);
      let o = start;
      for (let i = NFFT - NCP; i < NFFT; i++) out[o++] = 2 * re[i] * scale;
      for (let i = 0; i < NFFT; i++) out[o++] = 2 * re[i] * scale;
      for (let k = 0; k < NWIN; k++) out[start + k] = fl[NWIN - 1 - k] * out[start + k] + fl[k] * saved[k];
      for (let k = 0; k < NWIN; k++) saved[k] = out[start + NCP + k];
      start = o;
    }
    if (out.length >= NWIN) for (let i = 0; i < NWIN; i++) out[out.length - NWIN + i] *= fl[i];
    return out;
  }
  function layoutCells(lay, bins, pilot, tx, put) {
    const one = C(1, 0), st = {p: 0};
    bins.forEach((b, bi) => {
      let cell = one;
      for (let s = 2; s <= lay.spf; s++) {
        const marker = lay.map[bi][s - 2];
        if (lay.qam) {
          if (pilot(b, s)) cell = one;
          else if (marker) { const nm = cnorm(cell); cell = nm > 0 ? cdivs(cell, nm) : one; }
          else cell = lay.cst[takeBits(tx, st, lay.bps)];
        } else if (s > 2) {
          if (marker) cell = cdivs(cell, cnorm(cell));
          else cell = cmul(cell, lay.cst[takeBits(tx, st, lay.bps)]);
        }
        put(bi, b, s - 2, cell);
      }
    });
    if (st.p !== lay.n) throw new Error("OFDM cells consumed " + st.p + " of " + lay.n);
  }
  const qamPilot = (bin, s) => bin % 2 === 0 ? s % HF_PP === 2 : s % HF_PP === 3;
  function ofdmFrameRows(l, other, ph, tx) {
    const nc = l.nc, first = l.first;
    const lay = {spf: l.spf, bps: l.bps, n: l.n, qam: l.isQam, cst: constellation(l.bps), map: symbolMap(l, other)};
    const rows = Array.from({length: lay.spf - 1}, () => new Array(nc));
    const bins = Array.from({length: nc}, (_, bi) => first + bi);
    layoutCells(lay, bins, qamPilot, tx, (bi, b, r, cell) => { rows[r][bi] = cmul(cell, cconj(ph[b][r])); });
    return rows;
  }
  function ofdmModulate(l, other, ph, txs, rand) {
    const nc = l.nc, cst = constellation(l.bps), lead = l.leadIn;
    const draw = () => {
      const rows = Array.from({length: lead}, () => new Array(nc));
      for (let bi = 0; bi < nc; bi++) for (const row of rows) row[bi] = cst[rand(cst.length)];
      return rows;
    };
    const sets = Array.from({length: txs.length > 1 ? 3 : 1}, draw);
    let rows = sets[sets.length >> 1];
    for (const tx of txs) rows = rows.concat(ofdmFrameRows(l, other, ph, tx));
    return ofdmSynth(l.first, rows, 1);
  }

  // ───────────────────────────── HF modulator
  const TUNE_BACKOFF_DB = 6.4, CWID_BACKOFF_DB = 9.6;
  function tuneSymbol(driveDb) {
    const a = Math.SQRT2 * dbAmp(driveDb - TUNE_BACKOFF_DB), n = SYMBOL_SAMPLES, out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = a * Math.sin(2 * PI * TONE_BIN * i / n);
    return out;
  }
  class Modulator {
    constructor(bw) { this.bw = bw; this.tables = tables(bw); }
    encode(record, frame) {
      const l = this.bw.level(record), t = this.tables[record - 1];
      const info = frameBits(frame, l.k);
      whiten(info, hfWhitening());
      return interleave(turboEncode(info, t.turbo, l.puncturePeriod, l.n), t.chan);
    }
    gain(record, driveDb) { return txGain(this.bw.level(record).papr, driveDb); }
    transmission(record, frames, rand) {
      const l = this.bw.level(record), other = this.tables[record - 1].other;
      const txs = frames.map(f => this.encode(record, f));
      const x = l.isFsk ? fskModulate(l, other, txs, rand)
        : l.wf === "psk" ? pskModulate(l, other, pskPhasors(), txs, rand)
          : ofdmModulate(l, other, ofdmPhasors(), txs, rand);
      const norm = this.bw.ampNorm(record);
      for (let i = 0; i < x.length; i++) x[i] /= norm;
      return x;
    }
  }

  // ───────────────────────────── CW ID
  const CW_UNIT = 2048;
  const MORSE = {A: "10111", B: "111010101", C: "11101011101", D: "1110101", E: "1", F: "101011101", G: "111011101",
    H: "1010101", I: "101", J: "1011101110111", K: "111010111", L: "101110101", M: "1110111", N: "11101",
    O: "11101110111", P: "10111011101", Q: "1110111010111", R: "1011101", S: "10101", T: "111", U: "1010111",
    V: "101010111", W: "101110111", X: "11101010111", Y: "1110101110111", Z: "11101110101", 1: "10111011101110111",
    2: "101011101110111", 3: "1010101110111", 4: "10101010111", 5: "101010101", 6: "11101010101",
    7: "1110111010101", 8: "111011101110101", 9: "11101110111011101", 0: "1110111011101110111"};
  function cwUnits(text) {
    const out = [];
    for (const ch of text.toUpperCase()) {
      if (ch === " ") for (let i = 0; i < 7; i++) out.push(false);
      else if (MORSE[ch]) { for (const b of MORSE[ch]) out.push(b === "1"); out.push(false, false, false); }
    }
    return out;
  }
  function cwSynth(call, blanks, raBoard) {
    const units = cwUnits(" ".repeat(blanks) + call), out = new Float64Array(units.length * CW_UNIT);
    const s64 = sine(64, CW_UNIT), s32 = sine(32, CW_UNIT);
    let keyed = false, o = 0;
    for (const u of units) {
      keyed = keyed || u;
      const a = u ? 1.6 : 0, b = keyed && !raBoard ? 0.8 : 0;
      for (let i = 1; i <= CW_UNIT; i++) out[o++] = a * s64[i] + b * s32[i];
    }
    return out;
  }

  // ───────────────────────────── turbo decoder (max-log-MAP, float kernel, windowed as upstream)
  const TRELLIS = (() => {
    const next = [], par = [];
    for (let s = 0; s < 8; s++) {
      const r0 = (s >> 2) & 1, r1 = (s >> 1) & 1, r2 = s & 1;
      next.push([0, 0]); par.push([0, 0]);
      for (let u = 0; u < 2; u++) {
        const a = u ^ r0 ^ r1;
        par[s][u] = (a ^ r2 ^ r0) === 1 ? 1 : 0;
        next[s][u] = (r1 << 2) | (r2 << 1) | a;
      }
    }
    const gi = (s, u) => (u << 1) | par[s][u];
    const GI = [], EDGE = Array.from({length: 8}, () => [null, null]);
    for (let s = 0; s < 8; s++) {
      GI.push([gi(s, 0), gi(s, 1)]);
      for (let u = 0; u < 2; u++) EDGE[next[s][u]][s >> 2] = [s, gi(s, u)];
    }
    return {next, par, GI, EDGE};
  })();
  const usedLen = (k, p) => puncturedLen(k, p);
  function turboSplit(llr, perm, p) {
    const k = perm.length, tl = k + 3;
    const ls = new Float64Array(tl), lp1 = new Float64Array(tl), ls2 = new Float64Array(tl), lp2 = new Float64Array(tl);
    let i = 0;
    const next = () => {
      if (i >= llr.length) throw new Error("too few LLRs");
      const v = llr[i++];
      return Number.isFinite(v) ? v : 0;
    };
    const h = p >> 1;
    for (let t = 0; t < k; t++) {
      ls[t] = next();
      if (p === 1 || t % p === 0) lp1[t] = next();
      if (p === 1 || t % p === h) lp2[t] = next();
    }
    for (let t = k; t < tl; t++) { ls[t] = next(); lp1[t] = next(); ls2[t] = next(); lp2[t] = next(); }
    for (let j = 0; j < k; j++) ls2[j] = ls[perm[j]];
    return {ls, lp1, ls2, lp2};
  }
  function crcBytes(white, nbytes, bits) {
    const out = new Uint8Array(nbytes);
    for (let i = 0; i < nbytes; i++) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = ((v << 1) | ((bits[8 * i + j] ^ white[8 * i + j]) & 1)) & 255;
      out[i] = v;
    }
    return out;
  }

  const TLEN = 1024, TSEGMENTS = 4, NEG = -1e9;
  // Float kernel. a, b: Float64Array(8) state metrics; cells: Float64Array(TLEN * 8).
  const KA = new Float64Array(8), KG = new Float64Array(4), KB = new Float64Array(16);
  function kAlpha(x, off, p, poff, len, a, cells) {
    const E = TRELLIS.EDGE;
    for (let t = 0; t < len; t++) {
      for (let s = 0; s < 8; s++) cells[t * 8 + s] = a[s];
      const xa = x[off + t], pa = p[poff + t];
      const ga = 0.5 * (xa + pa), gb = 0.5 * (xa - pa);
      KG[0] = ga; KG[1] = gb; KG[2] = -gb; KG[3] = -ga;
      for (let d = 0; d < 8; d++) {
        const e0 = E[d][0], e1 = E[d][1];
        const v0 = a[e0[0]] + KG[e0[1]], v1 = a[e1[0]] + KG[e1[1]];
        KA[d] = v0 > v1 ? v0 : v1;
      }
      const n0 = KA[0];
      for (let d = 0; d < 8; d++) a[d] = KA[d] - n0;
    }
  }
  function kBeta(x, off, p, poff, len, b, cells, out, outOff, outLen, scale) {
    const NX = TRELLIS.next, GI = TRELLIS.GI;
    for (let t = len - 1; t >= 0; t--) {
      const xa = x[off + t], pa = p[poff + t];
      const ga = 0.5 * (xa + pa), gb = 0.5 * (xa - pa);
      KG[0] = ga; KG[1] = gb; KG[2] = -gb; KG[3] = -ga;
      for (let s = 0; s < 8; s++) {
        KB[2 * s] = b[NX[s][0]] + KG[GI[s][0]];
        KB[2 * s + 1] = b[NX[s][1]] + KG[GI[s][1]];
      }
      if (t < outLen) {
        let m0 = -Infinity, m1 = -Infinity;
        for (let s = 0; s < 8; s++) {
          const as = cells[t * 8 + s];
          const v0 = as + KB[2 * s], v1 = as + KB[2 * s + 1];
          if (!(m0 > v0)) m0 = v0;
          if (!(m1 > v1)) m1 = v1;
        }
        out[outOff + t] = scale * ((m0 - m1) - xa);
      }
      let n0 = 0;
      for (let s = 0; s < 8; s++) {
        const v0 = KB[2 * s], v1 = KB[2 * s + 1], v = v0 > v1 ? v0 : v1;
        if (s === 0) n0 = v;
        KA[s] = v;
      }
      for (let s = 0; s < 8; s++) b[s] = KA[s] - n0;
    }
  }
  const TERM = () => Float64Array.of(0, NEG, NEG, NEG, NEG, NEG, NEG, NEG);
  // early: null or {min, white, nbytes}
  function turboDecode(sp, perm, iters, scale, early) {
    const k = perm.length, tl = k + 3;
    const ls = [sp.ls, sp.ls2], lp = [sp.lp1, sp.lp2];
    const nwin = Math.ceil(tl / TLEN), seg = Math.ceil(nwin / TSEGMENTS) * TLEN, nseg = Math.ceil(tl / seg);
    const inv = new Uint32Array(k);
    for (let i = 0; i < k; i++) inv[perm[i]] = i;
    const ext = [new Float64Array(k), new Float64Array(k)], le21 = new Float64Array(k), bits = new Uint8Array(k);
    const mk = n => Array.from({length: n}, () => new Float64Array(8));
    const pb = [[mk(nwin + 1), mk(nwin + 1)], [mk(nwin + 1), mk(nwin + 1)]];
    const ap = [[mk(nseg + 1), mk(nseg + 1)], [mk(nseg + 1), mk(nseg + 1)]];
    const x = new Float64Array(seg), cells = new Float64Array(TLEN * 8), a = new Float64Array(8), b = new Float64Array(8);
    let ran = 0;
    for (let it = 1; it <= iters; it++) {
      const old = (it + 1) % 2, nw = it % 2;
      for (let d = 0; d < 2; d++) {
        const lsd = ls[d], lpd = lp[d], src = d === 0 ? le21 : ext[0];
        for (let i = 0; i < nseg; i++) {
          const s0 = i * seg, s1 = Math.min((i + 1) * seg, tl);
          for (let t = s0; t < s1; t++)
            x[t - s0] = t >= k ? lsd[t] : d === 0 ? lsd[t] + src[t] : lsd[t] + src[perm[t]];
          if (i === 0) a.set(TERM()); else a.set(ap[d][old][i]);
          // segment(): windows of TLEN over [s0, s1)
          let s = s0;
          while (s < s1) {
            const e = Math.min(s + TLEN, s1);
            const wlen = e - s;
            kAlpha(x, s - s0, lpd, s, wlen, a, cells);
            if (e === tl) b.set(TERM()); else b.set(pb[d][old][e / TLEN | 0]);
            const kk = Math.max(0, Math.min(k, e) - s);
            kBeta(x, s - s0, lpd, s, wlen, b, cells, ext[d], s, kk, scale);
            pb[d][nw][(s / TLEN) | 0].set(b);
            s = e;
          }
          if (i + 1 < nseg) ap[d][nw][i + 1].set(a);
        }
      }
      let changed = false;
      const e1 = ext[0], e2 = ext[1], l0 = ls[0];
      for (let j = 0; j < k; j++) {
        le21[j] = e2[inv[j]];
        const bit = (l0[j] + e1[j]) + le21[j] < 0 ? 1 : 0;
        if (bit !== bits[j]) changed = true;
        bits[j] = bit;
      }
      ran = it;
      if (early && it >= early.min && it < iters && !changed && crcOk(crcBytes(early.white, early.nbytes, bits))) break;
    }
    return {bits, iterations: ran};
  }

  const ITERATIONS = 10, EXTRINSIC_SCALE = 0.7, MIN_ITERATIONS = 2;
  function decodeFrame(t, k, n, p, white, early, llrTx) {
    if (llrTx.length !== t.chan.length) throw new Error("demapper and channel interleaver disagree on frame length");
    const soft = new Float64Array(n);
    for (let i = 0; i < t.chan.length; i++) soft[t.chan[i]] = llrTx[i];
    const sp = turboSplit(soft.subarray(0, usedLen(k, p)), t.turbo, p);
    const nbytes = k >> 3;
    const d = turboDecode(sp, t.turbo, ITERATIONS, EXTRINSIC_SCALE,
      early ? {min: MIN_ITERATIONS, white, nbytes} : null);
    const bytes = crcBytes(white, nbytes, d.bits);
    return {bytes, ok: crcOk(bytes), iterations: d.iterations};
  }
  class FrameDecoder {
    constructor(bw) { this.bw = bw; this.tables = tables(bw); this.white = hfWhitening(); this.early = true; }
    decode(record, llrTx) {
      const l = this.bw.level(record);
      return decodeFrame(this.tables[record - 1], l.k, l.n, l.puncturePeriod, this.white, this.early, llrTx);
    }
  }

  // ───────────────────────────── demapper / equaliser
  const CAND = 4;
  class Demapper {
    constructor(cst) {
      this.cst = cst;
      this.bps = Math.log2(cst.length) | 0;
      this.cand = [];
      const bps = this.bps;
      for (let h = 0; h < cst.length; h++)
        for (let b = 0; b < bps; b++) {
          const sh = bps - 1 - b;
          const c = [];
          for (let j = 0; j < cst.length; j++) if (((j ^ h) >> sh) & 1) c.push(j);
          const d = j => cnorm2([cst[j][0] - cst[h][0], cst[j][1] - cst[h][1]]);
          c.sort((x, y) => d(x) - d(y) || 0);
          this.cand.push(Array.from({length: CAND}, (_, i) => c[Math.min(i, c.length - 1)]));
        }
    }
    nearest(zr, zi) {
      let bi = 0, bd = Infinity;
      const cst = this.cst;
      for (let i = 0; i < cst.length; i++) {
        const dr = zr - cst[i][0], di = zi - cst[i][1], d = dr * dr + di * di;
        if (d < bd) { bi = i; bd = d; }
      }
      NEAREST[0] = bi; NEAREST[1] = bd;
      return NEAREST;
    }
    softBits(z, nvar, w, out) {
      const bps = this.bps, cst = this.cst;
      for (let i = 0; i < z.length; i++) {
        const zr = z[i][0], zi = z[i][1];
        const nr = this.nearest(zr, zi), h = nr[0], dh = nr[1];
        const s = (w ? w[i] : 1) / nvar;
        for (let b = 0; b < bps; b++) {
          const cand = this.cand[h * bps + b];
          let dalt = Infinity;
          for (const j of cand) {
            const dr = zr - cst[j][0], di = zi - cst[j][1], d = dr * dr + di * di;
            dalt = Math.min(dalt, d);
          }
          const v = (dalt - dh) * s;
          out.push(((h >> (bps - 1 - b)) & 1) === 0 ? v : -v);
        }
      }
    }
  }
  const NEAREST = [0, 0];
  const DEMAPPERS = [];
  function demapper(cst) {
    let d = DEMAPPERS.find(x => x.cst === cst);
    if (!d) { d = new Demapper(cst); DEMAPPERS.push(d); }
    return d;
  }
  function energyLlrs(m, bps, out) {
    for (let k = 0; k < bps; k++) {
      const sh = bps - 1 - k;
      let m0 = -Infinity, m1 = -Infinity;
      for (let idx = 0; idx < m.length; idx++) {
        const v = m[idx];
        if (((idx >> sh) & 1) === 0) m0 = Math.max(m0, v); else m1 = Math.max(m1, v);
      }
      out.push(m0 - m1);
    }
  }
  function softBits(z, cst, nvar, out) {
    if (cst.length > 2 * CAND) return demapper(cst).softBits(z, nvar, null, out);
    const bps = Math.log2(cst.length) | 0, d = new Float64Array(cst.length);
    for (const zi of z) {
      for (let j = 0; j < cst.length; j++) {
        const dr = zi[0] - cst[j][0], di = zi[1] - cst[j][1];
        d[j] = -(dr * dr + di * di) / nvar;
      }
      energyLlrs(d, bps, out);
    }
  }
  // eq.rs
  function eqDiff(c, rows, nb, rot) {
    const out = [];
    for (let r = 1; r < rows; r++) {
      const row = [];
      for (let b = 0; b < nb; b++) row.push(cmul(cmul(c[r][b], cconj(c[r - 1][b])), rot));
      out.push(row);
    }
    return out;
  }
  function dpskNvar(d, eps, marks) {
    let n = 0, sum = 0;
    for (const row of d) { n += row.length; for (const v of row) sum += cnorm(v); }
    const g = sum / n + eps;
    for (const row of d) for (let i = 0; i < row.length; i++) row[i] = cdivs(row[i], g);
    let ms = 0, mc = 0;
    for (const [i, j] of marks) { const v = d[i][j]; ms += cnorm2([v[0] - cnorm(v), v[1]]); mc++; }
    return Math.max(ms / mc, 1e-3);
  }
  function derotate(c, thd) {
    c.forEach((cr, row) => {
      const r = polar(1, -thd * row);
      for (let i = 0; i < cr.length; i++) cr[i] = cmul(cr[i], r);
    });
  }
  function interp(x, xs, ys) {
    if (!xs.length) return C(1, 0);
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let lo = 0, hi = xs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m + 1; else hi = m; }
    const i = lo - 1, x0 = xs[i], x1 = xs[i + 1], f = (x - x0) / (x1 - x0);
    return [ys[i][0] * (1 - f) + ys[i + 1][0] * f, ys[i][1] * (1 - f) + ys[i + 1][1] * f];
  }
  class Eq {
    constructor() { this.zs = []; this.ws = []; }
    push(y, x, xs, ys) {
      const h = interp(x, xs, ys), z = cdiv(y, h);
      this.zs.push(Number.isFinite(z[0]) && Number.isFinite(z[1]) ? z : C(0, 0));
      this.ws.push(cnorm2(h));
    }
    llrs(cst, floor, llr) {
      let sw = 0;
      for (const w of this.ws) sw += w;
      const mw = sw / Math.max(this.ws.length, 1) + 1e-30;
      const wn = this.ws.map(w => w / mw);
      const dm = demapper(cst);
      let err = 0;
      for (let i = 0; i < this.zs.length; i++) err += wn[i] * dm.nearest(this.zs[i][0], this.zs[i][1])[1];
      const nvar = Math.max(err / Math.max(this.zs.length, 1), floor);
      dm.softBits(this.zs, nvar, wn, llr);
      return nvar;
    }
  }

  // ───────────────────────────── dsp: tracks, windows, holds
  const MIN_I64 = -1e15;
  const remEuclid = (a, b) => { const r = a % b; return r < 0 ? r + Math.abs(b) : r; };
  const divEuclid = (a, b) => Math.floor(a / b);
  class Track {
    constructor(keep, zero) { this.base = 0; this.buf = []; this.keep = keep; this.zero = zero === undefined ? null : zero; }
    end() { return this.base + this.buf.length; }
    restart(base) { this.base = base; this.buf = []; }
    append(m0, v) {
      if (m0 !== this.end()) this.restart(m0);
      for (const x of v) this.buf.push(x);
      if (this.buf.length > 2 * this.keep) {
        const drop = this.buf.length - this.keep;
        this.buf.splice(0, drop);
        this.base += drop;
      }
    }
    at(i) { return this.buf[i - this.base]; }
    get(a, b) {
      const out = new Array(Math.max(0, b - a)), e = this.end();
      for (let i = a; i < b; i++) out[i - a] = i >= this.base && i < e ? this.buf[i - this.base] : this.zero;
      return out;
    }
  }
  const CZERO = Object.freeze([0, 0]);
  const ctrack = keep => new Track(keep, CZERO);
  class Window {
    constructor(n) { this.n = n; this.re = new Float64Array(n); this.im = new Float64Array(n); }
    at(track, a, len) {
      const re = this.re, im = this.im, e = track.end();
      re.fill(0); im.fill(0);
      for (let i = 0; i < len && i < this.n; i++) {
        const k = a + i;
        if (k >= track.base && k < e) { const z = track.buf[k - track.base]; re[i] = z[0]; im[i] = z[1]; }
      }
      fft(re, im, -1);
      return this;
    }
  }
  const CHI_MIN = 20;
  class Hold {
    constructor(hold, dead) { this.hold = hold; this.dead = dead; this.best = null; this.block = MIN_I64; }
    push(pos, metric, extra) {
      const out = this.flushBefore(pos);
      if (!out && pos >= this.block && (!this.best || metric > this.best[1])) this.best = [pos, metric, extra];
      return out;
    }
    flushBefore(pos) {
      if (this.best && pos - this.best[0] > this.hold) { const b = this.best; this.best = null; return b; }
      return null;
    }
    retain(f) { if (this.best && !f(this.best)) this.best = null; }
    offer(pos, cand) {
      const out = cand ? this.push(pos, cand[0], cand[1]) : this.flushBefore(pos);
      if (out) this.block = out[0] + this.dead;
      return out;
    }
  }
  function median(v) {
    const a = Float64Array.from(v).sort(), n = a.length;
    if (!n) throw new Error("median of nothing");
    return n % 2 === 1 ? a[n >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
  }
  function peakMid(vals, i, rel) {
    const tol = vals.length > 2 ? rel * (vals[i] - median(vals)) : 0;
    let j0 = i, j1 = i;
    while (j0 > 0 && vals[j0 - 1] >= vals[i] - tol) j0--;
    while (j1 + 1 < vals.length && vals[j1 + 1] >= vals[i] - tol) j1++;
    return (j0 + j1) >> 1;
  }
  const unit = z => { const n = cnorm(z) + 1e-30; return [z[0] / n, z[1] / n]; };
  function argmax(v) { let b = 0; for (let i = 0; i < v.length; i++) if (v[i] > v[b]) b = i; return b; }
  function thin(v, max) {
    if (v.length <= max) return v;
    return Array.from({length: max}, (_, i) => v[Math.floor(i * v.length / max)]);
  }
  function besselI0(x) {
    let sum = 1, term = 1, k = 1;
    while (term > 1e-17 * sum) { const q = x / (2 * k); term *= q * q; sum += term; k += 1; }
    return sum;
  }
  function kaiserLowpass(n, cutoff, fs, beta) {
    const fc = cutoff / (fs / 2), mid = (n - 1) / 2, h = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const m = i - mid;
      const sinc = m === 0 ? 1 : Math.sin(PI * fc * m) / (PI * fc * m);
      const r = 2 * i / (n - 1) - 1;
      h[i] = fc * sinc * besselI0(beta * Math.sqrt(Math.max(1 - r * r, 0))) / besselI0(beta);
    }
    let s = 0;
    for (const v of h) s += v;
    return h.map(v => v / s);
  }
  const csum = arr => { let r = 0, i = 0; for (const z of arr) { r += z[0]; i += z[1]; } return [r, i]; };
  const carg = z => Math.atan2(z[1], z[0]);
  function cpowi(z, e) {
    // num_traits::pow (exponentiation by squaring); e in {1, 2, 4, 8, 16, 32}
    let base = z;
    while ((e & 1) === 0) { base = cmul(base, base); e >>= 1; }
    if (e === 1) return base;
    let acc = base;
    while (e > 1) { e >>= 1; base = cmul(base, base); if (e & 1) acc = cmul(acc, base); }
    return acc;
  }

  // ───────────────────────────── shared receiver pieces (receiver.rs)
  function meanPower(buf, a, b) {
    const v = buf.get(a, b);
    let s = 0;
    for (const z of v) s += z[0] * z[0] + z[1] * z[1];
    return s / Math.max(v.length, 1);
  }
  function continues(buf, after, frame, noise) {
    const pa = meanPower(buf, after[0], after[1]), pf = meanPower(buf, frame[0], frame[1]);
    return pa - noise > 0.3 * Math.max(pf - noise, 1e-30) && pf > 4 * noise;
  }
  class Muted {
    constructor() { this.v = []; }
    mute(buf, fs, a, b) {
      const keep = buf.end() - 8 * Math.trunc(fs);
      this.v = this.v.filter(m => m[1] > keep);
      this.v.push([a - 64, b + 64]);
    }
    overlaps(a, b) { return this.v.some(m => a < m[1] && b > m[0]); }
    quietBlocks(buf, fs, block) {
      const from = Math.max(buf.base, buf.end() - 6 * Math.trunc(fs));
      const v = buf.get(from, buf.end()), p = [];
      for (let i = 0; (i + 1) * block <= v.length; i++) {
        if (this.overlaps(from + block * i, from + block * (i + 1))) continue;
        let s = 0;
        for (let j = i * block; j < (i + 1) * block; j++) s += v[j][0] * v[j][0] + v[j][1] * v[j][1];
        p.push(s / block);
      }
      if (p.length < 4) return null;
      return Float64Array.from(p).sort();
    }
  }
  function percentileSorted(p, q) {
    const pos = q / 100 * (p.length - 1), i = Math.floor(pos), f = pos - i;
    return i + 1 < p.length ? p[i] * (1 - f) + p[i + 1] * f : p[i];
  }
  const fOk = f => f.frame.ok, fT = f => f.frame.t, fTEnd = f => f.frame.tEnd;

  // Frame-pair assembly shared by the HF and FM receivers (receiver.rs, trait Assemble).
  class Assembler {
    initAsm(nframes) { this.asm = {nframes, cur: null, doneUntil: MIN_I64, txEnd48: null}; }
    holds() { return false; }
    keepFrame() { return true; }
    settled() { return false; }
    onDet(record, t, hint) {
      const K = this.constructor;
      if (!this.has(record) || t < this.asm.doneUntil - 64) return [];
      const span = this.span(record);
      let ev = [];
      const cur = this.asm.cur;
      if (cur) {
        if (cur.record === record && Math.abs(t - (cur.t + span)) <= K.PAIR_TOL && this.pairs(cur, record))
          return this.frame2(record, t, hint, ev);
        if (t < this.frame1End(cur) - 64) {
          if (fOk(cur.frames[0])) return ev;
          const r = this.decode(record, t, 0, hint);
          if (!r) return ev;
          if (fOk(r) || K.EMIT_BAD) ev.push({kind: "frame", ...r});
          if (fOk(r)) this.begin(record, r, hint, ev);
          return ev;
        }
        if (this.holds(cur, t)) return ev;
        ev = ev.concat(this.finalize());
      }
      if (this.asm.nframes === 2) {
        const back = t - span;
        if (back - 8 >= this.track().base && t > this.asm.doneUntil) {
          const rb = this.decode(record, back, 0, hint);
          if (rb && fOk(rb)) {
            ev.push({kind: "frame", ...rb});
            this.start(record, rb, hint);
            return this.frame2(record, t, hint, ev);
          }
        }
        const lost = this.lost(record, back, t, span);
        if (lost) {
          const r = this.decode(record, t, 1, hint);
          if (r && (fOk(r) || !K.LOST_NEEDS_OK)) { this.start(record, lost, hint); return this.close(r, true, ev); }
          if (!K.LOST_NEEDS_OK) return ev;
        }
      }
      const r = this.decode(record, t, 0, hint);
      if (!r) return ev;
      if (!this.keepFrame(r)) return ev;
      if (fOk(r) || K.EMIT_BAD) ev.push({kind: "frame", ...r});
      this.begin(record, r, hint, ev);
      return ev;
    }
    begin(record, r, hint, ev) {
      const settled = this.settled(r);
      this.start(record, r, hint);
      if (settled) for (const e of this.finalize()) ev.push(e);
    }
    start(record, r, hint) {
      const wait = this.wait(record, r, hint);
      this.asm.cur = {record, t: fT(r), frames: [r], two: this.asm.nframes === 2, wait};
    }
    frame2(record, t, hint, ev) {
      const r = this.decode(record, t, 1, hint);
      if (r) return this.close(r, true, ev);
      if (this.constructor.CLOSE_ON_MISS) return ev.concat(this.finalize());
      return ev;
    }
    close(r, emitBad, ev) {
      const cur = this.asm.cur;
      if (!cur) return ev;
      this.asm.cur = null;
      if (fOk(r) || emitBad) ev.push({kind: "frame", ...r});
      cur.frames.push(r);
      return ev.concat(this.finish(cur));
    }
    finalize() {
      const cur = this.asm.cur;
      if (!cur) return [];
      this.asm.cur = null;
      return this.finish(cur);
    }
    finish(cur) {
      const span = this.span(cur.record), last = cur.frames[cur.frames.length - 1];
      this.asm.doneUntil = fT(last) + span - 32;
      const tEnd = fTEnd(last), expected = this.expectedFrames(cur);
      const complete = cur.frames.every(fOk) && cur.frames.length >= expected;
      this.finished(cur.frames);
      return [{kind: "tx", record: cur.record, expected, complete, tEnd, frames: cur.frames, ok: cur.frames.map(fOk)}];
    }
  }

  // ───────────────────────────── HF receive front end (48 kHz real -> 3 kHz complex)
  const FS3 = 3000, DEC = 16;
  function rot(n0, n, fHz) {
    const out = new Array(n);
    for (let k = 0; k < n; k++) out[k] = polar(1, -2 * PI * fHz * (n0 + k) / FS3);
    return out;
  }
  const FE_N1 = 33, FE_N2 = 273, FE_D1 = (FE_N1 - 1) / 2, FE_D2 = (FE_N2 - 1) / 2;
  let FE_TAPS = null;
  class FrontEnd {
    constructor() {
      FE_TAPS = FE_TAPS || {h1: kaiserLowpass(FE_N1, 6000, FS, 5.65), h2: kaiserLowpass(FE_N2, 1520, FS / 4, 5.65),
        mix: Array.from({length: 32}, (_, n) => polar(1, -PI * n / 16))};
      this.h1 = FE_TAPS.h1; this.h2 = FE_TAPS.h2; this.mix = FE_TAPS.mix;
      this.nIn = 0; this.z = ctrack(8192); this.stage1Next = 0; this.u = ctrack(8192); this.outNext = 0;
    }
    process(x) {
      const n0 = this.nIn;
      this.nIn += x.length;
      const z = new Array(x.length);
      for (let i = 0; i < x.length; i++) { const m = this.mix[(n0 + i) % 32]; z[i] = [m[0] * x[i], m[1] * x[i]]; }
      this.z.append(this.z.end(), z);
      const kHi = divEuclid(this.nIn - 1 - FE_D1, 4);
      if (kHi >= this.stage1Next) {
        const u = [];
        for (let k = this.stage1Next; k <= kHi; k++) u.push(fir(this.z, this.h1, 4 * k - FE_D1));
        this.u.append(this.stage1Next, u);
        this.stage1Next = kHi + 1;
      }
      const mHi = divEuclid(this.stage1Next - 1 - FE_D2, 4), m0 = this.outNext;
      if (mHi < m0) return [m0, []];
      const b3 = [];
      for (let m = m0; m <= mHi; m++) { const s = m % 2 === 1 ? -2 : 2, v = fir(this.u, this.h2, 4 * m - FE_D2); b3.push([v[0] * s, v[1] * s]); }
      this.outNext = mHi + 1;
      return [m0, b3];
    }
  }
  function fir(t, h, start) {
    let ar = 0, ai = 0;
    const base = t.base, buf = t.buf;
    for (let i = 0; i < h.length; i++) {
      const n = start + i;
      if (n >= base) { const z = buf[n - base], c = h[i]; ar += z[0] * c; ai += z[1] * c; }
    }
    return [ar, ai];
  }

  // ───────────────────────────── SNR estimates (hf/rx/snr.rs)
  const SNR_REF_DB = 9.4, FSK_K_DB = 17.2, PSK_K_DB = 20.91, OFDM_K_DB = 20.81;
  const lg = x => x > 0 ? Math.log10(x) : -Infinity;
  const snrNormalise = (raw, l) => raw - (SNR_REF_DB - l.papr);
  function phaseErrorSnr(prods, l, kDb) {
    const u = prods.map(p => { const n = cnorm(p); return n > 0 ? cdivs(p, n) : p; });
    const s = csum(u), r = polar(1, -carg(s));
    const v = u.map(p => Math.abs(cmul(p, r)[1]));
    return 10 * lg(64 / l.sps) + 10 * lg(l.nc) - 20 * lg(median(v)) - kDb + l.snrCorr;
  }

  // ───────────────────────────── HF FSK engine
  const FSK_HOP = 4, FSK_MIN_HITS = 14, FRACTIONS = [-0.375, -0.25, -0.125, 0, 0.125, 0.25, 0.375];
  class FskEngine {
    constructor(bw, record, other) {
      const l = bw.level(record), g = fskGrid(l);
      this.record = record; this.l = l; this.grid = g;
      this.sps = g.sps; this.nrow = g.symbols - 1; this.tones = 1 << l.bps;
      const bin = (b, t) => g.bin(b, t), nrow = this.nrow, pairs = nrow + FSK_PILOTS;
      this.base = other.subarray(0, nrow);
      this.isPilot = Array.from({length: nrow}, (_, i) => other[pairs + 2 * i] !== 0);
      const pval = Array.from({length: nrow}, (_, i) => other[pairs + 2 * i + 1]);
      this.pilotRows = [];
      for (let i = 0; i < nrow; i++) if (this.isPilot[i]) this.pilotRows.push(i);
      this.pilotBins = this.pilotRows.map(i => bin(this.base[i], pval[i]));
      this.pilotTones = this.pilotRows.map(i => Array.from({length: this.tones}, (_, t) => bin(this.base[i], t)));
      this.hopRows = this.sps / FSK_HOP;
      this.span = nrow * this.sps;
      this.binhz = FS3 / this.sps;
      this.win = new Window(this.sps);
      this.energy = new Track(nrow * this.hopRows + 64 * this.hopRows);
      this.stftNext = 0; this.searchNext = 0;
      this.hold = new Hold(4, (nrow - 2) * this.hopRows);
    }
    startAt(start) { this.stftNext = divEuclid(start, FSK_HOP); this.searchNext = this.stftNext; }
    stft(buf) {
      const jHi = divEuclid(buf.end() - this.sps, FSK_HOP);
      if (jHi < this.stftNext) return;
      this.stftNext = Math.max(this.stftNext, divEuclid(buf.base + FSK_HOP - 1, FSK_HOP));
      const rows = [];
      for (let j = this.stftNext; j <= jHi; j++) {
        const w = this.win.at(buf, j * FSK_HOP, this.sps), row = new Float64Array(this.sps);
        for (let k = 0; k < this.sps; k++) row[k] = w.re[k] * w.re[k] + w.im[k] * w.im[k];
        rows.push(row);
      }
      this.energy.append(this.stftNext, rows);
      this.stftNext = jHi + 1;
    }
    metric(j, d) {
      const sps = this.sps, clip = k => Math.min(sps - 1, Math.max(0, k + d));
      let pe = 0, ce = 0, hits = 0;
      for (let n = 0; n < this.pilotRows.length; n++) {
        const row = this.energy.at(j + this.pilotRows[n] * this.hopRows);
        const p = row[clip(this.pilotBins[n])];
        let cmax = -Infinity;
        for (const k of this.pilotTones[n]) { const v = row[clip(k)]; ce += v; cmax = Math.max(cmax, v); }
        pe += p;
        if (p >= cmax && p > 1e-9) hits++;
      }
      return [pe / (ce + 1e-30), hits];
    }
    step(ctx) {
      this.stft(ctx.buf);
      const need = (this.nrow - 1) * this.hopRows, cHi = this.energy.end() - 1 - need;
      const lo = Math.max(this.searchNext, this.energy.base);
      const dmax = Math.max(Math.ceil(ctx.searchHz / this.binhz), 1), out = [];
      if (cHi < lo) return out;
      for (let j = lo; j <= cHi; j++) {
        let best = null;
        for (let d = -dmax; d <= dmax; d++) {
          const [frac, hits] = this.metric(j, d);
          if (hits >= FSK_MIN_HITS && (!best || frac > best[0])) best = [frac, d];
        }
        const r = this.hold.offer(j, best && best[0] > 0 ? best : null);
        if (r) out.push({record: this.record, t: r[0] * FSK_HOP, hint: {fsk: r[2]}});
      }
      this.searchNext = cHi + 1;
      return out;
    }
    rowsAt(buf, t, shiftHz) {
      const seg = buf.get(t, t + this.span);
      if (shiftHz !== 0) { const r = rot(t, this.span, shiftHz); for (let i = 0; i < seg.length; i++) seg[i] = cmul(seg[i], r[i]); }
      const rows = [], sps = this.sps, re = new Float64Array(sps), im = new Float64Array(sps);
      for (let c = 0; c + sps <= seg.length; c += sps) {
        for (let i = 0; i < sps; i++) { re[i] = seg[c + i][0]; im[i] = seg[c + i][1]; }
        fft(re, im, -1);
        const row = new Float64Array(sps);
        for (let i = 0; i < sps; i++) row[i] = re[i] * re[i] + im[i] * im[i];
        rows.push(row);
      }
      return rows;
    }
    pilotFrac(rows) {
      let pe = 0, ce = 0;
      for (let n = 0; n < this.pilotRows.length; n++) {
        const i = this.pilotRows[n];
        pe += rows[i][this.pilotBins[n]];
        let s = 0;
        for (const k of this.pilotTones[n]) s += rows[i][k];
        ce += s;
      }
      return pe / (ce + 1e-30);
    }
    demap(rows) {
      const below = [], f0 = this.grid.first;
      for (const r of rows) for (let k = 0; k < f0; k++) below.push(r[k]);
      const noise = median(below) + 1e-12, llr = [], m = new Float64Array(this.tones);
      rows.forEach((row, r) => {
        if (this.isPilot[r]) return;
        for (let v = 0; v < this.tones; v++) m[v] = row[this.grid.bin(this.base[r], GRAY[v])] / (noise * 10);
        energyLlrs(m, this.l.bps, llr);
      });
      return llr;
    }
    rawSnr(rows) {
      const ratios = this.pilotRows.map((i, n) => {
        const p = rows[i][this.pilotBins[n]];
        let s = 0;
        for (const k of this.pilotTones[n]) s += rows[i][k];
        const other = (s - p) / (this.tones - 1);
        return other > 0 ? p / other : 0;
      });
      return 10 * lg(median(ratios)) + 10 * lg(64 / this.sps) - FSK_K_DB;
    }
    decode(buf, dec, t0, d, index) {
      const refine = FSK_HOP;
      if (t0 + this.span + refine > buf.end() || t0 - refine < buf.base) return null;
      const sh0 = d * this.binhz, ts = [];
      for (let t = t0 - refine + 1; t < t0 + refine; t++) ts.push(t);
      const vals = ts.map(t => this.pilotFrac(this.rowsAt(buf, t, sh0)));
      const t = ts[argmax(vals)];
      let metric = -Infinity, sh = sh0;
      for (const f of FRACTIONS) {
        const s = sh0 + f * this.binhz, v = this.pilotFrac(this.rowsAt(buf, t, s));
        if (v > metric || (v === metric && s > sh)) { metric = v; sh = s; }
      }
      const rows = this.rowsAt(buf, t, sh), out = dec.decode(this.record, this.demap(rows));
      const raw = this.rawSnr(rows), norm = r => snrNormalise(r, this.l);
      let sv = 0;
      for (const dd of [-2, -1, 1]) sv += norm(this.rawSnr(this.rowsAt(buf, t + dd, sh)));
      sv += norm(raw);
      return {record: this.record, index, t, tEnd: t + this.span, ok: out.ok, bytes: out.bytes, rawSnrDb: raw,
        snrDb: norm(raw), snrAvgDb: sv / 4, afcRes: sh, iterations: out.iterations, metric};
    }
  }

  // ───────────────────────────── HF PSK engine
  const PSK_STEP = 2, PSK_MAX_DAT = 1500;
  function firAt(v, i, taps) {
    let r = 0, im = 0;
    for (let j = 0; j < taps.length; j++) { const x = v[i + j], t = taps[j]; r += x[0] * t; im += x[1] * t; }
    return [r, im];
  }
  class PskEngine {
    constructor(bw, record, other, phasors) {
      const l = bw.level(record), nc = l.fc.length, nsym = l.dataSymbols;
      this.record = record; this.l = l; this.nsym = nsym; this.order = 1 << l.bps;
      const map = symbolMap(l, other), hp = pulseTaps(l.span);
      let hs = 0;
      for (const v of hp) hs += v;
      this.taps = hp.map(v => v / hs);
      this.delay = (this.taps.length - 1) / 2;
      const pilot = (c, s) => s >= 2 && map[c][s - 2] === 1;
      let ndatAll = 0;
      for (let c = 0; c < nc; c++) for (let s = 1; s < nsym; s++) if (!pilot(c, s)) ndatAll++;
      const keep = Math.min(PSK_MAX_DAT / Math.max(ndatAll, 1), 1);
      this.maxStagger = 0;
      for (let c = 0; c < nc; c++) this.maxStagger = Math.max(this.maxStagger, stagger(c, nc));
      const tk = nsym * PSK_SPS + 4096;
      this.carriers = l.fc.map((fc, c) => {
        const p = phasors[c].slice(0, nsym), pilots = [], dataAll = [];
        for (let s = 1; s < nsym; s++) (pilot(c, s) ? pilots : dataAll).push(s);
        const n = Math.max(Math.trunc(dataAll.length * keep), 1), data = thin(dataAll.slice(), n);
        const q = s => cmul(p[s], cconj(p[s - 1]));
        return {fc, stagger: stagger(c, nc), pilotRef: pilots.map(q), dataRef: data.map(s => cpowi(q(s), this.order)),
          markerSyms: Array.from(other.subarray(c * l.markers, (c + 1) * l.markers)), phasors: p, pilots, data, dataAll,
          filtered: ctrack(tk), diff: ctrack(tk), diffPow: ctrack(tk)};
      });
      this.span = nsym * PSK_SPS;
      this.tail = this.maxStagger + this.delay;
      this.pilotCount = this.carriers.reduce((a, c) => a + c.pilots.length, 0);
      this.dataCount = this.carriers.reduce((a, c) => a + c.data.length, 0);
      this.filterNext = 0; this.searchNext = null;
      this.hold = new Hold(8, this.span - 4 * PSK_SPS);
    }
    startAt(start) {
      this.filterNext = start + this.delay;
      for (const c of this.carriers) { c.filtered.restart(this.filterNext); c.diff.restart(this.filterNext); c.diffPow.restart(this.filterNext); }
    }
    filter(buf) {
      const mHi = buf.end() - 1 - this.delay;
      if (mHi < this.filterNext) return;
      if (this.filterNext < buf.base + this.delay) this.startAt(buf.base);
      const a = this.filterNext - this.delay, seg = buf.get(a, mHi + this.delay + 1), order = this.order;
      for (const c of this.carriers) {
        const v = new Array(seg.length), w = -2 * PI * c.fc / FS3;
        for (let i = 0; i < seg.length; i++) {
          const th = w * (a + i), cr = Math.cos(th), ci = Math.sin(th), z = seg[i];
          v[i] = [cr * z[0] - ci * z[1], cr * z[1] + ci * z[0]];
        }
        const y = [];
        for (let i = 0; i <= mHi - this.filterNext; i++) y.push(firAt(v, i, this.taps));
        c.filtered.append(this.filterNext, y);
        const diff = [];
        for (let n = this.filterNext; n <= mHi; n++)
          diff.push(n - PSK_SPS >= c.filtered.base ? unit(cmul(c.filtered.at(n), cconj(c.filtered.at(n - PSK_SPS)))) : CZERO);
        c.diffPow.append(this.filterNext, diff.map(p => cpowi(p, order)));
        c.diff.append(this.filterNext, diff);
      }
      this.filterNext = mHi + 1;
    }
    chi(t) {
      let ar = 0, ai = 0, br = 0, bi = 0;
      for (const c of this.carriers) {
        const base = t + c.stagger;
        const db = c.diff.buf, d0 = base - c.diff.base, pb = c.diffPow.buf, p0 = base - c.diffPow.base;
        for (let i = 0; i < c.pilots.length; i++) {
          const z = db[d0 + PSK_SPS * c.pilots[i]], q = c.pilotRef[i];
          ar += z[0] * q[0] - z[1] * q[1]; ai += z[0] * q[1] + z[1] * q[0];
        }
        for (let i = 0; i < c.data.length; i++) {
          const z = pb[p0 + PSK_SPS * c.data[i]], q = c.dataRef[i];
          br += z[0] * q[0] - z[1] * q[1]; bi += z[0] * q[1] + z[1] * q[0];
        }
      }
      let chi = (ar * ar + ai * ai) / this.pilotCount;
      if (this.dataCount > 0) chi += (br * br + bi * bi) / this.dataCount;
      return [chi, [ar, ai]];
    }
    step(ctx) {
      this.filter(ctx.buf);
      const y0 = this.carriers[0].filtered, loOk = y0.base + PSK_SPS;
      const hi = y0.end() - 1 - this.maxStagger - PSK_SPS * (this.nsym - 1);
      let lo = Math.max(this.searchNext === null ? loOk : this.searchNext, loOk);
      lo += remEuclid(-lo, PSK_STEP);
      const out = [];
      if (hi < lo) return out;
      let t = lo;
      while (t <= hi) {
        const [chi] = this.chi(t);
        const r = this.hold.offer(t, chi >= CHI_MIN ? [chi, null] : null);
        if (r) out.push({record: this.record, t: r[0], hint: {psk: true}});
        t += PSK_STEP;
      }
      this.searchNext = t;
      return out;
    }
    symbols(buf, t, df) {
      const idx = (c, k) => t + c.stagger + PSK_SPS * k;
      if (df === 0) return this.carriers.map(c => Array.from({length: this.nsym}, (_, k) => cmul(c.filtered.at(idx(c, k)), c.phasors[k])));
      const a = t - this.delay - 1, b = t + this.maxStagger + PSK_SPS * (this.nsym - 1) + this.delay + 1;
      const seg = buf.get(a, b);
      return this.carriers.map(c => {
        const r = rot(a, seg.length, c.fc + df), v = seg.map((s, i) => cmul(r[i], s));
        return Array.from({length: this.nsym}, (_, k) => cmul(firAt(v, idx(c, k) - this.delay - a, this.taps), c.phasors[k]));
      });
    }
    coherence(z) {
      let ar = 0, ai = 0;
      this.carriers.forEach((c, ci) => {
        const zc = z[ci];
        for (const s of c.pilots) { const u = unit(cmul(zc[s], cconj(zc[s - 1]))); ar += u[0]; ai += u[1]; }
      });
      return [ar, ai];
    }
    rawSnr(z) {
      const prods = [];
      this.carriers.forEach((c, ci) => { for (const p of c.markerSyms) prods.push(cmul(cconj(z[ci][p - 1]), z[ci][p])); });
      return phaseErrorSnr(prods, this.l, PSK_K_DB);
    }
    decode(buf, dec, t0, index) {
      const refine = 3, y0 = this.carriers[0].filtered;
      if (t0 + this.maxStagger + PSK_SPS * (this.nsym - 1) + refine > y0.end() - 1 || t0 - refine - PSK_SPS < y0.base) return null;
      const cands = [];
      for (let t = t0 - refine; t <= t0 + refine; t++) cands.push(this.chi(t));
      const i = argmax(cands.map(c => c[0])), t = t0 - refine + i;
      let df = carg(cands[i][1]) * FS3 / (2 * PI * PSK_SPS);
      df = Math.abs(df) > 1 ? df : 0;
      const z = this.symbols(buf, t, df), r = unit(cconj(this.coherence(z)));
      const dfTot = df - carg(r) * FS3 / (2 * PI * PSK_SPS);
      const ds = z.map(zc => { const o = []; for (let k = 1; k < zc.length; k++) o.push(cmul(cmul(zc[k], cconj(zc[k - 1])), r)); return o; });
      const marks = [];
      this.carriers.forEach((c, ci) => { for (const s of c.pilots) marks.push([ci, s - 1]); });
      const nvar = dpskNvar(ds, 0, marks), cst = constellation(this.l.bps), llr = [];
      this.carriers.forEach((c, ci) => softBits(c.dataAll.map(s => ds[ci][s - 1]), cst, nvar, llr));
      const out = dec.decode(this.record, llr), raw = this.rawSnr(z);
      return {record: this.record, index, t, tEnd: t + this.maxStagger + this.span, ok: out.ok, bytes: out.bytes,
        rawSnrDb: raw, snrDb: snrNormalise(raw, this.l), snrAvgDb: null, afcRes: dfTot, iterations: out.iterations, metric: cands[i][0]};
    }
  }

  // ───────────────────────────── HF OFDM engine
  const OHOP = 4, ONF = NFFT / DEC, SYMLEN = (NFFT + NCP) / DEC, OSYM = SYMLEN / OHOP, PP = HF_PP;
  const RESUME_WINDOW = (PP + 1) * SYMLEN, GUARD = 8, OFDM_MAX_DAT = 2000;
  const HYPOTHESES = [0, -23.4375, 23.4375];
  class OfdmStft {
    constructor(fh) { this.fh = fh; this.rows = []; this.base = 0; }
    static hypotheses() { return HYPOTHESES.map(fh => new OfdmStft(fh)); }
    end() { return this.base + this.rows.length; }
    row(j) { return this.rows[j - this.base]; }
    compute(buf, j) {
      const a = j * OHOP, seg = buf.get(a, a + ONF), re = new Float64Array(ONF), im = new Float64Array(ONF);
      const r = this.fh !== 0 ? rot(a, ONF, this.fh) : null;
      for (let i = 0; i < ONF; i++) { const z = r ? cmul(seg[i], r[i]) : seg[i]; re[i] = z[0]; im[i] = z[1]; }
      fft(re, im, -1);
      return {re, im};
    }
    update(buf, lo, hi) {
      if (!this.rows.length || lo > this.end()) { this.rows = []; this.base = lo; }
      const front = [];
      while (this.base > lo) { front.unshift(this.compute(buf, this.base - 1)); this.base--; }
      if (front.length) this.rows = front.concat(this.rows);
      for (let j = this.end(); j <= hi; j++) this.rows.push(this.compute(buf, j));
    }
    keepFrom(j) {
      const n = j === null || j === undefined ? this.rows.length : Math.min(Math.max(j - this.base, 0), this.rows.length);
      this.rows.splice(0, n);
      this.base += n;
    }
  }
  class OfdmScan {
    constructor() { this.fBase = 0; this.stftNext = 0; this.acc = []; this.accBase = 0; this.chi = new Track(1024, 0); }
    restart(j) { this.fBase = j; this.stftNext = j; this.acc = []; this.accBase = j; this.chi.restart(j); }
    rows(buf) {
      const j0 = Math.max(this.stftNext, divEuclid(buf.base + OHOP - 1, OHOP));
      return [j0, divEuclid(buf.end() - ONF, OHOP)];
    }
  }
  function ofdmGroups(cells, off) {
    const g = [];
    for (const c of cells) {
      const o = off(c.s), e = g.find(x => x.off === o);
      if (e) e.cells.push([c.b, c.q]); else g.push({off: o, cells: [[c.b, c.q]]});
    }
    for (const x of g) {
      x.b = Int32Array.from(x.cells, c => c[0]);
      x.qr = Float64Array.from(x.cells, c => c[1][0]);
      x.qi = Float64Array.from(x.cells, c => c[1][1]);
    }
    return g;
  }
  // unit(a * conj(b)) per bin into (or, oi); zeros when no lagged row.
  function laggedUnit(row, o, fb, nb, or, oi) {
    if (!o) { or.fill(0); oi.fill(0); return; }
    for (let b = 0; b < nb; b++) {
      const ar = row.re[fb + b], ai = row.im[fb + b], br = o.re[fb + b], bi = -o.im[fb + b];
      const zr = ar * br - ai * bi, zi = ar * bi + ai * br, n = Math.hypot(zr, zi) + 1e-30;
      or[b] = zr / n; oi[b] = zi / n;
    }
  }
  class OfdmEngine {
    constructor(bw, record, other, phasors) {
      const l = bw.level(record);
      this.record = record; this.l = l;
      const fb = l.first, nb = l.nc, spf = l.spf, nsy = spf - 1, qam = l.isQam, order = 1 << l.bps;
      Object.assign(this, {fb, nb, spf, nsy, qam, order});
      this.map = symbolMap(l, other);
      const p = Array.from({length: nsy}, (_, r) => Array.from({length: nb}, (_, bi) => phasors[fb + bi][r]));
      this.phasors = p;
      const markers = [], data = [], qamPilots = [];
      for (let bi = 0; bi < nb; bi++) {
        for (let s = 3; s <= spf; s++) {
          const q = cmul(p[s - 2][bi], cconj(p[s - 3][bi]));
          if (this.map[bi][s - 2]) markers.push({s, b: bi, q});
          else if (!qam) data.push({s, b: bi, q: cpowi(q, order)});
        }
        if (qam) for (let s = 2; s <= spf; s++)
          if (qamPilot(fb + bi, s) && s + PP <= spf) qamPilots.push({s, b: bi, q: cmul(p[s - 2 + PP][bi], cconj(p[s - 2][bi]))});
      }
      this.markers = markers; this.data = thin(data, OFDM_MAX_DAT); this.qamPilots = qamPilots;
      this.ga = ofdmGroups(markers, s => s - 2);
      this.gb = qam ? ofdmGroups(qamPilots, s => s + 6) : ofdmGroups(this.data, s => s - 2);
      this.span = nsy * SYMLEN;
      this.scans = HYPOTHESES.map(() => new OfdmScan());
      this.searchNext = null;
      this.hold = new Hold(2, OSYM * (nsy - 2));
    }
    startAt(start) {
      for (const sc of this.scans) if (sc.stftNext * OHOP < start - RESUME_WINDOW) sc.restart(divEuclid(start, OHOP));
    }
    rowsNeeded(i, buf) {
      const sc = this.scans[i], [j0, jHi] = sc.rows(buf);
      if (jHi < j0) return null;
      return [j0 !== sc.stftNext ? j0 : Math.max(sc.fBase, j0 - PP * OSYM), jHi];
    }
    rowsKept(i) { const sc = this.scans[i]; return Math.max(sc.fBase, sc.stftNext - PP * OSYM); }
    update(i, buf, st) {
      const sc0 = this.scans[i], [j0, jHi] = sc0.rows(buf);
      if (jHi < j0) return;
      if (j0 !== sc0.stftNext) sc0.restart(j0);
      const na = this.markers.length, nbn = this.qam ? this.qamPilots.length : this.data.length;
      const done = OSYM * (this.spf - 2), fb = this.fb, nb = this.nb, sc = sc0;
      const g1r = this.g1r || (this.g1r = new Float64Array(nb)), g1i = this.g1i || (this.g1i = new Float64Array(nb));
      const gbr = this.gbr || (this.gbr = new Float64Array(nb)), gbi = this.gbi || (this.gbi = new Float64Array(nb));
      for (let j = j0; j <= jHi; j++) {
        const row = st.row(j);
        laggedUnit(row, j - OSYM >= sc.fBase ? st.row(j - OSYM) : null, fb, nb, g1r, g1i);
        if (this.qam) laggedUnit(row, j - PP * OSYM >= sc.fBase ? st.row(j - PP * OSYM) : null, fb, nb, gbr, gbi);
        else {
          for (let b = 0; b < nb; b++) {
            let r = g1r[b], im = g1i[b];
            for (let e = this.order; e > 1; e >>= 1) { const t = r * r - im * im; im = r * im + im * r; r = t; }
            gbr[b] = r; gbi[b] = im;
          }
        }
        sc.acc.push([0, 0, 0, 0]);
        for (let second = 0; second < 2; second++) {
          const gs = second ? this.gb : this.ga, gr = second ? gbr : g1r, gi = second ? gbi : g1i;
          for (const grp of gs) {
            const k = j - OSYM * grp.off - sc.accBase;
            if (k < 0) continue;
            let vr = 0, vi = 0;
            const B = grp.b, QR = grp.qr, QI = grp.qi, n = B.length;
            for (let c = 0; c < n; c++) {
              const b = B[c], xr = gr[b], xi = gi[b], qr = QR[c], qi = QI[c];
              vr += xr * qr - xi * qi; vi += xr * qi + xi * qr;
            }
            const e = sc.acc[k];
            e[2 * second] += vr; e[2 * second + 1] += vi;
          }
        }
        while (sc.accBase <= j - done) {
          const e = sc.acc.shift();
          sc.chi.append(sc.accBase, [(e[0] * e[0] + e[1] * e[1]) / na + (e[2] * e[2] + e[3] * e[3]) / nbn]);
          sc.accBase++;
        }
      }
      sc.stftNext = jHi + 1;
    }
    step(ctx) {
      const nh = ctx.linked ? 1 : HYPOTHESES.length;
      for (let i = 0; i < nh; i++) this.update(i, ctx.buf, ctx.ofdm[i]);
      const scans = this.scans.slice(0, nh);
      const hi = Math.min(...scans.map(s => s.chi.end())) - 1;
      const loOk = Math.max(...scans.map(s => s.chi.base)) + (this.qam ? PP * OSYM : OSYM);
      const lo = Math.max(this.searchNext === null ? loOk : this.searchNext, loOk), out = [];
      if (hi < lo) return out;
      for (let j = lo; j <= hi; j++) {
        let chi = -Infinity, fh = 0;
        scans.forEach((sc, k) => { const v = sc.chi.at(j); if (v > chi) { chi = v; fh = HYPOTHESES[k]; } });
        const r = this.hold.offer(j, chi >= CHI_MIN ? [chi, fh] : null);
        if (r) out.push({record: this.record, t: r[0] * OHOP, hint: {ofdm: r[2]}});
      }
      this.searchNext = hi + 1;
      return out;
    }
    cells(buf, t, df) {
      const seg = buf.get(t, t + this.span);
      if (df !== 0) { const r = rot(t, seg.length, df); for (let i = 0; i < seg.length; i++) seg[i] = cmul(seg[i], r[i]); }
      const out = [], re = new Float64Array(ONF), im = new Float64Array(ONF);
      for (let r = 0; r * SYMLEN < seg.length; r++) {
        for (let i = 0; i < ONF; i++) { const z = seg[r * SYMLEN + i]; re[i] = z[0]; im[i] = z[1]; }
        fft(re, im, -1);
        const row = new Array(this.nb), ph = this.phasors[r];
        for (let b = 0; b < this.nb; b++) row[b] = cmul([re[this.fb + b], im[this.fb + b]], ph[b]);
        out.push(row);
      }
      return out;
    }
    coherence(c) {
      let sr = 0, si = 0;
      for (const m of this.markers) { const u = unit(cmul(cconj(c[m.s - 3][m.b]), c[m.s - 2][m.b])); sr += u[0]; si += u[1]; }
      const s = [sr, si], m = cnorm(s) / this.markers.length;
      if (this.qam) {
        let wr = 0, wi = 0;
        for (const p of this.qamPilots) { const u = unit(cmul(cconj(c[p.s - 2][p.b]), c[p.s + 6][p.b])); wr += u[0]; wi += u[1]; }
        return [m + cnorm([wr, wi]) / this.qamPilots.length, s];
      }
      return [m, s];
    }
    decode(buf, dec, t0, fh, index) {
      const refine = 3;
      if (t0 + this.span + refine > buf.end() || t0 - refine < buf.base) return null;
      const res = [];
      for (let t = t0 - refine; t <= t0 + refine; t++) res.push(this.coherence(this.cells(buf, t, fh)));
      const vals = res.map(r => r[0]), i = peakMid(vals, argmax(vals), 0.02), t = t0 - refine + i;
      const w = 2 * PI * SYMLEN / FS3, f0 = fh + carg(res[i][1]) / w;
      const fit = k => { const df = f0 + k * FS3 / SYMLEN, c = this.cells(buf, t, df), [coh, s] = this.coherence(c); return {coh, df, c, s}; };
      let best = fit(0);
      for (const k of [-1, 1]) { const f = fit(k); if (f.coh > best.coh) best = f; }
      const {coh, df, c, s} = best, cst = constellation(this.l.bps), llr = [];
      let dfTot;
      if (!this.qam) {
        const r = unit(cconj(s)), d = eqDiff(c, this.nsy, this.nb, r);
        const nvar = dpskNvar(d, 0, this.markers.map(m => [m.s - 3, m.b]));
        for (let bi = 0; bi < this.nb; bi++) {
          const obs = [];
          for (let s2 = 3; s2 <= this.spf; s2++) if (!this.map[bi][s2 - 2]) obs.push(d[s2 - 3][bi]);
          softBits(obs, cst, nvar, llr);
        }
        dfTot = df - carg(r) / w;
      } else {
        let vr = 0, vi = 0;
        for (const p of this.qamPilots) { const v = cmul(cconj(c[p.s - 2][p.b]), c[p.s - 2 + PP][p.b]); vr += v[0]; vi += v[1]; }
        const thd = carg([vr, vi]) / PP;
        derotate(c, thd);
        dfTot = df + thd / w;
        const e = new Eq();
        for (let bi = 0; bi < this.nb; bi++) {
          const b = this.fb + bi, ps = [], ds = [];
          for (let s2 = 2; s2 <= this.spf; s2++) {
            if (qamPilot(b, s2)) ps.push(s2);
            else if (!this.map[bi][s2 - 2]) ds.push(s2);
          }
          const hp = ps.map(s2 => c[s2 - 2][bi]);
          for (const s2 of ds) e.push(c[s2 - 2][bi], s2, ps, hp);
        }
        e.llrs(cst, 1e-3, llr);
      }
      const out = dec.decode(this.record, llr);
      const raw = phaseErrorSnr(this.markers.map(m => cmul(cconj(c[m.s - 3][m.b]), c[m.s - 2][m.b])), this.l, OFDM_K_DB);
      return {record: this.record, index, t, tEnd: t + this.span - GUARD, ok: out.ok, bytes: out.bytes, rawSnrDb: raw,
        snrDb: snrNormalise(raw, this.l), snrAvgDb: null, afcRes: dfTot, iterations: out.iterations, metric: coh};
    }
  }

  // ───────────────────────────── HF control-frame detector
  const CHOP = 16, CNS = 128, CROWS = CNS / CHOP, CNFFT = 256, NBLK = CNFFT - 26, HB_HZ = FS3 / CNFFT;
  const MIN_SCORE = 0.15, REF_2500_DB = 13.8, F1E30 = F(1e-30);
  const clampBin = (i, n) => Math.min(n - 1, Math.max(0, i));
  class CtrlStft {
    constructor(keep) { this.win = new Window(CNFFT); this.spec = new Track(keep); this.stftNext = 0; }
    startAt(start) { this.stftNext = divEuclid(start, CHOP); }
    update(buf) {
      const jHi = divEuclid(buf.end() - CNS, CHOP);
      this.stftNext = Math.max(this.stftNext, divEuclid(buf.base + CHOP - 1, CHOP));
      if (jHi < this.stftNext) return;
      const rows = [];
      for (let j = this.stftNext; j <= jHi; j++) {
        const w = this.win.at(buf, j * CHOP, CNS);
        const power = new Float32Array(CNFFT), sum = new Float32Array(NBLK), max = new Float32Array(NBLK);
        for (let k = 0; k < CNFFT; k++) power[k] = w.re[k] * w.re[k] + w.im[k] * w.im[k];
        for (let h = 0; h < NBLK; h++) {
          let su = 0, mx = -Infinity;
          for (let i = 0; i < COMB; i++) { const v = power[h + 2 * i]; su = F(su + v); mx = Math.max(mx, v); }
          sum[h] = su; max[h] = mx;
        }
        rows.push({power, combSum: sum, combMax: max});
      }
      this.spec.append(this.stftNext, rows);
      this.stftNext = jHi + 1;
    }
  }
  function ctrlScore(spec, tb, j, offset, e) {
    let q = 0, hits = 0, en = 0;
    for (let k = 0; k < tb.symbols; k++) {
      const row = spec.at(j - CROWS * (tb.symbols - 1 - k));
      for (let i = 0; i < tb.tones; i++) {
        const ht = clampBin(2 * e.tones[k][i] + offset, CNFFT), hb = clampBin(2 * e.blocks[k][i] + offset, NBLK);
        const v = row.power[ht];
        q += F(v / F(row.combSum[hb] + F1E30));
        if (v >= row.combMax[hb] && v > 1e-9) hits++;
        en += v;
      }
    }
    return [q / (tb.symbols * tb.tones), hits, en];
  }
  function enoughHits(rows, tb, offset, e) {
    let misses = Math.max(0, tb.symbols * tb.tones - tb.minHits);
    const cf = e.cellsFlat;
    for (let c = 0; c < cf.length; c += 3) {
      const row = rows[cf[c]];
      let ti = cf[c + 1] + offset, bi = cf[c + 2] + offset;
      ti = ti < 0 ? 0 : ti > CNFFT - 1 ? CNFFT - 1 : ti;
      bi = bi < 0 ? 0 : bi > NBLK - 1 ? NBLK - 1 : bi;
      const v = row.power[ti];
      if (!(v >= row.combMax[bi] && v > 1e-9)) {
        if (misses === 0) return false;
        misses--;
      }
    }
    return true;
  }
  class CtrlDetector {
    constructor(bw, entries) {
      this.bw = bw; this.tabs = []; this.stft = new CtrlStft(CROWS * 40);
      this.searchNext = [null, null, null];
      this.holds = FORMATS.map(f => new Hold(2, 4 * (f.nsym - 1)));
      this.setEntries(entries);
    }
    setEntries(entries) {
      const old = this.tabs;
      this.tabs = FORMATS.map((fm, f) => {
        const seen = [], list = [];
        const sorted = entries.filter(e => e.fmt === f).sort((a, b) => a.code - b.code);
        for (const e of sorted) {
          const tones = e.codeword.map(s => s.slice().sort((a, b) => a - b));
          const key = JSON.stringify(tones);
          if (seen.some(x => x[0] === e.code && x[1] === key)) continue;
          seen.push([e.code, key]);
          const comb0 = familyComb(family(e.code, this.bw))[1];
          const blocks = tones.map(s => s.map(k => comb0 + COMB * Math.floor((k - comb0) / COMB)));
          const cells = [];
          tones.forEach((s, k) => s.forEach((_, i) => cells.push([k, 2 * tones[k][i], 2 * blocks[k][i]])));
          list.push({code: e.code, tag: e.tag, tones, blocks, cells, key, cellsFlat: Int32Array.from(cells.flat())});
        }
        return {symbols: fm.nsym - 1, tones: fm.ntones, minHits: fm.minHits, entries: list};
      });
      old.forEach((tb, f) => {
        const nw = this.tabs[f].entries;
        this.holds[f].retain(b => {
          const x = b[2], e = tb.entries[x.entry];
          const i = nw.findIndex(n => n.code === e.code && n.key === e.key);
          if (i < 0) return false;
          x.entry = i;
          return true;
        });
      });
    }
    startAt(start) { this.stft.startAt(start); this.searchNext = [null, null, null]; }
    step(buf, linked) {
      this.stft.update(buf);
      const maxOffset = linked ? 3 : 10, found = [], spec = this.stft.spec;
      for (let f = 0; f < 3; f++) {
        const tb = this.tabs[f];
        if (!tb.entries.length) continue;
        const loOk = spec.base + CROWS * (tb.symbols - 1), hi = spec.end() - 1;
        const lo = Math.max(this.searchNext[f] === null ? loOk : this.searchNext[f], loOk);
        if (hi < lo) continue;
        for (let j = lo; j <= hi; j++) {
          const rows = [];
          for (let k = 0; k < tb.symbols; k++) rows.push(spec.at(j - CROWS * (tb.symbols - 1 - k)));
          let best = null;
          for (let offset = -maxOffset; offset <= maxOffset; offset++) {
            tb.entries.forEach((e, index) => {
              if (!enoughHits(rows, tb, offset, e)) return;
              const [sc, hits] = ctrlScore(spec, tb, j, offset, e);
              if (hits >= tb.minHits && sc >= MIN_SCORE && (!best || sc > best[0])) best = [sc, {offset, entry: index, hits}];
            });
          }
          const r = this.holds[f].offer(j, best && best[0] > 0 ? best : null);
          if (r) found.push([f, r]);
        }
        this.searchNext[f] = hi + 1;
      }
      return found.map(([f, r]) => this.emit(f, r));
    }
    emit(f, r) {
      const [j, , x] = r, tb = this.tabs[f], offset = x.offset, e = tb.entries[x.entry], spec = this.stft.spec;
      const y = [offset - 1, offset, offset + 1].map(trial => ctrlScore(spec, tb, j, trial, e)[2]);
      const den = y[0] - 2 * y[1] + y[2];
      const dlt = den < 0 ? 0.5 * (y[0] - y[2]) / den : 0;
      const df = (offset + Math.min(0.5, Math.max(-0.5, dlt))) * HB_HZ;
      let ratio = 0;
      for (let k = 0; k < tb.symbols; k++) {
        const row = spec.at(j - CROWS * (tb.symbols - 1 - k));
        for (let i = 0; i < tb.tones; i++) {
          const et = row.power[clampBin(2 * e.tones[k][i] + offset, CNFFT)];
          const bs = row.combSum[clampBin(2 * e.blocks[k][i] + offset, NBLK)];
          ratio += et / ((bs - et) / (COMB - 1) + 1e-30);
        }
      }
      ratio /= tb.symbols * tb.tones;
      const snr = 10 * Math.log10(Math.max(ratio, 1e-12)) + 10 * Math.log10(tb.tones) + 10 * Math.log10(0.5) - REF_2500_DB;
      return {code: e.code, fmt: f, hits: x.hits, tag: e.tag, tEnd: j * CHOP + CNS, dfHz: df, snr,
        snrNorm: snr - (SNR_REF_DB - FORMATS[f].kDb)};
    }
  }
  function rxEntries(cb, tag) {
    const out = [];
    for (let fmt = 0; fmt < 3; fmt++) for (let code = 1; code <= NUM_CODES; code++) out.push({code, fmt, tag, codeword: cb.rx(fmt, code)});
    return out;
  }

  // ───────────────────────────── HF receiver
  const BUF_SECONDS = 24, SEARCH_HZ_LINKED = 30, SEARCH_HZ_UNLINKED = 117, RX_GRACE = Math.trunc(0.04 * FS3);
  const CONFIRM_GAP = 8, CONFIRM_GAP_PSK = 48, CONFIRM_LEN = 60, CONFIRM_WINDOWS = 10, FRAME2_LOOKAHEAD = 3 * 32 + 16;
  const to48 = m => m * DEC;
  function makeEngine(bw, record, t) {
    const l = bw.level(record);
    if (l.isFsk) return new FskEngine(bw, record, t.other);
    if (l.wf === "psk") return new PskEngine(bw, record, t.other, pskPhasors());
    return new OfdmEngine(bw, record, t.other, ofdmPhasors());
  }
  const engineTail = e => e instanceof PskEngine ? e.tail : 0;
  function engineDecode(e, buf, dec, t, index, hint) {
    if (e instanceof FskEngine) return e.decode(buf, dec, t, hint && hint.fsk !== undefined ? hint.fsk : 0, index);
    if (e instanceof PskEngine) return e.decode(buf, dec, t, index);
    return e.decode(buf, dec, t, hint && hint.ofdm !== undefined ? hint.ofdm : 0, index);
  }
  class Receiver extends Assembler {
    static idle(bw) { return new Receiver(bw, [], 1, null); }
    constructor(bw, records, nframes, ctrl) {
      super();
      this.bw = bw; this.fe = new FrontEnd(); this.buf = ctrack(BUF_SECONDS * FS3);
      this.afcHz = 0; this.ph = 0; this.linked = false; this.ctrlAfc = true; this.confirmEnd = true;
      this.engines = new Map();
      this.initAsm(nframes);
      this.muted = new Muted();
      this.ctrl = ctrl ? new CtrlDetector(bw, ctrl) : null;
      this.dec = new FrameDecoder(bw);
      this.ofdmStfts = OfdmStft.hypotheses();
      this.stats = {decode: {decodes: 0, crcOk: 0}, tx: 0, unexpectedFrame2: 0};
      this.expect(records, nframes);
    }
    searchHz() { return this.linked ? SEARCH_HZ_LINKED : SEARCH_HZ_UNLINKED; }
    expect(records, nframes) {
      for (const r of records) {
        if (!this.engines.has(r)) {
          const e = makeEngine(this.bw, r, this.dec.tables[r - 1]);
          const back = Math.max(this.buf.end() - e.span - FS3, this.asm.doneUntil - 64 - FS3 / 4);
          e.startAt(Math.max(this.buf.base, back));
          this.engines.set(r, e);
        }
      }
      for (const r of Array.from(this.engines.keys())) if (!records.includes(r)) this.engines.delete(r);
      this.engines = new Map(Array.from(this.engines.entries()).sort((a, b) => a[0] - b[0]));
      if (nframes !== null && nframes !== undefined) this.asm.nframes = nframes;
    }
    baseband() { return this.buf; }
    expected() { return Array.from(this.engines.keys()); }
    setCtrlEntries(entries) {
      if (!entries) this.ctrl = null;
      else if (this.ctrl) this.ctrl.setEntries(entries);
      else { const c = new CtrlDetector(this.bw, entries); c.startAt(Math.max(this.buf.base, this.buf.end() - 40 * 128)); this.ctrl = c; }
    }
    mute(a48, b48) { this.muted.mute(this.buf, FS3, Math.trunc(a48 / DEC), Math.trunc(b48 / DEC)); }
    markTxEnd(n48) { this.asm.txEnd48 = n48; }
    feed(x) { const [m0, b3] = this.fe.process(x); return this.feedBb(m0, b3); }
    // Baseband from a FrontEnd fed with this receiver's input stream (m0: index of b3[0]).
    feedBb(m0, b3) {
      if (m0 < 0) { b3 = b3.slice(Math.min(-m0, b3.length)); m0 = 0; }
      if (b3.length) {
        const w = -2 * PI * this.afcHz / FS3, ph0 = this.ph;
        const v = b3.map((b, n) => cmul(b, polar(1, ph0 + w * n)));
        this.ph = remEuclid(ph0 + w * b3.length, 2 * PI);
        this.buf.append(m0, v);
      }
      let ev = [];
      const linked = this.linked;
      if (this.ctrl) {
        for (const d of this.ctrl.step(this.buf, linked)) {
          if (this.ctrlAfc) this.afcHz += linked ? d.dfHz / 2 : d.dfHz;
          ev.push({kind: "ctrl", det: d, afcHz: this.afcHz});
        }
      }
      const nh = linked ? 1 : HYPOTHESES.length;
      const ofdmEngines = Array.from(this.engines.values()).filter(e => e instanceof OfdmEngine);
      for (let i = 0; i < nh; i++) {
        let r = null;
        for (const e of ofdmEngines) {
          const n = e.rowsNeeded(i, this.buf);
          if (n) r = r ? [Math.min(r[0], n[0]), Math.max(r[1], n[1])] : n;
        }
        if (r) this.ofdmStfts[i].update(this.buf, r[0], r[1]);
      }
      const ctx = {buf: this.buf, linked, searchHz: this.searchHz(), ofdm: this.ofdmStfts};
      let dets = [];
      for (const e of this.engines.values()) dets = dets.concat(e.step(ctx));
      this.ofdmStfts.forEach((st, i) => {
        st.keepFrom(ofdmEngines.length ? Math.min(...ofdmEngines.map(e => e.rowsKept(i))) : null);
      });
      dets.sort((a, b) => a.t - b.t);
      for (const d of dets) ev = ev.concat(this.onDet(d.record, d.t, d.hint));
      return ev.concat(this.pending());
    }
    flush() { return this.finalize(); }
    leadSamples(record) { const l = this.bw.level(record); return l.leadIn * l.symbolPeriod * FS3; }
    maxExtra(record) {
      const e0 = this.engines.get(record), kind = r => this.bw.level(r).wf;
      let ext = 0;
      for (const [r, e] of this.engines) {
        const lead = kind(r) === kind(record) ? this.leadSamples(r) - this.leadSamples(record) : this.leadSamples(r);
        ext = Math.max(ext, Math.trunc(e.span + engineTail(e) + lead - e0.span - engineTail(e0)));
      }
      return ext;
    }
    noiseFloor() { const p = this.muted.quietBlocks(this.buf, FS3, 30); return p ? percentileSorted(p, 5) : 0; }
    continuesAfter(cur, a, b) {
      const e = cur.frames[0].frame.tEnd;
      return continues(this.buf, [a, b], [e - 300, e - 8], this.noiseFloor());
    }
    pending() {
      const cur = this.asm.cur;
      if (!cur) return [];
      this.asm.cur = null;
      const e = this.engines.get(cur.record);
      if (!e) return this.finish(cur);
      const span = e.span, tail = engineTail(e);
      if (cur.wait.confirm) {
        let [a, b] = cur.wait.confirm;
        while (a < b && a + CONFIRM_LEN <= this.buf.end()) {
          if (!this.continuesAfter(cur, a, a + CONFIRM_LEN)) return this.finish(cur);
          a += CONFIRM_LEN;
        }
        if (a < b) { cur.wait.confirm = [a, b]; this.asm.cur = cur; return []; }
        cur.wait.confirm = null;
        cur.two = true;
        cur.wait.deadline = cur.t + 2 * span + tail + RX_GRACE;
        this.stats.unexpectedFrame2++;
      }
      if (this.asm.nframes === 2 || cur.two) {
        const t2 = cur.t + span;
        if (this.buf.end() >= t2 + span + tail + FRAME2_LOOKAHEAD) {
          const r = this.decode(cur.record, t2, 1, cur.wait.hyp);
          if (r && (r.frame.ok || this.asm.nframes === 2)) { this.asm.cur = cur; return this.close(r, true, []); }
          return this.finish(cur);
        }
      }
      if (this.buf.end() >= cur.wait.deadline) return this.finish(cur);
      this.asm.cur = cur;
      return [];
    }
    // Assembler hooks
    track() { return this.buf; }
    has(record) { return this.engines.has(record); }
    span(record) { const e = this.engines.get(record); return e ? e.span : 0; }
    decode(record, t, index, hint) {
      const e = this.engines.get(record);
      if (!e) return null;
      const r = engineDecode(e, this.buf, this.dec, t, index, hint);
      if (!r) return null;
      this.stats.decode.decodes++;
      if (r.ok) this.stats.decode.crcOk++;
      return {frame: r, afcHz: this.afcHz, missing: false};
    }
    pairs(cur) { return cur.frames[0].frame.ok || this.asm.nframes === 2 || cur.two; }
    frame1End(cur) { return cur.wait.t1End; }
    holds(cur, t) { return this.buf.end() < cur.wait.deadline && t < cur.wait.deadline; }
    lost(record, back, t) {
      if (this.asm.txEnd48 === null) return null;
      const te = this.asm.txEnd48 / DEC;
      if (!(back >= te + this.leadSamples(record) - 16)) return null;
      return {frame: {record, index: 0, t: back, tEnd: t, ok: false, bytes: new Uint8Array(0), rawSnrDb: 0, snrDb: 0,
        snrAvgDb: null, afcRes: 0, iterations: 0, metric: 0}, afcHz: this.afcHz, missing: true};
    }
    settled(r) { return r.frame.ok && this.asm.nframes === 1 && !this.confirmEnd; }
    wait(record, r, k) {
      const e = this.engines.get(record), span = e.span, tail = engineTail(e), psk = e instanceof PskEngine;
      const t = r.frame.t, nframes = this.asm.nframes, body = nframes === 2 ? 2 * span : span;
      const deadline = t + body + tail + RX_GRACE + (r.frame.ok ? 0 : this.maxExtra(record));
      let confirm = null;
      if (r.frame.ok && nframes === 1 && this.confirmEnd) {
        const g = psk ? CONFIRM_GAP_PSK : CONFIRM_GAP;
        confirm = [r.frame.tEnd + g, r.frame.tEnd + g + CONFIRM_WINDOWS * CONFIRM_LEN];
      }
      return {t1End: t + span, hyp: k, deadline, confirm};
    }
    expectedFrames() { return this.asm.nframes; }
    finished(frames) {
      const good = frames.filter(f => f.frame.ok).map(f => f.frame.afcRes);
      if (good.length) {
        let s = 0;
        for (const g of good) s += g;
        const res = s / good.length;
        this.afcHz += this.linked ? res / 2 : res;
      }
      this.stats.tx++;
    }
  }
  Receiver.PAIR_TOL = 8; Receiver.EMIT_BAD = true; Receiver.CLOSE_ON_MISS = false; Receiver.LOST_NEEDS_OK = false;

  // ───────────────────────────── call: US call rule (CW ID is mandatory for US calls)
  function isUsCall(call) {
    const base = String(call).split("-")[0], n = base.length, digits = [];
    for (let i = 0; i < n; i++) if (base[i] >= "0" && base[i] <= "9") digits.push(i);
    if (n < 4 || n > 6 || !"NKWA".includes(base[0]) || digits.length !== 1 || digits[0] < 1 || digits[0] > 2) return false;
    if (!/^[A-Za-z0-9]+$/.test(base)) return false;
    if (base[0] === "A" && base[1] >= "M" && base[1] <= "Z") return false;
    const pre = digits[0], suf = n - digits[0] - 1;
    if (pre === 2 && suf === 3) return base[0] === "K" || base[0] === "W";
    if (pre === 2 && suf === 2 && base[0] === "A") return base[1] >= "A" && base[1] <= "L";
    return true;
  }

  // ───────────────────────────── numbers (num.rs)
  const rint = x => { const r = Math.round(x); return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r; };
  const roundAway = x => x < 0 ? -Math.round(-x) : Math.round(x);
  const dec1 = x => roundAway(x * 10) / 10;
  const NO_SNR = F(1e35);

  // ───────────────────────────── busy detector (busy.rs)
  const BUSY_HANG = 34, TONE_PEAK_RATIO = 270, VU_GATE_DBFS = -46, SIGNATURE_POWER_GATE = 1e6, BUSY_ROWS = 20;
  const toneBand = bw => [[54, 74, 4], [21, 107, 14], [16, 112, 17]][bw.id];
  const signatureBand = bw => [[27, 37], [15, 49], [10, 54]][bw.id];
  const signatureThreshold = bw => bw === BW500 ? 3.1 : 2.0;
  const binOf = hz => rint(hz / BIN_HZ);
  function signature(fc) {
    const nc = fc.length, car = [0, 0, 0, 0], gap = [0, 0, 0];
    if (nc % 2 === 0) {
      const h = nc / 2;
      gap[0] = binOf(1500); car[0] = binOf(fc[h - 1]); car[1] = binOf(fc[h]);
      if (nc > 3) {
        car[2] = binOf(fc[h - 2]); car[3] = binOf(fc[h + 1]);
        gap[1] = binOf((fc[h - 2] + fc[h - 1]) * 0.5); gap[2] = binOf((fc[h] + fc[h + 1]) * 0.5);
      }
    } else {
      const c = (nc - 1) / 2;
      gap[0] = binOf((fc[c - 1] + 1500) * 0.5); car[0] = binOf(1500); car[1] = binOf(fc[c - 1]);
      if (nc > 2) { gap[1] = binOf((fc[c + 1] + 1500) * 0.5); car[2] = binOf(fc[c + 1]); }
    }
    return [car, gap];
  }
  function signatures(bw) {
    const out = [];
    for (let record = 1; record <= RECORDS; record++) {
      const l = bw.level(record);
      if (l.wf === "psk" && l.fc.length >= 2) { const [carriers, gaps] = signature(l.fc); out.push({record, carriers, gaps}); }
    }
    return out;
  }
  function detectTone(power, bw) {
    const [lo, hi, rank] = toneBand(bw), v = Float64Array.from(power.slice(lo, hi + 1)).sort();
    return v[v.length - 1] > TONE_PEAK_RATIO * v[rank - 1];
  }
  function detectSignature(power, sig, threshold) {
    const at = (b, sh) => power[b + sh];
    let best = 0, shift = 0;
    for (let sh = -1; sh <= 1; sh++) {
      let tot = 0;
      for (const c of sig.carriers) if (c > 0) tot += at(c, sh);
      if (best <= tot) { best = tot; shift = sh; }
    }
    let maxGap = 0, minCar = Infinity;
    for (const g of sig.gaps) if (g > 0) maxGap = Math.max(maxGap, at(g, shift));
    for (const c of sig.carriers) if (c > 0) minCar = Math.min(minCar, at(c, shift));
    return maxGap > 0 && minCar / maxGap > threshold;
  }
  class Busy {
    constructor(bw) {
      this.bw = bw; this.sigs = signatures(bw); this.fe = null;
      this.br = new Float64Array(128); this.bi = new Float64Array(128); this.bn = 0;
      this.lr = new Float64Array(64); this.li = new Float64Array(64); this.lp = 0; this.ln = 0; this.since = 0;
      this.rows = []; this.peak = 0; this.vu = -200; this.hang = 0; this.on = false; this.hits = [0, 0];
      this.wr = new Float64Array(64); this.wi = new Float64Array(64);
    }
    isOn() { return this.on; }
    setBw(bw) { if (bw !== this.bw) { this.bw = bw; this.sigs = signatures(bw); } }
    feed(x, forced) { if (!this.fe) this.fe = new FrontEnd(); return this.feedBb(x, this.fe.process(x)[1], forced); }
    // x: the 48 kHz block (for the peak meter); bb: its 3 kHz baseband from a FrontEnd.
    feedBb(x, bb, forced) {
      const edges = [];
      if (forced) { this.hang = BUSY_HANG; this.set(true, edges); }
      for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > this.peak) this.peak = a; }
      for (const z of bb) {
        const zr = z[0] * 32767, zi = z[1] * 32767;
        this.lr[this.lp] = zr; this.li[this.lp] = zi; this.lp = (this.lp + 1) & 63;
        if (this.ln < 64) this.ln++;
        if (++this.since === 32) {
          this.since = 0;
          if (this.ln === 64 && this.signatureHit() && !forced) { this.hits[1]++; this.hang = BUSY_HANG; this.set(true, edges); }
        }
        this.br[this.bn] = zr; this.bi[this.bn] = zi;
        if (++this.bn === 128) {
          const hit = this.toneHit();
          this.bn = 0;
          if (forced) continue;
          if (this.hang > 0 && --this.hang === 0) this.set(false, edges);
          if (hit) { this.hits[0]++; this.hang = BUSY_HANG; this.set(true, edges); }
        }
      }
      return edges;
    }
    set(on, edges) { if (this.on !== on) { this.on = on; edges.push(on); } }
    toneHit() {
      const peakDb = 20 * Math.log10(Math.max(this.peak, 1e-12));
      this.vu = Math.max(peakDb, this.vu - 1);
      this.peak = 0;
      if (this.vu <= VU_GATE_DBFS) return false;
      fft(this.br, this.bi, -1);
      const p = new Float64Array(128);
      for (let k = 0; k < 128; k++) p[k] = this.br[k] * this.br[k] + this.bi[k] * this.bi[k];
      return detectTone(p, this.bw);
    }
    signatureHit() {
      const re = this.wr, im = this.wi;
      for (let i = 0; i < 64; i++) { re[i] = this.lr[(this.lp + i) & 63]; im[i] = this.li[(this.lp + i) & 63]; }
      fft(re, im, -1);
      const row = new Float64Array(64);
      for (let k = 0; k < 64; k++) row[k] = re[k] * re[k] + im[k] * im[k];
      const [lo, hi] = signatureBand(this.bw);
      let mean = 0;
      for (let k = lo; k <= hi; k++) mean += row[k];
      mean /= hi - lo + 1;
      if (this.rows.length === BUSY_ROWS) this.rows.shift();
      this.rows.push(row);
      if (mean < SIGNATURE_POWER_GATE || this.rows.length < BUSY_ROWS) return false;
      const s = new Float64Array(64);
      for (const r of this.rows) for (let k = 0; k < 64; k++) s[k] += r[k];
      const thr = signatureThreshold(this.bw);
      return this.sigs.some(g => detectSignature(s, g, thr));
    }
  }

  // ───────────────────────────── ARQ basics (xara-arq: time, rng, bits)
  const SECOND = 48000, IDLE_POLL = 10 * SECOND, IDLE_POLL_LIMIT = 7, DISC_TIMEOUT_LIMIT = 3;
  const M64 = (1n << 64n) - 1n;
  class XorShift {
    constructor(seed) { this.s = (BigInt(seed) & M64) | 1n; }
    nextU64() {
      let s = this.s;
      s ^= (s << 13n) & M64; s ^= s >> 7n; s ^= (s << 17n) & M64;
      return (this.s = s);
    }
    upto(n) { return Number(this.nextU64() % BigInt(n + 1)); }
    below(n) { return Number((this.nextU64() >> 11n) % BigInt(Math.max(1, n))); }
    uniform() { return Number(this.nextU64() >> 11n) / 9007199254740992; }
  }
  // Byte queue (VecDeque<u8>) with a contiguous view.
  class ByteQ {
    constructor() { this.a = new Uint8Array(256); this.h = 0; this.t = 0; }
    get length() { return this.t - this.h; }
    view() { return this.a.subarray(this.h, this.t); }
    push(d) {
      const n = d.length, len = this.t - this.h;
      if (this.t + n > this.a.length) {
        if (len + n <= this.a.length >> 1) this.a.copyWithin(0, this.h, this.t);
        else { const b = new Uint8Array(2 * (len + n)); b.set(this.a.subarray(this.h, this.t)); this.a = b; }
        this.h = 0; this.t = len;
      }
      this.a.set(d, this.t); this.t += n;
    }
    shift(n) { this.h += Math.min(n, this.t - this.h); if (this.h === this.t) this.h = this.t = 0; }
    remove(at, n) { this.a.copyWithin(this.h + at, this.h + at + n, this.t); this.t -= n; }
    clear() { this.h = this.t = 0; }
    take() { const v = this.view().slice(); this.clear(); return v; }
  }
  const bitsOf = s => Array.from(s, c => c === "1" ? 1 : 0);
  function packBits(b) {
    const out = new Uint8Array(Math.ceil(b.length / 8));
    for (let i = 0; i < b.length; i++) if (b[i]) out[i >> 3] |= 0x80 >> (i & 7);
    return out;
  }
  function unpackBits(bytes) {
    const out = new Array(bytes.length * 8);
    for (let i = 0; i < out.length; i++) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
    return out;
  }
  const hexBytes = s => { const o = new Uint8Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(2 * i, 2), 16); return o; };
  const bytesEq = (a, s) => { if (a.length !== s.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== s.charCodeAt(i)) return false; return true; };
  function startsWith(d, pos, p) {
    if (d.length - pos < p.length) return false;
    for (let i = 0; i < p.length; i++) if (d[pos + i] !== p[i]) return false;
    return true;
  }

  // ───────────────────────────── VARA text compression (textcomp.rs, textcomp.dict)
  const TEXTCOMP_DICT = "S 1 000 10101101 2\nE 3b574c324b2d526164696f2f496e7465726e65745f4e6574776f726b0d 101010 0\nE 5b524d5320457870726573732d 010 5\nE 524d53205472696d6f646520 0010 5\nE 5b524d532052656c61792d 100010 5\nE 434d532076696120 1101 8\nE 7b534649203d20 0011 4\nE 5b574c324b2d 1110 5\nE 464320454d20 10010 6\nE 3b46573a20 000 8\nE 3b50513a20 1011 7\nE 3b50523a20 1100 7\nE 3b504d3a20 10100 8\nE 3b46523a0d 1000111 0\nE 5b4250512d 1010111 5\nE 2a2a2a20 1000110 8\nE 46460d 1111 0\nE 463e20 10011 6\nE 646520 10101100 8\nE 3b20 011 8\nE 0a 10000 0\nS 2 001 1011101100 3\nE 666f7277617264656420746f2074686520726563697069656e742076696120484620726164696f 111010011 0\nE 206d696e757465732072656d61696e696e67207769746820 01010001 8\nE 207468726f7567682074686520496e7465726e657420 110111000 0\nE 20436f6e6e656374656420746f20434d530d 101101101 1\nE 57656c636f6d6520746f2074686520 10000110 0\nE 20524d53205472696d6f6465 01010010 0\nE 20524d532052656c6179 101101111 0\nE 202f2f574c324b20 1011110010 0\nE 2068617320 01010011 0\nE 2056415241 101101001 0\nE 203e0d 010100000 1\nE 2620 1110100000 0\nE 20 011 0\nE 69 0001 0\nE 72 0010 0\nE 61 0100 0\nE 65 1001 0\nE 75 00000 0\nE 63 01011 0\nE 6c 10001 0\nE 73 10100 0\nE 6e 11100 0\nE 74 11110 0\nE 6f 11111 0\nE 66 000010 0\nE 62 001100 0\nE 0d 001101 1\nE 2c 001110 0\nE 40 001111 0\nE 2e 010101 0\nE 67 100000 0\nE 6d 101011 0\nE 68 101100 0\nE 70 110101 0\nE 64 111011 0\nE 76 0000110 0\nE 2d 0000111 0\nE 6b 1000010 0\nE 77 1010100 0\nE 79 1110101 0\nE 49 10101010 0\nE 52 10101011 0\nE 42 10110101 0\nE 5a 10111000 0\nE 4f 10111001 0\nE 4a 10111010 0\nE 32 10111101 0\nE 35 10111110 0\nE 36 10111111 0\nE 47 11000000 0\nE 44 11000001 0\nE 37 11000010 0\nE 38 11000011 0\nE 4d 11000100 0\nE 4c 11000101 0\nE 45 11000110 0\nE 50 11000111 0\nE 33 11001000 0\nE 59 11001001 0\nE 54 11001010 0\nE 57 11001011 0\nE 51 11001100 0\nE 34 11001101 0\nE 53 11001110 0\nE 31 11001111 0\nE 46 11010000 0\nE 55 11010001 0\nE 39 11010010 0\nE 4e 11010011 0\nE 43 11011000 0\nE 4b 11011001 0\nE 41 11011010 0\nE 48 11011011 0\nE 30 11011101 0\nE 56 11011110 0\nE 58 11011111 0\nE 3a 010100001 0\nE 2a 110111001 0\nE 3c 1000011100 0\nE 3d 1000011101 0\nE 23 1000011110 0\nE 24 1000011111 0\nE 5b 1011010000 0\nE 5c 1011010001 0\nE 5d 1011011000 0\nE 5f 1011011001 0\nE 21 1011011100 0\nE 22 1011011101 0\nE 3b 1011101101 0\nE 3e 1011101110 0\nE 3f 1011101111 0\nE 28 1011110000 0\nE 29 1011110001 0\nE 2f 1011110011 0\nE 27 1110100001 0\nE 6a 1110100010 0\nE 71 1110100011 0\nE 78 1110100100 0\nE 7a 1110100101 0\nS 3 010 - 0\nE 00 00000000 0\nE 01 00000001 0\nE 02 00000010 0\nE 03 00000011 0\nE 04 00000100 0\nE 05 00000101 0\nE 06 00000110 0\nE 07 00000111 0\nE 08 00001000 0\nE 09 00001001 0\nE 0a 00001010 0\nE 0b 00001011 0\nE 0c 00001100 0\nE 0d 00001101 1\nE 0e 00001110 0\nE 0f 00001111 0\nE 10 00010000 0\nE 11 00010001 0\nE 12 00010010 0\nE 13 00010011 0\nE 14 00010100 0\nE 15 00010101 0\nE 16 00010110 0\nE 17 00010111 0\nE 18 00011000 0\nE 19 00011001 0\nE 1a 00011010 0\nE 1b 00011011 0\nE 1c 00011100 0\nE 1d 00011101 0\nE 1e 00011110 0\nE 1f 00011111 0\nE 20 00100000 2\nE 21 00100001 2\nE 22 00100010 2\nE 23 00100011 2\nE 24 00100100 2\nE 25 00100101 0\nE 26 00100110 0\nE 27 00100111 2\nE 28 00101000 2\nE 29 00101001 2\nE 2a 00101010 2\nE 2b 00101011 0\nE 2c 00101100 2\nE 2d 00101101 2\nE 2e 00101110 2\nE 2f 00101111 2\nE 30 00110000 2\nE 31 00110001 2\nE 32 00110010 2\nE 33 00110011 2\nE 34 00110100 2\nE 35 00110101 2\nE 36 00110110 2\nE 37 00110111 2\nE 38 00111000 2\nE 39 00111001 2\nE 3a 00111010 2\nE 3b 00111011 2\nE 3c 00111100 2\nE 3d 00111101 2\nE 3e 00111110 2\nE 3f 00111111 2\nE 40 01000000 2\nE 41 01000001 2\nE 42 01000010 2\nE 43 01000011 2\nE 44 01000100 2\nE 45 01000101 2\nE 46 01000110 2\nE 47 01000111 2\nE 48 01001000 2\nE 49 01001001 2\nE 4a 01001010 2\nE 4b 01001011 2\nE 4c 01001100 2\nE 4d 01001101 2\nE 4e 01001110 2\nE 4f 01001111 2\nE 50 01010000 2\nE 51 01010001 2\nE 52 01010010 2\nE 53 01010011 2\nE 54 01010100 2\nE 55 01010101 2\nE 56 01010110 2\nE 57 01010111 2\nE 58 01011000 2\nE 59 01011001 2\nE 5a 01011010 2\nE 5b 01011011 2\nE 5c 01011100 2\nE 5d 01011101 2\nE 5e 01011110 0\nE 5f 01011111 2\nE 60 01100000 0\nE 61 01100001 2\nE 62 01100010 2\nE 63 01100011 2\nE 64 01100100 2\nE 65 01100101 2\nE 66 01100110 2\nE 67 01100111 2\nE 68 01101000 2\nE 69 01101001 2\nE 6a 01101010 2\nE 6b 01101011 2\nE 6c 01101100 2\nE 6d 01101101 2\nE 6e 01101110 2\nE 6f 01101111 2\nE 70 01110000 2\nE 71 01110001 2\nE 72 01110010 2\nE 73 01110011 2\nE 74 01110100 2\nE 75 01110101 2\nE 76 01110110 2\nE 77 01110111 2\nE 78 01111000 2\nE 79 01111001 2\nE 7a 01111010 2\nE 7b 01111011 0\nE 7c 01111100 0\nE 7d 01111101 0\nE 7e 01111110 0\nE 7f 01111111 0\nE 80 10000000 0\nE 81 10000001 0\nE 82 10000010 0\nE 83 10000011 0\nE 84 10000100 0\nE 85 10000101 0\nE 86 10000110 0\nE 87 10000111 0\nE 88 10001000 0\nE 89 10001001 0\nE 8a 10001010 0\nE 8b 10001011 0\nE 8c 10001100 0\nE 8d 10001101 0\nE 8e 10001110 0\nE 8f 10001111 0\nE 90 10010000 0\nE 91 10010001 0\nE 92 10010010 0\nE 93 10010011 0\nE 94 10010100 0\nE 95 10010101 0\nE 96 10010110 0\nE 97 10010111 0\nE 98 10011000 0\nE 99 10011001 0\nE 9a 10011010 0\nE 9b 10011011 0\nE 9c 10011100 0\nE 9d 10011101 0\nE 9e 10011110 0\nE 9f 10011111 0\nE a0 10100000 0\nE a1 10100001 0\nE a2 10100010 0\nE a3 10100011 0\nE a4 10100100 0\nE a5 10100101 0\nE a6 10100110 0\nE a7 10100111 0\nE a8 10101000 0\nE a9 10101001 0\nE aa 10101010 0\nE ab 10101011 0\nE ac 10101100 0\nE ad 10101101 0\nE ae 10101110 0\nE af 10101111 0\nE b0 10110000 0\nE b1 10110001 0\nE b2 10110010 0\nE b3 10110011 0\nE b4 10110100 0\nE b5 10110101 0\nE b6 10110110 0\nE b7 10110111 0\nE b8 10111000 0\nE b9 10111001 0\nE ba 10111010 0\nE bb 10111011 0\nE bc 10111100 0\nE bd 10111101 0\nE be 10111110 0\nE bf 10111111 0\nE c0 11000000 0\nE c1 11000001 0\nE c2 11000010 0\nE c3 11000011 0\nE c4 11000100 0\nE c5 11000101 0\nE c6 11000110 0\nE c7 11000111 0\nE c8 11001000 0\nE c9 11001001 0\nE ca 11001010 0\nE cb 11001011 0\nE cc 11001100 0\nE cd 11001101 0\nE ce 11001110 0\nE cf 11001111 0\nE d0 11010000 0\nE d1 11010001 0\nE d2 11010010 0\nE d3 11010011 0\nE d4 11010100 0\nE d5 11010101 0\nE d6 11010110 0\nE d7 11010111 0\nE d8 11011000 0\nE d9 11011001 0\nE da 11011010 0\nE db 11011011 0\nE dc 11011100 0\nE dd 11011101 0\nE de 11011110 0\nE df 11011111 0\nE e0 11100000 0\nE e1 11100001 0\nE e2 11100010 0\nE e3 11100011 0\nE e4 11100100 0\nE e5 11100101 0\nE e6 11100110 0\nE e7 11100111 0\nE e8 11101000 0\nE e9 11101001 0\nE ea 11101010 0\nE eb 11101011 0\nE ec 11101100 0\nE ed 11101101 0\nE ee 11101110 0\nE ef 11101111 0\nE f0 11110000 0\nE f1 11110001 0\nE f2 11110010 0\nE f3 11110011 0\nE f4 11110100 0\nE f5 11110101 0\nE f6 11110110 0\nE f7 11110111 0\nE f8 11111000 0\nE f9 11111001 0\nE fa 11111010 0\nE fb 11111011 0\nE fc 11111100 0\nE fd 11111101 0\nE fe 11111110 0\nE ff 11111111 0\nS 4 011 01000 2\nE 5554437d0d0a 0111 1\nE 204f6e203230 1001 0\nE 30 00 0\nE 2d 101 0\nE 32 0101 0\nE 31 0110 0\nE 3a 1000 0\nE 20 1100 0\nE 35 01001 0\nE 37 11010 0\nE 38 11011 0\nE 36 11100 0\nE 39 11101 0\nE 33 11110 0\nE 34 11111 0\nS 5 100 1011001 8\nE 2d4232465749484a4d245d0d 000 0\nE 2d42324649484a4d245d0d 101110 0\nE 2d4232465749484d245d0d 1011011 0\nE 2d423246484d245d0d 010 0\nE 3b50513a20 0010 7\nE 3b50523a20 0011 7\nE 3b20 1000 8\nE 2e 11 0\nE 31 011 0\nE 0a 1010 0\nE 35 101111 0\nE 0d 1001000 1\nE 37 1001001 0\nE 34 1001010 0\nE 39 1001011 0\nE 30 1001100 0\nE 32 1001101 0\nE 20 1001110 2\nE 33 1001111 0\nE 38 1011000 0\nE 36 1011010 0\nS 6 101 100110 2\nE 20 1010 7\nE 0d 1011 1\nE 45 00000 0\nE 4c 00001 0\nE 51 00010 0\nE 53 00011 0\nE 43 00100 0\nE 47 00101 0\nE 46 00110 0\nE 4e 00111 0\nE 44 01000 0\nE 4a 01001 0\nE 4f 01010 0\nE 41 01011 0\nE 49 01100 0\nE 48 01101 0\nE 42 01110 0\nE 50 01111 0\nE 52 10000 0\nE 4b 10001 0\nE 4d 10010 0\nE 39 100111 0\nE 59 110000 0\nE 56 110001 0\nE 5a 110010 0\nE 54 110011 0\nE 58 110100 0\nE 32 110101 0\nE 57 110110 0\nE 38 110111 0\nE 34 111000 0\nE 31 111001 0\nE 35 111010 0\nE 36 111011 0\nE 33 111100 0\nE 37 111101 0\nE 30 111110 0\nE 55 111111 0\nS 7 110 1110 2\nE 20300d 110 1\nE 31 00 0\nE 20 10 0\nE 0d 011 1\nE 34 01000 0\nE 39 01001 0\nE 36 01010 0\nE 32 010110 0\nE 35 010111 0\nE 37 111100 0\nE 38 111101 0\nE 30 111110 0\nE 33 111111 0\nS 8 111 01100101 2\nE 495330475242 01100100 0\nE 20444520 01001 0\nE 574c324b 10010000 0\nE 203e0d 110010 1\nE 290d 101111 1\nE 2028 110011 0\nE 2d 0111 0\nE 4b 1101 0\nE 4d 00000 0\nE 32 00001 0\nE 36 00010 0\nE 33 00011 0\nE 39 00100 0\nE 35 00101 0\nE 44 00111 0\nE 45 01011 0\nE 37 01101 0\nE 42 10000 0\nE 34 10011 0\nE 57 10100 0\nE 41 10101 0\nE 4e 11101 0\nE 58 001100 0\nE 30 001101 0\nE 53 010000 0\nE 5a 010001 0\nE 50 011000 0\nE 48 100010 0\nE 4f 100011 0\nE 49 100101 0\nE 38 101101 0\nE 4c 101110 0\nE 56 110000 0\nE 4a 110001 0\nE 47 111000 0\nE 43 111001 0\nE 31 111100 0\nE 46 111101 0\nE 54 111110 0\nE 52 111111 0\nE 20 0110011 6\nE 55 1001001 0\nE 59 1011000 0\nE 51 1011001 0\nE 0d 10010001 1\nE 0d 01010 1\n";
  const TC_START = 1, TC_MAX_PHRASE = 39, TC_TRIAL_BYTES = 150, TC_MAX_CODE = 10;
  let TC = null;
  const tcKey = code => { let v = 1; for (const b of code) v = (v << 1) | b; return v; };
  function tcTables() {
    if (TC) return TC;
    const raw = Array.from({length: 8}, () => ({start: [], entries: [], escape: null}));
    let cur = 0;
    for (const line of TEXTCOMP_DICT.split("\n")) {
      if (!line) continue;
      const f = line.split(" ");
      if (f[0] === "S") {
        cur = +f[1] - 1;
        raw[cur].start = bitsOf(f[2]);
        raw[cur].escape = f[3] !== "-" ? [bitsOf(f[3]), +f[4]] : null;
      } else raw[cur].entries.push({phrase: f[1] === "-" ? new Uint8Array(0) : hexBytes(f[1]), code: bitsOf(f[2]), next: +f[3]});
    }
    TC = raw.map(r => {
      let miss;
      if (r.escape) miss = {esc: r.escape[0], next: r.escape[1]};
      else {
        const by = new Int32Array(256);
        for (let b = 0; b < 256; b++) by[b] = r.entries.findIndex(e => e.phrase.length === 1 && e.phrase[0] === b);
        miss = {by};
      }
      const decode = new Map();
      r.entries.forEach((e, i) => { const k = tcKey(e.code); if (!decode.has(k)) decode.set(k, {entry: i}); });
      if (miss.esc) { const k = tcKey(miss.esc); if (!decode.has(k)) decode.set(k, {escape: miss.next}); }
      return {start: r.start, entries: r.entries, miss, decode};
    });
    return TC;
  }
  function tcPad(b) {
    const p = b.length ? 1 - b[b.length - 1] : 0, n = b.length % 8 === 0 ? 8 : 8 - b.length % 8;
    for (let i = 0; i < n; i++) b.push(p);
  }
  function tcCompress(data, cap, state) {
    const t = tcTables();
    if (!(state >= 1 && state <= t.length)) state = TC_START;
    const out = t[state - 1].start.slice();
    let consumed = 0, pos = 0, last = null;
    while (pos < data.length) {
      const st = t[state - 1];
      let code, m, next;
      const e = st.entries.find(e => e.phrase.length && startsWith(data, pos, e.phrase));
      if (e) { code = e.code; m = e.phrase.length; next = e.next; }
      else if (st.miss.esc) { code = st.miss.esc; m = 0; next = st.miss.next; }
      else { const b = st.entries[st.miss.by[data[pos]]]; code = b.code; m = 1; next = b.next; }
      const full = out.length + code.length > cap * 8;
      if (!full) { consumed += m; for (const b of code) out.push(b); last = [code.length, m, state]; }
      if (next !== 0) state = next;
      if (full) break;
      pos += m;
    }
    tcPad(out);
    if (out.length > cap * 8 && last) {
      out.length -= 8 + last[0];
      consumed -= last[1];
      state = last[2];
      tcPad(out);
    }
    return {bytes: packBits(out), consumed, endState: state};
  }
  function tcDecompress(payload) {
    const t = tcTables(), b = unpackBits(payload);
    if (!b.length) return null;
    const p = b[b.length - 1];
    while (b.length && b[b.length - 1] === p) b.pop();
    if (b.length < 3) return null;
    let state = (b[0] << 2 | b[1] << 1 | b[2]) + 1, i = 3;
    const out = [];
    while (i < b.length) {
      const st = t[state - 1];
      let hit = null, len = 0, v = 1;
      for (let l = 1; l <= Math.min(TC_MAX_CODE, b.length - i); l++) {
        v = (v << 1) | b[i + l - 1];
        const h = st.decode.get(v);
        if (h) { hit = h; len = l; break; }
      }
      if (!hit) return null;
      i += len;
      if (hit.entry !== undefined) {
        const e = st.entries[hit.entry];
        for (const x of e.phrase) out.push(x);
        if (e.next !== 0) state = e.next;
      } else state = hit.escape;
    }
    return [Uint8Array.from(out), state];
  }
  function turnCompresses(q) {
    const n = Math.min(q.length, TC_TRIAL_BYTES), c = tcCompress(q.subarray(0, n), n, TC_START);
    return c.bytes.length < c.consumed;
  }
  const inputWindow = room => 3 * room + TC_MAX_PHRASE;
  const fillFrame = (q, room, state) => tcCompress(q.subarray(0, Math.min(q.length, inputWindow(room))), room, state);
  function fitsFrames(q, frames, room, lastRoom, state) {
    const n = q.length;
    if (n <= (frames - 1) * room + lastRoom) return true;
    if (frames === 1) return n <= inputWindow(room) && tcCompress(q, lastRoom, state).consumed === n;
    if (n > inputWindow(2 * room)) return false;
    const c = tcCompress(q, room, state), r = n - c.consumed;
    return r === 0 || tcCompress(q.subarray(c.consumed), Math.min(r, lastRoom), c.endState).consumed === r;
  }

  // ───────────────────────────── FILES compression (compression.rs). Received chunks are inflated;
  // sent chunks go out stored (flag bit clear), which every peer accepts.
  const COMP = {OFF: 0, TEXT: 1, FILES: 2};
  const compFromBits = b => b === 1 ? COMP.TEXT : b === 2 ? COMP.FILES : COMP.OFF;
  const FILES_PAUSE = SECOND * 3 / 20, FILES_CHUNK = 32500, MAX_INFLATED = 50000;
  function filesChunk(data) {
    const out = new Uint8Array(data.length + 2);
    out[0] = data.length >> 8; out[1] = data.length & 255; out.set(data, 2);
    return out;
  }
  function chunkQueue(buf) {
    if (!buf.length) return;
    const raw = buf.take();
    for (let i = 0; i < raw.length; i += FILES_CHUNK) buf.push(filesChunk(raw.subarray(i, i + FILES_CHUNK)));
  }
  class FilesStager {
    constructor() { this.clear(); }
    get length() { return this.stage.length; }
    deadline() { return this.flushAt; }
    due(now) { return this.flushAt !== null && now >= this.flushAt; }
    clear() { this.stage = new ByteQ(); this.flushAt = null; }
    push(now, data, out) {
      this.stage.push(data);
      this.flushAt = now + FILES_PAUSE;
      while (this.stage.length >= FILES_CHUNK) {
        out.push(filesChunk(this.stage.view().subarray(0, FILES_CHUNK)));
        this.stage.shift(FILES_CHUNK);
      }
    }
    flush(out) { this.flushAt = null; if (this.stage.length) out.push(filesChunk(this.stage.take())); }
  }
  // Raw DEFLATE decoder (RFC 1951); null on a bad stream or more than `limit` bytes out.
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097,
    6145, 8193, 12289, 16385, 24577];
  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  function huff(lens) {
    const counts = new Uint16Array(16), offs = new Uint16Array(16), syms = new Uint16Array(lens.length);
    for (const l of lens) counts[l]++;
    counts[0] = 0;
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
    for (let i = 0; i < lens.length; i++) if (lens[i]) syms[offs[lens[i]]++] = i;
    return {counts, syms};
  }
  function inflateRaw(src, limit) {
    let pos = 0, bb = 0, nb = 0;
    const out = [];
    const get = n => {
      while (nb < n) { if (pos >= src.length) throw 0; bb |= src[pos++] << nb; nb += 8; }
      const v = bb & ((1 << n) - 1);
      bb >>>= n; nb -= n;
      return v;
    };
    const decode = h => {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len < 16; len++) {
        code |= get(1);
        const c = h.counts[len];
        if (code - c < first) return h.syms[index + code - first];
        index += c; first = (first + c) << 1; code <<= 1;
      }
      throw 0;
    };
    try {
      let last;
      do {
        last = get(1);
        const type = get(2);
        if (type === 0) {
          bb = 0; nb = 0;
          if (pos + 4 > src.length) throw 0;
          const len = src[pos] | src[pos + 1] << 8;
          if ((len ^ 0xFFFF) !== (src[pos + 2] | src[pos + 3] << 8)) throw 0;
          pos += 4;
          if (pos + len > src.length) throw 0;
          for (let i = 0; i < len; i++) out.push(src[pos++]);
        } else if (type === 1 || type === 2) {
          let lit, dist;
          if (type === 1) {
            const l = new Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
            lit = huff(l); dist = huff(new Array(30).fill(5));
          } else {
            const hlit = get(5) + 257, hdist = get(5) + 1, hclen = get(4) + 4, cl = new Array(19).fill(0);
            for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = get(3);
            const ch = huff(cl), lens = [];
            while (lens.length < hlit + hdist) {
              const s = decode(ch);
              if (s < 16) lens.push(s);
              else if (s === 16) { if (!lens.length) throw 0; const p = lens[lens.length - 1]; for (let r = 3 + get(2); r--;) lens.push(p); }
              else for (let r = s === 17 ? 3 + get(3) : 11 + get(7); r--;) lens.push(0);
            }
            if (lens.length > hlit + hdist) throw 0;
            lit = huff(lens.slice(0, hlit)); dist = huff(lens.slice(hlit));
          }
          for (;;) {
            const s = decode(lit);
            if (s < 256) out.push(s);
            else if (s === 256) break;
            else {
              const i = s - 257;
              if (i >= 29) throw 0;
              const len = LBASE[i] + get(LEXT[i]), d = decode(dist);
              if (d >= 30) throw 0;
              const dd = DBASE[d] + get(d < 4 ? 0 : (d >> 1) - 1);
              if (dd > out.length) throw 0;
              for (let k = 0; k < len; k++) out.push(out[out.length - dd]);
            }
            if (out.length > limit) throw 0;
          }
        } else throw 0;
        if (out.length > limit) throw 0;
      } while (!last);
      return Uint8Array.from(out);
    } catch (e) {
      if (e !== 0) throw e;
      return null;
    }
  }
  class FilesReader {
    constructor() { this.buf = new ByteQ(); }
    push(data) {
      this.buf.push(data);
      const blocks = [];
      for (;;) {
        const f = this.buf.view();
        if (f.length < 2) return blocks;
        const len = (f[0] & 0x7F) << 8 | f[1];
        if (f.length < 2 + len) return blocks;
        const deflated = (f[0] & 0x80) !== 0, body = f.slice(2, 2 + len);
        this.buf.shift(2 + len);
        const out = deflated ? inflateRaw(body, MAX_INFLATED) || new Uint8Array(0) : body;
        if (out.length) blocks.push(out);
      }
    }
  }

  // ───────────────────────────── link (b2f.rs, link.rs, session.rs)
  class B2fSnoop {
    constructor() { this.fs = false; this.quit = false; }
    observe(b) {
      this.quit = this.quit || bytesEq(b, "FQ\r");
      this.fs = this.fs || (b.length >= 5 && b[0] === 0x46 && b[1] === 0x53 && b[2] === 0x20 && b[b.length - 1] === 13);
    }
    takeQuit() { const q = this.quit; this.quit = false; return q; }
  }
  class Reorder {
    constructor() { this.s = []; }
    put(data, skip) {
      const s = this.s;
      let i = 0, free = 0, k = 0;
      while (k < data.length) {
        if (i === s.length) s.push(null);
        if (s[i] === null) { if (free >= skip) s[i] = data[k++]; free++; }
        i++;
      }
      let n = 0;
      while (n < s.length && s[n] !== null) n++;
      return Uint8Array.from(s.splice(0, n));
    }
    clear() { this.s = []; }
  }
  const fired = (o, k, now) => { const due = o[k] !== null && now >= o[k]; if (due) o[k] = null; return due; };
  class Link {
    constructor() {
      this.rx = {slots: new Reorder(), turnCompressed: null};
      this.comp = COMP.OFF; this.files = new FilesStager(); this.b2f = new B2fSnoop();
      this.deadline = null; this.watchdog = null; this.idleTimer = null; this.idleTicks = 0;
      this.discNow = false; this.discAfterTx = false; this.discTimeouts = 0; this.reader = new FilesReader();
    }
    nextDeadline() {
      let m = null;
      for (const t of [this.deadline, this.watchdog, this.idleTimer, this.files.deadline()]) if (t !== null && (m === null || t < m)) m = t;
      return m;
    }
    watchdogFired(now) { return fired(this, "watchdog", now); }
    deadlineFired(now) { return fired(this, "deadline", now); }
    idleFired(now) { return fired(this, "idleTimer", now) ? ++this.idleTicks : null; }
    text() { return this.comp === COMP.TEXT; }
    queue(now, connected, data, buf) {
      this.b2f.observe(data);
      if (connected && this.comp === COMP.FILES) this.files.push(now, data, buf);
      else buf.push(data);
    }
    startFiles(buf) { if (this.comp === COMP.FILES) chunkQueue(buf); }
    inflate(second, compressed, data) {
      if (this.text() && !second && compressed) { const d = tcDecompress(data); return d ? d[0] : null; }
      return data;
    }
    turnQuit(buf) { this.b2f.fs = false; if (this.b2f.takeQuit()) { this.discAfterTx = true; buf.clear(); } }
    wantsQrt(queued) { return this.discNow || (this.discAfterTx && queued + this.files.length === 0); }
    deliver(data, skip, host) {
      const out = this.rx.slots.put(data, skip);
      if (!out.length) return;
      if (this.comp !== COMP.FILES) host(out);
      else for (const b of this.reader.push(out)) host(b);
    }
  }
  function linkQueueHintBy(l, n, rows, max, fits) {
    for (let k = 1; k <= rows.length; k++) {
      const [down, same, up] = rows[k - 1];
      if (l > 1 && fits(l - 1, k)) return down;
      if (fits(l, k)) return same;
      const u = up.find(([d]) => l + d <= n && fits(l + d, k));
      if (u) return u[1];
    }
    return max;
  }
  class Core {
    constructor(seed) { this.out = []; this.rng = new XorShift(seed); this.transmitting = false; this.txEnd = 0; }
    pop() { return this.out.length ? this.out.shift() : null; }
    host(ev) { this.out.push({kind: "host", ev}); }
    nextDeadline(link) { return this.transmitting ? null : link.nextDeadline(); }
    deliver(link, data, skip) { link.deliver(data, skip, d => this.host({kind: "data", data: d})); }
  }
  const hostSettings = (mycall, retries) => ({mycalls: [mycall], chat: false, registered: false, retries, compression: COMP.TEXT});
  const primaryCall = h => h.mycalls.length ? h.mycalls[0] : "";

  // ───────────────────────────── HF ARQ: adaptation (hf/adapt.rs)
  const DISABLED = -100, SN_NORM_DB = 9.4;
  const recUp = (l, d) => l + d <= RECORDS ? l + d : null;
  const recDown = l => l > 1 ? l - 1 : l;
  const recClamp = (n, top) => Math.min(Math.max(n, 1), top);
  const stepThr = l => dec1(l.thr) - (SN_NORM_DB - dec1(l.papr));
  const skipDown = (bw, lv) => lv > 1 && bw.level(lv).skip ? recDown(lv) : lv;
  const stepDown = (bw, level) => skipDown(bw, recDown(level));
  class SnrTrend {
    constructor() { this.prev = NO_SNR; }
    push(snr) { const out = snr > this.prev ? 0.5 * (this.prev + snr) : snr; this.prev = snr; return out; }
  }
  const QAM = {NONE: -1, LOST_FIRST: 0, RECEIVED: 1};
  class Adaptation {
    constructor(bw) { this.bw = bw; this.reset(); }
    reset() {
      this.margin = 2; this.marginDecay = 0.5 / 15; this.marginPrev = 0;
      this.okRun = 1; this.qam = QAM.NONE; this.last = 1; this.failedClimbs = 0; this.lastGood = 1;
    }
    frameOk(level) {
      this.okRun++;
      if (this.bw.level(level).isQam) this.qam = QAM.RECEIVED;
      this.margin = Math.max(this.margin - this.marginDecay, 1.5);
      this.lastGood = level;
      if (this.last < level) this.failedClimbs = 0;
      this.last = level;
    }
    frameLost(level) {
      if (this.lastGood <= level && level > 1 && this.okRun > 0) {
        if (this.qam === QAM.NONE && this.bw.level(level).isQam) this.qam = QAM.LOST_FIRST;
        this.marginPrev = this.margin;
        this.margin += 1;
        if (this.last < level) this.margin += 4 * this.failedClimbs;
        if (this.okRun < 15) this.margin += 3 * (15 - this.okRun) / 15;
        this.marginDecay = (this.margin - this.marginPrev) / 15;
      }
      this.okRun = 0;
      if (this.last < level) this.failedClimbs++;
      this.last = level;
    }
    margins(snr, level) {
      const top = this.bw.topLevel, lim = qamLimit(this.bw), out = [];
      for (let d = 0; d < 5; d++) {
        const l = recUp(level, d);
        const off = l === null || l > top || (d >= 2 && (this.failedClimbs !== 0 || l > lim)) ||
          (d === 1 && l > lim && this.qam === QAM.LOST_FIRST);
        out.push(off ? DISABLED : snr - stepThr(this.bw.level(l)) - this.margin - Math.max(d - 1, 0));
      }
      return out;
    }
    levelFromSnr(snr, hi, margin) { return this.climb(snr, hi, margin, () => 0); }
    offerLevel(snr, hi) {
      const good = this.lastGood;
      return this.climb(snr, hi, 3, l => Math.min(Math.max(l - good - 1, 0), 3));
    }
    climb(snr, hi, margin, extra) {
      const m = Math.max(this.margin, margin);
      this.margin = Math.max(this.margin, 2);
      let out = 1;
      for (let l = 2; l <= hi; l++) {
        if (snr - stepThr(this.bw.level(l)) <= m + extra(l)) break;
        out = l;
      }
      return out;
    }
  }
  function ackDecision(bw, level, m, hint, complete, max) {
    for (const [s, code, need] of [[4, CODE.ACK_UP4, 6], [3, CODE.ACK_UP3, 5], [2, CODE.ACK_UP2, 4], [1, CODE.ACK_UP1, 3]]) {
      const up = recUp(level, s);
      if (up !== null && complete && up <= max && m[s] > 0 && hint >= need) return {code, level: up, stayReset: false};
    }
    if (!complete) return {code: CODE.ACK_SECOND_ONLY, level: stepDown(bw, level), stayReset: false};
    if (level > 1 && (m[0] < 0 || hint === 0)) return {code: CODE.ACK_DOWN, level: recDown(level), stayReset: false};
    return {code: CODE.ACK_STAY, level, stayReset: hint === 2};
  }
  const ACK_STEP = {[CODE.ACK_STAY]: 0, [CODE.ACK_UP1]: 1, [CODE.ACK_UP2]: 2, [CODE.ACK_UP3]: 3, [CODE.ACK_UP4]: 4, [CODE.ACK_DOWN]: -1};
  const ackStep = code => code in ACK_STEP ? ACK_STEP[code] : null;
  const stepCount = (code, upsteps, level) =>
    upsteps >= 6 ? 3 : upsteps >= 4 ? 2 : code === CODE.NACK_MISSED && level > 1 ? 2 : 1;
  const stepDownN = (bw, level, n) => skipDown(bw, n <= level ? recClamp(level - n, level) : level);

  // ───────────────────────────── HF ARQ: frames (hf/frames.rs)
  const HINT_MAX = 6, UNREGISTERED_MAX_LEVEL = 4;
  const ctrlThr = fmt => FORMATS[fmt].snrDb - (SN_NORM_DB - FORMATS[fmt].kDb);
  function formatForLevel(bw, level) {
    const thr = stepThr(bw.level(level));
    let out = 0;
    for (let f = 0; f < 3; f++) if (ctrlThr(f) <= thr) out = f;
    return out;
  }
  function chooseReplyFormat(snr, missed, rx) {
    const MAX_MISSED = [31, 1, 0], tones = f => FORMATS[f].ntones;
    let out = 0;
    for (let f = 0; f < 3; f++) {
      if (MAX_MISSED[f] < tones(f) / tones(rx) * missed || snr <= F(ctrlThr(f))) break;
      out = f;
    }
    return out;
  }
  class ReplyFormat {
    constructor() { this.prevSnr = NO_SNR; this.prevMissed = 0; }
    update(snrNorm, hits, rx) {
      const norm = F(snrNorm), snr = Math.min(norm, this.prevSnr);
      this.prevSnr = norm;
      const m = Math.max(0, (FORMATS[rx].nsym - 1) * FORMATS[rx].ntones - hits), missed = Math.max(m, this.prevMissed);
      this.prevMissed = m;
      return [snr, chooseReplyFormat(snr, missed, rx)];
    }
  }
  const payloadLen = (bw, level) => bw.level(level).payload;
  const HINT_UP = [[1, 3], [2, 4], [3, 5], [4, 6]];
  const queueHintBy = (bw, level, fits) => {
    const top = bw.topLevel;
    return linkQueueHintBy(level, top, [[0, 2, HINT_UP], [0, 1, HINT_UP]], HINT_MAX,
      (l, k) => l >= 1 && l <= RECORDS && l <= top && fits(l, k));
  };
  const queueHint = (bw, level, queued) => queueHintBy(bw, level, (l, k) => queued < k * payloadLen(bw, l));
  const queueHintText = (bw, level, q, state) =>
    queueHintBy(bw, level, (l, k) => { const p = payloadLen(bw, l); return fitsFrames(q, k, p, p - 1, state); });
  function parseFrame(frame, marker) {
    const at = frame.length - 3;
    if (at < 0) return null;
    const [ctrl, last, full] = ctrlFromByte(frame[at]), end = at - (last ? 1 : 0);
    if (end < 0) return {ctrl, last, full, nextLevel: null, data: null};
    const field = frame.subarray(0, end), nextLevel = last ? frame[end] : null;
    let data = null;
    if (full) data = field.slice();
    else {
      const i = field.lastIndexOf(TERMINATOR);
      if (i >= 0) {
        const after = i + 1 < field.length ? field[i + 1] : null;
        if (after === null || after === marker || after === 0) data = field.slice(0, i);
      }
    }
    return {ctrl, last, full, nextLevel, data};
  }
  const textCap = (max, text) => text ? recDown(max) : max;
  function startLevelCap(bw, c) {
    if (!c.registered) return UNREGISTERED_MAX_LEVEL;
    return c.fs && !c.headerSent ? qamLimit(bw) : textCap(bw.startLevelMax, c.text);
  }
  function hintTableMinimum(bw, level, text) {
    const t = bw === BW500 ? (text ? [6, 6, 5, 3] : [6, 6, 6, 5, 3]) : (text ? [6, 5, 3] : [6, 6, 4, 2]);
    return level - 1 < t.length ? t[level - 1] : 0;
  }

  // ───────────────────────────── HF ARQ: timing (hf/timing.rs)
  const TICK = 64, TICKS_PER_SEC = SECOND / TICK, SYM_TICKS = 32;
  const WATCHDOG_LINKED = 60 * SECOND, WATCHDOG_UNLINKED = 30 * SECOND, DISC_SLACK = 1.25, BREAK_SLACK = 1.5;
  const FQ_WAIT_REPLIES = 9, IDLE_DATA_WAIT = 201, BREAK_BACKOFF_STEP = 1024;
  const DECODE_ALLOW = [
    [168, 135, 154, 142, 150, 150, 199, 204, 204, 212, 230, 236, 259],
    [162, 140, 148, 148, 150, 164, 172, 176, 190, 263, 303, 319, 365, 415, 480, 556],
    [150, 118, 140, 136, 136, 144, 152, 164, 172, 180, 276, 315, 340, 415, 450, 535, 636]];
  const decodeAllowAt = (bw, i) => DECODE_ALLOW[bw.id][i];
  const decodeAllow = (bw, level) => decodeAllowAt(bw, level - 1);
  const codewordTicks = fmt => (FORMATS[fmt].nsym - 1) * SYM_TICKS;
  const leadTicks = (fmt, code) => leadinSymbols(fmt, code, 0) * SYM_TICKS;
  const ctrlTicks = (fmt, code) => codewordTicks(fmt) + leadTicks(fmt, code);
  // rint(0.45 * k) on the exact binary value of 0.45, as VARA computes it.
  const RF_M = 0x1CCCCCCCCCCCCDn, RF_E = 54n;
  function rint045(k) {
    const x = RF_M * BigInt(k), q = x >> RF_E, r = x & ((1n << RF_E) - 1n), half = 1n << (RF_E - 1n);
    return Number(q + (r > half || (r === half && (q & 1n) === 1n) ? 1n : 0n));
  }
  class Timing {
    constructor(bw, chatOrP2p) {
      const n = bw.numLevels;
      this.bw = bw; this.base = 0; this.ctrlDelay = 0; this.ctrlAllowance = 0; this.ctrlN = 0; this.ctrlSum = 0;
      this.ackDelay = new Array(n).fill(0); this.ackWindows = new Array(n).fill(0); this.sum = new Array(n).fill(0);
      this.count = new Array(n).fill(0); this.unset = true;
      this.reset(chatOrP2p);
    }
    reset(chatOrP2p) {
      this.sum.fill(0); this.count.fill(0); this.ackWindows.fill(0);
      this.ctrlN = 0; this.ctrlSum = 0;
      this.base = chatOrP2p ? 850 : 438;
      this.ctrlAllowance = this.base;
      this.unset = true;
    }
    baseAllowance() { return this.base; }
    replyWindow(fmt) { return codewordTicks(fmt) + SYM_TICKS + this.ctrlAllowance; }
    wait(l) {
      const d = this.ackDelay[l], w = d + 400;
      return this.ctrlDelay < d ? w + rint045(d - this.ctrlDelay) : w;
    }
    ctrl(t, calling) {
      if (t < 0) t = 548;
      if (calling) this.ctrlDelay = t;
      else { this.ctrlN++; this.ctrlSum += t; this.ctrlDelay = rint(this.ctrlSum / this.ctrlN); }
      this.ctrlAllowance = this.ctrlDelay + 150;
      if (this.unset) {
        this.unset = false;
        for (let l = 0; l < this.ackDelay.length; l++) {
          if (this.ackWindows[l] === 0) {
            this.ackDelay[l] = decodeAllowAt(this.bw, l) + this.ctrlDelay - 100;
            this.ackWindows[l] = this.wait(l);
          }
        }
      }
    }
    ack(level, t) {
      if (t < 0 || level > this.ackDelay.length) return;
      const i = level - 1;
      this.count[i]++; this.sum[i] += t;
      this.ackDelay[i] = rint(this.sum[i] / this.count[i]);
      for (let l = i + 1; l < this.ackDelay.length; l++) {
        if (this.count[l] !== 0) break;
        this.ackDelay[l] = this.ackDelay[i] + decodeAllowAt(this.bw, l) - decodeAllow(this.bw, level);
      }
      for (let l = 0; l < this.ackWindows.length; l++) this.ackWindows[l] = this.wait(l);
    }
    ackWindow(level) {
      const w = this.ackWindows[level - 1];
      return w !== undefined && w !== 0 ? w : decodeAllow(this.bw, level) + this.ctrlDelay - 100 + 400;
    }
    setBw(bw) {
      if (bw === this.bw) return;
      this.bw = bw;
      const n = bw.numLevels;
      for (const k of ["ackDelay", "ackWindows", "sum", "count"]) {
        const v = this[k];
        v.length = Math.min(v.length, n);
        while (v.length < n) v.push(0);
      }
      for (let l = 0; l < n; l++) {
        if (this.count[l] === 0) this.ackDelay[l] = decodeAllowAt(bw, l) + this.ctrlDelay - 100;
        this.ackWindows[l] = this.wait(l);
      }
    }
  }

  // ───────────────────────────── HF ARQ: turn start (hf/turn.rs)
  const HOLD_EMPTY_MS = 3300, HOLD_QUEUED_MS = 4500;
  const TURN = {PARTIAL: 0, PROMPT: 1, OVERFLOW: 2};
  const HINT_OV = {OFF: 0, MAX: 1, TABLE_MINIMUM: 2};
  // -> [{start: "hold"|"idle"|"data", hint}, held]
  function turnStart(bw, t) {
    const held = t.lastHeld;
    if (t.answererHold && !t.chat) {
      let s;
      if (t.queued === 0) s = t.sinceHeaderMs < HOLD_EMPTY_MS ? {start: "hold"} : {start: "idle"};
      else if (t.sinceHeaderMs < HOLD_QUEUED_MS && t.kind === TURN.PARTIAL) s = {start: "hold"};
      else if (t.kind === TURN.PROMPT) s = {start: "data", hint: HINT_OV.OFF};
      else s = {start: "data", hint: HINT_OV.TABLE_MINIMUM};
      return [s, held];
    }
    if (t.queued === 0) return [{start: "idle"}, held];
    const cap = textCap(bw.startLevelMax, t.text), n = Math.min(t.offered, bw.topLevel);
    if (t.queued <= payloadLen(bw, n) && t.offered > cap && t.queued !== held) return [{start: "hold"}, t.queued];
    return [{start: "data", hint: t.nextTx > cap ? HINT_OV.MAX : HINT_OV.OFF}, held];
  }

  // ───────────────────────────── CQ frames (cq.rs) and the unproto broadcaster (hf/broadcast.rs, CQ only)
  const CALL_ALPHABET = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const CQ_RECORD = 15, CQ_PAYLOAD = 6, UNPROTO_BW = BW500;
  function parseAx25Call(call) {
    const i = call.indexOf("-"), base = i < 0 ? call : call.slice(0, i), ss = i < 0 ? "0" : call.slice(i + 1);
    if (!/^\+?\d+$/.test(ss) || +ss > 15) return null;
    if (base.length < 1 || base.length > 7 || !/^[A-Z0-9]+$/.test(base)) return null;
    return {base, ssid: +ss};
  }
  function cqPayload(call, bw) {
    const c = parseAx25Call(call);
    if (!c) return null;
    let v = 0;
    for (const ch of c.base.padEnd(7, " ")) v = v * 64 + CALL_ALPHABET.indexOf(ch);
    v = v * 64 + ((bw.id + 1) * 16 + c.ssid);
    const out = new Uint8Array(CQ_PAYLOAD);
    for (let i = CQ_PAYLOAD - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
    return out;
  }
  function cqFrame(call, bw) {
    const p = cqPayload(call, bw);
    if (!p) return null;
    const crc = crc16(p);
    return Uint8Array.of(...p, crc >> 8, crc & 255);
  }
  function cqParse(frame) {
    if (frame.length < CQ_PAYLOAD) return null;
    let v = 0;
    for (let i = 0; i < CQ_PAYLOAD; i++) v = v * 256 + frame[i];
    let call = "";
    for (let k = 0; k < 7; k++) { const x = Math.floor(v / 2 ** (42 - 6 * k)) % 64; if (x < CALL_ALPHABET.length) call += CALL_ALPHABET[x]; }
    call = call.replace(/\s+$/, "");
    const x = v % 64;
    if (x & 15) call += "-" + (x & 15);
    const b = BANDWIDTHS.find(b => b.id + 1 === x >> 4);
    return {call, bw: b || null};
  }
  const cqHostLine = c => "CQFRAME " + c.call + " " + (c.bw ? c.bw.hz : "");
  const bcWindow = level => {
    const l = UNPROTO_BW.level(level);
    return Math.trunc((4 * l.leadIn * l.symbolPeriod + l.airtime) * SECOND);
  };
  class Broadcast {
    constructor(seed) {
      this.persistence = 0.3; this.ignoreDcd = false; this.kissRx = false; this.cqRx = false;
      this.cq = null; this.phase = {k: "idle"}; this.out = []; this.lastBusy = null; this.rng = new XorShift(seed);
    }
    pop() { return this.out.length ? this.out.shift() : null; }
    idle() { return this.phase.k === "idle" && this.cq === null; }
    receiving() { return this.phase.k === "rx"; }
    cqFrame(call, bw) {
      const f = this.idle() ? cqFrame(call, bw) : null;
      if (f) this.cq = f;
      return !!f;
    }
    poll(now, ctx) {
      if (ctx.busy) this.lastBusy = now;
      if (this.phase.k === "rx" && now >= this.phase.until) this.endRx();
      if (this.phase.k !== "idle" || !ctx.idle) return;
      if (this.cq) { const f = this.cq; this.cq = null; this.start({code: CODE.CQ, level: CQ_RECORD, frames: [f]}); }
    }
    start(p) { this.phase = {k: "tx"}; this.out.push({kind: "pending"}, {kind: "send", plan: p}); }
    txDone() { if (this.phase.k === "tx") { this.phase = {k: "idle"}; this.out.push({kind: "cancelPending"}); } }
    endRx() { this.phase = {k: "idle"}; this.out.push({kind: "expect", level: null}); }
    onCtrl(code, tEnd) {
      if (this.phase.k !== "idle" || !(code === CODE.CQ && this.cqRx)) return false;
      this.phase = {k: "rx", level: CQ_RECORD, until: tEnd + bcWindow(CQ_RECORD)};
      this.out.push({kind: "expect", level: CQ_RECORD});
      return true;
    }
    onFrame(level, bytes, snr) {
      if (this.phase.k !== "rx" || level !== this.phase.level) return;
      this.out.push({kind: "sn", sn: snr});
      const c = cqParse(bytes);
      if (c) this.out.push({kind: "cq", cq: c});
      this.endRx();
    }
  }
  const unprotoCodebook = () => new Codebook(0, [0, 0, 0, 0, 0], ROLE.CALLER, UNPROTO_BW);
  function unprotoEntries(cb) {
    const out = [];
    for (let fmt = 0; fmt < 3; fmt++) for (const code of CODE.KISS.concat([CODE.CQ])) out.push({code, fmt, tag: 0, codeword: cb.tx(fmt, code)});
    return out;
  }

  // ───────────────────────────── HF ARQ session (hf/session.rs): sans-IO, time in 48 kHz samples
  const HOST_SINCE_RX_CAP = 500, ANSWER_LEVEL_MAX = 4, SNR_REF_INIT_DB = -100, CALL_EXTRA_LEAD = 9, ANSWER_EXTRA_LEAD = 7;
  const QRT_CWID_BLANKS = [9, 12, 10];
  const hfConfig = (bw, mycall) => ({bw, host: hostSettings(mycall, 15), p2p: false, cwid: false, seed: 1, offerLevel: null});
  const cloneCfg = c => Object.assign({}, c, {host: Object.assign({}, c.host, {mycalls: c.host.mycalls.slice()})});
  class TxBuf {
    constructor() { this.buf = new ByteQ(); this.inflight = []; this.resend = null; this.finalSent = false; this.textTurn = null; this.state = 0; this.states = []; }
    drainFront(n) { this.buf.shift(n); }
    acceptAll() {
      const left = [], inf = this.inflight;
      this.inflight = [];
      for (const n of inf) { this.drainFront(n); if (n > 0) left.push(this.buf.length); }
      if (this.states.length) this.state = this.states[this.states.length - 1];
      this.states = [];
      return left;
    }
    firstOnly() {
      this.drainFront(this.inflight.length ? this.inflight[0] : 0);
      if (this.states.length) this.state = this.states[0];
      this.inflight = [];
    }
    secondOnly() {
      if (this.inflight.length === 2) { const [a, b] = this.inflight; this.buf.remove(a, b); this.resend = a; }
      this.inflight = [];
    }
  }
  const fallbackBelow = level => [1, 2, 3].map(d => level - d).filter(l => l >= 1);
  const stayBump = s => s === null ? 0 : s + 1;
  const LINKED_STATES = ["Listen", "Answering", "Calling", "HeaderSent"];
  class Session {
    constructor(cfg) { this.fresh(cfg, null, null); this.announce(); }
    fresh(cfg, core, carry) {
      const bw = cfg.bw;
      this.core = core || new Core(cfg.seed);
      this.carry = carry || {marker: 1, breakDraw: null, rxLevel: 1, offered: 1, replyFmt: 0, ctrlSnrHeld: 0,
        snrRefDb: SNR_REF_INIT_DB, timing: new Timing(bw, cfg.host.chat || cfg.p2p)};
      this.mycall = primaryCall(cfg.host); this.adapt = new Adaptation(bw); this.cfg = cfg; this.bw = bw;
      this.state = "Listen"; this.remote = ""; this.role = ROLE.ANSWERER; this.connected = false;
      this.level = 1; this.prevLevel = 1; this.fallback = []; this.nextTxLevel = 1; this.fmt = 0;
      this.ctrlSnr = new ReplyFormat(); this.alt = false; this.stays = 0; this.upsteps = 0; this.upstepFrom = 1;
      this.trend = new SnrTrend(); this.tx = new TxBuf(); this.lastCode = null; this.attempts = 0; this.reqFmt = null;
      this.dropped = false; this.header = null; this.registered = cfg.host.registered; this.holdFrom = null;
      this.hostKind = TURN.PARTIAL; this.hostSinceRx = []; this.lastHeld = 0; this.offeredByPeer = 1;
      this.hintOverride = HINT_OV.OFF; this.link = new Link();
    }
    pop() { return this.core.pop(); }
    peer() { return this.remote; }
    bandwidth() { return this.bw; }
    twoFrames() { return this.stays !== null && this.stays > 5; }
    nframes() { return this.twoFrames() ? 2 : 1; }
    resetTiming() { this.carry.timing.reset(this.cfg.host.chat || this.cfg.p2p); }
    buffered() { return this.tx.buf.length + this.link.files.length; }
    nextDeadline() { return this.core.nextDeadline(this.link); }
    maxStartLevel() { return this.startCap(true); }
    startCap(headerSent) {
      const c = {registered: this.registered, fs: this.link.b2f.fs, text: this.link.text(), headerSent};
      return Math.min(startLevelCap(this.bw, c), this.bw.topLevel);
    }
    maxLevel() { return this.registered ? this.bw.topLevel : UNREGISTERED_MAX_LEVEL; }
    keys() {
      const mycalls = [0, 0, 0, 0, 0];
      this.cfg.host.mycalls.slice(0, 5).forEach((c, i) => { mycalls[i] = callHash(c); });
      let seed, connect;
      if (this.state === "Listen") { seed = 0; connect = null; }
      else if (this.state === "Calling") { seed = callHash(this.remote); connect = null; }
      else if (this.role === ROLE.CALLER) { seed = callHash(this.remote); connect = callHash(this.mycall); }
      else { seed = callHash(this.mycall); connect = this.remote ? callHash(this.remote) : null; }
      const role = this.state === "Listen" ? ROLE.ANSWERER : this.role;
      return {seed, mycalls, role, connect: connect === null ? null : [connect, role]};
    }
    accepts() {
      const C = CODE, chat = this.cfg.host.chat;
      switch (this.state) {
        case "Listen": return this.requestCodes();
        case "Answering": return [C.QRT, C.ACK_REQ_0, C.ACK_REQ_1, C.QRT_NO_CWID].concat(this.requestCodes());
        case "Calling": return this.bw === BW2750 ? C.connectReplies(BW2300).concat(C.connectReplies(BW2750)) : C.connectReplies(this.bw);
        case "HeaderSent": return [C.NACK, C.QRT, C.QRT_NO_CWID, C.BREAK, C.IDLE];
        case "Receiving": return [C.QRT, C.ACK_REQ_0, C.ACK_REQ_1, C.QRT_NO_CWID, C.BREAK, C.IDLE];
        case "Break": return chat ? [C.QRT, C.ACK_REQ_0, C.ACK_REQ_1, C.GO_AHEAD, C.QRT_NO_CWID, C.BREAK, C.IDLE]
          : [C.QRT, C.ACK_REQ_0, C.ACK_REQ_1, C.GO_AHEAD, C.QRT_NO_CWID, C.IDLE].concat(C.startLevels());
        case "Sending": return [C.ACK_STAY, C.NACK, C.QRT, C.ACK_UP2, C.ACK_DOWN, C.ACK_UP1, C.ACK_UP3, C.ACK_UP4,
          C.ACK_SECOND_ONLY, C.ACK_FIRST_ONLY, C.NACK_MISSED, C.QRT_NO_CWID, C.BREAK, C.IDLE];
        case "IdleSent": return [C.QRT, C.ACK_REQ_0, C.ACK_REQ_1, C.NO_TRAFFIC, C.QRT_NO_CWID, C.BREAK];
        case "Idle": return [C.QRT, C.QRT_NO_CWID, C.BREAK, C.IDLE];
        case "FqWait": return [C.QRT, C.ACK_REQ_0, C.ACK_REQ_1, C.QRT_NO_CWID];
        default: return [];
      }
    }
    ackReq() { return this.alt ? CODE.ACK_REQ_1 : CODE.ACK_REQ_0; }
    requestCodes() {
      const k = Math.min(this.cfg.host.mycalls.length, CODE.ALIASES);
      return this.bw === BW500 ? CODE.connectReqs(BW500, k) : CODE.connectReqs(BW2300, k).concat(CODE.connectReqs(BW2750, k));
    }
    expectedLevels() {
      const v = [this.level, this.prevLevel].concat(this.fallback).filter(l => l <= this.bw.topLevel).sort((a, b) => a - b);
      return v.filter((l, i) => i === 0 || l !== v[i - 1]);
    }
    announce() {
      const receiving = this.state === "Receiving" || this.state === "Answering";
      this.core.out.push({kind: "listen", listen: {bw: this.bw, keys: this.keys(), codes: this.accepts(),
        levels: receiving ? this.expectedLevels() : [], nframes: this.nframes(), linked: !LINKED_STATES.includes(this.state)}});
    }
    enter(s) {
      if (s !== this.state) {
        if (!(this.state === "Calling" && s === "HeaderSent")) this.alt = false;
        if (s === "Sending") { this.tx.textTurn = null; this.tx.state = TC_START; }
        if (s === "Receiving") {
          this.link.rx.turnCompressed = null;
          this.link.rx.slots.clear();
          this.level = this.carry.rxLevel;
          this.prevLevel = this.level;
          this.fallback = [];
        }
        this.state = s; this.stays = 0; this.upsteps = 0; this.reqFmt = null;
      }
      this.announce();
    }
    setState(s) { this.state = s; this.announce(); }
    listen() {
      const core = this.core, carry = this.carry;
      this.fresh(cloneCfg(this.cfg), core, carry);
      this.carry.timing.setBw(this.bw);
      this.carry.timing.reset(this.cfg.host.chat || this.cfg.p2p);
      this.announce();
    }
    sendCtrl(code, fmt, extra) {
      this.fmt = fmt;
      if (code === CODE.IDLE) this.holdFrom = null;
      if (!CODE.ACK_REQ.includes(code)) this.lastCode = code;
      this.link.idleTimer = null;
      this.core.transmitting = true;
      this.link.deadline = null;
      this.core.out.push({kind: "tx", tx: {type: "ctrl", code, fmt, extra}});
    }
    resendLast() { if (this.lastCode !== null) this.sendCtrl(this.lastCode, 0, 0); }
    feedWatchdog(now) {
      this.link.watchdog = now + (this.connected || this.state === "HeaderSent" ? WATCHDOG_LINKED : WATCHDOG_UNLINKED);
    }
    levelSet(n) {
      this.upsteps = n <= this.upstepFrom ? 0 : this.upsteps + n - this.upstepFrom;
      this.upstepFrom = n;
      this.prevLevel = this.level;
      this.level = n;
    }
    qrt() {
      const code = this.cwid() ? CODE.QRT : CODE.QRT_NO_CWID;
      const fmt = this.state === "Receiving" || this.state === "Answering" ? this.fmt : 0;
      this.sendCtrl(code, fmt, 0);
      this.setState("Qrt");
    }
    cwid() { return this.cfg.cwid || isUsCall(this.mycall); }
    close(blanks) {
      if (this.role === ROLE.ANSWERER && !this.connected) {
        this.core.host({kind: "cancelPending"});
        this.listen();
      } else if (this.cwid()) {
        const call = this.mycall.split("-")[0];
        this.link.deadline = null; this.link.watchdog = null; this.link.idleTimer = null;
        this.core.transmitting = true;
        this.core.out.push({kind: "tx", tx: {type: "cwid", call, blanks}});
        this.setState("Closing");
      } else {
        this.core.host({kind: "disconnected"});
        this.listen();
      }
    }
    connect(now, mycall, remote) {
      if (this.state !== "Listen") return;
      this.mycall = mycall === null || mycall === undefined ? primaryCall(this.cfg.host) : mycall;
      this.remote = remote;
      this.role = ROLE.CALLER;
      this.carry.marker = termMarker(this.mycall);
      this.attempts = 0;
      this.setState("Calling");
      this.feedWatchdog(now);
      this.request(now);
    }
    request(now) {
      this.feedWatchdog(now);
      this.attempts++;
      this.sendCtrl(CODE.connectReq(this.bw, 0), 0, this.attempts === 1 ? CALL_EXTRA_LEAD : 0);
    }
    send(now, data) {
      if (this.holdFrom !== null && this.role === ROLE.ANSWERER) {
        const room = payloadLen(this.bw, Math.min(this.nextTxLevel, this.bw.topLevel));
        const keep = Math.min(Math.max(HOST_SINCE_RX_CAP - this.hostSinceRx.length, 0), data.length);
        for (let i = 0; i < keep; i++) this.hostSinceRx.push(data[i]);
        const acc = Uint8Array.from(this.hostSinceRx);
        const n = data.length;
        if (n >= 6 && data[n - 2] === 0x3E && data[n - 1] === 13) this.hostKind = TURN.PROMPT;
        else if (acc.length > room - 1 || (this.link.text() && tcCompress(acc, room - 1, TC_START).consumed < acc.length)) this.hostKind = TURN.OVERFLOW;
        else this.hostKind = TURN.PARTIAL;
      }
      this.link.queue(now, this.connected, data, this.tx.buf);
      if (this.state === "Idle" && !this.core.transmitting && this.link.deadline === null)
        this.link.deadline = Math.max(now, this.core.txEnd + IDLE_DATA_WAIT * TICK);
    }
    disconnect(now) {
      if (this.state === "FqWait") return;
      const linking = this.connected || ["Calling", "Answering", "HeaderSent"].includes(this.state);
      if (linking && this.buffered() > 0) this.link.discAfterTx = true;
      else this.abort(now);
    }
    abort(now) {
      switch (this.state) {
        case "Listen": case "Closing": case "Qrt": return;
        case "Calling": this.attempts = this.cfg.host.retries; return;
        default:
          this.link.discNow = true;
          if (this.state === "Idle" && !this.core.transmitting) this.link.deadline = now;
          else if (this.state === "Receiving" && !this.core.transmitting) this.link.deadline = Math.max(now, this.discWindow());
      }
    }
    discWindow() {
      const l = this.bw.level(this.level), frame = Math.trunc(l.airtime * TICKS_PER_SEC);
      const more = this.twoFrames() ? frame - Math.trunc(l.leadIn * l.symbolPeriod * TICKS_PER_SEC) : 0;
      return this.core.txEnd + (frame + more + Math.trunc(DISC_SLACK * this.carry.timing.baseAllowance())) * TICK;
    }
    dropLink() {
      if (["Listen", "Calling", "Qrt", "Closing"].includes(this.state)) return;
      if (this.core.transmitting) this.dropped = true;
      else this.close(0);
    }
    setBreakDraw(r) { this.carry.breakDraw = r; }
    onTxDone(now) {
      this.core.transmitting = false;
      this.core.txEnd = now;
      if (this.dropped) { this.dropped = false; this.link.deadline = null; this.close(0); return; }
      const draw = this.carry.breakDraw;
      this.carry.breakDraw = null;
      const T = this.carry.timing;
      let w = null;
      switch (this.state) {
        case "Calling": w = T.replyWindow(1); break;
        case "HeaderSent": case "Sending":
          if (this.reqFmt !== null) w = T.replyWindow(0);
          else {
            const f = Math.min(this.fmt, this.carry.replyFmt), code = this.tx.finalSent ? CODE.BREAK : CODE.ACK_STAY;
            w = T.ackWindow(this.level) + leadTicks(f, code) + codewordTicks(f);
          }
          break;
        case "Break": {
          const r = draw === null ? this.core.rng.upto(2) : draw;
          w = Math.trunc(BREAK_SLACK * T.baseAllowance()) + (r + 1) * BREAK_BACKOFF_STEP;
          break;
        }
        case "IdleSent": w = T.replyWindow(0); break;
        case "FqWait": w = FQ_WAIT_REPLIES * T.replyWindow(0); break;
        case "Receiving": if (this.link.discNow) w = Math.trunc((this.discWindow() - now) / TICK); break;
        case "Idle": if (this.link.discNow || this.tx.buf.length) w = IDLE_DATA_WAIT; break;
        case "Qrt": this.close(0); break;
        case "Closing": this.core.host({kind: "disconnected"}); this.listen(); break;
      }
      this.link.deadline = w === null ? null : now + w * TICK;
    }
    poll(now) {
      if (this.core.transmitting) return;
      if (this.link.watchdogFired(now)) {
        if (this.state !== "Answering") this.core.host({kind: "timedOut"});
        this.close(0);
        return;
      }
      if (this.link.files.due(now)) {
        this.link.files.flush(this.tx.buf);
        if (this.state === "Idle" && this.link.deadline === null && this.tx.buf.length)
          this.link.deadline = Math.max(now, this.core.txEnd + IDLE_DATA_WAIT * TICK);
      }
      const ticks = this.link.idleFired(now);
      if (ticks !== null) {
        if (!this.cfg.host.chat && ticks >= IDLE_POLL_LIMIT) this.qrt();
        else { this.sendCtrl(CODE.IDLE, 0, 0); this.enter("IdleSent"); }
        return;
      }
      if (!this.link.deadlineFired(now)) return;
      if (["HeaderSent", "Sending", "Break", "IdleSent"].includes(this.state) && this.link.discNow) {
        if (++this.link.discTimeouts >= DISC_TIMEOUT_LIMIT) { this.qrt(); return; }
      }
      switch (this.state) {
        case "Calling":
          if (this.attempts < this.cfg.host.retries) this.request(now);
          else { this.core.host({kind: "unableToConnect"}); this.close(0); }
          break;
        case "HeaderSent": case "Sending": {
          const f = this.reqFmt !== null ? fmtMoreRobust(this.reqFmt)
            : this.state === "Sending" ? formatForLevel(this.bw, recDown(this.level)) : Math.min(this.fmt, this.carry.replyFmt);
          this.reqFmt = f;
          this.sendCtrl(this.ackReq(), f, 0);
          break;
        }
        case "Break": this.sendCtrl(CODE.BREAK, 0, 0); break;
        case "IdleSent": this.sendCtrl(CODE.IDLE, 0, 0); break;
        case "Receiving": if (this.link.discNow) this.qrt(); break;
        case "FqWait": this.close(0); break;
        case "Idle": if (this.link.discNow || this.tx.buf.length) this.takeTurn(); break;
      }
    }
    ticksSinceTx(c) { return Math.trunc((c.tEnd - this.core.txEnd) / TICK) - ctrlTicks(c.fmt, c.code); }
    onCtrl(now, c) {
      if (this.core.transmitting || !this.accepts().includes(c.code)) return;
      const C = CODE;
      this.feedWatchdog(now);
      this.link.idleTimer = null;
      const [snr, fmt] = this.ctrlSnr.update(c.snrNorm, c.hits, c.fmt);
      this.carry.ctrlSnrHeld = snr; this.carry.snrRefDb = snr; this.carry.replyFmt = fmt;
      if (C.QRT_ANY.includes(c.code)) { this.close(c.code === C.QRT ? QRT_CWID_BLANKS[c.fmt] : 0); return; }
      if (this.link.discNow && this.state !== "Listen" && this.state !== "Calling") {
        if (this.state === "Sending") {
          if ([C.ACK_STAY, C.ACK_UP2, C.ACK_DOWN, C.ACK_UP1, C.ACK_UP3, C.ACK_UP4, C.BREAK].includes(c.code)) this.tx.acceptAll();
          else if (c.code === C.ACK_SECOND_ONLY) this.tx.secondOnly();
          else if (c.code === C.ACK_FIRST_ONLY) this.tx.firstOnly();
        }
        this.qrt();
        return;
      }
      if (this.state === "HeaderSent" || this.state === "Sending") {
        this.alt = !this.alt;
        if (this.reqFmt === null) this.carry.timing.ack(this.level, this.ticksSinceTx(c));
      }
      const measured = this.state === "Calling" || (this.state === "Break" && (c.code === C.GO_AHEAD || C.startLevel(c.code) !== null)) ||
        (this.state === "IdleSent" && c.code === C.NO_TRAFFIC);
      if (measured) this.carry.timing.ctrl(this.ticksSinceTx(c), this.state === "Calling");
      switch (this.state) {
        case "Listen": this.onRequest(now, c); break;
        case "Answering": this.ctrlAnswering(now, c); break;
        case "Calling": this.onReply(c); break;
        case "HeaderSent": this.ctrlHeaderSent(now, c); break;
        case "Receiving": this.ctrlReceiving(c); break;
        case "Break": this.ctrlBreak(now, c); break;
        case "Sending": this.ctrlSending(c); break;
        case "IdleSent":
          if (c.code === C.NO_TRAFFIC && !this.tx.buf.length) { this.link.idleTimer = now + IDLE_POLL; this.enter("Idle"); }
          else if (c.code === C.NO_TRAFFIC) this.takeTurn();
          else if (c.code === C.BREAK) this.grant();
          else this.resendLast();
          break;
        case "FqWait": this.resendLast(); break;
        case "Idle":
          if (c.code === C.BREAK) this.grant();
          else if (c.code === C.IDLE) { this.fmt = 0; this.answerIdle(); }
          break;
      }
    }
    onRequest(now, c) {
      const a = CODE.connectReqAlias(c.code);
      if (!a) return;
      const [reqBw, alias] = a;
      const bw = reqBw === BW2300 && this.bw === BW500 ? this.bw : reqBw === BW2750 ? this.bw : reqBw;
      this.switchBw(bw);
      this.mycall = this.cfg.host.mycalls[alias];
      this.role = ROLE.ANSWERER;
      const q = this.adapt.levelFromSnr(c.snrNorm, ANSWER_LEVEL_MAX, 6);
      this.level = this.prevLevel = this.upstepFrom = this.carry.rxLevel = q;
      this.fallback = [];
      const reply = CODE.connectReply(this.bw, q);
      if (this.state === "Listen") {
        this.core.host({kind: "pending"});
        this.state = "Answering";
        this.feedWatchdog(now);
      }
      this.sendCtrl(reply, 1, this.cfg.host.chat ? 0 : ANSWER_EXTRA_LEAD);
      this.announce();
    }
    switchBw(bw) {
      if (bw !== this.bw) { this.bw = bw; this.carry.timing.setBw(bw); this.adapt = new Adaptation(bw); }
    }
    ctrlAnswering(now, c) {
      if (CODE.ACK_REQ.includes(c.code)) {
        if (c.code === this.ackReq()) { this.alt = !this.alt; this.headerNack(stepDown(this.bw, this.level)); }
        else this.resendLast();
      } else this.onRequest(now, c);
    }
    headerNack(n) {
      const old = this.level;
      this.prevLevel = old;
      this.level = n;
      this.fallback = fallbackBelow(old);
      this.sendCtrl(CODE.NACK, this.fmt, 0);
      this.announce();
    }
    onHeader(now, d) {
      const f = d.frames[0], h = f.ok ? Header.parse(f.bytes) : null;
      if (!h) {
        this.alt = !this.alt;
        const n = stepDown(this.bw, d.level);
        this.level = d.level;
        this.headerNack(n);
        return;
      }
      this.remote = h.call;
      this.carry.marker = termMarker(this.remote);
      this.carry.snrRefDb = this.trend.push(f.snrDb);
      this.adapt.frameOk(d.level);
      this.core.host({kind: "sn", sn: f.snrDb});
      this.fmt = h.reply >= 2 ? 2 : h.reply;
      this.carry.rxLevel = d.level;
      this.nextTxLevel = recClamp(h.offer, this.bw.topLevel);
      this.offeredByPeer = this.nextTxLevel;
      if (!h.valid) { this.sendCtrl(CODE.REJECT, this.fmt, 0); this.setState("Qrt"); return; }
      this.registered = h.registered;
      this.link.comp = compFromBits(h.comp);
      this.hostKind = TURN.PARTIAL; this.lastHeld = 0;
      this.hostSinceRx = [];
      this.linkUp(now);
      this.core.host({kind: "registered", registered: this.registered});
      if (this.link.discNow) this.qrt();
      else if (this.cfg.host.chat) { this.sendCtrl(CODE.IDLE, this.fmt, 0); this.enter("IdleSent"); }
      else { this.holdFrom = now; this.sendCtrl(CODE.BREAK, this.fmt, 0); this.enter("Break"); }
    }
    onReply(c) {
      const r = CODE.connectReplyQ(c.code);
      if (!r) return;
      const [replyBw, q0] = r;
      this.switchBw(replyBw === BW2300 && this.bw === BW500 ? this.bw : replyBw);
      const q = recClamp(q0, RECORDS);
      this.link.comp = this.cfg.host.registered ? this.cfg.host.compression : COMP.OFF;
      const n = this.cfg.offerLevel !== null ? Math.min(this.cfg.offerLevel, this.startCap(true))
        : this.adapt.levelFromSnr(this.carry.ctrlSnrHeld, this.startCap(true), 3);
      this.level = q; this.upstepFrom = q; this.carry.rxLevel = n; this.nextTxLevel = q; this.carry.offered = n;
      this.header = {level: q, offer: n};
      this.setState("HeaderSent");
      this.feedWatchdog(c.tEnd);
      this.sendHeader();
    }
    sendHeader() {
      if (!this.header) return;
      const {level: q, offer: n} = this.header;
      const h = {call: this.mycall, valid: true, registered: this.cfg.host.registered, comp: this.link.comp, reply: this.carry.replyFmt, offer: n};
      const fb = Header.toFrame(h, this.bw.level(q).frameBytes, queueHint(this.bw, q, 0), this.carry.marker);
      this.fmt = formatForLevel(this.bw, q);
      this.tx.finalSent = true;
      this.core.transmitting = true;
      this.link.deadline = null;
      this.core.out.push({kind: "tx", tx: {type: "data", level: q, frames: [fb]}});
    }
    ctrlHeaderSent(now, c) {
      if (c.code === CODE.BREAK) {
        this.linkUp(now);
        this.sendCtrl(CODE.startLevelCode(this.carry.offered), formatForLevel(this.bw, this.level), 0);
        this.enter("Receiving");
      } else if (c.code === CODE.IDLE) {
        this.linkUp(now);
        this.answerIdle();
      } else if (c.code === CODE.NACK) {
        if (this.header) { this.header.level = recDown(this.header.level); this.level = this.header.level; this.nextTxLevel = this.level; }
        this.reqFmt = null;
        this.sendHeader();
      }
    }
    linkUp(now) {
      this.connected = true;
      this.link.startFiles(this.tx.buf);
      this.feedWatchdog(now);
      const me = this.mycall, peer = this.remote, caller = this.role === ROLE.CALLER;
      this.core.host({kind: "connected", caller: caller ? me : peer, answerer: caller ? peer : me, vias: [], bw: this.bw});
    }
    wantsQrt() { return this.link.wantsQrt(this.tx.buf.length); }
    answerIdle() {
      if (this.wantsQrt()) this.qrt();
      else if (!this.tx.buf.length) { this.sendCtrl(CODE.NO_TRAFFIC, this.fmt, 0); this.enter("Idle"); }
      else this.takeTurn();
    }
    takeTurn() { this.sendCtrl(CODE.BREAK, this.fmt, 0); this.enter("Break"); }
    grant() { this.sendCtrl(CODE.GO_AHEAD, this.fmt, 0); this.enter("Receiving"); }
    ctrlBreak(now, c) {
      const C = CODE, sl = C.startLevel(c.code);
      if (c.code === C.GO_AHEAD || sl !== null) {
        if (sl !== null) { this.nextTxLevel = recClamp(sl, RECORDS); this.offeredByPeer = this.nextTxLevel; }
        if (this.link.discNow) { this.qrt(); return; }
        const t = {answererHold: this.holdFrom !== null && this.role === ROLE.ANSWERER, chat: this.cfg.host.chat,
          queued: this.tx.buf.length, sinceHeaderMs: this.holdFrom === null ? 0 : Math.trunc((now - this.holdFrom) * 1000 / SECOND),
          kind: this.hostKind, offered: this.offeredByPeer, nextTx: this.nextTxLevel, text: this.link.text(), lastHeld: this.lastHeld};
        const [s, held] = turnStart(this.bw, t);
        this.lastHeld = held;
        if (s.start === "hold") this.sendCtrl(C.BREAK, this.fmt, 0);
        else if (s.start === "idle") { this.link.idleTicks = 0; this.sendCtrl(C.IDLE, this.fmt, 0); this.enter("IdleSent"); }
        else {
          this.hintOverride = s.hint;
          this.level = Math.min(this.nextTxLevel, this.bw.topLevel);
          this.upstepFrom = this.level;
          this.holdFrom = null;
          this.enter("Sending");
          this.transmit();
        }
      } else if (c.code === C.BREAK && this.cfg.host.chat && this.role === ROLE.ANSWERER) this.grant();
      else this.sendCtrl(C.BREAK, 0, 0);
    }
    transmit() {
      const bw = this.bw, level = this.level, flen = bw.level(level).frameBytes, room = payloadLen(bw, level);
      const nf = this.tx.resend === null ? this.nframes() : 1, frames = [];
      let pos = 0;
      this.tx.inflight = [];
      this.tx.finalSent = false;
      const n = this.cfg.offerLevel !== null ? Math.min(this.cfg.offerLevel, bw.topLevel)
        : this.adapt.offerLevel(this.carry.snrRefDb, this.startCap(false));
      const text = this.link.text();
      let state = Math.max(this.tx.state, TC_START);
      this.tx.states = [];
      const all = this.tx.buf.view();
      for (let i = 0; i < nf; i++) {
        const rest = all.length - pos;
        const limit = this.tx.resend !== null ? this.tx.resend : Infinity;
        this.tx.resend = null;
        const lastable = nf === 1 || i === 1, rawLast = lastable && rest < room && limit >= rest;
        const q = all.subarray(pos);
        let squeeze = false;
        if (text && nf === 1 && !rawLast) {
          if (this.tx.textTurn === null) this.tx.textTurn = turnCompresses(q);
          squeeze = this.tx.textTurn;
        }
        let data, take, last, compressed = false;
        if (squeeze) {
          const e = fillFrame(q.subarray(0, Math.min(rest, limit)), room, state);
          state = e.endState;
          last = lastable && e.consumed === rest && e.bytes.length < room;
          compressed = true; take = e.consumed; data = e.bytes;
        } else if (nf === 2) {
          take = Math.min(rest, room); data = q.subarray(0, take); last = i === 1 && rest === 0;
        } else {
          take = Math.min(rest, rawLast ? room - 1 : room, limit); data = q.subarray(0, take); last = rawLast;
        }
        const after = q.subarray(take);
        let hint = text && this.tx.textTurn === true ? queueHintText(bw, level, after, state) : queueHint(bw, level, after.length);
        const ov = this.hintOverride;
        this.hintOverride = HINT_OV.OFF;
        if (ov === HINT_OV.MAX) hint = HINT_MAX;
        else if (ov === HINT_OV.TABLE_MINIMUM) hint = Math.max(hint, hintTableMinimum(bw, level, text));
        frames.push(buildFrame(flen, data, {reply: this.carry.replyFmt, compressed, hint}, last ? n : null, this.carry.marker));
        this.tx.inflight.push(take);
        this.tx.states.push(state);
        this.tx.finalSent = this.tx.finalSent || last;
        pos += take;
      }
      if (this.tx.finalSent) { this.carry.offered = n; this.carry.rxLevel = n; }
      this.fmt = formatForLevel(bw, level);
      this.reqFmt = null;
      this.core.transmitting = true;
      this.link.deadline = null;
      this.core.out.push({kind: "tx", tx: {type: "data", level, frames}});
    }
    bufferReports() { for (const n of this.tx.acceptAll()) this.core.host({kind: "buffer", n: n + this.link.files.length}); }
    ctrlSending(c) {
      const C = CODE, top = this.bw.topLevel, before = this.tx.buf.length, d = ackStep(c.code);
      if (d !== null) {
        this.bufferReports();
        const n = recClamp(Math.max(this.level + d, 1), top);
        this.stays = c.code === C.ACK_STAY && this.tx.textTurn !== true ? stayBump(this.stays) : 0;
        this.levelSet(n);
      } else if (c.code === C.ACK_SECOND_ONLY || c.code === C.ACK_FIRST_ONLY) {
        if (c.code === C.ACK_SECOND_ONLY) this.tx.secondOnly(); else this.tx.firstOnly();
        this.stays = 0;
        this.levelSet(stepDown(this.bw, this.level));
      } else if (c.code === C.NACK || c.code === C.NACK_MISSED) {
        this.tx.inflight = [];
        const k = stepCount(c.code, this.upsteps, this.level), n = stepDownN(this.bw, this.level, k);
        this.stays = 0;
        if (c.code === C.NACK_MISSED) this.fmt = fmtMoreRobust(this.fmt);
        this.levelSet(n);
      } else if (c.code === C.BREAK || c.code === C.IDLE) {
        this.bufferReports();
        this.link.turnQuit(this.tx.buf);
        if (this.wantsQrt()) this.qrt();
        else if (c.code === C.BREAK) this.grant();
        else this.answerIdle();
        return;
      } else {
        if (C.ACK_REQ.includes(c.code)) this.resendLast();
        return;
      }
      if ((c.code === C.ACK_SECOND_ONLY || c.code === C.ACK_FIRST_ONLY) && this.tx.buf.length !== before)
        this.core.host({kind: "buffer", n: this.buffered()});
      if (this.link.discNow) this.qrt(); else this.transmit();
    }
    ctrlReceiving(c) {
      const C = CODE;
      if (C.ACK_REQ.includes(c.code) && c.code === this.ackReq()) {
        for (let i = 0; i < this.nframes(); i++) this.adapt.frameLost(this.level);
        const k = stepCount(C.NACK_MISSED, this.upsteps, this.level), n = stepDownN(this.bw, this.level, k);
        this.alt = !this.alt;
        this.stays = 0;
        this.levelSet(n);
        this.fallback = fallbackBelow(this.prevLevel);
        this.sendCtrl(C.NACK_MISSED, fmtMoreRobust(this.fmt), 0);
        this.announce();
      } else if (C.ACK_REQ.includes(c.code) || c.code === C.BREAK) this.resendLast();
      else if (c.code === C.IDLE) this.answerIdle();
    }
    reply(code, newLevel) {
      const C = CODE, old = this.level;
      if (code === C.ACK_STAY) this.stays = this.link.rx.turnCompressed === true ? 0 : stayBump(this.stays);
      else if (newLevel !== old || [C.NACK, C.ACK_SECOND_ONLY, C.ACK_FIRST_ONLY, C.NACK_MISSED].includes(code)) this.stays = 0;
      this.levelSet(newLevel);
      this.fallback = code === C.NACK ? fallbackBelow(old) : [];
      if (code !== C.BREAK && code !== C.IDLE) this.alt = !this.alt;
      this.sendCtrl(code, this.fmt, 0);
    }
    onData(now, d) {
      if (this.core.transmitting || !d.frames.length) return;
      if (this.state === "Answering") { this.feedWatchdog(now); this.onHeader(now, d); return; }
      if (this.state !== "Receiving" || d.tEnd < this.core.txEnd) return;
      this.feedWatchdog(now);
      if (this.link.discNow) { this.qrt(); return; }
      this.hostSinceRx = [];
      this.lastHeld = 0;
      const l = d.level;
      this.carry.rxLevel = l;
      const two = d.frames.length === 2, good = this.parseFrames(d.frames);
      if (good[0] && this.link.rx.turnCompressed === null) this.link.rx.turnCompressed = good[0].meta.ctrl.compressed;
      const ok = good.map(g => g !== null), s = this.rxStats(d.frames, ok, l);
      if (two && !ok[0]) this.adapt.frameLost(l);
      if (s !== null) this.carry.snrRefDb = s;
      let newest = null;
      for (let i = good.length - 1; i >= 0; i--) if (good[i]) { newest = good[i]; break; }
      if (!newest || s === null) {
        this.adapt.frameLost(l);
        const k = stepCount(CODE.NACK, this.upsteps, l);
        this.level = l;
        this.reply(CODE.NACK, stepDownN(this.bw, l, k));
        this.announce();
        return;
      }
      const lastf = newest.meta, fqData = bytesEq(newest.data, "FQ\r");
      this.fmt = lastf.ctrl.reply >= 2 ? 2 : lastf.ctrl.reply;
      const skip = payloadLen(this.bw, l);
      good.forEach((g, i) => { if (g) this.core.deliver(this.link, g.data, i === 1 && !ok[0] ? skip : 0); });
      this.level = l;
      if (lastf.last && ok.every(o => o) && (two || !this.twoFrames())) {
        this.endTurn(lastf, !two && !this.twoFrames() && !lastf.full && fqData);
      } else this.ackData(s, lastf.ctrl.hint, ok);
    }
    parseFrames(frames) {
      return frames.map((f, i) => {
        if (!f.ok) return null;
        const p = parseFrame(f.bytes, this.carry.marker);
        if (!p || p.data === null) return null;
        const meta = {ctrl: p.ctrl, last: p.last, full: p.full, nextLevel: p.nextLevel};
        const data = this.link.inflate(i === 1, meta.ctrl.compressed, p.data);
        return data === null ? null : {meta, data};
      });
    }
    endTurn(lastf, fq) {
      this.nextTxLevel = recClamp(lastf.nextLevel === null ? 1 : lastf.nextLevel, this.bw.topLevel);
      this.offeredByPeer = this.nextTxLevel;
      const code = this.cfg.host.chat && !this.tx.buf.length ? CODE.IDLE : CODE.BREAK;
      if (code === CODE.IDLE) this.link.idleTicks = 0;
      if (this.wantsQrt()) { this.qrt(); return; }
      this.reply(code, this.level);
      this.enter(code === CODE.BREAK ? (fq ? "FqWait" : "Break") : "IdleSent");
    }
    ackData(s, hint, ok) {
      const l = this.level, two = ok.length === 2;
      if ((two && ok[0] && !ok[1]) || (!two && this.twoFrames())) {
        this.adapt.frameLost(l);
        this.reply(CODE.ACK_FIRST_ONLY, stepDown(this.bw, l));
      } else {
        const complete = ok.every(o => o) && ok.length >= this.nframes();
        const m = this.adapt.margins(s, l), d = ackDecision(this.bw, l, m, hint, complete, this.maxLevel());
        if (d.stayReset) this.stays = null;
        this.reply(d.code, d.level);
      }
      if (this.link.discNow) this.link.deadline = null;
      this.announce();
    }
    rxStats(frames, ok, level) {
      let s = null;
      frames.forEach((f, i) => {
        if (!ok[i]) return;
        s = this.trend.push(f.snrDb);
        this.adapt.frameOk(level);
        if (i + 1 === frames.length) this.core.host({kind: "sn", sn: f.snrDb});
      });
      return s;
    }
  }

  // ───────────────────────────── station: TX scheduler (station/scheduler.rs)
  const KIND = {SESSION: "session", ANNOUNCE: "announce", FRAGMENT: "fragment", FRAGMENT_LAST: "fragmentLast"};
  class TxScheduler {
    constructor(latency, lag) { this.bursts = []; this.holdUntil = 0; this.ptt = false; this.latency = latency || 0; this.lag = lag || 0; this.unkey = null; this.tune = null; }
    setLatency(latency, lag) { this.latency = latency; this.lag = lag; }
    isEmpty() { return !this.bursts.length && this.unkey === null; }
    tuning() { return this.tune !== null; }
    startTune(tone) { this.tune = {tone, pos: 0}; }
    retune(tone) { if (this.tune) this.tune.tone = tone(); }
    stopTune() { this.tune = null; }
    untune(now, reports) { if (this.tune) { this.tune = null; this.unkeyIfEmpty(now, reports); } }
    hold(until) { this.holdUntil = Math.max(this.holdUntil, until - this.latency); }
    afterHold(now) { return Math.max(now, this.holdUntil); }
    nextStart(now) { return this.bursts.length || (this.ptt && this.unkey === null) ? now : this.afterHold(now); }
    push(samples, tail, earliest, keyed, kind) { this.bursts.push({samples, tail, pos: 0, earliest, keyed, kind}); }
    key(reports) { this.unkey = null; if (!this.ptt) { this.ptt = true; reports.push({kind: "ptt", on: true}); } }
    unkeyIfEmpty(now, reports) { if (!this.bursts.length && this.ptt) this.unkeyAt(now, reports, reports.length); }
    unkeyAt(end, reports, mark) {
      const hold = this.latency - this.lag;
      if (hold <= 0) { this.ptt = false; reports.splice(mark, 0, {kind: "ptt", on: false}); }
      else this.unkey = {at: end + hold, ready: mark};
    }
    pop(reports) {
      if (this.unkey) { if (this.unkey.ready === 0) return null; this.unkey.ready--; }
      return reports.length ? reports.shift() : null;
    }
    // One output sample at time t: null (idle), {v} or {v, kind, start, end} for a burst's last sample.
    next(t, reports) {
      const b0 = this.bursts[0];
      if (!(b0 && (b0.pos > 0 || t >= b0.earliest))) {
        const u = this.unkey;
        if (u && t >= u.at) { this.unkey = null; this.ptt = false; reports.splice(u.ready, 0, {kind: "ptt", on: false}); }
        if (!this.tune) return null;
        const v = this.tune.tone[this.tune.pos];
        this.tune.pos = (this.tune.pos + 1) % this.tune.tone.length;
        this.key(reports);
        return {v};
      }
      this.key(reports);
      const b = b0;
      if (b.pos === 0) { for (const k of b.keyed) reports.push(k); b.keyed = []; }
      const v = b.pos < b.samples.length ? b.samples[b.pos] : 0, len = b.samples.length + b.tail;
      if (++b.pos < len) return {v};
      this.bursts.shift();
      const end = t + 1;
      return {v, last: true, kind: b.kind, start: end - len, end};
    }
    release(end, reports, mark) { if (!this.bursts.length || this.bursts[0].earliest > end) this.unkeyAt(end, reports, mark); }
  }

  // ───────────────────────────── station: HF modem (station/mod.rs + station/hf.rs)
  const DEFAULT_DRIVE_DB = -5, TX_RING_BYTES = 600000, MIN_GAP = 4000, FRAGMENT_GAP = 1920;
  const KISS_SALT = 0x6B697373n;
  const keysEq = (a, b) => !!a && !!b && a.seed === b.seed && a.role === b.role && a.mycalls.join() === b.mycalls.join() &&
    String(a.connect) === String(b.connect);
  class HfStation {
    constructor(cfg, opts) {
      warm(cfg.bw);
      const o = Object.assign({driveDb: DEFAULT_DRIVE_DB, txLatency: 0, rxLag: 0, pttTail: 0}, opts || {});
      const cb = unprotoCodebook(), urx = Receiver.idle(UNPROTO_BW);
      urx.confirmEnd = false;
      this.un = {bc: new Broadcast(BigInt(cfg.seed) ^ KISS_SALT), rx: urx, entries: unprotoEntries(cb), codes: [], cb,
        modm: new Modulator(UNPROTO_BW), busy: false, marker: 0, reply: new ReplyFormat(), replyFmt: 0};
      this.cfg = cloneCfg(cfg); this.opts = o; this.session = new Session(cloneCfg(cfg));
      this.tx = new TxScheduler(o.txLatency, o.rxLag);
      this.listenOn = true; this.listening = null; this.now = 0; this.reports = []; this.pending = new ByteQ();
      this.busyDet = new Busy(cfg.bw);
      // One front end feeds the session receiver, the unproto receiver and the busy detector (all see the
      // same 48 kHz stream; upstream runs three identical copies).
      this.fe = new FrontEnd();
      this.rx = Receiver.idle(cfg.bw); this.rxOff = 0; this.rxBase = 0;
      this.modm = new Modulator(cfg.bw); this.grids = leadinGrids(); this.keys = null; this.entries = []; this.cb = null;
      this.txRnd = new VbRnd();
      this.drain();
    }
    get state() { return this.session.state; }
    isFree() { return this.idle() && !this.tx.ptt && !this.tx.tuning() && this.un.bc.idle(); }
    setPersistence(p) { this.un.bc.persistence = p; }
    setBusy(on) { this.un.busy = on; }
    resetSession() { this.session = new Session(cloneCfg(this.cfg)); this.keys = null; this.drain(); }
    pollUnproto() {
      const listening = this.session.state === "Listen", codes = [];
      if (listening && this.un.bc.kissRx) codes.push(...CODE.KISS);
      this.un.bc.cqRx = this.cfg.host.chat;
      if (listening && this.cfg.host.chat) codes.push(CODE.CQ);
      if (codes.join() !== this.un.codes.join()) {
        const e = this.un.entries.filter(e => codes.includes(e.code));
        this.un.rx.setCtrlEntries(e.length ? e : null);
        this.un.codes = codes;
      }
      const ctx = {idle: this.idle() && !this.tx.ptt && !this.tx.tuning(), bw500: this.cfg.bw === BW500,
        busy: this.un.busy || this.busyDet.on, reply: this.un.replyFmt, marker: this.un.marker, queued: this.buffered()};
      this.un.bc.poll(this.now, ctx);
      this.drainUnproto(this.now);
    }
    drainUnproto(now) {
      let e;
      while ((e = this.un.bc.pop())) {
        if (e.kind === "pending") this.reports.push({kind: "host", ev: {kind: "pending"}});
        else if (e.kind === "cancelPending") this.reports.push({kind: "host", ev: {kind: "cancelPending"}});
        else if (e.kind === "send") this.sendUnproto(now, e.plan);
        else if (e.kind === "expect") {
          this.un.rx.expect(e.level === null ? [] : [e.level], 1);
          if (e.level !== null) this.reports.push(this.unprotoBitrate(e.level, false));
        } else if (e.kind === "sn") this.reports.push({kind: "host", ev: {kind: "sn", sn: e.sn}});
        else if (e.kind === "cq") this.reports.push({kind: "line", line: cqHostLine(e.cq)});
      }
    }
    unprotoBitrate(level, tx) {
      const l = level === CQ_RECORD ? 1 : level;
      return {kind: "bitrate", level: l, bps: Math.round(UNPROTO_BW.level(l).netBps), tx};
    }
    sendUnproto(now, p) {
      this.reports.push({kind: "trace", text: `tx c${p.code} L${p.level}x${p.frames.length} unproto`});
      this.tx.stopTune();
      const d = this.opts.driveDb, g = ctrlGain(0, d);
      const ann = Array.from(frameAudio(this.grids, this.un.cb, 0, p.code, 0), v => quantise(v * g));
      this.tx.push(ann, 0, this.tx.afterHold(now), [], KIND.ANNOUNCE);
      const g2 = this.un.modm.gain(p.level, d);
      p.frames.forEach((f, k) => {
        const x = this.un.modm.transmission(p.level, [f], m => this.txRnd.draw(m));
        const s = new Float64Array(FRAGMENT_GAP + x.length);
        for (let i = 0; i < x.length; i++) s[FRAGMENT_GAP + i] = quantise(x[i] * g2);
        this.tx.push(s, 0, now, [this.unprotoBitrate(p.level, true)], k + 1 === p.frames.length ? KIND.FRAGMENT_LAST : KIND.FRAGMENT);
      });
    }
    onUnprotoEvent(ev) {
      if (ev.kind === "ctrl") {
        const d = ev.det;
        if (this.session.state === "Listen" && this.tx.isEmpty()) {
          const tEnd = to48(d.tEnd), took = this.un.bc.onCtrl(d.code, tEnd);
          this.reports.push({kind: "trace", text: `rx c${d.code} f${d.fmt} hits ${d.hits} unproto${took ? "" : " ignored"}`});
          this.tx.hold(tEnd + MIN_GAP);
        }
      } else if (ev.kind === "tx") {
        for (const f of ev.frames) {
          if (!f.frame.ok || f.missing) continue;
          this.un.bc.onFrame(ev.record, f.frame.bytes, f.frame.snrAvgDb !== null ? f.frame.snrAvgDb : f.frame.snrDb);
        }
        this.tx.hold(to48(ev.tEnd) + MIN_GAP);
      }
      this.drainUnproto(this.now);
    }
    onEvent(ev) {
      const now = this.now;
      if (ev.kind === "frame") { this.drain(); return; }
      const tEnd = this.rxBase + to48(ev.kind === "ctrl" ? ev.det.tEnd : ev.tEnd);
      this.tx.hold(tEnd + MIN_GAP);
      if (ev.kind === "ctrl") {
        const d = ev.det;
        this.un.replyFmt = this.un.reply.update(d.snrNorm, d.hits, d.fmt)[1];
        if (!this.un.bc.idle()) return;
        this.reports.push({kind: "trace", text: `rx c${d.code} f${d.fmt} hits ${d.hits} sn ${d.snrNorm.toFixed(1)} end ${(tEnd / SECOND).toFixed(3)} ${this.session.state}`});
        this.session.onCtrl(now, {code: d.code, fmt: d.fmt, hits: d.hits, snrNorm: d.snrNorm, tEnd});
      } else {
        if (!this.un.bc.idle()) return;
        const was = this.session.state, decoded = ev.ok;
        if (was === "Receiving" && decoded.length === 2 && decoded[0]) this.reportBitrate(ev.record, false);
        const marks = ev.frames.map(f => f.frame.ok ? (f.frame.bytes.length >= 3 && f.frame.bytes[f.frame.bytes.length - 3] & 0x20 ? "z" : "+") : "-").join("");
        this.reports.push({kind: "trace", text: `rx L${ev.record} [${marks}] end ${(tEnd / SECOND).toFixed(3)} ${this.session.state}`});
        this.session.onData(now, {level: ev.record, tEnd, frames: ev.frames.map(f => ({ok: f.frame.ok && !f.missing,
          bytes: f.frame.ok ? f.frame.bytes : new Uint8Array(0), snrDb: f.frame.snrAvgDb !== null ? f.frame.snrAvgDb : f.frame.snrDb}))});
        const mark = this.reports.length;
        this.drain();
        if (was === "Answering") {
          for (let i = mark; i < this.reports.length; i++) {
            const r = this.reports[i];
            if (r.kind === "host" && r.ev.kind === "connected") { this.reports.splice(i, 0, {kind: "unencrypted"}); break; }
          }
        }
        if (was === "Receiving" && decoded[decoded.length - 1] === true && this.session.state !== "Qrt") this.reportBitrate(ev.record, false);
      }
      this.drain();
    }
    render(t) {
      const d = this.opts.driveDb, keyed = [];
      let x, g;
      if (t.type === "ctrl") {
        if (t.code === CODE.BREAK) this.session.setBreakDraw(this.txRnd.randInt(2));
        x = frameAudio(this.grids, this.cb, t.fmt, t.code, t.extra);
        g = ctrlGain(t.fmt, d);
      } else if (t.type === "data") {
        this.reportBitrate(t.level, true);
        for (let i = 1; i < t.frames.length; i++) keyed.push(this.bitrate(t.level, true));
        x = this.modm.transmission(t.level, t.frames, m => this.txRnd.draw(m));
        g = this.modm.gain(t.level, d);
      } else {
        const cw = cwSynth(t.call, t.blanks, false), lead = t.blanks === 0 ? CW_UNIT : 0;
        x = new Float64Array(lead + cw.length);
        x.set(cw, lead);
        g = Math.pow(10, (d - CWID_BACKOFF_DB) / 20);
      }
      const out = new Float64Array(x.length);
      for (let i = 0; i < x.length; i++) out[i] = quantise(x[i] * g);
      return [out, keyed];
    }
    bitrate(level, tx) { return {kind: "bitrate", level, bps: Math.round(this.session.bw.level(level).netBps), tx}; }
    reportBitrate(level, tx) { this.reports.push(this.bitrate(level, tx)); }
    bandwidth() { return this.rx.bw; }
    burstDone(kind, start, end) {
      const heard = end + this.tx.latency;
      this.rx.mute(start - this.rxBase, heard - this.rxBase);
      this.rx.markTxEnd(heard - this.rxBase);
      this.un.rx.mute(start, heard);
      const mark = this.reports.length;
      if (kind === KIND.SESSION) { this.session.onTxDone(heard + this.opts.pttTail); this.drainAt(end); }
      this.tx.release(end, this.reports, mark);
      if (kind === KIND.FRAGMENT_LAST) { this.un.bc.txDone(); this.drainUnproto(end); }
    }
    apply(l) {
      const o = this.listening;
      if (!o || o.levels.join() !== l.levels.join() || o.nframes !== l.nframes)
        this.reports.push({kind: "trace", text: `expect [${l.levels.join(", ")}] x${l.nframes}`});
      if (!keysEq(this.keys, l.keys)) {
        const k = l.keys, cb = new Codebook(k.seed, k.mycalls, k.role, l.bw);
        if (k.connect) this.txRnd = cb.setConnectCodesTxRnd(k.connect[0], k.connect[1]);
        this.entries = rxEntries(cb, 0);
        this.cb = cb;
        this.keys = {seed: k.seed, mycalls: k.mycalls.slice(), role: k.role, connect: k.connect && k.connect.slice()};
      }
      const answering = this.listenOn || this.session.state !== "Listen";
      const e = answering ? this.entries.filter(e => l.codes.includes(e.code)) : [];
      this.rx.setCtrlEntries(e.length ? e : null);
      this.rx.expect(l.levels, l.nframes);
      this.rx.linked = l.linked;
      this.listening = l;
    }
    drain() { this.drainAt(this.now); }
    drainAt(now) {
      if (this.pending.length && this.session.state !== "Listen") this.session.send(now, this.pending.take());
      const txs = [];
      let o;
      while ((o = this.session.pop())) {
        if (o.kind === "tx") txs.push(o.tx);
        else if (o.kind === "listen") this.apply(o.listen);
        else {
          if (o.ev.kind === "connected") this.un.marker = termMarker(o.ev.caller);
          this.reports.push({kind: "host", ev: o.ev});
        }
      }
      for (const t of txs) {
        const what = t.type === "ctrl" ? `tx c${t.code} f${t.fmt}${t.extra > 0 ? "+" : ""}` : t.type === "data" ? `tx L${t.level}x${t.frames.length}` : "tx cw";
        this.reports.push({kind: "trace", text: `${what} ${this.session.state}`});
        this.tx.stopTune();
        const earliest = t.type === "cwid" ? now : this.tx.nextStart(now);
        if (t.type === "data" && this.session.state === "HeaderSent") this.reports.push({kind: "unencrypted"});
        const [samples, keyed] = this.render(t);
        this.tx.push(samples, 0, earliest, keyed, KIND.SESSION);
      }
    }
    idle() { return this.session.state === "Listen" && this.tx.isEmpty(); }
    link() {
      const s = this.session;
      return {state: s.state, level: s.level, peer: s.remote, bw: String(s.bw.hz), passband: s.bw.passband(), attempts: s.attempts, afcHz: this.rx.afcHz};
    }
    reconfigure(cfg) {
      if (!this.idle()) return false;
      if (cfg.bw !== this.rx.bw) {
        this.rx = Receiver.idle(cfg.bw);
        this.rxOff = Math.ceil(this.now / DEC);
        this.rxBase = this.rxOff * DEC;
        this.modm = new Modulator(cfg.bw);
      }
      this.cfg = cloneCfg(cfg);
      this.resetSession();
      return true;
    }
    // Key the TX bursts into `output` and return the input with keyed samples zeroed (scheduler.rs key_block).
    keyBlock(t0, input, output) {
      const fed = Float64Array.from(input);
      for (let i = 0; i < output.length; i++) {
        const r = this.tx.next(t0 + i, this.reports);
        if (r === null) { output[i] = 0; continue; }
        if (r.last) this.burstDone(r.kind, r.start, r.end);
        output[i] = r.v;
        fed[i] = 0;
      }
      return fed;
    }
    process(input, output) {
      const t0 = this.now, fed = this.keyBlock(t0, input, output);
      this.now = t0 + input.length;
      this.busyDet.setBw(this.session.bw);
      const forced = this.tx.ptt || !this.tx.isEmpty() || this.session.state !== "Listen";
      const [m0, bb] = this.fe.process(fed);
      for (const e of this.busyDet.feedBb(input, bb, forced)) this.reports.push({kind: "busy", on: e});
      for (const ev of this.rx.feedBb(m0 - this.rxOff, bb)) this.onEvent(ev);
      for (const ev of this.un.rx.feedBb(m0, bb)) this.onUnprotoEvent(ev);
      const dl = this.session.nextDeadline();
      if (dl !== null && dl <= this.now) this.session.poll(this.now);
      this.drain();
      this.pollUnproto();
    }
    connect(mycall, remote, vias) {
      if (vias && vias.length) return false;
      if (this.session.state === "Answering" && !this.tx.ptt && this.tx.isEmpty()) this.resetSession();
      if (this.session.state !== "Listen" || !this.un.bc.idle()) return false;
      this.session.connect(this.now, mycall, remote);
      this.drain();
      return true;
    }
    cqFrame(call, bw) {
      if (bw === null || bw === undefined) return false;
      const ok = this.isFree() && this.un.bc.cqFrame(call, bandwidth(bw) || BW2750);
      this.pollUnproto();
      return ok;
    }
    setIgnoreDcd(on) { this.un.bc.ignoreDcd = on; }
    setBw(hz) { const c = cloneCfg(this.cfg); c.bw = bandwidth(hz); return this.reconfigure(c); }
    setP2p(on) { this.update(c => { c.p2p = on; }); this.session.resetTiming(); }
    setKissRx(on) { this.un.bc.kissRx = on; }
    // Modem trait defaults (station/mod.rs)
    ptt() { return this.tx.ptt; }
    busy() { return this.busyDet.on; }
    buffered() { return this.pending.length + this.session.buffered(); }
    tune(on) {
      if (!on) { this.tx.untune(this.now, this.reports); return true; }
      if (!this.idle() || this.tx.ptt) return false;
      this.tx.startTune(HfStation.tuneTone(this.opts.driveDb));
      return true;
    }
    static tuneTone(db) { return Array.from(tuneSymbol(db), v => quantise(v)); }
    tuning() { return this.tx.tuning(); }
    setDrive(db) { this.opts.driveDb = db; this.tx.retune(() => HfStation.tuneTone(db)); }
    setTxLatency(t, lag) { this.opts.txLatency = t; this.opts.rxLag = lag; this.tx.setLatency(t, lag); }
    config() { return this.cfg; }
    update(f) { f(this.cfg); f(this.session.cfg); }
    pop() { return this.tx.pop(this.reports); }
    send(data) {
      if (this.session.state === "Listen") {
        const room = Math.max(TX_RING_BYTES - this.buffered(), 0);
        if (data.length > room) this.reports.push({kind: "trace", text: "buffer limit exceeded"});
        this.pending.push(data.subarray(0, Math.min(data.length, room)));
        return;
      }
      this.session.send(this.now, data);
      this.drain();
    }
    disconnect() { this.session.disconnect(this.now); this.drain(); }
    abort() { this.session.abort(this.now); this.drain(); }
    dropLink() { this.session.dropLink(); this.drain(); }
    setListen(on) { this.listenOn = on; if (this.listening) this.apply(this.listening); }
  }
  HfStation.VERSION = "VERSION VARA HF v4.9.0"; HfStation.VIAS = false; HfStation.CWID_GATEWAY = true;

  // @@PART5@@

  // @@EXPORTS@@
  return {
    // basics
    crc16, crcOk, VbRnd, HF_SEED, FM_SEED, whitening, pskPhasorIndex, dataDat, ofdmPhasorIndex,
    callHash, ssidCode, withSsid, packCall, unpackCall,
    frameBits, whiten, turboEncode, interleave, puncturePeriod, puncturedLen, constellation,
    dbAmp, quantise, sine, fall, fft,
    // HF levels and tables
    RECORDS, FSK_PILOTS, Level, BW500, BW2300, BW2750, BANDWIDTHS, bandwidth, datOffsets, qamLimit,
    hfTables, hfDat, serializeTables, tables, hfWhitening, pskPhasors, ofdmPhasors, warm,
    // frames and control codes
    TERMINATOR, ctrlByte, ctrlFromByte, termMarker, payloadCapacity, buildFrame, headerPayload, Header,
    CODE, FORMATS, ROLE, fmtMoreRobust, family, bwFamily, genCode, Codebook, leadinGrids, leadinSymbols,
    ctrlSynth, ctrlGain, frameAudio, atuTone, SYMBOL_SAMPLES, ATU_SYMBOLS, ATU_SILENT_SYMBOLS, TONE_BIN,
    // TX
    GRAY, fskRows, pulseTaps, interp16Taps, ncoPhase, ofdmSynth, NWIN, NFFT, NCP,
    TUNE_BACKOFF_DB, CWID_BACKOFF_DB, backoffDb, txGain, tuneSymbol, Modulator, cwUnits, cwSynth, CW_UNIT,
    // RX building blocks
    turboSplit, turboDecode, crcBytes, usedLen, decodeFrame, FrameDecoder, ITERATIONS, EXTRINSIC_SCALE,
    MIN_ITERATIONS, Demapper, demapper, softBits, energyLlrs, Eq,
    // receive
    Track, Window, Hold, median, kaiserLowpass, FrontEnd, FS3, DEC, to48, rot, CtrlDetector, rxEntries,
    FskEngine, PskEngine, OfdmEngine, Receiver, Assembler, Muted, continues, SNR_REF_DB, HYPOTHESES,
    // busy detector
    isUsCall, Busy, BUSY_HANG, signatures, detectTone, detectSignature, toneBand, signatureThreshold,
    // ARQ
    rint, dec1, SECOND, XorShift, ByteQ, packBits, unpackBits, tcTables, tcCompress, tcDecompress, turnCompresses, fitsFrames,
    COMP, filesChunk, FilesReader, FilesStager, inflateRaw, MAX_INFLATED, B2fSnoop, Reorder, Link, hostSettings,
    Adaptation, SnrTrend, QAM, ackDecision, stepDown, stepThr, formatForLevel, chooseReplyFormat, ReplyFormat, queueHint,
    queueHintText, parseFrame, startLevelCap, hintTableMinimum, HINT_MAX, Timing, TICK, turnStart, TURN, HINT_OV,
    cqFrame, cqParse, cqPayload, cqHostLine, CQ_RECORD, Broadcast, hfConfig, cloneCfg, Session, TxScheduler, KIND,
    HfStation, DEFAULT_DRIVE_DB, TX_RING_BYTES,
  };
});
