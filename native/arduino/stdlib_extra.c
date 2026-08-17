// itoa() and utoa() for the native build.
//
// stdlib_noniso.h (vendored from the core, unmodified) declares these, but the
// matching .c only defines ltoa/ultoa/dtostrf -- on the ESP32 the int variants
// come from the Xtensa newlib. glibc has no itoa at all, since it was never
// standard, so String(int, base) would fail to link without these.
//
// Kept in a separate file so the vendored sources stay byte-identical to the
// core; see NOTICE.md.

#include "stdlib_noniso.h"

char *itoa(int value, char *result, int base) {
  return ltoa((long)value, result, base);
}

char *utoa(unsigned int value, char *result, int base) {
  return ultoa((unsigned long)value, result, base);
}
