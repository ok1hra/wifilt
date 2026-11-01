#pragma once

// Power control of the LAN radio from the web UI: wake it from remote-control
// standby, or put it to standby / shut it down. Shared by the firmware sketch
// and a host regression test (tools/trx-power-smoke.cpp), so the sequencing is
// exercised without a radio.
//
// What the radio offers (IC-705 CI-V manual, IC-7610 CI-V manual):
//   18 01  turns the transceiver ON from OFF (Standby/Shutdown). Over native
//          LAN no FE preamble is needed (wfview icomCommander::powerOn).
//   18 00  turns it OFF. WHICH off is decided by the radio's own menu "Power
//          OFF Setting (for Remote Control)": 00 = Shutdown only, 01 =
//          Standby/Shutdown. IC-705 1A 05 00 73, IC-7610 1A 05 01 35.
// So "standby" and "shut down" are the same 18 00 after writing that menu to
// what the operator chose. The menu is left at the last choice, deliberately:
// it is what the operator asked the radio to do.
//
// Standby itself is judged elsewhere (IcomLanClient::radioPowered(): the LAN
// unit stays logged in and answers NG to every read). A menu write cannot be
// confirmed by its FB alone -- unsupported telemetry reads answer FA/FB on the
// same stream -- so it is read back until the radio reports the new value.
// From standby the radio would refuse the write, so a shutdown from standby
// wakes the radio first.

#include <stdint.h>
#include <stddef.h>
#include <string.h>

enum TrxPowerTarget : uint8_t { TRX_POWER_ON = 0, TRX_POWER_STANDBY, TRX_POWER_SHUTDOWN };

static const uint32_t TRX_POWER_WAKE_RESEND_MS  = 3000;   // one more 18 01 if still asleep
static const uint32_t TRX_POWER_WAKE_TIMEOUT_MS = 25000;  // IC-705 boot plus first poll
static const uint32_t TRX_POWER_MENU_RETRY_MS   = 500;    // write + read-back cadence
static const uint32_t TRX_POWER_MENU_TIMEOUT_MS = 3000;
// radioPowered() needs 4 s of NG-only before it reports standby, so a radio
// that obeyed is never sent a second 18 00.
static const uint32_t TRX_POWER_OFF_RESEND_MS   = 6000;
static const uint32_t TRX_POWER_OFF_TIMEOUT_MS  = 12000;
static const uint32_t TRX_POWER_FAILED_SHOW_MS  = 30000;  // how long /state names the failure

// The menu subaddress of "Power OFF Setting (for Remote Control)", by CI-V
// address. nullptr = the model is not known to have it; such a radio can only
// be woken.
inline const uint8_t *trxPowerOffMenu(uint8_t civAddr) {
  static const uint8_t ic705[2]  = {0x00, 0x73};
  static const uint8_t ic7610[2] = {0x01, 0x35};
  if (civAddr == 0xA4) return ic705;
  if (civAddr == 0x98) return ic7610;
  return nullptr;
}

struct TrxPowerOp {
  enum Phase : uint8_t { IDLE = 0, WAKING, MENU, OFF_SENT, FAILED };
  Phase phase = IDLE;
  TrxPowerTarget target = TRX_POWER_ON;
  uint8_t menu[2] = {0, 0};
  uint32_t phaseMs = 0;     // phase entered
  uint32_t sentMs = 0;      // last command of this phase sent
  uint8_t sends = 0;        // commands sent in this phase
  bool menuConfirmed = false;
  const char *why = "";     // FAILED reason

  bool busy() const { return phase != IDLE && phase != FAILED; }

  void enter(Phase p, uint32_t now) { phase = p; phaseMs = now; sentMs = 0; sends = 0; }
  void fail(const char *reason, uint32_t now) { why = reason; enter(FAILED, now); }
};

// Error for the web request, or nullptr when the operation was accepted (also
// when there is nothing to do: waking a radio that is already on). `poweredOn`
// is radioPowered(), `sessionUp` the LAN login.
inline const char *trxPowerStart(TrxPowerOp &op, TrxPowerTarget target, uint8_t civAddr,
                                 bool sessionUp, bool poweredOn, bool transmitting,
                                 uint32_t now) {
  if (op.busy()) return "busy";
  if (!sessionUp) return "offline";
  if (transmitting) return "transmitting";
  const uint8_t *menu = trxPowerOffMenu(civAddr);
  if (target != TRX_POWER_ON && !menu) return "unsupported";
  op.target = target;
  op.why = "";
  op.menuConfirmed = false;
  if (menu) memcpy(op.menu, menu, 2);
  if (target == TRX_POWER_ON && poweredOn) { op.enter(TrxPowerOp::IDLE, now); return nullptr; }
  op.enter(poweredOn ? TrxPowerOp::MENU : TrxPowerOp::WAKING, now);
  return nullptr;
}

// Every CI-V frame from the radio (FE FE <to> <from> <cmd> ... FD). Only the
// read-back of our menu matters.
inline void trxPowerOnFrame(TrxPowerOp &op, const uint8_t *f, size_t len) {
  if (op.phase != TrxPowerOp::MENU || len < 10 || f[4] != 0x1A || f[5] != 0x05) return;
  if (f[6] != op.menu[0] || f[7] != op.menu[1]) return;
  uint8_t want = op.target == TRX_POWER_STANDBY ? 0x01 : 0x00;
  if (f[8] == want) op.menuConfirmed = true;
}

// Advances the operation. Returns the length of a CI-V body (cmd + payload, no
// FE/addresses/FD) to send now, 0 for none. `out` needs 6 bytes.
inline size_t trxPowerTick(TrxPowerOp &op, uint32_t now, bool sessionUp, bool poweredOn,
                           uint8_t *out) {
  switch (op.phase) {
    case TrxPowerOp::IDLE:
      return 0;
    case TrxPowerOp::FAILED:
      if (now - op.phaseMs >= TRX_POWER_FAILED_SHOW_MS) { op.why = ""; op.enter(TrxPowerOp::IDLE, now); }
      return 0;

    case TrxPowerOp::WAKING:
      if (!sessionUp) { op.fail("link", now); return 0; }
      if (poweredOn) {
        if (op.target == TRX_POWER_ON) op.enter(TrxPowerOp::IDLE, now);
        else op.enter(TrxPowerOp::MENU, now);
        return 0;
      }
      if (now - op.phaseMs >= TRX_POWER_WAKE_TIMEOUT_MS) { op.fail("timeout", now); return 0; }
      if (op.sends == 0 || (op.sends == 1 && now - op.sentMs >= TRX_POWER_WAKE_RESEND_MS)) {
        op.sends++; op.sentMs = now;
        out[0] = 0x18; out[1] = 0x01;
        return 2;
      }
      return 0;

    case TrxPowerOp::MENU:
      if (!sessionUp) { op.fail("link", now); return 0; }
      if (op.menuConfirmed) { op.enter(TrxPowerOp::OFF_SENT, now); return 0; }
      if (now - op.phaseMs >= TRX_POWER_MENU_TIMEOUT_MS) { op.fail("menu", now); return 0; }
      if (op.sends == 0 || now - op.sentMs >= TRX_POWER_MENU_RETRY_MS) {
        // Even sends write, odd ones read back: the reply to the read is what
        // proves the write took.
        bool write = (op.sends & 1) == 0;
        op.sends++; op.sentMs = now;
        out[0] = 0x1A; out[1] = 0x05; out[2] = op.menu[0]; out[3] = op.menu[1];
        if (!write) return 4;
        out[4] = op.target == TRX_POWER_STANDBY ? 0x01 : 0x00;
        return 5;
      }
      return 0;

    case TrxPowerOp::OFF_SENT:
      // Standby keeps the session and stops the data; a shutdown ends both.
      if (!poweredOn || !sessionUp) { op.enter(TrxPowerOp::IDLE, now); return 0; }
      if (now - op.phaseMs >= TRX_POWER_OFF_TIMEOUT_MS) { op.fail("timeout", now); return 0; }
      if (op.sends == 0 || (op.sends == 1 && now - op.sentMs >= TRX_POWER_OFF_RESEND_MS)) {
        op.sends++; op.sentMs = now;
        out[0] = 0x18; out[1] = 0x00;
        return 2;
      }
      return 0;
  }
  return 0;
}

// /state "powerOp": "" idle, the target while busy, "failed:<why>" for a while
// after a failure. Bounded by "failed:timeout" (14).
inline const char *trxPowerOpName(const TrxPowerOp &op, char *buf, size_t n) {
  if (op.phase == TrxPowerOp::FAILED) {
    strncpy(buf, "failed:", n);
    strncat(buf, op.why, n - strlen(buf) - 1);
    return buf;
  }
  if (op.phase == TrxPowerOp::IDLE) return "";
  return op.target == TRX_POWER_ON ? "wake"
       : op.target == TRX_POWER_STANDBY ? "standby" : "shutdown";
}
