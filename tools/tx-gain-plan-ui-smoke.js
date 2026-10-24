#!/usr/bin/env node
"use strict";

// The topbar state is safety information, not decoration. A calibration found
// for the current band/power but measured at another global TRX MOD level must
// never be described as a different band.
const Ui = require("../data/tx-gain-plan-ui.js");

let checks = 0, failures = 0;
function check(name, condition, detail = "") {
  checks++;
  if (condition) return;
  failures++;
  console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
}

function renderButton(resolved, entries) {
  const value = {textContent: ""};
  const classes = new Map();
  const button = {title: "", querySelector: selector => selector === "b" ? value : null,
    classList: {toggle: (name, on) => classes.set(name, Boolean(on))}};
  const panel = Ui.create({mount: null,
    resultStore: {doc: {v: 2, entries}},
    planStore: {plan: () => ({powers: [100], rows: [
      {band: "20m", hz: 14095600, cells: [1]},
    ]})},
    cal: {resolved: () => resolved}, send: async () => {}, modelNumber: () => 5,
    wsprPresets: [], js8Presets: []});
  panel.button = button;
  panel.renderButton();
  return {text: value.textContent, title: button.title,
    red: classes.get("uncalibrated")};
}

const staleWhy = "measured at MOD level 28, the radio is on 104 — recalibrate 20m @ 100 %";
const stale = renderButton({gain: 0.25, calibrated: false, stale: true,
  band: "20m", percent: 100, why: staleWhy},
  {"IC-705|20m|100": {gain: 0.632, modLevel: 28}});
check("a MOD mismatch has its own explicit topbar state",
  stale.text === "TRX MOD DIFFERENT FROM MEASURED", stale.text);
check("the MOD mismatch tooltip says what differs", stale.title === staleWhy, stale.title);
check("the unsafe stale state remains red", stale.red === true);

const missing = renderButton({gain: 0.25, calibrated: false,
  band: "40m", percent: 100, why: "not calibrated for 40m @ 100 %"},
  {"IC-705|20m|100": {gain: 0.632, modLevel: 104}});
check("a genuinely different band keeps the original state",
  missing.text === "NOT FOR THIS BAND", missing.text);

const resumePanel = Ui.create({mount: null,
  resultStore: {
    entry: key => ({
      "IC-705|20m|10": {gain: 0.2, knee: 0.2, modLevel: 28},
      "IC-705|20m|100": {gain: 0.63, knee: 0.63, modLevel: 28},
    })[key] || null,
  },
  planStore: {plan: () => ({powers: [10, 100], rows: [
    {band: "20m", hz: 14095600, cells: [1, 1]},
  ]})},
  cal: {resolved: () => ({gain: 0.25, calibrated: false})},
  model: () => "IC-705", send: async () => {}, modelNumber: () => 5,
  wsprPresets: [], js8Presets: []});
const legacyResume = resumePanel.legacyTransition(104);
check("an old unmarked MOD mismatch infers a verification owner",
  legacyResume && legacyResume.owner && legacyResume.owner.band === "20m" &&
  legacyResume.owner.percent === 100 && legacyResume.target === 104,
  JSON.stringify(legacyResume));

// An IC-705 on its battery accepts 100 % and stops at 5 W. The run must leave the
// columns above the ceiling out -- and keep them in the stored plan for later.
async function ceilingRun(ceiling, powers) {
  globalThis.TxGainPlan = require("../data/tx-gain-plan.js");
  globalThis.TxGainCal = {entryKey: (model, band, percent) => `${model}|${band}|${percent}`};
  const panel = Ui.create({mount: null,
    resultStore: {entry: () => null},
    planStore: {plan: () => ({powers, rows: [
      {band: "20m", hz: 14095600, cells: powers.map(() => 1)},
    ]})},
    cal: {resolved: () => ({gain: 0.25, calibrated: false})},
    model: () => "IC-705", send: async () => {}, modelNumber: () => 705,
    radio: () => ({supplyVolts: 7.9}), onPlanChange: () => {},
    wsprPresets: [], js8Presets: []});
  panel.mod = {capability: {readable: true}, readLevel: async () => 40,
    readInput: async () => ({known: false}), readPowerCeiling: async () => ceiling};
  panel.blockingReason = () => "";
  panel.resumeTransitionFor = async () => null;
  panel.snapshotRadio = () => {};
  panel.pump = () => {};
  await panel.begin(false);
  return panel;
}

(async () => {
  const battery = {limited: true, percent: 50, watts: 5, battery: true,
    text: "IC-705 on battery: max 5 W = 50 %"};
  const capped = await ceilingRun(battery, [10, 50, 100]);
  const runPowers = capped.run ? capped.run.orderedCells().map(cell => cell.percent) : [];
  check("on battery the 100 % column is left out of the run",
    runPowers.join() === "10,50", runPowers.join());
  check("the stored plan keeps it", capped.plan.powers.join() === "10,50,100", capped.plan.powers.join());
  check("and the panel says why", /battery: max 5 W = 50 % — 100 % left out/.test(capped.message),
    capped.message);

  const nothing = await ceilingRun(battery, [80, 100]);
  check("a plan entirely above the ceiling does not start",
    !nothing.run && /every column is above/.test(nothing.message), nothing.message);

  const dc = await ceilingRun({limited: false, percent: 100}, [10, 50, 100]);
  const dcPowers = dc.run ? dc.run.orderedCells().map(cell => cell.percent) : [];
  check("on external power every column runs", dcPowers.join() === "10,50,100", dcPowers.join());
  report();
})();

function report() {
  if (failures) {
    console.error(`${failures}/${checks} checks failed`);
    process.exitCode = 1;
  } else console.log(`${checks}/${checks} checks passed`);
}
