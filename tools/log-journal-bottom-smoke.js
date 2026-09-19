#!/usr/bin/env node
"use strict";

// QRPLog's last QSO staying visible when the chrome below the journal changes
// height, driven in a real browser.
//
// The defect this guards against is not a covered row. The journal is a flex:1
// scroller with the dupe panel, band map, status bar, inputs, macro preview and
// button bar stacked BELOW it, all flex-shrink:0, and its rows are pinned to the
// bottom by .log-journal-spacer. Grow any of that chrome and the journal's
// viewport shrinks from the bottom while the browser keeps scrollTop, which is
// measured from the top -- so the newest QSO, the one being worked, slides out
// of sight by exactly the pixels the chrome gained. From a screenshot it looks
// like something covered it. Nothing did.
//
// Two things about the assertions here are deliberate.
//
// First, nothing checks `scrollHeight - scrollTop - clientHeight < 4`. That is
// the formula under test; a test written on it would pass by agreeing with the
// bug. Every check measures getBoundingClientRect() of the last .qso-row
// against the journal body's own rect -- the operator's question, "can I see
// the QSO I just worked", asked of the pixels.
//
// Second, the negative half matters as much as the positive half. An operator
// who has scrolled up to read an old QSO must NOT be yanked back when a dupe
// panel arrives; the contract is that the last QSO can be hidden by their own
// scrolling and by nothing else. That half is the one a later "let us just
// always scroll to the bottom, it is simpler" would quietly delete, so it is
// checked from both directions: scrolled up stays put, scrolled back to the
// bottom re-arms.
//
// Each positive check is paired with a precondition that the trigger really did
// shrink the journal. Without it a trigger that silently stopped working -- a
// renamed class, a display:none -- would still "pass".

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;

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

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (chrome) chrome.kill("SIGTERM");
  server.close();
  const checks = result.checks || [];
  const failed = checks.filter(c => !c[1]);
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
  }
  const line = `LOG JOURNAL BOTTOM ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
  (failed.length ? console.error : console.log)(line);
  if (failed.length) process.exitCode = 1;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  const json = body => {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify(body));
  };

  if (url.pathname === "/result" && request.method === "POST") {
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => { response.writeHead(204).end(); finish(JSON.parse(body)); });
    return;
  }

  if (url.pathname === "/cmd" && request.method === "POST") {
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => json({ok: true}));
    return;
  }

  if (url.pathname === "/log-macros.json") {
    if (request.method === "POST") {
      let body = "";
      request.on("data", c => body += c);
      request.on("end", () => { response.writeHead(200, {"Content-Type": "application/json"}); response.end("{}"); });
      return;
    }
    return json({});
  }

  if (url.pathname === "/state") return json(stateJson());
  if (url.pathname === "/dxcinfo") return json({locator: "JO70", call: "OK1HRA"});
  if (url.pathname === "/log-config") {
    return json({
      trx1Label: "TRX1", trx2Label: "TRX2", trx3Label: "TRX3",
      trx2enabled: false, trx3enabled: false, blockedDxcc: "",
    });
  }
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70"});

  let file = url.pathname === "/" ? path.join(data, "log.html")
                                  : path.join(data, path.basename(url.pathname));
  // JOURNAL_BOTTOM_SMOKE_MINIFIED=1 serves the terser output the device actually
  // ships, so a mangled name in the new code fails here rather than on the air.
  if (process.env.JOURNAL_BOTTOM_SMOKE_MINIFIED === "1" && file.endsWith(".js")
      && fs.existsSync(file + ".min")) file = file + ".min";
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    response.writeHead(200, {"Content-Type": mime[path.extname(file)] || "text/plain"});
    return response.end(fs.readFileSync(file));
  }
  response.writeHead(404).end("not found");
});

// ── The script appended to the real page ─────────────────────────────────────

const PAGE_SCRIPT = `
(async function () {
  const checks = [];
  const check = (name, ok, detail) => checks.push([name, !!ok, detail || ""]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);

  const body = $("logJournalBody");

  // Two frames: one for the style change to lay out, one for the
  // ResizeObserver callback that runs after it.
  function frames() {
    return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
  async function settle() { await frames(); await sleep(60); }

  function lastRow() {
    const rows = body.querySelectorAll(".qso-row");
    return rows.length ? rows[rows.length - 1] : null;
  }

  // The contract, in pixels: the whole of the newest QSO row sits inside the
  // journal body's visible rect. Not a scroll arithmetic -- that is the thing
  // being tested.
  function lastRowVisible() {
    const row = lastRow();
    if (!row) return false;
    const b = body.getBoundingClientRect(), r = row.getBoundingClientRect();
    return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
  }
  function lastRowWhere() {
    const row = lastRow();
    if (!row) return "no rows";
    const b = body.getBoundingClientRect(), r = row.getBoundingClientRect();
    return "row " + Math.round(r.top) + ".." + Math.round(r.bottom) +
           " vs body " + Math.round(b.top) + ".." + Math.round(b.bottom);
  }

  // Runs one trigger: applies it, waits, and reports whether the journal's
  // height really moved and whether the last QSO survived it.
  //
  // "moved", not "shrank": .kbd-open legitimately makes the journal TALLER,
  // because it hides the topbar and the band map to get the input row up
  // against the on-screen keyboard. The contract is about any height change.
  async function trigger(name, apply, undo) {
    const before = body.clientHeight;
    apply();
    await settle();
    const after = body.clientHeight;
    check(name + ": really changes the journal's height", after !== before,
      before + " -> " + after);
    check(name + ": the last QSO stays visible", lastRowVisible(), lastRowWhere());
    if (undo) { undo(); await settle(); }
  }

  function dupeLines(n) {
    const p = $("dupePanel");
    let html = "";
    for (let i = 0; i < n; i++) html += '<span class="dp-line">DUPE OK1AAA 14.025 CW 2026-09-19</span>';
    p.innerHTML = html;
    p.classList.remove("dupe-panel-hidden");
  }

  try {
    for (let i = 0; i < 60 && !(window.LogDB && window.LogManager); i++) await sleep(100);
    await sleep(900);

    // ---- seed a log long enough to overflow the viewport -------------------
    const log = await LogDB.createLog({
      contestName: "SMOKEJB", stationCall: "OK1HRA",
      defaultExchange: "NR", myLocator: "JO70",
    });
    for (let i = 1; i <= 40; i++) {
      const ss = String(i % 60).padStart(2, "0");
      await LogDB.addQso({
        logId: log.id, qsoNumber: i, call: "OK1T" + String(i).padStart(2, "0"),
        qsoDateUtc: "2026-09-19", timeOnUtc: "12:" + ss,
        timestampUtc: "2026-09-19T12:00:" + ss + "Z",
        frequencyDisplay: "14.025.00", mode: "CW",
        rstSent: "599", rstReceived: "599", exchangeReceived: String(i),
        trx: "TRX1", bandClass: "HF", deleted: false,
      });
    }
    LogManager.activateLog(log);
    await sleep(700);
    await settle();

    // ---- the ground the rest of the run stands on --------------------------
    check("all 40 QSO rendered", body.querySelectorAll(".qso-row").length === 40,
      String(body.querySelectorAll(".qso-row").length));
    check("the journal overflows its viewport",
      body.scrollHeight > body.clientHeight + 50,
      body.scrollHeight + " > " + body.clientHeight);
    check("the last QSO is visible at rest", lastRowVisible(), lastRowWhere());

    // The detector has to be able to say no, or every check above is vacuous.
    body.scrollTop = body.scrollTop - 200;
    await settle();
    check("scrolling up really does hide the last QSO", !lastRowVisible(), lastRowWhere());
    body.scrollTop = body.scrollHeight;
    await settle();
    check("scrolling back down brings it into view", lastRowVisible(), lastRowWhere());

    // ---- positive: every way the chrome can grow ---------------------------
    const bandBox = $("dxcBandBox");

    await trigger("band map on",
      () => bandBox.classList.add("dxc-active"),
      () => bandBox.classList.remove("dxc-active"));

    await trigger("band map on, then collapsed to its toolbar",
      () => { bandBox.classList.add("dxc-active"); bandBox.classList.add("dxc-collapsed"); },
      () => { bandBox.classList.remove("dxc-active"); bandBox.classList.remove("dxc-collapsed"); });

    await trigger("dupe panel full of matches",
      () => dupeLines(10),
      () => { $("dupePanel").classList.add("dupe-panel-hidden"); $("dupePanel").innerHTML = ""; });

    // The hint sits flex:1 in a row whose height is set by the 20px inputs, so
    // it has to wrap past about three lines before the row grows at all. The
    // message is therefore longer than anything showHint() sends: what is under
    // test is a taller input row, and this is how you get one at this width.
    await trigger("a hint message tall enough to grow the input row",
      () => { $("logHint").textContent =
        "Duplicate QSO with OK1AAA on 20m CW logged at 12:31 UTC, exchange 014 -- " +
        "press Alt+Enter to log it anyway, or Alt+W to clear the form and carry on. " +
        "The same call was also worked on 40m CW at 09:12 UTC and on 15m SSB at 11:48 UTC."; },
      () => { $("logHint").textContent = ""; });

    // The divider dragged far enough to wrap the input row: a height change
    // driven by WIDTH, which is the one cause no list of "things that grow the
    // bottom bar" would ever think to include. .log-split-on alone proves
    // nothing -- it only permits wrapping -- so the left pane is given the
    // flex-basis a real drag would write (log-dxc-split.js:116).
    const splitLeft = $("logSplitLeft");
    await trigger("the divider dragged narrow enough to wrap the input row",
      () => {
        document.body.classList.add("log-split-on");
        splitLeft.hidden = false;
        splitLeft.style.flexBasis = "620px";
      },
      () => {
        document.body.classList.remove("log-split-on");
        splitLeft.hidden = true;
        splitLeft.style.flexBasis = "";
      });

    // checkStoragePersistence() may already have shown this banner, so it is
    // put away first -- otherwise "remove ds-hidden" is a no-op and it is the
    // UNDO that moves the layout, under every measurement that follows.
    $("storageWarn").classList.add("ds-hidden");
    await settle();
    await trigger("the storage warning banner above the journal",
      () => $("storageWarn").classList.remove("ds-hidden"),
      () => $("storageWarn").classList.add("ds-hidden"));

    await trigger("a shorter window",
      () => document.documentElement.style.setProperty("--app-h", "560px"),
      () => document.documentElement.style.removeProperty("--app-h"));

    await trigger("the on-screen keyboard layout",
      () => document.body.classList.add("kbd-open"),
      () => document.body.classList.remove("kbd-open"));

    // Everything at once -- the state an operator running a contest with the
    // band map up and a dupe on screen actually sees.
    await trigger("band map, dupe panel and hint all at once",
      () => {
        bandBox.classList.add("dxc-active");
        dupeLines(8);
        $("logHint").textContent = "Duplicate QSO with OK1AAA on 20m CW logged at 12:31";
      },
      () => {
        bandBox.classList.remove("dxc-active");
        $("dupePanel").classList.add("dupe-panel-hidden");
        $("dupePanel").innerHTML = "";
        $("logHint").textContent = "";
      });

    // ---- the journal zoom, which no observer can see -----------------------
    // Alt+ scales the ROWS, which is content, not the body's box. The header
    // scales too, but at 0.1 steps that is ~1.4px against an integer
    // clientHeight and can round away entirely. stepJournalZoom therefore pins
    // by hand; this is the check that says so.
    function altSize(key, code) {
      document.dispatchEvent(new KeyboardEvent("keydown",
        {key: key, code: code, altKey: true, bubbles: true}));
    }
    let zoomOk = true, zoomWhere = "";
    for (let i = 0; i < 12; i++) {
      altSize("+", "Equal");
      await settle();
      if (!lastRowVisible()) { zoomOk = false; zoomWhere = "growing, step " + i + ": " + lastRowWhere(); break; }
    }
    check("Alt+ keeps the last QSO visible all the way to 2.5", zoomOk, zoomWhere);
    check("the zoom really grew the rows",
      parseFloat(getComputedStyle($("logJournal")).getPropertyValue("--jzoom")) > 1.5,
      getComputedStyle($("logJournal")).getPropertyValue("--jzoom"));

    zoomOk = true; zoomWhere = "";
    for (let i = 0; i < 12; i++) {
      altSize("-", "Minus");
      await settle();
      if (!lastRowVisible()) { zoomOk = false; zoomWhere = "shrinking, step " + i + ": " + lastRowWhere(); break; }
    }
    check("Alt- keeps the last QSO visible all the way back", zoomOk, zoomWhere);

    // ---- negative: the operator's own scroll is not overridden -------------
    body.scrollTop = body.scrollHeight;
    await settle();
    body.scrollTop = body.scrollTop - 220;
    await settle();
    const parked = body.scrollTop;
    check("the operator is parked above the bottom", !lastRowVisible(), lastRowWhere());

    bandBox.classList.add("dxc-active");
    await settle();
    check("a band map does NOT yank a scrolled-up operator back",
      body.scrollTop === parked, parked + " -> " + body.scrollTop);

    dupeLines(10);
    await settle();
    check("a dupe panel does NOT yank a scrolled-up operator back",
      body.scrollTop === parked, parked + " -> " + body.scrollTop);

    $("dupePanel").classList.add("dupe-panel-hidden");
    $("dupePanel").innerHTML = "";
    bandBox.classList.remove("dxc-active");
    await settle();

    // ---- re-arming: scroll back down and the pin works again ---------------
    body.scrollTop = body.scrollHeight;
    await settle();
    bandBox.classList.add("dxc-active");
    await settle();
    check("scrolling back to the bottom re-arms the pin", lastRowVisible(), lastRowWhere());
    bandBox.classList.remove("dxc-active");
    await settle();

    // ---- logging a QSO is the operator's own action, not a resize ----------
    body.scrollTop = body.scrollTop - 250;
    await settle();
    await LogDB.addQso({
      logId: log.id, qsoNumber: 41, call: "OK1T41",
      qsoDateUtc: "2026-09-19", timeOnUtc: "12:41",
      timestampUtc: "2026-09-19T12:00:41Z",
      frequencyDisplay: "14.025.00", mode: "CW",
      rstSent: "599", rstReceived: "599", exchangeReceived: "41",
      trx: "TRX1", bandClass: "HF", deleted: false,
    });
    LogManager.activateLog(log);
    await sleep(700);
    await settle();
    check("a newly logged QSO is scrolled to even from a scrolled-up journal",
      lastRowVisible(), lastRowWhere());
    check("and it is the new one", (lastRow().textContent || "").indexOf("OK1T41") >= 0,
      (lastRow().textContent || "").slice(0, 40));

    // ---- the horizontal scroll must survive a height change ----------------
    // Pinning with lastRow.scrollIntoView() instead of scrollTop would rewrite
    // scrollLeft here and slide the columns out from under the header, which
    // syncJournalHScroll keeps aligned.
    // The journal only scrolls sideways once the columns no longer fit, so the
    // divider is dragged in to make that true rather than hoping the window is
    // narrow enough.
    document.documentElement.style.setProperty("--app-h", "560px");
    document.body.classList.add("log-split-on");
    splitLeft.hidden = false;
    splitLeft.style.flexBasis = "760px";
    await settle();
    body.scrollLeft = 120;
    await settle();
    const leftBefore = body.scrollLeft;
    check("the journal really is scrolled sideways for this check",
      leftBefore > 0, String(leftBefore));
    bandBox.classList.add("dxc-active");
    await settle();
    check("a height change leaves the horizontal scroll alone",
      body.scrollLeft === leftBefore, leftBefore + " -> " + body.scrollLeft);
    check("and the header is still aligned with the rows",
      getComputedStyle($("logJournalHeader")).transform.indexOf("-" + leftBefore) > 0 ||
      $("logJournalHeader").style.transform === "translateX(-" + leftBefore + "px)",
      $("logJournalHeader").style.transform);
    bandBox.classList.remove("dxc-active");
    document.body.classList.remove("log-split-on");
    splitLeft.hidden = true;
    splitLeft.style.flexBasis = "";
    document.documentElement.style.removeProperty("--app-h");
    await settle();

    // ---- the dupe panel cap on a short window ------------------------------
    // 8em of dupe panel on a 560px window is 129px the journal cannot spare;
    // no amount of scroll pinning shows a row that has no space to exist in.
    // 400px, not 560: at 560 the min() still picks 8em and the check would
    // pass while proving nothing. 22vh of 400 is 88px, well under 8em's 120px.
    document.documentElement.style.setProperty("--app-h", "400px");
    dupeLines(10);
    await settle();
    const cap = parseFloat(getComputedStyle($("dupePanel")).maxHeight);
    check("the dupe panel is capped against the window, not just at 8em",
      cap < 120 && cap <= 400 * 0.22 + 1, cap + "px");
    check("the last QSO survives a dupe panel on a short window",
      lastRowVisible(), lastRowWhere());
    $("dupePanel").classList.add("dupe-panel-hidden");
    document.documentElement.style.removeProperty("--app-h");
  } catch (error) {
    check("the harness ran to the end", false, String(error && error.stack || error));
  }

  await fetch("/result", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({checks}),
  });
})();
`;

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  // 127.0.0.1 and not a .test host: the log page uses IndexedDB and asks about
  // storage persistence, which needs a secure context.
  //
  // The window size is part of the fixture, not a detail: 40 QSO have to
  // overflow the journal for any of this to mean anything, and the chrome has
  // to have somewhere to grow into.
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", "--window-size=1280,760",
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

// The fixture appends the test script to log.html on the way out, so the page
// under test is byte-identical to production apart from that one tag.
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file === "string" && file.endsWith("log.html"))
    return Buffer.concat([content, Buffer.from(`\n<script>${PAGE_SCRIPT}</script>\n`)]);
  return content;
};
