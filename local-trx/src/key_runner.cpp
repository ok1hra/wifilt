#include "key_runner.h"

#include <chrono>

namespace LocalTrx {

namespace {
constexpr int kPttLeadMs = 400;   // wifilt.ino:389 PTTlead
constexpr int kPttTailMs = 200;   // wifilt.ino:390 PTTtail
}  // namespace

KeyRunner::KeyRunner(KeyLine &line, int initialWpm) : line_(line), wpm_(initialWpm) {
  thread_ = std::thread(&KeyRunner::threadMain, this);
}

KeyRunner::~KeyRunner() {
  stopThread_ = true;
  cv_.notify_one();
  if (thread_.joinable()) thread_.join();
}

bool KeyRunner::sendCwText(const std::string &text) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (busy_.load() || hasPending_) return false;
    pendingMode_ = Mode::Cw;
    pendingText_ = text;
    hasPending_ = true;
  }
  cv_.notify_one();
  return true;
}

bool KeyRunner::sendFskText(const std::string &text) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (busy_.load() || hasPending_) return false;
    pendingMode_ = Mode::Fsk;
    pendingText_ = text;
    hasPending_ = true;
  }
  cv_.notify_one();
  return true;
}

void KeyRunner::abort() { abortRequested_ = true; }

bool KeyRunner::setAudioPtt(bool on) {
  if (busy_.load()) return false;   // CW/FSK job actively keying -- real conflict, refuse
  audioPtt_ = on;
  line_.setPtt(on);
  return true;
}

uint8_t KeyRunner::getCwSpeedRaw() { return wpmToCivSpeedRaw(wpm_.load()); }

bool KeyRunner::setCwSpeedRaw(uint8_t raw) {
  wpm_ = civSpeedRawToWpm(raw);
  return true;
}

void KeyRunner::runSequence(const std::vector<KeyEvent> &events) {
  for (const auto &ev : events) {
    if (abortRequested_.load()) break;
    line_.setKey(ev.level);
    std::this_thread::sleep_for(std::chrono::milliseconds(ev.ms));
  }
}

void KeyRunner::threadMain() {
  while (!stopThread_.load()) {
    std::string text;
    Mode mode;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      cv_.wait(lock, [this] { return hasPending_ || stopThread_.load(); });
      if (stopThread_.load()) break;
      text = std::move(pendingText_);
      mode = pendingMode_;
      hasPending_ = false;
      // Set busy_ HERE, adjacent to clearing hasPending_, not after the lock
      // is released below: setAudioPtt() reads busy_ without taking mutex_
      // at all (see its own comment), so a gap between "hasPending_ cleared"
      // and "busy_ set" is a real window where it -- or a concurrent
      // sendCwText()/sendFskText() under mutex_ -- can see BOTH false and
      // believe the runner idle even though this job is already committed to
      // running. Found by code review: that let setAudioPtt(true) slip a
      // line_.setPtt(true) in just before this job's own line_.setPtt(true)/
      // ...setPtt(false) sequence ran, and the job's end-of-run PTT drop then
      // silently stomped that audio-PTT session's line state.
      busy_ = true;
    }

    abortRequested_ = false;

    // wpm_ is only snapshotted here, not shared with a persistent CwEngine --
    // see key_runner.h's member comment for why that avoids a data race.
    std::vector<KeyEvent> events =
        (mode == Mode::Cw) ? CwEngine(wpm_.load()).encode(text) : fsk_.encode(text);

    line_.setPtt(true);
    // Not abortable mid-lead: wifilt.ino's own delayPumped() during PTTlead
    // does not check abortFskTransmission either [wifilt.ino:7708].
    std::this_thread::sleep_for(std::chrono::milliseconds(kPttLeadMs));

    if (!events.empty()) runSequence(events);

    // wifilt.ino: `if (!fskAborted) delayPumped(PTTtail);` [wifilt.ino:7744] --
    // an aborted transmission drops PTT immediately, it does not linger.
    if (!abortRequested_.load()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(kPttTailMs));
    }

    line_.setKey(false);
    line_.setPtt(false);
    // audioPtt_ tracks the LINE, not "did someone ask for audio PTT" -- the
    // line_.setPtt(false) just above always wins (a CW/FSK job's own PTT
    // gating is unconditional, see this file's header comment), so leaving
    // audioPtt_ at whatever it was before this job started a stale "true"
    // getAudioPtt() would keep reporting even though the physical line was
    // just dropped. Found by code review.
    audioPtt_ = false;
    busy_ = false;
  }
}

}  // namespace LocalTrx
