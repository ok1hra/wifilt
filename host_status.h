#pragma once

// /wl-host: the state of the machine wifilt runs on, for the OI3's LCD.
//
// A Raspberry Pi running wifilt and local-trx in the shack usually has no
// screen, and when the web page does not answer the operator cannot tell
// whether the Pi is down, rebooting, updating, sitting in its setup hotspot or
// simply on another network. The OI3 that local-trx drives over TrxNet has a
// 16x2 LCD; wifilt tells it, and the OI3 shows it in its "RPI" menu item.
//
// Sent by the native build on a Raspberry Pi only, to every real OI3 (an
// "OI3.*" peer on another address -- local-trx's own FSK stand-in has this
// machine's address), and only once local-trx's TrxNet node ("LTX.*") has been
// seen since wifilt started. TRX_NON: every 5 s, at once on a change, and twice
// on the way down -- a CON retransmit would die with the process.
//
// Payload (TrxNet INTEGRATION.md 7.4), 11 + n bytes:
//   0     ver    = 1
//   1     state  HOST_RUN .. HOST_UPDATE
//   2     flags  HOST_F_*
//   3     rssi   int8 dBm of the WiFi client link, 0 = none
//   4     pct    update progress 0..100, 255 = none
//   5     reserved, 0
//   6..9  IPv4 to browse to, a.b.c.d in that order (0.0.0.0 = none)
//   10    n      SSID length, 0..32
//   11..  SSID, no terminator
//
// Shared by the sketch and tools/host-status-smoke.cpp; nothing here touches
// the network or the clock.

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum HostState : uint8_t {
  HOST_RUN     = 0,   // wifilt is up
  HOST_RESTART = 1,   // wifilt re-executes itself (Save & Restart), back in seconds
  HOST_STOP    = 2,   // the service was stopped
  HOST_REBOOT  = 3,   // the whole system is going down (reboot or power-off)
  HOST_UPDATE  = 4    // an update from the web page is under way
};

enum : uint8_t {
  HOST_F_LOCKED   = 0x01,   // root filesystem is the fslock overlay
  HOST_F_LOCKABLE = 0x02,   // fslock is installed (so unlocked deserves a warning)
  HOST_F_AP       = 0x04,   // the WiFi interface runs a hotspot
  HOST_F_WIFI     = 0x08,   // a WiFi interface is up with an address
  HOST_F_LTX      = 0x10,   // local-trx's TrxNet node is present
  HOST_F_TRXLINK  = 0x20,   // wifilt's radio slot to local-trx is linked
  HOST_F_IP_ETH   = 0x40    // the address is not the WiFi interface's
};

static const uint8_t  HOST_STATUS_VER       = 1;
static const uint8_t  HOST_STATUS_HDR       = 11;
static const uint8_t  HOST_STATUS_SSID_MAX  = 32;
static const uint8_t  HOST_STATUS_MAX       = HOST_STATUS_HDR + HOST_STATUS_SSID_MAX;   // 43
static const uint8_t  HOST_STATUS_PCT_NONE  = 255;
static const uint32_t HOST_STATUS_PERIOD_MS = 5000;
static const uint32_t HOST_STATUS_MIN_GAP_MS = 1000;
static const int      HOST_STATUS_RSSI_STEP = 3;      // dB that counts as a change
static const char     HOST_STATUS_TOPIC[]   = "/wl-host";

struct HostStatus {
  uint8_t state;
  uint8_t flags;
  int8_t  rssi;        // 0 = none
  uint8_t pct;         // HOST_STATUS_PCT_NONE = none
  uint8_t ip[4];
  char    ssid[HOST_STATUS_SSID_MAX + 1];
};

// dBm as the wire carries it: -999 (nothing) and anything out of range -> 0.
static inline int8_t hostStatusRssi(int dbm) {
  if (dbm >= 0 || dbm < -127) return 0;
  return (int8_t)dbm;
}

// out must hold HOST_STATUS_MAX bytes. Returns the length.
static inline size_t hostStatusEncode(const HostStatus& s, uint8_t* out) {
  size_t n = strnlen(s.ssid, HOST_STATUS_SSID_MAX);
  out[0] = HOST_STATUS_VER;
  out[1] = s.state;
  out[2] = s.flags;
  out[3] = (uint8_t)s.rssi;
  out[4] = s.pct;
  out[5] = 0;
  memcpy(out + 6, s.ip, 4);
  out[10] = (uint8_t)n;
  memcpy(out + HOST_STATUS_HDR, s.ssid, n);
  return HOST_STATUS_HDR + n;
}

// The OI3 carries its own copy of this; kept here so the smoke test proves the
// layout both ways. A newer version with a longer header still decodes.
static inline bool hostStatusDecode(const uint8_t* data, size_t len, HostStatus& s) {
  if (!data || len < HOST_STATUS_HDR || data[0] < 1) return false;
  size_t n = data[10];
  if (n > HOST_STATUS_SSID_MAX || HOST_STATUS_HDR + n > len) return false;
  memset(&s, 0, sizeof(s));
  s.state = data[1];
  s.flags = data[2];
  s.rssi  = (int8_t)data[3];
  s.pct   = data[4];
  memcpy(s.ip, data + 6, 4);
  memcpy(s.ssid, data + HOST_STATUS_HDR, n);
  s.ssid[n] = '\0';
  return true;
}

// Worth telling the OI3 now rather than at the next period.
static inline bool hostStatusChanged(const HostStatus& a, const HostStatus& b) {
  if (a.state != b.state || a.flags != b.flags || a.pct != b.pct) return true;
  if (memcmp(a.ip, b.ip, 4) != 0 || strcmp(a.ssid, b.ssid) != 0) return true;
  if ((a.rssi == 0) != (b.rssi == 0)) return true;
  return abs((int)a.rssi - (int)b.rssi) >= HOST_STATUS_RSSI_STEP;
}

struct HostStatusSched {
  bool       sent;
  uint32_t   lastMs;
  HostStatus last;
};

// true = send `now` this pass (and remember it as sent).
static inline bool hostStatusDue(HostStatusSched& sch, const HostStatus& now, uint32_t ms) {
  bool due;
  if (!sch.sent) due = true;
  else if (ms - sch.lastMs >= HOST_STATUS_PERIOD_MS) due = true;
  else due = ms - sch.lastMs >= HOST_STATUS_MIN_GAP_MS && hostStatusChanged(sch.last, now);
  if (due) {
    sch.sent = true;
    sch.lastMs = ms;
    sch.last = now;
  }
  return due;
}
