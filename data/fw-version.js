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
      '.topbar-fw-sep{color:inherit;margin:0 7px;}';
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

  function gpsPanelRows() {
    if (!gpsInfo) return [['GPS details', 'not answering']];
    var source = ({0: 'OFF in the radio menu', 1: 'GPS receiver', 3: 'manual entry'})[gpsInfo.sel] || '?';
    var rows = [
      ['Locator', gpsInfo.grid || 'no fix yet'],
      ['Latitude', gpsDegMin(gpsInfo.lat, 'N', 'S')],
      ['Longitude', gpsDegMin(gpsInfo.lon, 'E', 'W')],
      ['Altitude', isFinite(Number(gpsInfo.altM)) && gpsInfo.altM !== null ? Number(gpsInfo.altM).toFixed(1) + ' m' : null],
      ['Course', isFinite(Number(gpsInfo.courseDeg)) && gpsInfo.courseDeg !== null ? gpsInfo.courseDeg + '°' : null],
      ['Speed', isFinite(Number(gpsInfo.speedKmh)) && gpsInfo.speedKmh !== null ? Number(gpsInfo.speedKmh).toFixed(1) + ' km/h' : null],
      ['Fix time (UTC)', gpsInfo.utc || null],
      ['Fix', gpsFixText(gpsInfo.fixAgeMs)],
      ['Source', source]
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

  function onGpsClick() {
    gpsPanelOpen = !gpsPanelOpen;
    if (gpsPanelOpen) fetchGps();
    render();
  }

  function render() {
    if (!el || (localRev === null && !offline)) return;
    el.innerHTML = '';

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
      if (!gpsPanelOpen) return;
      if (event.target.closest && event.target.closest('.topbar-gps-wrap')) return;
      gpsPanelOpen = false;
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
