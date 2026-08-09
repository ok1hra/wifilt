#!/usr/bin/env node
"use strict";

// Exercises the production auto-reply engine directly.
const {Js8AutoReply, formatSnr} = require("../../../data/js8-autoreply.js");
const {Js8Restrictions} = require("../../../data/js8-restrictions.js");

function check(condition, what) {
  if (!condition) { console.error(`AUTOREPLY FAIL: ${what}`); process.exitCode = 1; }
  return condition;
}

const BASE = {myCall: "OK1HRA", grid: "JO70AA", infoText: "50W VERT",
  statusText: "MONITORING", hearing: ["K0OG", "KD8SKZ"], groups: ["@ALLCALL", "@HB"],
  auto: true, selectedCall: "", nowMs: 10 * 60000};

const frame = (over = {}) => ({from: "K0OG", to: "OK1HRA", command: "SNR?",
  snr: -12, complete: true, ...over});
// Fresh engine past the QSO lock, since the lock starts at "never seen".
const engine = (opts = {}) => new Js8AutoReply(opts);

// --- the seven answers -----------------------------------------------------
{
  const e = engine();
  const cases = [
    ["SNR?", "SNR -12"],
    ["?", "SNR -12"],
    // "How do you copy me?" is the signal-report question asked in words, and it
    // is the reply JS8Call offers by default to a CQ -- so it is the first thing
    // most stations send at an unattended one. Answered with the same report,
    // from the same measurement, as SNR? would be.
    ["HW CPY?", "SNR -12"],
    ["GRID?", "GRID JO70AA"],
    ["INFO?", "INFO 50W VERT"],
    ["STATUS?", "STATUS MONITORING"],
    ["HEARING?", "HEARING KD8SKZ"],
  ];
  for (const [command, expected] of cases) {
    const out = e.handle(frame({command}), BASE);
    check(out.action === "reply" && out.text === expected && out.to === "K0OG",
      `${command} must answer "${expected}", got ${JSON.stringify(out)}`);
  }
}

// --- SNR formatting is the wire format, not a bare number -------------------
check(formatSnr(-12) === "-12" && formatSnr(5) === "+05" && formatSnr(0) === "+00",
  "SNR must be signed and zero padded");
check(formatSnr(999) === "+31" && formatSnr(-999) === "-30" && formatSnr(NaN) === "+00",
  "SNR must clamp to the six-bit wire range and tolerate junk");

// --- addressing -------------------------------------------------------------
{
  const e = engine();
  check(e.handle(frame({to: "OK2XYZ"}), BASE).reason === "not-addressed",
    "a frame for someone else must be ignored");
  check(e.handle(frame({to: "@ALLCALL"}), BASE).reason === "allcall",
    "automatic queries to @ALLCALL must be ignored like the reference");
  check(e.handle(frame({to: "@HB"}), BASE).action === "reply",
    "a non-ALLCALL group we joined may be answered");
  check(e.handle(frame({to: "@ARESGA"}), BASE).reason === "not-addressed",
    "a group we did not join must be ignored");
  check(e.handle(frame({from: "OK1HRA"}), BASE).reason === "self",
    "our own callsign must never be answered");
  check(e.handle(frame({command: "MSG"}), BASE).reason === "unsupported",
    "commands outside group B must be left alone");
}

// --- a half-received message is not answered --------------------------------
{
  const e = engine();
  check(e.handle(frame({complete: false}), BASE).reason === "incomplete",
    "an incomplete request must not be answered");
}

// --- QSO lock ---------------------------------------------------------------
{
  const e = engine();
  e.noteDirectedFrame(BASE.nowMs);           // a conversation is in progress
  const locked = e.handle(frame(), BASE);
  check(locked.reason === "qso-lock", "must stay quiet during a conversation");
  check(locked.detail.includes("s left"), "lock refusal must say how long");
  // One minute after the last directed frame the station is free again.
  const after = e.handle(frame(), {...BASE, nowMs: BASE.nowMs + 60000});
  check(after.action === "reply", "lock must release after a minute");
}

// --- missing configuration refuses instead of sending an empty frame --------
{
  const e = engine();
  check(e.handle(frame({command: "GRID?"}), {...BASE, grid: ""}).reason === "not-configured",
    "an unset grid must refuse, not send 'GRID '");
  check(e.handle(frame({command: "INFO?"}), {...BASE, infoText: "  "}).reason === "not-configured",
    "a blank INFO must refuse");
  check(e.handle(frame({command: "HEARING?"}), {...BASE, hearing: []}).reason === "not-configured",
    "hearing nobody must refuse");
}

// --- HEARING? stays inside one frame ----------------------------------------
{
  const e = engine();
  const out = e.handle(frame({command: "HEARING?"}),
    {...BASE, hearing: ["A1AA", "B2BB", "C3CC", "D4DD", "E5EE", "F6FF"]});
  check(out.text === "HEARING A1AA B2BB C3CC D4DD", `HEARING? must cap the list, got ${out.text}`);
}

// --- AGN? repeats what we actually sent -------------------------------------
{
  const e = engine();
  check(e.handle(frame({command: "AGN?"}), BASE).reason === "nothing-to-repeat",
    "AGN? with no history must refuse");
  e.noteSent("K0OG", "K0OG HELLO WORLD");
  const out = e.handle(frame({command: "AGN?"}), BASE);
  check(out.action === "reply" && out.text === "K0OG HELLO WORLD",
    `AGN? must repeat the last message, got ${JSON.stringify(out)}`);
}

// --- AUTO off produces the answer but does not send it ----------------------
{
  const e = engine();
  const out = e.handle(frame(), {...BASE, auto: false});
  check(out.action === "buffer" && out.text === "SNR -12",
    "AUTO off must offer the answer to the operator, not transmit it");
}

// --- restrictions are enforced and explained --------------------------------
{
  const restrictions = new Js8Restrictions();
  const e = engine({restrictions});
  check(e.handle(frame(), BASE).action === "reply", "first request must be answered");
  const second = e.handle(frame(), {...BASE, nowMs: BASE.nowMs + 1000});
  check(second.action === "skip" && second.reason === "window",
    "an immediate repeat must be refused by the restriction engine");
  check(second.retryInMs === 60000, "the refusal must carry the ban length");

  // Refusals caused by configuration must not burn a restriction slot.
  const r2 = new Js8Restrictions();
  const e2 = engine({restrictions: r2});
  e2.handle(frame({command: "GRID?"}), {...BASE, grid: ""});
  check(r2.snapshot(BASE.nowMs).granted === 0 && r2.snapshot(BASE.nowMs).windowed === 0,
    "a not-configured refusal must not consume the window");
  check(e2.handle(frame({command: "GRID?"}), BASE).action === "reply",
    "once configured the same station must be answered immediately");
}

// --- every skip is explained ------------------------------------------------
{
  const events = [];
  const e = engine({onEvent: event => events.push(event)});
  e.handle(frame({to: "OK2XYZ"}), BASE);
  check(events.some(event => event.type === "skip" && event.detail),
    "every skip must emit an event carrying a reason");
}

if (!process.exitCode)
// --- one signal report per window, whatever it was called -------------------
//
// HW CPY?, SNR? and a bare ? produce a byte-identical answer, so answering two of
// them in a row is transmitting the same frame twice. The restriction window
// exists to refuse exactly that, and it can only do so if the three share a key.
{
  const e = engine({restrictions: new Js8Restrictions({})});
  let at = BASE.nowMs;
  const ask = command => {
    at += 70000;                       // past the 60 s QSO lock each time
    return e.handle(frame({command}), {...BASE, nowMs: at});
  };
  check(ask("HW CPY?").action === "reply", "HW CPY? must be answered");
  check(ask("SNR?").reason === "window",
    "SNR? right after HW CPY? is the same question and must be refused");
  // A refusal does not refresh the window, so the third wording is still inside
  // the window opened by the ONE answer that was actually sent.
  check(ask("?").reason === "window",
    "and a third wording of the same question must not slip through either");
  // A different question is still a different question.
  const other = engine({restrictions: new Js8Restrictions({})});
  let ot = BASE.nowMs;
  const askOther = command => {
    ot += 70000;
    return other.handle(frame({command}), {...BASE, nowMs: ot});
  };
  check(askOther("HW CPY?").action === "reply", "seed");
  check(askOther("GRID?").action === "reply",
    "GRID? asks for something else and must still be answered");
}

  console.log("AUTOREPLY PASS commands=7 qsoLock=60s hearingMax=4 autoOff=buffer");
