#!/usr/bin/env node
"use strict";

// The long-term station history behind the route scores, checked against a clock this file
// controls. The properties that matter are the ones a browser cannot show in one sitting:
// that re-delivered traffic does not count twice, that two tabs merge, that a month-old day
// falls out, and that "heard on the one day I listened" is not a perfect score.

const H = require("../data/js8-station-history.js");

const DAY = 86400000, HOUR = 3600000, MIN = 60000;
const T0 = Date.UTC(2026, 10, 13, 18, 30);   // a Friday evening, UTC

function memoryStorage(initial = {}) {
  const items = {...initial};
  return {items,
    getItem: key => (key in items ? items[key] : null),
    setItem: (key, value) => { items[key] = String(value); },
    removeItem: key => { delete items[key]; }};
}
const fresh = storage => new H.StationHistory({storage: storage || memoryStorage()});
// Listen for a whole hour on `band` at time t (enough minutes to credit it).
const listenHour = (hist, band, t) => { for (let i = 0; i < H.LISTEN_MINUTES_PER_HOUR; i++) hist.noteListening(band, t + i * MIN); };

// --- idempotence: the same snapshot twice, a restored replay, changes nothing
const idem = fresh();
idem.noteHeard("40m", "OK1AAA", -12, T0);
const once = JSON.stringify(idem.data);
idem.noteHeard("40m", "OK1AAA", -12, T0);
idem.noteHeard("40m", "ok1aaa", -15, T0 + 5 * MIN);   // weaker, same hour, lower case
idem.noteHearsMe("40m", "OK1AAA", T0); idem.noteHearsMe("40m", "OK1AAA", T0);
idem.noteLink("40m", "OK9TGT", "OK1AAA", T0); idem.noteLink("40m", "OK9TGT", "OK1AAA", T0);
const recA = idem.data.bands["40m"].s.OK1AAA[H.dayOf(T0)];
const snapshotTwiceIsNoop = once === JSON.stringify((() => { const x = fresh(); x.noteHeard("40m", "OK1AAA", -12, T0); x.noteHeard("40m", "OK1AAA", -12, T0); return x.data; })());
const bestSnrKept = recA[1] === -12 && H.popcount(recA[0]) === 1 && recA[2] === 1;
const heardImpliesListened = H.popcount(idem.data.bands["40m"].l[H.dayOf(T0)]) === 1;

// --- listening needs enough minutes before the hour counts
const lis = fresh();
for (let i = 0; i < H.LISTEN_MINUTES_PER_HOUR - 1; i++) lis.noteListening("20m", T0 + i * MIN);
const shortListenNotCredited = !(lis.data.bands["20m"].l[H.dayOf(T0)]);
lis.noteListening("20m", T0 + 20 * MIN);
const tenMinutesCredited = H.popcount(lis.data.bands["20m"].l[H.dayOf(T0)]) === 1;

// --- shrinkage: one day of one is far from perfect
const one = fresh();
one.noteHeard("40m", "OK1ONE", -5, T0);
const oneDay = one.stationScore("40m", "OK1ONE", T0);
const oneDayOfOneIsShrunk = oneDay.score < 50 && oneDay.confident === false && oneDay.listenDays === 1;

// --- consistency beats loudness: STEADY heard every evening at -18, LOUD once at +5
const cons = fresh();
for (let d = 0; d < 10; d++) {
  const t = T0 - d * DAY;
  listenHour(cons, "40m", t);
  cons.noteHeard("40m", "OK1STD", -18, t);
  if (d === 0) cons.noteHeard("40m", "OK1LUD", 5, t);
}
const steady = cons.stationScore("40m", "OK1STD", T0), loud = cons.stationScore("40m", "OK1LUD", T0);
const steadyBeatsLoud = steady.score > loud.score && steady.confident && steady.heardDays === 10;

// --- bars: a day without listening is null, a listened day without the station is 0
const bars = fresh();
listenHour(bars, "40m", T0);                       // today: listened, station absent
listenHour(bars, "40m", T0 - 2 * DAY);             // two days ago: listened...
bars.noteHeard("40m", "OK1BAR", -10, T0 - 2 * DAY);//   ...and heard
const week = bars.weekBars("40m", "OK1BAR", T0);
const sevenBars = week.length === 7 && week[6].day === H.dayOf(T0);
const noListenIsNull = week[5].ratio === null && week[0].ratio === null;
const listenedAbsentIsZero = week[6].ratio === 0;
const heardDayIsFull = week[4].ratio === 1 && week[4].best === -10;

// --- the window: a day 28+ days old falls out on save
const old = fresh();
old.noteHeard("40m", "OK1OLD", -10, T0 - 30 * DAY);
old.noteHeard("40m", "OK1NEW", -10, T0);
old.save(T0);
const oldDayPruned = !old.data.bands["40m"].s.OK1OLD && Boolean(old.data.bands["40m"].s.OK1NEW);

// --- half-life: an old good day weighs less than a recent one
const decay = fresh();
for (let d = 0; d < 20; d++) listenHour(decay, "40m", T0 - d * DAY);
for (let d = 0; d < 5; d++) decay.noteHeard("40m", "OK1REC", -10, T0 - d * DAY);
for (let d = 15; d < 20; d++) decay.noteHeard("40m", "OK1PST", -10, T0 - d * DAY);
const recentOutweighsPast = decay.stationScore("40m", "OK1REC", T0).score > decay.stationScore("40m", "OK1PST", T0).score;

// --- two tabs merge through storage instead of overwriting each other
const shared = memoryStorage();
const tabA = fresh(shared), tabB = fresh(shared);
tabA.noteHeard("40m", "OK1TBA", -10, T0);
tabB.noteHeard("40m", "OK1TBB", -11, T0 + HOUR);
tabA.save(T0 + 2 * HOUR); tabB.save(T0 + 2 * HOUR);
const reread = fresh(shared);
const twoTabsMerge = Boolean(reread.data.bands["40m"].s.OK1TBA) && Boolean(reread.data.bands["40m"].s.OK1TBB) &&
  H.popcount(reread.data.bands["40m"].l[H.dayOf(T0)]) === 2;
// a reset in one tab is not undone by the other tab's next save
tabA.reset(T0 + 3 * HOUR);
tabB.save(T0 + 3 * HOUR);
const resetWinsOverOtherTab = !fresh(shared).data.bands["40m"];

// --- caps: stations beyond the cap go, least recently heard first
const cap = fresh();
for (let i = 0; i < 405; i++) cap.noteHeard("40m", `OK${i}`, -10, T0 - (i % 20) * DAY);
cap.save(T0);
const capped = Object.keys(cap.data.bands["40m"].s);
// the five evicted are all from the oldest day (i % 20 === 19, twenty of them)
const stationCapHolds = capped.length === 400 && capped.includes("OK0") &&
  capped.filter(call => Number(call.slice(2)) % 20 === 19).length === 15;

// --- broken / hostile storage never throws, and an unwritable one still works in memory
const broken = fresh(memoryStorage({[H.STORAGE_KEY]: "{not json"}));
const garbage = fresh(memoryStorage({[H.STORAGE_KEY]: JSON.stringify({v: 1, bands: {"40m": {l: "x", s: {A: 3, B: {"1": "zz"}}, p: {"bad": {}}}}})}));
const throwing = new H.StationHistory({storage: {getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); }}});
throwing.noteHeard("40m", "OK1MEM", -10, T0);
const brokenStorageSurvives = Object.keys(broken.data.bands).length === 0 &&
  Object.keys(garbage.data.bands["40m"].s.B || {}).length === 0 &&
  throwing.save(T0) === false && throwing.stationScore("40m", "OK1MEM", T0).heardDays === 1;

// --- route score: pair history and the station's reliability both lift a route
const route = fresh();
for (let d = 0; d < 7; d++) {
  const t = T0 - d * DAY;
  listenHour(route, "40m", t);
  route.noteHeard("40m", "OK1RTA", -15, t);
  route.noteLink("40m", "OK9TGT", "OK1RTA", t);
  if (d < 2) route.noteHeard("40m", "OK1RTB", -15, t);
}
const rA = route.routeScore("40m", "OK1RTA", "OK9TGT", -12, T0);
const rB = route.routeScore("40m", "OK1RTB", "OK9TGT", -12, T0);
const routeFavoursHistory = rA.route > rB.route && rA.pair.pairDays === 7 && rB.pair.pairDays === 0 && rA.confident;
const routeNoNumberIsHalf = route.routeScore("40m", "OK1RTA", "OK9TGT", null, T0).fresh === 0.5;
// pair evidence counts in either direction
route.noteLink("40m", "OK1RTB", "OK9TGT", T0);
const pairEitherDirection = route.pairScore("40m", "OK9TGT", "OK1RTB", T0).pairDays === 1;

// --- bands are separate
const bandsSeparate = route.stationScore("20m", "OK1RTA", T0).heardDays === 0;

const checks = {
  snapshotTwiceIsNoop, bestSnrKept, heardImpliesListened,
  shortListenNotCredited, tenMinutesCredited,
  oneDayOfOneIsShrunk, steadyBeatsLoud,
  sevenBars, noListenIsNull, listenedAbsentIsZero, heardDayIsFull,
  oldDayPruned, recentOutweighsPast,
  twoTabsMerge, resetWinsOverOtherTab, stationCapHolds, brokenStorageSurvives,
  routeFavoursHistory, routeNoNumberIsHalf, pairEitherDirection, bandsSeparate
};

const pass = Object.values(checks).every(Boolean);
console.log(`JS8 STATION HISTORY ${pass ? "PASS" : "FAIL"} ${JSON.stringify(checks)}`);
if (!pass) process.exitCode = 1;
