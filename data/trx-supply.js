// Power supply beside the RF power bar on the DATA pages (JS8Call, RTTY,
// Mercury): battery or DC, the voltage, and on battery a four-cell gauge.
//
// Only for radios whose row in icom-models.js says how to tell a battery from
// DC (batteryBelowVolts) -- today the IC-705. The source is supplyVolts in
// /state, which the firmware already polls as CI-V 15 15 (Vd meter); nothing
// here asks the radio anything. 1A 0B would name the supply directly, but the
// manual says the radio decides it "based on the current voltage" too, and a
// CI-V read from every page would compete for the one-slot /civread mailbox.
//
// A transmission sags the pack by a few tenths of a volt, which would make the
// gauge drop a cell on every over. The last receive-time reading is shown
// while the radio is keyed.

(function (root, factory) {
  const value = factory(
    typeof module === "object" && module.exports ? require("./icom-models.js") : root.IcomModels);
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.TrxSupply = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (IcomModels) {
  "use strict";

  // null = nothing to show. `rxVolts` is the caller's memory of the last
  // reading taken while not transmitting.
  function describe(radio, model, rxVolts = 0) {
    const row = IcomModels.findModel(model);
    if (!row || !(row.batteryBelowVolts > 0) || !radio || !radio.connected) return null;
    const live = Number(radio.supplyVolts) || 0;
    const volts = radio.tx && rxVolts > 0 ? rxVolts : live;
    if (!(volts > 0)) return null;
    const battery = volts < row.batteryBelowVolts;
    const steps = row.batteryLevelsV || [];
    const cells = battery ? steps.filter(threshold => volts >= threshold).length : 0;
    const low = battery && cells <= 1;
    const shown = `${volts.toFixed(1)} V`;
    return {
      battery, volts, cells, low,
      text: battery ? shown : `DC ${shown}`,
      title: battery
        ? `${row.label} on battery · ${volts.toFixed(2)} V · ${cells}/${steps.length} — estimated ` +
          "from the voltage of a 2-cell Li-ion pack; the radio reports no charge level" +
          (radio.tx ? " · held at the last receive reading while transmitting" : "")
        : `${row.label} on external power · ${volts.toFixed(2)} V`,
    };
  }

  // `el` is the static #trxSupply markup: <span class="bat"><i>×4</i></span><b></b>.
  function render(el, radio, model) {
    if (!el) return;
    if (radio && radio.connected && !radio.tx && Number(radio.supplyVolts) > 0)
      el.rxVolts = Number(radio.supplyVolts);
    const state = describe(radio, model, el.rxVolts || 0);
    el.hidden = !state;
    if (!state) return;
    el.classList.toggle("battery", state.battery);
    el.classList.toggle("low", state.low);
    el.querySelectorAll(".bat i").forEach((cell, index) => cell.classList.toggle("on", index < state.cells));
    const label = el.querySelector("b");
    if (label) label.textContent = state.text;
    el.title = state.title;
  }

  return {describe, render};
});
