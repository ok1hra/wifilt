// Native regression test for host_status.h -- the /wl-host topic for the OI3 LCD.
//
//   g++ -std=c++11 -Wall -Wextra -o /tmp/host-status-smoke tools/host-status-smoke.cpp && /tmp/host-status-smoke

#include <cassert>
#include <cstdio>
#include <cstring>
#include "../host_status.h"

static HostStatus make(const char* ssid, int dbm) {
  HostStatus s;
  memset(&s, 0, sizeof(s));
  s.state = HOST_RUN;
  s.flags = HOST_F_WIFI | HOST_F_LTX | HOST_F_LOCKED | HOST_F_LOCKABLE;
  s.rssi = hostStatusRssi(dbm);
  s.pct = HOST_STATUS_PCT_NONE;
  s.ip[0] = 192; s.ip[1] = 168; s.ip[2] = 1; s.ip[3] = 23;
  snprintf(s.ssid, sizeof(s.ssid), "%s", ssid);
  return s;
}

int main() {
  // RSSI: "nothing" and nonsense become 0; real readings pass.
  assert(hostStatusRssi(-999) == 0);
  assert(hostStatusRssi(0) == 0);
  assert(hostStatusRssi(5) == 0);
  assert(hostStatusRssi(-128) == 0);
  assert(hostStatusRssi(-127) == -127);
  assert(hostStatusRssi(-48) == -48);

  // Layout, byte by byte.
  uint8_t buf[HOST_STATUS_MAX];
  HostStatus a = make("Domov", -62);
  size_t n = hostStatusEncode(a, buf);
  assert(n == HOST_STATUS_HDR + 5);
  assert(buf[0] == 1 && buf[1] == HOST_RUN && buf[2] == a.flags);
  assert((int8_t)buf[3] == -62 && buf[4] == 255 && buf[5] == 0);
  assert(buf[6] == 192 && buf[7] == 168 && buf[8] == 1 && buf[9] == 23);
  assert(buf[10] == 5 && memcmp(buf + 11, "Domov", 5) == 0);

  // Round trip.
  HostStatus b;
  assert(hostStatusDecode(buf, n, b));
  assert(!hostStatusChanged(a, b));
  assert(strcmp(b.ssid, "Domov") == 0 && b.rssi == -62);

  // A full 32-byte SSID fits in the 64-byte TrxNet payload; a longer one is cut.
  HostStatus longName = make("", -50);
  memset(longName.ssid, 'X', HOST_STATUS_SSID_MAX);
  longName.ssid[HOST_STATUS_SSID_MAX] = '\0';
  n = hostStatusEncode(longName, buf);
  assert(n == HOST_STATUS_MAX && n <= 64);
  assert(hostStatusDecode(buf, n, b) && strlen(b.ssid) == 32);

  // No SSID, no address (wired-less, hotspot not up yet).
  HostStatus empty = make("", -999);
  memset(empty.ip, 0, 4);
  n = hostStatusEncode(empty, buf);
  assert(n == HOST_STATUS_HDR);
  assert(hostStatusDecode(buf, n, b) && b.ssid[0] == 0 && b.rssi == 0);

  // Malformed input is refused.
  assert(!hostStatusDecode(buf, HOST_STATUS_HDR - 1, b));
  uint8_t bad[HOST_STATUS_HDR];
  memcpy(bad, buf, HOST_STATUS_HDR);
  bad[10] = 5;                                  // claims an SSID that is not there
  assert(!hostStatusDecode(bad, sizeof(bad), b));
  bad[10] = 0; bad[0] = 0;                      // version 0 does not exist
  assert(!hostStatusDecode(bad, sizeof(bad), b));
  // A future version with extra bytes after the SSID still decodes.
  uint8_t future[HOST_STATUS_MAX + 4] = {0};
  n = hostStatusEncode(a, future);
  future[0] = 2;
  assert(hostStatusDecode(future, n + 4, b) && strcmp(b.ssid, "Domov") == 0);

  // Changes worth sending at once.
  HostStatus c = a;
  c.rssi = -64; assert(!hostStatusChanged(a, c));       // 2 dB: wait for the period
  c.rssi = -65; assert(hostStatusChanged(a, c));        // 3 dB: now
  c = a; c.flags &= (uint8_t)~HOST_F_LOCKED; assert(hostStatusChanged(a, c));
  c = a; c.state = HOST_UPDATE; assert(hostStatusChanged(a, c));
  c = a; c.pct = 40; assert(hostStatusChanged(a, c));
  c = a; c.ip[3] = 24; assert(hostStatusChanged(a, c));
  c = a; snprintf(c.ssid, sizeof(c.ssid), "Jinde"); assert(hostStatusChanged(a, c));
  c = a; c.rssi = 0; assert(hostStatusChanged(a, c));   // link lost

  // Scheduling: first at once, then every period; a change after the minimum gap.
  HostStatusSched sch;
  memset(&sch, 0, sizeof(sch));
  uint32_t t = 1000;
  assert(hostStatusDue(sch, a, t));
  assert(!hostStatusDue(sch, a, t + 100));
  assert(!hostStatusDue(sch, a, t + 4999));
  assert(hostStatusDue(sch, a, t + 5000));
  t += 5000;
  c = a; c.flags &= (uint8_t)~HOST_F_LOCKED;
  assert(!hostStatusDue(sch, c, t + 500));              // change, but inside the gap
  assert(hostStatusDue(sch, c, t + 1000));              // ...sent once the gap is over
  assert(!hostStatusDue(sch, c, t + 2000));             // and not again
  // millis() wrap.
  memset(&sch, 0, sizeof(sch));
  assert(hostStatusDue(sch, a, 0xFFFFF000u));
  assert(!hostStatusDue(sch, a, 0xFFFFF000u + 4000));
  assert(hostStatusDue(sch, a, 0xFFFFF000u + 5000));

  printf("host-status-smoke: all checks passed\n");
  return 0;
}
