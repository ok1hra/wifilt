// trxnet_ptt.h -- the timing halves of TrxnetLink (trxnet_link.h) that need
// no network: the /s-ptt lease (TrxNet INTEGRATION.md 7.3) and gathering
// CI-V 0x17 frames into /s-cw messages. Clock in, decision out, so doctest
// can drive both deterministically.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace LocalTrx {

// Commander side of the PTT lease. The device unkeys by itself 1500 ms after
// the last "1", so a lost "0", a dead local-trx or a pulled cable can never
// leave the radio transmitting.
class PttLease {
 public:
  static constexpr uint32_t kRenewMs = 300;          // INTEGRATION.md 7.3: MUST be <= 500
  static constexpr uint32_t kReleaseRepeatMs = 100;  // the "0" twice more within 200 ms
  static constexpr int      kReleaseRepeats = 2;
  static constexpr uint32_t kEchoTimeoutMs = 1000;   // no /ptt=1 by then = not supported or refused

  enum class Send { None, On, Off };

  // Every poll, with whether PTT is wanted right now. Returns what to send.
  Send tick(bool want, uint32_t nowMs);
  // /ptt from the device.
  void onEcho(bool keyed);

  // Once per keying, true when the device has not confirmed with /ptt=1
  // within kEchoTimeoutMs -- older firmware without /s-ptt, or a refusal
  // it answered with /ptt=0 (refused() tells which).
  bool takeEchoMissing();
  bool refused() const { return refused_; }
  bool keyedByDevice() const { return deviceKeyed_; }

 private:
  bool active_ = false;
  uint32_t keyStartMs_ = 0;
  uint32_t lastSendMs_ = 0;
  int releaseLeft_ = 0;
  bool echoSeen_ = false;
  bool refused_ = false;
  bool deviceKeyed_ = false;
  bool echoChecked_ = false;
  bool echoMissing_ = false;
};

// wifilt sends CW text as CI-V 0x17 frames of at most 30 characters, back to
// back. One /s-cw per frame would be several CON messages where one fits:
// frames arriving within kGatherMs of each other go out together, split at
// kMaxChunk -- TrxNet's payload limit, and OI3's text buffer.
class CwCoalescer {
 public:
  static constexpr uint32_t kGatherMs = 30;
  static constexpr size_t kMaxChunk = 64;

  void add(const std::string &text, uint32_t nowMs);
  // The next message to send, once nothing has been added for kGatherMs.
  bool take(std::string *chunkOut, uint32_t nowMs);
  void clear() { buffer_.clear(); }

 private:
  std::string buffer_;
  uint32_t lastAddMs_ = 0;
};

}  // namespace LocalTrx
