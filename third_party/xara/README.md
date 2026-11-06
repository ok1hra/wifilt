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

Not ported: `turbo/{fixed,simd}.rs` (ARM speed-ups of the same decoder),
`hf/rx/blind.rs` (only xara-monitor uses it), the registered-speed levels.
FM, the ARQ session and the host protocol follow in later phases
(docs/vara-implementace.md §4).

The tests in `tools/vara-phy-test.js` are ports of `crates/xara-phy/tests/*.rs`
(`crc_call`, `rnd`, `seq`, `dat`, `levels`, `frames`, `turbo`, `ctrl`, `tx`,
`tx_levels`, `cwid`, `rx_loop`). `rx_captures.rs` needs the VARA lab recordings,
which are not public, and is not ported.
