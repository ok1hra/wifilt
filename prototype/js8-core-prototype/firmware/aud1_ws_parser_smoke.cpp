#include "aud1_ws_parser.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {

std::vector<std::uint8_t> maskedFrame(std::uint8_t opcode,
                                      std::vector<std::uint8_t> const& payload) {
    std::vector<std::uint8_t> wire;
    wire.push_back(static_cast<std::uint8_t>(0x80U | opcode));
    if (payload.size() < 126) {
        wire.push_back(static_cast<std::uint8_t>(0x80U | payload.size()));
    } else {
        wire.push_back(0x80U | 126U);
        wire.push_back(static_cast<std::uint8_t>(payload.size() >> 8));
        wire.push_back(static_cast<std::uint8_t>(payload.size()));
    }
    constexpr std::uint8_t mask[] = {0x12, 0x34, 0x56, 0x78};
    wire.insert(wire.end(), std::begin(mask), std::end(mask));
    for (std::size_t index = 0; index < payload.size(); ++index)
        wire.push_back(static_cast<std::uint8_t>(payload[index] ^ mask[index % 4]));
    return wire;
}

bool feedFragmented(Aud1WsParser& parser, std::vector<std::uint8_t> const& wire,
                    std::vector<std::size_t> const& fragments,
                    std::vector<std::vector<std::uint8_t>>& frames) {
    std::size_t offset = 0;
    std::size_t fragment = 0;
    while (offset < wire.size()) {
        auto const available = std::min(fragments[fragment++ % fragments.size()],
                                        wire.size() - offset);
        for (std::size_t index = 0; index < available; ++index) {
            auto const result = parser.push(wire[offset++]);
            if (result == Aud1WsParser::Error) return false;
            if (result == Aud1WsParser::FrameReady) {
                frames.emplace_back(parser.payload(), parser.payload() + parser.payloadSize());
                parser.reset();
            }
        }
        // Feeding only bytes which are currently available must never require
        // the caller to wait for the rest of a fragmented TCP/WebSocket frame.
    }
    return true;
}

} // namespace

int main() {
    bool pass = true;
    Aud1WsParser parser;
    std::vector<std::vector<std::uint8_t>> frames;

    std::vector<std::uint8_t> audio(1960);
    for (std::size_t index = 0; index < audio.size(); ++index)
        audio[index] = static_cast<std::uint8_t>(index);
    auto const first = maskedFrame(0x2, audio);
    pass = pass && feedFragmented(parser, first, {1, 2, 7, 31, 509}, frames);
    pass = pass && frames.size() == 1 && frames[0] == audio && parser.idle();

    auto const textPayload = std::vector<std::uint8_t>{'t', 'x', '.', 'a', 'b', 'o', 'r', 't'};
    auto const text = maskedFrame(0x1, textPayload);
    std::vector<std::uint8_t> continuous = first;
    continuous.insert(continuous.end(), text.begin(), text.end());
    frames.clear();
    pass = pass && feedFragmented(parser, continuous, {continuous.size()}, frames);
    pass = pass && frames.size() == 2 && frames[0] == audio && frames[1] == textPayload;

    // An oversized frame must fail as soon as its length is known, without
    // allocating or waiting for the advertised payload.
    parser.reset();
    std::vector<std::uint8_t> oversized = {0x82, 0xFE, 0x08, 0x01}; // 2049 B
    auto result = Aud1WsParser::NeedMore;
    for (auto byte : oversized) result = parser.push(byte);
    pass = pass && result == Aud1WsParser::Error;

    std::cout << "AUD1 WS PARSER " << (pass ? "PASS" : "FAIL")
              << " fragmented=" << first.size()
              << " continuous_frames=" << frames.size() << '\n';
    return pass ? 0 : 1;
}
