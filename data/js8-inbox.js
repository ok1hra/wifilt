// Inbox: store-and-forward messaging.
//
// Five commands from docs/js8call-komunikacni-funkce.md group E:
//
//   MSG <text>              store for me, acknowledge
//   MSG TO:<CALL> <text>    store at this station for CALL, acknowledge
//   QUERY MSGS              do you hold anything for me?
//   QUERY MSG <id>          deliver message <id>
//   QUERY CALL <call>       can you reach <call>?
//
// The decision layer is here; the actual store lives in the firmware
// (decision 10) so mail survives a reload, a different computer and a cleared
// browser cache, and can be read from a phone. The store is injected, which also
// makes every rule testable without a radio or a filesystem.
//
// Storing is deliberately cheaper than transmitting: accepting a message costs
// us nothing but flash, so MSG is accepted even when unattended mode is off.
// Only the replies need a transmitter, and delivering somebody else's stored
// message is treated like relaying -- it needs arming.
//
// Every record carries a TYPE, the same four the reference implementation uses
// (mainwindow.cpp addCommandToStorage): STORE is third-party mail we hold,
// DELIVERED is a STORE we handed over, UNREAD/READ is mail for this operator.
// Without it one hopper held both kinds and `QUERY MSGS` answered out of all of
// them -- so a station that sent us a bare MSG got its own message offered back.
// Upstream avoids that by querying STORE alone, and so do we now.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8Inbox = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  // Record types. STORE/DELIVERED/UNREAD/READ mirror the reference
  // implementation; DEFERRED is ours -- own outgoing mail waiting for the
  // recipient to show up, which upstream has no concept of.
  const TYPE = {STORE: "STORE", DELIVERED: "DELIVERED", UNREAD: "UNREAD",
    READ: "READ", DEFERRED: "DEFERRED", EXPIRED: "EXPIRED"};

  const DEFAULTS = {
    maxMessages: 96,
    maxTextLength: 120,
    maxPerSender: 8,       // undelivered STORE per sender: one station must not
                           // be able to fill the whole store
    maxStore: 32,          // third-party mail may not crowd out our own
    maxUnreadPerSender: 16,
    maxDeferred: 16,
    dedupWindowMs: 24 * 3600000,  // the same message twice is a lost ACK, not new mail
    // Group mail is the one record that survives its own delivery -- every member may
    // still come for it -- so it needs a way out that per-recipient marking cannot give.
    // 24 KiB of durable store is a hard ceiling, and a net message nobody has come for in
    // a day is not worth the airtime it still promises. It expires VISIBLY (type EXPIRED,
    // logged), never silently: the MSG BOX rule is that nothing confirmed disappears
    // without a trace.
    groupTtlMs: 24 * 3600000,
    maxGroupRecipients: 8,
  };

  const CALL_RE = /^[A-Z0-9]{2,6}(?:\/[A-Z0-9]{1,2})?$/;
  const GROUP_RE = /^@[A-Z0-9/]{1,8}$/;
  const isCallsign = v => CALL_RE.test(String(v || "").toUpperCase().trim());
  const isGroup = v => GROUP_RE.test(String(v || "").toUpperCase().trim());
  const norm = v => String(v || "").toUpperCase().trim();
  // OK1BT/P is OK1BT working portable, and their mail is theirs whichever way
  // they sign today -- upstream hands a message over when the asker matches the
  // stored callsign OR its base (processCommandActivity.cpp, QUERY MSG branch).
  // The longest slash-separated segment is the base, same heuristic as
  // Radio::base_callsign for the prefix/suffix forms that reach us.
  const baseCall = v => norm(v).split("/")
    .reduce((best, segment) => segment.length > best.length ? segment : best, "");
  const sameStation = (left, right) =>
    norm(left) === norm(right) || (Boolean(left) && Boolean(right) &&
      !isGroup(left) && !isGroup(right) && baseCall(left) === baseCall(right));
  const formatSnr = value => {
    const measured = Math.round(Number(value));
    const snr = Number.isFinite(measured)
      ? Math.max(-30, Math.min(31, measured)) : 0;
    return `${snr < 0 ? "-" : "+"}${String(Math.abs(snr)).padStart(2, "0")}`;
  };
  const since = (thenMs, nowMs) => {
    const seconds = Math.max(0, Math.floor((Number(nowMs) - Number(thenMs)) / 1000));
    if (!Number.isFinite(seconds) || seconds < 15) return "now";
    if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
    return `${seconds - (seconds % 15)}s`;
  };

  // "OK1ABC HELLO" -> {to:"OK1ABC", text:"HELLO"}; null when malformed.
  //
  // The wire payload of a genuine " MSG TO:" frame carries NO "TO:" prefix --
  // the prefix is part of the command token, and JS8Call's receiver simply takes
  // the first word as the target (processCommandActivity.cpp, MSG TO: branch).
  // The prefixed form is still accepted: our own transmitter used to emit
  // " MSG" + "TO:CALL text" (both halves mirrored the mistake, so it was
  // invisible between two WIFILT stations), and frames from stations running
  // that firmware are still on the air.
  function parseMsgTo(payload) {
    const match = /^(?:TO:)?\s*(@?[A-Z0-9/]+)\s+([\s\S]+)$/i.exec(String(payload || "").trim());
    if (!match) return null;
    const to = norm(match[1]);
    if (!isCallsign(to) && !isGroup(to)) return null;
    return {to, text: match[2].trim()};
  }

  // A tiny in-memory store used by the tests and as the browser-side mirror.
  // Every query is typed: mail held FOR somebody is keyed by `to`, mail addressed
  // to this operator is keyed by `from`, exactly as upstream indexes them.
  class MemoryStore {
    constructor() { this.items = []; this.nextId = 1; }
    add(record) {
      const item = {type: TYPE.STORE, delivered: false, ...record, id: this.nextId++};
      this.items.push(item);
      return item;
    }
    // Third-party mail still waiting for this callsign. Never our own inbox:
    // handing somebody their own message back is what the type separates.
    // Group mail counts too: it is addressed to a group this station belongs to, so any
    // member may come for it -- but only once each, which is what deliveredTo records.
    // Matching is by station, not by string: OK1BT/P collects mail left for OK1BT.
    forCall(call) {
      const who = norm(call);
      return this.items.filter(i => i.type === TYPE.STORE &&
        (sameStation(i.to, who) || (isGroup(i.to) && !(i.deliveredTo || []).includes(who) &&
                          i.from !== who)));
    }
    // Only the group half of the above, for the answers that name a group explicitly.
    forGroup(group, call) {
      const who = norm(call), name = norm(group);
      return this.items.filter(i => i.type === TYPE.STORE && i.to === name &&
        !(i.deliveredTo || []).includes(who) && i.from !== who);
    }
    byId(id) { return this.items.find(i => i.id === Number(id)) || null; }
    countFrom(from) {
      return this.items.filter(i => i.type === TYPE.STORE && i.from === norm(from)).length;
    }
    countType(type, from) {
      const sender = from === undefined ? null : norm(from);
      return this.items.filter(i => i.type === type &&
        (sender === null || i.from === sender)).length;
    }
    // A STORE that went out becomes DELIVERED; `delivered` stays for anything
    // still reading the old field. Group mail is the exception: handing it to one member
    // must not take it away from the rest, so it keeps its type and only records who has
    // had it. `maxRecipients` is what eventually closes it.
    markDelivered(id, call = "", maxRecipients = 8) {
      const i = this.byId(id);
      if (!i) return null;
      if (isGroup(i.to)) {
        const who = norm(call);
        i.deliveredTo = [...new Set([...(i.deliveredTo || []), ...(who ? [who] : [])])];
        if (i.deliveredTo.length >= maxRecipients) {
          i.delivered = true;
          if (i.type === TYPE.STORE) i.type = TYPE.DELIVERED;
        }
        return i;
      }
      i.delivered = true;
      if (i.type === TYPE.STORE) i.type = TYPE.DELIVERED;
      return i;
    }
    remove(id) {
      const index = this.items.findIndex(i => i.id === Number(id));
      if (index < 0) return null;
      return this.items.splice(index, 1)[0];
    }
    size() { return this.items.length; }
    all() { return this.items.slice(); }
  }

  class Js8Inbox {
    constructor(options = {}) {
      this.config = {...DEFAULTS, ...options};
      this.store = options.store || new MemoryStore();
      this.onEvent = options.onEvent || null;
      this.stats = {stored: 0, delivered: 0, refused: 0};
    }

    _emit(event) { if (this.onEvent) this.onEvent(event); }
    _refuse(reason, detail) {
      this.stats.refused += 1;
      this._emit({type: "refused", reason, detail});
      return {action: "skip", reason, detail};
    }

    /**
     * Ordinary human traffic addressed to us: a plain directed message, or text
     * a relay handed over. Upstream leaves these in the RX window only, which is
     * exactly how a message goes unnoticed after three days away -- the traffic
     * feed is capped and CLEAR wipes it, so the MSG BOX is the only place a
     * message can wait. No ACK: nothing was promised, we simply keep it.
     *
     * @param frame {from, to, text, via}
     * @param ctx   {nowMs, myCall}
     */
    fileIncoming(frame, ctx) {
      const from = norm(frame && frame.from);
      const to = norm(frame && frame.to);
      const myCall = norm(ctx && ctx.myCall);
      const text = String(frame && frame.text || "").trim();
      if (!from || !myCall) return this._refuse("invalid", "missing callsign");
      if (to !== myCall) return this._refuse("not-addressed", `for ${to || "nobody"}`);
      const outcome = this._store(from, myCall, text, ctx, TYPE.UNREAD,
        norm(frame && frame.via));
      return outcome.ack ? {...outcome, ack: null} : outcome;
    }

    /**
     * `via` is the station that handed the message over when it came through a
     * relay: the sender is the originator, but the only address that reaches
     * them is the intermediary, so the record has to remember both.
     *
     * @param frame {from, to, command, text, complete, via}
     * @param ctx   {nowMs, myCall, armed, hearing:[calls]}
     */
    handle(frame, ctx) {
      const from = norm(frame && frame.from);
      const to = norm(frame && frame.to);
      const myCall = norm(ctx && ctx.myCall);
      const command = String(frame && frame.command || "").trim().toUpperCase();
      const payload = String(frame && frame.text || "").trim();
      const via = norm(frame && frame.via);

      if (!from || !myCall) return this._refuse("invalid", "missing callsign");
      // A command addressed to a group we belong to is addressed to us: that is what
      // membership means. A group we are NOT in is somebody else's net.
      const groups = (ctx && ctx.groups || []).map(norm);
      const mine = to === myCall || groups.includes(to);
      if (!mine) return this._refuse("not-addressed", `for ${to || "nobody"}`);
      // Checksummed commands: acting on half a message would store or transmit
      // corrupted text.
      if (frame.complete === false) return this._refuse("incomplete", `${command} still arriving`);
      // Which group it came in on, "" for a question asked of us by name. Every
      // answer below has to consider it, because a group question is heard by
      // every member at once and an answer they would ALL give is not an answer,
      // it is a pile-up in one slot.
      const group = isGroup(to) ? to : "";
      // @ALLCALL is the whole band, and mail is a two-station affair. Upstream
      // excludes it from MSG, MSG TO: and QUERY outright (`!isAllCall`), and so
      // do we: storing for everybody, or handing a message over because anyone
      // asked, is not something a group call can be allowed to trigger.
      if (group === "@ALLCALL" &&
          (command === "MSG" || command === "MSG TO:" || command === "QUERY MSG"))
        return this._refuse("allcall", `${command} to @ALLCALL is not answered`);

      switch (command) {
        // A bare MSG is mail for this operator: filed under my own callsign as
        // UNREAD, not as third-party stock. Upstream files the whole command the
        // same way and looks it up by sender.
        case "MSG":       return this._store(from, myCall, payload, ctx, TYPE.UNREAD, via);
        case "MSG TO:":   return this._storeFor(from, payload, ctx, via);
        case "QUERY MSGS":
        case "QUERY MSGS?": return this._queryMsgs(from, ctx, group);
        case "QUERY MSG": return this._queryMsg(from, payload, ctx);
        case "QUERY CALL": return this._queryCall(from, payload, ctx);
        default: return this._refuse("unsupported", `inbox does not handle ${command}`);
      }
    }

    _store(from, to, text, ctx, type = TYPE.STORE, via = "") {
      if (!text) return this._refuse("empty", "no message text");
      if (text.length > this.config.maxTextLength)
        return this._refuse("too-long", `${text.length} characters, limit ${this.config.maxTextLength}`);
      if (this.store.size() >= this.config.maxMessages)
        return this._refuse("full", `inbox holds ${this.config.maxMessages} messages`);

      if (type === TYPE.STORE) {
        if (this.store.countType(TYPE.STORE) >= this.config.maxStore)
          return this._refuse("store-quota",
            `already holding ${this.config.maxStore} messages for other stations`);
        if (this.store.countFrom(from) >= this.config.maxPerSender)
          return this._refuse("sender-quota",
            `${from} already has ${this.config.maxPerSender} undelivered messages here`);
      } else if (type === TYPE.UNREAD) {
        if (this.store.countType(TYPE.UNREAD, from) >= this.config.maxUnreadPerSender)
          return this._refuse("sender-quota",
            `${from} already has ${this.config.maxUnreadPerSender} unread messages here`);
        // A repeat inside the window is a lost ACK coming back around, not a
        // second message. Swallow the copy and let the caller acknowledge again.
        const twin = this.store.all().find(item =>
          (item.type === TYPE.UNREAD || item.type === TYPE.READ) &&
          item.from === from && item.text === text &&
          Number(ctx.nowMs) - Number(item.atMs) < this.config.dedupWindowMs);
        if (twin) {
          this._emit({type: "duplicate", id: twin.id, from, text});
          return {action: "duplicate", record: twin, ack: {to: from, text: "ACK"}};
        }
      }

      // `via` is only written when there is one: every record is serialized into
      // a 24 KiB budget, so an empty field on every message is real airtime-free
      // storage spent on nothing.
      const record = this.store.add({type, from, to, text, atMs: ctx.nowMs,
        delivered: false, ...(via ? {via} : {})});
      this.stats.stored += 1;
      this._emit({type: "stored", id: record.id, from, to, text, ...(via ? {via} : {})});
      // Storing costs nothing to transmit, so it works while disarmed; only the
      // acknowledgement needs the radio, and the caller decides that.
      // The local storage id is advertised by HEARTBEAT SNR / QUERY MSGS. A
      // normal MSG acknowledgement is the single-frame ACK command.
      return {action: "store", record, ack: {to: from, text: "ACK"}};
    }

    _storeFor(from, payload, ctx, via = "") {
      const parsed = parseMsgTo(payload);
      if (!parsed) {
        const skip = this._refuse("malformed", "expected MSG TO:CALL text");
        return {...skip, nack: {to: from, text: "NACK"}};
      }
      // Addressed to us it is our own mail, not stock we hold for a stranger.
      if (parsed.to === norm(ctx.myCall))
        return this._store(from, parsed.to, parsed.text, ctx, TYPE.UNREAD, via);
      // Mail for a group we have joined is worth holding: the members are people we are
      // on the air with. A group we are not in has nobody here to collect it, so the box
      // would be a public noticeboard paid for out of our own flash -- upstream accepts
      // any @NAME and this is where we deliberately part company with it.
      if (isGroup(parsed.to) && !(ctx.groups || []).map(norm).includes(parsed.to)) {
        const skip = this._refuse("not-my-group",
          `${parsed.to} is a group this station has not joined`);
        return {...skip, nack: {to: from, text: "NACK"}};
      }
      return this._store(from, parsed.to, parsed.text, ctx, TYPE.STORE);
    }

    _queryMsgs(from, ctx, group = "") {
      if (!ctx.armed)
        return this._refuse("not-armed", "QUERY MSGS requires AUTO");
      const waiting = this.store.forCall(from);
      if (!waiting.length) {
        // "Nothing here" is worth saying to a station that asked US. Asked of a
        // group, every member holding nothing would say it in the same slot --
        // a chorus of NO that buries the one station with an answer. Upstream
        // draws the same line (`if (!isAllCall && reply.isEmpty())`); we draw it
        // for every group, because the pile-up does not care which one it is.
        if (group)
          return this._refuse("group-silence",
            `nothing for ${from}; a NO to ${group} would be answered by everybody`);
        return {action: "reply", to: from, text: "NO", detail: "nothing stored"};
      }
      // Upstream answers with the id of the oldest message still to be
      // delivered; the asker then requests it explicitly.
      const oldest = waiting[0];
      const more = waiting.length > 1 ? ` +${waiting.length - 1}` : "";
      return {action: "reply", to: from, text: `YES MSG ID ${oldest.id}${more}`,
        detail: `${waiting.length} waiting`};
    }

    _queryMsg(from, payload, ctx) {
      const id = Number(String(payload || "").trim());
      if (!Number.isInteger(id) || id <= 0) return this._refuse("malformed", "expected a message id");
      const record = this.store.byId(id);
      if (!record) return this._refuse("unknown-id", `no message ${id}`);
      // Only stock we hold for somebody else may be handed over. Our own mail
      // and messages already delivered are not for the asking, whoever asks.
      if (record.type === TYPE.DELIVERED)
        return this._refuse("already-delivered", `message ${id} was handed over`);
      if (record.type === TYPE.EXPIRED)
        return this._refuse("expired", `message ${id} was held too long and expired`);
      if (record.type !== TYPE.STORE)
        return this._refuse("not-yours", `message ${id} is not held for anybody`);
      // Group mail belongs to every member, but only once each -- and never back to the
      // station that left it, which is the bug the typed store was built to prevent.
      const forGroup = isGroup(record.to);
      if (forGroup && (record.deliveredTo || []).includes(from))
        return this._refuse("already-delivered", `${from} already had message ${id}`);
      if (forGroup && record.from === from)
        return this._refuse("not-yours", `message ${id} came from ${from}`);
      if (!forGroup && !sameStation(record.to, from))
        return this._refuse("not-yours", `message ${id} is not addressed to ${from}`);
      // Handing over a message we are holding for somebody else is transmitting
      // third-party content, exactly like a relay hop.
      if (!ctx.armed) return this._refuse("not-armed", "delivery requires unattended mode");
      // Do not mark it here. The caller confirms only after the RF transaction
      // reaches "completed"; an aborted or unavailable transmitter must leave
      // the message retrievable.
      const waiting = this.store.forCall(from).filter(item => item.id !== id);
      const next = waiting.length
        ? ` NEXT MSG ID ${waiting[0].id}${waiting.length > 1 ? ` +${waiting.length - 1}` : ""}`
        : "";
      return {action: "deliver", to: from,
        // Group mail says which net it came from, or the member has no way to tell it
        // apart from a message addressed to them personally.
        text: isGroup(record.to)
          ? `MSG ${record.text} FROM ${record.from} TO ${record.to}${next}`
          : `MSG ${record.text} FROM ${record.from}${next}`, record,
        deliveryId: record.id};
    }

    _queryCall(from, payload, ctx) {
      if (!ctx.armed)
        return this._refuse("not-armed", "QUERY CALL requires AUTO");
      const target = norm(payload);
      if (!isCallsign(target)) return this._refuse("malformed", "expected a callsign");
      const heard = (ctx.hearing || []).find(item =>
        norm(typeof item === "object" && item ? item.call : item) === target);
      // Reference JS8Call stays silent when the target is unknown.
      if (!heard) return this._refuse("not-heard", `${target} not heard`);
      const text = typeof heard === "object" && heard
        ? `YES ${formatSnr(heard.snr)} (${since(heard.lastSlotUtcMs, ctx.nowMs)})`
        : "YES";
      return {action: "reply", to: from, text, detail: `we hear ${target}`};
    }

    // Messages this station is holding, for the UI and the remote panel.
    pending(call) { return this.store.forCall(call); }
    // `call` matters only for group mail: it is the member we handed it to.
    confirmDelivered(id, call = "") {
      const record = this.store.byId(id);
      if (!record || record.delivered) return false;
      this.store.markDelivered(id, call, this.config.maxGroupRecipients);
      this.stats.delivered += 1;
      this._emit({type: "delivered", id: record.id, to: record.to, call,
        text: record.text});
      return true;
    }

    // Group mail is the only record with a clock on it, and it has to stop out loud:
    // the type changes to EXPIRED and the reason is logged, so a message that was
    // promised to a net never simply vanishes from the box.
    expireGroupMail(nowMs) {
      const expired = [];
      for (const item of this.store.all()) {
        if (item.type !== TYPE.STORE || !isGroup(item.to)) continue;
        if (Number(nowMs) - Number(item.atMs) < this.config.groupTtlMs) continue;
        item.type = TYPE.EXPIRED;
        expired.push(item);
        this._emit({type: "expired", id: item.id, to: item.to, from: item.from,
          detail: `held ${Math.round((Number(nowMs) - Number(item.atMs)) / 3600000)} h ` +
                  `for ${item.to}, delivered to ${(item.deliveredTo || []).length}`});
      }
      return expired.length;
    }

    snapshot() {
      return {...this.stats, size: this.store.size(),
        items: this.store.all().map(i => ({id: i.id, type: i.type || TYPE.STORE,
          from: i.from, to: i.to, text: i.text, atMs: i.atMs, via: i.via || "",
          deliveredTo: (i.deliveredTo || []).slice(),
          delivered: Boolean(i.delivered)}))};
    }
  }

  return {Js8Inbox, MemoryStore, DEFAULTS, TYPE, parseMsgTo, isCallsign, isGroup};
});
