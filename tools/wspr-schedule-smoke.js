#!/usr/bin/env node
"use strict";

// Ordered WSPR timetable: change points, six-minute per-band invariant and the
// single prediction path shared by the countdown, preview and beacon.

const WsprCore = require("../data/wspr-core.js");

let failures = 0, checks = 0;
function ok(name, condition, detail = "") {
  checks++;
  if (condition) return;
  failures++;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}
function same(name, actual, expected) {
  const got = JSON.stringify(actual), wanted = JSON.stringify(expected);
  ok(name, got === wanted, `expected ${wanted}, got ${got}`);
}

const DAY0 = Date.UTC(2026, 6, 30);
const DAY_NUMBER = Math.floor(DAY0 / 86400000);
const schedule = (timetable, extra = {}) => ({timetable, ...extra});
const change = (slot, bands) => ({slot, bands});

// ---- 24-hour change list ----------------------------------------------------

const dayNight = schedule([
  change(17, ["20m", "15m", "10m"]),       // 08:30
  change(40, ["160m", "80m", "40m"]),      // 20:00
]);

same("before the first change the final sequence wraps through midnight",
     WsprCore.sequenceAt(0, dayNight).map(value => value.band),
     ["160m", "80m", "40m"]);
same("08:30 activates the day sequence in operator order",
     WsprCore.sequenceAt(17, dayNight).map(value => value.band),
     ["20m", "15m", "10m"]);
same("the day sequence lasts until the next change",
     WsprCore.sequenceAt(39, dayNight).map(value => value.band),
     ["20m", "15m", "10m"]);
same("20:00 activates the night sequence",
     WsprCore.sequenceAt(40, dayNight).map(value => value.band),
     ["160m", "80m", "40m"]);

const cleaned = WsprCore.timetableEntries(schedule([
  change(20, ["20m", "20m", "bogus", "15m"]),
  change(20, ["80m", "40m"]),
  change(99, ["10m"]),
]));
same("invalid bands, duplicate bands and invalid times are removed",
     cleaned.map(entry => [entry.slot, entry.bands.map(value => value.band)]),
     [[20, ["80m", "40m"]]]);

// ---- exact sequence and minimum gap ----------------------------------------

function framesFrom(slot, settings, count) {
  const first = slot * WsprCore.FRAMES_PER_SLOT;
  return WsprCore.daySequence(DAY_NUMBER, settings)
    .slice(first, first + count).map(value => value && value.band);
}

same("three bands run continuously in the order selected",
     framesFrom(17, dayNight, 6),
     ["20m", "15m", "10m", "20m", "15m", "10m"]);
same("one band leaves two frames silent",
     framesFrom(0, schedule([change(0, ["40m"])]), 6),
     ["40m", null, null, "40m", null, null]);
same("two bands leave the third frame silent",
     framesFrom(0, schedule([change(0, ["80m", "20m"])]), 6),
     ["80m", "20m", null, "80m", "20m", null]);
same("four bands use the explicit four-frame cycle",
     framesFrom(0, schedule([change(0, ["80m", "20m", "15m", "10m"])]), 8),
     ["80m", "20m", "15m", "10m", "80m", "20m", "15m", "10m"]);

function gapReport(settings, days = 365) {
  const last = new Map();
  let keyed = 0, violations = 0, worst = Infinity;
  for (let day = 0; day < days; day++) {
    const sequence = WsprCore.daySequence(DAY_NUMBER + day, settings);
    sequence.forEach((hit, frame) => {
      if (!hit) return;
      keyed++;
      const at = day * WsprCore.FRAMES_PER_DAY + frame;
      const previous = last.get(hit.band);
      if (previous !== undefined && at - previous < WsprCore.MIN_BAND_GAP_FRAMES) {
        violations++;
        worst = Math.min(worst, at - previous);
      }
      last.set(hit.band, at);
    });
  }
  return {keyed, violations, worst: Number.isFinite(worst) ? worst : null};
}

const transitions = [
  dayNight,
  schedule([change(0, ["40m"])]),
  schedule([change(1, ["40m", "20m"]), change(2, ["40m", "15m", "10m"])]),
  schedule([change(17, ["20m", "15m", "10m"]), change(40, ["10m", "15m", "20m"])]),
  schedule([change(0, ["160m", "80m", "40m", "20m", "15m"])]),
];
const broken = transitions.map(value => gapReport(value))
  .filter(report => report.violations);
ok("every band keeps two empty slots for a full year, including change edges and midnight",
   broken.length === 0, JSON.stringify(broken));

// If a new schema starts with a band used in either previous frame, its first
// candidate is silenced rather than violating the invariant.
{
  const edge = schedule([
    change(0, ["20m", "15m", "10m"]),
    change(1, ["10m", "40m", "80m"]),
  ]);
  const around = WsprCore.daySequence(DAY_NUMBER, edge).slice(13, 19)
    .map(value => value && value.band);
  ok("a shared band at a schema boundary is silenced when necessary",
     around[2] === null, around.join(" "));
  ok("the boundary still satisfies the six-minute invariant",
     gapReport(edge, 30).violations === 0);
}

// A radio that repeatedly misses tight retunes can ask the same scheduler for
// one silent frame after each band change. The preview sees the identical flag.
{
  const slower = schedule([change(0, ["80m", "20m", "15m"])],
                          {spaceBandChanges: true});
  const sequence = WsprCore.daySequence(DAY_NUMBER, slower);
  const adjacent = sequence.filter((value, index) => value && sequence[index + 1]).length;
  ok("reduced pacing leaves no adjacent transmissions", adjacent === 0,
     `${adjacent} adjacent`);
  ok("reduced pacing still keeps the per-band gap",
     gapReport(slower, 30).violations === 0);
}

// ---- migration from the two old shapes -------------------------------------

{
  const mask = on => Array.from({length: 48}, (_, slot) => on.includes(slot) ? "1" : "0").join("");
  const old = {
    rotation: [
      {band: "80m", hz: 3568600, slots: mask([0, 1, 2])},
      {band: "20m", hz: 14095600, slots: mask([0, 1])},
      {band: "15m", hz: 21094600, slots: mask([0, 1])},
    ],
  };
  same("the matrix migrates to compressed ordered changes",
       WsprCore.timetableEntries(old).map(entry =>
         [entry.slot, entry.bands.map(value => value.band)]),
       [[0, ["80m", "20m", "15m"]], [2, ["80m"]], [3, []]]);
}

{
  const old = {slots: {
    0: {band: "40m", hz: 7038600},
    1: {band: "40m", hz: 7038600},
    2: {band: "20m", hz: 14095600},
  }};
  same("the oldest one-band slot map also migrates",
       WsprCore.timetableEntries(old).map(entry =>
         [entry.slot, entry.bands.map(value => value.band)]),
       [[0, ["40m"]], [2, ["20m"]], [3, []]]);
}

// ---- prediction helpers -----------------------------------------------------

const from = Date.UTC(2026, 6, 30, 8, 29, 1);
const planned = WsprCore.plannedFrames(from, 1, dayNight);
ok("plannedFrames follows the 08:30 change",
   planned.length && planned[0].slot.band === "20m",
   planned.slice(0, 4).map(frame => frame.slot.band).join(" "));
same("nextTransmission is the first planned frame",
     WsprCore.nextTransmission(from, dayNight), planned[0]);
ok("an empty timetable plans nothing",
   WsprCore.plannedFrames(from, 24, schedule([])).length === 0);

ok("slotLabel exposes all 30-minute boundaries",
   WsprCore.slotLabel(0) === "00:00" &&
   WsprCore.slotLabel(17) === "08:30" &&
   WsprCore.slotLabel(40) === "20:00" &&
   WsprCore.slotLabel(47) === "23:30");

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
