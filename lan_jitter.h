// lan_jitter.h -- how late the radio's RX audio packets arrive, and the TX
// buffer that follows from it.
//
// The radio sends one RX audio packet every 20 ms, numbered (inner sequence,
// BE @0x12). Against that clock each packet has a lateness: arrival minus
// (first arrival + 20 ms x packets since). The fastest packets of a window set
// the floor; how far above the floor the slowest 1 % land is the one-way
// jitter of the path between the radio and this host -- Wi-Fi, mostly.
//
// The TX direction rides the same path, and the radio's TX buffer (the
// "txbuffer" of the stream request, icomLanClient.h) has to cover it: with
// 150 ms an IC-705 on Wi-Fi ran dry and dropped ~1.2 s of a 17 s JTTY message
// (found on air 2026-11-06); 300 ms fixed it. txBufferFor() turns the jitter
// into a buffer with a margin. Measuring the RX side needs no extra traffic and
// runs in the audio task, so a stalled main loop (the ESP32's 1-4 s page-load
// stalls) does not count as network jitter, as a ping RTT taken there would.
//
// No allocation, ~120 bytes. Not thread-safe: the caller holds its lock.
#pragma once
#include <stdint.h>

class LanRxJitter {
public:
  static const uint32_t PACKET_MS = 20;
  static const uint32_t WINDOW_MS = 20000;   // one p99 per window
  static const uint8_t  WINDOWS   = 6;       // jitter = worst of the last two minutes
  static const uint8_t  TOP       = 10;      // ~1 % of a window's 1000 packets
  static const uint32_t PAUSE_MS  = 1000;    // longer silence: the radio paused, re-anchor
  static const uint32_t HOLD_MS   = 1500;    // after this station's own TX: not counted
  static const uint32_t SANE_MS   = 2000;    // more than this late is a new stream, not jitter
  static const uint32_t BUFFER_MIN_MS = 150, BUFFER_MAX_MS = 500, BUFFER_STEP_MS = 50;

  void reset() {
    anchored = false; ext = 0; ring = 0; filled = 0; windowStartMs = 0;
    floorMs = INT32_MAX_; prevFloorMs = INT32_MAX_;
    for (uint8_t i = 0; i < TOP; i++) top[i] = 0;
    topCount = 0;
    for (uint8_t i = 0; i < WINDOWS; i++) p99[i] = 0;
  }
  LanRxJitter() { reset(); holdUntil = 0; held = false; }

  // A new audio stream (the channel reopened, a reconnect at another rate):
  // its sequence numbers have nothing to do with the last one's, even when
  // they happen to land close to them. The windows already measured stay.
  void restart() { anchored = false; floorMs = INT32_MAX_; prevFloorMs = INT32_MAX_; }

  // This station is transmitting. The radio's RX stream stutters around its own
  // PTT (found live on an IC-705 on FM: 231 ms "jitter" against 10 ms on SSB
  // the same day), which says nothing about the path. Packets until HOLD_MS
  // after the last call are not counted, and the clock re-anchors after it.
  void hold(uint32_t nowMs) { holdUntil = nowMs + HOLD_MS; held = true; }

  // One RX audio data packet: arrival time and its inner sequence number.
  void onPacket(uint32_t nowMs, uint16_t seq) {
    if (held) {
      if (int32_t(nowMs - holdUntil) < 0) { anchored = false; return; }
      held = false;
      restart();
    }
    if (!anchored) { anchor(nowMs, seq); return; }
    int16_t step = int16_t(seq - lastSeq);
    if (step <= 0) {
      // Behind the newest one: overtaken on the way, or a retransmit filling its
      // hole. Its lateness is real -- the audio was that late -- but it does
      // not move the sequence.
      if (step <= -250 || int32_t(nowMs - lastArrivalMs) > int32_t(PAUSE_MS)) { restart(); anchor(nowMs, seq); return; }
      lateness(nowMs, int32_t(nowMs - (baseMs + (ext + int32_t(step)) * PACKET_MS)));
      return;
    }
    if (step > 250 || int32_t(nowMs - lastArrivalMs) > int32_t(PAUSE_MS)) {
      // A new stream, or the radio was silent: carry on from here at the floor.
      ext += uint32_t(step);
      lastSeq = seq; lastArrivalMs = nowMs;
      int32_t keep = floorMs == INT32_MAX_ ? 0 : floorMs;
      baseMs = nowMs - ext * PACKET_MS - uint32_t(keep);
      return;
    }
    ext += uint32_t(step);
    lastSeq = seq; lastArrivalMs = nowMs;
    lateness(nowMs, int32_t(nowMs - (baseMs + ext * PACKET_MS)));
  }

  // Worst p99 lateness above the floor over the last WINDOWS windows, in ms.
  uint32_t jitterMs() const {
    uint32_t worst = 0;
    for (uint8_t i = 0; i < filled; i++) if (p99[i] > worst) worst = p99[i];
    return worst;
  }
  // Whole windows behind jitterMs() (0 = no opinion yet).
  uint8_t windows() const { return filled; }

  // The TX buffer for a path with this jitter: 1.5x plus 60 ms, in 50 ms steps,
  // 150..500 ms. A wired radio (a few ms) stays at the 150 ms everyone used.
  static uint32_t txBufferFor(uint32_t jitterMs) {
    uint32_t want = jitterMs * 3 / 2 + 60;
    want = (want + BUFFER_STEP_MS - 1) / BUFFER_STEP_MS * BUFFER_STEP_MS;
    if (want < BUFFER_MIN_MS) want = BUFFER_MIN_MS;
    if (want > BUFFER_MAX_MS) want = BUFFER_MAX_MS;
    return want;
  }

private:
  static const int32_t INT32_MAX_ = 0x7FFFFFFF;
  bool anchored;
  uint16_t lastSeq;
  uint32_t ext, baseMs, lastArrivalMs, windowStartMs;
  int32_t floorMs, prevFloorMs;
  uint16_t top[TOP];          // largest lateness values of the window, descending
  uint8_t topCount;
  uint16_t p99[WINDOWS];
  uint8_t ring, filled;
  uint32_t holdUntil;
  bool held;

  // Lateness above the floor (this window's fastest packet, or the last
  // window's if that was faster), into the window's top list.
  void lateness(uint32_t nowMs, int32_t late) {
    if (late < floorMs) floorMs = late;
    int32_t ref = floorMs < prevFloorMs ? floorMs : prevFloorMs;
    int32_t above = late - ref;
    if (above < 0) above = 0;
    if (above > int32_t(SANE_MS)) { restart(); anchored = false; return; }
    note(uint32_t(above));
    if (nowMs - windowStartMs >= WINDOW_MS) closeWindow(nowMs);
  }
  void anchor(uint32_t nowMs, uint16_t seq) {
    anchored = true; lastSeq = seq; ext = 0; baseMs = nowMs; lastArrivalMs = nowMs; windowStartMs = nowMs;
  }
  void note(uint32_t above) {
    uint16_t v = above > 0xFFFF ? 0xFFFF : uint16_t(above);
    if (topCount < TOP) topCount++;
    else if (v <= top[TOP - 1]) return;
    uint8_t i = topCount - 1;
    while (i > 0 && top[i - 1] < v) { top[i] = top[i - 1]; i--; }
    top[i] = v;
  }
  void closeWindow(uint32_t nowMs) {
    p99[ring] = topCount ? top[topCount - 1] : 0;
    ring = uint8_t((ring + 1) % WINDOWS);
    if (filled < WINDOWS) filled++;
    topCount = 0;
    prevFloorMs = floorMs; floorMs = INT32_MAX_;
    windowStartMs = nowMs;
  }
};
