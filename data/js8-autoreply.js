// Directed auto-reply engine: decides what (if anything) to answer.
//
// Pure decision layer. It never transmits and never touches the DOM -- it takes
// a decoded frame plus station state and returns either a reply to queue or an
// explained refusal. That keeps every rule testable without a radio, and keeps
// decision 13 honest: nothing is ever dropped without a reason a caller can log.
//
// Scope is group B of docs/js8call-komunikacni-funkce.md: the queries whose
// answer is a single frame built from state we already hold.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8AutoReply = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  // Command -> how the answer is built. `needs` names the piece of station state
  // that must be configured, so a missing INFO text refuses with a reason the
  // operator can act on instead of transmitting an empty frame.
  // `windowAs` groups commands whose ANSWER is identical into ONE restriction
  // window. A bare "?", "SNR?" and "HW CPY?" all ask for the same signal report,
  // so answering two of them in a row is transmitting the same frame twice --
  // which is precisely what the window exists to refuse. Without this, adding
  // HW CPY? handed every station a second free transmission.
  const HANDLERS = {
    "SNR?":     {reply: (ctx, frame) => `SNR ${formatSnr(frame.snr)}`, needs: null},
    "?":        {reply: (ctx, frame) => `SNR ${formatSnr(frame.snr)}`, needs: null,
                 windowAs: "SNR?"},
    // "How do you copy me?" is the SNR question asked in words -- it is the
    // default reply JS8Call offers to a CQ, so it is the FIRST thing most
    // stations send at an unattended one, and leaving it unanswered made this
    // station look deaf at exactly the moment it was being tested. The answer is
    // the same signal report, from the same measurement, so it cannot disagree
    // with what an SNR? a minute later would say.
    "HW CPY?":  {reply: (ctx, frame) => `SNR ${formatSnr(frame.snr)}`, needs: null,
                 windowAs: "SNR?"},
    "GRID?":    {reply: ctx => `GRID ${ctx.grid}`,     needs: "grid"},
    "INFO?":    {reply: ctx => `INFO ${ctx.infoText}`, needs: "infoText"},
    "STATUS?":  {reply: ctx => `STATUS ${ctx.statusText}`, needs: "statusText"},
    "HEARING?": {reply: ctx => `HEARING ${ctx.hearing.join(" ")}`, needs: "hearing"},
    "AGN?":     {reply: null, needs: "lastMessage"}, // resend, handled below
  };

  const QSO_LOCK_MS = 60000;      // upstream: no auto replies while a directed
                                  // message is still arriving, or for a minute
                                  // after its last frame
  const HEARING_MAX = 4;          // keep the answer inside one frame

  function formatSnr(snr) {
    const value = Math.round(Number(snr));
    if (!Number.isFinite(value)) return "+00";
    // Directed commands carry the value in six bits as -30..+31. Formatting a
    // wider value here would make the decision log disagree with what the
    // encoder actually puts on the air.
    const clamped = Math.max(-30, Math.min(31, value));
    return `${clamped < 0 ? "-" : "+"}${String(Math.abs(clamped)).padStart(2, "0")}`;
  }

  function normalizeCall(value) {
    return String(value || "").toUpperCase().trim();
  }

  class Js8AutoReply {
    constructor({restrictions = null, onEvent = null} = {}) {
      this.restrictions = restrictions;
      this.onEvent = onEvent;
      this.lastDirectedFrameMs = 0;   // drives the QSO lock
      this.lastSentByCall = new Map(); // for AGN? from a station we wrote to
      this.lastTransmission = null;    // {to, text} -- for AGN? from anybody else
      this.stats = {replied: 0, skipped: 0};
    }

    _emit(event) { if (this.onEvent) this.onEvent(event); }

    _skip(reason, detail, extra = {}) {
      this.stats.skipped += 1;
      const result = {action: "skip", reason, detail, ...extra};
      this._emit({type: "skip", reason, detail, ...extra});
      return result;
    }

    // Remember what we last sent so AGN? can repeat it. Two records on purpose:
    // per-station for the QSO case (repeat what I wrote to YOU), and the last
    // transmission of any kind -- a CQ, a heartbeat -- because upstream answers
    // AGN? out of m_lastTxMessage, its last transmission full stop, and a
    // station that copied our CQ garbled asks exactly that way.
    noteSent(call, text) {
      if (!text) return;
      const normalized = normalizeCall(call);
      this.lastTransmission = {to: normalized, text: String(text)};
      if (normalized) this.lastSentByCall.set(normalized, text);
    }

    // Any directed frame arriving -- to us or not -- arms the QSO lock, matching
    // upstream behaviour: do not talk over a conversation in progress.
    noteDirectedFrame(nowMs) { this.lastDirectedFrameMs = nowMs; }

    qsoLockRemainingMs(nowMs) {
      const elapsed = nowMs - this.lastDirectedFrameMs;
      return elapsed >= QSO_LOCK_MS ? 0 : QSO_LOCK_MS - elapsed;
    }

    /**
     * @param frame  decoded directed frame: {from, to, command, snr, complete}
     * @param ctx    {nowMs, myCall, groups, selectedCall, auto, grid, infoText,
     *                statusText, hearing}
     * @returns {action:"reply", to, text, command} |
     *          {action:"buffer", ...}  (AUTO off: offer it to the operator) |
     *          {action:"skip", reason, detail}
     */
    handle(frame, ctx) {
      const from = normalizeCall(frame && frame.from);
      const to = normalizeCall(frame && frame.to);
      const myCall = normalizeCall(ctx && ctx.myCall);
      const command = String(frame && frame.command || "").trim().toUpperCase();
      const nowMs = ctx.nowMs;

      if (!from || !myCall) return this._skip("invalid", "missing callsign");
      if (from === myCall) return this._skip("self", "frame from our own callsign");

      const groups = (ctx.groups || []).map(normalizeCall);
      const addressed = to === myCall || groups.includes(to);
      if (!addressed) return this._skip("not-addressed", `directed at ${to || "nobody"}`);
      // Reference JS8Call never answers these queries when they are sent to
      // @ALLCALL. Other explicitly joined groups remain eligible.
      if (to === "@ALLCALL")
        return this._skip("allcall", "automatic queries to @ALLCALL are suppressed");
      // AGN? is refused for ANY group, matching upstream's `!isGroupCall`
      // (processCommandActivity.cpp:629): "say that again" asked of a group
      // would have every member repeat a DIFFERENT message into the same slot.
      // The other queries survive a group because the answers can spread out;
      // these answers cannot even agree on what they are repeating.
      if (command === "AGN?" && to.startsWith("@"))
        return this._skip("group-query", "AGN? to a group is never answered");

      const handler = HANDLERS[command];
      if (!handler) return this._skip("unsupported", `no auto reply for ${command}`);

      // A multi-frame request is only answered once it is complete, otherwise we
      // would reply to half a message.
      if (frame.complete === false)
        return this._skip("incomplete", `${command} still arriving`);

      const lockMs = this.qsoLockRemainingMs(nowMs);
      if (lockMs > 0 && frame.armsLock !== false)
        return this._skip("qso-lock", `conversation in progress, ${Math.ceil(lockMs / 1000)} s left`);

      // Build the answer before spending the restriction budget, so a refusal
      // caused by missing configuration does not also consume a window slot.
      let text;
      if (command === "AGN?") {
        // First choice: what we last wrote to THIS station. Fallback: our last
        // transmission of any kind, which is what upstream always answers with
        // (m_lastTxMessage) -- the station asking heard us send SOMETHING and
        // wants it again; a garbled CQ is the common case. One deliberate
        // difference: upstream re-transmits it verbatim to its original
        // addressee, we address the answer to the asker.
        const previous = this.lastSentByCall.get(from) ||
          (this.lastTransmission && this.lastTransmission.text);
        if (!previous)
          return this._skip("nothing-to-repeat", "no earlier transmission to repeat");
        text = previous;
      } else {
        if (handler.needs) {
          const value = ctx[handler.needs];
          const empty = handler.needs === "hearing"
            ? !Array.isArray(value) || value.length === 0
            : !String(value || "").trim();
          if (empty)
            return this._skip("not-configured", `${handler.needs} is not set`, {command});
        }
        // The requester already knows we hear them; reference JS8Call excludes
        // that callsign and returns up to four other recently heard stations.
        const hearing = (ctx.hearing || [])
          .map(normalizeCall)
          .filter(call => call && call !== from)
          .slice(0, HEARING_MAX);
        text = handler.reply({...ctx, hearing}, frame);
      }

      if (this.restrictions) {
        const verdict = this.restrictions.evaluate({call: from, command, nowMs,
          windowKey: handler.windowAs || command,
          isSelectedCall: normalizeCall(ctx.selectedCall) === from});
        if (!verdict.allowed)
          return this._skip(verdict.reason, verdict.detail,
            {command, level: verdict.level, retryInMs: verdict.retryInMs});
      }

      // AUTO off still produces the answer, it just goes to the composer for the
      // operator to send -- upstream behaviour, and it keeps the restriction
      // accounting identical either way.
      const action = ctx.auto ? "reply" : "buffer";
      if (action === "reply") this.stats.replied += 1;
      this._emit({type: action, to: from, command, text});
      return {action, to: from, command, text};
    }

    snapshot() { return {...this.stats, lockUntilMs: this.lastDirectedFrameMs + QSO_LOCK_MS}; }
  }

  return {Js8AutoReply, HANDLERS, QSO_LOCK_MS, HEARING_MAX, formatSnr};
});
