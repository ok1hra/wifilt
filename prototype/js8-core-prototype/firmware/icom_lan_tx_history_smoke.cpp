#include "../../../icom_lan_tx_history.h"

#include <cstdint>
#include <cstdio>
#include <cstring>

static bool expectPacket(const IcomLanTxHistory<32, 4>& history,
                         uint16_t sequence,
                         const uint8_t* expected,
                         size_t expectedLength) {
  size_t length = 0;
  const uint8_t* packet = history.find(sequence, length);
  return packet != nullptr && length == expectedLength &&
         std::memcmp(packet, expected, expectedLength) == 0;
}

int main() {
  IcomLanTxHistory<32, 4> history;
  const uint8_t open[] = {0x16, 0x00, 0x01, 0x00, 0x05};
  const uint8_t readMode[] = {0x1b, 0x00, 0x02, 0x00, 0x04};
  const uint8_t readFrequency[] = {0x1b, 0x00, 0x03, 0x00, 0x03};

  if (!history.remember(1, open, sizeof(open)) ||
      !history.remember(2, readMode, sizeof(readMode)) ||
      !history.remember(3, readFrequency, sizeof(readFrequency))) {
    std::fprintf(stderr, "history rejected a valid tracked packet\n");
    return 1;
  }

  // The radio can request an older missing sequence after newer packets have
  // already been sent. It must get the byte-identical original packet back.
  if (!expectPacket(history, 2, readMode, sizeof(readMode))) {
    std::fprintf(stderr, "missing tracked sequence was not replayable\n");
    return 1;
  }

  const uint8_t later[] = {0x10, 0x00, 0x04, 0x00};
  history.remember(4, later, sizeof(later));
  history.remember(5, later, sizeof(later));
  if (history.find(1) != nullptr || history.find(2) == nullptr) {
    std::fprintf(stderr, "bounded history did not evict only the oldest entry\n");
    return 1;
  }

  history.clear();
  if (history.find(2) != nullptr) {
    std::fprintf(stderr, "history survived a channel reset\n");
    return 1;
  }

  std::puts("ICOM LAN TX HISTORY PASS");
  return 0;
}
