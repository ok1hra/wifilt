#!/usr/bin/env node
"use strict";

// Exercises the production restriction engine directly.
const {Js8Restrictions, banMsForLevel} = require("../../../data/js8-restrictions.js");

const MIN = 60000;
function check(condition, what) {
  if (!condition) { console.error(`RESTRICTIONS FAIL: ${what}`); process.exitCode = 1; }
  return condition;
}
const ask = (r, call, command, nowMs, isSelectedCall = false) =>
  r.evaluate({call, command, nowMs, isSelectedCall});

// --- normal operating is not restricted -------------------------------------
{
  const r = new Js8Restrictions();
  let t = 0;
  check(ask(r, "OK1ABC", "SNR?", t).allowed, "first question must be answered");
  // A station may reasonably ask several different things in a row.
  check(ask(r, "OK1ABC", "GRID?", t += 1000).allowed, "a different question must be answered");
  check(ask(r, "OK1ABC", "INFO?", t += 1000).allowed, "a third question must be answered");
  // Other stations are unaffected by each other.
  check(ask(r, "OK2XYZ", "SNR?", t += 1000).allowed, "another station must be answered");
  check(r.activeBans(t).length === 0, "ordinary traffic must not create bans");
}

// --- repeating the SAME question inside its window is the offence -----------
{
  const r = new Js8Restrictions();
  let t = 0;
  check(ask(r, "OK1ABC", "SNR?", t).allowed, "first SNR? must be answered");
  const second = ask(r, "OK1ABC", "SNR?", t + 60000);
  check(!second.allowed && second.reason === "window", "repeat inside window must be refused");
  check(second.level === 0 && second.retryInMs === 1 * MIN, "first offence must be a 1 min ban");
  // Beyond the window it is a legitimate question again.
  const r2 = new Js8Restrictions();
  check(ask(r2, "OK1ABC", "SNR?", 0).allowed, "seed");
  check(ask(r2, "OK1ABC", "SNR?", 5 * MIN + 1).allowed, "outside the window must be answered");
}

// --- rotating commands must not dodge the penalty ---------------------------
// The reason the penalty is keyed by callsign and not by (callsign, command).
{
  const r = new Js8Restrictions();
  let t = 0;
  check(!ask(r, "SPAM", "AGN?", t).allowed === false, "seed AGN?");
  const first = ask(r, "SPAM", "AGN?", t + 1000);   // repeat -> ban level 0
  check(!first.allowed && first.retryInMs === 1 * MIN, "AGN? repeat must ban 1 min");
  // Switching command must NOT get a free pass while the callsign is banned.
  const rotated = ask(r, "SPAM", "SNR?", t + 2000);
  check(!rotated.allowed && rotated.reason === "banned",
        "a different command must not bypass an active ban");
  check(rotated.retryInMs === 2 * MIN, "asking during a ban must double it");
  const again = ask(r, "SPAM", "GRID?", t + 3000);
  check(again.retryInMs === 4 * MIN, "each further request must double again");
}

// --- doubling and the 64 min ceiling ----------------------------------------
{
  const r = new Js8Restrictions();
  let t = 0;
  ask(r, "SPAM", "SNR?", t);
  let last = ask(r, "SPAM", "SNR?", t + 100).retryInMs; // level 0 -> 1 min
  const seen = [last];
  for (let i = 0; i < 10; i += 1) {
    last = ask(r, "SPAM", "SNR?", t += 200).retryInMs;
    seen.push(last);
  }
  check(seen.slice(0, 7).join(",") === "60000,120000,240000,480000,960000,1920000,3840000",
        `doubling must be 1..64 min, got ${seen.slice(0, 7).join(",")}`);
  check(seen.every(ms => ms <= 64 * MIN), "ban must never exceed the 64 min ceiling");
  check(banMsForLevel(6, MIN) === 64 * MIN, "level 6 must be 64 min");
}

// --- decay follows the same curve back down ---------------------------------
{
  const r = new Js8Restrictions();
  let t = 0;
  ask(r, "SPAM", "SNR?", t);
  ask(r, "SPAM", "SNR?", t + 100);          // level 0, ban 1 min
  ask(r, "SPAM", "SNR?", t + 200);          // level 1, ban 2 min
  ask(r, "SPAM", "SNR?", t + 300);          // level 2, ban 4 min
  const bans = r.activeBans(t + 400);
  check(bans.length === 1 && bans[0].level === 2, "station must be at level 2");

  // Quiet for the full ban -> the ban lapses but the level is still elevated.
  check(r.activeBans(t + 300 + 4 * MIN + 1).length === 0, "ban must lapse after its length");
  // Enough quiet and the penalty is gone entirely.
  const farFuture = t + 300 + (4 + 2 + 1) * MIN + 10;
  check(r.activeBans(farFuture).length === 0, "penalty must clear after decaying down");
  check(ask(r, "SPAM", "SNR?", farFuture).allowed,
        "a station must be answerable again once its penalty has decayed");
}

// --- the station you are actually working gets a shorter window -------------
{
  const r = new Js8Restrictions();
  check(ask(r, "OK1ABC", "SNR?", 0, true).allowed, "seed QSO station");
  check(!ask(r, "OK1ABC", "SNR?", 30000, true).allowed, "30 s is inside the 1 min QSO window");
  const r2 = new Js8Restrictions();
  check(ask(r2, "OK1ABC", "SNR?", 0, true).allowed, "seed");
  check(ask(r2, "OK1ABC", "SNR?", MIN + 1, true).allowed,
        "a live QSO must not be throttled by the 5 min window");
}

// --- heartbeat ACK keeps the upstream 55 min window -------------------------
{
  const r = new Js8Restrictions();
  check(ask(r, "OK1ABC", "HEARTBEAT", 0).allowed, "first HB ACK must be sent");
  const repeat = ask(r, "OK1ABC", "HEARTBEAT", 50 * MIN);
  check(!repeat.allowed && repeat.reason === "window", "HB inside 55 min must be refused");
  const r2 = new Js8Restrictions();
  check(ask(r2, "OK1ABC", "HEARTBEAT", 0).allowed, "seed");
  check(ask(r2, "OK1ABC", "HEARTBEAT", 55 * MIN + 1).allowed, "HB after 55 min must be sent");
}

// --- a normal beacon is throttled, never punished ---------------------------
// A station heartbeating every 15 min is well-behaved; a repeat inside the
// window must be suppressed WITHOUT seeding a penalty, or its ACKs (and its
// legitimate directed queries) would dry up as the callsign gets banned.
{
  const r = new Js8Restrictions();
  for (let n = 0; n < 8; n += 1) ask(r, "K0OG", "HEARTBEAT", n * 15 * MIN);
  check(r.stats.escalations === 0, "routine heartbeats must not escalate a penalty");
  check(r.activeBans(2 * 60 * MIN).length === 0, "a normal beacon must never create a ban");
  // ...and the station's real query still gets through.
  check(ask(r, "K0OG", "SNR?", 15 * MIN + 1000).allowed,
        "a beaconing station's legitimate query must still be answered");
}

// --- hourly cap is a bound, not a weapon ------------------------------------
// One station must not be able to exhaust it, which is why the per-callsign
// penalty exists; the cap only catches broad, distributed load.
{
  const r = new Js8Restrictions({hourlyCap: 5});
  let t = 0, allowed = 0;
  for (let i = 0; i < 8; i += 1)
    if (ask(r, `OK${i}ABC`, "SNR?", t += 1000).allowed) allowed += 1;
  check(allowed === 5, `hourly cap must stop at 5, got ${allowed}`);
  check(ask(r, "OK9ABC", "SNR?", t + 3600001).allowed, "cap must slide with the hour");
}

// --- every refusal is explained ---------------------------------------------
{
  const events = [];
  const r = new Js8Restrictions({onEvent: e => events.push(e)});
  ask(r, "SPAM", "SNR?", 0);
  const refusal = ask(r, "SPAM", "SNR?", 100);
  check(refusal.detail && refusal.detail.includes("SPAM"), "refusal must name the station");
  check(events.some(e => e.type === "penalty" && e.call === "SPAM" && e.reason),
        "escalation must emit an event with a reason");
}

const final = new Js8Restrictions();
final.evaluate({call: "OK1ABC", command: "SNR?", nowMs: 0});
const snap = final.snapshot(0);
check(snap.granted === 1 && snap.hourly === 1, "snapshot must report counters");

if (!process.exitCode)
  console.log("RESTRICTIONS PASS window=5min qso=1min hb=55min ban=1..64min cap=120/h");
