// JTTY live spectrum + waterfall + overlay, the jtty.html / QRPlog palette
// counterpart of rtty-scope.js (same DOM shape and the same Spectrum.Waterfall
// underneath, so data.css/rtty.css lay it out unchanged). The overlay is what
// differs: no mark/space pair, but the 127 Hz RX passband (green), the TX
// offset (red), recent decodes as ticks with their SNR, and on hover the
// passband a click would select.
//
// Frequencies are the lowest tone's, as WSJT-X shows them; a JTTY signal
// occupies about f-16 .. f+110 Hz (4 tones 31.25 Hz apart, 127 Hz at 99 %).
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JttyScope = factory();
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const RX_COLOR = "#3fd27f", TX_COLOR = "#ff5a4f";
  const SIGNAL_LOW = -16, SIGNAL_HIGH = 110;
  const DECODE_FADE_MS = 20000;
  const SPATIAL_SMOOTH_RADIUS = 2;

  function niceTicks(low, high, count) {
    const span = high - low;
    if (!(span > 0)) return [];
    const raw = span / Math.max(1, count);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(low / step) * step; v <= high; v += step) out.push(v);
    return out;
  }

  // options: scopeEl, liveCanvas, liveContainer, waterfallCanvas,
  // waterfallContainer, overlayCanvas, sampleRate, baseLowHz, baseHighHz,
  // rxHz(), txHz(), onTune(hz, event)
  function create(options) {
    const scopeEl = options.scopeEl, liveCanvas = options.liveCanvas;
    const liveContainer = options.liveContainer, overlayCanvas = options.overlayCanvas;
    const rxHzOf = options.rxHz, txHzOf = options.txHz || options.rxHz;
    const onTune = options.onTune || (() => {});
    const baseLowHz = options.baseLowHz, baseHighHz = options.baseHighHz;
    const waterfall = new Spectrum.Waterfall({
      canvas: options.waterfallCanvas, container: options.waterfallContainer,
      sampleRate: options.sampleRate, lowHz: baseLowHz, highHz: baseHighHz,
      minWidth: options.minWidth || 320, liveHopSize: 128, liveAgcEase: .6,
    });
    const decodes = [];      // {hz, snr, at}
    let smoothed = null, hoverHz = null, raf = null, running = false, zoomPercent = 100;

    function band(ctx, hz, color, alpha, top, bottom, width) {
      const x0 = waterfall.hzToX(hz + SIGNAL_LOW, width), x1 = waterfall.hzToX(hz + SIGNAL_HIGH, width);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x0), top, Math.max(1, Math.round(x1 - x0)), bottom - top);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      for (const x of [x0, x1]) {
        ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, top); ctx.lineTo(Math.round(x) + .5, bottom); ctx.stroke();
      }
    }

    function drawOverlay() {
      const ctx = overlayCanvas.getContext("2d");
      const width = overlayCanvas.width, bottomY = overlayCanvas.height;
      const splitY = liveContainer.clientHeight;
      ctx.clearRect(0, 0, width, bottomY);
      const rx = rxHzOf(), tx = txHzOf();
      band(ctx, rx, RX_COLOR, .12, 0, bottomY, width);
      if (Math.abs(tx - rx) >= 1) {
        const x = waterfall.hzToX(tx, width);
        ctx.strokeStyle = TX_COLOR; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, bottomY); ctx.stroke();
      }
      if (hoverHz !== null) band(ctx, hoverHz, "#bdbdbd", .08, 0, bottomY, width);

      const now = Date.now();
      ctx.font = "9px ui-monospace, Menlo, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      while (decodes.length && now - decodes[0].at > DECODE_FADE_MS) decodes.shift();
      for (const d of decodes) {
        const x = waterfall.hzToX(d.hz + 47, width);
        ctx.globalAlpha = Math.max(.25, 1 - (now - d.at) / DECODE_FADE_MS);
        ctx.fillStyle = "#f0d68c";
        ctx.fillText(String(d.snr), x, splitY + 2);
      }
      ctx.globalAlpha = 1;

      ctx.textBaseline = "bottom";
      ctx.fillStyle = "#c8c8c8";
      for (const hz of niceTicks(waterfall.lowHz, waterfall.highHz, 5))
        ctx.fillText(String(Math.round(hz)), waterfall.hzToX(hz, width), bottomY - 2);
      ctx.textAlign = "left";
      ctx.fillStyle = RX_COLOR;
      ctx.fillText(`RX ${Math.round(rx)}`, waterfall.hzToX(rx + SIGNAL_HIGH, width) + 4, splitY - 2);
      if (Math.abs(tx - rx) >= 1) {
        ctx.fillStyle = TX_COLOR;
        ctx.fillText(`TX ${Math.round(tx)}`, waterfall.hzToX(tx, width) + 4, splitY - 14);
      }
    }

    function resize() {
      waterfall.resize();
      const width = Math.max(waterfall.minWidth, Math.round(scopeEl.clientWidth));
      const height = Math.round(scopeEl.clientHeight);
      if (overlayCanvas.width !== width) overlayCanvas.width = width;
      if (overlayCanvas.height !== height) overlayCanvas.height = height;
      drawOverlay();
    }

    function drawLive() {
      const ctx = liveCanvas.getContext("2d");
      ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
      const {liveAgcLow: lo0, liveAgcHigh: hi0, liveValues: values} = waterfall.state();
      if (!(values && values.length)) return;
      if (!smoothed || smoothed.length !== values.length) smoothed = Float32Array.from(values);
      else for (let i = 0; i < values.length; i++) smoothed[i] += (values[i] - smoothed[i]) * .35;
      const lo = lo0, hi = Math.max(hi0, lo + 1), n = smoothed.length;
      ctx.strokeStyle = "rgba(200,200,200,.9)";
      ctx.lineWidth = .75;
      ctx.beginPath();
      const stepX = liveCanvas.width / (n - 1 || 1);
      for (let i = 0; i < n; i++) {
        let sum = 0, count = 0;
        for (let j = Math.max(0, i - SPATIAL_SMOOTH_RADIUS); j <= Math.min(n - 1, i + SPATIAL_SMOOTH_RADIUS); j++) { sum += smoothed[j]; count++; }
        const y = liveCanvas.height - Math.max(0, Math.min(1, (sum / count - lo) / (hi - lo))) * liveCanvas.height * .9;
        if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i * stepX, y);
      }
      ctx.stroke();
    }

    function frame() {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      drawLive();
      drawOverlay();
    }

    function setZoom(percent) {
      let low = baseLowHz, high = baseHighHz;
      if (percent !== 100) {
        const span = (baseHighHz - baseLowHz) * 100 / percent;
        const center = rxHzOf() + 47;
        low = Math.max(0, center - span / 2); high = low + span;
      }
      zoomPercent = percent;
      waterfall.setRange(low, high);
      drawOverlay();
      return {low, high};
    }

    // Where a click lands, as the lowest tone of a signal centred there.
    function clientXToHz(clientX) {
      const rect = scopeEl.getBoundingClientRect();
      const hz = waterfall.lowHz + (clientX - rect.left) / rect.width * (waterfall.highHz - waterfall.lowHz);
      return Math.round(hz - 47);
    }

    const onClick = event => onTune(clientXToHz(event.clientX), event);
    const onMove = event => { hoverHz = clientXToHz(event.clientX); };
    const onLeave = () => { hoverHz = null; };
    scopeEl.addEventListener("click", onClick);
    scopeEl.addEventListener("mousemove", onMove);
    scopeEl.addEventListener("mouseleave", onLeave);

    function start() {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      running = false;
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    }
    function destroy() {
      stop();
      scopeEl.removeEventListener("click", onClick);
      scopeEl.removeEventListener("mousemove", onMove);
      scopeEl.removeEventListener("mouseleave", onLeave);
    }

    return {
      waterfall, ingest: samples => waterfall.ingest(samples), drawOverlay, resize, setZoom,
      zoom: () => zoomPercent, clientXToHz, start, stop, destroy,
      markDecode: (hz, snr) => decodes.push({hz, snr, at: Date.now()}),
    };
  }

  return {create, niceTicks, RX_COLOR, TX_COLOR, SIGNAL_LOW, SIGNAL_HIGH};
}));
