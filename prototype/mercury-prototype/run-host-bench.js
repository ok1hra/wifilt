#!/usr/bin/env node
// Drives host-shim.c's real-modem ARQ bridge for one A->B file transfer.
// This is a JS port of mercury/tests/sim/sim_core.c's discrete-event loop
// (drain outframes, compute both FSMs' next deadline, jump the virtual
// clock to the earliest pending event, fire it, repeat) with ONE change:
// where sim_core.c asks its abstract sim_channel_t whether a frame survives
// and how long it takes, this calls host_modem_relay() -- a REAL freedv
// encode+decode round trip -- and uses the REAL sample count for airtime.
"use strict";
const path = require("path");

// Same emcc-3.1.6-vs-Node->=18-global-fetch workaround as run-loopback.js.
delete global.fetch;

const buildDir = process.argv[2];
if (!buildDir) { console.error("usage: run-host-bench.js <build-dir>"); process.exit(2); }
const createMercuryHost = require(path.resolve(buildDir, "mercury-host.js"));

// arq_fsm.h event ids (stable layout, see the header for the authoritative list).
const EV = {
  APP_LISTEN: 0, APP_STOP_LISTEN: 1, APP_CONNECT: 2, APP_DISCONNECT: 3, APP_DATA_READY: 4,
};
const CONN_STATE = ["DISCONNECTED", "LISTENING", "CALLING", "ACCEPTING", "CONNECTED", "DISCONNECTING"];
const FREEDV_MODE_DATAC3 = 12; // must match mercury/modem/freedv/freedv_api.h
const GUARD_MS = 100; // matches mercury/tests/sim/test_arq_sim.c's sim_channel_cfg_t.guard_ms

createMercuryHost().then(m => {
  const cw = (name, ret, args) => m.cwrap(name, ret, args);
  const init = cw("host_init", null, []);
  const epCreate = cw("host_endpoint_create", "number", ["string", "string"]);
  const dispatchSimple = cw("host_dispatch_simple", null, ["number", "number"]);
  const connect = cw("host_connect", null, ["number", "string"]);
  const queueTx = cw("host_queue_tx", null, ["number", "number", "number"]);
  const delivered = cw("host_delivered", "number", ["number", "number", "number"]);
  const connState = cw("host_conn_state", "number", ["number"]);
  const takeOutframe = cw("host_take_outframe", "number", ["number"]);
  const ofLen = cw("host_of_len", "number", []);
  const ofMode = cw("host_of_mode", "number", []);
  const ofBuf = cw("host_of_buf", "number", []);
  const ofPacketType = cw("host_of_packet_type", "number", []);
  const timeoutMs = cw("host_timeout_ms", "number", ["number", "number"]);
  const fireDeadline = cw("host_fire_deadline_if_due", "number", ["number", "number"]);
  const lastDeadlineEvent = cw("host_last_deadline_event", "number", []);
  const clockNow = cw("host_clock_now_ms", "number", []);
  const clockAdvance = cw("host_clock_advance_to_ms", null, ["number"]);
  const deliver = cw("host_deliver", "number", ["number", "number", "number", "number"]);
  const relayOutPtr = cw("host_relay_out_ptr", "number", []);
  const lastRelaySamples = cw("host_last_relay_samples", "number", []);
  const modemRelay = cw("host_modem_relay", "number", ["number", "number", "number"]);

  init();
  const A = epCreate("OK1HRA", "OK2XYZ");
  const B = epCreate("OK2XYZ", "OK1HRA");

  const INT_MAX = 2147483647;
  const pending = []; // {fireAt, kind: 'TX_COMPLETE'|'RX', target, bytes(Uint8Array), len}

  const name = ep => (ep === A ? "A" : "B");

  function drainOutframesFrom(sender, peer, now) {
    while (takeOutframe(sender)) {
      const len = ofLen();
      const mode = ofMode();
      const ptype = ofPacketType();
      const framePtr = ofBuf();

      const decodedLen = modemRelay(mode, framePtr, len);
      const samples = lastRelaySamples();
      const airtimeMs = Math.round(samples / 8); // 8 kHz -> ms, the REAL burst duration
      if (process.env.HOST_DEBUG) console.log(`  t=${now} [relay] from=${name(sender)} ptype=${ptype} mode=${mode} len=${len} -> decodedLen=${decodedLen} samples=${samples} airtime=${airtimeMs}`);

      pending.push({ fireAt: now + airtimeMs, kind: "TX_COMPLETE", target: sender });

      if (decodedLen === len) {
        const outPtr = relayOutPtr();
        const bytes = m.HEAPU8.slice(outPtr, outPtr + decodedLen); // copy: outPtr is reused by the next relay
        // +GUARD_MS mirrors mercury/tests/sim/sim_channel.c's sim_channel_schedule(),
        // which delivers at airtime+guard_ms while TX_COMPLETE fires at airtime alone
        // -- the sender goes idle slightly before the peer sees the frame.
        pending.push({ fireAt: now + airtimeMs + GUARD_MS, kind: "RX", target: peer, bytes, len: decodedLen });
      } else {
        console.log(`  [relay] mode=${mode} len=${len} -> decodedLen=${decodedLen} (frame lost/corrupted)`);
      }
    }
  }

  function drainAll(now) {
    drainOutframesFrom(A, B, now);
    drainOutframesFrom(B, A, now);
  }

  function firePending(p) {
    if (p.kind === "TX_COMPLETE") {
      if (process.env.HOST_DEBUG) console.log(`  t=${clockNow()} [tx_complete] ${name(p.target)}`);
      dispatchSimple(p.target, 22 /* ARQ_EV_TX_COMPLETE, see arq_fsm.h */);
      return;
    }
    const ptr = m._malloc(p.len);
    m.HEAPU8.set(p.bytes, ptr);
    const ok = deliver(p.target, ptr, p.len, 12.0);
    m._free(ptr);
    if (process.env.HOST_DEBUG) console.log(`  t=${clockNow()} [deliver] target=${name(p.target)} len=${p.len} ok=${ok} -> connA=${connState(A)} connB=${connState(B)}`);
  }

  function runUntilIdle(maxMs) {
    const start = clockNow();
    for (;;) {
      const now = clockNow();
      drainAll(now);

      const ta = timeoutMs(A, now);
      const tb = timeoutMs(B, now);
      if (pending.length === 0 && ta === INT_MAX && tb === INT_MAX) break;

      let next = Infinity;
      for (const p of pending) if (p.fireAt < next) next = p.fireAt;
      if (ta !== INT_MAX) next = Math.min(next, now + ta);
      if (tb !== INT_MAX) next = Math.min(next, now + tb);

      if (next === Infinity || next > start + maxMs) { clockAdvance(start + maxMs); break; }

      clockAdvance(next);
      const now2 = clockNow();
      const firedA = fireDeadline(A, now2);
      if (process.env.HOST_DEBUG && firedA) console.log(`  t=${now2} [deadline] A fired ev=${lastDeadlineEvent()} connA=${connState(A)}`);
      drainAll(now2);
      const firedB = fireDeadline(B, now2);
      if (process.env.HOST_DEBUG && firedB) console.log(`  t=${now2} [deadline] B fired ev=${lastDeadlineEvent()} connB=${connState(B)}`);
      drainAll(now2);

      for (let i = 0; i < pending.length; ) {
        if (pending[i].fireAt <= now2) {
          const p = pending.splice(i, 1)[0];
          firePending(p);
          drainAll(clockNow());
          i = 0;
        } else i++;
      }
    }
    return clockNow() - start;
  }

  // ---- scenario: B listens, A calls, A sends a blob, run to completion ----
  dispatchSimple(B, EV.APP_LISTEN);
  connect(A, "OK2XYZ");
  runUntilIdle(60000);

  const stateA = CONN_STATE[connState(A)];
  const stateB = CONN_STATE[connState(B)];
  console.log(`after handshake: A=${stateA} B=${stateB}`);
  if (stateA !== "CONNECTED" || stateB !== "CONNECTED") {
    console.error("FAIL: handshake did not reach CONNECTED/CONNECTED");
    process.exit(1);
  }

  const blob = Buffer.alloc(600);
  for (let i = 0; i < blob.length; i++) blob[i] = (i * 31 + 7) & 0xff;
  const blobPtr = m._malloc(blob.length);
  m.HEAPU8.set(blob, blobPtr);
  queueTx(A, blobPtr, blob.length);
  m._free(blobPtr);
  dispatchSimple(A, EV.APP_DATA_READY);

  // A connected session never truly goes idle (keepalive keeps it alive), so
  // step in small slices and stop as soon as the transfer itself is done --
  // this is the number worth reporting, not "ran until the 180s cap".
  const transferStart = clockNow();
  const outCap = blob.length + 64;
  const outPtr = m._malloc(outCap);
  let gotLen = 0;
  for (let i = 0; i < 180 && gotLen < blob.length; i++) {
    runUntilIdle(1000);
    gotLen = delivered(B, outPtr, outCap);
  }
  const got = Buffer.from(m.HEAPU8.slice(outPtr, outPtr + gotLen));
  m._free(outPtr);
  const elapsed = clockNow() - transferStart;

  console.log(`transfer: sent=${blob.length}B delivered=${gotLen}B elapsed=${elapsed}ms`);
  if (gotLen !== blob.length || !got.equals(blob)) {
    console.error("FAIL: delivered bytes do not match what was sent");
    process.exit(1);
  }
  console.log("PASS: real freedv-modulated frames carried a full transfer through the ARQ FSM, byte-exact");
});
