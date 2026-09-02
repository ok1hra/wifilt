// keyer.h -- CW and FSK message encoders, transport-free (bod 7/8/9).
//
// Both engines turn a text message into a sequence of KeyEvent (level +
// duration) transitions. Neither one touches a real pin or wall-clock time --
// that is serial_key.h's job (a dedicated high-priority thread walking this
// sequence against a real DTR/RTS line, bod 9). Kept separate so the actual
// encoding logic is doctest-able with no hardware, exactly like civ_router.h.
//
// KeyEvent.level: true = key down (CW dit/dah tone, or FSK "mark"), false =
// key up (CW inter-element/character/word gap, or FSK "space"/start bit).
// The LAST event in a returned sequence is always level=true (the final
// dit/dah, or the FSK stop bit) -- releasing the key afterward is the
// runner's job, not the encoder's, so every sequence is unambiguous on its
// own without a synthetic trailing zero-length release.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace LocalTrx {

struct KeyEvent {
  bool level;
  uint32_t ms;

  friend bool operator==(const KeyEvent &a, const KeyEvent &b) {
    return a.level == b.level && a.ms == b.ms;
  }
  friend bool operator!=(const KeyEvent &a, const KeyEvent &b) { return !(a == b); }
};

// ---- CW -----------------------------------------------------------------
//
// wifilt.ino has no CW bit-banging engine to port from: CW always goes out
// as an ASCII CI-V message (0x17) to the connected radio's OWN internal
// keyer (bod 7's table, wifilt.ino:7677) -- local-trx has no such radio
// behind it, so this is new logic, not a port. Standard international Morse
// + the textbook PARIS timing convention: dit = 1200/wpm ms, dah = 3 dits,
// intra-character gap = 1 dit, inter-character gap = 3 dits, word gap = 7
// dits (bod 9: dedicated high-priority thread is what actually walks this
// against a real clock; this class only computes durations).
class CwEngine {
 public:
  explicit CwEngine(int wpm = 20);

  void setWpm(int wpm);
  int wpm() const { return wpm_; }
  uint32_t ditMs() const;   // exposed for doctest, and for civ_router's 0x14 0x0C reply

  // Case-insensitive. Unknown characters (no Morse mapping) are silently
  // skipped -- the caller decides whether that is worth logging. Multiple
  // consecutive spaces collapse into a single word gap, and a leading/
  // trailing space contributes no gap at all (nothing to space from/to).
  std::vector<KeyEvent> encode(const std::string &text) const;

 private:
  int wpm_;
};

// ---- FSK (Baudot / ITA2) --------------------------------------------------
//
// Ported algorithm, not reinvented: character table and the LETTERS/FIGURES
// shift state machine (including its "re-assert FIGS after a space" quirk)
// come from wifilt.ino's chTable()/sendFsk() [wifilt.ino:7799 / 7771] byte-
// for-byte. Baud rate and stop-bit width are wifilt.ino's own constants
// [wifilt.ino:387-388] -- 45.45 Bd is not configurable there either, so it
// is not a constructor parameter here.
class FskEngine {
 public:
  FskEngine();

  // Case-insensitive (chTable() only matches uppercase). Resets neither the
  // LETTERS/FIGURES shift state nor the post-space flag between calls --
  // exactly like wifilt.ino's globals, which persist across sendCW() calls
  // within one transmission's character loop.
  std::vector<KeyEvent> encode(const std::string &text);

 private:
  bool lettersShift_ = true;   // wifilt.ino's `fig1`; false constructs to LETTERS there too
  bool afterSpace_ = false;    // wifilt.ino's `space`
};

}  // namespace LocalTrx
