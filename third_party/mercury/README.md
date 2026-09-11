# Mercury ARQ engine — WIFILT's modifications

`data/mercury-host.wasm` and `data/mercury-worker.js` are distributed binaries built
from GPL-3.0-or-later source that WIFILT **modifies**. That source is not vendored
here in full: it is upstream's own git tree, pinned by commit, plus the patch in this
directory. Together the two are the complete corresponding source for those binaries.

```
upstream: https://github.com/Rhizomatica/mercury
branch:   mercuryv2
commit:   8be5acd4b9ed5f7b6216694173a3bd000a74302e   ("Backport ffaudio latest changes", 2026-07-28)
patch:    wifilt-arq-changes.patch
```

To reproduce:

```sh
git clone https://github.com/Rhizomatica/mercury
cd mercury && git checkout 8be5acd4b9ed5f7b6216694173a3bd000a74302e
git apply /path/to/wifilt/third_party/mercury/wifilt-arq-changes.patch
```

then build the WASM modules with `prototype/mercury-prototype/build-host-wasm.sh` and
`build-worker-wasm.sh`, which read the checkout from `mercury/` at the repo root (that
path is gitignored: the clone is upstream's own git tree, kept out of this repository
deliberately, which is why the commit above is pinned here instead).

## What the patch changes

Three additions to `datalink_arq/`, all found by live two-station HF testing and all
off by default so upstream's own unit and sim tests stay bit-for-bit deterministic:

* **`arq_data_retry_jitter_pct`** (`arq_protocol.c/.h`, applied across `arq_fsm.c`) —
  every retry and ACK deadline in the FSM was derived from a fixed per-mode timing
  table, identical on both stations, so two peers could collide on every attempt
  indefinitely. `arq_protocol_jitter_retry_s()` spreads each freshly derived deadline
  by ±N %. Default 0 = no jitter and no `rand()` call at all.
* **`arq_mode_ceiling_rank`** (`arq_protocol.h`, `select_best_mode()` /
  `clamp_payload_mode_to_bandwidth()` in `arq_fsm.c`) — a runtime ceiling on the mode
  this station proposes stepping up to. Default is unlimited; WIFILT's own DATAC3
  ceiling is applied from the JS layer (`data/mercury-tuning.js`), not from here.
* **reactive CALL/ACCEPT resend and a broadened RX mode-follow** (`arq_fsm.c`) — an
  ACCEPT is resent on the event rather than only on the blind timer, and the RX
  demodulator follows the peer's mode in every state that can legitimately receive
  payload, not only `IDLE_IRS`.

`tests/sim/test_arq_sim.c` is patched with the matching upstream-style coverage.

Licence: GNU GPL version 3 or later, as upstream. Copyright (C) 2025 Rhizomatica,
author Rafael Diniz <rafael@riseup.net>; the modifications above are
Copyright (C) 2026 OK1HRA <ok1hra@gmail.com> and are under the same licence.
