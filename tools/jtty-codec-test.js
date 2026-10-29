#!/usr/bin/env node
"use strict";
// JTTY source-grammar unit test (data/jtty-codec.js, docs/jtty-implementace.md
// §4.1). The 34-bit vectors and frame counts are the normative ones from
// WSJT-X lib/jtty/jtty_source_encoding.txt and jtty_design.md (v3.3.0-beta5),
// so a pass here means this port packs bit-for-bit like WSJT-X does.

const C = require("../data/jtty-codec.js");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log("FAIL " + name + (detail !== undefined ? "  " + detail : "")); }
}

const bitsToString = bits => Array.from(bits).join("");

// ── golden vectors (jtty_source_encoding.txt "Representative 34-bit vectors")
const VECTORS = [
  ["CQ K1ABC CQ", C.callAtom(C.CALL.CQ, "K1ABC"), true, "0000100110111101111000110101000001"],
  ["EXCH_NUM full SERIAL 123, more", C.numAtom(1, C.NUM.SERIAL, 123), false, "1000000000000001111011000000001000"],
  ["EXCH_NUM full SERIAL 123, EOM", C.numAtom(1, C.NUM.SERIAL, 123), true, "1000000000000001111011000000001001"],
  ["EXCH_LOC full STATE CA", C.locAtom(1, C.LOC.STATE_PROVINCE, "CA"), true, "1000000000000110111010000000011001"],
  ["ZONE_LOC3 05 NWT", C.zoneLocAtom(5, "NWT"), true, "0000001011011110010000110100101001"],
  ["CLASS_SECTION 1D EMA", C.classSectionAtom(1, "D", 11), true, "0010000010110001011000000000101001"],
  ["EXCH_NUM_TIME full 156 1749", C.numTimeAtom(1, 156, 17 * 60 + 49), true, "1000000100111001000010110100111001"],
  ["CONTROL AGN?", C.controlAtom(0), true, "0000000000000000000000000001001001"],
  ["GRID4 field-only FN42", C.grid4Atom(0, "FN42"), true, "0001001010000110011000000001001001"],
  ["TEXT5 HELLO", C.text5Atom("HELLO"), true, "0100010011100101010101010110001101"],
];
for (const [name, atom, eom, expected] of VECTORS) {
  const bits = C.packAtom(atom, eom);
  check("pack " + name, bits && bitsToString(bits) === expected, bits && bitsToString(bits));
  const back = bits && C.unpackAtom(bits);
  check("unpack " + name, back && back.eom === eom && C.renderAtom(back.atom) === C.renderAtom(atom),
    back && C.renderAtom(back.atom));
}
const rendered = VECTORS.map(v => C.renderAtom(v[1]));
check("canonical renderings", JSON.stringify(rendered) === JSON.stringify(["CQ K1ABC CQ", "599 123", "599 123",
  "599 CA", "599 05 NWT", "1D EMA", "599 156 1749", "AGN?", "FN42", "HELLO"]), JSON.stringify(rendered));

// ── frame counts (jtty_design.md tables)
function frames(text, profile) {
  const p = C.packText(text, {profile});
  return p ? p.frames.length : -1;
}
const UNKNOWN = [
  ["CQ K1ABC CQ", 1], ["CQ KA1ABC CQ", 1], ["WB9XYZ", 1], ["WB9XYZ TU CQ KA1ABC CQ", 2],
  ["WB9XYZ 599 123", 2], ["599 123", 1], ["599 MA", 1], ["599 FN42", 1], ["1D EMA", 1],
  ["599 001", 2], ["599 05", 2], ["599 BRUCE", 2],
];
for (const [text, n] of UNKNOWN) check("frames (Unknown) " + text, frames(text, C.PROFILE.UNKNOWN) === n, frames(text, C.PROFILE.UNKNOWN));
check("frames (Field Day) 1D EMA", frames("1D EMA", C.PROFILE.FIELD_DAY) === 1);
check("frames (Roundup) 599 001", frames("599 001", C.PROFILE.RTTY) === 1);
check("frames (Roundup) K1ABC 599 001", frames("K1ABC 599 001", C.PROFILE.RTTY) === 2);
check("frames (Roundup) 599 MA", frames("599 MA", C.PROFILE.RTTY) === 1);
const r05 = C.packText("599 05", {profile: C.PROFILE.RTTY});
check("Roundup 599 05 -> 599 005 in one frame", r05 && r05.text === "599 005" && r05.frames.length === 1, r05 && r05.text);
const r0123 = C.packText("599 0123", {profile: C.PROFILE.RTTY});
check("Roundup 599 0123 -> 599 123", r0123 && r0123.text === "599 123" && r0123.frames.length === 1);
const roundupSerial = C.packText("599 123", {profile: C.PROFILE.RTTY});
check("Roundup prefers SERIAL over GENERIC", roundupSerial.atoms[0].subtype === C.NUM.SERIAL);
const roundupState = C.packText("599 MA", {profile: C.PROFILE.RTTY});
check("Roundup prefers STATE over QTH", roundupState.atoms[0].kind === C.ATOM.EXCH_LOC && roundupState.atoms[0].subtype === C.LOC.STATE_PROVINCE);
check("bare number is never a serial", C.packText("123", {profile: C.PROFILE.RTTY}).atoms[0].subtype === C.NUM.GENERIC);
check("control phrase inside a message", frames("K1ABC AGN? TU", C.PROFILE.UNKNOWN) === 2);
check("44-character pangram takes 9 frames", frames("THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 1", C.PROFILE.UNKNOWN) === 9,
  frames("THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 1", C.PROFILE.UNKNOWN));

// ── round trips through the frames
const MESSAGES = ["CQ OK1HRA CQ", "OK1HRA 599 001", "TU NOW DL1ABC 599 102", "HELLO WORLD 73",
  "599 05 NWT", "OK1HRA/P DE OK2XYZ", "NAME DAN QTH PRAGUE", "1D EMA", "QSL TU", "599 JN79"];
for (const m of MESSAGES) {
  const p = C.packText(m, {profile: C.PROFILE.UNKNOWN});
  const back = p && C.unpackFrames(p.frames);
  check("round trip " + m, back && back.text === p.text && back.eom === true, back && back.text);
}
const open = C.packText("HELLO THERE", {isFinal: false});
check("non-final message carries no EOM", open.frames.every(f => f[33] === 0));
const closed = C.packText("HELLO THERE", {});
check("final message: EOM only on the last frame", closed.frames.slice(0, -1).every(f => f[33] === 0) && closed.frames[closed.frames.length - 1][33] === 1);

// ── normalization
check("normalize folds case, spaces and unsupported characters", C.normalize("  cq   dx é ") === "CQ DX #", C.normalize("  cq   dx é "));
check("normalize truncates the 80-column field", C.normalize("A".repeat(100)).length === 80);
check("80 incompressible characters take exactly 16 frames", frames("ABCDE".repeat(20), C.PROFILE.UNKNOWN) === 16);
check("empty text packs to nothing", C.packText("   ") === null);

// ── calls
for (const call of ["K1ABC", "OK1HRA", "W9XYZ", "JA6DEF", "KA1ABC", "VK2AB", "4X1AB"])
  check("standard call " + call, C.standardCall(call));
for (const call of ["OK1HRA/P", "QU1RK", "Q1ABC", "K1ABCD", "1ABC", "K1", "ABCDEF"])
  check("not a standard call " + call, !C.standardCall(call));
check("unpack28(pack28) round trip", C.unpack28(C.pack28("OK1HRA")) === "OK1HRA");

// ── grammar refusals (source-validity rules)
function word(bitsString) { return Uint8Array.from(bitsString, c => Number(c)); }
check("all-zero word is invalid", C.unpackAtom(word("0".repeat(34))) === null);
check("reserved bit 33 set is invalid", C.unpackAtom(word(VECTORS[0][3].slice(0, 32) + "11")) === null);
const reservedI2 = word(VECTORS[0][3]);
reservedI2[28] = 1; reservedI2[29] = 0; reservedI2[30] = 0; reservedI2[31] = 1;   // i2=1, n2=2
check("i2.n2 = 1.2 is reserved", C.unpackAtom(reservedI2) === null);
const guard = word(VECTORS[1][3]);
guard[27] = 1; guard[28] = 1; guard[29] = 1;   // family 111
check("STRUCT30 family 111 is invalid", C.unpackAtom(guard) === null);
const bigGrid = C.packAtom(C.grid4Atom(0, "RR99"), true);
check("RR99 is the last valid grid", bigGrid !== null && C.unpackAtom(bigGrid).atom.text === "RR99");
check("CQ zone 41 is refused", C.packAtom(C.numAtom(1, C.NUM.CQ_ZONE, 41), true) === null);
check("three-character token with a leading zero is refused", C.packAtom(C.locAtom(1, C.LOC.QTH, "0AB"), true) === null);

// ── filler and display
check("filler between words becomes one space", C.stripFiller("HELLO <<<<< <<<<<WORLD") === "HELLO WORLD", C.stripFiller("HELLO <<<<< <<<<<WORLD"));
check("leading/trailing filler disappears", C.stripFiller("<<<<< CQ <<<<<") === "CQ");
check("a typed '<' survives", C.stripFiller("A<B") === "A<B");
check("missed frames display as ...", C.displayText("CQ~~~~~K1ABC") === "CQ ... K1ABC", C.displayText("CQ~~~~~K1ABC"));

// ── native function keys
const ctx = {myCall: "OK1HRA", hisCall: "DL1ABC", queueCall: "G4XYZ", exchange: "1", profile: C.PROFILE.UNKNOWN};
const f1 = C.compileMacro("CQ %M CQ", ctx);
check("F1 CQ %M CQ is one native frame", f1.native && f1.frames.length === 1 && f1.text === "CQ OK1HRA CQ");
const f2 = C.compileMacro("%H %E", ctx);
check("F2 %H %E is CALL + SERIAL", f2.native && f2.frames.length === 2 && f2.text === "DL1ABC 599 001", f2.text);
const f3 = C.compileMacro("%H TU CQ %M CQ", ctx);
check("F3 is CALL_TU + CQ", f3.frames.length === 2 && f3.text === "DL1ABC TU CQ OK1HRA CQ", f3.text);
const f6 = C.compileMacro("TU NOW %Q %E", ctx);
check("F6 uses the queued call", f6.text === "TU NOW G4XYZ 599 001", f6.text);
const fd = C.compileMacro("%E", Object.assign({}, ctx, {exchange: "1D EMA", profile: C.PROFILE.FIELD_DAY}));
check("Field Day %E is CLASS_SECTION", fd.frames.length === 1 && fd.text === "1D EMA");
const rr = C.compileMacro("%E", Object.assign({}, ctx, {exchange: "MA", profile: C.PROFILE.RTTY}));
check("Roundup %E takes a state", rr.text === "599 MA");
let threw = false;
try { C.compileMacro("%H %E", Object.assign({}, ctx, {hisCall: "OK1HRA/P"})); } catch (_e) { threw = true; }
check("native template with a non-standard call is refused, not sent as text", threw);
const custom = C.compileMacro("%H GL 73", ctx);
check("custom template falls back to text packing", !custom.native && custom.text === "DL1ABC GL 73", custom.text);

console.log(`JTTY CODEC ${fail ? "FAIL" : "PASS"} ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
