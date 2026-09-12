#!/usr/bin/env node
"use strict";

// The DX spot feed from dxc.html to an IP-rotator's map, driven in a real browser.
//
// WHY THIS EXISTS. The rotator's map used to open its own WebSocket on the
// firmware's port 82. That relay holds exactly ONE client (wifilt.ino:664) and a
// second upgrade evicts the first while forcing a fresh cluster login, so the map
// and the operator's own DXC window evicted each other. Growing the relay to N
// slots was rejected -- ESP32 core 2.0.14 WiFiClient::write() is a select() loop
// of 10 retries x 1 s, so one asleep client can block loop() for tens of seconds
// and three would treble it. Instead the LEADER instance POSTs a snapshot of its
// VISIBLE rows into the rotator's own firmware.
//
// What that makes worth checking, and what a unit test could not see:
//
//   * The gate is the leader election, which only exists across real documents on
//     a shared BroadcastChannel. So this runs TWO dxc.html instances in iframes
//     and asserts the follower stays silent -- if both posted, a rotator would get
//     two conflicting snapshots and the operator would see spots flicker between
//     two sets of filters.
//   * Promotion. Closing the leader must not stop the feed. Removing an iframe
//     fires pagehide, which is the resign path that actually runs when a window
//     is closed.
//   * NO PREFLIGHT. The whole reason the POST is text/plain and no-cors is that a
//     preflight OPTIONS would need CORS support on the rotator, which it does not
//     have. So the fake rotator listens on ITS OWN PORT -- a genuinely different
//     origin -- and records any OPTIONS it receives. A cross-origin POST that
//     quietly grew a preflight would show up here and nowhere else.
//
// The fake rotator answering on a second port is also why the fixture cannot just
// be one server: same-origin would prove nothing about the header choice.

const http = require("http"), fs = require("fs"), path = require("path");
const crypto = require("crypto");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let finished = false, chrome = null, timer = null, port = 0, rotPort = 0;
let pass = 1;
const allChecks = [];

// ── Fake rotator, on its own origin ──────────────────────────────────────────

let rotPosts = [];        // parsed bodies, newest last
let rotOptions = 0;       // preflights -- must stay zero

const rotator = http.createServer((request, response) => {
  if (request.method === "OPTIONS") {
    rotOptions++;
    response.writeHead(204).end();
    return;
  }
  const url = new URL(request.url, "http://rotator");
  if (url.pathname === "/setDxcSpots" && request.method === "POST") {
    let body = "";
    request.on("data", c => body += c);
    request.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (_) { parsed = {parseError: body.slice(0, 120)}; }
      rotPosts.push({at: Date.now(), ct: request.headers["content-type"] || "", body: parsed});
      response.writeHead(200, {"Content-Type": "text/plain"}).end("ok");
    });
    return;
  }
  response.writeHead(404).end("not found");
});

// ── Fake cluster over WebSocket ──────────────────────────────────────────────

let wsConns = [], wsOpens = 0, telnetUp = true;

function wsEncode(text) {
  const payload = Buffer.from(text, "utf8");
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

function wsDecode(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskOff = off;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  return {opcode, size: off + len};
}

function clusterPush(text) {
  for (const socket of wsConns) { try { socket.write(wsEncode(text)); } catch (_) {} }
}

// ── Fixture ──────────────────────────────────────────────────────────────────

function finish(result) {
  if (finished) return;
  for (const c of (result && result.checks) || []) allChecks.push(c);

  if (pass === 1 && !(result && result.hard)) {
    pass = 2;                       // second pass: no rotator configured at all
    rotPosts = [];
    killChrome();
    setTimeout(() => launchChrome(), 400).unref();
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
  console.log(`\nDXC MAP FEED ${failed ? "FAIL" : "PASS"} ${allChecks.length - failed}/${allChecks.length}`);
  setTimeout(() => process.exit(failed ? 1 : 0), 150).unref();
}

function killChrome() {
  if (!chrome) return;
  const dying = chrome;
  chrome = null;
  dying.kill("SIGTERM");
  // SIGKILL follow-up is not paranoia: a killed driver once left headless Chrome
  // children alive and still keying a real radio for ten minutes.
  setTimeout(() => { try { dying.kill("SIGKILL"); } catch (_) {} }, 2000).unref();
}

const HARNESS_HTML = `<!doctype html><meta charset="utf-8"><title>dxc map feed</title>
<body style="margin:0"><div id="frames"></div><script>__PAGE_SCRIPT__</script>`;

const T0 = Date.now();
const trace = (...a) => {
  if (process.env.DXC_MAP_TRACE === "1")
    console.error(`[${String(Date.now() - T0).padStart(6)}ms]`, ...a);
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  if (url.pathname !== "/dxc.html" && !url.pathname.endsWith(".js"))
    trace("fixture", request.method, url.pathname, (url.search || "").slice(0, 60));
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
  if (url.pathname === "/pass") return json({pass});
  if (url.pathname === "/map-stats")
    return json({posts: rotPosts, options: rotOptions, wsOpens, live: wsConns.length});
  if (url.pathname === "/map-stats/clear") { rotPosts = []; return json({ok: true}); }
  if (url.pathname === "/ws-push") { clusterPush(url.searchParams.get("t") || ""); return json({ok: true}); }
  if (url.pathname === "/telnet") {
    telnetUp = url.searchParams.get("on") === "1";
    clusterPush(JSON.stringify({telnet: telnetUp}));
    return json({ok: true});
  }

  // Pass 2 hands out an empty maphost: the feature must then be completely inert.
  if (url.pathname === "/dxcinfo") return json({
    locator: "JO70UC", callsign: "OK1HRA", trx2netid: 0, trx3netid: 0,
    maphost: pass === 1 ? `127.0.0.1:${rotPort}` : "",
  });

  if (url.pathname === "/" || url.pathname === "/index.html") {
    response.writeHead(200, {"Content-Type": "text/html"});
    return response.end(HARNESS_HTML.replace("__PAGE_SCRIPT__", PAGE_SCRIPT));
  }

  const file = path.join(data, path.basename(url.pathname));
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
  // One client, previous one evicted -- the device's behaviour, modelled so a
  // page that opens two sockets storms here exactly as it would on the radio.
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
    }
  });
  try { socket.write(wsEncode(JSON.stringify({telnet: telnetUp}))); } catch (_) {}
});

// ── The page script ──────────────────────────────────────────────────────────

const PAGE_SCRIPT = `
(async function () {
  const checks = [];
  const check = (name, ok, detail) => checks.push([name, !!ok, detail || ""]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const stats = async () => await (await fetch("/map-stats")).json();
  const clear = async () => await fetch("/map-stats/clear");
  const push = async text => await fetch("/ws-push?t=" + encodeURIComponent(text));
  const report = async hard =>
    await fetch("/result", {method: "POST", body: JSON.stringify({checks, hard: !!hard})});

  // 5 s cadence, so an 11 s window holds EXACTLY two ticks per poster. That is
  // what separates "only the leader posts" (2) from "both post" (4); a shorter
  // window cannot tell them apart.
  const TICK = 5000, WINDOW = 11000;

  const spot = (call, freq, type, time) =>
    "DX de OK2XYZ:    " + freq + "  " + call + "       " + type + "              " + time + "Z";

  function addFrame(name) {
    const f = document.createElement("iframe");
    f.name = name;
    f.style.cssText = "width:900px;height:400px;border:0";
    f.src = "/dxc.html";
    document.getElementById("frames").appendChild(f);
    return f;
  }
  const pillOf = f => {
    try { return f.contentDocument.getElementById("mapPill"); } catch (_) { return null; }
  };
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

    // ══ Pass 2: no rotator configured — the feature must be completely inert ══
    if (which === 2) {
      addFrame("solo");
      await sleep(TICK * 2 + 1500);
      const s = await stats();
      check("empty maphost posts nothing", s.posts.length === 0,
        s.posts.length + " posts");
      const pill = pillOf(document.getElementsByTagName("iframe")[0]);
      check("empty maphost leaves the MAP pill neutral",
        pill && pill.className.indexOf("ok") < 0,
        pill ? pill.className : "no pill");
      await report();
      return;
    }

    // ══ Pass 1 ══════════════════════════════════════════════════════════════

    // A filter set BEFORE the pages load, so it goes through the real
    // loadDxFilter() path rather than being poked into a live instance. The
    // point of the whole "visible rows only" rule is that this must reach the
    // rotator, and the operator gets no other hint that it did.
    localStorage.setItem("dxcDxFilter", JSON.stringify({text: "JA", regex: false}));

    const a = addFrame("a"), b = addFrame("b");
    await until(() => pillOf(a) && pillOf(b), 15000, "both instances to render");

    // One leader, one follower: exactly one green MAP pill.
    const greens = () => [a, b].filter(f => {
      const p = pillOf(f);
      return p && p.className.indexOf("ok") >= 0;
    });
    await until(() => greens().length === 1, 15000, "one instance to claim the feed");
    check("exactly one MAP pill is green", greens().length === 1,
      greens().length + " green");
    const follower = [a, b].find(f => greens().indexOf(f) < 0);
    const fPill = pillOf(follower);
    check("the follower says why it is silent",
      /Another DXC instance/.test(fPill && fPill.title || ""),
      fPill ? fPill.title : "no pill");

    // Two instances settling can legitimately upgrade more than once -- the
    // page's own comment says two leaders may overlap for an instant before the
    // lower id keeps the socket. So wait for the churn to STOP before pushing
    // anything: a line written to a socket that is about to be evicted is simply
    // lost, which would look like a capping bug rather than a harness race.
    const settled = await until(async () => {
      const first = await stats();
      await sleep(2000);
      const second = await stats();
      return (first.wsOpens === second.wsOpens && second.live === 1) ? second : null;
    }, 20000, "the cluster socket to settle");
    const opensBefore = settled.wsOpens;

    // 150 spots the DX filter keeps, two it must hide. Batched, because one
    // telnet chunk really does carry several lines.
    const lines = [];
    for (let i = 0; i < 150; i++) lines.push(spot("JA" + (1000 + i) + "AB", "14074.0", "CQ", "1204"));
    lines.push(spot("RA3ABC", "14075.0", "CQ", "1205"));
    lines.push(spot("UA9XYZ", "14076.0", "DE", "1206"));
    for (let i = 0; i < lines.length; i += 40)
      await push(lines.slice(i, i + 40).join("\\n") + "\\n");

    // Sync on the page having actually parsed them, not on a guessed delay.
    // #cnt reads "<visible>/<total>".
    await until(() => {
      const el = follower.contentDocument.getElementById("cnt");
      return el && /\\/152$/.test(el.textContent) ? true : null;
    }, 20000, "all 152 spots to reach the follower");

    await clear();
    await sleep(WINDOW);
    let s = await stats();

    check("only the leader posts", s.posts.length >= 1 && s.posts.length <= 3,
      s.posts.length + " posts in " + WINDOW + " ms (two posters would give 4)");
    check("the cross-origin POST triggers no preflight", s.options === 0,
      s.options + " OPTIONS");
    // The failure this guards is a reconnect STORM, not the count itself: once
    // settled, a steady feed must not cost a single new upgrade.
    check("a settled feed opens no further cluster sockets",
      s.wsOpens === opensBefore && s.live === 1,
      s.wsOpens + " upgrades (was " + opensBefore + "), " + s.live + " live");

    const last = s.posts.length ? s.posts[s.posts.length - 1] : null;
    check("POST is sent as text/plain", last && /text\\/plain/.test(last.ct),
      last ? last.ct : "no post");
    const spots = last && last.body && last.body.spots;
    check("snapshot is capped at 120 spots", Array.isArray(spots) && spots.length === 120,
      Array.isArray(spots) ? String(spots.length) : "no spots array");
    check("spots carry the type the map filters on",
      Array.isArray(spots) && spots.length > 0 && spots[0].type === "CQ",
      Array.isArray(spots) && spots[0] ? JSON.stringify(spots[0]) : "none");
    check("the cap keeps the NEWEST spots",
      Array.isArray(spots) && spots.some(x => x.dx === "JA1149AB")
        && !spots.some(x => x.dx === "JA1000AB"),
      Array.isArray(spots) ? spots[0].dx + ".." + spots[spots.length - 1].dx : "none");
    check("rows hidden by a DXC filter never reach the rotator",
      Array.isArray(spots) && !spots.some(x => x.dx === "RA3ABC" || x.dx === "UA9XYZ"),
      "filter was dx=JA");
    check("telnet state rides along", last && last.body && last.body.telnet === true,
      last && last.body ? String(last.body.telnet) : "no post");

    // Cluster login drops -- the rotator's dot depends on hearing about it.
    await fetch("/telnet?on=0");
    await clear();
    await sleep(WINDOW);
    s = await stats();
    const off = s.posts.length ? s.posts[s.posts.length - 1] : null;
    check("a dropped cluster login is reported to the rotator",
      off && off.body && off.body.telnet === false,
      off && off.body ? String(off.body.telnet) : "no post");

    // Close the leader. Removing an iframe fires pagehide, which is the resign
    // path that runs when a window is actually closed.
    const leader = greens()[0];
    leader.remove();
    await until(() => {
      const p = pillOf(follower);
      return p && p.className.indexOf("ok") >= 0;
    }, 15000, "the follower to be promoted");
    check("closing the leader promotes the follower's MAP pill", true, "");

    await clear();
    await sleep(WINDOW);
    s = await stats();
    check("the feed survives the leader closing", s.posts.length >= 1,
      s.posts.length + " posts after promotion");

    await report();
  } catch (error) {
    check("the harness ran to the end", false, String(error && error.message || error));
    await report(true);
  }
})();
`;

function launchChrome() {
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", "--window-size=1280,900",
    `http://127.0.0.1:${port}/`,
  ], {stdio: ["ignore", "ignore", "pipe"]});
  let chromeErrors = "";
  chrome.stderr.on("data", chunk => { chromeErrors += chunk; });
  chrome.on("error", error => finish({checks: [["chrome started", false, error.message]], hard: true}));
  chrome.on("close", code => {
    if (!finished && chrome) finish({checks: [["chrome stayed up", false,
      `exit ${code} ${chromeErrors.slice(-400)}`]], hard: true});
  });
}

rotator.listen(0, "127.0.0.1", () => {
  rotPort = rotator.address().port;
  server.listen(0, "127.0.0.1", () => {
    port = server.address().port;
    launchChrome();
    timer = setTimeout(() => finish({checks: [["the page reported within the timeout", false,
      "no /result was posted"]], hard: true}), 180000);
  });
});

process.on("SIGINT",  () => finish({checks: [["interrupted", false, "SIGINT"]], hard: true}));
process.on("SIGTERM", () => finish({checks: [["interrupted", false, "SIGTERM"]], hard: true}));

// dxc.html is served byte-identical to production except for the WebSocket port:
// the page hardcodes :82, which this fixture cannot bind.
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file !== "string") return content;
  if (file.endsWith("dxc.html"))
    return Buffer.from(content.toString("utf8").replace('+":82"+', `+":${port}"+`), "utf8");
  return content;
};
