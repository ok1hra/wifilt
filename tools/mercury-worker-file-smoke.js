#!/usr/bin/env node
// Real-browser regression + wiring check for the file-transfer additions in
// data/mercury-worker.js (ch.5/E3), against a running `wifilt` (fake radio
// for a cheap/deterministic pass -- same pattern as aud1-worker-smoke's own
// run-pump-live.js). A real second Mercury station is out of reach in this
// environment (one radio into a dummy load -- see mercury.html's own
// build-banner), so this cannot prove an actual file transfer; that half is
// already covered by prototype/mercury-prototype/run-native-transfer-file.js
// and run-native-transfer-resume.js (protocol correctness, against real
// native mercury). What THIS test proves, for real, in a real headless-
// Chrome Worker running the actual production files:
//   1. mercury-worker.js loads and runs a full LISTEN cycle without
//      throwing -- the dual-demodulator + host_delivered()/consumeFrames
//      wiring added for file transfer does not regress the already-proven
//      CALL/LISTEN pump when no data ever arrives.
//   2. A "send-file" message before CONNECTED is refused cleanly
//      (send-error/"not connected"), not silently ignored or crashed on --
//      exercising the real self.onmessage -> onSendFileRequested wiring.
//
// Usage: node mercury-worker-file-smoke.js <httpPort> [token]
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const httpPort = process.argv[2] || "8299";
const token = process.argv[3] || "cafefeedcafefeedcafefeedcafefeed";
const wsPort = 83;
const myCall = "OK1TEST";

const dataDir = path.resolve(__dirname, "../data");
const mime = { ".html": "text/html", ".js": "application/javascript", ".wasm": "application/wasm" };

let finished = false, chrome = null, timer = null, pingTimer = null;
const events = [];
// SIGKILL, reachable even if THIS process is the one killed -- see
// mercury-two-station-live.js's killAllChrome() comment for the real
// orphaned-Chrome-keeps-a-real-radio-transmitting incident this guards
// against (this tool can also point --config-dir at a real radio, not just
// the fake one its own top comment leads with).
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
  console.log(JSON.stringify({ ...result, events }, null, 2));
  console.log(result.ok ? "PASS: mercury-worker.js's file-transfer wiring survived a real LISTEN cycle in a real Worker" : "FAIL: see above");
  process.exit(result.ok ? 0 : 1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/log" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const msg = JSON.parse(Buffer.concat(chunks).toString());
        events.push(msg);
        console.log(`  <- ${JSON.stringify(msg)}`);
      } catch (_e) {}
      res.writeHead(204).end();
    });
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
      const events = [];
      let sawListening = false, sawSendErrorNotConnected = false, sawCancelNoopLogged = false, sawStopped = false, workerError = null;
      const w = new Worker("/mercury-worker.js");
      w.onmessage = (e) => {
        const msg = e.data;
        fetch("/log", {method:"POST", body: JSON.stringify(msg)}).catch(()=>{});
        if (msg.type === "status" && msg.connState === "LISTENING" && !sawListening) {
          sawListening = true;
          // Send-file before CONNECTED must be refused cleanly, not crash.
          const buffer = new TextEncoder().encode("hello mercury").buffer;
          w.postMessage({type:"send-file", name:"test.txt", buffer}, [buffer]);
          // Cancel with nothing in progress must be a harmless no-op, not a crash --
          // the only part of the cancel path reachable without a second live station.
          w.postMessage({type:"cancel-transfer"});
        }
        if (msg.type === "send-error" && /not connected/i.test(msg.reason || "")) sawSendErrorNotConnected = true;
        if (msg.type === "log" && /cancel requested but no transfer/i.test(msg.line || "")) sawCancelNoopLogged = true;
        if (msg.type === "stopped") sawStopped = true;
      };
      w.onerror = (e) => { workerError = e.message; };
      w.postMessage({type:"start", wsPort:${wsPort}, token:${JSON.stringify(token)}, myCall:${JSON.stringify(myCall)}, peerCall:"", role:"listen"});

      setTimeout(() => {
        w.postMessage({type:"stop"});
        setTimeout(() => {
          fetch("/result", {method:"POST", body: JSON.stringify({
            ok: sawListening && sawSendErrorNotConnected && sawCancelNoopLogged && sawStopped && !workerError,
            sawListening, sawSendErrorNotConnected, sawCancelNoopLogged, sawStopped, workerError,
          })}).catch(()=>{});
        }, 3000);
      }, 10000);
    </script></body></html>`);
    return;
  }
  const full = path.join(dataDir, url.pathname);
  fs.readFile(full, (err, data) => {
    if (!err) {
      res.writeHead(200, { "Content-Type": mime[path.extname(full)] || "application/octet-stream" });
      res.end(data);
      return;
    }
    const upstream = http.request({ host: "127.0.0.1", port: httpPort, path: req.url, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on("error", (e) => { res.writeHead(502); res.end("upstream error: " + e.message); });
    req.pipe(upstream);
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  pingTimer = setInterval(() => {
    http.request(`http://127.0.0.1:${httpPort}/mercury/session/ping`, { method: "POST", headers: { "Content-Type": "application/json" } }).end(JSON.stringify({ token }));
  }, 5000);
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", `http://127.0.0.1:${port}/`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErrors = "";
  chrome.stderr.on("data", (c) => { chromeErrors += c; });
  chrome.on("error", (e) => finish({ ok: false, reason: "chrome failed to start", detail: e.message }));
  chrome.on("close", (code) => { if (!finished) finish({ ok: false, reason: "chrome exited early", detail: `exit ${code} ${chromeErrors.slice(-800)}` }); });
  timer = setTimeout(() => finish({ ok: false, reason: "no /result within timeout" }), 30000);
});

http.request(`http://127.0.0.1:${httpPort}/mercury/session/claim`, { method: "POST", headers: { "Content-Type": "application/json" } })
  .end(JSON.stringify({ token, force: true }));
