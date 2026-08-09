#include "../../../icom_lan_audio_tx.h"

#include <cstdint>
#include <cstdio>
#include <cstring>

static bool payloadEquals(const uint8_t* packet, size_t length,
                          const uint8_t* expected, size_t expectedLength) {
  return packet != nullptr && length == 0x18 + expectedLength &&
         std::memcmp(packet + 0x18, expected, expectedLength) == 0;
}

int main() {
  bool ok = true;
  IcomLanAudioTx tx;
  tx.configure(0x11223344u, 0x55667788u);

  uint8_t audio[480];
  for (size_t i = 0; i < sizeof(audio); ++i) audio[i] = uint8_t(i);
  if (!tx.enqueue(audio, sizeof(audio)) || tx.queued() != sizeof(audio)) {
    std::fprintf(stderr, "audio queue rejected a valid prebuffer\n");
    ok = false;
  }
  if (!tx.arm(sizeof(audio), 1000)) {
    std::fprintf(stderr, "audio TX did not arm\n");
    ok = false;
  }

  const uint8_t* packet = nullptr;
  size_t length = 0;
  if (tx.poll(999, packet, length) != IcomLanAudioTx::WAITING) {
    std::fprintf(stderr, "audio packet emitted before its deadline\n");
    ok = false;
  }
  if (tx.poll(1000, packet, length) != IcomLanAudioTx::PACKET ||
      !payloadEquals(packet, length, audio, 160)) {
    std::fprintf(stderr, "first paced audio packet is wrong\n");
    ok = false;
  } else {
    const uint16_t tracked = uint16_t(packet[6]) | (uint16_t(packet[7]) << 8);
    const uint16_t audioSequence = (uint16_t(packet[0x12]) << 8) | packet[0x13];
    if (tracked != 1 || audioSequence != 0) {
      std::fprintf(stderr, "first audio sequence is wrong\n");
      ok = false;
    }
    tx.commitSend(true, 1000);
  }

  if (tx.poll(1020, packet, length) != IcomLanAudioTx::PACKET ||
      !payloadEquals(packet, length, audio + 160, 160)) {
    std::fprintf(stderr, "second paced audio packet is wrong\n");
    ok = false;
  } else {
    const uint16_t replaySequence =
        uint16_t(packet[6]) | (uint16_t(packet[7]) << 8);
    uint8_t original[0x18 + 160];
    std::memcpy(original, packet, length);
    tx.commitSend(true, 1020);

    size_t replayLength = 0;
    const uint8_t* replay = tx.replay(replaySequence, replayLength);
    if (replayLength != length || replay == nullptr ||
        std::memcmp(replay, original, length) != 0) {
      std::fprintf(stderr, "audio replay is not byte-identical\n");
      ok = false;
    }
  }

  if (tx.poll(1040, packet, length) != IcomLanAudioTx::PACKET ||
      !payloadEquals(packet, length, audio + 320, 160)) {
    std::fprintf(stderr, "third paced audio packet is wrong\n");
    ok = false;
  } else {
    tx.commitSend(true, 1040);
  }
  if (tx.poll(1189, packet, length) != IcomLanAudioTx::DRAINING ||
      tx.poll(1190, packet, length) != IcomLanAudioTx::DRAINED) {
    std::fprintf(stderr, "playout drain guard did not hold PTT for 150 ms\n");
    ok = false;
  }
  IcomLanAudioTx::Snapshot completed = tx.snapshot();
  if (completed.consumed != sizeof(audio) || completed.queued != 0 ||
      completed.maxLatenessMs != 0 || completed.fault != IcomLanAudioTx::FAULT_NONE) {
    std::fprintf(stderr, "completed TX snapshot is wrong\n");
    ok = false;
  }

  tx.reset();
  tx.configure(1, 2);
  if (!tx.enqueue(audio, 160) || !tx.arm(160, 2000) ||
      tx.poll(2000, packet, length) != IcomLanAudioTx::PACKET) {
    std::fprintf(stderr, "send-failure fixture did not reach packet state\n");
    ok = false;
  } else {
    tx.commitSend(false, 2000);
    if (tx.snapshot().fault != IcomLanAudioTx::FAULT_SEND) {
      std::fprintf(stderr, "local UDP send failure was silent\n");
      ok = false;
    }
  }

  tx.reset();
  tx.configure(1, 2);
  if (!tx.enqueue(audio, 160) || !tx.arm(160, 3000) ||
      tx.poll(3081, packet, length) != IcomLanAudioTx::FAULTED ||
      tx.snapshot().fault != IcomLanAudioTx::FAULT_DEADLINE) {
    std::fprintf(stderr, "irrecoverably late audio deadline was not faulted\n");
    ok = false;
  }

  tx.reset();
  tx.configure(1, 2);
  if (!tx.enqueue(audio, 80) || !tx.arm(160, 4000) ||
      tx.poll(4000, packet, length) != IcomLanAudioTx::FAULTED ||
      tx.snapshot().fault != IcomLanAudioTx::FAULT_UNDERRUN) {
    std::fprintf(stderr, "audio underrun was not faulted\n");
    ok = false;
  }

  if (!ok) return 1;
  std::puts("ICOM LAN AUDIO TX PASS");
  return 0;
}
