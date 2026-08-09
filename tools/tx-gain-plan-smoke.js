#!/usr/bin/env node
"use strict";

// The calibration plan sequencer, driven the way the page drives it.
//
// Every safety rule of the batch run is in here, so every one of them is asserted
// without a radio and without a browser:
//
//   * nothing keys before the antenna question for that band is answered
//   * one question per retune, and band-major ordering so that is one per band
//     per pass rather than one per cell
//   * ascending power inside a band, so the hottest carrier is the last one before
//     a retune -- the only cooling a plan with no pauses has
//   * the survey ranks bands at each band's OWN highest power, and the band that
//     needs the most audio owns the MOD level
//   * a written MOD level invalidates every survey reading, and a stale entry may
//     seed a search but may never be transmitted from
//   * a station failure stops the plan; a cell failure does not
//
// The simulated radio below has a knee that depends on band, power AND MOD level,
// which is what makes "did the plan actually retune and set power" answerable: a
// sequencer that skipped either would be measured against the wrong knee.

const path = require("path");
const Plan = require(path.join(__dirname, "..", "data", "tx-gain-plan.js"));

let checks = 0, failures = 0;
function check(name, condition, detail = "") {
  checks++;
  if (condition) return true;
  failures++;
  console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  return false;
}
const near = (value, wanted, tolerance) => Math.abs(value - wanted) <= tolerance;

// ---- a radio whose knee is a real function ---------------------------------
//
// knee = K(band) * percent / modLevel. 40 m is the worst band here, so it is the
// one the MOD level must end up serving.
const K = {"160m": 3.4, "40m": 4.2, "20m": 3.0, "15m": 2.1};

function makeRadio(modLevel = 128) {
  return {
    hz: 0, percent: 0, modLevel,
    knee(band, percent) { return K[band] * percent / this.modLevel; },
  };
}

// Runs a plan to completion against the radio, recording every intent.
function drive(run, radio, {answer = () => "ok", failCells = [], stopAfter = null,
                            measureFail = () => false, poFor = null,
                            kneeOverride = null} = {}) {
  const log = [];
  for (let guard = 0; guard < 400; guard++) {
    const step = run.next();
    log.push(step);
    if (stopAfter && log.length === stopAfter) { run.stop("operator stop"); continue; }
    switch (step.type) {
      case "retune":
        radio.hz = step.hz; radio.percent = 0;
        run.note({type: "tuned", hz: step.hz});
        break;
      case "askAntenna": {
        const verdict = answer(step);
        if (verdict === "skip") run.note({type: "antennaSkip", band: step.band});
        else if (verdict === "stop") run.note({type: "stationFailed", reason: "SWR 3.4"});
        else run.note({type: "antennaOk", band: step.band});
        break;
      }
      case "setPower":
        radio.percent = step.percent;
        run.note({type: "powerSet", percent: step.percent});
        break;
      case "measure": {
        const key = `${step.band}|${step.percent}`;
        const forced = measureFail(step);
        if (failCells.includes(key) || forced)
          run.note({type: "cellFailed",
                    reason: typeof forced === "string" ? forced : "ALC never acted"});
        else {
          // The knee comes from what the RADIO is set to, never from what the
          // step asked for: that is the whole point of the fixture.
          const raw = kneeOverride ? kneeOverride(step)
            : radio.knee(step.band, radio.percent || step.percent);
          // And the real search cannot see past its own ceiling: above 0.8 it
          // reports the ceiling and says the radio never limited. A fixture that
          // returned the true value would test a search that does not exist.
          //
          // It also arrives as its OWN note, exactly as tx-gain-cal-ui.js reports
          // it. The fixture used to hand it over as `measured` with a flag, which
          // no code path ever produced: the tool reported a ceiling as a plain
          // failure, so every check below passed against a message the real page
          // could not send, and the MOD-level correction they pin was unreachable
          // on the air.
          const knee = Math.min(0.8, raw);
          const po = poFor ? poFor(step) : Math.round(radio.percent * 2);
          if (raw > 0.8)
            run.note({type: "ceiling", knee, gain: knee, po,
                      reason: "the level reached the ceiling and the radio never limited"});
          else run.note({type: "measured", knee, gain: knee, po});
        }
        break;
      }
      case "writeMod":
        radio.modLevel = step.value;
        run.note({type: "modWritten", value: step.value});
        break;
      case "restore":
        run.note({type: "restored"});
        break;
      case "done":
        return log;
      default:
        return log;
    }
  }
  throw new Error("the sequencer did not finish");
}

// ---- the plan document ------------------------------------------------------

check("percent columns are whole, sorted, deduplicated and capped at four",
  JSON.stringify(Plan.normalizePowers([14, 1, 14, 0, 101, 2.6, 40, 60, 80])) ===
  JSON.stringify([1, 3, 14, 40]),
  JSON.stringify(Plan.normalizePowers([14, 1, 14, 0, 101, 2.6, 40, 60, 80])));

{
  const plan = Plan.normalizePlan({
    powers: [14, 1],
    rows: [{band: "40m", hz: 7040000, cells: [1, 1]},
           {band: "20m", hz: 14100000, cells: [0, 1]},
           {band: "20m", hz: 14200000, cells: [1, 1]},        // duplicate band
           {band: "", hz: 123, cells: [1]},                    // no band
           {band: "6m", hz: 0, cells: [1]}]});                 // no frequency
  check("a row needs a band and a frequency", plan.rows.length === 2,
        JSON.stringify(plan.rows.map(row => row.band)));
  check("the cell flags follow the sorted power order",
    JSON.stringify(plan.rows[0].cells) === JSON.stringify([1, 1]) &&
    JSON.stringify(plan.rows[1].cells) === JSON.stringify([0, 1]),
    JSON.stringify(plan.rows));
  const cells = Plan.cellsOf(plan);
  check("cells come out band-major and ascending in power",
    cells.map(cell => `${cell.band}@${cell.percent}`).join(" ") ===
    "40m@1 40m@14 20m@14",
    cells.map(cell => `${cell.band}@${cell.percent}`).join(" "));
}

{
  const plan = Plan.normalizePlan({powers: [1, 14],
    rows: [{band: "40m", hz: 7040000, cells: [1, 1]},
           {band: "20m", hz: 14100000, cells: [1, 1]}]});
  const cost = Plan.estimate(plan);
  check("the estimate counts two questions per band", cost.prompts === 4, String(cost.prompts));
  check("and one carrier per cell plus one per band",
    cost.carriers === 6, String(cost.carriers));
  check("air time is the sum of the carriers, not of the wall clock",
    cost.airMs === 2 * 8000 + 4 * 15000, String(cost.airMs));
  check("wall time is longer than air time", cost.totalMs > cost.airMs);
}

// ---- a full run -------------------------------------------------------------

{
  const plan = Plan.normalizePlan({powers: [1, 14],
    rows: [{band: "160m", hz: 1838000, cells: [1, 1]},
           {band: "40m", hz: 7040000, cells: [1, 1]},
           {band: "20m", hz: 14100000, cells: [1, 1]}]});
  const radio = makeRadio(128);
  const stored = {};
  const run = new Plan.TxGainPlanRun({plan, modLevel: radio.modLevel,
    resolve: cell => stored[`${cell.band}|${cell.percent}`] || null});
  run.begin();
  const log = drive(run, radio);
  const snapshot = run.snapshot();

  // The survey: one carrier per band, at that band's highest selected power, plus
  // one more on the owning band to verify the MOD level that was written from it.
  const surveys = log.filter(step => step.type === "measure" && step.survey);
  check("the survey keys once per band, plus one verification",
    surveys.length === 4, String(surveys.length));
  check("the survey uses each band's own highest power",
    surveys.every(step => step.percent === 14));
  check("the survey is coarse", surveys.every(step => step.resolutionDb === 1.5));

  // The MOD level: 40 m is the worst band (K = 4.2), knee at 14 % / 128 = 0.459,
  // so the correction is 128 * 0.459 / 0.7 = 84.
  const writes = log.filter(step => step.type === "writeMod");
  check("the MOD level is written exactly once", writes.length === 1,
        `wrote ${writes.length} times`);
  check("the worst band owns it", writes[0] && writes[0].band === "40m",
        writes[0] ? writes[0].band : "none");
  check("the correction aims the worst knee at 0.7",
    writes[0] && writes[0].value === 84, writes[0] ? String(writes[0].value) : "none");
  check("and the verification lands inside the tolerance",
    near(K["40m"] * 14 / 84, 0.7, 0.12), String(K["40m"] * 14 / 84));

  // The clean pass.
  const clean = log.filter(step => step.type === "measure" && !step.survey);
  check("every selected cell is measured after the write", clean.length === 6,
        String(clean.length));
  check("all six land as done", snapshot.done === 6, String(snapshot.done));
  check("the run reports the MOD level it settled on", snapshot.modLevel === 84);

  // Ordering and the antenna rule. The invariant is the one the operator asked
  // for -- a question for every retune -- and the count is what that costs: three
  // survey visits, one to verify the MOD level, three for the clean pass.
  const questions = log.filter(step => step.type === "askAntenna");
  const retunes = log.filter(step => step.type === "retune").length;
  check("a question for every retune, and never one without", retunes === questions.length,
        `${retunes} retunes vs ${questions.length} questions`);
  check("three bands cost seven visits", retunes === 7, String(retunes));
  check("a power change alone never asks again",
    questions.length < log.filter(step => step.type === "measure").length,
    "six cells and two powers per band must not be twelve questions");
  const order = clean.map(step => `${step.band}@${step.percent}`).join(" ");
  check("the clean pass runs band-major, ascending in power",
    order === "160m@1 160m@14 40m@1 40m@14 20m@1 20m@14", order);

  // Every measurement must have been taken with the radio actually on that cell.
  const wrong = log.filter((step, index) => step.type === "measure" &&
    log.slice(0, index).reverse().find(previous => previous.type === "retune")?.hz !== step.hz);
  check("no cell is measured before its retune", wrong.length === 0,
        `${wrong.length} measured on the wrong frequency`);
}

// ---- nothing keys before the antenna is confirmed --------------------------

{
  const plan = Plan.normalizePlan({powers: [1],
    rows: [{band: "40m", hz: 7040000, cells: [1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 128});
  run.begin();
  const first = run.next();
  check("the first intent is a retune", first.type === "retune");
  run.note({type: "tuned", hz: 7040000});
  const second = run.next();
  check("the antenna question comes before any power write or carrier",
    second.type === "askAntenna", second.type);
  // Asking again must not move anything on: an unanswered question is a state.
  check("an unanswered question repeats instead of proceeding",
    run.next().type === "askAntenna");
  check("the question carries a wait, and it is long enough to walk to a mast",
    second.timeoutMs === Plan.ANTENNA_WAIT_MS && second.timeoutMs >= 1800000,
    String(second.timeoutMs));
  run.note({type: "antennaOk", band: "40m"});
  check("only then is the power written", run.next().type === "setPower");

  // A retune spends the answer, stated as the rule rather than as a side effect of
  // the frequency comparison: the same frequency reported tuned again -- a host
  // retry after an unconfirmed write -- must ask again. Without this the rule reads
  // "one question per NEW frequency", which is not what the operator asked for.
  run.note({type: "tuned", hz: 7040000});
  check("a retune to the same frequency still asks again",
    run.next().type === "askAntenna");
}

// ---- skipping a band drops all of its cells --------------------------------

{
  const plan = Plan.normalizePlan({powers: [1, 14],
    rows: [{band: "40m", hz: 7040000, cells: [1, 1]},
           {band: "20m", hz: 14100000, cells: [1, 1]}]});
  const radio = makeRadio(128);
  const run = new Plan.TxGainPlanRun({plan, modLevel: 128});
  run.begin();
  const log = drive(run, radio, {answer: step => step.band === "20m" ? "skip" : "ok"});
  const measured = log.filter(step => step.type === "measure");
  check("a skipped band is never keyed",
    measured.every(step => step.band !== "20m"),
    measured.map(step => step.band).join(","));
  check("the other band still finishes",
    run.snapshot().done === 2, String(run.snapshot().done));
}

// ---- a cell failure continues, a station failure does not ------------------

{
  const plan = Plan.normalizePlan({powers: [1, 14],
    rows: [{band: "40m", hz: 7040000, cells: [1, 1]},
           {band: "20m", hz: 14100000, cells: [1, 1]}]});
  const radio = makeRadio(128);
  const run = new Plan.TxGainPlanRun({plan, modLevel: 128});
  run.begin();
  drive(run, radio, {failCells: ["40m|1"]});
  const snapshot = run.snapshot();
  check("a failed cell is recorded and the plan goes on",
    snapshot.failed === 1 && snapshot.done === 3,
    `${snapshot.failed} failed, ${snapshot.done} done`);
  check("the failure keeps its reason",
    snapshot.results.some(row => row.status === "failed" && /ALC/.test(row.reason)));
}

{
  const plan = Plan.normalizePlan({powers: [1],
    rows: [{band: "40m", hz: 7040000, cells: [1]},
           {band: "20m", hz: 14100000, cells: [1]}]});
  const radio = makeRadio(128);
  const run = new Plan.TxGainPlanRun({plan, modLevel: 128});
  run.begin();
  const log = drive(run, radio, {answer: step => step.band === "20m" ? "stop" : "ok"});
  check("a station failure stops the run", run.snapshot().state === "failed",
        run.snapshot().state);
  check("it restores the radio before finishing",
    log.some(step => step.type === "restore"),
    "an aborted plan must not leave the radio on a foreign band");
  check("and it says why", /SWR/.test(run.snapshot().error), run.snapshot().error);
}

// ---- STOP is one transition, whatever is in flight ------------------------

{
  const plan = Plan.normalizePlan({powers: [1, 14],
    rows: [{band: "40m", hz: 7040000, cells: [1, 1]},
           {band: "20m", hz: 14100000, cells: [1, 1]}]});
  const radio = makeRadio(128);
  const run = new Plan.TxGainPlanRun({plan, modLevel: 128});
  run.begin();
  const log = drive(run, radio, {stopAfter: 3});
  check("STOP ends the run wherever it was", run.snapshot().state === "stopped");
  check("STOP still restores", log.some(step => step.type === "restore"));
  check("nothing is measured after STOP",
    log.findIndex(step => step.type === "restore") ===
      log.length - 2 || log[log.length - 1].type === "done");
}

// ---- valid cells are skipped, stale ones seed the search ------------------

{
  const plan = Plan.normalizePlan({powers: [1, 14],
    rows: [{band: "40m", hz: 7040000, cells: [1, 1]}]});
  const radio = makeRadio(84);
  // One entry measured at today's MOD level, one at an older one.
  const stored = {
    "40m|1": {gain: 0.05, knee: 0.05, modLevel: 84},
    "40m|14": {gain: 0.9, knee: 0.9, modLevel: 168},
  };
  const run = new Plan.TxGainPlanRun({plan, modLevel: 84,
    resolve: cell => stored[`${cell.band}|${cell.percent}`] || null});
  run.begin();
  const log = drive(run, radio);
  const clean = log.filter(step => step.type === "measure" && !step.survey);
  check("a cell that is already valid for this MOD level is not keyed",
    !clean.some(step => step.percent === 1),
    clean.map(step => step.percent).join(","));
  check("a stale cell is re-measured", clean.some(step => step.percent === 14));
  const stale = clean.find(step => step.percent === 14);
  // 0.9 measured at MOD 168 predicts 0.9 * 168/84 = 1.8 at MOD 84.
  check("the stale knee is rescaled by the MOD ratio and passed as a seed",
    stale && near(stale.seed, 1.8, 0.001), stale ? String(stale.seed) : "none");
  check("the skip is recorded with a reason, not silently",
    run.snapshot().skipped >= 1 &&
    run.snapshot().results.some(row => row.status === "skipped" && /calibrated/.test(row.reason)));
}

{
  // An entry with no modLevel at all predates the schema. Usable on the air, but
  // it is not evidence about today's MOD level, so the plan re-measures it.
  const plan = Plan.normalizePlan({powers: [1], rows: [{band: "40m", hz: 7040000, cells: [1]}]});
  const stored = {"40m|1": {gain: 0.05, knee: 0.05}};
  const run = new Plan.TxGainPlanRun({plan, modLevel: 84,
    resolve: cell => stored[`${cell.band}|${cell.percent}`] || null});
  run.begin();
  const log = drive(run, makeRadio(84));
  check("a v1 entry without a MOD level is re-measured, not trusted",
    log.some(step => step.type === "measure" && !step.survey));
}

{
  // measureAll re-keys even a valid cell: the deliberate full run.
  const plan = Plan.normalizePlan({powers: [1], rows: [{band: "40m", hz: 7040000, cells: [1]}]});
  const stored = {"40m|1": {gain: 0.05, knee: 0.05, modLevel: 84}};
  const run = new Plan.TxGainPlanRun({plan, modLevel: 84, measureAll: true,
    resolve: cell => stored[`${cell.band}|${cell.percent}`] || null});
  run.begin();
  const log = drive(run, makeRadio(84));
  check("measureAll re-measures a valid cell",
    log.some(step => step.type === "measure" && !step.survey));
}

// ---- the MOD level loop ---------------------------------------------------

{
  // Already right: no write at all.
  const plan = Plan.normalizePlan({powers: [14], rows: [{band: "40m", hz: 7040000, cells: [1]}]});
  const radio = makeRadio(Math.round(K["40m"] * 14 / 0.7));   // knee is 0.7 exactly
  const run = new Plan.TxGainPlanRun({plan, modLevel: radio.modLevel});
  run.begin();
  const log = drive(run, radio);
  check("a MOD level that is already right is left alone",
    !log.some(step => step.type === "writeMod"));
}

{
  // Way off: the loop must converge inside its two corrections and stop.
  const plan = Plan.normalizePlan({powers: [14], rows: [{band: "40m", hz: 7040000, cells: [1]}]});
  const radio = makeRadio(255);
  const run = new Plan.TxGainPlanRun({plan, modLevel: 255});
  run.begin();
  const log = drive(run, radio);
  const writes = log.filter(step => step.type === "writeMod");
  check("the correction is bounded", writes.length <= Plan.MOD_MAX_CORRECTIONS,
        String(writes.length));
  check("and it converges", near(K["40m"] * 14 / radio.modLevel, 0.7, 0.15),
        String(K["40m"] * 14 / radio.modLevel));
}

{
  // MOD level far too low: the knee is above the ceiling, so the search reports
  // 0.8 and "never limited". The ratio from 0.8 would move the MOD level by 14 %
  // when it needs eight times more, so the loop must move decisively instead.
  const plan = Plan.normalizePlan({powers: [14], rows: [{band: "160m", hz: 1838000, cells: [1]}]});
  const radio = makeRadio(4);            // knee would be 3.4*14/4 = 11.9
  const run = new Plan.TxGainPlanRun({plan, modLevel: 4});
  run.begin();
  const log = drive(run, radio);
  const writes = log.filter(step => step.type === "writeMod");
  // Decisively, and never from a level the radio cannot modulate at: a ceiling reading
  // says the true knee is somewhere above 0.8, so a timid step would need six runs to
  // climb out. From 4 that is 4x -- and never below twice the floor.
  check("a ceiling hit moves the MOD level decisively, not by the ratio",
    writes.length >= 1 && writes[0].value >= 52 && writes[0].atCeiling === true,
    writes.length ? `${writes[0].value}` : "no write");
  check("and it says the level did not settle rather than claiming success",
    Boolean(run.snapshot().modAdvice), "two corrections cannot cross 30 dB");
  check("the matrix still gets measured", run.snapshot().done === 1);
}

{
  // Already at maximum and still not enough: the honest finding named in decision
  // 11 -- the RF power is beyond what this audio path can drive.
  const plan = Plan.normalizePlan({powers: [100], rows: [{band: "160m", hz: 1838000, cells: [1]}]});
  const radio = makeRadio(255);          // knee would be 3.4*100/255 = 1.33
  const run = new Plan.TxGainPlanRun({plan, modLevel: 255});
  run.begin();
  drive(run, radio);
  const advice = run.snapshot().modAdvice;
  check("a MOD level pinned at maximum reports the real cause",
    Boolean(advice) && /maximum/.test(advice.reason),
    advice ? advice.reason : "no advice");
  check("and it names the RF power, not the MOD level",
    Boolean(advice) && /RF power/.test(advice.reason));
  // The cell itself is a failure, not a green 0.8. The tool refuses to store a
  // ceiling -- it is where the search gave up, not a knee -- so a plan that
  // counted it as measured would report a calibrated station whose table has no
  // row for the cell, and the transmission would go out at the manual guess.
  const snapshot = run.snapshot();
  check("a ceiling at the top of the range is a failed cell, never a stored one",
    snapshot.done === 0 && snapshot.failed >= 1,
    `${snapshot.done} done / ${snapshot.failed} failed`);
  check("and it is marked as a ceiling rather than as a mystery",
    snapshot.results.some(row => row.status === "failed" && row.reachedCeiling === true),
    JSON.stringify(snapshot.results.map(row => [row.status, row.reachedCeiling])));
}

{
  // No MOD level read at all: measure, advise, never write.
  const plan = Plan.normalizePlan({powers: [14], rows: [{band: "40m", hz: 7040000, cells: [1]}]});
  const radio = makeRadio(128);
  const run = new Plan.TxGainPlanRun({plan, modLevel: 0});
  run.begin();
  const log = drive(run, radio);
  check("without a MOD level reading nothing is written",
    !log.some(step => step.type === "writeMod"));
  check("but the cells are still measured and the advice is given",
    run.snapshot().done === 1 && /unknown/.test(run.snapshot().modAdvice.reason));
}

{
  // The host reports that the MOD level cannot be read or written. The plan must
  // stop and say what the operator has to do -- this is the operator's own rule.
  const plan = Plan.normalizePlan({powers: [14], rows: [{band: "40m", hz: 7040000, cells: [1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 128});
  run.begin();
  run.note({type: "modUnavailable",
            reason: "the radio did not confirm 1A 05 01 17 — set the MOD level in its menu"});
  check("an unavailable MOD level stops the plan", run.snapshot().state === "failed");
  check("with the instruction, not a shrug",
    /menu/.test(run.snapshot().error), run.snapshot().error);
}

{
  // A survey that measures nothing must not divide by a knee it never got.
  const plan = Plan.normalizePlan({powers: [14], rows: [{band: "40m", hz: 7040000, cells: [1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 128});
  run.begin();
  const log = drive(run, makeRadio(128), {measureFail: () => true});
  check("a survey that measures nothing fails honestly",
    run.snapshot().state === "failed" && /survey/.test(run.snapshot().error),
    run.snapshot().error);
  check("and it restores the radio", log.some(step => step.type === "restore"));
}

{
  // An empty plan cannot key anything.
  const run = new Plan.TxGainPlanRun({plan: {powers: [], rows: []}, modLevel: 128});
  run.begin();
  check("an empty plan fails before any intent", run.snapshot().state === "failed");
  check("and never asks to key", run.next().type !== "measure");
}

// ---- the underrun retry, and the thermal flag -------------------------------
//
// Both were promised in the design and both were missing from the first build: the
// retry because a cell failure looked like a cell failure, and the flag because it
// was the compensation for running with no pauses -- the half of that decision that
// only shows up when a radio has warmed.

{
  // An underrun is the link's fault, not the cell's. One more carrier, then give up.
  const plan = Plan.normalizePlan({powers: [1], rows: [{band: "40m", hz: 7040000, cells: [1]}]});
  const radio = makeRadio(84);
  const run = new Plan.TxGainPlanRun({plan, modLevel: 84});
  run.begin();
  let underruns = 0;
  const log = drive(run, radio, {measureFail: step => {
    if (step.survey || underruns >= 1) return false;
    underruns++;
    return "FAULT_UNDERRUN on the thinned ring";
  }});
  const clean = log.filter(step => step.type === "measure" && !step.survey);
  check("an underrun is keyed again rather than recorded",
    clean.length === 2 && run.snapshot().done === 1 && run.snapshot().failed === 0,
    `${clean.length} carriers, ${run.snapshot().failed} failed`);
  check("and the retry is counted, not hidden", run.snapshot().retries === 1,
    String(run.snapshot().retries));
}

{
  // Twice on the same cell is the link telling us something: record it. The cell still
  // gets one more chance in the closing pass over what was left unmeasured, but not a
  // second underrun retry -- that budget is per cell, not per pass.
  const plan = Plan.normalizePlan({powers: [1], rows: [{band: "40m", hz: 7040000, cells: [1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 84});
  run.begin();
  const log = drive(run, makeRadio(84), {measureFail: step => step.survey
    ? false : "FAULT_UNDERRUN on the thinned ring"});
  const clean = log.filter(step => step.type === "measure" && !step.survey);
  check("a second underrun on the same cell is not retried again",
    clean.length === 3 && run.snapshot().failed === 1,
    `${clean.length} carriers, ${run.snapshot().failed} failed`);
  check("and the run still ends rather than looping", run.snapshot().state === "done",
    run.snapshot().state);
}

{
  // Any OTHER failure is the cell's own: no immediate retry, one closing attempt.
  const plan = Plan.normalizePlan({powers: [1], rows: [{band: "40m", hz: 7040000, cells: [1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 84});
  run.begin();
  const log = drive(run, makeRadio(84), {measureFail: step => step.survey
    ? false : "ALC never acted"});
  check("a cell failure that is not an underrun is not keyed again in the same pass",
    log.filter(step => step.type === "measure" && !step.survey).length === 2 &&
    run.snapshot().failed === 1,
    log.filter(step => step.type === "measure" && !step.survey).length + " carriers");
}

// ---- the closing pass over what was left --------------------------------------
//
// A band skipped because the antenna was wrong is exactly what the operator wants
// measured once the antenna is right and everything else is done. Walking back to it
// is not the same as looping, so it happens once and only once.

{
  const plan = Plan.normalizePlan({powers: [1, 14],
    rows: [{band: "40m", hz: 7040000, cells: [1, 1]},
           {band: "20m", hz: 14100000, cells: [1, 1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 84});
  run.begin();
  // Skip 20 m the first time it is asked about, accept it when it comes back.
  let skipped = false;
  const log = drive(run, makeRadio(84), {answer: step => {
    if (step.band !== "20m" || skipped) return "ok";
    skipped = true;
    return "skip";
  }});
  const twenties = log.filter(step => step.type === "measure" &&
                                      !step.survey && step.band === "20m");
  check("a skipped band is returned to at the end", twenties.length === 2,
    twenties.length + " carriers on 20m");
  check("and everything gets measured", run.snapshot().done === 4,
    String(run.snapshot().done));
  check("the operator is asked about it again", log.filter(step =>
    step.type === "askAntenna" && step.band === "20m").length >= 2);
}

{
  // A cell that fails no matter what must not keep the plan alive.
  const plan = Plan.normalizePlan({powers: [1, 14],
    rows: [{band: "40m", hz: 7040000, cells: [1, 1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 84});
  run.begin();
  // The failing cell is deliberately NOT the survey cell: a survey that measures
  // nothing is a different, already-tested outcome (the MOD level has no basis, so the
  // run stops instead of guessing).
  const log = drive(run, makeRadio(84), {failCells: ["40m|1"]});
  check("a permanently failing cell ends the run rather than cycling",
    run.snapshot().state === "done" && run.snapshot().failed === 1,
    run.snapshot().state + " / " + run.snapshot().failed + " failed");
  check("it was tried twice: once in the pass, once in the closing return",
    log.filter(step => step.type === "measure" && !step.survey &&
                       step.percent === 1).length === 2,
    String(log.filter(step => step.type === "measure" && !step.survey &&
                              step.percent === 1).length));
}

{
  // The thermal flag. Two powers on one band: forward power should scale with the
  // percentage, and a radio that has rolled its output back is more than 1 dB short.
  const plan = Plan.normalizePlan({powers: [1, 14],
    rows: [{band: "40m", hz: 7040000, cells: [1, 1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 84});
  run.begin();
  // 1 % gives Po 20; 14 % should give about 280, but the radio delivers 150.
  drive(run, makeRadio(84), {poFor: step => (step.percent === 1 ? 20 : 150)});
  const flagged = run.snapshot().results.filter(row => row.note === "po-low");
  check("a cell whose forward power fell short is flagged", flagged.length === 1,
    JSON.stringify(run.snapshot().results.map(row => [row.percent, row.po, row.note])));
  check("and the count is reported", run.snapshot().flagged === 1);
}

{
  // A radio that scales properly is not flagged. This is the half that keeps the
  // flag worth reading.
  const plan = Plan.normalizePlan({powers: [1, 14],
    rows: [{band: "40m", hz: 7040000, cells: [1, 1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 84});
  run.begin();
  drive(run, makeRadio(84), {poFor: step => step.percent * 20});
  check("a radio that holds its power is not flagged", run.snapshot().flagged === 0,
    JSON.stringify(run.snapshot().results.map(row => [row.percent, row.po, row.note])));
}

// ---- the MOD level must never stop the radio modulating ----------------------
//
// A second calibration run drove a real IC-705 to MOD level 1 -- 0 % in its menu, no
// modulation at all -- after which every search hit the ceiling, every cell stored
// 0.800, and the loop could not climb back out. It took a CI-V write from outside to
// recover. The floor, the ceiling jump and the refusal below are all that episode.

{
  const plan = Plan.normalizePlan({powers: [100], rows: [{band: "40m", hz: 7040000, cells: [1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 23});
  run.begin();
  // A knee measured far below target -- the shape that produced the disaster.
  const log = drive(run, makeRadio(23), {kneeOverride: () => 0.02});
  // Nothing is written at all: the value the arithmetic asks for is one the radio
  // cannot modulate at, so the honest move is to leave the setting alone and say why.
  check("a MOD level below a tenth of scale is never written",
    !log.some(step => step.type === "writeMod") && run.snapshot().modLevel === 23,
    String(run.snapshot().modLevel));
  check("and the refusal names the real cause",
    Boolean(run.snapshot().modAdvice) && /too hot/.test(run.snapshot().modAdvice.reason),
    run.snapshot().modAdvice ? run.snapshot().modAdvice.reason : "no advice");
}

{
  // And from a radio already stuck at 1, one run must climb out rather than crawl.
  const plan = Plan.normalizePlan({powers: [100], rows: [{band: "40m", hz: 7040000, cells: [1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 1});
  run.begin();
  const log = drive(run, makeRadio(1));
  const writes = log.filter(step => step.type === "writeMod");
  check("a radio stuck at a silent MOD level is lifted out in one move",
    writes.length >= 1 && writes[0].value >= Plan.MOD_RAW_MIN,
    writes.length ? String(writes[0].value) : "no write");
}

// ---- the progress the operator reads ----------------------------------------
//
// `done` counts stored cells, so it stays at 0 through the survey and the MOD level
// write -- a minute of carriers during which the number never moves. That reads as
// nothing happening, which is how it was reported: "it shows 0/4 the whole time, is
// that on purpose or a fault?"

// The powers are the fixture radio's, not round numbers: knee = K * percent /
// modLevel with K = 4.2 on 40 m means 100 % is above the 0.8 ceiling at EVERY MOD
// level, so a plan that asked for it could only ever end in failed cells. It used
// to end in four green ones, because the fixture handed a ceiling over as a
// measurement -- the same fiction the tool itself used to leave in the table.

{
  const plan = Plan.normalizePlan({powers: [10, 40],
    rows: [{band: "40m", hz: 7040000, cells: [1, 1]},
           {band: "20m", hz: 14100000, cells: [1, 1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 128});
  run.begin();
  const first = run.snapshot().progress;
  check("the survey says it is a survey", first.label === "survey", JSON.stringify(first));
  check("and counts the survey's own cells, not the matrix's",
    first.of === 2 && first.at === 1, JSON.stringify(first));

  // Walk it to the matrix and look again. The survey hits the ceiling on 40 m at
  // this MOD level, so this also walks the whole ceiling -> correction -> verify
  // path that the operator's radio was stuck in front of.
  const radio = makeRadio(128);
  drive(run, radio);
  const done = run.snapshot();
  check("a ceiling in the survey is corrected rather than stored",
    radio.modLevel > 128 && done.modLevel === radio.modLevel,
    `${radio.modLevel} / ${done.modLevel}`);
  check("every cell of the matrix is measured", done.done === 4, String(done.done));
  check("the label follows the phase rather than staying blank",
    typeof done.progress.label === "string" && done.progress.label.length > 0,
    JSON.stringify(done.progress));
}

// ---- where the search starts ------------------------------------------------
//
// A cell at a tenth of the power has a knee about a tenth as high. Starting cold
// there means walking down one settle at a time until the carrier runs out -- which
// is precisely how a run came back with the 100 % cells measured and the 10 % cells
// reporting "the carrier ran out before the search finished".

{
  const plan = Plan.normalizePlan({powers: [10, 40],
    rows: [{band: "40m", hz: 7040000, cells: [1, 1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 128});
  run.begin();
  const seeds = [];
  drive(run, makeRadio(128), {});
  // Recorded from the intents the sequencer issued.
  for (const row of run.snapshot().results) if (row.status === "ok") seeds.push(row);
  check("both cells of the band were measured", seeds.length === 2, String(seeds.length));
}

{
  // The seed itself, asked directly: a 10 % cell after the 100 % one is measured.
  const plan = Plan.normalizePlan({powers: [10, 100],
    rows: [{band: "40m", hz: 7040000, cells: [1, 1]}]});
  const run = new Plan.TxGainPlanRun({plan, modLevel: 92});
  run.begin();
  run.results.push({band: "40m", percent: 100, status: "ok", knee: 0.42});
  const seed = run.seedFor({band: "40m", percent: 10});
  check("a cell is seeded from its own band's other power, scaled by the ratio",
    near(seed, 0.042, 1e-9), String(seed));
  check("a cell of another band is not seeded from it",
    run.seedFor({band: "20m", percent: 10}) === 0);
  check("and a stored entry for the cell itself still wins",
    (() => {
      const stored = {"40m|10": {gain: 0.05, knee: 0.05, modLevel: 92}};
      const other = new Plan.TxGainPlanRun({plan, modLevel: 92,
        resolve: cell => stored[`${cell.band}|${cell.percent}`] || null});
      other.results.push({band: "40m", percent: 100, status: "ok", knee: 0.42});
      return near(other.seedFor({band: "40m", percent: 10}), 0.05, 1e-9);
    })());
}

// ---- what stops the whole run, and what only costs a cell --------------------
//
// The distinction is the difference between "one cell of four failed" and "the run
// died after the first green value" -- which is what the operator got, because every
// exception from a step was treated as a station failure. A readback that did not
// arrive in time says nothing about the station.

{
  const Ui = require(path.join(__dirname, "..", "data", "tx-gain-plan-ui.js"));
  const cellOnly = [
    "the radio did not confirm the power: asked for 7 % (level 18), it reports 12 % (level 31)",
    "the radio did not confirm the band: asked for 7040.0 kHz, it reports 14095.6 kHz",
    "the radio did not confirm USB-D",
    "ALC never acted, even at the maximum level",
    "FAULT_UNDERRUN",
  ];
  for (const reason of cellOnly)
    check(`"${reason.slice(0, 38)}..." costs a cell, not the run`,
      Ui.isStationFailure(reason) === false, reason);

  const fatal = [
    "ICOM-LAN is offline",
    "another page holds the radio",          // the session lock
    "SWR reached 3.4 — check the antenna",
    "the radio never answered the ALC meter (CI-V 15 13)",
    "this interface's firmware does not send ALC readings",
    "operator stop",
  ];
  for (const reason of fatal)
    check(`"${reason.slice(0, 38)}..." stops the run`,
      Ui.isStationFailure(reason) === true, reason);
}

// ---- answering the remaining antenna questions in advance -------------------
//
// The rule stays in the sequencer: a retune costs a confirmation, always, and the
// intent is still issued. What the operator can now do is answer the ones still to
// come, from the question that is already on screen. It is per run and never
// stored -- an antenna confirmation is a fact about somebody standing at the
// station, and one that outlived its session would be a confirmation about nobody.

{
  const Ui = require(path.join(__dirname, "..", "data", "tx-gain-plan-ui.js"));
  const plan = Plan.normalizePlan({powers: [10],
    rows: [{band: "40m", hz: 7040000, cells: [1]},
           {band: "20m", hz: 14100000, cells: [1]}]});

  // A panel without a document: only the two methods under test are exercised, and
  // everything they reach for is stubbed rather than drawn.
  const makePanel = () => {
    const panel = Object.create(Ui.TxGainPlanPanel.prototype);
    panel.run = new Plan.TxGainPlanRun({plan, modLevel: 128});
    panel.run.begin();
    panel.ask = null;
    panel.askAll = false;
    panel.autoAnswer = false;
    panel.opened = 0;
    panel.render = () => {};
    panel.pump = () => {};
    panel.open = () => { panel.opened++; };
    panel.armAskTimeout = () => {};
    panel.clearAskTimeout = () => {};
    return panel;
  };

  const step = {type: "askAntenna", band: "40m", hz: 7040000, percent: 10};

  const asking = makePanel();
  asking.execute(step);
  check("without the box the question is put on screen and waits",
    Boolean(asking.ask) && asking.opened === 1 && asking.run.confirmedHz === 0);

  // Ticking the box and answering arms it; the NEXT question answers itself.
  asking.run.note({type: "tuned", hz: 7040000});
  asking.askAll = true;
  asking.answer("ok");
  check("the box arms only when an answer is actually given", asking.autoAnswer === true);
  check("and it does not stay ticked for the next question", asking.askAll === false);

  const armed = makePanel();
  armed.autoAnswer = true;
  armed.run.note({type: "tuned", hz: 7040000});
  armed.execute(step);
  check("an armed panel answers the question instead of showing it",
    !armed.ask && armed.opened === 0 && armed.run.confirmedHz === 7040000);

  // STOP is not an answer, so it must not arm anything.
  const stopping = makePanel();
  stopping.ask = step;
  stopping.askAll = true;
  stopping.stop = () => { stopping.stopped = true; };
  stopping.answer("stop");
  check("STOP never arms it", stopping.autoAnswer === false && stopping.stopped === true);
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
