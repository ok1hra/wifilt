// keying_backend.h -- the seam between civ_router.cpp and the keying
// subsystem (bod 7/8), mirroring rig_backend.h's split for hamlib.
//
// civ_router.cpp never touches KeyRunner/serial_key.h directly: it only
// enqueues a CW send or reads/writes the CW speed, both fire-and-forget.
// wifilt.ino's own catWriteFrame() confirms this is the right shape -- its
// `broadcastTx` parameter, which looks like a "wait for the reply" flag, is
// read exactly once via `(void)broadcastTx;` [wifilt.ino:4899] and then never
// used again, so wifilt.ino never actually blocks waiting for a CW ack.
#pragma once

#include <cstdint>
#include <string>

namespace LocalTrx {

class KeyingBackend {
 public:
  virtual ~KeyingBackend() = default;

  // Enqueues `text` for CW transmission at the backend's current WPM.
  // Non-blocking: the actual dit/dah timing runs on a dedicated thread (bod
  // 9), never inside the CI-V dispatch/UDP poll path. Returns false only
  // when a transmission is already in progress (CW/FSK are mode-exclusive,
  // bod 7 -- they share one physical "key" line).
  virtual bool sendCwText(const std::string &text) = 0;

  // CI-V 0x14 0x0C, ICOM's own 0-255 CW-speed scale (6-48 WPM linear -- no
  // existing wifilt.ino convention to match: it only ever READS this
  // subcommand for display [wifilt.ino:6704], never writes it, so there was
  // nothing to port here, only the real ICOM CI-V convention to follow).
  virtual uint8_t getCwSpeedRaw() = 0;
  virtual bool setCwSpeedRaw(uint8_t raw) = 0;

  // CI-V 0x1C 0x00 (bod: fáze 3) -- direct PTT for audio TX, exactly what
  // audioPttOn()/audioPttOff() send [wifilt.ino:9427,9436]: {0x1C,0x00,0x01}
  // / {0x1C,0x00,0x00}. Independent of sendCwText()'s own self-timed PTT
  // sequencing (bod 7/8) -- returns false (state left unchanged) while a
  // CW/FSK job is actually keying, since audio PTT and keyed CW/FSK are
  // mutually exclusive at the radio level, not something to silently
  // override.
  virtual bool setAudioPtt(bool on) = 0;
  virtual bool getAudioPtt() const = 0;
};

// CI-V 0x14 0x0C's 0-255 scale <-> WPM. Exposed for doctest.
uint8_t wpmToCivSpeedRaw(int wpm);
int civSpeedRawToWpm(uint8_t raw);

}  // namespace LocalTrx
