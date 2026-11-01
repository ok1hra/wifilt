// Native regression test for watch_hub.h (WATCH: viewers follow the holder's
// data page). docs/watch-implementace.md.
//
//   g++ -std=c++17 -Wall -Wextra -o /tmp/watch-hub-smoke tools/watch-hub-smoke.cpp && /tmp/watch-hub-smoke

#include <cassert>
#include <cstdio>
#include <string>
#include <vector>
#include "../watch_hub.h"

static int checks = 0;
#define CHECK(x) do { assert(x); checks++; } while (0)

// Strip the WebSocket header off a queued server frame.
static std::string payloadOf(const std::string &frame) {
  uint8_t second = uint8_t(frame[1]);
  size_t offset = second < 126 ? 2 : second == 126 ? 4 : 10;
  return frame.substr(offset);
}

static void headerTests() {
  CHECK(watchWsHeader(0x1, 5) == std::string("\x81\x05", 2));
  CHECK(watchWsHeader(0x2, 300) == std::string("\x82\x7e\x01\x2c", 4));
  std::string big = watchWsHeader(0x1, 70000);
  CHECK(big.size() == 10 && uint8_t(big[1]) == 127);
  CHECK(uint8_t(big[7]) == 0x01 && uint8_t(big[8]) == 0x11 && uint8_t(big[9]) == 0x70);
  CHECK(watchRoleIndex("mercury") == WATCH_MERCURY);
  CHECK(watchRoleIndex("cw") == -1 && watchRoleIndex(nullptr) == -1);
}

static void snapshotTests() {
  WatchHub hub;
  CHECK(!watchSetSnapshot(hub, -1, "{}", 0));
  CHECK(!watchSetSnapshot(hub, WATCH_JS8, "", 0));
  CHECK(!watchSetSnapshot(hub, WATCH_JS8, std::string(WATCH_SNAPSHOT_MAX + 1, ' '), 0));
  CHECK(watchSetSnapshot(hub, WATCH_JS8, "{\"a\":1}", 1000));
  CHECK(watchSetSnapshot(hub, WATCH_JS8, "{\"a\":2}", 2000));
  CHECK(hub.snapshots[WATCH_JS8].json == "{\"a\":2}" && hub.snapshots[WATCH_JS8].seq == 2);
  CHECK(watchSnapshotMessage(hub, WATCH_JS8, 2500) ==
        "{\"type\":\"snapshot\",\"role\":\"js8\",\"seq\":2,\"ageMs\":500,\"data\":{\"a\":2}}");

  // Replay order: snapshots by role, then events oldest first.
  watchSetSnapshot(hub, WATCH_WSPR, "[1]", 2000);
  watchAppendEvent(hub, WATCH_RTTY, "{\"r1\":\"CQ\"}");
  watchAppendEvent(hub, WATCH_RTTY, "{\"r1\":\" DE\"}");
  std::vector<std::pair<std::string, int>> replayed;
  watchReplay(hub, 3000, [&](const std::string &message, int8_t role) { replayed.push_back({message, role}); });
  CHECK(replayed.size() == 4);
  CHECK(replayed[0].second == WATCH_JS8 && replayed[1].second == WATCH_WSPR);
  CHECK(replayed[2].second == -1 && replayed[2].first.find("\"seq\":4") != std::string::npos);
  CHECK(replayed[3].first == "{\"type\":\"event\",\"role\":\"rtty\",\"seq\":5,\"data\":{\"r1\":\" DE\"}}");
}

static void eventRingTests() {
  WatchHub hub;
  for (size_t index = 0; index < WATCH_EVENT_RING + 10; index++) watchAppendEvent(hub, WATCH_JTTY, "{}");
  CHECK(hub.events.size() == WATCH_EVENT_RING);
  CHECK(hub.events.front().seq == 11);
  WatchHub bytes;
  std::string fat(4000, 'x');
  for (int index = 0; index < 40; index++) watchAppendEvent(bytes, WATCH_RTTY, "\"" + fat + "\"");
  CHECK(bytes.eventBytes <= WATCH_EVENT_RING_BYTES);
  size_t sum = 0;
  for (const WatchEvent &event : bytes.events) sum += event.message.size();
  CHECK(sum == bytes.eventBytes);
}

static void queueTests() {
  WatchOut out;
  CHECK(watchQueueText(out, "{\"type\":\"hello\"}"));
  CHECK(watchQueueText(out, "{\"s\":1}", WATCH_JS8));
  CHECK(watchQueueText(out, "{\"s\":2}", WATCH_JS8));       // replaces the unsent one
  CHECK(out.frames.size() == 2);
  CHECK(payloadOf(out.frames[1].bytes) == "{\"s\":2}");
  size_t total = 0;
  for (const WatchFrame &frame : out.frames) total += frame.bytes.size();
  CHECK(out.pending == total);

  // A snapshot already partly on the wire is never rewritten under the socket.
  WatchOut partial;
  watchQueueText(partial, "{\"s\":1}", WATCH_WSPR);
  std::string wire;
  watchDrain(partial, [&](const char *data, size_t length) {
    size_t take = length > 3 ? 3 : length; wire.append(data, take); return int(take == 3 ? 3 : 0);
  });
  CHECK(partial.frontSent == 3);
  watchQueueText(partial, "{\"s\":2}", WATCH_WSPR);
  CHECK(partial.frames.size() == 2);
  CHECK(watchDrain(partial, [&](const char *data, size_t length) { wire.append(data, length); return int(length); }));
  CHECK(partial.frames.empty() && partial.pending == 0);
  CHECK(wire == watchWsHeader(1, 7) + "{\"s\":1}" + watchWsHeader(1, 7) + "{\"s\":2}");

  // Fatal send drops the viewer.
  WatchOut dead;
  watchQueueText(dead, "{}");
  CHECK(!watchDrain(dead, [](const char *, size_t) { return -1; }));

  // Text backlog cap.
  WatchOut slow;
  std::string chunk(1024 * 1024, 'x');
  bool kept = true;
  for (int index = 0; index < 5 && kept; index++) kept = watchQueueText(slow, chunk);
  CHECK(!kept);
}

static void audioTests() {
  WatchHub hub;
  watchAudioReset(hub, 77);
  std::vector<std::vector<uint8_t>> frames;
  auto emit = [&](const uint8_t *data, size_t length) { frames.emplace_back(data, data + length); };
  uint8_t packet[160];
  for (int index = 0; index < 160; index++) packet[index] = uint8_t(index);
  watchAudioIn(hub, packet, 160, 10, 0, emit);
  watchAudioIn(hub, packet, 160, 11, 0, emit);
  watchAudioIn(hub, packet, 160, 11, 0, emit);              // duplicate ignored
  watchAudioIn(hub, packet, 160, 12, 0, emit);
  CHECK(frames.empty() && hub.audio.size() == 480);
  watchAudioIn(hub, packet, 160, 13, 0, emit);              // 640 >= 512 -> flush
  CHECK(frames.size() == 1 && frames[0].size() == 40 + 640);
  const std::vector<uint8_t> &first = frames[0];
  CHECK(first[0] == 'A' && first[3] == '1' && first[5] == 1);
  CHECK(first[15] == 77 && first[19] == 0);                  // streamId, seq 0
  CHECK(first[6] == 0 && first[7] == 0);                     // no flags at hub level
  watchAudioIn(hub, packet, 160, 16, 50, emit);             // gap of 2 packets
  watchAudioFlush(hub, 100, emit);
  CHECK(frames.size() == 2);
  const std::vector<uint8_t> &second = frames[1];
  CHECK(second[7] == 0x04 && second[19] == 1);
  uint64_t firstSample = 0;
  for (int index = 24; index < 32; index++) firstSample = (firstSample << 8) | second[index];
  CHECK(firstSample == 640 + 2 * 160);

  // Per-viewer flags: FIRST once, DISCONTINUITY after a backlog drop.
  WatchOut viewer;
  CHECK(watchQueueAudio(viewer, frames[0].data(), frames[0].size()));
  CHECK(payloadOf(viewer.frames[0].bytes)[7] == 0x01);
  CHECK(watchQueueAudio(viewer, frames[0].data(), frames[0].size()));
  CHECK(payloadOf(viewer.frames[1].bytes)[7] == 0x00);
  watchQueueText(viewer, std::string(WATCH_AUDIO_BACKLOG, 'x'));
  CHECK(!watchQueueAudio(viewer, frames[0].data(), frames[0].size()));
  CHECK(viewer.audioDrops == 1);
  watchDrain(viewer, [](const char *, size_t length) { return int(length); });
  CHECK(watchQueueAudio(viewer, frames[0].data(), frames[0].size()));
  CHECK(payloadOf(viewer.frames[0].bytes)[7] == 0x04);
  CHECK(!watchQueueAudio(viewer, frames[0].data(), 10));
}

int main() {
  headerTests();
  snapshotTests();
  eventRingTests();
  queueTests();
  audioTests();
  printf("watch-hub-smoke: %d/%d checks passed\n", checks, checks);
  return 0;
}
