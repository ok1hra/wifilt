#!/usr/bin/env node
// Drives data/mercury-cal-worker.js in a real headless-Chrome Worker against
// a running `wifilt` (fake radio for a cheap first pass, or --config-dir
// pointed at a real IC-705 for the hardware pass -- same pattern as
// aud1-worker-smoke/run-pump-live.js).
//
// Usage: node mercury-cal-live-smoke.js <[host:]httpPort> [model] [frequencyHz] [percent] [token]
//
// `host` matters whenever the backend was started with --bind-ip (two native
// instances sharing one machine, one per real radio -- see the --bind-ip
// comment in native/net/WiFi.h): this throwaway proxy's own server MUST
// listen on that same address, because mercury-cal-worker.js's AUD1 socket
// connects to ws://location.hostname:83/..., not a hardcoded loopback --
// same fix mercury-two-station-live.js needed for the same reason.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const [rawHost, rawPort] = String(process.argv[2] || "8199").split(":");
const httpHost = rawPort ? rawHost : "127.0.0.1";
const httpPort = rawPort || rawHost;
const model = process.argv[3] || "IC-705";
const frequencyHz = Number(process.argv[4]) || 7078000;
const percent = Number(process.argv[5]) || 100;
const token = process.argv[6] || "cafefeedcafefeedcafefeedcafefeed";
const wsPort = 83;

const dataDir = path.resolve(__dirname, "../data");
const mime = { ".html": "text/html", ".js": "application/javascript", ".wasm": "application/wasm" };

let finished = false, chrome = null, timer = null, pingTimer = null;
// SIGKILL, not SIGTERM, and reachable even if THIS node process is the one
// killed (pkill, a wrapping `timeout`) -- see mercury-two-station-live.js's
// killAllChrome() comment for the real incident this guards against.
// Doubly worth it here specifically: an orphaned CAL worker keys a
// CONTINUOUS carrier while it searches, not intermittent data bursts.
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
  const ok = result && (result.ok === true || result.reason === "radio does not report ALC");
  console.log(ok ? "PASS (see result for real outcome)" : "FAIL: see result above");
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
  if (url.pathname === "/progress" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { const p = JSON.parse(Buffer.concat(chunks).toString()); console.log(`  ${p.state}/${p.phase} gain=${p.gain.toFixed(4)} steps=${p.steps} alcMax=${p.alcMax}`); } catch (_e) {} res.writeHead(204).end(); });
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
      const w = new Worker("mercury-cal-worker.js");
      w.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === "log" || msg.type === "stored") fetch("/log", {method:"POST", body: JSON.stringify({line: JSON.stringify(msg)})}).catch(()=>{});
        else if (msg.type === "progress") fetch("/progress", {method:"POST", body: JSON.stringify(msg)}).catch(()=>{});
        else if (msg.type === "error" || msg.type === "done") fetch("/result", {method:"POST", body: JSON.stringify(msg)}).catch(()=>{});
      };
      w.onerror = (e) => fetch("/result", {method:"POST", body: JSON.stringify({ok:false, reason:"worker error", detail:e.message})}).catch(()=>{});
      w.postMessage({type:"start", wsPort:${wsPort}, token:${JSON.stringify(token)}, model:${JSON.stringify(model)}, frequencyHz:${frequencyHz}, percent:${percent}});
    </script></body></html>`);
    return;
  }
  let file = url.pathname;
  let full = path.join(dataDir, file);
  fs.readFile(full, (err, data) => {
    if (!err) {
      res.writeHead(200, { "Content-Type": mime[path.extname(full)] || "application/octet-stream" });
      res.end(data);
      return;
    }
    // Not a static asset -- the Worker is served from THIS throwaway
    // server's own origin (a random port, not httpPort), so its relative
    // fetch("/mercury-txgain.json") lands here too, not on the real wifilt
    // instance. Proxy anything not found on disk through to the real
    // backend instead of 404ing (same reason mercury-live-smoke.js runs a
    // full reverse proxy for its production-page test).
    const upstream = http.request({ host: httpHost, port: httpPort, path: req.url, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on("error", (e) => { res.writeHead(502); res.end("upstream error: " + e.message); });
    req.pipe(upstream);
  });
});

server.listen(0, httpHost, () => {
  const port = server.address().port;
  pingTimer = setInterval(() => {
    http.request(`http://${httpHost}:${httpPort}/mercury/session/ping`, { method: "POST", headers: { "Content-Type": "application/json" } }).end(JSON.stringify({ token }));
  }, 5000);
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", `http://${httpHost}:${port}/`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErrors = "";
  chrome.stderr.on("data", (c) => { chromeErrors += c; });
  chrome.on("error", (e) => finish({ ok: false, reason: "chrome failed to start", detail: e.message }));
  chrome.on("close", (code) => { if (!finished) finish({ ok: false, reason: "chrome exited early", detail: `exit ${code} ${chromeErrors.slice(-400)}` }); });
  timer = setTimeout(() => finish({ ok: false, reason: "no result within timeout" }), 120000);
});

http.request(`http://${httpHost}:${httpPort}/mercury/session/claim`, { method: "POST", headers: { "Content-Type": "application/json" } })
  .end(JSON.stringify({ token, force: true }));
