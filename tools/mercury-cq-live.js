#!/usr/bin/env node
// CQ (docs/mercury-implementace.md ch.10's E4 gate, last item -- an
// unaddressed, sessionless broadcast, deliberately NOT routed through
// arq_fsm_dispatch() on either end, see host-shim.c's host_cq_rx_parse()
// comment) verified the same way the file-transfer proof was
// (mercury-two-station-live.js): two REAL production /mercury.html pages,
// each fronting a REAL, independent native/build/wifilt instance bound to
// its own real radio, over REAL RF. Both stations arm/LISTEN (CQ needs no
// CALL/ACCEPT handshake at all); station A clicks CQ; station B's own
// heardStations UI element is read directly to confirm it decoded A's real
// callsign off the air.
//
// Usage: node mercury-cq-live.js <hostA:portA> <hostB:portB> [callA] [callB] [timeoutMs]
"use strict";
const http = require("http");
const { spawn } = require("child_process");

const [targetA, targetB] = [process.argv[2] || "127.0.0.11:8301", process.argv[3] || "127.0.0.12:8302"];
const [hostA, portA] = targetA.split(":");
const [hostB, portB] = targetB.split(":");
const callA = process.argv[4] || "OK1HRA";
const callB = process.argv[5] || "OK4DC";
const timeoutMs = Number(process.argv[6]) || 120000;

let finished = false;
const chromeProcs = [];
let timer = null;
const state = { A: {}, B: {} };

// Same real incident as mercury-two-station-live.js's own comment: SIGKILL,
// reachable even if this driver's own node process is the one killed.
function killAllChrome() {
  for (const c of chromeProcs) { try { c.kill("SIGKILL"); } catch (_e) {} }
}
function finish(ok, reason) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  killAllChrome();
  serverA.close(); serverB.close();
  console.log(JSON.stringify({ ok, reason, state }, null, 2));
  console.log(ok ? "PASS: station B decoded station A's real CQ off real RF" : "FAIL: see above");
  process.exit(ok ? 0 : 1);
}
process.on("SIGTERM", () => { killAllChrome(); process.exit(143); });
process.on("SIGINT", () => { killAllChrome(); process.exit(130); });

function checkDone() {
  if (state.A.cqSent && state.B.cqHeard) finish(true, "cq sent and heard");
  else if (state.A.cqError || state.B.cqError) finish(false, `A.cqError=${state.A.cqError || "none"} B.cqError=${state.B.cqError || "none"}`);
}

function makeProxy(label, host, port, driverScript) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (url.pathname === "/event" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const msg = JSON.parse(Buffer.concat(chunks).toString());
          Object.assign(state[label], msg);
          console.log(`[${label}] ${JSON.stringify(msg)}`);
        } catch (_e) {}
        res.writeHead(204).end();
        checkDone();
      });
      return;
    }
    const upstreamHeaders = { ...req.headers };
    delete upstreamHeaders["accept-encoding"];
    const upstream = http.request({ host, port, path: req.url, method: req.method, headers: upstreamHeaders }, (up) => {
      if (req.url === "/mercury.html" && up.statusCode === 200) {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          const html = Buffer.concat(chunks).toString("utf8");
          const injected = html.replace("</body>", `<script>${driverScript}</script>\n</body>`);
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
  return server;
}

// Both drivers arm/LISTEN first (cqButton is only enabled once a Worker is
// actually running -- see mercury.js's startWorker()), then A alone clicks
// CQ after a short settle so B is genuinely listening first, not racing it.
function armDriver(post) {
  return `
  await new Promise((r) => setTimeout(r, 800));
  const armToggle = document.getElementById("armToggle");
  if (!armToggle || armToggle.disabled) { await ${post}({ cqError: "arm control not ready" }); return; }
  if (!armToggle.checked) armToggle.click();
  await ${post}({ log: "armed, listening" });
  const armDeadline = Date.now() + 15000;
  while (Date.now() < armDeadline) {
    if (!document.getElementById("cqButton")?.disabled) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (document.getElementById("cqButton")?.disabled) { await ${post}({ cqError: "cqButton never enabled" }); return; }
  `;
}

const DRIVER_A = `
(async () => {
  const post = (body) => fetch("/event", { method: "POST", body: JSON.stringify(body) }).catch(() => {});
  post({ log: "PAGE (RE)LOADED" });
  ${armDriver("post")}
  await new Promise((r) => setTimeout(r, 3000)); // let B genuinely settle into LISTEN first
  document.getElementById("cqButton").click();
  await post({ cqSent: true, log: "clicked CQ as ${callA}" });
})().catch((e) => fetch("/event", { method: "POST", body: JSON.stringify({ cqError: e.stack || String(e) }) }));
`;

const DRIVER_B = `
(async () => {
  const post = (body) => fetch("/event", { method: "POST", body: JSON.stringify(body) }).catch(() => {});
  post({ log: "PAGE (RE)LOADED" });
  ${armDriver("post")}
  const deadline = Date.now() + ${timeoutMs};
  while (Date.now() < deadline) {
    const heard = document.getElementById("heardStations")?.textContent || "";
    if (heard.includes(${JSON.stringify(callA)})) { await post({ cqHeard: true, heardText: heard }); return; }
    await new Promise((r) => setTimeout(r, 500));
  }
  await post({ cqError: "timeout, never heard ${callA}" });
})().catch((e) => fetch("/event", { method: "POST", body: JSON.stringify({ cqError: e.stack || String(e) }) }));
`;

const serverA = makeProxy("A", hostA, portA, DRIVER_A);
const serverB = makeProxy("B", hostB, portB, DRIVER_B);

function launch(server, label, bindHost) {
  return new Promise((resolve) => {
    server.listen(0, bindHost, () => {
      const port = server.address().port;
      const chrome = spawn("google-chrome", [
        "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--no-proxy-server", `http://${bindHost}:${port}/mercury.html`,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      chromeProcs.push(chrome);
      let errs = "";
      chrome.stderr.on("data", (c) => { errs += c; });
      chrome.on("error", (e) => finish(false, `[${label}] chrome failed to start: ${e.message}`));
      chrome.on("close", (code) => { if (!finished) finish(false, `[${label}] chrome exited early code=${code} ${errs.slice(-500)}`); });
      resolve();
    });
  });
}

console.log(`expecting station B to hear "${callA}" via a real CQ frame`);
Promise.all([launch(serverA, "A", hostA), launch(serverB, "B", hostB)]).then(() => {
  timer = setTimeout(() => finish(false, "overall timeout"), timeoutMs + 20000);
});
