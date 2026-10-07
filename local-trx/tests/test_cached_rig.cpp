// doctest unit tests for cached_rig.cpp -- driven step() by step() against a
// fake clock and a scripted inner backend, so every case is deterministic;
// one last case runs the real worker thread.
#include "doctest.h"

#include <chrono>
#include <deque>
#include <string>
#include <thread>
#include <vector>

#include "../src/cached_rig.h"

using namespace LocalTrx;

namespace {

// Inner backend whose frequency reads follow a script: each entry is one
// read's outcome (a value, or kFail). Once the script runs out, it keeps
// answering the last value -- like a rig that just sits on a frequency.
constexpr double kFail = -1.0;

class ScriptedRig : public RigBackend {
 public:
  bool getFreqHz(double *hz) override {
    freqReads++;
    if (onFreqRead) onFreqRead();
    double v = steadyFreq;
    if (!script.empty()) {
      v = script.front();
      script.pop_front();
    }
    if (v == kFail) {
      error = "get_freq: Command rejected by the rig";
      return false;
    }
    *hz = v;
    return true;
  }
  bool setFreqHz(double hz) override {
    freqWrites.push_back(hz);
    steadyFreq = hz;
    return true;
  }
  bool getMode(uint8_t *m, bool *d) override {
    if (modeFails) return false;
    *m = mode;
    *d = data;
    return true;
  }
  bool setMode(uint8_t m, bool d) override {
    mode = m;
    data = d;
    modeWrites++;
    return true;
  }
  bool getRitHz(int32_t *hz) override { *hz = rit; return true; }
  bool setRitHz(int32_t hz) override { rit = hz; return true; }
  bool getGain(GainKind, uint8_t *v) override {
    gainReads++;
    *v = af;
    return true;
  }
  bool setGain(GainKind, uint8_t v) override {
    af = v;
    gainWrites++;
    return true;
  }
  bool getMeter(MeterKind, uint8_t *raw) override {
    if (!meterOk) return false;
    *raw = meter;
    return true;
  }
  bool getAttenuatorOn(bool *on) override { *on = false; return true; }
  bool getVoxOn(bool *on) override { *on = false; return true; }
  bool reopen(std::string *err) override {
    reopens++;
    if (!reopenOk && err) *err = "port not found";
    return reopenOk;
  }
  std::string lastError() const override { return error; }

  std::deque<double> script;
  double steadyFreq = 14074000;
  std::function<void()> onFreqRead;
  int freqReads = 0;
  std::vector<double> freqWrites;
  uint8_t mode = 0x01;
  bool data = false;
  bool modeFails = false;
  int modeWrites = 0;
  int32_t rit = 0;
  uint8_t af = 100;
  int gainReads = 0;
  int gainWrites = 0;
  bool meterOk = true;
  uint8_t meter = 50;
  int reopens = 0;
  bool reopenOk = true;
  std::string error;
};

struct Harness {
  ScriptedRig inner;
  uint32_t now = 1000;
  std::vector<std::string> log;
  CachedRigBackend cache;

  explicit Harness(bool open = true)
      : cache(inner, open, [this] { return now; }, [this](const std::string &m) { log.push_back(m); }) {}

  // Advance to the next fast poll and run one worker step.
  void poll() {
    now += CachedRigBackend::kFastPollMs;
    cache.step();
  }
  double freq() {
    double hz = 0;
    REQUIRE(cache.getFreqHz(&hz));
    return hz;
  }
  bool logged(const std::string &needle) const {
    for (const std::string &l : log) {
      if (l.find(needle) != std::string::npos) return true;
    }
    return false;
  }
};

}  // namespace

TEST_CASE("CachedRig: before any read it answers inert defaults (0 Hz, USB), so wifilt still connects") {
  Harness h(/*open=*/false);
  CHECK(h.freq() == 0.0);
  uint8_t mode = 0xFF;
  bool data = true;
  REQUIRE(h.cache.getMode(&mode, &data));
  CHECK(mode == 0x01);
  CHECK_FALSE(data);
}

TEST_CASE("CachedRig: reads come from the cache and never call into the rig") {
  Harness h;
  h.poll();
  h.poll();   // two agreeing reads confirm the jump from the inert 0 Hz
  const int reads = h.inner.freqReads;
  for (int i = 0; i < 50; i++) CHECK(h.freq() == 14074000);
  CHECK(h.inner.freqReads == reads);
}

TEST_CASE("CachedRig: a one-off garbled frequency (the IC-7300 '1409.404.04' case) is never published") {
  Harness h;
  h.poll();
  h.poll();
  REQUIRE(h.freq() == 14074000);

  h.inner.script = {1409404040.0, 14074000};   // garbled reply, then the truth again
  h.poll();
  CHECK(h.freq() == 14074000);
  h.poll();
  CHECK(h.freq() == 14074000);
  CHECK(h.logged("ignored a one-off frequency reading of 1409404040 Hz"));
}

TEST_CASE("CachedRig: a real QSY (two agreeing reads far away) is published on the second read") {
  Harness h;
  h.poll();
  h.poll();
  h.inner.steadyFreq = 7074000;
  h.poll();
  CHECK(h.freq() == 14074000);   // held as a candidate
  h.poll();
  CHECK(h.freq() == 7074000);
  CHECK_FALSE(h.logged("ignored"));
}

TEST_CASE("CachedRig: ordinary tuning steps are published at once") {
  Harness h;
  h.poll();
  h.poll();
  h.inner.steadyFreq = 14074500;
  h.poll();
  CHECK(h.freq() == 14074500);
  h.inner.steadyFreq = 14080000;
  h.poll();
  CHECK(h.freq() == 14080000);
}

TEST_CASE("CachedRig: a failed read keeps the last good frequency and mode") {
  Harness h;
  h.inner.mode = 0x01;
  h.inner.data = true;
  h.poll();
  h.poll();
  h.inner.script = {kFail, kFail};
  h.inner.modeFails = true;
  h.poll();
  h.poll();
  CHECK(h.freq() == 14074000);
  uint8_t mode = 0;
  bool data = false;
  REQUIRE(h.cache.getMode(&mode, &data));
  CHECK(mode == 0x01);
  CHECK(data);
  CHECK(h.logged("frequency read failed: get_freq: Command rejected by the rig"));
}

TEST_CASE("CachedRig: USB-D from the rig reaches the cache as mode 0x01 + DATA") {
  Harness h;
  h.inner.mode = 0x01;
  h.inner.data = true;
  h.poll();
  uint8_t mode = 0;
  bool data = false;
  REQUIRE(h.cache.getMode(&mode, &data));
  CHECK(mode == 0x01);
  CHECK(data);
}

TEST_CASE("CachedRig: writes return at once, reach the rig on the next step, and read back immediately") {
  Harness h;
  h.poll();
  h.poll();
  CHECK(h.cache.setFreqHz(7040000));
  CHECK(h.inner.freqWrites.empty());   // queued, not sent from the caller's thread
  CHECK(h.freq() == 7040000);          // optimistic: an immediate read-back agrees
  h.cache.step();
  REQUIRE(h.inner.freqWrites.size() == 1);
  CHECK(h.inner.freqWrites[0] == 7040000);
  h.poll();
  CHECK(h.freq() == 7040000);   // no jump confirmation needed for our own QSY

  CHECK(h.cache.setMode(0x00, true));
  h.cache.step();
  CHECK(h.inner.mode == 0x00);
  CHECK(h.inner.data);
}

TEST_CASE("CachedRig: a read already in flight cannot overwrite a newer write") {
  Harness h;
  h.poll();
  h.poll();
  // The write lands while the worker is inside the rig's read (the cache
  // mutex is not held across CAT calls). The stale 14074000 that read returns
  // must not clobber the optimistic 3573000.
  h.inner.onFreqRead = [&h] {
    h.inner.onFreqRead = nullptr;
    h.cache.setFreqHz(3573000);
  };
  h.poll();
  CHECK(h.freq() == 3573000);
  h.cache.step();
  CHECK(h.inner.freqWrites.back() == 3573000);
}

TEST_CASE("CachedRig: levels are only polled while wifilt keeps asking, first ask has no answer yet") {
  Harness h;
  h.poll();
  h.poll();
  CHECK(h.inner.gainReads == 0);   // nobody asked
  uint8_t v = 0;
  CHECK_FALSE(h.cache.getGain(GainKind::Af, &v));   // honest: nothing read yet
  h.poll();
  CHECK(h.inner.gainReads == 1);
  REQUIRE(h.cache.getGain(GainKind::Af, &v));
  CHECK(v == 100);

  // Stop asking: polling stops once kWantedForMs has passed.
  h.now += CachedRigBackend::kWantedForMs;
  const int reads = h.inner.gainReads;
  for (int i = 0; i < 20; i++) h.poll();
  CHECK(h.inner.gainReads == reads);
}

TEST_CASE("CachedRig: a meter that stops answering goes silent rather than stale") {
  Harness h;
  uint8_t raw = 0;
  h.cache.getMeter(MeterKind::PowerMeter, &raw);
  h.poll();
  REQUIRE(h.cache.getMeter(MeterKind::PowerMeter, &raw));
  CHECK(raw == 50);
  h.inner.meterOk = false;
  h.now += CachedRigBackend::kMeterPollMs;
  h.poll();
  CHECK_FALSE(h.cache.getMeter(MeterKind::PowerMeter, &raw));
}

TEST_CASE("CachedRig: a rig that stops answering is reopened") {
  Harness h;
  h.poll();
  h.poll();
  h.inner.script.assign(CachedRigBackend::kReopenAfterFailures, kFail);
  h.inner.modeFails = true;
  for (int i = 0; i < CachedRigBackend::kReopenAfterFailures; i++) h.poll();
  CHECK(h.inner.reopens == 0);
  h.inner.modeFails = false;
  h.poll();
  CHECK(h.inner.reopens == 1);
  CHECK(h.logged("reopening it"));
  CHECK(h.logged("CAT: rig opened"));
  CHECK(h.freq() == 14074000);   // kept the last good value throughout
}

TEST_CASE("CachedRig: a rig absent at startup is retried every kReopenRetryMs until it appears") {
  Harness h(/*open=*/false);
  h.inner.reopenOk = false;
  h.cache.step();
  CHECK(h.inner.reopens == 1);
  CHECK(h.logged("cannot open rig (port not found)"));
  h.now += CachedRigBackend::kReopenRetryMs - 1;
  h.cache.step();
  CHECK(h.inner.reopens == 1);
  h.inner.reopenOk = true;
  h.now += 1;
  h.cache.step();
  CHECK(h.inner.reopens == 2);
  h.poll();
  h.poll();
  CHECK(h.freq() == 14074000);
}

TEST_CASE("CachedRig: real worker thread -- start(), queued write reaches the rig, stop() joins") {
  ScriptedRig inner;
  CachedRigBackend cache(inner, true, CachedRigBackend::Clock(), [](const std::string &) {});
  cache.start();
  double hz = 0;
  REQUIRE(cache.getFreqHz(&hz));
  CHECK(hz == 14074000);   // start() already confirmed the first reading
  cache.setFreqHz(21074000);
  // The worker wakes on the queued write (or within 10 ms anyway); only look
  // at inner's state after stop() has joined it.
  std::this_thread::sleep_for(std::chrono::milliseconds(150));
  cache.stop();
  REQUIRE_FALSE(inner.freqWrites.empty());
  CHECK(inner.freqWrites.back() == 21074000);
}
