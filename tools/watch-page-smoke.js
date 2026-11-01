#!/usr/bin/env node
"use strict";

// The WATCH viewer page in a real browser (docs/watch-implementace.md): boots
// against a fixture binary that speaks /watchws, and checks what the page
// actually drew from each role's snapshot or events, that the waterfall paints
// from relayed RX audio, that the tab follows the holder, that text from the
// air cannot inject markup -- and that the page never asks for anything that
// could take the session, tune or transmit, both in what it requested and in
// what its own sources contain.
//
//   node tools/watch-page-smoke.js

const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;
const requests = [];
const sockets = [];
const socketUrls = [];

function finish(result) {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  if (chrome) {
    chrome.kill("SIGTERM");
    setTimeout(() => chrome && chrome.kill("SIGKILL"), 2000).unref();
  }
  const checks = [...staticChecks(), ...((result && result.checks) || [])];
  const forbidden = requests.filter(url => FORBIDDEN.some(word => url.includes(word)));
  checks.push(["the page requested nothing that takes the session, tunes or transmits",
    forbidden.length === 0, forbidden.join(" ")]);
  checks.push(["only /watchws was opened as a socket", socketUrls.every(url => url.startsWith("/watchws")), socketUrls.join(" ")]);
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? `  -- ${detail}` : ""}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  setTimeout(() => process.exit(failed ? 1 : 0), 150).unref();
}

// What a viewer must never reach for. Checked against both the requests the
// page made and the text of every script it loads.
const FORBIDDEN = ["/cmd", "/audiows", "session/claim", "session/ping", "session/release", "mercury/session",
  "tx.prepare", "tx.extend", "tx.abort", "/msgbox", "js8lan.session", "/lan/reconnect", "/watch/snapshot"];

function staticChecks() {
  const html = fs.readFileSync(path.join(data, "watch.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="\/([^"?]+)/g)].map(match => match[1]).filter(name => name !== "ports.js");
  const out = [["the page loads only its whitelist of scripts",
    JSON.stringify(scripts) === JSON.stringify(["spectrum.js", "station-map.js", "watch.js"]), scripts.join(",")]];
  for (const name of scripts) {
    const text = fs.readFileSync(path.join(data, name), "utf8");
    const hits = FORBIDDEN.filter(word => text.includes(word));
    out.push([`${name} contains no session/TX/tuning call`, hits.length === 0, hits.join(",")]);
  }
  // The way in for a second visitor: every "driven from somewhere else" card
  // offers WATCH (shown by watch-link.js only when the binary has it on).
  // Tested live against the native binary in docs/watch-implementace.md.
  for (const page of ["data.html", "wspr.html", "rtty.html", "jtty.html", "mercury.html"]) {
    const text = fs.readFileSync(path.join(data, page), "utf8");
    const cards = [...text.matchAll(/<section id="\w+" class="gate-card session-busy"[\s\S]*?<\/section>/g)].map(m => m[0]);
    out.push([`${page}: its busy card offers WATCH, hidden until watch-link.js shows it`,
      cards.length === 1 && /<a class="gate-card-action watch-link" href="\/watch\.html" data-watch-link hidden/.test(cards[0]) &&
      /<script src="\/watch-link\.js\?v=[0-9a-f]+"><\/script>/.test(text)]);
  }
  return out;
}

// ── A minimal server-side WebSocket ──────────────────────────────────────────
function wsFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) header = Buffer.from([0x80 | opcode, body.length]);
  else if (body.length <= 0xffff) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(body.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([header, body]);
}
const sendText = (socket, object) => socket.write(wsFrame(1, JSON.stringify(object)));

const HOLDER_JS8 = {held: true, role: "js8", owner: "192.168.1.20"};
const JS8 = {myCall: "OK1HRA", grid: "JO70", activityHz: 14078000, radioHz: 14078000, mode: "A", tx: false,
  traffic: [
    {t: Date.UTC(2026, 10, 1, 12, 0, 15), hz: 1210, speed: "A", snr: -12, text: "OK1HRA: SNR -10", from: "DL1ABC", forMe: true},
    {t: Date.UTC(2026, 10, 1, 12, 0, 0), hz: 1500, speed: "A", snr: null, text: "CQ CQ", out: true, status: "completed", to: ""},
    {t: Date.UTC(2026, 10, 1, 11, 59, 45), hz: 900, speed: "A", snr: -3, text: "<img src=x id=pwned onerror=alert(1)>", from: "G4XYZ"},
  ],
  stations: [
    {call: "DL1ABC", country: "Germany", grid: "JO62", snr: -12, hz: 1210, speed: "A", t: Date.now() - 30000, heard: true, reacted: true, km: 280, az: 300},
    {call: "G4XYZ", country: "England", grid: "", snr: -3, hz: 900, speed: "A", t: Date.now() - 60000, heard: true, reacted: false, km: 1100, az: 290},
  ],
  links: [{from: "G4XYZ", to: "DL1ABC", detail: "SNR -9", atMs: Date.now()}]};
const WSPR = {myCall: "OK1HRA", grid: "JO70FD", dialHz: 14095600, lastCycleMs: Date.UTC(2026, 10, 1, 12, 0, 0), beacon: "stopped", tx: false,
  spots: [{t: Date.UTC(2026, 10, 1, 12, 0, 0), freqHz: 14097071, audioHz: 1471, snr: -21, dt: .4, drift: 0, call: "K1JT", grid: "FN20", power: 37}]};
const MERCURY = {aud1: "AUD1 connected", peer: "OK2XYZ", connection: ["Connected with OK2XYZ · SNR RX +6 dB / TX +4 dB"],
  transfer: {text: "sending -- 12 kB / 40 kB", percent: 30}, arq: ["Mode: 3 (peer 3)"], heard: "", received: ["photo.jpg"]};

function onWatchSocket(socket, url) {
  sockets.push(socket);
  const audio = url.includes("audio=1");
  sendText(socket, {type: "hello", protocol: "WATCH", version: 1, audio, viewers: sockets.length, holder: HOLDER_JS8});
  sendText(socket, {type: "snapshot", role: "js8", seq: 1, ageMs: 4000, data: JS8});
  sendText(socket, {type: "snapshot", role: "wspr", seq: 2, ageMs: 60000, data: WSPR});
  sendText(socket, {type: "snapshot", role: "mercury", seq: 3, ageMs: 1000, data: MERCURY});
  sendText(socket, {type: "event", role: "rtty", seq: 4, data: {type: "rtty.stream", r1: "CQ CQ DE DL1ABC ", r2: "CQ CQ DE DL1ABG "}});
  sendText(socket, {type: "event", role: "rtty", seq: 5, data: {type: "rtty.tx", text: "DL1ABC DE OK1HRA 599"}});
  sendText(socket, {type: "event", role: "jtty", seq: 6, data: {type: "jtty.stream", id: 7, hz: 1500, snr: -5, eom: 0, text: "CQ OK1"}});
  sendText(socket, {type: "event", role: "jtty", seq: 7, data: {type: "jtty.stream", id: 7, hz: 1500, snr: -4, eom: 1, text: "HRA CQ"}});
  if (audio) {
    // A 1 kHz tone, 512 samples a frame, ~16 frames a second.
    let first = 0, sequence = 0;
    const tick = setInterval(() => {
      if (socket.destroyed) { clearInterval(tick); return; }
      const frame = Buffer.alloc(40 + 512);
      frame.write("AUD1", 0); frame[4] = 1; frame[5] = 1;
      frame.writeUInt16BE(sequence === 0 ? 1 : 0, 6); frame.writeUInt16BE(40, 8);
      frame.writeUInt32BE(99, 12); frame.writeUInt32BE(sequence++, 16); frame.writeUInt32BE(8000, 20);
      frame.writeBigUInt64BE(BigInt(first), 24); frame.writeUInt32BE(512, 36);
      for (let index = 0; index < 512; index++) {
        const sample = Math.round(Math.sin(2 * Math.PI * 1000 * (first + index) / 8000) * 8000);
        frame[40 + index] = linearToUlaw(sample);
      }
      first += 512;
      socket.write(wsFrame(2, frame));
    }, 60);
  }
  socket.on("data", () => {});
  socket.on("error", () => {});
  socket.on("close", () => sockets.splice(sockets.indexOf(socket), 1));
}

function linearToUlaw(input) {
  let sample = input, sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  sample = Math.min(sample, 32635) + 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; exponent--, mask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  requests.push(url.pathname + url.search);
  const json = body => { response.writeHead(200, {"Content-Type": "application/json"}); response.end(JSON.stringify(body)); };
  const readBody = done => { let body = ""; request.on("data", c => body += c); request.on("end", () => done(body)); };

  if (url.pathname === "/result" && request.method === "POST")
    return readBody(body => { response.writeHead(204).end(); finish(JSON.parse(body)); });
  if (url.pathname === "/ports.js") {
    response.writeHead(200, {"Content-Type": "application/javascript"});
    return response.end(`window.WIFILT_PORTS={"http":${server.address().port},"dxc":82,"audio":${server.address().port},"homeHttp":0};`);
  }
  if (url.pathname === "/health.json") return json({platform: "linux", watch: {on: true, audio: true, viewers: sockets.length}});
  // Test controls, not part of any real API.
  if (url.pathname === "/fixture/holder") {
    for (const socket of sockets) sendText(socket, {type: "status", viewers: sockets.length,
      holder: {held: true, role: url.searchParams.get("role"), owner: "192.168.1.21"}});
    return json({ok: true});
  }
  if (url.pathname === "/fixture/sockets") return json(socketUrls);

  const file = path.join(data, path.basename(url.pathname));
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    let body = fs.readFileSync(file);
    if (path.basename(file) === "watch.html") {
      const text = body.toString().replace("<head>", `<head>\n<script>${ERROR_COLLECTOR}</script>`);
      body = Buffer.from(`${text}\n<script>${PAGE_SCRIPT}</script>\n`);
    }
    response.writeHead(200, {"Content-Type": mime[path.extname(file)] || "text/plain"});
    return response.end(body);
  }
  response.writeHead(404).end("not found");
});

server.on("upgrade", (request, socket) => {
  socketUrls.push(request.url);
  if (!request.url.startsWith("/watchws")) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  const accept = crypto.createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  onWatchSocket(socket, request.url);
});

const ERROR_COLLECTOR = `
window.__watchSmokeErrors = [];
window.addEventListener("error", e => window.__watchSmokeErrors.push(String((e.error && e.error.stack) || e.message)));
window.addEventListener("unhandledrejection", e => window.__watchSmokeErrors.push("unhandled rejection: " + String(e.reason)));
`;

const PAGE_SCRIPT = `
(async function () {
  const checks = [];
  const check = (name, ok, detail) => checks.push([name, !!ok, detail || ""]);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(50); } return pred(); };
  const tab = role => document.querySelector('#tabs button[data-role="' + role + '"]');

  try {
    await waitFor(() => $("link").textContent === "LIVE", 5000);
    check("no uncaught error during boot", window.__watchSmokeErrors.length === 0, window.__watchSmokeErrors.slice(0, 3).join(" | "));
    check("the link shows LIVE", $("link").textContent === "LIVE", $("link").textContent);
    check("the header names the holder", /JS8 · operated from 192\\.168\\.1\\.20/.test($("holder").textContent), $("holder").textContent);

    // ---- JS8 -----------------------------------------------------------------
    await waitFor(() => $("view").querySelector(".feed article"), 3000);
    check("the holder's mode is the open tab", tab("js8").classList.contains("active"));
    check("the JS8 feed has every published row", $("view").querySelectorAll(".feed article").length === 3);
    check("a message to me carries TO YOU", $("view").querySelector("article.for-me .badge")?.textContent === "TO YOU");
    check("own TX is a TX row", /TX → CQ\\/HB/.test($("view").querySelector("article.tx strong")?.textContent || ""));
    check("text from the air is shown, not run", !document.getElementById("pwned") &&
      $("view").textContent.includes("<img src=x id=pwned"));
    check("the stations table lists both", $("view").querySelectorAll("tbody tr").length === 2);
    check("a station that reacted is marked", $("view").querySelector("td.call.reacted")?.textContent.includes("DL1ABC"));
    check("the map is drawn with a hearing link", $("view").querySelector(".station-map-svg .map-hearing") !== null);
    check("the stamp says how old the screen is", /as of \\d+ s ago/.test($("stamp").textContent), $("stamp").textContent);

    // ---- WSPR ----------------------------------------------------------------
    tab("wspr").click(); await sleep(50);
    check("WSPR lists the spot", $("view").querySelector("td.call")?.textContent === "K1JT");
    check("WSPR computes the distance from the grids", /\\d{4} km/.test($("view").textContent));
    check("WSPR draws the map", $("view").querySelector(".station-map-svg") !== null);

    // ---- RTTY ----------------------------------------------------------------
    tab("rtty").click(); await sleep(50);
    const tapes = $("view").querySelectorAll("pre.tape");
    check("RTTY shows both decoders", tapes.length === 2 && tapes[0].textContent.includes("CQ CQ DE DL1ABC") &&
      tapes[1].textContent.includes("DL1ABG"));
    check("RTTY transmitted text is marked", tapes[0].querySelector(".tx")?.textContent.includes("DE OK1HRA 599"));

    // ---- JTTY ----------------------------------------------------------------
    tab("jtty").click(); await sleep(50);
    const jtty = [...$("view").querySelectorAll(".feed article")];
    check("JTTY joins the pieces of one message", jtty.length === 1 && jtty[0].textContent.includes("CQ OK1HRA CQ") &&
      jtty[0].textContent.includes("complete"), jtty.map(a => a.textContent).join(" | "));

    // ---- Mercury -------------------------------------------------------------
    tab("mercury").click(); await sleep(50);
    check("Mercury shows the connection and progress",
      $("view").textContent.includes("Connected with OK2XYZ") && Number($("view").querySelector("progress")?.value) === 30);
    check("Mercury lists the received file", $("view").textContent.includes("photo.jpg"));

    // ---- the tab follows the holder ------------------------------------------
    await fetch("/fixture/holder?role=wspr");
    await waitFor(() => tab("wspr").classList.contains("active"), 2000);
    check("a new holder role takes over a clicked tab", tab("wspr").classList.contains("active") && tab("wspr").classList.contains("held"));

    // ---- waterfall from relayed audio ----------------------------------------
    check("no audio asked for until the waterfall is on", !(await (await fetch("/fixture/sockets")).json()).some(u => u.includes("audio=1")));
    $("waterfallToggle").checked = true; $("waterfallToggle").dispatchEvent(new Event("change"));
    let urls = [];
    const end = Date.now() + 3000;
    while (Date.now() < end && urls[urls.length - 1] !== "/watchws?audio=1") {
      urls = await (await fetch("/fixture/sockets")).json();
      await sleep(50);
    }
    check("the waterfall reconnects asking for audio", urls[urls.length - 1] === "/watchws?audio=1", urls.join(" "));
    const canvas = $("waterfallCanvas");
    const ink = () => { const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++; return n; };
    await waitFor(() => ink() > 50, 6000);
    check("the waterfall paints the relayed tone", ink() > 50, String(ink()));
    check("the audio state says where it comes from", $("audioState").textContent === "RX audio from the radio", $("audioState").textContent);
    check("no uncaught error at the end", window.__watchSmokeErrors.length === 0, window.__watchSmokeErrors.slice(0, 3).join(" | "));
  } catch (error) {
    check("the page script ran to the end", false, String(error && error.stack || error));
  }
  await fetch("/result", {method: "POST", body: JSON.stringify({checks})});
})();
`;

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", "--window-size=1280,900", `http://127.0.0.1:${port}/watch.html`,
  ], {stdio: ["ignore", "ignore", "pipe"]});
  let chromeErrors = "";
  chrome.stderr.on("data", chunk => { chromeErrors += chunk; });
  chrome.on("error", error => finish({checks: [["chrome started", false, error.message]]}));
  chrome.on("close", code => {
    if (!finished) finish({checks: [["chrome stayed up", false, `exit ${code} ${chromeErrors.slice(-400)}`]]});
  });
  timer = setTimeout(() => finish({checks: [["the page reported within the timeout", false, "no /result was posted"]]}), 60000);
});

process.on("SIGINT", () => finish({checks: [["interrupted", false, "SIGINT"]]}));
process.on("SIGTERM", () => finish({checks: [["interrupted", false, "SIGTERM"]]}));
