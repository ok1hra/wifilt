#!/usr/bin/env node
// Real, over-the-air proof of [[js8-rx-partial-display]] (built 2026-08-01,
// "needs on-radio check" until now): two REAL production /data pages, each
// fronting a REAL, INDEPENDENT native/build/wifilt instance bound to its own
// real radio (dummy loads coupled close together, per the operator) -- not a
// loopback, not __dataTest.setActivity/feedAudio. Station A dials up station
// B's callsign in the real composer and sends a short JS8 Normal-mode message
// through the real UI (recipient + Enter, same path an operator uses).
// Station B never "arms" anything -- JS8 RX is passive/broadcast, it just
// needs to be sitting on the same frequency/mode with its decoder ready.
//
// What this proves beyond "the message eventually arrives" (already implied
// by [[js8-groups-plan]]'s E2 real-JS8Call verification): station B's Recent
// traffic panel must show the message ASSEMBLING mid-transmission --
// `.message-receiving` class present, `.rx-eot` ABSENT -- before the final
// frame lands, then settle into `.rx-eot` present / `.message-receiving`
// gone. A message that only ever appears once, fully formed, after the last
// frame would mean the partial-display feature isn't actually live.
//
// Two thin reverse proxies (same append-before-</body> injection technique
// as mercury-two-station-live.js / freq-timetable-live-check.js) front the
// two already-running wifilt instances; this script does not start, tune,
// or configure the radios itself -- both must already be on the same
// frequency/mode with real CI-V/LAN links up (verify via each instance's
// own /state before running; this script does not check it for you).
//
// Usage: node js8-two-station-live.js <hostA:portA> <hostB:portB> [callA] [callB] [timeoutMs]
"use strict";
const http = require("http");
const { spawn } = require("child_process");

const [targetA, targetB] = [process.argv[2] || "127.0.0.11:8301", process.argv[3] || "127.0.0.12:8302"];
const [hostA, portA] = targetA.split(":");
const [hostB, portB] = targetB.split(":");
const callA = process.argv[4] || "OK1HRA"; // station A's own identity (already set via /identity)
const callB = process.argv[5] || "OK4DC";  // who station A calls -- station B's own identity
const timeoutMs = Number(process.argv[6]) || 120000; // Normal mode: short text is ~2 frames = 30s air time

const TEST_TEXT = "TEST 123";

let finished = false;
const chromeProcs = [];
let timer = null;
const state = { A: {}, B: {} };

// SIGKILL, not SIGTERM -- see mercury-two-station-live.js's own comment for
// the incident this guards against (orphaned Chrome renderer children keep
// AUD1/PTT alive independent of this script after node itself is gone).
function killAllChrome() {
  for (const c of chromeProcs) { try { c.kill("SIGKILL"); } catch (_e) {} }
}
process.on("SIGTERM", () => { killAllChrome(); process.exit(143); });
process.on("SIGINT", () => { killAllChrome(); process.exit(130); });

function finish(ok, reason) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  killAllChrome();
  serverA.close(); serverB.close();
  console.log(JSON.stringify({ ok, reason, state }, null, 2));
  console.log(ok
    ? "PASS: real JS8 message crossed real RF, station B showed live partial assembly before EOT"
    : "FAIL: see above");
  process.exit(ok ? 0 : 1);
}

function checkDone() {
  if (state.A.sendError) { finish(false, `A.sendError=${state.A.sendError}`); return; }
  if (state.B.receiveError) { finish(false, `B.receiveError=${state.B.receiveError}`); return; }
  if (state.A.sendComplete && state.B.sawPartial && state.B.sawComplete) {
    finish(true, "send completed; B observed partial (no EOT) then complete (EOT)");
  }
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
      if (req.url === "/data" && up.statusCode === 200) {
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

const DRIVER_A = `
(async () => {
  const post = (body) => fetch("/event", { method: "POST", body: JSON.stringify(body) }).catch(() => {});
  await post({ log: "page loaded" });
  try {
    // The composer's own listeners attach synchronously during init(), but
    // currentJs8().myCall/state.selectedCall only populate once the async
    // Identity sync (GET /identity) resolves -- touching #recipient before
    // that lands chooseCall() calls that appear to work (the input's raw
    // value holds) but get silently wiped on the next render pass, which
    // unconditionally syncs #recipient's value back from the (still empty)
    // state.selectedCall. A short settle avoids the race.
    await new Promise((r) => setTimeout(r, 5000));

    // Recipient must be selected BEFORE polling #sendButton -- "select a
    // recipient" is itself one of the txBlockReasons, so waiting for the
    // button first (with no recipient set yet) would never converge.
    const recipient = document.getElementById("recipient");
    recipient.value = ${JSON.stringify(callB)};
    recipient.dispatchEvent(new Event("change", { bubbles: true }));
    await post({ log: "recipient set to ${callB}" });

    // Wait for the modem worker + CAT link + audio timebase to settle, all
    // folded into #sendButton's disabled state by renderControls()->
    // txBlockReasons(). Audio timebase lock in particular needs the AUD1
    // stream to actually be flowing for a bit, so allow up to 90s.
    const deadlineReady = Date.now() + 90000;
    let reasons = "";
    while (Date.now() < deadlineReady) {
      const safety = document.getElementById("txSafety");
      if (safety && !safety.checked) safety.click();
      const btn = document.getElementById("sendButton");
      reasons = btn?.title || "";
      if (btn && !btn.disabled) break;
      await post({ log: "waiting, reasons=" + reasons + " audioStatus=" + (typeof state !== "undefined" ? state.audioStatus : "?") });
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (document.getElementById("sendButton")?.disabled) {
      await post({ sendError: "composer never became ready, last reasons=" + reasons });
      return;
    }
    await post({ log: "composer ready" });

    const msgInput = document.getElementById("messageInput");
    msgInput.value = ${JSON.stringify(TEST_TEXT)};
    msgInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await post({ log: "sent Enter on composer, recipient=${callB} text=" + ${JSON.stringify(TEST_TEXT)} });

    // Track completion via the outgoing row in #traffic (own TX shows up
    // there too) -- poll for a while, then declare success once our own
    // send no longer shows as in-flight/queued.
    const deadline = Date.now() + ${timeoutMs};
    while (Date.now() < deadline) {
      const txSummary = document.getElementById("trafficSummary")?.textContent || "";
      await post({ log: "A traffic summary: " + txSummary });
      // txQueue empties once the frame(s) are actually handed to the radio;
      // state.txStatus is reachable directly (classic script, shared scope).
      if (typeof state !== "undefined" && state.txStatus && (state.txStatus === "idle" || state.txStatus === "completed")) {
        await post({ sendComplete: true });
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    await post({ sendError: "timeout waiting for TX to complete, last txStatus=" + (typeof state !== "undefined" ? state.txStatus : "?") });
  } catch (e) {
    await post({ sendError: e.stack || String(e) });
  }
})();
`;

const DRIVER_B = `
(async () => {
  const post = (body) => fetch("/event", { method: "POST", body: JSON.stringify(body) }).catch(() => {});
  await post({ log: "page loaded, listening (JS8 RX is passive)" });
  try {
    const deadline = Date.now() + ${timeoutMs};
    let sawPartial = false, sawComplete = false, partialTextSeen = "";
    while (Date.now() < deadline) {
      const rows = [...document.querySelectorAll("#traffic .message")];
      const fromA = rows.filter((el) => (el.textContent || "").includes(${JSON.stringify(callA)}));
      const receiving = fromA.some((el) => el.classList.contains("message-receiving") && !el.querySelector(".rx-eot"));
      const complete = fromA.some((el) => el.querySelector(".rx-eot"));
      if (receiving && !sawPartial) {
        sawPartial = true;
        const el = fromA.find((e) => e.classList.contains("message-receiving"));
        partialTextSeen = el?.querySelector(".message-text")?.textContent || "";
        await post({ log: "OBSERVED PARTIAL (no EOT yet): " + partialTextSeen });
      }
      if (complete && !sawComplete) {
        sawComplete = true;
        const el = fromA.find((e) => e.querySelector(".rx-eot"));
        const finalText = el?.querySelector(".message-text")?.textContent || "";
        await post({ log: "OBSERVED COMPLETE (rx-eot present): " + finalText, sawPartial, sawComplete: true, partialTextSeen, finalText });
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await post({ receiveError: "timeout: sawPartial=" + sawPartial + " sawComplete=" + sawComplete, sawPartial });
  } catch (e) {
    await post({ receiveError: e.stack || String(e) });
  }
})();
`;

const serverA = makeProxy("A", hostA, portA, DRIVER_A);
const serverB = makeProxy("B", hostB, portB, DRIVER_B);

function launch(server, label, bindHost) {
  return new Promise((resolve) => {
    // Proxy must listen on the SAME address the real backend is bound to
    // (--bind-ip) -- data.js opens its audio WS relative to location.hostname.
    server.listen(0, bindHost, () => {
      const port = server.address().port;
      const chrome = spawn("google-chrome", [
        "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--no-proxy-server", `http://${bindHost}:${port}/data`,
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

Promise.all([launch(serverA, "A", hostA), launch(serverB, "B", hostB)]).then(() => {
  timer = setTimeout(() => finish(false, "overall timeout"), timeoutMs + 30000);
});
