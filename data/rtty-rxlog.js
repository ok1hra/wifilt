// The RTTY receive log: a two-column TAPE of decoded text (DEC 1 | DEC 2),
// coloured per character by signal strength, plus this station's own TX echo.
//
// Extracted from rtty.js 2026-09-07 so QRPlog's own RTTY palette
// (log-rtty-panel.js) shows the same log rather than a second copy. The
// `.rtty-tok` span contract is exactly what makes click-a-word-into-the-log
// work, so two implementations would mean two click behaviours.
//
// The tape (docs/rtty-implementace.md §21, 2026-09-25). Two decoders run on
// the same audio -- DEC 1 point-samples each bit, DEC 2 integrates over it --
// and the operator picks whichever copy of a word came through. For that the
// two copies have to sit side by side, so the log is laid out in TIME, not as
// two free-flowing texts:
//
//  - every character carries `t`, the audio sample its start bit began at.
//    Both decoders count the same samples, so the same character decoded by
//    both lands on the same position of the same row.
//  - a row is as many character slots as the column is wide; one slot is one
//    Baudot character (7.5 bits, ~165 ms). Within a burst of traffic a
//    character goes to slot round((t - t0) / period) from the burst's anchor,
//    with `period` learnt from the traffic itself (a sender with 2 stop bits
//    runs 7 % slower and would otherwise drift a blank into every word).
//  - a pause of three characters or more ends the burst. A pause longer than
//    what is left of the row skips the empty rows and draws a thin rule
//    instead -- silence costs no screen space, and a new reception starts at
//    the left edge. That rule replaced the old "squelch-open marker" line and
//    the palette's 3 s gap break.
//  - this station's own TX echo is a row of its own, written into BOTH
//    columns: nothing decoded shares it, and the audio clock stops while we
//    transmit anyway (RX is blanked), so after it both columns restart level.
//  - a slot where DEC 2 disagrees with DEC 1 (including one blank) gets a
//    faint background in the DEC 2 column only (operator, 2026-09-25): DEC 1
//    stays clean as the reference, and the eye goes straight to the words to choose
//    between. The text colour keeps meaning signal strength.
//
// Everything placed is also kept as an event list, so a change of column
// width (window resize, palette resize, DEC 2 on/off) re-lays the whole tape
// out exactly rather than leaving old rows at the old width.
//
// Two deliberate differences from the code the first version replaced:
//
//  - the gradient endpoints arrive as parameters instead of being read from
//    document.documentElement at module load. The page is dark and defines
//    --muted/--panel2; QRPlog is light and defines neither, so a module-load
//    read there would silently produce nonsense. cssVarRgb() below is exported
//    so each consumer resolves them against ITS OWN element.
//
//  - what a token click does is a callback, not a hardwired BroadcastChannel
//    post. The page posts to wifilt-dxc-action; the palette calls log.js
//    directly, because BroadcastChannel does not deliver to the posting
//    context and the palette lives in the same document as its listener.
//
// The consumer owns the decoders and its own counters -- it calls pushChar()
// from each decoder's onChar() with meta.stream = 1 or 2. This module only
// owns the DOM.
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RttyRxLog = factory();
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  // snrDb here is 10*log10(markMag/spaceMag) from a single Goertzel window
  // sampled at the character's stop bit (rtty-codec.js's _emitCode()). The
  // SIGN just reflects which of the two tones that window happened to catch,
  // which varies per character with the bit pattern -- it is NOT confidence.
  // Pure noise gives roughly equal mark/space energy (ratio near 0 dB either
  // way); clean FSK gives one tone strongly dominant (|ratio| large either
  // way). So the mapping keys off Math.abs(snrDb), the distance from 0 dB.
  //
  // The dB bounds are placeholders -- this isn't physical SNR (no separate
  // noise-floor measurement), so there is no real-air data to calibrate
  // against yet (docs/rtty-implementace.md §13.3).
  const DEFAULT_FLOOR_DB = 0, DEFAULT_CEIL_DB = 15;
  const DEFAULT_CEIL_RGB = [255, 255, 255];
  // A third stop above the white one (operator, 2026-09-07): an exceptionally
  // strong character leaves the greyscale. White is already the brightest a
  // screen has, so the top of the scale has no headroom left in LUMINANCE --
  // the only axis still free is hue, which is exactly how a waterfall
  // colormap runs out of "brighter" and turns to colour.
  //
  // Green rather than the sandy yellow this started as (operator, 2026-09-08:
  // the sand read as washed out): it is the green QRPLog's own top and bottom
  // bars are built from, and the one the DX cluster pane sitting beside this
  // palette already uses for its text, so a booming station looks like it
  // belongs to the same screen. NOT the bars' #008800 itself -- that is a
  // BACKGROUND colour carrying white text, and as 12 px type on this palette's
  // ground it lands at 3.4:1, dimmer than the sand it replaces. #63ff7c keeps
  // luminance 0.76 against white's 1.0, the same size of step the sand made
  // (0.68) -- still a move in hue, not a dimming.
  const DEFAULT_HOT_DB = 20;
  const DEFAULT_HOT_RGB = [99, 255, 124];   // #63ff7c

  // One Baudot character in audio samples at the decoders' 8 kHz: 7.5 bits.
  const CHAR_SAMPLES = 8000 / 45.45 * 7.5;
  const BURST_GAP_CHARS = 3;     // a pause this long ends a burst
  const MIN_COLUMN_CHARS = 8;

  function cssVarRgb(name, fallbackHex, element) {
    const host = element || document.documentElement;
    const raw = getComputedStyle(host).getPropertyValue(name).trim() || fallbackHex;
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(raw);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
  }

  // The weak end of the gradient. Not plain --muted: that is a fixed UI token
  // other elements (pills, labels) rely on staying legible at ITS OWN
  // brightness, not a knob for this gradient. Blended 50 % toward the log's
  // own --panel2 background instead, so weak/noisy characters recede
  // noticeably further while still resolving to *something* readable on focus
  // (never fully invisible), rather than being a flat, separately-tuned hex.
  function floorRgbFrom(element) {
    const muted = cssVarRgb("--muted", "#8ba59d", element);
    const panel2 = cssVarRgb("--panel2", "#132724", element);
    return muted.map((c, i) => Math.round(c + (panel2[i] - c) * 0.5));
  }

  const isBlankChar = ch => ch === " " || ch === "\n" || ch === "\r";

  // options:
  //   el          the scrolling log container
  //   maxChars    scrollback budget in decoded characters (both columns)
  //   dual        show DEC 2 beside DEC 1 (default true)
  //   floorRgb    weak-signal colour, default floorRgbFrom(el)
  //   ceilRgb     strong-signal colour, default white -- brighter than --text
  //               on purpose, a deliberate two-ended widen of the gradient
  //   hotRgb      exceptionally-strong colour, default bright green
  //   floorDb/ceilDb/hotDb   |snrDb| mapped across the two ramps
  //   columnChars fixed column width in characters (tests); default: measured
  //   onToken(word, event)   a .rtty-tok was clicked
  function create(options) {
    const el = options.el;
    const maxChars = options.maxChars || 20000;
    const floorRgb = options.floorRgb || floorRgbFrom(el);
    const ceilRgb = options.ceilRgb || DEFAULT_CEIL_RGB;
    const hotRgb = options.hotRgb || DEFAULT_HOT_RGB;
    const floorDb = Number.isFinite(options.floorDb) ? options.floorDb : DEFAULT_FLOOR_DB;
    const ceilDb = Number.isFinite(options.ceilDb) ? options.ceilDb : DEFAULT_CEIL_DB;
    // Never below the white stop: a caller that inverts them would otherwise
    // divide by a negative span and paint the whole scale backwards. Equal is
    // allowed and means "step straight from white to green at that level".
    const hotDb = Math.max(ceilDb,
      Number.isFinite(options.hotDb) ? options.hotDb : DEFAULT_HOT_DB);
    const onToken = options.onToken || (() => {});
    const fixedColumnChars = options.columnChars || 0;
    let dual = options.dual !== false;

    const rgbString = c => `rgb(${c[0]},${c[1]},${c[2]})`;
    const mix = (from, to, t) =>
      rgbString([0, 1, 2].map(i => Math.round(from[i] + (to[i] - from[i]) * t)));

    // Two ramps, not one: floor -> white up to ceilDb, then white -> green up
    // to hotDb, flat green above it.
    //
    // The second ramp is a ramp and not a hard threshold on purpose. snrDb is
    // measured per character from a single Goertzel window, so it moves by
    // several dB between adjacent characters of the SAME word -- a step at
    // exactly hotDb would make one word flicker white/green letter by letter
    // and read as noise rather than as information. Ramped, a word straddling
    // the level simply looks tinted, and only a genuinely booming one is fully
    // green.
    function colorForSnr(snrDb) {
      if (!Number.isFinite(snrDb)) return null;
      const db = Math.abs(snrDb);
      if (db >= hotDb) return rgbString(hotRgb);
      if (db <= ceilDb)
        return mix(floorRgb, ceilRgb,
          Math.max(0, Math.min(1, (db - floorDb) / (ceilDb - floorDb))));
      return mix(ceilRgb, hotRgb, (db - ceilDb) / (hotDb - ceilDb));
    }

    // ---- DOM skeleton ------------------------------------------------------
    el.classList.add("rtty-tape");
    el.textContent = "";
    const head = document.createElement("div");
    head.className = "rtty-tape-head";
    head.innerHTML =
      '<span title="Decoder 1: reads each bit at its centre">DEC 1</span>' +
      '<span title="Decoder 2: averages over the middle of each bit and keeps the character rhythm -- ' +
      'strongest in noise, static and next to another station; pick whichever copy came through">DEC 2</span>';
    const empty = document.createElement("div");
    empty.className = "rtty-tape-empty";
    empty.textContent = "Waiting for signal…";
    const body = document.createElement("div");
    body.className = "rtty-tape-body";
    // An invisible row used only to measure how many characters fit a column.
    const probeRow = document.createElement("div");
    probeRow.className = "rtty-tape-row rtty-tape-probe";
    probeRow.setAttribute("aria-hidden", "true");
    const probeCell = document.createElement("div");
    probeCell.className = "rtty-tape-cell rtty-tape-s1";
    const probeText = document.createElement("span");
    probeText.textContent = "0000000000";
    probeCell.appendChild(probeText);
    probeRow.appendChild(probeCell);
    probeRow.appendChild(document.createElement("div")).className = "rtty-tape-cell rtty-tape-s2";
    el.append(head, empty, body, probeRow);

    // ---- model -------------------------------------------------------------
    let events = [];           // {kind:'c', s, ch, t, snr} | {kind:'s', s, t} | {kind:'e', echo}
    let charCount = 0;
    let columnChars = 0;
    let layout = null;         // rebuilt from `events` whenever the width changes
    let hoverTok = null;
    let lastEcho = null;
    const fallbackT = [0, 0, 0];   // callers without meta.t (standalone use)
    let nextTokId = 1;

    function measureColumnChars() {
      if (fixedColumnChars) return fixedColumnChars;
      const cellW = probeCell.clientWidth;
      const chW = probeText.getBoundingClientRect().width / 10;
      if (!(cellW > 0) || !(chW > 0)) return columnChars || 40;
      return Math.max(MIN_COLUMN_CHARS, Math.floor(cellW / chW));
    }

    function freshLayout() {
      return {
        rows: [],              // in order; {index, el, cells:[,c1,c2], slots:[,[],[]], echo, gap}
        byIndex: new Map(),
        lastRow: -1,
        burst: null,           // {t0, pos0, lastT}
        prevBurst: null,
        period: CHAR_SAMPLES,
        lastT: [null, null, null],
        tok: [0, 0, 0],        // open token id per stream (0 = none)
        tokChars: new Map(),   // tokId -> string so far
        segmentBreak: false,   // set by an echo: the next burst starts a fresh row
      };
    }

    function applyMode() {
      el.classList.toggle("rtty-tape-single", !dual);
    }

    function rowFor(index, L) {
      let row = L.byIndex.get(index);
      if (row) return row;
      row = {index, el: document.createElement("div"), cells: [null], slots: [null, [], []],
        spans: [null, [], []], echo: null, gap: false};
      row.el.className = "rtty-tape-row";
      for (let s = 1; s <= 2; s++) {
        const cell = document.createElement("div");
        cell.className = "rtty-tape-cell rtty-tape-s" + s;
        row.el.appendChild(cell);
        row.cells.push(cell);
      }
      // keep DOM and list ordered by index (a late DEC 2 character can reach
      // back into a row that DEC 1 never needed)
      let at = L.rows.length;
      while (at > 0 && L.rows[at - 1].index > index) at--;
      L.rows.splice(at, 0, row);
      body.insertBefore(row.el, at + 1 < L.rows.length ? L.rows[at + 1].el : null);
      L.byIndex.set(index, row);
      if (index > L.lastRow) L.lastRow = index;
      empty.hidden = true;
      return row;
    }

    function markGap(row) {
      row.gap = true;
      row.el.classList.add("rtty-tape-gap");
    }

    // Where a character goes: the burst it belongs to decides the anchor, the
    // time since that anchor decides the slot.
    function placeChar(L, s, t) {
      const gapSamples = BURST_GAP_CHARS * L.period;
      let burst = L.burst;
      if (burst && t < burst.t0 - L.period / 2 && L.prevBurst &&
          t <= L.prevBurst.lastT + gapSamples) {
        burst = L.prevBurst;                  // a late DEC 2 char from the burst before
      } else if (!burst || L.segmentBreak || t > burst.lastT + gapSamples) {
        // A new burst. After an echo (or at the very start) it opens a fresh
        // row. After a pause it keeps the pause's real length -- unless that
        // would leave at least one whole row empty: then the empty rows are
        // skipped, the burst starts at the left edge and the row gets a rule.
        let pos0, gapBefore = false;
        if (!burst || L.segmentBreak) {
          pos0 = (L.lastRow + 1) * columnChars;
        } else {
          pos0 = burst.lastPos + Math.max(1, Math.round((t - burst.lastT) / L.period));
          if (Math.floor(pos0 / columnChars) > L.lastRow + 1) {
            pos0 = (L.lastRow + 1) * columnChars;
            gapBefore = true;
          }
        }
        L.prevBurst = L.segmentBreak ? null : burst;
        burst = L.burst = {t0: t, pos0, lastT: t, lastPos: pos0, gapBefore};
        L.segmentBreak = false;
      }
      let pos = burst.pos0 + Math.round((t - burst.t0) / L.period);
      if (pos < burst.pos0) pos = burst.pos0;
      // never two characters of the same column in one slot
      for (;;) {
        const row = L.byIndex.get(Math.floor(pos / columnChars));
        if (!row || !row.slots[s][pos % columnChars]) break;
        pos++;
      }
      if (t > burst.lastT) burst.lastT = t;
      if (pos > burst.lastPos) burst.lastPos = pos;
      const row = rowFor(Math.floor(pos / columnChars), L);
      if (burst.gapBefore && Math.floor(pos / columnChars) === Math.floor(burst.pos0 / columnChars) && !row.gap)
        markGap(row);
      return {row, col: pos % columnChars};
    }

    function learnPeriod(L, s, t) {
      const prev = L.lastT[s];
      L.lastT[s] = t;
      if (prev === null) return;
      const d = t - prev;
      if (d > 0.85 * CHAR_SAMPLES && d < 1.3 * CHAR_SAMPLES) L.period += (d - L.period) * 0.1;
    }

    function applyChar(L, e) {
      learnPeriod(L, e.s, e.t);
      const {row, col} = placeChar(L, e.s, e.t);
      let tok = 0;
      if (isBlankChar(e.ch)) {
        L.tok[e.s] = 0;
      } else {
        if (!L.tok[e.s]) { L.tok[e.s] = nextTokId++; L.tokChars.set(L.tok[e.s], ""); }
        tok = L.tok[e.s];
        L.tokChars.set(tok, L.tokChars.get(tok) + e.ch);
      }
      row.slots[e.s][col] = {ch: e.ch, snr: e.snr, tok};
      e.row = row.index;
      return row;
    }

    // A FIGS/LTRS shift: a frame on the air that prints nothing. It takes a
    // slot like any character (so the period and the burst stay right), but
    // a slot holding nothing except a shift in either column is not drawn --
    // see visibleSlots().
    function applyShift(L, e) {
      learnPeriod(L, e.s, e.t);
      const {row, col} = placeChar(L, e.s, e.t);
      if (!row.slots[e.s][col]) row.slots[e.s][col] = {shift: true};
      e.row = row.index;
      return row;
    }

    function applyEcho(L, e) {
      const echo = e.echo;
      const row = rowFor(L.lastRow + 1, L);
      row.echo = echo;
      row.el.classList.add("rtty-tape-echo-row");
      echo.containers = [];
      echo.charSpans = [];
      for (let s = 1; s <= 2; s++) {
        const container = document.createElement("span");
        container.className = "rtty-tx-echo";
        const spans = Array.from(echo.text, ch => {
          const span = document.createElement("span");
          span.className = "rtty-tx-char";
          span.textContent = ch;
          container.appendChild(span);
          return span;
        });
        if (echo.failed) {
          container.classList.add("rtty-tx-echo-failed");
          container.appendChild(document.createTextNode(" (failed)"));
        }
        row.cells[s].textContent = "";
        row.cells[s].appendChild(container);
        echo.containers.push(container);
        echo.charSpans.push(spans);
      }
      echo.container = echo.containers[0];
      scheduleEchoLight(echo);
      L.segmentBreak = true;
      L.burst = null; L.prevBurst = null;
      L.tok = [0, 0, 0];
      e.row = row.index;
      return row;
    }

    // Each echoed character starts grey and steps to red at its own estimated
    // transmit time, from RttyCodec.charStartTimes() -- the real Baudot frame
    // sequence, so FIGS/LTRS shifts and characters with no Baudot mapping
    // don't throw a flat per-character count off. This does not try to track
    // real playback: external FSK over TrxNet has no observable completion
    // signal anyway, so elapsed wall time against this estimate is the whole
    // design, for both TX methods alike. A re-layout re-lights whatever time
    // has already passed and re-arms only the rest.
    function scheduleEchoLight(echo) {
      (echo.timers || []).forEach(clearTimeout);
      echo.timers = [];
      if (echo.failed && echo.frozenAt === undefined) echo.frozenAt = Date.now();
      const elapsed = (echo.frozenAt !== undefined ? echo.frozenAt : Date.now()) - echo.startedAt;
      for (const {index, startMs} of echo.times) {
        const light = () => echo.charSpans.forEach(spans => {
          const span = spans[index];
          if (span && span.isConnected) span.classList.add("lit");
        });
        if (startMs <= elapsed) light();
        else if (!echo.failed) echo.timers.push(setTimeout(light, startMs - elapsed));
      }
    }

    // One cell's slots -> one span per slot, updated IN PLACE: a row keeps
    // receiving characters while the operator reads it, and replacing its
    // nodes would drop a click landing mid-update and wipe a text selection.
    // A decoded character carries its word as data-tok (and the .rtty-tok
    // class), so a word the row edge wrapped is still ONE word for the click
    // and the hover; a DEC 2 slot that differs from DEC 1 is marked (in the
    // DEC 2 column only -- DEC 1 is the reference and stays unmarked).
    function renderCell(row, s, visible) {
      const cell = row.cells[s];
      const spans = row.spans[s];
      if (s === 2 && !dual) {
        if (spans.length) { cell.textContent = ""; spans.length = 0; }
        return;
      }
      const mine = row.slots[s], other = row.slots[3 - s];
      while (spans.length < visible.length) spans.push(cell.appendChild(document.createElement("span")));
      while (spans.length > visible.length) cell.removeChild(spans.pop());
      for (let v = 0; v < visible.length; v++) {
        const i = visible[v];
        const slot = mine[i] && !mine[i].shift ? mine[i] : null;
        const blank = !slot || isBlankChar(slot.ch);
        const otherSlot = other[i] && !other[i].shift ? other[i] : null;
        const otherBlank = !otherSlot || isBlankChar(otherSlot.ch);
        const differs = dual && s === 2 && (blank !== otherBlank || (!blank && slot.ch !== otherSlot.ch));
        const tok = !blank && slot.tok ? slot.tok : 0;
        const color = blank ? null : colorForSnr(slot.snr);
        const key = (blank ? " " : slot.ch) + "|" + differs + "|" + color + "|" + tok;
        const span = spans[v];
        if (span._k === key) continue;
        span._k = key;
        span.textContent = blank ? " " : slot.ch;
        span.className = "rtty-rx-char" + (tok ? " rtty-tok" : "") + (differs ? " rtty-diff" : "") +
          (tok && tok === hoverTok ? " hover" : "");
        if (tok) span.dataset.tok = String(tok); else delete span.dataset.tok;
        if (color) span.style.setProperty("--rtty-rx-char-color", color);
        else span.style.removeProperty("--rtty-rx-char-color");
      }
    }

    function renderRow(row) {
      if (row.echo) return;
      const visible = visibleSlots(row.slots[1], dual ? row.slots[2] : []);
      renderCell(row, 1, visible);
      renderCell(row, 2, visible);
    }

    function scrollToEnd() { el.scrollTop = el.scrollHeight; }

    // Re-lay everything from the event list (width change, mode change, trim).
    function relayout() {
      (layout ? layout.rows : []).forEach(r => { if (r.echo) (r.echo.timers || []).forEach(clearTimeout); });
      body.textContent = "";
      layout = freshLayout();
      applyMode();
      for (const e of events) {
        if (e.kind === "c") applyChar(layout, e);
        else if (e.kind === "s") applyShift(layout, e);
        else applyEcho(layout, e);
      }
      layout.rows.forEach(renderRow);
      empty.hidden = layout.rows.length > 0;
      scrollToEnd();
    }

    function ensureLayout() {
      const cap = measureColumnChars();
      if (!layout || cap !== columnChars) { columnChars = cap; relayout(); }
    }

    // Drop the oldest rows once the scrollback budget is spent, keeping 90 %.
    function trim() {
      if (charCount <= maxChars) return;
      let keep = 0, cutRow = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].kind === "c" && ++keep > maxChars * 0.9) { cutRow = events[i].row; break; }
      }
      events = events.filter(e => e.row > cutRow);
      charCount = events.filter(e => e.kind === "c").length;
      relayout();
    }

    function pushChar(ch, meta) {
      const s = meta && meta.stream === 2 ? 2 : 1;
      if (s === 2 && !dual) return;
      let t = meta && Number.isFinite(meta.t) ? meta.t : null;
      if (t === null) t = (fallbackT[s] += CHAR_SAMPLES);
      const e = {kind: "c", s, ch, t, snr: meta && meta.snrDb};
      if (!layout) ensureLayout();
      events.push(e);
      charCount++;
      const row = applyChar(layout, e);
      renderRow(row);
      if (charCount > maxChars) trim();
      scrollToEnd();
    }

    // A decoder's FIGS/LTRS shift (its onEvent {type:"shift", t}).
    function pushShift(meta) {
      const s = meta && meta.stream === 2 ? 2 : 1;
      if (s === 2 && !dual) return;
      if (!meta || !Number.isFinite(meta.t)) return;
      if (!layout) ensureLayout();
      const e = {kind: "s", s, t: meta.t};
      events.push(e);
      renderRow(applyShift(layout, e));
    }

    // This station's own sent text, echoed into the log like a monitor -- NOT
    // a .rtty-tok (no click/hover: the operator's own callsign in
    // "CQ CQ DE OK1HRA" must never be mistaken for a station to log).
    // Displayed uppercase (what actually goes out -- both TX methods already
    // uppercase at the encoding stage, this just makes the echo agree).
    function echoTx(text) {
      const upper = String(text).toUpperCase();
      const echo = {text: upper, startedAt: Date.now(), failed: false,
        times: RttyCodec.charStartTimes(upper), timers: [], containers: [], charSpans: []};
      if (!layout) ensureLayout();
      const e = {kind: "e", echo};
      events.push(e);
      applyEcho(layout, e);
      empty.hidden = true;
      lastEcho = echo;
      scrollToEnd();
      return echo;
    }

    // Retracts an echo whose send then failed, rather than leaving a false
    // "sent" line for a message that never went out -- the RX log is the one
    // place QRPlog cross-references what was sent, and it had no way to tell a
    // genuine send from a failed attempt.
    function markEchoFailed(echo) {
      if (!echo || echo.failed) return;
      if (!echo.containers.some(c => c.isConnected)) return;   // trimmed out of the log already
      echo.timers.forEach(clearTimeout);   // whatever hasn't lit yet stays grey, no catch-up
      echo.failed = true;
      echo.frozenAt = Date.now();
      for (const c of echo.containers) {
        c.classList.add("rtty-tx-echo-failed");
        c.appendChild(document.createTextNode(" (failed)"));
      }
    }

    // Wipes the log itself, not the decoder state -- squelch/AFC/tone tracking
    // all live in the decoder/settings and must keep running exactly as before.
    function clear() {
      (layout ? layout.rows : []).forEach(r => { if (r.echo) (r.echo.timers || []).forEach(clearTimeout); });
      events = [];
      charCount = 0;
      layout = null;
      body.textContent = "";
      empty.hidden = false;
    }

    function setDual(on) {
      if (dual === !!on) return;
      dual = !!on;
      applyMode();
      columnChars = 0;
      ensureLayout();
    }

    const onClick = event => {
      const token = event.target.closest(".rtty-tok");
      if (!token) return;
      // the whole word, also the half the row edge wrapped away from this one
      const whole = layout && token.dataset.tok ? layout.tokChars.get(Number(token.dataset.tok)) : null;
      const word = (whole || token.textContent).trim();
      if (!word) return;
      onToken(word, event);
    };
    // Hover lights every piece of the word, also the half the row edge wrapped.
    const onOver = event => {
      const token = event.target.closest && event.target.closest(".rtty-tok");
      const id = token ? Number(token.dataset.tok) : null;
      if (id === hoverTok) return;
      el.querySelectorAll(".rtty-tok.hover").forEach(n => n.classList.remove("hover"));
      hoverTok = id;
      if (id) el.querySelectorAll('.rtty-tok[data-tok="' + id + '"]').forEach(n => n.classList.add("hover"));
    };
    const onLeave = () => {
      el.querySelectorAll(".rtty-tok.hover").forEach(n => n.classList.remove("hover"));
      hoverTok = null;
    };
    el.addEventListener("click", onClick);
    el.addEventListener("mouseover", onOver);
    el.addEventListener("mouseleave", onLeave);

    const resizeObserver = typeof ResizeObserver === "function" && !fixedColumnChars
      ? new ResizeObserver(() => { if (layout || events.length) ensureLayout(); }) : null;
    if (resizeObserver) resizeObserver.observe(el);
    applyMode();

    function destroy() {
      el.removeEventListener("click", onClick);
      el.removeEventListener("mouseover", onOver);
      el.removeEventListener("mouseleave", onLeave);
      if (resizeObserver) resizeObserver.disconnect();
      (layout ? layout.rows : []).forEach(r => { if (r.echo) (r.echo.timers || []).forEach(clearTimeout); });
      lastEcho = null;
    }

    return {
      pushChar, pushShift, clear, echoTx, markEchoFailed, setDual, destroy,
      lastEcho: () => lastEcho,
      forgetEcho: () => { lastEcho = null; },
      columnChars: () => columnChars,
      // what each column shows, row by row -- for tests and for reading back
      rowsText: () => (layout ? layout.rows : []).map(r => {
        if (r.echo) return {echo: r.echo.text, gap: r.gap};
        const visible = visibleSlots(r.slots[1], r.slots[2]);
        return {dec1: slotsText(r.slots[1], visible), dec2: slotsText(r.slots[2], visible), gap: r.gap};
      }),
      colorForSnr,
    };
  }

  // Slot indexes to draw: all of them, except one where neither column has a
  // real character and at least one has a shift -- the shift's air time.
  function visibleSlots(a, b) {
    const n = Math.max(a.length, b.length), out = [];
    for (let i = 0; i < n; i++) {
      const x = a[i], y = b[i];
      const shiftOnly = (!x || x.shift) && (!y || y.shift) && ((x && x.shift) || (y && y.shift));
      if (!shiftOnly) out.push(i);
    }
    return out;
  }

  function slotsText(slots, visible) {
    let out = "";
    for (const i of visible) out += slots[i] && !slots[i].shift && !isBlankChar(slots[i].ch) ? slots[i].ch : " ";
    return out.replace(/\s+$/, "");
  }

  return {create, cssVarRgb, floorRgbFrom, CHAR_SAMPLES,
          DEFAULT_FLOOR_DB, DEFAULT_CEIL_DB, DEFAULT_HOT_DB, DEFAULT_HOT_RGB};
}));
