// Message relay.
//
// This is the only module where the station transmits text somebody else wrote,
// so "it works" and "it is safe" are not the same thing here. Decision 9 chose
// the upstream open-relay model; the limits below are what make that defensible
// rather than an open microphone.
//
// Wire shape (upstream JS8Call):
//
//   KN4CRD sends:  KN4CRD: DR4CNK>OH8STN>HELLO JULIAN!
//   DR4CNK relays:  DR4CNK: OH8STN>HELLO JULIAN! DE KN4CRD
//   OH8STN gets it, delivers it, and ACKs.
//
// So a relay frame addressed to us carries the REMAINING path in its payload.
// If the payload still starts with "CALL>" we are an intermediate hop and pass
// it on, appending "DE <originator>" so the chain stays attributable. Otherwise
// we are the destination: deliver and acknowledge.
//
// Pure decision layer; it never transmits and every refusal carries a reason.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8Relay = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const DEFAULTS = {
    enabled: true,
    maxTextLength: 120,  // one relayed message; longer is almost always abuse
    maxHops: 3,          // upstream examples stop at three; deeper paths are a
                         // good way to turn the network into an amplifier
    maxPerHour: 12,      // how much of our airtime strangers may spend
  };

  // A packable base callsign, optionally with a /P style suffix. Deliberately
  // strict: anything we cannot pack we must not promise to forward.
  const CALL_RE = /^[A-Z0-9]{2,6}(?:\/[A-Z0-9]{1,2})?$/;
  const isCallsign = value => CALL_RE.test(String(value || "").toUpperCase().trim());

  // A hop may arrive separated by a SPACE rather than ">", which is what JS8Call
  // actually puts on the air: its relay regex accepts `[> ]` and only rewrites
  // the separator to ">" when it forwards. Reading ">" alone made us the end of a
  // chain we were meant to pass on.
  //
  // The space form must be read more strictly than the ">" one. After ">" the
  // protocol says the token IS a callsign; after a space it is merely the first
  // word, and `isCallsign` alone would promote it -- "MSG TEST ..." would hop to
  // the station "MSG". Requiring the shape of a real callsign (a digit between
  // letters) is what upstream's regex does too. A relayed text that genuinely
  // starts with a callsign is still ambiguous, exactly as it is upstream; the
  // arming, hop and hourly limits below are what keep that harmless.
  const STRICT_CALL_RE =
    /^(?:[A-Z0-9]{1,4}\/)?[A-Z0-9]{1,2}[0-9][A-Z]{1,3}(?:\/[A-Z0-9]{1,2})?$/;

  /**
   * Splits a relay payload into the next hop and the rest.
   * "OH8STN>HELLO" -> {nextHop:"OH8STN", rest:"HELLO"}
   * "OH8STN HELLO" -> {nextHop:"OH8STN", rest:"HELLO"}
   * "HELLO DE X"   -> {nextHop:null, rest:"HELLO DE X"}
   */
  function splitHop(payload) {
    const text = String(payload || "").trim();
    const index = text.indexOf(">");
    if (index > 0) {
      const candidate = text.slice(0, index).toUpperCase().trim();
      if (isCallsign(candidate))
        return {nextHop: candidate, rest: text.slice(index + 1).trim()};
    }
    const space = text.indexOf(" ");
    if (space > 0) {
      const candidate = text.slice(0, space).toUpperCase();
      if (isCallsign(candidate) && STRICT_CALL_RE.test(candidate))
        return {nextHop: candidate, rest: text.slice(space + 1).trim()};
    }
    return {nextHop: null, rest: text};
  }

  // How many hops are still ahead, used for the depth limit.
  function remainingHops(payload) {
    let count = 0, rest = payload;
    for (;;) {
      const split = splitHop(rest);
      if (!split.nextHop) return count;
      count += 1;
      rest = split.rest;
      if (count > 16) return count; // pathological input, caller will refuse
    }
  }

  class Js8Relay {
    constructor(options = {}) {
      this.config = {...DEFAULTS, ...options};
      this.onEvent = options.onEvent || null;
      this.forwardTimes = [];
      this.stats = {forwarded: 0, delivered: 0, refused: 0};
      this.log = [];  // what we put on the air on somebody else's behalf
    }

    _emit(event) { if (this.onEvent) this.onEvent(event); }

    _refuse(reason, detail) {
      this.stats.refused += 1;
      this._emit({type: "refused", reason, detail});
      return {action: "skip", reason, detail};
    }

    _hourlyCount(nowMs) {
      const cutoff = nowMs - 3600000;
      while (this.forwardTimes.length && this.forwardTimes[0] < cutoff)
        this.forwardTimes.shift();
      return this.forwardTimes.length;
    }

    /**
     * @param frame {from, to, text, complete}
     * @param ctx   {nowMs, myCall, armed}
     */
    handle(frame, ctx) {
      const from = String(frame && frame.from || "").toUpperCase().trim();
      const to = String(frame && frame.to || "").toUpperCase().trim();
      const myCall = String(ctx && ctx.myCall || "").toUpperCase().trim();
      const payload = String(frame && frame.text || "").trim();
      const nowMs = ctx.nowMs;

      if (!this.config.enabled) return this._refuse("disabled", "relay is switched off");
      if (!from || !myCall) return this._refuse("invalid", "missing callsign");
      if (to !== myCall) return this._refuse("not-addressed", `relay for ${to || "nobody"}`);
      // A checksummed command must be whole before we act on it: forwarding half
      // a message would put corrupted text on the air under our callsign.
      if (frame.complete === false)
        return this._refuse("incomplete", "relay still arriving");
      if (!payload) return this._refuse("empty", "no payload to relay");
      if (payload.length > this.config.maxTextLength)
        return this._refuse("too-long",
          `${payload.length} characters, limit ${this.config.maxTextLength}`);

      const {nextHop, rest} = splitHop(payload);

      // Final destination: nothing left to forward. A relay ACK terminates
      // here; acknowledging an ACK would create a loop. For an ordinary
      // delivery, route the ACK back through the immediate sender and any
      // original callsign carried by the trailing DE/VIA attribution.
      if (!nextHop) {
        this.stats.delivered += 1;
        this._emit({type: "delivered", from, text: rest});
        if (/^ACK(?:\s|$)/i.test(rest))
          return {action: "deliver", from, text: rest, ack: null};
        const originMatch =
          /(?:^|\s)(?:\*DE\*|DE|VIA)\s+([A-Z0-9/]+)\s*$/i.exec(rest);
        const origin = originMatch ? originMatch[1].toUpperCase() : "";
        const ackText = origin && origin !== from ? `>${origin}>ACK` : "ACK";
        return {action: "deliver", from, text: rest,
          ack: {to: from, text: ackText}};
      }

      // From here on we would put someone else's words on the air.
      if (!ctx.armed)
        return this._refuse("not-armed", "relaying requires unattended mode");
      if (nextHop === myCall)
        return this._refuse("loop", "next hop is our own callsign");
      if (rest.toUpperCase().split(/[\s>]+/).includes(myCall))
        return this._refuse("loop", "our callsign appears later in the path");
      if (!rest) return this._refuse("empty", "nothing left after the hop");
      const hops = remainingHops(payload);
      if (hops > this.config.maxHops)
        return this._refuse("too-deep", `${hops} hops, limit ${this.config.maxHops}`);
      if (this._hourlyCount(nowMs) >= this.config.maxPerHour)
        return this._refuse("hourly-cap",
          `${this.config.maxPerHour} relays in the last hour`);

      // Append the originator so every hop stays attributable. If the chain
      // already carries an attribution we leave it alone -- it names the true
      // origin. The marker must be "*DE*", asterisks included: that is what
      // JS8Call itself writes when forwarding, and the ONLY forms its
      // parseRelayPathCallsigns reads are *DE* and VIA. A bare "DE" was
      // invisible to it -- the recipient built the return path from the
      // immediate hop alone, so the ACK died at the intermediary and the
      // originator was never credited in the recipient's inbox.
      const body = /(?:\*DE\*|DE|VIA)\s+[A-Z0-9/]+\s*$/i.test(rest)
        ? rest : `${rest} *DE* ${from}`;
      // Keep the relay command on every hop. Without the leading ">", the TX
      // encoder emits ordinary directed free text and the next station never
      // invokes its relay handler.
      const text = `>${body}`;
      if (text.length > this.config.maxTextLength)
        return this._refuse("too-long",
          `${text.length} characters after attribution, limit ${this.config.maxTextLength}`);

      this.forwardTimes.push(nowMs);
      this.stats.forwarded += 1;
      const entry = {atMs: nowMs, from, to: nextHop, text};
      this.log.push(entry);
      if (this.log.length > 50) this.log.shift();
      this._emit({type: "forward", ...entry});
      return {action: "forward", to: nextHop, text, origin: from};
    }

    snapshot(nowMs) {
      return {...this.stats, enabled: this.config.enabled,
        hourly: this._hourlyCount(nowMs), hourlyCap: this.config.maxPerHour,
        recent: this.log.slice(-10)};
    }
  }

  return {Js8Relay, DEFAULTS, splitHop, remainingHops, isCallsign};
});
