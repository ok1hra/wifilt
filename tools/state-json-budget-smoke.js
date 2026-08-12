#!/usr/bin/env node
"use strict";

// buildStateJson formats the whole /state document into a fixed stack buffer with
// snprintf. snprintf does not overflow, it TRUNCATES -- so one field too many
// produces JSON that is cut off mid-token, and every page that polls /state
// breaks at once with nothing in the log to say why.
//
// This derives the worst-case expanded length straight from the sketch's format
// string and checks it against the declared buffer, so adding a field either
// fits or fails here.

const fs = require("fs"), path = require("path");
const sketch = fs.readFileSync(path.join(__dirname, "..", "wifilt.ino"), "utf8");

let failures = 0, checks = 0;
function ok(name, condition, detail = "") {
  checks++;
  if (condition) return true;
  failures++;
  console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  return false;
}

// ---- the declared buffer ---------------------------------------------------

const bufferMatch = /static char stateBuf\[(\d+)\]/.exec(sketch);
ok("stateBuf is declared", Boolean(bufferMatch));
const bufferBytes = bufferMatch ? Number(bufferMatch[1]) : 0;

// ---- the format string -----------------------------------------------------

// buildStateJson's snprintf spans several adjacent string literals. Take the
// text between `snprintf(buf, bufSize,` and the closing `);` of the call.
const body = sketch.slice(sketch.indexOf("void buildStateJson("));
const callAt = body.indexOf("snprintf(buf, bufSize,");
ok("buildStateJson uses snprintf", callAt >= 0);
const call = body.slice(callAt + "snprintf(buf, bufSize,".length,
                        body.indexOf("\n  );", callAt));

// The format is a run of adjacent string literals; the argument list is
// everything after the last of them. Splitting on the last quote in the whole
// call does not work, because `? "true" : "false"` puts literals in the
// arguments too -- and taking every literal would splice "true" and "false"
// into the format and inflate the budget.
function splitFormatFromArguments(text) {
  let at = 0, format = "";
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) at++;
    if (text[at] !== '"') break;
    let index = at + 1;
    for (; index < text.length; index++) {
      if (text[index] === "\\") { index++; continue; }
      if (text[index] === '"') break;
    }
    format += text.slice(at + 1, index).replace(/\\"/g, '"');
    at = index + 1;
    while (at < text.length && /\s/.test(text[at])) at++;
    if (text[at] === ",") { at++; break; }          // format ends, arguments start
  }
  return {format, argumentText: text.slice(at)};
}

const {format, argumentText} = splitFormatFromArguments(call);
ok("format string recovered", format.startsWith("{") && format.endsWith("}"),
   `${format.length} B, starts ${JSON.stringify(format.slice(0, 12))}`);
ok("format carries no stray true/false literal", !/^\{.*"true".*\}$/.test(format));

// ---- worst case, bound per ARGUMENT ---------------------------------------

// A %s is only as long as whatever is passed to it, and most of these are the
// five characters of "false". Inventing a blanket width for %s made this budget
// useless (it claimed 1594 B for a document that cannot exceed 700). So each
// argument gets an explicit, reviewable bound, and an argument this table does
// not recognise FAILS -- which forces whoever adds a field to state its length
// instead of hoping.
const ARGUMENT_BOUNDS = [
  [/\?\s*"true"\s*:\s*"false"/, 5, "boolean rendered as true/false"],
  [/^lanStatus$/, 12, '"disconnected"'],
  [/^btStat$/, 24, '"TRXNET linked (limited)"'],
  [/^wifiStat$/, 9, '"WiFi down"'],
  [/^radioTransportName\(/, 8, "transport name"],
  [/^addrStr$/, 4, '"0xA4"'],
  [/^transceiverType\.c_str\(\)$/, 16, '"IC-7610-CI-V"'],
  // LAN view of /state: same field, either transceiverType or a literal.
  [/^viewType$/, 16, '"IC-7610-CI-V" / "ICOM-LAN"'],
  [/^modesSnapshot$/, 11, "char modes[12] at wifilt.ino:229"],
  [/^radioNameForJson\(/, 15, "radio caps name, sanitised and bounded"],
  [/^rssi$/, 5, "-999 .. 0"],
  [/^\(unsigned\)/, 10, "uint32"],
  [/^(state|view)(SupplyVolts|Swr)$/, 8, '"%.2f"'],
  // ,"gpsGrid":"JO60WC28","gpsFixAgeMs":999999999,"gpsSel":255 -- or empty when
  // the radio has no GPS. Built by its own bounded snprintf in buildStateJson.
  [/^gpsFrag$/, 59, "GPS fields, present only when the radio answered 23 00"],
];

function splitArguments(text) {
  const out = [];
  let depth = 0, current = "";
  for (const char of text) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) { out.push(current.trim()); current = ""; continue; }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const args = splitArguments(argumentText);
const conversions = format.match(/%[-+ #0-9.]*[a-zA-Z]/g) || [];
ok("conversions found", conversions.length > 0, `${conversions.length}`);
ok("every conversion has an argument", conversions.length === args.length,
   `${conversions.length} conversions, ${args.length} arguments`);

let worst = format.length + 1;   // + the NUL snprintf always writes
for (let index = 0; index < conversions.length; index++) {
  const conversion = conversions[index], argument = args[index] || "";
  const entry = ARGUMENT_BOUNDS.find(([pattern]) => pattern.test(argument));
  if (!ok(`argument ${index} has a declared bound`, Boolean(entry),
          `${conversion} <- ${argument.slice(0, 40)}`)) continue;
  worst += entry[1] - conversion.length;
}

const headroom = bufferBytes - worst;
console.log(`  format literal      ${String(format.length).padStart(5)} B`);
console.log(`  conversions         ${String(conversions.length).padStart(5)}` +
            `  (%s x${conversions.filter(text => text.endsWith("s")).length})`);
console.log(`  worst case          ${String(worst).padStart(5)} B`);
console.log(`  stateBuf            ${String(bufferBytes).padStart(5)} B`);
console.log(`  headroom            ${String(headroom).padStart(5)} B`);

ok("worst-case /state JSON fits stateBuf", headroom >= 0,
   `needs ${worst} B, buffer is ${bufferBytes} B -- snprintf would TRUNCATE and every page loses /state`);
// Margin, because two %s inputs are bounded by their sources rather than by this
// file: transceiverType comes from config, radioName off the wire.
ok("at least 64 B of margin", headroom >= 64, `${headroom} B`);

// ---- the network-derived field must not be able to break the JSON ----------

if (format.includes("radioName")) {
  ok("radioName is emitted through a sanitiser, not raw",
     /radioNameForJson\s*\(/.test(sketch),
     "caps come off the wire; a quote or backslash in them would corrupt /state");
  const sanitiser = /static const char \*radioNameForJson\([\s\S]*?\n}/.exec(sketch);
  ok("sanitiser exists", Boolean(sanitiser));
  if (sanitiser) {
    ok("sanitiser rejects quote and backslash",
       sanitiser[0].includes("'\"'") && sanitiser[0].includes("'\\\\'"));
    ok("sanitiser bounds its output", /sizeof\(|<\s*\d+/.test(sanitiser[0]));
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
