#!/usr/bin/env node
// The real, final proof this project has been working toward: two REAL
// production /mercury.html pages, each fronting a REAL, INDEPENDENT
// native/build/wifilt instance bound to its own real radio (via --bind-ip,
// see native/net/WiFi.h/.cpp), calling each other over REAL RF (dummy loads
// placed close enough to couple, per the operator) -- not native mercury,
// not a fake radio, not a synthetic postMessage. Station A dials station B,
// sends a real MRQ1-framed file once CONNECTED, station B (armed/LISTENing)
// receives it and the driver script verifies the downloaded Blob's SHA-256
// matches, byte for byte, entirely through the real UI (file input, SEND
// click, no message-bus shortcuts) -- exactly what an operator would do.
//
// Two thin reverse proxies (same append-before-</body> injection technique
// as mercury-live-smoke.js) front the two already-running wifilt instances;
// this script does not start or configure the radios itself.
//
// Usage: node mercury-two-station-live.js <hostA:portA> <hostB:portB> [peerCallA] [peerCallB] [timeoutMs]
"use strict";
const http = require("http");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const [targetA, targetB] = [process.argv[2] || "127.0.0.11:8301", process.argv[3] || "127.0.0.12:8302"];
const [hostA, portA] = targetA.split(":");
const [hostB, portB] = targetB.split(":");
const callA = process.argv[4] || "OK1HRA"; // who station A calls FROM (its own identity, already set)
const callB = process.argv[5] || "OK4DC";  // who station A dials
const timeoutMs = Number(process.argv[6]) || 900000; // 15 min -- real RF, real ARQ retries, unknown mode ladder

const FILE_NAME = "mercury-live-test.txt";
const FILE_CONTENT = `Mercury real-RF test ${new Date().toISOString()} ${callA}<->${callB}\n`.repeat(2);
const FILE_SHA256_HEX = crypto.createHash("sha256").update(Buffer.from(FILE_CONTENT, "utf8")).digest("hex");

let finished = false;
const chromeProcs = [];
const chromeProfileDirs = [];
let timer = null;
const state = { A: {}, B: {} };

// SIGKILL, not SIGTERM: this is a short-lived headless Chrome with nothing
// to save, and a real incident showed SIGTERM alone is not reliable enough
// here -- killing this driver's own node process externally (pkill, a
// `timeout` wrapper, this tool's own earlier runs during development) skips
// straight past finish() below with no chance to run ANY cleanup, and even
// when finish() does run, a plain SIGTERM occasionally left the renderer/
// gpu-process children behind, reparented to init once the parent chrome
// process exited -- and those orphans keep the AUD1 WebSocket (and the real
// radio's PTT) alive independent of this script or its proxy, invisible to
// `pgrep -f mercury-two-station-live` since node itself is long gone. Caught
// live: two real radios kept transmitting a stale test file at each other
// for ~10 minutes after the driving node process had already exited.
function killAllChrome() {
  for (const c of chromeProcs) { try { c.kill("SIGKILL"); } catch (_e) {} }
  for (const d of chromeProfileDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {} }
}

function finish(ok, reason) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  killAllChrome();
  serverA.close(); serverB.close();
  console.log(JSON.stringify({ ok, reason, expectedSha256: FILE_SHA256_HEX, state }, null, 2));
  console.log(ok
    ? "PASS: a real file crossed real RF between two independent wifilt instances/radios, byte-exact"
    : "FAIL: see above");
  process.exit(ok ? 0 : 1);
}

// The other half of the fix above: this process itself being killed (not
// just timing out normally) must still reach killAllChrome(). Node runs no
// cleanup on SIGTERM/SIGINT by default -- it just dies, silently orphaning
// chromeProcs' whole process tree.
process.on("SIGTERM", () => { killAllChrome(); process.exit(143); });
process.on("SIGINT", () => { killAllChrome(); process.exit(130); });

function checkDone() {
  if (state.A.sendComplete && state.B.receiveComplete) {
    finish(state.B.shaMatches === true, state.B.shaMatches ? "both sides report completion, hash matches" : "hash mismatch or unverified");
  } else if (state.A.sendError || state.B.receiveError) {
    finish(false, `A.sendError=${state.A.sendError || "none"} B.receiveError=${state.B.receiveError || "none"}`);
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

const DRIVER_A = `
(async () => {
  const post = (body) => fetch("/event", { method: "POST", body: JSON.stringify(body) }).catch(() => {});
  post({ log: "PAGE (RE)LOADED", perfNowAtLoad: performance.now() });
  // Diagnostic only: reveal every /mercury/session/* claim or ping and its
  // real outcome, to distinguish "a ping was late/failed and the client
  // re-claimed" from "the page itself reloaded" -- both would show as a
  // spurious extra claim() in the firmware's own log otherwise.
  const realFetch = fetch;
  window.fetch = function (url, opts) {
    const isSession = typeof url === "string" && url.includes("/session/");
    const p = realFetch.apply(this, arguments);
    if (isSession) {
      p.then((r) => post({ log: "fetch " + url + " -> " + r.status })).catch((e) => post({ log: "fetch " + url + " threw " + e.message }));
    }
    return p;
  };
  window.__mercuryDebug = [];
  let debugSent = 0;
  await new Promise((r) => setTimeout(r, 800));
  const peerInput = document.getElementById("peerCall");
  const callButton = document.getElementById("callButton");
  if (!peerInput || callButton?.disabled) { await post({ sendError: "controls not ready" }); return; }
  peerInput.value = ${JSON.stringify(callB)};
  callButton.click();
  await post({ log: "clicked CALL toward ${callB}" });

  const deadline = Date.now() + ${timeoutMs};
  let fileQueued = false;
  while (Date.now() < deadline) {
    const testEl = document.getElementById("connectionTest");
    const testText = testEl?.textContent || "";
    // The page's OWN static markup shows an example "Connected with OK2XYZ"
    // paragraph before any real CALL -- mercury.js marks that state with a
    // "placeholder" class specifically so real vs. example is distinguishable
    // in the DOM, not just by scraping text a mockup already contains.
    const reallyConnected = testEl && !testEl.classList.contains("placeholder") && testText.includes("Connected with");
    const estText = document.getElementById("transferEstimate")?.textContent || "";
    if (window.__mercuryDebug.length > debugSent) {
      await post({ rawMsgs: window.__mercuryDebug.slice(debugSent) });
      debugSent = window.__mercuryDebug.length;
    }
    const statusVisible = document.getElementById("statusSection") ? !document.getElementById("statusSection").hidden : false;
    const statusText = document.getElementById("arqStatus")?.textContent || "";
    await post({ connState: document.getElementById("aud1State")?.textContent || "", testText, estText, reallyConnected, statusVisible, statusText });

    if (!fileQueued && reallyConnected) {
      const fileInput = document.getElementById("fileInput");
      const file = new File([${JSON.stringify(FILE_CONTENT)}], ${JSON.stringify(FILE_NAME)}, { type: "text/plain" });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      document.getElementById("sendButton")?.click();
      fileQueued = true;
      await post({ log: "file queued for send", fileQueued: true });
    }
    if (estText.includes("delivered")) { await post({ sendComplete: true }); return; }
    if (estText.toLowerCase().includes("send failed")) { await post({ sendError: estText }); return; }
    // The Worker itself can die outright (AUD1 socket lost, session evicted,
    // ...) without ever producing a "send failed" text -- estText/testText
    // then just stop changing forever. Recognising this as terminal is what
    // was missing before: a dead Worker used to leave this driver polling
    // right up to its own 900s deadline, keeping Chrome (and the session
    // lock) alive that whole time and colliding with the NEXT attempt
    // launched on top of it.
    const pill = (document.getElementById("aud1State")?.textContent || "").toLowerCase();
    if (pill.includes("idle") || pill.includes("error") || testText.toLowerCase().includes("closed")) {
      await post({ sendError: "worker/session died: pill=" + pill + " test=" + testText });
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await post({ sendError: "timeout waiting for delivery" });
})().catch((e) => fetch("/event", { method: "POST", body: JSON.stringify({ sendError: e.stack || String(e) }) }));
`;

const DRIVER_B = `
(async () => {
  const post = (body) => fetch("/event", { method: "POST", body: JSON.stringify(body) }).catch(() => {});
  post({ log: "PAGE (RE)LOADED", perfNowAtLoad: performance.now() });
  // Diagnostic only: reveal every /mercury/session/* claim or ping and its
  // real outcome, to distinguish "a ping was late/failed and the client
  // re-claimed" from "the page itself reloaded" -- both would show as a
  // spurious extra claim() in the firmware's own log otherwise.
  const realFetch = fetch;
  window.fetch = function (url, opts) {
    const isSession = typeof url === "string" && url.includes("/session/");
    const p = realFetch.apply(this, arguments);
    if (isSession) {
      p.then((r) => post({ log: "fetch " + url + " -> " + r.status })).catch((e) => post({ log: "fetch " + url + " threw " + e.message }));
    }
    return p;
  };
  window.__mercuryDebug = [];
  let debugSent = 0;
  await new Promise((r) => setTimeout(r, 800));
  const listenToggle = document.getElementById("listenToggle");
  if (!listenToggle || listenToggle.disabled) { await post({ receiveError: "listen control not ready" }); return; }
  if (!listenToggle.checked) listenToggle.click();
  await post({ log: "LISTEN on" });

  const deadline = Date.now() + ${timeoutMs};
  while (Date.now() < deadline) {
    const testText = document.getElementById("connectionTest")?.textContent || "";
    const estText = document.getElementById("transferEstimate")?.textContent || "";
    const received = document.getElementById("receivedFiles")?.children.length || 0;
    if (window.__mercuryDebug.length > debugSent) {
      await post({ rawMsgs: window.__mercuryDebug.slice(debugSent) });
      debugSent = window.__mercuryDebug.length;
    }
    const statusVisible = document.getElementById("statusSection") ? !document.getElementById("statusSection").hidden : false;
    const statusText = document.getElementById("arqStatus")?.textContent || "";
    await post({ connState: document.getElementById("aud1State")?.textContent || "", testText, estText, receivedCount: received, statusVisible, statusText });

    if (received > 0) {
      const link = document.querySelector("#receivedFiles .received-file a");
      try {
        const buf = await (await fetch(link.href)).arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", buf);
        const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        await post({ receiveComplete: true, shaActual: hex, shaMatches: hex === ${JSON.stringify(FILE_SHA256_HEX)}, byteLength: buf.byteLength });
      } catch (e) {
        await post({ receiveComplete: true, shaMatches: false, verifyError: e.stack || String(e) });
      }
      return;
    }
    if (estText.toLowerCase().includes("receive failed")) { await post({ receiveError: estText }); return; }
    // A refused claim (session already held -- e.g. a leftover attempt this
    // driver failed to clean up last time) unchecks the arm toggle and
    // mercury.js goes no further; "listening" on its own is normal/expected
    // for a long time and must NOT be treated as terminal.
    if (!document.getElementById("listenToggle")?.checked) {
      await post({ receiveError: "LISTEN was refused or dropped (session already held?)" });
      return;
    }
    const pill = (document.getElementById("aud1State")?.textContent || "").toLowerCase();
    if (pill.includes("idle") || pill.includes("error")) {
      await post({ receiveError: "worker/session died: pill=" + pill });
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await post({ receiveError: "timeout waiting for a received file" });
})().catch((e) => fetch("/event", { method: "POST", body: JSON.stringify({ receiveError: e.stack || String(e) }) }));
`;

const serverA = makeProxy("A", hostA, portA, DRIVER_A);
const serverB = makeProxy("B", hostB, portB, DRIVER_B);

function launch(server, label, bindHost) {
  return new Promise((resolve) => {
    // The proxy MUST listen on the SAME address the real backend is bound
    // to (native/net/WiFi.h's --bind-ip), not 127.0.0.1 -- mercury-worker.js
    // opens AUD1 at ws://${location.hostname}:83/audiows, a fixed port this
    // proxy never sees requests for at all (it only fronts the HTTP/mercury
    // asset traffic). If the page were served from a DIFFERENT address than
    // where port 83 actually listens, location.hostname would point AUD1 at
    // an address with nothing bound there -- exactly what happened on the
    // first attempt (both sides timed out on "no AUD1 hello" because the
    // proxy was on 127.0.0.1 while --bind-ip put AUD1 on 127.0.0.11/.12).
    server.listen(0, bindHost, () => {
      const port = server.address().port;
      // Separate --user-data-dir per station, REQUIRED: without one, a
      // second `google-chrome --headless=new` invocation with no profile
      // dir of its own reuses whatever default/most-recent profile is
      // already running and just opens a second TAB in that same browser
      // process instead of a genuinely independent one -- confirmed live
      // 2026-08-25 (mercury-call-accept-regression memory) via `pgrep -af
      // chrome` after a "two independent stations" run showing only ONE
      // top-level chrome process for both A and B. Chrome throttles
      // JS timers (setTimeout/setInterval) in background tabs, which is
      // exactly where js8-aud1.js's self-paced ping loop and this driver's
      // own reconnect grace timers live -- a real, reproducible source of
      // the "audio session did not recover within 10000ms" hiccups seen
      // during testing, unrelated to anything in the shipped firmware/JS.
      const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `mercury-live-chrome-${label}-`));
      chromeProfileDirs.push(profileDir);
      const chrome = spawn("google-chrome", [
        "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--no-proxy-server", `--user-data-dir=${profileDir}`,
        `http://${bindHost}:${port}/mercury.html`,
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

console.log(`expecting SHA-256 ${FILE_SHA256_HEX} for a ${FILE_CONTENT.length}B file`);
Promise.all([launch(serverA, "A", hostA), launch(serverB, "B", hostB)]).then(() => {
  timer = setTimeout(() => finish(false, "overall timeout"), timeoutMs + 30000);
});
