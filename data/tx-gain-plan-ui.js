// The batch calibration panel: the band × power grid, and the loop that runs it.
//
// It owns no measuring of its own. The carrier, the ALC search and the write into
// the table are tx-gain-cal-ui.js, exactly as for a single calibration -- this
// borrows that run as a measuring device and adds the three things a batch needs:
// a plan to work through, a radio it drives itself, and a question before every
// retune. Two copies of a transmitter-keying path is the thing this project has
// most consistently refused.
//
// Split out of tx-gain-cal-ui.js rather than added to it. That file is the carrier
// and the byte accounting; putting a grid editor and a two-phase sequencer beside
// them would make one file where nobody can tell what transmits from what decides.
// Both are still one implementation mounted by both pages, which is what decision
// 12 is about.
//
// Nothing here decides the ORDER of anything: that is tx-gain-plan.js, which is
// clock-free and testable. This file executes intents and draws.

(function (root, factory) {
  const value = factory(
    typeof module === "object" && module.exports ? require("./tx-gain-plan.js") : root.TxGainPlan,
    typeof module === "object" && module.exports ? require("./tx-gain-cal.js") : root.TxGainCal,
    typeof module === "object" && module.exports ? require("./tx-gain-mod-level.js") : root.TxGainModLevel,
    typeof module === "object" && module.exports ? require("./icom-models.js") : root.IcomModels);
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.TxGainPlanUi = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (TxGainPlan, TxGainCal, TxGainModLevel, IcomModels) {
  "use strict";

  // The panel wears the timetable's clothes: the host page gives it
  // `.freq-timetable-panel` (bordered, absolutely positioned under its topbar
  // button, 520 px wide) and everything below only styles the inside. `.plan-body`
  // is the grid layout the content used to get from `.plan-field` when this lived
  // inline in the settings column.
  const CSS = ""
    + ".plan-body{display:grid;gap:8px}"
    + ".plan-field p{margin:0}"
    + ".plan-note{color:#8ba59d;font-size:12px;line-height:1.5}"
    + ".plan-grid{display:grid;gap:2px;font-size:12px;overflow-x:auto}"
    + ".plan-row{display:flex;gap:4px;align-items:center}"
    + ".plan-row>b{min-width:44px;color:#fff}"
    + ".plan-hz{width:96px;background:#10201c;color:#dfe9e5;border:1px solid #3a5a50;padding:2px 4px}"
    + ".plan-cell{min-width:64px;padding:3px 4px;border:1px solid #3a5a50;background:#10201c;"
    + "color:#8ba59d;cursor:pointer;font:inherit;text-align:center}"
    + ".plan-cell.on{border-color:#e0a020;color:#e0a020}"
    + ".plan-cell.ok{background:#16301f;color:#9fd39f;border-color:#3f7f4f}"
    + ".plan-cell.stale{background:#2e2410;color:#e0a020;border-color:#7f6320}"
    + ".plan-cell.failed{background:#2e1614;color:#e06c5a;border-color:#7f3a30}"
    + ".plan-cell.busy{outline:1px solid #e0a020}"
    + ".plan-grid.locked .plan-cell,.plan-grid.locked .plan-hz{cursor:default;opacity:.75}"
    + ".plan-grid.locked [data-remove-row]{visibility:hidden}"
    + ".plan-head{display:flex;gap:4px;color:#8ba59d}"
    + ".plan-head>b{min-width:44px}.plan-head>span{min-width:64px;text-align:center}"
    + ".plan-hzwarn{color:#e0a020;font-size:11px}"
    + ".plan-axis{color:#8ba59d;font-size:11px;text-transform:uppercase;min-width:104px}"
    + ".freq-timetable.asking{border-color:#e0a020;color:#e0a020;box-shadow:0 0 7px #e0a02044}"
    + ".freq-timetable.uncalibrated{border-color:#e06c5a;color:#e06c5a}"
    + ".freq-timetable.uncalibrated b{color:#e06c5a}"
    + ".plan-power-input{width:56px;background:#10201c;color:#dfe9e5;border:1px solid #3a5a50;padding:2px 4px}"
    + ".plan-chip{border:1px solid #674a30;color:#e0a020;padding:1px 4px;margin-right:4px;font-size:12px}"
    + ".plan-chip button{background:none;border:0;color:#8ba59d;cursor:pointer;padding:0 0 0 4px}"
    + ".plan-ask{border:1px solid #e0a020;padding:8px;display:grid;gap:6px;background:#241c08}"
    + ".plan-ask b{color:#e0a020}"
    + ".plan-ask label{display:flex;gap:6px;align-items:center;color:#8ba59d;font-size:12px}"
    + ".plan-ask label input{accent-color:#e0a020}"
    + ".plan-live{font-family:ui-monospace,monospace;font-size:12px;color:#e0a020}"
    + ".plan-error{font-size:12px;color:#e06c5a;line-height:1.5}"
    + ".plan-ok{font-size:12px;color:#9fd39f;line-height:1.5}"
    + ".plan-field button{cursor:pointer}"
    // A control that cannot be pressed says so before it is pressed. Same grammar the
    // rest of the interface already uses for this (.tune, .heartbeat, .traffic-filter
    // button): dimmed and not-allowed, so it is not mistakeable for a live one at a
    // glance. It matters here more than elsewhere -- during a run the only live
    // buttons are STOP and the two answers, and everything else on the panel would
    // otherwise look exactly as inviting.
    + ".plan-field button:disabled,.plan-field select:disabled,"
    + ".plan-field input:disabled{opacity:.4;cursor:not-allowed;color:#61746f;"
    + "border-color:#2a453e}"
    + ".plan-field button:disabled{box-shadow:none}"
    + ".plan-tools{display:flex;gap:6px;flex-wrap:wrap;align-items:center}"
    + ".plan-todo{border-left:3px solid #e0a020;padding:4px 8px;color:#e0a020;font-size:12px}"
    + ".plan-radio-line{display:block;color:#8ba59d;font-size:12px;line-height:1.6}"
    + ".plan-radio-line b{color:#dfe9e5}"
    + ".plan-todo.working{border-left-color:#3a5a50;color:#8ba59d}"
    + ".plan-field button.wanted{border-color:#e0a020;color:#e0a020;box-shadow:0 0 6px #e0a02044}";

  // Two separate rows, one per axis, and each says what it edits. They used to
  // share a line -- the powers field beside the band picker -- which read as if the
  // percentage belonged to the band about to be added. It does not: a power is a
  // COLUMN of the whole matrix, a band is a ROW, and one line for both invited
  // exactly that misreading.
  const MARKUP = ""
    + '<header><div><strong>TX gain calibration plan</strong>'
    + '<small>band × power matrix · the run tunes the radio and keys its own carrier</small>'
    + '</div><div class="tt-actions">'
    + '<button class="tt-clear" type="button" data-plan="close" title="Close">CLOSE</button>'
    + '</div></header>'
    + '<div class="plan-body">'
    + '<p class="plan-note">Measures every ticked cell: it tunes the radio, sets the'
    + ' power and keys a carrier itself. It asks about the antenna before every'
    + ' retune, and it never continues without an answer.</p>'
    + '<div class="plan-tools"><span class="plan-axis">rows &mdash; bands</span>'
    + '<select data-plan="addband" aria-label="band to add"></select>'
    + '<button type="button" data-plan="add">ADD BAND</button></div>'
    + '<div class="plan-tools"><span class="plan-axis">columns &mdash; powers</span>'
    + '<span data-plan="powerchips"></span>'
    + '<input class="plan-power-input" data-plan="newpower" type="number" min="1" max="100"'
    + ' step="1" inputmode="numeric" placeholder="%" aria-label="power in percent to add">'
    + '<button type="button" data-plan="addpower">ADD POWER</button></div>'
    + '<div class="plan-grid" data-plan="grid"></div>'
    + '<p class="plan-note" data-plan="estimate"></p>'
    // The two numbers the whole feature turns on, and neither was visible anywhere:
    // what the radio's own MOD level is (ONE value for every band -- that is what makes
    // it the outer loop) and what audio level a transmission would actually use right
    // now. Without them the tool reads as static even though the level is resolved per
    // transmission.
    + '<p class="plan-note" data-plan="radio"></p>'
    + '<div class="plan-tools">'
    + '<button type="button" data-plan="run">RUN</button>'
    + '<button type="button" data-plan="runall">RE-MEASURE ALL</button>'
    + '<button type="button" data-plan="stop" hidden>STOP</button>'
    + '</div>'
    // Why RUN would refuse, said BEFORE it is pressed. A disabled button with no
    // sentence beside it is how "RUN does nothing at all" happens.
    + '<p class="plan-note" data-plan="blocked" hidden></p>'
    // What the OPERATOR has to do next, said out loud. The panel could say what it was
    // doing but never whose turn it was, so "maybe I am supposed to press RUN and do
    // not know it" was the honest reaction.
    + '<p class="plan-todo" data-plan="todo"></p>'
    + '<div class="plan-ask" data-plan="ask" hidden></div>'
    + '<p class="plan-live" data-plan="live" hidden></p>'
    + '<p class="plan-ok" data-plan="done" hidden></p>'
    + '<p class="plan-error" role="alert" data-plan="error" hidden></p>'
    + '</div>';

  // The carrier's own limits, read from the tool that owns them rather than copied.
  // The watchdog has to outlast a legitimate run, so it must not guess at its length.
  const TxGainCalUiCaps = () => {
    const ui = typeof module === "object" && module.exports
      ? require("./tx-gain-cal-ui.js")
      : (typeof globalThis !== "undefined" ? globalThis : self).TxGainCalUi;
    return {leadMs: (ui && ui.CAL_LEAD_MS) || 2500,
            maxMs: (ui && ui.CAL_MAX_MS) || 20000,
            // The watchdog must outlast the HARD cap, or it fires on a search that
            // the carrier extension is legitimately still running.
            hardMs: (ui && ui.CAL_HARD_MS) || 50000};
  };

  let cssInstalled = false;
  function installCss(document) {
    if (cssInstalled || !document) return;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    cssInstalled = true;
  }

  // Frequencies where a 20 s carrier is not a private matter. The WSPR window is
  // 200 Hz wide and the tool keys 1500 Hz up from the dial, so calibrating on a
  // WSPR dial burns that slot for everyone decoding the band -- which is fine for
  // one deliberate measurement and rude thirty times over.
  const BUSY_WINDOWS = [];
  function busyWindow(hz) {
    for (const window of BUSY_WINDOWS)
      if (Math.abs(hz - window.hz) <= window.span) return window.what;
    return "";
  }
  function registerBusyWindows(wsprPresets, js8Presets) {
    if (BUSY_WINDOWS.length) return;
    for (const preset of wsprPresets || [])
      BUSY_WINDOWS.push({hz: Number(preset.hz) + 1500, span: 300, what: "the WSPR window"});
    for (const preset of js8Presets || [])
      BUSY_WINDOWS.push({hz: Number(preset.frequencyHz) + 1500, span: 1600, what: "the JS8 window"});
  }

  class TxGainPlanPanel {
    // `adapter` is the page, plus what the batch needs beyond a single run:
    //   cal              the TxGainCalRun this page already mounts
    //   resultStore      profile-specific measured gains (legacy name: store)
    //   planStore        station-wide shared band x power plan
    //   setFrequency(hz) -> Promise, confirmed against /state
    //   setPercent(pc)   -> Promise, confirmed in whole percent
    //   send(payload)    -> Promise, POST /cmd (used for civ.read and the MOD write)
    //   planBlockingReason() -> string, the page's extra gates for a batch run
    //   onPlanChange(running)
    //   bands()          -> [{band, hz}] offered in the ADD BAND menu
    constructor(adapter) {
      this.page = adapter;
      this.store = adapter.resultStore || adapter.store;
      this.planStore = adapter.planStore || this.store;
      this.cal = adapter.cal;
      this.plan = TxGainPlan.normalizePlan(this.planStore.plan());
      this.run = null;
      this.ask = null;               // the pending antenna question
      this.askAtMs = 0;
      // The operator's opt-out from the question, and the box that arms it. Both
      // live on the panel rather than in tx-gain-plan.js on purpose: the RULE is
      // "one question per retune" and that stays where the safety rules are; this
      // is the operator answering the remaining ones in advance, which is a fact
      // about the person at the desk and not about the plan. Per run, never
      // stored: an antenna confirmation that outlived the session it was given in
      // would be a confirmation about a station nobody was standing next to.
      this.askAll = false;           // the checkbox, while a question is up
      this.autoAnswer = false;       // armed: answer the remaining questions "ok"
      this.message = "";
      this.summary = "";
      this.busyCell = null;
      this.acting = false;
      // `begin()` has several awaited preflight steps before `run` exists. Without
      // a separate state both RUN buttons stayed live and the panel went back to
      // saying "press RUN" while it was actually reading CI-V / saving a resume
      // marker. A second click then started a competing preflight against the same
      // one-slot CI-V reply mailbox.
      this.starting = false;
      this.busyNote = "";
      this.modReadPromise = null;
      // The model is passed as a GETTER, not as a value: this panel is built when the
      // page loads and the radio has not answered its capabilities packet yet, so a
      // number read here would be null for the rest of the session.
      this.mod = new TxGainModLevel.ModLevelClient({
        send: payload => adapter.send(payload),
        model: () => (adapter.modelNumber ? adapter.modelNumber() : null),
      });
      registerBusyWindows(adapter.wsprPresets, adapter.js8Presets);

      if (adapter.mount) {
        installCss(adapter.mount.ownerDocument);
        adapter.mount.classList.add("plan-field");
        adapter.mount.innerHTML = MARKUP;
        this.dom = {};
        for (const node of adapter.mount.querySelectorAll("[data-plan]"))
          this.dom[node.dataset.plan] = node;
        if (adapter.calibrationProfileLabel) {
          const subtitle = adapter.mount.querySelector("header small");
          if (subtitle) subtitle.textContent += ` · ${adapter.calibrationProfileLabel} results`;
        }
        this.dom.add.addEventListener("click", () => this.addBand());
        this.dom.addpower.addEventListener("click", () => this.addPower());
        this.dom.newpower.addEventListener("keydown", event => {
          if (event.key === "Enter") { event.preventDefault(); this.addPower(); }
        });
        this.dom.powerchips.addEventListener("click", event => {
          const chip = event.target.closest("[data-remove-power]");
          if (chip) this.removePower(Number(chip.dataset.removePower));
        });
        this.dom.run.addEventListener("click", () => this.begin(false));
        this.dom.runall.addEventListener("click", () => this.begin(true));
        this.dom.stop.addEventListener("click", () => this.stop("operator stop"));
        // The grid is rewritten on every render, so events are delegated: a
        // listener bound to a cell would be pointing at a node that innerHTML has
        // already detached -- the trap this repo has hit three times.
        this.dom.grid.addEventListener("click", event => {
          const cell = event.target.closest("[data-cell]");
          if (cell) this.toggleCell(Number(cell.dataset.row), Number(cell.dataset.column));
          const remove = event.target.closest("[data-remove-row]");
          if (remove) this.removeBand(Number(remove.dataset.removeRow));
        });
        this.dom.grid.addEventListener("change", event => {
          const input = event.target.closest("[data-hz]");
          if (input) this.setHz(Number(input.dataset.hz), input.value);
        });
        this.dom.ask.addEventListener("click", event => {
          const action = event.target.closest("[data-answer]");
          if (action) this.answer(action.dataset.answer);
        });
        // The question redraws twice a second (the "waiting 4:12" line has to be
        // honest), and the redraw is an innerHTML rewrite -- so a checkbox that
        // kept its own state would be unticked again within half a second of
        // being ticked. The flag is the state; the box only shows it.
        this.dom.ask.addEventListener("change", event => {
          const box = event.target.closest("[data-answer-all]");
          if (box) this.askAll = Boolean(box.checked);
        });
        // After the dom map is built, never before: wireWindow reaches for
        // this.dom.close, and calling it a few lines earlier threw inside the
        // constructor and took the whole page script with it.
        this.wireWindow(adapter);
        this.renderBandMenu();
        // Drawn once at construction. Without this the panel showed only its static
        // markup -- an empty amber frame with an empty grid and an empty estimate --
        // because the only render() calls were the hash handler on one page and a tick
        // that redraws only while a question is up.
        this.render();
      }
    }

    // Adopt whatever the station's file turned out to hold. The store loads
    // asynchronously after the page boots, so the plan captured in the constructor is
    // the empty default; without this, a plan built on another device stayed invisible
    // until something else happened to redraw.
    reload() {
      const stored = TxGainPlan.normalizePlan(this.planStore.plan());
      if (stored.rows.length || stored.powers.length) this.plan = stored;
      else this.trySeed();
      this.render();
    }

    // A first plan that is already usable. An empty grid is technically correct and
    // practically a dead end: there is nothing to tick, so RUN can only refuse, and
    // the panel reads as broken. The seed is not a guess -- the powers are the two
    // this station actually operates on (the WSPR target and the JS8 setting) and the
    // row is the band the radio is on right now.
    // Retried rather than done once. The store loads seconds after the page boots and
    // the radio may not have reported a frequency yet, so the first attempt can find no
    // band at all -- and a one-shot seed then left the grid permanently empty, with
    // nothing to tick and RUN able only to refuse. Attempted again whenever the window
    // is opened, by which time the radio has long answered.
    trySeed() {
      if (this.plan.rows.length || this.plan.powers.length) return;
      const powers = TxGainPlan.normalizePowers(
        this.page.defaultPowers ? this.page.defaultPowers() : []);
      const radio = this.page.radio();
      const band = TxGainCal.bandOf(Number(radio.frequency) || 0);
      if (!band) return;                 // nothing honest to offer yet; try again later
      const preset = this.page.bands
        ? this.page.bands().find(entry => entry.band === band) : null;
      // Deliberately not saved: a plan nobody asked for must not become the station's
      // stored plan behind their back. The first edit writes it.
      this.plan = {powers,
                   rows: [{band, hz: preset ? preset.hz : Number(radio.frequency),
                           cells: powers.map(() => 1)}]};
    }

    get running() { return Boolean(this.run && this.run.running); }

    // ---- the window --------------------------------------------------------
    //
    // Same behaviour as the TIMETABLE panel it sits next to: a topbar button opens
    // it, an outside click or Escape closes it. With one rule of its own -- while a
    // question about the antenna is waiting, the window CANNOT be closed. A run that
    // is about to key a carrier must not be able to hide the only place its question
    // is asked; every other dismissal would leave a transmitter waiting behind a
    // panel nobody can see.
    wireWindow(adapter) {
      this.button = adapter.button || null;
      const doc = adapter.mount.ownerDocument;
      this.dom.close.addEventListener("click", () => this.close());
      if (this.button)
        // No stopPropagation: the outside-click listener below already ignores clicks
        // on this button, and stopping the event also stopped the page's own
        // capture-phase bookkeeping from seeing it -- which is how the click ended up
        // both opening and closing the window in the same gesture.
        this.button.addEventListener("click", () => this.toggleWindow());
      // Capture on the document, like the timetable's: a click inside must not close.
      doc.addEventListener("click", event => {
        if (this.page.mount.hidden || this.pinned()) return;
        if (this.page.mount.contains(event.target)) return;
        if (this.button && this.button.contains(event.target)) return;
        this.close();
      });
      doc.addEventListener("keydown", event => {
        if (event.key === "Escape" && !this.page.mount.hidden && !this.pinned()) this.close();
      });
    }

    // One CI-V read, when the window opens and not on a timer: the MOD level changes
    // only when somebody turns a knob or this tool writes it. It is what says whether
    // the stored table still describes this radio.
    // Awaitable, because the single-shot calibration waits on it: a knee is a knee
    // AT a MOD level, and a run that stored `modLevel: 0` produced an entry nothing
    // could ever call stale -- measured, unfalsifiable, and re-measured by every
    // plan afterwards. That was every calibration started from the settings panel
    // without opening this window first.
    refreshModLevel() {
      if (this.running) return Promise.resolve(this.mod.value);
      // Opening the panel starts this read. If RUN is pressed before it finishes,
      // hand the same promise to begin() instead of arming a second CI-V read for
      // the same global reply slot.
      if (this.modReading)
        return this.modReadPromise || Promise.resolve(this.mod.value);
      if (!this.mod.capability.readable) { this.render(); return Promise.resolve(0); }
      this.modReading = true;
      this.render();
      const pending = this.mod.readLevel()
        .catch(() => null)
        .then(value => {
          this.modReading = false;
          this.modReadPromise = null;
          this.render();
          return value;
        });
      this.modReadPromise = pending;
      return pending;
    }

    // Cannot be dismissed while it is asking. Not while merely running: a long run
    // with the window closed is fine and the button says so -- it is the QUESTION
    // that has to stay on screen.
    pinned() { return Boolean(this.ask); }

    open() {
      // The seed gets its chance here too: by the time anyone opens the window the
      // radio has reported its band, which it had not when the page booted.
      this.trySeed();
      this.refreshModLevel();
      this.page.mount.hidden = false;
      if (this.button) this.button.setAttribute("aria-expanded", "true");
      this.render();
    }

    close() {
      if (this.pinned()) return;
      this.page.mount.hidden = true;
      if (this.button) this.button.setAttribute("aria-expanded", "false");
      this.renderButton();
    }

    // Named, not `toggle`. There was a second `toggle(rowIndex, column)` further down
    // for a grid cell, so the class silently kept ONE of them -- the later one -- and
    // the topbar button called the cell version with undefined arguments. It ran, did
    // nothing, and reported nothing: the button looked dead and the panel never opened.
    toggleWindow() { if (this.page.mount.hidden) this.open(); else this.close(); }

    // The button carries the one thing worth glancing at, in the timetable's own
    // grammar. An unanswered question outranks everything else, because the run is
    // stopped until it is answered and the panel may be closed.
    renderButton() {
      if (!this.button) return;
      const value = this.button.querySelector("b");
      const cost = TxGainPlan.estimate(this.plan);
      const snapshot = this.run ? this.run.snapshot() : null;
      let text = cost.cells ? `${cost.cells} CELLS` : "EMPTY";
      // Phase AND position. "0/4" through the whole survey is true and useless: the
      // survey is carriers too, and its cells are not the matrix's.
      if (snapshot) text = snapshot.progress
        ? `${snapshot.progress.label.toUpperCase()} ${snapshot.progress.at}/${snapshot.progress.of}`
        : `${snapshot.done}/${snapshot.total}`;
      if (this.ask) text = `ANTENNA? ${this.ask.band}`;
      // Red when the station is not ready to transmit at a measured level: either the
      // table is empty altogether, or -- the case that actually bites -- the radio is
      // sitting on a band and power nothing has ever been measured for, so every
      // transmission is going out at the manual guess.
      const resolved = this.cal.resolved();
      const empty = !Object.keys((this.store.doc && this.store.doc.entries) || {}).length;
      const uncalibrated = !snapshot && !this.ask && (empty || !resolved.calibrated);
      if (uncalibrated && !this.ask) text = empty ? "NOT CALIBRATED"
        : resolved.stale ? "TRX MOD DIFFERENT FROM MEASURED" : "NOT FOR THIS BAND";
      if (value) value.textContent = text;
      this.button.classList.toggle("active", Boolean(snapshot) || Boolean(this.ask));
      this.button.classList.toggle("asking", Boolean(this.ask));
      this.button.classList.toggle("uncalibrated", Boolean(uncalibrated));
      this.button.title = uncalibrated
        ? (empty ? "Nothing has been calibrated yet — transmissions use the manual gain"
                 : resolved.stale ? String(resolved.why || "TRX MOD differs from the measurement")
                 : `No calibration for ${resolved.band || "this band"} @ ` +
                   `${resolved.percent || "?"} % — this transmission would use the manual gain`)
        : "TX gain calibration plan";
    }

    // ---- editing -----------------------------------------------------------

    async savePlan() {
      this.plan = TxGainPlan.normalizePlan(this.plan);
      try { await this.planStore.putPlan(this.plan); }
      catch (error) { this.message = String(error.message || error); }
      this.render();
    }

    // Columns are edited one at a time now, not by retyping a comma-separated list.
    // The list was both the only way to add a power and completely undiscoverable --
    // "I cannot see how to add another power to a band" is the same complaint.
    setPowers(wanted) {
      const powers = TxGainPlan.normalizePowers(wanted);
      // Cells follow their column, so a changed power list has to move them: the
      // flags are positional and re-sorting the header without them would silently
      // reassign every tick to a different power.
      const previous = this.plan.powers.slice();
      this.plan.rows = this.plan.rows.map(row => ({...row,
        cells: powers.map(percent => {
          const at = previous.indexOf(percent);
          // A brand-new column starts ticked on every row that has anything ticked:
          // adding a power means "also measure this", and an all-blank new column
          // would look like the button did nothing.
          if (at >= 0) return row.cells[at] ? 1 : 0;
          return row.cells.some(Boolean) ? 1 : 0;
        })}));
      this.plan.powers = powers;
      this.message = "";
      this.savePlan();
    }

    addPower() {
      const percent = Math.round(Number(this.dom.newpower.value));
      if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
        this.message = "a power is a whole percentage of the radio's scale, 1 to 100";
        this.render();
        return;
      }
      if (this.plan.powers.includes(percent)) {
        this.message = `${percent} % is already a column`;
        this.render();
        return;
      }
      if (this.plan.powers.length >= 4) {
        // Four is the cap from the design, and the reason is airtime: every column is
        // one more carrier on every band.
        this.message = "four powers is the limit — every column is another carrier on " +
                       "every band; remove one first";
        this.render();
        return;
      }
      this.dom.newpower.value = "";
      this.setPowers([...this.plan.powers, percent]);
    }

    removePower(percent) {
      this.setPowers(this.plan.powers.filter(value => value !== percent));
    }

    addBand() {
      const value = this.dom.addband.value;
      if (!value) return;
      const [band, hz] = value.split("|");
      if (this.plan.rows.some(row => row.band === band)) return;
      this.plan.rows.push({band, hz: Number(hz),
                           cells: this.plan.powers.map(() => 1)});
      this.savePlan();
    }

    removeBand(index) {
      this.plan.rows.splice(index, 1);
      this.savePlan();
    }

    setHz(index, value) {
      const row = this.plan.rows[index];
      if (!row) return;
      // kHz in, Hz stored: the operator reads a dial in kHz and a seven-digit field
      // invites a typo that lands on another band.
      const khz = Number(String(value).replace(",", "."));
      if (Number.isFinite(khz) && khz > 0) row.hz = Math.round(khz * 1000);
      this.savePlan();
    }

    toggleCell(rowIndex, column) {
      const row = this.plan.rows[rowIndex];
      if (!row || this.running) return;
      row.cells[column] = row.cells[column] ? 0 : 1;
      this.savePlan();
    }

    // ---- the run -----------------------------------------------------------

    async begin(measureAll) {
      if (this.running || this.starting) return;
      this.starting = true;
      this.message = "";
      this.summary = "";
      this.busyNote = "preparing the calibration run…";
      // Never inherited from the last run: the operator confirmed the antennas
      // that were connected then.
      this.askAll = false;
      this.autoAnswer = false;
      this.render();
      let started = false;
      try {
        const problem = this.blockingReason();
        if (problem) { this.message = problem; return; }

        // The MOD level, before anything transmits. Read first: an address the radio
        // has not confirmed is an address this never writes to, and where that fails
        // the operator's own rule applies -- stop and say what to set by hand.
        //
        // It takes up to 2.5 s of polling, and a button that goes quiet for two and a
        // half seconds and then possibly still refuses reads as a button that does
        // nothing. So say what is happening while it happens.
        this.busyNote = "reading the radio's MOD level…";
        this.render();
        let modLevel = 0;
        if (!this.mod.capability.readable) {
          this.message = this.modInstruction(this.mod.capability.reason);
          return;
        }
        modLevel = this.modReading && this.modReadPromise
          ? await this.modReadPromise : await this.mod.readLevel();
        if (modLevel === null) {
          this.message = this.modInstruction(this.mod.error);
          return;
        }

        // And is the modulator even listening to the network input? This used to be
        // one of three guesses printed after a failed search; on a model whose DATA
        // MOD subaddress is known it is now a fact.
        this.busyNote = "reading the radio's data-mode MOD input…";
        this.render();
        const input = await this.mod.readInput();
        if (input.known && !input.isNet) {
          this.message = `the radio's data-mode MOD input is set to ${input.raw}, not ` +
            `${this.mod.capability.inputNet} (${this.mod.capability.model.net}) — LAN audio ` +
            "does not reach the modulator, so nothing here can be measured";
          return;
        }

        this.busyNote = measureAll
          ? "preparing a fresh measurement of every selected cell…"
          : "preparing the stored MOD transition for verification…";
        this.render();
        let resumeTransition = null;
        try {
          resumeTransition = await this.resumeTransitionFor(modLevel, measureAll);
        } catch (error) {
          this.message = "storing the interrupted MOD transition failed: " +
            String(error.message || error);
          return;
        }

        this.run = new TxGainPlan.TxGainPlanRun({
          plan: this.plan, modLevel, measureAll, resumeTransition,
          resolve: cell => this.store.entry(TxGainCal.entryKey(
            this.page.model(), cell.band, cell.percent)),
        });
        this.run.begin();
        this.page.onPlanChange(true);
        this.snapshotRadio();
        started = true;
      } catch (error) {
        // Every preflight exception is visible. In particular, readInput() and a
        // host-page hook used to reject the event promise without putting anything
        // into the panel, which was indistinguishable from a dead button.
        this.message = "starting the calibration plan failed: " +
          String(error.message || error);
        if (this.run && !started) {
          this.run = null;
          try { this.page.onPlanChange(false); } catch (_error) {}
        }
      } finally {
        this.starting = false;
        this.busyNote = "";
        this.render();
      }
      if (started) this.pump();
    }

    // A global MOD write makes every old entry stale at once. The transition is
    // persisted before that write, so another page can verify the new level and
    // continue the clean matrix after a reload, link loss or operator STOP.
    async persistTransition(value) {
      this.pendingTransition = value || null;
      if (this.planStore && typeof this.planStore.putPending === "function")
        await this.planStore.putPending(value || null);
    }

    // Older firmware assets could already leave the station in the same state
    // without a marker. A selected stale entry is enough evidence that the TRX
    // MOD differs from its measurement; RUN measures the matrix at today's MOD.
    legacyTransition(modLevel) {
      const staleLevels = new Set();
      let owner = null;
      for (const cell of TxGainPlan.cellsOf(this.plan)) {
        const key = TxGainCal.entryKey(this.page.model(), cell.band, cell.percent);
        const entry = this.store.entry(key);
        if (TxGainCal.entryStatus(entry, modLevel) !== "stale") continue;
        const measuredAt = Number(entry && entry.modLevel) || 0;
        if (measuredAt) staleLevels.add(measuredAt);
        const knee = TxGainCal.seedFrom(entry, modLevel);
        if (knee > 0 && (!owner || knee > owner.knee))
          owner = {...cell, knee, reachedCeiling: false};
      }
      if (!staleLevels.size) return null;
      return {from: staleLevels.size === 1 ? [...staleLevels][0] : 0,
        target: modLevel, corrections: 0, model: String(this.page.model() || ""),
        owner, at: Date.now()};
    }

    async resumeTransitionFor(modLevel, measureAll) {
      const stored = this.planStore && typeof this.planStore.pending === "function"
        ? this.planStore.pending() : null;
      // RE-MEASURE ALL explicitly requests a fresh survey and MOD optimisation.
      if (measureAll) {
        if (stored) await this.persistTransition(null);
        return null;
      }
      const model = String(this.page.model() || "");
      if (stored && Number(stored.target) === Number(modLevel) &&
          (!stored.model || stored.model === model)) {
        this.pendingTransition = stored;
        return stored;
      }
      if (stored) await this.persistTransition(null);
      const legacy = this.legacyTransition(modLevel);
      if (!legacy) return null;
      await this.persistTransition(legacy);
      return legacy;
    }

    // The operator's own rule, in one sentence: if the level cannot be read or
    // written, say what to set by hand and stop. Never proceed on a guess -- every
    // knee in the matrix is a knee at a MOD level, so an unknown one makes the whole
    // table unfalsifiable.
    modInstruction(why) {
      const menu = this.mod.capability.menu;
      const net = this.mod.capability.model ? this.mod.capability.model.net + " " : "";
      return `${why}. Set the ${net}MOD level in the radio's own menu` +
        (menu ? ` (${menu})` : "") +
        ", then start the plan again — it cannot continue without knowing it.";
    }

    // What to put back afterwards. Taken before the first write, because after that
    // every reading describes the plan's own doing.
    snapshotRadio() {
      const radio = this.page.radio();
      this.restoreTo = {hz: Number(radio.frequency) || 0,
                        percent: this.page.percentOf ? this.page.percentOf(radio) : 0,
                        mode: radio.mode || "", filter: Number(radio.filter) || 0};
    }

    blockingReason() {
      const page = this.page.planBlockingReason ? this.page.planBlockingReason() : "";
      if (page) return page;
      const cal = this.cal.blockingReason();
      if (cal) return cal;
      if (!TxGainPlan.cellsOf(this.plan).length)
        return "tick at least one cell first";
      for (const row of this.plan.rows)
        if (row.cells.some(Boolean) && TxGainCal.bandOf(row.hz) !== row.band)
          return `${row.band}: ${(row.hz / 1000).toFixed(1)} kHz is not in that band`;
      return "";
    }

    // One intent at a time, and never two at once: `acting` is what keeps a render
    // or a late event from starting a second carrier on the same transmitter.
    async pump() {
      if (!this.run || this.acting) return;
      const step = this.run.next();
      if (!step) return;
      this.acting = true;
      // Drawn BEFORE the step runs, not only after. A measurement takes fifteen
      // seconds and nothing was redrawn until it ended, so the panel kept showing the
      // antenna question -- CONTINUE still on screen and apparently ignored -- with no
      // sign that anything was happening.
      this.render();
      try { await this.execute(step); }
      catch (error) {
        // Classified, not assumed. Every exception from a step used to stop the WHOLE
        // plan, so one unconfirmed power write -- a readback that the firmware only
        // refreshes every 1.5 s, and not at all during a transmission -- ended the run
        // after a single measured cell. That is exactly the "one green value per RUN"
        // the operator saw. A step that fails for a reason about THIS cell now costs
        // this cell.
        const reason = String(error.message || error);
        this.run.note({type: isStationFailure(reason) ? "stationFailed" : "cellFailed",
                       reason});
      }
      this.acting = false;
      this.render();
      // The question is the one intent that waits for a human; everything else
      // continues immediately.
      if (this.run && !this.ask) setTimeout(() => this.pump(), 0);
    }

    async execute(step) {
      switch (step.type) {
        case "retune":
          this.busyCell = null;
          await this.page.setFrequency(step.hz);
          this.run.note({type: "tuned", hz: step.hz});
          return;
        case "askAntenna":
          // Answered in advance. The plan still asks -- the rule that a retune
          // costs a confirmation is untouched, and it is still one answer per
          // retune -- but the operator gave the answers when they ticked the box,
          // rather than being fetched back to the screen for each of them.
          if (this.autoAnswer) {
            this.run.note({type: "antennaOk", band: step.band});
            return;
          }
          this.ask = step;
          this.askAtMs = Date.now();
          this.armAskTimeout();
          // The window opens itself for a question, and pinned() then keeps it open.
          // A carrier is next; the operator must not have to go looking for the place
          // where it is asked.
          this.open();
          return;
        case "setPower":
          await this.awaitTransmitterFree();
          await this.page.setPercent(step.percent);
          this.run.note({type: "powerSet", percent: step.percent});
          return;
        case "measure":
          await this.awaitTransmitterFree();
          return this.measure(step);
        case "writeMod": {
          const pending = {from: Number(this.run.modFrom) || Number(step.from) || 0,
            target: Number(step.value) || 0,
            corrections: Number(this.run.modCorrections) + 1,
            model: String(this.page.model() || ""), at: Date.now(),
            owner: {band: step.band, hz: step.verifyHz, percent: step.verifyPercent,
              knee: Number(step.knee) || 0, reachedCeiling: Boolean(step.atCeiling)}};
          try { await this.persistTransition(pending); }
          catch (error) {
            this.run.note({type: "stationFailed", reason:
              "the MOD transition could not be stored before changing the radio: " +
              String(error.message || error)});
            return;
          }
          const written = await this.mod.writeLevel(step.value);
          if (written === null) {
            try { await this.persistTransition(null); } catch (_error) {}
            this.run.note({type: "modUnavailable", reason: this.mod.error});
            return;
          }
          if (Number(written) !== Number(pending.target)) {
            pending.target = Number(written);
            try { await this.persistTransition(pending); } catch (_error) {}
          }
          this.run.note({type: "modWritten", value: written});
          return;
        }
        case "restore":
          await this.restoreRadio();
          this.run.note({type: "restored"});
          return;
        case "done":
          let resumeClearError = "";
          if (this.run) {
            const snapshot = this.run.snapshot();
            // Keep the marker after STOP/failure (or an incomplete matrix), so
            // RUN can finish the exact transition. A clean matrix commits it.
            if (snapshot.state === "done" && !snapshot.failed) {
              try { await this.persistTransition(null); }
              catch (error) {
                resumeClearError = "calibration finished, but clearing its resume state failed: " +
                  String(error.message || error);
              }
            }
          }
          this.finish();
          if (resumeClearError) {
            this.message = (this.message ? this.message + " · " : "") + resumeClearError;
            this.render();
          }
          return;
        default:
          return;
      }
    }

    // The single-shot tool does the measuring. It reads the band and the power off
    // the radio itself, which the plan has just set, so the cell it files under is
    // the cell that was actually transmitted -- not the one this asked for.
    measure(step) {
      this.busyCell = {band: step.band, percent: step.percent};
      this.render();
      return new Promise(resolve => {
        let settled = false;
        const finish = note => {
          if (settled) return;
          settled = true;
          if (watchdog) clearTimeout(watchdog);
          if (note) this.run.note(note);
          this.busyCell = null;
          this.render();
          resolve();
        };
        // The plan must never depend on the measurement reporting back. It did, and a
        // run that failed to start left this promise pending for ever: `acting` stayed
        // true, so every CONTINUE afterwards was a no-op and the countdown kept running
        // on a plan that was already dead. Now the carrier's own cap plus a margin ends
        // the wait, whatever the tool did or did not say.
        const watchdog = setTimeout(() => {
          // Stop the CALIBRATION, not just this promise. Telling the sequencer that
          // the cell failed while leaving the tool marked as running left the page
          // routing every control frame to a measurement nobody was waiting for --
          // and the beacon's own driver, TUNE included, then never saw tx-ready
          // again. It came back as "TX prebuffer missed slot" on a button that had
          // nothing to do with calibration.
          try { this.cal.stop("the measurement never reported back"); } catch (_e) {}
          finish({type: "cellFailed",
                  reason: "the measurement never reported back (carrier cap passed)"});
        }, TxGainCalUiCaps().leadMs + TxGainCalUiCaps().hardMs + 8000);
        this.cal.start({
          seed: step.seed, resolutionDb: step.resolutionDb || 0,
          onOutcome: outcome => finish(
            outcome.ok
              ? {type: "measured", knee: outcome.knee, gain: outcome.gain,
                 po: outcome.po, swrMax: outcome.swrMax, reachedCeiling: outcome.reachedCeiling}
              // A ceiling is neither a measurement nor an ordinary failure: it is
              // the one observation the MOD-level correction is made of, and
              // folding it into cellFailed is what left that correction unable to
              // fire on the only stations that need it.
              : outcome.reachedCeiling
                ? {type: "ceiling", knee: outcome.knee, gain: outcome.gain,
                   po: outcome.po, swrMax: outcome.swrMax, reason: outcome.reason}
                : isStationFailure(outcome.reason)
                  ? {type: "stationFailed", reason: outcome.reason}
                  : {type: "cellFailed", reason: outcome.reason}),
        }).catch(error => finish({type: "cellFailed",
                                  reason: String(error.message || error)}));
      });
    }

    // The PTT flag comes off a once-a-second poll, so it still reads "keyed" for up to
    // a second after the carrier has actually stopped. Acting inside that window gets
    // the next step refused -- "TRX PTT is active" -- which reaches the operator as
    // CONTINUE having done nothing at all. It is harmless to wait for it: the flag is
    // stale, not wrong, and a second is nothing against a 15 s carrier.
    async awaitTransmitterFree(timeoutMs = 4000) {
      const isPtt = () => /ptt|transmitting|tx is busy/i.test(this.cal.blockingReason());
      if (!isPtt()) return true;
      this.busyNote = "waiting for the transmitter to release…";
      this.render();
      for (let waited = 0; waited < timeoutMs; waited += 250) {
        await new Promise(resolve => setTimeout(resolve, 250));
        if (!isPtt()) break;
      }
      this.busyNote = "";
      this.render();
      // Deliberately not an error when it never clears: the step that follows will
      // refuse with its own reason, which is more specific than anything said here.
      return !isPtt();
    }

    async restoreRadio() {
      const wanted = this.restoreTo;
      if (!wanted) return;
      this.restoreTo = null;
      // Best effort, in the order that matters least-surprising: band first, then
      // the level. A failed restore must not turn a finished matrix into an error.
      try { if (wanted.hz) await this.page.setFrequency(wanted.hz); } catch (_error) {}
      try { if (wanted.percent) await this.page.setPercent(wanted.percent); } catch (_error) {}
      // And the mode WITH its filter. The single-shot tool restores the mode after
      // every cell, so the mode usually comes back on its own -- but nothing was
      // putting the filter back, and USB-D on FIL1 is not where an operator who was
      // listening on FIL2 left the radio.
      try {
        if (wanted.mode && this.page.setModeFilter &&
            (wanted.mode !== this.page.radio().mode ||
             (wanted.filter && wanted.filter !== Number(this.page.radio().filter))))
          await this.page.setModeFilter(wanted.mode, wanted.filter);
      } catch (_error) {}
    }

    answer(action) {
      if (!this.ask || !this.run) return;
      const band = this.ask.band;
      // The box is about the questions still to come, so it arms whichever way
      // this one was answered: "skip 40 m, and stop asking me about the rest".
      if (this.askAll && (action === "ok" || action === "skip")) this.autoAnswer = true;
      this.askAll = false;
      this.ask = null;
      this.clearAskTimeout();
      // The question is gone the instant it is answered. Waiting for the next render
      // left its buttons on screen for the length of a carrier.
      this.render();
      if (action === "ok") this.run.note({type: "antennaOk", band});
      else if (action === "skip") this.run.note({type: "antennaSkip", band});
      else { this.stop("operator stop"); return; }
      this.pump();
    }

    // Never a countdown that continues: only one that gives up. Waiting is safe --
    // PTT is down and the radio is parked -- but it holds the single-operator lock,
    // so a tab nobody comes back to has to let go of the radio eventually.
    armAskTimeout() {
      this.clearAskTimeout();
      this.askTimer = setTimeout(() => {
        this.ask = null;
        this.stop("nobody confirmed the antenna within 30 minutes");
      }, this.ask.timeoutMs || TxGainPlan.ANTENNA_WAIT_MS);
    }

    clearAskTimeout() {
      if (this.askTimer) { clearTimeout(this.askTimer); this.askTimer = null; }
    }

    stop(reason) {
      if (!this.run) return;
      this.ask = null;
      this.clearAskTimeout();
      this.cal.stop(reason);
      this.run.stop(reason);
      this.render();
      this.pump();
    }

    finish() {
      const snapshot = this.run ? this.run.snapshot() : null;
      this.clearAskTimeout();
      this.busyCell = null;
      this.askAll = false;
      this.autoAnswer = false;
      this.run = null;
      this.page.onPlanChange(false);
      if (!snapshot) return;
      const parts = [`${snapshot.done} measured`];
      if (snapshot.skipped) parts.push(`${snapshot.skipped} skipped`);
      if (snapshot.failed) parts.push(`${snapshot.failed} failed`);
      if (snapshot.modLevel && snapshot.modLevel !== snapshot.modFrom)
        parts.push(`MOD level ${snapshot.modFrom} → ${snapshot.modLevel}`);
      this.summary = parts.join(", ");
      this.results = snapshot.results;
      this.message = snapshot.error || "";
      if (snapshot.modAdvice && snapshot.modAdvice.reason)
        this.message = (this.message ? this.message + " · " : "") +
          `${snapshot.modAdvice.reason} (${snapshot.modAdvice.band} knee ` +
          `${snapshot.modAdvice.knee.toFixed(3)}, ${snapshot.modAdvice.offDb} dB off)`;
      this.render();
    }

    // ---- drawing -----------------------------------------------------------

    renderBandMenu() {
      if (!this.dom || !this.page.bands) return;
      this.dom.addband.innerHTML = this.page.bands()
        .map(entry => `<option value="${entry.band}|${entry.hz}">${entry.band}</option>`)
        .join("");
    }

    cellClass(row, column) {
      const percent = this.plan.powers[column];
      if (!row.cells[column]) return "plan-cell";
      const key = TxGainCal.entryKey(this.page.model(), row.band, percent);
      const status = this.store.status(key, this.modLevel());
      const failed = (this.results || []).find(result =>
        result.band === row.band && result.percent === percent && result.status === "failed");
      const busy = this.busyCell && this.busyCell.band === row.band &&
                   this.busyCell.percent === percent;
      const classes = ["plan-cell", "on"];
      if (status === "calibrated") classes.push("ok");
      else if (status === "stale") classes.push("stale");
      else if (failed) classes.push("failed");
      if (busy) classes.push("busy");
      return classes.join(" ");
    }

    cellText(row, column) {
      const percent = this.plan.powers[column];
      if (!row.cells[column]) return "·";
      const entry = this.store.entry(TxGainCal.entryKey(this.page.model(), row.band, percent));
      if (!entry) return "measure";
      const status = this.store.status(
        TxGainCal.entryKey(this.page.model(), row.band, percent), this.modLevel());
      return status === "stale" ? `stale ${Number(entry.gain).toFixed(3)}`
                               : Number(entry.gain).toFixed(3);
    }

    modLevel() {
      return this.run ? this.run.modLevel : this.mod.value;
    }

    render() {
      if (!this.dom) return;
      // Columns as chips with their own remove button, so both halves of editing a
      // power are visible: the list used to be a comma-separated text field, which
      // hid the fact that a power could be added at all.
      this.dom.powerchips.innerHTML = this.plan.powers.length
        ? this.plan.powers.map(percent =>
            `<span class="plan-chip">${percent} %<button type="button"` +
            ` data-remove-power="${percent}" title="Remove the ${percent} % column"` +
            `>×</button></span>`).join("")
        : `<span class="plan-note">none yet</span>`;
      this.dom.grid.innerHTML =
        `<div class="plan-head"><b></b><span>kHz</span>${this.plan.powers
          .map(percent => `<span>${percent} %</span>`).join("")}</div>` +
        this.plan.rows.map((row, index) => {
          const warning = this.hzWarning(row);
          return `<div class="plan-row"><b>${row.band}</b>` +
            `<input class="plan-hz" data-hz="${index}" type="text" inputmode="decimal"` +
            ` value="${(row.hz / 1000).toFixed(1)}" aria-label="${row.band} kHz">` +
            row.cells.map((_on, column) =>
              `<button type="button" class="${this.cellClass(row, column)}"` +
              ` data-cell data-row="${index}" data-column="${column}">` +
              `${this.cellText(row, column)}</button>`).join("") +
            `<button type="button" data-remove-row="${index}" title="Remove ${row.band}">×</button>` +
            (warning ? `<span class="plan-hzwarn">${warning}</span>` : "") +
            `</div>`;
        }).join("");

      const cost = TxGainPlan.estimate(this.plan);
      this.dom.estimate.textContent = cost.cells
        ? `${cost.cells} cells on ${cost.bands} bands · ${cost.carriers} carriers, ` +
          `${Math.round(cost.airMs / 60000)} min of transmission, about ` +
          `${Math.round(cost.totalMs / 60000)} min in total · ` +
          `${cost.prompts} antenna questions`
        : this.plan.rows.length
          ? "nothing ticked — click a cell to include that band at that power"
          : this.plan.powers.length
            ? "add a band above; each band becomes a row"
            : "add a power column and a band row above";

      // RUN is NEVER disabled for a blocking reason -- only while a run is already
      // going. A disabled button with no sentence beside it is indistinguishable from
      // a broken one, and that is exactly how it was reported: "RUN does nothing, no
      // response at all". Pressing it while blocked now prints the reason.
      this.dom.radio.innerHTML = this.radioLine();

      const locked = this.running || this.starting;
      const problem = locked ? "" : this.blockingReason();
      // While a run is going, the only controls that mean anything are STOP and, when
      // it is asking, CONTINUE and SKIP. Everything else -- starting again, adding a
      // band, adding a power, editing the grid -- can only produce a failure, so it is
      // disabled rather than left to be discovered by pressing it.
      this.dom.run.disabled = locked;
      this.dom.runall.disabled = locked;
      this.dom.add.disabled = locked;
      this.dom.addpower.disabled = locked;
      this.dom.addband.disabled = locked;
      this.dom.newpower.disabled = locked;
      this.dom.stop.hidden = !this.running;
      this.dom.grid.classList.toggle("locked", locked);
      this.dom.blocked.hidden = !problem;
      this.dom.blocked.textContent = problem ? `RUN will refuse: ${problem}` : "";

      this.dom.ask.hidden = !this.ask;
      // Emptied, not merely hidden. A CONTINUE button that still exists is a CONTINUE
      // button that can be clicked and can be read as an invitation -- and it stayed on
      // screen for the whole length of a carrier.
      if (!this.ask) this.dom.ask.innerHTML = "";
      if (this.ask) {
        const waited = Math.round((Date.now() - this.askAtMs) / 1000);
        const decoder = this.decoderNote(this.ask.hz);
        this.dom.ask.innerHTML =
          `<b>${this.ask.band} — ${(this.ask.hz / 1000).toFixed(1)} kHz, ` +
          `${this.ask.percent} %</b>` +
          `<p>Is the right antenna connected for ${this.ask.band}?</p>` +
          `<p class="plan-note">A carrier of up to 20 s follows. The plan stops if SWR ` +
          `reaches ${3.0}.${decoder ? " " + decoder : ""}</p>` +
          `<div class="plan-tools"><button type="button" data-answer="ok">CONTINUE</button>` +
          `<button type="button" data-answer="skip">SKIP ${this.ask.band}</button></div>` +
          // The whole remaining run, answered here. Said as what it costs, not as
          // a convenience: after this the plan retunes and keys on bands nobody is
          // asked about, so it is worth ticking only when every antenna in the
          // plan is already right -- one switch, one wideband antenna, an ATU that
          // follows the dial. SWR still stops the run; that guard is not the
          // operator's to switch off.
          `<label><input type="checkbox" data-answer-all` +
          `${this.askAll ? " checked" : ""}> don't ask again at the next retune —` +
          ` measure the rest without stopping (SWR still stops it)</label>` +
          // No second STOP here. There is one STOP, in the toolbar, where it does not
          // move about -- two buttons with one meaning is a question about which is
          // which, asked at the moment the operator is being asked something else.
          `<p class="plan-note">Waiting ${formatWait(waited)} — nothing is transmitted ` +
          `until you answer, and the plan gives up after 30 minutes.</p>`;
      }

      const snapshot = this.run ? this.run.snapshot() : null;
      this.dom.live.hidden = !snapshot && !this.busyNote;
      if (snapshot) this.dom.live.textContent = this.liveLine(snapshot);
      else if (this.busyNote) this.dom.live.textContent = this.busyNote;

      this.dom.done.hidden = !this.summary;
      this.dom.done.textContent = this.summary;
      this.dom.error.hidden = !this.message;
      this.dom.error.textContent = this.message;
      this.renderTodo(snapshot, problem);
      this.renderButton();
    }

    // Whose turn it is. Three states and no ambiguity: the operator presses RUN, the
    // operator answers the antenna question, or the plan is busy and there is nothing
    // to do. The button that is being asked for gets highlighted too, because a
    // sentence and a glowing button say it twice.
    renderTodo(snapshot, problem) {
      const todo = this.dom.todo;
      this.dom.run.classList.remove("wanted");
      if (this.ask) {
        todo.className = "plan-todo";
        todo.textContent = `Your turn: confirm the antenna for ${this.ask.band} below — ` +
          "nothing is transmitted until you answer.";
        return;
      }
      if (this.starting) {
        todo.className = "plan-todo working";
        todo.textContent = `Nothing to do — ${this.busyNote || "preparing the calibration run…"}`;
        return;
      }
      if (snapshot) {
        todo.className = "plan-todo working";
        todo.textContent = this.autoAnswer
          ? "Nothing to do — the plan is running. You asked it not to stop at the " +
            "next retunes, so it changes band and keys without asking again."
          : "Nothing to do — the plan is running. It will ask again " +
            "before it changes band.";
        return;
      }
      if (problem) {
        todo.className = "plan-todo";
        todo.textContent = `Your turn: ${problem}.`;
        return;
      }
      const cost = TxGainPlan.estimate(this.plan);
      todo.className = "plan-todo";
      todo.textContent = `Your turn: press RUN. ${cost.carriers} carriers, about ` +
        `${Math.round(cost.totalMs / 60000)} min, ${cost.prompts} antenna questions.`;
      this.dom.run.classList.add("wanted");
    }

    // What the radio is set to and what a transmission would use, in one line each.
    //
    // The MOD level answers "is one value enough for every band" with a plain yes: it
    // is a property of the input, not of the band, which is exactly why it is the
    // outer loop and why moving it invalidates every stored knee.
    //
    // The audio gain answers "is this static". It is not: it is looked up per
    // transmission from the table by band AND power, and the runtime limiter can take
    // it down mid-carrier. It only looked static because nothing ever showed it.
    radioLine() {
      const parts = [];
      const capability = this.mod.capability;
      if (!capability.readable) {
        parts.push(`<b>MOD level:</b> ${escapeHtml(capability.reason)}` +
          (capability.menu ? ` — set it by hand in ${escapeHtml(capability.menu)}` : ""));
      } else if (this.modReading) {
        parts.push("<b>MOD level:</b> reading…");
      } else if (this.mod.value) {
        const percent = Math.round(this.mod.value * 100 / 255);
        const menu = capability.menu ? ` (${escapeHtml(capability.menu)})` : "";
        parts.push(`<b>${escapeHtml(capability.model.net)} MOD level:</b> ` +
          `${this.mod.value} of 255 = ${percent} %${menu} — one value for every band`);
        const mismatch = this.tableModLevels().filter(level => level !== this.mod.value);
        if (mismatch.length)
          parts.push(`<b>TRX MOD different from measured:</b> ` +
            `${mismatch.length} stored row(s) use MOD ${mismatch.join(", ")}; ` +
            `the TRX reports ${this.mod.value} — those rows are stale and RUN will ` +
            `continue by verifying and measuring them at the current TRX MOD`);
      } else {
        parts.push("<b>MOD level:</b> not read yet");
      }
      // And the level a transmission would use this second.
      const resolved = this.cal.resolved();
      parts.push(`<b>TX audio gain now:</b> ${Number(resolved.gain).toFixed(4)} — ` +
        (resolved.calibrated
          ? `measured for ${escapeHtml(resolved.band)} @ ${resolved.percent} %` +
            (resolved.modUnknown ? " (MOD level of that measurement unknown)" : "")
          : `the manual value: ${escapeHtml(resolved.why || "nothing measured for this band")}`) +
        ". Looked up again for every transmission, per band and power.");
      return parts.map(line => `<span class="plan-radio-line">${line}</span>`).join("");
    }

    // Distinct MOD levels the stored rows were measured at.
    tableModLevels() {
      const entries = (this.store.doc && this.store.doc.entries) || {};
      const levels = new Set();
      for (const key of Object.keys(entries)) {
        const level = Number(entries[key].modLevel) || 0;
        if (level) levels.add(level);
      }
      return [...levels].sort((left, right) => left - right);
    }

    // Which band-decoder outputs this frequency asserts. On a station where those
    // outputs drive an antenna switch, "output 4 will assert" is half the answer to
    // the question being asked -- and the config that says so is a plain GET, so the
    // only reason not to name it was that the first version did not bother.
    //
    // Fetched once, lazily, and never blocking: no note is better than a late one.
    loadDecoder() {
      if (this.decoderRows || this.decoderPending) return;
      if (!this.page.radio().bdSupported) return;
      this.decoderPending = true;
      const get = this.page.fetchImpl || ((...args) => fetch(...args));
      get("/api/bd-config", {cache: "no-store"})
        .then(response => (response.ok ? response.json() : null))
        .then(doc => { this.decoderRows = doc && Array.isArray(doc.rows) ? doc.rows : []; })
        .catch(() => { this.decoderRows = []; });
    }

    decoderNote(hz) {
      if (!this.page.radio().bdSupported) return "";
      this.loadDecoder();
      const khz = Math.round(Number(hz) / 1000);
      const outputs = [];
      for (const row of this.decoderRows || []) {
        if (!row || !(khz >= Number(row.fMin)) || !(khz <= Number(row.fMax))) continue;
        const mask = Number(row.outputs) || 0;
        for (let bit = 0; bit < 16; bit++) if (mask & (1 << bit)) outputs.push(bit + 1);
      }
      const unique = [...new Set(outputs)].sort((left, right) => left - right);
      if (unique.length)
        return `The band decoder asserts output ${unique.join(", ")} here.`;
      if (this.decoderRows && !this.decoderRows.length) return "";
      return "This interface drives band-decoder outputs, which follow the dial.";
    }

    // What is happening, right now, in one line. "Is anything happening and which step
    // are we on" was the operator's complaint, and the answer existed -- in the OTHER
    // panel's live row, which nobody looking at this window can see.
    liveLine(snapshot) {
      const phase = {survey: "survey", mod: "MOD level", matrix: "measuring",
                     idle: "idle", done: "done", failed: "stopped",
                     stopped: "stopped"}[snapshot.state] || snapshot.state;
      const progress = snapshot.progress;
      const parts = [progress
        ? `${progress.label} ${progress.at}/${progress.of}` +
          (snapshot.total ? ` · ${snapshot.done}/${snapshot.total} stored` : "")
        : `${phase} · cell ${snapshot.done + 1}/${snapshot.total}`];
      if (this.busyCell) {
        parts.push(`${this.busyCell.band} @ ${this.busyCell.percent} %`);
        // The search's own state, borrowed from the tool doing it: which phase, what
        // level it is trying, what the ALC said and how long the carrier has left.
        const cal = this.cal.cal;
        if (cal) parts.push(`${cal.phase || cal.state} · level ${cal.gain.toFixed(4)}` +
                            ` · ALC ${cal.alcMax} · step ${cal.steps}`);
        else parts.push("carrier starting");
        // The calibration tool's own clock, not this panel's: `endsAtMs` was computed
        // with it, and subtracting a different clock from it is how a countdown starts
        // lying. (This panel's adapter has no clock at all -- reading one here threw
        // inside render() and took the whole tick with it.)
        const now = this.cal.page && this.cal.page.wallNow
          ? this.cal.page.wallNow() : Date.now();
        const left = this.cal.endsAtMs
          ? Math.max(0, Math.round((this.cal.endsAtMs - now) / 1000)) : 0;
        if (left) parts.push(`${left} s left`);
      } else if (this.ask) {
        parts.push("waiting for the antenna answer");
      } else if (this.acting) {
        // Between cells: retuning, writing the power or the MOD level. Short, but it is
        // the window in which the panel used to look frozen.
        const step = snapshot.step || {};
        parts.push({retune: "tuning the radio", setPower: "setting the power",
                    writeMod: "writing the MOD level", restore: "putting the radio back"
                   }[step.type] || "working");
      }
      if (snapshot.failed) parts.push(`${snapshot.failed} failed`);
      if (snapshot.retries) parts.push(`${snapshot.retries} retried`);
      if (snapshot.modLevel) parts.push(`MOD ${snapshot.modLevel}`);
      return parts.join(" · ");
    }

    hzWarning(row) {
      if (!row.cells.some(Boolean)) return "";
      if (TxGainCal.bandOf(row.hz) !== row.band) return "not in this band";
      const busy = busyWindow(row.hz);
      return busy ? `in ${busy} — a 20 s carrier there costs someone a decode` : "";
    }

    // A tick while the question is up, so the waited time is honest.
    // Called by the host page twice a second. The BUTTON is redrawn every time --
    // it is three class toggles and a string, and it is what tells the operator that
    // the radio has moved to a band nothing is calibrated for. It used to be redrawn
    // only inside a full render(), so the warning appeared when the panel was opened
    // rather than when it became true, which is the wrong way round for a warning.
    //
    // The full render stays rare on purpose: it rewrites the grid, and doing that
    // twice a second would fight with the frequency field under the operator's
    // fingers.
    tick() {
      this.renderButton();
      if (this.ask || this.run) this.render();
    }
  }

  // Which failures are about the station rather than the cell. The list is short on
  // purpose: everything else is the cell's own bad luck and the plan carries on.
  function isStationFailure(reason) {
    const text = String(reason || "").toLowerCase();
    // Everything here is a fact about the STATION: the transmitter is gone, the lock
    // is gone, the antenna is wrong, or the operator said stop. Anything else -- a
    // readback that did not arrive, a search that hit the ceiling, an underrun -- is a
    // fact about one cell, and the plan owes the other cells an attempt.
    //
    // "holds the radio" is in the list because the session lock is phrased that way on
    // the JS8 page and nothing else in it matched: the plan would have carried on
    // keying cells with the lease already lost.
    return /swr|does not report alc|never answered the alc|firmware|session|lock|holds the radio|link|offline|not reachable|operator stop/
      .test(text);
  }

  const escapeHtml = value => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const formatWait = seconds => `${Math.floor(seconds / 60)}:${
    String(seconds % 60).padStart(2, "0")}`;

  // A missing dependency must not be a dead panel. Every one of these is a separate
  // script tag, so a stale filesystem image -- assets uploaded before gzip-assets.sh
  // regenerated them, say -- can leave one of them absent, and the constructor would
  // then throw somewhere in the middle: markup on the page, no handlers attached, and
  // a frame that looks broken with nothing to read. Say which one is missing instead.
  function create(adapter) {
    const missing = [
      ["tx-gain-plan.js", TxGainPlan], ["tx-gain-cal.js", TxGainCal],
      ["tx-gain-mod-level.js", TxGainModLevel], ["icom-models.js", IcomModels],
    ].filter(([, module]) => !module).map(([name]) => name);
    if (missing.length) {
      if (adapter && adapter.mount) {
        installCss(adapter.mount.ownerDocument);
        adapter.mount.classList.add("plan-field");
        adapter.mount.innerHTML = '<b>Calibration plan</b>' +
          '<p class="plan-error">unavailable: ' + missing.join(", ") +
          ' did not load. The web assets in this device are incomplete — re-upload the' +
          ' filesystem image.</p>';
      }
      return null;
    }
    return new TxGainPlanPanel(adapter);
  }

  return {create, TxGainPlanPanel, isStationFailure, busyWindow, registerBusyWindows};
});
