#include "vpn.h"

#include <stdio.h>

#if defined(__linux__)

#include "paths.h"
#include "update.h"     // nativeRootIsOverlay()
#include "vpn_code.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <fstream>
#include <mutex>
#include <sstream>
#include <thread>
#include <vector>

const char *nativeHostLabel();   // native/net/WiFi.cpp

namespace {

// The environment overrides exist for tests without root (tools/vpn-*-check.sh);
// the units never set them. The helper honours the same WIFILT_VPN_* names.
const char *envOr(const char *name, const char *fallback) {
  const char *v = getenv(name);
  return v && *v ? v : fallback;
}
#define kConf     envOr("WIFILT_VPN_CONF", "/etc/wifilt-vpn.conf")
#define kStateDir envOr("WIFILT_VPN_STATE", "/var/lib/wifilt-vpn")
#define kEdge     envOr("WIFILT_VPN_EDGE", "/usr/local/sbin/edge")
const char *kTap = "wlvpn0";
const char *kDefaultSupernode = "remoteqth.com:82";

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

bool looksLikeObject(const std::string &s) {
  std::string t = trim(s);
  return t.size() >= 2 && t.front() == '{' && t.back() == '}';
}

// Our own flat files and n2n's management rows: string values never carry an
// escape we need, so a value with a backslash is simply not accepted.
std::string jsonString(const std::string &json, const char *key) {
  std::string pat = std::string("\"") + key + "\"";
  size_t k = json.find(pat);
  if (k == std::string::npos) return "";
  size_t c = json.find_first_not_of(" \t\r\n", k + pat.size());
  if (c == std::string::npos || json[c] != ':') return "";
  size_t q = json.find_first_not_of(" \t\r\n", c + 1);
  if (q == std::string::npos || json[q] != '"') return "";
  size_t e = json.find('"', q + 1);
  if (e == std::string::npos) return "";
  std::string v = json.substr(q + 1, e - q - 1);
  return v.find('\\') == std::string::npos ? v : "";
}

// The raw token after "key": -- true/false/number.
std::string jsonToken(const std::string &json, const char *key) {
  std::string pat = std::string("\"") + key + "\"";
  size_t k = json.find(pat);
  if (k == std::string::npos) return "";
  size_t c = json.find_first_not_of(" \t\r\n", k + pat.size());
  if (c == std::string::npos || json[c] != ':') return "";
  size_t a = json.find_first_not_of(" \t\r\n", c + 1);
  if (a == std::string::npos) return "";
  size_t b = json.find_first_of(",}\r\n \t", a);
  return json.substr(a, b == std::string::npos ? std::string::npos : b - a);
}

bool jsonBool(const std::string &json, const char *key, bool fallback) {
  std::string t = jsonToken(json, key);
  if (t == "true") return true;
  if (t == "false") return false;
  return fallback;
}

long long jsonLong(const std::string &json, const char *key, long long fallback) {
  std::string t = jsonToken(json, key);
  if (t.empty() || !(isdigit((unsigned char)t[0]) || t[0] == '-')) return fallback;
  return atoll(t.c_str());
}

// Text from n2n (another client's description) on its way into our JSON.
std::string jsonSafe(const std::string &s) {
  std::string out;
  for (char c : s) out += (c == '"' || c == '\\' || (unsigned char)c < 0x20) ? '?' : c;
  return out;
}

// ---- settings --------------------------------------------------------------

struct Config {
  bool enabled = false;
  std::string code, community, key, desc, supernode;
};

std::string configPath() { return nativeJoinPath(nativeConfigDir(), "/vpn.json"); }
std::string prevPath() { return nativeJoinPath(nativeConfigDir(), "/vpn.prev.json"); }

// Never trusts the file: community and key always come from the code again,
// so a hand-edited or restored file cannot point the edge anywhere else.
Config loadConfig() {
  Config c;
  std::string s = readFile(configPath(), 4096);
  c.enabled = jsonBool(s, "enabled", false);
  c.desc = jsonString(s, "desc");
  c.supernode = jsonString(s, "supernode");
  if (!vpncode::validSupernode(c.supernode)) c.supernode = kDefaultSupernode;
  if (!vpncode::validDescription(c.desc)) c.desc.clear();
  std::string canon = vpncode::normalize(jsonString(s, "code"));
  if (canon.empty()) {
    c.enabled = false;
  } else {
    c.code = vpncode::format(canon);
    c.community = vpncode::community(canon);
    c.key = vpncode::key(canon);
  }
  return c;
}

// One line, so the root helper can read it with sed.
std::string serialize(const Config &c) {
  return std::string("{\"enabled\":") + (c.enabled ? "true" : "false") +
         ",\"code\":\"" + c.code + "\",\"community\":\"" + c.community +
         "\",\"key\":\"" + c.key + "\",\"desc\":\"" + c.desc +
         "\",\"supernode\":\"" + c.supernode + "\"}\n";
}

std::string writeAtomic(const std::string &path, const std::string &body, bool secret) {
  std::string tmp = path + ".tmp";
  mode_t old = umask(secret ? 077 : 022);
  bool ok;
  {
    std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
    ok = (bool)out;
    if (ok) { out << body; ok = (bool)out; }
  }
  umask(old);
  if (!ok) { remove(tmp.c_str()); return "cannot write " + tmp; }
  if (secret) chmod(tmp.c_str(), 0600);
  if (rename(tmp.c_str(), path.c_str()) != 0) {
    remove(tmp.c_str());
    return "cannot rename " + tmp;
  }
  return "";
}

// The previous settings stay beside the new ones: the helper puts them back
// when a change made from inside the VPN cuts the requester off.
std::string saveConfig(const Config &c) {
  if (!nativeEnsureDir(nativeConfigDir())) return "cannot create " + nativeConfigDir();
  std::string old = readFile(configPath(), 4096);
  if (!old.empty()) writeAtomic(prevPath(), old, true);
  return writeAtomic(configPath(), serialize(c), true);
}

// ---- the helper's side -------------------------------------------------------

// KEY=value from /etc/wifilt-vpn.conf (install.sh writes it with %q, which
// leaves an ordinary path as it is).
std::string confValue(const char *key) {
  std::istringstream in(readFile(kConf, 4096));
  std::string line, pat = std::string(key) + "=";
  while (std::getline(in, line)) {
    if (line.compare(0, pat.size(), pat) == 0) return trim(line.substr(pat.size()));
  }
  return "";
}

std::string reqDir() { return std::string(kStateDir) + "/req"; }

std::string realPath(const std::string &p) {
  char buf[4096];
  return realpath(p.c_str(), buf) ? std::string(buf) : p;
}

std::string makeId() {
  static unsigned counter = 0;
  char buf[24];
  snprintf(buf, sizeof(buf), "%lx%x", (unsigned long)time(nullptr), ++counter & 0xfff);
  return buf;
}

std::string ipString(uint32_t networkOrder) {
  char buf[INET_ADDRSTRLEN] = "";
  struct in_addr a;
  a.s_addr = networkOrder;
  inet_ntop(AF_INET, &a, buf, sizeof(buf));
  return buf;
}

// Hand an action to the root helper. "apply" with nothing to apply it with (no
// units) is not an error: the settings are saved and wait for install.sh.
std::string requestHelper(const char *action, uint32_t watchIp) {
  std::string why;
  if (strcmp(nativeVpnMode(&why), "manual") == 0) {
    return strcmp(action, "apply") == 0 ? "" : why;
  }
  std::string body = std::string("{\"action\":\"") + action + "\",\"id\":\"" + makeId() +
                     "\",\"watch\":\"" + (watchIp ? ipString(watchIp) : "") + "\"}\n";
  return writeAtomic(reqDir() + "/apply.json", body, false);
}

// ---- wlvpn0 ------------------------------------------------------------------

bool tapAddress(uint32_t *addr, uint32_t *mask) {
  struct ifaddrs *list = nullptr;
  if (getifaddrs(&list) != 0) return false;
  bool found = false;
  for (struct ifaddrs *e = list; e; e = e->ifa_next) {
    if (!e->ifa_addr || e->ifa_addr->sa_family != AF_INET || !e->ifa_netmask) continue;
    if (strcmp(e->ifa_name, kTap) != 0) continue;
    *addr = ((struct sockaddr_in *)e->ifa_addr)->sin_addr.s_addr;
    *mask = ((struct sockaddr_in *)e->ifa_netmask)->sin_addr.s_addr;
    found = true;
    break;
  }
  freeifaddrs(list);
  return found;
}

// ---- the edge's management port, read in the background ---------------------

struct Peer {
  std::string desc, ip, mode;
  long long age = -1;
};

struct Snapshot {
  bool answered = false;      // the edge replied at all
  bool snCurrent = false;     // it has a current supernode
  long long snAge = -1;       // seconds since the supernode last answered it
  std::string snAddr;
  std::vector<Peer> peers;
  time_t at = 0;
};

std::mutex g_snapLock;
Snapshot g_snap;
std::atomic<bool> g_threadStarted{false};

int mgmtPort() { return atoi(envOr("WIFILT_VPN_MGMT_PORT", "5644")); }

// One "r <tag> <cmd>" round trip: the row objects, one per datagram (edge
// terminates each with \0, the supernode with \n), up to the "end" marker.
std::vector<std::string> mgmtQuery(const char *cmd, bool *answered) {
  std::vector<std::string> rows;
  *answered = false;
  int s = socket(AF_INET, SOCK_DGRAM, 0);
  if (s < 0) return rows;
  struct timeval tv = {0, 400 * 1000};
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  struct sockaddr_in to;
  memset(&to, 0, sizeof(to));
  to.sin_family = AF_INET;
  to.sin_port = htons((uint16_t)mgmtPort());
  to.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  static unsigned counter = 0;
  char tag[8], req[48];
  snprintf(tag, sizeof(tag), "%u", ++counter % 1000);
  snprintf(req, sizeof(req), "r %s %s", tag, cmd);
  if (sendto(s, req, strlen(req), 0, (struct sockaddr *)&to, sizeof(to)) < 0) {
    close(s);
    return rows;
  }
  const std::string tagField = std::string("\"_tag\":\"") + tag + "\"";
  for (int i = 0; i < 256; ++i) {
    char buf[4096];
    ssize_t n = recv(s, buf, sizeof(buf), 0);
    if (n <= 0) break;
    *answered = true;
    std::string d(buf, (size_t)n);
    while (!d.empty() && (d.back() == '\0' || d.back() == '\n')) d.pop_back();
    if (d.find(tagField) == std::string::npos) continue;   // a late reply to an older query
    std::string type = jsonString(d, "_type");
    if (type == "row") rows.push_back(d);
    else if (type == "end" || type == "error") break;
  }
  close(s);
  return rows;
}

// A peer the edge knows only from its P2P registration has no address in the
// management row yet (seen against remoteqth.com:82); the kernel's ARP table
// for wlvpn0 usually has it by its MAC.
std::string arpAddress(const std::string &mac) {
  if (mac.empty()) return "";
  std::istringstream in(readFile("/proc/net/arp", 1 << 16));
  std::string line, ip, type, flags, hw, mask, dev;
  std::getline(in, line);   // header
  while (std::getline(in, line)) {
    std::istringstream ls(line);
    if (!(ls >> ip >> type >> flags >> hw >> mask >> dev)) continue;
    if (dev != kTap || flags == "0x0") continue;
    if (strcasecmp(hw.c_str(), mac.c_str()) == 0) return ip;
  }
  return "";
}

void refreshSnapshot() {
  Config c = loadConfig();
  Snapshot snap;
  snap.at = time(nullptr);
  if (c.enabled) {
    bool a1 = false, a2 = false;
    std::vector<std::string> sn = mgmtQuery("supernodes", &a1);
    std::vector<std::string> ed = mgmtQuery("edges", &a2);
    long long now = (long long)time(nullptr);
    snap.answered = a1 || a2;
    for (const std::string &row : sn) {
      if (jsonLong(row, "current", 0) != 1) continue;
      snap.snCurrent = true;
      long long seen = jsonLong(row, "last_seen", 0);
      snap.snAge = seen > 0 ? now - seen : -1;
      snap.snAddr = jsonSafe(jsonString(row, "sockaddr"));
    }
    for (const std::string &row : ed) {
      Peer p;
      p.desc = jsonSafe(jsonString(row, "desc"));
      p.ip = jsonSafe(jsonString(row, "ip4addr"));
      if (p.ip.empty()) p.ip = jsonSafe(arpAddress(jsonString(row, "macaddr")));
      p.mode = jsonString(row, "mode") == "p2p" ? "p2p" : "relay";
      long long seen = jsonLong(row, "last_seen", 0);
      p.age = seen > 0 ? now - seen : -1;
      snap.peers.push_back(p);
    }
  }
  std::lock_guard<std::mutex> guard(g_snapLock);
  g_snap = snap;
}

// Started by the first status request; two UDP datagrams to localhost every
// few seconds while the VPN is switched on, nothing otherwise.
void ensureThread() {
  bool expected = false;
  if (!g_threadStarted.compare_exchange_strong(expected, true)) return;
  std::thread([] {
    for (;;) {
      refreshSnapshot();
      std::this_thread::sleep_for(std::chrono::seconds(3));
    }
  }).detach();
}

// The station callsign from the EEPROM image (203..218, wifilt.ino's map), for
// the CLI, which runs without the sketch.
std::string eepromCallsign() {
  std::string img = readFile(nativeJoinPath(nativeConfigDir(), "/eeprom.bin"), 256);
  std::string call;
  for (size_t i = 203; i < 219 && i < img.size(); ++i) {
    unsigned char c = (unsigned char)img[i];
    if (c == 0 || c == 0xFF) break;
    call += (char)c;
  }
  return call;
}

std::string upper(const std::string &s) {
  std::string out;
  for (char c : s) out += (char)toupper((unsigned char)c);
  return out;
}

}  // namespace

// ---- public ------------------------------------------------------------------

const char *nativeVpnMode(std::string *reason) {
  std::string dummy;
  std::string &why = reason ? *reason : dummy;
  why.clear();
  if (!fileExists(kConf)) {
    why = "the VPN service is not installed -- install wifilt with sudo ./install.sh";
    return "manual";
  }
  std::string confDir = confValue("CONF_DIR");
  if (!confDir.empty() && realPath(confDir) != realPath(nativeConfigDir())) {
    why = "this wifilt keeps its settings in " + nativeConfigDir() +
          ", the VPN service reads " + confDir;
    return "manual";
  }
  if (access(reqDir().c_str(), W_OK) != 0) {
    why = "cannot write " + reqDir() + " -- is wifilt running as the user install.sh was run for?";
    return "manual";
  }
  if (access(kEdge, X_OK) != 0) {
    why = std::string(kEdge) + " is missing -- n2n 3.1.1 is not installed yet";
    return "no-n2n";
  }
  return "ok";
}

const char *nativeVpnConfigFile() { return "/vpn.json"; }

void nativeVpnStart() { ensureThread(); }

bool nativeVpnClientIsVpn(uint32_t clientIp) {
  uint32_t addr = 0, mask = 0;
  if (!clientIp || !tapAddress(&addr, &mask) || !addr) return false;
  return (clientIp & mask) == (addr & mask);
}

std::string nativeVpnStatusJson(uint32_t clientIp) {
  ensureThread();
  std::string reason;
  const char *mode = nativeVpnMode(&reason);
  Config c = loadConfig();
  Snapshot snap;
  {
    std::lock_guard<std::mutex> guard(g_snapLock);
    snap = g_snap;
  }
  uint32_t addr = 0, mask = 0;
  bool tap = tapAddress(&addr, &mask);
  int bits = 0;
  for (uint32_t m = ntohl(mask); m & 0x80000000u; m <<= 1) ++bits;

  std::string out = "{\"mode\":\"";
  out += mode;
  out += "\",\"reason\":\"" + jsonSafe(reason) + "\"";
  out += ",\"locked\":";
  out += nativeRootIsOverlay() ? "true" : "false";
  out += ",\"paired\":";
  out += c.code.empty() ? "false" : "true";
  out += ",\"enabled\":";
  out += c.enabled ? "true" : "false";
  out += ",\"desc\":\"" + c.desc + "\",\"supernode\":\"" + c.supernode + "\"";
  out += ",\"community\":\"" + c.community + "\"";
  out += ",\"tap\":";
  out += tap ? "true" : "false";
  out += ",\"ip\":\"";
  if (tap && addr) out += ipString(addr) + "/" + std::to_string(bits);
  out += "\",\"edge\":";
  out += snap.answered ? "true" : "false";
  out += ",\"sn\":";
  if (snap.snCurrent) {
    out += "{\"addr\":\"" + snap.snAddr + "\",\"age\":" + std::to_string(snap.snAge) + "}";
  } else {
    out += "null";
  }
  out += ",\"peers\":[";
  for (size_t i = 0; i < snap.peers.size(); ++i) {
    const Peer &p = snap.peers[i];
    if (i) out += ",";
    out += "{\"desc\":\"" + p.desc + "\",\"ip\":\"" + p.ip + "\",\"mode\":\"" + p.mode +
           "\",\"age\":" + std::to_string(p.age) + "}";
  }
  out += "],\"at\":" + std::to_string((long long)snap.at);
  out += ",\"viaVpn\":";
  out += nativeVpnClientIsVpn(clientIp) ? "true" : "false";
  // Why the edge did not start (the helper's ExecCondition writes it, since
  // that check runs before the edge and so is not in the edge's own output).
  std::string edgeState = readFile(std::string(kStateDir) + "/edge.json", 1024);
  out += ",\"edgeError\":\"" + jsonSafe(jsonString(edgeState, "error")) + "\"";
  out += ",\"helper\":";
  std::string helper = readFile(std::string(kStateDir) + "/status.json", 16384);
  out += looksLikeObject(helper) ? trim(helper) : "null";
  out += "}";
  return out;
}

std::string nativeVpnCodeJson() {
  Config c = loadConfig();
  if (c.code.empty()) return "{\"code\":\"\"}";
  return "{\"code\":\"" + c.code + "\",\"community\":\"" + c.community + "\",\"key\":\"" +
         c.key + "\",\"cipher\":\"ChaCha20\",\"supernode\":\"" + c.supernode + "\"}";
}

std::string nativeVpnPair(const std::string &action, const std::string &code,
                          const std::string &defaultDesc, uint32_t clientIp,
                          std::string *codeOut) {
  (void)clientIp;   // moving to another network cuts the requester off by design
  std::string canon;
  if (action == "new") {
    canon = vpncode::normalize(vpncode::generate());
    if (canon.empty()) return "no random source on this machine";
  } else if (action == "join") {
    canon = vpncode::normalize(code);
    if (canon.empty()) return "that is not a valid pairing code -- check it for typos";
  } else {
    return "unknown action";
  }
  Config c = loadConfig();
  c.code = vpncode::format(canon);
  c.community = vpncode::community(canon);
  c.key = vpncode::key(canon);
  c.enabled = true;
  if (c.desc.empty()) {
    std::string d = upper(defaultDesc);
    c.desc = vpncode::validDescription(d) ? d : vpncode::defaultDescription("", nativeHostLabel());
  }
  std::string err = saveConfig(c);
  if (!err.empty()) return err;
  if (codeOut) *codeOut = c.code;
  return requestHelper("apply", 0);
}

std::string nativeVpnSet(const bool *enabled, const std::string *desc,
                         const std::string *supernode, uint32_t clientIp) {
  Config c = loadConfig();
  if (desc) {
    std::string d = upper(trim(*desc));
    if (!vpncode::validDescription(d))
      return "device name: 1 to 15 of A-Z 0-9 / . _ -";
    c.desc = d;
  }
  if (supernode) {
    std::string s = trim(*supernode);
    if (s.empty()) s = kDefaultSupernode;
    if (!vpncode::validSupernode(s)) return "supernode: host:port";
    c.supernode = s;
  }
  if (enabled) {
    if (*enabled && c.code.empty()) return "pair this device first";
    c.enabled = *enabled;
  }
  std::string err = saveConfig(c);
  if (!err.empty()) return err;
  // Watched only when the change keeps the VPN on: switching it off from
  // inside is a decision the page has already confirmed.
  uint32_t watch = (c.enabled && nativeVpnClientIsVpn(clientIp)) ? clientIp : 0;
  return requestHelper("apply", watch);
}

std::string nativeVpnLeave() {
  Config c = loadConfig();
  c.enabled = false;
  c.code.clear();
  c.community.clear();
  c.key.clear();
  std::string err = saveConfig(c);
  if (!err.empty()) return err;
  return requestHelper("apply", 0);
}

std::string nativeVpnInstall() {
  std::string why;
  if (strcmp(nativeVpnMode(&why), "manual") == 0) return why;
  if (nativeRootIsOverlay())
    return "the system is locked (fslock) -- unlock it and run the Raspberry Pi installer";
  return requestHelper("install", 0);
}

std::string nativeVpnImport(const std::string &json, uint32_t clientIp) {
  Config c = loadConfig();
  std::string code = jsonString(json, "code");
  if (!code.empty()) {
    std::string canon = vpncode::normalize(code);
    if (canon.empty()) return "invalid pairing code";
    c.code = vpncode::format(canon);
    c.community = vpncode::community(canon);
    c.key = vpncode::key(canon);
    c.enabled = jsonBool(json, "enabled", false);
  } else {
    c.code.clear();
    c.community.clear();
    c.key.clear();
    c.enabled = false;
  }
  std::string desc = jsonString(json, "desc");
  if (vpncode::validDescription(desc)) c.desc = desc;
  std::string sn = jsonString(json, "supernode");
  if (vpncode::validSupernode(sn)) c.supernode = sn;
  std::string err = saveConfig(c);
  if (!err.empty()) return err;
  uint32_t watch = (c.enabled && nativeVpnClientIsVpn(clientIp)) ? clientIp : 0;
  return requestHelper("apply", watch);
}

int nativeVpnCli(const std::string &codeOrNew, bool enable, const std::string &desc) {
  std::string canon = codeOrNew == "new" ? vpncode::normalize(vpncode::generate())
                                         : vpncode::normalize(codeOrNew);
  if (canon.empty()) {
    fprintf(stderr, "wifilt: not a valid pairing code (expected WL-XXXX-...-C)\n");
    return 2;
  }
  Config c = loadConfig();
  c.code = vpncode::format(canon);
  c.community = vpncode::community(canon);
  c.key = vpncode::key(canon);
  if (enable) c.enabled = true;
  if (!desc.empty()) {
    std::string d = upper(desc);
    if (!vpncode::validDescription(d)) {
      fprintf(stderr, "wifilt: device name must be 1 to 15 of A-Z 0-9 / . _ -\n");
      return 2;
    }
    c.desc = d;
  } else if (c.desc.empty()) {
    c.desc = vpncode::defaultDescription(eepromCallsign(), nativeHostLabel());
  }
  std::string err = saveConfig(c);
  if (!err.empty()) {
    fprintf(stderr, "wifilt: %s\n", err.c_str());
    return 1;
  }
  requestHelper("apply", 0);   // a no-op without the units; pi-setup restarts the service itself
  printf("%s\n", c.code.c_str());
  return 0;
}

#else  // !__linux__ -- remote access is Linux only (CAP_VPN); Windows decided against it.

const char *nativeVpnMode(std::string *reason) {
  if (reason) *reason = "remote access is available on Linux only";
  return "manual";
}
std::string nativeVpnStatusJson(uint32_t) { return "{\"mode\":\"manual\"}"; }
std::string nativeVpnCodeJson() { return "{\"code\":\"\"}"; }
bool nativeVpnClientIsVpn(uint32_t) { return false; }
std::string nativeVpnPair(const std::string &, const std::string &, const std::string &, uint32_t,
                          std::string *) { return "Linux only"; }
std::string nativeVpnSet(const bool *, const std::string *, const std::string *, uint32_t) {
  return "Linux only";
}
std::string nativeVpnLeave() { return "Linux only"; }
std::string nativeVpnInstall() { return "Linux only"; }
std::string nativeVpnImport(const std::string &, uint32_t) { return ""; }
const char *nativeVpnConfigFile() { return "/vpn.json"; }
void nativeVpnStart() {}
int nativeVpnCli(const std::string &, bool, const std::string &) {
  fprintf(stderr, "wifilt: remote access is available on Linux only\n");
  return 2;
}

#endif
