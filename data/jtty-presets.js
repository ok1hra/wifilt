// JTTY dial frequencies, same shape as data/rtty-presets.js. Taken from WSJT-X
// models/FrequencyList.cpp (v3.3.0-beta5), the program's own defaults -- not
// from the DXZone article, which differs on 160/80/40/17 m. All USB(-D); the
// signal sits at dial + audio offset. WSJT-X still calls them preliminary.
//
// lowHz/highHz is the dial range this page accepts as "on a JTTY channel": the
// preset itself, +-3 kHz, so a station that moved up for a clear spot is not
// reddened. jtty.js's offDialFrequency() reads it.
(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.JttyPresets = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const rows = [
    ["160m", "160 m", 1839000], ["80m", "80 m", 3572000], ["40m", "40 m", 7078000],
    ["30m", "30 m", 10140000], ["20m", "20 m", 14090000], ["17m", "17 m", 18104000],
    ["15m", "15 m", 21090000], ["12m", "12 m", 24920000], ["10m", "10 m", 28090000],
    ["6m", "6 m", 50160000], ["2m", "2 m", 144160000],
  ];
  const PRESETS = Object.freeze(rows.map(([id, band, frequencyHz]) =>
    Object.freeze({id, band, frequencyHz, lowHz: frequencyHz - 3000, highHz: frequencyHz + 3000})));

  function formatFrequency(frequencyHz) {
    const hz = Math.max(0, Math.round(Number(frequencyHz) || 0));
    const mhz = Math.floor(hz / 1000000);
    const rest = String(hz % 1000000).padStart(6, "0");
    return `${mhz}.${rest.slice(0, 3)}.${rest.slice(3)}`;
  }

  return {PRESETS, formatFrequency};
});
