// RTTY-ICOM dial-frequency catalogue, same shape as data/js8-presets.js.
// Standard IARU Region 1 RTTY calling frequencies, HF bands only -- RTTY isn't
// practically worked on 160 m/60 m/6 m/2 m, so this intentionally doesn't mirror
// js8-presets.js's full 12-band list (grilled 2026-08-27, docs/rtty-implementace.md).
(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.RttyPresets = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const PRESETS = Object.freeze([
    {id: "80m", band: "80 m", frequencyHz: 3580000},
    {id: "40m", band: "40 m", frequencyHz: 7040000},
    {id: "30m", band: "30 m", frequencyHz: 10140000},
    {id: "20m", band: "20 m", frequencyHz: 14080000},
    {id: "17m", band: "17 m", frequencyHz: 18100000},
    {id: "15m", band: "15 m", frequencyHz: 21080000},
    {id: "12m", band: "12 m", frequencyHz: 24920000},
    {id: "10m", band: "10 m", frequencyHz: 28080000},
  ]);

  function formatFrequency(frequencyHz) {
    const hz = Math.max(0, Math.round(Number(frequencyHz) || 0));
    const mhz = Math.floor(hz / 1000000);
    const rest = String(hz % 1000000).padStart(6, "0");
    return `${mhz}.${rest.slice(0, 3)}.${rest.slice(3)}`;
  }

  function find(id) {
    return PRESETS.find(preset => preset.id === id) || null;
  }

  return {PRESETS, formatFrequency, find};
});
