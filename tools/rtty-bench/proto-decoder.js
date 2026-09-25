"use strict";
// Copy of RttyCodec.Decoder (data/rtty-codec.js) with one switch per candidate
// improvement. With every switch at its default the output must be identical,
// character for character, to the production decoder -- bench.js checks that
// before measuring anything.

const RttyCodec = require("../../data/rtty-codec.js");
const {firBandpass} = require("./channel.js");
const TABLE = RttyCodec.TABLE, CODE_FIGS = RttyCodec.CODE_FIGS, CODE_LTRS = RttyCodec.CODE_LTRS;

function goertzelMag(buf, n, coeff) {
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = buf[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

const DEFAULTS = {
  toneHz: 1500, shiftHz: RttyCodec.SHIFT_HZ, baud: RttyCodec.BAUD, reverse: false,
  squelchThreshold: 0,   // abs squelch (baseline semantics); 0 = never gates
  windowSize: 96, hopSize: 8,
  window: "rect",        // O4: 'rect' | 'hann'
  atcDecayBits: 16,      // O5: envelope decay (fldigi: 16 bits)
  decision: "diff",      // O5: 'diff' (m-s power) | 'atc' (W7AY optimal ATC) | 'markonly' | 'spaceonly'
  sample: "point",       // O3: 'point' | 'integrate'
  intFrac: 0.7,          //     integration window as a fraction of a bit
  stopCheck: false,      // O1: drop frames whose stop bit is SPACE
  startHold: 0,          // O2: start bit must stay SPACE for this fraction of a bit
  dpll: false,           // O7: predict the next start from the last good frame
  usos: false,           // O12: unshift on space
  confMin: 0,            // O11: suppress chars below this soft confidence (0..1)
  preBpf: 0,             // O9: FIR bandpass taps around mark/space (0 = off)
  preBpfHalfWidth: 150,  //     passband = centre +- this
  limiter: "none",       // O8: 'none' | 'clip' | 'nb'
  nbK: 5,                //     blanker threshold in running RMS
  sql: null,             // O6: null | {type:'snrmin'|'oob', thDb, hystDb}
};

class ProtoDecoder {
  constructor(sampleRate, opts = {}) {
    const o = this.o = Object.assign({}, DEFAULTS, opts);
    this.sampleRate = sampleRate;
    this.onChar = null;
    const n = o.windowSize;
    this.ring = new Float32Array(n);
    this.scratch = new Float32Array(n);
    this.win = null;
    if (o.window === "hann") {
      this.win = new Float32Array(n);
      for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / n);
    }
    this.ringPos = 0; this.ringCount = 0; this.samplesSinceHop = 0; this.totalSamples = 0;
    this.page = "L";
    this.squelchOpen = false;
    this.syncState = "searching";
    this.frameStartSample = 0; this.bitIndex = 0; this.dataBits = 0; this.prevBeta = 0;

    const markHz = o.toneHz + o.shiftHz / 2, spaceHz = o.toneHz - o.shiftHz / 2;
    this.cm = 2 * Math.cos(2 * Math.PI * markHz / sampleRate);
    this.cs = 2 * Math.cos(2 * Math.PI * spaceHz / sampleRate);
    this.spb = sampleRate / o.baud;
    this.hopsPerBit = this.spb / o.hopSize;

    // ATC state (fldigi rtty.cxx / W7AY), amplitudes
    this.markEnv = 0; this.spaceEnv = 0; this.noiseFloor = 0;

    // integrate-and-dump accumulators
    this.acc = 0; this.accN = 0; this.accNorm = 0;
    this.conf = 1;

    // DPLL
    this.expectStart = -1;

    // pre-BPF
    if (o.preBpf > 0) {
      const h = firBandpass(o.toneHz - o.preBpfHalfWidth, o.toneHz + o.preBpfHalfWidth, o.preBpf, sampleRate);
      this.bpfH = Float32Array.from(h);
      this.bpfBuf = new Float32Array(o.preBpf * 2);
      this.bpfPos = 0;
    }
    this.nbRms = 0.01; this.nbHang = 0;

    // O6 squelch
    if (o.sql) {
      this.sqSig = 0; this.sqNoise = 1e-12;
      this.sqAlpha = 1 / (this.hopsPerBit * 7.5);   // ~one character
      if (o.sql.type === "oob") {
        const lo = o.toneHz - 340, hi = o.toneHz + 340;
        this.co1 = 2 * Math.cos(2 * Math.PI * lo / sampleRate);
        this.co2 = 2 * Math.cos(2 * Math.PI * hi / sampleRate);
      }
      this.snrEstDb = -99;
    }
  }

  _pre(x) {
    const o = this.o;
    if (o.preBpf > 0) {
      const L = o.preBpf;
      this.bpfBuf[this.bpfPos] = x; this.bpfBuf[this.bpfPos + L] = x;
      this.bpfPos = (this.bpfPos + 1) % L;
      // newest sample is at bpfPos-1; buf[bpfPos .. bpfPos+L-1] is oldest..newest
      let acc = 0;
      const h = this.bpfH, b = this.bpfBuf, base = this.bpfPos;
      for (let j = 0; j < L; j++) acc += h[j] * b[base + L - 1 - j];
      x = acc;
    }
    if (o.limiter === "clip") {
      x = x > 0 ? 0.1 : x < 0 ? -0.1 : 0;
    } else if (o.limiter === "nb") {
      const a = Math.abs(x);
      if (a > o.nbK * this.nbRms) { this.nbHang = 24; }
      // track RMS on every sample, the pulse itself clipped to the threshold,
      // so the reference can never freeze while blanking
      const c = Math.min(a, o.nbK * this.nbRms);
      this.nbRms = Math.sqrt(this.nbRms * this.nbRms * 0.998 + c * c * 0.002);
      if (this.nbHang > 0) { this.nbHang--; x = 0; }
    }
    return x;
  }

  pushSamples(float32) {
    const o = this.o, n = o.windowSize, spb = this.spb;
    const custom = o.preBpf > 0 || o.limiter !== "none";
    for (let i = 0; i < float32.length; i++) {
      this.ring[this.ringPos] = custom ? this._pre(float32[i]) : float32[i];
      this.ringPos = (this.ringPos + 1) % n;
      if (this.ringCount < n) this.ringCount++;
      this.totalSamples++;
      this.samplesSinceHop++;
      if (this.ringCount < n || this.samplesSinceHop < o.hopSize) continue;
      this.samplesSinceHop = 0;

      const tailLen = n - this.ringPos;
      this.scratch.set(this.ring.subarray(this.ringPos), 0);
      this.scratch.set(this.ring.subarray(0, this.ringPos), tailLen);
      if (this.win) for (let k = 0; k < n; k++) this.scratch[k] *= this.win[k];
      const markMag = goertzelMag(this.scratch, n, this.cm);
      const spaceMag = goertzelMag(this.scratch, n, this.cs);
      this.lastMarkMag = markMag; this.lastSpaceMag = spaceMag;

      // ---- squelch ----
      if (o.sql) this._sqlUpdate(markMag, spaceMag);
      else this.squelchOpen = (markMag + spaceMag) >= o.squelchThreshold;

      // ---- decision variable ----
      let beta;
      const ma = Math.sqrt(markMag), sa = Math.sqrt(spaceMag);
      if (o.decision === "diff") beta = markMag - spaceMag;
      else beta = this._atc(ma, sa);
      if (o.reverse) beta = -beta;
      // soft value for integration + confidence: v / scale in [-1, 1]
      let v, scale;
      if (o.decision === "diff") { v = ma - sa; scale = ma + sa; }
      else if (o.decision === "envnorm") { v = beta; scale = 1; }
      else { v = beta; scale = Math.abs(beta) + this._atcScale(); }
      if (o.reverse) v = -v;

      const now = this.totalSamples;
      if (!this.squelchOpen) {
        this.syncState = "searching"; this.prevBeta = beta; this.expectStart = -1;
        continue;
      }
      this._sync(beta, v, scale, now, spb);
      this.prevBeta = beta;
    }
  }

  _sync(beta, v, scale, now, spb) {
    const o = this.o;
    if (this.syncState === "searching") {
      if (o.dpll && this.expectStart >= 0) {
        // blank edges inside the stop bit: they can only be noise
        if (now < this.expectStart - 0.5 * spb) return;
        if (this.prevBeta >= 0 && beta < 0) {
          const err = now - this.expectStart;
          const start = Math.abs(err) <= 0.5 * spb ? Math.round(this.expectStart + 0.5 * err) : now;
          this._beginFrame(start);
          return;
        }
        if (now >= this.expectStart + 0.5 * spb) {
          // flywheel: no clean edge, but the line is SPACE where the start
          // bit should be -> take the predicted start; MARK -> idle, give up
          if (beta < 0) { this._beginFrame(this.expectStart); }
          else this.expectStart = -1;
        }
        return;
      }
      if (this.prevBeta >= 0 && beta < 0) this._beginFrame(now);
      return;
    }

    // framing
    const bi = this.bitIndex;
    if (o.startHold > 0 && bi === 0 && now < this.frameStartSample + o.startHold * spb) {
      if (beta > 0) { this.syncState = "searching"; }   // edge did not hold
      return;
    }
    if (o.sample === "point") {
      const target = this.frameStartSample + Math.round((bi + 0.5) * spb);
      if (now >= target) this._bit(beta > 0, Math.abs(v) / (scale + 1e-20));
    } else {
      const half = o.intFrac * spb / 2;
      const c = this.frameStartSample + (bi + 0.5) * spb;
      if (now >= c - half) { this.acc += v; this.accN += scale; }
      if (now >= c + half) {
        const m = this.acc / (this.accN + 1e-20);
        this.acc = 0; this.accN = 0;
        this._bit(m > 0, Math.abs(m));
      }
    }
  }

  _beginFrame(start) {
    this.frameStartSample = start;
    this.syncState = "framing";
    this.bitIndex = 0; this.dataBits = 0; this.acc = 0; this.accN = 0; this.conf = 1;
  }

  _bit(isMark, conf) {
    const o = this.o, bi = this.bitIndex;
    if (bi === 0) {
      if (isMark) { this.syncState = "searching"; this.expectStart = -1; this.bitIndex++; return; }
      this.conf = Math.min(this.conf, conf);
    } else if (bi <= 5) {
      if (isMark) this.dataBits |= (1 << (bi - 1));
      this.conf = Math.min(this.conf, conf);
    } else {
      const spb = this.spb;
      this.syncState = "searching";
      if (o.stopCheck && !isMark) {           // framing error
        this.expectStart = -1;
        this.bitIndex++;
        return;
      }
      if (o.stopCheck) this.conf = Math.min(this.conf, conf);
      this.expectStart = o.dpll ? this.frameStartSample + 7.5 * spb : -1;
      this._emitCode(this.dataBits);
    }
    this.bitIndex++;
  }

  _atcScale() {
    const me = this.markEnv - this.noiseFloor, se = this.spaceEnv - this.noiseFloor;
    return 0.25 * (me * me + se * se) + 1e-20;
  }

  // fldigi rtty.cxx "optimal ATC" (Kok Chen W7AY), with its envelope/noise
  // decay constants scaled from per-sample to per-hop.
  _atc(m, s) {
    const hb = this.hopsPerBit;
    const env = (avg, v) => { const d = v > avg ? hb / 4 : hb * this.o.atcDecayBits; return avg + (v - avg) / d; };
    const nse = (avg, v) => { const d = v < avg ? hb / 4 : hb * 48; return avg + (v - avg) / d; };
    this.markEnv = env(this.markEnv, m);
    this.spaceEnv = env(this.spaceEnv, s);
    this.noiseFloor = nse(this.noiseFloor, Math.min(m, s));
    const nf = this.noiseFloor;
    const mc = Math.max(nf, Math.min(m, this.markEnv)), sc = Math.max(nf, Math.min(s, this.spaceEnv));
    const me = this.markEnv - nf, se = this.spaceEnv - nf;
    const d = this.o.decision;
    if (d === "envnorm") return (mc - nf) / (me + 1e-20) - (sc - nf) / (se + 1e-20);
    if (d === "markonly") return (mc - nf) - 0.5 * me;
    if (d === "spaceonly") return 0.5 * se - (sc - nf);
    return (mc - nf) * me - (sc - nf) * se - 0.25 * (me * me - se * se);
  }

  _sqlUpdate(m, s) {
    const q = this.o.sql, a = this.sqAlpha;
    let ratio;
    if (q.type === "oob") {
      const n1 = goertzelMag(this.scratch, this.o.windowSize, this.co1);
      const n2 = goertzelMag(this.scratch, this.o.windowSize, this.co2);
      this.sqSig += a * (Math.max(m, s) - this.sqSig);
      this.sqNoise += a * (0.5 * (n1 + n2) - this.sqNoise);
      ratio = this.sqSig / Math.max(this.sqNoise, 1e-20) / 1.5;      // noise alone -> ~1
    } else {
      this.sqSig += a * (Math.abs(m - s) - this.sqSig);
      this.sqNoise += a * (Math.min(m, s) - this.sqNoise);
      ratio = this.sqSig / Math.max(this.sqNoise, 1e-20) / 2;        // noise alone -> ~1
    }
    const db = 10 * Math.log10(Math.max(ratio, 1e-6));
    this.snrEstDb = db;
    const h = q.hystDb == null ? 1 : q.hystDb;
    this.squelchOpen = this.squelchOpen ? db >= q.thDb - h : db >= q.thDb;
  }

  _emitCode(code) {
    const o = this.o;
    if (code === CODE_FIGS) { this.page = "F"; return; }
    if (code === CODE_LTRS) { this.page = "L"; return; }
    const entry = TABLE[code];
    if (!entry) return;
    const ch = this.page === "F" ? entry[1] : entry[0];
    if (o.usos && code === 4) this.page = "L";
    if (ch === null || ch === undefined) return;
    if (o.confMin > 0 && this.conf < o.confMin) return;
    if (this.onChar) this.onChar(ch, {t: this.frameStartSample, conf: this.conf,
      snrEstDb: this.snrEstDb});
  }
}

// O10: several decoders side by side; for each character slot (chars whose
// frame starts lie within 2 bit periods of each other) keep the one with the
// highest soft confidence. Runs offline, so grouping after the fact is fine.
class MultiDecoder {
  constructor(sampleRate, optsList) {
    this.subs = optsList.map(o => new ProtoDecoder(sampleRate, o));
    this.events = [];
    this.spb = sampleRate / RttyCodec.BAUD;
    this.subs.forEach((d, k) => { d.onChar = (ch, m) => this.events.push({ch, t: m.t, conf: m.conf, k}); });
  }
  pushSamples(x) { for (const d of this.subs) d.pushSamples(x); }
  text() {
    const ev = this.events.slice().sort((a, b) => a.t - b.t);
    let out = "", i = 0;
    while (i < ev.length) {
      let best = ev[i], j = i + 1;
      while (j < ev.length && ev[j].t - ev[i].t < 2 * this.spb) {
        if (ev[j].conf > best.conf) best = ev[j];
        j++;
      }
      out += best.ch;
      i = j;
    }
    return out;
  }
}

module.exports = {ProtoDecoder, MultiDecoder, DEFAULTS};
