// device_enum.h -- transport-free device/model listing for the wizard UI
// (fáze 6). Turns miniaudio/libserialport/hamlib's own enumeration APIs into
// plain std::vector<std::string>/struct lists with no HTTP/JSON involved --
// webui_server.cpp does that translation, same "logic separate from
// transport" split as civ_router.h/rig_backend.h keep for the CI-V side.
//
// None of hamlib/miniaudio/libserialport's own headers leak into this header
// (kept out of the .h on purpose -- RigModelInfo::id is a plain int, not
// rig_model_t) so callers that only need the wizard's JSON shape do not have
// to pull in three third-party headers to get it.
#pragma once

#include <string>
#include <vector>

namespace LocalTrx {

struct AudioDeviceLists {
  std::vector<std::string> capture;
  std::vector<std::string> playback;
};

// Empty lists on failure (e.g. ma_context_init() itself fails) rather than an
// error return -- the wizard just shows "no devices found", the same
// tolerance config.h's own empty-string-means-unset convention already has
// for a missing/misconfigured device.
AudioDeviceLists listAudioDevices();

// Empty on failure or zero ports found (both look the same to a caller, and
// both are already-tolerated states here -- see serial_key.h's own "port
// unavailable, fall back to logging" handling in main.cpp).
std::vector<std::string> listSerialPorts();

struct RigModelInfo {
  int id;   // hamlib's rig_model_t, kept as a plain int per this header's own
            // "no third-party types" rule above
  std::string mfgName;
  std::string modelName;
};

// The WHOLE hamlib list, no curated subset (bod 10) -- calls
// rig_load_all_backends() first, since only a handful of models are
// registered by default (Dummy among them).
std::vector<RigModelInfo> listRigModels();

}  // namespace LocalTrx
