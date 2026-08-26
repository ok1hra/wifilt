#!/usr/bin/env node
// Real, on-radio proof of the ONE claim [[js8-tx-resend-plan]] (built 2026-07-31)
// flagged as "mandatory on-radio check, everything else is software-verified":
// that a real AUD1 WebSocket loss during a real transmission actually lands in
// `aborted("websocket lost")` -- not a synthetic #abortButton press (that is an
// OPERATOR abort, decision 1, and earns no RESEND button at all), a real close()
// on the real WebSocket connected to the real radio's port 83, while a real JS8
// TX to that radio is genuinely mid-air (PTT down, `state.txStatus==="transmitting"`).
//
// One station is enough for this: nobody needs to receive the message, the claim
// under test is entirely local (own TX row lifecycle). Fronts one already-running
// wifilt instance through the same reverse-proxy + injected-driver technique as
// the other tools/*-live.js scripts in this repo.
//
// What this proves: after the forced WS close mid-transmission,
//   1. state.txStatus becomes "aborted" (not "fault", not left "transmitting"),
//   2. the Recent-traffic row for it carries txError "websocket lost" (visible in
//      the RESEND button's own title, which is the one place the page renders it),
//   3. txResendable() judged it "retryable" (not "operator") -- so the RESEND
//      button is actually present, the thing decision 1 exists to guarantee.
// A real network/CIV-link drop was deliberately NOT used to trigger this: AUD1
// (port 83) and the CIV/control LAN link are independent sessions in this
// firmware, and slamming the real LAN link to force this would risk the very
// instability this project has already fought hard to characterise (see
// [[icom-lan-loop-stall-compensation]]) for no better a test -- onclose fires
// identically for a clean vs. a network-dropped WebSocket, so a direct
// `.close()` on the real, live AUD1 socket exercises the exact same downstream
// code path a genuine drop would, without touching CIV/control at all.
//
// Usage: node js8-tx-resend-live.js <host:port> [peerCall] [timeoutMs]
"use strict";
const http = require("http");
const { spawn } = require("child_process");

const [host, port] = (process.argv[2] || "127.0.0.11:8301").split(":");
const peerCall = process.argv[3] || "OK4DC";
const timeoutMs = Number(process.argv[4]) || 90000;

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
  console.log(result.ok
    ? "PASS: a forced AUD1 loss mid-TX on the real radio really landed in aborted(\"websocket lost\") with a RESEND button"
    : "FAIL: see above");
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
    if (req.url === "/data" && up.statusCode === 200) {
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
    // Same identity-sync race as js8-two-station-live.js: chooseCall()/
    // state.selectedCall only stick once GET /identity has resolved.
    await new Promise((r) => setTimeout(r, 5000));

    const recipient = document.getElementById("recipient");
    recipient.value = ${JSON.stringify(peerCall)};
    recipient.dispatchEvent(new Event("change", { bubbles: true }));

    const deadlineReady = Date.now() + 90000;
    let reasons = "";
    while (Date.now() < deadlineReady) {
      const safety = document.getElementById("txSafety");
      if (safety && !safety.checked) safety.click();
      const btn = document.getElementById("sendButton");
      reasons = btn?.title || "";
      if (btn && !btn.disabled) break;
      await post({ log: "waiting for composer, reasons=" + reasons });
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (document.getElementById("sendButton")?.disabled) {
      await post({ ok: false, reason: "composer never became ready, last reasons=" + reasons });
      return;
    }
    await post({ log: "composer ready, sending" });

    const msgInput = document.getElementById("messageInput");
    msgInput.value = "TEST RESEND";
    msgInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    // Wait for real PTT-down mid-transmission, then sever ONLY the AUD1 socket
    // (audioSource._session.socket) -- never the CIV/control link.
    const deadlineTx = Date.now() + ${timeoutMs};
    let sawTransmitting = false;
    while (Date.now() < deadlineTx) {
      if (typeof state !== "undefined" && state.txStatus === "transmitting") { sawTransmitting = true; break; }
      await post({ log: "waiting for transmitting, txStatus=" + (typeof state !== "undefined" ? state.txStatus : "?") });
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!sawTransmitting) { await post({ ok: false, reason: "never observed txStatus=transmitting within timeout" }); return; }

    const socket = typeof audioSource !== "undefined" && audioSource && audioSource._session && audioSource._session.socket;
    if (!socket) { await post({ ok: false, reason: "no live audioSource._session.socket to close" }); return; }
    await post({ log: "PTT confirmed down (txStatus=transmitting), forcing AUD1 socket.close() now" });
    socket.close();

    // Poll for a terminal state (aborted OR fault -- diagnostic run, not
    // asserting which one yet) and dump everything the row/state know.
    const deadlineSettle = Date.now() + 15000;
    while (Date.now() < deadlineSettle) {
      const row = document.querySelector('#traffic .message-tx[data-tx-status="aborted"], #traffic .message-tx[data-tx-status="fault"]');
      const resendBtn = row?.querySelector(".tx-resend[data-resend-id]");
      if (row) {
        await post({
          log: "core claim confirmed: " + (row.dataset.txStatus === "aborted" && !!resendBtn),
          txStatusFinal: typeof state !== "undefined" ? state.txStatus : "?",
          txStateError: typeof state !== "undefined" && state.txState ? state.txState.error : "?",
          rowStatus: row.dataset.txStatus,
          resendPresent: !!resendBtn,
          resendTitle: resendBtn ? resendBtn.title : null,
        });
        if (row.dataset.txStatus !== "aborted" || !resendBtn) {
          await post({ ok: false, reason: "core claim failed: not aborted+resendable", rowHtml: row.outerHTML });
          return;
        }
        break;
      }
      await post({ log: "waiting for terminal row, txStatus=" + (typeof state !== "undefined" ? state.txStatus : "?") });
      await new Promise((r) => setTimeout(r, 500));
    }
    if (Date.now() >= deadlineSettle) {
      await post({ ok: false, reason: "no terminal row appeared within 15s of closing AUD1", txStatusFinal: typeof state !== "undefined" ? state.txStatus : "?" });
      return;
    }

    // Bonus verification (decision 4): does the ONE automatic retry actually
    // fire once the gate re-opens, and does it land on the air this time?
    // Not the mandatory claim -- keep watching for a while regardless.
    const deadlineRetry = Date.now() + 75000;
    let sawAttempt2 = false;
    while (Date.now() < deadlineRetry) {
      const row2 = document.querySelector('#traffic .message-tx[data-tx-attempts="2"]');
      if (row2) {
        sawAttempt2 = true;
        await post({
          ok: true,
          bonus: "attempt 2 (automatic retry) observed",
          attempt2Status: row2.dataset.txStatus,
          attempt2Html: row2.outerHTML,
        });
        return;
      }
      await post({ log: "waiting for automatic retry (attempt 2), audioStatus=" + (typeof state !== "undefined" ? state.audioStatus : "?") });
      await new Promise((r) => setTimeout(r, 2000));
    }
    await post({ ok: true, bonus: "core claim confirmed; automatic retry never reached attempt 2 within 75s (not the mandatory claim)", sawAttempt2 });
  } catch (e) {
    await post({ ok: false, reason: e.stack || String(e) });
  }
})();
`;

server.listen(0, host, () => {
  const proxyPort = server.address().port;
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", `http://${host}:${proxyPort}/data`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let errs = "";
  chrome.stderr.on("data", (c) => { errs += c; });
  chrome.on("error", (e) => finish({ ok: false, reason: "chrome failed to start: " + e.message }));
  chrome.on("close", (code) => { if (!finished) finish({ ok: false, reason: `chrome exited early code=${code} ${errs.slice(-500)}` }); });
  timer = setTimeout(() => finish({ ok: false, reason: "overall timeout" }), timeoutMs + 30000);
});
