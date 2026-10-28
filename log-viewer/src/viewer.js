'use strict';
/**
 * viewer.js — the WIFILT log viewer (GitHub Pages, read-only)
 *
 * Reads the file GIT LOG SYNC keeps in git (QSO-database.json next to this
 * page) and shows every QSO in it. Grilled 2026-10-02; in short:
 *
 *   - one filter under every column, all of them at once (AND). Plain text is
 *     "contains, any case"; "=x" is the whole cell; number columns also take
 *     ">n", "<n" and "a-b";
 *   - the statistics in the header are of the rows the filters leave, and
 *     clicking a number in them sets the filters that select it;
 *   - QSOs imported from old ADIF logs carry no DXCC data; it is looked up here
 *     with the same dxcc.js the interface uses, for display only;
 *   - filters, sorting and "show deleted" live in the address (#...), so a
 *     link opens the same view; which columns are hidden, and how wide they
 *     are, is personal and stays in this browser;
 *   - the ▾ in the Log filter lists the logs it matches, with their QSO counts;
 *   - ADIF/CSV export of the rows shown, through log-export.js -- the very
 *     file the interface exports with, so the two can never disagree;
 *   - a map of the rows shown beside the statistics (viewer-map.js); clicking
 *     a row marks its point and sets the grey line to its time.
 *
 * Only the rows in view are in the DOM: a log of 16 000 QSOs is normal here.
 */
(function () {

  var ROW_H = 26;
  var COLS_KEY = 'wifilt-log-viewer-cols';
  var WIDTHS_KEY = 'wifilt-log-viewer-widths';
  var MIN_W = 36, MAX_W = 800;
  var MODE_FOLD = { 'CW-R': 'CW', 'CWR': 'CW', 'USB': 'SSB', 'LSB': 'SSB', 'RTTY-R': 'RTTY', 'RTTYR': 'RTTY' };
  var BAND_ORDER = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m',
                    '2m', '1.25m', '70cm', '33cm', ''];

  // k: key, t: header, w: width px, num: number column, cls: cell class
  var COLS = [
    { k: 'log',     t: 'Log',     w: 150 },
    { k: 'my',      t: 'My call', w: 88 },
    { k: 'nr',      t: 'Nr',      w: 56,  num: true },
    { k: 'date',    t: 'Date',    w: 96 },
    { k: 'time',    t: 'UTC',     w: 58 },
    { k: 'call',    t: 'Call',    w: 104, cls: 'c-call' },
    { k: 'band',    t: 'Band',    w: 62 },
    { k: 'freq',    t: 'kHz',     w: 92,  num: true },
    { k: 'mode',    t: 'Mode',    w: 70 },
    { k: 'rsts',    t: 'RST S',   w: 62 },
    { k: 'rstr',    t: 'RST R',   w: 62 },
    { k: 'exch',    t: 'Exch',    w: 110 },
    { k: 'loc',     t: 'Locator', w: 82 },
    { k: 'country', t: 'Country', w: 150 },
    { k: 'cont',    t: 'Cont',    w: 56 },
    { k: 'cq',      t: 'CQ',      w: 46,  num: true },
    { k: 'itu',     t: 'ITU',     w: 46,  num: true },
    { k: 'qrb',     t: 'QRB km',  w: 74,  num: true },
    { k: 'az',      t: 'Az°',     w: 52,  num: true },
    { k: 'trx',     t: 'TRX',     w: 56 },
  ];
  var COL = {};
  COLS.forEach(function (c) { COL[c.k] = c; });

  var all = [];          // every row
  var shown = [];        // rows after filters and sort
  var filters = {};      // k -> raw text
  var compiled = {};     // k -> test(row) | null
  var sort = { k: 'when', dir: -1 };
  var showDeleted = false;
  var hidden = loadHidden();
  var widths = loadWidths();     // k -> px, only the columns someone resized
  var logsById = {};
  var fileInfo = null;
  var selected = null;   // the row last clicked, marked in the table and on the map

  var $ = function (id) { return document.getElementById(id); };

  // ── load ────────────────────────────────────────────────────────────────────

  function fileName() {
    var p = new URLSearchParams(location.search).get('file');
    return p && /^[\w./-]+$/.test(p) && p.indexOf('..') < 0 ? p : 'QSO-database.json';
  }

  function load() {
    var name = fileName();
    // Pages serves this file with a cache of its own (about ten minutes); the
    // query at least keeps this browser from adding another one on top.
    fetch('./' + name + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) throw new Error(name + ' is not in this repository yet. Run GIT LOG SYNC on the interface once, then reload (GitHub Pages needs a minute or two to publish it).');
        if (!r.ok) throw new Error('Could not read ' + name + ' (HTTP ' + r.status + ').');
        return r.json();
      })
      .then(function (f) {
        if (!f || !f.stores || !Array.isArray(f.stores.qso)) throw new Error(name + ' is not a WIFILT QSO database.');
        fileInfo = f;
        build(f);
        readHash();
        renderHeader();
        apply();
      })
      .catch(function (e) {
        $('sub').textContent = '';
        showMsg(e.message || String(e));
      });
  }

  function showMsg(t) {
    var m = $('msg');
    m.hidden = !t;
    m.textContent = t || '';
  }

  // ── rows ────────────────────────────────────────────────────────────────────

  var dxccCache = {};
  function lookup(call) {
    if (!(call in dxccCache)) dxccCache[call] = (window.DXCC && call) ? DXCC.lookupDxcc(call) : null;
    return dxccCache[call];
  }

  // The DXCC a QSO lacks, worked out as the interface itself does when a QSO
  // is logged (log-db.js commitQso): the country from the call, the distance
  // from my locator to the station's locator, or to its country's centre.
  function fillDxcc(q, log) {
    if (q.dxcc) return q.dxcc;
    var d = lookup(String(q.call || '').toUpperCase());
    if (!d) return null;
    d = Object.assign({}, d);
    var myPos = log && log.myLocator ? DXCC.locatorToLatLon(log.myLocator) : null;
    var dxPos = (q.locatorReceived && DXCC.locatorToLatLon(q.locatorReceived)) ||
                (d.latitude != null ? { lat: d.latitude, lon: d.longitude } : null);
    if (myPos && dxPos) {
      var qa = DXCC.calculateQrbAzimuth(myPos.lat, myPos.lon, dxPos.lat, dxPos.lon);
      d.qrbKm = qa.qrbKm;
      d.azimuthDeg = qa.azimuthDeg;
    }
    return d;
  }

  function modeKey(m) {
    var u = String(m || '').toUpperCase();
    return MODE_FOLD[u] || u;
  }

  function build(f) {
    logsById = {};
    (f.stores.logs || []).forEach(function (l) { logsById[l.id] = l; });
    ViewerMap.setLogs(logsById);
    all = f.stores.qso.map(function (q) {
      var log = logsById[q.logId] || {};
      var d = fillDxcc(q, log) || {};
      var hz = Number(q.frequencyHz) || 0;
      var r = {
        q: q, d: d, deleted: !!q.deleted,
        logId: q.logId,
        when: String(q.timestampUtc || ((q.qsoDateUtc || '') + 'T' + (q.timeOnUtc || ''))),
        log: log.contestName || q.logId || '',
        my: log.stationCall || '',
        nr: q.qsoNumber != null ? q.qsoNumber : '',
        date: q.qsoDateUtc || '',
        time: q.timeOnUtc || '',
        call: String(q.call || '').toUpperCase(),
        band: LogExport.freqToBand(hz),
        freq: hz ? (hz / 1000).toFixed(1) : '',
        mode: String(q.mode || '').toUpperCase(),
        modeKey: modeKey(q.mode),
        rsts: q.rstSent || '',
        rstr: q.rstReceived || '',
        exch: q.exchangeReceived || '',
        loc: String(q.locatorReceived || '').toUpperCase(),
        country: d.country || '',
        cont: d.continent || '',
        cq: d.cqZone != null ? d.cqZone : '',
        itu: d.ituZone != null ? d.ituZone : '',
        qrb: d.qrbKm != null ? Math.round(d.qrbKm) : '',
        az: d.azimuthDeg != null ? Math.round(d.azimuthDeg) : '',
        trx: q.trx || '',
      };
      r.lc = {};
      COLS.forEach(function (c) { r.lc[c.k] = String(r[c.k]).toLowerCase(); });
      r.lcModeKey = r.modeKey.toLowerCase();
      return r;
    });
    var calls = {};
    (f.stores.logs || []).forEach(function (l) { if (l.stationCall) calls[l.stationCall.toUpperCase()] = true; });
    var names = Object.keys(calls).sort();
    var title = (names.length ? names.join(' · ') + ' — ' : '') + 'QSO log';
    $('title').textContent = title;
    document.title = names.length ? names[0] + ' QSO log' : 'QSO log';
    $('sub').textContent = all.filter(function (r) { return !r.deleted; }).length + ' QSO in ' +
      (f.stores.logs || []).length + ' logs' +
      (f.exported_at ? ' · synced ' + String(f.exported_at).replace('T', ' ').slice(0, 16) + ' UTC' : '');
  }

  // ── filters ─────────────────────────────────────────────────────────────────

  // null = no filter; false = cannot be read (shown red, ignored)
  function compile(c, raw) {
    var s = String(raw || '').trim();
    if (!s) return null;
    var low = s.toLowerCase();
    // The Mode column also answers to the folded mode the statistics count
    // by: =SSB is every USB and LSB QSO, =CW includes CW-R.
    var folded = c.k === 'mode';
    if (low.charAt(0) === '=') {
      var want = low.slice(1).trim();
      return function (r) { return r.lc[c.k] === want || (folded && r.lcModeKey === want); };
    }
    if (c.num) {
      var m = /^(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)$/.exec(s);
      if (m) {
        var v = parseFloat(m[2]), op = m[1];
        return function (r) {
          var x = parseFloat(r[c.k]);
          if (isNaN(x)) return false;
          return op === '<' ? x < v : op === '>' ? x > v : op === '<=' ? x <= v : x >= v;
        };
      }
      m = /^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/.exec(s);
      if (m) {
        var lo = Math.min(parseFloat(m[1]), parseFloat(m[2])), hi = Math.max(parseFloat(m[1]), parseFloat(m[2]));
        return function (r) { var x = parseFloat(r[c.k]); return !isNaN(x) && x >= lo && x <= hi; };
      }
      if (/^[<>]/.test(s)) return false;
    }
    return function (r) { return r.lc[c.k].indexOf(low) >= 0 || (folded && r.lcModeKey.indexOf(low) >= 0); };
  }

  function apply() {
    var tests = COLS.map(function (c) { return compiled[c.k] ? compiled[c.k] : null; })
                    .filter(Boolean);
    shown = all.filter(function (r) {
      if (r.deleted && !showDeleted) return false;
      for (var i = 0; i < tests.length; i++) if (!tests[i](r)) return false;
      return true;
    });
    sortRows();
    writeHash();
    renderStats();
    // The filters, not the sort order: sorting the table must not refit the map.
    ViewerMap.update(shown, JSON.stringify(filters) + (showDeleted ? '+deleted' : ''));
    renderFilterState();
    $('count').textContent = shown.length === all.length ? shown.length + ' rows'
                                                         : shown.length + ' of ' + all.length + ' rows';
    $('gbody').style.height = (shown.length * ROW_H) + 'px';
    renderRows(true);
    if (!$('logPal').hidden) renderLogPal();
    showMsg(all.length && !shown.length ? 'No QSO matches these filters.' : '');
  }

  function sortRows() {
    var k = sort.k, dir = sort.dir, num = COL[k] && COL[k].num;
    shown.sort(function (a, b) {
      var x = a[k], y = b[k], c;
      if (x === '' && y !== '') return 1;
      if (y === '' && x !== '') return -1;
      if (num) c = parseFloat(x) - parseFloat(y);
      else c = x < y ? -1 : x > y ? 1 : 0;
      if (!c && k !== 'when') c = a.when < b.when ? -1 : a.when > b.when ? 1 : 0;
      return c * dir;
    });
  }

  var debounce = null;
  function onFilterInput(e) {
    var k = e.target.getAttribute('data-k');
    filters[k] = e.target.value;
    compiled[k] = compile(COL[k], e.target.value);
    clearTimeout(debounce);
    debounce = setTimeout(apply, 120);
  }

  function setFilter(k, v) {
    filters[k] = v;
    compiled[k] = compile(COL[k], v);
    var inp = document.querySelector('.frow input[data-k="' + k + '"]');
    if (inp) inp.value = v;
  }

  function renderFilterState() {
    document.querySelectorAll('.frow input').forEach(function (inp) {
      var c = compiled[inp.getAttribute('data-k')];
      inp.classList.toggle('active', !!c);
      inp.classList.toggle('bad', c === false);
    });
  }

  // ── the address keeps the view ──────────────────────────────────────────────

  function writeHash() {
    var p = new URLSearchParams();
    COLS.forEach(function (c) { if (filters[c.k]) p.set(c.k, filters[c.k]); });
    if (sort.k !== 'when' || sort.dir !== -1) p.set('sort', (sort.dir < 0 ? '-' : '') + sort.k);
    if (showDeleted) p.set('deleted', '1');
    ViewerMap.writeParams(p);
    var h = p.toString();
    var url = location.pathname + location.search + (h ? '#' + h : '');
    if (url !== location.pathname + location.search + location.hash) history.replaceState(null, '', url);
  }

  function readHash() {
    var p = new URLSearchParams(location.hash.replace(/^#/, ''));
    filters = {}; compiled = {};
    COLS.forEach(function (c) {
      var v = p.get(c.k);
      if (v) { filters[c.k] = v; compiled[c.k] = compile(c, v); }
    });
    var s = p.get('sort');
    if (s) {
      var k = s.replace(/^-/, '');
      if (COL[k] || k === 'when') sort = { k: k, dir: s.charAt(0) === '-' ? -1 : 1 };
    } else sort = { k: 'when', dir: -1 };
    showDeleted = p.get('deleted') === '1';
    $('showDeleted').checked = showDeleted;
    ViewerMap.readParams(p);
    document.querySelectorAll('.frow input').forEach(function (inp) {
      inp.value = filters[inp.getAttribute('data-k')] || '';
    });
  }

  // ── table ───────────────────────────────────────────────────────────────────

  function visibleCols() { return COLS.filter(function (c) { return !hidden[c.k]; }); }

  function colW(c) { return widths[c.k] || c.w; }

  function template() {
    return visibleCols().map(function (c) { return colW(c) + 'px'; }).join(' ');
  }

  function renderHeader() {
    var cols = visibleCols(), tpl = template();
    $('ghead').innerHTML =
      '<div class="grow hrow" style="grid-template-columns:' + tpl + '">' + cols.map(function (c) {
        var mark = sort.k === c.k ? (sort.dir < 0 ? ' ▼' : ' ▲') : '';
        return '<div data-sort="' + c.k + '" class="' + (c.num ? 'num ' : '') + (mark ? 'sorted' : '') +
               '" title="Sort by ' + esc(c.t) + '">' + esc(c.t) + mark +
               '<span class="rz" data-rz="' + c.k + '" title="Drag to resize, double-click to fit"></span></div>';
      }).join('') + '</div>' +
      '<div class="grow frow" style="grid-template-columns:' + tpl + '">' + cols.map(function (c) {
        var inp = '<input data-k="' + c.k + '" value="' + esc(filters[c.k] || '') + '" placeholder="' +
                  (c.num ? '>, <, a-b' : 'filter') + '" aria-label="Filter ' + esc(c.t) + '" spellcheck="false">';
        if (c.k === 'log') {
          return '<div class="fpick">' + inp + '<button type="button" class="pick" title="Choose a log" ' +
                 'aria-label="Choose a log" aria-expanded="' + !$('logPal').hidden + '">▾</button></div>';
        }
        return '<div>' + inp + '</div>';
      }).join('') + '</div>';
    renderFilterState();
  }

  var lastRange = '';
  function renderRows(force) {
    var g = $('grid');
    var headH = $('ghead').offsetHeight;
    var top = Math.max(0, g.scrollTop - headH);
    var first = Math.max(0, Math.floor(top / ROW_H) - 10);
    var last = Math.min(shown.length, Math.ceil((top + g.clientHeight) / ROW_H) + 10);
    var key = first + ':' + last;
    if (!force && key === lastRange) return;
    lastRange = key;
    var cols = visibleCols(), tpl = template(), html = [];
    for (var i = first; i < last; i++) {
      var r = shown[i];
      html.push('<div class="grow drow' + (r.deleted ? ' deleted' : '') + (r === selected ? ' sel' : '') +
        '" data-i="' + i + '" style="grid-template-columns:' + tpl + '">' +
        cols.map(function (c) {
          var v = esc(r[c.k]);
          return '<div class="' + (c.num ? 'num ' : '') + (c.cls || '') + '" title="' + v + '">' + v + '</div>';
        }).join('') + '</div>');
    }
    var win = $('gwin');
    win.style.transform = 'translateY(' + (first * ROW_H) + 'px)';
    win.innerHTML = html.join('');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── statistics ──────────────────────────────────────────────────────────────

  function renderStats() {
    var calls = {}, countries = {}, logs = {}, conts = {}, odx = null, minD = '', maxD = '';
    shown.forEach(function (r) {
      calls[r.call] = true;
      if (r.country) countries[r.country] = true;
      logs[r.logId] = true;
      if (r.cont) conts[r.cont] = (conts[r.cont] || 0) + 1;
      if (r.qrb !== '' && (!odx || r.qrb > odx.qrb)) odx = r;
      if (r.date && (!minD || r.date < minD)) minD = r.date;
      if (r.date && (!maxD || r.date > maxD)) maxD = r.date;
    });
    var contKeys = Object.keys(conts).sort(function (a, b) { return conts[b] - conts[a]; });
    var contOn = (filters.cont || '').toLowerCase();
    function tile(v, k, cls) {
      return '<div class="tile' + (cls ? ' ' + cls : '') + '"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>';
    }
    $('tiles').innerHTML =
      tile(shown.length, 'QSO') +
      tile(Object.keys(calls).length, 'Stations') +
      tile(Object.keys(countries).length, 'DXCC') +
      tile(Object.keys(logs).length, 'Logs') +
      tile(minD ? esc(minD === maxD ? minD : minD + ' – ' + maxD) : '—', 'Period') +
      tile(odx ? esc(odx.qrb + ' km') + ' <span class="k">' + esc(odx.call) + '</span>' : '—', 'ODX') +
      '<div class="tile wide"><div class="k">Continents</div>' + (contKeys.length ? contKeys.map(function (c) {
        return '<button type="button" class="chip' + (contOn === '=' + c.toLowerCase() ? ' on' : '') +
               '" data-cont="' + esc(c) + '" title="Show only ' + esc(c) + '">' + esc(c) + ' ' + conts[c] + '</button>';
      }).join('') : '<span class="k">—</span>') + '</div>';
    renderBandMode();
  }

  // Bands in frequency order, a row per mode (CW-R is CW, USB/LSB are SSB),
  // sums both ways. Every number selects its rows when clicked.
  function renderBandMode() {
    var cells = {}, bands = {}, modes = {}, total = 0;
    shown.forEach(function (r) {
      var b = r.band, m = r.modeKey || '?';
      bands[b] = (bands[b] || 0) + 1;
      modes[m] = (modes[m] || 0) + 1;
      cells[m + '|' + b] = (cells[m + '|' + b] || 0) + 1;
      total++;
    });
    var bl = BAND_ORDER.filter(function (b) { return bands[b]; });
    var ml = Object.keys(modes).sort(function (a, b) { return modes[b] - modes[a] || (a < b ? -1 : 1); });
    if (!total) { $('bmTable').innerHTML = ''; return; }
    var bandLabel = function (b) { return b || '?'; };
    var h = '<tr><th class="click" data-bm="" title="Clear band and mode">Mode \\ Band</th>' +
      bl.map(function (b) { return '<th class="click" data-band="' + esc(b) + '">' + esc(bandLabel(b)) + '</th>'; }).join('') +
      '<th>Σ</th></tr>';
    ml.forEach(function (m) {
      h += '<tr><th class="click" data-mode="' + esc(m) + '">' + esc(m) + '</th>' + bl.map(function (b) {
        var n = cells[m + '|' + b] || 0;
        return n ? '<td class="click" data-mode="' + esc(m) + '" data-band="' + esc(b) + '">' + n + '</td>'
                 : '<td class="zero">·</td>';
      }).join('') + '<td class="sum click" data-mode="' + esc(m) + '">' + modes[m] + '</td></tr>';
    });
    h += '<tr><th>Σ</th>' + bl.map(function (b) {
      return '<td class="sum click" data-band="' + esc(b) + '">' + bands[b] + '</td>';
    }).join('') + '<td class="sum">' + total + '</td></tr>';
    $('bmTable').innerHTML = h;
  }

  function onBandModeClick(e) {
    var t = e.target.closest('.click');
    if (!t) return;
    if (t.hasAttribute('data-bm')) { setFilter('band', ''); setFilter('mode', ''); apply(); return; }
    if (t.hasAttribute('data-band')) {
      var b = t.getAttribute('data-band');
      setFilter('band', b ? '=' + b : '');
    }
    if (t.hasAttribute('data-mode')) setFilter('mode', '=' + t.getAttribute('data-mode'));
    apply();
  }

  // ── export ──────────────────────────────────────────────────────────────────

  function stamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '-' + p(d.getUTCHours()) + p(d.getUTCMinutes());
  }

  function anyFilter() {
    return COLS.some(function (c) { return !!compiled[c.k]; });
  }

  function rowsForExport(list) {
    // The order of the log, not of the screen: by time.
    return (list || shown).slice().sort(function (a, b) { return a.when < b.when ? -1 : a.when > b.when ? 1 : 0; })
      .map(function (r) { return Object.assign({}, r.q, { dxcc: r.q.dxcc || (Object.keys(r.d).length ? r.d : null) }); });
  }

  function download(text, name, mime) {
    var blob = new Blob(['﻿' + text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
  }

  function exportName(ext, tag) {
    return 'wifilt-log-' + stamp() + (anyFilter() ? '-filtered' : '') + (tag || '') + '.' + ext;
  }

  function exportRows(list, ext, tag) {
    var qsos = rowsForExport(list);
    if (ext === 'adi') {
      download(LogExport.adifFromQsos(qsos, function (q) { return logsById[q.logId] || {}; }),
               exportName('adi', tag), 'text/plain;charset=utf-8;');
    } else {
      download(LogExport.csvFromQsos(qsos), exportName('csv', tag), 'text/csv;charset=utf-8;');
    }
  }

  // ── column widths: drag the edge of a header, double-click it to fit ──────

  function loadWidths() {
    try { return JSON.parse(localStorage.getItem(WIDTHS_KEY) || '{}') || {}; } catch (_) { return {}; }
  }

  function saveWidths() {
    try { localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths)); } catch (_) {}
  }

  // While dragging, only the template changes: no row is built again.
  function setTemplate() {
    var tpl = template();
    document.querySelectorAll('#grid .grow').forEach(function (g) { g.style.gridTemplateColumns = tpl; });
  }

  var drag = null, justResized = false;

  function onResizeDown(e) {
    var h = e.target.closest('.rz');
    if (!h) return;
    e.preventDefault();
    var k = h.getAttribute('data-rz');
    drag = { k: k, x: e.clientX, w: colW(COL[k]) };
    if (h.setPointerCapture) h.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  }

  function onResizeMove(e) {
    if (!drag) return;
    widths[drag.k] = Math.round(Math.max(MIN_W, Math.min(MAX_W, drag.w + e.clientX - drag.x)));
    setTemplate();
  }

  function onResizeUp() {
    if (!drag) return;
    drag = null;
    // The click that ends a drag on a header must not sort by it.
    justResized = true;
    setTimeout(function () { justResized = false; }, 0);
    document.body.classList.remove('resizing');
    saveWidths();
  }

  // As wide as the longest value among the rows shown (the first 5000).
  var measure = null;
  function fitColumn(k) {
    var c = COL[k];
    measure = measure || document.createElement('canvas').getContext('2d');
    var mono = getComputedStyle(document.body).getPropertyValue('--mono');
    measure.font = '600 12px ' + getComputedStyle(document.body).fontFamily;
    var w = measure.measureText(c.t + ' ▼').width;
    measure.font = (c.cls === 'c-call' ? '700 ' : '') + '13px ' + mono;
    for (var i = 0; i < shown.length && i < 5000; i++) w = Math.max(w, measure.measureText(String(shown[i][k])).width);
    widths[k] = Math.round(Math.max(MIN_W, Math.min(MAX_W, w + 18)));
    saveWidths();
    setTemplate();
  }

  // ── the log palette: which logs the Log filter matches, how big each is ───

  // Every log the other filters leave QSOs in, with how many; narrowed by
  // the text in the Log filter. An exact pick (=name) lists them all, so
  // another one can be picked.
  function logChoices() {
    var tests = COLS.filter(function (c) { return c.k !== 'log' && compiled[c.k]; })
                    .map(function (c) { return compiled[c.k]; });
    var by = {}, list = [];
    all.forEach(function (r) {
      if (r.deleted && !showDeleted) return;
      for (var i = 0; i < tests.length; i++) if (!tests[i](r)) return;
      var e = by[r.log];
      if (!e) { e = by[r.log] = { name: r.log, n: 0, from: '', my: {} }; list.push(e); }
      e.n++;
      if (r.date && (!e.from || r.date < e.from)) e.from = r.date;
      if (r.my) e.my[r.my] = true;
    });
    var raw = String(filters.log || '').trim().toLowerCase();
    var text = raw.charAt(0) === '=' ? '' : raw;
    return {
      text: text,
      list: list.filter(function (e) { return !text || e.name.toLowerCase().indexOf(text) >= 0; })
                .sort(function (a, b) { return a.from < b.from ? 1 : a.from > b.from ? -1 : 0; }),
    };
  }

  function renderLogPal() {
    var ch = logChoices(), list = ch.list, cur = String(filters.log || '').trim().toLowerCase();
    var n = list.reduce(function (s, e) { return s + e.n; }, 0);
    $('logPal').innerHTML =
      '<div class="lp-head"><b>' + list.length + (list.length === 1 ? ' log' : ' logs') + '</b> · ' + n + ' QSO' +
      (ch.text ? ' · matching “' + esc(ch.text) + '”' : '') + '</div>' +
      '<div class="lp-list">' + list.map(function (e) {
        return '<button type="button" class="lp-row' + (cur === '=' + e.name.toLowerCase() ? ' on' : '') +
               '" data-log="' + esc(e.name) + '"><span class="lp-name">' + esc(e.name) + '</span>' +
               '<span class="lp-my">' + esc(Object.keys(e.my).join(' ')) + '</span>' +
               '<span class="lp-date">' + esc(e.from) + '</span><span class="lp-n">' + e.n + '</span></button>';
      }).join('') + '</div>' +
      (cur ? '<button type="button" class="lp-any" data-log="">Any log</button>' : '');
    placeLogPal();
  }

  function placeLogPal() {
    var cell = document.querySelector('.frow .fpick'), pal = $('logPal');
    if (!cell) { closeLogPal(); return; }
    var r = cell.getBoundingClientRect(), w = Math.min(460, window.innerWidth - 16);
    pal.style.width = w + 'px';
    pal.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    pal.style.top = (r.bottom + 2) + 'px';
    pal.style.maxHeight = Math.max(160, window.innerHeight - r.bottom - 14) + 'px';
  }

  function openLogPal() {
    $('logPal').hidden = false;
    renderLogPal();
    var b = document.querySelector('.frow .pick');
    if (b) b.setAttribute('aria-expanded', 'true');
  }

  function closeLogPal() {
    $('logPal').hidden = true;
    var b = document.querySelector('.frow .pick');
    if (b) b.setAttribute('aria-expanded', 'false');
  }

  // ── columns menu ────────────────────────────────────────────────────────────

  function loadHidden() {
    try { return JSON.parse(localStorage.getItem(COLS_KEY) || '{}') || {}; } catch (_) { return {}; }
  }

  function saveHidden() {
    try { localStorage.setItem(COLS_KEY, JSON.stringify(hidden)); } catch (_) {}
  }

  // Under the button, or above it when there is no room below.
  function placeColsMenu() {
    var m = $('colsMenu'), r = $('colsBtn').getBoundingClientRect();
    var below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + 'px';
    if (below >= m.scrollHeight || below >= above) {
      m.style.top = (r.bottom + 4) + 'px'; m.style.bottom = '';
      m.style.maxHeight = below + 'px';
    } else {
      m.style.top = ''; m.style.bottom = (window.innerHeight - r.top + 4) + 'px';
      m.style.maxHeight = above + 'px';
    }
  }

  function closeColsMenu() {
    $('colsMenu').hidden = true;
    $('colsBtn').setAttribute('aria-expanded', 'false');
  }

  function renderColsMenu() {
    $('colsMenu').innerHTML = COLS.map(function (c) {
      return '<label><input type="checkbox" data-col="' + c.k + '"' + (hidden[c.k] ? '' : ' checked') + '> ' + esc(c.t) + '</label>';
    }).join('') + '<button type="button" class="reset-w" id="resetWidths"' + (Object.keys(widths).length ? '' : ' disabled') +
      '>Reset column widths</button>';
  }

  // ── wiring ──────────────────────────────────────────────────────────────────

  function wire() {
    $('ghead').addEventListener('input', function (e) { if (e.target.matches('.frow input')) onFilterInput(e); });
    $('ghead').addEventListener('pointerdown', onResizeDown);
    $('ghead').addEventListener('pointermove', onResizeMove);
    $('ghead').addEventListener('pointerup', onResizeUp);
    $('ghead').addEventListener('pointercancel', onResizeUp);
    $('ghead').addEventListener('dblclick', function (e) {
      var h = e.target.closest('.rz');
      if (h) fitColumn(h.getAttribute('data-rz'));
    });
    $('ghead').addEventListener('click', function (e) {
      if (e.target.closest('.pick')) {
        if ($('logPal').hidden) openLogPal(); else closeLogPal();
        return;
      }
      if (justResized || e.target.closest('.rz')) return;
      var h = e.target.closest('[data-sort]');
      if (!h) return;
      var k = h.getAttribute('data-sort');
      if (sort.k !== k) sort = { k: k, dir: COL[k].num ? -1 : 1 };
      else if (sort.dir === (COL[k].num ? -1 : 1)) sort.dir = -sort.dir;
      else sort = { k: 'when', dir: -1 };
      renderHeader();
      apply();
    });
    $('grid').addEventListener('scroll', function () { renderRows(false); }, { passive: true });
    $('gwin').addEventListener('click', function (e) {
      var d = e.target.closest('.drow');
      var r = d && shown[Number(d.getAttribute('data-i'))];
      if (!r) return;
      selected = r;
      renderRows(true);
      ViewerMap.focus(r);
    });
    window.addEventListener('resize', function () { renderRows(true); });
    $('tiles').addEventListener('click', function (e) {
      var c = e.target.closest('[data-cont]');
      if (!c) return;
      var v = '=' + c.getAttribute('data-cont');
      setFilter('cont', (filters.cont || '').toLowerCase() === v.toLowerCase() ? '' : v);
      apply();
    });
    $('bmTable').addEventListener('click', onBandModeClick);
    $('showDeleted').addEventListener('change', function (e) { showDeleted = e.target.checked; apply(); });
    $('clearFilters').addEventListener('click', function () {
      COLS.forEach(function (c) { setFilter(c.k, ''); });
      apply();
    });
    $('colsBtn').addEventListener('click', function () {
      var m = $('colsMenu');
      m.hidden = !m.hidden;
      $('colsBtn').setAttribute('aria-expanded', String(!m.hidden));
      if (!m.hidden) { renderColsMenu(); placeColsMenu(); }
    });
    // A fixed menu would stay put while its button moves away.
    document.querySelector('.upper > .top').addEventListener('scroll', closeColsMenu, { passive: true });
    window.addEventListener('resize', closeColsMenu);
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.cols-wrap')) closeColsMenu();
      if (!e.target.closest('#logPal') && !e.target.closest('.pick') && !e.target.closest('.fpick input')) closeLogPal();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLogPal(); });
    $('logPal').addEventListener('click', function (e) {
      var b = e.target.closest('[data-log]');
      if (!b) return;
      var name = b.getAttribute('data-log');
      setFilter('log', name ? '=' + name : '');
      closeLogPal();
      apply();
    });
    $('grid').addEventListener('scroll', function () { if (!$('logPal').hidden) placeLogPal(); }, { passive: true });
    window.addEventListener('resize', function () { if (!$('logPal').hidden) placeLogPal(); });
    $('colsMenu').addEventListener('click', function (e) {
      if (e.target.id !== 'resetWidths') return;
      widths = {};
      saveWidths();
      e.target.disabled = true;
      renderHeader();
      renderRows(true);
    });
    $('colsMenu').addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-col');
      if (!k) return;
      if (e.target.checked) delete hidden[k]; else hidden[k] = true;
      if (visibleCols().length === 0) { delete hidden[k]; e.target.checked = true; return; }
      saveHidden();
      renderHeader();
      renderRows(true);
    });
    $('helpBtn').addEventListener('click', function () {
      $('help').hidden = !$('help').hidden;
      $('helpBtn').setAttribute('aria-expanded', String(!$('help').hidden));
    });
    $('dlAdif').addEventListener('click', function () { exportRows(shown, 'adi'); });
    $('dlCsv').addEventListener('click', function () { exportRows(shown, 'csv'); });
    window.addEventListener('hashchange', function () {
      if (!fileInfo) return;
      readHash();
      renderHeader();
      apply();
    });
  }

  // Exposed for tools/log-viewer-smoke.js.
  window.LogViewer = {
    rows: function () { return shown; },
    all: function () { return all; },
    setFilter: function (k, v) { setFilter(k, v); apply(); },
    map: function () { return ViewerMap.info(); },
  };

  // On a phone the table is what there is no room for: the band x mode
  // breakdown starts folded there.
  if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) $('bmBox').open = false;

  ViewerMap.init({
    onFilter: function (k, v) { setFilter(k, v); apply(); },
    onState: writeHash,
    // The QSOs whose points are in view on the map, in the log's own format.
    onExport: function (list, ext) { exportRows(list, ext, '-map'); },
  });
  wire();
  load();
}());
