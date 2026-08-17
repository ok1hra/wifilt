// One place to hide the Winsock/BSD split.
//
// Everything above this header -- WiFiClient, WiFiServer, WiFiUDP, WebServer,
// the two hand-rolled WebSocket servers -- talks plain BSD sockets. The ESP32
// build already did: the audio task in icomLanClient.h runs on raw lwip
// sockets, which is why that code ports across nearly verbatim.
#pragma once

#ifdef _WIN32
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <windows.h>

  typedef int socklen_t;
  #define WIFILT_INVALID_SOCKET  INVALID_SOCKET
  #define WIFILT_CLOSE_SOCKET(s) closesocket(s)
  #define WIFILT_WOULD_BLOCK()   (WSAGetLastError() == WSAEWOULDBLOCK)
  typedef SOCKET wifilt_socket_t;

  // --- POSIX spellings the shared sources use -------------------------------
  //
  // Winsock has no MSG_DONTWAIT. Every socket in this project is already put in
  // non-blocking mode, so the flag is belt-and-braces on lwip too and zero is
  // exactly equivalent here. (Where the RESULT of a would-block matters, the
  // shared code goes through netSendNonBlocking() instead -- errno is the part
  // that genuinely differs, and a macro cannot paper over that.)
  #ifndef MSG_DONTWAIT
    #define MSG_DONTWAIT 0
  #endif

  #define F_GETFL    3
  #define F_SETFL    4
  #define O_NONBLOCK 0x0004

  // The audio task sets its raw socket non-blocking with fcntl. Winsock's
  // equivalent is ioctlsocket(FIONBIO), and there is no way to read the flag
  // back -- so F_GETFL reports the state this shim last set.
  inline int fcntl(wifilt_socket_t socket, int command, int argument = 0) {
    static int assumedFlags = 0;
    if (command == F_GETFL) return assumedFlags;
    if (command == F_SETFL) {
      u_long nonBlocking = (argument & O_NONBLOCK) ? 1 : 0;
      if (ioctlsocket(socket, FIONBIO, &nonBlocking) != 0) return -1;
      assumedFlags = argument;
      return 0;
    }
    return -1;
  }
#else
  #include <arpa/inet.h>
  #include <errno.h>
  #include <fcntl.h>
  #include <netdb.h>
  #include <netinet/in.h>
  #include <netinet/tcp.h>
  #include <sys/select.h>
  #include <sys/socket.h>
  #include <sys/types.h>
  #include <unistd.h>

  #define WIFILT_INVALID_SOCKET  (-1)
  #define WIFILT_CLOSE_SOCKET(s) ::close(s)
  #define WIFILT_WOULD_BLOCK()   (errno == EAGAIN || errno == EWOULDBLOCK)
  typedef int wifilt_socket_t;
#endif

// Winsock needs WSAStartup before any socket call and WSACleanup at exit; on
// POSIX both are no-ops. Called once from main().
bool nativeSocketsInit(void);
void nativeSocketsShutdown(void);

// Describes why the last socket call failed.
//
// strerror(errno) is wrong on Windows: Winsock reports through
// WSAGetLastError() and leaves errno holding whatever it held before, so a
// refused bind came out as "No such file or directory" -- a diagnostic that
// sends you looking for a missing file that was never involved. A misleading
// message costs more than no message at all.
const char *nativeSocketErrorText(void);

// True when the last socket error was "permission denied", which for a port
// below 1024 has a specific and actionable cause on each platform.
bool nativeSocketErrorWasPermission(void);

// True when the last socket error was "address already in use".
bool nativeSocketErrorWasInUse(void);

// Puts a socket into non-blocking mode. The sketch polls everything from its
// loop and must never block there -- that is the same constraint the box has.
bool nativeSocketSetNonBlocking(wifilt_socket_t socket, bool nonBlocking);

// Disables Nagle. The sketch calls setNoDelay() on every accepted connection
// because the WebSocket audio path is latency-sensitive.
bool nativeSocketSetNoDelay(wifilt_socket_t socket, bool noDelay);
