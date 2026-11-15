#!/usr/bin/env node
"use strict";

// QRPlog: a frequency and/or mode typed into Call tunes the selected TRX on
// Enter (log.js parseCallQsy / qsyFromCall), checked in a real browser against
// a fixture that records what the page POSTed.
//
// The assertions sit on the wire -- /cmd, /cmd?trx=N, /oi3/set-hz -- because
// the risk runs both ways: a callsign taken for a frequency retunes the radio
// in the middle of a QSO, and a frequency taken for a callsign is keyed on
// the air.

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;
const posts = [];             // {url, body} of every POST to the radio, in order
let connected = true;
let modeError = "";           // a /cmd setMode answer to fail with, "" = ok

function stateJson() {
  return {
    connected, catHealthy: true, audioReady: false, lanStatus: "linked",
    btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
    fullCat: true, wifiRssi: -55, fwRev: "20261115", bdSupported: false,
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
  const line = `LOG CALL QSY ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
  (failed.length ? console.error : console.log)(line);
  if (failed.length) process.exitCode = 1;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  const json = (body, status) => {
    response.writeHead(status || 200, {"Content-Type": "application/json"});
    response.end(JSON.stringify(body));
  };
  const readBody = fn => {
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => fn(body));
  };

  if (url.pathname === "/result" && request.method === "POST") {
    return readBody(body => { response.writeHead(204).end(); finish(JSON.parse(body)); });
  }

  if ((url.pathname === "/cmd" || url.pathname === "/oi3/set-hz") && request.method === "POST") {
    return readBody(body => {
      let parsed;
      try { parsed = JSON.parse(body); } catch (_) { parsed = {raw: body}; }
      posts.push({url: url.pathname + url.search, body: parsed});
      if (parsed.type === "setMode" && modeError) return json({error: modeError}, 409);
      json({ok: true});
    });
  }

  if (url.pathname === "/posts") return json(posts);
  if (url.pathname === "/posts/clear") { posts.length = 0; return json({ok: true}); }
  if (url.pathname === "/connected") { connected = url.searchParams.get("on") === "1"; return json({ok: true}); }
  if (url.pathname === "/mode-error") { modeError = url.searchParams.get("e") || ""; return json({ok: true}); }

  if (url.pathname === "/state" || url.pathname === "/oi3/state") return json(stateJson());
  if (url.pathname === "/dxcinfo") return json({locator: "JO70", call: "OK1HRA"});
  if (url.pathname === "/log-config") {
    return json({
      trx1Label: "TRX1", trx2Label: "TRX2", trx3Label: "TRX3",
      trx2enabled: true, trx3enabled: false, blockedDxcc: "",
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
  const call = () => $("inpCall");

  async function posts() { return (await fetch("/posts")).json(); }
  async function clearPosts() { await fetch("/posts/clear"); }
  function type(value) {
    call().value = value;
    call().dispatchEvent(new Event("input", {bubbles: true}));
  }
  function enter() {
    call().focus();
    call().dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
  }
  // What a typed text sent: the posts, compacted to "url type value".
  async function run(text) {
    await clearPosts();
    type(text);
    enter();
    await sleep(400);
    return (await posts()).map(p =>
      p.url + " " + (p.body.type || "") + " " + (p.body.frequency || p.body.hz || p.body.mode || p.body.text || ""));
  }
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  try {
    for (let i = 0; i < 60 && !(window.LogRadio && LogRadio.frequency()); i++) await sleep(100);
    await sleep(500);

    let got;
    got = await run("14025");
    check("14025 tunes TRX1 to 14025 kHz, nothing else",
      eq(got, ["/cmd setFrequency 14025000"]), JSON.stringify(got));
    check("and empties Call", call().value === "", call().value);

    got = await run("7.074");
    check("7.074 is MHz", eq(got, ["/cmd setFrequency 7074000"]), JSON.stringify(got));

    got = await run("14025,5");
    check("a decimal comma in kHz", eq(got, ["/cmd setFrequency 14025500"]), JSON.stringify(got));

    got = await run("14025CW");
    check("14025CW: frequency, then mode",
      eq(got, ["/cmd setFrequency 14025000", "/cmd setMode CW"]), JSON.stringify(got));

    got = await run("cw3525");
    check("cw3525: mode first, lower case",
      eq(got, ["/cmd setFrequency 3525000", "/cmd setMode CW"]), JSON.stringify(got));

    got = await run("USB");
    check("USB alone sets only the mode", eq(got, ["/cmd setMode USB"]), JSON.stringify(got));

    got = await run("SSB");
    check("SSB on 14 MHz (the radio's) is USB", eq(got, ["/cmd setMode USB"]), JSON.stringify(got));

    got = await run("3700SSB");
    check("3700SSB is LSB", eq(got, ["/cmd setFrequency 3700000", "/cmd setMode LSB"]), JSON.stringify(got));

    got = await run("5357SSB");
    check("60 m SSB is USB", eq(got, ["/cmd setFrequency 5357000", "/cmd setMode USB"]), JSON.stringify(got));

    got = await run("144.3FM");
    check("144.3FM", eq(got, ["/cmd setFrequency 144300000", "/cmd setMode FM"]), JSON.stringify(got));

    got = await run("FSK");
    check("FSK is RTTY", eq(got, ["/cmd setMode RTTY"]), JSON.stringify(got));

    // ---- callsigns are never taken -----------------------------------------
    for (const c of ["OK1HRA", "CW5ABC", "FM5XY", "DV1ABC", "AM70X", "OK", "9A1A", "2E0ABC"]) {
      got = await run(c);
      check(c + " is a callsign, not a QSY",
        !got.some(g => /setFrequency|setMode|set-hz/.test(g)), JSON.stringify(got));
      type("");
      $("inpExch").value = "";
    }

    // ---- not a frequency: a hint, nothing on the air ------------------------
    got = await run("59");
    check("59 sends nothing", got.length === 0, JSON.stringify(got));
    check("59 stays in Call", call().value === "59", call().value);
    check("and says why", /not a frequency/.test($("logHint").textContent), $("logHint").textContent);
    got = await run("CW14025USB");
    check("two modes send nothing", got.length === 0, JSON.stringify(got));
    type("");

    // ---- the radio's refusal is shown ---------------------------------------
    await fetch("/mode-error?e=unsupported_transport");
    got = await run("7030CW");
    check("a refused mode still tuned first",
      eq(got, ["/cmd setFrequency 7030000", "/cmd setMode CW"]), JSON.stringify(got));
    await sleep(200);
    check("the refusal is in the hint", /TrxNet/.test($("logHint").textContent), $("logHint").textContent);
    await fetch("/mode-error?e=");

    // ---- TRX2: /oi3/set-hz and /cmd?trx=2 ----------------------------------
    $("btnTrx2").click();
    await sleep(600);
    got = await run("21025CW");
    check("TRX2: frequency over /oi3/set-hz, mode over /cmd?trx=2",
      eq(got, ["/oi3/set-hz  21025000", "/cmd?trx=2 setMode CW"]), JSON.stringify(got));
    $("btnTrx1").click();
    await sleep(600);

    // ---- disconnected: the manual fields ------------------------------------
    await fetch("/connected?on=0");
    for (let i = 0; i < 30 && LogRadio.frequency(); i++) await sleep(100);
    await sleep(300);
    got = await run("3525CW");
    check("disconnected: nothing is sent", got.length === 0, JSON.stringify(got));
    check("the manual frequency takes it", $("sbManualFreq").value === "3525", $("sbManualFreq").value);
    check("the manual mode takes it", $("sbManualMode").value === "CW", $("sbManualMode").value);
    check("and the log would use it", LogRadio.logFrequency() === 3525000, String(LogRadio.logFrequency()));
    await fetch("/connected?on=1");
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
    "--no-proxy-server", "--mute-audio", `http://127.0.0.1:${port}/log.html`,
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
