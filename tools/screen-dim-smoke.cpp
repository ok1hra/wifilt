// Native regression test for screen_dim.h -- IC-705 screen dimming by mode.
//
//   g++ -std=c++11 -Wall -Wextra -o /tmp/screen-dim-smoke tools/screen-dim-smoke.cpp && /tmp/screen-dim-smoke
//
// A simulated IC-705 holds the four SET > Display items and answers reads
// the way the radio does (1A 05 01 36 hi lo, the rest one byte). Checked:
//   - mode classes: -D and RTTY digital, SSB/CW/AM/FM/DV not
//   - default: USB-D dims after the settle time, originals kept; USB restores
//   - a short trip through another mode writes nothing
//   - the operator's choice per class (icon) wins over the default
//   - not while not ready (TX); an interrupted run resumes and keeps originals
//   - after a reboot with originals kept: dark rewritten, not re-read
//   - a silent radio: no write at all, failure with growing hold-off
//   - a radio that does not take a write fails "verify"

#include "../screen_dim.h"
#include <cstdio>
#include <string>
#include <vector>

static int failures = 0, checks = 0;
static void ok(const char *name, bool condition) {
  checks++;
  if (!condition) { failures++; std::printf("FAIL %s\n", name); }
}

struct FakeRadio {
  uint8_t v[4] = {128, 0x01, 0x04, 0x00};   // 50 %, auto ON, 15 min, OFF
  bool silent = false, stubborn = false;
  int reads = 0, writes = 0;
  std::vector<std::vector<uint8_t>> replies;

  void receive(const uint8_t *b, size_t n) {
    if (n < 4 || b[0] != 0x1A || b[1] != 0x05 || b[2] != 0x01) return;
    int i = b[3] - 0x36;
    if (i < 0 || i > 3) return;
    if (n == 4) {
      reads++;
      if (silent) return;
      std::vector<uint8_t> f = {0xFE, 0xFE, 0xE1, 0xA4, 0x1A, 0x05, 0x01, b[3]};
      if (i == 0) { f.push_back(v[0] / 100); f.push_back((uint8_t)(((v[0] / 10 % 10) << 4) | (v[0] % 10))); }
      else f.push_back(v[i]);
      f.push_back(0xFD);
      replies.push_back(f);
      return;
    }
    writes++;
    if (stubborn) return;
    if (i == 0) v[0] = (uint8_t)((b[4] & 0x0f) * 100 + (b[5] >> 4) * 10 + (b[5] & 0x0f));
    else v[i] = b[4];
  }
};

struct Rig {
  FakeRadio radio;
  ScreenDimOp op;
  ScreenSaved saved;
  uint8_t prefs = 0xff;
  uint32_t now = 1000;
  int persists = 0;
  const char *mode = "USB";
  bool ready = true;

  void run(uint32_t ms) {
    for (uint32_t end = now + ms; now < end; now += 10) {
      for (auto &f : radio.replies) screenDimOnFrame(op, f.data(), f.size());
      radio.replies.clear();
      uint8_t out[6];
      bool changed = false;
      size_t n = screenDimTick(op, now, mode, prefs, ready, saved, changed, out);
      if (changed) persists++;
      if (n) radio.receive(out, n);
    }
  }
  bool dark() const { return radio.v[0] == 0 && radio.v[1] == 0 && radio.v[2] == 1 && radio.v[3] == 1; }
  bool original() const { return radio.v[0] == 128 && radio.v[1] == 1 && radio.v[2] == 4 && radio.v[3] == 0; }
  const char *state() const { return screenDimStateName(op, prefs, saved); }
};

int main() {
  ok("class USB-D", screenModeClass("USB-D") == SCREEN_CLASS_DIGITAL);
  ok("class LSB-D", screenModeClass("LSB-D") == SCREEN_CLASS_DIGITAL);
  ok("class FM-D", screenModeClass("FM-D") == SCREEN_CLASS_DIGITAL);
  ok("class RTTY", screenModeClass("RTTY") == SCREEN_CLASS_DIGITAL);
  ok("class RTTY-R", screenModeClass("RTTY-R") == SCREEN_CLASS_DIGITAL);
  ok("class USB", screenModeClass("USB") == SCREEN_CLASS_OTHER);
  ok("class CW-R", screenModeClass("CW-R") == SCREEN_CLASS_OTHER);
  ok("class AM", screenModeClass("AM") == SCREEN_CLASS_OTHER);
  ok("class DV", screenModeClass("DV") == SCREEN_CLASS_OTHER);
  ok("class empty", screenModeClass("") == SCREEN_CLASS_NONE);
  ok("class UNK", screenModeClass("UNK") == SCREEN_CLASS_NONE);
  ok("prefs default", screenWants(0xff, SCREEN_CLASS_DIGITAL) && !screenWants(0xff, SCREEN_CLASS_OTHER));
  ok("prefs digital off", !screenWants(screenPrefsSet(0xff, SCREEN_CLASS_DIGITAL, false), SCREEN_CLASS_DIGITAL));
  ok("prefs other on keeps digital", screenWants(screenPrefsSet(0xff, SCREEN_CLASS_OTHER, true), SCREEN_CLASS_DIGITAL));
  ok("supported only IC-705", screenSupported(0xA4) && !screenSupported(0x98));

  {  // default behaviour
    Rig r;
    r.run(5000);
    ok("USB: nothing on the wire", r.radio.reads == 0 && r.radio.writes == 0 && r.state() == std::string("normal"));
    r.mode = "USB-D";
    r.run(2500);
    ok("USB-D: waits the settle time", r.radio.reads == 0 && r.original());
    r.run(3000);
    ok("USB-D: dark", r.dark() && r.saved.valid && r.persists == 1);
    ok("USB-D: originals kept", r.saved.v[0] == 128 && r.saved.v[1] == 1 && r.saved.v[2] == 4 && r.saved.v[3] == 0);
    ok("USB-D: state dark", r.state() == std::string("dark"));
    int writes = r.radio.writes;
    r.radio.v[0] = 200;                    // operator turns the light up at the radio
    r.run(10000);
    ok("dark: operator's change left alone", r.radio.writes == writes && r.radio.v[0] == 200);
    r.radio.v[0] = 0;
    r.mode = "USB"; r.run(1000); r.mode = "USB-D"; r.run(5000);
    ok("short trip through USB writes nothing", r.radio.writes == writes);
    r.mode = "CW"; r.run(5000);
    ok("CW: restored", r.original() && !r.saved.valid && r.persists == 2);
    ok("CW: state normal", r.state() == std::string("normal"));
    r.mode = "RTTY"; r.run(5000);
    ok("RTTY: dark again", r.dark());
  }

  {  // operator's choice
    Rig r;
    r.prefs = screenPrefsSet(0xff, SCREEN_CLASS_DIGITAL, false);
    r.mode = "USB-D"; r.run(6000);
    ok("digital off: nothing", r.radio.writes == 0 && r.state() == std::string("normal"));
    r.prefs = screenPrefsSet(r.prefs, SCREEN_CLASS_DIGITAL, true);
    r.run(1000);
    ok("icon on: dark right away (class already settled)", r.dark());
    r.prefs = screenPrefsSet(r.prefs, SCREEN_CLASS_OTHER, true);
    r.mode = "USB"; r.run(6000);
    ok("other on: SSB stays dark", r.dark() && r.saved.valid);
  }

  {  // not while transmitting; interrupted run
    Rig r;
    r.mode = "USB-D"; r.ready = false; r.run(6000);
    ok("not ready: nothing", r.radio.reads == 0);
    r.ready = true; r.run(150);        // through the reads, into the writes
    r.ready = false; r.run(2000);
    ok("interrupted: originals already kept", r.saved.valid && r.saved.v[0] == 128 && !r.dark());
    int reads = r.radio.reads;
    r.ready = true; r.run(2000);
    ok("resumed: dark", r.dark());
    ok("resumed: no read over the originals", r.radio.reads == reads + 4);
  }

  {  // reboot with originals kept
    Rig r;
    r.saved.valid = true; r.saved.v[0] = 128; r.saved.v[1] = 1; r.saved.v[2] = 4; r.saved.v[3] = 0;
    r.radio.v[0] = 0; r.radio.v[1] = 0; r.radio.v[2] = 1; r.radio.v[3] = 1;
    r.mode = "USB-D"; r.run(6000);
    ok("reboot: dark rewritten, verify only", r.radio.writes == 4 && r.radio.reads == 4 && r.dark());
    r.mode = "LSB"; r.run(6000);
    ok("reboot: restore from EEPROM", r.original() && !r.saved.valid);
  }

  {  // silent radio
    Rig r;
    r.radio.silent = true;
    r.mode = "USB-D"; r.run(6000);
    ok("silent: no write", r.radio.writes == 0 && !r.saved.valid);
    ok("silent: failed", r.state() == std::string("failed") && r.op.why == std::string("read"));
    int reads = r.radio.reads;
    r.run(25000);
    ok("silent: holds 30 s", r.radio.reads == reads);
    r.run(10000);
    ok("silent: tries again", r.radio.reads == reads * 2);
    r.run(40000);
    ok("silent: second hold is longer", r.radio.reads == reads * 2);
    r.radio.silent = false;
    r.run(30000);
    ok("silent then answers: dark", r.dark());
  }

  {  // radio that does not take the write
    Rig r;
    r.radio.stubborn = true;
    r.mode = "USB-D"; r.run(6000);
    ok("stubborn: verify failure", r.state() == std::string("failed") && r.op.why == std::string("verify"));
    ok("stubborn: originals kept for later", r.saved.valid);
  }

  std::printf("%d/%d checks passed\n", checks - failures, checks);
  return failures ? 1 : 0;
}
