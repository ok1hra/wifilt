// The sketch includes <FS.h> and <LittleFS.h> separately, mirroring the ESP32
// core layout where LittleFS.h declares the filesystem instance on top of the
// generic FS API. Here both live in FS.h, so this is just the alias.
#pragma once

#include "FS.h"
