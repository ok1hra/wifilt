// The RX audio level beside "Audio" on the DATA and WSPR pages: the dBFS
// number coloured by how usable that level is, and in front of it an upright
// bar drawn like the RF power bar -- segments with their own fixed colour by
// where they sit on the scale, the ones above the level dark as on an LED
// strip.
//
// The level is the RMS of the whole passband, so it is judged on band noise:
// the radio's audio reaches the page as 8-bit µ-law (the ICOM LAN stream and
// local-trx alike), whose steps start to eat the weakest signals once the
// noise falls below about -60 dBFS, and strong stations clip once the noise
// alone sits above about -20 dBFS. -40 dBFS on an empty stretch of band is
// the target; a busy band reads higher than that and is fine.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.AudioLevel = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  // Lower edge of each segment, bottom up. The scale spends its segments
  // where the level means something: everything under -60 dBFS is one "too
  // low" segment (so -61 lights one, not four), the usable -60..-20 range is
  // four of 10 dB, the hot -20..-10 two of 5 dB, and -10 and up is clip.
  // The -40 dBFS target lights four of eight, the middle of the bar.
  const EDGES = [-Infinity, -60, -50, -40, -30, -20, -15, -10];
  const MARKS = EDGES.length;
  const LOW_BELOW_DB = -60;
  const HOT_FROM_DB = -20;
  const CLIP_FROM_DB = -10;

  const TITLE = "RX audio level (RMS of the passband). On an empty stretch of band, " +
    "with only noise, aim for about -40 dBFS. Below -60 the weakest signals sink into " +
    "the audio's µ-law steps; noise alone above -20 leaves strong stations no headroom " +
    "and they clip. A busy band reads higher than the noise and that is fine.";

  function zone(db) {
    if (!Number.isFinite(db)) return "none";
    if (db < LOW_BELOW_DB) return "low";
    if (db < HOT_FROM_DB) return "ok";
    if (db < CLIP_FROM_DB) return "hot";
    return "clip";
  }

  // Mark i covers [EDGES[i], EDGES[i+1]); the one the level falls in is lit
  // too, so the topmost lit mark always has the number's colour. Any real
  // level lights at least the bottom mark; no reading (or digital silence,
  // -Infinity) lights none.
  function lit(db) {
    if (!Number.isFinite(db)) return 0;
    let count = 0;
    while (count < MARKS && EDGES[count] <= db) count++;
    return count;
  }

  // Each mark takes the zone of its lower edge (the bottom one is "low"), so
  // the bar reads low | ok | hot | clip from the bottom up whatever the level.
  function markZone(index) {
    return index === 0 ? "low" : zone(EDGES[index]);
  }

  // `meter` is an empty span the marks are built into on the first call;
  // `value` is the <b> carrying the number. Called for every audio block, so
  // the DOM is only touched where something changed.
  function render(meter, value, db) {
    const level = zone(db);
    if (value) {
      const text = Number.isFinite(db) ? `${Math.round(db)} dBFS` : "-- dBFS";
      if (value.textContent !== text) value.textContent = text;
      if (value.dataset.zone !== level) value.dataset.zone = level;
      const status = value.parentElement;
      if (status && !status.title) status.title = TITLE;
    }
    if (!meter) return;
    if (!meter.children.length) {
      for (let index = 0; index < MARKS; index++) {
        const mark = meter.ownerDocument.createElement("i");
        mark.dataset.zone = markZone(index);
        meter.appendChild(mark);
      }
    }
    const count = lit(db);
    if (meter.litCount === count) return;
    meter.litCount = count;
    Array.prototype.forEach.call(meter.children, (mark, index) => mark.classList.toggle("on", index < count));
  }

  return {zone, lit, markZone, render, MARKS};
});
