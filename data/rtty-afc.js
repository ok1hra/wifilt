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

  return {findOffset, nextTarget};
});
