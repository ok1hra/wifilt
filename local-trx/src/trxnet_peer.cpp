#include "trxnet_peer.h"

#include <cstdio>

namespace LocalTrx {

namespace {

std::string makeDeviceName(uint8_t fskNetId) {
  char buf[TRXNET_MAX_DEVICE_NAME];
  std::snprintf(buf, sizeof(buf), "OI3.%02x", fskNetId);
  return buf;
}

// TrxNetCallback has no user-data slot (see trxnet_peer.h) -- one live
// instance stands in for "this". Not a design local-trx needs more than one
// of: a single process impersonates a single radio (bod 1) and a single FSK
// peer identity alongside it.
TrxnetPeer *g_instance = nullptr;

}  // namespace

TrxnetPeer::TrxnetPeer(std::string listenIp, uint8_t fskNetId, KeyRunner &keyer)
    : deviceName_(makeDeviceName(fskNetId)),
      udp_(std::move(listenIp)),
      net_(udp_),
      keyer_(keyer) {
  if (g_instance) {
    std::fprintf(stderr,
                 "trxnet_peer: a TrxnetPeer already exists in this process -- "
                 "the static callback trampoline supports exactly one\n");
  }
  g_instance = this;
}

void TrxnetPeer::onSCw(const char *from, const uint8_t *data, size_t len) {
  if (!g_instance) return;
  // wifilt.ino's own abort convention on this exact path: a single 0xFF byte
  // means "stop now", not text to key [wifilt.ino:4043-4045].
  if (len == 1 && data[0] == 0xFF) {
    std::printf("[oi3] <- abort from %s\n", from);
    g_instance->keyer_.abort();
    return;
  }
  std::string text(reinterpret_cast<const char *>(data), len);
  bool ok = g_instance->keyer_.sendFskText(text);
  std::printf("[oi3] <- /s-cw from %s: \"%s\" %s\n", from, text.c_str(),
              ok ? "queued" : "BUSY, dropped");
}

bool TrxnetPeer::begin(std::string *error) {
  // TrxNet::begin() has no return value/failure signal of its own -- it logs
  // internally and always proceeds (matches how wifilt.ino uses it, e.g.
  // "TRXNET| begin 705.01" unconditionally at startup). udp_.begin() inside
  // it is where a real bind failure would surface; nothing here to catch
  // beyond what IcomLanServer::begin() already demonstrates the pattern for.
  (void)error;
  net_.begin(deviceName_.c_str());
  net_.subscribe("/s-cw", &TrxnetPeer::onSCw);
  std::printf("[oi3] TrxNet peer '%s' up, listening for FSK on /s-cw\n", deviceName_.c_str());
  return true;
}

void TrxnetPeer::poll() { net_.loop(); }

}  // namespace LocalTrx
