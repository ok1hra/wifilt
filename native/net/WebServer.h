// Native stand-in for the ESP32 WebServer library.
//
// 59 route registrations and ~350 calls sit on top of this, but the API surface
// is only 16 methods -- send(), sendHeader() and on() are 90 % of it.
//
// THREE CONTRACTS THAT ARE NOT OBVIOUS FROM THE API and that the sketch depends
// on. All three were read out of the existing code, not assumed:
//
//  1. Every byte of every response goes through the protected virtual
//     _currentClientWrite(). DiagWebServer (wifilt.ino:316) overrides it to
//     record the peer and URI of slow responses, so bypassing it would silently
//     kill that diagnostic. _currentClient and _currentUri are protected for
//     the same reason.
//
//  2. setContentLength(n) followed by send(code, type, "") emits headers only,
//     with Content-Length: n and no body. handleFileFromSPIFFS
//     (wifilt.ino:2145) then takes client().fd() and writes the file straight
//     to the socket with non-blocking ::send(), so a multi-megabyte asset
//     cannot hold the loop and starve the radio's UDP keepalives. The server
//     must not append anything after the handler returns.
//
//  3. A POST body whose content type is not form-encoded is exposed as
//     arg("plain") -- the ESP32 convention, used at 18 call sites.
#pragma once

#include <functional>
#include <vector>

#include "Arduino.h"
#include "FS.h"
#include "WiFi.h"

typedef enum {
  HTTP_ANY,
  HTTP_GET,
  HTTP_HEAD,
  HTTP_POST,
  HTTP_PUT,
  HTTP_PATCH,
  HTTP_DELETE,
  HTTP_OPTIONS,
} HTTPMethod;

#define CONTENT_LENGTH_UNKNOWN ((size_t)-1)
#define CONTENT_LENGTH_NOT_SET ((size_t)-2)

// The sketch lowers this to 1000 ms before including the header
// (wifilt.ino:277) -- how long to wait for a request body before giving up.
#ifndef HTTP_MAX_DATA_WAIT
  #define HTTP_MAX_DATA_WAIT 5000
#endif

// Native-only: overrides the port the sketch hard-codes as DiagWebServer(80),
// so --port can move HTTP off 80 when binding it is not possible. Set before
// setup() runs. Note this moves HTTP only -- the two WebSocket servers keep
// their own ports (82, 83), which is what the browser expects.
void nativeSetHttpPort(uint16_t port);

class WebServer {
public:
  typedef std::function<void(void)> THandlerFunction;

  explicit WebServer(int port = 80);
  virtual ~WebServer();

  void begin();
  void begin(uint16_t port);
  void close();
  void stop();

  // Pumped from the sketch loop. Accepts every waiting connection, does ONE
  // non-blocking read pass per connection, and dispatches whatever requests
  // are complete. It must never wait: the same loop feeds the radio's TX
  // audio ring, and the previous implementation -- which blocked up to
  // HTTP_MAX_DATA_WAIT waiting for each request -- turned every speculative
  // browser socket (opened ahead of need, often never written to) into a
  // near-1-second loop stall and audible TX dropouts.
  void handleClient();

  void on(const String &uri, THandlerFunction handler);
  void on(const String &uri, HTTPMethod method, THandlerFunction handler);
  void onNotFound(THandlerFunction handler);

  // --- request ---
  const String &uri() const { return _currentUri; }
  HTTPMethod    method() const { return _currentMethod; }
  WiFiClient   &client() { return _currentClient; }

  String arg(const String &name) const;
  String arg(int index) const;
  String argName(int index) const;
  int    args() const;
  bool   hasArg(const String &name) const;

  void   collectHeaders(const char *headerKeys[], size_t count);
  String header(const String &name) const;
  String header(int index) const;
  bool   hasHeader(const String &name) const;

  // --- response ---
  void send(int code);
  void send(int code, const char *contentType, const String &content);
  void send(int code, const char *contentType, const char *content);
  void send(int code, const String &contentType, const String &content);

  void sendHeader(const String &name, const String &value, bool first = false);
  void setContentLength(size_t length);
  void sendContent(const String &content);
  void sendContent(const char *content, size_t length);

  size_t streamFile(fs::File &file, const String &contentType);

protected:
  // Every response byte funnels through here so subclasses can observe it.
  virtual size_t _currentClientWrite(const char *buffer, size_t length);

  WiFiClient _currentClient;
  String     _currentUri;
  HTTPMethod _currentMethod = HTTP_ANY;

private:
  struct Route {
    String           uri;
    HTTPMethod       method;
    THandlerFunction handler;
  };
  struct KeyValue {
    String key;
    String value;
  };
  // A connection whose request has not fully arrived yet. Kept across
  // handleClient() calls so the read can be resumed instead of waited for.
  struct Pending {
    WiFiClient client;
    String     buffer;
    uint32_t   deadline;
  };

  bool parseRequest(const String &raw, int headerEnd);
  void parseRequestLine(const String &line);
  void parseQuery(const String &query);
  void parseFormBody(const String &body);
  void dispatch();
  void sendResponseHeaders(int code, const String &contentType);
  void finishRequest();

  static String urlDecode(const String &text);
  static const char *statusText(int code);

  uint16_t              _port;
  WiFiServer            _server;
  std::vector<Pending>  _pending;
  std::vector<Route>    _routes;
  THandlerFunction      _notFound;
  std::vector<KeyValue> _args;
  std::vector<KeyValue> _headers;      // only the keys named by collectHeaders
  std::vector<String>   _collectedKeys;
  String                _responseHeaders;
  size_t                _contentLength = CONTENT_LENGTH_NOT_SET;
  bool                  _headersSent = false;
  bool                  _chunked = false;
};
