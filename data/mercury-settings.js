// Minimal versioned, validated settings store for the Mercury page --
// data/js8-settings.js's own freqTimetable slice, standalone. Mercury needed
// no settings persistence at all before the 2026-08-23 grill-me (no operator
// RF-power choice, no per-mode profile); the frequency timetable is the
// first thing this page must remember across a reload, so this is the
// smallest store that can hold it rather than a trimmed copy of the JS8 one
// dragging along fields Mercury has no use for (modem choice, groups,
// heartbeat interval, ...).
(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.MercurySettings = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const STORAGE_KEY = "wifilt.data.mercury-settings";
  const SCHEMA_VERSION = 1;
  // Frequency timetable: 48 half-hour UTC slots (index 0 = 00:00, 47 = 23:30).
  // Same shape and same limits as data/js8-settings.js's own, so a slot value
  // copied between the two pages by hand needs no translation.
  const TIMETABLE_SLOTS = 48;
  const TIMETABLE_MIN_HZ = 1000;
  const TIMETABLE_MAX_HZ = 470000000;

  function normalizeTimetable(input) {
    const source = input && typeof input === "object" ? input : {};
    const rawSlots = source.slots && typeof source.slots === "object" ? source.slots : {};
    const slots = {};
    for (let index = 0; index < TIMETABLE_SLOTS; index++) {
      const value = rawSlots[index] ?? rawSlots[String(index)];
      if (!value || typeof value !== "object") continue;
      const hz = Math.round(Number(value.hz));
      if (!Number.isFinite(hz) || hz < TIMETABLE_MIN_HZ || hz > TIMETABLE_MAX_HZ) continue;
      const band = typeof value.band === "string" && value.band.trim()
        ? value.band.trim().slice(0, 8) : null;
      slots[index] = band ? {hz, band} : {hz};
    }
    return {enabled: source.enabled === true, slots};
  }

  function defaults() { return {v: SCHEMA_VERSION, freqTimetable: {enabled: false, slots: {}}}; }

  function normalize(input) {
    const source = input && typeof input === "object" ? input : {};
    return {v: SCHEMA_VERSION, freqTimetable: normalizeTimetable(source.freqTimetable)};
  }

  function load(storage) {
    try {
      const raw = storage && storage.getItem(STORAGE_KEY);
      if (!raw) return defaults();
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (_error) { return defaults(); }
      return normalize(parsed);
    } catch (_error) { return defaults(); }
  }

  function save(storage, input) {
    const settings = normalize(input);
    try { storage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
    catch (_error) { /* private mode, or storage full -- the page keeps running in memory */ }
    return settings;
  }

  return {STORAGE_KEY, SCHEMA_VERSION, TIMETABLE_SLOTS, TIMETABLE_MIN_HZ, TIMETABLE_MAX_HZ,
          normalizeTimetable, defaults, normalize, load, save};
});
