// civ_router.h -- CI-V opcode dispatch, transport-free (bod 11, category a).
//
// Takes a parsed CI-V frame body (everything between the two FE FE addr bytes
// and the trailing FD -- i.e. cmd byte + payload) and a RigBackend, returns
// the reply PAYLOAD (starting with the echoed command byte, ICOM convention)
// or "no reply" for anything not in category (a). Framing (FE FE <to><from>
// ... FD) and addressing are icom_lan_server.cpp's job, not this one's -- kept
// separate so this stays pure and doctest-able without a socket.
//
// Byte formats here are verified against wifilt.ino's OWN parsing (not just
// generic ICOM CI-V spec), since that is the actual client local-trx talks to:
//   - frequency: 5-byte LSB-first packed BCD, see decodeCivFrequencyBytes()
//     [wifilt.ino:1320] / buildSetFrequencyFrame() [wifilt.ino:1742] -- same
//     layout tools/icom-lan-fake-radio.py's bcd_from_hz() already proves works.
//   - mode: single byte, table matches decodeModeName() [wifilt.ino:1349].
//   - 0x14 gain levels: 2-byte value where byte0 is a plain 0-2 "hundreds"
//     digit and byte1 is packed BCD tens|units, see encodeCivLevel()
//     [wifilt.ino:5511] / decodeCivBcdBytes() [wifilt.ino:1330].
//   - 0x21 0x00 RIT: subcommand byte + 3-byte LSB-first packed BCD magnitude,
//     see decodeCivBcdBytesLsb() [wifilt.ino:6708] -- wifilt itself never
//     applies a sign to this value, so local-trx does not invent one either.
//   - 0x15 meters (fáze 7, bod 11 category b) share 0x14's own 2-byte level
//     encoding -- decodeCivBcdBytes() [wifilt.ino:6692-6699] applies the exact
//     same digit layout to both opcodes, verified by reading wifilt's own
//     parser rather than assumed from the generic ICOM spec.
//   - 0x11 (attenuator) and 0x16 0x47 (VOX) are single raw bytes, 0/nonzero
//     [wifilt.ino:6718-6729] -- no BCD involved.
#pragma once

#include <cstdint>
#include <vector>

#include "keying_backend.h"
#include "rig_backend.h"

namespace LocalTrx {

struct CivResult {
  bool answered = false;
  std::vector<uint8_t> payload;   // starts with the (echoed) command byte
};

// frame is cmd byte followed by its body (no FE FE/addr/FD -- see above).
//
// `keying` is nullable: 0x17 (CW message) and 0x14 0x0C (CW speed) fall back
// to "no reply" when it is null, the same degradation civ_router already
// applies to any other unmapped command -- a keying subsystem that has not
// been wired up yet is not a guess-worthy default.
CivResult dispatchCiv(const std::vector<uint8_t> &frame, RigBackend &rig,
                      KeyingBackend *keying = nullptr);

// ---- wire-format helpers, exposed for doctest --------------------------

void bcdFromHz(uint64_t hz, uint8_t out[5]);
uint64_t hzFromBcd(const uint8_t in[5]);

void encodeCivLevel(uint16_t value, uint8_t out[2]);
uint16_t decodeCivLevel(const uint8_t in[2]);

void encodeRitLsb3(uint32_t hz, uint8_t out[3]);
uint32_t decodeRitLsb3(const uint8_t in[3]);

// CI-V mode byte <-> table also used by hamlib_bridge.cpp's rmode_t mapping
// (bod 11 "Mode translace"). Returns -1 for a byte with no known name.
const char *civModeName(uint8_t modeByte);

}  // namespace LocalTrx
