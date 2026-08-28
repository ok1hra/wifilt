// Shared RF-power auto-apply engine: write a station-chosen percent to the
// radio when a page opens and again after the LAN link returns, backing off
// the moment the operator turns the knob on the radio itself. Extracted
// (code-review 2026-08-28) from three near-identical hand-copies -- JS8Call-
// ICOM's own applyAutoRfPower()/writeRfPercent()/noteRfKnob()/noteRadioLink()
// (data.js), and RTTY-ICOM's copy of the same shape (rtty.js, item 13,
// grilled 2026-08-27) -- the same "extract on the 2nd+ copy" precedent
// spectrum.js's own header already documents for the waterfall.
//
// WSPR-Beacon is deliberately NOT a caller of this module. Its own
// applyAutoPower()/setRadioPower() (wspr.js) share the same knob-detection
// shape, but the target itself is a *legal* WSPR dBm level chosen from a
// closed list (WsprCore.POWER_LEVELS, capped at WSPR's own 10 W band limit)
// picked from a <select>, not a freely-typed 1-100 percent -- forcing that
// into this module's plain-percent-field contract would either lose the
// legal-level quantisation or need a parallel "legal levels only" mode this
// module does not have. If a future caller ever wants to route WSPR through
// this engine, the legal-level clamp MUST happen in that caller's own
// targetPercent()/setFromField() path, never bypassed by this module's own
// plain 1-100 clamp -- this module has no concept of a band-legal ceiling.
//
// Mercury-DATA has no equivalent feature at all (own comment: "no rfPercent
// field -- no operator-facing power choice here") and is not a caller
// either. Its *tuning* power field (setTuningPowerFromField(), a one-shot
// calibration set, not an auto-apply-on-load target) is a different feature
// and stays where it is.
//
// Deliberately clock-free and DOM-light: the only DOM this module touches is
// the four elements the caller hands it in `dom`. Everything page-specific
// (where the target percent is stored, what "blocked" means, how to render
// the rest of the page) is a callback -- same adapter shape this project
// already uses for TxGainCalUi/TxGainPlanUi (tx-gain-cal-ui.js/
// tx-gain-plan-ui.js), not a new convention.
(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.RfPowerAuto = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  // config:
  //   dom: {input, set, watts, state, field}  -- field is optional (no
  //     mismatch styling if omitted)
  //   targetPercent()      -> number|null      the station's chosen target
  //   radio()              -> {connected, transceiverType, tx, rfPower, rfPowerSeen}
  //   fullWatts()          -> number|null       full-scale watts for the live model
  //   formatWatts(watts)   -> string
  //   blocked()            -> boolean           true = never auto-write right now
  //     (mid-calibration, mid-TX-plan, or anything else the page itself
  //     needs to veto on -- this module does not know about CAL/CAL PLAN or
  //     the page's own TX state, it only asks)
  //   transmitting()       -> boolean           true = something is on the air
  //     from this page right now (separate from `blocked()` so the mismatch
  //     message can still explain a stand-down that isn't a calibration)
  //   command(payload)     -> Promise            POST /cmd, same shape every
  //     page's own command() already has
  //   waitForState(predicate, timeoutMs) -> Promise  same shape every page's
  //     own waitForState() already has
  //   onWrite(percent)     -> void               persist the chosen target
  //     (setJs8Setting/settings.rfPercent+saveSettings/etc.)
  //   render()             -> void               the page's own render pass
  function create(config) {
    let rfAppliedPercent = null;   // last percent written AND confirmed by readback
    let rfKnobTouched = false;     // operator moved it; the automation stands down
    let rfAutoArmed = true;        // a write is owed: page load, or the link returned
    let rfAutoBusy = false, rfAutoRetryMs = 0, rfLinkWasUp = false, rfLastError = "";
    // What the operator has typed but not yet written. null means "not
    // editing", and only then may a render put the stored target back into
    // the box -- without it the number is lost the moment focus leaves the
    // field on the way to the SET button beside it.
    let rfDraft = null;

    function noteKnob() {
      if (rfAutoArmed || rfAppliedPercent === null) return;
      if (config.blocked()) return;
      const radio = config.radio();
      if (!radio.connected || radio.rfPowerSeen !== true) return;
      if (WsprCore.civPercent(radio.rfPower) !== rfAppliedPercent) rfKnobTouched = true;
    }

    // Every write goes through here, so SET and the automation cannot drift
    // apart. Confirmed in whole percent, never on the raw level: the radio
    // quantises to its own step, so demanding an exact echo would fail a
    // write that landed exactly where it was asked to.
    async function writePercent(percent) {
      const cmd = WsprCore.civLevelCommand(WsprCore.percentToLevel(percent));
      const wanted = WsprCore.civPercent(cmd.level);
      await config.command({type: "civ.raw", data: cmd.data});
      try {
        await config.waitForState(
          radio => radio.rfPowerSeen === true && WsprCore.civPercent(radio.rfPower) === wanted, 6000);
      } catch (_error) {
        throw new Error("the radio did not confirm the power level");
      }
      rfAppliedPercent = wanted;
      return wanted;
    }

    async function applyAuto() {
      if (rfAutoBusy || !rfAutoArmed || rfKnobTouched) return;
      if (config.blocked()) return;
      if (Date.now() < rfAutoRetryMs) return;
      const target = config.targetPercent();
      // Nothing chosen, nothing to apply -- no safe value to invent for a
      // page nobody has configured.
      if (target === null) { rfAutoArmed = false; return; }
      const radio = config.radio();
      if (!radio.connected || radio.transceiverType !== "ICOM-LAN") return;
      if (config.transmitting()) return;   // never mid-transmission
      if (radio.rfPowerSeen === true &&
          WsprCore.civPercent(radio.rfPower) === WsprCore.civPercent(WsprCore.percentToLevel(target))) {
        // Already there. Record it so the knob detector has a baseline
        // without spending a CI-V round trip to establish one.
        rfAppliedPercent = WsprCore.civPercent(WsprCore.percentToLevel(target));
        rfAutoArmed = false; return;
      }
      rfAutoBusy = true;
      try { await writePercent(target); rfAutoArmed = false; }
      catch (_error) { rfAutoRetryMs = Date.now() + 5000; }   // stays armed, backs off
      finally { rfAutoBusy = false; config.render(); }
    }

    // The operator's own write. Still the only thing that turns a number in
    // the box into a stored choice -- the automation applies a target, it
    // never decides one.
    //
    // Explicit empty/non-numeric check BEFORE the clamp (code-review
    // 2026-08-28): Number("") is 0, not NaN, so `Number(x)||0` treated a
    // cleared field the same as a typed 0, which Math.max(1,...) then
    // silently rounded up to a real 1% write -- mercury.js's own
    // setTuningPowerFromField() already carries this exact fix for its own,
    // unrelated percent field; this is the same correction, now shared.
    async function setFromField() {
      const rawInput = rfDraft ?? config.dom.input.value;
      const raw = Number(rawInput);
      if (rawInput === "" || !Number.isFinite(raw)) {
        rfLastError = "Enter a power percent first.";
        renderField();
        return;
      }
      const percent = Math.max(1, Math.min(100, Math.round(raw)));
      config.dom.input.value = String(percent);
      config.dom.set.disabled = true;
      try {
        await writePercent(percent);
        config.onWrite(percent);
        // A fresh decision stands the automation back up after a turn of the knob.
        rfKnobTouched = false; rfAutoArmed = false; rfAutoRetryMs = 0; rfLastError = "";
        rfDraft = null;   // written; the box may follow the target again
      } catch (error) {
        rfLastError = error.message;
      }
      config.dom.set.disabled = false;
      renderField();
    }

    function noteDraft() {
      rfDraft = config.dom.input.value; rfLastError = "";
      renderField();
    }

    function renderField() {
      const radio = config.radio();
      const seen = radio.rfPowerSeen === true;
      const radioPercent = seen ? WsprCore.civPercent(radio.rfPower) : null;
      const target = config.targetPercent();
      // Nothing stored yet: show what the radio is on, so SET means "adopt
      // this" rather than making the operator guess a number to type.
      if (rfDraft === null && document.activeElement !== config.dom.input)
        config.dom.input.value = String(target ?? radioPercent ?? "");
      const shown = Number(rfDraft ?? config.dom.input.value) || 0;
      const fullWatts = config.fullWatts();
      // Through percentToLevel()/255, not a flat percent-of-full multiply
      // (code-review 2026-08-28: RTTY-ICOM's own copy used to do the flat
      // version, reading a slightly different watts figure than JS8Call-ICOM
      // for the same typed percent on the same radio -- this is JS8's own,
      // more accurate formula, now the one shared shape).
      config.dom.watts.textContent = fullWatts && shown >= 1
        ? config.formatWatts(fullWatts * WsprCore.percentToLevel(shown) / 255) : "--";
      const mismatch = Boolean(target !== null && radioPercent !== null && radioPercent !== target);
      if (config.dom.field) config.dom.field.classList.toggle("mismatch", mismatch);
      // One line, one source of truth: a failed write outranks everything,
      // then the disagreement, then nothing.
      const message = rfLastError ? rfLastError
        : !mismatch ? ""
        : `The radio is on ${radioPercent} %, not the ${target} % set here` +
          (rfKnobTouched
            ? " — changed on the radio, so it is not written automatically until you press SET."
            : " — press SET to write it.");
      config.dom.state.hidden = !message;
      config.dom.state.textContent = message;
      return mismatch;
    }

    // Called once per successful state poll, after the page has merged the
    // fresh reply into whatever config.radio() reads from -- re-arms on a
    // link-down -> link-up transition (a reply that never arrived says
    // nothing about the radio, so the caller must not call this from a
    // failed poll), then runs the knob check and the auto-apply attempt.
    function onPollSuccess() {
      const radio = config.radio();
      if (radio.connected && !rfLinkWasUp) rfAutoArmed = true;
      rfLinkWasUp = radio.connected;
      noteKnob();
      applyAuto();
    }

    return {noteDraft, setFromField, renderField, onPollSuccess, applyAuto};
  }

  return {create};
});
