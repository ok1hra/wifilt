#!/usr/bin/env node
"use strict";

// The JTTY page in a real browser (docs/jtty-implementace.md §5): boots
// against a fixture firmware, and the parts that only fail silently are
// checked on what the page actually did -- canvas geometry and ink, the
// receiver running as a real Worker (importScripts with the page's own ?v=
// URLs, which no Node test reaches), words handed to QRPlog over
// BroadcastChannel, and the packets JttyTx cuts for a whole message and for
// live entry with tx.extend. Same fixture shape as tools/rtty-page-smoke.js.
//
//   node tools/jtty-page-smoke.js            # readable sources
//   JTTY_SMOKE_MINIFIED=1 node tools/jtty-page-smoke.js   # what the box serves

const http = require("http"), fs = require("fs"), path = require("path");
const {spawn} = require("child_process");

const root = path.resolve(__dirname, "..");
const data = path.join(root, "data");
const mime = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"};

let finished = false, chrome = null, timer = null;
const commands = [];
let jttyStreamOn = false;
const sessionClaims = [];

function finish(result) {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  if (chrome) {
    // An orphaned headless Chrome has keyed a real radio before: kill it hard.
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
  if (url.pathname === "/setup-data.json") return json({
    trx1transport: "lan", trx1lanip: "192.168.1.50", trx1lanuser: "user",
    trx1lanpass: "pass", trx1model: "IC-705",
  });
  if (url.pathname === "/state") return json({
    connected: true, power: true, frequency: 14090000, mode: "USB-D", filter: 1,
    tx: false, rfPower: 128, rfPowerSeen: true, radioName: "IC-705", radioNameSeen: true,
    transceiverType: "IC-705", lanStatus: "linked", catHealthy: true,
    audioReady: true, smeterRaw: 0, powerMeterRaw: 0, swr: 1.0,
  });
  if (url.pathname.startsWith("/js8/session")) {
    if (request.method === "POST") return readBody(body => { sessionClaims.push({path: url.pathname, body}); json({ok: true}); });
    return json({held: true, role: "jtty"});
  }
  if (url.pathname === "/session-claims") return json(sessionClaims);
  if (url.pathname === "/cmd" && request.method === "POST")
    return readBody(body => { try { commands.push(JSON.parse(body)); } catch (_) { commands.push({raw: body}); } json({ok: true}); });
  if (url.pathname === "/commands") return json(commands);
  if (url.pathname === "/commands/clear") { commands.length = 0; return json({ok: true}); }
  if (url.pathname === "/log-config") return json({trx1Label: "TRX1", jttyStream: jttyStreamOn});
  if (url.pathname === "/log-config/jtty-stream" && request.method === "POST")
    return readBody(body => { jttyStreamOn = new URLSearchParams(body).get("jttyStream") === "1"; json({ok: true}); });
  if (url.pathname === "/jtty-stream.json") return json({enabled: jttyStreamOn, trxnet: true,
    subs: jttyStreamOn ? [{name: "JTY.fe", expiresS: 61}] : [], packets: 0, dropped: 0, refused: 0});
  if (url.pathname === "/txgain.json") return json({v: 1, entries: {}});
  if (url.pathname === "/txgain-plan.json") return json({});
  if (url.pathname === "/trxnet-peers.json") return json([]);
  if (url.pathname === "/identity") return json({call: "OK1HRA", grid: "JO70"});
  if (url.pathname === "/js8-config.json") return json({});

  let file = url.pathname === "/" ? path.join(data, "jtty.html") : path.join(data, path.basename(url.pathname));
  if (process.env.JTTY_SMOKE_MINIFIED === "1" && file.endsWith(".js") && fs.existsSync(file + ".min")) file = file + ".min";
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    response.writeHead(200, {"Content-Type": mime[path.extname(url.pathname)] || mime[path.extname(file)] || "text/plain"});
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
  const bootErrors = window.__jttySmokeErrors;
  const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(50); } return pred(); };

  try {
    await sleep(1500);

    // ---- 1. boot ----------------------------------------------------------
    check("no uncaught error during boot", bootErrors.length === 0, bootErrors.slice(0, 3).join(" | "));
    check("the LAN gate let the page through",
      !document.body.classList.contains("lan-gate-blocked") && !document.body.classList.contains("lan-gate-checking"),
      document.body.className);
    check("the session was granted, no busy card", $("sessionBusy").hidden);
    const claims = await (await fetch("/session-claims")).json();
    check("the session is claimed as role jtty",
      claims.some(c => c.path === "/js8/session/claim" && JSON.parse(c.body).role === "jtty"), JSON.stringify(claims));
    check("the JTTY sub-tab is the active one", document.querySelector(".subtab-active").getAttribute("href") === "/jtty.html");
    check("my call came from SETUP identity", $("jttyMyCall").textContent === "OK1HRA", $("jttyMyCall").textContent);

    // ---- 2. scope -----------------------------------------------------------
    const wf = $("waterfallCanvas"), overlay = $("jttyScopeOverlay"), scopeEl = $("jttyScope");
    check("the waterfall canvas took a real width", wf.width >= 320, String(wf.width));
    check("the overlay spans the whole scope", overlay.height === Math.round(scopeEl.clientHeight) && overlay.width >= 320,
      overlay.width + "x" + overlay.height);
    const ink = () => { const d = overlay.getContext("2d").getImageData(0, 0, overlay.width, overlay.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };
    check("the overlay has ink on it (RX band, ruler)", ink() > 200, String(ink()));
    const sum100 = $("spectrumSummary").textContent;
    document.querySelector('.rtty-zoom-pill[data-zoom="400"]').click();
    await sleep(60);
    check("400% narrows the shown window", $("spectrumSummary").textContent !== sum100, sum100 + " -> " + $("spectrumSummary").textContent);
    document.querySelector('.rtty-zoom-pill[data-zoom="100"]').click();
    await sleep(60);

    // ---- 3. click-to-tune ------------------------------------------------------
    await fetch("/commands/clear");
    const rect = scopeEl.getBoundingClientRect();
    const clickAt = (frac, shift) => scopeEl.dispatchEvent(new MouseEvent("click", {clientX: rect.left + rect.width * frac, clientY: rect.top + 10, shiftKey: !!shift, bubbles: true}));
    clickAt(0.25);
    await sleep(80);
    const rx1 = Number($("jttyRxHz").value), txAfterClick = Number($("jttyTxHz").value);
    check("a click moves RX, and TX with it", rx1 > 600 && rx1 < 1000 && txAfterClick === rx1, rx1 + "/" + txAfterClick);
    clickAt(0.6, true);
    await sleep(80);
    check("shift+click moves TX only", Number($("jttyRxHz").value) === rx1 && Number($("jttyTxHz").value) > 1500,
      $("jttyRxHz").value + "/" + $("jttyTxHz").value);
    $("jttyHoldTx").checked = true; $("jttyHoldTx").dispatchEvent(new Event("change"));
    const txHeld = Number($("jttyTxHz").value);
    clickAt(0.45);
    await sleep(80);
    check("with Hold TX a click leaves TX where it was", Number($("jttyTxHz").value) === txHeld && Number($("jttyRxHz").value) !== rx1);
    $("jttyHoldTx").checked = false; $("jttyHoldTx").dispatchEvent(new Event("change"));
    const sent = await (await fetch("/commands")).json();
    check("tuning by click never retunes the radio", !sent.some(c => c.type === "setFrequency"), JSON.stringify(sent));
    check("the RX label follows", $("jttyRxHzLabel").textContent.indexOf(String($("jttyRxHz").value)) === 0, $("jttyRxHzLabel").textContent);

    // ---- 4. composer, F-keys, profile -------------------------------------------
    check("eight function keys with the WSJT-X defaults",
      $("jttyFkeys").querySelectorAll(".jtty-fkey").length === 8 && $("jttyFkeys").textContent.indexOf("CQ %M CQ") >= 0);
    const ta = $("jttyTxText");
    ta.value = "cq ok1hra cq"; ta.dispatchEvent(new Event("input"));
    check("the preview counts one frame for a CQ", /^1 frame, 1\\.9 s$/.test($("jttyTxPreview").textContent), $("jttyTxPreview").textContent);
    ta.value = "OK1ABC 599 001"; ta.dispatchEvent(new Event("input"));
    const unknownPreview = $("jttyTxPreview").textContent;
    while ($("jttyProfile").textContent !== "ROUNDUP") $("jttyProfile").click();
    ta.dispatchEvent(new Event("input"));
    check("RTTY Roundup packs the serial tighter", unknownPreview.startsWith("3 frames") && $("jttyTxPreview").textContent.startsWith("2 frames"),
      unknownPreview + " -> " + $("jttyTxPreview").textContent);
    while ($("jttyProfile").textContent !== "UNKNOWN") $("jttyProfile").click();
    ta.value = "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG ".repeat(3); ta.dispatchEvent(new Event("input"));
    check("a long text is counted as several segments", /^\\d\\d frames/.test($("jttyTxPreview").textContent), $("jttyTxPreview").textContent);
    ta.value = ""; ta.dispatchEvent(new Event("input"));
    const ftol = $("jttyFtol").textContent;
    $("jttyFtol").click();
    check("the F TOL pill cycles", $("jttyFtol").textContent !== ftol && $("jttyFtolSelect").value !== "", ftol + " -> " + $("jttyFtol").textContent);
    $("jttyHisCall").value = "dl1abc"; $("jttyHisCall").dispatchEvent(new Event("input"));
    check("the DX call is upper case", $("jttyHisCall").value === "DL1ABC");
    check("without AUD1 the keys are disabled, not silently dead", $("jttyFkeys").querySelector("button").disabled);

    // ---- 5. the receiver as a real Worker, on the page's own URLs -----------------
    const scriptUrl = p => [...document.querySelectorAll("script[src]")].find(e => e.getAttribute("src").split("?")[0] === p).getAttribute("src");
    let got = [];
    const rx = JttyRx.create({modemUrl: scriptUrl("/jtty-modem.js"), codecUrl: scriptUrl("/jtty-codec.js"),
      config: {rxHz: 1500, ftolHz: 100}, onUpdates: u => { got = got.concat(u); }});
    check("the receiver runs in a Worker", rx.inWorker());
    const packed = JttyCodec.packText("CQ OK1HRA CQ");
    const pcm = JttyModem.synthesize(JttyModem.messageTones(packed.frames), {sampleRate: 8000, f0: 1500, amplitude: 0.3});
    const audio = new Float32Array(8000 * 5);
    for (let i = 0; i < pcm.length; i++) audio[4000 + i] = pcm[i] / 32768;
    for (let i = 0; i < audio.length; i += 160) rx.push(audio.subarray(i, i + 160));
    rx.gap(30000);
    await waitFor(() => got.some(u => u.text === "CQ OK1HRA CQ" && u.complete), 8000);
    check("the Worker decodes a CQ fed in 20 ms pieces", got.some(u => u.text === "CQ OK1HRA CQ" && u.complete), JSON.stringify(got));
    rx.stop();

    // ---- 6. the line log: tokens to QRPlog, to-me highlight ----------------------------
    const handed = [];
    const dxc = new BroadcastChannel("wifilt-dxc-action");
    dxc.onmessage = e => handed.push(e.data);
    const store = JttyRxLog.createStore();
    const box = document.createElement("div"); document.body.appendChild(box);
    const view = JttyRxLog.createView({el: box, myCall: () => "OK1HRA", onToken: w => new BroadcastChannel("wifilt-dxc-action").postMessage({type: "dxc-tune", callsign: w, source: "jtty"})});
    view.render(store.apply([{id: 1, audioHz: 1500, startT: 0, latestT: 0, snr: -7, text: "OK1HRA DL1ABC 599 001", complete: false, status: "growing"}]));
    check("a growing message shows as one line", box.querySelectorAll(".jtty-line.jtty-growing").length === 1);
    check("a message to me is highlighted", box.querySelector(".jtty-line").classList.contains("jtty-to-me"));
    view.render(store.apply([{id: 1, audioHz: 1500, startT: 0, latestT: 1, snr: -7, text: "OK1HRA DL1ABC 599 001 TU", complete: true, status: "complete"}]));
    check("its update replaces the same line", box.querySelectorAll(".jtty-line").length === 1 && !box.querySelector(".jtty-growing"));
    [...box.querySelectorAll(".jtty-tok")].find(t => t.textContent === "DL1ABC").click();
    await waitFor(() => handed.length > 0, 1500);
    check("clicking a word hands it to QRPlog", handed.length === 1 && handed[0].callsign === "DL1ABC" && handed[0].source === "jtty", JSON.stringify(handed));
    box.remove();

    // ---- 7. JttyTx: packets and tx.extend -----------------------------------------------
    function fakeSession() {
      const s = {hello: {streamId: 7}, prepared: [], writes: [], controls: [], ended: false, aborted: null,
        prepare(id, meta) { s.prepared.push(meta); return Promise.resolve(); },
        begin() {}, write(w) { s.writes.push(w); }, end() { s.ended = true; },
        isDrained() { return s.ended; }, complete() {}, abort(id, r) { s.aborted = r; },
        sendControl(m) { s.controls.push(m); }};
      return s;
    }
    const inspect = w => { const v = new DataView(w.buffer); return {flags: v.getUint16(6), seq: v.getUint32(16), offset: Number(v.getBigUint64(24)), samples: v.getUint32(36) / 2}; };
    const verify = (s, label, expectedSamples) => {
      const ps = s.writes.map(inspect);
      const total = ps.reduce((n, p) => n + p.samples, 0);
      const declaredPackets = s.prepared[0].packets + s.controls.filter(c => c.type === "tx.extend").reduce((n, c) => n + c.packets, 0);
      const declaredSamples = s.prepared[0].samples + s.controls.filter(c => c.type === "tx.extend").reduce((n, c) => n + c.samples, 0);
      check(label + ": every sample written, as declared", total === expectedSamples && declaredSamples === total, total + " / " + declaredSamples + " / " + expectedSamples);
      check(label + ": packet count as declared", ps.length === declaredPackets, ps.length + " vs " + declaredPackets);
      check(label + ": FIRST on the first only, LAST on the last only",
        (ps[0].flags & 1) && ps.slice(1).every(p => !(p.flags & 1)) && (ps[ps.length - 1].flags & 2) && ps.slice(0, -1).every(p => !(p.flags & 2)));
      check(label + ": 960-sample packets, only the last short", ps.slice(0, -1).every(p => p.samples === 960) && ps[ps.length - 1].samples <= 960);
      check(label + ": continuous sequence and offsets", ps.every((p, i) => p.seq === i && p.offset === i * 960));
    };
    let s1 = fakeSession(), done1 = null;
    const tx1 = JttyTx.create({session: () => s1, txHz: () => 1500, onFinish: e => { done1 = e || "ok"; }});
    await tx1.send(JttyCodec.packText("CQ OK1HRA CQ"));
    check("tx.prepare names the JTTY text", s1.prepared[0].jttyText === "CQ OK1HRA CQ", JSON.stringify(s1.prepared[0]));
    await waitFor(() => done1, 8000);
    check("a one-frame message finishes", done1 === "ok", String(done1));
    verify(s1, "one frame", 59 * 1536);
    check("a whole message never extends", s1.controls.length === 0, JSON.stringify(s1.controls));

    let s2 = fakeSession(), done2 = null, asked = 0;
    const tx2 = JttyTx.create({session: () => s2, txHz: () => 1500, onFinish: e => { done2 = e || "ok"; }});
    const second = JttyCodec.packText("DE OK1HRA", {isFinal: false});
    await tx2.startLive({frames: JttyCodec.packText("CQ CQ", {isFinal: false}).frames, text: "CQ CQ", final: false},
      () => { asked++; return asked === 1 ? {frames: second.frames, text: second.text, final: false} : asked === 2 ? null : {stop: true}; });
    check("live entry is live", tx2.live());
    await waitFor(() => done2, 20000);
    check("live entry ends on {stop}", done2 === "ok", String(done2));
    const ext = s2.controls.filter(c => c.type === "tx.extend");
    check("one extend for the typed segment, one for the filler", ext.length === 2 && ext[0].jttyText === "DE OK1HRA" && ext[1].jttyText === "",
      JSON.stringify(ext));
    const frames2 = JttyCodec.packText("CQ CQ").frames.length + second.frames.length + 1;
    verify(s2, "live", frames2 * 59 * 1536);

    let s3 = fakeSession(), done3 = null;
    const tx3 = JttyTx.create({session: () => s3, txHz: () => 1500, onFinish: e => { done3 = e; }});
    await tx3.send(JttyCodec.packText("CQ OK1HRA CQ"));
    tx3.abort("operator");
    check("abort reaches the session and finishes with the reason", s3.aborted === "operator" && done3 === "operator", s3.aborted + "/" + done3);

    // ---- 8. dial menu, stream switch -------------------------------------------------------
    await fetch("/commands/clear");
    $("trxFrequency").click();
    await sleep(50);
    const presets = $("frequencyMenu").querySelectorAll("[data-frequency]");
    check("the dial menu lists the 11 WSJT-X JTTY frequencies", presets.length === 11, String(presets.length));
    check("14.090 is marked current", $("frequencyMenu").querySelector(".current").dataset.frequency === "14090000");
    [...presets].find(b => b.dataset.frequency === "7078000").click();
    await sleep(200);
    const cmds = await (await fetch("/commands")).json();
    check("a preset sets the dial as it is (USB-D, no offset)", cmds.some(c => c.type === "setFrequency" && c.frequency === "7078000"), JSON.stringify(cmds));
    $("jttyStreamEnabled").checked = true;
    $("jttyStreamEnabled").dispatchEvent(new Event("change"));
    await waitFor(() => /JTY\\.fe/.test($("jttyStreamSubs").textContent), 2000);
    check("the TrxNet stream switch posts and shows the listener", /JTY\\.fe/.test($("jttyStreamSubs").textContent), $("jttyStreamSubs").textContent);

    // ---- 9. settings and station profile ---------------------------------------------------
    const stored = JSON.parse(localStorage.getItem("wifilt.data.jtty-settings"));
    check("settings persisted under their key", stored && stored.v === 1 && stored.rxHz === Number($("jttyRxHz").value), JSON.stringify(stored));
    check("the station profile knows the jtty half", StationProfile.HALVES.indexOf("jtty") >= 0);
    check("RX/TX offsets stay in this browser", StationProfile.BROWSER_ONLY.indexOf("jtty.rxHz") >= 0 && StationProfile.BROWSER_ONLY.indexOf("jtty.txHz") >= 0);

    check("nothing on the way threw", bootErrors.length === 0, bootErrors.join(" | "));
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
    ...(process.env.JTTY_SMOKE_DEBUG ? ["--enable-logging=stderr", "--v=0"] : []),
    `http://127.0.0.1:${port}/jtty.html`,
  ], {stdio: ["ignore", "ignore", "pipe"]});
  let chromeErrors = "";
  chrome.stderr.on("data", chunk => {
    chromeErrors += chunk;
    if (process.env.JTTY_SMOKE_DEBUG) for (const line of String(chunk).split("\n")) if (/CONSOLE|Uncaught/.test(line)) console.log(line.slice(0, 300));
  });
  chrome.on("error", error => finish({checks: [["chrome started", false, error.message]]}));
  chrome.on("close", code => {
    if (!finished) finish({checks: [["chrome stayed up", false, `exit ${code} ${chromeErrors.slice(-400)}`]]});
  });
  timer = setTimeout(() => finish({checks: [["the page reported within the timeout", false, "no /result was posted"]]}), 120000);
});

process.on("SIGINT", () => finish({checks: [["interrupted", false, "SIGINT"]]}));
process.on("SIGTERM", () => finish({checks: [["interrupted", false, "SIGTERM"]]}));

const ERROR_COLLECTOR = `
window.__jttySmokeErrors = [];
window.addEventListener("error", e => window.__jttySmokeErrors.push(String((e.error && e.error.stack) || e.message)));
window.addEventListener("unhandledrejection", e => window.__jttySmokeErrors.push("unhandled rejection: " + String(e.reason)));
`;
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);
  if (typeof file === "string" && file.endsWith("jtty.html")) {
    const text = content.toString();
    const head = text.replace("<head>", `<head>\n<script>${ERROR_COLLECTOR}</script>`);
    return Buffer.from(`${head}\n<script>${PAGE_SCRIPT}</script>\n`);
  }
  return content;
};
