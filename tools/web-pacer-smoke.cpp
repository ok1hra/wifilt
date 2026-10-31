// g++ -std=c++17 -o /tmp/web-pacer-smoke tools/web-pacer-smoke.cpp && /tmp/web-pacer-smoke
#include <cassert>
#include <cstdio>
#include "../web_pacer.h"

// Drive the pacer for durMs in 1 ms ticks with a browser that takes whatever
// it is allowed. Returns the bytes sent.
static uint64_t run(WebPacer &p, const WebPaceInput &in, uint32_t &now, uint32_t durMs) {
  uint64_t sent = 0;
  for (uint32_t i = 0; i < durMs; ++i, ++now) {
    uint32_t allow = webPaceAllow(p, in, now);
    assert(allow == WEB_PACE_UNLIMITED || allow <= WEB_PACE_CHUNK);
    if (allow && allow != WEB_PACE_UNLIMITED) { webPaceSent(p, allow, now); sent += allow; }
  }
  return sent;
}

static WebPaceInput clean() {
  WebPaceInput in;
  in.link = true;
  in.pingRtt = 10;
  in.pongAgeMs = 200;
  return in;
}

int main() {
  uint32_t now = 1000;

  // No radio session: nothing to protect, nothing paced.
  {
    WebPacer p;
    WebPaceInput in;
    assert(webPaceAllow(p, in, now) == WEB_PACE_UNLIMITED);
    assert(p.rate == 0);
  }

  // Clean link, no audio: full rate from the first byte, never above the cap.
  {
    WebPacer p;
    WebPaceInput in = clean();
    assert(webPaceAllow(p, in, now) == WEB_PACE_CHUNK);
    assert(p.rate == WEB_PACE_MAX_BPS);
    uint64_t s = run(p, in, now, 1000);
    assert(s > WEB_PACE_MAX_BPS * 9 / 10 && s <= WEB_PACE_MAX_BPS + 3 * WEB_PACE_CHUNK);
    assert(p.cuts == 0 && p.holds == 0);
  }

  // A retransmit request: sending holds, the rate halves, then grows back.
  {
    WebPacer p;
    WebPaceInput in = clean();
    run(p, in, now, 500);
    in.rtxRequests = 1;
    assert(webPaceAllow(p, in, now) == 0);
    assert(p.holds == 1 && p.cuts == 1 && p.rate == WEB_PACE_MAX_BPS / 2);
    assert(run(p, in, now, WEB_PACE_RTX_HOLD_MS - 1) == 0);
    run(p, in, now, 1);
    assert(run(p, in, now, 100) > 0);
    // The same count is not a new request.
    assert(p.holds == 1);
    run(p, in, now, 5000);
    assert(p.rate == WEB_PACE_MAX_BPS);
  }

  // Audio streaming: start low; a backed-up audio queue stops the file, apart
  // from one chunk per starve period so a page can never hang.
  {
    WebPacer p;
    WebPaceInput in = clean();
    in.audio = true;
    webPaceAllow(p, in, now);
    assert(p.rate == WEB_PACE_AUDIO_BPS);
    run(p, in, now, 100);
    in.wsBacklog = WEB_PACE_WS_BACKLOG + 1;
    uint64_t s = run(p, in, now, 3000);
    assert(s > 0 && s <= 3 * WEB_PACE_CHUNK);
    assert(p.rate == WEB_PACE_MIN_BPS);
    // Queue drained: sending resumes.
    in.wsBacklog = 0;
    assert(run(p, in, now, 1000) > WEB_PACE_MIN_BPS / 2);
  }

  // Audio starting mid-transfer pulls a high rate down to the audio start rate.
  {
    WebPacer p;
    WebPaceInput in = clean();
    run(p, in, now, 100);
    in.audio = true;
    webPaceAllow(p, in, now);
    assert(p.rate <= WEB_PACE_AUDIO_BPS);
  }

  // No pong for too long: the rate collapses to the floor and stays there, but
  // the file still moves at the floor rate.
  {
    WebPacer p;
    WebPaceInput in = clean();
    run(p, in, now, 100);
    in.pongAgeMs = WEB_PACE_PONG_LATE_MS + 1;
    run(p, in, now, 3000);
    assert(p.rate == WEB_PACE_MIN_BPS);
    uint64_t s = run(p, in, now, 1000);
    assert(s > WEB_PACE_MIN_BPS * 8 / 10 && s <= WEB_PACE_MIN_BPS + 3 * WEB_PACE_CHUNK);
    // A pong age of 0 means "none yet", not "fresh but late".
    WebPacer q;
    WebPaceInput none = clean();
    none.pongAgeMs = 0;
    run(q, none, now, 1000);
    assert(q.cuts == 0);
  }

  // A late ping against the learned floor is congestion; a modest rise is not.
  {
    WebPacer p;
    WebPaceInput in = clean();
    run(p, in, now, 100);
    assert(p.rttFloor == 10);
    in.pingRtt = 2 * 10 + WEB_PACE_RTT_SLACK_MS;
    run(p, in, now, 200);
    assert(p.cuts == 0);
    in.pingRtt = 2 * p.rttFloor + WEB_PACE_RTT_SLACK_MS + 1;
    run(p, in, now, 200);
    assert(p.cuts > 0);
  }

  // The floor creeps up while the link is clean, so a slower route is relearned.
  {
    WebPacer p;
    WebPaceInput in = clean();
    run(p, in, now, 100);
    in.pingRtt = 30;   // not late against 10, so the link counts as clean
    run(p, in, now, 10000);
    assert(p.rttFloor > 10 && p.rttFloor <= 30);
  }

  // A pause between page loads starts over at the full rate.
  {
    WebPacer p;
    WebPaceInput in = clean();
    run(p, in, now, 100);
    in.rtxRequests = 5;
    run(p, in, now, 300);
    assert(p.rate < WEB_PACE_MAX_BPS);
    now += WEB_PACE_IDLE_MS + 1;
    webPaceAllow(p, in, now);
    assert(p.rate == WEB_PACE_MAX_BPS);
  }

  // Losing the session resets the pacer: the next session starts fresh.
  {
    WebPacer p;
    WebPaceInput in = clean();
    in.rtxRequests = 3;
    run(p, in, now, 100);
    WebPaceInput down;
    assert(webPaceAllow(p, down, now) == WEB_PACE_UNLIMITED);
    in.rtxRequests = 0;   // a new session counts from zero
    webPaceAllow(p, in, now);
    assert(p.rate == WEB_PACE_MAX_BPS && p.holds == 0);
  }

  // millis() wrap inside a hold.
  {
    WebPacer p;
    WebPaceInput in = clean();
    uint32_t t = 0xffffffffu - 50;
    run(p, in, t, 20);
    in.rtxRequests = 1;
    assert(webPaceAllow(p, in, t) == 0);
    uint32_t t2 = t;
    assert(run(p, in, t2, WEB_PACE_RTX_HOLD_MS - 1) == 0);
    assert(run(p, in, t2, 200) > 0);
  }

  std::puts("web-pacer-smoke: all checks passed");
  return 0;
}
