#!/usr/bin/env node
"use strict";

// End-to-end for the compression profile: a sealed body must survive the real
// JS8 text layer -- buildReplyFrames -> ActivityStore reassembly -> payload --
// and open again, on the right key and hour, and fail cleanly otherwise. This is
// where the leading-space trim, the free-text misparse and the multi-frame pad
// would show up, none of which the isolated codec test can see.

const fs = require("fs");
const path = require("path");
const Js8Protocol = require("../data/js8-protocol.js");
const C = require("../data/compression.js");

const dictionary = new Js8Protocol.JscDictionary(
  fs.readFileSync(path.join(__dirname, "..", "data", "js8-jsc.bin")));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass += 1;
  else { fail += 1; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const FROM = "OK1XYZ", TO = "OK1ABC";
const MATERIAL = C.fromHex("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
const OTHER = C.fromHex("ffffffffffffffffffffffffffffffff");

// Drive a body through the JS8 text layer and return the reassembled payload +
// whether the reassembly was complete. `drop` omits the frame at that index.
function throughWire(body, { mode = 0, drop = -1 } = {}) {
  const frames = Js8Protocol.buildReplyFrames({ myCall: FROM, toCall: TO, text: body, mode });
  const store = new Js8Protocol.ActivityStore(dictionary);
  let emitted = [];
  frames.forEach((frame, index) => {
    if (index === drop) return;
    emitted = emitted.concat(store.push({
      ...frame, slotUtcMs: 1000 + index * 15000, submode: mode, offsetHz: 1500, snr: 0, dtMs: 0
    }));
  });
  emitted = emitted.concat(store.expire(1000 + frames.length * 15000 + 10 * 60000));
  const message = emitted.filter(item => item.type === "message").pop();
  return message ? message.message : null;
}

// ---- round-trip: many texts, keys, hours ------------------------------------
const TEXTS = [
  "HELLO", "SETKANI V 1200 NA 145.500", "73 DE OK1XYZ SEE YOU TOMORROW",
  "MEETING @ 12:00, BRING THE LOG; QRV ON 40M?", "A", "SHORT MSG",
  "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG AND KEEPS GOING FOR A GOOD WHILE LONGER",
  "PWD IS SUNSET-42 DONT SHARE", "COORDS 50.1N 14.4E QSY NOW",
];
let rtFail = 0, digitLeak = 0, spaceEdge = 0;
for (const text of TEXTS) {
  for (const hour of [0, 13, 23]) {
    const body = C.seal(text, MATERIAL, { from: FROM, to: TO, hour });
    if (/[0-9]/.test(body.slice(1, -1))) digitLeak += 1;
    if (/^\s|\s$/.test(body)) spaceEdge += 1;
    const payload = throughWire(body);
    if (!payload || payload.incomplete) { rtFail += 1; console.error(`   lost "${text}"`); continue; }
    const opened = C.openWith(payload.payload, MATERIAL, { from: FROM, to: TO, hour });
    if (!opened || opened.text !== C.normalize(text)) {
      rtFail += 1;
      console.error(`   "${text}" -> ${opened ? JSON.stringify(opened.text) : "null"}`);
    }
  }
}
ok("wire round-trip (texts x hours)", rtFail === 0, `${rtFail} failures`);
ok("body never carries a digit", digitLeak === 0, `${digitLeak} leaks`);
ok("body never edges on a space", spaceEdge === 0, `${spaceEdge} edges`);

// ---- wrong key -> null ------------------------------------------------------
{
  const body = C.seal("SECRET PLAN AT DAWN", MATERIAL, { from: FROM, to: TO, hour: 10 });
  const payload = throughWire(body);
  ok("wrong key rejects", C.openWith(payload.payload, OTHER, { from: FROM, to: TO, hour: 10 }) === null);
  ok("wrong hour rejects", C.openWith(payload.payload, MATERIAL, { from: FROM, to: TO, hour: 11 }) === null);
  ok("swapped callsigns reject", C.openWith(payload.payload, MATERIAL, { from: TO, to: FROM, hour: 10 }) === null);
  ok("right key+hour opens", (C.openWith(payload.payload, MATERIAL, { from: FROM, to: TO, hour: 10 }) || {}).text === "SECRET PLAN AT DAWN");
}

// ---- missing tail frame -> reported, not silent -----------------------------
{
  const text = "THIS MESSAGE IS LONG ENOUGH TO NEED SEVERAL DATA FRAMES ON NORMAL SPEED FOR SURE";
  const body = C.seal(text, MATERIAL, { from: FROM, to: TO, hour: 5 });
  const frames = Js8Protocol.buildReplyFrames({ myCall: FROM, toCall: TO, text: body, mode: 0 });
  const partial = throughWire(body, { drop: frames.length - 1 });
  // The reassembly itself flags the lost final frame (no EOT) as incomplete.
  ok("dropped tail -> incomplete reassembly", partial && partial.incomplete === true,
    partial ? `incomplete=${partial.incomplete}` : "no message");
  if (partial && !partial.incomplete) {
    const opened = C.openWith(partial.payload, MATERIAL, { from: FROM, to: TO, hour: 5 });
    ok("dropped tail -> missing-tail status",
      opened && opened.status === "missing-tail", opened ? JSON.stringify(opened) : "null");
  }
}

// ---- looksLikeProfile gate --------------------------------------------------
ok("gate accepts a real body",
  C.looksLikeProfile(C.seal("PING", MATERIAL, { from: FROM, to: TO, hour: 1 })));
ok("gate rejects ordinary traffic", !C.looksLikeProfile("HELLO OM 73"));
ok("gate rejects a digit body", !C.looksLikeProfile(".ABC12."));

// ---- hour window: sender at :59, receiver at next hour ----------------------
{
  const body = C.seal("EDGE OF THE HOUR", MATERIAL, { from: FROM, to: TO, hour: 12 });
  const payload = throughWire(body).payload;
  const tryHours = [11, 12, 13];   // receiver tries -1/0/+1
  const opened = tryHours.map(h => C.openWith(payload, MATERIAL, { from: FROM, to: TO, hour: h }))
    .find(Boolean);
  ok("hour -1/0/+1 window opens it", opened && opened.text === "EDGE OF THE HOUR");
}

// ---- keyring trial (the RX decision the browser hook runs) ------------------
{
  const mine = C.base32(C.fromHex("0f1e2d3c4b5a69788796a5b4c3d2e1f0"));
  const theirs = C.base32(C.randomBytes(16));
  const grpMat = C.base32(C.randomBytes(16));
  const profiles = [
    { name: "THEM", type: "peer", peer: "OK9ZZZ", material: theirs },
    { name: "ABC", type: "peer", peer: TO, material: mine },
    { name: "NET", type: "group", group: "@NOISE7", material: grpMat },
  ];
  const body = C.seal("KEYRING TRIAL WORKS", C.fromHex("0f1e2d3c4b5a69788796a5b4c3d2e1f0"),
    { from: FROM, to: TO, hour: 14 });
  const payload = throughWire(body).payload;
  const hours = [13, 14, 15];
  const hit = C.openAcross(payload, profiles, { from: FROM, to: TO, hours });
  ok("keyring trial finds the right profile", hit && hit.profile.name === "ABC" && hit.text === "KEYRING TRIAL WORKS");
  ok("keyring without the key returns null",
    C.openAcross(payload, [profiles[0]], { from: FROM, to: TO, hours }) === null);
  ok("keyring trial respects the hour window",
    !C.openAcross(payload, profiles, { from: FROM, to: TO, hours: [10, 11, 12] }));

  // Group body: sealed to @NOISE7, opened by the group profile.
  const gBody = C.seal("NET MESSAGE", C.unbase32(grpMat).subarray(0, 16),
    { from: FROM, to: "@NOISE7", hour: 14 });
  const gPayload = throughWire(gBody).payload;
  const gHit = C.openAcross(gPayload, profiles, { from: FROM, to: "@NOISE7", hours });
  ok("group profile opens a group body", gHit && gHit.profile.type === "group" && gHit.text === "NET MESSAGE");
}

// ---- review regressions -----------------------------------------------------

// A passphrase key must derive the SAME material on both stations. The salt is
// the shared label, not the target callsign (which differs between the peers).
{
  const pass = "correct horse battery staple";
  const aMaterial = C.hex(C.stretchSync(pass, C.passphraseSalt("Our Net"), 3000, 16));
  const bMaterial = C.hex(C.stretchSync(pass, C.passphraseSalt("  OUR   NET "), 3000, 16));
  ok("passphrase key: same label (any case/spacing) -> same material", aMaterial === bMaterial);
  const other = C.hex(C.stretchSync(pass, C.passphraseSalt("Other Net"), 3000, 16));
  ok("passphrase key: different label -> different material", aMaterial !== other);
}

// A resent own body must be recognised (opens across the whole day) so it is not
// double-sealed; a look-alike operator message must NOT be mistaken for one, so it
// can never be sent in clear when it should be sealed.
{
  const mat = C.fromHex("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
  const profile = { name: "ABC", type: "peer", peer: TO, material: C.base32(mat) };
  const own = C.seal("RESEND ME AN HOUR LATER", mat, { from: FROM, to: TO, hour: 9 });
  const day = Array.from({ length: 24 }, (_v, i) => i);
  ok("own cipher recognised across the day", !!C.openAcross(own, [profile], { from: FROM, to: TO, hours: day }));
  const lookalike = "." + "HELLO THERE OLD MAN" + ".";   // passes the shape gate, fails the MAC
  ok("look-alike text passes the shape gate", C.looksLikeProfile(lookalike));
  // isOwnCipherFor accepts only a real text open; a look-alike that parses as a
  // truncated block returns a truthy missing-tail status, which must NOT count.
  const laHit = C.openAcross(lookalike, [profile], { from: FROM, to: TO, hours: day });
  ok("look-alike text is NOT a genuine own-cipher open", !(laHit && laHit.text != null));
}

// The vault must re-seal under the iteration count its master was derived with; a
// mismatch (the old bug) makes the next unlock derive a different master and brick.
{
  const salt = C.randomBytes(16);
  const profiles = [{ name: "A", type: "peer", peer: "OK1AAA", material: C.base32(C.randomBytes(16)) }];
  const master = C.stretchSync("vault pw", salt, 3000, 32);
  const vault = C.sealVault(profiles, master, salt, 3000);
  const reopen = m => C.openVault(vault, C.stretchSync("vault pw", salt, m, 32));
  ok("vault opens under its stored iters", JSON.stringify(reopen(vault.kdf.iters)) === JSON.stringify(profiles));
  // The fix: persistVault re-seals with runtime.iters (here 3000), so a fresh
  // derive under the written iters still opens it.
  const resealed = C.sealVault(profiles, master, salt, 3000);
  ok("re-seal preserving iters stays openable", C.openVault(resealed, C.stretchSync("vault pw", salt, resealed.kdf.iters, 32)) !== null);
  // The bug: re-seal writing a different iters than the master was derived under
  // would brick — this asserts that scenario really fails, so the fix is load-bearing.
  const mismatched = C.sealVault(profiles, master, salt, 200000);   // ct under 3000-master, header says 200000
  ok("mismatched iters would brick (regression guard)",
    C.openVault(mismatched, C.stretchSync("vault pw", salt, mismatched.kdf.iters, 32)) === null);
}

console.log(`\ncompression-smoke: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
