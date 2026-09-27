'use strict';
/**
 * log-stats.js — the Alt+S statistics palette on the contest log
 *
 * A small movable palette answering two questions mid-contest: how many QSOs
 * on which band (and mode), and how many multipliers so far. Grilled
 * 2026-09-28; the decisions, in short:
 *
 *   - the ACTIVE log only, deleted QSOs left out, recounted live while open
 *     and not at all while closed;
 *   - one column per band that has a QSO, in frequency order, Σ on the right,
 *     and a "?" column only when some QSO has no usable frequency;
 *   - duplicates do not count: one QSO per call + band + mode, the first one
 *     logged. Mode as the DUPE colouring reads it (_modeKey, CW-R = CW), and
 *     USB/LSB folded into SSB. One mode in the log is one "QSO" row; more are
 *     a row each plus a "QSO" total row under them;
 *   - multipliers are read out of EXCH, per band regardless of mode, with the
 *     Σ the SUM of the bands (what scores), and the whole log's unique list
 *     below it. Each QSO gives at most one: its LAST candidate word.
 *       US/VE states: a 2-3 letter word, only from stations the DXCC table
 *                     puts in the USA, Alaska, Hawaii or Canada. No state
 *                     list on purpose -- ARRL sections (ENY, WPA) would fall
 *                     through one, and junk shows up in the list anyway.
 *       Zones:        a 1-2 digit word read as a number (2 = 02), 0 dropped,
 *                     no upper bound so CQ and ITU zones both work;
 *   - the choice of multiplier is remembered per log, the palette's place and
 *     whether it is open for the page.
 *
 * Like pa-panel.js it must never take the keyboard away from the log: buttons
 * cancel their own mousedown, and the one control that cannot (the select)
 * hands the caret back to Call as soon as it is used.
 *
 * Loaded after log.js: it reads _bandFromHz, _modeKey and inpCall from there.
 */
(function (global) {

  var STORE_KEY = 'wifilt-log-stats';        // {open, x, y}
  var MULT_KEY  = 'wifilt-log-stats-mult';   // {logId: 'states' | 'zones'}
  var REFRESH_MS = 150;

  // _bandFromHz's own order, low to high. A band it can return that is missing
  // here would still be shown -- after these, see compute().
  var BAND_ORDER = ['2200m', '630m', '160m', '80m', '60m', '40m', '30m', '20m',
                    '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm', '23cm',
                    '13cm', '9cm', '6cm', '3cm', '1.2cm', 'shf'];
  var MODE_ORDER = ['CW', 'SSB', 'AM', 'FM', 'RTTY'];
  // DXCC main prefixes of the USA, Alaska, Hawaii and Canada (dxcc.js).
  var WVE = { K: 1, KL: 1, KH6: 1, VE: 1 };
  var MULT_KINDS = { states: 1, zones: 1 };

  var el = null, open = false, pos = null;
  var userPos = false;   // pos is where the operator put it, not the anchor
  var multByLog = {};
  var timer = null, seq = 0;
  var lastQsos = null, lastLogId = null;

  // ── counting ──────────────────────────────────────────────────────────────

  function bandOf(q) {
    var hz = (global.LogDB && LogDB.hzOf) ? LogDB.hzOf(q) : Number(q.frequencyHz) || 0;
    if (!(hz > 0) || typeof _bandFromHz !== 'function') return null;
    return _bandFromHz(hz) || null;
  }

  function modeOf(q) {
    var m = typeof _modeKey === 'function' ? _modeKey(q.mode)
                                           : String(q.mode || '').trim().toUpperCase();
    if (m === 'USB' || m === 'LSB') m = 'SSB';
    return m || null;
  }

  // The DXCC entity by the call as it stands NOW: an edited call keeps the
  // dxcc object of the call it replaced, so the stored one is only a fallback.
  function entityOf(q, lookup) {
    var d = null;
    try { d = lookup ? lookup(q.call) : null; } catch (_) {}
    return d || q.dxcc || null;
  }

  function multOf(q, kind, lookup) {
    var words = String(q.exchangeReceived || '').toUpperCase().split(/[^A-Z0-9]+/);
    var re = kind === 'zones' ? /^\d{1,2}$/ : /^[A-Z]{2,3}$/;
    var w = null;
    for (var i = words.length - 1; i >= 0; i--) {
      if (re.test(words[i])) { w = words[i]; break; }
    }
    if (!w) return null;
    if (kind === 'zones') {
      var n = parseInt(w, 10);
      return n > 0 ? String(n) : null;
    }
    var d = entityOf(q, lookup);
    return d && WVE[d.mainPrefix] ? w : null;
  }

  function tsOf(q) {
    return q.timestampUtc || ((q.qsoDateUtc || '') + 'T' + (q.timeOnUtc || '') + 'Z');
  }

  function modeRank(m) {
    if (m === '?') return 1000;
    var i = MODE_ORDER.indexOf(m);
    return i < 0 ? 100 : i;
  }

  // Pure: QSOs in, table out. No DOM, so the smoke harness can feed it straight.
  //   bands     column keys in display order ('?' last, when present)
  //   rows      [{label, perBand:{band: n}, total}] -- the QSO rows as shown
  //   mult      null, or {perBand:{band: n}, sum, unique:[...]}
  function compute(qsos, kind, lookup) {
    var list = (qsos || []).filter(function (q) { return q && !q.deleted; });
    // Oldest first, so the QSO that counts is the first one logged and a dupe
    // cannot bring in a multiplier its original did not.
    list.sort(function (a, b) {
      var ta = tsOf(a), tb = tsOf(b);
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });

    var seen = {}, used = {}, byMode = {};
    var multBand = {}, multAll = {};
    var multOn = !!MULT_KINDS[kind];

    list.forEach(function (q) {
      var band = bandOf(q) || '?';
      var mode = modeOf(q) || '?';
      var call = String(q.call || '').trim().toUpperCase();
      var key = call + '|' + band + '|' + mode;
      if (seen[key]) return;
      seen[key] = 1;
      used[band] = 1;
      var row = byMode[mode] || (byMode[mode] = {});
      row[band] = (row[band] || 0) + 1;
      if (!multOn) return;
      var m = multOf(q, kind, lookup);
      if (!m) return;
      (multBand[band] || (multBand[band] = {}))[m] = 1;
      multAll[m] = 1;
    });

    var bands = BAND_ORDER.filter(function (b) { return used[b]; });
    Object.keys(used).forEach(function (b) {
      if (b !== '?' && bands.indexOf(b) < 0) bands.push(b);
    });
    if (used['?']) bands.push('?');

    function mkRow(label, perBand) {
      var total = 0;
      bands.forEach(function (b) { total += perBand[b] || 0; });
      return { label: label, perBand: perBand, total: total };
    }

    var modes = Object.keys(byMode).sort(function (a, b) {
      return (modeRank(a) - modeRank(b)) || (a < b ? -1 : a > b ? 1 : 0);
    });
    var rows = [];
    if (modes.length > 1) {
      var sum = {};
      modes.forEach(function (m) {
        rows.push(mkRow(m, byMode[m]));
        bands.forEach(function (b) { sum[b] = (sum[b] || 0) + (byMode[m][b] || 0); });
      });
      rows.push(mkRow('QSO', sum));
    } else {
      rows.push(mkRow('QSO', modes.length ? byMode[modes[0]] : {}));
    }

    var mult = null;
    if (multOn) {
      var per = {}, s = 0;
      bands.forEach(function (b) {
        per[b] = multBand[b] ? Object.keys(multBand[b]).length : 0;
        s += per[b];
      });
      var unique = Object.keys(multAll);
      if (kind === 'zones') unique.sort(function (a, b) { return a - b; });
      else unique.sort();
      mult = { perBand: per, sum: s, unique: unique };
    }

    return { bands: bands, rows: rows, mult: mult };
  }

  // ── persistence ───────────────────────────────────────────────────────────
  // Wrapped both ways, as in pa-panel.js: a private window refuses localStorage
  // outright, and a palette that throws on load would take the log with it.

  function load() {
    try {
      var v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (v && typeof v === 'object') {
        open = !!v.open;
        if (typeof v.x === 'number' && typeof v.y === 'number') {
          pos = { x: v.x, y: v.y };
          userPos = true;
        }
      }
    } catch (_) {}
    try {
      var m = JSON.parse(localStorage.getItem(MULT_KEY) || 'null');
      if (m && typeof m === 'object') multByLog = m;
    } catch (_) {}
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        open: open, x: userPos && pos ? pos.x : null, y: userPos && pos ? pos.y : null
      }));
    } catch (_) {}
  }

  function multFor(logId) {
    var k = logId != null ? multByLog[logId] : null;
    return MULT_KINDS[k] ? k : '';
  }

  function setMultFor(logId, kind) {
    if (logId == null) return;
    if (MULT_KINDS[kind]) multByLog[logId] = kind; else delete multByLog[logId];
    try { localStorage.setItem(MULT_KEY, JSON.stringify(multByLog)); } catch (_) {}
  }

  // ── geometry ──────────────────────────────────────────────────────────────

  // A stored position is only valid against the window it was stored in.
  // Clamped on every placement, every resize and every redraw -- the table
  // grows a column with each new band and must not grow off the screen.
  function clamp(p) {
    var w = el ? el.offsetWidth : 260;
    var h = el ? el.offsetHeight : 120;
    return {
      x: Math.min(Math.max(0, p.x), Math.max(0, global.innerWidth - w)),
      y: Math.min(Math.max(0, p.y), Math.max(0, global.innerHeight - h))
    };
  }

  // First ever opening: the top right corner of the journal, where it covers
  // the oldest QSOs and none of the entry row.
  function anchorPos() {
    var j = document.querySelector('.log-journal');
    var r = j ? j.getBoundingClientRect() : null;
    var w = el ? el.offsetWidth : 260;
    if (!r) return { x: 20, y: 20 };
    return { x: r.right - w - 8, y: r.top + 8 };
  }

  // Until the operator has moved it, the palette is re-anchored on every
  // placement: its width is only known once the table is in, and the first
  // placement happens over an empty body.
  function place() {
    if (!el) return;
    if (!pos || !userPos) pos = anchorPos();
    pos = clamp(pos);
    el.style.left = pos.x + 'px';
    el.style.top  = pos.y + 'px';
  }

  // ── build ─────────────────────────────────────────────────────────────────

  function build() {
    el = document.createElement('div');
    el.className = 'st-panel';
    el.id = 'statsPanel';
    el.innerHTML =
      '<div class="st-head" id="statsHead">' +
        '<span class="st-title">STATISTICS</span>' +
        '<button class="st-close" id="statsClose" type="button" title="Close (Alt+S)">&#10005;</button>' +
      '</div>' +
      '<div class="st-body">' +
        '<div class="st-empty" id="statsEmpty" hidden></div>' +
        '<table class="st-table" id="statsTable">' +
          '<thead id="statsThead"></thead>' +
          '<tbody id="statsQso"></tbody>' +
          // Built once and never redrawn: a select rewritten by innerHTML would
          // close under the operator's hand whenever a QSO got logged.
          '<tbody><tr class="st-sel-row"><td id="statsSelCell">' +
            '<select id="statsMult" class="st-select" title="Multipliers read from EXCH">' +
              '<option value="">&mdash; multipliers &mdash;</option>' +
              '<option value="states">US/VE states</option>' +
              '<option value="zones">Zones</option>' +
            '</select></td></tr></tbody>' +
          '<tbody id="statsMultRows"></tbody>' +
        '</table>' +
      '</div>';
    document.body.appendChild(el);

    el.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) e.preventDefault();
    });
    document.getElementById('statsClose').addEventListener('click', function () { setOpen(false); });
    el.addEventListener('change', onMultChange);
    mountDrag(document.getElementById('statsHead'));
  }

  function mountDrag(handle) {
    var dragging = false, dx = 0, dy = 0;
    handle.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.st-close')) return;
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
      el.style.top  = pos.y + 'px';
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      userPos = true;
      save();
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // The select is the one control that has to take focus to work at all, so
  // it gives it straight back. Esc on it would reach log.js's global handler
  // and abort a transmission, which is what Esc does everywhere else too.
  function onMultChange(e) {
    if (!e.target || e.target.id !== 'statsMult') return;
    setMultFor(lastLogId, e.target.value);
    render();
    try { inpCall.focus(); } catch (_) {}
  }

  // ── render ────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function cell(n) { return n ? String(n) : '<span class="st-zero">&middot;</span>'; }

  function render() {
    if (!el) return;
    var empty = document.getElementById('statsEmpty');
    var table = document.getElementById('statsTable');
    if (lastLogId == null || !lastQsos) {
      empty.innerHTML = lastLogId == null ? 'No log open.' : '&hellip;';
      empty.hidden = false;
      table.hidden = true;
      place();
      return;
    }
    empty.hidden = true;
    table.hidden = false;

    var kind = multFor(lastLogId);
    var sel = document.getElementById('statsMult');
    if (sel.value !== kind) sel.value = kind;
    var lookup = global.DXCC && DXCC.lookupDxcc ? DXCC.lookupDxcc : null;
    var st = compute(lastQsos, kind, lookup);

    var h = '<tr><th class="st-lbl"></th>';
    st.bands.forEach(function (b) { h += '<th>' + esc(b) + '</th>'; });
    document.getElementById('statsThead').innerHTML = h + '<th class="st-sum">&Sigma;</th></tr>';

    h = '';
    st.rows.forEach(function (r, i) {
      var total = st.rows.length > 1 && i === st.rows.length - 1;
      h += '<tr' + (total ? ' class="st-total"' : '') + '><th class="st-lbl">' + esc(r.label) + '</th>';
      st.bands.forEach(function (b) { h += '<td>' + cell(r.perBand[b]) + '</td>'; });
      h += '<td class="st-sum">' + r.total + '</td></tr>';
    });
    document.getElementById('statsQso').innerHTML = h;

    var cols = st.bands.length + 2;
    document.getElementById('statsSelCell').colSpan = cols;

    h = '';
    if (st.mult) {
      h += '<tr class="st-mult"><th class="st-lbl">MULT</th>';
      st.bands.forEach(function (b) { h += '<td>' + cell(st.mult.perBand[b]) + '</td>'; });
      h += '<td class="st-sum">' + st.mult.sum + '</td></tr>';
      h += '<tr><td colspan="' + cols + '" class="st-list" id="statsList">' +
           '<span class="st-list-n">unique ' + st.mult.unique.length + ':</span> ' +
           (st.mult.unique.length ? esc(st.mult.unique.join(' ')) : '&mdash;') +
           '</td></tr>';
    }
    document.getElementById('statsMultRows').innerHTML = h;
    place();
  }

  // ── data ──────────────────────────────────────────────────────────────────

  function activeLog() {
    return global.LogManager && LogManager.getActiveLog ? LogManager.getActiveLog() : null;
  }

  function fetchNow() {
    timer = null;
    if (!open) return;
    var log = activeLog();
    var my = ++seq;
    if (!log) { lastLogId = null; lastQsos = null; render(); return; }
    if (log.id !== lastLogId) { lastLogId = log.id; lastQsos = null; render(); }
    LogDB.getQsosForLog(log.id).then(function (qsos) {
      if (my !== seq || !open) return;         // a newer recount is on its way
      lastQsos = qsos;
      render();
    }).catch(function () {});
  }

  function refresh() {
    if (!open) return;
    clearTimeout(timer);
    timer = setTimeout(fetchNow, REFRESH_MS);
  }

  function setOpen(v) {
    open = !!v;
    if (open && !el) build();
    if (el) el.style.display = open ? '' : 'none';
    if (open) {
      place();
      clearTimeout(timer);
      fetchNow();
    } else {
      clearTimeout(timer);
      timer = null;
      lastQsos = null;
      // Closing from inside the palette must not strand the caret there.
      if (el && el.contains(document.activeElement)) { try { inpCall.focus(); } catch (_) {} }
    }
    save();
  }

  // ── mount ─────────────────────────────────────────────────────────────────

  function mount() {
    load();
    if (global.LogDB && LogDB.onQsoWrite) LogDB.onQsoWrite(refresh);
    global.addEventListener('resize', function () {
      if (!el || !open) return;
      place();
      save();
    });
    if (open) setOpen(true);
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', mount);
  else
    mount();

  global.LogStats = {
    toggle:  function () { setOpen(!open); },
    setOpen: setOpen,
    isOpen:  function () { return open; },
    refresh: refresh,
    compute: compute
  };

}(window));
