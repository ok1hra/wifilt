// Station history: which stations are heard EVERY time this station listens, not just now.
//
// The route list under the Message field is built from the last hour of traffic, and inside
// one hour a station that happens to be loud right now looks exactly as good as one that is
// on the band every single evening. For store-and-forward the second one is what matters: the
// addressee picks the mail up later, so the intermediary has to still be there later.
//
// So this layer keeps, per band and per UTC day, three 24-bit hour masks and a number:
//
//   l   hours I was listening on the band               (the denominator)
//   h   hours a station was decoded here                (direct decodes only)
//   s   that station's best SNR of the day
//   m   whether that station showed it copies ME that day (edge 1 of the route triangle)
//   p   whether a pair of remote stations proved, that day, that one copies the other
//
// Every write is a bitwise OR or a max. That is the property everything else rests on: the
// decoder snapshot is re-delivered, a restored session replays old messages, two tabs record
// the same band -- none of it can double-count, and merging two copies of the store is the
// same OR again. There are no counters here on purpose.
//
// It never touches the DOM and takes its storage injected, like the other js8-* engines, so
// the whole of it runs under Node in tools/js8-station-history-smoke.js.

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.Js8StationHistory = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {

  const STORAGE_KEY = "js8-station-history-v1";
  const DAY_MS = 86400000;
  const HOUR_MS = 3600000;
  // Four weeks: long enough that one good evening is outvoted by a month of evenings, short
  // enough that a station which moved or went QRT stops being recommended within weeks.
  const WINDOW_DAYS = 28;
  // A day two weeks old counts half. Propagation follows the season; last month's habit is a
  // hint, this week's is evidence.
  const HALF_LIFE_DAYS = 14;
  // The day-consistency ratio is shrunk towards zero by this many phantom listening days, so
  // "heard on the only day I ever listened" scores a third, not a hundred.
  const SHRINK_DAYS = 2;
  // Below this many listening days on the band the numbers are shown but do not reorder the
  // route list: two evenings are an anecdote.
  const CONFIDENT_DAYS = 3;
  // An hour counts as listened once the decoder ran for this long inside it. A decode inside
  // the hour counts it immediately (heard implies listened).
  const LISTEN_MINUTES_PER_HOUR = 10;
  const MAX_STATIONS_PER_BAND = 400;
  const MAX_PAIRS_PER_BAND = 2000;
  // JS8 decodes down to about -24 dB; -6 dB and better is a comfortable path in any speed.
  const SNR_FLOOR = -24, SNR_SPAN = 18;

  const dayOf = ms => Math.floor(Number(ms) / DAY_MS);
  const hourBit = ms => 1 << new Date(Number(ms)).getUTCHours();
  const popcount = mask => { let value = mask >>> 0, count = 0; while (value) { value &= value - 1; count++; } return count; };
  const weightOf = (today, day) => Math.pow(0.5, (today - day) / HALF_LIFE_DAYS);
  const clamp01 = value => Math.max(0, Math.min(1, value));
  const snrQuality = snr => (snr === null || snr === undefined || !Number.isFinite(Number(snr)))
    ? null : clamp01((Number(snr) - SNR_FLOOR) / SNR_SPAN);
  const callKey = call => String(call || "").trim().toUpperCase();

  function emptyData() { return {v: 1, resetAt: 0, bands: {}}; }
  function emptyBand() { return {l: {}, s: {}, p: {}}; }

  // A store read back from somebody else's browser storage is untrusted shape-wise: anything
  // that is not the expected nesting is dropped rather than allowed to throw later.
  function sanitize(raw) {
    const out = emptyData();
    if (!raw || typeof raw !== "object" || raw.v !== 1) return out;
    out.resetAt = Number(raw.resetAt) || 0;
    for (const [band, data] of Object.entries(raw.bands || {})) {
      if (!data || typeof data !== "object") continue;
      const target = out.bands[band] = emptyBand();
      for (const [day, mask] of Object.entries(data.l || {}))
        if (Number.isInteger(Number(day))) target.l[day] = Number(mask) >>> 0;
      for (const [call, days] of Object.entries(data.s || {})) {
        if (!days || typeof days !== "object") continue;
        const entry = target.s[call] = {};
        for (const [day, rec] of Object.entries(days)) {
          if (!Array.isArray(rec) || !Number.isInteger(Number(day))) continue;
          const snr = rec[1] === null || rec[1] === undefined ? null : Number(rec[1]);
          entry[day] = [Number(rec[0]) >>> 0, Number.isFinite(snr) ? snr : null, rec[2] ? 1 : 0];
        }
      }
      for (const [pair, days] of Object.entries(data.p || {})) {
        if (!days || typeof days !== "object" || pair.indexOf(">") < 1) continue;
        const entry = target.p[pair] = {};
        for (const day of Object.keys(days)) if (Number.isInteger(Number(day))) entry[day] = 1;
      }
    }
    return out;
  }

  // OR one store into another. Idempotent and commutative, which is why two tabs can each
  // save without locking: whatever order the writes land in, the union is the same.
  function mergeInto(into, from) {
    for (const [band, data] of Object.entries(from.bands)) {
      const target = into.bands[band] || (into.bands[band] = emptyBand());
      for (const [day, mask] of Object.entries(data.l)) target.l[day] = ((target.l[day] || 0) | mask) >>> 0;
      for (const [call, days] of Object.entries(data.s)) {
        const entry = target.s[call] || (target.s[call] = {});
        for (const [day, rec] of Object.entries(days)) {
          const have = entry[day];
          if (!have) { entry[day] = rec.slice(); continue; }
          have[0] = (have[0] | rec[0]) >>> 0;
          if (rec[1] !== null && (have[1] === null || rec[1] > have[1])) have[1] = rec[1];
          have[2] = have[2] || rec[2] ? 1 : 0;
        }
      }
      for (const [pair, days] of Object.entries(data.p)) {
        const entry = target.p[pair] || (target.p[pair] = {});
        for (const day of Object.keys(days)) entry[day] = 1;
      }
    }
    return into;
  }

  function newestDay(days) {
    let best = -Infinity;
    for (const day of Object.keys(days)) best = Math.max(best, Number(day));
    return best;
  }

  // Old days out, then the least recently heard stations and pairs out once over the cap.
  function prune(data, nowMs) {
    const oldest = dayOf(nowMs) - WINDOW_DAYS + 1;
    for (const [band, target] of Object.entries(data.bands)) {
      for (const day of Object.keys(target.l)) if (Number(day) < oldest) delete target.l[day];
      for (const table of [target.s, target.p]) {
        for (const [key, days] of Object.entries(table)) {
          for (const day of Object.keys(days)) if (Number(day) < oldest) delete days[day];
          if (!Object.keys(days).length) delete table[key];
        }
      }
      for (const [table, cap] of [[target.s, MAX_STATIONS_PER_BAND], [target.p, MAX_PAIRS_PER_BAND]]) {
        const keys = Object.keys(table);
        if (keys.length <= cap) continue;
        keys.sort((left, right) => newestDay(table[right]) - newestDay(table[left]));
        for (const key of keys.slice(cap)) delete table[key];
      }
      if (!Object.keys(target.l).length && !Object.keys(target.s).length && !Object.keys(target.p).length)
        delete data.bands[band];
    }
    return data;
  }

  function readStorage(storage) {
    if (!storage) return emptyData();
    try { return sanitize(JSON.parse(storage.getItem(STORAGE_KEY) || "null")); }
    catch (_error) { return emptyData(); }
  }

  class StationHistory {
    constructor({storage = null} = {}) {
      this.storage = storage;
      this.data = readStorage(storage);
      // Minutes of listening per "band|day|hour", kept in memory only: a minute count cannot
      // be merged across tabs, the hour bit it eventually sets can.
      this.minutes = new Map();
      this.dirty = false;
    }

    band(name, create = true) {
      if (!name) return null;
      return this.data.bands[name] || (create ? (this.data.bands[name] = emptyBand()) : null);
    }

    markListened(target, atMs) {
      const day = dayOf(atMs), bit = hourBit(atMs);
      if (((target.l[day] || 0) & bit) === 0) { target.l[day] = ((target.l[day] || 0) | bit) >>> 0; this.dirty = true; }
    }

    // One call per minute while the decoder runs on RX. The hour is credited once enough
    // minutes inside it have been spent listening.
    noteListening(band, nowMs) {
      const target = this.band(band);
      if (!target) return;
      const key = `${band}|${dayOf(nowMs)}|${new Date(nowMs).getUTCHours()}`;
      const minutes = (this.minutes.get(key) || 0) + 1;
      this.minutes.set(key, minutes);
      if (this.minutes.size > 64) this.minutes.delete(this.minutes.keys().next().value);
      if (minutes >= LISTEN_MINUTES_PER_HOUR) this.markListened(target, nowMs);
    }

    noteHeard(band, call, snr, atMs) {
      const key = callKey(call), target = this.band(band);
      if (!key || !target || !(Number(atMs) > 0)) return;
      this.markListened(target, atMs);
      const day = dayOf(atMs), bit = hourBit(atMs);
      const entry = target.s[key] || (target.s[key] = {});
      const rec = entry[day] || (entry[day] = [0, null, 0]);
      const value = snr === null || snr === undefined || snr === "" ? null : Number(snr);
      if ((rec[0] & bit) === 0) { rec[0] = (rec[0] | bit) >>> 0; this.dirty = true; }
      if (Number.isFinite(value) && (rec[1] === null || value > rec[1])) { rec[1] = value; this.dirty = true; }
    }

    noteHearsMe(band, call, atMs) {
      const key = callKey(call), target = this.band(band);
      if (!key || !target || !(Number(atMs) > 0)) return;
      const day = dayOf(atMs);
      const entry = target.s[key] || (target.s[key] = {});
      const rec = entry[day] || (entry[day] = [0, null, 0]);
      if (!rec[2]) { rec[2] = 1; this.dirty = true; }
    }

    // `heard` was copied by `listener`, the same orientation as hearingLinks().
    noteLink(band, heard, listener, atMs) {
      const from = callKey(heard), to = callKey(listener), target = this.band(band);
      if (!from || !to || from === to || !target || !(Number(atMs) > 0)) return;
      const pair = `${from}>${to}`, day = dayOf(atMs);
      const entry = target.p[pair] || (target.p[pair] = {});
      if (!entry[day]) { entry[day] = 1; this.dirty = true; }
    }

    // Read-merge-write: whatever another tab saved meanwhile is folded in rather than
    // overwritten. A reset done elsewhere (newer resetAt) wins over this tab's memory.
    save(nowMs = Date.now()) {
      if (!this.storage) { prune(this.data, nowMs); this.dirty = false; return true; }
      const stored = readStorage(this.storage);
      if (stored.resetAt > this.data.resetAt) { this.data = stored; }
      else { stored.resetAt = this.data.resetAt; this.data = mergeInto(stored, this.data); }
      prune(this.data, nowMs);
      this.dirty = false;
      try { this.storage.setItem(STORAGE_KEY, JSON.stringify(this.data)); return true; }
      catch (_error) {
        // Quota: drop the pairs (the bulkiest table, and the least important) and retry once.
        for (const target of Object.values(this.data.bands)) target.p = {};
        try { this.storage.setItem(STORAGE_KEY, JSON.stringify(this.data)); return true; }
        catch (_again) { return false; }
      }
    }

    reset(nowMs = Date.now()) {
      this.data = emptyData();
      this.data.resetAt = nowMs;
      this.minutes.clear();
      this.dirty = false;
      if (this.storage) try { this.storage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch (_error) {}
    }

    stats() {
      let stations = 0, bands = 0;
      for (const target of Object.values(this.data.bands)) { bands++; stations += Object.keys(target.s).length; }
      let bytes = 0;
      try { bytes = JSON.stringify(this.data).length; } catch (_error) {}
      return {bands, stations, bytes};
    }

    // Listening days inside the window, newest first, with their weights.
    listening(band, nowMs) {
      const target = this.band(band, false), today = dayOf(nowMs);
      const days = [];
      if (!target) return days;
      for (const [day, mask] of Object.entries(target.l)) {
        const index = Number(day);
        if (!mask || index > today || index <= today - WINDOW_DAYS) continue;
        days.push({day: index, l: mask, w: weightOf(today, index)});
      }
      return days.sort((left, right) => right.day - left.day);
    }

    confident(band, nowMs) { return this.listening(band, nowMs).length >= CONFIDENT_DAYS; }

    stationScore(band, call, nowMs) {
      const days = this.listening(band, nowMs);
      const target = this.band(band, false);
      const entry = (target && target.s[callKey(call)]) || {};
      let wListen = 0, wHeard = 0, wHoursListened = 0, wHoursHeard = 0, wMe = 0, heardDays = 0, meDays = 0;
      const best = [];
      for (const {day, l, w} of days) {
        wListen += w;
        wHoursListened += w * popcount(l);
        const rec = entry[day];
        if (!rec || !rec[0]) continue;
        heardDays++; wHeard += w;
        wHoursHeard += w * popcount(rec[0] & l);
        if (rec[2]) { wMe += w; meDays++; }
        if (rec[1] !== null) best.push(rec[1]);
      }
      best.sort((left, right) => left - right);
      const median = best.length ? best[Math.floor(best.length / 2)] : null;
      const D = wListen ? wHeard / (wListen + SHRINK_DAYS) : 0;
      // The hour share gets the same phantom days, each worth an average listening day, or a
      // single evening heard throughout would still hand out the whole of P.
      const P = wHoursListened
        ? wHoursHeard / (wHoursListened + SHRINK_DAYS * wHoursListened / wListen) : 0;
      const M = wHeard ? wMe / wHeard : 0;
      const S = snrQuality(median) || 0;
      return {score: Math.round(100 * (0.40 * D + 0.25 * P + 0.20 * M + 0.15 * S)),
        D, P, M, S, typicalSnr: median, listenDays: days.length, heardDays, meDays,
        confident: days.length >= CONFIDENT_DAYS};
    }

    // Days on which either direction of the pair was proved, against my listening days.
    pairScore(band, first, second, nowMs) {
      const target = this.band(band, false);
      const a = callKey(first), b = callKey(second);
      const one = (target && target.p[`${a}>${b}`]) || {}, two = (target && target.p[`${b}>${a}`]) || {};
      const days = this.listening(band, nowMs);
      let wListen = 0, wPair = 0, pairDays = 0;
      for (const {day, w} of days) {
        wListen += w;
        if (one[day] || two[day]) { wPair += w; pairDays++; }
      }
      return {pair: wListen ? wPair / (wListen + SHRINK_DAYS) : 0, pairDays, listenDays: days.length};
    }

    // route = 60 % how reliably the intermediary is here, 25 % how often it has been seen
    // copying (or copied by) the target, 15 % what the path looks like right now.
    routeScore(band, via, target, freshSnr, nowMs) {
      const station = this.stationScore(band, via, nowMs);
      const pair = this.pairScore(band, via, target, nowMs);
      const freshQ = snrQuality(freshSnr);
      const fresh = freshQ === null ? 0.5 : freshQ;
      return {route: Math.round(0.60 * station.score + 25 * pair.pair + 15 * fresh),
        station, pair, fresh, confident: station.confident};
    }

    // Seven days ending today, oldest first. `ratio` is null on a day I did not listen at
    // all: that is "no data", not "not heard", and the bar must say so.
    weekBars(band, call, nowMs) {
      const target = this.band(band, false), today = dayOf(nowMs);
      const entry = (target && target.s[callKey(call)]) || {};
      const bars = [];
      for (let day = today - 6; day <= today; day++) {
        const l = (target && target.l[day]) || 0;
        const rec = entry[day] || [0, null, 0];
        const listened = popcount(l), heard = popcount(rec[0] & l);
        bars.push({day, listened, heard, ratio: listened ? heard / listened : null,
          best: rec[0] ? rec[1] : null, hearsMe: Boolean(rec[2])});
      }
      return bars;
    }
  }

  return {StationHistory, STORAGE_KEY, WINDOW_DAYS, CONFIDENT_DAYS, LISTEN_MINUTES_PER_HOUR,
    dayOf, popcount, sanitize, mergeInto, prune};
});
