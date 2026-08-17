#include "WebServer.h"

#include <stdio.h>

namespace {
uint16_t g_httpPortOverride = 0;
}

void nativeSetHttpPort(uint16_t port) { g_httpPortOverride = port; }

WebServer::WebServer(int port)
    : _port((uint16_t)port), _server((uint16_t)port) {}

WebServer::~WebServer() { close(); }

void WebServer::begin() {
  if (g_httpPortOverride) _port = g_httpPortOverride;
  _server.begin(_port);
}

void WebServer::begin(uint16_t port) {
  _port = port;
  _server.begin(port);
}

void WebServer::close() { _server.end(); }
void WebServer::stop() { close(); }

void WebServer::on(const String &uri, THandlerFunction handler) {
  _routes.push_back({uri, HTTP_ANY, std::move(handler)});
}

void WebServer::on(const String &uri, HTTPMethod method, THandlerFunction handler) {
  _routes.push_back({uri, method, std::move(handler)});
}

void WebServer::onNotFound(THandlerFunction handler) {
  _notFound = std::move(handler);
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

void WebServer::handleClient() {
  if (!_currentClient) {
    _currentClient = _server.available();
    if (!_currentClient) return;
    _currentClient.setNoDelay(true);
  }

  if (readRequest()) dispatch();
  finishRequest();
}

bool WebServer::readRequest() {
  _args.clear();
  _headers.clear();
  _responseHeaders = "";
  _contentLength = CONTENT_LENGTH_NOT_SET;
  _headersSent = false;
  _chunked = false;
  _currentUri = "";
  _currentMethod = HTTP_ANY;

  // Sockets are non-blocking, so this spins with short sleeps until the request
  // is complete or the deadline passes. The bound is the sketch's own
  // HTTP_MAX_DATA_WAIT, lowered to 1000 ms at wifilt.ino:277.
  const uint32_t deadline = millis() + HTTP_MAX_DATA_WAIT;

  String head;
  int headerEnd = -1;
  while ((int32_t)(millis() - deadline) < 0) {
    uint8_t chunk[1024];
    int got = _currentClient.read(chunk, sizeof(chunk));
    if (got > 0) {
      head.concat((const char *)chunk, (size_t)got);
      headerEnd = head.indexOf("\r\n\r\n");
      if (headerEnd >= 0) break;
      continue;
    }
    if (got == 0 && !_currentClient.connected()) return false;
    delay(1);
  }
  if (headerEnd < 0) return false;

  const String headerBlock = head.substring(0, headerEnd);
  String       body = head.substring(headerEnd + 4);

  int lineEnd = headerBlock.indexOf("\r\n");
  parseRequestLine(lineEnd < 0 ? headerBlock : headerBlock.substring(0, lineEnd));

  // Walk the header lines once, picking up Content-Length/Content-Type plus
  // anything collectHeaders() asked for.
  size_t declaredLength = 0;
  String contentType;
  int    position = lineEnd < 0 ? headerBlock.length() : lineEnd + 2;
  while (position < (int)headerBlock.length()) {
    int end = headerBlock.indexOf("\r\n", position);
    if (end < 0) end = headerBlock.length();

    const String line = headerBlock.substring(position, end);
    position = end + 2;

    const int colon = line.indexOf(':');
    if (colon <= 0) continue;

    String name = line.substring(0, colon);
    String value = line.substring(colon + 1);
    value.trim();

    String lowered = name;
    lowered.toLowerCase();
    if (lowered == "content-length") declaredLength = (size_t)value.toInt();
    else if (lowered == "content-type") contentType = value;

    for (const String &wanted : _collectedKeys) {
      if (wanted.equalsIgnoreCase(name)) {
        _headers.push_back({name, value});
        break;
      }
    }
  }

  while (body.length() < declaredLength && (int32_t)(millis() - deadline) < 0) {
    uint8_t chunk[1024];
    int got = _currentClient.read(chunk, sizeof(chunk));
    if (got > 0) {
      body.concat((const char *)chunk, (size_t)got);
      continue;
    }
    if (got == 0 && !_currentClient.connected()) break;
    delay(1);
  }

  if (declaredLength > 0) {
    String lowered = contentType;
    lowered.toLowerCase();
    if (lowered.startsWith("application/x-www-form-urlencoded")) {
      parseFormBody(body);
    } else {
      // The ESP32 convention: any non-form body is reachable as arg("plain").
      _args.push_back({String("plain"), body});
    }
  }

  return true;
}

void WebServer::parseRequestLine(const String &line) {
  const int firstSpace = line.indexOf(' ');
  const int secondSpace = firstSpace < 0 ? -1 : line.indexOf(' ', firstSpace + 1);
  if (firstSpace < 0) return;

  const String verb = line.substring(0, firstSpace);
  if (verb == "GET") _currentMethod = HTTP_GET;
  else if (verb == "POST") _currentMethod = HTTP_POST;
  else if (verb == "OPTIONS") _currentMethod = HTTP_OPTIONS;
  else if (verb == "HEAD") _currentMethod = HTTP_HEAD;
  else if (verb == "PUT") _currentMethod = HTTP_PUT;
  else if (verb == "PATCH") _currentMethod = HTTP_PATCH;
  else if (verb == "DELETE") _currentMethod = HTTP_DELETE;
  else _currentMethod = HTTP_ANY;

  String target = secondSpace < 0 ? line.substring(firstSpace + 1)
                                  : line.substring(firstSpace + 1, secondSpace);

  const int question = target.indexOf('?');
  if (question >= 0) {
    parseQuery(target.substring(question + 1));
    target = target.substring(0, question);
  }
  _currentUri = urlDecode(target);
}

void WebServer::parseQuery(const String &query) {
  int position = 0;
  while (position < (int)query.length()) {
    int amp = query.indexOf('&', position);
    if (amp < 0) amp = query.length();

    const String pair = query.substring(position, amp);
    position = amp + 1;
    if (!pair.length()) continue;

    const int equals = pair.indexOf('=');
    if (equals < 0) _args.push_back({urlDecode(pair), String()});
    else
      _args.push_back({urlDecode(pair.substring(0, equals)),
                       urlDecode(pair.substring(equals + 1))});
  }
}

void WebServer::parseFormBody(const String &body) { parseQuery(body); }

void WebServer::dispatch() {
  for (const Route &route : _routes) {
    if (route.uri != _currentUri) continue;
    if (route.method != HTTP_ANY && route.method != _currentMethod) continue;
    route.handler();
    return;
  }
  if (_notFound) _notFound();
  else send(404, "text/plain", "Not found");
}

void WebServer::finishRequest() {
  // If a handler produced nothing at all, answer rather than leaving the
  // browser waiting for a response that will never come.
  if (!_headersSent) send(500, "text/plain", "");
  if (_chunked) _currentClientWrite("0\r\n\r\n", 5);

  _currentClient.stop();
  _currentClient = WiFiClient();
}

// ---------------------------------------------------------------------------
// Arguments and headers
// ---------------------------------------------------------------------------

String WebServer::arg(const String &name) const {
  for (const KeyValue &entry : _args)
    if (entry.key == name) return entry.value;
  return String();
}

String WebServer::arg(int index) const {
  if (index < 0 || index >= (int)_args.size()) return String();
  return _args[index].value;
}

String WebServer::argName(int index) const {
  if (index < 0 || index >= (int)_args.size()) return String();
  return _args[index].key;
}

int WebServer::args() const { return (int)_args.size(); }

bool WebServer::hasArg(const String &name) const {
  for (const KeyValue &entry : _args)
    if (entry.key == name) return true;
  return false;
}

void WebServer::collectHeaders(const char *headerKeys[], size_t count) {
  _collectedKeys.clear();
  for (size_t i = 0; i < count; i++)
    if (headerKeys[i]) _collectedKeys.push_back(String(headerKeys[i]));
}

String WebServer::header(const String &name) const {
  for (const KeyValue &entry : _headers)
    if (entry.key.equalsIgnoreCase(name)) return entry.value;
  return String();
}

String WebServer::header(int index) const {
  if (index < 0 || index >= (int)_headers.size()) return String();
  return _headers[index].value;
}

bool WebServer::hasHeader(const String &name) const {
  for (const KeyValue &entry : _headers)
    if (entry.key.equalsIgnoreCase(name)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

void WebServer::sendHeader(const String &name, const String &value, bool first) {
  const String line = name + ": " + value + "\r\n";
  if (first) _responseHeaders = line + _responseHeaders;
  else _responseHeaders += line;
}

void WebServer::setContentLength(size_t length) { _contentLength = length; }

void WebServer::sendResponseHeaders(int code, const String &contentType) {
  if (_headersSent) return;
  _headersSent = true;

  String head = "HTTP/1.1 ";
  head += code;
  head += ' ';
  head += statusText(code);
  head += "\r\n";

  if (contentType.length()) {
    head += "Content-Type: ";
    head += contentType;
    head += "\r\n";
  }

  if (_contentLength == CONTENT_LENGTH_UNKNOWN) {
    _chunked = true;
    head += "Transfer-Encoding: chunked\r\n";
  } else if (_contentLength != CONTENT_LENGTH_NOT_SET) {
    head += "Content-Length: ";
    head += (uint32_t)_contentLength;
    head += "\r\n";
  }

  head += _responseHeaders;

  // The sketch sets "Connection: close" itself on the static-file path; adding
  // it unconditionally would duplicate the header there.
  if (_responseHeaders.indexOf("Connection:") < 0)
    head += "Connection: close\r\n";

  head += "\r\n";
  _currentClientWrite(head.c_str(), head.length());
}

void WebServer::send(int code) { send(code, "", String()); }

void WebServer::send(int code, const char *contentType, const String &content) {
  // A caller that already declared the length wants headers only -- see
  // contract 2 in the header. Otherwise the body length is the content length.
  if (_contentLength == CONTENT_LENGTH_NOT_SET) _contentLength = content.length();

  sendResponseHeaders(code, String(contentType ? contentType : ""));
  if (content.length()) _currentClientWrite(content.c_str(), content.length());
}

void WebServer::send(int code, const char *contentType, const char *content) {
  send(code, contentType, String(content ? content : ""));
}

void WebServer::send(int code, const String &contentType, const String &content) {
  send(code, contentType.c_str(), content);
}

void WebServer::sendContent(const String &content) {
  sendContent(content.c_str(), content.length());
}

void WebServer::sendContent(const char *content, size_t length) {
  if (!content || !length) return;
  if (_chunked) {
    char prefix[16];
    const int prefixLength = snprintf(prefix, sizeof(prefix), "%x\r\n", (unsigned)length);
    _currentClientWrite(prefix, (size_t)prefixLength);
    _currentClientWrite(content, length);
    _currentClientWrite("\r\n", 2);
    return;
  }
  _currentClientWrite(content, length);
}

size_t WebServer::streamFile(fs::File &file, const String &contentType) {
  if (!file) return 0;

  setContentLength(file.size());
  sendResponseHeaders(200, contentType);

  size_t total = 0;
  uint8_t buffer[2048];
  while (true) {
    const size_t got = file.read(buffer, sizeof(buffer));
    if (!got) break;
    total += _currentClientWrite((const char *)buffer, got);
  }
  return total;
}

size_t WebServer::_currentClientWrite(const char *buffer, size_t length) {
  if (!buffer || !length) return 0;
  return _currentClient.write((const uint8_t *)buffer, length);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

String WebServer::urlDecode(const String &text) {
  String out;
  out.reserve(text.length());

  for (unsigned int i = 0; i < text.length(); i++) {
    const char c = text[i];
    if (c == '+') {
      out += ' ';
    } else if (c == '%' && i + 2 < text.length()) {
      const char high = text[i + 1];
      const char low = text[i + 2];
      auto nibble = [](char value) -> int {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        if (value >= 'A' && value <= 'F') return value - 'A' + 10;
        return -1;
      };
      const int hi = nibble(high);
      const int lo = nibble(low);
      if (hi >= 0 && lo >= 0) {
        out += (char)((hi << 4) | lo);
        i += 2;
        continue;
      }
      out += c;
    } else {
      out += c;
    }
  }
  return out;
}

const char *WebServer::statusText(int code) {
  switch (code) {
    case 200: return "OK";
    case 204: return "No Content";
    case 302: return "Found";
    case 304: return "Not Modified";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 409: return "Conflict";
    case 413: return "Payload Too Large";
    case 429: return "Too Many Requests";
    case 500: return "Internal Server Error";
    case 503: return "Service Unavailable";
    default:  return code < 400 ? "OK" : "Error";
  }
}
