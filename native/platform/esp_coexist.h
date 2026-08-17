// Native stand-in for ESP-IDF's WiFi/BT coexistence arbitration.
//
// On the ESP32 this shifts the radio's time budget when BT and WiFi fight for
// the same antenna. A PC has neither problem, so the two call sites become
// no-ops. Kept rather than #ifdef'd out of the sketch so the shared source
// stays identical for both targets.
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

typedef int esp_err_t;
#ifndef ESP_OK
  #define ESP_OK 0
#endif

typedef enum {
  ESP_COEX_PREFER_WIFI = 0,
  ESP_COEX_PREFER_BT,
  ESP_COEX_PREFER_BALANCE,
} esp_coex_prefer_t;

static inline esp_err_t esp_coex_preference_set(esp_coex_prefer_t prefer) {
  (void)prefer; return ESP_OK;
}

#ifdef __cplusplus
}
#endif
