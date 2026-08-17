// mDNS responder interface.
//
// STAGE 1-4: these are no-ops, so the binary is reached by IP.
// STAGE 5 replaces the body with a real responder publishing wifilt.local plus
// _http._tcp. That is not cosmetic -- IndexedDB is scoped per origin, so
// http://wifilt.local is the only address at which an operator's QSO log,
// settings and localStorage survive the move from the box to the binary.
//
// Platform notes for stage 5: Linux normally has Avahi already holding UDP
// 5353, so the responder must bind with SO_REUSEADDR/SO_REUSEPORT and join the
// multicast group alongside it. Windows has no Bonjour by default. macOS has
// Bonjour built in and DNSServiceRegister is the native route.
#pragma once

#include "Arduino.h"

class MDNSResponder {
public:
  bool begin(const char *hostname);
  bool begin(const String &hostname) { return begin(hostname.c_str()); }
  void end();

  void setInstanceName(const String &name);
  void setInstanceName(const char *name) { setInstanceName(String(name)); }

  bool addService(const char *service, const char *protocol, uint16_t port);
  bool addService(const String &service, const String &protocol, uint16_t port) {
    return addService(service.c_str(), protocol.c_str(), port);
  }

  // True once a real responder is publishing. Stage 1-4 always reports false,
  // so nothing can mistake the stub for a working name.
  bool isPublishing() const { return publishing; }

private:
  String hostname;
  String instanceName;
  bool   publishing = false;
};

extern MDNSResponder MDNS;
