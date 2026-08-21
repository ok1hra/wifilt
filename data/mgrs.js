// WGS84 latitude/longitude -> MGRS (Military Grid Reference System).
//
// The GPS panel already shows Locator, Latitude and Longitude off the same
// /gps fix; MGRS is a second, unrelated way to write the identical point, so
// it lives here as pure math with no state of its own -- same shape as
// station-identity.js's latLonToGrid, testable from Node without a browser.
//
// The projection is the standard Transverse Mercator series (Snyder, "Map
// Projections: A Working Manual", USGS PP 1395) evaluated on the WGS84
// ellipsoid at k0 = 0.9996 -- the formulas GPS receivers, GEOTRANS and every
// other MGRS tool use, so a value read off this panel matches a value read
// off a paper map or another GPS unit digit for digit. UTM zone numbering
// keeps the two documented exceptions to the plain 6-degree grid (Norway,
// Svalbard) so a station operating from those coastlines does not land on
// the wrong side of a zone seam. Outside 80 S - 84 N, MGRS switches to a
// different (polar, UPS) grid that this module does not implement -- a
// station up there gets null back, same as any other field the radio has
// no answer for.

(function (root) {
  "use strict";

  // MGRS 100 km square letters skip I and O everywhere (too easily mistaken
  // for 1 and 0). Columns cycle through 24 letters (A-Z minus I,O) and reset
  // every 3rd UTM zone; rows cycle through 20 letters (A-V minus I,O) and
  // repeat every 2000 km of northing. SET_ORIGIN_*_LETTERS gives the letter
  // at the southwest corner of zone-set 1..6 (zone number mod 6, 0 -> 6).
  var A = 65, I = 73, O = 79, V = 86, Z = 90;
  var SET_ORIGIN_COLUMN_LETTERS = "AJSAJS";
  var SET_ORIGIN_ROW_LETTERS = "AFAFAF";

  var ECC_SQUARED       = 0.00669438; // WGS84 first eccentricity squared
  var SCALE_FACTOR      = 0.9996;     // UTM central-meridian scale, k0
  var SEMI_MAJOR_AXIS   = 6378137;    // WGS84 a, metres
  var EASTING_OFFSET    = 500000;     // false easting at the central meridian
  var NORTHING_OFFSET   = 10000000;   // false northing added south of the equator
  var UTM_ZONE_WIDTH    = 6;          // degrees
  var HALF_UTM_ZONE_WIDTH = UTM_ZONE_WIDTH / 2;

  function degToRad(deg) { return deg * (Math.PI / 180); }

  // The 6-degree zone grid with its two standard exceptions: on the
  // southwest coast of Norway zone 32 is widened 3 degrees west at the cost
  // of zone 31 (band V, 56-64 N); around Svalbard zones 32/34/36 are dropped
  // in favour of four widened neighbours 31/33/35/37 (band X, 72-84 N).
  function utmZoneNumber(lat, lon) {
    var zone = Math.floor((lon + 180) / 6) + 1;
    if (lon === 180) zone = 60;
    if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
    if (lat >= 72 && lat < 84) {
      if (lon >= 0 && lon < 9) zone = 31;
      else if (lon >= 9 && lon < 21) zone = 33;
      else if (lon >= 21 && lon < 33) zone = 35;
      else if (lon >= 33 && lon < 42) zone = 37;
    }
    return zone;
  }

  // Latitude bands are lettered C through X (8 degrees each, skipping I and
  // O), except the top band X, which runs 12 degrees to close the grid at
  // 84 N. Outside 80 S - 84 N there is no band letter -- that is UPS
  // territory -- so the caller sees null.
  function latBand(lat) {
    if (lat > 84 || lat < -80) return null;
    if (lat >= 72) return "X";
    var bandLetters = "CDEFGHJKLMNPQRSTUVWX";
    return bandLetters.charAt(Math.floor((lat + 80) / 8));
  }

  // Forward Transverse Mercator, truncated (not rounded) to whole metres --
  // MGRS always reads as the square a point falls IN, never the nearest
  // grid line, same as the firmware's Maidenhead locator.
  function llToUtm(lat, lon) {
    var a = SEMI_MAJOR_AXIS;
    var latRad = degToRad(lat), lonRad = degToRad(lon);
    var zone = utmZoneNumber(lat, lon);
    var lonOrigin = (zone - 1) * UTM_ZONE_WIDTH - 180 + HALF_UTM_ZONE_WIDTH;
    var lonOriginRad = degToRad(lonOrigin);

    var e2 = ECC_SQUARED, e4 = e2 * e2, e6 = e4 * e2;
    var eccPrimeSq = e2 / (1 - e2);
    var sinLat = Math.sin(latRad), cosLat = Math.cos(latRad), tanLat = Math.tan(latRad);
    var N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    var T = tanLat * tanLat;
    var C = eccPrimeSq * cosLat * cosLat;
    var M0 = cosLat * (lonRad - lonOriginRad); // called "A" in Snyder

    var M = a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * latRad
      - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * latRad)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * latRad)
      - (35 * e6 / 3072) * Math.sin(6 * latRad));

    var easting = SCALE_FACTOR * N * (M0
      + (1 - T + C) * Math.pow(M0, 3) / 6
      + (5 - 18 * T + T * T + 72 * C - 58 * eccPrimeSq) * Math.pow(M0, 5) / 120) + EASTING_OFFSET;

    var northing = SCALE_FACTOR * (M + N * tanLat * (M0 * M0 / 2
      + (5 - T + 9 * C + 4 * C * C) * Math.pow(M0, 4) / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * eccPrimeSq) * Math.pow(M0, 6) / 720));
    if (lat < 0) northing += NORTHING_OFFSET;

    return {easting: Math.trunc(easting), northing: Math.trunc(northing), zone: zone};
  }

  function get100kSet(zone) {
    var set = zone % 6;
    return set === 0 ? 6 : set;
  }

  // Walk `steps` letters forward from `originCode` through the MGRS
  // alphabet (I and O never occur), wrapping past `cap` back to A. Columns
  // and rows are the same walk with a different cap (Z vs V) and origin.
  function walkLetters(originCode, steps, cap) {
    var code = originCode, n;
    for (n = 0; n < steps; n++) {
      code++;
      if (code === I || code === O) code++;
      if (code > cap) code = A + (code - cap - 1);
    }
    return code;
  }

  function letter100k(easting, northing, zone) {
    var set = get100kSet(zone);
    var colSteps = Math.floor(easting / 100000) - 1; // column letters are 1-based
    var rowSteps = Math.floor(northing / 100000) % 20;
    var col = walkLetters(SET_ORIGIN_COLUMN_LETTERS.charCodeAt(set - 1), colSteps, Z);
    var row = walkLetters(SET_ORIGIN_ROW_LETTERS.charCodeAt(set - 1), rowSteps, V);
    return String.fromCharCode(col) + String.fromCharCode(row);
  }

  // digits: how many easting/northing digits to keep per axis (0-5; 5 = 1 m,
  // the panel's own choice). Returns null wherever there is no MGRS answer:
  // outside 80 S - 84 N, the same shape as a GPS field the radio left blank.
  function latLonToMgrs(lat, lon, digits) {
    if (typeof digits !== "number") digits = 5;
    var band = latBand(lat);
    if (band === null || !isFinite(lat) || !isFinite(lon)) return null;

    var utm = llToUtm(lat, lon);
    var square = letter100k(utm.easting, utm.northing, utm.zone);
    var eastingStr = ("00000" + (utm.easting % 100000)).slice(-5).slice(0, digits);
    var northingStr = ("00000" + (utm.northing % 100000)).slice(-5).slice(0, digits);
    return utm.zone + band + square + eastingStr + northingStr;
  }

  var api = {
    latLonToMgrs: latLonToMgrs,
    utmZoneNumber: utmZoneNumber,
    latBand: latBand
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Mgrs = api;
}(typeof globalThis !== "undefined" ? globalThis : self));
