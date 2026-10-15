#!/usr/bin/env node
"use strict";

// The Spotter column's continent filter, driven in a real browser.
//
// Like the Mode filter it DISCARDS spots at the door instead of hiding rows, so
// what a unit test could not see is the part that matters:
//
//   * All three doors -- addLine(), historyLoad() and the leader's seed. Miss one
//     and the refused spots walk straight back in.
//   * The policy is shared. The window and QRPlog's embedded pane run as two
//     documents on one BroadcastChannel, so this hosts both in iframes and
//     checks a tick in one reaches the other.
//   * The column arms it. Hidden Spotter column = nothing discarded, in BOTH
//     instances, because the embedded pane is often narrower than the 700px at
//     which CSS hides the column and has to obey the wider one.

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

let port = 0, chrome = null, cdp = null, cdpSeq = 0, timer = null, finished = false;
const cdpWaiting = new Map();
let wsConns = [];
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
const spotLine = (spotter, khz, call) =>
  ("DX de " + spotter + ":").padEnd(18) + khz.toFixed(1).padStart(8) + "  " + call.padEnd(13)
  + "CW    20 dB  25 WPM  CQ      " + hmUtc(new Date()) + "Z";

// ── Fixture ──────────────────────────────────────────────────────────────────

const HOST = "<!doctype html><meta charset=utf-8><body style='margin:0'>"
  + "<iframe id=win src='/dxc.html' style='width:1200px;height:400px;border:0'></iframe>"
  + "<iframe id=emb src='/dxc.html?embed=1' style='width:1200px;height:400px;border:0'></iframe>";

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  const json = body => {
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/two.html") { response.writeHead(200, {"Content-Type": "text/html"}); return response.end(HOST); }
  // The firmware generates /ports.js; the page takes the cluster relay's port
  // from it, so this is what points the WebSocket at the fixture.
  if (url.pathname === "/ports.js") {
    response.writeHead(200, {"Content-Type": "application/javascript"});
    return response.end(`window.WIFILT_PORTS={"http":${port},"dxc":${port}};`);
  }
  if (url.pathname === "/dxcinfo") return json({locator: "JO70UC", callsign: "OK1HRA", trx2netid: 0, trx3netid: 0});
  if (url.pathname === "/log-db.json" || url.pathname === "/state") return json({});

  const file = path.join(data, path.basename(url.pathname));
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const body = fs.readFileSync(file);
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
  wsConns.push(socket);
  socket.on("error", () => {});
  try { socket.write(wsEncode(JSON.stringify({telnet: true}))); } catch (_) {}
  socket.on("close", () => { wsConns = wsConns.filter(c => c !== socket); });
  socket.on("data", () => {});
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

// Everything goes through what the operator has: the cluster feed, the menu,
// the Columns box and the rendered table. The page's script is one closure, so
// there is nothing else to reach -- which keeps this honest.
const D = id => `document.getElementById(${JSON.stringify(id)}).contentDocument`;
const W = "win", E = "emb";
const label = id => evaluate(`${D(id)}.getElementById('spotterFilterBtn').textContent`);
const active = id => evaluate(`${D(id)}.getElementById('spotterFilterBtn').classList.contains('active')`);
const title = id => evaluate(`${D(id)}.getElementById('spotterFilterBtn').title`);
const conts = id => evaluate(`Array.from(${D(id)}.querySelectorAll('#spotterMenu input[data-spotter-filter]:checked')).map(i => i.getAttribute('data-spotter-filter')).join(',')`);
const menuClick = (id, sel) => evaluate(`(() => { const d = ${D(id)}, m = d.getElementById('spotterMenu');
  if (!m.classList.contains('on')) d.getElementById('spotterFilterBtn').click();
  m.querySelector(${JSON.stringify(sel)}).click();
  return m.classList.contains('on'); })()`);
const menuClose = id => evaluate(`(${D(id)}.body.click(), true)`);
const shown = (id, call) => evaluate(`!!${D(id)}.querySelector('#body tr[data-dx=${JSON.stringify(call)}]')`);
const wsText = id => evaluate(`${D(id)}.getElementById('ws').textContent`);
const colsClick = (id, c) => evaluate(`(${D(id)}.querySelector('#cols input[data-x=${JSON.stringify(c)}]').click(), true)`);

async function bothReady() {
  await until(`(() => { for (const id of ['win', 'emb']) { const f = document.getElementById(id);
      if (!f || !f.contentDocument || f.contentDocument.readyState !== 'complete'
        || !f.contentDocument.querySelector('#spotterMenu input')) return false; }
    return true; })()`, 10000, "both instances to load");
  // One leader on the socket, one follower relayed through it.
  await until(`(() => { const a = ${D(W)}.getElementById('ws').textContent, b = ${D(E)}.getElementById('ws').textContent;
    return (a === 'WS↗') !== (b === 'WS↗') && (a === 'WS on' || b === 'WS on' || /WS/.test(a + b)); })()`,
    12000, "a leader and a follower");
  for (let i = 0; i < 100 && !wsConns.length; i++) await sleep(50);
  await until(`/\\(EU\\)/.test(${D(W)}.querySelector('#spotterMenu [data-spotter-action=mine]').textContent)`, 5000, "/dxcinfo");
}
const roles = async () => (await wsText(W)) === "WS↗" ? {leader: W, follower: E} : {leader: E, follower: W};

async function run() {
  await send("Page.navigate", {url: `http://127.0.0.1:${port}/two.html`});
  await until("document.readyState === 'complete'", 10000, "host");
  // A clean slate: the profile is fresh, but be sure.
  await evaluate("(localStorage.clear(), true)");
  await send("Page.reload");
  await bothReady();

  // 1. Idle.
  check("idle: button reads Spotter, not active", (await label(W)) === "Spotter" && !(await active(W)), await label(W));
  check("idle: all seven boxes ticked", (await conts(W)) === "EU,AF,AS,NA,SA,OC,OTHER", await conts(W));

  // 2. Keep EU, OC and other/unknown -- ticked one by one, the menu stays open.
  let open = true;
  for (const c of ["NA", "AS", "SA", "AF"]) open = (await menuClick(W, `input[data-spotter-filter="${c}"]`)) && open;
  await menuClose(W);
  check("menu: stays open across several ticks", open, "");
  check("label: three kept reads 'Spotter 3', active", (await label(W)) === "Spotter 3" && await active(W), await label(W));
  await until(`${D(E)}.getElementById('spotterFilterBtn').textContent === 'Spotter 3'`, 3000, "the pane to adopt").catch(() => {});
  check("shared: the pane adopted the window's choice", (await conts(E)) === "EU,OC,OTHER", await conts(E));

  // 3. Door 1, live feed: one spot per skimmer continent.
  const feed = [["DK8NE-#", "A1EU", true], ["OK1HRA-2", "A2EU", true], ["VK3ABC", "A3OC", true],
                ["QQ1ABC-#", "A4UNK", true], ["KC4AAA", "A5AN", true], ["W3LPL-2", "A6NA", false],
                ["JA1XYZ", "A7AS", false], ["PY2AA-#", "A8SA", false], ["ZS6ABC", "A9AF", false],
                ["G4ABC", "A0EU", true]];
  feed.forEach(([sp, call], i) => clusterPush(spotLine(sp, 14010 + i, call)));
  for (const id of [W, E]) await until(`!!${D(id)}.querySelector('#body tr[data-dx="A0EU"]')`, 5000, "the feed in " + id);
  for (const id of [W, E]) {
    const got = [];
    for (const [, call, want] of feed) if ((await shown(id, call)) !== want) got.push(call);
    check(`feed (${id}): EU/OC/unknown/AN kept, NA/AS/SA/AF discarded, SSIDs stripped`, !got.length, "wrong: " + got.join(" "));
  }
  check("button title counts the four discarded", /\(4 discarded since Clear\)/.test(await title(W)), await title(W));

  // 4. Not retroactive: admitted under All on, kept after Only mine.
  await menuClick(W, 'button[data-spotter-action="all"]');
  check("All on: all ticked, idle label", (await conts(W)) === "EU,AF,AS,NA,SA,OC,OTHER"
    && (await label(W)) === "Spotter" && !(await active(W)), await label(W));
  clusterPush(spotLine("W3LPL-2", 14100, "B1NA"));
  clusterPush(spotLine("DK8NE-#", 14101, "B1EU"));
  for (const id of [W, E]) await until(`!!${D(id)}.querySelector('#body tr[data-dx="B1EU"]')`, 5000, "B1EU in " + id);
  await menuClick(E, 'button[data-spotter-action="mine"]');
  await menuClose(W); await menuClose(E);
  await sleep(200);
  check("Only mine: OK1HRA keeps EU alone, in both", (await conts(W)) === "EU" && (await conts(E)) === "EU", (await conts(W)) + " / " + (await conts(E)));
  check("label: one continent reads 'EU'", (await label(W)) === "EU" && (await label(E)) === "EU", await label(W));
  check("not retroactive: the NA spot admitted earlier stays", await shown(W, "B1NA") && await shown(E, "B1NA"), "");

  // 5. Door 2: a reload restores the shared history through the filter. Wait
  //    out the save throttle so the backlog really holds B1NA.
  await sleep(3500);
  const histHas = await evaluate(`/B1NA/.test(localStorage.getItem('wifilt-dxc-history') || '')`);
  await send("Page.reload");
  await bothReady();
  let r = await roles();
  check("history: the backlog held the NA spot before the reload", histHas, "");
  check("history: the leader restored EU, refused NA", await shown(r.leader, "B1EU") && !(await shown(r.leader, "B1NA")), "leader " + r.leader);
  check("history: the follower too", await shown(r.follower, "B1EU") && !(await shown(r.follower, "B1NA")), "");

  // 6. Door 3: the leader's seed. Make the leader hold an NA row again (admit
  //    under All on, then narrow), then bring the follower back with NO
  //    history, so the seed is the only way anything reaches it.
  await menuClick(r.leader, 'button[data-spotter-action="all"]');
  clusterPush(spotLine("N2IC-#", 21025, "C1NA"));
  clusterPush(spotLine("G4ABC", 21026, "C1EU"));
  await until(`!!${D(r.leader)}.querySelector('#body tr[data-dx="C1NA"]')`, 5000, "C1NA in the leader");
  await menuClick(r.leader, 'button[data-spotter-action="mine"]');
  await menuClose(r.leader);
  await sleep(3500);
  const src = await evaluate(`document.getElementById(${JSON.stringify(r.follower)}).getAttribute('src')`);
  await evaluate(`(document.getElementById(${JSON.stringify(r.follower)}).src = 'about:blank', true)`);
  await sleep(500);
  await evaluate(`(localStorage.removeItem('wifilt-dxc-history'), document.getElementById(${JSON.stringify(r.follower)}).src = ${JSON.stringify(src)}, true)`);
  await until(`(() => { const d = ${D(r.follower)}; return d && d.readyState === 'complete'
    && d.getElementById('ws') && d.getElementById('ws').textContent === 'WS↗'
    && !!d.querySelector('#body tr[data-dx="C1EU"]'); })()`, 12000, "the follower to be seeded");
  check("seed: the leader still shows C1NA (not retroactive)", await shown(r.leader, "C1NA"), "");
  check("seed: the follower got C1EU but refused C1NA", await shown(r.follower, "C1EU") && !(await shown(r.follower, "C1NA")), "");

  // 7. Unticking the last box admits everything instead of nothing.
  await menuClick(W, 'input[data-spotter-filter="EU"]');
  await menuClose(W);
  check("empty selection resets to all", (await conts(W)) === "EU,AF,AS,NA,SA,OC,OTHER" && (await label(W)) === "Spotter", await conts(W));

  // 8. Labels for two continents.
  await menuClick(W, 'button[data-spotter-action="mine"]');
  await menuClick(W, 'input[data-spotter-filter="NA"]');
  check("label: two continents read 'EU NA'", (await label(W)) === "EU NA", await label(W));
  await menuClick(W, 'input[data-spotter-filter="NA"]');
  await menuClose(W);

  // 9. Hiding the Spotter column disarms it -- in BOTH instances.
  await colsClick(W, "spotter");
  await until(`!${D(E)}.querySelector('#cols input[data-x="spotter"]').checked`, 3000, "the pane to hide the column").catch(() => {});
  check("column hidden: the pane follows", !(await evaluate(`${D(E)}.querySelector('#cols input[data-x="spotter"]').checked`)), "");
  clusterPush(spotLine("W3LPL-2", 14200, "D1NA"));
  for (const id of [W, E]) await until(`!!${D(id)}.querySelector('#body tr[data-dx="D1NA"]')`, 4000, "D1NA in " + id).catch(() => {});
  check("column hidden: an NA spot is admitted while EU-only", await shown(W, "D1NA") && await shown(E, "D1NA"), "");
  check("column hidden: button idle, title says nothing is discarded",
    !(await active(E)) && /nothing is being discarded/.test(await title(E)), await title(E));
  const stored = await evaluate(`(() => { const p = JSON.parse(localStorage.getItem('wifilt-dxc-policy') || '{}');
    const a = JSON.parse(localStorage.getItem('dxcCols') || '{}'), b = JSON.parse(localStorage.getItem('dxcECols') || '{}');
    return p.spotter && p.spotter.on === false && !('spotter' in a) && !('spotter' in b); })()`);
  check("column hidden: the flag rides the shared policy, not the per-instance Cols blob", stored, "");
  await colsClick(W, "spotter");
  await sleep(300);
  check("column shown again: re-armed with EU kept", (await label(E)) === "EU" && await active(E), await label(E));

  // 10. One global key: a reload keeps it.
  await send("Page.reload");
  await bothReady();
  check("reload: the policy survives", (await conts(E)) === "EU" && (await label(E)) === "EU", await conts(E));
  await evaluate("(localStorage.clear(), true)");
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
  console.log(`DXC SPOTTER CONTINENT ${failed ? "FAIL" : "PASS"} ${checks.length - failed}/${checks.length}`);
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 2500).unref();
}

server.listen(0, "127.0.0.1", async () => {
  port = server.address().port;
  timer = setTimeout(() => finish(new Error("timed out")), 60000);
  try {
    await connect(await launchChrome());
    await run();
    finish();
  } catch (error) {
    finish(error);
  }
});
