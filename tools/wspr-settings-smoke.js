#!/usr/bin/env node
"use strict";

// The WSPR page writes the station locator into the settings blob that data.js
// owns (docs/wspr-majak-implementace.md decision 14). That is the right call --
// the locator is a property of the station, so fixing it on arrival at a
// portable site should fix it for JS8LAN too -- but it means one page mutates
// another page's storage.
//
// The failure this guards is silent and nasty: a save that normalises away a
// field would wipe JS8LAN's frequency timetable, heartbeat settings or groups,
// and nobody would notice until the next transmission that did not happen.
//
// So this replays exactly what wspr.js does (load -> Object.assign on
// modems.js8call -> save) against a fully populated v8 blob and checks that
// everything else survives byte for byte.

const Js8Settings = require("../data/js8-settings.js");
const WsprCore = require("../data/wspr-core.js");

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

function makeStorage(initial) {
  return {
    value: initial === undefined ? null : initial,
    getItem() { return this.value; },
    setItem(_key, value) { this.value = value; },
    removeItem() { this.value = null; },
  };
}

// A blob with every corner of the v8 schema populated, so anything the save path
// drops shows up rather than defaulting back to the same value by luck.
function populated() {
  const settings = Js8Settings.defaults();
  Object.assign(settings.modems.js8call, {
    myCall: "OK1HRA", grid: "JN79QI", speed: "B", txOffsetHz: 1234,
    clockCorrectionMs: -37, autoTiming: false, followSpeed: false,
    txGain: 0.55, txSafetyAccepted: true, auto: true, armHours: 24,
    infoText: "beacon test", statusText: "QRV", hb: true, hbAck: false,
    hbMinutes: 30, groups: ["@ALLCALL", "@HB", "@OK"], cqRepeatMin: 10,
  });
  settings.ui.disclosures = {spectrum: false, reply: false, traffic: true,
    stations: true, inbox: true, settings: true, timing: true};
  settings.freqTimetable = {enabled: true,
    slots: {0: {hz: 14078000, band: "20m"}, 27: {hz: 7078000, band: "40m"},
            47: {hz: 3578000}}};
  return settings;
}

// Exactly what data/wspr.js does.
function wsprSaveShared(storage, patch) {
  const settings = Js8Settings.load(storage).settings;
  Object.assign(settings.modems.js8call, patch);
  return Js8Settings.save(storage, settings);
}

// ---- what normalisation does on ANY save -----------------------------------
//
// Js8Settings.save normalises, and two of those normalisations rewrite input:
// infoText is upper-cased, and the always-on groups are stripped because they
// are implicit rather than stored. data.js goes through the same path on every
// one of its own saves, so this is house style, not damage -- but it has to be
// recorded, or the round-trip test below looks like it is hiding a bug.
{
  const normalised = Js8Settings.normalize(populated());
  check("infoText is upper-cased by normalisation",
    normalised.modems.js8call.infoText, "BEACON TEST");
  check("always-on groups are not stored",
    normalised.modems.js8call.groups, ["@OK"]);
  check("normalisation is idempotent",
    Js8Settings.normalize(normalised), normalised);
}

// ---- the round trip --------------------------------------------------------
//
// The bar is not "the blob is untouched" -- it is "the WSPR page's write is
// indistinguishable from JS8LAN saving the same blob with one field changed".
// Anything more lenient would miss a dropped timetable; anything stricter would
// fail on normalisation that data.js performs anyway.

{
  const before = Js8Settings.normalize(populated());
  const storage = makeStorage(JSON.stringify(before));

  wsprSaveShared(storage, {grid: "JO70FB"});
  const after = Js8Settings.load(storage).settings;

  check("the locator is what the WSPR page wrote", after.modems.js8call.grid, "JO70FB");

  // Everything else, field by field, so a failure names the casualty.
  const js8Before = before.modems.js8call, js8After = after.modems.js8call;
  for (const key of Object.keys(js8Before)) {
    if (key === "grid") continue;
    check(`modems.js8call.${key} survives`, js8After[key], js8Before[key]);
  }
  check("the frequency timetable survives", after.freqTimetable, before.freqTimetable);
  check("UI disclosures survive", after.ui, before.ui);
  check("the active modem survives", after.activeModem, before.activeModem);
  check("the schema version is unchanged", after.schemaVersion, before.schemaVersion);

  // The strongest form: identical to what JS8LAN itself would have stored.
  const expected = Js8Settings.normalize(populated());
  expected.modems.js8call.grid = "JO70FB";
  check("the result matches a JS8LAN save with only the locator changed",
    after, expected);
}

{
  // Writing the callsign too, which the page does from its own field.
  const storage = makeStorage(JSON.stringify(populated()));
  wsprSaveShared(storage, {myCall: "OK1ABC", grid: "JN89"});
  const after = Js8Settings.load(storage).settings;
  const expected = Js8Settings.normalize(populated());
  expected.modems.js8call.myCall = "OK1ABC";
  expected.modems.js8call.grid = "JN89";
  check("a callsign and locator write touches nothing else", after, expected);
}

{
  // Repeated saves must be idempotent: the beacon rewrites the locator every
  // time the operator edits the field, and drift across saves would be a slow
  // corruption rather than an obvious one.
  const storage = makeStorage(JSON.stringify(populated()));
  wsprSaveShared(storage, {grid: "JO70FB"});
  const first = storage.getItem();
  for (let round = 0; round < 5; round++) wsprSaveShared(storage, {grid: "JO70FB"});
  check("repeated identical saves are idempotent", storage.getItem(), first);
}

{
  // A blob that has never been written: the page must not crash and must not
  // invent a locator.
  const storage = makeStorage(null);
  const result = wsprSaveShared(storage, {grid: "JN79"});
  ok("saving into empty storage works", result.status === "saved", result.status);
  check("only the locator is set", Js8Settings.load(storage).settings.modems.js8call.grid, "JN79");
  check("everything else is at defaults",
    Js8Settings.load(storage).settings.freqTimetable, {enabled: false, slots: {}});
}

// ---- what the page is allowed to write -------------------------------------

{
  // js8-settings rejects a malformed locator and falls back rather than storing
  // it, so the page must validate BEFORE saving. This pins that the validation
  // in wspr-core and the one in js8-settings agree about what is acceptable.
  const storage = makeStorage(JSON.stringify(populated()));
  wsprSaveShared(storage, {grid: "NONSENSE"});
  const after = Js8Settings.load(storage).settings.modems.js8call.grid;
  ok("a malformed locator never reaches storage as-is", after !== "NONSENSE", after);

  for (const locator of ["JN79", "JN79QI", "JO70FB"]) {
    const store = makeStorage(JSON.stringify(populated()));
    wsprSaveShared(store, {grid: locator});
    check(`js8-settings accepts what wspr-core produces: ${locator}`,
      Js8Settings.load(store).settings.modems.js8call.grid, locator);
    // And the WSPR encoder accepts it back, which is the loop that matters.
    check(`wspr-core reads back its own locator: ${locator}`,
      WsprCore.normalizeLocator(locator).locator, locator);
  }
}

{
  // Coordinates typed into SETUP become a six-character locator, and that has to
  // be storable -- a six-character grid that js8-settings rejected would send the
  // beacon out with a stale square. (Typed in SETUP now, not here: the page shows
  // this value and cannot edit it.)
  const locator = require("../data/station-identity.js").parseLocator("50.0755, 14.4378");
  check("coordinates produce a six-character locator", locator, "JO70FB");
  const storage = makeStorage(JSON.stringify(populated()));
  wsprSaveShared(storage, {grid: locator});
  check("a locator derived from coordinates round-trips",
    Js8Settings.load(storage).settings.modems.js8call.grid, "JO70FB");
  check("and the four characters that go on air are correct",
    WsprCore.normalizeLocator(locator).transmitted, "JO70");
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
