#!/usr/bin/env node
// Serves worker-smoke/ (index.html + worker.js + build-worker/mercury-host.{js,wasm})
// and drives it in real headless Chrome (same pattern as tools/wspr-browser-smoke.js:
// a plain http server, no puppeteer). Proves mercury-host.wasm -- unmodified
// arq_fsm.c/arq_protocol.c/arith.c/arq_timing.c + trimmed freedv -- runs
// correctly in a real browser Worker, not just under Node.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const smokeDir = path.join(__dirname, "worker-smoke");
const buildDir = path.join(__dirname, "build-worker");
const mime = { ".html": "text/html", ".js": "application/javascript", ".wasm": "application/wasm" };

let finished = false, chrome = null, timer = null;
function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (chrome) chrome.kill("SIGTERM");
  server.close();
  const checks = result.checks || [];
  for (const [name, pass, detail] of checks) console.log(`  ${pass ? "OK  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
  const ok = checks.length > 0 && checks.every((c) => c[1]);
  console.log(ok ? "PASS: mercury-host.wasm runs correctly in a real browser Worker" : "FAIL: see above");
  process.exit(ok ? 0 : 1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/result" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { finish(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { finish({ checks: [["result parses", false, e.message]] }); } });
    return;
  }
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  let full = path.join(smokeDir, file);
  if (!fs.existsSync(full)) full = path.join(buildDir, path.basename(file));
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found: " + file); return; }
    res.writeHead(200, { "Content-Type": mime[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(0, () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", url,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErrors = "";
  chrome.stderr.on("data", (c) => { chromeErrors += c; });
  chrome.on("error", (e) => finish({ checks: [["chrome started", false, e.message]] }));
  chrome.on("close", (code) => { if (!finished) finish({ checks: [["chrome stayed up", false, `exit ${code} ${chromeErrors.slice(-400)}`]] }); });
  timer = setTimeout(() => finish({ checks: [["page reported within timeout", false, "no /result POST"]] }), 60000);
});
