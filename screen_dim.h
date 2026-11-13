#pragma once

// IC-705 screen dimming, chosen by the radio's mode. Shared by the firmware
// sketch and a host regression test (tools/screen-dim-smoke.cpp).
//
// CI-V has no "screen off now": 1A 05 01 40 only lets a short press of POWER do
// it. So "dim" means writing four items of SET > Display (IC-705 CI-V
// reference, p. 8 -- the 01 xx column; 00 36/37 beside it is Max TX Power):
//   1A 05 01 36  LCD Backlight             0000..0255, two BCD bytes  -> 0
//   1A 05 01 37  LCD Backlight Auto Adjust 00/01                      -> 00
//   1A 05 01 38  Screen Saver (Battery)    00=OFF 01=1 min .. 06      -> 01
//   1A 05 01 39  Screen Saver (DC 13.8 V)  same                       -> 01
// The display then goes dark a minute after the last operation at the radio.
// What was there before is read first, kept (the sketch persists it in
// EEPROM) and written back when dimming ends.
//
// WHEN is the operator's choice per mode class: digital (any -D mode, RTTY,
// RTTY-R) and everything else (SSB, CW, AM, FM, DV). Default: digital dims,
// the rest does not. The topbar icon flips the choice for the class the radio
// is in now. A class has to hold SCREEN_SETTLE_MS before anything is written,
// because a band change can pass through other modes on the way.
//
// Only a change of what is wanted is acted on. Once the radio is confirmed in
// the wanted state, whatever the operator then sets at the radio is left alone.
// After a reboot the dark values are written once more (nothing in RAM says
// they were confirmed); that is four writes the radio already has.

#include <stdint.h>
#include <stddef.h>
#include <string.h>

enum ScreenClass : uint8_t { SCREEN_CLASS_NONE = 0, SCREEN_CLASS_DIGITAL, SCREEN_CLASS_OTHER };

static const uint32_t SCREEN_SETTLE_MS    = 3000;
static const uint32_t SCREEN_REPLY_MS     = 400;    // per read, then resend
static const uint8_t  SCREEN_READ_TRIES   = 3;
static const uint32_t SCREEN_WRITE_GAP_MS = 100;
static const uint32_t SCREEN_HOLD_MS      = 30000;  // after a failure; doubles, up to 8 min

static const uint8_t SCREEN_ITEMS = 4;
static const uint8_t SCREEN_SUB0  = 0x36;          // 1A 05 01 36 .. 39
static const uint8_t SCREEN_DARK[SCREEN_ITEMS] = {0, 0x00, 0x01, 0x01};

inline bool screenSupported(uint8_t civAddr) { return civAddr == 0xA4; }   // IC-705

inline ScreenClass screenModeClass(const char *mode) {
  if (!mode || !*mode || strcmp(mode, "UNK") == 0) return SCREEN_CLASS_NONE;
  size_t n = strlen(mode);
  if (n >= 2 && strcmp(mode + n - 2, "-D") == 0) return SCREEN_CLASS_DIGITAL;
  if (strncmp(mode, "RTTY", 4) == 0) return SCREEN_CLASS_DIGITAL;
  return SCREEN_CLASS_OTHER;
}

// The choice byte (EEPROM): 0xff = never set = digital on, the rest off.
// Otherwise bit0 = dim in digital modes, bit1 = dim in the others.
inline bool screenWants(uint8_t prefs, ScreenClass c) {
  if (c == SCREEN_CLASS_NONE) return false;
  if (prefs == 0xff) return c == SCREEN_CLASS_DIGITAL;
  return prefs & (c == SCREEN_CLASS_DIGITAL ? 1 : 2);
}
inline uint8_t screenPrefsSet(uint8_t prefs, ScreenClass c, bool on) {
  uint8_t bits = prefs == 0xff ? 1 : (prefs & 3);
  uint8_t bit = c == SCREEN_CLASS_DIGITAL ? 1 : 2;
  return on ? (bits | bit) : (bits & ~bit);
}

// The radio's own settings from before dimming. light is the decoded 0..255.
struct ScreenSaved {
  bool valid = false;
  uint8_t v[SCREEN_ITEMS] = {0, 0, 0, 0};
};

struct ScreenDimOp {
  enum Phase : uint8_t { IDLE = 0, READ, WRITE, VERIFY, HOLD };
  Phase phase = IDLE;
  bool toDark = false;
  bool confirmed = false;   // the radio was verified in the state `saved` says
  uint8_t item = 0, tries = 0;
  uint32_t phaseMs = 0, sentMs = 0;
  bool got = false;
  uint8_t gotValue = 0;
  uint8_t readVals[SCREEN_ITEMS] = {0, 0, 0, 0};
  uint8_t target[SCREEN_ITEMS] = {0, 0, 0, 0};
  uint8_t failures = 0;
  const char *why = "";
  ScreenClass cls = SCREEN_CLASS_NONE;
  uint32_t clsSince = 0;

  bool busy() const { return phase == READ || phase == WRITE || phase == VERIFY; }
  void enter(Phase p, uint32_t now) { phase = p; phaseMs = now; sentMs = 0; item = 0; tries = 0; got = false; }
};

// Every CI-V frame from the radio (FE FE <to> <from> <cmd> ... FD). Only the
// reply to the read in flight matters.
inline void screenDimOnFrame(ScreenDimOp &op, const uint8_t *f, size_t len) {
  if (op.phase != ScreenDimOp::READ && op.phase != ScreenDimOp::VERIFY) return;
  if (len < 10 || f[4] != 0x1A || f[5] != 0x05 || f[6] != 0x01) return;
  if (f[7] != SCREEN_SUB0 + op.item) return;
  if (op.item == 0) {
    if (len < 11) return;
    uint8_t hi = f[8], lo = f[9];
    op.gotValue = (uint8_t)((hi & 0x0f) * 100 + (lo >> 4) * 10 + (lo & 0x0f));
  } else {
    op.gotValue = f[8];
  }
  op.got = true;
}

inline size_t screenDimBody(uint8_t item, bool write, uint8_t value, uint8_t *out) {
  out[0] = 0x1A; out[1] = 0x05; out[2] = 0x01; out[3] = SCREEN_SUB0 + item;
  if (!write) return 4;
  if (item == 0) {
    out[4] = value / 100;
    out[5] = (uint8_t)((((value / 10) % 10) << 4) | (value % 10));
    return 6;
  }
  out[4] = value;
  return 5;
}

inline void screenDimFail(ScreenDimOp &op, const char *why, uint32_t now) {
  op.why = why;
  if (op.failures < 255) op.failures++;
  op.confirmed = false;
  op.enter(ScreenDimOp::HOLD, now);
}

// Advances dimming. `mode` is the radio's mode text ("USB-D"), `ready` = LAN
// session up, radio powered, not transmitting, no power operation running.
// `saved` is updated in place; `savedChanged` says the sketch must persist it.
// Returns the length of a CI-V body to send now (cmd + payload), 0 for none.
// `out` needs 6 bytes.
inline size_t screenDimStep(ScreenDimOp &op, uint32_t now, const char *mode, uint8_t prefs,
                            bool ready, ScreenSaved &saved, bool &savedChanged, uint8_t *out) {
  ScreenClass cls = screenModeClass(mode);
  if (cls != op.cls) {
    op.cls = cls; op.clsSince = now; op.failures = 0;
    if (op.phase == ScreenDimOp::HOLD) op.enter(ScreenDimOp::IDLE, now);
  }

  switch (op.phase) {
    case ScreenDimOp::HOLD: {
      uint8_t shift = op.failures > 1 ? (uint8_t)(op.failures - 1) : 0;
      if (shift > 4) shift = 4;
      if (now - op.phaseMs < (SCREEN_HOLD_MS << shift)) return 0;
      op.why = "";
      op.enter(ScreenDimOp::IDLE, now);
      return 0;
    }

    case ScreenDimOp::IDLE: {
      if (!ready || op.cls == SCREEN_CLASS_NONE || now - op.clsSince < SCREEN_SETTLE_MS) return 0;
      bool want = screenWants(prefs, op.cls);
      if (want) {
        if (saved.valid && op.confirmed) return 0;
        op.toDark = true;
        memcpy(op.target, SCREEN_DARK, SCREEN_ITEMS);
        // Originals already kept (a reboot, or an aborted run): do not read the
        // half-dark radio over them.
        op.enter(saved.valid ? ScreenDimOp::WRITE : ScreenDimOp::READ, now);
      } else {
        if (!saved.valid) return 0;
        op.toDark = false;
        memcpy(op.target, saved.v, SCREEN_ITEMS);
        op.enter(ScreenDimOp::WRITE, now);
      }
      return screenDimStep(op, now, mode, prefs, ready, saved, savedChanged, out);
    }

    case ScreenDimOp::READ:
    case ScreenDimOp::VERIFY: {
      // Whatever stopped us (TX, standby) is waited out in IDLE and the run
      // starts over; it is not the radio refusing.
      if (!ready) { op.confirmed = false; op.enter(ScreenDimOp::IDLE, now); return 0; }
      if (op.got) {
        op.got = false;
        if (op.phase == ScreenDimOp::VERIFY && op.gotValue != op.target[op.item]) {
          screenDimFail(op, "verify", now);
          return 0;
        }
        op.readVals[op.item] = op.gotValue;
        op.item++; op.tries = 0; op.sentMs = 0;
        if (op.item == SCREEN_ITEMS) {
          if (op.phase == ScreenDimOp::READ) {
            // Kept before the first write, so a reboot halfway can still restore.
            memcpy(saved.v, op.readVals, SCREEN_ITEMS);
            saved.valid = true;
            savedChanged = true;
            op.enter(ScreenDimOp::WRITE, now);
            return screenDimStep(op, now, mode, prefs, ready, saved, savedChanged, out);
          }
          // Verified.
          op.failures = 0;
          op.confirmed = true;
          if (!op.toDark) { saved.valid = false; savedChanged = true; }
          op.enter(ScreenDimOp::IDLE, now);
          return 0;
        }
      }
      if (op.tries == 0 || now - op.sentMs >= SCREEN_REPLY_MS) {
        if (op.tries >= SCREEN_READ_TRIES) { screenDimFail(op, "read", now); return 0; }
        op.tries++; op.sentMs = now;
        return screenDimBody(op.item, false, 0, out);
      }
      return 0;
    }

    case ScreenDimOp::WRITE:
      if (!ready) { op.confirmed = false; op.enter(ScreenDimOp::IDLE, now); return 0; }
      if (op.sentMs && now - op.sentMs < SCREEN_WRITE_GAP_MS) return 0;
      if (op.item == SCREEN_ITEMS) {
        op.enter(ScreenDimOp::VERIFY, now);
        return screenDimStep(op, now, mode, prefs, ready, saved, savedChanged, out);
      }
      op.sentMs = now;
      {
        uint8_t item = op.item++;
        return screenDimBody(item, true, op.target[item], out);
      }
  }
  return 0;
}

inline size_t screenDimTick(ScreenDimOp &op, uint32_t now, const char *mode, uint8_t prefs,
                            bool ready, ScreenSaved &saved, bool &savedChanged, uint8_t *out) {
  savedChanged = false;
  return screenDimStep(op, now, mode, prefs, ready, saved, savedChanged, out);
}

// /state "scr": what the icon shows. "dark"/"normal" = what is wanted for the
// mode the radio is in; "dimming"/"restoring" while a run is on the wire;
// "failed" while a failure holds off the next try. Bounded by "restoring".
inline const char *screenDimStateName(const ScreenDimOp &op, uint8_t prefs, const ScreenSaved &saved) {
  if (op.phase == ScreenDimOp::HOLD) return "failed";
  if (op.busy()) return op.toDark ? "dimming" : "restoring";
  bool dark = op.cls == SCREEN_CLASS_NONE ? saved.valid : screenWants(prefs, op.cls);
  return dark ? "dark" : "normal";
}
