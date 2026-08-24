#!/usr/bin/env node
"use strict";

// Browser-level check for the three status-bar dropdowns added to Mercury
// 2026-08-23 (band picker, frequency timetable, TX gain calibration plan --
// docs/mercury-implementace.md ch.13). A plain http server serving the
// production data/ tree plus fixtures for /setup-data.json, /state, /cmd
// and /mercury-txgain.json. No radio involved -- /state is a fake IC-705
// sitting on the 20 m preset, and /cmd just records what it was asked and
// (for setFrequency) updates the fake radio so the plan's own confirm-loop
// can succeed without a real transceiver.
//
// Reports via --dump-dom (a hidden <pre> the page fills with its own
// results) rather than tools/mercury-browser-smoke.js's own long-lived
// headless Chrome + POST /result: that pattern was unreliable for THIS
// page's longer click sequence (~9 clicks, ~2.5 s of real waits across
// three separate panels) -- found live 2026-08-23 debugging the "not in
// that band" regression below, where the exact same sequence completed
// correctly under --dump-dom/--virtual-time-budget every time but the
// POST-based version above hung with no result and no page error, in this
// Chrome build, for reasons that stayed unexplained even after capturing
// stderr/console/unhandledrejection. --dump-dom sidesteps whatever that was
// by not depending on a live network round-trip back to this process at all.

const http = require("http"), fs = require("fs"), path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const mime = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript" };

let finished = false, chrome = null, timer = null;
function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (chrome) chrome.kill("SIGTERM");
  server.close();
  const checks = result.checks || [];
  let failures = 0;
  for (const [name, pass, detail] of checks) {
    if (pass) continue;
    failures++;
    console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
  console.log(`${checks.length - failures}/${checks.length} checks passed`);
  process.exitCode = failures || checks.length === 0 ? 1 : 0;
}

// dump-dom serializes the page as HTML, so the JSON the page wrote into the
// <pre>'s textContent comes back HTML-escaped; only the five entities HTML
// ever produces for plain text content are possible here (dump-dom does not
// use numeric escapes for this range).
function unescapeHtml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// The fake radio this whole smoke test drives. Starts on the 20 m preset
// (14105000 Hz, from data/mercury-presets.js) so "is this the current
// preset" and "off-dial" both have a real, checkable answer from the first
// poll onward.
const fakeRadio = {
  connected: true, transceiverType: "ICOM-LAN", radioName: "IC-705", radioNameSeen: true,
  frequency: 14105000, mode: "USB-D", filter: 1, tx: false,
  rfPower: 255, rfPowerSeen: true, lanStatus: "connected",
};
const cmdLog = [];
let txgainDoc = { v: 2, entries: {}, plan: { powers: [], rows: [] } };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");

  if (url.pathname === "/setup-data.json") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      fwRev: 20260822, blockedDxcc: "",
      trx1transport: "lan", trx1lanip: "192.168.1.60", trx1lanuser: "operator", trx1lanpass: "secret123",
      trx2transport: "trxnet", trx2lanip: "", trx2lanuser: "", trx2lanpass: "",
      trx3transport: "trxnet", trx3lanip: "", trx3lanuser: "", trx3lanpass: "",
    }));
    return;
  }

  if (url.pathname === "/state") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(fakeRadio));
    return;
  }

  if (url.pathname === "/cmd" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch (_e) {}
      cmdLog.push(payload);
      // setFrequency actually moves the fake radio, so the CAL PLAN's own
      // confirm-and-poll setFrequency() hook (which waits for state.radio.
      // frequency to agree) has something real to converge on.
      if (payload.type === "setFrequency") fakeRadio.frequency = Number(payload.frequency) || fakeRadio.frequency;
      if (payload.type === "setMode" && payload.mode) fakeRadio.mode = payload.mode;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (url.pathname === "/mercury-txgain.json") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(txgainDoc));
      return;
    }
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try { txgainDoc = JSON.parse(Buffer.concat(chunks).toString()); } catch (_e) {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
  }

  let file = url.pathname === "/" ? "/mercury.html" : url.pathname;
  const full = path.join(dataDir, file);
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found: " + file); return; }
    let body = data;
    if (path.basename(full) === "mercury.html")
      body = Buffer.concat([data, Buffer.from(`\n<script>${PAGE_SCRIPT}</script>\n`)]);
    res.writeHead(200, { "Content-Type": mime[path.extname(full)] || "application/octet-stream" });
    res.end(body);
  });
});

const PAGE_SCRIPT = `
(async () => {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push([name, Boolean(pass), String(detail)]);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const click = (el) => el.dispatchEvent(new MouseEvent("click", {bubbles: true}));

  // Give lan-gate.js's fetch, the first pollRadio() and the CAL PLAN's own
  // store.load()+reload() a moment to land.
  await wait(1200);

  check("ICOM-LAN gate does not block the page", !document.body.classList.contains("lan-gate-blocked"),
    "body classes: " + document.body.className);

  // ---- radio-bar parity itself ------------------------------------------
  check("trxFrequencyValue shows the fake radio's dial (20 m preset)",
    document.getElementById("trxFrequencyValue")?.textContent === "14.105.000");
  check("trxMode shows USB-D", document.getElementById("trxMode")?.textContent === "USB-D");
  check("trxPower is visible once connected", document.getElementById("trxPower")?.hidden === false);
  check("linkState shows RX WAIT (connected, not transmitting)",
    document.getElementById("linkState")?.textContent === "● RX WAIT");
  check("trxFrequency is NOT flagged off-dial (radio sits on a real preset)",
    !document.getElementById("trxFrequency")?.classList.contains("off-dial"));

  // ---- bullet 1: band picker ---------------------------------------------
  const trxFrequency = document.getElementById("trxFrequency");
  click(trxFrequency);
  await wait(50);
  const menu = document.getElementById("frequencyMenu");
  check("frequency menu opens on click", menu?.hidden === false);
  const presetButtons = [...menu.querySelectorAll("[data-frequency]")];
  check("exactly 8 Mercury presets offered (80-10 m, not JS8's 12)", presetButtons.length === 8,
    String(presetButtons.length));
  check("presets are labelled in Mercury's own band list (10 m present, 160 m absent)",
    presetButtons.some(b => b.textContent.includes("10 m")) &&
    !presetButtons.some(b => b.textContent.includes("160 m")));
  check("the 20 m preset is marked current (matches the fake radio's dial)",
    presetButtons.some(b => b.dataset.frequency === "14105000" && b.classList.contains("current")));

  const tenMeter = presetButtons.find(b => Number(b.dataset.frequency) === 28120000);
  click(tenMeter);
  await wait(400);
  // Proof the click actually reached /cmd (rather than only closing the menu):
  // re-read the fake radio's own state, which the server's /cmd handler moves
  // for a real setFrequency POST.
  const confirmState = await (await fetch("/state", { cache: "no-store" })).json();
  check("clicking a preset posts setFrequency to /cmd (fake radio actually retuned)",
    confirmState.frequency === 28120000, String(confirmState.frequency));
  check("frequency menu closes after picking a preset", document.getElementById("frequencyMenu")?.hidden === true);

  // ---- bullet 2: frequency timetable --------------------------------------
  const ttButton = document.getElementById("freqTimetableButton");
  check("timetable button starts OFF", document.getElementById("freqTimetableValue")?.textContent === "OFF");
  click(ttButton);
  await wait(50);
  const ttPanel = document.getElementById("freqTimetablePanel");
  check("timetable panel opens on click", ttPanel?.hidden === false);
  const cells = document.getElementById("freqTimetableGrid")?.querySelectorAll("[data-slot]");
  check("timetable grid renders 48 half-hour slots (JS8's own shape, not WSPR's matrix)",
    cells?.length === 48, String(cells && cells.length));
  click(document.getElementById("freqTimetableEnable"));
  await wait(50);
  check("enabling the timetable flips the button to ON",
    document.getElementById("freqTimetableEnable")?.textContent === "ON" &&
    document.getElementById("freqTimetableEnable")?.getAttribute("aria-checked") === "true");
  click(document.getElementById("freqTimetableClear")); // no confirm() dialog fires: nothing is filled in yet
  click(document.getElementById("freqTimetableClose"));
  await wait(50);
  check("CLOSE hides the timetable panel", document.getElementById("freqTimetablePanel")?.hidden === true);

  // ---- bullet 3: TX gain calibration plan ---------------------------------
  const planButton = document.getElementById("planButton");
  check("CAL PLAN button exists in the status bar", Boolean(planButton));
  check("CAL PLAN starts on an empty/uncalibrated table",
    ["EMPTY", "NOT CALIBRATED"].includes(document.getElementById("planButtonValue")?.textContent));
  click(planButton);
  await wait(300);
  const planField = document.getElementById("planField");
  check("CAL PLAN panel opens on click (TxGainPlanUi mounted, same module as JS8/WSPR)",
    planField?.hidden === false);
  check("the plan grid renders (tx-gain-plan-ui.js's own markup, unmodified)",
    Boolean(planField?.querySelector(".plan-grid, .plan-tools, .plan-field")));

  // Regression, found live 2026-08-23 by an operator, not by this suite (it
  // never actually pressed RUN before): bands() fed row.band the DISPLAY
  // label ("20 m", mercury-presets.js's own form) while tx-gain-plan-ui.js's
  // own blockingReason() compares it against TxGainCal.bandOf(row.hz), which
  // returns the no-space form ("20m") -- so the auto-seeded row for a radio
  // sitting exactly ON its 20 m preset was rejected as "not in that band" on
  // every single RUN, always. Fixed by having bands() derive the label from
  // TxGainCal.bandOf() itself instead of the display preset's own .band.
  //
  // RUN presses far enough into begin() to hit this fake harness's own real
  // ceiling next (no simulated CI-V MOD-level read, so this.mod.capability.
  // readable's own message appears) -- that is a property of the test double,
  // not a bug, and proves the band check specifically is what got past.
  const runButton = planField.querySelector('[data-plan="run"]');
  check("RUN button exists", Boolean(runButton));
  if (runButton) {
    click(runButton);
    await wait(400);
    const errorLine = planField.querySelector('[data-plan="error"]');
    const errorText = errorLine ? errorLine.textContent : "";
    check("RUN does not reject the auto-seeded 20 m row as 'not in that band'",
      !errorText.includes("is not in that band"), errorText);
  }

  // Written into the DOM, not POSTed: see this file's own header for why.
  const pre = document.createElement("pre");
  pre.id = "__smoke_result";
  pre.hidden = true;
  pre.textContent = JSON.stringify(checks);
  document.body.appendChild(pre);
})();
`;

server.listen(0, () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mercury.html?fixture=lan`;
  // Virtual time budget in ms: comfortably above the ~2.5 s the page script's
  // own real-time waits add up to, since --dump-dom fires once that budget
  // (or the load event, whichever is later) is exhausted.
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", "--virtual-time-budget=8000", "--dump-dom", url,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", chromeErrors = "";
  chrome.stdout.on("data", (c) => { out += c; });
  chrome.stderr.on("data", (c) => { chromeErrors += c; });
  chrome.on("error", (e) => finish({ checks: [["chrome started", false, e.message]] }));
  chrome.on("close", (code) => {
    if (finished) return;
    const m = out.match(/<pre id="__smoke_result"[^>]*>([\s\S]*?)<\/pre>/);
    if (!m) {
      finish({ checks: [["page reported a result", false,
        `no #__smoke_result found (exit ${code}); chrome stderr: ${chromeErrors.slice(-800)}`]] });
      return;
    }
    try { finish({ checks: JSON.parse(unescapeHtml(m[1])) }); }
    catch (e) { finish({ checks: [["result parses", false, e.message]] }); }
  });
  timer = setTimeout(() => finish({ checks: [["page reported within timeout", false, "chrome never closed"]] }), 20000);
});
