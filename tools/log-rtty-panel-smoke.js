#!/usr/bin/env node
"use strict";

// The RTTY palette on QRPLog, driven in a real browser.
//
// Why this harness exists: the palette floats over a contest log that is driven
// entirely from the keyboard, and the one thing it was built for -- click a
// decoded word, then press Enter -- fails silently in every interesting way.
// Four of those failures are invisible from the source:
//
//   * the word landing in the wrong field, because the palette's own click
//     blurred Call/Exch before anything asked which one the operator was in;
//   * the caret ending up nowhere, so Enter reaches the document instead of
//     the log's own Enter workflow;
//   * a drag to SELECT decoded text being treated as a click and overwriting
//     the field the operator was typing in;
//   * a remembered "open" claiming the shared radio audio WITH force on a
//     plain page reload, silently kicking a beacon off the air.
//
// The assertions therefore sit on document.activeElement, on the input values
// the log actually holds, and on the recorded session POST bodies -- never on
// internal state.
//
// Not covered here, on purpose: transmitting. That needs a real AUD1
// WebSocket, and the AFSK path is the same rtty-afsk-tx.js the full page uses
// (guarded by tools/rtty-page-smoke.js and by on-air testing).

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;
const sessionPosts = [];          // every /js8/session/* body, in order
let lanConfigured = true;         // does the saved setup have ICOM-LAN?
let claimRefused = false;         // make /js8/session/claim answer 409

function finish(result) {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  if (chrome) {
    chrome.kill("SIGTERM");
    setTimeout(() => chrome && chrome.kill("SIGKILL"), 2000).unref();
  }
  const checks = (result && result.checks) || [];
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? `  -- ${detail}` : ""}`);
  }
  console.log(`\nRTTY PANEL ${failed ? "FAIL" : "PASS"} ${checks.length - failed}/${checks.length}`);
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

  // Test control surface, so the page can steer its own fixture.
  if (url.pathname === "/set-lan") { lanConfigured = url.searchParams.get("v") === "1"; return json({ok: true}); }
  if (url.pathname === "/set-claim-refused") { claimRefused = url.searchParams.get("v") === "1"; return json({ok: true}); }
  if (url.pathname === "/session-posts") return json(sessionPosts);
  if (url.pathname === "/session-posts/clear") { sessionPosts.length = 0; return json({ok: true}); }

  if (url.pathname === "/setup-data.json") return json(lanConfigured ? {
    trx1transport: "lan", trx1lanip: "192.168.1.50", trx1lanuser: "user",
    trx1lanpass: "pass", trx1model: "IC-705",
  } : {trx1transport: "civ"});

  if (url.pathname.startsWith("/js8/session")) {
    if (request.method === "POST") return readBody(body => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) {}
      sessionPosts.push({path: url.pathname, body: parsed});
      if (claimRefused && url.pathname.endsWith("/claim") && !parsed.force) {
        response.writeHead(409, {"Content-Type": "application/json"});
        return response.end(JSON.stringify({owner: "192.168.1.9", ageMs: 4000}));
      }
      json({ok: true});
    });
    return json({held: true, role: "rtty"});
  }

  // The palette reads ?radio=lan; the log itself reads plain /state. Same
  // object here, with the LAN radio in a data mode so the RTTY button shows.
  if (url.pathname === "/state") return json({
    connected: true, catHealthy: true, audioReady: true, lanStatus: "linked",
    btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
    fullCat: true, wifiRssi: -55, fwRev: "20260907", bdSupported: false,
    power: true, frequency: 14085000, mode: "USB-D", filter: 1,
    radioAddress: "a4", transceiverType: "IC-705", radioName: "IC-705",
    tx: false, ritRaw: 0, smeterRaw: 0, powerMeterRaw: 0, afGain: 100,
    keySpeed: 20, rfPower: 128, rfPowerSeen: true, supplyVolts: 13.8, swr: 1.1,
    preamp: 0, vox: 0, dxcConnected: false,
  });

  if (url.pathname === "/cmd" && request.method === "POST")
    return readBody(() => json({ok: true}));
  if (url.pathname === "/civread") return json({});
  if (url.pathname === "/txgain.json") return json({v: 1, entries: {}});
  if (url.pathname === "/txgain-plan.json") return json({});
  if (url.pathname === "/dxcinfo") return json({locator: "JO70", call: "OK1HRA"});
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70"});
  if (url.pathname === "/log-config") return json({
    trx1Label: "TRX1", trx2Label: "TRX2", trx3Label: "TRX3",
    trx2enabled: false, trx3enabled: false, blockedDxcc: "",
  });
  if (url.pathname === "/log-macros.json") return json({});
  if (url.pathname === "/pa.json") return json({state: "ok", present: false});

  let file = url.pathname === "/" ? path.join(data, "log.html")
                                  : path.join(data, path.basename(url.pathname));
  if (process.env.RTTY_PANEL_SMOKE_MINIFIED === "1" && file.endsWith(".js")
      && fs.existsSync(file + ".min")) file = file + ".min";
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    response.writeHead(200, {"Content-Type": mime[path.extname(file)] || "text/plain"});
    return response.end(fs.readFileSync(file));
  }
  response.writeHead(404).end("not found");
});

const PAGE_SCRIPT = `
(async function () {
  const phase2 = sessionStorage.getItem("rttyPanelSmokePhase") === "2";
  const checks = phase2
    ? JSON.parse(sessionStorage.getItem("rttyPanelSmokeChecks") || "[]") : [];
  const check = (name, ok, detail) => checks.push([name, !!ok, detail || ""]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  const posts = async () => await (await fetch("/session-posts")).json();
  const clearPosts = async () => { await fetch("/session-posts/clear"); };

  // ---- second pass: the same page, reloaded with no ICOM-LAN configured ----
  if (phase2) {
    sessionStorage.removeItem("rttyPanelSmokePhase");
    try {
      await sleep(1500);
      check("without a link, the palette knows it", window.RttyPanel.lanReady() === false,
        String(window.RttyPanel.lanReady()));
      check("the RTTY button is not offered at all", $("btnRttyPopup").hidden);
      check("a remembered open state does not restore a palette that cannot listen",
        !window.RttyPanel.isOpen() && (!$("rttyPanel") || $("rttyPanel").style.display === "none"),
        "open=" + window.RttyPanel.isOpen());
      check("and it never claimed the radio audio on the way",
        (await posts()).filter(p => p.path.endsWith("/claim")).length === 0,
        JSON.stringify((await posts()).map(p => p.path)));
      window.RttyPanel.setOpen(true);
      await sleep(200);
      check("asking it to open anyway is refused", !window.RttyPanel.isOpen());
    } catch (error) {
      check("the no-link pass ran to the end", false, String(error && error.stack || error));
    }
    await fetch("/result", {method: "POST", body: JSON.stringify({checks})});
    return;
  }

  // A decoded word, put straight into the palette's RX log. The click handler
  // is delegated off the container, so this exercises the real path without
  // needing a real AUD1 stream to decode one.
  function putToken(word) {
    const rx = $("rttyPanelRx");
    const tok = document.createElement("span");
    tok.className = "rtty-tok";
    const ch = document.createElement("span");
    ch.className = "rtty-rx-char";
    ch.textContent = word;
    tok.appendChild(ch);
    rx.appendChild(tok);
    rx.appendChild(document.createTextNode(" "));
    return tok;
  }
  // A real click is pointerdown THEN click -- and the order is the whole
  // point: the palette has to read the focused field on the first of them.
  function realClick(node) {
    node.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}));
    node.dispatchEvent(new MouseEvent("click", {bubbles: true}));
  }

  try {
    await sleep(1400);

    // ---- 1. the button appears only when there is something to listen to --
    check("the RTTY button is offered on a LAN radio in a data mode",
      !$("btnRttyPopup").hidden, "hidden=" + $("btnRttyPopup").hidden);
    check("and it no longer claims to open a window",
      !/window/i.test($("btnRttyPopup").title), $("btnRttyPopup").title);

    // ---- 2. opening claims the session, and NEVER with force --------------
    await clearPosts();
    $("btnRttyPopup").click();
    await sleep(500);
    check("the palette is built and shown", !!$("rttyPanel")
      && $("rttyPanel").style.display !== "none");
    const claims = (await posts()).filter(p => p.path.endsWith("/claim"));
    check("opening claims the shared audio session", claims.length >= 1,
      JSON.stringify(claims));
    check("as role rtty, so QRPLog's own tagging keeps working",
      claims.length > 0 && claims[0].body.role === "rtty",
      JSON.stringify(claims[0] && claims[0].body));
    check("and WITHOUT force -- a beacon elsewhere is never silently kicked",
      claims.every(c => c.body.force !== true), JSON.stringify(claims.map(c => c.body.force)));

    // ---- 3. geometry: the scope is fixed, the RX log takes the growth ------
    const panel = $("rttyPanel"), rx = $("rttyPanelRx"), scope = $("rttyPanelScope");
    const scopeH0 = scope.getBoundingClientRect().height;
    const rxH0 = rx.getBoundingClientRect().height;
    // It opens on a few lines of decoded text, not on half the contest log.
    check("the palette opens compact, with the RX log smaller than the scope",
      rxH0 > 100 && rxH0 < scopeH0, \`rx=\${rxH0} scope=\${scopeH0}\`);
    panel.style.height = (panel.offsetHeight + 120) + "px";
    await sleep(150);
    check("making the palette taller grows the RX log",
      rx.getBoundingClientRect().height > rxH0 + 100,
      \`\${rxH0} -> \${rx.getBoundingClientRect().height}\`);
    check("and leaves the waterfall exactly as it was",
      Math.abs(scope.getBoundingClientRect().height - scopeH0) < 1,
      \`\${scopeH0} -> \${scope.getBoundingClientRect().height}\`);
    check("the palette stays at its fixed narrow width",
      Math.round(panel.getBoundingClientRect().width) === 320,
      String(panel.getBoundingClientRect().width));

    // ---- 3b. zoom pills ---------------------------------------------------
    // They live inside the drag handle and next to the log's own input row, so
    // three things have to hold at once: they zoom, they do not start a drag,
    // and they do not take the keyboard.
    const zoom = n => $("rttyPanelZoom").querySelector('[data-zoom="' + n + '"]');
    check("the palette opens at 100 %", zoom(100).classList.contains("active"));
    const panelLeftBefore = panel.getBoundingClientRect().left;
    $("inpCall").focus();
    const zoomMd = new MouseEvent("mousedown", {bubbles: true, cancelable: true});
    zoom(400).dispatchEvent(zoomMd);
    zoom(400).click();
    await sleep(150);
    check("pressing 400 % marks it and clears 100 %",
      zoom(400).classList.contains("active") && !zoom(100).classList.contains("active"));
    check("and it really narrowed the visible window",
      window.RttyPanel.getState().zoom === 400,
      String(window.RttyPanel.getState().zoom));
    check("a zoom press does not drag the palette",
      Math.abs(panel.getBoundingClientRect().left - panelLeftBefore) < 1,
      \`\${panelLeftBefore} -> \${panel.getBoundingClientRect().left}\`);
    check("and does not take the caret out of Call",
      zoomMd.defaultPrevented && document.activeElement === $("inpCall"),
      document.activeElement ? document.activeElement.id : "(none)");
    zoom(100).click();
    await sleep(100);

    // Five children in a 320 px bar: title, three pills, status and close.
    // Measured against a status far longer than any the palette actually
    // shows, because the failure being guarded is a title bar that pushes the
    // close button off the edge -- the status is the one part allowed to
    // shrink, so it must be the one that gives.
    const head = $("rttyPanelHead"), state = $("rttyPanelState");
    const stateWas = state.textContent;
    state.textContent = "connecting… a very long status indeed";
    await sleep(50);
    check("the title bar fits at 320 px even with the longest status",
      head.scrollWidth <= head.clientWidth + 1,
      \`scroll=\${head.scrollWidth} client=\${head.clientWidth}\`);
    check("and the close button is still inside the palette",
      $("rttyPanelClose").getBoundingClientRect().right
        <= panel.getBoundingClientRect().right + 1,
      \`close=\${$("rttyPanelClose").getBoundingClientRect().right} panel=\${panel.getBoundingClientRect().right}\`);
    state.textContent = stateWas;

    // ---- 4. THE focus rule -----------------------------------------------
    // Everything this palette exists for is in these four checks.
    const inpCall = $("inpCall"), inpExch = $("inpExch");
    inpCall.value = ""; inpExch.value = "";

    inpCall.focus();
    realClick(putToken("DL2XYZ"));
    await sleep(120);
    check("a word clicked while in Call lands in Call", inpCall.value === "DL2XYZ",
      JSON.stringify(inpCall.value));
    check("and the caret is IN Call afterwards, so Enter reaches the log",
      document.activeElement === inpCall,
      document.activeElement ? document.activeElement.id : "(none)");
    check("with the caret at the end, ready to correct or send",
      inpCall.selectionStart === inpCall.value.length, String(inpCall.selectionStart));

    inpExch.focus();
    realClick(putToken("599001"));
    await sleep(120);
    check("a word clicked while in Exch lands in Exch, not in Call",
      inpExch.value === "599001" && inpCall.value === "DL2XYZ",
      \`call=\${inpCall.value} exch=\${inpExch.value}\`);
    check("and the caret follows it there", document.activeElement === inpExch,
      document.activeElement ? document.activeElement.id : "(none)");

    // ---- 5. selecting text must not be mistaken for a click ---------------
    inpCall.focus();
    const before = inpCall.value;
    const tok = putToken("OK1HRA");
    tok.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}));
    const range = document.createRange();
    range.selectNodeContents(tok);
    const selection = getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    tok.dispatchEvent(new MouseEvent("click", {bubbles: true}));
    await sleep(120);
    check("dragging a selection across decoded text inserts NOTHING",
      inpCall.value === before, JSON.stringify(inpCall.value));
    check("and leaves the selection intact for Ctrl+C",
      String(getSelection()).indexOf("OK1HRA") >= 0, JSON.stringify(String(getSelection())));
    selection.removeAllRanges();

    // ---- 6. the palette's own chrome never steals the keyboard ------------
    inpCall.focus();
    const closeBtn = $("rttyPanelClose");
    const md = new MouseEvent("mousedown", {bubbles: true, cancelable: true});
    closeBtn.dispatchEvent(md);
    check("mousedown on a palette button is cancelled, so focus cannot move",
      md.defaultPrevented);
    check("and the caret is still in Call", document.activeElement === inpCall,
      document.activeElement ? document.activeElement.id : "(none)");

    // ---- 7. geometry survives a close, and a stored one is clamped --------
    const movedTo = {x: 140, y: 90};
    $("rttyPanel").style.left = movedTo.x + "px";
    $("rttyPanel").style.top = movedTo.y + "px";
    window.RttyPanel.setOpen(false);
    await sleep(200);
    check("closing hides the palette", $("rttyPanel").style.display === "none");
    const releases = (await posts()).filter(p => p.path.endsWith("/release"));
    check("and hands the radio audio back", releases.length >= 1,
      JSON.stringify(releases.map(r => r.path)));
    let stored = JSON.parse(localStorage.getItem("wifilt-rtty-panel") || "{}");
    check("the closed state is remembered", stored.open === false, JSON.stringify(stored));
    check("along with the height it was dragged to", stored.height > 400,
      String(stored.height));

    // A position stored on a wide screen must come back on-screen on a narrow
    // one, or the palette is simply gone with no way to get it back.
    localStorage.setItem("wifilt-rtty-panel",
      JSON.stringify({open: true, x: 99999, y: 99999, height: 430}));
    window.RttyPanel.setOpen(false);
    window.RttyPanel.setOpen(true);
    await sleep(300);
    const box = $("rttyPanel").getBoundingClientRect();
    check("an off-screen stored position is clamped back into view",
      box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1,
      \`left=\${box.left} top=\${box.top} right=\${box.right}\`);

    // ---- 7b. a reopened palette is still a working palette ----------------
    // Closing used to tear the scope's listeners down with its frame loop, so
    // click-to-tune and the hover preview were silently dead the second time
    // the palette was opened -- nothing visible, the waterfall just stopped
    // answering the mouse.
    const scopeEl = $("rttyPanelScope");
    const scopeBox = scopeEl.getBoundingClientRect();
    const toneBefore = window.RttyPanel.getState().settings.toneHz;
    scopeEl.dispatchEvent(new MouseEvent("click", {bubbles: true,
      clientX: scopeBox.left + scopeBox.width * 0.7, clientY: scopeBox.top + 10}));
    await sleep(150);
    check("after closing and reopening, clicking the waterfall still tunes",
      window.RttyPanel.getState().settings.toneHz !== toneBefore,
      \`\${toneBefore} -> \${window.RttyPanel.getState().settings.toneHz}\`);

    // ---- 7c. a window height change keeps the gap to the log's fields -----
    // The palette hangs from the BOTTOM of the viewport, not the top. The
    // Call/Exch fields sit just above the bottom button bar, so a palette
    // measured from the top edge walks into them as the window shrinks and
    // drifts away from them as it grows -- and an operator who has parked it
    // one line above the fields has to park it again after every resize.
    // Chrome cannot resize its own window from inside the page, so innerHeight
    // is stubbed and the page's own resize handler is run: the same code path a
    // real resize takes, with the same real DOM underneath.
    const panelEl = $("rttyPanel"), headEl = $("rttyPanelHead");
    const realHeight = window.innerHeight;
    const setViewportHeight = h => {
      Object.defineProperty(window, "innerHeight", {configurable: true, get: () => h});
      window.dispatchEvent(new Event("resize"));
    };
    const bottomGap = () =>
      window.innerHeight - (parseInt(panelEl.style.top, 10) + panelEl.offsetHeight);

    // Up, not down: the previous section left the palette flush with the bottom
    // edge, and every check below is about a gap that is actually there.
    headEl.dispatchEvent(new PointerEvent("pointerdown", {bubbles:true, cancelable:true, clientX:300, clientY:300, pointerId:7}));
    headEl.dispatchEvent(new PointerEvent("pointermove", {bubbles:true, clientX:300, clientY:220, pointerId:7}));
    headEl.dispatchEvent(new PointerEvent("pointerup",   {bubbles:true, clientX:300, clientY:220, pointerId:7}));
    await sleep(120);
    const gapBefore = bottomGap(), topBefore = parseInt(panelEl.style.top, 10);

    setViewportHeight(realHeight - 150);
    await sleep(150);
    check("a shorter window moves the palette up with the bottom edge",
      parseInt(panelEl.style.top, 10) === topBefore - 150,
      topBefore + " -> " + panelEl.style.top);
    check("so its distance to the log's entry fields is unchanged",
      bottomGap() === gapBefore, gapBefore + " -> " + bottomGap());

    setViewportHeight(realHeight + 250);
    await sleep(150);
    check("and a taller window keeps that same distance",
      bottomGap() === gapBefore, gapBefore + " -> " + bottomGap());

    stored = JSON.parse(localStorage.getItem("wifilt-rtty-panel") || "{}");
    check("the gap to the bottom edge is what gets remembered",
      stored.gap === gapBefore, JSON.stringify(stored));

    // Dragging the palette TALLER by its own resize handle grows it downward
    // from a fixed top, so the bottom edge the operator left it at is the new
    // anchor -- otherwise the next window resize would snap it back by the
    // height they just added.
    const grownTop = parseInt(panelEl.style.top, 10);
    panelEl.style.height = (panelEl.offsetHeight + 60) + "px";
    await sleep(200);
    check("resizing the palette itself grows it downward, top unmoved",
      parseInt(panelEl.style.top, 10) === grownTop,
      grownTop + " -> " + panelEl.style.top);
    const gapAfterGrow = bottomGap();
    setViewportHeight(realHeight);
    await sleep(150);
    check("and the new bottom edge is what the next window resize keeps",
      bottomGap() === gapAfterGrow, gapAfterGrow + " -> " + bottomGap());

    // ---- 8. held elsewhere: the card, and TAKE OVER ------------------------
    await fetch("/set-claim-refused?v=1");
    await clearPosts();
    window.RttyPanel.setOpen(false);
    await sleep(150);
    window.RttyPanel.setOpen(true);
    await sleep(600);
    check("a refused claim shows the held-elsewhere card",
      !$("rttyPanelBusy").hidden);
    check("naming who has it", /192\\.168\\.1\\.9/.test($("rttyPanelBusyWhere").textContent),
      JSON.stringify($("rttyPanelBusyWhere").textContent));
    check("and the palette says it has no audio",
      /no audio/.test($("rttyPanelState").textContent),
      JSON.stringify($("rttyPanelState").textContent));

    await clearPosts();
    $("rttyPanelTakeover").click();
    await sleep(500);
    const forced = (await posts()).filter(p => p.path.endsWith("/claim") && p.body.force === true);
    check("TAKE OVER is the only thing that forces the claim", forced.length === 1,
      JSON.stringify((await posts()).map(p => p.body.force)));
    await fetch("/set-claim-refused?v=0");
    // ---- 9. hand over to the no-ICOM-LAN pass -----------------------------
    // The "there is no link" path cannot be reached by poking state: the
    // palette learns it from LanGate.read() at mount, once. So the fixture is
    // switched over and the page genuinely reloaded, with the checks so far
    // carried across -- a remembered open:true is deliberately left in
    // localStorage, because a palette restoring itself onto a radio that has
    // no audio link is exactly the case worth catching.
    check("with a link configured, the palette reports it as ready",
      window.RttyPanel.lanReady() === true, String(window.RttyPanel.lanReady()));
    window.RttyPanel.setOpen(true);
    await sleep(200);
    await fetch("/set-lan?v=0");
    sessionStorage.setItem("rttyPanelSmokeChecks", JSON.stringify(checks));
    sessionStorage.setItem("rttyPanelSmokePhase", "2");
    // Cleared last, so the second pass grades only what IT did. The release
    // the palette fires on the way out lands after this and is expected --
    // hence the check over there looks for a claim specifically.
    await clearPosts();
    location.reload();
    return;
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
    if (!finished) finish({checks: [["chrome stayed up", false,
      `exit ${code} ${chromeErrors.slice(-400)}`]]});
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
