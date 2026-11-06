# xara — upstream of WIFILT's VARA-compatible modem

`data/vara-modem.js` is a hand-written JavaScript port of x0rro/xara, a
VARA-compatible HF/FM modem in Rust (MIT licence, (C) 2026 x0rro). Nothing from
the Rust tree is compiled or shipped; the port is checked against upstream's own
test vectors instead, so the checkout is only needed to run the tests.

```
upstream: https://github.com/x0rro/xara
commit:   09a9201381b00499ada9d9c816bd05bb8f175705   ("xara 0.1.3", 2026-10-31)
licence:  MIT
```

To reproduce the test setup:

```sh
git clone https://github.com/x0rro/xara
cd xara && git checkout 09a9201381b00499ada9d9c816bd05bb8f175705
```

with the checkout at `xara/` in the repository root (gitignored; `XARA_DIR`
points the tests elsewhere), then:

```sh
node tools/vara-phy-test.js           # every group (several minutes: the rx_* loopbacks)
node tools/vara-phy-test.js frames tx # just the named groups
node tools/vara-arq-test.js           # ARQ (LOSSY_SEEDS=3000 for upstream's full lossy sweep)
node tools/vara-host-test.js          # host protocol, two stations on an audio wire
node tools/vara-loopback-test.js      # mu-law 8 kHz audio path (no checkout needed)
node tools/vara-fm-test.js            # VARA FM: phy, receiver, ARQ, host (rx groups take minutes)
node tools/vara-worker-test.js        # the page's worker against a simulated firmware (no checkout needed)
tools/vara-page-native-check.sh       # /vara.html in headless Chrome against the native firmware
```

## What is ported (phase 1: HF physical layer)

| upstream file | in `data/vara-modem.js` |
|---|---|
| `xara-phy/src/{crc,rnd,seq,call,fec,constellation}.rs` | basics, bit-exact |
| `xara-phy/src/hf/level.rs`, `dat.rs` | level tables, record tables generated from the seed, bit-exact |
| `xara-phy/src/hf/{frame,ctrl,ctrl/code}.rs` | frames, control codebooks, bit-exact |
| `xara-phy/src/hf/{tx,fsk,psk,ofdm}.rs`, `ofdm.rs`, `cwid.rs` | modulators (radix-2 FFT: audio equal to rounding, not to the bit) |
| `xara-phy/src/turbo{.rs,/engine.rs,/float.rs}`, `decode.rs` | turbo decoder, float kernel, same windowing/segmenting |
| `xara-phy/src/{demap,eq,dsp,receiver}.rs` | demapper, equaliser, tracks, frame assembly |
| `xara-phy/src/hf/rx/{frontend,snr,fsk,psk,ofdm,ctrl,receiver}.rs` | receiver |
| `xara-phy/src/busy.rs` | busy detector (phase 2) |

## Phase 2: HF ARQ and host protocol

| upstream file | in |
|---|---|
| `xara-arq/src/{session,link,b2f,num,rng,time,host}.rs` | `data/vara-modem.js` |
| `xara-arq/src/textcomp.rs` + `textcomp.dict` | `data/vara-modem.js` (dictionary embedded verbatim) |
| `xara-arq/src/compression.rs` | `data/vara-modem.js`; own raw-DEFLATE decoder, FILES chunks are sent stored |
| `xara-arq/src/cq.rs`, `hf/broadcast.rs` (CQ part) | `data/vara-modem.js` |
| `xara-arq/src/hf/{session,adapt,frames,timing,turn}.rs` | `data/vara-modem.js` |
| `xara/src/station/{mod,hf,scheduler}.rs` | `data/vara-modem.js` (`HfStation`) |
| `xara-host/src/{command,response}.rs`, `xara/src/tnc.rs` | `data/vara-host.js` |

Not ported: `turbo/{fixed,simd}.rs` (ARM speed-ups of the same decoder),
`hf/rx/blind.rs` (only xara-monitor uses it), the registered-speed levels,
KISS/AX.25 unproto (`kiss.rs`, `ax25.rs`; only CQ frames are kept), DEFLATE on
the sending side of FILES compression, the TCP server and telemetry (the ESP32
bridge and the web page take their place). FM follows in a later phase
(docs/vara-implementace.md §4).

The tests are ports of upstream's own:

- `tools/vara-phy-test.js`: `crates/xara-phy/tests/*.rs` (`crc_call`, `rnd`,
  `seq`, `dat`, `levels`, `frames`, `turbo`, `ctrl`, `tx`, `tx_levels`,
  `cwid`, `rx_loop`). `rx_captures.rs` needs the VARA lab recordings, which
  are not public, and is not ported.
- `tools/vara-arq-test.js`: `crates/xara-arq/tests/{session,link,hf_timing,adapt,textcomp,edge_inputs}.rs`
  and `crates/xara-phy/tests/busy.rs`. The golden session transcript
  `tests/golden/hf_link.txt` is reproduced line for line except its seven
  FILES cases, whose frames carry miniz's DEFLATE output.
- `tools/vara-host-test.js`: `crates/xara-host/tests/{command,response}.rs`
  and `crates/xara/tests/host_protocol.rs` (two stations on an audio wire,
  in-memory host clients instead of TCP).
- `tools/vara-loopback-test.js` (no upstream counterpart): the WIFILT audio
  path, 48 kHz TX -> 8 kHz G.711 mu-law + noise -> 48 kHz RX, optionally with
  a path delay (`... 2300 30 4000 ulaw 500 p2p`).

## Phase 5: VARA FM

| upstream file | in `data/vara-modem.js` |
|---|---|
| `xara-phy/src/fm/{level,constellation,code,frame,ctrl,ctrl/code,tx}.rs`, `dat.rs` (FM tables) | FM physical layer, TX audio bit-exact |
| `xara-phy/src/fm/rx/{frontend,ctrl,ofdm,receiver}.rs` | FM receiver (the STFT in f32, as upstream) |
| `xara-arq/src/fm/{session,adapt,timing}.rs` | FM ARQ |
| `xara/src/station/fm.rs` | `FmStation`, same interface as `HfStation` |

Not ported: the FM digipeater (`fm/digi.rs`) and the broadcast frames
(`fm/broadcast.rs`, CQ and KISS over AX.25 in record 16), so `CQFRAME` answers
`WRONG` on FM. FM Wide reaches 5.7 kHz and runs on the 16 kHz radio link
(phase 6).

`tools/vara-fm-test.js` ports `crates/xara-phy/tests/fm_{tx,frames,rx}.rs`,
`crates/xara-arq/tests/fm_{vectors,session}.rs` and `crates/xara/tests/fm_host.rs`.
All 210 TX audio vectors are bit-exact. `fm_captures.rs` needs the lab
recordings; `fm_link.rs`, `fm_audio_link.rs`, `fm_broadcast.rs` and
`fm_digi*.rs` are not ported (the link is covered by `fm_host` and by
`tools/vara-worker-test.js` "fm narrow").

## Phase 6: FM Wide and the 16 kHz radio link

FM Wide needs no new port: `FM_WIDE` and its levels came with phase 5. What it
needs is audio up to 5.7 kHz. The XARA setting "16 kHz radio link" makes the
firmware ask the radio for 16 kHz µ-law in both directions. AUD1 offers the
16 kHz stream, and the worker for Mode "FM Wide" switches to it with
`rx.select`. Everything else still gets 8 kHz through a half-band decimator in
the firmware (docs/aud1-audio-websocket-protocol.md, "The 16 kHz radio link").
Without the setting, FM Wide reports that it needs it and stays silent.

Checks: `tools/vara-worker-test.js` "fm wide on the 16 kHz link" (the
simulated firmware starts at 8 kHz and switches on `rx.select`) and
`tools/aud1-16k-native-check.sh` (native firmware and fake radio: the setting
reconnects at 16 kHz, the tone survives the decimator, `rx.select`, TX as
320-byte packets, and back to 8 kHz).

## Phase 4: Winlink clients on TCP 8300/8301

`vara_host_bridge.h` (firmware) listens on the two VARA host ports and relays
both sockets to the XARA page over its AUD1 socket (`vara.host` frames,
docs/aud1-audio-websocket-protocol.md); the worker feeds them to the same
`Tnc` the page uses (`xara-host/src/server.rs`'s rules: one client per port,
either ending closes both). The page has to be open: with no XARA page holding
the radio, a client is refused. Replies to the page's own commands are kept
from the client, which pairs each command with one reply.

## Phase 3: the page

`data/vara-worker.js` runs one `HfStation` + `Tnc` on the AUD1 socket: the RX
sample clock (AUD1 `firstSample`) is the modem's clock, and every keyed
stretch of the station's output is one AUD1 transmission (`tx.prepare`,
`tx.extend`, FIRST/LAST). The one addition to the port for it is
`HfStation.keyed`, a per-sample keying mask filled in `keyBlock`.
`data/vara.html`/`vara.js`/`vara.css` are the page; it drives the modem with
the same host commands a Winlink client sends.

Latency is the limit to know about. The station is told its whole audio round
trip (upstream's `tx_latency`); what VARA does not forgive is a slow *peer*.
A Winlink-timing caller waits about 200 ms of round trip for the answerer, a
P2P/chat one about 500 ms (`tools/vara-loopback-test.js` with a delay). WIFILT
calling out works with any latency it has; answering a Winlink-timing call
needs a round trip under ~200 ms, which the AUD1 path (TX slot alone is
100 ms minimum) does not reach. P2P and chat answer fine.
