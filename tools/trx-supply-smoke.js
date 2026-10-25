#!/usr/bin/env node
"use strict";

// The IC-705 supply indicator beside the RF power bar on the DATA pages.
// Battery or DC is decided from the Vd meter (15 15) the firmware already polls;
// the gauge is an estimate from the pack voltage, held during TX sag.

const path = require("path");
const TrxSupply = require(path.join(__dirname, "..", "data", "trx-supply.js"));

let checks = 0, failures = 0;
function check(name, condition, detail = "") {
  checks++;
  if (condition) return true;
  failures++;
  console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  return false;
}

const radio = fields => ({connected: true, tx: false, supplyVolts: 0, ...fields});

// Thresholds as read off the radio's own three-segment icon (BP-272, 2026-10-25):
// 3 down to 7.6 V, 2 down to 7.3 V, then 1, which turns red below 7.0 V.
const at = volts => TrxSupply.describe(radio({supplyVolts: volts}), "IC-705");
const full = at(8.2);
check("a full BP-272 shows three of three", full && full.battery && full.cells === 3 &&
  full.total === 3 && !full.low, JSON.stringify(full));
check("and its voltage", full && full.text === "8.2 V", full && full.text);
check("7.6 V is still three, 7.5 V two", at(7.6).cells === 3 && at(7.5).cells === 2,
  `${at(7.6).cells} ${at(7.5).cells}`);
check("7.3 V is still two, 7.2 V one", at(7.3).cells === 2 && at(7.2).cells === 1,
  `${at(7.3).cells} ${at(7.2).cells}`);
check("7.0 V is one and not red, 6.9 V one and red",
  at(7.0).cells === 1 && !at(7.0).low && at(6.9).cells === 1 && at(6.9).low,
  `${at(7.0).low} ${at(6.9).low}`);
check("the segments follow the shown tenth: 7.58 V reads 7.6 V and three",
  at(7.58).text === "7.6 V" && at(7.58).cells === 3, JSON.stringify(at(7.58)));

const dc = at(13.8);
check("13.8 V is external power, no gauge, the voltage shown", dc && !dc.battery && dc.cells === 0 &&
  dc.text === "13.8 V", JSON.stringify(dc));
check("the DC tooltip says charging cannot be seen", dc && /not the pack's or whether it is charging/.test(dc.title),
  dc && dc.title);

check("other radios show nothing", TrxSupply.describe(radio({supplyVolts: 13.8}), "IC-7610") === null);
check("an unknown model shows nothing", TrxSupply.describe(radio({supplyVolts: 8}), "") === null);
check("no reading yet shows nothing", TrxSupply.describe(radio({supplyVolts: 0}), "IC-705") === null);
check("a dropped link shows nothing",
  TrxSupply.describe(radio({connected: false, supplyVolts: 8}), "IC-705") === null);

const sag = TrxSupply.describe(radio({tx: true, supplyVolts: 7.3}), "IC-705", 8.1);
check("during TX the last receive reading is held", sag && sag.volts === 8.1 && sag.cells === 3,
  JSON.stringify(sag));

// render(): the element remembers the receive reading across calls.
const cells = [0, 1, 2].map(() => ({on: false, classList: {toggle(_n, on) { this.owner.on = on; }}}));
cells.forEach(cell => { cell.classList.owner = cell; });
const label = {textContent: ""};
const classes = new Set();
const el = {hidden: true, title: "",
  classList: {toggle: (name, on) => (on ? classes.add(name) : classes.delete(name))},
  querySelectorAll: () => cells, querySelector: () => label};
TrxSupply.render(el, radio({supplyVolts: 8.1}), "IC-705");
TrxSupply.render(el, radio({tx: true, supplyVolts: 7.2}), "IC-705");
check("render holds the gauge through a keyed over",
  !el.hidden && classes.has("battery") && cells.every(cell => cell.on) && label.textContent === "8.1 V",
  `${label.textContent} ${cells.map(cell => cell.on).join()}`);
TrxSupply.render(el, radio({supplyVolts: 13.6}), "IC-705");
check("plugging in DC switches the element to the voltage only",
  !classes.has("battery") && label.textContent === "13.6 V", label.textContent);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
