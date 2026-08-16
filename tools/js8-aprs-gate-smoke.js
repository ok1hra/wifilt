#!/usr/bin/env node
"use strict";

// The JS8 -> APRS-IS gate, checked where it can be checked: in node, without a
// radio and without touching the network. Two things are pinned here on purpose:
//
//   1. the exact frame, because data/js8-aprs-gate.js is the ORACLE the C++ in
//      wifilt.ino has to agree with byte for byte (tools/aprsis-fake-server.js
//      compares the real firmware output against these same strings)
//   2. every one of the four filters, because each of them is the only thing
//      standing between "somebody transmitted" and "our callsign published it"

const assert = require("assert");
const Gate = require("../data/js8-aprs-gate.js");

// ---- passcode ---------------------------------------------------------------
// The published test vector for the aprsc hash. An odd-length callsign XORs its
// last character into the high byte alone (the C original's NUL terminator), so
// N0CALL and OK1HRA both have to come out right or the odd/even branch is wrong.
assert.strictEqual(Gate.passcode("N0CALL"), "13023");
assert.strictEqual(Gate.passcode("n0call"), "13023");
// Odd length, computed by hand against the C original: the last character is
// XORed into the high byte and nothing pairs with it. Without this vector every
// callsign in the test would be even-length and that branch untested.
assert.strictEqual(Gate.passcode("N0CAL"), "12947");
assert.strictEqual(Gate.passcode("N0CALL-10"), "13023", "SSID must not change the hash");
assert.strictEqual(Gate.passcode("OK1HRA"), Gate.passcode("OK1HRA-5"));
assert.notStrictEqual(Gate.passcode("OK1HRA"), Gate.passcode("OK1HRB"));
assert.strictEqual(Gate.passcodeValid("N0CALL-10", "13023"), true);
assert.strictEqual(Gate.passcodeValid("N0CALL-10", "13024"), false);
assert.strictEqual(Gate.passcodeValid("", "13023"), false);
assert.strictEqual(Gate.suggestCall("OK1HRA/P"), "OK1HRA-10");
assert.strictEqual(Gate.suggestCall(""), "");

// ---- locator -> APRS coordinate, centre of the cell -------------------------
// Hand-computed in docs/aprsis-igate-implementace.md. JN79NX's south-west corner
// is 4957.50N/01505.00E; the centre is one half subsquare further, and that half
// is the whole difference between this gate and JS8Call.
assert.deepStrictEqual(Gate.gridToAprs("JN79NX"), {lat: "4958.75N", lon: "01507.50E"});
assert.deepStrictEqual(Gate.gridToAprs("jn79nx"), {lat: "4958.75N", lon: "01507.50E"});
// Four characters: the centre is half a square away, half a degree of latitude.
assert.deepStrictEqual(Gate.gridToAprs("JN79"), {lat: "4930.00N", lon: "01500.00E"});
// Eight characters refine the centre without moving the square. This one lands on
// exactly 59.625 minutes -- a true rounding tie, and the reason the conversion is
// integer arithmetic instead of floating point: a float resolves it by the last
// bit, so JS and C++ would disagree on the last digit for locators like this one.
assert.deepStrictEqual(Gate.gridToAprs("JN79NX28"), {lat: "4959.63N", lon: "01506.25E"});
// Southern and western hemispheres, and both corners of the world.
assert.deepStrictEqual(Gate.gridToAprs("FM18LV"), {lat: "3853.75N", lon: "07702.50W"});
assert.deepStrictEqual(Gate.gridToAprs("GF15VC"), {lat: "3453.75S", lon: "05612.50W"});
assert.deepStrictEqual(Gate.gridToAprs("AA00AA"), {lat: "8958.75S", lon: "17957.50W"});
assert.deepStrictEqual(Gate.gridToAprs("RR99XX"), {lat: "8958.75N", lon: "17957.50E"});
assert.strictEqual(Gate.gridToAprs("JN7"), null);
assert.strictEqual(Gate.gridToAprs("ZZ99"), null);

// The claim that lets the conversion skip a 60.00-minute carry: every position a
// locator can produce is a multiple of 125 thousandths of a minute, so the
// remainder can never round up into the next degree. Swept over the whole grid,
// not argued -- if a locator ever produced "4960.00N" no APRS parser would take it.
let swept = 0;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWX";
for (const field of ["A", "F", "J", "N", "R"])
  for (const band of ["A", "F", "J", "N", "R"])
    for (const x of [0, 3, 9])
      for (const y of [0, 5, 9])
        for (const sub of ["", "AA", "MM", "XX", "AX", "XA"])
          for (const ext of sub ? ["", "00", "49", "99"] : [""]) {
            const grid = `${field}${band}${x}${y}${sub}${ext}`;
            const point = Gate.gridToAprs(grid);
            assert(point, `swept locator refused: ${grid}`);
            assert(/^[0-9]{4}\.[0-9]{2}[NS]$/.test(point.lat), `lat shape ${grid} ${point.lat}`);
            assert(/^[0-9]{5}\.[0-9]{2}[EW]$/.test(point.lon), `lon shape ${grid} ${point.lon}`);
            assert(Number(point.lat.slice(2, -1)) < 60, `lat minutes ${grid} ${point.lat}`);
            assert(Number(point.lon.slice(3, -1)) < 60, `lon minutes ${grid} ${point.lon}`);
            // Inside the world, and inside the cell the locator names.
            const degrees = Gate.gridToDegrees(grid);
            assert(degrees.lat > -90 && degrees.lat < 90, `lat range ${grid}`);
            assert(degrees.lon > -180 && degrees.lon < 180, `lon range ${grid}`);
            const cellLat = sub ? (ext ? 0.25 / 60 : 2.5 / 60) : 1;
            const cellLon = sub ? (ext ? 0.5 / 60 : 5 / 60) : 2;
            const corner = {lat: -90 + (band.charCodeAt(0) - 65) * 10 + y,
              lon: -180 + (field.charCodeAt(0) - 65) * 20 + x * 2};
            assert(degrees.lat >= corner.lat && degrees.lat <= corner.lat + 1 + cellLat,
              `lat outside its square ${grid}`);
            assert(degrees.lon >= corner.lon && degrees.lon <= corner.lon + 2 + cellLon,
              `lon outside its square ${grid}`);
            swept += 1;
          }
assert(swept > 1000, `sweep too small: ${swept}`);
assert.strictEqual(LETTERS.length, 24);

// ---- callsign -> APRS source ------------------------------------------------
assert.strictEqual(Gate.sourceCall("OK2ABC"), "OK2ABC");
assert.strictEqual(Gate.sourceCall("OK2ABC/P"), "OK2ABC");
assert.strictEqual(Gate.sourceCall("OK2ABC/9"), "OK2ABC-9");
assert.strictEqual(Gate.sourceCall("OK2ABC/QRP"), "OK2ABC");
assert.strictEqual(Gate.sourceCall("ok2abc/13"), "OK2ABC-13");

// ---- what the firmware must emit --------------------------------------------
const config = {enabled: true, call: "N0CALL-10", passcode: "13023",
  host: "czech.aprs2.net", port: 14580};

assert.strictEqual(
  Gate.frame({kind: "grid", from: "OK2ABC", grid: "JN79NX", snrDb: -7, freqHz: 14079200}, config),
  "OK2ABC>APJ8CL,qAR,N0CALL-10:=4958.75N/01507.50EG#JS8 14.079200MHz -07dB");
// A portable callsign loses its suffix in the source and gets it back in the comment.
assert.strictEqual(
  Gate.frame({kind: "grid", from: "OK2ABC/P", grid: "JN79NX", snrDb: 3, freqHz: 14079200}, config),
  "OK2ABC>APJ8CL,qAR,N0CALL-10:=4958.75N/01507.50EG#JS8 OK2ABC/P 14.079200MHz +03dB");
assert.strictEqual(
  Gate.frame({kind: "cmd", from: "OK2ABC", text: ":SMSGTE   :@+420123456789 AHOJ"}, config),
  "OK2ABC>APJ8CL,qAR,N0CALL-10::SMSGTE   :@+420123456789 AHOJ");
assert.strictEqual(Gate.frame({kind: "grid", from: "OK2ABC", grid: "XX"}, config), "");
assert.strictEqual(Gate.comment({from: "OK2ABC", snrDb: -7, freqHz: 0}), "-07dB");
assert(Gate.comment({from: "OK2ABC/VERYLONGSUFFIX", snrDb: -7, freqHz: 14079200})
  .length <= Gate.COMMENT_LIMIT, "comment must be truncated to 42");
assert.strictEqual(Gate.loginFrame(config, 20260816),
  "user N0CALL-10 pass 13023 vers wifilt 20260816");

// ---- reading a message ------------------------------------------------------
const grid = (from, payload, extra) => ({id: `${from}|${payload}`, snr: -7,
  directed: {from, to: "@APRSIS", command: " GRID"}, payload,
  incomplete: false, checksumOk: true, ...extra});
const cmd = (from, payload, extra) => ({id: `${from}|${payload}`, snr: -7,
  directed: {from, to: "@APRSIS", command: " CMD"}, payload,
  incomplete: false, checksumOk: true, ...extra});

assert.strictEqual(Gate.describe(null), null);
assert.strictEqual(Gate.describe({directed: {from: "OK2ABC", to: "OK1HRA", command: " GRID"},
  payload: "JN79NX"}), null, "traffic to somebody else is not ours to gate");
assert.strictEqual(Gate.describe({directed: {from: "OK2ABC", to: "@APRSIS", command: " SNR"},
  payload: "-07"}), null, "only GRID and CMD reach an IGate");
assert.strictEqual(Gate.describe(grid("OK2ABC", "JN79NX")).grid, "JN79NX");
assert.strictEqual(Gate.describe(grid("OK2ABC", "jn79nx28")).grid, "JN79NX28");
// A locator wrapped in words still gets found; junk alone does not.
assert.strictEqual(Gate.describe(grid("OK2ABC", "QTH JN79NX HI")).grid, "JN79NX");
assert.strictEqual(Gate.describe(grid("OK2ABC", "HELLO")).refuse, "no usable locator");
assert.strictEqual(Gate.describe(grid("SMS", "JN79NX")).refuse, "sender callsign unusable");

// The nine-character addressee is recomputed, never trusted: the sender's copy of
// that padding is invisible in a one-line input and hand-editing eats it.
assert.strictEqual(Gate.describe(cmd("OK2ABC", ":SMSGTE:HI")).text, ":SMSGTE   :HI");
assert.strictEqual(Gate.describe(cmd("OK2ABC", ":SMSGTE   :HI")).text, ":SMSGTE   :HI");
assert.strictEqual(Gate.describe(cmd("OK2ABC", ":  WXBOT :PRAGUE")).text, ":WXBOT    :PRAGUE");
assert.strictEqual(Gate.describe(cmd("OK2ABC", "SMSGTE:HI")).refuse, "not an APRS message");
assert.strictEqual(Gate.describe(cmd("OK2ABC", ":SMSGTE   :")).refuse, "not an APRS message");
assert.strictEqual(Gate.describe(cmd("OK2ABC", `:SMSGTE   :${"A".repeat(68)}`)).refuse,
  "APRS text over 67 characters");
assert.strictEqual(Gate.describe(cmd("OK2ABC", `:SMSGTE   :${"A".repeat(67)}`)).kind, "cmd");

function makeStore() {
  const map = new Map();
  return {map, getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value))};
}
const events = [];
function makeGate(storage) {
  events.length = 0;
  return new Gate.Js8AprsGate({storage: storage || makeStore(),
    onEvent: event => events.push(`${event.type}:${event.detail}`)});
}
const base = {config, blockedReason: () => "", freqHz: 14079200};

// ---- line injection ---------------------------------------------------------
// APRS-IS is line based and "\n" is a literal in the JS8 alphabet, so a station
// on the air could otherwise write a second, arbitrary packet into the CMD text
// and have this station publish it under its own callsign. CMD_RE spans newlines
// on purpose (the text is free-form), which is why the refusal is explicit.
const NEWLINE = String.fromCharCode(10), RETURN = String.fromCharCode(13);
for (const hostile of [
  ":SMSGTE:HI" + NEWLINE + "OK1XX>APRS,TCPIP*:>pwned",
  ":SMSGTE:HI" + RETURN + NEWLINE + "OK1XX>APRS,TCPIP*:>pwned",
  ":SMSGTE:" + NEWLINE + "HI",
  ":SMS" + NEWLINE + "GTE:HI"
]) {
  const shape = Gate.describe(cmd("OK2ABC", hostile));
  assert.strictEqual(shape.kind, "", "hostile CMD payload must not be gated");
  assert.strictEqual(shape.refuse, "control character in the message");
}
// The same through the whole decision, so the refusal is on the row and not just
// in a helper nobody calls.
let injGate = makeGate();
const injected = injGate.consider(cmd("OK2ABC", ":SMSGTE:HI" + NEWLINE + "OK1XX>APRS:>x"),
  {config, blockedReason: () => "", freqHz: 14079200, nowMs: 0});
assert.strictEqual(injected.state, "skipped");
assert.strictEqual(injected.reason, "control character in the message");
// A GRID message carrying a newline is refused for the same reason, even though
// the locator itself would have parsed.
assert.strictEqual(Gate.describe(grid("OK2ABC", "JN79NX" + NEWLINE + "OK1XX>APRS:>x")).refuse,
  "control character in the message");
// And a sender callsign is never a way in either.
assert.strictEqual(Gate.describe(grid("OK2ABC" + NEWLINE + "X", "JN79NX")).refuse,
  "control character in the message");
assert(!Gate.frame({kind: "cmd", from: "OK2ABC", text: ":SMSGTE   :HI"}, config)
  .includes(NEWLINE), "a built frame is one line");

// ---- readiness --------------------------------------------------------------
assert.strictEqual(Gate.readiness({...config, enabled: false}).ready, false);
assert.strictEqual(Gate.readiness({...config, passcode: "1"}).ready, false);
// The refusal must name the BASE callsign. Pointing at "OK1HRA-10" sends the
// operator looking at the SSID, which is the one part that cannot be wrong --
// the passcode is a checksum of the callsign with the SSID stripped.
const mismatch = Gate.readiness({...config, call: "OK1HRA-10", passcode: "1"}).reason;
assert(mismatch.includes("OK1HRA"), mismatch);
assert(!mismatch.includes("OK1HRA-10"), mismatch);
assert(Gate.passcode("OK1HRA") === Gate.passcode("OK1HRA-10"));
// Two callsigns, two different numbers -- the mistake this check exists for is a
// passcode that belongs to somebody else's callsign. 13023 is N0CALL's, and it is
// the vector used throughout these tests, so it is exactly the one likely to be
// pasted into the wrong field.
assert.strictEqual(Gate.passcode("OK1HRA"), "24480");
assert.notStrictEqual(Gate.passcode("OK1HRA"), Gate.passcode("N0CALL"));
assert.strictEqual(Gate.readiness({...config, call: ""}).ready, false);
assert.strictEqual(Gate.readiness(config).ready, true);
// -1 is the read-only login APRS-IS accepts; it must not pass for a gate that sends.
assert.strictEqual(Gate.readiness({...config, passcode: "-1"}).ready, false);

// ---- the four filters -------------------------------------------------------
let gate = makeGate();
let entry = gate.consider(grid("OK2ABC", "JN79NX"), {...base, nowMs: 1000});
assert.strictEqual(entry.state, "queued");
assert.strictEqual(entry.kind, "grid");
// The policy rides with the packet: the device is what enforces it, because the
// login is in the shared profile and every open browser is a gate.
assert.deepStrictEqual(gate.body(entry, config), {
  login: {call: "N0CALL-10", pass: "13023", host: "czech.aprs2.net", port: 14580,
    dedupMinutes: 10, maxPerHour: 30},
  packet: {kind: "grid", from: "OK2ABC", snrDb: -7, freqHz: 14079200, grid: "JN79NX"}});

// Filter 1: an incomplete reception is displayed but never gated. A lost EOT
// turns JN89HK into JN89 -- still a valid locator, tens of kilometres away.
gate = makeGate();
assert.strictEqual(gate.consider(grid("OK2ABC", "JN79", {incomplete: true}),
  {...base, nowMs: 1000}).state, "skipped");
assert.strictEqual(gate.consider(grid("OK2XYZ", "JN79NX", {checksumOk: false}),
  {...base, nowMs: 1000}).reason, "checksum failed");

// Filter 2: blocked stations get no internet gateway from us either.
gate = makeGate();
assert.strictEqual(gate.consider(grid("OK2ABC", "JN79NX"),
  {...base, nowMs: 1000, blockedReason: () => "blocked DXCC"}).reason, "blocked DXCC");

// Filter 3: dedup on sender + content, inside the window only.
gate = makeGate();
const first = gate.consider(grid("OK2ABC", "JN79NX"), {...base, nowMs: 1000});
gate.markSending(first, 1000);
gate.noteSend(first, {ok: true, seq: 1, sent: "x", nowMs: 1000});
const twin = gate.consider({...grid("OK2ABC", "JN79NX"), id: "second"},
  {...base, nowMs: 1000 + 9 * 60000});
assert.strictEqual(twin.state, "skipped");
assert(twin.reason.startsWith("already gated"), twin.reason);
const later = gate.consider({...grid("OK2ABC", "JN79NX"), id: "third"},
  {...base, nowMs: 1000 + 11 * 60000});
assert.strictEqual(later.state, "queued", "past the window it is news again");
// A different locator from the same station is not a duplicate.
assert.strictEqual(gate.consider({...grid("OK2ABC", "JN79NW"), id: "moved"},
  {...base, nowMs: 2000}).state, "queued");

// Filter 4: the hourly cap counts VERIFIED packets, so a wrong passcode can never
// look like a busy gate. Anything past the cap is refused with a reason.
gate = makeGate();
for (let i = 0; i < 30; i += 1) {
  const item = gate.consider({...grid("OK2ABC", `JN79N${String.fromCharCode(65 + i % 24)}`),
    id: `cap${i}`}, {...base, nowMs: 1000 + i});
  gate.markSending(item, 1000 + i);
  gate.noteSend(item, {ok: true, seq: i + 1, sent: "x", nowMs: 1000 + i});
  gate.noteStatus(item, {state: "verified", server: "T2TEST", nowMs: 1000 + i});
}
assert.strictEqual(gate.sentLastHour(2000), 30);
const capped = gate.consider({...grid("OK2XYZ", "JO70AA"), id: "over"},
  {...base, nowMs: 2000});
assert.strictEqual(capped.state, "skipped");
assert(capped.reason.includes("hourly cap"), capped.reason);
// An hour after the LAST of them the window has slid clear and the gate opens again.
const afterWindow = 1029 + 3600001;
assert.strictEqual(gate.sentLastHour(afterWindow), 0);
assert.strictEqual(gate.consider({...grid("OK2XYZ", "JO70AA"), id: "muchlater"},
  {...base, nowMs: afterWindow}).state, "queued");

// ---- retry, expiry and the server's verdict ---------------------------------
// Every step of the ladder must be reachable: indexing it one place too far left
// the last delay dead and turned a four-step ladder into a three-step one.
gate = makeGate();
let retry = gate.consider(grid("OK2ABC", "JN79NX"), {...base, nowMs: 0});
for (let attempt = 1; attempt <= Gate.RETRY_MS.length; attempt += 1) {
  gate.markSending(retry, 0);
  gate.noteSend(retry, {ok: false, error: "no route", nowMs: 0});
  assert.strictEqual(retry.state, "queued", `attempt ${attempt} must still be retried`);
  assert.strictEqual(retry.nextMs, Gate.RETRY_MS[attempt - 1], `backoff step ${attempt}`);
}
gate.markSending(retry, 0);
gate.noteSend(retry, {ok: false, error: "no route", nowMs: 0});
assert.strictEqual(retry.state, "failed", "a packet is not retried forever");

// "Not now" is not "failed". The interface refuses to open a socket while the
// transmitter is keyed, which is routine in a 15-second cycle -- four of those
// used to burn the whole ladder and drop a position nothing had refused.
gate = makeGate();
const busy = gate.consider(grid("OK2ABC", "JN79NX"), {...base, nowMs: 0});
for (let round = 0; round < 12; round += 1) {
  gate.markSending(busy, 0);
  gate.noteSend(busy, {ok: false, error: "tx", transient: true, nowMs: 0});
  assert.strictEqual(busy.state, "queued", `transient refusal ${round} must not fail it`);
}
assert.deepStrictEqual(gate.due(0), [], "a retry is not due immediately");
assert.deepStrictEqual(gate.due(Gate.RETRY_MS[0]).map(item => item.key), [busy.key]);
// ...but it still expires, so a radio that never stops transmitting cannot hold
// a position report for ever.
gate.due(Gate.TTL_MS + 1);
assert.strictEqual(busy.state, "failed");

// The interface says this frame already went out -- our own timed-out POST, or
// another browser now that the login lives in the shared profile. The row has to
// show it as gated, under the seq that actually carried it.
gate = makeGate();
const twin2 = gate.consider(grid("OK2ABC", "JN79NX"), {...base, nowMs: 0});
gate.markSending(twin2, 0);
gate.noteDuplicate(twin2, {seq: 12, nowMs: 5});
assert.strictEqual(twin2.state, "sent");
assert.strictEqual(twin2.seq, 12);
assert.strictEqual(twin2.sentMs, 5);
assert.strictEqual(twin2.duplicate, true);
assert.deepStrictEqual(gate.awaiting().map(item => item.seq), [12]);
// The verdict for that seq will turn the row green, because the frame really is
// on the network -- but the explanation of why this row has no packet of its own
// must survive it.
gate.noteStatus(twin2, {state: "verified", server: "T2TEST", nowMs: 10});
assert.strictEqual(twin2.state, "verified");
assert.strictEqual(twin2.reason, "already gated by this station");

// Past the TTL it is dropped instead of arriving late: `=` carries no timestamp,
// so a late position is plotted as if it had just been heard.
gate = makeGate();
const stale = gate.consider(grid("OK2ABC", "JN79NX"), {...base, nowMs: 0});
gate.due(Gate.TTL_MS - 1);
assert.strictEqual(stale.state, "queued");
gate.due(Gate.TTL_MS + 1);
assert.strictEqual(stale.state, "failed");
assert(stale.reason.includes("expired"), stale.reason);

// The logresp verdict is what turns the badge green, and only "verified" counts.
gate = makeGate();
const ok = gate.consider(grid("OK2ABC", "JN79NX"), {...base, nowMs: 0});
gate.markSending(ok, 0);
gate.noteSend(ok, {ok: true, seq: 7, sent: "line", nowMs: 0});
assert.strictEqual(ok.state, "sent");
assert.deepStrictEqual(gate.awaiting().map(item => item.seq), [7]);
gate.noteStatus(ok, {state: "pending", nowMs: 10});
assert.strictEqual(ok.state, "sent", "pending must not resolve the badge");
gate.noteStatus(ok, {state: "verified", server: "T2CZECH", nowMs: 20});
assert.strictEqual(ok.state, "verified");
assert.strictEqual(gate.sentLastHour(20), 1);

// "error" from the interface means the packet never reached the server -- a
// refused connect or a failed resolve. It is owed, not lost, so it goes back in
// the queue rather than turning the row red.
gate = makeGate();
const unreachable = gate.consider(grid("OK5ERR", "JN79NX"), {...base, nowMs: 0});
gate.markSending(unreachable, 0);
gate.noteSend(unreachable, {ok: true, seq: 4, sent: "line", nowMs: 0});
gate.noteStatus(unreachable, {state: "error", line: "connect failed", nowMs: 10});
assert.strictEqual(unreachable.state, "queued");
assert.strictEqual(unreachable.nextMs, 10 + Gate.RETRY_MS[0]);

gate = makeGate();
const bad = gate.consider(grid("OK2ABC", "JN79NX"), {...base, nowMs: 0});
gate.markSending(bad, 0);
gate.noteSend(bad, {ok: true, seq: 1, sent: "line", nowMs: 0});
gate.noteStatus(bad, {state: "unverified", line: "# logresp N0CALL-10 unverified", nowMs: 10});
assert.strictEqual(bad.state, "unverified");
assert.strictEqual(gate.sentLastHour(10), 0, "an unverified login delivered nothing");

// ---- the state survives F5 --------------------------------------------------
const store = makeStore();
gate = makeGate(store);
const kept = gate.consider(grid("OK2ABC", "JN79NX"), {...base, nowMs: 1000});
gate.markSending(kept, 1000);
gate.noteSend(kept, {ok: true, seq: 3, sent: "line", nowMs: 1000});
gate.noteStatus(kept, {state: "verified", server: "T2CZECH", nowMs: 1000});
const reloaded = new Gate.Js8AprsGate({storage: store});
assert.strictEqual(reloaded.sentLastHour(2000), 1, "the hourly cap must survive a reload");
assert.strictEqual(reloaded.consider({...grid("OK2ABC", "JN79NX"), id: "after-reload"},
  {...base, nowMs: 2000}).state, "skipped", "and so must the dedup window");
// A corrupt log must not take the page with it.
store.setItem(Gate.STORAGE_KEY, "{not json");
assert.strictEqual(new Gate.Js8AprsGate({storage: store}).sentLastHour(2000), 0);

// A gate that is off decides nothing, but still says why on the row.
gate = makeGate();
const offEntry = gate.consider(grid("OK2ABC", "JN79NX"),
  {...base, nowMs: 0, config: {...config, enabled: false}});
assert.strictEqual(offEntry.state, "skipped");
assert.strictEqual(offEntry.reason, "gate off");

console.log(`JS8 APRS GATE PASS grid=${JSON.stringify(Gate.gridToAprs("JN79NX"))} `
  + `frame=${JSON.stringify(Gate.frame({kind: "grid", from: "OK2ABC", grid: "JN79NX",
    snrDb: -7, freqHz: 14079200}, config))}`);
