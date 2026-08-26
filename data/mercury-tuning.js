// Mercury ARQ/RF-power tuning settings (docs/mercury-implementace.md §6.6,
// the 2026-08-23 grill-me). Deliberately a SEPARATE module and a SEPARATE
// server-side file from data/mercury-settings.js's own MercurySettings --
// that store is localStorage, per-browser, and scoped to the frequency
// timetable alone (ch.13, a personal browsing preference, same as JS8's own
// freqTimetable). This one is the opposite kind of setting: retry counts,
// mode ceiling and RF power are properties of the STATION, not the browser,
// so they live in one server-side blob (/mercury-tuning.json, same pattern
// as /mercury-txgain.json) and read the same everywhere this station is
// operated from -- exactly the drift [[station-identity-single-source]]
// already fixed once for callsign/locator. Giving the two concepts the same
// name/file would have made that distinction invisible to the next reader.
//
// Every field has a schema default, named in each comment below -- most
// match the C engine's own compiled-in default exactly. modeCeiling is the
// one deliberate exception: the engine's real compiled default is UNLIMITED
// (see its own comment below), and this module imposes DATAC3 as a JS-side
// safety policy on top of that, the same layering decision documented in
// [[mercury-ceiling-default-regression]]. An empty/missing document means
// "apply this module's own defaults", not "leave the engine at ITS defaults".
(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.MercuryTuning = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const STORE_URL = "/mercury-tuning.json";
  const SCHEMA_VERSION = 1;

  // arq_fsm.c's mode_rank(): 0=DATAC15 .. 5=QAM16C2. Only DATAC15/DATAC4/
  // DATAC3/DATAC1 are offered here -- DATAC17/QAM16C2 stay hard-blocked by
  // arq_bandwidth_allows_mode() regardless of this setting (this WASM
  // build's freedv modem does not have either compiled in), so offering them
  // as a ceiling choice would promise something the engine cannot do.
  const MODE_CEILING_RANKS = {DATAC15: 0, DATAC4: 1, DATAC3: 2, DATAC1: 3};
  const MODE_CEILING_NAMES = Object.keys(MODE_CEILING_RANKS);

  // Mirrors arq_protocol.h's own *_DEFAULT constants exactly -- shown in the
  // Settings UI as each field's placeholder/reset value, per the grill-me's
  // "every knob has a default" decision.
  const DEFAULTS = {
    v: SCHEMA_VERSION,
    retryCallSlots: 4,        // ARQ_CALL_RETRY_SLOTS_DEFAULT
    retryAcceptSlots: 4,      // ARQ_ACCEPT_RETRY_SLOTS_DEFAULT
    // Tried raising both to 7 on 2026-08-25 (compounding more retries against
    // the callint jitter below), on the theory that jittered retries are
    // close to independent draws so more of them should compound to a much
    // higher session success rate. Live testing did not show a clear
    // improvement over a small sample (arguably worse -- also makes a
    // genuinely bad session take longer to give up), so reverted to the
    // engine's own compiled defaults rather than keep an unproven change.
    // If revisited, needs a much larger sample to judge against pure jitter
    // alone.
    retryDataSlots: 10,       // ARQ_DATA_RETRY_SLOTS_DEFAULT
    retryDisconnectSlots: 2,  // ARQ_DISCONNECT_RETRY_SLOTS_DEFAULT
    callIntervalS: 0,         // ARQ_CALLINT_DEFAULT_S -- 0 = table default ("auto")
    retryDowngradeThreshold: 2, // ARQ_RETRY_DOWNGRADE_THRESHOLD_DEFAULT
    modeCeiling: "DATAC3",    // NOT ARQ_MODE_CEILING_RANK_DEFAULT (that's rank 5,
                              // unlimited) -- DATAC3 (rank 2) is this module's own
                              // deliberate safety policy default, applied on top of
                              // the engine's permissive one
    transferLimitKb: 200,     // MAX_TRANSFER_BYTES's own compiled default in mercury-worker.js
    rfPowerPercent: null,     // null = operator has not chosen one -- leave the radio alone, invent nothing
  };

  const TRANSFER_LIMIT_MIN_KB = 10;
  // MAX_TRANSFER_BYTES_HARD_CAP in mercury-worker.js (250 KiB) -- kept under
  // SESSION_BYTE_CAP (256 KiB, sim_endpoint.c's fixed upstream buffer).
  const TRANSFER_LIMIT_MAX_KB = 250;
  const CALLINT_MIN_S = 4.0; // ARQ_CALLINT_MIN_S -- the engine clamps below this anyway; validated here too so the UI never shows a value it cannot honour
  const CALLINT_MAX_S = 60.0; // sanity ceiling -- no engine constant needs one, but an unbounded field invites a typo that silently kills reconnection
  const RETRY_SLOTS_MIN = 0;
  const RETRY_SLOTS_MAX = 30; // generous headroom over every *_DEFAULT above; no engine ceiling exists, this is a UI sanity bound

  function clampInt(value, min, max, fallback) {
    // Number("") is 0, a perfectly finite number -- without this check a
    // blanked field clamped straight to `min` (0 rounds up into range)
    // instead of falling back to the schema default the empty field was
    // meant to mean, same distinction normalizeRfPowerPercent() already
    // makes explicit for its own null/undefined/"" case.
    if (value === "" || value === null || value === undefined) return fallback;
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  }

  function clampFloat(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  }

  // 0 is CALLINT's own "auto" sentinel (ARQ_CALLINT_DEFAULT_S) -- passes
  // through unclamped; any other value is floored at CALLINT_MIN_S exactly
  // like arq_protocol_call_retry_interval_s() would do on the read side.
  function normalizeCallInterval(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return 0;
    return clampFloat(n, CALLINT_MIN_S, CALLINT_MAX_S, fallback);
  }

  function normalizeModeCeiling(value) {
    const name = typeof value === "string" ? value.toUpperCase() : "";
    return Object.prototype.hasOwnProperty.call(MODE_CEILING_RANKS, name) ? name : DEFAULTS.modeCeiling;
  }

  function modeCeilingRank(name) {
    return Object.prototype.hasOwnProperty.call(MODE_CEILING_RANKS, name)
      ? MODE_CEILING_RANKS[name] : MODE_CEILING_RANKS[DEFAULTS.modeCeiling];
  }

  // rfPowerPercent is intentionally NOT range-clamped to [1,100] the way the
  // others are: null must survive normalize() unchanged (it means "no
  // choice made yet", not "0 %"), and mercury.js's own SET flow already
  // validates operator input before it ever reaches save().
  function normalizeRfPowerPercent(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 1 && n <= 100 ? n : null;
  }

  function normalize(input) {
    const source = input && typeof input === "object" ? input : {};
    return {
      v: SCHEMA_VERSION,
      retryCallSlots: clampInt(source.retryCallSlots, RETRY_SLOTS_MIN, RETRY_SLOTS_MAX, DEFAULTS.retryCallSlots),
      retryAcceptSlots: clampInt(source.retryAcceptSlots, RETRY_SLOTS_MIN, RETRY_SLOTS_MAX, DEFAULTS.retryAcceptSlots),
      retryDataSlots: clampInt(source.retryDataSlots, RETRY_SLOTS_MIN, RETRY_SLOTS_MAX, DEFAULTS.retryDataSlots),
      retryDisconnectSlots: clampInt(source.retryDisconnectSlots, RETRY_SLOTS_MIN, RETRY_SLOTS_MAX, DEFAULTS.retryDisconnectSlots),
      callIntervalS: normalizeCallInterval(source.callIntervalS, DEFAULTS.callIntervalS),
      retryDowngradeThreshold: clampInt(source.retryDowngradeThreshold, 1, RETRY_SLOTS_MAX, DEFAULTS.retryDowngradeThreshold),
      modeCeiling: normalizeModeCeiling(source.modeCeiling),
      transferLimitKb: clampInt(source.transferLimitKb, TRANSFER_LIMIT_MIN_KB, TRANSFER_LIMIT_MAX_KB, DEFAULTS.transferLimitKb),
      rfPowerPercent: normalizeRfPowerPercent(source.rfPowerPercent),
    };
  }

  function defaults() { return normalize({}); }

  // Same shape as tx-gain-cal.js's own TxGainStore: {url, fetchImpl}
  // constructor, .load() populates .doc, failure leaves .doc at schema
  // defaults and records .error rather than throwing -- a station with no
  // tuning file yet (the common case, freshly flashed) is not an error.
  class TuningStore {
    constructor(options = {}) {
      this.url = options.url || STORE_URL;
      this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
      this.doc = defaults();
      this.loaded = false;
      this.error = "";
    }

    async load() {
      try {
        const response = await this.fetchImpl(this.url, {cache: "no-store"});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const raw = await response.json();
        this.doc = normalize(raw);
        this.loaded = true;
        this.error = "";
      } catch (error) {
        this.error = String(error.message || error);
        this.loaded = false;
        this.doc = defaults();
      }
      return this.doc;
    }

    async save(input) {
      const doc = normalize(input);
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(doc),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.doc = doc;
      this.loaded = true;
      this.error = "";
      return doc;
    }
  }

  return {
    STORE_URL, SCHEMA_VERSION, DEFAULTS,
    MODE_CEILING_RANKS, MODE_CEILING_NAMES, modeCeilingRank,
    TRANSFER_LIMIT_MIN_KB, TRANSFER_LIMIT_MAX_KB, CALLINT_MIN_S, CALLINT_MAX_S,
    RETRY_SLOTS_MIN, RETRY_SLOTS_MAX,
    normalize, defaults, TuningStore,
  };
});
