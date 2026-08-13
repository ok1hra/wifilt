#!/usr/bin/env node
"use strict";

// The contest log's Alt hotkeys, driven in a real browser.
//
// Why this harness exists: Alt+U (RUN/S&P) and Alt+W (clear form) were reported
// dead while Alt+1/2/3 and Alt+Enter worked. The handler matched on
// KeyboardEvent.key alone, and key is the *character the layout produces*, which
// under Alt is not reliably the letter on the keycap:
//
//   CapsLock on          Alt+U -> key "U"     (not "u")
//   macOS Option         Alt+U -> key "Dead"  (diaeresis), Alt+W -> key "∑"
//   Alt+1 on macOS       key "¡"
//
// Digits and Enter survive all of that, which is exactly the reported symptom.
// The checks below send each of those event shapes; they are what the browser
// hands the page, not an invention of the test. code ("KeyU") is the physical
// key and is immune to layout and CapsLock, so that is what the page now reads.

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;
const commands = [];

function stateJson() {
  return {
    connected: true, catHealthy: true, audioReady: false, lanStatus: "linked",
    btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
    fullCat: true, wifiRssi: -55, fwRev: "20260812", bdSupported: false,
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
  const line = `LOG HOTKEYS ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
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
    request.on("end", () => { commands.push(body); json({ok: true}); });
    return;
  }

  if (url.pathname === "/state") return json(stateJson());
  if (url.pathname === "/dxcinfo") return json({locator: "JO70", call: "OK1HRA"});
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70"});
  if (url.pathname === "/log-config") {
    return json({
      trx1Label: "TRX1", trx2Label: "TRX2", trx3Label: "TRX3",
      trx2enabled: true, trx3enabled: false, blockedDxcc: "",
    });
  }

  const file = url.pathname === "/" ? path.join(data, "log.html")
                                    : path.join(data, path.basename(url.pathname));
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

  // One keystroke, described the way the browser describes it: the character the
  // layout produced (key) and the physical key (code) are given separately.
  function press(key, code, extra) {
    const init = Object.assign({key: key, code: code, altKey: true, bubbles: true,
                                cancelable: true}, extra || {});
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", init));
  }
  const isSP  = () => $("btnRunMode").textContent.indexOf("S") === 0;
  const toRun = () => { if (isSP()) $("btnRunMode").click(); };

  try {
    for (let i = 0; i < 60 && !window.LogMacros; i++) await sleep(100);
    await sleep(700);

    const log = await LogDB.createLog({
      contestName: "HOTKEY", stationCall: "OK1HRA",
      defaultExchange: "NR", myLocator: "JO70", startQsoNumber: 1,
    });
    LogManager.activateLog(log);
    await sleep(200);

    const call = $("inpCall"), exch = $("inpExch");

    // ---- Alt+U, in every shape a keyboard can deliver it --------------------
    const uShapes = [
      ["plain layout, CapsLock off", "u", "KeyU"],
      ["CapsLock on",                "U", "KeyU"],
      ["macOS Option (dead key)",    "Dead", "KeyU"],
    ];
    for (const [what, key, code] of uShapes) {
      toRun();
      await sleep(50);
      press(key, code);
      await sleep(80);
      check("Alt+U toggles RUN/S&P -- " + what, isSP(), $("btnRunMode").textContent);
    }
    toRun();

    // ---- Alt+W, likewise ----------------------------------------------------
    const wShapes = [
      ["plain layout, CapsLock off", "w", "KeyW"],
      ["CapsLock on",                "W", "KeyW"],
      ["macOS Option",               "\\u2211", "KeyW"],
    ];
    for (const [what, key, code] of wShapes) {
      call.value = "OK2ABC";
      call.dispatchEvent(new Event("input", {bubbles: true}));
      exch.value = "001";
      await sleep(80);
      press(key, code);
      await sleep(80);
      check("Alt+W clears the form -- " + what, call.value === "" && exch.value === "",
        JSON.stringify(call.value + "/" + exch.value));
    }

    // ---- Alt+1/2/3 keep working, including where the layout mangles them ----
    const trx = n => $("btnTrx" + n) || document.querySelector('[data-trx="' + n + '"]');
    press("2", "Digit2");
    await sleep(120);
    check("Alt+2 selects TRX2", app.activeTrx === 2, "TRX" + app.activeTrx);
    press("\\u00a1", "Digit1");           // macOS Option+1
    await sleep(120);
    check("Alt+1 selects TRX1 on a layout that rewrites the digit",
      app.activeTrx === 1, "TRX" + app.activeTrx);

    // ---- The guards the hotkeys must keep ----------------------------------
    toRun();
    call.focus();
    press("u", "KeyU", {altKey: false});
    await sleep(80);
    check("plain U typed into the call field does not toggle the mode", !isSP());

    // AltGr on Windows arrives as Ctrl+Alt; it types a character and must not
    // be read as a hotkey.
    press("u", "KeyU", {ctrlKey: true});
    await sleep(80);
    check("AltGr (Ctrl+Alt) is not the hotkey", !isSP());

    press("u", "KeyU", {shiftKey: true});
    await sleep(80);
    check("Shift+Alt+U is not the hotkey", !isSP());

    // ---- Alt+Enter still logs without keying -------------------------------
    call.value = "OK5XYZ";
    call.dispatchEvent(new Event("input", {bubbles: true}));
    exch.value = "007";
    exch.dispatchEvent(new Event("input", {bubbles: true}));
    await sleep(100);
    press("Enter", "Enter");
    await sleep(700);
    const stored = (await LogDB.getQsosForLog(log.id)).find(q => q.call === "OK5XYZ");
    check("Alt+Enter logs the QSO", !!stored);
  } catch (error) {
    check("the test script ran to the end", false, String(error && error.stack || error));
  }

  await fetch("/result", {method: "POST", body: JSON.stringify({checks})});
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

// The fixture appends the test script to log.html on the way out, so the page
// under test is byte-identical to production apart from that one tag.
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file === "string" && file.endsWith("log.html"))
    return Buffer.concat([content, Buffer.from(`\n<script>${PAGE_SCRIPT}</script>\n`)]);
  return content;
};
