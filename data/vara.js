// XARA (VARA-compatible) page (docs/vara-implementace.md, phase 3).
//
// The modem lives in data/vara-worker.js; this page is its first host: what
// the CONNECT/LISTEN/TERMINAL controls do is send the same VARA host commands
// a Winlink client would (CONNECT A B, LISTEN ON, BW2300, ...) and show the
// replies, so the TCP bridge of phase 4 plugs a real client into the same
// command path instead of a second one.
//
// The radio lease is the one every DATA page shares, under /vara/session
// (mercury-session.js's WifiltLease), claimed at load and held for the page's
// life, like Mercury: the worker owns the AUD1 socket the whole time, the
// waterfall runs off it, and LISTEN decides only whether this station answers.
(function () {
  "use strict";
  const VARA_WORKER_REV = "93ff9b79"; // stamped from /vara-worker.js
  const audioWsPort = () => Number((window.WIFILT_PORTS || {}).audio) || 83;
  const SETTINGS_URL = "/vara-settings.json";
  const DEFAULTS = {bw: 2300, p2p: true, driveDb: -5, latencyMs: 350, slotMs: 200, prebufferMs: 120};
  const LOG_LINES = 400, CHAT_CHARS = 60000;

  const dom = {};
  const byId = id => document.getElementById(id);
  let worker = null, lease = null, ownLease = false, settings = {...DEFAULTS};
  let myCall = "", status = null, radio = {connected: false, tx: false}, hostPeer = "";
  const rxText = new TextDecoder("utf-8");

  function normalise(raw) {
    const s = {...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {})};
    const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d; };
    s.bw = s.bw === "fmn" || s.bw === "fmw" ? s.bw : [500, 2300, 2750].includes(Number(s.bw)) ? Number(s.bw) : DEFAULTS.bw;
    s.link16k = s.link16k === true;
    s.p2p = s.p2p !== false;
    s.driveDb = num(s.driveDb, -30, 0, DEFAULTS.driveDb);
    s.latencyMs = num(s.latencyMs, 50, 2000, DEFAULTS.latencyMs);
    s.slotMs = num(s.slotMs, 100, 1000, DEFAULTS.slotMs);
    s.prebufferMs = num(s.prebufferMs, 20, Math.max(20, s.slotMs - 40), DEFAULTS.prebufferMs);
    return s;
  }
  // "Enable radio TX": the pledge the JS8 and WSPR pages share, in this
  // browser's Js8Settings blob. Read fresh every time, so ticking it on either
  // of the other pages counts here at once (the storage event re-renders).
  function txEnabled() {
    try {
      const js8 = Js8Settings.load(localStorage).settings.modems.js8call;
      return Boolean(js8 && js8.txSafetyAccepted);
    } catch (_e) { return false; }
  }
  function setTxEnabled(on) {
    try {
      const all = Js8Settings.load(localStorage).settings;
      all.modems.js8call.txSafetyAccepted = on;
      Js8Settings.save(localStorage, all);
    } catch (_e) { /* private mode: the page still follows the box for this load */ }
  }
  let txOn = false;
  function applyTxEnabled() {
    const on = txEnabled();
    dom.txSafety.checked = on;
    if (on === txOn) return;
    txOn = on;
    post({type: "configure", settings: {txEnabled: on}});
    renderStatus();
  }
  // Where the TxPledge toast's GO TO SETTING lands.
  function revealTxSafety() {
    const section = dom.txSafety.closest("details[data-section]");
    if (section) section.open = true;
    const row = dom.txSafety.closest("label") || dom.txSafety;
    row.scrollIntoView({behavior: "smooth", block: "center"});
    row.classList.add("setting-reveal");
    setTimeout(() => row.classList.remove("setting-reveal"), 2000);
  }
  const PLEDGE = window.TxPledge ? TxPledge.PLEDGE : "confirm Enable radio TX";
  // A control that keys: blocked by `reasons`, or -- when TX is all that is
  // missing -- left clickable for the pledge toast to explain (tx-pledge.js).
  function gateTx(el, blocked) {
    const reasons = blocked ? ["blocked"] : txOn ? [] : [PLEDGE];
    if (window.TxPledge) TxPledge.gate(el, reasons);
    else el.disabled = reasons.length > 0;
  }

  async function loadSettings() {
    try {
      const r = await fetch(SETTINGS_URL, {cache: "no-store"});
      if (r.ok) settings = normalise(await r.json());
    } catch (_e) { settings = normalise(null); }
  }

  // ---- logs ------------------------------------------------------------------
  function appendLine(pre, text, cls) {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text;
    pre.appendChild(line);
    while (pre.childNodes.length > LOG_LINES) pre.removeChild(pre.firstChild);
    pre.scrollTop = pre.scrollHeight;
  }
  const stamp = () => new Date().toISOString().slice(11, 19);
  function hostLog(text, cls) { appendLine(dom.hostLog, `${stamp()} ${text}`, cls); }
  function chatSystem(text) { appendLine(dom.chatLog, `— ${text} —`, "vara-chat-system"); }
  function chatText(text, cls) {
    // Received text arrives in pieces; keep appending to the last block of the
    // same kind so a line split across two frames stays one line.
    let last = dom.chatLog.lastElementChild;
    if (!last || last.className !== cls) { last = document.createElement("div"); last.className = cls; dom.chatLog.appendChild(last); }
    last.textContent += text.replace(/\r\n?/g, "\n");
    while (dom.chatLog.textContent.length > CHAT_CHARS && dom.chatLog.childNodes.length > 1) dom.chatLog.removeChild(dom.chatLog.firstChild);
    dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
  }

  // ---- worker -----------------------------------------------------------------
  function post(msg) { if (worker) worker.postMessage(msg); }
  function command(line) { hostLog(`> ${line}`, "vara-log-cmd"); post({type: "cmd", line}); }

  function startWorker() {
    if (worker) return;
    worker = new Worker(`/vara-worker.js?v=${VARA_WORKER_REV}`);
    worker.onmessage = event => onWorker(event.data || {});
    worker.onerror = event => { setAud1("error", "error"); hostLog(`worker error: ${event.message || event}`, "vara-log-error"); };
    worker.postMessage({type: "start", wsPort: audioWsPort(), token: lease.token(),
      settings: {...settings, mycall: myCall, listen: Boolean(myCall) && lease.isArmed(), txEnabled: txOn}});
  }
  function stopWorker() {
    if (!worker) return;
    try { worker.postMessage({type: "stop"}); } catch (_e) { /* gone */ }
    const w = worker;
    worker = null;
    setTimeout(() => w.terminate(), 500);
  }

  function onWorker(m) {
    switch (m.type) {
      case "status": status = m; renderStatus(); break;
      case "line": onHostLine(m.line); break;
      case "data": chatText(rxText.decode(m.bytes, {stream: true}), "vara-chat-rx"); break;
      case "trace": hostLog(`  ${m.text}`, "vara-log-trace"); break;
      case "host":
        if (m.cmd || m.data) { if (!hostPeer) chatSystem(`Winlink client ${m.peer || ""} attached on TCP 8300/8301`); hostPeer = m.peer || "client"; }
        else if (hostPeer) { chatSystem("Winlink client left"); hostPeer = ""; }
        break;
      case "rx-samples":
        if (!waterfall) break;
        setWaterfallRate(m.rate || 8000);
        if (!(status && status.ptt) && !radio.tx) waterfall.ingest(m.samples);
        break;
      case "aud1":
        if (m.status === "ready") setAud1("ready", "ok");
        else if (m.status === "closed" || m.status === "error") setAud1("lost", "error");
        else if (m.status === "tx-error") hostLog(`AUD1 TX refused: ${m.reason}`, "vara-log-error");
        break;
      case "tx":
        if (m.kind === "tx-fault") hostLog(`TX fault: ${m.reason}`, "vara-log-error");
        break;
      case "event":
        if (m.kind === "unableToConnect") chatSystem("no answer");
        else if (m.kind === "timedOut") chatSystem("link timed out");
        else if (m.kind === "txDisabled") {
          chatSystem("nothing sent: Enable radio TX is off (SETTINGS)");
          hostLog("refused: radio TX not enabled", "vara-log-error");
        }
        else if (m.kind === "needs16k") {
          chatSystem("FM Wide needs the 16 kHz radio link — switch it on in SETTINGS › ADVANCED");
          hostLog("FM Wide: the firmware offers no 16 kHz stream (16 kHz radio link is off)", "vara-log-error");
        }
        break;
      case "error":
        setAud1("error", "error");
        hostLog(`${m.reason}: ${m.detail || ""}`, "vara-log-error");
        if (window.WifiltAudioHealth) window.WifiltAudioHealth.diagnose();
        break;
    }
  }
  function onHostLine(line) {
    hostLog(`< ${line}`, line.startsWith("WRONG") ? "vara-log-error" : "vara-log-reply");
    if (line.startsWith("CONNECTED ")) chatSystem(`connected ${line.slice(10)}`);
    else if (line === "DISCONNECTED") { chatSystem("disconnected"); rxText.decode(); }
  }

  // ---- rendering ----------------------------------------------------------------
  function setAud1(text, cls) {
    dom.aud1State.textContent = "AUD1 " + text;
    dom.aud1State.className = "pill aud1-state" + (cls ? " " + cls : "");
  }
  // Session states in which a link stands and text can be queued (hf/session.rs);
  // Listen, Calling, Answering, Qrt and Closing are on either side of one.
  const LINKED = new Set(["Idle", "Receiving", "Sending", "HeaderSent", "Break", "IdleSent", "FqWait"]);
  function renderStatus() {
    const s = status;
    const linked = Boolean(s && LINKED.has(s.state));
    const idle = !s || s.state === "Listen";
    const haveCall = Boolean(myCall);
    dom.stState.textContent = s ? (s.tuning ? "TUNE" : s.ptt ? `${s.state} · TX` : s.state) : "—";
    dom.stPeer.textContent = s && s.peer ? s.peer : "—";
    dom.stSpeed.textContent = s && linked && s.level ? `level ${s.level}${s.mode === "fm" ? " FM" : ""}` : "—";
    dom.stSn.textContent = s && Number.isFinite(s.afcHz) && linked ? `AFC ${s.afcHz > 0 ? "+" : ""}${Math.round(s.afcHz)} Hz` : "—";
    dom.stBusy.textContent = s ? (s.busy ? "BUSY" : "clear") : "—";
    dom.stBusy.classList.toggle("warn", Boolean(s && s.busy));
    dom.stBuffer.textContent = s ? `${s.buffered} B` : "—";
    dom.stLoad.textContent = s && s.load ? `${Math.round(s.load * 100)} %` : "—";
    dom.stHost.textContent = s && s.host ? s.host : "—";
    // The modem's own LISTEN, which a Winlink client switches too (and a
    // client leaving switches off) -- the toggle follows it, never the reverse.
    if (s && dom.listenToggle.checked !== Boolean(s.listen)) {
      dom.listenToggle.checked = Boolean(s.listen);
      dom.listenState.textContent = s.listen ? "LISTENING" : "LISTEN OFF";
    }
    dom.stLoad.classList.toggle("warn", Boolean(s && s.load > 0.8));
    gateTx(dom.connectButton, !worker || !haveCall || !idle || !dom.peerCall.value.trim());
    dom.disconnectButton.disabled = !worker || idle;
    dom.abortButton.disabled = !worker || idle;
    // CQ frames are VARA HF's; FM's go over AX.25 in record 16, not ported.
    gateTx(dom.cqButton, !worker || !haveCall || !idle || Boolean(s && s.ptt) || Boolean(s && s.mode === "fm"));
    dom.bwSelect.disabled = !worker || !idle;
    dom.sessionSelect.disabled = !worker || !idle;
    // Switching LISTEN off is always allowed; on needs the pledge.
    if (dom.listenToggle.checked) { if (window.TxPledge) TxPledge.gate(dom.listenToggle, []); dom.listenToggle.disabled = !worker || !haveCall; }
    else gateTx(dom.listenToggle, !worker || !haveCall);
    // With a client on the data port the link's byte stream is the client's.
    const ownStream = !(s && s.host);
    dom.chatInput.disabled = !worker || !linked || !ownStream;
    dom.chatSend.disabled = !worker || !linked || !ownStream;
    dom.chatInput.placeholder = ownStream ? "Type, Enter sends once connected" : "The link's data belongs to the Winlink client";
    if (s && s.tuning) { if (window.TxPledge) TxPledge.gate(dom.tuneButton, []); dom.tuneButton.disabled = !worker; }
    else gateTx(dom.tuneButton, !worker || !idle);
    dom.tuneButton.classList.toggle("active", Boolean(s && s.tuning));
    dom.tuneButton.textContent = s && s.tuning ? "STOP TUNE" : "TUNE";
    dom.connectSummary.textContent = s ? (linked ? `linked with ${s.peer}` : s.state === "Calling" ? `calling ${dom.peerCall.value.trim().toUpperCase()}` : "") : "";
    document.body.classList.toggle("radio-transmitting", Boolean(s && s.ptt) || radio.tx);
  }
  function formatFrequency(hz) {
    hz = Math.max(0, Math.round(Number(hz) || 0));
    const rest = String(hz % 1000000).padStart(6, "0");
    return `${Math.floor(hz / 1000000)}.${rest.slice(0, 3)}.${rest.slice(3)}`;
  }
  function renderRadio() {
    const connected = radio.connected && radio.transceiverType === "ICOM-LAN";
    dom.trxFrequencyValue.textContent = formatFrequency(radio.frequency);
    dom.trxMode.textContent = radio.mode || "---";
    const fm = isFm(settings.bw), want = fm ? ["FM", "FM-D"] : ["USB", "USB-D"];
    const usb = want.includes(radio.mode);
    dom.trxMode.classList.toggle("incompatible", connected && !usb);
    dom.trxMode.title = connected && !usb ? (fm ? "VARA FM needs FM or FM-D" : "VARA HF needs USB or USB-D") : "TRX mode";
    dom.radioModel.textContent = radio.radioName || "--";
    dom.linkState.textContent = connected ? (radio.tx ? "● TX" : "● RX") : "● OFFLINE";
    dom.linkState.classList.toggle("error", !connected);
  }
  let pollInFlight = false;
  async function pollRadio() {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const r = await fetch("/state?radio=lan", {cache: "no-store", signal: AbortSignal.timeout(8000)});
      if (r.ok) { radio = {...radio, ...(await r.json())}; renderRadio(); renderStatus(); }
    } catch (_e) { radio.connected = false; renderRadio(); }
    finally { pollInFlight = false; }
  }

  // ---- controls -------------------------------------------------------------------
  function onConnect() {
    const peer = dom.peerCall.value.trim().toUpperCase();
    if (!peer || !myCall) return;
    chatSystem(`connecting ${peer}`);
    command(`CONNECT ${myCall} ${peer}`);
  }
  function onChatSend(event) {
    event.preventDefault();
    const text = dom.chatInput.value;
    if (!text) return;
    const bytes = new TextEncoder().encode(text + "\r");
    post({type: "send", bytes: bytes.buffer});
    chatText(text + "\n", "vara-chat-tx");
    dom.chatInput.value = "";
  }
  function onListen() {
    const on = dom.listenToggle.checked && Boolean(myCall);
    lease.setArmed(on);
    dom.listenState.textContent = on ? "LISTENING" : "LISTEN OFF";
    command(`LISTEN ${on ? "ON" : "OFF"}`);
  }
  function renderSettings() {
    dom.setDrive.value = settings.driveDb;
    dom.setLatency.value = settings.latencyMs;
    dom.setSlot.value = settings.slotMs;
    dom.setPrebuffer.value = settings.prebufferMs;
    dom.bwSelect.value = String(settings.bw);
    dom.sessionSelect.value = settings.p2p ? "p2p" : "winlink";
    dom.setLink16k.checked = settings.link16k;
    const mode = settings.bw === "fmn" ? "FM Narrow" : settings.bw === "fmw" ? "FM Wide" : settings.bw + " Hz";
    dom.settingsSummary.textContent = `${mode} · ${settings.p2p ? "P2P" : "Winlink"} · ${settings.latencyMs} ms${settings.link16k ? " · 16 kHz link" : ""}`;
  }
  async function saveSettings(extra) {
    const next = normalise({...settings, ...(extra || {}),
      driveDb: dom.setDrive.value, latencyMs: dom.setLatency.value, slotMs: dom.setSlot.value, prebufferMs: dom.setPrebuffer.value,
      link16k: dom.setLink16k.checked});
    const relink = next.link16k !== settings.link16k;
    settings = next;
    renderSettings();
    post({type: "configure", settings: {driveDb: next.driveDb, latencyMs: next.latencyMs, slotMs: next.slotMs, prebufferMs: next.prebufferMs}});
    try {
      const r = await fetch(SETTINGS_URL, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(next)});
      dom.settingsSaveStatus.textContent = r.ok ? "saved" : `not saved (HTTP ${r.status})`;
      // The firmware reconnects the radio at the new rate and drops the audio
      // socket; the worker starts again once the link has had time to return.
      if (r.ok && relink) {
        hostLog(`(radio link to ${next.link16k ? 16 : 8} kHz, reconnecting)`, "vara-log-cmd");
        stopWorker(); setTimeout(() => { if (ownLease) startWorker(); }, 4000);
      }
    } catch (_e) { dom.settingsSaveStatus.textContent = "not saved (no answer)"; }
    setTimeout(() => { dom.settingsSaveStatus.textContent = ""; }, 4000);
  }

  // ---- waterfall + start --------------------------------------------------------
  let waterfall = null;
  const isFm = bw => bw === "fmn" || bw === "fmw";
  // The waterfall follows the AUD1 stream: 0.3-3 kHz at 8 kHz, 0.3-6 kHz on
  // the 16 kHz stream FM Wide uses.
  function setWaterfallRate(rate) {
    if (waterfall.sampleRate === rate) return;
    waterfall.sampleRate = rate;
    waterfall.reset();
    waterfall.setRange(300, rate === 16000 ? 6000 : 3000);
  }
  function onBusy(info) {
    dom.takeoverNotice.hidden = false;
    document.body.classList.add("session-busy-only");
    dom.takeoverDetail.textContent = `In use elsewhere (${info.owner || "another page or device"}). Take over here?`;
  }

  async function init() {
    if (typeof LanGate !== "undefined" && !(await LanGate.gate())) return;
    ["trxFrequencyValue", "trxMode", "radioModel", "aud1State", "linkState", "listenToggle", "listenState",
      "waterfall", "waterfallCanvas", "waterfallOverlay", "myCall", "peerCall", "bwSelect", "sessionSelect",
      "connectButton", "disconnectButton", "abortButton", "cqButton", "connectSummary",
      "stState", "stPeer", "stSpeed", "stSn", "stBusy", "stBuffer", "stLoad", "stHost",
      "chatLog", "chatForm", "chatInput", "chatSend", "hostLog",
      "txSafety", "setDrive", "setLatency", "setSlot", "setPrebuffer", "setLink16k", "tuneButton", "settingsSave", "settingsSaveStatus",
      "settingsSummary", "takeoverNotice", "takeoverDetail", "takeoverButton"].forEach(id => { dom[id] = byId(id); });

    if (typeof Spectrum !== "undefined") {
      waterfall = new Spectrum.Waterfall({canvas: dom.waterfallCanvas, overlay: dom.waterfallOverlay,
        container: dom.waterfall, sampleRate: 8000, lowHz: 300, highHz: 3000});
      window.addEventListener("resize", () => waterfall.resize());
      waterfall.resize();
    }
    await loadSettings();
    renderSettings();
    try { myCall = ((await StationIdentity.read()) || {}).call || ""; } catch (_e) { myCall = ""; }
    dom.myCall.textContent = myCall || "set it in SETUP";
    dom.myCall.classList.toggle("warn", !myCall);

    lease = WifiltLease.create({tokenKey: "vara.session.token.v1", armedKey: "vara.session.armed.v1",
      channel: "vara.session", base: "/vara/session", role: "vara"});
    dom.listenToggle.checked = Boolean(myCall) && lease.isArmed();
    dom.listenState.textContent = dom.listenToggle.checked ? "LISTENING" : "LISTEN OFF";

    dom.peerCall.disabled = false;
    dom.peerCall.addEventListener("input", renderStatus);
    dom.peerCall.addEventListener("keydown", e => { if (e.key === "Enter") onConnect(); });
    dom.connectButton.addEventListener("click", onConnect);
    dom.disconnectButton.addEventListener("click", () => command("DISCONNECT"));
    dom.abortButton.addEventListener("click", () => { hostLog("> (abort)", "vara-log-cmd"); post({type: "abort"}); });
    dom.cqButton.addEventListener("click", () => command(`CQFRAME ${myCall} ${settings.bw}`));
    dom.bwSelect.addEventListener("change", () => {
      const v = dom.bwSelect.value, was = settings.bw, fm = isFm(v);
      saveSettings({bw: fm ? v : Number(v)});
      // HF, FM Narrow and FM Wide are different modems (FM Wide on its own
      // 16 kHz stream): switching between them starts the worker again with
      // the other one; within HF it is the BW command.
      if (fm || isFm(was)) {
        hostLog(`(switching to ${fm ? (v === "fmw" ? "VARA FM Wide" : "VARA FM Narrow") : "VARA HF"})`, "vara-log-cmd");
        stopWorker(); setTimeout(startWorker, 600);
      } else command(`BW${v}`);
    });
    dom.sessionSelect.addEventListener("change", () => {
      const p2p = dom.sessionSelect.value === "p2p";
      command(p2p ? "P2P SESSION" : "WINLINK SESSION");
      saveSettings({p2p});
    });
    dom.listenToggle.addEventListener("change", onListen);
    dom.chatForm.addEventListener("submit", onChatSend);
    dom.tuneButton.addEventListener("click", () => post({type: "tune", on: !(status && status.tuning)}));
    dom.settingsSave.addEventListener("click", () => saveSettings());
    txOn = txEnabled(); dom.txSafety.checked = txOn;
    if (window.TxPledge) TxPledge.install(revealTxSafety);
    dom.txSafety.addEventListener("change", () => { setTxEnabled(dom.txSafety.checked); applyTxEnabled(); });
    window.addEventListener("storage", event => { if (!event.key || event.key.indexOf("js8") !== -1) applyTxEnabled(); });

    lease.onBusy(onBusy);
    lease.onLost(() => { stopWorker(); ownLease = false; setAud1("—"); status = null; renderStatus(); });
    dom.takeoverButton.addEventListener("click", async () => {
      if (await lease.claim(true)) {
        dom.takeoverNotice.hidden = true; document.body.classList.remove("session-busy-only");
        ownLease = true; startWorker();
      }
    });
    renderStatus();
    pollRadio();
    setInterval(pollRadio, 1000);
    if (await lease.claim(false)) { ownLease = true; startWorker(); }
    window.addEventListener("beforeunload", () => { stopWorker(); if (ownLease) lease.release(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}());
