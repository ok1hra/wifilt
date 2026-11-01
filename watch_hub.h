#pragma once

// WATCH: other browsers follow the data page of whoever holds the radio.
//
// Decoding lives in the holder's browser only (js8_session.h), and the audio
// socket takes exactly one client. WATCH does not add a second decoder: the
// holder's page hands the binary what it already shows -- a snapshot of its
// state per role, and the RTTY/JTTY text it already streams over AUD1 -- and the
// binary fans that out to read-only viewers on /watchws. A viewer may also take
// a copy of the RX audio to draw its own waterfall; that is an FFT, not a
// decoder, and costs the holder nothing.
//
// Native build only. The box has no RAM for per-viewer queues, and its
// WiFiClient::write can hold the loop for up to 10 s per stalled peer -- the
// exact reason the DX cluster relay stayed single-client
// (docs/dxc-multi-client-implementace.md).
//
// Everything here is socket-free, so tools/watch-hub-smoke.cpp exercises the
// queueing rules without a radio or a browser. The sketch owns the sockets.

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <deque>
#include <string>
#include <vector>

static const uint8_t WATCH_MAX_VIEWERS = 8;
// About 4 s of 8 kHz u-law. A viewer further behind than this loses audio frames
// (marked DISCONTINUITY) but keeps every text message.
static const size_t  WATCH_AUDIO_BACKLOG = 32 * 1024;
// A viewer this far behind on text is cut; it reconnects to fresh snapshots.
static const size_t  WATCH_TEXT_BACKLOG = 4 * 1024 * 1024;
// The snapshot arrives as one POST body, and the web server buffers a request
// in an Arduino String, whose length is 16 bits: anything near 64 kB never
// completes. The pages size what they publish to stay under this
// (watch-publish.js MAX_BODY_BYTES).
static const size_t  WATCH_SNAPSHOT_MAX = 60 * 1024;
// Recent RTTY/JTTY events a newly connected viewer is replayed, so its tape
// starts with what was on the holder's screen rather than empty.
static const size_t  WATCH_EVENT_RING = 256;
static const size_t  WATCH_EVENT_RING_BYTES = 64 * 1024;
// Coalesced like the holder's own AUD1 stream: < 1 MSS, at least every 100 ms.
static const size_t  WATCH_AUDIO_FRAME_BYTES = 512;
static const uint32_t WATCH_AUDIO_FLUSH_MS = 100;

enum WatchRole : uint8_t { WATCH_JS8 = 0, WATCH_WSPR, WATCH_RTTY, WATCH_JTTY, WATCH_MERCURY, WATCH_ROLES };

inline const char *watchRoleName(int role) {
  static const char *const names[WATCH_ROLES] = {"js8", "wspr", "rtty", "jtty", "mercury"};
  return role >= 0 && role < WATCH_ROLES ? names[role] : "";
}

inline int watchRoleIndex(const char *name) {
  if (!name) return -1;
  for (int role = 0; role < WATCH_ROLES; role++)
    if (strcmp(name, watchRoleName(role)) == 0) return role;
  return -1;
}

// Server -> browser frames are never masked and never fragmented.
inline std::string watchWsHeader(uint8_t opcode, size_t length) {
  std::string header;
  header += char(0x80 | opcode);
  if (length < 126) {
    header += char(length);
  } else if (length <= 0xFFFF) {
    header += char(126);
    header += char(length >> 8);
    header += char(length);
  } else {
    header += char(127);
    for (int shift = 56; shift >= 0; shift -= 8) header += char(uint64_t(length) >> shift);
  }
  return header;
}

// ── One viewer's outgoing queue ──────────────────────────────────────────────
// Whole frames, so a dropped or replaced one never tears the byte stream.
struct WatchFrame {
  std::string bytes;
  int8_t snapshotRole = -1;   // a snapshot may be replaced by a newer one while unsent
  bool audio = false;
};

struct WatchOut {
  std::deque<WatchFrame> frames;
  size_t frontSent = 0;       // bytes of frames.front() already on the wire
  size_t pending = 0;         // unsent bytes across the queue
  bool audioStarted = false;  // FIRST goes on this viewer's first audio frame
  bool audioMissed = false;   // DISCONTINUITY goes on the next one after a drop
  uint32_t audioDrops = 0;
};

inline void watchOutReset(WatchOut &out) {
  out.frames.clear();
  out.frontSent = out.pending = 0;
  out.audioStarted = out.audioMissed = false;
  out.audioDrops = 0;
}

// Queue a text message. A snapshot replaces an older unsent snapshot of the same
// role in place, so a slow viewer gets the newest state instead of a backlog of
// stale ones. Returns false when the viewer is too far behind to keep.
inline bool watchQueueText(WatchOut &out, const std::string &json, int8_t snapshotRole = -1) {
  std::string frame = watchWsHeader(0x1, json.size()) + json;
  if (snapshotRole >= 0) {
    for (size_t index = out.frontSent ? 1 : 0; index < out.frames.size(); index++) {
      WatchFrame &queued = out.frames[index];
      if (queued.snapshotRole != snapshotRole) continue;
      out.pending = out.pending - queued.bytes.size() + frame.size();
      queued.bytes.swap(frame);
      return out.pending <= WATCH_TEXT_BACKLOG;
    }
  }
  out.pending += frame.size();
  WatchFrame queued;
  queued.bytes.swap(frame);
  queued.snapshotRole = snapshotRole;
  out.frames.push_back(std::move(queued));
  return out.pending <= WATCH_TEXT_BACKLOG;
}

// Queue one AUD1 RX frame (40-byte header + u-law). The per-viewer FIRST and
// DISCONTINUITY flags are patched into this viewer's copy. Returns false when
// the frame was dropped for backlog.
inline bool watchQueueAudio(WatchOut &out, const uint8_t *frame, size_t length) {
  if (length < 40) return false;
  if (out.pending > WATCH_AUDIO_BACKLOG) {
    out.audioDrops++;
    out.audioMissed = true;
    return false;
  }
  std::string payload(reinterpret_cast<const char *>(frame), length);
  uint16_t flags = uint16_t((uint8_t(payload[6]) << 8) | uint8_t(payload[7]));
  if (!out.audioStarted) flags |= 0x0001;
  if (out.audioMissed) flags |= 0x0004;
  payload[6] = char(flags >> 8);
  payload[7] = char(flags);
  out.audioStarted = true;
  out.audioMissed = false;
  WatchFrame queued;
  queued.bytes = watchWsHeader(0x2, payload.size()) + payload;
  queued.audio = true;
  out.pending += queued.bytes.size();
  out.frames.push_back(std::move(queued));
  return true;
}

// Push what the socket takes without blocking. send(data, length) returns >0
// sent, 0 would block, <0 fatal -- netSendNonBlocking()'s contract. Returns
// false when the peer is gone.
template <class Send>
inline bool watchDrain(WatchOut &out, Send send) {
  while (!out.frames.empty()) {
    WatchFrame &front = out.frames.front();
    size_t left = front.bytes.size() - out.frontSent;
    int sent = send(front.bytes.data() + out.frontSent, left);
    if (sent < 0) return false;
    if (sent == 0) return true;
    out.frontSent += size_t(sent);
    out.pending -= size_t(sent);
    if (out.frontSent < front.bytes.size()) return true;
    out.frames.pop_front();
    out.frontSent = 0;
  }
  return true;
}

// ── Shared state ─────────────────────────────────────────────────────────────
struct WatchSnapshot {
  std::string json;     // empty = this role never published
  uint32_t seq = 0;
  uint32_t atMs = 0;    // millis() when it arrived
};

struct WatchEvent {
  uint32_t seq;
  std::string message;  // the full {"type":"event",...} text, ready to queue
};

struct WatchHub {
  WatchSnapshot snapshots[WATCH_ROLES];
  std::deque<WatchEvent> events;
  size_t eventBytes = 0;
  uint32_t seq = 0;

  // The viewers' own RX audio stream, independent of the holder's AUD1 stream
  // (which restarts its numbering on every holder connect).
  std::vector<uint8_t> audio;
  uint32_t audioStreamId = 1;
  uint32_t audioSeq = 0;
  uint64_t audioFirstSample = 0;
  bool audioDiscontinuity = false;
  bool radioSeqValid = false;
  uint16_t radioExpected = 0;
  uint32_t audioLastFlushMs = 0;
};

inline std::string watchSnapshotMessage(const WatchHub &hub, int role, uint32_t nowMs) {
  const WatchSnapshot &snapshot = hub.snapshots[role];
  std::string message = "{\"type\":\"snapshot\",\"role\":\"";
  message += watchRoleName(role);
  message += "\",\"seq\":" + std::to_string(snapshot.seq);
  message += ",\"ageMs\":" + std::to_string(uint32_t(nowMs - snapshot.atMs));
  message += ",\"data\":" + snapshot.json + "}";
  return message;
}

// The JSON comes from the holder's page and is passed through unparsed; a
// viewer that cannot parse a message skips it. Only the size is policed here.
inline bool watchSetSnapshot(WatchHub &hub, int role, const std::string &json, uint32_t nowMs) {
  if (role < 0 || role >= WATCH_ROLES || json.empty() || json.size() > WATCH_SNAPSHOT_MAX) return false;
  WatchSnapshot &snapshot = hub.snapshots[role];
  snapshot.json = json;
  snapshot.seq = ++hub.seq;
  snapshot.atMs = nowMs;
  return true;
}

// Store an event and return the message to send to the viewers now.
inline std::string watchAppendEvent(WatchHub &hub, int role, const std::string &json) {
  WatchEvent event;
  event.seq = ++hub.seq;
  event.message = "{\"type\":\"event\",\"role\":\"";
  event.message += watchRoleName(role);
  event.message += "\",\"seq\":" + std::to_string(event.seq) + ",\"data\":" + json + "}";
  hub.eventBytes += event.message.size();
  hub.events.push_back(event);
  while (!hub.events.empty() &&
         (hub.events.size() > WATCH_EVENT_RING || hub.eventBytes > WATCH_EVENT_RING_BYTES)) {
    hub.eventBytes -= hub.events.front().message.size();
    hub.events.pop_front();
  }
  return event.message;
}

// Everything a newly connected viewer needs after its hello: the newest
// snapshot of each role, then the recent events in order.
template <class Queue>
inline void watchReplay(const WatchHub &hub, uint32_t nowMs, Queue queue) {
  for (int role = 0; role < WATCH_ROLES; role++)
    if (!hub.snapshots[role].json.empty()) queue(watchSnapshotMessage(hub, role, nowMs), int8_t(role));
  for (const WatchEvent &event : hub.events) queue(event.message, int8_t(-1));
}

// ── RX audio for the viewers' waterfall ──────────────────────────────────────
// Same AUD1 RX_ULAW layout the holder gets (docs/aud1-audio-websocket-protocol.md),
// so the viewer page parses it with the same rules.
template <class Emit>
inline void watchAudioFlush(WatchHub &hub, uint32_t nowMs, Emit emit) {
  hub.audioLastFlushMs = nowMs;
  if (hub.audio.empty()) return;
  uint8_t header[40];
  memcpy(header, "AUD1", 4);
  header[4] = 1; header[5] = 1;                      // version 1, RX_ULAW
  uint16_t flags = hub.audioDiscontinuity ? 0x0004 : 0;
  auto be = [](uint8_t *at, uint64_t value, int bytes) {
    for (int index = bytes - 1; index >= 0; index--) { at[index] = uint8_t(value); value >>= 8; }
  };
  be(header + 6, flags, 2); be(header + 8, 40, 2); be(header + 10, 0, 2);
  be(header + 12, hub.audioStreamId, 4); be(header + 16, hub.audioSeq, 4);
  be(header + 20, 8000, 4); be(header + 24, hub.audioFirstSample, 8);
  be(header + 32, 0, 4); be(header + 36, hub.audio.size(), 4);
  std::vector<uint8_t> frame(header, header + 40);
  frame.insert(frame.end(), hub.audio.begin(), hub.audio.end());
  emit(frame.data(), frame.size());
  hub.audioFirstSample += hub.audio.size();
  hub.audioSeq++;
  hub.audioDiscontinuity = false;
  hub.audio.clear();
}

// One radio datagram (~160 B / 20 ms). A radio sequence gap advances the sample
// clock and marks the next frame, exactly as lanAudioHandler() does for AUD1.
template <class Emit>
inline void watchAudioIn(WatchHub &hub, const uint8_t *data, size_t length, uint16_t radioSequence,
                         uint32_t nowMs, Emit emit) {
  if (!length) return;
  if (hub.radioSeqValid) {
    int16_t delta = int16_t(radioSequence - hub.radioExpected);
    if (delta < 0) return;                           // duplicate or stale
    if (delta > 0) {
      watchAudioFlush(hub, nowMs, emit);
      hub.audioFirstSample += uint64_t(uint16_t(delta)) * length;
      hub.audioDiscontinuity = true;
    }
  }
  hub.radioExpected = uint16_t(radioSequence + 1);
  hub.radioSeqValid = true;
  if (length > WATCH_AUDIO_FRAME_BYTES * 2) {
    watchAudioFlush(hub, nowMs, emit);
    hub.audioFirstSample += length;
    hub.audioDiscontinuity = true;
    return;
  }
  hub.audio.insert(hub.audio.end(), data, data + length);
  if (hub.audio.size() >= WATCH_AUDIO_FRAME_BYTES) watchAudioFlush(hub, nowMs, emit);
}

// Called when no viewer takes audio any more: the next stream starts clean.
inline void watchAudioReset(WatchHub &hub, uint32_t streamId) {
  hub.audio.clear();
  hub.audioStreamId = streamId ? streamId : 1;
  hub.audioSeq = 0;
  hub.audioFirstSample = 0;
  hub.audioDiscontinuity = false;
  hub.radioSeqValid = false;
}
