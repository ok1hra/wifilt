// SPDX-License-Identifier: GPL-3.0-or-later
// ts480_protocol.h -- Kenwood TS-480 control-panel <-> main-unit serial
// protocol (RJ12 panel cable, 5 V TTL UART, 57600 8N2). NOT CAT: the radio
// sends LCD segments and icons, the panel sends key codes, encoder counts and
// potentiometer positions.
//
// C++ port of ts480/protocol.py from the ts-480-web-panel project (GPL-3.0,
// itself based on the reverse engineering at
// https://github.com/stianeklund/TS-480-Panel). The JSON from
// DisplayState::toJson() has the same fields as the Python to_dict(), so the
// browser renderer (webui/ts480/lcd.js) is a straight port too.
//
// Framing: <command byte><data>\r. Flag bytes always have bit 7 set, so CR
// never appears inside data.
#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace LocalTrx {
namespace Ts480 {

constexpr char KEY_UP = '0', KEY_DOWN = '1', KEY_LONG = '3', KEY_HOLD = '4';

struct KeyDef {
  const char *name;    // id used by the browser ("NB", "POWER", ...)
  char code;           // single ASCII char on the wire
  const char *label;   // primary label on the panel
  const char *alt;     // long-press / secondary function
  const char *digit;   // digit in ENT (direct frequency entry) mode, "" if none
};

const std::vector<KeyDef> &keys();
const KeyDef *findKey(const std::string &name);
const KeyDef *findKeyByCode(char code);
const KeyDef *findDigitKey(char digit);

// Panel -> radio frames, CR included.
std::string keyMsg(const KeyDef &key, char state);
std::string vfoMsg(int delta);      // S%04X, signed 16-bit
std::string multiMsg(int delta);    // T%02X, signed 8-bit
std::string ritMsg(int delta);      // U%02X, signed 8-bit
std::string volumeMsg(int value);   // V%02X, 0..255
std::string squelchMsg(int value);  // W%02X, 0..255
std::string ifshiftMsg(int value);  // X%04X, 0..0x3FE
std::string keepaliveMsg();         // FF CR
std::string reconnectMsg();         // "02" CR: radio answers with its power state and a full redraw

constexpr int IFSHIFT_MAX = 0x3FE;
constexpr int IFSHIFT_CENTER = 0x1FF;
constexpr int ENCODER_VFO_LIMIT = 0x7FFF;
constexpr int ENCODER_SMALL_LIMIT = 0x7F;

// Human readable description of a panel -> radio frame (without CR), for logs.
std::string decodePanelFrame(const std::string &frame);

// Splits a byte stream on CR. Empty frames are dropped; more than 256 bytes
// without a CR is garbage and is thrown away.
class FrameReader {
 public:
  std::vector<std::string> feed(const uint8_t *data, size_t length);
  std::vector<std::string> feed(const std::string &data) {
    return feed(reinterpret_cast<const uint8_t *>(data.data()), data.size());
  }

 private:
  std::string buffer_;
};

enum class Action { None, Keepalive, Query };

// CAT MD code -> name ("9n" carries the same digit).
std::string modeName(int code);
// SSB/AM/FM: the modes the browser microphone may transmit in.
bool isVoiceMode(int code);

// Mirror of everything the radio asked the panel to show.
struct DisplayState {
  int power = -1;                    // -1 unknown, 0 off, 1 on
  std::string freqRaw = "       ";   // 7 chars, 10 Hz units
  std::string statusRaw = "        ";
  uint8_t dots[3] = {0x80, 0x80, 0x80};
  std::string menuNo = "  ";
  std::string menuEntry;
  int menuItem = -1;                 // "Pnn", hex
  int menuValue = -1;                // "4hh", hex (same as CAT EX)
  std::string param;                 // "2x" sub-display mode
  int meterMain = 0;                 // 0..20
  int meterSub = 0;                  // 0..10
  std::string meterSel;
  int modeCode = -1;
  int lamp = 0;                      // 0 off, 1 rx, 2 tx
  int brightness = 4;
  bool backlight = true;
  std::string error = "0";
  std::string model;
  std::map<char, uint8_t> flags = {{'?', 0x80}, {'@', 0x80}, {'A', 0x80}, {'B', 0x80},
                                   {'C', 0x80}, {'D', 0x80}, {'E', 0x80}, {'L', 0x80}};
  std::map<char, std::string> misc;  // unmapped commands, hex

  // Applies one radio -> panel frame (without CR) and says what the link
  // layer has to answer.
  Action apply(const std::string &frame);

  std::string freqText() const;      // with decimal points, e.g. "28.066.97"
  std::string statusText() const;
  long long frequencyHz() const;     // -1 when the digits are not a number
  std::vector<std::string> icons() const;
  std::string toJson() const;        // same fields as protocol.py's to_dict()
};

}  // namespace Ts480
}  // namespace LocalTrx
