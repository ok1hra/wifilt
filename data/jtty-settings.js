// Versioned, validated settings store for the JTTY page and QRPlog's JTTY
// palette, same shape as data/rtty-settings.js: localStorage first as the cache,
// the "jtty" half of /js8-config.json (data/station-profile.js) as the station's
// authority -- except rxHz/txHz, which are where this browser listens and
// sends right now (StationProfile.BROWSER_ONLY).
//
// rxHz/txHz are the lowest tone's audio frequency, as WSJT-X displays and
// reports it; the signal occupies about rxHz-16 .. rxHz+110 Hz.
(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.JttySettings = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const STORAGE_KEY = "wifilt.data.jtty-settings";
  const SCHEMA_VERSION = 1;
  const TONE_MIN_HZ = 200;
  const TONE_MAX_HZ = 2800;
  const FTOL_CHOICES_HZ = [20, 50, 100, 200, 500];
  // Where the receiver looks besides RX +- F Tol. "wsjtx" is upstream's own
  // fixed 1350/1650 +- 150 Hz; the wider ones cost CPU (docs/jtty-implementace.md §4.6).
  const SEARCH = Object.freeze({
    wsjtx: {lowHz: 1200, highHz: 1800, label: "1200–1800 Hz (as WSJT-X)"},
    wide: {lowHz: 500, highHz: 2500, label: "500–2500 Hz"},
    full: {lowHz: 200, highHz: 2900, label: "200–2900 Hz"},
  });
  const PROFILES = ["unknown", "field-day", "rtty-roundup"];
  const LIVE_IDLE_CHOICES_S = [5, 10, 20, 30, 60];

  function defaults() {
    return {
      v: SCHEMA_VERSION,
      rxHz: 1500, txHz: 1500, holdTx: false,
      ftolHz: 100, search: "wsjtx",
      profile: "unknown", exchange: "001",
      liveEntry: true, liveIdleS: 20,
      rfPercent: null,
      fkeys: null,       // null = the eight WSJT-X defaults (JttyCodec.DEFAULT_FKEYS)
    };
  }

  const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

  function normalize(input) {
    const s = input && typeof input === "object" ? input : {};
    const d = defaults();
    const rxHz = Math.round(Number(s.rxHz)), txHz = Math.round(Number(s.txHz));
    const rfPercent = Number(s.rfPercent);
    const fkeys = Array.isArray(s.fkeys) && s.fkeys.length === 8 && s.fkeys.every(k => typeof k === "string")
      ? s.fkeys.map(k => k.slice(0, 80)) : null;
    return {
      v: SCHEMA_VERSION,
      rxHz: inRange(rxHz, TONE_MIN_HZ, TONE_MAX_HZ) ? rxHz : d.rxHz,
      txHz: inRange(txHz, TONE_MIN_HZ, TONE_MAX_HZ) ? txHz : d.txHz,
      // Hold TX: the TX offset stays where it is when RX moves. Off by default
      // -- JTTY is worked like RTTY, answering on the caller's frequency.
      holdTx: s.holdTx === true,
      ftolHz: FTOL_CHOICES_HZ.indexOf(Number(s.ftolHz)) >= 0 ? Number(s.ftolHz) : d.ftolHz,
      search: Object.prototype.hasOwnProperty.call(SEARCH, s.search) ? s.search : d.search,
      profile: PROFILES.indexOf(s.profile) >= 0 ? s.profile : d.profile,
      exchange: typeof s.exchange === "string" ? s.exchange.slice(0, 13).toUpperCase() : d.exchange,
      liveEntry: s.liveEntry !== false,
      liveIdleS: LIVE_IDLE_CHOICES_S.indexOf(Number(s.liveIdleS)) >= 0 ? Number(s.liveIdleS) : d.liveIdleS,
      rfPercent: inRange(rfPercent, 1, 100) ? Math.round(rfPercent) : d.rfPercent,
      fkeys,
    };
  }

  function load(storage) {
    try {
      const raw = storage && storage.getItem(STORAGE_KEY);
      if (!raw) return defaults();
      try { return normalize(JSON.parse(raw)); } catch (_error) { return defaults(); }
    } catch (_error) { return defaults(); }
  }

  let stationWriter = null;
  function pushToStation(settings) {
    const profile = typeof globalThis !== "undefined" ? globalThis.StationProfile : null;
    if (!profile || !profile.writer) return;
    if (!stationWriter) stationWriter = profile.writer("jtty", 1500);
    stationWriter(settings);
  }

  function save(storage, input, options) {
    const settings = normalize(input);
    try { storage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
    catch (_error) { /* private mode, or storage full -- the page keeps running in memory */ }
    if (!(options && options.localOnly)) pushToStation(settings);
    return settings;
  }

  function isSaved(storage) {
    try { return !!(storage && storage.getItem(STORAGE_KEY)); }
    catch (_error) { return false; }
  }

  return {STORAGE_KEY, SCHEMA_VERSION, TONE_MIN_HZ, TONE_MAX_HZ, FTOL_CHOICES_HZ, SEARCH,
    PROFILES, LIVE_IDLE_CHOICES_S, defaults, normalize, load, save, isSaved};
});
