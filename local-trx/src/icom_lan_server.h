// icom_lan_server.h -- the ICOM LAN (RS-BA1) protocol, SERVER side (bod 1/2).
//
// Ported byte-for-byte from tools/icom-lan-fake-radio.py (see docs/
// local-trx-implementace.md, "Protokol server" -- that Python script is the
// proven-working reference, not re-derived from the ICOM spec). Reuses
// icom_lan_wire.h's endianness helpers and native/net's WiFiUDP exactly as
// bod 12 decided: source-recompiled, not a fork.
//
// Three independent channels share one handshake (AreYouThere/Ready/ping/
// retransmit/disconnect) -- Channel::handleCommon() -- and each layers its
// own packet types on top: ControlChannel (login/capabilities/stream),
// CivChannel (civ-open + FE FE...FD frames, routed through civ_router.h),
// AudioChannel (handshake only in this batch -- tone streaming is fáze 2/3).
#pragma once

#include <cstdint>
#include <deque>
#include <map>
#include <string>
#include <vector>

#include "audio_bridge.h"
#include "keying_backend.h"
#include "rig_backend.h"
#include "udp_socket.h"

namespace LocalTrx {

class Channel {
 public:
  Channel(std::string listenIp, uint16_t port, const char *tag, bool verbose);
  virtual ~Channel() = default;

  bool begin(std::string *error);
  // Drains every pending datagram on this channel's socket.
  void poll();

  bool linked() const { return linked_; }

 protected:
  // Subclasses' handle() call this first; a true return means the packet was
  // the shared handshake/keepalive and needs no further dispatch.
  bool handleCommon(const uint8_t *data, size_t len);

  void sendRaw(const uint8_t *data, size_t len, const char *label);
  void sendTracked(std::vector<uint8_t> packet, const char *label);
  std::vector<uint8_t> longHeader(size_t size, uint32_t inner);
  // Asks the peer to resend one previously-sent (tracked-style) packet by its
  // outer LE16 seq -- the request side of the retransmit protocol
  // handleCommon() already answers from the other direction (bod: fáze 3,
  // gap detection on incoming audio -- the peer's own IcomLanAudioTx keeps a
  // bounded replay history for exactly this, icom_lan_audio_tx.h's
  // HISTORY_PACKETS).
  void requestRetransmit(uint16_t seq);

  void log(const std::string &message) const;
  void vlog(const std::string &message) const;

  uint32_t myId_ = 0;
  uint32_t remoteId_ = 0;
  bool linked_ = false;

 private:
  virtual void handle(const uint8_t *data, size_t len) = 0;

  UdpSocket udp_;
  std::string listenIp_;
  uint16_t port_;
  const char *tag_;
  bool verbose_;
  UdpPeer peer_;
  UdpPeer lastFrom_;         // source of the most recent datagram, regardless
                             // of peer_ -- lets handleCommon() re-target a
                             // reconnect (see its AreYouThere branch)
  bool havePeer_ = false;
  uint16_t sendSeq_ = 0;
  // Bounded retransmit history (icom_lan_server.cpp's kTxHistoryPackets) --
  // txOrder_ is the FIFO of keys in actual send order, used to evict the
  // oldest entry from txBuf_ once the bound is exceeded (see sendTracked()).
  std::map<uint16_t, std::vector<uint8_t>> txBuf_;
  std::deque<uint16_t> txOrder_;
};

class ControlChannel : public Channel {
 public:
  ControlChannel(std::string listenIp, bool verbose, std::string radioName, uint8_t civAddr);

  bool streaming() const { return streaming_; }

 private:
  void handle(const uint8_t *data, size_t len) override;
  void onLogin(const uint8_t *data, size_t len);
  void sendCapabilities();
  void sendConninfo();
  void onToken(const uint8_t *data, size_t len);
  void onStreamRequest();

  std::string radioName_;
  uint8_t civAddr_;
  uint32_t token_ = 0x0BADC0DE;
  uint16_t tokRequest_ = 0;
  bool streaming_ = false;
};

class CivChannel : public Channel {
 public:
  // keying is nullable -- see civ_router.h's dispatchCiv() for what that degrades to.
  CivChannel(std::string listenIp, bool verbose, uint8_t civAddr, RigBackend &rig,
             KeyingBackend *keying);

  bool opened() const { return opened_; }

  // bod 11 category (d), fáze 7: poll the rig every kBroadcastPollMs and push
  // an unsolicited CI-V transceive frame (cmd 0x00/0x01, addressed to the
  // broadcast address) when freq/mode changed since the last poll -- the same
  // thing a real ICOM radio does the instant its own VFO knob turns, which a
  // pure request/reply model like this server's would otherwise only surface
  // up to CAT_POLL_MS (wifilt.ino:808, 1s in the slow/non-fastCat path) later.
  void tick(uint32_t nowMs);

 private:
  void handle(const uint8_t *data, size_t len) override;
  void sendCiv(const std::vector<uint8_t> &frame);
  void onCivFrame(const std::vector<uint8_t> &frame);

  uint8_t civAddr_;
  RigBackend &rig_;
  KeyingBackend *keying_;
  uint16_t seqB_ = 0;
  bool opened_ = false;

  uint32_t nextBroadcastPollMs_ = 0;
  bool haveLastBroadcast_ = false;
  uint64_t lastBroadcastFreqHz_ = 0;
  uint8_t lastBroadcastModeByte_ = 0;
};

class AudioChannel : public Channel {
 public:
  // capture/playback are independently nullable -- no audio.inputDevice (or
  // .outputDevice) configured, or it failed to open, means the channel still
  // completes its handshake and (for TX) still gap-detects, it just has
  // nothing to stream or nowhere to play decoded audio.
  AudioChannel(std::string listenIp, bool verbose, AudioCapture *capture, AudioPlayback *playback);

  // Call every IcomLanServer::poll() cycle -- paces outgoing packets at the
  // wire format's fixed 20ms/8kHz cadence, independent of how often poll()
  // itself happens to run.
  void tick(uint32_t nowMs);

 private:
  void handle(const uint8_t *data, size_t len) override;
  void onTxAudio(const uint8_t *data, size_t len);

  AudioCapture *capture_;
  AudioPlayback *playback_;

  // RX (server->client) send side.
  uint16_t audioOutSeq_ = 0;      // outer LE16 seq, fire-and-forget (bod: not
                                   // tracked/replayed -- see audio_bridge.h)
  uint16_t audioSequence_ = 0;    // inner BE16 content sequence, wire offset 0x12
  uint32_t nextSendMs_ = 0;
  bool sending_ = false;
  // Reused across tick() calls (packet size is fixed -- see tick()'s own
  // comment) instead of a fresh std::vector allocation every 20ms for the
  // life of a streaming session (found by code review).
  std::vector<uint8_t> packetBuf_;

  // TX (client->server) receive side, fáze 3: gap detection assumes wifilt's
  // outer and inner sequences advance in lockstep (one packet per pacing
  // tick, same as this channel's own RX send side does) -- true for
  // IcomLanAudioTx's own poll()/commitSend() pairing.
  bool haveLastRx_ = false;
  uint16_t lastOuterSeqRx_ = 0;
  uint16_t lastInnerSeqRx_ = 0;
};

// Ties the three channels together. connected() matches the phase-0 goal in
// docs/local-trx-implementace.md: "wifilt se připojí, catHealthy()==true,
// /state ukazuje frekvenci".
class IcomLanServer {
 public:
  // capture/playback are independently nullable -- see AudioChannel's own
  // constructor comment.
  IcomLanServer(std::string listenIp, std::string radioName, uint8_t civAddr, RigBackend &rig,
                KeyingBackend *keying, AudioCapture *capture, AudioPlayback *playback,
                bool verbose);

  bool begin(std::string *error);
  void poll();
  bool connected() const { return control_.streaming() && civ_.opened(); }

 private:
  ControlChannel control_;
  CivChannel civ_;
  AudioChannel audio_;
};

}  // namespace LocalTrx
