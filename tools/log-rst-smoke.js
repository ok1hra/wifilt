#!/usr/bin/env node
"use strict";

// The contest log's two RST fields, checked in a real browser against a fixture
// that records what the page actually POSTed to /cmd.
//
// Why this harness exists: log.html was the only page nothing drove. The report
// fields decide two things that are expensive to get wrong -- the text keyed on
// the air and the numbers written into the log -- and until this ran, both were
// only ever confirmed by reading the source. They had in fact been crossed for
// a long time: the editable field fed RST_RCVD while RST_SENT was a constant.
//
// The assertions deliberately sit on the wire (the body of /cmd) and on the
// stored QSO, not on what the page renders. A field can look right and still
// key the wrong report.

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;
const commands = [];          // every /cmd body the page sent, in order
let currentMode = "CW";
// How long /cmd sits on its answer. The default 0 is the ordinary case; the S&P
// test raises it to make the race it is about deterministic. The page captures
// the report it transmitted when the acknowledgement arrives, and in S&P the same
// Enter also writes the QSO -- so a slow answer is exactly the condition under
// which a finished QSO's report can land on the next one.
let cmdDelayMs = 0;

function stateJson() {
  return {
    connected: true, catHealthy: true, audioReady: false, lanStatus: "linked",
    btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
    fullCat: true, wifiRssi: -55, fwRev: "20260810", bdSupported: false,
    power: true, frequency: 14025000, mode: currentMode, filter: 1,
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
  const line = `LOG RST ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
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
      if (cmdDelayMs > 0) setTimeout(() => json({ok: true}), cmdDelayMs);
      else json({ok: true});
    });
    return;
  }

  if (url.pathname === "/delay-cmd") {
    cmdDelayMs = Number(url.searchParams.get("ms") || 0) || 0;
    return json({ok: true, ms: cmdDelayMs});
  }

  // Lets the browser side read back what reached the firmware.
  if (url.pathname === "/commands") return json(commands);
  if (url.pathname === "/commands/clear") { commands.length = 0; return json({ok: true}); }

  // The page under test drives the mode through /state, exactly as the radio
  // would, so the mode-follows-default rule is exercised on the real path.
  if (url.pathname === "/setMode") { currentMode = url.searchParams.get("mode") || "CW"; return json({ok: true}); }

  if (url.pathname === "/state") return json(stateJson());
  if (url.pathname === "/dxcinfo") return json({locator: "JO70", call: "OK1HRA"});
  if (url.pathname === "/log-config") {
    return json({
      trx1Label: "TRX1", trx2Label: "TRX2", trx3Label: "TRX3",
      trx2enabled: false, trx3enabled: false, blockedDxcc: "",
    });
  }
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70"});

  const file = url.pathname === "/" ? path.join(data, "log.html")
                                    : path.join(data, path.basename(url.pathname));
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

  async function commandsSince() {
    const r = await fetch("/commands");
    return r.json();
  }
  async function clearCommands() { await fetch("/commands/clear"); }
  async function lastSent() {
    const list = await commandsSince();
    return list.length ? String(list[list.length - 1].text || "") : "";
  }
  // The page posts on a promise chain; give it a moment to land.
  async function settle() { await sleep(300); }

  function type(el, value) {
    el.value = value;
    el.dispatchEvent(new Event("input", {bubbles: true}));
  }
  function enter(el) {
    el.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
  }

  try {
    // Wait for the page to have polled /state and settled into CW.
    for (let i = 0; i < 60 && !window.LogMacros; i++) await sleep(100);
    await sleep(700);

    // A log has to exist, otherwise logQso() only opens the manager modal.
    const log = await LogDB.createLog({
      contestName: "SMOKE", stationCall: "OK1HRA",
      defaultExchange: "NR", myLocator: "JO70", startQsoNumber: 1,
    });
    LogManager.activateLog(log);
    await sleep(200);

    const snt = $("inpRst"), rcv = $("inpRstRcvd"), call = $("inpCall"), exch = $("inpExch");

    // ---- 1. both fields exist and default per mode --------------------------
    check("the received report has a field of its own", !!rcv);
    check("both reports default to 599 in CW", snt.value === "599" && rcv.value === "599",
      snt.value + "/" + rcv.value);

    // The cursor must not stop on either field: Enter runs Call -> Exch.
    type(call, "OK2ABC");
    enter(call);
    await settle();
    check("Enter skips both report fields", document.activeElement === exch,
      document.activeElement && document.activeElement.id);

    // ---- 2. the sent field decides what goes on the air ---------------------
    await clearCommands();
    type(snt, "579");
    type(call, "OK2ABC");
    enter(call);                      // RUN mode -> TXEXCH
    await settle();
    const keyed = await lastSent();
    check("an overridden report is keyed, abbreviated", /57n/.test(keyed), keyed);

    // ---- 3. an unusable field falls back to the default ---------------------
    await clearCommands();
    type(snt, "5");
    enter(call);
    await settle();
    const keyedPartial = await lastSent();
    check("a half-typed report is not keyed", /5nn/.test(keyedPartial) && !/ 5 /.test(keyedPartial),
      keyedPartial);

    // ---- 4. the log records what was sent, not a later edit -----------------
    await clearCommands();
    type(snt, "559");
    type(call, "OK3XYZ");
    enter(call);                      // keys 55n
    await settle();
    type(snt, "339");                 // operator changes their mind AFTER the air
    type(rcv, "479");
    type(exch, "001");
    enter(exch);                      // logs the QSO
    await sleep(600);

    const qsos = await LogDB.getQsosForLog(log.id);
    const qso = qsos.find(q => q.call === "OK3XYZ");
    check("the QSO was stored", !!qso);
    check("the log keeps the report that was transmitted", qso && qso.rstSent === "559",
      qso && qso.rstSent);
    check("the received report is taken from its field", qso && qso.rstReceived === "479",
      qso && qso.rstReceived);

    // ---- 5. clearing the form returns both fields to the default -----------
    check("both fields are back at the default after logging",
      snt.value === "599" && rcv.value === "599", snt.value + "/" + rcv.value);

    // ---- 6. with nothing keyed, the field is what gets logged --------------
    // Phone never sends a macro, so this is the fallback path.
    await fetch("/setMode?mode=USB");
    for (let i = 0; i < 40 && LogMacros.modeGroup(window._smokeMode || "") !== "PHONE"; i++) {
      await sleep(100);
      if (snt.value === "59") break;
    }
    await sleep(500);
    check("phone drops both defaults to 59", snt.value === "59" && rcv.value === "59",
      snt.value + "/" + rcv.value);
    type(snt, "57");
    type(rcv, "55");
    type(call, "OK4PHN");
    enter(call);
    await settle();
    type(exch, "002");
    enter(exch);
    await sleep(600);
    const phone = (await LogDB.getQsosForLog(log.id)).find(q => q.call === "OK4PHN");
    check("without a transmission the sent field is logged", phone && phone.rstSent === "57",
      phone && phone.rstSent);
    check("the received field is logged in phone too", phone && phone.rstReceived === "55",
      phone && phone.rstReceived);

    // The page's own view of the radio's mode. Waiting on it beats sleeping: the
    // fields follow /state, which is polled twice a second.
    const modeNow = () => (typeof app !== "undefined" ? app.mode : "");
    const waitMode = async want => {
      for (let i = 0; i < 40 && modeNow() !== want; i++) await sleep(100);
      await sleep(150);
    };

    // ---- 7. S&P: a slow acknowledgement must not stamp the next QSO ---------
    // In S&P the same Enter keys the exchange and writes the QSO, so the
    // acknowledgement arrives after the form was cleared. It used to be taken for
    // this QSO's transmitted report, which means every S&P contact logged the
    // report of the one before it. The delay makes that race deterministic.
    await fetch("/setMode?mode=CW");
    await waitMode("CW");
    type(call, "");
    await fetch("/delay-cmd?ms=900");
    $("btnRunMode").click();                       // RUN -> S&P
    check("the page switched to S&P", $("btnRunMode").textContent.indexOf("S") === 0,
      $("btnRunMode").textContent);

    type(snt, "559");
    type(call, "OK5SP1");
    type(exch, "001");
    enter(exch);                                   // keys TXEXCHSP, logs, ack pending
    await sleep(1400);                             // the late ack lands in here
    type(call, "OK5SP2");                          // report left at the default
    type(exch, "002");
    enter(exch);
    await sleep(1400);
    await fetch("/delay-cmd?ms=0");

    const sp  = await LogDB.getQsosForLog(log.id);
    const sp1 = sp.find(q => q.call === "OK5SP1"), sp2 = sp.find(q => q.call === "OK5SP2");
    check("S&P logs the report it sent", sp1 && sp1.rstSent === "559", sp1 && sp1.rstSent);
    check("a late acknowledgement does not reach the next QSO",
      sp2 && sp2.rstSent === "599", sp2 && sp2.rstSent);
    $("btnRunMode").click();                       // back to RUN

    // ---- 8. an abandoned QSO takes its reports with it ----------------------
    type(call, "OK6ABC");
    type(snt, "339");
    type(rcv, "449");
    type(call, "");                                // the call is backspaced away
    check("abandoning a QSO resets both reports",
      snt.value === "599" && rcv.value === "599", snt.value + "/" + rcv.value);

    // ---- 9. the received field is logged as it stands -----------------------
    type(call, "OK7VRB");
    type(rcv, "4");                                // unusable, and the truth
    type(exch, "004");
    enter(exch);
    await sleep(700);
    type(call, "OK7NNN");
    type(rcv, "5NN");                              // CW spelling of 599
    type(exch, "005");
    enter(exch);
    await sleep(700);
    const vb  = await LogDB.getQsosForLog(log.id);
    const vb1 = vb.find(q => q.call === "OK7VRB"), vb2 = vb.find(q => q.call === "OK7NNN");
    check("an unusable received report is logged as typed",
      vb1 && vb1.rstReceived === "4", vb1 && vb1.rstReceived);
    check("N is folded to 9 in the log", vb2 && vb2.rstReceived === "599",
      vb2 && vb2.rstReceived);

    // ---- 10. Enter in a report field is routed into the flow ----------------
    await clearCommands();
    type(call, "OK8ENT");
    type(snt, "339");
    enter(snt);                                    // behaves as it would in EXCH
    await settle();
    const keyedFromRst = await lastSent();
    check("Enter in a report field keys the exchange", /33n/.test(keyedFromRst), keyedFromRst);
    check("and hands the cursor to EXCH", document.activeElement === exch,
      document.activeElement && document.activeElement.id);
    type(exch, "006");
    enter(snt);                                    // both filled -> logs
    await sleep(700);
    const ent = (await LogDB.getQsosForLog(log.id)).find(q => q.call === "OK8ENT");
    check("Enter in a report field logs the QSO once both fields are filled",
      !!ent && ent.rstSent === "339", ent && ent.rstSent);

    // ---- 11. the default follows the mode the radio actually reports --------
    type(call, "");
    await fetch("/setMode?mode=USB");
    await waitMode("USB");
    await fetch("/setMode?mode=USB-D");
    await waitMode("USB-D");
    check("a data mode reports three digits", snt.value === "599" && rcv.value === "599",
      modeNow() + " " + snt.value + "/" + rcv.value);

    // ---- 12. a mode with no keying path must not pretend to transmit --------
    // EXCH is emptied deliberately: with an exchange left in it, Enter in Call is
    // a no-op that sends nothing, and this check would pass without proving a
    // thing. It has to be Enter in the state that does transmit.
    await clearCommands();
    type(exch, "");
    type(call, "OK9DAT");
    enter(call);
    await settle();
    const dataCmds = await commandsSince();
    check("nothing is keyed in a data mode", dataCmds.length === 0, JSON.stringify(dataCmds));

    type(call, "");
    await fetch("/setMode?mode=WFM");
    await waitMode("WFM");
    check("WFM is phone, so two digits", snt.value === "59" && rcv.value === "59",
      modeNow() + " " + snt.value + "/" + rcv.value);
  } catch (error) {
    check("the test script ran to the end", false, String(error && error.stack || error));
  }

  await fetch("/result", {method: "POST", body: JSON.stringify({checks})});
})();
`;

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  // 127.0.0.1 and not a .test host: the log page uses IndexedDB and asks about
  // storage persistence, which needs a secure context. The radio serves this
  // page over plain HTTP on a LAN address, where that API is missing -- that
  // difference is covered by tools/data-browser-smoke.js, not here.
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", `http://127.0.0.1:${port}/log.html`,
  ], {stdio: ["ignore", "ignore", "pipe"]});
  let chromeErrors = "";
  chrome.stderr.on("data", chunk => { chromeErrors += chunk; });
  chrome.on("error", error => finish({checks: [["chrome started", false, error.message]]}));
  chrome.on("close", code => {
    if (!finished) finish({checks: [["chrome stayed up", false, `exit ${code} ${chromeErrors.slice(-400)}`]]});
  });
  timer = setTimeout(() => finish({checks: [["the page reported within the timeout", false,
    "no /result was posted"]]}), 90000);
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
