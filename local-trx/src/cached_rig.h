// cached_rig.h -- keeps every hamlib round-trip off the main loop.
//
// The main loop (IcomLanServer::poll() + AudioChannel::tick()) is single
// threaded. With hamlib called straight from CI-V dispatch, one IC-7300 CAT
// read (~50-400 ms over USB serial, up to hamlib's whole timeout+retry on a
// glitch) froze RX audio pacing for that long, and a slow 0x03 made wifilt's
// own 1 s CAT liveness probe (icomLanClient.h civHealthProbePending) tear
// the whole LAN session down -- audio with it.
//
// CachedRigBackend wraps the real backend on its own worker thread:
//   - reads answer instantly from the last good value (freq/mode always
//     polled; levels/meters only while wifilt keeps asking for them),
//   - writes are queued latest-wins and applied by the worker, the cache
//     updated optimistically so an immediate read-back already agrees,
//   - a failed read keeps the last good value (meters excepted: a stale
//     power/SWR reading after TX ended would be worse than none),
//   - a frequency JUMP (> kFreqJumpHz from the published value) must be
//     read twice before it is published -- a single garbled CAT reply can
//     no longer move wifilt's VFO to a nonsense frequency,
//   - a rig that stops answering (radio power-cycled, USB serial port
//     re-enumerated) or that was absent at startup is reopened periodically.
//
// Only the worker thread ever touches `inner` after start().
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

#include "rig_backend.h"

namespace LocalTrx {

class CachedRigBackend : public RigBackend {
 public:
  using Clock = std::function<uint32_t()>;
  using Logger = std::function<void(const std::string &)>;

  static constexpr uint32_t kFastPollMs = 200;        // freq + mode
  static constexpr uint32_t kSettingPollMs = 1000;    // AF/RF/power setting, RIT, ATT, VOX
  static constexpr uint32_t kMeterPollMs = 300;       // power meter, SWR, supply voltage
  static constexpr uint32_t kMeterStaleMs = 1500;     // older meter readings are not reported
  static constexpr uint32_t kWantedForMs = 5000;      // slow items: polled only while asked for
  static constexpr double   kFreqJumpHz = 50000.0;    // larger moves need a second matching read
  static constexpr int      kReopenAfterFailures = 10;
  static constexpr uint32_t kReopenRetryMs = 5000;

  // innerOpen: whether `inner` is usable right now. false (rig absent at
  // startup) makes the worker keep calling inner.reopen() every
  // kReopenRetryMs. Until the first good read, freq/mode answer inert
  // defaults (0 Hz, USB) -- the same thing local-trx always did without a rig,
  // so wifilt still connects and RX audio still flows.
  CachedRigBackend(RigBackend &inner, bool innerOpen, Clock clock = Clock(), Logger logger = Logger());
  ~CachedRigBackend() override;

  // One synchronous freq/mode read pass (so the cache is real before the
  // ICOM-LAN server starts answering), every level/meter marked wanted so
  // wifilt's very first aux poll already finds them filled, then the worker.
  void start();
  void stop();

  // One worker iteration: reopen if due, flush queued writes, poll what is
  // due. Public so tests can drive it deterministically without the thread.
  void step();

  bool getFreqHz(double *hzOut) override;
  bool setFreqHz(double hz) override;
  bool getMode(uint8_t *modeOut, bool *dataOut) override;
  bool setMode(uint8_t mode, bool data) override;
  bool getRitHz(int32_t *hzOut) override;
  bool setRitHz(int32_t hz) override;
  bool getGain(GainKind kind, uint8_t *valueOut) override;
  bool setGain(GainKind kind, uint8_t value) override;
  bool getMeter(MeterKind kind, uint8_t *rawOut) override;
  bool getAttenuatorOn(bool *onOut) override;
  bool getVoxOn(bool *onOut) override;

 private:
  enum Slow { kAf, kRf, kRfPower, kRit, kPowerMeter, kSwr, kSupply, kAtt, kVox, kSlowCount };

  struct SlowItem {
    bool valid = false;
    int32_t value = 0;
    uint32_t readAtMs = 0;       // last good read (meters go stale)
    uint32_t wantedAtMs = 0;
    bool everWanted = false;
    uint32_t nextPollMs = 0;
    uint32_t gen = 0;            // bumped by a queued write (gains/RIT only)
    bool pendingWrite = false;
    int32_t pendingValue = 0;
  };

  static bool isMeter(int item) { return item == kPowerMeter || item == kSwr || item == kSupply; }
  static int gainItem(GainKind kind);
  static int meterItem(MeterKind kind);

  bool readSlow(int item, int32_t *valueOut);
  bool pollSlowFromInner(int item, int32_t *valueOut);
  void pollFast(uint32_t now);
  void pollSlow(uint32_t now);
  void flushWrites();
  void maybeReopen(uint32_t now);
  bool acceptFreqRead(double hz, double *discardedOut);
  void logLimited(const std::string &key, const std::string &message, uint32_t now);
  void workerMain();

  RigBackend &inner_;
  bool innerOpen_;
  Clock clock_;
  Logger logger_;

  std::mutex mutex_;
  std::condition_variable wake_;

  // ---- guarded by mutex_ ----
  double freqHz_ = 0.0;
  bool freqReal_ = false;          // false = still the inert default
  bool haveFreqCandidate_ = false;
  double freqCandidate_ = 0.0;
  uint32_t freqGen_ = 0;
  bool pendingFreq_ = false;
  double pendingFreqHz_ = 0.0;

  uint8_t mode_ = 0x01;            // inert default: USB
  bool data_ = false;
  uint32_t modeGen_ = 0;
  bool pendingMode_ = false;
  uint8_t pendingModeByte_ = 0;
  bool pendingData_ = false;

  SlowItem slow_[kSlowCount];
  // ---- end guarded ----

  // Worker-thread-only state.
  uint32_t nextFastPollMs_ = 0;
  int slowCursor_ = 0;
  int consecutiveFastFailures_ = 0;
  uint32_t nextReopenMs_ = 0;
  struct LogSlot { std::string key; uint32_t lastMs = 0; int suppressed = 0; bool used = false; };
  LogSlot logSlots_[8];

  std::atomic<bool> stopRequested_{false};
  std::thread worker_;
};

}  // namespace LocalTrx
