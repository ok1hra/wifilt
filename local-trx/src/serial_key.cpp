#include "serial_key.h"

namespace LocalTrx {

namespace {

// sp_last_error_message() is only meaningful right after a call that
// returned SP_ERR_FAIL -- calling it otherwise is undefined per
// libserialport.h's own doc comment, so every caller here checks the
// specific return code first.
std::string lastErrorText() {
  char *msg = sp_last_error_message();
  std::string text = msg ? msg : "unknown error";
  if (msg) sp_free_error_message(msg);
  return text;
}

}  // namespace

SerialKeyLine::SerialKeyLine(std::string port, int baud, std::string keyLine, std::string pttLine)
    : portName_(std::move(port)), baud_(baud), keyLine_(std::move(keyLine)), pttLine_(std::move(pttLine)) {}

SerialKeyLine::~SerialKeyLine() {
  if (port_) {
    sp_set_dtr(port_, SP_DTR_OFF);
    sp_set_rts(port_, SP_RTS_OFF);
    sp_close(port_);
    sp_free_port(port_);
  }
}

bool SerialKeyLine::open(std::string *error) {
  if ((keyLine_ != "dtr" && keyLine_ != "rts") || (pttLine_ != "dtr" && pttLine_ != "rts") ||
      keyLine_ == pttLine_) {
    if (error) {
      *error = "keying.keyLine/pttLine must be \"dtr\"+\"rts\" (one each), got \"" + keyLine_ +
               "\"/\"" + pttLine_ + "\"";
    }
    return false;
  }

  sp_port *port = nullptr;
  enum sp_return rc = sp_get_port_by_name(portName_.c_str(), &port);
  if (rc != SP_OK) {
    if (error) {
      *error = "unknown serial port \"" + portName_ + "\"" +
               (rc == SP_ERR_FAIL ? ": " + lastErrorText() : "");
    }
    return false;
  }

  rc = sp_open(port, SP_MODE_READ_WRITE);
  if (rc != SP_OK) {
    if (error) {
      *error = "cannot open " + portName_ + (rc == SP_ERR_FAIL ? ": " + lastErrorText() : "");
    }
    sp_free_port(port);
    return false;
  }

  // Best-effort: some adapters need a valid rate to accept the open at all,
  // but DTR/RTS toggling itself has nothing to do with the data baud rate --
  // a failure here does not stop the keying lines from working.
  sp_set_baudrate(port, baud_);

  port_ = port;
  sp_set_dtr(port_, SP_DTR_OFF);
  sp_set_rts(port_, SP_RTS_OFF);
  return true;
}

void SerialKeyLine::setLine(const std::string &line, bool on) {
  if (!port_) return;
  if (line == "dtr") {
    sp_set_dtr(port_, on ? SP_DTR_ON : SP_DTR_OFF);
  } else if (line == "rts") {
    sp_set_rts(port_, on ? SP_RTS_ON : SP_RTS_OFF);
  }
}

void SerialKeyLine::setKey(bool down) { setLine(keyLine_, down); }
void SerialKeyLine::setPtt(bool on) { setLine(pttLine_, on); }

}  // namespace LocalTrx
