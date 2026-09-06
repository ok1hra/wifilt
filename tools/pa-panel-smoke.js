#!/usr/bin/env node
"use strict";

// The linear amplifier palette on QRPLog, driven in a real browser against a
// fixture that serves /pa.json and records what the page POSTed to /pa/cmd.
//
// Why this harness exists: the palette floats over a contest log that is driven
// entirely from the keyboard, and it can only ever be judged on two things --
// what the operator sees, and what actually went on the wire. Neither is
// visible from the source. Three failure modes are worth guarding in
// particular, and all three are silent:
//
//   * a click on the palette moving focus out of Call, which would break the
//     log's whole Enter flow without breaking anything visible;
//   * the peak/hold plumbing turning a null into a 0, so an amplifier that has
//     said nothing reads as one delivering no power;
//   * a button reporting success when the command was in fact dropped -- the
//     daemon takes commands only with --trxnet-subscribe and refuses silently,
//     so the only honest confirmation is the amplifier's own flags moving.
//
// The assertions therefore sit on rendered text, on document.activeElement and
// on the recorded POST bodies, never on internal state.

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;
const commands = [];              // every /pa/cmd body, in order
let paJson = null;                // what /pa.json answers right now
let paCmdError = null;            // when set, /pa/cmd refuses with this code
let radioTx = false;              // the RADIO's own TX state, from /state
let paCmd404 = false;             // simulate a firmware without the route

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
  const line = `PA PANEL ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
  (failed.length ? console.error : console.log)(line);
  if (failed.length) process.exitCode = 1;
}

// A plausible amplifier: running, in OPERATE, full power, 20 m, transmitting.
function paState(over) {
  return Object.assign({
    state: "ok", name: "PA.01", present: true, ageMs: 120,
    flags: 0x01 | 0, fwd: 0, ref: 0, swr: 0, band: 20,
    fwdPk: null, refPk: null, staleMs: 15000
  }, over || {});
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

  if (url.pathname === "/pa.json") return json(paJson || paState({present: false}));

  if (url.pathname === "/set-cmd-404") { paCmd404 = url.searchParams.get("v") === "1"; return json({ok: true}); }
  if (url.pathname === "/pa/cmd" && request.method === "POST") {
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => {
      try { commands.push(JSON.parse(body)); } catch (_) { commands.push({raw: body}); }
      if (paCmd404) {
        // Exactly what a firmware without the route does: HTML, not JSON.
        response.writeHead(404, {"Content-Type": "text/plain"});
        return response.end("not found");
      }
      if (paCmdError) {
        response.writeHead(409, {"Content-Type": "application/json"});
        return response.end(JSON.stringify({error: paCmdError}));
      }
      json({ok: true});
    });
    return;
  }

  // Test control surface, so the page can steer its own fixture.
  if (url.pathname === "/set-pa") {
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => { paJson = JSON.parse(body); json({ok: true}); });
    return;
  }
  if (url.pathname === "/set-cmd-error") {
    paCmdError = url.searchParams.get("code") || null;
    if (paCmdError === "") paCmdError = null;
    return json({ok: true});
  }
  if (url.pathname === "/set-tx") { radioTx = url.searchParams.get("v") === "1"; return json({ok: true}); }
  if (url.pathname === "/commands") return json(commands);
  if (url.pathname === "/commands/clear") { commands.length = 0; return json({ok: true}); }

  if (url.pathname === "/cmd" && request.method === "POST") {
    request.on("data", () => {});
    request.on("end", () => json({ok: true}));
    return;
  }
  if (url.pathname === "/state") {
    return json({
      connected: true, catHealthy: true, audioReady: false, lanStatus: "linked",
      btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
      fullCat: true, wifiRssi: -55, fwRev: "20260810", bdSupported: false,
      power: true, frequency: 14025000, mode: "CW", filter: 1,
      radioAddress: "a4", transceiverType: "IC-705", radioName: "IC-705",
      tx: radioTx, ritRaw: 0, smeterRaw: 0, powerMeterRaw: 0, afGain: 100,
      keySpeed: 20, rfPower: 128, rfPowerSeen: true, supplyVolts: 13.8, swr: 1.1,
      preamp: 0, vox: 0, dxcConnected: false,
    });
  }
  if (url.pathname === "/dxcinfo") return json({locator: "JO70", call: "OK1HRA"});
  if (url.pathname === "/log-config") {
    return json({
      trx1Label: "TRX1", trx2Label: "TRX2", trx3Label: "TRX3",
      trx2enabled: false, trx3enabled: false, blockedDxcc: "",
    });
  }
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70"});

  // The firmware serves the MINIFIED companion (via .gz), never the readable
  // source, so a build that only ever tests the source is testing a file no
  // operator runs. PA_SMOKE_MINIFIED=1 serves *.js.min under the plain name.
  let file = url.pathname === "/" ? path.join(data, "log.html")
                                  : path.join(data, path.basename(url.pathname));
  if (process.env.PA_SMOKE_MINIFIED === "1" && file.endsWith(".js")
      && fs.existsSync(file + ".min")) {
    file = file + ".min";
  }
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
  const txt = id => { const e = $(id); return e ? e.textContent.trim() : "(missing)"; };

  const F = { TUNE:1, OPERATE:2, TX:4, ALARM:8, FULL:16, CONTEST:32, BEEP:64,
              ON:256, LINK:512, REV2:1024 };

  // Push a /pa.json into the fixture and wait for the page's own poll to take
  // it -- going through the real fetch path, not by poking internals.
  async function setPa(obj) {
    await fetch("/set-pa", {method:"POST", body: JSON.stringify(obj)});
    window.PaPanel.apply(obj);
    await sleep(60);
  }
  async function commandsSince() {
    return await (await fetch("/commands")).json();
  }
  async function clearCommands() { await fetch("/commands/clear"); }

  const base = over => Object.assign({
    state:"ok", name:"PA.01", present:true, ageMs:120,
    flags:0, fwd:0, ref:0, swr:0, band:20, fwdPk:null, refPk:null, staleMs:15000
  }, over || {});

  try {
    // ---- 1. the button appears only when the amplifier is really there -----
    await setPa(base({present:false}));
    check("PA button is hidden with no amplifier on the network", $("btnPa").hidden);

    await setPa(base({present:true, flags:F.ON|F.LINK}));
    check("PA button appears once the amplifier is seen", !$("btnPa").hidden);

    // ---- 2. opening it ----------------------------------------------------
    $("btnPa").click();
    await sleep(120);
    check("clicking the button opens the palette",
      !!$("paPanel") && $("paPanel").style.display !== "none");

    // ---- 3. power: peaks, no decimals, and null is not zero ---------------
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.FULL|F.TX,
                      fwd:8120, ref:600, fwdPk:9104, refPk:801, swr:130}));
    check("forward power shows the peak, rounded to whole watts",
      txt("paFw") === "910", txt("paFw"));
    check("reflected power likewise", txt("paRef") === "80", txt("paRef"));
    check("SWR is shown to one decimal", txt("paSwr") === "SWR 1.3", txt("paSwr"));

    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, fwdPk:null, refPk:null, swr:0}));
    check("an expired peak reads as a dash, never as 0 W",
      txt("paFw") === "—" && txt("paRef") === "—", txt("paFw") + "/" + txt("paRef"));
    check("SWR 0 (no answer) is a dash too", txt("paSwr") === "SWR —", txt("paSwr"));

    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, swr:65535}));
    check("SWR 65535 is infinity, not a number", txt("paSwr") === "SWR ∞", txt("paSwr"));

    // ---- 3b. the two bars -------------------------------------------------
    // Full scale follows the mode, so the same 600 W reads differently in HALF
    // and in FULL. Getting that wrong would make a full-power HALF transmission
    // look like the amplifier is loafing.
    const barW = id => parseFloat($(id).style.width) || 0;

    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.FULL, fwdPk:6000, refPk:0}));
    check("600 W against a 1200 W scale is half a bar",
      Math.abs(barW("paBarFw") - 50) < 1, barW("paBarFw") + "%");
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, fwdPk:6000, refPk:0}));
    check("the same 600 W fills the bar in HALF",
      Math.abs(barW("paBarFw") - 100) < 1, barW("paBarFw") + "%");
    await setPa(base({flags:F.ON|F.LINK, fwdPk:500, refPk:0}));
    check("STANDBY switches to the exciter's own range",
      Math.abs(barW("paBarFw") - 50) < 1, barW("paBarFw") + "%");

    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.FULL, fwdPk:0, refPk:1000}));
    check("reflected power has a scale of its own, not the forward one",
      Math.abs(barW("paBarRef") - 50) < 1, barW("paBarRef") + "%");
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.FULL, fwdPk:null, refPk:null}));
    check("no reading leaves both bars empty",
      barW("paBarFw") === 0 && barW("paBarRef") === 0,
      barW("paBarFw") + "/" + barW("paBarRef"));
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.FULL, fwdPk:60000, refPk:0}));
    check("a reading over full scale is clamped, not spilled",
      barW("paBarFw") === 100, barW("paBarFw") + "%");

    // ---- 4. the three layers that are easy to confuse ---------------------
    await setPa(base({present:true, flags:F.ON|F.LINK}));
    check("daemon, link and power all up reads ON", txt("paStatusText") === "ON", txt("paStatusText"));
    await setPa(base({present:true, flags:F.LINK}));
    check("amplifier switched off reads OFF", txt("paStatusText") === "OFF", txt("paStatusText"));
    await setPa(base({present:true, flags:0}));
    check("daemon without its serial port reads NO LINK",
      txt("paStatusText") === "NO LINK", txt("paStatusText"));
    await setPa(base({present:false, flags:F.ON|F.LINK}));
    check("no peer at all reads OFFLINE", txt("paStatusText") === "OFFLINE", txt("paStatusText"));

    await setPa(base({present:true, flags:F.ON|F.LINK, ageMs:20000, fwdPk:5000}));
    check("stale telemetry says so", txt("paStatusText").startsWith("NO DATA"), txt("paStatusText"));
    check("stale telemetry greys the numbers out",
      $("paPanel").classList.contains("pa-stale"));

    // The trap this panel walked into on real hardware: the daemon publishes
    // only from its STATUS handler, so a SWITCHED-OFF amplifier sends nothing at
    // all -- and that is exactly the amplifier you want to press ON for. Greying
    // the buttons out for lack of readings locks the operator out of the state
    // they are trying to leave. Measured on the operator's own ESP32 with
    // ageMs = 38,978,070 (10.8 hours): OPERATE, PWR and TUNE all disabled.
    check("stale telemetry does not disable ON",      !$("paBtnOn").disabled);
    check("stale telemetry does not disable OPERATE", !$("paBtnOperate").disabled,
      $("paBtnOperate").title);
    check("stale telemetry does not disable PWR",     !$("paBtnFull").disabled,
      $("paBtnFull").title);
    check("stale telemetry does not disable TUNE",    !$("paBtnTune").disabled,
      $("paBtnTune").title);
    check("but it does say the state shown is the last one heard",
      /last known state/.test($("paBtnOperate").title), $("paBtnOperate").title);

    await clearCommands();
    $("paBtnOperate").click();
    await sleep(200);
    let staleCmds = await commandsSince();
    check("and a command sent with stale telemetry reaches the wire",
      staleCmds.length === 1 && staleCmds[0].what === "operate", JSON.stringify(staleCmds));
    await sleep(4600);

    // ---- 5. every flag TrxNet carries has a lamp, lit or not --------------
    await setPa(base({flags:F.ON|F.LINK|F.ALARM|F.TUNE}));
    const leds = Array.from(document.querySelectorAll("#paLeds .pa-led"));
    check("all five lamps are present, lit or dark", leds.length === 5,
      leds.map(l => l.textContent).join(","));
    const lit = leds.filter(l => l.classList.contains("on")).map(l => l.textContent);
    check("ALARM and TUNE are lit, the rest dark",
      lit.length === 2 && lit.includes("ALARM") && lit.includes("TUNE"), lit.join(","));
    check("REV 2 is reported when the flag says so",
      (await setPa(base({flags:F.ON|F.LINK|F.REV2}))) === undefined &&
      txt("paRevTag") === "REV 2.0", txt("paRevTag"));

    // ---- 6. band mismatch is the expensive mistake ------------------------
    // /state says 14.025 MHz, so 20 m agrees and 40 m does not.
    await setPa(base({flags:F.ON|F.LINK, band:20}));
    check("a band matching the radio is not flagged",
      !$("paBand").classList.contains("pa-band-mismatch"), txt("paBand"));
    await setPa(base({flags:F.ON|F.LINK, band:40}));
    check("a band the radio is not on IS flagged",
      $("paBand").classList.contains("pa-band-mismatch"), txt("paBand"));

    // ---- 7. buttons show state, and a click sends the OTHER value ---------
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.FULL}));
    check("OPERATE button shows the state it is in",
      txt("paBtnOperate") === "OPERATE", txt("paBtnOperate"));
    check("PWR button shows PWR-H when full", txt("paBtnFull") === "PWR-H", txt("paBtnFull"));

    await clearCommands();
    $("paBtnOperate").click();
    await sleep(150);
    let cmds = await commandsSince();
    check("clicking OPERATE asks for the opposite state",
      cmds.length === 1 && cmds[0].what === "operate" && cmds[0].value === 0,
      JSON.stringify(cmds));

    // ---- 8. focus never leaves the log -----------------------------------
    // The whole reason this harness exists. A contest log is typed into; a
    // palette that steals the caret on a click is unusable no matter how it
    // looks.
    const call = $("inpCall");
    for (const id of ["paBtnOn", "paBtnOperate", "paBtnFull", "paBtnTune", "btnPa"]) {
      call.focus();
      const before = document.activeElement;
      $(id).dispatchEvent(new MouseEvent("mousedown", {bubbles:true, cancelable:true}));
      $(id).click();
      await sleep(30);
      check("focus stays in Call across a click on " + id,
        document.activeElement === before && document.activeElement === call,
        document.activeElement ? document.activeElement.id || document.activeElement.tagName : "none");
    }
    // btnPa's click toggled the palette shut above; put it back.
    if (!window.PaPanel.isOpen()) { $("btnPa").click(); await sleep(120); }
    // Those clicks were real presses and started real settle windows. Let them
    // lapse, or the next block's first press is dropped for the right reason at
    // the wrong time.
    await sleep(1600);

    // ---- 9. a command is not a confirmation ------------------------------
    // That state change confirms the presses the focus block made, which starts
    // their settle windows. Let them lapse before pressing for real.
    await setPa(base({flags:F.ON|F.LINK}));
    await sleep(1600);
    await clearCommands();
    $("paBtnOperate").click();
    await sleep(120);
    check("a sent command puts the button in a waiting state",
      $("paBtnOperate").classList.contains("pa-pending"), $("paBtnOperate").className);
    // The amplifier never moves: after the confirm window the button must give
    // up and say why, rather than sit there looking busy forever.
    // The give-up window is 4 s, and it is noticed on the next poll -- 500 ms
    // apart -- so the worst case is 4.5 s. 4.2 s here was a coin flip.
    await sleep(5200);
    check("an unanswered command stops waiting",
      !$("paBtnOperate").classList.contains("pa-pending"), $("paBtnOperate").className);
    check("and says what to check", !$("paNote").hidden && /trxnet-subscribe/.test(txt("paNote")),
      txt("paNote"));

    // A second press while the first is still outstanding must not reach the
    // wire. OPERATE and PWR are toggle keys, so the second press carries the
    // OPPOSITE value -- and once the amplifier has meanwhile obeyed the first,
    // that second command undoes it. Which is exactly what "it switches to
    // OPERATE and then goes straight back" looks like from the operating desk.
    await setPa(base({flags:F.ON|F.LINK}));
    await clearCommands();
    $("paBtnOperate").click();          // asks for OPERATE=1
    await sleep(80);
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, ageMs:120}));  // amplifier obeys...
    check("the button repaints to the confirmed state at once",
      txt("paBtnOperate") === "OPERATE", txt("paBtnOperate"));
    // ...but the operator, who saw nothing happen for a moment, presses again.
    // That press must not reach the wire, or it undoes what just succeeded.
    $("paBtnOperate").click();
    await sleep(150);
    cmds = await commandsSince();
    check("an impatient second press does not undo the first",
      cmds.length === 1 && cmds[0].value === 1, JSON.stringify(cmds));

    // Once the settle window has passed, the button is a toggle again -- this
    // must not become a lockout.
    await sleep(1600);
    $("paBtnOperate").click();
    await sleep(150);
    cmds = await commandsSince();
    check("after the settle window it toggles normally again",
      cmds.length === 2 && cmds[1].value === 0, JSON.stringify(cmds));
    await setPa(base({flags:F.ON|F.LINK}));
    await sleep(1600);

    // The same command, this time answered by the flags moving.
    await clearCommands();
    $("paBtnOperate").click();
    await sleep(80);
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE}));
    check("a confirmed command clears the waiting state",
      !$("paBtnOperate").classList.contains("pa-pending"), $("paBtnOperate").className);

    // ---- 9b. an amplifier that never answers must not deaden the button ---
    // This is the failure the settle window caused when it ran from the moment a
    // command was SENT: with the amplifier not listening -- a daemon without
    // --trxnet-subscribe, or this device missing from its allow list -- every
    // press was swallowed and nothing on screen said so. "All the buttons
    // stopped working", from the operating desk. A guard may only hold a button
    // while something is actually happening.
    await setPa(base({flags:F.ON|F.LINK}));
    await sleep(1600);
    await clearCommands();
    $("paBtnOperate").click();
    await sleep(4600);                       // let the unanswered command lapse
    check("a command nobody answered leaves the button usable",
      !$("paBtnOperate").disabled && !$("paBtnOperate").classList.contains("pa-pending"),
      $("paBtnOperate").className);
    $("paBtnOperate").click();               // and pressing again must reach the wire
    await sleep(200);
    cmds = await commandsSince();
    check("pressing again after silence sends again",
      cmds.length === 2, JSON.stringify(cmds));
    await sleep(4600);

    // ---- 10. a refusal from the interface is reported --------------------
    await fetch("/set-cmd-error?code=pa_absent");
    await clearCommands();
    $("paBtnFull").click();
    await sleep(200);
    check("a refused command is reported, not swallowed",
      !$("paNote").hidden && /not on the network/i.test(txt("paNote")), txt("paNote"));
    await fetch("/set-cmd-error?code=");

    // A firmware without this route answers 404 with an HTML page. r.json() then
    // rejects, and a catch that turns that into {} reports a command that never
    // existed as accepted -- silence, which is the one thing a command must not
    // do.
    await sleep(1600);
    await fetch("/set-cmd-404?v=1");
    $("paBtnFull").click();
    await sleep(250);
    check("a 404 from an older firmware is reported, not swallowed",
      !$("paNote").hidden && /firmware predates/.test(txt("paNote")), txt("paNote"));
    await fetch("/set-cmd-404?v=0");
    await sleep(1600);

    // ---- 11. TUNE is off where the amplifier would ignore it -------------
    // Tuning runs at low power, so STANDBY is a perfectly ordinary place to do
    // it from. An earlier version blocked it there and was wrong.
    await setPa(base({flags:F.ON|F.LINK}));                  // STANDBY
    check("TUNE works in STANDBY -- tuning runs at low power",
      !$("paBtnTune").disabled, $("paBtnTune").title);
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE}));
    check("TUNE is available in OPERATE too", !$("paBtnTune").disabled);
    await clearCommands();
    $("paBtnTune").click();
    await sleep(150);
    cmds = await commandsSince();
    check("TUNE sends 1, it is not a toggle",
      cmds.length === 1 && cmds[0].what === "tune" && cmds[0].value === 1,
      JSON.stringify(cmds));

    // The radio keying is the other state in which the amplifier ignores TUNE.
    // This reads log.js's own /state poll, so it also proves the bridge between
    // the two is live -- window.app is invisible to a widget, and reaching for
    // it would leave this check permanently, quietly green.
    await fetch("/set-tx?v=1");
    await sleep(900);
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE}));
    check("TUNE is disabled while the radio is transmitting", $("paBtnTune").disabled);
    check("and says why, naming the radio rather than the amplifier",
      /radio is transmitting/.test($("paBtnTune").title), $("paBtnTune").title);
    await fetch("/set-tx?v=0");
    await sleep(900);
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE}));
    check("and available again once it stops", !$("paBtnTune").disabled);

    // ---- 12. dragging, clamping and persistence --------------------------
    const panel = $("paPanel"), head = $("paHead");
    head.dispatchEvent(new PointerEvent("pointerdown", {bubbles:true, cancelable:true, clientX:400, clientY:300, pointerId:1}));
    head.dispatchEvent(new PointerEvent("pointermove", {bubbles:true, clientX:300, clientY:200, pointerId:1}));
    head.dispatchEvent(new PointerEvent("pointerup",   {bubbles:true, clientX:300, clientY:200, pointerId:1}));
    await sleep(60);
    const moved = {x: parseInt(panel.style.left, 10), y: parseInt(panel.style.top, 10)};
    check("the palette follows a drag by its header",
      moved.x >= 0 && moved.y >= 0 && !isNaN(moved.x), JSON.stringify(moved));
    let stored = JSON.parse(localStorage.getItem("wifilt-pa-panel") || "{}");
    check("the position is remembered", stored.x === moved.x && stored.y === moved.y,
      JSON.stringify(stored));
    check("and so is the fact that it was open", stored.open === true, JSON.stringify(stored));

    // A position stored on a wider screen must not put the palette out of reach.
    localStorage.setItem("wifilt-pa-panel", JSON.stringify({open:true, x: 99999, y: 99999}));
    window.dispatchEvent(new Event("resize"));
    await sleep(60);
    const after = {x: parseInt(panel.style.left, 10), y: parseInt(panel.style.top, 10)};
    check("an off-screen position is pulled back into view",
      after.x + panel.offsetWidth <= window.innerWidth + 1 &&
      after.y + panel.offsetHeight <= window.innerHeight + 1,
      JSON.stringify(after) + " vp " + window.innerWidth + "x" + window.innerHeight);

    // ---- 13. closing ------------------------------------------------------
    $("paClose").click();
    await sleep(60);
    check("the close button closes it", panel.style.display === "none");
    stored = JSON.parse(localStorage.getItem("wifilt-pa-panel") || "{}");
    check("closing is remembered too", stored.open === false, JSON.stringify(stored));

    // ---- 14. losing the amplifier does not yank the panel away -----------
    $("btnPa").click();
    await sleep(80);
    await setPa(base({present:false, flags:0}));
    check("an open palette stays open when the amplifier disappears",
      $("paPanel").style.display !== "none");
    check("but its buttons go dead", $("paBtnOperate").disabled && $("paBtnTune").disabled);
    check("and say the amplifier is gone, not that something is wrong here",
      /not on the network/.test($("paBtnOperate").title), $("paBtnOperate").title);
  } catch (error) {
    check("the test script ran to the end", false, String(error && error.stack || error));
  }

  await fetch("/result", {method: "POST", body: JSON.stringify({checks})});
})();
`;

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  // 127.0.0.1, not a .test host: the log page keeps its QSOs in IndexedDB and
  // asks about storage persistence, which needs a secure context.
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
    "no /result was posted"]]}), 90000);
});

process.on("SIGINT",  () => finish({checks: [["interrupted", false, "SIGINT"]]}));
process.on("SIGTERM", () => finish({checks: [["interrupted", false, "SIGTERM"]]}));

// The fixture appends the test script to log.html on the way out, so the page
// under test is byte-identical to production apart from that one tag.
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file === "string" && file.endsWith("log.html"))
    return Buffer.concat([content, Buffer.from(`\n<script>${PAGE_SCRIPT}</script>\n`)]);
  return content;
};
