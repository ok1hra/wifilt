// Decoded RTTY text to the firmware, for the TrxNet stream (rtty_stream.h,
// grilled 2026-09-25). Shared by the RTTY-ICOM page and QRPlog's palette:
// whichever holds the AUD1 session decodes, and that one feeds.
//
// Over the AUD1 socket already open, as a text control frame -- no extra HTTP
// request, no extra connection. Batched to one frame per FLUSH_MS at most, and
// only when something was decoded: at 45 Bd that is about three characters per
// decoder per frame, beside the ~50 audio frames a second the socket carries.
//
// It sends whether or not the stream is switched on or anybody listens. The
// firmware decides both and drops what nobody wants; the page never has to know,
// so a switch flipped on another computer takes effect here at once.
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RttyStreamFeed = factory();
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const FLUSH_MS = 500;
  // Far above anything two decoders produce in FLUSH_MS; a stalled socket must
  // not grow this without bound.
  const MAX_PENDING = 256;

  // options.session() -- the live Aud1WebSocketSession, or null
  function create(options) {
    const sessionOf = options.session;
    const pending = {r1: "", r2: ""};
    let timer = null;

    function flush() {
      timer = null;
      if (!pending.r1 && !pending.r2) return;
      const session = sessionOf();
      const frame = {type: "rtty.stream", r1: pending.r1, r2: pending.r2};
      pending.r1 = pending.r2 = "";
      if (!session || !session.hello) return;
      try { session.sendControl(frame); } catch (_error) { /* socket closing */ }
    }

    // stream: 1 or 2 (DEC 1 / DEC 2); ch: what the decoder handed the tape.
    function push(stream, ch) {
      const key = stream === 2 ? "r2" : "r1";
      if (typeof ch !== "string" || !ch) return;
      if (pending[key].length < MAX_PENDING) pending[key] += ch;
      if (!timer) timer = setTimeout(flush, FLUSH_MS);
    }

    function stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.r1 = pending.r2 = "";
    }

    return {push, flush, stop};
  }

  return {create, FLUSH_MS};
}));
