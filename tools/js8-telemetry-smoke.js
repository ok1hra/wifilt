#!/usr/bin/env node
"use strict";

// The rules of the TELEMETRY panel, checked against a clock this file controls.
// A browser can show that a message went out; only a fake clock can show that the
// SECOND one did not -- and "does not transmit" is most of what this feature is.

const T = require("../data/js8-telemetry.js");

const MIN = 60000;
const hex16 = value => {            // uint16/int16 little-endian, as TrxNet sends it
  const raw = value < 0 ? value + 0x10000 : value;
  return (raw & 0xff).toString(16).padStart(2, "0").toUpperCase() +
         ((raw >> 8) & 0xff).toString(16).padStart(2, "0").toUpperCase();
};

const wx = (tempCenti, humCenti, ageS = 0) => ({topics: [
  {p: "WX.11", t: "/temp", v: hex16(tempCenti), a: ageS},
  {p: "WX.11", t: "/hum",  v: hex16(humCenti),  a: ageS}
]});

const JOB = {
  id: "wx", name: "WX", enabled: true, to: "@WX", periodMin: 60,
  fields: [
    {peer: "WX.11", topic: "/temp"},
    {peer: "WX.11", topic: "/hum"}
  ]
};

const armed = (job = JOB, nowMs = 0) => {
  const engine = new T.Js8Telemetry({});
  engine.setEnabled(true, nowMs);
  engine.configure([job], nowMs);
  return engine;
};

// --- decoding ---------------------------------------------------------------

// int16 hundredths, the encoding /temp and /pa-temp both use. The signed half is
// the one that bites: an amplifier below freezing reads as 655 °C unsigned.
const decodesSigned = T.formatValue(hex16(-1250), {type: "int16", div: 100, dec: 1, unit: "C"}) === "-12.5C";
const decodesUnsigned = T.formatValue(hex16(2134), {type: "uint16", div: 100, dec: 1, unit: "C"}) === "21.3C";
// A wrong type is the mistake the panel's live preview exists to catch, so it must
// produce a visibly wrong number rather than throwing.
const wrongTypeIsVisible = T.formatValue("7E80", {type: "uint16", div: 10, dec: 2}) === "3289.40" &&
  T.formatValue("7E80", {type: "int16", div: 10, dec: 2}) === "-3264.20";
// Zero is a real reading, so "cannot decode" must never collapse into it.
const undecodableIsNull = T.decodeRaw("", "uint16") === null &&
  T.decodeRaw("ZZ", "uint16") === null &&
  T.decodeRaw("00", "uint16") === null &&      // one byte offered for a two-byte type
  T.decodeRaw("0000", "uint16") === 0;

// --- the alphabet trap ------------------------------------------------------

// "%" survives (dense/JSC codeword), "°" does not exist in JS8 at all and would
// truncate the message from that character on.
const percentIsSendable = T.validateText("%") && T.validateText("M/S") && T.validateText("HPA");
const degreeIsRefused = !T.validateText("°C");
const degreeUnitIsDropped = T.normalizeField({peer: "WX.11", topic: "/temp", unit: "°C"}).unit === "";
const lowercaseUnitSurvives = T.normalizeField({peer: "WX.11", topic: "/windavg", unit: "m/s"}).unit === "M/S";

// --- rendering --------------------------------------------------------------

const rendered = T.renderJob(JOB, wx(2134, 5500));
const rendersLabelValueUnit = rendered.text === "TEMP 21.3C HUM 55%";
const catalogFillsLabels = T.normalizeField({peer: "WX.11", topic: "/windavg"}).label === "WIND";
const customTypeOverridesCatalog = T.normalizeField(
  {peer: "OI3.05", topic: "/temp", type: "uint16", div: 10, dec: 2}).div === 10;

// --- rule 1: an identical message is not sent -------------------------------

const engine = armed();
engine.noteSent("wx", "TEMP 21.3C HUM 55%", 0);
const unchangedIsRefused = engine.evaluate(JOB, wx(2134, 5500)).send === false &&
  engine.evaluate(JOB, wx(2134, 5500)).reason === "unchanged";
// The whole reason the comparison is on rendered text: 21.34 -> 21.31 at one decimal
// is still "21.3", and beaconing it again would be noise. 21.37 would NOT be jitter --
// it rounds to 21.4 and genuinely says something new.
const jitterBelowResolutionIsRefused = engine.evaluate(JOB, wx(2131, 5500)).send === false &&
  engine.evaluate(JOB, wx(2137, 5500)).send === true;
const realChangeIsSent = engine.evaluate(JOB, wx(2151, 5500)).send === true;
// SEND NOW has to get through, or a freshly configured job could never be tried.
const forceBeatsUnchanged = engine.evaluate(JOB, wx(2134, 5500), {force: true}).send === true;

// --- rule 2: a silent source drops out --------------------------------------

// One hour is this job's period, so a reading older than that is a dead sensor.
const staleSnapshot = {topics: [
  {p: "WX.11", t: "/temp", v: hex16(2134), a: 4000},   // 66 min: past the period
  {p: "WX.11", t: "/hum",  v: hex16(5500), a: 30}
]};
const staleRender = T.renderJob(JOB, staleSnapshot);
const staleFieldDropsOut = staleRender.text === "HUM 55%" &&
  staleRender.dropped.length === 1 && staleRender.dropped[0].topic === "/temp";
const allStaleSendsNothing = (() => {
  const both = {topics: staleSnapshot.topics.map(row => ({...row, a: 4000}))};
  const fresh = armed();
  return T.renderJob(JOB, both).text === "" &&
    fresh.evaluate(JOB, both).send === false &&
    fresh.evaluate(JOB, both).reason === "no fresh readings";
})();
// A source that has never been heard is not the same as a stale one, but it drops
// out the same way -- and says which it was.
const neverHeardDropsOut = T.renderJob(JOB, {topics: []}).dropped
  .every(field => field.reason === "never heard");

// --- the schedule -----------------------------------------------------------

const scheduleArmsAPeriodOut = engine.dueInMs("wx", 0) === 60 * MIN;
const nothingDueBeforePeriod = armed().dueJob(59 * MIN) === null;
const dueAtPeriod = armed().dueJob(60 * MIN) !== null;

// Two jobs falling due together must not key back to back.
const gapHoldsBetweenJobs = (() => {
  const second = {...JOB, id: "pa", name: "PA", to: "OK1ABC"};
  const both = new T.Js8Telemetry({});
  both.setEnabled(true, 0);
  both.configure([JOB, second], 0);
  const first = both.dueJob(60 * MIN);
  if (!first) return false;
  both.noteQueued(first.id, 60 * MIN);
  const immediately = both.dueJob(60 * MIN + 1000);       // still inside the 2 min floor
  const later = both.dueJob(60 * MIN + T.MIN_GAP_MS + 1);
  return immediately === null && later !== null && later.id !== first.id;
})();

// Queuing re-arms at once, so a message waiting behind a QSO cannot come due twice.
const queuingRearmsImmediately = (() => {
  const local = armed();
  local.noteQueued("wx", 60 * MIN);
  return local.dueJob(60 * MIN + 1) === null && local.dueInMs("wx", 60 * MIN) === 60 * MIN;
})();

// ...but the counter and the comparison text move only when the air time really
// happened. A failed transmission must not consume the change that prompted it.
const failedSendDoesNotConsumeTheChange = (() => {
  const local = armed();
  local.noteQueued("wx", 60 * MIN);                 // queued, then TX faults: no noteSent
  const next = local.evaluate(JOB, wx(2134, 5500));
  return next.send === true && local.snapshot(0).sent === 0;
})();

const manualSendCountsAndRearms = (() => {
  const local = armed();
  local.noteQueued("wx", 10 * MIN);                 // SEND NOW at t=10 min
  local.noteSent("wx", "TEMP 21.3C HUM 55%", 10 * MIN);
  return local.snapshot(10 * MIN).sent === 1 &&
    local.dueInMs("wx", 10 * MIN) === 60 * MIN;
})();

// --- surviving a reload -----------------------------------------------------

const runtimeSurvivesReload = (() => {
  const before = armed();
  before.noteQueued("wx", 60 * MIN);
  before.noteSent("wx", "TEMP 21.3C HUM 55%", 60 * MIN);
  const saved = JSON.parse(JSON.stringify(before.snapshotRuntime()));
  const after = new T.Js8Telemetry({});
  after.configure([JOB], 61 * MIN);
  after.restore(saved, 61 * MIN);
  const snap = after.snapshot(61 * MIN);
  return snap.sent === 1 && snap.enabled === true &&
    after.evaluate(JOB, wx(2134, 5500)).reason === "unchanged";
})();

// An overdue schedule read back after a long refresh must not fire on load.
const reloadDoesNotFireImmediately = (() => {
  const after = new T.Js8Telemetry({});
  after.configure([JOB], 0);
  after.restore({enabled: true, jobs: {wx: {dueMs: -5 * MIN, sent: 3, lastText: ""}}}, 0);
  return after.dueJob(0) === null && after.dueInMs("wx", 0) === 60 * MIN;
})();

// --- guards -----------------------------------------------------------------

const disabledJobNeverComesDue = (() => {
  const local = armed({...JOB, enabled: false});
  return local.dueJob(120 * MIN) === null && local.dueInMs("wx", 0) === null;
})();
const masterSwitchStopsEverything = (() => {
  const local = armed();
  local.setEnabled(false, 0);
  return local.dueJob(120 * MIN) === null && local.snapshot(0).dueInMs === null;
})();
const jobWithoutRecipientIsRefused =
  armed().evaluate({...JOB, to: ""}, wx(2134, 5500)).reason === "no recipient";
const jobWithoutFieldsIsRefused =
  armed().evaluate({...JOB, fields: []}, wx(2134, 5500)).reason === "no fields";
// The hour floor is the point of the whole schedule; nothing shorter may be stored.
const periodFloorIsAnHour = Math.min(...T.PERIOD_CHOICES_MIN) === 60 &&
  T.normalizeJob({...JOB, periodMin: 5}).periodMin === 60;

const checks = {
  decodesSigned, decodesUnsigned, wrongTypeIsVisible, undecodableIsNull,
  percentIsSendable, degreeIsRefused, degreeUnitIsDropped, lowercaseUnitSurvives,
  rendersLabelValueUnit, catalogFillsLabels, customTypeOverridesCatalog,
  unchangedIsRefused, jitterBelowResolutionIsRefused, realChangeIsSent, forceBeatsUnchanged,
  staleFieldDropsOut, allStaleSendsNothing, neverHeardDropsOut,
  scheduleArmsAPeriodOut, nothingDueBeforePeriod, dueAtPeriod, gapHoldsBetweenJobs,
  queuingRearmsImmediately, failedSendDoesNotConsumeTheChange, manualSendCountsAndRearms,
  runtimeSurvivesReload, reloadDoesNotFireImmediately,
  disabledJobNeverComesDue, masterSwitchStopsEverything,
  jobWithoutRecipientIsRefused, jobWithoutFieldsIsRefused, periodFloorIsAnHour
};

const pass = Object.values(checks).every(Boolean);
console.log(`JS8 TELEMETRY ${pass ? "PASS" : "FAIL"} ${JSON.stringify(checks)}`);
if (!pass) process.exitCode = 1;
