// g++ -std=c++17 -o /tmp/wifi-link-probe-smoke tools/wifi-link-probe-smoke.cpp && /tmp/wifi-link-probe-smoke
#include <cassert>
#include <cstdio>
#include "../wifi_link_probe.h"

static WifiProbeAction missRound(WifiLinkProbe &p, bool tx = false) {
  WifiProbeAction a = WIFI_PROBE_NONE;
  for (uint8_t i = 0; i < WIFI_PROBE_MISS_LIMIT; ++i) {
    a = wifiProbeTimeout(p, tx);
    if (i + 1 < WIFI_PROBE_MISS_LIMIT) assert(a == WIFI_PROBE_NONE);
  }
  return a;
}

int main() {
  const uint32_t gw = 0x0101A8C0;  // 192.168.1.1

  // A gateway that never answers ping never triggers anything.
  WifiLinkProbe silent;
  assert(wifiProbeSetGateway(silent, gw));
  for (int i = 0; i < 50; ++i) assert(wifiProbeTimeout(silent, false) == WIFI_PROBE_NONE);

  // First reply arms, the second does not report arming again.
  WifiLinkProbe p;
  wifiProbeSetGateway(p, gw);
  assert(wifiProbeReply(p));
  assert(!wifiProbeReply(p));

  // Two misses and a reply: nothing, the count starts over.
  assert(wifiProbeTimeout(p, false) == WIFI_PROBE_NONE);
  assert(wifiProbeTimeout(p, false) == WIFI_PROBE_NONE);
  assert(!wifiProbeReply(p));
  assert(wifiProbeTimeout(p, false) == WIFI_PROBE_NONE);
  assert(wifiProbeTimeout(p, false) == WIFI_PROBE_NONE);

  // Visible link-down resets the count: those timeouts are the watchdog's.
  wifiProbeLinkDown(p);
  assert(wifiProbeTimeout(p, false) == WIFI_PROBE_NONE);
  assert(wifiProbeTimeout(p, false) == WIFI_PROBE_NONE);
  wifiProbeLinkDown(p);

  // Full ladder, staying armed across the reconnects.
  assert(missRound(p) == WIFI_PROBE_RECONNECT);
  assert(missRound(p) == WIFI_PROBE_RADIO_RESET);
  assert(missRound(p) == WIFI_PROBE_RESTART);
  assert(missRound(p) == WIFI_PROBE_RESTART);

  // A reply anywhere on the ladder starts it from the bottom.
  wifiProbeReply(p);
  assert(missRound(p) == WIFI_PROBE_RECONNECT);
  wifiProbeReply(p);
  assert(missRound(p) == WIFI_PROBE_RECONNECT);

  // Restart waits for the end of a transmission, then fires on the next miss.
  assert(missRound(p) == WIFI_PROBE_RADIO_RESET);
  assert(missRound(p, true) == WIFI_PROBE_NONE);
  assert(wifiProbeTimeout(p, true) == WIFI_PROBE_NONE);
  assert(wifiProbeTimeout(p, false) == WIFI_PROBE_RESTART);
  // ...but reconnect and radio reset never wait for TX.
  wifiProbeReply(p);
  assert(missRound(p, true) == WIFI_PROBE_RECONNECT);
  assert(missRound(p, true) == WIFI_PROBE_RADIO_RESET);

  // Other inbound traffic resets misses and the ladder like a reply...
  wifiProbeReply(p);
  assert(wifiProbeTimeout(p, false) == WIFI_PROBE_NONE);
  assert(wifiProbeTimeout(p, false) == WIFI_PROBE_NONE);
  wifiProbeTraffic(p);
  assert(wifiProbeTimeout(p, false) == WIFI_PROBE_NONE);
  assert(wifiProbeTimeout(p, false) == WIFI_PROBE_NONE);
  assert(wifiProbeTimeout(p, false) == WIFI_PROBE_RECONNECT);
  wifiProbeTraffic(p);
  assert(missRound(p) == WIFI_PROBE_RECONNECT);
  // ...but never arms a probe whose gateway has not answered ping.
  WifiLinkProbe quiet;
  wifiProbeSetGateway(quiet, gw);
  wifiProbeTraffic(quiet);
  assert(!quiet.armed);
  for (int i = 0; i < 10; ++i) assert(wifiProbeTimeout(quiet, false) == WIFI_PROBE_NONE);

  // Same gateway keeps the state, a new one disarms.
  assert(!wifiProbeSetGateway(p, gw));
  assert(p.armed);
  assert(wifiProbeSetGateway(p, 0x0100A8C0));
  assert(!p.armed && p.stage == 0 && p.misses == 0);
  for (int i = 0; i < 10; ++i) assert(wifiProbeTimeout(p, false) == WIFI_PROBE_NONE);

  std::puts("wifi-link-probe-smoke: OK");
  return 0;
}
