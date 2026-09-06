#!/usr/bin/env node
"use strict";

// The saved-log picker's year folds, driven in a real browser against a seeded
// IndexedDB.
//
// Why this harness exists: the fold is the only thing standing between an
// operator with several seasons of contest logs and a modal they have to scroll
// through to find anything. Three rules decide whether it helps or hurts, and
// all three are easy to break without noticing while editing renderLogList:
// years start folded, the log currently in use is never inside a fold, and the
// filter still reaches every log of every year (opening the years that match).
//
// The assertions sit on what the modal actually renders -- an operator looking
// for last weekend's log cares about the rows on screen, not about which array
// applyFilter built.

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
  const line = `LOG YEAR GROUPS ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
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

  // Rows the operator can actually see: a row inside a folded <details> is not
  // one of them, which is the whole point of the feature.
  function visibleRows() {
    return Array.from(document.querySelectorAll("#lmLogList .lm-log-row"))
      .filter(row => {
        const fold = row.closest("details.lm-year");
        return !fold || fold.open;
      })
      .map(row => row.querySelector(".lm-log-name").textContent);
  }
  function years() {
    return Array.from(document.querySelectorAll("#lmLogList details.lm-year"))
      .map(d => d.dataset.year);
  }
  function openYears() {
    return Array.from(document.querySelectorAll("#lmLogList details.lm-year"))
      .filter(d => d.open).map(d => d.dataset.year);
  }
  async function reopenModal() {
    LogManager.closeModal();
    await sleep(30);
    LogManager.openModal();
    await sleep(250);
  }
  async function filterTo(text) {
    const input = $("lmSearch");
    input.value = text;
    input.dispatchEvent(new Event("input", {bubbles: true}));
    await sleep(120);
  }

  try {
    // ---- seed: five logs over three seasons, plus one with no timestamp -----
    const seed = [
      ["2024-03-02T10:00:00.000Z", "CQWW-2024"],
      ["2025-05-09T10:00:00.000Z", "FIELDDAY-2025"],
      ["2025-11-30T10:00:00.000Z", "CQWW-2025"],
      ["2026-01-04T10:00:00.000Z", "OKOM-2026"],
      ["2026-02-14T10:00:00.000Z", "ACTIVE-2026"],
    ];
    const made = [];
    for (const [when, name] of seed) {
      const log = await LogDB.createLog({
        contestName: name, stationCall: "OK1HRA", defaultExchange: "NR",
        myLocator: "JO70FD", startQsoNumber: 1, cwAbbrev: true,
      });
      log.createdAtUtc = when;
      await LogDB.updateLog(log);
      made.push(log);
    }
    const undated = await LogDB.createLog({
      contestName: "IMPORTED", stationCall: "OK1HRA", defaultExchange: "",
      myLocator: "", startQsoNumber: 1, cwAbbrev: true,
    });
    undated.createdAtUtc = "";
    await LogDB.updateLog(undated);

    LogManager.activateLog(made[4]);          // ACTIVE-2026
    await sleep(120);
    await reopenModal();

    // ---- 1. one fold per year, newest first, undated last ------------------
    check("one fold per year, newest first, undated last",
      years().join(",") === "2026,2025,2024,—", years().join(","));

    // ---- 2. every year starts folded ---------------------------------------
    check("every year starts folded", openYears().length === 0, openYears().join(","));

    // ---- 3. the active log is visible without opening anything -------------
    check("the active log is visible with every year folded",
      visibleRows().join(",") === "ACTIVE-2026", visibleRows().join(","));

    // ---- 4. the active log is not inside a fold ----------------------------
    const activeRow = document.querySelector("#lmLogList .lm-log-active");
    check("the active log sits outside the folds",
      !!activeRow && !activeRow.closest("details.lm-year"),
      activeRow ? (activeRow.closest("details.lm-year") ? "inside a fold" : "pinned") : "no active row");

    // ---- 5. its own year does not list it twice ----------------------------
    const y2026 = document.querySelector('#lmLogList details.lm-year[data-year="2026"]');
    y2026.open = true;
    await sleep(30);
    check("the active log is not repeated inside its own year",
      visibleRows().filter(n => n === "ACTIVE-2026").length === 1, visibleRows().join(","));
    check("its year still lists the other logs of that year",
      visibleRows().includes("OKOM-2026"), visibleRows().join(","));

    // ---- 6. the fold the operator opened survives a re-render --------------
    LogManager.openModal();               // renderLogList runs again
    await sleep(250);
    check("a year the operator opened stays open across a re-render",
      openYears().join(",") === "2026", openYears().join(","));

    // ---- 7. the filter reaches every year, not just the open one -----------
    await filterTo("cqww");
    check("the filter finds matches inside folded years",
      visibleRows().includes("CQWW-2024") && visibleRows().includes("CQWW-2025"),
      visibleRows().join(","));
    check("the filter hides the non-matching logs",
      !visibleRows().includes("OKOM-2026"), visibleRows().join(","));
    check("the active log stays visible while filtering",
      visibleRows().includes("ACTIVE-2026"), visibleRows().join(","));
    check("a year with no match stays folded",
      !openYears().includes("—"), openYears().join(","));

    // ---- 8. clearing the filter folds the filter's own years back up -------
    await filterTo("");
    check("clearing the filter folds back the years the filter opened",
      openYears().join(",") === "2026", openYears().join(","));

    // ---- 9. a filter matching nothing still shows the active log ----------
    await filterTo("zzzz");
    check("no match still leaves the active log on screen",
      visibleRows().join(",") === "ACTIVE-2026", visibleRows().join(","));
    check("no match says so", !!document.querySelector("#lmLogList .lm-empty"),
      (document.querySelector("#lmLogList .lm-empty") || {}).textContent || "no hint");
    await filterTo("");

    // ---- 10. the undated fold catches the log with no timestamp ------------
    const undatedFold = document.querySelector('#lmLogList details.lm-year[data-year="—"]');
    undatedFold.open = true;
    await sleep(30);
    check("a log with no usable timestamp lands in the undated fold",
      visibleRows().includes("IMPORTED"), visibleRows().join(","));
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
