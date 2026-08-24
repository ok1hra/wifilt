// Which of the interface's capabilities physically exist on this build.
//
// One source serves two very different machines. The ESP32 box has a WiFi
// radio, a UART for CI-V and seven GPIOs; the PC binary has none of those and
// reaches radios purely over IP. Rather than scattering #ifdefs through 9000
// lines, the differences are named once here, and the browser is told about
// them through "platform" and "caps" in /setup-data.json so SETUP can hide what
// cannot work.
//
// WIFILT_NATIVE is defined by native/Makefile. The Arduino build never sets it,
// so the box keeps every capability and nothing about it changes.

#pragma once

#if defined(WIFILT_NATIVE)

  // Which operating system, not just "not the box". SETUP shows this as the
  // suffix in its title (WIFILT-LINUX, WIFILT-WINDOWS), so an operator with the
  // box and the desktop binary open side by side can tell the two pages apart.
  // The catch-all matters: a build on a platform nobody named here says
  // "native" rather than claiming to be Linux.
  #if defined(_WIN32)
    #define CAP_PLATFORM_NAME "windows"
  #elif defined(__APPLE__)
    #define CAP_PLATFORM_NAME "macos"
  #elif defined(__linux__)
    #define CAP_PLATFORM_NAME "linux"
  #else
    #define CAP_PLATFORM_NAME "native"
  #endif

  // No radio to provision. The operating system owns the network connection
  // long before this binary starts, so SoftAP, the captive portal (which would
  // need UDP 53 and root anyway) and network scanning are all meaningless.
  #define CAP_WIFI 0

  // No UART. CI-V over a wire stays a hardware-box feature -- but note that CAT
  // itself is very much alive: ICOM LAN carries CI-V over its own UDP channel,
  // so frequency, mode, GPS and the whole TX-gain chain work normally.
  #define CAP_CIV 0

  // No pins: CW and FSK keying, the 74HC595 band decoder, the status LED, the
  // radio power relay and the hardware-revision divider.
  #define CAP_GPIO 0

  #define CAP_BAND_DECODER 0

  // No status LED either -- the PC binary has no pin to drive. Named here only
  // so #if STATUS_LED_RGB is never an undefined macro.
  #define STATUS_LED_RGB 0

#else

  #define CAP_PLATFORM_NAME "esp32"
  #define CAP_WIFI          1
  #define CAP_CIV           1
  #define CAP_GPIO          1
  #define CAP_BAND_DECODER  1

  // Which status-LED indicator this board physically has. The RemoteQTH box and
  // a bare WROOM have a plain LED on GPIO 5 (StatusPin), driven directly or via
  // LEDC PWM for the AP fade. The M5Atom Lite has NO LED on GPIO 5 -- its only
  // indicator is a single addressable SK6812 RGB on GPIO 27. The status-LED HAL
  // in wifilt.ino renders the one LED vocabulary (HARDWARE.md §6) onto whichever
  // of the two this build has.
  #if defined(WIFILT_M5ATOM_LITE)
    #define STATUS_LED_RGB 1
    #define STATUS_LED_PIN 27
  #else
    #define STATUS_LED_RGB 0
  #endif

#endif
