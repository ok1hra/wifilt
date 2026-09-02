// doctest unit tests for keying_backend.h's CI-V 0x14 0x0C <-> WPM
// conversion (ICOM's own 0-255 scale, 6-48 WPM linear).
#include "doctest.h"

#include <cstdlib>

#include "../src/keying_backend.h"

using namespace LocalTrx;

TEST_CASE("wpmToCivSpeedRaw covers the documented endpoints") {
  CHECK(wpmToCivSpeedRaw(6) == 0);
  CHECK(wpmToCivSpeedRaw(48) == 255);
}

TEST_CASE("civSpeedRawToWpm covers the documented endpoints") {
  CHECK(civSpeedRawToWpm(0) == 6);
  CHECK(civSpeedRawToWpm(255) == 48);
}

TEST_CASE("wpmToCivSpeedRaw clamps out-of-range WPM instead of wrapping") {
  CHECK(wpmToCivSpeedRaw(0) == 0);
  CHECK(wpmToCivSpeedRaw(100) == 255);
}

TEST_CASE("round-trip stays within 1 WPM for every representable speed") {
  for (int wpm = 6; wpm <= 48; wpm++) {
    uint8_t raw = wpmToCivSpeedRaw(wpm);
    int back = civSpeedRawToWpm(raw);
    CHECK(std::abs(back - wpm) <= 1);
  }
}
