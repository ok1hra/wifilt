// SHA-1 with mbedTLS's API shape, for the native build.
//
// The sketch needs SHA-1 in exactly one place: the RFC 6455 WebSocket
// handshake on ports 82 and 83, where the client key is hashed with the magic
// GUID. It reaches it two ways -- through its own SHA1Init/Update/Final
// wrappers (wifilt.ino:659-672) and by calling mbedtls_sha1() directly
// (wifilt.ino:7961) -- so both are provided.
//
// Pulling in a whole TLS library for one hash of a 60-byte string would be
// absurd, so this is a self-contained implementation. It is used for a protocol
// handshake, never for security.
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint32_t state[5];
  uint64_t bitCount;
  uint8_t  buffer[64];
  size_t   bufferLength;
} mbedtls_sha1_context;

void mbedtls_sha1_init(mbedtls_sha1_context *context);
void mbedtls_sha1_free(mbedtls_sha1_context *context);
void mbedtls_sha1_clone(mbedtls_sha1_context *destination,
                        const mbedtls_sha1_context *source);

int mbedtls_sha1_starts_ret(mbedtls_sha1_context *context);
int mbedtls_sha1_update_ret(mbedtls_sha1_context *context,
                            const unsigned char *input, size_t length);
int mbedtls_sha1_finish_ret(mbedtls_sha1_context *context,
                            unsigned char output[20]);

int mbedtls_sha1(const unsigned char *input, size_t length,
                 unsigned char output[20]);

#ifdef __cplusplus
}
#endif
