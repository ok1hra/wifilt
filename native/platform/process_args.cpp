#include "process_args.h"

namespace {
char **savedArgv = nullptr;
}

void nativeProcessArgvSet(int, char **argv) { savedArgv = argv; }

char **nativeProcessArgv(void) { return savedArgv; }
