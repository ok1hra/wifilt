// JS8Call adapter for the DATA-page modem contracts. Registration stays in
// data.js so loading this GPL-derived asset remains explicit and lazy.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.createJs8ModemAdapter = value.createJs8ModemAdapter;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  function createJs8ModemAdapter(environment) {
    const {DecoderBase, EncoderBase, createWorker, createTxController} = environment;
    if (!DecoderBase || !EncoderBase || !createWorker || !createTxController)
      throw new Error("JS8 adapter requires base classes and injected runtimes");

    class Js8CallDecoder extends DecoderBase {
      constructor(sampleRate) {
        super(sampleRate);
        this._onEvent = null;
        this._status = "loading";
        this._epochKey = null;
        this._messageCount = 0;
        this._frameCount = 0;
        this._activityKey = "";
        this._failure = null;
        this._telemetry = null;
        this._worker = createWorker();
        this._worker.onmessage = event => this._receive(event.data);
        // A worker whose script never arrives -- a 404, a dropped connection on a
        // web server that serves one request at a time, a corrupt cache entry --
        // reports through `error` and through nothing else: no message is ever
        // posted, so a page waiting for the first progress report waits for ever.
        // Without this the JS8 page sat on "Loading JS8Call-ICOM modem 0%" with
        // the RETRY button hidden, because nothing had declared a failure.
        this._worker.onerror = event => {
          if (event && event.preventDefault) event.preventDefault();
          const where = event && event.filename
            ? ` (${event.filename}:${event.lineno || 0})` : "";
          this._fail(`${(event && event.message) || "modem worker script could not be loaded"}${where}`);
        };
        this._worker.onmessageerror = () => this._fail("modem worker sent an undecodable message");
        this._worker.postMessage({type: "init", ...(environment.workerInit || {})});
      }

      // onEvent() is chained on after the constructor, so a failure raised while
      // the worker was starting has nobody to tell yet. Hold it and hand it over.
      onEvent(callback) {
        this._onEvent = callback;
        if (this._failure) { const message = this._failure; this._failure = null; callback({type:"error", message}); }
        return this;
      }

      _fail(message) {
        this._status = "error";
        if (this._onEvent) this._onEvent({type:"error", message});
        else this._failure = message;
      }

      beginEpoch(epoch) {
        if (!epoch || !Number.isInteger(Number(epoch.streamId)) ||
            !Number.isFinite(Number(epoch.anchorUtcMs)))
          throw new Error("JS8 decoder requires a locked media epoch");
        const mediaEpoch = Number(epoch.mediaEpoch || 0);
        this._epochKey = `${epoch.streamId}|${mediaEpoch}`;
        this._frameCount = 0;
        this._worker.postMessage({type:"epoch", streamId:Number(epoch.streamId),
          anchorUtcMs:Number(epoch.anchorUtcMs)});
      }

      // Current DATA page must call this overload with the untouched AUD1 wire.
      pushAud1(wire, arrivalMs = performance.now()) {
        if (!wire) throw new Error("JS8 decoder requires an AUD1 packet");
        this._worker.postMessage({type: "audio", wire, arrivalMs});
      }

      pushSamples(_samples, metadata) {
        if (!metadata || !metadata.aud1Wire ||
            !Number.isInteger(Number(metadata.streamId)) ||
            !Number.isFinite(Number(metadata.anchorUtcMs)))
          throw new Error("JS8 timing requires AUD1 sequence/firstSample metadata");
        const key = `${metadata.streamId}|${Number(metadata.mediaEpoch || 0)}`;
        if (this._epochKey !== key) this.beginEpoch(metadata);
        this.pushAud1(metadata.aud1Wire, metadata.arrivalMs);
      }

      reset(reason = "operator") {
        this._epochKey = null;
        this._messageCount = 0;
        this._frameCount = 0;
        this._worker.postMessage({type: "reset", reason});
      }
      close() { this._worker.postMessage({type: "close"}); this._worker.terminate(); }
      // Ages out partial receptions when audio has stopped and no decode window is being
      // produced. An older cached worker ignores the unknown type and keeps the
      // audio-driven expiry, so this degrades instead of breaking.
      //
      // The page ticks this once a second from the moment the decoder object
      // exists, which is some seconds before the worker has a runtime. There is
      // nothing to age out that early and nothing to gain from queueing ticks
      // behind a download, so the caller's clock is simply ignored until ready.
      expire(nowMs) {
        if (this._status !== "ready") return;
        this._worker.postMessage({type: "expire", nowMs});
      }

      // Pulled by the page when it repaints the diagnostics panel, never pushed:
      // a state message arrives with every audio packet, and an event per packet
      // would cost a render per packet to show numbers nobody is looking at while
      // the panel is closed. Only the counters are kept -- holding the whole state
      // would pin its frame array for as long as the newest message lives.
      telemetry() { return this._telemetry; }

      _receive(message) {
        if (message.state)
          this._telemetry = {audio: message.state.audio, decode: message.state.decode,
            windows: message.state.windows, windowsByMode: message.state.windowsByMode,
            epoch: message.state.epoch};
        if (message.type === "loading" && this._onEvent)
          this._onEvent({type:"loading", stage:message.stage,
            label:message.label, progress:message.progress,
            loaded:message.loaded, total:message.total});
        if (message.type === "ready") {
          this._status = "ready";
          if (this._onEvent) this._onEvent({type:"status", status:"ready"});
        }
        if (message.type === "error") {
          this._status = "error";
          if (this._onEvent) this._onEvent({type:"error", message:message.message});
        }
        if (message.state && message.state.activity) {
          const activity = message.state.activity;
          const frames = message.state.frames || activity.frames || [];
          const tail = frames.length ? frames[frames.length - 1] : null;
          const activityKey = `${frames.length}|${activity.messages ? activity.messages.length : 0}|` +
            `${activity.calls ? activity.calls.length : 0}|${tail ? `${tail.slotUtcMs}|${tail.raw}` : ""}`;
          if (activityKey !== this._activityKey && this._onEvent) {
            this._activityKey = activityKey;
            this._onEvent({type: "activity", activity});
          }
          if (this._onEvent && message.state.frames) {
            for (const frame of message.state.frames.slice(this._frameCount))
              this._onEvent({type:"frame", frame});
            this._frameCount = message.state.frames.length;
          }
          if (this._emit && activity.messages) {
            for (const item of activity.messages.slice(this._messageCount))
              this._emit(`${item.text}\n`);
            this._messageCount = activity.messages.length;
          }
        }
      }
    }

    class Js8CallEncoder extends EncoderBase {
      constructor(sampleRate) {
        super(sampleRate);
        this._onStatus = null;
        this._onEvent = null;
        this._controller = createTxController({sampleRate});
        this._context = {myCall: "", toCall: "", mode: 0};
      }

      configure(context) {
        this._context = {...this._context, ...context};
        if (Object.prototype.hasOwnProperty.call(context || {}, "clockCorrectionMs"))
          this._controller.clockCorrectionMs = Number(context.clockCorrectionMs) || 0;
        if (environment.getStreamId) {
          const streamId = Number(environment.getStreamId());
          if (Number.isInteger(streamId) && streamId > 0) this._controller.streamId = streamId;
        }
        return this;
      }
      onStatus(callback) { this._onStatus = callback; return this; }
      onEvent(callback) { this._onEvent = callback; return this; }

      encode(text, options = {}) {
        const request = {...this._context, ...options, text,
          toneHz:Number.isFinite(Number(options.toneHz)) ? Number(options.toneHz) : this.toneHz};
        const state = this._controller.queue(request);
        this._notify(state);
        return this._controller.prepare();
      }

      tick(nowUtcMs = this._controller.wallNow()) {
        const state = this._controller.tick(nowUtcMs);
        this._notify(state);
        return state;
      }

      abort() { const state = this._controller.abort("operator"); this._notify(state); }
      disconnect() { const state = this._controller.disconnect(); this._notify(state); }
      _notify(state) {
        if (this._onStatus) this._onStatus(state);
        if (this._onEvent) this._onEvent({type:"tx", state});
      }
    }

    return {
      id: "js8call",
      definition: {
        label: "JS8Call-ICOM",
        Decoder: Js8CallDecoder,
        Encoder: Js8CallEncoder,
        minTone: 500,
        maxTone: 2700,
        requiresAud1Metadata: true,
        requiresAsyncTxSink: true,
      },
      Decoder: Js8CallDecoder,
      Encoder: Js8CallEncoder,
    };
  }

  return {createJs8ModemAdapter};
});
