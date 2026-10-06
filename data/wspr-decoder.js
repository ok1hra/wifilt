// WSPR-2 receive decoder. SPDX-License-Identifier: GPL-3.0-or-later
//
// JavaScript port of wsprd from WSJT-X (C) 2001-2018 Joe Taylor K1JT and
// (C) 2014-2018 Steven Franke K9AN (block demodulation, subtraction, OSD);
// Fano decoder (C) 1994 Phil Karn KA9Q; lookup3 hash by Bob Jenkins (public
// domain). Port (C) 2026 RemoteQTH.com. See THIRD-PARTY-NOTICES.txt.
//
// Encoder, sync vector and interleaver are NOT repeated here: subtraction
// re-encodes through data/wspr-core.js, so the two directions cannot disagree.
// Input is the AUD1 RX stream as it arrives -- mu-law expanded Float32 at
// 8 kHz, 114 s starting on the even UTC minute -- and is brought to wsprd's
// 12 kHz before anything else happens.
//
// Runs twice: as a library (page, Node tests) and as its own Web Worker. The
// worker is told where wspr-core.js lives in `init`, so the URL carries the
// page's ?v= stamp instead of a second, unstamped one. `coreUrl` may be a list:
// wspr-core.js reads IcomModels at load, so icom-models.js has to come first.

(function (root, factory) {
  const isWorker = typeof importScripts === "function" && typeof document === "undefined";
  let api = null;
  const build = () => api || (api = factory(root.WsprCore ||
    (typeof require === "function" ? require("./wspr-core.js") : null)));
  if (typeof module === "object" && module.exports) { module.exports = build(); return; }
  if (!isWorker) { Object.defineProperty(root, "WsprDecoder", {get: build, configurable: true}); return; }
  let hashes = null;
  root.onmessage = (event) => {
    const m = event.data;
    try {
      if (m.type === "init") {
        // wspr-core.js needs icom-models.js loaded first; the page sends both.
        if (!root.WsprCore) importScripts(...[].concat(m.coreUrl));
        hashes = new (build().HashTable)();
        hashes.load(m.hashtable);
        return;
      }
      if (m.type !== "decode") return;
      const decoder = build();
      if (!hashes) hashes = new decoder.HashTable();
      const result = decoder.decode(m.samples, m.sampleRate, m.opts, hashes,
        (p) => root.postMessage({type: "progress", id: m.id, pass: p.pass, count: p.count}));
      root.postMessage({type: "result", id: m.id, decodes: result.decodes, ms: result.ms,
        hashtable: hashes.toJSON()});
    } catch (error) {
      root.postMessage({type: "error", id: m.id, message: String(error && error.stack || error)});
    }
  };
})(typeof globalThis !== "undefined" ? globalThis : self, function (Core) {
  "use strict";
  if (!Core) throw new Error("wspr-decoder.js needs wspr-core.js");

  const PR3 = new Uint8Array(162);
  for (let i = 0; i < 162; i++) PR3[i] = Core.syncBit(i);

  // INTERLEAVE[p] = channel position of code bit p (the bit-reversal walk).
  const INTERLEAVE = new Uint8Array(162);
  for (let i = 0, p = 0; p < 162; i++) {
    let j = 0;
    for (let b = 0; b < 8; b++) if (i & (1 << b)) j |= 1 << (7 - b);
    if (j < 162) INTERLEAVE[p++] = j;
  }
  function deinterleave(sym) {
    const tmp = new Uint8Array(162);
    for (let p = 0; p < 162; p++) tmp[p] = sym[INTERLEAVE[p]];
    sym.set(tmp);
  }
  function channelSymbols(data) {
    const bits = Core.interleave(Core.convolutionalEncode(data));
    for (let i = 0; i < 162; i++) bits[i] = 2 * bits[i] + PR3[i];
    return bits;
  }

  // Fano metric table (wsprd metric_tables[2], 2-FSK, Es/No = 6 dB).
  const METRIC = [0.9999,0.9998,0.9998,0.9998,0.9998,0.9998,0.9997,0.9997,0.9997,0.9997,0.9997,0.9996,0.9996,0.9996,0.9995,0.9995,0.9994,0.9994,0.9994,0.9993,0.9993,0.9992,0.9991,0.9991,0.9990,0.9989,0.9988,0.9988,0.9988,0.9986,0.9985,0.9984,0.9983,0.9982,0.9980,0.9979,0.9977,0.9976,0.9974,0.9971,0.9969,0.9968,0.9965,0.9962,0.9960,0.9957,0.9953,0.9950,0.9947,0.9941,0.9937,0.9933,0.9928,0.9922,0.9917,0.9911,0.9904,0.9897,0.9890,0.9882,0.9874,0.9863,0.9855,0.9843,0.9832,0.9819,0.9806,0.9792,0.9777,0.9760,0.9743,0.9724,0.9704,0.9683,0.9659,0.9634,0.9609,0.9581,0.9550,0.9516,0.9481,0.9446,0.9406,0.9363,0.9317,0.9270,0.9218,0.9160,0.9103,0.9038,0.8972,0.8898,0.8822,0.8739,0.8647,0.8554,0.8457,0.8357,0.8231,0.8115,0.7984,0.7854,0.7704,0.7556,0.7391,0.7210,0.7038,0.6840,0.6633,0.6408,0.6174,0.5939,0.5678,0.5410,0.5137,0.4836,0.4524,0.4193,0.3850,0.3482,0.3132,0.2733,0.2315,0.1891,0.1476,0.1021,0.0571,0.0136,-0.0329,-0.0820,-0.1325,-0.1845,-0.2366,-0.2894,-0.3456,-0.4022,-0.4600,-0.5199,-0.5793,-0.6416,-0.7038,-0.7680,-0.8344,-0.9007,-0.9671,-1.0405,-1.1086,-1.1806,-1.2550,-1.3329,-1.4093,-1.4859,-1.5642,-1.6460,-1.7298,-1.8117,-1.8961,-1.9808,-2.0670,-2.1565,-2.2461,-2.3375,-2.4321,-2.5264,-2.6224,-2.7176,-2.8139,-2.9141,-3.0167,-3.1188,-3.2207,-3.3200,-3.4290,-3.5339,-3.6431,-3.7462,-3.8583,-3.9646,-4.0764,-4.1830,-4.2979,-4.4078,-4.5266,-4.6354,-4.7480,-4.8673,-4.9791,-5.0947,-5.2050,-5.3250,-5.4486,-5.5701,-5.6892,-5.8106,-5.9269,-6.0533,-6.1717,-6.2873,-6.4084,-6.5352,-6.6620,-6.7899,-6.9091,-7.0353,-7.1574,-7.2802,-7.4083,-7.5294,-7.6625,-7.7915,-7.9196,-8.0424,-8.1638,-8.2908,-8.4307,-8.5504,-8.6767,-8.8076,-8.9405,-9.0694,-9.2013,-9.3310,-9.4602,-9.5848,-9.7209,-9.8508,-9.9852,-10.1145,-10.2446,-10.3750,-10.5086,-10.6436,-10.7716,-10.9094,-11.0369,-11.1704,-11.3058,-11.4408,-11.5677,-11.7128,-11.8438,-11.9726,-12.1201,-12.2443,-12.3910,-12.5104,-12.6421,-12.7909,-12.9343,-13.0591,-13.1934,-13.3286,-13.4579,-13.5961,-13.7273,-13.8691,-14.0060,-14.1393,-14.2669,-14.4127,-14.5524,-14.6799,-14.8169,-14.9505,-15.0838,-15.2225,-15.3537,-15.4891];

  const POLY1 = 0xf2d05351 >>> 0, POLY2 = 0xe4613c47 >>> 0;
  function parity32(x) {
    x ^= x >>> 16; x ^= x >>> 8; x ^= x >>> 4;
    return (0x6996 >>> (x & 0x0f)) & 1;
  }
  function encSym(state) {
    return (parity32((state & POLY1) >>> 0) << 1) | parity32((state & POLY2) >>> 0);
  }
  function roundC(x) { return x < 0 ? -Math.round(-x) : Math.round(x); }

  // ---------------------------------------------------------------- FFT
  // In-place radix-2 complex FFT, interleaved re/im; unnormalised like FFTW.
  const fftCache = new Map();
  function fft(buf, n, sign) {
    let t = fftCache.get(n);
    if (!t) {
      const bits = Math.log2(n) | 0, rev = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        let r = 0, x = i;
        for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
        rev[i] = r;
      }
      const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
      // The 2^21 table is 24 MB; keep only the small ones between cycles.
      t = {rev, cos, sin};
      if (n <= 4096) fftCache.set(n, t);
    }
    const {rev, cos, sin} = t;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let x = buf[2 * i]; buf[2 * i] = buf[2 * j]; buf[2 * j] = x;
        x = buf[2 * i + 1]; buf[2 * i + 1] = buf[2 * j + 1]; buf[2 * j + 1] = x;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const wr = cos[w], wi = sign * sin[w];
          const a = 2 * (start + k), b = 2 * (start + k + half);
          const xr = buf[b] * wr - buf[b + 1] * wi;
          const xi = buf[b] * wi + buf[b + 1] * wr;
          buf[b] = buf[a] - xr; buf[b + 1] = buf[a + 1] - xi;
          buf[a] += xr; buf[a + 1] += xi;
        }
      }
    }
  }

  // ----------------------------------------------------- 8 kHz -> 12 kHz
  // Upsample x3, windowed-sinc low-pass at 24 kHz, decimate x2. The filter's
  // 48-sample group delay is taken out so DT stays referenced to the minute.
  function to12k(x, rate) {
    if (rate === 12000) return x;
    if (rate !== 8000) throw new Error(`unsupported sample rate ${rate}`);
    const count = 97, mid = 48, taps = new Float64Array(count);
    const omega = 2 * Math.PI * 3400 / 24000;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const n = i - mid;
      taps[i] = (n === 0 ? omega : Math.sin(omega * n) / n) * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (count - 1)));
      sum += taps[i];
    }
    for (let i = 0; i < count; i++) taps[i] *= 3 / sum;
    const out = new Float32Array(Math.floor(x.length * 3 / 2));
    for (let m = 0; m < out.length; m++) {
      const k = 2 * m + mid;
      let acc = 0;
      const from = Math.max(0, Math.ceil((k - count + 1) / 3)), to = Math.min(x.length - 1, Math.floor(k / 3));
      for (let n = from; n <= to; n++) acc += taps[k - 3 * n] * x[n];
      out[m] = acc;
    }
    return out;
  }

  // -------------------------------------------------- downconversion
  // 12 kHz real audio -> complex baseband at 375 Hz centred on 1500 Hz, the
  // wsprd readwavfile() way: one big FFT, select bins, inverse FFT.
  const NP = 46080;
  function downconvert(samples) {
    const N1 = 1 << 21, N2 = 1 << 16;
    const npts = Math.min(samples.length, 114 * 12000);
    let big = new Float64Array(2 * N1);
    for (let i = 0; i < npts; i++) big[2 * i] = samples[i];
    fft(big, N1, -1);
    const i0 = Math.floor(1500 / (12000 / N1) + 0.5), nh2 = N2 / 2;
    const small = new Float64Array(2 * N2);
    for (let i = 0; i < N2; i++) {
      let j = i0 + i;
      if (i > nh2) j -= N2;
      small[2 * i] = big[2 * j]; small[2 * i + 1] = big[2 * j + 1];
    }
    big = null;
    fft(small, N2, +1);
    const scale = 1 / 1000 * (1474560 / N1);
    const id = new Float64Array(N2), qd = new Float64Array(N2);
    for (let i = 0; i < NP; i++) { id[i] = small[2 * i] * scale; qd[i] = small[2 * i + 1] * scale; }
    return {id, qd};
  }

  // ------------------------------------------------ sync and demodulation
  const DT = 1 / 375, DF = 375 / 256, TWOPIDT = 2 * Math.PI * DT;
  const TONE_OFFS = [-1.5, -0.5, 0.5, 1.5];

  function toneTables(fp, len, c, s) {
    for (let t = 0; t < 4; t++) {
      const dphi = TWOPIDT * (fp + TONE_OFFS[t] * DF);
      const cd = Math.cos(dphi), sd = Math.sin(dphi), ct = c[t], st = s[t];
      ct[0] = 1; st[0] = 0;
      for (let j = 1; j < len; j++) {
        ct[j] = ct[j - 1] * cd - st[j - 1] * sd;
        st[j] = ct[j - 1] * sd + st[j - 1] * cd;
      }
    }
  }
  function mk4(len) { return [new Float64Array(len), new Float64Array(len), new Float64Array(len), new Float64Array(len)]; }

  // mode 0: best time lag; mode 1: best frequency.
  function syncAndDemod(id, qd, np, f1, ifmin, ifmax, fstep, shift1, lagmin, lagmax, lagstep, drift, mode) {
    const c = mk4(256), s = mk4(256);
    if (mode === 0) { ifmin = 0; ifmax = 0; fstep = 0; }
    if (mode === 1) { lagmin = shift1; lagmax = shift1; }
    let syncmax = -1e30, bestShift = 0, fbest = 0;
    for (let ifreq = ifmin; ifreq <= ifmax; ifreq++) {
      const f0 = f1 + ifreq * fstep;
      for (let lag = lagmin; lag <= lagmax; lag += lagstep) {
        let ss = 0, totp = 0, fplast = NaN;
        for (let i = 0; i < 162; i++) {
          const fp = f0 + (drift / 2) * (i - 81) / 81;
          if (fp !== fplast) { toneTables(fp, 256, c, s); fplast = fp; }
          let i0 = 0, q0 = 0, i1 = 0, q1 = 0, i2 = 0, q2 = 0, i3 = 0, q3 = 0;
          const c0 = c[0], s0 = s[0], c1 = c[1], s1 = s[1], c2 = c[2], s2 = s[2], c3 = c[3], s3 = s[3];
          const base = lag + i * 256;
          for (let j = 0; j < 256; j++) {
            const k = base + j;
            if (k > 0 && k < np) {
              const x = id[k], y = qd[k];
              i0 += x * c0[j] + y * s0[j]; q0 += -x * s0[j] + y * c0[j];
              i1 += x * c1[j] + y * s1[j]; q1 += -x * s1[j] + y * c1[j];
              i2 += x * c2[j] + y * s2[j]; q2 += -x * s2[j] + y * c2[j];
              i3 += x * c3[j] + y * s3[j]; q3 += -x * s3[j] + y * c3[j];
            }
          }
          const p0 = Math.sqrt(i0 * i0 + q0 * q0), p1 = Math.sqrt(i1 * i1 + q1 * q1);
          const p2 = Math.sqrt(i2 * i2 + q2 * q2), p3 = Math.sqrt(i3 * i3 + q3 * q3);
          totp += p0 + p1 + p2 + p3;
          const cmet = (p1 + p3) - (p0 + p2);
          ss = PR3[i] === 1 ? ss + cmet : ss - cmet;
        }
        ss /= totp;
        if (ss > syncmax) { syncmax = ss; bestShift = lag; fbest = f0; }
      }
    }
    return {sync: syncmax, shift: bestShift, f: fbest};
  }

  // Noncoherent block detection (nblock = 1..3 symbols), soft symbols 0..255.
  function noncoherentSequenceDetection(id, qd, np, f0, lag, drift, symfac, nblock, bitbybit) {
    const c = mk4(257), s = mk4(257);
    const is = mk4(162), qs = mk4(162), cf = mk4(162), sf = mk4(162);
    const nseq = 1 << nblock;
    let fplast = NaN;
    for (let i = 0; i < 162; i++) {
      const fp = f0 + (drift / 2) * (i - 81) / 81;
      if (fp !== fplast) { toneTables(fp, 257, c, s); fplast = fp; }
      for (let t = 0; t < 4; t++) { cf[t][i] = c[t][256]; sf[t][i] = s[t][256]; }
      for (let t = 0; t < 4; t++) {
        let a = 0, b = 0;
        const ct = c[t], st = s[t];
        for (let j = 0; j < 256; j++) {
          const k = lag + i * 256 + j;
          if (k > 0 && k < np) {
            a += id[k] * ct[j] + qd[k] * st[j];
            b += -id[k] * st[j] + qd[k] * ct[j];
          }
        }
        is[t][i] = a; qs[t][i] = b;
      }
    }
    const fsymb = new Float64Array(162), p = new Float64Array(512);
    for (let i = 0; i < 162; i += nblock) {
      for (let j = 0; j < nseq; j++) {
        let xi = 0, xq = 0, cm = 1, sm = 0;
        for (let ib = 0; ib < nblock; ib++) {
          if (i + ib >= 162) break;
          const b = (j >> (nblock - 1 - ib)) & 1;
          const itone = PR3[i + ib] + 2 * b;
          xi += is[itone][i + ib] * cm + qs[itone][i + ib] * sm;
          xq += qs[itone][i + ib] * cm - is[itone][i + ib] * sm;
          const cmp = cf[itone][i + ib] * cm - sf[itone][i + ib] * sm;
          const smp = sf[itone][i + ib] * cm + cf[itone][i + ib] * sm;
          cm = cmp; sm = smp;
        }
        p[j] = Math.sqrt(xi * xi + xq * xq);
      }
      for (let ib = 0; ib < nblock; ib++) {
        if (i + ib >= 162) break;
        const imask = 1 << (nblock - 1 - ib);
        let xm1 = 0, xm0 = 0;
        for (let j = 0; j < nseq; j++) {
          if (j & imask) { if (p[j] > xm1) xm1 = p[j]; }
          else if (p[j] > xm0) xm0 = p[j];
        }
        fsymb[i + ib] = xm1 - xm0;
        if (bitbybit) fsymb[i + ib] /= (xm1 > xm0 ? xm1 : xm0);
      }
    }
    let fsum = 0, f2sum = 0;
    for (let i = 0; i < 162; i++) { fsum += fsymb[i] / 162; f2sum += fsymb[i] * fsymb[i] / 162; }
    const fac = Math.sqrt(f2sum - fsum * fsum);
    const symbols = new Uint8Array(162);
    for (let i = 0; i < 162; i++) {
      let v = symfac * fsymb[i] / fac;
      if (v > 127) v = 127;
      if (v < -128) v = -128;
      symbols[i] = Math.trunc(v + 128);
    }
    return symbols;
  }

  // Subtract the coherent component of a decoded signal (wsprd subtract_signal2).
  function subtractSignal(id, qd, np, f0, shift0, drift0, chan) {
    const nsym = 162, nsps = 256, nfilt = 360, nsig = nsym * nsps, nc2 = 45000;
    const refi = new Float64Array(nc2), refq = new Float64Array(nc2);
    const ci = new Float64Array(nc2), cq = new Float64Array(nc2);
    const cfi = new Float64Array(nc2), cfq = new Float64Array(nc2);
    let phi = 0;
    for (let i = 0; i < nsym; i++) {
      const dphi = TWOPIDT * (f0 + (drift0 / 2) * (i - nsym / 2) / (nsym / 2) + (chan[i] - 1.5) * DF);
      for (let j = 0; j < nsps; j++) {
        const ii = nsps * i + j;
        refi[ii] = Math.cos(phi); refq[ii] = Math.sin(phi);
        phi += dphi;
      }
    }
    const w = new Float64Array(nfilt), partial = new Float64Array(nfilt);
    let norm = 0;
    for (let i = 0; i < nfilt; i++) { w[i] = Math.sin(Math.PI * i / (nfilt - 1)); norm += w[i]; }
    for (let i = 0; i < nfilt; i++) w[i] /= norm;
    for (let i = 1; i < nfilt; i++) partial[i] = partial[i - 1] + w[i];
    for (let i = 0; i < nsig; i++) {
      const k = shift0 + i;
      if (k > 0 && k < np) {
        ci[i + nfilt] = id[k] * refi[i] + qd[k] * refq[i];
        cq[i + nfilt] = qd[k] * refi[i] - id[k] * refq[i];
      }
    }
    for (let i = nfilt / 2; i < nc2 - nfilt / 2; i++) {
      let a = 0, b = 0;
      const o = i - nfilt / 2;
      for (let j = 0; j < nfilt; j++) { a += w[j] * ci[o + j]; b += w[j] * cq[o + j]; }
      cfi[i] = a; cfq[i] = b;
    }
    for (let i = 0; i < nsig; i++) {
      let nrm;
      if (i < nfilt / 2) nrm = partial[nfilt / 2 + i];
      else if (i > nsig - 1 - nfilt / 2) nrm = partial[nfilt / 2 + nsig - 1 - i];
      else nrm = 1;
      const k = shift0 + i, j = i + nfilt;
      if (k > 0 && k < np) {
        id[k] -= (cfi[j] * refi[i] - cfq[j] * refq[i]) / nrm;
        qd[k] -= (cfi[j] * refq[i] + cfq[j] * refi[i]) / nrm;
      }
    }
  }

  // ----------------------------------------------------------- Fano decoder
  function makeMettab(bias) {
    const m0 = new Int32Array(256), m1 = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      m0[i] = roundC(10 * (METRIC[i] - bias));
      m1[i] = roundC(10 * (METRIC[255 - i] - bias));
    }
    return [m0, m1];
  }

  function fano(symbols, nbits, mettab, delta, maxcycles) {
    const n = nbits + 1;
    const enc = new Uint32Array(n), gamma = new Int32Array(n), met = new Int32Array(4 * n);
    const tm0 = new Int32Array(n), tm1 = new Int32Array(n), bi = new Uint8Array(n);
    const last = nbits - 1, tail = nbits - 31;
    const [M0, M1] = mettab;
    for (let k = 0; k <= last; k++) {
      const s0 = symbols[2 * k], s1 = symbols[2 * k + 1];
      met[4 * k] = M0[s0] + M0[s1];
      met[4 * k + 1] = M0[s0] + M1[s1];
      met[4 * k + 2] = M1[s0] + M0[s1];
      met[4 * k + 3] = M1[s0] + M1[s1];
    }
    let np = 0;
    let lsym = encSym(enc[0]);
    let m0 = met[lsym], m1 = met[3 ^ lsym];
    if (m0 > m1) { tm0[0] = m0; tm1[0] = m1; }
    else { tm0[0] = m1; tm1[0] = m0; enc[0] = (enc[0] + 1) >>> 0; }
    let t = 0, i;
    const maxc = maxcycles * nbits;
    for (i = 1; i <= maxc; i++) {
      const ngamma = gamma[np] + (bi[np] ? tm1[np] : tm0[np]);
      if (ngamma >= t) {
        if (gamma[np] < t + delta) { while (ngamma >= t + delta) t += delta; }
        gamma[np + 1] = ngamma;
        enc[np + 1] = (enc[np] << 1) >>> 0;
        if (++np === last + 1) break;
        lsym = encSym(enc[np]);
        if (np >= tail) {
          tm0[np] = met[4 * np + lsym];
        } else {
          m0 = met[4 * np + lsym]; m1 = met[4 * np + (3 ^ lsym)];
          if (m0 > m1) { tm0[np] = m0; tm1[np] = m1; }
          else { tm0[np] = m1; tm1[np] = m0; enc[np] = (enc[np] + 1) >>> 0; }
        }
        bi[np] = 0;
        continue;
      }
      for (;;) {
        if (np === 0 || gamma[np - 1] < t) {
          t -= delta;
          if (bi[np] !== 0) { bi[np] = 0; enc[np] = (enc[np] ^ 1) >>> 0; }
          break;
        }
        if (--np < tail && bi[np] !== 1) {
          bi[np]++;
          enc[np] = (enc[np] ^ 1) >>> 0;
          break;
        }
      }
    }
    const data = new Uint8Array(11);
    for (let b = 0, k = 7; b < (nbits >> 3); b++, k += 8) data[b] = enc[k] & 0xff;
    return {ok: i < maxc, data, cycles: i + 1};
  }

  // --------------------------------------------- ordered statistics decoder
  // Port of osdwspr.f90 (K9AN); 1-based arrays internally, as in Fortran.
  const OSD = (function () {
    const N = 162, K = 50, L = 32;
    const gg = [1,1,0,1,0,1,0,0,1,0,0,0,1,1,0,0,1,0,1,0,0,1,0,1,1,1,0,1,1,0,0,0,
                0,1,0,0,0,0,0,0,1,0,0,1,1,1,1,0,0,0,1,0,0,1,0,0,1,0,1,1,1,1,1,1];
    const gen = [];
    for (let k = 0; k <= K; k++) gen.push(new Uint8Array(N + 1));
    for (let n = 1; n <= 2 * L; n++) gen[1][n] = gg[n - 1];
    for (let k = 2; k <= K; k++)
      for (let n = 1; n <= N; n++) { let s = n - 2; if (s < 1) s += N; gen[k][n] = gen[k - 1][s]; }

    function mrbencode(me, cw, g2cols) {
      cw.fill(0);
      for (let k = 1; k <= K; k++) if (me[k] === 1) { const col = g2cols[k]; for (let n = 1; n <= N; n++) cw[n] ^= col[n]; }
    }
    function nextpat(mi, k, iorder) {
      let ind = -1;
      for (let i = 1; i <= k - 1; i++) if (mi[i] === 0 && mi[i + 1] === 1) ind = i;
      if (ind < 0) return ind;
      const ms = new Uint8Array(k + 1);
      for (let i = 1; i <= ind - 1; i++) ms[i] = mi[i];
      ms[ind] = 1; ms[ind + 1] = 0;
      if (ind + 1 < k) {
        let sum = 0; for (let i = 1; i <= k; i++) sum += ms[i];
        const nz = iorder - sum;
        for (let i = k - nz + 1; i <= k; i++) ms[i] = 1;
      }
      for (let i = 1; i <= k; i++) mi[i] = ms[i];
      for (let i = 1; i <= k; i++) if (mi[i] === 1) return i;
      return -1;
    }

    // ss: deinterleaved soft symbols centred on 0. Returns codeword (0-based).
    return function osd(ss, ndeep) {
      const rx = new Float64Array(N + 1), absrx = new Float64Array(N + 1), hdec = new Uint8Array(N + 1);
      for (let n = 1; n <= N; n++) { rx[n] = ss[n - 1] / 127; hdec[n] = rx[n] >= 0 ? 1 : 0; absrx[n] = Math.abs(rx[n]); }
      const idx = []; for (let n = 1; n <= N; n++) idx.push(n);
      idx.sort((a, b) => absrx[a] - absrx[b] || a - b);
      const indx = new Int32Array(N + 1); for (let n = 1; n <= N; n++) indx[n] = idx[n - 1];
      const genmrb = []; for (let k = 0; k <= K; k++) genmrb.push(new Uint8Array(N + 1));
      const indices = new Int32Array(N + 1);
      for (let i = 1; i <= N; i++) {
        for (let k = 1; k <= K; k++) genmrb[k][i] = gen[k][indx[N + 1 - i]];
        indices[i] = indx[N + 1 - i];
      }
      for (let id = 1; id <= K; id++) {
        for (let icol = id; icol <= K + 20; icol++) {
          if (genmrb[id][icol] === 1) {
            if (icol !== id) {
              for (let k = 1; k <= K; k++) { const t = genmrb[k][id]; genmrb[k][id] = genmrb[k][icol]; genmrb[k][icol] = t; }
              const t = indices[id]; indices[id] = indices[icol]; indices[icol] = t;
            }
            for (let ii = 1; ii <= K; ii++) {
              if (ii !== id && genmrb[ii][id] === 1) for (let n = 1; n <= N; n++) genmrb[ii][n] ^= genmrb[id][n];
            }
            break;
          }
        }
      }
      const g2cols = genmrb;
      const hd = new Uint8Array(N + 1), ab = new Float64Array(N + 1);
      for (let n = 1; n <= N; n++) { hd[n] = hdec[indices[n]]; ab[n] = absrx[indices[n]]; }
      const m0 = new Uint8Array(K + 1); for (let k = 1; k <= K; k++) m0[k] = hd[k];
      const c0 = new Uint8Array(N + 1), ce = new Uint8Array(N + 1);
      mrbencode(m0, c0, g2cols);
      let dmin = 0;
      for (let n = 1; n <= N; n++) if (c0[n] !== hd[n]) dmin += ab[n];
      const cw = new Uint8Array(N + 1); cw.set(c0);

      if (ndeep > 0) {
        if (ndeep > 5) ndeep = 5;
        let nord, npre1, npre2, nt, ntheta;
        const ntau = 16;
        if (ndeep === 1) { nord = 1; npre1 = 0; npre2 = 0; nt = 66; ntheta = 16; }
        else if (ndeep === 2) { nord = 1; npre1 = 1; npre2 = 0; nt = 66; ntheta = 22; }
        else if (ndeep === 3) { nord = 1; npre1 = 1; npre2 = 1; nt = 66; ntheta = 22; }
        else if (ndeep === 4) { nord = 2; npre1 = 1; npre2 = 1; nt = 66; ntheta = 22; }
        else { nord = 3; npre1 = 1; npre2 = 1; nt = 66; ntheta = 22; }
        const NK = N - K;
        const misub = new Uint8Array(K + 1), mi = new Uint8Array(K + 1), me = new Uint8Array(K + 1);
        const e2sub = new Uint8Array(NK + 1), e2 = new Uint8Array(NK + 1);
        for (let iorder = 1; iorder <= nord; iorder++) {
          misub.fill(0);
          for (let k = K - iorder + 1; k <= K; k++) misub[k] = 1;
          let iflag = K - iorder + 1;
          while (iflag >= 0) {
            const iend = (iorder === nord && npre1 === 0) ? iflag : 1;
            let d1 = 0;
            for (let n1 = iflag; n1 >= iend; n1--) {
              mi.set(misub); mi[n1] = 1;
              for (let k = 1; k <= K; k++) me[k] = m0[k] ^ mi[k];
              let nd1Kpt;
              if (n1 === iflag) {
                mrbencode(me, ce, g2cols);
                for (let n = 1; n <= NK; n++) { e2sub[n] = ce[K + n] ^ hd[K + n]; e2[n] = e2sub[n]; }
                nd1Kpt = 1; for (let n = 1; n <= nt; n++) nd1Kpt += e2sub[n];
                d1 = 0; for (let k = 1; k <= K; k++) if (me[k] !== hd[k]) d1 += ab[k];
              } else {
                const col = g2cols[n1];
                for (let n = 1; n <= NK; n++) e2[n] = e2sub[n] ^ col[K + n];
                nd1Kpt = 2; for (let n = 1; n <= nt; n++) nd1Kpt += e2[n];
              }
              if (nd1Kpt <= ntheta) {
                mrbencode(me, ce, g2cols);
                let dd;
                if (n1 === iflag) { dd = d1; for (let n = 1; n <= NK; n++) dd += e2sub[n] * ab[K + n]; }
                else { dd = d1 + (ce[n1] ^ hd[n1]) * ab[n1]; for (let n = 1; n <= NK; n++) dd += e2[n] * ab[K + n]; }
                if (dd < dmin) { dmin = dd; cw.set(ce); }
              }
            }
            iflag = nextpat(misub, K, iorder);
          }
        }
        if (npre2 === 1) {
          const box = new Map();
          for (let i1 = K; i1 >= 1; i1--) for (let i2 = i1 - 1; i2 >= 1; i2--) {
            let ipat = 0;
            for (let i = 1; i <= ntau; i++) if (g2cols[i1][K + i] ^ g2cols[i2][K + i]) ipat += 1 << (ntau - i);
            let arr = box.get(ipat); if (!arr) box.set(ipat, arr = []);
            arr.push([i1, i2]);
          }
          misub.fill(0);
          for (let k = K - nord + 1; k <= K; k++) misub[k] = 1;
          let iflag = K - nord + 1;
          const nxorTarget = nord + npre1 + npre2;
          while (iflag >= 0) {
            for (let k = 1; k <= K; k++) me[k] = m0[k] ^ misub[k];
            mrbencode(me, ce, g2cols);
            for (let n = 1; n <= NK; n++) e2sub[n] = ce[K + n] ^ hd[K + n];
            for (let i2 = 0; i2 <= ntau; i2++) {
              let ipat = 0;
              for (let i = 1; i <= ntau; i++) if (e2sub[i] ^ (i === i2 ? 1 : 0)) ipat += 1 << (ntau - i);
              const list = box.get(ipat);
              if (!list) continue;
              for (const [in1, in2] of list) {
                mi.set(misub); mi[in1] = 1; mi[in2] = 1;
                let sum = 0; for (let k = 1; k <= K; k++) sum += mi[k];
                if (sum < nxorTarget) break;
                for (let k = 1; k <= K; k++) me[k] = m0[k] ^ mi[k];
                mrbencode(me, ce, g2cols);
                let dd = 0; for (let n = 1; n <= N; n++) if (ce[n] !== hd[n]) dd += ab[n];
                if (dd < dmin) { dmin = dd; cw.set(ce); }
              }
            }
            iflag = nextpat(misub, K, nord);
          }
        }
      }
      const out = new Uint8Array(N);
      for (let n = 1; n <= N; n++) out[indices[n] - 1] = cw[n];
      return out;
    };
  })();

  // ------------------------------------------------------- message unpacking
  const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ";
  const isDigit = (c) => c >= "0" && c <= "9";
  const isAlpha = (c) => /^[A-Za-z]$/.test(c);

  // Bob Jenkins lookup3 hashlittle, initval 146, 15 bits.
  function nhash(str) {
    const k = Array.from(str, ch => ch.charCodeAt(0) & 0xff);
    let length = k.length, a, b, c;
    a = b = c = (0xdeadbeef + length + 146) >>> 0;
    const rot = (x, r) => ((x << r) | (x >>> (32 - r))) >>> 0;
    const word = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v |= k[p + i] << (8 * i); return v >>> 0; };
    let o = 0;
    while (length > 12) {
      a = (a + word(o, 4)) >>> 0; b = (b + word(o + 4, 4)) >>> 0; c = (c + word(o + 8, 4)) >>> 0;
      a = (a - c) >>> 0; a ^= rot(c, 4); a >>>= 0; c = (c + b) >>> 0;
      b = (b - a) >>> 0; b ^= rot(a, 6); b >>>= 0; a = (a + c) >>> 0;
      c = (c - b) >>> 0; c ^= rot(b, 8); c >>>= 0; b = (b + a) >>> 0;
      a = (a - c) >>> 0; a ^= rot(c, 16); a >>>= 0; c = (c + b) >>> 0;
      b = (b - a) >>> 0; b ^= rot(a, 19); b >>>= 0; a = (a + c) >>> 0;
      c = (c - b) >>> 0; c ^= rot(b, 4); c >>>= 0; b = (b + a) >>> 0;
      length -= 12; o += 12;
    }
    if (length === 0) return c & 32767;
    a = (a + word(o, Math.min(4, length))) >>> 0;
    if (length > 4) b = (b + word(o + 4, Math.min(4, length - 4))) >>> 0;
    if (length > 8) c = (c + word(o + 8, length - 8)) >>> 0;
    c ^= b; c >>>= 0; c = (c - rot(b, 14)) >>> 0;
    a ^= c; a >>>= 0; a = (a - rot(c, 11)) >>> 0;
    b ^= a; b >>>= 0; b = (b - rot(a, 25)) >>> 0;
    c ^= b; c >>>= 0; c = (c - rot(b, 16)) >>> 0;
    a ^= c; a >>>= 0; a = (a - rot(c, 4)) >>> 0;
    b ^= a; b >>>= 0; b = (b - rot(a, 14)) >>> 0;
    c ^= b; c >>>= 0; c = (c - rot(b, 24)) >>> 0;
    return c & 32767;
  }

  function unpackcall(ncall) {
    if (ncall >= 262177560) return null;
    let n = ncall;
    const tmp = new Array(6);
    tmp[5] = CHARS[n % 27 + 10]; n = Math.floor(n / 27);
    tmp[4] = CHARS[n % 27 + 10]; n = Math.floor(n / 27);
    tmp[3] = CHARS[n % 27 + 10]; n = Math.floor(n / 27);
    tmp[2] = CHARS[n % 10]; n = Math.floor(n / 10);
    tmp[1] = CHARS[n % 36]; n = Math.floor(n / 36);
    tmp[0] = CHARS[n];
    let i = 0;
    for (; i < 5; i++) if (tmp[i] !== " ") break;
    const buf6 = Array.from((tmp.slice(i).join("") + "      ").slice(0, 6), ch => (ch === " " ? "\0" : ch));
    let call = "";
    for (const ch of buf6) { if (ch === "\0") break; call += ch; }
    return {call, buf6};
  }

  function unpackgrid(ngrid) {
    ngrid = ngrid >>> 7;
    if (ngrid >= 32400) return null;
    const dlat = (ngrid % 180) - 90;
    let dlong = Math.floor(ngrid / 180) * 2 - 180 + 2;
    if (dlong < -180) dlong += 360;
    if (dlong > 180) dlong += 360;
    const nlong = Math.trunc(60.0 * (180.0 - dlong) / 5.0);
    let n1 = Math.trunc(nlong / 240), n2 = Math.trunc((nlong - 240 * n1) / 24);
    const g0 = CHARS[10 + n1], g2 = CHARS[n2];
    const nlat = Math.trunc(60.0 * (dlat + 90) / 2.5);
    n1 = Math.trunc(nlat / 240); n2 = Math.trunc((nlat - 240 * n1) / 24);
    return g0 + CHARS[10 + n1] + g2 + CHARS[n2];
  }

  function unpackpfx(nprefix, call) {
    if (nprefix < 60000) {
      let n = nprefix;
      const pfx = ["", "", ""];
      for (let i = 2; i >= 0; i--) {
        const nc = n % 37;
        pfx[i] = nc <= 9 ? String.fromCharCode(nc + 48) : nc <= 35 ? String.fromCharCode(nc + 55) : " ";
        n = Math.floor(n / 37);
      }
      const p = pfx.join(""), sp = p.lastIndexOf(" ");
      return (sp >= 0 ? p.slice(sp + 1) : p) + "/" + call;
    }
    const nc = ((nprefix - 60000) << 24) >> 24;   // C 'char' truncation
    if (nc >= 0 && nc <= 9) return call + "/" + String.fromCharCode(nc + 48);
    if (nc >= 10 && nc <= 35) return call + "/" + String.fromCharCode(nc + 55);
    if (nc >= 36 && nc <= 125) return call + "/" + String.fromCharCode(Math.floor((nc - 26) / 10) + 48) + String.fromCharCode((nc - 26) % 10 + 48);
    return null;
  }

  // Callsigns seen in type 1/2 messages, so type 3 (<hash> + 6-char locator)
  // can be shown with a name. Persisted by the page across cycles and reloads.
  class HashTable {
    constructor() { this.calls = new Map(); this.locs = new Map(); }
    toJSON() { return {calls: [...this.calls], locs: [...this.locs]}; }
    load(o) {
      if (!o) return;
      this.calls = new Map(o.calls || []);
      this.locs = new Map(o.locs || []);
    }
  }

  function unpk(data, ht) {
    const n1 = ((data[0] << 20) | (data[1] << 12) | (data[2] << 4) | ((data[3] >> 4) & 15)) >>> 0;
    const n2 = (((data[3] & 15) << 18) | (data[4] << 10) | (data[5] << 2) | ((data[6] >> 6) & 3)) >>> 0;
    const uc = unpackcall(n1);
    if (!uc) return null;
    const grid = unpackgrid(n2);
    if (!grid) return null;
    let callsign = uc.call;
    const ntype = (n2 & 127) - 64;
    if (ntype >= 0 && ntype <= 62) {
      const nu = ntype % 10;
      if (nu === 0 || nu === 3 || nu === 7) {
        const ihash = nhash(callsign);
        ht.calls.set(ihash, callsign); ht.locs.set(ihash, grid);
        return {type: 1, call: callsign, grid, power: ntype, noprint: false};
      }
      let nadd = nu;
      if (nu > 3) nadd = nu - 3;
      if (nu > 7) nadd = nu - 7;
      const full = unpackpfx(Math.floor(n2 / 128) + 32768 * (nadd - 1), callsign);
      if (!full) return null;
      callsign = full;
      const ndbm = ntype - nadd, nu2 = ndbm % 10;
      let noprint = false;
      if (nu2 === 0 || nu2 === 3 || nu2 === 7 || nu2 === 10) ht.calls.set(nhash(callsign), callsign);
      else noprint = true;
      return {type: 2, call: callsign, grid: "", power: ndbm, noprint};
    }
    const ndbm = -(ntype + 1), b = uc.buf6;
    let grid6 = b[5] !== "\0" ? b[5] : "";
    for (let i = 0; i < 5 && b[i] !== "\0"; i++) grid6 += b[i];
    const nu = ndbm % 10;
    let noprint = (nu !== 0 && nu !== 3 && nu !== 7 && nu !== 10) || !isAlpha(grid6[0] || "") ||
      !isAlpha(grid6[1] || "") || !isDigit(grid6[2] || "") || !isDigit(grid6[3] || "");
    const hc = ht.calls.get(Math.floor((n2 - ntype - 64) / 128));
    if (ntype === -64) noprint = true;
    return {type: 3, call: hc ? `<${hc}>` : "<...>", grid: grid6, power: ndbm, noprint};
  }

  // ------------------------------------------------------------------ decode
  const DEFAULTS = {quick: false, deep: false, subtraction: true, osdDepth: 0, wide: false,
    maxcycles: 10000, blockDemod: true};

  // samples: Float32Array starting on the even minute, `rate` 8000 or 12000.
  // Returns {decodes: [...] sorted by frequency, ms}. audioHz is the tone
  // centre in the receiver's audio; the caller adds the dial frequency.
  function decode(samples, rate, options, ht, progress) {
    const o = Object.assign({}, DEFAULTS, options || {});
    ht = ht || new HashTable();
    const t0 = Date.now();
    const {id, qd} = downconvert(to12k(samples, rate || 8000));
    const np = NP;
    const mettab = makeMettab(0.45);
    const delta = 60, symfac = 50, iifac = 8, minsync1 = 0.10;
    const minrms = 52.0 * (symfac / 64.0);
    const npasses = o.subtraction ? (o.blockDemod ? 3 : 2) : 1;
    const fmin = o.wide ? -150 : -110, fmax = o.wide ? 150 : 110;
    const df = 375.0 / 256.0 / 2;
    const nffts = 4 * Math.floor(np / 512) - 1;
    const ps = new Array(512);
    for (let j = 0; j < 512; j++) ps[j] = new Float64Array(nffts);
    const w = new Float64Array(512);
    for (let i = 0; i < 512; i++) w[i] = Math.sin(0.006147931 * i);
    const fbuf = new Float64Array(1024);
    const decodes = [], uniq = [];
    let ndecodesPass = 0;

    for (let ipass = 0; ipass < npasses; ipass++) {
      if (ipass === 1 && ndecodesPass === 0 && npasses > 2) ipass = 2;
      let nblocksize, maxdrift, minsync2;
      if (ipass < 2) { nblocksize = 1; maxdrift = 4; minsync2 = 0.12; }
      else { nblocksize = 4; maxdrift = 0; minsync2 = 0.10; }
      ndecodesPass = 0;

      for (let i = 0; i < nffts; i++) {
        for (let j = 0; j < 512; j++) {
          const k = i * 128 + j;
          fbuf[2 * j] = id[k] * w[j]; fbuf[2 * j + 1] = qd[k] * w[j];
        }
        fft(fbuf, 512, -1);
        for (let j = 0; j < 512; j++) {
          let k = j + 256; if (k > 511) k -= 512;
          ps[j][i] = fbuf[2 * k] * fbuf[2 * k] + fbuf[2 * k + 1] * fbuf[2 * k + 1];
        }
      }
      const psavg = new Float64Array(512);
      for (let j = 0; j < 512; j++) { let s = 0; const r = ps[j]; for (let i = 0; i < nffts; i++) s += r[i]; psavg[j] = s; }
      const smspec = new Float64Array(411);
      for (let i = 0; i < 411; i++) { let s = 0; for (let j = -3; j <= 3; j++) s += psavg[256 - 205 + i + j]; smspec[i] = s; }
      const noise = Float64Array.from(smspec).sort()[122];
      const minSnr = Math.pow(10, -8 / 10), snrScale = 26.3;
      for (let j = 0; j < 411; j++) {
        smspec[j] = smspec[j] / noise - 1.0;
        if (smspec[j] < minSnr) smspec[j] = 0.1 * minSnr;
      }

      let cands = [];
      for (let j = 1; j < 410 && cands.length < 200; j++) {
        if (smspec[j] > smspec[j - 1] && smspec[j] > smspec[j + 1])
          cands.push({freq: (j - 205) * df, snr: 10 * Math.log10(smspec[j]) - snrScale, shift: 0, drift: 0, sync: 0});
      }
      if (o.deep) for (let j = 0; j < 411 && cands.length < 200; j += 3) {
        if (smspec[j] > minSnr) cands.push({freq: (j - 205) * df, snr: 10 * Math.log10(smspec[j]) - snrScale, shift: 0, drift: 0, sync: 0});
      }
      cands = cands.filter(c => c.freq >= fmin && c.freq <= fmax);
      cands.sort((a, b) => b.snr - a.snr);

      // coarse shift, frequency and drift from the spectrogram
      for (const c of cands) {
        let smax = -1e30;
        const if0 = Math.trunc(c.freq / df + 256);
        for (let ifr = if0 - 2; ifr <= if0 + 2; ifr++) {
          for (let k0 = -10; k0 < 22; k0++) {
            for (let idrift = -maxdrift; idrift <= maxdrift; idrift++) {
              let ss = 0, pow = 0;
              for (let k = 0; k < 162; k++) {
                const ifd = Math.trunc(ifr + (k - 81.0) / 81.0 * idrift / (2.0 * df));
                const kindex = k0 + 2 * k;
                if (kindex >= 0 && kindex < nffts) {
                  const p0 = Math.sqrt(ps[ifd - 3][kindex]), p1 = Math.sqrt(ps[ifd - 1][kindex]);
                  const p2 = Math.sqrt(ps[ifd + 1][kindex]), p3 = Math.sqrt(ps[ifd + 3][kindex]);
                  ss += (2 * PR3[k] - 1) * ((p1 + p3) - (p0 + p2));
                  pow += p0 + p1 + p2 + p3;
                }
              }
              const sync1 = ss / pow;
              if (sync1 > smax) {
                smax = sync1;
                c.shift = 128 * (k0 + 1); c.drift = idrift; c.freq = (ifr - 256) * df; c.sync = sync1;
              }
            }
          }
        }
      }

      // refine with sync_and_demodulate
      for (const c of cands) {
        let f1 = c.freq, drift1 = c.drift, shift1 = c.shift, sync1;
        let lagmin = shift1 - 128, lagmax = shift1 + 128, lagstep = 64;
        let r = syncAndDemod(id, qd, np, f1, 0, 0, 0, shift1, lagmin, lagmax, lagstep, drift1, 0);
        shift1 = r.shift; sync1 = r.sync;
        r = syncAndDemod(id, qd, np, f1, -2, 2, 0.25, shift1, lagmin, lagmax, lagstep, drift1, 1);
        f1 = r.f; sync1 = r.sync;
        if (ipass < 2) {
          const rp = syncAndDemod(id, qd, np, f1, 0, 0, 0, shift1, lagmin, lagmax, lagstep, drift1 + 0.5, 1);
          const rm = syncAndDemod(id, qd, np, f1, 0, 0, 0, shift1, lagmin, lagmax, lagstep, drift1 - 0.5, 1);
          if (rp.sync > sync1) { drift1 += 0.5; sync1 = rp.sync; }
          else if (rm.sync > sync1) { drift1 -= 0.5; sync1 = rm.sync; }
        }
        if (sync1 > minsync1) {
          lagmin = shift1 - 32; lagmax = shift1 + 32; lagstep = 16;
          r = syncAndDemod(id, qd, np, f1, 0, 0, 0, shift1, lagmin, lagmax, lagstep, drift1, 0);
          shift1 = r.shift; sync1 = r.sync;
          r = syncAndDemod(id, qd, np, f1, -2, 2, 0.05, shift1, lagmin, lagmax, lagstep, drift1, 1);
          f1 = r.f; sync1 = r.sync;
          c.freq = f1; c.shift = shift1; c.drift = drift1; c.sync = sync1;
        } else {
          c.sync = sync1;
        }
      }

      const wat = [];
      for (const c of cands) {
        const k = wat.findIndex(x => Math.abs(c.freq - x.freq) < 0.05 && Math.abs(c.shift - x.shift) < 16);
        if (k >= 0) { if (c.sync > wat[k].sync) wat[k] = c; }
        else if (c.sync > minsync2) wat.push(c);
      }

      if (progress) progress({pass: ipass, count: wat.length});
      for (const c of wat) {
        const f1 = c.freq, shift1 = c.shift, drift1 = c.drift;
        let notDecoded = true, osdDecode = false, res = null, ii = 0, blockUsed = 1;
        for (let ib = 1; ib <= nblocksize && notDecoded; ib++) {
          const blocksize = ib < 4 ? ib : 1, bitmetric = ib < 4 ? 0 : 1;
          blockUsed = ib;
          for (let idt = 0; notDecoded && idt <= 128 / iifac; idt++) {
            ii = (idt + 1) >> 1;
            if (idt % 2 === 1) ii = -ii;
            ii *= iifac;
            const symbols = noncoherentSequenceDetection(id, qd, np, f1, shift1 + ii, drift1, symfac, blocksize, bitmetric);
            let sq = 0;
            for (let i = 0; i < 162; i++) { const y = symbols[i] - 128; sq += y * y; }
            if (Math.sqrt(sq / 162) > minrms) {
              deinterleave(symbols);
              res = fano(symbols, 81, mettab, delta, o.maxcycles);
              notDecoded = !res.ok;
              if (notDecoded && o.osdDepth > 0) {
                const fs = new Float64Array(162);
                for (let i = 0; i < 162; i++) fs[i] = symbols[i] - 128;
                const cw = OSD(fs, o.osdDepth);
                const hs = new Uint8Array(162);
                for (let i = 0; i < 162; i++) hs[i] = 255 * cw[i];
                const r2 = fano(hs, 81, mettab, delta, o.maxcycles);
                const u = unpk(r2.data, new HashTable());
                // OSD finds *a* codeword near anything; only trust it for a
                // callsign (and locator) already heard cleanly.
                if (u && (u.type === 1 || u.type === 2)) {
                  const ih = nhash(u.call);
                  if (ht.calls.get(ih) === u.call && (u.type === 2 || ht.locs.get(ih) === u.grid)) {
                    notDecoded = false; osdDecode = true; res = r2;
                  }
                }
              }
            }
            if (o.quick) break;
          }
        }
        if (notDecoded) continue;
        ndecodesPass++;
        const dec = unpk(res.data, ht);
        if (!dec || dec.noprint) continue;
        if (o.subtraction) subtractSignal(id, qd, np, f1, shift1, drift1, channelSymbols(res.data));
        if (uniq.some(u => u.call === dec.call && Math.abs(f1 - u.f) < 4.0)) continue;
        uniq.push({call: dec.call, f: f1});
        decodes.push({
          snr: Math.round(c.snr), dt: +(shift1 * DT - 1.0).toFixed(2), audioHz: +(1500 + f1).toFixed(2),
          drift: Math.trunc(drift1), call: dec.call, grid: dec.grid, power: dec.power, type: dec.type,
          sync: +c.sync.toFixed(3), pass: ipass + 1, osd: osdDecode,
          blocksize: blockUsed, jitter: ii, cycles: Math.floor(res.cycles / 81),
        });
      }
    }
    decodes.sort((a, b) => a.audioHz - b.audioHz);
    return {decodes, ms: Date.now() - t0};
  }

  return {decode, HashTable, nhash, unpk, to12k, _internal: {fano, OSD, deinterleave, channelSymbols, PR3}};
});
