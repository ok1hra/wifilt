// Native stand-in for the ESP32 core's esp32-hal-log.h.
//
// The core files we reuse verbatim (WString.cpp, Print.cpp) call log_e() on
// allocation failure. The PC build has no ESP log subsystem; these become
// no-ops that still consume their arguments, so -Wunused never fires and the
// format strings stay type-checked by the compiler.
#pragma once

#include <stdio.h>

#define WIFILT_LOG_SINK(level, fmt, ...) \
  do { (void)sizeof(printf(fmt, ##__VA_ARGS__)); } while (0)

#define log_v(fmt, ...) WIFILT_LOG_SINK("V", fmt, ##__VA_ARGS__)
#define log_d(fmt, ...) WIFILT_LOG_SINK("D", fmt, ##__VA_ARGS__)
#define log_i(fmt, ...) WIFILT_LOG_SINK("I", fmt, ##__VA_ARGS__)
#define log_w(fmt, ...) WIFILT_LOG_SINK("W", fmt, ##__VA_ARGS__)
#define log_e(fmt, ...) WIFILT_LOG_SINK("E", fmt, ##__VA_ARGS__)
#define log_n(fmt, ...) WIFILT_LOG_SINK("N", fmt, ##__VA_ARGS__)

#define ARDUHAL_LOG_LEVEL_NONE    0
#define ARDUHAL_LOG_LEVEL_ERROR   1
#define ARDUHAL_LOG_LEVEL_WARN    2
#define ARDUHAL_LOG_LEVEL_INFO    3
#define ARDUHAL_LOG_LEVEL_DEBUG   4
#define ARDUHAL_LOG_LEVEL_VERBOSE 5
