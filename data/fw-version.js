(function () {
  'use strict';

  var MANIFEST_URL = 'https://ok1hra.github.io/wifilt/manifest.json';
  var FLASHER_URL  = 'https://ok1hra.github.io/wifilt/';

  var localRev  = null;
  var remoteRev = null;
  var wifiRssi  = null;
  var el        = null;
  var offline   = false;
  var bdSupported = null;
  // GPS from /state: null = the radio has no GPS (fields absent) and the topbar
  // shows nothing; "" = GPS present but no position yet. Freshness comes from
  // gpsFixAgeMs -- the firmware's "ms since the UTC stamp last moved" -- so a
  // browser with a wrong clock still judges it correctly.
  var gpsGrid   = null;
  var gpsFixAgeMs = null;
  var gpsSel    = null;
  var GPS_FRESH_MS = 30000;
  // The details panel behind a click on the locator: everything the 23 00 reply
  // carries, fetched from /gps only while the panel is open. gpsInfo is the last
  // document, null when the fetch failed or has not landed yet.
  var gpsPanelOpen = false;
  var gpsInfo   = null;
  // The radio the position comes from, as the radio itself reports it. /state
  // carries it already, so the panel names the device rather than making the
  // operator remember which transceiver this interface is driving.
  var radioName = '';
  // Power of the LAN radio from /state (trx_power.h in the firmware). null =
  // no Icom LAN radio (or local-trx): no icon. 'standby' = the radio is off but
  // its LAN unit is still logged in, so it can be woken from here.
  var radioPower = null;
  var pwrCtl = false;          // model has the standby/shutdown menu
  var powerOp = '';            // '', 'wake', 'standby', 'shutdown', 'failed:<why>'
  var powerPanelOpen = false;
  var powerError = '';         // refusal of the last request, shown in the panel
  var powerDialog = null;
  var powerFastTimer = null;
  var powerFastUntil = 0;
  var WAKE_ASKED_KEY = 'wifilt.standbyAsked';
  var failCount = 0;
  var OFFLINE_AFTER = 2;      // consecutive failed polls before warning
  var FETCH_TIMEOUT = 4000;   // ms; hung request counts as a failed poll

  function injectStyles() {
    var s = document.createElement('style');
    s.textContent =
      'a.fw-version-link{color:inherit;text-decoration:none;}' +
      'a.fw-version-link:hover{text-decoration:underline;}' +
      'a.fw-update-link{color:#d97706;font-weight:700;text-decoration:none;margin-left:4px;}' +
      'a.fw-update-link:hover{color:#b45309;text-decoration:underline;}' +
      '.topbar-wifi-rssi{color:inherit;}' +
      '.topbar-wifi-rssi-bad{color:#dc2626;font-weight:700;}' +
      '.topbar-gps{color:inherit;}' +
      '.topbar-gps-muted{opacity:.55;}' +
      '.topbar-gps-manual{color:#d97706;font-weight:700;}' +
      '.topbar-gps-wrap{position:relative;display:inline-block;}' +
      '.topbar-gps-btn{cursor:pointer;}' +
      // Same visual family as the About panel behind the logo: dark card, the
      // border colour the brand panel uses, anchored under the right end of the bar.
      '.topbar-gps-panel{position:absolute;z-index:80;top:calc(100% + 7px);right:0;' +
        'min-width:235px;padding:10px 12px;border:1px solid #4b756c;border-radius:7px;' +
        'background:#0c1a18;box-shadow:0 16px 44px #000c;text-align:left;}' +
      '.topbar-gps-panel h4{margin:0 0 6px;font-size:11px;letter-spacing:.08em;color:#e8f3ee;}' +
      '.topbar-gps-panel div{display:flex;justify-content:space-between;gap:14px;' +
        'font-size:11px;line-height:1.8;}' +
      '.topbar-gps-panel div span:first-child{color:#8ba59d;}' +
      '.topbar-gps-panel div span:last-child{color:#e8f3ee;font-weight:600;white-space:nowrap;}' +
      '.topbar-esp-offline{color:#fff;background:#dc2626;font-weight:700;' +
        'padding:1px 7px;border-radius:4px;animation:espOfflineBlink 1s step-end infinite;}' +
      '@keyframes espOfflineBlink{50%{opacity:0.45;}}' +
      '.topbar-fw-sep{color:inherit;margin:0 7px;}' +
      // Power: green on, amber pulsing in standby, grey when the LAN session is
      // gone, blinking while an operation runs.
      '.topbar-pwr-wrap{position:relative;display:inline-block;}' +
      '.topbar-pwr{display:inline-flex;align-items:center;vertical-align:middle;cursor:pointer;' +
        'padding:0 2px;border:0;background:none;color:#6b7280;}' +
      '.topbar-pwr svg{width:15px;height:15px;display:block;}' +
      '.topbar-pwr-on{color:#22c55e;}' +
      '.topbar-pwr-standby{color:#e0a020;animation:pwrPulse 2s ease-in-out infinite;}' +
      '.topbar-pwr-busy{animation:espOfflineBlink .6s step-end infinite;}' +
      '@keyframes pwrPulse{50%{opacity:.35;}}' +
      // The topbar is nowrap; the notes in the panel have to wrap. Anchored on
      // the icon's left edge: the icon leads the segment, so RSSI and FW give
      // the panel room to the right even on a phone, where right:0 ran it off
      // the left of the screen.
      '.topbar-pwr-panel{left:0;right:auto;width:250px;max-width:calc(100vw - 16px);white-space:normal;}' +
      '.topbar-pwr-panel p{margin:6px 0;font-size:11px;line-height:1.5;color:#d9e6e1;}' +
      '.topbar-pwr-panel .topbar-pwr-err{color:#e5484d;}' +
      '.topbar-pwr-actions{display:flex;gap:8px;margin-top:8px;justify-content:flex-start!important;}' +
      '.topbar-pwr-btn{padding:5px 10px;border:1px solid #e0a020;border-radius:4px;background:#352311;' +
        'color:#ffd49a;font:inherit;font-size:11px;font-weight:800;cursor:pointer;}' +
      '.topbar-pwr-btn:hover,.topbar-pwr-btn:focus-visible{background:#4a3016;color:#fff;}' +
      '.topbar-pwr-btn-danger{border-color:#e5484d;background:#2a1213;color:#ffb4b4;}' +
      '.topbar-pwr-btn-danger:hover,.topbar-pwr-btn-danger:focus-visible{background:#45191b;}' +
      '.topbar-pwr-btn-quiet{border-color:#4b756c;background:transparent;color:#c9d8d3;}' +
      '.topbar-pwr-dialog{max-width:420px;padding:20px 22px;border:1px solid #8a572b;border-radius:8px;' +
        'background:#21170d;color:#d9c6ad;box-shadow:0 16px 48px #0009;' +
        'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;}' +
      '.topbar-pwr-dialog::backdrop{background:#000a;}' +
      '.topbar-pwr-dialog h2{margin:0 0 10px;color:#fff;font-family:inherit;font-size:18px;font-weight:700;}' +
      '.topbar-pwr-dialog p{margin:8px 0;line-height:1.5;}' +
      '.topbar-pwr-dialog .topbar-pwr-actions{justify-content:flex-end!important;margin-top:16px;}' +
      '.topbar-pwr-dialog .topbar-pwr-btn{font-size:13px;padding:8px 14px;}';
    s.textContent +=
      '.tab.tab-cat-muted{opacity:.55;}' +
      '.tab.tab-cat-muted:hover{opacity:.82;}';
    document.head.appendChild(s);
  }

  function renderHardwareNavigation() {
    document.querySelectorAll('.bd-nav').forEach(function (link) {
      link.hidden = bdSupported !== true;
    });
  }

  // The five GPS states of the topbar, graded so the operator can tell them
  // apart: no segment at all = this radio has no GPS; "GPS off" = GPS Select is
  // OFF in the radio menu; "GPS --" = waiting for the first fix; a plain
  // locator = live fix; a dimmed locator = last known position, fix lost.
  // A manual position (radio menu GPS Select = Manual) is a valid position but
  // never a live one, so it is marked and the DATA page keeps TX locked on it.
  function gpsStatus() {
    if (gpsGrid === null) return null;
    var grid6 = gpsGrid ? gpsGrid.slice(0, 6) : '';
    var fresh = gpsFixAgeMs !== null && gpsFixAgeMs < GPS_FRESH_MS;
    if (gpsSel === 3) {
      return {text: 'GPS ' + (grid6 || '--') + '·MAN', cls: 'topbar-gps topbar-gps-manual',
              title: 'Position entered manually in the radio, not a live GPS fix'};
    }
    if (!grid6) {
      return gpsSel === 0
        ? {text: 'GPS off', cls: 'topbar-gps topbar-gps-muted',
           title: 'GPS Select is OFF in the radio menu'}
        : {text: 'GPS --', cls: 'topbar-gps topbar-gps-muted',
           title: 'Radio has GPS, waiting for a position fix'};
    }
    if (fresh) {
      return {text: 'GPS ' + grid6, cls: 'topbar-gps',
              title: 'Live GPS fix, locator ' + gpsGrid};
    }
    var title = 'Last known GPS position';
    if (gpsFixAgeMs !== null && gpsFixAgeMs < 900000000) {
      var min = Math.round(gpsFixAgeMs / 60000);
      title += min < 1 ? ', fix lost under a minute ago'
                       : ', fix lost ' + min + ' min ago';
    } else {
      title += ', no live fix seen this session';
    }
    return {text: 'GPS ' + grid6, cls: 'topbar-gps topbar-gps-muted', title: title};
  }

  // dd°mm.mmm′ with the hemisphere letter -- the same shape the radio itself
  // shows and the 23 00 reply encodes, so the operator can compare digit by digit.
  function gpsDegMin(value, positive, negative) {
    var n = Number(value);
    if (!isFinite(n)) return null;
    var deg = Math.floor(Math.abs(n));
    var min = (Math.abs(n) - deg) * 60;
    var text = min.toFixed(3);
    if (min < 10) text = '0' + text;
    return deg + '°' + text + '′ ' + (n < 0 ? negative : positive);
  }

  function gpsFixText(ageMs) {
    var n = Number(ageMs);
    if (!isFinite(n)) return null;
    if (n < GPS_FRESH_MS) return 'live';
    if (n >= 900000000) return 'not confirmed this session';
    var min = Math.round(n / 60000);
    return min < 1 ? 'lost under a minute ago' : 'lost ' + min + ' min ago';
  }

  // "33U XP 04631 98765" -- zone+band, 100 km square, then the two 5-digit
  // (1 m) halves, spaced for reading rather than the bare machine form. Mgrs
  // is always called with 5-digit precision here, so the digit half is a
  // fixed 10 characters and everything before it is zone+band+square.
  function mgrsSpaced(compact) {
    if (!compact) return null;
    var head = compact.slice(0, -10);
    var digits = compact.slice(-10);
    return head.slice(0, -2) + ' ' + head.slice(-2) + ' ' + digits.slice(0, 5) + ' ' + digits.slice(5);
  }

  function gpsPanelRows() {
    if (!gpsInfo) return [['GPS details', 'not answering']];
    // Two different questions, so two rows: which device the position came from,
    // and how that device arrived at it.
    var from = ({0: 'receiver off', 1: 'GPS receiver', 3: 'manual entry'})[gpsInfo.sel] || '?';
    var rows = [
      ['Locator', gpsInfo.grid || 'no fix yet'],
      ['MGRS', mgrsSpaced(typeof Mgrs !== 'undefined' ? Mgrs.latLonToMgrs(gpsInfo.lat, gpsInfo.lon, 5) : null)],
      ['Latitude', gpsDegMin(gpsInfo.lat, 'N', 'S')],
      ['Longitude', gpsDegMin(gpsInfo.lon, 'E', 'W')],
      ['Altitude', isFinite(Number(gpsInfo.altM)) && gpsInfo.altM !== null ? Number(gpsInfo.altM).toFixed(1) + ' m' : null],
      ['Course', isFinite(Number(gpsInfo.courseDeg)) && gpsInfo.courseDeg !== null ? gpsInfo.courseDeg + '°' : null],
      ['Speed', isFinite(Number(gpsInfo.speedKmh)) && gpsInfo.speedKmh !== null ? Number(gpsInfo.speedKmh).toFixed(1) + ' km/h' : null],
      ['Fix time (UTC)', gpsInfo.utc || null],
      ['Fix', gpsFixText(gpsInfo.fixAgeMs)],
      ['Position from', from],
      ['Source', radioName || null]
    ];
    // A field the radio filled with FF simply is not there -- the guide allows
    // that for altitude explicitly -- so its row disappears instead of lying.
    return rows.filter(function (row) { return row[1] !== null && row[1] !== undefined; });
  }

  function gpsPanel() {
    var panel = document.createElement('div');
    panel.className = 'topbar-gps-panel';
    var head = document.createElement('h4');
    head.textContent = 'GPS — radio position';
    panel.appendChild(head);
    gpsPanelRows().forEach(function (row) {
      var line = document.createElement('div');
      var label = document.createElement('span');
      label.textContent = row[0];
      var value = document.createElement('span');
      value.textContent = row[1];
      // The decimal twin of the sexagesimal value, one hover away.
      if (row[0] === 'Latitude') value.title = Number(gpsInfo.lat).toFixed(6) + '°';
      if (row[0] === 'Longitude') value.title = Number(gpsInfo.lon).toFixed(6) + '°';
      line.appendChild(label);
      line.appendChild(value);
      panel.appendChild(line);
    });
    return panel;
  }

  function fetchGps() {
    fetch('/gps', {cache: 'no-store'})
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (d) { gpsInfo = d; if (gpsPanelOpen) render(); })
      .catch(function () { gpsInfo = null; if (gpsPanelOpen) render(); });
  }

  var POWER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M12 3v9"/><path d="M6.34 7.34A8 8 0 1 0 17.66 7.34"/></svg>';

  var POWER_REFUSALS = {
    transmitting: 'The radio is transmitting. Try again after the over.',
    busy: 'Another power operation is still running.',
    offline: 'There is no LAN session with the radio.',
    unsupported: 'Not available for this radio.'
  };
  var POWER_FAILURES = {
    timeout: 'The radio did not respond in time.',
    menu: 'The radio did not accept the Power OFF Setting (for Remote Control) menu write.',
    link: 'The LAN link to the radio dropped.'
  };

  function radioLabel() { return radioName || 'The radio'; }

  function powerStatusText() {
    if (powerOp === 'wake') return 'Waking up\u2026';
    if (powerOp === 'standby') return 'Going to standby\u2026';
    if (powerOp === 'shutdown') return 'Shutting down\u2026';
    if (radioPower === 'on') return 'On';
    if (radioPower === 'standby') return 'Standby (for remote control)';
    return 'Off or unreachable over LAN';
  }

  function powerButton(text, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'topbar-pwr-btn' + (cls ? ' ' + cls : '');
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function powerPanel() {
    var panel = document.createElement('div');
    panel.className = 'topbar-gps-panel topbar-pwr-panel';
    var head = document.createElement('h4');
    head.textContent = 'POWER \u2014 ' + (radioName || 'radio');
    panel.appendChild(head);
    var line = document.createElement('div');
    var label = document.createElement('span');
    label.textContent = 'State';
    var value = document.createElement('span');
    value.textContent = powerStatusText();
    line.appendChild(label);
    line.appendChild(value);
    panel.appendChild(line);

    var failed = powerOp.indexOf('failed:') === 0
      ? (POWER_FAILURES[powerOp.slice(7)] || 'Power operation failed.') : '';
    [powerError, failed].forEach(function (text) {
      if (!text) return;
      var p = document.createElement('p');
      p.className = 'topbar-pwr-err';
      p.textContent = text;
      panel.appendChild(p);
    });

    var busy = powerOp === 'wake' || powerOp === 'standby' || powerOp === 'shutdown';
    if (radioPower === 'off' && !busy) {
      var note = document.createElement('p');
      note.textContent = 'Over LAN the radio can only be woken from standby. ' +
        'After a full shutdown it has to be switched on at the radio.';
      panel.appendChild(note);
      return panel;
    }
    if (busy) return panel;
    var actions = document.createElement('div');
    actions.className = 'topbar-pwr-actions';
    if (radioPower === 'standby')
      actions.appendChild(powerButton('Wake up', '', function () { requestPower('on'); }));
    if (radioPower === 'on' && pwrCtl)
      actions.appendChild(powerButton('Standby', '', function () { confirmPower('standby'); }));
    if (pwrCtl)
      actions.appendChild(powerButton('Power off', 'topbar-pwr-btn-danger', function () { confirmPower('off'); }));
    if (!pwrCtl && radioPower === 'on') {
      var none = document.createElement('p');
      none.textContent = 'Standby and power off are offered for the IC-705 and IC-7610.';
      panel.appendChild(none);
    }
    if (actions.childNodes.length) panel.appendChild(actions);
    return panel;
  }

  // One <dialog> for every question; it lives on <body> because the topbar
  // is rebuilt on every poll.
  function showPowerDialog(title, paragraphs, buttons) {
    if (!powerDialog) {
      powerDialog = document.createElement('dialog');
      powerDialog.className = 'topbar-pwr-dialog';
      document.body.appendChild(powerDialog);
    }
    if (powerDialog.open) powerDialog.close();
    powerDialog.innerHTML = '';
    var h = document.createElement('h2');
    h.textContent = title;
    powerDialog.appendChild(h);
    paragraphs.forEach(function (text) {
      var p = document.createElement('p');
      p.textContent = text;
      powerDialog.appendChild(p);
    });
    var actions = document.createElement('div');
    actions.className = 'topbar-pwr-actions';
    buttons.forEach(function (spec) {
      actions.appendChild(powerButton(spec[0], spec[1], function () {
        powerDialog.close();
        if (spec[2]) spec[2]();
      }));
    });
    powerDialog.appendChild(actions);
    if (typeof powerDialog.showModal === 'function') powerDialog.showModal();
    else powerDialog.setAttribute('open', '');
    var focus = powerDialog.querySelector('.topbar-pwr-btn');
    if (focus) focus.focus();
  }

  function confirmPower(state) {
    powerPanelOpen = false;
    render();
    var stops = 'Anything the DATA pages are receiving or transmitting stops with it.';
    if (state === 'standby') {
      showPowerDialog('Put ' + radioLabel() + ' to standby?', [
        'The transceiver switches off but stays logged in on the network, so it can be woken ' +
        'up again from here (power icon in the top bar).',
        stops
      ], [['Cancel', 'topbar-pwr-btn-quiet'], ['Standby', '', function () { requestPower('standby'); }]]);
    } else {
      showPowerDialog('Power off ' + radioLabel() + '?', [
        'The radio shuts down completely and the network link drops. ' +
        'It CANNOT be switched on remotely afterwards \u2014 only at the radio itself.',
        'To be able to wake it from here later, use Standby instead.',
        stops
      ], [['Cancel', 'topbar-pwr-btn-quiet'],
          ['Standby instead', '', function () { requestPower('standby'); }],
          ['Power off', 'topbar-pwr-btn-danger', function () { requestPower('off'); }]]);
    }
  }

  // Once per tab: the answer to "wake it?" holds while the operator moves
  // between the DATA sub-pages, which all reload the topbar.
  function maybeAskWake() {
    if (radioPower !== 'standby' || powerOp) return;
    var asked = false;
    try { asked = window.sessionStorage.getItem(WAKE_ASKED_KEY) === '1'; } catch (e) {}
    if (asked) return;
    try { window.sessionStorage.setItem(WAKE_ASKED_KEY, '1'); } catch (e) {}
    showPowerDialog(radioLabel() + ' is in standby', [
      'The transceiver is switched off for remote control: the network link is up, ' +
      'but there is no receive, transmit or CAT until it is woken up.',
      'Wake it up now?'
    ], [['Not now', 'topbar-pwr-btn-quiet'], ['Wake up', '', function () { requestPower('on'); }]]);
  }

  function requestPower(state) {
    powerError = '';
    fetch('/cmd', {method: 'POST', cache: 'no-store', headers: {'Content-Type': 'application/json'},
                   body: JSON.stringify({type: 'power', state: state})})
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) powerError = POWER_REFUSALS[d && d.error] || 'The interface refused the request.';
        });
      })
      .catch(function () { powerError = 'The interface did not answer.'; })
      .then(function () {
        if (powerError) { powerPanelOpen = true; render(); }
        // Follow the operation at 1 s rather than the usual 5 s.
        powerFastUntil = Date.now() + 40000;
        if (!powerFastTimer) powerFastTimer = window.setInterval(function () {
          if (Date.now() > powerFastUntil) {
            window.clearInterval(powerFastTimer);
            powerFastTimer = null;
            return;
          }
          fetchLocal();
        }, 1000);
        fetchLocal();
      });
  }

  function onPowerClick() {
    powerPanelOpen = !powerPanelOpen;
    if (powerPanelOpen) gpsPanelOpen = false;
    else powerError = '';
    render();
  }

  function onGpsClick() {
    gpsPanelOpen = !gpsPanelOpen;
    if (gpsPanelOpen) powerPanelOpen = false;
    if (gpsPanelOpen) fetchGps();
    render();
  }

  function render() {
    if (!el || (localRev === null && !offline)) return;
    el.innerHTML = '';

    if (offline || radioPower === null) powerPanelOpen = false;
    if (!offline && radioPower !== null) {
      var busy = powerOp === 'wake' || powerOp === 'standby' || powerOp === 'shutdown';
      var pwrWrap = document.createElement('span');
      pwrWrap.className = 'topbar-pwr-wrap';
      var pwr = document.createElement('button');
      pwr.type = 'button';
      pwr.className = 'topbar-pwr' + (radioPower === 'on' ? ' topbar-pwr-on' : '') +
        (radioPower === 'standby' ? ' topbar-pwr-standby' : '') + (busy ? ' topbar-pwr-busy' : '');
      pwr.innerHTML = POWER_ICON;
      pwr.title = 'Radio power: ' + powerStatusText() + ' \u2014 click for wake / standby / power off';
      pwr.setAttribute('aria-label', pwr.title);
      pwr.setAttribute('aria-expanded', powerPanelOpen ? 'true' : 'false');
      pwr.addEventListener('click', onPowerClick);
      pwrWrap.appendChild(pwr);
      if (powerPanelOpen) pwrWrap.appendChild(powerPanel());
      el.appendChild(pwrWrap);
      var pwrSep = document.createElement('span');
      pwrSep.className = 'topbar-fw-sep';
      pwrSep.textContent = '|';
      el.appendChild(pwrSep);
    }

    var gps = offline ? null : gpsStatus();
    if (!gps) gpsPanelOpen = false;
    if (gps) {
      var gpsWrap = document.createElement('span');
      gpsWrap.className = 'topbar-gps-wrap';
      var gpsSpan = document.createElement('span');
      gpsSpan.className = gps.cls + ' topbar-gps-btn';
      gpsSpan.textContent = gps.text;
      gpsSpan.title = gps.title + ' — click for details';
      gpsSpan.setAttribute('role', 'button');
      gpsSpan.addEventListener('click', onGpsClick);
      gpsWrap.appendChild(gpsSpan);
      if (gpsPanelOpen) gpsWrap.appendChild(gpsPanel());
      el.appendChild(gpsWrap);
      var gpsSep = document.createElement('span');
      gpsSep.className = 'topbar-fw-sep';
      gpsSep.textContent = '|';
      el.appendChild(gpsSep);
    }

    var rssi = document.createElement('span');
    if (offline) {
      rssi.className = 'topbar-esp-offline';
      rssi.textContent = '⚠ OFFLINE';
      rssi.title = 'Page lost connection to the interface';
    } else {
      rssi.className = 'topbar-wifi-rssi';
      if (wifiRssi !== null && wifiRssi > -999) {
        rssi.textContent = wifiRssi + ' dBm';
        if (wifiRssi <= -70) {
          rssi.className += ' topbar-wifi-rssi-bad';
        }
      } else {
        rssi.textContent = '-- dBm';
      }
    }
    el.appendChild(rssi);

    if (localRev === null) return;

    var sep = document.createElement('span');
    sep.className = 'topbar-fw-sep';
    sep.textContent = '|';
    el.appendChild(sep);

    var a = document.createElement('a');
    a.href      = FLASHER_URL;
    a.target    = '_blank';
    a.rel       = 'noopener';
    a.className = 'fw-version-link';
    var hasUpdate = remoteRev !== null && Number(remoteRev) > Number(localRev);
    a.title     = hasUpdate ? 'New firmware available — click to open web installer'
                            : 'Open web installer';
    a.textContent = 'FW ' + localRev;
    el.appendChild(a);
    if (hasUpdate) {
      var upd = document.createElement('a');
      upd.href      = FLASHER_URL;
      upd.target    = '_blank';
      upd.rel       = 'noopener';
      upd.className = 'fw-update-link';
      upd.title     = 'New firmware available — click to open web installer';
      upd.textContent = ' → ' + remoteRev + ' ▲';
      el.appendChild(upd);
    }
  }

  // log-manager.js calls this instead of writing el.textContent directly
  window.setFwRev = function (rev) {
    localRev = String(rev);
    render();
  };

  window.setWifiRssi = function (rssi) {
    var n = Number(rssi);
    wifiRssi = Number.isFinite(n) ? n : null;
    render();
  };

  function fetchLocal() {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? window.setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT) : null;
    fetch('/state', ctrl ? { signal: ctrl.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (d) {
        failCount = 0;
        offline = false;
        if (d && d.fwRev) {
          localRev = String(d.fwRev);
        }
        if (d && d.wifiRssi !== undefined) {
          var n = Number(d.wifiRssi);
          wifiRssi = Number.isFinite(n) ? n : null;
        }
        if (d && d.bdSupported !== undefined) {
          bdSupported = d.bdSupported === true;
          renderHardwareNavigation();
        }
        if (d && typeof d.radioName === 'string') radioName = d.radioName;
        if (d && typeof d.radioPower === 'string') {
          radioPower = d.radioPower;
          pwrCtl = d.pwrCtl === true;
          powerOp = typeof d.powerOp === 'string' ? d.powerOp : '';
        } else {
          radioPower = null; pwrCtl = false; powerOp = '';
        }
        if (d && typeof d.gpsGrid === 'string') {
          gpsGrid = d.gpsGrid;
          gpsFixAgeMs = Number.isFinite(Number(d.gpsFixAgeMs)) ? Number(d.gpsFixAgeMs) : null;
          gpsSel = Number.isFinite(Number(d.gpsSel)) ? Number(d.gpsSel) : null;
        } else {
          gpsGrid = null; gpsFixAgeMs = null; gpsSel = null;
        }
        // An open panel follows the firmware's own 5 s GPS poll -- speed and
        // course move while you watch, at the pace they actually update.
        if (gpsPanelOpen) fetchGps();
        render();
        maybeAskWake();
      })
      .catch(function () {
        failCount++;
        if (failCount >= OFFLINE_AFTER && !offline) {
          offline = true;
          render();
        }
      })
      .finally(function () {
        if (timer !== null) window.clearTimeout(timer);
      });
  }

  function fetchRemote() {
    fetch(MANIFEST_URL)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.version) {
          remoteRev = String(d.version);
          render();
        }
      })
      .catch(function () {});
  }

  function init() {
    el = document.getElementById('topbarFw');
    if (!el) return;
    injectStyles();
    renderHardwareNavigation();
    // Outside click closes the panel, like the About panel behind the logo.
    // closest() and not contains(): the toggle re-renders the bar synchronously,
    // so by the time this bubbles up the clicked span is detached -- closest()
    // still walks its detached ancestors and recognises it as ours.
    document.addEventListener('click', function (event) {
      if (!gpsPanelOpen && !powerPanelOpen) return;
      if (event.target.closest && event.target.closest('.topbar-gps-wrap, .topbar-pwr-wrap')) return;
      gpsPanelOpen = false;
      powerPanelOpen = false;
      powerError = '';
      render();
    });

    var dataRev = el.getAttribute('data-rev');
    if (dataRev) {
      localRev = String(dataRev);
      render();
    } else {
      fetchLocal();
    }
    window.setInterval(fetchLocal, 5000);
    fetchRemote();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
