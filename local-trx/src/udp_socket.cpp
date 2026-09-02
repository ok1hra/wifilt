#include "udp_socket.h"

#include <cstdio>
#include <cstring>

namespace LocalTrx {

UdpSocket::~UdpSocket() {
  if (socket_ != WIFILT_INVALID_SOCKET) WIFILT_CLOSE_SOCKET(socket_);
}

bool UdpSocket::begin(const std::string &bindIp, uint16_t port, std::string *error) {
  socket_ = ::socket(AF_INET, SOCK_DGRAM, 0);
  if (socket_ == WIFILT_INVALID_SOCKET) {
    if (error) *error = std::string("socket() failed: ") + nativeSocketErrorText();
    return false;
  }

  int reuse = 1;
  setsockopt(socket_, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuse, sizeof(reuse));
  // TrxNet's peer discovery sends real UDP broadcasts (255.255.255.255) --
  // see trxnet_peer.h -- harmless for the ICOM-LAN channels, which never do.
  int broadcast = 1;
  setsockopt(socket_, SOL_SOCKET, SO_BROADCAST, (const char *)&broadcast, sizeof(broadcast));

  struct sockaddr_in address;
  std::memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons(port);
  if (bindIp.empty()) {
    address.sin_addr.s_addr = htonl(INADDR_ANY);
  } else if (::inet_pton(AF_INET, bindIp.c_str(), &address.sin_addr) != 1) {
    if (error) *error = "invalid listenIp: " + bindIp;
    WIFILT_CLOSE_SOCKET(socket_);
    socket_ = WIFILT_INVALID_SOCKET;
    return false;
  }

  if (::bind(socket_, (struct sockaddr *)&address, sizeof(address)) != 0) {
    if (error) {
      *error = std::string("bind ") + bindIp + ":" + std::to_string(port) +
               " failed: " + nativeSocketErrorText();
    }
    WIFILT_CLOSE_SOCKET(socket_);
    socket_ = WIFILT_INVALID_SOCKET;
    return false;
  }

  nativeSocketSetNonBlocking(socket_, true);
  return true;
}

int UdpSocket::recv(uint8_t *buf, size_t maxLen, UdpPeer *from) {
  struct sockaddr_in peer;
  socklen_t peerLen = sizeof(peer);
  int got = (int)::recvfrom(socket_, (char *)buf, (int)maxLen, 0, (struct sockaddr *)&peer,
                            &peerLen);
  if (got < 0) {
    return WIFILT_WOULD_BLOCK() ? 0 : -1;
  }
  if (from) {
    from->addr = (uint32_t)peer.sin_addr.s_addr;
    from->port = ntohs(peer.sin_port);
  }
  return got;
}

bool UdpSocket::sendTo(const uint8_t *data, size_t len, const UdpPeer &to) {
  struct sockaddr_in target;
  std::memset(&target, 0, sizeof(target));
  target.sin_family = AF_INET;
  target.sin_addr.s_addr = to.addr;
  target.sin_port = htons(to.port);
  int sent = (int)::sendto(socket_, (const char *)data, (int)len, 0,
                           (struct sockaddr *)&target, sizeof(target));
  return sent >= 0;
}

std::string UdpSocket::peerToString(const UdpPeer &peer) {
  struct in_addr a;
  a.s_addr = peer.addr;
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%s:%u", ::inet_ntoa(a), (unsigned)peer.port);
  return buf;
}

}  // namespace LocalTrx
