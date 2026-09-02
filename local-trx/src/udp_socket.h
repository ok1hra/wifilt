// udp_socket.h -- a UDP socket bound to a SPECIFIC local IP, not INADDR_ANY.
//
// Why not native/net/WiFiUDP (bod 12's usual reuse target): its begin(port)
// always binds INADDR_ANY [native/net/WiFiUdp.cpp] -- correct for wifilt
// itself (one WiFi interface), wrong here. On the SAME machine wifilt's own
// LAN client also binds local port 50001 on INADDR_ANY; two wildcard binds to
// the identical port collide (discovered live, 2026-08-31 -- packets never
// reached local-trx at all). tools/icom-lan-fake-radio.py already avoids this
// by binding its Python socket to a specific address, never 0.0.0.0 -- this
// is that same fix, done in C++ without touching native/net/WiFiUdp.cpp (bod
// 12's "nula diffů v native/" stays literal, not just in spirit).
//
// Deliberately not a UDP subclass either: that abstract base is what lets
// TrxNet.cpp take a transport-agnostic reference (see trxnet_peer.h, bod 15)
// and is not needed here -- icom_lan_server.cpp is the only caller.
#pragma once

#include <cstdint>
#include <string>

#include "../../native/net/socket_compat.h"

namespace LocalTrx {

struct UdpPeer {
  uint32_t addr = 0;   // network-order IPv4, as sockaddr_in.sin_addr.s_addr
  uint16_t port = 0;
};

class UdpSocket {
 public:
  ~UdpSocket();

  // bindIp empty -> INADDR_ANY (used by nothing here on purpose, kept only
  // for a config with an unset/blank listenIp rather than refusing to start).
  bool begin(const std::string &bindIp, uint16_t port, std::string *error);

  // Non-blocking. Returns the datagram length (>0), 0 when nothing is
  // pending, or a negative value on a real socket error.
  int recv(uint8_t *buf, size_t maxLen, UdpPeer *from);

  bool sendTo(const uint8_t *data, size_t len, const UdpPeer &to);

  static std::string peerToString(const UdpPeer &peer);

 private:
  wifilt_socket_t socket_ = WIFILT_INVALID_SOCKET;
};

}  // namespace LocalTrx
