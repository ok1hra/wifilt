// Add-ons: optional features kept out of this repository.
//
// When addons/addon.h exists beside the sketch, wifilt.ino includes it at its
// very end (#if __has_include), so an add-on sees every definition of the
// sketch, and it defines every hook declared here. Without the folder the
// sketch defines them empty and the build is the public one. An add-on's
// pages come from addons/<name>/data/, merged into the filesystem image by
// tools/prepare-spiffs-tree.sh and served beside data/ by the native build
// (--data-dir given again).
//
// The type and the empty hooks live in this header, not in wifilt.ino: the
// Arduino builder puts the .ino's generated prototypes ahead of anything
// declared in it (a prototype that names AddonBlob must find it already
// here), and it guesses prototypes from one-line bodies wrongly.
#pragma once

#include <stddef.h>
#include <Arduino.h>

// A small JSON blob an add-on keeps on cfgFS, stored verbatim and served at its
// own path -- the same contract as /mercury-tuning.json.
struct AddonBlob {
  const char* path;       // cfgFS file, also the URL it is served at
  size_t maxBytes;
  const char* backupKey;  // section in /config/download; nullptr keeps it out
  void (*onSaved)(void);  // after a successful write (POST or restore), or nullptr
};

size_t addonBlobCount(void);
const AddonBlob& addonBlobAt(size_t i);
void addonSetup(void);      // cfgFS mounted, before the first radio stream request
void addonNetworkUp(void);  // web server and AUD1 listening
void addonRoutes(void);     // extra webServer.on() routes
void addonTick(void);       // every loop pass
bool addonFromPage(const String& type, const String& json);  // AUD1 control frame; true = consumed

// What the sketch offers an add-on beyond its globals.
void radioLinkSetWide(bool want, bool reconnect);        // 16 kHz radio link on/off
bool aud1SendTextFrame(const char* json, size_t n);      // text frame to the AUD1 client
size_t aud1SendRoom(void);                               // free bytes in its send queue

// -DWIFILT_NO_ADDONS builds the public edition with addons/ present
// (what tools/release.sh always builds).
#if !defined(WIFILT_NO_ADDONS) && __has_include("addons/addon.h")
  #define WIFILT_HAS_ADDONS 1
#else
  #define WIFILT_HAS_ADDONS 0
  static const AddonBlob kNoAddonBlob = {"", 0, nullptr, nullptr};
  size_t addonBlobCount(void) { return 0; }
  const AddonBlob& addonBlobAt(size_t) { return kNoAddonBlob; }
  void addonSetup(void) {}
  void addonNetworkUp(void) {}
  void addonRoutes(void) {}
  void addonTick(void) {}
  bool addonFromPage(const String&, const String&) { return false; }
#endif
