#pragma once

// Web upload pacing: a static file sent to a browser must never take the
// outgoing WiFi capacity the radio link needs. Shared by the firmware sketch
// and a host regression test, so the rules run without hardware.
//
// Field log 2026-10-30: a second browser opened the JS8 page while RX audio
// streamed to the first one. handleFileFromSPIFFS kept the LAN client
// serviced, yet the radio asked for our datagrams again and again
// (`retransmit resent=16 deferred=72`), the gateway ping could not even leave
// the box (`ping_sock: send error=0`) and the CI-V polls went unanswered for
// over 4 s -- the TX queue was full of file data. The loop never stalled, so
// the LAN stall compensation had nothing to forgive.
//
// The radio and the audio are real time, a page load can wait. So the file
// goes out through a token bucket whose rate follows the radio link's own
// health, cut in half on every sign of trouble and grown back while clean:
//   - a new retransmit request from the radio (also holds sending briefly),
//   - a CI-V ping that comes back late, or no pong for too long,
//   - while RX audio streams: the audio WebSocket's queue backing up -- the
//     file may only use what the audio leaves free.
// The rate never drops below a floor, so a page always loads, if slowly.
// Without a radio session nothing is paced.

#include <stdint.h>

static const uint32_t WEB_PACE_UNLIMITED     = 0xffffffffu;
static const uint32_t WEB_PACE_MIN_BPS       = 16 * 1024;
static const uint32_t WEB_PACE_MAX_BPS       = 512 * 1024;
static const uint32_t WEB_PACE_AUDIO_BPS     = 64 * 1024;   // start rate beside a live audio stream
static const uint32_t WEB_PACE_CHUNK         = 1436;        // about one TCP segment
static const uint32_t WEB_PACE_MIN_SEND      = 512;         // no point in sending crumbs
static const uint32_t WEB_PACE_CUT_MS        = 200;         // at most one halving per this
static const uint32_t WEB_PACE_GROW_MS       = 250;         // clean time before each step up
static const uint32_t WEB_PACE_RTX_HOLD_MS   = 150;         // pause after a retransmit request
static const uint32_t WEB_PACE_PONG_LATE_MS  = 1500;        // three pings without an answer
static const uint32_t WEB_PACE_RTT_SLACK_MS  = 40;          // late = above 2 x floor + this
static const uint32_t WEB_PACE_WS_BACKLOG    = 2048;        // ~250 ms of 8 kB/s audio
static const uint32_t WEB_PACE_STARVE_MS     = 1000;        // audio gate never holds longer
static const uint32_t WEB_PACE_IDLE_MS       = 10000;       // a new page load starts over

struct WebPaceInput {
  bool     link = false;        // a LAN radio session is up
  bool     audio = false;       // RX audio is streaming to a browser
  uint32_t rtxRequests = 0;     // radio's retransmit requests, monotonic
  uint32_t pingRtt = 0;         // last CI-V ping RTT, ms; 0 = none yet
  uint32_t pongAgeMs = 0;       // since the last pong; 0 = none yet
  uint32_t wsBacklog = 0;       // bytes queued for the audio WebSocket
};

struct WebPacer {
  uint32_t rate = 0;            // bytes/s, 0 = start over on the next tick
  uint32_t tokens = 0;          // byte credit
  uint32_t lastTick = 0, lastCut = 0, lastGrow = 0, lastSend = 0, holdUntil = 0;
  uint32_t rtxSeen = 0;
  uint32_t rttFloor = 0;        // best recent RTT; survives page loads
  bool     audioMode = false;
  uint32_t cuts = 0, holds = 0; // for the per-transfer log line
};

inline bool webPaceCongested(const WebPacer &p, const WebPaceInput &in) {
  if (in.pongAgeMs > WEB_PACE_PONG_LATE_MS) return true;
  if (in.pingRtt && p.rttFloor && in.pingRtt > 2 * p.rttFloor + WEB_PACE_RTT_SLACK_MS) return true;
  return in.audio && in.wsBacklog > WEB_PACE_WS_BACKLOG;
}

// How many bytes may go out now: 0 = wait, WEB_PACE_UNLIMITED = no pacing.
inline uint32_t webPaceAllow(WebPacer &p, const WebPaceInput &in, uint32_t now) {
  if (!in.link) { p.rate = 0; return WEB_PACE_UNLIMITED; }

  if (p.rate == 0 || now - p.lastTick > WEB_PACE_IDLE_MS) {
    p.rate = in.audio ? WEB_PACE_AUDIO_BPS : WEB_PACE_MAX_BPS;
    p.tokens = WEB_PACE_CHUNK;
    p.lastTick = p.lastGrow = p.lastSend = now;
    p.lastCut = now - WEB_PACE_CUT_MS;   // the very first sign of trouble cuts at once
    p.holdUntil = now;
    p.rtxSeen = in.rtxRequests;
    p.audioMode = in.audio;
  }
  if (in.audio && !p.audioMode && p.rate > WEB_PACE_AUDIO_BPS) p.rate = WEB_PACE_AUDIO_BPS;
  p.audioMode = in.audio;

  // The floor follows the best RTT and creeps up 1 ms per clean step, so a
  // route that really got slower is relearned instead of reading as congestion.
  if (in.pingRtt && (!p.rttFloor || in.pingRtt < p.rttFloor)) p.rttFloor = in.pingRtt;

  bool rtxNew = in.rtxRequests != p.rtxSeen;
  p.rtxSeen = in.rtxRequests;
  if (rtxNew) { p.holdUntil = now + WEB_PACE_RTX_HOLD_MS; p.holds++; }

  if (rtxNew || webPaceCongested(p, in)) {
    if (now - p.lastCut >= WEB_PACE_CUT_MS) {
      p.rate = p.rate / 2 > WEB_PACE_MIN_BPS ? p.rate / 2 : WEB_PACE_MIN_BPS;
      p.lastCut = now;
      p.cuts++;
    }
    p.lastGrow = now;
  } else if (now - p.lastGrow >= WEB_PACE_GROW_MS) {
    uint32_t step = p.rate / 8 > WEB_PACE_MIN_BPS / 2 ? p.rate / 8 : WEB_PACE_MIN_BPS / 2;
    p.rate = p.rate + step < WEB_PACE_MAX_BPS ? p.rate + step : WEB_PACE_MAX_BPS;
    if (p.rttFloor && in.pingRtt > p.rttFloor) p.rttFloor++;
    p.lastGrow = now;
  }

  uint64_t credit = (uint64_t)p.rate * (now - p.lastTick) / 1000;
  p.lastTick = now;
  uint64_t tokens = p.tokens + credit;
  p.tokens = tokens > 2 * WEB_PACE_CHUNK ? 2 * WEB_PACE_CHUNK : (uint32_t)tokens;

  if ((int32_t)(now - p.holdUntil) < 0) return 0;
  if (in.audio && in.wsBacklog > WEB_PACE_WS_BACKLOG && now - p.lastSend < WEB_PACE_STARVE_MS) return 0;
  if (p.tokens < WEB_PACE_MIN_SEND) return 0;
  return p.tokens < WEB_PACE_CHUNK ? p.tokens : WEB_PACE_CHUNK;
}

inline void webPaceSent(WebPacer &p, uint32_t bytes, uint32_t now) {
  p.tokens = bytes < p.tokens ? p.tokens - bytes : 0;
  p.lastSend = now;
}
