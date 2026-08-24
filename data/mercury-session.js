// Mercury's own session lease (docs/mercury-implementace.md §4.2/§7, decision
// 5 as refined 2026-08-22): a SEPARATE token/URL from JS8LAN/WSPR's shared
// js8lan.session, but the exact same firmware record and exclusivity model --
// AudioHandleWsUpgrade checks ownership in exactly one place
// (js8SessionOwns(js8Session, ...)), and /mercury/session/* are thin aliases
// onto the same handlers /js8/session/* already uses. This file is the
// browser-side mirror of data.js's own acquireJs8Session/pingJs8Session/
// releaseJs8Session (lines ~7376-7539) -- same BroadcastChannel-tiebreak
// design for a duplicated tab, same "only an explicit 409 is a refusal"
// contract -- pointed at Mercury's own token key, channel name and endpoints,
// plus the two things only Mercury needs: reading mercuryName/Percent/
// RemainingMs out of a refusal (the takeover dialog, §6.3) and a purely
// local "armed" flag (§6.4 -- LISTEN is only meaningful armed, and unlike the
// lease this is never sent to the firmware: Mercury's ARQ FSM runs in this
// tab's Worker, not on the ESP32, so "armed" just means "this tab's pump
// auto-accepts an incoming CALL" and dies with the tab like any other
// in-memory state).
//
// Status: this module is real and tested standalone (tools/
// mercury-session-browser-smoke.js, 16/16 checks against a fixture that
// mirrors the real firmware's 200/409 contract, verified against the actual
// production handler via curl separately). It is deliberately NOT yet loaded
// by mercury.html/wired into mercury.js: claiming the lease and showing
// ARMED/LISTENING before the CALL/LISTEN Worker pump exists behind it would
// present state that does nothing, the same half-truth this codebase's UI
// conventions refuse everywhere else (see mercury.js's own header comment).
(function () {
  const SESSION_TOKEN_KEY = "mercury.session.token.v1";
  const ARMED_KEY = "mercury.session.armed.v1";
  const SESSION_PING_MS = 5000, SESSION_RETRY_MS = 3000, SESSION_PROBE_MS = 250;

  function store() { try { return globalThis.sessionStorage; } catch (_error) { return null; } }
  function localStore() { try { return globalThis.localStorage; } catch (_error) { return null; } }

  function makeToken() {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  let tokenCache = null;
  function token() {
    if (tokenCache) return tokenCache;
    const s = store();
    let t = s && s.getItem(SESSION_TOKEN_KEY);
    if (!t) { t = makeToken(); if (s) { try { s.setItem(SESSION_TOKEN_KEY, t); } catch (_error) { /* private mode */ } } }
    tokenCache = t;
    return t;
  }

  const pageId = makeToken();
  const channel = (() => { try { return new BroadcastChannel("mercury.session"); } catch (_error) { return null; } })();

  let held = false, confirmed = false, since = 0, localHolder = null;
  let pingTimer = null, retryTimer = null;
  let grantedCb = null, busyCb = null, lostCb = null;
  // Defaults to NOT ARMED (unattended answering is opt-in, same convention
  // as WSPR's own TX pledge) -- reverted 2026-08-23 once the waterfall
  // stopped depending on this flag (mercury.js's ambient "monitor" worker
  // now feeds it regardless of armed state, so the earlier "defaults to
  // ARMED" fix for an empty waterfall no longer applies). A missing key is
  // "never touched this control", treated as the default; an explicit "1"
  // is a deliberate opt-in and stays respected forever after, same as an
  // explicit "0" always was.
  let armed = (() => { const s = localStore(); const v = s && s.getItem(ARMED_KEY); return v === null || v === undefined ? false : v === "1"; })();
  let armedCb = null;

  if (channel) channel.onmessage = (event) => {
    const message = event.data || {};
    if (message.id === pageId) return;
    if (message.type === "probe" && held) channel.postMessage({ type: "held", id: pageId, since });
    if (message.type === "held") localHolder = { id: message.id, since: Number(message.since) || 0 };
    if (message.type === "released" && !held) scheduleRetry(200);
    if (message.type === "evict" && held) yieldSession({ lost: true });
  };

  function probeLocalHolder() {
    if (!channel) return Promise.resolve(null);
    localHolder = null;
    channel.postMessage({ type: "probe", id: pageId });
    return new Promise(resolve => setTimeout(() => resolve(localHolder), SESSION_PROBE_MS));
  }

  function localHolderOutranks(holder) {
    if (!holder) return false;
    if (holder.since !== since) return holder.since < since;
    return holder.id < pageId;
  }

  // Only an explicit 409 is a refusal -- a firmware without the lock, or a
  // fetch that simply failed (radio rebooting, LAN blip), must never leave
  // the operator staring at a takeover panel with no way back in.
  async function post(path, extra) {
    try {
      const response = await fetch(path, {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token(), ...extra }),
      });
      if (response.status !== 409) return { granted: true };
      const info = await response.json().catch(() => ({}));
      return {
        granted: false, owner: info.owner || "", ageMs: Number(info.ageMs) || 0,
        mercuryName: info.mercuryName || "", mercuryPercent: Number(info.mercuryPercent) || 0,
        mercuryRemainingMs: Number(info.mercuryRemainingMs) || 0,
      };
    } catch (_error) { return { granted: true }; }
  }

  function markHeld(isForced) {
    held = true; confirmed = isForced; since = Date.now();
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (!pingTimer) pingTimer = setInterval(ping, SESSION_PING_MS);
  }

  function yieldSession(info) {
    held = false; confirmed = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (busyCb) busyCb(info);
    if (info.lost && lostCb) lostCb(info);
    scheduleRetry(SESSION_RETRY_MS);
  }

  function scheduleRetry(delayMs) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(retry, delayMs);
  }

  async function retry() {
    retryTimer = null;
    if (await probeLocalHolder()) { scheduleRetry(SESSION_RETRY_MS); return; }
    const result = await claim(false);
    if (!result) return; // claim() already called busyCb on refusal
  }

  // Returns true once granted (and, for an unforced claim, once the local
  // duplicate-tab probe has also cleared) -- false on an explicit refusal.
  async function claim(force = false, progress = null) {
    if (force && channel) channel.postMessage({ type: "evict", id: pageId });
    const body = progress
      ? { force, mercuryName: progress.name, mercuryPercent: progress.percent, mercuryRemainingMs: progress.remainingMs }
      : { force };
    const result = await post("/mercury/session/claim", body);
    if (!result.granted) { if (busyCb) busyCb(result); return false; }
    markHeld(force);
    if (!force) {
      const holder = await probeLocalHolder();
      if (!held) return false; // yielded while the probe was in flight
      if (localHolderOutranks(holder)) { yieldSession({ local: true }); return false; }
    }
    confirmed = true;
    if (grantedCb) grantedCb();
    return true;
  }

  async function ping(progress = null) {
    if (!held) return;
    const body = progress
      ? { mercuryName: progress.name, mercuryPercent: progress.percent, mercuryRemainingMs: progress.remainingMs }
      : {};
    const result = await post("/mercury/session/ping", body);
    if (!result.granted) yieldSession({ ...result, lost: true });
  }

  function release() {
    if (!held) return;
    held = false; confirmed = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (channel) channel.postMessage({ type: "released", id: pageId });
    const body = JSON.stringify({ token: token() });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon("/mercury/session/release", new Blob([body], { type: "application/json" }))) return;
    } catch (_error) { /* fall through */ }
    try { fetch("/mercury/session/release", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }); } catch (_error) { /* leaving anyway */ }
  }

  function setArmed(value) {
    armed = Boolean(value);
    const s = localStore();
    if (s) { try { s.setItem(ARMED_KEY, armed ? "1" : "0"); } catch (_error) { /* private mode */ } }
    if (armedCb) armedCb(armed);
  }

  const MercurySession = {
    claim, ping, release,
    token, // the AUD1 WebSocket's ?token= is this same session token (AudioHandleWsUpgrade checks ownership via js8SessionOwns), so whatever holds the lease needs it to open the socket
    isHeld: () => held,
    isConfirmed: () => confirmed,
    isArmed: () => armed,
    setArmed,
    onGranted(cb) { grantedCb = cb; },
    onBusy(cb) { busyCb = cb; },      // cb(info): {owner, ageMs, mercuryName, mercuryPercent, mercuryRemainingMs, local?, lost?}
    onLost(cb) { lostCb = cb; },      // fires in addition to onBusy when the lease was actively taken away
    onArmedChange(cb) { armedCb = cb; },
  };

  if (typeof module === "object" && module.exports) module.exports = { MercurySession };
  else globalThis.MercurySession = MercurySession;
})();
