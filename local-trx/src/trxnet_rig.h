// trxnet_rig.h -- RigBackend for cat.backend "trxnet": the radio's frequency
// and mode come from a TrxNet device (an OI3 keyer polling the radio over
// CI-V), and commands go back to it as /s-hz and /s-mode.
//
// Pure state, no network: TrxnetLink (trxnet_link.h) feeds it what the
// device publishes and drains the commands it queues, both from the main
// loop -- the same thread civ_router.cpp calls it from, so no locking, and
// unlike hamlib nothing here ever blocks, so no CachedRigBackend in front.
//
// What OI3 can carry, and so what this answers:
//   - frequency: both ways, exact.
//   - mode: OI3 holds its own keyer mode (CW / SSB / FSK / DIGI) and
//     publishes the nearest CI-V byte -- SSB is always 0x01, DIGI is 0x05,
//     the DATA flag does not exist on TrxNet at all. Reported as-is, wifilt
//     would see its own USB-D come back as USB and command it again forever.
//     So the commanded mode is kept, and /mode from the device only replaces
//     it when it lands in a different class (CW / RTTY / everything else):
//     the operator switched the mode at the radio or the keyer.
//   - everything else (RIT, gains, meters, ATT, VOX): no TrxNet topic, so no
//     reply -- the same "no answer beats a guessed number" rule rig_backend.h
//     states, which wifilt already tolerates.
#pragma once

#include <cstdint>

#include "rig_backend.h"

namespace LocalTrx {

class TrxnetRigBackend : public RigBackend {
 public:
  // Network side (TrxnetLink).
  void onPeerHz(uint32_t hz);
  void onPeerMode(uint8_t civMode);
  bool takeFreqCommand(uint32_t *hzOut);
  bool takeModeCommand(uint8_t *civModeOut);
  bool haveFreq() const { return freqReal_; }

  // Until the device has published anything, freq/mode answer inert defaults
  // (0 Hz, USB) -- CachedRigBackend's convention for a rig not open yet, so
  // wifilt's CAT liveness probe keeps the LAN session (and RX audio) up.
  bool getFreqHz(double *hzOut) override;
  bool setFreqHz(double hz) override;
  bool getMode(uint8_t *modeOut, bool *dataOut) override;
  bool setMode(uint8_t mode, bool data) override;

  bool getRitHz(int32_t *) override { return false; }
  bool setRitHz(int32_t) override { return false; }
  bool getGain(GainKind, uint8_t *) override { return false; }
  bool setGain(GainKind, uint8_t) override { return false; }
  bool getMeter(MeterKind, uint8_t *) override { return false; }
  bool getAttenuatorOn(bool *) override { return false; }
  bool getVoxOn(bool *) override { return false; }

  // 0 = CW/CW-R, 1 = RTTY/RTTY-R, 2 = everything else. Exposed for doctest.
  static int modeClass(uint8_t civMode);

 private:
  uint32_t freqHz_ = 0;
  bool freqReal_ = false;
  bool pendingFreq_ = false;
  uint32_t pendingFreqHz_ = 0;

  uint8_t mode_ = 0x01;
  bool data_ = false;
  bool modeCommanded_ = false;   // mode_ came from wifilt, not from the device
  bool pendingMode_ = false;
  uint8_t pendingModeByte_ = 0;
};

}  // namespace LocalTrx
