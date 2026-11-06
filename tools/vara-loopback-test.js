#!/usr/bin/env node
"use strict";
// Two XARA HF stations (data/vara-modem.js) linked through a WIFILT-like audio
// path: TX at 48 kHz -> 8 kHz (as AUD1 RX delivers it) -> G.711 mu-law -> AWGN
// -> back up to 48 kHz. Connects, moves a payload one way, disconnects, and
// prints the levels reached and the throughput. No upstream checkout needed.
// docs/vara-implementace.md §4 phase 2 (mu-law risk).
//
//   node tools/vara-loopback-test.js                    the default matrix
//   node tools/vara-loopback-test.js 2300 20 8000 ulaw  bw snr_db bytes path(wire|ulaw)
//   node tools/vara-loopback-test.js 2300 20 8000 ulaw 600 [p2p]
//        ... plus a one-way audio path delay in ms (AUD1 prebuffer + LAN + WiFi),
//        which each station is told about as its txLatency; "p2p" for P2P timing

const M = require("../data/vara-modem.js");

// windowed-sinc lowpass, 48 kHz, cutoff 3.6 kHz (passes the 2750 Hz band)
function lowpass(n, fc, fs) {
  const h = new Float64Array(n), m = (n - 1) / 2;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m, w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1));
    h[i] = (x === 0 ? 2 * fc / fs : Math.sin(2 * Math.PI * fc / fs * x) / (Math.PI * x)) * w;
    s += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= s;
  return h;
}
const H = lowpass(193, 3600, 48000);
function ulaw(x) { // G.711 mu-law round trip on a 16-bit sample
  const BIAS = 0x84, CLIP = 32635;
  let s = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let m = 0x4000; (s & m) === 0 && exp > 0; m >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0F, u = ~(sign | (exp << 4) | mant) & 0xFF;
  const v = ~u & 0xFF, e = (v >> 4) & 7, mm = v & 0x0F;
  let t = ((mm << 3) + BIAS) << e;
  t -= BIAS;
  return ((v & 0x80) ? -t : t) / 32767;
}
class Channel {
  constructor(path, snrDb, seed) {
    this.path = path; this.snr = snrDb; this.hist = new Float64Array(H.length); this.hp = 0; this.phase = 0;
    this.up = new Float64Array(H.length); this.s = seed >>> 0 || 1; this.sig = 1e-12; this.n = 0;
  }
  rand() { this.s ^= this.s << 13; this.s >>>= 0; this.s ^= this.s >>> 17; this.s ^= this.s << 5; this.s >>>= 0; return this.s / 4294967296; }
  gauss() { const u = Math.max(this.rand(), 1e-12), v = this.rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  run(x) {
    if (this.path === "wire") return x;
    const out = new Float64Array(x.length);
    // noise at a fixed level: SNR against the stations' typical TX rms (-5 dB drive, ~-14 dBFS rms)
    const noise = Math.pow(10, -14 / 20) * Math.pow(10, -this.snr / 20) * Math.sqrt(48000 / 3000 / 2);
    for (let i = 0; i < x.length; i++) {
      this.hist[this.hp] = x[i]; this.hp = (this.hp + 1) % H.length;
      if (++this.phase === 6) {
        this.phase = 0;
        let y = 0;
        for (let k = 0; k < H.length; k++) y += H[k] * this.hist[(this.hp + k) % H.length];
        y += noise * this.gauss() / Math.sqrt(6);
        y = ulaw(y);
        this.upPush(y * 6);
      } else this.upPush(0);
      let z = 0;
      for (let k = 0; k < H.length; k++) z += H[k] * this.up[(this.up.p + k) % H.length];
      out[i] = z;
    }
    return out;
  }
  upPush(v) { this.up.p = this.up.p || 0; this.up[this.up.p] = v; this.up.p = (this.up.p + 1) % H.length; }
}

function run(bwHz, snr, bytes, path, delayMs = 0, p2p = false) {
  const bw = M.bandwidth(bwHz);
  const ca = M.hfConfig(bw, "N0CALL"), cb = M.hfConfig(bw, "N1CALL");
  ca.host.registered = true; ca.host.compression = M.COMP.OFF;
  if (p2p) { ca.p2p = true; cb.p2p = true; }
  // The delay is what a station hears of its own transmission: TX path + RX
  // path. The simulated wire puts all of it on one hop, which the far station
  // sees exactly as it would (its reply timing only depends on the sum).
  const lat = Math.round(delayMs * 48), blocks = 2 + Math.round(lat / 480);
  const opts = {driveDb: -5, txLatency: lat, rxLag: lat};
  const st = [new M.HfStation(ca, opts), new M.HfStation(cb, opts)];
  const ch = [new Channel(path, snr, 7), new Channel(path, snr, 11)];
  const wire = [0, 1].map(() => Array.from({length: blocks}, () => new Float64Array(480)));
  const log = [[], []], got = [];
  let levels = [], t0 = null, t1 = null;
  const data = Uint8Array.from({length: bytes}, (_, i) => (i * 7919 + 13) & 255);
  const drain = (i, now) => {
    let r;
    while ((r = st[i].pop())) {
      if (r.kind === "host") {
        log[i].push(r.ev.kind);
        if (r.ev.kind === "data") { got.push(...r.ev.data); if (got.length >= bytes && t1 === null) t1 = now; }
        if (r.ev.kind === "connected" && i === 0) { t0 = now; st[0].send(data); }
      } else if (r.kind === "bitrate" && r.tx && i === 0) levels.push(r.level);
    }
  };
  st[0].connect("N0CALL", "N1CALL", []);
  const limit = 48000 * Math.max(240, bytes / 20);
  let now = 0;
  const started = Date.now();
  while (now < limit) {
    for (let i = 0; i < 2; i++) {
      const out = new Float64Array(480);
      st[i].process(ch[1 - i].run(wire[1 - i].shift()), out);
      wire[i].push(out);
      drain(i, now);
    }
    now += 480;
    if (t1 !== null && st[0].state === "Idle") { st[0].disconnect(); }
    if (t1 !== null && log[0].includes("disconnected") && log[1].includes("disconnected")) break;
  }
  const ok = got.length === bytes && got.every((b, i) => b === data[i]);
  const secs = t1 !== null ? (t1 - t0) / 48000 : NaN;
  return {bw: bwHz, snr, bytes, path, delayMs, p2p, ok, connected: t0 !== null, secs: +secs.toFixed(1), bps: Math.round(bytes * 8 / secs),
    top: levels.length ? Math.max(...levels) : 0, disc: log[0].includes("disconnected") && log[1].includes("disconnected"),
    cpu: +((Date.now() - started) / 1000 / (now / 48000)).toFixed(2)};
}

const args = process.argv.slice(2);
const matrix = args.length ? [[+args[0], +args[1], +args[2], args[3] || "ulaw", +(args[4] || 0), args[5] === "p2p"]]
  : [[2300, 40, 8000, "wire"], [2300, 40, 8000, "ulaw"], [2300, 20, 8000, "ulaw"], [2750, 40, 8000, "ulaw"], [500, 30, 2000, "ulaw"]];
let fail = 0;
for (const [bw, snr, bytes, path, delayMs, p2p] of matrix) {
  const r = run(bw, snr, bytes, path, delayMs, p2p);
  console.log((r.ok && r.disc ? "ok   " : "FAIL ") + JSON.stringify(r));
  if (!r.ok || !r.disc) fail++;
}
process.exit(fail ? 1 : 0);
