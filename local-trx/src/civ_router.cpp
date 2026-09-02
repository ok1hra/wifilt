#include "civ_router.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace LocalTrx {

void bcdFromHz(uint64_t hz, uint8_t out[5]) {
  char s[11];
  std::snprintf(s, sizeof(s), "%010llu", (unsigned long long)hz);
  for (int i = 0; i < 5; i++) {
    int hiPos = 8 - i * 2, loPos = hiPos + 1;
    out[i] = (uint8_t)(((s[hiPos] - '0') << 4) | (s[loPos] - '0'));
  }
}

uint64_t hzFromBcd(const uint8_t in[5]) {
  char s[11];
  s[10] = '\0';
  for (int i = 0; i < 5; i++) {
    int hiPos = 8 - i * 2, loPos = hiPos + 1;
    s[hiPos] = (char)('0' + ((in[i] >> 4) & 0x0F));
    s[loPos] = (char)('0' + (in[i] & 0x0F));
  }
  return std::strtoull(s, nullptr, 10);
}

void encodeCivLevel(uint16_t value, uint8_t out[2]) {
  if (value > 255) value = 255;
  out[0] = (uint8_t)(value / 100);
  out[1] = (uint8_t)((((value / 10) % 10) << 4) | (value % 10));
}

namespace {
inline uint32_t bcdByte(uint8_t b) { return (uint32_t)((b >> 4) * 10 + (b & 0x0F)); }
}  // namespace

uint16_t decodeCivLevel(const uint8_t in[2]) {
  return (uint16_t)(bcdByte(in[0]) * 100 + bcdByte(in[1]));
}

void encodeRitLsb3(uint32_t hz, uint8_t out[3]) {
  char s[7];
  std::snprintf(s, sizeof(s), "%06u", (unsigned)(hz % 1000000u));
  for (int i = 0; i < 3; i++) {
    int hiPos = 4 - i * 2, loPos = hiPos + 1;
    out[i] = (uint8_t)(((s[hiPos] - '0') << 4) | (s[loPos] - '0'));
  }
}

uint32_t decodeRitLsb3(const uint8_t in[3]) {
  return bcdByte(in[0]) + bcdByte(in[1]) * 100 + bcdByte(in[2]) * 10000;
}

const char *civModeName(uint8_t modeByte) {
  // Table matches wifilt.ino's own decodeModeName() [wifilt.ino:1349] exactly
  // -- this is what the client this component talks to actually expects.
  switch (modeByte) {
    case 0x00: return "LSB";
    case 0x01: return "USB";
    case 0x02: return "AM";
    case 0x03: return "CW";
    case 0x04: return "RTTY";
    case 0x05: return "FM";
    case 0x06: return "WFM";
    case 0x07: return "CW-R";
    case 0x08: return "RTTY-R";
    default:   return nullptr;
  }
}

namespace {

CivResult ack() {
  CivResult r;
  r.answered = true;
  r.payload = {0xFB};
  return r;
}

CivResult noReply() { return CivResult{}; }

}  // namespace

CivResult dispatchCiv(const std::vector<uint8_t> &frame, RigBackend &rig, KeyingBackend *keying) {
  if (frame.empty()) return noReply();
  const uint8_t cmd = frame[0];
  const uint8_t *body = frame.data() + 1;
  const size_t bodyLen = frame.size() - 1;

  switch (cmd) {
    case 0x17: {   // CW message, ASCII payload, never through hamlib (bod 7/8)
      if (!keying || bodyLen == 0) return noReply();
      keying->sendCwText(std::string(reinterpret_cast<const char *>(body), bodyLen));
      // Fire-and-forget on wifilt's own side too -- see keying_backend.h's
      // header comment on catWriteFrame()'s dead broadcastTx parameter.
      return ack();
    }
    case 0x03: {   // read frequency, no body
      CivResult r;
      r.answered = true;
      r.payload.push_back(0x03);
      uint8_t bcd[5];
      bcdFromHz((uint64_t)rig.getFreqHz(), bcd);
      r.payload.insert(r.payload.end(), bcd, bcd + 5);
      return r;
    }
    case 0x05: {   // write frequency, 5-byte BCD body
      if (bodyLen < 5) return noReply();
      rig.setFreqHz((double)hzFromBcd(body));
      return ack();
    }
    case 0x04: {   // read mode, no body
      CivResult r;
      r.answered = true;
      r.payload.push_back(0x04);
      r.payload.push_back(rig.getModeByte());
      r.payload.push_back(0x01);   // filter width -- not modelled yet, wide/default
      return r;
    }
    case 0x06: {   // write mode, [modeId, modeWidth]
      if (bodyLen < 1) return noReply();
      rig.setModeByte(body[0]);
      return ack();
    }
    case 0x14: {   // levels: AF (0x01) / RF (0x02) gain (bod 11 category a),
                    // CW speed (0x0C, bod 7/8 -- keying subsystem, never hamlib)
      if (bodyLen < 1) return noReply();
      const uint8_t sub = body[0];
      if (sub == 0x0C) {
        if (!keying) return noReply();
        if (bodyLen >= 3) {   // write -- wifilt.ino itself never sends this (read-only
                              // there, wifilt.ino:5655), implemented anyway for any
                              // other CI-V client
          uint8_t lv[2] = {body[1], body[2]};
          keying->setCwSpeedRaw((uint8_t)decodeCivLevel(lv));
          return ack();
        }
        CivResult r;
        r.answered = true;
        r.payload.push_back(0x14);
        r.payload.push_back(0x0C);
        uint8_t lv[2];
        encodeCivLevel(keying->getCwSpeedRaw(), lv);
        r.payload.push_back(lv[0]);
        r.payload.push_back(lv[1]);
        return r;
      }
      GainKind kind;
      if (sub == 0x01) kind = GainKind::Af;
      else if (sub == 0x02) kind = GainKind::Rf;
      else if (sub == 0x0A) kind = GainKind::RfPower;   // TX power setting, fáze 7 -- wire-identical to AF/RF
      else return noReply();
      if (bodyLen >= 3) {   // write: subcmd + 2-byte level
        uint8_t lv[2] = {body[1], body[2]};
        rig.setGain(kind, (uint8_t)decodeCivLevel(lv));
        return ack();
      }
      // read: subcmd only
      CivResult r;
      r.answered = true;
      r.payload.push_back(0x14);
      r.payload.push_back(sub);
      uint8_t lv[2];
      encodeCivLevel(rig.getGain(kind), lv);
      r.payload.push_back(lv[0]);
      r.payload.push_back(lv[1]);
      return r;
    }
    case 0x21: {   // RIT, bod 11 category (a) -- only subcommand 0x00 read modelled
      if (bodyLen < 1 || body[0] != 0x00) return noReply();
      CivResult r;
      r.answered = true;
      r.payload.push_back(0x21);
      r.payload.push_back(0x00);
      uint8_t rit[3];
      encodeRitLsb3((uint32_t)rig.getRitHz(), rit);
      r.payload.insert(r.payload.end(), rit, rit + 3);
      return r;
    }
    case 0x15: {   // meters, bod 11 category (b), fáze 7 -- read-only, wifilt never writes these
      if (bodyLen < 1) return noReply();
      MeterKind kind;
      switch (body[0]) {
        case 0x11: kind = MeterKind::PowerMeter; break;
        case 0x12: kind = MeterKind::Swr; break;
        case 0x15: kind = MeterKind::SupplyVoltage; break;
        // 0x02 S-meter and 0x13 ALC: no reply -- see rig_backend.h's MeterKind
        // comment for why (no verified raw-scale reference to invert, unlike
        // the three above).
        default: return noReply();
      }
      uint8_t raw;
      if (!rig.getMeter(kind, &raw)) return noReply();   // backend doesn't support it
      CivResult r;
      r.answered = true;
      r.payload.push_back(0x15);
      r.payload.push_back(body[0]);
      uint8_t lv[2];
      encodeCivLevel(raw, lv);
      r.payload.push_back(lv[0]);
      r.payload.push_back(lv[1]);
      return r;
    }
    case 0x11: {   // attenuator engaged, bod 11 category (b), fáze 7
      // wifilt's own aux poll only ever sends this with NO body (a bare read,
      // wifilt.ino:5656) -- a body would be a SET, whose byte encoding wifilt
      // itself never exercises anywhere in this repo to verify against, so it
      // stays unanswered rather than guessed.
      if (bodyLen != 0) return noReply();
      bool on;
      if (!rig.getAttenuatorOn(&on)) return noReply();
      CivResult r;
      r.answered = true;
      r.payload.push_back(0x11);
      r.payload.push_back(on ? 0x01 : 0x00);
      return r;
    }
    case 0x16: {   // preamp (0x02) / VOX (0x47), bod 11 category (b), fáze 7
      // Only VOX is answered: PREAMP's CI-V byte is an index (0=off/1=AMP1/
      // 2=AMP2, wifilt.ino:6723-6726) but hamlib's RIG_LEVEL_PREAMP reports a
      // dB value -- there is no rig-independent dB->index rule, so mapping it
      // would be exactly the guess bod 3/11 rule out. VOX has no such
      // ambiguity (both sides are a plain on/off bit).
      if (bodyLen < 1 || body[0] != 0x47) return noReply();
      bool on;
      if (!rig.getVoxOn(&on)) return noReply();
      CivResult r;
      r.answered = true;
      r.payload.push_back(0x16);
      r.payload.push_back(0x47);
      r.payload.push_back(on ? 0x01 : 0x00);
      return r;
    }
    case 0x1C: {   // PTT for audio TX (bod: fáze 3), never through hamlib (bod 7/8)
      if (!keying || bodyLen < 1 || body[0] != 0x00) return noReply();
      if (bodyLen >= 2) keying->setAudioPtt(body[1] != 0x00);   // ignored if a CW/FSK job is busy
      CivResult r;
      r.answered = true;
      r.payload.push_back(0x1C);
      r.payload.push_back(0x00);
      r.payload.push_back(keying->getAudioPtt() ? 0x01 : 0x00);
      return r;
    }
    default:
      // Category (c): GPS/waterfall/MOD-level and anything else unmapped --
      // deliberately no reply, not a blanket ack (bod 11).
      return noReply();
  }
}

}  // namespace LocalTrx
