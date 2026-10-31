// trxnet_link.h -- local-trx's own TrxNet node ("LTX.<netId>") for driving a
// rig through a TrxNet device instead of hamlib + DTR/RTS: wifilt still only
// sees the fake ICOM-LAN radio, the audio still comes from this PC's sound
// card, and CAT / CW text / PTT go to the device picked in the wizard (an OI3
// keyer, which talks CI-V to the radio and owns its key and PTT lines).
//
//   cat.backend "trxnet"        /hz /mode in -> TrxnetRigBackend; /s-hz /s-mode out
//   keying.cwBackend "trxnet"   CI-V 0x17 and wifilt's FSK text -> /s-cw (CON)
//   keying.pttBackend "trxnet"  every PTT -> /s-ptt lease, /ptt confirms
//
// Not the same node as TrxnetPeer (trxnet_peer.h): that one impersonates an
// OI3 on loopback so wifilt's FSK output has somewhere to go; this one is a
// commander on the real network. Separate sockets, separate names.
//
// Binds 0.0.0.0:<localPort>, never a specific IP -- a specific-IP bind does
// not receive broadcasts on Linux (trxnet_udp.h), and discovery is broadcasts.
// localPort 5684 beside a native wifilt that already holds 5683 here; see
// TrxnetConfig and TrxNet INTEGRATION.md 10b.
//
// Main loop only, except setPtt(), which KeyRunner's thread also calls.
#pragma once

#include <atomic>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include <TrxNet.h>

#include "config.h"
#include "trxnet_ptt.h"
#include "trxnet_rig.h"
#include "trxnet_udp.h"

namespace LocalTrx {

class TrxnetLink {
 public:
  explicit TrxnetLink(const TrxnetConfig &config);
  ~TrxnetLink();   // a keyed PTT is released before the socket goes

  bool begin(std::string *error);
  void poll();

  // The wizard's Scan button (TrxNet::probe(), 1.08).
  void probe() { net_.probe(); }
  // The wizard's own instance has no peer until the operator picks one.
  void setPeer(const std::string &name) { peer_ = name; }
  const std::string &peer() const { return peer_; }
  const std::string &name() const { return deviceName_; }

  // cat.backend "trxnet": the device's /hz /mode feed it, its queued
  // commands go out from poll().
  void attachRig(TrxnetRigBackend *rig) { rig_ = rig; }

  // CW or FSK text, keyed by the device in whatever mode it is in. Gathered
  // for CwCoalescer::kGatherMs first. false = the device is not on the network.
  bool sendText(const std::string &text);
  void abortText();

  // Any thread.
  void setPtt(bool on) { pttWant_ = on; }
  bool pttWanted() const { return pttWant_.load(); }
  bool pttConfirmed() const { return lease_.keyedByDevice(); }

  bool peerPresent() const;

  // What the wizard's scan shows: every device that announced itself, plus
  // the /hz /mode /ptt it last published, if any.
  struct PeerInfo {
    std::string name;
    std::string ip;
    uint16_t port = 0;
    bool haveHz = false;
    uint32_t hz = 0;
    bool haveMode = false;
    uint8_t mode = 0;
    int ptt = -1;   // -1 = never published /ptt
  };
  std::vector<PeerInfo> peers() const;

 private:
  struct Observed {
    bool haveHz = false;
    uint32_t hz = 0;
    bool haveMode = false;
    uint8_t mode = 0;
    int ptt = -1;
  };

  // TrxNetCallback/TrxTopicCallback carry no user data -- one live instance
  // stands in for "this", as in trxnet_peer.cpp. The wizard's scanner and
  // the running link never exist in the same process at once (Configure vs
  // Run, webui_server.h).
  static void onAnyTopic(const char *from, const char *path, const uint8_t *data, size_t len);

  void pollPtt(uint32_t now);
  void pollPresence(uint32_t now);
  void sendPtt(uint8_t value);

  TrxnetConfig config_;
  std::string deviceName_;
  std::string peer_;
  TrxNetUdp udp_;
  TrxNet net_;
  TrxnetRigBackend *rig_ = nullptr;

  PttLease lease_;
  CwCoalescer cw_;
  std::atomic<bool> pttWant_{false};
  bool pttUnreachableLogged_ = false;

  std::map<std::string, Observed> observed_;
  bool peerWasPresent_ = false;
  uint32_t nextPresenceMs_ = 0;
  bool started_ = false;
};

}  // namespace LocalTrx
