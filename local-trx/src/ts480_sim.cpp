// SPDX-License-Identifier: GPL-3.0-or-later
// Port of ts480/sim.py (ts-480-web-panel). See ts480_sim.h.
#include "ts480_sim.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace LocalTrx {

namespace {

const long long kBands[] = {1810000, 3500000, 7000000, 10100000, 14000000, 18068000,
                            21000000, 24890000, 28000000, 50000000};

int signedValue(unsigned v, int bits) {
  return (v & (1u << (bits - 1))) ? (int)v - (1 << bits) : (int)v;
}

}  // namespace

SimTs480Transport::SimTs480Transport(int bootDelayMs) : bootDelayMs_(bootDelayMs) {}

SimTs480Transport::~SimTs480Transport() { close(); }

bool SimTs480Transport::open(std::string *) {
  if (open_) return true;
  stop_ = false;
  open_ = true;
  thread_ = std::thread([this]() { ticker(); });
  return true;
}

void SimTs480Transport::close() {
  stop_ = true;
  if (thread_.joinable()) thread_.join();
  open_ = false;
}

int SimTs480Transport::read(uint8_t *buffer, size_t size, int timeoutMs) {
  std::unique_lock<std::mutex> lock(outMutex_);
  if (out_.empty() && timeoutMs > 0) {
    outCv_.wait_for(lock, std::chrono::milliseconds(timeoutMs), [this]() { return !out_.empty(); });
  }
  const size_t n = std::min(size, out_.size());
  std::copy(out_.begin(), out_.begin() + (long)n, buffer);
  out_.erase(0, n);
  return (int)n;
}

bool SimTs480Transport::write(const std::string &data) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  for (const std::string &f : rx_.feed(data)) handle(f);
  return true;
}

bool SimTs480Transport::radioOn() {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  return on_;
}

std::map<char, int> SimTs480Transport::pots() {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  return pots_;
}

long long SimTs480Transport::frequency() {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  return freq_[vfo_];
}

void SimTs480Transport::tx(const std::string &frame) {
  {
    std::lock_guard<std::mutex> lock(outMutex_);
    out_ += frame;
    out_ += '\r';
  }
  outCv_.notify_all();
}

std::string SimTs480Transport::freqFrame() const {
  char buffer[32];
  std::snprintf(buffer, sizeof(buffer), ";%7lld", freq_[vfo_] / 10);
  return buffer;
}

std::string SimTs480Transport::statusFrame() const {
  if (entering_) {
    std::string t = ent_;
    t.resize(8, '-');
    return "<" + t.substr(0, 8);
  }
  if (rit_ || xit_) {
    char buffer[16];
    std::snprintf(buffer, sizeof(buffer), "%c%04d", ritOff_ < 0 ? '-' : '+', std::abs(ritOff_));
    std::string v = buffer;
    while (v.size() < 7) v = " " + v;
    return "<" + v;
  }
  return "<        ";
}

std::string SimTs480Transport::dotsFrame() const {
  const char sub = (char)((rit_ || xit_) && !entering_ ? 0x81 : 0x80);
  return std::string("F\x89") + sub + "\x80";
}

void SimTs480Transport::redraw() {
  seg_['C'] = (uint8_t)((seg_['C'] & ~0x30) | (rit_ ? 0x10 : 0) | (xit_ ? 0x20 : 0));
  seg_['D'] = (uint8_t)((seg_['D'] & ~0x03) | (vfo_ == 0 ? 0x01 : 0x02));
  tx(":  ");
  tx("20");
  tx("64");
  tx("71");
  tx("81");
  tx("9" + std::to_string(mode_));
  tx(freqFrame());
  tx(statusFrame());
  tx(">7" + std::to_string(meterSel_));
  for (const auto &entry : seg_) tx(std::string(1, entry.first) + (char)entry.second);
  tx(dotsFrame());
}

void SimTs480Transport::power(bool on) {
  on_ = on;
  if (!on) {
    bootPending_ = false;
    tx("00");
    tx("80");
    tx("60");
    tx("70");
    return;
  }
  tx("01");
  bootPending_ = true;
  bootAt_ = Clock::now() + std::chrono::milliseconds(bootDelayMs_);
}

void SimTs480Transport::handle(const std::string &f) {
  if (f == "\xFF" || f.empty()) return;
  const char c = f[0];
  const std::string body = f.substr(1);
  if (c == '0') {   // power key / reconnect
    if (body == "2") {
      if (on_) {
        tx("01");
        redraw();
      } else {
        tx("00");
      }
    } else if (body == "1") {
      // sim.py toggles here; the real radio (link.py, VERIFIED) only
      // switches ON with "01" and OFF with "00".
      if (!on_) power(true);
    } else if (body == "0" && on_) {
      power(false);
    }
    return;
  }
  if (!on_) return;
  if (c == 'V' || c == 'W' || c == 'X') {
    pots_[c] = (int)std::strtol(body.c_str(), nullptr, 16);
    return;
  }
  if (c == 'S') {
    const int d = signedValue((unsigned)std::strtoul(body.c_str(), nullptr, 16), 16);
    const int step = (seg_['?'] & 0x40) ? 1 : 5;
    freq_[vfo_] = std::max(30000LL, std::min(60000000LL, freq_[vfo_] + (long long)d * step));
    tx(freqFrame());
    return;
  }
  if (c == 'T') {
    const int d = signedValue((unsigned)std::strtoul(body.c_str(), nullptr, 16), 8);
    freq_[vfo_] = std::max(30000LL, (freq_[vfo_] / 1000 + d) * 1000);
    tx(freqFrame());
    return;
  }
  if (c == 'U') {
    if (rit_ || xit_) {
      const int d = signedValue((unsigned)std::strtoul(body.c_str(), nullptr, 16), 8);
      ritOff_ = std::max(-9990, std::min(9990, ritOff_ + 10 * d));
      tx(statusFrame());
      tx(dotsFrame());
    }
    return;
  }
  const Ts480::KeyDef *k = Ts480::findKeyByCode(c);
  if (k && body == "1") key(k->name);
}

void SimTs480Transport::key(const std::string &k) {
  if (entering_) {   // direct frequency entry
    if (k == "ENT") {
      std::string digits = ent_ + "0000000";
      freq_[vfo_] = std::atoll(digits.substr(0, 7).c_str()) * 10;
      entering_ = false;
      ent_.clear();
      redraw();
    } else if (const Ts480::KeyDef *key = Ts480::findKey(k); key && key->digit[0]) {
      ent_ += key->digit;
      tx(statusFrame());
    } else if (k == "MTR") {   // CLR
      entering_ = false;
      ent_.clear();
      redraw();
    }
    return;
  }
  static const std::map<std::string, std::pair<char, uint8_t>> toggles = {
      {"NB", {'?', 0x10}}, {"PROC", {'?', 0x04}}, {"VOX", {'?', 0x08}}, {"FINE", {'?', 0x40}},
      {"MHZ", {'?', 0x20}}, {"AGC", {'A', 0x04}}, {"FIL", {'A', 0x08}}, {"AT", {'D', 0x40}}};
  auto t = toggles.find(k);
  if (t != toggles.end()) {
    seg_[t->second.first] ^= t->second.second;
  } else if (k == "ATT") {
    const int v = seg_['?'] & 0x03;
    seg_['?'] = (uint8_t)((seg_['?'] & ~0x03) | (v == 0 ? 0x02 : v == 0x02 ? 0x01 : 0));
  } else if (k == "RIT") {
    rit_ = !rit_;
  } else if (k == "XIT") {
    xit_ = !xit_;
  } else if (k == "CL") {
    ritOff_ = 0;
  } else if (k == "AB") {
    vfo_ ^= 1;
  } else if (k == "ASB") {
    freq_[vfo_ ^ 1] = freq_[vfo_];
  } else if (k == "MODE") {
    static const std::map<int, int> next = {{2, 1}, {1, 3}, {3, 7}, {7, 6}, {6, 5}, {5, 4}, {4, 2}};
    auto it = next.find(mode_);
    mode_ = it == next.end() ? 2 : it->second;
  } else if (k == "MTR") {
    meterSel_ = meterSel_ % 3 + 1;
  } else if (k == "UP" || k == "DOWN") {
    const long long f = freq_[vfo_];
    int best = 0;
    for (int i = 1; i < 10; i++)
      if (std::llabs(kBands[i] - f) < std::llabs(kBands[best] - f)) best = i;
    best = (best + (k == "UP" ? 1 : -1) + 10) % 10;
    freq_[vfo_] = kBands[best];
  } else if (k == "ENT") {
    entering_ = true;
    ent_.clear();
  }
  redraw();
}

void SimTs480Transport::ticker() {
  int n = 0;
  while (!stop_) {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    n++;
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    if (bootPending_ && Clock::now() >= bootAt_) {
      bootPending_ = false;
      if (on_) {
        tx("R0");
        tx("Q1");
        redraw();
        tx("O");   // ask the panel for its pot positions
      }
    }
    if (n % 5 == 0) tx("\xFF");
    if (on_) {
      rng_ = rng_ * 1103515245u + 12345u;
      const double r = ((rng_ >> 16) & 0x7FFF) / 32767.0 * 3.0 - 1.5;
      s_ = std::max(0.0, std::min(20.0, s_ + r + (7 - s_) * 0.1));
      char buffer[16];
      std::snprintf(buffer, sizeof(buffer), "=%02d00", (int)std::lround(s_));
      tx(buffer);
    }
  }
}

}  // namespace LocalTrx
