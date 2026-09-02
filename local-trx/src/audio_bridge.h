// audio_bridge.h -- miniaudio capture -> 8 kHz mono µ-law ring buffer (bod 2,
// fáze 2: RX direction only, no PTT interaction).
//
// Deliberately NOT built on icom_lan_audio_tx.h's IcomLanAudioTx: that class
// paces out a single pre-encoded, KNOWN-LENGTH digital-mode TX burst
// (WSPR/JS8's own audio, wifilt->radio direction, prepareAudioTx()/
// startAudioTx(totalBytes,...) at icomLanClient.h:259-289) with a mandatory
// 150ms PLAYOUT_TAIL_MS drain between bursts -- repurposing it for a live,
// indefinite-length capture stream (radio->wifilt direction, what THIS class
// does) would click/gap every time it re-armed. A real radio's own RX audio
// has no such bookkeeping either (confirmed reading tools/
// icom-lan-fake-radio.py's AudioChannel.tick(): steady cadence, incrementing
// sequence, no arm/total at all) -- so this class matches what a real radio
// actually does, not a re-purposed WSPR/JS8 TX mechanism.
#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include <miniaudio.h>

namespace LocalTrx {

// G.711 µ-law encoder, ported byte-for-byte from tools/icom-lan-fake-radio.py's
// ulaw_encode() -- the wire format IC-705-class radios actually stream.
uint8_t ulawEncode(int16_t sample);

// The standard G.711 µ-law decompand (inverse of ulawEncode, lossy the way
// any µ-law codec is -- coarser quantization steps near full scale) --
// needed for fáze 3's TX direction (wifilt->local-trx audio), not portable
// from tools/icom-lan-fake-radio.py, which only ever encodes (it is the RX side).
int16_t ulawDecode(uint8_t encoded);

class AudioCapture {
 public:
  // deviceName empty -> system default capture device.
  explicit AudioCapture(std::string deviceName);
  ~AudioCapture();

  // ma_context_init() + device lookup by name (if any) + ma_device_init() at
  // a fixed 8 kHz mono s16 capture format -- miniaudio's own resampler/channel
  // conversion handles whatever the real hardware's native format is.
  bool start(std::string *error);

  // Pulls up to `max` already-encoded µ-law bytes into `out`, oldest first.
  // Never blocks; returns the number actually available (may be less than
  // `max`, or 0). Safe to call from a different thread than the miniaudio
  // callback -- that is the whole reason this exists (a mutex-guarded ring).
  size_t pull(uint8_t *out, size_t max);

  // How many encoded bytes are ready right now -- lets a caller wait for a
  // full 20ms/160-byte packet's worth instead of draining a partial one.
  size_t available();

 private:
  static void dataCallback(ma_device *device, void *output, const void *input,
                            ma_uint32 frameCount);
  void onCaptured(const int16_t *samples, ma_uint32 frameCount);

  std::string deviceName_;
  ma_context context_{};
  ma_device device_{};
  bool contextInitialized_ = false;
  bool deviceInitialized_ = false;

  std::mutex mutex_;
  std::vector<uint8_t> ring_;
  size_t head_ = 0, count_ = 0;   // tail = (head + count) % ring_.size()
};

// Mirror of AudioCapture for fáze 3's TX direction (wifilt->local-trx audio,
// AudioChannel::handle() decodes incoming µ-law and push()es PCM16 here;
// miniaudio's playback callback pulls from the same ring). Silence (not a
// stall) is what plays when the ring runs dry -- a live network stream can
// legitimately have gaps, and stalling the audio device is worse than a
// half-second of silence.
class AudioPlayback {
 public:
  explicit AudioPlayback(std::string deviceName);
  ~AudioPlayback();

  bool start(std::string *error);

  // Pushes already-decoded PCM16 mono 8kHz samples. Never blocks; on
  // overflow the OLDEST buffered samples are dropped to make room -- favours
  // low latency (fresh audio) over completeness, same policy as
  // AudioCapture's ring on the other side.
  void push(const int16_t *samples, size_t count);

 private:
  static void dataCallback(ma_device *device, void *output, const void *input,
                            ma_uint32 frameCount);
  void onPlayback(int16_t *output, ma_uint32 frameCount);

  std::string deviceName_;
  ma_context context_{};
  ma_device device_{};
  bool contextInitialized_ = false;
  bool deviceInitialized_ = false;

  std::mutex mutex_;
  std::vector<int16_t> ring_;
  size_t head_ = 0, count_ = 0;
};

}  // namespace LocalTrx
