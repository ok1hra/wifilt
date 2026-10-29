#!/usr/bin/env node
"use strict";
// The real /jtty.html in headless Chrome against the real native firmware and
// the fake radio (started by tools/jtty-page-native-check.sh): live entry from
// the page's own code, over the real AUD1 socket, through tx.prepare and
// tx.extend, until the firmware reports the transmission drained. Then a whole
// message from an F-key. Driven over the DevTools protocol, so the page is
// byte-for-byte what the box serves. docs/jtty-implementace.md §6.
//
//   node --experimental-websocket tools/jtty-page-native-check.js <http-port> <app-log>

const {spawn} = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const port = Number(process.argv[2] || 8080);
const appLog = process.argv[3];
const checks = [];
const check = (name, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? " -- " + detail : ""}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "jtty-chrome-"));
  const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--no-proxy-server", "--remote-debugging-port=9333",
    `--user-data-dir=${profile}`, "--window-size=1280,900", "about:blank"], {stdio: "ignore"});
  const kill = () => { try { chrome.kill("SIGKILL"); } catch (_) {} };
  process.on("exit", kill);
  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      try { target = (await (await fetch("http://127.0.0.1:9333/json")).json()).find(t => t.type === "page"); } catch (_) {}
    }
    if (!target) throw new Error("no DevTools target");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    const consoleLines = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === "Runtime.exceptionThrown") consoleLines.push("EXC " + JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 300));
    };
    const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({id: i, method, params})); });
    const evaluate = async expr => {
      const r = await send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true});
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const key = async (type, keyName, extra) => send("Input.dispatchKeyEvent", Object.assign({type, key: keyName}, extra || {}));
    const typeText = async text => { for (const ch of text) { await send("Input.insertText", {text: ch}); await sleep(60); } };
    const waitFor = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evaluate(expr)) return true; await sleep(150); } return false; };
    const logHas = re => fs.existsSync(appLog) && re.test(fs.readFileSync(appLog, "utf8"));
    const countLog = re => fs.existsSync(appLog) ? (fs.readFileSync(appLog, "utf8").match(re) || []).length : 0;

    await send("Runtime.enable", {});
    await send("Page.navigate", {url: `http://127.0.0.1:${port}/jtty.html`});
    const ready = await waitFor(`document.getElementById("aud1State") && /ready/.test(document.getElementById("aud1State").textContent)`, 20000);
    check("the page came up with AUD1 ready", ready, await evaluate(`document.getElementById("aud1State").textContent + " / " + document.body.className`));
    check("the radio shows as online", await evaluate(`/ONLINE/.test(document.getElementById("linkState").textContent)`));
    check("no exception during boot", consoleLines.length === 0, consoleLines.join(" | "));

    // ---- live entry ----------------------------------------------------------
    const drainedBefore = countLog(/AUD1 \| TX drained/g);
    await evaluate(`document.getElementById("jttyTxText").focus()`);
    await typeText("CQ TEST ");
    await key("rawKeyDown", "j", {modifiers: 1, code: "KeyJ", windowsVirtualKeyCode: 74});
    await key("keyUp", "j", {modifiers: 1, code: "KeyJ", windowsVirtualKeyCode: 74});
    const live = await waitFor(`document.getElementById("jttyLive").classList.contains("active") && /LIVE/.test(document.getElementById("jttyTxState").textContent)`, 6000);
    check("Alt+J starts live entry", live, await evaluate(`document.getElementById("jttyTxState").textContent`));
    const keyed = await waitFor(`document.body.classList.contains("radio-transmitting")`, 6000);
    check("PTT goes on", keyed);
    await sleep(1500);
    await typeText("DE OK1HRA OK1HRA K");
    await sleep(4500);            // idle flush, a frame or two of filler in between
    const sentSoFar = await evaluate(`document.getElementById("jttyTxPreview").textContent`);
    check("typed text goes out while still live", /live: \d+ sent/.test(sentSoFar) && !/live: 0 sent/.test(sentSoFar), sentSoFar);
    check("the firmware keeps extending without a fault", !logHas(/AUD1 \| TX abort/), "see app.log");
    await key("rawKeyDown", "Enter", {code: "Enter", windowsVirtualKeyCode: 13});
    await key("keyUp", "Enter", {code: "Enter", windowsVirtualKeyCode: 13});
    const done = await waitFor(`/^sent$/.test(document.getElementById("jttyTxState").textContent)`, 20000);
    check("Enter ends it and the page reports it sent", done, await evaluate(`document.getElementById("jttyTxState").textContent`));
    check("the firmware drained it with no abort", countLog(/AUD1 \| TX drained/g) > drainedBefore && !logHas(/AUD1 \| TX abort/));
    const echo = await evaluate(`[...document.querySelectorAll("#jttyRxLog .jtty-tx .jtty-text")].map(e => e.textContent).join("|")`);
    check("the RX-frequency log shows what went out", /CQ TEST/.test(echo) && /DE OK1HRA OK1HRA K/.test(echo), echo);

    // ---- a whole message from F1 ---------------------------------------------------
    const drained2 = countLog(/AUD1 \| TX drained/g);
    await evaluate(`document.getElementById("jttyFkeys").querySelector('[data-fkey="0"]').click()`);
    const sent2 = await waitFor(`/^sent$/.test(document.getElementById("jttyTxState").textContent) && !document.body.classList.contains("radio-transmitting")`, 15000);
    check("F1 sends CQ as one message", sent2 && countLog(/AUD1 \| TX drained/g) > drained2, await evaluate(`document.getElementById("jttyTxState").textContent`));
    const f1echo = await evaluate(`[...document.querySelectorAll("#jttyRxLog .jtty-tx .jtty-text")].pop().textContent`);
    check("as WSJT-X's native CQ", f1echo === "CQ OK1HRA CQ" || /^CQ \S+ CQ$/.test(f1echo), f1echo);
    check("nothing threw", consoleLines.length === 0, consoleLines.join(" | "));
    ws.close();
  } finally {
    kill();
  }
  const failed = checks.filter(ok => !ok).length;
  console.log(failed ? `JTTY PAGE NATIVE FAIL (${failed})` : "JTTY PAGE NATIVE PASS");
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.log("  FAIL harness: " + (error && error.stack || error)); process.exit(1); });
