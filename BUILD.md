# WIFILT — Building from source

Everything needed to build and flash WIFILT is in this repository. Most people never need
this file: the [web installer](https://ok1hra.github.io/wifilt/) writes a released build to
a blank ESP32 in about a minute, and [HARDWARE.md](HARDWARE.md) describes that route.

The firmware and the web assets are built separately, and the JS8 modem separately again —
a change to a page does not require the WASM toolchain.

## Contents

1. [Firmware](#1-firmware)
2. [Web assets](#2-web-assets)
3. [Flashing what you built](#3-flashing-what-you-built)
4. [The web installer page](#4-the-web-installer-page)
5. [JS8 modem (WebAssembly)](#5-js8-modem-webassembly)
6. [Tests](#6-tests)
7. [Documentation in `docs/`](#7-documentation-in-docs)

---

## 1. Firmware

| Requirement | Version |
|---|---|
| Arduino IDE | 1.8.19 or 2.x |
| Espressif Arduino-ESP32 core | **2.0.14** |
| Board | **ESP32 Dev Module** |
| Partition Scheme | **No OTA (2MB APP/2MB SPIFFS)** |
| Library | [TrxNet 0.3.0](https://github.com/ok1hra/TrxNet) |
| Flash mode | **DIO**, not QIO |

Two of those need explaining.

**The partition scheme menu choice is almost irrelevant.** A sketch-local `partitions.csv`
sits next to `wifilt.ino` and overrides the menu; that file is what actually lands on the
device. It defines five partitions rather than the stock four, the extra one being `cfg`,
where the operator's configuration lives so that a firmware update cannot erase it. See the
comments in [partitions.csv](partitions.csv) — they explain why the sizes are what they are,
and the arithmetic that must be re-checked if they ever change.

**Flash mode must be DIO.** The RemoteQTH interface boards ship a Zbit (`0x5e`) clone flash
chip whose QIO reads are unreliable: a QIO bootloader makes the ROM loader read garbage
after the first segment, and the board never boots at all. DIO at 80 MHz is stable. The
bootloader's flash mode is baked in at `elf2image` time and cannot be patched afterwards,
because its SHA-256 digest covers it.

Release procedure:

```bash
# 1. bump REV in wifilt.ino  (it is a date: #define REV 20260809)
# 2. Arduino IDE: Sketch → Export Compiled Binary
```

---

## 2. Web assets

The device serves pre-compressed copies of everything in `data/`. **Editing a source
`.js`, `.css` or `.html` changes nothing on the device until the compressed copies are
regenerated** — the firmware prefers the `.br` or `.gz` next to the file, and the
`.min.js` / `.br` products are not tracked in git.

```bash
node ./tools/stamp-asset-versions.js  # re-derive every ?v= from the asset's content
./tools/minify-spiffs-js.sh           # produce data/*.js.min
./tools/gzip-assets.sh                # produce the .br/.gz the device actually serves
```

Run these **in this order** after every edit under `data/`, before uploading the filesystem
or building the installer page. The order is not cosmetic: the stamper rewrites `data.js`
(its `ASSET_REV`) and every `.html`, and those are exactly the files the other two consume.

The stamper is what keeps a browser from running an old script against a new page. The
firmware serves `.html` as `no-cache, no-store` but `.js`/`.css` as `public, max-age=3600`,
so for up to an hour after a flash the two halves of a page can disagree. Hand-written
version dates lost that race on 2026-08-11 — 21 of 41 tags on `data.html` were already
pointing at a version older than their own source, and nine local assets carried no `?v=`
at all. Every version is now the first 8 hex of the asset's own SHA-256, so only what
actually changed is re-downloaded. `--check` writes nothing and fails if anything is out of
date, which is the form to put in front of a release build:

```bash
node ./tools/stamp-asset-versions.js --check
```

---

## 3. Flashing what you built

```bash
# firmware and filesystem in one esptool session
./tools/upload-firmware-spiffs.sh --port /dev/ttyUSB0

# validate both images without writing anything
./tools/upload-firmware-spiffs.sh --dry-run

# a slow or marginal USB link
./tools/upload-firmware-spiffs.sh --port /dev/ttyUSB0 --baud 460800
```

The script builds the LittleFS image for the partition named `spiffs`, verifies the
partition table already on the device before it writes anything, and deliberately leaves
the bootloader, the partition table and the `cfg` partition alone. `tools/upload-spiffs.sh`
uploads only the filesystem.

The very first flash of a blank board is the exception: it needs the bootloader and
partition table too, which is what the web installer writes.

---

## 4. The web installer page

`tools/gh-pages.sh` builds the esp-web-tools installer published at
<https://ok1hra.github.io/wifilt/>. It reads the partition geometry from `partitions.csv`
rather than repeating it, builds the LittleFS image from `data/`, and writes
`build/gh-pages/` — a generated directory, not tracked here.

```bash
./tools/gh-pages.sh              # build only
./tools/gh-pages.sh --publish    # build and push to the gh-pages branch
```

The page has no "what does this release do to your configuration" switch, on purpose. The
esp-web-tools dialog already asks the only question that decides it — its *Erase device*
checkbox — and the page explains that checkbox instead of guessing on the operator's
behalf. Unticked writes bootloader, partition table, firmware and assets and touches
neither `cfg` nor NVS; ticked erases the whole chip.

---

## 5. JS8 modem (WebAssembly)

Only needed when the JS8 DSP sources or the pinned upstream change. The built artifacts are
committed in `data/`, so a normal contributor never runs this.

Debian 12 packages:

```bash
sudo apt install build-essential ca-certificates cmake dpkg-dev emscripten \
  git gzip libboost1.81-dev libfftw3-dev nodejs p7zip-full python3 \
  terser xz-utils

./tools/build-js8-assets.sh
```

Enable the matching Debian `deb-src` entries first — the pinned FFTW is built from source.

Pinned versions: Emscripten 3.1.6, CMake 3.25.1, Node 18.20.4 (local checks accept Node
18–20). See [docs/js8call-build.md](docs/js8call-build.md) and
`prototype/js8-core-prototype/toolchain/toolchain.lock`.

---

## 6. Tests

The regression harnesses need no radio and no hardware. They are plain Node scripts; the
browser ones start headless Chrome themselves.

```bash
node tools/wspr-encoder-smoke.js        # encoder against WSJT-X golden vectors
node tools/js8-txqueue-smoke.js         # JS8 transmit queue and retry TTL
node tools/state-json-budget-smoke.js   # /state cannot overflow its buffer
```

There are around forty more in `tools/`, covering the same ground the pages do:

| Area | Harnesses |
|---|---|
| JS8 | `js8-aprs-`, `js8-data-frames-`, `js8-email-`, `js8-file-transfer-`, `js8-groups-`, `js8-modem-failure-`, `js8-session-browser-`, `js8-settings-`, `js8-txqueue-` |
| WSPR | `wspr-audio-`, `wspr-browser-`, `wspr-encoder-`, `wspr-log-`, `wspr-schedule-`, `wspr-settings-`, `wspr-tx-pacing-` |
| TX gain | `tx-gain-cal-`, `tx-gain-mod-level-`, `tx-gain-plan-`, `txgain-store-` |
| Setup and identity | `setup-radio-contract-`, `setup-spine-`, `station-identity-`, `station-profile-`, `check-identity-consistency.sh` |
| Storage and sync | `config-backup-`, `datasync-completion-`, `fs-partition-audit.js` |
| Pages | `data-browser-smoke.js`, `installer-page-smoke.js`, `check-page-scripts.js`, `wake-lock-` |
| Documentation | `ui-inventory.js --check SOFTWARE.md` — reports every control the manual does not mention |

`tools/icom-lan-login-test.py` talks to a real radio from a PC, which makes it the quickest
way to check CI-V behaviour without flashing anything:

```bash
python3 tools/icom-lan-login-test.py --ask
```

---

## 7. Documentation in `docs/`

`docs/` holds the maintainer's working notes, and most of them are **not** published: the
`.gitignore` treats `docs/*.md` as an allowlist, so a new note stays private until it is
named there. Only English documents that something in the repository links to belong in
that list.

The published set:

| Document | Subject |
|---|---|
| [docs/trx-http-api.md](docs/trx-http-api.md) | the HTTP API between the web log and a TRX, and what an adapter for TRX2/TRX3 must implement |
| [docs/aud1-audio-websocket-protocol.md](docs/aud1-audio-websocket-protocol.md) | the versioned RX/TX audio WebSocket envelope |
| [docs/wspr.md](docs/wspr.md) | the WSPR protocol as implemented by the beacon |
| [docs/trxnet.md](docs/trxnet.md) | the TrxNet peer-to-peer transport |
| [docs/find-device-ip.md](docs/find-device-ip.md) | every way to locate the interface on your network |
| [docs/js8call-build.md](docs/js8call-build.md) | rebuilding the JS8 modem from source |

Comments in the sources and entries in [Changelog.md](Changelog.md) sometimes cite a design
note such as `docs/wspr-majak-implementace.md`. Those are the maintainer's Czech working
notes, kept out of the repository on purpose; they record *why* a decision was taken, and
the decision itself is always readable from the code they annotate.

---

*Hardware: [HARDWARE.md](HARDWARE.md). Using the web interface: [SOFTWARE.md](SOFTWARE.md).*
