#!/usr/bin/env node
"use strict";

// RTTY-ICOM in a real browser, guarding the 2026-09-07 extraction of
// rtty-scope.js / rtty-rxlog.js / rtty-afsk-tx.js out of rtty.js.
//
// Why this harness exists: that refactor moved ~500 lines of a page whose only
// prior verification was on real hardware, and every one of its failure modes
// is silent. A scope that never resizes still renders a plausible-looking
// black box; an overlay that stops spanning the seam still draws lines; a
// token that loses its .rtty-tok class still shows the decoded text, and only
// the click-into-QRPlog hand-off -- the whole point of the RX log -- quietly
// stops working.
//
// So the assertions sit on rendered DOM, on canvas geometry the page actually
// computed, and on what went out over the BroadcastChannel -- never on
// internals. Two levels are covered on purpose:
//
//   * the PAGE's own instances, reached through real paths only (the
//     rtty-tx-fsk-echo hand-off drives the page's own RX log end to end);
//   * the extracted MODULES directly, mounted on a scratch element, for the
//     token/colour/click behaviour the page gives no handle on.

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;
const commands = [];              // every /cmd?radio=lan body, in order

function finish(result) {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  if (chrome) {
    // Orphaned headless Chrome has keyed a real radio unnoticed before -- kill
    // the whole thing, hard, and never leave it to the OS.
    chrome.kill("SIGTERM");
    setTimeout(() => chrome && chrome.kill("SIGKILL"), 2000).unref();
  }
  const checks = (result && result.checks) || [];
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? `  -- ${detail}` : ""}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  setTimeout(() => process.exit(failed ? 1 : 0), 150).unref();
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  const json = body => {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify(body));
  };
  const readBody = done => {
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => done(body));
  };

  if (url.pathname === "/result" && request.method === "POST")
    return readBody(body => { response.writeHead(204).end(); finish(JSON.parse(body)); });

  // LanGate reads the SAVED configuration, not the live radio: LAN on TRX1,
  // fully filled in, so gate() resolves ready and the page boots.
  if (url.pathname === "/setup-data.json") return json({
    trx1transport: "lan", trx1lanip: "192.168.1.50", trx1lanuser: "user",
    trx1lanpass: "pass", trx1model: "IC-705",
  });

  if (url.pathname === "/state") return json({
    connected: true, power: true, frequency: 14085000, mode: "USB-D", filter: 1,
    tx: false, rfPower: 128, rfPowerSeen: true, radioName: "IC-705",
    transceiverType: "IC-705", lanStatus: "linked", catHealthy: true,
    audioReady: true, smeterRaw: 0, powerMeterRaw: 0, swr: 1.0,
  });

  if (url.pathname.startsWith("/js8/session")) {
    if (request.method === "POST") return readBody(() => json({ok: true}));
    return json({held: true, role: "rtty"});
  }

  if (url.pathname === "/cmd" && request.method === "POST")
    return readBody(body => {
      try { commands.push(JSON.parse(body)); } catch (_) { commands.push({raw: body}); }
      json({ok: true});
    });
  if (url.pathname === "/commands") return json(commands);
  if (url.pathname === "/commands/clear") { commands.length = 0; return json({ok: true}); }

  if (url.pathname === "/log-config") return json({trx1Label: "TRX1"});
  if (url.pathname === "/log-config/fsk") return json({});
  if (url.pathname === "/txgain.json") return json({v: 1, entries: {}});
  if (url.pathname === "/txgain-plan.json") return json({});
  if (url.pathname === "/trxnet-peers.json") return json([]);
  if (url.pathname === "/civread") return json({});
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70"});

  // The firmware serves the MINIFIED companion (via .gz), never the readable
  // source, so a build that only ever tests the source is testing a file no
  // operator runs. RTTY_SMOKE_MINIFIED=1 serves *.js.min under the plain name.
  let file = url.pathname === "/" ? path.join(data, "rtty.html")
                                  : path.join(data, path.basename(url.pathname));
  if (process.env.RTTY_SMOKE_MINIFIED === "1" && file.endsWith(".js")
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

  // Collected from the very top of the page, before anything else runs.
  const bootErrors = window.__rttySmokeErrors;

  try {
    // The page waits on LanGate.gate() and a session claim before it draws.
    await sleep(1200);

    // ---- 1. the page came up at all --------------------------------------
    check("no uncaught error during boot", bootErrors.length === 0,
      bootErrors.slice(0, 3).join(" | "));
    check("the LAN gate let the page through",
      !document.body.classList.contains("lan-gate-blocked")
      && !document.body.classList.contains("lan-gate-checking"),
      document.body.className);
    check("the session was granted, no busy card", $("sessionBusy").hidden);

    // ---- 2. the scope actually sized itself ------------------------------
    // A canvas left at its HTML-declared width renders a plausible-looking
    // black box, so this is checked against the CONTAINER, not against 0.
    const wfCanvas = $("waterfallCanvas"), overlay = $("rttyScopeOverlay"),
          scopeEl = $("rttyScope"), liveWrap = $("rttyLiveSpectrum");
    check("the waterfall canvas took a real width", wfCanvas.width >= 320,
      String(wfCanvas.width));
    check("the overlay spans the WHOLE scope box, not one canvas",
      overlay.height === Math.round(scopeEl.clientHeight)
      && overlay.height > liveWrap.clientHeight,
      \`overlay \${overlay.height} vs live \${liveWrap.clientHeight} vs scope \${scopeEl.clientHeight}\`);
    check("the overlay is as wide as the scope", overlay.width >= 320, String(overlay.width));

    // ---- 3. the overlay is being painted every frame ---------------------
    // Non-blank pixels are the only honest evidence the rAF loop is running
    // and the module is drawing into the page's own canvas.
    const octx = overlay.getContext("2d");
    const painted = octx.getImageData(0, 0, overlay.width, overlay.height).data;
    let inked = 0;
    for (let i = 3; i < painted.length; i += 4) if (painted[i] !== 0) inked++;
    check("the overlay has ink on it (mark/space lines + ruler)", inked > 50, String(inked));

    // ---- 4. zoom still narrows the window --------------------------------
    const summaryAt100 = $("spectrumSummary").textContent;
    document.querySelector('.rtty-zoom-pill[data-zoom="400"]').click();
    await sleep(60);
    const summaryAt400 = $("spectrumSummary").textContent;
    check("400% changed the shown window", summaryAt400 !== summaryAt100,
      \`\${summaryAt100} -> \${summaryAt400}\`);
    const span = s => { const m = /RX (-?\\d+)[^\\d-]+(-?\\d+)/.exec(s); return m ? +m[2] - +m[1] : NaN; };
    check("400% is a NARROWER window than 100%", span(summaryAt400) < span(summaryAt100),
      \`\${span(summaryAt100)} -> \${span(summaryAt400)}\`);
    document.querySelector('.rtty-zoom-pill[data-zoom="100"]').click();
    await sleep(60);
    check("back to 100% restores the base window",
      span($("spectrumSummary").textContent) === span(summaryAt100));

    // ---- 5. click-to-tune, USB-D branch ----------------------------------
    // The radio is in USB-D, so a click moves the AUDIO TONE and must NOT
    // send setFrequency. Both halves matter: the real-FSK branch keying a
    // retune in a data mode would move the operator's dial under them.
    await fetch("/commands/clear");
    const toneBefore = $("rttyToneInput").value;
    const rect = scopeEl.getBoundingClientRect();
    scopeEl.dispatchEvent(new MouseEvent("click", {clientX: rect.left + rect.width * 0.75,
      clientY: rect.top + 10, bubbles: true}));
    await sleep(80);
    check("a click on the scope moved the audio tone",
      $("rttyToneInput").value !== toneBefore,
      \`\${toneBefore} -> \${$("rttyToneInput").value}\`);
    const sent = await (await fetch("/commands")).json();
    check("and did NOT retune the radio in a data mode",
      !sent.some(c => c.type === "setFrequency"), JSON.stringify(sent));

    // ---- 6. hover preview does not throw ---------------------------------
    const errorsBeforeHover = bootErrors.length;
    scopeEl.dispatchEvent(new MouseEvent("mousemove", {clientX: rect.left + 40,
      clientY: rect.top + 10, bubbles: true}));
    scopeEl.dispatchEvent(new MouseEvent("mouseleave", {bubbles: true}));
    await sleep(60);
    check("hovering the scope raised nothing", bootErrors.length === errorsBeforeHover,
      bootErrors.slice(errorsBeforeHover).join(" | "));

    // ---- 6b. AFC still runs every frame ----------------------------------
    // The tracker moved into rtty-afc.js; on the page the only observable
    // proof it is still wired is that turning AFC on adds its dashed pair and
    // offset label to the overlay -- i.e. more ink than with it off. Counting
    // ink is crude, but it is the one thing a canvas honestly reports.
    const inkNow = () => {
      const d = octx.getImageData(0, 0, overlay.width, overlay.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) n++;
      return n;
    };
    const inkAfcOff = inkNow();
    $("rttyAfcEnabled").checked = true;
    $("rttyAfcEnabled").dispatchEvent(new Event("change", {bubbles: true}));
    await sleep(200);
    const inkAfcOn = inkNow();
    check("enabling AFC draws its own pair and offset label", inkAfcOn > inkAfcOff,
      \`\${inkAfcOff} -> \${inkAfcOn}\`);
    const errorsBeforeAfcOff = bootErrors.length;
    $("rttyAfcEnabled").checked = false;
    $("rttyAfcEnabled").dispatchEvent(new Event("change", {bubbles: true}));
    await sleep(200);
    check("turning AFC back off resets cleanly and removes it again",
      inkNow() <= inkAfcOff + 4 && bootErrors.length === errorsBeforeAfcOff,
      \`\${inkNow()} vs \${inkAfcOff}; \${bootErrors.slice(errorsBeforeAfcOff).join(" | ")}\`);

    // ---- 7. the PAGE's own RX log, driven through a real path -------------
    // rtty-tx-fsk-echo is the QRPlog hand-off that mirrors a firmware GPIO FSK
    // send into this page's log -- it runs the page's own echoTxText(), so it
    // proves the page's rxLog instance is wired, not just that the module works.
    const txChannel = new BroadcastChannel("wifilt-rtty-tx");
    txChannel.postMessage({type: "rtty-tx-fsk-echo", text: "CQ DE OK1HRA"});
    await sleep(120);
    const echo = $("rttyRxLog").querySelector(".rtty-tx-echo");
    check("a mirrored FSK send appears in the page's own RX log", !!echo);
    check("echoed uppercase, one span per character",
      echo && echo.querySelectorAll(".rtty-tx-char").length === "CQ DE OK1HRA".length,
      echo ? String(echo.querySelectorAll(".rtty-tx-char").length) : "no echo");
    check("this station's own callsign is NOT clickable as a token",
      $("rttyRxLog").querySelectorAll(".rtty-tok").length === 0);

    $("rttyRxClear").click();
    await sleep(60);
    check("CLEAR empties the page's RX log", $("rttyRxLog").textContent === "",
      JSON.stringify($("rttyRxLog").textContent.slice(0, 40)));

    // ---- 8. the extracted RX-log module, mounted standalone ---------------
    // The page gives no handle on its decoder, so the token/colour/click
    // behaviour is exercised against the module directly -- the same file the
    // page and QRPlog's palette both load.
    const scratch = document.createElement("div");
    document.body.appendChild(scratch);
    let handedOver = null;
    const rxLog = RttyRxLog.create({
      el: scratch, maxChars: 200,
      floorRgb: [40, 40, 40], ceilRgb: [255, 255, 255],
      onToken: word => { handedOver = word; },
    });
    for (const ch of "OK1HRA") rxLog.pushChar(ch, {snrDb: 12});
    rxLog.pushChar(" ", {});
    for (const ch of "DL2XYZ") rxLog.pushChar(ch, {snrDb: 1});
    const tokens = scratch.querySelectorAll(".rtty-tok");
    check("decoded words become separate clickable tokens", tokens.length === 2,
      String(tokens.length));
    check("a space ends a token, and is not swallowed",
      scratch.textContent === "OK1HRA DL2XYZ", JSON.stringify(scratch.textContent));

    // The gradient keys off |snrDb|, so a strong character must be visibly
    // brighter than a weak one -- the whole point of colouring them at all.
    const strong = tokens[0].querySelector(".rtty-rx-char").style
      .getPropertyValue("--rtty-rx-char-color");
    const weak = tokens[1].querySelector(".rtty-rx-char").style
      .getPropertyValue("--rtty-rx-char-color");
    const lum = c => (c.match(/\\d+/g) || [0]).reduce((a, b) => a + +b, 0);
    check("a strong character is drawn brighter than a weak one",
      strong && weak && lum(strong) > lum(weak), \`\${weak} vs \${strong}\`);

    // The third stop: above hotDb a character goes bright green, because white
    // is the brightest a screen has and the scale has to keep saying something
    // above it. Checked on hue, not on brightness -- the green is DIMMER than
    // white, which is the whole point and also the easiest thing to get
    // backwards. (It was sandy yellow until 2026-09-08; the operator read the
    // sand as washed out and asked for QRPLog's own bar green instead.)
    for (const ch of " OK1ABC") rxLog.pushChar(ch, {snrDb: 24});
    const hotTok = scratch.querySelectorAll(".rtty-tok")[2];
    const hot = hotTok.querySelector(".rtty-rx-char").style
      .getPropertyValue("--rtty-rx-char-color");
    const rgb = c => (c.match(/\\d+/g) || []).map(Number);
    // Green is a HUE shift, not a dimming: the green channel must stay up at
    // the white end's level while red drops away. Getting that backwards would
    // make the strongest characters read as the weakest.
    check("an exceptionally strong character keeps white's green channel",
      rgb(hot)[1] >= 250, hot);
    check("and gets its colour by losing red, not by going darker",
      rgb(hot)[0] <= 160 && rgb(hot)[1] - rgb(hot)[0] > 60, hot);

    // A character just above the white stop must be only slightly tinted, not a
    // jump to full green -- snrDb moves several dB between adjacent characters
    // of one word, and a hard threshold would make that word flicker.
    // Measured on RED, the channel that actually separates this green from
    // white (255 -> 99); blue moves too, but less, so it is the weaker probe.
    const scratch3 = document.createElement("div");
    document.body.appendChild(scratch3);
    const rx3 = RttyRxLog.create({el: scratch3, maxChars: 500,
      floorRgb: [40, 40, 40], onToken: () => {}});
    rx3.pushChar("A", {snrDb: 16});
    const warm = rgb(scratch3.querySelector(".rtty-rx-char").style
      .getPropertyValue("--rtty-rx-char-color"));
    check("just above the white stop is barely tinted, not a jump to full green",
      warm[0] > 200 && warm[0] < 255, JSON.stringify(warm));
    check("and the tint deepens with the level rather than stepping",
      (function () {
        rx3.clear();
        rx3.pushChar("B", {snrDb: 19});
        const deeper = rgb(scratch3.querySelector(".rtty-rx-char").style
          .getPropertyValue("--rtty-rx-char-color"));
        return deeper[0] < warm[0] && deeper[0] > 110;
      })());

    tokens[1].querySelector(".rtty-rx-char").click();
    check("clicking a character hands over the WHOLE word", handedOver === "DL2XYZ",
      String(handedOver));

    // Scrollback trimming drops whole leading nodes, so it is only meaningful
    // against realistic traffic -- one unbroken 400-character token IS the
    // whole log, and dropping it empties the pane. Real RTTY has word breaks;
    // this pushes some, and demands the log end up both under budget and
    // still showing the most recent text.
    for (let i = 0; i < 60; i++) { for (const ch of "TEST") rxLog.pushChar(ch, {snrDb: 6}); rxLog.pushChar(" ", {}); }
    check("scrollback is trimmed to the budget", scratch.textContent.length <= 200,
      String(scratch.textContent.length));
    check("and the newest text survives the trim, oldest first out",
      scratch.textContent.trim().endsWith("TEST") && !scratch.textContent.includes("OK1HRA"),
      JSON.stringify(scratch.textContent.slice(-30)));

    // ---- 9. squelch break: throttled, never a leading blank line ----------
    const scratch2 = document.createElement("div");
    document.body.appendChild(scratch2);
    const rx2 = RttyRxLog.create({el: scratch2, maxChars: 500,
      squelchNewlineThrottleMs: 2000, onToken: () => {}});
    check("no break is inserted into an empty log", rx2.squelchBreak() === false);
    rx2.pushChar("A", {snrDb: 9});
    check("the first break after real text is inserted", rx2.squelchBreak() === true);
    check("a second break inside the throttle window is dropped",
      rx2.squelchBreak() === false);
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
    "--no-proxy-server", "--window-size=1280,900",
    `http://127.0.0.1:${port}/rtty.html`,
  ], {stdio: ["ignore", "ignore", "pipe"]});
  let chromeErrors = "";
  chrome.stderr.on("data", chunk => { chromeErrors += chunk; });
  chrome.on("error", error => finish({checks: [["chrome started", false, error.message]]}));
  chrome.on("close", code => {
    if (!finished) finish({checks: [["chrome stayed up", false,
      `exit ${code} ${chromeErrors.slice(-400)}`]]});
  });
  timer = setTimeout(() => finish({checks: [["the page reported within the timeout", false,
    "no /result was posted"]]}), 90000);
});

process.on("SIGINT",  () => finish({checks: [["interrupted", false, "SIGINT"]]}));
process.on("SIGTERM", () => finish({checks: [["interrupted", false, "SIGTERM"]]}));

// The fixture wraps rtty.html on the way out: an error collector BEFORE every
// other script (so a boot-time throw is caught, not missed), and the test
// script after them. The page under test is otherwise byte-identical.
const ERROR_COLLECTOR = `
window.__rttySmokeErrors = [];
window.addEventListener("error", e =>
  window.__rttySmokeErrors.push(String((e.error && e.error.stack) || e.message)));
window.addEventListener("unhandledrejection", e =>
  window.__rttySmokeErrors.push("unhandled rejection: " + String(e.reason)));
`;
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file === "string" && file.endsWith("rtty.html")) {
    const text = content.toString();
    const head = text.replace("<head>", `<head>\n<script>${ERROR_COLLECTOR}</script>`);
    return Buffer.from(`${head}\n<script>${PAGE_SCRIPT}</script>\n`);
  }
  return content;
};
