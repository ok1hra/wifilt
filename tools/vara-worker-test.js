#!/usr/bin/env node
"use strict";
// data/vara-worker.js against a simulated WIFILT firmware and radio pair.
//
// Two VaraCore instances, each with its own fake AUD1 session. The fake
// enforces what the firmware enforces on an AUD1 transmission
// (wifilt.ino aud1HandleControl / aud1AcceptTxPacket / aud1TxTick):
// tx.prepare limits, packet identity and continuity, FIRST/LAST against the
// declared totals, tx.extend, the prebuffer at the slot and a TX ring that
// must never run dry once keyed. What it plays goes "on the air" at 8 kHz
// mu-law after a radio delay; each radio hears the other's air (silence while
// it transmits itself) and hands it to its worker as 20 ms RX packets after an
// RX delay, with Wi-Fi style bunching and the odd lost packet.
//
//   node tools/vara-worker-test.js            the matrix below
//   VERBOSE=1 node tools/vara-worker-test.js  plus the host lines and TX events

const M = require("../data/vara-modem.js");
const H = require("../data/vara-host.js");
const {VaraCore} = require("../data/vara-worker.js");

const VERBOSE = process.env.VERBOSE === "1";
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? "ok   " : "FAIL ") + name + (detail ? "  " + detail : ""));
  if (!ok) failures++;
};

function ulaw(x) { // G.711 round trip, as the firmware/radio path does
  const BIAS = 0x84, CLIP = 32635;
  let s = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let m = 0x4000; (s & m) === 0 && exp > 0; m >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0F, v = (sign | (exp << 4) | mant) & 0xFF;
  let t = ((((v & 0x0F) << 3) + BIAS) << ((v >> 4) & 7)) - BIAS;
  return ((v & 0x80) ? -t : t) / 32768;
}

class Rng {
  constructor(seed) { this.s = seed >>> 0 || 1; }
  next() { this.s ^= this.s << 13; this.s >>>= 0; this.s ^= this.s >>> 17; this.s ^= this.s << 5; this.s >>>= 0; return this.s / 4294967296; }
  gauss() { const u = Math.max(this.next(), 1e-12), v = this.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
}

// ---- the fake firmware: one AUD1 session's TX side ---------------------------
class FakeAud1 {
  constructor(name, sim) {
    this.name = name; this.sim = sim; this.hello = {streamId: 0x51 + name.charCodeAt(0)};
    this.tx = null; this.status = null; this.errors = []; this.transmissions = 0; this.keyedMs = 0;
  }
  error(reason) {
    this.errors.push(reason);
    if (VERBOSE) console.log(`  [${this.name}] firmware: ${reason}`);
    if (this.tx) this.tx.dead = true;
    this.tx = null;
  }
  prepare(txId, m) {
    const delay = m.slotUtcMs - this.sim.nowMs;
    if (!(m.samples > 0 && m.packets > 0 && m.prebufferSamples > 0 && m.prebufferSamples <= m.samples &&
          m.prebufferSamples <= 12288 * 6 && m.packetMs === 20 && delay >= 100 && delay <= 35000)) {
      this.error("invalid tx.prepare"); return Promise.reject(new Error("invalid tx.prepare"));
    }
    if (this.tx && !this.tx.drained) this.error("new TX replaced active TX");
    this.tx = {txId, total: m.samples, packets: m.packets, prebuffer: m.prebufferSamples, slotMs: m.slotUtcMs,
      expSample: 0, expSeq: 0, received: 0, last: false, ring: [], keyed: false, played: 0, drained: false};
    this.transmissions++;
    return Promise.resolve(true);
  }
  begin() {}
  end() {}
  complete() {}
  abort(txId, reason) { if (this.tx && this.tx.txId === txId) { this.tx = null; if (VERBOSE) console.log(`  [${this.name}] abort ${reason}`); } }
  sendControl(msg) {
    if (msg.type !== "tx.extend") return;
    const t = this.tx;
    if (!t || t.txId !== msg.txId) return;
    if (!(msg.samples > 0 && msg.samples % 6 === 0 && msg.packets <= Math.floor((msg.samples + 959) / 960) + 1)) { this.error("invalid tx.extend"); return; }
    t.total += msg.samples; t.packets += msg.packets;
  }
  write(wire) {
    const t = this.tx;
    const v = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
    if (!t) return; // dropped quietly, like the firmware after a fault
    const flags = v.getUint16(6), first = (flags & 1) !== 0, last = (flags & 2) !== 0;
    const samples = (wire.length - 40) / 2;
    const ok = String.fromCharCode(...wire.subarray(0, 4)) === "AUD1" && wire[5] === 3 &&
      v.getUint32(12) === this.hello.streamId && v.getUint32(16) === t.expSeq && v.getUint32(20) === 48000 &&
      Number(v.getBigUint64(24)) === t.expSample && v.getUint32(32) === t.txId && samples % 6 === 0 && samples > 0;
    if (!ok) { this.error("TX packet identity/continuity failure"); return; }
    if ((t.expSeq === 0) !== first || t.expSample + samples > t.total || t.received + 1 > t.packets ||
        (last && (t.expSample + samples !== t.total || t.received + 1 !== t.packets)) ||
        (!last && t.received + 1 === t.packets)) { this.error("TX FIRST/LAST/length/buffer failure"); return; }
    for (let i = 0; i < samples; i += 6) t.ring.push(v.getInt16(40 + i * 2, true) / 32768);
    if (t.ring.length > 12288) { this.error("TX ring overflow"); return; }
    t.expSample += samples; t.expSeq++; t.received++; t.last = last;
  }
  // one 8 kHz sample period of the firmware's playout; returns the sample
  // handed to the radio, or null while not keyed
  play() {
    const t = this.tx;
    if (!t) return null;
    if (!t.keyed) {
      if (this.sim.nowMs < t.slotMs) return null;
      if (t.expSample < t.prebuffer) {
        if (this.sim.nowMs - t.slotMs > 100) this.error("TX prebuffer missed slot");
        return null;
      }
      t.keyed = true;
    }
    if (t.played * 6 >= t.total) {
      t.drained = true; this.tx = null;
      if (this.status) this.status({type: "tx-drained", txId: t.txId});
      return null;
    }
    if (!t.ring.length) { this.error("TX underrun"); return null; }
    t.played++; this.keyedMs += 1 / 8;
    return t.ring.shift();
  }
}

// ---- the radios and the air ---------------------------------------------------
function run(name, o) {
  const sim = {nowMs: 0};
  const rng = new Rng(o.seed || 5);
  const stations = ["A", "B"].map((n, i) => {
    // `o.b` overrides the path of station B alone: a fast answerer stands in
    // for a VARA station on a sound card (an RMS gateway, say).
    const p = Object.assign({rxDelayMs: 60, radioTxDelayMs: 40, slotMs: 200, prebufferMs: 120}, o, i === 1 ? o.b || {} : {});
    const aud1 = new FakeAud1(n, sim);
    const inbox = {lines: [], data: [], tx: [], events: []};
    const call = i === 0 ? "N0CALL" : "N1CALL";
    const latencyMs = p.latencyMs ?? (p.rxDelayMs + p.slotMs + p.radioTxDelayMs);
    const core = new VaraCore({M, H, aud1, wallNow: () => sim.nowMs, monoNow: () => sim.nowMs,
      post: msg => {
        if (msg.type === "line") { inbox.lines.push(msg.line); if (VERBOSE) console.log(`  [${n}] < ${msg.line}`); }
        else if (msg.type === "data") inbox.data.push(...msg.bytes);
        else if (msg.type === "tx") { inbox.tx.push(msg); if (VERBOSE && msg.kind !== "tx-start") console.log(`  [${n}] ${msg.kind} ${JSON.stringify(msg)}`); }
        else if (msg.type === "event") inbox.events.push(msg.kind);
      }},
      {mycall: call, bw: o.bw || 2300, latencyMs, slotMs: p.slotMs, prebufferMs: p.prebufferMs,
        p2p: o.p2p !== false, listen: i === 1});
    return {n, aud1, core, inbox, air: new Float32Array(8000 * (o.seconds + 5)), rxQueue: [], held: 0, t8: 1000 + i * 37,
      rxDelay8: Math.round(p.rxDelayMs * 8), txDelay8: Math.round(p.radioTxDelayMs * 8)};
  });
  const noise = Math.pow(10, -(o.noiseDb ?? 45) / 20);
  const totalMs = o.seconds * 1000;
  let t8 = 0;
  const script = o.script(stations);
  for (sim.nowMs = 0; sim.nowMs < totalMs; sim.nowMs += 20) {
    for (const s of stations) {
      for (let k = 0; k < 160; k++) {
        const v = s.aud1.play();
        if (v !== null) s.air[t8 + k + s.txDelay8] = v;
      }
    }
    for (let i = 0; i < 2; i++) {
      const s = stations[i], other = stations[1 - i];
      // the radio's own RX: the other station's air, silent while this one is keyed
      const start = t8 - s.rxDelay8;
      if (start >= 0) {
        const pkt = new Float32Array(160);
        for (let k = 0; k < 160; k++) {
          const own = s.air[start + k] !== 0;
          pkt[k] = own ? 0 : ulaw(other.air[start + k] + noise * rng.gauss());
        }
        s.rxQueue.push({samples: pkt, meta: {firstSample: BigInt(s.t8 + start)}});
      }
      // Wi-Fi: now and then a packet is lost, and deliveries bunch up
      if (o.jitter && rng.next() < 0.02) s.held = 1 + Math.floor(rng.next() * (o.jitter / 20));
      if (o.loss && s.rxQueue.length && rng.next() < o.loss) s.rxQueue.shift();
      if (s.held > 0) s.held--;
      else while (s.rxQueue.length) { const p = s.rxQueue.shift(); s.core.onRx(p.samples, p.meta); }
      s.core.tick();
    }
    t8 += 160;
    script(sim.nowMs);
  }
  return stations;
}

function ascii(bytes) { return Buffer.from(bytes).toString("latin1"); }

function chat(name, o, expectFail) {
  const msgA = "Hello from A over XARA, WIFILT worker test. ".repeat(o.repeat || 4);
  const msgB = "Reply from B. ".repeat(o.repeat || 4);
  let connectedAt = null, phase = 0;
  const st = run(name, Object.assign({seconds: 240}, o, {script: stations => now => {
    const [a, b] = stations;
    if (now === 2000) a.core.command("CONNECT N0CALL N1CALL");
    if (phase === 0 && a.inbox.lines.some(l => l.startsWith("CONNECTED"))) {
      phase = 1; connectedAt = now; a.core.send(new TextEncoder().encode(msgA));
    }
    if (phase === 1 && ascii(b.inbox.data) === msgA) { phase = 2; b.core.send(new TextEncoder().encode(msgB)); }
    if (phase === 2 && ascii(a.inbox.data) === msgB) { phase = 3; a.core.command("DISCONNECT"); }
  }}));
  const [a, b] = st;
  if (expectFail) {
    check(`${name}: does not connect (known limit)`, connectedAt === null);
    return st;
  }
  const discA = a.inbox.lines.includes("DISCONNECTED"), discB = b.inbox.lines.includes("DISCONNECTED");
  check(`${name}: connects`, connectedAt !== null);
  check(`${name}: A -> B text`, ascii(b.inbox.data) === msgA, `${b.inbox.data.length}/${msgA.length} B`);
  check(`${name}: B -> A text`, ascii(a.inbox.data) === msgB, `${a.inbox.data.length}/${msgB.length} B`);
  check(`${name}: disconnects`, discA && discB);
  for (const s of st) {
    const errs = s.aud1.errors.filter(e => !(o.allow || []).includes(e));
    check(`${name}: ${s.n} firmware accepted every transmission`, errs.length === 0,
      `${s.aud1.transmissions} TX, ${(s.aud1.keyedMs / 1000).toFixed(1)} s keyed${errs.length ? ", " + errs.join("; ") : ""}`);
  }
  return st;
}

// ---- matrix -----------------------------------------------------------------
const only = process.argv[2];
// Winlink timing gives the answerer ~200 ms to reply (Timing base 438 ticks):
// fine when the far end is a sound-card VARA station, too tight for two
// stations that both have WIFILT's ~300 ms audio round trip.
const cases = [
  ["p2p, clean path", {p2p: true}],
  ["winlink timing, fast answerer", {p2p: false, b: {rxDelayMs: 20, radioTxDelayMs: 20, slotMs: 100, prebufferMs: 60}}],
  ["winlink timing, both through WIFILT", {p2p: false, seconds: 60}, true],
  ["p2p, wifi jitter 120 ms + 1% loss", {p2p: true, jitter: 120, loss: 0.01, seed: 9}],
  ["p2p, bw 500", {p2p: true, bw: 500, repeat: 1}],
];
for (const [name, o, expectFail] of cases) if (!only || name.includes(only)) chat(name, o, expectFail);

// Keyed stretches map 1:1 onto transmissions: what one station keyed for is
// what the firmware played, to the 20 ms packet.
{
  const st = run("tune", {seconds: 6, script: stations => now => {
    if (now === 1000) stations[0].core.tune(true);
    if (now === 3000) stations[0].core.tune(false);
  }});
  const a = st[0];
  check("tune: one transmission, about 2 s keyed", a.aud1.transmissions === 1 && Math.abs(a.aud1.keyedMs - 2000) < 100,
    `${a.aud1.transmissions} TX, ${a.aud1.keyedMs.toFixed(0)} ms`);
  check("tune: firmware accepted it", a.aud1.errors.length === 0, a.aud1.errors.join("; "));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
