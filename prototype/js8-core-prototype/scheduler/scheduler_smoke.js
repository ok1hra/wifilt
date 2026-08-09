#!/usr/bin/env node
"use strict";

// Exercises the production scheduler directly -- no hand-synced prototype copy.
const {Js8Scheduler} = require("../../../data/js8-scheduler.js");

let now = 1000;
const events = [];
const scheduler = new Js8Scheduler({wallNow: () => now, onEvent: e => events.push(e)});

// --- one-shot and repeating basics ------------------------------------------
const fired = [];
scheduler.after("once", 100, at => fired.push(["once", at]));
scheduler.every("tenth", 100, at => fired.push(["tenth", at]));

now = 1050; scheduler.tick(now);
if (fired.length !== 0)
  throw new Error(`Task fired before it was due: ${JSON.stringify(fired)}`);

now = 1100; scheduler.tick(now);
if (fired.length !== 2 || fired[0][1] !== 1100 || fired[1][1] !== 1100)
  throw new Error(`Due tasks did not both run at 1100: ${JSON.stringify(fired)}`);
if (scheduler.has("once"))
  throw new Error("One-shot task was not removed after running");
if (!scheduler.has("tenth"))
  throw new Error("Repeating task was removed after running");

// --- dueIn reflects the single clock ----------------------------------------
now = 1150;
if (scheduler.dueIn("tenth") !== 50)
  throw new Error(`dueIn wrong: ${scheduler.dueIn("tenth")}`);
if (scheduler.dueIn("missing") !== null)
  throw new Error("dueIn must be null for an unknown task");

// --- cancel ------------------------------------------------------------------
scheduler.after("doomed", 10, () => { throw new Error("cancelled task ran"); });
if (!scheduler.cancel("doomed")) throw new Error("cancel returned false");
now = 1200; scheduler.tick(now);

// --- coalescing: a long throttled gap must not replay every missed period ----
// This is the L3-critical behaviour: a hidden tab or a forward clock jump must
// produce one run, not one per missed interval.
const before = fired.filter(item => item[0] === "tenth").length;
now = 61200; // 60 s later = 600 missed 100 ms periods
scheduler.tick(now);
const after = fired.filter(item => item[0] === "tenth").length;
if (after - before !== 1)
  throw new Error(`Coalescing failed: ${after - before} runs for a 60 s gap`);
const coalesced = events.find(event => event.type === "coalesced");
if (!coalesced || coalesced.id !== "tenth" || coalesced.missed < 500)
  throw new Error(`Coalesced event missing or wrong: ${JSON.stringify(coalesced)}`);
if (scheduler.dueIn("tenth") !== 100)
  throw new Error("Repeating task did not reschedule from the current time");

// --- backwards clock (correction applied / epoch change) ---------------------
scheduler.every("slow", 5000, () => {});
now = 61300; scheduler.tick(now);
const beforeJump = scheduler.dueIn("slow");
now = 31300; // clock pulled back 30 s
scheduler.tick(now);
const afterJump = scheduler.dueIn("slow");
if (!(afterJump <= 5000))
  throw new Error(`Backwards clock stranded a task ${afterJump} ms out (was ${beforeJump})`);
if (!events.some(event => event.type === "clock-backwards"))
  throw new Error("Backwards clock produced no event");

// --- a throwing task must not stop the others -------------------------------
let survivorRan = false;
scheduler.after("thrower", 10, () => { throw new Error("boom"); });
scheduler.after("survivor", 10, () => { survivorRan = true; });
now = 31400; scheduler.tick(now);
if (!survivorRan) throw new Error("A throwing task blocked the next task");
const errorEvent = events.find(event => event.type === "error" && event.id === "thrower");
if (!errorEvent || errorEvent.message !== "boom")
  throw new Error(`Task error not reported: ${JSON.stringify(errorEvent)}`);
if (scheduler.stats.errors !== 1)
  throw new Error(`Error count wrong: ${scheduler.stats.errors}`);

// --- setClock is the L1 -> L3 seam ------------------------------------------
// Swapping the source must keep tasks registered and must not replay the gap.
let mediaNow = 500000;
scheduler.setClock(() => mediaNow);
if (scheduler.now() !== 500000) throw new Error("setClock did not take effect");
let afterSwap = 0;
scheduler.every("swapped", 1000, () => { afterSwap += 1; });
mediaNow = 501000; scheduler.tick(mediaNow);
if (afterSwap !== 1)
  throw new Error(`Task did not run on the swapped clock: ${afterSwap}`);
// The huge apparent jump backwards (61 s wall -> 500 s media) must not have been
// treated as a backwards clock, because setClock resets the epoch.
const backwardsEvents = events.filter(event => event.type === "clock-backwards").length;
if (backwardsEvents !== 1)
  throw new Error(`setClock leaked an epoch comparison: ${backwardsEvents} events`);

const snapshot = scheduler.snapshot();
if (snapshot.taskCount !== scheduler.tasks.size)
  throw new Error("snapshot task count mismatch");

console.log(`SCHEDULER PASS ticks=${snapshot.ticks} runs=${snapshot.runs} ` +
  `coalesced=${snapshot.coalesced} errors=${snapshot.errors} tasks=${snapshot.taskCount}`);
