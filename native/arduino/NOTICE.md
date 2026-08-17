# Vendored Arduino core files

The following files are copied **verbatim** from the ESP32 Arduino core
`esp32:esp32@2.0.14`
(`~/.arduino15/packages/esp32/hardware/esp32/2.0.14/cores/esp32/`):

| File | Origin |
|---|---|
| `WString.h`, `WString.cpp` | © 2009-10 Hernando Barragan; © 2011 Paul Stoffregen — **LGPL 2.1 or later** |
| `Print.h`, `Print.cpp` | © 2008 David A. Mellis — **LGPL 2.1 or later** |
| `Stream.h`, `Stream.cpp` | Arduino core — **LGPL 2.1 or later** |
| `IPAddress.h`, `IPAddress.cpp` | Arduino core — **LGPL 2.1 or later** |
| `Printable.h` | Arduino core — **LGPL 2.1 or later** |
| `stdlib_noniso.h`, `stdlib_noniso.c` | Arduino core |
| `pgmspace.h` | Arduino core |

Their original licence headers are intact and must stay that way.

## Why copied rather than referenced in place

The native build would otherwise require the full ESP32 core (~500 MB) to be
installed on every build machine, including CI. Copying keeps `make -C native`
self-contained.

## Why these exact files, not a reimplementation

`wifilt.ino` uses `String` 336 times. A hand-written replacement would differ in
edge cases — reserve/capacity growth, `toInt()` on malformed input, implicit
conversions in `+` chains — and those differences would show up as behaviour
that differs between the box and the PC binary, which is precisely what this
port exists to avoid. Reusing the same implementation makes `String` identical
by construction.

## Updating

If the sketch is ever moved to a different ESP32 core version, re-copy these
files from the new core so the two targets keep sharing one `String`.
