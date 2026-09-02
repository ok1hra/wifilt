// The actual miniaudio implementation (MINIAUDIO_IMPLEMENTATION) lives in its
// own translation unit, third_party/miniaudio/miniaudio_impl.c -- this file
// only uses miniaudio's public API, declarations only.
#include "audio_bridge.h"

namespace LocalTrx {

uint8_t ulawEncode(int16_t sample) {
  const int kBias = 0x84, kClip = 32635;
  int sign = sample < 0 ? 0x80 : 0x00;
  int s = sample < 0 ? -(int)sample : (int)sample;
  if (s > kClip) s = kClip;
  s += kBias;

  int exponent = 7;
  int mask = 0x4000;
  while (exponent > 0 && !(s & mask)) {
    exponent--;
    mask >>= 1;
  }
  int mantissa = (s >> (exponent + 3)) & 0x0F;
  return (uint8_t)(~(sign | (exponent << 4) | mantissa) & 0xFF);
}

AudioCapture::AudioCapture(std::string deviceName) : deviceName_(std::move(deviceName)) {
  ring_.resize(32000);   // 4s at 8kHz mono uLaw (1 byte/sample)
}

AudioCapture::~AudioCapture() {
  if (deviceInitialized_) ma_device_uninit(&device_);
  if (contextInitialized_) ma_context_uninit(&context_);
}

void AudioCapture::dataCallback(ma_device *device, void *, const void *input, ma_uint32 frameCount) {
  auto *self = static_cast<AudioCapture *>(device->pUserData);
  self->onCaptured(static_cast<const int16_t *>(input), frameCount);
}

void AudioCapture::onCaptured(const int16_t *samples, ma_uint32 frameCount) {
  if (!samples) return;
  std::lock_guard<std::mutex> lock(mutex_);
  for (ma_uint32 i = 0; i < frameCount; i++) {
    uint8_t encoded = ulawEncode(samples[i]);
    size_t tail = (head_ + count_) % ring_.size();
    ring_[tail] = encoded;
    if (count_ < ring_.size()) {
      count_++;
    } else {
      // Ring full: drop the oldest byte rather than block or grow -- live
      // audio favours fresh samples over ones the consumer never caught up to.
      head_ = (head_ + 1) % ring_.size();
    }
  }
}

bool AudioCapture::start(std::string *error) {
  if (ma_context_init(nullptr, 0, nullptr, &context_) != MA_SUCCESS) {
    if (error) *error = "miniaudio: ma_context_init failed";
    return false;
  }
  contextInitialized_ = true;

  const ma_device_id *deviceId = nullptr;
  if (!deviceName_.empty()) {
    ma_device_info *captureInfos = nullptr;
    ma_uint32 captureCount = 0;
    if (ma_context_get_devices(&context_, nullptr, nullptr, &captureInfos, &captureCount) !=
        MA_SUCCESS) {
      if (error) *error = "miniaudio: cannot enumerate capture devices";
      return false;
    }
    bool found = false;
    for (ma_uint32 i = 0; i < captureCount; i++) {
      if (deviceName_ == captureInfos[i].name) {
        deviceId = &captureInfos[i].id;
        found = true;
        break;
      }
    }
    if (!found) {
      if (error) *error = "miniaudio: capture device not found: \"" + deviceName_ + "\"";
      return false;
    }
  }

  ma_device_config config = ma_device_config_init(ma_device_type_capture);
  config.capture.pDeviceID = deviceId;   // nullptr = system default
  config.capture.format = ma_format_s16;
  config.capture.channels = 1;
  config.sampleRate = 8000;   // wire format is fixed 8kHz mono -- miniaudio's own
                               // resampler/channel-mixer handles the real device's
                               // native format transparently
  config.dataCallback = &AudioCapture::dataCallback;
  config.pUserData = this;

  if (ma_device_init(&context_, &config, &device_) != MA_SUCCESS) {
    if (error) *error = "miniaudio: cannot open capture device \"" + deviceName_ + "\"";
    return false;
  }
  deviceInitialized_ = true;

  if (ma_device_start(&device_) != MA_SUCCESS) {
    if (error) *error = "miniaudio: cannot start capture device \"" + deviceName_ + "\"";
    return false;
  }
  return true;
}

size_t AudioCapture::available() {
  std::lock_guard<std::mutex> lock(mutex_);
  return count_;
}

size_t AudioCapture::pull(uint8_t *out, size_t max) {
  std::lock_guard<std::mutex> lock(mutex_);
  size_t take = count_ < max ? count_ : max;
  for (size_t i = 0; i < take; i++) {
    out[i] = ring_[(head_ + i) % ring_.size()];
  }
  head_ = (head_ + take) % ring_.size();
  count_ -= take;
  return take;
}

int16_t ulawDecode(uint8_t encoded) {
  uint8_t u = (uint8_t)~encoded;
  int sign = u & 0x80;
  int exponent = (u >> 4) & 0x07;
  int mantissa = u & 0x0F;
  int sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return (int16_t)(sign ? -sample : sample);
}

// ---- AudioPlayback ----------------------------------------------------------

AudioPlayback::AudioPlayback(std::string deviceName) : deviceName_(std::move(deviceName)) {
  ring_.resize(16000);   // 2s at 8kHz mono s16 (1 sample/slot)
}

AudioPlayback::~AudioPlayback() {
  if (deviceInitialized_) ma_device_uninit(&device_);
  if (contextInitialized_) ma_context_uninit(&context_);
}

void AudioPlayback::dataCallback(ma_device *device, void *output, const void *, ma_uint32 frameCount) {
  auto *self = static_cast<AudioPlayback *>(device->pUserData);
  self->onPlayback(static_cast<int16_t *>(output), frameCount);
}

void AudioPlayback::onPlayback(int16_t *output, ma_uint32 frameCount) {
  std::lock_guard<std::mutex> lock(mutex_);
  ma_uint32 take = (ma_uint32)(count_ < frameCount ? count_ : frameCount);
  for (ma_uint32 i = 0; i < take; i++) {
    output[i] = ring_[(head_ + i) % ring_.size()];
  }
  // Anything beyond what the ring had left plays as silence -- miniaudio
  // pre-silences the output buffer by default (ma_device_config's
  // noPreSilencedOutputBuffer, left false here), so there is nothing to fill
  // in for the remainder.
  head_ = (head_ + take) % ring_.size();
  count_ -= take;
}

bool AudioPlayback::start(std::string *error) {
  if (ma_context_init(nullptr, 0, nullptr, &context_) != MA_SUCCESS) {
    if (error) *error = "miniaudio: ma_context_init failed";
    return false;
  }
  contextInitialized_ = true;

  const ma_device_id *deviceId = nullptr;
  if (!deviceName_.empty()) {
    ma_device_info *playbackInfos = nullptr;
    ma_uint32 playbackCount = 0;
    if (ma_context_get_devices(&context_, &playbackInfos, &playbackCount, nullptr, nullptr) !=
        MA_SUCCESS) {
      if (error) *error = "miniaudio: cannot enumerate playback devices";
      return false;
    }
    bool found = false;
    for (ma_uint32 i = 0; i < playbackCount; i++) {
      if (deviceName_ == playbackInfos[i].name) {
        deviceId = &playbackInfos[i].id;
        found = true;
        break;
      }
    }
    if (!found) {
      if (error) *error = "miniaudio: playback device not found: \"" + deviceName_ + "\"";
      return false;
    }
  }

  ma_device_config config = ma_device_config_init(ma_device_type_playback);
  config.playback.pDeviceID = deviceId;
  config.playback.format = ma_format_s16;
  config.playback.channels = 1;
  config.sampleRate = 8000;
  config.dataCallback = &AudioPlayback::dataCallback;
  config.pUserData = this;

  if (ma_device_init(&context_, &config, &device_) != MA_SUCCESS) {
    if (error) *error = "miniaudio: cannot open playback device \"" + deviceName_ + "\"";
    return false;
  }
  deviceInitialized_ = true;

  if (ma_device_start(&device_) != MA_SUCCESS) {
    if (error) *error = "miniaudio: cannot start playback device \"" + deviceName_ + "\"";
    return false;
  }
  return true;
}

void AudioPlayback::push(const int16_t *samples, size_t count) {
  std::lock_guard<std::mutex> lock(mutex_);
  for (size_t i = 0; i < count; i++) {
    size_t tail = (head_ + count_) % ring_.size();
    ring_[tail] = samples[i];
    if (count_ < ring_.size()) {
      count_++;
    } else {
      head_ = (head_ + 1) % ring_.size();   // drop oldest -- see header comment
    }
  }
}

}  // namespace LocalTrx
