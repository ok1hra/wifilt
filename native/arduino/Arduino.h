// Native (Linux/Windows) stand-in for the ESP32 core's Arduino.h.
//
// Scope is deliberately narrow: this declares only what wifilt.ino actually
// uses, which was measured rather than guessed. Notably the sketch uses none of
// min()/max()/constrain()/abs()/map(), so this header does not define those
// macros and cannot poison the C++ standard headers the way the real one does.
#pragma once

// Windows must be pulled in BEFORE the Arduino pin constants below. winuser.h
// declares `typedef struct tagINPUT { ... } INPUT;` and Arduino defines INPUT as
// a macro; whichever lands second loses. Getting Windows in first means the
// typedef is already parsed, and the macro that follows only affects our own
// code -- which never names the Windows INPUT type.
//
// WIN32_LEAN_AND_MEAN drops the parts of the API nothing here uses, and NOMINMAX
// stops windows.h defining min/max as macros, which would break <chrono> and
// <algorithm> in every file that includes this one.
#ifdef _WIN32
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #ifndef NOMINMAX
    #define NOMINMAX
  #endif
  #include <windows.h>
#endif

#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <math.h>

// Declared before the core headers below, because WCharacter.h is written in
// terms of `boolean`.
typedef uint8_t  byte;
typedef uint16_t word;

// On Windows this must be spelled exactly as rpcndr.h spells it. That header
// declares `typedef unsigned char boolean`, and it arrives in some translation
// units but not others, because WIN32_LEAN_AND_MEAN keeps it out of the plain
// windows.h path -- so neither "always bool" nor "let Windows provide it" works.
// An identical repeated typedef is legal, so matching it is the one spelling
// that compiles either way. It is also ordinary Arduino: the AVR core has always
// aliased boolean to uint8_t, and the sketch only ever stores true or false.
#ifdef _WIN32
typedef unsigned char boolean;
#else
typedef bool boolean;
#endif

#include "esp32-hal.h"
#include "esp32-hal-log.h"
#include "esp_system.h"
#include "pgmspace.h"
#include "stdlib_noniso.h"
#include "WString.h"
#include "WCharacter.h"
#include "Printable.h"
#include "Print.h"
#include "Stream.h"
#include "IPAddress.h"

#define HIGH 0x1
#define LOW  0x0

#define INPUT        0x01
#define OUTPUT       0x03
#define INPUT_PULLUP 0x05

#define LSBFIRST 0
#define MSBFIRST 1

// There is no flash-vs-RAM distinction on a PC, so F() and PSTR() collapse to
// the bare literal. String and Print already accept const char*, so every
// existing call site keeps working.
#ifndef F
  #define F(string_literal) (string_literal)
#endif
#ifndef PSTR
  #define PSTR(string_literal) (string_literal)
#endif

long random(long howbig);
long random(long howsmall, long howbig);
void randomSeed(unsigned long seed);

// ESP32 places this in RTC memory, which survives a panic reset but not a power
// cycle -- the sketch uses it to notice that it rebooted while the PTT was
// keyed. A PC process that dies loses everything, so the attribute collapses to
// nothing and the flag simply starts clear. That is the honest behaviour: after
// a crash the transmitter is unkeyed anyway, because the OS closed the sockets.
#ifndef RTC_NOINIT_ATTR
  #define RTC_NOINIT_ATTR
#endif
#ifndef IRAM_ATTR
  #define IRAM_ATTR
#endif

// BSD string helpers, used by icomLanClient.h for the ICOM login credentials
// where truncation must be safe rather than clever.
//
// Availability is a moving target: the BSDs and macOS always had them, glibc
// only gained them in 2.38, and mingw has neither. Declaring them where libc
// already provides them would clash, so the guard is deliberate rather than
// defensive -- see the matching definition in Arduino.cpp.
#if !defined(__APPLE__) && !defined(__FreeBSD__) && !defined(__OpenBSD__) && \
    !defined(__NetBSD__) &&                                                  \
    !(defined(__GLIBC__) &&                                                  \
      (__GLIBC__ > 2 || (__GLIBC__ == 2 && __GLIBC_MINOR__ >= 38)))
  #define WIFILT_PROVIDES_STRLCPY 1

  #ifdef __cplusplus
  extern "C" {
  #endif
  size_t strlcpy(char *destination, const char *source, size_t size);
  size_t strlcat(char *destination, const char *source, size_t size);
  #ifdef __cplusplus
  }
  #endif
#endif

// ---------------------------------------------------------------------------
// GPIO
//
// The PC build has no pins. These stay as no-ops rather than being #ifdef'd out
// of the sketch, so the shared source compiles unchanged; SETUP hides every
// feature that would reach them by reporting caps.gpio = false. CW/FSK keying,
// the band decoder, the status LED, radio power and the HW-revision divider all
// land here and quietly do nothing.
// ---------------------------------------------------------------------------
void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t val);
int  digitalRead(uint8_t pin);
int  analogRead(uint8_t pin);
void shiftOut(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder, uint8_t val);

void     ledcSetup(uint8_t chan, double freq, uint8_t resolutionBits);
void     ledcAttachPin(uint8_t pin, uint8_t chan);
void     ledcWrite(uint8_t chan, uint32_t duty);
uint32_t ledcRead(uint8_t chan);

// ---------------------------------------------------------------------------
// Serial
//
// UART0 on the ESP32 carries two multiplexed things: the interactive CLI and
// (when a slot is configured for it) the CI-V bus. The PC build drops CI-V
// entirely -- see caps.civ -- but keeps the CLI, mapped onto stdin/stdout. That
// costs almost nothing and leaves the daemon debuggable from the terminal it
// was launched in.
// ---------------------------------------------------------------------------
class HardwareSerial : public Stream {
public:
  void begin(unsigned long baud, uint32_t config = 0, int8_t rxPin = -1,
             int8_t txPin = -1);
  void end();
  void setRxBufferSize(size_t size);
  void flush() override;

  int  available() override;
  int  read() override;
  int  peek() override;
  size_t write(uint8_t c) override;
  size_t write(const uint8_t *buffer, size_t size) override;
  using Print::write;

  operator bool() const { return true; }

private:
  int  pending = -1;   // one-byte pushback for peek()/available()
  // Latched once stdin reaches end of file. Without this, a daemon started
  // with stdin on /dev/null (systemd, nohup, any service manager) spins at
  // 100 % CPU forever: serialPump() loops on `while (Serial.available() > 0)`,
  // poll() keeps reporting the descriptor readable at EOF, and read() keeps
  // returning -1. Nothing else in the loop, HTTP included, ever runs again.
  bool closed = false;
};

extern HardwareSerial Serial;

// ---------------------------------------------------------------------------
// ESP
//
// The sketch calls ESP.restart() in ten places -- after saving WiFi settings,
// after a config upload, from the CLI, and on unrecoverable faults. On the box
// that is a reboot; here it re-executes the binary in place, so the operator
// gets the same "it came back with the new settings" behaviour instead of the
// daemon simply vanishing.
// ---------------------------------------------------------------------------
class EspClass {
public:
  [[noreturn]] void restart();
  uint32_t getFreeHeap();
  uint32_t getHeapSize();
  String   getChipModel();
};

extern EspClass ESP;
