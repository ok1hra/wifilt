// EspClass for the native build: the ten ESP.restart() call sites.

#include "Arduino.h"
#include "process_args.h"

#include <stdlib.h>

EspClass ESP;

// Defined in wifilt.ino under WIFILT_NATIVE: logs the radio sessions out so the
// IC-705 does not keep serving a ghost session after the re-exec (see the note
// at the definition).
extern void wifiltNativeStopRadioSessions();

void EspClass::restart() {
  Serial.println("\nWIFILT | restarting...");
  Serial.flush();

  // Say goodbye to the radio first. The re-exec'd process comes back on the
  // same fixed local ports within a second, so without a logout it would adopt
  // the dead session's keepalives and the radio would never expire it.
  wifiltNativeStopRadioSessions();

  // The actual re-exec (argv capture, FD_CLOEXEC sweep, execv/CreateProcess)
  // lives in process_args.cpp -- shared with local-trx's own restart-after-
  // save, which has no radio session of its own to say goodbye to but needs
  // the exact same "come back on the same ports without a leaked fd blocking
  // the fresh bind" guarantee. It never returns true (only false, on
  // failure, or does not return at all) -- called unconditionally rather
  // than through an `if` so every path out of this [[noreturn]] function
  // ends in exit(), which a `bool` return type cannot prove to the compiler
  // on its own.
  nativeReexecSelf();
  Serial.println("WIFILT | re-exec failed, exiting");
  Serial.flush();
  exit(1);
}

// The sketch never calls these today, but ESP.getFreeHeap() is the first thing
// anyone reaches for when diagnosing a leak, so they are answered honestly
// rather than left to fail at link time.
uint32_t EspClass::getFreeHeap() { return 0; }
uint32_t EspClass::getHeapSize() { return 0; }
String   EspClass::getChipModel() { return String("native"); }
