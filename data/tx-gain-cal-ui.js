// One calibration tool, hosted by two pages.
//
// The search itself is tx-gain-cal.js. This is everything around it: the carrier,
// the byte accounting, the panel, the verdict and the write into the station's
// table. It lives here because the WSPR page and the JS8Call page must run the
// SAME tool -- the measurement is a property of the radio, not of the mode, and
// two copies of a transmitter-keying panel would be "similar" within a month.
//
// Like lan-gate.js and wake-lock.js this carries its own markup and CSS, so
// putting the tool on a page is one script tag and one create() call.
//
// The carrier is deliberately NOT either page's own tune path. It is a WsprStream
// single tone driven by WsprTx, for one reason: the search has to move the level
// eight or nine times inside one keying, and only that pair generates audio a
// packet at a time. The JS8 page's tune carrier is pre-rendered into one buffer,
// so its level is fixed the moment it is built -- which is why the tool could not
// simply be "the tune button with a loop around it".
//
// Everything a page must supply is in the adapter. Nothing in here reads a global.

(function (root, factory) {
  const value = factory(
    typeof module === "object" && module.exports ? require("./tx-gain-cal.js") : root.TxGainCal,
    typeof module === "object" && module.exports ? require("./wspr-core.js") : root.WsprCore,
    typeof module === "object" && module.exports ? require("./wspr-tx.js") : root.WsprTx);
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.TxGainCalUi = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (TxGainCal, WsprCore, WsprTx) {

  // The carrier cap, and why there are two of them.
  //
  // 20 s was measured against a search that starts near the answer. It is not enough
  // when the knee is LOW: every step downwards costs the ring depth plus a 500 ms
  // settle (the meter has to fall on the radio's own time) plus one or two valid ALC
  // readings, so a cell at 10 % power takes half again as long as the same band at
  // 100 % -- which is exactly the pattern that failed on the air, the high-power cells
  // passing and the low-power ones reporting "the carrier ran out".
  //
  // A cap that stops a search which is still converging is arbitrary. So the soft cap
  // is EXTENDED whenever the search actually advances, and the hard cap is what bounds
  // the airtime: a search that has stopped moving gets no more carrier.
  const CAL_MAX_MS = 20000;             // soft: no progress for this long and it ends
  const CAL_EXTEND_MS = 9000;           // granted again on every step forward
  const CAL_HARD_MS = 50000;            // never longer than this, whatever happens
  const CAL_TARGET_FILL_BYTES = 4000;   // 0.5 s ahead of the radio, half the usual
  const CAL_RAMP_SAMPLES = 5760;        // 120 ms
  const CAL_LEAD_MS = 2500;             // shortest lead the firmware's window allows
  const CAL_SWR_LIMIT = TxGainCal.CAL_SWR_LIMIT; // shared with mercury-gain-cal.js -- see tx-gain-cal.js's own comment
  const MOD_LEVEL_TARGET = 0.7;         // where the knee should sit; see decision 11
  // Both pages put this driver on the SAME audio socket as their own (the WSPR
  // beacon's WsprTx, JS8's Js8Tx), and every control frame is now matched by
  // txId. Two counters that both start at 1 would make that match wrong rather
  // than absent: the beacon's third transmission and the third calibration cell
  // would answer to the same number. The ranges are simply kept apart.
  const CAL_FIRST_TX_ID = 1000000;

  const CSS = ""
    + ".cal-field{grid-column:1 / -1;border:1px solid #674a30;padding:8px;display:grid;gap:6px}"
    + ".cal-field[hidden]{display:none}"
    + ".cal-field p{margin:0}"
    + ".cal-field b{color:#fff}"
    + ".cal-intro,.cal-target{color:#8ba59d;font-size:12px;line-height:1.5}"
    + ".cal-live{font-family:ui-monospace,monospace;font-size:12px;color:#e0a020}"
    + ".cal-result{font-size:12px;color:#9fd39f;line-height:1.5}"
    + ".cal-error{font-size:12px;color:#e06c5a;line-height:1.5}"
    + ".cal-field button{cursor:pointer}"
    // The same rule as the plan panel and as the rest of the interface: a button that
    // cannot be pressed must not look like one that can.
    + ".cal-field button:disabled{opacity:.4;cursor:not-allowed;color:#61746f;"
    + "border-color:#2a453e}";

  const MARKUP = ""
    + '<b>Automatic TX gain</b>'
    + '<p class="cal-intro">Keys a carrier for up to 20 s on the band and power the'
    + ' radio is set to <em>now</em>, raises the audio level until ALC just starts'
    + ' to act, and stores the level below that. Nothing else about the radio is'
    + ' changed.</p>'
    // Ids as well as the data attributes: one radio means one instance per page,
    // and the browser harnesses address these by id.
    + '<p class="cal-target" id="calTarget" data-cal="target"></p>'
    + '<p><button type="button" id="calStart" data-cal="start">START CALIBRATION</button></p>'
    + '<p class="cal-live" id="calLive" data-cal="live" hidden></p>'
    + '<p class="cal-result" id="calResult" data-cal="result" hidden></p>'
    + '<p class="cal-error" id="calMessage" role="alert" data-cal="error" hidden></p>';

  let cssInstalled = false;
  function installCss(document) {
    if (cssInstalled || !document) return;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    cssInstalled = true;
  }

  // The three causes the operator can actually act on, when the level ran to the
  // ceiling without the radio ever limiting. None of them is readable over CI-V,
  // so listing them is the only defence against a diagnostic dead end.
  const CEILING_ADVICE =
    " — ALC never acted, even at the maximum level: check that the radio's MOD" +
    " input is the LAN one, that its MOD level is not too low, and that RF power" +
    " is not set higher than the audio path can drive";

  // And the number, whenever the MOD level is known. "Not too low" is a direction;
  // the operator has to turn a knob to a value, and the ratio that says which value
  // is the same one the batch plan corrects by -- the level needed scales with the
  // audio the radio would not take. A ceiling reading only proves the true knee is
  // ABOVE the ceiling, never how far above, so this is a floor on the answer and
  // says so rather than pretending to be the answer.
  // The floor the batch plan refuses to write below, read from it rather than
  // copied: the panel must not advise a level the plan would then refuse. Absent
  // on a page that mounts only the single-shot tool, hence the fallback.
  function modRawMin() {
    const plan = typeof module === "object" && module.exports
      ? require("./tx-gain-plan.js")
      : (typeof globalThis !== "undefined" ? globalThis : self).TxGainPlan;
    return (plan && plan.MOD_RAW_MIN) || 26;
  }

  function ceilingAdvice(modLevel) {
    const level = Number(modLevel) || 0;
    if (!level) return CEILING_ADVICE;
    // The same step tx-gain-plan.js's modStep() takes for a ceiling: four times,
    // never below twice the floor. Two numbers for one answer -- one in the panel
    // and another in the plan -- is worse than either.
    const wanted = Math.min(255, Math.max(Math.round(level * 4), modRawMin() * 2));
    const where = `. The radio's MOD level is ${level} of 255 ` +
                  `(${Math.round(level * 100 / 255)} %)`;
    // Nothing left to turn up. The same finding the plan reports, in the same
    // words: this is no longer about the MOD level.
    if (wanted <= level)
      return CEILING_ADVICE + where + " — already at maximum, so the RF power is " +
        "higher than this audio path can drive: measure at a lower power";
    return CEILING_ADVICE + where + ` — try ${wanted} and measure again` +
      (wanted >= 255 ? ", which is as high as it goes" : "");
  }

  // How much longer a search that just advanced may run. Its own function so the test
  // drives THIS code rather than a second copy of the arithmetic.
  const extendedDeadline = (nowMs, endsAtMs) =>
    Math.min(nowMs + CAL_EXTEND_MS, endsAtMs + (CAL_HARD_MS - CAL_MAX_MS));

  class TxGainCalRun {
    // `adapter` is the page. See the bottom of this file for the contract.
    constructor(adapter) {
      this.page = adapter;
      this.store = adapter.store;
      this.cal = null;
      this.armed = false;
      this._running = false;
      this.timer = null;
      this.restoreMode = "";
      this.run = {key: "", band: "", percent: 0, model: "", dbm: null,
                  message: "", result: null, poPeak: 0, swrPeak: 0, sawAlcField: false};
      this.tx = new WsprTx.WsprTx({
        sink: adapter.sink,
        wallNow: adapter.wallNow,
        streamId: adapter.streamId,
        targetFillBytes: CAL_TARGET_FILL_BYTES,
        firstTxId: CAL_FIRST_TX_ID,
        onEvent: event => this.onTxEvent(event),
      });
      if (adapter.mount) {
        installCss(adapter.mount.ownerDocument);
        adapter.mount.classList.add("cal-field");
        adapter.mount.innerHTML = MARKUP;
        adapter.mount.hidden = true;
        this.dom = {};
        for (const node of adapter.mount.querySelectorAll("[data-cal]"))
          this.dom[node.dataset.cal] = node;
        this.dom.start.addEventListener("click",
          () => (this.running ? this.stop("operator stop") : this.start()));
      }
    }

    // Both pages route every control frame by this flag and RETURN when it is set, so
    // a stale `true` silently swallows the beacon's, TUNE's and JS8's own transmissions
    // -- which is what happened: a watchdog reported a cell as failed without stopping
    // the tool, and TUNE stayed dead until the page was reloaded.
    //
    // So it is derived, not just assigned: a run is only running while it still has a
    // search or a carrier. Nothing can leave it latched on.
    get running() {
      if (!this._running) return false;
      return Boolean(this.cal) ||
        ["preparing", "waiting-slot", "prebuffering", "streaming"].includes(this.tx.state);
    }

    // ---- identity ----------------------------------------------------------

    // The key this radio, band and power belong under, or null when any part is
    // unknown. A calibration filed under a guessed model or a power the radio has
    // not confirmed would be worse than none, because it would be applied without
    // anyone being asked.
    identity() {
      const radio = this.page.radio();
      const model = this.page.model();
      const band = TxGainCal.bandOf(radio.frequency);
      if (!model || !band || radio.rfPowerSeen !== true) return null;
      const percent = WsprCore.civPercent(radio.rfPower);
      return {key: TxGainCal.entryKey(model, band, percent), model, band, percent};
    }

    blockingReason() {
      const page = this.page.blockingReason();
      if (page) return page;
      if (!this.identity()) {
        const radio = this.page.radio();
        if (!this.page.model()) return "the radio has not reported its model yet";
        if (!TxGainCal.bandOf(radio.frequency)) return "the radio is not on an amateur band";
        return "the radio has not reported its power setting yet";
      }
      return "";
    }

    // The MOD level the radio is on, as far as anyone has been told. 0 means never
    // read, which entryStatus() treats as "nothing to compare against" rather than
    // as a mismatch -- a page that cannot read the level must not declare every
    // stored calibration stale.
    modLevel() {
      return this.page.modLevel ? Number(this.page.modLevel()) || 0 : 0;
    }

    // What the table says for the radio as it stands right now.
    resolved() {
      const manual = this.page.manualGain();
      const identity = this.identity();
      if (!identity) return {gain: manual, calibrated: false, key: "",
                             why: "the radio has not reported its model, band or power yet"};
      const entry = this.store.entry(identity.key);
      const status = TxGainCal.entryStatus(entry, this.modLevel());
      if (status === "missing")
        return {gain: manual, calibrated: false, key: identity.key,
                band: identity.band, percent: identity.percent,
                why: `not calibrated for ${identity.band} @ ${identity.percent} %`};
      // A knee measured at a different MOD level is not a weaker measurement, it is
      // the wrong number -- and with no margin under the knee, wrong upwards means
      // distortion. Shown, never transmitted from.
      if (status === "stale")
        return {gain: manual, calibrated: false, stale: true, key: identity.key, entry,
                band: identity.band, percent: identity.percent,
                why: `measured at MOD level ${entry.modLevel}, the radio is on ` +
                     `${this.modLevel()} — recalibrate ${identity.band} @ ${identity.percent} %`};
      return {gain: Number(entry.gain), calibrated: true, key: identity.key, entry,
              band: identity.band, percent: identity.percent,
              modUnknown: status === "unknown-mod", why: ""};
    }

    // ---- the run -----------------------------------------------------------

    arm(armed) { this.armed = Boolean(armed); this.render(); }

    // `options` is how the batch plan borrows this as a measuring device:
    //   seed         a knee to start from -- a stale entry rescaled by the MOD
    //                ratio, which only ever shortens the search
    //   resolutionDb stop the bisection early. The plan's survey pass only has to
    //                rank the bands, and 1.5 dB instead of 0.375 is half the carrier
    //   onOutcome    called once with the result or the failure, so the sequencer
    //                learns what happened without polling this object
    async start(options = {}) {
      const problem = this.blockingReason();
      if (problem) {
        this.run.message = problem;
        this.render();
        if (options.onOutcome) options.onOutcome({ok: false, reason: problem});
        return;
      }
      const identity = this.identity();
      this.onOutcome = options.onOutcome || null;
      Object.assign(this.run, identity, {message: "", result: null, dbm: this.page.dbm(),
                                         poPeak: 0, swrPeak: 0, sawAlcField: false});
      // What the radio's MOD level is, BEFORE the carrier -- the entry is stored
      // with it, and an entry stored with 0 is one nothing can ever call stale.
      // Only when it is not already known: the batch plan reads it once for the
      // whole run, and this is a CI-V round trip worth up to 2.5 s.
      if (!this.modLevel() && this.page.refreshModLevel) {
        try { await this.page.refreshModLevel(); } catch (_error) {}
      }
      try {
        // The only write the calibration makes. Without a data mode the LAN audio
        // never reaches the modulator, the search runs to the ceiling and reports
        // "ALC never acted" -- a true statement pointing at the wrong cause.
        // Snapshot and restore, the way announceIpViaCw does in the firmware.
        this.restoreMode = "";
        const mode = this.page.radio().mode;
        if (mode !== "USB-D") {
          this.restoreMode = mode;
          await this.page.ensureDataMode();
        }
        const stored = this.store.entry(this.run.key);
        this.cal = new TxGainCal.TxGainCal(
          options.resolutionDb ? {resolutionDb: Number(options.resolutionDb)} : {});
        // A seed handed in wins over the stored knee: the plan has already rescaled
        // it for today's MOD level, while the stored one was measured at whatever
        // the MOD level used to be.
        this.cal.begin({knownKnee: Number(options.seed) > 0 ? Number(options.seed)
          : (stored ? TxGainCal.seedFrom(stored, this.modLevel()) : 0)});
        this._running = true;
        this.endsAtMs = this.page.wallNow() + CAL_LEAD_MS + CAL_MAX_MS;
        this.tx.targetFillBytes = CAL_TARGET_FILL_BYTES;
        this.tx.queue({symbols: new Uint8Array(162).fill(1),
                       slotUtcMs: this.page.wallNow() + CAL_LEAD_MS,
                       baseHz: 1500, amplitude: this.cal.gain,
                       leadMs: CAL_LEAD_MS, alcFast: true});
        // The backstop is the HARD cap. The soft one is enforced from the level
        // messages, where progress is actually visible.
        this.softDeadlineMs = this.page.wallNow() + CAL_LEAD_MS + CAL_MAX_MS;
        this.lastSteps = 0;
        this.timer = setTimeout(
          () => this.stop("the carrier ran out before the search finished (hard limit)"),
          CAL_LEAD_MS + CAL_HARD_MS);
        this.page.onRunChange(true);
      } catch (error) {
        this.cal = null;
        this._running = false;
        this.run.message = String(error.message || error);
        await this.restoreModeNow();
        this.page.onRunChange(false);
        // Reported, not swallowed. A caller waiting on the outcome -- the batch plan
        // waits on exactly this -- had no way to learn that the run never started, so
        // a failed ensureDataMode() or a refused tx.queue() left it waiting for ever:
        // its CONTINUE button then did nothing and the countdown ran on with the plan
        // already dead.
        this.report({ok: false, reason: this.run.message});
      }
      this.render();
    }

    // Every control frame from the firmware, for the same reason the beacon needs
    // them: tx-ready and tx-state are what move this driver out of "preparing",
    // and tx-level is both the credit clock and the ALC reading. Feeding only the
    // search left the driver waiting for a PTT confirmation that had already
    // arrived, and the run died with "PTT confirmation did not arrive".
    onControl(message) {
      if (!message) return;
      this.tx.onControl(message);
      if (message.type === "tx-level") this.noteLevel(message);
      else this.render();
    }

    // Also the only clock the search has: the byte counts say what the radio has
    // actually played, which no timer here can know.
    noteLevel(message) {
      if (!this.running || !this.cal) return;
      if (this.cal.state !== "searching" && this.cal.state !== "holding") return;
      if (Object.prototype.hasOwnProperty.call(message, "alcSeq")) this.run.sawAlcField = true;
      this.cal.noteSent(this.tx.sentUlaw);
      this.cal.noteLevel({consumed: message.consumed, alc: message.alc, alcSeq: message.alcSeq});
      if (this.tx.stream && Math.abs(this.tx.stream.amplitude - this.cal.gain) > 1e-6)
        this.tx.stream.setAmplitude(this.cal.gain, CAL_RAMP_SAMPLES);
      if (this.cal.state === "done") return this.finish();
      if (this.cal.state === "failed") return this.stop(this.failureText(this.cal.error));
      // Still searching: does it get more carrier?
      const now = this.page.wallNow();
      if (this.cal.steps > this.lastSteps) {
        this.lastSteps = this.cal.steps;
        this.softDeadlineMs = extendedDeadline(now, this.endsAtMs);
      }
      if (now > this.softDeadlineMs) {
        this.stop("the carrier ran out before the search finished — it stopped making " +
                  `progress at level ${this.cal.gain.toFixed(4)} after ${this.cal.steps} steps`);
        return;
      }
      this.render();
    }

    // Peaks and the SWR watch, from whatever the page polls. This is the one
    // thing on either page that deliberately drives the level UP, so it is also
    // the one place that must not keep doing so into a mismatched antenna.
    noteMeters({powerMeterRaw, swr}) {
      if (!this.running) return;
      this.run.poPeak = Math.max(this.run.poPeak, Number(powerMeterRaw) || 0);
      this.run.swrPeak = Math.max(this.run.swrPeak, Number(swr) || 0);
      if ((Number(swr) || 0) >= CAL_SWR_LIMIT)
        this.stop(`SWR reached ${Number(swr).toFixed(1)} — check the antenna`);
    }

    // The module reports what it observed; naming the likely cause needs to know
    // whether the field was even present, which only the page's link can say.
    failureText(error) {
      if (error !== "radio does not report ALC") return error;
      return this.run.sawAlcField
        ? "the radio never answered the ALC meter (CI-V 15 13) — this interface asked" +
          " for it, so the radio or its LAN CI-V stream is not returning it"
        : "this interface's firmware does not send ALC readings — flash the firmware," +
          " not just the web assets (check that /txgain.json answers)";
    }

    async finish() {
      const result = this.cal.result;
      this.cal = null;
      this.run.result = result;
      this.run.message = "";
      this.stopCarrier();
      // A ceiling result is NOT a calibration. "The level reached 0.8 and the radio
      // never limited" says the search found no knee at all -- storing 0.8 as the
      // measured level turns a failed measurement into a green number, and a whole
      // table of them is what a radio with a silent MOD level produces. It is reported
      // as a failed cell with the three causes the operator can act on.
      if (result.reachedCeiling) {
        this.run.message = "no knee found" + ceilingAdvice(this.modLevel());
        await this.restoreModeNow();
        this.page.onRunChange(false);
        this.render();
        // Not a calibration, but not nothing either: "the radio took 0.8 without
        // limiting" is the observation the batch plan's MOD-level correction is
        // built on, and it used to be thrown away here. The plan saw a bare
        // failure, recorded no survey knee, and its ceiling branch -- the one
        // that multiplies a too-low MOD level -- could never run. A station whose
        // MOD level was the whole problem therefore had no way out of it: every
        // cell above the one power that happened to fit reported "no knee found"
        // for ever. So the outcome carries the fact as well as the verdict.
        this.report({ok: false, reachedCeiling: true, knee: result.knee,
                     gain: result.gain, po: this.run.poPeak,
                     swrMax: Number(this.run.swrPeak.toFixed(1)),
                     reason: "the level reached the ceiling and the radio " +
                             "never limited — nothing was measured"});
        return;
      }
      try {
        await this.store.put(this.run.key, {
          knee: Number(result.knee.toFixed(4)), gain: Number(result.gain.toFixed(4)),
          po: this.run.poPeak, swrMax: Number(this.run.swrPeak.toFixed(1)),
          model: this.run.model, band: this.run.band, percent: this.run.percent,
          // The two fields schema v2 added. `modLevel` is what makes the entry
          // falsifiable later: without it the table cannot tell that the radio's
          // sensitivity has moved out from under every knee in it.
          modLevel: this.modLevel(), hz: Number(this.page.radio().frequency) || 0,
          reachedCeiling: result.reachedCeiling, autoTrimmed: false,
          at: this.page.now ? this.page.now() : Date.now(),
        });
      } catch (error) { this.run.message = String(error.message || error); }
      // The forward power measured during the final hold is a better reference
      // than a tune peak: the level it was taken at is known and steady.
      if (this.run.poPeak > 0 && this.run.dbm !== null && this.page.onReference)
        this.page.onReference(this.run.band, this.run.dbm, this.run.poPeak);
      await this.restoreModeNow();
      this.page.onRunChange(false);
      this.render();
      this.report({ok: true, knee: result.knee, gain: result.gain, po: this.run.poPeak,
                   swrMax: Number(this.run.swrPeak.toFixed(1)),
                   reachedCeiling: result.reachedCeiling,
                   modLevelCorrectionDb: result.modLevelCorrectionDb});
    }

    stop(reason = "operator stop") {
      // Even when there is nothing to stop: an owed outcome must be answered, or the
      // caller waits on a run that already ended.
      if (!this.running && !this.cal) { this.report({ok: false, reason}); return; }
      const swrMax = Number(this.run.swrPeak.toFixed(1));
      this.cal = null;
      this.run.message = reason;
      this.stopCarrier();
      this.restoreModeNow().then(() => { this.page.onRunChange(false); this.render(); });
      this.render();
      this.report({ok: false, reason, swrMax});
    }

    // Exactly once per run, whatever the outcome. The sequencer waits on this: a
    // measurement that ended without saying so would leave the plan holding a
    // carrier's worth of nothing, and the failure would look like a hung page.
    report(outcome) {
      const listener = this.onOutcome;
      if (!listener) return;
      this.onOutcome = null;
      listener(outcome);
    }

    stopCarrier() {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this._running = false;
      this.endsAtMs = 0;
      if (["preparing", "waiting-slot", "prebuffering", "streaming"].includes(this.tx.state))
        this.tx.fail("calibration finished");
    }

    async restoreModeNow() {
      if (!this.restoreMode || this.restoreMode === "USB-D") { this.restoreMode = ""; return; }
      const wanted = this.restoreMode;
      this.restoreMode = "";
      // Best effort: a failed restore must not turn a successful measurement into
      // an error, and the operator can see the mode on the page.
      try { await this.page.setMode(wanted); } catch (_error) {}
    }

    // The carrier's own driver has to be pumped, and its failures are the
    // calibration's, never the host page's beacon policy.
    tick() { if (this.running) this.tx.tick(); }

    onTxEvent(event) {
      if (event.type !== "failed" || !this.running) return;
      this.stop(event.reason || "the calibration carrier failed");
    }

    // ---- the panel ---------------------------------------------------------

    render() {
      if (!this.dom) return;
      this.page.mount.hidden = !this.armed;
      if (!this.armed) return;
      const identity = this.identity();
      const stored = identity ? this.store.entry(identity.key) : null;
      const problem = this.blockingReason();
      this.dom.target.textContent = identity
        ? `Will measure ${identity.model} on ${identity.band} at ${identity.percent} %` +
          (stored ? ` (previous knee ${stored.knee})` : " (never calibrated)")
        : problem || "";
      this.dom.start.textContent = this.running ? "STOP" : "START CALIBRATION";
      this.dom.start.disabled = !this.running && Boolean(problem);

      this.dom.live.hidden = !this.running;
      if (this.running && this.cal) {
        const left = Math.max(0, Math.round((this.endsAtMs - this.page.wallNow()) / 1000));
        this.dom.live.textContent =
          `${this.cal.phase || this.cal.state} · level ${this.cal.gain.toFixed(4)}` +
          ` · ALC ${this.cal.alcMax} · step ${this.cal.steps}` +
          ` · Po ${this.run.poPeak}/255 · ${left} s left`;
      }

      // A ceiling result is a failed measurement, and the failure is already
      // spelled out on the error line below. Printing "knee 0.8000, stored
      // 0.8000" beside it said the opposite of the truth twice over: 0.8 is
      // where the search gave up rather than a knee, and nothing was stored.
      const result = this.run.result && !this.run.result.reachedCeiling
        ? this.run.result : null;
      this.dom.result.hidden = !result;
      if (result) this.dom.result.textContent =
        `knee ${result.knee.toFixed(4)}, stored ${result.gain.toFixed(4)}` +
        (this.modLevel() ? ` at MOD level ${this.modLevel()}` : "") +
        ` — ${modLevelAdvice(result.knee)}`;
      this.dom.error.hidden = !this.run.message;
      this.dom.error.textContent = this.run.message;
    }
  }

  // The measured answer to "what should the MOD level in the radio's menu be",
  // which is the question this whole feature was asked for. A number, not a
  // value copied out of a manual that cannot know this radio, band or power.
  function modLevelAdvice(knee) {
    if (!(knee > 0)) return "";
    const db = 20 * Math.log10(knee / MOD_LEVEL_TARGET);
    if (Math.abs(db) < 3) return "the radio's MOD level is about right for this power";
    return `the radio's MOD level is ${Math.abs(db).toFixed(1)} dB too ` +
           `${db > 0 ? "low" : "high"} for this power (aim for a knee near ${MOD_LEVEL_TARGET})`;
  }

  // adapter: {
  //   mount, store, sink, streamId(), wallNow(), now?(),
  //   radio() -> {connected, mode, frequency, rfPower, rfPowerSeen, radioName},
  //   model() -> string, manualGain() -> number, dbm() -> number|null,
  //   blockingReason() -> string,      // the page's own gates, "" when clear
  //   ensureDataMode() -> Promise, setMode(mode) -> Promise,
  //   onRunChange(running), onReference?(band, dbm, poPeak),
  //   modLevel?() -> number,           // 0 when the radio's MOD level is unknown
  // }
  const create = adapter => new TxGainCalRun(adapter);

  return {create, TxGainCalRun, modLevelAdvice, ceilingAdvice, extendedDeadline,
          CAL_MAX_MS, CAL_EXTEND_MS, CAL_HARD_MS, CAL_TARGET_FILL_BYTES,
          CAL_RAMP_SAMPLES, CAL_LEAD_MS, CAL_SWR_LIMIT, MOD_LEVEL_TARGET,
          CAL_FIRST_TX_ID};
});
