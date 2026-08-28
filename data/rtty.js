// RTTY-ICOM page. See docs/rtty-implementace.md.
//
// Owns: settings, the shared single-operator lock (js8lan.session, same as
// JS8Call-ICOM/WSPR-Beacon -- kap.1 decision 9), /state polling, the RX
// decode chain (RttyCodec.Decoder fed from the AUD1 socket), both TX methods
// (audio-stream and FSK-backend, kap.6), click-to-tune and click-to-callsign.
//
// Deliberately does not own: the AUD1 wire protocol (js8-aud1.js, unchanged),
// the waterfall FFT (spectrum.js, unchanged except the `lastValues` hook
// kap.7 depends on), Baudot/AFSK encode-decode (rtty-codec.js -- NOT shared
// with log.js, see that file's own header for why the original "share it"
// design was replaced with a BroadcastChannel hand-off instead), or TX gain
// calibration (tx-gain-cal*.js/tx-gain-plan*.js, unchanged -- mounted exactly
// like data.js/wspr.js already do).
//
// Independent copy of data.js/wspr.js/mercury.js's own pollRadio()/render()
// pattern, not a shared module -- same "no extraction" convention those three
// already settled on (see mercury.html's own header comment for why).

(function () {
  "use strict";

  const AUDIO_WS_PORT =
    Number(new URLSearchParams(location.search).get("audioPort")) || 83;
  const STATE_POLL_MS = 1000;
  const FETCH_TIMEOUT_MS = 8000, FETCH_FLASH_TIMEOUT_MS = 12000;
  const fetchDeadline = (ms = FETCH_TIMEOUT_MS) => AbortSignal.timeout(ms);
  const SESSION_PING_MS = 5000, SESSION_RETRY_MS = 3000, SESSION_PROBE_MS = 250;
  const RADIO_STATE_URL = "/state?radio=lan";
  const RADIO_CMD_URL = "/cmd?radio=lan";

  // RX @ 8 kHz / TX @ 48 kHz, same AUD1 sample rates JS8/WSPR/Mercury already
  // use (kap.3). BASE_LOW_HZ/BASE_HIGH_HZ are the 100%-zoom waterfall/
  // live-spectrum window -- deliberately the SAME numbers as
  // RttySettings.TONE_MIN_HZ/MAX_HZ (code-review, same session: was a 3rd
  // independent 500/2700 literal, plus a 4th in rtty.html's <input min/max>,
  // which the boot sequence below now syncs from these instead of carrying
  // its own copy). That clamp range is NOT the same thing as the currently
  // VISIBLE window once zoom (item 15) narrows it -- see waterfall.lowHz/
  // waterfall.highHz, the live window, updated only by setRange() -- the
  // numeric tone field still accepts the full range regardless of current zoom.
  const BASE_LOW_HZ = RttySettings.TONE_MIN_HZ, BASE_HIGH_HZ = RttySettings.TONE_MAX_HZ,
        RX_AUDIO_RATE = 8000, TX_AUDIO_RATE = 48000;
  // kap.3: immediate push-to-talk, not a periodic slot -- slotUtcMs = now + leadMs.
  const TX_LEAD_MS = 800, TX_PREBUFFER_MS = 1000, TX_STREAM_LEAD_MS = 350,
        TX_PACKET_MS = 20, TX_RING_LIMIT_MS = 1400, TX_WATCHDOG_MARGIN_MS = 2000;
  const RX_LOG_MAX_CHARS = 20000;

  const $ = id => document.getElementById(id);
  const dom = {};
  for (const id of [
    "trxFrequencyValue", "trxMode", "radioModel", "linkState", "trxFrequency",
    "frequencyMenu", "trxSlotLabel", "trxReconnect", "trxPower", "trxPowerWatts",
    "aud1State", "planField", "planButton", "planButtonValue", "calField",
    "sessionBusy", "sessionBusyWhere", "sessionTakeover",
    "rttyReverse", "rttyTxMethod", "rttySquelch", "rttySnr",
    "waterfall", "waterfallCanvas", "waterfallOverlay", "spectrumSummary",
    "liveSpectrumCanvas",
    "rttyRxLog", "rxSummary",
    "rttyTxText", "rttyTxAbort", "rttyTxState",
    "rttySquelchInput", "rttySquelchLive", "rttyToneInput", "settingsSummary",
    // Item 13 (grilled 2026-08-27, second session): RF power target, moved
    // into SETTINGS -- see that section's own comment for why it lives here.
    "rttyRfPowerField", "rttyRfPercent", "rttyRfPercentWatts",
    "rttyRfPercentSet", "rttyRfPercentState",
  ]) dom[id] = $(id);

  const state = {
    radio: {connected: false, transceiverType: "", radioName: "", radioNameSeen: false,
      mode: "", frequency: 0, tx: false, rfPower: 0, rfPowerSeen: false},
    lastSnrDb: null, rxChars: 0,
  };

  const settings = RttySettings.load(window.localStorage);
  function saveSettings() { RttySettings.save(window.localStorage, settings); }

  // ---- session lease (shared with JS8/WSPR, kap.1 decision 9) --------------
  //
  // Verbatim pattern from wspr.js's own claimSession()/loseSession() -- see
  // that file's own comments for the BroadcastChannel probe's reasoning (a
  // duplicated tab shares sessionStorage, so the firmware alone cannot tell
  // the two apart).
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
    openSession();
    render();
  }

  function loseSession(info) {
    abortAudioTx("session lost");
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

  // ---- radio state ------------------------------------------------------

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
      };
      // Item 13: a write is owed on page load and again whenever the link
      // returns -- only for a reply that actually arrived, so it is the
      // radio's link being judged, not the browser's. rfPowerAuto itself
      // tracks the up/down transition (data/rf-power-auto.js).
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

  // ---- frequency menu (rtty-presets.js) ----------------------------------

  function renderFrequencyMenu() {
    const selected = state.radio.frequency;
    dom.frequencyMenu.innerHTML =
      `<header><strong>RTTY dial frequencies</strong><small>Standard IARU R1 RTTY calling frequencies</small>` +
      `<span class="tt-actions"><button class="tt-clear" type="button" data-menu-close title="Close">CLOSE</button></span></header>` +
      `<div class="frequency-presets">${RttyPresets.PRESETS.map(preset =>
        `<button class="frequency-preset${preset.frequencyHz === selected ? " current" : ""}"` +
        ` type="button" data-frequency="${preset.frequencyHz}">` +
        `<strong>${preset.band}</strong><span>${(preset.frequencyHz / 1e6).toFixed(4)} MHz</span></button>`).join("")}</div>` +
      `<footer>Sets the dial frequency only -- the mode and TX path are unaffected.</footer>`;
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

  // ---- AUD1 session -------------------------------------------------------

  let session = null;

  function audioUrl() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${location.hostname}:${AUDIO_WS_PORT}/audiows` +
           `?token=${encodeURIComponent(sessionToken())}`;
  }

  function openSession() {
    if (session) return session;
    session = new Js8Aud1Transport.Aud1WebSocketSession(
        {url: audioUrl(), WebSocketImpl: WebSocket, wallNow: () => Date.now()})
      .onStatus(() => render())
      .onControl(message => {
        // One socket, two possible drivers (this page's own TX, and the CAL
        // PLAN calibration carrier), never at once -- gainCal.blockingReason
        // below is what actually enforces that; this only routes the frames.
        if (gainCal && gainCal.running) gainCal.onControl(message);
        render();
      });
    session.onSamples(onSamples);
    session.start();
    return session;
  }

  function closeSession() {
    resetAudioTx();
    if (session) { session.stop(); session = null; }
  }

  // ---- waterfall + live spectrum (kap.7) ----------------------------------

  const waterfall = new Spectrum.Waterfall({
    canvas: dom.waterfallCanvas, overlay: dom.waterfallOverlay, container: dom.waterfall,
    sampleRate: RX_AUDIO_RATE, lowHz: BASE_LOW_HZ, highHz: BASE_HIGH_HZ,
    drawOverlay: (context, view) => drawToneOverlay(context, view),
  });

  function drawToneOverlay(context, view) {
    // The canvas actually being drawn to, not a hardcoded other one -- this
    // used to always read dom.waterfallOverlay's own size even when called
    // for the live-spectrum canvas (code-review, item 2/14: harmless while
    // both canvases happened to be the same height, which stopped being true
    // once item 14 made them different).
    const width = context.canvas.width, height = context.canvas.height;
    const markHz = settings.toneHz + RttyCodec.SHIFT_HZ / 2;
    const spaceHz = settings.toneHz - RttyCodec.SHIFT_HZ / 2;
    context.setLineDash([]);
    for (const [hz, color] of [[markHz, "#5ad18a"], [spaceHz, "#ff6b6b"]]) {
      const x = view.hzToX(hz, width);
      context.strokeStyle = color;
      context.lineWidth = 3;   // item 2: 3x (was 1)
      context.beginPath(); context.moveTo(Math.round(x) + .5, 0);
      context.lineTo(Math.round(x) + .5, height); context.stroke();
    }
  }

  // Item 15: 100%/200%/400% narrow BASE_LOW_HZ..BASE_HIGH_HZ around the tone
  // AS IT STANDS at the moment the pill is pressed -- not continuously
  // re-centred on every click-to-tune, which by construction always lands
  // inside whatever window is already visible (see the click handler below,
  // which reads waterfall.lowHz/highHz -- the Waterfall instance's own public
  // fields, kept current by setRange() alone -- rather than a 2nd copy), so
  // it never needs to move the window itself. Re-centring on every click
  // would mean a waterfall.setRange() -> resetAgc() on every click too,
  // restarting the AGC's learned noise floor (and the visible color scale
  // hiccuping along with it) far more often than the operator's own clicks
  // warrant (grilled 2026-08-27, second session). Deliberately not
  // persisted -- always starts at 100%.
  //
  // 100% is the fixed base range, NOT tone-centred like 200/400% (code-review,
  // same session): centring it the same way would mean "100%" only ever
  // reproduces the true 500-2700 Hz range when the tone happens to sit
  // exactly at its 1600 Hz midpoint, and for a low enough tone (e.g. the
  // 500 Hz space minimum, centre 585) the window would extend below 0 Hz --
  // spectrum.js's draw() has no floor check on lowHz, so a negative window
  // feeds it negative FFT bin indices, reading undefined off the end of a
  // Float32Array and poisoning the percentile AGC with NaN until the next
  // zoom press. 200%/400% are always safe: with toneHz clamped to
  // [TONE_MIN_HZ+85, TONE_MAX_HZ+85] (rtty-settings.js), their narrower spans
  // can only push the window a little past BASE_LOW_HZ/BASE_HIGH_HZ at the
  // very edges, never negative.
  function applyZoom(percent) {
    let low, high;
    if (percent === 100) {
      low = BASE_LOW_HZ; high = BASE_HIGH_HZ;
    } else {
      const span = (BASE_HIGH_HZ - BASE_LOW_HZ) * 100 / percent;
      const center = settings.toneHz;   // the midpoint mark/space sit ±85 Hz either side of
      low = center - span / 2; high = center + span / 2;
    }
    waterfall.setRange(low, high);
    document.querySelectorAll(".rtty-zoom-pill").forEach(button =>
      button.classList.toggle("active", Number(button.dataset.zoom) === percent));
    dom.spectrumSummary.textContent = `RX ${Math.round(low)}–${Math.round(high)} Hz`;
  }

  function onSamples(samples) {
    // Blank during this station's own TX, same as JS8/WSPR/Mercury (the LAN
    // audio path is itself duplex -- ic705-rx-audio-during-tx -- so without
    // this guard the waterfall/decoder would show our own signal as if it
    // were a received one).
    if (session && session.ptt) return;
    if (decoder) decoder.pushSamples(samples);
    waterfall.ingest(samples);
  }

  // Item 4: a smoothed line/envelope, not the bar chart this replaced -- no
  // fill under it (grilled 2026-08-27, second session). Two independent
  // smoothing passes, both "partial", not a heavy filter:
  //  - temporal: a light exponential blend frame-to-frame (smoothedSpectrum),
  //    same idea spectrum.js's own AGC already uses for agcLow/agcHigh;
  //  - spatial: a small moving average across neighbouring bins, so the trace
  //    reads as an envelope rather than a jagged per-bin FFT line.
  let smoothedSpectrum = null;
  const SPATIAL_SMOOTH_RADIUS = 2;

  function drawLiveSpectrum() {
    requestAnimationFrame(drawLiveSpectrum);
    const canvas = dom.liveSpectrumCanvas, ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Through waterfall.state() (code-review 2026-08-27), the same accessor
    // every other page's own spectrumState() already reads agcLow/agcHigh
    // through, rather than 3 separate direct-property reads. Empty/undefined
    // lastValues before the first FFT frame lands (or, previously, before
    // the deferred spectrum.js hook -- now landed, kap.7) draws nothing,
    // never an error.
    const {agcLow, agcHigh, lastValues: values} = waterfall.state();
    if (!values || !values.length) return;

    // A zoom change (or the first frame) alters how many FFT bins fall inside
    // the visible window (spectrum.js's own first/last) -- a stale buffer of
    // a different length cannot be blended into the new one, so it is simply
    // replaced rather than reset to zero (which would draw a false dip).
    if (!smoothedSpectrum || smoothedSpectrum.length !== values.length)
      smoothedSpectrum = Float32Array.from(values);
    else
      for (let i = 0; i < values.length; i++)
        smoothedSpectrum[i] += (values[i] - smoothedSpectrum[i]) * .35;

    const lo = agcLow, hi = Math.max(agcHigh, lo + 1);
    const points = new Array(smoothedSpectrum.length);
    for (let i = 0; i < smoothedSpectrum.length; i++) {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - SPATIAL_SMOOTH_RADIUS);
           j <= Math.min(smoothedSpectrum.length - 1, i + SPATIAL_SMOOTH_RADIUS); j++)
        { sum += smoothedSpectrum[j]; count++; }
      const norm = Math.max(0, Math.min(1, (sum / count - lo) / (hi - lo)));
      points[i] = canvas.height - norm * canvas.height;
    }

    ctx.strokeStyle = "rgba(120,220,200,.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const stepX = canvas.width / (points.length - 1 || 1);
    points.forEach((y, i) => (i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * stepX, y)));
    ctx.stroke();

    // The real Waterfall instance, not a duck-typed stand-in (code-review) --
    // its own hzToX() already does exactly this math against its current
    // this.lowHz/this.highHz, the same object the overlay canvas's own
    // paintOverlay() passes drawOverlay (spectrum.js: drawOverlay(this.
    // overlayContext, this)). One formula, one source of the current window,
    // used by both canvases.
    drawToneOverlay(ctx, waterfall);
  }

  // ---- RX decode (RttyCodec.Decoder) --------------------------------------

  const decoder = new RttyCodec.Decoder(RX_AUDIO_RATE,
    {toneHz: settings.toneHz, reverse: settings.reverse, squelchThreshold: settings.squelchThreshold});

  let rxOpenWordSpan = null;
  decoder.onChar((ch, meta) => {
    state.rxChars++;
    if (Number.isFinite(meta.snrDb)) state.lastSnrDb = meta.snrDb;
    const isBreak = ch === " " || ch === "\n" || ch === "\r";
    if (isBreak) {
      rxOpenWordSpan = null;
      if (ch !== "\r") dom.rttyRxLog.appendChild(document.createTextNode(ch));
    } else {
      if (!rxOpenWordSpan) {
        rxOpenWordSpan = document.createElement("span");
        rxOpenWordSpan.className = "rtty-tok";
        dom.rttyRxLog.appendChild(rxOpenWordSpan);
      }
      rxOpenWordSpan.textContent += ch;
    }
    trimRxLog();
    dom.rttyRxLog.scrollTop = dom.rttyRxLog.scrollHeight;
    renderStatusPills();
  });
  function trimRxLog() {
    while (dom.rttyRxLog.textContent.length > RX_LOG_MAX_CHARS && dom.rttyRxLog.firstChild)
      dom.rttyRxLog.removeChild(dom.rttyRxLog.firstChild);
  }

  // Item 6 (grilled 2026-08-27, second session): this station's own sent text,
  // echoed into the RX log like a monitor -- red, plain text, not a .rtty-tok
  // (no click/hover: the operator's own callsign in "CQ CQ DE OK1HRA" must
  // never be mistaken for a station to log). Called from both TX methods, at
  // the moment each commits to sending, whether the send came from this
  // page's own composer or a QRPlog hand-off (kap.8.3) -- there is exactly
  // one call site per method, so every path echoes the same way.
  // Tracks the most recent echo so a send that fails AFTER being echoed
  // (session.prepare()/setMode/sendCw can all still throw here -- kap.6's own
  // failure modes) can retract it, rather than leaving a red "sent" line for
  // a message that never actually went out (code-review: the RX log is the
  // one place QRPlog cross-references what was sent, and it had no way to
  // tell a genuine send from a failed attempt). Only one at a time needs
  // tracking -- txBusy() already keeps the two TX methods mutually exclusive.
  let lastTxEchoSpan = null;

  function echoTxText(text) {
    rxOpenWordSpan = null;   // don't let a live RX token keep growing into this
    const span = document.createElement("span");
    span.className = "rtty-tx-echo";
    span.textContent = text;
    dom.rttyRxLog.appendChild(span);
    dom.rttyRxLog.appendChild(document.createTextNode("\n"));
    trimRxLog();
    dom.rttyRxLog.scrollTop = dom.rttyRxLog.scrollHeight;
    lastTxEchoSpan = span;
  }

  function markTxEchoFailed(span) {
    if (!span || !span.isConnected) return;   // scrolled out of the trimmed log already
    span.classList.add("rtty-tx-echo-failed");
    span.textContent += " (failed)";
  }

  // Click a decoded token -> hand it to QRPlog, same BroadcastChannel dxc.html
  // already uses (kap.5/8.1) -- zero change in log.js's own listener.
  const dxcChannel = (() => { try { return new BroadcastChannel("wifilt-dxc-action"); } catch (_error) { return null; } })();
  dom.rttyRxLog.addEventListener("click", event => {
    const token = event.target.closest(".rtty-tok");
    if (!token || !dxcChannel) return;
    const callsign = token.textContent.trim();
    if (!callsign) return;
    dxcChannel.postMessage({type: "dxc-tune", callsign, trx: LanGate.slot ? LanGate.slot() : 0});
  });

  // ---- click-to-tune (shared RX/TX tone, kap.5) ---------------------------

  // Item 3 (grilled 2026-08-27, second session): a click/typed value sets the
  // SPACE/red line directly, not the internal centre -- settings.toneHz stays
  // the centre RttyCodec.Encoder/Decoder actually use (±SHIFT_HZ/2 for
  // mark/space), so every entry point that used to write it directly now goes
  // through this one conversion instead. Also where item 1's fix lives: the
  // waterfall overlay used to only repaint on resize(), so neither this nor
  // the numeric field below ever moved the lines actually drawn over the
  // waterfall -- only the live spectrum's own per-frame redraw showed the
  // change.
  function setToneFromSpaceHz(spaceHz) {
    const clamped = Math.max(RttySettings.TONE_MIN_HZ, Math.min(RttySettings.TONE_MAX_HZ, spaceHz));
    settings.toneHz = clamped + RttyCodec.SHIFT_HZ / 2;
    saveSettings();
    decoder.setToneOffset(settings.toneHz);
    waterfall.paintOverlay();
    dom.rttyToneInput.value = String(clamped);
  }

  dom.waterfall.addEventListener("click", event => {
    const rect = dom.waterfall.getBoundingClientRect();
    // Proportional within the CURRENTLY VISIBLE window (item 15) -- reads
    // waterfall.lowHz/highHz directly (the Waterfall instance's own public
    // fields) rather than a 2nd tracked copy, so a click always lands inside
    // whatever window setRange() last established, zoomed or not.
    const clickedHz = Math.round(waterfall.lowHz +
      (event.clientX - rect.left) / rect.width * (waterfall.highHz - waterfall.lowHz));
    setToneFromSpaceHz(clickedHz);
  });

  // ---- TX: audio-stream method (kap.6.1) ----------------------------------
  //
  // Own compact immediate-PTT pacing loop. Correction (code-review, same
  // session): Js8Tx.TxController.queue() DOES have an immediate/"tune" path
  // (`immediate:true` -> nextSlotUtcMs = now + prebuffer, no planSlot() call
  // -- already used in production for JS8's own TUNE button, data.js:6696) --
  // an earlier version of this comment claimed no existing controller fit
  // kap.3's "now + leadMs, no periodic slot", which was wrong. It still is
  // not a clean fit: queue() unconditionally requires a truthy
  // `MODES[request.mode]` even on the immediate path (js8-tx.js:182, dead
  // weight there since planSlot() -- the only place `mode` matters for
  // immediate sends -- is never called), which would mean embedding a
  // meaningless JS8 period number into every RTTY TX event. Kept as an own
  // loop rather than force that mismatch; WsprTx.WsprTx has no immediate path
  // at all (always a 120 s WSPR frame) so that half of the original claim
  // stands. Js8Tx.packetizeTxPcm48k() itself IS mode-agnostic and is reused
  // verbatim (see rtty.html's own script-list note for why it comes from
  // js8-tx.js and not wspr-tx.js, which has its own unexported copy).

  let audioTx = null;   // {txId, packets, packetIndex, prebufferStartUtcMs, endUtcMs, watchdogUtcMs, begun, audioEnded, ticker}
  let nextAudioTxId = 1;
  // True from the moment sendAudioStream() commits to a send until audioTx
  // itself is assigned (or the attempt fails) -- closes the TOCTOU window the
  // `if (audioTx) throw` guard alone left open across the `await
  // session.prepare(...)` below (code-review: a 2nd overlapping call, e.g. the
  // composer's own SEND racing an external QRPlog-triggered send, could pass
  // the guard before the 1st call's audioTx was ever assigned).
  let audioTxStarting = false;

  function resetAudioTx() {
    if (audioTx && audioTx.ticker) clearInterval(audioTx.ticker);
    audioTx = null;
  }

  async function sendAudioStream(text) {
    if (!session || !session.hello) throw new Error("AUD1 session is not ready yet");
    if (audioTx || audioTxStarting) throw new Error("a transmission is already in progress");
    audioTxStarting = true;
    try {
      const encoder = new RttyCodec.Encoder(TX_AUDIO_RATE, {toneHz: settings.toneHz});
      const pcm16 = encoder.encode(text);
      if (pcm16.length === 0) throw new Error("nothing to send (no supported characters)");
      echoTxText(text);   // item 6: as this page commits to the send, not after it finishes
      const myTxId = nextAudioTxId++;
      const packets = Js8Tx.packetizeTxPcm48k(pcm16, {streamId: session.hello.streamId, txId: myTxId});
      const now = Date.now();
      const slotUtcMs = now + TX_LEAD_MS;
      const prebufferSamples = Math.round(TX_PREBUFFER_MS * TX_AUDIO_RATE / 1000);
      await session.prepare(myTxId, {mode: 0, toneHz: settings.toneHz, samples: pcm16.length,
        packets: packets.length, slotUtcMs, prebufferSamples, packetMs: TX_PACKET_MS});
      const streamSpanMs = Math.min(TX_PREBUFFER_MS + TX_STREAM_LEAD_MS, TX_RING_LIMIT_MS);
      audioTx = {txId: myTxId, packets, packetIndex: 0,
        prebufferStartUtcMs: slotUtcMs - streamSpanMs,
        endUtcMs: slotUtcMs + pcm16.length / (TX_AUDIO_RATE / 1000),
        begun: false, audioEnded: false};
      audioTx.watchdogUtcMs = audioTx.endUtcMs + TX_WATCHDOG_MARGIN_MS;
      audioTx.ticker = setInterval(tickAudioTx, 40);
      render();
    } finally {
      audioTxStarting = false;
    }
  }

  function tickAudioTx() {
    if (!audioTx) return;
    const now = Date.now();
    try {
      if (!audioTx.begun && now >= audioTx.prebufferStartUtcMs) {
        session.begin(audioTx.txId);
        audioTx.begun = true;
      }
      if (audioTx.begun) {
        const due = Math.min(audioTx.packets.length, Math.max(0,
          Math.floor((now - audioTx.prebufferStartUtcMs) / TX_PACKET_MS) + 1));
        while (audioTx.packetIndex < due) {
          session.write(audioTx.packets[audioTx.packetIndex]);
          audioTx.packetIndex++;
        }
        if (audioTx.packetIndex === audioTx.packets.length && !audioTx.audioEnded) {
          session.end(audioTx.txId);
          audioTx.audioEnded = true;
        }
      }
      if (audioTx.audioEnded && session.isDrained(audioTx.txId)) {
        session.complete(audioTx.txId);
        finishAudioTx(null);
        return;
      }
      if (now > audioTx.watchdogUtcMs) throw new Error("TX drain watchdog");
    } catch (error) {
      try { session.abort(audioTx.txId, String(error.message || error)); } catch (_e) {}
      finishAudioTx(String(error.message || error));
      return;
    }
    render();
  }

  function abortAudioTx(reason) {
    if (!audioTx) return;
    try { session.abort(audioTx.txId, reason); } catch (_e) {}
    finishAudioTx(reason);
  }

  function finishAudioTx(error) {
    resetAudioTx();
    dom.rttyTxState.textContent = error ? `error: ${error}` : "sent";
    if (error) markTxEchoFailed(lastTxEchoSpan);
    if (externalTxRequestId && rttyTxChannel) {
      rttyTxChannel.postMessage({type: "rtty-tx-result", requestId: externalTxRequestId,
        ok: !error, error: error || undefined});
      externalTxRequestId = null;
    }
    render();
  }

  // ---- QRPlog hand-off receiver (docs/rtty-implementace.md §8.2/8.3) ------
  //
  // log.js never opens its own AUD1 socket (would contest this page's own
  // session) -- it hands the text here instead, over a dedicated channel.
  // Two-phase: an immediate probe-ack proves a live, idle session is held
  // here before log.js commits to the (possibly many-second) actual send.

  const rttyTxChannel = (() => { try { return new BroadcastChannel("wifilt-rtty-tx"); } catch (_error) { return null; } })();
  let externalTxRequestId = null;

  // Whether THIS tab holds the live session -- at most one rtty.html tab ever
  // does, since the session lease itself is exclusive. Deliberately separate
  // from "and is idle": a 'rtty-tx-send' broadcast reaches every open
  // rtty.html tab (BroadcastChannel has no addressing), and a non-holding tab
  // must stay SILENT rather than reply, or its near-instant reply races the
  // real holder's much slower actual transmission result and usually wins
  // (code-review: this used to fold "not the holder" and "holder but busy"
  // into the same canAcceptExternalSend() check, so every open-but-idle
  // rtty.html tab replied "busy with another transmission" to every send).
  function isSessionHolder() {
    return Boolean(sessionHeld && session && session.hello);
  }

  if (rttyTxChannel) rttyTxChannel.onmessage = event => {
    const msg = event.data || {};
    if (msg.type === "rtty-tx-probe") {
      if (isSessionHolder() && !audioTx && !audioTxStarting)
        rttyTxChannel.postMessage({type: "rtty-tx-probe-ack", requestId: msg.requestId});
      return;
    }
    if (msg.type !== "rtty-tx-send") return;
    if (!isSessionHolder()) return; // not the holder -- the real one answers, or nobody does
    if (audioTx || audioTxStarting) {
      rttyTxChannel.postMessage({type: "rtty-tx-result", requestId: msg.requestId,
        ok: false, error: "this RTTY-ICOM page is busy with another transmission"});
      return;
    }
    // The RF-safety pledge this used to gate on is gone entirely (item 7,
    // grilled 2026-08-27, second session -- composer and QRPlog hand-off
    // alike). echoTxText() inside sendAudioStream() below is what shows the
    // operator what is being sent; the compose box itself no longer needs to.
    externalTxRequestId = msg.requestId;
    const text = String(msg.text || "");
    lastTxEchoSpan = null;   // same reasoning as onSendClick's own reset above
    sendAudioStream(text).catch(error => {
      const requestId = externalTxRequestId;
      externalTxRequestId = null;
      markTxEchoFailed(lastTxEchoSpan);
      if (requestId && rttyTxChannel) rttyTxChannel.postMessage({type: "rtty-tx-result",
        requestId, ok: false, error: String(error.message || error)});
    });
  };

  // ---- TX: FSK-backend method (kap.6.2) -----------------------------------
  //
  // Mode-guard sequence, purely frontend: snapshot -> setMode RTTY if needed
  // -> sendCw -> restore. sendCW()/sendFsk() (wifilt.ino) already route
  // RTTY/RTTY-R to the GPIO bit-bang path unchanged -- verified against
  // wifilt.ino:7326-7340/7459-7522.

  let fskSending = false;

  async function sendFskBackend(text) {
    echoTxText(text);   // item 6: same "at the start" timing as the audio-stream method
    const originalMode = state.radio.mode;
    const isRttyMode = originalMode === "RTTY" || originalMode === "RTTY-R";
    fskSending = true;
    render();
    try {
      if (!isRttyMode) {
        await command({type: "setMode", mode: "RTTY"});
        await waitForState(radio => radio.mode === "RTTY" || radio.mode === "RTTY-R", 5000);
      }
      await command({type: "sendCw", text});
      dom.rttyTxState.textContent = "sent";
    } finally {
      if (!isRttyMode && originalMode) {
        try {
          await command({type: "setMode", mode: originalMode});
          await waitForState(radio => radio.mode === originalMode, 5000);
        } catch (_error) { /* best-effort restore; the operator can see the mode pill */ }
      }
      fskSending = false;
      render();
    }
  }

  // ---- TX composer wiring --------------------------------------------------

  // Two TX methods, two independent pieces of state (audioTx carries its own
  // packet-pacing detail an abort needs; fskSending is a plain flag) -- but
  // "is either one busy" was re-derived slightly differently at each call
  // site (code-review). Single helper for that question; call sites that
  // need to know WHICH one is busy still check audioTx/fskSending directly.
  function txBusy() { return Boolean(audioTx) || fskSending; }

  async function onSendClick() {
    const text = dom.rttyTxText.value.trim();
    if (!text || txBusy()) return;
    // Cleared before the attempt, not after: a rejection that happens BEFORE
    // echoTxText() ever runs (e.g. "AUD1 session is not ready yet") must not
    // retroactively mark a PREVIOUS, already-settled send's echo as failed.
    lastTxEchoSpan = null;
    dom.rttyTxState.textContent = "sending…";
    render();
    try {
      if (settings.txMethod === "audio") await sendAudioStream(text);
      else await sendFskBackend(text);
      // Item 7: clear once genuinely committed (not on a validation throw
      // above, which leaves the typed text in place to fix and retry) --
      // same flow as js8call's own compose box.
      dom.rttyTxText.value = "";
      renderStatusPills();
    } catch (error) {
      dom.rttyTxState.textContent = `error: ${String(error.message || error)}`;
      markTxEchoFailed(lastTxEchoSpan);
      render();
    }
  }

  function onAbortClick() {
    if (audioTx) abortAudioTx("operator");
    else if (fskSending) command({type: "abortCw"}).catch(() => {});
  }

  // ---- render ---------------------------------------------------------------

  function radioPercent() {
    return state.radio.rfPowerSeen ? WsprCore.civPercent(state.radio.rfPower) : null;
  }

  // Same rounding rule as data.js's/mercury.js's own formatWatts() (both
  // private to their own files, so duplicated here rather than shared --
  // code-review: this page's own watts display used to compute a 3rd,
  // differently-behaved formula that never dropped to milliwatts). Below a
  // watt is exactly where a QRP RTTY setting can legitimately sit.
  function formatWatts(watts) {
    if (watts < 0.9995) return `${Math.round(watts * 1000)} mW`;
    return watts < 9.95 ? `${watts.toFixed(1)} W` : `${Math.round(watts)} W`;
  }

  function render() {
    const slot = LanGate.slot ? LanGate.slot() : 0;
    dom.trxSlotLabel.textContent = slot ? `TRX${slot}` : "TRX";
    dom.trxFrequencyValue.textContent = state.radio.frequency
      ? RttyPresets.formatFrequency(state.radio.frequency) : "--.---.---";
    dom.trxMode.textContent = state.radio.mode || "---";
    dom.radioModel.textContent = liveRadioModel() || "--";
    dom.aud1State.textContent = "AUD1 " + (session && session.hello ? "ready" : "—");
    dom.linkState.textContent = state.radio.connected ? "● ONLINE" : "● OFFLINE";
    dom.linkState.classList.toggle("error", !state.radio.connected);
    dom.trxReconnect.hidden = state.radio.connected;

    const percent = radioPercent();
    dom.trxPower.hidden = percent === null;
    if (percent !== null) {
      const fullWatts = WsprCore.fullPowerWatts(liveRadioModel());
      dom.trxPowerWatts.textContent = fullWatts
        ? `${formatWatts(fullWatts * percent / 100)} (${percent}%)`
        : `${percent}%`;
      const lit = Math.round(percent / 10);
      dom.trxPower.querySelectorAll(".pwr-bar i").forEach((el, i) => el.classList.toggle("on", i < lit));
    }

    renderStatusPills();
    rfPowerAuto.renderField();
  }

  function renderStatusPills() {
    dom.rttyReverse.textContent = settings.reverse ? "REVERSE" : "NORMAL";
    dom.rttyReverse.classList.toggle("active", settings.reverse);
    // Item 16: the configured threshold itself (SETTINGS' own number),
    // highlighted while squelch is engaged (threshold above 0 -- the normal
    // state, default is 4). Replaces the old live open/closed reading.
    dom.rttySquelch.textContent = "SQL " + settings.squelchThreshold;
    dom.rttySquelch.classList.toggle("active", settings.squelchThreshold !== 0);
    dom.rttySnr.textContent = "SNR " +
      (Number.isFinite(state.lastSnrDb) ? `${state.lastSnrDb.toFixed(1)} dB` : "—");
    dom.rxSummary.textContent = state.rxChars ? `${state.rxChars} chars decoded` : "";

    // Item 7: no SEND button, no RF-safety checkbox left to gate on -- Enter
    // sends directly (wire()'s own keydown handler), ABORT is the only
    // button this row still has.
    dom.rttyTxAbort.hidden = !txBusy();
  }

  // ---- CAL PLAN (kap.9) -----------------------------------------------------
  //
  // Same TxGainCalUi/TxGainPlanUi tools JS8/WSPR mount, unchanged -- the
  // calibration carrier is WsprTx's own tone, a generic ALC-knee probe reused
  // regardless of which page mounts it (see rtty.html's own script-list
  // comment for why this is not a new RTTY-specific carrier).

  const gainStore = new TxGainCal.TxGainStore();
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
    // No manual TX-gain knob on this page (kap.1 has no gain-slider decision
    // for RTTY) -- the search always starts from the store's own seed.
    manualGain: () => 0,
    dbm: () => null,
    blockingReason: () => {
      if (!session || !session.hello) return "the AUD1 session is not ready";
      if (audioTx) return "a TX composer send is in progress";
      if (fskSending) return "an FSK-backend send is in progress";
      return "";
    },
    ensureDataMode: async () => {}, // kap.6.1: audio-stream TX does not touch the radio's mode
    setMode: mode => command({type: "setMode", mode}),
    onRunChange: () => render(),
    modLevel: () => (gainPlan ? gainPlan.modLevel() : 0),
    refreshModLevel: () => (gainPlan ? gainPlan.refreshModLevel() : null),
  });

  gainPlan = TxGainPlanUi.create({
    mount: dom.planField,
    button: dom.planButton,
    store: gainStore,
    cal: gainCal,
    model: calModel,
    modelNumber: () => IcomModels.modelNumber(calModel()),
    radio: () => state.radio,
    send: payload => commandJson(payload),
    bands: () => RttyPresets.PRESETS.map(preset => ({band: preset.band, hz: preset.frequencyHz})),
    wsprPresets: typeof WsprCore !== "undefined" ? WsprCore.PRESETS : [],
    js8Presets: typeof Js8TrxPresets !== "undefined" ? Js8TrxPresets.PRESETS : [],
    percentOf: radio => (radio.rfPowerSeen === true ? WsprCore.civPercent(radio.rfPower) : 0),
    defaultPowers: () => (state.radio.rfPowerSeen === true ? [radioPercent()] : []),
    setFrequency: async hz => {
      await command({type: "setFrequency", frequency: String(hz)});
      await waitForState(radio => radio.frequency === hz, 9000);
    },
    // Same write-then-poll-and-confirm shape as mercury.js's own setPercent
    // (self-contained, no separate confirmPercent helper needed here).
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
    // tx-gain-plan-ui.js calls this.page.onPlanChange(true)/(false) unconditionally
    // around every run (code-review: this was missing here, unlike data.js/wspr.js/
    // mercury.js, which all supply one -- RUN/RUN ALL threw
    // "onPlanChange is not a function" on this page before this was added).
    onPlanChange: () => render(),
  });

  // ---- RF power percent (item 13, grilled 2026-08-27, second session) -----
  //
  // The engine itself (auto-apply on load/reconnect, knob detection, write+
  // confirm, the empty-field guard) is shared with JS8Call-ICOM now
  // (data/rf-power-auto.js, code-review 2026-08-28 -- was a hand-copy here
  // before, see that module's own header for why WSPR/Mercury are not
  // callers of it). RTTY-ICOM supplies only what is genuinely page-specific:
  // where the target percent is stored (rtty-settings.js), and this page's
  // own txBusy()/gainCal/gainPlan for "don't write right now".
  const rfPowerAuto = RfPowerAuto.create({
    dom: {input: dom.rttyRfPercent, set: dom.rttyRfPercentSet,
          watts: dom.rttyRfPercentWatts, state: dom.rttyRfPercentState,
          field: dom.rttyRfPowerField},
    targetPercent: () => {
      const stored = settings.rfPercent;
      return Number.isFinite(Number(stored)) && Number(stored) >= 1 ? Number(stored) : null;
    },
    radio: () => state.radio,
    fullWatts: () => WsprCore.fullPowerWatts(liveRadioModel()),
    formatWatts,
    // CAL PLAN/CAL drive the radio's power through their own test levels
    // (kap.9), entirely independent of this engine's own writes -- without
    // this guard, the very next mismatch that produces (radio on some test
    // level) reads as "the operator turned the knob" and permanently stands
    // the automation down for the rest of the page's life.
    blocked: () => gainCal.running || (gainPlan && gainPlan.running),
    transmitting: () => state.radio.tx || txBusy(),
    command,
    waitForState,
    onWrite: percent => { settings.rfPercent = percent; saveSettings(); },
    render,
  });

  // ---- boot -------------------------------------------------------------

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
    // No planButton click handler here (item 8, grilled 2026-08-27, second
    // session): TxGainPlanUi.create() already wires its own click listener on
    // the same button internally (tx-gain-plan-ui.js's own toggleWindow()) --
    // a 2nd one here used to fire on every click too, immediately re-hiding
    // what the 1st one had just opened. data.js/wspr.js/mercury.js never had
    // this extra handler; CAL PLAN worked there the whole time.
    dom.trxReconnect.addEventListener("click", async () => {
      dom.trxReconnect.disabled = true;
      try { await fetch("/lan/reconnect", {method: "POST", signal: fetchDeadline(FETCH_FLASH_TIMEOUT_MS)}); }
      catch (_error) { /* pollState will keep showing the true link state */ }
      dom.trxReconnect.disabled = false;
    });
    dom.sessionTakeover.addEventListener("click", () => claimSession(true));
    window.addEventListener("resize", () => waterfall.resize());

    dom.rttyReverse.addEventListener("click", () => {
      settings.reverse = !settings.reverse;
      saveSettings();
      decoder.setReverse(settings.reverse);
      renderStatusPills();
    });
    // Item 11: TX method moved into SETTINGS as a <select> (was a header
    // pilulka toggled by click).
    dom.rttyTxMethod.addEventListener("change", () => {
      settings.txMethod = dom.rttyTxMethod.value === "fsk" ? "fsk" : "audio";
      saveSettings();
      renderStatusPills();
    });
    // Item 7: Enter sends, like js8call -- no SEND button, no RF-safety
    // checkbox left to gate on. preventDefault so Enter never inserts a
    // literal newline (the field is single-line; RTTY traffic is one line).
    dom.rttyTxText.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      onSendClick();
    });
    dom.rttyTxAbort.addEventListener("click", onAbortClick);

    // Item 15: stopPropagation keeps a pill click from also toggling the
    // <details> its <summary> lives in.
    document.querySelectorAll(".rtty-zoom-pill").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        applyZoom(Number(button.dataset.zoom));
      });
    });

    dom.rttySquelchInput.addEventListener("input", () => {
      settings.squelchThreshold = Number(dom.rttySquelchInput.value);
      saveSettings();
      decoder.setSquelchThreshold(settings.squelchThreshold);
      dom.rttySquelchLive.textContent = String(settings.squelchThreshold);
      renderStatusPills();   // item 16: the SQL pill mirrors this live
    });
    dom.rttyToneInput.addEventListener("change", () => {
      const hz = Math.round(Number(dom.rttyToneInput.value));
      if (!Number.isFinite(hz)) return;
      setToneFromSpaceHz(hz);
    });

    // Item 13: same input/SET pairing as data.js's own #rfPercent/#rfPercentSet,
    // now the same shared rfPowerAuto engine both pages call into.
    dom.rttyRfPercent.addEventListener("input", () => rfPowerAuto.noteDraft());
    dom.rttyRfPercentSet.addEventListener("click", () => rfPowerAuto.setFromField());
  }

  LanGate.gate().then(ready => {
    if (!ready) return;

    dom.rttySquelchInput.min = String(RttySettings.SQUELCH_MIN);
    dom.rttySquelchInput.max = String(RttySettings.SQUELCH_MAX);
    dom.rttySquelchInput.value = String(settings.squelchThreshold);
    dom.rttySquelchLive.textContent = String(settings.squelchThreshold);
    // rtty.html's <input min/max> is a static fallback for the instant before
    // this runs; RttySettings is authoritative from here on (code-review).
    dom.rttyToneInput.min = String(RttySettings.TONE_MIN_HZ);
    dom.rttyToneInput.max = String(RttySettings.TONE_MAX_HZ);
    // Item 3: the field shows the SPACE/red tone, not the internal centre
    // settings.toneHz actually stores -- same conversion setToneFromSpaceHz()
    // uses on the way back in.
    dom.rttyToneInput.value = String(settings.toneHz - RttyCodec.SHIFT_HZ / 2);

    dom.rttyTxMethod.value = settings.txMethod;

    wire();
    waterfall.resize();
    render();
    requestAnimationFrame(drawLiveSpectrum);

    pollState();
    setInterval(pollState, STATE_POLL_MS);

    claimSession();
  });
})();
