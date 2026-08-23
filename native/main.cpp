// Entry point for the native build.
//
// Everything meaningful lives in wifilt.ino, shared byte-for-byte with the
// ESP32 firmware. This file only does what a bootloader and the Arduino core
// do on the box: prepare the platform, then drive setup() and loop().
//
// Four things here are not optional. Each one was found while porting, and
// without it the binary is either broken or antisocial:
//
//   1. SIGPIPE must be ignored. Writing to a socket the browser just closed
//      otherwise KILLS THE PROCESS -- routine with WebSockets.
//   2. The loop needs pacing. wifilt.ino's loop() contains no delay(), yield()
//      or vTaskDelay() at all; correct on a dedicated MCU, but on a PC it would
//      spin a core at 100 %.
//   3. Windows needs timeBeginPeriod(1). The default 15.6 ms timer granularity
//      would stretch the audio thread's pdMS_TO_TICKS(1) wait to ~15 ms,
//      servicing audio 64x/s instead of 1000x/s.
//   4. A fresh EEPROM image is all 0xFF, and wifilt.ino:4404 reads that as
//      "AP mode". A PC cannot run SoftAP, so the image is seeded first.

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef _WIN32
  #include <execinfo.h> // see onCrash()'s own comment
#endif
#include <unistd.h>

#include <chrono>
#include <string>
#include <thread>

#include "Arduino.h"
#include "EEPROM.h"
#include "ESPmDNS.h"
#include "FS.h"
#include "WebServer.h"
#include "WiFi.h"
#include "paths.h"
#include "radio_transport.h"
#include "process_args.h"
#include "socket_compat.h"

#ifdef _WIN32
  // windows.h already came in via Arduino.h; timeapi.h is where
  // timeBeginPeriod/timeEndPeriod live and it is not part of the lean subset.
  #include <timeapi.h>
#endif

// Defined by the sketch.
extern void setup();
extern void loop();
extern fs::LittleFSFS cfgFS;
extern void wifiltNativeStopRadioSessions();

namespace {

volatile sig_atomic_t g_stopRequested = 0;

void onSignal(int) { g_stopRequested = 1; }

// Permanent diagnostic aid, kept deliberately: no gdb is available in this
// environment (no passwordless sudo to install it), and a real crash was
// once observed with zero output at all -- the process just vanished
// (announceIpViaCw()'s first live call, root-caused to a reentrant
// webServer.handleClient() call in the TEST harness that triggered it, not
// a bug in the function itself -- see [[cw-ip-announce-verified]]).
// backtrace_symbols_fd() is async-signal-safe (unlike printf/Serial), so
// it's safe to call from inside the handler itself; re-raising the default
// handler afterward still lets a real core file get written for deeper
// analysis (see that same memory for how to hand-parse one without gdb).
// Harmless on the normal path -- only fires on an actual fatal signal.
// execinfo.h/backtrace() is glibc-only -- the mingw-w64 Windows cross-build
// has neither it nor SIGBUS, so it just prints the bare crash marker.
void onCrash(int sig) {
  const char msg[] = "\n=== CRASH ===\n";
  write(2, msg, sizeof(msg) - 1);
#ifndef _WIN32
  void *frames[32];
  int n = backtrace(frames, 32);
  backtrace_symbols_fd(frames, n, 2);
#endif
  signal(sig, SIG_DFL);
  raise(sig);
}

void printUsage(const char *program) {
  printf(
      "WIFILT -- native build\n"
      "\n"
      "Usage: %s [options]\n"
      "\n"
#ifdef _WIN32
      "  --port N          HTTP port (default 80)\n"
#else
      "  --port N          HTTP port (default 80; needs root or\n"
      "                    setcap cap_net_bind_service=+ep)\n"
#endif
      "  --data-dir PATH   web assets (default: data/ beside the executable)\n"
      "  --config-dir PATH configuration (default: ~/.config/wifilt or %%APPDATA%%)\n"
      "  --bind-ip ADDR    bind HTTP/DXC-WS/AUD1-WS to this address instead of\n"
      "                    INADDR_ANY (default: all interfaces) -- lets two\n"
      "                    instances for two different radios share one host,\n"
      "                    each on its own loopback alias (127.0.0.11, ...)\n"
      "  --lan-port-base N override the LAN client's own local UDP ports\n"
      "                    (ctrl/civ/audio = N/N+1/N+2, default 50001) --\n"
      "                    needed alongside --bind-ip: two instances for two\n"
      "                    different radios would otherwise both bind local\n"
      "                    port 50001 and silently steal each other's\n"
      "                    control/audio packets\n"
      "  --help            this text\n"
      "\n"
      "The operator's QSO log lives in the browser and is scoped to the origin,\n"
      "so reaching this binary at the same address the box used is what keeps\n"
      "that log. Moving off port 80 changes the origin.\n",
      program);
}

// A fresh install has no EEPROM image, so every byte reads 0xFF -- which
// wifilt.ino:4404 interprets as "start in AP mode". On the box that is right:
// an unprovisioned device should raise its own access point. A PC has no
// SoftAP, so it would strand the operator in a captive portal that cannot
// exist. Seeding byte 0 to station mode is the equivalent of shipping a
// pre-provisioned device.
void seedFreshConfig() {
  if (!EEPROM.begin(360)) return;
  if (EEPROM.read(0) != 0xFF) return;

  printf("WIFILT | first run, seeding configuration in %s\n",
         nativeConfigDir().c_str());
  EEPROM.write(0, 0x00);
  EEPROM.commit();
}

bool parseArguments(int argc, char **argv, uint16_t *port) {
  for (int i = 1; i < argc; i++) {
    const std::string flag = argv[i];
    const bool hasValue = (i + 1) < argc;

    if (flag == "--help" || flag == "-h") {
      printUsage(argv[0]);
      return false;
    }
    if (flag == "--port" && hasValue) {
      *port = (uint16_t)atoi(argv[++i]);
    } else if (flag == "--data-dir" && hasValue) {
      nativeSetDataDir(argv[++i]);
    } else if (flag == "--config-dir" && hasValue) {
      nativeSetConfigDir(argv[++i]);
    } else if (flag == "--bind-ip" && hasValue) {
      nativeSetBindAddress(argv[++i]);
    } else if (flag == "--lan-port-base" && hasValue) {
      g_lanLocalPortBaseOverride = (uint16_t)atoi(argv[++i]);
    } else {
      fprintf(stderr, "WIFILT | unknown option: %s\n", flag.c_str());
      printUsage(argv[0]);
      return false;
    }
  }
  return true;
}

}  // namespace

int main(int argc, char **argv) {
  nativeProcessArgvSet(argc, argv);

  uint16_t port = 0;
  if (!parseArguments(argc, argv, &port)) return 1;

  // (1) Without this, one closed browser tab can take the whole daemon down.
#ifndef _WIN32
  signal(SIGPIPE, SIG_IGN);
#endif
  signal(SIGINT, onSignal);
  signal(SIGTERM, onSignal);
  signal(SIGSEGV, onCrash);
  signal(SIGABRT, onCrash);
#ifndef _WIN32
  signal(SIGBUS, onCrash);
#endif

  // (3) Raise the timer resolution so 1 ms waits really are about 1 ms.
#ifdef _WIN32
  timeBeginPeriod(1);
#endif

  if (!nativeSocketsInit()) {
    fprintf(stderr, "WIFILT | socket layer failed to start\n");
    return 1;
  }

  if (!nativeEnsureDir(nativeConfigDir())) {
    fprintf(stderr, "WIFILT | cannot create config directory: %s\n",
            nativeConfigDir().c_str());
    return 1;
  }

  // The box's two partitions become two directories. cfgFS is separate from the
  // assets for the same reason it is a separate partition there: reinstalling
  // must never touch calibrations.
  LittleFS.nativeSetRoot(nativeDataDir());
  cfgFS.nativeSetRoot(nativeConfigDir());

  if (port) nativeSetHttpPort(port);

  printf("WIFILT | assets  %s\n", nativeDataDir().c_str());
  printf("WIFILT | config  %s\n", nativeConfigDir().c_str());

  seedFreshConfig();   // (4)

  setup();

  // (2) Pace the loop. A pass that finished in under a millisecond sleeps the
  // remainder, which still leaves roughly a thousand passes a second -- far
  // more than the ESP32 manages -- without pinning a core.
  const auto minimumPass = std::chrono::milliseconds(1);
  while (!g_stopRequested) {
    const auto started = std::chrono::steady_clock::now();
    loop();
    const auto elapsed = std::chrono::steady_clock::now() - started;
    if (elapsed < minimumPass) std::this_thread::sleep_for(minimumPass - elapsed);
  }

  printf("\nWIFILT | shutting down\n");
  // Log the radio sessions out. Ctrl+C followed by a quick manual start hits
  // the same ghost-session wedge as a restart: the new process rebinds the
  // fixed ports and keeps the dead session alive by answering its pings.
  wifiltNativeStopRadioSessions();
  // Join the responder thread. A global std::thread left joinable calls
  // std::terminate() from its destructor at exit, which printed
  // "terminate called without an active exception" after every Ctrl+C.
  MDNS.end();
  EEPROM.end();

#ifdef _WIN32
  timeEndPeriod(1);
#endif
  nativeSocketsShutdown();
  return 0;
}
