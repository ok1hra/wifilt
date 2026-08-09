#!/usr/bin/env node
"use strict";

// Reproduces a duplicated JS8LAN tab in headless Chrome. Both iframes share
// sessionStorage, exactly like a browser-duplicated tab, while the WebSocket
// fixture enforces the firmware rule that a new AUD1 client replaces the old.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const {spawn} = require("child_process");

const dataDir = path.resolve(__dirname, "../data");
let sessionToken = "";
let activeSocket = null;
let wsOpens = 0;
let wsCloses = 0;
let streamId = 1000;
let sequence = 0;
let firstSample = 0;
let chrome = null;
let deadline = null;
let finished = false;

function readJson(req, callback) {
  let body = "";
  req.on("data", chunk => body += chunk);
  req.on("end", () => {
    try { callback(JSON.parse(body || "{}")); }
    catch (_error) { callback({}); }
  });
}

function sessionReply(res, status) {
  res.writeHead(status, {
    "Content-Type":"application/json",
    "Cache-Control":"no-store",
  });
  res.end(JSON.stringify({
    ok:status === 200,
    owner:"127.0.0.1",
    ageMs:200,
    leaseMs:15000,
  }));
}

function wsFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length < 126)
    return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  return Buffer.concat([
    Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255]),
    body,
  ]);
}

function aud1Packet(id) {
  const wire = Buffer.alloc(200, 0xff);
  wire.write("AUD1");
  wire[4] = 1;
  wire[5] = 1;
  wire.writeUInt16BE(sequence === 0 ? 1 : 0, 6);
  wire.writeUInt16BE(40, 8);
  wire.writeUInt32BE(id, 12);
  wire.writeUInt32BE(sequence++, 16);
  wire.writeUInt32BE(8000, 20);
  wire.writeBigUInt64BE(BigInt(firstSample), 24);
  wire.writeUInt32BE(160, 36);
  firstSample += 160;
  return wire;
}

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const pass = Boolean(result.busy) && wsOpens === 1 && wsCloses === 0;
  const report = {
    checks:{
      secondPageLockedOut:Boolean(result.busy),
      firstAudioKept:wsOpens === 1 && wsCloses === 0,
    },
    detail:result.detail || "",
    wsOpens,
    wsCloses,
  };
  console.log(`JS8 SESSION BROWSER ${pass ? "PASS" : "FAIL"} ${JSON.stringify(report)}`);
  if (!pass) process.exitCode = 1;
  if (chrome) chrome.kill("SIGTERM");
  if (activeSocket) activeSocket.destroy();
  server.close();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");

  if (url.pathname === "/result" && req.method === "POST")
    return readJson(req, result => {
      res.writeHead(204).end();
      finish(result);
    });

  if (url.pathname === "/js8/session/claim" && req.method === "POST")
    return readJson(req, body => {
      if (sessionToken && sessionToken !== body.token && !body.force)
        return sessionReply(res, 409);
      sessionToken = body.token || "";
      sessionReply(res, 200);
    });

  if (url.pathname === "/js8/session/ping" && req.method === "POST")
    return readJson(req, body => {
      if (sessionToken && sessionToken !== body.token)
        return sessionReply(res, 409);
      sessionToken = body.token || "";
      sessionReply(res, 200);
    });

  if (url.pathname === "/js8/session/release" && req.method === "POST")
    return readJson(req, body => {
      if (sessionToken === body.token) sessionToken = "";
      res.writeHead(200, {"Content-Type":"application/json"}).end('{"ok":true}');
    });

  if (url.pathname === "/state") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      connected:true,
      lanStatus:"linked",
      transceiverType:"ICOM-LAN",
      power:true,
      frequency:7078000,
      mode:"USB-D",
      tx:false,
      fwRev:"session-smoke",
    }));
  }

  if (url.pathname === "/setup-data.json") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      fwRev:"session-smoke",
      trx1transport:"lan",
      lanip:"127.0.0.1",
      lanuser:"operator",
      lanpass:"secret",
    }));
  }

  if (url.pathname === "/unattended") {
    res.setHeader("Content-Type", "application/json");
    return res.end('{"armed":false,"remainingMs":0,"clientLive":false}');
  }

  if (url.pathname === "/inbox") {
    res.setHeader("Content-Type", "text/plain");
    return res.end("");
  }

  if (url.pathname === "/cmd") {
    res.setHeader("Content-Type", "application/json");
    return res.end('{"ok":true}');
  }

  if (url.pathname === "/session-smoke.html") {
    res.setHeader("Content-Type", "text/html");
    return res.end(`<!doctype html>
<iframe id="first" src="/data?test=1&audioPort=${server.address().port}"></iframe>
<script>
const first=document.querySelector("#first");
let second=null;
let busyAt=0;
const started=Date.now();
const poll=setInterval(()=>{
  if(!second && first.contentDocument.querySelector("#modemState")?.textContent.includes("ready")){
    second=document.createElement("iframe");
    document.body.append(second);
    second.src="/data?test=1&audioPort=${server.address().port}";
  }
  let busy=false, detail="";
  try {
    busy=!!second?.contentDocument.body.classList.contains("session-busy-only");
    detail=second?.contentDocument.querySelector("#sessionBusyWhere")?.textContent||"";
  } catch(_error) {}
  if(busy && !busyAt) busyAt=Date.now();
  if((busyAt && Date.now()-busyAt>=5000) || Date.now()-started>=20000){
    clearInterval(poll);
    fetch("/result",{method:"POST",body:JSON.stringify({busy,detail})});
  }
},100);
</script>`);
  }

  const relative = url.pathname === "/data" ? "data.html" : url.pathname.slice(1);
  const target = path.resolve(dataDir, relative);
  if (!target.startsWith(dataDir + path.sep)) return res.writeHead(403).end();
  // Match the ESP32 deployment path: application JS is served from its
  // minified gzip companion whenever the browser advertises gzip.
  const gzip = target + ".gz";
  const encoded = String(req.headers["accept-encoding"] || "").includes("gzip") &&
    fs.existsSync(gzip) ? gzip : target;
  fs.readFile(encoded, (error, bytes) => {
    if (error) return res.writeHead(404).end();
    const mime = {
      ".html":"text/html",
      ".css":"text/css",
      ".js":"application/javascript",
      ".wasm":"application/wasm",
      ".bin":"application/octet-stream",
    };
    res.setHeader("Content-Type", mime[path.extname(target)] || "application/octet-stream");
    if (encoded === gzip) res.setHeader("Content-Encoding", "gzip");
    res.end(bytes);
  });
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname !== "/audiows" || url.searchParams.get("token") !== sessionToken)
    return socket.destroy();

  if (activeSocket && !activeSocket.destroyed) activeSocket.destroy();
  activeSocket = socket;
  wsOpens += 1;
  const id = ++streamId;
  sequence = 0;
  firstSample = 0;
  const accept = crypto.createHash("sha1")
    .update(req.headers["sec-websocket-key"] +
      "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
    "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  socket.write(wsFrame(1, JSON.stringify({
    type:"hello",
    protocol:"AUD1",
    version:1,
    streamId:id,
    rx:[{kind:"RX_ULAW", sampleRate:8000}],
    tx:[{kind:"TX_PCM16", sampleRate:48000}],
    maxPayloadBytes:1920,
  })));
  const interval = setInterval(() => {
    if (socket.destroyed) return clearInterval(interval);
    socket.write(wsFrame(2, aud1Packet(id)));
  }, 20);
  socket.on("close", () => {
    wsCloses += 1;
    clearInterval(interval);
  });
  socket.on("error", () => clearInterval(interval));
});

server.listen(0, "127.0.0.1", () => {
  chrome = spawn("google-chrome", [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-proxy-server",
    "--host-resolver-rules=MAP wifilt.test 127.0.0.1",
    `http://wifilt.test:${server.address().port}/session-smoke.html`,
  ]);
  chrome.on("close", code => {
    if (!finished) finish({detail:`Chrome exited ${code}`});
  });
  deadline = setTimeout(() => finish({detail:"test timeout"}), 25000);
});
