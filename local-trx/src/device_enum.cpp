#include "device_enum.h"

#include <algorithm>

// Declarations only -- MINIAUDIO_IMPLEMENTATION lives in its own translation
// unit (third_party/miniaudio/miniaudio_impl.c), same split audio_bridge.cpp
// already relies on.
#include "miniaudio.h"

#include <hamlib/rig.h>
#include <libserialport.h>

namespace LocalTrx {

AudioDeviceLists listAudioDevices() {
  AudioDeviceLists result;

  ma_context context;
  if (ma_context_init(nullptr, 0, nullptr, &context) != MA_SUCCESS) return result;

  ma_device_info *playbackInfos = nullptr;
  ma_uint32 playbackCount = 0;
  ma_device_info *captureInfos = nullptr;
  ma_uint32 captureCount = 0;
  if (ma_context_get_devices(&context, &playbackInfos, &playbackCount, &captureInfos,
                              &captureCount) == MA_SUCCESS) {
    for (ma_uint32 i = 0; i < captureCount; i++) result.capture.push_back(captureInfos[i].name);
    for (ma_uint32 i = 0; i < playbackCount; i++) result.playback.push_back(playbackInfos[i].name);
  }

  ma_context_uninit(&context);
  return result;
}

std::vector<std::string> listSerialPorts() {
  std::vector<std::string> names;
  struct sp_port **list = nullptr;
  if (sp_list_ports(&list) != SP_OK) return names;
  for (int i = 0; list[i]; i++) {
    const char *name = sp_get_port_name(list[i]);
    if (name) names.push_back(name);
  }
  sp_free_port_list(list);
  return names;
}

namespace {
int collectRigModel(const struct rig_caps *caps, rig_ptr_t data) {
  auto *out = static_cast<std::vector<RigModelInfo> *>(data);
  out->push_back({(int)caps->rig_model, caps->mfg_name ? caps->mfg_name : "",
                   caps->model_name ? caps->model_name : ""});
  return 1;   // 1 = keep enumerating (hamlib's own rigctl --list uses the same convention)
}
}  // namespace

std::vector<RigModelInfo> listRigModels() {
  // hamlib's registered rig model list cannot change at runtime (it is
  // compiled-in backend data), so re-walking every rig_caps struct across
  // ~200+ backends on every GET /api/devices -- the wizard's page-load call,
  // repeated on every reload including the one Save triggers -- was pure
  // waste. Cached after the first call; found by code review. Audio devices
  // and serial ports are NOT cached here (listAudioDevices()/listSerialPorts()
  // above) -- those genuinely change at runtime (USB hotplug) and are meant
  // to reflect that on every call.
  static const std::vector<RigModelInfo> models = [] {
    std::vector<RigModelInfo> m;
    rig_load_all_backends();   // only Dummy + a handful are registered otherwise
    rig_list_foreach(&collectRigModel, &m);
    // hamlib hands these back in internal registration order (roughly
    // per-backend release order, not remotely alphabetical -- e.g. Kenwood's
    // own TS-2000 sorts before its TS-570S), which makes finding one specific
    // rig among the ~280 entries by eye in the wizard's <select> painful.
    // Sorted by manufacturer then model name once, here, rather than in the
    // JS -- there is no reason to ship the unsorted order anywhere.
    std::sort(m.begin(), m.end(), [](const RigModelInfo &a, const RigModelInfo &b) {
      if (a.mfgName != b.mfgName) return a.mfgName < b.mfgName;
      return a.modelName < b.modelName;
    });
    return m;
  }();
  return models;
}

}  // namespace LocalTrx
