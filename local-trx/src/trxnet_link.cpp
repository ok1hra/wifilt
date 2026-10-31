#include "trxnet_link.h"

#include <cstdio>

#include <Arduino.h>   // millis() -- the same clock TrxNet.cpp runs its timers on

namespace LocalTrx {

namespace {

TrxnetLink *g_link = nullptr;

std::string makeDeviceName(uint8_t netId) {
  char buf[TRXNET_MAX_DEVICE_NAME];
  std::snprintf(buf, sizeof(buf), "LTX.%02x", netId);
  return buf;
}

uint32_t readLe32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

void writeLe32(uint32_t v, uint8_t *p) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  p[2] = (uint8_t)(v >> 16);
  p[3] = (uint8_t)(v >> 24);
}

}  // namespace

TrxnetLink::TrxnetLink(const TrxnetConfig &config)
    : config_(config),
      deviceName_(makeDeviceName(config.netId)),
      peer_(config.peer),
      udp_(std::string()),   // INADDR_ANY -- see the header
      net_(udp_, config.localPort) {
  if (g_link) {
    std::fprintf(stderr,
                 "trxnet: a TrxnetLink already exists in this process -- the static callback "
                 "trampoline supports exactly one\n");
  }
  g_link = this;
}

TrxnetLink::~TrxnetLink() {
  if (started_ && (pttWant_.load() || lease_.keyedByDevice())) {
    // Nothing will renew the lease after this; the device would unkey on its
    // own within 1.5 s, this just does not make it wait.
    for (int i = 0; i < 3; i++) sendPtt(0);
    std::printf("[trxnet] PTT released on shutdown\n");
  }
  if (g_link == this) g_link = nullptr;
}

bool TrxnetLink::begin(std::string *error) {
  // TrxNet::begin() reports nothing; bind the socket first so a port clash
  // is an error here instead of a silently deaf node. TrxNet's own
  // udp.begin() then finds it already bound (TrxNetUdp::begin is idempotent).
  if (!udp_.begin(config_.localPort)) {
    if (error) *error = "trxnet: cannot bind UDP port " + std::to_string(config_.localPort);
    return false;
  }
  net_.setPort(config_.localPort);
  net_.setDiscoveryPort(config_.networkPort);
  net_.onAnyTopic(&TrxnetLink::onAnyTopic);
  net_.begin(deviceName_.c_str());
  started_ = true;
  std::printf("[trxnet] '%s' up on port %u (network port %u)%s%s\n", deviceName_.c_str(),
              config_.localPort, config_.networkPort, peer_.empty() ? "" : ", device ",
              peer_.c_str());
  std::fflush(stdout);
  return true;
}

void TrxnetLink::onAnyTopic(const char *from, const char *path, const uint8_t *data, size_t len) {
  TrxnetLink *self = g_link;
  if (!self || !from || !from[0]) return;   // not discovered yet -- name unknown
  std::string name(from);
  std::string topic(path);
  Observed &o = self->observed_[name];
  const bool fromPeer = name == self->peer_;

  if (topic == "/hz" && len >= 4) {
    o.hz = readLe32(data);
    o.haveHz = true;
    if (fromPeer && self->rig_) self->rig_->onPeerHz(o.hz);
  } else if (topic == "/mode" && len >= 1) {
    o.mode = data[0];
    o.haveMode = true;
    if (fromPeer && self->rig_) self->rig_->onPeerMode(o.mode);
  } else if (topic == "/ptt" && len >= 1) {
    const int was = o.ptt;
    o.ptt = data[0] ? 1 : 0;
    if (fromPeer) {
      self->lease_.onEcho(data[0] != 0);
      if (o.ptt != was) {
        std::printf("[trxnet] <- /ptt %d from %s\n", o.ptt, from);
        std::fflush(stdout);
      }
    }
  }
}

void TrxnetLink::poll() {
  if (!started_) return;
  net_.loop();
  const uint32_t now = millis();

  if (rig_ && !peer_.empty()) {
    uint32_t hz;
    if (rig_->takeFreqCommand(&hz)) {
      uint8_t payload[4];
      writeLe32(hz, payload);
      net_.publishTo(peer_.c_str(), "/s-hz", payload, sizeof(payload), TRX_NON);
    }
    uint8_t mode;
    if (rig_->takeModeCommand(&mode)) {
      net_.publishTo(peer_.c_str(), "/s-mode", &mode, 1, TRX_NON);
    }
  }

  std::string chunk;
  while (cw_.take(&chunk, now)) {
    if (!net_.publishTo(peer_.c_str(), "/s-cw", reinterpret_cast<const uint8_t *>(chunk.data()),
                        chunk.size(), TRX_CON)) {
      std::fprintf(stderr, "warning: trxnet: /s-cw to %s not sent (not on the network, or "
                           "the CON queue is full): \"%s\"\n",
                   peer_.c_str(), chunk.c_str());
    } else {
      std::printf("[trxnet] -> /s-cw \"%s\" to %s\n", chunk.c_str(), peer_.c_str());
    }
  }

  pollPtt(now);
  pollPresence(now);
}

bool TrxnetLink::sendText(const std::string &text) {
  if (peer_.empty() || !peerPresent()) return false;
  cw_.add(text, millis());
  return true;
}

void TrxnetLink::abortText() {
  cw_.clear();
  if (peer_.empty()) return;
  const uint8_t stop = 0xFF;   // INTEGRATION.md 7: what 705 sends and OI3 acts on
  net_.publishTo(peer_.c_str(), "/s-cw", &stop, 1, TRX_CON);
}

void TrxnetLink::sendPtt(uint8_t value) {
  // TRX_NON, never CON: a retransmitted "1" landing after the "0" would key
  // the radio again (INTEGRATION.md 7.3).
  bool sent = !peer_.empty() && net_.publishTo(peer_.c_str(), "/s-ptt", &value, 1, TRX_NON);
  if (!sent && value && !pttUnreachableLogged_) {
    pttUnreachableLogged_ = true;
    std::fprintf(stderr, "warning: trxnet: PTT wanted but %s is not on the network -- not keyed\n",
                 peer_.empty() ? "(no device picked)" : peer_.c_str());
  }
  if (sent) pttUnreachableLogged_ = false;
}

void TrxnetLink::pollPtt(uint32_t now) {
  switch (lease_.tick(pttWant_.load(), now)) {
    case PttLease::Send::On:
      sendPtt(1);
      break;
    case PttLease::Send::Off:
      sendPtt(0);
      break;
    case PttLease::Send::None:
      break;
  }
  if (lease_.takeEchoMissing()) {
    if (lease_.refused()) {
      std::fprintf(stderr, "warning: trxnet: %s refused PTT (its interlock, or its own CW is keyed)\n",
                   peer_.c_str());
    } else {
      std::fprintf(stderr,
                   "warning: trxnet: no /ptt from %s within 1 s of keying -- its firmware has no "
                   "/s-ptt (OI3 needs FW 20261031+ on TrxNet 1.08), or it is not reachable\n",
                   peer_.c_str());
    }
  }
}

bool TrxnetLink::peerPresent() const {
  for (int i = 0; i < net_.peerCount(); i++) {
    const TrxPeer *p = net_.peer(i);
    if (p && peer_ == p->name) return true;
  }
  return false;
}

void TrxnetLink::pollPresence(uint32_t now) {
  if (peer_.empty() || (int32_t)(now - nextPresenceMs_) < 0) return;
  nextPresenceMs_ = now + 1000;
  bool present = peerPresent();
  if (present == peerWasPresent_) return;
  peerWasPresent_ = present;
  if (present) {
    std::printf("[trxnet] device %s joined\n", peer_.c_str());
  } else {
    std::fprintf(stderr, "warning: trxnet: device %s left the network (no announce for %lu s)\n",
                 peer_.c_str(), (unsigned long)(TRXNET_PEER_TIMEOUT_MS / 1000));
  }
  std::fflush(stdout);
}

std::vector<TrxnetLink::PeerInfo> TrxnetLink::peers() const {
  std::vector<PeerInfo> out;
  for (int i = 0; i < net_.peerCount(); i++) {
    const TrxPeer *p = net_.peer(i);
    if (!p) continue;
    PeerInfo info;
    info.name = p->name;
    char ip[16];
    std::snprintf(ip, sizeof(ip), "%u.%u.%u.%u", p->ip[0], p->ip[1], p->ip[2], p->ip[3]);
    info.ip = ip;
    info.port = p->port;
    auto it = observed_.find(info.name);
    if (it != observed_.end()) {
      info.haveHz = it->second.haveHz;
      info.hz = it->second.hz;
      info.haveMode = it->second.haveMode;
      info.mode = it->second.mode;
      info.ptt = it->second.ptt;
    }
    out.push_back(info);
  }
  return out;
}

}  // namespace LocalTrx
