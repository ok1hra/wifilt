// JTTY modem: frames -> 4-GFSK audio, and the receiver that finds, decodes and
// assembles JTTY messages in the AUD1 RX stream. SPDX-License-Identifier:
// GPL-3.0-or-later. JavaScript port of WSJT-X lib/jtty (C) K1JT, K9AN, G4KLA,
// N9ADG, DL3WDG, W3SZ, KJ5HST, KD0BTO and contributors, pinned at v3.3.0-beta5
// d89fe30ca: genjtty.f90, gen_jttywave.f90, tbcc.f90, jtty_tbcc_list_decoder.f90,
// jtty_tbcc_decoder.f90, jtty_mdecode.f90, jtty_peakup.f90,
// jtty_payload_correlators.f90, subtract_jtty.f90, ana64a.f90. Port (C) 2026
// RemoteQTH.com. docs/jtty-implementace.md §3-§4.
//
// Where this differs from upstream, it is the sample rate, nothing else.
// AUD1 RX is mu-law at 8 kHz, and 8000/31.25 is exactly 256 samples a symbol,
// so the receiver runs where the data already is: the 8 kHz chunk becomes a
// 4 kHz complex analytic signal (upstream: 12 kHz -> 6 kHz), 128 samples a
// symbol. Every constant upstream gives in seconds, hertz or symbols is kept;
// the ones in samples are rescaled (sync step 12 -> 8 samples = 2 ms, sync FFT
// 8192 -> 4096 = 0.98 Hz bins).
//
// Runs as a library (page, Node tests) and as its own Web Worker, the same way
// as wspr-decoder.js: the worker is told where jtty-codec.js lives in `init`,
// so that URL carries the page's ?v= stamp.
(function (root, factory) {
  const isWorker = typeof importScripts === "function" && typeof document === "undefined";
  let api = null;
  const build = () => api || (api = factory(root.JttyCodec ||
    (typeof require === "function" ? require("./jtty-codec.js") : null)));
  if (typeof module === "object" && module.exports) { module.exports = build(); return; }
  if (!isWorker) { Object.defineProperty(root, "JttyModem", {get: build, configurable: true}); return; }
  let receiver = null;
  root.onmessage = (event) => {
    const m = event.data;
    try {
      if (m.type === "init") {
        if (!root.JttyCodec) importScripts(m.codecUrl);
        receiver = new (build().Receiver)(m.options || {});
        return;
      }
      if (!receiver) return;
      if (m.type === "config") { receiver.configure(m.options || {}); return; }
      if (m.type === "reset") { receiver.reset(); return; }
      if (m.type === "samples" || m.type === "gap") {
        const t0 = Date.now();
        const updates = m.type === "gap" ? receiver.gap(m.count) : receiver.push(m.samples);
        if (updates.length || m.wantStats)
          root.postMessage({type: "updates", updates, ms: Date.now() - t0, stats: receiver.stats()});
      }
    } catch (error) {
      root.postMessage({type: "error", message: String(error && error.stack || error)});
    }
  };
})(typeof globalThis !== "undefined" ? globalThis : self, function (Codec) {
  "use strict";
  if (!Codec) throw new Error("jtty-modem.js needs jtty-codec.js");

  const BAUD = 31.25;
  const NSYNC = 13, NDATA = 46, NSYM = 59;
  const IS13 = Uint8Array.from([0, 2, 2, 3, 0, 0, 3, 2, 1, 3, 1, 2, 0]);
  const BT = 2.0;
  const PAYLOAD_BITS = 34, INFO_BITS = 46, CRC_BITS = 12;
  const CRC_POLY = 0x80F;
  const NU = 9, NSTATES = 512, G0 = 0o1167, G1 = 0o1545;
  const RESERVED_BIT = 33;      // 1-based, reserved zero

  const RATE_IN = 8000;          // AUD1 RX
  const FS = 4000;               // complex analytic, receiver internal
  const NSS = FS / BAUD;         // 128 samples a symbol
  const NFRAME = NSYM * NSS;     // 7552
  const NSTEP = NFRAME / 4;      // quarter frame, 1888
  const FRAME_S = NSYM / BAUD;   // 1.888 s
  const NCHUNK = NFRAME + NSTEP; // 9440 = 1.25 frames
  const NANA = 16384;            // complex buffer holding a chunk
  const NFRAME_IN = NFRAME * 2, NSTEP_IN = NSTEP * 2, NCHUNK_IN = NCHUNK * 2;
  const NFFT_SYNC = 4096;
  const DF_SYNC = FS / NFFT_SYNC;
  const SYNC_HOP = 8;            // 2 ms
  const NTSTEPS = Math.floor(NSTEP / SYNC_HOP) + 1;    // 237, as upstream
  const NFZ = Math.round(10 / DF_SYNC);
  const NTZ = Math.round(0.016 * FS / SYNC_HOP);
  const SMIN = 4.6;
  const MAX_CAND = 100;

  // jtty_mdecode constants
  const MAX_ACTIVE = 30, MAX_RECENT = MAX_ACTIVE * 16, MAX_GAP = 3, MAX_RETRO = 3;
  const HIST_DT = 0.05, HIST_DF = 3.0, NEAR_DF = 12.0, CONT_DT = 0.1;
  const ALIAS_FREQ_TONES = 2.5, ALIAS_SYMBOL_FRACTION = 0.25, ALIAS_MIN_OVERLAP = 9, ALIAS_MIN_AGREEMENT = 0.8;
  const MAX_ALIAS_REFS = 32, MAX_SUBTRACTED = 16;
  const SNR_FLOOR_DB = -17;

  const db = x => (x > 1e-37 ? 10 * Math.log10(x) : -99);

  // ── FFT (radix-2, split re/im, unnormalised; sign -1 = forward) ─────────

  const fftTables = new Map();
  function fft(re, im, n, sign) {
    let t = fftTables.get(n);
    if (!t) {
      const bits = Math.log2(n) | 0, rev = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        let r = 0, x = i;
        for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
        rev[i] = r;
      }
      const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
      t = {rev, cos, sin};
      fftTables.set(n, t);
    }
    const {rev, cos, sin} = t;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let x = re[i]; re[i] = re[j]; re[j] = x;
        x = im[i]; im[i] = im[j]; im[j] = x;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const wr = cos[w], wi = sign * sin[w];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  // ── FEC: CRC-12 + tail-biting K=10 r=1/2 (tbcc.f90) ─────────────────────

  const parity = v => { v ^= v >> 16; v ^= v >> 8; v ^= v >> 4; v ^= v >> 2; v ^= v >> 1; return v & 1; };

  function crcRegister(bits, count) {
    let reg = 0;
    for (let i = 0; i < count; i++) {
      reg ^= bits[i] << (CRC_BITS - 1);
      reg = (reg & 0x800) ? ((reg << 1) ^ CRC_POLY) : (reg << 1);
      reg &= 0xFFF;
    }
    return reg;
  }

  // encode_crc12: payload(34) -> info(46), the CRC MSB first.
  function appendCrc(payload) {
    const info = new Uint8Array(INFO_BITS);
    info.set(payload.subarray(0, PAYLOAD_BITS));
    const reg = crcRegister(info, PAYLOAD_BITS);
    for (let i = 1; i <= CRC_BITS; i++) info[PAYLOAD_BITS + i - 1] = (reg >> (CRC_BITS - i)) & 1;
    return info;
  }

  const crcValid = info => crcRegister(info, INFO_BITS) === 0;

  // jtty_tbcc_transition: register = state<<1|bit, Gray-mapped two-bit tone.
  const NEXT = new Uint16Array(NSTATES * 2), TONE = new Uint8Array(NSTATES * 2);
  for (let s = 0; s < NSTATES; s++) {
    for (let b = 0; b < 2; b++) {
      const reg = ((s << 1) | b) & 0x3FF;
      const b0 = parity(reg & G0), b1 = parity(reg & G1);
      NEXT[2 * s + b] = reg & (NSTATES - 1);
      TONE[2 * s + b] = 2 * b0 + (b0 ^ b1);
    }
  }

  function tailbitingState(bits) {
    let s = 0;
    for (let i = INFO_BITS - NU; i < INFO_BITS; i++) s = ((s << 1) | bits[i]) & (NSTATES - 1);
    return s;
  }

  // tbcc_encode: 34 payload bits -> 46 tones.
  function encodePayload(payload) {
    const info = appendCrc(payload);
    const tones = new Uint8Array(NDATA);
    let s = tailbitingState(info);
    for (let t = 0; t < INFO_BITS; t++) {
      tones[t] = TONE[2 * s + info[t]];
      s = NEXT[2 * s + info[t]];
    }
    return tones;
  }

  function frameTones(frameBits) {
    const tones = new Uint8Array(NSYM);
    tones.set(IS13);
    tones.set(encodePayload(frameBits), NSYNC);
    return tones;
  }

  function messageTones(frames) {
    const tones = new Uint8Array(frames.length * NSYM);
    frames.forEach((f, i) => tones.set(frameTones(f), i * NSYM));
    return tones;
  }

  // ── waveform (gen_jttywave.f90) ─────────────────────────────────────────

  // Abramowitz & Stegun 7.1.26 is too coarse at BT=2's steep edges; this is
  // the W. J. Cody rational form, good to ~1e-12.
  function erf(x) {
    const s = x < 0 ? -1 : 1;
    x = Math.abs(x);
    if (x < 0.5) {
      const t = x * x;
      return s * x * (3.20937758913846947e3 + t * (3.77485237685302021e2 + t * (1.13864154151050156e2 +
        t * (3.16112374387056560e0 + t * 1.85777706184603153e-1)))) /
        (2.84423683343917062e3 + t * (1.28261652607737228e3 + t * (2.44024637934444173e2 +
        t * (2.36012909523441209e1 + t))));
    }
    return s * (1 - erfc(x));
  }
  function erfc(x) {
    if (x < 4) {
      const n = ((((((((5.64188496988670089e-1 * x + 8.88314979438837594e0) * x + 6.61191906371416295e1) * x +
        2.98635138197400131e2) * x + 8.81952221241769090e2) * x + 1.71204761263407058e3) * x +
        2.05107837782607147e3) * x + 1.23033935479799725e3) * x + 2.15311535474403846e-8);
      const d = ((((((((x + 1.57449261107098347e1) * x + 1.17693950891312499e2) * x + 5.37181101862009858e2) * x +
        1.62138957456669019e3) * x + 3.29079923573345963e3) * x + 4.36261909014324716e3) * x +
        3.43936767414372164e3) * x + 1.23033935480374942e3);
      return Math.exp(-x * x) * n / d;
    }
    const z = 1 / (x * x);
    const p = z * (((((1.63153871373020978e-2 * z + 3.05326634961232344e-1) * z + 3.60344899949804439e-1) * z +
      1.25781726111229246e-1) * z + 1.60837851487422766e-2) * z + 6.58749161529837803e-4);
    const q = (((((z + 2.56852019228982242e0) * z + 1.87295284992346725e0) * z + 5.27905102951428412e-1) * z +
      6.05183413124413191e-2) * z + 2.33520497626869185e-3);
    return Math.exp(-x * x) / x * (0.564189583547756287 - p / q);
  }

  function gfskPulse(bt, t) {
    const c = Math.PI * Math.sqrt(2 / Math.LN2);
    return 0.5 * (erf(c * bt * (t + 0.5)) - erf(c * bt * (t - 0.5)));
  }

  const pulseCache = new Map();
  function pulseFor(nsps) {
    let p = pulseCache.get(nsps);
    if (!p) {
      p = new Float64Array(3 * nsps);
      for (let i = 0; i < 3 * nsps; i++) p[i] = gfskPulse(BT, (i + 1 - 1.5 * nsps) / nsps);
      pulseCache.set(nsps, p);
    }
    return p;
  }

  // Phase increments of the smoothed 4-GFSK waveform, one per output sample.
  function phaseSteps(tones, nsps, sampleRate, f0) {
    const nsym = tones.length;
    const pulse = pulseFor(nsps);
    const dphi = new Float64Array((nsym + 2) * nsps);
    const peak = 2 * Math.PI / nsps;
    for (let j = 0; j < nsym; j++) {
      const ib = j * nsps, a = peak * tones[j];
      if (!a) continue;
      for (let i = 0; i < 3 * nsps; i++) dphi[ib + i] += a * pulse[i];
    }
    const a1 = peak * tones[0], an = peak * tones[nsym - 1];
    for (let i = 0; i < 2 * nsps; i++) {
      dphi[i] += a1 * pulse[nsps + i];
      dphi[nsym * nsps + i] += an * pulse[i];
    }
    const out = new Float64Array(nsym * nsps);
    const base = 2 * Math.PI * f0 / sampleRate;
    for (let i = 0; i < out.length; i++) out[i] = dphi[nsps + i] + base;
    return out;
  }

  function rampGain(i, n, nramp) {
    if (i < nramp) return (1 - Math.cos(2 * Math.PI * i / (2 * nramp))) / 2;
    const k = i - (n - nramp);
    if (k >= 0) return (1 + Math.cos(2 * Math.PI * k / (2 * nramp))) / 2;
    return 1;
  }

  // Real waveform at sampleRate (48000 for AUD1 TX), lowest tone at f0 Hz.
  // Returns Int16 PCM like RttyCodec.Encoder, amplitude 0..1 of full scale.
  function synthesize(tones, options) {
    const sampleRate = (options && options.sampleRate) || 48000;
    const f0 = (options && options.f0) || 1500;
    const amplitude = options && Number.isFinite(options.amplitude) ? options.amplitude : 0.5;
    const nsps = sampleRate / BAUD;
    if (!Number.isInteger(nsps)) throw new Error("JTTY needs a sample rate that is a multiple of 31.25 Hz");
    const d = phaseSteps(tones, nsps, sampleRate, f0);
    const nramp = Math.round(nsps / 8);
    const pcm = new Int16Array(d.length);
    let phi = 0;
    for (let i = 0; i < d.length; i++) {
      const v = amplitude * rampGain(i, d.length, nramp) * Math.sin(phi);
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      phi += d[i];
      if (phi > 2 * Math.PI) phi -= 2 * Math.PI;
    }
    return pcm;
  }

  // Unit-amplitude complex reference at the receiver's FS (subtraction).
  function complexReference(tones, f0) {
    const d = phaseSteps(tones, NSS, FS, f0);
    const nramp = Math.round(NSS / 8);
    const re = new Float64Array(d.length), im = new Float64Array(d.length);
    let phi = 0;
    for (let i = 0; i < d.length; i++) {
      const g = rampGain(i, d.length, nramp);
      re[i] = g * Math.cos(phi); im[i] = g * Math.sin(phi);
      phi += d[i];
      if (phi > 2 * Math.PI) phi -= 2 * Math.PI;
    }
    return {re, im};
  }

  // ── list-WAVA TBCC decoder (jtty_tbcc_list_decoder.f90, reference form) ──

  const WIDTH = 4, HYPOTHESES = 4, WRAPS = 2;
  const pow2 = n => 2 ** n;

  // A path's input bits as one integer, bit 1 most significant, so numeric
  // order is upstream's lexical prefix order and equality is prefix equality.
  const keyBit = (key, pos) => Math.floor(key / pow2(INFO_BITS - pos)) % 2;

  const plans = new Map();
  function planFor(L) {
    let plan = plans.get(L);
    if (plan) return plan;
    const blocks = [];
    for (let start = 1; start <= INFO_BITS; start += L) {
      const len = Math.min(L, INFO_BITS - start + 1);
      const nb = 1 << len;
      const end = new Uint16Array(NSTATES * nb), seq = new Uint16Array(NSTATES * nb);
      for (let s = 0; s < NSTATES; s++) {
        for (let w = 0; w < nb; w++) {
          let st = s, code = 0;
          for (let k = 0; k < len; k++) {
            const bit = (w >> (len - 1 - k)) & 1;
            code = code * 4 + TONE[2 * st + bit];
            st = NEXT[2 * st + bit];
          }
          end[s * nb + w] = st;
          seq[s * nb + w] = code;
        }
      }
      // Branch words whose reserved bit would be 1 are never extended.
      const reservedMask = (start <= RESERVED_BIT && start + len > RESERVED_BIT) ? 1 << (len - 1 - (RESERVED_BIT - start)) : 0;
      blocks.push({start, len, nb, end, seq, reservedMask, keyScale: pow2(INFO_BITS - (start + len - 1))});
    }
    plan = {L, blocks};
    plans.set(L, plan);
    return plan;
  }

  // energies[code] = |sum of correlations along that tone sequence|^2 / len
  function blockEnergies(block, zr, zi) {
    const ncodes = 4 ** block.len;
    const e = new Float64Array(ncodes);
    const t0 = block.start - 1;
    for (let code = 0; code < ncodes; code++) {
      let sr = 0, si = 0;
      for (let k = 0; k < block.len; k++) {
        const tone = Math.floor(code / 4 ** (block.len - 1 - k)) % 4;
        sr += zr[tone * NDATA + t0 + k];
        si += zi[tone * NDATA + t0 + k];
      }
      e[code] = (sr * sr + si * si) / block.len;
    }
    return e;
  }

  // insert_survivor into the WIDTH slots of one destination state.
  function insertSurvivor(M, O, K, base, m, o, k) {
    for (let s = base; s < base + WIDTH; s++) {
      if (M[s] === -Infinity) break;
      if (O[s] !== o || K[s] !== k) continue;
      if (m <= M[s]) return;
      for (let j = s; j < base + WIDTH - 1; j++) { M[j] = M[j + 1]; O[j] = O[j + 1]; K[j] = K[j + 1]; }
      M[base + WIDTH - 1] = -Infinity;
      break;
    }
    let at = base + WIDTH;
    for (let s = base; s < base + WIDTH; s++) {
      if (M[s] === -Infinity || m > M[s] || (m === M[s] && (o < O[s] || (o === O[s] && k < K[s])))) { at = s; break; }
    }
    if (at >= base + WIDTH) return;
    for (let j = base + WIDTH - 1; j > at; j--) { M[j] = M[j - 1]; O[j] = O[j - 1]; K[j] = K[j - 1]; }
    M[at] = m; O[at] = o; K[at] = k;
  }

  // One rung: list WAVA at coherent block length L. Returns the CRC-clean
  // payload of the best of the top HYPOTHESES closed codewords, or null.
  function decodeRung(zr, zi, L) {
    const plan = planFor(L);
    const energies = plan.blocks.map(b => blockEnergies(b, zr, zi));
    let pM = new Float64Array(NSTATES * WIDTH).fill(-Infinity);
    let pO = new Int16Array(NSTATES * WIDTH), pK = new Float64Array(NSTATES * WIDTH);
    let cM = new Float64Array(NSTATES * WIDTH), cO = new Int16Array(NSTATES * WIDTH), cK = new Float64Array(NSTATES * WIDTH);
    for (let s = 0; s < NSTATES; s++) { pM[s * WIDTH] = 0; pO[s * WIDTH] = s; }
    for (let wrap = 0; wrap < WRAPS; wrap++) {
      for (let s = 0; s < NSTATES; s++) {
        for (let r = 0; r < WIDTH; r++) {
          const i = s * WIDTH + r;
          if (pM[i] === -Infinity) continue;
          pO[i] = s; pK[i] = 0;
        }
      }
      plan.blocks.forEach((b, bi) => {
        const e = energies[bi];
        cM.fill(-Infinity);
        for (let s = 0; s < NSTATES; s++) {
          for (let r = 0; r < WIDTH; r++) {
            const i = s * WIDTH + r;
            const m0 = pM[i];
            if (m0 === -Infinity) break;
            const o = pO[i], k0 = pK[i];
            for (let w = 0; w < b.nb; w++) {
              if (w & b.reservedMask) continue;
              const idx = s * b.nb + w;
              insertSurvivor(cM, cO, cK, b.end[idx] * WIDTH, m0 + e[b.seq[idx]], o, k0 + w * b.keyScale);
            }
          }
        }
        let t = pM; pM = cM; cM = t;
        t = pO; pO = cO; cO = t;
        t = pK; pK = cK; cK = t;
      });
    }
    // Closed paths, one entry per codeword, scored again on a single pass.
    const pool = new Map();
    for (let s = 0; s < NSTATES; s++) {
      for (let r = 0; r < WIDTH; r++) {
        const i = s * WIDTH + r;
        if (pM[i] === -Infinity) break;
        if (pO[i] !== s) continue;
        const key = pK[i];
        if (!pool.has(key)) pool.set(key, key);
      }
    }
    const candidates = [];
    for (const key of pool.keys()) {
      const bits = new Uint8Array(INFO_BITS);
      for (let p = 1; p <= INFO_BITS; p++) bits[p - 1] = keyBit(key, p);
      candidates.push({key, bits, clean: cleanMetric(bits, plan, energies)});
    }
    candidates.sort((a, b) => b.clean - a.clean || a.key - b.key);
    for (const c of candidates.slice(0, HYPOTHESES)) {
      if (!crcValid(c.bits)) continue;
      if (c.bits.subarray(0, PAYLOAD_BITS).every(v => v === 0)) return null;
      return c.bits.slice(0, PAYLOAD_BITS);
    }
    return null;
  }

  function cleanMetric(bits, plan, energies) {
    let s = tailbitingState(bits), m = 0;
    plan.blocks.forEach((b, bi) => {
      let w = 0;
      for (let k = 0; k < b.len; k++) w = (w << 1) | bits[b.start - 1 + k];
      const idx = s * b.nb + w;
      m += energies[bi][b.seq[idx]];
      s = b.end[idx];
    });
    return m;
  }

  // decode_ladder: coherent L = 1, 2, 4, then L1 on half-symbol energies.
  function decodeFrame(zr, zi, hr) {
    for (const L of [1, 2, 4]) {
      const p = decodeRung(zr, zi, L);
      if (p) return p;
    }
    return decodeRung(hr, new Float64Array(hr.length), 1);
  }

  // ── receiver ────────────────────────────────────────────────────────────

  // csync: phase-continuous unsmoothed sync tones; ctones: one symbol of each tone.
  const CSYNC_RE = new Float64Array(NSYNC * NSS), CSYNC_IM = new Float64Array(NSYNC * NSS);
  {
    let k = 0, phi = 0;
    for (let i = 0; i < NSYNC; i++) {
      const d = 2 * Math.PI * BAUD * IS13[i] / FS;
      for (let j = 0; j < NSS; j++) { CSYNC_RE[k] = Math.cos(phi); CSYNC_IM[k] = Math.sin(phi); k++; phi += d; }
    }
  }
  const CT_RE = new Float64Array(4 * NSS), CT_IM = new Float64Array(4 * NSS);
  for (let t = 0; t < 4; t++) for (let j = 0; j < NSS; j++) {
    CT_RE[t * NSS + j] = Math.cos(2 * Math.PI * t * j / NSS);
    CT_IM[t * NSS + j] = Math.sin(2 * Math.PI * t * j / NSS);
  }

  // ana64a: real 8 kHz -> complex analytic 4 kHz (bins 0..2 kHz-of-4k kept,
  // which at a complex 4 kHz rate is the whole 0..4 kHz of the input).
  function analytic(x, n) {
    const n1 = 2 * NANA;
    const re = new Float64Array(n1), im = new Float64Array(n1);
    const fac = 2 / n1;
    for (let i = 0; i < n; i++) re[i] = fac * x[i];
    fft(re, im, n1, -1);
    const cr = new Float64Array(NANA), ci = new Float64Array(NANA);
    cr.set(re.subarray(0, NANA)); ci.set(im.subarray(0, NANA));
    cr[0] *= 0.5; ci[0] *= 0.5;
    fft(cr, ci, NANA, 1);
    cr.fill(0, n / 2); ci.fill(0, n / 2);
    return {re: cr, im: ci};
  }

  // c0's band from spectrum bin k0 (FS/NANA Hz each) up, mixed down to 0 Hz
  // and decimated by D -- the sync search's input (see buildS0).
  function decimateBand(c0, k0, D) {
    const re = Float64Array.from(c0.re), im = Float64Array.from(c0.im);
    fft(re, im, NANA, -1);
    const nd = NANA / D;
    const dr = new Float64Array(nd), di = new Float64Array(nd);
    for (let k = 0; k < nd; k++) { dr[k] = re[(k0 + k) % NANA]; di[k] = im[(k0 + k) % NANA]; }
    fft(dr, di, nd, 1);
    return {re: dr, im: di};
  }

  // csync at 4000/D Hz.
  const syncTables = new Map();
  function syncFor(D) {
    let t = syncTables.get(D);
    if (!t) {
      const nss = NSS / D, re = new Float64Array(NSYNC * nss), im = new Float64Array(NSYNC * nss);
      let k = 0, phi = 0;
      for (let i = 0; i < NSYNC; i++) {
        const d = 2 * Math.PI * BAUD * IS13[i] / (FS / D);
        for (let j = 0; j < nss; j++) { re[k] = Math.cos(phi); im[k] = Math.sin(phi); k++; phi += d; }
      }
      t = {re, im};
      syncTables.set(D, t);
    }
    return t;
  }

  // twkfreq with a(2)=a(3)=0: c1 = c0 * exp(-i 2 pi f t).
  function shift(c0, f, n, out) {
    const d = -2 * Math.PI * f / FS;
    const wr = Math.cos(d), wi = Math.sin(d);
    let pr = 1, pi = 0;
    for (let i = 0; i < n; i++) {
      out.re[i] = c0.re[i] * pr - c0.im[i] * pi;
      out.im[i] = c0.re[i] * pi + c0.im[i] * pr;
      const t = pr * wr - pi * wi; pi = pr * wi + pi * wr; pr = t;
      if ((i & 1023) === 1023) { const g = 1 / Math.hypot(pr, pi); pr *= g; pi *= g; }
    }
    return out;
  }

  // subtract_jtty: matched-filter channel gain, low-passed over ~2 symbols.
  const subtractFilter = (() => {
    const nfilt = 2 * NSS;
    const wr = new Float64Array(NANA), wi = new Float64Array(NANA);
    let sum = 0;
    for (let j = -nfilt / 2; j <= nfilt / 2; j++) sum += Math.cos(Math.PI * j / nfilt) ** 2;
    for (let j = -nfilt / 2; j <= nfilt / 2; j++) wr[(j + NANA) % NANA] = Math.cos(Math.PI * j / nfilt) ** 2 / sum / NANA;
    fft(wr, wi, NANA, -1);
    return {re: wr, im: wi};
  })();

  function subtract(c0, tones59, f1, xdt) {
    const ref = complexReference(tones59, f1);
    const nstart = Math.round(xdt * FS);
    const ar = new Float64Array(NANA), ai = new Float64Array(NANA);
    for (let i = 0; i < NFRAME; i++) {
      const j = nstart + i;
      if (j < 0 || j >= NCHUNK) continue;
      ar[i] = c0.re[j] * ref.re[i] + c0.im[j] * ref.im[i];
      ai[i] = c0.im[j] * ref.re[i] - c0.re[j] * ref.im[i];
    }
    fft(ar, ai, NANA, -1);
    for (let i = 0; i < NANA; i++) {
      const r = ar[i] * subtractFilter.re[i] - ai[i] * subtractFilter.im[i];
      ai[i] = ar[i] * subtractFilter.im[i] + ai[i] * subtractFilter.re[i];
      ar[i] = r;
    }
    fft(ar, ai, NANA, 1);
    for (let i = 0; i < NFRAME; i++) {
      const j = nstart + i;
      if (j < 0 || j >= NCHUNK) continue;
      c0.re[j] -= ar[i] * ref.re[i] - ai[i] * ref.im[i];
      c0.im[j] -= ar[i] * ref.im[i] + ai[i] * ref.re[i];
    }
  }

  function syncPower(c1, i0) {
    let p = 0;
    for (let i = 0; i < NSYNC; i++) {
      let sr = 0, si = 0;
      const b = i0 + i * NSS, s = i * NSS;
      for (let k = 0; k < NSS; k++) {
        const xr = c1.re[b + k], xi = c1.im[b + k];
        sr += CSYNC_RE[s + k] * xr + CSYNC_IM[s + k] * xi;
        si += CSYNC_RE[s + k] * xi - CSYNC_IM[s + k] * xr;
      }
      p += sr * sr + si * si;
    }
    return p;
  }

  // jtty_peakup: +-4 ms in 1 ms hops, +-2.5 Hz in 0.5 Hz steps, then the
  // per-symbol phase ramp of the winner sharpens f1.
  function peakup(c0, xdt0, f0) {
    const npsync = NSYNC * NSS;
    const ia = Math.max(0, Math.round((xdt0 - 0.004) * FS));
    const ib = Math.min(NCHUNK - npsync, Math.round((xdt0 + 0.004) * FS));
    let pmax = 0, fpk = f0, xpk = xdt0, zbest = null;
    const c1 = {re: new Float64Array(ib + npsync + 1), im: new Float64Array(ib + npsync + 1)};
    for (let idf = -5; idf <= 5; idf++) {
      const f = f0 + 0.5 * idf;
      shift(c0, f, ib + npsync, c1);
      for (let i0 = ia; i0 <= ib; i0 += 4) {
        const p = syncPower(c1, i0);
        if (p > pmax) { pmax = p; fpk = f; xpk = i0 / FS; zbest = {f, i0}; }
      }
    }
    if (zbest) {
      shift(c0, zbest.f, ib + npsync, c1);
      const ph = new Float64Array(NSYNC), zr = new Float64Array(NSYNC), zi = new Float64Array(NSYNC);
      for (let i = 0; i < NSYNC; i++) {
        let sr = 0, si = 0;
        const b = zbest.i0 + i * NSS, s = i * NSS;
        for (let k = 0; k < NSS; k++) {
          sr += CSYNC_RE[s + k] * c1.re[b + k] + CSYNC_IM[s + k] * c1.im[b + k];
          si += CSYNC_RE[s + k] * c1.im[b + k] - CSYNC_IM[s + k] * c1.re[b + k];
        }
        zr[i] = sr; zi[i] = si; ph[i] = Math.atan2(si, sr);
      }
      const uw = new Float64Array(NSYNC);
      uw[0] = ph[0];
      for (let i = 1; i < NSYNC; i++) {
        let d = ph[i] - ph[i - 1];
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        uw[i] = uw[i - 1] + d;
      }
      const ym = uw.reduce((a, b) => a + b, 0) / NSYNC;
      let sxy = 0, sxx = 0;
      for (let i = 0; i < NSYNC; i++) { sxy += (i - 6) * (uw[i] - ym); sxx += (i - 6) ** 2; }
      const slope = sxy / sxx, icpt = ym - slope * 6;
      let rr = 0;
      for (let i = 0; i < NSYNC; i++) rr += (uw[i] - (slope * i + icpt)) ** 2;
      const dfhz = slope / (2 * Math.PI * NSS / FS);
      if (Math.sqrt(rr / NSYNC) < 1 && Math.abs(dfhz) <= 0.5) fpk += dfhz;
    }
    return {xdt: xpk, f1: fpk};
  }

  // jtty_correlate_payload_symbols: per tone and symbol, the full-symbol
  // correlation and the phase-free energy of its two halves.
  function correlatePayload(c1, start) {
    const zr = new Float64Array(4 * NDATA), zi = new Float64Array(4 * NDATA), hr = new Float64Array(4 * NDATA);
    const half = NSS / 2;
    for (let sym = 0; sym < NDATA; sym++) {
      const first = start + sym * NSS;
      if (first + NSS > NCHUNK) break;
      for (let t = 0; t < 4; t++) {
        let fr = 0, fi = 0, e = 0;
        for (let seg = 0; seg < 2; seg++) {
          let sr = 0, si = 0;
          for (let o = seg * half; o < (seg + 1) * half; o++) {
            const xr = c1.re[first + o], xi = c1.im[first + o];
            const rr = CT_RE[t * NSS + o], ri = CT_IM[t * NSS + o];
            sr += rr * xr + ri * xi;
            si += rr * xi - ri * xr;
          }
          fr += sr; fi += si; e += sr * sr + si * si;
        }
        zr[t * NDATA + sym] = fr; zi[t * NDATA + sym] = fi; hr[t * NDATA + sym] = Math.sqrt(e);
      }
    }
    return {zr, zi, hr};
  }

  function tonePowers(c1, i0) {
    const p = new Float64Array(4);
    for (let t = 0; t < 4; t++) {
      let sr = 0, si = 0;
      for (let k = 0; k < NSS; k++) {
        const xr = c1.re[i0 + k], xi = c1.im[i0 + k];
        sr += CT_RE[t * NSS + k] * xr + CT_IM[t * NSS + k] * xi;
        si += CT_RE[t * NSS + k] * xi - CT_IM[t * NSS + k] * xr;
      }
      p[t] = sr * sr + si * si;
    }
    return p;
  }
  const argmax = a => { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i; return k; };

  const DEFAULT_CONFIG = Object.freeze({rxHz: 1500, ftolHz: 100, searchLowHz: 1200, searchHighHz: 1800});

  class Receiver {
    constructor(options) {
      this.config = Object.assign({}, DEFAULT_CONFIG);
      this.configure(options || {});
      this.reset();
    }

    configure(options) {
      for (const k of Object.keys(DEFAULT_CONFIG)) if (Number.isFinite(options[k])) this.config[k] = options[k];
      const c = this.config;
      c.rxHz = Math.max(100, Math.min(2900, c.rxHz));
      c.ftolHz = Math.max(10, Math.min(500, c.ftolHz));
      c.searchLowHz = Math.max(100, Math.min(2800, c.searchLowHz));
      c.searchHighHz = Math.max(c.searchLowHz + 100, Math.min(3000, c.searchHighHz));
    }

    reset() {
      this.buffer = new Float32Array(1 << 16);
      this.bufferStart = 0;     // absolute 8 kHz index of buffer[0]
      this.bufferEnd = 0;
      this.nextStart = 0;
      this.active = [];
      this.recent = [];
      this.aliasRefs = [];
      this.nextMessageId = 1;
      this.windows = 0;
      this.frames = 0;
      this.lastWindowMs = 0;
    }

    stats() { return {windows: this.windows, frames: this.frames, active: this.active.length, lastWindowMs: this.lastWindowMs}; }

    gap(count) { return this.push(new Float32Array(Math.max(0, count | 0))); }

    // Append 8 kHz samples; returns message updates found in any window this
    // completed. A window runs every quarter frame once 1.25 frames are in.
    push(samples) {
      const keep = NCHUNK_IN + MAX_RETRO * NSTEP_IN + NSTEP_IN;
      if (this.bufferEnd - this.bufferStart + samples.length > this.buffer.length) {
        const drop = Math.max(0, this.bufferEnd - this.bufferStart - keep);
        this.buffer.copyWithin(0, drop, this.bufferEnd - this.bufferStart);
        this.bufferStart += drop;
        if (this.bufferEnd - this.bufferStart + samples.length > this.buffer.length) {
          const bigger = new Float32Array(2 * (this.bufferEnd - this.bufferStart + samples.length));
          bigger.set(this.buffer.subarray(0, this.bufferEnd - this.bufferStart));
          this.buffer = bigger;
        }
      }
      this.buffer.set(samples, this.bufferEnd - this.bufferStart);
      this.bufferEnd += samples.length;
      const updates = [];
      while (this.nextStart + NCHUNK_IN <= this.bufferEnd) {
        if (this.nextStart < this.bufferStart) this.nextStart = this.bufferStart;
        const t0 = Date.now();
        this.step(this.nextStart, updates);
        this.lastWindowMs = Date.now() - t0;
        this.windows++;
        this.nextStart += NSTEP_IN;
      }
      return updates;
    }

    // jtty_mdecode_step: the forward window, then up to three earlier windows
    // again for every signal it subtracted.
    step(istart, updates) {
      this.prune(istart / RATE_IN, updates);
      const subtracted = this.window(istart, null, updates);
      for (const s of subtracted) {
        for (let k = 1; k <= MAX_RETRO; k++) {
          const prev = istart - k * NSTEP_IN;
          if (prev < this.bufferStart) continue;
          this.window(prev, s, updates);
        }
      }
    }

    prune(forwardT, updates) {
      const oldest = forwardT - MAX_RETRO * FRAME_S / 4;
      this.recent = this.recent.filter(r => r.tsync >= oldest - HIST_DT);
      this.active = this.active.filter(m => {
        if (oldest - m.tsync > MAX_GAP * FRAME_S + CONT_DT) {
          this.queueUpdate(updates, m, false, "expired");
          return false;
        }
        return true;
      });
    }

    channels() {
      const c = this.config;
      const list = [{fc: c.rxHz, fwid: c.ftolHz, ch: 0}];
      const span = c.searchHighHz - c.searchLowHz;
      const n = Math.max(1, Math.round(span / 300));
      for (let i = 0; i < n; i++) list.push({fc: c.searchLowHz + span * (i + 0.5) / n, fwid: span / n / 2, ch: i + 1});
      return list;
    }

    window(istart, interferer, updates) {
      const off = istart - this.bufferStart;
      const x = this.buffer.subarray(off, off + NCHUNK_IN);
      let any = false;
      for (let i = 0; i < x.length; i += 7) if (x[i] !== 0) { any = true; break; }
      if (!any) return [];
      const t0 = istart / RATE_IN;
      const c0 = analytic(x, NCHUNK_IN);
      if (interferer) subtract(c0, interferer.tones, interferer.f1, interferer.tsync - t0);

      const cfg = this.config;
      const channels = this.channels().map(ch => {
        let ja = Math.max(3, Math.floor((ch.fc - ch.fwid) / DF_SYNC));
        let jb = Math.min(Math.floor(3000 / DF_SYNC), Math.floor((ch.fc + ch.fwid) / DF_SYNC));
        if (ch.ch !== 0) {
          ja = Math.max(ja, Math.ceil(cfg.searchLowHz / DF_SYNC));
          jb = Math.min(jb, Math.floor(cfg.searchHighHz / DF_SYNC));
        }
        return Object.assign(ch, {ja, jb});
      }).filter(ch => ch.ja <= ch.jb);
      if (!channels.length) return [];
      const jlo = Math.min(...channels.map(c => c.ja)), jhi = Math.max(...channels.map(c => c.jb));

      const ctx = {t0, c0, s0: null, jlo, jhi, cands: [], ch0ok: [], subtracted: [], anySubtracted: false,
        interferer: Boolean(interferer), updates};
      const c1 = {re: new Float64Array(NCHUNK), im: new Float64Array(NCHUNK)};
      ctx.c1 = c1;

      // Phase A: channel 0 first, up to two passes over the residual.
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1 && !ctx.anySubtracted) break;
        if (!ctx.s0) this.buildS0(ctx);
        const ch0 = channels.find(c => c.ch === 0);
        if (ch0) this.processChannel(ctx, ch0);
      }
      ctx.anySubtracted = false;
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1 && !ctx.anySubtracted) break;
        if (!ctx.s0) this.buildS0(ctx);
        for (const ch of channels) if (ch.ch !== 0) this.processChannel(ctx, ch);
        ctx.s0 = null;
      }
      return ctx.subtracted;
    }

    // s0: |FFT(conj(csync) * c0[i0..])|^2 smoothed 1-2-3-2-1 across bins, for
    // every 2 ms start in the window's first quarter frame.
    //
    // Upstream narrows this FFT with a chirp-z transform; here the searched
    // band is cut out of c0's spectrum instead and the correlation runs at
    // 4000/D Hz, so the 237 FFTs shrink by D at the same 0.98 Hz bins. The
    // cut is exact (no aliasing), only the scale of s0 changes, and s0 only
    // ever ranks candidates.
    buildS0(ctx) {
      const nb = ctx.jhi - ctx.jlo + 1;
      const s0 = new Float32Array(nb * NTSTEPS);
      const jshift = Math.max(0, ctx.jlo - 24);
      const span = (ctx.jhi + 2 + Math.ceil(3 * BAUD / DF_SYNC) + 48 - jshift) * DF_SYNC;
      let D = 8;
      while (D > 1 && FS / D < span) D /= 2;
      const src = D === 1 ? ctx.c0 : decimateBand(ctx.c0, jshift * (NANA / NFFT_SYNC), D);
      const base = D === 1 ? 0 : jshift;
      const sync = syncFor(D);
      const nfft = NFFT_SYNC / D, hop = SYNC_HOP / D, n = NSYNC * NSS / D, mask = nfft - 1;
      const re = new Float64Array(nfft), im = new Float64Array(nfft);
      for (let step = 0; step < NTSTEPS; step++) {
        const i0 = step * hop;
        re.fill(0); im.fill(0);
        for (let k = 0; k < n; k++) {
          const xr = src.re[i0 + k], xi = src.im[i0 + k];
          re[k] = sync.re[k] * xr + sync.im[k] * xi;
          im[k] = sync.re[k] * xi - sync.im[k] * xr;
        }
        fft(re, im, nfft, -1);
        const p = j => { const b = (j - base) & mask; return re[b] * re[b] + im[b] * im[b]; };
        for (let j = ctx.jlo; j <= ctx.jhi; j++)
          s0[(j - ctx.jlo) * NTSTEPS + step] = p(j - 2) + 2 * p(j - 1) + 3 * p(j) + 2 * p(j + 1) + p(j + 2);
      }
      ctx.s0 = s0;
    }

    processChannel(ctx, ch) {
      const ja = ch.ja, jb = ch.jb;
      const s0 = ctx.s0;
      const nc = ch.ch === 0 ? Math.max(2, Math.min(8, Math.round(ch.fwid / (NFZ * DF_SYNC)))) : 2;
      let decoded = false;
      if (ch.ch !== 0) {
        for (const ok of ctx.ch0ok) {
          for (let j = Math.max(ja, ok.ja); j <= Math.min(jb, ok.jb); j++)
            s0.fill(0, (j - ctx.jlo) * NTSTEPS, (j - ctx.jlo + 1) * NTSTEPS);
        }
      }
      const mask = ch.ch === 0 ? new Uint8Array((jb - ja + 1) * NTSTEPS).fill(1) : null;

      for (let ic = 0; ic < nc; ic++) {
        let best = -1, bj = ja, bs = 0;
        for (let j = ja; j <= jb; j++) {
          const row = (j - ctx.jlo) * NTSTEPS, mrow = (j - ja) * NTSTEPS;
          for (let s = 0; s < NTSTEPS; s++) {
            if (mask && !mask[mrow + s]) continue;
            if (s0[row + s] > best) { best = s0[row + s]; bj = j; bs = s; }
          }
        }
        if (best <= 0) break;
        for (let j = Math.max(ja, bj - NFZ); j <= Math.min(jb, bj + NFZ); j++) {
          for (let s = Math.max(0, bs - NTZ); s <= Math.min(NTSTEPS - 1, bs + NTZ); s++) {
            if (mask) mask[(j - ja) * NTSTEPS + s] = 0;
            else s0[(j - ctx.jlo) * NTSTEPS + s] = 0;
          }
        }
        let f1 = bj * DF_SYNC, xdt = bs * SYNC_HOP / FS;
        if (ch.ch === 0) ({xdt, f1} = peakup(ctx.c0, xdt, f1));
        if (ctx.cands.length >= MAX_CAND) break;
        const cand = {f1, xdt};
        ctx.cands.push(cand);
        shift(ctx.c0, f1, NCHUNK, ctx.c1);
        const sync = this.syncStats(ctx.c1, xdt);
        cand.snrdb = sync.snrdb;
        if (ch.ch === 0 && (sync.nsync <= 6 || sync.snrdb < SMIN)) continue;
        if (ch.ch !== 0 && (sync.nsync <= 8 || sync.snrdb < 5)) continue;
        if (this.decodeAndMerge(ctx, ch, cand, sync, false)) decoded = true;
      }

      if (!decoded) {
        // Sticky sync: an open message's next frame due right at this window.
        for (const m of this.active) {
          if (m.f1 < ch.fc - ch.fwid || m.f1 > ch.fc + ch.fwid) continue;
          if (Math.abs((ctx.t0 - m.tsync) - FRAME_S) > CONT_DT) continue;
          const xdt = m.tsync + FRAME_S - ctx.t0;
          if (xdt < 0 || ctx.cands.length >= MAX_CAND) continue;
          const cand = {f1: m.f1, xdt};
          ctx.cands.push(cand);
          shift(ctx.c0, cand.f1, NCHUNK, ctx.c1);
          const sync = this.syncStats(ctx.c1, xdt);
          this.decodeAndMerge(ctx, ch, cand, sync, true);
          break;
        }
      }
    }

    syncStats(c1, xdt) {
      let pt = 0, pa = 0, nsync = 0;
      const rx = new Uint8Array(NSYNC);
      for (let j = 0; j < NSYNC; j++) {
        const i0 = Math.round(xdt * FS) + j * NSS;
        if (i0 + NSS > NCHUNK) break;
        const p = tonePowers(c1, i0);
        rx[j] = argmax(p);
        if (rx[j] === IS13[j]) nsync++;
        pt += p[IS13[j]];
        pa += p[0] + p[1] + p[2] + p[3];
      }
      const pn = (pa - pt) / 3;
      return {pt, pa, nsync, rx, snrdb: pn > 0 ? db(pt / pn) : -99.9};
    }

    decodeAndMerge(ctx, ch, cand, sync, retry) {
      const start = Math.round(cand.xdt * FS) + NSYNC * NSS;
      const z = correlatePayload(ctx.c1, start);
      const payload = decodeFrame(z.zr, z.zi, z.hr);
      if (!payload) return false;
      const frame = Codec.renderFrame(payload);
      if (!frame) return false;
      const tones = encodePayload(payload);
      let pt = sync.pt, pa = sync.pa;
      const rxFrame = new Uint8Array(NSYM);
      rxFrame.set(sync.rx);
      for (let j = 0; j < NDATA; j++) {
        let k = 0, best = -1, sum = 0;
        for (let t = 0; t < 4; t++) {
          const p = z.zr[t * NDATA + j] ** 2 + z.zi[t * NDATA + j] ** 2;
          sum += p;
          if (p > best) { best = p; k = t; }
          if (t === tones[j]) pt += p;
        }
        rxFrame[NSYNC + j] = k;
        pa += sum;
      }
      const pn = (pa - pt) / 3;
      if (pn > 0) cand.snrdb = Math.max(db((pt - pn) / pn) - db(2500 / BAUD), SNR_FLOOR_DB);
      cand.tsync = ctx.t0 + cand.xdt;
      cand.text = frame.text;
      cand.trailingSep = frame.trailingSep;
      cand.eom = frame.eom;
      if (!retry && this.isAlias(cand.f1, cand.tsync, rxFrame, ctx)) return false;
      // record_ch0_success runs for every channel-0 decode, a dupe included.
      if (ch.ch === 0 && ctx.ch0ok.length < 16) {
        const j = Math.round(cand.f1 / DF_SYNC);
        ctx.ch0ok.push({ja: j - NFZ, jb: j + NFZ, f1: cand.f1, tsync: cand.tsync});
      }

      if (ctx.cands.some(c => c !== cand && c.text === cand.text && Math.abs(c.tsync - cand.tsync) < 0.032)) return true;
      if (ch.ch !== 0 && ctx.ch0ok.some(o => Math.abs(o.f1 - cand.f1) < HIST_DF && Math.abs(o.tsync - cand.tsync) < HIST_DT)) return true;

      const full = new Uint8Array(NSYM);
      full.set(IS13); full.set(tones, NSYNC);
      subtract(ctx.c0, full, cand.f1, cand.xdt);
      ctx.anySubtracted = true;
      ctx.s0 = null;
      this.rememberAlias(cand.f1, cand.tsync, full);
      if (!ctx.interferer && ctx.subtracted.length < MAX_SUBTRACTED)
        ctx.subtracted.push({f1: cand.f1, tsync: cand.tsync, tones: full});
      ctx.subtractedNow = (ctx.subtractedNow || []).concat([{f1: cand.f1, tsync: cand.tsync}]);
      this.frames++;
      this.assemble(cand, ctx.updates);
      return true;
    }

    rememberAlias(f1, tsync, tones) {
      if (this.aliasRefs.some(r => Math.abs(r.tsync - tsync) < 0.01 && Math.abs(r.f1 - f1) < 3)) return;
      this.aliasRefs.push({f1, tsync, tones});
      if (this.aliasRefs.length > MAX_ALIAS_REFS) this.aliasRefs.shift();
    }

    // is_frame_alias: a whole number of symbols inside a recent frame of the
    // same signal, its received tones that frame's tones shifted.
    isAlias(f1, tsync, rx, ctx) {
      for (const ref of this.aliasRefs) {
        const df = f1 - ref.f1;
        if (Math.abs(df) >= ALIAS_FREQ_TONES * BAUD) continue;
        if ((ctx.subtractedNow || []).some(s => Math.abs(s.tsync - ref.tsync) < 0.001 && Math.abs(s.f1 - ref.f1) < 0.1)) continue;
        const dt = tsync - ref.tsync;
        if (Math.abs(dt) >= FRAME_S) continue;
        const nsym = dt * BAUD;
        if (Math.abs(nsym - Math.round(nsym)) > ALIAS_SYMBOL_FRACTION) continue;
        const nshift = Math.round(nsym);
        if (nshift === 0) continue;
        const ktone = -Math.round(df / BAUD);
        let noverlap = 0, nagree = 0;
        for (let j = 0; j < NSYM; j++) {
          const m = j + nshift;
          if (m < 0 || m >= NSYM) continue;
          const expected = ref.tones[m] + ktone;
          if (expected < 0 || expected > 3) continue;
          noverlap++;
          if (rx[j] === expected) nagree++;
        }
        if (noverlap >= ALIAS_MIN_OVERLAP && nagree >= ALIAS_MIN_AGREEMENT * noverlap) return true;
      }
      return false;
    }

    // The part of decode_and_merge after subtraction: continue an open
    // message one frame period on (classify_active_candidate), recognise a
    // retro-window repeat, or start a new one.
    assemble(dec, updates) {
      if (this.recent.some(r => Math.abs(r.f1 - dec.f1) < NEAR_DF && Math.abs(r.tsync - dec.tsync) < HIST_DT)) return;
      let windowDupe = false, best = null, bestDf = Infinity, bestGap = 1;
      for (const m of this.active) {
        const df1 = dec.f1 - m.f1, dts = dec.tsync - m.tsync;
        const nfp = Math.round(dts / FRAME_S);
        if (nfp >= 1 && nfp <= MAX_GAP && Math.abs(dts - FRAME_S * nfp) < CONT_DT && Math.abs(df1) < 10 + 3 * (nfp - 1)) {
          if (Math.abs(df1) < bestDf) { bestDf = Math.abs(df1); best = m; bestGap = nfp; }
          continue;
        }
        const q = FRAME_S / 4, ns = Math.round(dts / q);
        if (Math.abs(ns) <= MAX_RETRO && Math.abs(df1) < 10 && Math.abs(dts - q * ns) < 0.003 && !(Math.abs(ns) % 4 === 0 && ns !== 0))
          windowDupe = true;
      }
      if (windowDupe) return;
      this.recent.push({f1: dec.f1, tsync: dec.tsync});
      if (this.recent.length > MAX_RECENT) this.recent.shift();
      if (best) {
        const add = dec.text;
        if (bestGap > 1) best.decoded = (best.decoded + "~~~~~" + add.replace(/^~/, "")).slice(0, Codec.MAX_TEXT);
        else best.decoded = (best.decoded + (best.trailingSep ? " " : "") + add).slice(0, Codec.MAX_TEXT);
        best.trailingSep = dec.trailingSep;
        best.f1 = dec.f1;
        best.tsync = dec.tsync;
        this.queueUpdate(updates, best, dec.eom);
        if (dec.eom) this.active = this.active.filter(m => m !== best);
        return;
      }
      if (!dec.eom && this.active.length >= MAX_ACTIVE) return;
      const m = {id: this.nextMessageId++, f1: dec.f1, tsync: dec.tsync, startT: dec.tsync, snr: dec.snrdb,
        decoded: dec.text, trailingSep: dec.trailingSep};
      this.queueUpdate(updates, m, dec.eom);
      if (!dec.eom) this.active.push(m);
    }

    queueUpdate(updates, m, complete, status) {
      const u = {id: m.id, audioHz: Math.round(m.f1 * 10) / 10, startT: m.startT, latestT: m.tsync,
        snr: Math.round(m.snr), text: Codec.stripFiller(Codec.displayText(m.decoded)),
        complete: Boolean(complete), status: status || (complete ? "complete" : "growing")};
      const i = updates.findIndex(x => x.id === u.id);
      if (i >= 0) updates[i] = u; else updates.push(u);
    }
  }

  return {
    BAUD, NSYM, NSYNC, NDATA, FRAME_S, IS13, RATE_IN, FS, DEFAULT_CONFIG,
    appendCrc, crcValid, encodePayload, frameTones, messageTones, synthesize,
    Receiver,
    samplesPerFrame: sampleRate => NSYM * sampleRate / BAUD,
    _internal: {decodeFrame, decodeRung, correlatePayload, analytic, fft, erf, gfskPulse},
  };
});
