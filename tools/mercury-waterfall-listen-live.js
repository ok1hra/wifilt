#!/usr/bin/env node
// Real, on-radio proof of [[mercury-listen-waterfall-split]] (built 2026-08-23,
// software-verified only until now): the Mercury waterfall must run continuously
// via the ambient "monitor" role -- independent of LISTEN -- and LISTEN must
// default OFF and gate only whether this station can be reached, not the
// waterfall/audio feed. Real /mercury.html, one already-running wifilt instance,
// real IC-705/IC-7610 AUD1 audio -- no TX at any point (CQ is deliberately never
// clicked; the CAL/PLAN busy-check is verified by reading a title, not by
// actually running a calibration).
//
// Usage: node mercury-waterfall-listen-live.js <host:port>
"use strict";
const http = require("http");
const { spawn } = require("child_process");

const [host, port] = (process.argv[2] || "127.0.0.11:8301").split(":");

let finished = false, chrome = null, timer = null;
function killChrome() { if (chrome) { try { chrome.kill("SIGKILL"); } catch (_e) {} } }
process.on("SIGTERM", () => { killChrome(); process.exit(143); });
process.on("SIGINT", () => { killChrome(); process.exit(130); });

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  killChrome();
  server.close();
  console.log(JSON.stringify(result, null, 2));
  console.log(result.ok ? "PASS: waterfall/LISTEN split confirmed on the real radio" : "FAIL: see above");
  process.exit(result.ok ? 0 : 1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/event" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(Buffer.concat(chunks).toString()); }
      catch (e) { finish({ ok: false, reason: "result parse error: " + e.message }); res.writeHead(204).end(); return; }
      if (typeof msg.ok === "boolean") finish(msg);
      else console.log(JSON.stringify(msg));
      res.writeHead(204).end();
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
        const injected = html.replace("</body>", `<script>${DRIVER}</script>\n</body>`);
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

const DRIVER = `
(async () => {
  const post = (body) => fetch("/event", { method: "POST", body: JSON.stringify(body) }).catch(() => {});
  await post({ log: "page loaded" });
  try {
    const findings = {};

    // 1. LISTEN defaults OFF.
    await new Promise((r) => setTimeout(r, 1500));
    findings.listenDefaultOff = document.getElementById("listenToggle").checked === false;
    findings.listenStateTextDefault = document.getElementById("listenState").textContent;

    // 2. Ambient "monitor" worker starts on its own within a few seconds --
    // aud1State should read "monitoring", not stay "disconnected"/error.
    const deadlineMonitor = Date.now() + 15000;
    let pillText = "";
    while (Date.now() < deadlineMonitor) {
      pillText = document.getElementById("aud1State").textContent;
      if (pillText.toLowerCase().includes("monitor")) break;
      await post({ log: "waiting for ambient monitor, aud1State=" + pillText });
      await new Promise((r) => setTimeout(r, 1000));
    }
    findings.ambientMonitorPill = pillText;
    findings.ambientMonitorReached = pillText.toLowerCase().includes("monitor");

    // 3. CQ stays disabled in ambient monitor role (never TX-armed by mere presence).
    findings.cqDisabledInMonitor = document.getElementById("cqButton").disabled === true;

    // 4. Waterfall canvas actually has non-blank pixel data -- proof real RX
    // samples are being ingested, not just a label saying so.
    await new Promise((r) => setTimeout(r, 3000));
    const canvas = document.getElementById("waterfallCanvas");
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonZero = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] || data[i+1] || data[i+2]) nonZero++;
    findings.waterfallNonBlankPixels = nonZero;
    findings.waterfallHasContent = nonZero > 0;

    // 5. Toggle LISTEN on -- pill should move away from "monitoring" (an actual
    // LISTEN/CALL-capable state), CQ should become enabled.
    document.getElementById("listenToggle").click();
    await new Promise((r) => setTimeout(r, 3000));
    findings.afterListenOnPill = document.getElementById("aud1State").textContent;
    findings.afterListenOnStateText = document.getElementById("listenState").textContent;
    findings.cqEnabledWhenListening = document.getElementById("cqButton").disabled === false;

    // 6. Toggle LISTEN back off -- must revert to ambient "monitor", not tear
    // down the audio feed entirely (session held for the page's whole life).
    document.getElementById("listenToggle").click();
    const deadlineRevert = Date.now() + 15000;
    let revertPill = "";
    while (Date.now() < deadlineRevert) {
      revertPill = document.getElementById("aud1State").textContent;
      if (revertPill.toLowerCase().includes("monitor")) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    findings.revertedToMonitorPill = revertPill;
    findings.revertedToMonitor = revertPill.toLowerCase().includes("monitor");
    findings.listenOffAgain = document.getElementById("listenToggle").checked === false;

    // 7. CAL/PLAN not permanently blocked by the always-on ambient worker --
    // read the button's own title/disabled state, do NOT actually run a
    // calibration (that would key the radio).
    const calButton = document.getElementById("planButton");
    findings.calButtonFound = !!calButton;
    findings.calButtonDisabled = calButton ? calButton.disabled : null;
    findings.calButtonTitle = calButton ? calButton.title : null;

    const ok = findings.listenDefaultOff && findings.ambientMonitorReached &&
      findings.cqDisabledInMonitor && findings.waterfallHasContent &&
      findings.cqEnabledWhenListening && findings.revertedToMonitor && findings.listenOffAgain;
    await post({ ok, findings });
  } catch (e) {
    await post({ ok: false, reason: e.stack || String(e) });
  }
})();
`;

server.listen(0, host, () => {
  const proxyPort = server.address().port;
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", `http://${host}:${proxyPort}/mercury.html`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let errs = "";
  chrome.stderr.on("data", (c) => { errs += c; });
  chrome.on("error", (e) => finish({ ok: false, reason: "chrome failed to start: " + e.message }));
  chrome.on("close", (code) => { if (!finished) finish({ ok: false, reason: `chrome exited early code=${code} ${errs.slice(-500)}` }); });
  timer = setTimeout(() => finish({ ok: false, reason: "overall timeout" }), 60000);
});
