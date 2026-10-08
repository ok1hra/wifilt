// Minimal versioned, validated settings store for the Mercury page --
// data/js8-settings.js's own freqTimetable slice, standalone. Mercury needed
// no settings persistence at all before the 2026-08-23 grill-me (no operator
// RF-power choice, no per-mode profile); the frequency timetable is the
// first thing this page must remember across a reload, so this is the
// smallest store that can hold it rather than a trimmed copy of the JS8 one
// dragging along fields Mercury has no use for (modem choice, groups,
// heartbeat interval, ...).
//
// localStorage is the cache the page draws from; since 2026-10-07 the station
// keeps the authority (the "mercury" half of /js8-config.json, see
// data/station-profile.js and save() below), the same move JS8's own schedule
// made: where the station listens cannot depend on which screen is open.
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

  // Every save also goes to the station (data/station-profile.js, the
  // "mercury" half of /js8-config.json), debounced there: the band schedule is
  // where the station listens, the same fact JS8's own schedule moved to the
  // station for, and on the station it is also in the SETUP backup.
  // `localOnly` is for taking the station's own copy over. Resolved at call
  // time, so this file stays independent of the order the scripts load in.
  let stationWriter = null;
  function pushToStation(settings) {
    const profile = typeof globalThis !== "undefined" ? globalThis.StationProfile : null;
    if (!profile || !profile.writer) return;
    if (!stationWriter) stationWriter = profile.writer("mercury", 1500);
    stationWriter(settings);
  }

  function save(storage, input, options) {
    const settings = normalize(input);
    try { storage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
    catch (_error) { /* private mode, or storage full -- the page keeps running in memory */ }
    if (!(options && options.localOnly)) pushToStation(settings);
    return settings;
  }

  // Whether the operator ever saved a schedule in this browser, as opposed to
  // load() handing back the defaults -- only that may become the station's.
  function isSaved(storage) {
    try { return !!(storage && storage.getItem(STORAGE_KEY)); }
    catch (_error) { return false; }
  }

  return {STORAGE_KEY, SCHEMA_VERSION, TIMETABLE_SLOTS, TIMETABLE_MIN_HZ, TIMETABLE_MAX_HZ,
          normalizeTimetable, defaults, normalize, load, save, isSaved};
});
