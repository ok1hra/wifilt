#include "keyer.h"

#include <cctype>

namespace LocalTrx {

// ---- CW -------------------------------------------------------------------

namespace {

// International Morse, '.'=dit '-'=dah. Space itself is handled in encode()
// directly (word gap), not looked up here.
const char *morseFor(char ch) {
  switch (ch) {
    case 'A': return ".-";      case 'B': return "-...";    case 'C': return "-.-.";
    case 'D': return "-..";     case 'E': return ".";       case 'F': return "..-.";
    case 'G': return "--.";     case 'H': return "....";    case 'I': return "..";
    case 'J': return ".---";    case 'K': return "-.-";     case 'L': return ".-..";
    case 'M': return "--";      case 'N': return "-.";      case 'O': return "---";
    case 'P': return ".--.";    case 'Q': return "--.-";    case 'R': return ".-.";
    case 'S': return "...";     case 'T': return "-";       case 'U': return "..-";
    case 'V': return "...-";    case 'W': return ".--";     case 'X': return "-..-";
    case 'Y': return "-.--";    case 'Z': return "--..";
    case '0': return "-----";   case '1': return ".----";   case '2': return "..---";
    case '3': return "...--";   case '4': return "....-";   case '5': return ".....";
    case '6': return "-....";   case '7': return "--...";   case '8': return "---..";
    case '9': return "----.";
    case '.': return ".-.-.-";  case ',': return "--..--";  case '?': return "..--..";
    case '/': return "-..-.";   case '-': return "-....-";  case '=': return "-...-";
    default:  return nullptr;
  }
}

}  // namespace

CwEngine::CwEngine(int wpm) : wpm_(wpm) {}

void CwEngine::setWpm(int wpm) { wpm_ = wpm; }

uint32_t CwEngine::ditMs() const {
  if (wpm_ <= 0) return 60;   // never divide by zero; 60ms = 20 WPM's dit
  return (uint32_t)(1200 / wpm_);
}

std::vector<KeyEvent> CwEngine::encode(const std::string &text) const {
  std::vector<KeyEvent> events;
  const uint32_t dit = ditMs();
  bool pendingWordGap = false;

  for (char raw : text) {
    char ch = (char)std::toupper((unsigned char)raw);
    if (ch == ' ') {
      if (!events.empty()) pendingWordGap = true;   // collapses repeats; no leading/trailing gap
      continue;
    }
    const char *pattern = morseFor(ch);
    if (!pattern) continue;   // unknown character -- silently skipped, bod above

    if (!events.empty()) {
      events.push_back({false, pendingWordGap ? dit * 7 : dit * 3});
    }
    pendingWordGap = false;

    for (const char *sym = pattern; *sym; sym++) {
      events.push_back({true, *sym == '.' ? dit : dit * 3});
      if (sym[1] != '\0') events.push_back({false, dit});
    }
  }
  return events;
}

// ---- FSK (Baudot/ITA2) ------------------------------------------------------

namespace {

// Bit-for-bit port of wifilt.ino's chTable() [wifilt.ino:7799]. shift: -1 = no
// LETTERS/FIGURES requirement (space/CR/LF), 0 = LETTERS-only, 1 = FIGURES-only.
struct BaudotCode {
  bool d1, d2, d3, d4, d5;
  int shift;
};

BaudotCode lookupBaudot(char ch) {
  switch (ch) {
    case 'A': return {1,1,0,0,0, 0};   case 'B': return {1,0,0,1,1, 0};
    case 'C': return {0,1,1,1,0, 0};   case 'D': return {1,0,0,1,0, 0};
    case 'E': return {1,0,0,0,0, 0};   case 'F': return {1,0,1,1,0, 0};
    case 'G': return {0,1,0,1,1, 0};   case 'H': return {0,0,1,0,1, 0};
    case 'I': return {0,1,1,0,0, 0};   case 'J': return {1,1,0,1,0, 0};
    case 'K': return {1,1,1,1,0, 0};   case 'L': return {0,1,0,0,1, 0};
    case 'M': return {0,0,1,1,1, 0};   case 'N': return {0,0,1,1,0, 0};
    case 'O': return {0,0,0,1,1, 0};   case 'P': return {0,1,1,0,1, 0};
    case 'Q': return {1,1,1,0,1, 0};   case 'R': return {0,1,0,1,0, 0};
    case 'S': return {1,0,1,0,0, 0};   case 'T': return {0,0,0,0,1, 0};
    case 'U': return {1,1,1,0,0, 0};   case 'V': return {0,1,1,1,1, 0};
    case 'W': return {1,1,0,0,1, 0};   case 'X': return {1,0,1,1,1, 0};
    case 'Y': return {1,0,1,0,1, 0};   case 'Z': return {1,0,0,0,1, 0};
    case '0': return {0,1,1,0,1, 1};   case '1': return {1,1,1,0,1, 1};
    case '2': return {1,1,0,0,1, 1};   case '3': return {1,0,0,0,0, 1};
    case '4': return {0,1,0,1,0, 1};   case '5': return {0,0,0,0,1, 1};
    case '6': return {1,0,1,0,1, 1};   case '7': return {1,1,1,0,0, 1};
    case '8': return {0,1,1,0,0, 1};   case '9': return {0,0,0,1,1, 1};
    case '-': return {1,1,0,0,0, 1};   case '?': return {1,0,0,1,1, 1};
    case ':': return {0,1,1,1,0, 1};   case '(': return {1,1,1,1,0, 1};
    case ')': return {0,1,0,0,1, 1};   case '.': return {0,0,1,1,1, 1};
    case ',': return {0,0,1,1,0, 1};   case '/': return {1,0,1,1,1, 1};
    case '+': return {1,0,0,0,1, 1};   // ITA2, per wifilt.ino's own comment
    case '\n': return {0,1,0,0,0, -1}; case '\r': return {0,0,0,1,0, -1};
    default:   return {0,0,1,0,0, -1};   // space, and wifilt.ino's own fallback for anything else
  }
}

constexpr double kBaudRateFsk = 45.45;               // wifilt.ino:387, RTTY baud rate
constexpr double kStopBitWidths = 1.5;               // wifilt.ino:388
// wifilt.ino:391 computes this as `int OneBit = 1/BaudRateFSK*1000`, i.e.
// truncated by an int assignment, not rounded -- matched here on purpose.
constexpr uint32_t kOneBitMs = (uint32_t)(1.0 / kBaudRateFsk * 1000.0);

// One character's on-the-wire framing: start bit (space) + 5 data bits +
// stop bit (mark, 1.5 units) -- wifilt.ino's sendFsk() [wifilt.ino:7771].
void appendFskChar(std::vector<KeyEvent> &events, const BaudotCode &code) {
  events.push_back({false, kOneBitMs});          // start bit
  events.push_back({code.d1, kOneBitMs});
  events.push_back({code.d2, kOneBitMs});
  events.push_back({code.d3, kOneBitMs});
  events.push_back({code.d4, kOneBitMs});
  events.push_back({code.d5, kOneBitMs});
  events.push_back({true, (uint32_t)(kOneBitMs * kStopBitWidths)});   // stop bit
}

}  // namespace

FskEngine::FskEngine() = default;

std::vector<KeyEvent> FskEngine::encode(const std::string &text) {
  static const BaudotCode kFigsShift = {1, 1, 0, 1, 1, -1};
  static const BaudotCode kLtrsShift = {1, 1, 1, 1, 1, -1};

  std::vector<KeyEvent> events;
  for (char raw : text) {
    char ch = (char)std::toupper((unsigned char)raw);
    BaudotCode code = lookupBaudot(ch);
    // wifilt.ino's chTable() sets its `space` flag for ' ' and for the
    // "anything else" fallback, but NOT for \n/\r -- all three land on
    // shift==-1 here, so \n/\r are excluded by character identity instead,
    // exactly as chTable() itself does it.
    bool isSpaceLike = (code.shift == -1) && (ch != '\n') && (ch != '\r');

    if (lettersShift_ && code.shift == 1) {
      appendFskChar(events, kFigsShift);
    } else if (!lettersShift_ && code.shift == 0) {
      appendFskChar(events, kLtrsShift);
    } else if (afterSpace_ && code.shift == 1) {
      appendFskChar(events, kFigsShift);
    }

    if (code.shift == 0 || code.shift == 1) {
      afterSpace_ = false;
      lettersShift_ = (code.shift == 0);
    } else if (isSpaceLike) {
      afterSpace_ = true;
    }

    appendFskChar(events, code);
  }
  return events;
}

}  // namespace LocalTrx
