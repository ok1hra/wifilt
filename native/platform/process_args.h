// The original argv, captured by main() so ESP.restart() can re-exec the
// binary with the same options the operator started it with.
#pragma once

void   nativeProcessArgvSet(int argc, char **argv);
char **nativeProcessArgv(void);
