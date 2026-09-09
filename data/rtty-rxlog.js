// The RTTY receive log: decoded characters as clickable word tokens, coloured
// per character by signal strength, plus this station's own TX echo.
//
// Extracted from rtty.js 2026-09-07 so QRPlog's own RTTY palette
// (log-rtty-panel.js) shows the same log rather than a second copy. The
// `.rtty-tok` span contract is exactly what makes click-a-word-into-the-log
// work, so two implementations would mean two click behaviours.
//
// Two deliberate differences from the code this replaces:
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
// The consumer owns the decoder and its own counters -- it calls pushChar()
// from decoder.onChar() and squelchBreak() from decoder.onEvent(). This module
// only owns the DOM.
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
  const SQUELCH_NEWLINE_THROTTLE_MS = 2000;

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

  // options:
  //   el          the scrolling log container
  //   maxChars    scrollback budget in characters
  //   floorRgb    weak-signal colour, default floorRgbFrom(el)
  //   ceilRgb     strong-signal colour, default white -- brighter than --text
  //               on purpose, a deliberate two-ended widen of the gradient
  //   hotRgb      exceptionally-strong colour, default bright green
  //   floorDb/ceilDb/hotDb   |snrDb| mapped across the two ramps
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
    const throttleMs = options.squelchNewlineThrottleMs || SQUELCH_NEWLINE_THROTTLE_MS;
    const onToken = options.onToken || (() => {});

    let openWordSpan = null;
    let lastSquelchNewlineAt = 0;
    let lastEcho = null;   // {container, timers}

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

    function trim() {
      while (el.textContent.length > maxChars && el.firstChild)
        el.removeChild(el.firstChild);
    }

    function scrollToEnd() { el.scrollTop = el.scrollHeight; }

    function pushChar(ch, meta) {
      const isBreak = ch === " " || ch === "\n" || ch === "\r";
      if (isBreak) {
        openWordSpan = null;
        if (ch !== "\r") el.appendChild(document.createTextNode(ch));
      } else {
        if (!openWordSpan) {
          openWordSpan = document.createElement("span");
          openWordSpan.className = "rtty-tok";
          el.appendChild(openWordSpan);
        }
        // One span per character (same shape as the TX echo below, just
        // coloured by signal strength instead of elapsed send time) so each
        // can carry its own SNR-derived colour. .rtty-tok's own click/hover
        // still targets the whole word via closest()/textContent --
        // unaffected by this nesting. Written as a custom property, not
        // style.color, so `.rtty-tok:hover .rtty-rx-char` can win by ordinary
        // specificity.
        const charSpan = document.createElement("span");
        charSpan.className = "rtty-rx-char";
        charSpan.textContent = ch;
        const color = colorForSnr(meta && meta.snrDb);
        if (color) charSpan.style.setProperty("--rtty-rx-char-color", color);
        openWordSpan.appendChild(charSpan);
      }
      trim();
      scrollToEnd();
    }

    // On every squelch close->open transition, insert a line break. Throttled,
    // measured from the last break actually INSERTED (not from the last
    // squelch-open event), so a signal fluttering near the threshold can't
    // spam the log -- events in between are silently dropped, no delayed
    // catch-up insert. Skipped entirely while the log is still empty: a break
    // only makes sense as a separator BETWEEN receptions, not as a lone blank
    // leading line, and that skip does NOT consume the throttle window, so the
    // first real reception still gets its own break without an artificial wait.
    function squelchBreak() {
      if (el.childNodes.length === 0) return false;
      const now = Date.now();
      if (now - lastSquelchNewlineAt < throttleMs) return false;
      lastSquelchNewlineAt = now;
      // A squelch close mid-word (the tail of a transmission cut off before a
      // natural word break) leaves openWordSpan pointing at that unfinished
      // span -- without this, the NEXT reception's characters would keep
      // appending to it, landing in DOM order BEFORE the break we're about to
      // insert instead of after it.
      openWordSpan = null;
      el.appendChild(document.createTextNode("\n"));
      trim();
      scrollToEnd();
      return true;
    }

    // Wipes the log itself, not the decoder state -- squelch/AFC/tone tracking
    // all live in the decoder/settings and must keep running exactly as
    // before. openWordSpan is reset so the next decoded character starts a
    // fresh token instead of resuming one whose DOM node just got removed.
    // lastEcho is left alone: markEchoFailed() only ever touches it through
    // container.isConnected, already false once this clears the log, so a send
    // still in flight fails silently-safe rather than throwing.
    function clear() {
      el.textContent = "";
      openWordSpan = null;
    }

    // This station's own sent text, echoed into the log like a monitor -- NOT
    // a .rtty-tok (no click/hover: the operator's own callsign in
    // "CQ CQ DE OK1HRA" must never be mistaken for a station to log).
    //
    // Displayed uppercase (what actually goes out -- both TX methods already
    // uppercase at the encoding stage, this just makes the echo agree) and
    // coloured in per character rather than red all at once: each character
    // starts grey and steps to red at its own estimated transmit time, from
    // RttyCodec.charStartTimes() -- the real Baudot frame sequence, so FIGS/
    // LTRS shifts and characters with no Baudot mapping don't throw a flat
    // per-character count off. This does not try to track real playback:
    // external FSK over TrxNet has no observable completion signal anyway, so
    // elapsed wall time against this estimate is the whole design, for both
    // TX methods alike.
    function echoTx(text) {
      openWordSpan = null;   // don't let a live RX token keep growing into this
      // A TX send that lands mid-word (RX decoding "HELLO" with no trailing
      // space yet) used to run the echoed text straight onto the end of that
      // unfinished RX line. One leading break, skipped when the log is already
      // empty or already ends on one, so back-to-back sends never grow a
      // widening gap.
      if (el.textContent && !el.textContent.endsWith("\n"))
        el.appendChild(document.createTextNode("\n"));

      const upper = String(text).toUpperCase();
      const container = document.createElement("span");
      container.className = "rtty-tx-echo";
      const charSpans = Array.from(upper, ch => {
        const span = document.createElement("span");
        span.className = "rtty-tx-char";
        span.textContent = ch;
        container.appendChild(span);
        return span;
      });
      el.appendChild(container);
      el.appendChild(document.createTextNode("\n"));
      trim();
      scrollToEnd();

      const timers = RttyCodec.charStartTimes(upper).map(({index, startMs}) =>
        setTimeout(() => {
          const span = charSpans[index];
          if (span && span.isConnected) span.classList.add("lit");
        }, startMs));
      lastEcho = {container, timers};
      return lastEcho;
    }

    // Retracts an echo whose send then failed, rather than leaving a false
    // "sent" line for a message that never went out -- the RX log is the one
    // place QRPlog cross-references what was sent, and it had no way to tell a
    // genuine send from a failed attempt.
    function markEchoFailed(echo) {
      if (!echo || !echo.container.isConnected) return;   // trimmed out of the log already
      echo.timers.forEach(clearTimeout);   // whatever hasn't lit yet stays grey, no catch-up
      echo.container.classList.add("rtty-tx-echo-failed");
      echo.container.appendChild(document.createTextNode(" (failed)"));
    }

    const onClick = event => {
      const token = event.target.closest(".rtty-tok");
      if (!token) return;
      const word = token.textContent.trim();
      if (!word) return;
      onToken(word, event);
    };
    el.addEventListener("click", onClick);

    function destroy() {
      el.removeEventListener("click", onClick);
      if (lastEcho) lastEcho.timers.forEach(clearTimeout);
      lastEcho = null;
    }

    return {
      pushChar, squelchBreak, clear, echoTx, markEchoFailed, destroy,
      lastEcho: () => lastEcho,
      forgetEcho: () => { lastEcho = null; },
      colorForSnr,
    };
  }

  return {create, cssVarRgb, floorRgbFrom,
          DEFAULT_FLOOR_DB, DEFAULT_CEIL_DB, DEFAULT_HOT_DB, DEFAULT_HOT_RGB};
}));
