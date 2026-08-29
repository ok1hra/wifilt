// Minimal versioned, validated settings store for the RTTY-ICOM page, same
// shape as data/mercury-settings.js (chosen over data/js8-settings.js as the
// template -- js8-settings.js carries modem/groups/heartbeat fields RTTY has
// no use for; grilled 2026-08-27, docs/rtty-implementace.md §2.3). Holds the
// kap.1 decisions that must survive a reload: Normal/Reverse (#3), squelch
// threshold (#4), and the shared RX/TX tone (kap.5 -- RTTY is a "zero-beat"
// convention, one click sets both).
//
// TX method (#6) lived here until 2026-08-28: audio-stream vs FSK-backend is
// no longer an operator choice, just what the radio's own current mode is
// (rtty.js decides straight from state.radio.mode). What replaced it -- FSK
// output internal GPIO vs external TrxNet device -- is a firmware/EEPROM-
// backed station setting (fskOutputMode/fskNetId, /log-config and
// /log-config/fsk), not a per-browser localStorage one here, since it must
// answer the same way for QRPLOG as for this page, from any computer -- see
// rtty.js's own loadFskConfig()/saveFskOutput().
//
// txPolarity (grilled 2026-08-28, 2nd session, item 3) IS per-browser
// localStorage, unlike fskOutputMode above: it is the AFSK encoder's own
// mark/space assignment, which is genuinely a property of how this operator
// has this page's audio tone set up, not of the station as a whole the way
// the FSK GPIO wiring is. Deliberately a field of its own rather than reusing
// `reverse` -- see its own comment below.
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

  // Squelch dB scale (grilled 2026-08-29): the raw magnitude above is what the
  // decoder actually compares against, but it means nothing to an operator --
  // "347" gives no sense of how tight the gate is, and the default of 4 sits
  // in the first 1% of the 0-500 slider, where a LINEAR slider has almost no
  // usable resolution. 10*log10(magnitude) reads as an ordinary ham-radio dB
  // figure AND spreads that same useful low end across most of the slider's
  // travel instead of compressing it into a sliver. magnitude=0 ("squelch
  // never gates" -- rtty.js's own header-pill on/off toggle, not a point on
  // this scale) has no dB equivalent and is handled separately by that pill;
  // the dB slider itself only ever sets a magnitude of 1 or more.
  const SQUELCH_DB_MIN = 0;                                    // magnitude 1
  const SQUELCH_DB_MAX = Math.round(10 * Math.log10(SQUELCH_MAX)); // ~27 dB at 500
  function squelchMagnitudeToDb(magnitude) {
    const m = Number(magnitude);
    if (!Number.isFinite(m) || m < 1) return SQUELCH_DB_MIN;
    return Math.max(SQUELCH_DB_MIN, Math.min(SQUELCH_DB_MAX, 10 * Math.log10(m)));
  }
  function squelchDbToMagnitude(db) {
    const d = Number(db);
    if (!Number.isFinite(d)) return 1;
    return Math.max(1, Math.min(SQUELCH_MAX, Math.round(Math.pow(10, d / 10))));
  }

  // AFC. Wide acquisition now requires the complete mark/space pair rather
  // than accepting whichever single carrier is louder, so it is no longer
  // ambiguous at SHIFT_HZ/2. The 180 Hz cap covers a full 170 Hz shift while
  // keeping both candidate carriers inside the narrowest 400% waterfall
  // window (550 Hz wide, centred on toneHz, with a little edge margin).
  // afcRateHzPerChar is Hz per 165 ms Baudot character
  // (RttyCodec.CHAR_DURATION_MS), not Hz/s -- the operator-facing unit the
  // user asked for as "more logical" than a raw per-second rate; rtty.js
  // converts to Hz/s internally for the actual slew integration.
  const AFC_RATE_MIN_HZ_PER_CHAR = 5, AFC_RATE_MAX_HZ_PER_CHAR = 85;
  const AFC_MAX_DEVIATION_MIN_HZ = 10, AFC_MAX_DEVIATION_HARD_CAP_HZ = 180;

  function defaults() {
    return {v: SCHEMA_VERSION, toneHz: 1500, reverse: false,
            squelchThreshold: 4, rfPercent: null, txPolarity: "normal",
            afcEnabled: false, afcRateHzPerChar: 60, afcMaxDeviationHz: 60,
            squelchNewlineEnabled: false};
  }

  function normalize(input) {
    const source = input && typeof input === "object" ? input : {};
    const d = defaults();
    const toneHz = Math.round(Number(source.toneHz));
    const squelchThreshold = Number(source.squelchThreshold);
    const rfPercent = Number(source.rfPercent);
    const afcRateHzPerChar = Number(source.afcRateHzPerChar);
    const afcMaxDeviationHz = Number(source.afcMaxDeviationHz);
    return {
      v: SCHEMA_VERSION,
      toneHz: Number.isFinite(toneHz) && toneHz >= TONE_CENTER_MIN_HZ && toneHz <= TONE_CENTER_MAX_HZ
        ? toneHz : d.toneHz,
      reverse: source.reverse === true,
      squelchThreshold: Number.isFinite(squelchThreshold) &&
        squelchThreshold >= SQUELCH_MIN && squelchThreshold <= SQUELCH_MAX
        ? squelchThreshold : d.squelchThreshold,
      rfPercent: Number.isFinite(rfPercent) && rfPercent >= 1 && rfPercent <= 100
        ? Math.round(rfPercent) : d.rfPercent,
      // Grilled 2026-08-28 (2nd session, item 3): what this station's OWN
      // AFSK encoder actually transmits -- deliberately its own field, not
      // reused from `reverse` above. `reverse` is RX-only decode
      // compatibility with a station whose TX happens to be inverted; a
      // shared switch would mean fixing a backward contact's decode also
      // flips this station's own TX polarity for the rest of the QSO.
      txPolarity: source.txPolarity === "reverse" ? "reverse" : d.txPolarity,
      afcEnabled: source.afcEnabled === true,
      afcRateHzPerChar: Number.isFinite(afcRateHzPerChar) &&
        afcRateHzPerChar >= AFC_RATE_MIN_HZ_PER_CHAR && afcRateHzPerChar <= AFC_RATE_MAX_HZ_PER_CHAR
        ? afcRateHzPerChar : d.afcRateHzPerChar,
      afcMaxDeviationHz: Number.isFinite(afcMaxDeviationHz) &&
        afcMaxDeviationHz >= AFC_MAX_DEVIATION_MIN_HZ && afcMaxDeviationHz <= AFC_MAX_DEVIATION_HARD_CAP_HZ
        ? afcMaxDeviationHz : d.afcMaxDeviationHz,
      // kap.13.4 (default flipped to OFF 2026-08-29, operator feedback after
      // first trying it on) -- same `=== true` gate as reverse/afcEnabled
      // above: missing/malformed input reads as "off".
      squelchNewlineEnabled: source.squelchNewlineEnabled === true,
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
          SQUELCH_MIN, SQUELCH_MAX, SQUELCH_DB_MIN, SQUELCH_DB_MAX,
          squelchMagnitudeToDb, squelchDbToMagnitude,
          AFC_RATE_MIN_HZ_PER_CHAR, AFC_RATE_MAX_HZ_PER_CHAR,
          AFC_MAX_DEVIATION_MIN_HZ, AFC_MAX_DEVIATION_HARD_CAP_HZ,
          defaults, normalize, load, save};
});
