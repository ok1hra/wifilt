// mixer_control.h -- the sound card's own playback volume, for tx_level.h.
//
// Linux: an ALSA simple mixer element, libasound loaded with dlopen() at run
// time like miniaudio does (Makefile: no -lasound), so the arm64 cross build
// needs no new library and a machine without ALSA simply has no mixer.
// Windows: the output device's endpoint volume (IAudioEndpointVolume), in dB,
// not the "scalar" API, whose curve is perceptual rather than linear.
//
// Every call opens the control afresh: the calls are rare (wifilt's CAL PLAN
// reads/writes a few times per run), a USB codec can disappear and come back
// between two of them, and a fresh read is the only way to see what a desktop
// volume slider did in the meantime.
#pragma once

#include <memory>
#include <string>
#include <vector>

#include "config.h"
#include "tx_level.h"

namespace LocalTrx {

struct MixerChoice {
  std::string card;       // value for config.audio.mixerCard
  std::string cardName;   // what the operator recognises
  std::string element;    // value for config.audio.mixerElement
  double minDb = 0.0, maxDb = 0.0;
  double nowDb = 0.0;     // where it is right now
};

// Every playback control with a dB scale. Linux: each ALSA card's simple
// elements. Windows: one entry, the endpoint of `outputDevice` (card
// "endpoint"), when that device exists.
std::vector<MixerChoice> listMixerControls(const std::string &outputDevice);

// The control config.audio names, or null + *error. An empty mixerCard is
// "no MOD level" and returns null with no error.
std::unique_ptr<MixerControl> openMixerControl(const AudioConfig &audio, std::string *error);

}  // namespace LocalTrx
