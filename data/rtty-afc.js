// Pure RTTY AFC carrier-pair detector. Kept separate from rtty.js so the
// frequency acquisition math can be regression-tested without constructing
// the page, radio session or canvases.
(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.RttyAfc = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  function valueAtHz(values, hz, lowHz, highHz) {
    const span = highHz - lowHz;
    if (!(span > 0) || !values || values.length < 2) return -Infinity;
    const index = Math.round((hz - lowHz) * (values.length - 1) / span);
    return index >= 0 && index < values.length ? values[index] : -Infinity;
  }

  function refinePeakBinOffset(values, index) {
    if (index <= 0 || index >= values.length - 1) return 0;
    const a = values[index - 1], b = values[index], c = values[index + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return 0;
    const denominator = a - 2 * b + c;
    let delta = denominator !== 0 ? 0.5 * (a - c) / denominator : 0;
    if (!Number.isFinite(delta) || Math.abs(delta) > 0.5) delta = 0;
    return delta;
  }

  // Find the common offset of an RTTY mark/space pair. `values` are FFT dB
  // bins spanning lowHz..highHz. A valid wide-range acquisition requires BOTH
  // carriers at their fixed separation: every framed Baudot character contains
  // a space start bit and a mark stop bit, and RTTY's 512 ms FFT normally spans
  // about three such characters. A lone carrier is intentionally rejected;
  // beyond half a shift it is ambiguous and belongs to the locked/local tracker,
  // not to wide acquisition.
  function findOffset(values, {
    lowHz,
    highHz,
    markHz,
    spaceHz,
    maxDeviationHz,
    prominenceDb = 8,
  } = {}) {
    const span = highHz - lowHz;
    const deviation = Number(maxDeviationHz);
    if (!(span > 0) || !values || values.length < 3 ||
        !Number.isFinite(markHz) || !Number.isFinite(spaceHz) ||
        !(deviation > 0) || !(prominenceDb >= 0)) return null;

    const hzPerBin = span / (values.length - 1);
    const steps = Math.max(4, Math.round(2 * deviation / hzPerBin));
    const levels = new Float32Array(steps + 1);
    const finiteLevels = [];

    for (let i = 0; i <= steps; i++) {
      const offsetHz = -deviation + i * (2 * deviation / steps);
      const markLevel = valueAtHz(values, markHz + offsetHz, lowHz, highHz);
      const spaceLevel = valueAtHz(values, spaceHz + offsetHz, lowHz, highHz);
      // The weaker carrier is the evidence that distinguishes a real pair from
      // the equally strong ±shift alias produced by either carrier on its own.
      const pairLevel = Math.min(markLevel, spaceLevel);
      levels[i] = pairLevel;
      if (Number.isFinite(pairLevel)) finiteLevels.push(pairLevel);
    }

    if (finiteLevels.length < 3) return null;
    let best = 0;
    for (let i = 1; i < levels.length; i++)
      if (levels[i] > levels[best]) best = i;

    finiteLevels.sort((a, b) => a - b);
    const noiseFloor = finiteLevels[finiteLevels.length >> 1];
    if (!Number.isFinite(levels[best]) ||
        levels[best] - noiseFloor < prominenceDb) return null;

    const stepHz = 2 * deviation / steps;
    return -deviation + (best + refinePeakBinOffset(levels, best)) * stepHz;
  }

  // Target policy kept beside the detector so the acquisition/squelch
  // interaction is testable too. A confident pair overrides a closed decoder
  // squelch: that is precisely how AFC pulls a weak, detuned decoder into lock.
  // Without a pair, idle MARK holds an established lock while a closed squelch
  // returns to the operator's centre.
  function nextTarget(currentTargetHz, foundOffsetHz, squelchOpen) {
    if (Number.isFinite(foundOffsetHz)) return foundOffsetHz;
    return squelchOpen && Number.isFinite(currentTargetHz) ? currentTargetHz : 0;
  }

  // The running tracker around the two pure functions above -- the slew
  // integration, the fresh-frame gate and the deviation clamp. Lifted out of
  // rtty.js 2026-09-07 so QRPlog's own RTTY palette tracks drift the same way
  // the page does instead of carrying a fourth copy of these thirty lines.
  //
  // Everything it needs is injected, so it stays as clock-free and DOM-free as
  // the detector it wraps -- the only impurity is Date.now(), which the slew
  // genuinely needs (it must keep easing between FFT frames, not only when new
  // data lands).
  //
  // options:
  //   settings()     {afcEnabled, afcMaxDeviationHz, afcRateHzPerChar}
  //   liveValues()   the live FFT tap's current Float32Array, or null
  //   window()       {lowHz, highHz} of the visible spectrum
  //   markSpace()    [markHz, spaceHz] the decoder is currently expecting
  //   squelchOpen()  the decoder's own narrow squelch
  //   onOffset(hz)   apply the new offset (the caller re-tones its decoder)
  //   charDurationMs one Baudot character, for the Hz-per-character rate
  //   prominenceDb   how far a found pair must stand out above the noise floor
  function createTracker(options) {
    const settingsOf = options.settings;
    const liveValuesOf = options.liveValues;
    const windowOf = options.window;
    const markSpaceOf = options.markSpace;
    const squelchOpenOf = options.squelchOpen || (() => false);
    const onOffset = options.onOffset || (() => {});
    const charDurationMs = options.charDurationMs;
    // How far a found pair must stand out above this scan's own median (a
    // stand-in noise floor -- the real peak is a small minority of the
    // samples, so the median tracks the floor around it) before it is trusted
    // at all. Needed because the decoder's own squelch re-evaluates from raw
    // magnitude every ~1 ms and readily flickers true on pure noise at a low
    // threshold; every flicker used to feed straight into a fresh, meaningless
    // target, visible as the detector line jittering with no real signal.
    const prominenceDb = Number.isFinite(options.prominenceDb) ? options.prominenceDb : 8;

    let offsetHz = 0, targetHz = 0, lastLiveValues = null, lastTickMs = null;

    function reset() { offsetHz = 0; targetHz = 0; onOffset(offsetHz); }

    function tick() {
      const now = Date.now();
      const dtSec = lastTickMs === null ? 0 : Math.max(0, Math.min(1, (now - lastTickMs) / 1000));
      lastTickMs = now;
      const settings = settingsOf();
      if (!settings.afcEnabled) return;

      const values = liveValuesOf();
      // Only act on a FRESH frame -- spectrum.js allocates a new Float32Array
      // per extraction, so identity changing means real new data landed, not
      // just another animation frame re-reading the same numbers.
      if (values && values !== lastLiveValues) {
        lastLiveValues = values;
        const [markHz, spaceHz] = markSpaceOf();
        const {lowHz, highHz} = windowOf();
        const found = findOffset(values, {lowHz, highHz, markHz, spaceHz,
          maxDeviationHz: settings.afcMaxDeviationHz, prominenceDb});
        targetHz = nextTarget(targetHz, found, squelchOpenOf());
      }

      const rateHzPerSec = settings.afcRateHzPerChar * 1000 / charDurationMs;
      const maxStep = rateHzPerSec * dtSec;
      const diff = targetHz - offsetHz;
      offsetHz += Math.max(-maxStep, Math.min(maxStep, diff));
      offsetHz = Math.max(-settings.afcMaxDeviationHz,
                          Math.min(settings.afcMaxDeviationHz, offsetHz));
      onOffset(offsetHz);
    }

    return {tick, reset, offsetHz: () => offsetHz, targetHz: () => targetHz};
  }

  // AUTOTUNE, QRPLog palette (grilled 2026-09-26, docs/rtty-implementace.md
  // kap. 23). The tracker above moves the DECODER onto a signal; this moves
  // the DIAL, so the signal lands on the markers and a reply goes out exactly
  // where the other station is. It is fed the raw findOffset() of every fresh
  // FFT frame -- not the tracker's offset, which is slewed, clamped and dead
  // whenever AFC is switched off (its default).
  //
  // Two states only, on purpose (operator, 2026-09-26: a grey/amber/green
  // pill flickering with every noisy frame was unreadable). SYNCED = at least
  // five recent samples agree; that offset is remembered as the last sync.
  // When the station stops and the detector is left chasing noise the pill
  // goes back to grey, but the last sync stays: a press applies it. It is
  // forgotten only when the dial it was measured on is gone.
  //
  // Samples are DECIMATED to one per sampleIntervalMs (operator, 2026-09-26:
  // a sync must take at least 2 s). The live FFT tap it reads refreshes every
  // 16 ms over a 512 ms window, so undecimated "four agreeing samples" were
  // ~65 ms of 97 %-overlapping windows -- one measurement seen four times.
  // At 500 ms apart the windows barely overlap, and stableCount samples span
  // at least (stableCount - 1) * sampleIntervalMs = 2 s.
  const AUTOTUNE = Object.freeze({
    sampleIntervalMs: 500,
    maxSamples: 10,     // = maxAgeMs / sampleIntervalMs
    maxAgeMs: 5000,     // how long samples count towards a sync
    stableCount: 5,
    toleranceHz: 10,    // samples this close to each other = one steady signal
    deadBandHz: 5,      // already on the markers -- leave the dial alone
    holdoffMs: 1000,    // after a retune the 512 ms FFT still holds the old position
  });

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // samples = [{t, hz}] -> {count, synced, syncHz}. The largest cluster, not
  // the whole buffer: one frame caught on a neighbour or on noise must
  // neither drop a sync nor drag its offset. syncHz is the median of that
  // cluster, or null when fewer than stableCount samples agree.
  function summarizeOffsets(samples, {
    nowMs,
    maxAgeMs = AUTOTUNE.maxAgeMs,
    stableCount = AUTOTUNE.stableCount,
    toleranceHz = AUTOTUNE.toleranceHz,
  } = {}) {
    const hz = (samples || []).filter(s => Number.isFinite(s.hz) &&
      !(nowMs - s.t > maxAgeMs)).map(s => s.hz);
    let best = [];
    for (const centre of hz) {
      const cluster = hz.filter(v => Math.abs(v - centre) <= toleranceHz);
      if (cluster.length > best.length) best = cluster;
    }
    const synced = best.length >= stableCount;
    return {count: hz.length, synced, syncHz: synced ? median(best) : null};
  }

  // The rolling buffer and the remembered sync, clock injected so the
  // holdoff and ageing are testable without waiting.
  //   observe(hz)      one fresh frame's findOffset() result; null is
  //                    ignored, and so is anything within sampleIntervalMs
  //                    of the last sample taken
  //   clear(holdoffMs) the dial moved: forget samples AND the last sync;
  //                    ignore frames for holdoffMs
  //   summary()        {count, synced, syncHz, lastSyncHz}
  //   decide()         {action: 'none'|'on-mark'|'tune', offsetHz} from the
  //                    last sync, whether or not it is still current
  function createAutotune({now = () => Date.now()} = {}) {
    let samples = [], holdoffUntil = 0, lastSyncHz = null, lastTakenMs = null;
    function observe(hz) {
      const t = now();
      if (t < holdoffUntil || !Number.isFinite(hz)) return;
      // Throttled on TAKEN samples, not on frames: a frame without a pair (a
      // gap between characters) does not use up the slot, the next one with
      // a pair is taken instead.
      if (lastTakenMs !== null && t - lastTakenMs < AUTOTUNE.sampleIntervalMs) return;
      lastTakenMs = t;
      samples.push({t, hz});
      if (samples.length > AUTOTUNE.maxSamples) samples.shift();
    }
    function clear(holdoffMs) {
      samples = [];
      lastSyncHz = null;
      lastTakenMs = null;
      holdoffUntil = holdoffMs > 0 ? now() + holdoffMs : 0;
    }
    function summary() {
      const t = now();
      samples = samples.filter(s => !(t - s.t > AUTOTUNE.maxAgeMs));
      const s = summarizeOffsets(samples, {nowMs: t});
      if (s.synced) lastSyncHz = s.syncHz;
      return Object.assign(s, {lastSyncHz});
    }
    function decide() {
      const s = summary();
      if (s.lastSyncHz === null) return {action: 'none', offsetHz: null};
      if (Math.abs(s.lastSyncHz) < AUTOTUNE.deadBandHz) return {action: 'on-mark', offsetHz: s.lastSyncHz};
      return {action: 'tune', offsetHz: s.lastSyncHz};
    }
    return {observe, clear, summary, decide};
  }

  return {findOffset, nextTarget, createTracker, AUTOTUNE, summarizeOffsets, createAutotune};
});
