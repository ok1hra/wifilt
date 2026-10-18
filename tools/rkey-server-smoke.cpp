// Native regression test for rkey_server.h -- the Paddle2IP remote CW key server.
//
//   g++ -std=c++11 -Wall -Wextra -o /tmp/rkey-server-smoke tools/rkey-server-smoke.cpp && /tmp/rkey-server-smoke
//
// A simulated Paddle2IP (the send rules of paddle2ip net.cpp: a packet on every
// edge, 20/100 ms heartbeats, the edges of the last 500 ms max 8 plus always the
// newest while the key is down, nonce from the last STATUS) keys text through a
// simulated network into the server, in simulated time. Checked:
//   - GPIO: every mark/space on the pin has the sender's exact length, under
//     jitter and loss; the first mark is D after the edge; no late edges
//   - CIV: the decoded text is what was keyed, prosigns as "^XY", word spaces
//     only between words, a "^XY" never split across 0x17 frames
//   - authentication: bad tag, wrong key, replay, a new session without a fresh
//     nonce -- none is accepted
//   - safety: a link that dies mid-mark releases the key within the timeout and
//     mutes; muted resumes only at a word gap; a radio not in CW keys nothing

#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <string>
#include <vector>
#include "../rkey_server.h"

static int failures = 0;
#define CHECK(cond, ...) do { if (cond) { printf("  ok   "); printf(__VA_ARGS__); printf("\n"); } \
  else { failures++; printf("  FAIL "); printf(__VA_ARGS__); printf("\n"); } } while (0)

static const uint8_t KEY[16] = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16};

// ---------------------------------------------------------------- pin capture

struct PinEdge { uint32_t t; bool down; };
static std::vector<PinEdge> pin;
static uint32_t simNow;               // server clock, for the pin callback
static void capturePin(bool down) { pin.push_back({simNow, down}); }

static uint32_t lcg = 12345;
static uint32_t rnd32() { lcg = lcg * 1103515245u + 12345u; return (lcg >> 1) ^ (lcg << 15); }
static double frand() { return (rnd32() & 0xFFFFFF) / double(0x1000000); }

// ---------------------------------------------------------------- Morse source

static const char *patternOf(char c) {
  for (const auto &m : RKEY_MORSE) if (m.c == c) return m.p;
  return nullptr;
}

// Text -> ideal edges, sender time. "<SK>" keys S and K without the letter gap.
static std::vector<PinEdge> textEdges(const std::string &text, uint8_t wpm, uint32_t t0) {
  std::vector<PinEdge> ev;
  uint32_t dit = 1200000u / wpm, t = t0;
  bool joined = false, first = true;
  for (size_t i = 0; i < text.size(); i++) {
    char c = text[i];
    if (c == '<') { joined = true; continue; }
    if (c == '>') { joined = false; continue; }
    if (c == ' ') { t += 4 * dit; continue; }        // 3 after the letter + 4 = 7
    const char *p = patternOf(c);
    assert(p);
    if (!first && !(joined && text[i - 1] != '<')) t += 2 * dit;   // letter gap 3 = 1 + 2
    first = false;
    for (const char *e = p; *e; e++) {
      uint32_t len = (*e == '.' ? 1 : 3) * dit;
      ev.push_back({t, true});
      ev.push_back({t + len, false});
      t += len + dit;
    }
  }
  return ev;
}

// ---------------------------------------------------------------- simulation

struct Datagram { uint32_t at; std::vector<uint8_t> b; };

struct Sim {
  RkeyServer s;
  // network
  uint32_t latencyUs = 30000, jitterUs = 0;
  double   loss = 0;
  bool     linkDown = false;           // drop everything from now on
  int32_t  clockOffset = 0x12345678;   // server clock - sender clock
  std::deque<Datagram> up, down;       // in flight
  // client
  uint8_t  wpm = 25;
  uint16_t session = 0xBEEF, evIdx = 0;
  uint32_t seq = 0, nonce = 0, lastSend = 0;
  std::vector<PinEdge> sent;           // edges handed to the "keyer", sender time
  std::vector<PinEdge> todo;
  size_t   todoPos = 0;
  RkeyStatus lastStatus;
  bool     haveStatus = false;
  uint32_t statusCount = 0;
  // CIV text drained like loop() does, frame by frame
  std::vector<std::string> frames;

  explicit Sim(uint8_t output) {
    rkeyInit(s);
    s.enabled = true; s.output = output; s.keySet = true; s.delayMs = 120;
    memcpy(s.key, KEY, 16);
    s.keyOut = capturePin; s.rand32 = rnd32;
    s.rigLink = true; s.rigCw = true; s.rigMode = 0x03; s.rigFreq = 14025000;
    pin.clear();
  }

  std::vector<uint8_t> build(uint32_t t, const uint8_t *key = KEY) {
    // Paddle2IP keyer_collect(): the last 500 ms, max 8, always the newest while down.
    size_t n = sent.size(), first = n;
    while (first > 0 && n - first < RKEY_MAX_EV) {
      bool newestDown = first == n && sent[first - 1].down;
      if (!newestDown && (t - sent[first - 1].t) >= 500000u) break;
      first--;
    }
    RkeyKeyHdr h;
    h.magic = RKEY_MAGIC; h.ver = RKEY_VER; h.type = RKEY_T_KEY;
    h.flags = (n && (t - sent[n - 1].t) < 2000000u) ? RKEY_KF_ACTIVE : 0;
    h.session = session; h.wpm = wpm; h.nev = (uint8_t)(n - first);
    h.seq = ++seq; h.tSend = t; h.nonce = nonce;
    h.evIdx0 = (uint16_t)(evIdx + first); h.delayMs = 0;
    std::vector<uint8_t> b(sizeof(h) + 4 * h.nev + RKEY_TAG_LEN);
    memcpy(b.data(), &h, sizeof(h));
    for (size_t i = first; i < n; i++) {
      uint32_t e = (sent[i].t & ~1u) | (sent[i].down ? 1u : 0u);
      memcpy(b.data() + sizeof(h) + 4 * (i - first), &e, 4);
    }
    rkey_sign(key, b.data(), (uint16_t)(sizeof(h) + 4 * h.nev));
    return b;
  }

  void transmit(uint32_t t, std::vector<uint8_t> b) {
    if (linkDown || frand() < loss) return;
    uint32_t at = t + latencyUs + (jitterUs ? (uint32_t)(frand() * jitterUs) : 0);
    // UDP may reorder under jitter; the server must cope, so keep arrival order.
    auto it = up.begin();
    while (it != up.end() && (int32_t)(it->at - at) <= 0) ++it;
    up.insert(it, Datagram{at, b});
  }

  // One 0.5 ms step of sender time t.
  void step(uint32_t t) {
    // client: key edges due now, then send
    bool fire = false;
    while (todoPos < todo.size() && (int32_t)(t - todo[todoPos].t) >= 0) { sent.push_back(todo[todoPos++]); fire = true; }
    bool active = !sent.empty() && (t - sent.back().t) < 2000000u;
    if (fire || (t - lastSend) >= (active ? 20000u : 100000u)) { transmit(t, build(t)); lastSend = t; }

    // server, in its own clock
    uint32_t st = t + (uint32_t)clockOffset;
    simNow = st;
    while (!up.empty() && (int32_t)(t - up.front().at) >= 0) {
      Datagram d = up.front(); up.pop_front();
      uint8_t reply[sizeof(RkeyStatus) + RKEY_TAG_LEN];
      uint16_t n = rkeyOnPacket(s, d.b.data(), (uint16_t)d.b.size(), st, 0x0100007F, 40000, reply);
      if (n && !linkDown) down.push_back(Datagram{t + latencyUs, std::vector<uint8_t>(reply, reply + n)});
    }
    rkeyService(s, st);
    rkeyPlayTick(s, st);
    if (s.output == RKEY_OUT_CIV) {
      char f[30]; uint8_t n;
      while ((n = rkeyTakeText(s, f, 30)) > 0) frames.push_back(std::string(f, n));
    }

    // client: STATUS
    while (!down.empty() && (int32_t)(t - down.front().at) >= 0) {
      Datagram d = down.front(); down.pop_front();
      assert(d.b.size() == sizeof(RkeyStatus) + RKEY_TAG_LEN && rkey_verify(KEY, d.b.data(), (uint16_t)d.b.size()));
      memcpy(&lastStatus, d.b.data(), sizeof(lastStatus));
      haveStatus = true; statusCount++;
      nonce = lastStatus.nonce;
    }
  }

  uint32_t t = 1000000;
  void run(uint32_t us) { for (uint32_t end = t + us; (int32_t)(end - t) > 0; t += 500) step(t); }
  void key(const std::string &text, uint32_t leadUs = 50000) {
    todo = textEdges(text, wpm, t + leadUs);
    todoPos = 0;
  }
  // Run until the text is keyed and the stream has drained.
  void keyAll(const std::string &text) { key(text); run(todo.back().t - t + 1500000); }
  std::string text() const { std::string r; for (auto &f : frames) r += f; return r; }
};

// Mark/space lengths on the pin compared with what the paddle keyed.
static double worstTimingError(const std::vector<PinEdge> &want, size_t from, size_t n) {
  double worst = 0;
  for (size_t i = 1; i < n; i++) {
    double a = double(pin[i].t - pin[i - 1].t), b = double(want[from + i].t - want[from + i - 1].t);
    double e = a > b ? a - b : b - a;
    if (e > worst) worst = e;
  }
  return worst;
}

int main() {
  printf("Morse -> 0x17 text\n");
  {
    char t[3];
    CHECK(rkeyMorseText("-.-.", 4, t) == 1 && t[0] == 'C', "C");
    CHECK(rkeyMorseText(".-.-.", 5, t) == 1 && t[0] == '+', "AR is '+'");
    CHECK(rkeyMorseText("...-.-", 6, t) == 3 && memcmp(t, "^SK", 3) == 0, "SK is ^SK");
    CHECK(rkeyMorseText("........", 8, t) == 3 && t[0] == '^', "8 dots go as a joined pair");
    CHECK(rkeyMorseText(".-.-", 4, t) == 3 && memcmp(t, "^EK", 3) == 0, "any split keys the same elements: .-.- is ^EK");
    CHECK(rkeyMorseText(".............", 13, t) == 0, "13 dots: longer than any two characters, undecodable");
  }

  printf("GPIO output, clean link\n");
  {
    Sim m(RKEY_OUT_GPIO);
    m.run(300000);
    CHECK(m.haveStatus && m.lastStatus.session == m.session && rkeyConnected(m.s, m.t + (uint32_t)m.clockOffset),
          "session accepted after the nonce handshake");
    m.keyAll("CQ TEST DE OK1HRA");
    std::vector<PinEdge> want = m.sent;
    CHECK(pin.size() == want.size(), "every edge reached the pin (%zu of %zu)", pin.size(), want.size());
    size_t n = pin.size() < want.size() ? pin.size() : want.size();
    double w = worstTimingError(want, 0, n);
    CHECK(w <= 600, "marks and spaces keep their length (worst %.0f us)", w);
    uint32_t lead = pin[0].t - (want[0].t + (uint32_t)m.clockOffset);
    CHECK(lead >= 145000 && lead <= 155000, "first mark plays latency + D after the paddle (%u us)", lead);
    CHECK(m.s.lateEv == 0 && m.s.lostEv == 0, "no late or lost edges (%u/%u)", m.s.lateEv, m.s.lostEv);
    CHECK(!m.s.outDown, "key released at the end");
    char tr[RKEY_TRACE]; uint8_t tn = rkeyTraceCopy(m.s, tr, sizeof(tr));
    CHECK(std::string(tr, tn) == "CQ TEST DE OK1HRA", "SETUP trace reads the text: '%.*s'", tn, tr);
    CHECK(m.frames.empty(), "GPIO sends no 0x17 text");
  }

  printf("GPIO output, 20 %% loss and 40 ms jitter\n");
  {
    Sim m(RKEY_OUT_GPIO);
    m.loss = 0.2; m.jitterUs = 40000; m.s.delayMs = 150;
    m.run(500000);
    m.keyAll("PARIS PARIS PARIS");
    std::vector<PinEdge> want = m.sent;
    size_t n = pin.size() < want.size() ? pin.size() : want.size();
    CHECK(pin.size() == want.size(), "every edge reached the pin (%zu of %zu)", pin.size(), want.size());
    CHECK(worstTimingError(want, 0, n) <= 2000, "lengths within 2 ms (worst %.0f us)", worstTimingError(want, 0, n));
    CHECK(m.s.lostEv == 0, "redundancy covered the loss (lost %u)", m.s.lostEv);
  }

  printf("CIV output\n");
  {
    Sim m(RKEY_OUT_CIV);
    m.run(300000);
    m.keyAll("CQ CQ DE OK1HRA <SK>");
    CHECK(m.text() == "CQ CQ DE OK1HRA ^SK", "decoded: '%s'", m.text().c_str());
    CHECK(pin.empty(), "CIV never touches the pin");
    CHECK(m.s.undecoded == 0, "nothing undecodable");
    // A "^XY" pair stays whole in a frame even when it lands at the end of one.
    Sim k(RKEY_OUT_CIV);
    const char *fill = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012^SK";
    rkeyEmit(k.s, fill, 29);
    rkeyEmit(k.s, fill + 29, 3);
    char f[30]; uint8_t a = rkeyTakeText(k.s, f, 30), b = rkeyTakeText(k.s, f + a, 30);
    CHECK(a == 29 && b == 3 && f[29] == '^', "a ^XY pair at a frame end moves whole to the next frame");
  }

  printf("CIV output, new over after a pause starts without a space\n");
  {
    Sim m(RKEY_OUT_CIV);
    m.run(300000);
    m.keyAll("TEST");
    m.run(4000000);
    m.keyAll("K");
    CHECK(m.text() == "TESTK", "no word space across a %u s pause: '%s'", 4, m.text().c_str());
  }

  printf("authentication\n");
  {
    Sim m(RKEY_OUT_GPIO);
    m.run(300000);
    uint16_t rx0 = m.s.rxPkts;
    uint8_t reply[64];
    std::vector<uint8_t> good = m.build(m.t);
    std::vector<uint8_t> bad = good; bad.back() ^= 0x55;
    CHECK(rkeyOnPacket(m.s, bad.data(), (uint16_t)bad.size(), m.t, 1, 1, reply) == 0 && m.s.rxPkts == rx0, "bad tag refused");
    std::vector<uint8_t> flip = good; flip[12] ^= 1;
    rkeyOnPacket(m.s, flip.data(), (uint16_t)flip.size(), m.t, 1, 1, reply);
    CHECK(m.s.rxPkts == rx0, "modified body refused");
    uint8_t other[16]; memset(other, 0x42, 16);
    std::vector<uint8_t> wk = m.build(m.t, other);
    rkeyOnPacket(m.s, wk.data(), (uint16_t)wk.size(), m.t, 1, 1, reply);
    CHECK(m.s.rxPkts == rx0, "wrong key refused");
    CHECK(m.s.badAuth == 3, "and all three counted as bad tags (%u)", m.s.badAuth);
    rkeyOnPacket(m.s, good.data(), (uint16_t)good.size(), m.t, 1, 1, reply);
    uint16_t rx1 = m.s.rxPkts;
    rkeyOnPacket(m.s, good.data(), (uint16_t)good.size(), m.t, 1, 1, reply);
    CHECK(rx1 == rx0 + 1 && m.s.rxPkts == rx1, "replayed packet refused");
    uint16_t sess = m.session;
    m.session = 0x1234; uint32_t n0 = m.nonce; m.nonce = 0x12345678;
    std::vector<uint8_t> stale = m.build(m.t);
    CHECK(rkeyOnPacket(m.s, stale.data(), (uint16_t)stale.size(), m.t, 1, 1, reply) > 0 && m.s.session == sess,
          "a new session with a stale nonce gets a STATUS, not the session");
    RkeyStatus st; memcpy(&st, reply, sizeof(st));
    CHECK(st.flags & RKEY_SF_NONCE_BAD, "STATUS says NONCE_BAD");
    m.nonce = 0;
    std::vector<uint8_t> none = m.build(m.t);
    rkeyOnPacket(m.s, none.data(), (uint16_t)none.size(), m.t, 1, 1, reply);
    CHECK(m.s.session == sess, "a new session without a nonce is refused");
    m.nonce = n0; m.session = sess;
  }

  printf("safety: link dies mid-mark\n");
  {
    Sim m(RKEY_OUT_GPIO);
    m.wpm = 5;                                    // a dah is 720 ms
    m.run(300000);
    m.key("T");                                   // one long mark
    m.run(250000 + 50000);                        // past D: the mark is playing
    CHECK(m.s.outDown, "mark is on air");
    uint32_t cut = m.t + (uint32_t)m.clockOffset;
    m.linkDown = true; m.up.clear();
    m.run(600000);
    CHECK(!m.s.outDown && !pin.empty() && !pin.back().down, "key released");
    uint32_t held = pin.back().t - cut;
    CHECK(held <= RKEY_LINK_TIMEOUT_US + 60000, "within the link timeout of the last packet (%u ms)", held / 1000);
    CHECK(m.s.muted, "stream muted");
    // The link comes back mid-word: nothing plays until a word gap.
    m.linkDown = false;
    size_t before = pin.size();
    m.wpm = 25;
    m.key("EEEEEEEEEE", 0);                       // continuous dits, never a word gap
    m.run(1500000);
    CHECK(pin.size() == before, "nothing keyed while muted mid-word");
    m.run(1000000);
    m.keyAll("K");
    CHECK(pin.size() == before + 6 && !m.s.muted, "after a pause the next word plays (%zu edges)", pin.size() - before);
  }

  printf("safety: radio not in CW\n");
  {
    Sim m(RKEY_OUT_GPIO);
    m.s.rigCw = false;
    m.run(300000);
    m.keyAll("TEST");
    CHECK(pin.empty(), "nothing keyed");
    RkeyStatus st = m.lastStatus;
    CHECK(!(st.flags & RKEY_SF_CW_MODE) && (st.flags & RKEY_SF_MUTED), "STATUS: not CW, muted");
    Sim c(RKEY_OUT_CIV);
    c.s.rigCw = false;
    c.run(300000);
    c.keyAll("TEST");
    CHECK(c.frames.empty(), "CIV sends no text either");
  }

  printf("safety: max key-down\n");
  {
    Sim m(RKEY_OUT_GPIO);
    m.run(300000);
    m.todo = {{m.t + 50000, true}, {m.t + 5050000, false}};   // a 5 s "mark"
    m.todoPos = 0;
    m.run(4000000);
    CHECK(!m.s.outDown && pin.size() == 2, "released after the maximum");
    CHECK(pin[1].t - pin[0].t <= RKEY_MAX_DOWN_US + 1000, "after %u ms", (pin[1].t - pin[0].t) / 1000);
  }

  printf(failures ? "RKEY SERVER SMOKE FAIL (%d)\n" : "RKEY SERVER SMOKE PASS\n", failures);
  return failures ? 1 : 0;
}
