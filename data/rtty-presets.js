// RTTY-ICOM dial-frequency catalogue, same shape as data/js8-presets.js.
// Standard IARU Region 1 RTTY calling frequencies. 160 m added back in
// despite the original "not practically worked" call (grilled 2026-08-28,
// item 6) -- still skips 60 m/6 m/2 m, where RTTY genuinely isn't practiced.
//
// lowHz/highHz (item 6, same session): the IARU Region 1 band-plan RTTY/data
// segment for each band, both edges -- NOT the whole amateur band. Used by
// rtty.js's offDialFrequency() to redden the frequency pill when the radio
// sits outside every one of these ranges. frequencyHz (the dial preset the
// menu tunes to) sits inside its own [lowHz,highHz] on every row.
(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.RttyPresets = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const PRESETS = Object.freeze([
    {id: "160m", band: "160 m", frequencyHz: 1838000, lowHz: 1838000, highHz: 1840000},
    {id: "80m", band: "80 m", frequencyHz: 3580000, lowHz: 3570000, highHz: 3600000},
    {id: "40m", band: "40 m", frequencyHz: 7040000, lowHz: 7040000, highHz: 7050000},
    {id: "30m", band: "30 m", frequencyHz: 10140000, lowHz: 10130000, highHz: 10150000},
    {id: "20m", band: "20 m", frequencyHz: 14080000, lowHz: 14070000, highHz: 14099000},
    {id: "17m", band: "17 m", frequencyHz: 18100000, lowHz: 18095000, highHz: 18109000},
    {id: "15m", band: "15 m", frequencyHz: 21080000, lowHz: 21070000, highHz: 21120000},
    {id: "12m", band: "12 m", frequencyHz: 24920000, lowHz: 24915000, highHz: 24929000},
    {id: "10m", band: "10 m", frequencyHz: 28080000, lowHz: 28070000, highHz: 28190000},
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
