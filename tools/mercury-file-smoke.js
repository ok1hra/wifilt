#!/usr/bin/env node
// Real-browser proof for data/mercury-file.js (MRQ1 header + resume store):
// header/query/reply build+parse round trips, the pure-JS SHA-256 FALLBACK
// path specifically (this harness browses http://wifilt.test, an insecure
// origin via Chrome's own --host-resolver-rules, exactly like
// data-browser-smoke.js's own DATA-page pass -- see
// [[browser-smoke-origin-split]] -- so crypto.subtle is genuinely
// unavailable here, not just untested), and a real IndexedDB ResumeStore
// exercised in a real browser (Node has no IndexedDB, so this is the only
// place that store's actual behaviour can be checked at all).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const dataDir = path.resolve(__dirname, "../data");
const mime = { ".html": "text/html", ".js": "application/javascript" };

let finished = false, chrome = null, timer = null;
function finish(ok, detail) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (chrome) chrome.kill("SIGTERM");
  server.close();
  console.log(detail);
  console.log(ok ? "PASS: mercury-file.js verified in a real browser (insecure origin + real IndexedDB)" : "FAIL: see above");
  process.exit(ok ? 0 : 1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/result" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const r = JSON.parse(Buffer.concat(chunks).toString());
        const failed = Object.entries(r.checks || {}).filter(([, v]) => v !== true);
        finish(failed.length === 0 && !r.error, JSON.stringify(r, null, 2));
      } catch (e) { finish(false, "result parse error: " + e.message); }
    });
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><body>
      <script src="js8-file-transfer.js"></script>
      <script src="mercury-file.js"></script>
      <script>
      (async () => {
        const checks = {};
        let error = null;
        try {
          const mf = window.MercuryFile;
          checks.moduleLoaded = !!mf;
          checks.insecureOrigin = window.isSecureContext === false;
          checks.noSubtle = !(window.crypto && window.crypto.subtle);

          // ---- sha256 pure-JS fallback, cross-checked against a Node-computed oracle ----
          const enc = new TextEncoder().encode("mercury resume test content, chunk one|chunk two appended after resume");
          const hash = await mf.sha256(enc);
          checks.sha256Matches = mf.hex(hash) === "770698ebcd576ca465e212748dded3e43bec56c46031d6591f46534ed0c4fa95";

          // ---- header build/parse round trip (data, query, reply) ----
          const h1 = mf.dataHeader({ totalSize: enc.length, sha256: hash, name: "resume/../evil\\\\name.bin", offset: 0, deflated: false });
          const p1 = mf.parseHeader(h1);
          checks.dataHeaderNameSanitized = p1.name === "resume_.._evil_name.bin";
          checks.dataHeaderRoundTrip = p1.totalSize === enc.length && p1.offset === 0 && mf.hex(p1.sha256) === mf.hex(hash);

          const q = mf.queryHeader({ totalSize: enc.length, sha256: hash, name: "file.bin" });
          const pq = mf.parseHeader(q);
          checks.queryFlagsCorrect = pq.isQuery === true && pq.isReply === false && pq.offset === 0;

          const r = mf.replyHeader({ totalSize: enc.length, sha256: hash, name: "file.bin", haveBytes: 30 });
          const pr = mf.parseHeader(r);
          checks.replyFlagsCorrect = pr.isReply === true && pr.isResume === true && pr.offset === 30;

          const r0 = mf.replyHeader({ totalSize: enc.length, sha256: hash, name: "file.bin", haveBytes: 0 });
          checks.replyZeroNotResume = mf.parseHeader(r0).isResume === false;

          const resumedData = mf.dataHeader({ totalSize: enc.length, sha256: hash, name: "file.bin", offset: 30, deflated: false });
          checks.resumedDataFlagsCorrect = mf.parseHeader(resumedData).isResume === true && mf.parseHeader(resumedData).offset === 30;

          checks.incompleteReturnsNull = mf.parseHeader(h1.slice(0, 20)) === null;
          try { mf.parseHeader(new Uint8Array(60)); checks.badMagicThrows = false; }
          catch (_e) { checks.badMagicThrows = true; }

          // ---- deflate-raw: feature-detected, must be safe either way ----
          checks.canCompressIsBoolean = typeof mf.canCompress() === "boolean";
          if (mf.canCompress()) {
            const deflated = await mf.deflateRaw(enc);
            const inflated = await mf.inflateRaw(deflated);
            checks.deflateRoundTrip = inflated.length === enc.length && inflated.every((b, i) => b === enc[i]);
          } else {
            checks.deflateRoundTrip = true; // nothing to test on a browser without CompressionStream
          }

          // ---- ResumeStore: real IndexedDB, chunked append + simulated resume negotiation ----
          const store = new mf.ResumeStore();
          const peer = "OK2XYZ";
          const name = "file.bin";
          const hex = mf.hex(hash);
          await store.clear(peer, name, hex); // in case a prior run of this smoke left state behind
          const half = enc.slice(0, 30), rest = enc.slice(30);
          const afterFirst = await store.append(peer, name, hex, enc.length, half);
          checks.resumeStoreFirstChunk = afterFirst.receivedBytes === 30;

          // Simulate what the receiving side would answer if a new connection
          // asked "do you have any of this already?" (a QUERY arrives): look
          // up the store, and the REPLY it would build should carry exactly
          // the offset to resume from.
          const existing = await store.get(peer, name, hex);
          const reply = mf.replyHeader({ totalSize: enc.length, sha256: hash, name, haveBytes: existing ? existing.receivedBytes : 0 });
          const parsedReply = mf.parseHeader(reply);
          checks.resumeNegotiationOffsetMatchesStore = parsedReply.offset === 30 && parsedReply.isResume === true;

          const afterSecond = await store.append(peer, name, hex, enc.length, rest);
          checks.resumeStoreFullLength = afterSecond.receivedBytes === enc.length;
          const fullBytes = new Uint8Array(await afterSecond.blob.arrayBuffer());
          checks.resumeStoreContentByteExact = fullBytes.length === enc.length && fullBytes.every((b, i) => b === enc[i]);

          await store.clear(peer, name, hex);
          checks.resumeStoreClears = (await store.get(peer, name, hex)) === null;

          // ---- consumeFrames: the stream parser mercury-worker.js's receive
          // side is built on (multiple frames in one buffer, a frame split
          // across two arrivals, nothing left, a too-short header) ----
          const tail = new TextEncoder().encode("resumed tail content");
          const resumeOffset = 79;
          const dataFrame = mf.dataHeader({ totalSize: resumeOffset + tail.length, sha256: hash, name: "b.bin", offset: resumeOffset, deflated: false });
          const stream = new Uint8Array([...q, ...dataFrame, ...tail]);
          const r1 = mf.consumeFrames(stream, 0);
          checks.consumeFramesTwoInOneBuffer = r1.frames.length === 2 && r1.offset === stream.length;
          checks.consumeFramesQueryContentEmpty = r1.frames.length > 0 && r1.frames[0].content.length === 0;
          checks.consumeFramesDataContentMatches = r1.frames.length > 1 && r1.frames[1].content.length === tail.length &&
            Array.from(r1.frames[1].content).every((b, i) => b === tail[i]);

          const partial = stream.slice(0, q.length + dataFrame.length + 3);
          const r2 = mf.consumeFrames(partial, 0);
          checks.consumeFramesSplitAcrossCalls = r2.frames.length === 1 && r2.offset === q.length;
          const r3 = mf.consumeFrames(stream, r2.offset);
          checks.consumeFramesResumesFromOffset = r3.frames.length === 1 && r3.offset === stream.length;

          const r4 = mf.consumeFrames(stream, stream.length);
          checks.consumeFramesNothingLeft = r4.frames.length === 0;
          const r5 = mf.consumeFrames(new Uint8Array([0x4d, 0x52]), 0);
          checks.consumeFramesTinyIncomplete = r5.frames.length === 0 && r5.offset === 0;

          // ---- parseHeader itself sanitizes the name, independent of
          // buildHeader -- a raw header assembled by hand (as a malicious or
          // buggy peer might over RF) must not get an unsafe name past this
          // point, since mercury.js puts it straight into a DOM <a> element. ----
          const evilNameBytes = new TextEncoder().encode('<img src=x onerror=alert(1)>/../evil');
          const rawHeader = new Uint8Array(mf.HEADER_FIXED_LEN + evilNameBytes.length);
          rawHeader.set(mf.MAGIC, 0);
          rawHeader[4] = mf.VERSION;
          new DataView(rawHeader.buffer).setUint8(54, evilNameBytes.length);
          rawHeader.set(evilNameBytes, mf.HEADER_FIXED_LEN);
          const parsedEvil = mf.parseHeader(rawHeader);
          checks.parseHeaderSanitizesRawInput = !parsedEvil.name.includes("<") && !parsedEvil.name.includes(">");
        } catch (e) {
          error = (e && e.stack) || String(e);
        }
        fetch("/result", { method: "POST", body: JSON.stringify({ checks, error }) }).catch(() => {});
      })();
      </script>
    </body></html>`);
    return;
  }
  const full = path.join(dataDir, url.pathname);
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": mime[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  chrome = spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-proxy-server", "--host-resolver-rules=MAP wifilt.test 127.0.0.1",
    `http://wifilt.test:${port}/`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErrors = "";
  chrome.stderr.on("data", (c) => { chromeErrors += c; });
  chrome.on("error", (e) => finish(false, "chrome failed to start: " + e.message));
  chrome.on("close", (code) => { if (!finished) finish(false, `chrome exited early code=${code}\n${chromeErrors.slice(-800)}`); });
  timer = setTimeout(() => finish(false, "no result within timeout"), 30000);
});
