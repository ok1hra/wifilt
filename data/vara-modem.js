// VARA-compatible modem, HF physical layer. SPDX-License-Identifier: MIT.
// JavaScript port of x0rro/xara (C) 2026 x0rro, MIT licence, pinned in
// third_party/xara/README.md: crates/xara-phy (crc, rnd, seq, call, fec,
// constellation, demap, eq, dat, dsp, ofdm, turbo/{engine,float}, decode,
// busy, cwid, hf/*). Port (C) 2026 RemoteQTH.com. docs/vara-implementace.md.
//
// Bit-exact against xara's vectors/ (tools/vara-phy-test.js): every integer
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
    feed(x) {
      const [m0, b3] = this.fe.process(x);
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
  };
});
