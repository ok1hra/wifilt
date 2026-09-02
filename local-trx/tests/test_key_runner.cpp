// doctest unit tests for key_runner.h -- the one real background thread in
// this batch. Uses a HIGH wpm (short dits) to keep wall-clock time down;
// PTTlead/PTTtail are fixed constants (wifilt.ino's own 400/200ms) so every
// test here costs at least ~0.6s regardless of message length.
#include "doctest.h"

#include <chrono>
#include <mutex>
#include <thread>
#include <vector>

#include "../src/key_runner.h"

using namespace LocalTrx;

namespace {

class RecordingKeyLine : public KeyLine {
 public:
  void setKey(bool down) override {
    std::lock_guard<std::mutex> lock(m);
    keyEvents.push_back(down);
  }
  void setPtt(bool on) override {
    std::lock_guard<std::mutex> lock(m);
    pttEvents.push_back(on);
  }

  std::vector<bool> snapshotKey() {
    std::lock_guard<std::mutex> lock(m);
    return keyEvents;
  }
  std::vector<bool> snapshotPtt() {
    std::lock_guard<std::mutex> lock(m);
    return pttEvents;
  }

  std::mutex m;
  std::vector<bool> keyEvents;
  std::vector<bool> pttEvents;
};

// KeyRunner's job queue has no synchronous "done" signal by design (bod 9:
// fire-and-forget from civ_router's point of view) -- poll busy() instead,
// same as a real caller would.
bool waitUntilIdle(KeyRunner &kr, int timeoutMs = 3000) {
  auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  // First wait for the worker thread to actually pick the job up -- without
  // this, a send*() call returning just before the thread sets busy_=true
  // races with the check below and reports "idle" before the job even started.
  while (!kr.busy() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  while (kr.busy() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return !kr.busy();
}

}  // namespace

TEST_CASE("KeyRunner::sendCwText keys a single dit and gates PTT lead/tail") {
  RecordingKeyLine line;
  KeyRunner kr(line, 200);   // dit = 6ms
  REQUIRE(kr.sendCwText("E"));
  REQUIRE(waitUntilIdle(kr));

  auto ptt = line.snapshotPtt();
  REQUIRE(ptt.size() == 2);
  CHECK(ptt[0] == true);
  CHECK(ptt[1] == false);

  auto key = line.snapshotKey();
  REQUIRE(key.size() == 2);   // one dit (level=true) + the runner's own final release
  CHECK(key[0] == true);
  CHECK(key[1] == false);
}

TEST_CASE("KeyRunner rejects a second send while busy (CW/FSK are mode-exclusive)") {
  RecordingKeyLine line;
  KeyRunner kr(line, 5);   // slow WPM so the first job is still running
  REQUIRE(kr.sendCwText("SOS"));
  CHECK_FALSE(kr.sendCwText("TEST"));
  CHECK_FALSE(kr.sendFskText("TEST"));
  kr.abort();
  waitUntilIdle(kr);
}

TEST_CASE("KeyRunner::sendFskText also keys and gates PTT") {
  RecordingKeyLine line;
  KeyRunner kr(line);
  REQUIRE(kr.sendFskText("A"));
  REQUIRE(waitUntilIdle(kr));

  auto ptt = line.snapshotPtt();
  REQUIRE(ptt.size() == 2);
  CHECK(ptt[0] == true);
  CHECK(ptt[1] == false);
  CHECK_FALSE(line.snapshotKey().empty());
}

TEST_CASE("KeyRunner::abort stops keying early and drops PTT without a tail delay") {
  RecordingKeyLine line;
  KeyRunner kr(line, 5);   // slow enough that "SOS SOS SOS" would run for seconds
  auto start = std::chrono::steady_clock::now();
  REQUIRE(kr.sendCwText("SOS SOS SOS SOS SOS"));
  std::this_thread::sleep_for(std::chrono::milliseconds(450));   // let PTT lead pass, start keying
  kr.abort();
  REQUIRE(waitUntilIdle(kr, 2000));
  auto elapsed = std::chrono::steady_clock::now() - start;
  // PTTlead(400) + a little keying + NO PTTtail (skipped on abort) -- nowhere
  // near what the full 19-character message at 5 WPM would otherwise take.
  CHECK(std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count() < 1500);

  auto ptt = line.snapshotPtt();
  REQUIRE(ptt.size() == 2);
  CHECK(ptt[1] == false);   // still released cleanly
  CHECK(line.snapshotKey().back() == false);   // key left in the released state
}

TEST_CASE("KeyRunner's CW speed round-trips through the KeyingBackend interface") {
  RecordingKeyLine line;
  KeyRunner kr(line);
  KeyingBackend &backend = kr;
  CHECK(backend.setCwSpeedRaw(wpmToCivSpeedRaw(20)));
  CHECK(civSpeedRawToWpm(backend.getCwSpeedRaw()) == 20);
}

TEST_CASE("KeyRunner::setAudioPtt (CI-V 0x1C, fáze 3) directly toggles the line") {
  RecordingKeyLine line;
  KeyRunner kr(line);
  CHECK(kr.setAudioPtt(true));
  CHECK(kr.getAudioPtt() == true);
  CHECK(line.snapshotPtt() == std::vector<bool>{true});

  CHECK(kr.setAudioPtt(false));
  CHECK(kr.getAudioPtt() == false);
  CHECK(line.snapshotPtt() == std::vector<bool>{true, false});
}

TEST_CASE("KeyRunner::setAudioPtt is refused while a CW/FSK job is actually keying") {
  RecordingKeyLine line;
  KeyRunner kr(line, 5);   // slow WPM so busy() stays true long enough to observe
  REQUIRE(kr.sendCwText("SOS"));
  std::this_thread::sleep_for(std::chrono::milliseconds(50));   // PTT lead has started
  REQUIRE(kr.busy());
  CHECK_FALSE(kr.setAudioPtt(true));
  CHECK(kr.getAudioPtt() == false);   // state unchanged, not silently overridden
  kr.abort();
  waitUntilIdle(kr);
}
