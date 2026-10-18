// rkey_proto.h — Remote CW key protocol (CTRL = Paddle2IP  <->  RIG = OI3)
// Identical copy in both repositories: github.com/ok1hra/paddle2ip (ESP32)
// and github.com/ok1hra/oi3 (AVR). Both targets are little-endian.
//
// Principle: the sender's keyer GENERATES the elements, so it knows the ideal
// edge times. It sends those times (its own µs clock), never sampled audio.
// The receiver replays every edge at  t_sender + offset + playout_delay,
// so element lengths are reproduced exactly regardless of network jitter.
//
// Robustness: each KEY packet repeats the last RKEY_MAX_EV edges, so up to
// ~RKEY_MAX_EV-1 consecutive lost packets lose nothing. No retransmits, no TCP.
//
// Security: SipHash-2-4 (64-bit tag, shared 128-bit key) over the whole packet,
// plus a receiver-issued nonce (anti-replay across sessions) and a monotonic
// seq (anti-replay within a session).
#pragma once
#include <stdint.h>
#include <string.h>

#define RKEY_MAGIC        0x4B   // 'K'
#define RKEY_VER          1
#define RKEY_T_KEY        1      // CTRL -> RIG : edges + heartbeat
#define RKEY_T_STATUS     2      // RIG  -> CTRL: state, nonce, RTT echo
#define RKEY_MAX_EV       8
#define RKEY_TAG_LEN      8
#define RKEY_DEFAULT_PORT 5690

// KEY flags
#define RKEY_KF_ACTIVE    0x01   // operator keyed within the last ~2 s

// STATUS flags
#define RKEY_SF_CIV_VALID 0x01
#define RKEY_SF_CW_MODE   0x02   // rig in CW/CWR -> keying allowed
#define RKEY_SF_INTERLOCK 0x04   // PA interlock active
#define RKEY_SF_KEY_DOWN  0x08   // CW output currently closed
#define RKEY_SF_PTT       0x10   // sequencer up
#define RKEY_SF_NONCE_BAD 0x20   // last KEY packet carried a stale nonce
#define RKEY_SF_MUTED     0x40   // stream muted after abort, waits for sender idle
#define RKEY_SF_TUNE      0x80   // low-power tune running, keying refused

// Edge encoding: sender µs timestamp, bit0 = new key state (1 = down).
#define RKEY_EV_DOWN(e)   ((e) & 1u)
#define RKEY_EV_TIME(e)   ((e) & ~1u)

struct __attribute__((packed)) RkeyKeyHdr {   // 24 B, followed by nev*4 B edges + 8 B tag
  uint8_t  magic, ver, type, flags;
  uint16_t session;    // random per CTRL boot
  uint8_t  wpm;        // sender WPM (PTT hang time, display)
  uint8_t  nev;        // edges in this packet (0 = pure heartbeat)
  uint32_t seq;        // packet counter, strictly increasing
  uint32_t tSend;      // sender µs clock at transmit
  uint32_t nonce;      // last nonce received from RIG (0 = none yet)
  uint16_t evIdx0;     // index of first edge; edge i has index evIdx0+i
  uint16_t delayMs;    // requested playout delay, 0 = use RIG default
};

struct __attribute__((packed)) RkeyStatus {   // 36 B + 8 B tag
  uint8_t  magic, ver, type, flags;
  uint16_t session;    // echo of CTRL session
  uint8_t  civMode;    // raw CI-V mode byte
  uint8_t  seqLevel;   // sequencer level 0..5
  uint32_t seq;        // status counter
  uint32_t echoTSend;  // tSend of last accepted KEY packet
  uint32_t echoAgeUs;  // RIG time since that packet arrived -> RTT = now - echoTSend - echoAgeUs
  uint32_t nonce;      // current nonce to put in KEY packets
  uint32_t freqHz;     // rig frequency (CI-V), 0 = unknown
  uint16_t delayMs;    // effective playout delay incl. adaptive extra
  uint16_t lateEv;     // edges that arrived too late (shifted)
  uint16_t lostEv;     // edges never received (gap beyond redundancy)
  uint16_t rxPkts;     // accepted KEY packets (wraps)
};

// ---------------- SipHash-2-4 (reference algorithm, Aumasson & Bernstein) ----
// ~1 ms per 60 B packet on a 16 MHz AVR, a few µs on ESP32-S3.
static inline uint64_t rkey_rotl(uint64_t x, uint8_t b) { return (x << b) | (x >> (64 - b)); }
#define RKEY_SIPROUND do { \
  v0 += v1; v1 = rkey_rotl(v1, 13); v1 ^= v0; v0 = rkey_rotl(v0, 32); \
  v2 += v3; v3 = rkey_rotl(v3, 16); v3 ^= v2;                         \
  v0 += v3; v3 = rkey_rotl(v3, 21); v3 ^= v0;                         \
  v2 += v1; v1 = rkey_rotl(v1, 17); v1 ^= v2; v2 = rkey_rotl(v2, 32); \
} while (0)

static uint64_t rkey_siphash(const uint8_t key[16], const uint8_t* m, uint16_t len) {
  uint64_t k0, k1;
  memcpy(&k0, key, 8); memcpy(&k1, key + 8, 8);          // little-endian targets only
  uint64_t v0 = 0x736f6d6570736575ULL ^ k0;
  uint64_t v1 = 0x646f72616e646f6dULL ^ k1;
  uint64_t v2 = 0x6c7967656e657261ULL ^ k0;
  uint64_t v3 = 0x7465646279746573ULL ^ k1;
  uint16_t i = 0;
  uint64_t mi;
  for (; (uint16_t)(i + 8) <= len; i += 8) {
    memcpy(&mi, m + i, 8);
    v3 ^= mi; RKEY_SIPROUND; RKEY_SIPROUND; v0 ^= mi;
  }
  uint64_t b = ((uint64_t)(len & 0xFF)) << 56;
  for (uint8_t j = 0; j < (uint8_t)(len - i); j++) b |= ((uint64_t)m[i + j]) << (8 * j);
  v3 ^= b; RKEY_SIPROUND; RKEY_SIPROUND; v0 ^= b;
  v2 ^= 0xff;
  RKEY_SIPROUND; RKEY_SIPROUND; RKEY_SIPROUND; RKEY_SIPROUND;
  return v0 ^ v1 ^ v2 ^ v3;
}

// Append tag after `len` bytes of buf. Returns total length.
static inline uint16_t rkey_sign(const uint8_t key[16], uint8_t* buf, uint16_t len) {
  uint64_t t = rkey_siphash(key, buf, len);
  memcpy(buf + len, &t, RKEY_TAG_LEN);
  return len + RKEY_TAG_LEN;
}

// Verify tag at the end of a received packet of `total` bytes.
static inline bool rkey_verify(const uint8_t key[16], const uint8_t* buf, uint16_t total) {
  if (total < RKEY_TAG_LEN) return false;
  uint64_t t = rkey_siphash(key, buf, total - RKEY_TAG_LEN), r;
  memcpy(&r, buf + total - RKEY_TAG_LEN, RKEY_TAG_LEN);
  return t == r;
}
