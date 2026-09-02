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
    CHECK(hamlibModeToCiv(h) == m);
  }
}

TEST_CASE("civModeToHamlib on an unmapped byte returns RIG_MODE_NONE, never a guess") {
  CHECK(civModeToHamlib(0xFF) == RIG_MODE_NONE);
}

TEST_CASE("hamlibModeToCiv on an unmapped rmode_t returns 0xFF, never a guess") {
  CHECK(hamlibModeToCiv(RIG_MODE_PKTUSB) == 0xFF);
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
