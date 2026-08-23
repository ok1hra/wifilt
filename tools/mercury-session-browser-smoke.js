#!/usr/bin/env node
"use strict";

// Standalone check for data/mercury-session.js -- the lease/arming module
// (docs/mercury-implementace.md §4.2/§7) is not wired into mercury.html's
// visible UI yet (see mercury.js's own header comment: flipping the arm
// toggle on before a real CALL/LISTEN Worker exists behind it would show the
// operator an "ARMED" state that does nothing, exactly the half-truth this
// codebase's UI conventions refuse elsewhere). This drives the module
// directly in two real headless-Chrome tabs sharing sessionStorage (a
// duplicated-tab reproduction, same technique as
// tools/js8-session-browser-smoke.js) against a fixture server that mimics
// /mercury/session/claim|ping|release's real 200/409 contract (confirmed
// against the actual production handler via curl earlier this session).

const http = require("http"), fs = require("fs"), path = require("path");
const { spawn } = require("child_process");

const dataDir = path.resolve(__dirname, "../data");
let sessionToken = "";
let mercuryProgress = null; // {mercuryName, mercuryPercent, mercuryRemainingMs} once a claim/ping sets it

function readJson(req, cb) {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => { try { cb(JSON.parse(body || "{}")); } catch (_e) { cb({}); } });
}

function reply(res, status, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  const body = { ok: status === 200, owner: "127.0.0.1", ageMs: 200, leaseMs: 15000 };
  if (mercuryProgress) Object.assign(body, mercuryProgress);
  res.end(JSON.stringify({ ...body, ...extra }));
}

let finished = false, chrome = null, timer = null;
function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (chrome) chrome.kill("SIGTERM");
  server.close();
  const checks = result.checks || [];
  let failures = 0;
  for (const [name, pass, detail] of checks) {
    if (pass) continue;
    failures++;
    console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
  console.log(`${checks.length - failures}/${checks.length} checks passed`);
  process.exitCode = failures || checks.length === 0 ? 1 : 0;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");

  if (url.pathname === "/result" && req.method === "POST")
    return readJson(req, result => { res.writeHead(204).end(); finish(result); });

  if (url.pathname === "/mercury/session/claim" && req.method === "POST")
    return readJson(req, body => {
      if (sessionToken && sessionToken !== body.token && !body.force) return reply(res, 409);
      sessionToken = body.token || "";
      if (body.mercuryName) mercuryProgress = { mercuryName: body.mercuryName, mercuryPercent: body.mercuryPercent || 0, mercuryRemainingMs: body.mercuryRemainingMs || 0 };
      reply(res, 200);
    });

  if (url.pathname === "/mercury/session/ping" && req.method === "POST")
    return readJson(req, body => {
      if (sessionToken && sessionToken !== body.token) return reply(res, 409);
      if (body.mercuryName) mercuryProgress = { mercuryName: body.mercuryName, mercuryPercent: body.mercuryPercent || 0, mercuryRemainingMs: body.mercuryRemainingMs || 0 };
      reply(res, 200);
    });

  if (url.pathname === "/mercury/session/release" && req.method === "POST")
    return readJson(req, body => {
      if (sessionToken === body.token) { sessionToken = ""; mercuryProgress = null; }
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    });

  if (url.pathname === "/mercury-session.js") {
    res.setHeader("Content-Type", "application/javascript");
    return fs.createReadStream(path.join(dataDir, "mercury-session.js")).pipe(res);
  }

  if (url.pathname === "/page") {
    res.setHeader("Content-Type", "text/html");
    return res.end(`<!doctype html><script src="/mercury-session.js"></script><script>${PAGE_SCRIPT}</script>`);
  }

  res.writeHead(404).end();
});

server.listen(0, "127.0.0.1", () => {
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", `http://127.0.0.1:${server.address().port}/page`,
  ]);
  chrome.on("close", code => { if (!finished) finish({ checks: [["chrome stayed up", false, `exit ${code}`]] }); });
  timer = setTimeout(() => finish({ checks: [["test finished within timeout", false, "no /result POST"]] }), 20000);
});

const PAGE_SCRIPT = `
(async () => {
  // Child iframes just need MercurySession on their own window for the
  // parent to drive directly -- they must not also run the outer sequence
  // (that would recursively spawn iframes forever).
  if (new URLSearchParams(location.search).toString()) return;

  const checks = [];
  const check = (name, pass, detail = "") => checks.push([name, Boolean(pass), String(detail)]);

  // ---- 1. basic claim/ping/release on a single "tab" ----
  const granted1 = await MercurySession.claim(false);
  check("first claim is granted", granted1 === true);
  check("isHeld()/isConfirmed() true after a granted unforced claim", MercurySession.isHeld() && MercurySession.isConfirmed());

  await MercurySession.ping();
  check("ping after a held claim stays held", MercurySession.isHeld());

  MercurySession.release();
  check("isHeld() false after release()", !MercurySession.isHeld());

  const granted1b = await MercurySession.claim(false);
  check("re-claim after release is granted", granted1b === true);

  // ---- 2. duplicated tab: an iframe in the SAME top-level browsing context
  // shares sessionStorage (real browser behaviour, exactly the mechanism
  // tools/js8-session-browser-smoke.js's own comment documents) so it gets
  // the SAME token as tab 1 -- the server happily renews either, and
  // exclusivity is enforced locally via the BroadcastChannel "who was here
  // first" tiebreak, not by a 409. ----
  const dup = document.createElement("iframe");
  dup.src = "/page?dup=1";
  document.body.appendChild(dup);
  await new Promise(resolve => { dup.onload = resolve; });
  const dupGranted = await dup.contentWindow.MercurySession.claim(false);
  check("a same-token duplicate tab's claim resolves false (loses the local tiebreak)", dupGranted === false);
  check("the duplicate tab is not held after losing the tiebreak", !dup.contentWindow.MercurySession.isHeld());
  check("tab 1 keeps the lease through a duplicate tab's claim", MercurySession.isHeld());

  // ---- 3. a genuinely different device/browser: a fresh iframe whose
  // sessionStorage is seeded with its OWN token before MercurySession ever
  // reads it (same effect as a different profile), so the fixture's real
  // "different token, no force" 409 path actually fires. ----
  await MercurySession.ping({ name: "foto.jpg", percent: 43, remainingMs: 1440000 });
  const other = document.createElement("iframe");
  other.src = "/page?other=1";
  document.body.appendChild(other);
  await new Promise(resolve => { other.onload = resolve; });
  other.contentWindow.sessionStorage.setItem("mercury.session.token.v1", "deadbeefdeadbeefdeadbeefdeadbeef");
  let busyInfo = null;
  other.contentWindow.MercurySession.onBusy(info => { busyInfo = info; });
  const otherGranted = await other.contentWindow.MercurySession.claim(false);
  check("a different device's claim is refused (real 409) while tab 1 holds it", otherGranted === false);
  check("the refusal surfaces the in-progress transfer's name/percent/remaining",
    busyInfo && busyInfo.mercuryName === "foto.jpg" && busyInfo.mercuryPercent === 43 && busyInfo.mercuryRemainingMs === 1440000,
    JSON.stringify(busyInfo));

  // ---- 4. forced takeover succeeds server-side. A forced claim always
  // broadcasts locally too (so a genuinely duplicated tab in the SAME
  // browser profile drops out immediately rather than waiting on a 5s ping);
  // this single-profile test harness can only reproduce that local-broadcast
  // path, not a truly separate profile's own 5s ping cycle, but the outcome
  // it proves either way is the same: onLost fires and isHeld() goes false. ----
  let tab1Lost = null;
  MercurySession.onLost(info => { tab1Lost = info; });
  const forced = await other.contentWindow.MercurySession.claim(true);
  check("forced claim from a different device is granted", forced === true);
  check("tab 1 is notified of the takeover and reports loss", tab1Lost !== null && !MercurySession.isHeld(), JSON.stringify(tab1Lost));

  // ---- 5. armed flag persists locally (own key, independent of the lease) ----
  check("armed defaults to false", MercurySession.isArmed() === false);
  let armedSeen = null;
  MercurySession.onArmedChange(v => { armedSeen = v; });
  MercurySession.setArmed(true);
  check("setArmed(true) is reflected immediately", MercurySession.isArmed() === true);
  check("onArmedChange callback fired with the new value", armedSeen === true);
  check("armed flag persists in localStorage under its own key",
    localStorage.getItem("mercury.session.armed.v1") === "1");

  other.contentWindow.MercurySession.release();

  await fetch("/result", { method: "POST", body: JSON.stringify({ checks }) });
})().catch(e => fetch("/result", { method: "POST",
  body: JSON.stringify({ checks: [["page script ran without throwing", false, e.stack || String(e)]] }) }));
`;
