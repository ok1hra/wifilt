// The ESP32 build pulls the real FreeRTOS kernel in here. The native build
// needs only five primitives -- task creation, the notify give/take pair and
// the critical-section pair -- which live in freertos_compat.h.
//
// This header exists so icomLanClient.h can keep its unmodified
// #include <freertos/FreeRTOS.h>, letting one source serve both targets.
#pragma once

#include "freertos_compat.h"
