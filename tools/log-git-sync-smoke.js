#!/usr/bin/env node
"use strict";

// GIT LOG SYNC on the real QRPlog page, in headless Chrome, against a fake
// GitHub served from the same origin (/gh/...).
//
// The merge rules have their own test (tools/log-git-merge-test.js). This one
// is about everything around them that the merge test cannot see: that BACKUP
// is gone and the split button took its place, that one click really goes
// download -> merge -> write here -> push, that the empty-repository path makes
// the first commit, that a deletion from another device stops and asks in the
// palette (and cancelling writes nothing), that a lost race (422) retries, that
// a bad token or no network leaves the database untouched and says so, that
// the counter survives F5, and that nothing in all of it takes the caret out
// of Call. "Another device" is played by the harness writing commits straight
// into the fake repository.
//
//   node tools/log-git-sync-smoke.js

const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};
const FILE = "QSO-database.json";

let finished = false, chrome = null, timer = null;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gitsync-smoke-"));

// ── the fake interface config ────────────────────────────────────────────────
let gitCfg = {};

// ── the fake GitHub ──────────────────────────────────────────────────────────
const gh = { token: "tok123", head: null, commits: {}, blobs: {}, trees: {}, n: 0,
             fail422: 0, drop: false, delay: 120, puts: 0 };
const newSha = () => (++gh.n).toString(16).padStart(40, "0");
const treeAt = c => (c && gh.commits[c]) ? gh.trees[gh.commits[c].tree] : {};
function commit(files, message) {
  const t = newSha();
  gh.trees[t] = files;
  const c = newSha();
  gh.commits[c] = { tree: t, parent: gh.head, message };
  gh.head = c;
  return c;
}

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (chrome) chrome.kill("SIGTERM");
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  const checks = result.checks || [];
  const failed = checks.filter(c => !c[1]);
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
  }
  const line = `GIT LOG SYNC ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
  (failed.length ? console.error : console.log)(line);
  if (failed.length) process.exitCode = 1;
}

function readBody(request) {
  return new Promise(resolve => {
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => resolve(body));
  });
}

function stateJson() {
  return {
    connected: true, catHealthy: true, audioReady: false, lanStatus: "linked",
    btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
    fullCat: true, wifiRssi: -55, fwRev: "20260810", bdSupported: false,
    power: true, frequency: 14025000, mode: "CW", filter: 1,
    radioAddress: "a4", transceiverType: "IC-705", radioName: "IC-705",
    tx: false, ritRaw: 0, smeterRaw: 0, powerMeterRaw: 0, afGain: 100,
    keySpeed: 20, rfPower: 128, rfPowerSeen: true, supplyVolts: 13.8, swr: 1.1,
    preamp: 0, vox: 0, dxcConnected: false,
  };
}

async function handleGh(request, response, url, json) {
  if (gh.drop) { request.socket.destroy(); return; }
  await new Promise(r => setTimeout(r, gh.delay));
  if (request.headers.authorization !== "Bearer " + gh.token)
    return json(401, { message: "Bad credentials" });
  const p = url.pathname.replace(/^\/gh\/repos\/o\/r\//, "");
  const body = request.method === "GET" ? null : JSON.parse((await readBody(request)) || "{}");

  if (request.method === "GET" && p === "git/ref/heads/main") {
    if (!gh.head) return json(409, { message: "Git Repository is empty." });
    return json(200, { ref: "refs/heads/main", object: { sha: gh.head, type: "commit" } });
  }
  let m;
  if (request.method === "GET" && (m = /^git\/commits\/(\w+)$/.exec(p))) {
    if (!gh.commits[m[1]]) return json(404, { message: "Not Found" });
    return json(200, { sha: m[1], tree: { sha: gh.commits[m[1]].tree } });
  }
  if (request.method === "GET" && (m = /^contents\/(.+)$/.exec(p))) {
    const text = treeAt(url.searchParams.get("ref"))[decodeURIComponent(m[1])];
    if (text == null) return json(404, { message: "Not Found" });
    const buf = Buffer.from(text);
    response.writeHead(200, { "Content-Type": "application/vnd.github.raw+json", "Content-Length": buf.length });
    return response.end(buf);
  }
  if (request.method === "PUT" && (m = /^contents\/(.+)$/.exec(p))) {
    if (gh.head) return json(422, { message: "sha wasn't supplied" });
    gh.puts++;
    const c = commit({ [decodeURIComponent(m[1])]: Buffer.from(body.content, "base64").toString("utf8") }, body.message);
    return json(201, { commit: { sha: c } });
  }
  if (request.method === "POST" && p === "git/blobs") {
    const s = newSha();
    gh.blobs[s] = body.content;
    return json(201, { sha: s });
  }
  if (request.method === "POST" && p === "git/trees") {
    const files = Object.assign({}, gh.trees[body.base_tree] || {});
    body.tree.forEach(e => { files[e.path] = gh.blobs[e.sha]; });
    const s = newSha();
    gh.trees[s] = files;
    return json(201, { sha: s });
  }
  if (request.method === "POST" && p === "git/commits") {
    const s = newSha();
    gh.commits[s] = { tree: body.tree, parent: body.parents[0], message: body.message };
    return json(201, { sha: s });
  }
  if (request.method === "PATCH" && p === "git/refs/heads/main") {
    if (gh.fail422 > 0 || gh.commits[body.sha].parent !== gh.head) {
      if (gh.fail422 > 0) {
        gh.fail422--;
        // the race, for real: someone else's commit lands first
        commit(Object.assign({}, treeAt(gh.head)), "other device");
      }
      return json(422, { message: "Update is not a fast forward" });
    }
    gh.head = body.sha;
    return json(200, { object: { sha: body.sha } });
  }
  return json(404, { message: "Not Found" });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  const json = (code, body) => {
    if (typeof code !== "number") { body = code; code = 200; }
    response.writeHead(code, {"Content-Type": "application/json"});
    response.end(JSON.stringify(body));
  };

  if (url.pathname === "/result" && request.method === "POST") {
    const body = await readBody(request);
    response.writeHead(204).end();
    return finish(JSON.parse(body));
  }
  if (url.pathname.startsWith("/gh/")) return handleGh(request, response, url, json);
  if (url.pathname === "/test/gh") {
    const b = JSON.parse((await readBody(request)) || "{}");
    if (b.seed != null) commit(Object.assign({}, treeAt(gh.head), { [FILE]: b.seed }), "device B");
    if (b.token != null) gh.token = b.token;
    if (b.fail422 != null) gh.fail422 = b.fail422;
    if (b.drop != null) gh.drop = b.drop;
    return json({ commits: Object.keys(gh.commits).length, head: gh.head, puts: gh.puts,
                  file: treeAt(gh.head)[FILE] || null,
                  message: gh.head ? gh.commits[gh.head].message : null });
  }
  if (url.pathname === "/git-backup.json") {
    if (request.method === "POST") {
      const b = await readBody(request);
      gitCfg = JSON.parse(b);
      return json({ ok: true });
    }
    return json(gitCfg);
  }
  if (url.pathname === "/test/cfg") return json(gitCfg);
  if (url.pathname === "/cmd") return json({ok: true});
  if (url.pathname === "/log-macros.json") return json({});
  if (url.pathname === "/state") return json(stateJson());
  if (url.pathname === "/pa.json") return json({present: false});
  if (url.pathname === "/dxcinfo") return json({locator: "JO70", call: "OK1HRA"});
  if (url.pathname === "/log-config") {
    return json({ trx1Label: "TRX1", trx2Label: "TRX2", trx3Label: "TRX3",
                  trx2enabled: false, trx3enabled: false, blockedDxcc: "" });
  }
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70"});

  let file = url.pathname === "/" ? path.join(data, "log.html")
                                  : path.join(data, path.basename(url.pathname));
  if (process.env.GIT_SYNC_SMOKE_MINIFIED === "1" && file.endsWith(".js")
      && fs.existsSync(file + ".min")) file = file + ".min";
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    response.writeHead(200, {"Content-Type": mime[path.extname(file)] || "text/plain"});
    return response.end(fs.readFileSync(file));
  }
  response.writeHead(404).end("not found");
});

const PAGE_SCRIPT = `
(async function () {
  const phase = sessionStorage.getItem("gsSmokePhase") || "1";
  const checks = JSON.parse(sessionStorage.getItem("gsSmokeChecks") || "[]");
  const check = (name, ok, detail) => checks.push([name, !!ok, detail || ""]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  const ghCtl = async (b) => (await fetch("/test/gh", {method: "POST", body: JSON.stringify(b || {})})).json();
  const shown = () => !!$("gsPanel") && $("gsPanel").style.display !== "none";
  const hint = () => ($("logHint") ? $("logHint").textContent : "");
  async function waitFor(cond, ms) {
    for (let t = 0; t < (ms || 8000); t += 50) { if (cond()) return true; await sleep(50); }
    return !!cond();
  }
  async function syncAndWait() {
    LogGitSync.sync();
    await sleep(30);
    await waitFor(() => !LogGitSync.isBusy() || $("gsConfirm") && !$("gsConfirm").hidden, 15000);
  }
  // A real click as a mouse makes it: mousedown first (whose default would move
  // the focus), then click.
  function press(el) {
    const ev = new MouseEvent("mousedown", {bubbles: true, cancelable: true});
    const allowed = el.dispatchEvent(ev);
    if (allowed) el.focus();
    el.click();
  }
  async function allQso() {
    const db = await LogDB.openDb();
    return new Promise(r => { const q = db.transaction("qso").objectStore("qso").getAll(); q.onsuccess = () => r(q.result); });
  }
  async function finishRun() {
    sessionStorage.removeItem("gsSmokePhase");
    sessionStorage.removeItem("gsSmokeChecks");
    await fetch("/result", { method: "POST", headers: {"Content-Type": "application/json"},
                             body: JSON.stringify({checks}) });
  }
  const now = () => new Date().toISOString();
  const q = (logId, call, extra) => Object.assign({ logId, call, qsoNumber: 1, qsoDateUtc: "2026-10-02",
    timeOnUtc: "10:00", timestampUtc: now(), rstSent: "599", rstReceived: "599", exchangeReceived: "",
    frequencyHz: 14025000, frequencyDisplay: "14.025.00", mode: "CW", trx: "TRX1", dxcc: null,
    locatorReceived: "", bandClass: "HF", note: "", source: "" }, extra || {});

  try {
    for (let i = 0; i < 80 && !(window.LogGitSync && window.LogManager && window.LogDB); i++) await sleep(100);
    await sleep(700);
    LogGitSync._setApi(location.origin + "/gh");
    const core = LogGitSync.core;

    if (phase === "2") {
      await waitFor(() => /\\(2\\)/.test($("btnGitSync").textContent), 4000);
      check("F5: the counter is recounted from the database",
            /GIT LOG SYNC \\(2\\)/.test($("btnGitSync").textContent), $("btnGitSync").textContent);
      check("F5: still coloured as unsaved", $("btnGitSync").classList.contains("btn-backup-pending"));
      await syncAndWait();
      check("F5: sync clears it", $("btnGitSync").textContent === "GIT LOG SYNC" &&
            !$("btnGitSync").classList.contains("btn-backup-pending"), $("btnGitSync").textContent);
      await finishRun();
      return;
    }

    // ── the button
    check("BACKUP is gone from QRPlog", !$("btnBackup"));
    check("the split button is there", !!$("btnGitSync") && !!$("btnGitSyncCfg"));
    check("not configured to start with", !LogGitSync.isConfigured());

    const log = await LogDB.createLog({contestName: "GITTEST", stationCall: "OK1HRA",
      defaultExchange: "NR", myLocator: "JO70FD", startQsoNumber: 1});
    LogManager.activateLog(log);
    await sleep(300);
    const q1 = await LogDB.addQso(q(log.id, "W1AW"));
    _onQsoBackupHook();     // what log.js calls after a QSO is logged
    check("unconfigured: the old auto-backup colour is on the new button",
          $("btnGitSync").classList.contains("btn-backup-pending"));

    $("inpCall").focus();
    press($("btnGitSync"));
    await waitFor(shown, 3000);
    check("unconfigured: a click opens the palette instead of syncing", shown());
    check("... and the caret stays in Call", document.activeElement === $("inpCall"),
          document.activeElement && document.activeElement.id);
    check("the palette links to the guide on GitHub",
          /github\\.com\\/ok1hra\\/wifilt\\/blob\\/main\\/SOFTWARE\\.md#git-log-sync$/.test($("gsGuide").href), $("gsGuide").href);
    check("unconfigured: the palette offers the JSON download and LOGSYNC",
          !$("gsUnconf").hidden && /LOGSYNC/.test($("gsUnconf").textContent));

    // ── configure
    $("gsRepo").value = "https://github.com/o/r";
    $("gsToken").value = "tok123";
    $("gsForm").dispatchEvent(new Event("submit", {cancelable: true}));
    await waitFor(() => LogGitSync.isConfigured(), 3000);
    const cfg1 = await (await fetch("/test/cfg")).json();
    check("SAVE stores the settings on the interface", cfg1.repo === "o/r" && cfg1.token === "tok123" &&
          cfg1.branch === "main" && cfg1.path === "QSO-database.json", JSON.stringify(cfg1));
    check("the token is never shown back", $("gsToken").value === "" && /token saved/.test($("gsTok").textContent));
    check("the viewer link follows the repository", $("gsViewer").href === "https://o.github.io/r/", $("gsViewer").href);
    await waitFor(() => /\\(1\\)/.test($("btnGitSync").textContent), 3000);
    check("configured: the counter shows the unsynced QSO", $("btnGitSync").textContent === "GIT LOG SYNC (1)",
          $("btnGitSync").textContent);
    LogGitSync.setOpen(false);

    // ── first sync, empty repository; watch the progress on the way
    // Every change the button goes through, not a sample of them: the steps
    // with no network wait in between (merge, apply) are over in less than a
    // frame, and a timer would see them only sometimes.
    const seen = { busy: false, p: [], steps: [] };
    const watch = new MutationObserver(records => {
      const b = $("btnGitSync");
      records.forEach(r => {
        if (r.type === "childList") r.addedNodes.forEach(n => {
          const t = n.textContent;
          if (/^SYNC… /.test(t) && seen.steps[seen.steps.length - 1] !== t) seen.steps.push(t);
        });
        if (r.type === "attributes" && r.attributeName === "style") {
          const v = b.style.getPropertyValue("--gs-p");
          if (v) seen.p.push(parseFloat(v));
        }
        if (r.type === "attributes" && r.attributeName === "class" && b.classList.contains("gs-busy")) seen.busy = true;
      });
    });
    watch.observe($("btnGitSync"), { childList: true, attributes: true, attributeFilter: ["style", "class"] });
    $("inpCall").focus();
    press($("btnGitSync"));
    await sleep(40);
    check("during a sync the button is disabled", $("btnGitSync").disabled);
    await waitFor(() => !LogGitSync.isBusy(), 15000);
    watch.disconnect();
    let st = await ghCtl();
    check("empty repository: the first commit is made", st.puts === 1 && st.commits === 1, JSON.stringify({puts: st.puts, c: st.commits}));
    const devId = localStorage.getItem("ds_device_id");
    let f = JSON.parse(st.file || "null");
    check("the file holds the QSO under <device>:<id>", f && f.stores.qso.length === 1 &&
          f.stores.qso[0].id === devId + ":" + q1.id, st.file && st.file.slice(0, 200));
    check("the token is not in the file", st.file && st.file.indexOf("tok123") < 0);
    const order = ["SYNC… ref", "SYNC… download", "SYNC… merge", "SYNC… apply", "SYNC… upload", "SYNC… commit", "SYNC… done"];
    check("the button names every step, in order", seen.busy &&
          JSON.stringify(seen.steps.filter(t => order.includes(t))) === JSON.stringify(order), seen.steps.join(" / "));
    check("...and fills from the left, never going back",
          seen.p.length >= 5 && seen.p.every((v, i) => i === 0 || v >= seen.p[i - 1]) && seen.p[seen.p.length - 1] === 100,
          seen.p.join(","));
    check("the click left the caret in Call", document.activeElement === $("inpCall"));
    check("after the sync the counter is gone", $("btnGitSync").textContent === "GIT LOG SYNC" &&
          !$("btnGitSync").classList.contains("btn-backup-pending"), $("btnGitSync").textContent);
    check("the hint reports the sync", /Git sync: \\+0 in, 1 out/.test(hint()), hint());
    const cfg2 = await (await fetch("/test/cfg")).json();
    check("the last sync is recorded on the interface", cfg2.lastSync && cfg2.lastSync.outCount === 1 &&
          cfg2.lastSync.sha === st.head && cfg2.token === "tok123", JSON.stringify(cfg2.lastSync));
    check("hover title tells the last sync", /Last sync/.test($("btnGitSync").title), $("btnGitSync").title);

    // ── nothing changed
    await syncAndWait();
    st = await ghCtl();
    check("a sync with nothing new makes no commit", st.commits === 1, String(st.commits));
    check("... and says so", /no changes/.test(hint()), hint());

    // ── another device: a QSO of its own, an edit of ours, a new log
    const B = "bbbbbbbb-0000-4000-8000-00000000000b";
    f = JSON.parse(st.file);
    const edited = Object.assign({}, f.stores.qso[0], { call: "W1AX", updatedAtUtc: now() });
    const logX = { id: "2026-10-02-OTHER", contestName: "OTHER", stationCall: "OK1HRA", myLocator: "JO70FD",
                   createdAtUtc: now(), updatedAtUtc: now(), nextQsoNumber: 3 };
    const bQso = Object.assign(q(log.id, "JA1ZZ"), { id: B + ":7", source_device_id: B, source_seq: 7, createdAtUtc: now() });
    const bQsoX = Object.assign(q(logX.id, "VK2AA"), { id: B + ":8", source_device_id: B, source_seq: 8, createdAtUtc: now() });
    const remote = { stores: { logs: f.stores.logs.concat([logX]), qso: [edited, bQso, bQsoX], devices: [] }, deleted_logs: [] };
    await ghCtl({ seed: core.serializeFile(core.mergeBackups(remote, null).merged, now()) });
    await sleep(20);
    await syncAndWait();
    st = await ghCtl();
    let mine = await allQso();
    check("pull: the other device's QSOs arrive", mine.some(r => r.id === B + ":7") && mine.some(r => r.id === B + ":8"),
          mine.map(r => r.id).join(","));
    check("pull: the newer edit of our own QSO lands under our own number",
          mine.some(r => r.id === q1.id && r.call === "W1AX"), JSON.stringify(mine.find(r => r.id === q1.id)));
    check("pull: the new log arrives, not active", !!(await LogDB.getLog(logX.id)) && !(await LogDB.getLog(logX.id)).active);
    check("pull: our active log stays active", LogManager.getActiveLog() && LogManager.getActiveLog().id === log.id);
    check("pull only: no commit when git already has it all", st.commits === 2, String(st.commits));
    check("pull: the hint counts what came in", /\\+3 in/.test(hint()), hint());

    // ── a lost race: someone pushes between our read and our write
    await LogDB.addQso(q(log.id, "DL1XX"));
    await ghCtl({ fail422: 1 });
    await syncAndWait();
    st = await ghCtl();
    f = JSON.parse(st.file);
    check("422: retried on top of the other commit and pushed",
          f.stores.qso.some(r => r.call === "DL1XX") && /GIT LOG SYNC/.test(st.message) && !LogGitSync.isBusy(),
          st.message);
    check("422: no error left behind", !$("btnGitSync").classList.contains("gs-error"));

    // ── another device deleted log X
    const before = (await allQso()).length;
    f = JSON.parse(st.file);
    const later = new Date(Date.now() + 1000).toISOString();
    const r2 = { stores: { logs: f.stores.logs.filter(l => l.id !== logX.id), qso: f.stores.qso.filter(r => r.logId !== logX.id),
                           devices: [] }, deleted_logs: [{ id: logX.id, deletedAtUtc: later }] };
    await ghCtl({ seed: core.serializeFile(core.mergeBackups(r2, null).merged, now()) });
    let backups = 0;
    const realBackup = window.backupDb;
    window.backupDb = async () => { backups++; return "smoke.json"; };
    const commitsBefore = (await ghCtl()).commits;
    await syncAndWait();
    check("a deletion from elsewhere stops and asks in the palette",
          shown() && !$("gsConfirm").hidden && /OTHER/.test($("gsConfirm").textContent), $("gsConfirm").textContent);
    press($("gsConfirm").querySelector("[data-gs=no]"));
    await waitFor(() => !LogGitSync.isBusy(), 5000);
    check("cancel: the log is still here", !!(await LogDB.getLog(logX.id)) && (await allQso()).length === before);
    check("cancel: nothing pushed, no backup downloaded", (await ghCtl()).commits === commitsBefore && backups === 0);
    await syncAndWait();
    press($("gsConfirm").querySelector("[data-gs=yes]"));
    await waitFor(() => !LogGitSync.isBusy(), 8000);
    check("yes: a JSON backup is downloaded first", backups === 1, String(backups));
    check("yes: the log and its QSO are gone here", !(await LogDB.getLog(logX.id)) &&
          !(await allQso()).some(r => r.logId === logX.id));
    check("yes: the tombstone is kept here", (await LogDB.getLogTombstones()).some(t => t.id === logX.id));
    window.backupDb = realBackup;
    LogGitSync.setOpen(false);

    // ── our own deletion travels
    const logY = await LogDB.createLog({contestName: "GONE", stationCall: "OK1HRA", defaultExchange: "NR",
                                        myLocator: "JO70FD", startQsoNumber: 1});
    await LogDB.addQso(q(logY.id, "EA1AA"));
    await syncAndWait();
    f = JSON.parse((await ghCtl()).file);
    check("a new log is pushed", f.stores.logs.some(l => l.id === logY.id));
    await LogDB.deleteLog(logY.id);
    await syncAndWait();
    f = JSON.parse((await ghCtl()).file);
    check("deleting a log here removes it from git and leaves a tombstone",
          !f.stores.logs.some(l => l.id === logY.id) && !f.stores.qso.some(r => r.logId === logY.id) &&
          f.deleted_logs.some(t => t.id === logY.id));
    check("one record per line in git", f.stores.qso.length === (await ghCtl()).file.split("\\n").filter(l => /"call"/.test(l)).length);

    // ── a bad token: nothing written, the palette says why
    await LogDB.addQso(q(log.id, "OK2ZZ"));
    const n1 = (await allQso()).length;
    await ghCtl({ token: "other" });
    await syncAndWait();
    check("401: the button turns red", $("btnGitSync").classList.contains("gs-error"));
    check("401: the palette opens with the reason", shown() && /401/.test($("gsError").textContent), $("gsError").textContent);
    check("401: the database is untouched", (await allQso()).length === n1);
    await ghCtl({ token: "tok123", drop: true });
    await syncAndWait();
    check("no network: said in words", /not reachable|did not answer/.test($("gsError").textContent), $("gsError").textContent);
    await ghCtl({ drop: false });
    await syncAndWait();
    check("back online: the error clears", !$("btnGitSync").classList.contains("gs-error") && $("gsError").hidden);
    LogGitSync.setOpen(false);

    // ── Esc in a palette field closes it and hands the caret back
    LogGitSync.setOpen(true);
    $("gsRepo").focus();
    $("gsRepo").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    await sleep(100);
    check("Esc in the palette closes it", !shown());
    check("... and the caret is back in Call", document.activeElement === $("inpCall"),
          document.activeElement && document.activeElement.id);

    // ── two QSOs unsynced, then F5
    await LogDB.addQso(q(log.id, "SM1AA"));
    await LogDB.addQso(q(log.id, "SP1BB"));
    sessionStorage.setItem("gsSmokeChecks", JSON.stringify(checks));
    sessionStorage.setItem("gsSmokePhase", "2");
    location.reload();
    return;
  } catch (error) {
    check("the harness ran to the end", false, String(error && error.stack || error));
  }
  await finishRun();
})();
`;

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", "--window-size=1400,900", "--user-data-dir=" + profile,
    `http://127.0.0.1:${port}/log.html`,
  ], {stdio: ["ignore", "ignore", "pipe"]});
  let chromeErrors = "";
  chrome.stderr.on("data", chunk => { chromeErrors += chunk; });
  chrome.on("error", error => finish({checks: [["chrome started", false, error.message]]}));
  chrome.on("close", code => {
    if (!finished) finish({checks: [["chrome stayed up", false, `exit ${code} ${chromeErrors.slice(-400)}`]]});
  });
  timer = setTimeout(() => finish({checks: [["the page reported within the timeout", false,
    "no /result was posted"]]}), 120000);
});

const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file === "string" && file.endsWith("log.html"))
    return Buffer.concat([content, Buffer.from(`\n<script>${PAGE_SCRIPT}</script>\n`)]);
  return content;
};
