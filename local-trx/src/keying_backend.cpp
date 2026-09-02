#include "keying_backend.h"

namespace LocalTrx {

// ICOM CI-V convention: 0 = 6 WPM, 255 = 48 WPM, linear.
uint8_t wpmToCivSpeedRaw(int wpm) {
  if (wpm < 6) wpm = 6;
  if (wpm > 48) wpm = 48;
  return (uint8_t)(((wpm - 6) * 255 + 21) / 42);   // +21 rounds to nearest, not truncates
}

int civSpeedRawToWpm(uint8_t raw) {
  return 6 + ((int)raw * 42 + 127) / 255;   // +127 rounds to nearest
}

}  // namespace LocalTrx
