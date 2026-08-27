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

  // [{code, page}] -> [code,...] with LTRS/FIGS shift codes inserted on page
  // change. startPage defaults to LTRS, matching both this decoder's own
  // initial state and every other Baudot terminal's reset condition.
  function baudotToFrames(chars, startPage = "L") {
    const frames = [];
    let page = startPage;
    for (const {code, page: want} of chars) {
      if (want && want !== page) {
        frames.push(want === "F" ? CODE_FIGS : CODE_LTRS);
        page = want;
      }
      frames.push(code);
    }
    return frames;
  }

  class Encoder {
    constructor(sampleRate, {toneHz = 1500, shiftHz = SHIFT_HZ, baud = BAUD,
                 amplitude = 0.5} = {}) {
      this.sampleRate = sampleRate;
      this.toneHz = toneHz;
      this.shiftHz = shiftHz;
      this.baud = baud;
      this.amplitude = amplitude;
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
      const markHz = this.toneHz + this.shiftHz / 2;
      const spaceHz = this.toneHz - this.shiftHz / 2;

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
  // hopSize samples (~22x oversampled per bit at the default 8 samples/hop vs.
  // ~176 samples/bit @ 8 kHz -- docs/rtty-implementace.md §5 window sizing note),
  // feeding a classic async start-bit-edge bit synchronizer: idle until a
  // mark->space transition while squelch is open, then sample bit centers at
  // fixed offsets from that edge via the same floor-accumulator idea as the
  // encoder. Never assumes a fixed pushSamples() block size (per
  // docs/modem-implementation.md §1) -- samples are folded into the ring buffer
  // one at a time regardless of how they arrived.
  class Decoder {
    constructor(sampleRate, {toneHz = 1500, shiftHz = SHIFT_HZ, baud = BAUD,
                 reverse = false, squelchThreshold = 4, windowSize = 96,
                 hopSize = 8} = {}) {
      this.sampleRate = sampleRate;
      this.toneHz = toneHz; this.shiftHz = shiftHz; this.baud = baud;
      this.reverse = reverse; this.squelchThreshold = squelchThreshold;
      this.windowSize = windowSize; this.hopSize = hopSize;
      this._onChar = null; this._onEvent = null;

      this.ring = new Float32Array(windowSize);
      this.scratch = new Float32Array(windowSize);
      this.ringPos = 0; this.ringCount = 0;
      this.samplesSinceHop = 0; this.totalSamples = 0;

      this.page = "L";
      this.squelchOpen = false;
      this.lastMarkMag = 0; this.lastSpaceMag = 0; this.lastSnrDb = -Infinity;

      this.syncState = "searching"; // 'searching' | 'framing'
      this.frameStartSample = 0;
      this.bitIndex = 0;   // 0=start, 1..5=data (d1..d5), 6=stop check
      this.dataBits = 0;
      this.prevBeta = 0;
    }

    setToneOffset(hz) { this.toneHz = hz; }
    setReverse(reverse) { this.reverse = reverse; }
    setSquelchThreshold(v) { this.squelchThreshold = v; }
    onChar(cb) { this._onChar = cb; return this; }
    onEvent(cb) { this._onEvent = cb; return this; }

    reset() {
      this.page = "L"; this.syncState = "searching";
      this.ringCount = 0; this.samplesSinceHop = 0; this.prevBeta = 0;
    }

    pushSamples(float32) {
      const markHz = this.toneHz + this.shiftHz / 2;
      const spaceHz = this.toneHz - this.shiftHz / 2;
      const samplesPerBit = this.sampleRate / this.baud;
      const n = this.windowSize;

      for (let i = 0; i < float32.length; i++) {
        this.ring[this.ringPos] = float32[i];
        this.ringPos = (this.ringPos + 1) % n;
        if (this.ringCount < n) this.ringCount++;
        this.totalSamples++;
        this.samplesSinceHop++;

        if (this.ringCount < n || this.samplesSinceHop < this.hopSize) continue;
        this.samplesSinceHop = 0;

        const tailLen = n - this.ringPos;
        this.scratch.set(this.ring.subarray(this.ringPos), 0);
        this.scratch.set(this.ring.subarray(0, this.ringPos), tailLen);
        const markMag = goertzelMag(this.scratch, n, markHz, this.sampleRate);
        const spaceMag = goertzelMag(this.scratch, n, spaceHz, this.sampleRate);
        this.lastMarkMag = markMag; this.lastSpaceMag = spaceMag;

        const wasOpen = this.squelchOpen;
        this.squelchOpen = (markMag + spaceMag) >= this.squelchThreshold;
        if (this.squelchOpen !== wasOpen && this._onEvent)
          this._onEvent({type: "squelch", open: this.squelchOpen});

        let beta = markMag - spaceMag; // >0 => mark, <0 => space, before reverse
        if (this.reverse) beta = -beta;
        const now = this.totalSamples;

        if (!this.squelchOpen) {
          this.syncState = "searching";
          this.prevBeta = beta;
          continue;
        }

        if (this.syncState === "searching" && this.prevBeta >= 0 && beta < 0) {
          this.frameStartSample = now;
          this.syncState = "framing";
          this.bitIndex = 0;
          this.dataBits = 0;
        } else if (this.syncState === "framing") {
          const targetSample = this.frameStartSample +
            Math.round((this.bitIndex + 0.5) * samplesPerBit);
          if (now >= targetSample) {
            const bitIsMark = beta > 0;
            if (this.bitIndex === 0) {
              if (bitIsMark) this.syncState = "searching"; // false start, abandon frame
            } else if (this.bitIndex <= 5) {
              if (bitIsMark) this.dataBits |= (1 << (this.bitIndex - 1));
            } else {
              this._emitCode(this.dataBits);
              this.syncState = "searching";
            }
            this.bitIndex++;
          }
        }

        this.prevBeta = beta;
      }
    }

    _emitCode(code) {
      if (code === CODE_FIGS) { this.page = "F"; return; }
      if (code === CODE_LTRS) { this.page = "L"; return; }
      const entry = TABLE[code];
      if (!entry) return;
      const ch = this.page === "F" ? entry[1] : entry[0];
      if (ch === null || ch === undefined) return;
      const snrDb = 10 * Math.log10(Math.max(this.lastMarkMag, 1e-12) /
                                     Math.max(this.lastSpaceMag, 1e-12));
      if (Number.isFinite(snrDb)) this.lastSnrDb = this.reverse ? -snrDb : snrDb;
      if (this._onChar) this._onChar(ch, {code, page: this.page,
        markMag: this.lastMarkMag, spaceMag: this.lastSpaceMag, snrDb: this.lastSnrDb});
    }
  }

  return {BAUD, SHIFT_HZ, CODE_FIGS, CODE_LTRS, TABLE,
          textToBaudot, baudotToFrames, Encoder, Decoder};
});
