#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <new>

#include "icom_lan_tx_history.h"

// Deep TX-audio module shared by WSPR and JS8.
//
// The application enqueues already converted uLaw bytes at the link rate (8 kHz,
// or 16 kHz with the XARA FM Wide link -- setPacketBytes) and arms one
// transmission. A dedicated socket owner calls poll() from its real-time task,
// sends the returned byte image, and reports the local UDP result through
// commitSend(). Packet pacing, both ICOM sequence spaces, bounded replay,
// underrun/deadline faults and the radio playout tail stay behind this interface.
//
// The class itself deliberately contains no Arduino, socket, task or clock code.
// That gives the production BSD/lwIP socket task and the native fault-injection
// harness two adapters at the same seam.
class IcomLanAudioTx {
 public:
  // 1.536 s of queue at the link rate (setPacketBytes): 12288 B at 8 kHz,
  // 24576 B at 16. Pages ask for up to a second of prebuffer (Mercury's
  // calibration), which has to fit at either rate. Heap, so an 8 kHz link
  // never pays for the 16 kHz one.
  static const size_t QUEUE_MS = 1536;
  static const size_t MAX_PAYLOAD = 320;       // one 20 ms radio packet at 16 kHz
  static const size_t HEADER_SIZE = 0x18;
  static const size_t MAX_PACKET = HEADER_SIZE + MAX_PAYLOAD;
  static const uint32_t PACKET_MS = 20;
  static const uint32_t MAX_LATENESS_MS = 80;
  static const uint32_t PLAYOUT_TAIL_MS = 150;
  static const size_t HISTORY_PACKETS = 32;    // 640 ms at continuous TX

  enum PollResult : uint8_t {
    WAITING,
    PACKET,
    DRAINING,
    DRAINED,
    FAULTED
  };

  enum Fault : uint8_t {
    FAULT_NONE,
    FAULT_NOT_READY,
    FAULT_OVERFLOW,
    FAULT_UNDERRUN,
    FAULT_DEADLINE,
    FAULT_SEND,
    FAULT_LINK
  };

  struct Snapshot {
    size_t queued;
    size_t capacity;
    uint64_t consumed;
    uint64_t total;
    uint32_t sentPackets;
    uint32_t maxLatenessMs;
    uint32_t replayRequests;
    uint32_t replayedPackets;
    uint32_t replayMisses;
    uint32_t sendFailures;
    Fault fault;
    bool armed;
    bool draining;
    bool drained;
  };

  IcomLanAudioTx() { setPacketBytes(160); reset(); }
  ~IcomLanAudioTx() { delete[] queue_; }
  IcomLanAudioTx(const IcomLanAudioTx&) = delete;
  IcomLanAudioTx& operator=(const IcomLanAudioTx&) = delete;

  // Reset the complete ICOM audio-channel epoch, including both sequence
  // counters and replay history. Use clearTx() between browser transmissions.
  void reset() {
    myId_ = remoteId_ = 0;
    trackedSequence_ = 1;
    audioSequence_ = 0;
    history_.clear();
    replayRequests_ = replayedPackets_ = replayMisses_ = sendFailures_ = 0;
    clearTx();
  }

  // Bytes per 20 ms packet: 160 at 8 kHz uLaw, 320 at 16 kHz; the queue is
  // resized to match. Only between transmissions (it clears the queue).
  // False when the queue could not be allocated -- every enqueue then fails.
  bool setPacketBytes(size_t bytes) {
    bytes = bytes == 0 || bytes > MAX_PAYLOAD ? 160 : bytes;
    size_t capacity = bytes * QUEUE_MS / PACKET_MS;
    packetBytes_ = bytes;
    if (queue_ && capacity == capacity_) { clearTx(); return true; }
    delete[] queue_;
    queue_ = new (std::nothrow) uint8_t[capacity];
    capacity_ = queue_ ? capacity : 0;
    clearTx();
    return queue_ != nullptr;
  }
  size_t packetBytes() const { return packetBytes_; }

  void configure(uint32_t myId, uint32_t remoteId) {
    myId_ = myId;
    remoteId_ = remoteId;
  }

  void clearTx() {
    read_ = write_ = queued_ = 0;
    consumed_ = total_ = 0;
    sentPackets_ = 0;
    nextDueMs_ = drainUntilMs_ = 0;
    maxLatenessMs_ = 0;
    fault_ = FAULT_NONE;
    armed_ = packetPending_ = draining_ = drained_ = false;
    pendingLength_ = pendingPayloadLength_ = 0;
  }

  void fail(Fault fault) {
    if (fault_ == FAULT_NONE) fault_ = fault;
    armed_ = false;
    packetPending_ = false;
  }

  bool enqueue(const uint8_t* data, size_t length) {
    if ((!data && length) || fault_ != FAULT_NONE) return false;
    if (!queue_ || length > capacity_ - queued_) {
      fail(FAULT_OVERFLOW);
      return false;
    }
    if (armed_ && consumed_ + queued_ + length > total_) {
      fail(FAULT_OVERFLOW);
      return false;
    }
    size_t first = capacity_ - write_;
    if (first > length) first = length;
    if (first) memcpy(queue_ + write_, data, first);
    if (length > first) memcpy(queue_, data + first, length - first);
    write_ = (write_ + length) % capacity_;
    queued_ += length;
    return true;
  }

  bool arm(uint64_t totalBytes, uint32_t startMs) {
    if (fault_ != FAULT_NONE || armed_ || packetPending_ || totalBytes == 0 ||
        consumed_ != 0 || totalBytes < queued_) {
      fail(FAULT_NOT_READY);
      return false;
    }
    total_ = totalBytes;
    nextDueMs_ = startMs;
    drainUntilMs_ = 0;
    armed_ = true;
    draining_ = drained_ = false;
    return true;
  }

  // JTTY live entry (AUD1 tx.extend, docs/jtty-implementace.md §6): the
  // transmission grows while it plays. Only before the drain tail starts --
  // once remaining reached zero the end has been announced and stands.
  bool extend(uint64_t moreBytes) {
    if (fault_ != FAULT_NONE || !armed_ || draining_ || drained_ || moreBytes == 0) return false;
    total_ += moreBytes;
    return true;
  }

  PollResult poll(uint32_t now, const uint8_t*& packet, size_t& length) {
    packet = nullptr;
    length = 0;
    if (fault_ != FAULT_NONE) return FAULTED;
    if (drained_) return DRAINED;
    if (draining_) {
      if ((int32_t)(now - drainUntilMs_) >= 0) {
        draining_ = false;
        drained_ = true;
        return DRAINED;
      }
      return DRAINING;
    }
    if (packetPending_) {
      uint32_t lateness = now - nextDueMs_;
      if (lateness > maxLatenessMs_) maxLatenessMs_ = lateness;
      if (lateness > MAX_LATENESS_MS) {
        fail(FAULT_DEADLINE);
        return FAULTED;
      }
      packet = pendingPacket_;
      length = pendingLength_;
      return PACKET;
    }
    if (!armed_) return WAITING;
    if ((int32_t)(now - nextDueMs_) < 0) return WAITING;

    uint32_t lateness = now - nextDueMs_;
    if (lateness > maxLatenessMs_) maxLatenessMs_ = lateness;
    if (lateness > MAX_LATENESS_MS) {
      fail(FAULT_DEADLINE);
      return FAULTED;
    }

    uint64_t remaining = total_ - consumed_;
    size_t wanted = remaining < packetBytes_ ? size_t(remaining) : packetBytes_;
    if (wanted == 0) {
      draining_ = true;
      drainUntilMs_ = now + PLAYOUT_TAIL_MS;
      return DRAINING;
    }
    if (queued_ < wanted) {
      fail(FAULT_UNDERRUN);
      return FAULTED;
    }

    memset(pendingPacket_, 0, HEADER_SIZE);
    pendingLength_ = HEADER_SIZE + wanted;
    pendingPayloadLength_ = wanted;
    putLE32(pendingPacket_ + 0x00, uint32_t(pendingLength_));
    pendingTrackedSequence_ = nextTrackedSequence();
    putLE16(pendingPacket_ + 0x06, pendingTrackedSequence_);
    putLE32(pendingPacket_ + 0x08, myId_);
    putLE32(pendingPacket_ + 0x0C, remoteId_);
    putLE16(pendingPacket_ + 0x10, wanted == 0xA0 ? 0x9781 : 0x0080);
    putBE16(pendingPacket_ + 0x12, audioSequence_++);
    putBE16(pendingPacket_ + 0x16, uint16_t(wanted));
    copyQueue(pendingPacket_ + HEADER_SIZE, wanted);
    packetPending_ = true;
    packet = pendingPacket_;
    length = pendingLength_;
    return PACKET;
  }

  void commitSend(bool success, uint32_t now) {
    if (!packetPending_ || fault_ != FAULT_NONE) return;
    if (!success) {
      sendFailures_++;
      fail(FAULT_SEND);
      return;
    }
    rememberTracked(pendingTrackedSequence_, pendingPacket_, pendingLength_);
    consumeQueue(pendingPayloadLength_);
    consumed_ += pendingPayloadLength_;
    sentPackets_++;
    packetPending_ = false;
    pendingLength_ = pendingPayloadLength_ = 0;
    nextDueMs_ += PACKET_MS;
    if (consumed_ >= total_) {
      armed_ = false;
      draining_ = true;
      drainUntilMs_ = now + PLAYOUT_TAIL_MS;
    }
  }

  uint16_t nextTrackedSequence() { return trackedSequence_++; }

  bool rememberTracked(uint16_t sequence, const uint8_t* packet, size_t length) {
    return history_.remember(sequence, packet, length);
  }

  const uint8_t* replay(uint16_t sequence, size_t& length) {
    replayRequests_++;
    const uint8_t* packet = history_.find(sequence, length);
    if (!packet) replayMisses_++;
    return packet;
  }

  void noteReplaySent(bool success) {
    if (success) replayedPackets_++;
    else {
      sendFailures_++;
      if (armed_ || draining_) fail(FAULT_SEND);
    }
  }

  size_t queued() const { return queued_; }
  size_t capacity() const { return capacity_; }
  bool active() const { return armed_ || packetPending_ || draining_; }

  Snapshot snapshot() const {
    Snapshot result;
    result.queued = queued_;
    result.capacity = capacity_;
    result.consumed = consumed_;
    result.total = total_;
    result.sentPackets = sentPackets_;
    result.maxLatenessMs = maxLatenessMs_;
    result.replayRequests = replayRequests_;
    result.replayedPackets = replayedPackets_;
    result.replayMisses = replayMisses_;
    result.sendFailures = sendFailures_;
    result.fault = fault_;
    result.armed = armed_ || packetPending_;
    result.draining = draining_;
    result.drained = drained_;
    return result;
  }

 private:
  static void putLE16(uint8_t* p, uint16_t v) {
    p[0] = uint8_t(v);
    p[1] = uint8_t(v >> 8);
  }
  static void putLE32(uint8_t* p, uint32_t v) {
    p[0] = uint8_t(v);
    p[1] = uint8_t(v >> 8);
    p[2] = uint8_t(v >> 16);
    p[3] = uint8_t(v >> 24);
  }
  static void putBE16(uint8_t* p, uint16_t v) {
    p[0] = uint8_t(v >> 8);
    p[1] = uint8_t(v);
  }

  void copyQueue(uint8_t* destination, size_t length) const {
    size_t first = capacity_ - read_;
    if (first > length) first = length;
    if (first) memcpy(destination, queue_ + read_, first);
    if (length > first) memcpy(destination + first, queue_, length - first);
  }

  void consumeQueue(size_t length) {
    read_ = (read_ + length) % capacity_;
    queued_ -= length;
  }

  uint8_t* queue_ = nullptr;
  size_t capacity_ = 0;
  size_t packetBytes_ = 160;
  size_t read_ = 0, write_ = 0, queued_ = 0;
  uint64_t consumed_ = 0, total_ = 0;
  uint32_t myId_ = 0, remoteId_ = 0;
  uint16_t trackedSequence_ = 1, audioSequence_ = 0;
  uint32_t nextDueMs_ = 0, drainUntilMs_ = 0;
  uint32_t sentPackets_ = 0, maxLatenessMs_ = 0;
  uint32_t replayRequests_ = 0, replayedPackets_ = 0, replayMisses_ = 0;
  uint32_t sendFailures_ = 0;
  Fault fault_ = FAULT_NONE;
  bool armed_ = false, packetPending_ = false, draining_ = false, drained_ = false;
  uint8_t pendingPacket_[MAX_PACKET];
  size_t pendingLength_ = 0, pendingPayloadLength_ = 0;
  uint16_t pendingTrackedSequence_ = 0;
  IcomLanTxHistory<MAX_PACKET, HISTORY_PACKETS> history_;
};
