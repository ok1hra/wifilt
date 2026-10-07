// rig_backend.h -- the seam between civ_router.cpp (wire-format, transport-free,
// doctest-covered) and whatever actually knows the rig's state.
//
// civ_router.cpp never touches hamlib directly, so it can be unit-tested with
// a trivial in-memory stub (phase 0) and does not change at all when
// hamlib_bridge.cpp (phase 1, real backend) replaces that stub.
#pragma once

#include <cstdint>
#include <string>

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

  // Every read returns false when it got no trustworthy answer (CAT timeout,
  // garbled reply, a value outside the rig's own range) -- never a default
  // dressed up as a reading. Ignoring hamlib's return code here once let a
  // failed/garbled IC-7300 read reach wifilt as "1409.404.04 MHz".
  virtual bool getFreqHz(double *hzOut) = 0;
  virtual bool setFreqHz(double hz) = 0;

  // CI-V mode byte (0x00 LSB .. 0x08 RTTY-R), not hamlib's rmode_t -- the
  // translation table lives in hamlib_bridge.cpp, on the far side of this seam.
  // `data` is ICOM's separate DATA flag (USB-D = 0x01 + data), the same split
  // CI-V 0x26 carries on the wire; legacy 0x04/0x06 simply cannot express it.
  virtual bool getMode(uint8_t *modeOut, bool *dataOut) = 0;
  virtual bool setMode(uint8_t mode, bool data) = 0;

  // Hz, signed -- CI-V 0x21 RIT.
  virtual bool getRitHz(int32_t *hzOut) = 0;
  virtual bool setRitHz(int32_t hz) = 0;

  // 0-255, CI-V's own gain scale (0x14 0x01 AF / 0x14 0x02 RF / 0x14 0x0A RF power).
  virtual bool getGain(GainKind kind, uint8_t *valueOut) = 0;
  virtual bool setGain(GainKind kind, uint8_t value) = 0;

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

  // Drop and re-establish the CAT link (radio power-cycled, USB serial port
  // re-enumerated). Backends with nothing to reopen keep the default.
  virtual bool reopen(std::string *error) {
    if (error) *error = "this backend cannot reopen";
    return false;
  }

  // Human-readable reason for the most recent failed call, for logging only.
  virtual std::string lastError() const { return std::string(); }
};

}  // namespace LocalTrx
