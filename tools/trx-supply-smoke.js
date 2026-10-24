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

const full = TrxSupply.describe(radio({supplyVolts: 8.2}), "IC-705");
check("a full BP-272 shows four cells", full && full.battery && full.cells === 4 && !full.low,
  JSON.stringify(full));
check("and its voltage without a DC label", full && full.text === "8.2 V", full && full.text);
check("the tooltip admits the level is estimated", full && /estimated/.test(full.title), full && full.title);

const low = TrxSupply.describe(radio({supplyVolts: 7.1}), "IC-705");
check("a nearly empty pack is one cell and low", low && low.cells === 1 && low.low, JSON.stringify(low));

const dc = TrxSupply.describe(radio({supplyVolts: 13.8}), "IC-705");
check("13.8 V is external power, no gauge", dc && !dc.battery && dc.cells === 0 && dc.text === "DC 13.8 V",
  JSON.stringify(dc));

check("other radios show nothing", TrxSupply.describe(radio({supplyVolts: 13.8}), "IC-7610") === null);
check("an unknown model shows nothing", TrxSupply.describe(radio({supplyVolts: 8}), "") === null);
check("no reading yet shows nothing", TrxSupply.describe(radio({supplyVolts: 0}), "IC-705") === null);
check("a dropped link shows nothing",
  TrxSupply.describe(radio({connected: false, supplyVolts: 8}), "IC-705") === null);

const sag = TrxSupply.describe(radio({tx: true, supplyVolts: 7.3}), "IC-705", 8.1);
check("during TX the last receive reading is held", sag && sag.volts === 8.1 && sag.cells === 4,
  JSON.stringify(sag));

// render(): the element remembers the receive reading across calls.
const cells = [0, 1, 2, 3].map(() => ({on: false, classList: {toggle(_n, on) { this.owner.on = on; }}}));
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
  !classes.has("battery") && label.textContent === "DC 13.6 V", label.textContent);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
