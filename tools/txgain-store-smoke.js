#!/usr/bin/env node
"use strict";

// The /txgain.json blob store, checked against the sketch source.
//
// There is nothing here a native harness could run -- the handlers are pure
// WebServer and LittleFS -- but the failures worth guarding are all structural,
// and structure is exactly what source can be asked about:
//
//   * the store must stay a BLOB. The moment the firmware starts parsing
//     entries it owns a schema it cannot migrate, in RAM it does not have, for
//     a table the radio has no use for.
//   * backup and restore must agree on the key. If the download writes
//     "txGain" and the restore looks for "txgain", a config restore brings back
//     everything except the calibrations -- and says nothing, because from its
//     point of view the section simply was not there.
//   * a missing file must read as an empty document, not a 404. An uncalibrated
//     radio is the normal first state.
//
// See docs/tx-auto-gain-implementace.md decision 3.

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

// ---- the endpoint ----------------------------------------------------------

check("the store has a path constant",
  /TXGAIN_CONFIG_PATH\s*=\s*"\/txgain\.json"/.test(sketch));
check("GET is routed",
  /webServer\.on\("\/txgain\.json",\s*HTTP_GET,\s*handleGetTxGain\)/.test(sketch));
check("POST is routed",
  /webServer\.on\("\/txgain\.json",\s*HTTP_POST,\s*handlePostTxGain\)/.test(sketch));

const getBody = between(sketch, "void handleGetTxGain()");
check("GET answers an empty document when nothing is stored",
  /json = "\{\}"/.test(getBody),
  "and a bare one: a hardcoded \"v\":1 skeleton became a lie when the table went to v2");
check("GET is uncacheable",
  /no-cache, no-store, must-revalidate/.test(getBody),
  "a cached table would be read back stale after a calibration");

const postBody = between(sketch, "void handlePostTxGain()");
check("POST bounds the body", /TXGAIN_MAX_BYTES/.test(postBody));
check("POST rejects anything that is not a JSON object",
  /body\[0\] != '\{'/.test(postBody) && /body\[body\.length\(\)-1\] != '\}'/.test(postBody));
check("POST writes the file whole",
  /cfgFS\.open\(TXGAIN_CONFIG_PATH, "w"\)/.test(postBody),
  "and on cfgFS, not the asset filesystem: the assets are replaced by every flash");

// The point of the design: no opinion about the contents.
for (const parser of ["extractJsonString", "extractJsonBool", "extractJsonInt",
                      "extractJsonObject", "aud1JsonU64"]) {
  check(`POST does not parse the table with ${parser}`, !postBody.includes(parser),
        "the schema belongs to the browser");
}
// Now that the empty document is bare {}, the firmware has no reason to name any
// part of the schema at all -- not the entry map, not a version. Any occurrence
// means something in C++ has started forming an opinion about the table.
const entryMentions = (sketch.match(/\\"entries\\"/g) || []).length;
check("the firmware never names the entry map", entryMentions === 0,
      `found ${entryMentions}`);

// ---- the ALC reply must be credited on BOTH radio paths ---------------------
//
// lanCivFrameRoute() hands slot 0 to lanCivFrameHandler and RETURNS: a LAN radio
// on TRX1 -- the ordinary single-radio setup -- feeds the shared CAT globals and
// never the per-slot snapshot. The first version parsed 15 13 only into the
// snapshot, so on that setup alcSeq never moved and the page correctly reported
// "the radio never answered the ALC meter" about a radio that had answered every
// time. Two handlers, two parses, and one accessor that picks by slot.

// lanCivFrameHandler() copies the frame into read_buffer and delegates to
// processCivBuffer(), so THAT is the TRX1 parse -- not the LAN-looking name.
const globalHandler = definition(sketch, "void processCivBuffer");
const snapshotHandler = definition(sketch, "void lanRadioCivSnapshot");

check("the TRX1 path parses the ALC meter",
  /pl\[0\] == 0x13/.test(globalHandler) && /stateAlcSeq\+\+/.test(globalHandler),
  "a LAN radio on TRX1 goes through processCivBuffer, never the snapshot");
check("the TRX1 LAN frames really reach that parser",
  /processCivBuffer\(\(uint8_t\)len\)/.test(definition(sketch, "void lanCivFrameHandler")));
check("the snapshot path parses it too",
  /pl\[0\] == 0x13/.test(snapshotHandler) && /alcSeq\+\+/i.test(snapshotHandler));
check("the counter only moves on a real reply",
  (sketch.match(/alcSeq\+\+/gi) || []).length === 2,
  "one increment per parse, nowhere else");
check("tx-level picks the source by slot, not by hope",
  /lanRadioSlotIndex\(\) == 0 \? stateAlcSeq/.test(sketch) &&
  sketch.includes("aud1AlcSeq()"));
check("both emitters use the accessor",
  (sketch.match(/aud1AlcSeq\(\)/g) || []).length >= 3,
  "two tx-level sites plus the definition");
check("and both sources are reset with a new txId",
  /aud1AlcReset\(\);/.test(sketch) &&
  /stateAlcRaw = 0; stateAlcSeq = 0;[\s\S]{0,80}lanRadioSnap\.alcRaw = 0/.test(sketch));

// ---- backup and restore ----------------------------------------------------

const downloadBody = between(sketch, "void handleConfigDownload()");
const uploadBody = between(sketch, "void handleConfigUpload()");

const downloadKey = /,\\"([A-Za-z]+)\\":";\s*\n?\s*j \+= txgainJson;/.exec(
  downloadBody.replace(/\r/g, ""));
check("the backup embeds the table", Boolean(downloadKey));
// The window was 200 characters until 2026-08-08, when the size guard that
// refuses an oversized section (instead of skipping it in silence) landed
// between the key and the write. The property is unchanged -- the key the
// backup emits is the key the restore opens the table with -- so the distance
// is what gets widened, not the check.
const restoreKey = /extractJsonObject\(body,\s*"([A-Za-z]+)"\)[\s\S]{0,600}?TXGAIN_CONFIG_PATH/
  .exec(uploadBody);
check("the restore reads it back", Boolean(restoreKey));
if (downloadKey && restoreKey) {
  check("backup and restore use the same key", downloadKey[1] === restoreKey[1],
        `${downloadKey[1]} vs ${restoreKey[1]}`);
}
check("the restore bounds what it writes",
  /TXGAIN_MAX_BYTES/.test(uploadBody));

// The backup is only worth having if it survives the flash that motivates it --
// and since 2026-08-08 the table does not need the backup to survive one at all:
// it lives on the `cfg` partition, which no tool writes. Asserting the mount is
// asserting that, because a table on the asset filesystem would be replaced by
// every firmware update and nothing would say so.
check("the table is stored on the configuration partition, not with the assets",
  /cfgFS\.open\(TXGAIN_CONFIG_PATH/.test(sketch)
  && !/LittleFS\.open\(TXGAIN_CONFIG_PATH/.test(sketch));

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

function between(text, signature) {
  const start = text.indexOf(signature);
  if (start < 0) return "";
  let depth = 0, index = text.indexOf("{", start);
  for (let at = index; at < text.length; at++) {
    if (text[at] === "{") depth++;
    else if (text[at] === "}" && --depth === 0) return text.slice(start, at + 1);
  }
  return text.slice(start);
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
