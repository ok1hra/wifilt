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
                 height = 64, minWidth = 320, drawOverlay = null, markRow = null}) {
      this.canvas = canvas; this.overlay = overlay;
      this.container = container || canvas.parentNode;
      this.context = canvas.getContext("2d");
      this.overlayContext = overlay ? overlay.getContext("2d") : null;
      this.sampleRate = sampleRate; this.lowHz = lowHz; this.highHz = highHz;
      this.fftSize = fftSize; this.hopSize = hopSize;
      this.height = height; this.minWidth = minWidth;
      this.drawOverlay = drawOverlay; this.markRow = markRow;

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
      this.ringPos = 0; this.hop = 0; this.fill = 0;
      this.agcLow = -85; this.agcHigh = -35; this.agcReady = false;
    }

    state() {
      return {agcLow: this.agcLow, agcHigh: this.agcHigh, agcReady: this.agcReady,
              rows: this.rows, fill: this.fill};
    }

    hzToX(hz, width = this.overlay ? this.overlay.width : this.canvas.width) {
      return (hz - this.lowHz) / (this.highHz - this.lowHz) * width;
    }

    ingest(samples) {
      for (const value of samples) {
        this.ring[this.ringPos] = value;
        this.ringPos = (this.ringPos + 1) % this.fftSize;
        this.fill = Math.min(this.fftSize, this.fill + 1);
        if (++this.hop >= this.hopSize) {
          this.hop = 0;
          if (this.fill >= this.fftSize) this.draw();
        }
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

    draw() {
      const size = this.fftSize, canvas = this.canvas, context = this.context;
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

      // Percentile AGC: the 18th percentile is the noise floor, the 98.5th is
      // the loudest thing worth showing. A minimum span keeps a dead-quiet band
      // from being stretched into pure noise.
      const sorted = Array.from(values).sort((a, b) => a - b);
      const targetLow = sorted[Math.floor((sorted.length - 1) * .18)] - 3;
      const observedHigh = sorted[Math.floor((sorted.length - 1) * .985)];
      const targetHigh = Math.max(observedHigh, targetLow + 22);
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
