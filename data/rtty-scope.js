// The RTTY scope: live spectrum + scrolling waterfall + the one overlay that
// spans both, with click-to-tune and the hover preview.
//
// Extracted from rtty.js 2026-09-07 so QRPlog's own RTTY palette
// (log-rtty-panel.js) draws the SAME scope rather than a second, drifting
// copy of it. The mark/space geometry here is pixel-verified work and the
// overlay's continuity across the seam between the two canvases is the whole
// reason that overlay exists -- neither survives being reimplemented.
//
// Owns: the Spectrum.Waterfall instance, the requestAnimationFrame loop, the
// overlay painting, zoom, and the pointer geometry (clientX <-> Hz).
//
// Deliberately does not own: settings (read through the injected accessor, so
// the consumer stays the single writer), AFC state (the consumer keeps its own
// offset and is called back once per frame through onFrame to advance it), or
// what a click actually DOES -- rtty.js retunes the radio in real-FSK modes
// and the audio tone otherwise, and that decision stays with the page.
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RttyScope = factory();
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  // Same 1/3-thinned weights and colours the page shipped: green is whichever
  // physical tone THIS station's encoder sends for a mark bit, red for space.
  const MARK_COLOR = "#5ad18a", SPACE_COLOR = "#ff6b6b";
  const SPATIAL_SMOOTH_RADIUS = 2;

  // Which physical tone is "mark" right now. settings.toneHz is the centre
  // RttyCodec's Encoder/Decoder actually use; mark sits SHIFT_HZ/2 above it
  // unless the operator's own TX polarity says otherwise.
  function markToneHz(settings) {
    return settings.txPolarity === "reverse"
      ? settings.toneHz - RttyCodec.SHIFT_HZ / 2
      : settings.toneHz + RttyCodec.SHIFT_HZ / 2;
  }

  // The pair the solid overlay lines sit on and AFC searches around -- space
  // is just mark's mirror image around the centre.
  function expectedMarkSpaceHz(settings) {
    const markHz = markToneHz(settings);
    return [markHz, 2 * settings.toneHz - markHz];
  }

  // [markHz, spaceHz] a click at this lower-tone frequency would produce.
  // Mirrors the page's setToneFromSpaceHz() (`centre = lowHz + SHIFT_HZ/2`)
  // followed by markToneHz()'s polarity branch, without writing anything.
  function markSpaceForLowHz(settings, lowHz) {
    return settings.txPolarity === "reverse"
      ? [lowHz, lowHz + RttyCodec.SHIFT_HZ]
      : [lowHz + RttyCodec.SHIFT_HZ, lowHz];
  }

  function dialToMarkHz(settings, dialHz, mode) {
    if (mode.startsWith("LSB")) return dialHz - markToneHz(settings);
    if (mode.startsWith("USB")) return dialHz + markToneHz(settings);
    return dialHz; // RTTY/RTTY-R (dial == mark already) and anything else
  }

  function markToDialHz(settings, markTargetHz, mode) {
    if (mode.startsWith("LSB")) return markTargetHz + markToneHz(settings);
    if (mode.startsWith("USB")) return markTargetHz - markToneHz(settings);
    return markTargetHz;
  }

  // Same shape rtty-presets.js's own formatFrequency() produces
  // (14.085.000), kept here as the fallback so a consumer that does not load
  // that file -- QRPLog's palette does not -- still gets a readable dial
  // instead of a ReferenceError mid-frame.
  function defaultFormatFrequency(frequencyHz) {
    const hz = Math.max(0, Math.round(Number(frequencyHz) || 0));
    const mhz = Math.floor(hz / 1000000);
    const rest = String(hz % 1000000).padStart(6, "0");
    return `${mhz}.${rest.slice(0, 3)}.${rest.slice(3)}`;
  }

  // "Nice" round tick values (d3.ticks()-style): pick a step from {1,2,5}x10^n
  // closest to span/count, so the waterfall's own rough frequency ruler reads
  // as round numbers (…900, 1300, 1700…) rather than whatever the visible
  // window's exact edges happen to divide into. "Roughly clear where we are"
  // -- not a precise scale.
  function niceTicks(lowHz, highHz, count) {
    const span = highHz - lowHz;
    if (!(span > 0)) return [];
    const rawStep = span / count;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / magnitude;
    const niceNorm = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    const step = niceNorm * magnitude;
    const ticks = [];
    for (let v = Math.ceil(lowHz / step) * step; v <= highHz; v += step) ticks.push(v);
    return ticks;
  }

  // options:
  //   scopeEl            wrapper around BOTH canvases -- pointer geometry and
  //                      the overlay's height are measured from this box
  //   liveCanvas         the live-spectrum trace canvas
  //   liveContainer      its wrapper; its clientHeight is the seam the ruler
  //                      labels sit on
  //   waterfallCanvas,
  //   waterfallContainer passed straight to Spectrum.Waterfall
  //   overlayCanvas      the single canvas covering both blocks
  //   sampleRate         RX audio rate (8000)
  //   baseLowHz/HighHz   the 100 % zoom window
  //   settings()         live settings object (toneHz, txPolarity, afcEnabled)
  //   afcOffsetHz()      the consumer's current AFC offset, in Hz
  //   radio()            {frequency, mode} -- for the FSK dial label
  //   onFrame()          called once per animation frame BEFORE drawing, so
  //                      the consumer can advance AFC even between FFT frames
  //   onTune(lowHz)      a click landed at this lower-tone frequency
  //   showFskLabel       draw the "FSK <dial>" companion-radio readout
  //   formatFrequency    Hz -> display string for that readout; injected so
  //                      this module has no hard dependency on rtty-presets.js,
  //                      which QRPLog does not load
  //   minWidth           waterfall backing-store floor (default 320)
  function create(options) {
    const scopeEl = options.scopeEl;
    const liveCanvas = options.liveCanvas;
    const liveContainer = options.liveContainer;
    const overlayCanvas = options.overlayCanvas;
    const settingsOf = options.settings;
    const afcOffsetOf = options.afcOffsetHz || (() => 0);
    const radioOf = options.radio || (() => ({frequency: 0, mode: ""}));
    const onFrame = options.onFrame || (() => {});
    const onTune = options.onTune || (() => {});
    const showFskLabel = options.showFskLabel !== false;
    const formatFrequency = options.formatFrequency || defaultFormatFrequency;
    const baseLowHz = options.baseLowHz, baseHighHz = options.baseHighHz;

    const waterfall = new Spectrum.Waterfall({
      canvas: options.waterfallCanvas,
      container: options.waterfallContainer,
      sampleRate: options.sampleRate,
      lowHz: baseLowHz,
      highHz: baseHighHz,
      minWidth: options.minWidth || 320,
      // The live tap's cadence is pinned to the display's: drawFrame() reads
      // it once per requestAnimationFrame (~16.7 ms @ 60 Hz), so 128 samples
      // (16 ms @ 8 kHz, still an even divisor of the 2048-sample waterfall hop
      // so ingest()'s shared-extraction optimization still applies) is the
      // ceiling -- anything faster burns FFTs nobody can ever see painted.
      liveHopSize: 128,
      liveAgcEase: .6,
    });

    let smoothedSpectrum = null;
    let hoverPreviewLowHz = null;
    let rafHandle = null, running = false;
    let zoomPercent = 100;

    // ---- overlay -----------------------------------------------------------
    //
    // The ONE overlay covering both the live-spectrum panel and the waterfall
    // below it. Replaces the old per-canvas draw, which ran twice and broke
    // into two visibly separate segments at the border between the two blocks
    // -- drawn once here instead, so the line is continuous by construction
    // rather than by coincidence of matching coordinates.
    function drawOverlay() {
      const ctx = overlayCanvas.getContext("2d");
      ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      const width = overlayCanvas.width, bottomY = overlayCanvas.height;
      // The seam between the two wrapped blocks, in this shared canvas's own
      // pixel space -- "bottom edge of the spectrogram" means here, not the
      // overlay's own bottom (that is the waterfall's bottom edge).
      const splitY = liveContainer.clientHeight;
      const settings = settingsOf();
      const [markHz, spaceHz] = expectedMarkSpaceHz(settings);

      // AFC drawn FIRST so the solid mark/space lines always sit on top of it,
      // never hidden by it even at zero offset (the two pairs coincide when
      // the detector hasn't drifted). Half the line weight, grey, no per-line
      // Hz label -- just the signed offset centred between the two.
      const afcOffsetHz = afcOffsetOf();
      if (settings.afcEnabled) {
        const afcMarkX = waterfall.hzToX(markHz + afcOffsetHz, width);
        const afcSpaceX = waterfall.hzToX(spaceHz + afcOffsetHz, width);
        ctx.strokeStyle = "rgba(180,180,180,.8)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        for (const x of [afcMarkX, afcSpaceX]) {
          ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, 0);
          ctx.lineTo(Math.round(x) + .5, bottomY); ctx.stroke();
        }
        ctx.setLineDash([]);
        const sign = afcOffsetHz > 0 ? "+" : afcOffsetHz < 0 ? "−" : "";
        ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
        ctx.fillStyle = "rgba(200,200,200,.9)";
        ctx.textAlign = "center";
        // Pinned to the top edge (was vertically centred, which sat in the
        // middle of the waterfall content) -- still horizontally centred over
        // its own dashed lines, just out of the way of what they cross.
        ctx.textBaseline = "top";
        ctx.fillText(`${sign}${Math.round(Math.abs(afcOffsetHz))} Hz`,
          (afcMarkX + afcSpaceX) / 2, 10);
        ctx.textBaseline = "alphabetic";
      }

      ctx.setLineDash([]);
      for (const [hz, strokeColor] of [[markHz, MARK_COLOR], [spaceHz, SPACE_COLOR]]) {
        const x = waterfall.hzToX(hz, width);
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, 0);
        ctx.lineTo(Math.round(x) + .5, bottomY); ctx.stroke();
      }

      // Hover preview: a thin, solid grey pair showing where the solid
      // green/red lines would land if the operator clicked at the current
      // mouse position. Solid (not dashed) so it is never mistaken for the
      // AFC pair above even when both show at once -- AFC means "current
      // drift compensation", this means "hypothetical click target".
      if (hoverPreviewLowHz !== null) {
        const [previewMarkHz, previewSpaceHz] = markSpaceForLowHz(settings, hoverPreviewLowHz);
        ctx.strokeStyle = "rgba(190,190,190,.65)";
        ctx.lineWidth = 1;
        for (const hz of [previewMarkHz, previewSpaceHz]) {
          const x = waterfall.hzToX(hz, width);
          ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, 0);
          ctx.lineTo(Math.round(x) + .5, bottomY); ctx.stroke();
        }
      }

      // The waterfall's own rough frequency ruler, bottom edge.
      ctx.font = "9px ui-monospace, Menlo, Consolas, monospace";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "#c8c8c8";
      ctx.textAlign = "center";
      for (const hz of niceTicks(waterfall.lowHz, waterfall.highHz, 5))
        ctx.fillText(String(Math.round(hz)), waterfall.hzToX(hz, width), bottomY - 2);

      // Exact SPACE/red-line frequency, just left of the line itself, at the
      // bottom of the spectrogram (the seam, not the overlay's bottom).
      ctx.fillStyle = SPACE_COLOR;
      ctx.textAlign = "right";
      ctx.fillText(String(Math.round(spaceHz)), waterfall.hzToX(spaceHz, width) - 4, splitY - 2);

      // The dial a companion real-FSK radio would need to put ITS mark at the
      // same actual RF frequency this AFSK mark tone lands on (dial == mark
      // for real FSK). Mirrors the space label's placement, to the right of
      // the green line instead of left of the red one.
      if (showFskLabel) {
        const radio = radioOf();
        const fskDialHz = dialToMarkHz(settings, radio.frequency, radio.mode || "");
        ctx.fillStyle = MARK_COLOR;
        ctx.textAlign = "left";
        ctx.fillText(`FSK ${formatFrequency(fskDialHz)}`,
          waterfall.hzToX(markHz, width) + 4, splitY - 2);
      }
    }

    // Sized to the wrapper's own rendered box -- top of the spectrogram
    // through the bottom of the waterfall, INCLUDING the border/gap between
    // them -- so the mark/space lines paint straight across that seam rather
    // than stopping at either individual canvas's own edge.
    function resizeOverlay() {
      const width = Math.max(waterfall.minWidth, Math.round(scopeEl.clientWidth));
      const height = Math.round(scopeEl.clientHeight);
      if (overlayCanvas.width !== width) overlayCanvas.width = width;
      if (overlayCanvas.height !== height) overlayCanvas.height = height;
    }

    function resize() {
      waterfall.resize();
      resizeOverlay();
      drawOverlay();
    }

    // ---- live spectrum -----------------------------------------------------
    //
    // A smoothed line/envelope, not a bar chart -- no fill under it. Two
    // independent smoothing passes, both "partial", not a heavy filter:
    //  - temporal: a light exponential blend frame-to-frame, the same idea
    //    spectrum.js's own AGC already uses for agcLow/agcHigh;
    //  - spatial: a small moving average across neighbouring bins, so the
    //    trace reads as an envelope rather than a jagged per-bin FFT line.
    function drawLive() {
      const ctx = liveCanvas.getContext("2d");
      ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
      // The live tap's OWN liveValues/liveAgcLow/liveAgcHigh -- NOT
      // lastValues/agcLow/agcHigh, which still feed the SCROLLING waterfall's
      // row colours at their own, deliberately slower, unchanged cadence.
      // Empty/undefined before the first live frame draws nothing, never an
      // error.
      const {liveAgcLow: agcLow, liveAgcHigh: agcHigh, liveValues: values} = waterfall.state();
      if (!(values && values.length)) return;

      // A zoom change (or the first frame) alters how many FFT bins fall
      // inside the visible window -- a stale buffer of a different length
      // cannot be blended into the new one, so it is simply replaced rather
      // than reset to zero (which would draw a false dip).
      if (!smoothedSpectrum || smoothedSpectrum.length !== values.length)
        smoothedSpectrum = Float32Array.from(values);
      else
        for (let i = 0; i < values.length; i++)
          smoothedSpectrum[i] += (values[i] - smoothedSpectrum[i]) * .35;

      const lo = agcLow, hi = Math.max(agcHigh, lo + 1);
      // Sliding-window sum, not a fresh sum/count scan per point: the window
      // for i+1 differs from i's only by one entering and one leaving sample,
      // so it is maintained in O(1) per point instead of re-summing all
      // ~2*RADIUS+1 of them every animation frame.
      const n = smoothedSpectrum.length;
      const points = new Array(n);
      let sum = 0, count = 0;
      for (let j = 0; j <= Math.min(SPATIAL_SMOOTH_RADIUS, n - 1); j++) {
        sum += smoothedSpectrum[j]; count++;
      }
      for (let i = 0; i < n; i++) {
        const norm = Math.max(0, Math.min(1, (sum / count - lo) / (hi - lo)));
        // 90 % headroom -- the loudest displayed point never quite touches the
        // top edge, so a signal at or above agcHigh reads as a tall peak, not
        // a flat line clipped against the canvas border.
        points[i] = liveCanvas.height - norm * liveCanvas.height * .9;
        const enter = i + SPATIAL_SMOOTH_RADIUS + 1, leave = i - SPATIAL_SMOOTH_RADIUS;
        if (enter < n) { sum += smoothedSpectrum[enter]; count++; }
        if (leave >= 0) { sum -= smoothedSpectrum[leave]; count--; }
      }

      // Light grey, not a teal -- too close to the MARK line's own green to
      // tell apart at a glance. Thin stroke: this reads as a live line, not a
      // filled band.
      ctx.strokeStyle = "rgba(200,200,200,.9)";
      ctx.lineWidth = .75;
      ctx.beginPath();
      const stepX = liveCanvas.width / (points.length - 1 || 1);
      points.forEach((y, i) => (i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * stepX, y)));
      ctx.stroke();
    }

    function frame() {
      if (!running) return;
      rafHandle = requestAnimationFrame(frame);
      // The consumer's AFC slew needs to keep moving every frame, not just
      // when a fresh FFT frame lands (e.g. still easing back to 0 after
      // squelch closes).
      onFrame();
      drawLive();
      // The shared overlay repaints every frame regardless of whether live
      // data has arrived yet, so it appears immediately on load.
      drawOverlay();
    }

    // ---- zoom --------------------------------------------------------------
    //
    // 100/200/400 % narrow the base window around the tone AS IT STANDS at the
    // moment of the call -- not continuously re-centred on every click-to-tune
    // (a click by construction always lands inside the window already visible),
    // which would mean a setRange() -> resetAgc() on every click, restarting
    // the AGC's learned noise floor far more often than the operator's own
    // clicks warrant.
    //
    // 100 % is the fixed base range, NOT tone-centred like 200/400 %: centring
    // it the same way would mean "100 %" only reproduces the true base range
    // when the tone happens to sit exactly at its midpoint, and for a low
    // enough tone the window would extend below 0 Hz -- spectrum.js's draw()
    // has no floor check on lowHz, so a negative window feeds it negative FFT
    // bin indices, reading undefined off the end of a Float32Array and
    // poisoning the percentile AGC with NaN. 200/400 % are always safe: with
    // toneHz clamped by rtty-settings.js, their narrower spans can only push
    // the window a little past the base edges, never negative.
    function setZoom(percent) {
      let low, high;
      if (percent === 100) {
        low = baseLowHz; high = baseHighHz;
      } else {
        const span = (baseHighHz - baseLowHz) * 100 / percent;
        const center = settingsOf().toneHz;
        low = center - span / 2; high = center + span / 2;
      }
      zoomPercent = percent;
      waterfall.setRange(low, high);
      drawOverlay();   // immediate feedback; the rAF loop would repaint within a frame anyway
      return {low, high};
    }

    // ---- pointer geometry --------------------------------------------------
    //
    // Proportional within the CURRENTLY VISIBLE window -- reads
    // waterfall.lowHz/highHz directly (the instance's own public fields, kept
    // current by setRange() alone) rather than a 2nd tracked copy, so a
    // position always lands inside whatever window setRange() last
    // established, zoomed or not. Both directions are purely proportional, so
    // this stays correct at any rendered width, including one narrower than
    // the backing store's floor.
    function clientXToHz(clientX) {
      const rect = scopeEl.getBoundingClientRect();
      return Math.round(waterfall.lowHz +
        (clientX - rect.left) / rect.width * (waterfall.highHz - waterfall.lowHz));
    }

    // One listener on the wrapper around BOTH blocks instead of a 2nd,
    // separate one per canvas -- they share the same Hz window and width, so
    // a single rect/handler covers "click anywhere in the spectrum retunes".
    const onClick = event => onTune(clientXToHz(event.clientX));
    const onMouseMove = event => {
      hoverPreviewLowHz = clientXToHz(event.clientX);
      drawOverlay();
    };
    const onMouseLeave = () => { hoverPreviewLowHz = null; drawOverlay(); };

    scopeEl.addEventListener("click", onClick);
    scopeEl.addEventListener("mousemove", onMouseMove);
    scopeEl.addEventListener("mouseleave", onMouseLeave);

    function start() {
      if (running) return;
      running = true;
      rafHandle = requestAnimationFrame(frame);
    }

    // The page's original loop had no stop condition -- it ran forever once
    // booted, which is fine for a page but not for a palette that opens and
    // closes inside a long-lived document.
    //
    // stop() and destroy() are deliberately different. A palette that is
    // merely CLOSED will be shown again from the same DOM, so it stops the
    // frame loop and keeps its listeners; unbinding them there would leave
    // click-to-tune and the hover preview silently dead on the second opening.
    // destroy() is the real teardown, for a scope whose elements are going.
    function stop() {
      running = false;
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }

    function destroy() {
      stop();
      scopeEl.removeEventListener("click", onClick);
      scopeEl.removeEventListener("mousemove", onMouseMove);
      scopeEl.removeEventListener("mouseleave", onMouseLeave);
    }

    return {
      waterfall,
      ingest: samples => waterfall.ingest(samples),
      drawOverlay,
      resize,
      setZoom,
      zoom: () => zoomPercent,
      clientXToHz,
      start,
      stop,
      destroy,
    };
  }

  return {
    create, defaultFormatFrequency,
    markToneHz, expectedMarkSpaceHz, markSpaceForLowHz,
    dialToMarkHz, markToDialHz, niceTicks,
    MARK_COLOR, SPACE_COLOR,
  };
}));
