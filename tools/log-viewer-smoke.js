#!/usr/bin/env node
"use strict";

// The GitHub Pages log viewer (log-viewer/index.html, as built), in headless
// Chrome, over the real history: the 16 027 QSOs of ic705-history-backup.json
// turned into the file GIT LOG SYNC writes, plus a handful of QSOs made for
// the edge cases (12m/2m/20m, USB/LSB, a deleted one, a far one).
//
// The size is the point as much as the rules: a filter that answers in a blink
// over twenty rows can take seconds over sixteen thousand, and a table that
// renders every row would not scroll at all.
//
//   node tools/log-viewer-smoke.js

const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const core = require(path.join(root, "data", "log-git-sync.js"));

// ── the fixture: the history as GIT LOG SYNC would push it
const hist = JSON.parse(fs.readFileSync(path.join(root, "ic705-history-backup.json"), "utf8"));
const DEV = "aaaaaaaa-0000-4000-8000-0000000000aa";
const LOG = "2026-10-02-SMOKE";
hist.stores.logs.push({ id: LOG, contestName: "SMOKE TEST", stationCall: "OK1HRA", myLocator: "JO60NA",
                        createdAtUtc: "2026-10-02T08:00:00.000Z", updatedAtUtc: "2026-10-02T08:00:00.000Z", nextQsoNumber: 9 });
const mk = (id, call, hz, mode, extra) => Object.assign({ id, logId: LOG, qsoNumber: id, call,
  qsoDateUtc: "2026-10-02", timeOnUtc: "09:" + String(id).padStart(2, "0"),
  timestampUtc: "2026-10-02T09:" + String(id).padStart(2, "0") + ":00.000Z", rstSent: "599", rstReceived: "599",
  exchangeReceived: "", frequencyHz: hz, frequencyDisplay: "", mode, trx: "TRX1", dxcc: null, locatorReceived: "",
  createdAtUtc: "2026-10-02T09:00:00.000Z" }, extra || {});
hist.stores.qso.push(
  mk(1, "VK2AAA", 24940000, "CW"),                               // 12m
  mk(2, "OK2BBB", 144300000, "USB"),                             // 2m
  mk(3, "OK1CCC", 14200000, "LSB"),                              // 20m, SSB
  mk(4, "ZL1DDD", 14025000, "CW-R", { locatorReceived: "RF73" }), // far
  mk(5, "DL9EEE", 7025000, "CW", { deleted: true, updatedAtUtc: "2026-10-02T10:00:00.000Z" }),
);
const file = core.mergeBackups(core.snapshotToFile(hist, DEV, []), null).merged;
const fixture = core.serializeFile(file, "2026-10-02T12:00:00.000Z");
const TOTAL = file.stores.qso.length;
const DELETED = file.stores.qso.filter(q => q.deleted).length;

let finished = false, chrome = null, timer = null;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-smoke-"));

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (chrome) chrome.kill("SIGTERM");
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  const checks = result.checks || [];
  const failed = checks.filter(c => !c[1]);
  for (const [name, ok, detail] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
  const line = `LOG VIEWER ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
  (failed.length ? console.error : console.log)(line);
  if (failed.length) process.exitCode = 1;
}

const PAGE_SCRIPT = `
(async function () {
  const TOTAL = ${TOTAL}, DELETED = ${DELETED};
  const phase = sessionStorage.getItem("vSmokePhase") || "1";
  const checks = JSON.parse(sessionStorage.getItem("vSmokeChecks") || "[]");
  const check = (name, ok, detail) => checks.push([name, !!ok, detail || ""]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  const rows = () => LogViewer.rows();
  const tile = k => { const t = [...document.querySelectorAll(".tile")].find(x => x.querySelector(".k") &&
                      x.querySelector(".k").textContent === k); return t ? t.querySelector(".v").firstChild.textContent.trim() : ""; };
  function typeFilter(k, v) {
    const inp = document.querySelector('.frow input[data-k="' + k + '"]');
    inp.value = v;
    inp.dispatchEvent(new Event("input", {bubbles: true}));
  }
  async function settle() { await sleep(250); }
  async function finishRun() {
    sessionStorage.removeItem("vSmokePhase"); sessionStorage.removeItem("vSmokeChecks");
    await fetch("/result", {method: "POST", body: JSON.stringify({checks})});
  }
  try {
    for (let i = 0; i < 100 && !(window.LogViewer && LogViewer.all().length); i++) await sleep(100);
    await sleep(300);

    if (phase === "2") {
      check("reload: the filters come back from the address",
            document.querySelector('.frow input[data-k="call"]').value === "OK1" &&
            document.querySelector('.frow input[data-k="band"]').value === "=20m", location.hash);
      check("reload: the same rows", rows().length === Number(sessionStorage.getItem("vSmokeN")),
            rows().length + " vs " + sessionStorage.getItem("vSmokeN"));
      check("reload: the sort comes back", /sort=-qrb/.test(location.hash) &&
            document.querySelector('.hrow [data-sort="qrb"]').classList.contains("sorted"));
      check("reload: the hidden column stays hidden", !document.querySelector('.hrow [data-sort="trx"]'));
      await finishRun();
      return;
    }

    // ── load
    check("every QSO is loaded", LogViewer.all().length === TOTAL, LogViewer.all().length + " / " + TOTAL);
    check("deleted ones are hidden by default", rows().length === TOTAL - DELETED, String(rows().length));
    check("the title names the station", /OK1HRA/.test($("title").textContent), $("title").textContent);
    check("statistics count the rows shown", tile("QSO") === String(rows().length), tile("QSO"));
    const drows = document.querySelectorAll(".drow").length;
    check("only the rows in view are in the page", drows > 5 && drows < 200, String(drows));

    // ── DXCC for imported QSOs
    const r9 = LogViewer.all().find(r => r.call === "R9JD");
    check("an imported QSO without DXCC gets its country here", r9 && r9.country && r9.cont === "AS",
          r9 && JSON.stringify({c: r9.country, k: r9.cont, q: r9.qrb}));
    const zl = LogViewer.all().find(r => r.call === "ZL1DDD");
    check("...and a distance from my locator", zl && zl.qrb > 15000 && zl.az !== "", zl && (zl.qrb + " km " + zl.az));

    // ── filters
    let t0 = performance.now();
    typeFilter("call", "ok1");
    await settle();
    const tCall = performance.now() - t0 - 120;
    check("partial call filter, any case", rows().length > 0 && rows().length < TOTAL &&
          rows().every(r => r.call.includes("OK1")), String(rows().length));
    check("filter + statistics over 16k rows answer quickly", tCall < 300, Math.round(tCall) + " ms");
    check("statistics follow the filter", tile("QSO") === String(rows().length) &&
          tile("Stations") === String(new Set(rows().map(r => r.call)).size));
    typeFilter("call", "");
    typeFilter("log", "smoke");
    await settle();
    check("the log name filters too", rows().length === 4 && rows().every(r => r.log === "SMOKE TEST"), String(rows().length));
    typeFilter("band", "2m");
    await settle();
    check("'2m' alone finds 2m and 12m", rows().map(r => r.band).sort().join() === "12m,2m", rows().map(r => r.band).join());
    typeFilter("band", "=2m");
    await settle();
    check("'=2m' finds only 2m", rows().length === 1 && rows()[0].band === "2m", rows().map(r => r.band).join());
    typeFilter("band", "");
    typeFilter("mode", "=ssb");
    await settle();
    check("'=SSB' finds USB and LSB", rows().map(r => r.mode).sort().join() === "LSB,USB", rows().map(r => r.mode).join());
    typeFilter("mode", "=cw");
    await settle();
    check("'=CW' includes CW-R", rows().some(r => r.mode === "CW-R"), rows().map(r => r.mode).join());
    typeFilter("mode", "");
    typeFilter("log", "");
    typeFilter("qrb", ">5000");
    await settle();
    check("QRB >5000", rows().length > 0 && rows().every(r => r.qrb > 5000), String(rows().length));
    // The imported history has no locator of its own (myLocator ""), so only
    // the made-up QSOs have a distance at all.
    typeFilter("qrb", "15000-20000");
    await settle();
    check("QRB 15000-20000", rows().length > 0 && rows().every(r => r.qrb >= 15000 && r.qrb <= 20000), String(rows().length));
    typeFilter("qrb", ">abc");
    await settle();
    check("an unreadable number filter is marked and ignored",
          document.querySelector('.frow input[data-k="qrb"]').classList.contains("bad") && rows().length === TOTAL - DELETED);
    typeFilter("qrb", "");
    typeFilter("call", "OK1");
    typeFilter("band", "=20m");
    await settle();
    check("filters AND together", rows().length > 0 && rows().every(r => r.call.includes("OK1") && r.band === "20m"),
          String(rows().length));
    check("the address holds the filters", /call=OK1/.test(location.hash) && /band=%3D20m/.test(location.hash), location.hash);

    // ── click in the statistics
    $("clearFilters").click();
    await settle();
    const cell = [...document.querySelectorAll("#bmTable td.click[data-band='40m'][data-mode='CW']")][0];
    check("the band x mode table has a 40m CW cell", !!cell);
    const want = cell ? Number(cell.textContent) : -1;
    cell && cell.click();
    await settle();
    check("clicking it sets Band and Mode", document.querySelector('.frow input[data-k="band"]').value === "=40m" &&
          document.querySelector('.frow input[data-k="mode"]').value === "=CW");
    check("...and shows exactly its number of rows", rows().length === want, rows().length + " vs " + want);
    const chip = document.querySelector(".chip[data-cont]");
    const cont = chip && chip.getAttribute("data-cont");
    chip && chip.click();
    await settle();
    check("a continent chip filters by it", rows().length > 0 && rows().every(r => r.cont === cont), cont);
    $("clearFilters").click();
    await settle();

    // ── deleted
    $("showDeleted").click();
    await settle();
    check("show deleted brings them back", rows().length === TOTAL && document.querySelectorAll(".drow.deleted").length >= 0);
    $("showDeleted").click();
    await settle();

    // ── export
    const blobs = [];
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = b => { blobs.push(b); return realCreate.call(URL, b); };
    typeFilter("log", "smoke");
    await settle();
    $("dlAdif").click();
    $("dlCsv").click();
    await sleep(100);
    URL.createObjectURL = realCreate;
    const adif = blobs[0] ? await blobs[0].text() : "";
    const csv = blobs[1] ? await blobs[1].text() : "";
    check("ADIF has one record per row shown", (adif.match(/<EOR>/g) || []).length === rows().length,
          (adif.match(/<EOR>/g) || []).length + " vs " + rows().length);
    check("ADIF carries each QSO's own station", /<STATION_CALLSIGN:6>OK1HRA/.test(adif) && /<MY_GRIDSQUARE:6>JO60NA/.test(adif));
    check("ADIF writes CW-R as CW (shared mapping)", /<CALL:6>ZL1DDD[^\\n]*<MODE:2>CW /.test(adif));
    check("CSV has a header and one line per row", csv.trim().split("\\r\\n").length === rows().length + 1);
    check("CSV carries the DXCC filled in here", /ZL1DDD[^\\n]*New Zealand/.test(csv));

    // ── sort, hidden column, then reload
    document.querySelector('.hrow [data-sort="qrb"]').click();
    await settle();
    check("sorting a number column puts the largest first", rows()[0].qrb >= rows()[rows().length - 1].qrb);
    $("colsBtn").click();
    const trx = document.querySelector('#colsMenu input[data-col="trx"]');
    trx.click();
    await settle();
    check("a column can be hidden", !document.querySelector('.hrow [data-sort="trx"]'));
    typeFilter("log", "");
    typeFilter("call", "OK1");
    typeFilter("band", "=20m");
    await settle();
    sessionStorage.setItem("vSmokeN", String(rows().length));
    sessionStorage.setItem("vSmokeChecks", JSON.stringify(checks));
    sessionStorage.setItem("vSmokePhase", "2");
    location.reload();
    return;
  } catch (error) {
    check("the harness ran to the end", false, String(error && error.stack || error));
  }
  await finishRun();
})();
`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  if (url.pathname === "/result" && request.method === "POST") {
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => { response.writeHead(204).end(); finish(JSON.parse(body)); });
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = fs.readFileSync(path.join(root, "log-viewer", "index.html"), "utf8")
      .replace("</body>", `<script>${PAGE_SCRIPT}</script>\n</body>`);
    response.writeHead(200, { "Content-Type": "text/html" });
    return response.end(html);
  }
  if (url.pathname === "/QSO-database.json") {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(fixture);
  }
  response.writeHead(404).end("not found");
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", "--window-size=1400,900", "--user-data-dir=" + profile,
    `http://127.0.0.1:${port}/`,
  ], {stdio: ["ignore", "ignore", "pipe"]});
  let chromeErrors = "";
  chrome.stderr.on("data", chunk => { chromeErrors += chunk; });
  chrome.on("error", error => finish({checks: [["chrome started", false, error.message]]}));
  chrome.on("close", code => {
    if (!finished) finish({checks: [["chrome stayed up", false, `exit ${code} ${chromeErrors.slice(-400)}`]]});
  });
  timer = setTimeout(() => finish({checks: [["the page reported within the timeout", false, "no /result"]]}), 90000);
});
