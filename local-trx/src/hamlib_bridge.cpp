#include "hamlib_bridge.h"

#include <cstdio>
#include <cstring>

namespace LocalTrx {

rmode_t civModeToHamlib(uint8_t civMode, bool data) {
  // Table matches civ_router.cpp's civModeName() byte-for-byte (both trace
  // back to wifilt.ino's decodeModeName() [wifilt.ino:1349]).
  if (data) {
    // Only the modes ICOM itself offers a DATA variant of (USB-D/LSB-D/
    // FM-D/AM-D on the IC-7300/705/7610).
    switch (civMode) {
      case 0x00: return RIG_MODE_PKTLSB;
      case 0x01: return RIG_MODE_PKTUSB;
      case 0x02: return RIG_MODE_PKTAM;
      case 0x05: return RIG_MODE_PKTFM;
      default:   return RIG_MODE_NONE;
    }
  }
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

bool hamlibModeToCiv(rmode_t mode, uint8_t *civModeOut, bool *dataOut) {
  uint8_t civ;
  bool data = false;
  switch (mode) {
    case RIG_MODE_LSB:    civ = 0x00; break;
    case RIG_MODE_USB:    civ = 0x01; break;
    case RIG_MODE_AM:     civ = 0x02; break;
    case RIG_MODE_CW:     civ = 0x03; break;
    case RIG_MODE_RTTY:   civ = 0x04; break;
    case RIG_MODE_FM:     civ = 0x05; break;
    case RIG_MODE_WFM:    civ = 0x06; break;
    case RIG_MODE_CWR:    civ = 0x07; break;
    case RIG_MODE_RTTYR:  civ = 0x08; break;
    case RIG_MODE_PKTLSB: civ = 0x00; data = true; break;
    case RIG_MODE_PKTUSB: civ = 0x01; data = true; break;
    case RIG_MODE_PKTAM:  civ = 0x02; data = true; break;
    case RIG_MODE_PKTFM:  civ = 0x05; data = true; break;
    default:              return false;   // no counterpart -- caller must not guess
  }
  *civModeOut = civ;
  *dataOut = data;
  return true;
}

HamlibRigBackend::HamlibRigBackend(rig_model_t rigModel, std::string port, int baud)
    : rigModel_(rigModel), port_(std::move(port)), baud_(baud) {}

HamlibRigBackend::~HamlibRigBackend() { close(); }

void HamlibRigBackend::close() {
  if (!rig_) return;
  rig_close(rig_);
  rig_cleanup(rig_);
  rig_ = nullptr;
}

// rigerror2(), not rigerror(): since hamlib 4.5 the latter appends hamlib's
// whole recent debug-message buffer to the text.
bool HamlibRigBackend::check(int rc, const char *what) {
  if (rc == RIG_OK) return true;
  lastError_ = std::string(what) + ": " + rigerror2(rc);
  return false;
}

bool HamlibRigBackend::open(std::string *error) {
  close();
  rig_ = rig_init(rigModel_);
  if (!rig_) {
    lastError_ = "rig_init failed for model " + std::to_string(rigModel_);
    if (error) *error = lastError_;
    return false;
  }

  // Port and speed through rig_set_conf() rather than poking
  // rig->state.rigport directly: that struct field was renamed in hamlib
  // 4.6 (ports moved behind accessor macros), the conf tokens work the same
  // on 4.5 (Linux distro packages) and 4.7 (the cross-built Windows/ARM64 libs).
  auto setConf = [this](const char *name, const std::string &value) {
    int rc = rig_set_conf(rig_, rig_token_lookup(rig_, name), value.c_str());
    if (rc != RIG_OK) lastError_ = std::string("rig_set_conf ") + name + ": " + rigerror2(rc);
    return rc == RIG_OK;
  };
  bool confOk = true;
  if (!port_.empty()) confOk = setConf("rig_pathname", port_) && confOk;
  // serial_speed only exists for serial-port rigs -- hamlib's Dummy (and
  // network/USB backends) reject it as an invalid parameter.
  if (baud_ > 0 && rig_->caps->port_type == RIG_PORT_SERIAL)
    confOk = setConf("serial_speed", std::to_string(baud_)) && confOk;
  if (!confOk) {
    if (error) *error = lastError_;
    rig_cleanup(rig_);
    rig_ = nullptr;
    return false;
  }

  int rc = rig_open(rig_);
  if (rc != RIG_OK) {
    lastError_ = std::string("rig_open failed: ") + rigerror2(rc);
    if (error) *error = lastError_;
    rig_cleanup(rig_);
    rig_ = nullptr;
    return false;
  }
  return true;
}

bool HamlibRigBackend::reopen(std::string *error) { return open(error); }

bool HamlibRigBackend::inRigRange(double hz) const {
  // Any of the rig's own receive ranges, all ITU regions. A model whose caps
  // list no range at all gets the benefit of the doubt.
  const freq_range_t *lists[] = {rig_->caps->rx_range_list1, rig_->caps->rx_range_list2,
                                 rig_->caps->rx_range_list3, rig_->caps->rx_range_list4,
                                 rig_->caps->rx_range_list5};
  bool anyRange = false;
  for (const freq_range_t *list : lists) {
    for (int i = 0; i < HAMLIB_FRQRANGESIZ && !RIG_IS_FRNG_END(list[i]); i++) {
      anyRange = true;
      if (hz >= list[i].startf && hz <= list[i].endf) return true;
    }
  }
  return !anyRange;
}

bool HamlibRigBackend::getFreqHz(double *hzOut) {
  if (!rig_) { lastError_ = "rig not open"; return false; }
  freq_t f = 0;
  if (!check(rig_get_freq(rig_, RIG_VFO_CURR, &f), "get_freq")) return false;
  if (f <= 0 || !inRigRange(f)) {
    char buf[96];
    std::snprintf(buf, sizeof(buf), "get_freq: %.0f Hz is outside the rig's own range, discarded", f);
    lastError_ = buf;
    return false;
  }
  *hzOut = f;
  return true;
}

bool HamlibRigBackend::setFreqHz(double hz) {
  if (!rig_) { lastError_ = "rig not open"; return false; }
  return check(rig_set_freq(rig_, RIG_VFO_CURR, (freq_t)hz), "set_freq");
}

bool HamlibRigBackend::getMode(uint8_t *modeOut, bool *dataOut) {
  if (!rig_) { lastError_ = "rig not open"; return false; }
  rmode_t mode = RIG_MODE_NONE;
  pbwidth_t width = 0;
  if (!check(rig_get_mode(rig_, RIG_VFO_CURR, &mode, &width), "get_mode")) return false;
  if (!hamlibModeToCiv(mode, modeOut, dataOut)) {
    lastError_ = std::string("get_mode: no CI-V counterpart for ") + rig_strrmode(mode);
    return false;
  }
  return true;
}

bool HamlibRigBackend::setMode(uint8_t mode, bool data) {
  if (!rig_) { lastError_ = "rig not open"; return false; }
  rmode_t hamlibMode = civModeToHamlib(mode, data);
  if (hamlibMode == RIG_MODE_NONE) {   // unmapped -- do not guess
    lastError_ = "set_mode: no hamlib counterpart for CI-V mode";
    return false;
  }
  return check(rig_set_mode(rig_, RIG_VFO_CURR, hamlibMode, RIG_PASSBAND_NORMAL), "set_mode");
}

bool HamlibRigBackend::getRitHz(int32_t *hzOut) {
  if (!rig_) { lastError_ = "rig not open"; return false; }
  shortfreq_t rit = 0;
  if (!check(rig_get_rit(rig_, RIG_VFO_CURR, &rit), "get_rit")) return false;
  *hzOut = (int32_t)rit;
  return true;
}

bool HamlibRigBackend::setRitHz(int32_t hz) {
  if (!rig_) { lastError_ = "rig not open"; return false; }
  return check(rig_set_rit(rig_, RIG_VFO_CURR, (shortfreq_t)hz), "set_rit");
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

bool HamlibRigBackend::getGain(GainKind kind, uint8_t *valueOut) {
  if (!rig_) { lastError_ = "rig not open"; return false; }
  if (!rig_has_get_level(rig_, gainLevel(kind))) return false;
  value_t val;
  val.f = 0.0f;
  if (!check(rig_get_level(rig_, RIG_VFO_CURR, gainLevel(kind), &val), "get_level")) return false;
  *valueOut = floatToByte(val.f);
  return true;
}

bool HamlibRigBackend::setGain(GainKind kind, uint8_t value) {
  if (!rig_) { lastError_ = "rig not open"; return false; }
  value_t val;
  val.f = (float)value / 255.0f;
  return check(rig_set_level(rig_, RIG_VFO_CURR, gainLevel(kind), val), "set_level");
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
  if (!rig_) { lastError_ = "rig not open"; return false; }
  if (!rig_has_get_level(rig_, level)) return false;
  value_t val;
  val.f = 0.0f;
  if (!check(rig_get_level(rig_, RIG_VFO_CURR, level, &val), "get_level")) return false;

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
  if (!rig_) { lastError_ = "rig not open"; return false; }
  if (!rig_has_get_level(rig_, RIG_LEVEL_ATT)) return false;
  value_t val;
  val.i = 0;
  if (rig_get_level(rig_, RIG_VFO_CURR, RIG_LEVEL_ATT, &val) != RIG_OK) return false;
  *onOut = val.i != 0;
  return true;
}

bool HamlibRigBackend::getVoxOn(bool *onOut) {
  if (!rig_) { lastError_ = "rig not open"; return false; }
  if (!rig_has_get_func(rig_, RIG_FUNC_VOX)) return false;
  int v = 0;
  if (rig_get_func(rig_, RIG_VFO_CURR, RIG_FUNC_VOX, &v) != RIG_OK) return false;
  *onOut = v != 0;
  return true;
}

}  // namespace LocalTrx
