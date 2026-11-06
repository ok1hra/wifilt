#pragma once

// VARA host ports for Winlink clients (Pat, Winlink Express): TCP 8300 for
// commands, 8301 for data -- the two sockets a VARA modem offers. The modem
// itself is XARA in the browser (data/vara-worker.js), so this is only a
// relay: bytes from the two TCP clients go to the page that holds the radio
// lease as "vara.host" control frames on its own AUD1 WebSocket, and what the
// page sends back the same way goes out on the matching socket. Riding the
// AUD1 socket means the lease that decides who may transmit also decides who
// gets the host traffic -- no second ownership check to keep in step.
//
// Connection rules are upstream's (xara-host/src/server.rs): one client per
// port, a second one is refused while the first is attached; either port
// connecting tells the modem "Connected"; either one ending closes both and
// tells it "Closed" once. With no XARA page holding the radio there is no
// modem, and a client is turned away at once rather than left talking to
// nothing -- the page has to be open for Pat to work.
//
// Wire (JSON text frames on /audiows, docs/aud1-audio-websocket-protocol.md):
//   firmware -> page   {"type":"vara.host","ev":"open","ch":"cmd"|"data","peer":"a.b.c.d"}
//                      {"type":"vara.host","ev":"close"}
//                      {"type":"vara.host","ch":"cmd"|"data","b64":"..."}
//   page -> firmware   {"type":"vara.host","ch":"cmd"|"data","b64":"..."}
//                      {"type":"vara.host","ev":"close"}
//                      {"type":"vara.hold","on":true|false}   (data port flow control)
//
// Base64 because the AUD1 parser on the page treats every binary frame as
// audio; a VARA link moves at most a few kB/s, so the third on top is nothing.

#include <stdint.h>
#include <string.h>
#include <new>

static const uint16_t VARA_CMD_PORT = 8300, VARA_DATA_PORT = 8301;

// ---- base64 (RFC 4648, padded) -----------------------------------------------
static const char VARA_B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t varaB64Encode(const uint8_t *in, size_t n, char *out) {
  size_t o = 0;
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = uint32_t(in[i]) << 16;
    if (i + 1 < n) v |= uint32_t(in[i + 1]) << 8;
    if (i + 2 < n) v |= in[i + 2];
    out[o++] = VARA_B64[(v >> 18) & 63];
    out[o++] = VARA_B64[(v >> 12) & 63];
    out[o++] = i + 1 < n ? VARA_B64[(v >> 6) & 63] : '=';
    out[o++] = i + 2 < n ? VARA_B64[v & 63] : '=';
  }
  out[o] = 0;
  return o;
}

static int varaB64Value(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

// Returns the decoded length, or -1 on a malformed string or a too small `out`.
static int varaB64Decode(const char *in, size_t n, uint8_t *out, size_t cap) {
  size_t o = 0;
  uint32_t v = 0;
  int bits = 0;
  for (size_t i = 0; i < n; i++) {
    if (in[i] == '=') break;
    int d = varaB64Value(in[i]);
    if (d < 0) return -1;
    v = (v << 6) | uint32_t(d);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (o >= cap) return -1;
      out[o++] = uint8_t(v >> bits);
    }
  }
  return int(o);
}

// ---- the relay -------------------------------------------------------------------
// The sketch supplies the four things that are its own: is a XARA page holding
// the radio, send it a text frame, how much room its send queue has, and a log.
struct VaraHostHooks {
  bool (*modemPresent)();
  bool (*sendText)(const char *json, size_t n);
  size_t (*sendRoom)();
  void (*log)(const char *line);
};

class VaraHostBridge {
public:
  static const size_t READ_CHUNK = 768;        // per port and tick, before base64
  static const size_t OUT_CAP = 4096;          // queued toward one TCP client

  explicit VaraHostBridge(VaraHostHooks hooks) : h(hooks), cmdServer(VARA_CMD_PORT), dataServer(VARA_DATA_PORT) {}

  void begin() { cmdServer.begin(); dataServer.begin(); started = true; }

  void tick() {
    if (!started) return;
    bool modem = h.modemPresent();
    accept(cmdServer, ports[0], "cmd", modem);
    accept(dataServer, ports[1], "data", modem);
    bool any = ports[0].attached || ports[1].attached;
    if (!any) return;
    // The page went away (closed, lease taken over): the modem is gone, so is
    // the host session -- exactly what a client sees when a VARA modem quits.
    if (!modem) { closeAll(false, "XARA page gone"); return; }
    for (int i = 0; i < 2; i++) {
      Port &p = ports[i];
      if (!p.attached) continue;
      if (!p.client.connected()) { closeAll(true, i ? "data client closed" : "cmd client closed"); return; }
      drain(p);
      if (p.failed) { closeAll(true, "client not reading"); return; }
      if (i == 1 && hold) continue;
      pump(p, i ? "data" : "cmd");
    }
  }

  // A control frame from the page (aud1HandleControl hands over the whole JSON).
  void fromPage(const char *ch, const char *b64, size_t b64Len, bool closeReq) {
    if (closeReq) { closeAll(false, "closed by the modem"); return; }
    Port *p = ch && !strcmp(ch, "cmd") ? &ports[0] : ch && !strcmp(ch, "data") ? &ports[1] : nullptr;
    if (!p || !p->attached || !b64Len || !buf) return;
    uint8_t *scratch = buf->scratch;
    int n = varaB64Decode(b64, b64Len, scratch, OUT_CAP);
    if (n <= 0) return;
    if (size_t(n) > OUT_CAP - p->outLen) { p->failed = true; return; }   // a client that stopped reading
    for (int i = 0; i < n; i++) { p->out[(p->outHead + p->outLen) % OUT_CAP] = scratch[i]; p->outLen++; }
    drain(*p);
  }
  void setHold(bool on) { hold = on; }
  bool cmdAttached() const { return ports[0].attached; }
  bool dataAttached() const { return ports[1].attached; }

private:
  struct Port {
    WiFiClient client;
    bool attached = false, failed = false;
    uint8_t *out = nullptr;              // into buf while a client is attached
    size_t outHead = 0, outLen = 0;
  };
  // About 13 kB, so it exists only while a Winlink client is attached: an
  // ESP32 that never sees one (most of them) must not pay for it -- the heap
  // it took from boot was enough to starve the WiFi stack and the audio task.
  struct Buffers {
    uint8_t out[2][OUT_CAP];
    uint8_t scratch[OUT_CAP];
    char frameOut[48 + (READ_CHUNK + 2) / 3 * 4 + 4];
  };
  bool ensureBuffers() {
    if (!buf) buf = new (std::nothrow) Buffers;
    if (!buf) return false;
    ports[0].out = buf->out[0]; ports[1].out = buf->out[1];
    return true;
  }
  void freeBuffers() {
    delete buf; buf = nullptr;
    ports[0].out = ports[1].out = nullptr;
  }

  void say(const char *what, const char *ch) {
    char line[96];
    snprintf(line, sizeof(line), "VARA| %s %s", ch, what);
    h.log(line);
  }

  void accept(WiFiServer &server, Port &p, const char *ch, bool modem) {
    WiFiClient c = server.available();
    if (!c) return;
    if (!modem) { c.stop(); say("client refused: no XARA page holds the radio", ch); return; }
    if (p.attached && p.client.connected()) { c.stop(); say("second client refused", ch); return; }
    if (!ensureBuffers()) { c.stop(); say("client refused: out of memory", ch); return; }
    c.setNoDelay(true);
    p.client = c; p.attached = true; p.failed = false; p.outHead = p.outLen = 0;
    IPAddress ip = c.remoteIP();
    char json[112];
    int n = snprintf(json, sizeof(json), "{\"type\":\"vara.host\",\"ev\":\"open\",\"ch\":\"%s\",\"peer\":\"%u.%u.%u.%u\"}",
                     ch, ip[0], ip[1], ip[2], ip[3]);
    h.sendText(json, size_t(n));
    say("client connected", ch);
  }

  void closeAll(bool tellPage, const char *why) {
    for (Port &p : ports) {
      if (p.attached) p.client.stop();
      p.attached = false; p.failed = false; p.outHead = p.outLen = 0;
    }
    hold = false;
    freeBuffers();
    if (tellPage) { static const char msg[] = "{\"type\":\"vara.host\",\"ev\":\"close\"}"; h.sendText(msg, sizeof(msg) - 1); }
    h.log((String("VARA| host closed: ") + why).c_str());
  }

  // Socket -> page, sized to what the AUD1 queue can take now: audio comes
  // first there, and a frame that does not fit would be dropped whole.
  void pump(Port &p, const char *ch) {
    int avail = p.client.available();
    if (avail <= 0) return;
    size_t want = size_t(avail) < READ_CHUNK ? size_t(avail) : READ_CHUNK;
    size_t frame = 48 + (want + 2) / 3 * 4;
    if (h.sendRoom() < frame + 4096) return;     // keep room for the RX audio
    if (!buf) return;
    int got = p.client.read(buf->scratch, want);
    if (got <= 0) return;
    char *json = buf->frameOut;
    int n = snprintf(json, sizeof(buf->frameOut), "{\"type\":\"vara.host\",\"ch\":\"%s\",\"b64\":\"", ch);
    n += int(varaB64Encode(buf->scratch, size_t(got), json + n));
    json[n++] = '"'; json[n++] = '}'; json[n] = 0;
    h.sendText(json, size_t(n));
  }

  // Page -> socket, never blocking: what the kernel will not take now waits.
  void drain(Port &p) {
    while (p.outLen && p.out) {
      size_t run = OUT_CAP - p.outHead;
      if (run > p.outLen) run = p.outLen;
      int fd = p.client.fd();
      if (fd < 0) { p.failed = true; return; }
      int sent = netSendNonBlocking(fd, p.out + p.outHead, run);
      if (sent < 0) { p.failed = true; return; }
      if (sent == 0) return;
      p.outHead = (p.outHead + size_t(sent)) % OUT_CAP;
      p.outLen -= size_t(sent);
    }
  }

  VaraHostHooks h;
  WiFiServer cmdServer, dataServer;
  Port ports[2];
  bool started = false, hold = false;
  Buffers *buf = nullptr;   // off the stack (the loop task has 8 kB) and off the heap when idle
};
