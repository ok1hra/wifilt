// WSPR beacon page. See docs/wspr-majak-implementace.md.
//
// Owns: settings, the single-operator lock, /state polling, CAT (band, USB-D,
// power with readback), the 24-hour sequence timetable, TUNE, and the beacon state machine
// that hands one frame at a time to WsprTx.
//
// Deliberately does not own: symbol generation and pacing (wspr-core.js,
// wspr-tx.js) or the AUD1 wire protocol (js8-aud1.js, used unchanged).

(function () {
  "use strict";

  // Same seam data.js uses (data.js:11): lets a fixture point the audio socket at
  // an unprivileged port on the same host. Port 83 is privileged, so without this
  // the page could not be exercised outside a real device at all.
  const AUDIO_WS_PORT =
    Number(new URLSearchParams(location.search).get("audioPort")) || 83;
  const STATE_POLL_MS = 1000;
  // Same abort deadline data.js carries (data.js:30): a fetch with no timeout
  // parks a browser connection on a half-open socket for minutes after a WiFi
  // burst, and at this page's 1 Hz poll rate the per-origin pool is exhausted
  // within seconds -- after which every request, including a reload, queues
  // behind dead ones. 8 s clears the ~5 s the firmware legitimately defers
  // port 80 around a TX slot; flash-writing POSTs get a longer leash.
  const FETCH_TIMEOUT_MS = 8000, FETCH_FLASH_TIMEOUT_MS = 12000;
  const fetchDeadline = (ms = FETCH_TIMEOUT_MS) => AbortSignal.timeout(ms);
  const SESSION_PING_MS = 5000, SESSION_RETRY_MS = 3000, SESSION_PROBE_MS = 250;
  const SETTINGS_KEY = "wifilt.wspr.v1";
  const PREPARE_LEAD_MS = 10000;    // must match WsprTx's window
  // Back-to-back frames leave 9,4 s between the end of one WSPR signal (110,592 s
  // of a 120 s frame) and the start of the next, and the band change has to fit
  // inside it. The queue refuses anything later than leadMs/2, so the beacon
  // hands WsprTx a shorter lead for those frames -- the prebuffer itself only
  // needs 1,35 s. Nothing is allowed to key on an unconfirmed dial: a frame that
  // is not ready by the cutoff is given up as missed instead.
  const TIGHT_LEAD_MS = 4000, RETUNE_CUTOFF_MS = 2000, BAND_SETTLE_MS = 300;
  // Three retunes that did not make the cutoff mean the link cannot sustain a
  // change every frame; the schedule then leaves one frame free after each band
  // change until a retune fits again.
  const RETUNE_MISS_LIMIT = 3;
  // TUNE is a manual action, so it uses the shortest lead the TX path allows
  // (prebuffering starts 1.35 s before the slot) rather than the beacon's ten
  // seconds -- a button that does nothing for ten seconds reads as broken.
  const TUNE_LEAD_MS = 2500;
  const TUNE_MAX_MS = 10000;        // hard cap, same as the JS8 tune carrier
  // AUD1_TX_RING_SIZE in the sketch: the firmware's TX audio ring, 1.536 s of
  // 8 kHz mu-law. This is the margin the browser keeps ahead of the radio, and
  // the thing that runs out when a transmission dies of "TX buffer underrun".
  const TX_RING_BYTES = 12288;
  const TX_RING_SECONDS = TX_RING_BYTES / 8000;
  // LAN is exclusive to one of TRX1-TRX3 and the operator picks which; ?radio=lan
  // makes the firmware answer for that slot instead of the primary radio. Without
  // it the beacon would read and command TRX1 while its audio went to the LAN
  // radio -- silently wrong whenever LAN sits on TRX2 or TRX3. data.js does the
  // same, and lan-gate.js has already proved the slot exists by the time these
  // are used.
  const RADIO_STATE_URL = "/state?radio=lan";
  const RADIO_CMD_URL = "/cmd?radio=lan";

  const $ = id => document.getElementById(id);
  const dom = {};
  for (const id of ["trxFrequencyValue", "trxMode", "radioModel", "linkState", "utcClock",
    "sessionBusy", "sessionBusyWhere", "sessionTakeover",
    "beaconInterface", "callsign", "locator", "locatorTransmitted", "powerDbm", "powerWatts",
    "powerPercent", "powerSet", "radioModelOverride", "fullPowerWatts",
    "fullPowerSource", "clockCorrection", "powerField", "powerMismatch",
    "txGain", "txSafety", "tuneButton", "powerMeter", "swr", "tuneReference",
    "calField", "calResolved", "planField", "planButton",
    "referenceCount", "referenceClear",
    "periodHint", "scheduleAdd", "scheduleClear", "scheduleUndo", "scheduleClose",
    "scheduleList", "schedulePopover",
    "previewTitle", "previewCount", "previewGrid",
    "previewNext", "startStop", "beaconState", "nextSession", "liveSession",
    "sessionProgress", "ringFill", "packetCount", "pttState", "beaconError",
    "activityDays", "activityTotals", "activityGrid", "activityDetail", "plannedLegend",
    "activityBands",
    // shell shared with the JS8Call page
    "waterfall", "waterfallCanvas", "waterfallOverlay", "spectrumSummary", "audioLevel",
    "aud1State", "lanHealth", "trxReconnect", "trxHelpButton", "trxHelpDialog",
    "trxHelpModeWarning", "timingState", "trxFrequency", "frequencyMenu",
    "trxSlotLabel", "slotTimer",
    "freqTimetableButton", "freqTimetableValue", "freqTimetablePanel",
    "txSessionSummary", "activitySummary", "settingsSummary"]) dom[id] = $(id);

  // The WSPR sub-band inside the SSB passband. The offset is randomised in here
  // for every transmission; the waterfall only shows where it landed.
  const WINDOW_LOW_HZ = 1400, WINDOW_HIGH_HZ = 1600;
  const RX_LOW = 500, RX_HIGH = 2700, AUDIO_RATE = 8000;
  // Never key above this, whatever the radio can do. A 110 s carrier is a
  // different proposition from an SSB transmission, and this page is a QRP
  // beacon on someone's desk.
  const POWER_CEILING_W = 10;
  // How far off a WSPR dial frequency the radio may sit before the page decides
  // the operator needs the setup help rather than a silent refusal.
  const DIAL_TOLERANCE_HZ = 500;

  const state = {
    radio: {connected: false, transceiverType: "", radioName: "", radioNameSeen: false, mode: "", frequency: 0,
            tx: false, powerMeterRaw: 0, swr: 0, rfPower: 0, rfPowerSeen: false, supplyVolts: 0,
            lanDrops: 0, lanStalls: 0, lanFilled: 0},
    beacon: "stopped",          // stopped | armed | tuning | transmitting | paused
    consecutiveBroken: 0,
    tunePeakRaw: 0,             // highest forward-power reading seen during TUNE
    tuneBand: "",               // band that peak belongs to, filed with it
    tuneDbm: null,              // and the level the radio was on while measuring
    tuneEndsAtMs: 0,            // when the tune watchdog will cut the carrier
    lastError: "",
    pendingSlotUtcMs: 0,
    lastRetuneMs: 0,          // how long the last band change took, measured
    retuneMisses: 0,          // consecutive frames lost to a band change running late
    spaceBandChanges: false,  // ... and the slower pace that follows three of them
    bandFilter: "",           // which band the activity grid is showing ("" = all)
    currentSession: null,     // what the in-flight transmission will be logged as
    activity: [],             // records loaded from IndexedDB, newest first
    activityRange: "6h",
    selectedCell: null,
    audioDb: -90,
    lastOffsetHz: 1500,       // where the last (or current) transmission landed
    pendingFrequency: 0,      // a hand-tuned band waiting for the radio to confirm
    helpShownForSetup: false, // latch: the setup dialog opens once per bad state
  };

  // ---- settings ------------------------------------------------------------

  // The station locator lives in the shared Js8Settings blob, not here: it is a
  // property of the station, so fixing it on arrival at a portable site should
  // fix it for JS8LAN too.
  function loadShared() { return Js8Settings.load(localStorage).settings; }
  function sharedGrid() {
    const settings = loadShared();
    return (settings.modems && settings.modems.js8call && settings.modems.js8call.grid) || "";
  }
  function sharedCall() {
    const settings = loadShared();
    return (settings.modems && settings.modems.js8call && settings.modems.js8call.myCall) || "";
  }
  function saveShared(patch) {
    const settings = loadShared();
    Object.assign(settings.modems.js8call, patch);
    Js8Settings.save(localStorage, settings);
  }
  // The same pledge JS8LAN requires before it will key, deliberately shared: it
  // is a statement about the antenna and the power, not about a mode. Read fresh
  // on every call, so ticking the box on either page is seen here immediately.
  function txSafetyAccepted() {
    const settings = loadShared();
    return Boolean(settings.modems && settings.modems.js8call &&
                   settings.modems.js8call.txSafetyAccepted);
  }

  // Shared for the same reason as the pledge: it is one MOD input on one radio.
  // Both modes are constant-envelope -- WSPR is a single tone, JS8 is FSK -- so
  // the same level gives the same ALC reading, and two stored values only meant
  // the drive depended on which page transmitted last, invisibly.
  function txGain() {
    const settings = loadShared();
    const value = settings.modems && settings.modems.js8call
      ? Number(settings.modems.js8call.txGain) : NaN;
    return Number.isFinite(value) ? Math.min(0.8, Math.max(0.1, value)) : 0.25;
  }

  // WSPR starts one second past an even UTC minute and the decoder tolerates
  // about a second, so a device whose clock is off transmits into nothing. The
  // correction is shared with JS8Call, which is also the only page that can
  // measure it -- WSPR does not decode, so it cannot check its own clock and
  // deliberately offers no automatic timing.
  function clockCorrectionMs() {
    const settings = loadShared();
    const value = settings.modems && settings.modems.js8call
      ? Number(settings.modems.js8call.clockCorrectionMs) : 0;
    return Number.isFinite(value) ? value : 0;
  }
  const utcNow = () => Date.now() + clockCorrectionMs();

  // One formatter for every countdown on the page. A sparse schedule can put the
  // next transmission most of a day away, and mm:ss without an hour rollover
  // turned that into "720:00" -- a number that looks like a fault.
  // A running clock rather than a phrase: minutes always padded, hours only when
  // there are any. Used by the timer beside START, where a jumping width would
  // make the button move.
  function formatClock(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const pad = value => String(value).padStart(2, "0");
    const hours = Math.floor(total / 3600);
    return hours ? `${hours}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`
                 : `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    if (total < 60) return `${total} s`;
    const pad = value => String(value).padStart(2, "0");
    const minutes = Math.floor(total / 60) % 60, hours = Math.floor(total / 3600);
    return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}`
                 : `${minutes}:${pad(total % 60)}`;
  }

  const SETTINGS_VERSION = 4;

  // `powerDbm: null` means "the operator has never chosen", which is what lets
  // the 1 % rule apply exactly once. Version 1 wrote 30 into storage as its
  // default, so a saved number there proves nothing -- hence the migration below
  // throws it away rather than mistaking a default for a decision.
  // `timetable` is a list of UTC change points. Each ordered band sequence stays
  // active until the next change and the final one wraps through midnight.
  const settingsDefaults = () => ({
    version: SETTINGS_VERSION, powerDbm: null, modelOverride: "",
    powerReferences: {}, timetable: [],
  });

  let settings = settingsDefaults();

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (raw && typeof raw === "object") {
        settings = {...settingsDefaults(), ...raw};
        if (!Number.isFinite(Number(raw.version)) && (raw.slots || raw.rotation))
          settings.version = Array.isArray(raw.rotation) ? 3 : 1;
      }
    } catch (_error) { settings = settingsDefaults(); }
    migrateSettings();
    if (settings.powerDbm !== null && !WsprCore.POWER_LEVELS.includes(settings.powerDbm))
      settings.powerDbm = null;
    const knownBands = new Set(WsprCore.PRESETS.map(preset => preset.band));
    const bySlot = new Map();
    for (const entry of Array.isArray(settings.timetable) ? settings.timetable : []) {
      const slot = Number(entry && entry.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= WsprCore.SLOTS_PER_DAY) continue;
      const seen = new Set(), bands = [];
      for (const band of Array.isArray(entry.bands) ? entry.bands : []) {
        const name = String(typeof band === "string" ? band : (band && band.band) || "");
        if (!knownBands.has(name) || seen.has(name)) continue;
        seen.add(name); bands.push(name);
      }
      bySlot.set(slot, {slot, bands});
    }
    settings.timetable = [...bySlot.values()].sort((a, b) => a.slot - b.slot);
    if (!settings.powerReferences || typeof settings.powerReferences !== "object")
      settings.powerReferences = {};
  }

  // v1 -> v2. All three dropped values are dropped for the same reason: they
  // cannot be converted honestly. `txGain` now lives in the shared blob, the
  // scalar reference has no band and so cannot be filed under one, and a saved
  // `powerDbm` cannot be told apart from v1's own default.
  //
  // v2 -> v3 introduced the band x half-hour matrix. v4 deliberately replaces
  // both older shapes with ordered change points; the core owns that one-time
  // conversion so the on-air scheduler and migration cannot disagree.
  function migrateSettings() {
    if (Number(settings.version) >= SETTINGS_VERSION) return;
    if (Number(settings.version) < 2) {
      delete settings.txGain;
      delete settings.powerReferenceRaw;
      settings.powerDbm = null;
      settings.powerReferences = {};
    }
    const legacy = {...settings};
    delete legacy.timetable;
    settings.timetable = WsprCore.timetableEntries(legacy)
      .map(entry => ({slot: entry.slot, bands: entry.bands.map(band => band.band)}));
    delete settings.slots;
    delete settings.rotation;
    delete settings.periodFrames;
    delete settings.randomizeFrame;
    settings.version = SETTINGS_VERSION;
    saveSettings();
  }
  // The beacon's settings are a fact about the station -- its power, its band
  // schedule, its per-band references -- not about this browser, so they go to
  // the interface as well. Debounced: the panel saves on every keystroke.
  const pushStationProfile = window.StationProfile
    ? window.StationProfile.writer("wspr", 1500) : null;

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
    catch (_error) { /* private mode: the page still works for this session */ }
    if (pushStationProfile) pushStationProfile(settings);
  }

  // The station overrules this browser, except for the clock correction, which
  // is a property of this computer. An empty station is left alone -- promoting
  // is the operator's decision, made in the JS8 settings panel.
  function adoptStationProfile() {
    if (!window.StationProfile) return Promise.resolve(false);
    return window.StationProfile.read().then(station => {
      const merged = window.StationProfile.forBrowser(station, "wspr", settings);
      if (!merged) return false;
      settings = {...settingsDefaults(), ...merged};
      migrateSettings();
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_e) {}
      return true;
    }).catch(() => false);
  }

  // ---- single-operator lock -------------------------------------------------
  //
  // Mirrors the JS8LAN implementation rather than importing it, because that code
  // lives inside data.js rather than in a module. The firmware is the authority;
  // this only renders what it decides. The BroadcastChannel probe exists because
  // a duplicated tab shares sessionStorage, so the firmware cannot tell the two
  // apart and would grant both.

  const SESSION_TOKEN_KEY = "js8lan.session.token.v1";
  let sessionTokenCache = null, sessionHeld = false, sessionConfirmed = false;
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

  // Only an explicit 409 is a refusal: a firmware without the lock, or a fetch
  // that simply failed, must not leave the operator staring at a panel.
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

  function markHeld(confirmed) {
    sessionHeld = true; sessionConfirmed = confirmed; sessionSince = Date.now();
    if (sessionRetryTimer) { clearTimeout(sessionRetryTimer); sessionRetryTimer = null; }
    dom.sessionBusy.hidden = true;
    // The audio socket belongs to the page, not to a transmission. Opening it
    // here rather than at START is what keeps `hello` from racing the first
    // tx.prepare, and it is what gives the waterfall something to draw.
    openSession();
    render();
  }

  function loseSession(info) {
    stopBeacon("session lost");
    closeSession();
    sessionHeld = false; sessionConfirmed = false;
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
    const claim = await sessionPost("/js8/session/claim", {force, role: "wspr"});
    if (!claim.granted) { loseSession(claim); return; }
    markHeld(true);
  }

  setInterval(async () => {
    if (!sessionHeld) return;
    const ping = await sessionPost("/js8/session/ping", {role: "wspr"});
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

  // ---- radio state ----------------------------------------------------------

  // In-flight guard: at 1 Hz a stalled poll must skip ticks, not stack a new
  // hung request each second on top of the last one.
  let statePollInFlight = false;
  async function pollState() {
    if (statePollInFlight) return;
    statePollInFlight = true;
    try {
      const response = await fetch(RADIO_STATE_URL, {cache: "no-store", signal: fetchDeadline()});
      if (!response.ok) throw new Error(String(response.status));
      const json = await response.json();
      noteLinkState(json);
      state.radio = {
        connected: Boolean(json.connected),
        transceiverType: String(json.transceiverType || ""),
        radioName: String(json.radioName || ""),
        radioNameSeen: json.radioNameSeen === true,
        // fall through to setReportedModel below -- the guide follows the radio
        mode: String(json.mode || ""),
        frequency: Number(json.frequency) || 0,
        tx: Boolean(json.tx),
        powerMeterRaw: Number(json.powerMeterRaw) || 0,
        swr: Number(json.swr) || 0,
        rfPower: Number(json.rfPower) || 0,
        rfPowerSeen: json.rfPowerSeen === true,
        supplyVolts: Number(json.supplyVolts) || 0,
        lanDrops: Number(json.lanDrops) || 0,
        lanStalls: Number(json.lanStalls) || 0,
        lanFilled: Number(json.lanFilled) || 0,
        // Whether this hardware drives band-decoder outputs. The calibration plan
        // says so in the antenna question: on a station where the outputs switch
        // antennas, "the decoder follows the dial" is half the answer already.
        bdSupported: json.bdSupported === true,
      };
    } catch (_error) {
      // Deliberately does NOT go through noteLinkState(): a fetch that never
      // arrived says nothing about the radio, and treating it as a link drop
      // would re-arm the power write on every WiFi flutter.
      state.radio.connected = false;
    } finally { statePollInFlight = false; }
    noteKnob();
    maybeRekeyGainModel();
    render();
  }

  // Item 1 follow-up: fires the rekeyModel() repair once the live model is
  // actually known (radioNameSeen catches up after boot/a LAN-slot swap) --
  // idempotent after that, but the flag skips the store fetch on every
  // subsequent 1 Hz poll once it has run.
  let modelRekeyAttempted = false;
  function maybeRekeyGainModel() {
    if (modelRekeyAttempted) return;
    const toModel = liveRadioModel();
    if (!settings.modelOverride || !toModel) return;
    modelRekeyAttempted = true;
    gainStore.rekeyModel(settings.modelOverride, toModel)
      .then(changed => { if (changed && gainPlan) gainPlan.reload(); })
      .catch(() => {});
  }

  const isLan = () => state.radio.transceiverType === "ICOM-LAN";

  // See IcomModels.liveRadioModel()'s own comment for why this guard exists
  // (the ~1s stale-radio-name window on a live LAN-slot model swap, confirmed
  // against both an IC-705 and an IC-7610). Shared with data.js/mercury.js so
  // the fix cannot regress in one page while staying fixed in the others.
  const liveRadioModel = () => IcomModels.liveRadioModel(state.radio);

  // Full power of the transmitter on the CI-V percentage scale. Order matters:
  // an explicit override wins, then what the radio itself reported, and an
  // unknown model yields null so the UI refuses to start rather than guessing a
  // curve that could be a factor of ten out.
  function fullPower() {
    if (settings.modelOverride)
      return {watts: WsprCore.fullPowerWatts(settings.modelOverride), source: "manual override"};
    const model = liveRadioModel();
    const reported = WsprCore.fullPowerWatts(model);
    if (reported) return {watts: reported, source: `reported as ${model}`};
    return {watts: null, source: model
      ? `unknown model ${model}` : "radio has not reported a model yet"};
  }

  // What this radio can be set to, cheapest first. The floor is its own
  // one-percent step, so the list is seven levels long on a 10 W IC-705 and
  // four on a 100 W radio -- the shorter list is the point, not a bug: the
  // levels it drops are ones the transmitter cannot distinguish from their
  // neighbours, and announcing one of those would put a power on wsprnet that
  // never left the antenna.
  const offeredLevels = () =>
    WsprCore.offeredPowerLevels(fullPower().watts, POWER_CEILING_W);

  // A beacon's opening bid is one percent of the transmitter, not a fixed dBm:
  // 30 dBm is a tenth of an IC-705 but a hundredth of an IC-7610, and only one
  // of those is a sensible place to start. Now that the offered range begins at
  // one percent, that bid simply IS the bottom of the list -- one rule instead
  // of two that would have to be kept agreeing.
  function defaultPowerDbm(fullWatts) {
    const levels = WsprCore.offeredPowerLevels(fullWatts, POWER_CEILING_W);
    return levels.length ? levels[0] : null;
  }

  // The target: what the menu shows and what the automation and SET write.
  //
  // A stored choice is honoured only while the connected radio can actually
  // produce it. It is deliberately not erased when it cannot -- swapping back
  // to the radio it was chosen on restores it -- and in the meantime the list
  // follows the radio, which is the whole point of deriving it per model.
  function targetDbm() {
    const levels = offeredLevels();
    if (!levels.length) return null;
    if (settings.powerDbm !== null && levels.includes(settings.powerDbm))
      return settings.powerDbm;
    return levels[0];
  }

  // Do the radio and the target agree? Compared in whole percent, exactly,
  // because that is the resolution the radio has. The raw 0..255 scale carries
  // 2.55 units per percent, so the +-2 this used to allow was wide enough to
  // call 1 % and 2 % the same reading -- and at the bottom of the offered range
  // those two are 3 dB apart. The rounded dBm is no better in the other
  // direction: it would call it a match with the radio half a decibel away.
  const radioPercent = () => WsprCore.civPercent(state.radio.rfPower);

  function powerMismatch() {
    const full = fullPower().watts;
    const target = targetDbm();
    if (!full || target === null || !isLan() || !state.radio.connected) return null;
    let level;
    try { level = WsprCore.powerCommand(target, full).level; }
    catch (_error) { return null; }
    // An unread level cannot agree with anything. Reporting a match here would
    // be the worst outcome available: the fabricated 205 happening to land
    // within tolerance of the target would tell the operator the radio is
    // already set when nobody has ever asked it.
    if (state.radio.rfPowerSeen !== true) return {target, level};
    return radioPercent() === WsprCore.civPercent(level) ? null : {target, level};
  }

  // ---- TUNE power references ------------------------------------------------
  //
  // One reference per band and target level, not one for the whole beacon. The
  // forward-power reading depends on the band, the antenna and the tuner, and a
  // schedule spanning three bands would otherwise mark two of them unconfirmed
  // for the rest of the night on the strength of a tune on the third.
  const referenceKey = (band, dbm) => `${band || "?"}|${dbm}`;

  function referenceFor(band, dbm) {
    const entry = settings.powerReferences[referenceKey(band, dbm)];
    return entry && entry.raw > 0 ? entry.raw : 0;
  }

  function storeReference(band, dbm, raw) {
    settings.powerReferences[referenceKey(band, dbm)] =
      {raw, dbm, at: Date.now(), band: band || ""};
    saveSettings();
  }

  // ---- CAT ------------------------------------------------------------------

  async function command(payload) {
    const response = await fetch(RADIO_CMD_URL, {method: "POST", signal: fetchDeadline(),
      headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
    if (!response.ok) throw new Error(`${payload.type} failed (${response.status})`);
    return true;
  }

  // The same POST, but answering with what the firmware said. civ.read replies with
  // the sequence number the caller has to watch for, and a read that threw away the
  // body could not tell a fresh answer from a repeat of the last one.
  async function commandJson(payload) {
    const response = await fetch(RADIO_CMD_URL, {method: "POST", signal: fetchDeadline(),
      headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
    if (!response.ok) throw new Error(`${payload.type} failed (${response.status})`);
    return response.json().catch(() => ({ok: true}));
  }

  // setMode cannot express USB-D, so the data-mode bit goes through the generic
  // civ.raw endpoint exactly as data.js does it: 26 00 <USB> <DATA on> <FILx>.
  async function ensureUsbDataMode() {
    if (state.radio.mode === "USB-D") return;
    const filter = [1, 2, 3].includes(Number(state.radio.filter)) ? Number(state.radio.filter) : 1;
    await command({type: "civ.raw", data: "26000101" + String(filter).padStart(2, "0")});
  }

  // Waits for /state to actually reflect a change. Everything on this page that
  // touches the radio verifies rather than assumes, because a transmission sent
  // on the wrong band or at the wrong power is worse than a missed slot.
  function waitForState(test, timeoutMs = 5000, pollMs = 100) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = async () => {
        await pollState();
        if (test(state.radio)) return resolve(true);
        if (Date.now() - started > timeoutMs) return reject(new Error("the radio did not confirm the change"));
        setTimeout(tick, pollMs);
      };
      tick();
    });
  }

  // Band and mode only. Power is deliberately NOT written here: what the message
  // reports is derived from what the radio says it is set to, so a write squeezed
  // in seconds before the slot would only widen the window in which the two can
  // disagree. applyAutoPower() settles the level on load and after a link return,
  // when there is time to confirm the readback.
  async function tuneRadio(slot) {
    // `state.radio.tx` comes off the 1 Hz /state poll, so it can still read
    // "keyed" a second after the PTT dropped. Between two back-to-back frames
    // there are only nine seconds, and throwing one of them away on a stale flag
    // would book a missed slot for a radio that was already free -- so confirm
    // rather than trust.
    // tx-drained is the firmware's definitive PTT-OFF acknowledgement. It is
    // newer than the 1 Hz /state snapshot, so do not spend the short inter-frame
    // gap waiting for that stale snapshot to catch up.
    const transmitterFree = tx && !tx.ptt && tx.state === "completed";
    if (state.radio.tx && !transmitterFree) await pollState();
    if (state.radio.tx && !transmitterFree) throw new Error("the radio is transmitting");
    const started = Date.now();
    if (state.radio.frequency !== slot.hz) {
      await command({type: "setFrequency", frequency: String(slot.hz)});
      // The band-decoder outputs follow the dial, and the relays they drive need
      // to have settled before the carrier arrives. The settle interval starts
      // with the CAT write and overlaps its readback instead of being paid after.
      await Promise.all([
        waitForState(radio => radio.frequency === slot.hz),
        new Promise(resolve => setTimeout(resolve, BAND_SETTLE_MS)),
      ]);
      state.lastRetuneMs = Date.now() - started;
    }
    if (state.radio.mode !== "USB-D") {
      await ensureUsbDataMode();
      await waitForState(radio => radio.mode === "USB-D");
    }
  }

  // What the radio is actually set to, and the legal WSPR level that reports it
  // most honestly. rfPower is the 0..255 CI-V level, so the model's full-scale
  // figure is what turns it into watts. The rounding error is surfaced rather
  // than hidden: WSPR levels are 3 dB apart and everyone's propagation data
  // depends on this number being close to true.
  function radioPower() {
    const full = fullPower().watts;
    if (!full) return {watts: null, dbm: null, errorDb: 0};
    // Until the radio has answered 14 0A, rfPower is the firmware's fabricated
    // default -- 205, which on an IC-705 reads as a confident and entirely
    // invented 8.00 W. That number would go into the WSPR message and from
    // there into everyone else's propagation data, so refuse it.
    if (state.radio.rfPowerSeen !== true) return {watts: null, dbm: null, errorDb: 0};
    const watts = full * state.radio.rfPower / 255;
    const exact = WsprCore.wattsToDbm(watts);
    let dbm = WsprCore.POWER_LEVELS[0];
    for (const level of WsprCore.POWER_LEVELS)
      if (Math.abs(level - exact) < Math.abs(dbm - exact)) dbm = level;
    return {watts, dbm, errorDb: dbm - exact};
  }

  // ---- manual band choice ---------------------------------------------------
  //
  // The dial menu from the JS8Call page, with WSPR frequencies. It opens at any
  // time, but the presets only act while the beacon is stopped: during a run the
  // schedule tunes the radio a few seconds before every slot, so a manual choice
  // would be silently undone and the operator left wondering.
  const beaconStopped = () => state.beacon === "stopped";

  function renderFrequencyMenu() {
    const selected = state.pendingFrequency || state.radio.frequency;
    const locked = !beaconStopped();
    dom.frequencyMenu.innerHTML =
      `<header><strong>WSPR dial frequencies</strong><small>${locked
        ? "the schedule is driving the radio" : "choose a band to tune the TRX"}</small>` +
      `<span class="tt-actions"><button class="tt-clear" type="button" data-menu-close` +
      ` title="Close">CLOSE</button></span></header>` +
      `<div class="frequency-presets">${WsprCore.PRESETS.map(preset =>
        `<button class="frequency-preset${preset.hz === selected ? " current" : ""}"` +
        ` type="button" data-frequency="${preset.hz}"${locked ? " disabled" : ""}>` +
        `<strong>${preset.band}</strong><span>${(preset.hz / 1e6).toFixed(4)} MHz</span></button>`).join("")}</div>` +
      `<footer class="${!locked && offDialFrequency() ? "off-dial" : ""}">${locked
        ? "Stop the beacon to tune by hand; while it runs the schedule sets the band before each slot."
        : offDialFrequency()
          ? "The radio is not on a WSPR dial frequency, so START stays disabled until a band is chosen here. TUNE still works where the radio is."
          : "Standard WSPR dial frequencies. The beacon sets USB-D itself."}</footer>`;
  }

  async function requestFrequency(hz) {
    closeFrequencyMenu();
    state.pendingFrequency = hz;
    render();
    try {
      await command({type: "setFrequency", frequency: String(hz)});
      await waitForState(radio => radio.frequency === hz);
      // Tuning by hand also prepares the radio, exactly as the JS8Call page does:
      // a WSPR dial frequency in the wrong mode is not a usable state.
      await ensureUsbDataMode();
      state.lastError = "";
    } catch (error) {
      state.lastError = String(error.message || error);
    }
    state.pendingFrequency = 0;
    render();
  }

  // ---- setup help -----------------------------------------------------------
  //
  // A radio that is neither in a data mode nor anywhere near a WSPR dial
  // frequency has not been set up for this page at all -- most likely it is
  // still where the operator left it after voice or JS8. Rather than refuse
  // quietly at the first slot, open the setup card that says what to change.
  //
  // Both conditions have to hold: USB-D on a random frequency is a legitimate
  // mid-tune state, and so is sitting on a WSPR frequency in USB while the
  // beacon is about to set the mode itself.
  //
  // A preset that is still being written counts as arrived: pendingFrequency is
  // only ever one of the presets, and flagging the second between the CAT write
  // and its readback would blink the dial red every time a band is chosen.
  function offDialFrequency() {
    const hz = state.pendingFrequency || state.radio.frequency;
    if (!hz) return false;
    return !WsprCore.PRESETS.some(preset => Math.abs(preset.hz - hz) <= DIAL_TOLERANCE_HZ);
  }

  function maybeOfferSetupHelp() {
    const unusable = state.radio.connected && Boolean(state.radio.mode) &&
                     state.radio.mode !== "USB-D" && offDialFrequency();
    // Latched: it opens on the transition into that state, not on every poll,
    // so dismissing it does not start a fight with the one-second poller.
    if (unusable && !state.helpShownForSetup) openSetupHelp("mode");
    state.helpShownForSetup = unusable;
  }

  function openSetupHelp(reason = "manual") {
    dom.trxHelpModeWarning.hidden = reason !== "mode";
    if (dom.trxHelpDialog.open) return;
    if (typeof dom.trxHelpDialog.showModal === "function") dom.trxHelpDialog.showModal();
    else dom.trxHelpDialog.setAttribute("open", "");
  }

  // ---- writing power --------------------------------------------------------
  //
  // This page used to write power only when SET was pressed, and said so in
  // three places. It now also writes it on load and whenever the radio's link
  // comes back, so an unattended beacon keys at the level left in the menu
  // rather than at whatever the radio happens to remember after a power cycle.
  //
  // Three rules keep that from becoming a page that fights its own operator:
  //
  //   * The knob wins. `appliedPercent` is what this page last wrote and saw
  //     confirmed; a different reading while the link is up can only be a hand
  //     on the front panel, and that stands the automation down until the
  //     operator makes a fresh choice.
  //   * A transmission is never interrupted. LAN drops here happen under audio
  //     load -- that is, mid-carrier -- so the write waits for the PTT rather
  //     than moving the amplitude half way through a frame that has already
  //     announced its power.
  //   * A failed /state fetch is not a reconnect. pollState() reports
  //     `connected: false` when the fetch itself fails, which on this setup is
  //     usually a WiFi flutter the radio knew nothing about.
  let appliedPercent = null;     // last percent written AND confirmed by readback
  let knobTouched = false;       // operator moved it; automation stands down
  let autoPowerArmed = true;     // a write is owed: page load, or the link returned
  let autoPowerBusy = false, autoPowerRetryMs = 0;
  let linkWasUp = false, lastLanDrops = -1;

  // Called only for a reply that actually arrived, so the radio's link is what
  // is being judged rather than the browser's.
  function noteLinkState(json) {
    const up = Boolean(json.connected);
    const drops = Number(json.lanDrops) || 0;
    if ((up && !linkWasUp) || (lastLanDrops >= 0 && drops > lastLanDrops))
      autoPowerArmed = true;
    linkWasUp = up;
    lastLanDrops = drops;
  }

  // Only meaningful when no write is owed: right after the link returns the
  // reading disagrees precisely because the radio may have forgotten, which is
  // the case the automation exists for -- not evidence of a hand on the knob.
  function noteKnob() {
    if (autoPowerArmed || appliedPercent === null) return;
    if (!state.radio.connected || state.radio.rfPowerSeen !== true) return;
    if (radioPercent() !== appliedPercent) knobTouched = true;
  }

  async function applyAutoPower() {
    if (autoPowerBusy || !autoPowerArmed || knobTouched) return;
    // A calibration measures the radio as the operator set it up -- including a
    // JS8 power level, which is the whole reason this page can calibrate for the
    // other mode at all. Writing WSPR's own target here would file the result
    // under a percentage the radio was never on.
    if (calArmed || state.calRunning || state.planRunning) return;
    if (Date.now() < autoPowerRetryMs) return;
    // The same gate as SET. The TX pledge is deliberately not part of it:
    // writing power is not transmitting, and this write moves towards the safe
    // end of the scale rather than away from it.
    if (!isLan() || !state.radio.connected || !sessionHeld || !sessionConfirmed) return;
    if (state.radio.tx || (tx && tx.ptt)) return;
    const full = fullPower().watts;
    const target = targetDbm();
    if (!full || target === null) return;
    let power;
    try { power = WsprCore.powerCommand(target, full); }
    catch (_error) { return; }
    const wanted = WsprCore.civPercent(power.level);
    // Already there. Record it anyway: the knob detector needs a baseline, and
    // it should not cost a CI-V round trip to establish one.
    if (state.radio.rfPowerSeen === true && radioPercent() === wanted) {
      appliedPercent = wanted; autoPowerArmed = false; return;
    }
    autoPowerBusy = true;
    try {
      await command({type: "civ.raw", data: power.data});
      await waitForState(radio => WsprCore.civPercent(radio.rfPower) === wanted);
      appliedPercent = wanted; autoPowerArmed = false;
      state.lastError = "";
    } catch (error) {
      // Stays armed. Backing off rather than retrying every tick keeps a radio
      // that refuses the write from turning into a CI-V flood.
      autoPowerRetryMs = Date.now() + 5000;
      state.lastError = String(error.message || error);
    }
    autoPowerBusy = false;
    render();
  }

  // Did the radio take the level? Asked actively, judged on both units, and when it
  // does not agree it says WHAT the radio reports -- "the radio did not confirm the
  // power" alone sends the next investigation nowhere.
  async function confirmPercent(percent, level, timeoutMs = 9000) {
    const started = Date.now();
    let seen = -1, seenPercent = -1;
    while (Date.now() - started < timeoutMs) {
      // 14 0A with no payload is a READ request; the reply lands in the same state
      // field the poll rotation fills.
      try { await command({type: "civ.raw", data: "140A"}); } catch (_error) {}
      await new Promise(resolve => setTimeout(resolve, 300));
      await pollState();
      if (state.radio.rfPowerSeen !== true) continue;
      seen = state.radio.rfPower;
      seenPercent = WsprCore.civPercent(seen);
      // Either unit agreeing is agreement: the radio quantises to whole percent, so
      // the raw value it stores can differ from the one written while meaning the
      // same setting.
      if (seenPercent === percent || seen === level) return true;
    }
    throw new Error(`the radio did not confirm the power: asked for ${percent} % ` +
      `(level ${level})` + (seen < 0 ? ", and it never reported a power setting"
        : `, it reports ${seenPercent} % (level ${seen})`));
  }

  // The operator's own write. Still the only thing that turns the proposal into
  // a stored choice -- the automation applies a target, it does not decide one.
  async function setRadioPower() {
    if (!isLan() || !state.radio.connected || !sessionHeld) {
      state.lastError = "the radio is not reachable"; render(); return;
    }
    const target = targetDbm();
    if (target === null) {
      state.lastError = "the radio model is unknown"; render(); return;
    }
    dom.powerSet.disabled = true;
    try {
      const power = WsprCore.powerCommand(target, fullPower().watts);
      await command({type: "civ.raw", data: power.data});
      // Confirmed in whole percent: the radio quantises to its own step, so
      // demanding an exact echo of the raw level would time out on a write that
      // in fact landed exactly where it was asked to.
      const wanted = WsprCore.civPercent(power.level);
      await waitForState(radio => WsprCore.civPercent(radio.rfPower) === wanted);
      // Pressing SET is the decision the 1 % proposal was waiting for, so the
      // level stops being a suggestion and starts being the operator's choice --
      // and it re-arms an automation that a turn of the knob had stood down.
      settings.powerDbm = target; saveSettings();
      appliedPercent = wanted; knobTouched = false; autoPowerArmed = false;
      state.lastError = "";
    } catch (error) {
      state.lastError = String(error.message || error);
    }
    dom.powerSet.disabled = false;
    render();
  }

  // ---- schedule -------------------------------------------------------------

  const slotIndexNow = () => WsprCore.slotIndexAt(utcNow());
  const slotLabel = WsprCore.slotLabel;

  // Which frame the beacon keys in is arithmetic three views have to agree on, so
  // it lives in wspr-core and nothing here re-derives it: the countdown below, the
  // preview strip in the panel and the activity block's future all ask the same
  // function. A preview with its own copy of the rule is a preview that can lie.
  //
  // Everything that asks goes through scheduleView(), never `settings` directly:
  // the beacon may be running at a reduced pace after three late band changes,
  // and a preview that did not know about it would promise frames the beacon has
  // already decided to skip.
  const scheduleView = () => (state.spaceBandChanges
    ? {...settings, spaceBandChanges: true} : settings);
  const nextTransmission = (fromUtcMs = utcNow()) =>
    WsprCore.nextTransmission(fromUtcMs, scheduleView());

  // Editing state for the panel. `editingSlot` identifies a change point, not
  // every half hour it covers; the sequence lasts until the next change.
  let editingSlot = null;
  let clickOrigin = {timetable: false, popover: false};

  // One undo level is enough for this small editor and protects Clear/remove.
  let scheduleUndo = null;

  const timetableEntry = slot =>
    settings.timetable.find(entry => entry.slot === Number(slot)) || null;
  const bandsAt = index => WsprCore.sequenceAt(index, settings).map(band => band.band);
  const scheduledSlots = () =>
    Array.from({length: WsprCore.SLOTS_PER_DAY}, (_, index) => index)
      .filter(index => bandsAt(index).length).length;

  function snapshotSchedule() {
    scheduleUndo = JSON.stringify(settings.timetable);
  }

  function sortTimetable() {
    settings.timetable.sort((a, b) => a.slot - b.slot);
  }

  function addChange(preferredSlot = slotIndexNow()) {
    let slot = Number(preferredSlot);
    for (let tries = 0; tries < WsprCore.SLOTS_PER_DAY && timetableEntry(slot); tries++)
      slot = (slot + 1) % WsprCore.SLOTS_PER_DAY;
    if (timetableEntry(slot)) return;
    snapshotSchedule();
    settings.timetable.push({slot, bands: []});
    sortTimetable();
    editingSlot = slot;
    saveSettings();
  }

  function removeChange(slot) {
    if (!timetableEntry(slot)) return;
    snapshotSchedule();
    settings.timetable = settings.timetable.filter(entry => entry.slot !== Number(slot));
    if (editingSlot === Number(slot)) editingSlot = null;
    saveSettings();
  }

  function undoSchedule() {
    if (scheduleUndo === null) return;
    try { settings.timetable = JSON.parse(scheduleUndo); } catch (_error) { return; }
    scheduleUndo = null;
    saveSettings(); closeSlotPopover(); renderSchedule(); render();
  }

  function rangeEnd(index) {
    if (!settings.timetable.length) return 0;
    return settings.timetable[(index + 1) % settings.timetable.length].slot;
  }

  // The whole day is described by its change points. Two rows express the common
  // day/night example instead of painting six bands through 48 matrix cells.
  function renderSchedule() {
    sortTimetable();
    const now = slotIndexNow();
    const activeEntry = settings.timetable.length
      ? settings.timetable.filter(entry => entry.slot <= now).pop() ||
        settings.timetable[settings.timetable.length - 1]
      : null;
    dom.scheduleList.innerHTML = settings.timetable.length
      ? settings.timetable.map((entry, index) => {
          const end = rangeEnd(index), active = entry === activeEntry;
          const sequence = entry.bands.length
            ? entry.bands.map((band, order) =>
                `<span class="tt-sequence-band">${order + 1}<b>${band}</b></span>`).join("")
            : `<span class="tt-silent">silent</span>`;
          const range = settings.timetable.length === 1
            ? `from ${slotLabel(entry.slot)} · all day`
            : `${slotLabel(entry.slot)}–${slotLabel(end)}`;
          return `<button class="tt-schedule-row${active ? " now" : ""}" type="button"` +
                 ` data-change-slot="${entry.slot}" title="Edit change at ${slotLabel(entry.slot)} UTC">` +
                 `<span class="tt-range">${range}</span>` +
                 `<span class="tt-sequence">${sequence}</span><span class="chevron">›</span></button>`;
        }).join("")
      : `<p class="tt-empty">No sequence yet. Add the first change and choose bands in on-air order.</p>`;
    renderPreview();
    renderActivity();
    dom.scheduleUndo.hidden = scheduleUndo === null;
  }

  // ---- what the schedule is going to do -------------------------------------
  //
  // The grid says which band a half hour uses; it cannot say which two-minute
  // frame inside it will key, because that comes out of the period and the
  // randomised offset. That missing minute is the whole reason the schedule feels
  // unpredictable, so it gets drawn: the activity block's raster, one row per
  // hour and thirty frames across, hollow because it has not happened yet.

  const PREVIEW_HOURS = 6, FRAMES_PER_HOUR = 30, HOUR_MS = 3600000;

  function renderPreview() {
    if (dom.freqTimetablePanel.hidden) return;
    const now = utcNow();
    const firstHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const until = firstHour + PREVIEW_HOURS * HOUR_MS;
    const planned = WsprCore.plannedFrames(now, (until - now) / HOUR_MS, scheduleView());

    let html = "", edgeDrawn = false, marked = 0;
    for (let row = 0; row < PREVIEW_HOURS; row++) {
      const rowStart = firstHour + row * HOUR_MS;
      html += `<div class="tt-preview-row">` +
              `<b>${new Date(rowStart).toISOString().slice(11, 13)}</b>`;
      for (let frame = 0; frame < FRAMES_PER_HOUR; frame++) {
        const frameUtcMs = rowStart + frame * WsprCore.FRAME_MS + 1000;
        const past = frameUtcMs + WsprCore.FRAME_MS <= now;
        const edge = !past && !edgeDrawn;
        if (edge) edgeDrawn = true;
        const keys = past ? null : WsprCore.frameTransmission(frameUtcMs, scheduleView());
        if (keys) marked++;
        html += `<i class="tt-frame${keys ? " planned" : ""}${past ? " past" : ""}` +
                `${edge ? " edge" : ""}" title="${new Date(frameUtcMs).toISOString().slice(11, 16)}` +
                ` UTC${keys ? ` — ${keys.slot.band}` : ""}"></i>`;
      }
      html += "</div>";
    }
    dom.previewGrid.innerHTML = html;

    // A plan the beacon cannot currently carry out is still worth showing -- it is
    // usually being built while the beacon is stopped -- but it must not be dressed
    // up as what is going to happen.
    const blocked = state.beacon === "stopped" ? "beacon stopped" : blockingReason();
    dom.previewTitle.textContent = blocked
      ? `would transmit · next ${PREVIEW_HOURS} h — ${blocked}`
      : `planned · next ${PREVIEW_HOURS} h`;
    dom.previewTitle.classList.toggle("hypothetical", Boolean(blocked));
    // Counted from the cells that were actually drawn, not from `planned`. A frame
    // already running is marked in the strip but is no longer "next", so the two
    // differ by one exactly when the beacon is mid-transmission -- and a head that
    // says 34 above 35 hollow cells is the kind of detail that costs trust.
    dom.previewCount.textContent = `${marked} TX`;
    dom.previewNext.textContent = planned.length
      ? `next ${planned.slice(0, 3).map(frame =>
          `${new Date(frame.slotUtcMs).toISOString().slice(11, 16)} ${frame.slot.band}`)
          .join(" · ")}`
      : scheduledSlots()
        ? `nothing in the next ${PREVIEW_HOURS} hours`
        : "the schedule is empty — add a change and choose its band sequence";
  }

  // The topbar button carries the two things worth glancing at: which band the
  // beacon is on, and how long until it speaks again. There is no ON/OFF switch
  // as there is on JS8Call -- here START runs the schedule and the schedule is
  // the whole programme.
  function renderTimetableButton() {
    // The band shown is the one the countdown belongs to -- the NEXT
    // transmission's. Showing the current half hour's band next to a countdown
    // aimed at a different slot said "20m" while it was about to key on 40.
    const upcoming = nextTransmission();
    if (!scheduledSlots()) {
      dom.freqTimetableValue.textContent = "NO SCHEDULE";
    } else if (upcoming) {
      const at = state.pendingSlotUtcMs || upcoming.slotUtcMs;
      dom.freqTimetableValue.textContent =
        `${upcoming.slot.band} · ${formatDuration((at - utcNow()) / 1000)}`;
    } else {
      dom.freqTimetableValue.textContent = "SILENT";
    }
    const active = Boolean(upcoming) && state.beacon !== "stopped";
    dom.freqTimetableButton.classList.toggle("active", active);
    dom.freqTimetablePanel.classList.toggle("active", active);
  }

  function openSlotPopover(index) {
    editingSlot = index;
    renderSlotPopover();
    dom.schedulePopover.hidden = false;
    positionSlotPopover();
  }

  function renderSlotPopover() {
    if (editingSlot === null) return;
    const entry = timetableEntry(editingSlot);
    if (!entry) return closeSlotPopover();
    const timeOptions = Array.from({length: WsprCore.SLOTS_PER_DAY}, (_, slot) =>
      `<option value="${slot}"${slot === entry.slot ? " selected" : ""}` +
      `${timetableEntry(slot) && slot !== entry.slot ? " disabled" : ""}>` +
      `${slotLabel(slot)}</option>`).join("");
    const selected = entry.bands.map((band, index) =>
      `<span class="tt-sequence-edit"><b>${index + 1} · ${band}</b>` +
      `<button type="button" data-move-band="${index}" data-direction="-1"` +
      `${index ? "" : " disabled"} title="Move ${band} earlier">←</button>` +
      `<button type="button" data-move-band="${index}" data-direction="1"` +
      `${index + 1 < entry.bands.length ? "" : " disabled"} title="Move ${band} later">→</button>` +
      `<button type="button" data-remove-band="${index}" title="Remove ${band}">×</button></span>`
    ).join("");
    const spare = WsprCore.PRESETS.filter(preset => !entry.bands.includes(preset.band));
    dom.schedulePopover.innerHTML =
      `<header><strong>Sequence change</strong><small>UTC, repeats daily</small></header>` +
      `<label class="tt-change-time">from <select data-change-time>${timeOptions}</select></label>` +
      `<div class="tt-sequence-editor">${selected ||
        `<span class="tt-silent">silent until the next change</span>`}</div>` +
      `<div class="tt-band-picker"><span>add next</span>${spare.map(preset =>
        `<button class="tt-band" type="button" data-add-band="${preset.band}">${preset.band}</button>`
      ).join("")}</div>` +
      `<small class="tt-gap-note">Each band may occur at most once per 6 minutes; ` +
      `with fewer than 3 bands the missing positions stay silent.</small>` +
      `<button class="tt-clear-slot" type="button" data-remove-change>` +
      `Remove this change</button>`;
  }

  // Re-queried rather than remembered: renderSchedule() rewrites the grid, so the
  // element a caller could hand over here is detached by the time it is measured.
  function positionSlotPopover() {
    const cell = dom.scheduleList.querySelector(`[data-change-slot="${editingSlot}"]`);
    if (!cell) return;
    const panelBox = dom.freqTimetablePanel.getBoundingClientRect();
    const cellBox = cell.getBoundingClientRect();
    dom.schedulePopover.style.left =
      `${Math.max(6, Math.min(cellBox.left - panelBox.left, dom.freqTimetablePanel.clientWidth - dom.schedulePopover.offsetWidth - 6))}px`;
    dom.schedulePopover.style.top = `${cellBox.bottom - panelBox.top + 4}px`;
  }

  function closeSlotPopover() {
    dom.schedulePopover.hidden = true;
    editingSlot = null;
  }

  // Closing the panel drops the undo snapshot with it. An UNDO that outlives the
  // editing session it belongs to offers to restore a schedule the operator has
  // stopped thinking about, which is a worse surprise than the one it prevents.
  // Its own function for the same reason closeTimetablePanel() has one: four
  // places closed this menu and each wrote the two statements out again.
  function closeFrequencyMenu() {
    dom.frequencyMenu.hidden = true;
    dom.trxFrequency.setAttribute("aria-expanded", "false");
  }

  function closeTimetablePanel() {
    dom.freqTimetablePanel.hidden = true;
    dom.freqTimetableButton.setAttribute("aria-expanded", "false");
    closeSlotPopover();
    scheduleUndo = null;
    dom.scheduleUndo.hidden = true;
  }

  // ---- AUD1 session ---------------------------------------------------------
  //
  // `onControl` and `bufferedAmount` lived here as a WSPR-only subclass, because
  // Aud1WebSocketSession acts on hello/tx-ready/tx-state/tx-drained/tx-error and
  // passes nothing else on -- while tx-level is what paces the credit loop. Both
  // are now in the shared class: JS8LAN needs the same frames for the ALC gain
  // limiter, and one hook is better than two that can drift.
  let session = null, tx = null, beaconTimer = null, beaconPreparing = false;
  // Kept so the browser harness can make the minute pass on demand; the page
  // itself never touches it after it is armed.
  let identityWatch = null;

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
      .onControl(message => {
        if (tx && !gainCal.running) tx.onControl(message);
        // One socket, two drivers, never at once. Route by which one is running:
        // WsprTx acts on tx-ready/tx-state/tx-error without checking txId, so
        // handing every frame to both would let a calibration's abort fail the
        // beacon's idle driver and vice versa.
        if (gainCal.running) gainCal.onControl(message);
        else if (message && message.type === "tx-level") onBeaconLevel(message);
        render();
      });
    session.onSamples(onSamples);
    session.start();
    // The stream identity comes from the firmware's hello and is re-minted on
    // every reconnect, so WsprTx reads it per transmission rather than being
    // handed a constant it would then send to a radio that rejects it.
    tx = new WsprTx.WsprTx({sink: session, onEvent: onTxEvent, wallNow: utcNow,
                            streamId: () => (session && session.hello
                                             ? session.hello.streamId : 0)});
    return session;
  }

  // ---- waterfall ------------------------------------------------------------
  //
  // Read-only by design. WSPR randomises its offset inside the 200 Hz window for
  // every transmission, so there is nothing here for the operator to choose; the
  // marker reports where the signal went, and the two lines say where the window
  // is. Unlike JS8Call the analyser keeps running through transmission: the radio
  // sends RX audio while keyed, so with the monitor on this is the only sight the
  // operator gets of their own signal.
  const waterfall = new Spectrum.Waterfall({
    canvas: dom.waterfallCanvas, overlay: dom.waterfallOverlay, container: dom.waterfall,
    sampleRate: AUDIO_RATE, lowHz: RX_LOW, highHz: RX_HIGH,
    drawOverlay: (context, view) => drawWindowOverlay(context, view),
  });

  function onSamples(samples) {
    let sum = 0;
    for (const value of samples) sum += value * value;
    state.audioDb = 20 * Math.log10(Math.sqrt(sum / Math.max(1, samples.length)) + 1e-9);
    waterfall.ingest(samples);
  }

  function drawWindowOverlay(context, view) {
    const width = dom.waterfallOverlay.width, height = dom.waterfallOverlay.height;
    const transmitting = Boolean(tx && tx.ptt);

    // The TX banner belongs in the top-left corner: the bottom strip of the
    // canvas is the frequency scale's (it is an overlaid div, not a caption
    // below), and the banner used to overprint its "500 Hz" end. Measured here
    // because the window label below has to know how much room is left.
    const banner = `TX ${state.lastOffsetHz} Hz — not receive audio`;
    context.font = "bold 11px monospace";
    const bannerEnd = transmitting ? 6 + context.measureText(banner).width : 0;

    // The WSPR window: everything outside it is dimmed, so the 200 Hz that
    // matter are obvious inside a 2200 Hz display.
    const left = view.hzToX(WINDOW_LOW_HZ, width), right = view.hzToX(WINDOW_HIGH_HZ, width);
    context.fillStyle = "rgba(2,6,14,.45)";
    context.fillRect(0, 0, left, height);
    context.fillRect(right, 0, width - right, height);
    context.strokeStyle = "rgba(120,220,200,.65)"; context.lineWidth = 1;
    context.setLineDash([3, 3]);
    for (const x of [left, right]) {
      context.beginPath();
      context.moveTo(Math.round(x) + .5, 0); context.lineTo(Math.round(x) + .5, height);
      context.stroke();
    }
    context.setLineDash([]);
    context.fillStyle = "rgba(190,220,214,.72)"; context.font = "bold 9px monospace";
    // Keep the label over its own window edge horizontally; on a narrow canvas
    // that puts it under the TX banner, so it drops a line instead of moving.
    const labelX = Math.max(3, left - 46);
    context.fillText("WSPR 1400–1600", labelX, labelX < bannerEnd + 6 ? 22 : 10);

    // Where this beacon transmits. Dotted while idle because it is then history,
    // solid while keyed because it is then live.
    const marker = view.hzToX(state.lastOffsetHz, width);
    context.strokeStyle = transmitting ? "#ff1838" : "rgba(255,24,56,.55)";
    context.lineWidth = 2;
    context.setLineDash(transmitting ? [] : [4, 4]);
    context.beginPath();
    context.moveTo(marker, 0); context.lineTo(marker, height);
    context.stroke();
    context.setLineDash([]);

    if (transmitting) {
      context.fillStyle = "rgba(255,24,56,.14)";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#ff8fa3"; context.font = "bold 11px monospace";
      context.fillText(banner, 6, 12);
    }
  }

  function closeSession() {
    if (tx) { try { tx.reset(); } catch (_error) {} tx = null; }
    if (session) { session.stop(); session = null; }
  }

  function onTxEvent(event) {
    // The limiter's bracket. Every ending goes through here -- completed,
    // failed, or the deliberate abort a STOP produces -- so the guard cannot be
    // left holding a transmission that finished.
    if (["completed", "failed"].includes(event.type) && beaconGuard.active)
      endBeaconGuard();
    // stopBeacon() aborts the transmission on purpose, which arrives back here as
    // a failure. Without this guard the handler re-arms the beacon and STOP does
    // not stop -- it just skips one slot.
    if (state.beacon === "stopped") return;
    // A tune carrier ends with a deliberate abort, and stopTune() leaves the
    // tuning state before it fires -- so anything still arriving here while
    // tuning is a genuine fault. It must reach the operator; running it through
    // the beacon's failure policy instead would arm a beacon nobody started.
    if (state.beacon === "tuning") {
      if (event.type !== "failed") return;
      if (tuneTimer) { clearTimeout(tuneTimer); tuneTimer = null; }
      state.lastError = event.reason || "the tune carrier failed";
      state.beacon = "stopped";
      render();
      return;
    }
    // No branch for the calibration here on purpose: it drives its own WsprTx
    // instance, so its faults arrive at its own handler and never reach the
    // beacon's failure policy. An earlier version shared this driver, and a fault
    // during a calibration then armed the beacon nobody started, logged a WSPR
    // session that never existed, and put the reason in the beacon banner while
    // the calibration panel stayed empty.
    if (event.type === "completed") {
      state.consecutiveBroken = 0;
      state.beacon = "armed";
      // A transmission that worked is the answer to whatever the last one
      // complained about. The banner describes the beacon NOW; the failure
      // itself is not lost -- ACTIVITY keeps it, with its reason, for 90 days.
      // Leaving it up meant an underrun from hours ago still read as a fault.
      state.lastError = "";
      recordSession({completed: true});
      // A back-to-back frame leaves only 9.4 s after the WSPR audio. Do not add
      // up to one heartbeat (500 ms) before even starting the next band change.
      // `completed` is emitted from tx-drained, i.e. after firmware confirmed PTT
      // down, and WsprTx is already reusable when this callback runs.
      setTimeout(beaconTick, 0);
    } else if (event.type === "failed") {
      recordSession({completed: false, afterKeying: event.afterKeying, reason: event.reason});
      // Only a failure after keying means a truncated signal actually went out;
      // a missed slot before keying is ordinary on this link and must not stop a
      // beacon. Three broken ones in a row is systemic.
      // The newest event wins. The old `lastError || reason` kept whichever
      // message arrived first, which -- together with never clearing on success
      // -- froze the banner on the first fault the beacon ever hit.
      state.lastError = event.reason;
      if (event.afterKeying) {
        state.consecutiveBroken += 1;
        if (state.consecutiveBroken >= 3) {
          state.beacon = "paused";
          state.lastError = `paused after three broken transmissions (${event.reason})`;
        } else state.beacon = "armed";
      } else state.beacon = "armed";
    }
    render();
  }

  // ---- activity log ---------------------------------------------------------

  async function refreshActivity() {
    try {
      state.activity = await WsprLog.all();
      renderActivity();
    } catch (_error) { /* private mode or no IndexedDB: the beacon still runs */ }
  }

  // Every attempt is written, including the ones that never keyed. A beacon that
  // only logs its successes cannot tell the operator that half its slots are
  // being lost.
  async function recordSession({completed, afterKeying, reason}) {
    const session = state.currentSession;
    state.currentSession = null;
    if (!session) return;
    const powerMeterRaw = session.powerSamples.length ? Math.max(...session.powerSamples) : 0;
    const record = {
      slotUtcMs: session.slotUtcMs, band: session.band, dialHz: session.dialHz,
      offsetHz: session.offsetHz, callsign: session.callsign, locator: session.locator,
      dbm: session.dbm, powerMeterRaw,
      ulawSent: tx ? Math.floor(tx.sentSamples / 6) : 0,
      // A missing reference yields 0, which classify() already reads as "do not
      // check". Not checking is honest; accusing a band that was never tuned is
      // not, and that is exactly what one global reference used to do.
      status: WsprLog.classify({completed, afterKeying, powerMeterRaw,
                                referenceRaw: referenceFor(session.band, session.dbm)}),
      reason: completed ? "" : String(reason || ""),
    };
    try { await WsprLog.record(record); } catch (_error) {}
    await refreshActivity();
  }

  // Two resolutions, because one geometry cannot serve both questions. Up to a
  // day the operator is asking "which slots did I lose", which needs a cell per
  // two-minute slot; over a week they are asking "when does this band work",
  // which only needs an hour. The old 24 x 28 grid answered neither and filled
  // the screen doing it.
  const ACTIVITY_RANGES = {
    "1h": {hours: 1}, "6h": {hours: 6}, "24h": {hours: 24}, "7d": {days: 7},
  };
  const activityRange = () => ACTIVITY_RANGES[state.activityRange] || ACTIVITY_RANGES["6h"];

  // The slot views continue past "now" with what the schedule is going to key, so
  // the same axis answers "what did it do" and "what will it do". The 7-day view
  // does not: with a repeating 24-hour schedule every future day is identical, so
  // it would add area and no information.
  const ACTIVITY_AHEAD_HOURS = 6;

  // Records the grid is allowed to see. The filter is applied here rather than in
  // WsprLog so the aggregation stays a pure function of what it is handed.
  const filteredActivity = () => state.bandFilter
    ? state.activity.filter(record => record.band === state.bandFilter) : state.activity;

  function activityCells() {
    const range = activityRange();
    const records = filteredActivity();
    return range.hours
      ? {slotView: true, ...WsprLog.summariseSlots(records,
          {hours: range.hours, aheadHours: ACTIVITY_AHEAD_HOURS, nowUtcMs: utcNow()})}
      : {slotView: false, ...WsprLog.summarise(records, {days: range.days, nowUtcMs: utcNow()})};
  }

  // Every band that has either run or is scheduled, so a band can be inspected
  // before its first transmission and after it has been taken out of the table.
  function activityBands() {
    const bands = new Set(settings.timetable.flatMap(entry => entry.bands));
    for (const record of state.activity) if (record.band) bands.add(record.band);
    const rank = band => WsprCore.PRESETS.findIndex(preset => preset.band === band);
    return [...bands].sort((a, b) => rank(a) - rank(b));
  }

  function renderActivityBands() {
    if (!dom.activityBands) return;
    const bands = activityBands();
    if (state.bandFilter && !bands.includes(state.bandFilter)) state.bandFilter = "";
    dom.activityBands.innerHTML = bands.length < 2 ? "" :
      `<span class="tt-chip-label">show</span>` +
      `<button class="tt-chip${state.bandFilter ? "" : " current"}" type="button"` +
      ` data-filter-band="">ALL</button>` +
      bands.map(band =>
        `<button class="tt-chip${band === state.bandFilter ? " current" : ""}" type="button"` +
        ` data-filter-band="${band}">${band}</button>`).join("");
  }

  function renderActivity() {
    renderActivityBands();
    const range = activityRange();
    const view = activityCells();
    const now = utcNow();
    const totals = WsprLog.totals(filteredActivity(),
      range.hours ? {hours: range.hours, nowUtcMs: now} : {days: range.days, nowUtcMs: now});

    const stamp = utcMs => new Date(utcMs).toISOString().replace("T", " ").slice(0, 16);
    let html = "", planned = 0, edgeDrawn = false;
    view.cells.forEach((row, rowIndex) => {
      const label = view.slotView
        ? new Date(row[0].hourUtcMs).toISOString().slice(11, 13)
        : String(rowIndex).padStart(2, "0");
      html += `<div class="activity-row"><span class="activity-hour">${label}</span>`;
      row.forEach((cell, columnIndex) => {
        const when = view.slotView ? stamp(cell.slotUtcMs)
          : `${new Date(cell.dayUtcMs).toISOString().slice(0, 10)} ${label}:00`;
        // A frame still running counts as present, not past, so the "now" mark
        // lands on the frame after it rather than inside it.
        const future = view.slotView && cell.slotUtcMs + WsprCore.FRAME_MS > now;
        const frame = future ? WsprCore.frameTransmission(cell.slotUtcMs, scheduleView()) : null;
        // While one band is being inspected, only its own future frames are drawn
        // hollow -- otherwise the filtered grid would promise transmissions that
        // belong to a band it is not showing.
        const keys = frame && (!state.bandFilter || frame.slot.band === state.bandFilter)
          ? frame : null;
        const edge = future && !edgeDrawn;
        if (edge) edgeDrawn = true;
        if (keys) planned++;
        const detail = keys ? `planned ${keys.slot.band}`
          : cell.records.length
            ? Object.entries(cell.counts).map(([status, count]) => `${count} ${status}`).join(", ")
            : "nothing scheduled";
        html += `<button class="activity-cell ${cell.status}${keys ? " planned" : ""}` +
                `${edge ? " edge" : ""}` +
                `${state.selectedCell === `${rowIndex}:${columnIndex}` ? " selected" : ""}"` +
                ` type="button" data-row="${rowIndex}" data-column="${columnIndex}"` +
                ` title="${when} UTC — ${detail}"></button>`;
      });
      html += "</div>";
    });
    dom.activityGrid.classList.toggle("slot-view", view.slotView);
    dom.activityGrid.innerHTML = html;

    const summary = `${totals.sent} sent · ${totals.suspect} unconfirmed · ` +
                    `${totals.missed} missed · ${totals.broken} broken` +
                    (view.slotView ? ` · ${planned} planned` : "");
    dom.activityTotals.textContent = summary;
    dom.activitySummary.textContent = summary;
    // Nothing is drawn hollow in the 7-day view, so the legend must not claim it.
    dom.plannedLegend.hidden = !view.slotView;
  }

  function showCellDetail(rowIndex, columnIndex) {
    const view = activityCells();
    const cell = view.cells[rowIndex] && view.cells[rowIndex][columnIndex];
    if (!cell || !cell.records.length) {
      state.selectedCell = null;
      dom.activityDetail.hidden = true;
      renderActivity();
      return;
    }
    state.selectedCell = `${rowIndex}:${columnIndex}`;
    const heading = view.slotView
      ? new Date(cell.slotUtcMs).toISOString().replace("T", " ").slice(0, 16)
      : `${new Date(cell.dayUtcMs).toISOString().slice(0, 10)} ` +
        `${String(rowIndex).padStart(2, "0")}:00`;
    const rows = cell.records
      .slice().sort((a, b) => a.slotUtcMs - b.slotUtcMs)
      .map(record => `<tr>` +
        `<td>${new Date(record.slotUtcMs).toISOString().slice(11, 19)}</td>` +
        `<td>${escapeHtml(record.band || "")}</td>` +
        `<td>${record.dbm} dBm</td>` +
        `<td>${record.offsetHz || "--"} Hz</td>` +
        `<td class="status-${record.status}">${record.status}</td>` +
        `<td class="reason">${escapeHtml(record.reason || "")}</td></tr>`).join("");
    dom.activityDetail.hidden = false;
    dom.activityDetail.innerHTML =
      `<h3>${heading} UTC</h3>` +
      `<table><thead><tr><th>slot</th><th>band</th><th>power</th><th>offset</th>` +
      `<th>status</th><th>reason from the firmware</th></tr></thead><tbody>${rows}</tbody></table>`;
    renderActivity();
  }

  const escapeHtml = text => String(text).replace(/[&<>"]/g,
    c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));

  // ---- beacon ---------------------------------------------------------------

  function startBeacon() {
    const problem = startBlockingReason();
    if (problem) { state.lastError = problem; render(); return; }
    state.lastError = ""; state.consecutiveBroken = 0;
    state.beacon = "armed";
    render();
  }

  // Stopping the beacon no longer closes the audio socket: it is the page's, and
  // the waterfall keeps running between beacon runs. Only losing the session
  // lease or leaving the page closes it.
  function stopBeacon(reason = "") {
    state.beacon = "stopped";
    state.pendingSlotUtcMs = 0;
    if (tx && ["preparing", "waiting-slot", "prebuffering", "streaming"].includes(tx.state))
      tx.fail(reason || "operator stop");
    render();
  }

  async function beaconTick() {
    if (state.beacon !== "armed" || !tx || beaconPreparing) return;
    if (["preparing", "waiting-slot", "prebuffering", "streaming"].includes(tx.state)) return;

    const next = nextTransmission();
    if (!next) { state.pendingSlotUtcMs = 0; return; }
    state.pendingSlotUtcMs = next.slotUtcMs;
    const untilSlot = next.slotUtcMs - utcNow();
    if (untilSlot > PREPARE_LEAD_MS + 20000) return;      // still far away
    // A frame that follows straight after one of ours has nine seconds of gap,
    // not the beacon's usual ten-second lead, so it is prepared on a shorter one.
    // Below the cutoff there is no longer room to confirm the dial, and keying on
    // an unconfirmed band is the one thing this page will not do.
    const leadMs = untilSlot < PREPARE_LEAD_MS ? TIGHT_LEAD_MS : PREPARE_LEAD_MS;
    if (untilSlot < RETUNE_CUTOFF_MS) return;             // too late, wait for the next

    // Re-checked here rather than only at START: the operator can reach over and
    // turn the power up hours into an unattended run, and this slot must not go
    // out over the ceiling just because the beacon was armed when it was legal.
    const blocked = blockingReason();
    const dbm = radioPower().dbm;
    beaconPreparing = true;
    try {
      if (blocked) throw new Error(blocked);
      await tuneRadio(next.slot);
      // STOP may have been pressed while CAT/readback was in flight.
      if (state.beacon === "stopped") return;
      // The cutoff is checked AFTER the retune, because that is what it is about:
      // a dial that arrived too late to leave room for the prebuffer.
      const leftAfterTune = next.slotUtcMs - utcNow();
      if (leftAfterTune < RETUNE_CUTOFF_MS)
        throw new Error(`the band change left only ${(leftAfterTune / 1000).toFixed(1)} s`);
      const frame = WsprCore.encode({
        callsign: sharedCall(),
        locator: sharedGrid(),
        powerDbm: dbm});
      // Randomised inside the 200 Hz WSPR window, standard practice against
      // collisions with other beacons on the same dial frequency.
      const baseHz = WINDOW_LOW_HZ + Math.floor(Math.random() * (WINDOW_HIGH_HZ - WINDOW_LOW_HZ));
      state.lastOffsetHz = baseHz;
      state.currentSession = {
        slotUtcMs: next.slotUtcMs, band: next.slot.band, dialHz: next.slot.hz,
        offsetHz: baseHz, callsign: frame.message.callsign,
        locator: frame.message.transmittedLocator, dbm,
        powerSamples: [],
      };
      tx.queue({symbols: frame.symbols, slotUtcMs: next.slotUtcMs,
                baseHz, amplitude: beginBeaconGuard().gain, leadMs});
      state.beacon = "transmitting";
      // A frame that made it is proof the link can sustain the pace, so the
      // spacing imposed after three failures is lifted again here.
      state.retuneMisses = 0;
      state.spaceBandChanges = false;
    } catch (error) {
      if (state.beacon === "stopped") return;
      // Failing to tune means the slot passes with nothing radiated. That is a
      // missed slot, and the grid has to say so rather than showing a gap.
      state.currentSession = {
        slotUtcMs: next.slotUtcMs, band: next.slot.band, dialHz: next.slot.hz,
        offsetHz: 0, callsign: sharedCall(),
        locator: sharedGrid().slice(0, 4), dbm: dbm || 0, powerSamples: [],
      };
      await recordSession({completed: false, afterKeying: false,
                           reason: String(error.message || error)});
      state.lastError = String(error.message || error);
      state.beacon = "armed";
      // Only the deadline degrades the pace. A missing callsign or a power
      // ceiling would fail just as reliably at half the rate, so treating those
      // as "too fast" would hide a fault behind a quieter schedule.
      if (untilSlot < PREPARE_LEAD_MS) {
        state.retuneMisses += 1;
        if (state.retuneMisses >= RETUNE_MISS_LIMIT && !state.spaceBandChanges) {
          state.spaceBandChanges = true;
          state.lastError = `${state.lastError} — leaving a frame free after each ` +
            `band change until one fits again`;
        }
      }
    } finally {
      beaconPreparing = false;
    }
    render();
  }

  // ---- tune -----------------------------------------------------------------
  //
  // A toggle with a hard cap, mirroring the JS8 tune carrier: five seconds is not
  // enough to turn the MOD level knob and watch the meter settle, and a button
  // that cannot be stopped early is one the operator learns not to press.
  let tuneTimer = null;

  async function startTune() {
    const problem = radioBlockingReason();
    if (problem) { state.lastError = problem; render(); return; }
    state.lastError = ""; state.tunePeakRaw = 0;
    try {
      const next = nextTransmission() || {slot: WsprCore.PRESETS[5]};
      await tuneRadio(next.slot);
      // Which band and which level this carrier is measuring. Filed under the
      // radio's own dBm, not the target, because that is the figure a logged
      // transmission carries -- the two have to be looked up the same way.
      state.tuneBand = next.slot.band;
      state.tuneDbm = radioPower().dbm;
      // A steady tone in the middle of the WSPR window. The 162 symbols are a
      // full frame's worth of audio; stopTune aborts long before it runs out.
      const symbols = new Uint8Array(162).fill(1);
      // The same level the beacon would transmit at, calibrated or manual. A
      // tune carrier that used a different one would be measuring something the
      // beacon never sends.
      tx.queue({symbols, slotUtcMs: utcNow() + TUNE_LEAD_MS, baseHz: 1500,
                amplitude: resolvedGain().gain, leadMs: TUNE_LEAD_MS});
      state.beacon = "tuning";
      // Armed on the same line as the deadline the timer counts down, so the
      // two cannot drift apart. Anywhere earlier and the awaited retune would
      // be spent off the clock the operator is watching.
      tuneTimer = setTimeout(() => stopTune("tune finished"), TUNE_LEAD_MS + TUNE_MAX_MS);
      state.tuneEndsAtMs = utcNow() + TUNE_LEAD_MS + TUNE_MAX_MS;
    } catch (error) {
      state.lastError = String(error.message || error);
      state.beacon = "stopped";
    }
    render();
  }

  function stopTune(reason = "operator stop") {
    if (tuneTimer) { clearTimeout(tuneTimer); tuneTimer = null; }
    state.tuneEndsAtMs = 0;
    // Read the reference before aborting: forward power is only polled while
    // keyed, so after the abort this is the last reading from a dead carrier.
    if (state.tunePeakRaw > 0 && state.tuneDbm !== null)
      storeReference(state.tuneBand, state.tuneDbm, state.tunePeakRaw);
    // Leave the tuning state first. The abort below comes back through
    // onTxEvent as a failure, and it is one we caused on purpose -- the
    // "stopped" guard there is what tells the two cases apart.
    state.beacon = "stopped";
    if (tx && ["preparing", "waiting-slot", "prebuffering", "streaming"].includes(tx.state))
      tx.fail(reason);
    render();
  }

  // ---- TX gain calibration ---------------------------------------------------
  //
  // The tool itself is data/tx-gain-cal-ui.js, shared with the JS8Call page: the
  // measurement is a property of the radio, not of the mode, and two copies of a
  // transmitter-keying panel would drift. This page only supplies the adapter --
  // what the radio is, what blocks keying here, and where the forward-power
  // reference goes -- plus the one thing that is genuinely WSPR's: the beacon's
  // own runtime limiter.
  const gainStore = new TxGainCal.TxGainStore();
  const beaconGuard = new TxAlcGuard.TxAlcGuard();
  let calArmed = false;           // #autogain: also suppresses the automatic power write

  // Grilled 2026-08-28: NOT settings.modelOverride -- that override exists only
  // to make fullPower() guess a wattage curve when the radio has not reported
  // (or does not report) a model watts.js recognizes (see that function's own
  // comment). Calibration identity is a property of the physical hardware --
  // filing a measured knee under a pretend model would apply it to whatever
  // radio the override happens to name, and a real radio calibrated under a
  // wrong name is invisible to RTTY-ICOM/DATA/Mercury, which all key off the
  // live-reported name (IcomModels.liveRadioModel() -- see its own comment).
  // Before this fix, a station with an override set had its WSPR-measured
  // knees permanently unreachable from every other DATA page.
  const calModel = () => liveRadioModel() || "";

  // Declared before the single-shot tool because that tool's adapter asks the plan
  // panel for the radio's MOD level. `const` here would be a temporal dead zone: a
  // render() during page setup would throw a ReferenceError rather than read zero.
  let gainPlan = null;

  const gainCal = TxGainCalUi.create({
    mount: dom.calField,
    store: gainStore,
    sink: {
      // The session is the sink, with one addition: WsprTx keeps the firmware's
      // dead-man alive with wspr.ping, and the page's own beacon driver uses the
      // very same socket. Sharing it is safe only because the two never run at
      // once, which is what the blocking reason below enforces.
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
    wallNow: utcNow,
    radio: () => state.radio,
    model: calModel,
    manualGain: txGain,
    dbm: () => radioPower().dbm,
    blockingReason: () => {
      const radio = radioBlockingReason();
      if (radio) return radio;
      // One transmitter, two drivers on this page. The beacon owns the radio
      // whenever it is armed or keying; a calibration that queued a carrier into
      // the same socket would put two transmissions on one slot.
      if (state.beacon !== "stopped") return `the beacon is ${state.beacon}`;
      return "";
    },
    ensureDataMode: async () => {
      await ensureUsbDataMode();
      await waitForState(radio => radio.mode === "USB-D");
    },
    setMode: mode => command({type: "setMode", mode}),
    onRunChange: running => { state.calRunning = running; render(); },
    onReference: (band, dbm, poPeak) => storeReference(band, dbm, poPeak),
    // What the radio's network MOD level is, as far as the plan panel has been able
    // to read it. Every stored knee is a knee AT a MOD level, so the resolver needs
    // this to tell a usable entry from one measured before the sensitivity moved.
    modLevel: () => (gainPlan ? gainPlan.modLevel() : 0),
    // And a way to go and read it. The plan panel owns the CI-V client for it;
    // a calibration started from the settings panel alone would otherwise file
    // its knee under an unknown MOD level.
    refreshModLevel: () => (gainPlan ? gainPlan.refreshModLevel() : null),
  });

  // The batch plan. Same module the JS8Call page mounts; it borrows the single-shot
  // run above as its measuring device and adds the grid, the radio driving and the
  // antenna question.
  gainPlan = TxGainPlanUi.create({
    mount: dom.planField,
    button: dom.planButton,
    store: gainStore,
    cal: gainCal,
    model: calModel,
    modelNumber: () => IcomModels.modelNumber(calModel()),
    radio: () => state.radio,
    send: payload => commandJson(payload),
    bands: () => WsprCore.PRESETS.map(preset => ({band: preset.band, hz: preset.hz})),
    wsprPresets: WsprCore.PRESETS,
    js8Presets: typeof Js8TrxPresets !== "undefined" ? Js8TrxPresets.PRESETS : [],
    percentOf: radio => (radio.rfPowerSeen === true ? WsprCore.civPercent(radio.rfPower) : 0),
    // The powers this station actually operates on: the level WSPR is targeting, and
    // whatever the radio is set to right now (which on a shared MOD input is usually
    // the JS8 one). Not a ladder of round numbers -- every extra column is a carrier
    // on every band.
    defaultPowers: () => {
      const out = [];
      const full = fullPower().watts, target = targetDbm();
      if (full && target !== null) {
        try { out.push(WsprCore.civPercent(WsprCore.powerCommand(target, full).level)); }
        catch (_error) { /* an unknown model has no target to offer */ }
      }
      if (state.radio.rfPowerSeen === true) out.push(radioPercent());
      return out;
    },
    // Confirmed writes, both of them: a plan that measured a cell on a band the
    // radio never reached would file the wrong knee under the right key.
    setFrequency: async hz => {
      await command({type: "setFrequency", frequency: String(hz)});
      await Promise.all([
        // Frequency is slot 0 of the rotation, so it comes back fast -- but say what
        // it came back as when it does not match, for the same reason as the power.
        waitForState(radio => radio.frequency === hz, 9000).catch(() => {
          throw new Error(`the radio did not confirm the band: asked for ` +
            `${(hz / 1000).toFixed(1)} kHz, it reports ` +
            `${(state.radio.frequency / 1000).toFixed(1)} kHz`);
        }),
        new Promise(resolve => setTimeout(resolve, BAND_SETTLE_MS)),
      ]);
    },
    // Written, then CONFIRMED -- and the confirmation asks the radio rather than
    // waiting for it to be asked. The firmware polls 14 0A once per fifteen-slot
    // rotation (1.5 s) and not at all while a transmission is running, so a passive
    // wait right after a carrier depends on a rotation that may not have resumed. A
    // read request costs one CI-V frame and removes that dependency.
    setPercent: async percent => {
      const level = WsprCore.percentToLevel(percent);
      await command({type: "civ.raw", data: WsprCore.civLevelCommand(level).data});
      await confirmPercent(percent, level);
    },
    // The beacon owns the transmitter whenever it is not stopped, and the plan keys
    // on bands the schedule knows nothing about.
    planBlockingReason: () => (state.beacon !== "stopped" ? `the beacon is ${state.beacon}` : ""),
    // The module names the outputs itself from /api/bd-config; the page only lends it
    // a fetch so it opens no socket of its own. The lent fetch carries the same
    // deadline as everything else here; a caller-supplied signal still wins.
    fetchImpl: (url, options = {}) =>
      fetch(url, {signal: fetchDeadline(FETCH_FLASH_TIMEOUT_MS), ...options}),
    setModeFilter: (mode, filter) => command({type: "setMode", mode,
      filter: filter ? "FIL" + filter : undefined}),
    onPlanChange: running => { state.planRunning = running; render(); },
  });

  // The level for the transmission about to be queued. Resolved per transmission,
  // not per page load: the schedule changes band -- and with it the power
  // percentage -- as often as every frame, and the table is keyed by both.
  const resolvedGain = () => gainCal.resolved();

  function beginBeaconGuard() {
    const resolved = resolvedGain();
    // An uncalibrated level is the operator's own manual choice. Trimming that
    // behind their back would be the page arguing with the slider they set.
    if (resolved.calibrated) beaconGuard.beginTx({key: resolved.key, gain: resolved.gain});
    return resolved;
  }

  function endBeaconGuard() {
    const outcome = beaconGuard.endTx();
    if (!outcome || !outcome.reduced || outcome.persistGain === null) return;
    const entry = gainStore.entry(outcome.key);
    if (!entry) return;
    gainStore.put(outcome.key, {...entry, gain: Number(outcome.persistGain.toFixed(4)),
                                autoTrimmed: true, at: Date.now()})
      .catch(() => {}).then(render);
  }

  // Unlike JS8, WSPR generates its audio a packet at a time, so a reduction can
  // reach the air inside the frame it was decided in -- ramped, never stepped.
  // The frame is never aborted: 6 dB down still decodes, a truncated frame is a
  // burnt slot.
  function onBeaconLevel(message) {
    if (!beaconGuard.active || state.beacon !== "transmitting") return;
    const before = beaconGuard.gain;
    const after = beaconGuard.noteLevel({consumed: message.consumed, alc: message.alc,
                                         alcSeq: message.alcSeq});
    if (after !== before && tx.stream)
      tx.stream.setAmplitude(after, TxGainCalUi.CAL_RAMP_SAMPLES);
  }

  // Read-only beside the manual field, never inside it: a calibrated level can be
  // 0.006 or 0.63 and the field steps in 0.05, so writing it there would round the
  // measurement away on the operator's first click.
  function renderGainCal() {
    const resolved = resolvedGain();
    if (resolved.calibrated) {
      const entry = resolved.entry || {};
      const at = Number(entry.at) || 0;
      dom.calResolved.textContent =
        `calibrated ${resolved.gain} — ${resolved.band} @ ${resolved.percent} %` +
        (entry.autoTrimmed ? ", trimmed on air" : "") +
        (at ? `, ${new Date(at).toISOString().slice(0, 10)}` : "");
      dom.calResolved.classList.remove("uncalibrated");
    } else {
      dom.calResolved.textContent = `${resolved.why} — using the manual ${resolved.gain}`;
      dom.calResolved.classList.add("uncalibrated");
    }
    gainCal.render();
  }

  // Everything that must be true before this page may key the transmitter at
  // all, whether for a beacon slot or a tune carrier.
  function radioBlockingReason() {
    if (!isLan()) return "the primary radio is not on the ICOM-LAN transport";
    if (!state.radio.connected) return "the radio is not connected";
    if (!sessionHeld || !sessionConfirmed) return "another page holds the radio";
    // Without a hello there is no stream identity, and the firmware rejects
    // every TX packet that carries the wrong one. Saying so beats keying into a
    // transmission the radio will abort.
    if (!session || !session.hello) return "the audio link is not ready";
    if (!txSafetyAccepted()) return "confirm Enable radio TX";
    return "";
  }

  // Everything that must be true before the beacon may key the transmitter.
  function blockingReason() {
    const radio = radioBlockingReason();
    if (radio) return radio;
    if (!fullPower().watts) return "the radio model is unknown, so its power reading cannot be converted to watts";
    const power = radioPower();
    if (!(power.watts > 0.001)) return "the radio is set to zero power";
    // The ceiling is the operator's rule, not the radio's. Refuse rather than
    // turning the power down: the automation only ever writes a level from the
    // menu, and every level in the menu is already under the cap -- so a radio
    // found above it was put there by hand, and answering that by reaching for
    // the knob would be the page arguing with its operator.
    if (power.watts > POWER_CEILING_W * 1.01)
      return `the radio is set to ${power.watts.toFixed(1)} W, above the ${POWER_CEILING_W} W ceiling`;
    try {
      WsprCore.validate({callsign: sharedCall(), locator: sharedGrid(),
                         powerDbm: power.dbm});
    } catch (error) { return error.message; }
    if (!scheduledSlots()) return "the schedule is empty";
    return "";
  }

  // What blocks START but not a beacon that is already running. The dial is the
  // operator's until the beacon takes it: arming from 14.200 would look fine for
  // ten minutes and then fail its first slot, so refuse at the button instead
  // and colour the control that fixes it. A run in progress is deliberately
  // exempt -- beaconTick keeps checking blockingReason() alone, because there
  // the schedule tunes the radio itself before every slot and a hand-turned VFO
  // mid-run is something it corrects rather than something it stops for.
  // TUNE is exempt too: it keys a carrier on whatever the radio is on, which is
  // exactly what an operator setting the drive level wants.
  function startBlockingReason() {
    const problem = blockingReason();
    if (problem) return problem;
    if (offDialFrequency())
      return "the radio is not on a WSPR dial frequency — choose a band from the dial menu";
    return "";
  }

  // ---- rendering ------------------------------------------------------------

  // The menu is derived from the radio, which arrives asynchronously, so it is
  // built here rather than once at startup -- and rebuilt only when the set of
  // levels genuinely changes, because replacing the options of a select the
  // operator has open would throw away what they were pointing at.
  //
  // The percent is on every line on purpose. It explains why a 100 W radio gets
  // four entries and a 10 W one seven, and it is the same unit the radio's own
  // display shows, so it can be read straight against the front-panel knob.
  let powerOptionsKey = null;

  function renderPowerOptions() {
    const levels = offeredLevels();
    const key = levels.join(",");
    if (key === powerOptionsKey) return;
    powerOptionsKey = key;
    const full = fullPower().watts;
    dom.powerDbm.innerHTML = levels.map(dbm => {
      const watts = WsprCore.dbmToWatts(dbm);
      const percent = WsprCore.civPercent(WsprCore.powerCommand(dbm, full).level);
      const shown = watts < 1 ? `${(watts * 1000).toFixed(0)} mW`
                              : `${watts.toFixed(watts < 10 ? 1 : 0)} W`;
      return `<option value="${dbm}">${dbm} dBm · ${shown} · ${percent} %</option>`;
    }).join("");
    // An unknown model has no scale, so there is no honest list to offer. The
    // page already refuses to start in that state; the menu says the same thing
    // rather than showing levels it cannot convert.
    dom.powerDbm.disabled = !levels.length;
  }

  function render() {
    // The red frame around the whole viewport while the radio is keyed. Same
    // rule, same class and same stylesheet as JS8Call (`body.radio-transmitting`
    // in data.css, which this page already loads) -- it belongs here more, not
    // less: WSPR keys for 110 s at a time, and the calibration keys on bands the
    // operator never dialled by hand.
    //
    // Every driver on this page counts, which is why it is not read off the
    // beacon's WsprTx: TUNE, the beacon and the gain calibration are three
    // drivers on one transmitter, and `session.ptt` is the socket's own answer
    // for all of them. `state.radio.tx` is the radio's, one second late.
    document.body.classList.toggle("radio-transmitting",
      Boolean(state.radio.tx || (session && session.ptt)));

    // Whether ICOM-LAN is configured at all was settled by lan-gate.js before
    // this page booted, so the only thing left to hide the interface for is
    // another page holding the radio.
    dom.beaconInterface.hidden = !dom.sessionBusy.hidden;

    // LAN is exclusive to one of TRX1-3 and the operator chooses which, so the
    // button names it rather than showing an anonymous "TRX" -- same as JS8Call.
    const lanSlot = LanGate.slot ? LanGate.slot() : 0;
    dom.trxSlotLabel.textContent = lanSlot ? `TRX ${lanSlot}` : "TRX";
    dom.trxSlotLabel.title = lanSlot ? `TRX${lanSlot} is the LAN radio` : "TRX";

    const shownHz = state.pendingFrequency || state.radio.frequency;
    dom.trxFrequencyValue.textContent =
      shownHz ? Js8TrxPresets.formatFrequency(shownHz) : "--.---.---";
    dom.trxFrequency.classList.toggle("pending", Boolean(state.pendingFrequency));
    // START is refused off a dial frequency, so the refusal is drawn on the one
    // control that resolves it rather than left as a dead button with the reason
    // in a line of text further down the page.
    const offDial = offDialFrequency();
    dom.trxFrequency.classList.toggle("off-dial", offDial);
    dom.trxFrequency.title = offDial
      ? "Not a WSPR dial frequency — choose a band before the beacon can start"
      : "";
    if (!dom.frequencyMenu.hidden) renderFrequencyMenu();
    maybeOfferSetupHelp();
    dom.trxMode.textContent = state.radio.mode || "---";
    dom.radioModel.textContent = liveRadioModel() || "model unknown";
    // Same string drives the setup guide, so the dialog can never explain a radio
    // other than the one on the air. No-op while it does not change. Must be
    // liveRadioModel(), not the raw radioName -- radioName can still hold the
    // PREVIOUS radio's name for ~1s after a live LAN-slot model swap, before
    // radioNameSeen catches up (see liveRadioModel()'s own comment above).
    if (typeof TrxHelp !== "undefined") TrxHelp.setReportedModel(liveRadioModel());
    dom.linkState.textContent = state.radio.connected ? "● LINKED" : "● OFFLINE";
    dom.linkState.classList.toggle("up", state.radio.connected);

    // The audio socket has its own indicator: LINKED above reports CI-V over
    // LAN, and a beacon can sit there "linked" and still be unable to key.
    const audioUp = Boolean(session && session.hello);
    dom.aud1State.textContent = audioUp ? "AUD1 ●" : "AUD1 —";
    dom.aud1State.classList.toggle("up", audioUp);
    dom.trxReconnect.hidden = state.radio.connected;
    // "LAN 0·0·0" carried no information -- LINKED and AUD1 already say the link
    // is healthy -- and the three numbers had no legend anywhere on the page,
    // only a title, which a phone cannot show. So it stays hidden until one of
    // them moves, and then it spells itself out.
    const lanIdle = !state.radio.lanDrops && !state.radio.lanStalls && !state.radio.lanFilled;
    dom.lanHealth.hidden = lanIdle;
    dom.lanHealth.textContent = lanIdle ? "" :
      `LAN drop ${state.radio.lanDrops} · stall ${state.radio.lanStalls} · fill ${state.radio.lanFilled}`;
    dom.lanHealth.classList.toggle("warn",
      state.radio.lanDrops > 0 || state.radio.lanFilled > 0);
    dom.timingState.textContent = `clock ${clockCorrectionMs() >= 0 ? "+" : ""}${clockCorrectionMs()} ms`;

    const scale = fullPower();
    dom.fullPowerWatts.textContent = scale.watts ? `${scale.watts} W` : "unknown";
    dom.fullPowerSource.textContent = scale.source;

    // Power is a readout of the radio, so the rounding to a legal WSPR level is
    // shown rather than hidden -- that number goes on the air and into everyone
    // else's propagation data.
    const power = radioPower();
    if (power.watts === null) {
      dom.powerWatts.textContent = "--";
      dom.powerPercent.textContent = "the radio model is unknown";
    } else {
      dom.powerWatts.textContent = power.watts < 1
        ? `${(power.watts * 1000).toFixed(0)} mW` : `${power.watts.toFixed(2)} W`;
      const error = power.errorDb;
      dom.powerPercent.textContent = `reports ${power.dbm} dBm` +
        (Math.abs(error) >= 0.05 ? ` (${error > 0 ? "+" : ""}${error.toFixed(1)} dB)` : " exactly");
    }
    dom.powerWatts.classList.toggle("over",
      power.watts !== null && power.watts > POWER_CEILING_W * 1.01);

    // The target half of the row. Amber says "not written", nothing more: what
    // goes on the air is the readout to its left, so a mismatch never stops a
    // transmission -- one turn of the knob would otherwise silence the beacon
    // for the night. Only the 10 W ceiling refuses to key, and it wears red.
    renderPowerOptions();
    const target = targetDbm();
    if (target !== null && document.activeElement !== dom.powerDbm)
      dom.powerDbm.value = String(target);
    const mismatch = powerMismatch();
    dom.powerField.classList.toggle("mismatch", Boolean(mismatch));
    dom.powerMismatch.hidden = !mismatch;
    if (mismatch)
      dom.powerMismatch.textContent = power.watts === null
        ? `the radio is not on ${mismatch.target} dBm — press SET`
        : `the radio is on ${power.watts < 1 ? `${(power.watts * 1000).toFixed(0)} mW`
            : `${power.watts.toFixed(2)} W`} — press SET to write ${mismatch.target} dBm`;

    try { dom.locatorTransmitted.textContent = WsprCore.normalizeLocator(sharedGrid()).transmitted; }
    catch (_error) { dom.locatorTransmitted.textContent = "----"; }

    if (document.activeElement !== dom.txGain) dom.txGain.value = String(txGain());
    // Both meters are only polled while the radio is keyed: the firmware asks for
    // the S-meter and the supply voltage instead during RX (the aux poll's
    // `stateTx ? 0x11 : 0x02` and `stateTx ? 0x12 : 0x15` in the sketch), and it
    // never zeroes what it read last. So off key these fields hold the PREVIOUS
    // transmission's numbers, frozen -- and the live session row appears while the
    // page is still prebuffering, before the radio keys, which is exactly when
    // that stale SWR was on screen looking like a measurement.
    // "118" alone reads like watts. "118/255" reads like a position on a dial,
    // which is what it is -- and it makes the reference below it comparable at a
    // glance rather than by arithmetic.
    const metering = state.radio.tx;
    dom.powerMeter.textContent = metering ? `${state.radio.powerMeterRaw}/255` : "--";
    dom.swr.textContent = metering && state.radio.swr ? state.radio.swr.toFixed(1) : "--";
    // While tuning this counts the peak up live; afterwards it shows what is on
    // file for the band the next transmission will use, so the operator can see
    // whether the meter beside it is about to agree.
    const tuneActive = state.beacon === "tuning";
    const referenceBand = tuneActive ? state.tuneBand
      : ((nextTransmission() || {}).slot || {}).band;
    const stored = referenceFor(referenceBand, power.dbm);
    const referenceRaw = tuneActive && state.tunePeakRaw > 0 ? state.tunePeakRaw : stored;
    dom.tuneReference.textContent = referenceRaw ? `${referenceRaw}/255` : "--";

    const bandCount = Object.keys(settings.powerReferences).length;
    dom.referenceCount.textContent = bandCount
      ? `${bandCount} band${bandCount === 1 ? "" : "s"} measured` : "no bands measured";
    dom.referenceClear.disabled = !bandCount;

    renderGainCal();

    dom.txSafety.checked = txSafetyAccepted();
    if (document.activeElement !== dom.clockCorrection)
      dom.clockCorrection.value = String(clockCorrectionMs());
    // What the collapsed SETTINGS header has to answer at a glance: who is on
    // the air, from where, and at what power. The mismatch belongs here too --
    // the section opens collapsed, and an amber row nobody can see is not a
    // warning. The dBm on the left stays the radio's, because that is the truth
    // that goes on the air whether or not the target was ever written.
    dom.settingsSummary.textContent =
      `${sharedCall() || "no callsign"} · ${dom.locatorTransmitted.textContent} · ` +
      `${power.dbm === null ? "power unknown" : `${power.dbm} dBm`}` +
      `${mismatch ? ` · target ${mismatch.target} dBm not applied` : ""}` +
      `${txSafetyAccepted() ? "" : " · TX not enabled"}`;
    dom.settingsSummary.classList.toggle("mismatch", Boolean(mismatch));
    // The invariant is fixed, so there is no density control whose interaction
    // with the number of bands has to be decoded. State the consequence directly.
    const widest = Math.max(0, ...Array.from({length: WsprCore.SLOTS_PER_DAY},
      (_, index) => bandsAt(index).length));
    const cycle = Math.max(widest, WsprCore.MIN_BAND_GAP_FRAMES);
    dom.periodHint.textContent =
      `Each band waits at least 6 minutes before it may key again. ` +
      (widest
        ? `The longest sequence has ${widest} band${widest > 1 ? "s" : ""}: the radio keys ` +
          `${Math.round(100 * widest / cycle)} % of the time and each band comes round ` +
          `every ${cycle * 2} minutes${widest >= WsprCore.MIN_BAND_GAP_FRAMES
            ? " in the exact order shown." : "; unused positions stay silent."}`
        : "Add a change and choose its ordered band sequence.");
    dom.scheduleUndo.hidden = scheduleUndo === null;
    // Cheap while the panel is closed -- renderPreview returns immediately -- and
    // this is what keeps the strip's "would transmit" head honest when the beacon
    // starts or a blocker clears while the panel is open.
    renderPreview();
    dom.audioLevel.textContent = `${Math.round(state.audioDb)} dBFS`;
    dom.spectrumSummary.textContent =
      `RX ${RX_LOW}–${RX_HIGH} Hz · WSPR window ${WINDOW_LOW_HZ}–${WINDOW_HIGH_HZ} Hz · TX ${state.lastOffsetHz} Hz`;

    const problem = startBlockingReason();
    const tuning = state.beacon === "tuning";
    const beaconRunning = state.beacon !== "stopped" && !tuning;
    // The two buttons key the same transmitter, so each one locks the other out
    // rather than letting a tune carrier collide with a scheduled slot.
    dom.startStop.disabled = tuning || (!beaconRunning && Boolean(problem));
    dom.startStop.textContent = beaconRunning ? "STOP" : "START";
    dom.startStop.classList.toggle("running", beaconRunning);
    dom.tuneButton.disabled = !tuning && (beaconRunning || Boolean(radioBlockingReason()));
    dom.tuneButton.textContent = tuning ? "STOP" : "TUNE";
    dom.tuneButton.classList.toggle("running", tuning);
    dom.beaconState.textContent = state.beacon;
    dom.beaconState.className = `beacon-state ${state.beacon === "paused" ? "paused"
      : state.beacon === "stopped" ? "" : "running"}`;

    const message = state.lastError || (state.beacon === "stopped" ? problem : "");
    dom.beaconError.hidden = !message;
    dom.beaconError.textContent = message;

    const next = state.pendingSlotUtcMs ? {slotUtcMs: state.pendingSlotUtcMs} : nextTransmission();
    const countdown = next
      ? Math.max(0, Math.round((next.slotUtcMs - utcNow()) / 1000)) : 0;
    // No countdown here any more: the timer beside START carries it, and two
    // clocks for one event disagree the moment one of them lags a render.
    // The measured band change belongs next to the next slot: with a rotation it
    // is the number that decides whether the following frame is reachable at all,
    // and there are only nine seconds of gap to spend.
    const retune = state.lastRetuneMs
      ? ` · band change ${(state.lastRetuneMs / 1000).toFixed(1)} s` +
        `${state.spaceBandChanges ? ", pacing reduced" : ""}`
      : "";
    dom.nextSession.textContent = next
      ? `next slot ${new Date(next.slotUtcMs).toISOString().slice(11, 19)} UTC${retune}`
      : "no slot scheduled";

    const live = tx && ["prebuffering", "streaming"].includes(tx.state);
    dom.liveSession.hidden = !live;
    dom.pttState.textContent = tx && tx.ptt ? "ON" : "off";
    dom.pttState.classList.toggle("keyed", Boolean(tx && tx.ptt));
    if (live) {
      const snapshot = tx.snapshot();
      // Radiated, not sent. The browser runs more than a second ahead of the
      // radio -- it has to, that is what the ring is for -- so a bar fed from
      // sent samples was already part full the instant it appeared. `consumed`
      // is what the firmware has actually clocked out, at 8 mu-law bytes per ms.
      const radiatedMs = Math.min(WsprCore.DURATION_S * 1000, snapshot.consumedUlaw / 8);
      // Tied to PTT, not to the state machine. The radio drops out of TX as soon
      // as it has clocked the last sample, but `tx-drained` only arrives after
      // that -- so a bar driven by state alone sat there full while the operator
      // was already back on receive.
      dom.sessionProgress.value = tx.ptt ? Math.round(radiatedMs) : 0;
      // Seconds as well as percent: the margin before the tone breaks is what
      // the operator is actually judging, and "18 %" does not say whether that
      // is a quarter of a second or two.
      dom.ringFill.textContent =
        `${Math.round(100 * snapshot.ringEstimate / TX_RING_BYTES)} % ` +
        `· ${(TX_RING_SECONDS * snapshot.ringEstimate / TX_RING_BYTES).toFixed(1)} s`;
      dom.packetCount.textContent = String(snapshot.sentPackets);
      dom.txSessionSummary.textContent =
        `transmitting ${Math.round(100 * radiatedMs / (WsprCore.DURATION_S * 1000))} %`;
    } else {
      // Emptied on the way out, so the bar can never reappear part-full at the
      // start of the next transmission.
      dom.sessionProgress.value = 0;
      dom.txSessionSummary.textContent = tuning ? "tune carrier"
        : next ? `next slot ${new Date(next.slotUtcMs).toISOString().slice(11, 19)} UTC`
               : "no slot scheduled";
    }

    renderSlotTimer(next, countdown);

    renderTimetableButton();
    waterfall.paintOverlay();
  }

  // Green while waiting, red while radiating. Two states of one clock rather
  // than two indicators, because at any moment exactly one of them is the answer
  // to "how long until something changes".
  function renderSlotTimer(next, countdown) {
    const keyed = Boolean(tx && tx.ptt);
    if (state.beacon === "stopped") { dom.slotTimer.hidden = true; return; }
    // TUNE is not a slot. It is queued as a full 162-symbol frame so the tone
    // cannot run dry, but the watchdog cuts it after TUNE_MAX_MS -- so counting
    // the frame out here promised a minute and a half of carrier that was never
    // going to be sent. What ends the tune is the only honest number.
    if (state.beacon === "tuning") {
      dom.slotTimer.hidden = !state.tuneEndsAtMs;
      if (!state.tuneEndsAtMs) return;
      dom.slotTimer.textContent = formatClock((state.tuneEndsAtMs - utcNow()) / 1000);
      // Red only once the radio is actually radiating; the lead-in is still a
      // wait, and the colours mean the same thing here as everywhere else.
      dom.slotTimer.className = `slot-timer ${keyed ? "transmitting" : "waiting"}`;
      dom.slotTimer.title = "time until TUNE stops itself";
      return;
    }
    if (keyed && tx.slotUtcMs) {
      const endsAt = tx.slotUtcMs + WsprCore.DURATION_S * 1000;
      dom.slotTimer.hidden = false;
      dom.slotTimer.textContent = formatClock((endsAt - utcNow()) / 1000);
      dom.slotTimer.className = "slot-timer transmitting";
      dom.slotTimer.title = "time left of this transmission";
      return;
    }
    if (!next) { dom.slotTimer.hidden = true; return; }
    dom.slotTimer.hidden = false;
    dom.slotTimer.textContent = formatClock(countdown);
    dom.slotTimer.className = "slot-timer waiting";
    dom.slotTimer.title = "time until the next transmission starts";
  }

  function renderClock() {
    dom.utcClock.textContent = `UTC ${new Date(utcNow()).toISOString().slice(11, 19)}`;
  }

  // ---- wiring ---------------------------------------------------------------

  function populateSelects() {
    for (const model of Object.keys(WsprCore.RADIO_FULL_POWER_W)) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = `${model} (${WsprCore.RADIO_FULL_POWER_W[model]} W)`;
      dom.radioModelOverride.append(option);
    }
    dom.radioModelOverride.value = settings.modelOverride;
  }

  // The callsign and the locator have no handlers here any more: they are the
  // station's, they are typed in SETUP, and this page shows them. Editing them in
  // three places meant three validations, and the JS8 one turned a half-typed
  // locator into an empty one -- which the interface stores, so a typo on one
  // tablet wiped the square the beacon transmits.
  function showIdentity() {
    dom.callsign.textContent = sharedCall() || "— not set";
    dom.locator.textContent = sharedGrid() || "— not set";
  }

  function wire() {
    dom.powerDbm.addEventListener("change", () => {
      settings.powerDbm = Number(dom.powerDbm.value); saveSettings();
      // A fresh choice re-enables an automation that a turn of the knob had
      // stood down. It does not itself write -- SET is still what writes -- so
      // the new target lands on the radio at the next load or link return.
      knobTouched = false;
      render();
    });
    dom.powerSet.addEventListener("click", setRadioPower);
    dom.clockCorrection.addEventListener("change", () => {
      const value = Math.max(-1000, Math.min(1000, Number(dom.clockCorrection.value) || 0));
      saveShared({clockCorrectionMs: value});
      render();
    });
    dom.radioModelOverride.addEventListener("change", () => {
      settings.modelOverride = dom.radioModelOverride.value; saveSettings(); render();
    });
    // Written to the shared blob on `change` only: `input` fires on every
    // keystroke, and a half-typed "0." saved as 0 would silently mute JS8Call's
    // drive too. Clamped here rather than trusting the number field, because
    // typing into it can produce anything.
    dom.txGain.addEventListener("change", () => {
      const value = Number(dom.txGain.value);
      saveShared({txGain: Number.isFinite(value)
        ? Math.min(0.8, Math.max(0.1, value)) : 0.25});
      render();
    });
    dom.referenceClear.addEventListener("click", () => {
      settings.powerReferences = {}; saveSettings(); render();
    });
    dom.scheduleAdd.addEventListener("click", () => {
      addChange();
      renderSchedule(); renderSlotPopover(); dom.schedulePopover.hidden = false;
      positionSlotPopover(); render();
    });
    dom.scheduleClear.addEventListener("click", () => {
      if (!settings.timetable.length) return;
      snapshotSchedule();
      settings.timetable = [];
      saveSettings();
      closeSlotPopover(); renderSchedule(); render();
    });
    dom.scheduleUndo.addEventListener("click", undoSchedule);
    dom.scheduleList.addEventListener("click", event => {
      const row = event.target.closest("[data-change-slot]");
      if (!row) return;
      const index = Number(row.dataset.changeSlot);
      if (editingSlot === index) { closeSlotPopover(); return; }
      openSlotPopover(index);
    });
    dom.schedulePopover.addEventListener("change", event => {
      const select = event.target.closest("[data-change-time]");
      if (!select || editingSlot === null) return;
      const entry = timetableEntry(editingSlot), slot = Number(select.value);
      if (!entry || timetableEntry(slot)) return;
      snapshotSchedule();
      entry.slot = slot; editingSlot = slot;
      sortTimetable(); saveSettings();
      renderSchedule(); renderSlotPopover(); positionSlotPopover(); render();
    });
    dom.schedulePopover.addEventListener("click", event => {
      if (editingSlot === null) return;
      const entry = timetableEntry(editingSlot);
      if (!entry) return;
      const add = event.target.closest("[data-add-band]");
      if (add && !entry.bands.includes(add.dataset.addBand)) {
        snapshotSchedule();
        entry.bands.push(add.dataset.addBand);
        saveSettings(); renderSchedule(); renderSlotPopover(); positionSlotPopover(); render();
        return;
      }
      const remove = event.target.closest("[data-remove-band]");
      if (remove) {
        snapshotSchedule();
        entry.bands.splice(Number(remove.dataset.removeBand), 1);
        saveSettings(); renderSchedule(); renderSlotPopover(); positionSlotPopover(); render();
        return;
      }
      const move = event.target.closest("[data-move-band]");
      if (move) {
        const from = Number(move.dataset.moveBand);
        const to = from + Number(move.dataset.direction);
        if (to >= 0 && to < entry.bands.length) {
          snapshotSchedule();
          [entry.bands[from], entry.bands[to]] = [entry.bands[to], entry.bands[from]];
          saveSettings(); renderSchedule(); renderSlotPopover(); positionSlotPopover(); render();
        }
        return;
      }
      if (event.target.closest("[data-remove-change]")) {
        removeChange(editingSlot);
        closeSlotPopover(); renderSchedule(); render();
      }
    });
    document.addEventListener("click", () => {
      if (dom.schedulePopover.hidden) return;
      if (clickOrigin.popover || clickOrigin.timetable) return;
      closeSlotPopover();
    });
    dom.trxFrequency.addEventListener("click", () => {
      const opening = dom.frequencyMenu.hidden;
      if (opening) renderFrequencyMenu();
      dom.frequencyMenu.hidden = !opening;
      dom.trxFrequency.setAttribute("aria-expanded", String(opening));
    });
    dom.frequencyMenu.addEventListener("click", event => {
      if (event.target.closest("[data-menu-close]")) { closeFrequencyMenu(); return; }
      const button = event.target.closest("[data-frequency]");
      if (button && !button.disabled) requestFrequency(Number(button.dataset.frequency));
    });
    dom.scheduleClose.addEventListener("click", closeTimetablePanel);
    // The schedule now lives in the topbar, as it does on JS8Call.
    dom.freqTimetableButton.addEventListener("click", () => {
      const opening = dom.freqTimetablePanel.hidden;
      dom.freqTimetablePanel.hidden = !opening;
      dom.freqTimetableButton.setAttribute("aria-expanded", String(opening));
      if (opening) renderSchedule(); else closeTimetablePanel();
    });
    // Where a click came from has to be decided in the capture phase, before the
    // handlers below rebuild the grid or the popover. Once innerHTML has been
    // replaced the event target is detached, closest() can no longer see the panel
    // above it, and the "clicked outside" logic then closed the panel on every
    // single edit.
    document.addEventListener("click", event => {
      clickOrigin = {
        timetable: Boolean(event.target.closest(".tt-control")),
        popover: Boolean(event.target.closest(".tt-popover") ||
                         event.target.closest("[data-change-slot]")),
      };
    }, true);
    document.addEventListener("click", () => {
      if (dom.freqTimetablePanel.hidden) return;
      if (clickOrigin.timetable) return;
      closeTimetablePanel();
    });
    document.addEventListener("click", event => {
      if (dom.frequencyMenu.hidden) return;
      if (event.target.closest("#frequencyMenu") || event.target.closest("#trxFrequency")) return;
      closeFrequencyMenu();
    });
    addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      closeTimetablePanel();
      closeFrequencyMenu();
    });
    dom.trxHelpButton.addEventListener("click", () => openSetupHelp("manual"));
    dom.trxHelpDialog.addEventListener("click", event => {
      if (event.target === dom.trxHelpDialog) dom.trxHelpDialog.close();
    });
    // Same endpoint the JS8Call page uses (data.js reconnectRadio): a POST with
    // no body, answered 202 by whichever slot owns the LAN radio.
    dom.trxReconnect.addEventListener("click", async () => {
      dom.trxReconnect.disabled = true;
      try {
        const response = await fetch("/lan/reconnect", {method: "POST",
          signal: fetchDeadline(FETCH_FLASH_TIMEOUT_MS)});
        if (!response.ok) throw new Error(`reconnect failed (HTTP ${response.status})`);
        state.lastError = "";
      } catch (error) {
        state.lastError = String(error.message || error);
      }
      dom.trxReconnect.disabled = false;
      render();
    });
    window.addEventListener("resize", () => waterfall.resize());
    dom.txSafety.addEventListener("change", () => {
      saveShared({txSafetyAccepted: dom.txSafety.checked});
      render();
    });
    dom.startStop.addEventListener("click", () => {
      if (state.beacon === "stopped") startBeacon(); else stopBeacon();
    });
    dom.tuneButton.addEventListener("click", () => {
      if (state.beacon === "tuning") stopTune(); else startTune();
    });
    dom.sessionTakeover.addEventListener("click", () => claimSession(true));
    dom.activityDays.addEventListener("change", () => {
      state.activityRange = ACTIVITY_RANGES[dom.activityDays.value] ? dom.activityDays.value : "6h";
      state.selectedCell = null;
      dom.activityDetail.hidden = true;
      renderActivity();
    });
    dom.activityBands.addEventListener("click", event => {
      const chip = event.target.closest("[data-filter-band]");
      if (!chip) return;
      state.bandFilter = chip.dataset.filterBand;
      // The selection points at a cell of the grid being replaced, so it cannot
      // survive the filter change.
      state.selectedCell = null;
      dom.activityDetail.hidden = true;
      renderActivity();
    });
    dom.activityGrid.addEventListener("click", event => {
      const cell = event.target.closest("[data-row]");
      if (!cell) return;
      const key = `${cell.dataset.row}:${cell.dataset.column}`;
      if (state.selectedCell === key) {
        state.selectedCell = null;
        dom.activityDetail.hidden = true;
        renderActivity();
        return;
      }
      showCellDetail(Number(cell.dataset.row), Number(cell.dataset.column));
    });
  }

  // ---- boot -----------------------------------------------------------------

  // Nothing starts until ICOM-LAN is known to be configured -- not the session
  // claim either. The beacon cannot key a radio it has no audio path to, and
  // taking the single-operator lease in that state would lock a working JS8LAN
  // out of the radio for no reason.
  LanGate.gate().then(ready => {
    if (!ready) return;

    // Open the guide on the model this radio reported last time, until a live
    // answer replaces it. radioSlots[].model survives a reboot for exactly this.
    if (typeof TrxHelp !== "undefined") {
      const slot = LanGate.slot ? LanGate.slot() : 0;
      const config = LanGate.config() || {};
      if (slot) TrxHelp.setReportedModel(config[`trx${slot}model`] || "");
    }

    loadSettings();
    populateSelects();
    // The interface owns the callsign and the locator; this page's copy of them
    // is a cache. Without this a second tablet beacons under whatever the JS8
    // profile in ITS browser happens to say -- which on a fresh one is nothing.
    adoptStationProfile().then(changed => {
      if (!changed) return;
      populateSelects();
      dom.txGain.value = String(txGain());
      renderSchedule();
      render();
    });
    if (window.StationIdentity) {
      const localIdentity = () => ({call: sharedCall(), grid: sharedGrid()});
      const applyIdentity = changes => {
        if (changes.call !== undefined) saveShared({myCall: changes.call});
        if (changes.grid !== undefined) saveShared({grid: changes.grid});
        showIdentity();
        render();
      };
      window.StationIdentity.read().then(station => {
        const local = localIdentity();
        if (!window.StationIdentity.adopt(station, local, applyIdentity))
          return window.StationIdentity.promote(station, local);
      }).catch(() => {});
      // A beacon page is left open for days, which is exactly how long it used to
      // go on transmitting a callsign that had been changed in SETUP.
      identityWatch = window.StationIdentity.watch(localIdentity, applyIdentity);
    }
    showIdentity();
    dom.txGain.value = String(txGain());
    dom.activityDays.value = state.activityRange;
    wire();
    renderSchedule();
    renderActivity();
    renderClock();
    waterfall.resize();
    render();

    // Ninety days of retention keeps the database small enough to be irrelevant
    // (144 transmissions a day is about 800 kB) while still covering a season.
    WsprLog.prune().then(refreshActivity).catch(() => refreshActivity());

    claimSession();
    // #autogain only ARMS the panel. Arriving at a URL -- from SETUP, from a
    // bookmark, from browser history -- must never put RF on the air by itself,
    // so the carrier still waits for a click.
    // Both calibration panels live in SETTINGS, always. They used to be hidden until
    // #autogain, which is why an operator opening /wspr saw no calibration at all --
    // and the hash cannot be a safety gate anyway: showing a panel transmits nothing,
    // the carrier still waits for a click. #autogain now only OPENS the section, which
    // is what the link from SETUP needs it for.
    gainCal.arm(true);
    const readCalHash = () => {
      calArmed = location.hash === "#autogain";
      if (!calArmed) return;
      const section = dom.calField.closest("details");
      if (section) section.open = true;
      dom.calField.scrollIntoView({block: "nearest"});
      // The plan is its own window in the topbar; a deep link to the calibration
      // opens it too, so the link from SETUP lands on both halves of the tool.
      if (gainPlan) gainPlan.open();
    };
    readCalHash();
    window.addEventListener("hashchange", () => { readCalHash(); render(); });
    // The plan is the station's, so it arrives with the table rather than with the
    // page. reload() adopts it -- or seeds a usable first one when there is none.
    gainStore.load().then(() => { if (gainPlan) gainPlan.reload(); render(); });

    pollState();
    setInterval(pollState, STATE_POLL_MS);
    setInterval(renderClock, 1000);
    setInterval(() => { renderSchedule(); }, 60000);
    // The beacon's own heartbeat. Slot planning happens here; once a transmission
    // is queued, WsprTx is driven by inbound tx-level messages instead.
    beaconTimer = setInterval(() => {
      beaconTick();
      // Owes a write only after a page load or a real link return, and holds off
      // while the transmitter is keyed, so this is a no-op on almost every tick.
      applyAutoPower();
      if (tx) tx.tick();
      // Forward power is only meaningful while keyed, and /state reports it only
      // then (the poller reads SWR/power during TX and S-meter/supply otherwise).
      if (tx && tx.ptt && state.currentSession)
        state.currentSession.powerSamples.push(state.radio.powerMeterRaw);
      // The tune reference is the peak of a carrier, not whatever happened to be
      // polled when the operator let go of the button.
      if (tx && tx.ptt && state.beacon === "tuning")
        state.tunePeakRaw = Math.max(state.tunePeakRaw, state.radio.powerMeterRaw);
      // The calibration carrier has its own driver, so it needs its own pump and
      // its own meter feed. Peaks and the SWR watch matter only while it keys.
      gainCal.tick();
      if (state.calRunning)
        gainCal.noteMeters({powerMeterRaw: state.radio.powerMeterRaw, swr: state.radio.swr});
      // Only so the "waiting 4:12" line tells the truth. The plan itself is driven
      // by intents and by what the radio answers, never by this timer -- a hidden
      // tab throttles timers to once a second and the run must not care.
      if (gainPlan) gainPlan.tick();
      render();
    }, 500);

    // Exposed for tools/wspr-browser-smoke.js, which drives the real page. Its
    // absence is how the harness tells that the gate closed the page.
    globalThis.__wspr = {state, settings, nextTransmission, blockingReason,
                         radioBlockingReason, fullPower, radioPower, render,
                         recordSession, refreshActivity, renderActivity, onTxEvent,
                         renderSchedule, clockCorrectionMs, waterfall,
                         targetDbm, defaultPowerDbm, powerMismatch, offeredLevels,
                         get autoPower() {
                           return {appliedPercent, knobTouched, armed: autoPowerArmed};
                         },
                         referenceFor, storeReference, txGain,
                         // For tools/wspr-browser-smoke.js: the calibration is
                         // driven entirely by tx-level frames, so the harness
                         // needs to see where the search got to.
                         gainCal, gainPlan, gainStore, resolvedGain, beaconGuard,
                         get identityWatch() { return identityWatch; },
                         get calArmed() { return calArmed; },
                         scheduleView, addChange, saveSettings,
                         get editingSlot() { return editingSlot; },
                         get tx() { return tx; },
                         get sessionHeld() { return sessionHeld && sessionConfirmed; }};
  // The whole page is built inside one .then callback, so anything that throws
  // in it becomes an unhandled rejection and leaves a half-drawn beacon on
  // screen -- controls present, nothing behind them, and not a word to say so.
  // The DATA page died exactly this way on 2026-08-11 (a cached script against a
  // freshly served page), and this file was one commit away from the same fault.
  //
  // __wspr is assigned last, so its absence is already how the smoke harness
  // detects a page that did not finish; this makes the operator's copy of that
  // signal visible too.
  }).catch(error => {
    console.error("[wspr] startup failed:", error);
    const host = document.querySelector("main");
    if (!host) return;
    const card = document.createElement("section");
    // .gate-card is styled by lan-gate.js, which has already injected its sheet:
    // gate() runs before this chain can reject.
    card.className = "gate-card";
    card.setAttribute("role", "alert");
    card.innerHTML = '<div class="gate-card-icon" aria-hidden="true">!</div><div>'
      + "<h1>WSPR could not start</h1><p></p>"
      + "<p class=\"gate-card-note\">If this followed a firmware update, reload with "
      + "Ctrl+Shift+R: a script cached by the browser can be older than the page.</p>"
      + "</div>";
    card.querySelector("p").textContent = String((error && error.message) || error);
    host.insertBefore(card, host.firstChild);
  });
})();
