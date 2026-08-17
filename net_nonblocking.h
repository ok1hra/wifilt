// One meaning for "send what fits, never block", across lwip and Winsock.
//
// Two hot paths write straight to a socket descriptor instead of going through
// WiFiClient: the static-asset streamer (a multi-megabyte modem asset must not
// hold the loop and starve the radio's UDP keepalives) and the audio WebSocket
// drain. Both were written as ::send(..., MSG_DONTWAIT) followed by an errno
// test -- which is correct on lwip and quietly wrong on Winsock, where socket
// errors go to WSAGetLastError() and errno keeps whatever it held before.
//
// Getting that wrong is not cosmetic: audioDrainWs() treats "not a would-block
// error" as "the peer is gone" and drops the WebSocket, so on Windows a merely
// full send buffer would kill the audio stream.
//
// Include AFTER the platform's socket headers (lwip/sockets.h on the ESP32,
// socket_compat.h natively).
#pragma once

#include <stddef.h>

#if defined(_WIN32)
  #include <winsock2.h>
#else
  #include <errno.h>
#endif

// Returns:
//   > 0  bytes handed to the kernel (may be fewer than asked for)
//     0  would block -- the send buffer is full, retry on the next tick
//   < 0  fatal -- the peer is gone or the socket is broken
inline int netSendNonBlocking(int fd, const void *data, size_t length) {
#if defined(_WIN32)
  // Winsock has no MSG_DONTWAIT; the socket is already in non-blocking mode
  // (ioctlsocket FIONBIO), which gives the same behaviour.
  int sent = ::send((SOCKET)fd, (const char *)data, (int)length, 0);
  if (sent > 0) return sent;
  if (sent < 0 && WSAGetLastError() == WSAEWOULDBLOCK) return 0;
  return -1;
#else
  int sent = ::send(fd, data, length, MSG_DONTWAIT);
  if (sent > 0) return sent;
  // ENOMEM is lwip's way of saying "no pbufs right now", which is a retry, not
  // a failure -- dropping the connection on it was a real source of stalls.
  if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == ENOMEM))
    return 0;
  return -1;
#endif
}
