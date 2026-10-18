#pragma once

// The UDP socket, the task and the playout timer around rkey_server.h (the
// Paddle2IP remote CW key). Sketch only, included after the socket headers;
// the ESP32 and the PC build share it, only the box has a KEY pin.
//
// Why a task of its own and not loop(): loop() can stall for seconds (a slow
// web request, a flash write), and an edge that waits that long arrives "late"
// and shifts the over -- or, worse, a key-down outlives its link. The task
// blocks in select() and timestamps every datagram the moment it arrives; the
// GPIO edges are then played by an esp_timer every 0.5 ms, which also releases
// the key on a dead link without help from anybody.
//
// loop() keeps the two jobs that need the radio link (rkeyLoop() in the
// sketch): publishing the radio's mode/frequency into the server, and sending
// the decoded text as CI-V 0x17.

// A spinlock on the ESP32 (the playout timer runs on the other core), a mutex
// on the PC.
static portMUX_TYPE rkeyMux = portMUX_INITIALIZER_UNLOCKED;
#define RKEY_LOCK()   portENTER_CRITICAL(&rkeyMux)
#define RKEY_UNLOCK() portEXIT_CRITICAL(&rkeyMux)
#include "rkey_server.h"
#if !defined(WIFILT_NATIVE)
  #include <esp_timer.h>
#endif

// Heap, not .bss: a station that never uses the paddle pays nothing for it.
static RkeyServer  *rkey = nullptr;
static const char  *rkeyNetError = "";      // shown in SETUP: why nothing listens
static uint16_t     rkeyNetPort = 0;

#if !defined(WIFILT_NATIVE)
static esp_timer_handle_t rkeyPlayTimer = nullptr;
static bool               rkeyPlayRunning = false;   // touched by the rkey task only
static void rkeyPlayTimerCb(void *) { rkeyPlayTick(*rkey, micros()); }
#endif

static void rkeyNetClose(int fd) {
#ifdef _WIN32
  closesocket(fd);
#else
  close(fd);
#endif
}

static void rkeyTaskMain(void *) {
  RkeyServer &s = *rkey;
  int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (fd >= 0) {
    // No SO_REUSEADDR, unlike the radio sockets: two listeners on one UDP port
    // would split the paddle's packets between them, and that has to fail
    // loudly here rather than as a mystery of lost edges.
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    sockaddr_in local = {};
    local.sin_family = AF_INET;
    local.sin_port = htons(rkeyNetPort);
    local.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(fd, reinterpret_cast<sockaddr*>(&local), sizeof(local)) < 0) {
      rkeyNetClose(fd);
      fd = -1;
      rkeyNetError = "UDP port in use";
    }
  } else {
    rkeyNetError = "no socket";
  }
  if (fd < 0) {
    Serial.print("RKEY| listen FAILED on UDP "); Serial.print(rkeyNetPort);
    Serial.print(": "); Serial.println(rkeyNetError);
    vTaskDelete(nullptr);
    return;
  }
  Serial.print("RKEY| listening on UDP "); Serial.print(rkeyNetPort);
  Serial.println(s.output == RKEY_OUT_GPIO ? " -> KEY output" : " -> radio keyer (CI-V text)");

  // One byte over the largest valid packet: anything that fills it is too long.
  uint8_t buf[sizeof(RkeyKeyHdr) + 4 * RKEY_MAX_EV + RKEY_TAG_LEN + 1];
  uint8_t reply[sizeof(RkeyStatus) + RKEY_TAG_LEN];
  for (;;) {
    fd_set rd;
    FD_ZERO(&rd);
    FD_SET(fd, &rd);
    timeval tv = {0, 5000};
    select(fd + 1, &rd, nullptr, nullptr, &tv);
    for (uint8_t k = 0; k < 8; k++) {               // bounded work per wake-up
      sockaddr_in from = {};
      socklen_t fromLen = sizeof(from);
      int n = recvfrom(fd, reinterpret_cast<char*>(buf), sizeof(buf), 0,
                       reinterpret_cast<sockaddr*>(&from), &fromLen);
      if (n <= 0) break;
      uint32_t arrive = micros();
      if (n >= (int)sizeof(buf)) continue;
      uint16_t r = rkeyOnPacket(s, buf, (uint16_t)n, arrive, from.sin_addr.s_addr,
                                ntohs(from.sin_port), reply);
      if (r) sendto(fd, reinterpret_cast<const char*>(reply), r, 0,
                    reinterpret_cast<sockaddr*>(&from), sizeof(from));
    }
    uint32_t now = micros();
    rkeyService(s, now);
#if !defined(WIFILT_NATIVE)
    // The playout timer runs while there is anything to play or a paddle is
    // talking, and sleeps otherwise: 2000 wake-ups a second for nothing would
    // only take time from the WiFi stack on the other core.
    if (rkeyPlayTimer) {
      bool idle = rkeyPlayIdle(s);
      if (!rkeyPlayRunning && !idle) {
        rkeyPlayRunning = esp_timer_start_periodic(rkeyPlayTimer, 500) == ESP_OK;
      } else if (rkeyPlayRunning && idle && (now - s.lastPktUs) > 5000000UL) {
        esp_timer_stop(rkeyPlayTimer);
        rkeyPlayRunning = false;
      }
    }
#endif
  }
}

// Called once from setup(), after the network is up. keyOut = null: no KEY pin.
static bool rkeyNetBegin(const uint8_t key[16], bool keySet, uint8_t output, uint16_t port,
                         uint16_t delayMs, void (*keyOut)(bool)) {
  rkey = new (std::nothrow) RkeyServer;
  if (!rkey) { rkeyNetError = "out of memory"; return false; }
  rkeyInit(*rkey);
  rkey->enabled = true;
  rkey->output  = output;
  memcpy(rkey->key, key, 16);
  rkey->keySet  = keySet;
  rkey->delayMs = delayMs;
  rkey->keyOut  = output == RKEY_OUT_GPIO ? keyOut : nullptr;
  rkey->rand32  = esp_random;
  rkeyNetPort = port;
  if (!keySet) { rkeyNetError = "no shared key"; return false; }
  if (output == RKEY_OUT_GPIO && !keyOut) { rkeyNetError = "no KEY output on this build"; return false; }
#if !defined(WIFILT_NATIVE)
  if (output == RKEY_OUT_GPIO) {
    esp_timer_create_args_t args = {};
    args.callback = rkeyPlayTimerCb;
    args.name = "rkey-play";
    if (esp_timer_create(&args, &rkeyPlayTimer) != ESP_OK) { rkeyNetError = "no playout timer"; return false; }
  }
#else
  (void)&rkeyPlayTick;                      // the PC has no KEY pin to play to
#endif
  TaskHandle_t task = nullptr;
  if (xTaskCreatePinnedToCore(rkeyTaskMain, "rkey", 4096, nullptr, 4, &task,
                              ARDUINO_RUNNING_CORE) != pdPASS) {
    rkeyNetError = "no task";
    return false;
  }
  return true;
}
