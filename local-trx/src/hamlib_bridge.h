// hamlib_bridge.h -- RigBackend implemented over hamlib's C API (fáze 1),
// extended fáze 7 with category (b)'s best-effort meters/ATT/VOX.
//
// Direct linkage, not rigctld (bod 4, closed 2026-08-29). Covers bod 11's
// category (a): freq/mode/RIT/AF+RF gain (+ RF power, wire-identical, fáze 7)
// -- plus category (b)'s SWR/power-meter/supply-voltage/ATT/VOX (fáze 7,
// gated on rig_has_get_level()/rig_has_get_func() so an unsupported backend
// gets no reply, never a fabricated number). CW/FSK/PTT never come through
// here at all (bod 7/8) -- those are keyer.h/serial_key.h/trxnet_peer.h.
#pragma once

#include <string>

#include <hamlib/rig.h>

#include "rig_backend.h"

namespace LocalTrx {

class HamlibRigBackend : public RigBackend {
 public:
  HamlibRigBackend(rig_model_t rigModel, std::string port, int baud);
  ~HamlibRigBackend() override;

  // rig_init() + configure port + rig_open(). false + *error on failure --
  // the Dummy backend (RIG_MODEL_DUMMY) never fails this, which is exactly
  // what makes it usable in CI with no hardware on the bench.
  bool open(std::string *error);

  double  getFreqHz() override;
  bool    setFreqHz(double hz) override;
  uint8_t getModeByte() override;
  bool    setModeByte(uint8_t mode) override;
  int32_t getRitHz() override;
  bool    setRitHz(int32_t hz) override;
  uint8_t getGain(GainKind kind) override;
  bool    setGain(GainKind kind, uint8_t value) override;
  bool    getMeter(MeterKind kind, uint8_t *rawOut) override;
  bool    getAttenuatorOn(bool *onOut) override;
  bool    getVoxOn(bool *onOut) override;

 private:
  rig_model_t rigModel_;
  std::string port_;
  int baud_;
  RIG *rig_ = nullptr;
};

// CI-V mode byte <-> hamlib rmode_t (bod 11 "Mode translace"). Exposed for
// doctest. Returns RIG_MODE_NONE / 0xFF for anything with no counterpart on
// the other side, matching civ_router's "no guess" policy elsewhere.
rmode_t civModeToHamlib(uint8_t civMode);
uint8_t hamlibModeToCiv(rmode_t mode);

}  // namespace LocalTrx
