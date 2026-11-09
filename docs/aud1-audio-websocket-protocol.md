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
  "tx": [{"kind": "TX_PCM16", "sampleRate": 48000},
         {"kind": "TX_ULAW", "sampleRate": 8000}],
  "maxPayloadBytes": 2048,
  "radioTxBufferMs": 150
}
```

`streamId` is a random non-zero 32-bit epoch identity. It changes on an audio
session restart, on a sample counter reset and on a new login to the radio. On
a change the client discards partially assembled slots; it must not read the
difference as packet loss inside the previous epoch.

`radioTxBufferMs` is the radio's own TX jitter buffer, asked for in the stream
request: how long the radio holds TX audio before it plays it. It is TX latency
on top of the firmware's slot and prebuffer, which a modem that times its
replies adds to its round trip. For a radio on Wi-Fi (the IC-705) the
firmware adapts it to the jitter it measures on the RX audio (150–500 ms in 50 ms
steps, `lan_jitter.h`; a wired radio stays at 150): it rises
as soon as the path needs it and falls only after ten quiet minutes, and a
change reconnects the radio, so it is applied only while no client holds this
socket. A client from before the field ignores it; one that reads it treats a
missing field as 150. `/state` shows the same as `txBufferMs`, the value the next
connection will use as `txBufferNextMs`, and the measured `rxJitterMs`.

### The 16 kHz radio link

The LAN radio link normally runs at 8 kHz µ-law in both directions. An add-on
with a wideband modem can ask for the wide link (`radioLinkSetWide()` in
`wifilt.ino`); the firmware then requests 16 kHz µ-law from the radio instead.
The rate is part of the stream request, so a change reconnects the radio and
closes the audio socket. On that link:

- the hello offers a second RX entry,
  `"rx":[{"kind":"RX_ULAW","sampleRate":8000},{"kind":"RX_ULAW","sampleRate":16000}]`;
- the RX stream still starts at 8 kHz. The firmware decimates the radio's
  16 kHz with a 63-tap half-band filter, flat to 3.4 kHz and 58 dB down from
  4.6 kHz. Every client that knows nothing of 16 kHz keeps working, and so do
  the watch viewers;
- `{"type":"rx.select","sampleRate":16000}` switches this socket to the
  radio's 16 kHz, and `8000` switches it back. A switch starts a new media
  epoch: the next frame has `FIRST`, `firstSample` 0 and the new `sampleRate`.
  On an 8 kHz link the request is remembered and has no effect;
- TX: the hello offers `{"kind":"TX_ULAW","sampleRate":16000}`, so a client
  that speaks TX_ULAW sends 320-byte 20 ms packets; a TX_PCM16 client still
  sends 48 kHz and the firmware takes every 3rd sample instead of every 6th.
  The radio queue is 1.536 s at either rate (24576 B at 16 kHz) and each radio
  packet is 320 B.

### TX_ULAW: TX at the link's rate

The hello's `tx` list offers `TX_PCM16` at 48 kHz and `TX_ULAW` at the radio
link's rate (8000, or 16000 on the 16 kHz link). A client that knows TX_ULAW
sends its transmission already as the link's µ-law: one byte per sample,
160 B per 20 ms at 8 kHz, 320 B at 16 kHz -- about 10 kB/s on the socket
instead of about 98 kB/s for PCM16 at 48 kHz (6-12x less WiFi to the box, and
less for the loop to parse).

- `tx.prepare` adds `"kind":"TX_ULAW"` and sets `sampleRate` to the link's
  rate. `samples`, `prebufferSamples` and every `tx.extend.samples` count the
  link's samples; the packets carry kind `4`, that `sampleRate` and a
  `firstSample` in the same samples.
- A `sampleRate` other than the link's rate is refused with
  `tx-error "TX rate mismatch"`. Without `kind` the transmission is TX_PCM16
  at 48 kHz, exactly as before, so a page from before TX_ULAW keeps working,
  and a page that finds no TX_ULAW in the hello (older firmware) sends PCM16.
- The wire is fixed per transmission by its `tx.prepare`.
- The browser side lives in one place, `Aud1WebSocketSession`
  (`data/js8-aud1.js`): every modem still builds 48 kHz PCM16 packets, and
  the session rewrites them -- every 6th (8 kHz) or 3rd (16 kHz) sample from
  the packet start, coded with a bit-exact copy of the firmware's
  `aud1Pcm16ToUlaw`. That is the firmware's own TX_PCM16 conversion, so the
  radio receives byte for byte what it did before
  (`tools/aud1-tx-ulaw-smoke.js`). `?aud1tx=pcm16` on a page (Mercury passes
  it on to its workers) forces TX_PCM16 for an A/B test.
- The firmware logs the wire of each transmission:
  `AUD1 | TX ready id=7 wire=TX_ULAW/8000 slot in ms=200`.

## Binary message

Every binary WebSocket message carries exactly one 40-byte header and exactly
one payload. All multi-byte header fields are unsigned big-endian.

| Offset | Length | Field | Meaning |
|---:|---:|---|---|
| 0 | 4 | magic | ASCII `AUD1` |
| 4 | 1 | version | `1` |
| 5 | 1 | kind | `1=RX_ULAW`, `2=RX_PCM16`, `3=TX_PCM16`, `4=TX_ULAW` |
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

`RX_ULAW` and `TX_ULAW` carry one G.711 µ-law byte per sample. A PCM payload is signed
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
`prebufferSamples` and `packetMs=20`. An RTTY transmission adds `rttyText`, the
message itself, which the firmware publishes on TrxNet's `/rtty-tx` once it has
accepted the prepare (and follows with an abort marker if the transmission is
cut short); JS8, WSPR and Mercury leave it out. Binary `TX_PCM16` may only start once the
server has answered `tx-ready` with the same `txId` — and `tx-ready` is still
not permission to key.

The client starts at `slotUtcMs - prebufferSamples/sampleRate`, sends one 20 ms
packet every 20 ms and bounds the catch-up burst. The firmware maps the
browser's target slot onto its own monotonic clock; the accuracy of that map
has to be measured under a dummy load. If the prebuffer is short at the target
instant, if sequence/`firstSample` disagree, if the ring overflows, or if an
underrun follows PTT, the whole `txId` goes to fault and PTT OFF.

Production JS8LAN uses `prebufferSamples=48000` (1 s) and allows at most 25
packets (500 ms) of catch-up. After conversion to the link's µ-law the firmware
holds a 1.536 s ring (12288 B at 8 kHz, 24576 B on the 16 kHz link), so a
brief stall in a mobile browser does not cost the slot while catch-up stays
bounded. PTT is not keyed while the ring
buffer is being filled.

The first and last audio block carry the `FIRST` and `LAST` flags. The firmware
reports `tx-state` as it goes and sends `tx-drained` once the audio buffer has
physically emptied. Failures are reported as `tx-error`. The client can end a
transmission with `tx.abort`; the firmware then discards pending audio and
acknowledges the state with PTT OFF. A timeout, a lost WebSocket, a bad
sequence, an underrun and a reconnect must all, without exception, end at PTT
OFF.

Unrelated to TX, an RTTY page also sends `{"type":"rtty.stream","r1":"…","r2":"…"}`
at most every 500 ms: what its two decoders printed since the last one, for the
TrxNet text stream (`rtty_stream.h`). The firmware drops it unless the stream is
switched on and somebody subscribed.

A modem that does not know a transmission's length in advance can stream it:
`tx.prepare` for a few packets the moment it keys, the declared length kept a
few packets ahead with `tx.extend` (`samples`, `packets`) while it stays keyed,
and the end padded with silence to an exact `LAST`. Its packets may follow
`tx.prepare` on the same socket without waiting for `tx-ready`; the firmware
handles frames in order, so they arrive with the transmission already in
`READY`.

An add-on may carry its own text frames on this socket (`addonFromPage()` in
`wifilt.ino`, and `aud1SendTextFrame()` the other way); the firmware passes
every control frame it does not know to the add-ons first.

### Modem busy: a quiet loop during an ARQ link

An ARQ link such as Mercury's times its replies in a few hundred ms, and
between its bursts the firmware's loop is not keyed, so `txRealtimeNow()` would
let it do anything. While a link is up (Mercury: CALLING, ACCEPTING, CONNECTED,
DISCONNECTING) the page sends

```json
{"type":"modem.busy","on":true,"mode":"mercury"}
```

every 5 s, and `"on":false` once the link is down. The firmware holds it as a
15 s lease that also ends with the socket (`modemBusyNow()`, shown as
`"modemBusy"` in `/state`). While it holds (`linkQuietNow()` = keyed or busy):

- the LAN radio's RX-time CI-V rotation drops from 100 ms to 500 ms and to
  frequency, mode and PTT (TX-time metering is unchanged); serial CI-V radios
  are polled four times less often; the GPS poll pauses;
- no DX cluster reconnect and no APRS-IS DNS/connect (both block the loop); DX
  cluster spots are relayed one chunk per 250 ms and the rest waits in TCP;
- the unattended log is written to flash only once its RAM ring is half full,
  and never across a key; an ICOM network scan is refused (`"link"`);
- static page loads are paced at most at 64 kB/s (`web_pacer.h`).

Once a minute while busy the firmware logs where the loop's time went, per
stage, worst and mean pass: `LOOP| busy max/mean us: LanClient=… CIV=… Web=…`.

A page frame is at most 2048 bytes (`Aud1WsParser`), so the page sends at most
1200 payload bytes per frame. The firmware reads a socket only when the AUD1
send queue has room for the frame plus 4 kB, so RX audio keeps priority.

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
PCM16/48 kHz into the radio's µ-law stream, and the measurement of slot timing
on the device, remain part of the dummy-load gate.
