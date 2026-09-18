#!/usr/bin/env node
"use strict";

// QRPLog's TX serial offset, checked in a real browser against a fixture that
// records what the page actually POSTed to /cmd.
//
// The feature lets an operator running one continuous log send contest serials
// from 001 -- "log QSO #721 is serial 001" -- without touching the log's own
// numbering. That split is the whole point and also the whole risk: the number
// on the air and the number in the database deliberately disagree, so both have
// to be pinned down at once. Every assertion here therefore sits either on the
// wire (the body of /cmd) or on the stored QSO record, never on what the page
// renders -- the EXCH label can read 001 while the key sends 721.
//
// Two behaviours are easy to get backwards and are each checked directly:
//   * an F5 must NOT drop the offset (restoreActiveLog goes through the same
//     activateLog() as a deliberate switch), but opening another log MUST;
//   * a base past the end of the log must refuse to save rather than quietly
//     key 000 or a negative serial.

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;
const commands = [];          // every /cmd body the page sent, in order
let currentMode = "CW";

// Only NRQ is overridden, so {NR}/{PREVNR} get exercised on their own rather
// than only through {EXCH}; loadMacroStore() merges this over MacroDefaults, so
// every other template stays exactly as the firmware ships it.
const macroStore = {cw: {NRQ: "{NR} {PREVNR}"}, rtty: {NRQ: "{NR} {PREVNR}"}};

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
  const line = `LOG SERIAL OFFSET ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
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
    return json(macroStore);
  }

  // Lets the browser side read back what reached the firmware.
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
  // SERIAL_OFFSET_SMOKE_MINIFIED=1 serves the terser output the device actually
  // ships, so a mangled name in the new code fails here rather than on the air.
  if (process.env.SERIAL_OFFSET_SMOKE_MINIFIED === "1" && file.endsWith(".js")
      && fs.existsSync(file + ".min")) file = file + ".min";
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

  async function clearCommands() { await fetch("/commands/clear"); }
  async function lastSent() {
    const r = await fetch("/commands");
    const list = await r.json();
    return list.length ? String(list[list.length - 1].text || "") : "";
  }
  async function settle() { await sleep(350); }

  function type(el, value) {
    el.value = value;
    el.dispatchEvent(new Event("input", {bubbles: true}));
  }
  function enter(el) {
    el.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
  }
  function lbl() { return ($("lblExch") || {}).textContent || ""; }

  // Fires TXEXCH from RUN mode and returns what reached /cmd.
  async function keyExch(callsign) {
    await clearCommands();
    const call = $("inpCall");
    type(call, callsign);
    call.focus();
    enter(call);
    await settle();
    return lastSent();
  }

  // Runs one whole QSO through the Enter workflow, leaving the form clear.
  async function logOne(callsign, exchange) {
    const call = $("inpCall"), exch = $("inpExch");
    type(call, callsign);
    call.focus();
    enter(call);
    await settle();
    type(exch, exchange);
    exch.focus();
    enter(exch);
    await sleep(700);
  }

  async function openEditor() {
    $("btnMacros").click();
    await sleep(250);
  }
  function setOffset(on, base) {
    const chk = $("mxSerialEnable"), inp = $("mxSerialBase");
    chk.checked = !!on;
    chk.dispatchEvent(new Event("change", {bubbles: true}));
    if (base !== undefined) {
      inp.value = String(base);
      inp.dispatchEvent(new Event("input", {bubbles: true}));
    }
  }

  try {
    for (let i = 0; i < 60 && !window.LogMacros; i++) await sleep(100);
    await sleep(900);

    // A log of 720 QSO: nextQsoNumber 721 is the number the operator would map
    // onto serial 001. startQsoNumber seeds it without writing 720 rows.
    const logA = await LogDB.createLog({
      contestName: "SMOKEA", stationCall: "OK1HRA",
      defaultExchange: "NR", myLocator: "JO70", startQsoNumber: 721,
    });
    LogManager.activateLog(logA);
    await sleep(300);

    // ---- 1. offset off: nothing whatsoever changes -------------------------
    check("the label is plain EXCH while the offset is off", lbl() === "EXCH", lbl());
    const rawKeyed = await keyExch("OK2ABC");
    check("the log's own number goes on the air while off", /\\b721\\b/.test(rawKeyed), rawKeyed);

    // ---- 2. the editor prefills the number the operator needs --------------
    await openEditor();
    check("the offset section is in the macro editor", !!$("mxSerialEnable") && !!$("mxSerialBase"));
    check("the base prefills with the log's next number", $("mxSerialBase").value === "721",
      $("mxSerialBase").value);
    check("the note explains the off state",
      /721/.test($("mxSerialNote").textContent), $("mxSerialNote").textContent);

    // ---- 3. a base past the end of the log refuses to save ----------------
    setOffset(true, 800);
    await sleep(120);
    check("a base past the end of the log is flagged",
      $("mxSerialNote").classList.contains("mx-serial-bad"), $("mxSerialNote").textContent);
    $("mxSave").click();
    await sleep(500);
    check("the rejected base leaves the dialog open", !$("macroEditorModal").classList.contains("lm-hidden"));
    const afterReject = await LogDB.getLog(logA.id);
    check("the rejected base writes nothing to the log record", !afterReject.txSerialEnabled,
      String(afterReject.txSerialEnabled));

    // ---- 4. a valid base saves and takes effect ---------------------------
    setOffset(true, 721);
    await sleep(120);
    check("a valid base previews the resulting serial",
      /001/.test($("mxSerialNote").textContent) &&
      !$("mxSerialNote").classList.contains("mx-serial-bad"), $("mxSerialNote").textContent);
    $("mxSave").click();
    await sleep(900);
    const savedA = await LogDB.getLog(logA.id);
    check("the offset is stored on the log record",
      savedA.txSerialEnabled === true && savedA.txSerialBase === 721,
      savedA.txSerialEnabled + "/" + savedA.txSerialBase);
    check("the label shows the serial that goes on the air", lbl() === "001|EXCH", lbl());

    // ---- 5. the air carries the shifted serial ----------------------------
    const shifted = await keyExch("OK2ABC");
    check("the shifted serial is keyed, CW-abbreviated", /TT1/.test(shifted), shifted);
    check("the log's own number is not keyed", !/721/.test(shifted), shifted);

    // ---- 6. the stored QSO keeps the log's own number ---------------------
    await logOne("OK3XYZ", "001");
    const qsos = await LogDB.getQsosForLog(logA.id);
    const qso = qsos.find(q => q.call === "OK3XYZ");
    check("the QSO was stored", !!qso);
    check("the stored qsoNumber is the log's own, not the shifted one",
      qso && qso.qsoNumber === 721, qso && String(qso.qsoNumber));
    check("the label advances with the log", lbl() === "002|EXCH", lbl());
    const second = await keyExch("OK4DEF");
    check("the next QSO keys the next shifted serial", /TT2/.test(second), second);

    // ---- 7. {NR} and {PREVNR} shift together ------------------------------
    await logOne("OK5GHI", "002");          // nextQsoNumber -> 723, shifted 003
    await clearCommands();
    $("btnNrQ").click();
    await settle();
    const nrq = await lastSent();
    check("{NR} and {PREVNR} both carry shifted serials", /TT3/.test(nrq) && /TT2/.test(nrq), nrq);

    // ---- 8. RTTY sends digits, shifted the same way -----------------------
    await fetch("/setMode?mode=RTTY");
    await sleep(1600);
    const rtty = await keyExch("OK6JKL");
    check("RTTY keys the shifted serial as plain digits",
      /003/.test(rtty) && !/TT3/.test(rtty), rtty);
    await fetch("/setMode?mode=CW");
    await sleep(1600);

    // ---- 9. runtime clamp: the log moves under a saved base ---------------
    const live = LogManager.getActiveLog();
    const restore = live.nextQsoNumber;
    live.nextQsoNumber = 700;               // as if QSOs had been deleted
    const clamped = await keyExch("OK7MNO");
    check("a base past the log clamps to 001 instead of keying 000 or negative",
      /TT1/.test(clamped) && !/-/.test(clamped), clamped);
    live.nextQsoNumber = restore;
    await LogDB.updateLog(live);

    // ---- 10. an F5 must not drop the offset -------------------------------
    await LogManager.restoreActiveLog();
    await sleep(400);
    const afterRestore = LogManager.getActiveLog();
    check("restoring the same log on reload keeps the offset on",
      !!afterRestore && afterRestore.txSerialEnabled === true,
      afterRestore && String(afterRestore.txSerialEnabled));
    check("the label survives a reload", lbl().indexOf("|EXCH") > 0, lbl());

    // ---- 11. opening another log must drop it -----------------------------
    const logB = await LogDB.createLog({
      contestName: "SMOKEB", stationCall: "OK1HRA",
      defaultExchange: "NR", myLocator: "JO70", startQsoNumber: 1,
    });
    LogManager.activateLog(logB);
    await sleep(500);
    const switchedA = await LogDB.getLog(logA.id);
    check("switching logs turns the offset off", switchedA.txSerialEnabled === false,
      String(switchedA.txSerialEnabled));
    check("the base is kept for when the log is reopened", switchedA.txSerialBase === 721,
      String(switchedA.txSerialBase));
    check("the label is plain EXCH in the new log", lbl() === "EXCH", lbl());
    const inB = await keyExch("OK8PQR");
    check("the new log keys its own numbering", /TT1/.test(inB), inB);

    // ---- 12. Cancel discards an unsaved offset ----------------------------
    LogManager.activateLog(await LogDB.getLog(logA.id));
    await sleep(400);
    await openEditor();
    check("the reopened log offers its remembered base", $("mxSerialBase").value === "721",
      $("mxSerialBase").value);
    setOffset(true, 721);
    await sleep(120);
    check("an unsaved change raises the dirty dot", !$("mxSerialDot").hidden);
    $("mxCancel").click();
    await sleep(400);
    const afterCancel = await LogDB.getLog(logA.id);
    check("Cancel writes nothing", afterCancel.txSerialEnabled === false,
      String(afterCancel.txSerialEnabled));
    check("the label stays plain after Cancel", lbl() === "EXCH", lbl());
    // ---- 13. the offset must not block editing macros with no log open ----
    LogManager.activateLog(null);
    await sleep(400);
    await openEditor();
    check("the offset controls are disabled with no log open",
      $("mxSerialEnable").disabled && $("mxSerialBase").disabled);
    check("the note says why", /No log open/.test($("mxSerialNote").textContent),
      $("mxSerialNote").textContent);
    $("mxSave").click();
    await sleep(900);
    check("macros still save with no log open",
      $("macroEditorModal").classList.contains("lm-hidden"), $("mxStatus").textContent);
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
  // 127.0.0.1 and not a .test host: the log page uses IndexedDB and asks about
  // storage persistence, which needs a secure context.
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

// The fixture appends the test script to log.html on the way out, so the page
// under test is byte-identical to production apart from that one tag.
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file === "string" && file.endsWith("log.html"))
    return Buffer.concat([content, Buffer.from(`\n<script>${PAGE_SCRIPT}</script>\n`)]);
  return content;
};
