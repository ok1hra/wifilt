// trxnet_udp.h -- Arduino UDP adapter over UdpSocket, for TrxNet.cpp's `UDP&`.
//
// TrxNet.cpp (vendored source, reused unmodified per bod 15/12) needs a
// concrete `UDP` (native/net/Udp.h's abstract class -- same interface
// WiFiUDP implements). Not WiFiUDP itself: same wildcard-bind problem
// udp_socket.h's header comment describes for the ICOM-LAN channels, and it
// bites just as hard here -- a native wifilt build on the SAME machine als
// runs its own TrxNet on port 5683 wildcard-bound (confirmed live, see
// trxnet_peer.h). This wraps the already-fixed UdpSocket (bind to a specific
// IP) behind the same Arduino-style stateful interface WiFiUDP presents,
// mirroring its internal buffering [native/net/WiFiUdp.cpp] almost exactly.
#pragma once

#include <string>
#include <vector>

#include <Udp.h>

#include "udp_socket.h"

namespace LocalTrx {

class TrxNetUdp : public UDP {
 public:
  explicit TrxNetUdp(std::string listenIp);

  uint8_t begin(uint16_t port) override;
  uint8_t beginMulticast(IPAddress, uint16_t) override { return 0; }   // unused by TrxNet
  void stop() override;

  int beginPacket(IPAddress ip, uint16_t port) override;
  int beginPacket(const char *host, uint16_t port) override;   // unused by TrxNet; not implemented
  int endPacket() override;
  size_t write(uint8_t value) override;
  size_t write(const uint8_t *buffer, size_t size) override;
  using Print::write;

  int parsePacket() override;
  int available() override;
  int read() override;
  int read(unsigned char *buffer, size_t length) override;
  int read(char *buffer, size_t length) override;
  int peek() override;
  void flush() override;

  IPAddress remoteIP() override;
  uint16_t remotePort() override;

 private:
  std::string listenIp_;
  UdpSocket socket_;

  UdpPeer txTarget_;
  bool txOpen_ = false;
  std::vector<uint8_t> txBuffer_;

  std::vector<uint8_t> rxBuffer_;
  size_t rxOffset_ = 0;
  UdpPeer lastRemote_;
};

}  // namespace LocalTrx
