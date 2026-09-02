// The original argv, captured by main() so ESP.restart() (wifilt) or
// local-trx's own equivalent can re-exec the binary with the same options
// the operator started it with.
#pragma once

void   nativeProcessArgvSet(int argc, char **argv);
char **nativeProcessArgv(void);

// Re-execs the current process image with the argv nativeProcessArgvSet()
// captured -- FD_CLOEXEC swept across every descriptor above stdio first, so
// listeners/serial ports/audio devices the OLD image had open do not leak
// into the new one and block its own fresh binds (see the .cpp for the full
// story; this was esp_compat.cpp's own EspClass::restart() body, pulled out
// here so local-trx's own restart-after-save can reuse the exact same,
// already-live-tested-on-real-hardware mechanism instead of a second
// implementation). Does not return on success. Returns false only when
// nativeProcessArgvSet() was never called, or the OS-level re-exec itself
// failed -- the caller decides what "nothing sane left to do" means for it
// (wifilt exits non-zero so a service manager can restart it instead).
bool nativeReexecSelf(void);
