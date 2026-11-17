// Native regression test for the VPN pairing code (native/platform/vpn_code.cpp).
//
//   g++ -std=c++17 -Wall -Wextra -o /tmp/vpn-code-smoke tools/vpn-code-smoke.cpp native/platform/vpn_code.cpp
//   /tmp/vpn-code-smoke

#include <cassert>
#include <cstdio>
#include <set>
#include <string>

#include "../native/platform/vpn_code.h"

using namespace vpncode;

int main() {
  // A fixed vector: payload "0123456789ABCDEFGHJKMNPQRSTV" (28 symbols).
  const std::string payload = "0123456789ABCDEFGHJKMNPQRSTV";
  const char check = checkSymbol(payload);
  const std::string canonical = payload + check;
  assert(normalize(canonical) == canonical);
  const std::string formatted = format(canonical);
  assert(formatted.size() == 2 + 7 * 5 + 2);   // WL, 7 x -XXXX, -C
  assert(formatted.compare(0, 3, "WL-") == 0);
  assert(formatted == "WL-0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-" + std::string(1, check));
  assert(community(canonical) == "wl-01234567");
  assert(key(canonical) == "89ABCDEFGHJKMNPQRSTV");
  assert(validCommunity(community(canonical)));
  assert(validKey(key(canonical)));

  // What an operator types still lands on the same code.
  std::string lower;
  for (char c : formatted) lower += (char)tolower((unsigned char)c);
  assert(normalize(lower) == canonical);
  assert(normalize(" wl 0123 4567 89ab cdef ghjk mnpq rstv " + std::string(1, check)) == canonical);
  assert(normalize(formatted.substr(3)) == canonical);          // without "WL-"
  // Look-alikes: O for 0, I and L for 1.
  std::string looks = formatted;
  looks[3] = 'O';                       // the '0'
  looks[4] = 'I';                       // the '1'
  assert(normalize(looks) == canonical);
  looks[4] = 'l';
  assert(normalize(looks) == canonical);

  // Every single-symbol typo is caught by the check symbol.
  const char *alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  int caught = 0, tried = 0;
  for (size_t i = 0; i < canonical.size(); ++i) {
    for (const char *a = alphabet; *a; ++a) {
      if (*a == canonical[i]) continue;
      std::string bad = canonical;
      bad[i] = *a;
      ++tried;
      if (normalize(bad).empty()) ++caught;
    }
  }
  assert(caught == tried);
  // And adjacent swaps of different symbols, almost always (Luhn mod N misses
  // only pairs whose values differ by N/2... none here would pass unnoticed by
  // more than a handful). Count, do not demand perfection.
  int swapsCaught = 0, swaps = 0;
  for (size_t i = 0; i + 1 < canonical.size(); ++i) {
    if (canonical[i] == canonical[i + 1]) continue;
    std::string bad = canonical;
    std::swap(bad[i], bad[i + 1]);
    ++swaps;
    if (normalize(bad).empty()) ++swapsCaught;
  }
  assert(swapsCaught >= swaps - 2);

  // Wrong length, foreign symbol (U), empty.
  assert(normalize(canonical.substr(1)).empty());
  assert(normalize(canonical + "0").empty());
  std::string withU = canonical;
  withU[5] = 'U';
  assert(normalize(withU).empty());
  assert(normalize("").empty());

  // Generated codes are valid, distinct, and the community fits the
  // supernode's regex (wl- + 8 of \w).
  std::set<std::string> seen;
  for (int i = 0; i < 200; ++i) {
    std::string code = generate();
    assert(!code.empty());
    std::string c = normalize(code);
    assert(!c.empty());
    assert(format(c) == code);
    assert(validCommunity(community(c)));
    assert(validKey(key(c)));
    seen.insert(code);
  }
  assert(seen.size() == 200);

  // Description: callsign + host label, at most 15 symbols, label kept.
  assert(defaultDescription("ok1hra", "RPI") == "OK1HRA-RPI");
  assert(defaultDescription("OK1HRA/P", "PC") == "OK1HRA/P-PC");
  assert(defaultDescription("", "RPI") == "WIFILT-RPI");
  assert(defaultDescription("VERYLONGCALL123", "RPI") == "VERYLONGCAL-RPI");
  assert(defaultDescription("OK1HRA", "") == "OK1HRA-PC");
  assert(validDescription(defaultDescription("VERYLONGCALL123", "RPI")));
  assert(!validDescription(""));
  assert(!validDescription("lowercase"));
  assert(!validDescription("SIXTEEN-CHARS-XX"));
  assert(!validDescription("BAD SPACE"));

  // Supernode.
  assert(validSupernode("remoteqth.com:82"));
  assert(validSupernode("10.0.0.1:7654"));
  assert(!validSupernode("remoteqth.com"));
  assert(!validSupernode(":82"));
  assert(!validSupernode("remoteqth.com:0"));
  assert(!validSupernode("remoteqth.com:65536"));
  assert(!validSupernode("bad host:82"));
  assert(!validSupernode("evil;rm:82"));

  printf("vpn-code-smoke: ok (%d typos, %d/%d swaps caught)\n", tried, swapsCaught, swaps);
  return 0;
}
