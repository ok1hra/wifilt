// trxnet_peer.h -- minimal TrxNet peer emulation for FSK (bod 15).
//
// wifilt.ino's FSK path never reaches the ICOM-LAN/CI-V channel at all (see
// docs/local-trx-implementace.md bod 15) -- it only ever leaves as a TrxNet
// "/s-cw" message to a peer named "OI3.<netId>" [wifilt.ino:4012-4016,
// 7679-7692]. local-trx becomes that peer: registers under the same name,
// subscribes to "/s-cw", and keys FSK through the SAME KeyRunner CW-over-
// CI-V uses (bod 7: CW and FSK are mode-exclusive and share one physical
// key line).
//
// Reuses $(TRXNET_DIR)/TrxNet.cpp unmodified via source recompilation (bod
// 12/15's pattern for icom_lan_wire.h) -- zero diff in the TrxNet library
// itself.
#pragma once

#include <cstdint>
#include <string>

#include <TrxNet.h>

#include "key_runner.h"
#include "trxnet_udp.h"

namespace LocalTrx {

class TrxnetPeer {
 public:
  // fskNetId matches wifilt's own config (config.keying.fskNetId here,
  // g_lcFskNetId there) -- the operator sets both to the same value, exactly
  // parallel to typing local-trx's IP into wifilt's ICOM-LAN field.
  TrxnetPeer(std::string listenIp, uint8_t fskNetId, KeyRunner &keyer);

  bool begin(std::string *error);
  void poll();   // calls TrxNet::loop()

 private:
  // TrxNetCallback is a plain function pointer with no user-data slot, so a
  // static trampoline + a single live-instance pointer stands in for "this".
  // local-trx only ever constructs one TrxnetPeer per process (main.cpp) --
  // asserted, not just assumed, in the .cpp.
  static void onSCw(const char *from, const uint8_t *data, size_t len);

  std::string deviceName_;   // "OI3.<hex fskNetId>"
  TrxNetUdp udp_;
  TrxNet net_;
  KeyRunner &keyer_;
};

}  // namespace LocalTrx
