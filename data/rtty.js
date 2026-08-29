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
    "rttyReverse", "rttySquelch", "rttySnr",
    "waterfall", "waterfallCanvas", "spectrumSummary",
    "rttyScope", "rttyLiveSpectrum", "rttyScopeOverlay", "liveSpectrumCanvas",
    "rttyRxLog", "rxSummary",
    "rttyTxText", "rttyTxAbort", "rttyTxState",
    "rttySquelchInput", "rttySquelchLive", "rttyToneInput", "settingsSummary",
    // AFC (grilled 2026-08-28, 3rd session): see rtty.js's own afcTick()/
    // syncDecoderTone() for what these drive.
    "rttyAfcEnabled", "rttyAfcRateInput", "rttyAfcMaxDeviationInput",
    // Item 13 (grilled 2026-08-27, second session): RF power target, moved
    // into SETTINGS -- see that section's own comment for why it lives here.
    "rttyRfPowerField", "rttyRfPercent", "rttyRfPercentWatts",
    "rttyRfPercentSet", "rttyRfPercentState",
    // Item 3 (2nd session): this station's own AFSK TX polarity, independent
    // of the RX-only #rttyReverse pill.
    "rttyTxPolarity",
    // Item 5 (2nd session): FSK output mode/NET_ID, moved here from SETUP --
    // see loadFskConfig()/saveFskOutput() below.
    "rttyFskOutputMode", "rttyFskNetIdRow", "rttyFskNetId", "rttyTrxnetPeersFsk",
    "rttySettingsSection",
  ]) dom[id] = $(id);

  const state = {
    radio: {connected: false, transceiverType: "", radioName: "", radioNameSeen: false,
      mode: "", frequency: 0, tx: false, rfPower: 0, rfPowerSeen: false},
    lastSnrDb: null, rxChars: 0,
  };

  const settings = RttySettings.load(window.localStorage);
  function saveSettings() { RttySettings.save(window.localStorage, settings); }

  // ---- dial <-> mark compensation (AFSK sideband vs true-FSK dial) --------
  //
  // An IARU "dial frequency" (rtty-presets.js) means the on-air MARK tone
  // sits exactly there. That's true for real FSK (RTTY/RTTY-R: FSK_OUT GPIO
  // keys the radio's own internal FSK modulator directly, no audio stage --
  // Icom's own convention is dial == mark in that mode) but NOT for AFSK
  // over SSB (LSB-D/USB-D): there the mark tone rides the sideband as audio,
  // so it sits markToneHz() BELOW the dial on LSB (the audio tone subtracts
  // from the suppressed carrier) or ABOVE it on USB (audio adds). Without
  // this, sending the same preset to a radio sitting in LSB-D/USB-D put the
  // real mark markToneHz() away from where RTTY/RTTY-R -- and every other
  // operator reading the same dial number -- expects it.
  //
  // Grilled 2026-08-28 (2nd session, item 3): the transmitted mark used to be
  // unconditionally the higher tone (settings.toneHz + SHIFT_HZ/2), TX-side
  // "reverse" not being a thing rtty-codec.js's Encoder read at all. Real use
  // confirmed that default is fine as a default -- but a station that wants
  // its own AFSK to match a companion real-FSK radio's fixed hardware
  // convention (wifilt.ino's FSK_MARK_LEVEL/FSK_SPACE_LEVEL, not software-
  // configurable) needs the OTHER tone as mark instead. settings.txPolarity
  // is that choice -- deliberately separate from the RX-only NORMAL/REVERSE
  // pill (that file's own comment) -- so markToneHz() now reads it, and every
  // caller (the Encoder construction below, drawScopeOverlay()'s green/red
  // lines, this dial math) follows without needing its own copy of the flag.
  function markToneHz() {
    return settings.txPolarity === "reverse"
      ? settings.toneHz - RttyCodec.SHIFT_HZ / 2
      : settings.toneHz + RttyCodec.SHIFT_HZ / 2;
  }

  function dialToMarkHz(dialHz, mode) {
    if (mode.startsWith("LSB")) return dialHz - markToneHz();
    if (mode.startsWith("USB")) return dialHz + markToneHz();
    return dialHz; // RTTY/RTTY-R (dial == mark already) and anything else
  }
  function markToDialHz(markTargetHz, mode) {
    if (mode.startsWith("LSB")) return markTargetHz + markToneHz();
    if (mode.startsWith("USB")) return markTargetHz - markToneHz();
    return markTargetHz;
  }
  // The pair drawScopeOverlay()'s solid lines sit on and afcTick() searches
  // around -- spaceHz is just markHz's mirror image around settings.toneHz,
  // whichever physical tone markToneHz() currently calls mark.
  function expectedMarkSpaceHz() {
    const markHz = markToneHz();
    return [markHz, 2 * settings.toneHz - markHz];
  }

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
    const claim = await sessionPost("/js8/session/claim", {force, role: "rtty"});
    if (!claim.granted) { loseSession(claim); return; }
    markHeld();
  }

  setInterval(async () => {
    if (!sessionHeld) return;
    const ping = await sessionPost("/js8/session/ping", {role: "rtty"});
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
    // Compare against the on-air MARK, not the raw CI-V dial (dialToMarkHz is
    // a no-op outside LSB-D/USB-D) -- otherwise a preset picked while in
    // LSB-D/USB-D never re-highlights as "current", since the radio's
    // reported dial is markToneHz() away from preset.frequencyHz by design.
    const selected = Math.round(dialToMarkHz(state.radio.frequency, state.radio.mode || ""));
    dom.frequencyMenu.innerHTML =
      `<header><strong>RTTY dial frequencies</strong><small>Standard IARU R1 RTTY calling frequencies</small>` +
      `<span class="tt-actions"><button class="tt-clear" type="button" data-menu-close title="Close">CLOSE</button></span></header>` +
      `<div class="frequency-presets">${RttyPresets.PRESETS.map(preset =>
        `<button class="frequency-preset${preset.frequencyHz === selected ? " current" : ""}"` +
        ` type="button" data-frequency="${preset.frequencyHz}">` +
        `<strong>${preset.band}</strong><span>${(preset.frequencyHz / 1e6).toFixed(4)} MHz</span>` +
        // The calling segment's own edges (offDialFrequency()'s [lowHz,highHz],
        // rtty-presets.js), not just the one suggested dial frequency -- RTTY
        // is worked anywhere inside this range, unlike JS8/WSPR/Mercury's
        // fixed channelised dials, so the menu needs to say what that range
        // actually is (grilled, on-radio feedback: the single dial number
        // alone left the segment's edges invisible).
        `<span class="frequency-preset-range">${(preset.lowHz / 1e6).toFixed(3)}–${(preset.highHz / 1e6).toFixed(3)} MHz</span>` +
        `</button>`).join("")}</div>` +
      `<footer>Sets the mark tone here -- compensated for the AFSK sideband/tone offset in LSB-D/USB-D (dial sent to the radio differs by markToneHz()); real FSK (RTTY/RTTY-R) needs none. TX path is unaffected.</footer>`;
  }

  function closeFrequencyMenu() {
    dom.frequencyMenu.hidden = true;
    dom.trxFrequency.setAttribute("aria-expanded", "false");
  }

  async function requestFrequency(hz) {
    closeFrequencyMenu();
    const civHz = Math.round(markToDialHz(hz, state.radio.mode || ""));
    try { await command({type: "setFrequency", frequency: String(civHz)}); }
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

  // Item 3, grilled 2026-08-28: liveHopSize/liveAgcEase arm the 2nd,
  // independent FFT/AGC tap this page's own live-spectrum panel reads
  // (waterfall.state().liveValues/liveAgcLow/liveAgcHigh below). Pushed
  // further in a 2nd grill the same day (still felt slow after the first
  // pass): ~64 ms cadence (512 samples @ 8 kHz, still divides the
  // waterfall's own 2048-sample hop evenly -- ingest()'s shared-extraction
  // optimization still applies, just on every 4th live tick instead of every
  // 2nd) and a steeper AGC ease, so the live-spectrum trace now catches up to
  // a new signal in well under 0.3 s instead of the ~1-1.5 s the first pass
  // landed on (and ~5.6 s before either pass). Traded away on purpose: more
  // visible jitter on a short noise spike, accepted because RTTY tone-
  // tracking cares about reacting to a real tone fast, not about smoothing
  // transients. The scrolling waterfall's own row rate/colour ramp
  // (this.hop/agcLow/agcHigh/lastValues) is untouched by either setting
  // ("vodopad nechat", grilled).
  const waterfall = new Spectrum.Waterfall({
    canvas: dom.waterfallCanvas, container: dom.waterfall,
    sampleRate: RX_AUDIO_RATE, lowHz: BASE_LOW_HZ, highHz: BASE_HIGH_HZ,
    liveHopSize: 512, liveAgcEase: .6,
  });

  // "Nice" round tick values (d3.ticks()-style): pick a step from {1,2,5}x10^n
  // closest to span/count, so the waterfall's own rough frequency ruler
  // (item 9, grilled 2026-08-28) reads as round numbers (…900, 1300, 1700…)
  // rather than whatever the visible window's exact edges happen to divide
  // into. "Roughly clear where we are" -- not a precise scale.
  function niceTicks(lowHz, highHz, count) {
    const span = highHz - lowHz;
    if (!(span > 0)) return [];
    const rawStep = span / count;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / magnitude;
    const niceNorm = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    const step = niceNorm * magnitude;
    const ticks = [];
    for (let v = Math.ceil(lowHz / step) * step; v <= highHz; v += step) ticks.push(v);
    return ticks;
  }

  // Item 8/9, grilled 2026-08-28: the ONE overlay covering both the
  // live-spectrum panel and the waterfall below it (#rttyScope wraps both;
  // this canvas sits on top of the whole thing, see rtty.css's own comment).
  // Replaces the old per-canvas drawToneOverlay(), which used to run twice
  // (once for waterfallOverlay, once again at the end of drawLiveSpectrum())
  // and broke into two visibly separate segments at the border between the
  // two blocks -- drawn once here instead, so the line is continuous by
  // construction rather than by coincidence of matching coordinates.
  function drawScopeOverlay() {
    const canvas = dom.rttyScopeOverlay, ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const width = canvas.width, bottomY = canvas.height;
    // The seam between the two wrapped blocks, in this shared canvas's own
    // pixel space -- "bottom edge of the spectrogram" (item 9) means here,
    // not the overlay's own bottom (that is the waterfall's bottom edge).
    const splitY = dom.rttyLiveSpectrum.clientHeight;

    // Grilled 2026-08-28 (2nd session, item 3): markHz/spaceHz now follow
    // settings.txPolarity (markToneHz()'s own comment) -- green is always
    // whichever physical tone THIS station's encoder actually sends for a
    // mark bit, red whichever it sends for space, so the overlay never
    // disagrees with what goes out over the air. The old 2nd, dashed
    // "logical space" line existed only because TX used to ignore Reverse
    // while RX didn't; now that TX has its own explicit polarity instead of
    // silently disagreeing with these lines, that mismatch -- and the line
    // that existed only to flag it -- is gone.
    const [markHz, spaceHz] = expectedMarkSpaceHz();

    // AFC (grilled 2026-08-28, 3rd session): drawn FIRST so the solid
    // mark/space lines below always sit on top of it, never hidden by it
    // even at zero offset (the two pairs coincide when the detector hasn't
    // drifted). Half the line weight, grey, no per-line Hz label -- just the
    // signed offset centred between the two.
    if (settings.afcEnabled) {
      const afcMarkX = waterfall.hzToX(markHz + afcOffsetHz, width);
      const afcSpaceX = waterfall.hzToX(spaceHz + afcOffsetHz, width);
      ctx.strokeStyle = "rgba(180,180,180,.8)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      for (const x of [afcMarkX, afcSpaceX]) {
        ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, 0);
        ctx.lineTo(Math.round(x) + .5, bottomY); ctx.stroke();
      }
      ctx.setLineDash([]);
      const sign = afcOffsetHz > 0 ? "+" : afcOffsetHz < 0 ? "−" : "";
      ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
      ctx.fillStyle = "rgba(200,200,200,.9)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${sign}${Math.round(Math.abs(afcOffsetHz))} Hz`, (afcMarkX + afcSpaceX) / 2, canvas.height / 2);
      ctx.textBaseline = "alphabetic";
    }

    ctx.setLineDash([]);
    for (const [hz, strokeColor] of [[markHz, "#5ad18a"], [spaceHz, "#ff6b6b"]]) {
      const x = waterfall.hzToX(hz, width);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2;   // item 5: thinned by 1/3 (was 3)
      ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, 0);
      ctx.lineTo(Math.round(x) + .5, bottomY); ctx.stroke();
    }

    // Item 9: the waterfall's own rough frequency ruler, bottom edge.
    ctx.font = "9px ui-monospace, Menlo, Consolas, monospace";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "#c8c8c8";
    ctx.textAlign = "center";
    for (const hz of niceTicks(waterfall.lowHz, waterfall.highHz, 5))
      ctx.fillText(String(Math.round(hz)), waterfall.hzToX(hz, width), bottomY - 2);

    // Item 9: exact SPACE/red-line frequency, just left of the line itself,
    // at the bottom of the spectrogram (the seam, not the overlay's bottom).
    ctx.fillStyle = "#ff6b6b";
    ctx.textAlign = "right";
    ctx.fillText(String(Math.round(spaceHz)), waterfall.hzToX(spaceHz, width) - 4, splitY - 2);

    // Item 3 (2nd session): the dial a companion real-FSK radio would need
    // to put ITS mark at the same actual RF frequency this AFSK mark tone
    // lands on (dial == mark for real FSK -- dialToMarkHz()'s own comment).
    // This is the number an operator manually aligning an AFSK radio against
    // a 2nd, true-FSK one is after -- mirrors the space label's placement,
    // to the right of the green line instead of left of the red one.
    const fskDialHz = dialToMarkHz(state.radio.frequency, state.radio.mode || "");
    ctx.fillStyle = "#5ad18a";
    ctx.textAlign = "left";
    ctx.fillText(`FSK ${RttyPresets.formatFrequency(fskDialHz)}`,
      waterfall.hzToX(markHz, width) + 4, splitY - 2);
  }

  // Sized to #rttyScope's own rendered box -- top of the spectrogram through
  // the bottom of the waterfall, INCLUDING the border/gap between them --
  // so the mark/space lines paint straight across that seam (item 8) rather
  // than stopping at either individual canvas's own edge.
  function resizeScopeOverlay() {
    const width = Math.max(320, Math.round(dom.rttyScope.clientWidth));
    const height = Math.round(dom.rttyScope.clientHeight);
    if (dom.rttyScopeOverlay.width !== width) dom.rttyScopeOverlay.width = width;
    if (dom.rttyScopeOverlay.height !== height) dom.rttyScopeOverlay.height = height;
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
    drawScopeOverlay();   // immediate feedback -- the rAF loop would repaint this within a frame anyway
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
    // AFC's slew needs to keep moving every frame, not just when a fresh FFT
    // frame lands (e.g. still easing back to 0 after squelch closes) -- and
    // the grey dashed lines need to visibly track that, so the overlay is
    // repainted here too while AFC is on (harmless extra draw otherwise:
    // drawScopeOverlay() itself already runs every frame's worth of cost
    // this page ever pays for the live-spectrum canvas below).
    afcTick();
    if (settings.afcEnabled) drawScopeOverlay();
    const canvas = dom.liveSpectrumCanvas, ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Item 3, grilled 2026-08-28: the live tap's OWN liveValues/liveAgcLow/
    // liveAgcHigh (spectrum.js's liveDraw(), ~128 ms cadence, faster AGC
    // ease) -- NOT lastValues/agcLow/agcHigh, which still feed the SCROLLING
    // waterfall's row colours at their own, deliberately slower, unchanged
    // cadence. Empty/undefined before the first live frame lands draws
    // nothing, never an error.
    const {liveAgcLow: agcLow, liveAgcHigh: agcHigh, liveValues: values} = waterfall.state();
    if (values && values.length) {
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
      // Sliding-window sum (code-review 2026-08-28), not a fresh sum/count
      // scan per point: the window for i+1 differs from i's only by one
      // entering and one leaving sample, so it is maintained incrementally
      // in O(1) per point instead of re-summing all ~2*RADIUS+1 of them --
      // same numbers, same envelope, just without the redundant O(n*radius)
      // work every animation frame.
      const n = smoothedSpectrum.length;
      const points = new Array(n);
      let sum = 0, count = 0;
      for (let j = 0; j <= Math.min(SPATIAL_SMOOTH_RADIUS, n - 1); j++) { sum += smoothedSpectrum[j]; count++; }
      for (let i = 0; i < n; i++) {
        const norm = Math.max(0, Math.min(1, (sum / count - lo) / (hi - lo)));
        // Item 7: 90% headroom -- the loudest displayed point never quite
        // touches the top edge, so a signal at or above agcHigh reads as a
        // tall peak, not a flat line clipped against the canvas border.
        points[i] = canvas.height - norm * canvas.height * .9;
        const enter = i + SPATIAL_SMOOTH_RADIUS + 1, leave = i - SPATIAL_SMOOTH_RADIUS;
        if (enter < n) { sum += smoothedSpectrum[enter]; count++; }
        if (leave >= 0) { sum -= smoothedSpectrum[leave]; count--; }
      }

      // Item 4: light grey (was rgba(120,220,200,.9), a teal too close to the
      // MARK line's own green #5ad18a to tell apart at a glance).
      ctx.strokeStyle = "rgba(200,200,200,.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const stepX = canvas.width / (points.length - 1 || 1);
      points.forEach((y, i) => (i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * stepX, y)));
      ctx.stroke();
    }

    // Item 8: the shared overlay (mark/space lines + item 9's ruler/readout)
    // repaints every frame regardless of whether live-spectrum data has
    // arrived yet, so it appears immediately on load exactly as it used to.
    drawScopeOverlay();
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
  // echoed into the RX log like a monitor -- not a .rtty-tok (no click/hover:
  // the operator's own callsign in "CQ CQ DE OK1HRA" must never be mistaken
  // for a station to log). Called from both TX methods, at the moment each
  // commits to sending, whether the send came from this page's own composer
  // or a QRPlog hand-off (kap.8.3) -- there is exactly one call site per
  // method, so every path echoes the same way.
  //
  // Item 1/2 (grilled 2026-08-28, 3rd session): displayed uppercase (what
  // actually goes out -- both TX methods already uppercase at the encoding
  // stage, textToBaudot()/wifilt.ino's chTable(), this just makes the echo
  // agree), and coloured in per character rather than red all at once: each
  // character starts grey and steps straight to red at its own estimated
  // transmit time (RttyCodec.charStartTimes() -- the real Baudot frame
  // sequence, so FIGS/LTRS shifts and characters with no Baudot mapping don't
  // throw a flat per-character count off). Doesn't try to track real
  // playback -- external FSK over TrxNet has no observable completion signal
  // anyway (grilled), so elapsed wall time against this estimate is the
  // whole design, for both TX methods alike.
  //
  // Tracks the most recent echo so a send that fails AFTER being echoed
  // (session.prepare()/setMode/sendCw can all still throw here -- kap.6's own
  // failure modes) can retract it, rather than leaving a false "sent" line
  // for a message that never actually went out (code-review: the RX log is
  // the one place QRPlog cross-references what was sent, and it had no way
  // to tell a genuine send from a failed attempt). Only one at a time needs
  // tracking -- txBusy() already keeps the two TX methods mutually exclusive.
  let lastTxEcho = null;   // {container, timers}

  function echoTxText(text) {
    rxOpenWordSpan = null;   // don't let a live RX token keep growing into this
    // Grilled 2026-08-28 (item 4): a TX send that lands mid-word (RX decoding
    // "HELLO" with no trailing space/newline yet) used to run the echoed text
    // straight onto the end of that unfinished RX line -- the code above
    // abandons the open word span without ever closing its line. One leading
    // break, skipped when the log is already empty or already ends on one, so
    // back-to-back sends never grow a widening gap.
    if (dom.rttyRxLog.textContent && !dom.rttyRxLog.textContent.endsWith("\n"))
      dom.rttyRxLog.appendChild(document.createTextNode("\n"));

    const upper = String(text).toUpperCase();
    const container = document.createElement("span");
    container.className = "rtty-tx-echo";
    const charSpans = Array.from(upper, ch => {
      const span = document.createElement("span");
      span.className = "rtty-tx-char";
      span.textContent = ch;
      container.appendChild(span);
      return span;
    });
    dom.rttyRxLog.appendChild(container);
    dom.rttyRxLog.appendChild(document.createTextNode("\n"));
    trimRxLog();
    dom.rttyRxLog.scrollTop = dom.rttyRxLog.scrollHeight;

    const timers = RttyCodec.charStartTimes(upper).map(({index, startMs}) =>
      setTimeout(() => {
        const span = charSpans[index];
        if (span && span.isConnected) span.classList.add("lit");
      }, startMs));
    lastTxEcho = {container, timers};
  }

  function markTxEchoFailed(echo) {
    if (!echo || !echo.container.isConnected) return;   // scrolled out of the trimmed log already
    echo.timers.forEach(clearTimeout);   // item 3c: whatever hasn't lit yet stays grey, no catch-up
    echo.container.classList.add("rtty-tx-echo-failed");
    echo.container.appendChild(document.createTextNode(" (failed)"));
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

  // ---- AFC (grilled 2026-08-28, 3rd/4th sessions) --------------------------
  //
  // Tracks the OTHER station's drift by nudging only the decoder's own
  // runtime tone offset (decoder.setToneOffset(), via syncDecoderTone()
  // below) -- settings.toneHz itself, and therefore this station's own TX
  // tone and the solid mark/space overlay lines, never move.
  //
  // The "carrier detector" reuses the waterfall's own live FFT tap
  // (spectrum.js's liveDraw(), already running at liveHopSize=512 -- ~64 ms
  // @ 8 kHz -- for the live-spectrum panel above the waterfall) instead of
  // adding a second FFT. That instantaneous estimate (afcFindOffset() below)
  // becomes this tick's target; the actual detector offset chases it -- or
  // chases 0 whenever decoder.squelchOpen is false -- at a fixed max Hz/s
  // slew rate (afcRateHzPerChar converted from Hz/char). One rule for both
  // "track the signal" and "spring back to centre", per the grilled spec.
  let afcOffsetHz = 0, afcTargetHz = 0, afcLastLiveValues = null, afcLastTickMs = null;

  // 4th session: how far a found peak must stand out above this scan's own
  // median (a stand-in noise floor -- the real peak is a small minority of
  // the samples, so the median tracks the floor around it) before it's
  // trusted at all. Added because decoder.squelchOpen alone re-evaluates
  // from raw magnitude every ~1 ms (rtty-codec.js's own hop) and readily
  // flickers true on pure noise at a low/default threshold -- every flicker
  // used to feed straight into a fresh, meaningless target, visible as the
  // detector line jittering with no real signal present.
  const AFC_PROMINENCE_DB = 8;

  function afcRateHzPerSec() {
    return settings.afcRateHzPerChar * 1000 / RttyCodec.CHAR_DURATION_MS;
  }

  function syncDecoderTone() {
    decoder.setToneOffset(settings.toneHz + afcOffsetHz);
  }

  // 3-point parabolic fit around the discrete bin maximum, in the dB domain
  // liveValues already is -- resolves sub-bin frequency well inside this
  // waterfall's own ~1.95 Hz/bin (fftSize=4096 @ 8 kHz).
  function refinePeakBinOffset(values, k) {
    if (k <= 0 || k >= values.length - 1) return 0;
    const a = values[k - 1], b = values[k], c = values[k + 1];
    const denom = a - 2 * b + c;
    let delta = denom !== 0 ? .5 * (a - c) / denom : 0;
    if (!Number.isFinite(delta) || Math.abs(delta) > .5) delta = 0;
    return delta;
  }

  // dB value at the bin nearest `hz` in a liveValues array spanning
  // [waterfall.lowHz, waterfall.highHz] -- -Infinity outside that span (e.g.
  // right after a zoom change narrows what's actually in `values`). Same
  // lowHz + i*(span/(length-1)) approximation hzToX()/draw() already use
  // elsewhere in this file for this exact array.
  function valueAtHz(values, hz) {
    const span = waterfall.highHz - waterfall.lowHz;
    if (!(span > 0) || !values || values.length < 2) return -Infinity;
    const idx = Math.round((hz - waterfall.lowHz) * (values.length - 1) / span);
    return idx >= 0 && idx < values.length ? values[idx] : -Infinity;
  }

  // Grilled 2026-08-28 (4th session, items 2/3): a peak search independently
  // per candidate tone (the original design) can pick the wrong one --
  // fading/noise can make the SILENT tone's own window read louder than the
  // real, drifted one, and grows more likely the wider afcMaxDeviationHz
  // lets the two windows get. Sliding a MATCHED PAIR across candidate shifts
  // instead -- always exactly SHIFT_HZ apart, as mark/space genuinely are --
  // removes the "which one is it" classification step entirely: whichever of
  // mark+c/space+c is actually keyed, max(mark+c, space+c) peaks at the true
  // offset c regardless of which one that turns out to be.
  //
  // This does NOT lift the ~SHIFT_HZ/2 ambiguity ceiling, though (confirmed
  // with the user, same session, before raising afcMaxDeviationHz's cap was
  // ruled out): a real peak at true offset X always has an equally tall
  // "ghost" at X±SHIFT_HZ, because the OTHER candidate line lands on that
  // exact same real energy there (space+(X+SHIFT_HZ) === mark+X). The ghost
  // only falls outside the scanned range while afcMaxDeviationHz stays under
  // ~SHIFT_HZ/2 -- no algorithm over frequency content alone can tell the
  // two apart once both are in range, and a real drift that large also
  // breaks the decoder's own start/stop framing lock, so nothing would
  // decode either way regardless of what AFC does.
  //
  // Returns null when nothing in range clears AFC_PROMINENCE_DB above the
  // scan's own median -- callers should treat that the same as "no fresh
  // data", not force a reset (decoder.squelchOpen going false is still what
  // springs the target back to 0).
  function afcFindOffset(values, dev) {
    const span = waterfall.highHz - waterfall.lowHz;
    if (!(span > 0) || !values || values.length < 3) return null;
    const hzPerBin = span / (values.length - 1);
    const steps = Math.max(4, Math.round(2 * dev / hzPerBin));
    const [markHz, spaceHz] = expectedMarkSpaceHz();
    const levels = new Float32Array(steps + 1);
    for (let i = 0; i <= steps; i++) {
      const c = -dev + i * (2 * dev / steps);
      levels[i] = Math.max(valueAtHz(values, markHz + c), valueAtHz(values, spaceHz + c));
    }
    let best = 0;
    for (let i = 1; i < levels.length; i++) if (levels[i] > levels[best]) best = i;
    const noiseFloor = levels.slice().sort()[levels.length >> 1];   // median
    // Bug found live on the radio (4th session): when the WHOLE scanned range
    // falls outside the currently visible liveValues span (e.g. right after a
    // zoom change), every entry is -Infinity, levels[best]-noiseFloor is
    // -Infinity-(-Infinity) = NaN, and `NaN < AFC_PROMINENCE_DB` is false --
    // so the rejection silently failed OPEN instead of returning null,
    // feeding syncDecoderTone() a bogus value pegged at -dev and detuning
    // the decoder even on a properly zero-beat signal. Explicit finite check
    // closes that instead of relying on the comparison alone.
    if (!Number.isFinite(levels[best]) || levels[best] - noiseFloor < AFC_PROMINENCE_DB) return null;
    const stepHz = (2 * dev) / steps;
    return -dev + (best + refinePeakBinOffset(levels, best)) * stepHz;
  }

  // Called every animation frame from drawLiveSpectrum() -- the continuous
  // slew integration needs to keep moving (toward the target, or back to 0)
  // even between fresh FFT frames, not just when new data lands.
  function afcTick() {
    const now = Date.now();
    const dtSec = afcLastTickMs === null ? 0 : Math.max(0, Math.min(1, (now - afcLastTickMs) / 1000));
    afcLastTickMs = now;
    if (!settings.afcEnabled) return;

    const {liveValues: values} = waterfall.state();
    // Only act on a FRESH frame -- spectrum.js allocates a new Float32Array
    // per extraction, so identity changing means real new data landed, not
    // just another animation frame re-reading the same numbers.
    if (values && values !== afcLastLiveValues) {
      afcLastLiveValues = values;
      if (decoder.squelchOpen) {
        const found = afcFindOffset(values, settings.afcMaxDeviationHz);
        if (found !== null) afcTargetHz = found;
      }
    }
    if (!decoder.squelchOpen) afcTargetHz = 0;   // no signal right now -- spring back to centre

    const maxStep = afcRateHzPerSec() * dtSec;
    const diff = afcTargetHz - afcOffsetHz;
    afcOffsetHz += Math.max(-maxStep, Math.min(maxStep, diff));
    afcOffsetHz = Math.max(-settings.afcMaxDeviationHz, Math.min(settings.afcMaxDeviationHz, afcOffsetHz));
    syncDecoderTone();
  }

  // ---- click-to-tune (shared RX/TX tone, kap.5) ---------------------------

  // Item 3 (grilled 2026-08-27, second session): a click/typed value sets the
  // lower physical tone directly (SPACE in the default Normal TX polarity,
  // MARK once settings.txPolarity is Reverse -- markToneHz()'s own comment),
  // not the internal centre -- settings.toneHz stays the centre
  // RttyCodec.Encoder/Decoder actually use (±SHIFT_HZ/2 for
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
    // Item 4e (grilled): a manual retune re-centres on purpose -- any
    // accumulated AFC offset was relative to the OLD centre and would be
    // nonsense applied to the new one, so it starts over from 0 here.
    afcOffsetHz = 0; afcTargetHz = 0;
    syncDecoderTone();
    drawScopeOverlay();
    dom.rttyToneInput.value = String(clamped);
  }

  // Item 2, grilled 2026-08-28: one listener on #rttyScope (the wrapper
  // around BOTH the live-spectrum panel and the waterfall, item 8) instead of
  // a 2nd, separate one on the live-spectrum canvas -- the two blocks share
  // the same Hz window and width, so a single rect/handler already covers
  // "click anywhere in the spectrum retunes", not just the waterfall.
  dom.rttyScope.addEventListener("click", event => {
    const rect = dom.rttyScope.getBoundingClientRect();
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
      // Item 1 (fix 1/2, grilled 2026-08-28): the shared /txgain.json table's
      // resolved level for the radio's CURRENT band+power, same accessor
      // data.js/wspr.js use for their own TX amplitude -- previously this
      // page never read it at all, so RttyCodec.Encoder always fell back to
      // its own default (amplitude=.5), ignoring calibration entirely,
      // regardless of which page it came from.
      //
      // Only overridden once resolved().calibrated is true: uncalibrated,
      // resolved().gain is 0 (this page's gainCal.manualGain() above is a
      // fixed 0, not a real slider like JS8/WSPR have), so passing it through
      // unconditionally would transmit silence on a never-calibrated
      // band/power instead of preserving the encoder's own historical
      // default -- worse than doing nothing, since RTTY worked fine before
      // this fix existed.
      const resolved = resolvedGain();
      // Item 3 (2nd session): txPolarity picked here, not read a 2nd time
      // inside rtty-codec.js -- one source of truth for "what does reverse
      // mean right now", same as markToneHz() above.
      const txReverse = settings.txPolarity === "reverse";
      const encoder = new RttyCodec.Encoder(TX_AUDIO_RATE, resolved.calibrated
        ? {toneHz: settings.toneHz, amplitude: resolved.gain, reverse: txReverse}
        : {toneHz: settings.toneHz, reverse: txReverse});
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
    if (error) markTxEchoFailed(lastTxEcho);
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
    lastTxEcho = null;   // same reasoning as onSendClick's own reset above
    sendAudioStream(text).catch(error => {
      const requestId = externalTxRequestId;
      externalTxRequestId = null;
      markTxEchoFailed(lastTxEcho);
      if (requestId && rttyTxChannel) rttyTxChannel.postMessage({type: "rtty-tx-result",
        requestId, ok: false, error: String(error.message || error)});
    });
  };

  // ---- TX: FSK-backend method (kap.6.2) -----------------------------------
  //
  // No mode-guard flip any more (grilled 2026-08-28): this is only ever
  // called while the radio is already RTTY/RTTY-R (onSendClick below decides
  // that from state.radio.mode directly), so there is nothing to snapshot or
  // restore -- a straight sendCw. sendCW() (wifilt.ino) routes RTTY/RTTY-R to
  // real FSK, internal GPIO or forwarded to an external TrxNet device per the
  // station's own FSK-output setting -- never AUD1 audio, whatever page has
  // it open.

  let fskSending = false;

  async function sendFskBackend(text) {
    echoTxText(text);   // item 6: same "at the start" timing as the audio-stream method
    fskSending = true;
    render();
    try {
      await command({type: "sendCw", text});
      dom.rttyTxState.textContent = "sent";
    } finally {
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
    lastTxEcho = null;
    dom.rttyTxState.textContent = "sending…";
    render();
    try {
      // Mode-driven, not an operator setting (grilled 2026-08-28): real
      // RTTY/RTTY-R always keys real FSK; anything else (in practice
      // USB-D/LSB-D) goes out as AFSK over the already-open AUD1 stream.
      const isRttyMode = state.radio.mode === "RTTY" || state.radio.mode === "RTTY-R";
      if (isRttyMode) await sendFskBackend(text);
      else await sendAudioStream(text);
      // Item 7: clear once genuinely committed (not on a validation throw
      // above, which leaves the typed text in place to fix and retry) --
      // same flow as js8call's own compose box.
      dom.rttyTxText.value = "";
      renderStatusPills();
    } catch (error) {
      dom.rttyTxState.textContent = `error: ${String(error.message || error)}`;
      markTxEchoFailed(lastTxEcho);
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

  // Item 6, grilled 2026-08-28: unlike JS8/WSPR/Mercury (fixed channelised
  // dial frequencies, "off dial" = not exactly equal to a preset), RTTY is
  // worked anywhere inside a band's calling segment -- so here it means
  // outside EVERY preset's own [lowHz,highHz] range instead.
  function offDialFrequency() {
    const hz = state.radio.frequency;
    if (!hz || !state.radio.connected) return false;
    // Checked against the on-air MARK (dialToMarkHz), not the raw CI-V dial --
    // in LSB-D/USB-D the two differ by markToneHz(), and it's the mark that
    // actually has to land inside the calling segment.
    const markHz = dialToMarkHz(hz, state.radio.mode || "");
    return !RttyPresets.PRESETS.some(preset => markHz >= preset.lowHz && markHz <= preset.highHz);
  }

  function render() {
    // Item 5 (grilled 2026-08-28, 3rd session): the red frame around the
    // whole viewport while the radio is keyed, plus the matching veil over
    // #rttyScope (rtty.css's own body.radio-transmitting rule) -- same
    // class, same stylesheet, same condition as WSPR-Beacon's own render()
    // (state.radio.tx is the radio's own answer, ~1s stale; session.ptt is
    // this socket's own, immediate).
    document.body.classList.toggle("radio-transmitting",
      Boolean(state.radio.tx || (session && session.ptt)));

    const slot = LanGate.slot ? LanGate.slot() : 0;
    dom.trxSlotLabel.textContent = slot ? `TRX${slot}` : "TRX";
    dom.trxFrequencyValue.textContent = state.radio.frequency
      ? RttyPresets.formatFrequency(state.radio.frequency) : "--.---.---";
    // Item 6: same .off-dial class/red styling data.css already gives JS8/
    // WSPR/Mercury's own #trxFrequency for their own "not on a known dial
    // frequency" state.
    const offDial = offDialFrequency();
    dom.trxFrequency.classList.toggle("off-dial", offDial);
    // Displayed number stays the raw CI-V dial (matches the radio's own front
    // panel) -- but in LSB-D/USB-D that's markToneHz() away from the real
    // on-air mark, so the title spells out where the mark actually is rather
    // than silently disagreeing with offDialFrequency()'s own (mark-based)
    // verdict above.
    const markHz = state.radio.frequency
      ? Math.round(dialToMarkHz(state.radio.frequency, state.radio.mode || "")) : 0;
    const titleParts = [];
    if (markHz && markHz !== Math.round(state.radio.frequency))
      titleParts.push(`mark on air: ${RttyPresets.formatFrequency(markHz)} MHz (${state.radio.mode} tone offset)`);
    if (offDial) titleParts.push("Outside every RTTY calling segment — choose a band from the menu");
    dom.trxFrequency.title = titleParts.join(" — ");
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

  // Item 1 (fix 1/2, grilled 2026-08-28): what the shared /txgain.json table
  // says for the radio's CURRENT band+power -- gainCal.resolved() already
  // does the identity()/store.entry() lookup keyed on TxGainCal.bandOf(),
  // same accessor data.js's/wspr.js's own resolvedGain() wrap. A knee
  // measured on ANY of the four DATA pages (same model+band+power) applies
  // here too, since it is the one shared table. Falls back to the encoder's
  // own historical default (.5) with a reason when nothing is calibrated yet
  // -- this page has no manual gain slider (kap.1), so gainCal.manualGain()
  // above already answers 0, not a slider value.
  const resolvedGain = () => gainCal.resolved();

  gainPlan = TxGainPlanUi.create({
    mount: dom.planField,
    button: dom.planButton,
    store: gainStore,
    cal: gainCal,
    model: calModel,
    modelNumber: () => IcomModels.modelNumber(calModel()),
    radio: () => state.radio,
    send: payload => commandJson(payload),
    // Item 1 (fix 2/2, grilled 2026-08-28): TxGainCal.bandOf(hz) -- not
    // preset.band -- because the plan's own row-validity check
    // (tx-gain-plan-ui.js: TxGainCal.bandOf(row.hz) !== row.band) and the
    // runtime resolvedGain() lookup above both key on bandOf()'s no-space
    // canonical name ("20m"), while RttyPresets.PRESETS.band is "20 m" (with
    // a space, same convention as js8-presets.js) -- every PLAN cell saved
    // under the raw preset label would fail that check/never be found again.
    // Same fix mercury.js already applies to its own bands() for the same
    // reason (see that file's own comment).
    bands: () => RttyPresets.PRESETS.map(preset =>
      ({band: TxGainCal.bandOf(preset.frequencyHz), hz: preset.frequencyHz})),
    wsprPresets: typeof WsprCore !== "undefined" ? WsprCore.PRESETS : [],
    js8Presets: typeof Js8TrxPresets !== "undefined" ? Js8TrxPresets.PRESETS : [],
    percentOf: radio => (radio.rfPowerSeen === true ? WsprCore.civPercent(radio.rfPower) : 0),
    // The powers this station actually operates on: the level configured for
    // RTTY (settings.rfPercent, the same field rfPowerAuto's own
    // targetPercent() reads below) and whatever the radio is set to right now
    // -- same two-source shape data.js/wspr.js/mercury.js already use for
    // their own defaultPowers(). This page used to offer only the second one,
    // so CAL PLAN seeded an empty grid (trySeed() in tx-gain-plan-ui.js needs
    // at least one power to create a column) whenever the radio had not yet
    // reported its power back over CI-V -- unlike every other DATA page,
    // which always has at least its own configured target to seed with
    // (code-review 2026-08-28).
    defaultPowers: () => {
      const out = [];
      const target = Number(settings.rfPercent);
      if (Number.isFinite(target) && target >= 1) out.push(Math.round(target));
      if (state.radio.rfPowerSeen === true) out.push(radioPercent());
      return out;
    },
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

  // ---- FSK output mode (item 5, grilled 2026-08-28, 2nd session) ----------
  //
  // Moved here from the SETUP page's LOG config section -- still the same
  // firmware/EEPROM-backed station setting (must answer the same way for
  // QRPLOG and every other computer, rtty-settings.js's own header comment),
  // just edited from the page that actually keys FSK. GET /log-config
  // already returns fskOutputMode/fskNetId as part of the raw stored
  // document, no firmware change needed to read them; writing goes through
  // the new, narrow POST /log-config/fsk instead of the giant /setup/save
  // form, which refuses the whole post unless ssid+pswd are both present --
  // this page has neither. That endpoint reads trx1Label/trx2Label/
  // trx3Label/blockedDxcc back out of the firmware's own live cache rather
  // than trusting anything this page sends, so there is no merge race to
  // worry about here -- only fskOutputMode/fskNetId ever come from this page.
  function syncFskNetIdRow() {
    dom.rttyFskNetIdRow.hidden = dom.rttyFskOutputMode.value !== "trxnet";
  }

  async function loadFskConfig() {
    try {
      const response = await fetch("/log-config", {cache: "no-store", signal: fetchDeadline()});
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      dom.rttyFskOutputMode.value = data.fskOutputMode === "trxnet" ? "trxnet" : "internal";
      dom.rttyFskNetId.value = typeof data.fskNetId === "string" ? data.fskNetId : "00";
    } catch (_error) {
      // Leaves whatever the <select>/<input> defaults already are -- same
      // "station not reachable yet" fallback every other SETTINGS field here
      // already has.
    }
    syncFskNetIdRow();
  }

  async function saveFskOutput() {
    const fskOutputMode = dom.rttyFskOutputMode.value === "trxnet" ? "trxnet" : "internal";
    const fskNetId = dom.rttyFskNetId.value || "00";
    try {
      await fetch("/log-config/fsk", {
        method: "POST", signal: fetchDeadline(),
        headers: {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
        body: new URLSearchParams({fskOutputMode, fskNetId}).toString(),
      });
    } catch (_error) { /* transient network failure -- the field just did not take */ }
  }

  // Trimmed, single-target copy of setup.html's own mountTrxnetPeerList()
  // (that file's own comment: "FSK output device: one target, no
  // ambiguity" -- no lastFocused-of-three tracking needed here, unlike its
  // TRX1/2/3 NET_ID picker). Kept as its own small copy rather than a shared
  // module, matching this codebase's usual convention for page-local widgets
  // (see rtty.js's own file-header note on calibration/plan files).
  function mountFskPeerList() {
    const section = dom.rttySettingsSection, body = dom.rttyTrxnetPeersFsk;
    if (!section || !body) return;
    let timer = null;

    const fmtAge = s => {
      s = Math.max(0, s | 0);
      if (s < 60) return `${s} s`;
      if (s < 3600) return `${(s / 60) | 0} m`;
      return `${(s / 3600) | 0} h`;
    };
    const esc = t => String(t).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
    const note = text => { body.innerHTML = `<span class="trxnet-peers-empty">${esc(text)}</span>`; };
    // Every device names itself "<prefix>.<2-hex-digit NET_ID>" (trxDeviceName's
    // own convention, wifilt.ino) -- the trailing pair is the id to fill.
    const netIdFromName = name => {
      const m = /\.([0-9a-fA-F]{2})$/.exec(String(name || ""));
      return m ? m[1].toUpperCase() : null;
    };
    const row = (name, ip, age, cls, badge) => {
      const netId = netIdFromName(name);
      const clickable = netId && cls !== "trxnet-peer-self";
      const tag = clickable ? "button" : "div";
      const attrs = clickable
        ? ` type="button" class="trxnet-peer trxnet-peer-pick ${cls}" data-netid="${netId}" title="Fill ${netId}"`
        : ` class="trxnet-peer ${cls}"`;
      return `<${tag}${attrs}><span class="trxnet-peer-name">${esc(name)}${badge || ""}</span>` +
        `<span class="trxnet-peer-ip">${esc(ip)}</span><span class="trxnet-peer-age">${esc(age)}</span></${tag}>`;
    };
    const render = d => {
      if (d.state === "handoff") { note("TrxNet starts on the next restart — the hotspot is still running"); return; }
      if (d.state === "ap") { note("TrxNet not active in AP mode"); return; }
      if (d.state === "disabled") { note("TrxNet disabled"); return; }
      const peers = (d.peers || []).slice().sort((a, b) => {
        if (Boolean(b.prio) !== Boolean(a.prio)) return b.prio - a.prio;
        return String(a.name).localeCompare(String(b.name));
      });
      let html = d.self ? row(d.self, "this device", "", "trxnet-peer-self", "") : "";
      html += peers.length
        ? peers.map(p => row(p.name, p.ip, fmtAge(p.age), p.prio ? "trxnet-peer-prio" : "",
            p.prio ? ' <span class="trxnet-prio-badge">PRIO</span>' : "")).join("")
        : '<span class="trxnet-peers-empty">No devices heard yet</span>';
      body.innerHTML = html;
    };
    const poll = () => fetch("/trxnet-peers.json", {cache: "no-store"})
      .then(r => r.json()).then(render).catch(() => note("Device list unavailable"));
    const start = () => { if (timer) return; poll(); timer = setInterval(poll, 3000); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    section.addEventListener("toggle", () => { if (section.open) start(); else stop(); });
    if (section.open) start();

    body.addEventListener("click", event => {
      const button = event.target.closest(".trxnet-peer-pick");
      if (!button) return;
      dom.rttyFskNetId.value = button.dataset.netid;
      saveFskOutput();
    });
  }

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
    // Item 8: the shared overlay is sized off #rttyScope's own box, not
    // driven by Waterfall.resize() (which only ever touched its own
    // canvas/overlay pair) -- resized alongside it so both stay in sync.
    window.addEventListener("resize", () => { waterfall.resize(); resizeScopeOverlay(); });

    dom.rttyReverse.addEventListener("click", () => {
      settings.reverse = !settings.reverse;
      saveSettings();
      decoder.setReverse(settings.reverse);
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

    // Item 3 (2nd session): this station's own AFSK TX polarity, independent
    // of the RX-only #rttyReverse pill above -- see markToneHz()'s own comment.
    dom.rttyTxPolarity.addEventListener("change", () => {
      settings.txPolarity = dom.rttyTxPolarity.value === "reverse" ? "reverse" : "normal";
      saveSettings();
      drawScopeOverlay();
    });

    // AFC (grilled 2026-08-28, 3rd session). Turning it off resets the
    // detector immediately, same reasoning as setToneFromSpaceHz()'s own
    // reset -- a stale offset left applied after the operator turned AFC
    // back off would be exactly the confusing behaviour the toggle exists to
    // prevent.
    dom.rttyAfcEnabled.addEventListener("change", () => {
      settings.afcEnabled = dom.rttyAfcEnabled.checked;
      saveSettings();
      dom.rttyAfcRateInput.disabled = !settings.afcEnabled;
      dom.rttyAfcMaxDeviationInput.disabled = !settings.afcEnabled;
      if (!settings.afcEnabled) { afcOffsetHz = 0; afcTargetHz = 0; syncDecoderTone(); }
      drawScopeOverlay();
    });
    dom.rttyAfcRateInput.addEventListener("change", () => {
      const hz = Number(dom.rttyAfcRateInput.value);
      if (!Number.isFinite(hz)) return;
      settings.afcRateHzPerChar = Math.max(RttySettings.AFC_RATE_MIN_HZ_PER_CHAR,
        Math.min(RttySettings.AFC_RATE_MAX_HZ_PER_CHAR, hz));
      dom.rttyAfcRateInput.value = String(settings.afcRateHzPerChar);
      saveSettings();
    });
    dom.rttyAfcMaxDeviationInput.addEventListener("change", () => {
      const hz = Number(dom.rttyAfcMaxDeviationInput.value);
      if (!Number.isFinite(hz)) return;
      settings.afcMaxDeviationHz = Math.max(RttySettings.AFC_MAX_DEVIATION_MIN_HZ,
        Math.min(RttySettings.AFC_MAX_DEVIATION_HARD_CAP_HZ, hz));
      dom.rttyAfcMaxDeviationInput.value = String(settings.afcMaxDeviationHz);
      saveSettings();
    });

    // Item 5 (2nd session): FSK output mode/NET_ID, firmware/EEPROM-backed
    // (see loadFskConfig()/saveFskOutput() above), not part of `settings`.
    dom.rttyFskOutputMode.addEventListener("change", () => {
      syncFskNetIdRow();
      saveFskOutput();
    });
    dom.rttyFskNetId.addEventListener("change", saveFskOutput);

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
    // Item 3: the field shows the lower physical tone, not the internal
    // centre settings.toneHz actually stores -- same conversion
    // setToneFromSpaceHz() uses on the way back in.
    dom.rttyToneInput.value = String(settings.toneHz - RttyCodec.SHIFT_HZ / 2);
    dom.rttyTxPolarity.value = settings.txPolarity;

    dom.rttyAfcEnabled.checked = settings.afcEnabled;
    dom.rttyAfcRateInput.min = String(RttySettings.AFC_RATE_MIN_HZ_PER_CHAR);
    dom.rttyAfcRateInput.max = String(RttySettings.AFC_RATE_MAX_HZ_PER_CHAR);
    dom.rttyAfcRateInput.value = String(settings.afcRateHzPerChar);
    dom.rttyAfcRateInput.disabled = !settings.afcEnabled;
    dom.rttyAfcMaxDeviationInput.min = String(RttySettings.AFC_MAX_DEVIATION_MIN_HZ);
    dom.rttyAfcMaxDeviationInput.max = String(RttySettings.AFC_MAX_DEVIATION_HARD_CAP_HZ);
    dom.rttyAfcMaxDeviationInput.value = String(settings.afcMaxDeviationHz);
    dom.rttyAfcMaxDeviationInput.disabled = !settings.afcEnabled;

    wire();
    waterfall.resize();
    resizeScopeOverlay();
    render();
    requestAnimationFrame(drawLiveSpectrum);

    // Item 5 (2nd session): firmware/EEPROM-backed, so it arrives with a
    // fetch rather than with rtty-settings.js's own localStorage load above
    // -- same one-time-at-boot convention log.js's own /log-config read uses.
    loadFskConfig();
    mountFskPeerList();

    // The plan (and every calibrated knee) is the station's, shared over
    // /txgain.json with JS8Call-ICOM/WSPR-Beacon -- it arrives with the table
    // rather than with the page. reload() adopts whatever is already there,
    // or seeds a usable first one when there is none (code-review 2026-08-28:
    // this call was missing here entirely, unlike data.js/wspr.js, which both
    // load the shared store on boot -- so RTTY-ICOM never saw a calibration
    // measured on another page, never picked up the shared plan, and its own
    // gainCal.resolved() could never report calibrated:true no matter what
    // was actually on file).
    gainStore.load().then(() => { if (gainPlan) gainPlan.reload(); render(); });

    pollState();
    setInterval(pollState, STATE_POLL_MS);

    claimSession();
  });
})();
