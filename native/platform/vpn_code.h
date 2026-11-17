// The VPN pairing code (docs/vpn-n2n-implementace.md, SOFTWARE.md "Remote access").
//
// One string a person can read out, paste or scan, which IS the private network:
//
//   WL-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-C
//
// 28 random Crockford base32 symbols plus one Luhn mod 32 check symbol. The
// first 8 become the n2n community ("wl-" + lower case, so the supernode's
// community.list regex `wl-\w\w\w\w\w\w\w\w` accepts it), the other 20 the key
// (100 bits). Deriving is plain slicing -- no hash -- so the bash side never has
// to reproduce anything: wifilt writes community and key into vpn.json itself.
//
// Pure functions on std::string only, so tools/vpn-code-smoke.cpp can test them
// without the rest of the native build.
#pragma once

#include <string>

namespace vpncode {

constexpr int kPayload = 28;         // random symbols
constexpr int kCommunityChars = 8;   // of which the community
constexpr int kKeyChars = 20;        // and the key
constexpr int kDescMax = 15;         // n2n_desc_t is 16 bytes, NUL not guaranteed

// A fresh code from the operating system's RNG, formatted; "" if there is none.
std::string generate();

// The 29 canonical symbols (payload + check) of whatever the operator typed --
// lower case, spaces, dashes, a missing "WL-" and the look-alikes O/I/L are all
// accepted -- or "" when it is not a valid code (wrong length, a symbol outside
// the alphabet, or the check symbol does not match).
std::string normalize(const std::string &typed);

// "WL-XXXX-...-C" for canonical symbols (as normalize() returns them).
std::string format(const std::string &canonical);

// n2n community and key of canonical symbols.
std::string community(const std::string &canonical);
std::string key(const std::string &canonical);

// The Luhn mod 32 check symbol of a payload.
char checkSymbol(const std::string &payload);

// The edge's -I description. The supernode derives the edge's address from it,
// so it changes only when the operator changes it. "OK1HRA-RPI" from the
// station callsign and the host label; "WIFILT-RPI" without a callsign.
std::string defaultDescription(const std::string &callsign, const std::string &hostLabel);

// Field checks shared by the web handlers, the CLI and the config import. The
// root helper repeats them in bash (native/vpn/wifilt-vpn.sh) because it must
// not trust a file the unprivileged user can write.
bool validDescription(const std::string &desc);       // 1..15 of [A-Z0-9/._-]
bool validSupernode(const std::string &hostPort);     // host:port, host [A-Za-z0-9.-]
bool validCommunity(const std::string &community);    // wl- + 8 of [0-9a-z]
bool validKey(const std::string &key);                // 20 of [0-9A-Z]

}  // namespace vpncode
