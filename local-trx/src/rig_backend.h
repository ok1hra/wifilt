// rig_backend.h -- the seam between civ_router.cpp (wire-format, transport-free,
// doctest-covered) and whatever actually knows the rig's state.
//
// civ_router.cpp never touches hamlib directly, so it can be unit-tested with
// a trivial in-memory stub (phase 0) and does not change at all when
// hamlib_bridge.cpp (phase 1, real backend) replaces that stub.
#pragma once

#include <cstdint>

namespace LocalTrx {

// Mirrors CI-V level/meter subcommand targets this bridges (bod 11, category a
// plus the 0x14 0x0A RF-power SETTING, added fáze 7 -- it is wire-identical to
// AF/RF gain, a plain 0.0-1.0 hamlib float on a 0-255 CI-V scale, so it shares
// this same seam rather than getting one of its own).
enum class GainKind { Af, Rf, RfPower };

// Read-only meters, bod 11 category (b), fáze 7. Deliberately a SMALL subset
// of what real ICOM CI-V 0x15 exposes -- see getMeter()'s own comment for why
// S-meter and ALC are not here despite hamlib nominally having a level for
// each: this project's rule (bod 3, category c) is "no reply beats a guessed
// number", and those two have no verified raw-scale reference anywhere in
// this repo to invert (unlike SWR/supply-voltage, whose CI-V raw<->physical
// formulas are wifilt's OWN already-shipped decode -- see civ_router.cpp).
enum class MeterKind { PowerMeter, Swr, SupplyVoltage };

class RigBackend {
 public:
  virtual ~RigBackend() = default;

  virtual double  getFreqHz() = 0;
  virtual bool    setFreqHz(double hz) = 0;

  // CI-V mode byte (0x00 LSB .. 0x08 RTTY-R), not hamlib's rmode_t -- the
  // translation table lives in hamlib_bridge.cpp, on the far side of this seam.
  virtual uint8_t getModeByte() = 0;
  virtual bool    setModeByte(uint8_t mode) = 0;

  // Hz, signed -- CI-V 0x21 RIT.
  virtual int32_t getRitHz() = 0;
  virtual bool    setRitHz(int32_t hz) = 0;

  // 0-255, CI-V's own gain scale (0x14 0x01 AF / 0x14 0x02 RF / 0x14 0x0A RF power).
  virtual uint8_t getGain(GainKind kind) = 0;
  virtual bool    setGain(GainKind kind, uint8_t value) = 0;

  // CI-V 0x15, bod 11 category (b), fáze 7. false = this backend does not
  // (or cannot honestly) answer this meter -- civ_router.cpp must then send
  // no reply at all, the same tolerance wifilt already has for a real radio
  // that simply doesn't support a given CI-V read (proven live against a
  // real IC-7610's GPS command, see docs/local-trx-implementace.md bod 11).
  virtual bool getMeter(MeterKind kind, uint8_t *rawOut) = 0;

  // CI-V 0x11 (attenuator engaged) and 0x16 0x47 (VOX engaged), both fáze 7,
  // both single on/off bits -- wifilt only ever READS these (see aux poll
  // rotation, wifilt.ino:5644-5663), so only a read side exists here. false =
  // unsupported, same no-reply convention as getMeter().
  virtual bool getAttenuatorOn(bool *onOut) = 0;
  virtual bool getVoxOn(bool *onOut) = 0;
};

}  // namespace LocalTrx
