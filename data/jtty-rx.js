// JTTY receiver on the page side: runs JttyModem.Receiver in its own Web
// Worker (jtty-modem.js is both the library and the worker script, like
// wspr-decoder.js) and hands back message updates. Falls back to running in
// the page when a Worker cannot be made -- slower, same results.
//
// The AUD1 stream arrives in 20 ms pieces; they are batched to BATCH_MS so the
// worker sees a few messages a second, not fifty. During this station's own
// TX the caller sends gap() instead of audio, which keeps the receiver's clock
// running without decoding the transmitter's own signal.
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JttyRx = factory();
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const BATCH_MS = 200;

  // options: modemUrl, codecUrl, config, onUpdates(updates, stats), onError(message)
  function create(options) {
    const onUpdates = options.onUpdates || (() => {});
    const onError = options.onError || (() => {});
    let worker = null, inline = null;
    let pending = [], pendingLength = 0, gapPending = 0, timer = null;

    try {
      worker = new Worker(options.modemUrl);
      worker.onmessage = event => {
        const m = event.data || {};
        if (m.type === "updates") onUpdates(m.updates || [], m.stats || null, m.ms);
        else if (m.type === "error") onError(m.message);
      };
      worker.onerror = event => onError(String(event.message || "JTTY worker failed"));
      worker.postMessage({type: "init", codecUrl: options.codecUrl, options: options.config || {}});
    } catch (_error) {
      worker = null;
      inline = new JttyModem.Receiver(options.config || {});
    }

    function flush() {
      timer = null;
      if (gapPending) {
        const count = gapPending;
        gapPending = 0;
        if (worker) worker.postMessage({type: "gap", count});
        else deliver(inline.gap(count));
      }
      if (!pendingLength) return;
      const samples = new Float32Array(pendingLength);
      let at = 0;
      for (const p of pending) { samples.set(p, at); at += p.length; }
      pending = []; pendingLength = 0;
      if (worker) worker.postMessage({type: "samples", samples, wantStats: true}, [samples.buffer]);
      else deliver(inline.push(samples));
    }

    function deliver(updates) {
      if (updates.length) onUpdates(updates, inline.stats());
    }

    function schedule() { if (!timer) timer = setTimeout(flush, BATCH_MS); }

    function push(samples) {
      if (gapPending) flush();
      pending.push(Float32Array.from(samples));
      pendingLength += samples.length;
      schedule();
    }

    function gap(count) {
      if (pendingLength) flush();
      gapPending += count;
      schedule();
    }

    function configure(config) {
      if (worker) worker.postMessage({type: "config", options: config});
      else inline.configure(config);
    }

    function reset() {
      pending = []; pendingLength = 0; gapPending = 0;
      if (worker) worker.postMessage({type: "reset"});
      else inline.reset();
    }

    function stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (worker) worker.terminate();
      worker = null;
    }

    return {push, gap, configure, reset, stop, inWorker: () => Boolean(worker)};
  }

  // Decoded JTTY to the firmware, for the TrxNet stream (/jtty-rx, docs/
  // jtty-implementace.md §8): one control frame per message update, carrying
  // only what the message gained since the last one sent -- a frame or two of
  // text, a few times a second at most.
  function createStreamFeed(options) {
    const sessionOf = options.session;
    const sent = new Map();   // message id -> characters already published
    function push(updates) {
      const session = sessionOf();
      if (!session || !session.hello) return;
      for (const u of updates) {
        const before = sent.get(u.id) || 0;
        const delta = u.text.length > before ? u.text.slice(before) : "";
        if (!delta && !u.complete) continue;
        sent.set(u.id, u.text.length);
        if (u.complete || u.status === "expired") sent.delete(u.id);
        try {
          session.sendControl({type: "jtty.stream", id: u.id & 0xFF, hz: Math.round(u.audioHz),
            snr: u.snr, eom: u.complete ? 1 : 0, text: delta.slice(0, 57)});
        } catch (_error) { /* socket closing */ }
      }
      while (sent.size > 64) sent.delete(sent.keys().next().value);
    }
    return {push, stop: () => sent.clear()};
  }

  return {create, createStreamFeed, BATCH_MS};
}));
