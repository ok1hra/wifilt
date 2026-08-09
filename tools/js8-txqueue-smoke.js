#!/usr/bin/env node
"use strict";

// The TTL half of docs/js8-tx-resend-plan.md, checked without a browser: how long a
// retry of a failed transmission stays worth sending. The browser harness can prove
// that a retry is armed, but not that it dies at the right moment -- that needs a
// clock the test controls.

const Js8TxQueue = require("../data/js8-txqueue.js");

const NORMAL = 0, TURBO = 8, SLOW = 4;
const queue = new Js8TxQueue.Js8TxQueue({});
const events = [];
const watched = new Js8TxQueue.Js8TxQueue({onEvent: event => events.push(event)});

// A retry pushed at t=0 with the resend TTL, read back at various later times.
function survives(ttlMs, atMs) {
  const local = new Js8TxQueue.Js8TxQueue({});
  local.push({source: "operator", text: "RETRY", to: "K0OG", nowMs: 0, ttlMs});
  return local.size(atMs) === 1;
}

function survivesRelay(atMs) {
  const local = new Js8TxQueue.Js8TxQueue({});
  local.push({source: "relay", text: "FWD", to: "K0OG", nowMs: 0});
  return local.size(atMs) === 1;
}

const normalTtl = Js8TxQueue.resendTtlMs(NORMAL);
watched.push({source: "operator", text: "RETRY", to: "K0OG", nowMs: 0, ttlMs: normalTtl});
watched.prune(normalTtl + 1);

const checks = {
  // Four slot periods, expressed in periods rather than seconds: a fixed 60 s would be
  // two slots on SLOW and fifteen on TURBO, which is not the same rule at all.
  fourPeriods: Js8TxQueue.RESEND_PERIODS === 4 &&
    normalTtl === 60000 && Js8TxQueue.resendTtlMs(TURBO) === 16000 &&
    Js8TxQueue.resendTtlMs(SLOW) === 120000,
  unknownSubmodeFallsBackToNormal: Js8TxQueue.resendTtlMs(99) === normalTtl,
  // Longer than an auto reply is allowed to wait, because a resend is the operator's
  // own message and not a report that goes stale in two slots.
  outlivesAutoReply: normalTtl > Js8TxQueue.autoReplyTtlMs(NORMAL),

  aliveJustBeforeExpiry: survives(normalTtl, normalTtl - 1),
  goneAtExpiry: !survives(normalTtl, normalTtl),

  // The operator source itself must stay unbounded: only the RETRY gets a cap, so a
  // first send is never quietly dropped by a clock.
  operatorSourceStillUnbounded: Js8TxQueue.TTL_MS.operator === null &&
    (() => {
      queue.push({source: "operator", text: "FIRST", to: "K0OG", nowMs: 0});
      return queue.size(24 * 3600000) === 1;
    })(),

  // Store-and-forward keeps its own half hour: a message for an absent station does
  // not go stale because twenty minutes passed. No ttlMs override, so this exercises
  // the source default the retry path deliberately leaves alone.
  relayKeepsThirtyMinutes: Js8TxQueue.TTL_MS.relay === 30 * 60000 &&
    Js8TxQueue.TTL_MS.inbox === 30 * 60000 &&
    survivesRelay(29 * 60000) && !survivesRelay(31 * 60000),

  // Expiry is announced, never silent -- the row and the composer both hang off this.
  expiryIsAnnounced: events.some(event => event.type === "expired" && event.source === "operator")
};

const pass = Object.values(checks).every(Boolean);
console.log(`JS8 TXQUEUE ${pass ? "PASS" : "FAIL"} ${JSON.stringify(checks)}`);
if (!pass) process.exitCode = 1;
