// ── QRPlog ⇄ DX cluster split view ───────────────────────────────────────────
//
// WHY IT EXISTS AT ALL. Clicking a spot's frequency in the DXC pop-up hands
// QRPlog the callsign and puts the caret in Call -- and then the operator's
// Enter goes to the POP-UP, because that is the window the click left focused.
// The word arrives, the cursor does not. log.js has done its half correctly
// all along (insertWordIntoLog() calls target.focus() AND setSelectionRange());
// what it cannot do is move OS window focus, and calling window.opener.focus()
// from the pop-up would fix the keyboard by raising the log OVER the cluster --
// hiding the spot list exactly when it is being read.
//
// This is bit-for-bit the defect that retired the RTTY pop-up on 2026-09-07,
// and it has the same answer, recorded in log-rtty-panel.js:11-27: in one
// document the problem does not exist. So the cluster moves into the log's own
// document as the left half of a draggable split, and dxc.html hands the
// callsign straight to parent.LogRadio -- synchronously, in the same task as
// the click, so the caret lands in Call and the next keystroke goes there.
//
// WHY AN IFRAME and not a port of the DXC table into this page: dxc.html is
// 45 KB of table, five filters, a column chooser, a histogram, a raw view and a
// cluster protocol parser. Copying it here would mean maintaining two DXC
// implementations that drift. Same-origin iframes are just browsing contexts:
// parent.LogRadio works, and each instance keeps its own filters.
//
// WHAT THIS FILE DOES NOT DO: share the cluster socket. The firmware holds
// exactly one DxcWsClient (wifilt.ino:654) and a second connection evicts the
// first (:9259) while forcing a fresh telnet login (:9271) -- two instances
// reconnect-storm each other, a documented field incident. dxc.html's own
// leader/follower layer solves that; this file only mounts and sizes the pane.

(function (global) {
  'use strict';

  var STORE_KEY  = 'wifilt-log-split';
  var MIN_LEFT   = 280;   // the DXC table with its narrow columns
  // 615px measured: the button bar (RUN + three TRX + ? + LOG + MACROS +
  // BACKUP) is what runs out of room first, once .log-split-on lets the input
  // row wrap. Rounded up for a little headroom on other platforms' fonts.
  var MIN_RIGHT  = 630;
  // Has to be at least MIN_LEFT + gutter + MIN_RIGHT, or the clamp would have
  // to sacrifice one half -- and the log losing its buttons is not a trade
  // worth making. 920 still admits a 1024-wide tablet in landscape.
  var MIN_VIEW   = 920;
  // Only ever used to pick a first width, when nothing is stored yet.
  var FIRST_FRAC = 0.42;

  var split     = document.getElementById('logSplit');
  var left      = document.getElementById('logSplitLeft');
  var gutter    = document.getElementById('logSplitGutter');
  var right     = document.getElementById('logSplitRight');
  var tabDxc    = document.getElementById('tabDxc');
  var tabs      = document.querySelector('.tabs');
  var statusBox = document.getElementById('topbarFw');   // GPS | dBm | FW

  var open     = false;
  // The width the operator asked for, in PIXELS, unclamped -- see the sizing
  // block below for why pixels and why unclamped.
  var wantLeft = 0;                 // 0 = nothing chosen yet
  var firstFrac = FIRST_FRAC;       // used only until wantLeft is known
  var frame    = null;

  // ── Stored geometry ────────────────────────────────────────────────────────
  //
  // Same shape and the same reasoning as the RTTY/PA palettes
  // (log-rtty-panel.js:86-105): the operator sets a proportion once and F5 on
  // the log page is frequent, so losing it every reload would be a nuisance.
  // `open` is stored even while a narrow viewport refuses to honour it -- see
  // applyViewport() below.

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
      open = !!s.open;
      if (typeof s.leftPx === 'number' && s.leftPx > 0) wantLeft = Math.round(s.leftPx);
      // A width stored by the first version of this file, as a fraction. Read
      // once so an operator who had already sized the pane does not find it
      // reset, then written back as pixels on the next save.
      else if (typeof s.ratio === 'number' && s.ratio > 0 && s.ratio < 1) firstFrac = s.ratio;
    } catch (_e) {}
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ open: open, leftPx: wantLeft }));
    } catch (_e) {}
  }

  // ── Sizing ────────────────────────────────────────────────────────────────

  function wide() {
    return global.innerWidth >= MIN_VIEW;
  }

  // The pane's width is a PIXEL width, not a proportion. The operator sizes it
  // to fit the DXC columns they want to read -- kHz, DX, dB -- and those are a
  // fixed number of characters wide, so widening the browser window must not
  // widen the pane. The log is the elastic half: it takes whatever the window
  // gains or loses. (Storing a fraction did the opposite, which is what this
  // replaced.)
  function clampLeft(px) {
    var total = split.clientWidth - gutter.offsetWidth;
    if (total <= 0) return Math.round(px);
    var max = total - MIN_RIGHT;
    if (max < MIN_LEFT) max = MIN_LEFT;      // cannot satisfy both: left wins
    return Math.round(Math.min(Math.max(px, MIN_LEFT), max));
  }

  // Note what this does NOT do: it never writes the clamped value back into
  // wantLeft. Shrinking the window far enough makes the log claim space from
  // the pane, and widening it again has to give that space back -- which only
  // works while the operator's own choice is still remembered underneath.
  function applyWidth() {
    if (!open) return;
    var total = split.clientWidth - gutter.offsetWidth;
    if (!wantLeft && total > 0) wantLeft = Math.round(total * firstFrac);
    left.style.flexBasis = clampLeft(wantLeft) + 'px';
  }

  // ── Topbar status block ───────────────────────────────────────────────────
  //
  // GPS, signal strength, the OFFLINE badge and the firmware version share the
  // tab row, and that row does not wrap -- a second line of topbar comes
  // straight out of the journal's height. The first version of the split
  // simply hid the block whenever the split was open, which took the OFFLINE
  // warning and the GPS panel away from the operator even on a 1920 screen
  // where everything fitted with room to spare.
  //
  // What replaces it is measured rather than written down here, because none
  // of the terms are constant: the tab labels come from the page, the block's
  // own width follows what the radio reports (GPS chip or not, `⚠ OFFLINE`
  // instead of dBm, an available-update arrow behind the version), and the
  // width they have to fit into is whatever the operator left the divider at.
  // log.css:248 documents the two classes and the order they come in.

  function tabsOverflow() {
    // +1: sub-pixel layout means a row that fits exactly can measure a
    // fraction wider than its box.
    return tabs.scrollWidth > tabs.clientWidth + 1;
  }

  function applyTopbar() {
    if (!tabs) return;
    var cls = document.body.classList;
    // Measure with the whole block shown, always. "Does it fit" has one
    // answer; "does it fit given what is already hidden" has two, and asking
    // the second one makes the row flap between them.
    cls.remove('log-split-fw-off');
    cls.remove('log-split-status-off');
    if (!(open && wide()) || !tabsOverflow()) return;
    cls.add('log-split-fw-off');
    if (!tabsOverflow()) return;
    // The version alone was not enough; nothing here is worth a clipped tab.
    cls.remove('log-split-fw-off');
    cls.add('log-split-status-off');
  }

  // ── Mount / unmount ───────────────────────────────────────────────────────
  //
  // close() REMOVES the iframe rather than hiding it. A hidden-but-alive frame
  // would keep holding the single cluster WebSocket and stay leader, so an
  // external DXC window could never take over from a closed panel. The cost is
  // that the panel's spot backlog dies with it -- exactly what happens today
  // when the DXC window is closed, and the leader (if any) re-seeds the next
  // panel from its own rows[] anyway.

  function mount() {
    if (frame) return;
    frame = document.createElement('iframe');
    frame.id    = 'logDxcFrame';
    frame.title = 'DX cluster';
    frame.src   = '/dxc.html?embed=1';
    left.appendChild(frame);
  }

  function unmount() {
    if (!frame) return;
    frame.remove();
    frame = null;
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  function paint() {
    var on = open && wide();
    left.hidden   = !on;
    gutter.hidden = !on;
    document.body.classList.toggle('log-split-on', on);
    if (tabDxc) tabDxc.classList.toggle('tab-split-on', on);
    if (on) { mount(); applyWidth(); } else { unmount(); left.style.flexBasis = ''; }
    applyTopbar();
  }

  function doOpen() {
    if (!wide()) return false;
    open = true;
    save();
    paint();
    return true;
  }

  function doClose() {
    open = false;
    save();
    paint();
    return true;
  }

  // Returns TRUE when the split handled the click, FALSE to let the caller's
  // window.open() fallback run -- that is the contract log.html's onclick
  // relies on, and it is what makes a narrow viewport fall back to the pop-up
  // every other page still uses.
  function toggle(event) {
    if (event && event.preventDefault) event.preventDefault();
    if (open) return doClose();
    return doOpen();
  }

  // A viewport that stops being wide enough collapses the split but KEEPS
  // `open` stored, so rotating a tablet back to landscape brings it back
  // instead of making the operator re-open it.
  function applyViewport() {
    paint();
  }

  // ── Gutter drag ───────────────────────────────────────────────────────────
  //
  // pointerdown + setPointerCapture, the same mountDrag() shape the RTTY and
  // PA palettes use (log-rtty-panel.js:143-167). The capture is not optional
  // here: without it every pointermove that crosses the iframe is delivered to
  // the FRAME's document, not this one, and the drag dies the moment the
  // pointer enters the pane being resized. preventDefault() keeps the drag
  // from selecting text and from moving focus out of Call.

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    try { gutter.setPointerCapture(e.pointerId); } catch (_e) {}
    document.body.classList.add('log-split-dragging');

    function onMove(ev) {
      var box = split.getBoundingClientRect();
      wantLeft = ev.clientX - box.left;
      left.style.flexBasis = clampLeft(wantLeft) + 'px';
      // Per move, because the topbar is what the operator is looking at while
      // they drag. Two forced reflows of one flex row is nothing next to the
      // relayout the flex-basis write already costs.
      applyTopbar();
    }

    function onUp(ev) {
      // Committed as what is actually on screen, not as the raw pointer
      // position: dragging past either edge means "as far as it goes", and
      // saving the unclamped number would make the next load jump.
      wantLeft = clampLeft(wantLeft);
      save();
      document.body.classList.remove('log-split-dragging');
      try { gutter.releasePointerCapture(ev.pointerId); } catch (_e) {}
      gutter.removeEventListener('pointermove', onMove);
      gutter.removeEventListener('pointerup', onUp);
      gutter.removeEventListener('pointercancel', onUp);
    }

    gutter.addEventListener('pointermove', onMove);
    gutter.addEventListener('pointerup', onUp);
    gutter.addEventListener('pointercancel', onUp);
  }

  // Keyboard nudge, so the separator is not mouse-only (it carries
  // role="separator" and a tabindex, which promises this works).
  function onKey(e) {
    var step = e.shiftKey ? 50 : 10;         // px, matching the pixel width
    if (e.key === 'ArrowLeft')       wantLeft = clampLeft(wantLeft) - step;
    else if (e.key === 'ArrowRight') wantLeft = clampLeft(wantLeft) + step;
    else return;
    e.preventDefault();
    wantLeft = clampLeft(wantLeft);
    applyWidth();
    applyTopbar();
    save();
  }

  // ── Wire up ───────────────────────────────────────────────────────────────

  if (split && left && gutter && right) {
    load();
    paint();
    gutter.addEventListener('pointerdown', onDown);
    gutter.addEventListener('keydown', onKey);
    global.addEventListener('resize', function () { applyWidth(); applyTopbar(); });
    // fw-version.js rebuilds the status block from /state every 5 s and its
    // width changes with it -- the radio starts reporting a GPS fix, the link
    // drops and `⚠ OFFLINE` appears, a newer firmware adds " -> 20260910 ▲".
    // Without this the row would only be measured correctly until the next
    // poll changed its mind. Safe against a loop: applyTopbar() writes classes
    // on <body> and never touches this subtree.
    if (statusBox && global.MutationObserver) {
      new global.MutationObserver(function () { applyTopbar(); })
        .observe(statusBox, { childList: true, subtree: true, characterData: true });
    }
    try {
      var mq = global.matchMedia('(min-width: ' + MIN_VIEW + 'px)');
      if (mq.addEventListener) mq.addEventListener('change', applyViewport);
      else if (mq.addListener) mq.addListener(applyViewport);
    } catch (_e) {}
  }

  global.LogDxcSplit = {
    toggle: toggle,
    open:   doOpen,
    close:  doClose,
    // log.js asks this to decide whose spots may feed the band map: with the
    // panel mounted its filters are the ones the operator is looking at, so an
    // external window's payload must not overwrite them every 5 s.
    isOpen: function () { return open && wide() && !!frame; },
  };
})(window);
