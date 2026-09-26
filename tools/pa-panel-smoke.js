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
let radioFreq = 14025000;         // the RADIO's own frequency, from /state
const catCommands = [];           // every /cmd body, in order -- the RADIO's
                                  // commands, kept apart from the amplifier's so
                                  // the assertions above cannot be confused by a
                                  // retune landing in the same list
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
  if (url.pathname === "/set-freq") {
    radioFreq = Number(url.searchParams.get("v") || 0) || 0;
    return json({ok: true});
  }
  if (url.pathname === "/commands") return json(commands);
  if (url.pathname === "/commands/clear") { commands.length = 0; return json({ok: true}); }
  if (url.pathname === "/cat-commands") return json(catCommands);
  if (url.pathname === "/cat-commands/clear") { catCommands.length = 0; return json({ok: true}); }

  // The radio's own command route. Recorded now, not just swallowed: the segment
  // scale's arrows are judged on the frequency that actually went out, which is
  // the only thing that says the arithmetic picked the right segment centre.
  if (url.pathname === "/cmd" && request.method === "POST") {
    let body = "";
    request.on("data", c => { body += c; });
    request.on("end", () => {
      try { catCommands.push(JSON.parse(body)); } catch (_) { catCommands.push({raw: body}); }
      json({ok: true});
    });
    return;
  }
  if (url.pathname === "/state") {
    return json({
      connected: true, catHealthy: true, audioReady: false, lanStatus: "linked",
      btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
      fullCat: true, wifiRssi: -55, fwRev: "20260810", bdSupported: false,
      power: true, frequency: radioFreq, mode: "CW", filter: 1,
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
  // What the operator can actually see: in the layout, and not hidden by
  // visibility -- the power row goes blank on receive that way, keeping its
  // height, so display and the DOM text alone would both say "there".
  const shown = el => !!el && el.getClientRects().length > 0
                      && getComputedStyle(el).visibility !== "hidden";
  const rect = id => $(id).getBoundingClientRect();

  // Contrast, WCAG relative luminance. Here because the one thing this panel
  // must never do with a value is print it where it cannot be read: every
  // reading falls back to a dash, a dash is a thin glyph, and a dash nobody can
  // see is indistinguishable from a panel that has stopped working.
  const lum = c => {
    const v = c.match(/[0-9.]+/g).slice(0, 3).map(Number).map(n => {
      n /= 255;
      return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const contrast = (fg, bg) => {
    const a = lum(fg), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  // The worst contrast among the panel's readings, against the panel itself.
  const worstContrast = ids => {
    const bg = getComputedStyle($("paPanel")).backgroundColor;
    return ids.reduce((worst, id) => {
      const c = contrast(getComputedStyle($(id)).color, bg);
      return c < worst ? c : worst;
    }, Infinity);
  };

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
  async function catSince() { return await (await fetch("/cat-commands")).json(); }
  async function clearCat() { await fetch("/cat-commands/clear"); }

  // Move the radio and wait for the page to believe it. Deliberately the long way
  // round: log.js polls /state twice a second and the palette reads log.js, so
  // this is the real path a real retune takes -- and the only one that proves the
  // bridge between the two files is intact.
  async function setFreq(hz) {
    await fetch("/set-freq?v=" + hz);
    await sleep(1300);
  }

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
    // Nothing has been transmitted since the page loaded, so there is nothing
    // to hold: the power row is blank -- no zeros, no dashes -- but there.
    check("before the first over the power row is blank",
      !Array.from(document.querySelectorAll("#paVals .pa-val")).some(shown) &&
      txt("paFw") + txt("paSwr") + txt("paRef") === "" && $("paVals").offsetHeight > 0,
      JSON.stringify(txt("paFw") + txt("paSwr") + txt("paRef")) + " h=" + $("paVals").offsetHeight);

    // ---- 3. power: peaks, no decimals, and null is not zero ---------------
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.FULL|F.TX,
                      fwd:8120, ref:600, fwdPk:9104, refPk:801, swr:130}));
    check("forward power shows the peak, rounded to whole watts",
      txt("paFw") === "910", txt("paFw"));
    check("reflected power likewise", txt("paRef") === "80", txt("paRef"));
    check("SWR is shown to one decimal", txt("paSwr") === "1.3", txt("paSwr"));
    check("while keyed, all three readings are on screen",
      shown($("paFw")) && shown($("paSwr")) && shown($("paRef")));
    // FW at the left edge, SWR in the middle, REV at the right edge.
    const rowR = rect("paVals"), fwR = rect("paFw"), swrR = rect("paSwrBox"), refR = rect("paRef");
    check("FW sits left of SWR, and SWR left of REV",
      fwR.right < swrR.left && swrR.right < refR.left,
      [fwR.right, swrR.left, swrR.right, refR.left].map(Math.round).join(","));
    check("and SWR is centred in the row",
      Math.abs((swrR.left + swrR.right) / 2 - (rowR.left + rowR.right) / 2) < 1.5,
      Math.round(swrR.left + swrR.right) / 2 + " vs " + (rowR.left + rowR.right) / 2);
    const keyedRowH = $("paVals").offsetHeight;

    // The widest the row ever gets: four digits of forward power, three of
    // reflected, and SWR 10.0 -- still inside the panel, still apart.
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.FULL|F.TX,
                      fwdPk:11804, refPk:1204, swr:1000}));
    const wRow = rect("paVals");
    const box = sel => document.querySelector(sel).getBoundingClientRect();
    const wa = box(".pa-val-fw"), wb = box(".pa-val-swr"), wc = box(".pa-val-rev");
    check("the widest readings still fit the row without touching",
      wa.left >= wRow.left - 0.5 && wc.right <= wRow.right + 0.5 &&
      wa.right < wb.left && wb.right < wc.left &&
      $("paVals").scrollWidth <= $("paVals").clientWidth,
      [wa.left, wa.right, wb.left, wb.right, wc.left, wc.right, wRow.left, wRow.right]
        .map(Math.round).join(","));

    // Receiving: the daemon keeps publishing and the peak comes back as 0 W,
    // not null. The row does not empty itself -- that read as the panel dropping
    // out, right above the bars -- it keeps the last over's readings, in one
    // dark grey, until the next over.
    const HELD_GREY = "rgb(100, 111, 127)";
    const heldGrey = () => Array.from(document.querySelectorAll(
        "#paVals .pa-val-k, #paVals .pa-val-v, #paVals .pa-val-u"))
      .filter(shown).every(e => getComputedStyle(e).color === HELD_GREY);
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, fwd:0, ref:0, fwdPk:0, refPk:0, swr:0}));
    check("on receive (FW 0) the row keeps the last over's readings",
      txt("paFw") === "1180" && txt("paSwr") === "10.0" && txt("paRef") === "120" &&
      shown($("paFw")) && shown($("paSwr")) && shown($("paRef")),
      txt("paFw") + " / " + txt("paSwr") + " / " + txt("paRef"));
    check("all of it -- labels, numbers, units -- in the one dark grey",
      $("paVals").classList.contains("pa-vals-held") && heldGrey(),
      getComputedStyle($("paFw")).color + " / " + getComputedStyle($("paSwr")).color);
    const heldC = worstContrast(["paFw", "paSwr", "paRef"]);
    check("dark, but not so dark it vanishes",
      heldC >= 3 && heldC < 4, "contrast " + heldC.toFixed(2) + ":1");
    check("not a dash, and not 0 W", !/—/.test(txt("paVals")) && txt("paFw") !== "0", txt("paVals"));
    check("and the row keeps its height, so the panel does not jump",
      $("paVals").offsetHeight === keyedRowH && keyedRowH > 0,
      $("paVals").offsetHeight + " vs " + keyedRowH);

    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, fwdPk:null, refPk:null, swr:0}));
    check("an expired peak keeps the held readings too, never 0 W",
      txt("paFw") === "1180" && $("paVals").classList.contains("pa-vals-held"), txt("paVals"));

    // Keyed, but with nothing reflected: that is the good news, and it shows --
    // live, in colour, not in the held grey.
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.TX, fwdPk:1000, refPk:0, swr:100}));
    check("REV 0 W while keyed is shown, not hidden",
      shown($("paRef")) && txt("paRef") === "0", txt("paRef"));
    check("and a live reading is back in colour",
      !$("paVals").classList.contains("pa-vals-held") &&
      getComputedStyle($("paFw")).color !== HELD_GREY, getComputedStyle($("paFw")).color);

    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.TX, fwdPk:1000, refPk:10, swr:0}));
    check("keyed with SWR 0 (no answer) leaves the middle empty",
      !shown($("paSwrBox")) && txt("paSwr") === "" && shown($("paFw")), txt("paSwr"));

    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.TX, fwdPk:1000, refPk:10, swr:65535}));
    check("SWR 65535 is infinity, not a number", txt("paSwr") === "∞", txt("paSwr"));

    // The last sample of an over often carries no SWR -- the drive is already
    // falling. The held reading is the last real one, not that 0.
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.TX, fwdPk:1000, refPk:10, swr:0}));
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, fwdPk:0, refPk:0, swr:0}));
    check("the held SWR is the over's last real reading, not its final 0",
      txt("paSwr") === "∞" && shown($("paSwr")), txt("paSwr"));
    // ...but it belongs to that over. The next one starts without it.
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.TX, fwdPk:2000, refPk:10, swr:0}));
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, fwdPk:0, refPk:0, swr:0}));
    check("a new over does not inherit the previous one's SWR",
      txt("paFw") === "200" && txt("paSwr") === "" && !shown($("paSwrBox")),
      txt("paFw") + " / " + JSON.stringify(txt("paSwr")));

    // Half as tall again as they were (5 px), rounded to a whole pixel.
    check("the power bars are 8 px each",
      document.querySelectorAll(".pa-bar").length === 2 &&
      Array.from(document.querySelectorAll(".pa-bar")).every(b => b.offsetHeight === 8),
      Array.from(document.querySelectorAll(".pa-bar")).map(b => b.offsetHeight).join(","));

    // ---- 3a. temperature --------------------------------------------------
    // /pa-temp is °C x 100 and arrived on 2026-09-08. The base fixture above
    // deliberately does NOT carry it: that is a daemon older than the topic,
    // which publishes the other five perfectly and this one never. It has to be
    // blank and not 0 °C, the same null-is-not-zero rule the power readings
    // follow -- an amplifier that has said nothing about its heatsink must not
    // read as a cold one.
    const tempCls = () => $("paTemp").className;
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE}));
    check("an amplifier that never reported a temperature shows nothing",
      txt("paTemp") === "", txt("paTemp"));
    check("and says why on hover", /not reporting a temperature/.test($("paTemp").title),
      $("paTemp").title);
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, temp:null}));
    check("and an explicit null does too", txt("paTemp") === "", txt("paTemp"));
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, temp:0}));
    check("but 0 °C is a reading, not a blank", txt("paTemp") === "0 °C", txt("paTemp"));

    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, temp:5849}));
    check("°C x 100 is shown as whole degrees", txt("paTemp") === "58 °C", txt("paTemp"));

    // The colours are the fan schedule, manual 18.17, exactly as the full web
    // console draws it -- one reading meaning one thing on both screens.
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, temp:3200}));
    check("below the first fan step the temperature stays out of the way",
      tempCls() === "pa-temp t-cool", tempCls());
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, temp:5800}));
    check("past the first fan step it is warm", tempCls() === "pa-temp t-warm", tempCls());
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, temp:6800}));
    check("past the second it is hot", tempCls() === "pa-temp t-hot", tempCls());
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, temp:7800}));
    check("past the third it is very hot", tempCls() === "pa-temp t-vhot", tempCls());
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, temp:9200}));
    check("and at 90 °C it is the amplifier's own protection tripping",
      tempCls() === "pa-temp t-trip", tempCls());

    // CONTEST moves the whole schedule: the first fan stage runs continuously,
    // so nothing is ever "cool", and the second and third steps come earlier.
    // Reading 62 °C as merely warm during a contest would understate it.
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.CONTEST, temp:3200}));
    check("in CONTEST nothing is cool, because the first fan stage never stops",
      tempCls() === "pa-temp t-warm", tempCls());
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE|F.CONTEST, temp:6200}));
    check("and the hot step comes earlier than it would outside a contest",
      tempCls() === "pa-temp t-hot", tempCls());
    await setPa(base({flags:F.ON|F.LINK|F.OPERATE, temp:6200}));
    check("the very same 62 °C is only warm with CONTEST off",
      tempCls() === "pa-temp t-warm", tempCls());

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
    // Greyed, but still legible. This was 2.09:1 once, which is "the dash is in
    // the DOM and invisible on screen" -- reported from the shack as the panel
    // showing no value and not even a dash. Measured rather than eyeballed,
    // because being unable to see it is the whole failure.
    // The band and the temperature are what is left on screen by then -- the
    // power row went blank with the peaks -- and they keep their last values.
    await setPa(base({present:true, flags:F.ON|F.LINK, ageMs:20000, band:20, temp:4500}));
    check("stale telemetry keeps the last band and temperature",
      txt("paBand") === "20 m" && txt("paTemp") === "45 °C", txt("paBand") + " / " + txt("paTemp"));
    const stale4 = worstContrast(["paTemp", "paBand"]);
    check("...and they stay readable while greyed",
      stale4 >= 4, "worst contrast " + stale4.toFixed(2) + ":1");

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
    await sleep(6600);

    // ---- 5. every flag TrxNet carries has a lamp, lit or not --------------
    await setPa(base({flags:F.ON|F.LINK|F.ALARM|F.TUNE}));
    const leds = Array.from(document.querySelectorAll("#paLeds .pa-led"));
    check("all five lamps are present, lit or dark", leds.length === 5,
      leds.map(l => l.textContent).join(","));
    const lit = leds.filter(l => l.classList.contains("on")).map(l => l.textContent);
    check("ALARM and TUNE are lit, the rest dark",
      lit.length === 2 && lit.includes("ALARM") && lit.includes("TUNE"), lit.join(","));
    // Two fixed rows: what is happening over the modes it is in.
    const ledRows = Array.from(document.querySelectorAll("#paLeds .pa-led-row"))
      .map(r => Array.from(r.children).map(l => l.textContent).join(" "));
    check("the lamps sit in two rows, ALARM TX TUNE over CONTEST BEEP",
      ledRows.length === 2 && ledRows[0] === "ALARM TX TUNE" && ledRows[1] === "CONTEST BEEP",
      ledRows.join(" | "));
    const r0 = document.querySelectorAll("#paLeds .pa-led-row")[0].getBoundingClientRect();
    const r1 = document.querySelectorAll("#paLeds .pa-led-row")[1].getBoundingClientRect();
    check("really two rows on screen, not one wrapped",
      r1.top >= r0.bottom - 0.5, r0.bottom + " / " + r1.top);
    // The temperature beside both rows, larger than anything else down there.
    await setPa(base({flags:F.ON|F.LINK, temp:4500}));
    const tR = rect("paTemp"), lR = rect("paLeds");
    check("the temperature stands to the right of the lamps",
      tR.left > lR.right, tR.left + " vs " + lR.right);
    check("centred across both lamp rows",
      Math.abs((tR.top + tR.bottom) / 2 - (lR.top + lR.bottom) / 2) < 2,
      (tR.top + tR.bottom) / 2 + " vs " + (lR.top + lR.bottom) / 2);
    check("and enlarged to 20 px", getComputedStyle($("paTemp")).fontSize === "20px",
      getComputedStyle($("paTemp")).fontSize);
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
    // In the status line, in the panel's true centre whatever the status text
    // beside it says.
    await setPa(base({flags:F.ON|F.LINK|F.REV2, band:15}));
    const stR = $("paStatusText").closest(".pa-status").getBoundingClientRect();
    const bR = rect("paBand");
    check("the band sits between the status and REV, centred",
      Math.abs((bR.left + bR.right) / 2 - (stR.left + stR.right) / 2) < 1.5 &&
      bR.left > rect("paStatusText").right && bR.right < rect("paRevTag").left,
      (bR.left + bR.right) / 2 + " vs " + (stR.left + stR.right) / 2);
    await setPa(base({flags:F.LINK, band:15}));
    const bR2 = rect("paBand");
    check("and stays put when the status text changes length",
      Math.abs(bR2.left - bR.left) < 0.5, bR.left + " -> " + bR2.left);
    // The longest thing the status can say. It is wider than a third of the
    // panel, and the band must step aside rather than print over it -- seen on
    // the first screenshot as "NO DATA 20 s40 m".
    await setPa(base({flags:F.ON|F.LINK, band:40, ageMs:125000}));
    check("a long NO DATA never runs into the band",
      rect("paStatusText").right + 3 <= rect("paBand").left,
      txt("paStatusText") + ": " + rect("paStatusText").right + " / " + rect("paBand").left);
    check("and the band still fits inside the panel",
      rect("paBand").right <= $("paStatusText").closest(".pa-status").getBoundingClientRect().right + 0.5);
    await setPa(base({flags:F.ON|F.LINK, band:0}));
    check("an unknown band is blank, not a dash", txt("paBand") === "", txt("paBand"));

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
    // The give-up window is 6 s -- it has to outlast the daemon's own three
    // tries, see CONFIRM_MS -- and it is noticed on the next poll, 500 ms
    // apart, so the worst case is 6.5 s. The old 4.2 s was a coin flip even
    // against the old 4 s window; keep a full second of room.
    await sleep(7200);
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
    await sleep(6600);                       // let the unanswered command lapse
    check("a command nobody answered leaves the button usable",
      !$("paBtnOperate").disabled && !$("paBtnOperate").classList.contains("pa-pending"),
      $("paBtnOperate").className);
    $("paBtnOperate").click();               // and pressing again must reach the wire
    await sleep(200);
    cmds = await commandsSince();
    check("pressing again after silence sends again",
      cmds.length === 2, JSON.stringify(cmds));
    await sleep(6600);

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

    // ---- 12b. a window height change keeps the gap to the log's fields -----
    // The palette hangs from the BOTTOM of the viewport, not the top. The
    // Call/Exch fields sit just above the bottom button bar, so a palette
    // measured from the top edge walks into them as the window shrinks and
    // drifts away from them as it grows -- and an operator who has parked it
    // one line above the fields has to park it again after every resize.
    // Chrome cannot resize its own window from inside the page, so innerHeight
    // is stubbed and the page's own resize handler is run: the same code path a
    // real resize takes, with the same real DOM underneath.
    const realHeight = window.innerHeight;
    const setViewportHeight = h => {
      Object.defineProperty(window, "innerHeight", {configurable: true, get: () => h});
      window.dispatchEvent(new Event("resize"));
    };
    const bottomGap = () =>
      window.innerHeight - (parseInt(panel.style.top, 10) + panel.offsetHeight);

    head.dispatchEvent(new PointerEvent("pointerdown", {bubbles:true, cancelable:true, clientX:400, clientY:400, pointerId:2}));
    head.dispatchEvent(new PointerEvent("pointermove", {bubbles:true, clientX:400, clientY:500, pointerId:2}));
    head.dispatchEvent(new PointerEvent("pointerup",   {bubbles:true, clientX:400, clientY:500, pointerId:2}));
    await sleep(60);
    const gapBefore = bottomGap(), topBefore = parseInt(panel.style.top, 10);

    setViewportHeight(realHeight - 200);
    await sleep(80);
    check("a shorter window moves the palette up with the bottom edge",
      parseInt(panel.style.top, 10) === topBefore - 200,
      topBefore + " -> " + panel.style.top);
    check("so its distance to the log's entry fields is unchanged",
      bottomGap() === gapBefore, gapBefore + " -> " + bottomGap());

    setViewportHeight(realHeight + 300);
    await sleep(80);
    check("and a taller window keeps that same distance",
      bottomGap() === gapBefore, gapBefore + " -> " + bottomGap());

    stored = JSON.parse(localStorage.getItem("wifilt-pa-panel") || "{}");
    check("the gap to the bottom edge is what gets remembered",
      stored.gap === gapBefore, JSON.stringify(stored));

    // Closed, the palette hears no resize at all -- so the gap, not the top, is
    // what has to be stored, or every resize made with it shut moves it.
    $("paClose").click();
    setViewportHeight(realHeight);
    await sleep(60);
    $("btnPa").click();
    await sleep(150);
    check("a window resized while it was closed still reopens it in place",
      bottomGap() === gapBefore, gapBefore + " -> " + bottomGap());

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

    // ---- 15. the tuning-segment scale -------------------------------------
    // The tuner holds one setting per sub-band, so what this row has to get right
    // is which sub-band the radio is in and where its centre is -- everything
    // else about it is decoration. The assertions therefore land on the filled
    // segment, on the dot's position, and on the frequency that actually went out
    // on /cmd.
    await setPa(base({flags:F.ON|F.LINK}));
    await setFreq(14025000);          // 20 m, exactly the centre of index 1 of 9

    const segs   = () => Array.from($("paSegTrack").children);
    const onIdx  = () => segs().findIndex(s => s.classList.contains("pa-seg-on"));
    const dotPct = () => parseFloat($("paSegDot").style.left);

    check("a nine-segment band is drawn one page of six at a time",
      segs().length === 6, String(segs().length));
    check("the segment the radio is standing in is the filled one",
      onIdx() === 1, "filled index " + onIdx());
    // The page spans 13950..14250 kHz -- its top edge is half way between the
    // sixth and seventh centres, not half a step past the sixth -- so 14025
    // belongs at (14025-13950)/300 = 25 %.
    check("the dot sits at the frequency, not at the segment's edge",
      Math.abs(dotPct() - 25) < 0.1, $("paSegDot").style.left);
    check("and it is visible", !$("paSegDot").hidden);

    // Strictly below / above -- which is what lets an arrow finish the job.
    await setFreq(14027000);
    await clearCat();
    $("paSegDown").click();
    await sleep(80);
    let cat = await catSince();
    check("standing 2 kHz above a centre, the left arrow lands ON that centre",
      cat.length === 1 && cat[0].frequency === 14025000, JSON.stringify(cat));
    check("and it says so before being pressed",
      /14025 kHz/.test($("paSegDown").title), $("paSegDown").title);

    await clearCat();
    $("paSegUp").click();
    await sleep(80);
    cat = await catSince();
    check("the right arrow goes to the next centre up",
      cat.length === 1 && cat[0].frequency === 14075000, JSON.stringify(cat));

    // Paging, and the reason the last page is stuck to the end of the band.
    await setFreq(14275000);           // index 6 of 9
    check("leaving the page moves the window a whole page",
      segs().length === 6, String(segs().length));
    check("the last page is pinned to the band's end, so it never runs short",
      onIdx() === 3, "filled index " + onIdx());

    await setFreq(4030000);            // the very last centre on 80 m, 29 of them
    check("80 m's last page holds six segments, not the one left over",
      segs().length === 6, String(segs().length));
    check("with the radio in the last of them", onIdx() === 5, "filled index " + onIdx());
    check("at the top of the band the right arrow has nowhere to go",
      $("paSegUp").disabled);
    check("and says that, rather than just going quiet",
      /No further tuning segment/.test($("paSegUp").title), $("paSegUp").title);

    await setFreq(1785000);            // the first centre on 160 m
    check("at the bottom of the band the left arrow is the dead one",
      $("paSegDown").disabled && !$("paSegUp").disabled);

    // A click straight onto a segment -- crossing 80 m on the arrows is 28 presses.
    await setFreq(3750000);
    await clearCat();
    const wantCentre = Number(segs()[0].dataset.centre) * 1000;
    segs()[0].click();
    await sleep(80);
    cat = await catSince();
    check("clicking a segment tunes to that segment's own centre",
      cat.length === 1 && cat[0].frequency === wantCentre,
      JSON.stringify(cat) + " want " + wantCentre);
    check("and every segment offers its centre on hover, so the scale stays blind"
      + " without being unreadable",
      segs()[0].title === segs()[0].dataset.centre + " kHz", segs()[0].title);

    // Bands the amplifier has no segments for at all. Answering with the nearest
    // centre regardless would draw 2 m as the top of 6 m and 60 m as the top of
    // 80 m -- a scale confidently pointing at a band that is not there.
    await setFreq(144300000);
    check("on a band the amplifier cannot tune, the scale empties",
      segs().length === 0 && $("paSegDot").hidden, String(segs().length));
    check("and both arrows go dead", $("paSegDown").disabled && $("paSegUp").disabled);
    check("and say which of the two reasons it is",
      /no tuning segments on this band/.test($("paSegUp").title), $("paSegUp").title);
    // An empty scale still has to LOOK like an empty scale. Its trough is
    // 1.06:1 against the panel -- deliberately, it is a recess -- so without
    // the inset line there is nothing on screen at all where the row is, and
    // "the tuning preview disappeared" is how that gets reported.
    check("an empty scale is still visibly a scale",
      getComputedStyle($("paSegScale")).boxShadow !== "none",
      getComputedStyle($("paSegScale")).boxShadow);

    check("and the scale says NO SEGMENTS -- the frequency is known, the band is the problem",
      shown($("paSegMsg")) && txt("paSegMsg") === "NO SEGMENTS", txt("paSegMsg"));
    const rowHNoSeg = $("paSegRow").offsetHeight;

    await setFreq(5300000);
    check("60 m is not drawn as the top of 80 m", segs().length === 0, String(segs().length));
    await setFreq(14075000);
    check("the words do not change the row's height",
      $("paSegRow").offsetHeight === rowHNoSeg, rowHNoSeg + " vs " + $("paSegRow").offsetHeight);

    // Transmitting. Retuning the radio out from under a keyed amplifier is the
    // expensive mistake this whole panel exists to prevent.
    await setFreq(14075000);
    await fetch("/set-tx?v=1");
    await sleep(1300);
    check("both arrows go dead while the radio is transmitting",
      $("paSegDown").disabled && $("paSegUp").disabled);
    check("and say that is why", /transmitting/.test($("paSegDown").title),
      $("paSegDown").title);
    await clearCat();
    segs()[0].click();
    await sleep(80);
    check("and a click on the scale itself sends nothing either",
      (await catSince()).length === 0, JSON.stringify(await catSince()));
    await fetch("/set-tx?v=0");
    await sleep(1300);

    // With nothing coming from the radio there is no frequency to place.
    await setFreq(0);
    check("with no frequency from the radio the scale is empty and dead",
      segs().length === 0 && $("paSegDown").disabled && $("paSegUp").disabled,
      String(segs().length));
    check("and says the radio is not connected",
      /not connected/.test($("paSegDown").title), $("paSegDown").title);
    check("and says NO FREQ over the scale, so it cannot pass for a broken one",
      shown($("paSegMsg")) && txt("paSegMsg") === "NO FREQ", txt("paSegMsg"));
    const mR = rect("paSegMsg"), scR = rect("paSegScale");
    check("laid over the middle of the scale",
      Math.abs((mR.left + mR.right) / 2 - (scR.left + scR.right) / 2) < 1.5 &&
      Math.abs((mR.top + mR.bottom) / 2 - (scR.top + scR.bottom) / 2) < 1.5,
      [mR.left, mR.right, scR.left, scR.right].map(Math.round).join(","));
    await setFreq(14075000);
    check("and the words go once there is a frequency again",
      !shown($("paSegMsg")) && !$("paSegDot").hidden);

    // ---- 16. the scale must not steal the caret either ---------------------
    // The scale is a DIV, not a button, so it slips straight past a mousedown
    // guard that only looks for buttons -- and then a click on it takes the caret
    // out of Call and breaks the log's whole Enter flow. Asserted on
    // defaultPrevented rather than on activeElement, because a synthetic
    // mousedown never moves focus anyway: this checks the guard itself fired.
    for (const id of ["paSegDown", "paSegUp", "paSegScale", "paSegRow"]) {
      const ev = new MouseEvent("mousedown", {bubbles:true, cancelable:true});
      $(id).dispatchEvent(ev);
      check("mousedown on " + id + " is cancelled, so the caret cannot leave Call",
        ev.defaultPrevented);
    }
    for (const id of ["paSegDown", "paSegUp"]) {
      call.focus();
      $(id).dispatchEvent(new MouseEvent("mousedown", {bubbles:true, cancelable:true}));
      $(id).click();
      await sleep(30);
      check("focus stays in Call across a click on " + id,
        document.activeElement === call,
        document.activeElement ? document.activeElement.id || document.activeElement.tagName : "none");
    }

    // ---- 17. TUNE+ and the radio's own tuner --------------------------------
    // The firmware runs the whole tune; the palette offers it, shows where it
    // is and turns into its STOP key. Judged on the rendered button, the note
    // line and the POSTed bodies -- the same three things as everything above.
    const tuneCmds = async () => (await commandsSince()).filter(c => c.what === "tune" || c.what === "tuneplus");
    const idle = {st:"idle", why:"", swr:0, ageMs:60000};

    await setPa(base({flags:F.ON|F.LINK, trx1:"IC-7610", tunePlus:false, tunePlusWhy:"no_oi3", tp:idle}));
    check("the title names the radio the amplifier follows", txt("paName") === "PA.01/IC-7610", txt("paName"));
    check("the radio half, slash included, is grey and the name is not",
      txt("paNameTrx") === "/IC-7610" &&
      getComputedStyle($("paNameTrx")).color === getComputedStyle($("paClose")).color &&
      getComputedStyle($("paNameAmp")).color !== getComputedStyle($("paNameTrx")).color,
      getComputedStyle($("paNameAmp")).color + " / " + getComputedStyle($("paNameTrx")).color);
    check("without an OI3 the key stays plain TUNE", txt("paBtnTune") === "TUNE", txt("paBtnTune"));
    check("and an ordinary station is not told about TUNE+", !/TUNE[+]/.test($("paBtnTune").title), $("paBtnTune").title);

    await setPa(base({flags:F.ON|F.LINK, trx1:"IC-7610", tunePlus:false, tunePlusWhy:"oi3_old", tp:idle}));
    check("an OI3 without remote TUNE is named as the reason", /older/.test($("paBtnTune").title), $("paBtnTune").title);

    await setPa(base({flags:F.ON|F.LINK, trx1:"IC-7610", tunePlus:true, tunePlusWhy:"", tp:idle}));
    check("with the OI3 there the key reads TUNE+", txt("paBtnTune") === "TUNE+", txt("paBtnTune"));
    check("and is enabled", !$("paBtnTune").disabled, $("paBtnTune").title);
    await clearCommands();
    $("paBtnTune").click();
    await sleep(150);
    let tc = await tuneCmds();
    check("a click starts TUNE+, not the bare amplifier key",
      tc.length === 1 && tc[0].what === "tuneplus" && tc[0].value === 1, JSON.stringify(tc));
    check("and the key shows the request is out", txt("paBtnTune") === "…", txt("paBtnTune"));

    await setPa(base({flags:F.ON|F.LINK|F.TX, trx1:"IC-7610", tunePlus:true, tp:{st:"carrier", why:"", swr:0, ageMs:200}}));
    check("carrier up reads CARRIER", txt("paBtnTune") === "CARRIER", txt("paBtnTune"));
    check("drawn as a run in progress", $("paBtnTune").classList.contains("st-tp"), $("paBtnTune").className);
    await fetch("/set-tx?v=1");
    await setPa(base({present:false, flags:F.ON|F.LINK|F.TX|F.TUNE, trx1:"IC-7610", tunePlus:true,
                      tp:{st:"tuning", why:"", swr:0, ageMs:900}}));
    await sleep(1300);
    check("tuning reads TUNING", txt("paBtnTune") === "TUNING", txt("paBtnTune"));
    check("and stays clickable while the radio transmits and the amplifier is lost -- it is the STOP key",
      !$("paBtnTune").disabled, $("paBtnTune").title);
    await clearCommands();
    $("paBtnTune").click();
    await sleep(150);
    tc = await tuneCmds();
    check("a click while running stops it",
      tc.length === 1 && tc[0].what === "tuneplus" && tc[0].value === 0, JSON.stringify(tc));
    await fetch("/set-tx?v=0");
    await sleep(1300);

    await setPa(base({flags:F.ON|F.LINK, trx1:"IC-7610", tunePlus:true, tp:{st:"done", why:"", swr:130, ageMs:300}}));
    check("a finished tune reports the SWR", /Tuned.*SWR 1[.]3/.test(txt("paNote")), txt("paNote"));
    check("and the key is TUNE+ again", txt("paBtnTune") === "TUNE+", txt("paBtnTune"));

    await setPa(base({flags:F.ON|F.LINK, trx1:"IC-7610", tunePlus:true,
                      tp:{st:"fail", why:"The amplifier did not start tuning.", swr:0, ageMs:300}}));
    check("a failed tune says why", /did not start tuning/.test(txt("paNote")), txt("paNote"));

    await setPa(base({flags:F.LINK, trx1:"IC-7610", tunePlus:true, tp:idle}));
    check("TUNE+ is greyed out with the amplifier OFF", $("paBtnTune").disabled, $("paBtnTune").title);
    check("and says to switch it on", /ON first/.test($("paBtnTune").title), $("paBtnTune").title);

    await setPa(base({flags:F.ON|F.LINK, trx1:"IC-7610", tunePlus:true, tp:idle}));
    await fetch("/set-cmd-error?code=trx_tx");
    $("paBtnTune").click();
    await sleep(200);
    check("a refused start says why", /transmitting/.test(txt("paNote")), txt("paNote"));
    check("and the key does not hang on the request", txt("paBtnTune") === "TUNE+", txt("paBtnTune"));
    await fetch("/set-cmd-error?code=");

    // A tune that ended long ago must not be reported as news.
    $("paBtnTune").click();
    await sleep(150);
    await setPa(base({flags:F.ON|F.LINK, trx1:"IC-7610", tunePlus:true, tp:{st:"done", why:"", swr:110, ageMs:60000}}));
    check("a stale result is not replayed", txt("paNote") === "", txt("paNote"));

    // The radio's own tuner, switched off on OFF -> ON by the firmware.
    await setPa(base({flags:F.ON|F.LINK, trx1:"IC-7610", tunePlus:true, tp:idle, atuOff:null}));
    await setPa(base({flags:F.ON|F.LINK, trx1:"IC-7610", tunePlus:true, tp:idle,
                      atuOff:{ok:false, why:"trxnet", ageMs:100}}));
    check("a tuner that could not be switched off is reported",
      /NOT switched off/.test(txt("paNote")) && /TrxNet/.test(txt("paNote")), txt("paNote"));

    const ev = new MouseEvent("mousedown", {bubbles:true, cancelable:true});
    $("paBtnTune").dispatchEvent(ev);
    check("mousedown on TUNE+ is cancelled, so the caret cannot leave Call", ev.defaultPrevented);
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
