#pragma once

// Gateway probe: catches a station link that is associated and holds an IP
// but carries no data. Shared by the firmware sketch and a host regression
// test, so the escalation rules are exercised without hardware.
//
// The WiFi watchdog only asks "status CONNECTED and IP != 0". A dead data path
// passes both (field log 2026-10-25: web OFFLINE, IC-705 silent on LAN while
// its own WLAN icon stayed on, WIFI-status 3 with an IP) until the DHCP lease
// can no longer be renewed -- minutes to hours later. Pinging the gateway is
// the cheapest proof that frames really flow.
//
// The probe arms only after the gateway has answered once: a router that drops
// ICMP must never turn this into an endless reconnect loop. It stays armed
// across reconnects to the same gateway, because the outage it hunts is
// exactly the one where replies stop coming.
//
// Escalation without an intervening reply: reconnect (seconds, keeps all RAM
// state) -> radio off/on -> ESP.restart(), the restart never while keyed.

#include <stdint.h>

enum WifiProbeAction : uint8_t {
  WIFI_PROBE_NONE = 0,
  WIFI_PROBE_RECONNECT,     // re-associate to the same AP
  WIFI_PROBE_RADIO_RESET,   // WiFi radio off/on, full-scan connect
  WIFI_PROBE_RESTART,       // reboot the interface
};

static const uint32_t WIFI_PROBE_INTERVAL_MS = 10000;
static const uint32_t WIFI_PROBE_TIMEOUT_MS  = 2000;
static const uint8_t  WIFI_PROBE_MISS_LIMIT  = 3;   // ~30 s of silence per step

struct WifiLinkProbe {
  uint32_t gateway = 0;   // address the session pings, 0 = none yet
  bool     armed = false; // the gateway has answered at least once
  uint8_t  misses = 0;    // consecutive unanswered probes while the link looked up
  uint8_t  stage = 0;     // escalations since the last reply
};

// A different gateway is a different network: its ICMP policy is unknown.
inline bool wifiProbeSetGateway(WifiLinkProbe &p, uint32_t gateway) {
  if (p.gateway == gateway) return false;
  p.gateway = gateway;
  p.armed = false;
  p.misses = 0;
  p.stage = 0;
  return true;
}

// Timeouts while the station is visibly down belong to the ordinary watchdog.
inline void wifiProbeLinkDown(WifiLinkProbe &p) { p.misses = 0; }

// Returns true when this reply armed the probe (worth one log line).
inline bool wifiProbeReply(WifiLinkProbe &p) {
  bool newlyArmed = !p.armed;
  p.armed = true;
  p.misses = 0;
  p.stage = 0;
  return newlyArmed;
}

inline WifiProbeAction wifiProbeTimeout(WifiLinkProbe &p, bool txActive) {
  if (!p.armed) return WIFI_PROBE_NONE;
  if (p.misses < 0xff) p.misses++;
  if (p.misses < WIFI_PROBE_MISS_LIMIT) return WIFI_PROBE_NONE;
  // Misses stay at the limit while keyed, so the very next one retries.
  if (p.stage >= 2 && txActive) return WIFI_PROBE_NONE;
  p.misses = 0;
  if (p.stage == 0) { p.stage = 1; return WIFI_PROBE_RECONNECT; }
  if (p.stage == 1) { p.stage = 2; return WIFI_PROBE_RADIO_RESET; }
  return WIFI_PROBE_RESTART;
}
