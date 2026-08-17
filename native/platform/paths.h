// Where the native build keeps its two "partitions".
//
// The ESP32 has a custom partition table: `spiffs` holds the web assets and a
// separate `cfg` partition holds the operator's configuration, deliberately
// split so a firmware flash cannot wipe calibrations. On a PC the same split is
// two directories, and the same rule applies: reinstalling the binary must not
// touch the config directory.
#pragma once

#include <string>

// Web assets -- the shipped data/ tree. Read-only in practice.
// Default: <dir of executable>/data, overridable with --data-dir.
const std::string &nativeDataDir();

// Operator configuration: EEPROM image plus the cfgFS files.
// Default: $XDG_CONFIG_HOME/wifilt (Linux) or %APPDATA%\wifilt (Windows),
// overridable with --config-dir.
const std::string &nativeConfigDir();

void nativeSetDataDir(const std::string &path);
void nativeSetConfigDir(const std::string &path);

// Creates the config directory if it does not exist. Returns false only if the
// path exists as something other than a directory, or cannot be created.
bool nativeEnsureDir(const std::string &path);

// Joins with the platform separator and normalises the "/leading-slash" paths
// the sketch uses for its config files (e.g. "/log-config").
std::string nativeJoinPath(const std::string &root, const std::string &child);
