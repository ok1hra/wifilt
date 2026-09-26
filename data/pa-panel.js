'use strict';
/**
 * pa-panel.js — the linear amplifier, on the contest log
 *
 * A small movable palette showing everything TrxNet carries about an EXPERT
 * 1K-FA (six topics, nothing more is on the wire) and offering the four
 * commands it accepts. The firmware does the TrxNet half and serves it as
 * /pa.json; this file is only the window onto it.
 *
 * Two rules shape the whole thing:
 *
 * 1. It must never take the keyboard away from the log. A contest log is
 *    driven entirely from Call and Exch, and a panel floating over it that
 *    steals focus on a click would be worse than no panel. Every button
 *    cancels its own mousedown, so the click still fires but focus never
 *    moves -- that one line is the reason this is usable at all.
 *
 * 2. A command is not a confirmation. The daemon takes commands only with
 *    --trxnet-subscribe and silently drops them when the sender is outside
 *    --trxnet-allow; neither refusal comes back. So every button waits to see
 *    the amplifier's own flags move, and says so when they do not.
 *
 * Mounted with one script tag, carrying its own markup -- the wake-lock.js /
 * lan-gate.js pattern. Page-local by design: this belongs to QRPLog.
 */
(function (global) {

  var STORE_KEY = 'wifilt-pa-panel';
  var POLL_OPEN_MS   = 500;    // matches the log's own /state cadence
  var POLL_CLOSED_MS = 3000;   // just enough to know whether the button belongs
  // The amplifier needs about seven seconds to come up from DTR, so the wait for
  // ON has to outlast that; the other three are keystroke loops inside the
  // daemon and have to outlast the daemon's own giving up, or this says "did
  // not follow" while it is still trying.
  //
  // OPERATE and PWR bound at MAX_TRIES x SETTLE_S in expert_console.py: three
  // presses, each waiting for a STATUS that arrived at least 1.5 s after the
  // last one. That is 4.5 s, and measured on the wire it lands at about 4.7 s,
  // because the amplifier goes completely silent for 1.2 s while it throws the
  // relays. Six seconds leaves a second of room on top. (It used to be four,
  // written when the daemon retried six times at 0.4 s -- which was itself the
  // bug: it pressed a toggle key again before the amplifier could answer, and
  // the parity of the press count decided where it ended up.)
  var CONFIRM_MS = { on: 10000, operate: 6000, full: 6000, tune: 6000 };
  // Fan switching thresholds in °C, from the amplifier's manual 18.17 by way of
  // the web console's AMP.fanOn -- the same numbers it colours its own TEMP cell
  // by, so one reading means one thing on both screens. The CONTEST set starts
  // at 0 because in that mode the first fan stage runs continuously: during a
  // contest the number is always at least "warm", which is a fact about the fan
  // rather than a fault.
  var PA_FAN_ON   = { normal: [40, 65, 75], contest: [0, 60, 70] };
  // Above this the amplifier's own hardware protection trips (AMP.tempMax).
  var PA_TEMP_MAX = 90;

  // Reflected power's own full scale, from the console's AMP.prMax. It does not
  // follow FULL/HALF: what matters about reflected power is how much of it there
  // is, not what fraction of the forward power it represents.
  var PA_REF_MAX = 200;
  // How long a button ignores further presses after the amplifier CONFIRMED one.
  // Long enough to cover an operator who pressed again just as the confirmation
  // landed, short enough not to be felt when the next change is deliberate.
  var SETTLE_MS = 1500;

  // /pa-flags, exactly as the daemon documents it. Bit 7 is always zero: it
  // means PA_PROT in protocol Rev 1.0 and T_SCALE in Rev 2.0, so it would be
  // two different things on one wire.
  var F = {
    TUNE: 1 << 0, OPERATE: 1 << 1, TX: 1 << 2, ALARM: 1 << 3,
    FULL: 1 << 4, CONTEST: 1 << 5, BEEP: 1 << 6,
    ON: 1 << 8, LINK: 1 << 9, REV2: 1 << 10
  };

  // Metres -> the Hz span the amplifier would be on. Used only to colour the
  // band red when the amplifier and the radio disagree; deliberately generous,
  // because a false alarm here would train the operator to ignore it.
  var BAND_HZ = {
    160: [1800000, 2000000],   80: [3500000, 4000000],   40: [7000000, 7300000],
     30: [10100000, 10150000], 20: [14000000, 14350000], 17: [18068000, 18168000],
     15: [21000000, 21450000], 12: [24890000, 24990000], 10: [28000000, 29700000],
      6: [50000000, 54000000]
  };

  // The tuner's sub-bands: the CENTRE of each, in kHz, keyed by band in metres --
  // the same key as BAND_HZ and as what the amplifier publishes on /band. From
  // the user's manual section 19 (p. 70), by way of SUB_CENTER_KHZ in
  // expert_console.py, where test/subband_test.py checks it against that table
  // band by band. 127 entries in total.
  //
  // Written out rather than generated, for the same reason the daemon writes it
  // out: it is the one piece of data here with no other source to check it
  // against, so it has to be readable against the manual line by line. The steps
  // are regular within a band EXCEPT 17 m (50 then 40) and 12 m (72 then 75),
  // which is exactly what a generator would get wrong.
  //
  // This is a second band table beside BAND_HZ and deliberately not a
  // replacement: BAND_HZ is the IARU span, used only to notice that the
  // amplifier and the radio disagree, and is kept generous on purpose. These are
  // the tuner's own divisions and reach FURTHER than the band -- 160 m starts at
  // 1785 and 10 m at 27950 -- because the amplifier will tune there.
  var PA_SUB_KHZ = {
    160: [1785, 1795, 1805, 1815, 1825, 1835, 1845, 1855, 1865, 1875, 1885, 1895,
          1905, 1915, 1925, 1935, 1945, 1955, 1965, 1975, 1985, 1995, 2005, 2015],
     80: [3470, 3490, 3510, 3530, 3550, 3570, 3590, 3610, 3630, 3650, 3670, 3690,
          3710, 3730, 3750, 3770, 3790, 3810, 3830, 3850, 3870, 3890, 3910, 3930,
          3950, 3970, 3990, 4010, 4030],
     40: [6963, 6988, 7013, 7038, 7063, 7088, 7113, 7138,
          7163, 7188, 7213, 7238, 7263, 7288, 7313, 7338],
     30: [10075, 10125, 10175],
     20: [13975, 14025, 14075, 14125, 14175, 14225, 14275, 14325, 14375],
     17: [18075, 18125, 18165],
     15: [20975, 21025, 21075, 21125, 21175, 21225, 21275, 21325, 21375,
          21425, 21475],
     12: [24891, 24963, 25038],
     10: [27950, 28050, 28150, 28250, 28350, 28450, 28550, 28650, 28750, 28850,
          28950, 29050, 29150, 29250, 29350, 29450, 29550, 29650, 29750],
      6: [49750, 50250, 50750, 51250, 51750, 52250, 52750, 53250, 53750, 54250]
  };

  // Segments shown at once. The scale is 218 px wide, so a whole band would put
  // 80 m's 29 segments at under 6 px each -- unreadable and unclickable. Six
  // leaves about 27 px per segment, and on 160 m the window comes out at 60 kHz.
  var PA_SEG_PAGE = 6;

  var state   = null;    // last /pa.json
  var open    = false;
  var pos     = null;    // {x, y}, null until placed
  var gap     = null;    // px from the viewport's BOTTOM edge to the panel's
                         // bottom edge -- the vertical anchor, see place()
  var placed  = null;    // the {y, h} place() last wrote, so syncGap() can tell
                         // the operator's own moves from this file's
  var el      = null;    // the panel, built on first open
  var btn     = null;    // the PA button in the bottom bar
  var pollTimer = null;
  var pending   = {};    // what -> {want, until, from}
  var settledAt = {};    // what -> when the amplifier last CONFIRMED it
  var note    = '';      // one line of trouble, shown under the buttons
  var held    = null;    // the last transmission's readings, {fw, rf, swr}
  var heldKeyed = false; // was the last sample a transmitting one
  // TUNE+ runs in the firmware (/pa.json "tp"); these only follow it.
  var tpAskedAt = 0;     // a start/stop is on its way: '…' until the state moves
  var tpLastSt  = null;  // last tp.st seen, to notice a run finishing
  var atuLastAt = null;  // when the last tuner-off attempt was, to report it once
  var segKey  = '';      // band + first shown segment, so the scale's dividers
                         // are rebuilt only when the window actually moves
  var segView = null;    // {list, start, end, lo, hi} of what is drawn right now,
                         // so a click can be mapped back to a frequency

  // ── persistence ───────────────────────────────────────────────────────────
  // Wrapped both ways: a private window refuses localStorage outright, and a
  // panel that throws on load would take the whole log's script with it.

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var v = JSON.parse(raw);
      if (v && typeof v === 'object') {
        open = !!v.open;
        if (typeof v.x === 'number' && typeof v.y === 'number') pos = { x: v.x, y: v.y };
        // Older stores hold only the top. They stay readable: place() derives
        // the gap from that top once, against the window it is opened in.
        if (typeof v.gap === 'number') gap = v.gap;
      }
    } catch (_) {}
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        open: open, x: pos ? pos.x : null, y: pos ? pos.y : null, gap: gap
      }));
    } catch (_) {}
  }

  // ── geometry ──────────────────────────────────────────────────────────────

  // A stored position is only valid against the window it was stored in. Clamp
  // on every load and every resize, or a panel dragged to the right of a wide
  // screen is simply gone on a laptop, with no way to get it back.
  function clamp(p) {
    if (!p) return p;
    var w = el ? el.offsetWidth  : 218;
    var h = el ? el.offsetHeight : 150;
    var maxX = Math.max(0, global.innerWidth  - w);
    var maxY = Math.max(0, global.innerHeight - h);
    return { x: Math.min(Math.max(0, p.x), maxX), y: Math.min(Math.max(0, p.y), maxY) };
  }

  // First ever opening: under the button that opened it, not in the middle of
  // the screen. The panel belongs to that button and should look like it.
  function anchorPos() {
    var r = btn ? btn.getBoundingClientRect() : null;
    if (!r) return { x: 20, y: 20 };
    var w = el ? el.offsetWidth : 218;
    var h = el ? el.offsetHeight : 150;
    return clamp({ x: r.right - w, y: r.top - h - 8 });
  }

  // The panel hangs from the BOTTOM of the viewport, not the top: `gap` is the
  // distance from the window's bottom edge to the panel's own, and the top is
  // derived from it every time. That is what keeps the palette the same short
  // distance above the log's entry fields when the browser window is resized --
  // the fields sit just above the bottom button bar, so a top-anchored palette
  // would drift into them as the window shrinks and away from them as it grows.
  function place() {
    if (!el) return;
    var h = el.offsetHeight;
    if (!pos) pos = anchorPos();
    if (gap === null) gap = global.innerHeight - (pos.y + h);
    pos = clamp({ x: pos.x, y: global.innerHeight - h - gap });
    el.style.left = pos.x + 'px';
    el.style.top  = pos.y + 'px';
    placed = { y: pos.y, h: h };
  }

  // Wherever the panel's bottom edge has ENDED UP -- after a drag, or after its
  // own content changed height -- is the new anchor.
  //
  // Unforced, a geometry place() itself wrote is not a move and is skipped: a
  // window resize has to READ the gap, never rewrite it, or a placement the
  // clamp had to pull back on a short window would forget where the operator
  // had put the panel. A drag forces it, because a drag that the clamp happened
  // to return to the very same pixel is still the operator saying "here".
  function syncGap(force) {
    if (!el || !pos) return;
    var h = el.offsetHeight;
    if (!force && placed && placed.y === pos.y && placed.h === h) return;
    gap = global.innerHeight - (pos.y + h);
    placed = { y: pos.y, h: h };
  }

  // ── build ─────────────────────────────────────────────────────────────────

  function build() {
    el = document.createElement('div');
    el.className = 'pa-panel';
    el.id = 'paPanel';
    el.innerHTML =
      '<div class="pa-head" id="paHead">' +
        // The amplifier white, the radio it follows grey: the name is what the
        // palette is, the radio is a footnote to it. Two spans rather than
        // markup built from the names, which come from the config.
        '<span class="pa-head-name" id="paName"><span id="paNameAmp">PA</span>' +
          '<span class="pa-head-trx" id="paNameTrx"></span></span>' +
        '<button class="pa-close" id="paClose" type="button" title="Close">&#10005;</button>' +
      '</div>' +
      '<div class="pa-body">' +
        // FW, SWR and REV together, because they are the three readings of one
        // transmission. On receive they stay, greyed, until the next one; see
        // noteHeld().
        '<div class="pa-vals pa-vals-idle" id="paVals">' +
          '<span class="pa-val pa-val-fw"><span class="pa-val-k">FW</span>' +
            '<span class="pa-val-v" id="paFw"></span><span class="pa-val-u">W</span></span>' +
          '<span class="pa-val pa-val-swr" id="paSwrBox"><span class="pa-val-k">SWR</span>' +
            '<span class="pa-val-v" id="paSwr"></span></span>' +
          '<span class="pa-val pa-val-rev"><span class="pa-val-k">REV</span>' +
            '<span class="pa-val-v" id="paRef"></span><span class="pa-val-u">W</span></span>' +
        '</div>' +
        '<div class="pa-bars">' +
          '<div class="pa-bar"><i id="paBarFw" class="pa-bar-fw"></i></div>' +
          '<div class="pa-bar"><i id="paBarRef" class="pa-bar-ref"></i></div>' +
        '</div>' +
        // The tuner's divisions of the band the radio is on, with the dot where
        // the radio actually is. Deliberately blind -- no numbers: at 27 px a
        // segment there is no room for any, and what the operator needs from it is
        // "which box am I in and how far to the next one", not a reading. The
        // frequency itself is already on the log's own status bar.
        '<div class="pa-seg-row" id="paSegRow">' +
          '<button class="pa-seg-arrow" id="paSegDown" type="button" data-seg="-1">&#9664;</button>' +
          '<div class="pa-seg-wrap">' +
            '<div class="pa-seg-scale" id="paSegScale">' +
              '<span class="pa-seg-track" id="paSegTrack"></span>' +
              '<i class="pa-seg-dot" id="paSegDot" hidden></i>' +
            '</div>' +
            '<span class="pa-seg-msg" id="paSegMsg" hidden></span>' +
          '</div>' +
          '<button class="pa-seg-arrow" id="paSegUp" type="button" data-seg="1">&#9654;</button>' +
        '</div>' +
        // The lamps in two rows, and the heatsink temperature large beside them:
        // it is the one reading here that changes slowly and matters a lot.
        '<div class="pa-ind">' +
          '<div class="pa-leds" id="paLeds"></div>' +
          '<span class="pa-temp" id="paTemp"></span>' +
        '</div>' +
        '<div class="pa-status">' +
          '<span class="pa-status-l"><span class="pa-dot" id="paDot"></span>' +
            '<span id="paStatusText">&mdash;</span></span>' +
          '<span class="pa-band" id="paBand"></span>' +
          '<span class="pa-rev-tag" id="paRevTag"></span></div>' +
        '<div class="pa-btns">' +
          '<button class="pa-btn st-off" id="paBtnOn"      type="button" data-cmd="on">OFF</button>' +
          '<button class="pa-btn st-off" id="paBtnOperate" type="button" data-cmd="operate">STANDBY</button>' +
          '<button class="pa-btn st-off" id="paBtnFull"    type="button" data-cmd="full">PWR-L</button>' +
          '<button class="pa-btn st-off" id="paBtnTune"    type="button" data-cmd="tune">TUNE</button>' +
        '</div>' +
        '<div class="pa-note" id="paNote" hidden></div>' +
      '</div>';
    document.body.appendChild(el);

    // THE rule: cancel mousedown on everything clickable, so the click still
    // happens but the caret never leaves Call or Exch. Without this the panel
    // would break the log's keyboard flow on every single press.
    // The segment scale is a DIV, not a button, so it would slip past a guard
    // that only looked for buttons -- and a click on it would take the caret out
    // of Call, which is the one thing this panel must never do.
    el.addEventListener('mousedown', function (e) {
      if (e.target.closest('button, .pa-seg-row')) e.preventDefault();
    });

    document.getElementById('paClose').addEventListener('click', function () { setOpen(false); });
    el.addEventListener('click', onButtonClick);
    el.addEventListener('click', onSegClick);
    mountDrag(document.getElementById('paHead'));
    place();
    render();
  }

  // ── dragging ──────────────────────────────────────────────────────────────
  // Pointer events with capture: the panel keeps following the cursor even when
  // it outruns it, and a pointer lost out of the window ends the drag cleanly.

  function mountDrag(handle) {
    var dragging = false, dx = 0, dy = 0;
    handle.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.pa-close')) return;
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
      syncGap(true);
      save();
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // ── commands ──────────────────────────────────────────────────────────────

  function onButtonClick(e) {
    var b = e.target.closest('[data-cmd]');
    if (!b || b.disabled) return;
    var what = b.dataset.cmd;
    // Two guards, and both only ever hold a button while something is actually
    // happening. That distinction matters: a guard that keeps swallowing presses
    // when nothing is happening is indistinguishable from a broken button.
    //
    //   pending  -- a command is out and unanswered. The button reads "…", so
    //               the press is visibly not being ignored. It clears itself on
    //               confirmation, or gives up and says why.
    //   settled  -- the amplifier has just CONFIRMED, within the last SETTLE_MS.
    //               This is the one that stops "it went to OPERATE and straight
    //               back": these are toggle keys, so the impatient second press
    //               of an operator who saw nothing for a moment carries the
    //               opposite value and cleanly undoes what just worked.
    //
    // Nothing holds the button after a command that was NOT confirmed -- if the
    // amplifier is not listening, pressing again is exactly what to try next.
    // With TUNE+ on offer the TUNE key starts a whole tune, and while one runs
    // it is the STOP key. Neither goes through pending/settled: the firmware
    // owns the run and /pa.json says where it is.
    if (what === 'tune' && (tpRunning() || (state && state.tunePlus))) {
      sendTunePlus(tpRunning() ? 0 : 1);
      return;
    }
    if (pending[what]) return;
    if (Date.now() - (settledAt[what] || 0) < SETTLE_MS) return;
    var f = flags();
    var want;
    if (what === 'on')      want = (f & F.ON)      ? 0 : 1;
    else if (what === 'operate') want = (f & F.OPERATE) ? 0 : 1;
    else if (what === 'full')    want = (f & F.FULL)    ? 0 : 1;
    else                          want = 1;              // TUNE is not a toggle
    send(what, want);
  }

  function send(what, value) {
    // Remember the flags we are leaving, so "did it move" is a real comparison
    // and not a guess. TUNE is its own case: the amplifier raises the TUNE bit.
    pending[what] = {
      want: value,
      until: Date.now() + (CONFIRM_MS[what] || 4000),
      from: flags(),
      // Snapshot of the failure counter, so a rise during THIS command's wait
      // means this command is the one that could not be sent.
      txFailedAt: state ? state.txFailed : undefined
    };
    note = '';
    render();
    fetch('/pa/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ what: what, value: value }),
      signal: AbortSignal.timeout(6000)
    }).then(function (r) {
      // The status code has to be read, not just the body. A firmware without
      // this route answers 404 with an HTML page: r.json() then rejects, the
      // old catch turned that into {}, and a command that never existed was
      // reported as accepted. Silence is the one thing a command must not do.
      return r.json().catch(function () { return {}; })
              .then(function (d) { return { ok: r.ok, status: r.status, body: d }; });
    }).then(function (r) {
      if (r.ok && !(r.body && r.body.error)) return;
      delete pending[what];
      var e = r.body && r.body.error;
      note = e === 'pa_absent' ? 'Amplifier not on the network.'
           : e === 'pa_unset'  ? 'No PA NET_ID set in SETUP.'
           : e                 ? 'Refused: ' + e
           : r.status === 404  ? 'This interface has no /pa/cmd — its firmware predates the PA panel.'
           : 'The interface refused the command (HTTP ' + r.status + ').';
      render();
    }).catch(function () {
      delete pending[what];
      note = 'Command did not reach the interface.';
      render();
    });
  }

  function sendTunePlus(value) {
    tpAskedAt = Date.now();
    if (value) note = '';
    render();
    fetch('/pa/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ what: 'tuneplus', value: value }),
      signal: AbortSignal.timeout(6000)
    }).then(function (r) {
      return r.json().catch(function () { return {}; })
              .then(function (d) { return { ok: r.ok, status: r.status, body: d }; });
    }).then(function (r) {
      if (r.ok && !(r.body && r.body.error)) return;
      tpAskedAt = 0;
      var e = r.body && r.body.error;
      note = e === 'pa_off'         ? 'Switch the amplifier ON first.'
           : e === 'trx_tx'         ? 'The radio is transmitting.'
           : e === 'tp_busy'        ? 'A tune is already running.'
           : e === 'tp_unavailable' ? 'TUNE+ is not available: ' + tunePlusWhyText(state && state.tunePlusWhy)
           : e === 'pa_absent'      ? 'Amplifier not on the network.'
           : e                      ? 'Refused: ' + e
           : r.status === 404       ? 'This interface has no /pa/cmd — its firmware predates the PA panel.'
           : 'The interface refused the command (HTTP ' + r.status + ').';
      render();
    }).catch(function () {
      tpAskedAt = 0;
      note = 'Command did not reach the interface.';
      render();
    });
  }

  function tpState() {
    return (state && state.tp && state.tp.st) || 'idle';
  }
  function tpRunning() {
    var st = tpState();
    return st === 'start' || st === 'carrier' || st === 'tuning' || st === 'stopping';
  }

  function tunePlusWhyText(code) {
    return code === 'no_oi3'     ? 'FSK output is not set to an external OI3 (RTTY settings).'
         : code === 'oi3_absent' ? 'the OI3 keyer is not on the network.'
         : code === 'oi3_old'    ? 'the OI3 keyer has not announced remote TUNE — its firmware may be older.'
         : 'unknown reason.';
  }

  // A run that has just finished, and a tuner-off attempt that has just failed,
  // each say so once on the trouble line. Only fresh ones: opening QRPLog
  // must not replay the result of a tune from an hour ago.
  var FRESH_MS = 5000;
  function reapTunePlus() {
    var tp = state && state.tp;
    var st = tpState();
    if (tpAskedAt && (st !== tpLastSt || Date.now() - tpAskedAt > 3000)) tpAskedAt = 0;
    if (st !== tpLastSt) {
      var fresh = tp && typeof tp.ageMs === 'number' && tp.ageMs < FRESH_MS;
      if (st === 'done' && fresh) {
        note = 'Tuned' + (tp.swr ? ' — SWR ' + (tp.swr >= 65535 ? '∞' : (tp.swr / 100).toFixed(1)) : '') + '.';
      } else if (st === 'fail' && fresh) {
        note = 'TUNE+ ' + (tp.why ? tp.why.charAt(0).toLowerCase() + tp.why.slice(1) : 'failed.');
      }
      tpLastSt = st;
    }
    var a = state && state.atuOff;
    if (a && typeof a.ageMs === 'number') {
      var at = Math.round((Date.now() - a.ageMs) / 1000);
      if (atuLastAt !== null && Math.abs(at - atuLastAt) > 1 && a.ageMs < FRESH_MS && !a.ok) {
        note = 'The radio\'s own tuner was NOT switched off: ' + (
          a.why === 'trxnet'  ? 'TRX1 is on TrxNet, which carries frequency only.'
        : a.why === 'noaddr'  ? 'TRX1 has no CI-V address.'
        : 'TRX1 is not connected.');
      }
      if (atuLastAt === null || Math.abs(at - atuLastAt) > 1) atuLastAt = at;
    } else if (atuLastAt === null) {
      atuLastAt = -1;                    // "never tried" seen: the next attempt is new
    }
  }

  // Has the amplifier answered? It confirms by moving its own flags -- there is
  // no acknowledgement on the wire, and no way to tell a daemon without
  // --trxnet-subscribe from one that simply has not got there yet except by
  // waiting and then saying so.
  function reapPending() {
    var f = flags(), now = Date.now(), changed = false;
    for (var what in pending) {
      if (!Object.prototype.hasOwnProperty.call(pending, what)) continue;
      var p = pending[what];
      var bit = what === 'on' ? F.ON : what === 'operate' ? F.OPERATE
              : what === 'full' ? F.FULL : F.TUNE;
      var isSet = !!(f & bit);
      var done = what === 'tune' ? isSet : (isSet === !!p.want);
      if (done) { delete pending[what]; settledAt[what] = now; changed = true; }
      else if (now > p.until) {
        delete pending[what];
        // Two very different faults hid behind one message for three rounds of
        // this: a daemon that refused the command, and an interface that never
        // managed to send it. /pa.json now reports which, so say which.
        note = (state && state.txFailed && p.txFailedAt !== undefined
                && state.txFailed > p.txFailedAt)
          ? 'This interface could not put the command on TrxNet (the amplifier ' +
            'dropped out of its peer table, or the send queue is full).'
          : 'Sent, but the amplifier did not follow. Check that its daemon runs ' +
            'with --trxnet-subscribe and that its --trxnet-allow list names this ' +
            'device.';
        changed = true;
      }
    }
    return changed;
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function flags() {
    return (state && typeof state.flags === 'number') ? state.flags : 0;
  }

  function isStale() {
    if (!state || state.ageMs === null || state.ageMs === undefined) return true;
    return state.ageMs > (state.staleMs || 15000);
  }

  function watts(raw) {
    // W x 10 on the wire; no decimals on screen, by request -- during a contest
    // a fractional watt is noise, and the digit that changes distracts.
    if (raw === null || raw === undefined) return null;
    return Math.round(raw / 10);
  }

  function setBarWidth(id, value, max) {
    var b = document.getElementById(id);
    if (!b) return;
    var pct = (value === null || value === undefined || !max)
      ? 0 : Math.max(0, Math.min(100, value / max * 100));
    b.style.width = pct + '%';
  }

  // A greyed-out button has to say why. Without this the operator is left
  // guessing between "the amplifier is in STANDBY", "the radio is keyed" and
  // "this panel has lost the amplifier" -- three different problems that look
  // identical, and the question the fourth button prompted the first time it
  // went grey for a reason nobody could see.
  function setBtn(id, text, cls, isPending, why, hint) {
    var b = document.getElementById(id);
    if (!b) return;
    b.textContent = text;
    b.className = 'pa-btn ' + cls + (isPending ? ' pa-pending' : '');
    b.disabled = !!why;
    b.title = why || hint || '';
  }

  // The first reason that applies, as a sentence rather than a boolean.
  //
  // Only two things genuinely stop a command, and STALE TELEMETRY IS NOT ONE OF
  // THEM. That was a real trap, and this panel walked straight into it: the
  // daemon publishes only from its STATUS handler, so a switched-off amplifier
  // sends nothing at all -- and an amplifier that is switched off is exactly the
  // one you want to press ON for. Greying the buttons out because no readings
  // are arriving locks the operator out of the state they are trying to leave.
  //
  // Sending blind is safe here because these are not keystrokes: /s-operate 1
  // means "be in OPERATE", and the daemon runs its own compare-send-confirm loop
  // to get there. It even holds a command for ten seconds while no telemetry is
  // flowing, documented for precisely this case -- /s-on and /s-operate sent
  // together, with the amplifier taking about seven seconds to come up.
  //
  // STANDBY is not a reason either: tuning runs at low power, so it is an
  // ordinary place to tune from.
  function whyDisabled(f, live, stale, needsQuietRadio) {
    if (!live)  return 'The amplifier is not on the network.';
    if (needsQuietRadio && radioTx())
      return 'The radio is transmitting — the amplifier locks the RF path while TX is asserted.';
    return '';
  }

  // Stale telemetry does not disable anything, but the operator should know the
  // state on the buttons is the last one heard, not the current one.
  function staleNote(stale) {
    return stale ? ' (last known state — no telemetry right now)' : '';
  }

  // Which fan stage the heatsink has reached, as the web console names it. The
  // thresholds move with CONTEST because the amplifier's own fan schedule does.
  function tempClass(c, f) {
    var on = (f & F.CONTEST) ? PA_FAN_ON.contest : PA_FAN_ON.normal;
    if (c >= PA_TEMP_MAX) return 't-trip';
    if (c >= on[2]) return 't-vhot';
    if (c >= on[1]) return 't-hot';
    if (c >= on[0]) return 't-warm';
    return 't-cool';
  }

  // The power row outlives the transmission: the last readings stay on screen,
  // greyed, until the next one. A row that emptied itself two seconds after
  // every over read as the panel dropping out, right above the bars -- and
  // "what did that last over do" is exactly the question asked on receive.
  //
  // Noted on every poll, open or not, so a panel opened after an over still
  // has it. SWR only ever from a sample that carried one: the amplifier
  // answering 0 on the last sample of an over must not wipe the reading it gave
  // a moment earlier -- nor may one over's SWR survive into the next, so it
  // starts afresh when a new one begins.
  function noteHeld() {
    var fw = watts(state ? state.fwdPk : null);
    var keyed = !!fw;
    if (keyed) {
      var rf = watts(state.refPk), swr = state.swr;
      if (!heldKeyed || !held) held = { fw: fw, rf: rf, swr: 0 };
      held.fw = fw;
      held.rf = rf;
      if (swr) held.swr = swr;
    }
    heldKeyed = keyed;
  }

  function render() {
    if (!el) return;
    var f = flags(), stale = isStale(), live = !!(state && state.present);

    el.classList.toggle('pa-stale', stale);
    // PA.01/IC-7610: the amplifier, and the radio whose /hz it follows.
    document.getElementById('paNameAmp').textContent =
      (state && state.name) ? state.name.toUpperCase() : 'PA';
    document.getElementById('paNameTrx').textContent =
      (state && state.trx1) ? '/' + state.trx1 : '';

    var fw = watts(state ? state.fwdPk : null);
    var rf = watts(state ? state.refPk : null);

    // Keyed or not is forward power alone. The daemon keeps publishing on
    // receive, so "receiving" arrives as FW 0, not as null, and "FW 0 W REV 0 W"
    // through every RX period would be noise; REV 0 W while keyed, though, is
    // the good news and shows. Not keyed, the row shows the last over's readings
    // in dark grey (see noteHeld), and is blank only before the first over this
    // page has seen -- blank, not removed, so the panel keeps its height.
    var keyed = !!fw;
    var shownVals = keyed ? { fw: fw, rf: rf, swr: state.swr } : held;
    var valsEl = document.getElementById('paVals');
    valsEl.classList.toggle('pa-vals-idle', !shownVals);
    valsEl.classList.toggle('pa-vals-held', !keyed && !!shownVals);
    document.getElementById('paFw').textContent  = shownVals ? shownVals.fw : '';
    document.getElementById('paRef').textContent =
      (shownVals && shownVals.rf !== null) ? shownVals.rf : '';
    valsEl.title = (!keyed && shownVals) ? 'The last transmission' : '';

    // Two bars, no scale. Full scale follows the mode the amplifier is actually
    // in -- 1200 W in FULL, 600 W in HALF -- because a fixed 1200 W scale would
    // make a full-power HALF transmission look like half a job. In STANDBY the
    // numbers are the exciter's, so the range drops to its 100 W.
    //
    // They carry the peak, the same figure as the digits, not the instantaneous
    // reading the full console's bars use. At two samples a second the
    // instantaneous value is mostly the gaps between syllables: the bar would
    // sit near zero through an entire SSB over. The console can afford it
    // because it sees every packet; this cannot.
    var fwMax = !(f & F.OPERATE) ? 100 : (f & F.FULL) ? 1200 : 600;
    setBarWidth('paBarFw',  fw, fwMax);
    setBarWidth('paBarRef', rf, PA_REF_MAX);

    renderSegScale();

    // SWR: 0 means the amplifier did not answer, 65535 means infinite. Neither
    // is a number to print; the first leaves the middle of the row empty.
    var swr = shownVals ? shownVals.swr : null;
    var swrKnown = !!swr;
    document.getElementById('paSwrBox').classList.toggle('pa-val-none', !swrKnown);
    document.getElementById('paSwr').textContent = !swrKnown ? ''
      : swr >= 65535 ? '∞' : (swr / 100).toFixed(1);

    // Unknown is blank, not a dash: the status line beside it already says why
    // (OFFLINE, NO DATA), and while telemetry is merely stale the last band
    // stays, greyed.
    var bandEl = document.getElementById('paBand');
    var band = state ? state.band : null;
    bandEl.textContent = (band === null || band === undefined || band === 0)
      ? '' : band + ' m';
    bandEl.classList.toggle('pa-band-mismatch', bandMismatch(band));
    bandEl.title = bandMismatch(band)
      ? 'The amplifier is on a different band than the radio' : '';

    // Beside the lamps, in its own column: a value that runs 9 °C to 105 °C
    // must not share a row with them, or that row would reflow as it changed.
    // Null rather than 0 whenever no /pa-temp has arrived -- a daemon older than
    // 2026-09-08 publishes the other five topics and never this one, so "no
    // reading" has to be distinguishable from "cold". No reading is blank; the
    // tooltip says why.
    var tempEl = document.getElementById('paTemp');
    var tempC = (state && state.temp !== null && state.temp !== undefined)
      ? state.temp / 100 : null;
    tempEl.innerHTML = tempC === null ? ''
      : (Math.round(tempC) + '<span class="pa-temp-u"> °C</span>');
    tempEl.className = 'pa-temp' + (tempC === null ? '' : ' ' + tempClass(tempC, f));
    tempEl.title = tempC === null
      ? 'The amplifier is not reporting a temperature'
      : ('Fan steps at ' + ((f & F.CONTEST) ? PA_FAN_ON.contest : PA_FAN_ON.normal)
         .join(' / ') + ' °C, protection at ' + PA_TEMP_MAX + ' °C');

    // Every flag TrxNet carries, lit or dark. The dark ones stay in place so
    // the rows never reflow and the eye learns where to look. What is happening
    // on the first row, the modes it is in on the second.
    var leds = [[
      ['ALARM',   f & F.ALARM,   'r'],
      ['TX',      f & F.TX,      'r'],
      ['TUNE',    f & F.TUNE,    'y']
    ], [
      ['CONTEST', f & F.CONTEST, 'c'],
      ['BEEP',    f & F.BEEP,    'c']
    ]];
    document.getElementById('paLeds').innerHTML = leds.map(function (row) {
      return '<div class="pa-led-row">' + row.map(function (l) {
        return '<span class="pa-led' + (l[1] ? ' on ' + l[2] : '') + '">' + l[0] + '</span>';
      }).join('') + '</div>';
    }).join('');

    // The three layers that are easy to confuse, told apart in one line: is the
    // daemon reachable, does it have the amplifier on its serial port, and is
    // the amplifier switched on.
    var dot = document.getElementById('paDot'), txt = document.getElementById('paStatusText');
    var cls = 'pa-dot', label;
    if (!live)                { label = 'OFFLINE'; }
    else if (stale)           { label = 'NO DATA' + (state && state.ageMs ? ' ' + Math.round(state.ageMs / 1000) + ' s' : ''); }
    else if (!(f & F.LINK))   { label = 'NO LINK'; cls += ' warn'; }
    else if (!(f & F.ON))     { label = 'OFF';     cls += ' warn'; }
    else                      { label = 'ON';      cls += ' ok'; }
    dot.className = cls;
    txt.textContent = label;
    document.getElementById('paRevTag').textContent =
      (live && !stale) ? ('REV ' + ((f & F.REV2) ? '2.0' : '1.0')) : '';

    var basicWhy = whyDisabled(f, live, stale, false);
    var hint = basicWhy || staleNote(stale).replace(/^ \(|\)$/g, '');
    setBtn('paBtnOn', pending.on ? '…' : ((f & F.ON) ? 'ON' : 'OFF'),
           (f & F.ON) ? 'st-on' : 'st-off', !!pending.on, basicWhy, hint);
    setBtn('paBtnOperate', pending.operate ? '…' : ((f & F.OPERATE) ? 'OPERATE' : 'STANDBY'),
           (f & F.OPERATE) ? 'st-op' : 'st-off', !!pending.operate, basicWhy, hint);
    setBtn('paBtnFull', pending.full ? '…' : ((f & F.FULL) ? 'PWR-H' : 'PWR-L'),
           (f & F.FULL) ? 'st-hi' : 'st-off', !!pending.full, basicWhy, hint);
    // TUNE works in STANDBY -- tuning runs at low power. The one state where it
    // genuinely cannot act is with the radio keying: the amplifier locks the
    // whole RF path while TX is asserted (measured on the bench, flags stuck at
    // 0x84 with no drive; only OPERATE / MODE / OFF / DISPLAY answered).
    //
    // TUNE+ runs the whole tune (carrier from OI3, the amplifier's TUNE, the
    // radio put back) and while it runs this is its STOP key -- never greyed
    // out then, whatever else is going on: the radio IS transmitting, on
    // purpose, and losing sight of the amplifier is a reason to stop, not to
    // take the stop away.
    if (tpRunning()) {
      var st = tpState();
      setBtn('paBtnTune', tpAskedAt ? '…' : st === 'carrier' ? 'CARRIER'
             : st === 'tuning' ? 'TUNING' : '…',
             'st-tp', !!tpAskedAt || st === 'stopping', '',
             'TUNE+ running — click to stop');
    } else if (state && state.tunePlus) {
      var tpWhy = whyDisabled(f, live, stale, true) ||
        (((f & F.ON) && (f & F.LINK)) ? '' : 'Switch the amplifier ON first.');
      setBtn('paBtnTune', tpAskedAt ? '…' : 'TUNE+',
             (f & F.TUNE) ? 'st-on' : 'st-off', !!tpAskedAt, tpWhy,
             hint || 'Full tune: low-power CW carrier from OI3, the amplifier\'s TUNE, ' +
                     'then the radio back to its mode and power');
    } else {
      var tpNo = state && state.tunePlusWhy;
      setBtn('paBtnTune', pending.tune ? '…' : 'TUNE',
             (f & F.TUNE) ? 'st-on' : 'st-off', !!pending.tune,
             whyDisabled(f, live, stale, true),
             hint || ((tpNo && tpNo !== 'no_oi3') ? 'TUNE+ unavailable: ' + tunePlusWhyText(tpNo) : ''));
    }

    var noteEl = document.getElementById('paNote');
    noteEl.textContent = note;
    noteEl.hidden = !note;

    // The trouble line appearing or going makes the panel taller or shorter, and
    // it grows downward from wherever it stands. Re-derive the anchor so the gap
    // still describes the bottom edge the operator can actually see -- otherwise
    // the next window resize would snap the panel by the height of one line.
    // Deliberately syncGap() and not place(): render() runs on every poll, and
    // re-placing here would fight a drag in progress.
    syncGap();
  }

  // window.LogRadio is log.js's deliberate, narrow export -- `const app` at the
  // top level of a classic script never lands on window, so reaching for
  // window.app here would silently read undefined and this check would be dead
  // while looking alive.
  function radioHz() {
    return (global.LogRadio && global.LogRadio.frequency()) || 0;
  }
  function radioTx() {
    return !!(global.LogRadio && global.LogRadio.tx());
  }

  function bandMismatch(band) {
    if (!band || !BAND_HZ[band]) return false;
    var hz = radioHz();
    if (!hz) return false;
    var r = BAND_HZ[band];
    return hz < r[0] || hz > r[1];
  }

  // ── the tuning-segment scale ──────────────────────────────────────────────
  //
  // The tuner holds one setting per sub-band, so tuning the amplifier means
  // tuning it in each one, and the only sensible place to do that is the CENTRE
  // of a segment: from there the stored setting covers the whole of it. None of
  // that is visible anywhere -- the amplifier's own display shows a frequency,
  // not which division of the band it falls in, so the operator has no way to
  // know which segment they are in, where it ends, or how to get to its middle.
  // This row is that missing picture, and its arrows are the shortest way to the
  // place worth pressing TUNE.

  // Where a frequency falls in the tuner's divisions, or null when it falls
  // outside all of them.
  //
  // Nearest centre rather than computed edges -- that handles 17 m (steps 50 then
  // 40) and 12 m (72 then 75) with no special case, because between two centres
  // the nearer one wins by definition. This is the daemon's own sub_band_for()
  // logic, and the two being the same matters: the daemon is what actually moves
  // the amplifier, so a scale that divided the band differently would point at
  // the wrong thing.
  //
  // Only the outer edges need a test, and they need it badly. Answering with the
  // nearest centre regardless would put 60 m at the top of 80 m and 2 m at the
  // top of 6 m -- bands the amplifier does not have, drawn as if it did.
  function segLocate(hz) {
    var khz = (Number(hz) || 0) / 1000;
    if (!khz) return null;
    var bestBand = null, bestIdx = -1, bestGap = Infinity, b, list, i, gap, last;
    for (b in PA_SUB_KHZ) {
      list = PA_SUB_KHZ[b];
      for (i = 0; i < list.length; i++) {
        gap = Math.abs(list[i] - khz);
        if (gap < bestGap) { bestGap = gap; bestBand = b; bestIdx = i; }
      }
    }
    if (bestIdx < 0) return null;
    list = PA_SUB_KHZ[bestBand];
    last = list.length - 1;
    if (last > 0) {
      if (bestIdx === 0 && khz < list[0] &&
          list[0] - khz > (list[1] - list[0]) / 2) return null;
      if (bestIdx === last && khz > list[last] &&
          khz - list[last] > (list[last] - list[last - 1]) / 2) return null;
    }
    return { band: Number(bestBand), list: list, idx: bestIdx };
  }

  // The lower edge of segment i in kHz; i === list.length gives the top edge of
  // the last one. Half-way between two centres IS the edge, because that is where
  // the nearest-centre rule flips -- so the irregular bands come out right
  // without knowing they are irregular.
  function segEdge(list, i) {
    var n = list.length;
    if (n < 2) return i <= 0 ? list[0] - 0.5 : list[0] + 0.5;
    if (i <= 0) return list[0] - (list[1] - list[0]) / 2;
    if (i >= n)  return list[n - 1] + (list[n - 1] - list[n - 2]) / 2;
    return (list[i - 1] + list[i]) / 2;
  }

  // Which run of segments to draw. Paged rather than scrolled: the window holds
  // still while the operator tunes about inside it and moves a whole page when
  // the dot leaves, so the picture never crawls under a hand on the VFO.
  //
  // The min() keeps the last page full. On 80 m -- 29 segments -- the last page
  // is 23..28 and not 24..28: a page showing one lonely segment would say nothing
  // at all about where in the band it sits.
  function segWindow(idx, n) {
    if (n <= PA_SEG_PAGE) return { start: 0, end: n };
    var start = Math.min(Math.floor(idx / PA_SEG_PAGE) * PA_SEG_PAGE, n - PA_SEG_PAGE);
    return { start: start, end: start + PA_SEG_PAGE };
  }

  // The next segment centre below (dir < 0) or above (dir > 0) a frequency, or
  // null when this band has none left that way.
  //
  // STRICTLY below/above, and that is the whole trick: standing 2 kHz off a
  // centre, the arrow pointing at it lands ON it instead of skipping past to the
  // next one -- which is what an operator about to press TUNE actually wants.
  // Standing exactly on a centre, it moves one segment along.
  function segNeighbour(list, khz, dir) {
    var i;
    if (dir < 0) {
      for (i = list.length - 1; i >= 0; i--) if (list[i] < khz) return list[i];
    } else {
      for (i = 0; i < list.length; i++) if (list[i] > khz) return list[i];
    }
    return null;
  }

  // A greyed arrow has to say why, the same rule the command buttons follow: one
  // that just stops working is indistinguishable from a broken one.
  function setSegArrow(id, targetKhz, why) {
    var b = document.getElementById(id);
    if (!b) return;
    b.disabled = !!why || targetKhz === null;
    b.title = why ? why
            : targetKhz === null ? 'No further tuning segment on this band'
            : ('Tune to ' + Math.round(targetKhz) + ' kHz — the centre of the next segment');
  }

  function renderSegScale() {
    var track = document.getElementById('paSegTrack');
    var dot   = document.getElementById('paSegDot');
    if (!track || !dot) return;

    var hz = radioHz();
    var at = segLocate(hz);
    // The row never goes away and never changes height, the same discipline as
    // the LED row and the numbers above it: the panel floats over a contest log,
    // and something that appears and disappears would move everything under it.
    // An empty scale with dead arrows is the honest version of "nothing to show".
    var why = !hz ? 'The radio is not connected, so there is no frequency to place'
            : !at ? 'The amplifier has no tuning segments on this band'
            : '';
    // An empty scale says nothing about WHY it is empty, and the two reasons
    // point at different things to fix -- the radio, or the band -- so it says.
    var msg = document.getElementById('paSegMsg');
    if (msg) {
      msg.textContent = !hz ? 'NO FREQ' : !at ? 'NO SEGMENTS' : '';
      msg.hidden = !!(hz && at);
      msg.title = why;
    }
    if (why) {
      if (segKey) { track.innerHTML = ''; segKey = ''; segView = null; }
      dot.hidden = true;
      setSegArrow('paSegDown', null, why);
      setSegArrow('paSegUp',   null, why);
      return;
    }

    var win  = segWindow(at.idx, at.list.length);
    var lo   = segEdge(at.list, win.start);
    var hi   = segEdge(at.list, win.end);
    var span = hi - lo;
    var key  = at.band + ':' + win.start + ':' + win.end;

    // Rebuild the dividers only when the window has actually moved. render() runs
    // twice a second for the whole contest; rewriting six elements each time
    // would be six thousand pointless rebuilds an hour, and would also kill the
    // dot's own transition every time it landed mid-move.
    if (key !== segKey) {
      var html = '', i, a, z;
      for (i = win.start; i < win.end; i++) {
        a = segEdge(at.list, i);
        z = segEdge(at.list, i + 1);
        html += '<i class="pa-seg" data-centre="' + at.list[i] +
                '" title="' + at.list[i] + ' kHz" style="left:' +
                ((a - lo) / span * 100).toFixed(3) + '%;width:' +
                ((z - a) / span * 100).toFixed(3) + '%"></i>';
      }
      track.innerHTML = html;
      segKey = key;
    }
    segView = { list: at.list, lo: lo, hi: hi };

    // The segment the dot is in gets filled. Without it the operator has to judge
    // which side of a divider a 4 px dot is sitting on, which at 27 px a segment
    // is exactly the decision this row exists to save them.
    var segs = track.children, j;
    for (j = 0; j < segs.length; j++) {
      segs[j].classList.toggle('pa-seg-on', win.start + j === at.idx);
    }

    var khz = hz / 1000;
    dot.hidden = false;
    dot.style.left =
      Math.max(0, Math.min(100, (khz - lo) / span * 100)).toFixed(3) + '%';

    // Retuning the radio out from under a keyed amplifier is precisely the
    // expensive mistake this panel is here to prevent, so TX kills both arrows --
    // the same reason TUNE is held while the radio is transmitting.
    var txWhy = radioTx() ? 'The radio is transmitting' : '';
    setSegArrow('paSegDown', segNeighbour(at.list, khz, -1), txWhy);
    setSegArrow('paSegUp',   segNeighbour(at.list, khz,  1), txWhy);
  }

  // Two ways to move, and the click is the one that makes a 29-segment band
  // usable: crossing 80 m on the arrows alone would be 28 presses.
  //
  // Deliberately NOT part of onButtonClick. That one belongs to the amplifier's
  // commands and to their pending/settled machinery, which exists because the
  // daemon never answers. A retune needs none of it: /state comes back with the
  // new frequency half a second later and the dot moves, which is the
  // confirmation.
  function onSegClick(e) {
    var arrow = e.target.closest('.pa-seg-arrow');
    var seg   = e.target.closest('.pa-seg');
    var khz   = null;

    if (arrow) {
      if (arrow.disabled || !segView) return;
      khz = segNeighbour(segView.list, radioHz() / 1000, Number(arrow.dataset.seg));
    } else if (seg) {
      if (radioTx() || !segView) return;
      khz = Number(seg.dataset.centre);
    }
    if (!khz) return;
    if (global.LogRadio && global.LogRadio.tuneTo) {
      global.LogRadio.tuneTo(Math.round(khz * 1000), 'pa-seg');
    }
  }

  // ── the button in the bottom bar ──────────────────────────────────────────

  function renderButton() {
    if (!btn) return;
    var present = !!(state && state.present);
    // The icon follows the peer table, not the freshness of telemetry. It is
    // stable that way: a peer lives 95 s past its last announce, so a WiFi
    // hiccup does not make a button blink in and out during a contest.
    btn.hidden = !present;
    btn.classList.toggle('pa-live', present && !isStale());
  }

  function setOpen(v) {
    open = !!v;
    if (open && !el) build();
    if (el) el.style.display = open ? '' : 'none';
    if (open) { place(); render(); }
    save();
    schedule(0);
  }

  // ── polling ───────────────────────────────────────────────────────────────

  function schedule(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }

  function poll() {
    // A timeout is not optional here. QRPLog's own /state poll has none, and the
    // reason to have one is written up in setup-spine.js: a hung fetch parks one
    // of the browser's ~6 connections per origin until the page starves.
    fetch('/pa.json', { cache: 'no-store', signal: AbortSignal.timeout(4000) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state = d;
        noteHeld();
        reapPending();
        reapTunePlus();
        renderButton();
        if (open) render();
      })
      .catch(function () {
        // The interface itself is unreachable. Say nothing new: the log's own
        // connection indicator already reports that, and two alarms for one
        // fault is one alarm too many.
        if (state) { state.present = false; state.ageMs = null; }
        renderButton();
        if (open) render();
      })
      .finally(function () { schedule(open ? POLL_OPEN_MS : POLL_CLOSED_MS); });
  }

  // ── mount ─────────────────────────────────────────────────────────────────

  function mount() {
    btn = document.getElementById('btnPa');
    if (!btn) return;
    load();
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function () { setOpen(!open); });
    global.addEventListener('resize', function () {
      if (!el || !open) return;
      place();                     // from the bottom gap, which stays as it was
      save();
    });
    if (open) { build(); place(); }
    poll();
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', mount);
  else
    mount();

  // Exposed for the smoke harness, which drives the panel rather than reading
  // its source: it needs to open it and inject a /pa.json without a real one.
  global.PaPanel = {
    setOpen: setOpen,
    isOpen: function () { return open; },
    apply: function (d) { state = d; noteHeld(); reapPending(); reapTunePlus(); renderButton(); if (open) render(); },
    getState: function () { return state; }
  };

}(window));
