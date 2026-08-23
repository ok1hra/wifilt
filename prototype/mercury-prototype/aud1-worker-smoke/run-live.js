#!/usr/bin/env node
// Drives worker.js against a REAL running `wifilt` (native, pointed at a real
// IC-705 with `--config-dir`) instead of the fake radio -- the live-socket
// half aud1-worker-smoke/README.md said was blocked without root. Not
// blocked anymore: the operator ran `sudo setcap cap_net_bind_service=+ep`
// on the binary themselves (their machine, their password, never seen here).
//
// Usage: node run-live.js <httpPort> [mercurySessionToken]
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const httpPort = process.argv[2] || "8199";
const token = process.argv[3] || "cafefeedcafefeedcafefeedcafefeed";
const wsPort = 83;

const proto = path.resolve(__dirname, "..");
const dataDir = path.resolve(__dirname, "../../../data");
const buildDir = path.join(proto, "build-worker");
const mime = { ".html": "text/html", ".js": "application/javascript", ".wasm": "application/wasm" };

let finished = false, chrome = null, timer = null, pingTimer = null;
function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (pingTimer) clearInterval(pingTimer);
  if (chrome) chrome.kill("SIGTERM");
  server.close();
  const checks = result.checks || [];
  let failures = 0;
  for (const [name, pass, detail] of checks) {
    console.log(`  ${pass ? "OK  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
    if (!pass) failures++;
  }
  console.log(checks.length
    ? (failures ? `FAIL: ${failures}/${checks.length} failed` : "PASS: real AUD1 transport against a real IC-705")
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
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><body><script>
      const w = new Worker("worker.js?wsPort=${wsPort}&token=${encodeURIComponent(token)}");
      w.onmessage = e => fetch("/result", {method:"POST", body: JSON.stringify(e.data)}).catch(()=>{});
      w.onerror = e => fetch("/result", {method:"POST", body: JSON.stringify({checks:[["worker loaded", false, e.message]]})}).catch(()=>{});
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
  // worker.js reads its own location.search for wsPort/token, but classic
  // Workers don't inherit the page's query string -- so worker.js is loaded
  // with its OWN query string (see the page HTML above); read from there too.
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
  chrome.on("error", (e) => finish({ checks: [["chrome started", false, e.message]] }));
  chrome.on("close", (code) => { if (!finished) finish({ checks: [["chrome stayed up", false, `exit ${code} ${chromeErrors.slice(-400)}`]] }); });
  timer = setTimeout(() => finish({ checks: [["page reported within timeout", false, "no /result POST"]] }), 45000);
});
