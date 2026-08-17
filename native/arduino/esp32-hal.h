// Native (Linux/Windows) stand-in for the ESP32 core's esp32-hal.h.
//
// Only the timing primitives live here, separately from Arduino.h, because the
// core's Stream.cpp includes this header directly. Keeping it standalone avoids
// a circular include between Arduino.h and the core files we reuse verbatim.
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

unsigned long millis(void);
unsigned long micros(void);
void delay(uint32_t ms);
void delayMicroseconds(uint32_t us);

// On the ESP32 this yields to other FreeRTOS tasks. The PC build runs the
// sketch loop on its own thread with real threads elsewhere, so there is
// nothing to hand control to -- but a bare spin would burn a core, so this
// sleeps for a scheduler tick.
void yield(void);

#ifdef __cplusplus
}
#endif
