// Test layer 3 of docs/wspr-majak-implementace.md: the WSPR pacing model driven
// against the REAL firmware TX path.
//
// The functions below aud1_tx_shim are not a reimplementation. They are lifted
// verbatim out of IC-705_Interface.ino at build time by extract_sketch_aud1.py,
// so aud1AcceptTxPacket, aud1TxTick and the abort conditions are production
// code. The native LAN Adapter uses the real IcomLanAudioTx Module and exposes
// the separately clocked audio owner used by the firmware.
//
// This binary is the firmware half of a co-simulation. It speaks a line protocol
// on stdin/stdout so tools/wspr-tx-pacing-smoke.js can drive it with the real
// browser-side driver (data/wspr-tx.js) and close the credit loop:
//
//   in    TICK <ms> <main>       always run audio owner, optionally run main tick
//         CTRL <json>           a browser control frame (tx.prepare / wspr.ping)
//         PACKET <hex>          an AUD1 TX packet
//         LAN <0|1>             LAN link up or down
//         ALC <raw> <seq>       the radio answered the ALC meter (TRX1 globals)
//         STAT                  ask for the ring state
//   out   TX <json>             whatever the firmware sent to the browser
//         PTT <0|1>             a PTT transition
//         RING <used> <consumed> <state>
//         RADIO <bytes>         mu-law handed to the radio since the last report
//
// Every stdout line is a fact observed inside the firmware code, never something
// the test decided.

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "icom_lan_audio_tx.h"

// ---- Arduino shims ---------------------------------------------------------

namespace {
std::uint32_t g_millis = 0;
std::vector<std::string> g_pendingText;   // AudioSendText output, drained per line
std::uint64_t g_radioBytes = 0;           // mu-law actually handed to the radio
bool g_lanUp = true;
bool g_serialEcho = false;
} // namespace

std::uint32_t millis() { return g_millis; }

// Just enough of Arduino's String for the extracted code: concatenation, search,
// substring, trim, case folding and the numeric constructors.
class String {
  public:
    String() = default;
    String(const char *text) : value_(text ? text : "") {}
    String(const std::string &text) : value_(text) {}
    String(char c) : value_(1, c) {}
    explicit String(int v) : value_(std::to_string(v)) {}
    explicit String(unsigned v) : value_(std::to_string(v)) {}
    explicit String(long v) : value_(std::to_string(v)) {}
    explicit String(unsigned long v) : value_(std::to_string(v)) {}
    explicit String(long long v) : value_(std::to_string(v)) {}
    explicit String(unsigned long long v) : value_(std::to_string(v)) {}

    int length() const { return static_cast<int>(value_.size()); }
    const char *c_str() const { return value_.c_str(); }
    char charAt(int index) const {
        return (index >= 0 && index < length()) ? value_[static_cast<std::size_t>(index)] : '\0';
    }
    int indexOf(const String &needle) const {
        auto const at = value_.find(needle.value_);
        return at == std::string::npos ? -1 : static_cast<int>(at);
    }
    int indexOf(char needle) const {
        auto const at = value_.find(needle);
        return at == std::string::npos ? -1 : static_cast<int>(at);
    }
    String substring(int from, int to) const {
        if (from < 0) from = 0;
        if (to > length()) to = length();
        if (from >= to) return String();
        return String(value_.substr(static_cast<std::size_t>(from),
                                    static_cast<std::size_t>(to - from)));
    }
    void trim() {
        auto const first = value_.find_first_not_of(" \t\r\n");
        if (first == std::string::npos) { value_.clear(); return; }
        auto const last = value_.find_last_not_of(" \t\r\n");
        value_ = value_.substr(first, last - first + 1);
    }
    void toLowerCase() {
        for (auto &c : value_) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }
    void reserve(std::size_t bytes) { value_.reserve(bytes); }

    String &operator+=(const String &other) { value_ += other.value_; return *this; }
    String &operator+=(const char *other) { value_ += other ? other : ""; return *this; }
    String &operator+=(char other) { value_ += other; return *this; }
    friend String operator+(String left, const String &right) { left += right; return left; }
    friend String operator+(String left, const char *right) { left += right; return left; }
    friend String operator+(const char *left, const String &right) {
        return String(left) + right;
    }
    bool operator==(const char *other) const { return value_ == (other ? other : ""); }
    bool operator==(const String &other) const { return value_ == other.value_; }
    bool operator!=(const char *other) const { return !(*this == other); }
    bool operator!=(const String &other) const { return !(*this == other); }
    const std::string &str() const { return value_; }

  private:
    std::string value_;
};

namespace {
struct SerialStub {
    template <typename T> void print(const T &value) const {
        if (g_serialEcho) std::cerr << value;
    }
    void print(const String &value) const { if (g_serialEcho) std::cerr << value.str(); }
    template <typename T> void println(const T &value) const {
        if (g_serialEcho) std::cerr << value << "\n";
    }
    void println(const String &value) const { if (g_serialEcho) std::cerr << value.str() << "\n"; }
    void println() const { if (g_serialEcho) std::cerr << "\n"; }
} Serial;

struct WsClientStub {
    bool up{true};
    bool connected() const { return up; }
} AudioWsClient;

// Native Adapter at the same Seam as the production socket owner. Packetization,
// queue accounting, deadlines and the playout tail remain the real Module.
// The ALC snapshot the sketch's tx-level emitter reads. Only the two fields the
// TX path touches are modelled: the rest of LanRadioSnapshot is filled by the
// CI-V handler, which is not part of this co-simulation.
struct LanRadioSnapStub {
    std::uint16_t alcRaw{0};
    std::uint32_t alcSeq{0};
};
LanRadioSnapStub lanRadioSnap;

// The shared CAT globals a LAN radio on TRX1 writes instead of the snapshot,
// and the slot lookup that decides between them. Both are inputs to the lifted
// aud1Alc* accessors; the harness keeps the radio on slot 0, which is the
// ordinary single-radio setup and the one the first version got wrong.
std::uint32_t stateAlcRaw = 0;
std::uint32_t stateAlcSeq = 0;
std::uint8_t lanRadioSlot = 0;
std::uint8_t lanRadioSlotIndex() { return lanRadioSlot; }

struct LanClientStub {
    IcomLanAudioTx tx;
    bool txTraffic{false};
    bool alcFastFlag{false};

    LanClientStub() { tx.configure(0x11223344, 0x55667788); }
    bool connected() const { return g_lanUp; }
    bool audioTxReady() const { return g_lanUp; }
    bool prepareAudioTx() { tx.clearTx(); return g_lanUp; }
    bool queueAudioTx(const std::uint8_t *data, std::size_t length) {
        return g_lanUp && tx.enqueue(data, length);
    }
    bool startAudioTx(std::uint64_t total, std::uint32_t startMs) {
        return g_lanUp && tx.arm(total, startMs);
    }
    void cancelAudioTx(IcomLanAudioTx::Fault fault = IcomLanAudioTx::FAULT_NONE) {
        if (fault == IcomLanAudioTx::FAULT_NONE) tx.clearTx();
        else tx.fail(fault);
    }
    IcomLanAudioTx::Snapshot audioTxSnapshot() const { return tx.snapshot(); }
    // Mirrors IcomLanClient: ending TX traffic always ends fast-ALC metering,
    // so a calibration that dies cannot leave the rotation latched.
    void setTxTrafficActive(bool active) {
        txTraffic = active;
        if (!active) alcFastFlag = false;
    }
    void setAlcFast(bool fast) { alcFastFlag = fast; }
    bool alcFast() const { return alcFastFlag; }
    std::uint32_t audioRxDropped() const { return 0; }
    static const char *audioTxFaultName(IcomLanAudioTx::Fault fault) {
        switch (fault) {
          case IcomLanAudioTx::FAULT_NONE: return "";
          case IcomLanAudioTx::FAULT_NOT_READY: return "audio channel not ready";
          case IcomLanAudioTx::FAULT_OVERFLOW: return "TX buffer overflow";
          case IcomLanAudioTx::FAULT_UNDERRUN: return "TX buffer underrun";
          case IcomLanAudioTx::FAULT_DEADLINE: return "TX audio deadline missed";
          case IcomLanAudioTx::FAULT_SEND: return "TX UDP send failed";
          case IcomLanAudioTx::FAULT_LINK: return "LAN audio link lost";
        }
        return "TX audio fault";
    }
    void serviceAudioOwner(std::uint32_t now) {
        for (int budget = 0; budget < 3; ++budget) {
            const std::uint8_t *packet = nullptr;
            std::size_t length = 0;
            if (tx.poll(now, packet, length) != IcomLanAudioTx::PACKET) return;
            if (!g_lanUp) { tx.commitSend(false, now); return; }
            g_radioBytes += length - IcomLanAudioTx::HEADER_SIZE;
            tx.commitSend(true, now);
        }
    }
} lanClient;

// The sketch reaches the radio through the LAN-radio accessors rather than a
// fixed slot-0 object, so that the JS8/WSPR TX path follows whichever TRX the
// operator gave LAN to. Nothing about the pacing depends on which slot it is.
using IcomLanClient = LanClientStub;
IcomLanClient *lanRadioClient() { return &lanClient; }
bool lanRadioConnected() { return g_lanUp; }

String jsonEscape(const String &text) { return text; }

bool AudioSendText(const String &text) {
    g_pendingText.push_back(text.str());
    return true;
}
} // namespace

// Real shared headers, exactly as the sketch includes them.
#include "aud1_tx_state.h"
#include "unattended_events.h"
#include "unattended_guard.h"

namespace {
UnattendedGuard unattendedGuard;
void unattendedLogEvent(UnattendedEventType, const String &) {}
void unattendedLogEvent(UnattendedEventType, const char *) {}

// IC-705_Interface.ino:486 — the bounded grace the receive loop gives a
// fragmented TCP read that straddles the slot boundary.
const std::uint32_t AUD1_WS_SLOT_BACKLOG_GRACE_MS = 100;
const std::uint32_t TX_GUARD_LEAD_MS = 3000;

// ---- sketch globals --------------------------------------------------------
// Same declarations as IC-705_Interface.ino around line 451.
Aud1TxState aud1TxState = AUD1_TX_IDLE;
const std::size_t AUD1_TX_RING_SIZE = 12288;
std::size_t aud1TxUsed = 0;
std::uint32_t aud1TxId = 0, aud1TxExpectedSequence = 0, aud1TxExpectedPackets = 0;
std::uint32_t aud1TxReceivedPackets = 0, aud1TxTargetMs = 0;
std::uint32_t aud1TxDeadlineMs = 0, aud1TxPrebufferSamples = 0;
std::uint64_t aud1TxExpectedSample = 0, aud1TxTotalSamples = 0, aud1TxConsumedUlaw = 0;
bool aud1TxLastSeen = false;
std::uint32_t aud1TxLevelNextMs = 0;
std::uint32_t audioStreamId = 0;
std::uint32_t audioTxLastMs = 0;
bool audioTxKeyed = false;
// Per-transmission health counters for the browser->firmware leg.
std::uint32_t aud1TxLastPacketMs = 0;
std::uint32_t aud1TxMaxGapMs = 0;
std::size_t aud1TxMinQueued = (std::size_t)-1;
std::uint32_t audioRxHeld = 0;

// PTT transitions are the single most important observable, so they are surfaced
// rather than merely recorded.
bool g_pttReported = false;
std::vector<std::string> g_pttEvents;
void notePtt() {
    if (audioTxKeyed == g_pttReported) return;
    g_pttReported = audioTxKeyed;
    g_pttEvents.push_back(audioTxKeyed ? "1" : "0");
}
void audioPttOn() { audioTxKeyed = g_lanUp; notePtt(); }
void audioPttOff() { audioTxKeyed = false; notePtt(); }

void aud1TxAbort(const String &reason, bool notify = true);
void aud1TxTick(bool deferPrebufferMiss = false);
} // namespace

// ---- the production code ---------------------------------------------------
namespace {
#include "sketch_aud1_tx.inc"
} // namespace

// ---- line protocol ---------------------------------------------------------

namespace {
std::vector<std::uint8_t> parseHex(const std::string &text) {
    std::vector<std::uint8_t> out;
    out.reserve(text.size() / 2);
    for (std::size_t at = 0; at + 1 < text.size(); at += 2)
        out.push_back(static_cast<std::uint8_t>(std::stoul(text.substr(at, 2), nullptr, 16)));
    return out;
}

void flush() {
    for (auto const &text : g_pendingText) std::cout << "TX " << text << "\n";
    g_pendingText.clear();
    for (auto const &value : g_pttEvents) std::cout << "PTT " << value << "\n";
    g_pttEvents.clear();
    if (g_radioBytes) {
        std::cout << "RADIO " << g_radioBytes << "\n";
        g_radioBytes = 0;
    }
    std::cout.flush();
}
} // namespace

int main(int argc, char **argv) {
    for (int index = 1; index < argc; ++index)
        if (std::strcmp(argv[index], "--verbose") == 0) g_serialEcho = true;

    audioStreamId = 0x53505752;   // the browser must match this exactly
    std::cout << "HELLO " << audioStreamId << " " << AUD1_TX_RING_SIZE << "\n";
    std::cout.flush();

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        auto const space = line.find(' ');
        std::string const verb = line.substr(0, space);
        std::string const rest = space == std::string::npos ? "" : line.substr(space + 1);

        if (verb == "TICK") {
            std::istringstream values(rest);
            int runMain = 0;
            values >> g_millis >> runMain;
            // The production audio owner advances independently of the
            // cooperative sketch loop.
            lanClient.serviceAudioOwner(g_millis);
            if (runMain) aud1TxTick(false);
            // startAudioTx() notifies the production task, so an arm performed
            // by the main tick may emit the first due packet immediately.
            lanClient.serviceAudioOwner(g_millis);
        } else if (verb == "CTRL") {
            unattendedNoteClient(unattendedGuard, g_millis);
            aud1HandleControl(String(rest));
        } else if (verb == "PACKET") {
            unattendedNoteClient(unattendedGuard, g_millis);
            auto const wire = parseHex(rest);
            aud1AcceptTxPacket(wire.data(), wire.size());
            // Mirrors the receive loop: once streaming, drain on every packet.
            std::size_t const required = (aud1TxPrebufferSamples + 5) / 6;
            if (aud1TxState == AUD1_TX_STREAM ||
                ((aud1TxState == AUD1_TX_READY || aud1TxState == AUD1_TX_PREBUFFER) &&
                 aud1TxExpectedSample >= aud1TxPrebufferSamples && aud1TxUsed >= required))
                aud1TxTick(true);
            lanClient.serviceAudioOwner(g_millis);
        } else if (verb == "LAN") {
            g_lanUp = rest == "1";
            AudioWsClient.up = g_lanUp;
        } else if (verb == "ALC") {
            // The radio answered the ALC meter. Writes the SHARED CAT globals,
            // which is where a LAN radio on TRX1 lands -- the case that used to
            // report "the radio never answered" while it was answering. The
            // accessors are lifted from the sketch, so this proves the selection,
            // not a harness copy of it.
            std::istringstream fields(rest);
            unsigned long raw = 0, seq = 0;
            fields >> raw >> seq;
            stateAlcRaw = static_cast<std::uint32_t>(raw);
            stateAlcSeq = static_cast<std::uint32_t>(seq);
        } else if (verb == "STAT") {
            // nothing to do; the RING line below reports it
        } else if (verb == "QUIT") {
            break;
        } else {
            std::cout << "ERR unknown verb " << verb << "\n";
        }
        flush();
        std::cout << "RING " << aud1TxUsed << " " << aud1TxConsumedUlaw << " "
                  << static_cast<int>(aud1TxState) << "\n";
        std::cout.flush();
    }
    return 0;
}
