// SPDX-License-Identifier: GPL-3.0-or-later
// Port of ts480/protocol.py (ts-480-web-panel). See ts480_protocol.h.
#include "ts480_protocol.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <set>

#include "../third_party/json/json.hpp"

using nlohmann::json;

namespace LocalTrx {
namespace Ts480 {

namespace {

// Verification marks and history live in ts-480-web-panel's protocol.py and
// PROTOCOL.md; this table is a copy of KEYS there.
const std::vector<KeyDef> kKeys = {
    {"POWER", '0', "\xE2\x8F\xBB", "", ""},
    {"PF", '1', "PF", "", ""},
    {"ATT", '2', "ATT/PRE", "ANT 1/2", ""},
    {"AT", '3', "AT", "", ""},
    {"CH1", '4', "CH1", "REC", "1"},
    {"CH2", '5', "CH2", "REC", "2"},
    {"CH3", '6', "CH3", "REC", "3"},
    {"PWR", '7', "PWR", "TX MONI", "4"},
    {"MIC", '8', "MIC", "RF.G", "5"},
    {"KEY", '9', "KEY", "DELAY", "6"},
    {"NB", ':', "NB/T", "LEVEL", "7"},
    {"VOX", '<', "VOX", "GAIN", "8"},
    {"PROC", ';', "PROC", "LEVEL", "9"},
    {"MTR", '=', "MTR", "CLR", ""},
    {"AGC", '>', "AGC", "OFF", "0"},
    {"ENT", '?', "ENT", "", ""},
    {"DNL", '@', "DNL", "LEVEL", ""},
    {"NR", 'A', "NR", "LEVEL", ""},
    {"FIL", 'B', "FIL", "NAR", ""},
    {"BC", 'C', "BC", "CW.T", ""},
    {"FINE", 'D', "FINE", "STEP", ""},
    {"SCAN", 'E', "SCAN", "SG.SEL", ""},
    {"MODE", 'F', "MODE", "", ""},
    {"MENU", 'G', "MENU", "F.LOCK", ""},
    {"MHZ", 'H', "MHz", "M.STP", ""},
    {"ASB", 'I', "A=B", "SPLIT", ""},
    {"AB", 'J', "A/B", "M/V", ""},
    {"QMI", 'K', "QMI", "M.IN", ""},
    {"QMR", 'L', "QMR", "M>VFO", ""},
    {"CL", 'M', "CL", "", ""},
    {"RIT", 'N', "RIT", "", ""},
    {"XIT", 'O', "XIT", "", ""},
    {"DOWN", 'Q', "\xE2\x96\xBC", "TF-SET", ""},
    {"UP", 'P', "\xE2\x96\xB2", "TF-SET", ""},
};

// Bit n of the flag byte -> annunciator label (protocol.py FLAG_LABELS).
const std::map<char, std::vector<std::string>> kFlagLabels = {
    {'?', {"PRE", "ATT", "PROC", "VOX", "NB", "MHz", "FINE"}},
    {'@', {"QM\xE2\x98\x85", "\xE2\x98\x85", "ANT1", "ANT2", "MENU", "M.CH", "M.SCR"}},
    {'A', {"AGC", "OFF", "-F", "NAR", "2", "LOCK", "REC"}},
    {'B', {"B0?", "B1?", "NR2", "NR1", "BC2", "BC1", "DNL"}},
    {'C', {"T", "CT", "F.LOCK", "PC", "RIT", "XIT", "AUTO"}},
    {'D', {"A", "B", "M", "SPLIT", "\xE2\x96\xB8T", "\xE2\x97\x82R", "AT"}},
    {'E', {"\xE2\x97\x82" "1", "\xE2\x97\x82" "2", "\xE2\x97\x82" "3", "\xE2\x96\xB8" "1",
           "\xE2\x96\xB8" "2", "\xE2\x96\xB8" "3", "E6?"}},
    {'L', {"L0?", "L1?", "L2?", "L3?", "L4?", "L5?", "L6?"}},
};

int clampInt(int v, int lo, int hi) { return std::max(lo, std::min(hi, v)); }

std::string printfString(const char *format, unsigned value) {
  char buffer[16];
  std::snprintf(buffer, sizeof(buffer), format, value);
  return buffer;
}

int signedValue(unsigned v, int bits) {
  return (v & (1u << (bits - 1))) ? (int)v - (1 << bits) : (int)v;
}

// protocol.py _text(): printable ASCII as is, 0xA0..0xFF as latin-1 (UTF-8
// here, so the JSON stays valid), everything else '?'.
std::string displayText(const std::string &bytes) {
  std::string out;
  for (unsigned char ch : bytes) {
    if (ch >= 0x20 && ch < 0x7F) {
      out += (char)ch;
    } else if (ch >= 0xA0) {
      out += (char)(0xC0 | (ch >> 6));
      out += (char)(0x80 | (ch & 0x3F));
    } else {
      out += '?';
    }
  }
  return out;
}

// protocol.py _num(): decimal, else hex, else 0.
int parseNumber(const std::string &s) {
  if (s.empty()) return 0;
  char *end = nullptr;
  long v = std::strtol(s.c_str(), &end, 10);
  if (end && *end == '\0') return (int)v;
  v = std::strtol(s.c_str(), &end, 16);
  if (end && *end == '\0') return (int)v;
  return 0;
}

bool parseHex(const std::string &s, int *out) {
  if (s.empty()) return false;
  char *end = nullptr;
  long v = std::strtol(s.c_str(), &end, 16);
  if (!end || *end != '\0') return false;
  *out = (int)v;
  return true;
}

std::string hexBytes(const std::string &bytes) {
  std::string out;
  char buffer[4];
  for (size_t i = 0; i < bytes.size(); i++) {
    std::snprintf(buffer, sizeof(buffer), "%02x", (unsigned char)bytes[i]);
    if (i) out += ' ';
    out += buffer;
  }
  return out;
}

// Counts UTF-8 code points, so the decimal-point positions below work on
// characters the way Python indexes str, not on bytes.
std::vector<std::string> splitCharacters(const std::string &text) {
  std::vector<std::string> chars;
  for (size_t i = 0; i < text.size();) {
    unsigned char c = (unsigned char)text[i];
    size_t len = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : 4;
    chars.push_back(text.substr(i, len));
    i += len;
  }
  return chars;
}

// protocol.py _with_dots(): bit n of mask lights the dot in front of the
// last (n + base) characters.
std::string withDots(const std::string &text, uint8_t mask, int base) {
  std::vector<std::string> chars = splitCharacters(text);
  const int length = (int)chars.size();
  std::set<int> positions;
  for (int n = 0; n < 7; n++) {
    if (mask & (1 << n)) positions.insert(length - (n + base));
  }
  std::string out;
  for (int i = 0; i < length; i++) {
    if (i > 0 && positions.count(i)) out += '.';
    out += chars[i];
  }
  return out;
}

}  // namespace

const std::vector<KeyDef> &keys() { return kKeys; }

const KeyDef *findKey(const std::string &name) {
  for (const KeyDef &k : kKeys)
    if (name == k.name) return &k;
  return nullptr;
}

const KeyDef *findKeyByCode(char code) {
  for (const KeyDef &k : kKeys)
    if (k.code == code) return &k;
  return nullptr;
}

const KeyDef *findDigitKey(char digit) {
  for (const KeyDef &k : kKeys)
    if (k.digit[0] == digit && k.digit[1] == '\0') return &k;
  return nullptr;
}

std::string keyMsg(const KeyDef &key, char state) { return std::string{key.code, state, '\r'}; }

std::string vfoMsg(int delta) {
  return printfString("S%04X\r", (unsigned)clampInt(delta, -ENCODER_VFO_LIMIT, ENCODER_VFO_LIMIT) & 0xFFFF);
}
std::string multiMsg(int delta) {
  return printfString("T%02X\r", (unsigned)clampInt(delta, -ENCODER_SMALL_LIMIT, ENCODER_SMALL_LIMIT) & 0xFF);
}
std::string ritMsg(int delta) {
  return printfString("U%02X\r", (unsigned)clampInt(delta, -ENCODER_SMALL_LIMIT, ENCODER_SMALL_LIMIT) & 0xFF);
}
std::string volumeMsg(int value) { return printfString("V%02X\r", (unsigned)clampInt(value, 0, 0xFF)); }
std::string squelchMsg(int value) { return printfString("W%02X\r", (unsigned)clampInt(value, 0, 0xFF)); }
std::string ifshiftMsg(int value) { return printfString("X%04X\r", (unsigned)clampInt(value, 0, IFSHIFT_MAX)); }
std::string keepaliveMsg() { return std::string("\xFF\r", 2); }
std::string reconnectMsg() { return "02\r"; }

std::string decodePanelFrame(const std::string &frame) {
  if (frame == "\xFF") return "keepalive";
  if (frame.empty()) return "";
  const char c = frame[0];
  const std::string rest = frame.substr(1);
  int v = 0;
  if (c == 'S' && rest.size() == 4 && parseHex(rest, &v)) return "VFO " + printfString("%+d", (unsigned)signedValue((unsigned)v, 16));
  if (c == 'T' && rest.size() == 2 && parseHex(rest, &v)) return "MULTI " + printfString("%+d", (unsigned)signedValue((unsigned)v, 8));
  if (c == 'U' && rest.size() == 2 && parseHex(rest, &v)) return "RIT/XIT " + printfString("%+d", (unsigned)signedValue((unsigned)v, 8));
  if (c == 'V' && rest.size() == 2 && parseHex(rest, &v)) return "AF " + std::to_string(v);
  if (c == 'W' && rest.size() == 2 && parseHex(rest, &v)) return "SQL " + std::to_string(v);
  if (c == 'X' && rest.size() == 4 && parseHex(rest, &v)) return "IF-SHIFT " + printfString("%+d", (unsigned)(v - IFSHIFT_CENTER));
  if (rest.size() == 1) {
    if (const KeyDef *key = findKeyByCode(c)) {
      const char *state = rest == "0" ? "up" : rest == "1" ? "down" : rest == "2" ? "reconnect"
                          : rest == "3" ? "long" : rest == "4" ? "hold" : nullptr;
      return std::string("KEY ") + key->name + " " + (state ? state : rest);
    }
  }
  return "? " + hexBytes(frame);
}

std::vector<std::string> FrameReader::feed(const uint8_t *data, size_t length) {
  buffer_.append(reinterpret_cast<const char *>(data), length);
  std::vector<std::string> frames;
  for (;;) {
    size_t cr = buffer_.find('\r');
    if (cr == std::string::npos) break;
    std::string frame = buffer_.substr(0, cr);
    buffer_.erase(0, cr + 1);
    if (!frame.empty()) frames.push_back(std::move(frame));
  }
  if (buffer_.size() > 256) buffer_.clear();
  return frames;
}

std::string modeName(int code) {
  switch (code) {
    case 1: return "LSB";
    case 2: return "USB";
    case 3: return "CW";
    case 4: return "FM";
    case 5: return "AM";
    case 6: return "FSK";
    case 7: return "CW-R";
    case 9: return "FSK-R";
    default: return "?" + std::to_string(code);
  }
}

bool isVoiceMode(int code) { return code == 1 || code == 2 || code == 4 || code == 5; }

Action DisplayState::apply(const std::string &frame) {
  if (frame.empty()) return Action::None;
  if (frame == "\xFF") return Action::Keepalive;
  const char c = frame[0];
  const std::string body = frame.substr(1);
  const size_t n = body.size();

  if (c == 'O' && n == 0) return Action::Query;
  if (c == '0' && n == 1) {   // 00 off / 01 on / 02 on
    power = body != "0" ? 1 : 0;
    return Action::None;
  }
  if (c == ';' && n >= 7) {
    freqRaw = displayText(body.substr(0, 7));
  } else if (c == '<') {
    statusRaw = displayText(body.substr(0, 8));
    while (splitCharacters(statusRaw).size() < 8) statusRaw += ' ';
  } else if (c == '=' && n == 4) {
    meterMain = parseNumber(body.substr(0, 2));
    meterSub = parseNumber(body.substr(2));
  } else if (c == '>') {
    meterSel = displayText(body);
  } else if (c == 'F' && n >= 1) {
    for (size_t i = 0; i < 3 && i < n; i++) dots[i] = (uint8_t)body[i];
  } else if (kFlagLabels.count(c) && n == 1 && ((uint8_t)body[0] & 0x80)) {
    flags[c] = (uint8_t)body[0];
  } else if (c == ':') {
    menuNo = displayText(body);
  } else if (c == 'P') {
    menuEntry = displayText(body);
    int v = 0;
    menuItem = parseHex(menuEntry, &v) ? v : -1;
  } else if (c == '4' && n >= 1) {
    int v = 0;
    menuValue = parseHex(displayText(body), &v) ? v : -1;
  } else if (c == '2') {
    param = body == "0" ? std::string() : displayText(body);
  } else if (c == '6' && n == 1) {
    brightness = parseNumber(body);
  } else if (c == '7' && n == 1) {
    backlight = body == "1";
  } else if (c == '8' && n == 1) {
    lamp = parseNumber(body);
  } else if (c == '9' && n == 1) {
    modeCode = parseNumber(body);
  } else if (c == 'S' && n == 1) {
    error = displayText(body);
  } else if (c == 'Q' && n == 1) {
    const std::string t = displayText(body);
    model = t == "0" ? "RX only" : t == "1" ? "TWIN PWR" : t;
  } else {
    misc[c] = hexBytes(body);
  }
  return Action::None;
}

std::string DisplayState::freqText() const { return withDots(freqRaw, dots[0], 2); }
std::string DisplayState::statusText() const { return withDots(statusRaw, dots[1], 3); }

long long DisplayState::frequencyHz() const {
  std::string digits = freqRaw;
  std::replace(digits.begin(), digits.end(), ' ', '0');
  if (digits.size() != 7) return -1;
  for (char ch : digits)
    if (ch < '0' || ch > '9') return -1;
  return std::atoll(digits.c_str()) * 10;
}

std::vector<std::string> DisplayState::icons() const {
  std::set<std::string> set;   // UTF-8 byte order == code point order == Python sorted()
  for (const auto &entry : flags) {
    auto labels = kFlagLabels.find(entry.first);
    if (labels == kFlagLabels.end()) continue;
    for (int i = 0; i < 7; i++)
      if (entry.second & (1 << i)) set.insert(labels->second[i]);
  }
  return std::vector<std::string>(set.begin(), set.end());
}

std::string DisplayState::toJson() const {
  json j;
  j["power"] = power < 0 ? json(nullptr) : json(power == 1);
  j["freq"] = freqText();
  j["freq_raw"] = freqRaw;
  const long long hz = frequencyHz();
  j["freq_hz"] = hz < 0 ? json(nullptr) : json(hz);
  j["status"] = statusText();
  j["menu_no"] = menuNo;
  j["menu_entry"] = menuEntry;
  j["param"] = param;
  j["menu_item"] = menuItem < 0 ? json(nullptr) : json(menuItem);
  j["menu_value"] = menuValue < 0 ? json(nullptr) : json(menuValue);
  j["meter_main"] = meterMain;
  j["meter_sub"] = meterSub;
  j["meter_sel"] = meterSel;
  j["mode"] = modeCode < 0 ? std::string() : modeName(modeCode);
  j["mode_code"] = modeCode < 0 ? json(nullptr) : json(modeCode);
  j["lamp"] = lamp == 0 ? "off" : lamp == 1 ? "rx" : lamp == 2 ? "tx" : std::to_string(lamp);
  j["brightness"] = brightness;
  j["backlight"] = backlight;
  j["error"] = error;
  j["model"] = model;
  j["icons"] = icons();
  json flagsJson = json::object();
  for (const auto &entry : flags) flagsJson[std::string(1, entry.first)] = printfString("%02X", entry.second);
  j["flags"] = flagsJson;
  json miscJson = json::object();
  for (const auto &entry : misc) miscJson[std::string(1, entry.first)] = entry.second;
  j["misc"] = miscJson;
  // The radio can send any byte; a bad UTF-8 sequence must not throw here.
  return j.dump(-1, ' ', false, json::error_handler_t::replace);
}

}  // namespace Ts480
}  // namespace LocalTrx
