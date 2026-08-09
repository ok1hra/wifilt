#!/usr/bin/env node
"use strict";

// Exercises the production TX arbiter directly.
const {Js8TxQueue, autoReplyTtlMs} = require("../../../data/js8-txqueue.js");

function check(condition, what) {
  if (!condition) { console.error(`TXQUEUE FAIL: ${what}`); process.exitCode = 1; }
  return condition;
}

// --- priority order ---------------------------------------------------------
{
  const q = new Js8TxQueue();
  let t = 0;
  q.push({source: "autoreply", text: "SNR -12", to: "K0OG", nowMs: t, submode: 0});
  q.push({source: "inbox", text: "MSG 32", to: "OK2XYZ", nowMs: t += 1});
  q.push({source: "operator", text: "HELLO", to: "K0OG", nowMs: t += 1});
  q.push({source: "relay", text: "OH8STN>HI", to: "DR4CNK", nowMs: t += 1});

  check(q.take(t).source === "operator", "the operator must always go first");
  // relay and inbox share a priority, so the older one wins.
  check(q.take(t).source === "inbox", "within a priority the oldest goes first");
  check(q.take(t).source === "relay", "then the newer of that priority");
  check(q.take(t).source === "autoreply", "auto replies come last of the queued kinds");
  check(q.take(t) === null, "an empty queue must return null");
}

// --- expiry: the point of the whole design ----------------------------------
// A ten minute BIN transfer must not be followed by a burst of stale answers.
{
  const events = [];
  const q = new Js8TxQueue({onEvent: event => events.push(event)});
  q.push({source: "autoreply", text: "SNR -12", to: "K0OG", nowMs: 0, submode: 0});
  check(q.size(0) === 1, "entry must be queued");
  // Normal mode: two 15 s periods.
  check(autoReplyTtlMs(0) === 30000, "auto reply TTL must be two Normal periods");
  check(q.peek(29999) !== null, "must still be valid just inside its window");
  check(q.peek(30000) === null, "must be dropped once its window passes");
  check(q.stats.expired === 1, "expiry must be counted");
  const expired = events.find(event => event.type === "expired");
  check(expired && expired.detail.includes("s"), "expiry must be explained, not silent");

  // A ten minute transfer with a steady trickle of queries leaves nothing behind.
  const q2 = new Js8TxQueue();
  for (let minute = 0; minute < 10; minute += 1)
    q2.push({source: "autoreply", text: "SNR -12", to: `OK${minute}ABC`, nowMs: minute * 60000, submode: 0});
  check(q2.size(600000) === 0, "no stale answers may survive a ten minute transfer");
  check(q2.stats.expired === 10, "all ten must be dropped, not sent late");
}

// --- TTL follows the submode ------------------------------------------------
{
  check(autoReplyTtlMs(4) === 60000, "Slow: two 30 s periods");
  check(autoReplyTtlMs(1) === 20000, "Fast: two 10 s periods");
  check(autoReplyTtlMs(8) === 8000, "JS8-60: two 4 s periods");
  check(autoReplyTtlMs(99) === 30000, "an unknown submode must fall back to Normal");
}

// --- operator work never expires --------------------------------------------
{
  const q = new Js8TxQueue();
  q.push({source: "operator", text: "HELLO", to: "K0OG", nowMs: 0});
  check(q.peek(86400000) !== null, "what the operator typed must never be dropped");
  // Relay and inbox hold for half an hour.
  const q2 = new Js8TxQueue();
  q2.push({source: "relay", text: "X", to: "A", nowMs: 0});
  check(q2.peek(30 * 60000 - 1) !== null, "relay must survive just under 30 min");
  check(q2.peek(30 * 60000) === null, "relay must expire at 30 min");
}

// --- heartbeat reschedules instead of stacking ------------------------------
{
  const events = [];
  const q = new Js8TxQueue({onEvent: event => events.push(event)});
  const out = q.push({source: "heartbeat", text: "@HB JO70", nowMs: 0});
  check(!out.queued && out.reason === "reschedule", "heartbeat must not queue");
  check(q.size(0) === 0, "heartbeat must leave the queue untouched");
  check(events.some(event => event.type === "deferred"), "the deferral must be visible");
}

// --- a repeated question does not buy two answers ---------------------------
{
  const q = new Js8TxQueue();
  q.push({source: "autoreply", text: "SNR -12", to: "K0OG", nowMs: 0, submode: 0,
    meta: {command: "SNR?"}});
  q.push({source: "autoreply", text: "SNR -10", to: "K0OG", nowMs: 1000, submode: 0,
    meta: {command: "SNR?"}});
  check(q.size(1000) === 1, "a second answer to the same question must replace the first");
  check(q.peek(1000).text === "SNR -10", "the newer, fresher report must be the one kept");
  check(q.stats.replaced === 1, "the replacement must be counted");
  // A different question from the same station is its own entry.
  q.push({source: "autoreply", text: "GRID JO70", to: "K0OG", nowMs: 1100, submode: 0,
    meta: {command: "GRID?"}});
  check(q.size(1100) === 2, "a different question must queue separately");
}

// --- bounded ----------------------------------------------------------------
{
  const q = new Js8TxQueue({maxSize: 3});
  for (let i = 0; i < 5; i += 1)
    q.push({source: "operator", text: `M${i}`, nowMs: 0});
  check(q.size(0) === 3, "the queue must stay bounded");
  check(q.stats.rejected === 2, "rejections must be counted");
  check(!q.push({source: "nonsense", text: "x", nowMs: 0}).queued, "unknown sources must be refused");
  check(!q.push({source: "operator", text: "", nowMs: 0}).queued, "empty text must be refused");
}

// --- snapshot drives the UI, so it must be truthful -------------------------
{
  const q = new Js8TxQueue();
  q.push({source: "operator", text: "HELLO", to: "K0OG", nowMs: 0});
  q.push({source: "autoreply", text: "SNR -12", to: "K0OG", nowMs: 0, submode: 0});
  const snap = q.snapshot(40000); // the auto reply has expired by now
  check(snap.size === 1 && snap.items[0].source === "operator",
    "snapshot must not report entries it would refuse to send");
  check(snap.items[0].inMs === null, "an operator entry must show no expiry");
}

if (!process.exitCode)
  console.log("TXQUEUE PASS order=operator,relay/inbox,autoreply,heartbeat " +
    "autoreplyTTL=2periods relayTTL=30min hbDefers=true");
