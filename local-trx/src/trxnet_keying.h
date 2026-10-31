// trxnet_keying.h -- where keying.cwBackend / keying.pttBackend "trxnet"
// plug into the existing keying seams (keying_backend.h, key_runner.h), so
// civ_router.cpp and KeyRunner stay unaware of TrxNet.
#pragma once

#include <atomic>
#include <cstdio>
#include <string>

#include "key_runner.h"
#include "keying_backend.h"
#include "trxnet_link.h"

namespace LocalTrx {

// keying.pttBackend "trxnet": the key stays on `keyLine` (serial DTR/RTS, or
// the logging fallback), PTT becomes the device's /s-ptt lease. KeyRunner
// raises PTT through setPtt() both for audio (CI-V 0x1C) and around serial
// CW/FSK, so both go to the device.
class TrxnetPttKeyLine : public KeyLine {
 public:
  TrxnetPttKeyLine(KeyLine &keyLine, TrxnetLink &link) : keyLine_(keyLine), link_(link) {}

  void setKey(bool down) override { keyLine_.setKey(down); }
  void setPtt(bool on) override {
    link_.setPtt(on);
    std::printf("[ptt] %s (TrxNet %s)\n", on ? "ON" : "off", link_.peer().c_str());
    std::fflush(stdout);
  }

 private:
  KeyLine &keyLine_;
  TrxnetLink &link_;
};

// keying.cwBackend "trxnet": CI-V 0x17 text goes to the device, which keys
// it with its own keyer -- at its own speed, which TrxNet cannot set, so the
// CI-V 0x14 0x0C value is only stored and read back. Audio PTT stays with
// KeyRunner (and from there with whichever KeyLine pttBackend picked).
class TrxnetCwKeying : public KeyingBackend {
 public:
  TrxnetCwKeying(TrxnetLink &link, KeyRunner &keyer, int wpm)
      : link_(link), keyer_(keyer), speedRaw_(wpmToCivSpeedRaw(wpm)) {}

  bool sendCwText(const std::string &text) override {
    if (link_.sendText(text)) return true;
    std::fprintf(stderr, "warning: trxnet: CW \"%s\" dropped -- %s is not on the network\n",
                 text.c_str(), link_.peer().empty() ? "(no device picked)" : link_.peer().c_str());
    return false;
  }
  uint8_t getCwSpeedRaw() override { return speedRaw_.load(); }
  bool setCwSpeedRaw(uint8_t raw) override {
    speedRaw_ = raw;
    return true;
  }
  bool setAudioPtt(bool on) override { return keyer_.setAudioPtt(on); }
  bool getAudioPtt() const override { return keyer_.getAudioPtt(); }

 private:
  TrxnetLink &link_;
  KeyRunner &keyer_;
  std::atomic<uint8_t> speedRaw_;
};

}  // namespace LocalTrx
