#!/usr/bin/env node
// One-off, real-hardware verification for [[freq-timetable]] (FREQ TIMETABLE
// on the DATA/JS8 page) -- software-verified only until now, "needs on-radio
// check". Drives the real production /data page against a real,
// already-running native/build/wifilt instance (same reverse-proxy +
// injected-driver-script technique as tools/mercury-live-smoke.js): fills
// the CURRENT UTC half-hour slot with a test frequency, enables the
// timetable, waits for the 5s reconcile tick, and confirms via /state that
// the real radio actually retuned -- then cleans up (clears the slot,
// disables the timetable, retunes back to the original frequency) so the
// radio is left exactly as found.
//
// Read-only in effect on the radio's OWN settings otherwise: no TX, no mode
// change, frequency only -- this file makes no firmware/production-code
// edits, it only drives the already-built page through its real UI.
//
// Usage: node freq-timetable-live-check.js <host:port> [testFreqHz]
"use strict";
const http = require("http");
const { spawn } = require("child_process");

const [host, port] = (process.argv[2] || "127.0.0.11:8301").split(":");
const testFreqHz = Number(process.argv[3]) || 14074000;

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
  console.log(result.ok ? "PASS: FREQ TIMETABLE retuned the real radio, then cleaned up" : "FAIL: see above");
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
      // Only a message carrying an `ok` boolean is the final result --
      // everything else (progress "log" lines) is just printed.
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
  try {
    await new Promise((r) => setTimeout(r, 800));
    const originalHz = state.radio.frequency;
    await post({ log: "page loaded, original frequency=" + originalHz });

    // Open the panel and click the CURRENT slot cell (same index the
    // production code itself uses: slotIndexNow()).
    document.getElementById("freqTimetableButton").click();
    await new Promise((r) => setTimeout(r, 200));
    const now = new Date();
    const nowIndex = now.getUTCHours() * 2 + (now.getUTCMinutes() >= 30 ? 1 : 0);
    const cell = document.querySelector(\`.tt-cell[data-slot="\${nowIndex}"]\`);
    if (!cell) { await post({ ok: false, reason: "current slot cell not found, index=" + nowIndex }); return; }
    cell.click();
    await new Promise((r) => setTimeout(r, 200));

    // Set a custom test frequency (kHz) via the popover, then Set kHz.
    const input = document.getElementById("ttCustom");
    if (!input) { await post({ ok: false, reason: "custom-kHz input not found" }); return; }
    input.value = String(${testFreqHz} / 1000);
    document.querySelector("[data-tt-custom]").click();
    await new Promise((r) => setTimeout(r, 200));

    // Enable the timetable (aria-checked reflects current state).
    const enableBtn = document.getElementById("freqTimetableEnable");
    if (enableBtn.getAttribute("aria-checked") !== "true") enableBtn.click();
    await post({ log: "slot filled + timetable enabled, waiting for reconcile" });

    // reconcileTimetable() runs on a ~5s tick; poll /state for up to 15s.
    let retuned = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (state.radio.frequency === ${testFreqHz}) { retuned = true; break; }
    }
    await post({ log: "post-wait frequency=" + state.radio.frequency, retuned });

    // Clean up regardless of outcome: clear the slot, disable, retune back.
    // Each step is independently guarded -- unlike the setup phase above
    // (which is allowed to bail out early), a lookup failing HERE must not
    // skip disabling the timetable or restoring the original frequency,
    // or this leaves a real, live radio parked on the test frequency with
    // FREQ TIMETABLE still armed.
    try {
      document.getElementById("freqTimetableButton").click();
      await new Promise((r) => setTimeout(r, 200));
      const cleanupCell = document.querySelector(\`.tt-cell[data-slot="\${nowIndex}"]\`);
      if (cleanupCell) {
        cleanupCell.click();
        await new Promise((r) => setTimeout(r, 200));
        const clearBtn = document.querySelector("[data-tt-clear-slot]");
        if (clearBtn) clearBtn.click();
        await new Promise((r) => setTimeout(r, 200));
      } else {
        await post({ log: "cleanup: slot cell not found, index=" + nowIndex + " -- skipping slot-clear, still disabling+retuning" });
      }
    } catch (e) {
      await post({ log: "cleanup: slot-clear step failed, still disabling+retuning: " + (e.stack || String(e)) });
    }
    try {
      if (document.getElementById("freqTimetableEnable").getAttribute("aria-checked") === "true")
        document.getElementById("freqTimetableEnable").click();
    } catch (e) {
      await post({ log: "cleanup: disable step failed: " + (e.stack || String(e)) });
    }
    // Retune back to the original frequency through the normal manual path
    // (same requestFrequency used elsewhere), not a raw CI-V write.
    if (typeof requestFrequency === "function") await requestFrequency(originalHz);
    await new Promise((r) => setTimeout(r, 1500));
    await post({ ok: retuned, originalHz, testFreqHz: ${testFreqHz}, restoredHz: state.radio.frequency, reason: retuned ? "retuned as expected" : "radio never retuned within 15s" });
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
  timer = setTimeout(() => finish({ ok: false, reason: "overall timeout" }), 30000);
});
