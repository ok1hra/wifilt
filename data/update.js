(function () {
  'use strict';

  // Update wizard (PC / Raspberry Pi). Three views: overview -> progress ->
  // result. All state lives on the server (the updater's status.json), so the
  // page can be reloaded, opened in a second browser, or lose WIFILT for the
  // restart in the middle of the update and simply pick up where it is.

  var DOWNLOAD_PAGE = 'https://ok1hra.github.io/wifilt/';
  var PHASE_LABELS = {
    check:    'Look for the newest build',
    download: 'Download',
    verify:   'Verify SHA256 and the package',
    unlock:   'Unlock the system (reboot)',
    backup:   'Save the current version',
    stop:     'Stop WIFILT',
    install:  'Install',
    oi3:      'Flash the OI3 firmware',
    start:    'Start WIFILT',
    health:   'Check that the new version answers',
    relock:   'Lock the system again (reboot)',
    done:     'Done'
  };
  // Phases during which wifilt is expected to be unreachable, and why.
  var OFFLINE_WHY = {
    unlock: 'The system is rebooting to unlock. This takes a minute or two.',
    backup: 'WIFILT is restarting with the new version.',
    stop: 'WIFILT is restarting with the new version.',
    install: 'WIFILT is restarting with the new version.',
    oi3: 'The OI3 is getting its new firmware. WIFILT starts right after.',
    start: 'WIFILT is restarting with the new version.',
    health: 'WIFILT is restarting with the new version.',
    relock: 'The system is rebooting to lock again. This takes a minute or two.'
  };
  var CANCELLABLE = { check: 1, download: 1, verify: 1 };
  var RECENT_RESULT_S = 15 * 60;

  var $ = function (id) { return document.getElementById(id); };
  var info = null;
  var status = null;
  var pollTimer = null;
  var offlineSince = 0;
  var offlineTries = 0;
  var startRev = null;
  var dryAllowed = /[?&]dry=1/.test(location.search);

  function show(view) {
    ['viewOverview', 'viewProgress', 'viewResult'].forEach(function (v) {
      $(v).hidden = v !== view;
    });
  }

  function setLink(ok, text) {
    var el = $('link');
    el.textContent = text;
    el.className = 'pill ' + (ok ? 'ok' : 'bad');
  }

  function getJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  function fmtBytes(n) {
    if (!n) return '0 MB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function fmtAge(sec) {
    if (sec < 90) return 'just now';
    if (sec < 5400) return Math.round(sec / 60) + ' min ago';
    if (sec < 172800) return Math.round(sec / 3600) + ' h ago';
    return Math.round(sec / 86400) + ' days ago';
  }

  // ------------------------------------------------------------ overview --

  // The OI3 firmware this update brings, from check.json (the updater reads
  // pi-setup's answers and the newest latest.json): null when there is no OI3
  // here or nothing newer for it.
  function oi3Upgrade(c) {
    var o = c && c.oi3;
    if (!o || !o.have || !o.latest) return null;
    if (o.installed && Number(o.latest) <= Number(o.installed)) return null;
    return { from: o.installed || '?', to: o.latest };
  }

  function planFor(mode, oi3) {
    var p = ['Download the new version and check its SHA256'];
    if (mode === 'pi-locked') {
      p.push('Unlock the read-only system and reboot');
      p.push('Install the new version and restart WIFILT');
      if (oi3) p.push('Flash the new OI3 firmware (the OI3 restarts)');
      p.push('Check that it answers (otherwise go back to the current version)');
      p.push('Lock the system again and reboot');
    } else {
      p.push('Save the current version so it can be restored');
      p.push('Stop WIFILT (and local-trx, if it runs), install, start again');
      if (oi3) p.push('Flash the new OI3 firmware in between (the OI3 restarts)');
      p.push('Check that the new version answers; if not, the current version comes back');
    }
    return p;
  }

  function durationFor(mode) {
    return mode === 'pi-locked'
      ? 'Takes about 3 to 5 minutes. The page reconnects by itself after each reboot.'
      : 'Takes about a minute.';
  }

  function renderOverview() {
    var u = info.updater || {};
    var c = u.check || null;
    var mode = u.mode || 'manual';
    $('revInstalled').textContent = info.rev;
    var newest = c && c.rev ? c.rev : '—';
    $('revNewest').textContent = newest;
    var hasNew = c && c.rev && Number(c.rev) > Number(info.rev) && !c.error;
    $('revNewest').className = hasNew ? 'newer' : '';
    $('checkedAt').textContent = c && c.checkedAt
      ? 'Checked ' + fmtAge(Math.max(0, Date.now() / 1000 - c.checkedAt)) +
        (c.channel && c.channel !== 'pages' ? ' · channel: ' + c.channel : '')
      : 'Not checked yet.';

    var line = '';
    if (mode === 'manual') line = '';
    else if (c && c.error === 'token-missing') line = 'This update channel needs an access token.';
    else if (c && c.error) line = 'Check failed: ' + c.error;
    else if (!c) line = 'Press "Check now" to look for a new version.';
    else if (hasNew) line = 'A new version is available.';
    else line = 'You have the newest version.';
    $('overviewState').textContent = line;
    $('newsLine').hidden = !hasNew;
    var oi3 = oi3Upgrade(c);
    var o = c && c.oi3;
    $('oi3Line').hidden = !(o && o.have);
    $('oi3Line').textContent = !(o && o.have) ? '' :
      oi3 ? 'OI3 firmware ' + oi3.from + ' → ' + oi3.to + (hasNew ? ' comes with this update.' : ' is in the newest build.') :
      'OI3 firmware ' + (o.installed || '?') + ' is up to date.';

    $('tokenBox').hidden = !(c && (c.error === 'token-missing' || c.tokenNeeded));
    $('manualBox').hidden = mode !== 'manual';
    $('btnCheck').hidden = mode === 'manual';
    if (mode === 'manual') {
      var why = $('manualWhy');
      why.innerHTML = '';
      [
        'It was not installed with install.sh / pi-setup, or by an older version without the updater,',
        'or this WIFILT runs from another folder than the installed one (an unpacked archive, a checkout),',
        'or it was started by hand (start-wifilt.sh) instead of by the wifilt service,',
        'or (Windows) the folder of wifilt.exe has no wifilt-update.ps1 or is not writable, e.g. Program Files.'
      ].forEach(function (t) { var li = document.createElement('li'); li.textContent = t; why.appendChild(li); });
      $('manualLink').href = DOWNLOAD_PAGE;
    }

    $('planBox').hidden = !hasNew || mode === 'manual';
    if (hasNew && mode !== 'manual') {
      var ol = $('planList');
      ol.innerHTML = '';
      planFor(mode, oi3).forEach(function (t) { var li = document.createElement('li'); li.textContent = t; ol.appendChild(li); });
      $('planTime').textContent = durationFor(mode);
    }
    var busyWhy = info.tx ? 'The radio is transmitting.' :
                  info.unattended ? 'Unattended operation is armed. Disarm it first.' : '';
    $('busyWarn').hidden = !busyWhy;
    $('busyWarn').textContent = busyWhy ? busyWhy + ' Updating now is refused.' : '';
    $('btnUpdate').hidden = !hasNew || mode === 'manual';
    $('btnUpdate').disabled = !!info.busy;
    $('btnDry').hidden = !(dryAllowed && mode !== 'manual' && c && c.rev);
    show('viewOverview');
    watchOverview();
  }

  // While the overview or a result is shown, notice an update started
  // elsewhere (another browser, a second tab) and follow it.
  var idleTimer = null;
  function idleShown() { return !$('viewOverview').hidden || !$('viewResult').hidden; }
  function watchOverview() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (!idleShown()) return;
      getJson('/update/status').then(function (s) {
        if (!idleShown()) return;
        if (s.state === 'running' || s.state === 'offline') { status = s; enterProgress(null); return; }
        watchOverview();
      }).catch(watchOverview);
    }, 3000);
  }

  function loadInfo() {
    return getJson('/update/info').then(function (d) {
      info = d;
      setLink(true, (d.host || 'PC') + ' · ' + d.rev);
      if (startRev === null) startRev = d.rev;
      return d;
    });
  }

  function waitForCheck(before) {
    var t0 = Date.now();
    $('btnCheck').disabled = true;
    $('overviewState').textContent = 'Checking…';
    (function again() {
      loadInfo().then(function (d) {
        var c = d.updater && d.updater.check;
        if (c && c.checkedAt && c.checkedAt !== before) { $('btnCheck').disabled = false; renderOverview(); return; }
        if (Date.now() - t0 > 60000) {
          $('btnCheck').disabled = false;
          renderOverview();
          $('overviewState').textContent = 'No answer from the updater. Is wifilt-update.path running?';
          return;
        }
        setTimeout(again, 1500);
      }).catch(function () { setTimeout(again, 2000); });
    })();
  }

  function startCheck() {
    var c = info && info.updater && info.updater.check;
    var before = c ? c.checkedAt : 0;
    $('overviewErr').hidden = true;
    postJson('/update/start', { action: 'check' }).then(function () {
      waitForCheck(before);
    }).catch(function (e) { showErr(e.message); });
  }

  function startUpdate(dry) {
    var c = info.updater.check;
    var what = dry ? 'Simulate the update (nothing is changed)?' :
      'Update WIFILT ' + info.rev + ' → ' + c.rev + ' now?' +
      (info.updater.mode === 'pi-locked' ? '\n\nThe system will reboot twice.' : '');
    if (!window.confirm(what)) return;
    $('btnUpdate').disabled = true;
    postJson('/update/start', { action: 'update', dry: !!dry }).then(function (d) {
      status = { state: 'running', id: d.id, phases: [], log: [], pct: 0, msg: 'Starting the updater…' };
      enterProgress(d.id);
    }).catch(function (e) { $('btnUpdate').disabled = false; showErr(e.message); });
  }

  function showErr(text) {
    $('overviewErr').textContent = text;
    $('overviewErr').hidden = false;
  }

  function saveToken() {
    var t = $('tokenInput').value.trim();
    postJson('/update/token', { token: t }).then(function () {
      $('tokenInput').value = '';
      startCheck();
    }).catch(function (e) { showErr(e.message); });
  }

  // ------------------------------------------------------------ progress --

  var waitingId = null;   // id of the request we started, until status shows it

  function enterProgress(id) {
    waitingId = id || null;
    show('viewProgress');
    renderProgress();
    poll();
  }

  function renderProgress() {
    var s = status || {};
    var phases = s.phases || [];
    var dry = s.dry ? ' (dry run)' : '';
    $('progTitle').textContent = (s.from && s.to ? 'Updating ' + s.from + ' → ' + s.to : 'Updating…') + dry;
    var bar = $('progBar');
    if (offlineSince) bar.removeAttribute('value');
    else bar.value = s.pct || 0;
    $('progPct').textContent = offlineSince ? '…' : (s.pct || 0) + ' %';
    $('progBytes').textContent = s.phase === 'download' && s.total
      ? fmtBytes(s.bytes) + ' / ' + fmtBytes(s.total) : '';
    $('progMsg').textContent = s.msg || '';

    var ol = $('phaseList');
    ol.innerHTML = '';
    phases.forEach(function (p, i) {
      if (p === 'done') return;
      var li = document.createElement('li');
      li.textContent = PHASE_LABELS[p] || p;
      if (i < s.phaseIdx || s.state === 'done') li.className = 'done';
      else if (i === s.phaseIdx) li.className = s.state === 'failed' ? 'failed' : 'active';
      if (i === s.phaseIdx && s.phase === 'download' && s.total && !offlineSince)
        li.textContent += ' ' + Math.round(100 * s.bytes / s.total) + ' %';
      ol.appendChild(li);
    });
    $('logText').textContent = (s.log || []).join('\n');
    $('btnCancel').hidden = !(s.state === 'running' && CANCELLABLE[s.phase]);
  }

  function renderOffline() {
    var s = status || {};
    var secs = Math.round((Date.now() - offlineSince) / 1000);
    var why = OFFLINE_WHY[s.phase] || 'WIFILT does not answer right now.';
    $('offlineMsg').hidden = false;
    $('offlineMsg').textContent = why + ' Waiting ' + secs + ' s (attempt ' + offlineTries + ')…';
    setLink(false, 'offline ' + secs + ' s');
    renderProgress();
  }

  function poll() {
    clearTimeout(pollTimer);
    getJson('/update/status').then(function (s) {
      if (offlineSince) {
        offlineSince = 0; offlineTries = 0;
        $('offlineMsg').hidden = true;
        loadInfo().catch(function () {});
      }
      // Until the updater picked our request up, status.json still shows the
      // previous run; keep the "starting" placeholder instead.
      if (waitingId && s.id !== waitingId) {
        if (s.state === 'idle' || s.state === 'done' || s.state === 'failed' || s.state === 'cancelled') {
          pollTimer = setTimeout(poll, 1000);
          return;
        }
      }
      waitingId = null;
      status = s;
      setLink(true, 'connected');
      if (s.state === 'done' || s.state === 'failed' || s.state === 'cancelled') {
        enterResult();
        return;
      }
      renderProgress();
      pollTimer = setTimeout(poll, 1000);
    }).catch(function () {
      if (!offlineSince) offlineSince = Date.now();
      offlineTries++;
      renderOffline();
      pollTimer = setTimeout(poll, 2000);
    });
  }

  function cancelUpdate() {
    $('btnCancel').disabled = true;
    postJson('/update/cancel', {}).catch(function () {}).then(function () {
      setTimeout(function () { $('btnCancel').disabled = false; }, 3000);
    });
  }

  // -------------------------------------------------------------- result --

  function enterResult() {
    var s = status || {};
    var title, msg;
    if (s.state === 'done') {
      title = s.dry ? 'Dry run finished' : 'Updated to ' + s.to;
      msg = s.msg || '';
      if (s.mode === 'pi-locked' && !s.dry) msg += ' The system is locked again.';
    } else if (s.state === 'cancelled') {
      title = 'Cancelled';
      msg = 'Nothing was changed.';
    } else {
      title = 'Update failed';
      msg = (s.error || 'unknown error') +
        (['backup', 'check', 'download', 'verify', 'unlock'].indexOf(s.phase) >= 0
          ? ' Nothing was changed.'
          : ' The previous version was restored.');
      if (s.mode === 'pi-locked' && s.phase === 'relock') msg += ' The system is locked again.';
    }
    $('resTitle').textContent = title;
    $('resTitle').className = s.state === 'failed' ? 'err' : '';
    $('resMsg').textContent = msg;
    $('resLog').textContent = (s.log || []).join('\n');
    $('btnReload').hidden = !(s.state === 'done' && !s.dry);
    show('viewResult');
    watchOverview();
  }

  // ---------------------------------------------------------------- init --

  function init() {
    $('btnCheck').addEventListener('click', startCheck);
    $('btnUpdate').addEventListener('click', function () { startUpdate(false); });
    $('btnDry').addEventListener('click', function () { startUpdate(true); });
    $('btnCancel').addEventListener('click', cancelUpdate);
    $('tokenSave').addEventListener('click', saveToken);
    $('btnReload').addEventListener('click', function () { location.href = '/'; });
    $('btnBack').addEventListener('click', function () { loadInfo().then(renderOverview); });

    Promise.all([loadInfo(), getJson('/update/status').catch(function () { return { state: 'idle' }; })])
      .then(function (r) {
        status = r[1];
        var s = status;
        if (s.state === 'running' || s.state === 'offline') { enterProgress(null); return; }
        var age = Date.now() / 1000 - (s.ts || 0);
        if ((s.state === 'done' || s.state === 'failed') && age < RECENT_RESULT_S) { enterResult(); return; }
        renderOverview();
      })
      .catch(function (e) {
        setLink(false, 'error');
        show('viewOverview');
        showErr('This page needs the PC / Raspberry Pi version of WIFILT (' + e.message + ').');
        $('btnCheck').hidden = true;
      });
  }

  init();
})();
