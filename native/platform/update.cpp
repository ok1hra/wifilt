#include "update.h"

#include "paths.h"
#include "process_args.h"

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#include <fstream>
#include <sstream>
#include <vector>

#ifndef _WIN32
  #include <unistd.h>
#endif

// native/net/WiFi.cpp: the port a listener really got (80, or 8080 when it
// could not bind 80) -- handed to the Windows updater for its health check.
uint16_t nativeActualPort(uint16_t requested);

namespace {

// The environment overrides exist for testing the page without root (the
// updater script honours the same WIFILT_UPDATE_STATE); the units never set them.
#ifndef _WIN32
const char *envOr(const char *name, const char *fallback) {
  const char *v = getenv(name);
  return v && *v ? v : fallback;
}
#endif
#define kConf     envOr("WIFILT_UPDATE_CONF", "/etc/wifilt-update.conf")
#ifdef _WIN32
// Windows: no root updater and no request directory; wifilt starts the
// PowerShell updater itself and both keep their files in the config dir.
std::string winStateDir() { return nativeJoinPath(nativeConfigDir(), "/update"); }
#define kStateDir winStateDir()
#else
#define kStateDir envOr("WIFILT_UPDATE_STATE", "/var/lib/wifilt-update")
#endif

std::string readFile(const std::string &path, size_t limit = 65536) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return "";
  std::string out;
  out.resize(limit);
  in.read(&out[0], (std::streamsize)limit);
  out.resize((size_t)in.gcount());
  return out;
}

bool fileExists(const std::string &path) {
  struct stat st;
  return stat(path.c_str(), &st) == 0;
}

std::string trim(const std::string &s) {
  size_t a = s.find_first_not_of(" \t\r\n");
  if (a == std::string::npos) return "";
  size_t b = s.find_last_not_of(" \t\r\n");
  return s.substr(a, b - a + 1);
}

#ifndef _WIN32
const char *kPiConf = "/etc/wifilt-pi/setup.conf";

// PREFIX=... from /etc/wifilt-update.conf (written by install.sh with %q,
// which leaves an ordinary path as it is).
std::string confPrefix() {
  std::istringstream in(readFile(kConf, 4096));
  std::string line;
  while (std::getline(in, line)) {
    if (line.compare(0, 7, "PREFIX=") == 0) return trim(line.substr(7));
  }
  return "";
}

std::string reqDir() { return std::string(kStateDir) + "/req"; }
#endif

bool rootIsOverlay() {
#ifdef _WIN32
  return false;
#else
  std::istringstream in(readFile("/proc/mounts", 1 << 16));
  std::string dev, mnt, type;
  std::string line;
  while (std::getline(in, line)) {
    std::istringstream ls(line);
    if (ls >> dev >> mnt >> type && mnt == "/") {
      if (type == "overlay") return true;
    }
  }
  return false;
#endif
}

// A trivially JSON-ish check that a file the root updater wrote is an object,
// so a half-written or empty file never reaches the page as broken JSON.
bool looksLikeObject(const std::string &s) {
  std::string t = trim(s);
  return t.size() >= 2 && t.front() == '{' && t.back() == '}';
}

// Atomic: the path unit fires on the rename, never on a half-written file.
std::string writeAtomic(const std::string &path, const std::string &body) {
  std::string tmp = path + ".tmp";
  {
    std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
    if (!out) return "cannot write " + tmp;
    out << body;
    if (!out) return "cannot write " + tmp;
  }
#ifdef _WIN32
  remove(path.c_str());  // Windows rename() does not replace an existing file
#endif
  if (rename(tmp.c_str(), path.c_str()) != 0) {
    remove(tmp.c_str());
    return "cannot rename " + tmp;
  }
  return "";
}

// The state word and timestamp of status.json, for the double-start guard.
void statusStateTs(std::string *state, long *ts) {
  std::string s = readFile(std::string(kStateDir) + "/status.json");
  *state = ""; *ts = 0;
  size_t k = s.find("\"state\":\"");
  if (k != std::string::npos) {
    size_t a = k + 9, b = s.find('"', a);
    if (b != std::string::npos && b - a < 16) *state = s.substr(a, b - a);
  }
  size_t t = s.find("\"ts\":");
  if (t != std::string::npos) *ts = atol(s.c_str() + t + 5);
}

std::string makeId() {
  static unsigned counter = 0;
  char buf[24];
  snprintf(buf, sizeof(buf), "%lx%x", (unsigned long)time(nullptr), ++counter & 0xfff);
  return buf;
}

}  // namespace

const char *nativeUpdateMode() {
#ifdef _WIN32
  // The zip is unpacked by hand anywhere; the updater replaces files next to
  // wifilt.exe, so that folder must hold the script and be writable (not, for
  // example, Program Files without admin rights).
  std::string dir = nativeExecutableDir();
  if (!fileExists(dir + "\\wifilt-update.ps1")) return "manual";
  std::string probe = dir + "\\.wifilt-write-probe";
  FILE *f = fopen(probe.c_str(), "wb");
  if (!f) return "manual";
  fclose(f);
  remove(probe.c_str());
  return "windows";
#else
  if (!fileExists(kConf)) return "manual";
  std::string prefix = confPrefix();
  // The updater replaces what install.sh put in PREFIX. A wifilt started from
  // somewhere else (an unpacked archive, a checkout) would not be the one that
  // gets updated, so it must not offer to.
  if (prefix.empty() || nativeExecutableDir() != prefix) return "manual";
  if (access(reqDir().c_str(), W_OK) != 0) return "manual";
  // Started by hand (start-wifilt.sh) rather than by wifilt.service: the
  // updater stops and starts the service, so this process would keep running
  // the old binary. systemd sets INVOCATION_ID for every service it starts.
  if (!getenv("INVOCATION_ID") && !getenv("WIFILT_UPDATE_CONF")) return "manual";
  if (fileExists(kPiConf)) return rootIsOverlay() ? "pi-locked" : "pi";
  return "systemd";
#endif
}

std::string nativeUpdateStatusJson() {
  std::string s = readFile(std::string(kStateDir) + "/status.json");
  if (!looksLikeObject(s)) return "{\"state\":\"idle\"}";
  s = trim(s);
  // Locked Pi: the updater's last word before "fslock lock" reboots the machine
  // is phase "relock", state "offline". Back up and locked again, that run is
  // over -- finished, or failed with the old version restored (error set).
  if (s.find("\"phase\":\"relock\"") != std::string::npos && rootIsOverlay()) {
    const std::string from = "\"state\":\"offline\"";
    size_t k = s.find(from);
    if (k != std::string::npos) {
      bool failed = s.find("\"error\":\"\"") == std::string::npos;
      s.replace(k, from.size(), failed ? "\"state\":\"failed\"" : "\"state\":\"done\"");
    }
  }
  return s;
}

std::string nativeUpdateInfoJson() {
  std::string out = "{\"mode\":\"";
  out += nativeUpdateMode();
  out += "\",\"locked\":";
  out += rootIsOverlay() ? "true" : "false";
  out += ",\"check\":";
  std::string check = readFile(std::string(kStateDir) + "/check.json", 4096);
  out += looksLikeObject(check) ? trim(check) : "null";
  // Only the state word of the status, so the topbar can say "updating"
  // without pulling the whole log every few minutes.
  std::string status = nativeUpdateStatusJson();
  std::string state = "idle";
  size_t k = status.find("\"state\":\"");
  if (k != std::string::npos) {
    size_t a = k + 9, b = status.find('"', a);
    if (b != std::string::npos && b - a < 16) state = status.substr(a, b - a);
  }
  int pct = 0;
  size_t p = status.find("\"pct\":");
  if (p != std::string::npos) pct = atoi(status.c_str() + p + 6);
  out += ",\"state\":\"" + state + "\",\"pct\":" + std::to_string(pct) + "}";
  return out;
}

bool nativeRootIsOverlay() { return rootIsOverlay(); }

bool nativePiLockable() {
#ifdef _WIN32
  return false;
#else
  // pi-setup installs the fslock command only when the operator chose the
  // power-loss protection (native/pi/lib/fslock.sh).
  return fileExists(kPiConf) && access("/usr/local/sbin/fslock", X_OK) == 0;
#endif
}

bool nativeUpdaterBusy(int *pct) {
  std::string status = nativeUpdateStatusJson();
  bool busy = status.find("\"state\":\"running\"") != std::string::npos ||
              status.find("\"state\":\"offline\"") != std::string::npos;
  if (!busy) return false;
  // A run that died without writing its last word must not report "updating"
  // for ever: the updater rewrites the file at least once a second while it
  // works, and a locked Pi's reboots take a few minutes.
  size_t t = status.find("\"ts\":");
  if (t != std::string::npos) {
    long long ts = atoll(status.c_str() + t + 5);
    long long now = (long long)time(nullptr);
    if (ts > 0 && now - ts > 600) return false;
  }
  if (pct) {
    size_t p = status.find("\"pct\":");
    *pct = p != std::string::npos ? atoi(status.c_str() + p + 6) : 0;
    if (*pct < 0) *pct = 0;
    if (*pct > 100) *pct = 100;
  }
  return true;
}

std::string nativeUpdateRequest(const char *action, bool dry, std::string *idOut) {
  if (strcmp(nativeUpdateMode(), "manual") == 0) return "this installation cannot update itself";
  if (strcmp(action, "check") != 0 && strcmp(action, "update") != 0) return "unknown action";
  // One update at a time. A second request would otherwise wait in the
  // directory and start the moment the first run ends, overwriting its result.
  // Stale states (an updater killed mid-way) stop blocking after a while; a
  // locked Pi spends minutes in reboots, hence the long "offline" allowance.
  std::string state; long ts = 0;
  statusStateTs(&state, &ts);
  long age = (long)time(nullptr) - ts;
  if ((state == "running" && age < 300) || (state == "offline" && age < 1200))
    return "an update is already running";
  std::string id = makeId();
  if (idOut) *idOut = id;
#ifdef _WIN32
  nativeEnsureDir(kStateDir);
  // How wifilt was started, for the script to start it the same way again.
  {
    std::string args;
    char **argv = nativeProcessArgv();
    for (int i = 1; argv && argv[i]; ++i) { args += argv[i]; args += "\n"; }
    writeAtomic(kStateDir + "\\restart-args.txt", args);
  }
  std::string script = nativeExecutableDir() + "\\wifilt-update.ps1";
  std::string port = std::to_string(nativeActualPort(80));
  std::string exeDir = nativeExecutableDir();
  std::string stateDir = kStateDir;
  std::vector<const char *> argv = {
    "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden", "-File", script.c_str(),
    "-Action", action, "-ExeDir", exeDir.c_str(), "-StateDir", stateDir.c_str(),
    "-Port", port.c_str(), "-Id", id.c_str() };
  if (dry) argv.push_back("-Dry");
  argv.push_back(nullptr);
  if (!nativeSpawnDetached(argv.data())) return "cannot start PowerShell";
  return "";
#else
  std::string req = reqDir() + "/request.json";
  // A request still waiting means the updater has not picked the last one up.
  if (fileExists(req)) return "a request is already pending";
  std::string body = std::string("{\"action\":\"") + action + "\",\"id\":\"" + id +
                     "\",\"dry\":" + (dry ? "1" : "0") + "}\n";
  return writeAtomic(req, body);
#endif
}

std::string nativeUpdateCancel() {
  if (strcmp(nativeUpdateMode(), "manual") == 0) return "this installation cannot update itself";
#ifdef _WIN32
  return writeAtomic(kStateDir + "\\cancel", "1\n");
#else
  return writeAtomic(reqDir() + "/cancel", "1\n");
#endif
}

std::string nativeUpdateSaveToken(const std::string &token) {
  std::string t = trim(token);
  if (t.size() > 256) return "token too long";
  for (char c : t) {
    if (!(isalnum((unsigned char)c) || c == '_' || c == '-' || c == '.')) return "token has invalid characters";
  }
  std::string path = nativeJoinPath(nativeConfigDir(), "/update-token");
  if (t.empty()) { remove(path.c_str()); return ""; }
#ifndef _WIN32
  mode_t old = umask(077);
#endif
  std::string err = writeAtomic(path, t + "\n");
#ifndef _WIN32
  umask(old);
  chmod(path.c_str(), 0600);
#endif
  return err;
}
