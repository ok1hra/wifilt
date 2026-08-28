// Audio waterfall shared by the two DATA sub-pages. Extracted verbatim from
// data.js, which grew it for JS8Call; WSPR-Beacon draws the same picture over
// the same RX audio and only paints a different overlay on top.
//
// Owns: the FFT, the sample ring, the AGC, the colour ramp and the scrolling
// canvas. Deliberately does NOT own: what the overlay says (band edges, TX
// markers, rulers) or when to stop ingesting -- both are page policy and arrive
// as callbacks, because the pages genuinely disagree. JS8Call stops the
// analyser while transmitting; the beacon keeps drawing, since the radio sends
// RX audio through the transmission and that is the operator's only sight of
// their own signal.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Spectrum = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {

  // Blue -> cyan -> yellow, with the knee pushed high so noise stays dark and a
  // real signal is the only thing that reaches the warm end.
  function color(value) {
    const v = Math.pow(Math.max(0, Math.min(1, value)), 1.8);
    const mix = (a, b, t) => a.map((channel, index) => Math.round(channel + (b[index] - channel) * t));
    if (v < .55) return mix([0, 2, 20], [0, 42, 145], v / .55);
    if (v < .92) return mix([0, 42, 145], [0, 180, 205], (v - .55) / .37);
    return mix([0, 180, 205], [255, 215, 55], (v - .92) / .08);
  }

  class Waterfall {
    // `markRow` runs with the 2D context right after a new row lands, while it
    // is still the top row: JS8Call uses it to burn a slot-boundary ruler that
    // then scrolls down with the history.
    constructor({canvas, overlay, container, sampleRate = 8000,
                 lowHz = 500, highHz = 2700, fftSize = 4096, hopSize = 2048,
                 height = 64, minWidth = 320, drawOverlay = null, markRow = null,
                 // RTTY-ICOM's own faster, independent tap (item 3, grilled
                 // 2026-08-28): a 2nd hop cadence + AGC easing for a consumer
                 // that wants livelier data than the scrolling waterfall's own
                 // rows/colour ramp should have -- see liveDraw()'s own
                 // comment. Off by default (0): every existing caller
                 // (JS8/WSPR/Mercury) never sets these and never pays for it.
                 liveHopSize = 0, liveAgcEase = 0}) {
      this.canvas = canvas; this.overlay = overlay;
      this.container = container || canvas.parentNode;
      this.context = canvas.getContext("2d");
      this.overlayContext = overlay ? overlay.getContext("2d") : null;
      this.sampleRate = sampleRate; this.lowHz = lowHz; this.highHz = highHz;
      this.fftSize = fftSize; this.hopSize = hopSize;
      this.height = height; this.minWidth = minWidth;
      this.drawOverlay = drawOverlay; this.markRow = markRow;
      this.liveHopSize = liveHopSize; this.liveAgcEase = liveAgcEase;

      this.re = new Float32Array(fftSize);
      this.im = new Float32Array(fftSize);
      this.ring = new Float32Array(fftSize);
      this.hann = Float32Array.from({length: fftSize},
        (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (fftSize - 1)));
      this.rows = 0;
      this.reset();
    }

    // Everything the AGC learned is tied to what the receiver was hearing, so a
    // band change or a transmission has to start it over rather than fade.
    reset() {
      this.ring.fill(0);
      this.ringPos = 0; this.hop = 0; this.liveHop = 0; this.fill = 0;
      this.resetAgc();
    }

    // Just the AGC statistics, not the ring buffer -- split out (code-review)
    // for setRange() below: a zoomed-in sub-band genuinely has a different
    // noise floor worth re-learning, but the raw samples already sitting in
    // the ring are still perfectly valid FFT input regardless of which bins
    // get extracted from them afterward. Resets the live tap's own AGC too
    // (item 3) -- unconditionally, since a page that never uses it just
    // ignores these fields, and a page that does needs them reset on every
    // zoom/band change exactly like the main pair.
    resetAgc() {
      this.agcLow = -85; this.agcHigh = -35; this.agcReady = false;
      this.liveAgcLow = -85; this.liveAgcHigh = -35; this.liveAgcReady = false;
    }

    state() {
      // lastValues included (code-review 2026-08-27) so RTTY-ICOM's live
      // spectrum (kap.7) can read it through the same accessor every other
      // consumer here already uses (data.js's own spectrumState(){return
      // waterfall.state();}), instead of a second ad hoc `.lastValues`
      // property access path -- the property itself stays too (see its own
      // comment above draw()'s last line) since a per-animation-frame read
      // is the one place going through this array-allocating spread is worth
      // skipping. liveAgcLow/liveAgcHigh/liveValues (item 3) are the 2nd,
      // faster tap's own numbers -- undefined/stale for any page that never
      // configures liveHopSize, exactly like lastValues before the first
      // frame.
      return {agcLow: this.agcLow, agcHigh: this.agcHigh, agcReady: this.agcReady,
              rows: this.rows, fill: this.fill, lastValues: this.lastValues,
              liveAgcLow: this.liveAgcLow, liveAgcHigh: this.liveAgcHigh,
              liveAgcReady: this.liveAgcReady, liveValues: this.liveValues};
    }

    hzToX(hz, width = this.overlay ? this.overlay.width : this.canvas.width) {
      return (hz - this.lowHz) / (this.highHz - this.lowHz) * width;
    }

    // Re-point the FFT bin extraction at a different Hz window (RTTY-ICOM's
    // zoom pills). Restarts the AGC only (code-review: a full reset() also
    // zeroes the ring buffer/fill counters, discarding up to 0.512s of
    // already-buffered, still-perfectly-valid audio and stalling the display
    // until it refills -- purely because the bins being extracted from it
    // changed, not because the incoming audio did). Old rows keep scrolling
    // down under the new overlay and age out on their own, exactly as they
    // already do after a band change today (which does still call the full
    // reset(), via data.js's own resetSpectrumAnalyzer()).
    setRange(lowHz, highHz) {
      this.lowHz = lowHz; this.highHz = highHz;
      this.resetAgc();
      this.paintOverlay();
    }

    ingest(samples) {
      for (const value of samples) {
        this.ring[this.ringPos] = value;
        this.ringPos = (this.ringPos + 1) % this.fftSize;
        this.fill = Math.min(this.fftSize, this.fill + 1);
        const hopDue = (++this.hop >= this.hopSize);
        if (hopDue) this.hop = 0;
        // item 3: the live tap's own, independent hop counter -- runs at its
        // own (typically shorter) cadence without touching this.hop/draw()
        // above, so the waterfall's own row rate never changes.
        const liveDue = this.liveHopSize && (++this.liveHop >= this.liveHopSize);
        if (liveDue) this.liveHop = 0;
        if (!hopDue && !liveDue) continue;
        if (this.fill < this.fftSize) continue;
        // Whenever liveHopSize evenly divides hopSize (RTTY-ICOM: 1024 into
        // 2048), every 2nd live tick lands on the exact same ring window a
        // waterfall row also wants this same iteration -- extractValues() is
        // a full 4096-point FFT, so doing it twice for byte-identical input
        // was pure waste (code-review 2026-08-28). One extraction, handed to
        // whichever of draw()/liveDraw() is actually due.
        const values = this.extractValues();
        if (hopDue) this.draw(values);
        if (liveDue) this.liveDraw(values);
      }
    }

    // A hole in the RX timeline, in samples. Ingesting only what arrived would
    // stitch the two sides together and the picture would stay seamless while
    // the decoder was fed silence, so missing time is painted as visibly dead
    // rows instead. Dark red, not floor-blue: a quiet band and a lost band must
    // never look alike. Holes shorter than a row are ingested as true silence
    // (they dim the row they fall into), longer ones become whole rows and
    // restart the FFT window -- the audio before a hole and after it are not
    // one continuous signal, and smearing them across the seam would repaint
    // exactly the lie this method exists to remove.
    gap(sampleCount) {
      if (!(sampleCount > 0)) return;
      const rows = Math.min(this.height, Math.round(sampleCount / this.hopSize));
      if (rows < 1) { this.ingest(new Float32Array(sampleCount)); return; }
      const canvas = this.canvas, context = this.context;
      context.drawImage(canvas, 0, 0, canvas.width, canvas.height - rows,
                        0, rows, canvas.width, canvas.height - rows);
      context.fillStyle = "#38060f";
      context.fillRect(0, 0, canvas.width, rows);
      this.rows += rows;
      this.ring.fill(0); this.ringPos = 0; this.hop = 0; this.fill = 0;
    }

    fft(re, im) {
      const size = this.fftSize;
      for (let i = 1, j = 0; i < size; i++) {
        let bit = size >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
        if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let len = 2; len <= size; len <<= 1) {
        const angle = -2 * Math.PI / len, wr0 = Math.cos(angle), wi0 = Math.sin(angle);
        for (let start = 0; start < size; start += len) {
          let wr = 1, wi = 0;
          for (let j = 0; j < (len >> 1); j++) {
            const a = start + j, b = a + (len >> 1);
            const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
            const nextWr = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = nextWr;
          }
        }
      }
    }

    // FFT the current ring-buffer window and slice out the visible [lowHz,
    // highHz] bins -- the part draw() and liveDraw() (item 3) both need,
    // pulled out so the 2nd tap is not a hand-copy of this math.
    extractValues() {
      const size = this.fftSize;
      for (let i = 0; i < size; i++) {
        this.re[i] = this.ring[(this.ringPos + i) % size] * this.hann[i];
        this.im[i] = 0;
      }
      this.fft(this.re, this.im);

      const first = Math.floor(this.lowHz * size / this.sampleRate);
      const last = Math.ceil(this.highHz * size / this.sampleRate);
      const values = new Float32Array(last - first + 1);
      for (let bin = first; bin <= last; bin++)
        values[bin - first] = 20 * Math.log10(Math.hypot(this.re[bin], this.im[bin]) / size + 1e-9);
      return values;
    }

    // Percentile AGC: the 18th percentile is the noise floor, the 98.5th is
    // the loudest thing worth showing. A minimum span keeps a dead-quiet band
    // from being stretched into pure noise. Shared by draw() and liveDraw()
    // (item 3) -- only the easing factor and which agc*/agcReady fields it
    // lands in differ between the two.
    // `values` is already the typed array extractValues() returns --
    // Float32Array.prototype.sort() with no comparator sorts numerically by
    // spec (unlike a plain Array's default lexicographic sort), so this reads
    // the two percentiles without Array.from()'s boxing or a comparator call
    // per comparison (code-review 2026-08-28) -- .slice() first since sort()
    // is in place and extractValues()'s array is read again by draw()/
    // liveDraw() right after this returns.
    agcTargets(values) {
      const sorted = values.slice().sort();
      const targetLow = sorted[Math.floor((sorted.length - 1) * .18)] - 3;
      const observedHigh = sorted[Math.floor((sorted.length - 1) * .985)];
      const targetHigh = Math.max(observedHigh, targetLow + 22);
      return {targetLow, targetHigh, observedHigh};
    }

    // `values` comes from ingest()'s own single extractValues() call for this
    // sample (shared with liveDraw() when their hops coincide); draw() itself
    // no longer extracts.
    draw(values) {
      const canvas = this.canvas, context = this.context;

      const {targetLow, targetHigh, observedHigh} = this.agcTargets(values);
      if (observedHigh > -140) {
        if (!this.agcReady) { this.agcLow = targetLow; this.agcHigh = targetHigh; this.agcReady = true; }
        else {
          this.agcLow += (targetLow - this.agcLow) * .10;
          this.agcHigh += (targetHigh - this.agcHigh) * .10;
        }
      }

      context.drawImage(canvas, 0, 0, canvas.width, canvas.height - 1,
                        0, 1, canvas.width, canvas.height - 1);
      const row = context.createImageData(canvas.width, 1);
      for (let x = 0; x < canvas.width; x++) {
        const bin = Math.min(values.length - 1, Math.floor(x * values.length / canvas.width));
        const c = color((values[bin] - this.agcLow) / (this.agcHigh - this.agcLow));
        const at = x * 4;
        row.data[at] = c[0]; row.data[at + 1] = c[1]; row.data[at + 2] = c[2]; row.data[at + 3] = 255;
      }
      context.putImageData(row, 0, 0);
      if (this.markRow) this.markRow(context, canvas.width);
      this.rows++;
      // RTTY-ICOM's live-spectrum panel used to read this each animation frame
      // instead of running a second FFT; superseded by the dedicated liveDraw()
      // tap below (item 3, grilled 2026-08-28) so its own, faster cadence no
      // longer has to piggyback on this row's -- kept here too since it is
      // still the one true "as of the last waterfall row" reading, and JS8/
      // WSPR/Mercury still only ever read this pair.
      this.lastValues = values;
    }

    // The live tap (item 3, grilled 2026-08-28): same window, its own hop
    // cadence (liveHopSize, set only by RTTY-ICOM) and its own AGC easing
    // (liveAgcEase, deliberately faster than the waterfall's fixed .10) --
    // entirely separate state from draw()'s own agcLow/agcHigh/lastValues/
    // rows, so a livelier live-spectrum readout never speeds up or re-colours
    // the scrolling waterfall underneath it ("vodopad nechat", grilled).
    liveDraw(values) {
      const {targetLow, targetHigh, observedHigh} = this.agcTargets(values);
      if (observedHigh > -140) {
        if (!this.liveAgcReady) { this.liveAgcLow = targetLow; this.liveAgcHigh = targetHigh; this.liveAgcReady = true; }
        else {
          this.liveAgcLow += (targetLow - this.liveAgcLow) * this.liveAgcEase;
          this.liveAgcHigh += (targetHigh - this.liveAgcHigh) * this.liveAgcEase;
        }
      }
      this.liveValues = values;
    }

    resize() {
      const width = Math.max(this.minWidth, Math.round(this.container.clientWidth));
      if (this.canvas.width !== width) { this.canvas.width = width; this.canvas.height = this.height; }
      if (this.overlay) { this.overlay.width = width; this.overlay.height = this.height; }
      this.paintOverlay();
    }

    paintOverlay() {
      if (!this.overlayContext || !this.drawOverlay) return;
      this.overlayContext.clearRect(0, 0, this.overlay.width, this.overlay.height);
      this.drawOverlay(this.overlayContext, this);
    }
  }

  return {Waterfall, color};
});
