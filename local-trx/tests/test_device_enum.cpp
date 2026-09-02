// doctest unit tests for device_enum.cpp's wizard-UI listing helpers (fáze
// 6). No socket/HTTP here -- see webui_server.cpp for how these turn into
// JSON; tools/local-trx-integration-test.sh covers the HTTP side live.
#include "doctest.h"

#include <hamlib/rig.h>

#include "../src/device_enum.h"

using namespace LocalTrx;

TEST_CASE("listRigModels includes hamlib's Dummy backend, no hardware needed") {
  // Same fix as main.cpp's own rig_set_debug() call: rig_load_all_backends()
  // defaults to RIG_DEBUG_VERBOSE, which floods stdout with an "_init
  // called" line per backend (~200 of them) otherwise.
  rig_set_debug(RIG_DEBUG_ERR);
  std::vector<RigModelInfo> models = listRigModels();
  bool foundDummy = false;
  for (const auto &m : models) {
    if (m.modelName == "Dummy") {
      foundDummy = true;
      break;
    }
  }
  CHECK(foundDummy);
  // bod 10: the WHOLE hamlib list, no curated subset -- hamlib ships several
  // hundred backends once rig_load_all_backends() has run, so a low count
  // here would mean that call silently stopped happening.
  CHECK(models.size() > 100);
}

TEST_CASE("listAudioDevices completes without crashing, sandbox with zero real devices included") {
  // No assertion on content -- a CI sandbox may have no real audio hardware
  // at all. This proves miniaudio's own ma_context_init()/get_devices()/
  // uninit() sequence completes cleanly either way, the same tolerance
  // test_audio_bridge.cpp already has for AudioCapture/AudioPlayback.
  CHECK_NOTHROW(listAudioDevices());
}

TEST_CASE("listSerialPorts completes without crashing, tolerates zero candidates") {
  // Same "0 candidates in this sandbox is a valid outcome, not a failure"
  // tolerance as test_serial_key.cpp's own sp_list_ports() use.
  CHECK_NOTHROW(listSerialPorts());
}
