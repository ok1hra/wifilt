// The CI-V read capture, tested as the real firmware text.
//
// civReadArm() and civReadCapture() below are LIFTED VERBATIM out of the sketch
// at build time -- they are not a reimplementation. That matters more here than
// the eight lines suggest, because everything the MOD-level calibration decides
// hangs off one question: did the radio answer THIS address, or is the page
// looking at something else?
//
// Three ways that can go wrong, all of them silent on the air and all of them
// asserted below:
//
//   * a stale reply left in place after arming -> the page reads the previous
//     address's value as the answer to the new question, and writes a MOD level
//     computed from the wrong number.
//   * a reply from a DIFFERENT subaddress accepted -> same outcome, except the
//     radio really did send it, so nothing anywhere looks broken. Icoms broadcast
//     unsolicited 1A 05 frames when the operator turns a menu knob.
//   * a sequence that moves without a reply -> "the radio confirmed that address"
//     about an address the radio does not have, which is exactly the case the
//     design refuses to write to.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include <string>

// ---- Arduino shims ---------------------------------------------------------

namespace {
std::uint32_t g_millis = 1000;
}
static std::uint32_t millis() { return g_millis; }

// The sketch's globals, same names and same types. The capture is pure byte work,
// so this is the whole environment it needs.
static const std::size_t CIV_READ_MAX = 16;
static std::uint8_t  civReadPrefix[CIV_READ_MAX] = {0};
static std::uint8_t  civReadPrefixLen = 0;
static std::uint8_t  civReadReply[CIV_READ_MAX] = {0};
static std::uint8_t  civReadReplyLen = 0;
static std::uint32_t civReadSeq = 0;
static std::uint32_t civReadAtMs = 0;

#include "sketch_civ_read.inc"

// ---- the harness -----------------------------------------------------------

namespace {

int checks = 0, failures = 0;

void check(const char *name, bool condition, const char *detail = "") {
    checks++;
    if (condition) return;
    failures++;
    std::printf("FAIL %s%s%s\n", name, detail[0] ? " -- " : "", detail);
}

// FE FE <to> <from> <cmd> <payload...> FD, the way both capture sites see it.
struct Frame {
    std::uint8_t bytes[32];
    std::size_t length;
};

Frame frame(std::initializer_list<std::uint8_t> body) {
    Frame out{};
    out.bytes[0] = 0xFE; out.bytes[1] = 0xFE; out.bytes[2] = 0xE1; out.bytes[3] = 0xA4;
    std::size_t at = 4;
    for (std::uint8_t byte : body) out.bytes[at++] = byte;
    out.bytes[at++] = 0xFD;
    out.length = at;
    return out;
}

void reset() {
    civReadPrefixLen = 0;
    civReadReplyLen = 0;
    civReadSeq = 0;
    civReadAtMs = 0;
}

const std::uint8_t MOD_LEVEL[] = {0x1A, 0x05, 0x01, 0x17};   // IC-705 WLAN MOD Level
const std::uint8_t DATA_MOD[]  = {0x1A, 0x05, 0x01, 0x19};   // IC-705 DATA MOD input

std::string hex(const std::uint8_t *bytes, std::size_t length) {
    std::string out;
    char pair[3];
    for (std::size_t at = 0; at < length; at++) {
        std::snprintf(pair, sizeof(pair), "%02X", bytes[at]);
        out += pair;
    }
    return out;
}

} // namespace

int main() {
    // ---- an unarmed capture is inert ---------------------------------------
    reset();
    {
        auto reply = frame({0x1A, 0x05, 0x01, 0x17, 0x00, 0x96});
        civReadCapture(reply.bytes, reply.length);
        check("an unarmed capture ignores every frame", civReadSeq == 0 && civReadReplyLen == 0);
    }

    // ---- the ordinary answer ----------------------------------------------
    reset();
    civReadArm(MOD_LEVEL, sizeof(MOD_LEVEL));
    {
        auto reply = frame({0x1A, 0x05, 0x01, 0x17, 0x00, 0x96});
        g_millis = 5000;
        civReadCapture(reply.bytes, reply.length);
        check("a matching reply moves the sequence once", civReadSeq == 1);
        check("the reply is stored as cmd + payload, with no addressing",
              hex(civReadReply, civReadReplyLen) == "1A0501170096",
              hex(civReadReply, civReadReplyLen).c_str());
        check("the arrival time is recorded", civReadAtMs == 5000);
        // 0096 BCD is 96 of 255 -- decoded by the page, never here. The assertion
        // is only that the two bytes survived intact.
        check("the value bytes survive intact",
              civReadReply[4] == 0x00 && civReadReply[5] == 0x96);
    }

    // ---- a different subaddress must not answer ----------------------------
    reset();
    civReadArm(MOD_LEVEL, sizeof(MOD_LEVEL));
    {
        // USB MOD Level, one byte away from the one we asked about, and the kind
        // of frame an Icom sends unsolicited when a menu knob moves.
        auto other = frame({0x1A, 0x05, 0x01, 0x16, 0x02, 0x55});
        civReadCapture(other.bytes, other.length);
        check("a neighbouring subaddress is not the answer",
              civReadSeq == 0 && civReadReplyLen == 0,
              "1A 05 01 16 would have reported the USB level as the WLAN one");
        auto meter = frame({0x15, 0x13, 0x00, 0x00});
        civReadCapture(meter.bytes, meter.length);
        check("an unrelated command is not the answer", civReadSeq == 0);
        auto ng = frame({0xFA});
        civReadCapture(ng.bytes, ng.length);
        check("an NG reply is not the answer", civReadSeq == 0,
              "the firmware does not parse FA; absence is the signal");
        auto ok = frame({0xFB});
        civReadCapture(ok.bytes, ok.length);
        check("a bare OK is not the answer", civReadSeq == 0);
    }

    // ---- arming clears the previous answer ---------------------------------
    reset();
    civReadArm(MOD_LEVEL, sizeof(MOD_LEVEL));
    {
        auto reply = frame({0x1A, 0x05, 0x01, 0x17, 0x00, 0x96});
        civReadCapture(reply.bytes, reply.length);
        const std::uint32_t after = civReadSeq;
        civReadArm(DATA_MOD, sizeof(DATA_MOD));
        check("arming clears the stored reply", civReadReplyLen == 0,
              "otherwise the old address's value answers the new question");
        check("arming does not move the sequence", civReadSeq == after);
        check("arming clears the timestamp", civReadAtMs == 0);
        // And the old address stops being accepted.
        civReadCapture(reply.bytes, reply.length);
        check("the previous address no longer matches after re-arming",
              civReadSeq == after && civReadReplyLen == 0);
        auto now = frame({0x1A, 0x05, 0x01, 0x19, 0x03});
        civReadCapture(now.bytes, now.length);
        check("the newly armed address does match", civReadSeq == after + 1);
        check("a one-byte value is stored whole", civReadReplyLen == 5 && civReadReply[4] == 0x03);
    }

    // ---- bounds ------------------------------------------------------------
    reset();
    civReadArm(MOD_LEVEL, sizeof(MOD_LEVEL));
    {
        // Longer than CIV_READ_MAX: a scope or memory-name reply on the same
        // command family. It must truncate, never write past the buffer.
        Frame big{};
        big.bytes[0] = 0xFE; big.bytes[1] = 0xFE; big.bytes[2] = 0xE1; big.bytes[3] = 0xA4;
        big.bytes[4] = 0x1A; big.bytes[5] = 0x05; big.bytes[6] = 0x01; big.bytes[7] = 0x17;
        for (std::size_t at = 8; at < 30; at++) big.bytes[at] = 0x11;
        big.bytes[30] = 0xFD;
        big.length = 31;
        civReadCapture(big.bytes, big.length);
        check("an over-long reply is truncated to the buffer",
              civReadReplyLen == CIV_READ_MAX, "must not run past civReadReply");
        check("and it still counts as an answer", civReadSeq == 1);
    }

    // A frame shorter than the armed prefix cannot match, and asking must not
    // read past its end.
    reset();
    civReadArm(MOD_LEVEL, sizeof(MOD_LEVEL));
    {
        auto shortFrame = frame({0x1A, 0x05});
        civReadCapture(shortFrame.bytes, shortFrame.length);
        check("a frame shorter than the prefix is not a match", civReadSeq == 0);
        std::uint8_t runt[5] = {0xFE, 0xFE, 0xE1, 0xA4, 0xFD};
        civReadCapture(runt, sizeof(runt));
        check("a runt frame is ignored", civReadSeq == 0);
        civReadCapture(nullptr, 12);
        check("a null frame is ignored", civReadSeq == 0);
    }

    // ---- repeated answers each count --------------------------------------
    //
    // The page needs to tell a fresh read from a repeat of the same value, and the
    // only thing that can say so is the sequence. Two identical replies are two
    // observations.
    reset();
    civReadArm(MOD_LEVEL, sizeof(MOD_LEVEL));
    {
        auto reply = frame({0x1A, 0x05, 0x01, 0x17, 0x00, 0x96});
        civReadCapture(reply.bytes, reply.length);
        civReadCapture(reply.bytes, reply.length);
        check("each answer counts, even with an identical value", civReadSeq == 2);
    }

    std::printf("%d/%d checks passed\n", checks - failures, checks);
    return failures ? 1 : 0;
}
