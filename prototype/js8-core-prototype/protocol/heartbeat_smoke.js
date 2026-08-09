#!/usr/bin/env node
"use strict";

// Exercises the production heartbeat engine directly.
const {Js8Heartbeat, OFFSET_MIN_HZ, OFFSET_MAX_HZ, POSTPONE_GUARD_MS, isHbSubmode} =
  require("../../../data/js8-heartbeat.js");
const {Js8Restrictions} = require("../../../data/js8-restrictions.js");

const MIN = 60000;
function check(condition, what) {
  if (!condition) { console.error(`HEARTBEAT FAIL: ${what}`); process.exitCode = 1; }
  return condition;
}
const ctx = (over = {}) => ({nowMs: 0, submode: 0, txBusy: false, armed: true,
  myCall: "OK1HRA", ...over});

// --- the beacon only runs when it is supposed to -----------------------------
{
  const hb = new Js8Heartbeat();
  check(hb.evaluate(ctx()).reason === "disabled", "must not beacon while disabled");

  hb.configure({enabled: true, intervalMs: 15 * MIN}, 0);
  check(hb.evaluate(ctx({nowMs: 0})).reason === "not-due", "must wait out the first interval");
  check(hb.evaluate(ctx({nowMs: 15 * MIN})).send, "must be due after the interval");
  check(hb.evaluate(ctx({nowMs: 15 * MIN, myCall: ""})).reason === "no-callsign",
    "must not beacon without a callsign");
  check(hb.evaluate(ctx({nowMs: 15 * MIN, armed: false})).reason === "not-armed",
    "an unarmed station must not beacon by itself");
}

// --- speed restriction ------------------------------------------------------
// Upstream does not offer heartbeat on the two fastest modes at all.
{
  const hb = new Js8Heartbeat();
  hb.configure({enabled: true, intervalMs: 1}, 0);
  check(isHbSubmode(4) && isHbSubmode(0) && isHbSubmode(1), "Slow/Normal/Fast must be allowed");
  check(!isHbSubmode(2) && !isHbSubmode(8), "JS8 40 and JS8 60 must not be allowed");
  for (const submode of [2, 8]) {
    const out = hb.evaluate(ctx({nowMs: 1000, submode}));
    check(!out.send && out.reason === "speed", `submode ${submode} must refuse with a reason`);
  }
  check(hb.evaluate(ctx({nowMs: 1000, submode: 4})).send, "Slow must be allowed");
}

// --- offset stays in the narrow HB band -------------------------------------
{
  let value = 0;
  const hb = new Js8Heartbeat({random: () => value});
  value = 0;   check(hb.pickOffsetHz() === OFFSET_MIN_HZ, "bottom of the range");
  value = 1;   check(hb.pickOffsetHz() === OFFSET_MAX_HZ, "top of the range");
  value = 0.5; check(hb.pickOffsetHz() === 750, "middle of the range");
  const real = new Js8Heartbeat();
  for (let i = 0; i < 200; i += 1) {
    const hz = real.pickOffsetHz();
    if (hz < OFFSET_MIN_HZ || hz > OFFSET_MAX_HZ) {
      check(false, `offset ${hz} escaped the 500-1000 Hz band`);
      break;
    }
  }
}

// --- band activity only yields an imminent beacon ---------------------------
// A heartbeat must not transmit on top of a decode, but routine traffic earlier
// in the interval is not ours to yield to -- postponing on it would starve the
// beacon on any busy band.
{
  const hb = new Js8Heartbeat();
  hb.configure({enabled: true, intervalMs: 15 * MIN}, 0);
  check(hb.dueInMs(0) === 15 * MIN, "due in one interval");
  check(!hb.noteBandActivity(5 * MIN), "activity far from the deadline must be ignored");
  check(hb.dueInMs(5 * MIN) === 10 * MIN, "the beacon keeps its schedule");
  const near = 15 * MIN - 10000;   // 10 s before due, inside the one-frame guard
  check(hb.noteBandActivity(near), "activity about to be talked over must slip the beacon");
  check(hb.dueInMs(near) === POSTPONE_GUARD_MS, "it slips by one frame, not a whole interval");
  check(hb.evaluate(ctx({nowMs: near + POSTPONE_GUARD_MS})).send,
    "and then fires in the next quiet frame");
}

// --- a busy band must not starve the beacon (regression: interval-wide reset) -
// One decode every 30 s used to push the due time forward forever; the beacon
// must still announce the station. The dense case (a decode every 8 s, tighter
// than the one-frame guard) is what the defer ceiling exists for.
function beaconsInBusyHour(decodeEveryMs) {
  const hb = new Js8Heartbeat();
  hb.configure({enabled: true, ackEnabled: false, intervalMs: 15 * MIN}, 0);
  let sent = 0, lastDecode = 0;
  for (let t = 0; t <= 60 * MIN; t += 5000) {
    while (lastDecode + decodeEveryMs <= t) { lastDecode += decodeEveryMs; hb.noteBandActivity(lastDecode); }
    if (hb.evaluate(ctx({nowMs: t})).send) { hb.noteSent(t); sent += 1; }
  }
  return sent;
}
check(beaconsInBusyHour(30000) >= 3, "a beacon on a busy band (30 s) must still fire");
check(beaconsInBusyHour(8000) >= 3, "a beacon on a wall-to-wall band (8 s) must still fire");

// --- a busy radio reschedules, never queues ---------------------------------
// It must not queue a beacon for the wrong slot, but it must not push the beacon a
// whole interval either (that used to hide a station through any long QSO): it
// bounded-defers by one frame and fires the moment the radio frees.
{
  const events = [];
  const hb = new Js8Heartbeat({onEvent: event => events.push(event)});
  hb.configure({enabled: true, intervalMs: 15 * MIN}, 0);
  const out = hb.evaluate(ctx({nowMs: 15 * MIN, txBusy: true}));
  check(!out.send && out.reason === "tx-busy", "a busy radio must refuse");
  check(hb.dueInMs(15 * MIN) === POSTPONE_GUARD_MS,
    "a busy radio bounded-defers the beacon by one frame, not a whole interval");
  check(events.some(event => event.type === "deferred"), "the deferral must be visible");
  check(hb.stats.deferred === 1, "deferrals must be counted");
}

// --- acknowledging somebody else's heartbeat --------------------------------
{
  const restrictions = new Js8Restrictions();
  const hb = new Js8Heartbeat({restrictions});
  hb.configure({enabled: true, ackEnabled: true, intervalMs: 15 * MIN}, 0);

  const ack = hb.handleHeartbeat({from: "K0OG", snr: -12}, ctx());
  check(ack.action === "ack" && ack.text === "HEARTBEAT SNR -12" && ack.to === "K0OG",
    `ACK must carry the report, got ${JSON.stringify(ack)}`);
  // A far-off beacon is left on its schedule by an ACK -- it will still announce us
  // on time. Only an imminent beacon is postponed (bounded), so an ACK-heavy band
  // can no longer push our own @HB broadcast forward forever.
  check(hb.dueInMs(0) === 15 * MIN, "an ACK far from due must not disturb the beacon schedule");

  // Upstream's 55 minute window: the same station must not be acked again soon.
  const again = hb.handleHeartbeat({from: "K0OG", snr: -12}, ctx({nowMs: 50 * MIN}));
  check(again.action === "skip", "a repeat heartbeat inside the window must not be acked");
  const later = hb.handleHeartbeat({from: "K0OG", snr: -12}, ctx({nowMs: 200 * MIN}));
  check(later.action === "ack", "after the window it may be acked again");

  check(hb.handleHeartbeat({from: "OK1HRA", snr: 0}, ctx()).reason === "self",
    "our own heartbeat must never be acked");
  check(hb.handleHeartbeat({from: "K0OG", snr: 0}, ctx({armed: false})).reason === "not-armed",
    "an unarmed station must not ack");

  const off = new Js8Heartbeat({restrictions: new Js8Restrictions()});
  off.configure({ackEnabled: false}, 0);
  check(off.handleHeartbeat({from: "K0OG", snr: 0}, ctx()).reason === "disabled",
    "HB mode must be enabled before acknowledgements are sent");
  off.configure({enabled: true, ackEnabled: false}, 0);
  check(off.handleHeartbeat({from: "K0OG", snr: 0}, ctx()).reason === "ack-disabled",
    "ACK can be switched off independently");
  off.configure({enabled: true, ackEnabled: true}, 0);
  check(off.handleHeartbeat({from: "K0OG", snr: 0}, ctx({submode: 2})).reason === "speed",
    "HB acknowledgements must not be sent on JS8 40 or JS8 60");
  check(off.handleHeartbeat({from: "K0OG", snr: 0}, ctx({messageBusy: true})).reason === "message-busy",
    "an incomplete buffered message must suppress intelligent HB ACK");
}

// --- HEARTBEAT SNR advertisement when we hold mail ---------------------------
{
  const hb = new Js8Heartbeat();
  hb.configure({enabled: true, ackEnabled: true, intervalMs: 15 * MIN}, 0);
  // No mail: an ordinary ACK.
  const plain = hb.handleHeartbeat({from: "K0OG", snr: -12},
    ctx({pendingMsgId: () => null}));
  check(plain.text === "HEARTBEAT SNR -12",
    "no stored mail must produce the reference heartbeat acknowledgement");
  // Mail waiting: advertise its id so the station fetches it.
  const advert = hb.handleHeartbeat({from: "KM4ACK", snr: -12},
    ctx({pendingMsgId: () => 32}));
  check(advert.text === "HEARTBEAT SNR -12 MSG ID 32",
    `mail must be advertised in the heartbeat, got ${advert.text}`);
}

// --- SNR formatting matches the wire ----------------------------------------
{
  const hb = new Js8Heartbeat();
  hb.configure({enabled: true, ackEnabled: true}, 0);
  check(hb.handleHeartbeat({from: "A1AA", snr: 5}, ctx()).text === "HEARTBEAT SNR +05",
    "positive SNR padded");
  check(hb.handleHeartbeat({from: "B2BB", snr: 0}, ctx()).text === "HEARTBEAT SNR +00",
    "zero SNR");
  check(hb.handleHeartbeat({from: "C3CC", snr: -7}, ctx()).text === "HEARTBEAT SNR -07",
    "negative SNR padded");
  check(hb.handleHeartbeat({from: "D4DD", snr: -60}, ctx()).text === "HEARTBEAT SNR -30",
    "SNR must be clamped to the six-bit directed-command range");
}

// --- a continuously busy radio must not starve the beacon (regression) -------
// A wall-to-wall QSO used to push the beacon a whole interval on every check, so
// an active station never appeared on the HB map. It must now come due within the
// defer ceiling (interval + MAX_DEFER) and fire the instant the radio frees.
{
  const hb = new Js8Heartbeat();
  hb.configure({enabled: true, intervalMs: 15 * MIN}, 0);
  let firstDue = null;
  for (let t = 15 * MIN; t <= 30 * MIN; t += 5000) {
    hb.evaluate(ctx({nowMs: t, txBusy: true}));         // radio busy on every check
    if (firstDue === null && hb.dueInMs(t) <= 0) firstDue = t;
  }
  check(firstDue !== null && firstDue <= 15 * MIN + 2 * MIN + 5000,
    "a busy radio must let the beacon come due within one interval + the defer ceiling");
  check(hb.evaluate(ctx({nowMs: 30 * MIN, txBusy: false})).send,
    "the beacon fires as soon as the radio frees");
}

// --- an ACK-heavy band must not starve our own broadcast beacon (regression) -
// Acking others used to reset our beacon a whole interval each time, so a station
// that answered many heartbeats never announced itself. Distinct calls (dodging
// the 55 min per-call window) keep the ACKs succeeding.
{
  const callFor = i => `DL1${String.fromCharCode(65 + Math.floor(i / 26) % 26)}` +
                       `${String.fromCharCode(65 + i % 26)}`;
  const hb = new Js8Heartbeat({restrictions: new Js8Restrictions()});
  hb.configure({enabled: true, ackEnabled: true, intervalMs: 15 * MIN}, 0);
  let sent = 0, station = 0;
  for (let t = 0; t <= 60 * MIN; t += 5000) {
    if (t % 30000 === 0) hb.handleHeartbeat({from: callFor(station++), snr: -10}, ctx({nowMs: t}));
    if (hb.evaluate(ctx({nowMs: t})).send) { hb.noteSent(t); sent += 1; }
  }
  check(sent >= 3, "our own beacon must still fire on an ACK-heavy band");
}

// --- an ACK slips only an imminent beacon, and only within the ceiling -------
{
  const hb = new Js8Heartbeat({restrictions: new Js8Restrictions()});
  hb.configure({enabled: true, ackEnabled: true, intervalMs: 15 * MIN}, 0);
  const near = 15 * MIN - 8000;   // 8 s before due, inside the one-frame guard
  hb.handleHeartbeat({from: "N0CALL", snr: -5}, ctx({nowMs: near}));
  check(hb.dueInMs(near) === POSTPONE_GUARD_MS,
    "an ACK bounded-defers our own beacon when it is imminent");
}

// --- a faulted beacon retries rather than waiting a whole interval -----------
// checkHeartbeat marks the beacon sent up front (so it cannot double-fire); if the
// TX then faults, noteFault must pull the retry to the next quiet frame.
{
  const hb = new Js8Heartbeat();
  hb.configure({enabled: true, intervalMs: 15 * MIN}, 0);
  hb.noteSent(15 * MIN);                 // beacon marked sent -> next one interval out
  check(hb.dueInMs(15 * MIN) === 15 * MIN, "a sent beacon schedules one interval out");
  hb.noteFault(15 * MIN + 1000);         // ...but that TX faulted ~1 s later
  check(hb.dueInMs(15 * MIN + 1000) === POSTPONE_GUARD_MS,
    "a faulted beacon retries in the next quiet frame, not a whole interval later");
}

if (!process.exitCode)
  console.log("HEARTBEAT PASS speeds=Slow,Normal,Fast offset=500-1000Hz " +
    "ackWindow=55min busyDefers=bounded activityPostpones=true beaconNeverStarved=true");
