#!/usr/bin/env node
"use strict";

// Alt+K, the contest log's free-text message bar, driven in a real browser.
//
// What is pinned down here (grilled 2026-09-25):
//   - the bar opens only where the message would actually go out: CW and true
//     RTTY always, USB-D/LSB-D only while RTTY holds the AUD1 session, never in
//     phone or with the TRX disconnected -- and asks again on Enter;
//   - RTTY/DATA send "\r\n" + text + " ", CW the text alone, both trimmed and
//     upper-cased;
//   - the firmware's limits (CW 30, RTTY 33, DATA 200): a mode that changes to
//     a stricter one under the text turns the bar red and Enter refuses, the
//     text is not cut;
//   - Esc discards and closes, and while transmitting ALSO aborts -- one key;
//   - the focus goes back to the field it came from;
//   - the shortcut list names it.
//
// The radio is this fixture: /state answers whatever mode the page script set
// through /fixture, and /cmd records what the page asked the firmware to key.

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;
const commands = [];
const radio = {mode: "CW", connected: true, tx: false, role: ""};

function stateJson() {
  return {
    connected: radio.connected, catHealthy: true, audioReady: false, lanStatus: "linked",
    btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
    fullCat: true, wifiRssi: -55, fwRev: "20260812", bdSupported: false,
    power: true, frequency: 14025000, mode: radio.mode, filter: 1,
    radioAddress: "a4", transceiverType: "IC-705", radioName: "IC-705",
    tx: radio.tx, ritRaw: 0, smeterRaw: 0, powerMeterRaw: 0, afGain: 100,
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
  const line = `LOG FREE TX ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length}`;
  (failed.length ? console.error : console.log)(line);
  if (failed.length) process.exitCode = 1;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  const json = body => {
    response.writeHead(200, {"Content-Type": "application/json", "Cache-Control": "no-store"});
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
    request.on("end", () => { commands.push(JSON.parse(body)); json({ok: true}); });
    return;
  }

  // The page script's two handles on this fixture.
  if (url.pathname === "/fixture") {
    for (const k of ["mode", "role"]) if (url.searchParams.has(k)) radio[k] = url.searchParams.get(k);
    if (url.searchParams.has("connected")) radio.connected = url.searchParams.get("connected") === "1";
    return json(radio);
  }
  if (url.pathname === "/commands") {
    const out = commands.splice(0);
    return json(out);
  }

  if (url.pathname === "/state") return json(stateJson());
  if (url.pathname === "/js8/session") return json({held: !!radio.role, role: radio.role});
  if (url.pathname === "/dxcinfo") return json({locator: "JO70", call: "OK1HRA"});
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70"});
  if (url.pathname === "/log-config") {
    return json({
      trx1Label: "TRX1", trx2Label: "TRX2", trx3Label: "TRX3",
      trx2enabled: true, trx3enabled: false, blockedDxcc: "",
    });
  }

  const file = url.pathname === "/" ? path.join(data, "log.html")
                                    : path.join(data, path.basename(url.pathname));
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

  function key(k, code, extra) {
    const init = Object.assign({key: k, code: code, bubbles: true, cancelable: true}, extra || {});
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", init));
  }
  const altK  = () => key("k", "KeyK", {altKey: true});
  const enter = () => key("Enter", "Enter");
  const esc   = () => key("Escape", "Escape");
  const type  = text => {
    const inp = $("inpFreeTx");
    inp.value += text;
    inp.dispatchEvent(new Event("input", {bubbles: true}));
  };
  const barOpen = () => !$("freeTxBar").hidden;
  const hint = () => $("logHint").textContent;
  // /state is polled every 500 ms, the AUD1 role every 3 s.
  async function setRadio(q, waitMs) {
    await fetch("/fixture?" + q);
    await sleep(waitMs || 800);
  }
  const takeCommands = async () => (await fetch("/commands")).json();
  const sends = cmds => cmds.filter(c => c.type === "sendCw").map(c => c.text);
  const aborts = cmds => cmds.filter(c => c.type === "abortCw").length;

  try {
    for (let i = 0; i < 60 && !window.LogMacros; i++) await sleep(100);
    await sleep(900);

    const log = await LogDB.createLog({
      contestName: "FREETX", stationCall: "OK1HRA",
      defaultExchange: "NR", myLocator: "JO70", startQsoNumber: 1,
    });
    LogManager.activateLog(log);
    await sleep(200);
    const call = $("inpCall"), exch = $("inpExch");

    // ---- CW: opens, sends the text alone, gives the focus back --------------
    call.focus();
    altK();
    await sleep(80);
    check("Alt+K opens the bar in CW", barOpen());
    check("the caret is in it", document.activeElement === $("inpFreeTx"));
    check("it names the route CW", /^CW/.test($("freeTxRoute").textContent), $("freeTxRoute").textContent);
    check("and counts against CW's 30", $("freeTxCount").textContent === "0/30", $("freeTxCount").textContent);
    check("the field itself stops at 30", $("inpFreeTx").maxLength === 30, String($("inpFreeTx").maxLength));

    type("  tu 73 gl ");
    await sleep(50);
    check("typing is upper-cased as it goes", $("inpFreeTx").value === "  TU 73 GL ", JSON.stringify($("inpFreeTx").value));
    enter();
    await sleep(300);
    let cmds = await takeCommands();
    check("Enter keys the trimmed text alone in CW", JSON.stringify(sends(cmds)) === JSON.stringify(["TU 73 GL"]),
      JSON.stringify(cmds));
    check("and closes the bar", !barOpen());
    check("empty for next time", $("inpFreeTx").value === "");
    check("the caret is back in Call", document.activeElement === call);

    // From Exch, the caret goes back to Exch.
    await sleep(1600);   // past the optimistic TX window noteTxStarted() opened
    exch.focus();
    altK();
    await sleep(60);
    esc();
    await sleep(200);
    cmds = await takeCommands();
    check("Esc closes the bar", !barOpen());
    check("and aborts nothing when nothing is going out", aborts(cmds) === 0, JSON.stringify(cmds));
    check("the caret goes back to Exch, where it came from", document.activeElement === exch);

    // Empty Enter: nothing keyed, bar closed.
    altK();
    await sleep(60);
    type("   ");
    enter();
    await sleep(200);
    cmds = await takeCommands();
    check("an empty Enter keys nothing", cmds.length === 0, JSON.stringify(cmds));
    check("and just closes", !barOpen());

    // Alt+K while open only takes the focus back; a click elsewhere keeps it open.
    call.focus();
    altK();
    await sleep(60);
    type("QRL");
    call.focus();
    await sleep(60);
    check("focus leaving the bar does not close it", barOpen() && $("inpFreeTx").value === "QRL");
    altK();
    await sleep(60);
    check("Alt+K again brings the caret back, text intact",
      document.activeElement === $("inpFreeTx") && $("inpFreeTx").value === "QRL");

    // Esc while transmitting: one key, both things.
    enter();                       // keys QRL -> optimistic TX window open
    await sleep(100);
    await takeCommands();
    altK();
    await sleep(60);
    type("SRI");
    esc();
    await sleep(250);
    cmds = await takeCommands();
    check("Esc during a transmission aborts it", aborts(cmds) === 1, JSON.stringify(cmds));
    check("and closes the bar in the same keystroke", !barOpen() && $("inpFreeTx").value === "");
    await sleep(1600);

    // ---- true RTTY: framed, limit 33 ---------------------------------------
    await setRadio("mode=RTTY");
    call.focus();
    altK();
    await sleep(60);
    check("Alt+K opens in RTTY", barOpen() && /^RTTY/.test($("freeTxRoute").textContent),
      $("freeTxRoute").textContent);
    check("with RTTY's 33", $("freeTxCount").textContent === "0/33", $("freeTxCount").textContent);
    type("pse k");
    enter();
    await sleep(300);
    cmds = await takeCommands();
    check("RTTY sends CR LF, the text, and a space",
      JSON.stringify(sends(cmds)) === JSON.stringify(["\\r\\nPSE K "]), JSON.stringify(cmds));
    await sleep(1600);

    // ---- DATA: only while RTTY holds AUD1 ----------------------------------
    await setRadio("mode=USB-D&role=");
    altK();
    await sleep(80);
    check("USB-D without RTTY holding the audio does not open", !barOpen());
    check("and says why", /RTTY palette/.test(hint()), hint());

    await setRadio("role=rtty", 3500);
    const sent = [];
    const panel = window.RttyPanel;
    const origHolds = panel.holdsSession, origSend = panel.send;
    panel.holdsSession = () => true;
    panel.send = text => { sent.push(text); return Promise.resolve(); };
    call.focus();
    altK();
    await sleep(60);
    check("USB-D with RTTY holding the audio opens, as DATA", barOpen() && /^DATA/.test($("freeTxRoute").textContent),
      $("freeTxRoute").textContent);
    check("with DATA's 200", $("freeTxCount").textContent === "0/200", $("freeTxCount").textContent);
    type("cq de ok1hra");
    enter();
    await sleep(300);
    check("DATA goes through the palette, framed like RTTY",
      JSON.stringify(sent) === JSON.stringify(["\\r\\nCQ DE OK1HRA "]), JSON.stringify(sent));
    await sleep(1600);

    // A mode that turns stricter under the text: red, refused, text kept.
    altK();
    await sleep(60);
    const long = "ABCDEFGHIJ ABCDEFGHIJ ABCDEFGHIJ ABCDEFGHIJ";   // 43
    type(long);
    await sleep(50);
    check("43 characters are fine in DATA", !$("freeTxBar").classList.contains("free-tx-bad"));
    await setRadio("mode=RTTY");
    check("the bar turns red once RTTY's 33 applies",
      $("freeTxBar").classList.contains("free-tx-bad") && $("freeTxCount").textContent === "43/33",
      $("freeTxCount").textContent);
    check("the text is not cut", $("inpFreeTx").value === long, $("inpFreeTx").value.length + "");
    $("inpFreeTx").focus();
    enter();
    await sleep(300);
    cmds = await takeCommands();
    check("Enter refuses it", sends(cmds).length === 0 && sent.length === 1, JSON.stringify(cmds));
    check("the bar stays open with the text", barOpen() && $("inpFreeTx").value === long);
    check("and says why", /Too long for RTTY: 43\\/33/.test(hint()), hint());

    // Stricter again by leaving for phone: the route itself is refused on Enter.
    await setRadio("mode=USB");
    check("in phone the bar goes red too", $("freeTxBar").classList.contains("free-tx-bad"));
    $("inpFreeTx").focus();
    enter();
    await sleep(200);
    cmds = await takeCommands();
    check("Enter in phone keys nothing", cmds.length === 0 && sent.length === 1, JSON.stringify(cmds));
    check("and names phone", /Phone mode/.test(hint()), hint());
    esc();
    await sleep(100);
    panel.holdsSession = origHolds; panel.send = origSend;

    // ---- where it does not open --------------------------------------------
    altK();
    await sleep(80);
    check("Alt+K in phone does not open", !barOpen());
    // Mode first: a disconnected /state is not read for its mode at all.
    await setRadio("mode=CW");
    await setRadio("connected=0");
    altK();
    await sleep(80);
    check("nor with the TRX disconnected", !barOpen());
    check("and says so", /TRX not connected/.test(hint()), hint());
    await setRadio("connected=1");

    // ---- not over a dialog, and the shortcut list names it ------------------
    $("btnHelp").click();
    await sleep(150);
    const helpText = $("helpModal").textContent.replace(/\\s+/g, " ");
    check("the help list names Alt+K", /Alt\\+K/.test(helpText), helpText.slice(0, 300));
    altK();
    await sleep(80);
    check("Alt+K does not open under an open dialog", !barOpen());
    $("helpModalClose").click();
    await sleep(100);

    // Placement: over the status bar, directly above the input row.
    call.focus();
    altK();
    await sleep(80);
    const barBox = $("freeTxBar").getBoundingClientRect();
    const rowBox = document.querySelector(".log-input-row").getBoundingClientRect();
    check("the bar sits right on top of the input row",
      Math.abs(barBox.bottom - rowBox.top) < 1.5 && barBox.width >= rowBox.width - 1,
      JSON.stringify({bar: [barBox.top, barBox.bottom, barBox.width], row: [rowBox.top, rowBox.width]}));
    esc();
    await sleep(80);
  } catch (error) {
    check("the test script ran to the end", false, String(error && error.stack || error));
  }

  await fetch("/result", {method: "POST", body: JSON.stringify({checks})});
})();
`;

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
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
