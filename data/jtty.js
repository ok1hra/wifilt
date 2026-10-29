// JTTY page (/jtty.html): WSJT-X 3.2's asynchronous 4-GFSK keyboard mode over
// ICOM-LAN, built the way rtty.js is -- same session lease, /state polling, RF
// power, CAL PLAN and QRPlog hand-off, so the two pages behave alike and stay
// that way. What is JTTY's own: the receiver (jtty-modem.js in a Worker, every
// signal in the passband at once), the two RX views, the function keys with
// WSJT-X's native templates, and live entry (docs/jtty-implementace.md §5-§6).
(function () {
  "use strict";

  const AUDIO_WS_PORT =
    Number(new URLSearchParams(location.search).get("audioPort")) ||
    Number((window.WIFILT_PORTS || {}).audio) || 83;
  const STATE_POLL_MS = 1000;
  const FETCH_TIMEOUT_MS = 8000, FETCH_FLASH_TIMEOUT_MS = 12000;
  const fetchDeadline = (ms = FETCH_TIMEOUT_MS) => AbortSignal.timeout(ms);
  const SESSION_PING_MS = 5000, SESSION_RETRY_MS = 3000, SESSION_PROBE_MS = 250;
  const RADIO_STATE_URL = "/state?radio=lan";
  const RADIO_CMD_URL = "/cmd?radio=lan";
  const RX_AUDIO_RATE = 8000;
  const BASE_LOW_HZ = 200, BASE_HIGH_HZ = 3000;
  // Live entry, as WSJT-X 3.3 (mainwindow_jtty.cpp): a pause this long sends
  // whatever is typed; otherwise words go out in batches, holding back the
  // last few that might still join the next word into one compact frame.
  const LIVE_IDLE_FLUSH_MS = 1500, LIVE_BATCH_WORDS = 5, LIVE_HOLDBACK_WORDS = 3;

  const $ = id => document.getElementById(id);
  const dom = {};
  for (const id of [
    "trxFrequencyValue", "trxMode", "radioModel", "linkState", "trxFrequency",
    "frequencyMenu", "trxSlotLabel", "trxReconnect", "trxPower", "trxPowerWatts", "trxSupply",
    "aud1State", "ttControl", "planField", "planButton", "planButtonValue", "calField",
    "sessionBusy", "sessionBusyWhere", "sessionTakeover",
    "jttyFtol", "jttyProfile", "jttyDecodes",
    "waterfall", "waterfallCanvas", "spectrumSummary",
    "jttyScope", "jttyLiveSpectrum", "jttyScopeOverlay", "liveSpectrumCanvas",
    "jttyBandLog", "jttyRxLog", "jttyRxHzLabel", "rxSummary", "jttyRxClear",
    "jttyHisCall", "jttyExchange", "jttyMyCall", "jttyFkeys",
    "jttyTxText", "jttyLive", "jttyTxAbort", "jttyTxState", "jttyTxPreview", "txSummary",
    "jttyRfPowerField", "jttyRfPercent", "jttyRfPercentWatts", "jttyRfPercentSet", "jttyRfPercentState",
    "jttyTxHz", "jttyHoldTx", "jttyLiveEntry", "jttyLiveIdle",
    "jttyRxHz", "jttyFtolSelect", "jttySearch", "jttyProfileSelect",
    "jttyFkeyEditor", "jttyFkeysReset",
    "jttyStreamEnabled", "jttyStreamSubs",
    "jttySettingsSection", "settingsSummary",
  ]) dom[id] = $(id);

  const state = {
    radio: {connected: false, transceiverType: "", radioName: "", radioNameSeen: false,
      mode: "", frequency: 0, tx: false, rfPower: 0, rfPowerSeen: false},
    frames: 0, lastWindowMs: null, myCall: "", myGrid: "",
  };

  const settings = JttySettings.load(window.localStorage);
  function saveSettings() { Object.assign(settings, JttySettings.save(window.localStorage, settings)); }

  const profileCode = () => JttyCodec.profileFromName(settings.profile);
  const fkeys = () => settings.fkeys || JttyCodec.DEFAULT_FKEYS;
  const PROFILE_LABEL = {"unknown": "UNKNOWN", "field-day": "FIELD DAY", "rtty-roundup": "ROUNDUP"};

  // ── session lease (rtty.js §lease, role "jtty") ─────────────────────────

  const SESSION_TOKEN_KEY = "js8lan.session.token.v1";
  let sessionTokenCache = null, sessionHeld = false, sessionRetryTimer = null,
      sessionSince = 0, sessionLocalHolder = null;

  function makeToken() {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }
  function sessionToken() {
    if (sessionTokenCache) return sessionTokenCache;
    let token = null;
    try { token = sessionStorage.getItem(SESSION_TOKEN_KEY); } catch (_error) {}
    if (!token) {
      token = makeToken();
      try { sessionStorage.setItem(SESSION_TOKEN_KEY, token); } catch (_error) {}
    }
    sessionTokenCache = token;
    return token;
  }

  const pageId = makeToken();
  const channel = (() => { try { return new BroadcastChannel("js8lan.session"); } catch (_error) { return null; } })();
  if (channel) channel.onmessage = event => {
    const message = event.data || {};
    if (message.id === pageId) return;
    if (message.type === "probe" && sessionHeld)
      channel.postMessage({type: "held", id: pageId, since: sessionSince});
    if (message.type === "held") sessionLocalHolder = {id: message.id, since: Number(message.since) || 0};
    if (message.type === "released" && !sessionHeld) scheduleSessionRetry(200);
    if (message.type === "evict" && sessionHeld) loseSession({});
  };

  function probeLocalHolder() {
    if (!channel) return Promise.resolve(null);
    sessionLocalHolder = null;
    channel.postMessage({type: "probe", id: pageId});
    return new Promise(resolve => setTimeout(() => resolve(sessionLocalHolder), SESSION_PROBE_MS));
  }
  function localHolderOutranks(holder) {
    if (!holder) return false;
    if (holder.since !== sessionSince) return holder.since < sessionSince;
    return holder.id < pageId;
  }

  async function sessionPost(path, extra) {
    try {
      const response = await fetch(path, {method: "POST", cache: "no-store", signal: fetchDeadline(),
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({token: sessionToken(), ...extra})});
      if (response.status !== 409) return {granted: true};
      const info = await response.json().catch(() => ({}));
      return {granted: false, owner: info.owner || "", ageMs: Number(info.ageMs) || 0};
    } catch (_error) { return {granted: true}; }
  }

  function scheduleSessionRetry(delayMs = SESSION_RETRY_MS) {
    if (sessionRetryTimer) clearTimeout(sessionRetryTimer);
    sessionRetryTimer = setTimeout(claimSession, delayMs);
  }

  function markHeld() {
    sessionHeld = true; sessionSince = Date.now();
    if (sessionRetryTimer) { clearTimeout(sessionRetryTimer); sessionRetryTimer = null; }
    dom.sessionBusy.hidden = true;
    openSession();
    render();
  }

  function loseSession(info) {
    jttyTx.abort("session lost");
    closeSession();
    sessionHeld = false;
    dom.sessionBusy.hidden = false;
    dom.sessionBusyWhere.textContent = info.owner ? `held by ${info.owner}` : "";
    scheduleSessionRetry();
    render();
  }

  async function claimSession(force = false) {
    const holder = await probeLocalHolder();
    if (holder && localHolderOutranks(holder) && !force) {
      loseSession({owner: "another tab in this browser"});
      return;
    }
    const claim = await sessionPost("/js8/session/claim", {force, role: "jtty"});
    if (!claim.granted) { loseSession(claim); return; }
    markHeld();
  }

  setInterval(async () => {
    if (!sessionHeld) return;
    const ping = await sessionPost("/js8/session/ping", {role: "jtty"});
    if (!ping.granted) loseSession(ping);
  }, SESSION_PING_MS);

  addEventListener("pagehide", () => {
    if (!sessionHeld) return;
    if (channel) channel.postMessage({type: "released", id: pageId});
    try {
      fetch("/js8/session/release", {method: "POST", keepalive: true,
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({token: sessionToken()})});
    } catch (_error) { /* leaving anyway */ }
  });

  // ── radio state ─────────────────────────────────────────────────────────

  let statePollInFlight = false;
  async function pollState() {
    if (statePollInFlight) return;
    statePollInFlight = true;
    try {
      const response = await fetch(RADIO_STATE_URL, {cache: "no-store", signal: fetchDeadline()});
      if (!response.ok) throw new Error(String(response.status));
      const json = await response.json();
      state.radio = {
        connected: Boolean(json.connected),
        transceiverType: String(json.transceiverType || ""),
        radioName: String(json.radioName || ""),
        radioNameSeen: json.radioNameSeen === true,
        mode: String(json.mode || ""),
        frequency: Number(json.frequency) || 0,
        tx: Boolean(json.tx),
        rfPower: Number(json.rfPower) || 0,
        rfPowerSeen: json.rfPowerSeen === true,
        supplyVolts: Number(json.supplyVolts) || 0,
      };
      rfPowerAuto.onPollSuccess();
    } catch (_error) {
      state.radio.connected = false;
    } finally { statePollInFlight = false; }
    render();
  }

  const liveRadioModel = () => IcomModels.liveRadioModel(state.radio);

  async function command(payload) {
    const response = await fetch(RADIO_CMD_URL, {method: "POST", signal: fetchDeadline(),
      headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
    if (!response.ok) {
      const info = await response.json().catch(() => ({}));
      throw new Error(info.error || `${payload.type} failed (${response.status})`);
    }
    return true;
  }
  async function commandJson(payload) {
    const response = await fetch(RADIO_CMD_URL, {method: "POST", signal: fetchDeadline(),
      headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || `${payload.type} failed (${response.status})`);
    return json;
  }

  function waitForState(predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      (function check() {
        if (predicate(state.radio)) return resolve();
        if (Date.now() > deadline) return reject(new Error("timed out waiting for the radio"));
        setTimeout(check, 250);
      })();
    });
  }

  // ── dial frequencies ────────────────────────────────────────────────────

  function renderFrequencyMenu() {
    const current = state.radio.frequency;
    dom.frequencyMenu.innerHTML =
      `<header><strong>JTTY dial frequencies</strong><small>WSJT-X 3.3 defaults (still preliminary) -- USB-D</small>` +
      `<span class="tt-actions"><button class="tt-clear" type="button" data-menu-close title="Close">CLOSE</button></span></header>` +
      `<div class="frequency-presets">${JttyPresets.PRESETS.map(preset =>
        `<button class="frequency-preset${preset.frequencyHz === current ? " current" : ""}"` +
        ` type="button" data-frequency="${preset.frequencyHz}">` +
        `<strong>${preset.band}</strong><span>${(preset.frequencyHz / 1e6).toFixed(3)} MHz</span>` +
        `</button>`).join("")}</div>` +
      `<footer>The dial; the signal is dial + the audio offset. 20 m (14.090) is the main meeting place.</footer>`;
  }

  function closeFrequencyMenu() {
    dom.frequencyMenu.hidden = true;
    dom.trxFrequency.setAttribute("aria-expanded", "false");
  }

  async function requestFrequency(hz) {
    closeFrequencyMenu();
    try { await command({type: "setFrequency", frequency: String(hz)}); }
    catch (_error) { /* pollState will show whatever the radio actually did */ }
  }

  function offDialFrequency() {
    const hz = state.radio.frequency;
    if (!hz || !state.radio.connected) return false;
    return !JttyPresets.PRESETS.some(preset => hz >= preset.lowHz && hz <= preset.highHz);
  }

  // ── AUD1 ────────────────────────────────────────────────────────────────

  let session = null;

  function audioUrl() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${location.hostname}:${AUDIO_WS_PORT}/audiows?token=${encodeURIComponent(sessionToken())}`;
  }

  function openSession() {
    if (session) return session;
    session = new Js8Aud1Transport.Aud1WebSocketSession(
        {url: audioUrl(), WebSocketImpl: WebSocket, wallNow: () => Date.now()})
      .onStatus(() => render())
      .onControl(message => {
        if (gainCal && gainCal.running) gainCal.onControl(message);
        render();
      });
    session.onSamples(onSamples);
    session.start();
    return session;
  }

  function closeSession() {
    jttyTx.reset();
    if (session) { session.stop(); session = null; }
  }

  // During this station's own TX the receiver gets silence of the same length:
  // its clock keeps running, and it never decodes its own transmitter.
  function onSamples(samples) {
    if (session && session.ptt) { receiver.gap(samples.length); return; }
    receiver.push(samples);
    scope.ingest(samples);
  }

  // ── scope ───────────────────────────────────────────────────────────────

  const scope = JttyScope.create({
    scopeEl: dom.jttyScope, liveCanvas: dom.liveSpectrumCanvas, liveContainer: dom.jttyLiveSpectrum,
    waterfallCanvas: dom.waterfallCanvas, waterfallContainer: dom.waterfall,
    overlayCanvas: dom.jttyScopeOverlay, sampleRate: RX_AUDIO_RATE,
    baseLowHz: BASE_LOW_HZ, baseHighHz: BASE_HIGH_HZ,
    rxHz: () => settings.rxHz, txHz: () => settings.txHz,
    onTune: (hz, event) => {
      if (event && event.shiftKey) setTxHz(hz);
      else setRxHz(hz, !settings.holdTx);
    },
  });

  function applyZoom(percent) {
    const {low, high} = scope.setZoom(percent);
    document.querySelectorAll(".rtty-zoom-pill").forEach(button =>
      button.classList.toggle("active", Number(button.dataset.zoom) === percent));
    dom.spectrumSummary.textContent = `RX ${Math.round(low)}–${Math.round(high)} Hz`;
  }

  const clampHz = hz => Math.max(JttySettings.TONE_MIN_HZ, Math.min(JttySettings.TONE_MAX_HZ, Math.round(hz)));
  function setRxHz(hz, alsoTx) {
    settings.rxHz = clampHz(hz);
    if (alsoTx) settings.txHz = settings.rxHz;
    saveSettings();
    configureReceiver();
    rxView.refilter(store.all());
    renderSettingsFields();
    render();
  }
  function setTxHz(hz) {
    settings.txHz = clampHz(hz);
    saveSettings();
    renderSettingsFields();
    render();
  }

  // ── receiver ────────────────────────────────────────────────────────────

  const scriptUrl = path => {
    const node = [...document.querySelectorAll("script[src]")]
      .find(element => element.getAttribute("src").split("?")[0] === path);
    return node ? node.getAttribute("src") : path;
  };

  const receiverConfig = () => {
    const band = JttySettings.SEARCH[settings.search];
    return {rxHz: settings.rxHz, ftolHz: settings.ftolHz, searchLowHz: band.lowHz, searchHighHz: band.highHz};
  };

  const store = JttyRxLog.createStore();
  const dxcChannel = (() => { try { return new BroadcastChannel("wifilt-dxc-action"); } catch (_error) { return null; } })();
  const handToQrplog = word => {
    if (!dxcChannel) return;
    dxcChannel.postMessage({type: "dxc-tune", callsign: word, trx: LanGate.slot ? LanGate.slot() : 0, source: "jtty"});
  };
  function answerLine(id) {
    const m = store.get(id);
    if (!m) return;
    setRxHz(m.audioHz, !settings.holdTx);
    const words = m.text.split(" ");
    const call = /^CQ$/.test(words[0]) ? words.find((w, i) => i > 0 && JttyCodec.standardCall(w) && w !== "CQ")
      : words.find(w => JttyCodec.standardCall(w) && w !== state.myCall);
    if (call) { dom.jttyHisCall.value = call; handToQrplog(call); }
  }
  const viewOptions = {myCall: () => state.myCall, txHz: () => settings.txHz,
    onToken: word => handToQrplog(word), onLineDouble: id => answerLine(id)};
  const bandView = JttyRxLog.createView(Object.assign({el: dom.jttyBandLog, maxLines: 300}, viewOptions));
  const rxView = JttyRxLog.createView(Object.assign({el: dom.jttyRxLog, maxLines: 200,
    filter: JttyRxLog.nearRx(() => settings.rxHz, () => state.myCall)}, viewOptions));

  const streamFeed = JttyRx.createStreamFeed({session: () => session});
  const receiver = JttyRx.create({
    modemUrl: scriptUrl("/jtty-modem.js"), codecUrl: scriptUrl("/jtty-codec.js"),
    config: receiverConfig(),
    onUpdates: (updates, stats, ms) => {
      const changed = store.apply(updates);
      for (const m of changed) {
        bandView.upsert(m);
        rxView.upsert(m);
        if (m.status !== "expired") scope.markDecode(m.audioHz, m.snr);
      }
      if (stats) state.frames = stats.frames;
      if (Number.isFinite(ms)) state.lastWindowMs = ms;
      streamFeed.push(updates);
      renderStatusPills();
    },
    onError: message => { dom.jttyDecodes.textContent = "DEC error"; dom.jttyDecodes.title = message; },
  });
  const configureReceiver = () => receiver.configure(receiverConfig());

  function clearRx() {
    store.clear();
    bandView.clear();
    rxView.clear();
    state.frames = 0;
    renderStatusPills();
  }

  // ── TX ──────────────────────────────────────────────────────────────────

  let currentEcho = null, externalTxRequestId = null, live = null;

  const jttyTx = JttyTx.create({
    session: () => session,
    txHz: () => settings.txHz,
    gain: () => resolvedGain(),
    onSegment: seg => {
      if (seg.filler) return currentEcho;
      if (!currentEcho) currentEcho = rxView.echoTx(seg.text);
      else currentEcho.append(seg.text);
      return currentEcho;
    },
    onSegmentFailed: echo => rxView.markEchoFailed(echo),
    onFinish: error => {
      dom.jttyTxState.textContent = error ? `error: ${error}` : "sent";
      currentEcho = null;
      if (live) endLiveUi();
      if (externalTxRequestId && jttyTxChannel) {
        jttyTxChannel.postMessage({type: "jtty-tx-result", requestId: externalTxRequestId, ok: !error, error: error || undefined});
        externalTxRequestId = null;
      }
    },
    onTick: () => renderTxState(),
  });

  const macroCtx = () => ({myCall: state.myCall, hisCall: dom.jttyHisCall.value.trim().toUpperCase(),
    queueCall: dom.jttyHisCall.value.trim().toUpperCase(), exchange: dom.jttyExchange.value.trim().toUpperCase(),
    grid: state.myGrid, profile: profileCode()});

  function txBlockingReason() {
    if (!sessionHeld || !session || !session.hello) return "the AUD1 session is not ready";
    if (!state.radio.connected) return "the radio is not connected";
    if (gainCal.running || (gainPlan && gainPlan.running)) return "a TX calibration is running";
    return "";
  }

  // Text longer than one 80-character JTTY message goes out as segments of one
  // growing message, cut at spaces (JttyTransmit nextTransmitTextSegment), EOM
  // on the last -- what WSJT-X does with a long typed line.
  function segmentsOf(text, profile) {
    if (!JttyCodec.normalize(String(text)).trim()) return [];
    const all = [];
    let cur = "";
    for (const w of String(text).toUpperCase().replace(/\s+/g, " ").trim().split(" ")) {
      if (cur && (cur + " " + w).length > JttyCodec.MAX_TEXT) { all.push(cur); cur = w; }
      else cur = cur ? cur + " " + w : w;
    }
    if (cur) all.push(cur);
    return all.map((chunk, i) => {
      const packed = JttyCodec.packText(chunk.slice(0, JttyCodec.MAX_TEXT), {profile, isFinal: i === all.length - 1});
      if (!packed) throw new Error("text does not encode");
      return {frames: packed.frames, text: packed.text, final: i === all.length - 1};
    });
  }

  // A whole message, from the composer, an F-key or another tab.
  async function sendWhole(packedOrText) {
    const blocked = txBlockingReason();
    if (blocked) throw new Error(blocked);
    if (jttyTx.busyOrStarting()) throw new Error("a transmission is already in progress");
    currentEcho = null;
    if (typeof packedOrText !== "string") return jttyTx.send(packedOrText);
    const segments = segmentsOf(packedOrText, profileCode());
    if (!segments.length) throw new Error("nothing to send");
    if (segments.length === 1) return jttyTx.send(segments[0]);
    const first = segments.shift();
    return jttyTx.startLive(first, () => segments.shift() || {stop: true});
  }

  async function onComposerEnter() {
    const text = dom.jttyTxText.value;
    if (live) { finishLive(); return; }
    if (!text.trim()) return;
    try {
      dom.jttyTxState.textContent = "preparing…";
      await sendWhole(text);
      dom.jttyTxText.value = "";
      renderPreview();
    } catch (error) {
      dom.jttyTxState.textContent = `error: ${String(error.message || error)}`;
      if (currentEcho) rxView.markEchoFailed(currentEcho);
    }
    renderTxState();
  }

  async function sendFkey(index) {
    const template = fkeys()[index];
    if (!template) return;
    try {
      const compiled = JttyCodec.compileMacro(template, macroCtx());
      if (live) {
        // Inside live entry an F-key is typed text, like WSJT-X inserting it.
        insertLiveText(compiled.text + " ");
        return;
      }
      dom.jttyTxState.textContent = "preparing…";
      await sendWhole(compiled);
    } catch (error) {
      dom.jttyTxState.textContent = `error: ${String(error.message || error)}`;
    }
    renderTxState();
  }

  // ── live entry (§6) ─────────────────────────────────────────────────────

  function insertLiveText(text) {
    const el = dom.jttyTxText;
    el.value = el.value.replace(/\s*$/, el.value.trim() ? " " : "") + text;
    live.lastTypeMs = Date.now();
    renderPreview();
  }

  // The next segment for JttyTx, or null for filler, or {stop:true}.
  function liveNext() {
    if (!live) return {stop: true};
    const now = Date.now();
    const uncommitted = dom.jttyTxText.value.slice(live.committed);
    if (!uncommitted.trim()) {
      return now - live.lastTypeMs > settings.liveIdleS * 1000 ? {stop: true} : null;
    }
    const idle = now - live.lastTypeMs >= LIVE_IDLE_FLUSH_MS;
    let take = 0;
    if (idle) take = uncommitted.length;
    else {
      // Complete words are the ones a space has closed.
      const ends = [];
      uncommitted.replace(/\S+(?=\s)/g, (w, at) => { ends.push(at + w.length); return w; });
      if (ends.length - LIVE_HOLDBACK_WORDS >= LIVE_BATCH_WORDS) take = ends[ends.length - LIVE_HOLDBACK_WORDS - 1] + 1;
    }
    if (!take) return null;
    let chunk = uncommitted.slice(0, take);
    if (JttyCodec.normalize(chunk).length > JttyCodec.MAX_TEXT) {
      const cut = chunk.slice(0, JttyCodec.MAX_TEXT).lastIndexOf(" ");
      chunk = chunk.slice(0, cut > 0 ? cut + 1 : JttyCodec.MAX_TEXT);
    }
    const packed = JttyCodec.packText(chunk, {profile: profileCode(), isFinal: false});
    live.committed += chunk.length;
    renderPreview();
    if (!packed) return null;
    return {frames: packed.frames, text: packed.text, final: false};
  }

  async function startLive() {
    if (live || !settings.liveEntry) return;
    const blocked = txBlockingReason();
    if (blocked) { dom.jttyTxState.textContent = `error: ${blocked}`; return; }
    if (jttyTx.busyOrStarting()) return;
    live = {committed: 0, lastTypeMs: Date.now(), sentText: ""};
    currentEcho = null;
    dom.jttyLive.classList.add("active");
    // Whatever is already typed goes first, as WSJT-X's Alt+J force-flushes.
    const typed = dom.jttyTxText.value;
    let first = null;
    if (typed.trim()) {
      const chunk = typed.slice(0, JttyCodec.MAX_TEXT);
      const packed = JttyCodec.packText(chunk, {profile: profileCode(), isFinal: false});
      if (packed) { first = {frames: packed.frames, text: packed.text, final: false}; live.committed = chunk.length; }
    }
    try {
      await jttyTx.startLive(first, liveNext);
      dom.jttyTxState.textContent = "live";
    } catch (error) {
      dom.jttyTxState.textContent = `error: ${String(error.message || error)}`;
      endLiveUi();
    }
    renderPreview();
    renderTxState();
  }

  // Enter during live entry: the rest goes out with EOM, then PTT drops.
  function finishLive() {
    if (!live) return;
    const rest = dom.jttyTxText.value.slice(live.committed).trim();
    let seg = null;
    if (rest) {
      const packed = JttyCodec.packText(rest.slice(0, JttyCodec.MAX_TEXT), {profile: profileCode(), isFinal: true});
      if (packed) seg = {frames: packed.frames, text: packed.text, final: true};
    }
    jttyTx.finalize(seg);
    dom.jttyTxText.value = "";
    endLiveUi();
  }

  function endLiveUi() {
    live = null;
    dom.jttyLive.classList.remove("active");
    dom.jttyTxText.classList.remove("jtty-committed-text");
    renderPreview();
  }

  function abortTx() {
    if (live) { dom.jttyTxText.value = dom.jttyTxText.value.slice(live.committed); endLiveUi(); }
    jttyTx.abort("operator");
  }

  // Text already sent during live entry cannot be edited any more.
  function guardCommitted() {
    if (!live) return;
    live.lastTypeMs = Date.now();
    const el = dom.jttyTxText;
    if (el.value.length < live.committed || el.value.slice(0, live.committed) !== live.sentText)
      el.value = live.sentText + el.value.slice(Math.min(el.value.length, live.committed));
  }

  function renderPreview() {
    const text = dom.jttyTxText.value;
    if (live) {
      live.sentText = text.slice(0, live.committed);
      dom.jttyTxPreview.textContent = `live: ${live.committed} sent, ${text.length - live.committed} waiting`;
      return;
    }
    if (!text.trim()) { dom.jttyTxPreview.textContent = ""; return; }
    try {
      const segments = segmentsOf(text, profileCode());
      const frames = segments.reduce((n, s) => n + s.frames.length, 0);
      dom.jttyTxPreview.textContent = `${frames} frame${frames === 1 ? "" : "s"}, ${(frames * JttyModem.FRAME_S).toFixed(1)} s`;
    } catch (_error) {
      dom.jttyTxPreview.textContent = "does not encode";
    }
  }

  // ── QRPlog hand-off (wifilt-jtty-tx, same protocol as wifilt-rtty-tx) ───

  const jttyTxChannel = (() => { try { return new BroadcastChannel("wifilt-jtty-tx"); } catch (_error) { return null; } })();
  const isSessionHolder = () => Boolean(sessionHeld && session && session.hello);

  if (jttyTxChannel) jttyTxChannel.onmessage = event => {
    const msg = event.data || {};
    if (msg.type === "jtty-tx-probe") {
      if (isSessionHolder() && !jttyTx.busyOrStarting())
        jttyTxChannel.postMessage({type: "jtty-tx-probe-ack", requestId: msg.requestId});
      return;
    }
    if (msg.type === "jtty-tx-abort") {
      if (isSessionHolder() && jttyTx.busy()) abortTx();
      return;
    }
    if (msg.type !== "jtty-tx-send") return;
    if (!isSessionHolder()) return;   // not the holder -- the real one answers, or nobody does
    if (jttyTx.busyOrStarting()) {
      jttyTxChannel.postMessage({type: "jtty-tx-result", requestId: msg.requestId, ok: false,
        error: "this JTTY page is busy with another transmission"});
      return;
    }
    externalTxRequestId = msg.requestId;
    let packed;
    try {
      packed = JttyCodec.packText(String(msg.text || ""), {profile: JttyCodec.profileFromName(msg.profile)});
      if (!packed) throw new Error("text does not encode in one JTTY message");
    } catch (error) {
      jttyTxChannel.postMessage({type: "jtty-tx-result", requestId: msg.requestId, ok: false, error: String(error.message || error)});
      externalTxRequestId = null;
      return;
    }
    sendWhole(packed).catch(error => {
      const requestId = externalTxRequestId;
      externalTxRequestId = null;
      if (requestId) jttyTxChannel.postMessage({type: "jtty-tx-result", requestId, ok: false, error: String(error.message || error)});
    });
  };

  // ── CAL PLAN / RF power (rtty.js, unchanged in substance) ───────────────

  const gainStore = new TxGainCal.TxGainStore();
  const presetBands = () => JttyPresets.PRESETS.map(preset => ({band: TxGainCal.bandOf(preset.frequencyHz), hz: preset.frequencyHz}));
  const gainPlanStore = new TxGainPlanStore.PlanStore({profile: TxGainPlanStore.PROFILE_TONE, bands: presetBands});
  const calModel = () => liveRadioModel() || "";
  let gainPlan = null;

  const gainCal = TxGainCalUi.create({
    mount: dom.calField,
    store: gainStore,
    sink: {
      prepare: (...args) => session.prepare(...args),
      begin: (...args) => session.begin(...args),
      write: (...args) => session.write(...args),
      end: (...args) => session.end(...args),
      isDrained: (...args) => session.isDrained(...args),
      complete: (...args) => session.complete(...args),
      abort: (...args) => session.abort(...args),
      sendControl: (...args) => session.sendControl(...args),
      get bufferedAmount() { return session ? session.bufferedAmount : 0; },
      get ptt() { return Boolean(session && session.ptt); },
    },
    streamId: () => (session && session.hello ? session.hello.streamId : 0),
    wallNow: () => Date.now(),
    radio: () => state.radio,
    model: calModel,
    manualGain: () => 0,
    dbm: () => null,
    blockingReason: () => {
      if (!session || !session.hello) return "the AUD1 session is not ready";
      if (jttyTx.busy()) return "a JTTY transmission is in progress";
      return "";
    },
    ensureDataMode: async () => {},
    setMode: mode => command({type: "setMode", mode}),
    onRunChange: () => render(),
    modLevel: () => (gainPlan ? gainPlan.modLevel() : 0),
    refreshModLevel: () => (gainPlan ? gainPlan.refreshModLevel() : null),
  });

  const resolvedGain = () => gainCal.resolved();

  function radioPercent() {
    return state.radio.rfPowerSeen ? WsprCore.civPercent(state.radio.rfPower) : null;
  }

  function formatWatts(watts) {
    if (watts < 0.9995) return `${Math.round(watts * 1000)} mW`;
    return watts < 9.95 ? `${watts.toFixed(1)} W` : `${Math.round(watts)} W`;
  }

  gainPlan = TxGainPlanUi.create({
    mount: dom.planField,
    button: dom.planButton,
    resultStore: gainStore,
    planStore: gainPlanStore,
    cal: gainCal,
    model: calModel,
    modelNumber: () => IcomModels.modelNumber(calModel()),
    radio: () => state.radio,
    send: payload => commandJson(payload),
    bands: presetBands,
    wsprPresets: typeof WsprCore !== "undefined" ? WsprCore.PRESETS : [],
    js8Presets: typeof Js8TrxPresets !== "undefined" ? Js8TrxPresets.PRESETS : [],
    percentOf: radio => (radio.rfPowerSeen === true ? WsprCore.civPercent(radio.rfPower) : 0),
    defaultPowers: () => {
      const out = [];
      const target = Number(settings.rfPercent);
      if (Number.isFinite(target) && target >= 1) out.push(Math.round(target));
      if (state.radio.rfPowerSeen === true) out.push(radioPercent());
      if (typeof TxModePowers === "undefined") return out;
      return TxModePowers.union([out, TxModePowers.read({model: liveRadioModel()}).map(entry => entry.percent)], 4);
    },
    setFrequency: async hz => {
      await command({type: "setFrequency", frequency: String(hz)});
      await waitForState(radio => radio.frequency === hz, 9000);
    },
    setPercent: async percent => {
      const level = WsprCore.percentToLevel(percent);
      await command({type: "civ.raw", data: WsprCore.civLevelCommand(level).data});
      const started = Date.now();
      let seen = -1, seenPercent = -1;
      while (Date.now() - started < 9000) {
        try { await command({type: "civ.raw", data: "140A"}); } catch (_error) {}
        await new Promise(resolve => setTimeout(resolve, 300));
        await pollState();
        if (state.radio.rfPowerSeen === true) {
          seen = state.radio.rfPower;
          seenPercent = WsprCore.civPercent(seen);
          if (seenPercent === percent || seen === level) return;
        }
      }
      throw new Error(`the radio did not confirm the power: asked for ${percent} % (level ${level})` +
        (seen < 0 ? ", and it never reported a power setting" : `, it reports ${seenPercent} % (level ${seen})`));
    },
    onPlanChange: () => render(),
  });

  const rfPowerAuto = RfPowerAuto.create({
    dom: {input: dom.jttyRfPercent, set: dom.jttyRfPercentSet, watts: dom.jttyRfPercentWatts,
          state: dom.jttyRfPercentState, field: dom.jttyRfPowerField},
    targetPercent: () => {
      const stored = settings.rfPercent;
      return Number.isFinite(Number(stored)) && Number(stored) >= 1 ? Number(stored) : null;
    },
    radio: () => state.radio,
    fullWatts: () => WsprCore.fullPowerWatts(liveRadioModel()),
    formatWatts,
    blocked: () => gainCal.running || (gainPlan && gainPlan.running),
    transmitting: () => state.radio.tx || jttyTx.busy(),
    command,
    waitForState,
    onWrite: percent => { settings.rfPercent = percent; saveSettings(); },
    render,
  });

  // ── TrxNet stream switch (station-wide, firmware config) ────────────────

  async function loadStreamConfig() {
    try {
      const response = await fetch("/log-config", {cache: "no-store", signal: fetchDeadline()});
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      dom.jttyStreamEnabled.checked = data.jttyStream === true;
    } catch (_error) { /* keeps the unchecked default */ }
  }

  async function saveStream() {
    try {
      await fetch("/log-config/jtty-stream", {method: "POST", signal: fetchDeadline(),
        headers: {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
        body: new URLSearchParams({jttyStream: dom.jttyStreamEnabled.checked ? "1" : "0"}).toString()});
    } catch (_error) { /* transient network failure -- the switch just did not take */ }
    pollStream();
  }

  async function pollStream() {
    if (!dom.jttyStreamEnabled.checked) { dom.jttyStreamSubs.textContent = ""; return; }
    try {
      const response = await fetch("/jtty-stream.json", {cache: "no-store", signal: fetchDeadline()});
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      const subs = Array.isArray(data.subs) ? data.subs : [];
      let line = !data.trxnet ? "TrxNet is off on this interface — nothing can subscribe."
        : subs.length ? "Listening: " + subs.map(s => s.name + " (" + s.expiresS + " s)").join(", ")
        : "Nobody listening.";
      if (data.refused) line += " Refused (table full): " + data.refused + ".";
      dom.jttyStreamSubs.textContent = line;
    } catch (_error) {
      dom.jttyStreamSubs.textContent = "";
    }
  }

  // ── render ──────────────────────────────────────────────────────────────

  function renderTxState() {
    const busy = jttyTx.busy();
    dom.jttyTxAbort.hidden = !busy;
    if (busy && !live) dom.jttyTxState.textContent = `TX ${Math.round(jttyTx.progress() * 100)} %`;
    if (busy && live) dom.jttyTxState.textContent = jttyTx.live() ? "LIVE" : "finishing…";
    const blocked = txBlockingReason();
    dom.jttyFkeys.querySelectorAll("button").forEach(b => { b.disabled = Boolean(blocked) || (busy && !live); });
    dom.jttyLive.disabled = !settings.liveEntry || Boolean(blocked) || (busy && !live);
    dom.jttyLive.hidden = !settings.liveEntry;
    dom.txSummary.textContent = busy ? (live ? "LIVE" : "TX") : "";
  }

  function renderStatusPills() {
    dom.jttyFtol.textContent = `F TOL ${settings.ftolHz}`;
    dom.jttyProfile.textContent = PROFILE_LABEL[settings.profile];
    dom.jttyProfile.classList.toggle("active", settings.profile !== "unknown");
    dom.jttyDecodes.textContent = `DEC ${state.frames}` + (Number.isFinite(state.lastWindowMs) ? ` · ${state.lastWindowMs} ms` : "");
    dom.rxSummary.textContent = state.frames ? `${state.frames} frames decoded` : "";
    dom.jttyRxHzLabel.textContent = `${settings.rxHz} ±${JttyRxLog.RX_WINDOW_HZ} Hz`;
    dom.settingsSummary.textContent = `RX ${settings.rxHz} · TX ${settings.txHz} Hz` + (settings.holdTx ? " (hold)" : "");
  }

  function render() {
    document.body.classList.toggle("radio-transmitting", Boolean(state.radio.tx || (session && session.ptt)));
    const slot = LanGate.slot ? LanGate.slot() : 0;
    dom.trxSlotLabel.textContent = slot ? `TRX${slot}` : "TRX";
    dom.trxFrequencyValue.textContent = state.radio.frequency
      ? JttyPresets.formatFrequency(state.radio.frequency) : "--.---.---";
    const offDial = offDialFrequency();
    dom.trxFrequency.classList.toggle("off-dial", offDial);
    dom.trxFrequency.title = offDial ? "Not on a JTTY dial frequency — choose a band from the menu" : "";
    dom.trxMode.textContent = state.radio.mode || "---";
    dom.trxMode.classList.toggle("off-dial", Boolean(state.radio.mode) && !/^(USB|LSB)-D$|^USB$/.test(state.radio.mode));
    dom.trxMode.title = /-D$/.test(state.radio.mode) ? "" : "JTTY is sent as audio: use USB-D (data mode)";
    dom.radioModel.textContent = liveRadioModel() || "--";
    dom.aud1State.textContent = "AUD1 " + (session && session.hello ? "ready" : "—");
    dom.linkState.textContent = state.radio.connected ? "● ONLINE" : "● OFFLINE";
    dom.linkState.classList.toggle("error", !state.radio.connected);
    dom.trxReconnect.hidden = state.radio.connected;

    const percent = radioPercent();
    dom.trxPower.hidden = percent === null;
    TrxSupply.render(dom.trxSupply, state.radio, liveRadioModel());
    if (percent !== null) {
      const fullWatts = WsprCore.fullPowerWatts(liveRadioModel());
      dom.trxPowerWatts.textContent = fullWatts ? `${formatWatts(fullWatts * percent / 100)} (${percent}%)` : `${percent}%`;
      const lit = Math.round(percent / 10);
      dom.trxPower.querySelectorAll(".pwr-bar i").forEach((el, i) => el.classList.toggle("on", i < lit));
    }
    renderStatusPills();
    renderTxState();
    rfPowerAuto.renderField();
  }

  function renderFkeys() {
    const keys = fkeys();
    dom.jttyFkeys.innerHTML = keys.map((t, i) =>
      `<button class="jtty-fkey" type="button" data-fkey="${i}" title="F${i + 1}: ${t.replace(/"/g, "&quot;")}"><b>F${i + 1}</b><span>${t.replace(/[<&]/g, c => (c === "<" ? "&lt;" : "&amp;"))}</span></button>`).join("");
    dom.jttyFkeyEditor.innerHTML = keys.map((t, i) =>
      `<label>F${i + 1}<input type="text" maxlength="80" data-fkey-edit="${i}" value="${t.replace(/"/g, "&quot;")}" spellcheck="false"></label>`).join("");
  }

  function renderSettingsFields() {
    dom.jttyRxHz.value = String(settings.rxHz);
    dom.jttyTxHz.value = String(settings.txHz);
    dom.jttyHoldTx.checked = settings.holdTx;
    dom.jttyLiveEntry.checked = settings.liveEntry;
    dom.jttyLiveIdle.value = String(settings.liveIdleS);
    dom.jttyFtolSelect.value = String(settings.ftolHz);
    dom.jttySearch.value = settings.search;
    dom.jttyProfileSelect.value = settings.profile;
  }

  // ── wiring ──────────────────────────────────────────────────────────────

  function wire() {
    dom.trxFrequency.addEventListener("click", () => {
      const opening = dom.frequencyMenu.hidden;
      if (opening) renderFrequencyMenu();
      dom.frequencyMenu.hidden = !opening;
      dom.trxFrequency.setAttribute("aria-expanded", String(opening));
    });
    dom.frequencyMenu.addEventListener("click", event => {
      if (event.target.closest("[data-menu-close]")) { closeFrequencyMenu(); return; }
      const button = event.target.closest("[data-frequency]");
      if (button) requestFrequency(Number(button.dataset.frequency));
    });
    document.addEventListener("click", event => {
      if (dom.frequencyMenu.hidden) return;
      if (event.target.closest("#frequencyMenu") || event.target.closest("#trxFrequency")) return;
      closeFrequencyMenu();
    });
    dom.trxReconnect.addEventListener("click", async () => {
      dom.trxReconnect.disabled = true;
      try { await fetch("/lan/reconnect", {method: "POST", signal: fetchDeadline(FETCH_FLASH_TIMEOUT_MS)}); }
      catch (_error) { /* pollState will keep showing the true link state */ }
      dom.trxReconnect.disabled = false;
    });
    dom.sessionTakeover.addEventListener("click", () => claimSession(true));
    window.addEventListener("resize", () => scope.resize());

    document.querySelectorAll(".rtty-zoom-pill").forEach(button => button.addEventListener("click", event => {
      event.stopPropagation();
      applyZoom(Number(button.dataset.zoom));
    }));
    dom.jttyRxClear.addEventListener("click", event => { event.stopPropagation(); clearRx(); });

    dom.jttyFtol.addEventListener("click", () => {
      const list = JttySettings.FTOL_CHOICES_HZ;
      settings.ftolHz = list[(list.indexOf(settings.ftolHz) + 1) % list.length];
      saveSettings(); configureReceiver(); renderSettingsFields(); renderStatusPills();
    });
    dom.jttyProfile.addEventListener("click", () => {
      const list = JttySettings.PROFILES;
      settings.profile = list[(list.indexOf(settings.profile) + 1) % list.length];
      saveSettings(); renderSettingsFields(); renderStatusPills(); renderPreview();
    });

    dom.jttyTxText.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onComposerEnter(); }
    });
    dom.jttyTxText.addEventListener("input", () => { guardCommitted(); renderPreview(); });
    dom.jttyLive.addEventListener("click", () => (live ? finishLive() : startLive()));
    dom.jttyTxAbort.addEventListener("click", abortTx);
    dom.jttyFkeys.addEventListener("click", event => {
      const b = event.target.closest("[data-fkey]");
      if (b) sendFkey(Number(b.dataset.fkey));
    });
    for (const el of [dom.jttyHisCall, dom.jttyExchange]) el.addEventListener("input", () => {
      el.value = el.value.toUpperCase();
      if (el === dom.jttyExchange) { settings.exchange = el.value; saveSettings(); }
    });

    document.addEventListener("keydown", event => {
      const tag = (event.target && event.target.tagName) || "";
      const inSettings = event.target && event.target.closest && event.target.closest("#jttySettingsSection");
      if (event.key === "Escape" && jttyTx.busyOrStarting()) { event.preventDefault(); abortTx(); return; }
      if (event.altKey && (event.key === "j" || event.key === "J")) { event.preventDefault(); live ? finishLive() : startLive(); return; }
      const f = /^F([1-8])$/.exec(event.key);
      if (f && !inSettings && !event.altKey && !event.ctrlKey && !event.metaKey &&
          (tag === "BODY" || event.target.closest(".rtty-tx-body"))) {
        event.preventDefault();
        sendFkey(Number(f[1]) - 1);
      }
    });

    dom.jttyRxHz.addEventListener("change", () => setRxHz(Number(dom.jttyRxHz.value), false));
    dom.jttyTxHz.addEventListener("change", () => setTxHz(Number(dom.jttyTxHz.value)));
    dom.jttyHoldTx.addEventListener("change", () => { settings.holdTx = dom.jttyHoldTx.checked; saveSettings(); renderStatusPills(); });
    dom.jttyLiveEntry.addEventListener("change", () => { settings.liveEntry = dom.jttyLiveEntry.checked; saveSettings(); renderTxState(); });
    dom.jttyLiveIdle.addEventListener("change", () => { settings.liveIdleS = Number(dom.jttyLiveIdle.value); saveSettings(); });
    dom.jttyFtolSelect.addEventListener("change", () => { settings.ftolHz = Number(dom.jttyFtolSelect.value); saveSettings(); configureReceiver(); renderStatusPills(); });
    dom.jttySearch.addEventListener("change", () => { settings.search = dom.jttySearch.value; saveSettings(); configureReceiver(); });
    dom.jttyProfileSelect.addEventListener("change", () => { settings.profile = dom.jttyProfileSelect.value; saveSettings(); renderStatusPills(); renderPreview(); });
    dom.jttyFkeyEditor.addEventListener("change", event => {
      const input = event.target.closest("[data-fkey-edit]");
      if (!input) return;
      const keys = fkeys().slice();
      keys[Number(input.dataset.fkeyEdit)] = input.value.trim() || JttyCodec.DEFAULT_FKEYS[Number(input.dataset.fkeyEdit)];
      settings.fkeys = keys.every((k, i) => k === JttyCodec.DEFAULT_FKEYS[i]) ? null : keys;
      saveSettings();
      renderFkeys();
    });
    dom.jttyFkeysReset.addEventListener("click", () => { settings.fkeys = null; saveSettings(); renderFkeys(); });
    dom.jttyStreamEnabled.addEventListener("change", saveStream);
    dom.jttyRfPercent.addEventListener("input", () => rfPowerAuto.noteDraft());
    dom.jttyRfPercentSet.addEventListener("click", () => rfPowerAuto.setFromField());

    window.addEventListener("storage", event => {
      if (event.key !== JttySettings.STORAGE_KEY) return;
      const other = JttySettings.load(window.localStorage);
      if (other.profile !== settings.profile) { settings.profile = other.profile; renderSettingsFields(); renderStatusPills(); }
    });
  }

  function adoptStationSettings() {
    if (!window.StationProfile) return Promise.resolve();
    return StationProfile.adoptHalf("jtty", settings, JttySettings.isSaved(window.localStorage))
      .then(station => {
        if (!station) return;
        const next = JttySettings.save(window.localStorage, Object.assign({}, station,
          {rxHz: settings.rxHz, txHz: settings.txHz}), {localOnly: true});
        Object.assign(settings, next);
      })
      .catch(() => {});
  }

  function adoptIdentity() {
    if (!window.StationIdentity) return Promise.resolve();
    const apply = changes => {
      if (changes.call) state.myCall = changes.call;
      if (changes.grid) state.myGrid = changes.grid;
      dom.jttyMyCall.textContent = state.myCall || "no call in SETUP → Identity";
      rxView.refilter(store.all());
    };
    StationIdentity.watch(() => ({call: state.myCall, grid: state.myGrid}), apply);
    return StationIdentity.read().then(station => { if (station) apply(station); }).catch(() => {});
  }

  for (const v of JttySettings.FTOL_CHOICES_HZ) dom.jttyFtolSelect.add(new Option(`${v} Hz`, String(v)));
  for (const [k, v] of Object.entries(JttySettings.SEARCH)) dom.jttySearch.add(new Option(v.label, k));
  for (const v of JttySettings.LIVE_IDLE_CHOICES_S) dom.jttyLiveIdle.add(new Option(`${v} s`, String(v)));

  Promise.all([LanGate.gate(), adoptStationSettings(), adoptIdentity()]).then(([ready]) => {
    if (!ready) return;
    dom.jttyExchange.value = settings.exchange;
    renderSettingsFields();
    renderFkeys();
    configureReceiver();
    wire();
    scope.resize();
    render();
    scope.start();

    loadStreamConfig().then(pollStream);
    setInterval(() => { if (dom.jttySettingsSection.open) pollStream(); }, 5000);

    gainPlanStore.loadAndMigrate([{profile: TxGainPlanStore.PROFILE_TONE, store: gainStore}])
      .then(() => { if (gainPlan) gainPlan.reload(); render(); });

    pollState();
    setInterval(pollState, STATE_POLL_MS);
    claimSession();
  });
})();
