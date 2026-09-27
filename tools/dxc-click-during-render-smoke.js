#!/usr/bin/env node
"use strict";

// A click on a DX spot has to tune the radio on the FIRST try, even while
// spots are pouring in.
//
// Found on air 2026-09-27: clicking a spot's frequency in the DXC table often
// did nothing, and the operator clicked two or three times. The table is
// rebuilt whole (tbody.innerHTML) on every spot, and with RBN feeding several a
// second a rebuild regularly fell between the button going down and coming up.
// A click is a press and a release on the SAME element; with the element gone,
// the browser sends it to their common ancestor, tbody, which is not a
// .freq-link -- nothing tuned. QRPLog's band map clears and redraws its
// markers the same way and had the same hole.
//
// Why a harness of its own, driving the mouse through the DevTools protocol:
// synthetic events cannot show this. dispatchEvent("click") on the link goes
// to the link whatever the DOM did in between; only real input lets the browser
// decide where the click lands. So node holds the mouse button down, pushes a
// spot while it is down, and lets go.

const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const {spawn} = require("child_process");

// Node 20 has a WebSocket client only behind a flag. Re-run under it rather
// than pull in a package for one connection.
if (typeof WebSocket === "undefined") {
  const child = spawn(process.execPath, ["--experimental-websocket", "--no-warnings", __filename,
    ...process.argv.slice(2)], {stdio: "inherit"});
  child.on("exit", code => process.exit(code == null ? 1 : code));
  return;
}

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript",
              ".json": "application/json"};
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MINIFIED = process.env.DXC_CLICK_SMOKE_MINIFIED === "1";

let port = 0, chrome = null, cdp = null, cdpSeq = 0, timer = null, finished = false;
const cdpWaiting = new Map();
let wsConns = [];
const cmds = [];
const checks = [];
const check = (name, ok, detail) => checks.push([name, !!ok, detail]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wsEncode(text) {
  const payload = Buffer.from(text, "utf8");
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}
function clusterPush(line) {
  for (const s of wsConns) { try { s.write(wsEncode(line + "\n")); } catch (_) {} }
}

const hmUtc = at => String(at.getUTCHours()).padStart(2, "0") + String(at.getUTCMinutes()).padStart(2, "0");
const spotLine = (khz, call) =>
  "DX de OK2XYZ:    " + khz.toFixed(1) + "  " + call.padEnd(13) + "CQ                    " + hmUtc(new Date()) + "Z";

// ── Fixture ──────────────────────────────────────────────────────────────────

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

  if (url.pathname === "/state") return json({
    connected: true, catHealthy: true, audioReady: true, lanStatus: "linked",
    btStatus: "LAN linked", wifiStatus: "WiFi STA", radioTransport: "lan",
    fullCat: true, wifiRssi: -55, fwRev: "20260927", bdSupported: false,
    power: true, frequency: 14074000, mode: "CW", filter: 1,
    radioAddress: "a4", transceiverType: "IC-705", radioName: "IC-705",
    tx: false, ritRaw: 0, smeterRaw: 0, powerMeterRaw: 0, afGain: 100,
    keySpeed: 20, rfPower: 128, rfPowerSeen: true, supplyVolts: 13.8, swr: 1.1,
    preamp: 0, vox: 0, dxcConnected: true,
  });
  if (url.pathname === "/cmd" && request.method === "POST")
    return readBody(body => { try { cmds.push(JSON.parse(body)); } catch (_) {} json({ok: true}); });
  if (url.pathname === "/oi3/state") return json({connected: false, frequency: 0, mode: "USB", dxcConnected: true});
  if (url.pathname === "/js8/session") return json({held: false, role: ""});
  if (url.pathname === "/dxcinfo") return json({locator: "JO70UC", callsign: "OK1HRA", trx2netid: 0, trx3netid: 0});
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70UC"});
  if (url.pathname === "/log-config") return json({
    trx1Label: "TRX1", trx2Label: "TRX2", trx3Label: "TRX3",
    trx2enabled: false, trx3enabled: false, blockedDxcc: "",
  });
  if (url.pathname === "/log-macros.json") return json({});
  if (url.pathname === "/pa.json") return json({state: "ok", present: false});
  if (url.pathname === "/setup-data.json") return json({trx1transport: "lan"});

  let file = url.pathname === "/" ? path.join(data, "log.html") : path.join(data, path.basename(url.pathname));
  if (MINIFIED && file.endsWith(".js") && fs.existsSync(file + ".min")) file = file + ".min";
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    let body = fs.readFileSync(file);
    // dxc.html talks to the device's port 82; point it at this fixture.
    if (file.endsWith("dxc.html")) body = Buffer.from(body.toString("utf8").replace('+":82"+', `+":${port}"+`), "utf8");
    response.writeHead(200, {"Content-Type": mime[path.extname(file)] || "text/plain"});
    return response.end(body);
  }
  response.writeHead(404).end("not found");
});

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url, "http://fixture");
  if (url.pathname !== "/dxcws") { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(request.headers["sec-websocket-key"] + WS_GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
    + "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  for (const old of wsConns.splice(0)) { try { old.destroy(); } catch (_) {} }
  wsConns.push(socket);
  socket.on("error", () => {});
  socket.on("close", () => { wsConns = wsConns.filter(c => c !== socket); });
  socket.on("data", () => {});
  try { socket.write(wsEncode(JSON.stringify({telnet: true}))); } catch (_) {}
});

// ── DevTools protocol ────────────────────────────────────────────────────────

function send(method, params) {
  const id = ++cdpSeq;
  cdp.send(JSON.stringify({id, method, params: params || {}}));
  return new Promise((resolve, reject) => cdpWaiting.set(id, {resolve, reject}));
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception || {}));
  return r.result.value;
}

async function until(expression, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await evaluate(expression); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + label);
    await sleep(50);
  }
}

const mouse = (type, x, y) => send("Input.dispatchMouseEvent",
  {type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1});

async function navigate(url) {
  await send("Page.navigate", {url});
  await until("document.readyState === 'complete'", 10000, "the page to load");
}

function launchChrome() {
  return new Promise((resolve, reject) => {
    chrome = spawn("google-chrome", [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--no-proxy-server", "--window-size=1280,900", "--remote-debugging-port=0",
      "about:blank",
    ], {stdio: ["ignore", "ignore", "pipe"]});
    let err = "";
    chrome.stderr.on("data", chunk => {
      err += chunk;
      const m = err.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) resolve(Number(m[1]));
    });
    chrome.on("error", reject);
    chrome.on("close", code => { if (!finished) reject(new Error("chrome exited " + code + " " + err.slice(-300))); });
  });
}

async function connect(devtoolsPort) {
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    const list = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${devtoolsPort}/json/list`, res => {
        let b = ""; res.on("data", c => b += c); res.on("end", () => resolve(JSON.parse(b)));
      }).on("error", reject);
    });
    target = list.find(t => t.type === "page");
    if (!target) await sleep(100);
  }
  cdp = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { cdp.onopen = resolve; cdp.onerror = reject; });
  cdp.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !cdpWaiting.has(msg.id)) return;
    const w = cdpWaiting.get(msg.id);
    cdpWaiting.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result);
  };
  await send("Page.enable");
  await send("Runtime.enable");
}

// ── The checks ───────────────────────────────────────────────────────────────

async function tableSection() {
  await navigate(`http://127.0.0.1:${port}/dxc.html`);
  await until("true", 100, "");
  for (let i = 0; i < 100 && !wsConns.length; i++) await sleep(50);
  clusterPush(spotLine(14074.0, "JA1ABC"));
  await until("!!document.querySelector('#body tr[data-dx=\"JA1ABC\"] .freq-link')", 6000, "the first spot to render");

  const pt = await evaluate(`(() => {
    const r = document.querySelector('#body tr[data-dx="JA1ABC"] .freq-link').getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  })()`);
  cmds.length = 0;
  await mouse("mouseMoved", pt.x, pt.y);
  await mouse("mousePressed", pt.x, pt.y);
  // A spot while the button is down -- the render that used to take the
  // pressed link away.
  clusterPush(spotLine(14080.0, "ZZ9ZZ"));
  await sleep(400);
  const heldMidPress = await evaluate("!document.querySelector('#body tr[data-dx=\"ZZ9ZZ\"]')");
  await mouse("mouseReleased", pt.x, pt.y);
  await sleep(300);

  const tuned = cmds.filter(c => c.type === "setFrequency").map(c => c.frequency);
  check("DXC table: a spot arriving mid-click does not swallow the click",
    tuned.length === 1 && Number(tuned[0]) === 14074000, JSON.stringify(tuned));
  check("DXC table: the redraw waited while the button was down", heldMidPress, "");
  const late = await until("!!document.querySelector('#body tr[data-dx=\"ZZ9ZZ\"]')", 2000, "the held spot")
    .catch(() => false);
  check("DXC table: ...and the held spot shows right after the click", late, "");

  // An ordinary click, with nothing arriving, still tunes -- and still only once.
  cmds.length = 0;
  const pt2 = await evaluate(`(() => {
    const r = document.querySelector('#body tr[data-dx="ZZ9ZZ"] .freq-link').getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  })()`);
  await mouse("mouseMoved", pt2.x, pt2.y);
  await mouse("mousePressed", pt2.x, pt2.y);
  await mouse("mouseReleased", pt2.x, pt2.y);
  await sleep(300);
  const tuned2 = cmds.filter(c => c.type === "setFrequency").map(c => c.frequency);
  check("DXC table: a quiet click tunes once",
    tuned2.length === 1 && Number(tuned2[0]) === 14080000, JSON.stringify(tuned2));

  // Only the two clickable fields hold the feed (operator, 2026-09-27). A press
  // on the call holds it; the release is made elsewhere so no search window
  // opens -- a click needs press and release on the same element.
  const at = sel => evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  })()`);
  const callPt = await at('#body tr[data-dx="JA1ABC"] .dx-link');
  const offPt  = await at('#body tr[data-dx="JA1ABC"] .c-spotter');
  await mouse("mouseMoved", callPt.x, callPt.y);
  await mouse("mousePressed", callPt.x, callPt.y);
  clusterPush(spotLine(14085.0, "YY8YY"));
  await sleep(400);
  const heldOnCall = await evaluate("!document.querySelector('#body tr[data-dx=\"YY8YY\"]')");
  await mouse("mouseMoved", offPt.x, offPt.y);
  await mouse("mouseReleased", offPt.x, offPt.y);
  check("DXC table: a press on the call holds the redraw too", heldOnCall, "");
  await until("!!document.querySelector('#body tr[data-dx=\"YY8YY\"]')", 2000, "the spot held by the call press")
    .catch(() => {});

  // Anywhere else in the row the feed keeps flowing under the pressed button.
  const plainPt = await at('#body tr[data-dx="JA1ABC"] .c-spotter');
  await mouse("mouseMoved", plainPt.x, plainPt.y);
  await mouse("mousePressed", plainPt.x, plainPt.y);
  clusterPush(spotLine(14088.0, "XX7XX"));
  const flowed = await until("!!document.querySelector('#body tr[data-dx=\"XX7XX\"]')", 1200, "the spot")
    .catch(() => false);
  await mouse("mouseReleased", plainPt.x, plainPt.y);
  check("DXC table: a press elsewhere in the row does not hold the redraw", flowed, "");
}

async function bandMapSection() {
  await navigate(`http://127.0.0.1:${port}/log.html`);
  await until("document.getElementById('dxcBandBox').classList.contains('dxc-active')", 8000, "the band map to activate");
  const feed = spots => evaluate(`(() => {
    const ch = new BroadcastChannel('wifilt-dxc-spots');
    ch.postMessage({ts: Date.now(), src: 'embed', spots: ${JSON.stringify(spots)}});
    ch.close();
    return true;
  })()`);
  const t = hmUtc(new Date()) + "Z";
  await feed([{dx: "JA1ABC", freq: "14074.0", type: "CQ", time: t}]);
  await until("!!document.querySelector('#dxcBandSvg g[data-call=\"JA1ABC\"]')", 4000, "the marker");

  const pt = await evaluate(`(() => {
    const r = document.querySelector('#dxcBandSvg g[data-call="JA1ABC"]').getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  })()`);
  await evaluate("inpCall.value = ''; true");
  cmds.length = 0;
  await mouse("mouseMoved", pt.x, pt.y);
  await mouse("mousePressed", pt.x, pt.y);
  await feed([{dx: "JA1ABC", freq: "14074.0", type: "CQ", time: t},
              {dx: "ZZ9ZZ",  freq: "14090.0", type: "CQ", time: t}]);
  await sleep(400);
  const heldMidPress = await evaluate("!document.querySelector('#dxcBandSvg g[data-call=\"ZZ9ZZ\"]')");
  await mouse("mouseReleased", pt.x, pt.y);
  await sleep(300);

  const tuned = cmds.filter(c => c.type === "setFrequency").map(c => c.frequency);
  check("band map: a spot update mid-click does not swallow the click",
    tuned.length === 1 && Number(tuned[0]) === 14074000, JSON.stringify(tuned));
  const call = await evaluate("inpCall.value");
  check("band map: ...and the call lands in Call", call === "JA1ABC", call);
  check("band map: the redraw waited while the button was down", heldMidPress, "");
  const late = await until("!!document.querySelector('#dxcBandSvg g[data-call=\"ZZ9ZZ\"]')", 2000, "the held marker")
    .catch(() => false);
  check("band map: ...and the held marker shows right after the click", late, "");

  // A press on the empty map, off every marker, holds nothing.
  const box = await evaluate(`(() => {
    const r = document.getElementById('dxcBandSvg').getBoundingClientRect();
    return {x: r.left + 3, y: r.top + 3};
  })()`);
  const onEmpty = await evaluate(`(() => {
    const el = document.elementFromPoint(${box.x}, ${box.y});
    return !!el && !el.closest('g[data-call]');
  })()`);
  await mouse("mouseMoved", box.x, box.y);
  await mouse("mousePressed", box.x, box.y);
  await feed([{dx: "JA1ABC", freq: "14074.0", type: "CQ", time: t},
              {dx: "ZZ9ZZ",  freq: "14090.0", type: "CQ", time: t},
              {dx: "YY8YY",  freq: "14060.0", type: "CQ", time: t}]);
  const flowed = await until("!!document.querySelector('#dxcBandSvg g[data-call=\"YY8YY\"]')", 1200, "the marker")
    .catch(() => false);
  await mouse("mouseReleased", box.x, box.y);
  check("band map: a press off the markers does not hold the redraw", onEmpty && flowed,
    "empty spot under the pointer: " + onEmpty);
}

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (error) check("the harness ran to the end", false, String(error && error.stack || error));
  try { if (cdp) cdp.close(); } catch (_) {}
  if (chrome) {
    const dying = chrome;
    dying.kill("SIGTERM");
    // A killed driver once left headless Chrome children alive, keying a real
    // radio for ten minutes. Never trust SIGTERM alone.
    setTimeout(() => {
      try { dying.kill("SIGKILL"); } catch (_) {}
    }, 2000).unref();
  }
  server.close();
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
  }
  console.log(`DXC CLICK DURING RENDER ${failed ? "FAIL" : "PASS"} ${checks.length - failed}/${checks.length}`);
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 2500).unref();
}

server.listen(0, "127.0.0.1", async () => {
  port = server.address().port;
  timer = setTimeout(() => finish(new Error("timed out")), 60000);
  try {
    await connect(await launchChrome());
    await tableSection();
    await bandMapSection();
    finish();
  } catch (error) {
    finish(error);
  }
});
