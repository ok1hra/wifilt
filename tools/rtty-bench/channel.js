"use strict";
// RTTY test-bench signal generator + HF channel models. Offline only -- never
// loaded by data/. Everything is seeded so a (channel, x, seed) triple always
// produces the same audio.

const RttyCodec = require("../../data/rtty-codec.js");

const FS = 8000;
const BAUD = RttyCodec.BAUD, SHIFT = RttyCodec.SHIFT_HZ;
const CENTRE = 1500;
const TARGET_RMS = 0.1;   // radio AGC stand-in: signal+noise always at -20 dBFS

// ---- seeded PRNG ----------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0 || 1;
  const next = () => {           // mulberry32
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  next.gauss = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while (u === 0) u = next();
    v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return next;
}

// ---- traffic text ---------------------------------------------------------
const PREFIXES = ["OK1", "OK2", "OL5", "DL1", "DL8", "G4", "F5", "SP9", "S5", "HA8",
  "YO3", "UA3", "EA7", "I2", "OH2", "SM5", "LY2", "9A1", "OE3", "YL2", "K1", "W3", "VE3"];
function callsign(r) {
  const p = PREFIXES[Math.floor(r() * PREFIXES.length)];
  const n = 2 + Math.floor(r() * 2);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(65 + Math.floor(r() * 26));
  return p + s;
}
function serial(r) { return String(1 + Math.floor(r() * 999)).padStart(3, "0"); }

// Realistic contest/QSO overs. Each element is one "over" -- an idle MARK gap
// separates overs, like real RTTY traffic.
function trafficOvers(r, minChars) {
  const overs = [];
  let total = 0;
  while (total < minChars) {
    const a = callsign(r), b = callsign(r), nr = serial(r);
    const kind = Math.floor(r() * 5);
    let t;
    if (kind === 0) t = `CQ TEST ${a} ${a} CQ`;
    else if (kind === 1) t = `${a} 599 ${nr} ${nr} ${b}`;
    else if (kind === 2) t = `TU ${nr} 599 ${a} TEST`;
    else if (kind === 3) t = `${b} DE ${a} UR RST 599 599 NAME JAN QTH PRAHA/${nr} BK`;
    else t = `QRZ? ${a} 5NN ${nr} ${nr} GL`;
    t = " " + t + " ";            // leading/trailing space, as loggers send
    overs.push(t);
    total += t.length;
  }
  return overs;
}

// Frames for one over, continuing `page`. txUsos: re-send FIGS after a space
// when the next char is a figure (what MMTTY/N1MM/fldigi TX do, so a USOS
// receiver never mis-shifts); our own RttyCodec.Encoder does NOT do this.
function overToFrames(text, page, txUsos) {
  const chars = RttyCodec.textToBaudot(text);
  const frames = [];
  let lastWasSpace = false;
  for (const {code, page: want} of chars) {
    if (want && (want !== page || (txUsos && lastWasSpace && want === "F"))) {
      frames.push(want === "F" ? RttyCodec.CODE_FIGS : RttyCodec.CODE_LTRS);
      page = want;
    }
    frames.push(code);
    lastWasSpace = code === 4;
  }
  return {frames, page};
}

// Expected decoded text (what a perfect decoder prints): the overs joined,
// with characters that have no Baudot mapping dropped.
function expectedText(overs) {
  return overs.map(o => RttyCodec.textToBaudot(o).map(c => {
    const e = RttyCodec.TABLE[c.code];
    return c.page === "F" ? e[1] : e[0];
  }).join("")).join("");
}

// Continuous-phase 2FSK exactly like RttyCodec.Encoder (same floor
// accumulator), but returning float samples plus a per-sample tone flag
// (1 = mark, 0 = space) so the channel can fade each tone on its own.
// segments: array of {mark:bool, units:number}.
function fskSegments(frames, idleUnitsBefore = []) {
  const segs = [];
  frames.forEach((code, i) => {
    if (idleUnitsBefore[i]) segs.push({mark: true, units: idleUnitsBefore[i]});
    segs.push({mark: false, units: 1});
    for (let b = 0; b < 5; b++) segs.push({mark: ((code >> b) & 1) === 1, units: 1});
    segs.push({mark: true, units: 1.5});
  });
  return segs;
}

function synthFsk(segs, {toneHz = CENTRE, baud = BAUD, amp = 0.5, fs = FS, startPhase = 0} = {}) {
  const spb = fs / baud;
  const bounds = [0];
  let cum = 0;
  for (const s of segs) { cum += s.units; bounds.push(Math.floor(cum * spb)); }
  const n = bounds[bounds.length - 1];
  const out = new Float32Array(n), mark = new Uint8Array(n);
  const hi = toneHz + SHIFT / 2, lo = toneHz - SHIFT / 2;
  let phase = startPhase, k = 0;
  for (let i = 0; i < segs.length; i++) {
    const dphi = 2 * Math.PI * (segs[i].mark ? hi : lo) / fs;
    for (; k < bounds[i + 1]; k++) {
      out[k] = amp * Math.sin(phase);
      mark[k] = segs[i].mark ? 1 : 0;
      phase += dphi;
    }
    if (phase > 1e6) phase %= 2 * Math.PI;
  }
  return {pcm: out, mark, phaseTrack: null};
}

// Same as synthFsk but keeps the running phase per sample so a complex fading
// gain can be applied to each tone as |g|*sin(phase + arg g).
function synthFskPhase(segs, {toneHz = CENTRE, baud = BAUD, fs = FS} = {}) {
  const spb = fs / baud;
  const bounds = [0];
  let cum = 0;
  for (const s of segs) { cum += s.units; bounds.push(Math.floor(cum * spb)); }
  const n = bounds[bounds.length - 1];
  const phase = new Float64Array(n), mark = new Uint8Array(n);
  const hi = toneHz + SHIFT / 2, lo = toneHz - SHIFT / 2;
  let ph = 0, k = 0;
  for (let i = 0; i < segs.length; i++) {
    const dphi = 2 * Math.PI * (segs[i].mark ? hi : lo) / fs;
    for (; k < bounds[i + 1]; k++) { phase[k] = ph; mark[k] = segs[i].mark ? 1 : 0; ph += dphi; }
    if (ph > 1e6) ph %= 2 * Math.PI;
  }
  return {phase, mark, n};
}

// ---- noise / channel pieces -----------------------------------------------
function firBandpass(lowHz, highHz, taps, fs = FS) {
  const h = new Float64Array(taps), m = (taps - 1) / 2;
  for (let i = 0; i < taps; i++) {
    const t = i - m;
    const lp = f => t === 0 ? 2 * f / fs : Math.sin(2 * Math.PI * f / fs * t) / (Math.PI * t);
    const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1));
    h[i] = (lp(highHz) - lp(lowHz)) * w;
  }
  return h;
}
function convolve(x, h) {
  const n = x.length, t = h.length, m = (t - 1) >> 1;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const j0 = Math.max(0, i + m - n + 1), j1 = Math.min(t, i + m + 1);
    for (let j = j0; j < j1; j++) acc += h[j] * x[i + m - j];
    y[i] = acc;
  }
  return y;
}

// Receiver-passband noise (300-2700 Hz, the radio's SSB/DATA filter), unit
// power -- so an SNR in 2500 Hz is literally signal power / noise power.
function bandNoise(n, r) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = r.gauss();
  const y = convolve(w, firBandpass(300, 2700, 129));
  let p = 0;
  for (let i = 0; i < n; i++) p += y[i] * y[i];
  const k = 1 / Math.sqrt(p / n);
  for (let i = 0; i < n; i++) y[i] *= k;
  return y;
}

// Complex Rayleigh process, Gaussian Doppler spectrum (Watterson), unit mean
// power, by sum of sinusoids. spreadHz = two-sigma Doppler spread (CCIR).
function rayleigh(n, spreadHz, r, fs = FS) {
  const M = 24, sigma = spreadHz / 2;
  const f = [], th1 = [], th2 = [];
  for (let k = 0; k < M; k++) { f.push(r.gauss() * sigma); th1.push(2 * Math.PI * r()); th2.push(2 * Math.PI * r()); }
  const re = new Float32Array(n), im = new Float32Array(n);
  const step = 16;                          // evaluate every 2 ms, interpolate
  const s = 1 / Math.sqrt(M);
  let pr = 0, pi = 0, lr = 0, li = 0;
  for (let i = 0; i <= n + step; i += step) {
    let a = 0, b = 0;
    const t = i / fs;
    for (let k = 0; k < M; k++) {
      const ph = 2 * Math.PI * f[k] * t;
      a += Math.cos(ph + th1[k]); b += Math.sin(ph + th2[k]);
    }
    a *= s; b *= s;
    if (i > 0) for (let j = i - step; j < i && j < n; j++) {
      const u = (j - (i - step)) / step;
      re[j] = lr + (a - lr) * u; im[j] = li + (b - li) * u;
    }
    lr = a; li = b;
  }
  void pr; void pi;
  return {re, im};
}

// G.711 mu-law, matching data/js8-aud1.js's decode table exactly.
const ULAW_DEC = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  let s = (((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 7);
  s -= 0x84;
  ULAW_DEC[i] = ((u & 0x80) ? -s : s) / 32768;
}
function ulawEncode(sample16) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (sample16 >> 8) & 0x80;
  if (sign) sample16 = -sample16;
  if (sample16 > CLIP) sample16 = CLIP;
  sample16 += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (sample16 & mask) === 0 && exp > 0; exp--, mask >>= 1);
  const mant = (sample16 >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}
function ulawRoundTrip(x) {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
    y[i] = ULAW_DEC[ulawEncode(s)];
  }
  return y;
}

// ---- scenario builder -----------------------------------------------------
// channel: {kind:'awgn'|'fade'|'impulse'|'qrm'|'cw'|'noise', snrDb, spreadHz,
//           toneOffsetHz, baudErr, qrmOffsetHz, qrmRelDb, cwOffsetHz, cwRelDb,
//           impulseRate, impulseRelDb, gain, seconds}
// Returns {samples, expected, durationSec}.
function buildScenario(channel, seed, {minChars = 600} = {}) {
  const r = rng(seed * 7919 + 13);
  const ch = Object.assign({kind: "awgn", snrDb: 0, spreadHz: 1, toneOffsetHz: 0,
    baudErr: 0, gain: 1}, channel);

  let sig = null, expected = "", n;
  if (ch.kind === "noise") {
    n = Math.round((ch.seconds || 300) * FS);
  } else {
    const overs = trafficOvers(r, minChars);
    expected = expectedText(overs);
    let page = "L";
    const frames = [], idle = [];
    // 0.4 s lead-in idle, 0.2-1.2 s idle between overs
    overs.forEach((o, i) => {
      const res = overToFrames(o, page, true);
      page = res.page;
      res.frames.forEach((f, j) => {
        frames.push(f);
        idle.push(j === 0 ? (i === 0 ? 0.4 : 0.2 + r()) * BAUD : 0);
      });
    });
    const segs = fskSegments(frames, idle);
    segs.push({mark: true, units: 0.5 * BAUD});     // tail idle
    const baud = BAUD * (1 + ch.baudErr);
    const toneHz = CENTRE + ch.toneOffsetHz;
    const {phase, mark, n: len} = synthFskPhase(segs, {toneHz, baud});
    n = len;
    sig = new Float32Array(n);
    const amp = Math.sqrt(2);                         // unit signal power
    if (ch.kind === "fade") {
      const gm = rayleigh(n, ch.spreadHz, r), gs = rayleigh(n, ch.spreadHz, r);
      for (let i = 0; i < n; i++) {
        const g = mark[i] ? gm : gs;
        // Re{g e^{j phase}} expressed via sin: |g| sin(phase + arg g)
        sig[i] = amp * (g.re[i] * Math.sin(phase[i]) + g.im[i] * Math.cos(phase[i]));
      }
    } else {
      for (let i = 0; i < n; i++) sig[i] = amp * Math.sin(phase[i]);
    }
  }

  const noise = bandNoise(n, r);
  const out = new Float32Array(n);
  const sAmp = sig ? Math.pow(10, ch.snrDb / 20) : 0;   // signal RMS vs unit noise
  for (let i = 0; i < n; i++) out[i] = noise[i] + (sig ? sAmp * sig[i] : 0);

  if (ch.kind === "qrm" || ch.kind === "qrmnoise") {
    // An independent RTTY station, its own random traffic and timing, sending
    // continuously, qrmOffsetHz from our centre, qrmRelDb vs our signal.
    const r2 = rng(seed * 104729 + 7);
    const overs = trafficOvers(r2, Math.ceil(minChars * 1.6));
    let page = "L";
    const frames = [];
    for (const o of overs) { const res = overToFrames(o, page, true); page = res.page; frames.push(...res.frames); }
    const segs = fskSegments(frames, frames.map((_, i) => i === 0 ? 0.1 * BAUD : 0));
    const q = synthFsk(segs, {toneHz: CENTRE + ch.qrmOffsetHz, baud: BAUD * 1.002, amp: Math.sqrt(2), startPhase: 1});
    const qa = sAmp * Math.pow(10, ch.qrmRelDb / 20);
    for (let i = 0; i < n && i < q.pcm.length; i++) out[i] += qa * q.pcm[i];
  }
  if (ch.kind === "cw") {
    const ca = sAmp * Math.pow(10, ch.cwRelDb / 20) * Math.sqrt(2);
    // cwSweep: the carrier glides from MARK+20 to MARK+260 Hz over the whole
    // run, so no window length is rewarded for a null that happens to sit
    // on one fixed carrier frequency
    let ph = 0.3;
    for (let i = 0; i < n; i++) {
      const f = ch.cwSweep ? CENTRE + SHIFT / 2 + 20 + 240 * i / n : CENTRE + ch.cwOffsetHz;
      ph += 2 * Math.PI * f / FS;
      out[i] += ca * Math.sin(ph);
    }
  }

  // AGC stand-in: total (signal + gaussian noise) to TARGET_RMS
  let p = 0;
  for (let i = 0; i < n; i++) p += out[i] * out[i];
  const k = TARGET_RMS * ch.gain / Math.sqrt(p / n);
  for (let i = 0; i < n; i++) out[i] *= k;

  if (ch.kind === "impulse") {
    // Static crashes: Poisson arrivals, each a ~1 ms decaying wideband burst
    // peaking impulseRelDb above the noise RMS (after AGC -- the AGC is too
    // slow to follow a crash). Clipped at full scale like a real sound path.
    const noiseRms = k;                                // unit noise * k
    const peak = noiseRms * Math.pow(10, (ch.impulseRelDb || 26) / 20);
    const rate = ch.impulseRate || 8;
    let t = 0;
    for (;;) {
      t += -Math.log(1 - r()) / rate * FS;
      const i0 = Math.floor(t);
      if (i0 >= n) break;
      for (let j = 0; j < 40 && i0 + j < n; j++)
        out[i0 + j] += peak * Math.exp(-j / 8) * r.gauss();
    }
  }
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, out[i]));

  return {samples: ulawRoundTrip(out), expected, durationSec: n / FS};
}

module.exports = {FS, BAUD, SHIFT, CENTRE, TARGET_RMS, rng, trafficOvers, overToFrames,
  expectedText, fskSegments, synthFsk, synthFskPhase, buildScenario, firBandpass, convolve,
  ulawRoundTrip, ulawEncode, ULAW_DEC};
