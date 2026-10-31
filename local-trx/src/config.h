// config.h -- local-trx's own JSON config, separate from wifilt's
// /radio-config.json (see docs/local-trx-implementace.md, "Dávka 1").
//
// Nested per-wizard-step sections on purpose: the wizard UI (phase 6, not
// built yet) will read/write exactly one section per step. Until then this
// file is hand-edited.
#pragma once

#include <cstdint>
#include <string>

namespace LocalTrx {

struct AudioConfig {
  std::string inputDevice;   // miniaudio device name, not index (phase 2/3, unused for now)
  std::string outputDevice;
};

struct CatConfig {
  // "hamlib": serial CAT below. "trxnet": the TrxNet device in TrxnetConfig
  // (an OI3 keyer that talks CI-V to the radio) -- port/baud/rigModel unused.
  std::string backend = "hamlib";
  std::string port = "/dev/ttyUSB0";
  int         baud = 19200;
  int         rigModel = 1;   // hamlib RIG_MODEL_DUMMY -- see phase 1
};

struct KeyingConfig {
  // Each "serial" (DTR/RTS on `port` below) or "trxnet" (TrxnetConfig's
  // device). cwBackend covers CW and FSK text -- over TrxNet the device keys
  // it with its own keyer, at its own speed. pttBackend covers every PTT,
  // audio and the one KeyRunner raises around serial CW/FSK.
  std::string cwBackend = "serial";
  std::string pttBackend = "serial";
  std::string port = "/dev/ttyUSB1";   // second, independent serial adapter (bod 6/7)
  int         baud = 1200;
  std::string keyLine = "dtr";         // "dtr" | "rts" -- the other line is always PTT
  std::string pttLine = "rts";
  int         cwWpm = 20;              // 0x14 0x0C, own bit-banging engine, never hamlib (bod 8)
  // TrxNet peer identity for FSK (bod 15): wifilt's own g_lcFskOutputMode="trxnet"
  // sends here as OI3.<fskNetId>. Independent of CI-V address below.
  uint8_t fskNetId = 0x10;
};

// The TrxNet device CAT/CW/PTT go through when a backend above says
// "trxnet" -- see trxnet_link.h. Not the FSK peer identity (keying.fskNetId),
// which wifilt reaches on loopback.
struct TrxnetConfig {
  std::string peer;              // device name picked by the wizard's scan, e.g. "OI3.01"
  uint8_t netId = 0x01;          // local-trx's own name on the network: "LTX.<netId>"
  // The port this end listens on. 5684 beside a native wifilt, which already
  // holds 5683 on this machine (TrxNet 1.08 setDiscoveryPort(); the device
  // must run 1.08+ to answer). 5683 when wifilt runs elsewhere -- then any
  // TrxNet version works.
  uint16_t localPort = 5684;
  uint16_t networkPort = 5683;   // what every other device uses
};

// Synthetic radio identity presented at LAN login (bod 3). radioName MUST NOT
// contain a 3-4 digit run -- data/icom-models.js's findModel() extracts one
// with /(\d{3,4})/ and, if it happened to match a real model number, would
// turn on capabilities (MOD-level calibration etc.) this radio does not have.
struct IdentityConfig {
  std::string radioName = "LOCAL-TRX";
  std::string civAddress = "A6";   // hex string; configurable, does not collide
                                    // with any entry in icom-models.js's MODELS table
};

struct Config {
  // Master switch, OFF by default -- an installed-but-unconfigured local-trx
  // (e.g. shipped alongside a wifilt release, not asked for by every
  // operator) must not grab any hardware or open any port until someone has
  // actually walked through the wizard and turned it on. false here means
  // main.cpp runs ONLY the setup wizard (webui_server.cpp) -- no
  // HamlibRigBackend, no KeyRunner/SerialKeyLine, no AudioCapture/Playback,
  // no IcomLanServer, no TrxnetPeer -- so the wizard itself is what flips
  // this to true (checkbox, top of webui/index.html), Save, then a restart
  // brings the whole thing up for real. See docs/local-trx-implementace.md.
  bool enabled = false;
  // Opens both this process's own wizard page and wifiltUrl below in the
  // system's default browser at startup -- asked for directly ("chtěl bych,
  // aby spuštění binárky otevřelo jak web wifilt, tak local-trx"). Off by
  // default for the same reason "enabled" is: an unattended/CI/headless run
  // must not spawn a real browser process. Suppressed on a restart THIS
  // process triggered itself (Save button, LOCAL_TRX_RESTARTED env var,
  // main.cpp) -- only a genuinely fresh launch opens tabs, not every save.
  bool openBrowserOnStart = false;
  std::string wifiltUrl = "http://127.0.0.1/";   // best-effort guess -- wifilt's own
                                                  // port/host are not knowable from here
  std::string listenIp = "127.0.0.1";   // informational: WiFiUDP binds INADDR_ANY,
                                         // this is what the operator types into
                                         // wifilt's Setup ICOM-LAN field
  AudioConfig audio;
  CatConfig cat;
  KeyingConfig keying;
  TrxnetConfig trxnet;
  IdentityConfig identity;

  bool catOverTrxnet() const { return cat.backend == "trxnet"; }
  bool cwOverTrxnet() const { return keying.cwBackend == "trxnet"; }
  bool pttOverTrxnet() const { return keying.pttBackend == "trxnet"; }
  bool usesTrxnet() const { return catOverTrxnet() || cwOverTrxnet() || pttOverTrxnet(); }
};

// Default config file location, mirroring native/platform/paths.cpp's pattern
// for wifilt itself: $XDG_CONFIG_HOME/local-trx or ~/.config/local-trx on
// Linux/macOS, %APPDATA%\local-trx on Windows. Overridable with --config-dir.
std::string defaultConfigDir();

// Parses a config.json DOCUMENT already in memory -- shared by loadConfig()
// below (reads one off disk) and the wizard's POST /api/config (fáze 6,
// webui_server.cpp), so the two can never drift on what "a valid config.json"
// means. Kept string-in/Config-out (no nlohmann::json in this signature) so
// neither loadConfig()'s callers nor webui_server.cpp need to include
// third_party/json/json.hpp themselves -- same "no third-party types leak
// into the header" rule device_enum.h keeps for miniaudio/hamlib/libserialport.
// Malformed JSON is reported via `error` and the returned Config is still
// all-defaults -- never a half-parsed struct.
Config parseConfigJson(const std::string &jsonText, std::string *error = nullptr);

// Reads configDir + "/config.json". Missing file -> defaults (all fields
// above), so a first run works without the wizard. Malformed JSON is reported
// via `error` and the returned Config is still the defaults -- never a
// half-parsed struct.
Config loadConfig(const std::string &configDir, std::string *error = nullptr);

// Writes configDir + "/config.json", creating configDir if needed. Returns
// false (and fills `error`) only on an I/O failure.
bool saveConfig(const std::string &configDir, const Config &config, std::string *error = nullptr);

// Same JSON shape saveConfig() writes to disk, as a string -- shared with the
// wizard's GET /api/config (fáze 6, webui_server.cpp) so the file and the
// HTTP response can never drift on what a Config serialises to. No
// nlohmann::json in this signature, same reasoning as parseConfigJson() above.
std::string configToJsonString(const Config &config);

}  // namespace LocalTrx
