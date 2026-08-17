// Native stand-in for ESP-IDF's esp_wifi.h.
//
// The PC build never runs SoftAP mode -- APmode is forced false at startup and
// SETUP hides the whole WiFi step via caps.wifi -- so the one block that calls
// these (the WPA/WPA2 mixed-mode fixup for the captive portal) is unreachable.
// It still has to compile, which is all this header is for.
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef int esp_err_t;
#ifndef ESP_OK
  #define ESP_OK 0
#endif

typedef enum { WIFI_IF_STA = 0, WIFI_IF_AP = 1 } wifi_interface_t;

typedef enum {
  WIFI_AUTH_OPEN = 0,
  WIFI_AUTH_WEP,
  WIFI_AUTH_WPA_PSK,
  WIFI_AUTH_WPA2_PSK,
  WIFI_AUTH_WPA_WPA2_PSK,
  WIFI_AUTH_WPA2_ENTERPRISE,
  WIFI_AUTH_WPA3_PSK,
  WIFI_AUTH_WPA2_WPA3_PSK,
} wifi_auth_mode_t;

typedef struct {
  uint8_t          ssid[32];
  uint8_t          password[64];
  uint8_t          ssid_len;
  uint8_t          channel;
  wifi_auth_mode_t authmode;
  uint8_t          ssid_hidden;
  uint8_t          max_connection;
  uint16_t         beacon_interval;
} wifi_ap_config_t;

typedef struct {
  uint8_t ssid[32];
  uint8_t password[64];
  uint8_t channel;
} wifi_sta_config_t;

typedef union {
  wifi_ap_config_t  ap;
  wifi_sta_config_t sta;
} wifi_config_t;

static inline esp_err_t esp_wifi_get_config(wifi_interface_t iface, wifi_config_t *conf) {
  (void)iface;
  if (conf) *conf = wifi_config_t{};
  return ESP_OK;
}
static inline esp_err_t esp_wifi_set_config(wifi_interface_t iface, wifi_config_t *conf) {
  (void)iface; (void)conf; return ESP_OK;
}
static inline esp_err_t esp_wifi_stop(void) { return ESP_OK; }
static inline esp_err_t esp_wifi_start(void) { return ESP_OK; }

#ifdef __cplusplus
}
#endif
