#!/usr/bin/env node
"use strict";

// STATISTICS over every saved log, in the saved-log picker, driven in a real
// browser against a seeded IndexedDB.
//
// What it guards: the fold counts every log the way the Alt+S palette counts
// one (dupes within a log once, the same call in two logs twice, deleted QSOs
// out, USB/LSB = SSB, CW-R = CW, no frequency = "?"), lays it out band by mode
// with both sums next to their labels -- Σ the first row and the first column --
// ignores the filter, and remembers whether it was open.

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (chrome) { chrome.kill("SIGTERM"); setTimeout(() => chrome && chrome.kill("SIGKILL"), 2000).unref(); }
  server.close();
  const checks = result.checks || [];
  const failed = checks.filter(c => !c[1]);
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
  }
  const line = `LOG LIST STATS ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
  (failed.length ? console.error : console.log)(line);
  if (failed.length) process.exitCode = 1;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  const json = body => {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify(body));
  };

  if (url.pathname === "/result" && request.method === "POST") {
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => { response.writeHead(204).end(); finish(JSON.parse(body)); });
    return;
  }
  if (url.pathname === "/cmd" && request.method === "POST") {
    request.on("data", () => {});
    request.on("end", () => json({ok: true}));
    return;
  }
  if (url.pathname === "/state") {
    return json({
      connected: true, catHealthy: true, audioReady: false, lanStatus: "linked",
      btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
      fullCat: true, wifiRssi: -55, fwRev: "20260810", bdSupported: false,
      power: true, frequency: 14025000, mode: "CW", filter: 1,
      radioAddress: "a4", transceiverType: "IC-705", radioName: "IC-705",
      tx: false, ritRaw: 0, smeterRaw: 0, powerMeterRaw: 0, afGain: 100,
      keySpeed: 20, rfPower: 128, rfPowerSeen: true, supplyVolts: 13.8, swr: 1.1,
      preamp: 0, vox: 0, dxcConnected: false,
    });
  }
  if (url.pathname === "/dxcinfo") return json({locator: "JO70", call: "OK1HRA"});
  if (url.pathname === "/log-config") {
    return json({
      trx1Label: "TRX1", trx2Label: "TRX2", trx3Label: "TRX3",
      trx2enabled: false, trx3enabled: false, blockedDxcc: "",
    });
  }
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70"});

  const file = url.pathname === "/" ? path.join(data, "log.html")
                                    : path.join(data, path.basename(url.pathname));
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    response.writeHead(200, {"Content-Type": mime[path.extname(file)] || "text/plain"});
    return response.end(fs.readFileSync(file));
  }
  response.writeHead(404).end("not found");
});

// ── The script appended to the real page ─────────────────────────────────────

const PAGE_SCRIPT = `
(async function () {
  const checks = [];
  const check = (name, ok, detail) => checks.push([name, !!ok, detail || ""]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  let n = 0;
  const ts = () => new Date(Date.UTC(2026, 0, 1, 10, 0, n++)).toISOString();
  const q = (logId, call, hz, mode, extra) => Object.assign(
    {logId, call, frequencyHz: hz, mode, exchangeReceived: "", timestampUtc: ts()}, extra || {});
  const rows = () => Array.from(document.querySelectorAll("#lmStats tr"))
    .map(tr => Array.from(tr.children).map(c => c.textContent.trim()).join("|"));

  async function reopenModal() {
    LogManager.closeModal();
    await sleep(30);
    LogManager.openModal();
    await sleep(300);
  }

  try {
    localStorage.removeItem("wifilt-log-list-stats-open");
    LogManager.openModal();
    await sleep(300);
    check("no logs, no statistics fold", !$("lmStats"), $("lmStats") ? "fold shown" : "");

    const mk = name => LogDB.createLog({
      contestName: name, stationCall: "OK1HRA", defaultExchange: "NR",
      myLocator: "JO70FD", startQsoNumber: 1, cwAbbrev: true,
    });
    const a = await mk("CQWW-2025"), b = await mk("OKOM-2026");
    // log A: W1AW twice on 20 m CW (a dupe), once on 20 m CW-R (still CW, dupe),
    // once on 20 m SSB (another mode, counts), K3LR 40 m CW, a deleted one.
    await LogDB.addQso(q(a.id, "W1AW",  14025000, "CW"));
    await LogDB.addQso(q(a.id, "W1AW",  14026000, "CW"));
    await LogDB.addQso(q(a.id, "W1AW",  14027000, "CW-R"));
    await LogDB.addQso(q(a.id, "W1AW",  14250000, "USB"));
    await LogDB.addQso(q(a.id, "K3LR",   7025000, "CW"));
    await LogDB.addQso(q(a.id, "DL1ABC", 7030000, "CW", {deleted: true}));
    // log B: W1AW again on 20 m CW (another log, counts), LSB on 80 m, RTTY on
    // 160 m, and one with no frequency.
    await LogDB.addQso(q(b.id, "W1AW",  14025000, "CW"));
    await LogDB.addQso(q(b.id, "OK2AA",  3700000, "LSB"));
    await LogDB.addQso(q(b.id, "OK1KZ",  1840000, "RTTY"));
    await LogDB.addQso(q(b.id, "OK1XYZ",       0, "CW"));
    LogManager.activateLog(b);
    await sleep(120);
    await reopenModal();

    const fold = $("lmStats");
    check("the statistics fold is there once logs have QSOs", !!fold);
    check("it starts folded", fold && !fold.open, fold && fold.open ? "open" : "");
    check("its head counts all logs without dupes",
      fold && /all logs · 7 QSO, no dupes/.test(fold.querySelector("summary").textContent),
      fold && fold.querySelector("summary").textContent.trim().replace(/\\s+/g, " "));
    check("it sits after the year folds, before the footer",
      fold && fold.previousElementSibling && fold.previousElementSibling.matches("details.lm-year")
           && fold.nextElementSibling && fold.nextElementSibling.matches(".lm-log-total"),
      fold ? (fold.previousElementSibling || {}).className + " / " + (fold.nextElementSibling || {}).className : "");

    const r = rows();
    check("header: Σ right after the label, then modes in order",
      r[0] === "|Σ|CW|SSB|RTTY", r[0]);
    check("the Σ row comes first, under the header",
      r[1] === "Σ|7|4|2|1", r[1]);
    check("bands are rows in frequency order, '?' last, each with its Σ first",
      r.slice(2).join(" ; ") === "160m|1|·|·|1 ; 80m|1|·|1|· ; 40m|1|1|·|· ; 20m|3|2|1|· ; ?|1|1|·|·",
      r.slice(2).join(" ; "));
    check("no multipliers in it", !/MULT/.test(r.join(" ")), "");

    // ---- the filter leaves it alone --------------------------------------
    const s = $("lmSearch");
    s.value = "cqww";
    s.dispatchEvent(new Event("input", {bubbles: true}));
    await sleep(120);
    check("the filter does not change the statistics",
      rows()[1] === "Σ|7|4|2|1", rows()[1]);
    s.value = "";
    s.dispatchEvent(new Event("input", {bubbles: true}));
    await sleep(120);

    // ---- open state is remembered ----------------------------------------
    $("lmStats").open = true;
    await sleep(50);
    await reopenModal();
    check("an opened fold stays open after the modal is reopened",
      $("lmStats") && $("lmStats").open);
    $("lmStats").open = false;
    await sleep(50);
    await reopenModal();
    check("a closed fold stays closed", $("lmStats") && !$("lmStats").open);

    // ---- a new QSO shows on the next opening ------------------------------
    await LogDB.addQso(q(b.id, "OK1ZZ", 14030000, "CW"));
    await reopenModal();
    check("a QSO logged since is counted on the next opening",
      rows()[1] === "Σ|8|5|2|1", rows()[1]);
  } catch (error) {
    check("the test script ran to the end", false, String(error && error.stack || error));
  }

  await fetch("/result", {method: "POST", body: JSON.stringify({checks})});
})();
`;

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  // 127.0.0.1 and not a .test host: the log page keeps its logs in IndexedDB and
  // asks about storage persistence, which needs a secure context.
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", `http://127.0.0.1:${port}/log.html`,
  ], {stdio: ["ignore", "ignore", "pipe"]});
  let chromeErrors = "";
  chrome.stderr.on("data", chunk => { chromeErrors += chunk; });
  chrome.on("error", error => finish({checks: [["chrome started", false, error.message]]}));
  chrome.on("close", code => {
    if (!finished) finish({checks: [["chrome stayed up", false, `exit ${code} ${chromeErrors.slice(-400)}`]]});
  });
  timer = setTimeout(() => finish({checks: [["the page reported within the timeout", false,
    "no /result was posted"]]}), 90000);
});

process.on("SIGINT",  () => finish({checks: [["interrupted", false, "SIGINT"]]}));
process.on("SIGTERM", () => finish({checks: [["interrupted", false, "SIGTERM"]]}));

// The fixture appends the test script to log.html on the way out, so the page
// under test is byte-identical to production apart from that one tag.
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file === "string" && file.endsWith("log.html"))
    return Buffer.concat([content, Buffer.from(`\n<script>${PAGE_SCRIPT}</script>\n`)]);
  return content;
};
