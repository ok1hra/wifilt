// MSG BOX: durability, types and eviction around the inbox protocol engine.
//
// js8-inbox.js decides what the protocol may do; this owns what survives. The
// two share one store, so a message filed by the protocol and a message the
// operator deferred are the same record with a different TYPE -- one file, one
// quota, one eviction order (docs/msgbox-implementace.md, decision 1).
//
// Eviction is driven by BYTES, not by the record count. The firmware refuses a
// body over its cap with 413 and the browser-side mirror would then keep
// running against a copy flash no longer has -- the box would look fine until a
// reload lost everything. So the budget is enforced where the JSON is built.
//
// What never gets evicted: unread mail and deferred messages still trying. When
// only those are left the box is full and refuses new mail instead, which at
// least tells the sender something (no ACK). Silently dropping a message we
// already acknowledged is the one outcome worth avoiding.

(function (root, factory) {
  const value = factory(typeof require === "function" && typeof module === "object"
    ? require("./js8-inbox.js") : (root.Js8Inbox || null));
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8MsgBox = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function (inboxModule) {
  const TYPE = (inboxModule && inboxModule.TYPE) || {STORE: "STORE",
    DELIVERED: "DELIVERED", UNREAD: "UNREAD", READ: "READ", DEFERRED: "DEFERRED"};
  // A directed frame packs the recipient into 28 bits: a base callsign longer
  // than six characters cannot be addressed at all, and asking anyway throws
  // inside the encoder. Anything we plan to transmit to has to pass this first.
  const isCallsign = (inboxModule && inboxModule.isCallsign) ||
    (value => /^[A-Z0-9]{2,6}(?:\/[A-Z0-9]{1,2})?$/.test(String(value || "").toUpperCase().trim()));
  // OK1ABC and OK1ABC/P are one station. Comparing the raw strings would let a
  // suffix slip past an identity check that exists to catch exactly that.
  const baseCall = value =>
    String(value || "").toUpperCase().trim().split("/")[0];

  const DEFAULTS = {
    maxBytes: 24576,     // must match MSGBOX_MAX_BYTES in the firmware
    evictAtRatio: 0.9,   // leave headroom: the last record must still fit
    maxTextLength: 120,  // the protocol's limit, not the store's
    maxDeferred: 16,
    // Seven days is the longest arming window the firmware offers
    // (unattended_guard.h), so a deferred message can never outlive every
    // opportunity its own station could have given it.
    lifetimeMs: 7 * 24 * 3600000,
  };

  // Deferred sub-states. `waiting` is the only one still allowed to transmit;
  // the other two are terminal and therefore evictable.
  const STATE = {WAITING: "waiting", HANDED: "handed", ATTENTION: "attention"};

  // Eviction order, worst first. Position in this list IS the policy: history
  // before things still in use, other people's mail before our own.
  const EVICTION_ORDER = [TYPE.DELIVERED, TYPE.READ, TYPE.STORE, TYPE.DEFERRED];

  const isLiveDeferred = item =>
    item.type === TYPE.DEFERRED && (item.state || STATE.WAITING) === STATE.WAITING;
  const isEvictable = item =>
    item.type !== TYPE.UNREAD && !isLiveDeferred(item);

  // Records written before types existed. The old file is discriminable because
  // a bare MSG was filed against its sender (to === from) while MSG TO: was
  // filed against a third station -- see docs/msgbox-implementace.md.
  function migrateRecord(record) {
    if (!record || typeof record !== "object") return null;
    // `pinnedVia` arrived with the via-route picker. A deferred record written
    // before it has no pin, which is exactly what an empty string means, so the
    // default is filled in rather than left undefined -- the automation reads
    // this field on every appearance and an absent key would work by accident.
    if (record.type === TYPE.DEFERRED && typeof record.pinnedVia !== "string")
      record = {...record, pinnedVia: ""};
    if (record.type) return record;
    const own = String(record.to || "").toUpperCase() === String(record.from || "").toUpperCase();
    const delivered = Boolean(record.delivered);
    return {...record,
      type: own ? (delivered ? TYPE.READ : TYPE.UNREAD)
                : (delivered ? TYPE.DELIVERED : TYPE.STORE)};
  }

  // "HEARTBEAT SNR -12 MSG ID 32" and "YES MSG ID 7 +2" both mean the same
  // thing: somebody is holding mail for us and named its id. Upstream emits both
  // and acts on neither, so this is the parser nobody has.
  const ADVERT_RE = /(?:^|\s)MSG ID\s+(\d+)(?:\s*\+(\d+))?/i;
  function parseMailAdvert(text) {
    const match = ADVERT_RE.exec(String(text || ""));
    if (!match) return null;
    // A delivery quotes the id of the NEXT message, which is an advert too --
    // but it is handled by the delivery parser so the pickup is registered once.
    if (/NEXT MSG ID/i.test(String(text || ""))) return null;
    return {id: Number(match[1]), more: Number(match[2] || 0)};
  }

  // The reply to QUERY MSG: "MSG <text> FROM <origin> NEXT MSG ID 33 +1".
  // Splitting it keeps the stored record readable and turns the tail into the
  // next pickup instead of leaving protocol noise in the operator's mail.
  // The command token is stripped by the time the payload reaches us, so the
  // leading MSG is optional here.
  const DELIVERY_RE = /^(?:MSG\s+)?([\s\S]+?)\s+FROM\s+([A-Z0-9/]+)(?:\s+NEXT MSG ID\s+(\d+)(?:\s*\+(\d+))?)?$/i;
  function parseDeliveredMail(text) {
    const match = DELIVERY_RE.exec(String(text || "").trim());
    if (!match) return null;
    return {text: match[1].trim(), origin: match[2].toUpperCase(),
      nextId: match[3] ? Number(match[3]) : 0, more: Number(match[4] || 0)};
  }

  // Decision 6 in one object: one attempt per opportunity, an hour between
  // attempts at the same thing, five in total and then it stops on its own.
  // Deliberately shared with the deferred sending stages -- an unreachable
  // station must not be able to make us transmit forever, whatever the reason.
  class AttemptLedger {
    constructor({maxAttempts = 5, cooldownMs = 3600000} = {}) {
      this.config = {maxAttempts, cooldownMs};
      this.entries = new Map();
    }
    entry(key) { return this.entries.get(String(key)) || null; }
    due(key, nowMs) {
      const entry = this.entry(key);
      if (!entry) return true;
      if (entry.attempts >= this.config.maxAttempts) return false;
      return Number(nowMs) - entry.lastMs >= this.config.cooldownMs;
    }
    exhausted(key) {
      const entry = this.entry(key);
      return Boolean(entry) && entry.attempts >= this.config.maxAttempts;
    }
    note(key, nowMs) {
      const entry = this.entry(key) || {attempts: 0, lastMs: 0};
      entry.attempts += 1;
      entry.lastMs = Number(nowMs) || 0;
      this.entries.set(String(key), entry);
      return {attempts: entry.attempts,
        exhausted: entry.attempts >= this.config.maxAttempts};
    }
    clear(key) { this.entries.delete(String(key)); }
  }

  class Js8MsgBox {
    constructor({store, maxBytes, evictAtRatio, onEvent} = {}) {
      if (!store) throw new Error("Js8MsgBox needs the store the inbox engine uses");
      this.store = store;
      this.config = {...DEFAULTS,
        ...(maxBytes ? {maxBytes} : {}),
        ...(evictAtRatio ? {evictAtRatio} : {})};
      this.onEvent = onEvent || null;
      this.stats = {evicted: 0, migrated: 0, dropped: 0};
    }

    _emit(event) { if (this.onEvent) this.onEvent(event); }

    // --- durability ---------------------------------------------------------

    // One record per line, so a single corrupt line costs one message and not
    // the whole box. Returns what happened, because "restored 0" and "the file
    // was empty" are different failures and the operator needs to tell them apart.
    loadJsonl(text) {
      const result = {restored: 0, migrated: 0, dropped: 0};
      for (const line of String(text || "").split("\n")) {
        if (!line.trim()) continue;
        let record = null;
        try { record = JSON.parse(line); } catch (_error) { result.dropped += 1; continue; }
        const typed = migrateRecord(record);
        if (!typed || !typed.text) { result.dropped += 1; continue; }
        if (!record.type) result.migrated += 1;
        this.store.items.push(typed);
        this.store.nextId = Math.max(this.store.nextId, Number(typed.id || 0) + 1);
        result.restored += 1;
      }
      this.stats.migrated += result.migrated;
      this.stats.dropped += result.dropped;
      if (result.migrated || result.dropped) this._emit({type: "loaded", ...result});
      return result;
    }

    toJsonl() {
      return this.store.all().map(item => JSON.stringify(item)).join("\n");
    }

    byteSize() {
      // The firmware measures the POST body, so measure the same thing. Text is
      // capped at 120 characters but callsigns and text are ASCII in practice;
      // TextEncoder keeps it honest where it is available.
      const body = this.toJsonl();
      return typeof TextEncoder === "function"
        ? new TextEncoder().encode(body).length
        : Buffer.byteLength(body, "utf8");
    }

    // --- eviction -----------------------------------------------------------

    budget() { return Math.floor(this.config.maxBytes * this.config.evictAtRatio); }

    /**
     * Drops records down the ladder until the serialized body fits the budget.
     * @returns {evicted:[], bytes:number, full:boolean}
     *   `full` means nothing evictable is left and the box is still over budget:
     *   the caller must refuse new mail rather than drop unread messages.
     */
    enforceBudget() {
      const evicted = [];
      let bytes = this.byteSize();
      const limit = this.budget();
      while (bytes > limit) {
        const victim = this._nextVictim();
        if (!victim) break;
        this.store.remove(victim.id);
        evicted.push(victim);
        this.stats.evicted += 1;
        this._emit({type: "evicted", id: victim.id, recordType: victim.type,
          from: victim.from, to: victim.to});
        bytes = this.byteSize();
      }
      return {evicted, bytes, full: bytes > limit};
    }

    _nextVictim() {
      for (const type of EVICTION_ORDER) {
        const candidates = this.store.all()
          .filter(item => item.type === type && isEvictable(item))
          .sort((left, right) => (Number(left.atMs) || 0) - (Number(right.atMs) || 0));
        if (candidates.length) return candidates[0];
      }
      return null;
    }

    // --- deferred outgoing mail ---------------------------------------------

    /**
     * Parks a message the operator wrote for a station that is not here now.
     * Refusals are returned rather than thrown: every one of them is something
     * the composer must say out loud.
     *
     * A group is refused because a group never "shows up" -- there is no event
     * that could ever release the message, so it would wait for ever.
     *
     * `pinnedVia` narrows the automation to a single intermediary the operator
     * picked from the route list. Empty means "any", which is the old behaviour.
     *
     * @returns {record} | {refused:reason}
     */
    defer({to, text, nowMs, myCall, lifetimeMs = DEFAULTS.lifetimeMs, pinnedVia = ""}) {
      const target = String(to || "").toUpperCase().trim();
      const body = String(text || "").trim();
      if (!target || target.startsWith("@")) return {refused: "not-a-station"};
      if (String(myCall || "").toUpperCase().trim() === target) return {refused: "own-callsign"};
      // Parking mail for a station we could never address would be a message
      // that waits for ever and then throws in the encoder when its moment comes.
      if (!isCallsign(target)) return {refused: "not-addressable"};
      if (!body) return {refused: "empty"};
      if (body.length > DEFAULTS.maxTextLength) return {refused: "too-long"};
      if (this.counts().deferred >= DEFAULTS.maxDeferred) return {refused: "too-many"};
      // `pinnedVia` is the operator's WISH -- the one intermediary this message
      // may be parked at. It is a different thing from `via`, which is the
      // RESULT recorded once somebody actually acknowledged storing it, and
      // conflating the two would make an unfulfilled plan look like a delivery.
      //
      // An unusable pin is REFUSED rather than dropped. Storing the message with
      // an empty pin would widen it back to "park it anywhere", which is the
      // opposite of what was asked, while the button reported success -- and the
      // automation would then hand the mail to whichever station turned up first.
      const pin = String(pinnedVia || "").toUpperCase().trim();
      if (pin) {
        if (!isCallsign(pin)) return {refused: "pin-not-addressable"};
        // /P and /QRP are the same station; a suffix must not let a pin name the
        // addressee and quietly become a self-pin the automation can never satisfy.
        if (baseCall(pin) === baseCall(target)) return {refused: "pin-is-the-addressee"};
      }
      const record = this.store.add({type: TYPE.DEFERRED, state: STATE.WAITING,
        from: String(myCall || "").toUpperCase(), to: target, text: body,
        atMs: nowMs, expiresMs: nowMs + lifetimeMs, via: "", attempts: 0,
        pinnedVia: pin, delivered: false});
      this._emit({type: "deferred", id: record.id, to: target});
      return record;
    }

    // Messages still trying to reach this station, oldest first.
    deferredFor(call, nowMs) {
      const target = String(call || "").toUpperCase();
      this.expireDeferred(nowMs);
      return this.store.all()
        .filter(item => isLiveDeferred(item) && item.to === target)
        .sort((left, right) => (Number(left.atMs) || 0) - (Number(right.atMs) || 0));
    }

    // Seven days is the longest arming window the firmware offers, so a message
    // that has not gone out in that time has had every chance the station could
    // give it. It stops trying and says so instead of waiting silently for ever.
    expireDeferred(nowMs) {
      const expired = [];
      for (const item of this.store.all()) {
        if (!isLiveDeferred(item)) continue;
        if (!item.expiresMs || Number(nowMs) < Number(item.expiresMs)) continue;
        item.state = STATE.ATTENTION;
        item.reason = "expired";
        expired.push(item);
        this._emit({type: "expired", id: item.id, to: item.to});
      }
      return expired;
    }

    noteDeferredAttempt(id, nowMs, {maxAttempts = 5} = {}) {
      const record = this.store.byId(id);
      if (!record) return null;
      record.attempts = (Number(record.attempts) || 0) + 1;
      record.lastTryMs = nowMs;
      if (record.attempts >= maxAttempts) {
        record.state = STATE.ATTENTION;
        record.reason = "no answer";
        this._emit({type: "gave-up", id: record.id, to: record.to});
      }
      return record;
    }

    // The recipient acknowledged: the message is theirs now, and the only real
    // proof of delivery this protocol can produce. The record goes.
    confirmDeferred(id) {
      const record = this.store.byId(id);
      if (!record || record.type !== TYPE.DEFERRED) return null;
      this.store.remove(id);
      this._emit({type: "delivered-deferred", id: record.id, to: record.to});
      return record;
    }

    // Parked at an intermediary (E4). Terminal for automation: its ACK proves
    // storage, never delivery, and further attempts would only make duplicates.
    handOffDeferred(id, via) {
      const record = this.store.byId(id);
      if (!record || record.type !== TYPE.DEFERRED) return null;
      record.state = STATE.HANDED;
      record.via = String(via || "").toUpperCase();
      this._emit({type: "handed", id: record.id, to: record.to, via: record.via});
      return record;
    }

    // --- operator actions ---------------------------------------------------

    markRead(id) {
      const record = this.store.byId(id);
      if (!record || record.type !== TYPE.UNREAD) return false;
      record.type = TYPE.READ;
      record.readMs = Date.now();
      this._emit({type: "read", id: record.id, from: record.from});
      return true;
    }

    // Deletion is undoable rather than confirmed: a dialog on every row is worse
    // than putting the record back. The removed record is returned whole so the
    // caller can hand it to restore().
    remove(id) {
      const record = this.store.remove(id);
      if (record) this._emit({type: "removed", id: record.id, recordType: record.type});
      return record;
    }

    // Keeps the original id, so an undo restores the row the operator deleted
    // rather than a copy of it -- ids are referenced by NEXT MSG ID on the air.
    restore(record) {
      if (!record || this.store.byId(record.id)) return null;
      this.store.items.push(record);
      this.store.nextId = Math.max(this.store.nextId, Number(record.id || 0) + 1);
      this._emit({type: "restored", id: record.id});
      return record;
    }

    // --- views --------------------------------------------------------------

    counts() {
      const items = this.store.all();
      const of = type => items.filter(item => item.type === type).length;
      return {
        unread: of(TYPE.UNREAD),
        read: of(TYPE.READ),
        held: of(TYPE.STORE),
        delivered: of(TYPE.DELIVERED),
        waiting: items.filter(isLiveDeferred).length,
        deferred: of(TYPE.DEFERRED),
        total: items.length,
        bytes: this.byteSize(),
      };
    }

    // FOR ME / WAITING / HELD are the three questions the operator actually has;
    // everything else is history and lives under ALL.
    items(filter = "all") {
      const all = this.store.all();
      switch (String(filter).toLowerCase()) {
        case "mine": return all.filter(item =>
          item.type === TYPE.UNREAD || item.type === TYPE.READ);
        case "waiting": return all.filter(item => item.type === TYPE.DEFERRED);
        case "held": return all.filter(item =>
          item.type === TYPE.STORE || item.type === TYPE.DELIVERED);
        default: return all;
      }
    }
  }

  return {Js8MsgBox, AttemptLedger, DEFAULTS, TYPE, STATE, EVICTION_ORDER,
    migrateRecord, parseMailAdvert, parseDeliveredMail};
});
