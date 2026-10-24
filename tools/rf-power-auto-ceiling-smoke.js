#!/usr/bin/env node
"use strict";

// RfPowerAuto under a radio power ceiling.
//
// An IC-705 on its battery takes 100 % and stops at 5 W. The JS8 power bar keeps
// the operator's stored 100 % but writes only the 50 % the radio can deliver, and
// writes the full value again by itself once the ceiling goes away (DC back).

const path = require("path");
globalThis.WsprCore = require(path.join(__dirname, "..", "data", "wspr-core.js"));
globalThis.document = {activeElement: null};
const RfPowerAuto = require(path.join(__dirname, "..", "data", "rf-power-auto.js"));

let checks = 0, failures = 0;
function check(name, condition, detail = "") {
  checks++;
  if (condition) return true;
  failures++;
  console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  return false;
}

const node = () => ({value: "", textContent: "", hidden: true, disabled: false,
                     classList: {toggle() {}}});

function makePage({stored = 100, ceiling = null} = {}) {
  const page = {
    stored, ceiling,
    radio: {connected: true, transceiverType: "ICOM-LAN", tx: false, rfPower: 255, rfPowerSeen: true},
    writes: [],
    dom: {input: node(), set: node(), watts: node(), state: node(), field: node()},
  };
  page.auto = RfPowerAuto.create({
    dom: page.dom,
    targetPercent: () => page.stored,
    radio: () => page.radio,
    fullWatts: () => 10,
    formatWatts: watts => `${watts.toFixed(1)} W`,
    blocked: () => false,
    transmitting: () => false,
    command: async payload => {
      const level = parseInt(payload.data.slice(4, 6), 10) * 100 + parseInt(payload.data.slice(6, 8), 10);
      page.writes.push(WsprCore.civPercent(level));
      page.radio.rfPower = level;
    },
    waitForState: async predicate => { if (!predicate(page.radio)) throw new Error("timed out"); },
    onWrite: percent => { page.stored = percent; },
    render() {},
    ceilingPercent: () => page.ceiling,
    ceilingText: () => "IC-705 on battery: max 5 W = 50 %",
  });
  return page;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

(async () => {
  {
    const page = makePage({ceiling: 50});
    page.auto.onPollSuccess();
    await tick();
    check("on battery the stored 100 % is written as 50 %", page.writes.join() === "50", page.writes.join());
    check("the stored target is kept", page.stored === 100);
    page.auto.renderField();
    check("the field shows why", !page.dom.state.hidden &&
      /battery.*running at 50 %, 100 % returns/.test(page.dom.state.textContent), page.dom.state.textContent);
    check("the field still holds the operator's 100", page.dom.input.value === "100", page.dom.input.value);

    page.ceiling = null;
    page.auto.onPollSuccess();
    await tick();
    check("DC back: 100 % is written again without a SET", page.writes.join() === "50,100", page.writes.join());
  }

  {
    const page = makePage({ceiling: null});
    page.radio.rfPower = WsprCore.percentToLevel(100);
    page.auto.onPollSuccess();
    await tick();
    check("no ceiling, radio already there: nothing is written", page.writes.length === 0, page.writes.join());
    page.ceiling = 50;
    page.auto.onPollSuccess();
    await tick();
    check("a battery appearing mid-session caps the radio", page.writes.join() === "50", page.writes.join());
  }

  {
    const page = makePage({stored: 30, ceiling: 50});
    page.radio.rfPower = WsprCore.percentToLevel(30);
    page.auto.onPollSuccess();
    await tick();
    page.auto.renderField();
    check("a target under the ceiling is untouched and says nothing",
      page.writes.length === 0 && page.dom.state.hidden, page.dom.state.textContent);
  }

  {
    const page = makePage({stored: 30, ceiling: 50});
    page.radio.rfPower = WsprCore.percentToLevel(30);
    page.auto.onPollSuccess();
    await tick();
    page.dom.input.value = "80";
    page.auto.noteDraft();
    await page.auto.setFromField();
    check("SET 80 % on battery writes 50 % and stores 80 %",
      page.writes.join() === "50" && page.stored === 80, `${page.writes.join()} ${page.stored}`);
  }

  console.log(`${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
})();
