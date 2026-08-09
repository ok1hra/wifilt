#!/usr/bin/env node
"use strict";

// The activity grid's aggregation, tested without a browser.
//
// Colour precedence is the part of chapter 9 most likely to be quietly wrong: a
// cell that shows green while it holds one broken transmission is worse than no
// grid at all, because it hides exactly the thing the grid exists to surface.
// Keeping the aggregation pure is what lets that be checked here rather than by
// squinting at a screenshot.

const WsprLog = require("../data/wspr-log.js");

let failures = 0, checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) return true;
  failures++;
  console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  return false;
}
function ok(name, condition, detail = "") {
  return check(name + (detail ? ` (${detail})` : ""), Boolean(condition), true);
}

const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 26, 15, 30, 0);
const at = (daysAgo, hour, minute = 4) =>
  Date.UTC(2026, 6, 26 - daysAgo, hour, minute, 1);

const session = (slotUtcMs, status, extra = {}) => ({
  slotUtcMs, status, band: "20m", dialHz: 14095600, offsetHz: 1500,
  callsign: "OK1HRA", locator: "JN79", dbm: 37, reason: "", ...extra});

// ---- precedence ------------------------------------------------------------

for (const [worse, better] of [["broken", "missed"], ["missed", "suspect"],
                               ["suspect", "sent"], ["sent", "idle"]])
  ok(`${worse} outranks ${better}`, WsprLog.STATUS_RANK[worse] > WsprLog.STATUS_RANK[better]);

{
  // One broken transmission inside an hour that is otherwise clean must colour
  // the whole cell. This is the assertion the grid exists for.
  const records = [
    session(at(0, 10, 4), "sent"), session(at(0, 10, 6), "sent"),
    session(at(0, 10, 8), "broken", {reason: "TX buffer underrun"}),
    session(at(0, 10, 10), "sent"),
  ];
  const {cells, days} = WsprLog.summarise(records, {days: 28, nowUtcMs: NOW});
  const cell = cells[10][days - 1];
  check("a single broken transmission colours the hour", cell.status, "broken");
  check("the cell keeps every attempt", cell.records.length, 4);
  check("the cell counts each status", cell.counts, {sent: 3, broken: 1});
}

{
  const records = [session(at(0, 8), "sent"), session(at(0, 8, 6), "suspect")];
  const {cells, days} = WsprLog.summarise(records, {days: 28, nowUtcMs: NOW});
  check("suspect outranks sent in a cell", cells[8][days - 1].status, "suspect");
}

// ---- layout ----------------------------------------------------------------

{
  const {cells, days, firstDay, lastDay} = WsprLog.summarise([], {days: 7, nowUtcMs: NOW});
  check("24 rows", cells.length, 24);
  check("one column per day", cells[0].length, 7);
  check("window spans the requested days", (lastDay - firstDay) / DAY, 6);
  check("an empty log is all idle",
    cells.every(row => row.every(cell => cell.status === "idle")), true);
}

{
  // Today is the rightmost column, and the row is the UTC hour of the slot.
  const records = [session(at(0, 23), "sent"), session(at(6, 0), "broken")];
  const {cells, days, counted} = WsprLog.summarise(records, {days: 7, nowUtcMs: NOW});
  check("both records land in the window", counted, 2);
  check("today is the last column", cells[23][days - 1].status, "sent");
  check("six days ago is the first column", cells[0][0].status, "broken");
}

{
  // Anything outside the window is dropped rather than folded into an edge
  // column, which would silently misattribute old failures to today.
  const records = [session(at(30, 12), "broken"), session(at(0, 12), "sent")];
  const {counted, cells, days} = WsprLog.summarise(records, {days: 7, nowUtcMs: NOW});
  check("records outside the window are dropped", counted, 1);
  check("the surviving record is placed correctly", cells[12][days - 1].status, "sent");
}

{
  const junk = [{slotUtcMs: "not a number", status: "sent"}, {status: "sent"}, null];
  const {counted} = WsprLog.summarise(junk, {days: 7, nowUtcMs: NOW});
  check("malformed records are ignored", counted, 0);
  const unknown = [session(at(0, 1), "banana")];
  const {cells, days} = WsprLog.summarise(unknown, {days: 7, nowUtcMs: NOW});
  check("an unknown status is treated as missed, not as success",
    cells[1][days - 1].status, "missed");
}

// ---- totals ----------------------------------------------------------------

{
  const records = [session(at(0, 1), "sent"), session(at(0, 2), "sent"),
                   session(at(1, 3), "broken"), session(at(2, 4), "missed"),
                   session(at(3, 5), "suspect"), session(at(40, 6), "sent")];
  check("totals count the window only", WsprLog.totals(records, {days: 7, nowUtcMs: NOW}),
    {sent: 2, suspect: 1, missed: 1, broken: 1});
}

// ---- classification --------------------------------------------------------

check("a failure before keying is a missed slot",
  WsprLog.classify({completed: false, afterKeying: false}), "missed");
check("a failure after keying is broken",
  WsprLog.classify({completed: false, afterKeying: true}), "broken");
check("a clean transmission without a reference is sent",
  WsprLog.classify({completed: true, powerMeterRaw: 118, referenceRaw: 0}), "sent");
check("power within tolerance is sent",
  WsprLog.classify({completed: true, powerMeterRaw: 110, referenceRaw: 118}), "sent");
check("power far from the reference is suspect",
  WsprLog.classify({completed: true, powerMeterRaw: 40, referenceRaw: 118}), "suspect");
check("power far above the reference is also suspect",
  WsprLog.classify({completed: true, powerMeterRaw: 200, referenceRaw: 118}), "suspect");
check("exactly at the tolerance edge is still sent",
  WsprLog.classify({completed: true, powerMeterRaw: 118 * 1.2, referenceRaw: 118}), "sent");

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
