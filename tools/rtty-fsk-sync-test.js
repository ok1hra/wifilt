#!/usr/bin/env node
"use strict";

// The policy in data/rtty-fsk-sync.js, driven with a fake radio.
//
// Why a unit test and not only a browser one: everything interesting here is a
// DECISION -- which edge re-reads, what happens when the radio does not
// answer, who wins between the radio and the stored fallback, what a late
// reply is allowed to do -- and each of those costs seconds of real waiting in
// a browser harness and tells you nothing about WHICH branch broke. The wiring
// (does a decision actually reach the decoder and the waterfall) is covered
// where it belongs instead, in tools/log-rtty-panel-smoke.js section 7e.

const assert = require("assert");
const path = require("path");
const RttyFskSync = require(path.join(__dirname, "..", "data", "rtty-fsk-sync.js"));

const checks = [];
function check(name, ok, detail) { checks.push([name, !!ok, detail || ""]); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A model row shaped like icom-models.js's own, injected rather than looked up.
const IC705 = {rttyMarkFreqCmd: "1A050050", rttyKeyingPolarityCmd: "1A050052"};
const NO_FSK_ROW = {};        // IC-7300MK2/IC-9700/IC-7760: no verified address

// answers: {command: payload|null}. Records every command actually asked for.
function fakeRadio(answers, options) {
  const opts = options || {};
  const asked = [];
  return {
    asked,
    read(command) {
      asked.push(command);
      const answer = Object.prototype.hasOwnProperty.call(answers, command)
        ? answers[command] : null;
      if (opts.throws) return Promise.reject(new Error("link down"));
      if (!opts.delayMs) return Promise.resolve(answer);
      return new Promise(resolve => setTimeout(() => resolve(answer), opts.delayMs));
    },
  };
}

function makeSync(radio, options) {
  const opts = options || {};
  const state = {stored: {toneHz: 1500, reverse: false, squelchThreshold: 4,
                          fskMarkHz: opts.fallbackMarkHz || 2125},
                 changes: 0, saved: []};
  state.sync = RttyFskSync.create({
    read: radio.read,
    model: () => "IC-705",
    findModel: () => (opts.row === undefined ? IC705 : opts.row),
    fallbackMarkHz: () => state.stored.fskMarkHz,
    onMarkRead: hz => { state.saved.push(hz); state.stored.fskMarkHz = hz; },
    onChange: () => { state.changes++; },
  });
  state.effective = () => state.sync.effective(state.stored);
  return state;
}

async function run() {
  // ---- 1. the ordinary case: the radio answers ----------------------------
  {
    const radio = fakeRadio({"1A050050": "02", "1A050052": "00"});
    const s = makeSync(radio);
    check("idle, effective() hands back the STORED object itself",
      s.effective() === s.stored);

    s.sync.observe("RTTY", true);
    // Before any answer: the fallback is already in force, because a civ.read
    // can take seconds and the decoder must not sit on the AFSK tone meanwhile.
    check("entering RTTY applies the fallback immediately",
      s.effective().toneHz === 2125 + 85, String(s.effective().toneHz));
    check("and says the value is not from the radio yet", s.sync.fromRadio() === false);

    await sleep(20);
    check("the radio's own Mark Frequency wins once it answers",
      s.effective().toneHz === 2125 + 85 && s.sync.markHz() === 2125,
      `${s.sync.markHz()} / ${s.effective().toneHz}`);
    check("and it is now flagged as read from the radio", s.sync.fromRadio() === true);
    check("Keying Polarity Normal means the decoder runs REVERSED",
      s.effective().reverse === true, String(s.effective().reverse));
    check("both SET-menu items were asked for",
      radio.asked.length === 2 && radio.asked.includes("1A050050"),
      JSON.stringify(radio.asked));
    check("the stored settings object was never written",
      s.stored.toneHz === 1500 && s.stored.reverse === false,
      JSON.stringify({toneHz: s.stored.toneHz, reverse: s.stored.reverse}));
    check("the answer was persisted as the new fallback",
      s.saved.length === 1 && s.saved[0] === 2125, JSON.stringify(s.saved));

    // A different mark, to prove the centre really follows it.
    const low = makeSync(fakeRadio({"1A050050": "00", "1A050052": "00"}));
    low.sync.observe("RTTY-R", true);
    await sleep(20);
    check("1275 Hz marks put the centre at 1360, not at the default",
      low.effective().toneHz === 1275 + 85, String(low.effective().toneHz));

    // Reverse polarity: the tones do not move, only which one is mark.
    const rev = makeSync(fakeRadio({"1A050050": "02", "1A050052": "01"}));
    rev.sync.observe("RTTY", true);
    await sleep(20);
    check("Keying Polarity Reverse flips the decoder back, centre unmoved",
      rev.effective().reverse === false && rev.effective().toneHz === 2125 + 85,
      `${rev.effective().reverse} / ${rev.effective().toneHz}`);
  }

  // ---- 2. leaving real FSK gives the operator's own settings back ---------
  {
    const s = makeSync(fakeRadio({"1A050050": "02", "1A050052": "00"}));
    s.sync.observe("RTTY", true);
    await sleep(20);
    s.sync.observe("USB-D", true);
    check("back in USB-D, effective() is the stored object again",
      s.effective() === s.stored && s.effective().toneHz === 1500,
      String(s.effective().toneHz));
    check("and the sync reports itself idle", s.sync.active() === false);
  }

  // ---- 3. the edge key is mode AND session, not mode alone ---------------
  {
    const radio = fakeRadio({"1A050050": "02", "1A050052": "00"});
    const s = makeSync(radio);
    s.sync.observe("RTTY", false);
    await sleep(20);
    check("in RTTY but NOT holding the audio, nothing is read at all",
      radio.asked.length === 0 && s.sync.active() === false,
      JSON.stringify(radio.asked));

    s.sync.observe("RTTY", true);
    await sleep(20);
    check("taking the session over re-reads, though the mode never changed",
      radio.asked.length === 2, JSON.stringify(radio.asked));

    // Losing it and taking it back is the TAKE OVER case the old mode-only
    // key in rtty.js missed entirely.
    s.sync.observe("RTTY", false);
    check("losing the session drops the override", s.sync.active() === false);
    s.sync.observe("RTTY", true);
    await sleep(20);
    check("and getting it back reads again", radio.asked.length === 4,
      String(radio.asked.length));

    const settled = radio.asked.length;
    s.sync.observe("RTTY", true);
    s.sync.observe("RTTY-R", true);
    await sleep(20);
    check("a settled read is not re-armed while it stays real FSK",
      radio.asked.length === settled, String(radio.asked.length));
  }

  // ---- 4. when the radio cannot be asked ---------------------------------
  {
    const s = makeSync(fakeRadio({}), {row: NO_FSK_ROW, fallbackMarkHz: 1615});
    s.sync.observe("RTTY", true);
    await sleep(20);
    check("an unverified model falls back to the stored mark",
      s.effective().toneHz === 1615 + 85 && s.sync.markHz() === 1615,
      String(s.effective().toneHz));
    check("and says so, so the status line can mark it '?'",
      s.sync.fromRadio() === false);
    check("with reverse still defaulting to the on-air-verified true",
      s.effective().reverse === true);
    check("nothing was persisted -- there was no answer to persist",
      s.saved.length === 0, JSON.stringify(s.saved));

    const dead = makeSync(fakeRadio({}, {throws: true}));
    dead.sync.observe("RTTY", true);
    await sleep(20);
    check("a read that throws leaves the fallback in force, not an exception",
      dead.effective().toneHz === 2125 + 85 && dead.sync.fromRadio() === false,
      String(dead.effective().toneHz));

    const nul = makeSync(fakeRadio({"1A050050": null, "1A050052": null}));
    nul.sync.observe("RTTY", true);
    await sleep(20);
    check("a timed-out read (null) is not mistaken for an answer",
      nul.sync.fromRadio() === false && nul.effective().toneHz === 2125 + 85,
      String(nul.effective().toneHz));

    const junk = makeSync(fakeRadio({"1A050050": "7F", "1A050052": "7F"}));
    junk.sync.observe("RTTY", true);
    await sleep(20);
    check("an unrecognised payload is ignored rather than decoded as a tone",
      junk.sync.fromRadio() === false && junk.effective().reverse === true,
      `${junk.sync.markHz()} / ${junk.effective().reverse}`);
  }

  // ---- 5. a late reply must not retune a decoder that has moved on -------
  {
    const s = makeSync(fakeRadio({"1A050050": "00", "1A050052": "00"}, {delayMs: 40}));
    s.sync.observe("RTTY", true);
    s.sync.observe("USB-D", true);          // left before the reply lands
    await sleep(120);
    check("a reply arriving after the mode was left changes nothing",
      s.effective() === s.stored && s.saved.length === 0,
      JSON.stringify({tone: s.effective().toneHz, saved: s.saved}));
  }

  // ---- 6. the two manual escapes ----------------------------------------
  {
    const s = makeSync(fakeRadio({"1A050050": "02", "1A050052": "00"}));
    check("REVERSE cannot be flipped while nothing is overridden",
      s.sync.setReverse(false) === false);
    s.sync.observe("RTTY", true);
    await sleep(20);
    check("the per-contact REVERSE flip is accepted in real FSK",
      s.sync.setReverse(false) === true && s.effective().reverse === false,
      String(s.effective().reverse));
    check("and it stays transient -- the stored preference is untouched",
      s.stored.reverse === false && s.effective() !== s.stored);
    s.sync.observe("USB-D", true);
    s.sync.observe("RTTY", true);
    await sleep(20);
    check("the next edge re-derives it from the radio again",
      s.effective().reverse === true, String(s.effective().reverse));

    // The fallback, changed in SETTINGS while already in RTTY.
    const manual = makeSync(fakeRadio({}), {row: NO_FSK_ROW});
    manual.sync.observe("RTTY", true);
    await sleep(20);
    check("changing the mark setting takes effect immediately when the radio is mute",
      manual.sync.setMarkHz(1275) === true && manual.effective().toneHz === 1275 + 85,
      String(manual.effective().toneHz));
    check("a value Icom does not have is refused", manual.sync.setMarkHz(1800) === false);
    const answered = makeSync(fakeRadio({"1A050050": "02", "1A050052": "00"}));
    answered.sync.observe("RTTY", true);
    await sleep(20);
    check("but it never overrides a radio that has actually answered",
      answered.sync.setMarkHz(1275) === false && answered.effective().toneHz === 2125 + 85,
      String(answered.effective().toneHz));
  }

  // ---- 7. the cache identity every consumer relies on --------------------
  {
    const s = makeSync(fakeRadio({"1A050050": "02", "1A050052": "00"}));
    s.sync.observe("RTTY", true);
    await sleep(20);
    check("repeated effective() calls hand back the SAME object",
      s.effective() === s.effective());
    check("so scope and AFC do not allocate a copy per animation frame",
      s.effective() === s.effective());
    const before = s.effective();
    s.sync.setReverse(false);
    check("and a real change does produce a new one",
      s.effective() !== before && s.effective().reverse === false);
  }

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? `  -- ${detail}` : ""}`);
  }
  console.log(`\nRTTY FSK SYNC ${failed ? "FAIL" : "PASS"} ${checks.length - failed}/${checks.length}`);
  process.exit(failed ? 1 : 0);
}

run().catch(error => { console.error(error); process.exit(1); });
