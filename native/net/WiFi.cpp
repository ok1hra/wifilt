#include "WiFi.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include <string>

#ifdef _WIN32
  #include <iphlpapi.h>
#else
  #include <ifaddrs.h>
  #include <net/if.h>
  #ifdef __linux__
    #include <linux/if_packet.h>
  #elif defined(__APPLE__)
    #include <net/if_dl.h>
  #endif
#endif

WiFiClass WiFi;

// ---------------------------------------------------------------------------
// socket_compat
// ---------------------------------------------------------------------------

bool nativeSocketsInit(void) {
#ifdef _WIN32
  WSADATA data;
  return WSAStartup(MAKEWORD(2, 2), &data) == 0;
#else
  return true;
#endif
}

void nativeSocketsShutdown(void) {
#ifdef _WIN32
  WSACleanup();
#endif
}

bool nativeSocketSetNonBlocking(wifilt_socket_t socket, bool nonBlocking) {
  if (socket == WIFILT_INVALID_SOCKET) return false;
#ifdef _WIN32
  u_long mode = nonBlocking ? 1 : 0;
  return ioctlsocket(socket, FIONBIO, &mode) == 0;
#else
  int flags = fcntl(socket, F_GETFL, 0);
  if (flags < 0) return false;
  flags = nonBlocking ? (flags | O_NONBLOCK) : (flags & ~O_NONBLOCK);
  return fcntl(socket, F_SETFL, flags) == 0;
#endif
}

const char *nativeSocketErrorText(void) {
#ifdef _WIN32
  // FormatMessage would be more faithful, but it allocates and needs freeing on
  // an error path. The handful of failures that actually happen here are worth
  // naming outright; anything else falls back to the numeric code.
  static char buffer[64];
  const int error = WSAGetLastError();
  switch (error) {
    case WSAEACCES:       return "permission denied";
    case WSAEADDRINUSE:   return "address already in use";
    case WSAEADDRNOTAVAIL:return "address not available";
    case WSAENETDOWN:     return "network is down";
    case WSAECONNREFUSED: return "connection refused";
    case WSAETIMEDOUT:    return "timed out";
    case WSAEHOSTUNREACH: return "host unreachable";
    default:
      snprintf(buffer, sizeof(buffer), "winsock error %d", error);
      return buffer;
  }
#else
  return strerror(errno);
#endif
}

bool nativeSocketErrorWasPermission(void) {
#ifdef _WIN32
  return WSAGetLastError() == WSAEACCES;
#else
  return errno == EACCES;
#endif
}

bool nativeAddressIsOnLocalLink(uint32_t networkOrderAddress) {
  const uint32_t address = ntohl(networkOrderAddress);
  if ((address >> 24) == 127) return true;              // loopback

#ifdef _WIN32
  ULONG size = 15 * 1024;
  IP_ADAPTER_ADDRESSES *adapters = (IP_ADAPTER_ADDRESSES *)malloc(size);
  if (!adapters) return false;
  bool local = false;
  if (GetAdaptersAddresses(AF_INET, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST |
                           GAA_FLAG_SKIP_DNS_SERVER, nullptr, adapters, &size) == NO_ERROR) {
    for (IP_ADAPTER_ADDRESSES *a = adapters; a && !local; a = a->Next) {
      for (IP_ADAPTER_UNICAST_ADDRESS *u = a->FirstUnicastAddress; u; u = u->Next) {
        if (u->Address.lpSockaddr->sa_family != AF_INET) continue;
        const uint32_t own =
            ntohl(((struct sockaddr_in *)u->Address.lpSockaddr)->sin_addr.s_addr);
        const uint8_t bits = u->OnLinkPrefixLength;
        const uint32_t mask = bits == 0 ? 0 : (0xFFFFFFFFu << (32 - bits));
        if ((own & mask) == (address & mask)) { local = true; break; }
      }
    }
  }
  free(adapters);
  return local;
#else
  struct ifaddrs *interfaces = nullptr;
  if (getifaddrs(&interfaces) != 0) return false;

  bool local = false;
  for (struct ifaddrs *entry = interfaces; entry && !local; entry = entry->ifa_next) {
    if (!entry->ifa_addr || !entry->ifa_netmask) continue;
    if (entry->ifa_addr->sa_family != AF_INET) continue;
    const uint32_t own =
        ntohl(((struct sockaddr_in *)entry->ifa_addr)->sin_addr.s_addr);
    const uint32_t mask =
        ntohl(((struct sockaddr_in *)entry->ifa_netmask)->sin_addr.s_addr);
    if ((own & mask) == (address & mask)) local = true;
  }
  freeifaddrs(interfaces);
  return local;
#endif
}

bool nativeSocketErrorWasInUse(void) {
#ifdef _WIN32
  return WSAGetLastError() == WSAEADDRINUSE;
#else
  return errno == EADDRINUSE;
#endif
}

bool nativeSocketSetNoDelay(wifilt_socket_t socket, bool noDelay) {
  if (socket == WIFILT_INVALID_SOCKET) return false;
  int value = noDelay ? 1 : 0;
  return setsockopt(socket, IPPROTO_TCP, TCP_NODELAY, (const char *)&value,
                    sizeof(value)) == 0;
}

// ---------------------------------------------------------------------------
// SocketHandle
// ---------------------------------------------------------------------------

class SocketHandle {
public:
  explicit SocketHandle(wifilt_socket_t socket) : socket(socket) {}
  ~SocketHandle() { close(); }

  void close() {
    if (socket != WIFILT_INVALID_SOCKET) {
      WIFILT_CLOSE_SOCKET(socket);
      socket = WIFILT_INVALID_SOCKET;
    }
  }

  wifilt_socket_t socket;
  int             peeked = -1;
  // Set once the peer closes. Kept separate from the descriptor so connected()
  // can still report true while unread bytes remain, which is what the Arduino
  // client does and what the sketch's drain loops rely on.
  bool            peerClosed = false;
  IPAddress       remote;
  uint16_t        remotePort = 0;
};

namespace {

// Resolves host:port and connects, bounded by timeoutMs so a dead DX cluster
// cannot wedge the sketch loop. The ESP32 client is bounded the same way.
wifilt_socket_t connectTo(const char *host, uint16_t port, int32_t timeoutMs,
                          IPAddress &resolved) {
  if (!host || !*host) return WIFILT_INVALID_SOCKET;

  char service[8];
  snprintf(service, sizeof(service), "%u", (unsigned)port);

  struct addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_INET;   // the whole protocol surface here is IPv4
  hints.ai_socktype = SOCK_STREAM;

  struct addrinfo *results = nullptr;
  if (getaddrinfo(host, service, &hints, &results) != 0 || !results)
    return WIFILT_INVALID_SOCKET;

  wifilt_socket_t handle = WIFILT_INVALID_SOCKET;
  for (struct addrinfo *entry = results; entry; entry = entry->ai_next) {
    handle = ::socket(entry->ai_family, entry->ai_socktype, entry->ai_protocol);
    if (handle == WIFILT_INVALID_SOCKET) continue;

    nativeSocketSetNonBlocking(handle, true);
    int rc = ::connect(handle, entry->ai_addr, (socklen_t)entry->ai_addrlen);

    bool connected = (rc == 0);
    if (!connected) {
      fd_set writable;
      FD_ZERO(&writable);
      FD_SET(handle, &writable);
      struct timeval tv;
      tv.tv_sec = timeoutMs / 1000;
      tv.tv_usec = (timeoutMs % 1000) * 1000;
      if (select((int)handle + 1, nullptr, &writable, nullptr, &tv) > 0) {
        int error = 0;
        socklen_t length = sizeof(error);
        if (getsockopt(handle, SOL_SOCKET, SO_ERROR, (char *)&error, &length) == 0)
          connected = (error == 0);
      }
    }

    if (connected) {
      struct sockaddr_in *address = (struct sockaddr_in *)entry->ai_addr;
      resolved = IPAddress((uint32_t)address->sin_addr.s_addr);
      break;
    }

    WIFILT_CLOSE_SOCKET(handle);
    handle = WIFILT_INVALID_SOCKET;
  }

  freeaddrinfo(results);
  return handle;
}

}  // namespace

// ---------------------------------------------------------------------------
// WiFiClient
// ---------------------------------------------------------------------------

WiFiClient::WiFiClient() {}
WiFiClient::WiFiClient(std::shared_ptr<SocketHandle> handle)
    : handle(std::move(handle)) {}

int WiFiClient::connect(IPAddress ip, uint16_t port) {
  return connect(ip, port, 3000);
}

int WiFiClient::connect(const char *host, uint16_t port) {
  return connect(host, port, 3000);
}

int WiFiClient::connect(IPAddress ip, uint16_t port, int32_t timeoutMs) {
  char literal[16];
  snprintf(literal, sizeof(literal), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
  return connect(literal, port, timeoutMs);
}

int WiFiClient::connect(const char *host, uint16_t port, int32_t timeoutMs) {
  stop();

  IPAddress resolved;
  wifilt_socket_t socket = connectTo(host, port, timeoutMs, resolved);
  if (socket == WIFILT_INVALID_SOCKET) return 0;

  handle = std::make_shared<SocketHandle>(socket);
  handle->remote = resolved;
  handle->remotePort = port;
  return 1;
}

size_t WiFiClient::write(uint8_t value) { return write(&value, 1); }

size_t WiFiClient::write(const uint8_t *buffer, size_t size) {
  if (!handle || handle->socket == WIFILT_INVALID_SOCKET || !buffer || !size)
    return 0;

  size_t sent = 0;
  while (sent < size) {
    int chunk = ::send(handle->socket, (const char *)buffer + sent,
                       (int)(size - sent), 0);
    if (chunk > 0) {
      sent += (size_t)chunk;
      continue;
    }
    if (chunk < 0 && WIFILT_WOULD_BLOCK()) {
      // The socket is non-blocking so the loop keeps turning. Wait briefly for
      // room rather than dropping the tail, which would corrupt a WebSocket
      // frame mid-flight.
      fd_set writable;
      FD_ZERO(&writable);
      FD_SET(handle->socket, &writable);
      struct timeval tv;
      tv.tv_sec = 0;
      tv.tv_usec = 50 * 1000;
      if (select((int)handle->socket + 1, nullptr, &writable, nullptr, &tv) > 0)
        continue;
      break;
    }
    handle->peerClosed = true;
    break;
  }
  return sent;
}

int WiFiClient::available() {
  if (!handle || handle->socket == WIFILT_INVALID_SOCKET) return 0;

  int pending = handle->peeked >= 0 ? 1 : 0;

  char probe[1];
  int peeked = ::recv(handle->socket, probe, sizeof(probe), MSG_PEEK);
  if (peeked > 0) return pending + 1;
  if (peeked == 0) handle->peerClosed = true;
  else if (!WIFILT_WOULD_BLOCK()) handle->peerClosed = true;

  return pending;
}

int WiFiClient::read() {
  if (!handle) return -1;
  if (handle->peeked >= 0) {
    int value = handle->peeked;
    handle->peeked = -1;
    return value;
  }
  uint8_t byte;
  int got = read(&byte, 1);
  return got == 1 ? byte : -1;
}

int WiFiClient::read(uint8_t *buffer, size_t size) {
  if (!handle || handle->socket == WIFILT_INVALID_SOCKET || !buffer || !size)
    return -1;

  size_t offset = 0;
  if (handle->peeked >= 0) {
    buffer[0] = (uint8_t)handle->peeked;
    handle->peeked = -1;
    offset = 1;
    if (size == 1) return 1;
  }

  int got = ::recv(handle->socket, (char *)buffer + offset,
                   (int)(size - offset), 0);
  if (got > 0) return (int)(offset + (size_t)got);
  if (got == 0) handle->peerClosed = true;
  else if (!WIFILT_WOULD_BLOCK()) handle->peerClosed = true;

  return offset > 0 ? (int)offset : (got == 0 ? 0 : -1);
}

int WiFiClient::peek() {
  if (!handle) return -1;
  if (handle->peeked < 0) handle->peeked = read();
  return handle->peeked;
}

void WiFiClient::flush() {
  // Nothing is buffered on our side: write() pushes straight to the socket.
}

void WiFiClient::stop() {
  if (handle) handle->close();
  handle.reset();
}

uint8_t WiFiClient::connected() {
  if (!handle || handle->socket == WIFILT_INVALID_SOCKET) return 0;
  // Unread data keeps the client "connected" even after the peer hung up, so
  // the sketch's drain loops can finish the last frame.
  if (available() > 0) return 1;
  return handle->peerClosed ? 0 : 1;
}

WiFiClient::operator bool() { return connected() != 0; }

void WiFiClient::setNoDelay(bool noDelay) {
  if (handle) nativeSocketSetNoDelay(handle->socket, noDelay);
}

void WiFiClient::setTimeout(uint32_t seconds) {
  Stream::setTimeout((unsigned long)seconds * 1000UL);
}

int WiFiClient::fd() const {
  return handle ? (int)handle->socket : -1;
}

IPAddress WiFiClient::remoteIP() const {
  return handle ? handle->remote : IPAddress();
}

uint16_t WiFiClient::remotePort() const {
  return handle ? handle->remotePort : 0;
}

bool WiFiClient::operator==(const WiFiClient &other) const {
  return handle == other.handle;
}

// ---------------------------------------------------------------------------
// WiFiServer
// ---------------------------------------------------------------------------

WiFiServer::WiFiServer(uint16_t port, uint8_t maxClients)
    : port(port), maxClients(maxClients) {}

WiFiServer::~WiFiServer() { end(); }

void WiFiServer::begin(uint16_t newPort) {
  if (newPort) port = newPort;
  end();

  // A listener that fails to bind MUST be loud. The Arduino API returns void,
  // so the sketch prints "web server started" either way; staying silent here
  // produced a daemon that logged a healthy startup while answering nothing.
  // The same failure on port 80 -- already taken, or no CAP_NET_BIND_SERVICE --
  // is the one that must never be mistaken for success, because falling back to
  // another port changes the origin and hides the operator's QSO log.
  listener = ::socket(AF_INET, SOCK_STREAM, 0);
  if (listener == WIFILT_INVALID_SOCKET) {
    fprintf(stderr, "WIFILT | port %u: cannot create socket (%s)\n",
            (unsigned)port, nativeSocketErrorText());
    return;
  }

  int reuse = 1;
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuse,
             sizeof(reuse));

  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_ANY);
  address.sin_port = htons(port);

  if (::bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0) {
    const bool denied = nativeSocketErrorWasPermission();
    const bool taken = nativeSocketErrorWasInUse();
    fprintf(stderr, "WIFILT | port %u: BIND FAILED -- %s\n", (unsigned)port,
            nativeSocketErrorText());
    if (denied && port < 1024) {
#ifdef _WIN32
      fprintf(stderr, "WIFILT |   ports below 1024 need an elevated process\n");
#else
      fprintf(stderr,
              "WIFILT |   ports below 1024 need root, or:\n"
              "WIFILT |   sudo setcap cap_net_bind_service=+ep <path to wifilt>\n");
#endif
    }
    if (taken)
      fprintf(stderr, "WIFILT |   another process is already on port %u\n",
              (unsigned)port);
    WIFILT_CLOSE_SOCKET(listener);
    listener = WIFILT_INVALID_SOCKET;
    return;
  }

  if (::listen(listener, maxClients) != 0) {
    fprintf(stderr, "WIFILT | port %u: listen failed (%s)\n", (unsigned)port,
            nativeSocketErrorText());
    WIFILT_CLOSE_SOCKET(listener);
    listener = WIFILT_INVALID_SOCKET;
    return;
  }

  nativeSocketSetNonBlocking(listener, true);
}

void WiFiServer::end() {
  if (listener != WIFILT_INVALID_SOCKET) {
    WIFILT_CLOSE_SOCKET(listener);
    listener = WIFILT_INVALID_SOCKET;
  }
}

void WiFiServer::stop() { end(); }
void WiFiServer::close() { end(); }
void WiFiServer::setNoDelay(bool value) { noDelay = value; }

WiFiClient WiFiServer::available() {
  if (listener == WIFILT_INVALID_SOCKET) return WiFiClient();

  struct sockaddr_in peer;
  socklen_t length = sizeof(peer);
  wifilt_socket_t accepted =
      ::accept(listener, (struct sockaddr *)&peer, &length);
  if (accepted == WIFILT_INVALID_SOCKET) return WiFiClient();

  nativeSocketSetNonBlocking(accepted, true);
  if (noDelay) nativeSocketSetNoDelay(accepted, true);

  auto handle = std::make_shared<SocketHandle>(accepted);
  handle->remote = IPAddress((uint32_t)peer.sin_addr.s_addr);
  handle->remotePort = ntohs(peer.sin_port);
  return WiFiClient(handle);
}

WiFiClient WiFiServer::accept() { return available(); }

bool WiFiServer::hasClient() {
  if (listener == WIFILT_INVALID_SOCKET) return false;
  fd_set readable;
  FD_ZERO(&readable);
  FD_SET(listener, &readable);
  struct timeval tv = {0, 0};
  return select((int)listener + 1, &readable, nullptr, nullptr, &tv) > 0;
}

// ---------------------------------------------------------------------------
// WiFiClass
// ---------------------------------------------------------------------------

namespace {

// First non-loopback IPv4 address, with its MAC. This is what the operator
// types into a browser, and what SETUP shows.
bool primaryInterface(IPAddress *address, uint8_t mac[6]) {
  bool found = false;

#ifdef _WIN32
  ULONG size = 15 * 1024;
  IP_ADAPTER_ADDRESSES *adapters = (IP_ADAPTER_ADDRESSES *)malloc(size);
  if (!adapters) return false;

  if (GetAdaptersAddresses(AF_INET, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST |
                           GAA_FLAG_SKIP_DNS_SERVER, nullptr, adapters, &size) == NO_ERROR) {
    for (IP_ADAPTER_ADDRESSES *a = adapters; a && !found; a = a->Next) {
      if (a->OperStatus != IfOperStatusUp) continue;
      if (a->IfType == IF_TYPE_SOFTWARE_LOOPBACK) continue;
      for (IP_ADAPTER_UNICAST_ADDRESS *u = a->FirstUnicastAddress; u; u = u->Next) {
        if (u->Address.lpSockaddr->sa_family != AF_INET) continue;
        struct sockaddr_in *in = (struct sockaddr_in *)u->Address.lpSockaddr;
        if (address) *address = IPAddress((uint32_t)in->sin_addr.s_addr);
        if (mac && a->PhysicalAddressLength >= 6)
          memcpy(mac, a->PhysicalAddress, 6);
        found = true;
        break;
      }
    }
  }
  free(adapters);
#else
  struct ifaddrs *interfaces = nullptr;
  if (getifaddrs(&interfaces) != 0) return false;

  for (struct ifaddrs *entry = interfaces; entry; entry = entry->ifa_next) {
    if (!entry->ifa_addr) continue;
    if (entry->ifa_flags & IFF_LOOPBACK) continue;
    if (!(entry->ifa_flags & IFF_UP)) continue;
    if (entry->ifa_addr->sa_family != AF_INET) continue;

    struct sockaddr_in *in = (struct sockaddr_in *)entry->ifa_addr;
    if (address) *address = IPAddress((uint32_t)in->sin_addr.s_addr);

    // The hardware address lives on a second ifaddrs entry for the same
    // interface name -- AF_PACKET on Linux, AF_LINK on the BSDs and macOS.
  #if defined(__linux__)
    if (mac) {
      for (struct ifaddrs *hw = interfaces; hw; hw = hw->ifa_next) {
        if (!hw->ifa_addr || hw->ifa_addr->sa_family != AF_PACKET) continue;
        if (strcmp(hw->ifa_name, entry->ifa_name) != 0) continue;
        struct sockaddr_ll *ll = (struct sockaddr_ll *)hw->ifa_addr;
        if (ll->sll_halen >= 6) memcpy(mac, ll->sll_addr, 6);
        break;
      }
    }
  #elif defined(__APPLE__)
    if (mac) {
      for (struct ifaddrs *hw = interfaces; hw; hw = hw->ifa_next) {
        if (!hw->ifa_addr || hw->ifa_addr->sa_family != AF_LINK) continue;
        if (strcmp(hw->ifa_name, entry->ifa_name) != 0) continue;
        struct sockaddr_dl *dl = (struct sockaddr_dl *)hw->ifa_addr;
        if (dl->sdl_alen >= 6) memcpy(mac, LLADDR(dl), 6);
        break;
      }
    }
  #endif

    found = true;
    break;
  }
  freeifaddrs(interfaces);
#endif

  return found;
}

String formatMac(const uint8_t mac[6]) {
  char text[18];
  snprintf(text, sizeof(text), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1],
           mac[2], mac[3], mac[4], mac[5]);
  return String(text);
}

}  // namespace

// --- provisioning: inert -----------------------------------------------------

wl_status_t WiFiClass::begin(const char *, const char *, int32_t,
                             const uint8_t *, bool) {
  return WL_CONNECTED;
}
bool WiFiClass::mode(wifi_mode_t) { return true; }
bool WiFiClass::disconnect(bool, bool) { return true; }
bool WiFiClass::reconnect() { return true; }
bool WiFiClass::setSleep(bool) { return true; }
bool WiFiClass::softAP(const char *, const char *, int, int, int) {
  // AP mode cannot exist here; APmode is forced false at startup so the sketch
  // never reaches this, and SETUP hides the captive-portal step entirely.
  return false;
}
int16_t WiFiClass::scanNetworks(bool, bool, bool, uint32_t) { return 0; }
void    WiFiClass::scanDelete() {}

String   WiFiClass::SSID(uint8_t) { return String(); }
int32_t  WiFiClass::RSSI(uint8_t) { return 0; }
int32_t  WiFiClass::channel(uint8_t) { return 0; }
uint8_t *WiFiClass::BSSID(uint8_t) { return bssid; }
uint8_t  WiFiClass::encryptionType(uint8_t) { return 0; }

bool WiFiClass::setHostname(const char *value) {
  hostname = value ? value : "";
  return true;
}

const char *WiFiClass::getHostname() { return hostname.c_str(); }

// --- state: answered from the host ------------------------------------------

wl_status_t WiFiClass::status() {
  // The OS owns the link. Reporting anything but CONNECTED would send the
  // sketch's reconnect state machine chasing a network it does not manage.
  return WL_CONNECTED;
}

IPAddress WiFiClass::localIP() {
  IPAddress address;
  primaryInterface(&address, nullptr);
  return address;
}

IPAddress WiFiClass::softAPIP() { return IPAddress(); }
IPAddress WiFiClass::gatewayIP() { return IPAddress(); }
IPAddress WiFiClass::subnetMask() { return IPAddress(255, 255, 255, 0); }

String WiFiClass::SSID() { return String(); }

String WiFiClass::macAddress() {
  uint8_t mac[6] = {0, 0, 0, 0, 0, 0};
  primaryInterface(nullptr, mac);
  return formatMac(mac);
}

String WiFiClass::softAPmacAddress() { return macAddress(); }

// No radio, so no signal strength. Zero rather than a plausible-looking -50,
// which would show up in SETUP as a fabricated reading.
int8_t  WiFiClass::RSSI() { return 0; }
int32_t WiFiClass::channel() { return 0; }

uint8_t *WiFiClass::BSSID() { return bssid; }

int WiFiClass::hostByName(const char *name, IPAddress &result) {
  if (!name || !*name) return 0;

  struct addrinfo hints;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_STREAM;

  struct addrinfo *results = nullptr;
  if (getaddrinfo(name, nullptr, &hints, &results) != 0 || !results) return 0;

  struct sockaddr_in *address = (struct sockaddr_in *)results->ai_addr;
  result = IPAddress((uint32_t)address->sin_addr.s_addr);
  freeaddrinfo(results);
  return 1;
}
