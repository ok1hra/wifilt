#include "trxnet_udp.h"

namespace LocalTrx {

TrxNetUdp::TrxNetUdp(std::string listenIp) : listenIp_(std::move(listenIp)) {}

uint8_t TrxNetUdp::begin(uint16_t port) {
  std::string error;
  return socket_.begin(listenIp_, port, &error) ? 1 : 0;
}

void TrxNetUdp::stop() {}   // UdpSocket closes in its own destructor

int TrxNetUdp::beginPacket(IPAddress ip, uint16_t port) {
  txTarget_.addr = (uint32_t)ip;
  txTarget_.port = port;
  txBuffer_.clear();
  txOpen_ = true;
  return 1;
}

int TrxNetUdp::beginPacket(const char *, uint16_t) {
  return 0;   // TrxNet.cpp never calls this overload -- see trxnet_udp.h
}

int TrxNetUdp::endPacket() {
  if (!txOpen_) return 0;
  txOpen_ = false;
  bool ok = socket_.sendTo(txBuffer_.data(), txBuffer_.size(), txTarget_);
  txBuffer_.clear();
  return ok ? 1 : 0;
}

size_t TrxNetUdp::write(uint8_t value) { return write(&value, 1); }

size_t TrxNetUdp::write(const uint8_t *buffer, size_t size) {
  if (!txOpen_ || !buffer) return 0;
  txBuffer_.insert(txBuffer_.end(), buffer, buffer + size);
  return size;
}

int TrxNetUdp::parsePacket() {
  uint8_t staging[2048];
  UdpPeer from;
  int got = socket_.recv(staging, sizeof(staging), &from);
  if (got <= 0) return 0;
  rxBuffer_.assign(staging, staging + got);
  rxOffset_ = 0;
  lastRemote_ = from;
  return got;
}

int TrxNetUdp::available() { return (int)(rxBuffer_.size() - rxOffset_); }

int TrxNetUdp::read() {
  if (rxOffset_ >= rxBuffer_.size()) return -1;
  return rxBuffer_[rxOffset_++];
}

int TrxNetUdp::read(unsigned char *buffer, size_t length) {
  if (!buffer || rxOffset_ >= rxBuffer_.size()) return -1;
  size_t remaining = rxBuffer_.size() - rxOffset_;
  size_t take = length < remaining ? length : remaining;
  std::copy(rxBuffer_.begin() + (long)rxOffset_, rxBuffer_.begin() + (long)(rxOffset_ + take),
            buffer);
  rxOffset_ += take;
  return (int)take;
}

int TrxNetUdp::read(char *buffer, size_t length) {
  return read(reinterpret_cast<unsigned char *>(buffer), length);
}

int TrxNetUdp::peek() {
  if (rxOffset_ >= rxBuffer_.size()) return -1;
  return rxBuffer_[rxOffset_];
}

void TrxNetUdp::flush() { rxOffset_ = rxBuffer_.size(); }

IPAddress TrxNetUdp::remoteIP() { return IPAddress(lastRemote_.addr); }
uint16_t TrxNetUdp::remotePort() { return lastRemote_.port; }

}  // namespace LocalTrx
