#pragma once

// JTTY text on TrxNet, the counterpart of rtty_stream.h (docs/jtty-
// implementace.md §8): decoded JTTY and what this station sends, for analysis
// on another device. Shared by the firmware sketch and the native regression
// test, so the rules are exercised without a radio.
//
// Two state topics, owned by this interface:
//   /jtty-rx  one packet per decoded frame's worth of new text:
//             [seq u8][msgId u8][flags u8][audioHz u16 LE][snr i8][ASCII 0..58]
//             flags bit0 = end of message. msgId numbers messages (it wraps);
//             a listener appends each packet's text to its msgId and closes
//             it on EOM. A text longer than 58 bytes is split, EOM on the last.
//   /jtty-tx  every JTTY transmission's text as it is committed to the air --
//             a whole message, or each live-entry segment as it goes:
//             [seq u8][ASCII 1..63]; [seq][0x00] = the transmission was aborted.
// seq counts packets per topic and wraps; a skipped number is a lost packet or
// one dropped here because the queue was full.
//
// Subscribe, not broadcast, exactly as for RTTY: /s-jtty (uint8) 1 subscribes or
// renews, 0 unsubscribes, a subscription lapses JTTY_STREAM_LEASE_MS after its
// last renewal. TRX_NON for the same reason rtty_stream.h gives.
//
// Unlike RTTY's character streams, JTTY arrives in whole records (a decoded
// frame, a TX segment), so the buffer is a small queue of finished packets,
// allocated on first use.

#include "rtty_stream.h"

static const uint8_t  JTTY_STREAM_MAX_SUBS = RTTY_STREAM_MAX_SUBS;
static const uint32_t JTTY_STREAM_LEASE_MS = RTTY_STREAM_LEASE_MS;
static const uint8_t  JTTY_STREAM_PAYLOAD  = 1 + RTTY_STREAM_CHUNK;   // TRXNET_MAX_PAYLOAD
static const uint8_t  JTTY_STREAM_RX_HEAD  = 6;
static const uint8_t  JTTY_STREAM_RX_TEXT  = JTTY_STREAM_PAYLOAD - JTTY_STREAM_RX_HEAD;
static const uint8_t  JTTY_STREAM_QUEUE    = 24;

enum JttyStreamTopic : uint8_t { JTTY_STREAM_RX, JTTY_STREAM_TX };
static const char* const JTTY_STREAM_TOPIC[2] = {"/jtty-rx", "/jtty-tx"};

struct JttyStreamPacket {
  uint8_t topic;
  uint8_t len;
  uint8_t data[JTTY_STREAM_PAYLOAD];
};

struct JttyStream {
  bool              enabled;
  RttyStreamSub     subs[JTTY_STREAM_MAX_SUBS];
  JttyStreamPacket* queue;
  uint8_t           head, count;
  uint8_t           seq[2];
  bool              lost[2];
  uint32_t          packets;    // diagnostics, per subscriber sent
  uint32_t          dropped;    // packets the full queue turned away
  uint16_t          refused;    // subscriptions turned away: table full
};

static inline void jttyStreamClear(JttyStream& s) { s.head = s.count = 0; }

static inline void jttyStreamSetEnabled(JttyStream& s, bool on) {
  s.enabled = on;
  if (on) return;
  for (uint8_t i = 0; i < JTTY_STREAM_MAX_SUBS; i++) s.subs[i].used = false;
  jttyStreamClear(s);
}

static inline void jttyStreamExpire(JttyStream& s, uint32_t now) {
  bool any = false;
  for (uint8_t i = 0; i < JTTY_STREAM_MAX_SUBS; i++) {
    RttyStreamSub& sub = s.subs[i];
    if (sub.used && (int32_t)(now - sub.lastMs) >= (int32_t)JTTY_STREAM_LEASE_MS) sub.used = false;
    any = any || sub.used;
  }
  if (!any) jttyStreamClear(s);
}

static inline bool jttyStreamActive(JttyStream& s, uint32_t now) {
  if (!s.enabled) return false;
  jttyStreamExpire(s, now);
  for (uint8_t i = 0; i < JTTY_STREAM_MAX_SUBS; i++) if (s.subs[i].used) return true;
  return false;
}

// Same table rules as rttyStreamSubscribe (one lease per peer name).
static inline RttyStreamSubResult jttyStreamSubscribe(JttyStream& s, const char* from,
                                                      const uint8_t* data, size_t len, uint32_t now) {
  if (!s.enabled || !from || !from[0] || !data || len < 1) return RTTY_SUB_IGNORED;
  if (strlen(from) >= RTTY_STREAM_NAME_MAX) return RTTY_SUB_IGNORED;
  jttyStreamExpire(s, now);
  int free = -1;
  for (uint8_t i = 0; i < JTTY_STREAM_MAX_SUBS; i++) {
    RttyStreamSub& sub = s.subs[i];
    if (!sub.used) { if (free < 0) free = i; continue; }
    if (strcmp(sub.name, from) != 0) continue;
    if (data[0] == 0) {
      sub.used = false;
      jttyStreamExpire(s, now);
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

// A slot at the queue's tail, or null (and the topic marked lossy) when full.
static inline JttyStreamPacket* jttyStreamSlot(JttyStream& s, JttyStreamTopic topic) {
  if (!s.queue) {
    s.queue = (JttyStreamPacket*)malloc(sizeof(JttyStreamPacket) * JTTY_STREAM_QUEUE);
    if (!s.queue) { s.lost[topic] = true; s.dropped++; return nullptr; }
  }
  if (s.count >= JTTY_STREAM_QUEUE) { s.lost[topic] = true; s.dropped++; return nullptr; }
  JttyStreamPacket* p = &s.queue[(s.head + s.count++) % JTTY_STREAM_QUEUE];
  p->topic = topic;
  if (s.lost[topic]) { s.seq[topic]++; s.lost[topic] = false; }   // the gap says so
  p->data[0] = s.seq[topic]++;
  return p;
}

static inline size_t jttyStreamClean(char* out, const char* text, size_t n, size_t max) {
  size_t k = 0;
  for (size_t i = 0; i < n && k < max; i++) if (text[i] != '\0') out[k++] = text[i];
  return k;
}

// New text of one received message (only what it gained since the last call).
static inline void jttyStreamRx(JttyStream& s, uint8_t msgId, bool eom, uint16_t audioHz, int8_t snr,
                                const char* text, size_t n, uint32_t now) {
  if (!jttyStreamActive(s, now)) return;
  if (!text) n = 0;
  size_t at = 0;
  do {
    size_t take = n - at < JTTY_STREAM_RX_TEXT ? n - at : JTTY_STREAM_RX_TEXT;
    bool last = at + take >= n;
    JttyStreamPacket* p = jttyStreamSlot(s, JTTY_STREAM_RX);
    if (!p) return;
    p->data[1] = msgId;
    p->data[2] = (last && eom) ? 1 : 0;
    p->data[3] = (uint8_t)(audioHz & 0xFF);
    p->data[4] = (uint8_t)(audioHz >> 8);
    p->data[5] = (uint8_t)snr;
    p->len = (uint8_t)(JTTY_STREAM_RX_HEAD +
      jttyStreamClean((char*)p->data + JTTY_STREAM_RX_HEAD, text ? text + at : "", take, JTTY_STREAM_RX_TEXT));
    at += take;
  } while (at < n);
}

static inline void jttyStreamTx(JttyStream& s, const char* text, size_t n, uint32_t now) {
  if (!text || !n || !jttyStreamActive(s, now)) return;
  for (size_t at = 0; at < n; at += RTTY_STREAM_CHUNK) {
    size_t take = n - at < RTTY_STREAM_CHUNK ? n - at : RTTY_STREAM_CHUNK;
    JttyStreamPacket* p = jttyStreamSlot(s, JTTY_STREAM_TX);
    if (!p) return;
    size_t k = jttyStreamClean((char*)p->data + 1, text + at, take, RTTY_STREAM_CHUNK);
    if (!k) { s.count--; s.seq[JTTY_STREAM_TX]--; continue; }   // nothing but NULs: not a packet
    p->len = (uint8_t)(1 + k);
  }
}

static inline void jttyStreamAbortTx(JttyStream& s, uint32_t now) {
  if (!jttyStreamActive(s, now)) return;
  JttyStreamPacket* p = jttyStreamSlot(s, JTTY_STREAM_TX);
  if (!p) return;
  p->data[1] = 0x00;
  p->len = 2;
}

// At most maxPackets packets (each to every subscriber) leave per call.
static inline void jttyStreamDrain(JttyStream& s, uint32_t now, uint8_t maxPackets,
                                   RttyStreamPublishFn publish, void* ctx) {
  if (!jttyStreamActive(s, now)) return;
  for (uint8_t sent = 0; s.count > 0 && sent < maxPackets; sent++) {
    JttyStreamPacket& p = s.queue[s.head];
    for (uint8_t i = 0; i < JTTY_STREAM_MAX_SUBS; i++) {
      if (!s.subs[i].used) continue;
      publish(ctx, s.subs[i].name, JTTY_STREAM_TOPIC[p.topic], p.data, p.len);
      s.packets++;
    }
    s.head = (s.head + 1) % JTTY_STREAM_QUEUE;
    s.count--;
  }
}
