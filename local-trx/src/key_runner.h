// key_runner.h -- the dedicated high-priority-ish thread bod 9 calls for
// (real timer, not ESP32-style blocking delay()) that actually walks a
// CwEngine/FskEngine KeyEvent sequence against a real key line.
//
// This is the one place CW-over-CI-V (civ_router.h's KeyingBackend, bod 7/8)
// and FSK-over-TrxNet (trxnet_peer.h, bod 15) meet: both are mode-exclusive
// and share one physical "key" line, so both route through one KeyRunner.
// PTT is gated by KeyRunner itself, not by the caller -- wifilt.ino sends
// neither a matching PTT signal alongside CI-V 0x17 (a real radio's own
// internal keyer raises its own PTT) nor alongside a TrxNet "/s-cw" message
// (bod 15: "no PTT signal on that path at all"), so local-trx has to stand
// in for that, using wifilt.ino's own PTTlead=400/PTTtail=200 constants
// [wifilt.ino:389-390] for consistent behaviour.
#pragma once

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>

#include "keyer.h"
#include "keying_backend.h"

namespace LocalTrx {

// The only thing serial_key.h has to implement (bod 6: libserialport DTR/RTS,
// blocked on the dev machine missing libserialport-dev as of 2026-08-31 --
// see docs/local-trx-implementace.md). KeyRunner and everything upstream of
// it (keyer.h, civ_router.h, trxnet_peer.h) needs nothing more than this.
class KeyLine {
 public:
  virtual ~KeyLine() = default;
  virtual void setKey(bool down) = 0;
  virtual void setPtt(bool on) = 0;
};

class KeyRunner : public KeyingBackend {
 public:
  explicit KeyRunner(KeyLine &line, int initialWpm = 20);
  ~KeyRunner() override;

  // KeyingBackend (CW-over-CI-V).
  bool sendCwText(const std::string &text) override;
  uint8_t getCwSpeedRaw() override;
  bool setCwSpeedRaw(uint8_t raw) override;

  // FSK-over-TrxNet (bod 15) -- same mode-exclusive gate as sendCwText().
  bool sendFskText(const std::string &text);

  // wifilt.ino's own abort convention on the "/s-cw" TrxNet path: a single
  // 0xFF byte means "stop now", not text to key [wifilt.ino:4043-4045].
  // Not wired to CI-V 0x17 -- wifilt.ino has no equivalent CW-abort message
  // on that path (CW abort there is a real radio's own front-panel concern).
  void abort();

  // CI-V 0x1C 0x00 (bod: fáze 3) -- see keying_backend.h's own comment.
  bool setAudioPtt(bool on) override;
  bool getAudioPtt() const override { return audioPtt_.load(); }

  bool busy() const { return busy_.load(); }

 private:
  enum class Mode { Cw, Fsk };

  void threadMain();
  void runSequence(const std::vector<KeyEvent> &events);

  KeyLine &line_;
  std::atomic<int> wpm_;
  // Persistent LETTERS/FIGURES shift state (wifilt.ino's own `fig1`/`space`
  // globals persist across a whole session the same way) -- only ever
  // touched by the worker thread itself, never the caller, so this needs no
  // lock unlike wpm_ above (read from both threads: the caller via
  // get/setCwSpeedRaw, the worker via threadMain()'s CwEngine construction).
  FskEngine fsk_;

  std::thread thread_;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::atomic<bool> stopThread_{false};
  std::atomic<bool> abortRequested_{false};
  std::atomic<bool> busy_{false};
  std::atomic<bool> audioPtt_{false};

  bool hasPending_ = false;
  Mode pendingMode_ = Mode::Cw;
  std::string pendingText_;
};

}  // namespace LocalTrx
