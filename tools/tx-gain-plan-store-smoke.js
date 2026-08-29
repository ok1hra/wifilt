#!/usr/bin/env node
"use strict";

// Shared CAL PLAN persistence: one matrix, profile-specific frequencies, and
// result tables that remain physically separate.
const path = require("path");
const Cal = require(path.join(__dirname, "..", "data", "tx-gain-cal.js"));
const Store = require(path.join(__dirname, "..", "data", "tx-gain-plan-store.js"));

let checks = 0, failures = 0;
function check(name, condition, detail = "") {
  checks++;
  if (condition) return;
  failures++;
  console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
}

const files = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const fetchImpl = async (url, options = {}) => {
  if (options.method === "POST") files.set(url, JSON.parse(options.body));
  return {ok: true, json: async () => clone(files.get(url) || {})};
};
const toneBands = () => [
  {band: "160m", hz: 1836600}, {band: "40m", hz: 7038600},
  {band: "20m", hz: 14095600},
];
const mercuryBands = () => [
  {band: "40m", hz: 7103000}, {band: "20m", hz: 14105000},
];

(async () => {
  files.set("/txgain.json", {v: 2, entries: {"IC-705|20m|10": {gain: 0.2}},
    plan: {powers: [10, 50], rows: [
      {band: "160m", hz: 1836600, cells: [1, 0]},
      {band: "20m", hz: 14095600, cells: [1, 1]},
    ]}});
  files.set("/mercury-txgain.json", {v: 2,
    entries: {"IC-705|20m|10": {gain: 0.7}},
    plan: {powers: [20], rows: [
      {band: "20m", hz: 14105000, cells: [1]},
      {band: "40m", hz: 7103000, cells: [1]},
    ]}});
  files.set(Store.STORE_URL, {});

  const toneResults = new Cal.TxGainStore({fetchImpl});
  const mercuryResults = new Cal.TxGainStore({url: "/mercury-txgain.json", fetchImpl});
  const tonePlan = new Store.PlanStore({fetchImpl, profile: Store.PROFILE_TONE,
    bands: toneBands});
  const mercuryPlan = new Store.PlanStore({fetchImpl, profile: Store.PROFILE_MERCURY,
    bands: mercuryBands});

  await mercuryPlan.loadAndMigrate([
    {profile: Store.PROFILE_TONE, store: toneResults},
    {profile: Store.PROFILE_MERCURY, store: mercuryResults},
  ]);
  await tonePlan.load();

  check("the first non-empty legacy plan owns the shared matrix",
    tonePlan.plan().powers.join(",") === "10,50" && tonePlan.plan().rows.length === 2,
    JSON.stringify(tonePlan.plan()));
  check("Mercury only sees bands it supports",
    mercuryPlan.plan().rows.map(row => row.band).join(",") === "20m",
    JSON.stringify(mercuryPlan.plan().rows));
  check("tone frequency survives migration",
    tonePlan.plan().rows.find(row => row.band === "20m").hz === 14095600);
  check("Mercury contributes its profile frequency without replacing the matrix",
    mercuryPlan.plan().rows[0].hz === 14105000);
  check("result entries remain profile-specific",
    toneResults.entry("IC-705|20m|10").gain === 0.2 &&
    mercuryResults.entry("IC-705|20m|10").gain === 0.7);

  // Editing the visible Mercury subset shares powers/cells and its frequency,
  // while preserving the unsupported 160m row and tone frequency.
  await mercuryPlan.putPlan({powers: [10, 25, 50], rows: [
    {band: "20m", hz: 14106000, cells: [1, 0, 1]},
    {band: "40m", hz: 7103000, cells: [0, 1, 1]},
  ]});
  await tonePlan.load();
  const canonical = files.get(Store.STORE_URL);
  const row160 = canonical.rows.find(row => row.band === "160m");
  const row20 = canonical.rows.find(row => row.band === "20m");
  check("a profile cannot erase unsupported shared rows", Boolean(row160));
  check("unsupported rows remap their selections by power",
    row160.cells.join(",") === "1,1,0", row160.cells.join(","));
  check("editing Mercury frequency preserves the tone frequency",
    row20.hzByProfile[Store.PROFILE_TONE] === 14095600 &&
    row20.hzByProfile[Store.PROFILE_MERCURY] === 14106000,
    JSON.stringify(row20.hzByProfile));
  check("matrix powers and selected cells are shared",
    tonePlan.plan().powers.join(",") === "10,25,50" &&
    tonePlan.plan().rows.find(row => row.band === "20m").cells.join(",") === "1,0,1");

  // A visible band removed by Mercury is removed from the common matrix, while
  // its result entries are untouched.
  await mercuryPlan.putPlan({powers: [10, 25, 50], rows: [
    {band: "20m", hz: 14106000, cells: [1, 0, 1]},
  ]});
  check("removing a supported row removes it from the shared matrix",
    !files.get(Store.STORE_URL).rows.some(row => row.band === "40m"));
  check("plan edits never write either result table",
    files.get("/txgain.json").entries["IC-705|20m|10"].gain === 0.2 &&
    files.get("/mercury-txgain.json").entries["IC-705|20m|10"].gain === 0.7);

  // Re-running migration is a no-op: canonical matrix and edited frequencies win.
  const before = JSON.stringify(files.get(Store.STORE_URL));
  await mercuryPlan.loadAndMigrate([
    {profile: Store.PROFILE_TONE, store: toneResults},
    {profile: Store.PROFILE_MERCURY, store: mercuryResults},
  ]);
  check("migration is idempotent and never overwrites canonical values",
    JSON.stringify(files.get(Store.STORE_URL)) === before);

  // A versioned empty document is an operator choice, not a missing file.
  // It must not resurrect the legacy embedded matrix on the next page load.
  files.set(Store.STORE_URL, Store.emptyDoc());
  await tonePlan.loadAndMigrate([
    {profile: Store.PROFILE_TONE, store: toneResults},
  ]);
  check("a deliberately empty shared plan stays empty",
    files.get(Store.STORE_URL).rows.length === 0 && tonePlan.plan().rows.length === 0);

  // An interrupted global MOD transition is execution state, scoped to the
  // waveform profile. Tone pages share it; Mercury must neither see nor erase it.
  files.set(Store.STORE_URL, {v: 1, powers: [10], rows: [
    {band: "20m", cells: [1], hzByProfile: {
      [Store.PROFILE_TONE]: 14095600, [Store.PROFILE_MERCURY]: 14105000}},
  ]});
  await tonePlan.load();
  await tonePlan.putPending({from: 28, target: 104, corrections: 1,
    model: "IC-705", owner: {band: "20m", hz: 14095600, percent: 10}});
  await mercuryPlan.load();
  check("pending MOD transitions are profile-specific",
    tonePlan.pending().target === 104 && mercuryPlan.pending() === null);
  await mercuryPlan.putPending({from: 40, target: 80, corrections: 1,
    model: "IC-705", owner: {band: "20m", hz: 14105000, percent: 10}});
  await tonePlan.load();
  check("writing another profile preserves the tone transition",
    tonePlan.pending().target === 104);
  await tonePlan.putPlan(tonePlan.plan());
  await mercuryPlan.load();
  check("editing the shared matrix cancels every profile transition",
    tonePlan.pending() === null && mercuryPlan.pending() === null);

  if (failures) {
    console.error(`${failures}/${checks} checks failed`);
    process.exitCode = 1;
  } else console.log(`${checks}/${checks} checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
