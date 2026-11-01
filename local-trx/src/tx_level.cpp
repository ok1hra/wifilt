#include "tx_level.h"

#include <cmath>

namespace LocalTrx {

TxLevel::TxLevel(MixerControl &mixer, Trim trim, Persist persist)
    : mixer_(mixer), trimOut_(std::move(trim)), persist_(std::move(persist)) {}

bool TxLevel::open(std::string *error) {
  double lo = 0.0, hi = 0.0;
  if (!mixer_.range(&lo, &hi) || !(hi > lo)) {
    if (error) *error = mixer_.describe() + " has no usable dB range";
    return false;
  }
  maxDb_ = hi;
  minDb_ = lo < hi - kFloorBelowMaxDb ? hi - kFloorBelowMaxDb : lo;
  open_ = true;
  return true;
}

double TxLevel::levelToDb(uint8_t level, double maxDb) {
  return maxDb + 20.0 * std::log10((double)level / 255.0);
}

void TxLevel::applyTrim(float trim) {
  trim_ = trim;
  if (trimOut_) trimOut_(trim);
}

void TxLevel::restore(int level, double mixerDb) {
  if (!open_ || level < 0 || level > 255) return;
  double now = 0.0;
  if (!mixer_.getDb(&now) || std::fabs(now - mixerDb) > kSameDb) return;   // moved since: the mixer wins
  haveSet_ = true;
  level_ = (uint8_t)level;
  hwDb_ = now;
  applyTrim(level == 0 ? 0.0f
                       : (float)std::fmin(1.0, std::pow(10.0, (levelToDb(level_, maxDb_) - now) / 20.0)));
}

bool TxLevel::getModLevel(uint8_t *levelOut) {
  if (!open_) return false;
  double now = 0.0;
  if (!mixer_.getDb(&now)) return false;
  if (haveSet_ && std::fabs(now - hwDb_) <= kSameDb) {
    *levelOut = level_;
    return true;
  }
  if (haveSet_) {
    // Someone else moved the mixer. What plays now is the mixer alone.
    haveSet_ = false;
    applyTrim(1.0f);
    if (persist_) persist_(-1, now);
  }
  const double level = 255.0 * std::pow(10.0, (now - maxDb_) / 20.0);
  *levelOut = (uint8_t)(level < 0.0 ? 0 : level > 255.0 ? 255 : std::lround(level));
  return true;
}

bool TxLevel::setModLevel(uint8_t level) {
  if (!open_) return false;
  const double target = level == 0 ? minDb_ : levelToDb(level, maxDb_);
  double got = 0.0;
  if (!mixer_.setDbAtOrAbove(target < minDb_ ? minDb_ : target, &got)) return false;
  float trim;
  if (level == 0) {
    trim = 0.0f;
  } else if (got >= target) {
    trim = (float)std::pow(10.0, (target - got) / 20.0);
  } else {
    // The mixer rounded down, which setDbAtOrAbove() promises not to do.
    // Never amplify to make up for it: report what really plays instead,
    // and wifilt's read-back says the radio kept a different value.
    haveSet_ = false;
    applyTrim(1.0f);
    if (persist_) persist_(-1, got);
    return true;
  }
  haveSet_ = true;
  level_ = level;
  hwDb_ = got;
  applyTrim(trim);
  if (persist_) persist_(level, got);
  return true;
}

}  // namespace LocalTrx
