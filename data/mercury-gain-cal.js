// The `cal` adapter TxGainPlanUi (data/tx-gain-plan-ui.js) drives, for
// Mercury. docs/mercury-implementace.md ch.8.
//
// data/tx-gain-cal-ui.js (JS8/WSPR's own single-shot tool) is hard-wired to a
// single-tone WsprStream carrier -- by its own header comment, deliberately
// NOT either page's tune path, because the search has to move the level
// mid-keying and only a streamed tone can do that. A real Mercury DATAC1
// burst measures ~7.5 dB PAPR even after freedv's own clipping (see
// data/mercury-cal-worker.js's header); the same peak-normalised gain means
// a very different real drive level between a tone and a burst, so
// calibrating with one and applying the result to the other would let ALC
// "trample the data" -- the exact trap ch.8 already named. TxGainCalUi
// therefore cannot be reused here, and that is also why mercury-cal-worker.js
// exists as its own Worker with its own carrier, already built and verified
// live against a real IC-705 (docs, 2026-08-22).
//
// TxGainPlanUi does not know or care what the carrier is. Grepped against
// tx-gain-plan-ui.js, everything it calls on `cal` is: resolved(),
// blockingReason(), start({seed, resolutionDb, onOutcome}), stop(reason),
// plus reads of `.cal` (live progress: phase/state/gain/steps/alcMax -- the
// exact field names mercury-cal-worker.js's own "progress" message already
// uses, both being tx-gain-cal.js's TxGainCal.snapshot() one step removed)
// and `.endsAtMs`/`.page.wallNow()` for its countdown. This file is the
// bridge: everything ABOVE that line (identity, staleness, the search
// itself, the store) is tx-gain-cal.js, shared and unchanged; everything
// BELOW it (the carrier) is mercury-cal-worker.js, run in a Worker because
// Mercury's whole audio path already lives in one (mercury-worker.js).
//
// `start()`'s returned promise is deliberately not the completion signal --
// tx-gain-plan-ui.js's own measure() never awaits or .then()s it, only
// .catch()es a synchronous setup failure, and relies entirely on onOutcome
// for "this cell is done". Matching that contract (rather than making the
// promise resolve on completion, which nothing here reads) is what keeps
// this file from needing its own copy of that assumption.
(function (root, factory) {
  const value = factory(
    typeof module === "object" && module.exports ? require("./tx-gain-cal.js") : root.TxGainCal);
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.MercuryGainCal = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (TxGainCal) {
  "use strict";

  // mercury-cal-worker.js declares a 90 s loop (LOOP_MARGIN_S) and ends itself
  // as soon as the search finishes; this is only the backstop for "the Worker
  // never answered at all" (a WASM init failure that never posted "error", a
  // crashed tab). Kept comfortably ABOVE tx-gain-plan-ui.js's own measure()
  // watchdog (leadMs+hardMs+8000, ~60.5 s): that one is the informative one
  // ("the measurement never reported back (carrier cap passed)") and must
  // fire first. This one only protects against this file itself, not against
  // the plan.
  const WATCHDOG_MS = 95000;
  // Shared with tx-gain-cal-ui.js via tx-gain-cal.js's own export (see its
  // comment there). The Worker only ever sees ALC -- it has no forward-power
  // or SWR meter of its own -- so without this an antenna reflecting into
  // ALC looks exactly like audio that is genuinely too hot, and the plan's
  // MOD-level advice would name the wrong cause. WSPR/JS8's own tool has
  // carried this guard since before this file existed; Mercury's
  // calibration never did.
  const CAL_SWR_LIMIT = TxGainCal.CAL_SWR_LIMIT;

  class MercuryGainCalRun {
    constructor(adapter) {
      this.page = adapter;
      this.store = adapter.store;
      this.cal = null;      // live progress while running: {phase,state,gain,steps,alcMax}
      this.endsAtMs = 0;
      this.worker = null;
      this.watchdog = null;
      this._running = false;
      this.onOutcome = null;
      this.swrPeak = 0;
    }

    // Polled by the host page, exactly like tx-gain-cal-ui.js's own noteMeters().
    // Guarded on `_running` for the same reason: the page polls the radio's meters
    // continuously, on and off any calibration.
    noteMeters({swr}) {
      if (!this._running) return;
      this.swrPeak = Math.max(this.swrPeak, Number(swr) || 0);
      if ((Number(swr) || 0) >= CAL_SWR_LIMIT)
        this.stop(`SWR reached ${Number(swr).toFixed(1)} — check the antenna`);
    }

    get running() { return this._running; }

    // The key this radio, band and power belong under, or null when any part
    // is unknown -- same rule as tx-gain-cal-ui.js's own identity(): a
    // calibration filed under a guessed model or an unconfirmed power would be
    // applied without anyone being asked.
    identity() {
      const radio = this.page.radio();
      const model = this.page.model();
      const band = TxGainCal.bandOf(radio.frequency);
      if (!model || !band || radio.rfPowerSeen !== true) return null;
      const percent = this.page.percentOf(radio);
      return {key: TxGainCal.entryKey(model, band, percent), model, band, percent};
    }

    blockingReason() {
      const page = this.page.blockingReason();
      if (page) return page;
      if (this._running) return "a calibration is already running";
      if (!this.identity()) {
        const radio = this.page.radio();
        if (!this.page.model()) return "the radio has not reported its model yet";
        if (!TxGainCal.bandOf(radio.frequency)) return "the radio is not on an amateur band";
        return "the radio has not reported its power setting yet";
      }
      return "";
    }

    // What the table says for the radio as it stands right now -- byte-for-byte
    // tx-gain-cal-ui.js's own resolved(), just reading the MOD level through a
    // page hook instead of owning a second CI-V reader (the plan panel already
    // reads it once per window-open; see mercury.js's modLevel()/refreshModLevel()
    // hooks, which delegate to the very TxGainPlanPanel this is mounted into).
    resolved() {
      const manual = this.page.manualGain();
      const identity = this.identity();
      if (!identity) return {gain: manual, calibrated: false, key: "",
                             why: "the radio has not reported its model, band or power yet"};
      const entry = this.store.entry(identity.key);
      const modLevel = this.page.modLevel();
      const status = TxGainCal.entryStatus(entry, modLevel);
      if (status === "missing")
        return {gain: manual, calibrated: false, key: identity.key,
                band: identity.band, percent: identity.percent,
                why: `not calibrated for ${identity.band} @ ${identity.percent} %`};
      if (status === "stale")
        return {gain: manual, calibrated: false, stale: true, key: identity.key, entry,
                band: identity.band, percent: identity.percent,
                why: `measured at MOD level ${entry.modLevel}, the radio is on ` +
                     `${modLevel} — recalibrate ${identity.band} @ ${identity.percent} %`};
      return {gain: Number(entry.gain), calibrated: true, key: identity.key, entry,
              band: identity.band, percent: identity.percent,
              modUnknown: status === "unknown-mod", why: ""};
    }

    async start(options = {}) {
      const problem = this.blockingReason();
      if (problem) {
        if (options.onOutcome) options.onOutcome({ok: false, reason: problem});
        return;
      }
      const identity = this.identity();
      this.onOutcome = options.onOutcome || null;

      // Same rule as the single-shot tool: a knee is a knee AT a MOD level, and
      // the plan reads it once per window-open, not once per cell -- this only
      // fills it in the first time nobody has yet.
      if (!this.page.modLevel() && this.page.refreshModLevel) {
        try { await this.page.refreshModLevel(); } catch (_error) {}
      }
      // Without USB-D the LAN audio never reaches the modulator and the search
      // runs to the ceiling reporting "ALC never acted" -- true, wrong cause.
      try {
        if (this.page.radio().mode !== "USB-D") await this.page.ensureDataMode();
      } catch (_error) { /* best effort -- a failed mode set must not block the cell */ }

      // The Mercury session lease, not the audio session itself: the burst
      // needs the SAME AUD1 token CALL/LISTEN authenticate with, so it must
      // hold the one lease that arbitrates between this station's own pages/
      // devices, exactly like onCall()/onArmToggle() do. Claimed here (not
      // once for the whole plan) so a plan run that outlives an operator
      // closing the tab cannot leave the lease held with nothing using it.
      let claimedHere = false;
      try {
        if (!this.page.sessionHeld()) {
          const granted = await this.page.claimSession();
          if (!granted) {
            this.onOutcome && this.onOutcome({ok: false, reason: "another device holds the Mercury session"});
            this.onOutcome = null;
            return;
          }
          claimedHere = true;
        }
      } catch (error) {
        this.onOutcome && this.onOutcome({ok: false, reason: String(error.message || error)});
        this.onOutcome = null;
        return;
      }

      const stored = this.store.entry(identity.key);
      const modLevel = this.page.modLevel();
      const seed = Number(options.seed) > 0 ? Number(options.seed)
        : (stored ? TxGainCal.seedFrom(stored, modLevel) : 0);

      this._running = true;
      this.swrPeak = 0;
      this.cal = {phase: "starting", state: "starting", gain: seed || 0, steps: 0, alcMax: 0};
      this.endsAtMs = this.page.wallNow() + WATCHDOG_MS;
      this.page.onRunChange(true);
      this.claimedHere = claimedHere;

      this.watchdog = setTimeout(
        () => this.finish({ok: false, reason: "the measurement never reported back (worker timeout)"}),
        WATCHDOG_MS);

      this.worker = new Worker("/mercury-cal-worker.js");
      this.worker.onmessage = event => {
        const msg = event.data || {};
        if (msg.type === "progress") {
          this.cal = {phase: msg.phase, state: msg.state, gain: msg.gain,
                      steps: msg.steps, alcMax: msg.alcMax};
          return;
        }
        if (msg.type === "log") return;
        if (msg.type === "error") { this.finish({ok: false, reason: msg.detail || msg.reason}); return; }
        if (msg.type === "done") {
          const result = msg.result;
          if (!msg.ok || !result) {
            this.finish({ok: false, reason: msg.error || "calibration did not finish"});
            return;
          }
          // A ceiling is not a measurement -- same rule as tx-gain-cal-ui.js's
          // own finish(): the level climbed to the search's own ceiling and the
          // radio never limited, so there is no knee to store, only the
          // MOD-level correction the plan's writeMod step acts on.
          this.finish(result.reachedCeiling
            ? {ok: false, reachedCeiling: true, knee: result.knee, gain: result.gain,
               modLevelCorrectionDb: result.modLevelCorrectionDb,
               reason: "no knee found — the radio never limited at this MOD level"}
            : {ok: true, knee: result.knee, gain: result.gain,
               modLevelCorrectionDb: result.modLevelCorrectionDb});
        }
      };
      this.worker.onerror = event =>
        this.finish({ok: false, reason: `calibration worker crashed: ${event.message || event}`});
      this.worker.postMessage({
        type: "start", wsPort: this.page.audioPort(), token: this.page.audioToken(),
        model: identity.model, frequencyHz: Number(this.page.radio().frequency) || 0,
        percent: identity.percent, knownKnee: seed, modLevel,
      });
    }

    finish(outcome) {
      if (!this._running) return;
      this._running = false;
      const swrMax = Number(this.swrPeak.toFixed(1));
      this.cal = null;
      if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
      if (this.worker) { try { this.worker.terminate(); } catch (_e) {} this.worker = null; }
      this.page.onRunChange(false);
      if (this.claimedHere) { this.page.releaseSession(); this.claimedHere = false; }
      const cb = this.onOutcome; this.onOutcome = null;
      if (cb) cb({...outcome, swrMax});
    }

    stop(reason) { this.finish({ok: false, reason: reason || "operator stop"}); }
  }

  function create(adapter) { return new MercuryGainCalRun(adapter); }
  return {create};
});
