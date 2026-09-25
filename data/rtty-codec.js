// Baudot/ITA2 RTTY codec -- AFSK encoder (TX, audio-stream method) and
// Goertzel bit-sync decoder (RX). Fixed 45.45 Bd / 170 Hz shift, see
// docs/rtty-implementace.md §1 decision 1-2. Consumed by data/rtty.js (the
// DATA sub-page) only -- an earlier design had data/log.js's QRPlog audio-TX
// path share this module directly, which docs/rtty-implementace.md §8.3
// (revised 2026-08-27) replaced with a BroadcastChannel hand-off to whichever
// RTTY-ICOM tab already holds the AUD1 session instead, so log.js never loads
// this file. Kept as a plain, page-agnostic Encoder/Decoder pair rather than
// the data.js registerModem() Decoder/Encoder base classes from
// docs/modem-implementation.md regardless (this page doesn't use that
// registry) -- and TABLE/textToBaudot/baudotToFrames stay exported alongside
// Encoder/Decoder (code-review: currently only Encoder/Decoder/SHIFT_HZ have
// an external caller) because they are the pieces most worth unit-testing in
// isolation from a full encode-decode round trip -- e.g. verifying a specific
// ITA2 code against the wifilt.ino table this was transcribed from without
// having to demodulate synthesized audio to do it.
//
// horusdemodlib (github.com/projecthorus/horus-gui) is cited in the design
// doc only as an FSK-demod *technique* inspiration (Goertzel tone detection,
// bit sync, continuous-phase TX) -- its own protocol is Horus Binary balloon
// telemetry, unrelated to ham Baudot RTTY, and nothing here is ported from it.
(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.RttyCodec = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const BAUD = 45.45;          // wifilt.ino's own BaudRateFSK constant, kept identical
  const SHIFT_HZ = 170;        // on purpose (see docs/rtty-implementace.md §3)
  const CODE_FIGS = 27;        // 11011
  const CODE_LTRS = 31;        // 11111
  const CODE_SPACE = 4;        // 00100

  // [ltrsChar, figsChar] per 5-bit ITA2 code. Bit order throughout this file is
  // bit0=first-transmitted..bit4=last-transmitted, matching wifilt.ino's d1..d5
  // (sendFsk() clocks d1 out first). Codes 0-26/28-30 that the firmware's own
  // chTable() (wifilt.ino:7459-7522) maps from an ASCII character are transcribed
  // verbatim from there -- letters, digits, space, CR, LF, and - ? : ( ) . , / +
  // (the last one is FIGS code 17, tagged "//ITA2" in wifilt.ino itself). The 7
  // codes chTable() never emits (5, 9, 11, 13, 20, 26, 30's *unmapped* half is
  // moot -- those 7 have no ASCII source there at all) are filled from the
  // standard international ITA2 figures assignment for RX compatibility with
  // other stations' TX gear; ham RTTY QSO traffic essentially never uses BELL/
  // WRU/'/$/!/&/#/;, so a wrong guess on the rarer ones costs nothing in practice.
  const TABLE = [
    [null, null],   // 0  blank
    ["E", "3"],      // 1
    ["\n", "\n"],    // 2  LF
    ["A", "-"],       // 3
    [" ", " "],       // 4  SPACE
    ["S", "'"],       // 5
    ["I", "8"],       // 6
    ["U", "7"],       // 7
    ["\r", "\r"],     // 8  CR
    ["D", "$"],       // 9
    ["R", "4"],       // 10
    ["J", ""],        // 11 BELL (non-printing either way)
    ["N", ","],       // 12
    ["F", "!"],       // 13
    ["C", ":"],       // 14
    ["K", "("],       // 15
    ["T", "5"],       // 16
    ["Z", "+"],       // 17 verified against wifilt.ino:7512 ("//ITA2")
    ["L", ")"],       // 18
    ["W", "2"],       // 19
    ["H", "#"],       // 20
    ["Y", "6"],       // 21
    ["P", "0"],       // 22
    ["Q", "1"],       // 23
    ["O", "9"],       // 24
    ["B", "?"],       // 25
    ["G", "&"],       // 26
    null,             // 27 FIGS shift
    ["M", "."],       // 28
    ["X", "/"],       // 29
    ["V", ";"],       // 30
    null,             // 31 LTRS shift
  ];

  // char -> {code, page}; page is null for the 3 codes valid in either page
  // (SPACE/CR/LF) so sending them never forces a shift.
  const SHARED_CODES = new Set([2, 4, 8]);
  const CHAR_TO_CODE = new Map();
  for (let code = 0; code < 32; code++) {
    const entry = TABLE[code];
    if (!entry) continue;
    const [ltrsChar, figsChar] = entry;
    const shared = SHARED_CODES.has(code);
    if (ltrsChar && !CHAR_TO_CODE.has(ltrsChar))
      CHAR_TO_CODE.set(ltrsChar, {code, page: shared ? null : "L"});
    if (figsChar && figsChar !== ltrsChar && !CHAR_TO_CODE.has(figsChar))
      CHAR_TO_CODE.set(figsChar, {code, page: shared ? null : "F"});
  }

  // Text -> [{code, page}], uppercased; characters with no Baudot representation
  // are dropped (wifilt.ino's GPIO path instead silently substitutes a space --
  // dropping is preferred here so a typo doesn't key an extra, misleading space).
  function textToBaudot(text) {
    const out = [];
    for (const rawChar of String(text).toUpperCase()) {
      const entry = CHAR_TO_CODE.get(rawChar);
      if (entry) out.push(entry);
    }
    return out;
  }

  // Whether a character that wants `want` needs a shift frame first. Besides
  // the plain page change, FIGS is re-sent after every SPACE: a receiver with
  // unshift-on-space (USOS -- this decoder's default, and MMTTY's/N1MM's)
  // falls back to LTRS on a space, so "599 001" sent without it reads
  // "599 PPQ" there. The extra FIGS costs one frame and is harmless to a
  // receiver without USOS; wifilt.ino's own FSK sender already does exactly
  // this (the `space == 1 && fig2 == 1` branch in its send loop).
  function needsShift(want, page, afterSpace) {
    return !!want && (want !== page || (want === "F" && afterSpace));
  }

  // [{code, page}] -> [code,...] with LTRS/FIGS shift codes inserted on page
  // change (and FIGS after a space, see needsShift()). startPage defaults to
  // LTRS, matching both this decoder's own initial state and every other
  // Baudot terminal's reset condition.
  function baudotToFrames(chars, startPage = "L") {
    const frames = [];
    let page = startPage, afterSpace = false;
    for (const {code, page: want} of chars) {
      if (needsShift(want, page, afterSpace)) {
        frames.push(want === "F" ? CODE_FIGS : CODE_LTRS);
        page = want;
      }
      frames.push(code);
      afterSpace = code === CODE_SPACE;
    }
    return frames;
  }

  // One Baudot frame (1 start + 5 data + 1.5 stop = 7.5 bit periods) at the
  // fixed 45.45 Bd, in ms -- the char/frame duration RTTY-ICOM's TX echo
  // colouring (rtty.js's echoTxText()) and its AFC rate setting (Hz/char)
  // both key off, so the two features agree on what "one character" costs in
  // wall time without either duplicating the arithmetic.
  const CHAR_DURATION_MS = 1000 * 7.5 / BAUD;

  // Per-VISIBLE-character start time (ms from the first frame) for `text`,
  // matching the exact frame sequence encode() would actually produce --
  // including a FIGS/LTRS shift frame where the page changes (no visible
  // character of its own) and skipping characters with no Baudot mapping at
  // all (silently dropped, same as textToBaudot() -- never transmitted, so
  // never assigned a time). Grilled 2026-08-28 (3rd session, RTTY TX-echo
  // colouring): a naive text.length*CHAR_DURATION_MS would drift out of sync
  // on any message that switches between letters and figures, or that
  // contains a character outside the Baudot set. Returns one entry per
  // encodable character, in original string order, {index, startMs} where
  // index is the position in text.toUpperCase() -- the caller doesn't need
  // to re-uppercase to line indices up, since textToBaudot() also uppercases
  // before matching.
  function charStartTimes(text, startPage = "L") {
    const upper = String(text).toUpperCase();
    const out = [];
    let page = startPage, frame = 0, afterSpace = false;
    for (let i = 0; i < upper.length; i++) {
      const entry = CHAR_TO_CODE.get(upper[i]);
      if (!entry) continue;
      if (needsShift(entry.page, page, afterSpace)) { frame++; page = entry.page; }
      out.push({index: i, startMs: frame * CHAR_DURATION_MS});
      frame++;
      afterSpace = entry.code === CODE_SPACE;
    }
    return out;
  }

  class Encoder {
    // `reverse` (grilled 2026-08-28, 2nd session, item 3) swaps which of the
    // two physical tones is transmitted for a mark bit vs a space bit --
    // deliberately its own constructor option, separate from Decoder's
    // `reverse`/setReverse(). The two are independent settings for a reason:
    // Decoder's reverse is RX-only decode compatibility with a station whose
    // TX happens to be inverted, re-toggled per contact; this one is what
    // THIS station's own encoder actually puts on the air, a station-level
    // choice that must not flip just because the operator flipped the other
    // one to read somebody else's backward signal mid-QSO.
    constructor(sampleRate, {toneHz = 1500, shiftHz = SHIFT_HZ, baud = BAUD,
                 amplitude = 0.5, reverse = false} = {}) {
      this.sampleRate = sampleRate;
      this.toneHz = toneHz;
      this.shiftHz = shiftHz;
      this.baud = baud;
      this.amplitude = amplitude;
      this.reverse = reverse;
    }

    setToneOffset(hz) { this.toneHz = hz; }

    // text -> Int16Array PCM @ sampleRate. Continuous-phase 2FSK; each Baudot
    // character is 1 start (space) + 5 data + 1.5 stop (mark) = 7.5 bit periods.
    // Bit boundaries use a cumulative floor accumulator (docs/rtty-implementace.md
    // §3) because samples/bit is never an integer (1056.106 @ 48 kHz) -- a fixed
    // Math.round(spb) step would drift audibly over a long message. The result is
    // padded with trailing mark-tone samples to a multiple of 6 so every AUD1
    // TX_PCM16 packet (packetizeTxPcm48k's fixed 960-sample chunks, including a
    // short final one) satisfies the firmware's (length-40)%12==0 wire check.
    encode(text) {
      const frames = baudotToFrames(textToBaudot(text), "L");
      if (frames.length === 0) return new Int16Array(0);

      const samplesPerBit = this.sampleRate / this.baud;
      const upperHz = this.toneHz + this.shiftHz / 2;
      const lowerHz = this.toneHz - this.shiftHz / 2;
      const markHz = this.reverse ? lowerHz : upperHz;
      const spaceHz = this.reverse ? upperHz : lowerHz;

      const segments = [];
      for (const code of frames) {
        segments.push(false);                                   // start: space
        for (let bit = 0; bit < 5; bit++) segments.push(((code >> bit) & 1) === 1); // d1..d5
        segments.push("stop");                                  // stop: mark, 1.5 units
      }

      let cumUnits = 0;
      const boundaries = [0];
      for (const seg of segments) {
        cumUnits += seg === "stop" ? 1.5 : 1;
        boundaries.push(Math.floor(cumUnits * samplesPerBit));
      }
      const totalSamples = boundaries[boundaries.length - 1];

      const pcm = new Float32Array(totalSamples);
      let phase = 0, sampleIndex = 0;
      for (let i = 0; i < segments.length; i++) {
        const isMark = segments[i] === "stop" || segments[i] === true;
        const dphi = 2 * Math.PI * (isMark ? markHz : spaceHz) / this.sampleRate;
        const segEnd = boundaries[i + 1];
        for (; sampleIndex < segEnd; sampleIndex++) {
          pcm[sampleIndex] = this.amplitude * Math.sin(phase);
          phase += dphi;
        }
        if (phase > 1e6) phase %= 2 * Math.PI; // keep bounded on very long messages
      }

      const padCount = (6 - (totalSamples % 6)) % 6;
      let out = pcm;
      if (padCount > 0) {
        out = new Float32Array(totalSamples + padCount);
        out.set(pcm);
        const dphi = 2 * Math.PI * markHz / this.sampleRate; // idle condition = mark
        for (let i = 0; i < padCount; i++) {
          out[totalSamples + i] = this.amplitude * Math.sin(phase);
          phase += dphi;
        }
      }

      const pcm16 = new Int16Array(out.length);
      for (let i = 0; i < out.length; i++)
        pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(out[i] * 32767)));
      return pcm16;
    }
  }

  function goertzelMag(buf, n, hz, sampleRate) {
    const coeff = 2 * Math.cos(2 * Math.PI * hz / sampleRate);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const s0 = buf[i] + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }

  // Goertzel(markHz)/Goertzel(spaceHz) over a sliding window, re-evaluated every
  // hopSize samples, feeding a classic async start-bit-edge bit synchronizer:
  // idle until a mark->space transition while squelch is open, then sample bit
  // centers at fixed offsets from that edge. Never assumes a fixed
  // pushSamples() block size (per docs/modem-implementation.md §1) -- samples
  // are folded into the ring buffer one at a time regardless of how they arrived.
  //
  // Signal-from-noise separation (docs/rtty-implementace.md §20, measured
  // offline with tools/rtty-bench/ before any of it went in -- each piece is
  // there for one channel and was checked not to cost in the others):
  //   * window: 188 samples (23.5 ms) with a Hann taper. 170 Hz is exactly 4
  //     bins at that length, so each tone sits in a null of the other's
  //     filter, and the Hann sidelobes keep a neighbouring station out: a
  //     station 300 Hz away is tolerated ~12 dB louder than with the old
  //     96-sample rectangle, white noise gains ~1 dB.
  //   * ATC (fldigi's "optimal ATC", Kok Chen W7AY): mark and space envelopes
  //     plus a noise floor set the decision threshold, instead of plain
  //     mark - space. Selective fading otherwise moves the zero crossing that
  //     marks the start bit -- the further the longer the window, which is
  //     why the long window is ONLY safe together with ATC (alone it floors
  //     at 5-40 % CER in fading). Envelope decay is 4 bits, not fldigi's 16:
  //     16 leaves a floor on 2 Hz fading.
  //   * noise blanker: a sample above NB_K x running RMS zeroes it and the
  //     next NB_HANG samples -- static crashes, ~7 dB, neutral elsewhere.
  //   * squelch against the noise, not against loudness: in RTTY one tone is
  //     always off, so the weaker Goertzel IS the noise; |mark - space| over
  //     about one character is the signal. squelchDb is dB above that noise
  //     (0 = never gates). The old absolute-magnitude threshold depended on
  //     the LAN audio level: at one level it passed nothing, at another it
  //     cost 5 dB, at a third it let garbage through.
  //   * USOS (unshift on space), switchable -- see _emitCode().
  const NB_K = 5, NB_HANG = 24;
  const ATC_DECAY_BITS = 4;
  const SQUELCH_HYSTERESIS_DB = 1;

  const hannCache = new Map();
  function hannWindow(n) {
    let w = hannCache.get(n);
    if (!w) {
      w = new Float32Array(n);
      for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / n);
      hannCache.set(n, w);
    }
    return w;
  }

  class Decoder {
    constructor(sampleRate, {toneHz = 1500, shiftHz = SHIFT_HZ, baud = BAUD,
                 reverse = false, squelchDb = 3, usos = true, windowSize = 188,
                 hopSize = 8, noiseBlanker = true, bitDecision = "point",
                 intFrac = 0.7, dpll = false} = {}) {
      this.sampleRate = sampleRate;
      this.toneHz = toneHz; this.shiftHz = shiftHz; this.baud = baud;
      this.reverse = reverse; this.squelchDb = squelchDb; this.usos = usos;
      this.windowSize = windowSize; this.hopSize = hopSize;
      this.noiseBlanker = noiseBlanker;
      // DEC 2 (§21) is this same decoder with bitDecision "integrate" and the
      // DPLL flywheel on; DEC 1 keeps the defaults (point sample, no DPLL).
      this.bitDecision = bitDecision; this.intFrac = intFrac; this.dpll = dpll;
      this.bitAcc = 0; this.expectStart = -Infinity;
      this._onChar = null; this._onEvent = null;

      this.ring = new Float32Array(windowSize);
      this.scratch = new Float32Array(windowSize);
      this.window = hannWindow(windowSize);
      this.ringPos = 0; this.ringCount = 0;
      this.samplesSinceHop = 0; this.totalSamples = 0;

      this.page = "L";
      this.squelchOpen = squelchDb <= 0;
      this.lastMarkMag = 0; this.lastSpaceMag = 0; this.lastSnrDb = -Infinity;

      this.syncState = "searching"; // 'searching' | 'framing'
      this.frameStartSample = 0;
      this.bitIndex = 0;   // 0=start, 1..5=data (d1..d5), 6=stop check
      this.dataBits = 0;
      this.prevBeta = 0;

      this._resetTracking();
    }

    _resetTracking() {
      this.markEnv = 0; this.spaceEnv = 0; this.noiseFloor = 0;   // ATC, amplitudes
      this.sqSignal = 0; this.sqNoise = 0;                         // squelch, powers
      this.noiseSnrDb = -Infinity;
      this.nbRms = 0; this.nbHang = 0;
      this.closedEdgeSample = -Infinity;
    }

    setToneOffset(hz) { this.toneHz = hz; }
    setReverse(reverse) { this.reverse = reverse; }
    setSquelchDb(db) {
      this.squelchDb = db;
      if (!(db > 0) && !this.squelchOpen) {
        this.squelchOpen = true;
        if (this._onEvent) this._onEvent({type: "squelch", open: true});
      }
    }
    setUsos(usos) { this.usos = !!usos; }
    onChar(cb) { this._onChar = cb; return this; }
    onEvent(cb) { this._onEvent = cb; return this; }

    reset() {
      this.page = "L"; this.syncState = "searching";
      this.ringCount = 0; this.samplesSinceHop = 0; this.prevBeta = 0;
      this._resetTracking();
    }

    // Blanks impulses. The RMS reference is updated on EVERY sample, with the
    // pulse clipped to the threshold -- updating it only outside blanking
    // lets it freeze low and then blank everything forever.
    _blank(x) {
      const a = Math.abs(x);
      const limit = NB_K * this.nbRms;
      if (this.nbRms > 0 && a > limit) this.nbHang = NB_HANG;
      const c = this.nbRms > 0 ? Math.min(a, limit) : a;
      this.nbRms = Math.sqrt(this.nbRms * this.nbRms * 0.998 + c * c * 0.002);
      if (this.nbHang > 0) { this.nbHang--; return 0; }
      return x;
    }

    // ATC decision value for amplitudes m/s: > 0 means mark. Antisymmetric in
    // (mark, space), so REVERSE is a plain sign flip.
    _atc(m, s, hopsPerBit) {
      const attack = hopsPerBit / 4, decay = hopsPerBit * ATC_DECAY_BITS;
      this.markEnv += (m - this.markEnv) / (m > this.markEnv ? attack : decay);
      this.spaceEnv += (s - this.spaceEnv) / (s > this.spaceEnv ? attack : decay);
      const low = Math.min(m, s);
      this.noiseFloor += (low - this.noiseFloor) /
        (low < this.noiseFloor ? attack : hopsPerBit * 48);
      const nf = this.noiseFloor;
      const mc = Math.max(nf, Math.min(m, this.markEnv));
      const sc = Math.max(nf, Math.min(s, this.spaceEnv));
      const me = this.markEnv - nf, se = this.spaceEnv - nf;
      return (mc - nf) * me - (sc - nf) * se - 0.25 * (me * me - se * se);
    }

    _updateSquelch(markMag, spaceMag, hopsPerBit) {
      const alpha = 1 / (hopsPerBit * 7.5);   // about one character
      this.sqSignal += alpha * (Math.abs(markMag - spaceMag) - this.sqSignal);
      this.sqNoise += alpha * (Math.min(markMag, spaceMag) - this.sqNoise);
      // On noise alone E|m - s| = 2 E min(m, s) for two exponential powers,
      // so the /2 puts pure noise at ~0 dB.
      this.noiseSnrDb = 10 * Math.log10(Math.max(this.sqSignal / 2, 1e-30) /
                                        Math.max(this.sqNoise, 1e-30));
      const db = this.squelchDb;
      const open = !(db > 0) ||
        (this.squelchOpen ? this.noiseSnrDb >= db - SQUELCH_HYSTERESIS_DB : this.noiseSnrDb >= db);
      if (open !== this.squelchOpen) {
        this.squelchOpen = open;
        if (this._onEvent) this._onEvent({type: "squelch", open});
      }
    }

    pushSamples(float32) {
      const markHz = this.toneHz + this.shiftHz / 2;
      const spaceHz = this.toneHz - this.shiftHz / 2;
      const samplesPerBit = this.sampleRate / this.baud;
      const hopsPerBit = samplesPerBit / this.hopSize;
      const n = this.windowSize, win = this.window;

      for (let i = 0; i < float32.length; i++) {
        this.ring[this.ringPos] = this.noiseBlanker ? this._blank(float32[i]) : float32[i];
        this.ringPos = (this.ringPos + 1) % n;
        if (this.ringCount < n) this.ringCount++;
        this.totalSamples++;
        this.samplesSinceHop++;

        if (this.ringCount < n || this.samplesSinceHop < this.hopSize) continue;
        this.samplesSinceHop = 0;

        const tailLen = n - this.ringPos;
        this.scratch.set(this.ring.subarray(this.ringPos), 0);
        this.scratch.set(this.ring.subarray(0, this.ringPos), tailLen);
        for (let k = 0; k < n; k++) this.scratch[k] *= win[k];
        const markMag = goertzelMag(this.scratch, n, markHz, this.sampleRate);
        const spaceMag = goertzelMag(this.scratch, n, spaceHz, this.sampleRate);
        this.lastMarkMag = markMag; this.lastSpaceMag = spaceMag;

        this._updateSquelch(markMag, spaceMag, hopsPerBit);
        let beta = this._atc(Math.sqrt(markMag), Math.sqrt(spaceMag), hopsPerBit);
        if (this.reverse) beta = -beta;
        const now = this.totalSamples;

        if (!this.squelchOpen) {
          // Remember the last mark->space edge seen while closed (forgotten
          // once the line goes back to mark): the squelch averages over about
          // a character, so it opens late -- often already inside the first
          // start bit of a station that keys straight into text with no idle
          // MARK first (this page's own Encoder does exactly that).
          if (this.prevBeta >= 0 && beta < 0) this.closedEdgeSample = now;
          else if (beta >= 0) this.closedEdgeSample = -Infinity;
          this.syncState = "searching";
          this.expectStart = -Infinity;
          this.prevBeta = beta;
          continue;
        }

        if (this.syncState === "searching") this._search(beta, now, samplesPerBit);
        else this._frame(beta, now, samplesPerBit);

        this.prevBeta = beta;
      }
    }

    _beginFrame(start) {
      this.frameStartSample = start;
      this.syncState = "framing";
      this.bitIndex = 0;
      this.dataBits = 0;
      this.bitAcc = 0;
    }

    _search(beta, now, samplesPerBit) {
      const edge = this.prevBeta >= 0 && beta < 0;
      if (this.dpll && this.expectStart > -Infinity) {
        // Continuous traffic: the next start bit is due 7.5 bits after the
        // last good one. An "edge" inside that stop bit can only be noise; a
        // real edge near the prediction is averaged with it; no edge at all
        // but SPACE where the start bit should be is taken on the prediction
        // (the flywheel); MARK there means the sender went idle.
        if (now < this.expectStart - 0.5 * samplesPerBit) return;
        if (edge) {
          const err = now - this.expectStart;
          this._beginFrame(Math.abs(err) <= 0.5 * samplesPerBit
            ? Math.round(this.expectStart + 0.5 * err) : now);
        } else if (now >= this.expectStart + 0.5 * samplesPerBit) {
          if (beta < 0) this._beginFrame(this.expectStart);
          else this.expectStart = -Infinity;
        }
        return;
      }
      if (beta < 0 && this.prevBeta < 0 &&
          now - this.closedEdgeSample <= samplesPerBit) {
        // just opened inside a start bit: frame from its real edge
        this._beginFrame(this.closedEdgeSample);
        this.closedEdgeSample = -Infinity;
      } else if (edge) this._beginFrame(now);
    }

    _frame(beta, now, samplesPerBit) {
      const centre = this.frameStartSample + (this.bitIndex + 0.5) * samplesPerBit;
      if (this.bitDecision === "integrate") {
        // Sum the decision value over the middle intFrac of the bit instead
        // of reading one point at its centre (DEC 2, §21).
        const half = this.intFrac * samplesPerBit / 2;
        if (now >= centre - half) this.bitAcc += beta;
        if (now < centre + half) return;
        const isMark = this.bitAcc > 0;
        this.bitAcc = 0;
        this._bit(isMark, samplesPerBit);
      } else if (now >= this.frameStartSample + Math.round((this.bitIndex + 0.5) * samplesPerBit)) {
        this._bit(beta > 0, samplesPerBit);
      }
    }

    _bit(isMark, samplesPerBit) {
      if (this.bitIndex === 0) {
        if (isMark) {                       // false start, abandon frame
          this.syncState = "searching";
          this.expectStart = -Infinity;
        }
      } else if (this.bitIndex <= 5) {
        if (isMark) this.dataBits |= (1 << (this.bitIndex - 1));
      } else {
        this.syncState = "searching";
        this.expectStart = this.dpll ? this.frameStartSample + 7.5 * samplesPerBit : -Infinity;
        this._emitCode(this.dataBits);
      }
      this.bitIndex++;
    }

    _emitCode(code) {
      if (code === CODE_FIGS || code === CODE_LTRS) {
        this.page = code === CODE_FIGS ? "F" : "L";
        // A shift prints nothing but takes a character's time on the air; the
        // RX tape (rtty-rxlog.js) needs to know, or "OE3PAN" -- sent as
        // O E FIGS 3 LTRS P A N -- would show a blank on each side of the 3.
        if (this._onEvent) this._onEvent({type: "shift", page: this.page, t: this.frameStartSample});
        return;
      }
      const entry = TABLE[code];
      if (!entry) return;
      const ch = this.page === "F" ? entry[1] : entry[0];
      // USOS: a space drops back to LTRS, so one corrupted FIGS garbles a
      // word instead of the rest of the line (+0.2..1.6 dB, most in fading).
      // A station that sends figures after a space WITHOUT re-sending FIGS
      // reads wrong with it on ("599 001" -> "599 PPQ"); hence the switch.
      if (this.usos && code === CODE_SPACE) this.page = "L";
      if (ch === null || ch === undefined) return;
      const snrDb = 10 * Math.log10(Math.max(this.lastMarkMag, 1e-12) /
                                     Math.max(this.lastSpaceMag, 1e-12));
      if (Number.isFinite(snrDb)) this.lastSnrDb = this.reverse ? -snrDb : snrDb;
      if (this._onChar) this._onChar(ch, {code, page: this.page,
        markMag: this.lastMarkMag, spaceMag: this.lastSpaceMag, snrDb: this.lastSnrDb,
        noiseSnrDb: this.noiseSnrDb,
        // sample index of this character's start bit: two decoders fed the
        // same samples share this clock, which is what lines their output up
        t: this.frameStartSample});
    }
  }

  return {BAUD, SHIFT_HZ, CODE_FIGS, CODE_LTRS, TABLE, CHAR_DURATION_MS,
          textToBaudot, baudotToFrames, charStartTimes, Encoder, Decoder};
});
