// Native stand-in for the ESP32 WiFi library: WiFiClient, WiFiServer and the
// WiFiClass status surface.
//
// A PC has no WiFi to provision -- the OS owns the network long before this
// binary starts. So WiFiClass is a read-only window onto the host's networking
// (localIP, macAddress, hostByName) and every provisioning call is inert:
// begin(), softAP(), scanNetworks(), disconnect(). SETUP never shows those
// controls because /setup-data.json reports caps.wifi = false.
//
// WiFiClient and WiFiServer, by contrast, are real: they carry the DX-cluster
// telnet link, the APRS-IS link, the HTTP server and both hand-rolled
// WebSocket servers.
#pragma once

#include <memory>
#include <string>

#include "Arduino.h"
#include "Client.h"
#include "Server.h"
#include "socket_compat.h"

typedef enum {
  WL_NO_SHIELD      = 255,
  WL_IDLE_STATUS    = 0,
  WL_NO_SSID_AVAIL  = 1,
  WL_SCAN_COMPLETED = 2,
  WL_CONNECTED      = 3,
  WL_CONNECT_FAILED = 4,
  WL_CONNECTION_LOST = 5,
  WL_DISCONNECTED   = 6,
} wl_status_t;

typedef enum {
  WIFI_OFF = 0,
  WIFI_STA = 1,
  WIFI_AP = 2,
  WIFI_AP_STA = 3,
} wifi_mode_t;

// ---------------------------------------------------------------------------
// WiFiClient
//
// Copyable, sharing one socket, because the sketch keeps accepted connections
// in long-lived globals (DxcWsClient, AudioWsClient) that are assigned by value
// from WiFiServer::available(). Closing any copy closes the connection, which
// is what the ESP32 client does too.
// ---------------------------------------------------------------------------
class SocketHandle;

class WiFiClient : public Client {
public:
  WiFiClient();
  explicit WiFiClient(std::shared_ptr<SocketHandle> handle);

  int connect(IPAddress ip, uint16_t port) override;
  int connect(const char *host, uint16_t port) override;
  int connect(IPAddress ip, uint16_t port, int32_t timeoutMs);
  int connect(const char *host, uint16_t port, int32_t timeoutMs);

  size_t write(uint8_t value) override;
  size_t write(const uint8_t *buffer, size_t size) override;
  using Print::write;

  int  available() override;
  int  read() override;
  int  read(uint8_t *buffer, size_t size) override;
  int  peek() override;
  void flush() override;
  void stop() override;
  uint8_t connected() override;
  operator bool() override;

  void setNoDelay(bool noDelay);
  void setTimeout(uint32_t seconds);

  // Raw descriptor, so the sketch can select() on writability without blocking
  // the loop (wifilt.ino:2154, :8230). Returns -1 when not connected.
  int fd() const;

  IPAddress remoteIP() const;
  uint16_t  remotePort() const;

  bool operator==(const WiFiClient &other) const;
  bool operator!=(const WiFiClient &other) const { return !(*this == other); }

private:
  std::shared_ptr<SocketHandle> handle;
};

// Every WiFiServer (HTTP :80, DXC WS :82, AUD1 WS :83 -- all hardcoded ports,
// see wifilt.ino) binds INADDR_ANY by default, same as the real device (one
// WiFi interface, one obvious place to listen). On a PC that means two
// wifilt processes for two different radios can never coexist on one
// machine -- both would fight over the same three ports. --bind-ip lets a
// test harness give each instance its own loopback alias (127.0.0.11,
// 127.0.0.12, ...) instead, so "port 83" stops being a single global
// resource. Empty string (the default) preserves the original INADDR_ANY
// behavior exactly -- this is additive, not a behavior change for existing
// callers/the ESP32 build.
void nativeSetBindAddress(const std::string &ip);
const std::string &nativeBindAddress();

// ---------------------------------------------------------------------------
// WiFiServer -- listening socket, non-blocking accept.
// ---------------------------------------------------------------------------
class WiFiServer : public Server {
public:
  explicit WiFiServer(uint16_t port = 80, uint8_t maxClients = 4);
  ~WiFiServer();

  void begin(uint16_t port = 0) override;
  void end();
  void stop();
  void close();

  // Returns a connected client, or a falsy one when nobody is waiting.
  WiFiClient available();
  WiFiClient accept();

  void setNoDelay(bool noDelay);
  bool hasClient();

  size_t write(uint8_t) override { return 0; }

private:
  uint16_t        port;
  uint8_t         maxClients;
  bool            noDelay = false;
  wifilt_socket_t listener = WIFILT_INVALID_SOCKET;
};

// ---------------------------------------------------------------------------
// WiFiClass -- host network state, provisioning inert.
// ---------------------------------------------------------------------------
class WiFiClass {
public:
  // Provisioning: accepted and ignored. The OS already owns the connection.
  wl_status_t begin(const char *ssid = nullptr, const char *password = nullptr,
                    int32_t channel = 0, const uint8_t *bssid = nullptr,
                    bool connect = true);
  bool     mode(wifi_mode_t mode);
  bool     disconnect(bool wifiOff = false, bool eraseAp = false);
  bool     reconnect();
  bool     setSleep(bool enable);
  bool     setHostname(const char *hostname);
  const char *getHostname();
  bool     softAP(const char *ssid, const char *password = nullptr,
                  int channel = 1, int hidden = 0, int maxConnection = 4);
  int16_t  scanNetworks(bool async = false, bool showHidden = false,
                        bool passive = false, uint32_t maxMsPerChannel = 300);
  void     scanDelete();

  // Per-scan-result accessors. scanNetworks() always reports zero networks on
  // a PC -- enumerating the host's wireless neighbourhood is neither possible
  // portably nor useful, since the OS already owns the connection -- so these
  // exist to compile and to return empty rather than invented data.
  String   SSID(uint8_t index);
  int32_t  RSSI(uint8_t index);
  int32_t  channel(uint8_t index);
  uint8_t *BSSID(uint8_t index);
  uint8_t  encryptionType(uint8_t index);

  // State: answered honestly from the host.
  wl_status_t status();
  IPAddress   localIP();
  IPAddress   softAPIP();
  IPAddress   gatewayIP();
  IPAddress   subnetMask();
  String      SSID();
  String      macAddress();
  String      softAPmacAddress();
  int8_t      RSSI();
  int32_t     channel();
  uint8_t    *BSSID();
  int         hostByName(const char *hostname, IPAddress &result);

private:
  uint8_t bssid[6] = {0, 0, 0, 0, 0, 0};
  String  hostname;
};

extern WiFiClass WiFi;
