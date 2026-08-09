#!/usr/bin/env node
"use strict";

// The civ.read request/response path, checked against the sketch source.
//
// The capture itself is tested as real firmware text by
// prototype/js8-core-prototype/build-civread-smoke.sh. What is left here is
// structure, and structure is where this path can fail silently:
//
//   * the capture must be invoked from BOTH radio paths. lanCivFrameRoute() hands
//     slot 0 to lanCivFrameHandler and returns, so an ordinary single-radio LAN
//     setup never touches the per-slot snapshot. Wiring only one of them is the
//     exact mistake that cost two on-radio attempts when ALC was added, and it
//     looks like "the radio does not answer" rather than like a bug.
//   * /civread must NOT invent a friendly empty answer. A firmware without the
//     endpoint 404s, and that 404 is how a page tells "flash the firmware" from
//     "the radio never answered". /txgain.json deliberately does the opposite,
//     and copying that here would erase the difference.
//   * the firmware must not decode the value. 1A 05 01 17 is BCD on an IC-705 and
//     an enumeration one subaddress away; the meaning belongs to the page.
//
// See docs/tx-audio-gain-plan-implementace.md, decision 5.

const fs = require("fs"), path = require("path");
const sketch = fs.readFileSync(path.join(__dirname, "..", "wifilt.ino"), "utf8");

let checks = 0, failures = 0;
function check(name, condition, detail = "") {
  checks++;
  if (condition) return true;
  failures++;
  console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  return false;
}

// ---- the request -----------------------------------------------------------

const cmdBody = definition(sketch, "void handlePostCmd");
check("civ.read is a command type", /type == "civ\.read"/.test(cmdBody));
check("it arms the capture before sending",
  /civReadArm\(payload, payloadLen\);[\s\S]{0,200}?catWriteFrameSlot/.test(cmdBody),
  "arming after the write can miss a fast reply");
check("it refuses an empty payload",
  /payloadLen == 0[\s\S]{0,120}invalid_hex/.test(cmdBody));
check("it answers with the sequence the caller must watch",
  /"\{\\"ok\\":true,\\"seq\\":" \+ String\(\(unsigned long\)civReadSeq\)/.test(cmdBody));
check("civ.raw stays a write and does not arm anything",
  !/type == "civ\.raw"[\s\S]{0,400}?civReadArm/.test(cmdBody));
check("it honours the same slot targeting as every other command",
  /catWriteFrameSlot\(targetSlot, frame, frameLen\)[\s\S]{0,400}?civReadSeq/.test(cmdBody) ||
  /civReadArm[\s\S]{0,200}?catWriteFrameSlot\(targetSlot/.test(cmdBody));

// ---- the reply -------------------------------------------------------------

check("GET is routed",
  /webServer\.on\("\/civread",\s*HTTP_GET,\s*handleGetCivRead\)/.test(sketch));

const readBody = definition(sketch, "void handleGetCivRead");
check("the endpoint exists", readBody.length > 0);
check("it reports the sequence", /\\"seq\\":" \+ String\(\(unsigned long\)civReadSeq\)/.test(readBody));
check("it echoes which address was asked about", /civReadPrefix\[i\]/.test(readBody),
  "without it a late answer cannot be matched to its question");
check("it returns the reply as hex", /%02X/.test(readBody) && /civReadReply\[i\]/.test(readBody));
check("it is uncacheable", /no-cache, no-store, must-revalidate/.test(readBody));
check("it does not fabricate an empty-but-valid document",
  !/\\"reply\\":\\"[0-9A-F]/.test(readBody),
  "a 404 from an old firmware must stay distinguishable");
check("age is zero until something was actually captured",
  /civReadReplyLen && civReadAtMs/.test(readBody));

// No interpretation anywhere in the endpoint: no BCD decode, no scaling, no
// per-model knowledge.
for (const forbidden of ["decodeCivBcdBytes", "modLevel", "0x17", "0x0117"])
  check(`the endpoint does not interpret the value (${forbidden})`,
        !readBody.includes(forbidden), "the schema belongs to the page");

// ---- both capture sites ----------------------------------------------------

const captureBody = definition(sketch, "void civReadCapture");
check("the capture is one function, not two copies", captureBody.length > 0);
check("the shared CAT parser captures",
  /civReadCapture\(read_buffer, len\)/.test(definition(sketch, "void processCivBuffer")),
  "this is where a LAN radio on TRX1 lands");
check("the per-slot snapshot captures too",
  /civReadCapture\(frame, len\)/.test(definition(sketch, "void lanRadioCivSnapshot")),
  "TRX2/TRX3 never reach processCivBuffer");
check("TRX1 LAN frames really reach the shared parser",
  /processCivBuffer\(\(uint8_t\)len\)/.test(definition(sketch, "void lanCivFrameHandler")));
// Exactly two call sites. Counted as statements (a line that starts with the
// call) rather than as mentions, because the declaration, the definition and the
// comments that point at it all contain the name too -- and a count that includes
// prose is a count that changes when someone improves a comment.
const callSites = (sketch.match(/^[ \t]*civReadCapture\(/gm) || []).length;
check("the capture is invoked exactly twice", callSites === 2,
      `found ${callSites} call statements`);
const bumps = (sketch.match(/civReadSeq\+\+/g) || []).length;
check("the sequence moves in exactly one place", bumps === 1,
      `found ${bumps}`);

// ---- the budget it must not touch ------------------------------------------

check("the value is not added to /state",
  !/civRead/.test(definition(sketch, "void buildStateJson")),
  "78 B of headroom, for a value that changes only when the operator acts");

// The sketch forward-declares nearly everything, so indexOf() on a signature
// finds the DECLARATION and slices the next unrelated brace pair. Anchor on a
// definition: signature ... ) followed by an opening brace.
function definition(text, name) {
  const at = new RegExp("\\n" + name + "\\([^;{]*\\)\\s*\\{").exec(text);
  if (!at) return "";
  const from = text.slice(at.index + 1);
  let depth = 0;
  for (let index = from.indexOf("{"); index < from.length; index++) {
    if (from[index] === "{") depth++;
    else if (from[index] === "}" && --depth === 0) return from.slice(0, index + 1);
  }
  return from;
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
