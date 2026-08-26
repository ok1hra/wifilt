// PROTOTYPE — metadata-preserving AudioSource candidate for strict JS8 epochs.

(function (root, factory) {
  const value = factory(
    typeof module === "object" && module.exports
      ? require("./aud1_websocket_session.js") : root.Js8Aud1Transport,
    typeof module === "object" && module.exports
      ? require("../timebase/js8_timebase.js") : {Js8Timebase: root.Js8Timebase}
  );
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8WsAudioSource = value;
})(typeof globalThis !== "undefined" ? globalThis : self,
function (Transport, Timebase) {
  class WsAudioSource {
    constructor(sampleRate = 8000, options = {}) {
      if (!Transport?.Aud1WebSocketSession || !Timebase?.Js8Timebase)
        throw new Error("WsAudioSource requires AUD1 transport and Js8Timebase");
      this.sampleRate = sampleRate;
      this.url = options.url;
      this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
      this.wallNow = options.wallNow || (() => Date.now());
      this.monotonicNow = options.monotonicNow || (() => performance.now());
      this.reconnectMs = options.reconnectMs ?? 1000;
      this.anchorPacketCount = options.anchorPacketCount ?? 5;
      this.TimebaseImpl = options.TimebaseImpl || Timebase.Js8Timebase;
      this.SessionImpl = options.SessionImpl || Transport.Aud1WebSocketSession;
      this._samplesCallback = null;
      this._packetCallback = null;
      this._epochCallback = null;
      this._statusCallback = null;
      this._controlCallback = null;
      this._session = null;
      this._pending = [];
      this._announcedEpoch = 0;
      this._readyStreamId = null;
      this._running = false;
      this._timebase = new this.TimebaseImpl({sampleRate,
        anchorPacketCount:this.anchorPacketCount});
    }

    onSamples(callback) { this._samplesCallback = callback; return this; }
    onPacket(callback) { this._packetCallback = callback; return this; }
    onEpoch(callback) { this._epochCallback = callback; return this; }
    onStatus(callback) { this._statusCallback = callback; return this; }
    // Raw control frames, for what the status events cannot express. tx-level is
    // the one that matters: it carries the ALC reading the gain limiter acts on,
    // five times a second, and unlike a timer it keeps arriving in a background
    // tab.
    onControl(callback) { this._controlCallback = callback; return this; }

    start() {
      if (this._running) return;
      if (!this.url || !this.WebSocketImpl)
        throw new Error("WsAudioSource requires URL and WebSocket implementation");
      this._running = true;
      this._session = new this.SessionImpl({url:this.url,
        WebSocketImpl:this.WebSocketImpl, reconnectMs:this.reconnectMs,
        now:this.monotonicNow, wallNow:this.wallNow})
        .onSamples((samples, rate, metadata) =>
          this._receiveSamples(samples, rate, metadata))
        .onStatus(status => this._receiveStatus(status))
        .onControl(message => {
          if (this._controlCallback) this._controlCallback(message);
        });
      this._session.start();
    }

    stop() {
      this._running = false;
      if (this._session) this._session.stop();
      this._session = null;
      this._pending = [];
      this._emitStatus({type:"stopped"});
    }

    state() {
      return {running:this._running, readyStreamId:this._readyStreamId,
        bufferedPackets:this._pending.length,
        timebase:this._timebase.snapshot()};
    }

    configure(options = {}) {
      if (Object.prototype.hasOwnProperty.call(options, "clockCorrectionMs"))
        this._timebase.setManualCorrection(options.clockCorrectionMs);
      if (Object.prototype.hasOwnProperty.call(options, "autoTiming"))
        this._timebase.setAutoTiming(options.autoTiming);
      return this;
    }

    observeDecode(frame, call = "") {
      return this._timebase.observeDecode({...frame, call});
    }

    confirmClock() { this._timebase.confirmClock(); }
    resetTiming() { this._timebase.resetTiming(); }

    // TxController sink contract. The WebSocket session remains the sole
    // browser-side owner of AUD1 TX control and packet writes.
    prepare(txId, metadata) { return this._requireSession().prepare(txId, metadata); }
    begin(txId) { return this._requireSession().begin(txId); }
    write(wire) { return this._requireSession().write(wire); }
    end(txId) { return this._requireSession().end(txId); }
    isDrained(txId) { return this._session ? this._session.isDrained(txId) : false; }
    complete(txId) { return this._requireSession().complete(txId); }
    abort(txId, reason) {
      if (this._session) return this._session.abort(txId, reason);
    }
    // Both needed by the WSPR pacing driver, which the calibration tool runs over
    // this same socket: the keepalive that refreshes the firmware's dead-man, and
    // the backlog figure it treats as proof the link cannot carry the pace.
    sendControl(message) { return this._requireSession().sendControl(message); }
    get bufferedAmount() { return this._session ? this._session.bufferedAmount : 0; }
    get ptt() { return Boolean(this._session && this._session.ptt); }

    _requireSession() {
      if (!this._session) throw new Error("AUD1 WebSocket session is not running");
      return this._session;
    }

    _receiveStatus(status) {
      if (status.type === "ready") {
        this._readyStreamId = status.streamId;
        this._pending = [];
      } else if (status.type === "closed") {
        this._readyStreamId = null;
        this._pending = [];
        // See Js8Timebase.noteStreamLost()'s own comment: without this,
        // mediaStatus stays "locked" (stale, from the dead stream) for the
        // whole reconnect+hello handshake, letting txBlockReasons()'s "audio
        // timebase is not locked" gate read clear too early.
        this._timebase.noteStreamLost();
      }
      this._emitStatus(status);
    }

    _receiveSamples(samples, rate, metadata) {
      if (!this._running) return;
      if (this._readyStreamId === null)
        return this._emitStatus({type:"protocol-error",
          message:"audio received before ready"});
      if (metadata.streamId !== this._readyStreamId)
        return this._emitStatus({type:"protocol-error",
          message:"audio stream differs from hello"});
      if (metadata.kind !== 1 || rate !== this.sampleRate)
        return this._emitStatus({type:"protocol-error",
          message:`JS8 requires RX_ULAW at ${this.sampleRate} Hz`});
      const firstSample = Number(metadata.firstSample);
      if (!Number.isSafeInteger(firstSample))
        return this._emitStatus({type:"protocol-error",
          message:"AUD1 firstSample exceeds JavaScript safe integer range"});

      const observed = this._timebase.observePacket({
        streamId:metadata.streamId,
        sequence:metadata.sequence,
        firstSample,
        sampleCount:samples.length,
        discontinuity:Boolean(metadata.flags & 0x0004),
        arrivalWallMs:this.wallNow(),
        arrivalMonotonicMs:metadata.arrivalMs,
      });
      if (!observed.accepted) {
        this._emitStatus({type:"packet-dropped", duplicate:observed.duplicate,
          streamId:metadata.streamId, sequence:metadata.sequence});
        return;
      }

      const item = {samples, rate, metadata};
      const media = observed.state.media;
      if (media.status !== "locked") {
        this._pending.push(item);
        this._emitStatus({type:"anchoring", streamId:metadata.streamId,
          candidates:media.anchorCandidates, required:this.anchorPacketCount});
        return;
      }
      if (this._announcedEpoch !== media.epoch) {
        this._announcedEpoch = media.epoch;
        const epoch = {streamId:media.streamId, mediaEpoch:media.epoch,
          reason:media.reason, anchorUtcMs:media.anchorUtcSample0Ms};
        if (this._epochCallback) this._epochCallback(epoch);
        this._emitStatus({type:"epoch", ...epoch});
      }
      this._pending.push(item);
      const pending = this._pending;
      this._pending = [];
      for (const buffered of pending) this._deliver(buffered);
    }

    _deliver(item) {
      const snapshot = this._timebase.snapshot();
      const metadata = {...item.metadata,
        mediaEpoch:snapshot.media.epoch,
        anchorUtcMs:snapshot.media.anchorUtcSample0Ms,
        timebase:snapshot};
      if (this._packetCallback) this._packetCallback(metadata);
      if (this._samplesCallback)
        this._samplesCallback(item.samples, item.rate, metadata);
    }

    _emitStatus(status) {
      if (this._statusCallback) this._statusCallback(status);
    }
  }

  return {WsAudioSource};
});
