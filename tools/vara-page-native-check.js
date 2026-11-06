#!/usr/bin/env node
"use strict";
// The real /vara.html in headless Chrome against the real native firmware and
// the fake radio (started by tools/vara-page-native-check.sh). The modem worker
// runs off the fake radio's RX tone; what it keys is streamed through the real
// firmware's AUD1 TX path, which is the point: the firmware must accept every
// keyed stretch as one transmission -- tx.prepare, tx.extend while it lasts,
// FIRST/LAST on its ends -- and drain it without an abort. Driven over the
// DevTools protocol, so the page is byte-for-byte what the box serves.
//
//   node --experimental-websocket tools/vara-page-native-check.js <http-port> <app-log>

const {spawn} = require("child_process");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const port = Number(process.argv[2] || 8080);
const appLog = process.argv[3];
const checks = [];
const check = (name, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vara-chrome-"));
  const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--no-proxy-server", "--remote-debugging-port=9334",
    `--user-data-dir=${profile}`, "--window-size=1280,900", "about:blank"], {stdio: "ignore"});
  const kill = () => { try { chrome.kill("SIGKILL"); } catch (_) {} };
  process.on("exit", kill);
  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      try { target = (await (await fetch("http://127.0.0.1:9334/json")).json()).find(t => t.type === "page"); } catch (_) {}
    }
    if (!target) throw new Error("no DevTools target");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text).slice(0, 300));
    };
    const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({id: i, method, params})); });
    const evaluate = async expr => {
      const r = await send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true});
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    // The page may still be loading (or behind the LAN gate): an expression
    // that throws is "not yet", not a failure.
    const waitFor = async (expr, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { try { if (await evaluate(expr)) return true; } catch (_) {} await sleep(150); }
      return false;
    };
    const log = () => fs.existsSync(appLog) ? fs.readFileSync(appLog, "utf8") : "";
    const count = re => (log().match(re) || []).length;
    const text = idName => evaluate(`document.getElementById(${JSON.stringify(idName)}).textContent`);
    const hostLog = () => text("hostLog");

    await send("Runtime.enable", {});
    await send("Page.navigate", {url: `http://127.0.0.1:${port}/vara.html`});
    const ready = await waitFor(`/ready/.test(document.getElementById("aud1State").textContent)`, 20000);
    check("the page came up with AUD1 ready", ready, await text("aud1State"));
    check("my callsign comes from the station identity", (await text("myCall")) === "OK1HRA", await text("myCall"));
    const listening = await waitFor(`document.getElementById("stState").textContent === "Listen"`, 8000);
    check("the modem runs and reports its state", listening, await text("stState"));
    const load = await waitFor(`/%/.test(document.getElementById("stLoad").textContent)`, 8000);
    check("the modem keeps up with the radio", load, await text("stLoad"));
    check("no exception during boot", errors.length === 0, errors.join(" | "));
    const sessionInfo = await (await fetch(`http://127.0.0.1:${port}/vara/session`)).json().catch(() => ({}));
    check("the lease is held under /vara/session as role vara", sessionInfo.role === "vara", JSON.stringify(sessionInfo).slice(0, 160));

    // ---- TUNE: one keyed stretch, one transmission ---------------------------
    let drained = count(/AUD1 \| TX drained/g);
    await evaluate(`document.getElementById("tuneButton").click()`);
    const keyed = await waitFor(`document.getElementById("stState").textContent === "TUNE"`, 4000);
    check("TUNE keys the modem", keyed, await text("stState"));
    await sleep(2500);
    check("the firmware keyed the radio", /AUD1 \| TX ready/.test(log()) && !/AUD1 \| TX abort/.test(log()));
    await evaluate(`document.getElementById("tuneButton").click()`);
    const tuneDone = await waitFor(`document.getElementById("stState").textContent === "Listen"`, 4000);
    await sleep(1500);
    check("STOP TUNE ends it and the firmware drains it", tuneDone && count(/AUD1 \| TX drained/g) === drained + 1,
      `drained ${count(/AUD1 \| TX drained/g) - drained}`);

    // ---- CQ frame -------------------------------------------------------------
    drained = count(/AUD1 \| TX drained/g);
    await evaluate(`document.getElementById("cqButton").click()`);
    const cqSent = await waitFor(`/OK/.test(document.getElementById("hostLog").textContent.split("CQFRAME").pop())`, 4000);
    check("CQFRAME is accepted", cqSent, (await hostLog()).split("\n").slice(-3).join(" / "));
    await sleep(6000);
    check("the CQ frame goes out and drains", count(/AUD1 \| TX drained/g) > drained, `drained ${count(/AUD1 \| TX drained/g) - drained}`);

    // ---- CONNECT to nobody: repeated calls, each its own transmission ----------
    drained = count(/AUD1 \| TX drained/g);
    await evaluate(`(() => { const p = document.getElementById("peerCall"); p.value = "N1CALL"; p.dispatchEvent(new Event("input")); document.getElementById("connectButton").click(); })()`);
    const calling = await waitFor(`document.getElementById("stState").textContent.startsWith("Calling")`, 4000);
    check("CONNECT starts calling", calling, await text("stState"));
    await sleep(12000);
    const calls = count(/AUD1 \| TX drained/g) - drained;
    check("every call attempt drains on its own", calls >= 2, `${calls} drained`);
    await evaluate(`document.getElementById("abortButton").click()`);
    const back = await waitFor(`document.getElementById("stState").textContent === "Listen"`, 8000);
    check("ABORT returns to listening", back, await text("stState"));
    // ABORT above cut the call that was on the air -- that one is ours.
    const aborts = (log().match(/AUD1 \| TX abort[^\n]*/g) || []).filter(l => !/operator abort/.test(l));
    check("the firmware never aborted a transmission on its own", aborts.length === 0, aborts.slice(0, 3).join(" | "));

    // ---- settings -------------------------------------------------------------
    await evaluate(`(() => { document.getElementById("setLatency").value = "420"; document.getElementById("settingsSave").click(); })()`);
    await waitFor(`/saved/.test(document.getElementById("settingsSaveStatus").textContent)`, 4000);
    const saved = await (await fetch(`http://127.0.0.1:${port}/vara-settings.json`)).json().catch(() => ({}));
    check("settings are stored on the device", saved.latencyMs === 420, JSON.stringify(saved));

    // ---- a Winlink client on TCP 8300/8301 (phase 4) ----------------------------
    // What Pat does, byte for byte: commands with CR, replies one per command,
    // events in between; data on the second socket.
    const tcp = portNo => new Promise((res, rej) => {
      const sock = net.connect(portNo, "127.0.0.1");
      const c = {sock, lines: [], raw: Buffer.alloc(0), closed: false};
      sock.on("data", d => {
        c.raw = Buffer.concat([c.raw, d]);
        let i;
        while ((i = c.raw.indexOf(13)) >= 0) { c.lines.push(c.raw.subarray(0, i).toString("latin1")); c.raw = c.raw.subarray(i + 1); }
      });
      sock.on("close", () => { c.closed = true; });
      sock.on("error", () => { c.closed = true; });
      sock.on("connect", () => res(c));
      setTimeout(() => rej(new Error("connect timeout")), 3000);
    });
    const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100); } return false; };
    const cmd = await tcp(8300), data = await tcp(8301);
    const shown = await waitFor(`document.getElementById("stHost").textContent === "127.0.0.1"`, 4000);
    check("the page shows the client attached", shown, await text("stHost"));
    const ask = async (line, re) => {
      const from = cmd.lines.length;
      cmd.sock.write(line + "\r");
      const ok = await until(() => cmd.lines.slice(from).some(l => re.test(l)), 4000);
      return [ok, cmd.lines.slice(from).join(" | ")];
    };
    let r = await ask("VERSION", /^VERSION VARA HF/);
    check("VERSION answers like VARA HF", r[0], r[1]);
    r = await ask("MYCALL OK1HRA", /^OK$/);
    check("MYCALL is accepted", r[0], r[1]);
    r = await ask("BW2300", /^OK$/);
    check("BW2300 is accepted", r[0], r[1]);
    // Unlinked, the modem queues it for the next link without a BUFFER report
    // (station.send in Listen, as upstream) -- the page's TX QUEUE shows it.
    data.sock.write("hello world");
    const queued = await waitFor(`document.getElementById("stBuffer").textContent === "11 B"`, 4000);
    check("data on 8301 reaches the modem's queue", queued, await text("stBuffer"));
    let from = cmd.lines.length;
    // A command from the page answers the page, not the client.
    from = cmd.lines.length;
    await evaluate(`(() => { const s = document.getElementById("sessionSelect"); s.value = "winlink"; s.dispatchEvent(new Event("change")); })()`);
    await sleep(1200);
    check("a command from the page sends the client no reply", !cmd.lines.slice(from).some(l => l === "OK" || l === "WRONG"),
      cmd.lines.slice(from).join(" | "));
    r = await ask("CONNECT OK1HRA N1CALL", /^PTT OFF$/);
    check("CONNECT keys the radio and reports PTT ON/OFF", r[0] && /PTT ON/.test(r[1]), r[1]);
    r = await ask("ABORT", /^OK$/);
    check("ABORT is accepted", r[0], r[1]);
    const idle = await waitFor(`document.getElementById("stState").textContent === "Listen"`, 8000);
    check("the modem is back to listening", idle, await text("stState"));
    cmd.sock.end();
    const both = await until(() => data.closed, 4000);
    check("closing the command socket closes the data socket too", both);
    const gone = await waitFor(`document.getElementById("stHost").textContent === "—"`, 4000);
    check("the page shows the client gone", gone, await text("stHost"));
    check("the firmware logged the host session", /VARA\| cmd client connected/.test(log()) && /VARA\| host closed/.test(log()));

    // ---- no page, no modem: a client is turned away ------------------------------
    await send("Page.navigate", {url: "about:blank"});
    await sleep(2500);
    const lone = await tcp(8300).catch(() => null);
    const refused = lone ? await until(() => lone.closed, 4000) : true;
    check("with no XARA page open a client is refused at once", refused && /client refused: no XARA page/.test(log()));
    if (lone && !lone.closed) lone.sock.destroy();

    check("nothing threw", errors.length === 0, errors.join(" | "));
    ws.close();
  } finally {
    kill();
  }
  const failed = checks.filter(ok => !ok).length;
  console.log(failed ? `XARA PAGE NATIVE FAIL (${failed})` : "XARA PAGE NATIVE PASS");
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.log("  FAIL harness: " + (error && error.stack || error)); process.exit(1); });
