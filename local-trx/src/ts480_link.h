// SPDX-License-Identifier: GPL-3.0-or-later
// ts480_link.h -- the panel side of the TS-480 panel <-> radio link: answers
// the radio's keepalives and pot queries, sends keys / encoders / pots, keeps
// a DisplayState mirror for the browser. Port of ts480/link.py
// (ts-480-web-panel), with the asyncio tasks folded into ONE dedicated thread.
//
// Why a thread of its own: the radio sends FF every 5 s and switches itself
// OFF about 4 s after the panel stops answering. Nothing on the main loop
// (HTTP, WebSocket, audio, hamlib) may ever be able to delay that answer.
#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "ts480_protocol.h"

struct sp_port;

namespace LocalTrx {

class Ts480Transport {
 public:
  virtual ~Ts480Transport() = default;
  virtual bool open(std::string *error) = 0;
  virtual void close() = 0;
  virtual bool isOpen() const = 0;
  // Waits up to timeoutMs. Bytes read, 0 on timeout, -1 on a port error.
  virtual int read(uint8_t *buffer, size_t size, int timeoutMs) = 0;
  virtual bool write(const std::string &data) = 0;
  virtual std::string describe() const = 0;
};

// The USB-UART on the RJ12 panel cable: 57600 8N2 (the radio accepts 8N1
// too), DTR/RTS held low -- some adapters power or reset things through them.
class SerialTs480Transport : public Ts480Transport {
 public:
  explicit SerialTs480Transport(std::string portName) : portName_(std::move(portName)) {}
  ~SerialTs480Transport() override { close(); }
  bool open(std::string *error) override;
  void close() override;
  bool isOpen() const override { return port_ != nullptr; }
  int read(uint8_t *buffer, size_t size, int timeoutMs) override;
  bool write(const std::string &data) override;
  std::string describe() const override { return portName_; }

 private:
  std::string portName_;
  sp_port *port_ = nullptr;
};

struct Ts480LinkOptions {
  // config dir's ts480-state.json said the radio was on: switch it on again
  // after this (re)start unless it is already on (a quick re-exec stays
  // under the radio's 4 s auto-off).
  bool restorePower = false;
  // Called from the link thread once a power state reported by the radio has
  // held for 2 s, so a restart can put it back.
  std::function<void(bool on)> persistPower;
  bool verbose = false;
};

class Ts480Link {
 public:
  using Clock = std::chrono::steady_clock;

  // Python PanelLink timings.
  static constexpr int kKeepaliveMs = 1000;
  static constexpr int kLinkTimeoutMs = 6000;
  static constexpr int kReconnectMs = 3000;
  static constexpr int kEncoderFlushMs = 60;
  static constexpr int kLongPressMs = 1000;
  static constexpr int kPersistAfterMs = 2000;
  static constexpr int kRestoreFirstMs = 2500;
  static constexpr int kRestoreRetryMs = 4000;
  static constexpr int kRestoreAttempts = 3;

  Ts480Link(std::unique_ptr<Ts480Transport> transport, Ts480LinkOptions options);
  ~Ts480Link();

  void start();
  void stop();

  // Thread-safe controls (any thread).
  void keyDown(const std::string &name);
  void keyUp(const std::string &name);
  void encoder(const std::string &which, int delta);   // "vfo" | "multi" | "rit"
  void setPot(const std::string &which, int value);    // "af" | "sql" | "ifshift"
  void directFreq(double khz);                         // ENT, digits, ENT
  void reconnect();

  // True once since the last call when the display (or the link state)
  // changed -- the main loop broadcasts snapshotJson() then.
  bool takeDirty() { return dirty_.exchange(false); }
  std::string snapshotJson();

  bool connected() const;
  int power();          // -1 unknown, 0 off, 1 on
  int modeCode();       // CAT MD code, -1 unknown
  bool transmitting();  // TX lamp lit
  std::string describe() const { return transport_->describe(); }
  bool portOpen() const { return portOpen_.load(); }

  // Test hooks: run one iteration of the link thread's work at `now`
  // without the thread (tests/test_ts480.cpp drives a fake clock).
  void pumpForTest(Clock::time_point now, int readTimeoutMs = 0) { iterate(now, readTimeoutMs); }

 private:
  void run();
  void iterate(Clock::time_point now, int readTimeoutMs);
  void send(const std::string &data);
  void onFrame(const std::string &frame, Clock::time_point now);
  void timers(Clock::time_point now);
  void tap(const Ts480::KeyDef &key, Clock::time_point &at);

  std::unique_ptr<Ts480Transport> transport_;
  Ts480LinkOptions options_;
  Ts480::FrameReader reader_;

  std::thread thread_;
  std::atomic<bool> stop_{false};
  std::atomic<bool> dirty_{false};
  std::atomic<bool> portOpen_{false};
  std::mutex writeMutex_;

  std::mutex mutex_;   // everything below
  Ts480::DisplayState state_;
  int af_ = 0;   // start silent, as the original panel software does
  int sql_ = 0;
  int ifshift_ = Ts480::IFSHIFT_CENTER;
  struct Held {
    Clock::time_point longAt;
    bool longSent = false;
  };
  std::map<std::string, Held> held_;
  int acc_[3] = {0, 0, 0};   // vfo, multi, rit
  std::deque<std::pair<Clock::time_point, std::string>> macro_;   // timed frames (direct freq)

  std::atomic<int64_t> lastRxMs_{-100000};
  Clock::time_point lastKeepalive_{};
  Clock::time_point lastReconnect_{};
  Clock::time_point lastFlush_{};
  Clock::time_point nextOpenTry_{};
  std::string lastOpenError_;
  bool openedOnce_ = false;

  // Power persistence / restore.
  int powerSeen_ = -1;
  Clock::time_point powerChangedAt_{};
  int powerPersisted_ = -1;
  bool restorePending_ = false;
  Clock::time_point restoreAt_{};
  int restoreAttempts_ = 0;
};

// ts480-state.json in the config dir: {"lastPower": bool}. Its own file, not
// config.json: writing it must not look like a wizard Save (restart).
bool loadTs480LastPower(const std::string &configDir);
void saveTs480LastPower(const std::string &configDir, bool on);

}  // namespace LocalTrx
