// WATCH, the holder's half: hand the binary what this page shows, so other
// browsers can follow it on /watch.html (watch_hub.h). Nothing here decodes or
// transmits; a page passes a function that describes its own screen, and this
// sends the result when it changed, at most every `intervalMs`.
//
// Quiet unless the binary says WATCH is on (/health.json "watch", the PC build
// only) -- on the box this costs one /health.json read a minute and nothing
// else. Only the session holder may publish (POST /watch/snapshot checks the
// token), so a page that lost the radio goes quiet on the 409.
//
//   const publisher = WatchPublish.create({role: "wspr", token: () => sessionToken()});
//   publisher.publish(() => ({spots: state.rxSpots.slice(0, 500)}));

(function (root, factory) {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  else root.WatchPublish = value;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  const HEALTH_RECHECK_MS = 60000;
  const FETCH_TIMEOUT_MS = 5000;
  const BUSY_PAUSE_MS = 10000;
  // An unchanged screen is still re-sent this often, so a restarted binary --
  // which forgot every snapshot -- gets this page's state back.
  const REFRESH_MS = 60000;
  // watch_hub.h WATCH_SNAPSHOT_MAX: the binary buffers a request body in a String
  // with a 16-bit length. The pages bound what they describe to stay well under.
  const MAX_BODY_BYTES = 60 * 1024;

  // Fetch with a deadline: a hung request must not hold one of the browser's
  // few connections to this origin (the OFFLINE wedge).
  function timedFetch(fetchImpl, url, options) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
    return fetchImpl(url, {...options, signal: controller ? controller.signal : undefined})
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  // One /health.json read shared by every publisher on the page.
  let health = {checkedMs: -Infinity, on: false, pending: null};
  function watchOn(fetchImpl, nowMs) {
    if (health.pending) return health.pending;
    if (nowMs - health.checkedMs < HEALTH_RECHECK_MS) return Promise.resolve(health.on);
    health.pending = timedFetch(fetchImpl, "/health.json", {cache: "no-store"})
      .then(response => response.ok ? response.json() : null)
      .then(body => Boolean(body && body.watch && body.watch.on))
      .catch(() => false)
      .then(on => { health = {checkedMs: nowMs, on, pending: null}; return on; });
    return health.pending;
  }

  function create({role, token, intervalMs = 2000, fetchImpl, now = () => Date.now()}) {
    const fetcher = fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    let describe = null, lastSent = "", lastSentMs = 0, timer = null, inFlight = false, pausedUntil = 0;
    let tooBigWarned = false;

    async function flush() {
      timer = null;
      if (!describe || inFlight || !fetcher) return;
      const nowMs = now();
      // Lost the radio: the next render after the pause tries again.
      if (nowMs < pausedUntil) return;
      if (!(await watchOn(fetcher, nowMs))) return;
      let body;
      try { body = JSON.stringify(describe()); } catch (error) { console.error("[watch] describe", error); return; }
      if (!body || (body === lastSent && nowMs - lastSentMs < REFRESH_MS)) return;
      if (body.length > MAX_BODY_BYTES) {
        if (!tooBigWarned) console.warn(`[watch] ${role} snapshot ${body.length} B is over ${MAX_BODY_BYTES} B, not sent`);
        tooBigWarned = true;
        return;
      }
      const sessionToken = token();
      if (!sessionToken) return;
      inFlight = true;
      try {
        const response = await timedFetch(fetcher,
          `/watch/snapshot?role=${encodeURIComponent(role)}&token=${encodeURIComponent(sessionToken)}`,
          {method: "POST", headers: {"Content-Type": "application/json"}, body});
        if (response.ok) { lastSent = body; lastSentMs = now(); }
        else if (response.status === 404) health = {checkedMs: now(), on: false, pending: null};
        else if (response.status === 409) pausedUntil = now() + BUSY_PAUSE_MS;
      } catch (_error) {
        // Offline or timed out: the next change tries again.
      } finally {
        inFlight = false;
      }
    }

    function schedule(delayMs) {
      if (!timer) timer = setTimeout(flush, Math.max(0, delayMs));
    }

    return {
      // `describeFn` is called when the send is due, not now, so a page may call
      // this on every render without paying for the serialization each time.
      publish(describeFn) {
        describe = describeFn;
        schedule(intervalMs);
      },
      // A new holder session (reload, takeover regained): send even if unchanged.
      reset() { lastSent = ""; pausedUntil = 0; },
    };
  }

  return {create};
});
