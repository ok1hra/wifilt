// cat_ptt.h -- keying.pttBackend "cat": PTT as a CAT command through the
// rig backend (hamlib rig_set_ptt(), Kenwood TX0;/TX1;/RX;), the key line
// left where it was. Same seam as TrxnetPttKeyLine (trxnet_keying.h):
// KeyRunner raises PTT through setPtt() both for audio (CI-V 0x1C) and
// around serial CW/FSK, so both become CAT commands.
#pragma once

#include <cstdio>

#include "key_runner.h"
#include "rig_backend.h"

namespace LocalTrx {

class CatPttKeyLine : public KeyLine {
 public:
  // rig is CachedRigBackend in local-trx: setPtt() only queues, the worker
  // thread sends it and logs a refusal (cached_rig.h).
  CatPttKeyLine(KeyLine &keyLine, RigBackend &rig, bool dataInput)
      : keyLine_(keyLine), rig_(rig), dataInput_(dataInput) {}

  void setKey(bool down) override { keyLine_.setKey(down); }
  void setPtt(bool on) override {
    if (!rig_.setPtt(on, dataInput_)) {
      std::fprintf(stderr, "warning: CAT PTT %s refused -- %s\n", on ? "on" : "off",
                   rig_.lastError().empty() ? "this CAT backend has no PTT" : rig_.lastError().c_str());
    }
    std::printf("[ptt] %s (CAT, %s input)\n", on ? "ON" : "off", dataInput_ ? "data" : "mic");
    std::fflush(stdout);
  }

 private:
  KeyLine &keyLine_;
  RigBackend &rig_;
  bool dataInput_;
};

}  // namespace LocalTrx
