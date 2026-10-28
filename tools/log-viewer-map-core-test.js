#!/usr/bin/env node
"use strict";

// log-viewer/src/map-core.js in node: where the map beside the GitHub Pages
// log puts each QSO and each transmitter, and where it thinks the sun is.
//
// The map itself (viewer-map.js) needs a browser and the internet; what it
// draws is decided here, so this is where the rules are checked -- over small
// made-up rows for the edge cases, and over the real 16k-QSO history for the
// "a VHF contest stays in Europe" promise.
//
//   node tools/log-viewer-map-core-test.js

const fs = require("fs"), path = require("path");

const root = path.resolve(__dirname, "..");
global.window = global;
require(path.join(root, "data", "dxcc.js"));
const M = require(path.join(root, "log-viewer", "src", "map-core.js"));

const checks = [];
const check = (name, ok, detail) => checks.push([name, !!ok, detail]);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A row the way viewer.js builds it, as far as the map reads one.
const row = (call, extra) => Object.assign({
  call, loc: "", exch: "", d: DXCC.lookupDxcc(call) || {}, logId: "A",
}, extra || {});
const LOGS = {
  A: { id: "A", stationCall: "OK1HRA", myLocator: "JO60NA" },
  B: { id: "B", stationCall: "OK5Z", myLocator: "JN79US" },
  C: { id: "C", stationCall: "OK1HRA", myLocator: "JO60NA" },
  N: { id: "N", stationCall: "OK1OEA", myLocator: "" },
};

// ── where a QSO is
{
  const p = M.locate(row("W3LPL", { loc: "FM19LG", exch: "PA" }));
  check("a received locator wins over the state", p && p.kind === "loc" && p.key === "L:FM19LG");
  const s = M.locate(row("W3LPL", { exch: "PA" }));
  check("PA from a US call is Pennsylvania", s && s.kind === "state" && s.key === "S:US-PA", s && s.key);
  const dl = M.locate(row("DL1ABC", { exch: "PA" }));
  check("PA from a German call is just Germany", dl && dl.kind === "dxcc" && dl.key === "D:Germany", dl && dl.key);
  const ve = M.locate(row("VE3XYZ", { exch: "4 ON" }));
  check("'4 ON' from a Canadian call is Ontario", ve && ve.key === "S:VE-ON", ve && ve.key);
  const pq = M.locate(row("VE2XYZ", { exch: "PQ" }));
  check("the old PQ is the same point as QC", pq && pq.key === "S:VE-QC", pq && pq.key);
  const zone = M.locate(row("K1ABC", { exch: "5" }));
  check("a CQ zone from a US call is the middle of the USA", zone && zone.key === "D:USA");
  const bad = M.locate(row("OK1ABC", { loc: "599" }));
  check("a locator that is not one falls back to DXCC", bad && bad.key === "D:Czech Republic", bad && bad.key);
  const four = M.locate(row("OK1ABC", { loc: "jo70" }));
  check("a four-character locator is a point of its own", four && four.key === "L:JO70");
  check("no DXCC, no place", M.locate({ call: "XX", loc: "", exch: "", d: {} }) === null);
  check("locator normalisation cuts to six", M.normLocator("jo60na12") === "JO60NA");
}

// ── where a log was transmitted from
{
  const a = M.siteOf(LOGS.A, "");
  check("a log's locator is its site", a && !a.approx && a.key === "L:JO60NA");
  const n = M.siteOf(LOGS.N, "");
  check("no locator: the middle of the own call's country, approximate",
        n && n.approx && n.key === "D:Czech Republic");
  const o = M.siteOf(LOGS.N, "JO70FD");
  check("no locator but one given on the page: that one, exact", o && !o.approx && o.key === "L:JO70FD");
  const keep = M.siteOf(LOGS.A, "JO70FD");
  check("a locator given on the page does not override the log's own", keep.key === "L:JO60NA");
}

// ── aggregation
{
  const rows = [
    row("W3LPL", { exch: "PA" }), row("K3ZO", { exch: "MD" }), row("N3AD", { exch: "PA" }),
    row("W3LPL", { exch: "PA", logId: "B" }),
    row("JA1ABC", { exch: "25" }), row("JA2XYZ", { exch: "25" }),
    row("OK2BBB", { loc: "JN89AA", logId: "C" }),
    { call: "XX", loc: "", exch: "", d: {}, logId: "A" },
  ];
  const agg = M.aggregate(rows, LOGS, "");
  check("two locators, two sites; two logs at one locator, one site", agg.sites.length === 2,
        agg.sites.map(s => s.key).join(","));
  const pa = agg.points.find(p => p.key === "S:US-PA");
  check("one point per state, counting every QSO", pa && pa.n === 3 && pa.calls.join() === "W3LPL,N3AD",
        pa && pa.n + " " + pa.calls);
  const siteA = agg.sites.findIndex(s => s.key === "L:JO60NA");
  const linkPa = agg.links.find(l => l.site === siteA && agg.points[l.point].key === "S:US-PA");
  check("the line to a state carries its QSO count", linkPa && linkPa.n === 2, linkPa && linkPa.n);
  const ja = agg.points.find(p => p.key === "D:Japan");
  check("the line to a DXCC carries its QSO count", ja && agg.links.find(l => l.point === agg.points.indexOf(ja)).n === 2);
  check("a QSO with no place is counted, not drawn", agg.unplaced === 1);
  check("the site with most QSOs gives the reference longitude", near(agg.ref, M.siteOf(LOGS.A).lon, 1e-9));
}

// ── the antimeridian
{
  const rows = [row("JA1ABC"), row("W6ABC", { exch: "CA" }), row("KH6ABC"), row("ZL1ABC")];
  const agg = M.aggregate(rows, LOGS, "");
  const b = M.bounds(agg);
  check("JA, W6, KH6 and ZL from Europe are not torn at the antimeridian",
        b && b.east - b.west <= 360 && agg.points.every(p => Math.abs(p.lonU - agg.ref) <= 180),
        b && JSON.stringify(b));
  const gc = M.greatCircle({ lat: 35, lon: 139 }, { lat: 37, lon: -120 });
  const jumps = gc.slice(1).some((p, i) => Math.abs(p[1] - gc[i][1]) > 10);
  check("a great circle across the Pacific runs on without a jump", !jumps && gc[gc.length - 1][1] > 180,
        gc[gc.length - 1].map(x => x.toFixed(1)).join(","));
  const mid = gc[Math.floor(gc.length / 2)];
  check("and bends north of both ends, as a great circle does", mid[0] > 45, mid[0].toFixed(1));
}

// ── the real history: a VHF contest stays where it was
{
  const hist = JSON.parse(fs.readFileSync(path.join(root, "ic705-history-backup.json"), "utf8")).stores;
  const logs = {};
  hist.logs.forEach(l => { logs[l.id] = l; });
  const all = hist.qso.map(q => ({
    call: String(q.call || "").toUpperCase(), loc: String(q.locatorReceived || "").toUpperCase(),
    exch: q.exchangeReceived || "", d: q.dxcc || DXCC.lookupDxcc(String(q.call || "")) || {}, logId: q.logId,
  }));
  const vhf = all.filter(r => r.logId === "2023-09-02-IARU-R1-144MHZ");
  const b = M.bounds(M.aggregate(vhf, logs, ""));
  check("IARU R1 144 MHz stays in Europe", b && b.south > 40 && b.north < 60 && b.west > -10 && b.east < 30,
        JSON.stringify(b));
  const t0 = process.hrtime.bigint();
  const agg = M.aggregate(all, logs, "");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check("the whole history aggregates quickly", ms < 150, ms.toFixed(0) + " ms, " + agg.points.length + " points");
  const arrl = agg.points.filter(p => p.kind === "state").length;
  check("the ARRL DX logs place QSOs in states", arrl > 40, arrl + " states/provinces");
  check("every history log without a locator has an approximate site",
        agg.sites.length >= 1 && agg.sites.every(s => s.approx), agg.sites.map(s => s.key).join(","));
}

// ── the sun
{
  // 2026 March equinox: 20 March 14:46 UTC. At 12:00 UTC the declination is
  // a few hundredths of a degree south, and with the equation of time at
  // about -7.5 min the sun crosses Greenwich only at 12:07 -- it is still
  // about 1.9 degrees east.
  const s = M.subsolar(new Date("2026-03-20T12:00:00Z"));
  check("equinox noon: the sun is over the equator", near(s.lat, 0, 0.1), s.lat.toFixed(3));
  check("equinox noon: and 1.9 degrees east of Greenwich", near(s.lon, 1.9, 0.3), s.lon.toFixed(3));
  const j = M.subsolar(new Date("2026-06-21T12:00:00Z"));
  check("June solstice: over the Tropic of Cancer", near(j.lat, 23.44, 0.1), j.lat.toFixed(3));
  const d = M.subsolar(new Date("2026-12-21T00:00:00Z"));
  check("December solstice, midnight UTC: the Tropic of Capricorn, the Pacific",
        near(d.lat, -23.44, 0.1) && Math.abs(d.lon) > 175, d.lat.toFixed(2) + "," + d.lon.toFixed(2));
  check("altitude is 90 under the sun", near(M.sunAltitude(s, s.lat, s.lon), 90, 1e-6));
  check("and 0 a quarter of the world away", near(M.sunAltitude(s, 0, s.lon + 90), 0, 1e-6));
  check("and -90 opposite", near(M.sunAltitude(s, -s.lat, s.lon + 180), -90, 1e-6));
}

const failed = checks.filter(c => !c[1]);
for (const [name, ok, detail] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail != null && detail !== "" ? " -- " + detail : ""}`);
const line = `MAP CORE ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
(failed.length ? console.error : console.log)(line);
if (failed.length) process.exitCode = 1;
