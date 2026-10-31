#include "trxnet_rig.h"

#include <cmath>

namespace LocalTrx {

int TrxnetRigBackend::modeClass(uint8_t civMode) {
  if (civMode == 0x03 || civMode == 0x07) return 0;
  if (civMode == 0x04 || civMode == 0x08) return 1;
  return 2;
}

void TrxnetRigBackend::onPeerHz(uint32_t hz) {
  if (hz == 0) return;   // OI3 before its first CAT answer -- not a reading
  freqHz_ = hz;
  freqReal_ = true;
}

void TrxnetRigBackend::onPeerMode(uint8_t civMode) {
  if (modeCommanded_ && modeClass(civMode) == modeClass(mode_)) return;   // the device's rounding of ours
  mode_ = civMode;
  data_ = false;
  modeCommanded_ = false;
}

bool TrxnetRigBackend::takeFreqCommand(uint32_t *hzOut) {
  if (!pendingFreq_) return false;
  pendingFreq_ = false;
  *hzOut = pendingFreqHz_;
  return true;
}

bool TrxnetRigBackend::takeModeCommand(uint8_t *civModeOut) {
  if (!pendingMode_) return false;
  pendingMode_ = false;
  *civModeOut = pendingModeByte_;
  return true;
}

bool TrxnetRigBackend::getFreqHz(double *hzOut) {
  *hzOut = freqHz_;
  return true;
}

bool TrxnetRigBackend::setFreqHz(double hz) {
  if (!(hz > 0.0) || hz > 4294967295.0) return false;
  uint32_t value = (uint32_t)std::lround(hz);
  freqHz_ = value;   // optimistic, the device's /hz echo confirms it
  pendingFreq_ = true;
  pendingFreqHz_ = value;
  return true;
}

bool TrxnetRigBackend::getMode(uint8_t *modeOut, bool *dataOut) {
  *modeOut = mode_;
  *dataOut = data_;
  return true;
}

bool TrxnetRigBackend::setMode(uint8_t mode, bool data) {
  mode_ = mode;
  data_ = data;
  modeCommanded_ = true;
  // The DATA flag has no TrxNet encoding -- the device gets the plain mode.
  pendingMode_ = true;
  pendingModeByte_ = mode;
  return true;
}

}  // namespace LocalTrx
