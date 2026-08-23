#!/usr/bin/env node
// Sanity check for ch.8's calibration burst source before building the real
// Worker around it: host_mode_payload_bytes(DATAC1) + host_tx_start() with an
// ARBITRARY (dummy) payload of that exact size, no ARQ session/CALL/peer
// needed at all -- content doesn't matter for a drive calibration, only the
// mode's real OFDM waveform shape (PAPR) does, which doc ch.8 insists on
// (never the WSPR tune tone: 6-10dB less PAPR, badly under-calibrates).
"use strict";
const path = require("path");
delete global.fetch;
const createMercuryHost = require(path.resolve(__dirname, "build-host/mercury-host.js"));

const FREEDV_MODE_DATAC1 = 10;

async function main() {
  const m = await createMercuryHost();
  const cw = (name, ret, args) => m.cwrap(name, ret, args);
  const modePayloadBytes = cw("host_mode_payload_bytes", "number", ["number"]);
  const txStart = cw("host_tx_start", "number", ["number", "number", "number"]);
  const txRemaining = cw("host_tx_remaining", "number", []);
  const txPtr = cw("host_tx_ptr", "number", []);

  const len = modePayloadBytes(FREEDV_MODE_DATAC1);
  console.log(`DATAC1 payload_bytes = ${len}`);
  if (!(len > 0)) { console.log("FAIL: bad payload length"); process.exit(1); }

  const dummy = new Uint8Array(len); // all-zero content -- fine, only shape matters
  const ptr = m._malloc(len);
  m.HEAPU8.set(dummy, ptr);
  const sampleCount = txStart(FREEDV_MODE_DATAC1, ptr, len);
  m._free(ptr);
  console.log(`host_tx_start(DATAC1, dummy) -> ${sampleCount} samples @ 8kHz (${(sampleCount / 8000).toFixed(2)}s)`);
  if (!(sampleCount > 0)) { console.log("FAIL: modulation failed"); process.exit(1); }

  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) samples[i] = m.HEAP16[(txPtr() >> 1) + i];
  let peak = 0, sumSq = 0;
  for (const s of samples) { peak = Math.max(peak, Math.abs(s)); sumSq += s * s; }
  const rms = Math.sqrt(sumSq / samples.length);
  const paparDb = 20 * Math.log10(peak / rms);
  console.log(`peak=${peak} rms=${rms.toFixed(1)} PAPR=${paparDb.toFixed(1)}dB remaining=${txRemaining()}`);
  const ok = paparDb > 3; // a real OFDM burst should clearly exceed a constant-envelope tone's ~0dB
  console.log(ok
    ? "PASS: real DATAC1 burst modulated from an arbitrary payload, with real OFDM PAPR"
    : "FAIL: PAPR too low to be a real OFDM burst");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
