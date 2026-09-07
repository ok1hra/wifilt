// AFSK transmission over the AUD1 stream: Baudot -> PCM -> paced packets.
//
// Extracted from rtty.js 2026-09-07 so QRPlog's own RTTY palette
// (log-rtty-panel.js) transmits through the same code path. A duplicated TX
// implementation is the kind of bug that only shows up on the air.
//
// Own compact immediate-PTT pacing loop rather than Js8Tx.TxController:
// queue() DOES have an immediate/"tune" path, but it unconditionally requires
// a truthy MODES[request.mode] even there (dead weight, since planSlot() -- the
// only place `mode` matters for immediate sends -- is never called on that
// path), which would mean embedding a meaningless JS8 period number into every
// RTTY TX event. WsprTx has no immediate path at all (always a 120 s frame).
// Js8Tx.packetizeTxPcm48k() itself IS mode-agnostic and is reused verbatim.
//
// start() resolves once the stream is SET UP, not when the message finishes --
// that is deliberately the page's existing contract (the composer clears its
// textarea "once genuinely committed", long before the audio drains).
// Completion arrives separately through onFinish.
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RttyAfskTx = factory();
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const TX_AUDIO_RATE = 48000;
  // Immediate push-to-talk, not a periodic slot -- slotUtcMs = now + leadMs.
  const DEFAULTS = {
    sampleRate: TX_AUDIO_RATE,
    leadMs: 800, prebufferMs: 1000, streamLeadMs: 350,
    packetMs: 20, ringLimitMs: 1400, watchdogMarginMs: 2000,
    tickMs: 40,
  };

  // options:
  //   session()      the live Aud1WebSocketSession, or null
  //   settings()     live settings object (toneHz, txPolarity)
  //   gain()         {gain, calibrated} from the shared /txgain.json table
  //   onEcho(text)   called at the moment this commits to the send; whatever
  //                  it returns is handed back to onEchoFailed on failure
  //   onEchoFailed(handle)
  //   onFinish(error)  null on success, a message string on failure
  //   onTick()       progress changed -- repaint
  function create(options) {
    const cfg = Object.assign({}, DEFAULTS, options);
    const sessionOf = options.session;
    const settingsOf = options.settings;
    const gainOf = options.gain || (() => ({gain: 0, calibrated: false}));
    const onEcho = options.onEcho || (() => null);
    const onEchoFailed = options.onEchoFailed || (() => {});
    const onFinish = options.onFinish || (() => {});
    const onTick = options.onTick || (() => {});

    let audioTx = null;
    let nextTxId = 1;
    // True from the moment start() commits until audioTx is assigned (or the
    // attempt fails) -- closes the TOCTOU window the `if (audioTx) throw`
    // guard alone leaves open across the `await session.prepare(...)` below,
    // where a 2nd overlapping call could pass the guard before the 1st call's
    // audioTx was ever assigned.
    let starting = false;

    function reset() {
      if (audioTx && audioTx.ticker) clearInterval(audioTx.ticker);
      audioTx = null;
    }

    async function start(text) {
      const session = sessionOf();
      if (!session || !session.hello) throw new Error("AUD1 session is not ready yet");
      if (audioTx || starting) throw new Error("a transmission is already in progress");
      starting = true;
      try {
        const settings = settingsOf();
        // The shared /txgain.json table's resolved level for the radio's
        // CURRENT band+power, the same accessor data.js/wspr.js use for their
        // own TX amplitude.
        //
        // Only applied once calibrated is true: uncalibrated, gain is 0 (this
        // path has no manual gain slider like JS8/WSPR do), so passing it
        // through unconditionally would transmit SILENCE on a never-calibrated
        // band/power instead of preserving the encoder's own historical
        // default -- worse than doing nothing.
        const resolved = gainOf();
        // txPolarity is picked here, not read a 2nd time inside
        // rtty-codec.js -- one source of truth for "what does reverse mean
        // right now", same as RttyScope.markToneHz().
        const txReverse = settings.txPolarity === "reverse";
        const encoder = new RttyCodec.Encoder(cfg.sampleRate, resolved.calibrated
          ? {toneHz: settings.toneHz, amplitude: resolved.gain, reverse: txReverse}
          : {toneHz: settings.toneHz, reverse: txReverse});
        const pcm16 = encoder.encode(text);
        if (pcm16.length === 0) throw new Error("nothing to send (no supported characters)");

        const echo = onEcho(text);   // as this commits to the send, not after it finishes
        const myTxId = nextTxId++;
        const packets = Js8Tx.packetizeTxPcm48k(pcm16,
          {streamId: session.hello.streamId, txId: myTxId});
        const slotUtcMs = Date.now() + cfg.leadMs;
        const prebufferSamples = Math.round(cfg.prebufferMs * cfg.sampleRate / 1000);
        await session.prepare(myTxId, {mode: 0, toneHz: settings.toneHz,
          samples: pcm16.length, packets: packets.length, slotUtcMs,
          prebufferSamples, packetMs: cfg.packetMs});
        const streamSpanMs = Math.min(cfg.prebufferMs + cfg.streamLeadMs, cfg.ringLimitMs);
        audioTx = {txId: myTxId, packets, packetIndex: 0, echo,
          prebufferStartUtcMs: slotUtcMs - streamSpanMs,
          endUtcMs: slotUtcMs + pcm16.length / (cfg.sampleRate / 1000),
          begun: false, audioEnded: false};
        audioTx.watchdogUtcMs = audioTx.endUtcMs + cfg.watchdogMarginMs;
        audioTx.ticker = setInterval(tick, cfg.tickMs);
        onTick();
      } finally {
        starting = false;
      }
    }

    function tick() {
      if (!audioTx) return;
      const session = sessionOf();
      const now = Date.now();
      try {
        if (!session) throw new Error("AUD1 session closed");
        if (!audioTx.begun && now >= audioTx.prebufferStartUtcMs) {
          session.begin(audioTx.txId);
          audioTx.begun = true;
        }
        if (audioTx.begun) {
          const due = Math.min(audioTx.packets.length, Math.max(0,
            Math.floor((now - audioTx.prebufferStartUtcMs) / cfg.packetMs) + 1));
          while (audioTx.packetIndex < due) {
            session.write(audioTx.packets[audioTx.packetIndex]);
            audioTx.packetIndex++;
          }
          if (audioTx.packetIndex === audioTx.packets.length && !audioTx.audioEnded) {
            session.end(audioTx.txId);
            audioTx.audioEnded = true;
          }
        }
        if (audioTx.audioEnded && session.isDrained(audioTx.txId)) {
          session.complete(audioTx.txId);
          finish(null);
          return;
        }
        if (now > audioTx.watchdogUtcMs) throw new Error("TX drain watchdog");
      } catch (error) {
        const message = String(error.message || error);
        try { session && session.abort(audioTx.txId, message); } catch (_e) {}
        finish(message);
        return;
      }
      onTick();
    }

    function abort(reason) {
      if (!audioTx) return;
      const session = sessionOf();
      try { session && session.abort(audioTx.txId, reason); } catch (_e) {}
      finish(reason);
    }

    function finish(error) {
      const echo = audioTx ? audioTx.echo : null;
      reset();
      if (error) onEchoFailed(echo);
      onFinish(error || null);
      onTick();
    }

    // Matches the page's own txBusy(): the transient `starting` flag is an
    // internal re-entry guard, not something a caller should see as "busy".
    function busy() { return Boolean(audioTx); }

    // The stricter question, for anything that answers "can you take a send
    // right now?" on behalf of this station -- a probe answered during the
    // `await session.prepare()` window would otherwise promise a free
    // transmitter that is already committed.
    function busyOrStarting() { return Boolean(audioTx) || starting; }

    // Fraction of packets already written, for a progress readout. 0 before
    // the pacer begins, 1 once everything is queued.
    function progress() {
      if (!audioTx || !audioTx.packets.length) return 0;
      return audioTx.packetIndex / audioTx.packets.length;
    }

    return {start, abort, reset, busy, busyOrStarting, progress,
            txId: () => (audioTx ? audioTx.txId : 0)};
  }

  return {create, DEFAULTS};
}));
