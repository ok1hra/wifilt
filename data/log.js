'use strict';
/**
 * log-manager.js — contest log creation, selection, export (CSV + ADIF)
 * Depends on: log-db.js (LogDB)
 */

(function (global) {

  // ── Helpers ────────────────────────────────────────────────────────────────

  function todayYyyymmdd() {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  let _activeLog    = null;   // current log object
  let _onLogChanged = null;   // callback(log) when active log changes

  function getActiveLog()        { return _activeLog; }
  function onLogChanged(handler) { _onLogChanged = handler; }

  function _notifyChange() {
    window._logSettings = _activeLog;   // make available to log.js / dxcc lookup
    if (_onLogChanged) _onLogChanged(_activeLog);
  }

  // ── Activate a log ─────────────────────────────────────────────────────────

  function activateLog(log) {
    _activeLog = log;
    LogDB.setSetting('activeLogId', log ? log.id : null).catch(() => {});
    _notifyChange();
  }

  // ── Restore last active log on startup ────────────────────────────────────

  function restoreActiveLog() {
    return LogDB.getAllSettings().then(cfg => {
      const id = cfg.activeLogId;
      if (!id) return null;
      return LogDB.getLog(id).then(log => {
        if (log) activateLog(log);
        return log;
      });
    });
  }

  // ── Increment QSO number in active log ────────────────────────────────────

  function bumpQsoNumber() {
    if (!_activeLog) return Promise.resolve(null);
    _activeLog.nextQsoNumber++;
    return LogDB.updateLog(_activeLog);
  }

  // ── CSV export ─────────────────────────────────────────────────────────────

  function escCsv(v) {
    const s = String(v == null ? '' : v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  const CSV_HEADERS = [
    'qsoNumber','dateUtc','timeUtc','call','rstSent','rstReceived',
    'exchangeReceived','frequencyHz','frequencyDisplay','mode','trx',
    'continent','country','dxccPrefix','cqZone','ituZone',
    'utcOffset','qrbKm','azimuthDeg','locatorReceived',
  ];

  function qsoToCsvRow(q) {
    const d = q.dxcc || {};
    return [
      q.qsoNumber, q.qsoDateUtc, q.timeOnUtc,
      q.call, q.rstSent, q.rstReceived, q.exchangeReceived,
      q.frequencyHz, q.frequencyDisplay, q.mode, q.trx,
      d.continent, d.country, d.mainPrefix, d.cqZone, d.ituZone,
      d.utcOffset, d.qrbKm, d.azimuthDeg,
      q.locatorReceived || '',
    ].map(escCsv).join(',');
  }

  function exportCsv(logId) {
    return LogDB.getQsosForLog(logId).then(qsos => {
      qsos.sort((a,b) => a.qsoNumber - b.qsoNumber);
      const lines = [CSV_HEADERS.join(','), ...qsos.map(qsoToCsvRow)];
      return lines.join('\r\n');
    });
  }

  function downloadCsv(logObj) {
    exportCsv(logObj.id).then(csv => {
      const date = logObj.createdAtUtc.slice(0, 10);
      const name = date + '-' + logObj.contestName.replace(/[^A-Z0-9]/gi, '') + '.csv';
      _triggerDownload(csv, name, 'text/csv;charset=utf-8;');
    });
  }

  // ── ADIF export ────────────────────────────────────────────────────────────

  function adifField(tag, val) {
    if (val == null || val === '') return '';
    const s = String(val);
    return '<' + tag + ':' + s.length + '>' + s;
  }

  function freqToAdifMhz(hz) {
    return (hz / 1e6).toFixed(6);
  }

  function freqToBand(hz) {
    if (hz >= 1800000   && hz <= 2000000)   return '160m';
    if (hz >= 3500000   && hz <= 4000000)   return '80m';
    if (hz >= 5351500   && hz <= 5366500)   return '60m';
    if (hz >= 7000000   && hz <= 7300000)   return '40m';
    if (hz >= 10100000  && hz <= 10150000)  return '30m';
    if (hz >= 14000000  && hz <= 14350000)  return '20m';
    if (hz >= 18068000  && hz <= 18168000)  return '17m';
    if (hz >= 21000000  && hz <= 21450000)  return '15m';
    if (hz >= 24890000  && hz <= 24990000)  return '12m';
    if (hz >= 28000000  && hz <= 29700000)  return '10m';
    if (hz >= 50000000  && hz <= 54000000)  return '6m';
    if (hz >= 70000000  && hz <= 71000000)  return '4m';
    if (hz >= 144000000 && hz <= 148000000) return '2m';
    if (hz >= 222000000 && hz <= 225000000) return '1.25m';
    if (hz >= 420000000 && hz <= 450000000) return '70cm';
    if (hz >= 902000000 && hz <= 928000000) return '33cm';
    return '';
  }

  function adifModeMap(mode) {
    const m = (mode || '').toUpperCase();
    if (m === 'CW' || m === 'CWR' || m === 'CW-R') return 'CW';
    if (m === 'USB') return 'SSB';
    if (m === 'LSB') return 'SSB';
    if (m === 'FM')  return 'FM';
    if (m === 'AM')  return 'AM';
    if (m === 'RTTY' || m === 'RTTY-R' || m === 'RTTYR') return 'RTTY';
    if (m === 'FSK') return 'RTTY';
    if (m === 'DV')  return 'DIGITALVOICE';
    return mode;
  }

  function qsoToAdif(q, stationCall, myLocator) {
    const fields = [
      adifField('FREQ',             freqToAdifMhz(q.frequencyHz)),
      adifField('BAND',             freqToBand(q.frequencyHz)),
      adifField('QSO_DATE',         (q.qsoDateUtc || '').replace(/-/g,'')),
      adifField('TIME_ON',          (q.timeOnUtc  || '').replace(':','')),
      adifField('CALL',             q.call),
      adifField('MODE',             adifModeMap(q.mode)),
      adifField('RST_SENT',         q.rstSent),
      adifField('STX',              String(q.qsoNumber).padStart(3,'0')),
      adifField('RST_RCVD',         q.rstReceived),
      adifField('SRX',              q.exchangeReceived),
      adifField('STATION_CALLSIGN', stationCall),
      adifField('MY_GRIDSQUARE',    myLocator),
      adifField('GRIDSQUARE',       q.locatorReceived || ''),
      '<EOR>',
    ];
    return fields.filter(Boolean).join(' ') + '\r\n';
  }

  function exportAdif(logObj) {
    return LogDB.getQsosForLog(logObj.id).then(qsos => {
      qsos.sort((a,b) => a.qsoNumber - b.qsoNumber);
      const header = 'Generated by WIFILT contest log\r\n' +
                     adifField('PROGRAMID','WIFILT-Log') + ' ' +
                     adifField('PROGRAMVERSION','1.0') + ' ' +
                     '<EOH>\r\n\r\n';
      const records = qsos.map(q =>
        qsoToAdif(q, logObj.stationCall, logObj.myLocator)
      ).join('');
      return header + records;
    });
  }

  function downloadAdif(logObj) {
    exportAdif(logObj).then(adif => {
      const date = logObj.createdAtUtc.slice(0, 10);
      const name = date + '-' + logObj.contestName.replace(/[^A-Z0-9]/gi,'') + '.adi';
      _triggerDownload(adif, name, 'text/plain;charset=utf-8;');
    });
  }

  function _triggerDownload(content, filename, mime) {
    const blob = new Blob(['﻿' + content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
  }

  // ── Storage info popup (shared, created once) ─────────────────────────────

  function _ensureStoragePopup() {
    if (document.getElementById('lmStorageInfoPopup')) return;
    const d = document.createElement('div');
    d.className = 'si-popup';
    d.id = 'lmStorageInfoPopup';
    d.innerHTML = `
      <p class="si-popup-head">Storage info <button class="si-popup-close" id="lmSiClose">✕</button></p>
      <div class="si-section">
        <p class="si-h">Usage &amp; quota — where to look</p>
        <div class="si-row"><span class="si-browser">Chrome / Edge</span><span>DevTools <kbd>F12</kbd> → Application → Storage — shows exact usage and quota for this origin.</span></div>
        <div class="si-row"><span class="si-browser">Firefox</span><span>Address bar: <code>about:storage</code> — lists all origins with size. Or DevTools <kbd>F12</kbd> → Storage → IndexedDB.</span></div>
        <div class="si-row"><span class="si-browser">Safari</span><span>Develop → Web Inspector → Storage. (Enable Develop menu in Preferences → Advanced.)</span></div>
      </div>
      <div class="si-section">
        <p class="si-h">Persistent storage — protection from auto-eviction</p>
        <div class="si-row"><span class="si-browser">Chrome / Edge</span><span>Granted automatically when you bookmark this page or install it as a PWA (⋮ → "Install app"). No action usually needed.</span></div>
        <div class="si-row"><span class="si-browser">Firefox</span><span>Settings → Privacy &amp; Security → Cookies and Site Data → Manage Data → find this origin → check "Persist". Requires HTTPS.</span></div>
        <div class="si-row"><span class="si-browser">Safari</span><span>Managed automatically by the browser; explicit requests from code are not supported.</span></div>
      </div>
      <p class="si-note">This app runs over plain HTTP, so the Storage API (requires HTTPS) is unavailable to JavaScript. Desktop browsers rarely evict IndexedDB data unless the disk is critically full — especially for bookmarked pages.</p>`;
    document.body.appendChild(d);
    document.getElementById('lmSiClose').addEventListener('click', e => {
      e.stopPropagation();
      d.classList.remove('si-open');
    });
    document.addEventListener('click', e => {
      if (!d.contains(e.target)) d.classList.remove('si-open');
    });
  }

  // ── First-time disclaimer ─────────────────────────────────────────────────

  const DISCLAIMER_KEY = 'log-disclaimer-acked';

  function showDisclaimerIfNeeded() {
    if (localStorage.getItem(DISCLAIMER_KEY)) return;
    if (document.getElementById('logDisclaimer')) return;
    const overlay = document.createElement('div');
    overlay.id = 'logDisclaimer';
    overlay.className = 'ld-overlay';
    overlay.innerHTML = `
      <div class="ld-box">
        <span class="ld-title">Log stored in your browser</span>
        <div class="ld-body">
          <p>Your contest log is stored in this browser's IndexedDB — not on the ESP32 or any server.</p>
          <p>Keep in mind:</p>
          <ul>
            <li>Clearing browser data or site storage <strong>deletes your log permanently</strong></li>
            <li>A different browser or device sees an <strong>empty log</strong></li>
            <li>This app runs over HTTP, so the browser may not guarantee persistent storage</li>
          </ul>
          <p class="ld-backup">Back up regularly: go to <a href="/datasync" target="_blank">LOGSYNC → Backup / Restore</a> and export a JSON file after each session.</p>
        </div>
        <div class="ld-footer">
          <label class="ld-check-label">
            <input type="checkbox" id="logDisclaimerCheck">
            I understand and I have noted the backup recommendation
          </label>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('logDisclaimerCheck').addEventListener('change', function () {
      if (!this.checked) return;
      localStorage.setItem(DISCLAIMER_KEY, '1');
      overlay.remove();
    });
  }

  // ── Log manager modal UI ───────────────────────────────────────────────────

  let _allLogs   = [];
  let _allCounts = [];
  let _delAllTimer = null;

  function buildModal() {
    const el = document.createElement('div');
    el.id        = 'logMgrModal';
    el.className = 'lm-modal lm-hidden';
    el.innerHTML = `
      <div class="lm-box">
        <div class="lm-header">
          <span class="lm-title">QRPLog</span>
          <button class="lm-close" id="lmClose" type="button">✕</button>
        </div>

        <div class="lm-body">
        <section class="lm-section" id="lmListSection">
          <div class="lm-list-header">
            <span class="lm-section-title" style="margin:0">Saved logs</span>
            <input id="lmSearch" class="lm-search" type="search" placeholder="filter…" autocomplete="off" spellcheck="false">
          </div>
          <div id="lmLogList" class="lm-log-list"></div>
          <div class="lm-del-all-row">
            <button id="lmDeleteAll" class="lm-btn lm-btn-sm lm-btn-del" type="button">Delete all</button>
          </div>
        </section>

        <section class="lm-section">
          <div class="lm-section-title">New log</div>
          <form id="lmNewForm" class="lm-form" autocomplete="off">
            <label class="lm-row">
              <span>Contest</span>
              <input id="lmContest" maxlength="40" placeholder="CQWW" required>
            </label>
            <label class="lm-row">
              <span>My call</span>
              <input id="lmMyCall" maxlength="16" placeholder="OK1ABC" required>
            </label>
            <div class="lm-row">
              <span>Exchange <button type="button" class="lm-help-btn" id="lmExchHelpBtn" title="Exchange type help">?</button></span>
              <select id="lmExchType" class="lm-row-select">
                <option value="">NONE</option>
                <option value="NR">NR</option>
                <option value="NRUTC">NR+UTC</option>
                <option value="NRLOC">NR+LOC (6m and up)</option>
                <option value="STATIC">STATIC</option>
              </select>
            </div>
            <div class="lm-row" id="lmStaticRow" style="display:none">
              <span>Exch value</span>
              <input id="lmExchStatic" maxlength="20" placeholder="e.g. SK1, 14, A">
            </div>
            <div class="lm-row" id="lmExchPreviewRow">
              <span class="lm-preview-label">Preview</span>
              <span class="lm-exch-preview" id="lmExchPreviewText">— no exchange —</span>
            </div>
            <label class="lm-row">
              <span>My locator</span>
              <input id="lmLoc" maxlength="6" placeholder="JO70FD">
            </label>
            <label class="lm-row">
              <span>Start QSO#</span>
              <input id="lmStartNr" type="number" min="1" value="1">
            </label>
            <div class="lm-row lm-row-check">
              <span>CW numbers</span>
              <label class="lm-check-wrap">
                <input type="checkbox" id="lmCwAbbrev" checked>
                <span class="lm-check-text">CW abbreviation &mdash; 0&rarr;T, 9&rarr;N &nbsp;(e.g. 001&rarr;TT1, 599&rarr;5NN)</span>
              </label>
            </div>
            <div class="lm-actions">
              <button type="submit" class="lm-btn lm-btn-primary">Create &amp; activate</button>
            </div>
          </form>
        </section>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    document.getElementById('lmClose').addEventListener('click', closeModal);
    el.addEventListener('click', e => { if (e.target === el) closeModal(); });
    document.getElementById('lmNewForm').addEventListener('submit', onNewFormSubmit);
    document.getElementById('lmLogList').addEventListener('click', onLogListClick);
    document.getElementById('lmSearch').addEventListener('input', applyFilter);
    document.getElementById('lmDeleteAll').addEventListener('click', onDeleteAll);

    // uppercase fields
    ['lmContest','lmMyCall','lmExchStatic','lmLoc'].forEach(id => {
      const inp = document.getElementById(id);
      if (!inp) return;
      inp.addEventListener('input', () => {
        const pos = inp.selectionStart;
        inp.value = inp.value.toUpperCase();
        inp.setSelectionRange(pos, pos);
      });
    });

    // A new log starts as the station the interface says it is. Still editable:
    // a contest entry, a /P outing or a guest operator are all legitimate
    // reasons for one log to carry a different call -- but nobody should have to
    // retype their own callsign on a device that already knows it.
    if (window.StationIdentity) {
      window.StationIdentity.read().then(station => {
        if (!station) return;
        const call = document.getElementById('lmMyCall');
        const loc  = document.getElementById('lmLoc');
        if (call && !call.value.trim() && station.call) call.value = station.call;
        if (loc && !loc.value.trim() && station.grid) loc.value = station.grid;
        _updateExchPreview();
      }).catch(() => {});
    }

    document.getElementById('lmExchType').addEventListener('change', _onExchTypeChange);
    document.getElementById('lmExchStatic').addEventListener('input', _updateExchPreview);
    document.getElementById('lmLoc').addEventListener('input', _updateExchPreview);
    document.getElementById('lmCwAbbrev').addEventListener('change', _updateExchPreview);
    document.getElementById('lmExchHelpBtn').addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      _ensureExchHelpPopup();
      document.getElementById('lmExchHelpPopup').classList.toggle('si-open');
    });
    _updateExchPreview();

    return el;
  }

  // ── Exchange type helpers ──────────────────────────────────────────────────

  function _exchDisplayLabel(de) {
    if (!de) return 'NONE';
    if (de === 'NR')    return 'NR';
    if (de === 'NRUTC') return 'NR+UTC';
    if (de === 'NRLOC') return 'NR+LOC';
    return de;
  }

  function _onExchTypeChange() {
    const type = document.getElementById('lmExchType').value;
    const row  = document.getElementById('lmStaticRow');
    if (row) row.style.display = (type === 'STATIC') ? '' : 'none';
    _updateExchPreview();
  }

  function _cwNum(n, abbrev) {
    const s = String(n).padStart(3, '0');
    if (!abbrev) return s;
    return s.replace(/0/g, 'T').replace(/9/g, 'N');
  }

  function _updateExchPreview() {
    const typeEl    = document.getElementById('lmExchType');
    const locEl     = document.getElementById('lmLoc');
    const staticEl  = document.getElementById('lmExchStatic');
    const abbrevEl  = document.getElementById('lmCwAbbrev');
    const previewEl = document.getElementById('lmExchPreviewText');
    if (!typeEl || !previewEl) return;

    const type   = typeEl.value;
    const loc    = locEl    ? locEl.value.trim()    : '';
    const stat   = staticEl ? staticEl.value.trim() : '';
    const abbrev = abbrevEl ? abbrevEl.checked       : true;
    const rst    = abbrev ? '5NN' : '599';
    const nr     = _cwNum(1, abbrev);
    let text = '';
    let warn = false;

    if (!type) {
      text = '— no exchange —';
    } else if (type === 'NR') {
      text = rst + ' ' + nr;
    } else if (type === 'NRUTC') {
      const d    = new Date();
      const hhmm = String(d.getUTCHours()).padStart(2,'0') + String(d.getUTCMinutes()).padStart(2,'0');
      text = rst + ' ' + nr + '-' + hhmm;
    } else if (type === 'NRLOC') {
      if (!loc) { text = rst + ' ' + nr + ' ⚠ set locator'; warn = true; }
      else       { text = rst + ' ' + nr + ' ' + loc; }
    } else if (type === 'STATIC') {
      if (!stat) { text = rst + ' ⚠ enter exchange'; warn = true; }
      else        { text = rst + ' ' + stat; }
    }

    previewEl.textContent = text;
    previewEl.classList.toggle('lm-exch-preview-warn', warn);
  }

  function _ensureExchHelpPopup() {
    if (document.getElementById('lmExchHelpPopup')) return;
    const d = document.createElement('div');
    d.className = 'si-popup lm-exch-help-popup';
    d.id = 'lmExchHelpPopup';
    d.innerHTML = `
      <p class="si-popup-head">Exchange type <button class="si-popup-close" id="lmExchHelpClose">&#x2715;</button></p>
      <dl class="lm-exch-help-list">
        <dt>NONE</dt>
        <dd>No exchange code is sent. Suitable for expedition-style operation or casual QSOs.</dd>
        <dt>NR</dt>
        <dd>A sequential QSO number is sent (001, 002, …). Standard for most HF contests.</dd>
        <dt>NR+UTC</dt>
        <dd>Sequential number plus current UTC time (e.g. 001-1430). Used in some RTTY contests (e.g. NRAU, Baltic).</dd>
        <dt>NR+LOC <small>(6m and up)</small></dt>
        <dd>Sequential number plus your Maidenhead locator (e.g. 001 JO70FD). Standard for VHF/UHF contests. Locator is taken from the <em>My locator</em> field.</dd>
        <dt>STATIC</dt>
        <dd>A fixed text you define (e.g. zone, district, region). Used in contests where the exchange does not change between QSOs.</dd>
      </dl>`;
    document.body.appendChild(d);
    document.getElementById('lmExchHelpClose').addEventListener('click', e => {
      e.stopPropagation();
      d.classList.remove('si-open');
    });
    document.addEventListener('click', e => {
      if (!d.contains(e.target) && e.target.id !== 'lmExchHelpBtn') d.classList.remove('si-open');
    });
  }

  function renderLogList() {
    const container = document.getElementById('lmLogList');
    if (!container) return;
    LogDB.getLogs().then(logs => {
      logs.sort((a,b) => b.createdAtUtc.localeCompare(a.createdAtUtc));
      Promise.all(logs.map(log =>
        LogDB.getQsosForLog(log.id).then(qsos => qsos.filter(q => !q.deleted).length)
      )).then(counts => {
        _allLogs   = logs;
        _allCounts = counts;
        applyFilter();
      });
    });
  }

  function applyFilter() {
    const container = document.getElementById('lmLogList');
    if (!container) return;
    const searchEl = document.getElementById('lmSearch');
    const query    = searchEl ? searchEl.value.trim().toLowerCase() : '';

    const filtered = _allLogs.reduce((acc, log, i) => {
      const match = !query
        || log.contestName.toLowerCase().includes(query)
        || log.stationCall.toLowerCase().includes(query);
      if (match) acc.push({ log, i });
      return acc;
    }, []);

    container.innerHTML = '';

    if (!filtered.length) {
      container.innerHTML = '<div class="lm-empty">' + (_allLogs.length ? 'No match.' : 'No logs yet.') + '</div>';
      return;
    }

    filtered.forEach(({ log, i }) => {
      const count    = _allCounts[i] || 0;
      const isActive = _activeLog && _activeLog.id === log.id;
      const row      = document.createElement('div');
      row.className  = 'lm-log-row' + (isActive ? ' lm-log-active' : '');
      row.innerHTML  = `
        <div class="lm-log-info">
          <span class="lm-log-name">${_esc(log.contestName)}</span>
          <span class="lm-log-meta">${_esc(log.stationCall)}${log.myLocator ? ' | ' + _esc(log.myLocator) : ''} | ${_esc(_exchDisplayLabel(log.defaultExchange))} | #${count}</span>
        </div>
        <div class="lm-log-btns">
          ${!isActive ? `<button class="lm-btn lm-btn-sm" data-act="open" data-id="${_esc(log.id)}">Open</button>` : '<span class="lm-active-tag">active</span>'}
          <button class="lm-btn lm-btn-sm lm-btn-export" data-act="csv"  data-id="${_esc(log.id)}">CSV</button>
          <button class="lm-btn lm-btn-sm lm-btn-export" data-act="adif" data-id="${_esc(log.id)}">ADIF</button>
          <button class="lm-btn lm-btn-sm lm-btn-del"    data-act="del"  data-id="${_esc(log.id)}">Del</button>
        </div>
      `;
      container.appendChild(row);
    });

    const total    = _allCounts.reduce((s, c) => s + c, 0);
    const filteredTotal = filtered.reduce((s, { i }) => s + (_allCounts[i] || 0), 0);
    const estKb  = total * 650;
    const estStr = estKb >= 1048576 ? '~' + (estKb / 1048576).toFixed(1) + ' MB'
                                    : '~' + (estKb / 1024).toFixed(0) + ' kB';
    const footer = document.createElement('div');
    footer.className = 'lm-log-total';
    const footerText = query
      ? `${filtered.length} / ${_allLogs.length} logs · ${filteredTotal} / ${total} QSO · ${estStr}`
      : `${_allLogs.length} logs · ${total} QSO · ${estStr}`;
    footer.innerHTML = `${footerText} <button class="si-btn" id="lmStorageInfo" type="button" title="How to check browser storage">ⓘ</button>`;
    footer.querySelector('#lmStorageInfo').addEventListener('click', e => {
      e.stopPropagation();
      _ensureStoragePopup();
      const p = document.getElementById('lmStorageInfoPopup');
      if (p) p.classList.toggle('si-open');
    });
    container.appendChild(footer);
  }

  function onLogListClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id  = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === 'open') {
      LogDB.getLog(id).then(log => { if (log) { activateLog(log); closeModal(); showDisclaimerIfNeeded(); } });
    } else if (act === 'csv') {
      LogDB.getLog(id).then(log => { if (log) downloadCsv(log); });
    } else if (act === 'adif') {
      LogDB.getLog(id).then(log => { if (log) downloadAdif(log); });
    } else if (act === 'del') {
      if (!confirm('Delete log ' + id + ' and all its QSOs?')) return;
      LogDB.getQsosForLog(id)
        .then(qsos => Promise.all(qsos.map(q => LogDB.deleteQso(q.id))))
        .then(() => LogDB.deleteLog(id))
        .then(() => {
          if (_activeLog && _activeLog.id === id) activateLog(null);
          renderLogList();
        });
    }
  }

  function onDeleteAll() {
    const btn = document.getElementById('lmDeleteAll');
    if (!btn) return;
    if (btn.dataset.confirm !== '1') {
      // first click — arm
      btn.dataset.confirm = '1';
      btn.textContent = '⚠ Confirm delete ALL?';
      btn.classList.add('lm-btn-del-confirm');
      clearTimeout(_delAllTimer);
      _delAllTimer = setTimeout(() => {
        btn.dataset.confirm = '';
        btn.textContent = 'Delete all';
        btn.classList.remove('lm-btn-del-confirm');
      }, 3000);
      return;
    }
    // second click — execute
    clearTimeout(_delAllTimer);
    btn.dataset.confirm = '';
    btn.textContent = 'Deleting…';
    btn.disabled = true;
    LogDB.openDb().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(['qso', 'logs'], 'readwrite');
      t.objectStore('qso').clear();
      t.objectStore('logs').clear();
      t.oncomplete = resolve;
      t.onerror    = e => reject(e.target.error);
    })).then(() => {
      activateLog(null);
      btn.disabled = false;
      btn.textContent = 'Delete all';
      btn.classList.remove('lm-btn-del-confirm');
      renderLogList();
    }).catch(err => {
      btn.disabled = false;
      btn.textContent = 'Delete all';
      alert('Error: ' + err.message);
    });
  }

  function onNewFormSubmit(e) {
    e.preventDefault();
    const contestName    = document.getElementById('lmContest').value.trim();
    const stationCall    = document.getElementById('lmMyCall').value.trim();
    const myLocator      = document.getElementById('lmLoc').value.trim();
    const startQsoNumber = parseInt(document.getElementById('lmStartNr').value, 10) || 1;
    const cwAbbrev       = document.getElementById('lmCwAbbrev').checked;
    const exchType       = document.getElementById('lmExchType').value;
    const defaultExchange = exchType === 'STATIC'
      ? (document.getElementById('lmExchStatic').value.trim())
      : exchType;

    if (!contestName || !stationCall) return;

    LogDB.createLog({ contestName, stationCall, defaultExchange, myLocator, startQsoNumber, cwAbbrev })
      .then(log => {
        activateLog(log);
        closeModal();
        showDisclaimerIfNeeded();
      });
  }

  function _esc(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Open / close ───────────────────────────────────────────────────────────

  function openModal() {
    let modal = document.getElementById('logMgrModal');
    if (!modal) modal = buildModal();
    modal.classList.remove('lm-hidden');
    const inp = document.getElementById('lmContest');
    if (inp && !inp.value) inp.value = todayYyyymmdd() + '-';
    renderLogList();
  }

  function closeModal() {
    const modal = document.getElementById('logMgrModal');
    if (modal) modal.classList.add('lm-hidden');
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  global.LogManager = {
    getActiveLog, onLogChanged, activateLog, restoreActiveLog,
    bumpQsoNumber, openModal, closeModal,
    downloadCsv, downloadAdif,
  };

}(window));

// ────────────────────────────────────────────────────────────────────────────

'use strict';
/**
 * log-macros.js — contest macro generator
 *
 * Macros: CQ, TXEXCH, TXEXCHSP, TXEXCHSP2, TU
 * Transport: HTTP POST /cmd {type:"sendCw", text} — firmware routes CW vs FSK/RTTY by current TRX mode.
 */

(function (global) {

  // ── Mode classification ────────────────────────────────────────────────────

  // Which keying path a radio mode belongs to. 'NONE' means the interface has no
  // path at all: sendCW() in the firmware keys only in CW/CW-R (CI-V message) and
  // RTTY/RTTY-R (FSK GPIO), so the data modes the radio reports with a -D suffix
  // (USB-D, LSB-D), WFM and UNK cannot be transmitted from here. This used to
  // fall back to 'CW', which built CW text, POSTed it, took the ok:true for an
  // answer -- and logged a report that never left the box.
  function modeGroup(mode) {
    const m = (mode || '').toUpperCase();
    if (['CW','CW-R','CWR'].includes(m))                        return 'CW';
    if (['RTTY','RTTY-R','RTTYR','FSK'].includes(m))            return 'RTTY';
    if (['SSB','LSB','USB','FM','WFM','AM','DV'].includes(m))    return 'PHONE';
    return 'NONE';
  }

  function isVhfPlus(freqHz) {
    return Number(freqHz) > 49_000_000;
  }

  // ── CW number: 3-char padded, 0→T and 9→N when abbrev enabled ─────────────

  function cwNumber(n, abbrev) {
    const s = String(n).padStart(3, '0');
    if (!abbrev) return s;
    return s.replace(/0/g, 'T').replace(/9/g, 'N');
  }

  // ── UTC HHMM ───────────────────────────────────────────────────────────────

  function utcHHMM() {
    const d = new Date();
    return String(d.getUTCHours()).padStart(2,'0') + String(d.getUTCMinutes()).padStart(2,'0');
  }

  function utcHHMMcw(abbrev) {
    const s = utcHHMM();
    if (!abbrev) return s;
    return s.replace(/0/g, 'T').replace(/9/g, 'N');
  }

  // ── Sent report ────────────────────────────────────────────────────────────
  // The operator's Snt field decides what goes on the air, so the log and the
  // air cannot disagree. Anything unusable falls back to the plain 599, which
  // keeps the untouched case byte-for-byte identical to the old hardcoded text
  // — the CW path sends the payload verbatim, without upper-casing it.
  function rstText(ctx, abbrev) {
    const raw = String(ctx.rstSent || '').trim().toUpperCase();
    const rst = /^[1-5][1-9N]{1,2}$/.test(raw) ? raw.replace(/N/g, '9') : '599';
    return abbrev ? rst.replace(/0/g, 't').replace(/9/g, 'n') : rst;
  }

  // ── Build macro text ───────────────────────────────────────────────────────

  /**
   * buildMacro(type, ctx) → string
   *
   * ctx = {
   *   mode, freqHz, stationCall, call, exchangeType,
   *   exchange, qsoNumber, prevQsoNumber, myLocator, cwAbbrev, rstSent
   * }
   * type: 'CQ' | 'TXEXCH' | 'TXEXCHSP' | 'TXEXCHSP2' | 'TU'
   */
  function buildMacro(type, ctx) {
    const mg     = modeGroup(ctx.mode);
    const vhf    = isVhfPlus(ctx.freqHz);
    const abbrev = ctx.cwAbbrev !== false;
    const rst    = rstText(ctx, abbrev);   // CW: abbreviated (5nn)
    const rstPlain = rstText(ctx, false);      // RTTY: always digits
    const nr     = cwNumber(ctx.qsoNumber  || 1, abbrev);
    const prevNr = cwNumber(ctx.prevQsoNumber || Math.max(1, (ctx.qsoNumber || 1) - 1), abbrev);
    const loc    = ctx.myLocator || '';
    const myCall = ctx.stationCall || 'MYCALL';
    const dxCall = ctx.call        || '';

    switch (type) {

      case 'CQ':
        if (mg === 'RTTY') return '\r\n ' + myCall + ' ' + myCall + ' ' + myCall + ' TEST';
        if (mg === 'CW')   return myCall + ' ' + myCall + ' TEST';
        return '';  // PHONE — manual

      case 'TXEXCH': {
        if (mg === 'RTTY') {
          const nrStr  = String(ctx.qsoNumber || 1).padStart(3, '0');
          const excStr = ctx.exchangeType === 'NRUTC' ? (rstPlain + '-' + nrStr + '-' + utcHHMM())
                       : ctx.exchangeType === 'NRLOC' ? (rstPlain + '-' + nrStr + '-' + loc)
                       : ctx.exchangeType === 'NR'    ? rstPlain + '-' + nrStr
                       : (ctx.exchange ? rstPlain + '-' + ctx.exchange : rstPlain);
          return '\r\n ' + dxCall + ' ' + dxCall + ' ' + excStr + ' ' + excStr;
        }
        if (mg === 'CW') {
          if (ctx.exchangeType === 'NR' || ctx.exchangeType === 'NRUTC') {
            const nrPart = ctx.exchangeType === 'NRUTC' ? nr + '-' + utcHHMMcw(abbrev) : nr;
            return vhf ? dxCall + ' ' + rst + ' ' + nrPart + ' ' + loc
                       : dxCall + ' ' + rst + ' ' + nrPart;
          }
          if (ctx.exchangeType === 'NRLOC') return dxCall + ' ' + rst + ' ' + nr + ' ' + loc;
          return dxCall + ' ' + rst + ' ' + ctx.exchange;
        }
        return '';
      }

      case 'TXEXCHSP': {
        if (mg === 'RTTY') {
          const nrStr  = String(ctx.qsoNumber || 1).padStart(3, '0');
          const excStr = ctx.exchangeType === 'NRUTC' ? (rstPlain + '-' + nrStr + '-' + utcHHMM())
                       : ctx.exchangeType === 'NRLOC' ? (rstPlain + '-' + nrStr + '-' + loc)
                       : ctx.exchangeType === 'NR'    ? rstPlain + '-' + nrStr
                       : (ctx.exchange ? rstPlain + '-' + ctx.exchange : rstPlain);
          return '\r\n ' + dxCall + ' ' + dxCall + ' ' + excStr + ' ' + excStr;
        }
        if (mg === 'CW') {
          if (ctx.exchangeType === 'NR' || ctx.exchangeType === 'NRUTC') {
            const nrPart = ctx.exchangeType === 'NRUTC' ? nr + '-' + utcHHMMcw(abbrev) : nr;
            return vhf ? rst + ' ' + nrPart + ' ' + loc + ' tu' : rst + ' ' + nrPart;
          }
          if (ctx.exchangeType === 'NRLOC') return rst + ' ' + nr + ' ' + loc + ' tu';
          return ctx.exchange ? rst + ' ' + ctx.exchange : rst + ' tu';
        }
        return '';
      }

      case 'TXEXCHSP2': {
        const pn    = ctx.prevQsoNumber || Math.max(1, (ctx.qsoNumber || 1) - 1);
        const pnCw  = cwNumber(pn, abbrev);
        const pnStr = String(pn).padStart(3, '0');
        if (mg === 'RTTY') {
          const excStr = ctx.exchangeType === 'NRUTC' ? (rstPlain + '-' + pnStr + '-' + utcHHMM())
                       : ctx.exchangeType === 'NRLOC' ? (rstPlain + '-' + pnStr + '-' + loc)
                       : ctx.exchangeType === 'NR'    ? rstPlain + '-' + pnStr
                       : (ctx.exchange ? rstPlain + '-' + ctx.exchange : rstPlain);
          return '\r\n ' + dxCall + ' ' + dxCall + ' ' + excStr + ' ' + excStr;
        }
        if (mg === 'CW') {
          if (ctx.exchangeType === 'NR' || ctx.exchangeType === 'NRUTC') {
            const pnPart = ctx.exchangeType === 'NRUTC' ? pnCw + '-' + utcHHMMcw(abbrev) : pnCw;
            return vhf ? rst + ' ' + pnPart + ' ' + loc : rst + ' ' + pnPart;
          }
          if (ctx.exchangeType === 'NRLOC') return rst + ' ' + pnCw + ' ' + loc;
          return ctx.exchange ? rst + ' ' + ctx.exchange : rst + ' tu';
        }
        return '';
      }

      case 'TU':
        if (mg === 'RTTY') return dxCall + ' tu ' + myCall;
        if (mg === 'CW')   return 'tu ' + myCall;
        return '';

      case 'CALLTU':
        if (mg === 'RTTY') return dxCall + ' tu ' + myCall;
        if (mg === 'CW')   return dxCall + ' tu';
        return '';

      default:
        return '';
    }
  }

  // ── Send a macro via HTTP POST /cmd ───────────────────────────────────────

  function sendMacro(type, ctx) {
    const text = buildMacro(type, ctx);
    if (!text) return Promise.resolve(false);  // PHONE mode — nothing to send
    if (ctx._oi3) {
      return fetch('/oi3/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trx: ctx._trx, text })
      }).then(r => r.ok).catch(() => false);
    }
    return fetch('/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'sendCw', text })
    }).then(r => r.ok).catch(() => false);
  }

  // ── Init (no-op, kept for API compatibility) ───────────────────────────────

  function init() {}

  // ── Export ─────────────────────────────────────────────────────────────────

  global.LogMacros = { buildMacro, sendMacro, modeGroup, init };

}(window));

// ────────────────────────────────────────────────────────────────────────────

'use strict';

// ── App state ─────────────────────────────────────────────────────────────────

const app = {
  runMode:    'RUN',   // 'RUN' | 'SP'
  activeTrx:  1,       // 1 | 2 | 3
  trxLabels:  ['TRX1', 'TRX2', 'TRX3'],
  trxOi3:     [false, false, false],  // OI3 mode per TRX (true when NET_ID != 0)

  // TRX state from /state polling
  connected:  false,
  dxcConnected: false,
  frequency:  0,
  mode:       'USB',
  tx:         false,
  fwRev:      '',

  // RST fields: true if the operator manually edited one for the current QSO.
  // Tracked per field so editing the received report does not freeze the sent
  // one from following a mode change (and the other way round).
  rstSentDirty: false,
  rstRcvdDirty: false,

  // The sent report as it actually went on the air, captured when a macro
  // carrying it was successfully transmitted. The log records this, not the
  // field — editing the field afterwards cannot rewrite what was already sent.
  rstSentTx:  '',

  // Which QSO the capture above belongs to. Incremented whenever the reports are
  // reset (a QSO logged, or a QSO abandoned). The acknowledgement of a macro is
  // asynchronous: in S&P the same Enter that keys the exchange also writes the
  // QSO, and the IndexedDB write usually wins the race against the round trip to
  // the ESP32. Without this, that late ok:true stamped the finished QSO's report
  // onto the next one, so every S&P contact logged the report before it.
  qsoGeneration: 0,

  // Form state machine
  formState:      'IDLE',  // IDLE | CALL_ENTERED | EXCHANGE_ENTERED | LOGGED
  prevCallSent:   '',      // call as sent in TXEXCH, for TU/CALL-TU decision
  skipNextTu:     false,   // true when CALLTU was already sent, suppress regular TU

  // Blocked DXCC list (parsed from /log-config at startup)
  blockedDxccList: [],     // lowercase country names, e.g. ['russia', 'kaliningrad']

  _pollTimer:  null,
  _hintTimer:  null,
};

// ── Auto-backup state ─────────────────────────────────────────────────────────

let _backupIdleTimer = null;
let _qsoSinceBackup  = 0;
const BACKUP_IDLE_MS = 30 * 60 * 1000;

// ── DOM references ────────────────────────────────────────────────────────────

const inpCall     = document.getElementById('inpCall');
const inpRst      = document.getElementById('inpRst');      // sent
const inpRstRcvd  = document.getElementById('inpRstRcvd');  // received
const inpExch     = document.getElementById('inpExch');
const btnRunMode  = document.getElementById('btnRunMode');
const logHint     = document.getElementById('logHint');
const logEmptyHint = document.getElementById('logEmptyHint');

const trxButtons  = [
  document.getElementById('btnTrx1'),
  document.getElementById('btnTrx2'),
  document.getElementById('btnTrx3'),
];

const sbTime      = document.getElementById('sbTime');
const sbFreq      = document.getElementById('sbFreq');
const sbMode      = document.getElementById('sbMode');
const macroPreview = document.getElementById('macroPreview');
const sbContinent = document.getElementById('sbContinent');
const sbCountry   = document.getElementById('sbCountry');
const sbPrefix    = document.getElementById('sbPrefix');
const sbCq        = document.getElementById('sbCq');
const sbItu       = document.getElementById('sbItu');
const sbUtc       = document.getElementById('sbUtc');
const sbQrb       = document.getElementById('sbQrb');
const sbAz        = document.getElementById('sbAz');

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatFreq(hz) {
  const n = Math.round(Number(hz));
  if (!n) return '-.---.--';
  const mhz  = Math.floor(n / 1_000_000);
  const khz  = Math.floor((n % 1_000_000) / 1000);
  const tens = Math.floor((n % 1000) / 10);
  return `${mhz}.${String(khz).padStart(3, '0')}.${String(tens).padStart(2, '0')}`;
}

// The report convention for a mode: two digits on phone, three otherwise.
//
// The mode text from /state is richer than it looks. applyModeState() in the
// firmware appends -D for the radio's data mode (USB-D, LSB-D), and it also
// emits WFM and UNK. The old list named six phone modes and let everything else
// fall through to 599, so WFM -- plain phone -- prefilled a CW report. Decide on
// the base and let the -D suffix mean a data QSO, which is reported in three
// digits like RTTY. UNK returns '' : an unreadable mode is no reason to overwrite
// a field the operator is working in, so callers leave it alone.
function rstDefault(mode) {
  if (!mode) return '59';
  const m = String(mode).trim().toUpperCase();
  if (m === 'UNK') return '';
  if (m.endsWith('-D')) return '599';
  switch (m) {
    case 'SSB': case 'LSB': case 'USB': case 'FM': case 'WFM': case 'AM': case 'DV':
      return '59';
    default:
      return '599';
  }
}

// A report is only allowed on the air (and into the log as "sent") once it is
// complete. Without this a half-typed field would be keyed: the operator clears
// 599, types "5", and in RUN mode the next Enter sends TXEXCH straight away.
// N is the CW shorthand for 9 and is accepted as typed.
function validRst(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return /^[1-5][1-9N]{1,2}$/.test(s) ? s.replace(/N/g, '9') : '';
}

// What a report field contributes to the log. The air needs a report it can key,
// which is what validRst() is for; the log needs the truth, which is whatever the
// operator left in the field. Substituting the default for an unusable value --
// logging 599 for a field reading "4" -- writes a report nobody sent and nobody
// heard, and it looks perfectly correct in the journal forever. N is folded to 9
// because 5NN is the CW spelling of 599 and the log carries digits. An empty
// field is the one case with nothing to be faithful to, so it takes the default.
function rstForLog(raw, mode) {
  const s = String(raw || '').trim().toUpperCase().replace(/N/g, '9');
  return s || rstDefault(mode) || '599';
}

// Both RST fields follow the mode until the operator touches them.
function resetRstFields() {
  const d = rstDefault(app.mode);
  if (d) {
    inpRst.value     = d;
    inpRstRcvd.value = d;
  }
  app.rstSentDirty = false;
  app.rstRcvdDirty = false;
}

// The report state that belongs to one QSO and must not outlive it: the fields,
// the operator's edits, and the record of what went on the air. Bumping the
// generation is what makes a macro acknowledgement that arrives after this point
// harmless -- it belongs to a QSO that is already written.
function resetReportsForNewQso() {
  resetRstFields();
  app.rstSentTx = '';
  app.qsoGeneration++;
}

function utcHHMM() {
  const d = new Date();
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

// ── UTC clock (fires every second, aligned to wall-clock seconds) ─────────────

function startClock() {
  function tick() {
    sbTime.textContent = utcHHMM();
    const msUntilNextSecond = 1000 - (Date.now() % 1000);
    setTimeout(tick, msUntilNextSecond);
  }
  tick();
}

// ── /state polling ────────────────────────────────────────────────────────────

function pollState() {
  clearTimeout(app._pollTimer);
  const trxIdx = app.activeTrx - 1;
  const isOi3  = app.trxOi3[trxIdx] && trxIdx > 0;
  const url    = isOi3 ? '/oi3/state?trx=' + (trxIdx + 1) : '/state';
  fetch(url)
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(data => {
      applyState(data);
      app._pollTimer = setTimeout(pollState, 500);
    })
    .catch(() => {
      applyDisconnected();
      app._pollTimer = setTimeout(pollState, 1000);
    });
}

function applyState(data) {
  app.connected = !!data.connected;
  if (typeof data.dxcConnected === 'boolean') {
    app.dxcConnected = data.dxcConnected;
  }
  if (data.fwRev && !app.fwRev) {
    app.fwRev = String(data.fwRev);
    if (window.setFwRev) {
      window.setFwRev(app.fwRev);
    } else {
      const el = document.getElementById('topbarFw');
      if (el) el.textContent = 'FW ' + app.fwRev;
    }
  }

  // Update frequency/mode/tx only when radio is actually connected —
  // when disconnected, preserve manually entered values
  if (app.connected) {
    app.frequency = data.frequency || 0;
    app.tx        = !!data.tx;
    const newMode = (data.mode || 'USB').trim();
    if (newMode !== app.mode) {
      app.mode = newMode;
      const d = rstDefault(app.mode);   // '' on UNK — leave the fields as they are
      if (d && !app.rstSentDirty) inpRst.value     = d;
      if (d && !app.rstRcvdDirty) inpRstRcvd.value = d;
    }
  }

  renderStatusBar();
  renderConnStatus();
  try { _updateDxcBand(app.connected ? app.frequency : 0, app.dxcConnected); } catch (_) {}
}

function applyDisconnected() {
  app.connected = false;
  renderStatusBar();
  renderConnStatus();
  try { _updateDxcBand(0, app.dxcConnected); } catch (_) {}
}

// ── Status bar rendering ──────────────────────────────────────────────────────

function renderStatusBar() {
  if (app.connected) {
    sbFreqModeGroup.style.display = '';
    sbManualGroup.style.display   = 'none';
    sbFreq.textContent = formatFreq(app.frequency);
    sbMode.textContent = app.mode || '---';
  } else {
    sbFreqModeGroup.style.display = 'none';
    sbManualGroup.style.display   = '';
  }
  // Preserve DXCC while call field has content; clear only when empty
  if (inpCall.value.trim()) {
    updateDxccFromCall();
  } else {
    renderDxccStatus(null);
  }
}

const sbDxccGroup      = document.getElementById('sbDxccGroup');
const sbExchLocGroup   = document.getElementById('sbExchLocGroup');
const sbExchLoc        = document.getElementById('sbExchLoc');
const sbExchAz         = document.getElementById('sbExchAz');
const sbExchQrb        = document.getElementById('sbExchQrb');
const azIndicator      = document.getElementById('azIndicator');
const sbFreqModeGroup  = document.getElementById('sbFreqModeGroup');
const sbManualGroup    = document.getElementById('sbManualGroup');
const sbManualFreq     = document.getElementById('sbManualFreq');
const sbManualMode     = document.getElementById('sbManualMode');

function renderDxccStatus(dxcc) {
  if (!dxcc) {
    sbDxccGroup.style.display = 'none';
    azIndicator.classList.remove('az-active');
    return;
  }
  sbDxccGroup.style.display = '';
  if (dxcc.azimuthDeg != null) {
    azIndicator.textContent = '↑';
    azIndicator.style.transform = 'rotate(' + dxcc.azimuthDeg + 'deg)';
    azIndicator.classList.add('az-active');
  } else {
    azIndicator.classList.remove('az-active');
  }
  // Phase 2 will call renderDxccStatus(result) with populated data:
  // { continent, country, mainPrefix, cqZone, ituZone, utcOffset, qrbKm, azimuthDeg }
  sbContinent.textContent = dxcc.continent   || '--';
  sbCountry.textContent   = dxcc.country     || '--';
  sbPrefix.textContent    = dxcc.mainPrefix  || '--';
  sbCq.textContent        = dxcc.cqZone ? 'CQ-' + dxcc.cqZone : 'CQ--';
  sbItu.textContent       = dxcc.ituZone ? 'ITU-' + dxcc.ituZone : 'ITU--';
  sbUtc.textContent       = dxcc.utcOffset != null ? 'utc ' + dxcc.utcOffset : 'utc --';
  sbQrb.textContent       = dxcc.qrbKm  != null ? 'QRB ' + dxcc.qrbKm + 'km' : 'QRB --';
  sbAz.textContent        = dxcc.azimuthDeg != null ? 'Az ' + dxcc.azimuthDeg + '°' : 'Az --';
}

// ── Exchange locator preview (VHF/UHF — triggered on spacebar in inpExch) ────

function updateExchLocatorPreview() {
  if (app.frequency <= 49_000_000) {
    sbExchLocGroup.style.display = 'none';
    return;
  }
  const text = inpExch.value;
  const m    = text.match(/(?:^| )([A-R]{2}[0-9]{2}[A-X]{2})(?= |$)/i);
  if (!m) {
    sbExchLocGroup.style.display = 'none';
    return;
  }
  const loc   = m[1].toUpperCase();
  const myLoc = (window._logSettings && window._logSettings.myLocator) || window._deviceLocator || '';
  sbExchLoc.textContent = loc;
  if (myLoc && window.DXCC) {
    const dxPos = DXCC.locatorToLatLon(loc);
    const myPos = DXCC.locatorToLatLon(myLoc);
    if (dxPos && myPos) {
      const { qrbKm, azimuthDeg } = DXCC.calculateQrbAzimuth(
        myPos.lat, myPos.lon, dxPos.lat, dxPos.lon
      );
      sbExchAz.textContent  = azimuthDeg + '°';
      sbExchQrb.textContent = qrbKm + ' km';
      azIndicator.textContent = '↑';
      azIndicator.style.transform = 'rotate(' + azimuthDeg + 'deg)';
      azIndicator.classList.add('az-active');
    } else {
      sbExchAz.textContent  = '--';
      sbExchQrb.textContent = '--';
    }
  } else {
    sbExchAz.textContent  = '--';
    sbExchQrb.textContent = '--';
  }
  sbExchLocGroup.style.display = '';
}

// ── Connection status indicator ───────────────────────────────────────────────

function renderConnStatus() {
  trxButtons.forEach((b, i) => {
    b.classList.remove('trx-conn-ok', 'trx-conn-off');
    if (i === app.activeTrx - 1) {
      b.classList.add(app.connected ? 'trx-conn-ok' : 'trx-conn-off');
    }
  });
}

// ── Hint message (auto-clear) ─────────────────────────────────────────────────

function showHint(msg, durationMs) {
  logHint.textContent = msg;
  clearTimeout(app._hintTimer);
  app._hintTimer = setTimeout(() => { logHint.textContent = ''; }, durationMs || 2000);
}

// ── Auto-backup: helpers, idle timer, close warning (C + D) ──────────────────

function _backupFileTs(d) {
  const p = n => String(n).padStart(2, '0');
  return String(d.getUTCFullYear()) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
         '-' + p(d.getUTCHours()) + p(d.getUTCMinutes());
}

function _idbGetAllStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = e  => reject(e.target.error);
  });
}

async function backupDb() {
  const now = new Date();
  const cdb = await LogDB.openDb();
  const [logs, qso, settings] = await Promise.all([
    _idbGetAllStore(cdb, 'logs'),
    _idbGetAllStore(cdb, 'qso'),
    _idbGetAllStore(cdb, 'settings'),
  ]);

  let syncState = [], devices = [];
  try {
    const sdb = await new Promise((res, rej) => {
      const r = indexedDB.open('datasyncDb', 1);
      r.onsuccess      = e => res(e.target.result);
      r.onerror        = e => rej(e.target.error);
      r.onupgradeneeded = () => {};
    });
    [syncState, devices] = await Promise.all([
      _idbGetAllStore(sdb, 'sync_state').catch(() => []),
      _idbGetAllStore(sdb, 'devices').catch(() => []),
    ]);
  } catch (_) {}

  const fname  = _backupFileTs(now) + '-QSO-database.json';
  const backup = {
    export_version: 1,
    exported_at:    now.toISOString(),
    stores:         { logs, qso, settings, sync_state: syncState, devices },
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = fname; a.click();
  URL.revokeObjectURL(url);
  return fname;
}

function _beforeUnloadHandler(e) {
  e.preventDefault();
  e.returnValue = '';
}

function _disarmBeforeUnload() {
  window.removeEventListener('beforeunload', _beforeUnloadHandler);
}

function _onBackupDone() {
  _qsoSinceBackup = 0;
  _disarmBeforeUnload();
  document.getElementById('btnBackup').classList.remove('btn-backup-pending');
}

function _resetBackupTimer() {
  clearTimeout(_backupIdleTimer);
  _backupIdleTimer = setTimeout(async () => {
    try {
      const fname = await backupDb();
      showHint('Auto-backup: ' + fname);
      _onBackupDone();
    } catch (err) {
      showHint('Auto-backup failed: ' + (err.message || err));
    }
  }, BACKUP_IDLE_MS);
}

function _onQsoBackupHook() {
  _qsoSinceBackup++;
  _resetBackupTimer();
  if (_qsoSinceBackup === 1) {
    document.getElementById('btnBackup').classList.add('btn-backup-pending');
    window.addEventListener('beforeunload', _beforeUnloadHandler);
  }
}

function _initBackup() {
  document.getElementById('btnBackup').addEventListener('click', async () => {
    try {
      const fname = await backupDb();
      showHint('Backup: ' + fname);
      _onBackupDone();
    } catch (err) {
      showHint('Backup error: ' + (err.message || err));
    }
  });
}

// ── RUN / S&P toggle ──────────────────────────────────────────────────────────

function setRunMode(mode) {
  app.runMode = mode;  // 'RUN' | 'SP'
  btnRunMode.innerHTML = mode === 'RUN' ? 'R<u>U</u>N' : 'S&amp;P';
  // RUN: show *?, hide check  /  S&P: show check, hide *?
  btnCallQ.classList.toggle('btn-action-hidden', mode !== 'RUN');
  btnCheck.classList.toggle('btn-action-hidden', mode !== 'SP');
  updateMacroPreview();
}

btnRunMode.addEventListener('click', () => {
  setRunMode(app.runMode === 'RUN' ? 'SP' : 'RUN');
  inpCall.focus();
});

// ── TRX switching helper ──────────────────────────────────────────────────────

function selectTrx(n) {
  const btn = trxButtons[n - 1];
  if (!btn || btn.style.display === 'none') return;
  btn.click();
}

// ── Help modal ────────────────────────────────────────────────────────────────

function openHelpModal() {
  document.getElementById('helpModal').classList.remove('lm-hidden');
}
function closeHelpModal() {
  document.getElementById('helpModal').classList.add('lm-hidden');
}

document.getElementById('btnHelp').addEventListener('click', openHelpModal);
document.getElementById('helpModalClose').addEventListener('click', closeHelpModal);
document.getElementById('helpModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeHelpModal();
});

// ── Global hotkeys ────────────────────────────────────────────────────────────

// Under Alt the browser reports the character the *layout* produced, not the
// letter printed on the keycap. With CapsLock on, Alt+U arrives as key "U"; on
// macOS Option+U is a dead key ("Dead"), Option+W is "∑" and Option+1 is "¡".
// Matching on key alone therefore killed exactly the letter shortcuts while the
// digits and Enter went on working. e.code names the physical key, which no
// layout and no CapsLock can move; key stays as the fallback for the rare input
// method that reports no code at all.
function altHotkey(e, codes, key) {
  if (!e.altKey || e.ctrlKey || e.shiftKey) return false;   // AltGr is Ctrl+Alt
  if (e.code) return codes.includes(e.code);
  return typeof e.key === 'string' && e.key.toLowerCase() === key;
}

document.addEventListener('keydown', e => {
  // Esc — close help modal, then QSO edit dialog
  if (e.key === 'Escape') {
    const help = document.getElementById('helpModal');
    if (help && !help.classList.contains('lm-hidden')) {
      closeHelpModal();
      return;
    }
    const modal = document.getElementById('qsoEditModal');
    if (modal && !modal.classList.contains('lm-hidden')) {
      closeQsoEdit();
      return;
    }
    abortTransmission();
    return;
  }
  // Alt+1/2/3 — select TRX
  for (const n of [1, 2, 3]) {
    if (altHotkey(e, ['Digit' + n, 'Numpad' + n], String(n))) {
      e.preventDefault();
      selectTrx(n);
      return;
    }
  }
  // Alt+U — toggle RUN / S&P
  if (altHotkey(e, ['KeyU'], 'u')) {
    e.preventDefault();
    setRunMode(app.runMode === 'RUN' ? 'SP' : 'RUN');
    inpCall.focus();
    return;
  }
  // Alt+W — clear all input fields
  if (altHotkey(e, ['KeyW'], 'w')) {
    e.preventDefault();
    clearForm();
    renderDxccStatus(null);
    inpCall.focus();
    return;
  }
  // Alt+Enter — log current QSO without sending any memory
  if (altHotkey(e, ['Enter', 'NumpadEnter'], 'enter')) {
    e.preventDefault();
    logCurrentQsoOnly();
  }
});

// ── TRX selection ─────────────────────────────────────────────────────────────

function updateTrxHeader() {
  const hdr = document.getElementById('jhdrTrx');
  if (hdr) hdr.textContent = app.trxLabels[app.activeTrx - 1] || 'TRX';
}

trxButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    app.activeTrx = Number(btn.dataset.trx);
    trxButtons.forEach(b => b.classList.toggle('btn-trx-active', b === btn));
    // clear stale frequency/mode so a different TRX's values don't leak into the log
    app.frequency = 0;
    app.connected = false;
    sbManualFreq.value = '';
    updateTrxHeader();
    renderStatusBar();
    renderConnStatus();
    try { _updateDxcBand(0, app.dxcConnected); } catch (_) {}
    clearTimeout(app._pollTimer);
    pollState();
    inpCall.focus();
  });
});

// ── Input: uppercase normalisation ────────────────────────────────────────────

function normaliseUpper(inp) {
  inp.addEventListener('input', () => {
    const pos = inp.selectionStart;
    inp.value = inp.value.toUpperCase();
    inp.setSelectionRange(pos, pos);
  });
}

normaliseUpper(inpCall);
normaliseUpper(inpExch);
inpExch.addEventListener('input', updateExchLocatorPreview);

inpRst.addEventListener('input',     () => { app.rstSentDirty = true; });
inpRstRcvd.addEventListener('input', () => { app.rstRcvdDirty = true; });

// ── DXCC lookup on Call input ─────────────────────────────────────────────────

inpCall.addEventListener('input', () => {
  updateDxccFromCall();
  // An emptied Call field is an abandoned QSO. Its reports must not follow the
  // operator to the next station: a 559 typed for a caller that faded away would
  // otherwise be logged, silently, for whoever comes next. The reset sits here
  // and not on the first character of a new call on purpose — that would wipe a
  // report deliberately set before the call was typed.
  if (!inpCall.value.trim()) {
    clearDupePanel();
    resetReportsForNewQso();
  }
});

function updateDxccFromCall() {
  const call = inpCall.value.trim();
  if (!call || !window.DXCC) {
    renderDxccStatus(null);
    return;
  }

  const dxcc = DXCC.lookupDxcc(call);
  if (!dxcc) {
    renderDxccStatus(null);
    return;
  }

  // Attach QRB/azimuth if we have our locator from settings
  const myLoc = (window._logSettings && window._logSettings.myLocator) || window._deviceLocator || '';
  if (myLoc) {
    const myPos = DXCC.locatorToLatLon(myLoc);
    if (myPos) {
      const { qrbKm, azimuthDeg } = DXCC.calculateQrbAzimuth(
        myPos.lat, myPos.lon, dxcc.latitude, dxcc.longitude
      );
      dxcc.qrbKm     = qrbKm;
      dxcc.azimuthDeg = azimuthDeg;
    }
  }

  renderDxccStatus(dxcc);
}

// ── Blocked DXCC check ────────────────────────────────────────────────────────

function blockedCountryForCall(call) {
  if (!app.blockedDxccList.length || !window.DXCC) return null;
  const dxcc = DXCC.lookupDxcc(call);
  if (!dxcc || !dxcc.country) return null;
  const country = dxcc.country.toLowerCase();
  return app.blockedDxccList.some(b => country.includes(b)) ? dxcc.country : null;
}

// ── Dupe panel reference (needed by clearForm below) ─────────────────────────

const dupePanel = document.getElementById('dupePanel');

function clearDupePanel() {
  dupePanel.textContent = '';
  dupePanel.classList.add('dupe-panel-hidden');
  document.querySelectorAll('.qso-row.qso-dupe').forEach(r => r.classList.remove('qso-dupe'));
}

// ── Form state machine helpers ────────────────────────────────────────────────

function formStateOf() {
  const call = inpCall.value.trim();
  const exch = inpExch.value.trim();
  if (!call && !exch) return 'IDLE';
  if (call  && !exch) return 'CALL_ENTERED';
  return 'EXCHANGE_ENTERED';
}

function clearForm() {
  inpCall.value    = '';
  inpExch.value    = '';
  resetReportsForNewQso();
  app.prevCallSent = '';
  app.skipNextTu   = false;
  app.formState    = 'IDLE';
  renderDxccStatus(null);
  sbExchLocGroup.style.display = 'none';
  clearDupePanel();
  setPrevExchVisible(false);
}

// ── Macro context builder ─────────────────────────────────────────────────────

function macroCtx(overrides) {
  const log    = LogManager.getActiveLog() || {};
  const trxIdx = app.activeTrx - 1;
  const de     = log.defaultExchange || '';
  return Object.assign({
    mode:         app.mode,
    freqHz:       app.frequency,
    stationCall:  log.stationCall  || '',
    call:         inpCall.value.trim(),
    exchangeType: ['NR','NRUTC','NRLOC'].includes(de) ? de : 'STATIC',
    exchange:     de,
    // Never empty: rstDefault() has nothing to say about UNK, and a mode that
    // cannot be read is still a mode nothing gets keyed in, so the value is only
    // ever a placeholder for the preview.
    rstSent:      validRst(inpRst.value) || rstDefault(app.mode) || '599',
    qsoNumber:    log.nextQsoNumber    || 1,
    prevQsoNumber:(log.nextQsoNumber   || 1) - 1,
    myLocator:    log.myLocator        || '',
    cwAbbrev:     log.cwAbbrev !== false,
    _oi3:         app.trxOi3[trxIdx] && trxIdx > 0,
    _trx:         app.activeTrx,
  }, overrides);
}

// ── Send CW/RTTY macro via WebSocket ─────────────────────────────────────────

// Macros that put the sent report on the air. CQ and TU do not carry one.
const RST_BEARING_MACROS = ['TXEXCH', 'TXEXCHSP', 'TXEXCHSP2'];

function sendMacroText(macroType) {
  if (!window.LogMacros) return;
  const mg = LogMacros.modeGroup(app.mode);
  if (mg === 'PHONE') {
    showHint('Phone mode — send manually');
    return;
  }
  // No keying path for this mode (a data mode, WFM, UNK). Refuse here rather than
  // POST into a firmware that would drop it and answer ok:true anyway.
  if (mg === 'NONE') {
    showHint(app.mode + ' cannot be keyed — send manually');
    return;
  }
  const trxIdx = app.activeTrx - 1;
  const isOi3  = app.trxOi3[trxIdx] && trxIdx > 0;
  if (!app.connected && !isOi3) {
    showHint('TRX not connected');
    return;
  }
  const ctx = macroCtx();
  const gen = app.qsoGeneration;
  LogMacros.sendMacro(macroType, ctx).then(ok => {
    if (!ok) { showHint('Send failed'); return; }
    // Only these three carry the report; CQ and TU do not. A failed POST is not
    // recorded — nothing left the interface.
    if (!RST_BEARING_MACROS.includes(macroType)) return;
    // The QSO this went out for is already logged or abandoned. Whatever it
    // transmitted is history that belongs to that QSO, not to the one now on the
    // screen.
    if (gen !== app.qsoGeneration) return;
    app.rstSentTx = ctx.rstSent;
  });
}

function sendRawText(text) {
  if (!text || !window.LogMacros) return;
  const mg = LogMacros.modeGroup(app.mode);
  if (mg === 'PHONE') { showHint('Phone mode — send manually'); return; }
  if (mg === 'NONE')  { showHint(app.mode + ' cannot be keyed — send manually'); return; }
  const trxIdx = app.activeTrx - 1;
  const isOi3  = app.trxOi3[trxIdx] && trxIdx > 0;
  if (!app.connected && !isOi3) { showHint('TRX not connected'); return; }
  const url  = isOi3 ? '/oi3/send' : '/cmd';
  const body = isOi3 ? { trx: app.activeTrx, text } : { type: 'sendCw', text };
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .catch(() => {});
}


// ── Enter key workflow ────────────────────────────────────────────────────────

inpCall.addEventListener('keydown', handleCallEnter);
inpExch.addEventListener('keydown', handleExchEnter);
inpRst.addEventListener('keydown',     handleRstEnter);
inpRstRcvd.addEventListener('keydown', handleRstEnter);

// Enter in a report field used to be a dead key — no handler, and no <form> to
// submit to, so an operator who corrected the report and pressed Enter got
// silence. It is now routed into the ordinary flow: with no call entered yet it
// behaves as it would in Call, otherwise as it would in EXCH, and it transmits
// exactly as it would there. Tab is the way out of these fields that keys
// nothing.
function handleRstEnter(e) {
  if (e.key !== 'Enter' || e.altKey) return;
  if (!inpCall.value.trim()) { handleCallEnter(e); return; }
  const exchEmpty = !inpExch.value.trim();
  handleExchEnter(e);
  // With EXCH still empty its handler only keys and hints, leaving the focus
  // where it was — which would park the cursor in a report field and key the
  // exchange again on every further Enter. Send it where the work continues.
  if (exchEmpty) inpExch.focus();
}

function handleCallEnter(e) {
  if (e.key === ' ') {
    e.preventDefault();
    checkDupe(inpCall.value.trim());
    return;
  }
  if (e.key !== 'Enter' || e.altKey) return;
  e.preventDefault();

  const call  = inpCall.value.trim();
  const state = formStateOf();

  if (state === 'IDLE') {
    if (app.runMode === 'RUN') {
      sendMacroText('CQ');
    } else {
      showHint('Enter callsign');
    }
    return;
  }

  if (state === 'CALL_ENTERED') {
    const blockedCountry = blockedCountryForCall(call);
    if (blockedCountry) {
      inpCall.value = '';
      renderDxccStatus(null);
      clearDupePanel();
      showHint('⛔ BLOCKED: ' + blockedCountry, 5000);
      if (app.runMode === 'RUN') sendMacroText('CQ');
      return;
    }
    app.prevCallSent = call;
    checkDupe(call);
    if (app.runMode === 'RUN') {
      sendMacroText('TXEXCH');
    } else {
      sendRawText((LogManager.getActiveLog() || {}).stationCall || '');
    }
    inpExch.focus();
    return;
  }

  inpExch.focus();
}

// ── Dupe check ────────────────────────────────────────────────────────────────

function _bandFromHz(hz) {
  const k = hz / 1000;
  if (k >= 1800  && k < 2000)    return '160m';
  if (k >= 3500  && k < 4000)    return '80m';
  if (k >= 5000  && k < 6000)    return '60m';
  if (k >= 7000  && k < 7300)    return '40m';
  if (k >= 10000 && k < 10200)   return '30m';
  if (k >= 14000 && k < 14400)   return '20m';
  if (k >= 18000 && k < 18200)   return '17m';
  if (k >= 21000 && k < 21500)   return '15m';
  if (k >= 24800 && k < 25000)   return '12m';
  if (k >= 28000 && k < 30000)   return '10m';
  if (k >= 50000 && k < 54000)   return '6m';
  if (k >= 70000 && k < 71000)   return '4m';
  if (k >= 144000 && k < 148000) return '2m';
  if (k >= 430000 && k < 440000) return '70cm';
  if (k >= 1240000)              return 'shf';
  return null;
}

function _parseDisplayFreqHz(display) {
  if (!display) return 0;
  const p = String(display).split('.');
  if (p.length !== 3) return 0;
  return (parseInt(p[0], 10) || 0) * 1_000_000
       + (parseInt(p[1], 10) || 0) * 1_000
       + (parseInt(p[2], 10) || 0) * 10;
}

function checkDupe(call) {
  const log = LogManager.getActiveLog();
  if (!log || !call) { clearDupePanel(); return; }
  const normCall = call.toUpperCase();
  const chkGlobal = document.getElementById('chkGlobalSearch');
  const isGlobal  = !!(chkGlobal && chkGlobal.checked);

  const dupeProm    = isGlobal ? LogDB.findDupesGlobal(normCall)      : LogDB.findDupes(log.id, normCall);
  const partialProm = call.length >= 2
    ? (isGlobal ? LogDB.findPartialGlobal(normCall) : LogDB.findPartial(log.id, normCall))
    : Promise.resolve([]);
  const logsProm    = isGlobal ? LogDB.getLogs() : Promise.resolve(null);

  Promise.all([dupeProm, partialProm, logsProm]).then(([dupes, partials, allLogs]) => {
    const activeDupes    = dupes.filter(d => !d.deleted);
    const activePartials = partials.filter(d => !d.deleted && d.call.toUpperCase() !== normCall);
    if (!activeDupes.length && !activePartials.length) { clearDupePanel(); return; }

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function hlCall(c, frag) {
      const idx = c.indexOf(frag);
      const dim = s => s ? '<span class="dp-partial-dim">' + esc(s) + '</span>' : '';
      if (idx < 0) return dim(c);
      return dim(c.slice(0, idx))
        + '<span class="dp-partial-hl">' + esc(c.slice(idx, idx + frag.length)) + '</span>'
        + dim(c.slice(idx + frag.length));
    }

    const logMap = Object.fromEntries((allLogs || []).map(l => [l.id, l]));
    const myCall  = log.stationCall || '';
    const hasDupe = activeDupes.some(d => d.logId === log.id);
    let htmlPartial = '';
    let htmlDupe    = '';

    if (activePartials.length) {
      if (!isGlobal) {
        const uniq = [...new Set(activePartials.map(d => d.call))].sort();
        htmlPartial += '<div class="dp-line dp-partial">PARTIAL: '
          + uniq.map(c => hlCall(c, normCall)).join('  ') + '</div>';
      } else {
        const pAct = [], pSame = [], pOther = [];
        activePartials.forEach(d => {
          if (d.logId === log.id) { pAct.push(d); return; }
          const sc = (logMap[d.logId] || {}).stationCall || '';
          (sc === myCall ? pSame : pOther).push(d);
        });
        const uAct   = [...new Set(pAct.map(d => d.call))].sort();
        const uSame  = [...new Set(pSame.map(d => d.call))].sort();
        const uOther = [...new Set(pOther.map(d => d.call))].sort();
        const cells = [];
        if (uOther.length) cells.push(uOther.map(c => esc(c)).join('  '));
        if (uSame.length)  cells.push('<span class="dp-partial-green">' + uSame.map(c => esc(c)).join('  ') + '</span>');
        if (uAct.length)   cells.push(uAct.map(c => hlCall(c, normCall)).join('  '));
        if (cells.length) htmlPartial += '<div class="dp-line dp-partial">PARTIAL: ' + cells.join('  ') + '</div>';
      }
    }

    if (activeDupes.length) {
      const fmtD = d => 'DUPE: #' + String(d.qsoNumber).padStart(3,'0') + ' '
        + esc(d.call) + ' ' + esc(d.timeOnUtc||'') + ' '
        + esc(d.frequencyDisplay||'') + ' ' + esc(d.mode||'');

      const trxBand = _bandFromHz(app.frequency);
      const dupeCls = d => {
        const b = _bandFromHz(_parseDisplayFreqHz(d.frequencyDisplay));
        return (trxBand && b && b === trxBand) ? 'dp-dupe' : 'dp-dupe-other';
      };

      if (!isGlobal) {
        activeDupes.forEach(d => { htmlDupe += '<div class="dp-line ' + dupeCls(d) + '">' + fmtD(d) + '</div>'; });
      } else {
        const logSuffix = d => {
          const l = logMap[d.logId] || {};
          const ts = (l.createdAtUtc || '').slice(0, 10);
          return ' <span class="dp-log-name">| ' + esc((ts ? ts + ' ' : '') + (l.contestName || '')) + '</span>';
        };
        const cat1 = [], cat2 = [], cat3 = [];
        activeDupes.forEach(d => {
          if (d.logId === log.id) { cat3.push(d); return; }
          const sc = (logMap[d.logId] || {}).stationCall || '';
          (sc === myCall ? cat2 : cat1).push(d);
        });
        cat1.forEach(d => { htmlDupe += '<div class="dp-line dp-dupe-other">'   + fmtD(d) + logSuffix(d) + '</div>'; });
        cat2.forEach(d => { htmlDupe += '<div class="dp-line dp-dupe-samecall">' + fmtD(d) + logSuffix(d) + '</div>'; });
        cat3.forEach(d => { htmlDupe += '<div class="dp-line ' + dupeCls(d) + '">' + fmtD(d) + logSuffix(d) + '</div>'; });
      }
    }

    const html = htmlPartial + htmlDupe;
    if (!html) { clearDupePanel(); return; }

    dupePanel.innerHTML = html;
    dupePanel.className = 'dupe-panel' + (hasDupe ? '' : ' dupe-panel-similar');
    dupePanel.classList.remove('dupe-panel-hidden');
    document.querySelectorAll('.qso-row').forEach(row => {
      row.classList.toggle('qso-dupe', row.dataset.call === normCall);
    });
  }).catch(() => {});
}

function handleExchEnter(e) {
  if (e.key !== 'Enter' || e.altKey) return;
  e.preventDefault();

  const call = inpCall.value.trim();
  const exch = inpExch.value.trim();

  if (!call) {
    inpCall.focus();
    return;
  }

  if (!exch) {
    if (app.runMode === 'RUN') {
      app.prevCallSent = call;
      sendMacroText('TXEXCH');
    } else {
      sendRawText((LogManager.getActiveLog() || {}).stationCall || '');
    }
    showHint('Enter exchange');
    return;
  }

  // RUN mode: if call was corrected after TXEXCH was sent, re-announce and suppress regular TU
  if (app.runMode === 'RUN' && app.prevCallSent && call !== app.prevCallSent) {
    app.skipNextTu = true;
    sendMacroText('CALLTU');
  }

  // Both filled → S&P sends exchange memory first, then log QSO
  if (app.runMode !== 'RUN') {
    sendMacroText('TXEXCHSP');
  }
  // Both filled → log QSO
  logQso(call, exch);
}

// ── QSO logging ───────────────────────────────────────────────────────────────

function logCurrentQsoOnly() {
  const call = inpCall.value.trim();
  const exch = inpExch.value.trim();

  if (!call) {
    showHint('Enter callsign');
    inpCall.focus();
    return;
  }

  logQso(call, exch, { sendPostActions: false, hint: 'QSO logged without TX' });
}

function logQso(call, exch, options) {
  const opts = options || {};
  const log = LogManager.getActiveLog();
  if (!log) {
    showHint('No log open — press LOG to create one');
    LogManager.openModal();
    return;
  }

  const now        = new Date();
  const dateUtc    = now.toISOString().slice(0, 10);
  const timeUtc    = String(now.getUTCHours()).padStart(2,'0') + ':' +
                     String(now.getUTCMinutes()).padStart(2,'0');
  // Sent: what actually went on the air wins over the field, so a later edit
  // cannot rewrite history. Falls back to the field as it stands when nothing was
  // keyed at all (phone, a mode with no keying path, "log without TX").
  const rstSent    = app.rstSentTx || rstForLog(inpRst.value, app.mode);
  // Received: nothing was ever transmitted for it, so the field is the only
  // source there is — taken as it stands, not second-guessed.
  const rstRcvd    = rstForLog(inpRstRcvd.value, app.mode);

  // DXCC lookup
  const dxcc = window.DXCC ? DXCC.lookupDxcc(call) : null;
  if (dxcc) {
    const myLoc = log.myLocator || '';
    if (myLoc && window.DXCC) {
      const myPos = DXCC.locatorToLatLon(myLoc);
      if (myPos) {
        const { qrbKm, azimuthDeg } = DXCC.calculateQrbAzimuth(
          myPos.lat, myPos.lon, dxcc.latitude, dxcc.longitude
        );
        dxcc.qrbKm      = qrbKm;
        dxcc.azimuthDeg = azimuthDeg;
      }
    }
  }

  // LOC mode: explicit NRLOC exchange type, or auto-triggered on 6m and up
  const locMode = (log.defaultExchange === 'NRLOC') || (app.frequency > 49_000_000);

  // Extract Maidenhead locator from received exchange in LOC mode
  let locatorReceived = '';
  if (locMode) {
    const m = exch.match(/\b([A-R]{2}\d{2}[A-X]{2})\b/i);
    if (m) locatorReceived = m[1].toUpperCase();
    // Recalculate QRB/azimuth from received locator when available
    if (locatorReceived && dxcc && window.DXCC) {
      const myLoc = log.myLocator || '';
      const dxPos = DXCC.locatorToLatLon(locatorReceived);
      const myPos = myLoc ? DXCC.locatorToLatLon(myLoc) : null;
      if (dxPos && myPos) {
        const { qrbKm, azimuthDeg } = DXCC.calculateQrbAzimuth(
          myPos.lat, myPos.lon, dxPos.lat, dxPos.lon
        );
        dxcc.qrbKm      = qrbKm;
        dxcc.azimuthDeg = azimuthDeg;
      }
    }
  }

  const qso = {
    logId:            log.id,
    qsoNumber:        log.nextQsoNumber,
    qsoDateUtc:       dateUtc,
    timeOnUtc:        timeUtc,
    timestampUtc:     now.toISOString(),
    call:             call,
    rstSent:          rstSent,
    rstReceived:      rstRcvd,
    exchangeReceived: exch,
    frequencyHz:      app.frequency,
    frequencyDisplay: formatFreq(app.frequency),
    mode:             app.mode,
    trx:              app.trxLabels[app.activeTrx - 1],
    dxcc:             dxcc || null,
    locatorReceived:  locatorReceived,
    bandClass:        locMode ? 'VHF_PLUS' : 'HF',
    note:             '',
  };

  LogDB.addQso(qso)
    .then(saved => {
      LogManager.bumpQsoNumber();
      appendJournalRow(saved);
      _onQsoBackupHook();
      // Phase 5: send TU macro + reset RIT
      if (opts.sendPostActions !== false) sendTuAndResetRit();
      clearForm();
      if (opts.hint) showHint(opts.hint);
      // Show "prev exch" button in S&P mode after logging
      if (app.runMode === 'SP') setPrevExchVisible(true);
      inpCall.focus();
    })
    .catch(err => {
      // Do NOT clear form or advance QSO number on error
      showHint('DB error: ' + (err.message || err));
    });
}

function sendTuAndResetRit() {
  if (app.runMode === 'RUN') {
    if (app.skipNextTu) {
      app.skipNextTu = false;
    } else {
      sendMacroText('TU');
    }
  }
  // Reset RIT via HTTP POST /cmd
  if (app.connected) {
    fetch('/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'setRitClear' }),
    }).catch(() => {});
  }
}

// ── Journal: append a QSO row (Phase 4 will call this) ───────────────────────

function appendJournalRow(qso, displayNr) {
  const hint = document.getElementById('logEmptyHint');
  if (hint) hint.remove();

  const body = document.getElementById('logJournalBody');
  const row  = document.createElement('div');
  row.className = qso.deleted ? 'qso-row qso-deleted' : 'qso-row';
  row.dataset.logId = qso.logId || '';
  row.dataset.call  = qso.call  || '';
  row.dataset.qsoId = qso.id    != null ? String(qso.id) : '';

  const dxccText = (() => {
    if (qso.deleted) return '';
    const d = qso.dxcc;
    if (!d) return '';
    const parts = [];
    if (d.country) parts.push(d.country);
    if (d.qrbKm != null) parts.push(d.qrbKm + ' km');
    if (d.azimuthDeg != null && qso.bandClass === 'VHF_PLUS') parts.push(d.azimuthDeg + '°');
    return parts.join(' | ');
  })();

  const cols = [
    { cls: 'jcol-nr',   text: String(displayNr != null ? displayNr : qso.qsoNumber).padStart(3, '0') },
    { cls: 'jcol-date', text: qso.deleted ? '' : (qso.qsoDateUtc  || '') },
    { cls: 'jcol-time', text: qso.deleted ? '' : (qso.timeOnUtc   || '--:--') },
    { cls: 'jcol-call', text: qso.deleted ? '' : (qso.call        || '') },
    { cls: 'jcol-freq', text: qso.deleted ? '' : (qso.frequencyDisplay || '') },
    { cls: 'jcol-mode', text: qso.deleted ? '' : (qso.mode        || '') },
    { cls: 'jcol-snt',  text: qso.deleted ? '' : (qso.rstSent     || '') },
    { cls: 'jcol-rcv',  text: qso.deleted ? '' : (qso.rstReceived || '') },
    { cls: 'jcol-exch', text: qso.deleted ? '' : (qso.exchangeReceived || '') },
    { cls: 'jcol-trx',  text: qso.deleted ? '' : (qso.trx         || '') },
    { cls: 'jcol-dxcc', text: dxccText },
  ];

  cols.forEach(({ cls, text }) => {
    const span = document.createElement('span');
    span.className = 'jcol ' + cls;
    span.textContent = text;
    row.appendChild(span);
  });

  if (!qso.deleted) row.title = 'Click to edit';

  body.appendChild(row);
  row.scrollIntoView({ block: 'end' });
}

// ── QSO row click → edit dialog ───────────────────────────────────────────────

document.getElementById('logJournalBody').addEventListener('click', e => {
  const row = e.target.closest('.qso-row[data-qso-id]');
  if (!row || !row.dataset.qsoId) return;
  openQsoEdit(Number(row.dataset.qsoId));
});

document.getElementById('logJournalBody').addEventListener('contextmenu', e => {
  const callSpan = e.target.closest('.jcol-call');
  if (!callSpan) return;
  const row = callSpan.closest('.qso-row');
  if (!row || !row.dataset.call) return;
  e.preventDefault();
  window.open('https://www.google.com/search?q=' + encodeURIComponent(row.dataset.call), '_blank');
});

// ── Call search ───────────────────────────────────────────────────────────────

document.getElementById('jhdrCall').addEventListener('click', () => {
  const row = document.getElementById('logCallSearchRow');
  const inp = document.getElementById('logCallSearchInp');
  row.classList.remove('ds-hidden');
  inp.value = '';
  inp.focus();
  applyCallSearch('');
});

document.getElementById('logCallSearchClose').addEventListener('click', closeCallSearch);

document.getElementById('logCallSearchInp').addEventListener('input', e => {
  applyCallSearch(e.target.value.trim());
});

document.getElementById('logCallSearchInp').addEventListener('keydown', e => {
  if (e.key === 'Escape') closeCallSearch();
});

function closeCallSearch() {
  document.getElementById('logCallSearchRow').classList.add('ds-hidden');
  applyCallSearch('');
}

function applyCallSearch(query) {
  const q = query.toUpperCase();
  const rows = document.querySelectorAll('#logJournalBody .qso-row');
  let first = null;
  rows.forEach(row => {
    const callSpan = row.querySelector('.jcol-call');
    const rawCall  = row.dataset.call || '';
    if (!q) {
      row.classList.remove('qso-search-dim', 'qso-search-hl');
      if (callSpan) callSpan.textContent = rawCall;
    } else {
      const idx = rawCall.toUpperCase().indexOf(q);
      const match = idx !== -1;
      row.classList.toggle('qso-search-dim', !match);
      row.classList.toggle('qso-search-hl',   match);
      if (callSpan) {
        if (match) {
          const pre  = rawCall.slice(0, idx);
          const mid  = rawCall.slice(idx, idx + q.length);
          const post = rawCall.slice(idx + q.length);
          callSpan.innerHTML = esc(pre) + '<mark class="call-search-mark">' + esc(mid) + '</mark>' + esc(post);
        } else {
          callSpan.textContent = rawCall;
        }
      }
      if (match && !first) first = row;
    }
  });
  if (first) first.scrollIntoView({ block: 'center' });
}

let _qsoEditQso = null;

function openQsoEdit(qsoId) {
  LogDB.getQso(qsoId).then(qso => {
    if (!qso) { console.warn('openQsoEdit: QSO not found, id=', qsoId); return; }
    _qsoEditQso = qso;
    let modal = document.getElementById('qsoEditModal');
    if (!modal) modal = buildQsoEditModal();
    fillQsoEditForm(qso);
    modal.classList.remove('lm-hidden');
    document.getElementById('qeCall').focus();
  }).catch(err => { console.error('openQsoEdit error:', err); });
}

function buildQsoEditModal() {
  const el = document.createElement('div');
  el.id = 'qsoEditModal';
  el.className = 'lm-modal lm-hidden';
  el.innerHTML = `
    <div class="lm-box" style="width:min(440px,calc(100vw - 24px))">
      <div class="lm-header">
        <span class="lm-title" id="qeTitle">Edit QSO</span>
        <button class="lm-close" id="qeClose">×</button>
      </div>
      <div class="lm-section">
        <div class="lm-form">
          <label class="lm-row"><span>Call</span><input id="qeCall" maxlength="16" autocapitalize="characters" spellcheck="false" autocomplete="off"></label>
          <label class="lm-row"><span>Date UTC</span><input id="qeDate" type="date"></label>
          <label class="lm-row"><span>Time UTC</span><input id="qeTime" type="time"></label>
          <label class="lm-row"><span>Freq (kHz)</span><input id="qeFreq" inputmode="decimal" spellcheck="false" autocomplete="off"></label>
          <label class="lm-row"><span>Mode</span>
            <select id="qeMode" class="lm-row-select">
              <option value="USB">USB</option>
              <option value="LSB">LSB</option>
              <option value="CW">CW</option>
              <option value="CW-R">CW-R</option>
              <option value="RTTY">RTTY</option>
              <option value="FM">FM</option>
              <option value="AM">AM</option>
            </select>
          </label>
          <label class="lm-row"><span>RST Sent</span><input id="qeSnt" maxlength="3" autocomplete="off"></label>
          <label class="lm-row"><span>RST Rcvd</span><input id="qeRcv" maxlength="3" autocomplete="off"></label>
          <label class="lm-row"><span>Exchange</span><input id="qeExch" maxlength="20" autocomplete="off"></label>
        </div>
      </div>
      <div class="lm-section qe-actions">
        <button id="qeDelete" class="lm-btn lm-btn-del">Delete</button>
        <div class="qe-actions-right">
          <button id="qeCancel" class="lm-btn">Cancel</button>
          <button id="qeSave" class="lm-btn lm-btn-primary">Save</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  document.getElementById('qeClose').addEventListener('click', closeQsoEdit);
  document.getElementById('qeCancel').addEventListener('click', closeQsoEdit);
  el.addEventListener('click', e => { if (e.target === el) closeQsoEdit(); });
  // Enter in any text field saves (not in <select>, where Enter picks an option)
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); saveQsoEdit(); }
  });
  document.getElementById('qeSave').addEventListener('click', saveQsoEdit);
  document.getElementById('qeDelete').addEventListener('click', deleteQsoEdit);

  const callInp = document.getElementById('qeCall');
  callInp.addEventListener('input', () => {
    const p = callInp.selectionStart;
    callInp.value = callInp.value.toUpperCase();
    callInp.setSelectionRange(p, p);
  });

  return el;
}

function fillQsoEditForm(qso) {
  document.getElementById('qeTitle').textContent = 'Edit QSO #' + String(qso.qsoNumber).padStart(3, '0');
  document.getElementById('qeCall').value  = qso.call          || '';
  document.getElementById('qeDate').value  = qso.qsoDateUtc    || '';
  document.getElementById('qeTime').value  = qso.timeOnUtc     || '';
  document.getElementById('qeFreq').value  = qso.frequencyHz   ? (qso.frequencyHz / 1000).toString() : '';
  const modeEl = document.getElementById('qeMode');
  modeEl.value = Array.from(modeEl.options).find(o => o.value === qso.mode) ? qso.mode : 'USB';
  document.getElementById('qeSnt').value   = qso.rstSent          || '';
  document.getElementById('qeRcv').value   = qso.rstReceived      || '';
  document.getElementById('qeExch').value  = qso.exchangeReceived || '';
}

function closeQsoEdit() {
  const modal = document.getElementById('qsoEditModal');
  if (modal) modal.classList.add('lm-hidden');
  _qsoEditQso = null;
}

function abortTransmission() {
  const trxIdx = app.activeTrx - 1;
  const isOi3  = app.trxOi3[trxIdx] && trxIdx > 0;
  if (isOi3) {
    fetch('/oi3/abort-cw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trx: app.activeTrx }),
    }).catch(() => {});
  } else {
    fetch('/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'abortCw' }),
    }).catch(() => {});
  }
}

function saveQsoEdit() {
  if (!_qsoEditQso) return;
  const call = document.getElementById('qeCall').value.trim().toUpperCase();
  if (!call) return;
  const hz = Math.round(parseFloat(document.getElementById('qeFreq').value.replace(',', '.')) * 1000) || _qsoEditQso.frequencyHz || 0;

  _qsoEditQso.call             = call;
  _qsoEditQso.qsoDateUtc       = document.getElementById('qeDate').value;
  _qsoEditQso.timeOnUtc        = document.getElementById('qeTime').value;
  _qsoEditQso.frequencyHz      = hz;
  _qsoEditQso.frequencyDisplay = formatFreq(hz);
  _qsoEditQso.mode             = document.getElementById('qeMode').value;
  _qsoEditQso.rstSent          = document.getElementById('qeSnt').value.trim();
  _qsoEditQso.rstReceived      = document.getElementById('qeRcv').value.trim();
  _qsoEditQso.exchangeReceived = document.getElementById('qeExch').value.trim();
  _qsoEditQso.deleted          = false;

  LogDB.updateQso(_qsoEditQso).then(() => {
    updateJournalRow(_qsoEditQso);
    closeQsoEdit();
  });
}

function deleteQsoEdit() {
  if (!_qsoEditQso) return;
  _qsoEditQso.deleted = true;
  LogDB.updateQso(_qsoEditQso).then(() => {
    updateJournalRow(_qsoEditQso);
    closeQsoEdit();
  });
}

function updateJournalRow(qso) {
  const row = document.querySelector('.qso-row[data-qso-id="' + qso.id + '"]');
  if (!row) return;
  if (qso.deleted) {
    row.className = 'qso-row qso-deleted';
    Array.from(row.children).forEach(span => {
      if (!span.classList.contains('jcol-nr')) span.textContent = '';
    });
  } else {
    row.className = 'qso-row';
    const dxccText = (() => {
      const d = qso.dxcc;
      if (!d) return '';
      const parts = [];
      if (d.country) parts.push(d.country);
      if (d.qrbKm != null) parts.push(d.qrbKm + 'km');
      return parts.join(' | ');
    })();
    const vals = [
      String(qso.qsoNumber).padStart(3, '0'),
      qso.qsoDateUtc || '',
      qso.timeOnUtc  || '--:--',
      qso.call       || '',
      qso.frequencyDisplay || '',
      qso.mode       || '',
      qso.rstSent    || '',
      qso.rstReceived || '',
      qso.exchangeReceived || '',
      qso.trx        || '',
      dxccText,
    ];
    Array.from(row.children).forEach((span, i) => { span.textContent = vals[i] || ''; });
  }
}

// ── Action buttons (*?, nr?, prev exch, check) ────────────────────────────────

const btnCallQ  = document.getElementById('btnCallQ');
const btnNrQ    = document.getElementById('btnNrQ');
const btnPrevEx = document.getElementById('btnPrevEx');
const btnCheck  = document.getElementById('btnCheck');

btnCallQ.addEventListener('click', () => {
  sendRawText((inpCall.value.trim() || '') + '?');
  inpCall.focus();
});

btnNrQ.addEventListener('click', () => {
  sendRawText('nr?');
  inpExch.focus();
});

btnPrevEx.addEventListener('click', () => {
  if (window.LogMacros) {
    LogMacros.sendMacro('TXEXCHSP2', macroCtx());
  }
  inpCall.focus();
});

btnCheck.addEventListener('click', () => {
  checkDupe(inpCall.value.trim());
  inpCall.focus();
});

function setPrevExchVisible(visible) {
  btnPrevEx.classList.toggle('btn-action-hidden', !visible);
}

// ── Active log display ────────────────────────────────────────────────────────

const btnOpenLog = document.getElementById('btnOpenLog');
btnOpenLog.addEventListener('click', () => LogManager.openModal());

function onActiveLogChanged(log) {
  if (!log) {
    btnOpenLog.textContent = 'LOG';
    btnOpenLog.classList.remove('btn-trx-active');
    return;
  }
  btnOpenLog.textContent = 'LOG: ' + (log.contestName || '—');
  btnOpenLog.classList.add('btn-trx-active');
  // reload journal rows for the active log
  loadJournalFromDb(log.id);
}

LogManager.onLogChanged(onActiveLogChanged);

// ── Load journal from IndexedDB ───────────────────────────────────────────────

function loadJournalFromDb(logId) {
  const body = document.getElementById('logJournalBody');
  body.innerHTML = '';
  const spacer = document.createElement('div');
  spacer.className = 'log-journal-spacer';
  body.appendChild(spacer);

  LogDB.getQsosForLog(logId).then(qsos => {
    qsos.sort((a, b) => {
      const ta = (a.timestampUtc || a.qsoDateUtc + 'T' + (a.timeOnUtc||'') + 'Z') || '';
      const tb = (b.timestampUtc || b.qsoDateUtc + 'T' + (b.timeOnUtc||'') + 'Z') || '';
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    if (!qsos.length) {
      body.innerHTML = '<div class="log-empty" id="logEmptyHint">No QSO logged yet.</div>';
      return;
    }
    qsos.forEach((q, i) => appendJournalRow(q, i + 1));
  }).catch(() => {});
}

// ── Storage persistence warning ───────────────────────────────────────────────

async function checkStoragePersistence() {
  if (!navigator.storage || !navigator.storage.persisted) return;
  let persisted = await navigator.storage.persisted().catch(() => false);
  if (!persisted && navigator.storage.persist) {
    persisted = await navigator.storage.persist().catch(() => false);
  }
  if (persisted) return;

  const warn = document.getElementById('storageWarn');
  if (!warn) return;
  warn.classList.remove('ds-hidden');

  document.getElementById('storageWarnClose').addEventListener('click',
    () => warn.classList.add('ds-hidden'), { once: true });

  const popup    = document.getElementById('storageFixPopup');
  const originEl = document.getElementById('fixPopupOrigin');
  if (originEl) originEl.textContent = window.location.origin;

  function openFixPopup()  { popup.classList.remove('ds-hidden'); }
  function closeFixPopup() { popup.classList.add('ds-hidden'); }

  document.getElementById('storageWarnFix').addEventListener('click', openFixPopup);
  document.getElementById('storageFixClose').addEventListener('click', closeFixPopup);
  document.getElementById('storageFixOk').addEventListener('click', closeFixPopup);
  popup.addEventListener('click', e => { if (e.target === popup) closeFixPopup(); });
}

// ── Initialisation ────────────────────────────────────────────────────────────

function init() {
  setRunMode('RUN');
  resetRstFields();
  startClock();
  pollState();
  checkStoragePersistence();

  // Device locator fallback for azimuth display (when log has no myLocator set)
  fetch('/dxcinfo').then(r => r.json()).then(d => {
    if (d.locator) window._deviceLocator = d.locator;
  }).catch(() => {});

  // Load global LOG settings from ESP32 /log-config (shared across browsers)
  fetch('/log-config').then(r => r.json()).then(cfg => {
    if (cfg.trx1Label) app.trxLabels[0] = cfg.trx1Label;
    if (cfg.trx2Label) app.trxLabels[1] = cfg.trx2Label;
    if (cfg.trx3Label) app.trxLabels[2] = cfg.trx3Label;
    // A TRX is "remote" (controlled via the ESP, not the local CAT link) when it has
    // Unified radio config explicitly carries active state. Fall back to the
    // legacy peer/address inference for backups from older firmware.
    app.trxOi3[1] = typeof cfg.trx2enabled === "boolean"
      ? cfg.trx2enabled
      : (cfg.trx2netid || 0) !== 0 || (cfg.trx2conntype || 0) === 1;
    app.trxOi3[2] = typeof cfg.trx3enabled === "boolean"
      ? cfg.trx3enabled
      : (cfg.trx3netid || 0) !== 0 || (cfg.trx3conntype || 0) === 1;
    app.blockedDxccList = (cfg.blockedDxcc || '').split('\n')
      .map(s => s.trim().toLowerCase()).filter(Boolean);
    trxButtons.forEach((b, i) => { b.textContent = app.trxLabels[i]; });
    // Hide TRX2/TRX3 buttons when OI3 not configured
    trxButtons[1].style.display = app.trxOi3[1] ? '' : 'none';
    trxButtons[2].style.display = app.trxOi3[2] ? '' : 'none';
    // If active TRX is now hidden, fall back to TRX1
    if ((app.activeTrx === 2 && !app.trxOi3[1]) || (app.activeTrx === 3 && !app.trxOi3[2])) {
      app.activeTrx = 1;
      trxButtons.forEach((b, i) => b.classList.toggle('btn-trx-active', i === 0));
    }
    updateTrxHeader();
    renderConnStatus();
  }).catch(() => {});

  // Manual freq/mode inputs (active when TRX disconnected)
  sbManualFreq.addEventListener('input', () => {
    const hz = Math.round(parseFloat(sbManualFreq.value.replace(',', '.')) * 1000);
    if (hz > 0) {
      app.frequency = hz;
      if (inpCall.value.trim()) updateDxccFromCall();
    }
  });
  sbManualFreq.addEventListener('blur', () => {
    const hz = Math.round(parseFloat(sbManualFreq.value.replace(',', '.')) * 1000);
    if (hz > 0) sbManualFreq.value = (hz / 1000).toString();
    else sbManualFreq.value = '';
  });
  sbManualMode.addEventListener('change', () => {
    app.mode = sbManualMode.value;
    const d = rstDefault(app.mode);
    if (d && !app.rstSentDirty) inpRst.value     = d;
    if (d && !app.rstRcvdDirty) inpRstRcvd.value = d;
  });

  // Start WebSocket for macros
  if (window.LogMacros) LogMacros.init();

  _initBackup();

  _alignMacroPreview();

  // Restore last active log, then focus Call
  LogManager.restoreActiveLog().then(() => {
    inpCall.focus();
    updateMacroPreview();
  }).catch(() => {
    inpCall.focus();
  });
}

init();

// ── DXC tune broadcast ────────────────────────────────────────────────────────
try {
  const dxcActionCh = new BroadcastChannel('wifilt-dxc-action');
  dxcActionCh.addEventListener('message', e => {
    const msg = e.data;
    if (!msg || msg.type !== 'dxc-tune') return;
    selectTrx(msg.trx);
    setRunMode('SP');
    if (msg.callsign) {
      inpCall.value = msg.callsign;
      inpCall.dispatchEvent(new Event('input'));
    }
    checkDupe(inpCall.value.trim());
    inpCall.focus();
  });
} catch (_) {}

// ── Macro preview ────────────────────────────────────────────────────────────

function updateMacroPreview() {
  if (!macroPreview || !window.LogMacros) return;
  const focused  = document.activeElement;
  const state    = formStateOf();
  const isRun    = app.runMode === 'RUN';
  const myCall   = (LogManager.getActiveLog() || {}).stationCall || '';
  let text = '';

  if (focused === inpCall) {
    if (state === 'IDLE' && isRun) {
      text = LogMacros.buildMacro('CQ', macroCtx()) || '';
    } else if (state === 'CALL_ENTERED') {
      text = isRun ? (LogMacros.buildMacro('TXEXCH', macroCtx()) || '') : myCall;
    }
  } else if (focused === inpExch) {
    const call = inpCall.value.trim();
    const exch = inpExch.value.trim();
    if (call && !exch) {
      text = isRun ? (LogMacros.buildMacro('TXEXCH', macroCtx()) || '') : myCall;
    } else if (call && exch && !isRun) {
      text = LogMacros.buildMacro('TXEXCHSP', macroCtx()) || '';
    }
  }

  macroPreview.textContent = text;
}

function _alignMacroPreview() {
  if (!macroPreview) return;
  requestAnimationFrame(() => {
    const cl = inpCall.getBoundingClientRect().left;
    const pl = macroPreview.getBoundingClientRect().left;
    if (cl > pl) macroPreview.style.paddingLeft = (cl - pl) + 'px';
  });
}

[inpCall, inpExch].forEach(inp => {
  inp.addEventListener('focus', updateMacroPreview);
  inp.addEventListener('input', updateMacroPreview);
  inp.addEventListener('blur',  updateMacroPreview);
});

// ── DXC Band Display ──────────────────────────────────────────────────────────

const dxcBandBox = document.getElementById('dxcBandBox');
const dxcBandSvg = document.getElementById('dxcBandSvg');

const _DXC_NS       = 'http://www.w3.org/2000/svg';
const _DXC_SCALE_Y  = 68;
const _DXC_LABEL_Y  = 79;
const _DXC_CALL_Y   = 56;
const _DXC_FS       = 11;
const _DXC_CHAR_W   = 6.5;
const _DXC_BG       = '#2d2d2d';
const _DXC_FG       = '#cccccc';
const _DXC_TICK_COL = '#666666';
const _DXC_LINE_COL = '#ff4444';

let _dxcSpots     = [];
let _dxcBandStart = -1;
let _dxcBandWidth = 100;
let _dxcActive    = false;
let _svgScale     = null;
let _svgSpots     = null;
let _svgLine      = null;

function _dxcW() {
  return dxcBandSvg.clientWidth || 800;
}

function _dxcX(freqKhz) {
  return ((freqKhz - _dxcBandStart) / _dxcBandWidth) * _dxcW();
}

function _dxcScaleLabel(khz) {
  const s = String(khz);
  return s.length > 3 ? s.slice(0, -3) + ' ' + s.slice(-3) : s;
}

function _dxcEl(tag, attrs) {
  const el = document.createElementNS(_DXC_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function _dxcClear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function _initDxcSvg() {
  _dxcClear(dxcBandSvg);
  _svgScale = _dxcEl('g', {});
  _svgSpots = _dxcEl('g', {});
  _svgLine  = _dxcEl('line', {
    y1: '0', y2: String(_DXC_SCALE_Y),
    stroke: _DXC_LINE_COL, 'stroke-width': '1.5'
  });
  dxcBandSvg.appendChild(_svgScale);
  dxcBandSvg.appendChild(_svgSpots);
  dxcBandSvg.appendChild(_svgLine);
  _renderDxcScale();
}

function _renderDxcScale() {
  if (!_svgScale) return;
  _dxcClear(_svgScale);
  const W = _dxcW();

  _svgScale.appendChild(_dxcEl('line', {
    x1: '0', x2: String(W),
    y1: String(_DXC_SCALE_Y), y2: String(_DXC_SCALE_Y),
    stroke: _DXC_TICK_COL, 'stroke-width': '1'
  }));

  const labelStep = _dxcBandWidth === 50 ? 10 : _dxcBandWidth === 200 ? 50 : 25;

  for (let i = 0; i <= _dxcBandWidth; i++) {
    const x  = (i / _dxcBandWidth) * W;
    const y1 = i % 10 === 0 ? _DXC_SCALE_Y - 10
             : i % 5  === 0 ? _DXC_SCALE_Y - 7
             :                 _DXC_SCALE_Y - 4;
    _svgScale.appendChild(_dxcEl('line', {
      x1: String(x), x2: String(x),
      y1: String(y1), y2: String(_DXC_SCALE_Y),
      stroke: _DXC_TICK_COL, 'stroke-width': '1'
    }));

    if (i % labelStep === 0) {
      const lbl = _dxcEl('text', {
        x: String(x), y: String(_DXC_LABEL_Y),
        'text-anchor': 'middle',
        fill: _DXC_FG,
        'font-size': '9',
        'font-family': 'monospace'
      });
      lbl.textContent = _dxcScaleLabel(_dxcBandStart + i);
      _svgScale.appendChild(lbl);
    }
  }
}

function _renderDxcLine(freqHz) {
  if (!_svgLine || _dxcBandStart < 0) return;
  const x = _dxcX(freqHz / 1000);
  _svgLine.setAttribute('x1', String(x));
  _svgLine.setAttribute('x2', String(x));
}

function _renderDxcSpots() {
  if (!_svgSpots || _dxcBandStart < 0) return;
  _dxcClear(_svgSpots);

  const visible = _dxcSpots.filter(s => {
    const f = parseFloat(s.freq);
    return f >= _dxcBandStart && f < _dxcBandStart + _dxcBandWidth;
  });
  visible.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  const PAD = 2;
  for (const spot of visible) {
    const f    = parseFloat(spot.freq);
    const x    = _dxcX(f);
    const call = String(spot.dx || '');
    const tw   = call.length * _DXC_CHAR_W;

    const outer = _dxcEl('g', { 'data-freq': String(f), 'data-call': call });
    outer.style.cursor = 'pointer';

    const grp = _dxcEl('g', { transform: `rotate(-90,${x},${_DXC_CALL_Y})` });

    grp.appendChild(_dxcEl('rect', {
      x:      String(x - PAD),
      y:      String(_DXC_CALL_Y - _DXC_FS - PAD),
      width:  String(tw + PAD * 2),
      height: String(_DXC_FS + PAD * 2),
      fill:   _DXC_BG
    }));

    const txt = _dxcEl('text', {
      x:             String(x),
      y:             String(_DXC_CALL_Y),
      'text-anchor': 'start',
      fill:          _DXC_FG,
      'font-size':   String(_DXC_FS),
      'font-family': 'monospace'
    });
    txt.textContent = call;
    grp.appendChild(txt);
    outer.appendChild(grp);

    outer.addEventListener('click', () => {
      // Send frequency to the currently selected TRX
      const trxNum = app.activeTrx;
      const freqHz = Math.round(f * 1000);

      // Check if the selected TRX is configured
      if (trxNum === 2 && !app.trxOi3[1]) return;  // TRX2 not configured
      if (trxNum === 3 && !app.trxOi3[2]) return;  // TRX3 not configured

      if (trxNum === 1) {
        // TRX1: send via /cmd
        fetch('/cmd', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ type: 'setFrequency', reqId: 'dxc-band', frequency: freqHz })
        }).catch(() => {});
      } else {
        // TRX2/3: send via /oi3/set-hz
        fetch('/oi3/set-hz', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ trx: trxNum, hz: freqHz })
        }).catch(() => {});
      }

      setRunMode('SP');
      if (call) {
        inpCall.value = call;
        inpCall.dispatchEvent(new Event('input'));
      }
      inpCall.focus();
    });
    _svgSpots.appendChild(outer);
  }
}

function _updateDxcBand(freqHz, dxcConnected) {
  if (!dxcConnected || !freqHz) {
    if (_dxcActive) {
      dxcBandBox.classList.remove('dxc-active');
      _dxcActive = false;
    }
    return;
  }

  const bandStart = Math.floor(freqHz / (_dxcBandWidth * 1000)) * _dxcBandWidth;

  if (!_dxcActive) {
    _dxcActive    = true;
    _dxcBandStart = bandStart;
    dxcBandBox.classList.add('dxc-active');
    _initDxcSvg();
    _renderDxcSpots();
  } else if (bandStart !== _dxcBandStart) {
    _dxcBandStart = bandStart;
    _renderDxcScale();
    _renderDxcSpots();
  }
  _renderDxcLine(freqHz);
}

try {
  // Initial load from localStorage — covers the case where dxc.html has spots
  // cached but hasn't broadcast yet (no new spots since log.js opened).
  const cached = localStorage.getItem('wifilt-dxc-spots');
  if (cached) {
    const msg = JSON.parse(cached);
    if (msg && Array.isArray(msg.spots)) _dxcSpots = msg.spots;
  }
} catch (_) {}

try {
  const dxcSpotsChannel = new BroadcastChannel('wifilt-dxc-spots');
  dxcSpotsChannel.addEventListener('message', e => {
    const msg = e.data;
    if (!msg || !Array.isArray(msg.spots)) return;
    _dxcSpots = msg.spots;
    if (_dxcActive) _renderDxcSpots();
  });
} catch (_) {}

window.addEventListener('resize', () => {
  if (_dxcActive) _renderDxcScale();
  _alignMacroPreview();
});

const dxcBandToggle  = document.getElementById('dxcBandToggle');
const dxcBwBtn       = document.getElementById('dxcBwBtn');
const dxcBwPalette   = document.getElementById('dxcBwPalette');

dxcBandToggle.addEventListener('click', () => {
  const collapsed = dxcBandBox.classList.toggle('dxc-collapsed');
  dxcBandToggle.textContent = collapsed ? '▲' : '▼';
});

dxcBwBtn.addEventListener('click', e => {
  e.stopPropagation();
  dxcBwPalette.classList.toggle('dxc-bw-open');
});

dxcBwPalette.addEventListener('click', e => {
  const btn = e.target.closest('.dxc-bw-opt');
  if (!btn) return;
  const bw = parseInt(btn.dataset.bw, 10);
  if (!bw || bw === _dxcBandWidth) { dxcBwPalette.classList.remove('dxc-bw-open'); return; }

  _dxcBandWidth = bw;
  dxcBwPalette.querySelectorAll('.dxc-bw-opt').forEach(b => {
    b.classList.toggle('dxc-bw-active', parseInt(b.dataset.bw, 10) === bw);
  });
  dxcBwPalette.classList.remove('dxc-bw-open');

  if (_dxcActive && app.frequency) {
    _dxcBandStart = Math.floor(app.frequency / (_dxcBandWidth * 1000)) * _dxcBandWidth;
    _renderDxcScale();
    _renderDxcSpots();
    _renderDxcLine(app.frequency);
  }
});

document.addEventListener('click', () => dxcBwPalette.classList.remove('dxc-bw-open'));

/* ════════════════════════════════════════════════════════════════════════
   Touch / on-screen keyboard adaptations
   ════════════════════════════════════════════════════════════════════════ */

/* Bind the app height to the visual viewport so the on-screen keyboard never
   hides the input row, and flag a compact layout while the keyboard is up.
   No UA sniffing — purely capability/viewport driven. */
(function setupViewportKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;                      // desktop / unsupported → CSS dvh fallback
  const root = document.documentElement;
  const body = document.body;
  const KBD_RATIO = 0.75;               // viewport shrunk past this ⇒ keyboard open

  function apply() {
    // Size the (position:fixed) body to the visible viewport and glue it to
    // the visible area. On iOS Safari, focusing a field pans the layout
    // viewport (offsetTop > 0); following it stops the page jumping to the top.
    root.style.setProperty('--app-h', vv.height + 'px');
    body.style.top  = vv.offsetTop  + 'px';
    body.style.left = vv.offsetLeft + 'px';
    body.classList.toggle('kbd-open', vv.height < window.innerHeight * KBD_RATIO);
  }

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
})();

/* Keep the journal header aligned with rows when scrolled horizontally on
   narrow / touch screens (the body is the horizontal scroller). */
(function syncJournalHScroll() {
  const body = document.getElementById('logJournalBody');
  const header = document.getElementById('logJournalHeader');
  if (!body || !header) return;
  body.addEventListener('scroll', () => {
    header.style.transform = 'translateX(' + (-body.scrollLeft) + 'px)';
  });
})();

/* Enter = confirm in the remaining input fields (manual freq, call search,
   QSO edit modal). Call/Exch keep their own workflow; the LOG create modal
   already submits via its <form>. */

// Manual freq: Enter applies (live input handler already pushed it) + closes keyboard.
sbManualFreq.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); sbManualFreq.blur(); }
});

// Call search: Enter jumps to the first match and dismisses the keyboard.
document.getElementById('logCallSearchInp').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const first = document.querySelector('#logJournalBody .qso-row.qso-search-hl');
  if (first) first.scrollIntoView({ block: 'center' });
  e.target.blur();
});
