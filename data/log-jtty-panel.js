'use strict';
/**
 * log-jtty-panel.js — JTTY, on the contest log
 *
 * The JTTY counterpart of log-rtty-panel.js, built to the same three rules
 * (docs/jtty-implementace.md §7):
 *
 * 1. It never takes the keyboard away from the log. Buttons cancel their own
 *    mousedown; the RX log captures the target field on POINTERDOWN and hands
 *    a clicked word to that field afterwards, so Enter still sends the macro
 *    that is next in the QSO.
 *
 * 2. It is a full holder of the shared AUD1 session (role "jtty"), or it is
 *    nothing: the same lease, the same "held elsewhere" card, and a claim
 *    WITHOUT force when it only restores a remembered open state. It and the
 *    RTTY palette share this tab's session token, so only one of the two is
 *    ever open -- opening one closes the other.
 *
 * 3. No settings live here. RX/TX offset, F Tol, search band and Hold TX are
 *    the JTTY page's (jtty-settings.js), read live; what this owns is what is
 *    received and what is going out now. Whole messages only: live entry is
 *    the JTTY page's, a contest exchange is a macro.
 *
 * What the palette shows is the page's RX-frequency view: messages within
 * ±70 Hz of the RX offset, and anything with this station's call. Click on
 * the waterfall: listen (and answer) there; double-click a line: tune to that
 * station and take its call.
 *
 * Everything that draws, decodes or transmits is shared with the page, not
 * copied: jtty-scope.js, jtty-rxlog.js, jtty-rx.js, jtty-tx.js.
 */
(function (global) {

  var STORE_KEY = 'wifilt-jtty-panel';
  var AUDIO_WS_PORT = Number((global.WIFILT_PORTS || {}).audio) || 83;
  var RX_AUDIO_RATE = 8000;
  var STATE_POLL_MS = 1000;
  var SESSION_PING_MS = 5000, SESSION_RETRY_MS = 3000, SESSION_PROBE_MS = 250;
  var SESSION_TOKEN_KEY = 'js8lan.session.token.v1';
  // Switching over from the RTTY palette: its release beacon goes out with the
  // same token this claim uses, so the claim waits until that has landed.
  var HANDOVER_MS = 400;
  var PANEL_W = 360;
  var SCOPE_H = 81 + 2 + 64;
  var CHROME_H = 26;
  var DEFAULT_H = SCOPE_H + CHROME_H + 128;
  var MIN_H = SCOPE_H + CHROME_H + 67;

  var open = false, pos = null, height = DEFAULT_H, width = PANEL_W;
  var gap = null, placed = null;
  var el = null, btn = null, lanReady = null, lanSlot = 0;

  // ── geometry (log-rtty-panel.js, the same rules) ─────────────────────────

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var v = JSON.parse(raw);
      if (v && typeof v === 'object') {
        open = !!v.open;
        if (typeof v.x === 'number' && typeof v.y === 'number') pos = { x: v.x, y: v.y };
        if (typeof v.height === 'number') height = v.height;
        if (typeof v.width === 'number') width = v.width;
        if (typeof v.gap === 'number') gap = v.gap;
      }
    } catch (_) {}
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        open: open, x: pos ? pos.x : null, y: pos ? pos.y : null,
        height: height, width: width, gap: gap
      }));
    } catch (_) {}
  }

  function clampSize() {
    var maxH = Math.max(MIN_H, global.innerHeight - 20);
    height = Math.min(Math.max(MIN_H, Math.round(height)), maxH);
    return height;
  }

  function clampWidth() {
    var maxW = Math.max(PANEL_W, global.innerWidth - 20);
    width = Math.min(Math.max(PANEL_W, Math.round(width)), maxW);
    return width;
  }

  function clamp(p) {
    if (!p) return p;
    var w = el ? el.offsetWidth : PANEL_W;
    var h = el ? el.offsetHeight : height;
    return { x: Math.min(Math.max(0, p.x), Math.max(0, global.innerWidth - w)),
             y: Math.min(Math.max(0, p.y), Math.max(0, global.innerHeight - h)) };
  }

  function anchorPos() {
    var r = btn ? btn.getBoundingClientRect() : null;
    if (!r) return { x: 20, y: 20 };
    var w = el ? el.offsetWidth : PANEL_W;
    var h = el ? el.offsetHeight : height;
    return clamp({ x: r.right - w, y: r.top - h - 8 });
  }

  function place() {
    if (!el) return;
    var h = el.offsetHeight;
    if (!pos) pos = anchorPos();
    if (gap === null) gap = global.innerHeight - (pos.y + h);
    pos = clamp({ x: pos.x, y: global.innerHeight - h - gap });
    el.style.left = pos.x + 'px';
    el.style.top = pos.y + 'px';
    placed = { y: pos.y, h: h };
  }

  function syncGap(force) {
    if (!el || !pos) return;
    var h = el.offsetHeight;
    if (!force && placed && placed.y === pos.y && placed.h === h) return;
    gap = global.innerHeight - (pos.y + h);
    placed = { y: pos.y, h: h };
  }

  function mountDrag(handle) {
    var dragging = false, dx = 0, dy = 0;
    handle.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      dragging = true;
      dx = e.clientX - el.offsetLeft;
      dy = e.clientY - el.offsetTop;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
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
      syncGap(true);
      save();
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // ── settings (the JTTY page's, followed live) ─────────────────────────────

  var settings = JttySettings.load(localStorage);

  function reloadSettings() {
    settings = JttySettings.load(localStorage);
    if (receiver) receiver.configure(receiverConfig());
    if (rxView && store) rxView.refilter(store.all());
    if (scope) scope.drawOverlay();
  }

  function saveSettings() { settings = JttySettings.save(localStorage, settings); }

  function receiverConfig() {
    var band = JttySettings.SEARCH[settings.search];
    return { rxHz: settings.rxHz, ftolHz: settings.ftolHz, searchLowHz: band.lowHz, searchHighHz: band.highHz };
  }

  // ── radio state ───────────────────────────────────────────────────────────

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

  // ── session lease (role "jtty") ───────────────────────────────────────────

  var sessionTokenCache = null, sessionHeld = false, sessionRetryTimer = null,
      sessionSince = 0, sessionLocalHolder = null, session = null;

  function makeToken() {
    var bytes = new Uint8Array(16);
    if (global.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
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
    if (jttyTx) jttyTx.abort('session lost');
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
      return sessionPost('/js8/session/claim', { force: !!force, role: 'jtty' })
        .then(function (claim) {
          if (!claim.granted) { loseSession(claim); return; }
          if (!open) return;
          markHeld();
        });
    });
  }

  function releaseSession() {
    if (jttyTx && jttyTx.busy()) jttyTx.abort('the JTTY palette was closed');
    if (!sessionHeld) return;
    if (sessionChannel) sessionChannel.postMessage({ type: 'released', id: pageId });
    sessionHeld = false;
    closeAudio();
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
    sessionPost('/js8/session/ping', { role: 'jtty' }).then(function (ping) {
      if (!ping.granted) loseSession(ping);
    });
  }, SESSION_PING_MS);

  global.addEventListener('pagehide', releaseSession);

  // ── audio ─────────────────────────────────────────────────────────────────

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
    if (jttyTx) jttyTx.reset();
    if (session) { session.stop(); session = null; }
  }

  function onSamples(samples) {
    if (!receiver) return;
    if (session && session.ptt) { receiver.gap(samples.length); return; }
    receiver.push(samples);
    if (scope) scope.ingest(samples);
  }

  // ── engine ────────────────────────────────────────────────────────────────

  var scope = null, store = null, rxView = null, receiver = null, streamFeed = null, jttyTx = null;
  var gainStore = null, modLevelClient = null, modLevel = 0;
  var myCall = '', currentEcho = null;

  function scriptUrl(path) {
    var nodes = document.querySelectorAll('script[src]');
    for (var i = 0; i < nodes.length; i++)
      if (nodes[i].getAttribute('src').split('?')[0] === path) return nodes[i].getAttribute('src');
    return path;
  }

  function buildEngine() {
    store = JttyRxLog.createStore();
    rxView = JttyRxLog.createView({
      el: document.getElementById('jttyPanelRx'),
      maxLines: 120,
      filter: JttyRxLog.nearRx(function () { return settings.rxHz; }, function () { return myCall; }),
      myCall: function () { return myCall; },
      txHz: function () { return settings.txHz; },
      onToken: onTokenClicked,
      onLineDouble: onLineDouble
    });
    streamFeed = JttyRx.createStreamFeed({ session: function () { return session; } });
    receiver = JttyRx.create({
      modemUrl: scriptUrl('/jtty-modem.js'), codecUrl: scriptUrl('/jtty-codec.js'),
      config: receiverConfig(),
      onUpdates: function (updates) {
        store.apply(updates).forEach(function (m) {
          rxView.upsert(m);
          if (m.status !== 'expired' && scope) scope.markDecode(m.audioHz, m.snr);
        });
        streamFeed.push(updates);
      }
    });

    scope = JttyScope.create({
      scopeEl: document.getElementById('jttyPanelScope'),
      liveCanvas: document.getElementById('jttyPanelLiveCanvas'),
      liveContainer: document.getElementById('jttyPanelLive'),
      waterfallCanvas: document.getElementById('jttyPanelWaterfallCanvas'),
      waterfallContainer: document.getElementById('jttyPanelWaterfall'),
      overlayCanvas: document.getElementById('jttyPanelOverlay'),
      sampleRate: RX_AUDIO_RATE, baseLowHz: 200, baseHighHz: 3000,
      rxHz: function () { return settings.rxHz; },
      txHz: function () { return settings.txHz; },
      onTune: function (hz, event) {
        if (event && event.shiftKey) setOffsets(null, hz);
        else setOffsets(hz, settings.holdTx ? null : hz);
      }
    });

    gainStore = new TxGainCal.TxGainStore();
    gainStore.load();
    modLevelClient = new TxGainModLevel.ModLevelClient({
      send: function (payload) {
        return fetch('/cmd?radio=lan', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function (response) { return response.json(); })
          .catch(function () { return {}; });
      },
      model: function () { return radio.model; }
    });

    jttyTx = JttyTx.create({
      session: function () { return session; },
      txHz: function () { return settings.txHz; },
      gain: resolvedGain,
      onSegment: function (seg) {
        if (seg.filler) return currentEcho;
        if (!currentEcho) currentEcho = rxView.echoTx(seg.text);
        else currentEcho.append(seg.text);
        return currentEcho;
      },
      onSegmentFailed: function (echo) { rxView.markEchoFailed(echo); },
      onFinish: onTxFinished,
      onTick: renderTx
    });

    if (global.StationIdentity) {
      var apply = function (changes) { if (changes.call) { myCall = changes.call; rxView.refilter(store.all()); } };
      global.StationIdentity.read().then(function (s) { if (s) apply(s); }).catch(function () {});
      global.StationIdentity.watch(function () { return { call: myCall }; }, apply);
    }
  }

  function setOffsets(rxHz, txHz) {
    var clampHz = function (hz) { return Math.max(JttySettings.TONE_MIN_HZ, Math.min(JttySettings.TONE_MAX_HZ, Math.round(hz))); };
    if (rxHz !== null) settings.rxHz = clampHz(rxHz);
    if (txHz !== null) settings.txHz = clampHz(txHz);
    saveSettings();
    if (receiver) receiver.configure(receiverConfig());
    if (rxHz !== null) rxView.refilter(store.all());
    renderState();
  }

  // The same gain the page uses: the shared /txgain.json for this band+power.
  function resolvedGain() {
    return TxGainCal.resolveGain({
      store: gainStore,
      identity: TxGainCal.identityFor({
        model: radio.model, frequencyHz: radio.frequency,
        percent: WsprCore.civPercent(radio.rfPower), rfPowerSeen: radio.rfPowerSeen
      }),
      modLevel: modLevel,
      manualGain: 0
    });
  }

  // ── words into the log ────────────────────────────────────────────────────

  var pendingField = null;

  function onRxPointerDown() {
    pendingField = global.LogRadio && global.LogRadio.focusedField ? global.LogRadio.focusedField() : null;
  }

  function onTokenClicked(word) {
    var selection = global.getSelection ? global.getSelection() : null;
    if (selection && !selection.isCollapsed) return;
    if (!global.LogRadio || !global.LogRadio.insertWord) return;
    global.LogRadio.insertWord(word, lanSlot, pendingField);
    pendingField = null;
  }

  // Double-click: work that station -- its frequency, and its call into Call.
  function onLineDouble(id) {
    var m = store.get(id);
    if (!m) return;
    setOffsets(m.audioHz, settings.holdTx ? null : m.audioHz);
    var words = m.text.split(' '), call = '';
    for (var i = 0; i < words.length; i++) {
      if (words[i] === 'CQ' || words[i] === myCall || !JttyCodec.standardCall(words[i])) continue;
      call = words[i];
      break;
    }
    if (call && global.LogRadio && global.LogRadio.insertWord) global.LogRadio.insertWord(call, lanSlot, null);
  }

  // ── TX ────────────────────────────────────────────────────────────────────

  var txResolve = null, txReject = null;

  // text: what the macro built; options.profile: the exchange profile QRPlog
  // derived from the contest exchange ('unknown' | 'field-day' | 'rtty-roundup').
  function send(text, options) {
    return new Promise(function (resolve, reject) {
      if (jttyTx && jttyTx.busyOrStarting()) return reject(new Error('the JTTY palette is busy with another transmission'));
      if (!sessionHeld || !session || !session.hello) return reject(new Error('the JTTY palette does not hold the audio session'));
      var packed = JttyCodec.packText(String(text || ''),
        { profile: JttyCodec.profileFromName(options && options.profile) });
      if (!packed) return reject(new Error('the text does not encode in one JTTY message (80 characters at most)'));
      txResolve = resolve; txReject = reject;
      currentEcho = null;
      jttyTx.send(packed).catch(function (error) {
        txResolve = txReject = null;
        reject(error);
      });
    });
  }

  function onTxFinished(error) {
    var resolve = txResolve, reject = txReject;
    txResolve = txReject = null;
    currentEcho = null;
    if (error) { if (reject) reject(new Error(error)); }
    else if (resolve) resolve();
    renderTx();
  }

  function applyZoom(percent) {
    if (!scope) return;
    scope.setZoom(percent);
    var pills = document.getElementById('jttyPanelZoom').querySelectorAll('button');
    Array.prototype.forEach.call(pills, function (pill) {
      pill.classList.toggle('active', Number(pill.dataset.zoom) === percent);
    });
  }

  function renderTx() {
    if (!el) return;
    var strip = document.getElementById('jttyPanelTx');
    var busy = jttyTx && jttyTx.busy();
    strip.hidden = !busy;
    el.classList.toggle('rtty-panel-tx-on', !!busy);
    if (!busy) return;
    var gain = resolvedGain();
    document.getElementById('jttyPanelTxLabel').textContent =
      'TX ' + Math.round(jttyTx.progress() * 100) + ' %' + (gain.calibrated ? '' : ' · uncalibrated');
  }

  function renderState(owner) {
    if (!el) return;
    var busyCard = document.getElementById('jttyPanelBusy');
    busyCard.hidden = sessionHeld;
    if (!sessionHeld && typeof owner === 'string')
      document.getElementById('jttyPanelBusyWhere').textContent = owner ? 'held by ' + owner : '';
    var live = sessionHeld && session && session.hello;
    var mode = radio.mode && !/-D$/.test(radio.mode) ? radio.mode + '!' : radio.mode;
    document.getElementById('jttyPanelState').textContent = !sessionHeld ? 'no audio'
      : (live ? (mode || '') + ' RX ' + settings.rxHz + (settings.txHz !== settings.rxHz ? ' TX ' + settings.txHz : '') : 'connecting…');
  }

  // ── markup ────────────────────────────────────────────────────────────────

  function build() {
    el = document.createElement('div');
    el.className = 'rtty-panel jtty-panel';
    el.id = 'jttyPanel';
    el.style.height = clampSize() + 'px';
    el.style.width = clampWidth() + 'px';
    el.innerHTML =
      '<div class="rtty-panel-head" id="jttyPanelHead">' +
        '<span class="rtty-panel-title">JTTY</span>' +
        '<span class="rtty-panel-zoom" id="jttyPanelZoom" role="group" aria-label="Waterfall zoom">' +
          '<button type="button" data-zoom="100" class="active">100%</button>' +
          '<button type="button" data-zoom="200">200%</button>' +
          '<button type="button" data-zoom="400">400%</button>' +
        '</span>' +
        '<span class="rtty-panel-state" id="jttyPanelState"></span>' +
        '<button class="rtty-panel-close" id="jttyPanelClose" type="button" title="Close (releases the radio audio)">×</button>' +
      '</div>' +
      '<div class="rtty-panel-scope" id="jttyPanelScope" ' +
        'title="Click: listen and answer here (TX stays put with Hold TX). Shift+click: transmit here.">' +
        '<div class="rtty-panel-live" id="jttyPanelLive">' +
          '<canvas id="jttyPanelLiveCanvas" width="1024" height="81"></canvas></div>' +
        '<div class="rtty-panel-waterfall" id="jttyPanelWaterfall">' +
          '<canvas id="jttyPanelWaterfallCanvas" width="320" height="64"></canvas></div>' +
        '<canvas class="rtty-panel-overlay" id="jttyPanelOverlay"></canvas>' +
      '</div>' +
      '<div class="rtty-panel-rx jtty-panel-rx" id="jttyPanelRx" aria-live="polite" ' +
        'title="Near the RX offset, and anything with your call. Click a word: Call/Exch. Double-click a line: work that station."></div>' +
      '<div class="rtty-panel-tx" id="jttyPanelTx" hidden>' +
        '<span id="jttyPanelTxLabel">TX</span>' +
        '<button id="jttyPanelTxAbort" type="button">ABORT</button>' +
      '</div>' +
      '<section class="rtty-panel-busy" id="jttyPanelBusy" hidden role="alert">' +
        '<b>The radio is driven from somewhere else</b>' +
        '<p>One radio, one operator: JS8Call-ICOM, WSPR, Mercury, RTTY-ICOM and ' +
           'JTTY all drive the transceiver through a single audio link.</p>' +
        '<p id="jttyPanelBusyWhere" class="session-busy-where"></p>' +
        '<button id="jttyPanelTakeover" type="button">TAKE THE SESSION OVER HERE</button>' +
      '</section>';
    document.body.appendChild(el);

    el.addEventListener('mousedown', function (e) { if (e.target.closest('button')) e.preventDefault(); });
    mountDrag(document.getElementById('jttyPanelHead'));
    document.getElementById('jttyPanelClose').addEventListener('click', function () { setOpen(false); });
    document.getElementById('jttyPanelTakeover').addEventListener('click', function () { claimSession(true); });
    document.getElementById('jttyPanelTxAbort').addEventListener('click', function () { jttyTx.abort('operator'); });
    document.getElementById('jttyPanelRx').addEventListener('pointerdown', onRxPointerDown);
    document.getElementById('jttyPanelZoom').addEventListener('click', function (e) {
      var pill = e.target.closest('button');
      if (pill) applyZoom(Number(pill.dataset.zoom));
    });

    buildEngine();

    if (global.ResizeObserver) {
      new ResizeObserver(function () {
        if (!open || !el) return;
        height = el.offsetHeight;
        width = el.offsetWidth;
        syncGap();
        scope.resize();
        save();
      }).observe(el);
    }
  }

  // ── open / close ──────────────────────────────────────────────────────────

  function setOpen(v) {
    var wanted = !!v;
    if (wanted && lanReady === false) return;
    if (wanted === open && el) return;
    open = wanted;
    var handover = 0;
    if (open && global.RttyPanel && global.RttyPanel.isOpen()) {
      global.RttyPanel.setOpen(false);
      handover = HANDOVER_MS;
    }
    if (open && !el) build();
    if (el) el.style.display = open ? '' : 'none';
    if (open) {
      reloadSettings();
      place();
      scope.resize();
      scope.start();
      renderState('');
      renderTx();
      if (handover) scheduleSessionRetry(handover);
      else claimSession(false);
      pollState();
      readModLevel();
    } else {
      if (sessionRetryTimer) { clearTimeout(sessionRetryTimer); sessionRetryTimer = null; }
      clearTimeout(statePollTimer);
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

  function mount() {
    btn = document.getElementById('btnJttyPopup');
    if (!btn) return;
    load();
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function () { setOpen(!open); });

    global.addEventListener('resize', function () {
      if (!el || !open) return;
      el.style.height = clampSize() + 'px';
      el.style.width = clampWidth() + 'px';
      place();
      if (scope) scope.resize();
      save();
    });

    if (global.StationProfile) {
      global.StationProfile.adoptHalf('jtty', JttySettings.load(localStorage),
        JttySettings.isSaved(localStorage)).then(function (station) {
        if (!station) return;
        var local = JttySettings.load(localStorage);
        JttySettings.save(localStorage, Object.assign({}, station, { rxHz: local.rxHz, txHz: local.txHz }), { localOnly: true });
        reloadSettings();
      }).catch(function () {});
    }

    global.addEventListener('storage', function (e) {
      if (e.key === JttySettings.STORAGE_KEY) reloadSettings();
    });

    LanGate.read(document).then(function (outcome) {
      lanReady = !!(outcome && outcome.ready);
      lanSlot = (outcome && outcome.slot) || 0;
      if (lanReady) {
        // A remembered open state wins only if the RTTY palette did not
        // also come back open -- never both.
        if (open && !(global.RttyPanel && global.RttyPanel.isOpen())) { open = false; setOpen(true); }
        else open = false;
      } else if (open) setOpen(false);
    }).catch(function () { lanReady = false; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  global.JttyPanel = {
    setOpen: setOpen,
    isOpen: function () { return open; },
    lanReady: function () { return lanReady; },
    holdsSession: function () { return sessionHeld && !!session && !!session.hello; },
    txBusy: function () { return !!jttyTx && jttyTx.busy(); },
    send: send,
    echoTx: function (text) { return rxView ? rxView.echoTx(text) : null; },
    abort: function () { if (jttyTx) jttyTx.abort('operator'); },
    setRunMode: function () {},
    getState: function () {
      return { open: open, sessionHeld: sessionHeld, rxHz: settings.rxHz, txHz: settings.txHz,
               messages: store ? store.all().length : 0, txBusy: !!jttyTx && jttyTx.busy() };
    }
  };

}(window));
