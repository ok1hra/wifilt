// JTTY transmission over the AUD1 stream: frames -> 4-GFSK PCM -> paced
// packets. Shared by the JTTY page and QRPlog's JTTY palette, like
// rtty-afsk-tx.js is for RTTY, so there is one TX path to get right.
//
// Two shapes of one mechanism:
//   send(packed)        a whole message, as RTTY sends one (the palette, macros);
//   startLive(next)     live entry (jtty.html only, docs/jtty-implementace.md §6):
//                       the transmission is open-ended, and next() is asked for
//                       the following segment shortly before the audio already
//                       declared runs out -- typed text, null for a filler frame,
//                       {stop:true} to let it end.
// The firmware learns about each added segment through tx.extend; a one-shot
// message is simply a transmission that never extends.
//
// Packets are cut from one continuous sample stream, 960 at a time, and only
// the very last may be short: a JTTY frame (90624 samples at 48 kHz) is not a
// whole number of 20 ms packets, and a short packet mid-stream would let the
// 20 ms pacing fall behind real time by 12 ms a frame. While the stream is
// still open the last declared packet is never sent -- the firmware takes a
// packet that reaches the declared count without the LAST flag as a failure.
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JttyTx = factory();
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const RATE = 48000, PACKET = 960;
  const DEFAULTS = {
    leadMs: 800, prebufferMs: 1000, streamLeadMs: 350,
    packetMs: 20, ringLimitMs: 1400, watchdogMarginMs: 3000,
    tickMs: 20,
    // How much declared-but-unsent audio is left when next() is asked again:
    // with ~1.35 s already in the radio's ring, text typed up to about two
    // seconds before the air runs dry still makes the next frame.
    lookaheadMs: 800,
  };

  const codec = () => (typeof JttyCodec !== "undefined" ? JttyCodec : (typeof require === "function" ? require("./jtty-codec.js") : null));
  const modem = () => (typeof JttyModem !== "undefined" ? JttyModem : (typeof require === "function" ? require("./jtty-modem.js") : null));

  function packetWire(samples, offset, count, {streamId, txId, sequence, first, last}) {
    const wire = new Uint8Array(40 + count * 2);
    const view = new DataView(wire.buffer);
    wire.set([0x41, 0x55, 0x44, 0x31], 0);
    wire[4] = 1; wire[5] = 3;
    view.setUint16(6, (first ? 1 : 0) | (last ? 2 : 0), false);
    view.setUint16(8, 40, false);
    view.setUint32(12, streamId >>> 0, false);
    view.setUint32(16, sequence >>> 0, false);
    view.setUint32(20, RATE, false);
    view.setBigUint64(24, BigInt(offset), false);
    view.setUint32(32, txId >>> 0, false);
    view.setUint32(36, count * 2, false);
    for (let i = 0; i < count; i++) view.setInt16(40 + i * 2, samples[i], true);
    return wire;
  }

  // options:
  //   session()          the live Aud1WebSocketSession, or null
  //   txHz()             audio frequency of the lowest tone
  //   gain()             {gain, calibrated} from the shared /txgain.json table
  //   onSegment(seg)     a segment committed to the air: {text, frames, filler};
  //                      whatever it returns is handed to onSegmentFailed
  //   onSegmentFailed(handle)
  //   onFinish(error)    null on success, a message on failure
  //   onTick()           progress changed -- repaint
  function create(options) {
    const cfg = Object.assign({}, DEFAULTS, options);
    const sessionOf = options.session;
    const txHzOf = options.txHz || (() => 1500);
    const gainOf = options.gain || (() => ({gain: 0, calibrated: false}));
    const onSegment = options.onSegment || (() => null);
    const onSegmentFailed = options.onSegmentFailed || (() => {});
    const onFinish = options.onFinish || (() => {});
    const onTick = options.onTick || (() => {});

    let tx = null;
    let nextTxId = 1;
    let starting = false;

    function pcmFor(frames) {
      const resolved = gainOf();
      return modem().synthesize(modem().messageTones(frames), {sampleRate: RATE, f0: txHzOf(),
        amplitude: resolved.calibrated ? resolved.gain : 0.5});
    }

    function fillerFrames() {
      return codec().packText(codec().FILLER_TEXT, {isFinal: false}).frames;
    }

    function reset() {
      if (tx && tx.ticker) clearInterval(tx.ticker);
      tx = null;
    }

    const packetsFor = samples => Math.ceil(samples / PACKET);

    async function begin(first, live) {
      const session = sessionOf();
      if (!session || !session.hello) throw new Error("AUD1 session is not ready yet");
      if (tx || starting) throw new Error("a transmission is already in progress");
      starting = true;
      try {
        const pcm = pcmFor(first.frames);
        const handle = onSegment(first);
        const myTxId = nextTxId++;
        const slotUtcMs = Date.now() + cfg.leadMs;
        const prebufferSamples = Math.round(cfg.prebufferMs * RATE / 1000);
        await session.prepare(myTxId, {mode: 0, toneHz: txHzOf(), samples: pcm.length,
          packets: packetsFor(pcm.length), slotUtcMs, prebufferSamples, packetMs: cfg.packetMs,
          jttyText: first.filler ? "" : first.text});
        const streamSpanMs = Math.min(cfg.prebufferMs + cfg.streamLeadMs, cfg.ringLimitMs);
        tx = {txId: myTxId, live: Boolean(live), next: live || null,
          queue: [pcm], queueOffset: 0, queued: pcm.length,
          declared: pcm.length, sent: 0, sequence: 0,
          final: !live || Boolean(first.final), handles: [handle],
          slotUtcMs, prebufferStartUtcMs: slotUtcMs - streamSpanMs,
          begun: false, audioEnded: false, error: null};
        tx.ticker = setInterval(tick, cfg.tickMs);
        onTick();
      } finally {
        starting = false;
      }
    }

    // A whole message: {frames, text} from JttyCodec.packText()/compileMacro().
    function send(packed) {
      if (!packed || !packed.frames || !packed.frames.length) return Promise.reject(new Error("nothing to send"));
      return begin({frames: packed.frames, text: packed.text, final: true, filler: false}, null);
    }

    // Live entry. first: the opening segment ({frames, text, final}) or null
    // for a filler opener; next(): see the header.
    function startLive(first, next) {
      const opener = first || {frames: fillerFrames(), text: codec().FILLER_TEXT, final: false, filler: true};
      return begin(opener, next);
    }

    function extend(session) {
      let seg = tx.next ? tx.next() : {stop: true};
      if (seg && seg.stop) { tx.final = true; return; }
      if (!seg) seg = {frames: fillerFrames(), text: codec().FILLER_TEXT, final: false, filler: true};
      const pcm = pcmFor(seg.frames);
      const before = packetsFor(tx.declared);
      tx.declared += pcm.length;
      session.sendControl({type: "tx.extend", txId: tx.txId, samples: pcm.length,
        packets: packetsFor(tx.declared) - before, jttyText: seg.filler ? "" : seg.text});
      tx.queue.push(pcm);
      tx.queued += pcm.length;
      tx.handles.push(onSegment(seg));
      if (seg.final) tx.final = true;
    }

    // The next count samples out of the queue, as one Int16Array.
    function take(count) {
      const out = new Int16Array(count);
      let filled = 0;
      while (filled < count) {
        const head = tx.queue[0];
        const n = Math.min(count - filled, head.length - tx.queueOffset);
        out.set(head.subarray(tx.queueOffset, tx.queueOffset + n), filled);
        filled += n;
        tx.queueOffset += n;
        if (tx.queueOffset === head.length) { tx.queue.shift(); tx.queueOffset = 0; }
      }
      tx.queued -= count;
      return out;
    }

    function tick() {
      if (!tx) return;
      const session = sessionOf();
      const now = Date.now();
      try {
        if (!session) throw new Error("AUD1 session closed");
        if (!tx.final && tx.declared - tx.sent < cfg.lookaheadMs * RATE / 1000) extend(session);
        if (!tx.begun && now >= tx.prebufferStartUtcMs) {
          session.begin(tx.txId);
          tx.begun = true;
        }
        if (tx.begun && !tx.audioEnded) {
          const allowed = (Math.floor((now - tx.prebufferStartUtcMs) / cfg.packetMs) + 1) * PACKET;
          while (tx.sent < allowed && tx.queued > 0) {
            const count = Math.min(PACKET, tx.queued);
            const last = tx.final && tx.sent + count === tx.declared;
            // Open stream: never a short packet, never the declared-last one.
            if (!last && (count < PACKET || packetsFor(tx.sent) + 1 >= packetsFor(tx.declared))) break;
            const samples = take(count);
            session.write(packetWire(samples, tx.sent, count, {streamId: session.hello.streamId,
              txId: tx.txId, sequence: tx.sequence, first: tx.sequence === 0, last}));
            tx.sequence++;
            tx.sent += count;
            if (last) {
              session.end(tx.txId);
              tx.audioEnded = true;
              break;
            }
          }
        }
        if (tx.audioEnded && session.isDrained(tx.txId)) {
          session.complete(tx.txId);
          finish(null);
          return;
        }
        if (now > tx.slotUtcMs + tx.declared / (RATE / 1000) + cfg.watchdogMarginMs)
          throw new Error("TX drain watchdog");
      } catch (error) {
        const message = String(error.message || error);
        try { session && session.abort(tx.txId, message); } catch (_e) {}
        finish(message);
        return;
      }
      onTick();
    }

    function abort(reason) {
      if (!tx) return;
      const session = sessionOf();
      try { session && session.abort(tx.txId, reason); } catch (_e) {}
      finish(reason);
    }

    // Live entry: no more segments after the current ones -- PTT drops once
    // they have played. final(seg) sends one last segment first (EOM on it).
    function finalize(seg) {
      if (!tx || tx.final) return;
      if (seg && seg.frames && seg.frames.length) {
        const keep = tx.next;
        tx.next = () => { tx.next = keep; return Object.assign({}, seg, {final: true}); };
        const session = sessionOf();
        if (session) extend(session);
      }
      tx.final = true;
    }

    function finish(error) {
      const handles = tx ? tx.handles : [];
      reset();
      if (error) handles.forEach(h => onSegmentFailed(h));
      onFinish(error || null);
      onTick();
    }

    const busy = () => Boolean(tx);
    const busyOrStarting = () => Boolean(tx) || starting;
    const live = () => Boolean(tx && tx.live && !tx.final);
    function progress() {
      if (!tx || !tx.declared) return 0;
      return tx.sent / tx.declared;
    }
    // Seconds of audio already declared and not yet on the air.
    function remainingS() {
      if (!tx) return 0;
      return Math.max(0, (tx.slotUtcMs + tx.declared / (RATE / 1000) - Date.now()) / 1000);
    }

    return {send, startLive, finalize, abort, reset, busy, busyOrStarting, live, progress, remainingS,
            txId: () => (tx ? tx.txId : 0)};
  }

  return {create, DEFAULTS, PACKET};
}));
