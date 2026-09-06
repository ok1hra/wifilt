'use strict';
/**
 * pa-panel.js — the linear amplifier, on the contest log
 *
 * A small movable palette showing everything TrxNet carries about an EXPERT
 * 1K-FA (five topics, nothing more is on the wire) and offering the four
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

  var state   = null;    // last /pa.json
  var open    = false;
  var pos     = null;    // {x, y}, null until placed
  var el      = null;    // the panel, built on first open
  var btn     = null;    // the PA button in the bottom bar
  var pollTimer = null;
  var pending   = {};    // what -> {want, until, from}
  var settledAt = {};    // what -> when the amplifier last CONFIRMED it
  var note    = '';      // one line of trouble, shown under the buttons

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
      }
    } catch (_) {}
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        open: open, x: pos ? pos.x : null, y: pos ? pos.y : null
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

  function place() {
    if (!el) return;
    if (!pos) pos = anchorPos();
    pos = clamp(pos);
    el.style.left = pos.x + 'px';
    el.style.top  = pos.y + 'px';
  }

  // ── build ─────────────────────────────────────────────────────────────────

  function build() {
    el = document.createElement('div');
    el.className = 'pa-panel';
    el.id = 'paPanel';
    el.innerHTML =
      '<div class="pa-head" id="paHead">' +
        '<span class="pa-head-name" id="paName">PA</span>' +
        '<button class="pa-close" id="paClose" type="button" title="Close">&#10005;</button>' +
      '</div>' +
      '<div class="pa-body">' +
        '<div class="pa-vals">' +
          '<span class="pa-val pa-val-fw"><span class="pa-val-k">FW</span>' +
            '<span class="pa-val-v" id="paFw">&mdash;</span><span class="pa-val-u">W</span></span>' +
          '<span class="pa-val pa-val-rev"><span class="pa-val-k">REV</span>' +
            '<span class="pa-val-v" id="paRef">&mdash;</span><span class="pa-val-u">W</span></span>' +
        '</div>' +
        '<div class="pa-bars">' +
          '<div class="pa-bar"><i id="paBarFw" class="pa-bar-fw"></i></div>' +
          '<div class="pa-bar"><i id="paBarRef" class="pa-bar-ref"></i></div>' +
        '</div>' +
        '<div class="pa-sub">' +
          '<span class="pa-swr" id="paSwr">SWR &mdash;</span>' +
          '<span class="pa-band" id="paBand">&mdash;</span>' +
        '</div>' +
        '<div class="pa-leds" id="paLeds"></div>' +
        '<div class="pa-status"><span class="pa-dot" id="paDot"></span>' +
          '<span id="paStatusText">&mdash;</span>' +
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
    el.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) e.preventDefault();
    });

    document.getElementById('paClose').addEventListener('click', function () { setOpen(false); });
    el.addEventListener('click', onButtonClick);
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

  function render() {
    if (!el) return;
    var f = flags(), stale = isStale(), live = !!(state && state.present);

    el.classList.toggle('pa-stale', stale);
    document.getElementById('paName').textContent =
      (state && state.name) ? state.name.toUpperCase() : 'PA';

    var fw = watts(state ? state.fwdPk : null);
    var rf = watts(state ? state.refPk : null);
    document.getElementById('paFw').textContent  = fw === null ? '—' : fw;
    document.getElementById('paRef').textContent = rf === null ? '—' : rf;

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

    // SWR: 0 means the amplifier did not answer, 65535 means infinite. Neither
    // is a number to print.
    var swrEl = document.getElementById('paSwr'), swr = state ? state.swr : null;
    swrEl.textContent = 'SWR ' + (
      (swr === null || swr === undefined || swr === 0) ? '—'
      : swr >= 65535 ? '∞'
      : (swr / 100).toFixed(1));

    var bandEl = document.getElementById('paBand');
    var band = state ? state.band : null;
    bandEl.textContent = (band === null || band === undefined || band === 0)
      ? '—' : band + ' m';
    bandEl.classList.toggle('pa-band-mismatch', bandMismatch(band));
    bandEl.title = bandMismatch(band)
      ? 'The amplifier is on a different band than the radio' : '';

    // Every flag TrxNet carries, lit or dark. The dark ones stay in place so
    // the row never reflows and the eye learns where to look.
    var leds = [
      ['ALARM',   f & F.ALARM,   'r'],
      ['TX',      f & F.TX,      'r'],
      ['TUNE',    f & F.TUNE,    'y'],
      ['CONTEST', f & F.CONTEST, 'c'],
      ['BEEP',    f & F.BEEP,    'c']
    ];
    document.getElementById('paLeds').innerHTML = leds.map(function (l) {
      return '<span class="pa-led' + (l[1] ? ' on ' + l[2] : '') + '">' + l[0] + '</span>';
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
    setBtn('paBtnTune', pending.tune ? '…' : 'TUNE',
           (f & F.TUNE) ? 'st-on' : 'st-off', !!pending.tune,
           whyDisabled(f, live, stale, true), hint);

    var noteEl = document.getElementById('paNote');
    noteEl.textContent = note;
    noteEl.hidden = !note;
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
        reapPending();
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
      pos = clamp(pos);
      place();
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
    apply: function (d) { state = d; reapPending(); renderButton(); if (open) render(); },
    getState: function () { return state; }
  };

}(window));
