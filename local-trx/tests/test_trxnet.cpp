// doctest unit tests for the network-free halves of the TrxNet backend:
// trxnet_rig.cpp (what wifilt sees of the device's frequency/mode) and
// trxnet_ptt.cpp (the /s-ptt lease and CW gathering), plus the config keys.
#include "doctest.h"

#include <string>
#include <vector>

#include "../src/config.h"
#include "../src/trxnet_ptt.h"
#include "../src/trxnet_rig.h"

using namespace LocalTrx;

TEST_CASE("TrxnetRigBackend answers inert defaults until the device publishes") {
  TrxnetRigBackend rig;
  double hz = -1;
  CHECK(rig.getFreqHz(&hz));
  CHECK(hz == 0.0);
  CHECK_FALSE(rig.haveFreq());
  uint8_t mode = 0xFF;
  bool data = true;
  CHECK(rig.getMode(&mode, &data));
  CHECK(mode == 0x01);
  CHECK_FALSE(data);

  rig.onPeerHz(0);   // OI3 before its first CAT answer
  CHECK_FALSE(rig.haveFreq());
  rig.onPeerHz(14074000);
  CHECK(rig.haveFreq());
  CHECK(rig.getFreqHz(&hz));
  CHECK(hz == 14074000.0);
}

TEST_CASE("TrxnetRigBackend queues one /s-hz, latest wins, cache updated at once") {
  TrxnetRigBackend rig;
  uint32_t cmd = 0;
  CHECK_FALSE(rig.takeFreqCommand(&cmd));
  CHECK(rig.setFreqHz(7040000.0));
  CHECK(rig.setFreqHz(7074000.4));
  double hz = 0;
  rig.getFreqHz(&hz);
  CHECK(hz == 7074000.0);
  REQUIRE(rig.takeFreqCommand(&cmd));
  CHECK(cmd == 7074000);
  CHECK_FALSE(rig.takeFreqCommand(&cmd));
  CHECK_FALSE(rig.setFreqHz(0.0));
  CHECK_FALSE(rig.setFreqHz(-5.0));
}

TEST_CASE("TrxnetRigBackend keeps wifilt's USB-D through the device's coarse /mode echo") {
  TrxnetRigBackend rig;
  CHECK(rig.setMode(0x01, true));   // JS8: USB-D
  uint8_t sent = 0;
  REQUIRE(rig.takeModeCommand(&sent));
  CHECK(sent == 0x01);              // the DATA flag has no TrxNet encoding

  rig.onPeerMode(0x01);   // OI3 SSB echo
  uint8_t mode = 0;
  bool data = false;
  rig.getMode(&mode, &data);
  CHECK(mode == 0x01);
  CHECK(data);

  rig.onPeerMode(0x05);   // OI3 switched to DIGI -- still the phone/data class
  rig.getMode(&mode, &data);
  CHECK(mode == 0x01);
  CHECK(data);

  rig.onPeerMode(0x03);   // operator picked CW at the keyer -- a real change
  rig.getMode(&mode, &data);
  CHECK(mode == 0x03);
  CHECK_FALSE(data);

  rig.onPeerMode(0x01);   // no command since: the device's word is taken as-is
  rig.getMode(&mode, &data);
  CHECK(mode == 0x01);
  CHECK_FALSE(data);
}

TEST_CASE("TrxnetRigBackend keeps CW-R and LSB that OI3 can only echo as CW and USB") {
  TrxnetRigBackend rig;
  uint8_t mode = 0;
  bool data = false;
  rig.setMode(0x07, false);
  rig.onPeerMode(0x03);
  rig.getMode(&mode, &data);
  CHECK(mode == 0x07);
  rig.setMode(0x00, false);
  rig.onPeerMode(0x01);
  rig.getMode(&mode, &data);
  CHECK(mode == 0x00);
  rig.setMode(0x08, false);
  rig.onPeerMode(0x04);
  rig.getMode(&mode, &data);
  CHECK(mode == 0x08);
}

TEST_CASE("TrxnetRigBackend answers nothing it has no TrxNet topic for") {
  TrxnetRigBackend rig;
  int32_t rit;
  uint8_t v;
  bool on;
  CHECK_FALSE(rig.getRitHz(&rit));
  CHECK_FALSE(rig.getGain(GainKind::Af, &v));
  CHECK_FALSE(rig.getGain(GainKind::RfPower, &v));
  CHECK_FALSE(rig.getMeter(MeterKind::Swr, &v));
  CHECK_FALSE(rig.getAttenuatorOn(&on));
  CHECK_FALSE(rig.getVoxOn(&on));
}

namespace {
// Runs the lease from t=start to t=end in 5 ms steps (the main loop's own
// sleep), wanting `want`, and records when it sent what.
struct Sent {
  uint32_t t;
  PttLease::Send what;
};
std::vector<Sent> run(PttLease &lease, bool want, uint32_t start, uint32_t end) {
  std::vector<Sent> out;
  for (uint32_t t = start; t < end; t += 5) {
    PttLease::Send s = lease.tick(want, t);
    if (s != PttLease::Send::None) out.push_back({t, s});
  }
  return out;
}
}  // namespace

TEST_CASE("PttLease keys at once, renews every 300 ms, well inside the 1500 ms lease") {
  PttLease lease;
  std::vector<Sent> sent = run(lease, true, 1000, 2000);
  REQUIRE(sent.size() == 4);
  CHECK(sent[0].t == 1000);
  CHECK(sent[1].t == 1300);
  CHECK(sent[2].t == 1600);
  CHECK(sent[3].t == 1900);
  for (const Sent &s : sent) CHECK(s.what == PttLease::Send::On);
}

TEST_CASE("PttLease releases at once and repeats the 0 twice, then goes quiet") {
  PttLease lease;
  run(lease, true, 0, 500);
  std::vector<Sent> sent = run(lease, false, 500, 2000);
  REQUIRE(sent.size() == 3);
  CHECK(sent[0].t == 500);
  CHECK(sent[1].t == 600);
  CHECK(sent[2].t == 700);
  for (const Sent &s : sent) CHECK(s.what == PttLease::Send::Off);
}

TEST_CASE("PttLease: keying again during the release repeats sends no stale 0") {
  PttLease lease;
  run(lease, true, 0, 500);
  std::vector<Sent> off = run(lease, false, 500, 550);
  REQUIRE(off.size() == 1);
  std::vector<Sent> on = run(lease, true, 550, 900);
  REQUIRE_FALSE(on.empty());
  for (const Sent &s : on) CHECK(s.what == PttLease::Send::On);
}

TEST_CASE("PttLease flags a device that never confirms, once per keying") {
  PttLease lease;
  run(lease, true, 0, 990);
  CHECK_FALSE(lease.takeEchoMissing());
  run(lease, true, 990, 1100);
  CHECK(lease.takeEchoMissing());
  CHECK_FALSE(lease.refused());
  run(lease, true, 1100, 3000);
  CHECK_FALSE(lease.takeEchoMissing());

  run(lease, false, 3000, 3500);
  run(lease, true, 3500, 3600);
  lease.onEcho(true);
  run(lease, true, 3600, 5000);
  CHECK_FALSE(lease.takeEchoMissing());
  CHECK(lease.keyedByDevice());
}

TEST_CASE("PttLease tells a refusal from silence") {
  PttLease lease;
  run(lease, true, 0, 100);
  lease.onEcho(false);   // interlock: the device answered our 1 with 0
  run(lease, true, 100, 1100);
  CHECK(lease.takeEchoMissing());
  CHECK(lease.refused());
}

TEST_CASE("PttLease survives the millis() wrap") {
  PttLease lease;
  std::vector<Sent> sent;
  for (uint32_t i = 0; i < 200; i++) {
    uint32_t t = 0xFFFFFF00u + i * 5;   // wraps past zero
    if (lease.tick(true, t) != PttLease::Send::None) sent.push_back({t, PttLease::Send::On});
  }
  REQUIRE(sent.size() == 4);   // 0, +300, +600, +900 ms
}

TEST_CASE("CwCoalescer gathers back-to-back CI-V frames into one message") {
  CwCoalescer cw;
  std::string chunk;
  cw.add("CQ CQ DE OK1HRA ", 0);
  cw.add("OK1HRA K", 10);
  CHECK_FALSE(cw.take(&chunk, 20));
  CHECK_FALSE(cw.take(&chunk, 39));
  REQUIRE(cw.take(&chunk, 40));
  CHECK(chunk == "CQ CQ DE OK1HRA OK1HRA K");
  CHECK_FALSE(cw.take(&chunk, 100));
}

TEST_CASE("CwCoalescer splits at the 64-byte TrxNet payload without waiting") {
  CwCoalescer cw;
  std::string text(100, 'E');
  cw.add(text, 0);
  std::string chunk;
  REQUIRE(cw.take(&chunk, 1));
  CHECK(chunk.size() == 64);
  CHECK_FALSE(cw.take(&chunk, 2));   // the 36-byte rest waits for the gather window
  REQUIRE(cw.take(&chunk, 30));
  CHECK(chunk.size() == 36);
  cw.add("TEST", 50);
  cw.clear();
  CHECK_FALSE(cw.take(&chunk, 200));
}

TEST_CASE("config: TrxNet backends default off, round-trip through JSON") {
  Config defaults;
  CHECK(defaults.cat.backend == "hamlib");
  CHECK(defaults.keying.cwBackend == "serial");
  CHECK(defaults.keying.pttBackend == "serial");
  CHECK_FALSE(defaults.usesTrxnet());
  CHECK(defaults.trxnet.localPort == 5684);
  CHECK(defaults.trxnet.networkPort == 5683);
  CHECK(defaults.trxnet.netId == 0x01);

  Config c;
  c.cat.backend = "trxnet";
  c.keying.pttBackend = "trxnet";
  c.trxnet.peer = "OI3.01";
  c.trxnet.netId = 0x0a;
  c.trxnet.localPort = 5683;
  std::string error;
  Config back = parseConfigJson(configToJsonString(c), &error);
  CHECK(error.empty());
  CHECK(back.catOverTrxnet());
  CHECK_FALSE(back.cwOverTrxnet());
  CHECK(back.pttOverTrxnet());
  CHECK(back.trxnet.peer == "OI3.01");
  CHECK(back.trxnet.netId == 0x0a);
  CHECK(back.trxnet.localPort == 5683);
  CHECK(back.trxnet.networkPort == 5683);
}
