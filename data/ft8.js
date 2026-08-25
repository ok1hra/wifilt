// FT8-ICOM page controller (receive only, v1).
//
// Owns: the single-operator lock (shared with JS8Call-ICOM and WSPR-Beacon),
// /state polling for the dial/mode display, the RX audio path, a UTC-aligned
// slot buffer, and dispatch of each 15 s FT8 slot to the decode Worker.
//
// Deliberately does not own (yet): TX, CAT-write (frequency/mode), the automatic
// QSO sequencer, and the logbook. The AUD1 wire protocol (js8-aud1.js) and the
// waterfall (spectrum.js) are used unchanged, exactly as the WSPR page uses them.
//
// Time note: FT8 is time-critical. v1 trusts this browser's Date.now() for slot
// alignment (which is what the firmware's TX validation already relies on). An
// advisory clock-accuracy check against the radio's GPS UTC is a planned follow-up.

(function () {
  "use strict";

  // Same seam data.js/wspr.js use: a fixture can point the audio socket at an
  // unprivileged port. Port 83 is privileged, so this is what lets the page be
  // exercised off a real device.
  const AUDIO_WS_PORT =
    Number(new URLSearchParams(location.search).get("audioPort")) || 83;
  const STATE_POLL_MS = 1000;
  const FETCH_TIMEOUT_MS = 8000;
  const fetchDeadline = (ms = FETCH_TIMEOUT_MS) => AbortSignal.timeout(ms);
  const SESSION_PING_MS = 5000, SESSION_RETRY_MS = 3000, SESSION_PROBE_MS = 250;
  // LAN is exclusive to one of TRX1-TRX3; ?radio=lan makes the firmware answer
  // for that slot instead of the primary radio, same as data.js/wspr.js.
  const RADIO_STATE_URL = "/state?radio=lan";

  const RX_LOW = 200, RX_HIGH = 3000, AUDIO_RATE = 8000;

  // FT8: 15 s slots; the transmission is 12.64 s starting at the slot boundary.
  const SLOT_MS = 15000;
  // How long after a slot boundary to run the decode: the whole transmission plus
  // a margin for the LAN jitter buffer must have arrived. The decoder searches
  // over dt, so a little slack here only shows up as a dt offset.
  const DECODE_TRIGGER_MS = 13500;
  // Samples handed to the decoder per slot (~14 s at 8 kHz), covering the 12.64 s
  // signal with head/tail margin.
  const WINDOW_SAMPLES = Math.round(14 * AUDIO_RATE);
  // Rolling audio ring: a bit more than one slot so a late decode still has its
  // whole window on hand.
  const RING_SAMPLES = 18 * AUDIO_RATE;

  const AUD1_LIVE_MS = 3000;      // dot filled while RX audio is this fresh
  const MAX_SLOT_GROUPS = 60;     // decode history kept in the DOM

  const $ = id => document.getElementById(id);
  const dom = {};
  for (const id of [
    "trxFrequencyValue", "trxMode", "radioModel", "linkState", "trxReconnect",
    "aud1State", "utcClock", "timingState", "trxSlotLabel",
    "sessionBusy", "sessionBusyWhere", "sessionTakeover",
    "ft8Interface", "waterfall", "waterfallCanvas", "waterfallOverlay",
    "spectrumSummary", "audioLevel", "slotState", "decodeStats",
    "decodesSummary", "decodesList",
  ]) dom[id] = $(id);

  // This script's own stamped ?v=, forwarded to the Worker so it importScripts()
  // the vendored ft8ts.js at the same revision the page was built against.
  const ASSET_REV = (() => {
    try {
      const src = (document.currentScript && document.currentScript.src) || "";
      return new URL(src).searchParams.get("v") || "";
    } catch (_error) { return ""; }
  })();

  const utcNow = () => Date.now();

  const state = {
    radio: {connected: false, transceiverType: "", radioName: "", radioNameSeen: false,
            mode: "", frequency: 0},
    audioDb: -99,
    lastAudioMs: 0,
    lastDecode: null,        // {slotUtcMs, count, elapsedMs}
    workerReady: false,
  };

  // ---------------------------------------------------------------- decode worker

  let worker = null, workerFailed = false;
  const latestOverlayFreqs = [];   // decode freqs of the most recent slot, for the overlay

  function startWorker() {
    if (worker) return worker;
    try {
      worker = new Worker("/ft8-worker.js" + (ASSET_REV ? "?v=" + ASSET_REV : ""));
    } catch (error) {
      workerFailed = true;
      dom.decodesSummary.textContent = "decoder failed to start";
      return null;
    }
    worker.onmessage = event => {
      const message = event.data || {};
      if (message.type === "ready") { state.workerReady = true; render(); return; }
      if (message.type === "decodes") { onDecodes(message); return; }
      if (message.type === "error") {
        dom.decodesSummary.textContent = "decode error: " + message.message;
      }
    };
    worker.onerror = () => { dom.decodesSummary.textContent = "decoder crashed"; };
    worker.postMessage({type: "init", version: ASSET_REV});
    return worker;
  }

  // ---------------------------------------------------------------- session lock
  //
  // Ported from wspr.js so the three DATA pages arbitrate identically: one radio,
  // one operator. The firmware is the authority; this renders what it decides.

  const SESSION_TOKEN_KEY = "js8lan.session.token.v1";
  let sessionTokenCache = null, sessionHeld = false;
  let sessionRetryTimer = null, sessionSince = 0, sessionLocalHolder = null;

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
      const response = await fetch(path, {method: "POST", cache: "no-store",
        signal: fetchDeadline(),
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
    // The audio socket belongs to the page, not to a transmission: opening it
    // here is what gives the waterfall and the decoder something to work on.
    openSession();
    render();
  }

  function loseSession(info) {
    closeSession();
    sessionHeld = false;
    dom.sessionBusy.hidden = false;
    dom.sessionBusyWhere.textContent = info && info.owner ? `held by ${info.owner}` : "";
    scheduleSessionRetry();
    render();
  }

  async function claimSession(force = false) {
    const holder = await probeLocalHolder();
    if (holder && localHolderOutranks(holder) && !force) {
      loseSession({owner: "another tab in this browser"});
      return;
    }
    const claim = await sessionPost("/js8/session/claim", {force});
    if (!claim.granted) { loseSession(claim); return; }
    markHeld();
  }

  setInterval(async () => {
    if (!sessionHeld) return;
    const ping = await sessionPost("/js8/session/ping", {});
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

  // ---------------------------------------------------------------- audio socket

  let session = null;

  function audioUrl() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${location.hostname}:${AUDIO_WS_PORT}/audiows` +
           `?token=${encodeURIComponent(sessionToken())}`;
  }

  function openSession() {
    if (session) return session;
    session = new Js8Aud1Transport.Aud1WebSocketSession(
        {url: audioUrl(), WebSocketImpl: WebSocket, wallNow: utcNow})
      .onStatus(status => { if (status.type === "closed") render(); })
      .onControl(() => {});   // RX only: no TX control frames to route yet
    session.onSamples(onSamples);
    session.start();
    return session;
  }

  function closeSession() {
    if (!session) return;
    try { session.stop(); } catch (_error) {}
    session = null;
    resetTimeline();
  }

  // ---------------------------------------------------------------- slot buffer
  //
  // A ring keyed on the stream's absolute sample index, so packet gaps leave a
  // hole in the timeline (zero-filled) instead of splicing time together. The
  // UTC of any sample is anchored from the wall-clock arrival of the first packet
  // of the epoch; transport latency shows up as a dt offset in the decode, which
  // FT8 tolerates by design.

  const ring = new Float32Array(RING_SAMPLES);
  let epoch = null;            // current streamId
  let writeIndex = null;       // next absolute sample index expected
  let anchorSample = 0, anchorWallMs = 0;
  let lastDecodedSlot = -1;

  function resetTimeline() {
    epoch = null; writeIndex = null; anchorSample = 0; anchorWallMs = 0;
  }

  function sampleToUtc(index) {
    return anchorWallMs + (index - anchorSample) * 1000 / AUDIO_RATE;
  }

  function ingestTimeline(samples, metadata) {
    const first = metadata && Number.isFinite(Number(metadata.firstSample))
      ? Number(metadata.firstSample) : null;
    const streamId = metadata ? metadata.streamId : null;

    if (first === null) {
      // No sample index: fall back to plain append at the current head.
      if (writeIndex === null) { writeIndex = 0; anchorSample = 0; anchorWallMs = utcNow(); }
      writeSpan(writeIndex, samples);
      writeIndex += samples.length;
      return;
    }

    if (epoch !== streamId || writeIndex === null) {
      epoch = streamId;
      writeIndex = first;
      anchorSample = first;
      anchorWallMs = utcNow();
    }

    if (first > writeIndex) {
      // Gap: zero-fill the missing span so the timeline stays honest.
      const gap = Math.min(first - writeIndex, RING_SAMPLES);
      for (let i = 0; i < gap; i++) ring[(writeIndex + i) % RING_SAMPLES] = 0;
      writeIndex = first;
    }
    // first <= writeIndex is a duplicate/overlap: rewrite from `first`, harmless.
    writeSpan(first, samples);
    writeIndex = Math.max(writeIndex, first + samples.length);
  }

  function writeSpan(startIndex, samples) {
    for (let i = 0; i < samples.length; i++)
      ring[(startIndex + i) % RING_SAMPLES] = samples[i];
  }

  // Copy [startIndex, startIndex+count) out of the ring, zero-filling anything
  // that has already been overwritten or has not arrived.
  function extractWindow(startIndex, count) {
    const out = new Float32Array(count);
    const oldest = (writeIndex || 0) - RING_SAMPLES;
    for (let i = 0; i < count; i++) {
      const idx = startIndex + i;
      out[i] = (idx >= oldest && idx < writeIndex) ? ring[((idx % RING_SAMPLES) + RING_SAMPLES) % RING_SAMPLES] : 0;
    }
    return out;
  }

  // js8-aud1 delivers (samples, rate, metadata) — metadata carries firstSample /
  // streamId, which the timeline uses to keep slots aligned across packet gaps.
  function onSamples(samples, _rate, metadata) {
    let sum = 0;
    for (const value of samples) sum += value * value;
    state.audioDb = 20 * Math.log10(Math.sqrt(sum / Math.max(1, samples.length)) + 1e-9);
    state.lastAudioMs = Date.now();
    waterfall.ingest(samples);
    ingestTimeline(samples, metadata);
  }

  function maybeDecodeSlot() {
    if (!sessionHeld || writeIndex === null || workerFailed) return;
    const slot = Math.floor((utcNow() - DECODE_TRIGGER_MS) / SLOT_MS);
    if (slot <= lastDecodedSlot) return;
    lastDecodedSlot = slot;

    const slotUtcMs = slot * SLOT_MS;
    // Sample index at the slot boundary, from the wall anchor.
    const startIndex = Math.round(anchorSample + (slotUtcMs - anchorWallMs) * AUDIO_RATE / 1000);
    const samples = extractWindow(startIndex, WINDOW_SAMPLES);
    startWorker();
    if (!worker) return;
    worker.postMessage(
      {type: "decode", slotUtcMs, sampleRate: AUDIO_RATE, version: ASSET_REV, samples},
      [samples.buffer]
    );
  }

  // ---------------------------------------------------------------- decode render

  function onDecodes(message) {
    const decodes = Array.isArray(message.decodes) ? message.decodes : [];
    state.lastDecode = {slotUtcMs: message.slotUtcMs, count: decodes.length, elapsedMs: message.elapsedMs};

    latestOverlayFreqs.length = 0;
    for (const d of decodes) latestOverlayFreqs.push(d.freq);
    waterfall.paintOverlay();

    renderSlotGroup(message.slotUtcMs, decodes);
    dom.decodesSummary.textContent =
      `${decodes.length} decode${decodes.length === 1 ? "" : "s"} · ${Math.round(message.elapsedMs)} ms`;
    dom.decodeStats.textContent = `${decodes.length} @ ${Math.round(message.elapsedMs)} ms`;
  }

  function slotStamp(slotUtcMs) {
    return new Date(slotUtcMs).toISOString().slice(11, 19);
  }

  function renderSlotGroup(slotUtcMs, decodes) {
    const group = document.createElement("div");
    group.className = "ft8-slot-group";

    const divider = document.createElement("div");
    divider.className = "ft8-slot-divider";
    divider.textContent = `--- ${slotStamp(slotUtcMs)} UTC · ${decodes.length} ---`;
    group.appendChild(divider);

    decodes
      .slice()
      .sort((a, b) => a.freq - b.freq)
      .forEach(d => group.appendChild(renderDecodeRow(d)));

    dom.decodesList.prepend(group);
    while (dom.decodesList.children.length > MAX_SLOT_GROUPS)
      dom.decodesList.removeChild(dom.decodesList.lastChild);
  }

  function renderDecodeRow(d) {
    const row = document.createElement("div");
    row.className = "ft8-decode-row";
    const msg = String(d.msg || "").trim();
    if (/^CQ\b/.test(msg)) row.classList.add("is-cq");
    row.innerHTML =
      `<span class="col-db">${formatSnr(d.snr)}</span>` +
      `<span class="col-dt">${Number(d.dt).toFixed(1)}</span>` +
      `<span class="col-freq">${Math.round(d.freq)}</span>` +
      `<span class="col-msg"></span>`;
    row.querySelector(".col-msg").textContent = msg;
    return row;
  }

  function formatSnr(snr) {
    const value = Math.round(Number(snr));
    return (value >= 0 ? "+" : "") + value;
  }

  // ---------------------------------------------------------------- waterfall

  const waterfall = new Spectrum.Waterfall({
    canvas: dom.waterfallCanvas, overlay: dom.waterfallOverlay, container: dom.waterfall,
    sampleRate: AUDIO_RATE, lowHz: RX_LOW, highHz: RX_HIGH,
    drawOverlay: (context, view) => drawDecodeOverlay(context, view),
  });

  function drawDecodeOverlay(context, view) {
    const width = dom.waterfallOverlay.width;
    context.save();
    context.strokeStyle = "rgba(224,160,32,0.9)";
    context.lineWidth = 1;
    for (const freq of latestOverlayFreqs) {
      if (freq < RX_LOW || freq > RX_HIGH) continue;
      const x = Math.round(view.hzToX(freq, width)) + 0.5;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, 6);
      context.stroke();
    }
    context.restore();
  }

  // ---------------------------------------------------------------- radio /state

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
      };
    } catch (_error) {
      state.radio.connected = false;
    } finally { statePollInFlight = false; }
    render();
  }

  const liveRadioModel = () =>
    (globalThis.IcomModels && IcomModels.liveRadioModel)
      ? IcomModels.liveRadioModel(state.radio) : (state.radio.radioName || "");

  // ---------------------------------------------------------------- render

  function render() {
    const radio = state.radio;

    if (globalThis.Js8TrxPresets && Js8TrxPresets.formatFrequency)
      dom.trxFrequencyValue.textContent = radio.frequency
        ? Js8TrxPresets.formatFrequency(radio.frequency) : "--.---.---";
    else
      dom.trxFrequencyValue.textContent = radio.frequency
        ? (radio.frequency / 1e6).toFixed(6) : "--.---.---";

    dom.trxMode.textContent = radio.mode || "---";
    dom.radioModel.textContent = liveRadioModel() || "--";

    const linked = radio.connected;
    dom.linkState.textContent = linked ? "● LINKED" : "● OFFLINE";
    dom.linkState.classList.toggle("linked", linked);

    const audioLive = sessionHeld && (Date.now() - state.lastAudioMs) < AUD1_LIVE_MS;
    dom.aud1State.textContent = audioLive ? "AUD1 ●" : "AUD1 —";
    dom.aud1State.classList.toggle("live", audioLive);

    dom.audioLevel.textContent = `${Math.round(state.audioDb)} dBFS`;
  }

  function renderClock() {
    dom.utcClock.textContent = "UTC " + new Date().toISOString().slice(11, 19);
    const inSlot = utcNow() % SLOT_MS;
    const secsIntoSlot = (inSlot / 1000).toFixed(1);
    dom.slotState.textContent = `${secsIntoSlot}s / ${SLOT_MS / 1000}s`;
    render();
  }

  // ---------------------------------------------------------------- boot

  dom.sessionTakeover.addEventListener("click", () => claimSession(true));
  if (dom.trxReconnect) dom.trxReconnect.addEventListener("click", () => pollState());

  waterfall.resize();
  window.addEventListener("resize", () => waterfall.resize());

  startWorker();
  claimSession();
  pollState();
  setInterval(pollState, STATE_POLL_MS);
  setInterval(renderClock, 250);
  setInterval(maybeDecodeSlot, 200);
})();
