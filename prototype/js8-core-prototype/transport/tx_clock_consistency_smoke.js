#!/usr/bin/env node
"use strict";

// B2 regression: `slotUtcMs` (planned by TxController) and `clientUtcMs` (sent by
// the AUD1 session) must come from ONE clock. The firmware computes
//   delayMs = slotUtcMs - clientUtcMs
// and rejects tx.prepare unless 100 <= delayMs <= 35000
// (IC-705_Interface.ino, aud1HandleControl). Two different clocks shift the pair
// apart and the radio silently refuses to transmit.
//
// Exercises the production files directly.
const {TxController} = require("../../../data/js8-tx.js");
const {Aud1WebSocketSession} = require("../../../data/js8-aud1.js");

const FIRMWARE_MIN_DELAY_MS = 100;
const FIRMWARE_MAX_DELAY_MS = 35000;

class FakeSocket {
  constructor() { this.readyState = 1; this.sent = []; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
}
FakeSocket.OPEN = 1;

// Builds a session whose UTC source is `wallNow`, already past the AUD1 hello.
function openSession(wallNow) {
  const sockets = [];
  class Impl extends FakeSocket {
    constructor() { super(); sockets.push(this); }
  }
  Impl.OPEN = 1;
  const session = new Aud1WebSocketSession({url: "ws://test/audiows",
    WebSocketImpl: Impl, reconnectMs: 0, wallNow});
  session.start();
  session.receiveControl({type: "hello", protocol: "AUD1", version: 1, streamId: 7});
  return {session, socket: sockets[0]};
}

// Runs one TX preparation and returns what the firmware would see.
function prepareOnce({controllerClock, sessionClock, mode = 0}) {
  const {session, socket} = openSession(sessionClock);
  const sink = {
    prepare: (txId, metadata) => session.prepare(txId, metadata),
    begin: () => {}, write: () => {}, end: () => {},
    isDrained: () => false, complete: () => {}, abort: () => {}, ptt: false,
  };
  const controller = new TxController({
    buildFrames: () => [{raw: "TEST", frameType: 1, role: "directed"}],
    encoder: () => new Int16Array(48000 * 13), // ~13 s, one Normal frame
    sink, wallNow: controllerClock,
  });
  controller.queue({mode, toneHz: 1500}, controllerClock());
  controller.prepare(controllerClock());

  const control = socket.sent
    .map(raw => JSON.parse(raw))
    .find(message => message.type === "tx.prepare");
  if (!control) throw new Error("no tx.prepare reached the socket");
  return {...control, delayMs: control.slotUtcMs - control.clientUtcMs};
}

// --- shared clock: the invariant holds ---------------------------------------
// A media-time clock 60 s away from Date.now() (an L3 epoch anchor) must be
// harmless as long as BOTH sides read it.
let shared = Date.now() + 60000;
const good = prepareOnce({controllerClock: () => shared, sessionClock: () => shared});
if (good.clientUtcMs !== shared)
  throw new Error(`clientUtcMs did not come from the injected clock: ${good.clientUtcMs} != ${shared}`);
if (good.delayMs < FIRMWARE_MIN_DELAY_MS || good.delayMs > FIRMWARE_MAX_DELAY_MS)
  throw new Error(`Shared clock produced a delay the firmware rejects: ${good.delayMs} ms`);

// --- mixed clocks: the firmware would reject ---------------------------------
// Controller on media time, session on Date.now() -- exactly the B2 defect.
const mixed = prepareOnce({controllerClock: () => Date.now() + 60000,
  sessionClock: () => Date.now()});
if (mixed.delayMs >= FIRMWARE_MIN_DELAY_MS && mixed.delayMs <= FIRMWARE_MAX_DELAY_MS)
  throw new Error(
    `Mixed clocks slipped through the firmware window (${mixed.delayMs} ms); ` +
    "this test can no longer detect the B2 defect");

// --- the default is still Date.now() -----------------------------------------
// Callers that inject nothing must behave exactly as before this change.
const legacy = prepareOnce({controllerClock: () => Date.now(), sessionClock: undefined});
if (legacy.delayMs < FIRMWARE_MIN_DELAY_MS || legacy.delayMs > FIRMWARE_MAX_DELAY_MS)
  throw new Error(`Default clock regressed: ${legacy.delayMs} ms`);

console.log(`TX CLOCK CONSISTENCY PASS shared=${good.delayMs}ms ` +
  `mixed=${mixed.delayMs}ms(rejected) default=${legacy.delayMs}ms ` +
  `window=${FIRMWARE_MIN_DELAY_MS}-${FIRMWARE_MAX_DELAY_MS}ms`);
