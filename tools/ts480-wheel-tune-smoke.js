#!/usr/bin/env node
"use strict";
// TS-480 palette in QRPlog: the mouse wheel over the LCD's frequency digits
// tunes the radio (local-trx webui/ts480/client.js attachWheelTune).
//
// local-trx --ts480-sim (so the keypad path: the simulator is not CAT's radio)
// + a page that loads the palette the way QRPlog's log.js does + headless
// Chrome driven over CDP (--remote-debugging-pipe, no WebSocket module needed)
// with real Input.dispatchMouseEvent wheel events -- a synthetic WheelEvent
// would not prove the hit test against the rendered, scaled SVG.
//
//   make -C local-trx && node tools/ts480-wheel-tune-smoke.js
// No sound card is opened (audio devices "" in the generated config).
const http = require("http"), path = require("path"), fs = require("fs"), os = require("os");
const { spawn } = require("child_process");

const LTX = path.resolve(__dirname, "..", "local-trx");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ts480-wheel-"));
fs.mkdirSync(path.join(TMP, "cfg"));
fs.writeFileSync(path.join(TMP, "cfg", "config.json"), JSON.stringify({
  audio: { inputDevice: "", outputDevice: "" },
  cat: { backend: "hamlib", baud: 9600, port: "", rigModel: 1 },
  enabled: true,
  identity: { civAddress: "A6", radioName: "LOCAL-TRX" },
  keying: { keyLine: "none", pttLine: "none", port: "" },
  listenIp: "127.0.0.77",
}, null, 2));
const WEB = 18765, WS = 18766, PAGE = 18780;
const checks = [];
const check = (name, ok, detail) => { checks.push([name, !!ok, detail || ""]); console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ltx = spawn(path.join(LTX, "build/local-trx"),
  ["--config-dir", path.join(TMP, "cfg"), "--web-port", String(WEB), "--web-root", path.join(LTX, "webui"), "--ts480-sim"],
  { stdio: ["ignore", fs.openSync(path.join(TMP, "local-trx.log"), "w"), fs.openSync(path.join(TMP, "local-trx.err"), "w")] });

const html = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head>
<body style="margin:0;height:100vh;background:#222">
<div class="log-btn-group" style="position:fixed;right:10px;bottom:10px"><button id="btnPa">PA</button></div>
<script src="http://127.0.0.1:${WEB}/ts480/config.js"></script>
<script src="http://127.0.0.1:${WEB}/ts480/qrplog.js"></script>
</body></html>`;
const server = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(html); }).listen(PAGE);

const prof = path.join(TMP, "chrome");
const chrome = spawn(process.env.CHROME || "google-chrome", ["--headless=new", "--remote-debugging-pipe", "--no-first-run",
  "--no-default-browser-check", "--disable-gpu", `--user-data-dir=${prof}`, "--window-size=1200,800", "about:blank"],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const toChrome = chrome.stdio[3], fromChrome = chrome.stdio[4];
let seq = 0, buf = Buffer.alloc(0);
const waiting = new Map();
fromChrome.on("data", d => {
  buf = Buffer.concat([buf, d]);
  let i;
  while ((i = buf.indexOf(0)) >= 0) {
    const msg = JSON.parse(buf.slice(0, i).toString("utf8"));
    buf = buf.slice(i + 1);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  }
});
function cdp(method, params = {}, sessionId) {
  const id = ++seq;
  toChrome.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  return new Promise((res, rej) => waiting.set(id, m => m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result)));
}

let session;
async function ev(expr) {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, session);
  if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result.value;
}
const mouse = (type, x, y, extra = {}) => cdp("Input.dispatchMouseEvent", { type, x, y, ...extra }, session);
const wheel = (x, y, deltaY) => mouse("mouseWheel", x, y, { deltaX: 0, deltaY });

// In the page: the observer socket, a 7-segment reader for the palette's LCD,
// screen coordinates of digit i.
const HELPERS = `
window.__t = { st: null, entries: 0, entering: false, prevented: [] };
(function () {
  const ws = new WebSocket("ws://127.0.0.1:${WS}/ts480");
  ws.onmessage = e => {
    if (typeof e.data !== "string") return;
    const m = JSON.parse(e.data);
    if (m.type !== "state") return;
    __t.st = m.state;
    const ent = !!(m.state && /^[0-9]*-+$/.test(m.state.status || ""));
    if (ent && !__t.entering) __t.entries++;
    __t.entering = ent;
  };
  window.addEventListener("wheel", e => __t.prevented.push(e.defaultPrevented));
})();
window.__svg = () => document.querySelector(".ltx480-pal-body svg");
window.__pt = i => {
  const p = new DOMPoint(753 + i * 49 + 15, 343 + 28).matrixTransform(__svg().getScreenCTM());
  return { x: p.x, y: p.y };
};
window.__lcd = () => {
  const SEG = { "abcdef": "0", "bc": "1", "abdeg": "2", "abcdg": "3", "bcfg": "4", "acdfg": "5", "acdefg": "6",
    "abc": "7", "abcdefg": "8", "abcdfg": "9", "": " " };
  let out = "";
  for (let i = 0; i < 7; i++) {
    const g = [...__svg().querySelectorAll("g")].find(g => (g.getAttribute("transform") || "").startsWith("translate(" + (753 + i * 49) + ",343)") && g.querySelector("polygon"));
    const polys = [...g.querySelectorAll("polygon")], names = ["a", "d", "f", "e", "b", "c", "g"];
    const lit = names.filter((n, k) => polys[k].classList.contains("on")).sort().join("");
    out += SEG[lit] ?? "?";
    const dp = g.querySelector("rect");
    if (dp && dp.classList.contains("on")) out += ".";
  }
  return out;
};
window.__mark = () => { const m = __svg().querySelector(".tunemark"); return m.classList.contains("on") ? m.parentNode.getAttribute("transform") : ""; };
true;`;

async function waitFor(expr, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(expr)) return true;
    await sleep(50);
  }
  const dbg = await ev(`JSON.stringify({cfg: window.LTX_TS480, btn: !!document.getElementById("btnTs480"), hidden: document.getElementById("btnTs480") && document.getElementById("btnTs480").hidden, st: window.__t && __t.st, scripts: [...document.scripts].map(s => s.src), lcd: typeof Ts480Lcd, cl: typeof Ts480Client, flag: window.__ltx480Palette})`);
  throw new Error("timeout: " + what + " " + dbg);
}
const freqHz = () => ev("__t.st && __t.st.freq_hz");

async function main() {
  await sleep(1200);
  const { targetInfos } = await cdp("Target.getTargets");
  const page = targetInfos.find(t => t.type === "page");
  session = (await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
  await cdp("Page.enable", {}, session);
  await cdp("Runtime.enable", {}, session);
  await cdp("Page.navigate", { url: `http://127.0.0.1:${PAGE}/` }, session);
  await sleep(800);
  await ev(HELPERS);
  await waitFor(`!!document.getElementById("btnTs480") && !document.getElementById("btnTs480").hidden`, 8000, "TS480 button");
  await ev(`document.getElementById("btnTs480").click(), true`);
  await waitFor(`!!__svg() && !document.getElementById("ts480Panel").hidden`, 3000, "palette");
  await ev(`document.querySelector("#ts480Panel .ltx480-pwr").click(), true`);
  await waitFor(`__t.st && __t.st.power === true && __t.st.freq_hz > 0`, 8000, "power on");
  await sleep(500);
  const f0 = await freqHz();
  check("sim starts on 14.074.00", f0 === 14074000, String(f0));
  check("LCD reads it", (await ev("__lcd()")) === "14.074.00", await ev("__lcd()"));

  // MHz digit: no mark, wheel passes through untouched.
  let p = await ev("__pt(1)");
  await mouse("mouseMoved", p.x, p.y);
  check("hover MHz digit: no tuning mark", (await ev("__mark()")) === "");
  await wheel(p.x, p.y, -100);
  await sleep(900);
  check("wheel on MHz digit: not tuned", (await freqHz()) === 14074000, String(await freqHz()));
  check("wheel on MHz digit: event not consumed", (await ev("__t.prevented.at(-1)")) === false);

  // kHz digit: mark + cursor, one notch up.
  p = await ev("__pt(4)");
  await mouse("mouseMoved", p.x, p.y);
  check("hover kHz digit: mark under digit 4", (await ev("__mark()")).startsWith("translate(" + (753 + 4 * 49) + ","), await ev("__mark()"));
  check("hover kHz digit: ns-resize cursor", (await ev("__svg().style.cursor")) === "ns-resize");
  const e0 = await ev("__t.entries");
  await wheel(p.x, p.y, -100);
  await sleep(60);
  check("wheel up on kHz: LCD shows 14.075.00 at once", (await ev("__lcd()")) === "14.075.00", await ev("__lcd()"));
  check("wheel up on kHz: event consumed", (await ev("__t.prevented.at(-1)")) === true);
  check("radio not there yet (keypad entry pending)", (await freqHz()) === 14074000);
  await waitFor(`__t.st.freq_hz === 14075000`, 4000, "14075000");
  check("radio reaches 14.075.00", true);
  await sleep(300);
  check("one keypad entry", (await ev("__t.entries")) - e0 === 1, String((await ev("__t.entries")) - e0));
  check("LCD still 14.075.00", (await ev("__lcd()")) === "14.075.00", await ev("__lcd()"));

  // 10 Hz digit: three fast notches = one entry of +30 Hz.
  p = await ev("__pt(6)");
  await mouse("mouseMoved", p.x, p.y);
  const e1 = await ev("__t.entries");
  for (let k = 0; k < 3; k++) { await wheel(p.x, p.y, -100); await sleep(40); }
  check("3 notches on 10 Hz: LCD 14.075.03 at once", (await ev("__lcd()")) === "14.075.03", await ev("__lcd()"));
  await waitFor(`__t.st.freq_hz === 14075030`, 4000, "14075030");
  await sleep(400);
  check("3 notches: one keypad entry", (await ev("__t.entries")) - e1 === 1, String((await ev("__t.entries")) - e1));

  // 100 kHz digit down, across the 14 MHz boundary.
  p = await ev("__pt(2)");
  await mouse("mouseMoved", p.x, p.y);
  await wheel(p.x, p.y, 100);
  await sleep(60);
  check("wheel down on 100 kHz: LCD 13.975.03", (await ev("__lcd()")) === "13.975.03", await ev("__lcd()"));
  await waitFor(`__t.st.freq_hz === 13975030`, 4000, "13975030");
  check("radio reaches 13.975.03", true);

  // A notch while the keypad is still typing the previous one continues from it.
  p = await ev("__pt(3)");
  await mouse("mouseMoved", p.x, p.y);
  await wheel(p.x, p.y, -100);
  await waitFor(`__t.entering`, 2000, "entry started");
  check("during the entry the LCD keeps 13.985.03", (await ev("__lcd()")) === "13.985.03", await ev("__lcd()"));
  await wheel(p.x, p.y, -100);
  await sleep(60);
  check("second notch mid-entry: LCD 13.995.03", (await ev("__lcd()")) === "13.995.03", await ev("__lcd()"));
  await waitFor(`__t.st.freq_hz === 13995030 && !__t.entering`, 6000, "13995030");
  check("radio ends on 13.995.03", true);
  await sleep(500);
  check("LCD 13.995.03 after it settled", (await ev("__lcd()")) === "13.995.03", await ev("__lcd()"));

  // Touchpad: small deltas accumulate, 40 px = one notch.
  p = await ev("__pt(5)");
  await mouse("mouseMoved", p.x, p.y);
  for (let k = 0; k < 4; k++) { await wheel(p.x, p.y, -12); await sleep(20); }   // 48 px = one notch
  await sleep(60);
  check("touchpad 4x12 px on 100 Hz: one notch", (await ev("__lcd()")) === "13.995.13", await ev("__lcd()"));
  await waitFor(`__t.st.freq_hz === 13995130`, 4000, "13995130");

  // Below 10 MHz the leading digit is blank.
  p = await ev("__pt(2)");
  await mouse("mouseMoved", p.x, p.y);
  await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: 0, deltaY: 100 * 40 }, session);   // a coalesced burst: 40 notches
  await sleep(60);
  check("40-notch burst on 100 kHz: LCD  9.995.13", (await ev("__lcd()")) === " 9.995.13", JSON.stringify(await ev("__lcd()")));
  await waitFor(`__t.st.freq_hz === 9995130`, 4000, "9995130");
  check("radio reaches 9.995.13", true);

  // Power off: no mark, no tuning.
  await ev(`document.querySelector("#ts480Panel .ltx480-pwr").click(), true`);
  await waitFor(`__t.st && __t.st.power === false`, 6000, "power off");
  p = await ev("__pt(4)");
  await mouse("mouseMoved", p.x + 1, p.y);
  check("power off: no mark", (await ev("__mark()")) === "");
  await wheel(p.x, p.y, -100);
  check("power off: wheel not consumed", (await ev("__t.prevented.at(-1)")) === false);
}

const timer = setTimeout(() => { check("overall timeout", false); done(); }, 90000);
function done() {
  clearTimeout(timer);
  try { chrome.kill("SIGTERM"); } catch (_) {}
  try { ltx.kill("SIGTERM"); } catch (_) {}
  server.close();
  const failed = checks.filter(c => !c[1]).length;
  console.log(`WHEEL TUNE ${failed ? "FAIL" : "PASS"} ${checks.length - failed}/${checks.length}`);
  if (failed) console.log("local-trx logs kept in " + TMP);
  setTimeout(() => {
    if (!failed) fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  }, 500);
}
main().then(done, e => { check("exception", false, e.message); done(); });
