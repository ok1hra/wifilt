// One translation unit generates miniaudio's actual implementation (the
// amalgamated .h is declarations-only otherwise) -- same one-impl-file
// pattern as doctest's DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN.
#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"
