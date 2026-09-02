// icom_lan_wire.h must come before icom_lan_server.h (-> udp_socket.h ->
// socket_compat.h -> <arpa/inet.h>): arpa/inet.h #defines INADDR_NONE as a
// numeric macro, which mangles native/arduino/IPAddress.h's own
// "extern IPAddress INADDR_NONE;" declaration if that declaration has not
// been parsed yet. native/net/Udp.h dodges this the same way (IPAddress.h
// before socket_compat.h) -- discovered here 2026-08-31, matched, not fixed
// upstream (bod 12: zero diff in native/).
#include "../../icom_lan_wire.h"

#include <cstdio>
#include <cstring>

#include "civ_router.h"
#include "icom_lan_server.h"

namespace LocalTrx {

namespace {

constexpr uint16_t CONTROL_PORT = 50001;
constexpr uint16_t CIV_PORT = 50002;
constexpr uint16_t AUDIO_PORT = 50003;

// Same bound wifilt's own icom_lan_tx_history.h (HISTORY_PACKETS) and this
// file's own kMaxGapChase below already use for a retransmit replay window --
// a real client only ever asks to resend something it noticed missing within
// the last handful of packets, never one from minutes/hours ago. Without a
// bound, Channel::txBuf_ kept every tracked packet for the rest of the
// session (sendSeq_ is a uint16_t, so it is naturally capped at 65536
// entries by key reuse on wraparound, but that is still tens of thousands of
// heap-allocated std::vectors sitting around doing nothing -- found by code
// review).
constexpr size_t kTxHistoryPackets = 32;

// Control-header packet types (icom-lan-fake-radio.py's T_* constants).
// TYPE_ARE_YOU_THERE/TYPE_I_AM_HERE already live in icom_lan_wire.h.
constexpr uint16_t T_IDLE = 0x00;
constexpr uint16_t T_RETRANSMIT = 0x01;
constexpr uint16_t T_READY = 0x06;
constexpr uint16_t T_PING = 0x07;
constexpr uint16_t T_DISCONNECT = 0x05;

}  // namespace

// ---- Channel ---------------------------------------------------------------

Channel::Channel(std::string listenIp, uint16_t port, const char *tag, bool verbose)
    : listenIp_(std::move(listenIp)), port_(port), tag_(tag), verbose_(verbose) {
  // Deliberately NOT IcomWire::mkId() (that helper is the CLIENT's own IP-
  // derived scheme): the proven-working fake-radio.py server side just ORs
  // the port into a fixed prefix, and there is no reason to diverge.
  myId_ = 0x50000000u | port_;
}

bool Channel::begin(std::string *error) {
  std::string bindError;
  if (!udp_.begin(listenIp_, port_, &bindError)) {
    if (error) *error = std::string(tag_) + ": " + bindError;
    return false;
  }
  return true;
}

void Channel::log(const std::string &message) const {
  std::printf("[%s] %s\n", tag_, message.c_str());
  std::fflush(stdout);
}

void Channel::vlog(const std::string &message) const {
  if (verbose_) log(message);
}

void Channel::sendRaw(const uint8_t *data, size_t len, const char *label) {
  if (!havePeer_) return;
  udp_.sendTo(data, len, peer_);
  vlog(std::string("-> ") + label);
}

void Channel::sendTracked(std::vector<uint8_t> packet, const char *label) {
  IcomWire::putLE16(packet.data() + 6, sendSeq_);
  uint16_t seq = sendSeq_;
  txBuf_[seq] = packet;
  txOrder_.push_back(seq);
  // Evict oldest-by-insertion-order, not oldest-by-key: sendSeq_ wraps at
  // 65536, so "smallest key" is not "oldest sent" once a session has been up
  // long enough to wrap around. txOrder_ tracks actual send order instead.
  if (txOrder_.size() > kTxHistoryPackets) {
    txBuf_.erase(txOrder_.front());
    txOrder_.pop_front();
  }
  sendSeq_ = (uint16_t)(sendSeq_ + 1);
  sendRaw(packet.data(), packet.size(), label);
}

void Channel::requestRetransmit(uint16_t seq) {
  uint8_t buf[16];
  IcomWire::hdr16(buf, myId_, remoteId_, T_RETRANSMIT, seq);
  sendRaw(buf, sizeof(buf), "retransmit-request");
}

std::vector<uint8_t> Channel::longHeader(size_t size, uint32_t inner) {
  std::vector<uint8_t> p(size, 0);
  IcomWire::putLE32(p.data() + 0, (uint32_t)size);
  // Bytes 4-7 (type/seq) stay 0 here -- sendTracked() patches the seq half at
  // offset 6 right before sending, same as icom-lan-fake-radio.py's long_header().
  IcomWire::putLE32(p.data() + 8, myId_);
  IcomWire::putLE32(p.data() + 12, remoteId_);
  IcomWire::putBE32(p.data() + 0x10, inner);
  return p;
}

bool Channel::handleCommon(const uint8_t *data, size_t len) {
  if (len < 16) return true;
  uint16_t ptype = IcomWire::getLE16(data + 4);
  uint16_t seq = IcomWire::getLE16(data + 6);
  uint32_t sender = IcomWire::getLE32(data + 8);

  if (len == 0x10 && ptype == IcomWire::TYPE_ARE_YOU_THERE) {
    remoteId_ = sender;
    // AreYouThere is this protocol's own "hello, I'm (re)connecting" signal,
    // so it -- and only it -- is allowed to re-target peer_ to whoever just
    // sent it, even if a previous client's session is still latched from
    // here. Without this, wifilt itself reconnecting from a new ephemeral
    // port (network blip, restart) would leave local-trx permanently
    // answering a dead socket until manually restarted -- discovered while
    // testing multiple clients in sequence, but a real operational concern
    // for any long-running local-trx, not just the test harness.
    peer_ = lastFrom_;
    havePeer_ = true;
    uint8_t buf[16];
    IcomWire::hdr16(buf, myId_, remoteId_, IcomWire::TYPE_I_AM_HERE, 0x00);
    sendRaw(buf, 16, "i-am-here");
    log("<- AreYouThere -> I Am Here");
    return true;
  }
  if (len == 0x10 && ptype == T_READY) {
    uint8_t buf[16];
    IcomWire::hdr16(buf, myId_, remoteId_, T_READY, 0x01);
    sendRaw(buf, 16, "ready");
    if (!linked_) {
      linked_ = true;
      log("<- AreYouReady -> Ready");
    }
    return true;
  }
  if (len == 0x15 && ptype == T_PING) {
    uint8_t reply = data[0x10];
    uint32_t stamp = IcomWire::getLE32(data + 0x11);
    if (reply == 0x00) {
      uint8_t buf[0x15];
      IcomWire::putLE32(buf + 0, 0x15);
      IcomWire::putLE16(buf + 4, T_PING);
      IcomWire::putLE16(buf + 6, seq);
      IcomWire::putLE32(buf + 8, myId_);
      IcomWire::putLE32(buf + 12, remoteId_);
      buf[0x10] = 0x01;
      IcomWire::putLE32(buf + 0x11, stamp);
      sendRaw(buf, 0x15, "ping-reply");
    }
    return true;
  }
  if (len == 0x10 && ptype == T_IDLE) return true;
  if (len == 0x10 && ptype == T_RETRANSMIT) {
    auto it = txBuf_.find(seq);
    if (it != txBuf_.end()) sendRaw(it->second.data(), it->second.size(), "retransmit");
    return true;
  }
  if (len == 0x10 && ptype == T_DISCONNECT) {
    linked_ = false;
    log("<- Disconnect");
    return true;
  }
  return false;
}

void Channel::poll() {
  uint8_t buf[2048];
  for (;;) {
    int got = udp_.recv(buf, sizeof(buf), &lastFrom_);
    if (got <= 0) break;   // 0 = nothing pending, <0 = real socket error either way
    if (!havePeer_) {
      peer_ = lastFrom_;
      havePeer_ = true;
    }
    handle(buf, (size_t)got);
  }
}

// ---- ControlChannel ---------------------------------------------------------

ControlChannel::ControlChannel(std::string listenIp, bool verbose, std::string radioName,
                                uint8_t civAddr)
    : Channel(std::move(listenIp), CONTROL_PORT, "ctl", verbose),
      radioName_(std::move(radioName)),
      civAddr_(civAddr) {}

void ControlChannel::handle(const uint8_t *data, size_t len) {
  if (handleCommon(data, len)) return;

  if (len == 0x80) {
    onLogin(data, len);
  } else if (len == 0x40) {
    onToken(data, len);
  } else if (len == 0x90) {
    onStreamRequest();
  } else {
    vlog("<- unhandled control packet len=" + std::to_string(len));
  }
}

void ControlChannel::onLogin(const uint8_t *data, size_t len) {
  (void)len;
  tokRequest_ = IcomWire::getLE16(data + 0x1A);
  log("<- LOGIN");

  auto p = longHeader(0x60, 0x50);
  p[0x14] = 0x02;
  p[0x15] = 0x00;
  IcomWire::putLE16(p.data() + 0x1A, tokRequest_);
  IcomWire::putLE32(p.data() + 0x1C, token_);
  IcomWire::putLE32(p.data() + 0x30, 0x00000000);   // 0xFEFFFFFF would mean rejected
  static const char kName[] = "local-trx";
  std::memcpy(p.data() + 0x40, kName, sizeof(kName) - 1);
  sendTracked(p, "login-response");
  log("-> LOGIN OK");

  sendCapabilities();
  sendConninfo();
}

void ControlChannel::sendCapabilities() {
  // 0x42 fixed header + one 0x66-byte radio entry, mirrors icom-lan-fake-radio.py.
  const size_t size = 0x42 + 0x66;
  auto p = longHeader(size, size - 0x10);
  p[0x14] = 0x02;
  p[0x15] = 0x01;
  IcomWire::putLE16(p.data() + 0x1A, tokRequest_);
  IcomWire::putLE32(p.data() + 0x1C, token_);

  const size_t base = 0x42;
  IcomWire::putLE16(p.data() + base + 0x07, 0x8010);   // commoncap
  static const uint8_t kGuidTail[] = {0x02, 0x00, 0xDE, 0xAD, 0xBE, 0xEF};
  std::memcpy(p.data() + base + 0x0A, kGuidTail, sizeof(kGuidTail));
  // bod 3: synthetic radio name goes out here. Must not contain a 3-4 digit
  // run, see config.h's IdentityConfig comment -- findModel() would otherwise
  // stop returning null and turn on capabilities this radio does not have.
  std::string name = radioName_.substr(0, 0x20);
  std::memcpy(p.data() + base + 0x10, name.data(), name.size());
  p[base + 0x52] = civAddr_;
  sendTracked(p, "capabilities");
  log("-> CAPABILITIES name=" + radioName_);
}

void ControlChannel::sendConninfo() {
  auto p = longHeader(0x90, 0x80);
  p[0x14] = 0x02;
  p[0x15] = 0x02;
  IcomWire::putLE16(p.data() + 0x1A, tokRequest_);
  IcomWire::putLE32(p.data() + 0x1C, token_);
  std::string name = radioName_.substr(0, 0x20);
  std::memcpy(p.data() + 0x40, name.data(), name.size());
  IcomWire::putLE32(p.data() + 0x60, 0);   // busy = free
  sendTracked(p, "conninfo");
  log("-> CONNINFO (radio free)");
}

void ControlChannel::onToken(const uint8_t *data, size_t len) {
  (void)len;
  uint8_t magic = data[0x15];
  // Deviation 3 (docs/icom-lan-implementace.md): only the 0x05 auth gets a
  // reply -- that reply is what gates the client's stream request. 0x02 is
  // deliberately left unanswered.
  if (magic != 0x05) return;

  auto p = longHeader(0x40, 0x30);
  p[0x14] = 0x02;
  p[0x15] = 0x05;
  IcomWire::putLE16(p.data() + 0x1A, tokRequest_);
  IcomWire::putLE32(p.data() + 0x1C, token_);
  IcomWire::putLE32(p.data() + 0x30, 0x00000000);
  sendTracked(p, "auth-0x05-reply");
  log("-> AUTH 0x05 acknowledged");
}

void ControlChannel::onStreamRequest() {
  log("<- STREAM REQUEST");
  auto p = longHeader(0x50, 0x40);
  p[0x14] = 0x02;
  p[0x15] = 0x03;
  IcomWire::putLE16(p.data() + 0x1A, tokRequest_);
  IcomWire::putLE32(p.data() + 0x1C, token_);
  IcomWire::putLE32(p.data() + 0x30, 0x00000000);   // error = none
  IcomWire::putBE16(p.data() + 0x42, CIV_PORT);      // deviation 4: fixed ports
  IcomWire::putBE16(p.data() + 0x46, AUDIO_PORT);
  sendTracked(p, "stream-status");
  streaming_ = true;
  log("-> STATUS civport=" + std::to_string(CIV_PORT) + " audioport=" + std::to_string(AUDIO_PORT));
}

// ---- CivChannel --------------------------------------------------------------

CivChannel::CivChannel(std::string listenIp, bool verbose, uint8_t civAddr, RigBackend &rig,
                       KeyingBackend *keying)
    : Channel(std::move(listenIp), CIV_PORT, "civ", verbose),
      civAddr_(civAddr),
      rig_(rig),
      keying_(keying) {}

void CivChannel::sendCiv(const std::vector<uint8_t> &frame) {
  std::vector<uint8_t> p(0x15 + frame.size(), 0);
  IcomWire::putLE32(p.data() + 0, (uint32_t)p.size());
  IcomWire::putLE32(p.data() + 8, myId_);
  IcomWire::putLE32(p.data() + 12, remoteId_);
  p[0x10] = 0xC1;
  IcomWire::putLE16(p.data() + 0x11, (uint16_t)frame.size());
  IcomWire::putBE16(p.data() + 0x13, seqB_);
  seqB_ = (uint16_t)(seqB_ + 1);
  std::memcpy(p.data() + 0x15, frame.data(), frame.size());
  sendTracked(p, "CIV frame");
}

void CivChannel::handle(const uint8_t *data, size_t len) {
  if (handleCommon(data, len)) return;

  if (len == 0x16) {
    // Deviation 5: the client opens the stream with magic 0x05, not wfview's 0x04.
    uint8_t magic = data[0x15];
    if (magic == 0x05 && !opened_) {
      opened_ = true;
      log("<- civ-open (magic 0x05) -- CI-V stream up");
    } else if (magic == 0x00) {
      opened_ = false;
      log("<- civ-close");
    }
    return;
  }

  if (len > 0x15 && data[0x10] == 0xC1) {
    uint16_t length = IcomWire::getLE16(data + 0x11);
    if (0x15 + (size_t)length <= len) {
      onCivFrame(std::vector<uint8_t>(data + 0x15, data + 0x15 + length));
    }
    return;
  }

  vlog("<- unhandled CIV packet len=" + std::to_string(len));
}

void CivChannel::onCivFrame(const std::vector<uint8_t> &frame) {
  if (frame.size() < 6 || frame[0] != 0xFE || frame[1] != 0xFE) return;
  uint8_t to = frame[2];
  uint8_t sender = frame[3];
  if (to != civAddr_) return;

  // civ_router.h's convention: cmd byte + body, no FE FE/addr, no trailing FD.
  std::vector<uint8_t> cmdAndBody(frame.begin() + 4, frame.end() - 1);
  CivResult result = dispatchCiv(cmdAndBody, rig_, keying_);
  if (!result.answered) return;   // category (c): no reply, not a blanket ack

  std::vector<uint8_t> replyFrame;
  replyFrame.reserve(5 + result.payload.size());
  replyFrame.push_back(0xFE);
  replyFrame.push_back(0xFE);
  replyFrame.push_back(sender);
  replyFrame.push_back(civAddr_);
  replyFrame.insert(replyFrame.end(), result.payload.begin(), result.payload.end());
  replyFrame.push_back(0xFD);
  sendCiv(replyFrame);
}

namespace {
constexpr uint32_t kCivBroadcastPollMs = 300;   // bod 11(d)'s own suggested 200-500ms
constexpr uint8_t kCivBroadcastAddress = 0x00;  // BROADCAST_ADDRESS, wifilt.ino:221 --
                                                 // an unsolicited push has no specific
                                                 // sender to echo back to like a reply does
}  // namespace

void CivChannel::tick(uint32_t nowMs) {
  if (!opened_) return;   // no CI-V stream up yet -- nothing to push to
  if (nowMs < nextBroadcastPollMs_) return;
  nextBroadcastPollMs_ = nowMs + kCivBroadcastPollMs;

  const uint64_t freqHz = (uint64_t)rig_.getFreqHz();
  const uint8_t modeByte = rig_.getModeByte();

  if (!haveLastBroadcast_) {
    // First sample only establishes the baseline -- otherwise every run would
    // open with a phantom "change" broadcast against whatever the rig
    // happened to power up at.
    lastBroadcastFreqHz_ = freqHz;
    lastBroadcastModeByte_ = modeByte;
    haveLastBroadcast_ = true;
    return;
  }

  if (freqHz != lastBroadcastFreqHz_) {
    lastBroadcastFreqHz_ = freqHz;
    std::vector<uint8_t> f = {0xFE, 0xFE, kCivBroadcastAddress, civAddr_, 0x00};   // CMD_TRANS_FREQ
    uint8_t bcd[5];
    bcdFromHz(freqHz, bcd);
    f.insert(f.end(), bcd, bcd + 5);
    f.push_back(0xFD);
    sendCiv(f);
    vlog("-> transceive broadcast freq (bod 11d)");
  }

  if (modeByte != lastBroadcastModeByte_) {
    lastBroadcastModeByte_ = modeByte;
    std::vector<uint8_t> m = {0xFE, 0xFE, kCivBroadcastAddress, civAddr_,
                               0x01,          // CMD_TRANS_MODE
                               modeByte, 0x01};  // filter width -- same "not modelled yet,
                                                  // wide/default" placeholder as the 0x04 read reply
    m.push_back(0xFD);
    sendCiv(m);
    vlog("-> transceive broadcast mode (bod 11d)");
  }
}

// ---- AudioChannel ------------------------------------------------------------

namespace {
constexpr uint32_t kAudioPacketMs = 20;      // wire format's fixed cadence, 8kHz/160B
constexpr size_t kAudioSamplesPerPacket = 160;
constexpr uint16_t kMaxGapChase = 32;   // icom_lan_audio_tx.h's own HISTORY_PACKETS bound --
                                        // chasing further than the peer's own replay history
                                        // holds would just draw more unanswered requests
}  // namespace

AudioChannel::AudioChannel(std::string listenIp, bool verbose, AudioCapture *capture,
                           AudioPlayback *playback)
    : Channel(std::move(listenIp), AUDIO_PORT, "aud", verbose),
      capture_(capture),
      playback_(playback) {}

void AudioChannel::handle(const uint8_t *data, size_t len) {
  if (handleCommon(data, len)) return;
  if (len < 0x18) {
    vlog("<- unhandled audio packet len=" + std::to_string(len));
    return;
  }
  onTxAudio(data, len);
}

void AudioChannel::onTxAudio(const uint8_t *data, size_t len) {
  uint16_t outerSeq = IcomWire::getLE16(data + 0x06);
  uint16_t innerSeq = IcomWire::getBE16(data + 0x12);
  uint16_t paylen = IcomWire::getLE16(data + 0x14);
  if ((size_t)0x18 + paylen > len) {
    vlog("<- malformed audio packet, paylen=" + std::to_string(paylen) + " len=" + std::to_string(len));
    return;
  }

  if (haveLastRx_) {
    int16_t delta = (int16_t)(innerSeq - lastInnerSeqRx_);
    if (delta > 1) {
      uint16_t missing = (uint16_t)(delta - 1);
      uint16_t chase = missing < kMaxGapChase ? missing : kMaxGapChase;
      for (uint16_t i = 0; i < chase; i++) {
        requestRetransmit((uint16_t)(lastOuterSeqRx_ + 1 + i));
      }
      vlog("<- audio gap of " + std::to_string(missing) + " packet(s), requested retransmit");
      lastOuterSeqRx_ = outerSeq;
      lastInnerSeqRx_ = innerSeq;
    } else if (delta == 1) {
      lastOuterSeqRx_ = outerSeq;
      lastInnerSeqRx_ = innerSeq;
    } else {
      // delta <= 0: a duplicate or a late retransmit reply arriving after we
      // already moved on -- still worth decoding/playing, but must not move
      // the gap-tracking state backward.
      vlog("<- late/duplicate audio packet (delta=" + std::to_string(delta) + ")");
    }
  } else {
    lastOuterSeqRx_ = outerSeq;
    lastInnerSeqRx_ = innerSeq;
    haveLastRx_ = true;
  }

  if (playback_ && paylen > 0) {
    // kAudioSamplesPerPacket (160) is the wire format's own fixed packet
    // size (20ms/8kHz) -- not IcomLanAudioTx::MAX_PAYLOAD, deliberately (see
    // this file's AudioChannel header comment on why that class stays unused
    // here), even though the two happen to share the same number.
    int16_t pcm[kAudioSamplesPerPacket];
    size_t n = paylen < kAudioSamplesPerPacket ? paylen : kAudioSamplesPerPacket;
    for (size_t i = 0; i < n; i++) pcm[i] = ulawDecode(data[0x18 + i]);
    playback_->push(pcm, n);
  }
}

void AudioChannel::tick(uint32_t nowMs) {
  if (!capture_ || !linked_) return;
  if (!sending_) {
    nextSendMs_ = nowMs;
    sending_ = true;
  }
  if ((int32_t)(nowMs - nextSendMs_) < 0) return;
  if (capture_->available() < kAudioSamplesPerPacket) return;   // wait for a full 20ms chunk

  uint8_t payload[kAudioSamplesPerPacket];
  size_t got = capture_->pull(payload, sizeof(payload));
  nextSendMs_ += kAudioPacketMs;

  // Byte layout ported from tools/icom-lan-fake-radio.py's AudioChannel.tick()
  // -- the proven server-side RX format, NOT icom_lan_audio_tx.h's client-TX
  // one (different direction, different flag conventions at 0x10 -- see
  // audio_bridge.h's header comment).
  // packetBuf_ is a member, reused every call -- resize() is a no-op once it
  // has already grown to this size (got is always kAudioSamplesPerPacket by
  // the time we get here, see the guard above), so this stops being a heap
  // allocation after the first packet of a session.
  packetBuf_.assign(0x18 + got, 0);
  std::vector<uint8_t> &packet = packetBuf_;
  IcomWire::putLE32(packet.data() + 0x00, (uint32_t)packet.size());
  // 0x04-0x06 stays 0 (packet "type" -- 0x01 would mean retransmit request)
  IcomWire::putLE16(packet.data() + 0x06, audioOutSeq_++);
  IcomWire::putLE32(packet.data() + 0x08, myId_);
  IcomWire::putLE32(packet.data() + 0x0C, remoteId_);
  // 0x10-0x12 stays 0 (client-TX-only field, unused for server RX)
  IcomWire::putBE16(packet.data() + 0x12, audioSequence_++);
  IcomWire::putLE16(packet.data() + 0x14, (uint16_t)got);
  // 0x16-0x18 stays 0 (reserved)
  std::copy(payload, payload + got, packet.begin() + 0x18);
  sendRaw(packet.data(), packet.size(), "audio");
}

// ---- IcomLanServer -------------------------------------------------------

IcomLanServer::IcomLanServer(std::string listenIp, std::string radioName, uint8_t civAddr,
                             RigBackend &rig, KeyingBackend *keying, AudioCapture *capture,
                             AudioPlayback *playback, bool verbose)
    : control_(listenIp, verbose, std::move(radioName), civAddr),
      civ_(listenIp, verbose, civAddr, rig, keying),
      audio_(std::move(listenIp), verbose, capture, playback) {}

bool IcomLanServer::begin(std::string *error) {
  if (!control_.begin(error)) return false;
  if (!civ_.begin(error)) return false;
  if (!audio_.begin(error)) return false;
  return true;
}

void IcomLanServer::poll() {
  control_.poll();
  civ_.poll();
  audio_.poll();
  civ_.tick(millis());
  audio_.tick(millis());
}

}  // namespace LocalTrx
