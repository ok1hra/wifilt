// ws_frame.h -- the bits of RFC 6455 the TS-480 panel's WebSocket needs:
// handshake accept key and frame (de)coding. Separate from ts480_ws.cpp so
// the unit tests need no sockets.
#pragma once

#include <cstddef>
#include <string>

namespace LocalTrx {

constexpr size_t kWsMaxPayload = 65536;

namespace Ws {
// Sec-WebSocket-Accept for a Sec-WebSocket-Key (RFC 6455 section 4.2.2).
std::string acceptKey(const std::string &clientKey);
// One frame off the front of `buffer`: 1 = complete (opcode/payload set,
// `consumed` bytes used), 0 = need more bytes, -1 = protocol error.
int parseFrame(const std::string &buffer, int *opcode, std::string *payload, size_t *consumed);
// An unmasked server frame.
std::string buildFrame(int opcode, const std::string &payload);
}  // namespace Ws

}  // namespace LocalTrx
