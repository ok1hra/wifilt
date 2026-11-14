// SPDX-License-Identifier: GPL-3.0-or-later
// See ws_frame.h.
#include "ws_frame.h"

#include "mbedtls/sha1.h"

namespace LocalTrx {

namespace {

std::string base64(const unsigned char *data, size_t length) {
  static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (size_t i = 0; i < length; i += 3) {
    unsigned v = (unsigned)data[i] << 16;
    if (i + 1 < length) v |= (unsigned)data[i + 1] << 8;
    if (i + 2 < length) v |= data[i + 2];
    out += table[(v >> 18) & 63];
    out += table[(v >> 12) & 63];
    out += i + 1 < length ? table[(v >> 6) & 63] : '=';
    out += i + 2 < length ? table[v & 63] : '=';
  }
  return out;
}

}  // namespace

namespace Ws {

std::string acceptKey(const std::string &clientKey) {
  const std::string source = clientKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  unsigned char digest[20];
  mbedtls_sha1(reinterpret_cast<const unsigned char *>(source.data()), source.size(), digest);
  return base64(digest, sizeof(digest));
}

int parseFrame(const std::string &buffer, int *opcode, std::string *payload, size_t *consumed) {
  if (buffer.size() < 2) return 0;
  const uint8_t b0 = (uint8_t)buffer[0], b1 = (uint8_t)buffer[1];
  if (b0 & 0x70) return -1;   // RSV bits: no extensions negotiated
  size_t pos = 2;
  uint64_t length = b1 & 0x7F;
  if (length == 126) {
    if (buffer.size() < 4) return 0;
    length = ((uint64_t)(uint8_t)buffer[2] << 8) | (uint8_t)buffer[3];
    pos = 4;
  } else if (length == 127) {
    if (buffer.size() < 10) return 0;
    length = 0;
    for (int i = 0; i < 8; i++) length = (length << 8) | (uint8_t)buffer[2 + i];
    pos = 10;
  }
  if (length > kWsMaxPayload) return -1;
  const bool masked = (b1 & 0x80) != 0;
  uint8_t mask[4] = {0, 0, 0, 0};
  if (masked) {
    if (buffer.size() < pos + 4) return 0;
    for (int i = 0; i < 4; i++) mask[i] = (uint8_t)buffer[pos + i];
    pos += 4;
  }
  if (buffer.size() < pos + length) return 0;
  payload->assign(buffer, pos, (size_t)length);
  if (masked) {
    for (size_t i = 0; i < payload->size(); i++) (*payload)[i] = (char)((uint8_t)(*payload)[i] ^ mask[i & 3]);
  }
  *opcode = b0 & 0x0F;
  *consumed = pos + (size_t)length;
  return 1;
}

std::string buildFrame(int opcode, const std::string &payload) {
  std::string frame;
  frame += (char)(0x80 | (opcode & 0x0F));
  const size_t n = payload.size();
  if (n < 126) {
    frame += (char)n;
  } else if (n <= 0xFFFF) {
    frame += (char)126;
    frame += (char)(n >> 8);
    frame += (char)(n & 0xFF);
  } else {
    frame += (char)127;
    for (int i = 7; i >= 0; i--) frame += (char)(((uint64_t)n >> (8 * i)) & 0xFF);
  }
  return frame + payload;
}

}  // namespace Ws

}  // namespace LocalTrx
