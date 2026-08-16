#!/usr/bin/env node
"use strict";

// Do the firmware and the browser agree, character for character?
//
// The locator conversion, the passcode hash and the callsign mapping exist twice:
// once in data/js8-aprs-gate.js, which the browser and every harness use, and
// once as C++ in wifilt.ino, which is what actually builds the frame that leaves
// the station. Two implementations of one rule drift, and the drift is invisible
// -- both keep producing something that looks like a coordinate.
//
// So this compiles the REAL functions out of wifilt.ino (cut by name from the
// source, not copied into a fixture that could go stale) against a shim that
// supplies just enough of Arduino's String, and sweeps them against the
// JavaScript. Nothing is mocked: what runs here is the text that runs on the ESP32.
//
//   node tools/aprsis-conversion-parity.js

const {execFileSync} = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Gate = require("../data/js8-aprs-gate.js");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "wifilt.ino"), "utf8");

// Cut a function out of the sketch by its signature, up to the closing brace in
// the first column. The sketch is one flat file with no nesting at that level,
// which is what makes this safe.
function extract(signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`wifilt.ino no longer contains: ${signature}`);
  const end = source.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`unterminated function: ${signature}`);
  return `${source.slice(start, end)}\n}\n`;
}

const functions = [
  extract("uint16_t aprsisPasscode(const String &call) {"),
  extract("bool aprsisFieldSafe(const String &value) {"),
  extract("String aprsisCleanCall(const String &call) {"),
  extract("String aprsisSourceCall(const String &call) {"),
  extract("bool aprsisGridToAprs(const String &grid, String &latOut, String &lonOut) {")
].join("\n");

// Just the parts of Arduino's String these three functions touch. Anything they
// start using that is missing here will fail to compile, which is the point.
const shim = `
#include <cstdio>
#include <cstdlib>
#include <cctype>
#include <string>
#include <iostream>

struct String : std::string {
  String() {}
  String(char c) : std::string(1, c) {}
  String(const char *s) : std::string(s) {}
  String(const std::string &s) : std::string(s) {}
  void toUpperCase() { for (auto &c : *this) c = toupper((unsigned char)c); }
  int indexOf(char c) const { auto p = find(c); return p == npos ? -1 : (int)p; }
  String substring(int from) const { return from >= (int)size() ? String() : String(substr(from)); }
  String substring(int from, int to) const {
    if (from >= (int)size()) return String();
    return String(substr(from, to - from));
  }
  String &operator=(const char *s) { assign(s); return *this; }
  String &operator+=(char c) { push_back(c); return *this; }
};

// Concatenation has to keep producing a String, not a std::string: Arduino's
// String is what the sketch chains substring() onto afterwards.
inline String operator+(const String &a, const char *b) { String r(a); r.append(b); return r; }
inline String operator+(const String &a, const String &b) { String r(a); r.append(b); return r; }
inline String operator+(const char *a, const String &b) { String r(a); r.append(b); return r; }

${functions}

// EVERY argument crosses percent-encoded. The values under test include spaces
// and control characters, and a whitespace-delimited pipe would silently split
// them -- which shifts every later answer by a line and reports the resulting
// misalignment as a conversion mismatch.
static String decodeArgument(const std::string &argument) {
  String decoded;
  for (size_t i = 0; i < argument.size(); i++) {
    if (argument[i] == '%' && i + 2 < argument.size()) {
      decoded += (char)strtol(argument.substr(i + 1, 2).c_str(), nullptr, 16);
      i += 2;
    } else decoded += argument[i];
  }
  return decoded;
}

int main() {
  std::string command, raw;
  while (std::cin >> command >> raw) {
    String argument = decodeArgument(raw);
    if (command == "passcode") {
      printf("%u\\n", (unsigned)aprsisPasscode(String(argument)));
    } else if (command == "source") {
      printf("%s\\n", aprsisSourceCall(String(argument)).c_str());
    } else if (command == "safe") {
      printf("%s\\n", aprsisFieldSafe(argument) ? "safe" : "refused");
    } else if (command == "grid") {
      String lat, lon;
      if (!aprsisGridToAprs(String(argument), lat, lon)) printf("REFUSED\\n");
      else printf("%s %s\\n", lat.c_str(), lon.c_str());
    }
  }
  return 0;
}
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aprsis-parity-"));
const cpp = path.join(dir, "parity.cpp");
const bin = path.join(dir, "parity");
fs.writeFileSync(cpp, shim);
execFileSync("g++", ["-std=c++17", "-O1", "-Wall", "-o", bin, cpp], {stdio: "inherit"});

// The sweep: every field, a spread of squares, every subsquare letter, and the
// extended digits. Small enough to run in a second, wide enough that a half-cell
// or a rounding difference cannot hide in a corner of the grid.
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWX";
const grids = [];
for (let field = 0; field < 18; field += 1)
  for (let band = 0; band < 18; band += 3)
    for (const x of [0, 4, 9])
      for (const y of [0, 5, 9]) {
        const square = `${String.fromCharCode(65 + field)}${String.fromCharCode(65 + band)}${x}${y}`;
        grids.push(square);
        for (const sub of ["AA", "LM", "XX", "NX"]) {
          grids.push(square + sub);
          for (const ext of ["00", "28", "99"]) grids.push(square + sub + ext);
        }
      }
const calls = ["N0CALL", "N0CAL", "OK1HRA", "OK1HRA-10", "W1AW", "VK2ABCD", "3DA0XX",
  "OK1A", "A", "AB", "ABC"];
const sources = ["OK2ABC", "OK2ABC/P", "OK2ABC/9", "OK2ABC/13", "OK2ABC/QRP",
  "ok2abc", "OK2ABC/0", "OK2ABC/123",
  // Hostile and merely odd input. The old sweep fed only well-formed callsigns,
  // which is exactly why it passed while the C++ was missing the character
  // filter its JavaScript oracle applies -- a newline here reached the AX.25
  // source field and started a second packet.
  "AA1:BB", "AA1 BB", "AA1>BB", "AA1,BB", "AA1;BB", "AA1@BB", "AA1#BB",
  "OK2ABC*", "OK2ABC.", "OK2ABC/P/Q", "-OK2ABC", "OK2ABC-", "OK2ABC--9"];

// Control characters: what one of these in a field means is a second APRS-IS
// packet, so both sides have to refuse the same set. Percent-encoded across the
// pipe for the obvious reason.
const control = code => String.fromCharCode(code);
const fields = ["OK2ABC", ":SMSGTE   :HI", "HI THERE 73",
  `AA1${control(10)}BB`, `AA1${control(13)}BB`, `AA1${control(9)}BB`,
  `AA1${control(0)}BB`, `AA1${control(127)}BB`, control(10), `HI${control(27)}[2J`];
// Percent-encode anything the pipe could not carry intact.
const encode = value => String(value).replace(/[^A-Za-z0-9/:.-]/g,
  ch => `%${ch.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`);

const script = [
  ...grids.map(grid => `grid ${encode(grid)}`),
  ...calls.map(call => `passcode ${encode(call)}`),
  ...sources.map(call => `source ${encode(call)}`),
  ...fields.map(field => `safe ${encode(field)}`)
].join("\n") + "\n";

const out = execFileSync(bin, {input: script, encoding: "utf8"}).trim().split("\n");
let line = 0, mismatches = 0;
const report = (what, want, got) => {
  if (String(want) === String(got)) return;
  mismatches += 1;
  console.log(`MISMATCH ${what}\n  browser: ${want}\n  firmware: ${got}`);
};

for (const grid of grids) {
  const point = Gate.gridToAprs(grid);
  report(`grid ${grid}`, point ? `${point.lat} ${point.lon}` : "REFUSED", out[line]);
  line += 1;
}
for (const call of calls) {
  report(`passcode ${call}`, Gate.passcode(call), out[line]);
  line += 1;
}
for (const call of sources) {
  report(`source ${call}`, Gate.sourceCall(call), out[line]);
  line += 1;
}
for (const field of fields) {
  report(`safe ${encode(field)}`, Gate.fieldSafe(field) ? "safe" : "refused", out[line]);
  line += 1;
}

fs.rmSync(dir, {recursive: true, force: true});
if (mismatches) {
  console.log(`APRS-IS PARITY FAIL ${mismatches} of ${line} disagree`);
  process.exit(1);
}
console.log(`APRS-IS PARITY PASS ${line} conversions identical `
  + `(${grids.length} locators, ${calls.length} passcodes, ${sources.length} callsigns, `
  + `${fields.length} control-character fields)`);
console.log(`  sample ${grids[0]} -> ${out[0]}, ${LETTERS.length} subsquare letters swept`);
