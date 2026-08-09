# AUD1 — audio WebSocket protocol

Status: in production. The firmware serves this protocol on port 83 at
`/audiows` (`wifilt.ino`, `aud1_ws_parser.h`, `aud1_tx_state.h`) and the DATA
page speaks it through `data/js8-aud1.js`. An isolated reference implementation
of the same wire format lives in `prototype/js8-core-prototype`, where the
edge cases below are tested without a radio:

- a firmware-side `Aud1RxEmitter` with two-phase `prepare`/`commit`, so that a
  failed WebSocket write produces a gap and a `DISCONTINUITY` rather than a
  fabricated sequence number;
- a strict browser `WsAudioSource` that requires `hello`, enforces the
  `streamId` match, preserves the original wire bytes and holds the first five
  packets back until the UTC epoch is locked;
- delivery of `epoch(streamId, anchorUtcMs)` to the Worker before the first
  `audio` packet;
- Node and native Chrome WebSocket tests for duplicate, gap and reconnect.

## Connection setup

After `/audiows` is opened the server sends a text JSON message first:

```json
{
  "type": "hello",
  "protocol": "AUD1",
  "version": 1,
  "streamId": 16909060,
  "rx": [{"kind": "RX_ULAW", "sampleRate": 8000}],
  "tx": [{"kind": "TX_PCM16", "sampleRate": 48000}],
  "maxPayloadBytes": 2048
}
```

`streamId` is a random non-zero 32-bit epoch identity. It changes on an audio
session restart, on a sample counter reset and on a new login to the radio. On
a change the client discards partially assembled slots; it must not read the
difference as packet loss inside the previous epoch.

## Binary message

Every binary WebSocket message carries exactly one 40-byte header and exactly
one payload. All multi-byte header fields are unsigned big-endian.

| Offset | Length | Field | Meaning |
|---:|---:|---|---|
| 0 | 4 | magic | ASCII `AUD1` |
| 4 | 1 | version | `1` |
| 5 | 1 | kind | `1=RX_ULAW`, `2=RX_PCM16`, `3=TX_PCM16` |
| 6 | 2 | flags | bit flags, below |
| 8 | 2 | headerBytes | `40` |
| 10 | 2 | reserved | must be zero |
| 12 | 4 | streamId | audio epoch identity |
| 16 | 4 | sequence | message order in that direction, modulo 2^32 |
| 20 | 4 | sampleRate | samples per second |
| 24 | 8 | firstSample | index of the first audio sample since the epoch began |
| 32 | 4 | txId | zero for RX, the TX operation identity for TX |
| 36 | 4 | payloadBytes | exact length of the rest of the message |

Flags: `0x0001 FIRST`, `0x0002 LAST`, `0x0004 DISCONTINUITY`, `0x0008 ABORT`.
Unknown bits are a protocol error in version 1.

`RX_ULAW` carries one G.711 µ-law byte per sample. A PCM payload is signed
PCM16 little-endian and its length must be even. The PCM endianness
deliberately differs from the network header and has to be implemented
explicitly through `DataView`, never through an unchecked host-typed view.

`firstSample` is the authority for media time. The arrival time of the
WebSocket message is only used to measure jitter. A gap in `firstSample` is
filled with zeros and raises a discontinuity; an overlapping payload is
trimmed and a complete duplicate is discarded.

## Byte-level vector

An `RX_ULAW` header, flags `FIRST|DISCONTINUITY`, `streamId=0x01020304`,
`sequence=0x05060708`, 8 kHz, `firstSample=0x0000000100000002`,
`txId=0x0a0b0c0d` and payload `ff 7f 00`:

```text
41 55 44 31 01 01 00 05 00 28 00 00 01 02 03 04
05 06 07 08 00 00 1f 40 00 00 00 01 00 00 00 02
0a 0b 0c 0d 00 00 00 03 ff 7f 00
```

A receiver must reject a bad magic or version, a different header length, a
non-zero reserved field, an unknown kind or flag, a zero sample rate, a
`payloadBytes` mismatch and an odd PCM length.

## The safe TX minimum

Neither the binary stream nor `tx-ready` may key PTT. `tx-ready(txId)` only
confirms that the firmware validated the request and reserved a bounded ring
buffer; the radio is still PTT OFF. The client starts sending audio 20 ms
ahead of the target slot. The firmware may key only in the target slot and
only with the complete minimum prebuffer. `LAST` ends the audio, `ABORT`
discards the buffer, and every timeout or disconnect must end at PTT OFF in
the firmware.

## TX control messages

Every modem frame gets its own non-zero `txId` and its own PTT cycle. The
client first sends a text `tx.prepare` message with the fields `txId`,
`sampleRate`, `samples`, `packets`, `mode`, `toneHz`, `slotUtcMs`,
`prebufferSamples` and `packetMs=20`. Binary `TX_PCM16` may only start once the
server has answered `tx-ready` with the same `txId` — and `tx-ready` is still
not permission to key.

The client starts at `slotUtcMs - prebufferSamples/sampleRate`, sends one 20 ms
packet every 20 ms and bounds the catch-up burst. The firmware maps the
browser's target slot onto its own monotonic clock; the accuracy of that map
has to be measured under a dummy load. If the prebuffer is short at the target
instant, if sequence/`firstSample` disagree, if the ring overflows, or if an
underrun follows PTT, the whole `txId` goes to fault and PTT OFF.

Production JS8LAN uses `prebufferSamples=48000` (1 s) and allows at most 25
packets (500 ms) of catch-up. After conversion to 8 kHz µ-law the firmware
holds a 12288-byte ring (1.536 s), so a brief stall in a mobile browser does
not cost the slot while catch-up stays bounded. PTT is not keyed while the ring
buffer is being filled.

The first and last audio block carry the `FIRST` and `LAST` flags. The firmware
reports `tx-state` as it goes and sends `tx-drained` once the audio buffer has
physically emptied. Failures are reported as `tx-error`. The client can end a
transmission with `tx.abort`; the firmware then discards pending audio and
acknowledges the state with PTT OFF. A timeout, a lost WebSocket, a bad
sequence, an underrun and a reconnect must all, without exception, end at PTT
OFF.

```text
QUEUED -> PREPARING -> WAITING_SLOT -> PREBUFFERING -> TRANSMITTING
             |              |              |                |
             +--------------+--------------+----------------+-> ABORT/FAULT
                                                                  -> PTT OFF
TRANSMITTING -> DRAINING -> COMPLETED -> PTT OFF
```

A multi-frame message repeats this handshake for every frame and its following
time slot. Acknowledging one `txId` never authorises sending the next frame.

The isolated `Aud1TxGate` covers capture, prebuffer, continuity, bounded buffer
size, drain, abort, disconnect and underrun. The production conversion of
PCM16/48 kHz into the radio's 8 kHz µ-law stream, and the measurement of slot
timing on the device, remain part of the dummy-load gate.
