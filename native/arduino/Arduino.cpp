// Implementation of the native Arduino runtime shim: clock, delay, RNG, the
// GPIO no-ops and a Serial that is really stdin/stdout.

#include "Arduino.h"

#include <chrono>
#include <random>
#include <thread>

#ifdef _WIN32
  #include <conio.h>
  #include <io.h>
#else
  #include <poll.h>
  #include <unistd.h>
#endif

// ---------------------------------------------------------------------------
// Clock
//
// millis() must be monotonic and must start near zero, because the sketch
// stores deadlines as plain unsigned longs and compares them with wraparound
// arithmetic. Anchoring to process start rather than to the epoch keeps those
// comparisons in the same numeric range they occupy on the ESP32.
// ---------------------------------------------------------------------------
namespace {

std::chrono::steady_clock::time_point processStart = std::chrono::steady_clock::now();

std::mt19937 &rng() {
  static std::mt19937 engine{std::random_device{}()};
  return engine;
}

}  // namespace

extern "C" unsigned long millis(void) {
  auto delta = std::chrono::steady_clock::now() - processStart;
  return (unsigned long)std::chrono::duration_cast<std::chrono::milliseconds>(delta).count();
}

extern "C" unsigned long micros(void) {
  auto delta = std::chrono::steady_clock::now() - processStart;
  return (unsigned long)std::chrono::duration_cast<std::chrono::microseconds>(delta).count();
}

extern "C" void delay(uint32_t ms) {
  std::this_thread::sleep_for(std::chrono::milliseconds(ms));
}

extern "C" void delayMicroseconds(uint32_t us) {
  std::this_thread::sleep_for(std::chrono::microseconds(us));
}

extern "C" void yield(void) {
  // A bare sched_yield() in the sketch's polling loops would spin a core flat,
  // so this concedes an actual scheduler tick instead.
  std::this_thread::sleep_for(std::chrono::milliseconds(1));
}

extern "C" uint32_t esp_random(void) {
  std::uniform_int_distribution<uint32_t> dist(0, UINT32_MAX);
  return dist(rng());
}

// ---------------------------------------------------------------------------
// Arduino RNG semantics: random(n) is [0,n), random(a,b) is [a,b).
// ---------------------------------------------------------------------------
long random(long howbig) {
  if (howbig <= 0) return 0;
  std::uniform_int_distribution<long> dist(0, howbig - 1);
  return dist(rng());
}

long random(long howsmall, long howbig) {
  if (howsmall >= howbig) return howsmall;
  return howsmall + random(howbig - howsmall);
}

void randomSeed(unsigned long seed) {
  if (seed != 0) rng().seed((std::mt19937::result_type)seed);
}

// ---------------------------------------------------------------------------
// strlcpy / strlcat -- only where libc does not already supply them.
// Both always NUL-terminate and return the length the source wanted, which is
// how the caller detects truncation.
// ---------------------------------------------------------------------------
#ifdef WIFILT_PROVIDES_STRLCPY

extern "C" size_t strlcpy(char *destination, const char *source, size_t size) {
  const size_t sourceLength = strlen(source);
  if (size) {
    const size_t copy = sourceLength < size - 1 ? sourceLength : size - 1;
    memcpy(destination, source, copy);
    destination[copy] = '\0';
  }
  return sourceLength;
}

extern "C" size_t strlcat(char *destination, const char *source, size_t size) {
  const size_t destinationLength = strnlen(destination, size);
  const size_t sourceLength = strlen(source);
  if (destinationLength == size) return size + sourceLength;

  const size_t room = size - destinationLength - 1;
  const size_t copy = sourceLength < room ? sourceLength : room;
  memcpy(destination + destinationLength, source, copy);
  destination[destinationLength + copy] = '\0';
  return destinationLength + sourceLength;
}

#endif

// ---------------------------------------------------------------------------
// GPIO -- no pins on a PC. See the note in Arduino.h.
// ---------------------------------------------------------------------------
void pinMode(uint8_t, uint8_t) {}
void digitalWrite(uint8_t, uint8_t) {}
int  digitalRead(uint8_t) { return LOW; }
int  analogRead(uint8_t) { return 0; }
void shiftOut(uint8_t, uint8_t, uint8_t, uint8_t) {}

void     ledcSetup(uint8_t, double, uint8_t) {}
void     ledcAttachPin(uint8_t, uint8_t) {}
void     ledcWrite(uint8_t, uint32_t) {}
uint32_t ledcRead(uint8_t) { return 0; }

// ---------------------------------------------------------------------------
// Serial over stdin/stdout
// ---------------------------------------------------------------------------
HardwareSerial Serial;

void HardwareSerial::begin(unsigned long, uint32_t, int8_t, int8_t) {
  // Baud rate is meaningless here. The sketch changes it at runtime when the
  // operator picks a CI-V speed; on the PC build CI-V does not exist, so this
  // is deliberately inert rather than an error.
  setvbuf(stdout, nullptr, _IOLBF, 0);
}

void HardwareSerial::end() { fflush(stdout); }
void HardwareSerial::setRxBufferSize(size_t) {}
void HardwareSerial::flush() { fflush(stdout); }

int HardwareSerial::available() {
  if (pending >= 0) return 1;
  if (closed) return 0;

  // Ask the OS whether a read can proceed without blocking. A descriptor at
  // EOF answers "yes" here, so readiness alone is not enough -- the byte has
  // to actually be fetched to tell data from end-of-stream.
#ifdef _WIN32
  if (_isatty(_fileno(stdin)) && !_kbhit()) return 0;
#else
  struct pollfd pfd;
  pfd.fd = STDIN_FILENO;
  pfd.events = POLLIN;
  pfd.revents = 0;
  if (poll(&pfd, 1, 0) <= 0) return 0;
  if (!(pfd.revents & (POLLIN | POLLHUP))) return 0;
#endif

  const int c = fgetc(stdin);
  if (c == EOF) {
    // Latched deliberately: without it the caller's
    // `while (Serial.available() > 0)` never terminates.
    closed = true;
    return 0;
  }

  pending = c;
  return 1;
}

int HardwareSerial::read() {
  if (pending >= 0) {
    int value = pending;
    pending = -1;
    return value;
  }
  if (closed) return -1;

  const int c = fgetc(stdin);
  if (c == EOF) {
    closed = true;
    return -1;
  }
  return c;
}

int HardwareSerial::peek() {
  if (pending < 0) pending = read();
  return pending;
}

size_t HardwareSerial::write(uint8_t c) {
  return fputc(c, stdout) == EOF ? 0 : 1;
}

size_t HardwareSerial::write(const uint8_t *buffer, size_t size) {
  return fwrite(buffer, 1, size, stdout);
}
