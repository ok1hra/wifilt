#!/usr/bin/env node
"use strict";

// Test layer 1 of docs/wspr-majak-implementace.md: the WSPR Type 1 encoder
// against golden vectors produced by WSJT-X's own wsprcode.
//
// The fixtures in tools/fixtures/ are committed, so this runs without WSJT-X
// installed. Regenerate them with:  wsprcode "OK1HRA JN79 37" > tools/fixtures/...
//
// All four intermediate stages are compared, not just the final symbols: when
// only the interleaver breaks, the failure names the interleaver.

const fs = require("fs"), path = require("path");
const Wspr = require("../data/wspr-core.js");
// The Maidenhead arithmetic and the locator parser live here now: they served
// one input field, and that field moved to SETUP together with the identity.
const Identity = require("../data/station-identity.js");

const fixtures = path.join(__dirname, "fixtures");
let failures = 0, checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) return true;
  failures++;
  console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  return false;
}

function throws(name, fn, fragment) {
  checks++;
  try { fn(); } catch (error) {
    if (String(error.message).includes(fragment)) return true;
    failures++;
    console.error(`FAIL ${name}: message ${JSON.stringify(error.message)} lacks ${JSON.stringify(fragment)}`);
    return false;
  }
  failures++;
  console.error(`FAIL ${name}: expected a throw`);
  return false;
}

// ---- fixture parsing -------------------------------------------------------

function parseFixture(text) {
  const hex = /Hex:\s*([0-9A-Fa-f ]+)/.exec(text)[1].trim().split(/\s+/)
    .map(byte => parseInt(byte, 16));
  const block = label => {
    const match = new RegExp(`${label} symbols:\\n((?:\\s+[\\d ]+\\n)+)`).exec(text);
    return match[1].trim().split(/\s+/).map(Number);
  };
  return {hex, data: block("Data"), sync: block("Sync"), channel: block("Channel")};
}

// ---- golden vectors --------------------------------------------------------

for (const file of fs.readdirSync(fixtures).filter(name => name.endsWith(".txt")).sort()) {
  const text = fs.readFileSync(path.join(fixtures, file), "utf8");
  const [callsign, locator, powerDbm] = /Message:\s*(\S+)\s+(\S+)\s+(\S+)/.exec(text).slice(1);
  const expected = parseFixture(text);
  const result = Wspr.encode({callsign, locator, powerDbm: Number(powerDbm)});
  const label = `${callsign} ${locator} ${powerDbm}`;

  // wsprcode prints 7 bytes of the 11-byte packed message (50 bits + padding).
  check(`${label} packed`, Array.from(result.packed.slice(0, expected.hex.length)), expected.hex);
  check(`${label} sync`, Array.from({length: 162}, (_, i) => Wspr.syncBit(i)), expected.sync);
  check(`${label} data`, Array.from(result.dataBits), expected.data);
  check(`${label} channel`, Array.from(result.symbols), expected.channel);
  check(`${label} symbol count`, result.symbols.length, 162);
  check(`${label} symbol range`,
    Array.from(result.symbols).every(symbol => symbol >= 0 && symbol <= 3), true);
}

// ---- validation ------------------------------------------------------------

check("callsign trim/upcase", Wspr.normalizeCallsign(" ok1hra ").call, "OK1HRA");
check("callsign field alignment", Wspr.normalizeCallsign("K1ABC").field, " K1ABC");
check("callsign already aligned", Wspr.normalizeCallsign("OK1HRA").field, "OK1HRA");
throws("compound suffix refused", () => Wspr.normalizeCallsign("OK1HRA/P"), "Type 2");
throws("compound prefix refused", () => Wspr.normalizeCallsign("EA/OK1HRA"), "Type 2");
throws("empty callsign refused", () => Wspr.normalizeCallsign(""), "empty");

check("locator kept at six", Wspr.normalizeLocator("jn79qi").locator, "JN79QI");
check("locator transmitted at four", Wspr.normalizeLocator("JN79QI").transmitted, "JN79");
throws("five-character locator refused", () => Wspr.normalizeLocator("JN799"), "Maidenhead");
throws("out-of-range field refused", () => Wspr.normalizeLocator("ZZ99"), "Maidenhead");

check("legal power accepted", Wspr.normalizePower(37), 37);
throws("illegal power refused", () => Wspr.normalizePower(32), "legal WSPR power");
check("power levels complete", Wspr.POWER_LEVELS.length, 19);
check("power levels are n mod 10 in {0,3,7}",
  Wspr.POWER_LEVELS.every(dbm => [0, 3, 7].includes(dbm % 10)), true);

// ---- Maidenhead ------------------------------------------------------------

const grids = [
  ["Praha", 50.0755, 14.4378, "JO70FB"],
  ["Null Island", 0, 0, "JJ00AA"],
  ["Sydney", -33.8688, 151.2093, "QF56OD"],
  ["Reykjavik", 64.1466, -21.9426, "HP94AD"],
];
for (const [name, lat, lon, grid] of grids) {
  check(`grid ${name}`, Identity.latLonToGrid(lat, lon, 6), grid);
  check(`grid ${name} four`, Identity.latLonToGrid(lat, lon, 4), grid.slice(0, 4));
}
// Clamping, not wrapping: the poles and the date line must stay inside A..R.
check("grid at north pole", /^[A-R]{2}[0-9]{2}/.test(Identity.latLonToGrid(90, 180, 6)), true);
check("grid at south pole", /^[A-R]{2}[0-9]{2}/.test(Identity.latLonToGrid(-90, -180, 6)), true);
// A square boundary belongs to the square it opens, never the one it closes.
check("square boundary 16E", Identity.latLonToGrid(49.5, 16.0, 4), "JN89");
check("square boundary just under", Identity.latLonToGrid(49.5, 15.999, 4), "JN79");

// The parser moved with the arithmetic, into station-identity.js: there is one
// place a locator can be typed now, so there is one place that reads one. The
// refusals below are why -- they return null rather than "", because an
// unreadable locator is not an empty one, and storing it as empty is what wiped
// the station's square.
check("input: plain locator", Identity.parseLocator("jo70fb"), "JO70FB");
check("input: four-character locator", Identity.parseLocator("JN79"), "JN79");
check("input: comma coordinates", Identity.parseLocator("50.0755, 14.4378"), "JO70FB");
check("input: space coordinates", Identity.parseLocator("50.0755 14.4378"), "JO70FB");
check("input: negative coordinates", Identity.parseLocator("-33.8688,151.2093"), "QF56OD");
check("input: nonsense refused", Identity.parseLocator("5X, 14"), null);
check("input: bad subsquare refused", Identity.parseLocator("JO70FZ"), null);

// ---- slot planning ---------------------------------------------------------

const evenMinute = Date.UTC(2026, 6, 25, 12, 4, 0, 0);
check("slot from mid-frame", Wspr.nextSlotUtcMs(evenMinute - 40000), evenMinute + 1000);
check("slot never returns the past", Wspr.nextSlotUtcMs(evenMinute + 1000), evenMinute + 121000);
check("slot lands one second after an even minute",
  new Date(Wspr.nextSlotUtcMs(evenMinute + 5000)).getUTCSeconds(), 1);
check("slot minute is even",
  new Date(Wspr.nextSlotUtcMs(evenMinute + 5000)).getUTCMinutes() % 2, 0);

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exitCode = 1;
