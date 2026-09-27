#!/usr/bin/env node
"use strict";

// The Alt+S statistics palette (data/log-stats.js), driven in a real browser.
//
// Two halves. The counting is a pure function, LogStats.compute(), and is fed
// hand-made QSOs straight: the rules grilled on 2026-09-28 are all in there --
// duplicates by call + band + mode, CW-R = CW, USB = LSB = SSB, a QSO imported
// from ADIF (frequency only as "14.0740 MHz" text) still landing on 20m, the
// LAST candidate word of EXCH, states only from W/VE stations by DXCC, zones as
// numbers. The palette is then driven through the page itself: the hotkey, the
// caret that must never leave Call, live recounting on every write, the
// per-log multiplier choice, and the open state surviving a reload.

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;

function stateJson() {
  return {
    connected: true, catHealthy: true, audioReady: false, lanStatus: "linked",
    btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
    fullCat: true, wifiRssi: -55, fwRev: "20260810", bdSupported: false,
    power: true, frequency: 14025000, mode: "CW", filter: 1,
    radioAddress: "a4", transceiverType: "IC-705", radioName: "IC-705",
    tx: false, ritRaw: 0, smeterRaw: 0, powerMeterRaw: 0, afGain: 100,
    keySpeed: 20, rfPower: 128, rfPowerSeen: true, supplyVolts: 13.8, swr: 1.1,
    preamp: 0, vox: 0, dxcConnected: false,
  };
}

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (chrome) chrome.kill("SIGTERM");
  server.close();
  const checks = result.checks || [];
  const failed = checks.filter(c => !c[1]);
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
  }
  const line = `LOG STATS ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
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
  if (url.pathname === "/cmd") return json({ok: true});
  if (url.pathname === "/log-macros.json") return json({});
  if (url.pathname === "/state") return json(stateJson());
  if (url.pathname === "/dxcinfo") return json({locator: "JO70", call: "OK1HRA"});
  if (url.pathname === "/log-config") {
    return json({
      trx1Label: "TRX1", trx2Label: "TRX2", trx3Label: "TRX3",
      trx2enabled: false, trx3enabled: false, blockedDxcc: "",
    });
  }
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70"});

  let file = url.pathname === "/" ? path.join(data, "log.html")
                                  : path.join(data, path.basename(url.pathname));
  if (process.env.LOG_STATS_SMOKE_MINIFIED === "1" && file.endsWith(".js")
      && fs.existsSync(file + ".min")) file = file + ".min";
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    response.writeHead(200, {"Content-Type": mime[path.extname(file)] || "text/plain"});
    return response.end(fs.readFileSync(file));
  }
  response.writeHead(404).end("not found");
});

// A template literal: no backslash escapes in here, they would be eaten by
// Node before the page ever saw them.
const PAGE_SCRIPT = `
(async function () {
  const phase = sessionStorage.getItem("statsSmokePhase") || "1";
  const checks = JSON.parse(sessionStorage.getItem("statsSmokeChecks") || "[]");
  const check = (name, ok, detail) => checks.push([name, !!ok, detail || ""]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  const panel = () => $("statsPanel");
  const shown = () => !!panel() && panel().style.display !== "none";
  function altS(extra) {
    const init = Object.assign({code: "KeyS", key: "s", altKey: true, bubbles: true, cancelable: true}, extra || {});
    $("inpCall").dispatchEvent(new KeyboardEvent("keydown", init));
  }
  const ts = n => new Date(Date.UTC(2026, 8, 28, 12, 0, n)).toISOString();
  const q = (n, call, hz, mode, exch, extra) => Object.assign(
    {call: call, frequencyHz: hz, mode: mode, exchangeReceived: exch || "", timestampUtc: ts(n)}, extra || {});
  const text = id => ($(id) ? $(id).textContent.trim().split(/ +/).join(" ") : "");
  const rowText = sel => Array.from(document.querySelectorAll(sel))
    .map(tr => Array.from(tr.children).map(c => c.textContent.trim()).join("|"));

  async function finishRun() {
    sessionStorage.removeItem("statsSmokePhase");
    sessionStorage.removeItem("statsSmokeChecks");
    await fetch("/result", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({checks}),
    });
  }

  try {
    for (let i = 0; i < 60 && !(window.LogStats && window.LogManager && window.DXCC); i++) await sleep(100);
    await sleep(900);

    if (phase === "2") {
      // ---- 6. after the reload ---------------------------------------------
      await sleep(600);
      const want = JSON.parse(sessionStorage.getItem("statsSmokePos") || "null");
      check("the palette comes back open after F5", LogStats.isOpen() && shown());
      check("... where it was left",
        want && panel() && panel().style.left === want.left && panel().style.top === want.top,
        JSON.stringify(want) + " vs " + (panel() && panel().style.left + "," + panel().style.top));
      check("... still counting the active log",
        /QSO/.test(text("statsQso")), text("statsQso"));
      LogStats.setOpen(false);
      await finishRun();
      return;
    }

    // Leftovers from an earlier run in the same profile.
    try { localStorage.removeItem("wifilt-log-stats"); localStorage.removeItem("wifilt-log-stats-mult"); } catch (_) {}
    LogStats.setOpen(false);

    // ---- 1. the counting, pure --------------------------------------------
    const L = DXCC.lookupDxcc;
    let s = LogStats.compute([
      q(1, "OK1AA", 14025000, "CW"),
      q(2, "OK1AA", 14030000, "CW-R"),              // dupe: CW-R is CW
      q(3, "OK1AA", 7025000,  "CW"),                // other band: counts
      q(4, "OK1AA", 14200000, "USB"),               // other mode: counts
      q(5, "OK1AA", 14250000, "LSB"),               // dupe: LSB is SSB like USB
      q(6, "OK2BB", 0, "CW", "", {frequencyDisplay: "14.0740 MHz"}),  // ADIF import
      q(7, "OK3CC", 0, "CW"),                       // no frequency at all
      q(8, "OK4DD", 21025000, "CW", "", {deleted: true}),
      q(9, "OK5EE", 3525000, ""),                   // no mode
    ], "", L);
    check("bands in frequency order, only used ones, '?' last",
      s.bands.join(",") === "80m,40m,20m,?", s.bands.join(","));
    const byLabel = {};
    s.rows.forEach(r => { byLabel[r.label] = r; });
    check("more modes: a row each, then the QSO total row last",
      s.rows.map(r => r.label).join(",") === "CW,SSB,?,QSO", s.rows.map(r => r.label).join(","));
    check("CW-R on the same band is a dupe of CW",
      byLabel.CW.perBand["20m"] === 2 && byLabel.CW.perBand["40m"] === 1,
      JSON.stringify(byLabel.CW.perBand));
    check("USB and LSB on one band are one SSB QSO",
      byLabel.SSB.perBand["20m"] === 1 && byLabel.SSB.total === 1, JSON.stringify(byLabel.SSB.perBand));
    check("an ADIF QSO with only the MHz text lands on 20m (counted in CW 20m above)",
      byLabel.CW.perBand["20m"] === 2);
    check("no frequency goes to '?'", byLabel.CW.perBand["?"] === 1, JSON.stringify(byLabel.CW.perBand));
    check("the deleted QSO is not counted", byLabel.QSO.total === 6, String(byLabel.QSO.total));
    check("no mode is its own '?' row", byLabel["?"] && byLabel["?"].perBand["80m"] === 1);

    s = LogStats.compute([q(1, "OK1AA", 14025000, "CW"), q(2, "OK1BB", 7025000, "CW")], "", L);
    check("one mode: a single QSO row", s.rows.length === 1 && s.rows[0].label === "QSO" && s.rows[0].total === 2,
      JSON.stringify(s.rows));
    check("no multiplier chosen: no multiplier result", s.mult === null);

    s = LogStats.compute([
      q(1, "W1AW",   14025000, "CW", "BOB MA"),       // last word wins: MA
      q(2, "K3LR",   14026000, "CW", "72 ENY"),       // 3 letters (section)
      q(3, "VE3XX",  14027000, "CW", "ON"),
      q(4, "KH6YY",  7025000,  "CW", "HI"),
      q(5, "KL7ZZ",  7026000,  "CW", "AK"),
      q(6, "DL1ABC", 14028000, "CW", "MA"),           // not W/VE: ignored
      q(7, "W2XX",   7027000,  "CW", "MA"),           // MA again, other band
      q(8, "W1AW",   14029000, "CW", "CT"),           // dupe: brings nothing
      q(9, "N4YY",   21025000, "CW", "599 KW4"),      // no 2-3 letter word
      q(10, "AA1ZZ", 21026000, "CW", "ABCD"),         // 4 letters: not a state
    ], "states", L);
    check("states: unique list alphabetical, W/VE only, last word",
      s.mult.unique.join(" ") === "AK ENY HI MA ON", s.mult.unique.join(" "));
    check("states: per band counts",
      s.mult.perBand["20m"] === 3 && s.mult.perBand["40m"] === 3 && s.mult.perBand["15m"] === 0,
      JSON.stringify(s.mult.perBand));
    check("states: the sum is the bands added up", s.mult.sum === 6, String(s.mult.sum));

    s = LogStats.compute([
      q(1, "OK1AA", 14025000, "CW", "15"),
      q(2, "OK1BB", 14026000, "CW", "015"),           // 3 digits: no zone
      q(3, "JA1CC", 14027000, "CW", "25"),
      q(4, "W1AW",  14028000, "CW", "5"),
      q(5, "K1ZZ",  14029000, "CW", "05"),            // 05 is 5
      q(6, "VK2XX", 7025000,  "CW", "30 2"),          // last word: 2
      q(7, "ZL1YY", 7026000,  "CW", "02"),            // 02 is 2
      q(8, "OK2DD", 7027000,  "CW", "0"),             // no zone 0
      q(9, "UA0EE", 7028000,  "CW", "599 19"),
    ], "zones", L);
    check("zones: 2 = 02, 5 = 05, 0 dropped, sorted as numbers",
      s.mult.unique.join(" ") === "2 5 15 19 25", s.mult.unique.join(" "));
    check("zones: per band and sum",
      s.mult.perBand["20m"] === 3 && s.mult.perBand["40m"] === 2 && s.mult.sum === 5,
      JSON.stringify(s.mult.perBand) + " sum " + s.mult.sum);

    // ---- 2. the hotkey and the caret --------------------------------------
    const logA = await LogDB.createLog({contestName: "STATSA", stationCall: "OK1HRA",
      defaultExchange: "NR", myLocator: "JO70FD", startQsoNumber: 1});
    const logB = await LogDB.createLog({contestName: "STATSB", stationCall: "OK1HRA",
      defaultExchange: "NR", myLocator: "JO70FD", startQsoNumber: 1});
    await LogDB.addQso(Object.assign({logId: logA.id}, q(1, "W1AW", 14025000, "CW", "MA")));
    await LogDB.addQso(Object.assign({logId: logA.id}, q(2, "K3LR", 7025000, "CW", "PA")));
    LogManager.activateLog(logA);
    await sleep(400);

    $("inpCall").focus();
    altS();
    await sleep(400);
    check("Alt+S opens the palette", shown());
    check("... and the caret stays in Call", document.activeElement === $("inpCall"),
      document.activeElement && document.activeElement.id);
    check("header: the bands of the log, then the sum",
      rowText("#statsThead tr").join(";") === "|40m|20m|Σ", rowText("#statsThead tr").join(";"));
    check("the QSO row counts them", rowText("#statsQso tr").join(";") === "QSO|1|1|2",
      rowText("#statsQso tr").join(";"));
    check("no multiplier rows before one is chosen", !$("statsMultRows").children.length);

    $("inpCall").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", code: "Escape", bubbles: true, cancelable: true}));
    await sleep(200);
    check("Esc does not close it (Esc stays the TX abort)", shown());

    // ---- 3. the multiplier select -----------------------------------------
    const sel = $("statsMult");
    sel.focus();
    sel.value = "states";
    sel.dispatchEvent(new Event("change", {bubbles: true}));
    await sleep(200);
    check("choosing hands the caret back to Call", document.activeElement === $("inpCall"),
      document.activeElement && document.activeElement.id);
    check("the MULT row appears in the band grid", rowText("#statsMultRows tr.st-mult").join(";") === "MULT|1|1|2",
      rowText("#statsMultRows tr.st-mult").join(";"));
    check("... with the unique list under it", text("statsList") === "unique 2: MA PA", text("statsList"));

    // ---- 4. live recounting ------------------------------------------------
    const selBefore = $("statsMult");
    const added = await LogDB.addQso(Object.assign({logId: logA.id}, q(3, "VE3XX", 14030000, "USB", "ON")));
    await sleep(500);
    check("a new QSO is counted without reopening",
      rowText("#statsQso tr").join(";") === "CW|1|1|2;SSB|·|1|1;QSO|1|2|3",
      rowText("#statsQso tr").join(";"));
    check("the select survives the redraw (same element)", $("statsMult") === selBefore);
    check("... and the list grows", text("statsList") === "unique 3: MA ON PA", text("statsList"));
    added.exchangeReceived = "QC";
    await LogDB.updateQso(added);
    await sleep(500);
    check("an edit is recounted", text("statsList") === "unique 3: MA PA QC", text("statsList"));
    await LogDB.deleteQso(added.id);
    await sleep(500);
    check("a delete is recounted", rowText("#statsQso tr").join(";") === "QSO|1|1|2",
      rowText("#statsQso tr").join(";"));

    // ---- 5. the choice is per log ------------------------------------------
    LogManager.activateLog(logB);
    await sleep(500);
    check("another log starts with no multiplier", $("statsMult").value === "" && !$("statsMultRows").children.length,
      $("statsMult").value);
    check("an empty log shows just the sum",
      rowText("#statsThead tr").join(";") === "|Σ" && rowText("#statsQso tr").join(";") === "QSO|0",
      rowText("#statsThead tr").join(";") + " / " + rowText("#statsQso tr").join(";"));
    LogManager.activateLog(logA);
    await sleep(500);
    check("back on the first log its choice is still there", $("statsMult").value === "states",
      $("statsMult").value);

    // Alt+S with CapsLock on reports key "S": the physical key still decides.
    altS({key: "S"});
    await sleep(200);
    check("Alt+S (CapsLock) closes it", !shown());
    altS({key: "S"});
    await sleep(400);
    check("... and opens it again", shown());

    // Park it somewhere recognisable and reload.
    const p = panel();
    p.style.left = "40px"; p.style.top = "60px";
    // Through the drag, which is what writes the position.
    const head = $("statsHead");
    const r = head.getBoundingClientRect();
    head.dispatchEvent(new PointerEvent("pointerdown", {clientX: r.left + 20, clientY: r.top + 5, pointerId: 1, bubbles: true}));
    head.dispatchEvent(new PointerEvent("pointermove", {clientX: r.left + 30, clientY: r.top + 15, pointerId: 1, bubbles: true}));
    head.dispatchEvent(new PointerEvent("pointerup",   {clientX: r.left + 30, clientY: r.top + 15, pointerId: 1, bubbles: true}));
    sessionStorage.setItem("statsSmokePos", JSON.stringify({left: p.style.left, top: p.style.top}));
    sessionStorage.setItem("statsSmokeChecks", JSON.stringify(checks));
    sessionStorage.setItem("statsSmokePhase", "2");
    location.reload();
    return;
  } catch (error) {
    check("the harness ran to the end", false, String(error && error.stack || error));
  }
  await finishRun();
})();
`;

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", "--window-size=1400,900", `http://127.0.0.1:${port}/log.html`,
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

const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file === "string" && file.endsWith("log.html"))
    return Buffer.concat([content, Buffer.from(`\n<script>${PAGE_SCRIPT}</script>\n`)]);
  return content;
};
