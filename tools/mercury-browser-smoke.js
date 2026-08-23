#!/usr/bin/env node
"use strict";

// Browser-level check for the Mercury page skeleton (docs/mercury-implementace.md
// §6) — same dependency-free pattern as tools/wspr-browser-smoke.js: a plain
// http server serving the production data/ tree plus a /setup-data.json
// fixture for lan-gate.js, driven in real headless Chrome. No radio involved,
// and none of Mercury's own backend exists yet (see mercury.js's own header
// comment) — this only checks the page renders the intended shape and does
// not silently pretend any of its controls work.

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

// lan-gate.js's own fetch("/setup-data.json") never forwards the page's own
// query string, so "which fixture" has to be server-side state set from the
// one request that DOES carry it (the initial page load), not read off each
// individual /setup-data.json request.
let lanFixture = process.argv[2] === "lan";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/mercury.html" && url.searchParams.has("fixture"))
    lanFixture = url.searchParams.get("fixture") === "lan";
  if (url.pathname === "/result" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { finish({ checks: [["result parses", false, e.message]] }); }
    });
    return;
  }
  if (url.pathname === "/setup-data.json") {
    // No ICOM-LAN configured: the gate-card path (own smoke case below);
    // the "lan" CLI arg (see lanFixture above) flips this to a fully
    // configured TRX1, for the "page actually renders" case.
    const lan = lanFixture;
    const creds = { lanip: "192.168.1.60", lanuser: "operator", lanpass: "secret123" };
    const blank = { lanip: "", lanuser: "", lanpass: "" };
    const c = lan ? creds : blank;
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      fwRev: 20260822, blockedDxcc: "",
      trx1transport: lan ? "lan" : "trxnet", trx1lanip: c.lanip, trx1lanuser: c.lanuser, trx1lanpass: c.lanpass,
      trx2transport: "trxnet", trx2lanip: "", trx2lanuser: "", trx2lanpass: "",
      trx3transport: "trxnet", trx3lanip: "", trx3lanuser: "", trx3lanpass: "",
    }));
    return;
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

server.listen(0, () => {
  const port = server.address().port;
  const fixture = process.argv[2] === "lan" ? "?fixture=lan" : "";
  const url = `http://127.0.0.1:${port}/mercury.html${fixture}`;
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", url,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErrors = "";
  chrome.stderr.on("data", (c) => { chromeErrors += c; });
  chrome.on("error", (e) => finish({ checks: [["chrome started", false, e.message]] }));
  chrome.on("close", (code) => { if (!finished) finish({ checks: [["chrome stayed up", false, `exit ${code} ${chromeErrors.slice(-400)}`]] }); });
  timer = setTimeout(() => finish({ checks: [["page reported within timeout", false, "no /result POST"]] }), 20000);
});

const PAGE_SCRIPT = `
(async () => {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push([name, Boolean(pass), String(detail)]);

  // Give lan-gate.js's fetch + render a moment.
  await new Promise(r => setTimeout(r, 400));

  const lanBlocked = document.body.classList.contains("lan-gate-blocked");
  const params = new URLSearchParams(location.search);
  if (params.get("fixture") === "lan") {
    check("with ICOM-LAN configured, the gate does not block the page", !lanBlocked,
      "body classes: " + document.body.className);
    check("subnav shows all three DATA pages with Mercury active",
      document.querySelector('.subtabs a[href="/data"]')?.textContent.trim() === "JS8Call-ICOM" &&
      document.querySelector('.subtabs a[href="/wspr.html"]')?.textContent.trim() === "WSPR-Beacon" &&
      document.querySelector('.subtabs a[href="/mercury.html"]')?.textContent.trim() === "Mercury" &&
      document.querySelector('.subtabs a[href="/mercury.html"]')?.classList.contains("subtab-active") === true);
    check("DATA tab stays active on the Mercury page",
      document.querySelector('.tabs a[href="/data"]')?.classList.contains("tab-active") === true);
    check("build banner is visible and says what is/isn't verified yet",
      document.querySelector(".build-banner")?.textContent.includes("verified end to end"));
    // CALL/LISTEN/file-transfer (with resume) are all real now (data/
    // mercury-session.js + mercury-worker.js + mercury-file.js, all
    // verified against a real IC-705 and/or real native mercury before this
    // page was wired to them) -- only the sked field and mid-transfer
    // cancel stay disabled (genuinely not built).
    const stillDisabledIds = ["skedTime", "cancelButton"];
    check("controls with no real behavior yet stay disabled",
      stillDisabledIds.every(id => document.getElementById(id)?.disabled === true),
      stillDisabledIds.filter(id => document.getElementById(id)?.disabled !== true).join(","));
    const nowEnabledIds = ["peerCall", "callButton", "armToggle", "fileInput"];
    check("CALL/arm/file-send controls are enabled (real session lock + Worker pump + MRQ1 layer exist now)",
      nowEnabledIds.every(id => document.getElementById(id)?.disabled === false),
      nowEnabledIds.filter(id => document.getElementById(id)?.disabled !== false).join(","));
    check("SEND stays disabled until a file is chosen AND the session is connected",
      document.getElementById("sendButton")?.disabled === true);
    check("MercurySession loaded", typeof window.MercurySession !== "undefined");
    check("connection-test mockup is marked as an example, not a live session (no CALL/LISTEN attempted)",
      document.querySelector("#connectionTest.placeholder")?.textContent.includes("no live connection yet"));
    check("takeover dialog markup exists but is hidden (no takeover has happened)",
      document.getElementById("takeoverNotice")?.hidden === true);
    check("arm toggle starts unchecked/NOT ARMED (fresh browser, no persisted arm state)",
      document.getElementById("armToggle")?.checked === false &&
      document.getElementById("armState")?.textContent === "NOT ARMED");
  } else {
    check("without ICOM-LAN configured, the gate blocks the page", lanBlocked,
      "body classes: " + document.body.className);
    check("the subnav survives the gate blanking (same rule as JS8Call-ICOM/WSPR)",
      getComputedStyle(document.querySelector(".subtabs")).display !== "none");
  }

  await fetch("/result", { method: "POST", body: JSON.stringify({ checks }) });
})().catch(e => fetch("/result", { method: "POST",
  body: JSON.stringify({ checks: [["page script ran without throwing", false, e.stack || String(e)]] }) }));
`;
