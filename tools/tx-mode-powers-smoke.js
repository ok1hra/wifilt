#!/usr/bin/env node
"use strict";

// tx-mode-powers.js names the RF power each tone mode transmits at, so CAL PLAN
// can offer all of them as columns and SETUP can label them. The numbers have to
// be the SAME ones each page uses, or the calibration it prompts lands on a power
// nothing transmits at -- so the WSPR case is checked against the dBm -> percent
// conversion the WSPR page itself makes.

const path = require("path");
const WsprCore = require(path.join(__dirname, "..", "data", "wspr-core.js"));
const Powers = require(path.join(__dirname, "..", "data", "tx-mode-powers.js"));

let checks = 0, failures = 0;
function check(name, condition, detail = "") {
  checks++;
  if (condition) return;
  failures++;
  console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
}

function storage(values) {
  return {getItem: key => (key in values ? JSON.stringify(values[key]) : null)};
}

{
  const modes = Powers.read({model: "IC-705", wsprCore: WsprCore, storage: storage({
    "wifilt.data.js8-settings": {modems: {js8call: {rfPercent: 30}}},
    "wifilt.wspr.v1": {powerDbm: 37},
    "wifilt.data.rtty-settings": {rfPercent: 50},
  })});
  const by = Object.fromEntries(modes.map(m => [m.mode, m.percent]));
  check("JS8 reads its own percentage", by.JS8 === 30, JSON.stringify(by));
  // 37 dBm = 5 W on a 10 W IC-705: the WSPR page writes level 128 = 50 %.
  check("WSPR converts its dBm through the radio's full power, as the page does",
    by.WSPR === WsprCore.civPercent(WsprCore.powerCommand(37, 10).level) && by.WSPR === 50,
    String(by.WSPR));
  check("RTTY reads its own percentage", by.RTTY === 50);
  check("two modes on one power share a column", Powers.modesAt(50, modes).join(",") === "WSPR,RTTY");
}

{
  // WSPR never chose: the page transmits at the lowest level it offers.
  const modes = Powers.read({model: "IC-7610", wsprCore: WsprCore,
    storage: storage({"wifilt.wspr.v1": {powerDbm: null}})});
  const wspr = modes.find(m => m.mode === "WSPR");
  const lowest = WsprCore.offeredPowerLevels(100, 10)[0];
  check("an unchosen WSPR level is the page's own default",
    wspr && wspr.detail === `${lowest} dBm`, wspr ? wspr.detail : "none");
}

{
  const modes = Powers.read({model: "", wsprCore: WsprCore, storage: storage({
    "wifilt.wspr.v1": {powerDbm: 37}, "wifilt.data.js8-settings": {modems: {js8call: {rfPercent: null}}}})});
  check("nothing is invented: no model, no WSPR; no JS8 choice, no JS8", modes.length === 0,
    JSON.stringify(modes));
  check("unreadable storage is no modes, not a crash",
    Powers.read({storage: {getItem: () => { throw new Error("denied"); }}}).length === 0);
}

{
  check("union keeps the caller's own powers first and caps at four",
    JSON.stringify(Powers.union([[30, 12], [5, 30, 50, 80]], 4)) === "[30,12,5,50]",
    JSON.stringify(Powers.union([[30, 12], [5, 30, 50, 80]], 4)));
  check("union drops nonsense", JSON.stringify(Powers.union([[0, -3, 101, "x", 7.4]])) === "[7]");
}

if (failures) { console.error(`TX MODE POWERS FAIL ${checks - failures}/${checks}`); process.exit(1); }
console.log(`TX MODE POWERS PASS ${checks}/${checks}`);
