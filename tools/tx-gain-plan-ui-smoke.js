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

if (failures) {
  console.error(`${failures}/${checks} checks failed`);
  process.exitCode = 1;
} else console.log(`${checks}/${checks} checks passed`);
