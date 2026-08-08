// TX gain calibration: find the highest audio level the radio takes without
// its ALC acting. See docs/tx-auto-gain-implementace.md.
//
// The whole file is deliberately clock-free. Two independent reasons:
//
//  * The audio the browser writes reaches the radio a ring-depth later, so
//    "wait 500 ms and read the meter" measures the PREVIOUS level. What the
//    firmware does report is `consumed` -- how many mu-law bytes the radio has
//    actually played -- and that is an exact answer to "is the radio at the new
//    level yet". Every step here is therefore gated on bytes, not on time.
//  * A page in a background tab has its timers throttled to once a second or
//    worse, while WebSocket frames keep arriving. Anything clocked on timers
//    would stall exactly where the transmission does not.
//
// The other trap this encodes: a repeated ALC reading is not a new observation.
// The firmware only bumps `alcSeq` when the radio actually answered 15 13, so a
// sample counts once. Without that, one deflection would be read as several and
// the search would walk down past the knee it just found.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.TxGainCal = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  const ULAW_BYTES_PER_SECOND = 8000;

  const DEFAULTS = {
    // Cold start. Low enough to be clean on any sane setup, high enough not to
    // spend the whole carrier climbing; a stored knee overrides it anyway.
    startGain: 0.05,
    // Below the manual slider's 0.1: at 1 % RF power the knee lands near 0.008,
    // and mu-law holds ~28 dB SQNR there, so the level is usable even though the
    // slider cannot express it.
    floor: 0.004,
    // The manual slider's ceiling. Above this the honest conclusion is not "more
    // gain" but "the radio's MOD level or RF power is wrong".
    ceiling: 0.8,
    bracketRatio: 2,          // 6 dB steps while bracketing
    resolutionDb: 0.375,      // 6 -> 3 -> 1.5 -> 0.75 -> 0.375
    marginDb: 0,              // operator's choice: store the measured clean level
    rampBytes: 960,           // 120 ms -- amplitude changes are ramped, not stepped
    // How much of the new level must be played before a reading is about it.
    // Asymmetric on purpose. Upwards, ALC responds at once: 100 ms is plenty and
    // a fast answer is what keeps the step count inside a capped carrier.
    // Downwards, the meter has to FALL, and its ballistics are the radio's, not
    // ours -- a reading taken too soon still shows the level we just left, and
    // with a one-sample-condemns rule that would mark a clean level dirty and
    // walk the search down past the knee. 500 ms of played audio is the cheapest
    // honest answer; it costs about a third of a step.
    settleBytes: 800,         // 100 ms, after an increase
    settleDownBytes: 4000,    // 500 ms, after a decrease
    holdBytes: 16000,         // 2 s final verification at the chosen level
    cleanSamples: 2,          // ALC decays; one zero does not prove clean
    // No answer to 15 13 within this much played audio means the radio does not
    // report ALC at all. Bytes rather than seconds for the reasons above.
    alcSilenceBytes: 24000,   // 3 s
  };

  const toDb = ratio => 20 * Math.log10(ratio);
  const fromDb = db => Math.pow(10, db / 20);

  class TxGainCal {
    constructor(options = {}) {
      this.config = {...DEFAULTS, ...options};
      this.reset();
    }

    reset() {
      const {startGain, floor, ceiling} = this.config;
      this.state = "idle";
      this.phase = "";              // bracket-up | bracket-down | bisect | hold
      this.gain = clamp(startGain, floor, ceiling);
      this.error = "";
      this.steps = 0;
      this.alcMax = 0;
      this.alcSeen = false;
      this.reachedCeiling = false;
      this.result = null;
      // The bracket: highest level proven clean, lowest proven dirty.
      this.cleanGain = 0;
      this.dirtyGain = 0;
      this.sentBytes = 0;
      this.consumedBytes = 0;
      this.lastSeq = 0;
      this.stepFromBytes = 0;       // consumption at which the current level is live
      this.cleanRun = 0;
      this.stepSettleBytes = this.config.settleBytes;
      this.holdFromBytes = 0;
      this.holdBackoffs = 0;
      this.lastAlcBytes = 0;        // consumption when ALC last answered
    }

    // `knownKnee` is a seed, never a result: it only shortens the bracket. It is
    // deliberately entered 6 dB low so a stale entry cannot put an overdriven
    // carrier on the air for even one step.
    begin({knownKnee = 0} = {}) {
      this.reset();
      const {floor, ceiling, startGain, bracketRatio} = this.config;
      const seeded = knownKnee > 0 ? knownKnee / bracketRatio : startGain;
      this.gain = clamp(seeded, floor, ceiling);
      this.state = "searching";
      this.phase = "bracket-up";
      return this.snapshot();
    }

    fail(reason) {
      if (this.state === "failed") return this.snapshot();
      this.state = "failed";
      this.error = String(reason);
      return this.snapshot();
    }

    // Bytes the page has handed to the transport so far. The page reports it
    // rather than the module counting: only the page knows what it actually
    // wrote, and guessing here would put the byte offsets a packet out.
    noteSent(sentUlawBytes) {
      const bytes = Number(sentUlawBytes) || 0;
      if (bytes > this.sentBytes) this.sentBytes = bytes;
      return this.snapshot();
    }

    // One tx-level frame.
    noteLevel({consumed, alc, alcSeq} = {}) {
      if (this.state !== "searching" && this.state !== "holding") return this.snapshot();
      const played = Number(consumed);
      if (Number.isFinite(played) && played > this.consumedBytes) this.consumedBytes = played;

      const seq = Number(alcSeq) || 0;
      if (seq > this.lastSeq) {
        this.lastSeq = seq;
        this.alcSeen = true;
        this.lastAlcBytes = this.consumedBytes;
        this.observe(Number(alc) || 0);
      } else if (!this.alcSeen && this.consumedBytes >= this.config.alcSilenceBytes) {
        // Not an error in the radio and not a bug here: plenty of transceivers
        // simply do not answer 15 13. Say which one it is instead of running the
        // search to the ceiling and blaming the MOD level.
        return this.fail("radio does not report ALC");
      }
      return this.snapshot();
    }

    // A reading is only about the level the radio is actually playing. Anything
    // taken before the new level is live describes the previous step.
    observe(alcRaw) {
      if (this.consumedBytes < this.stepFromBytes + this.stepSettleBytes) return;
      if (alcRaw > this.alcMax) this.alcMax = alcRaw;
      const dirty = alcRaw > 0;
      if (this.state === "holding") return this.observeHold(dirty);

      if (dirty) {
        // One reading is enough to condemn a level. Declaring dirty early costs
        // a fraction of a dB; declaring it late puts a distorted signal out.
        // Safe only because of the asymmetric settle above -- without it, a
        // meter still falling from the previous level would condemn this one.
        this.cleanRun = 0;
        this.dirtyGain = this.dirtyGain ? Math.min(this.dirtyGain, this.gain) : this.gain;
        this.advance();
        return;
      }
      // Clean needs corroboration, because the meter falls back to zero on its
      // own schedule after the level drops.
      this.cleanRun += 1;
      if (this.cleanRun < this.config.cleanSamples) return;
      this.cleanRun = 0;
      this.cleanGain = Math.max(this.cleanGain, this.gain);
      this.advance();
    }

    observeHold(dirty) {
      if (!dirty) {
        this.cleanRun += 1;
        if (this.consumedBytes - this.holdFromBytes < this.config.holdBytes) return;
        if (this.cleanRun < this.config.cleanSamples) return;
        this.finish();
        return;
      }
      // The hold is the only thing standing between a zero-margin result and a
      // level that trips ALC on the first real transmission. One retry a dB
      // lower, then stop claiming success.
      this.cleanRun = 0;
      if (this.holdBackoffs >= 1) {
        this.fail("level did not stay clean during the final hold");
        return;
      }
      this.holdBackoffs += 1;
      this.dirtyGain = this.gain;
      this.cleanGain = 0;
      this.applyGain(this.gain * fromDb(-1));
      this.holdFromBytes = this.consumedBytes;
    }

    // The search is a bracket: it needs one level proven clean and one proven
    // dirty, and only then does bisection have anything to halve. Phase is
    // derived from which half of the bracket is still missing rather than kept
    // as state -- an earlier version tracked it separately and kept walking
    // down after it had already found the clean side, straight past the knee
    // and into "ALC active at the floor" on a perfectly normal radio.
    advance() {
      const {floor, ceiling, bracketRatio, resolutionDb} = this.config;
      this.steps += 1;

      if (!this.cleanGain) {
        // Everything so far has been dirty, including the level we started on:
        // the knee is below it. Walking down costs a second or two of a carrier
        // the radio is already limiting -- which is what its ALC is for -- and
        // it is the only setup where refusing would leave exactly the operator
        // who needs a calibration without one.
        if (this.gain <= floor) {
          this.fail("ALC is active even at the lowest usable level");
          return;
        }
        this.phase = "bracket-down";
        this.applyGain(Math.max(floor, this.gain / bracketRatio));
        return;
      }

      if (!this.dirtyGain) {
        if (this.gain >= ceiling) {
          // Not a failure: the radio simply never limits at any level this path
          // can produce. The knee is the ceiling, and the operator gets told the
          // three things that actually cause it.
          this.cleanGain = this.gain;
          this.enterHold({reachedCeiling: true});
          return;
        }
        this.phase = "bracket-up";
        this.applyGain(Math.min(ceiling, this.gain * bracketRatio));
        return;
      }

      this.phase = "bisect";
      const spanDb = toDb(this.dirtyGain / this.cleanGain);
      if (spanDb <= resolutionDb) { this.enterHold({reachedCeiling: false}); return; }
      this.applyGain(Math.sqrt(this.cleanGain * this.dirtyGain));
    }

    enterHold({reachedCeiling}) {
      this.reachedCeiling = Boolean(reachedCeiling);
      this.state = "holding";
      this.phase = "hold";
      this.cleanRun = 0;
      const target = this.cleanGain * fromDb(-this.config.marginDb);
      this.applyGain(clamp(target, this.config.floor, this.config.ceiling));
      this.holdFromBytes = this.consumedBytes;
    }

    applyGain(next) {
      this.stepSettleBytes = next < this.gain
        ? this.config.settleDownBytes : this.config.settleBytes;
      this.gain = next;
      // The level is only live once the ramp has been played out, so a reading
      // is judged against the moment the change is COMPLETE, not started.
      this.stepFromBytes = Math.max(this.consumedBytes, this.sentBytes) + this.config.rampBytes;
      this.cleanRun = 0;
    }

    finish() {
      this.state = "done";
      this.phase = "";
      this.result = {
        knee: this.cleanGain,
        gain: this.gain,
        alcMax: this.alcMax,
        steps: this.steps,
        reachedCeiling: Boolean(this.reachedCeiling),
        // What the operator should do about the radio's own MOD level. This is
        // the number that replaces the recommended-value guesswork: it is
        // measured, and it is specific to this radio, band and power.
        modLevelCorrectionDb: this.cleanGain > 0
          ? Number(toDb(this.cleanGain / 0.7).toFixed(1)) : 0,
      };
      return this.snapshot();
    }

    snapshot() {
      return {state: this.state, phase: this.phase, gain: this.gain,
              steps: this.steps, alcMax: this.alcMax, alcSeen: this.alcSeen,
              cleanGain: this.cleanGain, dirtyGain: this.dirtyGain,
              error: this.error, result: this.result};
    }
  }

  function clamp(value, low, high) {
    const number = Number(value);
    if (!Number.isFinite(number)) return low;
    return Math.min(high, Math.max(low, number));
  }

  // ---- the key ---------------------------------------------------------------
  //
  // The knee depends on the radio, the band and the power setting, and on
  // nothing else this side can observe. All three therefore go in the key, and
  // nothing is ever interpolated between two entries: whether the knee really
  // scales with the power percentage is a question for the radio, not an
  // assumption to build on.
  //
  // Band edges match data.js bandOf() so the two pages file a transmission under
  // the same name -- with one deliberate difference. 60 m there is the
  // 5351.5-5366.5 kHz segment; the WSPR dial for the band is 5287.2 kHz, outside
  // it. Two labels for one physical band would mean calibrating it twice, so the
  // window here spans both. It is only ever a gain key; the log keeps its own.
  const BANDS = [
    [1800000, 2000000, "160m"], [3500000, 4000000, "80m"],
    [5250000, 5450000, "60m"],  [7000000, 7300000, "40m"],
    [10100000, 10150000, "30m"], [14000000, 14350000, "20m"],
    [18068000, 18168000, "17m"], [21000000, 21450000, "15m"],
    [24890000, 24990000, "12m"], [28000000, 29700000, "10m"],
    [50000000, 54000000, "6m"],  [144000000, 148000000, "2m"],
  ];

  function bandOf(hz) {
    const frequency = Number(hz) || 0;
    for (const [low, high, name] of BANDS)
      if (frequency >= low && frequency <= high) return name;
    return "";
  }

  const entryKey = (model, band, percent) =>
    `${model || "?"}|${band || "?"}|${Number(percent) || 0}`;

  // The key IS the model, the band and the power, so a record that repeats them
  // is paying for the same three strings twice -- and the file has a hard cap
  // that a full band-by-power matrix would otherwise walk straight through.
  // Measured: 195 B per record with them, 110 B without, so 44 cells go from
  // 8.6 kB to 4.9 kB and fit inside the existing 6 kB ceiling.
  //
  // The flags are dropped when false for the same reason: `"reachedCeiling":false`
  // is 22 bytes saying nothing. Absent means false everywhere that reads them.
  const REDUNDANT = ["model", "band", "percent"];
  const FLAGS = ["reachedCeiling", "autoTrimmed"];

  function compact(key, entry) {
    const out = {};
    for (const [name, value] of Object.entries(entry || {})) {
      if (REDUNDANT.includes(name)) continue;
      if (FLAGS.includes(name) && !value) continue;
      if (value === undefined || value === null) continue;
      out[name] = value;
    }
    return out;
  }

  // Reading puts them back, so nothing downstream has to know the record got
  // smaller. Records written before this still carry their own copies; the key
  // wins, because it is what the entry is filed under.
  function expand(key, entry) {
    const parts = String(key || "").split("|");
    if (parts.length < 3) return entry;
    return Object.assign({}, entry, {
      model: parts[0] === "?" ? (entry.model || "") : parts[0],
      band: parts[1] === "?" ? (entry.band || "") : parts[1],
      percent: Number(parts[2]) || Number(entry.percent) || 0,
      reachedCeiling: entry.reachedCeiling === true,
      autoTrimmed: entry.autoTrimmed === true,
    });
  }

  // ---- the station's table ---------------------------------------------------
  //
  // Firmware-side, because a calibration describes the station rather than the
  // browser that measured it. The firmware stores the file and never reads
  // inside it, so this class is the only definition of the schema anywhere.
  const STORE_URL = "/txgain.json";
  const SCHEMA_VERSION = 2;

  // ---- staleness -------------------------------------------------------------
  //
  // Every knee is a knee AT A MOD LEVEL: the audio level the radio starts limiting
  // at moves inversely with the sensitivity of its network input. So an entry
  // measured before the MOD level changed is not a smaller truth, it is a wrong
  // number -- up to eight times wrong at the operating point this station uses --
  // and with zero margin below the knee that difference is distortion, not a
  // quieter signal. It therefore may not reach the air.
  //
  // It is still the best starting point available, though, so it is offered as a
  // SEED: rescaled by the MOD ratio it lands within a decibel or two, and
  // begin({knownKnee}) enters 6 dB below whatever it is handed, so a wrong guess
  // costs a step and can never overdrive.
  //
  // An entry with no `modLevel` at all predates this schema. It is not called
  // stale -- nothing is known to have changed -- but it is not evidence about
  // today's MOD level either, which is why the plan re-measures it.
  function entryStatus(entry, modLevel) {
    if (!entry || !(Number(entry.gain) > 0)) return "missing";
    const measuredAt = Number(entry.modLevel) || 0;
    const now = Number(modLevel) || 0;
    if (!measuredAt) return "unknown-mod";
    if (!now) return "calibrated";        // nothing to compare against; trust it
    return measuredAt === now ? "calibrated" : "stale";
  }

  const seedFrom = (entry, modLevel) => {
    const knee = entry ? Number(entry.knee) || 0 : 0;
    if (!(knee > 0)) return 0;
    const measuredAt = Number(entry.modLevel) || 0;
    const now = Number(modLevel) || 0;
    if (!measuredAt || !now || measuredAt === now) return knee;
    return knee * measuredAt / now;
  };

  class TxGainStore {
    constructor(options = {}) {
      this.url = options.url || STORE_URL;
      this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
      this.doc = {v: SCHEMA_VERSION, entries: {}};
      this.loaded = false;
      this.error = "";
    }

    async load() {
      try {
        const response = await this.fetchImpl(this.url, {cache: "no-store"});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const doc = await response.json();
        this.doc = migrate(doc);
        this.loaded = true;
        this.error = "";
      } catch (error) {
        // A table that cannot be read is not a reason to transmit at a guessed
        // level: the caller falls back to the manual gain and says so.
        this.error = String(error.message || error);
        this.loaded = false;
      }
      return this.doc;
    }

    entry(key) {
      const found = this.doc && this.doc.entries ? this.doc.entries[key] : null;
      return found && Number(found.gain) > 0 ? expand(key, found) : null;
    }

    // The entry only if it is usable for the MOD level the radio has right now.
    // Everything on the transmit path asks through here rather than through
    // entry(), so a stale row cannot reach the air by being read innocently.
    usableEntry(key, modLevel) {
      const found = this.entry(key);
      return entryStatus(found, modLevel) === "stale" ? null : found;
    }

    status(key, modLevel) { return entryStatus(this.entry(key), modLevel); }

    // ---- the plan --------------------------------------------------------
    //
    // Stored beside the entries and not in localStorage, for the same reason the
    // entries are: the operator builds the plan at the desk and runs it from
    // whatever is next to the antenna switch, because every retune asks a
    // question. It also lands in the config backup for free.
    plan() {
      const found = this.doc && this.doc.plan;
      return found && typeof found === "object" ? found : {powers: [], rows: []};
    }

    async putPlan(plan) {
      await this.load();
      this.doc.plan = plan;
      return this.save();
    }

    // Re-read before every write. The file is replaced whole, so a second
    // browser that calibrated another band in the meantime would otherwise be
    // erased by this one's stale copy.
    async put(key, entry) {
      await this.load();
      if (!this.doc.entries) this.doc.entries = {};
      this.doc.entries[key] = compact(key, entry);
      return this.save();
    }

    async remove(key) {
      await this.load();
      if (this.doc.entries) delete this.doc.entries[key];
      return this.save();
    }

    async clear() {
      // The plan survives: it is what the operator built, not what was measured,
      // and "forget the calibrations" is not "forget which cells I want".
      const plan = this.plan();
      this.doc = {v: SCHEMA_VERSION, entries: {}, plan};
      return this.save();
    }

    async save() {
      const response = await this.fetchImpl(this.url, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify(this.doc)});
      if (!response.ok) throw new Error(`storing the calibration failed (HTTP ${response.status})`);
      this.loaded = true;
      return this.doc;
    }
  }

  // v1 -> v2 is additive: entries keep every field they had and simply have no
  // `modLevel`, which entryStatus() reports as "unknown-mod" -- usable, but not
  // evidence about a MOD level nobody had recorded. Rewriting them with a guessed
  // MOD level would turn "we do not know" into a claim.
  function migrate(input) {
    const doc = input && typeof input === "object" ? input : {};
    const entries = doc.entries && typeof doc.entries === "object" ? doc.entries : {};
    const plan = doc.plan && typeof doc.plan === "object" ? doc.plan : {powers: [], rows: []};
    return {...doc, v: SCHEMA_VERSION, entries, plan};
  }

  return {TxGainCal, TxGainStore, DEFAULTS, ULAW_BYTES_PER_SECOND,
          bandOf, entryKey, compact, expand, STORE_URL, SCHEMA_VERSION, migrate,
          entryStatus, seedFrom, toDb, fromDb};
});
