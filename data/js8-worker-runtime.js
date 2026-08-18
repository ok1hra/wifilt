// PROTOTYPE — pure Worker state model over the two WASM modules.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8WorkerRuntime = value.Js8WorkerRuntime;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const RING_SAMPLES = 60 * 12000;

  function parseAud1(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 40 || bytes[0] !== 0x41 || bytes[1] !== 0x55 ||
        bytes[2] !== 0x44 || bytes[3] !== 0x31 || bytes[4] !== 1)
      throw new Error("invalid AUD1 header");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const payloadBytes = view.getUint32(36, false);
    if (view.getUint16(8, false) !== 40 || 40 + payloadBytes !== bytes.length ||
        bytes[5] !== 1 || view.getUint32(20, false) !== 8000)
      throw new Error("unsupported AUD1 RX packet");
    return {
      flags: view.getUint16(6, false),
      streamId: view.getUint32(12, false),
      sequence: view.getUint32(16, false),
      firstSample: view.getBigUint64(24, false),
      payload: bytes.subarray(40),
    };
  }

  class Js8WorkerRuntime {
    constructor(audioWasm, decoderWasm, anchorUtcMs = 0n, protocol = null,
                options = {}) {
      this.audioWasm = audioWasm;
      this.decoderWasm = decoderWasm;
      this.anchorUtcMs = BigInt(anchorUtcMs);
      this.strictEpochAnchoring = Boolean(options.strictEpochAnchoring);
      this.epochReady = !this.strictEpochAnchoring;
      this.protocol = protocol;
      this.audio = audioWasm._js8_audio_create(this.anchorUtcMs);
      this.decoder = decoderWasm._js8_wasm_decoder_create();
      this.windowPtr = audioWasm._malloc(32);
      this.snapshotPtr = audioWasm._malloc(80);
      this.eventPtr = decoderWasm._malloc(44);
      this.ring = new Int16Array(RING_SAMPLES);
      this.totalSamples = 0;
      this.streamId = null;
      this.frames = [];
      this.dedupe = new Set();
      this.dedupeOrder = [];
      this.windows = 0;
      this.windowsByMode = {0: 0, 1: 0, 2: 0, 4: 0, 8: 0};
      this.resetDecodeStats();
      if (this.protocol && this.protocol.discontinuity)
        this.protocol.discontinuity();
    }

    // What the decoder actually did with the windows it was handed. Counted here
    // because this is the only place that knows: the page sees frames when there
    // are frames, and a decoder that never ran looks exactly like a dead band.
    resetDecodeStats() {
      this.decodedWindows = 0;
      this.decodeEvents = 0;
      this.skippedWindows = 0;
      this.lastSkip = null;
      this.recentDecodes = [];
    }

    reset(streamId, anchorUtcMs = this.anchorUtcMs,
          epochReady = !this.strictEpochAnchoring) {
      this.anchorUtcMs = BigInt(anchorUtcMs);
      this.audioWasm._js8_audio_reset(this.audio, this.anchorUtcMs);
      this.ring.fill(0);
      this.totalSamples = 0;
      this.streamId = streamId;
      this.epochReady = epochReady;
      this.frames = [];
      this.dedupe.clear();
      this.dedupeOrder = [];
      this.windows = 0;
      this.windowsByMode = {0: 0, 1: 0, 2: 0, 4: 0, 8: 0};
      this.resetDecodeStats();
      if (this.protocol && this.protocol.discontinuity)
        this.protocol.discontinuity();
    }

    beginEpoch(streamId, anchorUtcMs) {
      if (!Number.isInteger(Number(streamId)) || Number(streamId) < 0)
        throw new Error("epoch streamId must be a non-negative integer");
      if (!Number.isFinite(Number(anchorUtcMs)))
        throw new Error("epoch anchorUtcMs must be finite");
      this.reset(Number(streamId), BigInt(Math.round(Number(anchorUtcMs))), true);
      return this.state();
    }

    pushAud1(wire, arrivalMs) {
      const packet = parseAud1(wire);
      if (this.strictEpochAnchoring) {
        if (!this.epochReady)
          throw new Error("audio rejected: media epoch is not anchored");
        if (this.streamId !== packet.streamId)
          throw new Error(`audio rejected: stream ${packet.streamId} does not match anchored epoch ${this.streamId}`);
      } else if (this.streamId !== packet.streamId) {
        this.reset(packet.streamId);
      }
      const inputPtr = this.audioWasm._malloc(packet.payload.length);
      this.audioWasm.HEAPU8.set(packet.payload, inputPtr);
      const produced = this.audioWasm._js8_audio_push_ulaw(
        this.audio, packet.sequence, packet.firstSample, arrivalMs,
        (packet.flags & 0x0004) !== 0 ? 1 : 0,
        inputPtr, packet.payload.length
      );
      this.audioWasm._free(inputPtr);
      this.copyAudioOutput(produced);
      this.drainWindows();
      return this.state();
    }

    finish() {
      const produced = this.audioWasm._js8_audio_finish(this.audio);
      this.copyAudioOutput(produced);
      this.drainWindows();
      return this.state();
    }

    copyAudioOutput(count) {
      if (count <= 0) return;
      const outputPtr = this.audioWasm._malloc(count * 4);
      const copied = this.audioWasm._js8_audio_copy_output(
        this.audio, outputPtr, count
      );
      const floats = this.audioWasm.HEAPF32.slice(
        outputPtr >> 2, (outputPtr >> 2) + copied
      );
      this.audioWasm._free(outputPtr);
      for (const value of floats) {
        const pcm = Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
        this.ring[this.totalSamples % RING_SAMPLES] = pcm;
        this.totalSamples += 1;
      }
    }

    drainWindows() {
      while (this.audioWasm._js8_audio_next_window(this.audio, this.windowPtr)) {
        const memory = new DataView(this.audioWasm.HEAPU8.buffer);
        const mode = memory.getInt32(this.windowPtr, true);
        const slotUtcMs = memory.getBigInt64(this.windowPtr + 8, true);
        const firstSample = Number(memory.getBigUint64(this.windowPtr + 16, true));
        const sampleCount = Number(memory.getBigUint64(this.windowPtr + 24, true));
        this.windows += 1;
        this.windowsByMode[mode] += 1;
        this.decodeWindow(mode, slotUtcMs, firstSample, sampleCount);
        // The reassembly clock: a window exists for every slot whether anything decoded
        // or not, so partial receptions age out even on a dead band, with no wall clock
        // in the worker and deterministic behaviour in tests.
        this.expire(Number(slotUtcMs));
      }
    }

    // Also reachable from the page on a 1 s job: when audio stops for good, no window is
    // produced and a stranded partial would otherwise pose as a live reception forever.
    expire(nowMs) {
      if (this.protocol && this.protocol.expire) this.protocol.expire(nowMs);
    }

    decodeWindow(mode, slotUtcMs, firstSample, sampleCount) {
      // A window the ring cannot serve used to return in silence, and silence is
      // indistinguishable from a quiet band: the decoder never ran, no frame came
      // out, and nothing anywhere said so. `evicted` means the audio was overwritten
      // before the window was drained (the worker is behind real time); `incomplete`
      // means the scheduler released a window the audio path had not finished
      // producing, which should never happen and is a bug the moment it is nonzero.
      const incomplete = firstSample + sampleCount > this.totalSamples;
      if (firstSample < this.totalSamples - RING_SAMPLES || incomplete) {
        this.skippedWindows += 1;
        this.lastSkip = {mode, slotUtcMs: Number(slotUtcMs),
          reason: incomplete ? "incomplete" : "evicted",
          missingMs: Math.round((incomplete
            ? firstSample + sampleCount - this.totalSamples
            : this.totalSamples - RING_SAMPLES - firstSample) / 12)};
        return;
      }
      const pcmPtr = this.decoderWasm._malloc(sampleCount * 2);
      const heap = this.decoderWasm.HEAP16;
      for (let i = 0; i < sampleCount; i += 1)
        heap[(pcmPtr >> 1) + i] = this.ring[(firstSample + i) % RING_SAMPLES];
      const count = this.decoderWasm._js8_wasm_decoder_run(
        this.decoder, pcmPtr, sampleCount, mode, 0, 5000, 1500
      );
      this.decoderWasm._free(pcmPtr);
      if (count < 0) throw new Error(`decoder rejected mode ${mode}`);
      if (count > 0) this.decodedWindows += 1;

      while (this.decoderWasm._js8_wasm_decoder_next_event(
        this.decoder, this.eventPtr
      )) {
        const bytes = this.decoderWasm.HEAPU8.slice(
          this.eventPtr + 16, this.eventPtr + 29
        );
        const zero = bytes.indexOf(0);
        const raw = String.fromCharCode(...(zero < 0 ? bytes : bytes.slice(0, zero)));
        const view = new DataView(this.decoderWasm.HEAPU8.buffer);
        const frame = {
          type: "frame",
          slotUtcMs: Number(slotUtcMs),
          submode: view.getInt32(this.eventPtr + 40, true),
          snr: view.getInt32(this.eventPtr + 4, true),
          dtMs: Math.round(view.getFloat32(this.eventPtr + 8, true) * 1000),
          offsetHz: view.getFloat32(this.eventPtr + 12, true),
          raw,
          frameType: view.getInt32(this.eventPtr + 32, true),
          quality: view.getFloat32(this.eventPtr + 36, true),
        };
        const key = `${frame.slotUtcMs}|${frame.submode}|${frame.offsetHz.toFixed(1)}|${frame.raw}`;
        if (!this.dedupe.has(key)) {
          this.dedupe.add(key);
          this.dedupeOrder.push(key);
          if (this.dedupeOrder.length > 2048)
            this.dedupe.delete(this.dedupeOrder.shift());
          this.frames.push(frame);
          // dt is the whole diagnosis for a station that is heard but not decoded:
          // it says by how much this reception sat off the slot the scheduler cut,
          // and a bias shared by every station is the anchor, not the band. Kept as
          // a short tail so the state message stays small.
          this.decodeEvents += 1;
          this.recentDecodes.push({slotUtcMs: frame.slotUtcMs, submode: frame.submode,
            dtMs: frame.dtMs, snr: frame.snr, offsetHz: frame.offsetHz});
          if (this.recentDecodes.length > 8) this.recentDecodes.shift();
          if (this.protocol) this.protocol.push(frame);
        }
      }
    }

    state() {
      this.audioWasm._js8_audio_snapshot(this.audio, this.snapshotPtr);
      const audioView = new DataView(this.audioWasm.HEAPU8.buffer);
      return {
        streamId: this.streamId,
        totalSamples12k: this.totalSamples,
        windows: this.windows,
        windowsByMode: {...this.windowsByMode},
        frames: this.frames.slice(),
        activity: this.protocol ? this.protocol.snapshot() : null,
        decode: {decodedWindows: this.decodedWindows, events: this.decodeEvents,
          skippedWindows: this.skippedWindows, lastSkip: this.lastSkip,
          recent: this.recentDecodes.slice()},
        epoch: {strict: this.strictEpochAnchoring, ready: this.epochReady,
          streamId: this.streamId, anchorUtcMs: Number(this.anchorUtcMs)},
        audio: {
          expectedSample8k: Number(audioView.getBigUint64(this.snapshotPtr, true)),
          acceptedPackets: Number(audioView.getBigUint64(this.snapshotPtr + 8, true)),
          duplicatePackets: Number(audioView.getBigUint64(this.snapshotPtr + 16, true)),
          sequenceGaps: Number(audioView.getBigUint64(this.snapshotPtr + 24, true)),
          discontinuities: Number(audioView.getBigUint64(this.snapshotPtr + 32, true)),
          insertedGapSamples8k: Number(audioView.getBigUint64(this.snapshotPtr + 40, true)),
          producedSamples12k: Number(audioView.getBigUint64(this.snapshotPtr + 48, true)),
          maxArrivalJitterMs: audioView.getFloat64(this.snapshotPtr + 56, true),
          peak: audioView.getFloat32(this.snapshotPtr + 64, true),
          rms: audioView.getFloat64(this.snapshotPtr + 72, true),
        },
        audioMemoryBytes: this.audioWasm.HEAPU8.buffer.byteLength,
        decoderMemoryBytes: this.decoderWasm.HEAPU8.buffer.byteLength,
      };
    }

    destroy() {
      this.audioWasm._free(this.windowPtr);
      this.audioWasm._free(this.snapshotPtr);
      this.decoderWasm._free(this.eventPtr);
      this.audioWasm._js8_audio_destroy(this.audio);
      this.decoderWasm._js8_wasm_decoder_destroy(this.decoder);
    }
  }

  return {Js8WorkerRuntime, parseAud1};
});
