// EspClass for the native build: the ten ESP.restart() call sites.

#include "Arduino.h"
#include "process_args.h"

#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <windows.h>
  #include <process.h>
  #include <string>
#else
  #include <fcntl.h>
  #include <unistd.h>
#endif

EspClass ESP;

// Defined in wifilt.ino under WIFILT_NATIVE: logs the radio sessions out so the
// IC-705 does not keep serving a ghost session after the re-exec (see the note
// at the definition).
extern void wifiltNativeStopRadioSessions();

#ifdef _WIN32
namespace {

// Command-line quoting per the MSVCRT parsing rules, so a --data-dir with
// spaces survives the round trip through CreateProcess.
void appendQuoted(std::string &commandLine, const char *argument) {
  if (*argument && !strpbrk(argument, " \t\"")) {
    commandLine += argument;
    return;
  }
  commandLine += '"';
  size_t backslashes = 0;
  for (const char *p = argument; *p; ++p) {
    if (*p == '\\') { ++backslashes; continue; }
    if (*p == '"') {
      commandLine.append(backslashes * 2 + 1, '\\');
      backslashes = 0;
      commandLine += '"';
      continue;
    }
    commandLine.append(backslashes, '\\');
    backslashes = 0;
    commandLine += *p;
  }
  commandLine.append(backslashes * 2, '\\');
  commandLine += '"';
}

}  // namespace
#endif

void EspClass::restart() {
  Serial.println("\nWIFILT | restarting...");
  Serial.flush();

  // Say goodbye to the radio first. The re-exec'd process comes back on the
  // same fixed local ports within a second, so without a logout it would adopt
  // the dead session's keepalives and the radio would never expire it.
  wifiltNativeStopRadioSessions();

  // Re-exec ourselves with the original argv so the operator keeps whatever
  // --port / --data-dir / --config-dir they launched with. If that fails there
  // is nothing sane left to do but exit non-zero, which lets a service manager
  // (systemd, Windows service wrapper) do the restart instead.
  char **argv = nativeProcessArgv();
  if (argv && argv[0]) {
#ifdef _WIN32
    // _execv passes inheritable handles into the child, and Winsock sockets
    // are inheritable by default -- the restarted process then finds ports
    // 80/82/83 still held by its own inherited copies, every bind fails, and
    // the setup page waits for a device that never comes back. CreateProcess
    // with bInheritHandles=FALSE hands over nothing.
    std::string commandLine;
    for (int i = 0; argv[i]; ++i) {
      if (i) commandLine += ' ';
      appendQuoted(commandLine, argv[i]);
    }
    STARTUPINFOA startup;
    memset(&startup, 0, sizeof(startup));
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process;
    if (CreateProcessA(nullptr, &commandLine[0], nullptr, nullptr,
                       FALSE /* bInheritHandles */, 0, nullptr, nullptr,
                       &startup, &process)) {
      CloseHandle(process.hProcess);
      CloseHandle(process.hThread);
      exit(0);
    }
    _execv(argv[0], argv);
#else
    // Descriptors survive execv unless marked close-on-exec; the re-exec'd
    // image then finds ports 80/82/83 still bound by its own leaked listeners,
    // logs BIND FAILED and serves nothing, while the setup page waits for a
    // device that never comes back. Sweep every descriptor above stdio rather
    // than each creation site, so the raw audio socket icomLanClient.h opens
    // is covered without touching code shared with the ESP32 build.
    long maxFd = sysconf(_SC_OPEN_MAX);
    if (maxFd <= 0 || maxFd > 4096) maxFd = 4096;
    for (int fd = 3; fd < (int)maxFd; ++fd) {
      int flags = fcntl(fd, F_GETFD, 0);
      if (flags >= 0) fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
    }
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
