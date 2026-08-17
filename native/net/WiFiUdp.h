// Native WiFiUDP -- the transport under everything that matters here:
// the ICOM RS-BA1 control/CI-V/audio channels (UDP 50001-50003 and the
// per-slot triplets), TrxNet discovery on 5683, and the setup-page radio scan.
//
// TrxNet takes a `UDP&`, so this must derive from the abstract UDP class the
// same way the ESP32 WiFiUDP does; that is why TrxNet.cpp needs no changes at
// all for the native build.
#pragma once

#include <stdint.h>

#include <vector>

#include "Udp.h"
#include "socket_compat.h"

class WiFiUDP : public UDP {
public:
  WiFiUDP() = default;
  ~WiFiUDP() override;

  uint8_t begin(uint16_t port) override;
  uint8_t beginMulticast(IPAddress address, uint16_t port) override;
  void    stop() override;

  int    beginPacket(IPAddress ip, uint16_t port) override;
  int    beginPacket(const char *host, uint16_t port) override;
  int    endPacket() override;
  size_t write(uint8_t value) override;
  size_t write(const uint8_t *buffer, size_t size) override;
  using Print::write;

  int  parsePacket() override;
  int  available() override;
  int  read() override;
  int  read(unsigned char *buffer, size_t length) override;
  int  read(char *buffer, size_t length) override;
  int  peek() override;
  void flush() override;

  IPAddress remoteIP() override;
  uint16_t  remotePort() override;

  // Raw descriptor, for the same non-blocking select() polling the audio path
  // uses on the TCP side.
  int fd() const { return (int)socket; }

private:
  wifilt_socket_t      socket = WIFILT_INVALID_SOCKET;
  std::vector<uint8_t> rxBuffer;
  size_t               rxOffset = 0;
  std::vector<uint8_t> txBuffer;
  struct sockaddr_in   txTarget {};
  bool                 txOpen = false;
  IPAddress            lastRemote;
  uint16_t             lastRemotePort = 0;
};
