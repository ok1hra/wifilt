// SPDX-License-Identifier: GPL-3.0-or-later
// TS-480 panel protocol, link and simulator. The protocol cases are a port of
// ts-480-web-panel's tests/test_protocol.py (same captured boot dumps).
#include "doctest.h"

#include <chrono>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

#include "../third_party/json/json.hpp"
#include "ts480_link.h"
#include "ts480_protocol.h"
#include "ts480_sim.h"

using namespace LocalTrx;
using namespace LocalTrx::Ts480;
using nlohmann::json;

namespace {

std::string fromHex(const std::string &hex) {
  std::string out;
  unsigned value = 0;
  int digits = 0;
  for (char c : hex) {
    int v = c >= '0' && c <= '9' ? c - '0' : c >= 'A' && c <= 'F' ? c - 'A' + 10 : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
    if (v < 0) continue;
    value = value * 16 + (unsigned)v;
    if (++digits == 2) {
      out += (char)value;
      value = 0;
      digits = 0;
    }
  }
  return out;
}

struct Run {
  DisplayState state;
  std::vector<Action> actions;
};

Run run(const std::string &data) {
  Run r;
  FrameReader reader;
  for (const std::string &f : reader.feed(data)) {
    Action a = r.state.apply(f);
    if (a != Action::None) r.actions.push_back(a);
  }
  return r;
}

bool hasIcon(const DisplayState &s, const std::string &icon) {
  for (const std::string &i : s.icons())
    if (i == icon) return true;
  return false;
}

std::string trim(const std::string &s) {
  size_t a = s.find_first_not_of(' '), b = s.find_last_not_of(' ');
  return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}

// radio -> panel power-on dump from stianeklund/TS-480-Panel
const std::string BOOT = fromHex(
    "0D 0D 30 31 0D 30 31 0D 3A 20 20 0D 52 30 0D 32 30 0D 36 31 0D 37 31 0D 38 30 0D"
    "39 32 0D 3B 32 38 30 36 36 39 37 0D 3C 20 20 20 20 20 20 20 20 0D 3D 30 30 30 30 0D"
    "3E 37 31 0D 3F 80 0D 40 84 0D 41 81 0D 42 81 0D 43 C0 0D 44 81 0D 45 81 0D"
    "46 89 80 80 0D 4C 80 0D 3D 31 33 30 30 0D 51 30 0D 4F 0D 33 31 0D 38 31 0D 53 30 0D FF 0D");

// Real TS-480HX, 2026-11-13
const std::string REAL_BOOT = fromHex(
    "30 31 0D 3A 20 20 0D 52 30 0D 32 30 0D 36 31 0D 37 30 0D 38 30 0D 39 32 0D"
    "3B 20 37 30 37 38 32 37 0D 3C 20 20 20 20 20 20 20 20 0D 3D 30 30 30 30 0D 3E 37 31 0D"
    "3F 80 0D 40 88 0D 41 85 0D 42 80 0D 43 88 0D 44 81 0D 45 81 0D 46 89 80 80 0D 4C 80 0D");

// A transport that records what the link writes and plays back what a test feeds.
class FakeTransport : public Ts480Transport {
 public:
  std::vector<std::string> written;
  std::string toRead;
  bool open(std::string *) override { opened = true; return true; }
  void close() override { opened = false; }
  bool isOpen() const override { return opened; }
  int read(uint8_t *buffer, size_t size, int) override {
    size_t n = std::min(size, toRead.size());
    std::copy(toRead.begin(), toRead.begin() + (long)n, buffer);
    toRead.erase(0, n);
    return (int)n;
  }
  bool write(const std::string &data) override { written.push_back(data); return true; }
  std::string describe() const override { return "fake"; }
  bool opened = false;
};

}  // namespace

TEST_CASE("ts480: stianeklund boot dump") {
  Run r = run(BOOT);
  CHECK(r.state.power == 1);
  CHECK(r.state.freqText() == "28.066.97");
  CHECK(r.state.frequencyHz() == 28066970);
  CHECK(r.state.meterMain == 13);
  CHECK(r.state.meterSub == 0);
  CHECK(r.state.lamp == 1);
  CHECK(r.state.brightness == 1);
  CHECK(r.state.backlight);
  for (const char *icon : {"ANT1", "AGC", "A", "AUTO", "\xE2\x97\x82" "1"}) CHECK(hasIcon(r.state, icon));
  CHECK(r.state.model == "RX only");
  REQUIRE(r.actions.size() == 2);
  CHECK(r.actions[0] == Action::Query);
  CHECK(r.actions[1] == Action::Keepalive);
}

TEST_CASE("ts480: XIT status line") {
  Run r = run(fromHex("3C 20 20 20 20 31 37 36 30 0D 43 E8 0D 46 89 81 80 0D"));
  CHECK(trim(r.state.statusText()) == "1.760");
  for (const char *icon : {"XIT", "PC", "AUTO"}) CHECK(hasIcon(r.state, icon));
}

TEST_CASE("ts480: frames split across reads") {
  FrameReader reader;
  CHECK(reader.feed(std::string(";28")).empty());
  CHECK(reader.feed(std::string("50000\r=08")) == std::vector<std::string>{";2850000"});
  CHECK(reader.feed(std::string("00\r")) == std::vector<std::string>{"=0800"});
}

TEST_CASE("ts480: panel messages") {
  CHECK(keyMsg(*findKey("NB"), KEY_DOWN) == ":1\r");
  CHECK(keyMsg(*findKey("POWER"), KEY_DOWN) == "01\r");
  CHECK(vfoMsg(1) == "S0001\r");
  CHECK(vfoMsg(-2) == "SFFFE\r");
  CHECK(multiMsg(-1) == "TFF\r");
  CHECK(ritMsg(1) == "U01\r");
  CHECK(ifshiftMsg(0x201) == "X0201\r");
  CHECK(volumeMsg(0x2A) == "V2A\r");
  CHECK(decodePanelFrame("SFFFE") == "VFO -2");
  CHECK(decodePanelFrame("N1") == "KEY RIT down");
  CHECK(keyMsg(*findKey("SCAN"), KEY_DOWN) == "E1\r");
  CHECK(keyMsg(*findKey("MODE"), KEY_DOWN) == "F1\r");
}

TEST_CASE("ts480: real boot dump") {
  Run r = run(REAL_BOOT);
  json d = json::parse(r.state.toJson());
  CHECK(d["freq"] == " 7.078.27");
  CHECK(d["freq_hz"] == 7078270);
  CHECK(d["mode"] == "USB");
  for (const char *icon : {"ANT2", "AGC", "-F", "PC", "A"}) CHECK(hasIcon(r.state, icon));
}

TEST_CASE("ts480: mode digit is the CAT MD code") {
  CHECK(modeName(1) == "LSB");
  CHECK(modeName(2) == "USB");
  CHECK(modeName(3) == "CW");
  CHECK(modeName(4) == "FM");
  CHECK(modeName(5) == "AM");
  CHECK(modeName(6) == "FSK");
  CHECK(modeName(7) == "CW-R");
  CHECK(modeName(9) == "FSK-R");
  CHECK(isVoiceMode(1));
  CHECK(isVoiceMode(2));
  CHECK(isVoiceMode(4));
  CHECK(isVoiceMode(5));
  CHECK_FALSE(isVoiceMode(3));
  CHECK_FALSE(isVoiceMode(6));
  CHECK_FALSE(isVoiceMode(-1));
}

TEST_CASE("ts480: verified flag bits") {
  const std::vector<std::pair<std::string, std::string>> cases = {
      {"?\x82", "ATT"}, {"?\x81", "PRE"}, {"?\x84", "PROC"}, {"?\x90", "NB"}, {"?\xc0", "FINE"},
      {"B\x88", "NR1"}, {"B\x84", "NR2"}, {"B\xa0", "BC1"}, {"B\x90", "BC2"}, {"B\xc0", "DNL"},
      {"C\x90", "RIT"}, {"C\xa0", "XIT"}, {"C\x81", "T"}, {"C\x82", "CT"}, {"@\x84", "ANT1"}};
  for (const auto &c : cases) {
    DisplayState s;
    s.apply(c.first);
    CHECK_MESSAGE(hasIcon(s, c.second), c.second);
  }
}

TEST_CASE("ts480: RIT offset status in Hz") {
  Run r = run(std::string("<   -0001\rF\x89\x81\x80\r"));
  CHECK(trim(r.state.statusText()) == "-0.001");
}

TEST_CASE("ts480: menu frames") {
  Run r = run(std::string(":10\rP0A\r2E\r400\r@\x98\r"));
  json d = json::parse(r.state.toJson());
  CHECK(d["menu_no"] == "10");
  CHECK(d["menu_item"] == 10);
  CHECK(d["menu_value"] == 0);
  CHECK(d["param"] == "E");
  CHECK(hasIcon(r.state, "MENU"));
  r.state.apply("P30");
  r.state.apply("443");
  CHECK(r.state.menuItem == 48);
  CHECK(r.state.menuValue == 67);
}

TEST_CASE("ts480: high latin-1 bytes stay valid JSON") {
  DisplayState s;
  s.apply(std::string(";\xB0\xA0" "12345"));
  json parsed;
  CHECK_NOTHROW(parsed = json::parse(s.toJson()));
  CHECK(parsed.is_object());
}

TEST_CASE("ts480 link: POWER sends on/off, not press/release") {
  auto *fake = new FakeTransport;
  Ts480Link link(std::unique_ptr<Ts480Transport>(fake), {});
  link.pumpForTest(Ts480Link::Clock::now());   // opens, sends 02
  fake->written.clear();
  link.keyDown("POWER");
  link.keyUp("POWER");
  REQUIRE(fake->written.size() == 1);
  CHECK(fake->written[0] == "01\r");
  fake->toRead = "01\r";
  link.pumpForTest(Ts480Link::Clock::now());
  fake->written.clear();
  link.keyDown("POWER");
  link.keyUp("POWER");
  REQUIRE(fake->written.size() == 1);
  CHECK(fake->written[0] == "00\r");
}

TEST_CASE("ts480 link: answers keepalive and the pot query") {
  auto *fake = new FakeTransport;
  Ts480Link link(std::unique_ptr<Ts480Transport>(fake), {});
  const auto t0 = Ts480Link::Clock::now();
  link.pumpForTest(t0);
  CHECK(fake->written.at(0) == "02\r");
  fake->written.clear();
  link.setPot("af", 0x40);
  fake->written.clear();
  fake->toRead = std::string("\xFF\rO\r", 4);
  link.pumpForTest(t0 + std::chrono::milliseconds(10));
  REQUIRE(fake->written.size() >= 2);
  CHECK(fake->written[0] == std::string("\xFF\r", 2));
  CHECK(fake->written[1] == "X01FF\rV40\rW00\r" + std::string("\xFF\r", 2));
  CHECK(link.connected());
}

TEST_CASE("ts480 link: long press after 1 s, encoders flushed in clamped parts") {
  auto *fake = new FakeTransport;
  Ts480Link link(std::unique_ptr<Ts480Transport>(fake), {});
  const auto t0 = Ts480Link::Clock::now();
  link.pumpForTest(t0);
  fake->written.clear();
  link.keyDown("NB");
  CHECK(fake->written.back() == ":1\r");
  link.pumpForTest(t0 + std::chrono::milliseconds(500));
  CHECK(fake->written.back() == ":1\r");
  link.pumpForTest(t0 + std::chrono::milliseconds(1100));
  CHECK(fake->written.back() == ":3\r");
  link.keyUp("NB");
  CHECK(fake->written.back() == ":0\r");

  fake->written.clear();
  link.encoder("multi", 200);
  link.pumpForTest(t0 + std::chrono::milliseconds(1200));
  link.pumpForTest(t0 + std::chrono::milliseconds(1270));
  std::vector<std::string> t;
  for (const std::string &w : fake->written)
    if (w[0] == 'T') t.push_back(w);
  REQUIRE(t.size() == 2);
  CHECK(t[0] == "T7F\r");
  CHECK(t[1] == "T49\r");   // 200 - 127 = 73
}

TEST_CASE("ts480 link: power restore") {
  using std::chrono::milliseconds;
  SUBCASE("was on, radio still on after a quick restart: nothing sent") {
    auto *fake = new FakeTransport;
    Ts480LinkOptions o;
    o.restorePower = true;
    Ts480Link link(std::unique_ptr<Ts480Transport>(fake), o);
    const auto t0 = Ts480Link::Clock::now();
    link.pumpForTest(t0);
    fake->toRead = "00\r01\r";   // the radio's answer to 02 while on
    link.pumpForTest(t0 + milliseconds(100));
    fake->written.clear();
    link.pumpForTest(t0 + milliseconds(3000));
    for (const std::string &w : fake->written) CHECK(w != "01\r");
  }
  SUBCASE("was on, radio off now: 01 sent, retried, then given up") {
    auto *fake = new FakeTransport;
    Ts480LinkOptions o;
    o.restorePower = true;
    Ts480Link link(std::unique_ptr<Ts480Transport>(fake), o);
    const auto t0 = Ts480Link::Clock::now();
    link.pumpForTest(t0);
    fake->written.clear();
    int ons = 0;
    for (int t = 100; t < 20000; t += 100) {
      link.pumpForTest(t0 + milliseconds(t));
    }
    for (const std::string &w : fake->written)
      if (w == "01\r") ons++;
    CHECK(ons == Ts480Link::kRestoreAttempts);
  }
  SUBCASE("was off: never switched on") {
    auto *fake = new FakeTransport;
    Ts480Link link(std::unique_ptr<Ts480Transport>(fake), {});
    const auto t0 = Ts480Link::Clock::now();
    link.pumpForTest(t0);
    for (int t = 100; t < 10000; t += 100) link.pumpForTest(t0 + milliseconds(t));
    for (const std::string &w : fake->written) CHECK(w != "01\r");
  }
  SUBCASE("power changes are persisted once they hold for 2 s") {
    auto *fake = new FakeTransport;
    std::vector<bool> saved;
    Ts480LinkOptions o;
    o.persistPower = [&saved](bool on) { saved.push_back(on); };
    Ts480Link link(std::unique_ptr<Ts480Transport>(fake), o);
    const auto t0 = Ts480Link::Clock::now();
    link.pumpForTest(t0);
    fake->toRead = "01\r";
    link.pumpForTest(t0 + milliseconds(100));
    link.pumpForTest(t0 + milliseconds(1000));
    CHECK(saved.empty());
    link.pumpForTest(t0 + milliseconds(2200));
    REQUIRE(saved.size() == 1);
    CHECK(saved[0] == true);
    fake->toRead = "00\r";
    link.pumpForTest(t0 + milliseconds(3000));
    link.pumpForTest(t0 + milliseconds(5100));
    REQUIRE(saved.size() == 2);
    CHECK(saved[1] == false);
  }
}

TEST_CASE("ts480 link: direct frequency macro") {
  auto *fake = new FakeTransport;
  Ts480Link link(std::unique_ptr<Ts480Transport>(fake), {});
  const auto t0 = Ts480Link::Clock::now();
  link.pumpForTest(t0);
  fake->written.clear();
  link.directFreq(7074.0);   // 0707400 -> "07074"
  for (int t = 0; t < 3000; t += 20) link.pumpForTest(t0 + std::chrono::milliseconds(t));
  std::string downs;
  for (const std::string &w : fake->written)
    if (w.size() == 3 && w[1] == '1') downs += w[0];
  // ENT '?', 0 '>', 7 ':', 0 '>', 7 ':', 4 '7', ENT '?'
  CHECK(downs == "?>:>:7?");
}

TEST_CASE("ts480 sim: power on, redraw, keys through the real link thread") {
  auto *sim = new SimTs480Transport(200);
  Ts480Link link(std::unique_ptr<Ts480Transport>(sim), {});
  link.start();
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  CHECK(link.power() == 0);
  link.keyDown("POWER");
  for (int i = 0; i < 40 && link.modeCode() < 0; i++) std::this_thread::sleep_for(std::chrono::milliseconds(50));
  CHECK(link.power() == 1);
  CHECK(link.modeCode() == 2);
  CHECK(link.connected());
  // The sim asks for the pots after boot ("O"); the link answers with AF 0.
  for (int i = 0; i < 20 && sim->pots().empty(); i++) std::this_thread::sleep_for(std::chrono::milliseconds(50));
  CHECK(sim->pots()['V'] == 0);
  link.keyDown("MODE");
  link.keyUp("MODE");
  std::this_thread::sleep_for(std::chrono::milliseconds(150));
  CHECK(link.modeCode() == 1);   // USB -> LSB
  link.encoder("vfo", 10);
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  CHECK(sim->frequency() == 14074050);
  json snap = json::parse(link.snapshotJson());
  CHECK(snap["type"] == "state");
  CHECK(snap["state"]["mode"] == "LSB");
  CHECK(snap["state"]["freq_hz"] == 14074050);
  link.stop();
}

// ---- WebSocket framing (ws_frame.h) ------------------------------------

#include "ws_frame.h"

TEST_CASE("ws: RFC 6455 accept key example") {
  CHECK(Ws::acceptKey("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
}

TEST_CASE("ws: masked client frame, split delivery, 16-bit length") {
  // RFC 6455 5.7: a masked "Hello"
  const std::string masked = fromHex("81 85 37 fa 21 3d 7f 9f 4d 51 58");
  int opcode = 0;
  std::string payload;
  size_t consumed = 0;
  CHECK(Ws::parseFrame(masked.substr(0, 4), &opcode, &payload, &consumed) == 0);
  REQUIRE(Ws::parseFrame(masked + "x", &opcode, &payload, &consumed) == 1);
  CHECK(opcode == 1);
  CHECK(payload == "Hello");
  CHECK(consumed == masked.size());

  const std::string big(300, 'a');
  const std::string frame = Ws::buildFrame(2, big);
  CHECK((uint8_t)frame[1] == 126);
  REQUIRE(Ws::parseFrame(frame, &opcode, &payload, &consumed) == 1);
  CHECK(opcode == 2);
  CHECK(payload == big);

  CHECK(Ws::parseFrame(fromHex("C1 00"), &opcode, &payload, &consumed) == -1);   // RSV bit set
}

// ---- PTT arbitration (ptt_arbiter.h) ------------------------------------

#include "ptt_arbiter.h"

namespace {
class FakeKeying : public KeyingBackend {
 public:
  bool ptt = false;
  bool busy = false;
  bool sendCwText(const std::string &) override { return !busy; }
  uint8_t getCwSpeedRaw() override { return 0; }
  bool setCwSpeedRaw(uint8_t) override { return true; }
  bool setAudioPtt(bool on) override {
    if (busy) return false;
    ptt = on;
    return true;
  }
  bool getAudioPtt() const override { return ptt; }
};
}  // namespace

TEST_CASE("ptt arbiter: first owner wins, the other is refused") {
  FakeKeying inner;
  PttArbiter arbiter(inner);
  std::string why;

  CHECK(arbiter.setAudioPtt(true));   // wifilt keys
  CHECK_FALSE(arbiter.browserPtt(true, &why));
  CHECK(why == "wifilt is transmitting");
  CHECK(arbiter.setAudioPtt(false));
  CHECK_FALSE(inner.ptt);

  CHECK(arbiter.browserPtt(true, &why));   // browser keys
  CHECK(inner.ptt);
  CHECK(arbiter.browserOwns());
  CHECK_FALSE(arbiter.setAudioPtt(true));      // wifilt refused
  CHECK(arbiter.setAudioPtt(false));           // wifilt's "off" does not unkey the browser
  CHECK(inner.ptt);
  CHECK_FALSE(arbiter.sendCwText("TEST"));     // no CW over the browser's transmission
  CHECK(arbiter.browserPtt(false, nullptr));
  CHECK_FALSE(inner.ptt);
  CHECK_FALSE(arbiter.browserOwns());

  inner.busy = true;   // CW job keying
  why.clear();
  CHECK_FALSE(arbiter.browserPtt(true, &why));
  CHECK(why == "CW/FSK keying in progress");
}
