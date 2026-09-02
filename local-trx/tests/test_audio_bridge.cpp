// doctest coverage for audio_bridge.h.
#include "doctest.h"

#include <chrono>
#include <cstdlib>
#include <thread>

#include "../src/audio_bridge.h"

using namespace LocalTrx;

TEST_CASE("ulawEncode matches tools/icom-lan-fake-radio.py's ulaw_encode reference values") {
  // Ported constants, not re-derived: silence and full-scale are the two
  // values worth pinning byte-exact against the Python reference (G.711
  // µ-law, BIAS=0x84/CLIP=32635).
  CHECK(ulawEncode(0) == 0xFF);       // silence
  CHECK(ulawEncode(32767) == 0x80);   // positive full scale (clipped toward CLIP)
  CHECK(ulawEncode(-32768) == 0x00);  // negative full scale
}

TEST_CASE("ulawEncode is antisymmetric (sign bit only) for a given magnitude") {
  // The two encodings should differ only in the sign bit (0x80) -- same
  // magnitude, opposite sign.
  uint8_t pos = ulawEncode(12000);
  uint8_t neg = ulawEncode(-12000);
  CHECK((pos ^ neg) == 0x80);
}

TEST_CASE("AudioCapture opens the default capture device and actually captures bytes") {
  AudioCapture capture("");   // "" = system default, see main.cpp's own gating comment
  std::string error;
  if (!capture.start(&error)) {
    MESSAGE("no default capture device in this environment (" << error << ") -- skipping");
    return;
  }

  // Give the callback thread real wall-clock time to run at least a couple
  // of 8kHz buffers -- this is genuinely exercising miniaudio's ALSA/
  // PulseAudio backend against whatever hardware this machine has, not a
  // mock. Silence still counts: µ-law-encodes to a real (non-empty) byte
  // stream regardless of content.
  size_t got = 0;
  for (int i = 0; i < 20 && got == 0; i++) {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    got = capture.available();
  }
  CHECK(got > 0);

  uint8_t buf[4096];
  size_t pulled = capture.pull(buf, sizeof(buf));
  CHECK(pulled > 0);
  CHECK(pulled <= got);
}

TEST_CASE("AudioCapture reports an error for an unknown device name, does not crash") {
  AudioCapture capture("this device does not exist -- 42");
  std::string error;
  CHECK_FALSE(capture.start(&error));
  CHECK_FALSE(error.empty());
  // available()/pull() on a never-started capture must be safe no-ops.
  CHECK(capture.available() == 0);
  uint8_t buf[16];
  CHECK(capture.pull(buf, sizeof(buf)) == 0);
}

TEST_CASE("ulawDecode(ulawEncode(x)) round-trips silence exactly and near-silence closely") {
  // µ-law is lossy by construction -- exact only at 0, coarser quantization
  // steps elsewhere. 100 is well inside the finest (smallest exponent) step,
  // where the round-trip error is at most a few counts.
  CHECK(ulawDecode(ulawEncode(0)) == 0);
  CHECK(std::abs(ulawDecode(ulawEncode(100)) - 100) <= 4);
  CHECK(std::abs(ulawDecode(ulawEncode(-100)) - (-100)) <= 4);
}

TEST_CASE("ulawDecode is antisymmetric for a given magnitude, like ulawEncode") {
  uint8_t enc = ulawEncode(12000);
  int16_t pos = ulawDecode(enc);
  int16_t neg = ulawDecode((uint8_t)(enc ^ 0x80));
  CHECK(pos == -neg);
}

TEST_CASE("AudioPlayback opens the default playback device without crashing") {
  AudioPlayback playback("");   // "" = system default
  std::string error;
  if (!playback.start(&error)) {
    MESSAGE("no default playback device in this environment (" << error << ") -- skipping");
    return;
  }
  // Push a short burst of silence and let the callback thread actually pull
  // from the ring at least once -- this is a real miniaudio playback device,
  // not a mock, so this proves push()/onPlayback() do not crash or deadlock
  // against genuine ALSA/PulseAudio callback timing.
  int16_t silence[160] = {0};
  playback.push(silence, 160);
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  playback.push(silence, 160);
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  CHECK(true);   // reaching here without crashing/hanging is the assertion
}

TEST_CASE("AudioPlayback reports an error for an unknown device name, does not crash") {
  AudioPlayback playback("this device does not exist -- 42");
  std::string error;
  CHECK_FALSE(playback.start(&error));
  CHECK_FALSE(error.empty());
  int16_t silence[16] = {0};
  playback.push(silence, 16);   // must be a safe no-op on a never-started playback
}
