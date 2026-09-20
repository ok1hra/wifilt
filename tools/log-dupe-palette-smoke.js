#!/usr/bin/env node
"use strict";

// The call search -- duplicates and partial calls -- driven in a real browser
// against a seeded IndexedDB.
//
// It replaced one panel below the journal with two surfaces: a DUPE view that
// covers the journal whole, and a floating palette of partial matches. What
// makes it worth a harness of its own is that almost none of it is visible in
// the code that renders it:
//
//   * ARMED is a mode with no indicator. Space turns it on and both surfaces
//     then track the Call field live. Emptying the field, or Alt+W, does NOT
//     turn it off -- the surfaces simply have nothing to match and come back by
//     themselves. Getting that wrong looks exactly like the feature working.
//   * Esc is this page's panic key. It ends the search ONLY while nothing is
//     being transmitted, and /state is polled every 500 ms, so the page keeps
//     its own optimistic deadline. A regression here does not show as a wrong
//     pixel; it shows as a CW message that would not stop.
//   * The two halves have SEPARATE global switches, with different defaults.
//   * The band a stored QSO is on used to be parsed out of its display text,
//     and the parser understood only one of the two formats in the database --
//     so an ADIF-imported QSO could never turn red. That is now read off
//     frequencyHz with the text only as a fallback, and both formats are
//     checked here.
//   * The Mode cell drops out of the row's colour when the mode does not match,
//     and "match" cannot be a string compare: loggedMode() maps USB-D onto RTTY
//     or JS8 depending on who holds AUD1, and /state says CW-R where the log
//     says CW. Both traps have their own check.

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;
const commands = [];
let currentMode = "CW";
let currentTx = false;
let aud1 = {held: false, role: ""};

function stateJson() {
  return {
    connected: true, catHealthy: true, audioReady: false, lanStatus: "linked",
    btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
    fullCat: true, wifiRssi: -55, fwRev: "20260810", bdSupported: false,
    power: true, frequency: 14025000, mode: currentMode, filter: 1,
    radioAddress: "a4", transceiverType: "IC-705", radioName: "IC-705",
    tx: currentTx, ritRaw: 0, smeterRaw: 0, powerMeterRaw: 0, afGain: 100,
    keySpeed: 20, rfPower: 128, rfPowerSeen: true, supplyVolts: 13.8, swr: 1.1,
    preamp: 0, vox: 0, dxcConnected: false,
  };
}

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (chrome) { chrome.kill("SIGTERM"); setTimeout(() => chrome && chrome.kill("SIGKILL"), 2000).unref(); }
  server.close();
  const checks = result.checks || [];
  const failed = checks.filter(c => !c[1]);
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
  }
  const line = `LOG DUPE PALETTE ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
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
    request.on("end", () => {
      try { commands.push(JSON.parse(body)); } catch (_) { commands.push({raw: body}); }
      json({ok: true});
    });
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

  if (url.pathname === "/commands") return json(commands);
  if (url.pathname === "/commands/clear") { commands.length = 0; return json({ok: true}); }
  if (url.pathname === "/setMode") { currentMode = url.searchParams.get("mode") || "CW"; return json({ok: true}); }
  if (url.pathname === "/setTx")   { currentTx = url.searchParams.get("tx") === "1"; return json({ok: true}); }
  if (url.pathname === "/setAud1") {
    const role = url.searchParams.get("role") || "";
    aud1 = role ? {held: true, role} : {held: false, role: ""};
    return json({ok: true});
  }
  if (url.pathname === "/js8/session") return json(aud1);
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
  if (process.env.LOG_DUPE_SMOKE_MINIFIED === "1" && file.endsWith(".js")
      && fs.existsSync(file + ".min")) file = file + ".min";
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    response.writeHead(200, {"Content-Type": mime[path.extname(file)] || "text/plain"});
    return response.end(fs.readFileSync(file));
  }
  response.writeHead(404).end("not found");
});

const PAGE_SCRIPT = `
(async function () {
  const checks = [];
  const check = (name, ok, detail) => checks.push([name, !!ok, detail || ""]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);

  const call = () => $("inpCall");
  function type(value) {
    call().value = value;
    call().dispatchEvent(new Event("input", {bubbles: true}));
  }
  function key(k, opts) {
    const init = Object.assign({key: k, bubbles: true}, opts || {});
    call().focus();
    call().dispatchEvent(new KeyboardEvent("keydown", init));
  }
  function esc() {
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
  }
  function view()    { return $("dupeView"); }
  function viewUp()  { const v = view(); return !!v && !v.classList.contains("ds-hidden"); }
  function pal()     { return $("callPalette"); }
  function palUp()   { const p = pal(); return !!p && !p.classList.contains("ds-hidden"); }
  function palCalls() {
    const p = pal();
    if (!p) return [];
    return Array.from(p.querySelectorAll(".cp-call")).map(b => b.title);
  }
  // The palette is organised in blocks, one per level of match. Reading them
  // back as blocks is the only way an ordering check can say WHICH ordering it
  // is testing -- a flat list would let a level-vs-level difference stand in
  // for the tie-break inside a level, and pass without testing it.
  function palGroups() {
    const p = pal();
    if (!p) return [];
    return Array.from(p.querySelectorAll(".cp-group")).map(g => ({
      tag: g.querySelector(".cp-tag").textContent,
      calls: Array.from(g.querySelectorAll(".cp-call")).map(b => b.title),
    }));
  }
  function palShape() {
    return palGroups().map(g => g.tag + ":" + g.calls.join(",")).join(" | ");
  }
  function viewRows() {
    return Array.from(view().querySelectorAll(".dv-row"));
  }
  function rowCall(r) { return r.querySelector(".jcol-call").textContent; }
  function modeCell(r) { return r.querySelector(".jcol-mode"); }

  // Space arms; every later keystroke is tracked live, so the tests type
  // through the same path an operator does.
  async function arm(value) {
    type(value);
    key(" ");
    await sleep(260);
  }

  let n = 1;
  function qso(logId, callsign, opts) {
    const o = opts || {};
    const day = String(10 + (n % 18)).padStart(2, "0");
    const rec = {
      logId: logId, qsoNumber: n, call: callsign,
      qsoDateUtc: "2026-09-" + day, timeOnUtc: "12:" + String(10 + (n % 40)).padStart(2, "0"),
      timestampUtc: o.ts || ("2026-09-" + day + "T12:00:0" + (n % 9) + "Z"),
      rstSent: "599", rstReceived: "599", exchangeReceived: String(n),
      mode: o.mode || "CW", trx: "TRX1", bandClass: "HF", dxcc: null,
    };
    if (o.displayOnly) { rec.frequencyDisplay = o.displayOnly; }
    else {
      rec.frequencyHz = o.hz || 14025000;
      rec.frequencyDisplay = o.display || "14.025.00";
    }
    if (o.deleted) rec.deleted = true;
    n++;
    return rec;
  }

  try {
    for (let i = 0; i < 60 && !(window.LogDB && window.LogManager); i++) await sleep(100);
    await sleep(900);

    // ---- seed -------------------------------------------------------------
    const main = await LogDB.createLog({
      contestName: "DUPEMAIN", stationCall: "OK1HRA",
      defaultExchange: "NR", myLocator: "JO70FD", startQsoNumber: 1,
    });
    const other = await LogDB.createLog({
      contestName: "DUPEOTHER", stationCall: "OL5Q",
      defaultExchange: "NR", myLocator: "JO70FD", startQsoNumber: 1,
    });

    // OK1ABC in the active log: 20m (the radio's band), 40m, and 20m again but
    // older, so the ordering has something to order.
    await LogDB.addQso(qso(main.id, "OK1ABC", {hz: 21200000, display: "21.200.00", ts: "2026-03-01T10:00:00Z"}));
    await LogDB.addQso(qso(main.id, "OK1ABC", {hz:  7032000, display:  "7.032.00", ts: "2026-05-01T10:00:00Z"}));
    await LogDB.addQso(qso(main.id, "OK1ABC", {hz: 14025000, display: "14.025.00", ts: "2026-09-01T10:00:00Z"}));
    // same call in the OTHER log, for the global switch
    await LogDB.addQso(qso(other.id, "OK1ABC", {hz: 14025000, ts: "2026-08-01T10:00:00Z"}));
    // a deleted one, which must never appear anywhere
    await LogDB.addQso(qso(main.id, "OK1ABC", {deleted: true, ts: "2026-09-02T10:00:00Z"}));

    // partial-match fodder. OK1ABCD is one longer, OK1ABCDE two, XOK1ABCD has a
    // character BEFORE the fragment.
    await LogDB.addQso(qso(main.id, "OK1ABCD",  {hz: 14025000}));
    await LogDB.addQso(qso(main.id, "OK1ABCDE", {hz:  7032000}));
    await LogDB.addQso(qso(main.id, "XOK1ABCD", {hz:  7032000}));
    await LogDB.addQso(qso(other.id, "OK1ABCX", {hz:  7032000}));

    // the ADIF-importer shape: no frequencyHz at all, "14.0740 MHz" as text
    await LogDB.addQso(qso(main.id, "OK1IMPORT", {displayOnly: "14.0740 MHz"}));

    LogManager.activateLog(main);
    await sleep(500);

    // ---- 1. the data layer ------------------------------------------------
    let r = await LogDB.matchCalls("OK1ABC", {logId: main.id, exactGlobal: false, partialGlobal: false});
    check("exact matches the active log only", r.exact.length === 3, String(r.exact.length));
    check("a deleted QSO never enters the index",
      r.exact.every(x => x.call === "OK1ABC") && r.exact.length === 3, String(r.exact.length));
    check("the exact call is absent from the partial set",
      r.partial.every(x => x.call !== "OK1ABC"), r.partial.map(x => x.call).join(","));
    check("partial finds only strictly longer calls",
      r.partial.every(x => x.call.length > "OK1ABC".length), r.partial.map(x => x.call).join(","));

    r = await LogDB.matchCalls("OK1ABC", {logId: main.id, exactGlobal: true, partialGlobal: false});
    check("exactGlobal widens the exact half alone",
      r.exact.length === 4 && r.partial.every(x => x.logId === main.id),
      r.exact.length + " exact / " + r.partial.map(x => x.call).join(","));

    r = await LogDB.matchCalls("OK1ABC", {logId: main.id, exactGlobal: false, partialGlobal: true});
    check("partialGlobal widens the partial half alone",
      r.exact.length === 3 && r.partial.some(x => x.call === "OK1ABCX"),
      r.exact.length + " exact / " + r.partial.map(x => x.call).join(","));

    // The audit's own bug: an imported QSO carries no frequencyHz, only
    // "14.0740 MHz", and the old parser gave up on that format entirely.
    r = await LogDB.matchCalls("OK1IMPORT", {logId: main.id});
    check("a QSO with only ADIF-style display text still resolves a frequency",
      r.exact.length === 1 && r.exact[0].hz === 14074000,
      r.exact.length ? String(r.exact[0].hz) : "no match");

    // An addQso behind the index's back has to be visible without a rebuild.
    await LogDB.addQso(qso(main.id, "OK1LATE", {hz: 14025000}));
    r = await LogDB.matchCalls("OK1LATE", {logId: main.id});
    check("a QSO logged after the index was built is found at once",
      r.exact.length === 1, String(r.exact.length));

    // ---- 2. the band helper ----------------------------------------------
    check("630m is a band now", _bandFromHz(475000) === "630m", String(_bandFromHz(475000)));
    check("2200m is a band now", _bandFromHz(136500) === "2200m", String(_bandFromHz(136500)));
    check("23cm and 3cm are no longer the same band",
      _bandFromHz(1296000000) === "23cm" && _bandFromHz(10368000000) === "3cm",
      _bandFromHz(1296000000) + " / " + _bandFromHz(10368000000));

    // ---- 3. the DUPE view -------------------------------------------------
    await arm("OK1ABC");
    check("Space on an exact match opens the DUPE view", viewUp(), "");
    check("the DUPE view covers the journal header too",
      Math.abs(view().getBoundingClientRect().top - $("logJournal").getBoundingClientRect().top) < 2,
      Math.round(view().getBoundingClientRect().top) + " vs " +
      Math.round($("logJournal").getBoundingClientRect().top));

    let rows = viewRows();
    check("the DUPE view lists the active log's QSOs", rows.length === 3, String(rows.length));
    const times = rows.map(x => x.querySelector(".jcol-date").textContent);
    check("oldest at the top, newest at the bottom",
      times.join(",") === times.slice().sort().join(","), times.join(","));
    check("the same-band QSO is red and the others amber",
      rows.filter(x => x.className.indexOf("dv-band") !== -1).length === 1 &&
      rows.filter(x => x.className.indexOf("dv-other") !== -1).length === 2,
      rows.map(x => x.className).join(" | "));
    check("the newest QSO is the red one, at the bottom",
      rows[rows.length - 1].className.indexOf("dv-band") !== -1,
      rows[rows.length - 1].className);
    check("the LOG column names the log",
      rows[0].querySelector(".jcol-log").textContent.indexOf("DUPEMAIN") !== -1,
      rows[0].querySelector(".jcol-log").textContent);

    // The mode cell: same mode keeps the row's colour, a different one does not.
    check("a matching mode keeps the row's colour",
      viewRows().every(x => modeCell(x).className.indexOf("dv-mode-off") === -1),
      viewRows().map(x => modeCell(x).className).join(" | "));

    // /state says CW-R where the log says CW: one mode to any operator.
    await fetch("/setMode?mode=CW-R");
    await sleep(900);
    type("OK1ABC");
    await sleep(260);
    check("CW-R on the radio still matches CW in the log",
      viewRows().every(x => modeCell(x).className.indexOf("dv-mode-off") === -1),
      viewRows().map(x => modeCell(x).textContent + ":" + modeCell(x).className).join(" | "));

    await fetch("/setMode?mode=USB");
    await sleep(900);
    type("OK1ABC");
    await sleep(260);
    check("a genuinely different mode dims the Mode cell alone",
      viewRows().every(x => modeCell(x).className.indexOf("dv-mode-off") !== -1) &&
      viewRows().some(x => x.className.indexOf("dv-band") !== -1),
      viewRows().map(x => modeCell(x).className).join(" | "));

    // The headline trap: the radio sits on USB-D while RTTY-ICOM holds AUD1, so
    // a QSO logged right now would be stored as RTTY -- and must match one.
    await LogDB.addQso(qso(main.id, "OK1RTTY", {hz: 14025000, mode: "RTTY"}));
    await fetch("/setMode?mode=USB-D");
    await fetch("/setAud1?role=rtty");
    await sleep(3400);                       // aud1Role is polled every 3 s
    await arm("OK1RTTY");
    check("USB-D with RTTY-ICOM on AUD1 matches a stored RTTY QSO",
      viewUp() && viewRows().every(x => modeCell(x).className.indexOf("dv-mode-off") === -1),
      viewUp() ? viewRows().map(x => modeCell(x).textContent + ":" + modeCell(x).className).join(" | ") : "no view");
    await fetch("/setAud1?role=");
    await fetch("/setMode?mode=CW");
    await sleep(900);

    // ---- 4. the global switches are separate ------------------------------
    await arm("OK1ABC");
    check("the DUPE half is local by default", viewRows().length === 3, String(viewRows().length));
    $("chkGlobalSearch").checked = true;
    $("chkGlobalSearch").dispatchEvent(new Event("change", {bubbles: true}));
    await sleep(300);
    check("flipping global re-runs the search without another Space",
      viewRows().length === 4, String(viewRows().length));
    check("the other log's QSO carries its own station call in the LOG column",
      viewRows().some(x => x.querySelector(".jcol-log").textContent.indexOf("OL5Q") !== -1),
      viewRows().map(x => x.querySelector(".jcol-log").textContent).join(" | "));
    $("chkGlobalSearch").checked = false;
    $("chkGlobalSearch").dispatchEvent(new Event("change", {bubbles: true}));
    await sleep(300);

    // ---- 5. the palette ---------------------------------------------------
    await arm("OK1AB");
    check("a fragment with longer matches opens the palette", palUp(), "");
    check("no exact match means no DUPE view", !viewUp(), "");
    check("the palette's own global is ON by default",
      $("cpGlobal").checked === true, String($("cpGlobal").checked));
    check("the palette reaches the other log with its own switch on",
      palCalls().indexOf("OK1ABCX") !== -1, palCalls().join(","));

    // Order: worst at the top, best at the bottom, and within one level the
    // calls that START with the fragment come first.
    const groups = palGroups();
    check("one block per level, worst at the top and best at the bottom",
      groups.map(g => g.tag).join(",") === "+3,+2,+1", palShape());
    check("the closest match sits at the very bottom",
      palCalls()[palCalls().length - 1] === "OK1ABC", palShape());
    // Both of these are +3, so this is the tie-break INSIDE one level and
    // nothing else: OK1ABCDE starts with the fragment, XOK1ABCD does not.
    check("inside one level, a call starting with the fragment comes first",
      groups[0].calls.join(",") === "OK1ABCDE,XOK1ABCD", palShape());
    check("and then alphabetically",
      groups[1].calls.join(",") === "OK1ABCD,OK1ABCX", palShape());

    check("the matched fragment carries the colour class",
      !!pal().querySelector(".cp-band .cp-hl") && !!pal().querySelector(".cp-other .cp-hl"),
      Array.from(pal().querySelectorAll(".cp-call")).map(b => b.className).join(" | "));

    // The palette floats: it must not be inside the journal's column.
    check("the palette is fixed, not in the layout flow",
      getComputedStyle(pal()).position === "fixed", getComputedStyle(pal()).position);
    document.documentElement.style.setProperty("--app-h", "400px");
    await sleep(80);
    const cap = parseFloat(getComputedStyle(pal()).maxHeight);
    check("the palette is capped against --app-h, not the layout viewport",
      cap > 0 && cap <= 400 * 0.5 + 1, cap + "px");
    document.documentElement.style.removeProperty("--app-h");

    // The palette is anchored by its BOTTOM edge, and its content changes on
    // every keystroke. If a height change re-anchored instead of pushing the
    // top up, the palette would walk down the screen over the field being typed
    // in -- one row per letter, which is slow enough to look like anything but
    // a bug. Type a fragment wider and narrower and watch the bottom edge.
    const bottom0 = Math.round(pal().getBoundingClientRect().bottom);
    const walk = [], heights = [];
    for (const f of ["OK1A", "OK1AB", "OK1ABC", "OK1AB", "OK1A", "OK1AB"]) {
      type(f);
      await sleep(180);
      const r = pal().getBoundingClientRect();
      walk.push(Math.round(r.bottom));
      heights.push(Math.round(r.height));
    }
    // Stated first, because without it the check above is vacuous: a palette
    // whose height never moved cannot drift either.
    check("the list really changed height while this was measured",
      new Set(heights).size > 1, heights.join(","));
    check("the palette's bottom edge does not walk as the list resizes",
      walk.every(v => Math.abs(v - bottom0) <= 1), bottom0 + " -> " + walk.join(","));

    // Clicking a call hands it to the form the way a DXC spot does -- and the
    // armed search then turns it into an exact match on its own.
    const target = Array.from(pal().querySelectorAll(".cp-call")).find(b => b.title === "OK1ABCD");
    target.click();
    await sleep(300);
    check("clicking a call puts it in the Call field", call().value === "OK1ABCD", call().value);
    check("and the search follows it straight into the DUPE view",
      viewUp() && rowCall(viewRows()[0]) === "OK1ABCD",
      viewUp() ? rowCall(viewRows()[0]) : "no view");

    // Two characters is the floor: one letter matches everything.
    type("O");
    await sleep(260);
    check("a single character opens nothing", !palUp() && !viewUp(), "");

    // ---- 6. the armed lifecycle ------------------------------------------
    await arm("OK1AB");
    type("");
    await sleep(260);
    check("an emptied Call hides both surfaces", !palUp() && !viewUp(), "");
    type("OK1AB");
    await sleep(260);
    check("...but does NOT disarm: typing brings the palette back with no Space",
      palUp(), "");

    document.dispatchEvent(new KeyboardEvent("keydown", {key: "w", code: "KeyW", altKey: true, bubbles: true}));
    await sleep(300);
    check("Alt+W clears the form and hides the surfaces", !palUp() && !viewUp(), call().value);
    type("OK1AB");
    await sleep(260);
    check("...and does not disarm either", palUp(), "");

    // ---- 7. Esc, the panic key -------------------------------------------
    // Idle: Esc ends the search. The optimistic TX deadline is 1.5 s, and
    // nothing has been keyed since well before that.
    await fetch("/commands/clear");
    await sleep(1700);
    esc();
    await sleep(200);
    check("Esc ends the search when nothing is transmitting", !palUp(), "");
    let sent = await (await fetch("/commands")).json();
    check("...and does not abort anything",
      !sent.some(c => c.type === "abortCw"), JSON.stringify(sent));
    type("OK1AB");
    await sleep(260);
    check("Esc really disarmed: typing no longer opens the palette", !palUp(), "");

    // Transmitting: Esc goes straight to the abort, palette or no palette.
    await arm("OK1AB");
    check("re-armed for the transmitting case", palUp(), "");
    await fetch("/setTx?tx=1");
    await sleep(900);
    await fetch("/commands/clear");
    esc();
    await sleep(250);
    sent = await (await fetch("/commands")).json();
    check("Esc during TX aborts instead of closing the palette",
      sent.some(c => c.type === "abortCw"), JSON.stringify(sent));
    check("...and the palette is still open", palUp(), "");
    await fetch("/setTx?tx=0");
    await sleep(900);

    // ---- 8. a logged QSO, RUN vs S&P -------------------------------------
    $("btnRunMode").dataset.state = "RUN";
    setRunMode("RUN");
    await arm("OK1ABC");
    check("armed with the DUPE view up before logging", viewUp(), "");
    type("OK1ABC");
    $("inpExch").value = "001";
    $("inpExch").dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
    await sleep(900);
    check("a QSO logged in RUN ends the search", !viewUp() && !palUp(), "");
    type("OK1AB");
    await sleep(260);
    check("...and really disarmed it", !palUp(), "");

    setRunMode("SP");
    await arm("OK1ABC");
    type("OK1ABC");
    $("inpExch").value = "002";
    $("inpExch").dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
    await sleep(900);
    type("OK1AB");
    await sleep(300);
    check("a QSO logged in S&P leaves the search armed", palUp(), "");

    // ---- 9. the cap, last of all because it floods the database ----------
    for (let i = 0; i < 60; i++) {
      await LogDB.addQso(qso(main.id, "OK1AB" + String(i).padStart(3, "0"), {hz: 7032000}));
    }
    LogDB.invalidateCallIndex();
    await arm("OK1AB");
    check("the palette shows at most 50 calls", palCalls().length === 50, String(palCalls().length));
    check("and says how many it dropped",
      !$("cpMore").classList.contains("ds-hidden") && $("cpMore").textContent.indexOf("more") !== -1,
      $("cpMore").textContent);
    // The cap drops the WORST end. The +1 match must survive 60 longer ones.
    check("the cap keeps the closest matches",
      palCalls()[palCalls().length - 1] === "OK1ABC", palCalls().slice(-4).join(","));
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
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", "--window-size=1280,900",
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
