// Native regression test for trx_power.h -- wake / standby / shutdown of the
// LAN radio from the web UI.
//
//   g++ -std=c++11 -Wall -Wextra -o /tmp/trx-power-smoke tools/trx-power-smoke.cpp && /tmp/trx-power-smoke
//
// A simulated IC-705 in simulated time: 18 01 boots it after a delay, 18 00
// follows the "Power OFF Setting (for Remote Control)" menu, standby answers NG
// to everything (so a menu write there is refused), and radioPowered() goes
// false only 4 s after the last data reply, as IcomLanClient judges it.
// Checked:
//   - wake from standby, one resend when the first 18 01 is lost, timeout
//   - standby / shutdown from ON write the menu, read it back, then 18 00 once
//   - shutdown from standby wakes first, then writes the menu
//   - refusals: transmitting, busy, offline, a model without the menu
//   - a lost menu write is retried; a radio that never confirms fails "menu"

#include "../trx_power.h"
#include <cstdio>
#include <string>
#include <vector>

static int failures = 0, checks = 0;
static void ok(const char *name, bool condition) {
  checks++;
  if (!condition) { failures++; std::printf("FAIL %s\n", name); }
}

struct FakeRadio {
  enum State { ON, STANDBY, OFF } state = ON;
  uint8_t menuValue = 0x01;          // Standby/Shutdown
  uint32_t bootAt = 0;               // ON once now >= bootAt (while booting)
  bool booting = false;
  uint32_t lastDataMs = 0;           // last non-NG reply
  bool dropWrites = false;           // menu writes lost on the wire
  bool dropFirstWake = false;
  bool deaf = false;                 // ignores 18 01 altogether
  bool neverConfirm = false;
  int wakes = 0, offs = 0, writes = 0;
  std::vector<std::vector<uint8_t>> replies;

  bool sessionUp() const { return state != OFF; }
  bool powered(uint32_t now) const { return state == ON && now - lastDataMs < 4000; }

  void tick(uint32_t now) {
    if (booting && now >= bootAt) { booting = false; state = ON; }
    if (state == ON) lastDataMs = now;   // telemetry polls answered with data
  }

  void receive(const uint8_t *b, size_t n, uint32_t now) {
    if (state == OFF) return;
    if (b[0] == 0x18 && b[1] == 0x01) {
      wakes++;
      if (deaf || (dropFirstWake && wakes == 1)) return;
      if (state == STANDBY && !booting) { booting = true; bootAt = now + 3000; }
      return;
    }
    if (state != ON) return;              // NG to everything else
    if (b[0] == 0x18 && b[1] == 0x00) {
      offs++;
      state = menuValue == 0x01 ? STANDBY : OFF;
      return;
    }
    if (b[0] == 0x1A && b[1] == 0x05 && b[2] == 0x00 && b[3] == 0x73) {
      if (n == 5) {
        writes++;
        if (!dropWrites && !neverConfirm) menuValue = b[4];
        if (dropWrites) dropWrites = false;   // only the first one is lost
        return;
      }
      uint8_t v = neverConfirm ? (uint8_t)0x07 : menuValue;
      replies.push_back({0xFE, 0xFE, 0xE1, 0xA4, 0x1A, 0x05, 0x00, 0x73, v, 0xFD});
    }
  }
};

// Runs until the op is idle/failed or the deadline, 50 ms steps.
static void run(TrxPowerOp &op, FakeRadio &r, uint32_t &now, uint32_t forMs) {
  uint32_t end = now + forMs;
  while (now < end) {
    r.tick(now);
    for (auto &f : r.replies) trxPowerOnFrame(op, f.data(), f.size());
    r.replies.clear();
    uint8_t out[6];
    size_t n = trxPowerTick(op, now, r.sessionUp(), r.powered(now), out);
    if (n) r.receive(out, n, now);
    if (op.phase == TrxPowerOp::IDLE || op.phase == TrxPowerOp::FAILED) return;
    now += 50;
  }
}

static FakeRadio standbyRadio(uint32_t &now) {
  FakeRadio r;
  r.state = FakeRadio::STANDBY;
  now = 100000;
  r.lastDataMs = 0;
  return r;
}

int main() {
  char name[24];

  {  // wake from standby
    uint32_t now; FakeRadio r = standbyRadio(now); TrxPowerOp op;
    ok("wake accepted", trxPowerStart(op, TRX_POWER_ON, 0xA4, true, false, false, now) == nullptr);
    ok("wake named", std::string(trxPowerOpName(op, name, sizeof name)) == "wake");
    run(op, r, now, 30000);
    ok("wake ends idle", op.phase == TrxPowerOp::IDLE);
    ok("radio on", r.state == FakeRadio::ON);
    ok("one 18 01", r.wakes == 1);
  }
  {  // first 18 01 lost -> one resend
    uint32_t now; FakeRadio r = standbyRadio(now); r.dropFirstWake = true; TrxPowerOp op;
    trxPowerStart(op, TRX_POWER_ON, 0xA4, true, false, false, now);
    run(op, r, now, 30000);
    ok("lost wake resent", r.wakes == 2 && r.state == FakeRadio::ON && op.phase == TrxPowerOp::IDLE);
  }
  {  // a radio that never wakes
    uint32_t now; FakeRadio r = standbyRadio(now); r.deaf = true; TrxPowerOp op;
    trxPowerStart(op, TRX_POWER_ON, 0xA4, true, false, false, now);
    run(op, r, now, 30000);
    ok("wake timeout", op.phase == TrxPowerOp::FAILED &&
       std::string(trxPowerOpName(op, name, sizeof name)) == "failed:timeout");
    ok("exactly two 18 01", r.wakes == 2);
    uint8_t out[6];
    trxPowerTick(op, now + TRX_POWER_FAILED_SHOW_MS, true, false, out);
    ok("failure clears after a while", op.phase == TrxPowerOp::IDLE);
  }
  {  // wake when already on: nothing to do
    uint32_t now = 5000; TrxPowerOp op;
    ok("wake on ON accepted", trxPowerStart(op, TRX_POWER_ON, 0xA4, true, true, false, now) == nullptr);
    ok("wake on ON idle", op.phase == TrxPowerOp::IDLE);
  }
  {  // standby from ON with menu at Shutdown only
    uint32_t now = 5000; FakeRadio r; r.menuValue = 0x00; TrxPowerOp op;
    r.tick(now);
    ok("standby accepted", trxPowerStart(op, TRX_POWER_STANDBY, 0xA4, true, true, false, now) == nullptr);
    run(op, r, now, 30000);
    ok("standby idle", op.phase == TrxPowerOp::IDLE);
    ok("menu set to Standby/Shutdown", r.menuValue == 0x01);
    ok("radio in standby", r.state == FakeRadio::STANDBY);
    ok("one 18 00", r.offs == 1);
  }
  {  // shutdown from ON
    uint32_t now = 5000; FakeRadio r; TrxPowerOp op;
    r.tick(now);
    trxPowerStart(op, TRX_POWER_SHUTDOWN, 0xA4, true, true, false, now);
    ok("shutdown named", std::string(trxPowerOpName(op, name, sizeof name)) == "shutdown");
    run(op, r, now, 30000);
    ok("shutdown idle", op.phase == TrxPowerOp::IDLE);
    ok("menu Shutdown only", r.menuValue == 0x00);
    ok("radio off", r.state == FakeRadio::OFF);
  }
  {  // shutdown from standby: wake, write, off
    uint32_t now; FakeRadio r = standbyRadio(now); TrxPowerOp op;
    trxPowerStart(op, TRX_POWER_SHUTDOWN, 0xA4, true, false, false, now);
    ok("shutdown from standby wakes first", op.phase == TrxPowerOp::WAKING);
    run(op, r, now, 60000);
    ok("shutdown from standby idle", op.phase == TrxPowerOp::IDLE);
    ok("shutdown from standby off", r.state == FakeRadio::OFF && r.wakes == 1 && r.menuValue == 0x00);
  }
  {  // a lost menu write is retried
    uint32_t now = 5000; FakeRadio r; r.dropWrites = true; TrxPowerOp op;
    r.tick(now);
    trxPowerStart(op, TRX_POWER_SHUTDOWN, 0xA4, true, true, false, now);
    run(op, r, now, 30000);
    ok("lost write retried", r.writes >= 2 && r.state == FakeRadio::OFF);
  }
  {  // menu never confirmed -> no 18 00
    uint32_t now = 5000; FakeRadio r; r.neverConfirm = true; TrxPowerOp op;
    r.tick(now);
    trxPowerStart(op, TRX_POWER_STANDBY, 0xA4, true, true, false, now);
    run(op, r, now, 30000);
    ok("unconfirmed menu fails", op.phase == TrxPowerOp::FAILED &&
       std::string(trxPowerOpName(op, name, sizeof name)) == "failed:menu");
    ok("no 18 00 without the menu", r.offs == 0 && r.state == FakeRadio::ON);
  }
  {  // refusals
    TrxPowerOp op;
    ok("transmitting refused", std::string(trxPowerStart(op, TRX_POWER_STANDBY, 0xA4, true, true, true, 0)) == "transmitting");
    ok("offline refused", std::string(trxPowerStart(op, TRX_POWER_ON, 0xA4, false, false, false, 0)) == "offline");
    ok("unknown model cannot standby", std::string(trxPowerStart(op, TRX_POWER_STANDBY, 0x94, true, true, false, 0)) == "unsupported");
    ok("unknown model can wake", trxPowerStart(op, TRX_POWER_ON, 0x94, true, false, false, 0) == nullptr);
    ok("busy refused", std::string(trxPowerStart(op, TRX_POWER_ON, 0x94, true, false, false, 0)) == "busy");
    ok("IC-7610 menu", trxPowerOffMenu(0x98) && trxPowerOffMenu(0x98)[0] == 0x01 && trxPowerOffMenu(0x98)[1] == 0x35);
  }

  std::printf("%d/%d checks passed\n", checks - failures, checks);
  return failures ? 1 : 0;
}
