#include "EEPROM.h"

#include "paths.h"

#include <stdio.h>
#include <string.h>

#include <string>

EEPROMClass EEPROM;

namespace {

std::string imagePath() {
  return nativeJoinPath(nativeConfigDir(), "eeprom.bin");
}

}  // namespace

bool EEPROMClass::begin(size_t requested) {
  if (requested == 0) return false;

  if (data && size == requested) return true;
  delete[] data;

  data = new (std::nothrow) uint8_t[requested];
  if (!data) {
    size = 0;
    return false;
  }
  size = requested;

  // Erased-flash semantics -- see the header. Everything not present in the
  // file on disk stays 0xFF.
  memset(data, 0xFF, size);

  if (!nativeEnsureDir(nativeConfigDir())) return false;

  FILE *file = fopen(imagePath().c_str(), "rb");
  if (file) {
    // A short file (older build with a smaller EEPROM_SIZE) leaves the tail at
    // 0xFF, which is exactly how the box behaves when the image grows.
    fread(data, 1, size, file);
    fclose(file);
  }

  dirty = false;
  return true;
}

void EEPROMClass::end() {
  commit();
  delete[] data;
  data = nullptr;
  size = 0;
}

bool EEPROMClass::inRange(int address, size_t width) const {
  return data && address >= 0 && (size_t)address + width <= size;
}

uint8_t EEPROMClass::read(int address) {
  return inRange(address) ? data[address] : 0xFF;
}

void EEPROMClass::write(int address, uint8_t value) {
  if (!inRange(address)) return;
  if (data[address] == value) return;
  data[address] = value;
  dirty = true;
}

bool EEPROMClass::commit() {
  if (!data) return false;
  if (!dirty) return true;
  if (!nativeEnsureDir(nativeConfigDir())) return false;

  // Write to a sibling temp file and rename over the target, so a crash or a
  // pulled plug mid-write cannot leave a half-written configuration behind.
  // The box gets this from NVS; on a PC it has to be done by hand.
  const std::string target = imagePath();
  const std::string temp = target + ".tmp";

  FILE *file = fopen(temp.c_str(), "wb");
  if (!file) return false;

  bool ok = fwrite(data, 1, size, file) == size;
  if (fflush(file) != 0) ok = false;
  if (fclose(file) != 0) ok = false;

  if (!ok) {
    remove(temp.c_str());
    return false;
  }

#ifdef _WIN32
  // Windows rename() fails if the destination exists.
  remove(target.c_str());
#endif
  if (rename(temp.c_str(), target.c_str()) != 0) {
    remove(temp.c_str());
    return false;
  }

  dirty = false;
  return true;
}

uint8_t EEPROMClass::readByte(int address) { return read(address); }

size_t EEPROMClass::writeByte(int address, uint8_t value) {
  write(address, value);
  return 1;
}

// The ESP32 library stores multi-byte values in native (little-endian) order.
// Matching that byte-for-byte is what lets a /config/download taken from the
// box be uploaded into the binary and vice versa.
uint16_t EEPROMClass::readUShort(int address) {
  if (!inRange(address, 2)) return 0xFFFF;
  uint16_t value;
  memcpy(&value, data + address, 2);
  return value;
}

size_t EEPROMClass::writeUShort(int address, uint16_t value) {
  if (!inRange(address, 2)) return 0;
  if (memcmp(data + address, &value, 2) != 0) {
    memcpy(data + address, &value, 2);
    dirty = true;
  }
  return 2;
}

bool EEPROMClass::readBool(int address) { return read(address) != 0; }

size_t EEPROMClass::writeBool(int address, bool value) {
  write(address, value ? 1 : 0);
  return 1;
}
