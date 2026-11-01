// tx_level.h: the sound card mixer as the radio's MOD level, against a fake
// mixer with hardware-like steps.
#include "doctest.h"

#include <cmath>
#include <vector>

#include "../src/civ_router.h"
#include "../src/tx_level.h"

using namespace LocalTrx;

namespace {

// A mixer with fixed steps, like a USB codec's: -45..+6 dB in 1.5 dB.
class SteppedMixer : public MixerControl {
 public:
  bool range(double *lo, double *hi) override {
    if (!ok) return false;
    *lo = minDb;
    *hi = maxDb;
    return true;
  }
  bool getDb(double *db) override {
    if (!ok) return false;
    *db = db_;
    return true;
  }
  bool setDbAtOrAbove(double want, double *got) override {
    if (!ok) return false;
    sets++;
    if (want < minDb) want = minDb;
    if (want > maxDb) want = maxDb;
    db_ = minDb + std::ceil((want - minDb) / step - 1e-9) * step;
    if (db_ > maxDb) db_ = maxDb;
    *got = db_;
    return true;
  }
  std::string describe() const override { return "fake mixer"; }

  bool ok = true;
  double minDb = -45.0, maxDb = 6.0, step = 1.5;
  double db_ = 0.0;
  int sets = 0;
};

struct Rig {
  SteppedMixer mixer;
  float trim = -1.0f;
  std::vector<std::pair<int, double>> saved;
  TxLevel level{mixer, [this](float t) { trim = t; },
                [this](int l, double db) { saved.push_back({l, db}); }};
  Rig() { REQUIRE(level.open(nullptr)); }

  // What actually reaches the radio, relative to the mixer's maximum.
  double amplitude() const { return std::pow(10.0, (mixer.db_ - mixer.maxDb) / 20.0) * trim; }
};

// A rig backend that answers nothing -- 1A 05 99 99 must not need one.
class NoRig : public RigBackend {
 public:
  bool getFreqHz(double *) override { return false; }
  bool setFreqHz(double) override { return false; }
  bool getMode(uint8_t *, bool *) override { return false; }
  bool setMode(uint8_t, bool) override { return false; }
  bool getRitHz(int32_t *) override { return false; }
  bool setRitHz(int32_t) override { return false; }
  bool getGain(GainKind, uint8_t *) override { return false; }
  bool setGain(GainKind, uint8_t) override { return false; }
  bool getMeter(MeterKind, uint8_t *) override { return false; }
  bool getAttenuatorOn(bool *) override { return false; }
  bool getVoxOn(bool *) override { return false; }
};

}  // namespace

TEST_CASE("TxLevel: every level reads back exactly and plays at level/255 of the mixer's maximum") {
  Rig r;
  for (int want : {255, 254, 200, 128, 37, 5, 1}) {
    REQUIRE(r.level.setModLevel((uint8_t)want));
    uint8_t got = 0;
    REQUIRE(r.level.getModLevel(&got));
    CHECK(got == want);
    CHECK(r.trim <= 1.0f);
    CHECK(r.trim > std::pow(10.0, -1.5 / 20.0) - 1e-6);   // never more than one step of trim
    CHECK(r.amplitude() == doctest::Approx(want / 255.0).epsilon(1e-5));
    REQUIRE(!r.saved.empty());
    CHECK(r.saved.back().first == want);
    CHECK(r.saved.back().second == doctest::Approx(r.mixer.db_));
  }
}

TEST_CASE("TxLevel: 255 is the mixer at its maximum with no trim, 0 is silence") {
  Rig r;
  REQUIRE(r.level.setModLevel(255));
  CHECK(r.mixer.db_ == doctest::Approx(6.0));
  CHECK(r.trim == doctest::Approx(1.0f));
  REQUIRE(r.level.setModLevel(0));
  CHECK(r.mixer.db_ == doctest::Approx(-45.0));
  CHECK(r.trim == 0.0f);
  uint8_t got = 99;
  REQUIRE(r.level.getModLevel(&got));
  CHECK(got == 0);
}

TEST_CASE("TxLevel: a mixer moved by someone else drops the trim and reports the mixer alone") {
  Rig r;
  REQUIRE(r.level.setModLevel(100));
  r.mixer.db_ -= 6.0;   // a desktop volume slider
  uint8_t got = 0;
  REQUIRE(r.level.getModLevel(&got));
  CHECK(r.trim == doctest::Approx(1.0f));
  CHECK(got == (uint8_t)std::lround(255.0 * std::pow(10.0, (r.mixer.db_ - 6.0) / 20.0)));
  CHECK(got != 100);   // wifilt sees a MOD level it did not set -> stale table
  CHECK(r.saved.back().first == -1);
}

TEST_CASE("TxLevel: a mute-sentinel minimum is not taken at face value") {
  Rig r;
  r.mixer.minDb = -9999999.0 / 100.0;
  r.mixer.step = 0.5;
  TxLevel level{r.mixer, [&r](float t) { r.trim = t; }, nullptr};
  REQUIRE(level.open(nullptr));
  REQUIRE(level.setModLevel(0));
  CHECK(r.mixer.db_ >= 6.0 - TxLevel::kFloorBelowMaxDb - 0.5);
}

TEST_CASE("TxLevel: restore brings the trim back only while the mixer is where it was left") {
  Rig first;
  REQUIRE(first.level.setModLevel(77));
  const auto saved = first.saved.back();

  Rig same;
  same.mixer.db_ = saved.second;
  same.level.restore(saved.first, saved.second);
  uint8_t got = 0;
  REQUIRE(same.level.getModLevel(&got));
  CHECK(got == 77);
  CHECK(same.trim == doctest::Approx(first.trim));

  Rig moved;
  moved.mixer.db_ = saved.second + 3.0;
  moved.level.restore(saved.first, saved.second);
  CHECK(moved.trim == -1.0f);   // never touched
  REQUIRE(moved.level.getModLevel(&got));
  CHECK(got != 77);

  Rig never;
  never.level.restore(-1, 0.0);
  CHECK(never.trim == -1.0f);
}

TEST_CASE("TxLevel: a control without a usable range is refused, and answers nothing") {
  SteppedMixer mixer;
  mixer.ok = false;
  TxLevel level{mixer, nullptr, nullptr};
  std::string error;
  CHECK_FALSE(level.open(&error));
  CHECK(error.find("fake mixer") != std::string::npos);
  uint8_t got;
  CHECK_FALSE(level.getModLevel(&got));
  CHECK_FALSE(level.setModLevel(10));
}

TEST_CASE("dispatchCiv 1A 05 99 99: local-trx's MOD level, BCD like 14 0A; every other 1A unanswered") {
  Rig r;
  NoRig rig;
  CHECK_FALSE(dispatchCiv({0x1A, 0x05, 0x99, 0x99}, rig).answered);   // no TxLevel wired

  CivResult w = dispatchCiv({0x1A, 0x05, 0x99, 0x99, 0x01, 0x28}, rig, nullptr, &r.level);   // 128
  REQUIRE(w.answered);
  CHECK(w.payload == std::vector<uint8_t>{0xFB});

  CivResult rd = dispatchCiv({0x1A, 0x05, 0x99, 0x99}, rig, nullptr, &r.level);
  REQUIRE(rd.answered);
  CHECK(rd.payload == std::vector<uint8_t>{0x1A, 0x05, 0x99, 0x99, 0x01, 0x28});

  CHECK(dispatchCiv({0x1A, 0x05, 0x99, 0x99, 0x02, 0x55}, rig, nullptr, &r.level).answered);
  CHECK(dispatchCiv({0x1A, 0x05, 0x99, 0x99}, rig, nullptr, &r.level).payload ==
        std::vector<uint8_t>{0x1A, 0x05, 0x99, 0x99, 0x02, 0x55});

  // Out of range: refused, the level stays.
  CHECK_FALSE(dispatchCiv({0x1A, 0x05, 0x99, 0x99, 0x02, 0x99}, rig, nullptr, &r.level).answered);
  // Real ICOM settings (IC-705 WLAN MOD level) are never answered or written.
  const int sets = r.mixer.sets;
  CHECK_FALSE(dispatchCiv({0x1A, 0x05, 0x01, 0x17}, rig, nullptr, &r.level).answered);
  CHECK_FALSE(dispatchCiv({0x1A, 0x05, 0x01, 0x17, 0x01, 0x00}, rig, nullptr, &r.level).answered);
  CHECK_FALSE(dispatchCiv({0x1A, 0x0B}, rig, nullptr, &r.level).answered);
  CHECK(r.mixer.sets == sets);
}
