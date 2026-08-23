#!/usr/bin/env node
// Loads the REAL production /mercury.html (not a prototype harness) from a
// running `native/build/wifilt` -- fake radio or a real one via
// --config-dir -- fills in a peer callsign, clicks CALL for real, and
// confirms the page's own DOM updates to reflect a real CALL attempt driven
// through data/mercury.js -> data/mercury-session.js -> data/mercury-worker.js
// -> the real AUD1 socket, exactly the path an operator would use.
//
// A thin reverse proxy fronts the real wifilt instance so the driver script
// can be appended to mercury.html same-origin (same technique
// mercury-browser-smoke.js's own PAGE_SCRIPT append uses) -- everything else
// (mercury.js, mercury-session.js, mercury-worker.js, mercury-host.wasm,
// /setup-data.json, /mercury/session/*, ...) is proxied through unmodified.
// The AUD1 WebSocket itself is unaffected: it always targets port 83
// directly (a global port, not this proxy's), exactly like this repo's other
// *-live.js drivers.
//
// Usage: node mercury-live-smoke.js <httpPort> [peerCall] [waitMs] [mode:call|listen]
"use strict";
const http = require("http");
const { spawn } = require("child_process");

const httpPort = process.argv[2] || "8199";
const peerCall = process.argv[3] || "OK2XYZ";
const waitMs = Number(process.argv[4]) || 12000;
const mode = process.argv[5] || "call";

let finished = false, chrome = null, timer = null;
// SIGKILL, reachable even if THIS process is the one killed -- see
// mercury-two-station-live.js's killAllChrome() comment for the real
// orphaned-Chrome-keeps-a-real-radio-transmitting incident this guards
// against.
function killChrome() { if (chrome) { try { chrome.kill("SIGKILL"); } catch (_e) {} } }
process.on("SIGTERM", () => { killChrome(); process.exit(143); });
process.on("SIGINT", () => { killChrome(); process.exit(130); });

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  killChrome();
  server.close();
  const checks = result.checks || [];
  let failures = 0;
  for (const [name, pass, detail] of checks) {
    console.log(`  ${pass ? "OK  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
    if (!pass) failures++;
  }
  if (Array.isArray(result.debug)) {
    console.log("--- worker message log ---");
    for (const entry of result.debug) console.log(`  t=${entry.t} ${JSON.stringify(entry.msg)}`);
  }
  console.log(checks.length
    ? (failures ? `FAIL: ${failures}/${checks.length} failed` : "PASS: real production /mercury.html drove a real CALL")
    : "FAIL: no checks reported");
  process.exit(checks.length && failures === 0 ? 0 : 1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/result" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { finish(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { finish({ checks: [["result parses", false, e.message]] }); } });
    return;
  }

  // Strip accept-encoding: the real server precompresses (data/*.gz) and
  // would otherwise hand back gzip bytes for mercury.html, which the
  // string-replace injection below would silently corrupt (no "</body>"
  // match in compressed bytes read as utf8) -- easiest fix is asking for
  // the plain response in the first place, same as any of this repo's other
  // *-live.js drivers that inject into fetched HTML.
  const upstreamHeaders = { ...req.headers };
  delete upstreamHeaders["accept-encoding"];
  const upstream = http.request({ host: "127.0.0.1", port: httpPort, path: req.url, method: req.method, headers: upstreamHeaders }, (up) => {
    if (req.url === "/mercury.html" && up.statusCode === 200) {
      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        const html = Buffer.concat(chunks).toString("utf8");
        const injected = html.replace("</body>", `<script>${DRIVER_SCRIPT}</script>\n</body>`);
        const headers = { ...up.headers };
        delete headers["content-length"];
        res.writeHead(200, headers);
        res.end(injected);
      });
      return;
    }
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  upstream.on("error", (e) => { res.writeHead(502); res.end("upstream error: " + e.message); });
  req.pipe(upstream);
});

server.listen(0, () => {
  const port = server.address().port;
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", `http://127.0.0.1:${port}/mercury.html`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErrors = "";
  chrome.stderr.on("data", (c) => { chromeErrors += c; });
  chrome.on("error", (e) => finish({ checks: [["chrome started", false, e.message]] }));
  chrome.on("close", (code) => { if (!finished) finish({ checks: [["chrome stayed up", false, `exit ${code} ${chromeErrors.slice(-400)}`]] }); });
  timer = setTimeout(() => finish({ checks: [["page reported within timeout", false, "no /result POST"]] }), waitMs + 30000);
});

const DRIVER_SCRIPT = `
(async () => {
  const checks = [];
  const check = (name, pass, detail = "") => checks.push([name, Boolean(pass), String(detail)]);
  const peerCall = ${JSON.stringify(peerCall)};
  const waitMs = ${waitMs};
  const mode = ${JSON.stringify(mode)};

  window.__mercuryDebug = [];
  await new Promise((r) => setTimeout(r, 800)); // let lan-gate.js + mercury.js's init() settle

  check("LAN gate did not block the page", !document.body.classList.contains("lan-gate-blocked"),
    document.body.className);
  check("MercurySession loaded", typeof window.MercurySession !== "undefined");
  const peerInput = document.getElementById("peerCall");
  const callButton = document.getElementById("callButton");
  const armToggle = document.getElementById("armToggle");
  check("CALL/arm controls are enabled", peerInput && !peerInput.disabled && callButton && !callButton.disabled && armToggle && !armToggle.disabled);
  if (!peerInput || !callButton || !armToggle) { await fetch("/result", { method: "POST", body: JSON.stringify({ checks }) }); return; }

  if (mode === "listen") {
    armToggle.click();
  } else {
    peerInput.value = peerCall;
    callButton.click();
  }

  // Watch the real page's own state through its real DOM, not a message bus.
  const deadline = Date.now() + waitMs;
  let sawState = false, sawConnState = "", sawTestText = "", sawArmed = false;
  const wantedText = mode === "listen" ? "Listening" : "Calling";
  while (Date.now() < deadline) {
    const pill = document.getElementById("aud1State")?.textContent || "";
    const test = document.getElementById("connectionTest")?.textContent || "";
    if (test.includes(wantedText)) sawState = true;
    if (document.getElementById("armState")?.textContent === "ARMED") sawArmed = true;
    sawConnState = pill;
    sawTestText = test;
    await new Promise((r) => setTimeout(r, 300));
  }
  check(\`page reached a \${mode === "listen" ? "LISTENING" : "CALLING"} state via a real click (not a fake message)\`, sawState, \`\${sawConnState} | \${sawTestText}\`);
  if (mode === "listen") check("arm-state label shows ARMED", sawArmed);
  check("takeover panel never appeared (no one else held the lease)",
    document.getElementById("takeoverNotice")?.hidden !== false);

  await fetch("/result", { method: "POST", body: JSON.stringify({ checks, debug: window.__mercuryDebug }) });
})().catch((e) => fetch("/result", { method: "POST",
  body: JSON.stringify({ checks: [["driver script ran without throwing", false, e.stack || String(e)]] }) }));
`;
