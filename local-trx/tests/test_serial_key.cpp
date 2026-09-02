// doctest coverage for serial_key.h -- structural only (open/configure/
// assign the lines), per docs/local-trx-implementace.md's own caveat: even a
// real port here cannot assert DTR/RTS *electrical* fidelity, only that
// libserialport accepts and applies the calls.
//
// NOT `socat` PTY pairs, despite the plan's Testy section naming them:
// discovered live 2026-08-31 that libserialport's sp_get_port_by_name()
// rejects /dev/pts/* outright (SP_ERR_ARG, before even trying to open it) --
// its Linux backend only recognises names matching real tty device patterns,
// PTYs are not one. sp_list_ports() below is what libserialport itself
// considers openable on this machine; each candidate is tried in turn and
// the test skips (does not fail) if none actually open -- this sandbox's
// /dev/ttyS0-3 exist as device nodes but return "Input/output error" with no
// real 8250 UART behind them, which is an environment gap, not a code bug.
// A real USB-serial adapter on a desk is what turns this from skip to pass.
#include "doctest.h"

#include <string>
#include <vector>

#include "../src/serial_key.h"

using namespace LocalTrx;

namespace {

std::vector<std::string> listCandidatePorts() {
  std::vector<std::string> names;
  struct sp_port **list = nullptr;
  if (sp_list_ports(&list) != SP_OK) return names;
  for (int i = 0; list[i]; i++) names.push_back(sp_get_port_name(list[i]));
  sp_free_port_list(list);
  return names;
}

}  // namespace

TEST_CASE("SerialKeyLine opens a real port and toggles DTR/RTS without crashing") {
  std::vector<std::string> candidates = listCandidatePorts();
  std::string opened;
  for (const auto &name : candidates) {
    SerialKeyLine probe(name, 1200, "dtr", "rts");
    std::string error;
    if (probe.open(&error)) {
      opened = name;
      break;   // destructor closes it before the real test below reopens it
    }
  }

  if (opened.empty()) {
    MESSAGE("no openable serial port in this environment (checked " << candidates.size()
            << " candidate(s)) -- skipping; needs a real USB-serial adapter");
    return;
  }

  SerialKeyLine line(opened, 1200, "dtr", "rts");
  std::string error;
  REQUIRE_MESSAGE(line.open(&error), error);
  line.setKey(true);
  line.setKey(false);
  line.setPtt(true);
  line.setPtt(false);
  // destructor runs at scope exit: deasserts both lines, closes, frees -- must not hang
}

TEST_CASE("SerialKeyLine.open() rejects an invalid keyLine/pttLine pair") {
  SerialKeyLine same("/dev/null", 1200, "dtr", "dtr");   // both lines the same -- invalid regardless of port
  std::string error;
  CHECK_FALSE(same.open(&error));
  CHECK_FALSE(error.empty());
}

TEST_CASE("SerialKeyLine.open() reports an error for an unknown port, does not crash") {
  SerialKeyLine line("/dev/this-port-does-not-exist-42", 1200, "dtr", "rts");
  std::string error;
  CHECK_FALSE(line.open(&error));
  CHECK_FALSE(error.empty());
  // setKey/setPtt on a never-opened line must be safe no-ops.
  line.setKey(true);
  line.setPtt(true);
}
