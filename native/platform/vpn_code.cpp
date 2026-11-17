#include "vpn_code.h"

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__linux__)
  #include <sys/random.h>
#endif

namespace vpncode {

namespace {

// Crockford's base32: no I, L, O, U -- nothing to mistake when read aloud.
const char kAlphabet[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
constexpr int kN = 32;

int symbolValue(char c) {
  const char *p = strchr(kAlphabet, c);
  return (c && p) ? (int)(p - kAlphabet) : -1;
}

bool randomBytes(uint8_t *out, size_t n) {
#if defined(__linux__)
  size_t got = 0;
  while (got < n) {
    ssize_t r = getrandom(out + got, n - got, 0);
    if (r <= 0) return false;
    got += (size_t)r;
  }
  return true;
#else
  FILE *f = fopen("/dev/urandom", "rb");
  if (!f) return false;
  bool ok = fread(out, 1, n, f) == n;
  fclose(f);
  return ok;
#endif
}

// Luhn mod N over symbol values, rightmost symbol doubled first.
int luhnSum(const std::string &symbols, bool withCheck) {
  int factor = withCheck ? 1 : 2;
  int sum = 0;
  for (size_t i = symbols.size(); i-- > 0;) {
    int addend = factor * symbolValue(symbols[i]);
    factor = factor == 2 ? 1 : 2;
    sum += addend / kN + addend % kN;
  }
  return sum;
}

}  // namespace

char checkSymbol(const std::string &payload) {
  int remainder = luhnSum(payload, false) % kN;
  return kAlphabet[(kN - remainder) % kN];
}

std::string generate() {
  uint8_t bytes[kPayload];
  if (!randomBytes(bytes, sizeof(bytes))) return "";
  std::string payload;
  // 256 is a multiple of 32, so the low five bits are uniform.
  for (uint8_t b : bytes) payload += kAlphabet[b & 31];
  return format(payload + checkSymbol(payload));
}

std::string normalize(const std::string &typed) {
  std::string s;
  for (char c : typed) {
    if (c == ' ' || c == '-' || c == '_' || c == '\t' || c == '\r' || c == '\n') continue;
    c = (char)toupper((unsigned char)c);
    s += c;
  }
  if (s.size() == (size_t)kPayload + 3 && s.compare(0, 2, "WL") == 0) s.erase(0, 2);
  if (s.size() != (size_t)kPayload + 1) return "";
  for (char &c : s) {
    if (c == 'O') c = '0';
    else if (c == 'I' || c == 'L') c = '1';
    if (symbolValue(c) < 0) return "";
  }
  if (luhnSum(s, true) % kN != 0) return "";
  return s;
}

std::string format(const std::string &canonical) {
  if (canonical.size() != (size_t)kPayload + 1) return "";
  std::string out = "WL";
  for (int i = 0; i < kPayload; i += 4) out += "-" + canonical.substr(i, 4);
  out += "-";
  out += canonical[kPayload];
  return out;
}

std::string community(const std::string &canonical) {
  if (canonical.size() != (size_t)kPayload + 1) return "";
  std::string c = "wl-";
  for (int i = 0; i < kCommunityChars; ++i) c += (char)tolower((unsigned char)canonical[i]);
  return c;
}

std::string key(const std::string &canonical) {
  if (canonical.size() != (size_t)kPayload + 1) return "";
  return canonical.substr(kCommunityChars, kKeyChars);
}

std::string defaultDescription(const std::string &callsign, const std::string &hostLabel) {
  std::string call;
  for (char c : callsign) {
    c = (char)toupper((unsigned char)c);
    if (isalnum((unsigned char)c) || c == '/') call += c;
  }
  std::string label;
  for (char c : hostLabel) {
    c = (char)toupper((unsigned char)c);
    if (isalnum((unsigned char)c)) label += c;
  }
  if (label.empty()) label = "PC";
  if (call.empty()) call = "WIFILT";
  std::string desc = call + "-" + label;
  if (desc.size() > (size_t)kDescMax) {
    // Keep the label: two of one operator's machines must not collapse into
    // one name, and the callsign is the part that can lose its tail.
    size_t keep = (size_t)kDescMax - label.size() - 1;
    desc = call.substr(0, keep) + "-" + label;
  }
  return desc;
}

bool validDescription(const std::string &desc) {
  if (desc.empty() || desc.size() > (size_t)kDescMax) return false;
  for (char c : desc) {
    if (!(isdigit((unsigned char)c) || (c >= 'A' && c <= 'Z') || c == '/' || c == '.' ||
          c == '_' || c == '-'))
      return false;
  }
  return true;
}

bool validSupernode(const std::string &hostPort) {
  size_t colon = hostPort.rfind(':');
  if (colon == std::string::npos || colon == 0 || colon > 253) return false;
  std::string host = hostPort.substr(0, colon), port = hostPort.substr(colon + 1);
  for (char c : host) {
    if (!(isalnum((unsigned char)c) || c == '.' || c == '-')) return false;
  }
  if (port.empty() || port.size() > 5) return false;
  for (char c : port) {
    if (!isdigit((unsigned char)c)) return false;
  }
  long p = atol(port.c_str());
  return p >= 1 && p <= 65535;
}

bool validCommunity(const std::string &c) {
  if (c.size() != 3u + kCommunityChars || c.compare(0, 3, "wl-") != 0) return false;
  for (size_t i = 3; i < c.size(); ++i) {
    if (!(isdigit((unsigned char)c[i]) || (c[i] >= 'a' && c[i] <= 'z'))) return false;
  }
  return true;
}

bool validKey(const std::string &k) {
  if (k.size() != (size_t)kKeyChars) return false;
  for (char c : k) {
    if (!(isdigit((unsigned char)c) || (c >= 'A' && c <= 'Z'))) return false;
  }
  return true;
}

}  // namespace vpncode
