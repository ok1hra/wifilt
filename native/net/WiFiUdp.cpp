#include "WiFiUdp.h"

#include <string.h>

WiFiUDP::~WiFiUDP() { stop(); }

uint8_t WiFiUDP::begin(uint16_t port) {
  stop();

  socket = ::socket(AF_INET, SOCK_DGRAM, 0);
  if (socket == WIFILT_INVALID_SOCKET) return 0;

  // SO_REUSEADDR matters more here than it looks: the setup-page radio scan
  // opens a second socket on 50001 while a live client may still hold it, and
  // the ICOM slots reuse fixed ports across reconnects.
  int reuse = 1;
  setsockopt(socket, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuse, sizeof(reuse));

  // The discovery sweep sends to the subnet broadcast address.
  int broadcast = 1;
  setsockopt(socket, SOL_SOCKET, SO_BROADCAST, (const char *)&broadcast,
             sizeof(broadcast));

  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_ANY);
  address.sin_port = htons(port);

  if (::bind(socket, (struct sockaddr *)&address, sizeof(address)) != 0) {
    WIFILT_CLOSE_SOCKET(socket);
    socket = WIFILT_INVALID_SOCKET;
    return 0;
  }

  // Non-blocking: parsePacket() is polled from the sketch loop and must never
  // stall it, exactly as on the box.
  nativeSocketSetNonBlocking(socket, true);
  return 1;
}

uint8_t WiFiUDP::beginMulticast(IPAddress address, uint16_t port) {
  if (!begin(port)) return 0;

  struct ip_mreq group;
  memset(&group, 0, sizeof(group));
  group.imr_multiaddr.s_addr = (uint32_t)address;
  group.imr_interface.s_addr = htonl(INADDR_ANY);
  setsockopt(socket, IPPROTO_IP, IP_ADD_MEMBERSHIP, (const char *)&group,
             sizeof(group));
  return 1;
}

void WiFiUDP::stop() {
  if (socket != WIFILT_INVALID_SOCKET) {
    WIFILT_CLOSE_SOCKET(socket);
    socket = WIFILT_INVALID_SOCKET;
  }
  rxBuffer.clear();
  rxOffset = 0;
  txBuffer.clear();
  txOpen = false;
}

int WiFiUDP::beginPacket(IPAddress ip, uint16_t port) {
  if (socket == WIFILT_INVALID_SOCKET) {
    // The sketch sometimes sends before an explicit begin(); mirror the ESP32
    // behaviour of opening an ephemeral socket rather than silently dropping.
    if (!begin(0)) return 0;
  }
  memset(&txTarget, 0, sizeof(txTarget));
  txTarget.sin_family = AF_INET;
  txTarget.sin_addr.s_addr = (uint32_t)ip;
  txTarget.sin_port = htons(port);
  txBuffer.clear();
  txOpen = true;
  return 1;
}

int WiFiUDP::beginPacket(const char *host, uint16_t port) {
  if (!host || !*host) return 0;

  struct addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_DGRAM;

  struct addrinfo *results = nullptr;
  if (getaddrinfo(host, nullptr, &hints, &results) != 0 || !results) return 0;

  struct sockaddr_in *address = (struct sockaddr_in *)results->ai_addr;
  IPAddress resolved((uint32_t)address->sin_addr.s_addr);
  freeaddrinfo(results);

  return beginPacket(resolved, port);
}

int WiFiUDP::endPacket() {
  if (!txOpen || socket == WIFILT_INVALID_SOCKET) return 0;
  txOpen = false;

  int sent = (int)::sendto(socket, (const char *)txBuffer.data(),
                           (int)txBuffer.size(), 0,
                           (struct sockaddr *)&txTarget, sizeof(txTarget));
  txBuffer.clear();
  return sent >= 0 ? 1 : 0;
}

size_t WiFiUDP::write(uint8_t value) { return write(&value, 1); }

size_t WiFiUDP::write(const uint8_t *buffer, size_t size) {
  if (!txOpen || !buffer || !size) return 0;
  txBuffer.insert(txBuffer.end(), buffer, buffer + size);
  return size;
}

int WiFiUDP::parsePacket() {
  if (socket == WIFILT_INVALID_SOCKET) return 0;

  // ICOM audio packets stay well under 1500; 2048 covers every frame the
  // protocol produces with room for a jumbo control packet.
  uint8_t staging[2048];
  struct sockaddr_in peer;
  socklen_t length = sizeof(peer);

  int got = (int)::recvfrom(socket, (char *)staging, sizeof(staging), 0,
                            (struct sockaddr *)&peer, &length);
  if (got <= 0) return 0;

  rxBuffer.assign(staging, staging + got);
  rxOffset = 0;
  lastRemote = IPAddress((uint32_t)peer.sin_addr.s_addr);
  lastRemotePort = ntohs(peer.sin_port);
  return got;
}

int WiFiUDP::available() {
  return (int)(rxBuffer.size() - rxOffset);
}

int WiFiUDP::read() {
  if (rxOffset >= rxBuffer.size()) return -1;
  return rxBuffer[rxOffset++];
}

int WiFiUDP::read(unsigned char *buffer, size_t length) {
  if (!buffer || rxOffset >= rxBuffer.size()) return -1;
  size_t remaining = rxBuffer.size() - rxOffset;
  size_t take = length < remaining ? length : remaining;
  memcpy(buffer, rxBuffer.data() + rxOffset, take);
  rxOffset += take;
  return (int)take;
}

int WiFiUDP::read(char *buffer, size_t length) {
  return read((unsigned char *)buffer, length);
}

int WiFiUDP::peek() {
  if (rxOffset >= rxBuffer.size()) return -1;
  return rxBuffer[rxOffset];
}

void WiFiUDP::flush() {
  rxOffset = rxBuffer.size();
}

IPAddress WiFiUDP::remoteIP() { return lastRemote; }
uint16_t  WiFiUDP::remotePort() { return lastRemotePort; }
