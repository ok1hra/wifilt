// doctest unit tests for hamlib_bridge.cpp's mode-translation table (bod 11
// "Mode translace"). Pure functions only -- no RIG* instance needed here;
// the Dummy-backend round-trip is tools/local-trx-integration-test.sh's job,
// except CAT PTT below, which opens hamlib's own Dummy (no port, no hardware).
#include "doctest.h"

#include <string>

#include "../src/civ_router.h"
#include "../src/hamlib_bridge.h"

using namespace LocalTrx;

TEST_CASE("civModeToHamlib/hamlibModeToCiv round-trip for every mapped CI-V byte") {
  const uint8_t modes[] = {0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08};
  for (uint8_t m : modes) {
    rmode_t h = civModeToHamlib(m);
    CHECK(h != RIG_MODE_NONE);
    uint8_t back = 0xFF;
    bool data = true;
    REQUIRE(hamlibModeToCiv(h, &back, &data));
    CHECK(back == m);
    CHECK_FALSE(data);
  }
}

TEST_CASE("DATA modes: hamlib's PKT* modes are ICOM's mode byte + DATA flag, both ways") {
  // The IC-7300 in USB-D reports RIG_MODE_PKTUSB -- this used to fall through
  // to a hard-coded "USB", which is why wifilt never showed USB-D.
  struct { rmode_t hamlib; uint8_t civ; } pairs[] = {
      {RIG_MODE_PKTLSB, 0x00}, {RIG_MODE_PKTUSB, 0x01}, {RIG_MODE_PKTAM, 0x02}, {RIG_MODE_PKTFM, 0x05}};
  for (auto p : pairs) {
    uint8_t civ = 0xFF;
    bool data = false;
    REQUIRE(hamlibModeToCiv(p.hamlib, &civ, &data));
    CHECK(civ == p.civ);
    CHECK(data);
    CHECK(civModeToHamlib(p.civ, true) == p.hamlib);
  }
}

TEST_CASE("civModeToHamlib on an unmapped byte returns RIG_MODE_NONE, never a guess") {
  CHECK(civModeToHamlib(0xFF) == RIG_MODE_NONE);
  CHECK(civModeToHamlib(0x03, true) == RIG_MODE_NONE);   // there is no CW-D
}

TEST_CASE("hamlibModeToCiv on an unmapped rmode_t returns false, never a guess") {
  uint8_t civ = 0x42;
  bool data = false;
  CHECK_FALSE(hamlibModeToCiv(RIG_MODE_SAM, &civ, &data));
  CHECK(civ == 0x42);
}

TEST_CASE("civ_router's own mode table (civModeName) agrees with hamlib_bridge's") {
  // Both tables trace back to wifilt.ino's decodeModeName() [wifilt.ino:1349];
  // this guards against the two drifting apart independently.
  for (uint8_t m = 0x00; m <= 0x08; m++) {
    const char *name = civModeName(m);
    REQUIRE(name != nullptr);
    CHECK(civModeToHamlib(m) != RIG_MODE_NONE);
  }
  CHECK(civModeName(0x09) == nullptr);
}

TEST_CASE("alcLevelToRaw: zero stays zero, any ALC reading is nonzero, TS-480 dots x 12") {
  CHECK(alcLevelToRaw(0.0f) == 0);
  CHECK(alcLevelToRaw(-0.1f) == 0);
  CHECK(alcLevelToRaw(0.001f) == 1);       // never rounded into "clean"
  CHECK(alcLevelToRaw(0.25f) == 12);       // TS-480: one RM3 dot (hamlib reports dots / 4)
  CHECK(alcLevelToRaw(2.5f) == 120);       // ten dots = top of an ICOM's ALC zone
  CHECK(alcLevelToRaw(5.0f) == 240);       // twenty dots
  CHECK(alcLevelToRaw(100.0f) == 255);
}

TEST_CASE("CAT PTT: keys only models whose own caps say CAT PTT -- never hamlib's silent no-op") {
  // RIG_PTT_NONE makes rig_set_ptt() return RIG_OK having sent nothing
  // ("allowed for use with VOX"), so "OK" would be a lie there. hamlib's
  // Dummy is RIG_PTT_NONE in 4.6 and RIG_PTT_RIG in 4.7 -- the expectation
  // follows the linked library's caps.
  rig_set_debug(RIG_DEBUG_NONE);
  HamlibRigBackend closed(RIG_MODEL_DUMMY, "", 0);
  CHECK_FALSE(closed.setPtt(true, true));
  CHECK(closed.lastError() == "rig not open");

  for (rig_model_t model : {RIG_MODEL_DUMMY, RIG_MODEL_DUMMY_NOVFO}) {
    CAPTURE(model);
    HamlibRigBackend rig(model, "", 0);
    std::string error;
    REQUIRE(rig.open(&error));
    const ptt_type_t type = rig_get_caps(model)->ptt_type;
    const bool hasCatPtt = type == RIG_PTT_RIG || type == RIG_PTT_RIG_MICDATA;
    CHECK(rig.setPtt(true, true) == hasCatPtt);
    CHECK(rig.setPtt(true, false) == hasCatPtt);
    CHECK(rig.setPtt(false, true) == hasCatPtt);
    if (!hasCatPtt) CHECK(rig.lastError().find("no CAT PTT") != std::string::npos);
  }

  // The radio this was built for: Kenwood TX0;/TX1;, hamlib RIG_PTT_RIG_MICDATA.
  rig_load_all_backends();
  REQUIRE(rig_get_caps(RIG_MODEL_TS480) != nullptr);
  CHECK(rig_get_caps(RIG_MODEL_TS480)->ptt_type == RIG_PTT_RIG_MICDATA);
}
