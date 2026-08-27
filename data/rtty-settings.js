// Minimal versioned, validated settings store for the RTTY-ICOM page, same
// shape as data/mercury-settings.js (chosen over data/js8-settings.js as the
// template -- js8-settings.js carries modem/groups/heartbeat fields RTTY has
// no use for; grilled 2026-08-27, docs/rtty-implementace.md §2.3). Holds the
// kap.1 decisions that must survive a reload: Normal/Reverse (#3), squelch
// threshold (#4), TX method (#6), and the shared RX/TX tone (kap.5 -- RTTY is
// a "zero-beat" convention, one click sets both).
(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.RttySettings = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const STORAGE_KEY = "wifilt.data.rtty-settings";
  const SCHEMA_VERSION = 1;
  const TONE_MIN_HZ = 500;
  const TONE_MAX_HZ = 2700;
  const SQUELCH_MIN = 0;
  // Goertzel sum-of-squares magnitude over a 96-sample window (rtty-codec.js's
  // Decoder default): for a matched tone of amplitude A, magnitude ~ (N*A/2)^2,
  // so ~200 at a fairly weak A=0.3. 500 leaves headroom above that without the
  // 10000 ceiling this used to carry, which was ~50x wider than the actual
  // <input type="range" max="..."> in rtty.html could ever submit (code-review
  // -- kept the two in sync, rtty.js's boot sequence now sets the slider's
  // min/max from these constants instead of rtty.html carrying its own copy).
  const SQUELCH_MAX = 500;
  const TX_METHODS = ["audio", "fsk"];

  function defaults() {
    return {v: SCHEMA_VERSION, toneHz: 1500, reverse: false,
            squelchThreshold: 4, txMethod: "audio"};
  }

  function normalize(input) {
    const source = input && typeof input === "object" ? input : {};
    const d = defaults();
    const toneHz = Math.round(Number(source.toneHz));
    const squelchThreshold = Number(source.squelchThreshold);
    return {
      v: SCHEMA_VERSION,
      toneHz: Number.isFinite(toneHz) && toneHz >= TONE_MIN_HZ && toneHz <= TONE_MAX_HZ
        ? toneHz : d.toneHz,
      reverse: source.reverse === true,
      squelchThreshold: Number.isFinite(squelchThreshold) &&
        squelchThreshold >= SQUELCH_MIN && squelchThreshold <= SQUELCH_MAX
        ? squelchThreshold : d.squelchThreshold,
      txMethod: TX_METHODS.includes(source.txMethod) ? source.txMethod : d.txMethod,
    };
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

  return {STORAGE_KEY, SCHEMA_VERSION, TONE_MIN_HZ, TONE_MAX_HZ,
          SQUELCH_MIN, SQUELCH_MAX, TX_METHODS, defaults, normalize, load, save};
});
