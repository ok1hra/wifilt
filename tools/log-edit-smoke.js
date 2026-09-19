#!/usr/bin/env node
"use strict";

// Editing a saved log -- name, exchange, locator, CW abbreviation -- driven in a
// real browser against a fixture that records what the page POSTed to /cmd.
//
// A log record was immutable from creation until this feature: a typo in the
// name or the wrong exchange type could only be fixed by exporting to ADIF,
// making a new log and importing back. The editor reuses the "New log" form, so
// most of what can go wrong here is cross-talk between the two modes, and that
// is what these checks are aimed at.
//
// Three traps have their own checks because each one fails silently:
//   * #lmMyCall carries `required`; hidden, it makes the browser refuse to submit
//     the whole form, so Save simply stops working;
//   * the active log is a live object whose nextQsoNumber rises in memory, so
//     writing back a copy read from the database costs a QSO its number;
//   * JS8 resolves its log by NAME, so renaming JS8CALL silently re-points where
//     JS8 QSOs land.

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;
const commands = [];
let currentMode = "CW";

function stateJson() {
  return {
    connected: true, catHealthy: true, audioReady: false, lanStatus: "linked",
    btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
    fullCat: true, wifiRssi: -55, fwRev: "20260810", bdSupported: false,
    power: true, frequency: 14025000, mode: currentMode, filter: 1,
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
  const line = `LOG EDIT ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
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
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => {
      try { commands.push(JSON.parse(body)); } catch (_) { commands.push({raw: body}); }
      json({ok: true});
    });
    return;
  }

  if (url.pathname === "/log-macros.json") {
    if (request.method === "POST") {
      let body = "";
      request.on("data", c => body += c);
      request.on("end", () => { response.writeHead(200, {"Content-Type": "application/json"}); response.end("{}"); });
      return;
    }
    return json({});
  }

  if (url.pathname === "/commands") return json(commands);
  if (url.pathname === "/commands/clear") { commands.length = 0; return json({ok: true}); }
  if (url.pathname === "/setMode") { currentMode = url.searchParams.get("mode") || "CW"; return json({ok: true}); }
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
  if (process.env.LOG_EDIT_SMOKE_MINIFIED === "1" && file.endsWith(".js")
      && fs.existsSync(file + ".min")) file = file + ".min";
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    response.writeHead(200, {"Content-Type": mime[path.extname(file)] || "text/plain"});
    return response.end(fs.readFileSync(file));
  }
  response.writeHead(404).end("not found");
});

const PAGE_SCRIPT = `
(async function () {
  const checks = [];
  const check = (name, ok, detail) => checks.push([name, !!ok, detail || ""]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);

  async function clearCommands() { await fetch("/commands/clear"); }
  async function lastSent() {
    const r = await fetch("/commands");
    const list = await r.json();
    return list.length ? String(list[list.length - 1].text || "") : "";
  }
  function type(el, value) {
    el.value = value;
    el.dispatchEvent(new Event("input", {bubbles: true}));
  }
  function pick(el, value) {
    el.value = value;
    el.dispatchEvent(new Event("change", {bubbles: true}));
  }
  async function openMgr() { $("btnOpenLog").click(); await sleep(350); }
  async function clickEdit(logId) {
    const btn = document.querySelector('[data-act="edit"][data-id="' + logId + '"]');
    if (!btn) throw new Error("no Edit button for " + logId);
    btn.click();
    await sleep(350);
  }
  // Submits the way a real click does, so HTML5 validation is genuinely in play.
  async function save() { $("lmFormSubmit").click(); await sleep(700); }

  async function keyExch(callsign) {
    await clearCommands();
    const call = $("inpCall");
    type(call, callsign);
    call.focus();
    call.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
    await sleep(400);
    return lastSent();
  }

  try {
    for (let i = 0; i < 60 && !window.LogMacros; i++) await sleep(100);
    await sleep(900);

    // ---- 1. createLog now actually stores cwAbbrev -------------------------
    const offLog = await LogDB.createLog({
      contestName: "ABBREVOFF", stationCall: "OK1HRA",
      defaultExchange: "NR", myLocator: "JO70FD", startQsoNumber: 1, cwAbbrev: false,
    });
    check("createLog stores cwAbbrev:false instead of dropping it",
      offLog.cwAbbrev === false, String(offLog.cwAbbrev));
    const onLog = await LogDB.createLog({
      contestName: "ABBREVON", stationCall: "OK1HRA",
      defaultExchange: "NR", myLocator: "JO70FD", startQsoNumber: 1, cwAbbrev: true,
    });
    check("an unspecified/true cwAbbrev stays on", onLog.cwAbbrev === true, String(onLog.cwAbbrev));

    // The log under test: static exchange, so the STATIC round trip is covered.
    const log = await LogDB.createLog({
      contestName: "EDITME", stationCall: "OK1HRA",
      defaultExchange: "SK1", myLocator: "JO70FD", startQsoNumber: 1, cwAbbrev: true,
    });
    LogManager.activateLog(log);
    await sleep(300);

    // ---- 2. the editor opens prefilled ------------------------------------
    await openMgr();
    check("every saved log has an Edit button",
      document.querySelectorAll('[data-act="edit"]').length >= 3,
      String(document.querySelectorAll('[data-act="edit"]').length));
    await clickEdit(log.id);
    check("the form switches to edit mode", $("lmFormTitle").textContent === "Edit log",
      $("lmFormTitle").textContent);
    check("the name is prefilled", $("lmContest").value === "EDITME", $("lmContest").value);
    check("the locator is prefilled", $("lmLoc").value === "JO70FD", $("lmLoc").value);
    check("a stored static exchange maps back to STATIC + its text",
      $("lmExchType").value === "STATIC" && $("lmExchStatic").value === "SK1",
      $("lmExchType").value + "/" + $("lmExchStatic").value);
    check("the STATIC row is unfolded", $("lmStaticRow").style.display !== "none");
    check("My call and the running number are hidden",
      $("lmMyCall").closest(".lm-row").style.display === "none" &&
      $("lmStartNr").closest(".lm-row").style.display === "none");
    check("hiding My call also drops its required attribute",
      !$("lmMyCall").hasAttribute("required"));
    check("Cancel is offered", !$("lmEditCancel").hidden);

    // ---- 3. saving writes only the four editable fields --------------------
    type($("lmContest"), "RENAMED");
    type($("lmLoc"), "JN79AB");
    pick($("lmExchType"), "NRLOC");
    $("lmCwAbbrev").checked = false;
    $("lmCwAbbrev").dispatchEvent(new Event("change", {bubbles: true}));
    await save();

    const saved = await LogDB.getLog(log.id);
    check("the save went through at all (required trap)",
      saved.contestName === "RENAMED", saved.contestName);
    check("the locator was written", saved.myLocator === "JN79AB", saved.myLocator);
    check("the exchange type was written", saved.defaultExchange === "NRLOC", saved.defaultExchange);
    check("cwAbbrev was written", saved.cwAbbrev === false, String(saved.cwAbbrev));
    check("the id is untouched", saved.id === log.id, saved.id);
    check("the callsign is untouched", saved.stationCall === "OK1HRA", saved.stationCall);
    check("the form returned to New log mode", $("lmFormTitle").textContent === "New log",
      $("lmFormTitle").textContent);
    check("Cancel is hidden again", $("lmEditCancel").hidden);
    check("required is back on My call", $("lmMyCall").hasAttribute("required"));

    // ---- 4. the active log picks the change up live -----------------------
    check("the LOG button shows the new name",
      $("btnOpenLog").textContent.indexOf("RENAMED") >= 0, $("btnOpenLog").textContent);
    check("the live log object was updated, not a stale copy",
      LogManager.getActiveLog().defaultExchange === "NRLOC",
      LogManager.getActiveLog().defaultExchange);
    $("btnOpenLog").click(); await sleep(200);   // close the manager
    const keyed = await keyExch("OK2ABC");
    check("macros key the new exchange format (NRLOC adds the locator)",
      /JN79AB/.test(keyed), keyed);
    check("cwAbbrev off means plain digits on the air", /001/.test(keyed), keyed);

    // ---- 5. editing the active log must not roll its counter back ---------
    await openMgr();
    await clickEdit(log.id);
    const before = LogManager.getActiveLog().nextQsoNumber;
    await LogManager.bumpQsoNumber();            // a QSO gets logged mid-dialog
    type($("lmContest"), "RENAMED2");
    await save();
    const afterBump = await LogDB.getLog(log.id);
    check("a QSO logged while the dialog was open keeps its number",
      afterBump.nextQsoNumber === before + 1,
      before + " -> " + afterBump.nextQsoNumber);

    // ---- 6. Cancel and closing discard the edit ---------------------------
    await openMgr();
    await clickEdit(offLog.id);
    type($("lmContest"), "NEVERSAVED");
    $("lmEditCancel").click();
    await sleep(300);
    const cancelled = await LogDB.getLog(offLog.id);
    check("Cancel writes nothing", cancelled.contestName === "ABBREVOFF", cancelled.contestName);
    check("Cancel returns the form to New log", $("lmFormTitle").textContent === "New log");

    await clickEdit(offLog.id);
    $("lmClose").click();
    await sleep(300);
    await openMgr();
    check("closing the dialog mid-edit does not reopen in edit mode",
      $("lmFormTitle").textContent === "New log" && $("lmMyCall").hasAttribute("required"),
      $("lmFormTitle").textContent);

    // ---- 7. the exchange note counts real QSOs ----------------------------
    await LogDB.addQso({logId: onLog.id, qsoNumber: 1, call: "OK9XYZ", timestampUtc: new Date().toISOString()});
    $("lmClose").click(); await sleep(200);
    await openMgr();
    await clickEdit(onLog.id);
    check("no note while the exchange is unchanged", $("lmExchNote").hidden);
    pick($("lmExchType"), "NRUTC");
    await sleep(150);
    check("changing the exchange warns, with the QSO count",
      !$("lmExchNote").hidden && /1 QSO/.test($("lmExchNote").textContent),
      $("lmExchNote").textContent);
    pick($("lmExchType"), "NR");
    await sleep(150);
    check("returning to the stored value clears the note", $("lmExchNote").hidden,
      $("lmExchNote").textContent);
    $("lmEditCancel").click(); await sleep(200);

    // ---- 8. the JS8 rename guard ------------------------------------------
    const js8 = await LogDB.createLog({
      contestName: "JS8CALL", stationCall: "OK1HRA",
      defaultExchange: "", myLocator: "JO70FD", startQsoNumber: 1,
    });
    $("lmClose").click(); await sleep(200);
    await openMgr();
    await clickEdit(js8.id);
    type($("lmContest"), "JS8CALL 2026");
    await save();
    const js8After = await LogDB.getLog(js8.id);
    check("renaming JS8CALL is not saved on the first click",
      js8After.contestName === "JS8CALL", js8After.contestName);
    check("the first click explains why", /JS8/.test($("lmFormStatus").textContent),
      $("lmFormStatus").textContent);
    await save();
    const js8Confirmed = await LogDB.getLog(js8.id);
    check("a second click commits the rename",
      js8Confirmed.contestName === "JS8CALL 2026", js8Confirmed.contestName);

    // Renaming some other log TO JS8CALL takes that traffic, so it warns too.
    await openMgr();
    await clickEdit(offLog.id);
    type($("lmContest"), "JS8CALL");
    await save();
    const hijack = await LogDB.getLog(offLog.id);
    check("renaming another log TO JS8CALL also warns first",
      hijack.contestName === "ABBREVOFF", hijack.contestName);

    // An ordinary rename must not be caught by the guard.
    await clickEdit(onLog.id);
    type($("lmContest"), "PLAINRENAME");
    await save();
    const plain = await LogDB.getLog(onLog.id);
    check("an ordinary rename saves on the first click",
      plain.contestName === "PLAINRENAME", plain.contestName);

    // ---- 9. NONE and the plain types round trip ---------------------------
    await openMgr();
    await clickEdit(js8.id);
    check("an empty exchange maps back to NONE", $("lmExchType").value === "",
      $("lmExchType").value);
    pick($("lmExchType"), "NRUTC");
    await save();
    await openMgr();
    await clickEdit(js8.id);
    check("a plain type round trips through the select",
      $("lmExchType").value === "NRUTC" && $("lmExchStatic").value === "",
      $("lmExchType").value + "/" + $("lmExchStatic").value);
    $("lmEditCancel").click();

    // ---- 10. creating a log still works after all that --------------------
    type($("lmContest"), "STILLWORKS");
    type($("lmMyCall"), "OK1HRA");
    await save();
    const logs = await LogDB.getLogs();
    check("the form still creates logs after being used as an editor",
      logs.some(l => l.contestName === "STILLWORKS"),
      logs.map(l => l.contestName).join(","));
  } catch (error) {
    check("the harness ran to the end", false, String(error && error.stack || error));
  }

  await fetch("/result", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({checks}),
  });
})();
`;

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
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

const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file === "string" && file.endsWith("log.html"))
    return Buffer.concat([content, Buffer.from(`\n<script>${PAGE_SCRIPT}</script>\n`)]);
  return content;
};
