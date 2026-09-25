#pragma once

// RTTY text on TrxNet: both decoders' output and what this station sends, for
// analysis on another device (grilled 2026-09-25). Shared by the firmware sketch
// and the native regression test, so the rules are exercised without a radio.
//
// Three state topics, owned by this interface:
//   /rtty1    DEC 1's output, exactly as the decoder hands it to the RX tape
//   /rtty2    DEC 2's, likewise (nothing while DEC 2 is switched off)
//   /rtty-tx  every RTTY transmission's text, at the moment it starts
// Payload: [seq uint8][ASCII, 1..63 bytes], no terminator. seq counts packets per
// topic and wraps; a skipped number is a lost packet, or characters dropped here
// because a buffer overflowed. [seq][0x00] on /rtty-tx = the transmission was
// aborted and what followed did not go out.
//
// Subscribe, not broadcast. A listener sends /s-rtty (uint8) to this interface:
// 1 subscribes or renews, 0 unsubscribes. A subscription lapses RTTY_STREAM_LEASE_MS
// after its last renewal, so a listener that dies stops the stream on its own and
// nothing is left sending into the void. Renew every 30 s, the announce period.
//
// TRX_NON on purpose, not TRX_CON: /s-cw (FSK through an external TrxNet keyer)
// and /s-lptune share the one CON pending queue, and a listener that vanished
// without unsubscribing would keep it full of retransmits for the whole lease --
// failing the transmissions themselves. seq is how a listener sees a loss.
//
// Text is only buffered while the switch is on AND somebody listens. The buffers
// are allocated on the heap on first use: the sketch has almost no static DRAM to
// spare, and a station that never streams should not pay for this at all.

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static const uint8_t  RTTY_STREAM_MAX_SUBS = 4;
static const uint32_t RTTY_STREAM_LEASE_MS = 90000;
static const uint8_t  RTTY_STREAM_NAME_MAX = 32;   // TRXNET_MAX_DEVICE_NAME
static const uint8_t  RTTY_STREAM_CHUNK    = 63;   // + seq = TRXNET_MAX_PAYLOAD

enum RttyStreamId : uint8_t { RTTY_STREAM_RX1, RTTY_STREAM_RX2, RTTY_STREAM_TX, RTTY_STREAM_COUNT };

// RX arrives a few characters per AUD1 frame and leaves on the next loop pass;
// TX arrives as a whole message (200 characters at most over AFSK).
static const uint16_t RTTY_STREAM_BUF_SIZE[RTTY_STREAM_COUNT] = {128, 128, 256};
static const char* const RTTY_STREAM_TOPIC[RTTY_STREAM_COUNT] = {"/rtty1", "/rtty2", "/rtty-tx"};

enum RttyStreamSubResult : uint8_t {
  RTTY_SUB_IGNORED, RTTY_SUB_ADDED, RTTY_SUB_RENEWED, RTTY_SUB_REMOVED, RTTY_SUB_FULL
};

struct RttyStreamSub {
  char     name[RTTY_STREAM_NAME_MAX];
  uint32_t lastMs;
  bool     used;
};

struct RttyStream {
  bool          enabled;
  RttyStreamSub subs[RTTY_STREAM_MAX_SUBS];
  char*         buf[RTTY_STREAM_COUNT];
  uint16_t      len[RTTY_STREAM_COUNT];
  uint8_t       seq[RTTY_STREAM_COUNT];
  bool          lost[RTTY_STREAM_COUNT];   // characters dropped since the last packet
  bool          txAbort;                  // marker owed after the TX text
  uint32_t      packets;                  // diagnostics, per subscriber sent
  uint32_t      droppedChars;
  uint16_t      refused;                  // subscriptions turned away: table full
};

static inline void rttyStreamClearText(RttyStream& s) {
  for (uint8_t i = 0; i < RTTY_STREAM_COUNT; i++) s.len[i] = 0;
  s.txAbort = false;
}

static inline void rttyStreamSetEnabled(RttyStream& s, bool on) {
  s.enabled = on;
  if (on) return;
  for (uint8_t i = 0; i < RTTY_STREAM_MAX_SUBS; i++) s.subs[i].used = false;
  rttyStreamClearText(s);
}

static inline void rttyStreamExpire(RttyStream& s, uint32_t now) {
  bool any = false;
  for (uint8_t i = 0; i < RTTY_STREAM_MAX_SUBS; i++) {
    RttyStreamSub& sub = s.subs[i];
    if (sub.used && (int32_t)(now - sub.lastMs) >= (int32_t)RTTY_STREAM_LEASE_MS) sub.used = false;
    any = any || sub.used;
  }
  if (!any) rttyStreamClearText(s);
}

static inline bool rttyStreamActive(RttyStream& s, uint32_t now) {
  if (!s.enabled) return false;
  rttyStreamExpire(s, now);
  for (uint8_t i = 0; i < RTTY_STREAM_MAX_SUBS; i++) if (s.subs[i].used) return true;
  return false;
}

// `from` is the sender's peer name as TrxNet resolved it; empty = not in the peer
// table yet, and there is nobody to send to.
static inline RttyStreamSubResult rttyStreamSubscribe(RttyStream& s, const char* from,
                                                      const uint8_t* data, size_t len, uint32_t now) {
  if (!s.enabled || !from || !from[0] || !data || len < 1) return RTTY_SUB_IGNORED;
  if (strlen(from) >= RTTY_STREAM_NAME_MAX) return RTTY_SUB_IGNORED;
  rttyStreamExpire(s, now);
  int free = -1;
  for (uint8_t i = 0; i < RTTY_STREAM_MAX_SUBS; i++) {
    RttyStreamSub& sub = s.subs[i];
    if (!sub.used) { if (free < 0) free = i; continue; }
    if (strcmp(sub.name, from) != 0) continue;
    if (data[0] == 0) {
      sub.used = false;
      rttyStreamExpire(s, now);   // the last one gone drops what was waiting
      return RTTY_SUB_REMOVED;
    }
    sub.lastMs = now;
    return RTTY_SUB_RENEWED;
  }
  if (data[0] == 0) return RTTY_SUB_IGNORED;
  if (free < 0) { s.refused++; return RTTY_SUB_FULL; }
  RttyStreamSub& sub = s.subs[free];
  strncpy(sub.name, from, RTTY_STREAM_NAME_MAX - 1);
  sub.name[RTTY_STREAM_NAME_MAX - 1] = '\0';
  sub.lastMs = now;
  sub.used = true;
  return RTTY_SUB_ADDED;
}

static inline void rttyStreamAppend(RttyStream& s, RttyStreamId id, const char* text, size_t n,
                                    uint32_t now) {
  if (id >= RTTY_STREAM_COUNT || !text || !n || !rttyStreamActive(s, now)) return;
  if (!s.buf[id]) {
    s.buf[id] = (char*)malloc(RTTY_STREAM_BUF_SIZE[id]);
    if (!s.buf[id]) { s.lost[id] = true; s.droppedChars += n; return; }
  }
  for (size_t i = 0; i < n; i++) {
    if (text[i] == '\0') continue;   // 0x00 alone is the abort marker's byte
    if (s.len[id] >= RTTY_STREAM_BUF_SIZE[id]) { s.lost[id] = true; s.droppedChars++; continue; }
    s.buf[id][s.len[id]++] = text[i];
  }
}

static inline void rttyStreamAbortTx(RttyStream& s, uint32_t now) {
  if (rttyStreamActive(s, now)) s.txAbort = true;
}

// publish(ctx, peer, topic, data, len) sends one packet to one subscriber. At
// most maxPackets packets (each to every subscriber) leave per call, so a long
// TX message spreads over a few loop passes instead of stalling one.
typedef void (*RttyStreamPublishFn)(void* ctx, const char* peer, const char* topic,
                                    const uint8_t* data, size_t len);

static inline void rttyStreamSendPacket(RttyStream& s, RttyStreamId id, const uint8_t* pkt,
                                        size_t len, RttyStreamPublishFn publish, void* ctx) {
  for (uint8_t i = 0; i < RTTY_STREAM_MAX_SUBS; i++) {
    if (!s.subs[i].used) continue;
    publish(ctx, s.subs[i].name, RTTY_STREAM_TOPIC[id], pkt, len);
    s.packets++;
  }
}

static inline void rttyStreamDrain(RttyStream& s, uint32_t now, uint8_t maxPackets,
                                   RttyStreamPublishFn publish, void* ctx) {
  if (!rttyStreamActive(s, now)) return;
  uint8_t pkt[1 + RTTY_STREAM_CHUNK];
  uint8_t sent = 0;
  for (uint8_t id = 0; id < RTTY_STREAM_COUNT && sent < maxPackets; id++) {
    while (s.len[id] > 0 && sent < maxPackets) {
      uint16_t n = s.len[id] < RTTY_STREAM_CHUNK ? s.len[id] : RTTY_STREAM_CHUNK;
      if (s.lost[id]) { s.seq[id]++; s.lost[id] = false; }   // the gap says so
      pkt[0] = s.seq[id]++;
      memcpy(pkt + 1, s.buf[id], n);
      rttyStreamSendPacket(s, (RttyStreamId)id, pkt, 1 + n, publish, ctx);
      s.len[id] -= n;
      if (s.len[id]) memmove(s.buf[id], s.buf[id] + n, s.len[id]);
      sent++;
    }
  }
  if (s.txAbort && s.len[RTTY_STREAM_TX] == 0 && sent < maxPackets) {
    if (s.lost[RTTY_STREAM_TX]) { s.seq[RTTY_STREAM_TX]++; s.lost[RTTY_STREAM_TX] = false; }
    pkt[0] = s.seq[RTTY_STREAM_TX]++;
    pkt[1] = 0x00;
    rttyStreamSendPacket(s, RTTY_STREAM_TX, pkt, 2, publish, ctx);
    s.txAbort = false;
  }
}
