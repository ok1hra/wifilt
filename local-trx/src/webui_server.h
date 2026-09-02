// webui_server.h -- the wizard's own embedded HTTP server (fáze 6, bod
// "Setup/config UI"). Own port, own page, entirely separate from wifilt's
// 80/82/83 -- this reads/writes local-trx's config.json, never wifilt's
// /radio-config.json (see config.h).
//
// Reuses native/net/WebServer.cpp + native/fs/FS.cpp + native/platform/
// paths.cpp -- bod 12's "recompile a proven component a second time" pattern
// (already applied to icom_lan_wire.h/native/arduino and TrxNet.cpp),
// extended a third time rather than hand-rolling an HTTP parser. The
// non-blocking accept/read-once/dispatch contract WebServer.h documents
// still matters here: poll() runs in the SAME main-loop iteration as
// IcomLanServer::poll()/TrxnetPeer::poll(), so it must never block on a slow
// client the way the file header's contract #2 already guards against.
#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include "config.h"

// Forward-declared rather than #include "WebServer.h" here -- that header
// pulls in Arduino.h/FS.h/WiFi.h, which nothing that merely CONSTRUCTS a
// WebUiServer (main.cpp included) needs to see. webui_server.cpp includes it.
class WebServer;

namespace LocalTrx {

// Forward-declared for the same reason as WebServer above -- only
// webui_server.cpp needs libserialport.h itself (via serial_key.h).
class SerialKeyLine;
// Same reasoning again for miniaudio.h (audio_bridge.h) and hamlib/rig.h
// (hamlib_bridge.h).
class AudioCapture;
class AudioPlayback;

class WebUiServer {
 public:
  // webRoot: directory holding index.html (and any static assets) -- mapped
  // onto the reused LittleFS global the same way native/main.cpp maps it
  // onto wifilt's own data/ directory, just pointed at local-trx's own
  // webui/ instead. configDir: where GET/POST /api/config read and write
  // (config.h's own convention, same directory --config-dir already names).
  // hardwareLive: true in main.cpp's enabled branch, where a real
  // HamlibRigBackend/SerialKeyLine/AudioCapture/AudioPlayback already holds
  // config.json's CAT/keying/audio ports+devices open for the live ICOM-LAN
  // session; false in the disabled branch, where the wizard is the only
  // thing running and nothing is open yet. Test-line/test-CAT/test-audio
  // refuse to open a SECOND handle onto the same hardware when this is true
  // (see their own comments) -- opening e.g. a rig_open() against a serial
  // port hamlib's live instance already owns does not fail cleanly on every
  // platform/backend, and can instead interleave/garble commands actually
  // reaching the radio. Found by code review; the wizard's live-test buttons
  // were only ever meant for configuring BEFORE "Enable" is checked, when
  // nothing else has the hardware open yet.
  WebUiServer(uint16_t port, std::string webRoot, std::string configDir, bool hardwareLive);
  ~WebUiServer();

  bool begin(std::string *error);
  void poll();   // non-blocking -- call every main-loop iteration, like
                 // IcomLanServer::poll()/TrxnetPeer::poll()

  // Set once, right after a successful POST /api/config -- main.cpp checks
  // this on the NEXT main-loop iteration (after this poll() call has
  // returned, so WebServer's own finishRequest() has already closed that
  // request's client socket) and re-execs the whole process there, never
  // from inside the request handler itself: doing it there would replace
  // the process image before the "saved" response had actually left the
  // socket. Asked for directly ("can the button restart the binary itself
  // without user intervention") since config.json's own no-hot-reload rule
  // already meant every save needed one anyway.
  bool restartRequested() const { return restartRequested_; }

 private:
  void setupRoutes();
  void handleDevices();
  void handleGetConfig();
  void handlePostConfig();
  void handleTestLine();
  void handleTestCat();
  void handleTestAudio();
  void handleAudioLevel();
  void sendError(int code, const std::string &message);

  uint16_t port_;
  std::string webRoot_;
  std::string configDir_;
  bool hardwareLive_;
  std::unique_ptr<WebServer> server_;

  // POST /api/test-line's own state (bod: live DTR/RTS test button, asked
  // for after a real-hardware session found the ONLY way to confirm keying
  // actually worked was eyes/ears on the radio -- this lets an operator
  // toggle the line themselves while still on the wizard's step 3, instead
  // of needing the whole wifilt->CI-V->KeyRunner chain running first. Opened
  // lazily on the first "on", against whatever port/lines the CURRENT form
  // fields say (not the saved config.json) -- reuses SerialKeyLine as-is, so
  // its own destructor's "deassert both lines before closing" guarantee
  // applies here too. A different port than the one currently open closes
  // the old one first, never leaves two open at once.
  std::unique_ptr<SerialKeyLine> testLine_;
  std::string testLinePort_;

  // POST /api/test-audio + GET /api/audio-level's own state, same "against
  // the current form, not saved config, opened lazily, torn down on
  // device-switch/page-unload" shape as testLine_ above. testCapture_ backs
  // step 1's live level meter (JS polls /api/audio-level while it is open);
  // testPlayback_ backs the "play test tone" button -- kept open across
  // clicks rather than opened/closed per click specifically so the tone
  // itself (pushed once, played by miniaudio's OWN callback thread) is never
  // cut short by a synchronous close racing the still-draining ring buffer,
  // and so handleTestAudio() never needs to block this thread waiting for
  // playback to finish either.
  std::unique_ptr<AudioCapture> testCapture_;
  std::string testCaptureDevice_;
  std::unique_ptr<AudioPlayback> testPlayback_;
  std::string testPlaybackDevice_;

  bool restartRequested_ = false;
};

}  // namespace LocalTrx
