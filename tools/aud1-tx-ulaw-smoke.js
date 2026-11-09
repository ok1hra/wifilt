#!/usr/bin/env node
"use strict";

// TX_ULAW (AUD1 kind 4, docs/aud1-audio-websocket-protocol.md): the browser
// sends TX at the radio link's rate as uLaw instead of PCM16 at 48 kHz, and the
// radio must receive exactly the bytes the firmware's own conversion produced.
//
//   1. encodeUlaw (data/js8-aud1.js) == aud1Pcm16ToUlaw, compiled straight out
//      of wifilt.ino, for all 65536 inputs;
//   2. transcodeTxWire == the firmware's TX_PCM16 path (every 6th / 3rd sample
//      from the packet start, then aud1Pcm16ToUlaw) over a run of packets, at
//      8 and 16 kHz;
//   3. Aud1WebSocketSession against a fake socket: the hello decides the wire,
//      tx.prepare / tx.extend / packets are counted in the wire's samples, and
//      a hello without TX_ULAW (old firmware) or txWire:"pcm16" keeps PCM16.
//
// Usage: node tools/aud1-tx-ulaw-smoke.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const {execFileSync} = require("child_process");
const T = require("../data/js8-aud1.js");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
  if (!ok) failures += 1;
}

// ---- 1. the encoder, against the firmware's own function ------------------
const sketch = fs.readFileSync(path.join(__dirname, "..", "wifilt.ino"), "utf8");
const match = sketch.match(/static uint8_t aud1Pcm16ToUlaw\(int16_t input\)\{[\s\S]*?\n\}\n/);
if (!match) { console.log("FAIL aud1Pcm16ToUlaw not found in wifilt.ino"); process.exit(1); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aud1-ulaw-"));
fs.writeFileSync(path.join(dir, "u.cpp"), `#include <cstdint>
#include <cstdio>
${match[0]}
int main(){ for(int i=-32768;i<32768;i++) std::putchar(aud1Pcm16ToUlaw(int16_t(i))); }
`);
execFileSync("g++", ["-std=c++17", "-O1", "-o", path.join(dir, "u"), path.join(dir, "u.cpp")]);
const firmware = execFileSync(path.join(dir, "u"), {maxBuffer: 1 << 20});
fs.rmSync(dir, {recursive: true, force: true});
let mismatch = -1;
for (let i = 0; i < 65536; i += 1) if (T.encodeUlaw(i - 32768) !== firmware[i]) { mismatch = i - 32768; break; }
check("encodeUlaw == firmware aud1Pcm16ToUlaw for all 65536 inputs", firmware.length === 65536 && mismatch < 0,
  mismatch < 0 ? "" : `first difference at ${mismatch}`);
const fwUlaw = v => firmware[v + 32768];

// ---- 2. the packet transcoder, against the firmware's PCM16 path -----------
function pcmPacket({seq, firstSample, pcm, first, last, txId = 7, streamId = 0x01020304}) {
  const wire = new Uint8Array(40 + pcm.length * 2), v = new DataView(wire.buffer);
  wire.set([0x41, 0x55, 0x44, 0x31], 0); wire[4] = 1; wire[5] = 3;
  v.setUint16(6, (first ? 1 : 0) | (last ? 2 : 0), false); v.setUint16(8, 40, false);
  v.setUint32(12, streamId, false); v.setUint32(16, seq, false); v.setUint32(20, 48000, false);
  v.setBigUint64(24, BigInt(firstSample), false); v.setUint32(32, txId, false);
  v.setUint32(36, pcm.length * 2, false);
  for (let i = 0; i < pcm.length; i += 1) v.setInt16(40 + i * 2, pcm[i], true);
  return wire;
}
// A swept tone with full-scale peaks and odd packet sizes (multiples of 6).
const sizes = [960, 960, 954, 966, 960, 6, 960, 480];
const total = sizes.reduce((a, b) => a + b, 0);
const signal = new Int16Array(total);
for (let i = 0; i < total; i += 1)
  signal[i] = Math.max(-32768, Math.min(32767, Math.round(34000 * Math.sin(i * (0.01 + i * 1e-6)))));
for (const rate of [8000, 16000]) {
  const txWire = T.pickTxWire({tx: [{kind: "TX_PCM16", sampleRate: 48000}, {kind: "TX_ULAW", sampleRate: rate}]});
  const decim = 48000 / rate;
  let at = 0, ok = true, detail = "";
  sizes.forEach((n, seq) => {
    const pcm = signal.subarray(at, at + n);
    const out = T.transcodeTxWire(pcmPacket({seq, firstSample: at, pcm, first: seq === 0, last: seq === sizes.length - 1}), txWire);
    const p = T.parseAud1(out);
    const want = [];
    for (let i = 0; i < n; i += decim) want.push(fwUlaw(pcm[i]));   // aud1AcceptTxPacket's loop
    const same = p.payload.length === want.length && want.every((b, i) => p.payload[i] === b);
    if (!same || p.kind !== 4 || p.sampleRate !== rate || p.firstSample !== BigInt(at / decim) ||
        p.sequence !== seq || p.txId !== 7 || p.streamId !== 0x01020304 ||
        p.flags !== ((seq === 0 ? 1 : 0) | (seq === sizes.length - 1 ? 2 : 0))) {
      ok = false; detail = detail || `packet ${seq}`;
    }
    at += n;
  });
  check(`transcodeTxWire == firmware PCM16 path at ${rate} Hz (${sizes.length} packets)`, ok, detail);
}
check("pickTxWire without TX_ULAW in the hello -> PCM16",
  T.pickTxWire({tx: [{kind: "TX_PCM16", sampleRate: 48000}]}).kind === 3);
check("pickTxWire with txWire pcm16 -> PCM16",
  T.pickTxWire({tx: [{kind: "TX_ULAW", sampleRate: 8000}]}, "pcm16").kind === 3);
check("pickTxWire ignores a rate 48 kHz is no multiple of",
  T.pickTxWire({tx: [{kind: "TX_ULAW", sampleRate: 11025}]}).kind === 3);

// ---- 3. the session, against a fake socket ---------------------------------
class FakeSocket {
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; FakeSocket.last = this; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
}
FakeSocket.OPEN = 1;

async function session(helloTx, options = {}) {
  const s = new T.Aud1WebSocketSession({url: "ws://x/audiows", WebSocketImpl: FakeSocket,
    pingIntervalMs: 1e9, wallNow: () => 1000000, ...options});
  s.start();
  const socket = FakeSocket.last;
  await s.receive(JSON.stringify({type: "hello", protocol: "AUD1", version: 1, streamId: 99,
    rx: [{kind: "RX_ULAW", sampleRate: 8000}], tx: helloTx}));
  return {s, socket};
}
const lastJson = socket => JSON.parse(socket.sent.filter(m => typeof m === "string").pop());

(async () => {
  {
    const {s, socket} = await session([{kind: "TX_PCM16", sampleRate: 48000}, {kind: "TX_ULAW", sampleRate: 8000}]);
    const ready = s.prepare(5, {slotUtcMs: 1001000, prebufferSamples: 9600, packetMs: 20,
      samples: 960 * 10, packets: 10, mode: "MERCURY", toneHz: 0});
    const prep = lastJson(socket);
    check("8 kHz: tx.prepare names TX_ULAW at 8000 in link samples",
      prep.kind === "TX_ULAW" && prep.sampleRate === 8000 && prep.samples === 1600 && prep.prebufferSamples === 1600,
      JSON.stringify(prep));
    s.sendControl({type: "tx.extend", txId: 5, samples: 960 * 3, packets: 3});
    const ext = lastJson(socket);
    check("8 kHz: tx.extend is counted in link samples", ext.samples === 480 && ext.packets === 3, JSON.stringify(ext));
    s.begin(5);
    s.write(pcmPacket({seq: 0, firstSample: 0, pcm: signal.subarray(0, 960), first: true, last: false, txId: 5, streamId: 99}));
    const bin = socket.sent[socket.sent.length - 1];
    const p = T.parseAud1(bin);
    check("8 kHz: the packet goes out as kind 4, 160 bytes, firstSample 0",
      p.kind === 4 && p.payload.length === 160 && p.sampleRate === 8000 && p.firstSample === 0n,
      `kind ${p.kind} len ${p.payload.length}`);
    check("8 kHz: ~10x fewer bytes on the socket than PCM16 (header included)", bin.length === 200, `${bin.length} B vs 1960 B`);
    s.receiveControl({type: "tx-ready", txId: 5});
    await ready;
    const odd = await s.prepare(6, {slotUtcMs: 1001000, prebufferSamples: 1000, packetMs: 20,
      samples: 961, packets: 2, mode: "MERCURY", toneHz: 0}).then(() => "resolved", e => e.message);
    check("a length that is no whole number of link samples is refused", /whole number/.test(odd), odd);
    s.stop();
  }
  {
    const {s, socket} = await session([{kind: "TX_PCM16", sampleRate: 48000}, {kind: "TX_ULAW", sampleRate: 16000}]);
    s.prepare(5, {slotUtcMs: 1001000, prebufferSamples: 1000, packetMs: 20, samples: 960 * 4, packets: 4, mode: "MERCURY", toneHz: 0}).catch(() => {});
    const prep = lastJson(socket);
    check("16 kHz: tx.prepare at 16000, prebuffer rounded up", prep.sampleRate === 16000 &&
      prep.samples === 1280 && prep.prebufferSamples === 334, JSON.stringify(prep));
    s.begin(5);
    s.write(pcmPacket({seq: 0, firstSample: 0, pcm: signal.subarray(0, 960), first: true, last: false, txId: 5, streamId: 99}));
    check("16 kHz: 320-byte packets", T.parseAud1(socket.sent[socket.sent.length - 1]).payload.length === 320);
    s.stop();
  }
  for (const [name, helloTx, options] of [
    ["old firmware (no TX_ULAW in the hello)", [{kind: "TX_PCM16", sampleRate: 48000}], {}],
    ["txWire pcm16 (?aud1tx=pcm16)", [{kind: "TX_PCM16", sampleRate: 48000}, {kind: "TX_ULAW", sampleRate: 8000}], {txWire: "pcm16"}],
  ]) {
    const {s, socket} = await session(helloTx, options);
    s.prepare(5, {slotUtcMs: 1001000, prebufferSamples: 9600, packetMs: 20, samples: 9600, packets: 10, mode: "JS8", toneHz: 1000}).catch(() => {});
    const prep = lastJson(socket);
    s.begin(5);
    const wire = pcmPacket({seq: 0, firstSample: 0, pcm: signal.subarray(0, 960), first: true, last: false, txId: 5, streamId: 99});
    s.write(wire);
    const sentWire = socket.sent[socket.sent.length - 1];
    check(`${name}: PCM16 at 48 kHz, packet unchanged`,
      prep.kind === undefined && prep.sampleRate === 48000 && prep.samples === 9600 && sentWire === wire,
      JSON.stringify(prep));
    s.stop();
  }
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
