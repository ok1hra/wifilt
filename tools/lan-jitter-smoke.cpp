// g++ -std=c++17 -O2 -o /tmp/lan-jitter-smoke tools/lan-jitter-smoke.cpp && /tmp/lan-jitter-smoke
//
// lan_jitter.h: RX audio lateness -> one-way jitter -> the radio's TX buffer.
// Packets are generated on the radio's 20 ms clock and delivered with a
// chosen delay pattern; the measured jitter and the buffer it asks for are
// checked against what the pattern is.
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cmath>
#include <vector>
#include <algorithm>
#include "../lan_jitter.h"

static int failures = 0, passes = 0;
static void check(const char* name, bool ok, const char* fmt = "", long a = 0, long b = 0) {
  if (ok) { passes++; return; }
  failures++;
  printf("FAIL %s  ", name); printf(fmt, a, b); printf("\n");
}
static uint32_t rng = 1;
static double uni() { rng = rng * 1664525u + 1013904223u; return (rng >> 8) / 16777216.0; }

// Feed `seconds` of packets. delayMs(i) is packet i's network delay; skip(i)
// drops it; clockPpm skews the radio's clock against ours.
// Delivered in arrival order, as a socket hands them over: a packet held up
// longer than the next one arrives after it.
template <class D, class S>
static void feed(LanRxJitter& j, uint32_t& t0, uint16_t& seq, double seconds, D delayMs, S skip, double clockPpm = 0) {
  int n = int(seconds * 50);
  std::vector<std::pair<uint32_t, uint16_t>> arr;
  for (int i = 0; i < n; i++, seq++) {
    double sent = t0 + i * 20.0 * (1 + clockPpm * 1e-6);
    if (skip(i)) continue;
    arr.push_back({uint32_t(std::lround(sent + delayMs(i))), seq});
  }
  std::stable_sort(arr.begin(), arr.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  for (const auto& p : arr) j.onPacket(p.first, p.second);
  t0 += uint32_t(n * 20);
}
static auto never = [](int) { return false; };

int main() {
  {
    LanRxJitter j; uint32_t t = 1000; uint16_t s = 100;
    check("no opinion before a window closes", j.windows() == 0 && j.jitterMs() == 0);
    feed(j, t, s, 130, [](int) { return 2.0 + uni() * 3; }, never);
    check("wired: a few ms", j.windows() == 6 && j.jitterMs() <= 5, "jitter %ld windows %ld", j.jitterMs(), j.windows());
    check("wired: buffer stays 150", LanRxJitter::txBufferFor(j.jitterMs()) == 150, "%ld", LanRxJitter::txBufferFor(j.jitterMs()));
  }
  {
    // Wi-Fi: mostly 5-25 ms, 2 % of packets 100-160 ms late (the IC-705's ping max was 152).
    LanRxJitter j; uint32_t t = 5000; uint16_t s = 60000;   // wraps the 16-bit sequence on the way
    feed(j, t, s, 130, [](int) { return uni() < 0.02 ? 100 + uni() * 60 : 5 + uni() * 20; }, never);
    uint32_t jt = j.jitterMs(), buf = LanRxJitter::txBufferFor(jt);
    check("wifi: p99 sees the 100-160 ms tail", jt >= 90 && jt <= 160, "jitter %ld", jt);
    check("wifi: buffer 250-300 ms", buf >= 250 && buf <= 300, "buffer %ld (jitter %ld)", buf, jt);
  }
  {
    // A burst: 400 ms stall, the queued packets then arrive back to back.
    LanRxJitter j; uint32_t t = 0; uint16_t s = 0;
    feed(j, t, s, 25, [](int i) { int k = i % 500; return k < 20 ? 400.0 - k * 20 + 2 : 2.0; }, never);
    // 4 % of packets in the tail, so the p99 lands inside it; the buffer has to outlast the stall.
    check("stall bursts: counted", j.jitterMs() >= 200, "jitter %ld", j.jitterMs());
    check("stall bursts: the buffer outlasts a 400 ms stall", LanRxJitter::txBufferFor(j.jitterMs()) >= 400, "%ld", LanRxJitter::txBufferFor(j.jitterMs()));
  }
  {
    // Lost packets (holes) do not make the next one look late.
    LanRxJitter j; uint32_t t = 0; uint16_t s = 0;
    feed(j, t, s, 65, [](int) { return 3.0; }, [](int i) { return i % 37 == 0 || (i % 400) < 5; });
    check("holes: no lateness from missing packets", j.jitterMs() <= 1, "jitter %ld", j.jitterMs());
  }
  {
    // The radio stops streaming for 3 s (no AF), then resumes on its clock.
    LanRxJitter j; uint32_t t = 0; uint16_t s = 0;
    feed(j, t, s, 10, [](int) { return 4.0; }, never);
    t += 3000;
    feed(j, t, s, 55, [](int) { return 4.0; }, never);
    check("radio pause: not jitter", j.jitterMs() <= 1, "jitter %ld", j.jitterMs());
  }
  {
    // 50 ppm clock skew for 10 minutes: drift is re-floored every window.
    LanRxJitter j; uint32_t t = 0; uint16_t s = 0;
    feed(j, t, s, 600, [](int) { return 3.0; }, never, 50);
    check("clock skew: drift is not jitter", j.jitterMs() <= 2, "jitter %ld", j.jitterMs());
  }
  {
    // Retransmitted packets, 300 ms after their slot, behind newer ones.
    LanRxJitter j; uint32_t t = 0;
    for (int i = 0; i < 2600; i++) {
      j.onPacket(t + i * 20 + 2, uint16_t(i));
      if (i % 50 == 10) j.onPacket(t + i * 20 + 300, uint16_t(i - 5));   // a replay, 300 ms on
    }
    // 2 % of the audio 300 ms late through retransmits is a path the TX buffer has to cover too.
    check("replays: their lateness counts", j.jitterMs() >= 250, "jitter %ld", j.jitterMs());
  }
  {
    // Recovery: two minutes of a clean path after a bad one bring it back down.
    LanRxJitter j; uint32_t t = 0; uint16_t s = 0;
    feed(j, t, s, 60, [](int) { return uni() < 0.05 ? 200.0 : 5.0; }, never);
    uint32_t bad = j.jitterMs();
    feed(j, t, s, 125, [](int) { return 5.0; }, never);
    check("recovery: high, then back to clean", bad >= 150 && j.jitterMs() <= 1, "bad %ld now %ld", bad, j.jitterMs());
  }
  {
    // Reconnect: the new stream's numbers land just below the old ones, minutes later.
    LanRxJitter j; uint32_t t = 0; uint16_t s = 5000;
    feed(j, t, s, 65, [](int) { return 3.0; }, never);
    t += 240000; s -= 100;
    feed(j, t, s, 65, [](int) { return 3.0; }, never);
    check("reconnect with nearby sequence numbers: not jitter", j.jitterMs() <= 2, "jitter %ld", j.jitterMs());
    LanRxJitter k; t = 0; s = 5000;
    feed(k, t, s, 30, [](int) { return 3.0; }, never);
    k.restart(); t += 1000;
    feed(k, t, s, 45, [](int) { return 3.0; }, never);
    check("restart(): carries on cleanly", k.jitterMs() <= 2 && k.windows() >= 2, "jitter %ld", k.jitterMs());
  }
  {
    // Own TX every 10 s for 3 s: the radio stalls RX 600 ms at each PTT edge and bursts.
    LanRxJitter j; uint32_t t = 0; uint16_t s = 0;
    for (int cycle = 0; cycle < 14; cycle++) {
      uint32_t c0 = t;
      feed(j, t, s, 7, [](int) { return 4.0; }, never);
      // 3 s of TX: hold() called while it lasts, RX stalls 600 ms at its start
      for (int i = 0; i < 150; i++, s++) {
        uint32_t now = c0 + 7000 + i * 20;
        j.hold(now);
        j.onPacket(now + (i < 30 ? 600 - i * 20 : 4), s);
      }
      t += 3000;
      // after TX: 600 ms stall again, then burst -- inside the hold tail
      feed(j, t, s, 0.6, [](int i) { return 600.0 - i * 20; }, never);
    }
    check("own TX: the stutter around PTT is not jitter", j.jitterMs() <= 5, "jitter %ld", j.jitterMs());
  }
  check("txBufferFor: 0 -> 150", LanRxJitter::txBufferFor(0) == 150);
  check("txBufferFor: 100 -> 250", LanRxJitter::txBufferFor(100) == 250, "%ld", LanRxJitter::txBufferFor(100));
  check("txBufferFor: 150 -> 300", LanRxJitter::txBufferFor(150) == 300, "%ld", LanRxJitter::txBufferFor(150));
  check("txBufferFor: 1000 -> 500 cap", LanRxJitter::txBufferFor(1000) == 500);
  printf("%d passed, %d failed\n", passes, failures);
  return failures ? 1 : 0;
}
