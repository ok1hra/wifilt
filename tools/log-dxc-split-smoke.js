#!/usr/bin/env node
"use strict";

// The DX cluster split pane on QRPLog, driven in a real browser.
//
// Why this harness exists. The split was built for exactly one thing: click a
// spot's frequency and be able to TYPE. The pop-up it replaces already put the
// callsign in Call and already put the caret there -- what it could not do was
// hand over the keyboard, because the click left focus in another OS window.
// That failure is invisible from the source and invisible in a screenshot: the
// field looks right, and the operator's Enter goes somewhere else. So the first
// check here is document.activeElement in the PARENT document after a click
// inside the iframe, and nothing about it is negotiable.
//
// The second reason is the cluster socket. The firmware keeps ONE DxcWsClient
// (wifilt.ino:654) and a second upgrade evicts the first (:9259) while forcing
// a fresh telnet login (:9271); the page reconnects 2.5 s after any close. Two
// instances therefore evict each other forever -- a real incident that once
// read as "DXC keeps dropping WS and Telnet" and turned out to be five DXC
// windows open at once. The fixture's WebSocket server models that eviction
// faithfully, so a browser-side bug that opens two sockets shows up here as
// the same storm it causes on the device, rather than as a passing test.
//
// Two Chrome passes, because the 900px threshold cannot be reached by poking
// state: a viewport is a viewport. Pass 1 is 1280x900 (split allowed), pass 2
// is 800x700 (split must refuse and fall back to the pop-up).
//
// Not covered here, on purpose: the 8 s dead-leader watchdog. Removing an
// iframe fires pagehide, so the resign path -- the one that actually runs when
// a window is closed -- promotes in well under a second and is what is checked.
// The watchdog is the backstop for a crashed tab, and waiting it out would add
// eight idle seconds to every run.

const http = require("http"), fs = require("fs"), path = require("path");
const crypto = require("crypto");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null, port = 0;
let pass = 1;
const allChecks = [];

// ── Fake cluster over WebSocket ──────────────────────────────────────────────

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
let wsConns = [];        // live sockets, at most one by construction
let wsOpens = 0;         // accepted upgrades ever -- the storm detector
let clusterCmds = [];    // text frames the "cluster" received

function wsEncode(text) {
  const payload = Buffer.from(text, "utf8");
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

// Returns {opcode, text, size} for one complete frame, or null when the buffer
// does not hold a whole one yet. Client frames are always masked.
function wsDecode(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskOff = off;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  const body = Buffer.from(buf.subarray(off, off + len));
  if (masked) for (let i = 0; i < len; i++) body[i] ^= buf[maskOff + (i % 4)];
  return {opcode, text: body.toString("utf8"), size: off + len};
}

function clusterPush(line) {
  for (const socket of wsConns) { try { socket.write(wsEncode(line + "\n")); } catch (_) {} }
}

// ── Fixture ──────────────────────────────────────────────────────────────────

function finish(result) {
  if (finished) return;
  const checks = (result && result.checks) || [];
  for (const c of checks) allChecks.push(c);

  if (pass === 1 && !(result && result.hard)) {
    // Hand over to the narrow-viewport pass in a fresh browser.
    pass = 2;
    killChrome();
    setTimeout(() => launchChrome(800, 700), 400).unref();
    return;
  }

  finished = true;
  if (timer) clearTimeout(timer);
  killChrome();
  let failed = 0;
  for (const [name, ok, detail] of allChecks) {
    if (!ok) failed++;
    console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? `  -- ${detail}` : ""}`);
  }
  console.log(`\nDXC SPLIT ${failed ? "FAIL" : "PASS"} ${allChecks.length - failed}/${allChecks.length}`);
  setTimeout(() => process.exit(failed ? 1 : 0), 150).unref();
}

function killChrome() {
  if (!chrome) return;
  const dying = chrome;
  chrome = null;
  dying.kill("SIGTERM");
  // SIGKILL follow-up is not paranoia: a killed driver once left headless
  // Chrome children alive and still keying a real radio for ten minutes.
  setTimeout(() => { try { dying.kill("SIGKILL"); } catch (_) {} }, 2000).unref();
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

  if (url.pathname === "/pass") return json({pass});
  if (url.pathname === "/ws-stats") return json({opens: wsOpens, live: wsConns.length, cmds: clusterCmds});
  if (url.pathname === "/ws-stats/clear") { wsOpens = 0; clusterCmds = []; return json({ok: true}); }
  if (url.pathname === "/ws-push") { clusterPush(url.searchParams.get("line") || ""); return json({ok: true}); }

  if (url.pathname === "/state") return json({
    connected: true, catHealthy: true, audioReady: true, lanStatus: "linked",
    btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
    fullCat: true, wifiRssi: -55, fwRev: "20260907", bdSupported: false,
    power: true, frequency: 14074000, mode: "USB", filter: 1,
    radioAddress: "a4", transceiverType: "IC-705", radioName: "IC-705",
    tx: false, ritRaw: 0, smeterRaw: 0, powerMeterRaw: 0, afGain: 100,
    keySpeed: 20, rfPower: 128, rfPowerSeen: true, supplyVolts: 13.8, swr: 1.1,
    preamp: 0, vox: 0, dxcConnected: true,
  });

  if (url.pathname === "/oi3/state") return json({
    connected: true, power: true, frequency: 14074000, mode: "USB",
    tx: false, dxcConnected: true, radioName: "TRX2",
  });
  if (url.pathname === "/setup-data.json") return json({trx1transport: "civ"});
  if (url.pathname === "/cmd" && request.method === "POST")
    return readBody(() => json({ok: true}));
  if (url.pathname === "/oi3/set-hz" && request.method === "POST")
    return readBody(() => json({ok: true}));
  if (url.pathname === "/civread") return json({});
  if (url.pathname === "/txgain.json") return json({v: 1, entries: {}});
  if (url.pathname === "/txgain-plan.json") return json({});
  if (url.pathname === "/dxcinfo")
    return json({locator: "JO70UC", callsign: "OK1HRA", trx2netid: 1, trx3netid: 1});
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70UC"});
  if (url.pathname === "/log-config") return json({
    trx1Label: "TRX1", trx2Label: "TRX2", trx3Label: "TRX3",
    trx2enabled: true, trx3enabled: true, blockedDxcc: "",
  });
  if (url.pathname === "/log-macros.json") return json({});
  if (url.pathname === "/pa.json") return json({state: "ok", present: false});

  let file = url.pathname === "/" ? path.join(data, "log.html")
                                  : path.join(data, path.basename(url.pathname));
  if (process.env.DXC_SPLIT_SMOKE_MINIFIED === "1" && file.endsWith(".js")
      && fs.existsSync(file + ".min")) file = file + ".min";
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    response.writeHead(200, {"Content-Type": mime[path.extname(file)] || "text/plain"});
    return response.end(fs.readFileSync(file));
  }
  response.writeHead(404).end("not found");
});

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url, "http://fixture");
  if (url.pathname !== "/dxcws") { socket.destroy(); return; }
  const accept = crypto.createHash("sha1")
    .update(request.headers["sec-websocket-key"] + WS_GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
    + "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  wsOpens++;
  // The device holds one client and evicts the previous one. Modelled here on
  // purpose -- see the header.
  for (const old of wsConns.splice(0)) { try { old.destroy(); } catch (_) {} }
  wsConns.push(socket);
  socket.on("error", () => {});
  socket.on("close", () => { wsConns = wsConns.filter(c => c !== socket); });
  let buf = Buffer.alloc(0);
  socket.on("data", chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const frame = wsDecode(buf);
      if (!frame) break;
      buf = buf.subarray(frame.size);
      if (frame.opcode === 8) { socket.destroy(); return; }
      if (frame.opcode === 1) clusterCmds.push(frame.text.trim());
    }
  });
  try { socket.write(wsEncode(JSON.stringify({telnet: true}))); } catch (_) {}
});

// ── The page script ──────────────────────────────────────────────────────────

const PAGE_SCRIPT = `
(async function () {
  const checks = [];
  const check = (name, ok, detail) => checks.push([name, !!ok, detail || ""]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  const stats = async () => await (await fetch("/ws-stats")).json();
  const report = async hard => {
    await fetch("/result", {method: "POST", body: JSON.stringify({checks, hard: !!hard})});
  };

  const SPOT = "DX de OK2XYZ:    14074.0  JA1ABC       CQ CQ UP              1204Z";

  function realClick(node, init) {
    node.dispatchEvent(new PointerEvent("pointerdown", Object.assign({bubbles: true}, init)));
    node.dispatchEvent(new MouseEvent("mousedown", Object.assign({bubbles: true}, init)));
    node.dispatchEvent(new MouseEvent("click", Object.assign({bubbles: true}, init)));
  }

  // Wait for a predicate rather than for a fixed delay: the iframe has to
  // load, elect a leader, receive the feed and render before anything here is
  // meaningful, and each of those is timing-dependent.
  async function until(fn, ms, label) {
    const deadline = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await fn(); } catch (_) { v = null; }
      if (v) return v;
      if (Date.now() > deadline) throw new Error("timed out waiting for " + label);
      await sleep(50);
    }
  }

  try {
    const which = (await (await fetch("/pass")).json()).pass;

    // ══ Pass 2: a viewport too narrow for a side-by-side split ══════════════
    if (which === 2) {
      await sleep(1200);
      let opened = null;
      const realOpen = window.open;
      window.open = function (href) { opened = href; return null; };
      try { localStorage.setItem("wifilt-log-split", JSON.stringify({open: true, leftPx: 420})); } catch (e) {}
      // A stored open:true must not be honoured here, and must not be erased
      // either -- rotating a tablet back to landscape has to bring it back.
      LogDxcSplit.close();
      try { localStorage.setItem("wifilt-log-split", JSON.stringify({open: true, leftPx: 420})); } catch (e) {}
      check("a narrow viewport reports the split as closed",
        LogDxcSplit.isOpen() === false, String(LogDxcSplit.isOpen()));
      check("and mounts no iframe", !$("logDxcFrame"));
      $("tabDxc").click();
      await sleep(300);
      check("clicking DXC falls back to the pop-up every other page uses",
        typeof opened === "string" && /dxc\\.html/.test(opened), String(opened));
      check("the split still refuses after that click",
        LogDxcSplit.isOpen() === false, String(LogDxcSplit.isOpen()));
      let stored = {};
      try { stored = JSON.parse(localStorage.getItem("wifilt-log-split") || "{}"); } catch (e) {}
      check("the remembered width survives the narrow pass",
        stored.leftPx === 420, JSON.stringify(stored));
      window.open = realOpen;
      await report(true);
      return;
    }

    // ══ Pass 1: wide enough ════════════════════════════════════════════════
    try { localStorage.removeItem("wifilt-log-split"); } catch (e) {}
    try { localStorage.removeItem("dxcEFreqFilter"); localStorage.removeItem("dxcFreqFilter"); } catch (e) {}
    LogDxcSplit.close();
    await sleep(1200);

    // ---- 1. closed is the default, and costs nothing ----------------------
    check("with no stored state the split is closed",
      LogDxcSplit.isOpen() === false, String(LogDxcSplit.isOpen()));
    check("and no cluster socket is opened while it is closed",
      (await stats()).opens === 0, JSON.stringify(await stats()));
    check("the left pane and the gutter are hidden",
      $("logSplitLeft").hidden && $("logSplitGutter").hidden);

    // ---- 2. the tab opens it ----------------------------------------------
    $("tabDxc").click();
    await sleep(200);
    check("clicking DXC opens the split", LogDxcSplit.isOpen() === true);
    check("the tab is marked, but not as the active page",
      $("tabDxc").classList.contains("tab-split-on")
      && !$("tabDxc").classList.contains("tab-active"));
    check("an iframe is mounted in embed mode",
      !!$("logDxcFrame") && /embed=1/.test($("logDxcFrame").src), String($("logDxcFrame") && $("logDxcFrame").src));

    // ---- 3. the topbar still fits (the 100vw regression) ------------------
    // .tabs used to size itself in vw. Inside the split's right column that
    // overflows the page by the width of the cluster pane.
    check("the page does not scroll sideways with the split open",
      document.body.scrollWidth <= window.innerWidth + 1,
      document.body.scrollWidth + " vs " + window.innerWidth);
    check("the firmware version is out of the tab row's way",
      getComputedStyle($("topbarFw")).display === "none");

    const frame = $("logDxcFrame");
    await until(() => frame.contentWindow && frame.contentDocument
      && frame.contentDocument.getElementById("body"), 8000, "the iframe to load");
    const fdoc = frame.contentDocument;

    // ---- 4. exactly one socket, and it is the pane's ----------------------
    await until(async () => (await stats()).live === 1, 8000, "the pane to connect")
      .catch(() => {});
    let s = await stats();
    check("the embedded pane holds exactly one cluster socket",
      s.live === 1 && s.opens === 1, JSON.stringify(s));

    // ---- 5. a spot arrives and renders ------------------------------------
    await fetch("/ws-push?line=" + encodeURIComponent(SPOT));
    const link = await until(() => fdoc.querySelector("#body .freq-link"), 6000, "the spot to render");
    check("a cluster line renders as a clickable frequency", !!link, link && link.textContent);

    // ---- 6. THE check. Everything this split exists for is here. ---------
    $("inpCall").value = "";
    $("inpCall").focus();
    realClick(link, {button: 0});
    await sleep(250);
    check("the callsign lands in Call", $("inpCall").value === "JA1ABC", $("inpCall").value);
    check("and the KEYBOARD lands in Call too, so Enter reaches the log",
      document.activeElement === $("inpCall"),
      document.activeElement && (document.activeElement.id || document.activeElement.tagName));
    check("with the caret at the end of what just arrived",
      $("inpCall").selectionStart === $("inpCall").value.length,
      $("inpCall").selectionStart + "/" + $("inpCall").value.length);
    check("handing over a spot switches the log to S&P",
      $("btnRunMode").textContent.indexOf("S&P") >= 0, $("btnRunMode").textContent);
    // Typed, not set: proof the field really has the keyboard.
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key: "1", bubbles: true}));
    check("a keystroke after the click is not swallowed by the iframe",
      document.activeElement === $("inpCall"),
      document.activeElement && document.activeElement.id);

    // ---- 7. the middle and right buttons still pick TRX2 / TRX3 ----------
    link.dispatchEvent(new MouseEvent("auxclick", {bubbles: true, button: 1}));
    await sleep(200);
    check("middle click hands the spot to TRX2",
      $("btnTrx2").classList.contains("btn-trx-active"), $("btnTrx2").className);
    fdoc.getElementById("body").dispatchEvent(new MouseEvent("contextmenu", {bubbles: true}));
    await sleep(100);
    $("btnTrx1").click();          // back to the radio the band map follows
    await sleep(400);

    // ---- 8. the gutter drags, clamps and persists -------------------------
    const gutter = $("logSplitGutter"), left = $("logSplitLeft");
    // Hairline, but still grabbable: the visible line is 1px and the hit area
    // is widened with a pseudo-element, so a pointer a few px off the line has
    // to land on the divider and not on the pane behind it.
    const gRect = gutter.getBoundingClientRect();
    check("the divider is a hairline", Math.round(gRect.width) <= 1, String(gRect.width));
    const midY = Math.round(gRect.top + gRect.height / 2);
    check("but it can still be grabbed either side of the line",
      document.elementFromPoint(Math.round(gRect.left) - 3, midY) === gutter
      && document.elementFromPoint(Math.round(gRect.right) + 3, midY) === gutter,
      [document.elementFromPoint(Math.round(gRect.left) - 3, midY),
       document.elementFromPoint(Math.round(gRect.right) + 3, midY)]
        .map(e => e && (e.id || e.tagName)).join(" / "));

    const before = left.getBoundingClientRect().width;
    function drag(toX) {
      gutter.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true, button: 0, pointerId: 1, clientX: gutter.getBoundingClientRect().left}));
      gutter.dispatchEvent(new PointerEvent("pointermove", {bubbles: true, pointerId: 1, clientX: toX}));
      gutter.dispatchEvent(new PointerEvent("pointerup", {bubbles: true, pointerId: 1, clientX: toX}));
    }
    drag(700);
    await sleep(120);
    const after = left.getBoundingClientRect().width;
    check("dragging the gutter resizes the pane", Math.abs(after - before) > 40,
      before + " -> " + after);

    drag(20);   // hard left: the pane must keep its floor, not collapse
    await sleep(120);
    check("the pane cannot be dragged below its minimum",
      left.getBoundingClientRect().width >= 279,
      String(left.getBoundingClientRect().width));

    drag(window.innerWidth - 5);   // hard right: the log must stay usable
    await sleep(200);
    check("and the log keeps its own minimum width",
      $("logSplitRight").getBoundingClientRect().width >= 629,
      String($("logSplitRight").getBoundingClientRect().width));
    // The check that matters at the minimum, and the one a scrollWidth test on
    // <body> misses entirely: .log-shell is overflow:hidden, so a row that no
    // longer fits is CLIPPED rather than overflowing the page. A screenshot at
    // the old 600px floor showed BACKUP sliced in half while every page-level
    // width assertion still passed.
    const clipped = [".log-btn-bar", ".log-input-row"]
      .filter(sel => { const e = document.querySelector(sel);
        return e && e.scrollWidth > e.clientWidth + 1; });
    check("and nothing the operator OPERATES is clipped at that minimum",
      clipped.length === 0, clipped.join(" "));

    let stored = {};
    try { stored = JSON.parse(localStorage.getItem("wifilt-log-split") || "{}"); } catch (e) {}
    check("the width and the open state are remembered, in pixels",
      stored.open === true && typeof stored.leftPx === "number" && stored.leftPx >= 280,
      JSON.stringify(stored));

    // ---- 8b. resizing the WINDOW must not resize the pane ----------------
    // The pane is sized to fit the DXC columns the operator wants to read, and
    // those are a fixed number of characters wide. The log is the elastic
    // half. Storing a proportion got this exactly backwards.
    drag(400);
    await sleep(150);
    const paneChosen  = Math.round(left.getBoundingClientRect().width);
    const rightBefore = Math.round($("logSplitRight").getBoundingClientRect().width);
    // The container, not window.innerWidth: a headless window cannot be
    // resized from script, and .log-split is what the sizing code measures.
    const splitEl = $("logSplit");
    splitEl.style.width = (splitEl.getBoundingClientRect().width - 200) + "px";
    window.dispatchEvent(new Event("resize"));
    await sleep(150);
    check("narrowing the browser leaves the DXC pane exactly as wide",
      Math.round(left.getBoundingClientRect().width) === paneChosen,
      paneChosen + " -> " + Math.round(left.getBoundingClientRect().width));
    check("and the log absorbs the whole change",
      Math.abs(Math.round($("logSplitRight").getBoundingClientRect().width)
               - (rightBefore - 200)) <= 2,
      rightBefore + " -> " + Math.round($("logSplitRight").getBoundingClientRect().width));

    // Shrink past the point where the log can still give: the pane has to
    // yield, and then get its width back when there is room again.
    splitEl.style.width = (paneChosen + 6 + 500) + "px";
    window.dispatchEvent(new Event("resize"));
    await sleep(150);
    const squeezed = Math.round(left.getBoundingClientRect().width);
    check("a window too narrow for both makes the pane yield, not the log",
      squeezed < paneChosen && Math.round($("logSplitRight").getBoundingClientRect().width) >= 500,
      squeezed + " / right " + Math.round($("logSplitRight").getBoundingClientRect().width));
    splitEl.style.width = "";
    window.dispatchEvent(new Event("resize"));
    await sleep(150);
    check("and widening it again restores the width the operator chose",
      Math.round(left.getBoundingClientRect().width) === paneChosen,
      paneChosen + " -> " + Math.round(left.getBoundingClientRect().width));

    // ---- 9. the pane's settings are its own ------------------------------
    // Without a separate namespace two live instances are only two scroll
    // positions onto one setting, and each write fights the other.
    frame.contentWindow.localStorage.setItem("dxcEFreqFilter", JSON.stringify({"20m": false}));
    check("the pane stores its filters under its own prefix",
      !!localStorage.getItem("dxcEFreqFilter"));
    check("and leaves the external window's keys alone",
      localStorage.getItem("dxcFreqFilter") === null,
      String(localStorage.getItem("dxcFreqFilter")));

    // ---- 10. band map: the pane feeds it -------------------------------
    // Driven by a real cluster line, not a synthetic payload: the pane parses
    // it, renders it and publishes it through publishVisibleDxccSpots() on its
    // own. 14090 kHz is inside the 14000-14100 window the band map derives
    // from the radio's 14074000 Hz.
    const onMap = call => $("dxcBandSvg").textContent.indexOf(call) >= 0;
    await fetch("/ws-push?line=" + encodeURIComponent(
      "DX de OK9AAA:    14090.0  ZZ9ZZ        test                  1211Z"));
    await until(() => onMap("ZZ9ZZ"), 6000, "the pane's spot to reach the band map")
      .catch(() => {});
    check("the pane's own spots feed the band map",
      onMap("ZZ9ZZ"), $("dxcBandSvg").textContent.slice(0, 100));

    // ---- 11. two instances, one socket ------------------------------------
    // A second iframe stands in for the external DXC window: same origin, same
    // BroadcastChannel, its own instance -- and inspectable, which a pop-up in
    // headless Chrome is not.
    await fetch("/ws-stats/clear");
    const second = document.createElement("iframe");
    second.id = "smokeSecondDxc";
    second.src = "/dxc.html";
    second.style.cssText = "position:fixed;left:-9999px;width:600px;height:700px";
    document.body.appendChild(second);
    await until(() => second.contentDocument && second.contentDocument.getElementById("body"),
      8000, "the second instance to load");
    await sleep(1500);
    s = await stats();
    check("a second instance opens NO extra cluster socket",
      s.opens === 0 && s.live === 1, JSON.stringify(s));

    await fetch("/ws-push?line=" + encodeURIComponent(
      "DX de OK1AAA:     7015.0  VK3QQQ       up 2                  1215Z"));
    await until(() => second.contentDocument.querySelectorAll("#body tr").length > 0,
      6000, "the follower to receive the relayed feed").catch(() => {});
    check("the follower sees the relayed spots",
      second.contentDocument.querySelectorAll("#body tr").length > 0,
      String(second.contentDocument.querySelectorAll("#body tr").length));
    check("and it was seeded with the backlog from before it joined",
      /JA1ABC/.test(second.contentDocument.getElementById("body").textContent),
      second.contentDocument.getElementById("body").textContent.slice(0, 120));

    // ---- 12. the follower is not read-only -------------------------------
    const follower = second.contentDocument.getElementById("body").ownerDocument;
    follower.getElementById("cmd").value = "sh/dx 20";
    follower.getElementById("cmd").dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
    await until(async () => (await stats()).cmds.some(c => c === "sh/dx 20"), 4000,
      "the follower's command to reach the cluster").catch(() => {});
    check("a command typed in the follower reaches the cluster through the leader",
      (await stats()).cmds.indexOf("sh/dx 20") >= 0, JSON.stringify((await stats()).cmds));

    // ---- 12b. band map: an external window must NOT feed it -------------
    // Posted from the SECOND instance's realm, because BroadcastChannel never
    // delivers to the posting context -- a channel built in this document
    // could not reach log.js's listener in this same document (log.js:3231).
    const winCh = new second.contentWindow.BroadcastChannel("wifilt-dxc-spots");
    const winPayload = () => ({ts: Date.now(), src: "window", totalVisible: 1,
      spotsByPrefix: {}, spotsByPrefix30Min: {},
      spots: [{dx: "QQ0QQ", freq: 14060.0, time: "1220"}]});
    winCh.postMessage(winPayload());
    await sleep(600);
    check("an external window cannot feed the band map while the pane is open",
      !onMap("QQ0QQ"), $("dxcBandSvg").textContent.slice(0, 100));

    // ---- 13. losing the leader promotes the other ------------------------
    // The pane connected first, so the PANE is the leader -- removing the
    // second instance here would only retire a follower and prove nothing.
    // Closing the split is also how an operator really takes the leader away.
    // The wait is generous on purpose: pagehide makes this immediate, and the
    // 8 s watchdog is the backstop if a browser ever skips it. Either counts;
    // what must not happen is nobody picking the socket up.
    await fetch("/ws-stats/clear");
    $("tabDxc").click();
    await sleep(300);
    check("clicking DXC again closes the split", LogDxcSplit.isOpen() === false);
    check("and the iframe is gone, not merely hidden", !$("logDxcFrame"));
    await until(async () => (await stats()).live === 1, 11000,
      "the surviving instance to be promoted").catch(() => {});
    s = await stats();
    check("losing the leader promotes the surviving instance, without a storm",
      s.opens === 1 && s.live === 1, JSON.stringify(s));

    // ---- 13b. and the refusal above was real, not a dead channel --------
    // With the pane closed the very same payload on the very same channel has
    // to land. Without this, "it did not appear" would also pass if nothing
    // was ever delivered at all.
    winCh.postMessage(winPayload());
    await until(() => onMap("QQ0QQ"), 4000, "the external window to feed the band map")
      .catch(() => {});
    check("with the pane closed the external window feeds the band map again",
      onMap("QQ0QQ"), $("dxcBandSvg").textContent.slice(0, 100));
    winCh.close();

    // ---- 14. the last one out releases the socket ------------------------
    await fetch("/ws-stats/clear");
    second.remove();
    await sleep(800);
    check("with no instance left, nothing holds the cluster socket",
      (await stats()).live === 0, JSON.stringify(await stats()));

    // ---- 15. the spot backlog survives leaving the page -------------------
    // The operator's report: DXC open in the split, go somewhere else, come
    // back -- empty. log-dxc-split.js REMOVES the iframe on close and has to
    // (a hidden but live frame would keep holding the single cluster socket and
    // stay leader), so rows[] died with it; with no other instance alive there
    // was nobody to seed from either. The rows are now cached for 30 minutes,
    // aged on the spot's OWN UTC stamp rather than on when it arrived.
    //
    // Deliberately the LAST section, with every other instance already gone:
    // the leader/follower seed cannot be what puts the rows back, so only the
    // cache can be.
    //
    // Step 9 left {"20m": false} in the pane's own band filter. That never bit
    // the instance it was written into -- loadFreqFilter() had already run --
    // but a FRESH pane reads it at boot and would hide every spot below, which
    // would look exactly like a cache that did not work.
    localStorage.removeItem("dxcEFreqFilter");

    const hm = at => String(at.getUTCHours()).padStart(2, "0") +
                     String(at.getUTCMinutes()).padStart(2, "0");
    const ago = mins => hm(new Date(Date.now() - mins * 60000));
    const spotAt = (call, khz, at) =>
      "DX de OK2XYZ:    " + khz + "  " + call + "       cache test            " + at + "Z";

    $("tabDxc").click();
    await until(() => $("logDxcFrame") && $("logDxcFrame").contentDocument &&
      $("logDxcFrame").contentDocument.getElementById("body"), 8000,
      "the pane to come back for the cache pass");
    let pane = $("logDxcFrame").contentDocument;
    const paneText = () => pane.getElementById("body").textContent;
    // The document existing is not the same as the pane being on the cluster:
    // it still has to win an election and open the socket, and a line pushed
    // before that is simply lost.
    await until(async () => (await stats()).live === 1, 10000,
      "the returning pane to take the cluster socket");

    // CLEAR is also what forgets the cache, so this starts from a known-empty
    // one rather than from whatever the sections above left behind.
    pane.getElementById("clear").click();
    await sleep(150);

    await fetch("/ws-push?line=" + encodeURIComponent(spotAt("CACHE1", "14045.0", ago(1))));
    await fetch("/ws-push?line=" + encodeURIComponent(spotAt("CACHE2", "14055.0", ago(20))));
    await fetch("/ws-push?line=" + encodeURIComponent(spotAt("STALE9", "14065.0", ago(95))));
    await until(() => /STALE9/.test(paneText()), 6000,
      "all three cache-pass spots to render").catch(() => {});
    check("the cache pass starts with all three spots on screen",
      /CACHE1/.test(paneText()) && /CACHE2/.test(paneText()) && /STALE9/.test(paneText()),
      paneText().slice(0, 200));

    // ---- 15a. the zoom buttons move the COLUMNS, not just the type --------
    // Reported alongside the cache: shrinking the text left the columns at full
    // width and opened big gaps, enlarging it sawed the longer values off
    // behind the ellipsis. The table is table-layout:fixed and every cell
    // clips, so scaling the font on its own could only ever produce one of
    // those two. QRPLog's own journal hit this and was fixed the same way --
    // see .jcol-* and the --jzoom note in log.css.
    const cell = () => pane.querySelector("#body tr td.c-freq");
    const colW = () => cell().getBoundingClientRect().width;
    const fontPx = () => parseFloat(pane.defaultView.getComputedStyle(cell()).fontSize);
    const base = {w: colW(), f: fontPx()};
    pane.getElementById("zoomOut").click();
    await sleep(150);
    const small = {w: colW(), f: fontPx()};
    check("zooming out shrinks the column, not just the text",
      small.f < base.f && small.w < base.w, JSON.stringify({base, small}));
    pane.getElementById("zoomIn").click();
    pane.getElementById("zoomIn").click();
    await sleep(150);
    const big = {w: colW(), f: fontPx()};
    check("and zooming in widens it, so longer values still fit",
      big.f > base.f && big.w > base.w, JSON.stringify({base, big}));
    // The two must move by the SAME factor. Widths that merely moved in the
    // right direction would still drift out of step over the 0.6-2.5 range,
    // which is the whole complaint.
    check("the column tracks the type in proportion",
      Math.abs((big.w / base.w) - (big.f / base.f)) < 0.02,
      JSON.stringify({wRatio: big.w / base.w, fRatio: big.f / base.f}));
    pane.getElementById("zoomOut").click();   // back to 1.0 for everything below
    await sleep(150);

    // Closed well inside the 3 s write throttle on purpose: what is under test
    // here is the pagehide flush, not the timer that would have covered for it.
    $("tabDxc").click();
    await sleep(300);
    check("and the iframe went away again", !$("logDxcFrame"));

    $("tabDxc").click();
    await until(() => $("logDxcFrame") && $("logDxcFrame").contentDocument &&
      /CACHE1/.test($("logDxcFrame").contentDocument.getElementById("body").textContent),
      8000, "the cached spots to come back").catch(() => {});
    pane = $("logDxcFrame").contentDocument;
    check("spots come back after leaving the pane and returning",
      /CACHE1/.test(paneText()) && /CACHE2/.test(paneText()), paneText().slice(0, 200));
    check("a spot older than 30 minutes does not",
      !/STALE9/.test(paneText()), paneText().slice(0, 200));
    check("and the Raw view is rebuilt from the surviving rows",
      /CACHE1/.test(pane.getElementById("raw").textContent) &&
      !/STALE9/.test(pane.getElementById("raw").textContent),
      pane.getElementById("raw").textContent.slice(0, 200));

    // ---- 15b. CLEAR forgets the cache as well as the table ----------------
    // Without this the table would refill itself on the next visit and the
    // button would look broken.
    pane.getElementById("clear").click();
    await sleep(150);
    $("tabDxc").click();
    await sleep(300);
    $("tabDxc").click();
    await until(() => $("logDxcFrame") && $("logDxcFrame").contentDocument &&
      $("logDxcFrame").contentDocument.getElementById("body"), 8000,
      "the pane to come back after CLEAR");
    pane = $("logDxcFrame").contentDocument;
    await sleep(600);
    check("CLEAR forgets the cache, so nothing comes back", paneText() === "",
      paneText().slice(0, 200));

    // ---- 16. the bottom bar: one row unless asked --------------------------
    // Measured in a real browser before this was built: the bar stood 175px
    // tall at 720-800px of pane width, because above the 700px breakpoint it
    // did not wrap at all and .hint stacked its 68 characters into nine lines
    // -- and the split's default 0.42 fraction lands a 1920px screen at ~806px.
    // Two of the checks below cannot be read out of the source: that the arrow
    // keeps its rectangle across the toggle (it is last in the DOM so the bar,
    // which grows upward, always leaves it in the bottom-right corner), and
    // that the newest spot survives the reflow the opening causes.
    const paneWin = $("logDxcFrame").contentWindow;
    const bar     = pane.getElementById("bar");
    const toggle  = pane.getElementById("barToggle");

    // align-items:center puts items of unequal height on unequal offsetTops
    // inside ONE row, so anything within 6px counts as the same row.
    const barRows = () => {
      const tops = [];
      for (const el of bar.children) {
        if (el.offsetParent === null) continue;
        tops.push(Math.round(el.offsetTop + el.offsetHeight / 2));
      }
      tops.sort((a, b) => a - b);
      let n = 0, last = -99;
      for (const v of tops) if (v - last > 6) { n++; last = v; }
      return n;
    };
    const putAway = () => Array.prototype.filter.call(
      bar.querySelectorAll(".bar-more"), el => el.offsetParent === null).length;

    check("the pane's bar starts collapsed, on one row",
      bar.classList.contains("collapsed") && barRows() === 1,
      barRows() + " row(s), " + Math.round(bar.getBoundingClientRect().height) + "px");
    check("nine controls are put away and the status row is not",
      putAway() === 9 && pane.getElementById("cmd").offsetParent !== null
      && pane.getElementById("ws").offsetParent !== null
      && pane.getElementById("cnt").offsetParent !== null,
      putAway() + " hidden");

    const arrowShut = toggle.getBoundingClientRect();
    toggle.click();
    await sleep(120);
    check("the arrow opens it and everything comes back",
      !bar.classList.contains("collapsed") && putAway() === 0 && barRows() > 1,
      putAway() + " hidden, " + barRows() + " row(s)");
    const arrowOpen = toggle.getBoundingClientRect();
    check("and the arrow itself stays put",
      Math.abs(arrowOpen.right - arrowShut.right) <= 1
      && Math.abs(arrowOpen.bottom - arrowShut.bottom) <= 2,
      Math.round(arrowShut.right) + "," + Math.round(arrowShut.bottom) + " -> "
      + Math.round(arrowOpen.right) + "," + Math.round(arrowOpen.bottom));
    check("the open state is stored under the pane's own prefix",
      paneWin.localStorage.getItem("dxcEBarOpen") === "1"
      && paneWin.localStorage.getItem("dxcBarOpen") === null,
      String(paneWin.localStorage.getItem("dxcEBarOpen")));

    // The Columns panel used to sit at a hardcoded bottom:76px, which matched
    // one particular wrapped bar and nothing else.
    pane.getElementById("colbtn").click();
    await sleep(80);
    const colsBottom = parseInt(pane.getElementById("cols").style.bottom, 10);
    check("the Columns panel anchors above the bar's real height",
      Math.abs(colsBottom - (bar.offsetHeight + 6)) <= 1,
      colsBottom + " vs bar " + bar.offsetHeight);

    // ---- 16b. opening the bar must not push the newest spot out of sight ---
    // The bar reflows rather than overlays, so .wrap loses height while
    // keeping its scrollTop. scrollOutputsToBottom() cannot cover this on its
    // own: it opens with if(!autoScroll)return, and the operator who froze the
    // list is exactly the one parked at its end. So auto-scroll is turned OFF
    // here on purpose -- with it on, the check would pass either way.
    const bulk = [];
    for (let i = 0; i < 80; i++) {
      bulk.push("DX de OK1AAA:    14025.0  T" + (100 + i)
        + "ABC       filler                1220Z");
    }
    await fetch("/ws-push?line=" + encodeURIComponent(bulk.join("\\n")));
    await until(() => pane.querySelectorAll("#body tr").length > 60, 6000,
      "the filler spots to render").catch(() => {});

    pane.getElementById("scrollToggle").click();   // auto-scroll OFF
    await sleep(80);
    check("with auto-scroll off the always-visible counter says so",
      pane.getElementById("cnt").classList.contains("scroll-off"),
      pane.getElementById("cnt").className);

    toggle.click();                                 // collapse
    await sleep(120);
    const wrapEl = pane.querySelector(".wrap");
    wrapEl.scrollTop = wrapEl.scrollHeight;
    await sleep(60);
    const scrollable = wrapEl.scrollHeight > wrapEl.clientHeight + 10;
    const rowsNow    = pane.querySelectorAll("#body tr");
    const lastRow    = rowsNow[rowsNow.length - 1];
    toggle.click();                                 // and open it again
    await sleep(120);
    check("opening the bar keeps the newest spot visible",
      scrollable && !!lastRow
      && lastRow.getBoundingClientRect().bottom
         <= wrapEl.getBoundingClientRect().bottom + 1,
      (scrollable ? "" : "NOT SCROLLABLE ") + (lastRow
        ? Math.round(lastRow.getBoundingClientRect().bottom) + " vs wrap "
          + Math.round(wrapEl.getBoundingClientRect().bottom) : "no rows"));
    pane.getElementById("scrollToggle").click();    // auto-scroll back on
  } catch (error) {
    check("the test script ran to the end", false, String(error && error.stack || error));
  }

  await report(false);
})();
`;

// ── Run ──────────────────────────────────────────────────────────────────────

function launchChrome(w, h) {
  // 127.0.0.1, not a .test host: the log keeps QSOs in IndexedDB and asks
  // about storage persistence, which needs a secure context.
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", `--window-size=${w},${h}`,
    `http://127.0.0.1:${port}/log.html`,
  ], {stdio: ["ignore", "ignore", "pipe"]});
  let chromeErrors = "";
  chrome.stderr.on("data", chunk => { chromeErrors += chunk; });
  chrome.on("error", error => finish({checks: [["chrome started", false, error.message]], hard: true}));
  chrome.on("close", code => {
    if (!finished && chrome) finish({checks: [["chrome stayed up", false,
      `exit ${code} ${chromeErrors.slice(-400)}`]], hard: true});
  });
}

server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  launchChrome(1280, 900);
  timer = setTimeout(() => finish({checks: [["the page reported within the timeout", false,
    "no /result was posted"]], hard: true}), 120000);
});

process.on("SIGINT",  () => finish({checks: [["interrupted", false, "SIGINT"]], hard: true}));
process.on("SIGTERM", () => finish({checks: [["interrupted", false, "SIGTERM"]], hard: true}));

// The fixture appends the test script to log.html on the way out, and points
// dxc.html's WebSocket at this fixture instead of the device's port 82. Both
// pages are otherwise byte-identical to production.
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file !== "string") return content;
  if (file.endsWith("log.html"))
    return Buffer.concat([content, Buffer.from(`\n<script>${PAGE_SCRIPT}</script>\n`)]);
  if (file.endsWith("dxc.html"))
    return Buffer.from(content.toString("utf8").replace('+":82"+', `+":${port}"+`), "utf8");
  return content;
};
