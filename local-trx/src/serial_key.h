// serial_key.h -- real DTR/RTS keying over libserialport (bod 6/7).
//
// The one thing everything upstream (keyer.h, key_runner.h's KeyLine,
// civ_router.h's 0x17/0x14-0x0C, trxnet_peer.h) was built and live-verified
// against a LoggingKeyLine stand-in for, since this dev machine was missing
// libserialport-dev until 2026-08-31's install. This is a second, independent
// serial adapter from hamlib_bridge.h's CAT port (bod 6) -- two physically
// separate USB-serial dongles per the original spec, never one shared port.
#pragma once

#include <string>

#include <libserialport.h>

#include "key_runner.h"

namespace LocalTrx {

class SerialKeyLine : public KeyLine {
 public:
  // keyLine/pttLine: "dtr" or "rts" (config.keying.keyLine/pttLine) -- exactly
  // one of each, the two lines on one physical adapter (bod 7: CW+FSK share
  // the "key" line, mode-exclusive; the other line is always PTT).
  SerialKeyLine(std::string port, int baud, std::string keyLine, std::string pttLine);
  ~SerialKeyLine() override;

  // sp_get_port_by_name() + sp_open() + sp_set_baudrate() (best-effort --
  // DTR/RTS toggling does not depend on the configured baud, but a port some
  // adapters refuse to open without a valid rate) + both lines deasserted.
  bool open(std::string *error);

  void setKey(bool down) override;
  void setPtt(bool on) override;

 private:
  void setLine(const std::string &line, bool on);

  std::string portName_;
  int baud_;
  std::string keyLine_;
  std::string pttLine_;
  struct sp_port *port_ = nullptr;
};

}  // namespace LocalTrx
