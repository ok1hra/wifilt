// SPDX-License-Identifier: GPL-3.0-or-later
// ts480_sim.h -- minimal TS-480 main unit speaking the panel protocol, for
// tests and `local-trx --ts480-sim` (no radio, no RJ12 adapter). Port of
// ts480/sim.py (ts-480-web-panel): the framing, keepalive, power-on redraw and
// pot query match real captures; what a key does is a simplified model, not
// the real firmware.
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <map>
#include <mutex>
#include <string>
#include <thread>

#include "ts480_link.h"

namespace LocalTrx {

class SimTs480Transport : public Ts480Transport {
 public:
  explicit SimTs480Transport(int bootDelayMs = 1000);
  ~SimTs480Transport() override;

  bool open(std::string *error) override;
  void close() override;
  bool isOpen() const override { return open_.load(); }
  int read(uint8_t *buffer, size_t size, int timeoutMs) override;
  bool write(const std::string &data) override;
  std::string describe() const override { return "simulator"; }

  // Test access.
  bool radioOn();
  std::map<char, int> pots();
  long long frequency();

 private:
  using Clock = std::chrono::steady_clock;
  void tx(const std::string &frame);
  std::string freqFrame() const;
  std::string statusFrame() const;
  std::string dotsFrame() const;
  void redraw();
  void power(bool on);
  void handle(const std::string &frame);
  void key(const std::string &name);
  void ticker();

  const int bootDelayMs_;
  std::atomic<bool> open_{false};
  std::atomic<bool> stop_{false};
  std::thread thread_;

  std::mutex outMutex_;
  std::condition_variable outCv_;
  std::string out_;

  std::recursive_mutex mutex_;   // radio model below
  Ts480::FrameReader rx_;
  bool on_ = false;
  long long freq_[2] = {14074000, 7074000};
  int vfo_ = 0;
  int mode_ = 2;   // USB
  bool rit_ = false, xit_ = false;
  int ritOff_ = 0;
  std::map<char, uint8_t> seg_ = {{'?', 0x80}, {'@', 0x84}, {'A', 0x81}, {'B', 0x80},
                                  {'C', 0xC8}, {'D', 0x81}, {'E', 0x81}};
  int meterSel_ = 1;
  bool entering_ = false;
  std::string ent_;
  std::map<char, int> pots_;
  bool bootPending_ = false;
  Clock::time_point bootAt_{};
  double s_ = 6.0;
  unsigned rng_ = 12345;
};

}  // namespace LocalTrx
