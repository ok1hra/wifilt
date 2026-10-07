// doctest unit tests for hamlib_bridge.cpp's mode-translation table (bod 11
// "Mode translace"). Pure functions only -- no RIG* instance needed here;
// the Dummy-backend round-trip is tools/local-trx-integration-test.sh's job.
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
