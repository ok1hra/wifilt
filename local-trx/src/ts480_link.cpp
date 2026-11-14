// SPDX-License-Identifier: GPL-3.0-or-later
// Port of ts480/link.py (ts-480-web-panel). See ts480_link.h.
#include "ts480_link.h"

#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <vector>

#include <libserialport.h>

#include "../third_party/json/json.hpp"

using nlohmann::json;

namespace LocalTrx {

namespace {

std::string serialErrorText() {
  char *msg = sp_last_error_message();
  std::string text = msg ? msg : "unknown error";
  if (msg) sp_free_error_message(msg);
  return text;
}

int64_t toMs(Ts480Link::Clock::time_point t) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(t.time_since_epoch()).count();
}

std::chrono::milliseconds ms(int v) { return std::chrono::milliseconds(v); }

std::string printable(const std::string &frame) {
  std::string out;
  for (unsigned char c : frame) out += (c >= 0x20 && c < 0x7F) ? (char)c : '.';
  return out;
}

}  // namespace

// ---- serial transport ------------------------------------------------------

bool SerialTs480Transport::open(std::string *error) {
  close();
  sp_port *port = nullptr;
  enum sp_return rc = sp_get_port_by_name(portName_.c_str(), &port);
  if (rc != SP_OK) {
    if (error) *error = "unknown serial port \"" + portName_ + "\"" + (rc == SP_ERR_FAIL ? ": " + serialErrorText() : "");
    return false;
  }
  rc = sp_open(port, SP_MODE_READ_WRITE);
  if (rc != SP_OK) {
    if (error) *error = "cannot open " + portName_ + (rc == SP_ERR_FAIL ? ": " + serialErrorText() : "");
    sp_free_port(port);
    return false;
  }
  sp_set_baudrate(port, 57600);
  sp_set_bits(port, 8);
  sp_set_parity(port, SP_PARITY_NONE);
  sp_set_stopbits(port, 2);   // the old working network bridge for this radio used 8N2
  sp_set_flowcontrol(port, SP_FLOWCONTROL_NONE);
  sp_set_dtr(port, SP_DTR_OFF);
  sp_set_rts(port, SP_RTS_OFF);
  port_ = port;
  return true;
}

void SerialTs480Transport::close() {
  if (!port_) return;
  sp_close(port_);
  sp_free_port(port_);
  port_ = nullptr;
}

int SerialTs480Transport::read(uint8_t *buffer, size_t size, int timeoutMs) {
  if (!port_) return -1;
  // Wait for the first byte, then take whatever else is already there.
  int got = sp_blocking_read_next(port_, buffer, size, (unsigned)timeoutMs);
  if (got < 0) return -1;
  return got;
}

bool SerialTs480Transport::write(const std::string &data) {
  if (!port_) return false;
  int sent = sp_blocking_write(port_, data.data(), data.size(), 200);
  return sent == (int)data.size();
}

// ---- link ------------------------------------------------------------------

Ts480Link::Ts480Link(std::unique_ptr<Ts480Transport> transport, Ts480LinkOptions options)
    : transport_(std::move(transport)), options_(std::move(options)) {
  // What ts480-state.json already says -- no write until the radio reports
  // something different.
  powerPersisted_ = options_.restorePower ? 1 : 0;
}

Ts480Link::~Ts480Link() { stop(); }

void Ts480Link::start() {
  if (thread_.joinable()) return;
  stop_ = false;
  thread_ = std::thread([this]() { run(); });
}

void Ts480Link::stop() {
  stop_ = true;
  if (thread_.joinable()) thread_.join();
  transport_->close();
  portOpen_ = false;
}

void Ts480Link::run() {
  while (!stop_) iterate(Clock::now(), 20);
}

void Ts480Link::send(const std::string &data) {
  std::lock_guard<std::mutex> lock(writeMutex_);
  if (!transport_->isOpen()) return;
  if (!transport_->write(data)) {
    std::fprintf(stderr, "ts480: write to %s failed\n", transport_->describe().c_str());
    return;
  }
  if (options_.verbose) {
    for (const std::string &f : Ts480::FrameReader().feed(data)) {
      if (f == "\xFF") continue;
      std::printf("[ts480] tx %-10s %s\n", printable(f).c_str(), Ts480::decodePanelFrame(f).c_str());
    }
    std::fflush(stdout);
  }
}

void Ts480Link::iterate(Clock::time_point now, int readTimeoutMs) {
  if (!transport_->isOpen()) {
    if (now >= nextOpenTry_) {
      std::string error;
      bool ok;
      {
        std::lock_guard<std::mutex> lock(writeMutex_);
        ok = transport_->open(&error);
      }
      if (ok) {
        portOpen_ = true;
        lastOpenError_.clear();
        std::printf("local-trx: TS-480 panel link on %s\n", transport_->describe().c_str());
        std::fflush(stdout);
        send(Ts480::reconnectMsg());   // ask the radio for its power state and a full redraw
        lastReconnect_ = now;
        lastKeepalive_ = now;
        if (options_.restorePower && !openedOnce_) {
          restorePending_ = true;
          restoreAt_ = now + ms(kRestoreFirstMs);
        }
        openedOnce_ = true;
        dirty_ = true;
      } else {
        if (error != lastOpenError_) {
          std::fprintf(stderr, "warning: TS-480 panel port unavailable (%s) -- retrying every 3 s\n",
                       error.c_str());
          lastOpenError_ = error;
        }
        nextOpenTry_ = now + ms(3000);
      }
    }
    if (!transport_->isOpen()) {
      if (readTimeoutMs > 0) std::this_thread::sleep_for(ms(readTimeoutMs));
      timers(now);
      return;
    }
  }

  uint8_t buffer[256];
  const int got = transport_->read(buffer, sizeof(buffer), readTimeoutMs);
  if (got < 0) {
    std::fprintf(stderr, "warning: TS-480 panel port %s failed -- reopening\n", transport_->describe().c_str());
    {
      std::lock_guard<std::mutex> lock(writeMutex_);
      transport_->close();
    }
    portOpen_ = false;
    nextOpenTry_ = now + ms(1000);
    dirty_ = true;
    return;
  }
  if (got > 0) {
    for (const std::string &frame : reader_.feed(buffer, (size_t)got)) onFrame(frame, now);
  }
  timers(now);
}

void Ts480Link::onFrame(const std::string &frame, Clock::time_point now) {
  lastRxMs_ = toMs(now);
  Ts480::Action action;
  std::string reply;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    action = state_.apply(frame);
    if (action == Ts480::Action::Query) {
      reply = Ts480::ifshiftMsg(ifshift_) + Ts480::volumeMsg(af_) + Ts480::squelchMsg(sql_) +
              Ts480::keepaliveMsg();
    }
    if (state_.power != powerSeen_) {
      powerSeen_ = state_.power;
      powerChangedAt_ = now;
    }
  }
  if (action == Ts480::Action::Keepalive) {
    send(Ts480::keepaliveMsg());   // within the radio's 4 s, always
    return;
  }
  if (options_.verbose) {
    std::printf("[ts480] rx %-10s %s\n", printable(frame).c_str(), action == Ts480::Action::Query ? "query" : "");
    std::fflush(stdout);
  }
  if (!reply.empty()) send(reply);
  dirty_ = true;
}

void Ts480Link::timers(Clock::time_point now) {
  std::vector<std::string> out;
  bool persist = false, persistOn = false;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const bool linkAlive = toMs(now) - lastRxMs_.load() < kLinkTimeoutMs;

    if (transport_->isOpen() && now - lastKeepalive_ >= ms(kKeepaliveMs)) {
      lastKeepalive_ = now;
      out.push_back(Ts480::keepaliveMsg());
      if (!linkAlive && now - lastReconnect_ > ms(kReconnectMs)) {
        lastReconnect_ = now;
        out.push_back(Ts480::reconnectMsg());
      }
      dirty_ = true;   // refreshes the "connected" indicator
    }

    if (now - lastFlush_ >= ms(kEncoderFlushMs)) {
      lastFlush_ = now;
      static const int limits[3] = {Ts480::ENCODER_VFO_LIMIT, Ts480::ENCODER_SMALL_LIMIT, Ts480::ENCODER_SMALL_LIMIT};
      for (int i = 0; i < 3; i++) {
        if (!acc_[i]) continue;
        const int part = std::max(-limits[i], std::min(limits[i], acc_[i]));
        acc_[i] -= part;
        out.push_back(i == 0 ? Ts480::vfoMsg(part) : i == 1 ? Ts480::multiMsg(part) : Ts480::ritMsg(part));
      }
    }

    for (auto &entry : held_) {
      if (!entry.second.longSent && now >= entry.second.longAt) {
        entry.second.longSent = true;
        if (const Ts480::KeyDef *key = Ts480::findKey(entry.first)) out.push_back(Ts480::keyMsg(*key, Ts480::KEY_LONG));
      }
    }

    while (!macro_.empty() && macro_.front().first <= now) {
      out.push_back(macro_.front().second);
      macro_.pop_front();
    }

    if (restorePending_ && now >= restoreAt_) {
      if (state_.power == 1) {
        restorePending_ = false;
        std::printf("local-trx: TS-480 was on before the restart and still is\n");
      } else if (restoreAttempts_ < kRestoreAttempts) {
        restoreAttempts_++;
        restoreAt_ = now + ms(kRestoreRetryMs);
        out.push_back(Ts480::keyMsg(*Ts480::findKey("POWER"), Ts480::KEY_DOWN));   // "01" = on
        std::printf("local-trx: TS-480 was on before the restart -- switching it on (try %d)\n", restoreAttempts_);
      } else {
        restorePending_ = false;
        std::fprintf(stderr, "warning: TS-480 did not come on after %d tries -- leaving it\n", kRestoreAttempts);
      }
      std::fflush(stdout);
    }

    if (!restorePending_ && powerSeen_ >= 0 && powerSeen_ != powerPersisted_ &&
        now - powerChangedAt_ >= ms(kPersistAfterMs)) {
      powerPersisted_ = powerSeen_;
      persist = true;
      persistOn = powerSeen_ == 1;
    }
  }
  for (const std::string &frame : out) send(frame);
  if (persist && options_.persistPower) options_.persistPower(persistOn);
}

void Ts480Link::keyDown(const std::string &name) {
  const Ts480::KeyDef *key = Ts480::findKey(name);
  if (!key) return;
  std::string frame;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (name == "POWER") {
      // VERIFIED (link.py): "01" switches the radio on, "00" off -- not a
      // press/release pair. The operator's own choice ends any restore.
      restorePending_ = false;
      frame = Ts480::keyMsg(*key, state_.power == 1 ? Ts480::KEY_UP : Ts480::KEY_DOWN);
    } else {
      if (held_.count(name)) return;
      held_[name] = Held{Clock::now() + ms(kLongPressMs), false};
      frame = Ts480::keyMsg(*key, Ts480::KEY_DOWN);
    }
  }
  send(frame);
}

void Ts480Link::keyUp(const std::string &name) {
  const Ts480::KeyDef *key = Ts480::findKey(name);
  if (!key) return;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = held_.find(name);
    if (it == held_.end()) return;
    held_.erase(it);
  }
  send(Ts480::keyMsg(*key, Ts480::KEY_UP));
}

void Ts480Link::encoder(const std::string &which, int delta) {
  const int index = which == "vfo" ? 0 : which == "multi" ? 1 : which == "rit" ? 2 : -1;
  if (index < 0) return;
  std::lock_guard<std::mutex> lock(mutex_);
  acc_[index] += delta;
  // A runaway accumulation (browser stuck) must not spin the VFO for minutes.
  const int cap = index == 0 ? 20 * Ts480::ENCODER_VFO_LIMIT : 20 * Ts480::ENCODER_SMALL_LIMIT;
  acc_[index] = std::max(-cap, std::min(cap, acc_[index]));
}

void Ts480Link::setPot(const std::string &which, int value) {
  std::string frame;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (which == "af") {
      af_ = std::max(0, std::min(255, value));
      frame = Ts480::volumeMsg(af_);
    } else if (which == "sql") {
      sql_ = std::max(0, std::min(255, value));
      frame = Ts480::squelchMsg(sql_);
    } else if (which == "ifshift") {
      ifshift_ = std::max(0, std::min(Ts480::IFSHIFT_MAX, value));
      frame = Ts480::ifshiftMsg(ifshift_);
    } else {
      return;
    }
  }
  send(frame);
  dirty_ = true;
}

void Ts480Link::tap(const Ts480::KeyDef &key, Clock::time_point &at) {
  macro_.push_back({at, Ts480::keyMsg(key, Ts480::KEY_DOWN)});
  macro_.push_back({at + ms(80), Ts480::keyMsg(key, Ts480::KEY_UP)});
  at += ms(130);
}

void Ts480Link::directFreq(double khz) {
  if (!(khz > 0) || khz > 60000) return;
  // link.py: 10 Hz units, 7 digits, trailing zeros dropped, at least two
  // digits; the first digit is the 10 MHz digit (7 MHz -> 0,7...).
  long long hz10 = std::llround(khz * 100);
  char digits[32];
  std::snprintf(digits, sizeof(digits), "%07lld", hz10);
  std::string d(digits);
  while (d.size() > 1 && d.back() == '0') d.pop_back();
  if (d == "0" || d.empty()) d = "0";
  if (d.size() < 2) d.append(2 - d.size(), '0');

  std::lock_guard<std::mutex> lock(mutex_);
  Clock::time_point at = Clock::now();
  if (!macro_.empty() && macro_.back().first + ms(50) > at) at = macro_.back().first + ms(50);
  const Ts480::KeyDef *ent = Ts480::findKey("ENT");
  tap(*ent, at);
  for (char c : d) {
    if (const Ts480::KeyDef *k = Ts480::findDigitKey(c)) tap(*k, at);
  }
  tap(*ent, at);
}

void Ts480Link::reconnect() { send(Ts480::reconnectMsg()); }

bool Ts480Link::connected() const { return toMs(Clock::now()) - lastRxMs_.load() < kLinkTimeoutMs; }

int Ts480Link::power() {
  std::lock_guard<std::mutex> lock(mutex_);
  return state_.power;
}

int Ts480Link::modeCode() {
  std::lock_guard<std::mutex> lock(mutex_);
  return state_.modeCode;
}

bool Ts480Link::transmitting() {
  std::lock_guard<std::mutex> lock(mutex_);
  return state_.lamp == 2;
}

std::string Ts480Link::snapshotJson() {
  std::string stateJson;
  int af, sql, ifshift;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    stateJson = state_.toJson();
    af = af_;
    sql = sql_;
    ifshift = ifshift_;
  }
  std::ostringstream out;
  out << "{\"type\":\"state\",\"connected\":" << (connected() ? "true" : "false")
      << ",\"passive\":false,\"portOpen\":" << (portOpen_.load() ? "true" : "false")
      << ",\"port\":" << json(transport_->describe()).dump()
      << ",\"state\":" << stateJson << ",\"pots\":{\"af\":" << af << ",\"sql\":" << sql
      << ",\"ifshift\":" << ifshift << "}}";
  return out.str();
}

bool loadTs480LastPower(const std::string &configDir) {
  std::ifstream in(configDir + "/ts480-state.json");
  if (!in.is_open()) return false;
  std::stringstream buffer;
  buffer << in.rdbuf();
  try {
    json root = json::parse(buffer.str());
    return root.value("lastPower", false);
  } catch (const json::exception &) {
    return false;
  }
}

void saveTs480LastPower(const std::string &configDir, bool on) {
  const std::string path = configDir + "/ts480-state.json";
  const std::string tmp = path + ".tmp";
  {
    std::ofstream out(tmp);
    if (!out.is_open()) {
      std::fprintf(stderr, "warning: cannot write %s\n", tmp.c_str());
      return;
    }
    out << json{{"lastPower", on}}.dump() << "\n";
  }
  if (std::rename(tmp.c_str(), path.c_str()) != 0) {
#ifdef _WIN32
    // Windows rename() does not replace an existing file.
    std::remove(path.c_str());
    if (std::rename(tmp.c_str(), path.c_str()) == 0) return;
#endif
    std::fprintf(stderr, "warning: cannot write %s\n", path.c_str());
    return;
  }
  std::printf("local-trx: TS-480 power state saved (%s)\n", on ? "on" : "off");
  std::fflush(stdout);
}

}  // namespace LocalTrx
