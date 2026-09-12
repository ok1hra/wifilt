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
    "aud1State", "ttControl", "planField", "planButton", "planButtonValue", "calField",
    "sessionBusy", "sessionBusyWhere", "sessionTakeover",
    "rttyReverse", "rttySquelch", "rttySnr",
    "waterfall", "waterfallCanvas", "spectrumSummary",
    "rttyScope", "rttyLiveSpectrum", "rttyScopeOverlay", "liveSpectrumCanvas",
    "rttyRxLog", "rxSummary", "rttyRxClear",
    "rttyTxText", "rttyTxAbort", "rttyTxState",
    "rttySquelchInput", "rttySquelchLive", "rttySquelchNewlineEnabled", "rttyToneInput", "settingsSummary",
    // AFC (grilled 2026-08-28, 3rd session): see the RttyAfc.createTracker()
    // wiring below for what these drive.
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
    "rttyFskMark",
    "rttySettingsSection",
  ]) dom[id] = $(id);

  const state = {
    radio: {connected: false, transceiverType: "", radioName: "", radioNameSeen: false,
      mode: "", frequency: 0, tx: false, rfPower: 0, rfPowerSeen: false},
    lastSnrDb: null, rxChars: 0,
  };

  const settings = RttySettings.load(window.localStorage);
  function saveSettings() { RttySettings.save(window.localStorage, settings); }

  // Squelch on/off (grilled 2026-08-29): settings.squelchThreshold=0 already
  // meant "never gates" before this (renderStatusPills' own .active check),
  // so turning it off needs no new field -- but restoring the LEVEL an
  // operator had dialled in before they hit the header pill's OFF does. This
  // is session-only (not persisted): a page loaded with squelch already off
  // has nothing on-disk to remember a level from, so it starts back at the
  // schema default like any other fresh load. Seeded from the loaded
  // threshold when it is already a real level, otherwise the schema default.
  let squelchOnMagnitude = settings.squelchThreshold > 0
    ? settings.squelchThreshold : RttySettings.defaults().squelchThreshold;
  function formatSquelchDb(db) { return `${Math.round(db)} dB`; }
  // Single place both the header pill and the SETTINGS row call to flip
  // squelch off (threshold 0, decoder never gates) or back on (whatever
  // level the slider was last parked at) -- keeps the two controls, and the
  // decoder itself, from ever disagreeing about which state they are in.
  function setSquelchEnabled(enabled) {
    settings.squelchThreshold = enabled ? squelchOnMagnitude : 0;
    saveSettings();
    applyEffective();
    dom.rttySquelchInput.value = String(Math.round(RttySettings.squelchMagnitudeToDb(squelchOnMagnitude)));
    dom.rttySquelchLive.textContent = formatSquelchDb(RttySettings.squelchMagnitudeToDb(squelchOnMagnitude));
    renderStatusPills();
  }

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
  // All four live in rtty-scope.js since 2026-09-07, so QRPlog's own RTTY
  // palette draws its mark/space lines from the same definitions instead of a
  // second copy. They are pure functions of `settings`; these thin wrappers
  // keep every call site in this file reading exactly as it did.
  // `effective`, not `settings`: in real FSK the tone these draw and compute
  // from is the radio's own Mark Frequency, not the operator's stored AFSK
  // one (rtty-fsk-sync.js). Outside RTTY/RTTY-R the two are the same object.
  const markToneHz = () => RttyScope.markToneHz(effective);
  const dialToMarkHz = (dialHz, mode) => RttyScope.dialToMarkHz(effective, dialHz, mode);
  const markToDialHz = (markTargetHz, mode) => RttyScope.markToDialHz(effective, markTargetHz, mode);
  // The pair the solid overlay lines sit on and afcTick() searches around --
  // spaceHz is just markHz's mirror image around settings.toneHz, whichever
  // physical tone markToneHz() currently calls mark.
  const expectedMarkSpaceHz = () => RttyScope.expectedMarkSpaceHz(effective);

  // ---- radio-authoritative FSK decode settings (real RTTY/RTTY-R only) ----
  //
  // Both halves -- the decoder's centre from the radio's RTTY Mark Frequency,
  // and settings.reverse from its RTTY Keying Polarity -- moved into
  // rtty-fsk-sync.js on 2026-09-10, because QRPlog's RTTY palette needs
  // exactly the same policy and had none of it (that file's header carries
  // the whole reasoning, including why the old one-way write to the radio's
  // Keying Polarity menu is gone). What stays here is the wiring: which CI-V
  // reader it uses, where its answers land, and what a change re-tones.
  //
  // The reader is TxGainModLevel.ModLevelClient, whose read(command) is
  // already the generic "arm /cmd civ.read, poll /civread until the sequence
  // moves" loop this page used to carry a private third copy of. Its capability
  // getter is about the MOD level and is not consulted for an explicit command.
  const civClient = new TxGainModLevel.ModLevelClient({
    send: payload => commandJson(payload),
    model: () => liveRadioModel(),
  });

  const fskSync = RttyFskSync.create({
    read: command => civClient.read(command).then(answer => answer && answer.value),
    model: () => liveRadioModel(),
    fallbackMarkHz: () => settings.fskMarkHz,
    // Self-healing: what the radio actually answered becomes the stored
    // fallback, so a later timed-out read lands on this radio's own last
    // truth instead of a guess.
    onMarkRead: hz => {
      if (settings.fskMarkHz === hz) return;
      settings.fskMarkHz = hz;
      saveSettings();
      if (dom.rttyFskMark) dom.rttyFskMark.value = String(hz);
    },
    onChange: () => applyEffective(),
  });

  // The settings the decoder, the overlay and the AFC actually run on:
  // `settings` as stored, with the FSK override laid over it while the radio
  // is in RTTY/RTTY-R and this page holds the audio. Never written back --
  // effective() hands back the stored object itself when nothing is
  // overridden, so outside real FSK the two are literally the same object.
  let effective = settings;

  function applyEffective() {
    const before = effective;
    effective = fskSync.effective(settings);
    // No boot guard, deliberately: `decoder` and `afcTracker` below are
    // const-initialised while this module evaluates, and nothing can call
    // this before that finishes -- every caller is an event handler, a fetch
    // continuation or fskSync.observe(), none of which exist yet. (A
    // `typeof decoder` guard would be worse than useless here: typeof throws
    // on a const still in its temporal dead zone, so it would turn the case
    // it claims to handle into an exception.)
    decoder.setReverse(effective.reverse);
    decoder.setSquelchThreshold(effective.squelchThreshold);
    // afcReset() re-tones the decoder on its way out (its onOffset does), so
    // a moved centre goes through it rather than being written twice -- and
    // an AFC offset accumulated around the OLD centre is nonsense applied to
    // this one.
    if (effective.toneHz !== before.toneHz) afcReset();
    else decoder.setToneOffset(effective.toneHz + afcTracker.offsetHz());
    drawScopeOverlay();
    renderStatusPills();
    renderToneField();
  }

  // The tone field shows what is being listened on, which in real FSK is the
  // radio's own Mark Frequency -- and is then READ-ONLY: the radio owns it,
  // there is nothing here to type that would survive. Same rule the palette
  // has by construction (no tone field at all).
  function renderToneField() {
    if (!dom.rttyToneInput) return;
    dom.rttyToneInput.value = String(Math.round(effective.toneHz - RttyCodec.SHIFT_HZ / 2));
    const held = fskSync.active();
    dom.rttyToneInput.disabled = held;
    dom.rttyToneInput.title = held
      ? "The radio's own RTTY Mark Frequency is in force while it is in RTTY/RTTY-R" +
        (fskSync.fromRadio() ? "" : " (not read from the radio -- FSK mark frequency setting)")
      : "";
  }

  // Shared by the manual #rttyReverse pill and the FSK sync above, so both go
  // through the same decoder/persist/render sequence.
  function setReverse(value) {
    // While the radio's polarity is in force, the pill is the per-contact
    // escape for a station that transmits inverted -- transient, like
    // everything else the sync owns, and re-derived on the next edge. The
    // stored preference (which belongs to USB-D/LSB-D AFSK) is left alone.
    if (fskSync.setReverse(value)) return;
    settings.reverse = value;
    saveSettings();
    applyEffective();
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
      // The lease is the second half of the sync's edge key, so TAKE OVER
      // from another page (mode unchanged) re-reads, and a page that has lost
      // the session stops reading -- which is what keeps the firmware's
      // single civReadArm() slot free of two readers at once. The lease, not
      // isSessionHolder(): a CI-V read needs no audio socket, and starting it
      // while the socket is still coming up means the tone is already right
      // when the first samples land.
      fskSync.observe(state.radio.mode, sessionHeld);
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
  //
  // The whole scope -- the Spectrum.Waterfall instance, the live-spectrum
  // trace, the single overlay spanning BOTH canvases (so the mark/space lines
  // are one continuous stroke across the seam rather than two per-canvas
  // draws that happen to line up), zoom, and the click/hover geometry -- lives
  // in rtty-scope.js since 2026-09-07, shared verbatim with QRPlog's own RTTY
  // palette (log-rtty-panel.js). That module's own header carries the
  // reasoning those pieces accumulated; nothing about them changed here.
  //
  // What stays on this page is what is genuinely the page's: which settings
  // the scope reads, what a click actually DOES (retune the radio in real-FSK
  // modes, move the audio tone otherwise), and the zoom pills' own DOM.
  const scope = RttyScope.create({
    scopeEl: dom.rttyScope,
    liveCanvas: dom.liveSpectrumCanvas,
    liveContainer: dom.rttyLiveSpectrum,
    waterfallCanvas: dom.waterfallCanvas,
    waterfallContainer: dom.waterfall,
    overlayCanvas: dom.rttyScopeOverlay,
    sampleRate: RX_AUDIO_RATE,
    baseLowHz: BASE_LOW_HZ, baseHighHz: BASE_HIGH_HZ,
    settings: () => effective,
    afcOffsetHz: () => afcTracker.offsetHz(),
    radio: () => state.radio,
    formatFrequency: RttyPresets.formatFrequency,
    // The AFC slew needs to keep moving every frame, not just when a fresh
    // FFT frame lands (e.g. still easing back to 0 after squelch closes).
    onFrame: () => afcTick(),
    onTune: lowHz => {
      // Click-to-tune-the-RADIO, real FSK only (grilled 2026-08-30): real FSK
      // has no audio stage on TX (dial == mark), so retuning the dial is the
      // ONLY way to bring a station onto this operator's fixed passband.
      // USB-D/LSB-D keep the original "click sets the audio tone" behaviour.
      const isRealFsk = state.radio.mode === "RTTY" || state.radio.mode === "RTTY-R";
      if (isRealFsk) retuneRadioForLowHz(lowHz);
      else setToneFromSpaceHz(lowHz);
    },
  });
  // Kept as the names the rest of this file already reads, so every existing
  // call site is unchanged.
  const waterfall = scope.waterfall;
  const drawScopeOverlay = () => scope.drawOverlay();

  // Item 15: the module owns the window arithmetic (including why 100 % is the
  // fixed base range and not tone-centred like 200/400 %); this owns the DOM
  // the page shows for it. Deliberately not persisted -- always starts at 100%.
  function applyZoom(percent) {
    const {low, high} = scope.setZoom(percent);
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
    scope.ingest(samples);
  }

  // ---- RX decode (RttyCodec.Decoder) --------------------------------------

  const decoder = new RttyCodec.Decoder(RX_AUDIO_RATE,
    {toneHz: effective.toneHz, reverse: effective.reverse,
     squelchThreshold: effective.squelchThreshold});

  // kap.13/13.4 + item 6: the RX log itself -- word tokens, the per-character
  // SNR gradient, scrollback trimming, the squelch-open break and this
  // station's own TX echo -- lives in rtty-rxlog.js since 2026-09-07, shared
  // with QRPlog's own RTTY palette (log-rtty-panel.js). That module's header
  // carries the reasoning all of it accumulated, including why the gradient
  // keys off Math.abs(snrDb) and why its dB bounds are still placeholders.
  //
  // The gradient endpoints are resolved from THIS document's own :root, which
  // is exactly what used to happen inline here -- the module takes them as
  // parameters because QRPlog's palette has to resolve them against its own
  // element instead (that page is light and defines neither --muted nor
  // --panel2, so a documentElement read there would produce nonsense).

  // Click a decoded token -> hand it to QRPlog, same BroadcastChannel dxc.html
  // already uses (kap.5/8.1). Unlike a DXC spot, this isn't "go work this
  // station" -- source:"rtty" tells log.js's listener to leave RUN/S&P alone,
  // and (grilled again 2026-08-30) to drop the word into whichever of
  // Call/Exch the operator is actually focused in there, not always Call --
  // a clicked token is any decoded word, not necessarily a callsign.
  const dxcChannel = (() => { try { return new BroadcastChannel("wifilt-dxc-action"); } catch (_error) { return null; } })();

  const rxLog = RttyRxLog.create({
    el: dom.rttyRxLog,
    maxChars: RX_LOG_MAX_CHARS,
    onToken: word => {
      if (!dxcChannel) return;
      dxcChannel.postMessage({type: "dxc-tune", callsign: word,
        trx: LanGate.slot ? LanGate.slot() : 0, source: "rtty"});
    },
  });

  decoder.onChar((ch, meta) => {
    state.rxChars++;
    if (Number.isFinite(meta.snrDb)) state.lastSnrDb = meta.snrDb;
    rxLog.pushChar(ch, meta);
    renderStatusPills();
  });

  // kap.13.4 (grilled 2026-08-29): on every squelch close->open transition,
  // insert a line break into the RX log -- reuses rtty-codec.js's Decoder's
  // existing onEvent() hook, no codec change needed. The throttle and the
  // "skip while the log is still empty" rule (and why that skip must not
  // consume the throttle window) live in the module.
  decoder.onEvent(evt => {
    if (evt.type !== "squelch" || !evt.open || !effective.squelchNewlineEnabled) return;
    rxLog.squelchBreak();
  });

  // CLEAR pill (RX summary row): wipes the log itself, not the decoder state --
  // squelch/AFC/tone tracking all live in the decoder/settings and must keep
  // running exactly as before. lastTxEcho is deliberately left alone --
  // markTxEchoFailed() only ever touches it through container.isConnected,
  // already false once this clears the log, so a send still in flight fails
  // silently-safe rather than throwing.
  function clearRxLog() {
    rxLog.clear();
    state.rxChars = 0;
    renderStatusPills();
  }

  // Tracks the most recent echo so a send that fails AFTER being echoed
  // (session.prepare()/setMode/sendCw can all still throw -- kap.6's own
  // failure modes) can retract it, rather than leaving a false "sent" line for
  // a message that never actually went out: the RX log is the one place QRPlog
  // cross-references what was sent, and it had no way to tell a genuine send
  // from a failed attempt. Only one at a time needs tracking -- txBusy()
  // already keeps the two TX methods mutually exclusive.
  let lastTxEcho = null;   // {container, timers}
  const echoTxText = text => { lastTxEcho = rxLog.echoTx(text); };
  const markTxEchoFailed = echo => rxLog.markEchoFailed(echo);

  // ---- AFC (grilled 2026-08-28, 3rd/4th sessions) --------------------------
  //
  // Tracks the OTHER station's drift by nudging only the decoder's own
  // runtime tone offset (decoder.setToneOffset(), from the tracker's onOffset
  // below) -- settings.toneHz itself, and therefore this station's own TX
  // tone and the solid mark/space overlay lines, never move.
  //
  // The carrier-pair detector (RttyAfc.findOffset()) reuses the waterfall's
  // own live FFT tap
  // (spectrum.js's liveDraw(), already running at liveHopSize=128 -- ~16 ms
  // @ 8 kHz -- for the live-spectrum panel above the waterfall) instead of
  // adding a second FFT. That instantaneous estimate (RttyAfc.findOffset())
  // becomes this tick's target; the actual detector offset chases it at a
  // fixed max Hz/s slew rate (afcRateHzPerChar converted from Hz/char). When
  // no pair is found, a closed decoder squelch springs the target back to the
  // operator's centre; an open squelch holds the last lock for an idle MARK.
  // The slew integration, the fresh-frame gate and the deviation clamp live in
  // rtty-afc.js's own createTracker() since 2026-09-07, beside the detector
  // they wrap and shared with QRPlog's RTTY palette. What stays here is the
  // wiring: which spectrum tap it reads, which decoder it re-tones.
  const afcTracker = RttyAfc.createTracker({
    settings: () => effective,
    liveValues: () => waterfall.state().liveValues,
    window: () => ({lowHz: waterfall.lowHz, highHz: waterfall.highHz}),
    markSpace: () => expectedMarkSpaceHz(),
    squelchOpen: () => decoder.squelchOpen,
    // AFC nudges only the decoder's own runtime tone offset --
    // settings.toneHz itself, and therefore this station's own TX tone and the
    // solid mark/space overlay lines, never move.
    onOffset: offsetHz => decoder.setToneOffset(effective.toneHz + offsetHz),
    charDurationMs: RttyCodec.CHAR_DURATION_MS,
  });

  // The names the rest of this file already calls. There is no separate
  // "re-tone the decoder" helper any more: every site that moves
  // settings.toneHz resets the tracker, and reset() re-tones on its way out.
  const afcTick = () => afcTracker.tick();
  const afcReset = () => afcTracker.reset();

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
    // applyEffective() does that reset itself once the centre has moved.
    applyEffective();
  }

  // Click-to-tune-the-RADIO, real FSK only (RTTY/RTTY-R -- grilled 2026-08-30,
  // replaces setToneFromSpaceHz() for exactly these two modes; USB-D/LSB-D
  // keep the original "click sets the audio tone" behaviour below unchanged).
  //
  // Real FSK has no audio stage on TX (dial==mark, markToDialHz()'s own
  // comment), so retuning the dial is the ONLY way to bring a station onto
  // this operator's fixed passband -- settings.toneHz itself never moves
  // here, unlike setToneFromSpaceHz().
  //
  // dialToMarkHz()/markToDialHz() do not apply: those are absolute-RF-Hz
  // functions for the frequency-menu presets (an RF target in, an RF target
  // or dial out), TX-side by definition -- they say nothing about how an
  // already-INCOMING signal's RX audio position moves with the dial. That
  // relationship was confirmed on air (operator, 2026-08-30): the dial and
  // the received audio tone move the SAME direction, 1:1 -- turn the dial
  // down, a signal's audio pitch moves down too, and back up the same way.
  // So: however far off (in audio Hz) the clicked signal sits from the fixed
  // reference tone, the dial needs exactly that same signed shift.
  function retuneRadioForLowHz(clickedLowHz) {
    const referenceLowHz = effective.toneHz - RttyCodec.SHIFT_HZ / 2;
    const deltaHz = referenceLowHz - clickedLowHz;
    const newDialHz = Math.round((state.radio.frequency || 0) + deltaHz);
    if (newDialHz <= 0) return;   // no radio frequency known yet -- nothing sane to compute
    // Mirrors requestFrequency()'s own silent catch: pollState already shows
    // whatever the radio actually did, on success or refusal alike.
    command({type: "setFrequency", frequency: String(newDialHz)}).catch(() => {});
    // Same reasoning as setToneFromSpaceHz()'s own reset: an AFC offset
    // tracking drift around the OLD signal position is meaningless once the
    // dial has just jumped to a different one.
    afcReset();
  }

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

  // The send itself -- encode, packetize, the immediate-PTT pacing loop and
  // its drain watchdog -- lives in rtty-afsk-tx.js since 2026-09-07, shared
  // with QRPlog's own RTTY palette (log-rtty-panel.js). That module's header
  // carries the reasoning, including why this is an own loop rather than
  // Js8Tx.TxController.queue().
  //
  // What stays here is what finishing a send MEANS to this page: the
  // composer's own state pill, and the QRPlog hand-off's result message.
  const afskTx = RttyAfskTx.create({
    session: () => session,
    settings: () => effective,
    // Item 1 (grilled 2026-08-28): the shared /txgain.json table's resolved
    // level for the radio's CURRENT band+power, the same accessor
    // data.js/wspr.js use -- previously this page never read it at all, so
    // RttyCodec.Encoder always fell back to its own amplitude=.5 default and
    // ignored calibration entirely.
    gain: () => resolvedGain(),
    sampleRate: TX_AUDIO_RATE,
    leadMs: TX_LEAD_MS, prebufferMs: TX_PREBUFFER_MS,
    streamLeadMs: TX_STREAM_LEAD_MS, packetMs: TX_PACKET_MS,
    ringLimitMs: TX_RING_LIMIT_MS, watchdogMarginMs: TX_WATCHDOG_MARGIN_MS,
    onEcho: text => { echoTxText(text); return lastTxEcho; },
    onEchoFailed: echo => markTxEchoFailed(echo),
    onFinish: error => {
      dom.rttyTxState.textContent = error ? `error: ${error}` : "sent";
      if (externalTxRequestId && rttyTxChannel) {
        rttyTxChannel.postMessage({type: "rtty-tx-result", requestId: externalTxRequestId,
          ok: !error, error: error || undefined});
        externalTxRequestId = null;
      }
    },
    onTick: () => render(),
  });

  // The names the rest of this file already calls, unchanged in meaning.
  const sendAudioStream = text => afskTx.start(text);
  const abortAudioTx = reason => afskTx.abort(reason);
  const resetAudioTx = () => afskTx.reset();

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
    // Grilled 2026-08-30: QRPLOG's FSK-backend sends (true RTTY/RTTY-R mode)
    // key the radio straight from the firmware's own GPIO (wifilt.ino's
    // sendCW()) -- no AUD1 session, no hand-off, nothing that needs this tab
    // to be the session holder or even idle (unlike rtty-tx-send below).
    // This is purely a display mirror, sent whether or not any RTTY-ICOM tab
    // exists to show it, so it renders unconditionally with the same
    // echoTxText() the local composer/FSK-backend path already uses --
    // same per-character "lit" tempo, no separate success/failure tracking
    // since QRPlog has none to relay either.
    if (msg.type === "rtty-tx-fsk-echo") {
      echoTxText(String(msg.text || ""));
      return;
    }
    if (msg.type === "rtty-tx-probe") {
      if (isSessionHolder() && !afskTx.busyOrStarting())
        rttyTxChannel.postMessage({type: "rtty-tx-probe-ack", requestId: msg.requestId});
      return;
    }
    if (msg.type !== "rtty-tx-send") return;
    if (!isSessionHolder()) return; // not the holder -- the real one answers, or nobody does
    if (afskTx.busyOrStarting()) {
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

  // Two TX methods, two independent pieces of state (the AFSK sender carries
  // its own packet-pacing detail an abort needs; fskSending is a plain flag)
  // -- but "is either one busy" was re-derived slightly differently at each
  // call site (code-review). Single helper for that question; call sites that
  // need to know WHICH one is busy still ask afskTx/fskSending directly.
  function txBusy() { return afskTx.busy() || fskSending; }

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
    if (afskTx.busy()) abortAudioTx("operator");
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
    // Grilled 2026-08-29: CAL PLAN's calibration carrier is an audio tone
    // over AUD1 (see the CAL PLAN section's own header comment below) --
    // true RTTY/RTTY-R (FSK) mode keys the shift modulator via the GPIO
    // line instead, so there is nothing for that tone to measure. Hidden
    // outright, not just disabled -- reappears immediately in every other
    // mode, including USB-D/LSB-D, where the audio path is real.
    dom.ttControl.hidden = state.radio.mode === "RTTY" || state.radio.mode === "RTTY-R";
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
    dom.rttyReverse.textContent = effective.reverse ? "REVERSE" : "NORMAL";
    dom.rttyReverse.classList.toggle("active", effective.reverse);
    // Item 16: the configured level itself (SETTINGS' own dB number),
    // highlighted while squelch is engaged (threshold above 0 -- the normal
    // state). Replaces the old live open/closed reading. Grilled 2026-08-29:
    // the pill is now also the on/off button (click handler below) --
    // OFF reads as plain text, ON as the dB level, same .active highlight as
    // before either way.
    dom.rttySquelch.textContent = settings.squelchThreshold === 0
      ? "SQL OFF" : "SQL " + formatSquelchDb(RttySettings.squelchMagnitudeToDb(settings.squelchThreshold));
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
  const gainPlanStore = new TxGainPlanStore.PlanStore({
    profile: TxGainPlanStore.PROFILE_TONE,
    bands: () => RttyPresets.PRESETS.map(preset =>
      ({band: TxGainCal.bandOf(preset.frequencyHz), hz: preset.frequencyHz})),
  });
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
      if (afskTx.busy()) return "a TX composer send is in progress";
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
    resultStore: gainStore,
    planStore: gainPlanStore,
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
    window.addEventListener("resize", () => scope.resize());

    dom.rttyReverse.addEventListener("click", () => setReverse(!effective.reverse));
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

    // Same stopPropagation reasoning as the zoom pills above -- this button
    // lives in the RX <summary> too.
    dom.rttyRxClear.addEventListener("click", event => {
      event.stopPropagation();
      clearRxLog();
    });

    // Grilled 2026-08-29: this slider moves on the dB scale now and only ever
    // sets the LEVEL (never 0 -- squelchDbToMagnitude() floors at magnitude
    // 1) -- dragging it always leaves squelch on, same as turning a physical
    // squelch knob up from its detented-off position always does.
    dom.rttySquelchInput.addEventListener("input", () => {
      squelchOnMagnitude = RttySettings.squelchDbToMagnitude(Number(dom.rttySquelchInput.value));
      settings.squelchThreshold = squelchOnMagnitude;
      saveSettings();
      applyEffective();
      dom.rttySquelchLive.textContent = formatSquelchDb(RttySettings.squelchMagnitudeToDb(squelchOnMagnitude));
      renderStatusPills();   // item 16: the SQL pill mirrors this live
    });
    // Header SQL pill (grilled 2026-08-29): now the on/off control, not just a
    // readout -- stopPropagation is not needed here, it is not inside a
    // <summary>.
    dom.rttySquelch.addEventListener("click", () => setSquelchEnabled(settings.squelchThreshold === 0));
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
      applyEffective();
    });

    // The fallback mark frequency. Takes effect on the next RTTY/RTTY-R edge
    // (or immediately, if the radio is in real FSK right now and the value it
    // is running on did not come from the radio itself) -- a live re-derive
    // rather than a stored value nobody acts on until a mode change.
    dom.rttyFskMark.addEventListener("change", () => {
      const hz = Math.round(Number(dom.rttyFskMark.value));
      if (!RttySettings.FSK_MARK_CHOICES_HZ.includes(hz)) return;
      settings.fskMarkHz = hz;
      saveSettings();
      if (fskSync.active() && !fskSync.fromRadio()) fskSync.setMarkHz(hz);
    });

    // kap.13.4 (grilled 2026-08-29): see decoder.onEvent() above for what this drives.
    dom.rttySquelchNewlineEnabled.addEventListener("change", () => {
      settings.squelchNewlineEnabled = dom.rttySquelchNewlineEnabled.checked;
      saveSettings();
      applyEffective();
    });

    // AFC (grilled 2026-08-28, 3rd session). Turning it off resets the
    // detector immediately, same reasoning as setToneFromSpaceHz()'s own
    // reset -- a stale offset left applied after the operator turned AFC
    // back off would be exactly the confusing behaviour the toggle exists to
    // prevent.
    dom.rttyAfcEnabled.addEventListener("change", () => {
      settings.afcEnabled = dom.rttyAfcEnabled.checked;
      saveSettings();
      applyEffective();
      dom.rttyAfcRateInput.disabled = !settings.afcEnabled;
      dom.rttyAfcMaxDeviationInput.disabled = !settings.afcEnabled;
      if (!settings.afcEnabled) afcReset();
    });
    dom.rttyAfcRateInput.addEventListener("change", () => {
      const hz = Number(dom.rttyAfcRateInput.value);
      if (!Number.isFinite(hz)) return;
      settings.afcRateHzPerChar = Math.max(RttySettings.AFC_RATE_MIN_HZ_PER_CHAR,
        Math.min(RttySettings.AFC_RATE_MAX_HZ_PER_CHAR, hz));
      dom.rttyAfcRateInput.value = String(settings.afcRateHzPerChar);
      saveSettings();
      applyEffective();
    });
    dom.rttyAfcMaxDeviationInput.addEventListener("change", () => {
      const hz = Number(dom.rttyAfcMaxDeviationInput.value);
      if (!Number.isFinite(hz)) return;
      settings.afcMaxDeviationHz = Math.max(RttySettings.AFC_MAX_DEVIATION_MIN_HZ,
        Math.min(RttySettings.AFC_MAX_DEVIATION_HARD_CAP_HZ, hz));
      dom.rttyAfcMaxDeviationInput.value = String(settings.afcMaxDeviationHz);
      saveSettings();
      applyEffective();
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

    dom.rttySquelchInput.min = String(RttySettings.SQUELCH_DB_MIN);
    dom.rttySquelchInput.max = String(RttySettings.SQUELCH_DB_MAX);
    // The slider always shows the LEVEL (squelchOnMagnitude), on or off --
    // on/off itself is the header pill's job (renderStatusPills() below).
    dom.rttySquelchInput.value = String(Math.round(RttySettings.squelchMagnitudeToDb(squelchOnMagnitude)));
    dom.rttySquelchLive.textContent = formatSquelchDb(RttySettings.squelchMagnitudeToDb(squelchOnMagnitude));
    // rtty.html's <input min/max> is a static fallback for the instant before
    // this runs; RttySettings is authoritative from here on (code-review).
    dom.rttyToneInput.min = String(RttySettings.TONE_MIN_HZ);
    dom.rttyToneInput.max = String(RttySettings.TONE_MAX_HZ);
    // Item 3: the field shows the lower physical tone, not the internal
    // centre settings.toneHz actually stores -- same conversion
    // setToneFromSpaceHz() uses on the way back in.
    renderToneField();
    dom.rttyTxPolarity.value = settings.txPolarity;
    dom.rttySquelchNewlineEnabled.checked = settings.squelchNewlineEnabled;
    // The radio's own Mark Frequency, for the models it cannot be read from
    // (and as the fallback for a read that times out on the ones it can).
    dom.rttyFskMark.value = String(settings.fskMarkHz);

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
    scope.resize();
    render();
    scope.start();

    // Item 5 (2nd session): firmware/EEPROM-backed, so it arrives with a
    // fetch rather than with rtty-settings.js's own localStorage load above
    // -- same one-time-at-boot convention log.js's own /log-config read uses.
    loadFskConfig();
    mountFskPeerList();

    // The station-wide plan is shared with JS8Call-ICOM/WSPR-Beacon through
    // /txgain-plan.json; their single-tone knees remain in /txgain.json.
    // reload() adopts whatever is already there,
    // or seeds a usable first one when there is none (code-review 2026-08-28:
    // this call was missing here entirely, unlike data.js/wspr.js, which both
    // load the shared store on boot -- so RTTY-ICOM never saw a calibration
    // measured on another page, never picked up the shared plan, and its own
    // gainCal.resolved() could never report calibrated:true no matter what
    // was actually on file).
    gainPlanStore.loadAndMigrate([
      {profile: TxGainPlanStore.PROFILE_TONE, store: gainStore},
    ]).then(() => { if (gainPlan) gainPlan.reload(); render(); });

    pollState();
    setInterval(pollState, STATE_POLL_MS);

    claimSession();
  });
})();
