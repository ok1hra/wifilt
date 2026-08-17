// Native stand-in for ESP-IDF's task watchdog.
//
// The ESP32 arms a 73 s watchdog with panic-reset so a wedged loop reboots the
// box. A PC daemon has no equivalent: the OS will not reboot the machine, and
// silently killing the process would lose the operator's session for no gain.
// A wedged loop on a PC is a bug to be debugged, not papered over, so these are
// no-ops and the seven esp_task_wdt_reset() call sites cost nothing.
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef int esp_err_t;
#ifndef ESP_OK
  #define ESP_OK 0
#endif

static inline esp_err_t esp_task_wdt_init(uint32_t timeoutSeconds, bool panic) {
  (void)timeoutSeconds; (void)panic; return ESP_OK;
}
static inline esp_err_t esp_task_wdt_add(void *handle) { (void)handle; return ESP_OK; }
static inline esp_err_t esp_task_wdt_reset(void) { return ESP_OK; }
static inline esp_err_t esp_task_wdt_delete(void *handle) { (void)handle; return ESP_OK; }

#ifdef __cplusplus
}
#endif
