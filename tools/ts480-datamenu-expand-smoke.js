#!/usr/bin/env node
"use strict";
// TS-480 pill on the DATA pages: the palette's expand opens the full panel in
// its own window, the window's collapse closes it and drops the palette again
// (local-trx webui/ts480/datamenu.js + panel.html ?from=data).
//
// local-trx --ts480-sim + a page with the DATA pages' nav.subtabs that loads
// config.js + datamenu.js the way addon-tabs.js does + headless Chrome over
// CDP (--remote-debugging-pipe). Clicks are real Input.dispatchMouseEvent
// events: window.open from a scripted el.click() is not a user gesture, and a
// pop-up blocker would make the test prove nothing.
//
//   make -C local-trx && node tools/ts480-datamenu-expand-smoke.js
// No sound card is opened (audio devices "" in the generated config).
const http = require("http"), path = require("path"), fs = require("fs"), os = require("os");
const { spawn } = require("child_process");

const LTX = path.resolve(__dirname, "..", "local-trx");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ts480-dm-"));
fs.mkdirSync(path.join(TMP, "cfg"));
fs.writeFileSync(path.join(TMP, "cfg", "config.json"), JSON.stringify({
  audio: { inputDevice: "", outputDevice: "" },
  cat: { backend: "hamlib", baud: 9600, port: "", rigModel: 1 },
  enabled: true,
  identity: { civAddress: "A6", radioName: "LOCAL-TRX" },
  keying: { keyLine: "none", pttLine: "none", port: "" },
  listenIp: "127.0.0.78",
}, null, 2));
const WEB = 18775, PAGE = 18790;
const checks = [];
const check = (name, ok, detail) => { checks.push([name, !!ok, detail || ""]); console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ltx = spawn(path.join(LTX, "build/local-trx"),
  ["--config-dir", path.join(TMP, "cfg"), "--web-port", String(WEB), "--web-root", path.join(LTX, "webui"), "--ts480-sim"],
  { stdio: ["ignore", fs.openSync(path.join(TMP, "local-trx.log"), "w"), fs.openSync(path.join(TMP, "local-trx.err"), "w")] });

const html = `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head>
<body style="margin:0;height:100vh;background:#222;color:#ddd">
<header class="site-topbar"><nav class="subtabs" style="display:flex;width:900px"><a>JS8</a><a>RTTY</a></nav></header>
<script src="http://127.0.0.1:${WEB}/ts480/config.js"></script>
<script>document.write('<script src="http://127.0.0.1:${WEB}/ts480/datamenu.js?v=' + encodeURIComponent((window.LTX_TS480 || {}).rev || 0) + '"><\\/script>')</script>
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

async function ev(expr, sessionId) {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result.value;
}
async function waitFor(expr, ms, what, sessionId) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(expr, sessionId)) return true;
    await sleep(50);
  }
  throw new Error("timeout: " + what);
}
// A real click (a user gesture) in the middle of the element `selector` matches.
async function click(selector, sessionId) {
  const p = await ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, sessionId);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }, sessionId);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 }, sessionId);
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 }, sessionId);
}
async function panelTargets() {
  const { targetInfos } = await cdp("Target.getTargets");
  return targetInfos.filter(t => t.type === "page" && t.url.includes("/ts480/panel.html"));
}
async function waitTargets(n, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = await panelTargets();
    if (t.length === n) return t;
    await sleep(50);
  }
  throw new Error("timeout: " + what + " (" + (await panelTargets()).length + " panel windows)");
}

const PAL_OPEN = `!document.getElementById("ts480DataPalette").hidden`;

async function main() {
  await sleep(1200);
  const { targetInfos } = await cdp("Target.getTargets");
  const page = targetInfos.find(t => t.type === "page");
  const s = (await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
  await cdp("Page.enable", {}, s);
  await cdp("Runtime.enable", {}, s);
  await cdp("Page.navigate", { url: `http://127.0.0.1:${PAGE}/` }, s);
  await sleep(800);
  await waitFor(`!!document.querySelector(".ltx480-dm") && !document.querySelector(".ltx480-dm").hidden`, 8000, "TS480 pill", s);

  await click(".ltx480-dm-pill", s);
  await waitFor(PAL_OPEN, 2000, "palette", s);
  const ext = await ev(`(() => { const b = document.querySelector("#ts480DataPalette .ltx480-dm-ext");
    return b && { svg: !!b.querySelector("svg"), title: b.title, row: b.parentNode === document.querySelector("#ts480DataPalette .ltx480-dm-row"),
                  last: b === b.parentNode.lastElementChild }; })()`, s);
  check("expand button in the palette's first row, at its right end", ext && ext.row && ext.last, JSON.stringify(ext));
  check("it is the expand pictogram (svg), titled", ext && ext.svg && /full panel/.test(ext.title), ext && ext.title);

  // ---- expand: palette closes, panel.html?from=data opens in its own window
  await click("#ts480DataPalette .ltx480-dm-ext", s);
  const [win] = await waitTargets(1, 4000, "panel window");
  check("expand opens panel.html in its own window", true, win.url);
  check("marked as opened from a DATA page", new URL(win.url).searchParams.get("from") === "data", win.url);
  check("the palette closed", !(await ev(PAL_OPEN, s)));

  const ps = (await cdp("Target.attachToTarget", { targetId: win.targetId, flatten: true })).sessionId;
  await cdp("Runtime.enable", {}, ps);
  await waitFor(`document.readyState === "complete" && !!document.querySelector(".ltx480-end")`, 4000, "collapse button", ps);
  const title = await ev(`document.querySelector(".ltx480-end").title`, ps);
  check("collapse names the DATA palette, not QRPlog", title === "Back into the DATA page's TS480 palette", title);

  // ---- expand again while the window is open: brought forward, not a second one
  await click(".ltx480-dm-pill", s);
  await waitFor(PAL_OPEN, 2000, "palette again", s);
  await click("#ts480DataPalette .ltx480-dm-ext", s);
  await sleep(600);
  const again = await panelTargets();
  check("a second expand reuses the open window", again.length === 1 && again[0].targetId === win.targetId, String(again.length));

  // ---- collapse: window closes, the DATA palette drops again
  await click(".ltx480-end", ps);
  await waitTargets(0, 4000, "panel window closed");
  check("collapse closes the window", true);
  await waitFor(PAL_OPEN, 2000, "palette back after collapse", s);
  check("and the DATA palette is open again", true);

  // ---- pop-up blocked: the palette stays and says so
  await ev(`window.open = () => null, true`, s);
  await click("#ts480DataPalette .ltx480-dm-ext", s);
  await sleep(200);
  const msg = await ev(`document.querySelector("#ts480DataPalette .ltx480-dm-msg").textContent`, s);
  check("blocked pop-up: palette stays open", await ev(PAL_OPEN, s));
  check("and says the browser blocked it", /blocked the pop-up/.test(msg), msg);
}

// Resolves when the child has exited (or after `ms` regardless): Chrome keeps
// writing its profile for a moment after the kill, and removing TMP under it
// throws ENOTEMPTY.
const exited = (child, ms) => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  const t = setTimeout(resolve, ms);
  child.once("exit", () => { clearTimeout(t); resolve(); });
});

let finished = false;
async function done() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  const failed = checks.filter(c => !c[1]).length;
  console.log(`\nTS480 DATA EXPAND ${failed ? "FAIL" : "PASS"} ${checks.length - failed}/${checks.length}`);
  try { chrome.kill("SIGTERM"); } catch (_) {}
  try { ltx.kill("SIGTERM"); } catch (_) {}
  server.close();
  await Promise.all([exited(chrome, 3000), exited(ltx, 3000)]);
  try { if (ltx.exitCode === null && ltx.signalCode === null) ltx.kill("SIGKILL"); } catch (_) {}
  if (failed) console.log("logs kept in " + TMP);
  else try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
  process.exit(failed ? 1 : 0);
}
const timer = setTimeout(() => { check("overall timeout", false); done(); }, 60000);
main().then(done, e => { check("ran to the end", false, e.message); done(); });
