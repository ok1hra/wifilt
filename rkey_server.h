#pragma once

// Remote CW key server for Paddle2IP (github.com/ok1hra/paddle2ip). The paddle
// box runs the iambic keyer and the sidetone itself and streams the key EDGES,
// stamped with the keyer's ideal times, over UDP; this interface answers like an
// OI3 does. Wire format: rkey_proto.h, an identical copy of the one in paddle2ip
// and oi3. Receive, nonce, mute and playout rules are a port of the reference
// server, oi3 rkey.ino -- keep them in step with it.
//
// Two outputs, chosen in SETUP (Remote CW key):
//   CIV   The edges are decoded back into characters and handed to the radio's
//         own keyer as CI-V 0x17 text. Works over ICOM-LAN, over CI-V and on the
//         PC build -- no cable to the radio. The price: about one character of
//         latency (a character is only known once its letter gap has passed),
//         and the radio's keyer shapes the elements at its own speed, which the
//         sketch sets to the paddle's WPM.
//   GPIO  The edges are replayed on the KEY output at t_sender + latency + D,
//         exactly like the OI3 does on CW1: the operator's own timing on air.
//         Box only, cabled to the radio's KEY jack (straight key, BK-IN on).
//         With `gate` set, an over's edges wait until the sketch reports the
//         radio ready (txWanted -> txReady), the way the OI3 waits for its PTT
//         sequencer: the IC-705 has one KEY jack, and its key type has to be
//         switched from Paddle to Straight over CAT first, and back afterwards.
//
// The decoder can use a fixed threshold because Paddle2IP's keyer is exact: a
// dit is 1, a dah 3, the element gap 1, the letter gap 3 and the word gap 7
// dits, so 2 and 5 dits split them with a whole dit of margin either side.
//
// Shared by the sketch and the native regression test (tools/rkey-server-smoke.cpp),
// so nothing here touches a socket, a pin or a clock: the caller passes arrival
// times in, gets STATUS replies back and supplies keyOut() for the pin.
//
// Threads (rkey_net.h): rkeyOnPacket/rkeyService run in the rkey task,
// rkeyPlayTick in the GPIO playout timer, rkeyTakeText/rkeyTraceCopy in loop().
// RKEY_LOCK guards the playout queue, the text ring and the trace; it must not
// nest, and the includer defines it (a no-op for the single-threaded test).

#include <stdint.h>
#include <string.h>
#include "rkey_proto.h"

#ifndef RKEY_LOCK
  #define RKEY_LOCK()
  #define RKEY_UNLOCK()
#endif

enum : uint8_t { RKEY_OUT_CIV = 0, RKEY_OUT_GPIO = 1 };

static const uint32_t RKEY_MARGIN_US        = 1500;     // min. lead when queueing an edge
static const int32_t  RKEY_SLEW_US          = 1500;     // max drift correction per mark start
static const uint32_t RKEY_EXTRA_MAX_US     = 500000;   // cap of the adaptive extra delay
static const int32_t  RKEY_STALE_US         = 400000;   // packet this far behind min latency = stale
static const uint32_t RKEY_STATUS_MIN_US    = 100000;   // STATUS rate limit
static const uint32_t RKEY_NONCE_ROTATE_US  = 5000000;
static const uint32_t RKEY_LINK_TIMEOUT_US  = 300000;   // key down and no packet -> release
static const uint32_t RKEY_MAX_DOWN_US      = 3000000;  // longest single key-down
static const uint32_t RKEY_CONN_US          = 1000000;  // "connected" = a packet within this
static const uint32_t RKEY_OVER_GAP_US      = 3000000;  // longer pause = new over, no word space
static const uint32_t RKEY_READY_TIMEOUT_US = 3000000;  // gate: the radio never got ready -> abort
static const uint32_t RKEY_GATE_HOLD_US     = 2000000;  // gate: this long idle ends the over

#define RKEY_Q     32    // playout queue (power of two)
#define RKEY_TXT   128   // decoded text waiting for loop() (power of two)
#define RKEY_TRACE 48    // decoded text shown in SETUP

// ---------------------------------------------------------------- Morse -> text

// What the Icom keyer accepts in CI-V 0x17 (CI-V reference, "Codes for CW
// message contents"). Space is the word gap and is not in the table.
struct RkeyMorse { char c; const char *p; };
static const RkeyMorse RKEY_MORSE[] = {
  {'A', ".-"},   {'B', "-..."}, {'C', "-.-."}, {'D', "-.."},  {'E', "."},    {'F', "..-."},
  {'G', "--."},  {'H', "...."}, {'I', ".."},   {'J', ".---"}, {'K', "-.-"},  {'L', ".-.."},
  {'M', "--"},   {'N', "-."},   {'O', "---"},  {'P', ".--."}, {'Q', "--.-"}, {'R', ".-."},
  {'S', "..."},  {'T', "-"},    {'U', "..-"},  {'V', "...-"}, {'W', ".--"},  {'X', "-..-"},
  {'Y', "-.--"}, {'Z', "--.."},
  {'0', "-----"}, {'1', ".----"}, {'2', "..---"}, {'3', "...--"}, {'4', "....-"},
  {'5', "....."}, {'6', "-...."}, {'7', "--..."}, {'8', "---.."}, {'9', "----."},
  {'/', "-..-."},  {'?', "..--.."}, {'.', ".-.-.-"}, {'-', "-....-"}, {',', "--..--"},
  {':', "---..."}, {'\'', ".----."}, {'(', "-.--."}, {')', "-.--.-"}, {'=', "-...-"},
  {'+', ".-.-."},  {'"', ".-..-."}, {'@', ".--.-."},
};

static char rkeyMorseChar(const char *pat, uint8_t n) {
  for (size_t i = 0; i < sizeof(RKEY_MORSE) / sizeof(RKEY_MORSE[0]); i++) {
    if (strlen(RKEY_MORSE[i].p) == n && memcmp(RKEY_MORSE[i].p, pat, n) == 0) return RKEY_MORSE[i].c;
  }
  return 0;
}

// One keyed character as 0x17 text. A pattern that is no character of its own
// but two run together -- SK (S+K), AS, BK, the 8-dot error -- goes as "^XY":
// the keyer then sends the pair without the letter gap, so the air gets exactly
// the elements the operator keyed, whichever split is found first.
// Returns the length written (0 = undecodable, nothing to send).
static uint8_t rkeyMorseText(const char *pat, uint8_t n, char out[3]) {
  char c = rkeyMorseChar(pat, n);
  if (c) { out[0] = c; return 1; }
  for (uint8_t i = 1; i < n; i++) {
    char a = rkeyMorseChar(pat, i);
    char b = a ? rkeyMorseChar(pat + i, n - i) : 0;
    if (a && b) { out[0] = '^'; out[1] = a; out[2] = b; return 3; }
  }
  return 0;
}

// ---------------------------------------------------------------- server state

struct RkeyServer {
  // configuration, set before the task starts
  bool     enabled;
  uint8_t  output;              // RKEY_OUT_*
  uint8_t  key[16];
  bool     keySet;
  uint16_t delayMs;             // default playout delay (the paddle may ask for another)
  void   (*keyOut)(bool down);  // KEY pin; null = this build has none
  uint32_t (*rand32)();
  volatile bool gate;           // GPIO: hold an over's edges until txReady (set by the sketch)

  // Gate handshake. The server raises txWanted for an over and drops it 2 s
  // after the last key-up; the sketch prepares the radio, then sets txReady,
  // and undoes it once txWanted is down. Only the server clears txReady.
  volatile bool txWanted, txReady;
  uint32_t pend[RKEY_Q];        // accepted edges waiting for txReady
  uint8_t  pendH, pendT;
  uint32_t waitSinceUs;

  // the radio, published by loop()
  volatile bool     rigLink, rigCw, rigTx;
  volatile uint8_t  rigMode;    // CI-V mode byte
  volatile uint32_t rigFreq;

  // session
  bool     haveSession;
  uint16_t session;
  uint32_t lastSeq;
  uint16_t nextIdx;
  bool     muted;
  bool     lastState;
  uint32_t peerIp;              // network order
  uint16_t peerPort;            // host order
  bool     peerValid;
  uint32_t echoTSend, lastPktUs;
  volatile uint32_t wdLastPktUs;
  uint8_t  wpm;
  uint16_t reqDelayMs;

  // timing
  int32_t  skewCur, skewPrev;
  uint32_t skewWinUs;
  bool     anchored;
  uint32_t offset, extraUs, lastAt;

  // nonce
  uint32_t nonce, noncePrev, nonceUs;
  bool     nonceInit, nonceBad;

  // playout queue (GPIO), consumed by rkeyPlayTick
  struct { uint32_t at; uint8_t down; } q[RKEY_Q];
  volatile uint8_t  qHead, qTail;
  volatile bool     outDown, wdTripped;
  volatile uint32_t downSinceUs, lastUpUs;

  // decoder, in the SENDER's clock
  char     el[10];
  uint8_t  elN;                 // > sizeof(el) = too long, dropped
  bool     decDown, decGap;     // decGap: a character went out, the next may need a word space
  uint32_t decDownT, decUpT;

  // decoded text for loop() (CIV output) and for SETUP (both outputs)
  char     txt[RKEY_TXT];
  uint8_t  txtHead, txtTail;
  char     trace[RKEY_TRACE];
  uint8_t  traceLen;

  // statistics
  uint16_t lateEv, lostEv, rxPkts;
  uint32_t badAuth, undecoded, aborts, textDropped;
  uint32_t statusSeq, lastStatusUs;
  const char *lastAbort;
};

static void rkeyInit(RkeyServer &s) {
  // Callers fill the configuration afterwards; everything else starts at zero.
  memset(&s, 0, sizeof(s));
  s.muted = true;
  s.wpm = 20;
  s.skewCur = s.skewPrev = 0x7FFFFFFF;
}

static uint32_t rkeyDitUs(const RkeyServer &s) { return 1200000UL / (s.wpm ? s.wpm : 20); }

static bool rkeyAllowed(const RkeyServer &s) {
  return s.enabled && s.keySet && s.rigLink && s.rigCw
      && (s.output == RKEY_OUT_CIV || s.keyOut != nullptr);
}

static bool rkeyConnected(const RkeyServer &s, uint32_t nowUs) {
  return s.haveSession && !s.nonceBad && (nowUs - s.lastPktUs) < RKEY_CONN_US;
}

// ---------------------------------------------------------------- text out

static void rkeyTracePut(RkeyServer &s, char c) {
  if (s.traceLen == RKEY_TRACE) { memmove(s.trace, s.trace + 1, RKEY_TRACE - 1); s.traceLen--; }
  s.trace[s.traceLen++] = c;
}

static void rkeyEmit(RkeyServer &s, const char *t, uint8_t n) {
  RKEY_LOCK();
  if (s.output == RKEY_OUT_CIV) {
    uint8_t used = (uint8_t)((s.txtHead - s.txtTail) & (RKEY_TXT - 1));
    if (used + n < RKEY_TXT) {
      for (uint8_t i = 0; i < n; i++) { s.txt[s.txtHead] = t[i]; s.txtHead = (s.txtHead + 1) & (RKEY_TXT - 1); }
    } else {
      s.textDropped += n;           // loop() stalled for a minute; never send half a "^XY"
    }
  }
  if (n == 3 && t[0] == '^') { rkeyTracePut(s, '<'); rkeyTracePut(s, t[1]); rkeyTracePut(s, t[2]); rkeyTracePut(s, '>'); }
  else for (uint8_t i = 0; i < n; i++) rkeyTracePut(s, t[i]);
  RKEY_UNLOCK();
}

// Up to max bytes of decoded text for one 0x17 frame. A "^XY" pair is never
// split across two frames: the keyer only joins what it gets in one.
static uint8_t rkeyTakeText(RkeyServer &s, char *out, uint8_t max) {
  uint8_t n = 0;
  RKEY_LOCK();
  while (s.txtTail != s.txtHead && n < max) {
    if (s.txt[s.txtTail] == '^' && (uint8_t)(max - n) < 3) break;
    uint8_t take = s.txt[s.txtTail] == '^' ? 3 : 1;
    for (uint8_t i = 0; i < take && s.txtTail != s.txtHead; i++) {
      out[n++] = s.txt[s.txtTail];
      s.txtTail = (s.txtTail + 1) & (RKEY_TXT - 1);
    }
  }
  RKEY_UNLOCK();
  return n;
}

static uint8_t rkeyTraceCopy(RkeyServer &s, char *out, uint8_t max) {
  RKEY_LOCK();
  uint8_t n = s.traceLen < max ? s.traceLen : max;
  memcpy(out, s.trace + (s.traceLen - n), n);
  RKEY_UNLOCK();
  return n;
}

// ---------------------------------------------------------------- decoder

static void rkeyDecFlush(RkeyServer &s) {
  if (s.elN == 0) return;
  char t[3];
  uint8_t n = (s.elN <= sizeof(s.el)) ? rkeyMorseText(s.el, s.elN, t) : 0;
  if (n) rkeyEmit(s, t, n);
  else   s.undecoded++;
  s.elN = 0;
  s.decGap = true;
}

static void rkeyDecReset(RkeyServer &s) {
  if (s.elN || s.decDown) {          // a character cut by an abort: shown, never sent
    RKEY_LOCK(); rkeyTracePut(s, '*'); RKEY_UNLOCK();
  }
  s.elN = 0;
  s.decDown = false;
  s.decGap = false;
}

static void rkeyDecEdge(RkeyServer &s, bool down, uint32_t t) {
  uint32_t dit = rkeyDitUs(s);
  if (down) {
    if (s.decDown) return;
    if (s.elN && (int32_t)(t - s.decUpT) >= (int32_t)(2 * dit)) rkeyDecFlush(s);
    if (s.elN == 0 && s.decGap) {
      int32_t gap = (int32_t)(t - s.decUpT);
      if (gap >= (int32_t)(5 * dit) && gap < (int32_t)RKEY_OVER_GAP_US) rkeyEmit(s, " ", 1);
      s.decGap = false;
    }
    s.decDown = true;
    s.decDownT = t;
  } else {
    if (!s.decDown) return;
    if (s.elN < sizeof(s.el)) s.el[s.elN] = ((int32_t)(t - s.decDownT) < (int32_t)(2 * dit)) ? '.' : '-';
    if (s.elN <= sizeof(s.el)) s.elN++;
    s.decDown = false;
    s.decUpT = t;
  }
}

// The sender's clock has reached t (a packet's tSend): a letter gap that has
// passed completes the character -- the latency the CIV output pays.
static void rkeyDecIdle(RkeyServer &s, uint32_t t) {
  if (s.elN && !s.decDown && (int32_t)(t - s.decUpT) >= (int32_t)(2 * rkeyDitUs(s))) rkeyDecFlush(s);
}

// ---------------------------------------------------------------- timing helpers

static void rkeySkewReset(RkeyServer &s, uint32_t nowUs) {
  s.skewCur = s.skewPrev = 0x7FFFFFFF;
  s.skewWinUs = nowUs;
}
static void rkeySkewSample(RkeyServer &s, int32_t v, uint32_t nowUs) {
  if (nowUs - s.skewWinUs >= 1000000UL) { s.skewPrev = s.skewCur; s.skewCur = 0x7FFFFFFF; s.skewWinUs = nowUs; }
  if (v < s.skewCur) s.skewCur = v;
}
static int32_t rkeySkewMin(const RkeyServer &s) { return s.skewCur < s.skewPrev ? s.skewCur : s.skewPrev; }

static uint32_t rkeyDUs(const RkeyServer &s) {
  return (uint32_t)(s.reqDelayMs ? s.reqDelayMs : s.delayMs) * 1000UL + s.extraUs;
}

static void rkeyNonceRotate(RkeyServer &s, uint32_t nowUs) {
  s.noncePrev = s.nonce;
  s.nonce = s.rand32 ? s.rand32() : 0;
  if (s.nonce == 0) s.nonce = 1;
  s.nonceUs = nowUs;
}
static bool rkeyNonceOk(const RkeyServer &s, uint32_t n) {
  return n != 0 && (n == s.nonce || n == s.noncePrev);
}

// ---------------------------------------------------------------- playout (GPIO)

static void rkeyAbort(RkeyServer &s, const char *why, uint32_t nowUs) {
  RKEY_LOCK();
  s.qTail = s.qHead;
  if (s.outDown && s.keyOut) s.keyOut(false);
  if (s.outDown) s.lastUpUs = nowUs;
  s.outDown = false;
  RKEY_UNLOCK();
  rkeyDecReset(s);
  s.pendH = s.pendT = 0;
  s.waitSinceUs = 0;
  s.anchored = false;
  s.lastState = false;
  s.muted = true;
  s.aborts++;
  s.lastAbort = why;
}

// Releases the key and drops the queue; rkeyService() then aborts and mutes.
// Lock held.
static void rkeyTripLocked(RkeyServer &s, uint32_t nowUs) {
  if (s.outDown) { if (s.keyOut) s.keyOut(false); s.outDown = false; s.lastUpUs = nowUs; }
  s.qTail = s.qHead;
  s.wdTripped = true;
}

// The playout timer, every 0.5 ms while the stream is live. It also enforces the
// link timeout and the max key-down on its own, so neither a stalled task nor a
// stalled loop() can leave the transmitter keyed.
static void rkeyPlayTick(RkeyServer &s, uint32_t nowUs) {
  RKEY_LOCK();
  bool linkOk = (nowUs - s.wdLastPktUs) <= RKEY_LINK_TIMEOUT_US;
  while (s.qHead != s.qTail && (int32_t)(nowUs - s.q[s.qTail].at) >= 0) {
    bool d = s.q[s.qTail].down;
    if (d && !linkOk) { rkeyTripLocked(s, nowUs); break; }   // never start a mark on a dead link
    if (s.keyOut) s.keyOut(d);
    s.outDown = d;
    if (d) s.downSinceUs = nowUs; else s.lastUpUs = nowUs;
    s.qTail = (s.qTail + 1) & (RKEY_Q - 1);
  }
  if (s.outDown && (!linkOk || (nowUs - s.downSinceUs) > RKEY_MAX_DOWN_US)) rkeyTripLocked(s, nowUs);
  RKEY_UNLOCK();
}

static bool rkeyPlayIdle(RkeyServer &s) {
  RKEY_LOCK();
  bool idle = s.qHead == s.qTail && !s.outDown;
  RKEY_UNLOCK();
  return idle;
}

static void rkeySchedule(RkeyServer &s, uint32_t e, uint32_t nowUs) {
  bool down = RKEY_EV_DOWN(e);
  uint32_t t = RKEY_EV_TIME(e);

  if (!s.anchored) {
    // New over: anchor on the jitter-free latency estimate. The radio's own
    // BK-IN does the TX switching, so there is no sequencer lead to cover.
    s.extraUs = (s.extraUs * 3) / 4;                // adaptive extra decays per over
    s.offset   = (uint32_t)rkeySkewMin(s) + rkeyDUs(s);
    s.anchored = true;
    s.lastAt   = nowUs;
  } else if (down) {
    // Drift correction, only at a mark start (inside a gap).
    int32_t diff = (int32_t)((uint32_t)rkeySkewMin(s) + rkeyDUs(s) - s.offset);
    if (diff >  RKEY_SLEW_US) diff =  RKEY_SLEW_US;
    if (diff < -RKEY_SLEW_US) diff = -RKEY_SLEW_US;
    s.offset += (uint32_t)diff;
  }

  uint32_t at = t + s.offset;
  int32_t lead = (int32_t)(at - nowUs);
  if (down && lead < (int32_t)RKEY_MARGIN_US) {
    // Late mark start: shift the rest of the over, keep the mark length.
    uint32_t sh = (uint32_t)((int32_t)RKEY_MARGIN_US - lead);
    s.offset += sh; at += sh;
    s.extraUs += sh + 2000UL;
    if (s.extraUs > RKEY_EXTRA_MAX_US) s.extraUs = RKEY_EXTRA_MAX_US;
    s.lateEv++;
  } else if (!down && lead < 0) {
    at = nowUs;                                      // late key-up: release now
    s.lateEv++;
  }
  if ((int32_t)(at - s.lastAt) < 0) at = s.lastAt;   // keep the queue monotonic
  s.lastAt = at;

  RKEY_LOCK();
  uint8_t nh = (s.qHead + 1) & (RKEY_Q - 1);
  bool full = nh == s.qTail;
  if (!full) { s.q[s.qHead].at = at; s.q[s.qHead].down = down ? 1 : 0; s.qHead = nh; }
  RKEY_UNLOCK();
  if (full) rkeyAbort(s, "queue full", nowUs);
}

// ---------------------------------------------------------------- STATUS

static uint16_t rkeyBuildStatus(RkeyServer &s, uint32_t nowUs, uint8_t *out) {
  RkeyStatus st;
  bool gpio = s.output == RKEY_OUT_GPIO;
  st.magic = RKEY_MAGIC; st.ver = RKEY_VER; st.type = RKEY_T_STATUS;
  st.flags = ((s.rigLink && s.rigFreq) ? RKEY_SF_CIV_VALID : 0)
           | (s.rigCw ? RKEY_SF_CW_MODE : 0)
           | ((gpio ? s.outDown : s.rigTx) ? RKEY_SF_KEY_DOWN : 0)
           | (s.rigTx ? RKEY_SF_PTT : 0)
           | (s.nonceBad ? RKEY_SF_NONCE_BAD : 0)
           | (s.muted ? RKEY_SF_MUTED : 0);
  st.session   = s.session;
  st.civMode   = s.rigMode;
  st.seqLevel  = 0;                                  // no sequencer here
  st.seq       = ++s.statusSeq;
  st.echoTSend = s.echoTSend;
  st.echoAgeUs = nowUs - s.lastPktUs;
  st.nonce     = s.nonce;
  st.freqHz    = s.rigLink ? s.rigFreq : 0;
  // CIV plays nothing out: the radio's keyer starts each character as soon as
  // it gets it, so "D" would describe nothing that happens.
  st.delayMs   = gpio ? (uint16_t)(rkeyDUs(s) / 1000UL) : 0;
  st.lateEv    = s.lateEv;
  st.lostEv    = s.lostEv;
  st.rxPkts    = s.rxPkts;
  memcpy(out, &st, sizeof(st));
  s.lastStatusUs = nowUs;
  return rkey_sign(s.key, out, sizeof(st));
}

// ---------------------------------------------------------------- receive

// One datagram. Returns the length of a STATUS reply written to `reply`
// (sizeof(RkeyStatus) + RKEY_TAG_LEN bytes), 0 = send nothing. The reply goes
// to the packet's own source, which rkeyOnPacket also remembers in peerIp/Port.
static uint16_t rkeyOnPacket(RkeyServer &s, const uint8_t *buf, uint16_t n, uint32_t arriveUs,
                             uint32_t srcIp, uint16_t srcPort, uint8_t *reply) {
  if (!s.enabled || !s.keySet) return 0;
  if (n < sizeof(RkeyKeyHdr) + RKEY_TAG_LEN) return 0;
  RkeyKeyHdr h;
  memcpy(&h, buf, sizeof(h));
  if (h.magic != RKEY_MAGIC || h.ver != RKEY_VER || h.type != RKEY_T_KEY) return 0;
  if (h.nev > RKEY_MAX_EV) return 0;
  if (n != sizeof(RkeyKeyHdr) + 4u * h.nev + RKEY_TAG_LEN) return 0;
  if (!rkey_verify(s.key, buf, n)) { s.badAuth++; return 0; }

  // Authenticated: this is our paddle. STATUS goes back to where it came from.
  s.peerIp = srcIp; s.peerPort = srcPort; s.peerValid = true;
  bool nonceOk = rkeyNonceOk(s, h.nonce);
  s.nonceBad = !nonceOk;

  if (!s.haveSession || h.session != s.session) {
    // A new session only with a fresh nonce, so an old capture cannot start one.
    if (!nonceOk) return rkeyBuildStatus(s, arriveUs, reply);
    if (s.haveSession) rkeyAbort(s, "new session", arriveUs);
    s.haveSession = true;
    s.session  = h.session;
    s.nextIdx  = h.evIdx0 + h.nev;                   // never replay a history we just met
    s.muted    = true;
    s.lastState = false;
    s.extraUs  = 0;
    rkeyDecReset(s);
    rkeySkewReset(s, arriveUs);
  } else if ((int32_t)(h.seq - s.lastSeq) <= 0) {
    return 0;                                        // duplicate / reordered / replayed
  }
  s.lastSeq   = h.seq;
  s.lastPktUs = arriveUs;
  s.wdLastPktUs = arriveUs;
  s.echoTSend = h.tSend;
  s.wpm       = h.wpm < 5 ? 5 : (h.wpm > 60 ? 60 : h.wpm);
  s.reqDelayMs = (h.delayMs >= 10 && h.delayMs <= 1000) ? h.delayMs : 0;
  s.rxPkts++;

  int32_t sk = (int32_t)(arriveUs - h.tSend);
  rkeySkewSample(s, sk, arriveUs);
  uint16_t replyLen = 0;
  if (!nonceOk || (arriveUs - s.lastStatusUs) >= RKEY_STATUS_MIN_US) replyLen = rkeyBuildStatus(s, arriveUs, reply);
  if (!nonceOk) return replyLen;                     // heartbeat only; the edges come again

  const uint8_t *ev = buf + sizeof(RkeyKeyHdr);
  bool stale = (sk - rkeySkewMin(s)) > RKEY_STALE_US;

  // Mute release, checked BEFORE this packet's edges are consumed, so a
  // released stream starts with edges newer than the word gap: the paddle is
  // idle, or its newest edge is a key-up older than 5 dits -- the next word,
  // never the middle of a character.
  if (s.muted && rkeyAllowed(s)) {
    bool release = h.nev == 0;
    if (!release) {
      uint32_t last; memcpy(&last, ev + 4u * (h.nev - 1), 4);
      bool idxKnown = (int16_t)((uint16_t)(h.evIdx0 + h.nev) - s.nextIdx) <= 0;
      // signed: an edge stamped after tSend must not look like a long gap
      release = idxKnown && !RKEY_EV_DOWN(last)
             && (int32_t)(h.tSend - RKEY_EV_TIME(last)) > (int32_t)(5 * rkeyDitUs(s));
    }
    if (release) { s.muted = false; s.lastState = false; rkeyDecReset(s); }
  }

  for (uint8_t i = 0; i < h.nev; i++) {
    uint16_t idx = h.evIdx0 + i;
    int16_t rel = (int16_t)(idx - s.nextIdx);
    if (rel < 0) continue;                           // already have it
    uint32_t e; memcpy(&e, ev + 4u * i, 4);
    s.nextIdx = idx + 1;
    if (rel > 0) {                                   // lost beyond the redundancy
      s.lostEv += rel;
      if (!s.muted) rkeyAbort(s, "edge gap", arriveUs);
    }
    if (s.muted) continue;
    if (stale) { rkeyAbort(s, "stale", arriveUs); continue; }
    bool down = RKEY_EV_DOWN(e);
    if (down == s.lastState) continue;               // not a transition
    s.lastState = down;
    rkeyDecEdge(s, down, RKEY_EV_TIME(e));
    if (s.output != RKEY_OUT_GPIO) continue;
    if (!s.gate) { rkeySchedule(s, e, arriveUs); continue; }
    uint8_t nh = (s.pendH + 1) & (RKEY_Q - 1);
    if (nh == s.pendT) { rkeyAbort(s, "pending full", arriveUs); continue; }
    s.pend[s.pendH] = e;
    s.pendH = nh;
  }
  if (!s.muted) rkeyDecIdle(s, h.tSend);
  return replyLen;
}

// ---------------------------------------------------------------- periodic

// From the rkey task, at least every few ms.
static void rkeyService(RkeyServer &s, uint32_t nowUs) {
  if (!s.nonceInit) { rkeyNonceRotate(s, nowUs); rkeyNonceRotate(s, nowUs); s.nonceInit = true; }
  if (nowUs - s.nonceUs > RKEY_NONCE_ROTATE_US) rkeyNonceRotate(s, nowUs);

  if (s.wdTripped) { s.wdTripped = false; rkeyAbort(s, "watchdog", nowUs); return; }

  // Gate: the over ends -- and the radio goes back -- once nothing is waiting,
  // nothing plays and the key has been up for a while. Before the allowed()
  // test on purpose: an over cut by an abort must hand the radio back too.
  bool pend = s.pendH != s.pendT;
  if (s.txWanted && !pend && rkeyPlayIdle(s)) {
    RKEY_LOCK(); uint32_t lastUp = s.lastUpUs; RKEY_UNLOCK();
    if ((nowUs - lastUp) > RKEY_GATE_HOLD_US) s.txWanted = false;
  }

  bool busy = !rkeyPlayIdle(s) || s.elN || s.decDown || pend;
  if (!rkeyAllowed(s)) {
    if (busy) rkeyAbort(s, "not allowed", nowUs);
    else s.muted = true;
    return;
  }
  // A paddle that went silent mid-character: the character is gone. (The
  // playout timer has already released a key that was down.)
  if (busy && (nowUs - s.lastPktUs) > RKEY_LINK_TIMEOUT_US) { rkeyAbort(s, "link", nowUs); return; }

  if (pend) {
    // A new over always waits for a fresh "ready": ready is cleared BEFORE
    // wanted is raised, so loop() can never pair this over with a ready it
    // gave the previous one -- after which it may already have sent Paddle.
    if (!s.txWanted) { s.txReady = false; s.txWanted = true; s.waitSinceUs = nowUs | 1; }
    if (s.txReady) {
      s.waitSinceUs = 0;
      while (s.pendT != s.pendH) {
        rkeySchedule(s, s.pend[s.pendT], nowUs);
        s.pendT = (s.pendT + 1) & (RKEY_Q - 1);
      }
    } else {
      if (!s.waitSinceUs) s.waitSinceUs = nowUs | 1;
      // signed: waitSinceUs = now|1 can sit 1 us in the future
      if ((int32_t)(nowUs - s.waitSinceUs) > (int32_t)RKEY_READY_TIMEOUT_US) { rkeyAbort(s, "radio not ready", nowUs); return; }
    }
  }

  // 7 dits of silence end the over; the next mark re-anchors the playout.
  if (s.anchored && rkeyPlayIdle(s)) {
    RKEY_LOCK(); uint32_t lastUp = s.lastUpUs; RKEY_UNLOCK();
    if ((nowUs - lastUp) > 7 * rkeyDitUs(s)) s.anchored = false;
  }
}
