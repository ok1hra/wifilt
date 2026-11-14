// SPDX-License-Identifier: GPL-3.0-or-later
// See ts480_ws.h.
#include "ts480_ws.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstring>

#include <WiFi.h>

#include "../third_party/json/json.hpp"
#include "audio_bridge.h"
#include "ptt_arbiter.h"
#include "ts480_link.h"
#include "ts480_protocol.h"

using nlohmann::json;

// native/net/WiFi.cpp: whether WiFiServer::begin() really got its port (the
// Arduino API returns void).
bool nativeListenerOk(uint16_t requested);
const char *nativeListenerError(uint16_t requested);

namespace LocalTrx {

namespace {

constexpr int kOpContinuation = 0x0, kOpText = 0x1, kOpBinary = 0x2, kOpClose = 0x8, kOpPing = 0x9,
              kOpPong = 0xA;
constexpr size_t kMaxHandshake = 8192;
constexpr size_t kAfChunk = 320;   // 40 ms of 8 kHz µ-law per frame

int64_t nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

std::string lower(std::string s) {
  for (char &c : s) c = (char)std::tolower((unsigned char)c);
  return s;
}

std::string trimmed(const std::string &s) {
  size_t a = s.find_first_not_of(" \t"), b = s.find_last_not_of(" \t\r");
  return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
}

}  // namespace


struct Ts480WsServer::Client {
  WiFiClient socket;
  bool upgraded = false;
  bool dead = false;
  std::string in;
  int64_t connectedMs = 0;
  std::set<std::string> held;
  bool af = false;
  bool ptt = false;
  int64_t pttSinceMs = 0;
  int64_t lastTxAudioMs = 0;
  std::string peer;
};

Ts480WsServer::Ts480WsServer(uint16_t port, Ts480Link &link, AudioCapture *capture,
                             AudioPlayback *playback, PttArbiter *ptt)
    : port_(port), link_(link), capture_(capture), playback_(playback), ptt_(ptt),
      server_(std::make_unique<WiFiServer>(port, kMaxClients)) {}

Ts480WsServer::~Ts480WsServer() {
  for (auto &c : clients_) drop(*c);
  clients_.clear();
  if (capture_) capture_->setTapEnabled(false);
}

bool Ts480WsServer::begin(std::string *error) {
  server_->begin();
  if (!nativeListenerOk(port_)) {
    if (error) *error = "TS-480 panel WebSocket: port " + std::to_string(port_) + ": " + nativeListenerError(port_);
    return false;
  }
  server_->setNoDelay(true);
  return true;
}

void Ts480WsServer::accept() {
  for (;;) {
    WiFiClient incoming = server_->available();
    if (!incoming) return;
    if ((int)clients_.size() >= kMaxClients) {
      const char *busy = "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
      incoming.write(reinterpret_cast<const uint8_t *>(busy), std::strlen(busy));
      incoming.stop();
      continue;
    }
    auto c = std::make_unique<Client>();
    c->socket = incoming;
    c->connectedMs = nowMs();
    c->peer = incoming.remoteIP().toString().c_str();
    clients_.push_back(std::move(c));
  }
}

void Ts480WsServer::poll() {
  accept();
  const int64_t now = nowMs();

  for (auto &c : clients_) serviceClient(*c, now);

  // AF tap: on only while some page listens.
  bool wantAf = false;
  for (auto &c : clients_)
    if (c->upgraded && !c->dead && c->af) wantAf = true;
  if (capture_ && wantAf != tapOn_) {
    capture_->setTapEnabled(wantAf);
    tapOn_ = wantAf;
    afPending_.clear();
  }
  if (capture_ && tapOn_) {
    uint8_t buffer[1600];
    size_t got = capture_->pullTap(buffer, sizeof(buffer));
    afPending_.append(reinterpret_cast<const char *>(buffer), got);
    while (afPending_.size() >= kAfChunk) {
      const std::string chunk = afPending_.substr(0, kAfChunk);
      afPending_.erase(0, kAfChunk);
      for (auto &c : clients_)
        if (c->upgraded && !c->dead && c->af) sendBinary(*c, chunk);
    }
  }

  if (now - lastBroadcastMs_ >= kBroadcastMs && link_.takeDirty()) {
    lastBroadcastMs_ = now;
    const std::string snapshot = link_.snapshotJson();
    for (auto &c : clients_)
      if (c->upgraded && !c->dead) sendText(*c, snapshot);
  }

  for (auto &c : clients_) {
    if (c->dead) continue;
    pttWatchdog(*c, now);
  }

  for (auto &c : clients_)
    if (c->dead) drop(*c);
  clients_.erase(std::remove_if(clients_.begin(), clients_.end(), [](const std::unique_ptr<Client> &c) { return c->dead; }),
                 clients_.end());
}

void Ts480WsServer::serviceClient(Client &c, int64_t now) {
  if (c.dead) return;
  uint8_t buffer[4096];
  for (int rounds = 0; rounds < 16; rounds++) {
    int n = c.socket.read(buffer, sizeof(buffer));
    if (n <= 0) break;
    c.in.append(reinterpret_cast<const char *>(buffer), (size_t)n);
  }
  if (!c.upgraded) {
    if (c.in.find("\r\n\r\n") != std::string::npos) {
      handshake(c);
    } else if (c.in.size() > kMaxHandshake || now - c.connectedMs > 5000) {
      c.dead = true;
    }
  }
  while (c.upgraded && !c.dead) {
    int opcode = 0;
    std::string payload;
    size_t consumed = 0;
    const int r = Ws::parseFrame(c.in, &opcode, &payload, &consumed);
    if (r == 0) break;
    if (r < 0) {
      c.dead = true;
      break;
    }
    c.in.erase(0, consumed);
    if (opcode == kOpText) {
      handleText(c, payload, now);
    } else if (opcode == kOpBinary) {
      handleBinary(c, payload, now);
    } else if (opcode == kOpPing) {
      sendRaw(c, Ws::buildFrame(kOpPong, payload));
    } else if (opcode == kOpClose) {
      sendRaw(c, Ws::buildFrame(kOpClose, ""));
      c.dead = true;
    } else if (opcode == kOpContinuation || opcode == kOpPong) {
      // browsers never fragment these small messages; pongs need nothing
    }
  }
  if (!c.socket.connected()) c.dead = true;
}

void Ts480WsServer::handshake(Client &c) {
  const size_t end = c.in.find("\r\n\r\n");
  const std::string request = c.in.substr(0, end);
  c.in.erase(0, end + 4);

  std::string path, key;
  bool upgrade = false;
  size_t pos = 0, lineNo = 0;
  while (pos <= request.size()) {
    size_t eol = request.find("\r\n", pos);
    if (eol == std::string::npos) eol = request.size();
    const std::string line = request.substr(pos, eol - pos);
    pos = eol + 2;
    if (lineNo++ == 0) {
      // GET /ts480 HTTP/1.1
      size_t a = line.find(' '), b = line.rfind(' ');
      if (a != std::string::npos && b > a) path = line.substr(a + 1, b - a - 1);
      continue;
    }
    size_t colon = line.find(':');
    if (colon == std::string::npos) continue;
    const std::string name = lower(trimmed(line.substr(0, colon)));
    const std::string value = trimmed(line.substr(colon + 1));
    if (name == "upgrade" && lower(value) == "websocket") upgrade = true;
    if (name == "sec-websocket-key") key = value;
  }
  const size_t query = path.find('?');
  if (query != std::string::npos) path = path.substr(0, query);
  if (!upgrade || key.empty() || path != "/ts480") {
    sendRaw(c, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    c.dead = true;
    return;
  }
  sendRaw(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
             "Sec-WebSocket-Accept: " + Ws::acceptKey(key) + "\r\n\r\n");
  if (c.dead) return;
  c.upgraded = true;
  std::printf("[ts480] browser %s connected\n", c.peer.c_str());
  std::fflush(stdout);
  sendText(c, helloJson());
  sendText(c, link_.snapshotJson());
}

std::string Ts480WsServer::helloJson() const {
  json keys = json::array();
  for (const Ts480::KeyDef &k : Ts480::keys()) {
    keys.push_back({{"name", k.name}, {"code", std::string(1, k.code)}, {"label", k.label},
                    {"alt", k.alt}, {"digit", k.digit}, {"verified", true}});
  }
  json hello;
  hello["type"] = "hello";
  hello["keys"] = keys;
  hello["af"] = afAvailable();
  hello["tx"] = txAvailable();
  hello["port"] = link_.describe();
  return hello.dump();
}

void Ts480WsServer::handleText(Client &c, const std::string &text, int64_t now) {
  json m;
  try {
    m = json::parse(text);
  } catch (const json::exception &) {
    return;
  }
  if (!m.is_object()) return;
  const std::string op = m.value("op", "");
  try {
    if (op == "down") {
      const std::string key = m.value("key", "");
      link_.keyDown(key);
      if (key != "POWER") c.held.insert(key);
    } else if (op == "up") {
      const std::string key = m.value("key", "");
      link_.keyUp(key);
      c.held.erase(key);
    } else if (op == "enc") {
      link_.encoder(m.value("which", ""), m.value("delta", 0));
    } else if (op == "pot") {
      link_.setPot(m.value("which", ""), m.value("value", 0));
    } else if (op == "freq") {
      link_.directFreq(m.value("khz", 0.0));
    } else if (op == "reconnect") {
      link_.reconnect();
    } else if (op == "af") {
      c.af = capture_ != nullptr && m.value("on", false);
    } else if (op == "ptt") {
      setPtt(c, m.value("on", false), "", now);
    }
  } catch (const json::exception &) {
    // wrong-typed field from a hand-made client: ignore the message
  }
}

void Ts480WsServer::handleBinary(Client &c, const std::string &data, int64_t now) {
  if (!c.ptt || !playback_) return;
  std::vector<int16_t> pcm(data.size());
  for (size_t i = 0; i < data.size(); i++) pcm[i] = ulawDecode((uint8_t)data[i]);
  playback_->pushBrowser(pcm.data(), pcm.size());
  c.lastTxAudioMs = now;
}

void Ts480WsServer::setPtt(Client &c, bool on, const std::string &reason, int64_t now) {
  std::string why = reason;
  if (on && !c.ptt) {
    const int mode = link_.modeCode();
    if (!txAvailable()) {
      why = "no TX audio device in local-trx";
    } else if (!link_.connected() || link_.power() != 1) {
      why = "the radio is off";
    } else if (!Ts480::isVoiceMode(mode)) {
      why = "PTT only in SSB, AM and FM";
    } else {
      for (auto &other : clients_)
        if (other.get() != &c && other->ptt) why = "another browser is transmitting";
      if (why.empty() && !ptt_->browserPtt(true, &why) && why.empty()) why = "refused";
      if (why.empty()) {
        c.ptt = true;
        c.pttSinceMs = now;
        c.lastTxAudioMs = now + (kPttStartGraceMs - kPttAudioTimeoutMs);
        playback_->setBrowserExclusive(true);
        std::printf("[ts480] PTT ON from browser %s\n", c.peer.c_str());
        std::fflush(stdout);
      }
    }
  } else if (!on && c.ptt) {
    c.ptt = false;
    ptt_->browserPtt(false, nullptr);
    playback_->setBrowserExclusive(false);
    std::printf("[ts480] PTT off from browser %s%s%s\n", c.peer.c_str(), reason.empty() ? "" : ": ",
                reason.c_str());
    std::fflush(stdout);
  }
  if (!c.dead && c.upgraded) {
    json m{{"type", "ptt"}, {"on", c.ptt}, {"reason", c.ptt ? std::string() : why}};
    sendText(c, m.dump());
  }
}

void Ts480WsServer::pttWatchdog(Client &c, int64_t now) {
  if (!c.ptt) return;
  if (now - c.lastTxAudioMs > kPttAudioTimeoutMs) {
    setPtt(c, false, "no microphone audio for 1 s", now);
  } else if (now - c.pttSinceMs > kPttMaxMs) {
    setPtt(c, false, "3 minute limit", now);
  } else if (!Ts480::isVoiceMode(link_.modeCode())) {
    setPtt(c, false, "the radio left SSB/AM/FM", now);
  } else if (!link_.connected() || link_.power() != 1) {
    setPtt(c, false, "the radio is off or the panel link is down", now);
  }
}

void Ts480WsServer::drop(Client &c) {
  c.dead = true;
  if (c.ptt) {
    c.ptt = false;
    if (ptt_) ptt_->browserPtt(false, nullptr);
    if (playback_) playback_->setBrowserExclusive(false);
    std::printf("[ts480] PTT off: browser %s went away\n", c.peer.c_str());
  }
  for (const std::string &key : c.held) link_.keyUp(key);   // never leave a key stuck down
  c.held.clear();
  if (c.upgraded) std::printf("[ts480] browser %s disconnected\n", c.peer.c_str());
  std::fflush(stdout);
  c.upgraded = false;
  c.socket.stop();
}

bool Ts480WsServer::sendText(Client &c, const std::string &text) { return sendRaw(c, Ws::buildFrame(kOpText, text)); }

bool Ts480WsServer::sendBinary(Client &c, const std::string &data) { return sendRaw(c, Ws::buildFrame(kOpBinary, data)); }

bool Ts480WsServer::sendRaw(Client &c, const std::string &bytes) {
  if (c.dead) return false;
  const size_t sent = c.socket.write(reinterpret_cast<const uint8_t *>(bytes.data()), bytes.size());
  if (sent != bytes.size()) {
    // A half-written frame corrupts the stream: this client is done.
    c.dead = true;
    return false;
  }
  return true;
}

}  // namespace LocalTrx
