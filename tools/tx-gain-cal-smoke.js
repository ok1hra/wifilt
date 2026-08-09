#!/usr/bin/env node
"use strict";

// The ALC gain search and the runtime limiter, driven against a simulated radio.
// See docs/tx-auto-gain-implementace.md.
//
// The simulation is the point. Everything expensive about this feature happens
// on the air -- a 20 s carrier, a real transceiver, an antenna -- so the cases
// worth testing are exactly the ones nobody wants to reproduce there: a knee
// below the starting level, a radio that never limits, a radio that limits at
// the floor, a meter that answers stale values, and a level that stops being
// clean during the final hold.
//
// The radio model carries the two properties that make this problem awkward:
//
//   * audio reaches it LATE. What the browser writes now is played once the ring
//     drains, so a reading taken too early describes the previous level. The
//     model therefore answers from the level that was live at `consumed`, not
//     from the level the search currently wants.
//   * the meter DECAYS. After the drive drops below the knee the ALC needle
//     falls back over its own time, so the first zero after a reduction is not
//     yet proof. The model holds one stale non-zero reading, which is what makes
//     the two-clean-samples rule testable rather than decorative.

const {TxGainCal, TxGainStore, fromDb, toDb,
       entryStatus, seedFrom, migrate, SCHEMA_VERSION} = require("../data/tx-gain-cal.js");
const {TxAlcGuard} = require("../data/tx-alc-guard.js");
const IcomModels = require("../data/icom-models.js");

let checks = 0, failures = 0;
function check(name, actual, expected) {
  checks++;
  const ok = Object.is(actual, expected) ||
             (typeof actual === "number" && typeof expected === "number" &&
              Math.abs(actual - expected) < 1e-9);
  if (!ok) { failures++; console.error(`FAIL ${name}\n  expected ${expected}\n  actual   ${actual}`); }
}
function checkNear(name, actual, expected, toleranceDb) {
  checks++;
  const errorDb = Math.abs(toDb(actual / expected));
  if (!(errorDb <= toleranceDb)) {
    failures++;
    console.error(`FAIL ${name}\n  ${actual} is ${errorDb.toFixed(2)} dB from ${expected}` +
                  ` (tolerance ${toleranceDb} dB)`);
  }
}
function checkTrue(name, value) { check(name, Boolean(value), true); }

const FRAME_BYTES = 1600;        // 200 ms of mu-law at 8 kHz, one tx-level frame
const RAMP_BYTES = 960;          // matches the module default

// A transceiver whose ALC starts acting above `knee`.
function makeRadio({knee, alcEveryFrames = 2, answersAlc = true, decaySamples = 1}) {
  return {
    // Mutable, so a test can move the knee mid-run: a battery sagging under a
    // 20 s carrier does exactly that.
    knee,
    consumed: 0,
    seq: 0,
    frames: 0,
    schedule: [{fromBytes: 0, gain: 0}],
    decayLeft: 0,
    // The browser wrote a new level; it becomes audible once the ramp is played.
    setGain(gain, atBytes) { this.schedule.push({fromBytes: atBytes, gain}); },
    liveGain() {
      let gain = 0;
      for (const entry of this.schedule) if (entry.fromBytes <= this.consumed) gain = entry.gain;
      return gain;
    },
    // One tx-level frame from the firmware.
    frame() {
      this.consumed += FRAME_BYTES;
      this.frames += 1;
      let alc = 0;
      if (answersAlc && this.frames % alcEveryFrames === 0) {
        this.seq += 1;
        if (this.liveGain() > this.knee) { alc = 40; this.decayLeft = decaySamples; }
        else if (this.decayLeft > 0) { alc = 20; this.decayLeft -= 1; }
      }
      return {consumed: this.consumed, alc, alcSeq: this.seq};
    },
  };
}

// Run a whole calibration. `sent` tracks the browser staying about a ring ahead
// of the radio, which is what makes the byte accounting non-trivial in the first
// place: the level the search picks now is not the level being measured now.
function runCalibration(radio, options = {}, {maxFrames = 400, seed = 0} = {}) {
  const cal = new TxGainCal(options);
  cal.begin({knownKnee: seed});
  let sent = 4000;                                   // half a second queued ahead
  radio.setGain(cal.gain, 0);
  cal.noteSent(sent);
  for (let i = 0; i < maxFrames; i++) {
    if (cal.state === "done" || cal.state === "failed") break;
    sent += FRAME_BYTES;
    cal.noteSent(sent);
    const before = cal.gain;
    cal.noteLevel(radio.frame());
    if (cal.gain !== before) radio.setGain(cal.gain, sent + RAMP_BYTES);
  }
  return cal;
}

// ---- the search ------------------------------------------------------------

{
  // Cold start, knee in the middle of the range. The stored value must be a
  // level the radio actually accepted, not an interpolation between two.
  const knee = 0.31;
  const cal = runCalibration(makeRadio({knee}));
  check("cold start finishes", cal.state, "done");
  checkNear("cold start lands on the knee", cal.result.gain, knee, 0.4);
  checkTrue("the stored knee was measured clean", cal.result.knee <= knee);
  check("the ceiling was not reached", cal.result.reachedCeiling, false);
}

{
  // A stored entry only shortens the search. It is entered 6 dB low on purpose,
  // so a stale seed cannot put an overdriven carrier out even for one step.
  const knee = 0.31;
  const cold = runCalibration(makeRadio({knee}));
  const warm = runCalibration(makeRadio({knee}), {}, {seed: knee});
  check("warm start finishes", warm.state, "done");
  checkNear("warm start lands on the same knee", warm.result.gain, knee, 0.4);
  checkTrue("warm start takes fewer steps", warm.result.steps < cold.result.steps);
}

{
  // Knee below the starting level: walking down is the only honest answer.
  // Failing here would leave the operator with no calibration on exactly the
  // setup that needs one most -- a hot MOD level at 1 % RF power.
  const knee = 0.02;
  const cal = runCalibration(makeRadio({knee}));
  check("a knee below the start still finishes", cal.state, "done");
  checkNear("and lands on it", cal.result.gain, knee, 0.4);
}

{
  // The radio never limits. Not a failure: the search has done its job and the
  // conclusion belongs to the operator's MOD level, not to more gain.
  const cal = runCalibration(makeRadio({knee: 5}));
  check("an unreachable knee still finishes", cal.state, "done");
  check("it reports hitting the ceiling", cal.result.reachedCeiling, true);
  check("and applies the ceiling", cal.result.gain, 0.8);
}

{
  // ALC active even at the floor. There is nothing left to reduce, so say so
  // rather than transmitting into a limiter and calling it calibrated.
  const cal = runCalibration(makeRadio({knee: 0.0005}));
  check("a knee below the floor fails", cal.state, "failed");
  check("with the reason the operator can act on", cal.error,
        "ALC is active even at the lowest usable level");
}

{
  // A transceiver that does not answer 15 13 at all. Detected by absence,
  // because the firmware has no NG parsing -- and detected in bytes, not
  // seconds, so a throttled background tab cannot fake it.
  const cal = runCalibration(makeRadio({knee: 0.3, answersAlc: false}));
  check("a radio that never reports ALC fails", cal.state, "failed");
  check("with the right reason", cal.error, "radio does not report ALC");
  check("and it is not blamed on the level", cal.result, null);
}

{
  // The trap that motivated alcSeq: the firmware repeats the last reading in
  // every tx-level frame, five times per new sample. If a repeat counted, one
  // deflection would be read as five and the search would walk straight past
  // the knee it had just found.
  const cal = new TxGainCal();
  cal.begin({});
  cal.noteSent(20000);
  const start = cal.gain;
  for (let i = 1; i <= 10; i++) cal.noteLevel({consumed: 8000 + i * 1600, alc: 40, alcSeq: 7});
  check("a repeated ALC reading moves the level once", cal.steps, 1);
  checkTrue("and only downwards", cal.gain < start);
}

{
  // The decaying meter. After a reduction the needle is still falling, so the
  // first reading at the new level is about the old one. Judging it would
  // condemn a level that was never tried.
  const cal = new TxGainCal({settleBytes: 800});
  cal.begin({});
  cal.noteSent(10000);
  cal.noteLevel({consumed: 10000, alc: 40, alcSeq: 1});    // dirty, steps down
  const afterStep = cal.gain;
  const steps = cal.steps;
  cal.noteLevel({consumed: 10200, alc: 40, alcSeq: 2});    // stale, still decaying
  check("a reading taken before the new level is live is ignored", cal.steps, steps);
  check("so the level does not move again", cal.gain, afterStep);
}

{
  // The final hold is what makes a zero-margin result safe. One backoff is
  // allowed; a second failure means the answer is not trustworthy and must not
  // be presented as one.
  const knee = 0.31;
  const radio = makeRadio({knee});
  const cal = runCalibration(radio);
  check("the hold ran to completion", cal.state, "done");
  checkTrue("the held level is the one stored", cal.result.gain === cal.gain);
}

{
  // A knee that moves while the hold is running -- a battery sagging under a
  // 20 s carrier is the realistic version. One dB down, verify again, succeed.
  const radio = makeRadio({knee: 0.31});
  const cal = new TxGainCal();
  cal.begin({});
  let sent = 4000;
  radio.setGain(cal.gain, 0);
  for (let i = 0; i < 400 && cal.state === "searching"; i++) {
    sent += FRAME_BYTES;
    cal.noteSent(sent);
    const before = cal.gain;
    cal.noteLevel(radio.frame());
    if (cal.gain !== before) radio.setGain(cal.gain, sent + RAMP_BYTES);
  }
  check("the search reached the hold", cal.state, "holding");
  const held = cal.gain;
  radio.knee = held * fromDb(-2);                    // the radio moved under us
  for (let i = 0; i < 400 && cal.state === "holding"; i++) {
    sent += FRAME_BYTES;
    cal.noteSent(sent);
    const before = cal.gain;
    cal.noteLevel(radio.frame());
    if (cal.gain !== before) radio.setGain(cal.gain, sent + RAMP_BYTES);
  }
  check("a knee that moves during the hold fails honestly", cal.state, "failed");
  check("with a reason that names the hold", cal.error,
        "level did not stay clean during the final hold");
}

{
  // The measured advice that replaces the recommended-value guesswork.
  const cal = runCalibration(makeRadio({knee: 0.07}));
  check("a low knee finishes", cal.state, "done");
  checkTrue("and reports the MOD level as too hot",
            cal.result.modLevelCorrectionDb < -15);
}

// ---- the runtime limiter ---------------------------------------------------

{
  // One transmission that trips is not evidence. It reduces on the air -- that
  // is free -- but the station's table is not rewritten on a single reading.
  const guard = new TxAlcGuard();
  guard.beginTx({key: "IC-705|20m|40", gain: 0.5});
  guard.noteLevel({consumed: 5000, alc: 30, alcSeq: 1});
  const first = guard.endTx();
  checkTrue("a trip reduces the level in flight", first.gain < 0.5);
  check("one witness does not persist", first.persistGain, null);
  check("and it is counted", first.witnesses, 1);

  guard.beginTx({key: "IC-705|20m|40", gain: 0.5});
  guard.noteLevel({consumed: 5000, alc: 30, alcSeq: 1});
  const second = guard.endTx();
  checkNear("two witnesses persist one dB down", second.persistGain, 0.5 * fromDb(-1), 0.01);
  check("and the count is cleared", second.witnesses, 2);

  guard.beginTx({key: "IC-705|20m|40", gain: 0.5});
  const third = guard.endTx();
  check("a third, clean transmission persists nothing", third.persistGain, null);
}

{
  // A clean transmission clears the standing accusation. Without this, two trips
  // months apart with fifty good transmissions between them would corroborate
  // each other and quietly walk the stored level down.
  const guard = new TxAlcGuard();
  guard.beginTx({key: "k", gain: 0.5});
  guard.noteLevel({consumed: 5000, alc: 30, alcSeq: 1});
  guard.endTx();
  guard.beginTx({key: "k", gain: 0.5});
  guard.endTx();                                     // clean
  guard.beginTx({key: "k", gain: 0.5});
  guard.noteLevel({consumed: 5000, alc: 30, alcSeq: 1});
  const after = guard.endTx();
  check("a clean transmission resets the witness count", after.witnesses, 1);
  check("so nothing is persisted", after.persistGain, null);
}

{
  // Six dB down and still limiting: the entry no longer describes this radio.
  // Holding the floor and asking for a recalibration beats sliding away quietly.
  const guard = new TxAlcGuard();
  guard.beginTx({key: "k", gain: 0.5});
  let consumed = 0;
  for (let i = 1; i <= 12; i++) {
    consumed += 8000;                                // 1 Hz, the normal TX rate
    guard.noteLevel({consumed, alc: 30, alcSeq: i});
  }
  const end = guard.endTx();
  checkNear("the limiter stops six dB down", end.gain, 0.5 * fromDb(-6), 0.01);
  check("and says the calibration no longer holds", end.needsRecalibration, true);
}

{
  // The decaying meter again, on the limiter side, where it is worse: every
  // change here is downwards, so a needle still falling from the previous level
  // would be read as a fresh deflection and take another dB off. Three readings
  // 200 ms apart are one event, not three.
  const guard = new TxAlcGuard();
  guard.beginTx({key: "k", gain: 0.5});
  guard.noteLevel({consumed: 8000, alc: 30, alcSeq: 1});
  const afterFirst = guard.gain;
  guard.noteLevel({consumed: 9600, alc: 30, alcSeq: 2});
  guard.noteLevel({consumed: 11200, alc: 20, alcSeq: 3});
  check("readings taken while the needle falls do not stack", guard.gain, afterFirst);
  checkNear("so one deflection costs exactly one dB", guard.gain, 0.5 * fromDb(-1), 0.01);
}

{
  // Same repeat trap as the search, same reason.
  const guard = new TxAlcGuard();
  guard.beginTx({key: "k", gain: 0.5});
  for (let i = 0; i < 8; i++) guard.noteLevel({consumed: 5000 + i * 1600, alc: 30, alcSeq: 3});
  const end = guard.endTx();
  checkNear("a repeated reading reduces once", end.gain, 0.5 * fromDb(-1), 0.01);
}

// ---- schema v2: a knee is a knee AT A MOD LEVEL ----------------------------
//
// Writing the radio's MOD level moves every stored knee, so the schema has to
// record the level each measurement was taken at. Without it the table would keep
// serving pre-write values as valid -- and with zero margin under the knee, a
// value eight times too high is distortion, not a weaker signal.

{
  check("entries measured at the current MOD level are calibrated",
    entryStatus({gain: 0.3, knee: 0.3, modLevel: 84}, 84), "calibrated");
  check("entries from another MOD level are stale",
    entryStatus({gain: 0.3, knee: 0.3, modLevel: 168}, 84), "stale");
  check("a v1 entry is neither stale nor evidence",
    entryStatus({gain: 0.3, knee: 0.3}, 84), "unknown-mod");
  check("with no MOD level reading at all, an entry is still usable",
    entryStatus({gain: 0.3, knee: 0.3, modLevel: 168}, 0), "calibrated");
  check("an entry with no gain is missing, whatever else it has",
    entryStatus({knee: 0.3, modLevel: 84}, 84), "missing");

  // The seed is the one place the inverse proportionality is allowed, because the
  // search re-measures immediately and enters 6 dB below whatever it is handed.
  checkNear("a stale knee is rescaled by the MOD ratio",
    seedFrom({knee: 0.9, modLevel: 168}, 84), 1.8, 1e-9);
  check("a fresh knee is its own seed", seedFrom({knee: 0.31, modLevel: 84}, 84), 0.31);
  check("nothing known means no seed", seedFrom(null, 84), 0);
}

{
  const doc = migrate({v: 1, entries: {"IC-705|20m|1": {gain: 0.03, knee: 0.03}}});
  check("migration keeps v1 entries", Object.keys(doc.entries).length, 1);
  check("and does not invent a MOD level for them",
    doc.entries["IC-705|20m|1"].modLevel, undefined);
  check("the document is v2 afterwards", doc.v, SCHEMA_VERSION);
  check("and it always has a plan to edit", Array.isArray(doc.plan.rows), true);
  check("a garbage document migrates to an empty one",
    Object.keys(migrate("nonsense").entries).length, 0);
}

{
  // usableEntry() is what the transmit path asks. entry() still answers, because
  // the panel has to be able to SHOW a stale row -- it just must not key one.
  const store = new TxGainStore({fetchImpl: async () => ({ok: false, status: 404})});
  store.doc = {v: 2, plan: {powers: [], rows: []}, entries: {
    fresh: {gain: 0.3, knee: 0.3, modLevel: 84},
    old: {gain: 0.9, knee: 0.9, modLevel: 168},
  }};
  check("a fresh row is usable", Boolean(store.usableEntry("fresh", 84)), true);
  check("a stale row is not", store.usableEntry("old", 84), null);
  check("but it is still readable for display", Boolean(store.entry("old")), true);
  check("and the status says which", store.status("old", 84), "stale");
}

// ---- the MOD level subaddress table ---------------------------------------

{
  const ic705 = IcomModels.findModel(705);
  check("the IC-705 MOD level command is the one in its own CI-V manual",
    ic705.modLevelCmd, "1A050117");
  check("and the DATA MOD input command with it", ic705.modInputCmd, "1A050119");
  check("WLAN is value 3 on that radio", ic705.modInputNet, 3);

  // No number where no manual was read. This is the whole discipline: across
  // models the subaddresses have no pattern, so a guess cannot be checked.
  for (const number of [7300, 7610, 9700, 7760]) {
    const model = IcomModels.findModel(number);
    check(`IC-${number} has no guessed MOD level command`, model.modLevelCmd, undefined);
    check(`IC-${number} still tells the operator where the menu is`,
      /MOD Input/.test(model.modMenu || ""), true);
  }

  // The deny list is the backstop for the one irreversible mistake.
  check("a CI-V setting is never writable", IcomModels.writableSubaddress("1A050131"), false);
  check("nor the CI-V echo", IcomModels.writableSubaddress("1A050132"), false);
  check("nor the NTP server string", IcomModels.writableSubaddress("1A050168"), false);
  check("nor an SSID", IcomModels.writableSubaddress("1A050320"), false);
  check("the MOD level itself is writable", IcomModels.writableSubaddress("1A050117"), true);
  check("a command that is not 1A 05 is refused outright",
    IcomModels.writableSubaddress("140A0080"), false);
  check("and so is a malformed one", IcomModels.writableSubaddress("1A05"), false);
  // Every command the table actually carries must pass its own deny list.
  for (const model of IcomModels.models()) {
    if (!model.modLevelCmd) continue;
    check(`${model.label}'s command passes the deny list`,
      IcomModels.writableSubaddress(model.modLevelCmd), true);
  }
}

// ---- the carrier cap extends while the search advances -----------------------
//
// A cap that ends a search which is still converging is arbitrary, and it ended the
// low-power cells: their knee is ten times lower, so they spend more steps walking
// down, and every downward step must wait out the meter's own fall time. The soft cap
// is now granted again on every step forward; the hard cap bounds the airtime.
//
// Driven through the module's own function, so this is not a second copy of the rule.

{
  const Ui = require("../data/tx-gain-cal-ui.js");
  check("the soft cap is shorter than the hard one", Ui.CAL_MAX_MS < Ui.CAL_HARD_MS, true);

  // A search that steps every 3 s: how far does it get?
  const endsAt = Ui.CAL_LEAD_MS + Ui.CAL_MAX_MS;      // the first soft deadline
  let deadline = endsAt, now = Ui.CAL_LEAD_MS, steps = 0;
  while (steps < 60) {
    now += 3000;
    if (now > deadline) break;
    steps += 1;
    deadline = Ui.extendedDeadline(now, endsAt);
  }
  checkTrue("a search that keeps stepping runs well past the old 20 s cap", now > 30000);
  checkTrue("but is bounded", now <= Ui.CAL_LEAD_MS + Ui.CAL_HARD_MS + 3000);

  // One that stops stepping is ended within one extension of its last step.
  const lastStep = 8000;
  const after = Ui.extendedDeadline(lastStep, endsAt);
  check("a stalled search gets exactly one extension more",
        after, lastStep + Ui.CAL_EXTEND_MS);
  checkTrue("and a stall is never rewarded with the hard limit",
            after < Ui.CAL_LEAD_MS + Ui.CAL_HARD_MS);
}

// ---- the running flag cannot latch ------------------------------------------
//
// Both pages route every control frame with `if (cal.running) { cal.onControl(m);
// return; }`, so a stale true swallows the beacon's, TUNE's and JS8's transmissions
// alike. That is not a hypothetical: a watchdog once reported a cell as failed
// without stopping the tool, and TUNE stayed dead until the page was reloaded --
// "after jumping to WSPR and back, tune runs again" was the operator's own clue.

{
  const Ui = require("../data/tx-gain-cal-ui.js");
  // A bare object standing in for the run: no search, no carrier.
  const fake = Object.create(Ui.TxGainCalRun.prototype);
  fake._running = true;
  fake.cal = null;
  fake.tx = {state: "idle"};
  check("a flag left set with no search and no carrier reads as not running",
        fake.running, false);
  fake.cal = {};
  check("a live search reads as running", fake.running, true);
  fake.cal = null;
  fake.tx = {state: "streaming"};
  check("so does a carrier still streaming", fake.running, true);
  fake._running = false;
  check("and nothing reads as running once it has been stopped", fake.running, false);
}

// ---- an abort answers for its own transmission, and only that one -----------
//
// The calibration is the reason this matters. A single beacon slot ends by itself;
// a calibration keys a carrier per cell and ends EVERY one of them with a tx.abort,
// which the firmware answers with a tx-error carrying the txId it aborted. Let that
// answer arrive late -- the LittleFS write of /txgain.json between cells is enough --
// and the previous cell's acknowledgement failed the next cell instead. On the air
// that reads as "client abort: calibration finished" on a cell that had just started,
// and a matrix that comes back three values short.

{
  const {WsprTx} = require("../data/wspr-tx.js");
  const aborts = [];
  const sink = {
    prepare: () => true, write: () => {}, end: () => {}, sendControl: () => {},
    abort: (txId, reason) => aborts.push({txId, reason}), bufferedAmount: 0,
  };
  const symbols = new Uint8Array(162).fill(1);
  const tx = new WsprTx({sink, streamId: 7, wallNow: () => 1000, onEvent: () => {}});

  tx.queue({symbols, slotUtcMs: 1000 + 3000, leadMs: 2500});
  const first = tx.txId;
  tx.fail("calibration finished");                 // the cell ends, as every cell does
  check("the abort names the transmission it ends", aborts.length, 1);
  check("and names it by id", aborts[0].txId, first);

  tx.queue({symbols, slotUtcMs: 1000 + 3000, leadMs: 2500});
  const second = tx.txId;
  tx.onControl({type: "tx-error", txId: first,
                reason: "client abort: calibration finished"});
  check("a late abort acknowledgement does not fail the next cell", tx.state, "waiting-slot");
  check("and the next cell keeps its own identity", tx.txId, second);
  tx.onControl({type: "tx-state", txId: first, ptt: true});
  check("nor does another transmission's PTT report key this one", tx.ptt, false);
  tx.onControl({type: "tx-error", txId: second, reason: "TX watchdog"});
  check("its own tx-error still fails it", tx.state, "failed");

  // And an idle driver -- the beacon's, while a calibration owns the transmitter --
  // must not answer at all. It used to fail, and fail() then sent an abort with
  // txId 0, which the firmware reads as "abort whatever is in flight".
  const idle = new WsprTx({sink, streamId: 7, wallNow: () => 1000, onEvent: () => {}});
  const before = aborts.length;
  idle.onControl({type: "tx-error", txId: 4242, reason: "client abort: calibration finished"});
  check("an idle driver ignores a fault about somebody else's transmission",
        idle.state, "idle");
  check("and sends no wildcard abort", aborts.length, before);
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
