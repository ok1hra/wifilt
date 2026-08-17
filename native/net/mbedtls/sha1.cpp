#include "sha1.h"

#include <string.h>

namespace {

inline uint32_t rotateLeft(uint32_t value, int bits) {
  return (value << bits) | (value >> (32 - bits));
}

void transform(uint32_t state[5], const uint8_t block[64]) {
  uint32_t w[80];

  for (int i = 0; i < 16; i++) {
    w[i] = ((uint32_t)block[i * 4] << 24) | ((uint32_t)block[i * 4 + 1] << 16) |
           ((uint32_t)block[i * 4 + 2] << 8) | (uint32_t)block[i * 4 + 3];
  }
  for (int i = 16; i < 80; i++) {
    w[i] = rotateLeft(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
  }

  uint32_t a = state[0], b = state[1], c = state[2], d = state[3], e = state[4];

  for (int i = 0; i < 80; i++) {
    uint32_t f, k;
    if (i < 20)      { f = (b & c) | ((~b) & d);        k = 0x5A827999; }
    else if (i < 40) { f = b ^ c ^ d;                   k = 0x6ED9EBA1; }
    else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
    else             { f = b ^ c ^ d;                   k = 0xCA62C1D6; }

    const uint32_t temp = rotateLeft(a, 5) + f + e + k + w[i];
    e = d;
    d = c;
    c = rotateLeft(b, 30);
    b = a;
    a = temp;
  }

  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
}

}  // namespace

void mbedtls_sha1_init(mbedtls_sha1_context *context) {
  if (context) memset(context, 0, sizeof(*context));
}

void mbedtls_sha1_free(mbedtls_sha1_context *context) {
  if (context) memset(context, 0, sizeof(*context));
}

void mbedtls_sha1_clone(mbedtls_sha1_context *destination,
                        const mbedtls_sha1_context *source) {
  if (destination && source) *destination = *source;
}

int mbedtls_sha1_starts_ret(mbedtls_sha1_context *context) {
  if (!context) return -1;
  context->state[0] = 0x67452301;
  context->state[1] = 0xEFCDAB89;
  context->state[2] = 0x98BADCFE;
  context->state[3] = 0x10325476;
  context->state[4] = 0xC3D2E1F0;
  context->bitCount = 0;
  context->bufferLength = 0;
  return 0;
}

int mbedtls_sha1_update_ret(mbedtls_sha1_context *context,
                            const unsigned char *input, size_t length) {
  if (!context || (!input && length)) return -1;

  context->bitCount += (uint64_t)length * 8;

  while (length > 0) {
    const size_t room = 64 - context->bufferLength;
    const size_t take = length < room ? length : room;

    memcpy(context->buffer + context->bufferLength, input, take);
    context->bufferLength += take;
    input += take;
    length -= take;

    if (context->bufferLength == 64) {
      transform(context->state, context->buffer);
      context->bufferLength = 0;
    }
  }
  return 0;
}

int mbedtls_sha1_finish_ret(mbedtls_sha1_context *context,
                            unsigned char output[20]) {
  if (!context || !output) return -1;

  const uint64_t bits = context->bitCount;

  uint8_t padding = 0x80;
  mbedtls_sha1_update_ret(context, &padding, 1);
  context->bitCount = bits;   // padding must not count toward the length

  padding = 0x00;
  while (context->bufferLength != 56) {
    mbedtls_sha1_update_ret(context, &padding, 1);
    context->bitCount = bits;
  }

  uint8_t lengthBytes[8];
  for (int i = 0; i < 8; i++) lengthBytes[i] = (uint8_t)(bits >> (56 - i * 8));
  mbedtls_sha1_update_ret(context, lengthBytes, 8);

  for (int i = 0; i < 5; i++) {
    output[i * 4]     = (uint8_t)(context->state[i] >> 24);
    output[i * 4 + 1] = (uint8_t)(context->state[i] >> 16);
    output[i * 4 + 2] = (uint8_t)(context->state[i] >> 8);
    output[i * 4 + 3] = (uint8_t)(context->state[i]);
  }
  return 0;
}

int mbedtls_sha1(const unsigned char *input, size_t length,
                 unsigned char output[20]) {
  mbedtls_sha1_context context;
  mbedtls_sha1_init(&context);
  mbedtls_sha1_starts_ret(&context);
  mbedtls_sha1_update_ret(&context, input, length);
  const int result = mbedtls_sha1_finish_ret(&context, output);
  mbedtls_sha1_free(&context);
  return result;
}
