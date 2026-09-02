#include "webui_server.h"

#include <cmath>
#include <fstream>
#include <functional>
#include <sstream>

#include <FS.h>
#include <WebServer.h>

#include "../third_party/json/json.hpp"
#include "audio_bridge.h"
#include "device_enum.h"
#include "hamlib_bridge.h"
#include "serial_key.h"

using nlohmann::json;

namespace LocalTrx {

WebUiServer::WebUiServer(uint16_t port, std::string webRoot, std::string configDir, bool hardwareLive)
    : port_(port), webRoot_(std::move(webRoot)), configDir_(std::move(configDir)),
      hardwareLive_(hardwareLive), server_(std::make_unique<WebServer>(port_)) {}

// Needed even though it is empty: WebServer is only forward-declared in the
// header, so std::unique_ptr's default destructor (generated at the call
// site if this were left implicit) would not see a complete type there.
WebUiServer::~WebUiServer() = default;

bool WebUiServer::begin(std::string *error) {
  LittleFS.nativeSetRoot(webRoot_);
  if (!LittleFS.begin()) {
    if (error) *error = "webui: cannot open web root: " + webRoot_;
    return false;
  }
  setupRoutes();
  server_->begin();
  return true;
}

void WebUiServer::poll() { server_->handleClient(); }

void WebUiServer::setupRoutes() {
  server_->on("/", [this]() {
    fs::File file = LittleFS.open("/index.html");
    if (!file) {
      server_->send(404, "text/plain", ("index.html not found in " + webRoot_).c_str());
      return;
    }
    server_->streamFile(file, "text/html");
  });

  server_->on("/api/devices", [this]() { handleDevices(); });

  server_->on("/api/config", HTTP_GET, [this]() { handleGetConfig(); });
  server_->on("/api/config", HTTP_POST, [this]() { handlePostConfig(); });

  server_->on("/api/test-line", HTTP_POST, [this]() { handleTestLine(); });
  server_->on("/api/test-cat", HTTP_POST, [this]() { handleTestCat(); });
  server_->on("/api/test-audio", HTTP_POST, [this]() { handleTestAudio(); });
  server_->on("/api/audio-level", HTTP_GET, [this]() { handleAudioLevel(); });

  server_->onNotFound([this]() { server_->send(404, "text/plain", "not found"); });
}

void WebUiServer::handleDevices() {
  json root;

  AudioDeviceLists audio = listAudioDevices();
  root["audioCapture"] = audio.capture;
  root["audioPlayback"] = audio.playback;

  root["serialPorts"] = listSerialPorts();

  json models = json::array();
  for (const RigModelInfo &m : listRigModels()) {
    models.push_back({{"id", m.id}, {"mfg", m.mfgName}, {"model", m.modelName}});
  }
  root["rigModels"] = std::move(models);

  server_->send(200, "application/json", root.dump().c_str());
}

void WebUiServer::handleGetConfig() {
  std::string error;
  Config config = loadConfig(configDir_, &error);
  // A parse error here means an operator (or a previous local-trx version)
  // left a malformed config.json on disk -- still answer with the in-memory
  // defaults loadConfig() itself falls back to (never a half-parsed struct,
  // see config.h), just surface the problem too rather than hiding it.
  json root = json::parse(configToJsonString(config));
  if (!error.empty()) root["_loadError"] = error;
  server_->send(200, "application/json", root.dump().c_str());
}

void WebUiServer::handlePostConfig() {
  std::string body(server_->arg("plain").c_str());   // ESP32 convention, WebServer.h's own doc comment #3
  std::string error;
  Config config = parseConfigJson(body, &error);
  if (!error.empty()) {
    json err;
    err["ok"] = false;
    err["error"] = error;
    server_->send(400, "application/json", err.dump().c_str());
    return;
  }
  if (!saveConfig(configDir_, config, &error)) {
    json err;
    err["ok"] = false;
    err["error"] = error;
    server_->send(500, "application/json", err.dump().c_str());
    return;
  }
  // local-trx wires hamlib/miniaudio/libserialport up ONCE at startup
  // (main.cpp) -- there is no live-reconfiguration path for any of them, so
  // a saved config only takes effect after a restart. Same "Save & Restart"
  // shape as wifilt's own first-run Setup flow -- and, like wifilt's own
  // POST /restart, main.cpp does the actual restart itself (see
  // restartRequested()'s own comment for exactly when), so the operator
  // never has to do it by hand.
  restartRequested_ = true;
  json ok;
  ok["ok"] = true;
  ok["note"] = "saved -- restarting local-trx now";
  server_->send(200, "application/json", ok.dump().c_str());
}

void WebUiServer::sendError(int code, const std::string &message) {
  json err;
  err["ok"] = false;
  err["error"] = message;
  server_->send(code, "application/json", err.dump().c_str());
}

namespace {
// Every /api/test-* handler below takes its JSON body the same way -- pulled
// out so each one is just "parse, validate, act" without repeating the
// try/catch. Returns false (having already sent the 400) on a parse error.
bool parseJsonBody(WebServer &server, json *out, std::function<void(int, const std::string &)> fail) {
  try {
    *out = json::parse(std::string(server.arg("plain").c_str()));
    return true;
  } catch (const json::parse_error &e) {
    fail(400, std::string("bad request: ") + e.what());
    return false;
  }
}
}  // namespace

void WebUiServer::handleTestLine() {
  if (hardwareLive_) {
    sendError(409, "local-trx is enabled and running live -- disable it and restart before "
                    "using the test buttons, so the wizard is not opening a second handle onto "
                    "hardware the live session already holds open.");
    return;
  }
  json req;
  auto fail = [this](int code, const std::string &message) { sendError(code, message); };
  if (!parseJsonBody(*server_, &req, fail)) return;

  if (!req.contains("port") || !req.contains("which") || !req.contains("on")) {
    fail(400, "missing port/which/on");
    return;
  }
  std::string port = req["port"].get<std::string>();
  std::string which = req["which"].get<std::string>();
  bool on = req["on"].get<bool>();
  if (port.empty()) {
    fail(400, "no port selected yet");
    return;
  }
  if (which != "key" && which != "ptt") {
    fail(400, "which must be \"key\" or \"ptt\"");
    return;
  }

  // A different port than whatever test line is currently open -- close the
  // old one first (its destructor deasserts both lines before releasing the
  // handle) rather than ever holding two open at once.
  if (testLine_ && testLinePort_ != port) {
    testLine_.reset();
    testLinePort_.clear();
  }

  if (!testLine_) {
    int baud = req.value("baud", 1200);
    std::string keyLine = req.value("keyLine", "dtr");
    std::string pttLine = req.value("pttLine", "rts");
    auto candidate = std::make_unique<SerialKeyLine>(port, baud, keyLine, pttLine);
    std::string openError;
    if (!candidate->open(&openError)) {
      fail(400, openError);
      return;
    }
    testLine_ = std::move(candidate);
    testLinePort_ = port;
  }

  if (which == "key") {
    testLine_->setKey(on);
  } else {
    testLine_->setPtt(on);
  }

  json ok;
  ok["ok"] = true;
  server_->send(200, "application/json", ok.dump().c_str());
}

// Fresh rig_open()/rig_get_freq()/rig_close() every click (no persistent
// state, unlike testLine_/testCapture_/testPlayback_ below) -- a one-shot
// query has nothing to hold open between requests. This DOES block
// WebUiServer::poll() -- and so the whole main loop, since it is one
// thread -- for however long hamlib's serial round-trip takes (typically
// well under a second, up to its read-timeout on a wrong port/baud): an
// accepted, bounded exception to the "never block the loop" rule the class
// comment states, scoped to a rare, deliberate, human-clicked wizard action,
// not a hot path. Same trade-off implicitly already made by handleTestLine's
// own sp_open() above, just with a longer worst case here.
void WebUiServer::handleTestCat() {
  if (hardwareLive_) {
    sendError(409, "local-trx is enabled and running live -- disable it and restart before "
                    "using the test buttons, so the wizard is not opening a second handle onto "
                    "hardware the live session already holds open.");
    return;
  }
  json req;
  auto fail = [this](int code, const std::string &message) { sendError(code, message); };
  if (!parseJsonBody(*server_, &req, fail)) return;

  if (!req.contains("port")) {
    fail(400, "missing port");
    return;
  }
  std::string port = req["port"].get<std::string>();
  if (port.empty()) {
    fail(400, "no port selected yet");
    return;
  }
  int baud = req.value("baud", 19200);
  int rigModel = req.value("rigModel", 1);

  HamlibRigBackend rig((rig_model_t)rigModel, port, baud);
  std::string openError;
  if (!rig.open(&openError)) {
    fail(400, openError);
    return;
  }
  double freqHz = rig.getFreqHz();

  json ok;
  ok["ok"] = true;
  ok["freqHz"] = freqHz;
  server_->send(200, "application/json", ok.dump().c_str());
  // rig destructs here (rig_close()+rig_cleanup()) -- never left open between
  // clicks, unlike the keying/audio test state below, since there is nothing
  // to poll for on a CAT link between one query and the next.
}

void WebUiServer::handleTestAudio() {
  if (hardwareLive_) {
    sendError(409, "local-trx is enabled and running live -- disable it and restart before "
                    "using the test buttons, so the wizard is not opening a second handle onto "
                    "hardware the live session already holds open.");
    return;
  }
  json req;
  auto fail = [this](int code, const std::string &message) { sendError(code, message); };
  if (!parseJsonBody(*server_, &req, fail)) return;

  if (!req.contains("role") || !req.contains("device") || !req.contains("on")) {
    fail(400, "missing role/device/on");
    return;
  }
  std::string role = req["role"].get<std::string>();
  std::string device = req["device"].get<std::string>();
  bool on = req["on"].get<bool>();
  // "default" is the same portable everyone-reads-it-the-same-way sentinel
  // config.h/main.cpp already use for the system default device -- real
  // device names are locale-dependent (see main.cpp's own comment).
  std::string deviceName = device == "default" ? "" : device;

  if (role == "capture") {
    if (!on) {
      testCapture_.reset();
      testCaptureDevice_.clear();
      json ok;
      ok["ok"] = true;
      server_->send(200, "application/json", ok.dump().c_str());
      return;
    }
    if (device.empty()) {
      fail(400, "no capture device selected yet");
      return;
    }
    if (!testCapture_ || testCaptureDevice_ != device) {
      testCapture_.reset();
      auto candidate = std::make_unique<AudioCapture>(deviceName);
      std::string openError;
      if (!candidate->start(&openError)) {
        fail(400, openError);
        return;
      }
      testCapture_ = std::move(candidate);
      testCaptureDevice_ = device;
    }
    json ok;
    ok["ok"] = true;
    server_->send(200, "application/json", ok.dump().c_str());
    return;
  }

  if (role == "playback") {
    if (device.empty()) {
      fail(400, "no playback device selected yet");
      return;
    }
    if (!testPlayback_ || testPlaybackDevice_ != device) {
      testPlayback_.reset();
      auto candidate = std::make_unique<AudioPlayback>(deviceName);
      std::string openError;
      if (!candidate->start(&openError)) {
        fail(400, openError);
        return;
      }
      testPlayback_ = std::move(candidate);
      testPlaybackDevice_ = device;
    }
    if (on) {
      // One second of an 800Hz tone, a moderate amplitude (not full-scale --
      // this plays out of a real speaker) -- push() itself never blocks
      // (see audio_bridge.h), miniaudio's own playback thread drains it in
      // real time, so this returns immediately regardless of the tone's
      // 1-second length.
      constexpr int kSampleRate = 8000;
      constexpr double kToneHz = 800.0;
      constexpr double kPi = 3.14159265358979323846;
      int16_t samples[kSampleRate];
      for (int i = 0; i < kSampleRate; i++) {
        samples[i] = (int16_t)(8000.0 * std::sin(2.0 * kPi * kToneHz * i / kSampleRate));
      }
      testPlayback_->push(samples, kSampleRate);
    } else {
      testPlayback_.reset();
      testPlaybackDevice_.clear();
    }
    json ok;
    ok["ok"] = true;
    server_->send(200, "application/json", ok.dump().c_str());
    return;
  }

  fail(400, "role must be \"capture\" or \"playback\"");
}

void WebUiServer::handleAudioLevel() {
  json result;
  if (!testCapture_) {
    result["active"] = false;
    result["level"] = 0;
    server_->send(200, "application/json", result.dump().c_str());
    return;
  }

  // Drains whatever has accumulated since the LAST poll (the wizard's own JS
  // polls this every ~150ms, see webui/index.html) -- peak of that window,
  // not a running average, so a brief loud moment (a CW dit, a voice peak)
  // still visibly moves the meter even if surrounded by silence.
  uint8_t buf[4096];
  size_t got = testCapture_->pull(buf, sizeof(buf));
  int16_t peak = 0;
  for (size_t i = 0; i < got; i++) {
    int16_t sample = ulawDecode(buf[i]);
    int16_t magnitude = sample < 0 ? (int16_t)(-sample) : sample;
    if (magnitude > peak) peak = magnitude;
  }
  result["active"] = true;
  result["level"] = (int)((peak / 32767.0) * 100.0);
  server_->send(200, "application/json", result.dump().c_str());
}

}  // namespace LocalTrx
