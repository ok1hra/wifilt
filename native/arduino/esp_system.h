// Native stand-in for ESP-IDF's esp_system.h.
//
// The core's stdlib_noniso.c includes this header; the only thing the shared
// sources actually take from it is esp_random(), which wifilt.ino uses to seed
// WebSocket masking and session tokens.
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Backed by the OS CSPRNG on the PC build, not by the ESP32 RF noise source.
uint32_t esp_random(void);

#ifdef __cplusplus
}
#endif
