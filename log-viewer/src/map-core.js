'use strict';
/**
 * map-core.js — where the QSOs of the log viewer are, without any drawing
 *
 * The map beside the log (viewer-map.js) draws what this works out from the
 * rows the filters leave. Kept apart, with no DOM, so node can test it
 * (tools/log-viewer-map-core-test.js). In short:
 *
 *   - a QSO is where its received locator says; failing that, in the US state
 *     or Canadian province its exchange names (ARRL DX: "PA", "4 ON"); failing
 *     that, in the middle of its DXCC country;
 *   - the transmitter is where its log's locator says. A log without one sits
 *     in the middle of its own call's country, marked approximate, unless the
 *     page was given a locator for such logs;
 *   - QSOs at one place are one point; a line joins a site and a point and
 *     carries how many QSOs it stands for;
 *   - longitudes are unwrapped around the busiest site, so a log from Europe to
 *     JA and W6 is not torn apart at the antimeridian;
 *   - the sun: where it stands overhead, and how high it is anywhere else.
 *
 * Needs DXCC (data/dxcc.js) for locators and the DXCC of a site.
 */
(function (root, factory) {
  var value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.MapCore = value;
}(typeof globalThis !== 'undefined' ? globalThis : self, function () {

  var D2R = Math.PI / 180, R2D = 180 / Math.PI, EARTH_KM = 6371;

  // Roughly the middle of each state and province -- where its QSOs gather.
  // The two big provinces sit a little south of their geographic centre,
  // among their stations rather than in the tundra.
  var REGIONS = {
    USA: {
      AL: [32.8, -86.8], AK: [64.0, -152.0], AZ: [34.3, -111.7], AR: [34.9, -92.4], CA: [37.2, -119.5],
      CO: [39.0, -105.5], CT: [41.6, -72.7], DE: [39.0, -75.5], DC: [38.9, -77.0], FL: [28.6, -82.4],
      GA: [32.7, -83.4], HI: [20.8, -156.3], ID: [44.4, -114.6], IL: [40.0, -89.2], IN: [39.9, -86.3],
      IA: [42.1, -93.5], KS: [38.5, -98.4], KY: [37.5, -85.3], LA: [31.1, -92.0], ME: [45.4, -69.2],
      MD: [39.0, -76.8], MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3], MS: [32.7, -89.7],
      MO: [38.4, -92.5], MT: [47.0, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6], NH: [43.7, -71.6],
      NJ: [40.2, -74.7], NM: [34.4, -106.1], NY: [42.9, -75.5], NC: [35.6, -79.4], ND: [47.5, -100.5],
      OH: [40.3, -82.8], OK: [35.6, -97.5], OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.5],
      SC: [33.9, -80.9], SD: [44.4, -100.2], TN: [35.9, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7],
      VT: [44.1, -72.7], VA: [37.5, -78.9], WA: [47.4, -120.5], WV: [38.6, -80.6], WI: [44.6, -89.9],
      WY: [43.0, -107.6],
    },
    Canada: {
      NL: [48.9, -55.9], NF: [48.9, -55.9], LB: [53.5, -62.0], NS: [45.0, -63.0], PE: [46.4, -63.2],
      NB: [46.6, -66.5], QC: [49.0, -72.0], PQ: [49.0, -72.0], ON: [47.5, -83.0], MB: [53.8, -98.8],
      SK: [54.0, -106.0], AB: [54.5, -115.0], BC: [53.7, -124.8], YT: [64.3, -135.0], NT: [64.8, -119.0],
      NU: [66.0, -95.0],
    },
  };
  var REGION_PREFIX = { USA: 'US', Canada: 'VE' };
  // Old names that mean the same place: one point, one label.
  var REGION_ALIAS = { NF: 'NL', PQ: 'QC' };

  var LOC_RE = /^[A-R]{2}[0-9]{2}(?:[A-X]{2})?/;

  function dxcc() { return (typeof DXCC !== 'undefined' && DXCC) || null; }

  // The grid square of a locator, cut to what it can be trusted for: six
  // characters, or four. Anything else is not a locator.
  function normLocator(loc) {
    var m = LOC_RE.exec(String(loc || '').trim().toUpperCase());
    return m ? m[0] : '';
  }

  function locatorPos(loc) {
    var l = normLocator(loc), D = dxcc();
    return l && D ? D.locatorToLatLon(l) : null;
  }

  function regionOf(country, exch) {
    var table = REGIONS[country];
    if (!table) return null;
    var tokens = String(exch || '').toUpperCase().split(/[^A-Z0-9]+/);
    for (var i = 0; i < tokens.length; i++) {
      if (table[tokens[i]]) {
        var code = REGION_ALIAS[tokens[i]] || tokens[i];
        return { code: code, lat: table[code][0], lon: table[code][1] };
      }
    }
    return null;
  }

  // row: { call, loc, exch, d: {country, latitude, longitude} }
  function locate(row) {
    var loc = normLocator(row.loc);
    if (loc) {
      var p = locatorPos(loc);
      if (p) return { key: 'L:' + loc, kind: 'loc', lat: p.lat, lon: p.lon, label: loc };
    }
    var d = row.d || {};
    var reg = regionOf(d.country, row.exch);
    if (reg) {
      return { key: 'S:' + REGION_PREFIX[d.country] + '-' + reg.code, kind: 'state', lat: reg.lat, lon: reg.lon,
               label: reg.code, country: d.country };
    }
    if (d.country && d.latitude != null && d.longitude != null) {
      return { key: 'D:' + d.country, kind: 'dxcc', lat: d.latitude, lon: d.longitude, label: d.country,
               country: d.country, prefix: d.mainPrefix || '' };
    }
    return null;
  }

  // Where a log was transmitted from. myloc: the locator the page was given
  // for logs that have none.
  function siteOf(log, myloc) {
    log = log || {};
    var call = String(log.stationCall || '').toUpperCase();
    var loc = normLocator(log.myLocator) || normLocator(myloc);
    if (loc) {
      var p = locatorPos(loc);
      if (p) return { key: 'L:' + loc, lat: p.lat, lon: p.lon, loc: loc, approx: false, call: call };
    }
    var D = dxcc(), d = D && call ? D.lookupDxcc(call) : null;
    if (d && d.latitude != null) {
      return { key: 'D:' + d.country, lat: d.latitude, lon: d.longitude, loc: '', approx: true, call: call,
               country: d.country };
    }
    return null;
  }

  // Unwrap lon to within 180 degrees of ref.
  function unwrap(lon, ref) {
    while (lon - ref > 180) lon -= 360;
    while (lon - ref < -180) lon += 360;
    return lon;
  }

  /**
   * rows: [{ call, loc, exch, d, logId, ... }] -- the rows the filters leave.
   * logsById: { id: log }.  myloc: locator for logs without one ('' = none).
   *
   * -> { sites: [{key, lat, lon, lonU, loc, approx, calls: [], n}],
   *      points: [{key, kind, lat, lon, lonU, label, calls: [], n, rows: []}],
   *      links: [{site, point, n}],   // indices into sites / points
   *      unplaced: n,                 // QSOs with no place at all
   *      ref: the longitude everything is unwrapped around }
   */
  function aggregate(rows, logsById, myloc) {
    var siteByLog = {}, sites = [], siteIdx = {}, points = [], pointIdx = {}, links = [], linkIdx = {};
    var unplaced = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var pos = locate(r);
      if (!pos) { unplaced++; continue; }
      var pi = pointIdx[pos.key];
      if (pi == null) {
        pi = pointIdx[pos.key] = points.length;
        pos.calls = []; pos.callSet = {}; pos.n = 0; pos.rows = [];
        points.push(pos);
      }
      var pt = points[pi];
      pt.n++;
      pt.rows.push(r);
      if (!pt.callSet[r.call]) { pt.callSet[r.call] = true; pt.calls.push(r.call); }

      if (!(r.logId in siteByLog)) siteByLog[r.logId] = siteOf(logsById && logsById[r.logId], myloc);
      var s = siteByLog[r.logId];
      if (!s) continue;
      var si = siteIdx[s.key];
      if (si == null) {
        si = siteIdx[s.key] = sites.length;
        sites.push({ key: s.key, lat: s.lat, lon: s.lon, loc: s.loc, approx: s.approx, calls: [], callSet: {}, n: 0 });
      }
      var st = sites[si];
      st.n++;
      if (s.call && !st.callSet[s.call]) { st.callSet[s.call] = true; st.calls.push(s.call); }
      var lk = si + '|' + pi;
      if (linkIdx[lk] == null) { linkIdx[lk] = links.length; links.push({ site: si, point: pi, n: 0 }); }
      links[linkIdx[lk]].n++;
    }
    points.forEach(function (p) { delete p.callSet; });
    sites.forEach(function (s) { delete s.callSet; });

    var ref = 0, best = -1;
    sites.forEach(function (s) { if (s.n > best) { best = s.n; ref = s.lon; } });
    if (!sites.length && points.length) ref = points[0].lon;
    sites.forEach(function (s) { s.lonU = unwrap(s.lon, ref); });
    points.forEach(function (p) { p.lonU = unwrap(p.lon, ref); });
    return { sites: sites, points: points, links: links, unplaced: unplaced, ref: ref };
  }

  // The box around everything there is to see, in unwrapped longitudes.
  // null when there is nothing.
  function bounds(agg) {
    var s = -90, n = 90, w = 0, e = 0, any = false;
    function add(lat, lon) {
      if (!any) { s = n = lat; w = e = lon; any = true; return; }
      if (lat < s) s = lat; if (lat > n) n = lat;
      if (lon < w) w = lon; if (lon > e) e = lon;
    }
    agg.sites.forEach(function (x) { add(x.lat, x.lonU); });
    agg.points.forEach(function (x) { add(x.lat, x.lonU); });
    return any ? { south: s, west: w, north: n, east: e } : null;
  }

  function distanceKm(lat1, lon1, lat2, lon2) {
    var p1 = lat1 * D2R, p2 = lat2 * D2R, dp = p2 - p1, dl = (lon2 - lon1) * D2R;
    var a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * EARTH_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function maxDistanceKm(center, agg) {
    var m = 0;
    agg.points.forEach(function (p) { m = Math.max(m, distanceKm(center.lat, center.lon, p.lat, p.lon)); });
    agg.sites.forEach(function (p) { m = Math.max(m, distanceKm(center.lat, center.lon, p.lat, p.lon)); });
    return m;
  }

  function toVec(lat, lon) {
    var p = lat * D2R, l = lon * D2R;
    return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  }

  // The great circle from a to b ({lat, lon}) as [[lat, lon], ...]. The
  // longitudes run on continuously from a.lon, past +-180 if they must, so
  // Leaflet draws one unbroken line.
  function greatCircle(a, b) {
    var va = toVec(a.lat, a.lon), vb = toVec(b.lat, b.lon);
    var dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
    var om = Math.acos(dot);
    var out = [[a.lat, a.lon]];
    if (om < 1e-9) { out.push([b.lat, a.lon + (unwrap(b.lon, a.lon) - a.lon)]); return out; }
    var steps = Math.max(2, Math.ceil(om * R2D / 2)), so = Math.sin(om), prev = a.lon;
    for (var i = 1; i <= steps; i++) {
      var t = i / steps, k1 = Math.sin((1 - t) * om) / so, k2 = Math.sin(t * om) / so;
      var x = k1 * va[0] + k2 * vb[0], y = k1 * va[1] + k2 * vb[1], z = k1 * va[2] + k2 * vb[2];
      var lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * R2D;
      var lon = unwrap(Math.atan2(y, x) * R2D, prev);
      out.push([lat, lon]);
      prev = lon;
    }
    return out;
  }

  // ── the sun ─────────────────────────────────────────────────────────────────

  // Where the sun is overhead at date: {lat, lon}. The low-precision almanac
  // formula (about 0.01 degree), plenty for a grey line drawn on a map.
  function subsolar(date) {
    var n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
    var L = (280.460 + 0.9856474 * n) % 360;
    var g = (357.528 + 0.9856003 * n) % 360 * D2R;
    var lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
    var eps = (23.439 - 0.0000004 * n) * D2R;
    var dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
    var ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) * R2D;
    var gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    var lon = ((ra - gmst * 15) % 360 + 540) % 360 - 180;
    return { lat: dec * R2D, lon: lon };
  }

  // How high the sun stands (degrees, negative below the horizon) at lat/lon
  // when it is overhead at sun ({lat, lon}, from subsolar).
  function sunAltitude(sun, lat, lon) {
    var p = lat * D2R, d = sun.lat * D2R, h = (lon - sun.lon) * D2R;
    var s = Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(h);
    return Math.asin(Math.max(-1, Math.min(1, s))) * R2D;
  }

  return {
    REGIONS: REGIONS,
    normLocator: normLocator,
    locate: locate,
    siteOf: siteOf,
    aggregate: aggregate,
    bounds: bounds,
    distanceKm: distanceKm,
    maxDistanceKm: maxDistanceKm,
    greatCircle: greatCircle,
    subsolar: subsolar,
    sunAltitude: sunAltitude,
    unwrap: unwrap,
  };
}));
