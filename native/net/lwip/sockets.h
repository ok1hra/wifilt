// The sketch includes <lwip/sockets.h> to get select() for polling whether the
// audio WebSocket is writable without blocking the loop (wifilt.ino:280).
// On the native build that is just the host's BSD/Winsock headers.
#pragma once

#include "socket_compat.h"
