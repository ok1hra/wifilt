// Auto-reply restriction engine.
//
// With AUTO on, any station can make yours transmit just by asking. `AGN?` is
// the worst case: it asks you to repeat your whole last message, so a few
// characters of theirs cost you several frames of airtime. Upstream JS8Call only
// rate-limits heartbeat ACKs (55 min per callsign, HBBlockingDB); the query
// commands are unlimited, which is survivable for a desktop session and not for
// a station armed for a week.
//
// Two layers, decided in docs/js8call-neobsluhovany-provoz-plan.md (rule D):
//
//   Window, keyed by (callsign, question). A station may legitimately ask you
//   several different things in a row, so each pair has its own window. Asking
//   the SAME thing again inside its window is the offence -- and "the same thing"
//   is the ANSWER, not the wording: `HW CPY?`, `SNR?` and a bare `?` all ask for
//   one signal report, so js8-autoreply.js hands them all the same `windowKey`.
//
//   Penalty, keyed by CALLSIGN alone, doubling from one minute and decaying back
//   down the same curve. Per-command penalties would be defeated by simply
//   rotating through AGN?, SNR?, GRID?, INFO?, STATUS?, HEARING? -- six free
//   transmissions before anything triggered.
//
// Nothing here suppresses silently: every decision returns a reason, and every
// state change emits an event for the log (decision 13).

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8Restrictions = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  const MINUTE = 60000;

  const DEFAULTS = {
    windowMs: 5 * MINUTE,        // same station asking the same thing again
    qsoWindowMs: 1 * MINUTE,     // the station you are actually working
    heartbeatWindowMs: 55 * MINUTE, // matches upstream HBBlockingDB
    baseBanMs: 1 * MINUTE,       // 2^0
    maxLevel: 6,                 // 2^6 = 64 min ceiling
    hourlyCap: 120,              // global sanity bound, visible in the panel
  };

  const banMsForLevel = (level, baseBanMs) => baseBanMs * Math.pow(2, level);

  class Js8Restrictions {
    constructor(options = {}) {
      this.config = {...DEFAULTS, ...options};
      this.onEvent = options.onEvent || null;
      this.windows = new Map();  // "CALL CMD" -> last reply utcMs
      this.penalties = new Map(); // CALL -> {level, banUntilMs, decayAtMs}
      this.replyTimes = [];       // utcMs of granted replies, for the hourly cap
      this.stats = {granted: 0, windowed: 0, banned: 0, capped: 0, escalations: 0};
    }

    _emit(event) { if (this.onEvent) this.onEvent(event); }

    windowMsFor(command, isSelectedCall) {
      if (command === "HEARTBEAT") return this.config.heartbeatWindowMs;
      return isSelectedCall ? this.config.qsoWindowMs : this.config.windowMs;
    }

    // Penalty decays one level per ban-length of quiet, i.e. back down the same
    // curve it climbed. Called before every decision so the view is current.
    _decay(call, nowMs) {
      const penalty = this.penalties.get(call);
      if (!penalty || penalty.level < 0) return null;
      while (penalty.level >= 0 && nowMs >= penalty.decayAtMs) {
        penalty.level -= 1;
        if (penalty.level < 0) {
          this.penalties.delete(call);
          this._emit({type: "penalty-cleared", call, atMs: nowMs});
          return null;
        }
        penalty.decayAtMs += banMsForLevel(penalty.level, this.config.baseBanMs);
      }
      return penalty;
    }

    _escalate(call, nowMs, reason) {
      const existing = this.penalties.get(call);
      const level = existing ? Math.min(existing.level + 1, this.config.maxLevel) : 0;
      const banMs = banMsForLevel(level, this.config.baseBanMs);
      this.penalties.set(call, {level, banUntilMs: nowMs + banMs,
        decayAtMs: nowMs + banMs});
      this.stats.escalations += 1;
      this._emit({type: "penalty", call, level, banMs, reason, atMs: nowMs});
      return banMs;
    }

    _hourlyCount(nowMs) {
      const cutoff = nowMs - 3600000;
      while (this.replyTimes.length && this.replyTimes[0] < cutoff) this.replyTimes.shift();
      return this.replyTimes.length;
    }

    // Decide whether an auto reply may be sent. Never mutates on a refusal other
    // than to escalate, so a caller can ask twice without side effects.
    // `windowKey` is what the window is keyed by, `command` is what the log and
    // the refusal text name. They differ only where two commands have the same
    // answer -- "HW CPY?" and "SNR?" -- and then sharing the window is the point:
    // asking the same thing in two different words is still asking it twice.
    evaluate({call, command, nowMs, isSelectedCall = false, windowKey = command}) {
      if (!call || !command) return {allowed: false, reason: "invalid request"};

      // Heartbeat ACKs are throttled, not policed. A station beaconing on its
      // normal interval -- 15 min upstream, 60 min this station's default -- is not
      // misbehaving, so a repeat is simply suppressed -- upstream HBBlockingDB
      // does the same. It must never seed or escalate a penalty, and an unrelated
      // penalty from query abuse must not silence a heartbeat either; otherwise a
      // routine beacon poisons the callsign and its own ACKs then dry up.
      if (command === "HEARTBEAT") {
        const key = `${call} ${command}`;
        const last = this.windows.get(key);
        const windowMs = this.config.heartbeatWindowMs;
        if (last !== undefined && nowMs - last < windowMs) {
          this.stats.windowed += 1;
          return {allowed: false, reason: "window",
            detail: `${call} heartbeat inside ${Math.round(windowMs / MINUTE)} min`};
        }
        if (this._hourlyCount(nowMs) >= this.config.hourlyCap) {
          this.stats.capped += 1;
          return {allowed: false, reason: "hourly-cap",
            detail: `${this.config.hourlyCap} auto replies in the last hour`};
        }
        this.windows.set(key, nowMs);
        this.replyTimes.push(nowMs);
        this.stats.granted += 1;
        return {allowed: true, reason: "ok"};
      }

      const penalty = this._decay(call, nowMs);
      if (penalty && nowMs < penalty.banUntilMs) {
        // Asking again while banned is what doubles it.
        const banMs = this._escalate(call, nowMs, `repeat during ban (${command})`);
        this.stats.banned += 1;
        return {allowed: false, reason: "banned", level: this.penalties.get(call).level,
          retryInMs: banMs, detail: `${call} banned ${Math.round(banMs / MINUTE)} min`};
      }

      const key = `${call} ${windowKey}`;
      const last = this.windows.get(key);
      const windowMs = this.windowMsFor(command, isSelectedCall);
      if (last !== undefined && nowMs - last < windowMs) {
        const banMs = this._escalate(call, nowMs, `repeat ${command} inside window`);
        this.stats.windowed += 1;
        return {allowed: false, reason: "window", level: this.penalties.get(call).level,
          retryInMs: banMs, detail: `${call} repeated ${command} inside ${Math.round(windowMs / MINUTE)} min`};
      }

      if (this._hourlyCount(nowMs) >= this.config.hourlyCap) {
        this.stats.capped += 1;
        return {allowed: false, reason: "hourly-cap",
          detail: `${this.config.hourlyCap} auto replies in the last hour`};
      }

      this.windows.set(key, nowMs);
      this.replyTimes.push(nowMs);
      this.stats.granted += 1;
      return {allowed: true, reason: "ok"};
    }

    // For the status panel: who is currently restricted and for how long.
    activeBans(nowMs) {
      const out = [];
      for (const call of [...this.penalties.keys()]) {
        const penalty = this._decay(call, nowMs);
        if (penalty && nowMs < penalty.banUntilMs)
          out.push({call, level: penalty.level, remainingMs: penalty.banUntilMs - nowMs});
      }
      return out.sort((a, b) => b.remainingMs - a.remainingMs);
    }

    snapshot(nowMs) {
      return {...this.stats, hourly: this._hourlyCount(nowMs),
        hourlyCap: this.config.hourlyCap, bans: this.activeBans(nowMs)};
    }

    // Forget everything about one station, e.g. after the operator clears it.
    forget(call) {
      this.penalties.delete(call);
      for (const key of [...this.windows.keys()])
        if (key.startsWith(`${call} `)) this.windows.delete(key);
    }
  }

  return {Js8Restrictions, DEFAULTS, banMsForLevel};
});
