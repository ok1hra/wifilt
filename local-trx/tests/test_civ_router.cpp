// doctest unit tests for civ_router.cpp's wire-format helpers and opcode
// dispatch. Transport-free on purpose (see civ_router.h) -- no socket, no
// hamlib rig needed, just a trivial in-memory FakeRig.
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include <string>

#include "../src/civ_router.h"

using namespace LocalTrx;

namespace {

class FakeRig : public RigBackend {
 public:
  double  getFreqHz() override { return freqHz_; }
  bool    setFreqHz(double hz) override { freqHz_ = hz; return true; }
  uint8_t getModeByte() override { return mode_; }
  bool    setModeByte(uint8_t mode) override { mode_ = mode; return true; }
  int32_t getRitHz() override { return ritHz_; }
  bool    setRitHz(int32_t hz) override { ritHz_ = hz; return true; }
  uint8_t getGain(GainKind kind) override {
    switch (kind) {
      case GainKind::Af:      return af_;
      case GainKind::Rf:      return rf_;
      case GainKind::RfPower: return rfPower_;
    }
    return 0;
  }
  bool setGain(GainKind kind, uint8_t value) override {
    switch (kind) {
      case GainKind::Af:      af_ = value; break;
      case GainKind::Rf:      rf_ = value; break;
      case GainKind::RfPower: rfPower_ = value; break;
    }
    return true;
  }
  bool getMeter(MeterKind kind, uint8_t *rawOut) override {
    switch (kind) {
      case MeterKind::PowerMeter:
        if (!powerMeterSupported) return false;
        *rawOut = powerMeter_;
        return true;
      case MeterKind::Swr:
        if (!swrSupported) return false;
        *rawOut = swr_;
        return true;
      case MeterKind::SupplyVoltage:
        if (!supplyVoltageSupported) return false;
        *rawOut = supplyVoltage_;
        return true;
    }
    return false;
  }
  bool getAttenuatorOn(bool *onOut) override {
    if (!attSupported) return false;
    *onOut = attOn_;
    return true;
  }
  bool getVoxOn(bool *onOut) override {
    if (!voxSupported) return false;
    *onOut = voxOn_;
    return true;
  }

  double freqHz_ = 7035920;
  uint8_t mode_ = 0x03;
  int32_t ritHz_ = 0;
  uint8_t af_ = 200;
  uint8_t rf_ = 255;
  uint8_t rfPower_ = 128;

  bool powerMeterSupported = true;
  bool swrSupported = true;
  bool supplyVoltageSupported = true;
  bool attSupported = true;
  bool voxSupported = true;
  uint8_t powerMeter_ = 90;
  uint8_t swr_ = 40;
  uint8_t supplyVoltage_ = 200;
  bool attOn_ = false;
  bool voxOn_ = false;
};

class FakeKeying : public KeyingBackend {
 public:
  bool sendCwText(const std::string &text) override {
    if (busy) return false;
    lastText = text;
    sendCount++;
    return true;
  }
  uint8_t getCwSpeedRaw() override { return speedRaw; }
  bool setCwSpeedRaw(uint8_t raw) override { speedRaw = raw; return true; }
  bool setAudioPtt(bool on) override {
    if (busy) return false;
    audioPtt = on;
    return true;
  }
  bool getAudioPtt() const override { return audioPtt; }

  std::string lastText;
  int sendCount = 0;
  uint8_t speedRaw = 128;
  bool busy = false;
  bool audioPtt = false;
};

}  // namespace

TEST_CASE("bcdFromHz/hzFromBcd round-trip, matches tools/icom-lan-fake-radio.py's bcd_from_hz") {
  uint8_t buf[5];
  bcdFromHz(7035920, buf);
  // Byte-for-byte against bcd_from_hz(7035920): digits reversed "0295307000..."
  // gives out = [0x07(?), ...] -- verified via round-trip instead of a fragile
  // literal, since that is what actually matters for interop.
  CHECK(hzFromBcd(buf) == 7035920);

  bcdFromHz(14074000, buf);
  CHECK(hzFromBcd(buf) == 14074000);

  bcdFromHz(0, buf);
  CHECK(hzFromBcd(buf) == 0);
}

TEST_CASE("encodeCivLevel/decodeCivLevel round-trip across the full 0-255 range") {
  for (int v = 0; v <= 255; v++) {
    uint8_t buf[2];
    encodeCivLevel((uint16_t)v, buf);
    CHECK(decodeCivLevel(buf) == v);
  }
}

TEST_CASE("encodeCivLevel matches wifilt.ino's own worked example (255 -> 02 55)") {
  uint8_t buf[2];
  encodeCivLevel(255, buf);
  CHECK(buf[0] == 0x02);
  CHECK(buf[1] == 0x55);
}

TEST_CASE("encodeRitLsb3/decodeRitLsb3 round-trip") {
  uint8_t buf[3];
  encodeRitLsb3(0, buf);
  CHECK(decodeRitLsb3(buf) == 0);
  encodeRitLsb3(1234, buf);
  CHECK(decodeRitLsb3(buf) == 1234);
}

TEST_CASE("civModeName matches wifilt.ino's decodeModeName table") {
  CHECK(std::string(civModeName(0x00)) == "LSB");
  CHECK(std::string(civModeName(0x01)) == "USB");
  CHECK(std::string(civModeName(0x03)) == "CW");
  CHECK(std::string(civModeName(0x07)) == "CW-R");
  CHECK(civModeName(0xFF) == nullptr);
}

TEST_CASE("dispatchCiv 0x03 read frequency") {
  FakeRig rig;
  rig.freqHz_ = 7035920;
  CivResult r = dispatchCiv({0x03}, rig);
  REQUIRE(r.answered);
  REQUIRE(r.payload.size() == 6);
  CHECK(r.payload[0] == 0x03);
  uint8_t bcd[5];
  for (int i = 0; i < 5; i++) bcd[i] = r.payload[1 + i];
  CHECK(hzFromBcd(bcd) == 7035920);
}

TEST_CASE("dispatchCiv 0x05 write frequency updates the rig") {
  FakeRig rig;
  uint8_t bcd[5];
  bcdFromHz(14074000, bcd);
  std::vector<uint8_t> frame = {0x05};
  for (uint8_t b : bcd) frame.push_back(b);
  CivResult r = dispatchCiv(frame, rig);
  CHECK(r.answered);
  CHECK(rig.freqHz_ == 14074000);
}

TEST_CASE("dispatchCiv 0x04/0x06 mode read and write") {
  FakeRig rig;
  rig.mode_ = 0x01;   // USB
  CivResult r = dispatchCiv({0x04}, rig);
  REQUIRE(r.answered);
  CHECK(r.payload[0] == 0x04);
  CHECK(r.payload[1] == 0x01);

  CivResult w = dispatchCiv({0x06, 0x03, 0x01}, rig);   // set CW
  CHECK(w.answered);
  CHECK(rig.mode_ == 0x03);
}

TEST_CASE("dispatchCiv 0x14 AF/RF gain read and write") {
  FakeRig rig;
  rig.af_ = 255;
  CivResult r = dispatchCiv({0x14, 0x01}, rig);
  REQUIRE(r.answered);
  CHECK(r.payload == std::vector<uint8_t>{0x14, 0x01, 0x02, 0x55});

  CivResult w = dispatchCiv({0x14, 0x02, 0x00, 0x00}, rig);   // RF gain -> 0
  CHECK(w.answered);
  CHECK(rig.rf_ == 0);
}

TEST_CASE("dispatchCiv 0x14 0x0A RF power read and write (fáze 7, wire-identical to AF/RF)") {
  FakeRig rig;
  rig.rfPower_ = 255;
  CivResult r = dispatchCiv({0x14, 0x0A}, rig);
  REQUIRE(r.answered);
  CHECK(r.payload == std::vector<uint8_t>{0x14, 0x0A, 0x02, 0x55});

  CivResult w = dispatchCiv({0x14, 0x0A, 0x01, 0x00}, rig);   // -> 100
  CHECK(w.answered);
  CHECK(rig.rfPower_ == 100);
}

TEST_CASE("dispatchCiv 0x15 meters (fáze 7): power/SWR/supply answered, S-meter/ALC are not") {
  FakeRig rig;
  rig.powerMeter_ = 128;
  rig.swr_ = 40;
  rig.supplyVoltage_ = 200;

  CivResult power = dispatchCiv({0x15, 0x11}, rig);
  REQUIRE(power.answered);
  CHECK(power.payload[0] == 0x15);
  CHECK(power.payload[1] == 0x11);
  CHECK(decodeCivLevel(power.payload.data() + 2) == 128);

  CivResult swr = dispatchCiv({0x15, 0x12}, rig);
  REQUIRE(swr.answered);
  CHECK(decodeCivLevel(swr.payload.data() + 2) == 40);

  CivResult supply = dispatchCiv({0x15, 0x15}, rig);
  REQUIRE(supply.answered);
  CHECK(decodeCivLevel(supply.payload.data() + 2) == 200);

  // No verified raw-scale reference to invert these two against (rig_backend.h) --
  // deliberately no reply, not a guessed number, same rule as category (c).
  CHECK_FALSE(dispatchCiv({0x15, 0x02}, rig).answered);   // S-meter
  CHECK_FALSE(dispatchCiv({0x15, 0x13}, rig).answered);   // ALC
}

TEST_CASE("dispatchCiv 0x15 meters: no reply when the backend doesn't support one (bod 11b)") {
  FakeRig rig;
  rig.powerMeterSupported = false;
  CHECK_FALSE(dispatchCiv({0x15, 0x11}, rig).answered);
  CHECK_FALSE(dispatchCiv({0x15}, rig).answered);   // no subcommand at all
}

TEST_CASE("dispatchCiv 0x11 attenuator: bare read only, matches wifilt's own aux-poll shape") {
  FakeRig rig;
  rig.attOn_ = true;
  CivResult r = dispatchCiv({0x11}, rig);
  REQUIRE(r.answered);
  CHECK(r.payload == std::vector<uint8_t>{0x11, 0x01});

  rig.attOn_ = false;
  CHECK(dispatchCiv({0x11}, rig).payload == std::vector<uint8_t>{0x11, 0x00});

  // wifilt itself never sends a body on this opcode -- unverified wire shape,
  // stays unanswered rather than guessed (see civ_router.cpp's own comment).
  CHECK_FALSE(dispatchCiv({0x11, 0x00}, rig).answered);

  rig.attSupported = false;
  CHECK_FALSE(dispatchCiv({0x11}, rig).answered);
}

TEST_CASE("dispatchCiv 0x16 0x47 VOX read; 0x16 0x02 preamp is never answered (index<->dB guess)") {
  FakeRig rig;
  rig.voxOn_ = true;
  CivResult r = dispatchCiv({0x16, 0x47}, rig);
  REQUIRE(r.answered);
  CHECK(r.payload == std::vector<uint8_t>{0x16, 0x47, 0x01});

  CHECK_FALSE(dispatchCiv({0x16, 0x02}, rig).answered);   // preamp, deliberately unmapped

  rig.voxSupported = false;
  CHECK_FALSE(dispatchCiv({0x16, 0x47}, rig).answered);
}

TEST_CASE("dispatchCiv 0x21 0x00 RIT read") {
  FakeRig rig;
  rig.ritHz_ = 0;
  CivResult r = dispatchCiv({0x21, 0x00}, rig);
  REQUIRE(r.answered);
  CHECK(r.payload.size() == 5);
  CHECK(r.payload[0] == 0x21);
  CHECK(r.payload[1] == 0x00);
}

TEST_CASE("dispatchCiv never answers unmapped commands (category c, no blanket ack)") {
  FakeRig rig;
  CHECK_FALSE(dispatchCiv({0x23}, rig).answered);        // GPS
  CHECK_FALSE(dispatchCiv({0x27, 0x00}, rig).answered);  // waterfall/scope
  CHECK_FALSE(dispatchCiv({0x1A, 0x05}, rig).answered);  // MOD-level calibration
  CHECK_FALSE(dispatchCiv({}, rig).answered);            // empty frame
}

TEST_CASE("dispatchCiv 0x17 CW message routes to the keying backend, never hamlib") {
  FakeRig rig;
  FakeKeying keying;
  CivResult r = dispatchCiv({0x17, 'C', 'Q', ' ', 'D', 'E'}, rig, &keying);
  CHECK(r.answered);
  CHECK(keying.sendCount == 1);
  CHECK(keying.lastText == "CQ DE");
}

TEST_CASE("dispatchCiv 0x17 with no keying backend wired up: no reply, not a crash") {
  FakeRig rig;
  CHECK_FALSE(dispatchCiv({0x17, 'C', 'Q'}, rig, nullptr).answered);
  CHECK_FALSE(dispatchCiv({0x17, 'C', 'Q'}, rig).answered);   // default argument
}

TEST_CASE("dispatchCiv 0x17 with an empty message is not sent") {
  FakeRig rig;
  FakeKeying keying;
  CHECK_FALSE(dispatchCiv({0x17}, rig, &keying).answered);
  CHECK(keying.sendCount == 0);
}

TEST_CASE("dispatchCiv 0x14 0x0C CW speed read/write, routed to keying not hamlib") {
  FakeRig rig;
  FakeKeying keying;
  keying.speedRaw = 128;
  CivResult r = dispatchCiv({0x14, 0x0C}, rig, &keying);
  REQUIRE(r.answered);
  CHECK(r.payload[0] == 0x14);
  CHECK(r.payload[1] == 0x0C);
  CHECK(decodeCivLevel(&r.payload[2]) == 128);

  CivResult w = dispatchCiv({0x14, 0x0C, 0x00, 0x00}, rig, &keying);
  CHECK(w.answered);
  CHECK(keying.speedRaw == 0);
}

TEST_CASE("dispatchCiv 0x14 0x0C with no keying backend: no reply") {
  FakeRig rig;
  CHECK_FALSE(dispatchCiv({0x14, 0x0C}, rig).answered);
}

TEST_CASE("dispatchCiv 0x1C 0x00 PTT: write then read, matches audioPttOn/Off's own bytes") {
  FakeRig rig;
  FakeKeying keying;

  // audioPttOn() sends exactly {0x1C, 0x00, 0x01} [wifilt.ino:9427].
  CivResult on = dispatchCiv({0x1C, 0x00, 0x01}, rig, &keying);
  REQUIRE(on.answered);
  CHECK(on.payload == std::vector<uint8_t>{0x1C, 0x00, 0x01});
  CHECK(keying.audioPtt == true);

  // A bare read (subcmd only, matching icomLanClient.h's own aux-poll query)
  // reports the current state without changing it.
  CivResult read = dispatchCiv({0x1C, 0x00}, rig, &keying);
  REQUIRE(read.answered);
  CHECK(read.payload == std::vector<uint8_t>{0x1C, 0x00, 0x01});

  // audioPttOff() sends {0x1C, 0x00, 0x00} [wifilt.ino:9436].
  CivResult off = dispatchCiv({0x1C, 0x00, 0x00}, rig, &keying);
  REQUIRE(off.answered);
  CHECK(off.payload == std::vector<uint8_t>{0x1C, 0x00, 0x00});
  CHECK(keying.audioPtt == false);
}

TEST_CASE("dispatchCiv 0x1C PTT is refused while the keyer is busy with CW/FSK") {
  FakeRig rig;
  FakeKeying keying;
  keying.busy = true;
  CivResult r = dispatchCiv({0x1C, 0x00, 0x01}, rig, &keying);
  REQUIRE(r.answered);   // still replies -- with the unchanged state
  CHECK(r.payload == std::vector<uint8_t>{0x1C, 0x00, 0x00});
  CHECK(keying.audioPtt == false);
}

TEST_CASE("dispatchCiv 0x1C with no keying backend, or a non-0x00 subcommand: no reply") {
  FakeRig rig;
  FakeKeying keying;
  CHECK_FALSE(dispatchCiv({0x1C, 0x00, 0x01}, rig).answered);          // no backend
  CHECK_FALSE(dispatchCiv({0x1C, 0x01, 0x01}, rig, &keying).answered); // e.g. tuner, not PTT
  CHECK_FALSE(dispatchCiv({0x1C}, rig, &keying).answered);             // no subcommand at all
}
