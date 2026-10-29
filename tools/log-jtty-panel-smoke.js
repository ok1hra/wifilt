#!/usr/bin/env node
"use strict";

// QRPLog's JTTY palette in a real browser (data/log-jtty-panel.js,
// docs/jtty-implementace.md §7), against the same fixture firmware shape as
// tools/log-rtty-panel-smoke.js. What is checked is everything QRPLog does
// with JTTY, through EVERY TX entry point -- the RTTY palette's first on-air
// test found the macros going one way and Enter another:
//
//   * the button, the palette, its lease (role jtty), and that it and the
//     RTTY palette are never open together;
//   * macros, Alt+K and Esc routed to the palette while it holds the session,
//     with the JTTY macro set (compact frames) and the exchange profile;
//   * a word clicked in the palette lands in Call;
//   * a JTTY QSO is logged as JTTY and exported as MFSK / JTTY;
//   * the macro editor has its JTTY tab.
//
//   node tools/log-jtty-panel-smoke.js
//   JTTY_PANEL_SMOKE_MINIFIED=1 node tools/log-jtty-panel-smoke.js

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;
const sessionPosts = [];
let sessionRole = "jtty";
let macrosSaved = null;

function finish(result) {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  if (chrome) {
    chrome.kill("SIGTERM");
    setTimeout(() => chrome && chrome.kill("SIGKILL"), 2000).unref();
  }
  const checks = (result && result.checks) || [];
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? `  -- ${detail}` : ""}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  setTimeout(() => process.exit(failed ? 1 : 0), 150).unref();
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  const json = body => {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify(body));
  };
  const readBody = done => {
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => done(body));
  };
  if (url.pathname === "/result" && request.method === "POST")
    return readBody(body => { response.writeHead(204).end(); finish(JSON.parse(body)); });
  if (url.pathname === "/session-posts") return json(sessionPosts);
  if (url.pathname === "/session-posts/clear") { sessionPosts.length = 0; return json({ok: true}); }
  if (url.pathname === "/set-role") { sessionRole = url.searchParams.get("v") || ""; return json({ok: true}); }
  if (url.pathname === "/macros-saved") return json(macrosSaved);
  if (url.pathname === "/setup-data.json") return json({
    trx1transport: "lan", trx1lanip: "192.168.1.50", trx1lanuser: "user", trx1lanpass: "pass", trx1model: "IC-705",
  });
  if (url.pathname.startsWith("/js8/session")) {
    if (request.method === "POST") return readBody(body => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) {}
      sessionPosts.push({path: url.pathname, body: parsed});
      json({ok: true});
    });
    return json({held: Boolean(sessionRole), role: sessionRole});
  }
  if (url.pathname === "/state") return json({
    connected: true, catHealthy: true, audioReady: true, lanStatus: "linked",
    btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
    fullCat: true, wifiRssi: -55, fwRev: "20261029", bdSupported: false,
    power: true, frequency: 14090000, mode: "USB-D", filter: 1,
    radioAddress: "a4", transceiverType: "IC-705", radioName: "IC-705",
    tx: false, ritRaw: 0, smeterRaw: 0, powerMeterRaw: 0, afGain: 100,
    keySpeed: 20, rfPower: 128, rfPowerSeen: true, supplyVolts: 13.8, swr: 1.1,
    preamp: 0, vox: 0, dxcConnected: false,
  });
  if (url.pathname === "/cmd" && request.method === "POST") return readBody(() => json({ok: true, seq: 0}));
  if (url.pathname === "/civread") return json({seq: 0, cmd: null, reply: null});
  if (url.pathname === "/txgain.json") return json({v: 1, entries: {}});
  if (url.pathname === "/txgain-plan.json") return json({});
  if (url.pathname === "/dxcinfo") return json({locator: "JO70", call: "OK1HRA"});
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70"});
  if (url.pathname === "/log-config") return json({trx1Label: "TRX1", trx2Label: "TRX2", trx3Label: "TRX3",
    trx2enabled: false, trx3enabled: false, blockedDxcc: ""});
  if (url.pathname === "/log-macros.json") {
    if (request.method === "POST") return readBody(body => { macrosSaved = JSON.parse(body); json({ok: true}); });
    return json({});
  }
  if (url.pathname === "/pa.json") return json({state: "ok", present: false});
  if (url.pathname === "/js8-config.json") return json({});

  let file = url.pathname === "/" ? path.join(data, "log.html") : path.join(data, path.basename(url.pathname));
  if (process.env.JTTY_PANEL_SMOKE_MINIFIED === "1" && file.endsWith(".js") && fs.existsSync(file + ".min")) file = file + ".min";
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    response.writeHead(200, {"Content-Type": mime[path.extname(url.pathname)] || mime[path.extname(file)] || "text/plain"});
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
  const errors = window.__jttyPanelSmokeErrors;
  const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(50); } return pred(); };
  const posts = async () => await (await fetch("/session-posts")).json();

  try {
    await sleep(1800);
    check("QRPLog booted with the JTTY scripts, no error", errors.length === 0, errors.slice(0, 3).join(" | "));
    check("the JTTY palette module is there", !!window.JttyPanel && !!window.RttyPanel);
    check("the JTTY button shows in USB-D", !$("btnJttyPopup").hidden);
    check("the palette knows the link is there", window.JttyPanel.lanReady() === true, String(window.JttyPanel.lanReady()));

    // ---- 1. open: lease, layout ---------------------------------------------
    await fetch("/session-posts/clear");
    $("btnJttyPopup").click();
    await sleep(700);
    const panel = $("jttyPanel");
    check("the button opens the palette", window.JttyPanel.isOpen() && panel && panel.style.display !== "none");
    const claims = (await posts()).filter(p => p.path.endsWith("/claim"));
    check("it claims the session as role jtty, without force",
      claims.length === 1 && claims[0].body.role === "jtty" && !claims[0].body.force, JSON.stringify(claims));
    check("its waterfall took a real width", $("jttyPanelWaterfallCanvas").width >= 320, String($("jttyPanelWaterfallCanvas").width));
    check("the RX area starts with its placeholder", /Waiting/.test($("jttyPanelRx").textContent));

    // ---- 2. never together with the RTTY palette --------------------------------
    window.RttyPanel.setOpen(true);
    await sleep(800);
    check("opening RTTY closes JTTY", window.RttyPanel.isOpen() && !window.JttyPanel.isOpen());
    const rttyClaims = (await posts()).filter(p => p.path.endsWith("/claim") && p.body.role === "rtty");
    check("RTTY claims after the hand-over", rttyClaims.length === 1, JSON.stringify(await posts()));
    window.JttyPanel.setOpen(true);
    await sleep(800);
    check("and opening JTTY closes RTTY", window.JttyPanel.isOpen() && !window.RttyPanel.isOpen());
    const geometry = JSON.parse(localStorage.getItem("wifilt-jtty-panel") || "{}");
    check("the open state is remembered", geometry.open === true, JSON.stringify(geometry));

    // ---- 3. every TX entry point goes through the palette --------------------------
    await waitFor(() => app.aud1Role === "jtty", 4000);
    check("QRPLog sees JTTY holding AUD1", app.aud1Role === "jtty", app.aud1Role);
    const sends = [];
    window.JttyPanel.holdsSession = () => true;
    window.JttyPanel.send = (text, options) => { sends.push({text, options}); return Promise.resolve(); };
    const realActive = LogManager.getActiveLog;
    LogManager.getActiveLog = () => ({stationCall: "OK1HRA", defaultExchange: "NR", nextQsoNumber: 7});
    inpCall.value = "DL1ABC";
    sendMacroText("CQ");
    sendMacroText("TXEXCH");
    sendMacroText("CALLTU");
    sendMacroText("NRQ");
    await sleep(100);
    check("CQ is the compact JTTY one", sends[0] && sends[0].text === "CQ OK1HRA CQ", JSON.stringify(sends[0]));
    check("the exchange is '599 007', spaced, no dashes", sends[1] && sends[1].text === "DL1ABC 599 007", JSON.stringify(sends[1]));
    check("a numbered exchange packs as RTTY Roundup", sends[1] && sends[1].options.profile === "rtty-roundup", JSON.stringify(sends[1]));
    check("CALLTU and NR? are the JTTY ones", sends[2] && sends[2].text === "DL1ABC TU" && sends[3] && sends[3].text === "NR?",
      JSON.stringify(sends.slice(2)));
    check("which fit 1 + 2 + 1 + 1 frames", sends.slice(0, 4).map(s => JttyCodec.packText(s.text, {profile: JttyCodec.PROFILE.RTTY}).frames.length).join() === "1,2,1,1");
    LogManager.getActiveLog = () => ({stationCall: "OK1HRA", defaultExchange: "05", nextQsoNumber: 7});
    sendMacroText("TXEXCH");
    await sleep(50);
    check("a free exchange stays Unknown (a zone is not a serial)", sends[4] && sends[4].options.profile === "unknown" && sends[4].text === "DL1ABC 599 05",
      JSON.stringify(sends[4]));
    LogManager.getActiveLog = realActive;

    // Alt+K
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "k", altKey: true, bubbles: true}));
    await sleep(100);
    check("Alt+K opens with the JTTY route", !$("freeTxBar").hidden && /^JTTY/.test($("freeTxRoute").textContent), $("freeTxRoute").textContent);
    check("and JTTY's 80-character limit", $("inpFreeTx").maxLength === 80, String($("inpFreeTx").maxLength));
    $("inpFreeTx").value = "TNX FER QSO 73";
    $("inpFreeTx").dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
    await sleep(100);
    check("Alt+K text goes out as typed, no CR/LF framing", sends[5] && sends[5].text === "TNX FER QSO 73", JSON.stringify(sends[5]));

    // Esc
    let aborted = 0;
    const realBusy = window.JttyPanel.txBusy, realAbort = window.JttyPanel.abort;
    window.JttyPanel.txBusy = () => true;
    window.JttyPanel.abort = () => { aborted++; };
    inpCall.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    await sleep(50);
    check("Esc stops a JTTY transmission", aborted >= 1, String(aborted));
    window.JttyPanel.txBusy = realBusy; window.JttyPanel.abort = realAbort;

    // ---- 4. a word from the palette into Call --------------------------------------
    inpCall.value = "";
    const rx = $("jttyPanelRx");
    const line = document.createElement("div");
    line.className = "jtty-line";
    line.innerHTML = '<span class="jtty-text"><span class="jtty-tok">CQ</span> <span class="jtty-tok">G4XYZ</span> <span class="jtty-tok">CQ</span></span>';
    rx.appendChild(line);
    inpCall.focus();
    const tok = line.querySelectorAll(".jtty-tok")[1];
    tok.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}));
    tok.click();
    await sleep(100);
    check("a clicked word lands in Call", inpCall.value === "G4XYZ", inpCall.value);

    // ---- 5. logging and export ---------------------------------------------------------
    check("a USB-D QSO with JTTY holding AUD1 is logged as JTTY", loggedMode() === "JTTY", loggedMode());
    check("ADIF: MODE=MFSK SUBMODE=JTTY", LogExport.adifModeMap("JTTY") === "MFSK" && LogExport.adifSubmode("JTTY") === "JTTY");

    // ---- 6. the macro editor has its JTTY tab --------------------------------------------
    openMacroEditor();
    await sleep(100);
    check("the editor opens on the JTTY tab", $("mxTabJtty") && $("mxTabJtty").classList.contains("lm-btn-primary") &&
      !$("mxPanelJtty").classList.contains("lm-hidden"));
    check("with the JTTY defaults", $("mx_jtty_CQ") && $("mx_jtty_CQ").value === "CQ {MYCALL} CQ", $("mx_jtty_CQ") && $("mx_jtty_CQ").value);
    $("mx_jtty_NRQ").value = "AGN?";
    $("mx_jtty_NRQ").dispatchEvent(new Event("input"));
    $("mxSave").click();
    await sleep(400);
    const saved = await (await fetch("/macros-saved")).json();
    check("Save stores the jtty half beside cw and rtty", saved && saved.jtty && saved.jtty.NRQ === "AGN?" && saved.rtty && saved.cw,
      JSON.stringify(saved && Object.keys(saved)));

    // ---- 7. off with the JTTY role, back to RTTY's refusals -------------------------------
    await fetch("/set-role?v=");
    await waitFor(() => app.aud1Role === "", 5000);
    check("with nobody holding AUD1 the Alt+K route says where to go",
      /RTTY or JTTY palette/.test(freeTxRoute().why || ""), JSON.stringify(freeTxRoute()));

    window.JttyPanel.setOpen(false);
    await sleep(300);
    check("closing releases the session", (await posts()).some(p => p.path.endsWith("/release")));
    check("nothing on the way threw", errors.length === 0, errors.join(" | "));
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
    "--no-proxy-server", "--window-size=1400,950",
    ...(process.env.JTTY_SMOKE_DEBUG ? ["--enable-logging=stderr", "--v=0"] : []),
    `http://127.0.0.1:${port}/log.html`,
  ], {stdio: ["ignore", "ignore", "pipe"]});
  let chromeErrors = "";
  chrome.stderr.on("data", chunk => {
    chromeErrors += chunk;
    if (process.env.JTTY_SMOKE_DEBUG) for (const l of String(chunk).split("\n")) if (/CONSOLE|Uncaught/.test(l)) console.log(l.slice(0, 300));
  });
  chrome.on("error", error => finish({checks: [["chrome started", false, error.message]]}));
  chrome.on("close", code => {
    if (!finished) finish({checks: [["chrome stayed up", false, `exit ${code} ${chromeErrors.slice(-400)}`]]});
  });
  timer = setTimeout(() => finish({checks: [["the page reported within the timeout", false, "no /result was posted"]]}), 90000);
});

process.on("SIGINT", () => finish({checks: [["interrupted", false, "SIGINT"]]}));
process.on("SIGTERM", () => finish({checks: [["interrupted", false, "SIGTERM"]]}));

const ERROR_COLLECTOR = `
window.__jttyPanelSmokeErrors = [];
window.addEventListener("error", e => window.__jttyPanelSmokeErrors.push(String((e.error && e.error.stack) || e.message)));
window.addEventListener("unhandledrejection", e => window.__jttyPanelSmokeErrors.push("unhandled rejection: " + String(e.reason)));
`;
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file === "string" && file.endsWith("log.html")) {
    const text = content.toString().replace("<head>", `<head>\n<script>${ERROR_COLLECTOR}</script>`);
    return Buffer.from(`${text}\n<script>${PAGE_SCRIPT}</script>\n`);
  }
  return content;
};
