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
// CLEAN mode (grilled 2026-09-28, the CLEAN pill on the palette and the page).
// The tape's slot = round((t - t0) / period) runs from the start of a burst,
// and with the squelch off -- the palette's only setting -- noise keeps one
// burst going for as long as the palette is open. A learnt period that moves
// by a tenth of a percent then shifts every new slot by several positions:
// forward leaves blanks that were never decoded, backward drops characters
// into those holes rows back (measured on this code: none of it on a clean
// signal, edits up to 3 rows back in noise). CLEAN does not place by time:
//
//  - DEC 1 is plain text, character after character in decode order -- the
//    order the clickable words are built from, so what is on screen is what a
//    click hands over. CR/LF show as a blank, runs of blanks as one. A row
//    ends when either column is full; both then write only into the newest
//    row, so DEC 1 never changes after the fact.
//  - DEC 2 goes to the row its `t` falls in, written continuously inside it:
//    the newest row, or the one before when the character was decoded before
//    the newest row began. It never reaches further back. No amber marks --
//    without slots there is nothing to compare position by position.
//  - 2 s of silence in both columns starts a new row under a rule and ends
//    the word in both, so the click agrees with the rule; this station's TX
//    echo is its own row, as on the tape.
//  - the scrollback trim drops whole rows from the top and re-lays nothing.
//
// The tape itself is left exactly as it was: switching re-lays the event list
// in the other mode.
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
  const CLEAN_PAUSE_SAMPLES = 2 * 8000;   // CLEAN mode: a new row after 2 s of silence
  // Holding the tape still while the operator aims at a word (see aimTouch()).
  const AIM_MS = 2000, AIM_GRACE_MS = 400;

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
  //   clean       start in CLEAN mode (default false: the time tape)
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
    let clean = options.clean === true;

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
        lastAnyT: null,        // CLEAN: the newest character's t, either column
      };
    }

    function applyMode() {
      el.classList.toggle("rtty-tape-single", !dual);
      el.classList.toggle("rtty-tape-clean", clean);
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

    // The clickable word a character belongs to: a run of non-blank characters
    // of one column in decode order -- the same in both modes, whatever the
    // layout does with the characters.
    function tokenFor(L, e) {
      if (isBlankChar(e.ch)) { L.tok[e.s] = 0; return 0; }
      if (!L.tok[e.s]) { L.tok[e.s] = nextTokId++; L.tokChars.set(L.tok[e.s], ""); }
      const tok = L.tok[e.s];
      L.tokChars.set(tok, L.tokChars.get(tok) + e.ch);
      return tok;
    }

    function applyChar(L, e) {
      learnPeriod(L, e.s, e.t);
      const {row, col} = placeChar(L, e.s, e.t);
      const tok = tokenFor(L, e);
      row.slots[e.s][col] = {ch: e.ch, snr: e.snr, tok};
      e.row = row.index;
      return row;
    }

    // CLEAN mode: the row a character is written into (see the header). New
    // rows are opened here only for a character that will be drawn.
    function cleanNewRow(L, t, gap) {
      const row = rowFor(L.lastRow + 1, L);
      row.t0 = t;
      if (gap) markGap(row);
      L.segmentBreak = false;
      return row;
    }

    function applyCharClean(L, e) {
      const pause = L.lastAnyT !== null && e.t - L.lastAnyT > CLEAN_PAUSE_SAMPLES;
      // The pause's rule separates words on screen, so it ends them for the
      // click too -- "AB", silence, "DL2XYZ" is two words here, not ABDL2XYZ.
      if (pause) L.tok = [0, 0, 0];
      const tok = tokenFor(L, e);
      const blank = !tok;
      if (L.lastAnyT === null || e.t > L.lastAnyT) L.lastAnyT = e.t;
      const cur = L.lastRow >= 0 ? L.byIndex.get(L.lastRow) : null;
      const fresh = !cur || cur.echo || L.segmentBreak || pause;
      let row = fresh ? null : cur;
      if (row && e.s === 2 && e.t < row.t0) {
        const prev = L.byIndex.get(row.index - 1);
        if (prev && !prev.echo && !row.gap && prev.slots[2].length < columnChars) row = prev;
      }
      if (row && row.slots[e.s].length >= columnChars) row = null;   // full: a new row
      if (blank) {
        // A blank ends the word and is drawn once, between two words: never at
        // the start of a row, never twice in a row, never opening a row.
        e.row = row ? row.index : L.lastRow;
        const slots = row ? row.slots[e.s] : null;
        if (!slots || !slots.length || isBlankChar(slots[slots.length - 1].ch)) return null;
        slots.push({ch: " ", snr: e.snr, tok: 0});
        return row;
      }
      if (!row) row = cleanNewRow(L, e.t, pause && cur && !cur.echo);
      row.slots[e.s].push({ch: e.ch, snr: e.snr, tok});
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
        const differs = dual && !clean && s === 2 &&
          (blank !== otherBlank || (!blank && slot.ch !== otherSlot.ch));
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
      if (clean) {   // each column is its own continuous text
        renderCell(row, 1, row.slots[1].map((_, i) => i));
        renderCell(row, 2, row.slots[2].map((_, i) => i));
        return;
      }
      const visible = visibleSlots(row.slots[1], dual ? row.slots[2] : []);
      renderCell(row, 1, visible);
      renderCell(row, 2, visible);
    }

    // ---- the tape stands still while the operator aims -----------------------
    // Characters fill a row in place, so the tape only moves when a NEW row
    // starts: scrollToEnd() then slides everything up one line. At 45 Bd that
    // is every few seconds, often enough that the line shifted between aiming
    // at a word and pressing the button, and the operator logged the word one
    // row below (2026-09-28). Same idea as the DX cluster's anchor (dxc.html
    // aimTouch), shorter: while the pointer is on a clickable word AND has
    // moved (or pressed, or turned the wheel) there in the last AIM_MS, the
    // tape does not follow the newest text. A parked mouse lets go after
    // AIM_MS -- in QRPlog it rests on this palette while the operator types
    // the exchange, and the tape must keep following the band then.
    //
    // For the text that arrives meanwhile to have somewhere to go, the tape
    // always ends in one empty row (CSS padding on .rtty-tape-body, one line
    // plus a pause rule): normally that is just blank space at the bottom,
    // while held a new row grows into it without moving anything above. More
    // than that during one hold goes below the edge and shows on release.
    //
    // Moving off a word keeps the hold for AIM_GRACE_MS, enough to cross the
    // blanks to the next word or the next row; moving on off-word never
    // extends it. Leaving the tape lets go at once. Letting go is a jump to the
    // newest text. The frame (.rtty-tape-aiming) is amber on purpose: red is
    // this station's TX. It must never be a border -- a border changes the
    // column width and that re-lays the whole tape, exactly the jump this is
    // here to prevent.
    let aimUntil = 0, aimTimer = 0;
    const aiming = () => aimUntil > Date.now();
    function aimArm(ms) {
      clearTimeout(aimTimer);
      aimTimer = setTimeout(releaseAim, ms + 20);
    }
    function aimTouch() {
      aimUntil = Date.now() + AIM_MS;
      el.classList.add("rtty-tape-aiming");
      aimArm(AIM_MS);
    }
    function aimGrace() {
      const until = Date.now() + AIM_GRACE_MS;
      if (aimUntil <= until) return;
      aimUntil = until;
      aimArm(AIM_GRACE_MS);
    }
    // Ends a hold without scrolling -- for whatever re-lays the tape anyway.
    function dropAim() {
      const was = aimUntil;
      aimUntil = 0;
      clearTimeout(aimTimer);
      aimTimer = 0;
      el.classList.remove("rtty-tape-aiming");
      return was;
    }
    function releaseAim() {
      if (!dropAim()) return;
      if (charCount > maxChars) trim();   // held back while the operator aimed
      else scrollToEnd();
    }

    function scrollToEnd() { if (!aiming()) el.scrollTop = el.scrollHeight; }

    // Re-lay everything from the event list (width change, mode change, trim).
    // The rows are rebuilt, so a hold has nothing left to hold.
    function relayout() {
      dropAim();
      (layout ? layout.rows : []).forEach(r => { if (r.echo) (r.echo.timers || []).forEach(clearTimeout); });
      body.textContent = "";
      layout = freshLayout();
      applyMode();
      for (const e of events) {
        if (e.kind === "c") (clean ? applyCharClean : applyChar)(layout, e);
        else if (e.kind === "s") { if (clean) e.row = layout.lastRow; else applyShift(layout, e); }
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
      if (!clean) { relayout(); return; }
      // CLEAN: the rows below the cut stay exactly as they are
      while (layout.rows.length && layout.rows[0].index <= cutRow) {
        const row = layout.rows.shift();
        layout.byIndex.delete(row.index);
        if (row.echo) (row.echo.timers || []).forEach(clearTimeout);
        body.removeChild(row.el);
      }
      scrollToEnd();
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
      const row = clean ? applyCharClean(layout, e) : applyChar(layout, e);
      if (row) renderRow(row);
      // a trim re-lays the whole tape: not under a word being aimed at
      if (charCount > maxChars && !aiming()) trim();
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
      // CLEAN has no slots for a shift's air time; kept for the tape's sake
      if (clean) e.row = layout.lastRow;
      else renderRow(applyShift(layout, e));
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
      dropAim();
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

    // The CLEAN pill: the whole history re-laid in the other mode.
    function setClean(on) {
      if (clean === !!on) return;
      clean = !!on;
      applyMode();
      if (layout) relayout();
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
    const onAim = event => {
      const t = event.target;
      if (t && t.closest && t.closest(".rtty-tok")) aimTouch();
      else if (aiming()) aimGrace();
    };
    el.addEventListener("click", onClick);
    el.addEventListener("mouseover", onOver);
    el.addEventListener("mouseleave", onLeave);
    el.addEventListener("pointermove", onAim);
    el.addEventListener("pointerdown", onAim);
    el.addEventListener("wheel", onAim, {passive: true});
    el.addEventListener("pointerleave", releaseAim);

    const resizeObserver = typeof ResizeObserver === "function" && !fixedColumnChars
      ? new ResizeObserver(() => { if (layout || events.length) ensureLayout(); }) : null;
    if (resizeObserver) resizeObserver.observe(el);
    applyMode();

    function destroy() {
      el.removeEventListener("click", onClick);
      el.removeEventListener("mouseover", onOver);
      el.removeEventListener("mouseleave", onLeave);
      el.removeEventListener("pointermove", onAim);
      el.removeEventListener("pointerdown", onAim);
      el.removeEventListener("wheel", onAim);
      el.removeEventListener("pointerleave", releaseAim);
      dropAim();
      if (resizeObserver) resizeObserver.disconnect();
      (layout ? layout.rows : []).forEach(r => { if (r.echo) (r.echo.timers || []).forEach(clearTimeout); });
      lastEcho = null;
    }

    return {
      pushChar, pushShift, clear, echoTx, markEchoFailed, setDual, setClean, destroy,
      clean: () => clean,
      lastEcho: () => lastEcho,
      forgetEcho: () => { lastEcho = null; },
      columnChars: () => columnChars,
      aiming,
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
