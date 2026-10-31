#include "trxnet_ptt.h"

namespace LocalTrx {

PttLease::Send PttLease::tick(bool want, uint32_t nowMs) {
  if (want) {
    if (!active_) {
      active_ = true;
      keyStartMs_ = nowMs;
      lastSendMs_ = nowMs;
      releaseLeft_ = 0;
      echoSeen_ = false;
      refused_ = false;
      echoChecked_ = false;
      return Send::On;
    }
    if (!echoChecked_ && nowMs - keyStartMs_ >= kEchoTimeoutMs) {
      echoChecked_ = true;
      if (!echoSeen_) echoMissing_ = true;
    }
    if (nowMs - lastSendMs_ >= kRenewMs) {
      lastSendMs_ = nowMs;
      return Send::On;
    }
    return Send::None;
  }

  if (active_) {
    active_ = false;
    releaseLeft_ = kReleaseRepeats;
    lastSendMs_ = nowMs;
    return Send::Off;
  }
  if (releaseLeft_ > 0 && nowMs - lastSendMs_ >= kReleaseRepeatMs) {
    releaseLeft_--;
    lastSendMs_ = nowMs;
    return Send::Off;
  }
  return Send::None;
}

void PttLease::onEcho(bool keyed) {
  deviceKeyed_ = keyed;
  if (!active_) return;
  if (keyed) {
    echoSeen_ = true;
    refused_ = false;
  } else {
    refused_ = true;   // the device answered our "1" with "0": interlock, its own CW, lease lost
  }
}

bool PttLease::takeEchoMissing() {
  bool missing = echoMissing_;
  echoMissing_ = false;
  return missing;
}

void CwCoalescer::add(const std::string &text, uint32_t nowMs) {
  buffer_ += text;
  lastAddMs_ = nowMs;
}

bool CwCoalescer::take(std::string *chunkOut, uint32_t nowMs) {
  if (buffer_.empty()) return false;
  if (buffer_.size() < kMaxChunk && nowMs - lastAddMs_ < kGatherMs) return false;
  size_t n = buffer_.size() < kMaxChunk ? buffer_.size() : kMaxChunk;
  *chunkOut = buffer_.substr(0, n);
  buffer_.erase(0, n);
  return true;
}

}  // namespace LocalTrx
