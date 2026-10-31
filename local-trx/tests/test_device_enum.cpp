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

#ifndef _WIN32
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include <fstream>

TEST_CASE("findSerialAliases finds udev-style symlinks to listed ports, nothing else") {
  // A scratch dir stands in for /dev: two "ports" (plain files -- only the
  // path resolution matters), udev-style relative aliases, a link to an
  // unlisted file, a dangling link and a subdirectory link that must stay out
  // (by-id/by-path are not scanned).
  char tmpl[] = "/tmp/local-trx-alias-XXXXXX";
  REQUIRE(mkdtemp(tmpl));
  const std::string dir = tmpl;
  for (const char *f : {"ttyUSB0", "ttyUSB1", "ttyS9"}) std::ofstream(dir + "/" + f);
  REQUIRE(symlink("ttyUSB0", (dir + "/ttyUSB.cat").c_str()) == 0);
  REQUIRE(symlink("ttyUSB1", (dir + "/ttyUSB.cw").c_str()) == 0);
  REQUIRE(symlink("ttyS9", (dir + "/unlisted").c_str()) == 0);
  REQUIRE(symlink("missing", (dir + "/dangling").c_str()) == 0);
  REQUIRE(mkdir((dir + "/serial").c_str(), 0700) == 0);
  REQUIRE(symlink("../ttyUSB0", (dir + "/serial/by-id-ish").c_str()) == 0);

  std::vector<SerialAlias> aliases =
      findSerialAliases({dir + "/ttyUSB0", dir + "/ttyUSB1"}, dir);
  REQUIRE(aliases.size() == 2);
  CHECK(aliases[0].path == dir + "/ttyUSB.cat");
  CHECK(aliases[0].target == dir + "/ttyUSB0");
  CHECK(aliases[1].path == dir + "/ttyUSB.cw");
  CHECK(aliases[1].target == dir + "/ttyUSB1");

  CHECK(findSerialAliases({}, dir).empty());
  CHECK(findSerialAliases({dir + "/ttyUSB0"}, dir + "/nonexistent").empty());

  REQUIRE(system(("rm -rf '" + dir + "'").c_str()) == 0);
}
#endif
