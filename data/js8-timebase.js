// PROTOTYPE — pure sample-indexed UTC/time-correction state model.
// Question: can browser wall time survive packet jitter, gaps, reconnects and
// clock jumps without moving accepted samples, while decode dt converges only
// through bounded, consistent corrections?

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8Timebase = value.Js8Timebase;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] :
      (sorted[middle - 1] + sorted[middle]) / 2;
  }

  class Js8Timebase {
    constructor(options = {}) {
      this.sampleRate = options.sampleRate || 8000;
      this.anchorPacketCount = options.anchorPacketCount || 5;
      this.clockJumpThresholdMs = options.clockJumpThresholdMs || 100;
      this.timingSamplesRequired = options.timingSamplesRequired || 3;
      this.timingToleranceMs = options.timingToleranceMs || 40;
      this.maxTimingObservationMs = options.maxTimingObservationMs || 1500;
      this.maxTimingStepMs = options.maxTimingStepMs || 50;
      this.maxAutoCorrectionMs = options.maxAutoCorrectionMs || 1000;
      this.settleThresholdMs = options.settleThresholdMs || 5;

      this.wallMinusMonotonicMs = null;
      this.clockEpoch = 0;
      this.clockJumps = 0;
      this.lastClockJumpMs = 0;
      this.clockConfirmed = false;
      this.mediaEpoch = 0;
      this.streamId = null;
      this.mediaStatus = "unanchored";
      this.mediaEpochReason = "initial";
      this.anchorUtcSample0Ms = null;
      this.anchorCandidates = [];
      this.anchorCandidateCount = 0;
      this.minCandidateSinceLockMs = null;
      this.anchorLateMs = 0;
      this.anchorProofs = 0;
      this.expectedSample = null;
      this.expectedSequence = null;
      this.seenPackets = new Set();
      this.seenPacketOrder = [];

      this.acceptedPackets = 0;
      this.duplicatePackets = 0;
      this.sequenceGaps = 0;
      this.gapSamples = 0;
      this.overlapSamples = 0;
      this.discontinuities = 0;
      this.reconnects = 0;
      this.slotFlushes = 0;
      this.maxTransportDelayMs = 0;

      this.manualCorrectionMs = Number(options.manualCorrectionMs || 0);
      this.autoCorrectionMs = 0;
      this.autoTimingEnabled = options.autoTimingEnabled !== false;
      this.autoTimingStatus = this.autoTimingEnabled ? "collecting" : "off";
      this.timingUpdates = 0;
      this.timingOutliers = 0;
      this.lastTimingUpdateMs = 0;
      this.timingLanes = new Map();
      this.stationTiming = new Map();
      this.seenDecodes = new Set();
      this.seenDecodeOrder = [];
    }

    observeClock(wallMs, monotonicMs) {
      if (!Number.isFinite(wallMs) || !Number.isFinite(monotonicMs))
        throw new Error("clock observation must be finite");
      const observedOffset = wallMs - monotonicMs;
      if (this.wallMinusMonotonicMs === null) {
        this.wallMinusMonotonicMs = observedOffset;
        this.clockEpoch = 1;
        return {jump: false, deltaMs: 0};
      }
      const deltaMs = observedOffset - this.wallMinusMonotonicMs;
      if (Math.abs(deltaMs) <= this.clockJumpThresholdMs)
        return {jump: false, deltaMs};

      this.wallMinusMonotonicMs = observedOffset;
      this.clockEpoch += 1;
      this.clockJumps += 1;
      this.lastClockJumpMs = deltaMs;
      this.clockConfirmed = false;
      this._resetAutoTiming(false);
      this._beginMediaEpoch(this.streamId, "clock-jump");
      return {jump: true, deltaMs};
    }

    observePacket(packet) {
      const required = ["streamId", "sequence", "firstSample", "sampleCount",
        "arrivalWallMs", "arrivalMonotonicMs"];
      for (const field of required)
        if (!Number.isFinite(Number(packet[field])))
          throw new Error(`packet ${field} must be finite`);
      if (packet.sampleCount <= 0) throw new Error("packet sampleCount must be positive");

      const clock = this.observeClock(packet.arrivalWallMs,
                                      packet.arrivalMonotonicMs);
      if (this.streamId === null || packet.streamId !== this.streamId)
        this._beginMediaEpoch(packet.streamId,
          this.streamId === null ? "first-stream" : "stream-change");

      const packetKey = `${packet.streamId}|${packet.sequence}`;
      if (this.seenPackets.has(packetKey)) {
        this.duplicatePackets += 1;
        return {accepted: false, duplicate: true, clockJump: clock.jump,
          state: this.snapshot()};
      }
      this.seenPackets.add(packetKey);
      this.seenPacketOrder.push(packetKey);
      if (this.seenPacketOrder.length > 512)
        this.seenPackets.delete(this.seenPacketOrder.shift());

      if (this.expectedSequence !== null && packet.sequence > this.expectedSequence)
        this.sequenceGaps += packet.sequence - this.expectedSequence;
      this.expectedSequence = packet.sequence + 1;

      if (this.expectedSample !== null) {
        if (packet.firstSample > this.expectedSample) {
          this.gapSamples += packet.firstSample - this.expectedSample;
          this.discontinuities += 1;
        } else if (packet.firstSample < this.expectedSample) {
          this.overlapSamples += Math.min(this.expectedSample - packet.firstSample,
                                         packet.sampleCount);
        }
      }
      if (packet.discontinuity) this.discontinuities += 1;
      this.expectedSample = Math.max(this.expectedSample || 0,
        packet.firstSample + packet.sampleCount);
      this.acceptedPackets += 1;

      const stableArrivalWall = this.wallMinusMonotonicMs +
        packet.arrivalMonotonicMs;
      const packetEndMs = (packet.firstSample + packet.sampleCount) * 1000 /
        this.sampleRate;
      const candidate = stableArrivalWall - packetEndMs;
      if (this.mediaStatus !== "locked") {
        this.anchorCandidates.push(candidate);
        this.anchorCandidateCount += 1;
        if (this.anchorCandidates.length >= this.anchorPacketCount) {
          this.anchorUtcSample0Ms = Math.min(...this.anchorCandidates);
          this.mediaStatus = "locked";
          this.maxTransportDelayMs = Math.max(...this.anchorCandidates) -
            this.anchorUtcSample0Ms;
        }
      } else {
        this.maxTransportDelayMs = Math.max(this.maxTransportDelayMs,
          candidate - this.anchorUtcSample0Ms);
        // The other half of the same measurement, and the half that decides whether
        // anything decodes. The anchor is five packets wide and taken while the page
        // is still loading, so a main-thread stall or a burst of transport delay in
        // that half second freezes a sample-0 estimate that is too LATE, and every
        // decode dt then carries the error for the life of the epoch. A later packet
        // implying an EARLIER sample 0 is proof of exactly how much too late, because
        // transport delay can only ever push a candidate later than the truth.
        if (this.minCandidateSinceLockMs === null ||
            candidate < this.minCandidateSinceLockMs) {
          this.minCandidateSinceLockMs = candidate;
          if (candidate < this.anchorUtcSample0Ms) {
            this.anchorLateMs = this.anchorUtcSample0Ms - candidate;
            this.anchorProofs += 1;
          }
        }
      }

      return {accepted: true, duplicate: false, clockJump: clock.jump,
        state: this.snapshot()};
    }

    mediaUtcMs(sampleIndex, sampleRate = this.sampleRate) {
      if (this.mediaStatus !== "locked") return null;
      return this.anchorUtcSample0Ms + Number(sampleIndex) * 1000 / sampleRate +
        this.totalCorrectionMs();
    }

    slotUtcMs(sampleIndex, periodMs, sampleRate = this.sampleRate) {
      const utcMs = this.mediaUtcMs(sampleIndex, sampleRate);
      return utcMs === null ? null : Math.floor(utcMs / periodMs) * periodMs;
    }

    observeDecode(observation) {
      const dtMs = Number(observation.dtMs);
      const mode = Number(observation.submode);
      const slotUtcMs = Number(observation.slotUtcMs);
      if (!Number.isFinite(dtMs) || !Number.isFinite(mode) ||
          !Number.isFinite(slotUtcMs)) throw new Error("invalid decode timing");
      const call = observation.call || "";
      const key = `${mode}|${slotUtcMs}|${call}`;
      if (this.seenDecodes.has(key)) return {accepted: false, duplicate: true};
      this.seenDecodes.add(key);
      this.seenDecodeOrder.push(key);
      if (this.seenDecodeOrder.length > 512)
        this.seenDecodes.delete(this.seenDecodeOrder.shift());

      const station = this.stationTiming.get(call) ||
        {call, samples: 0, meanDtMs: dtMs, lastDtMs: dtMs};
      station.meanDtMs = station.samples === 0 ? dtMs :
        station.meanDtMs * 0.8 + dtMs * 0.2;
      station.lastDtMs = dtMs;
      station.samples += 1;
      this.stationTiming.set(call, station);

      if (Math.abs(dtMs) > this.maxTimingObservationMs) {
        this.timingOutliers += 1;
        return {accepted: false, outlier: true};
      }
      if (!this.autoTimingEnabled) return {accepted: true, adjusted: false};

      const lane = this.timingLanes.get(mode) || [];
      lane.push(dtMs);
      while (lane.length > this.timingSamplesRequired) lane.shift();
      this.timingLanes.set(mode, lane);
      this.autoTimingStatus = "collecting";
      if (lane.length < this.timingSamplesRequired)
        return {accepted: true, adjusted: false};

      const center = median(lane);
      const spread = Math.max(...lane.map(value => Math.abs(value - center)));
      if (spread > this.timingToleranceMs)
        return {accepted: true, adjusted: false, inconsistent: true,
          medianMs: center, spreadMs: spread};

      this.timingLanes.clear();
      if (Math.abs(center) <= this.settleThresholdMs) {
        this.autoTimingStatus = "locked";
        return {accepted: true, adjusted: false, locked: true,
          medianMs: center, spreadMs: spread};
      }
      const stepMs = clamp(center, -this.maxTimingStepMs, this.maxTimingStepMs);
      this.autoCorrectionMs = clamp(this.autoCorrectionMs + stepMs,
        -this.maxAutoCorrectionMs, this.maxAutoCorrectionMs);
      this.timingUpdates += 1;
      this.lastTimingUpdateMs = stepMs;
      this.autoTimingStatus = "adjusting";
      return {accepted: true, adjusted: true, stepMs,
        correctionMs: this.autoCorrectionMs, medianMs: center,
        spreadMs: spread};
    }

    setManualCorrection(valueMs) {
      if (!Number.isFinite(Number(valueMs))) throw new Error("invalid correction");
      this.manualCorrectionMs = Number(valueMs);
    }

    setAutoTiming(enabled) {
      this.autoTimingEnabled = Boolean(enabled);
      this.autoTimingStatus = this.autoTimingEnabled ? "collecting" : "off";
      this.timingLanes.clear();
    }

    resetTiming() {
      this._resetAutoTiming(true);
    }

    // The transport (WsAudioSource) calls this the moment its WebSocket closes --
    // BEFORE any packet of a future reconnect exists to trigger observePacket()'s
    // own stream-change detection. Without it `mediaStatus` stays "locked" from the
    // dead stream across the whole reconnect+hello handshake, since nothing else
    // ever clears it proactively: only a NEW packet's streamId mismatch does
    // (_beginMediaEpoch, below), and that cannot happen before the new stream's
    // first packet arrives. Confirmed on real hardware (2026-08-25): a WS drop
    // mid-TX left mediaStatus="locked" stale, so `txBlockReasons()`'s "audio
    // timebase is not locked" gate read false-clear, and the resend plan's one
    // automatic retry (docs/js8-tx-resend-plan.md decision 4, meant to wait for
    // "the gate to open again") fired within milliseconds into a session whose
    // `hello` was still null, burning the single attempt on "AUD1 hello not
    // received" instead of the real recovery a few seconds later.
    noteStreamLost() {
      if (this.streamId === null && this.mediaStatus === "unanchored") return;
      this.streamId = null;
      this.mediaStatus = "unanchored";
      this.mediaEpochReason = "closed";
      this.anchorUtcSample0Ms = null;
      this.anchorCandidates = [];
      this.anchorCandidateCount = 0;
      this.minCandidateSinceLockMs = null;
      this.anchorLateMs = 0;
      this.anchorProofs = 0;
      this.expectedSample = null;
      this.expectedSequence = null;
    }

    confirmClock() {
      this.clockConfirmed = true;
    }

    totalCorrectionMs() {
      return this.manualCorrectionMs + this.autoCorrectionMs;
    }

    snapshot() {
      return {
        clock: {epoch: this.clockEpoch,
          status: this.clockConfirmed ? "confirmed" : "unchecked",
          jumps: this.clockJumps, lastJumpMs: this.lastClockJumpMs},
        media: {epoch: this.mediaEpoch, reason: this.mediaEpochReason,
          streamId: this.streamId, status: this.mediaStatus,
          anchorUtcSample0Ms: this.anchorUtcSample0Ms,
          anchorCandidates: this.anchorCandidateCount,
          anchorLateMs: this.anchorLateMs, anchorProofs: this.anchorProofs,
          expectedSample: this.expectedSample, slotFlushes: this.slotFlushes},
        transport: {acceptedPackets: this.acceptedPackets,
          duplicatePackets: this.duplicatePackets,
          sequenceGaps: this.sequenceGaps, gapSamples: this.gapSamples,
          overlapSamples: this.overlapSamples,
          discontinuities: this.discontinuities, reconnects: this.reconnects,
          maxTransportDelayMs: this.maxTransportDelayMs},
        correction: {manualMs: this.manualCorrectionMs,
          autoMs: this.autoCorrectionMs, totalMs: this.totalCorrectionMs(),
          enabled: this.autoTimingEnabled, status: this.autoTimingStatus,
          updates: this.timingUpdates, outliers: this.timingOutliers,
          lastStepMs: this.lastTimingUpdateMs},
        timing: [...this.stationTiming.values()].map(value => ({...value}))
          .sort((a, b) => a.call.localeCompare(b.call)),
      };
    }

    _beginMediaEpoch(streamId, reason) {
      const hadStream = this.streamId !== null;
      if (hadStream && reason === "stream-change") this.reconnects += 1;
      if (hadStream) this.slotFlushes += 1;
      this.mediaEpoch += 1;
      this.streamId = streamId;
      this.mediaStatus = "anchoring";
      this.mediaEpochReason = reason;
      this.anchorUtcSample0Ms = null;
      this.anchorCandidates = [];
      this.anchorCandidateCount = 0;
      this.minCandidateSinceLockMs = null;
      this.anchorLateMs = 0;
      this.anchorProofs = 0;
      this.expectedSample = null;
      this.expectedSequence = null;
      this.seenPackets.clear();
      this.seenPacketOrder = [];
      this.maxTransportDelayMs = 0;
    }

    _resetAutoTiming(clearStations) {
      this.autoCorrectionMs = 0;
      this.autoTimingStatus = this.autoTimingEnabled ? "collecting" : "off";
      this.lastTimingUpdateMs = 0;
      this.timingLanes.clear();
      this.seenDecodes.clear();
      this.seenDecodeOrder = [];
      if (clearStations) this.stationTiming.clear();
    }
  }

  return {Js8Timebase, median};
});
