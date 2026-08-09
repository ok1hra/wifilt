#pragma once

// icom_lan_wire.h was split out of icomLanClient.h and includes <Arduino.h>,
// which the native harness had no answer for -- the CI-V client smokes stopped
// compiling at that split and nobody noticed, because a build script that is
// not in anyone's loop fails silently. Everything the ported wire code actually
// uses (millis, strlcpy, HEX, Serial) already lives in the WiFi stub, so this
// is a forwarding header rather than a second pile of fakes.
#include "WiFi.h"
