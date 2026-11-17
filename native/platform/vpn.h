// The native build's side of "Remote access" -- the n2n VPN to the supernode
// on remoteqth.com (docs/vpn-n2n-implementace.md, SOFTWARE.md).
//
// wifilt never runs the VPN itself: the n2n edge is its own service
// (wifilt-vpn.service), so the station stays reachable while wifilt restarts,
// crashes or is being updated -- remote access is the lifeline for exactly
// those moments. wifilt only
//   * keeps the settings in vpn.json in its config directory (mode 0600; on a
//     locked Pi that directory is on the data card, so nothing in /etc has to
//     survive a reboot),
//   * asks the root helper to apply them by dropping req/apply.json into
//     /var/lib/wifilt-vpn (wifilt-vpn-apply.path), the update pattern,
//   * and reads the edge's state from its management port, 127.0.0.1:5644, in a
//     background thread -- the web handlers never wait on a socket.
// Linux only (CAP_VPN); the helper and the units come from native/install.sh.
#pragma once

#include <stdint.h>
#include <string>

// "ok"      installed by install.sh with the VPN units, n2n present
// "no-n2n"  the same, but /usr/local/sbin/edge is missing (SETUP offers to build it)
// "manual"  no VPN units (not installed by install.sh, or wifilt uses another
//           config directory than the helper reads); `reason` says which
const char *nativeVpnMode(std::string *reason);

// Starts the background thread that reads the edge's management port, so the
// first /vpn/status already has an answer (wifilt.ino, with the routes).
void nativeVpnStart();

// Everything SETUP and the topbar show; clientIp (network order) is the
// requester, so the page can warn "you are connected through this VPN".
std::string nativeVpnStatusJson(uint32_t clientIp);

// The pairing code and what it means for another n2n client (hin2n):
// {"code","community","key","cipher","supernode"}; {"code":""} when unpaired.
std::string nativeVpnCodeJson();

// The requester reaches wifilt through the VPN (its address is in wlvpn0's subnet).
bool nativeVpnClientIsVpn(uint32_t clientIp);

// SETUP actions. Each returns "" or a short reason. A change made from inside
// the VPN carries the requester's address: the helper puts the previous
// settings back when that address does not answer through the new ones.
//   pair: action "new" (fresh code) or "join" (code typed by the operator);
//         defaultDesc is used when no device name is set yet.
std::string nativeVpnPair(const std::string &action, const std::string &code,
                          const std::string &defaultDesc, uint32_t clientIp,
                          std::string *codeOut);
//   set: only the fields that are present change.
std::string nativeVpnSet(const bool *enabled, const std::string *desc,
                         const std::string *supernode, uint32_t clientIp);
std::string nativeVpnLeave();
//   build and install n2n 3.1.1 (native/vpn/build-n2n.sh) through the helper.
std::string nativeVpnInstall();

// Configuration backup: the vpn object of /config/upload (the download side
// streams vpn.json itself). Validates, recomputes community and key from the
// code, and applies.
std::string nativeVpnImport(const std::string &json, uint32_t clientIp);

// cfgFS path of the settings, for the backup ("/vpn.json").
const char *nativeVpnConfigFile();

// `wifilt --vpn-pair new|CODE [--vpn-enable] [--vpn-desc NAME]`, used by
// pi-setup. Writes vpn.json into the config directory, prints the code and
// returns the process exit status.
int nativeVpnCli(const std::string &codeOrNew, bool enable, const std::string &desc);
