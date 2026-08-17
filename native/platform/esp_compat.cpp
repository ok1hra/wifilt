// EspClass for the native build: the ten ESP.restart() call sites.

#include "Arduino.h"
#include "process_args.h"

#include <stdlib.h>

#ifdef _WIN32
  #include <process.h>
#else
  #include <unistd.h>
#endif

EspClass ESP;

void EspClass::restart() {
  Serial.println("\nWIFILT | restarting...");
  Serial.flush();

  // Re-exec ourselves with the original argv so the operator keeps whatever
  // --bind / --data-dir / --config-dir they launched with. If exec fails there
  // is nothing sane left to do but exit non-zero, which lets a service manager
  // (systemd, Windows service wrapper) do the restart instead.
  char **argv = nativeProcessArgv();
  if (argv && argv[0]) {
#ifdef _WIN32
    _execv(argv[0], argv);
#else
    execv(argv[0], argv);
#endif
  }

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
