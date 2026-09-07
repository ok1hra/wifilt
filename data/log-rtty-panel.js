'use strict';
/**
 * log-rtty-panel.js — RTTY-ICOM, on the contest log
 *
 * A small movable palette carrying the minimum of RTTY-ICOM that a contest
 * operator actually watches while logging: the waterfall, the live spectrum,
 * and the decoded text. Fixed narrow width; the height is dragged, and the
 * extra height goes entirely to the RX log.
 *
 * WHY IT EXISTS AT ALL. Clicking a decoded word in the RTTY pop-up hands it to
 * QRPLog and puts the caret in Call or Exch -- and then the operator's Enter
 * goes to the POP-UP, because that is the window the click left focused. The
 * word arrives, the cursor does not, and the whole point of clicking a word is
 * that Enter then sends the macro which is next in the QSO. Focusing the log
 * window from the pop-up would fix the keyboard and break the eyes: it raises
 * QRPLog OVER the pop-up, hiding the waterfall exactly when it is being
 * watched. In one document the problem does not exist.
 *
 * Three rules shape everything here:
 *
 * 1. It must never take the keyboard away from the log. Buttons cancel their
 *    own mousedown (pa-panel.js's rule). The RX log cannot do the same --
 *    cancelling mousedown there would kill text selection -- so it captures
 *    the target field on POINTERDOWN, before the browser moves focus, and
 *    hands the word to that captured field afterwards. A click that turns out
 *    to be a drag-selection inserts nothing and takes no focus back, so
 *    Ctrl+C still works.
 *
 * 2. It is a full holder of the shared AUD1 session, or it is nothing. The
 *    interface has exactly ONE audio socket (wifilt.ino's AudioWsClient), so
 *    opening this palette takes the radio's audio from whatever holds it. It
 *    therefore claims the same js8lan.session lease JS8Call-ICOM/WSPR-Beacon/
 *    Mercury/RTTY-ICOM claim, shows the same "held elsewhere" card with the
 *    same TAKE OVER button, and -- crucially -- claims WITHOUT force when it
 *    is merely restoring a remembered open state, so reloading QRPLog never
 *    silently steals a running beacon.
 *
 * 3. No settings live here. Tone, shift, polarity, squelch, AFC, REVERSE,
 *    zoom and the gain calibration all stay on the full RTTY-ICOM page under
 *    the DATA tab; this palette reads the same stored settings and follows
 *    them live. What it owns is what is transient: what is being received,
 *    and what is going out right now.
 *
 * Everything that draws or decodes is shared with that page, not copied:
 * rtty-scope.js, rtty-rxlog.js, rtty-afsk-tx.js, rtty-afc.js, rtty-codec.js.
 *
 * Mounted with one script tag, carrying its own markup -- the pa-panel.js /
 * wake-lock.js pattern. Page-local by design: this belongs to QRPLog.
 */
(function (global) {

  var STORE_KEY = 'wifilt-rtty-panel';
  var AUDIO_WS_PORT = 83;
  var RX_AUDIO_RATE = 8000, TX_AUDIO_RATE = 48000;
  var STATE_POLL_MS = 1000;
  var SESSION_PING_MS = 5000, SESSION_RETRY_MS = 3000, SESSION_PROBE_MS = 250;
  var SESSION_TOKEN_KEY = 'js8lan.session.token.v1';
  var RX_LOG_MAX_CHARS = 6000;   // a palette, not the page: less scrollback
  // 320 is spectrum.js's own minWidth, so the waterfall's backing store is
  // never stretched. At the 500-2700 Hz base window that is 6.9 Hz/px, and a
  // 170 Hz shift lands 25 px apart -- comfortably clickable.
  var PANEL_W = 320;
  // The blocks above the RX log never change height, so the palette's own
  // height minus these two IS the decoded-text window -- which is what makes
  // "drag it taller, get more text" true rather than approximately true.
  var SCOPE_H = 81 + 2 + 64;   // live spectrum, the seam, waterfall
  var CHROME_H = 26;           // title bar plus the panel's own borders
  // Opens on about seven lines of text and grows from there (operator,
  // 2026-09-07: it used to open at twice this and took more of the contest log
  // than it had earned). The floor leaves under four lines, which is still a
  // readable exchange.
  var DEFAULT_H = SCOPE_H + CHROME_H + 128;
  var MIN_H = SCOPE_H + CHROME_H + 67;

  var open = false, pos = null, height = DEFAULT_H;
  // null until LanGate.read() has answered -- deliberately tri-state, so the
  // log's own button rule can tell "not configured" from "not asked yet" and
  // not flicker the button in on every page load.
  var el = null, btn = null, lanReady = null, lanSlot = 0;

  // ── stored geometry ───────────────────────────────────────────────────────
  //
  // Wrapped both ways: a private window refuses localStorage outright, and a
  // palette that throws on load would take the whole log's script with it.

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var v = JSON.parse(raw);
      if (v && typeof v === 'object') {
        open = !!v.open;
        if (typeof v.x === 'number' && typeof v.y === 'number') pos = { x: v.x, y: v.y };
        if (typeof v.height === 'number') height = v.height;
      }
    } catch (_) {}
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        open: open, x: pos ? pos.x : null, y: pos ? pos.y : null, height: height
      }));
    } catch (_) {}
  }

  // A stored position is only valid against the window it was stored in. Clamp
  // on every load and every resize, or a palette dragged to the right of a wide
  // screen is simply gone on a laptop, with no way to get it back.
  function clampSize() {
    var maxH = Math.max(MIN_H, global.innerHeight - 20);
    height = Math.min(Math.max(MIN_H, Math.round(height)), maxH);
    return height;
  }

  function clamp(p) {
    if (!p) return p;
    var w = el ? el.offsetWidth : PANEL_W;
    var h = el ? el.offsetHeight : height;
    var maxX = Math.max(0, global.innerWidth - w);
    var maxY = Math.max(0, global.innerHeight - h);
    return { x: Math.min(Math.max(0, p.x), maxX), y: Math.min(Math.max(0, p.y), maxY) };
  }

  // First ever opening: under the button that opened it, not in the middle of
  // the screen. The palette belongs to that button and should look like it.
  function anchorPos() {
    var r = btn ? btn.getBoundingClientRect() : null;
    if (!r) return { x: 20, y: 20 };
    var w = el ? el.offsetWidth : PANEL_W;
    var h = el ? el.offsetHeight : height;
    return clamp({ x: r.right - w, y: r.top - h - 8 });
  }

  function place() {
    if (!el) return;
    if (!pos) pos = anchorPos();
    pos = clamp(pos);
    el.style.left = pos.x + 'px';
    el.style.top = pos.y + 'px';
  }

  function mountDrag(handle) {
    var dragging = false, dx = 0, dy = 0;
    handle.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      dragging = true;
      dx = e.clientX - el.offsetLeft;
      dy = e.clientY - el.offsetTop;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();          // no text selection, and no focus change
    });
    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      pos = clamp({ x: e.clientX - dx, y: e.clientY - dy });
      el.style.left = pos.x + 'px';
      el.style.top = pos.y + 'px';
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      save();
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // ── settings, shared with the full page ───────────────────────────────────
  //
  // The same wifilt.data.rtty-settings store rtty.html writes. Read at open and
  // followed live: `storage` fires in THIS document when another tab writes, so
  // changing the tone or squelch on the full page lands here without a reload.
  // This palette never writes them -- it has no settings UI by design.

  var settings = RttySettings.defaults();

  function reloadSettings() {
    settings = RttySettings.load(localStorage);
    if (decoder) {
      decoder.setReverse(settings.reverse);
      decoder.setSquelchThreshold(settings.squelchThreshold);
      decoder.setToneOffset(settings.toneHz + (afc ? afc.offsetHz() : 0));
    }
    if (scope) scope.drawOverlay();
  }

  // ── the radio this palette listens to ─────────────────────────────────────
  //
  // /state?radio=lan, NOT the plain /state QRPLog itself polls: LAN may sit in
  // any one of the three TRX slots (wifilt.ino's LanRadioSnapshot), and plain
  // /state is TRX1's own CAT globals. Using the log's app.mode here would pick
  // the wrong radio's mode the moment the operator works another slot -- and
  // mode is what decides FSK versus AFSK on transmit.

  var radio = { frequency: 0, mode: '', tx: false, rfPower: 0, rfPowerSeen: false, model: '' };
  var statePollTimer = null;

  function pollState() {
    clearTimeout(statePollTimer);
    if (!open) return;
    fetch('/state?radio=lan', { cache: 'no-store', signal: AbortSignal.timeout(4000) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        radio.frequency = Number(d.frequency) || 0;
        radio.mode = String(d.mode || '').trim();
        radio.tx = !!d.tx;
        radio.rfPower = Number(d.rfPower) || 0;
        radio.rfPowerSeen = d.rfPowerSeen === true;
        radio.model = String(d.radioName || d.transceiverType || '').trim();
      })
      .catch(function () {})
      .finally(function () {
        renderState();
        statePollTimer = setTimeout(pollState, STATE_POLL_MS);
      });
  }

  // ── the shared single-operator lease ──────────────────────────────────────
  //
  // Same shape as rtty.js's and wspr.js's own claim/ping/release, deliberately
  // kept as its own copy rather than shared -- those two already are copies of
  // each other, with the reasoning written out there.
  //
  // The BroadcastChannel probe is NOT optional here. A pop-up opened from this
  // very page with window.open inherits a COPY of sessionStorage, so it carries
  // the identical token and the firmware cannot tell the two apart; without the
  // probe they would take turns kicking each other's audio socket with neither
  // ever being told.

  var sessionTokenCache = null, sessionHeld = false, sessionRetryTimer = null,
      sessionSince = 0, sessionLocalHolder = null, session = null;

  function makeToken() {
    var bytes = new Uint8Array(16);
    if (global.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(bytes, function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  function sessionToken() {
    if (sessionTokenCache) return sessionTokenCache;
    var token = null;
    try { token = sessionStorage.getItem(SESSION_TOKEN_KEY); } catch (_) {}
    if (!token) {
      token = makeToken();
      try { sessionStorage.setItem(SESSION_TOKEN_KEY, token); } catch (_) {}
    }
    sessionTokenCache = token;
    return token;
  }

  var pageId = makeToken();
  var sessionChannel = (function () {
    try { return new BroadcastChannel('js8lan.session'); } catch (_) { return null; }
  }());
  if (sessionChannel) sessionChannel.onmessage = function (event) {
    var message = event.data || {};
    if (message.id === pageId) return;
    if (message.type === 'probe' && sessionHeld)
      sessionChannel.postMessage({ type: 'held', id: pageId, since: sessionSince });
    if (message.type === 'held') sessionLocalHolder = { id: message.id, since: Number(message.since) || 0 };
    if (message.type === 'released' && !sessionHeld && open) scheduleSessionRetry(200);
    if (message.type === 'evict' && sessionHeld) loseSession({});
  };

  function probeLocalHolder() {
    if (!sessionChannel) return Promise.resolve(null);
    sessionLocalHolder = null;
    sessionChannel.postMessage({ type: 'probe', id: pageId });
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(sessionLocalHolder); }, SESSION_PROBE_MS);
    });
  }

  function localHolderOutranks(holder) {
    if (!holder) return false;
    if (holder.since !== sessionSince) return holder.since < sessionSince;
    return holder.id < pageId;
  }

  function sessionPost(path, extra) {
    var body = Object.assign({ token: sessionToken() }, extra || {});
    return fetch(path, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (response) {
      if (response.status !== 409) return { granted: true };
      return response.json().catch(function () { return {}; }).then(function (info) {
        return { granted: false, owner: info.owner || '', ageMs: Number(info.ageMs) || 0 };
      });
    }).catch(function () { return { granted: true }; });
  }

  function scheduleSessionRetry(delayMs) {
    if (sessionRetryTimer) clearTimeout(sessionRetryTimer);
    sessionRetryTimer = setTimeout(function () { claimSession(false); },
      typeof delayMs === 'number' ? delayMs : SESSION_RETRY_MS);
  }

  function markHeld() {
    sessionHeld = true;
    sessionSince = Date.now();
    if (sessionRetryTimer) { clearTimeout(sessionRetryTimer); sessionRetryTimer = null; }
    openAudio();
    renderState();
  }

  function loseSession(info) {
    if (afskTx) afskTx.abort('session lost');
    closeAudio();
    sessionHeld = false;
    if (open) scheduleSessionRetry();
    renderState(info && info.owner ? String(info.owner) : '');
  }

  function claimSession(force) {
    return probeLocalHolder().then(function (holder) {
      if (holder && localHolderOutranks(holder) && !force) {
        loseSession({ owner: 'another tab in this browser' });
        return;
      }
      return sessionPost('/js8/session/claim', { force: !!force, role: 'rtty' })
        .then(function (claim) {
          if (!claim.granted) { loseSession(claim); return; }
          markHeld();
        });
    });
  }

  function releaseSession() {
    // Abort first, not just reset: closing the palette mid-message would
    // otherwise clear the pacer without ever settling send()'s promise, and
    // log.js -- which has no timeout on this path, unlike the BroadcastChannel
    // one -- would wait for a result that can no longer come.
    if (afskTx && afskTx.busy()) afskTx.abort('the RTTY palette was closed');
    if (!sessionHeld) return;
    if (sessionChannel) sessionChannel.postMessage({ type: 'released', id: pageId });
    sessionHeld = false;
    closeAudio();
    // keepalive so the release still goes out while the tab is being torn down
    try {
      fetch('/js8/session/release', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: sessionToken() })
      }).catch(function () {});
    } catch (_) {}
  }

  setInterval(function () {
    if (!sessionHeld) return;
    sessionPost('/js8/session/ping', { role: 'rtty' }).then(function (ping) {
      if (!ping.granted) loseSession(ping);
    });
  }, SESSION_PING_MS);

  global.addEventListener('pagehide', releaseSession);

  // ── the audio socket ──────────────────────────────────────────────────────

  function audioUrl() {
    var scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return scheme + '://' + location.hostname + ':' + AUDIO_WS_PORT +
           '/audiows?token=' + encodeURIComponent(sessionToken());
  }

  function openAudio() {
    if (session) return session;
    session = new Js8Aud1Transport.Aud1WebSocketSession({
      url: audioUrl(), WebSocketImpl: WebSocket, wallNow: function () { return Date.now(); }
    }).onStatus(renderState);
    session.onSamples(onSamples);
    session.start();
    return session;
  }

  function closeAudio() {
    if (afskTx) afskTx.reset();
    if (session) { session.stop(); session = null; }
  }

  function onSamples(samples) {
    // Blank during this station's own TX, same as the page and as
    // JS8/WSPR/Mercury -- the LAN audio path is itself duplex, so without this
    // the waterfall would show our own signal as if it were received.
    if (session && session.ptt) return;
    if (decoder) decoder.pushSamples(samples);
    if (scope) scope.ingest(samples);
  }

  // ── decode, scope, AFC, transmit ──────────────────────────────────────────

  var decoder = null, scope = null, rxLog = null, afc = null, afskTx = null;
  var gainStore = null, modLevelClient = null, modLevel = 0;

  function buildEngine() {
    decoder = new RttyCodec.Decoder(RX_AUDIO_RATE, {
      toneHz: settings.toneHz, reverse: settings.reverse,
      squelchThreshold: settings.squelchThreshold
    });

    rxLog = RttyRxLog.create({
      el: document.getElementById('rttyPanelRx'),
      maxChars: RX_LOG_MAX_CHARS,
      // Resolved against the PALETTE, not documentElement: QRPLog's own :root
      // is light and defines neither --muted nor --panel2, while this palette
      // carries the dark ones the full page uses.
      floorRgb: RttyRxLog.floorRgbFrom(el),
      onToken: onTokenClicked
    });

    decoder.onChar(function (ch, meta) { rxLog.pushChar(ch, meta); });
    decoder.onEvent(function (evt) {
      if (evt.type !== 'squelch' || !evt.open || !settings.squelchNewlineEnabled) return;
      rxLog.squelchBreak();
    });

    afc = RttyAfc.createTracker({
      settings: function () { return settings; },
      liveValues: function () { return scope.waterfall.state().liveValues; },
      window: function () {
        return { lowHz: scope.waterfall.lowHz, highHz: scope.waterfall.highHz };
      },
      markSpace: function () { return RttyScope.expectedMarkSpaceHz(settings); },
      squelchOpen: function () { return decoder.squelchOpen; },
      onOffset: function (offsetHz) { decoder.setToneOffset(settings.toneHz + offsetHz); },
      charDurationMs: RttyCodec.CHAR_DURATION_MS
    });

    scope = RttyScope.create({
      scopeEl: document.getElementById('rttyPanelScope'),
      liveCanvas: document.getElementById('rttyPanelLiveCanvas'),
      liveContainer: document.getElementById('rttyPanelLive'),
      waterfallCanvas: document.getElementById('rttyPanelWaterfallCanvas'),
      waterfallContainer: document.getElementById('rttyPanelWaterfall'),
      overlayCanvas: document.getElementById('rttyPanelOverlay'),
      sampleRate: RX_AUDIO_RATE,
      baseLowHz: RttySettings.TONE_MIN_HZ, baseHighHz: RttySettings.TONE_MAX_HZ,
      settings: function () { return settings; },
      afcOffsetHz: function () { return afc.offsetHz(); },
      radio: function () { return radio; },
      onFrame: function () { afc.tick(); },
      onTune: onScopeTune
    });

    gainStore = new TxGainCal.TxGainStore();
    gainStore.load();
    modLevelClient = new TxGainModLevel.ModLevelClient({
      send: function (payload) {
        return fetch('/cmd?radio=lan', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      },
      model: function () { return radio.model; }
    });

    afskTx = RttyAfskTx.create({
      session: function () { return session; },
      settings: function () { return settings; },
      gain: resolvedGain,
      sampleRate: TX_AUDIO_RATE,
      onEcho: function (text) { return rxLog.echoTx(text); },
      onEchoFailed: function (echo) { rxLog.markEchoFailed(echo); },
      onFinish: onTxFinished,
      onTick: renderTx
    });
  }

  // The shared /txgain.json table, read exactly the way the four DATA pages
  // read it -- through TxGainCal.resolveGain(), so a knee measured at another
  // MOD level counts as uncalibrated here too rather than being transmitted
  // from. Uncalibrated means the encoder keeps its own historical default,
  // which is what RTTY did before calibration existed; the TX strip says so.
  function resolvedGain() {
    return TxGainCal.resolveGain({
      store: gainStore,
      identity: TxGainCal.identityFor({
        model: radio.model,
        frequencyHz: radio.frequency,
        percent: WsprCore.civPercent(radio.rfPower),
        rfPowerSeen: radio.rfPowerSeen
      }),
      modLevel: modLevel,
      manualGain: 0
    });
  }

  // Click-to-tune, exactly the page's own two branches: real FSK has no audio
  // stage on TX, so only the dial can bring a station into the passband;
  // USB-D/LSB-D move the audio tone instead. The palette has no tone field to
  // update, so it writes the setting and redraws.
  function onScopeTune(lowHz) {
    if (radio.mode === 'RTTY' || radio.mode === 'RTTY-R') {
      var referenceLowHz = settings.toneHz - RttyCodec.SHIFT_HZ / 2;
      var newDialHz = Math.round((radio.frequency || 0) + (referenceLowHz - lowHz));
      if (newDialHz <= 0) return;
      fetch('/cmd?radio=lan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'setFrequency', frequency: String(newDialHz) })
      }).catch(function () {});
      afc.reset();
      return;
    }
    var clamped = Math.max(RttySettings.TONE_MIN_HZ,
      Math.min(RttySettings.TONE_MAX_HZ, lowHz));
    settings.toneHz = clamped + RttyCodec.SHIFT_HZ / 2;
    // Take back what save() normalized, rather than keeping the raw value in
    // memory: otherwise a tone the store clamped would leave this palette and
    // the full RTTY page disagreeing about the same setting until a reload.
    settings = RttySettings.save(localStorage, settings);
    afc.reset();
    scope.drawOverlay();
  }

  // ── handing a word to the log ─────────────────────────────────────────────
  //
  // THE reason this palette exists. The field has to be captured on
  // pointerdown: the RX log is a plain div, so clicking it moves focus to the
  // body and blurs Call/Exch before any click handler runs -- and then
  // "whichever field the operator was in" has already been forgotten. Same
  // race log.js documents around selectTrx(), one step earlier.
  //
  // mousedown is deliberately NOT cancelled here (unlike the buttons): that
  // would kill text selection inside the RX log, and reading a decoded
  // exchange out of it with the mouse is worth keeping.

  var pendingField = null;

  function onRxPointerDown() {
    pendingField = global.LogRadio && global.LogRadio.focusedField
      ? global.LogRadio.focusedField() : null;
  }

  function onTokenClicked(word) {
    // A drag across several words is a selection, not an insert. Leave both
    // the text and the focus alone so Ctrl+C does what the operator meant.
    var selection = global.getSelection ? global.getSelection() : null;
    if (selection && !selection.isCollapsed) return;
    if (!global.LogRadio || !global.LogRadio.insertWord) return;
    global.LogRadio.insertWord(word, lanSlot, pendingField);
    pendingField = null;
  }

  // ── transmit, driven from QRPLog alone ────────────────────────────────────

  var txResolve = null, txReject = null;

  // Called by log.js instead of its BroadcastChannel hand-off whenever this
  // palette holds the session -- BroadcastChannel does not deliver to the
  // posting context, so with the palette open the old path would simply time
  // out. Resolves when the message has actually gone out, matching the promise
  // contract sendViaRttyIcomPage() already had.
  function send(text) {
    return new Promise(function (resolve, reject) {
      if (afskTx && afskTx.busyOrStarting())
        return reject(new Error('the RTTY palette is busy with another transmission'));
      if (!sessionHeld || !session || !session.hello)
        return reject(new Error('the RTTY palette does not hold the audio session'));
      txResolve = resolve; txReject = reject;
      afskTx.start(text).catch(function (error) {
        txResolve = txReject = null;
        reject(error);
      });
    });
  }

  function onTxFinished(error) {
    var resolve = txResolve, reject = txReject;
    txResolve = txReject = null;
    if (error) { if (reject) reject(new Error(error)); }
    else if (resolve) resolve();
    renderTx();
  }

  // The module owns the window arithmetic (including why 100 % is the fixed
  // base range and not tone-centred like the other two); this owns the pills.
  function applyZoom(percent) {
    if (!scope) return;
    scope.setZoom(percent);
    var pills = document.getElementById('rttyPanelZoom').querySelectorAll('button');
    Array.prototype.forEach.call(pills, function (pill) {
      pill.classList.toggle('active', Number(pill.dataset.zoom) === percent);
    });
  }

  function renderTx() {
    if (!el) return;
    var strip = document.getElementById('rttyPanelTx');
    var busy = afskTx && afskTx.busy();
    strip.hidden = !busy;
    el.classList.toggle('rtty-panel-tx-on', !!busy);
    if (!busy) return;
    var pct = Math.round(afskTx.progress() * 100);
    var gain = resolvedGain();
    document.getElementById('rttyPanelTxLabel').textContent =
      'TX ' + pct + ' %' + (gain.calibrated ? '' : ' · uncalibrated');
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function renderState(owner) {
    if (!el) return;
    var busyCard = document.getElementById('rttyPanelBusy');
    busyCard.hidden = sessionHeld;
    if (!sessionHeld && typeof owner === 'string')
      document.getElementById('rttyPanelBusyWhere').textContent =
        owner ? 'held by ' + owner : '';
    var live = sessionHeld && session && session.hello;
    // The title line is the only status this palette shows. Without it a
    // silent waterfall is ambiguous: no signal, or no audio at all?
    document.getElementById('rttyPanelState').textContent =
      !sessionHeld ? 'no audio' : live ? (radio.mode || '') : 'connecting…';
  }

  // ── build ─────────────────────────────────────────────────────────────────

  function build() {
    el = document.createElement('div');
    el.className = 'rtty-panel';
    el.id = 'rttyPanel';
    el.style.height = clampSize() + 'px';
    el.innerHTML =
      '<div class="rtty-panel-head" id="rttyPanelHead">' +
        '<span class="rtty-panel-title">RTTY</span>' +
        // Zoom is view state, not a setting: it is never persisted (the full
        // page does not persist it either), it is centred on the tone as it
        // stands at the moment it is pressed rather than continuously, and it
        // is glanced at while tuning. That is why it earns header space when
        // squelch and REVERSE do not.
        '<span class="rtty-panel-zoom" id="rttyPanelZoom" role="group" ' +
          'aria-label="Waterfall zoom" title="Zoom the waterfall around the current tone">' +
          '<button type="button" data-zoom="100" class="active">100%</button>' +
          '<button type="button" data-zoom="200">200%</button>' +
          '<button type="button" data-zoom="400">400%</button>' +
        '</span>' +
        '<span class="rtty-panel-state" id="rttyPanelState"></span>' +
        '<button class="rtty-panel-close" id="rttyPanelClose" type="button" ' +
          'title="Close (releases the radio audio)">×</button>' +
      '</div>' +
      '<div class="rtty-panel-scope" id="rttyPanelScope" ' +
        'title="Receiver audio. Click to tune. Blank during this station\'s own TX.">' +
        '<div class="rtty-panel-live" id="rttyPanelLive">' +
          '<canvas id="rttyPanelLiveCanvas" width="1024" height="81"></canvas></div>' +
        '<div class="rtty-panel-waterfall" id="rttyPanelWaterfall">' +
          '<canvas id="rttyPanelWaterfallCanvas" width="320" height="64"></canvas></div>' +
        '<canvas class="rtty-panel-overlay" id="rttyPanelOverlay"></canvas>' +
      '</div>' +
      '<div class="rtty-panel-rx" id="rttyPanelRx" aria-live="polite"></div>' +
      '<div class="rtty-panel-tx" id="rttyPanelTx" hidden>' +
        '<span id="rttyPanelTxLabel">TX</span>' +
        '<button id="rttyPanelTxAbort" type="button">ABORT</button>' +
      '</div>' +
      '<section class="rtty-panel-busy" id="rttyPanelBusy" hidden role="alert">' +
        '<b>The radio is driven from somewhere else</b>' +
        '<p>One radio, one operator: JS8Call-ICOM, WSPR-Beacon, Mercury and ' +
           'RTTY-ICOM all drive the transceiver through a single audio link.</p>' +
        '<p id="rttyPanelBusyWhere"></p>' +
        '<button id="rttyPanelTakeover" type="button">TAKE THE SESSION OVER HERE</button>' +
      '</section>';
    document.body.appendChild(el);

    // pa-panel.js's rule: cancel mousedown on everything clickable, so the
    // click still happens but the caret never leaves Call or Exch. The RX log
    // is the deliberate exception -- see onRxPointerDown() above.
    el.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) e.preventDefault();
    });

    mountDrag(document.getElementById('rttyPanelHead'));
    document.getElementById('rttyPanelClose')
      .addEventListener('click', function () { setOpen(false); });
    document.getElementById('rttyPanelTakeover')
      .addEventListener('click', function () { claimSession(true); });
    document.getElementById('rttyPanelTxAbort')
      .addEventListener('click', function () { afskTx.abort('operator'); });
    document.getElementById('rttyPanelRx')
      .addEventListener('pointerdown', onRxPointerDown);
    document.getElementById('rttyPanelZoom').addEventListener('click', function (e) {
      var pill = e.target.closest('button');
      if (pill) applyZoom(Number(pill.dataset.zoom));
    });

    buildEngine();

    // Native vertical resize, so the grab handle is the browser's own. The
    // scope is a fixed block and the RX log is the flex child, so every pixel
    // added goes to the decoded text -- which is the point of resizing at all.
    if (global.ResizeObserver) {
      new ResizeObserver(function () {
        if (!open || !el) return;
        height = el.offsetHeight;
        scope.resize();
        save();
      }).observe(el);
    }
  }

  // ── open / close ──────────────────────────────────────────────────────────

  function setOpen(v) {
    var wanted = !!v;
    // No ICOM-LAN link means no audio to listen to. Only a definite no blocks
    // it: lanReady is null until LanGate.read() answers, and refusing during
    // that first moment would make the button dead on a fast click.
    if (wanted && lanReady === false) return;
    if (wanted === open && el) return;
    open = wanted;
    if (open && !el) build();
    if (el) el.style.display = open ? '' : 'none';
    if (open) {
      reloadSettings();
      place();
      scope.resize();
      scope.start();
      renderState('');
      renderTx();
      // WITHOUT force. Restoring a remembered "open" on a page reload must
      // never silently take the radio from a running beacon on another
      // machine -- the operator asks for that explicitly, with TAKE OVER.
      claimSession(false);
      pollState();
      readModLevel();
    } else {
      if (sessionRetryTimer) { clearTimeout(sessionRetryTimer); sessionRetryTimer = null; }
      clearTimeout(statePollTimer);
      // stop(), not destroy(): the same DOM is shown again on the next
      // opening, and destroy() would unbind click-to-tune with it.
      if (scope) scope.stop();
      releaseSession();
    }
    save();
  }

  function readModLevel() {
    if (!modLevelClient || !radio.model) return;
    modLevelClient.readLevel()
      .then(function (level) { if (level !== null) modLevel = level; })
      .catch(function () {});
  }

  // ── mount ─────────────────────────────────────────────────────────────────
  //
  // The button is the log's existing RTTY one, which used to open the pop-up.
  // Its mode-driven visibility stays in log.js; this only adds the second
  // condition -- an ICOM-LAN link that is actually configured, read through
  // LanGate.read() and never LanGate.gate(), whose CSS would blank the log.

  function mount() {
    btn = document.getElementById('btnRttyPopup');
    if (!btn) return;
    load();
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function () { setOpen(!open); });

    global.addEventListener('resize', function () {
      if (!el || !open) return;
      el.style.height = clampSize() + 'px';
      pos = clamp(pos);
      place();
      if (scope) scope.resize();
      save();
    });

    // Another tab changed the shared RTTY settings on the full page.
    global.addEventListener('storage', function (e) {
      if (e.key === RttySettings.STORAGE_KEY) reloadSettings();
    });

    // read(), never gate(): gate() injects lan-gate.js's own CSS and sets
    // body.lan-gate-checking/-blocked, which would blank the whole contest log.
    // read() only answers the question and touches nothing.
    LanGate.read(document).then(function (outcome) {
      lanReady = !!(outcome && outcome.ready);
      lanSlot = (outcome && outcome.slot) || 0;
      // A remembered "open" is honoured only once the link is known to exist.
      // Without a link there is nothing to listen to, so the palette stays
      // shut -- and is closed again if the operator managed to click the
      // button during the moment before this answer arrived, rather than
      // being left sitting on "connecting..." forever.
      if (lanReady) { if (open) setOpen(true); }
      else if (open) setOpen(false);
    }).catch(function () { lanReady = false; });
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', mount);
  else
    mount();

  // What log.js and the smoke harness may ask of this palette. Narrow on
  // purpose: three questions and two commands, nothing about internals.
  global.RttyPanel = {
    setOpen: setOpen,
    isOpen: function () { return open; },
    // null = not asked yet, so callers can distinguish it from a real no.
    lanReady: function () { return lanReady; },
    holdsSession: function () { return sessionHeld && !!session && !!session.hello; },
    txBusy: function () { return !!afskTx && afskTx.busy(); },
    send: send,
    abort: function () { if (afskTx) afskTx.abort('operator'); },
    getState: function () {
      return { open: open, held: sessionHeld, height: height, radio: radio,
               settings: settings, zoom: scope ? scope.zoom() : 100 };
    }
  };

}(window));
