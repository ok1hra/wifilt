// SPDX-License-Identifier: GPL-3.0-or-later
// ts480_ws.h -- the TS-480 panel's WebSocket (ws://<host>:<webPort+1>/ts480):
// display state to the browser, keys / knobs / power from it, and optionally
// AF both ways (RX audio from local-trx's sound card to the browser, the
// browser microphone to the radio while it holds PTT).
//
// The wizard's HTTP server (native WebServer) has no WebSocket upgrade, hence
// a port of its own -- the same split wifilt itself has (HTTP :80, AUD1 :83).
// A WebSocket is also the one thing a page from another origin (QRPlog,
// served by wifilt) may open to local-trx without CORS.
//
// Protocol (JSON text frames, same as ts-480-web-panel's server.py):
//   server -> browser  {"type":"hello",...}  {"type":"state",...}
//                      {"type":"ptt","on":bool,"reason":"..."}
//   browser -> server  {"op":"down"|"up","key":NAME}  {"op":"enc","which","delta"}
//                      {"op":"pot","which","value"}  {"op":"freq","khz"}
//                      {"op":"reconnect"}  {"op":"af","on":bool}  {"op":"ptt","on":bool}
// Binary frames: 8 kHz mono G.711 µ-law. Server -> browser = RX audio while
// "af" is on; browser -> server = microphone, used only while that browser
// holds PTT.
//
// PTT safety (an orphaned page must never keep a transmitter keyed): PTT
// drops when the socket closes, when no microphone frame arrived for 1 s,
// after 3 minutes, when the radio leaves SSB/AM/FM, and when the panel link
// or the radio's power goes away.
#pragma once

#include <cstdint>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "ws_frame.h"

class WiFiServer;

namespace LocalTrx {

class Ts480Link;
class AudioCapture;
class AudioPlayback;
class PttArbiter;


class Ts480WsServer {
 public:
  static constexpr int kMaxClients = 4;
  static constexpr int kBroadcastMs = 30;
  static constexpr int kPttAudioTimeoutMs = 1000;
  static constexpr int kPttStartGraceMs = 1500;
  static constexpr int kPttMaxMs = 180000;

  // capture/playback/ptt may be null: no AF, no TX.
  Ts480WsServer(uint16_t port, Ts480Link &link, AudioCapture *capture, AudioPlayback *playback,
                PttArbiter *ptt);
  ~Ts480WsServer();

  bool begin(std::string *error);
  void poll();   // main loop, non-blocking

  uint16_t port() const { return port_; }
  bool afAvailable() const { return capture_ != nullptr; }
  bool txAvailable() const { return playback_ != nullptr && ptt_ != nullptr; }

 private:
  struct Client;
  void accept();
  void serviceClient(Client &c, int64_t nowMs);
  void handshake(Client &c);
  void handleText(Client &c, const std::string &text, int64_t nowMs);
  void handleBinary(Client &c, const std::string &data, int64_t nowMs);
  void setPtt(Client &c, bool on, const std::string &reason, int64_t nowMs);
  void pttWatchdog(Client &c, int64_t nowMs);
  void drop(Client &c);
  bool sendText(Client &c, const std::string &text);
  bool sendBinary(Client &c, const std::string &data);
  bool sendRaw(Client &c, const std::string &bytes);
  std::string helloJson() const;

  uint16_t port_;
  Ts480Link &link_;
  AudioCapture *capture_;
  AudioPlayback *playback_;
  PttArbiter *ptt_;
  std::unique_ptr<WiFiServer> server_;
  std::vector<std::unique_ptr<Client>> clients_;
  int64_t lastBroadcastMs_ = 0;
  bool tapOn_ = false;
  std::string afPending_;
};

}  // namespace LocalTrx
