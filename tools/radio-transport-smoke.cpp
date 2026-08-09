#include <cassert>
#include <cstring>
#include "../radio_transport.h"

int main() {
  const RadioTransport transports[] = {RADIO_LAN, RADIO_TRXNET, RADIO_CIV};
  for (uint8_t slot = 0; slot < 3; ++slot) {
    for (RadioTransport transport : transports) {
      assert(radioHasCapability(slot, transport, RADIO_CAP_FREQUENCY));
      assert(radioHasCapability(slot, transport, RADIO_CAP_MODE));
      assert(radioHasCapability(slot, transport, RADIO_CAP_TUNE));
      // LAN is fully capable in any slot: the JS8 audio path follows the LAN
      // radio wherever the operator put it. Serial CI-V stays full-CAT only as
      // TRX1, TrxNet is always limited.
      assert(radioHasCapability(slot, transport, RADIO_CAP_FULL_CAT)
             == (transport == RADIO_LAN || (slot == 0 && transport == RADIO_CIV)));
      assert(radioHasCapability(slot, transport, RADIO_CAP_AUDIO)
             == (transport == RADIO_LAN));
    }
  }

  assert(radioTransportFromName("LAN", RADIO_TRXNET) == RADIO_LAN);
  assert(radioTransportFromName("trxnet", RADIO_LAN) == RADIO_TRXNET);
  assert(radioTransportFromName("CI-V", RADIO_LAN) == RADIO_CIV);
  assert(std::strcmp(radioTransportName(RADIO_LAN), "lan") == 0);
  assert(std::strcmp(radioTransportName(RADIO_TRXNET), "trxnet") == 0);
  assert(std::strcmp(radioTransportName(RADIO_CIV), "civ") == 0);

  assert(radioLanLocalControlPort(0) == 50001);
  assert(radioLanLocalControlPort(1) == 50011);
  assert(radioLanLocalControlPort(2) == 50021);
  return 0;
}
