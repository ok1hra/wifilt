// doctest unit tests for config.cpp -- config.json parsing/defaults (Dávka 1
// decision: nested sections, see docs/local-trx-implementace.md).
#include "doctest.h"

#include <cstdlib>
#include <cstdio>
#include <string>

#include "../src/config.h"

using namespace LocalTrx;

namespace {

// A fresh, empty scratch directory per test so tests never see each other's
// config.json and never touch the real ~/.config/local-trx.
std::string makeScratchDir(const char *suffix) {
  std::string dir = std::string("/tmp/local-trx-test-") + suffix;
  std::string cmd = "rm -rf " + dir + " && mkdir -p " + dir;
  std::system(cmd.c_str());
  return dir;
}

}  // namespace

TEST_CASE("loadConfig with no config.json yet returns defaults, no error") {
  std::string dir = makeScratchDir("empty");
  std::string error;
  Config config = loadConfig(dir, &error);
  CHECK(error.empty());
  // Off by default -- an installed-but-unconfigured local-trx must not grab
  // any hardware/port until the wizard's own checkbox turns it on.
  CHECK(config.enabled == false);
  CHECK(config.openBrowserOnStart == false);   // no browser spawned unattended/in CI
  CHECK(config.wifiltUrl == "http://127.0.0.1/");
  CHECK(config.listenIp == "127.0.0.1");
  CHECK(config.cat.rigModel == 1);   // RIG_MODEL_DUMMY
  CHECK(config.identity.radioName == "LOCAL-TRX");
  CHECK(config.identity.civAddress == "A6");
  CHECK(config.keying.keyLine == "dtr");
  CHECK(config.keying.pttLine == "rts");
}

TEST_CASE("identity.radioName default contains no 3-4 digit run (findModel() trap)") {
  // data/icom-models.js's findModel() extracts /(\d{3,4})/ from the reported
  // name; a match there would turn on capabilities this radio does not have.
  Config config = loadConfig(makeScratchDir("digitcheck"));
  int run = 0;
  for (char c : config.identity.radioName) {
    run = (c >= '0' && c <= '9') ? run + 1 : 0;
    CHECK(run < 3);
  }
}

TEST_CASE("saveConfig then loadConfig round-trips every field") {
  std::string dir = makeScratchDir("roundtrip");

  Config out;
  out.enabled = true;
  out.openBrowserOnStart = true;
  out.wifiltUrl = "http://192.168.1.60/";
  out.listenIp = "192.168.1.50";
  out.audio.inputDevice = "USB Audio CODEC";
  out.audio.outputDevice = "USB Audio CODEC";
  out.cat.port = "/dev/ttyUSB3";
  out.cat.baud = 38400;
  out.cat.rigModel = 3021;
  out.keying.port = "/dev/ttyUSB4";
  out.keying.baud = 9600;
  out.keying.keyLine = "rts";
  out.keying.pttLine = "dtr";
  out.keying.cwWpm = 25;
  out.keying.fskNetId = 0x22;
  out.identity.radioName = "TESTRIG";
  out.identity.civAddress = "B1";

  std::string error;
  REQUIRE(saveConfig(dir, out, &error));
  CHECK(error.empty());

  Config in = loadConfig(dir, &error);
  CHECK(error.empty());
  CHECK(in.enabled == out.enabled);
  CHECK(in.openBrowserOnStart == out.openBrowserOnStart);
  CHECK(in.wifiltUrl == out.wifiltUrl);
  CHECK(in.listenIp == out.listenIp);
  CHECK(in.audio.inputDevice == out.audio.inputDevice);
  CHECK(in.audio.outputDevice == out.audio.outputDevice);
  CHECK(in.cat.port == out.cat.port);
  CHECK(in.cat.baud == out.cat.baud);
  CHECK(in.cat.rigModel == out.cat.rigModel);
  CHECK(in.keying.port == out.keying.port);
  CHECK(in.keying.baud == out.keying.baud);
  CHECK(in.keying.keyLine == out.keying.keyLine);
  CHECK(in.keying.pttLine == out.keying.pttLine);
  CHECK(in.keying.cwWpm == out.keying.cwWpm);
  CHECK(in.keying.fskNetId == out.keying.fskNetId);
  CHECK(in.identity.radioName == out.identity.radioName);
  CHECK(in.identity.civAddress == out.identity.civAddress);
}

TEST_CASE("loadConfig on malformed JSON reports an error and still returns defaults") {
  std::string dir = makeScratchDir("malformed");
  FILE *f = std::fopen((dir + "/config.json").c_str(), "w");
  REQUIRE(f != nullptr);
  std::fputs("{ not valid json", f);
  std::fclose(f);

  std::string error;
  Config config = loadConfig(dir, &error);
  CHECK_FALSE(error.empty());
  CHECK(config.listenIp == "127.0.0.1");   // defaults, not a half-parsed struct
}
