// Native regression test for rtty_stream.h -- the RTTY text stream on TrxNet.
//
//   g++ -std=c++11 -Wall -Wextra -o /tmp/rtty-stream-smoke tools/rtty-stream-smoke.cpp && /tmp/rtty-stream-smoke

#include <cassert>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include "../rtty_stream.h"

struct Packet { std::string peer, topic; std::vector<uint8_t> data; };
static std::vector<Packet> wire;

static void capture(void*, const char* peer, const char* topic, const uint8_t* data, size_t len) {
  wire.push_back({peer, topic, std::vector<uint8_t>(data, data + len)});
}

static const uint8_t ON = 1, OFF = 0;

static std::string text(const Packet& p) { return std::string(p.data.begin() + 1, p.data.end()); }

int main() {
  RttyStream s = {};
  uint32_t now = 1000;

  // Off by default: a subscription is not even recorded, and nothing buffers.
  assert(rttyStreamSubscribe(s, "MON.01", &ON, 1, now) == RTTY_SUB_IGNORED);
  rttyStreamAppend(s, RTTY_STREAM_RX1, "CQ", 2, now);
  assert(s.len[RTTY_STREAM_RX1] == 0 && s.buf[RTTY_STREAM_RX1] == nullptr);

  // On, but nobody listening: still nothing kept and nothing allocated.
  rttyStreamSetEnabled(s, true);
  rttyStreamAppend(s, RTTY_STREAM_RX1, "CQ", 2, now);
  assert(s.len[RTTY_STREAM_RX1] == 0 && s.buf[RTTY_STREAM_RX1] == nullptr);

  // A sender the peer table does not know has no address to answer to.
  assert(rttyStreamSubscribe(s, "", &ON, 1, now) == RTTY_SUB_IGNORED);
  assert(rttyStreamSubscribe(s, "MON.01", nullptr, 0, now) == RTTY_SUB_IGNORED);
  // Unsubscribing something never subscribed is harmless.
  assert(rttyStreamSubscribe(s, "MON.01", &OFF, 1, now) == RTTY_SUB_IGNORED);

  assert(rttyStreamSubscribe(s, "MON.01", &ON, 1, now) == RTTY_SUB_ADDED);
  assert(rttyStreamSubscribe(s, "MON.01", &ON, 1, now + 30000) == RTTY_SUB_RENEWED);

  // RX text goes out as [seq][ascii] to the subscriber, per topic.
  rttyStreamAppend(s, RTTY_STREAM_RX1, "CQ TEST", 7, now);
  rttyStreamAppend(s, RTTY_STREAM_RX2, "CQ TEXT", 7, now);
  rttyStreamDrain(s, now, 8, capture, nullptr);
  assert(wire.size() == 2);
  assert(wire[0].peer == "MON.01" && wire[0].topic == "/rtty1" && wire[0].data[0] == 0 && text(wire[0]) == "CQ TEST");
  assert(wire[1].topic == "/rtty2" && wire[1].data[0] == 0 && text(wire[1]) == "CQ TEXT");
  wire.clear();

  // seq counts per topic.
  rttyStreamAppend(s, RTTY_STREAM_RX1, "\r\nDE", 4, now);
  rttyStreamDrain(s, now, 8, capture, nullptr);
  assert(wire.size() == 1 && wire[0].data[0] == 1 && text(wire[0]) == "\r\nDE");
  wire.clear();

  // TX longer than a packet is split at 63 characters, never over 64 bytes.
  std::string longTx(150, 'R');
  rttyStreamAppend(s, RTTY_STREAM_TX, longTx.c_str(), longTx.size(), now);
  rttyStreamDrain(s, now, 2, capture, nullptr);            // budget: two packets per pass
  assert(wire.size() == 2);
  rttyStreamDrain(s, now, 2, capture, nullptr);
  assert(wire.size() == 3);
  assert(wire[0].data.size() == 64 && wire[1].data.size() == 64 && wire[2].data.size() == 1 + 24);
  assert(wire[0].data[0] == 0 && wire[1].data[0] == 1 && wire[2].data[0] == 2);
  assert(wire[0].topic == "/rtty-tx");
  wire.clear();

  // An abort comes after the text it cut short, as [seq][0x00].
  rttyStreamAppend(s, RTTY_STREAM_TX, "\r\nCQ CQ ", 8, now);
  rttyStreamAbortTx(s, now);
  rttyStreamDrain(s, now, 8, capture, nullptr);
  assert(wire.size() == 2);
  assert(text(wire[0]) == "\r\nCQ CQ " && wire[0].data[0] == 3);
  assert(wire[1].data.size() == 2 && wire[1].data[0] == 4 && wire[1].data[1] == 0x00);
  wire.clear();
  // NUL inside text is dropped, so 0x00 alone stays unambiguous.
  rttyStreamAppend(s, RTTY_STREAM_TX, "A\0B", 3, now);
  rttyStreamDrain(s, now, 8, capture, nullptr);
  assert(wire.size() == 1 && text(wire[0]) == "AB");
  wire.clear();

  // Overflow drops characters AND skips a seq, so the listener sees the gap.
  std::string flood(200, 'X');
  rttyStreamAppend(s, RTTY_STREAM_RX1, flood.c_str(), flood.size(), now);
  assert(s.len[RTTY_STREAM_RX1] == 128 && s.droppedChars == 72);
  rttyStreamDrain(s, now, 8, capture, nullptr);
  assert(wire.size() == 3 && wire[0].data[0] == 3);          // 2 was skipped
  wire.clear();

  // A second subscriber gets the same packets; the fifth is refused.
  assert(rttyStreamSubscribe(s, "MON.02", &ON, 1, now) == RTTY_SUB_ADDED);
  assert(rttyStreamSubscribe(s, "MON.03", &ON, 1, now) == RTTY_SUB_ADDED);
  assert(rttyStreamSubscribe(s, "MON.04", &ON, 1, now) == RTTY_SUB_ADDED);
  assert(rttyStreamSubscribe(s, "MON.05", &ON, 1, now) == RTTY_SUB_FULL && s.refused == 1);
  rttyStreamAppend(s, RTTY_STREAM_RX2, "K", 1, now);
  rttyStreamDrain(s, now, 8, capture, nullptr);
  assert(wire.size() == 4 && wire[3].peer == "MON.04" && wire[0].data == wire[3].data);
  wire.clear();

  // Unsubscribe frees the slot.
  assert(rttyStreamSubscribe(s, "MON.04", &OFF, 1, now) == RTTY_SUB_REMOVED);
  assert(rttyStreamSubscribe(s, "MON.05", &ON, 1, now) == RTTY_SUB_ADDED);

  // Lease: MON.01 renewed at +30 s, the rest subscribed at `now`. At +90 s the
  // others lapse; MON.01 lasts until +120 s.
  now += 90000;
  assert(rttyStreamActive(s, now));
  rttyStreamAppend(s, RTTY_STREAM_RX1, "Z", 1, now);
  rttyStreamDrain(s, now, 8, capture, nullptr);
  assert(wire.size() == 1 && wire[0].peer == "MON.01");
  wire.clear();
  now += 30000;
  assert(!rttyStreamActive(s, now));
  rttyStreamAppend(s, RTTY_STREAM_RX1, "Z", 1, now);
  rttyStreamDrain(s, now, 8, capture, nullptr);
  assert(wire.empty() && s.len[RTTY_STREAM_RX1] == 0);

  // Text waiting when the last listener goes is dropped, not sent to a later one.
  assert(rttyStreamSubscribe(s, "MON.01", &ON, 1, now) == RTTY_SUB_ADDED);
  rttyStreamAppend(s, RTTY_STREAM_RX1, "OLD", 3, now);
  rttyStreamAbortTx(s, now);
  assert(rttyStreamSubscribe(s, "MON.01", &OFF, 1, now) == RTTY_SUB_REMOVED);
  assert(s.len[RTTY_STREAM_RX1] == 0 && !s.txAbort);

  // Switching off forgets the subscribers; switching back on needs a renewal.
  assert(rttyStreamSubscribe(s, "MON.01", &ON, 1, now) == RTTY_SUB_ADDED);
  rttyStreamSetEnabled(s, false);
  rttyStreamSetEnabled(s, true);
  assert(!rttyStreamActive(s, now));

  // millis() wraps; the lease must not.
  RttyStream w = {};
  rttyStreamSetEnabled(w, true);
  uint32_t nearWrap = 0xFFFFFFFFu - 1000;
  assert(rttyStreamSubscribe(w, "MON.01", &ON, 1, nearWrap) == RTTY_SUB_ADDED);
  assert(rttyStreamActive(w, nearWrap + 60000));
  assert(!rttyStreamActive(w, nearWrap + 90000));

  // An abort with nobody listening is not remembered for a later subscriber.
  RttyStream q = {};
  rttyStreamSetEnabled(q, true);
  rttyStreamAbortTx(q, 0);
  assert(!q.txAbort);

  // seq wraps as a uint8.
  RttyStream r = {};
  rttyStreamSetEnabled(r, true);
  rttyStreamSubscribe(r, "MON.01", &ON, 1, 0);
  r.seq[RTTY_STREAM_RX1] = 255;
  rttyStreamAppend(r, RTTY_STREAM_RX1, "A", 1, 0);
  rttyStreamDrain(r, 0, 8, capture, nullptr);
  rttyStreamAppend(r, RTTY_STREAM_RX1, "B", 1, 0);
  rttyStreamDrain(r, 0, 8, capture, nullptr);
  assert(wire.size() == 2 && wire[0].data[0] == 255 && wire[1].data[0] == 0);

  std::puts("RTTY STREAM PASS");
  return 0;
}
