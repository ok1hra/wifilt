// The calibration plan: which band × power cells to measure, in what order, and
// what has to happen between them. See docs/tx-audio-gain-plan-implementace.md.
//
// This file decides; it never acts. It owns no DOM, no clock and no fetch, and it
// answers exactly one question at a time -- "what next?" -- with an intent the
// host executes. Three reasons that shape, all of them learned the hard way in
// this repo:
//
//  * The alternative is `for (const cell of plan) { await retune(); await ask();
//    await measure(); }`, which reads better and cannot be tested outside a
//    browser. Every await in that chain is a place where STOP, a lost session, a
//    dropped LAN link and a hidden tab all have to be handled, and an abort
//    leaves the rest of the chain dangling. Here an abort is one transition.
//  * A page in a background tab has its timers throttled, so anything that paced
//    itself would stall exactly where a transmission does not.
//  * The plan keys a transmitter on bands the operator did not choose by hand. The
//    ordering rules -- ascending power inside a band, one antenna question per
//    retune, survey before the MOD level write -- are safety rules, and safety
//    rules belong somewhere they can be asserted without a radio.

(function (root, factory) {
  const value = factory(
    typeof module === "object" && module.exports ? require("./tx-gain-cal.js") : root.TxGainCal);
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.TxGainPlan = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (TxGainCal) {
  "use strict";

  // Staleness and the seed come from tx-gain-cal.js, deliberately not from a copy
  // here. Two definitions of "is this entry still about today's MOD level" would
  // drift, and the two halves disagreeing means one of them lets a stale gain onto
  // the air while the other reports the cell as needing work.
  const entryStatus = TxGainCal.entryStatus;
  const seedFrom = TxGainCal.seedFrom;

  // Where the knee should sit at the highest planned power. Same constant as the
  // single-shot tool's advice; it is the whole definition of "optimal MOD level".
  const MOD_LEVEL_TARGET = 0.7;
  // How close the re-measured knee has to land before the MOD level is accepted.
  // Wider than the search's own 0.375 dB on purpose: the survey that produced the
  // correction was coarse, and demanding more than the input carried would spend
  // carriers chasing noise.
  const MOD_TOLERANCE_DB = 1.5;
  const MOD_MAX_CORRECTIONS = 2;
  // The floor is NOT 1. A MOD level of 1 is 0 % in the radio's menu: the transmitter
  // stops modulating altogether, every subsequent search runs to the ceiling, and the
  // loop cannot climb back out because a ceiling reading is not a measurement. That is
  // not a hypothesis -- a second calibration run drove a real IC-705 to exactly that
  // state, and it took a CI-V write from outside to recover it.
  //
  // 26 of 255 is 10 %, below which no sane station operates. If the arithmetic asks
  // for less, the honest conclusion is not "write it" but "the audio path is far too
  // hot for this RF power" -- and that is what gets said.
  const MOD_RAW_MIN = 26, MOD_RAW_MAX = 255;
  // The survey only has to rank the bands, so it stops eight times earlier than
  // the clean pass. ~8 s of carrier instead of ~15.
  const SURVEY_RESOLUTION_DB = 1.5;
  // Nobody answers for half an hour: park the radio back where it was and let go
  // of the lock. Never a shorter one, and never an automatic "continue" -- a
  // question that answers itself is not a safeguard.
  const ANTENNA_WAIT_MS = 1800000;

  const toDb = ratio => 20 * Math.log10(ratio);

  // ---- the plan document -----------------------------------------------------
  //
  // Stored in /txgain.json under `plan`, so it is the station's and not the
  // browser's: the operator builds it at the desk and runs it from a tablet next
  // to the antenna switch, because every retune asks a question.

  function emptyPlan() { return {powers: [], rows: []}; }

  // Whole percent, at most four columns, ascending, no duplicates. Percent is the
  // radio's own resolution and the unit in the table's key; watts would mean two
  // names for one cell across two models.
  function normalizePowers(input) {
    const seen = new Set();
    const powers = [];
    for (const value of Array.isArray(input) ? input : []) {
      const percent = Math.round(Number(value));
      if (!Number.isFinite(percent) || percent < 1 || percent > 100) continue;
      if (seen.has(percent)) continue;
      seen.add(percent);
      powers.push(percent);
    }
    powers.sort((left, right) => left - right);
    return powers.slice(0, 4);
  }

  function normalizeRows(input, powerCount) {
    const rows = [];
    const seen = new Set();
    for (const row of Array.isArray(input) ? input : []) {
      if (!row || typeof row !== "object") continue;
      const band = String(row.band || "");
      const hz = Math.round(Number(row.hz) || 0);
      if (!band || hz <= 0 || seen.has(band)) continue;
      seen.add(band);
      const cells = [];
      for (let index = 0; index < powerCount; index++)
        cells.push(Array.isArray(row.cells) && row.cells[index] ? 1 : 0);
      rows.push({band, hz, cells});
    }
    return rows;
  }

  function normalizePlan(input) {
    const source = input && typeof input === "object" ? input : {};
    const powers = normalizePowers(source.powers);
    return {powers, rows: normalizeRows(source.rows, powers.length)};
  }

  // Every selected cell, band-major and ascending in power. Both halves are
  // deliberate: band-major so one retune serves all the powers of a band (and
  // therefore asks the antenna question once per pass), ascending so the hottest
  // cell of a band is the last before a retune -- and a retune waits for a human,
  // which is the only cooling this plan has.
  function cellsOf(plan) {
    const out = [];
    for (const row of plan.rows)
      row.cells.forEach((selected, index) => {
        if (selected) out.push({band: row.band, hz: row.hz, percent: plan.powers[index]});
      });
    return out;
  }

  const highestPercent = plan => {
    const cells = cellsOf(plan);
    return cells.length ? Math.max(...cells.map(cell => cell.percent)) : 0;
  };

  // What a run will cost, in the units the operator pays: carriers, air time,
  // wall time and questions. Shown before START, because "10 bands" and "20
  // antenna questions" are the same plan and only one of them sounds fine.
  function estimate(plan, {surveyMs = 8000, cellMs = 15000, retuneMs = 2000} = {}) {
    const cells = cellsOf(plan);
    const bands = surveyCells(plan);            // one per band, its own top power
    // Every band is visited twice -- once by the survey, once by the clean pass --
    // and each visit is a retune, so each visit is a question.
    const prompts = bands.length * 2;
    const carriers = bands.length + cells.length;
    const airMs = bands.length * surveyMs + cells.length * cellMs;
    return {cells: cells.length, bands: bands.length, carriers, prompts,
            airMs, totalMs: airMs + prompts * retuneMs,
            topPercent: highestPercent(plan)};
  }

  // The survey pass: one cell per band, at THAT band's highest selected power.
  //
  // Not "every band at the globally highest power": a band selected only at 1 %
  // will never be keyed at 40 %, so its knee there is not a fact about this
  // station. And a band's knee is highest at its own highest power, so ranking
  // those maxima needs no normalisation -- which matters, because normalising
  // would drag the unverified `knee ∝ percent` assumption into the one decision
  // that must not rest on it.
  function surveyCells(plan) {
    const best = new Map();
    for (const cell of cellsOf(plan)) {
      const found = best.get(cell.band);
      if (!found || cell.percent > found.percent) best.set(cell.band, cell);
    }
    return [...best.values()].map(cell => ({...cell, survey: true}));
  }

  // ---- the run ---------------------------------------------------------------
  //
  // `store` is the resolver the host passes in: given a cell it answers whether a
  // valid measurement for TODAY's MOD level already exists. Keeping that outside
  // means this file never learns the table's schema.

  class TxGainPlanRun {
    constructor({plan, modLevel = 0, store = null, resolve = null,
                 measureAll = false} = {}) {
      this.plan = normalizePlan(plan);
      this.modLevel = Number(modLevel) || 0;
      this.measureAll = Boolean(measureAll);
      // resolve(cell) -> {valid, knee, modLevel} | null
      this.resolve = typeof resolve === "function" ? resolve
        : (store && typeof store.entry === "function"
            ? cell => store.entry(cell) : () => null);

      this.state = "idle";           // idle | survey | mod | matrix | done | failed | stopped
      this.error = "";
      this.step = null;              // the intent handed out last
      this.results = [];             // one row per attempted cell
      this.surveyKnees = [];         // {band, hz, percent, knee}
      this.modFrom = Number(modLevel) || 0;   // what the radio had before the run
      this.modTarget = 0;
      this.modCorrections = 0;
      this.modAdvice = null;         // set when the MOD level could not be settled
      this.modOwner = null;          // the band whose knee sets the MOD level
      // The antenna answer belongs to a VISIT, not to a band: the operator's rule
      // is one question per retune, so any retune spends it. Keeping a set of
      // confirmed bands instead looked equivalent and silently skipped the question
      // on the clean pass for every band the survey had already asked about.
      this.confirmedHz = 0;
      this.secondPass = false;       // the one return to unfinished cells
      this.retried = new Set();      // cells already given their one underrun retry
      this.retries = 0;
      this.bandPo = new Map();       // band -> {percent, po} of its first measurement
      this.tuned = {hz: 0, percent: 0};
      this.queue = [];
      this.index = 0;
      this.pendingRestore = false;
    }

    // ---- lifecycle ---------------------------------------------------------

    begin() {
      if (!cellsOf(this.plan).length) return this.fail("the plan has no cells selected");
      this.queue = surveyCells(this.plan);
      this.index = 0;
      this.state = "survey";
      this.pendingRestore = true;
      return this.snapshot();
    }

    fail(reason) {
      if (this.state === "failed" || this.state === "stopped") return this.snapshot();
      this.error = String(reason);
      this.state = "failed";
      this.step = this.pendingRestore ? {type: "restore", reason: this.error} : {type: "done"};
      return this.snapshot();
    }

    stop(reason = "operator stop") {
      if (this.state === "done" || this.state === "failed") return this.snapshot();
      this.error = String(reason);
      this.state = "stopped";
      this.step = this.pendingRestore ? {type: "restore", reason: this.error} : {type: "done"};
      return this.snapshot();
    }

    get running() { return ["survey", "mod", "matrix"].includes(this.state); }

    // ---- what next ---------------------------------------------------------
    //
    // One intent at a time, and the same intent again until the host reports it
    // done. Idempotence is what makes a re-render or a dropped event harmless.
    next() {
      if (!this.running) {
        this.step = this.pendingRestore ? {type: "restore", reason: this.error}
                                       : {type: "done"};
        return this.step;
      }
      if (this.state === "mod") return (this.step = this.modStep());

      const cell = this.queue[this.index];
      if (!cell) return (this.step = this.advancePhase());

      // Skipping comes first: a cell that already has a valid measurement must
      // not cost a retune, and therefore must not cost a question either.
      if (!this.measureAll && !cell.survey && this.isValid(cell)) {
        const entry = this.resolve(cell) || {};
        this.results.push({...cell, status: "skipped",
                           reason: "already calibrated for this MOD level",
                           knee: Number(entry.knee) || 0});
        this.index++;
        return this.next();
      }

      if (this.tuned.hz !== cell.hz)
        return (this.step = {type: "retune", hz: cell.hz, band: cell.band});
      // One question per retune, which with band-major ordering is one per band
      // per pass. The operator chose the strict rule; the ordering is what keeps
      // it from becoming twenty clicks.
      if (this.confirmedHz !== cell.hz)
        return (this.step = {type: "askAntenna", band: cell.band, hz: cell.hz,
                             percent: cell.percent, timeoutMs: ANTENNA_WAIT_MS});
      if (this.tuned.percent !== cell.percent)
        return (this.step = {type: "setPower", percent: cell.percent, band: cell.band});
      return (this.step = {type: "measure", band: cell.band, hz: cell.hz,
                           percent: cell.percent, survey: Boolean(cell.survey),
                           resolutionDb: cell.survey ? SURVEY_RESOLUTION_DB : 0,
                           seed: this.seedFor(cell)});
    }

    // Where to start looking. In order of what is actually known:
    //
    //  1. a stored entry for this very cell, rescaled if the MOD level has moved;
    //  2. a cell of the SAME BAND measured a minute ago in this run, scaled by the
    //     power ratio.
    //
    // (2) is the one that matters on the air. A cell at 10 % has a knee about ten
    // times lower than the same band at 100 %, and starting a cold search at 0.05 then
    // means walking down step by step -- each step costing a settle the meter's own
    // ballistics demand -- until the carrier runs out. That is exactly how the
    // high-power cells passed and the low-power ones did not.
    //
    // It stays an estimate and never a result: begin() enters 6 dB BELOW whatever it
    // is handed, so a wrong guess costs a step and can never overdrive. The same
    // discipline the MOD level correction uses.
    seedFor(cell) {
      const stored = seedFrom(this.resolve(cell), this.modLevel);
      if (stored > 0) return stored;
      const sibling = this.results.find(row => row.status === "ok" &&
        row.band === cell.band && row.percent && row.percent !== cell.percent &&
        Number(row.knee) > 0);
      if (!sibling) return 0;
      return Number(sibling.knee) * cell.percent / sibling.percent;
    }

    // Only an entry measured at TODAY's MOD level counts as done. "unknown-mod"
    // deliberately does not: it predates the schema, so it is usable on the air but
    // it is not evidence about the MOD level now in the radio, and a plan that
    // accepted it would report a station calibrated on the strength of a number
    // whose conditions nobody recorded.
    isValid(cell) {
      const entry = this.resolve(cell);
      if (entryStatus(entry, this.modLevel) !== "calibrated") return false;
      return Boolean(Number(entry.modLevel));
    }

    // Returns an INTENT, never a snapshot. fail() and stop() answer with a
    // snapshot because they are notes; routing their return value out of here put
    // an object with no `type` into `step`, and the host -- which switches on
    // type -- stopped without restoring the radio. An aborted plan then left the
    // transmitter on a band the operator never chose.
    advancePhase() {
      if (this.state === "survey") {
        if (!this.surveyKnees.length) {
          // Two different failures, and the message has to say which. Before any
          // write it means no band could be measured at all; after one it means
          // the verification carrier failed, and the MOD level in the radio is
          // now a value nobody has confirmed.
          if (this.modCorrections)
            this.fail(`the MOD level was written (${this.modLevel}) but the ` +
                      "verification measurement failed — check it in the radio's menu");
          else this.fail("the survey could not measure a single band");
          return this.step;
        }
        this.state = "mod";
        return this.modStep();
      }
      // Before finishing: one return to what was left unmeasured. A band the operator
      // skipped because the antenna was wrong, or a cell that failed, is exactly what
      // they will want measured now that the antenna is right and the rest is done --
      // and walking back to it is not the same as looping, so it happens ONCE.
      if (!this.secondPass) {
        this.secondPass = true;
        const unfinished = this.unfinishedCells();
        if (unfinished.length) {
          this.queue = unfinished;
          this.index = 0;
          // Cleared so the cells come back as work rather than as history; the earlier
          // failures stay in `results` only as the reason this pass exists.
          this.results = this.results.filter(row => !unfinished.some(
            cell => cell.band === row.band && cell.percent === row.percent));
          return this.next();
        }
      }
      this.state = "done";
      return {type: "restore", reason: ""};
    }

    // Selected cells that ended the clean pass without a measurement: failed, or
    // dropped when their band was skipped. Deliberately NOT cells that were skipped
    // for being already calibrated -- those are finished, not unfinished.
    // Nor a cell that hit the ceiling. That failure is deterministic: the MOD
    // level is settled before the matrix starts, so nothing about the second
    // attempt differs from the first, and keying it again spends a full carrier
    // to learn the same thing. The reason stays in `results` either way.
    unfinishedCells() {
      const measured = new Set(this.results
        .filter(row => row.status === "ok" || row.reachedCeiling ||
                       row.reason === "already calibrated for this MOD level")
        .map(row => `${row.band}|${row.percent}`));
      return cellsOf(this.plan).filter(cell => !measured.has(`${cell.band}|${cell.percent}`));
    }

    // ---- the MOD level, once ------------------------------------------------
    //
    // The band that needs the MOST audio owns the MOD level. Set it from the most
    // sensitive band instead and every other band would need more than 0.7, which
    // pushes some of them above the 0.8 ceiling -- unmeasurable, and on the air
    // it means a radio that never reaches the power it is set to. Optimising the
    // worst band leaves the others below 0.7, and that is only headroom.
    modStep() {
      const worst = this.surveyKnees.reduce(
        (best, entry) => (!best || entry.knee > best.knee ? entry : best), null);
      if (!worst) { this.fail("the survey measured nothing"); return this.step; }
      this.modOwner = worst;

      const offDb = toDb(worst.knee / MOD_LEVEL_TARGET);
      // A ceiling hit is not a measurement. The search stopped at 0.8 because the
      // radio never limited, so the real knee is somewhere above it and the ratio
      // computed from 0.8 would be a fraction of the move actually needed -- two
      // corrections of +1.4 % on a MOD level that is 8x too low. Move by a
      // decisive 6 dB instead and look again; that is what the second survey is
      // for. Without this the loop reports "did not converge" about a radio it
      // barely nudged.
      if (worst.reachedCeiling && this.modLevel) {
        // Four times, and never a timid step from a level that cannot modulate. A
        // ceiling reading says the true knee is somewhere ABOVE 0.8 -- how far above is
        // unknown -- so doubling from a MOD level of 1 would need six runs to recover.
        const doubled = Math.min(MOD_RAW_MAX,
                                 Math.max(this.modLevel * 4, MOD_RAW_MIN * 2));
        if (doubled !== this.modLevel && this.modCorrections < MOD_MAX_CORRECTIONS) {
          this.modTarget = doubled;
          return {type: "writeMod", value: doubled, from: this.modLevel,
                  band: worst.band, knee: worst.knee, atCeiling: true, atFloor: false,
                  verifyPercent: worst.percent, verifyHz: worst.hz};
        }
        return this.enterMatrix({
          advice: {offDb: Number(offDb.toFixed(1)), band: worst.band, knee: worst.knee,
                   target: this.modLevel,
                   reason: doubled === this.modLevel
                     ? "the MOD level is already at maximum — the RF power is higher " +
                       "than this audio path can drive"
                     : "the MOD level did not converge"}});
      }
      if (Math.abs(offDb) <= MOD_TOLERANCE_DB) return this.enterMatrix();

      if (!this.modLevel) {
        // No MOD level means the read never landed, so there is nothing to scale
        // and nothing safe to write. The advice is still worth having.
        return this.enterMatrix({
          advice: {offDb: Number(offDb.toFixed(1)), band: worst.band,
                   knee: worst.knee, target: 0, reason: "the MOD level is unknown"}});
      }
      if (this.modCorrections >= MOD_MAX_CORRECTIONS) {
        return this.enterMatrix({
          advice: {offDb: Number(offDb.toFixed(1)), band: worst.band, knee: worst.knee,
                   target: 0, reason: "the MOD level did not converge"}});
      }

      // knee is proportional to RF power over MOD level, so this is one division.
      // It is an ESTIMATE -- the next survey reading is what decides -- which is
      // the same discipline the table applies to its own entries.
      const wanted = Math.round(this.modLevel * worst.knee / MOD_LEVEL_TARGET);
      let clamped = Math.max(MOD_RAW_MIN, Math.min(MOD_RAW_MAX, wanted));
      // The estimate can round to the value the radio already has while the knee
      // is still outside tolerance -- at a MOD level of 1 or 2 every ratio does.
      // Standing still there and calling it "already at minimum" would be a lie in
      // the wrong direction, so step by the smallest amount the radio can express.
      // Asking for less than the floor is a finding, not a value to write.
      if (wanted < MOD_RAW_MIN) {
        return this.enterMatrix({
          advice: {offDb: Number(offDb.toFixed(1)), band: worst.band, knee: worst.knee,
                   target: MOD_RAW_MIN,
                   reason: `the MOD level would have to go below ${MOD_RAW_MIN} of 255 ` +
                     "(10 %), which is a radio that barely modulates — the audio path " +
                     "is far too hot for this RF power, so nothing was written"}});
      }
      if (clamped === this.modLevel && Math.abs(offDb) > MOD_TOLERANCE_DB)
        clamped = worst.knee > MOD_LEVEL_TARGET
          ? Math.min(MOD_RAW_MAX, this.modLevel + 1)
          : Math.max(MOD_RAW_MIN, this.modLevel - 1);
      if (clamped === this.modLevel) {
        // The radio is already at the end of its range in the direction the
        // measurement asks for. That is not a failure of this loop -- it is the
        // honest finding that the RF power is beyond what the audio path can
        // drive (or below what it can express), and it has to be said that way.
        return this.enterMatrix({
          advice: {offDb: Number(offDb.toFixed(1)), band: worst.band, knee: worst.knee,
                   target: clamped,
                   reason: wanted > MOD_RAW_MAX
                     ? "the MOD level is already at maximum — the RF power is higher " +
                       "than this audio path can drive"
                     : "the MOD level is already at minimum"}});
      }
      this.modTarget = clamped;
      return {type: "writeMod", value: clamped, from: this.modLevel,
              band: worst.band, knee: worst.knee,
              atCeiling: wanted > MOD_RAW_MAX, atFloor: wanted < MOD_RAW_MIN,
              verifyPercent: worst.percent, verifyHz: worst.hz};
    }

    enterMatrix(extra = {}) {
      this.state = "matrix";
      this.modAdvice = extra.advice || null;
      this.queue = cellsOf(this.plan);
      this.index = 0;
      return this.next();
    }

    // ---- what the host reports back ----------------------------------------

    note(event) {
      if (!event || typeof event !== "object") return this.snapshot();
      switch (event.type) {
        case "tuned":
          // A retune spends the antenna answer, always. That is the whole rule.
          this.tuned = {hz: Number(event.hz) || 0, percent: 0};
          this.confirmedHz = 0;
          break;
        case "antennaOk":
          this.confirmedHz = this.tuned.hz;
          break;
        case "antennaSkip": {
          // Skipping a band drops every cell it has, in both phases. The operator
          // said the antenna is wrong; that is not a per-cell fact.
          const band = String(event.band || "");
          this.queue = this.queue.filter((cell, index) =>
            index < this.index || cell.band !== band);
          this.results.push({band, hz: 0, percent: 0, status: "skipped",
                             reason: "the operator skipped this band"});
          break;
        }
        case "powerSet":
          this.tuned = {hz: this.tuned.hz, percent: Number(event.percent) || 0};
          break;
        case "measured": {
          const cell = this.queue[this.index] || {};
          const knee = Number(event.knee) || 0;
          if (cell.survey) this.surveyKnees.push({band: cell.band, hz: cell.hz,
                                                  percent: cell.percent, knee,
                                                  reachedCeiling: Boolean(event.reachedCeiling)});
          // A survey reading is not a stored calibration -- it was taken coarsely
          // and, once the MOD level moves, at a level nothing will transmit at.
          // Counting it as a done cell would show 13 of 10 measured.
          const po = Number(event.po) || 0;
          this.results.push({...cell, status: cell.survey ? "survey" : "ok", knee,
                             gain: Number(event.gain) || knee, po,
                             note: cell.survey ? "" : this.thermalNote(cell, po)});
          this.index++;
          break;
        }
        case "ceiling": {
          // The search ran to 0.8 and the radio never limited. Nothing was
          // measured and nothing was stored -- but the OBSERVATION is what the
          // MOD level correction below is made of, and it is only ever produced
          // by the station this loop exists to fix: a MOD level so low that the
          // audio path cannot drive the radio to the power it is set to.
          //
          // So a survey cell records it, ceiling flag and all, and modStep()
          // then multiplies the MOD level and looks again. A matrix cell has
          // nothing to correct any more and is a plain failure.
          const cell = this.queue[this.index] || {};
          if (cell.survey) {
            this.surveyKnees.push({band: cell.band, hz: cell.hz, percent: cell.percent,
                                   knee: Number(event.knee) || 0, reachedCeiling: true});
            this.results.push({...cell, status: "survey", knee: Number(event.knee) || 0,
                               gain: Number(event.gain) || 0, po: Number(event.po) || 0,
                               reachedCeiling: true, note: ""});
          } else {
            this.results.push({...cell, status: "failed",
                               reason: String(event.reason || "no knee found"),
                               reachedCeiling: true});
          }
          this.index++;
          break;
        }
        case "cellFailed": {
          const cell = this.queue[this.index] || {};
          const reason = String(event.reason || "measurement failed");
          // An underrun is not a property of the cell. The calibration carrier runs a
          // deliberately halved ring, and WiFi burst loss on this path is a documented
          // fault -- so the honest response is to key it once more, not to record a
          // measurement that never happened. One retry: a second underrun on the same
          // cell is telling us something about the link, and repeating for ever would
          // spend the whole plan on one band.
          const key = `${cell.band}|${cell.percent}`;
          if (/underrun/i.test(reason) && !this.retried.has(key)) {
            this.retried.add(key);
            this.retries += 1;
            break;                       // same cell, same index -- measured again
          }
          this.results.push({...cell, status: "failed", reason});
          this.index++;
          break;
        }
        case "modWritten":
          // The write landed; only a fresh reading judges it. EVERY survey knee is
          // discarded, not just the owning band's: they were all measured at the
          // old MOD level, and comparing a re-measured number against stale ones
          // could hand the next correction a value from the wrong era. Dropping
          // them costs nothing, because the ranking they established still holds --
          // the MOD level scales every band by the same factor, so the worst band
          // stays the worst.
          this.modLevel = Number(event.value) || this.modLevel;
          this.modCorrections++;
          this.surveyKnees = [];
          this.queue = this.modOwner
            ? [{...this.modOwner, survey: true}] : [];
          this.index = 0;
          this.state = "survey";
          break;
        case "modUnavailable":
          // Read refused, address unconfirmed, or an old firmware. The plan does
          // not proceed on a guess: the operator sets the value in the radio's
          // menu and says so.
          return this.fail(String(event.reason ||
            "the MOD level could not be read or written — set it in the radio's menu"));
        case "restored":
          this.pendingRestore = false;
          if (this.state === "done" || this.state === "failed" || this.state === "stopped")
            this.step = {type: "done"};
          break;
        case "stationFailed":
          return this.fail(String(event.reason || "the station stopped the plan"));
        default:
          break;
      }
      return this.snapshot();
    }

    // The price of running with no pauses between cells, paid with data that is
    // recorded anyway. A radio that has warmed up reduces its own output WITHOUT
    // changing the percentage it is set to, and the knee moves with the actual RF --
    // so a hot cell measures a level nothing will ever transmit at, and nothing in the
    // table would say so. Within one band the forward power should scale with the
    // percentage; more than 1 dB short of that is the symptom.
    //
    // A flag, never a refusal: the operator chose no pauses, and a measurement that
    // may have been taken warm is still better than none. It just has to be labelled.
    thermalNote(cell, po) {
      const first = this.bandPo.get(cell.band);
      if (!first) {
        if (po > 0) this.bandPo.set(cell.band, {percent: cell.percent, po});
        return "";
      }
      if (!(po > 0) || !(first.po > 0) || cell.percent === first.percent) return "";
      const expected = first.po * cell.percent / first.percent;
      if (!(expected > 0)) return "";
      return toDb(po / expected) < -1 ? "po-low" : "";
    }

    // Where the run got to, in the words the panel shows.
    snapshot() {
      const done = this.results.filter(row => row.status === "ok").length;
      const failed = this.results.filter(row => row.status === "failed").length;
      const skipped = this.results.filter(row => row.status === "skipped").length;
      // What to put on a progress line. `done` alone reads as 0/4 for the whole
      // survey and the MOD level write -- a minute or more of carriers during which
      // the number never moves, which looks like nothing is happening.
      const label = {survey: this.modCorrections ? "verifying MOD level" : "survey",
                     mod: "MOD level", matrix: this.secondPass ? "finishing" : "measuring"
                    }[this.state] || this.state;
      const progress = {label,
                        at: Math.min(this.index + 1, Math.max(this.queue.length, 1)),
                        of: this.queue.length || cellsOf(this.plan).length};
      return {state: this.state, phase: this.state, error: this.error, progress,
              step: this.step, done, failed, skipped, retries: this.retries,
              flagged: this.results.filter(row => row.note === "po-low").length,
              total: cellsOf(this.plan).length,
              modLevel: this.modLevel, modFrom: this.modFrom,
              modOwner: this.modOwner, modAdvice: this.modAdvice || null,
              results: this.results.slice()};
    }
  }

  return {TxGainPlanRun, normalizePlan, normalizePowers, cellsOf, estimate,
          emptyPlan, highestPercent,
          MOD_LEVEL_TARGET, MOD_TOLERANCE_DB, MOD_MAX_CORRECTIONS,
          SURVEY_RESOLUTION_DB, ANTENNA_WAIT_MS, MOD_RAW_MIN, MOD_RAW_MAX};
});
