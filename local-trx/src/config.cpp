#include "config.h"

#include <fstream>
#include <sstream>

#include "paths.h"   // nativeEnsureDir() -- shared with wifilt's own native build
                      // (bod 12); recursive (creates missing parents), unlike a
                      // single mkdir() call, and already linked into local-trx
                      // via native/Makefile's own object (Makefile's CXX_SOURCES)
                      // so this is not a new dependency. A private, non-recursive
                      // reimplementation used to live here -- found duplicated by
                      // code review, and it silently failed to create configDir
                      // whenever it needed more than one new path segment (e.g. a
                      // --config-dir two levels deep that does not exist yet).

#include "../third_party/json/json.hpp"

using nlohmann::json;

namespace LocalTrx {

std::string defaultConfigDir() {
#ifdef _WIN32
  const char *appData = getenv("APPDATA");
  if (appData && *appData) return std::string(appData) + "\\local-trx";
  return "local-trx-config";
#else
  const char *xdg = getenv("XDG_CONFIG_HOME");
  if (xdg && *xdg) return std::string(xdg) + "/local-trx";
  const char *home = getenv("HOME");
  if (home && *home) return std::string(home) + "/.config/local-trx";
  return "local-trx-config";
#endif
}

Config parseConfigJson(const std::string &jsonText, std::string *error) {
  Config config;   // defaults from config.h's in-class initialisers

  // One try covers json::parse() (throws parse_error on bad syntax) AND every
  // .get<T>() below (throws type_error on a wrong-typed field -- e.g. a hand-
  // edited config.json with "baud":"115200" as a string). Catching only
  // parse_error left a type_error from .get<T>() unhandled and propagating
  // out of parseConfigJson() as an uncaught exception -- found by code
  // review. nlohmann::json::exception is the common base of parse_error/
  // type_error/out_of_range/other_error, so one catch covers all of them;
  // on any failure this falls back to all-defaults, same as the pre-existing
  // parse_error behaviour, rather than a half-populated Config.
  try {
    json root = json::parse(jsonText);

    if (root.contains("enabled")) config.enabled = root["enabled"].get<bool>();
    if (root.contains("openBrowserOnStart"))
      config.openBrowserOnStart = root["openBrowserOnStart"].get<bool>();
    if (root.contains("wifiltUrl")) config.wifiltUrl = root["wifiltUrl"].get<std::string>();
    if (root.contains("listenIp")) config.listenIp = root["listenIp"].get<std::string>();

    if (root.contains("audio")) {
      auto &a = root["audio"];
      if (a.contains("inputDevice"))  config.audio.inputDevice  = a["inputDevice"].get<std::string>();
      if (a.contains("outputDevice")) config.audio.outputDevice = a["outputDevice"].get<std::string>();
    }

    if (root.contains("cat")) {
      auto &c = root["cat"];
      if (c.contains("port"))     config.cat.port     = c["port"].get<std::string>();
      if (c.contains("baud"))     config.cat.baud     = c["baud"].get<int>();
      if (c.contains("rigModel")) config.cat.rigModel = c["rigModel"].get<int>();
    }

    if (root.contains("keying")) {
      auto &k = root["keying"];
      if (k.contains("port"))     config.keying.port     = k["port"].get<std::string>();
      if (k.contains("baud"))     config.keying.baud     = k["baud"].get<int>();
      if (k.contains("keyLine"))  config.keying.keyLine  = k["keyLine"].get<std::string>();
      if (k.contains("pttLine"))  config.keying.pttLine  = k["pttLine"].get<std::string>();
      if (k.contains("cwWpm"))    config.keying.cwWpm    = k["cwWpm"].get<int>();
      if (k.contains("fskNetId")) config.keying.fskNetId = (uint8_t)k["fskNetId"].get<unsigned>();
    }

    if (root.contains("identity")) {
      auto &i = root["identity"];
      if (i.contains("radioName"))  config.identity.radioName  = i["radioName"].get<std::string>();
      if (i.contains("civAddress")) config.identity.civAddress = i["civAddress"].get<std::string>();
    }
  } catch (const json::exception &e) {
    if (error) *error = std::string("config.json error: ") + e.what();
    return Config{};   // bad/partial parse must not hand back a half-applied config
  }

  return config;
}

Config loadConfig(const std::string &configDir, std::string *error) {
  const std::string path = configDir + "/config.json";

  std::ifstream in(path);
  if (!in.is_open()) {
    // No file yet is not an error -- first run works off defaults.
    return Config{};
  }

  std::stringstream buffer;
  buffer << in.rdbuf();
  return parseConfigJson(buffer.str(), error);
}

std::string configToJsonString(const Config &config) {
  json root;
  root["enabled"] = config.enabled;
  root["openBrowserOnStart"] = config.openBrowserOnStart;
  root["wifiltUrl"] = config.wifiltUrl;
  root["listenIp"] = config.listenIp;
  root["audio"] = {
    {"inputDevice",  config.audio.inputDevice},
    {"outputDevice", config.audio.outputDevice},
  };
  root["cat"] = {
    {"port", config.cat.port},
    {"baud", config.cat.baud},
    {"rigModel", config.cat.rigModel},
  };
  root["keying"] = {
    {"port", config.keying.port},
    {"baud", config.keying.baud},
    {"keyLine", config.keying.keyLine},
    {"pttLine", config.keying.pttLine},
    {"cwWpm", config.keying.cwWpm},
    {"fskNetId", (unsigned)config.keying.fskNetId},
  };
  root["identity"] = {
    {"radioName", config.identity.radioName},
    {"civAddress", config.identity.civAddress},
  };
  return root.dump(2);
}

bool saveConfig(const std::string &configDir, const Config &config, std::string *error) {
  if (!nativeEnsureDir(configDir)) {
    if (error) *error = "cannot create config directory: " + configDir;
    return false;
  }

  std::ofstream out(configDir + "/config.json");
  if (!out.is_open()) {
    if (error) *error = "cannot write " + configDir + "/config.json";
    return false;
  }
  out << configToJsonString(config) << "\n";
  return true;
}

}  // namespace LocalTrx
