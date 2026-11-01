// tx_level.h -- the radio's "MOD level", as local-trx answers it: the OS mixer
// volume of the sound card that plays wifilt's TX audio into the radio.
//
// wifilt's TX gain calibration (data/tx-gain-plan-ui.js, CAL PLAN) will not run
// without a MOD level it can read, write and read back -- every knee it stores
// is a knee AT a MOD level (data/tx-gain-cal.js entryStatus()). On an ICOM over
// LAN that is the radio's network MOD level, 1A 05 <subaddress>. Behind
// local-trx the analogue is the level going into the radio's DATA/ACC input,
// i.e. the sound card's own volume, so local-trx answers it on a subaddress no
// ICOM has: 1A 05 99 99 (civ_router.cpp; data/icom-models.js LOCAL_TRX_MOD_CMD
// is the other end). A real radio reached by mistake answers NG, which wifilt
// reads as "not readable", so nothing is ever written to it.
//
// Same encoding as an ICOM MOD level: 0-255, BCD on the wire. The mapping is
// LINEAR AMPLITUDE relative to the mixer's maximum, level/255 =
// 10^((dB - maxDb)/20), because that is what the calibration assumes when it
// rescales a knee measured at another MOD level (tx-gain-cal.js seedFrom():
// knee * measuredAt / now).
//
// The mixer has steps (0.5-1.5 dB on typical USB codecs), but wifilt checks
// that the value it wrote reads back exactly (tx-gain-mod-level.js
// writeLevel()). So the mixer goes to the nearest step AT OR ABOVE the target
// and a software trim, always <= 1 (attenuation only, never gain), takes off
// the rest in AudioPlayback. The read-back is then exact AND true. Something
// else moving the mixer (a desktop volume slider, alsamixer) shows up as a
// mixer that no longer sits where it was left: the trim is dropped and the
// level is reported from the mixer alone -- wifilt then sees a MOD level it did
// not set and marks its table stale, as it does when an ICOM's menu is changed.
#pragma once

#include <cstdint>
#include <functional>
#include <string>

namespace LocalTrx {

// What civ_router.cpp needs, kept to two calls so it can be faked in doctest.
class ModLevelBackend {
 public:
  virtual ~ModLevelBackend() = default;
  virtual bool getModLevel(uint8_t *levelOut) = 0;
  virtual bool setModLevel(uint8_t level) = 0;
};

// One playback volume control, in dB. Implementations: mixer_control.cpp
// (ALSA on Linux, the endpoint volume on Windows); tests use a fake.
class MixerControl {
 public:
  virtual ~MixerControl() = default;
  // The control's playback range. false = unusable (gone, no dB scale).
  virtual bool range(double *minDb, double *maxDb) = 0;
  // Where it is now -- read from the device each time, since something
  // else may have moved it.
  virtual bool getDb(double *dbOut) = 0;
  // Moves to the nearest step at or above `wantDb` (clamped to the range) and
  // says where it landed.
  virtual bool setDbAtOrAbove(double wantDb, double *gotDb) = 0;
  virtual std::string describe() const = 0;
};

class TxLevel : public ModLevelBackend {
 public:
  using Trim = std::function<void(float)>;                    // AudioPlayback::setTrim
  using Persist = std::function<void(int level, double mixerDb)>;   // -> config.json

  // Lowest mixer setting this ever uses. Some controls report a mute
  // sentinel (-9999999 / 100 dB) as their minimum; level 1 is only -48 dB.
  static constexpr double kFloorBelowMaxDb = 96.0;
  // A mixer read this close to where it was left still counts as untouched.
  static constexpr double kSameDb = 0.05;

  TxLevel(MixerControl &mixer, Trim trim, Persist persist);

  // Reads the range. false + *error when the control cannot be used.
  bool open(std::string *error);

  // At startup, from config.json: the level last written and the mixer dB it
  // left. The trim comes back only if the mixer still sits there.
  void restore(int level, double mixerDb);

  bool getModLevel(uint8_t *levelOut) override;
  bool setModLevel(uint8_t level) override;

  float trim() const { return trim_; }

 private:
  static double levelToDb(uint8_t level, double maxDb);
  void applyTrim(float trim);

  MixerControl &mixer_;
  Trim trimOut_;
  Persist persist_;
  bool open_ = false;
  double minDb_ = 0.0, maxDb_ = 0.0;
  bool haveSet_ = false;     // level_/hwDb_ describe what this process left
  uint8_t level_ = 0;
  double hwDb_ = 0.0;
  float trim_ = 1.0f;
};

}  // namespace LocalTrx
