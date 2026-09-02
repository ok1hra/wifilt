// doctest unit tests for keyer.h's CW (new logic) and FSK (ported from
// wifilt.ino's chTable()/sendFsk()) encoders. Transport-free -- no
// serial_key.h, no real clock.
#include "doctest.h"

#include "../src/keyer.h"

using namespace LocalTrx;

// ---- CW -------------------------------------------------------------------

TEST_CASE("CwEngine::ditMs matches the PARIS convention (1200/wpm)") {
  CHECK(CwEngine(20).ditMs() == 60);
  CHECK(CwEngine(12).ditMs() == 100);
  CHECK(CwEngine(60).ditMs() == 20);
}

TEST_CASE("CwEngine::encode('S') is three dits with two intra-element gaps") {
  CwEngine cw(20);   // dit = 60ms
  auto events = cw.encode("S");
  REQUIRE(events.size() == 5);
  CHECK(events[0] == KeyEvent{true, 60});
  CHECK(events[1] == KeyEvent{false, 60});
  CHECK(events[2] == KeyEvent{true, 60});
  CHECK(events[3] == KeyEvent{false, 60});
  CHECK(events[4] == KeyEvent{true, 60});   // ends on a mark, see keyer.h
}

TEST_CASE("CwEngine::encode('O') is three dahs (3x dit each)") {
  CwEngine cw(20);
  auto events = cw.encode("O");
  REQUIRE(events.size() == 5);
  CHECK(events[0] == KeyEvent{true, 180});
  CHECK(events[2] == KeyEvent{true, 180});
  CHECK(events[4] == KeyEvent{true, 180});
}

TEST_CASE("CwEngine::encode('SOS') inserts a 3-dit inter-character gap") {
  CwEngine cw(20);
  auto s = cw.encode("S");        // 5 events
  auto sos = cw.encode("SOS");
  // S(5) + gap(1) + O(5) + gap(1) + S(5) = 17
  REQUIRE(sos.size() == 17);
  CHECK(sos[5] == KeyEvent{false, 180});    // 3 x 60ms inter-character gap
  CHECK(sos[11] == KeyEvent{false, 180});
  (void)s;
}

TEST_CASE("CwEngine::encode uses a 7-dit word gap, and collapses repeated spaces") {
  CwEngine cw(20);   // dit=60
  auto oneSpace = cw.encode("A B");
  auto twoSpaces = cw.encode("A  B");
  // A(.-  = 3 events) + word-gap(1) + B(-... = 7 events) = 11
  REQUIRE(oneSpace.size() == 11);
  CHECK(oneSpace[3] == KeyEvent{false, 420});   // 7 x 60ms
  CHECK(oneSpace == twoSpaces);                 // repeated spaces collapse to one gap
}

TEST_CASE("CwEngine::encode ignores unknown characters and leading/trailing spaces") {
  CwEngine cw(20);
  CHECK(cw.encode("").empty());
  CHECK(cw.encode("   ").empty());
  CHECK(cw.encode("E") == cw.encode(" E "));
  CHECK(cw.encode("E") == cw.encode("E#"));   // '#' has no Morse mapping
}

// ---- FSK (Baudot/ITA2) ------------------------------------------------------

// wifilt.ino:391's `int OneBit = 1/BaudRateFSK*1000` truncates to 22, not 22.002...
static const uint32_t kBit = 22;

TEST_CASE("FskEngine::encode('A') needs no shift (starts in LETTERS) -- one 7-event frame") {
  FskEngine fsk;
  auto events = fsk.encode("A");
  REQUIRE(events.size() == 7);
  CHECK(events[0] == KeyEvent{false, kBit});         // start bit (space)
  CHECK(events[1] == KeyEvent{true, kBit});          // A = 11000
  CHECK(events[2] == KeyEvent{true, kBit});
  CHECK(events[3] == KeyEvent{false, kBit});
  CHECK(events[4] == KeyEvent{false, kBit});
  CHECK(events[5] == KeyEvent{false, kBit});
  CHECK(events[6] == KeyEvent{true, (uint32_t)(kBit * 1.5)});   // stop bit
}

TEST_CASE("FskEngine::encode('1') emits a FIGS shift before the digit (starts in LETTERS)") {
  FskEngine fsk;
  auto events = fsk.encode("1");
  REQUIRE(events.size() == 14);   // FIGS-shift frame(7) + '1' frame(7)
  // FIGS shift = 11011
  CHECK(events[1] == KeyEvent{true, kBit});
  CHECK(events[2] == KeyEvent{true, kBit});
  CHECK(events[3] == KeyEvent{false, kBit});
  CHECK(events[4] == KeyEvent{true, kBit});
  CHECK(events[5] == KeyEvent{true, kBit});
  // '1' = 11101
  CHECK(events[8] == KeyEvent{true, kBit});
  CHECK(events[9] == KeyEvent{true, kBit});
  CHECK(events[10] == KeyEvent{true, kBit});
  CHECK(events[11] == KeyEvent{false, kBit});
  CHECK(events[12] == KeyEvent{true, kBit});
}

TEST_CASE("FskEngine::encode('1A') shifts to FIGURES then back to LETTERS") {
  FskEngine fsk;
  auto events = fsk.encode("1A");
  // FIGS(7) + '1'(7) + LTRS(7) + 'A'(7) = 28
  REQUIRE(events.size() == 28);
  // LTRS shift = 11111
  CHECK(events[15] == KeyEvent{true, kBit});
  CHECK(events[16] == KeyEvent{true, kBit});
  CHECK(events[17] == KeyEvent{true, kBit});
  CHECK(events[18] == KeyEvent{true, kBit});
  CHECK(events[19] == KeyEvent{true, kBit});
}

TEST_CASE("FskEngine::encode('A1') needs only one shift, not two") {
  FskEngine fsk;
  auto events = fsk.encode("A1");
  // 'A'(7, no shift needed) + FIGS(7) + '1'(7) = 21
  REQUIRE(events.size() == 21);
}

TEST_CASE("FskEngine re-asserts FIGS after a space between two figures (wifilt.ino quirk)") {
  FskEngine fsk;
  auto events = fsk.encode("1 2");
  // FIGS(7) + '1'(7) + space(7) + FIGS(7, re-asserted) + '2'(7) = 35
  REQUIRE(events.size() == 35);
}

TEST_CASE("FskEngine does not re-assert LETTERS after a space between two letters") {
  FskEngine fsk;
  auto events = fsk.encode("A B");
  // 'A'(7, no shift) + space(7) + 'B'(7, no shift -- already in LETTERS) = 21
  REQUIRE(events.size() == 21);
}

TEST_CASE("FskEngine shift state persists across separate encode() calls") {
  FskEngine fsk;
  auto first = fsk.encode("1");
  CHECK(first.size() == 14);   // shifts into FIGURES
  auto second = fsk.encode("2");
  CHECK(second.size() == 7);   // already in FIGURES -- no repeated shift
}
