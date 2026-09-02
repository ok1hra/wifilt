// local-trx -- impersonates an ICOM LAN radio so an unmodified native wifilt
// build can drive any hamlib-supported TRX. See docs/local-trx-implementace.md.
//
// config.json's "enabled" is OFF by default: until an operator sets it via
// the setup wizard, this process runs ONLY that wizard (no hardware opened,
// no port bound beyond it) -- see the early-exit branch in main() below.
//
//   local-trx [--config-dir PATH] [--bind-ip IP] [-v] [-h]
//
// --bind-ip is accepted for operator documentation/parity with wifilt's own
// --config-dir flag, but the three UDP sockets bind INADDR_ANY (see
// icom_lan_server.cpp) -- what matters is what the operator types into
// wifilt's Setup ICOM-LAN field, which --bind-ip does not change.
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <thread>

#include <WiFi.h>   // nativeSocketsInit() -- WSAStartup on Windows, no-op elsewhere

// <windows.h> AFTER <WiFi.h>, not before: windows.h #defines INADDR_NONE as a
// numeric macro, which mangles native/arduino/IPAddress.h's own
// "extern IPAddress INADDR_NONE;" declaration if that declaration has not
// been parsed yet -- the exact same trap icom_lan_server.cpp's own top
// comment documents for arpa/inet.h on Linux (bod 12), now hit here on
// Windows instead. WiFi.h already pulls in IPAddress.h, so this ordering is
// enough; found live 2026-09-01 cross-building for Windows (Dávka 3).
#ifdef _WIN32
  #include <windows.h>
  #include <shellapi.h>   // ShellExecuteA() (openInBrowser()) -- mingw-w64's
                           // own windows.h, unlike MSVC's, does not pull this
                           // in on its own even without WIN32_LEAN_AND_MEAN;
                           // found cross-building for Windows, see Makefile's
                           // win: target for the matching -lshell32.
#else
  #include <limits.h>
  #include <unistd.h>
  #ifdef __APPLE__
    #include <mach-o/dyld.h>
  #endif
#endif

#include <process_args.h>   // nativeProcessArgvSet()/nativeReexecSelf() -- shared
                            // with wifilt's own ESP.restart(), see its own header

#include "src/audio_bridge.h"
#include "src/config.h"
#include "src/hamlib_bridge.h"
#include "src/icom_lan_server.h"
#include "src/key_runner.h"
#include "src/serial_key.h"
#include "src/trxnet_peer.h"
#include "src/webui_server.h"

namespace {

volatile std::sig_atomic_t g_stop = 0;

void onSignal(int) { g_stop = 1; }

uint8_t parseHexByte(const std::string &s, uint8_t fallback) {
  if (s.empty()) return fallback;
  return (uint8_t)std::strtoul(s.c_str(), nullptr, 16);
}

// Mirrors native/platform/paths.cpp's own private executableDir() (same
// readlink/GetModuleFileNameA/_NSGetExecutablePath technique) rather than
// reusing it directly -- that function is not exported from paths.h, and
// exporting it would mean a diff in native/ just for this, which bod 12
// treats as worth avoiding for a component this small and this unlikely to
// drift. Used only to default --web-root to "next to the binary", the same
// place wifilt's own data/ directory lives relative to its executable.
std::string executableDirectory() {
#ifdef _WIN32
  char buffer[MAX_PATH];
  DWORD length = GetModuleFileNameA(nullptr, buffer, MAX_PATH);
  if (length == 0 || length == MAX_PATH) return ".";
  std::string path(buffer, length);
#elif defined(__APPLE__)
  char buffer[PATH_MAX];
  uint32_t size = sizeof(buffer);
  if (_NSGetExecutablePath(buffer, &size) != 0) return ".";
  std::string path(buffer);
#else
  char buffer[PATH_MAX];
  ssize_t length = readlink("/proc/self/exe", buffer, sizeof(buffer) - 1);
  if (length <= 0) return ".";
  std::string path(buffer, (size_t)length);
#endif
  size_t slash = path.find_last_of("/\\");
  return slash == std::string::npos ? std::string(".") : path.substr(0, slash);
}

// Best-effort, fire-and-forget -- there is no good way to tell "no browser
// installed" apart from "user's machine is headless/CI", and both should
// just leave local-trx running rather than fail the process over a
// convenience feature. `open`/`xdg-open`/ShellExecuteA all hand off to the
// system's own default-browser resolution rather than hard-coding one.
//
// Deliberately NOT std::system() with a concatenated command string: `url`
// is config.wifiltUrl, read straight from config.json / the wizard's
// unauthenticated POST /api/config with no validation, and a shell command
// built by string concatenation lets a value like
// `http://x/"; rm -rf ~; "` break out of the quoting and run arbitrary
// commands the next time this fires (found by code review). fork()+execlp()
// (POSIX) and ShellExecuteA (Windows) both pass `url` as its OWN argument,
// never through a shell's command-line parser, so there is nothing for
// special characters in it to break out of.
void openInBrowser(const std::string &url) {
#ifdef _WIN32
  ShellExecuteA(nullptr, "open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
#else
  // SIG_IGN on SIGCHLD makes the kernel reap this short-lived opener child
  // automatically (POSIX-guaranteed behaviour) -- local-trx never forks
  // anywhere else, so this does not affect any other child-process handling.
  std::signal(SIGCHLD, SIG_IGN);
  pid_t pid = fork();
  if (pid == 0) {
  #ifdef __APPLE__
    execlp("open", "open", url.c_str(), (char *)nullptr);
  #else
    execlp("xdg-open", "xdg-open", url.c_str(), (char *)nullptr);
  #endif
    _exit(127);   // execlp failed -- no opener installed (headless/CI box)
  }
#endif
}

// Called from the main loop, NEVER from inside a WebServer request handler
// itself (see WebUiServer::restartRequested()'s own comment on why) --
// mirrors wifilt's own POST /restart handler's brief delay before
// ESP.restart() (wifilt.ino, webServer.on("/restart", ...)) for the same
// reason: give the OS a moment to actually hand the "saved" response off to
// the browser before this process image goes away. The re-exec itself is
// nativeReexecSelf() (process_args.cpp), the exact mechanism wifilt's own
// ESP.restart() uses -- FD_CLOEXEC-swept execv/CreateProcess, so local-trx's
// own UDP channels/serial ports/miniaudio devices do not leak into the
// fresh image and block its own binds.
[[noreturn]] void restartSelfAfterSave() {
  std::printf("local-trx: config saved, restarting...\n");
  std::fflush(stdout);
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
#ifdef _WIN32
  _putenv_s("LOCAL_TRX_RESTARTED", "1");
#else
  setenv("LOCAL_TRX_RESTARTED", "1", 1);
#endif
  nativeReexecSelf();
  std::fprintf(stderr, "local-trx: re-exec failed, exiting\n");
  std::exit(1);
}

// Shared by both the disabled and enabled branches of main() below -- both
// construct a WebUiServer, call begin(), and (only on success) do the
// openBrowserOnStart dance. What differs between the two call sites --
// hardwareLive, the exact log message printed on success, and whether a
// failed begin() is fatal (the disabled branch has nothing else to run if
// the wizard cannot start) or just "the wizard is unavailable, CAT/audio/
// keying still work" (the enabled branch) -- deliberately stays at each call
// site rather than being folded in here: those are real behavioural
// differences, not incidental duplication. Only the mechanical
// construct+begin()+browser-launch part was actually copy-pasted (found by
// code review).
std::unique_ptr<LocalTrx::WebUiServer> startWizard(uint16_t webPort, const std::string &webRoot,
                                                    const std::string &configDir, bool hardwareLive,
                                                    const LocalTrx::Config &config,
                                                    bool suppressAutoOpen, std::string *error) {
  auto webUi = std::make_unique<LocalTrx::WebUiServer>(webPort, webRoot, configDir, hardwareLive);
  if (!webUi->begin(error)) return nullptr;
  if (config.openBrowserOnStart && !suppressAutoOpen) {
    openInBrowser("http://127.0.0.1:" + std::to_string(webPort) + "/");
    openInBrowser(config.wifiltUrl);
  }
  return webUi;
}

// Fallback KeyLine when no keying.port is configured, or the configured one
// fails to open (no adapter on the desk, wrong name, ...) -- logs every
// key/PTT transition instead of toggling a real line. This is also what
// proved the whole chain (keyer.h, key_runner.h, civ_router.h's
// 0x17/0x14-0x0C, trxnet_peer.h) end to end before serial_key.h existed
// (this dev machine was missing libserialport-dev until 2026-08-31).
class LoggingKeyLine : public LocalTrx::KeyLine {
 public:
  void setKey(bool down) override {
    std::printf("[key] %s\n", down ? "DOWN" : "up");
    std::fflush(stdout);
  }
  void setPtt(bool on) override {
    std::printf("[ptt] %s\n", on ? "ON" : "off");
    std::fflush(stdout);
  }
};

// Fallback RigBackend when config.cat.rigModel/port fails to open (wrong
// port, wrong baud, rig off or unplugged) -- same "never refuse to start"
// rule as LoggingKeyLine above, extended to CAT: found live 2026-09-02, a
// CAT/keying port mixup made rig.open() fail and used to take the ENTIRE
// process down (including the wizard's own web server, main()'s early
// `return 1`), locking the operator out of the one UI that could fix the
// mistake. getMeter()/getAttenuatorOn()/getVoxOn() already have a genuine
// "false = no reply" convention (civ_router.cpp's "no guess" policy), so
// those just say unsupported here too; getFreqHz()/getModeByte()/getRitHz()/
// getGain() have no such signal in RigBackend (civ_router.cpp always sends
// a reply for these, see bcdFromHz/encodeCivLevel/encodeRitLsb3 call sites)
// so they answer with an inert 0 rather than fabricating a plausible-looking
// number.
class NullRigBackend : public LocalTrx::RigBackend {
 public:
  double  getFreqHz() override { return 0.0; }
  bool    setFreqHz(double) override { return false; }
  uint8_t getModeByte() override { return 0; }
  bool    setModeByte(uint8_t) override { return false; }
  int32_t getRitHz() override { return 0; }
  bool    setRitHz(int32_t) override { return false; }
  uint8_t getGain(LocalTrx::GainKind) override { return 0; }
  bool    setGain(LocalTrx::GainKind, uint8_t) override { return false; }
  bool    getMeter(LocalTrx::MeterKind, uint8_t *) override { return false; }
  bool    getAttenuatorOn(bool *) override { return false; }
  bool    getVoxOn(bool *) override { return false; }
};

void printHelp() {
  std::printf(
      "local-trx -- PC-side ICOM-LAN-radio impersonator for native wifilt\n\n"
      "  --config-dir PATH   config.json location (default: %s)\n"
      "  --bind-ip IP        documentation only -- see the note at the top of main.cpp\n"
      "  --web-port PORT     setup-wizard HTTP port (default: 8765, 0 disables it)\n"
      "  --web-root PATH     wizard's static assets (default: webui/ next to the binary)\n"
      "  -v, --verbose       log every handshake/keepalive packet\n"
      "  -h, --help          this text\n",
      LocalTrx::defaultConfigDir().c_str());
}

}  // namespace

int main(int argc, char **argv) {
  nativeProcessArgvSet(argc, argv);   // so a wizard-triggered restart (below) can
                                      // re-exec with the exact args this run started with
  nativeSocketsInit();

  // hamlib defaults to RIG_DEBUG_VERBOSE, which prints ~10-15 trace lines to
  // stdout for EVERY single rig_get_freq()/rig_get_mode() call, and wifilt's
  // own aux poll rotation calls one of those every ~100ms (icomLanClient.h).
  // Found live 2026-08-31 chasing an intermittent "no control packets 6s,
  // link lost" -- that turned out to actually be orphaned leftover
  // local-trx/wifilt processes from earlier failed test runs fighting over
  // the same UDP ports (tools/local-trx-integration-test.sh's own cleanup
  // bug, now fixed; same class of hazard as
  // mercury-orphaned-chrome-tx-incident). This debug flood was not the
  // cause, but it is real unnecessary latency in the same hot path
  // regardless, so it stays fixed. RIG_DEBUG_ERR keeps real hamlib errors
  // visible without the trace spam.
  rig_set_debug(RIG_DEBUG_ERR);

  std::string configDir = LocalTrx::defaultConfigDir();
  std::string webRoot;   // resolved to executableDirectory()+"/webui" below once
                         // argv[0]'s own directory is known -- keep the CLI default
                         // out of printHelp()'s static text, which cannot see it
  uint16_t webPort = 8765;   // bod "Setup/config UI"'s own suggested port
  bool verbose = false;

  for (int i = 1; i < argc; i++) {
    std::string arg = argv[i];
    if (arg == "--config-dir" && i + 1 < argc) {
      configDir = argv[++i];
    } else if (arg == "--bind-ip" && i + 1 < argc) {
      i++;   // accepted, see the file header comment
    } else if (arg == "--web-port" && i + 1 < argc) {
      webPort = (uint16_t)std::strtoul(argv[++i], nullptr, 10);
    } else if (arg == "--web-root" && i + 1 < argc) {
      webRoot = argv[++i];
    } else if (arg == "-v" || arg == "--verbose") {
      verbose = true;
    } else if (arg == "-h" || arg == "--help") {
      printHelp();
      return 0;
    } else {
      std::fprintf(stderr, "unknown argument: %s (try --help)\n", arg.c_str());
      return 1;
    }
  }
  if (webRoot.empty()) webRoot = executableDirectory() + "/webui";

  // Two independent reasons config.openBrowserOnStart's own tab-opening
  // dance (startWizard(), below) should NOT fire despite being turned on:
  // LOCAL_TRX_RESTARTED is set by restartSelfAfterSave() right before its
  // own execv()/CreateProcess, inherited into this exact re-exec'd image's
  // environment, so a wizard-triggered restart never reopens tabs (only a
  // genuinely fresh launch does). LOCAL_TRX_SKIP_AUTO_OPEN is set by
  // native/start-wifilt.sh/.bat, the shared launcher that starts wifilt AND
  // local-trx and opens both tabs ITSELF -- without this, a local-trx
  // config that also has openBrowserOnStart:true would open the wizard tab
  // a second time on top of the launcher's own.
  const bool suppressAutoOpen = std::getenv("LOCAL_TRX_RESTARTED") != nullptr ||
                                 std::getenv("LOCAL_TRX_SKIP_AUTO_OPEN") != nullptr;

  std::string error;
  LocalTrx::Config config = LocalTrx::loadConfig(configDir, &error);
  if (!error.empty()) {
    std::fprintf(stderr, "warning: %s -- continuing with defaults\n", error.c_str());
  }

  // Master switch (config.h), OFF by default: an installed-but-unconfigured
  // local-trx (e.g. shipped alongside a wifilt release rather than fetched
  // deliberately) must not open the ICOM-LAN server, the TrxNet peer, or
  // touch any CAT/keying/audio hardware until an operator has actually
  // walked through the wizard and turned it on. The wizard itself is the one
  // thing that STILL runs here -- it is how "on" gets set in the first
  // place, Save, then a restart brings the rest of this function up for
  // real. Everything from HamlibRigBackend's rig.open() below onward is
  // skipped entirely in this branch, not just left idle: no hardware is
  // opened, no port is bound.
  if (!config.enabled) {
    std::printf("local-trx: disabled in config.json (default) -- running the setup wizard only.\n");
    std::unique_ptr<LocalTrx::WebUiServer> webUi;
    if (webPort != 0) {
      std::string webError;
      webUi = startWizard(webPort, webRoot, configDir, /*hardwareLive=*/false, config, suppressAutoOpen, &webError);
      if (webUi) {
        std::printf("local-trx: setup wizard at http://127.0.0.1:%u/ -- open it, configure, check "
                    "\"Enable\", then Save (this restarts local-trx itself).\n",
                    webPort);
      } else {
        std::fprintf(stderr,
                      "setup wizard unavailable (%s) -- nothing else to do while disabled, exiting.\n",
                      webError.c_str());
        return 1;
      }
    } else {
      std::fprintf(stderr,
                    "local-trx is disabled AND --web-port 0 (wizard off too) -- nothing to do. "
                    "Edit config.json's \"enabled\" by hand, or drop --web-port 0, to get the "
                    "wizard back.\n");
      return 1;
    }
    std::fflush(stdout);

    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);
    while (!g_stop) {
      webUi->poll();
      if (webUi->restartRequested()) restartSelfAfterSave();
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    std::printf("local-trx: shutting down\n");
    return 0;
  }

  LocalTrx::HamlibRigBackend hamlibRig((rig_model_t)config.cat.rigModel, config.cat.port, config.cat.baud);
  NullRigBackend nullRig;
  LocalTrx::RigBackend *rig = &hamlibRig;
  if (!hamlibRig.open(&error)) {
    std::fprintf(stderr,
                 "warning: cannot open rig (model %d, port %s): %s -- CAT reporting inert "
                 "defaults instead (fix cat.port/cat.rigModel in the wizard, still reachable "
                 "below)\n",
                 config.cat.rigModel, config.cat.port.c_str(), error.c_str());
    rig = &nullRig;
  }

  uint8_t civAddr = parseHexByte(config.identity.civAddress, 0xA6);

  // Keying subsystem (bod 7/8/15): one KeyRunner, shared by CW-over-CI-V and
  // FSK-over-TrxNet, since the two are mode-exclusive and share one physical
  // key line. Real DTR/RTS when keying.port is configured and opens; falls
  // back to LoggingKeyLine otherwise (empty port, or the adapter is not
  // actually on the desk) rather than refusing to start -- CAT/keying-text
  // still all work, just without a physical line moving.
  LoggingKeyLine loggingKeyLine;
  LocalTrx::SerialKeyLine serialKeyLine(config.keying.port, config.keying.baud,
                                        config.keying.keyLine, config.keying.pttLine);
  LocalTrx::KeyLine *keyLine = &loggingKeyLine;
  if (!config.keying.port.empty()) {
    std::string keyError;
    if (serialKeyLine.open(&keyError)) {
      keyLine = &serialKeyLine;
      std::printf("local-trx: keying via %s (key=%s, ptt=%s)\n", config.keying.port.c_str(),
                  config.keying.keyLine.c_str(), config.keying.pttLine.c_str());
    } else {
      std::fprintf(stderr, "warning: keying serial port unavailable (%s) -- logging key/PTT instead\n",
                   keyError.c_str());
    }
  }
  LocalTrx::KeyRunner keyer(*keyLine, config.keying.cwWpm);

  // RX audio (bod 2, fáze 2, no PTT interaction): only attempted when
  // explicitly configured -- an empty audio.inputDevice means "not set up
  // yet" the same way an empty keying.port does, not "use whatever the
  // system default capture device happens to be" (which would make every
  // CI/sandbox run silently grab a real microphone if one exists). The
  // literal value "default" is a portable stand-in for "yes, the system
  // default capture device" -- real device names are locale-dependent
  // (PulseAudio reports them translated, e.g. Czech "Vnitřní zvukový
  // systém..." on this dev machine) and unfit for a config value everyone
  // reads the same way.
  std::string audioDeviceName = config.audio.inputDevice == "default" ? "" : config.audio.inputDevice;
  LocalTrx::AudioCapture audioCapture(audioDeviceName);
  LocalTrx::AudioCapture *audioCapturePtr = nullptr;
  if (!config.audio.inputDevice.empty()) {
    std::string audioError;
    if (audioCapture.start(&audioError)) {
      audioCapturePtr = &audioCapture;
      std::printf("local-trx: RX audio capturing from \"%s\"\n",
                  config.audio.inputDevice == "default" ? "(system default)"
                                                          : config.audio.inputDevice.c_str());
    } else {
      std::fprintf(stderr, "warning: RX audio device unavailable (%s) -- no audio will stream\n",
                   audioError.c_str());
    }
  }

  // TX audio (bod: fáze 3, PTT gated separately via CI-V 0x1C, not via audio
  // arrival). Same "" = disabled / "default" = portable sentinel convention
  // as the capture side above.
  std::string playbackDeviceName = config.audio.outputDevice == "default" ? "" : config.audio.outputDevice;
  LocalTrx::AudioPlayback audioPlayback(playbackDeviceName);
  LocalTrx::AudioPlayback *audioPlaybackPtr = nullptr;
  if (!config.audio.outputDevice.empty()) {
    std::string audioError;
    if (audioPlayback.start(&audioError)) {
      audioPlaybackPtr = &audioPlayback;
      std::printf("local-trx: TX audio playing to \"%s\"\n",
                  config.audio.outputDevice == "default" ? "(system default)"
                                                           : config.audio.outputDevice.c_str());
    } else {
      std::fprintf(stderr, "warning: TX audio device unavailable (%s) -- incoming audio dropped\n",
                   audioError.c_str());
    }
  }

  LocalTrx::IcomLanServer server(config.listenIp, config.identity.radioName, civAddr, *rig,
                                  &keyer, audioCapturePtr, audioPlaybackPtr, verbose);
  if (!server.begin(&error)) {
    std::fprintf(stderr, "%s\nhint: ports 50001-50003 may already be in use\n", error.c_str());
    return 1;
  }

  LocalTrx::TrxnetPeer trxnetPeer(config.listenIp, config.keying.fskNetId, keyer);
  if (!trxnetPeer.begin(&error)) {
    std::fprintf(stderr, "trxnet_peer: %s\n", error.c_str());
    return 1;
  }

  // Setup wizard (fáze 6): a genuinely optional subsystem -- unlike the
  // ICOM-LAN server/TrxNet peer above, its failure to start (missing webui/
  // directory, port already in use, or --web-port 0) never stops CAT/audio/
  // keying from working, the same "degrade, do not refuse to start"
  // tolerance the audio/keying wiring above already has.
  std::unique_ptr<LocalTrx::WebUiServer> webUi;
  if (webPort != 0) {
    std::string webError;
    webUi = startWizard(webPort, webRoot, configDir, /*hardwareLive=*/true, config, suppressAutoOpen, &webError);
    if (webUi) {
      std::printf("local-trx: setup wizard at http://127.0.0.1:%u/\n", webPort);
    } else {
      std::fprintf(stderr, "warning: setup wizard unavailable (%s)\n", webError.c_str());
    }
  }

  std::printf("local-trx: radio '%s' civ=0x%02X, rig model %d on '%s', listenIp=%s "
              "(informational -- see --bind-ip)\n",
              config.identity.radioName.c_str(), civAddr, config.cat.rigModel,
              config.cat.port.c_str(), config.listenIp.c_str());
  std::fflush(stdout);

  std::signal(SIGINT, onSignal);
  std::signal(SIGTERM, onSignal);

  bool announced = false;
  while (!g_stop) {
    server.poll();
    trxnetPeer.poll();
    if (webUi) webUi->poll();
    if (webUi && webUi->restartRequested()) restartSelfAfterSave();
    if (!announced && server.connected()) {
      announced = true;
      std::printf("CONNECTED\n");
      std::fflush(stdout);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }

  std::printf("local-trx: shutting down\n");
  return 0;
}
