// Minimal versioned, validated settings store for the RTTY-ICOM page, same
// shape as data/mercury-settings.js (chosen over data/js8-settings.js as the
// template -- js8-settings.js carries modem/groups/heartbeat fields RTTY has
// no use for; grilled 2026-08-27, docs/rtty-implementace.md §2.3). Holds the
// kap.1 decisions that must survive a reload: Normal/Reverse (#3), squelch
// threshold (#4), TX method (#6), and the shared RX/TX tone (kap.5 -- RTTY is
// a "zero-beat" convention, one click sets both).
//
// rfPercent (grilled 2026-08-27, second session, item 13) follows JS8's own
// rfPercent field verbatim: null means "nothing chosen, leave the radio
// alone" (data.js's own rfTargetPercent() comment), never a made-up default --
// there is no safe power to invent for a QSO mode nobody has configured yet.
// Zoom (100/200/400%, item 15) is deliberately NOT here -- grilled decision
// was in-memory only, always starts at 100% on load.
(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.RttySettings = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const STORAGE_KEY = "wifilt.data.rtty-settings";
  const SCHEMA_VERSION = 1;
  const TONE_MIN_HZ = 500;
  const TONE_MAX_HZ = 2700;
  // settings.toneHz itself stores the internal mark/space CENTRE, not the
  // SPACE value the operator actually sets (rtty.js's setToneFromSpaceHz()
  // clamps the operator's value to TONE_MIN_HZ/MAX_HZ, then adds this shift to
  // get the centre it persists) -- so the centre's own valid range is shifted
  // up by it, not the same [TONE_MIN_HZ, TONE_MAX_HZ] the operator-facing
  // value uses. 85 = RttyCodec.SHIFT_HZ/2 (170/2), duplicated as a literal
  // here rather than importing RttyCodec, since that shift is a fixed ham
  // RTTY protocol constant (kap.1 decision 2 -- never configurable) and this
  // file is deliberately load-order-independent of rtty-codec.js.
  //
  // code-review 2026-08-27 (second session, item 3 follow-up): before this,
  // normalize() checked the persisted centre against the operator-facing
  // [500,2700] range verbatim -- any space tone above ~2615 Hz (still inside
  // the field's own advertised range) produced a centre above 2700, which
  // silently failed that check and reset toneHz to the 1500 Hz default on the
  // very next save, discarding the operator's chosen tone with no warning.
  const CENTER_SHIFT_HZ = 85;
  const TONE_CENTER_MIN_HZ = TONE_MIN_HZ + CENTER_SHIFT_HZ;
  const TONE_CENTER_MAX_HZ = TONE_MAX_HZ + CENTER_SHIFT_HZ;
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
            squelchThreshold: 4, txMethod: "audio", rfPercent: null};
  }

  function normalize(input) {
    const source = input && typeof input === "object" ? input : {};
    const d = defaults();
    const toneHz = Math.round(Number(source.toneHz));
    const squelchThreshold = Number(source.squelchThreshold);
    const rfPercent = Number(source.rfPercent);
    return {
      v: SCHEMA_VERSION,
      toneHz: Number.isFinite(toneHz) && toneHz >= TONE_CENTER_MIN_HZ && toneHz <= TONE_CENTER_MAX_HZ
        ? toneHz : d.toneHz,
      reverse: source.reverse === true,
      squelchThreshold: Number.isFinite(squelchThreshold) &&
        squelchThreshold >= SQUELCH_MIN && squelchThreshold <= SQUELCH_MAX
        ? squelchThreshold : d.squelchThreshold,
      txMethod: TX_METHODS.includes(source.txMethod) ? source.txMethod : d.txMethod,
      rfPercent: Number.isFinite(rfPercent) && rfPercent >= 1 && rfPercent <= 100
        ? Math.round(rfPercent) : d.rfPercent,
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
          TONE_CENTER_MIN_HZ, TONE_CENTER_MAX_HZ,
          SQUELCH_MIN, SQUELCH_MAX, TX_METHODS, defaults, normalize, load, save};
});
