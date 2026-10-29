// Native regression test for jtty_stream.h (the JTTY stream on TrxNet) and for
// IcomLanAudioTx::extend(), the radio-side half of AUD1 tx.extend (JTTY live
// entry). docs/jtty-implementace.md §6, §8.
//
//   g++ -std=c++11 -Wall -Wextra -o /tmp/jtty-stream-smoke tools/jtty-stream-smoke.cpp && /tmp/jtty-stream-smoke

#include <cassert>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include "../jtty_stream.h"
#include "../icom_lan_audio_tx.h"

struct Packet { std::string peer, topic; std::vector<uint8_t> data; };
static std::vector<Packet> wire;

static void capture(void*, const char* peer, const char* topic, const uint8_t* data, size_t len) {
  wire.push_back({peer, topic, std::vector<uint8_t>(data, data + len)});
}

static const uint8_t ON = 1, OFF = 0;
static int checks = 0;
#define CHECK(x) do { assert(x); checks++; } while (0)

static std::string rxText(const Packet& p) { return std::string(p.data.begin() + 6, p.data.end()); }
static std::string txText(const Packet& p) { return std::string(p.data.begin() + 1, p.data.end()); }

static void streamTests() {
  JttyStream s = {};
  uint32_t now = 1000;

  // Off by default: nothing recorded, nothing allocated.
  CHECK(jttyStreamSubscribe(s, "MON.01", &ON, 1, now) == RTTY_SUB_IGNORED);
  jttyStreamRx(s, 1, true, 1500, -5, "CQ", 2, now);
  CHECK(s.count == 0 && s.queue == nullptr);

  // On, nobody listening: still nothing kept.
  jttyStreamSetEnabled(s, true);
  jttyStreamRx(s, 1, true, 1500, -5, "CQ", 2, now);
  CHECK(s.count == 0 && s.queue == nullptr);

  CHECK(jttyStreamSubscribe(s, "", &ON, 1, now) == RTTY_SUB_IGNORED);
  CHECK(jttyStreamSubscribe(s, "MON.01", &ON, 1, now) == RTTY_SUB_ADDED);
  CHECK(jttyStreamSubscribe(s, "MON.01", &ON, 1, now) == RTTY_SUB_RENEWED);

  // One decoded frame: the header, then the text.
  jttyStreamRx(s, 7, false, 1512, -12, "CQ OK1HRA", 9, now);
  jttyStreamDrain(s, now, 4, capture, nullptr);
  CHECK(wire.size() == 1 && wire[0].topic == "/jtty-rx" && wire[0].peer == "MON.01");
  CHECK(wire[0].data[0] == 0 && wire[0].data[1] == 7 && wire[0].data[2] == 0);
  CHECK((wire[0].data[3] | (wire[0].data[4] << 8)) == 1512 && (int8_t)wire[0].data[5] == -12);
  CHECK(rxText(wire[0]) == "CQ OK1HRA");

  // An 80-character message in one update splits, EOM only on its last piece.
  wire.clear();
  std::string longText(80, 'A');
  jttyStreamRx(s, 8, true, 1400, 3, longText.c_str(), longText.size(), now);
  jttyStreamDrain(s, now, 4, capture, nullptr);
  CHECK(wire.size() == 2 && wire[0].data.size() == 64 && rxText(wire[0]).size() == 58);
  CHECK(wire[0].data[2] == 0 && wire[1].data[2] == 1);
  CHECK(rxText(wire[0]) + rxText(wire[1]) == longText);
  CHECK(wire[0].data[0] == 1 && wire[1].data[0] == 2);

  // An EOM with nothing new still reaches the listener, so it can close the message.
  wire.clear();
  jttyStreamRx(s, 9, true, 1400, 3, "", 0, now);
  jttyStreamDrain(s, now, 4, capture, nullptr);
  CHECK(wire.size() == 1 && wire[0].data.size() == 6 && wire[0].data[2] == 1);

  // TX: 63-byte pieces on their own seq, then the abort marker.
  wire.clear();
  std::string tx(100, 'B');
  jttyStreamTx(s, tx.c_str(), tx.size(), now);
  jttyStreamAbortTx(s, now);
  jttyStreamDrain(s, now, 8, capture, nullptr);
  CHECK(wire.size() == 3 && wire[0].topic == "/jtty-tx");
  CHECK(txText(wire[0]).size() == 63 && txText(wire[0]) + txText(wire[1]) == tx);
  CHECK(wire[0].data[0] == 0 && wire[1].data[0] == 1);
  CHECK(wire[2].data.size() == 2 && wire[2].data[1] == 0x00);

  // At most maxPackets per call; the rest waits for the next pass.
  wire.clear();
  for (int i = 0; i < 6; i++) jttyStreamRx(s, 10, false, 1500, 0, "X", 1, now);
  jttyStreamDrain(s, now, 4, capture, nullptr);
  CHECK(wire.size() == 4 && s.count == 2);
  jttyStreamDrain(s, now, 4, capture, nullptr);
  CHECK(wire.size() == 6 && s.count == 0);

  // A full queue drops, and the next packet's seq shows the gap.
  wire.clear();
  uint8_t before = s.seq[JTTY_STREAM_RX];
  for (int i = 0; i < JTTY_STREAM_QUEUE + 3; i++) jttyStreamRx(s, 11, false, 1500, 0, "Y", 1, now);
  CHECK(s.dropped == 3);
  jttyStreamDrain(s, now, 255, capture, nullptr);
  wire.clear();
  jttyStreamRx(s, 12, true, 1500, 0, "Z", 1, now);
  jttyStreamDrain(s, now, 4, capture, nullptr);
  CHECK(wire.size() == 1 && (uint8_t)(wire[0].data[0] - before) == JTTY_STREAM_QUEUE + 1);

  // Two listeners each get every packet.
  wire.clear();
  CHECK(jttyStreamSubscribe(s, "MON.02", &ON, 1, now) == RTTY_SUB_ADDED);
  jttyStreamTx(s, "TU", 2, now);
  jttyStreamDrain(s, now, 4, capture, nullptr);
  CHECK(wire.size() == 2 && wire[0].peer != wire[1].peer);

  // The lease lapses; the last one gone drops what was waiting.
  jttyStreamRx(s, 13, false, 1500, 0, "W", 1, now);
  now += JTTY_STREAM_LEASE_MS;
  CHECK(!jttyStreamActive(s, now) && s.count == 0);

  // Unsubscribe, and off forgets everything.
  CHECK(jttyStreamSubscribe(s, "MON.01", &ON, 1, now) == RTTY_SUB_ADDED);
  CHECK(jttyStreamSubscribe(s, "MON.01", &OFF, 1, now) == RTTY_SUB_REMOVED);
  CHECK(jttyStreamSubscribe(s, "MON.01", &ON, 1, now) == RTTY_SUB_ADDED);
  jttyStreamSetEnabled(s, false);
  CHECK(!jttyStreamActive(s, now));
  free(s.queue);
}

// Play out whatever is due, the way the audio task does.
static void playAll(IcomLanAudioTx& tx, uint32_t& now, int maxPolls) {
  for (int i = 0; i < maxPolls; i++) {
    const uint8_t* packet; size_t length;
    IcomLanAudioTx::PollResult r = tx.poll(now, packet, length);
    if (r == IcomLanAudioTx::PACKET) tx.commitSend(true, now);
    else if (r == IcomLanAudioTx::DRAINED || r == IcomLanAudioTx::FAULTED) return;
    now += 20;
  }
}

static void extendTests() {
  static IcomLanAudioTx tx;
  tx.reset();
  uint8_t block[480];
  memset(block, 0xFF, sizeof block);
  uint32_t now = 100;

  CHECK(!tx.extend(160));                       // nothing armed
  CHECK(tx.enqueue(block, 320));
  CHECK(tx.arm(320, now));
  CHECK(!tx.enqueue(block, 160));               // past the declared end: overflow
  tx.reset();

  CHECK(tx.enqueue(block, 320));
  CHECK(tx.arm(320, now));
  CHECK(!tx.extend(0));
  CHECK(tx.extend(160));                        // grows while playing
  CHECK(tx.snapshot().total == 480);
  CHECK(tx.enqueue(block, 160));                // now fits
  playAll(tx, now, 50);
  IcomLanAudioTx::Snapshot snap = tx.snapshot();
  CHECK(snap.fault == IcomLanAudioTx::FAULT_NONE && snap.consumed == 480 && snap.drained);
  CHECK(!tx.extend(160));                       // the end announced stands

  // Extended but never fed: the scheduler underruns instead of stalling.
  tx.reset();
  CHECK(tx.enqueue(block, 160));
  CHECK(tx.arm(160, now));
  CHECK(tx.extend(160));
  playAll(tx, now, 50);
  CHECK(tx.snapshot().fault == IcomLanAudioTx::FAULT_UNDERRUN);
}

int main() {
  streamTests();
  extendTests();
  printf("JTTY STREAM PASS %d/%d\n", checks, checks);
  return 0;
}
