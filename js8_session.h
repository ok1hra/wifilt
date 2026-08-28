#pragma once

// Single-operator lock for the JS8LAN page: shared by the firmware sketch and
// the native regression tests, so the rules are exercised without a radio.
//
// Why the firmware owns it. The page drives one radio through one AUD1
// WebSocket, so two pages open at once is never a working configuration --
// AudioHandleWsUpgrade already disconnects the previous client, which means a
// second tab silently steals audio from the first and neither operator is told.
// A browser-side lock (localStorage, BroadcastChannel) only ever sees tabs in
// one browser; the second computer is exactly the case that has to be caught.
// So the ESP32 keeps the authoritative record and the browser only renders it.
//
// Lease, not a flag. A crashed tab, a closed laptop lid or a dropped Wi-Fi link
// cannot send a release, so ownership expires on its own: the holder refreshes
// it while it lives, and JS8_SESSION_LEASE_MS after the last sign of life the
// lock is free again. AUD1 traffic refreshes it too, so a page that is actually
// running audio never depends on the HTTP heartbeat alone.
//
// Takeover is deliberate and always available. Refusing it would leave a
// forgotten tab on another machine holding the radio with no remedy but a
// power cycle, so a claim with force wins and the old holder learns it lost on
// its next heartbeat.
//
// All deadlines use millis(); comparisons are wrap-safe via signed differences,
// matching the rest of the sketch.

#include <stdint.h>
#include <string.h>

// 15 s tolerates a Wi-Fi stall or a stop-the-world GC in the tab (heartbeat is
// 5 s, so two may be lost) while still freeing a dead session quickly enough
// that the operator moving to another machine does not think it is stuck.
static const uint32_t JS8_SESSION_LEASE_MS = 15000;
// 128 bits of getRandomValues as hex. The sketch links with single-digit bytes
// of DRAM to spare, so this record is kept as narrow as the job allows: the
// owner address is a packed v4 rather than a string, and the counters are 16-bit
// because they exist to be read by a human, not to run up.
static const uint8_t JS8_SESSION_TOKEN_MAX = 32;

enum Js8SessionResult : uint8_t {
  JS8_SESSION_GRANTED = 0,   // lock was free (or expired) and is now held
  JS8_SESSION_RENEWED,       // caller already held it -- reload, page return
  JS8_SESSION_TAKEOVER,      // forced away from a live holder
  JS8_SESSION_BUSY,          // someone else holds a live lease
  JS8_SESSION_BAD_TOKEN,     // malformed or missing token
};

struct Js8Session {
  char     token[JS8_SESSION_TOKEN_MAX + 1] = {0};
  uint32_t ownerIpV4 = 0;          // shown to the locked-out page, not trusted
  uint32_t lastSeenMs = 0;         // millis() of the last claim/heartbeat
  uint16_t takeovers = 0;          // counters feed the diagnostics panel
  uint16_t refusals = 0;
  bool     held = false;           // a token was installed (may have expired)
  // Which UI is holding the lock -- "js8" / "rtty" / "wspr" / "mercury", empty
  // if the claimer didn't say (older client, or a role this build doesn't
  // know about). QRPLOG (log.js) reads this from /js8/session to decide how a
  // USB-D/LSB-D QSO gets tagged and whether it may key through the holder's
  // page at all -- it is not itself a party to the lock, just a reader.
  char     role[8] = {0};
  // Mercury transfer progress (docs/mercury-implementace.md decision 5 + §6.3/§7).
  // Mercury shares this same lock/token -- there is only one AUD1 owner, checked
  // in exactly one place (AudioHandleWsUpgrade) -- so "its own lease" means its
  // own URL (/mercury/session/*) and its own busy-dialog wording, not a second
  // record. These three fields are what make that wording possible: a page
  // locked out while a transfer is running reads "Mercury transfer foto.jpg,
  // 43% done" instead of the generic "radio is driven from somewhere else".
  // Set via the claim/ping body; mercuryName[0]==0 means "not a transfer" (the
  // generic text applies) -- see js8SessionSetMercuryProgress below.
  char     mercuryName[24] = {0};      // filename, truncated; operator-facing only
  uint8_t  mercuryPercent = 0;         // 0..100
  uint32_t mercuryRemainingMs = 0;     // estimated time left, as last reported
};

// Tokens are echoed into JSON and compared byte for byte, so anything outside
// the UUID alphabet is rejected rather than escaped.
inline bool js8SessionTokenValid(const char *token) {
  if (!token) return false;
  size_t length = strlen(token);
  if (length < 8 || length > JS8_SESSION_TOKEN_MAX) return false;
  for (size_t index = 0; index < length; ++index) {
    const char c = token[index];
    const bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
                    (c >= 'A' && c <= 'F') || c == '-';
    if (!ok) return false;
  }
  return true;
}

inline bool js8SessionLive(const Js8Session &session, uint32_t nowMs) {
  if (!session.held) return false;
  return (int32_t)(nowMs - session.lastSeenMs) < (int32_t)JS8_SESSION_LEASE_MS;
}

inline bool js8SessionOwns(const Js8Session &session, uint32_t nowMs, const char *token) {
  if (!js8SessionLive(session, nowMs) || !token) return false;
  return strcmp(session.token, token) == 0;
}

inline uint32_t js8SessionAgeMs(const Js8Session &session, uint32_t nowMs) {
  if (!session.held) return 0;
  return (uint32_t)(nowMs - session.lastSeenMs);
}

// Not operator-facing: a stale filename left over from whoever held the lock
// before must never be shown against a new holder that has not said anything
// about a transfer yet.
inline void js8SessionClearMercuryProgress(Js8Session &session) {
  session.mercuryName[0] = 0;
  session.mercuryPercent = 0;
  session.mercuryRemainingMs = 0;
}

// Called from the claim/ping handler when the request body carries transfer
// fields. Silently does nothing on a malformed name -- the caller already
// owns the lock at that point, so there is nothing to refuse, only nothing to
// show.
inline void js8SessionSetMercuryProgress(Js8Session &session, const char *name,
                                         int percent, uint32_t remainingMs) {
  if (!name) return;
  strncpy(session.mercuryName, name, sizeof(session.mercuryName) - 1);
  session.mercuryName[sizeof(session.mercuryName) - 1] = 0;
  // Clamp on the wide `int` BEFORE narrowing to uint8_t -- narrowing first
  // (e.g. a caller passing (uint8_t)percent) wraps any percent >= 256 mod
  // 256, which this clamp would then no longer see as out of range.
  session.mercuryPercent = (uint8_t)(percent < 0 ? 0 : (percent > 100 ? 100 : percent));
  session.mercuryRemainingMs = remainingMs;
}

inline void js8SessionClear(Js8Session &session) {
  session.token[0] = 0;
  session.ownerIpV4 = 0;
  session.held = false;
  session.lastSeenMs = 0;
  session.role[0] = 0;
  js8SessionClearMercuryProgress(session);
}

// role defaults to nullptr so every pre-existing caller (the native smoke
// test, the ping handler below) keeps compiling unchanged -- a claim/renew
// that doesn't mention a role simply leaves whatever was there.
inline void js8SessionSetRole(Js8Session &session, const char *role) {
  if (!role) return;
  strncpy(session.role, role, sizeof(session.role) - 1);
  session.role[sizeof(session.role) - 1] = 0;
}

inline void js8SessionInstall(Js8Session &session, uint32_t nowMs,
                              const char *token, uint32_t ipV4,
                              const char *role = nullptr) {
  strncpy(session.token, token, JS8_SESSION_TOKEN_MAX);
  session.token[JS8_SESSION_TOKEN_MAX] = 0;
  session.ownerIpV4 = ipV4;
  session.held = true;
  session.lastSeenMs = nowMs;
  // A fresh grant or a takeover is always a new holder that has said nothing
  // about a transfer yet -- carrying the previous holder's filename/percent
  // (or the previous holder's role) forward would misattribute it to this one.
  session.role[0] = 0;
  js8SessionSetRole(session, role);
  js8SessionClearMercuryProgress(session);
}

inline Js8SessionResult js8SessionClaim(Js8Session &session, uint32_t nowMs,
                                        const char *token, uint32_t ipV4, bool force,
                                        const char *role = nullptr) {
  if (!js8SessionTokenValid(token)) return JS8_SESSION_BAD_TOKEN;
  if (js8SessionOwns(session, nowMs, token)) {
    session.lastSeenMs = nowMs;
    js8SessionSetRole(session, role);
    return JS8_SESSION_RENEWED;
  }
  if (js8SessionLive(session, nowMs) && !force) {
    session.refusals += 1;
    return JS8_SESSION_BUSY;
  }
  const bool stolen = js8SessionLive(session, nowMs);
  js8SessionInstall(session, nowMs, token, ipV4, role);
  if (stolen) { session.takeovers += 1; return JS8_SESSION_TAKEOVER; }
  return JS8_SESSION_GRANTED;
}

// The heartbeat doubles as a claim on a free lock. Without that, a release that
// races ahead of the holder's own re-claim (same-tab navigation fires the
// release beacon and the new page load in either order) would leave the tab
// heartbeating into a lock nobody owns, and the next page to open would win the
// radio out from under a live session.
inline Js8SessionResult js8SessionHeartbeat(Js8Session &session, uint32_t nowMs,
                                            const char *token, uint32_t ipV4,
                                            const char *role = nullptr) {
  if (!js8SessionTokenValid(token)) return JS8_SESSION_BAD_TOKEN;
  if (js8SessionOwns(session, nowMs, token)) {
    session.lastSeenMs = nowMs;
    js8SessionSetRole(session, role);
    return JS8_SESSION_RENEWED;
  }
  if (js8SessionLive(session, nowMs)) { session.refusals += 1; return JS8_SESSION_BUSY; }
  // A heartbeat that re-claims a freed lock (see comment above) without ever
  // having sent a role -- today's clients don't -- would otherwise install
  // with an empty role until the holder's next explicit claim. Passing role
  // through here closes that gap for clients that do send it on ping.
  js8SessionInstall(session, nowMs, token, ipV4, role);
  return JS8_SESSION_GRANTED;
}

// Any AUD1 frame proves the holder is alive, so a page streaming audio keeps
// the lease fresh even if its HTTP heartbeat is starved. No token is needed:
// every change of owner closes the audio socket, so an open socket always
// belongs to the current holder. An already-expired lease is never resurrected
// -- that would let a half-open TCP connection from a dead browser hold the
// radio indefinitely.
inline void js8SessionNoteTraffic(Js8Session &session, uint32_t nowMs) {
  if (js8SessionLive(session, nowMs)) session.lastSeenMs = nowMs;
}

// A release from a page that no longer owns the lock is a late beacon from a
// session already taken over, and must not free the new holder's lease.
inline bool js8SessionRelease(Js8Session &session, const char *token) {
  if (!js8SessionTokenValid(token) || !session.held) return false;
  if (strcmp(session.token, token) != 0) return false;
  js8SessionClear(session);
  return true;
}

inline const char *js8SessionResultName(Js8SessionResult result) {
  switch (result) {
    case JS8_SESSION_GRANTED:   return "granted";
    case JS8_SESSION_RENEWED:   return "renewed";
    case JS8_SESSION_TAKEOVER:  return "takeover";
    case JS8_SESSION_BUSY:      return "busy";
    case JS8_SESSION_BAD_TOKEN: return "bad-token";
  }
  return "unknown";
}
