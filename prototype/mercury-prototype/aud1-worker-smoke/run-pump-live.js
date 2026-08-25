#!/usr/bin/env node
// Drives pump-worker.js (the generalized ARQ pump) in a real headless-Chrome
// Worker against a running `wifilt` (native, either the fake radio for a
// cheap/deterministic first pass, or --config-dir pointed at a real IC-705
// for the hardware pass -- see run-live.js's own header for the setcap
// context that unblocked port 83 here).
//
// Usage: node run-pump-live.js <httpPort> <role:call|listen> [peerCall] [runMs] [token]
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const httpPort = process.argv[2] || "8199";
const role = process.argv[3] || "call";
const peerCall = process.argv[4] || "OK2XYZ";
const runMs = Number(process.argv[5]) || 30000;
const token = process.argv[6] || "cafefeedcafefeedcafefeedcafefeed";
const wsPort = 83;
const myCall = "OK1HRA";

const proto = path.resolve(__dirname, "..");
const dataDir = path.resolve(__dirname, "../../../data");
const buildDir = path.join(proto, "build-worker");
const mime = { ".html": "text/html", ".js": "application/javascript", ".wasm": "application/wasm" };

let finished = false, chrome = null, timer = null, pingTimer = null;
// SIGKILL, reachable even if THIS process is the one killed -- see
// mercury-two-station-live.js's killAllChrome() comment for the real
// orphaned-Chrome-keeps-a-real-radio-transmitting incident this guards
// against. This driver can target a REAL IC-705, so an external kill must
// never leave headless Chrome (and the radio it's keying) running.
function killChrome() { if (chrome) { try { chrome.kill("SIGKILL"); } catch (_e) {} } }
process.on("SIGTERM", () => { killChrome(); process.exit(143); });
process.on("SIGINT", () => { killChrome(); process.exit(130); });

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (pingTimer) clearInterval(pingTimer);
  killChrome();
  server.close();
  console.log(JSON.stringify(result, null, 2));
  if (Array.isArray(result.slotDrifts) && result.slotDrifts.length) {
    const drifts = result.slotDrifts.map((d) => d.driftMs);
    const mean = drifts.reduce((a, b) => a + b, 0) / drifts.length;
    console.log(`slotUtcMs->millis() drift: n=${drifts.length} mean=${mean.toFixed(1)}ms min=${Math.min(...drifts)}ms max=${Math.max(...drifts)}ms`);
  }
  const ok = result && result.ok === true;
  console.log(ok ? "PASS: pump-worker ran its full cycle without crashing" : "FAIL: see result above");
  process.exit(ok ? 0 : 1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/log" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { console.log(JSON.parse(Buffer.concat(chunks).toString()).line); } catch (_e) {} res.writeHead(204).end(); });
    return;
  }
  if (url.pathname === "/status" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { const s = JSON.parse(Buffer.concat(chunks).toString()); console.log(`  t=${s.tMs}ms state=${s.connState} dflow=${s.dflowState}`); } catch (_e) {} res.writeHead(204).end(); });
    return;
  }
  if (url.pathname === "/result" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { finish(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { finish({ ok: false, reason: "result parse error", detail: e.message }); } });
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><body><script>
      const w = new Worker("pump-worker.js");
      w.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === "log") fetch("/log", {method:"POST", body: JSON.stringify(msg)}).catch(()=>{});
        else if (msg.type === "status") fetch("/status", {method:"POST", body: JSON.stringify(msg)}).catch(()=>{});
        else if (msg.type === "done") fetch("/result", {method:"POST", body: JSON.stringify(msg)}).catch(()=>{});
      };
      w.onerror = (e) => fetch("/result", {method:"POST", body: JSON.stringify({ok:false, reason:"worker error", detail:e.message})}).catch(()=>{});
      w.postMessage({type:"start", wsPort:${wsPort}, token:${JSON.stringify(token)}, myCall:${JSON.stringify(myCall)}, peerCall:${JSON.stringify(peerCall)}, role:${JSON.stringify(role)}, runMs:${runMs}});
    </script></body></html>`);
    return;
  }
  let file = url.pathname;
  let full = path.join(__dirname, file);
  if (!fs.existsSync(full)) full = path.join(buildDir, path.basename(file));
  if (!fs.existsSync(full)) full = path.join(dataDir, path.basename(file));
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found: " + file); return; }
    res.writeHead(200, { "Content-Type": mime[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(0, () => {
  const port = server.address().port;
  pingTimer = setInterval(() => {
    http.request(`http://127.0.0.1:${httpPort}/mercury/session/ping`, { method: "POST", headers: { "Content-Type": "application/json" } })
      .end(JSON.stringify({ token }));
  }, 5000);
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", `http://127.0.0.1:${port}/`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErrors = "";
  chrome.stderr.on("data", (c) => { chromeErrors += c; });
  chrome.on("error", (e) => finish({ ok: false, reason: "chrome failed to start", detail: e.message }));
  chrome.on("close", (code) => { if (!finished) finish({ ok: false, reason: "chrome exited early", detail: `exit ${code} ${chromeErrors.slice(-400)}` }); });
  timer = setTimeout(() => finish({ ok: false, reason: "no /result within timeout" }), runMs + 30000);
});

// Claim the session up front (claim(), not just ping()) so the worker's own
// tx.prepare calls have a live lease from the very first packet.
http.request(`http://127.0.0.1:${httpPort}/mercury/session/claim`, { method: "POST", headers: { "Content-Type": "application/json" } })
  .end(JSON.stringify({ token, force: true }));
