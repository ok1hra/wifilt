// ptt_arbiter.h -- one transmitter, two ways to key it: wifilt over ICOM-LAN
// (CI-V 1C 00 through civ_router) and the TS-480 panel's browser microphone
// (ts480_ws.h). Sits in front of the real KeyingBackend; whoever raises audio
// PTT first owns it until they drop it, the other is refused meanwhile.
// wifilt's CW/FSK text is refused while the browser transmits as well.
#pragma once

#include <mutex>
#include <string>

#include "keying_backend.h"

namespace LocalTrx {

class PttArbiter : public KeyingBackend {
 public:
  explicit PttArbiter(KeyingBackend &inner) : inner_(inner) {}

  bool sendCwText(const std::string &text) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (owner_ == Owner::Browser) return false;
    return inner_.sendCwText(text);
  }
  uint8_t getCwSpeedRaw() override { return inner_.getCwSpeedRaw(); }
  bool setCwSpeedRaw(uint8_t raw) override { return inner_.setCwSpeedRaw(raw); }

  // wifilt's side (CI-V 1C 00).
  bool setAudioPtt(bool on) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (owner_ == Owner::Browser) return !on;   // on refused; off has nothing to do
    const bool ok = inner_.setAudioPtt(on);
    if (ok) owner_ = on ? Owner::Lan : Owner::None;
    return ok;
  }
  bool getAudioPtt() const override { return inner_.getAudioPtt(); }

  // The browser's side. `why` says why an "on" was refused.
  bool browserPtt(bool on, std::string *why) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!on) {
      if (owner_ != Owner::Browser) return true;
      inner_.setAudioPtt(false);
      owner_ = Owner::None;
      return true;
    }
    if (owner_ == Owner::Browser) return true;
    if (owner_ == Owner::Lan || inner_.getAudioPtt()) {
      if (why) *why = "wifilt is transmitting";
      return false;
    }
    if (!inner_.setAudioPtt(true)) {
      if (why) *why = "CW/FSK keying in progress";
      return false;
    }
    owner_ = Owner::Browser;
    return true;
  }
  bool browserOwns() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return owner_ == Owner::Browser;
  }

 private:
  enum class Owner { None, Lan, Browser };
  KeyingBackend &inner_;
  mutable std::mutex mutex_;
  Owner owner_ = Owner::None;
};

}  // namespace LocalTrx
