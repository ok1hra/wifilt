// GPS panel MGRS row -- correctness of the WGS84 -> MGRS conversion itself,
// checked against known-good values rather than against a radio.
//
// The first three checks are verbatim reference vectors from proj4js/mgrs
// (MIT), a widely used, independently tested port of the same NGA/USNG
// algorithm this module implements -- they pin the Transverse Mercator
// series and the 100 km square lettering at once. The zone-boundary checks
// pin the two documented exceptions to the plain 6-degree UTM grid (Norway,
// Svalbard) against the boundary degrees given for them on Wikipedia's UTM
// article, independently of the digit math above.

const path = require("path");
const ROOT = path.join(__dirname, "..");
const Mgrs = require(path.join(ROOT, "data", "mgrs.js"));

const failures = [];
function check(name, ok) { if (!ok) failures.push(name); }

// ---- reference vectors (proj4js/mgrs test suite) ---------------------------
check("Vienna, full 1 m precision",
  Mgrs.latLonToMgrs(48.24949, 16.41450, 5) === "33UXP0500444997");
check("Las Vegas area, full 1 m precision",
  Mgrs.latLonToMgrs(36.2361322, -115.0820944, 5) === "11SPA7234911844");
check("equator / prime meridian, northing all zeros",
  Mgrs.latLonToMgrs(0, 0, 5) === "31NAA6602100000");
check("one hundred-thousandth of a degree north of the equator moves the northing by 1 m",
  Mgrs.latLonToMgrs(0.00001, 0, 5) === "31NAA6602100001");
check("high-arctic point at reduced (100 m) precision",
  Mgrs.latLonToMgrs(83.62778, -32.66433, 3) === "25XEN041865");

// ---- zone number exceptions -------------------------------------------------
// Norway: band V (56-64 N) shrinks zone 31 to 0-3 E and widens zone 32 to
// 3-12 E, three degrees further west than the plain grid would give it.
check("Norway: just west of the shrunk zone 31/32 seam stays zone 31",
  Mgrs.utmZoneNumber(61, 2.9) === 31);
check("Norway: just east of the seam is pulled into the widened zone 32",
  Mgrs.utmZoneNumber(61, 3.1) === 32);
check("Norway: a point that would naively be zone 31 is really zone 32",
  Mgrs.utmZoneNumber(61, 4.5) === 32);
check("outside band V the plain grid applies even at the same longitude",
  Mgrs.utmZoneNumber(50, 4.5) === 31);

// Svalbard: band X (72-84 N) drops zones 32/34/36 for four widened
// neighbours: 31 (0-9 E), 33 (9-21 E), 35 (21-33 E), 37 (33-42 E).
check("Svalbard: just west of the 31/33 seam stays zone 31",
  Mgrs.utmZoneNumber(78, 8.9) === 31);
check("Svalbard: just east of the seam is pulled into zone 33 (32X does not exist)",
  Mgrs.utmZoneNumber(78, 9.1) === 33);
check("Svalbard: a point that would naively be zone 32 is really zone 33",
  Mgrs.utmZoneNumber(78, 9.5) === 33);
check("Svalbard: the 33/35 seam",
  Mgrs.utmZoneNumber(78, 21.5) === 35);
check("Svalbard: the 35/37 seam",
  Mgrs.utmZoneNumber(78, 33.5) === 37);
check("outside band X the plain grid applies even at the same longitude",
  Mgrs.utmZoneNumber(50, 9.5) === 32);

// ---- polar cutoff ------------------------------------------------------------
check("just above 84 N has no MGRS band", Mgrs.latBand(84.1) === null);
check("84 N itself is still band X", Mgrs.latBand(84) === "X");
check("just below 80 S has no MGRS band", Mgrs.latBand(-80.1) === null);
check("80 S itself is still band C", Mgrs.latBand(-80) === "C");
check("a point above 84 N converts to null, not a wrong answer",
  Mgrs.latLonToMgrs(84.5, 10, 5) === null);
check("a point below 80 S converts to null, not a wrong answer",
  Mgrs.latLonToMgrs(-80.5, 10, 5) === null);

const total = 20;
if (failures.length) {
  console.error("MGRS FAIL (" + failures.length + " of " + total + ")\n  " + failures.join("\n  "));
  process.exitCode = 1;
} else {
  console.log("MGRS PASS " + total + " checks");
}
