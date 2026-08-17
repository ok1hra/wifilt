// Native stand-in for the ESP32 EEPROM library.
//
// On the box this is NVS-backed flash emulation; here it is a fixed-size file
// (`eeprom.bin`) in the config directory. The sketch stores its 360-byte
// configuration through this API at 117 call sites, with the byte map
// documented at wifilt.ino:128-178.
//
// CRITICAL: an absent or short image reads back as 0xFF, not zero. The ESP32
// library does memset(0xFF) for a missing NVS blob (EEPROM.cpp:112) because
// that is what erased flash looks like, and the sketch's byte map relies on it
// -- "0xff = unprogrammed" appears throughout. Zero-filling here would silently
// turn every unset field into a valid-looking 0 on first run.
#pragma once

#include <stddef.h>
#include <stdint.h>

class EEPROMClass {
public:
  bool begin(size_t size);
  void end();

  uint8_t read(int address);
  void    write(int address, uint8_t value);

  // Writes the in-memory image back to disk. Returns false if the file could
  // not be written, which the sketch treats as a failed save.
  bool commit();

  uint8_t readByte(int address);
  size_t  writeByte(int address, uint8_t value);

  uint16_t readUShort(int address);
  size_t   writeUShort(int address, uint16_t value);

  bool   readBool(int address);
  size_t writeBool(int address, bool value);

  size_t length() const { return size; }

private:
  bool     inRange(int address, size_t width = 1) const;
  uint8_t *data = nullptr;
  size_t   size = 0;
  bool     dirty = false;
};

extern EEPROMClass EEPROM;
