#include "hamlib_bridge.h"

#include <cstring>

namespace LocalTrx {

rmode_t civModeToHamlib(uint8_t civMode) {
  // Table matches civ_router.cpp's civModeName() byte-for-byte (both trace
  // back to wifilt.ino's decodeModeName() [wifilt.ino:1349]).
  switch (civMode) {
    case 0x00: return RIG_MODE_LSB;
    case 0x01: return RIG_MODE_USB;
    case 0x02: return RIG_MODE_AM;
    case 0x03: return RIG_MODE_CW;
    case 0x04: return RIG_MODE_RTTY;
    case 0x05: return RIG_MODE_FM;
    case 0x06: return RIG_MODE_WFM;
    case 0x07: return RIG_MODE_CWR;
    case 0x08: return RIG_MODE_RTTYR;
    default:   return RIG_MODE_NONE;
  }
}

uint8_t hamlibModeToCiv(rmode_t mode) {
  switch (mode) {
    case RIG_MODE_LSB:   return 0x00;
    case RIG_MODE_USB:   return 0x01;
    case RIG_MODE_AM:    return 0x02;
    case RIG_MODE_CW:    return 0x03;
    case RIG_MODE_RTTY:  return 0x04;
    case RIG_MODE_FM:    return 0x05;
    case RIG_MODE_WFM:   return 0x06;
    case RIG_MODE_CWR:   return 0x07;
    case RIG_MODE_RTTYR: return 0x08;
    default:             return 0xFF;   // no counterpart -- caller must not guess
  }
}

HamlibRigBackend::HamlibRigBackend(rig_model_t rigModel, std::string port, int baud)
    : rigModel_(rigModel), port_(std::move(port)), baud_(baud) {}

HamlibRigBackend::~HamlibRigBackend() {
  if (rig_) {
    rig_close(rig_);
    rig_cleanup(rig_);
  }
}

bool HamlibRigBackend::open(std::string *error) {
  rig_ = rig_init(rigModel_);
  if (!rig_) {
    if (error) *error = "rig_init failed for model " + std::to_string(rigModel_);
    return false;
  }

  if (!port_.empty()) {
    // strncpy() does NOT null-terminate when port_ is >= the destination
    // size -- it silently relies on rig_init() having already zeroed the
    // struct, which is an internal hamlib detail, not a documented
    // guarantee. Terminate explicitly rather than depend on that (found by
    // code review): an unterminated pathname here means whatever hamlib's
    // serial backend reads past the buffer next is undefined.
    std::strncpy(rig_->state.rigport.pathname, port_.c_str(),
                 sizeof(rig_->state.rigport.pathname) - 1);
    rig_->state.rigport.pathname[sizeof(rig_->state.rigport.pathname) - 1] = '\0';
  }
  if (baud_ > 0) {
    rig_->state.rigport.parm.serial.rate = baud_;
  }

  int rc = rig_open(rig_);
  if (rc != RIG_OK) {
    if (error) *error = std::string("rig_open failed: ") + rigerror(rc);
    rig_cleanup(rig_);
    rig_ = nullptr;
    return false;
  }
  return true;
}

double HamlibRigBackend::getFreqHz() {
  freq_t f = 0;
  rig_get_freq(rig_, RIG_VFO_CURR, &f);
  return f;
}

bool HamlibRigBackend::setFreqHz(double hz) {
  return rig_set_freq(rig_, RIG_VFO_CURR, (freq_t)hz) == RIG_OK;
}

uint8_t HamlibRigBackend::getModeByte() {
  rmode_t mode = RIG_MODE_NONE;
  pbwidth_t width = 0;
  rig_get_mode(rig_, RIG_VFO_CURR, &mode, &width);
  uint8_t civ = hamlibModeToCiv(mode);
  return civ == 0xFF ? 0x01 /* USB, least-surprising default */ : civ;
}

bool HamlibRigBackend::setModeByte(uint8_t mode) {
  rmode_t hamlibMode = civModeToHamlib(mode);
  if (hamlibMode == RIG_MODE_NONE) return false;   // unmapped -- do not guess
  return rig_set_mode(rig_, RIG_VFO_CURR, hamlibMode, RIG_PASSBAND_NORMAL) == RIG_OK;
}

int32_t HamlibRigBackend::getRitHz() {
  shortfreq_t rit = 0;
  rig_get_rit(rig_, RIG_VFO_CURR, &rit);
  return (int32_t)rit;
}

bool HamlibRigBackend::setRitHz(int32_t hz) {
  return rig_set_rit(rig_, RIG_VFO_CURR, (shortfreq_t)hz) == RIG_OK;
}

namespace {
setting_t gainLevel(GainKind kind) {
  switch (kind) {
    case GainKind::Af:      return RIG_LEVEL_AF;
    case GainKind::Rf:      return RIG_LEVEL_RF;
    case GainKind::RfPower: return RIG_LEVEL_RFPOWER;
  }
  return RIG_LEVEL_AF;   // unreachable, silences -Wreturn-type
}

uint8_t floatToByte(float v) {
  float clamped = v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v);
  return (uint8_t)(clamped * 255.0f + 0.5f);
}

// A raw 0-255 CI-V level clamp for values NOT already normalised to 0.0-1.0
// (SWR/supply-voltage below arrive already scaled to the 0-255 domain by
// wifilt's own inverted formula, so this is a plain byte clamp, not floatToByte's
// 0.0-1.0 one).
uint8_t clampToByte(float raw) {
  return (uint8_t)(raw < 0.0f ? 0 : (raw > 255.0f ? 255 : raw + 0.5f));
}
}  // namespace

uint8_t HamlibRigBackend::getGain(GainKind kind) {
  value_t val;
  val.f = 0.0f;
  rig_get_level(rig_, RIG_VFO_CURR, gainLevel(kind), &val);
  return floatToByte(val.f);
}

bool HamlibRigBackend::setGain(GainKind kind, uint8_t value) {
  value_t val;
  val.f = (float)value / 255.0f;
  return rig_set_level(rig_, RIG_VFO_CURR, gainLevel(kind), val) == RIG_OK;
}

bool HamlibRigBackend::getMeter(MeterKind kind, uint8_t *rawOut) {
  setting_t level;
  switch (kind) {
    case MeterKind::PowerMeter:    level = RIG_LEVEL_RFPOWER_METER; break;
    case MeterKind::Swr:           level = RIG_LEVEL_SWR; break;
    case MeterKind::SupplyVoltage: level = RIG_LEVEL_VD_METER; break;
    default: return false;
  }
  // The capability bitmask, not just the return code: `rig_get_level()` alone
  // returning RIG_OK is not a reliable "genuinely supported" signal on every
  // backend, so this checks `rig_has_get_level()` first -- the same gate a
  // real rig driver's static caps table uses to honestly say "I do not have
  // this" (bod 3/11's "no reply beats a guessed number"). Verified live
  // 2026-09-01 against hamlib's Dummy backend: RFPOWER_METER/VD_METER/SWR are
  // all consistently granted through local-trx's own open() sequence
  // (main.cpp's HamlibRigBackend::open(), port empty, baud set) -- reproduced
  // across 8 separate process runs, always answered with a live simulated
  // value. (A handful of throwaway ad-hoc probes built with different,
  // non-Makefile compiler invocations saw `rig_has_get_level()` decline the
  // same two levels instead; never reproduced through the actual build, so
  // treated as an artifact of those probes' own compile flags, not a real
  // Dummy quirk worth designing around.)
  if (!rig_has_get_level(rig_, level)) return false;
  value_t val;
  val.f = 0.0f;
  if (rig_get_level(rig_, RIG_VFO_CURR, level, &val) != RIG_OK) return false;

  switch (kind) {
    case MeterKind::PowerMeter:
      *rawOut = floatToByte(val.f);   // already a 0.0-1.0 fraction of max power
      break;
    case MeterKind::Swr:
      // Inverse of wifilt's OWN forward formula (wifilt.ino:6696):
      // stateSwr = 1.0 + raw*3.0/120.0  =>  raw = (swr-1.0)*120.0/3.0
      *rawOut = clampToByte((val.f - 1.0f) * 120.0f / 3.0f);
      break;
    case MeterKind::SupplyVoltage:
      // Inverse of wifilt.ino:6698: stateSupplyVolts = raw*16.0/241.0
      *rawOut = clampToByte(val.f * 241.0f / 16.0f);
      break;
    default:
      return false;
  }
  return true;
}

bool HamlibRigBackend::getAttenuatorOn(bool *onOut) {
  if (!rig_has_get_level(rig_, RIG_LEVEL_ATT)) return false;
  value_t val;
  val.i = 0;
  if (rig_get_level(rig_, RIG_VFO_CURR, RIG_LEVEL_ATT, &val) != RIG_OK) return false;
  *onOut = val.i != 0;
  return true;
}

bool HamlibRigBackend::getVoxOn(bool *onOut) {
  if (!rig_has_get_func(rig_, RIG_FUNC_VOX)) return false;
  int v = 0;
  if (rig_get_func(rig_, RIG_VFO_CURR, RIG_FUNC_VOX, &v) != RIG_OK) return false;
  *onOut = v != 0;
  return true;
}

}  // namespace LocalTrx
