#include "cached_rig.h"

#include <chrono>
#include <cmath>
#include <cstdio>

namespace LocalTrx {

namespace {

uint32_t steadyMillis() {
  using namespace std::chrono;
  return (uint32_t)duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

bool due(uint32_t now, uint32_t at) { return (int32_t)(now - at) >= 0; }

std::string hzText(double hz) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%.0f Hz", hz);
  return buf;
}

}  // namespace

CachedRigBackend::CachedRigBackend(RigBackend &inner, bool innerOpen, Clock clock, Logger logger)
    : inner_(inner),
      innerOpen_(innerOpen),
      clock_(clock ? std::move(clock) : Clock(steadyMillis)),
      logger_(logger ? std::move(logger)
                     : Logger([](const std::string &m) { std::fprintf(stderr, "%s\n", m.c_str()); })) {
  const uint32_t now = clock_();
  nextFastPollMs_ = now;
  nextReopenMs_ = now;
}

CachedRigBackend::~CachedRigBackend() { stop(); }

void CachedRigBackend::start() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const uint32_t now = clock_();
    for (SlowItem &s : slow_) {
      s.everWanted = true;
      s.wantedAtMs = now;
      s.nextPollMs = now;
    }
  }
  if (innerOpen_) {
    // Twice: the second read confirms the first one's jump away from the
    // inert 0 Hz default (see acceptFreqRead()).
    nextFastPollMs_ = clock_();
    pollFast(nextFastPollMs_);
    nextFastPollMs_ = clock_();
    pollFast(nextFastPollMs_);
  }
  worker_ = std::thread(&CachedRigBackend::workerMain, this);
}

void CachedRigBackend::stop() {
  stopRequested_ = true;
  wake_.notify_all();
  if (worker_.joinable()) worker_.join();
}

void CachedRigBackend::workerMain() {
  while (!stopRequested_) {
    step();
    std::unique_lock<std::mutex> lock(mutex_);
    wake_.wait_for(lock, std::chrono::milliseconds(10), [this] {
      if (stopRequested_ || pendingFreq_ || pendingMode_) return true;
      for (const SlowItem &s : slow_) {
        if (s.pendingWrite) return true;
      }
      return false;
    });
  }
}

void CachedRigBackend::step() {
  const uint32_t now = clock_();
  maybeReopen(now);
  flushWrites();
  if (!innerOpen_) return;
  pollFast(now);
  pollSlow(now);
}

// ---- worker side -------------------------------------------------------

void CachedRigBackend::maybeReopen(uint32_t now) {
  const bool needed = !innerOpen_ || consecutiveFastFailures_ >= kReopenAfterFailures;
  if (!needed || !due(now, nextReopenMs_)) return;
  nextReopenMs_ = now + kReopenRetryMs;
  if (innerOpen_) {
    logger_("CAT: rig stopped answering (" + std::to_string(consecutiveFastFailures_) +
            " failed reads in a row), reopening it");
  }
  std::string error;
  if (inner_.reopen(&error)) {
    if (!innerOpen_ || consecutiveFastFailures_ > 0) logger_("CAT: rig opened");
    innerOpen_ = true;
    consecutiveFastFailures_ = 0;
    nextFastPollMs_ = now;
  } else {
    innerOpen_ = false;
    logLimited("reopen", "CAT: cannot open rig (" + error + "), retrying every " +
                             std::to_string(kReopenRetryMs / 1000) + " s",
               now);
  }
}

void CachedRigBackend::flushWrites() {
  bool doMode = false, doFreq = false;
  uint8_t mode = 0;
  bool data = false;
  double hz = 0.0;
  bool doSlow[kSlowCount] = {};
  int32_t slowValue[kSlowCount] = {};
  {
    std::lock_guard<std::mutex> lock(mutex_);
    doMode = pendingMode_;
    mode = pendingModeByte_;
    data = pendingData_;
    pendingMode_ = false;
    doFreq = pendingFreq_;
    hz = pendingFreqHz_;
    pendingFreq_ = false;
    for (int i = 0; i < kSlowCount; i++) {
      doSlow[i] = slow_[i].pendingWrite;
      slowValue[i] = slow_[i].pendingValue;
      slow_[i].pendingWrite = false;
    }
  }
  const uint32_t now = clock_();
  // Mode before frequency: some rigs shift the displayed frequency on a mode
  // change (CW pitch offset), the frequency written last is the one that sticks.
  if (doMode && !inner_.setMode(mode, data)) {
    logLimited("set_mode", "CAT: mode change failed: " + inner_.lastError(), now);
  }
  if (doFreq && !inner_.setFreqHz(hz)) {
    logLimited("set_freq", "CAT: tuning to " + hzText(hz) + " failed: " + inner_.lastError(), now);
  }
  for (int i = 0; i < kSlowCount; i++) {
    if (!doSlow[i]) continue;
    bool ok = false;
    switch (i) {
      case kAf:      ok = inner_.setGain(GainKind::Af, (uint8_t)slowValue[i]); break;
      case kRf:      ok = inner_.setGain(GainKind::Rf, (uint8_t)slowValue[i]); break;
      case kRfPower: ok = inner_.setGain(GainKind::RfPower, (uint8_t)slowValue[i]); break;
      case kRit:     ok = inner_.setRitHz(slowValue[i]); break;
      default:       ok = true; break;
    }
    if (!ok) logLimited("set_level", "CAT: level write failed: " + inner_.lastError(), now);
  }
}

bool CachedRigBackend::acceptFreqRead(double hz, double *discardedOut) {
  // mutex_ held by the caller. Returns true when a held jump candidate turned
  // out to be a one-off (the read after it did not agree).
  const bool hadCandidate = haveFreqCandidate_;
  const double candidate = freqCandidate_;
  if (freqReal_ && std::fabs(hz - freqHz_) <= kFreqJumpHz) {
    freqHz_ = hz;                 // ordinary tuning step
    haveFreqCandidate_ = false;
  } else if (hadCandidate && std::fabs(hz - candidate) <= kFreqJumpHz) {
    freqHz_ = hz;                 // two reads agree on the new place: a real QSY
    freqReal_ = true;
    haveFreqCandidate_ = false;
    return false;
  } else {
    haveFreqCandidate_ = true;    // hold it until the next read agrees
    freqCandidate_ = hz;
  }
  if (hadCandidate) *discardedOut = candidate;
  return hadCandidate;
}

void CachedRigBackend::pollFast(uint32_t now) {
  if (!due(now, nextFastPollMs_)) return;
  nextFastPollMs_ = now + kFastPollMs;

  uint32_t gen;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    gen = freqGen_;
  }
  double hz = 0.0;
  const bool freqOk = inner_.getFreqHz(&hz);
  if (freqOk) {
    bool discarded = false;
    double discardedHz = 0.0;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (gen == freqGen_ && !pendingFreq_) discarded = acceptFreqRead(hz, &discardedHz);
    }
    if (discarded) {
      logLimited("freq_glitch", "CAT: ignored a one-off frequency reading of " + hzText(discardedHz) +
                                    " (the next read did not confirm it)",
                 now);
    }
  } else {
    logLimited("get_freq", "CAT: frequency read failed: " + inner_.lastError(), now);
  }

  {
    std::lock_guard<std::mutex> lock(mutex_);
    gen = modeGen_;
  }
  uint8_t mode = 0;
  bool data = false;
  const bool modeOk = inner_.getMode(&mode, &data);
  if (modeOk) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (gen == modeGen_ && !pendingMode_) {
      mode_ = mode;
      data_ = data;
    }
  } else {
    logLimited("get_mode", "CAT: mode read failed: " + inner_.lastError(), now);
  }

  consecutiveFastFailures_ = (freqOk || modeOk) ? 0 : consecutiveFastFailures_ + 1;
}

bool CachedRigBackend::pollSlowFromInner(int item, int32_t *valueOut) {
  uint8_t b = 0;
  bool on = false;
  int32_t rit = 0;
  bool ok = false;
  switch (item) {
    case kAf:         ok = inner_.getGain(GainKind::Af, &b); *valueOut = b; break;
    case kRf:         ok = inner_.getGain(GainKind::Rf, &b); *valueOut = b; break;
    case kRfPower:    ok = inner_.getGain(GainKind::RfPower, &b); *valueOut = b; break;
    case kRit:        ok = inner_.getRitHz(&rit); *valueOut = rit; break;
    case kPowerMeter: ok = inner_.getMeter(MeterKind::PowerMeter, &b); *valueOut = b; break;
    case kSwr:        ok = inner_.getMeter(MeterKind::Swr, &b); *valueOut = b; break;
    case kSupply:     ok = inner_.getMeter(MeterKind::SupplyVoltage, &b); *valueOut = b; break;
    case kAtt:        ok = inner_.getAttenuatorOn(&on); *valueOut = on ? 1 : 0; break;
    case kVox:        ok = inner_.getVoxOn(&on); *valueOut = on ? 1 : 0; break;
    default:          break;
  }
  return ok;
}

void CachedRigBackend::pollSlow(uint32_t now) {
  // At most ONE slow read per step, so freq/mode polling never waits behind
  // a whole batch of level reads.
  for (int n = 0; n < kSlowCount; n++) {
    const int item = (slowCursor_ + n) % kSlowCount;
    uint32_t gen;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      SlowItem &s = slow_[item];
      if (!s.everWanted || now - s.wantedAtMs >= kWantedForMs || !due(now, s.nextPollMs)) continue;
      s.nextPollMs = now + (isMeter(item) ? kMeterPollMs : kSettingPollMs);
      gen = s.gen;
    }
    slowCursor_ = (item + 1) % kSlowCount;
    int32_t value = 0;
    const bool ok = pollSlowFromInner(item, &value);
    std::lock_guard<std::mutex> lock(mutex_);
    SlowItem &s = slow_[item];
    if (s.gen != gen || s.pendingWrite) return;   // a write overtook this read
    if (ok) {
      s.valid = true;
      s.value = value;
      s.readAtMs = now;
    } else if (isMeter(item)) {
      s.valid = false;   // a stale power/SWR reading is worse than none
    }
    return;
  }
}

void CachedRigBackend::logLimited(const std::string &key, const std::string &message, uint32_t now) {
  // Same failure every poll would otherwise flood the console 5x a second.
  LogSlot *slot = nullptr;
  for (LogSlot &s : logSlots_) {
    if (s.used && s.key == key) { slot = &s; break; }
  }
  if (!slot) {
    for (LogSlot &s : logSlots_) {
      if (!s.used) { slot = &s; break; }
    }
    if (!slot) slot = &logSlots_[0];
    *slot = LogSlot{key, now - 10000, 0, true};
  }
  if (now - slot->lastMs < 10000) {
    slot->suppressed++;
    return;
  }
  std::string line = message;
  if (slot->suppressed > 0) line += " (+" + std::to_string(slot->suppressed) + " similar in the last 10 s)";
  slot->lastMs = now;
  slot->suppressed = 0;
  logger_(line);
}

// ---- RigBackend (caller side, never blocks on CAT) ---------------------

int CachedRigBackend::gainItem(GainKind kind) {
  switch (kind) {
    case GainKind::Af:      return kAf;
    case GainKind::Rf:      return kRf;
    case GainKind::RfPower: return kRfPower;
  }
  return kAf;
}

int CachedRigBackend::meterItem(MeterKind kind) {
  switch (kind) {
    case MeterKind::PowerMeter:    return kPowerMeter;
    case MeterKind::Swr:           return kSwr;
    case MeterKind::SupplyVoltage: return kSupply;
  }
  return kPowerMeter;
}

bool CachedRigBackend::readSlow(int item, int32_t *valueOut) {
  const uint32_t now = clock_();
  std::lock_guard<std::mutex> lock(mutex_);
  SlowItem &s = slow_[item];
  if (!s.everWanted || now - s.wantedAtMs >= kWantedForMs) s.nextPollMs = now;   // poll it right away
  s.everWanted = true;
  s.wantedAtMs = now;
  if (!s.valid) return false;
  // A meter not polled lately (nobody asked for a while) says nothing about
  // now -- this ask restarts polling, the next one gets a fresh value.
  if (isMeter(item) && now - s.readAtMs > kMeterStaleMs) return false;
  *valueOut = s.value;
  return true;
}

bool CachedRigBackend::getFreqHz(double *hzOut) {
  std::lock_guard<std::mutex> lock(mutex_);
  *hzOut = freqHz_;
  return true;
}

bool CachedRigBackend::setFreqHz(double hz) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    pendingFreq_ = true;
    pendingFreqHz_ = hz;
    freqGen_++;
    freqHz_ = hz;
    freqReal_ = true;
    haveFreqCandidate_ = false;
  }
  wake_.notify_one();
  return true;
}

bool CachedRigBackend::getMode(uint8_t *modeOut, bool *dataOut) {
  std::lock_guard<std::mutex> lock(mutex_);
  *modeOut = mode_;
  *dataOut = data_;
  return true;
}

bool CachedRigBackend::setMode(uint8_t mode, bool data) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    pendingMode_ = true;
    pendingModeByte_ = mode;
    pendingData_ = data;
    modeGen_++;
    mode_ = mode;
    data_ = data;
  }
  wake_.notify_one();
  return true;
}

bool CachedRigBackend::getRitHz(int32_t *hzOut) { return readSlow(kRit, hzOut); }

bool CachedRigBackend::setRitHz(int32_t hz) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    SlowItem &s = slow_[kRit];
    s.pendingWrite = true;
    s.pendingValue = hz;
    s.gen++;
    s.valid = true;
    s.value = hz;
  }
  wake_.notify_one();
  return true;
}

bool CachedRigBackend::getGain(GainKind kind, uint8_t *valueOut) {
  int32_t v;
  if (!readSlow(gainItem(kind), &v)) return false;
  *valueOut = (uint8_t)v;
  return true;
}

bool CachedRigBackend::setGain(GainKind kind, uint8_t value) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    SlowItem &s = slow_[gainItem(kind)];
    s.pendingWrite = true;
    s.pendingValue = value;
    s.gen++;
    s.valid = true;
    s.value = value;
  }
  wake_.notify_one();
  return true;
}

bool CachedRigBackend::getMeter(MeterKind kind, uint8_t *rawOut) {
  int32_t v;
  if (!readSlow(meterItem(kind), &v)) return false;
  *rawOut = (uint8_t)v;
  return true;
}

bool CachedRigBackend::getAttenuatorOn(bool *onOut) {
  int32_t v;
  if (!readSlow(kAtt, &v)) return false;
  *onOut = v != 0;
  return true;
}

bool CachedRigBackend::getVoxOn(bool *onOut) {
  int32_t v;
  if (!readSlow(kVox, &v)) return false;
  *onOut = v != 0;
  return true;
}

}  // namespace LocalTrx
