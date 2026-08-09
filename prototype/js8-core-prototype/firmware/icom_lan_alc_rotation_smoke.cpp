// The CI-V telemetry rotation during browser TX, with and without the fast-ALC
// mode the gain calibration asks for.
//
// What this is really guarding is a rate, not a switch statement. The browser
// search spends one step per ALC reading, the carrier it runs on is capped, and
// the poll period cannot be shortened (250 ms is the compensation for control
// starvation under audio load). So the only lever left is how many slots of the
// rotation ALC gets -- and if a later edit quietly drops one, the calibration
// does not break, it just silently halves the number of steps it can take
// inside one carrier. That is exactly the kind of regression no on-radio test
// would ever be blamed for.
//
// Build: prototype/js8-core-prototype/build-icom-lan-alc-rotation-smoke.sh

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#define private public
#include "../../../icomLanClient.h"
#undef private

WiFiStub WiFi;
SerialStub Serial;
uint32_t testMillis = 0;

void lanCivFrameHandler(const uint8_t*, size_t) {}
void lanSecondaryCivFrameHandler(uint8_t, const uint8_t*, size_t) {}
void lanCivFrameRoute(uint8_t, const uint8_t*, size_t) {}
void lanAudioHandler(const uint8_t*, size_t, uint16_t) {}

static bool ok = true;
static void fail(const char* what) {
  std::fprintf(stderr, "FAIL %s\n", what);
  ok = false;
}

// A CI-V command as it appears inside the UDP payload: FE FE A4 E1 <body> FD.
static std::vector<uint8_t> civBody(const std::vector<uint8_t>& body) {
  std::vector<uint8_t> frame = {0xFE, 0xFE, 0xA4, 0xE1};
  frame.insert(frame.end(), body.begin(), body.end());
  frame.push_back(0xFD);
  return frame;
}

static bool packetCarries(const std::vector<uint8_t>& packet,
                          const std::vector<uint8_t>& body) {
  const std::vector<uint8_t> frame = civBody(body);
  return std::search(packet.begin(), packet.end(), frame.begin(), frame.end())
         != packet.end();
}

// Put a client in the state the rotation runs in: authenticated, CI-V open and
// answering, scope silenced, and streaming browser audio.
static void openForTx(IcomLanClient& client) {
  client.state = IcomLanClient::LAN_CONNECTED;
  client.civPort = 50002;
  client.civGotHere = true;
  client.civGotReady = true;
  client.civOpenSent = true;
  client.civGotData = true;
  client.scopeOff = true;
  client.lastCtrlRxMs = testMillis;
  client.lastCivDataMs = testMillis;
  client.setTxTrafficActive(true);
}

// A CI-V reply addressed back to us (to=E1), which is what clears the
// one-request-at-a-time gate. Without it the client waits out its 500 ms
// timeout and every second tick sends nothing -- correct behaviour against a
// mute radio, but it would halve the rotation under test for the wrong reason.
static std::vector<uint8_t> civReplyPacket() {
  const std::vector<uint8_t> frame = {0xFE, 0xFE, 0xE1, 0xA4, 0x03,
                                      0x00, 0x00, 0x00, 0x00, 0x00, 0xFD};
  std::vector<uint8_t> packet(0x15 + frame.size(), 0);
  packet[0] = static_cast<uint8_t>(packet.size());
  packet[4] = 0x00;
  packet[0x10] = 0xC1;
  packet[0x11] = static_cast<uint8_t>(frame.size());
  std::copy(frame.begin(), frame.end(), packet.begin() + 0x15);
  return packet;
}

// One poll period of a healthy loop, then whatever the client sent.
static std::vector<std::vector<uint8_t>> tick(IcomLanClient& client) {
  client.civUdp.writes.clear();
  testMillis += 250;
  client.lastCtrlRxMs = testMillis;
  client.civUdp.receive(client.radioIP, civReplyPacket());
  client.loop();
  client.lastCivDataMs = testMillis;
  return client.civUdp.writes;
}

// Which telemetry read a tick produced, as a single character, so a rotation
// can be asserted as a string. '.' means the tick sent no read at all.
static char readOf(const std::vector<std::vector<uint8_t>>& writes) {
  for (const auto& packet : writes) {
    if (packetCarries(packet, {0x1C, 0x00})) return 'T';   // PTT
    if (packetCarries(packet, {0x15, 0x11})) return 'P';   // power
    if (packetCarries(packet, {0x15, 0x12})) return 'S';   // SWR
    if (packetCarries(packet, {0x15, 0x13})) return 'A';   // ALC
    if (packetCarries(packet, {0x03}))       return 'F';   // frequency
  }
  return '.';
}

static std::string rotationOf(IcomLanClient& client, int ticks) {
  std::string seen;
  for (int i = 0; i < ticks; ++i) seen.push_back(readOf(tick(client)));
  return seen;
}

int main() {
  {
    // Normal browser TX: ALC joins PTT/Po/SWR, so every reading lands once per
    // second at the 250 ms pace. That is enough for the runtime limiter, which
    // only ever needs to notice that ALC moved off zero.
    IcomLanClient client;
    openForTx(client);
    const std::string seen = rotationOf(client, 8);
    if (seen != "TPSATPSA") {
      std::fprintf(stderr, "normal TX rotation is \"%s\", expected \"TPSATPSA\"\n",
                   seen.c_str());
      fail("normal TX rotation");
    }
  }

  {
    // Calibration: ALC in every other slot. Three of six, so 2 Hz -- and SWR
    // still present, because this is the mode that deliberately drives the
    // level up and must not go blind to a mismatched antenna while doing it.
    IcomLanClient client;
    openForTx(client);
    client.setAlcFast(true);
    const std::string seen = rotationOf(client, 12);
    if (seen != "ATASAPATASAP") {
      std::fprintf(stderr, "CAL rotation is \"%s\", expected \"ATASAPATASAP\"\n",
                   seen.c_str());
      fail("CAL rotation");
    }
    const size_t alc = std::count(seen.begin(), seen.end(), 'A');
    const size_t swr = std::count(seen.begin(), seen.end(), 'S');
    if (alc != 6) fail("CAL rotation does not read ALC at 2 Hz");
    if (swr != 2) fail("CAL rotation dropped SWR");
  }

  {
    // The phase is reset with the mode, so a run always opens on an ALC slot
    // instead of inheriting wherever the previous transmission stopped.
    IcomLanClient client;
    openForTx(client);
    rotationOf(client, 3);              // leave the counter mid-rotation
    client.setAlcFast(true);
    if (readOf(tick(client)) != 'A') fail("CAL rotation did not start on ALC");
  }

  {
    // Every ending of a transmission goes through setTxTrafficActive(false),
    // which is what makes "the flag cannot be left latched" true rather than
    // merely intended. A calibration that dies mid-search must not leave the
    // radio polled for ALC three times as often as for its own frequency.
    IcomLanClient client;
    openForTx(client);
    client.setAlcFast(true);
    client.setTxTrafficActive(false);
    if (client.alcFast()) fail("alcFast survived the end of TX traffic");

    client.setTxTrafficActive(true);
    const std::string seen = rotationOf(client, 4);
    if (seen != "TPSA") {
      std::fprintf(stderr, "rotation after a dead CAL run is \"%s\", expected \"TPSA\"\n",
                   seen.c_str());
      fail("rotation did not return to normal after a dead CAL run");
    }
  }

  {
    // Outside browser TX nothing changes: the fifteen-item station rotation
    // still opens on frequency. Calibration metering is a TX-only concern and
    // must not cost the idle page its dial readout.
    IcomLanClient client;
    openForTx(client);
    client.setAlcFast(true);
    client.setTxTrafficActive(false);
    client.auxRot = 0;
    if (readOf(tick(client)) != 'F') fail("idle rotation no longer starts on frequency");
  }

  if (ok) std::printf("icom-lan-alc-rotation-smoke: all checks passed\n");
  return ok ? 0 : 1;
}
