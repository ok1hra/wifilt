// PROTOTYPE — browser TX intent/state model; the sink alone owns simulated PTT.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8Tx = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const MODES = {
    0: {periodMs: 15000}, 1: {periodMs: 10000}, 2: {periodMs: 6000},
    4: {periodMs: 30000}, 8: {periodMs: 4000},
  };

  // The firmware TX ring holds AUD1_TX_RING_SIZE = 12288 B of 8 kHz uLaw = 1.536 s.
  // Before keying nothing drains it, so the pre-key stream span must stay under
  // that (with margin) or the firmware aborts with "TX ring overflow before write".
  const TX_RING_LIMIT_MS = 1400;
  // How far ahead of its prebuffer an immediate transmission (TUNE) starts streaming.
  const IMMEDIATE_STREAM_LEAD_MS = 200;

  function planSlot(nowUtcMs, mode, correctionMs = 0, leadMs = 800) {
    const period = MODES[mode].periodMs;
    const earliest = nowUtcMs + Math.max(0, leadMs) + correctionMs;
    const correctedSlot = Math.ceil(earliest / period) * period;
    return correctedSlot - correctionMs;
  }

  function packetizeTxPcm48k(pcm, {streamId, txId}) {
    const samples = pcm instanceof Int16Array ? pcm : new Int16Array(pcm);
    const packets = [];
    const samplesPerPacket = 960; // 20 ms, payload 1920 B <= AUD1 maximum.
    for (let offset = 0, sequence = 0; offset < samples.length;
         offset += samplesPerPacket, sequence += 1) {
      const count = Math.min(samplesPerPacket, samples.length - offset);
      const wire = new Uint8Array(40 + count * 2);
      const view = new DataView(wire.buffer);
      wire.set([0x41, 0x55, 0x44, 0x31], 0);
      wire[4] = 1; wire[5] = 3;
      const first = offset === 0;
      const last = offset + count === samples.length;
      view.setUint16(6, (first ? 1 : 0) | (last ? 2 : 0), false);
      view.setUint16(8, 40, false);
      view.setUint32(12, streamId >>> 0, false);
      view.setUint32(16, sequence >>> 0, false);
      view.setUint32(20, 48000, false);
      view.setBigUint64(24, BigInt(offset), false);
      view.setUint32(32, txId >>> 0, false);
      view.setUint32(36, count * 2, false);
      for (let i = 0; i < count; i += 1)
        view.setInt16(40 + i * 2, samples[offset + i], true);
      packets.push(wire);
    }
    return packets;
  }

  function inspectTxPacket(wire) {
    const bytes = wire instanceof Uint8Array ? wire : new Uint8Array(wire);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 40 || String.fromCharCode(...bytes.subarray(0, 4)) !== "AUD1" ||
        bytes[4] !== 1 || bytes[5] !== 3 || view.getUint16(8, false) !== 40 ||
        view.getUint32(20, false) !== 48000 || view.getUint32(36, false) !== bytes.length - 40)
      throw new Error("invalid AUD1 TX packet");
    return {flags: view.getUint16(6, false), streamId: view.getUint32(12, false),
      sequence: view.getUint32(16, false), firstSample: view.getBigUint64(24, false),
      txId: view.getUint32(32, false), samples: (bytes.length - 40) / 2};
  }

  class CaptureTxSink {
    constructor({drainReady = true} = {}) {
      this.drainReady = drainReady;
      this.ptt = false;
      this.sessions = [];
      this.events = [];
      this.current = null;
    }

    prepare(txId, metadata) {
      if (this.ptt || this.current) throw new Error("sink busy");
      this.current = {txId, metadata, packets: [], expectedSequence: 0,
                      expectedSample: 0n, ended: false, started:false};
      this.sessions.push(this.current);
      this.events.push({type: "tx-ready", txId});
      return true;
    }

    begin(txId) {
      if (!this.current || this.current.txId !== txId) throw new Error("TX not prepared");
      this.current.started = true;
      this.events.push({type: "audio-start", txId, ptt:false});
    }

    write(wire) {
      if (!this.current || !this.current.started) throw new Error("audio without prepared session");
      const packet = inspectTxPacket(wire);
      if (packet.txId !== this.current.txId ||
          packet.sequence !== this.current.expectedSequence ||
          packet.firstSample !== this.current.expectedSample)
        throw new Error("TX packet continuity failure");
      this.current.expectedSequence += 1;
      this.current.expectedSample += BigInt(packet.samples);
      this.current.packets.push(wire);
    }

    advance(nowUtcMs) {
      if (!this.current || !this.current.started || this.ptt) return;
      if (nowUtcMs < this.current.metadata.slotUtcMs) return;
      if (Number(this.current.expectedSample) < this.current.metadata.prebufferSamples)
        throw new Error("TX prebuffer missed slot");
      this.ptt = true;
      this.events.push({type:"ptt", value:true, txId:this.current.txId});
    }

    end(txId) {
      if (!this.current || this.current.txId !== txId) throw new Error("wrong TX end");
      const last = inspectTxPacket(this.current.packets.at(-1));
      if ((last.flags & 2) === 0) throw new Error("TX stream lacks LAST");
      this.current.ended = true;
      this.events.push({type: "audio-end", txId});
    }

    isDrained(txId) {
      return Boolean(this.current && this.current.txId === txId &&
                     this.current.ended && this.drainReady);
    }

    complete(txId) {
      if (!this.current || this.current.txId !== txId) throw new Error("wrong TX complete");
      this.ptt = false;
      this.events.push({type: "ptt", value: false, txId});
      this.current = null;
    }

    abort(txId, reason) {
      this.ptt = false;
      this.events.push({type: "abort", txId, reason});
      this.events.push({type: "ptt", value: false, txId});
      this.current = null;
    }
  }

  class TxController {
    // `wallNow` is the single UTC source for every entry point below. Slot
    // planning, pacing and the `clientUtcMs` the firmware validates against must
    // all come from it -- mixing it with a bare Date.now() shifts them apart by
    // the clock correction and the firmware then rejects tx.prepare.
    constructor({buildFrames, encoder, sink, streamId = 0x4a533854,
                 clockCorrectionMs = 0, leadMs = 800, prebufferMs = 1000,
                 streamLeadMs = 350, maxCatchupPackets = 25,
                 wallNow = () => Date.now(),
                 monotonicNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now())}) {
      this.buildFrames = buildFrames;
      this.encoder = encoder;
      this.sink = sink;
      this.streamId = streamId;
      this.clockCorrectionMs = clockCorrectionMs;
      this.leadMs = leadMs;
      this.prebufferMs = prebufferMs;
      this.streamLeadMs = streamLeadMs;
      this.maxCatchupPackets = maxCatchupPackets;
      this.wallNow = wallNow;
      this.monotonicNow = monotonicNow;
      this.nextTxId = 1;
      this.reset();
    }

    reset() {
      this.status = "idle"; this.frames = []; this.frameIndex = 0;
      this.mode = 0; this.toneHz = 1500; this.txId = 0; this.nextSlotUtcMs = null;
      this.prebufferStartUtcMs = null; this.endUtcMs = null;
      this.watchdogUtcMs = null; this.packets = []; this.packetIndex = 0;
      this.currentUtcMs = null;
      this.immediate = false;
      this._audioEnded = false;
      this.error = ""; this.transitions = [];
    }

    transition(status, atUtcMs, detail = "") {
      this.status = status;
      this.transitions.push({status, atUtcMs, detail});
    }

    queue(request, nowUtcMs = this.wallNow()) {
      if (!["idle", "completed", "aborted", "fault"].includes(this.status))
        throw new Error("TX queue is busy");
      if (!MODES[request.mode] || request.toneHz < 500 || request.toneHz > 2700)
        throw new Error("invalid TX mode or tone");
      this.frames = this.buildFrames(request);
      this.frameIndex = 0; this.mode = request.mode; this.toneHz = request.toneHz;
      this.currentUtcMs = nowUtcMs;
      this.immediate = request.immediate === true || request.kind === "tune";
      this.activePrebufferMs = this.immediate ? Math.min(this.prebufferMs, 250)
                                               : this.prebufferMs;
      this.error = ""; this.transitions = [];
      this.transition("queued", nowUtcMs, `${this.frames.length} frames`);
      return this.snapshot();
    }

    prepare(nowUtcMs = this.wallNow()) {
      if (this.status !== "queued") throw new Error("TX is not queued");
      const pending = this.prepareCurrent(nowUtcMs);
      return pending && typeof pending.then === "function"
        ? pending.then(() => this.snapshot()) : this.snapshot();
    }

    prepareCurrent(nowUtcMs) {
      const frame = this.frames[this.frameIndex];
      const modulationStartedMs = this.monotonicNow();
      const pcm = this.encoder(frame, this.mode, this.toneHz);
      const scheduledAtUtcMs = nowUtcMs + Math.max(0, this.monotonicNow() - modulationStartedMs);
      this.currentUtcMs = scheduledAtUtcMs;
      this.txId = this.nextTxId++;
      this.packets = packetizeTxPcm48k(pcm, {streamId: this.streamId, txId: this.txId});
      this.packetIndex = 0;
      // Front-load: begin streaming earlier than the firmware's required prebuffer
      // (metadata.prebufferSamples below is unchanged) so the ring is full ~streamLeadMs
      // before the slot. That absorbs a loop stall during delivery without shifting the
      // key. Capped to the firmware ring capacity.
      //
      // Immediate/tune gets a lead too, just a shorter one. It used to stream exactly
      // its prebuffer span, so the last packet the firmware needed left ~10 ms before
      // the slot: a 20 ms page timer running a little late on a busy page was enough
      // for "TX prebuffer missed slot" (seen on a native build with a TS-480 behind
      // local-trx, every TUNE press).
      const streamSpanMs = Math.min(this.activePrebufferMs +
        (this.immediate ? IMMEDIATE_STREAM_LEAD_MS : this.streamLeadMs), TX_RING_LIMIT_MS);
      this.nextSlotUtcMs = this.immediate
        ? scheduledAtUtcMs + Math.max(streamSpanMs + 100, 350)
        : planSlot(scheduledAtUtcMs, this.mode, this.clockCorrectionMs, this.leadMs);
      this.prebufferStartUtcMs = this.nextSlotUtcMs - streamSpanMs;
      this.endUtcMs = this.nextSlotUtcMs + pcm.length / 48;
      this.watchdogUtcMs = this.endUtcMs + 2000;
      const ready = this.sink.prepare(this.txId, {mode: this.mode, toneHz: this.toneHz,
          frameIndex: this.frameIndex, samples: pcm.length, packets: this.packets.length,
          slotUtcMs:this.nextSlotUtcMs, prebufferSamples:this.activePrebufferMs * 48,
          packetMs:20});
      if (ready && typeof ready.then === "function") {
        this.transition("preparing", scheduledAtUtcMs, `txId ${this.txId}`);
        return ready.then(value => {
          if (!value) throw new Error("TX sink did not become ready");
          if (this.status === "preparing") this.schedulePrepared(scheduledAtUtcMs);
        }).catch(error => this.fail(String(error.message || error), scheduledAtUtcMs));
      }
      if (!ready) throw new Error("TX sink did not become ready");
      this.schedulePrepared(scheduledAtUtcMs);
      return null;
    }

    schedulePrepared(nowUtcMs) {
      this.transition("waiting-slot", nowUtcMs, `slot ${this.nextSlotUtcMs}`);
    }

    tick(nowUtcMs = this.wallNow()) {
      this.currentUtcMs = nowUtcMs;
      try {
        if (this.status === "waiting-slot" && nowUtcMs >= this.prebufferStartUtcMs) {
          this.sink.begin(this.txId);
          this.transition("prebuffering", nowUtcMs, `txId ${this.txId}; PTT OFF`);
        }
        if (this.status === "prebuffering" || this.status === "transmitting") {
          const due = Math.min(this.packets.length, Math.max(0,
            Math.floor((nowUtcMs - this.prebufferStartUtcMs) / 20) + 1));
          if (due - this.packetIndex > this.maxCatchupPackets)
            throw new Error("TX packet pacing missed");
          while (this.packetIndex < due) {
            this.sink.write(this.packets[this.packetIndex], nowUtcMs);
            this.packetIndex += 1;
          }
          if (this.sink.advance) this.sink.advance(nowUtcMs);
          if (this.status === "prebuffering" && nowUtcMs >= this.nextSlotUtcMs) {
            if (this.sink.ptt)
              this.transition("transmitting", nowUtcMs, `txId ${this.txId}`);
            else if (nowUtcMs > this.nextSlotUtcMs + 200)
              throw new Error("TX PTT confirmation timeout");
          }
          if (this.packetIndex === this.packets.length &&
              !this._audioEnded) {
            this.sink.end(this.txId);
            this._audioEnded = true;
          }
        }
        if ((this.status === "transmitting" || this.status === "prebuffering") &&
            nowUtcMs >= this.endUtcMs) {
          if (!this._audioEnded) throw new Error("TX audio incomplete at frame end");
          this.transition("draining", nowUtcMs, `txId ${this.txId}`);
        }
        if (this.status === "draining") {
          if (this.sink.isDrained(this.txId)) this.completeFrame(nowUtcMs);
          else if (nowUtcMs > this.watchdogUtcMs) this.fail("drain watchdog", nowUtcMs);
        }
      } catch (error) {
        this.fail(String(error.message || error), nowUtcMs);
      }
      return this.snapshot();
    }

    completeFrame(nowUtcMs) {
      this.sink.complete(this.txId);
      this._audioEnded = false;
      this.frameIndex += 1;
      if (this.frameIndex >= this.frames.length) {
        this.packets = [];
        this.transition("completed", nowUtcMs, "PTT OFF");
      } else {
        this.prepareCurrent(nowUtcMs);
      }
    }

    abort(reason = "operator", nowUtcMs = this.wallNow()) {
      this.currentUtcMs = nowUtcMs;
      // Why the transmission ended is what tells an operator STOP apart from a lost
      // WebSocket, and the resend policy turns on exactly that difference. Without it
      // the caller only sees "aborted" and has to guess.
      this.error = reason;
      if (!["idle", "completed", "aborted"].includes(this.status))
        this.sink.abort(this.txId, reason);
      this.packets = [];
      this.transition("aborted", nowUtcMs, `${reason}; PTT OFF`);
      return this.snapshot();
    }

    disconnect(nowUtcMs = this.wallNow()) {
      return this.abort("websocket lost", nowUtcMs);
    }

    fail(reason, nowUtcMs) {
      this.currentUtcMs = nowUtcMs;
      this.error = reason;
      this.sink.abort(this.txId, reason);
      this.packets = [];
      this.transition("fault", nowUtcMs, `${reason}; PTT OFF`);
    }

    snapshot() {
      const duration=Number(this.endUtcMs)-Number(this.nextSlotUtcMs);
      const frameProgress=this.status==="draining" ? 1 : this.status==="transmitting"&&duration>0
        ? Math.max(0,Math.min(1,(Number(this.currentUtcMs)-Number(this.nextSlotUtcMs))/duration)) : 0;
      return {status: this.status, mode: this.mode, toneHz: this.toneHz,
        frameIndex: this.frameIndex, frameCount: this.frames.length, txId: this.txId,
        nextSlotUtcMs: this.nextSlotUtcMs,
        prebufferStartUtcMs:this.prebufferStartUtcMs, endUtcMs: this.endUtcMs,
        watchdogUtcMs: this.watchdogUtcMs, packetCount: this.packets.length,
        packetIndex:this.packetIndex,
        nowUtcMs:this.currentUtcMs, frameProgress,
        immediate:this.immediate,
        ptt: Boolean(this.sink.ptt), error: this.error,
        transitions: this.transitions.slice(), frames: this.frames.slice()};
    }
  }

  return {CaptureTxSink, TxController, inspectTxPacket, packetizeTxPcm48k, planSlot};
});
