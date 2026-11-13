#pragma once

// Unattended-operation guard: shared by the firmware sketch and the native
// regression tests, so the rules are exercised without a radio.
//
// Division of authority (see docs/js8call-neobsluhovany-provoz-plan.md):
//
//   Liveness is the firmware's HARD gate. A frontend that has not been heard
//   from cannot start a new transmission, attended or not. This is unspoofable
//   in the direction that matters: a dead or frozen browser cannot fake it.
//   A transmission already in flight is deliberately NOT aborted here -- three
//   existing paths already cover it (buffer underrun, per-transmission
//   deadline, WebSocket close) and a fourth would kill a legitimate long file
//   transfer on a brief Wi-Fi stall.
//
//   Arming is authoritative STATE, not a hard gate. The firmware owns it so it
//   survives a page reload and can be inspected and revoked from any device on
//   the network; the browser is what stops generating automatic traffic when it
//   lapses. The firmware additionally refuses any tx.prepare the browser itself
//   marked as unattended once arming is gone -- cooperative defence that costs
//   nothing, with no illusion that it constrains a misbehaving browser.
//
//   Operator-initiated transmissions never require arming, otherwise ordinary
//   manual operating would break.
//
// All deadlines use millis(); comparisons are wrap-safe via signed differences,
// matching the rest of the sketch. The longest arming window is 168 h, well
// inside the ~49.7 day millis() wrap.

#include <stdint.h>

enum UnattendedBlock : uint8_t {
  UNATTENDED_OK = 0,
  UNATTENDED_BLOCK_LIVENESS,   // no frame from the frontend within the timeout
  UNATTENDED_BLOCK_NOT_ARMED,  // browser asked for unattended TX while disarmed
};

// Arming durations offered by both the modem settings and /setup.
static const uint32_t UNATTENDED_ARM_CHOICES_H[] = {1, 6, 12, 24, 168};
static const uint8_t  UNATTENDED_ARM_CHOICE_COUNT = 5;
static const uint32_t UNATTENDED_ARM_MAX_MS = 168UL * 3600UL * 1000UL;
static const uint32_t UNATTENDED_LIVENESS_TIMEOUT_MS = 5000;

struct UnattendedGuard {
  uint32_t livenessTimeoutMs = UNATTENDED_LIVENESS_TIMEOUT_MS;
  uint32_t lastClientMs = 0;     // millis() when the frontend was last heard
  bool     clientSeen = false;   // nothing has ever arrived yet
  bool     armed = false;
  uint32_t armedUntilMs = 0;     // millis() deadline, meaningful when armed
  uint32_t blockedLiveness = 0;  // counters feed the remote status panel
  uint32_t blockedNotArmed = 0;
};

// Any frame from the frontend proves liveness: control JSON or TX audio. During
// a long transfer the audio packets alone keep this fresh (~50/s).
inline void unattendedNoteClient(UnattendedGuard &guard, uint32_t nowMs) {
  guard.lastClientMs = nowMs;
  guard.clientSeen = true;
}

inline bool unattendedLivenessFresh(const UnattendedGuard &guard, uint32_t nowMs) {
  if (!guard.clientSeen) return false;
  return (int32_t)(nowMs - guard.lastClientMs) < (int32_t)guard.livenessTimeoutMs;
}

// Arming lapses on its own so a forgotten open tab cannot transmit for weeks.
inline bool unattendedArmActive(const UnattendedGuard &guard, uint32_t nowMs) {
  return guard.armed && (int32_t)(nowMs - guard.armedUntilMs) < 0;
}

// Armed AND a frontend is alive to act on it. Arming alone is only a deadline:
// with no page connected the liveness gate refuses every transmission, so
// nothing can go out unattended. This is what "the station is running
// unattended right now" means to anything outside the TX path (the updater).
inline bool unattendedOperating(const UnattendedGuard &guard, uint32_t nowMs) {
  return unattendedArmActive(guard, nowMs) && unattendedLivenessFresh(guard, nowMs);
}

inline uint32_t unattendedRemainingMs(const UnattendedGuard &guard, uint32_t nowMs) {
  if (!unattendedArmActive(guard, nowMs)) return 0;
  return (uint32_t)(guard.armedUntilMs - nowMs);
}

// Clamped so a malformed or hostile request cannot arm beyond the longest
// offered window.
inline bool unattendedArm(UnattendedGuard &guard, uint32_t durationMs, uint32_t nowMs) {
  if (durationMs == 0) return false;
  if (durationMs > UNATTENDED_ARM_MAX_MS) durationMs = UNATTENDED_ARM_MAX_MS;
  guard.armed = true;
  guard.armedUntilMs = nowMs + durationMs;
  return true;
}

// Extending from /setup restarts the window from now rather than accumulating,
// so the displayed deadline always matches the button that was pressed.
inline bool unattendedExtend(UnattendedGuard &guard, uint32_t durationMs, uint32_t nowMs) {
  return unattendedArm(guard, durationMs, nowMs);
}

inline void unattendedRevoke(UnattendedGuard &guard) {
  guard.armed = false;
  guard.armedUntilMs = 0;
}

// Drops a lapsed arming exactly once so the caller can emit a single event.
inline bool unattendedExpire(UnattendedGuard &guard, uint32_t nowMs) {
  if (!guard.armed || unattendedArmActive(guard, nowMs)) return false;
  unattendedRevoke(guard);
  return true;
}

// Verdict for a NEW tx.prepare. `requestUnattended` is what the browser claims
// about this transmission; it can only ever restrict, never unlock.
inline UnattendedBlock unattendedEvaluate(UnattendedGuard &guard, uint32_t nowMs,
                                          bool requestUnattended) {
  if (!unattendedLivenessFresh(guard, nowMs)) {
    guard.blockedLiveness += 1;
    return UNATTENDED_BLOCK_LIVENESS;
  }
  if (requestUnattended && !unattendedArmActive(guard, nowMs)) {
    guard.blockedNotArmed += 1;
    return UNATTENDED_BLOCK_NOT_ARMED;
  }
  return UNATTENDED_OK;
}

// Checked at the moment of keying, which is where liveness actually bites.
//
// Refusing a new tx.prepare on liveness is close to meaningless: every inbound
// frame refreshes the dead-man, so the frame carrying the request has just
// proved the browser is alive. The real gap is the wait between preparation and
// the slot -- the firmware accepts a slot up to 35 s ahead. A browser that sends
// the request plus a full prebuffer and then dies leaves the ring satisfied, so
// the prebuffer test passes and the radio would key 30 s later and transmit into
// a dead session. Liveness at keying time is what catches that.
inline bool unattendedMayKey(const UnattendedGuard &guard, uint32_t nowMs) {
  return unattendedLivenessFresh(guard, nowMs);
}

inline const char *unattendedBlockReason(UnattendedBlock block) {
  switch (block) {
    case UNATTENDED_OK:              return "ok";
    case UNATTENDED_BLOCK_LIVENESS:  return "frontend liveness lost";
    case UNATTENDED_BLOCK_NOT_ARMED: return "unattended TX while disarmed";
  }
  return "unknown";
}

inline bool unattendedIsArmChoiceH(uint32_t hours) {
  for (uint8_t index = 0; index < UNATTENDED_ARM_CHOICE_COUNT; ++index)
    if (UNATTENDED_ARM_CHOICES_H[index] == hours) return true;
  return false;
}
