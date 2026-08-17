// Captive-portal DNS server -- permanently inert on the native build.
//
// On the box this answers every DNS query with the SoftAP address so a phone
// joining WIFILT-AP lands on SETUP. A PC never runs SoftAP: the OS owns the
// network, WiFiClass::softAP() returns false, and SETUP hides the whole
// provisioning step via caps.wifi. Binding UDP 53 would also need root.
//
// Kept as a no-op class rather than removed so the sketch source stays
// identical for both targets.
#pragma once

#include "Arduino.h"

class DNSServer {
public:
  bool start(uint16_t port, const String &domainName, const IPAddress &resolvedIP) {
    (void)port; (void)domainName; (void)resolvedIP;
    return false;
  }
  void stop() {}
  void processNextRequest() {}
  void setErrorReplyCode(int code) { (void)code; }
  void setTTL(uint32_t ttl) { (void)ttl; }
};
