# WIFILT — Building from source

Everything needed to build and flash WIFILT is in this repository. Most people never need
this file: the [web installer](https://ok1hra.github.io/wifilt/) writes a released build to
a blank ESP32 in about a minute, or hands you a Linux, Raspberry Pi or Windows binary that
needs no hardware at all — [HARDWARE.md](HARDWARE.md) and
[SOFTWARE.md § 1.5](SOFTWARE.md#15-where-it-runs) describe those routes.

The firmware, the native Linux/Windows/ARM64 build, the web assets and the JS8 modem are all
built separately — a change to a page does not require the WASM toolchain, and a change to
the sketch does not require touching `native/`.

## Contents

1. [Firmware](#1-firmware)
2. [Web assets](#2-web-assets)
3. [Flashing what you built](#3-flashing-what-you-built)
4. [Native build: Linux, Windows and Raspberry Pi (ARM64)](#4-native-build-linux-windows-and-raspberry-pi-arm64)
5. [The web installer page](#5-the-web-installer-page)
6. [JS8 modem (WebAssembly)](#6-js8-modem-webassembly)
7. [Tests](#7-tests)
8. [Documentation in `docs/`](#8-documentation-in-docs)

---

## 1. Firmware

The firmware builds with **PlatformIO**, which pins the toolchain and fetches the
one external library for you. `platformio.ini` defines two ESP32 boards from the
single `wifilt.ino`:

| Environment | Board | Hardware |
|---|---|---|
| `esp32` | ESP32 Dev Module (`esp32dev`) | the RemoteQTH box or a bare ESP32-WROOM |
| `m5atom` | `m5stack-atom` | M5Stack **Atom Lite** (ESP32-PICO-D4, 4 MB) |

```bash
pip install platformio          # once
pio run                         # build both boards
pio run -e m5atom               # build only the Atom Lite
pio run -e esp32 -t upload      # build and flash the box over USB
```

The images land in `.pio/build/<env>/firmware.bin`. Everything below is pinned in
`platformio.ini` and needs no board-manager clicking:

| Requirement | Value |
|---|---|
| PlatformIO platform | **espressif32 @ 6.5.0** (arduino-esp32 **2.0.14**) |
| Partition table | sketch-local `partitions.csv` (`board_build.partitions`) |
| Library | [TrxNet](https://github.com/ok1hra/TrxNet) (fetched from `lib_deps`) |
| Flash mode | **DIO**, not QIO (`board_build.flash_mode`) |

> The Atom Lite is a **bare-module** build: same firmware and capabilities as the
> box, with the band decoder auto-disabled at runtime (no hardware-revision
> divider). It differs only in the status LED — it has no plain LED on GPIO 5 but
> a single SK6812 RGB on GPIO 27, selected by the `WIFILT_M5ATOM_LITE` build flag.
> See [HARDWARE.md § 6](HARDWARE.md#6-status-led).

PlatformIO is the primary path for local development (and the only one that
builds the M5Atom). CI still compiles the box with `arduino-cli`, and the
**release binary** is still produced with the Arduino IDE 1.8 by
`tools/export-compiled-binary.sh` (see the release procedure below), which
performs the same DIO and partition-fit checks. All three build the same
`wifilt.ino` with the same core version, so their output is equivalent.

Two of the pinned values need explaining.

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
tools/release.sh
```

One script walks the whole chain and asks before every phase. Enter takes the capitalised
default, so answering nothing builds the firmware and the desktop archives and installs
them on this computer — and still touches neither the radio hardware, nor git, nor the web:

| # | Phase | Default | What it does beyond running the command |
|---|---|---|---|
| 1 | `REV` → today's date | `y/N` | asked only when the two differ; a REV in the future is left alone |
| 2 | export compiled binary | `Y/n` | `tools/export-compiled-binary.sh`, described below |
| 3 | `make -C native dist` | `Y/n` | clears archives of other revisions first, so `SHA256SUMS` describes exactly what ships |
| 4 | `tools/native-integration-test.sh` | `y/N` | offers `make -C native setcap`; without it the audio half of the test silently does not run |
| 5 | run `./native/build/wifilt --data-dir data` | `y/N` | offers the capability first, and gives the binary its own process group, so the Ctrl-C that stops it does not end the release run |
| 6 | install this build on this computer | `Y/n` | unpacks the phase-3 archive and runs its `install.sh`; stops a running `wifilt.service` first, because `install(1)` cannot write over a binary that is executing |
| 7 | `tools/upload-firmware-spiffs.sh` | `y/N` | picks the port from a numbered list carrying each device's `by-id` name, and flashes the `by-id` path |
| 8 | `git commit` / `git push` | `y/N` ×2 | re-stamps the assets first, and compares REV against the Changelog |
| 9 | `tools/gh-pages.sh --publish` | `y/N` | refuses unless the tree is clean and `HEAD` is `origin/main` |

The order of the last two is deliberate. `gh-pages.sh` publishes from a throwaway git
repository, so it will happily put a build of source that exists nowhere onto a public
page; publishing after the push, and only when `HEAD` is what `origin/main` holds, makes
every released page point at source anyone can fetch. `--force` is the one way past that,
and past the guards that check the firmware is newer than its sources and that
`native/dist` holds archives for this REV — each of which is a way the page could end up
describing something that does not exist.

Phases 2, 3, 6, 7, 8 and 9 end the run when they fail — they build something, write to the
computer, to the board, or outward. Phases 4 and 5 are looks rather than steps, so a
failure there asks whether to carry on. Nothing is offered on a branch other than `main`
from phase 8 onwards.

Phase 5 has three wrinkles worth knowing before they surprise you.

Ctrl-C makes the native binary print `shutting down` and then die on `terminate called
without an active exception` — a thread left unjoined in its shutdown path. The script
names it and carries on rather than asking, and the summary keeps the phase yellow so it
is not forgotten.

`http://wifilt.local` may not reach the binary even though it announces exactly that name.
`nsswitch.conf` reads `hosts: files mdns4_minimal …`, so a single line in `/etc/hosts`
outranks the responder and no mDNS query is ever made; if that line points at the hardware
on a network this machine is not on, the result looks precisely like a web server that
does not work. The script prints the addresses that do work and says so when the name
resolves somewhere else.

`getcap` lives in `/sbin`, which is not on a normal user's `PATH` on Debian. Calling it by
name alone reports "no capability" for a binary that has one, and asks for a sudo password
that changes nothing — so the script looks in `/sbin` and `/usr/sbin` too, and says openly
when it cannot check at all.

By hand it is still two steps — bump `REV` in `wifilt.ino`, then Arduino IDE:
Sketch → Export Compiled Binary — and step 2 has a headless equivalent, for when the
release is built from a terminal or a script:

```bash
tools/export-compiled-binary.sh            # ARDUINO_IDE=/path/to/arduino-1.8.19 if not found
tools/export-compiled-binary.sh --clean    # from scratch, ignoring the incremental build
```

It drives the IDE's own command line (`arduino --verify`) with the FQBN the CI job uses,
then makes the copy that *is* the export — `recipe.output.save_file` in the core's
`platform.txt` renames `wifilt.ino.bin` to `wifilt.ino.esp32.bin`, and nothing else. The
result was checked against an IDE export of the same source: the two images differ only in
the embedded ELF SHA-256 and the image digest that covers it, which change with the build
path. The code is identical.

Three things it does that the IDE does not:

* it builds in `build/arduino/` with its own settings folder in `build/arduino-settings/`,
  so an open IDE cannot change what is built and the script cannot rewrite the IDE's
  preferences. (`--preferences-file` moves Arduino's whole settings folder next to that
  file, hence the `packages` symlink back to `~/.arduino15`.)
* it fails if the image is not DIO. The flash mode is one word of the FQBN and a QIO image
  bricks the boards silently — see above.
* it reports the size against `app0` of the sketch-local `partitions.csv`, not against the
  menu scheme. The IDE's "Sketch uses 48%" is measured against the 2 MB the menu promises;
  the device gives the app 1.375 MB.

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

## 4. Native build: Linux, Windows and Raspberry Pi (ARM64)

The same `wifilt.ino`, the same `data/`, compiled as a PC program instead of firmware. A
browser cannot tell the two apart — same HTTP API, same WebSocket ports, same assets, and
the same address, `http://wifilt.local`. Scope is IP only: **ICOM LAN and TrxNet.** There is
no serial port and no GPIO on a PC, so CI-V over a wire, FSK/RTTY keying, the status LED, the
switched 13.8 V output and the band decoder stay hardware-box features — CAT itself is
unaffected, because ICOM LAN carries CI-V on its own UDP channel. `platform_caps.h` names the
differences once, `/setup-data.json` reports them to the browser, and SETUP hides what cannot
work rather than presenting a control that saves into nothing.

Everything lives in `native/`, which the Arduino builder ignores. It supplies `WebServer`,
`WiFiClient`/`Server`/`UDP`, `EEPROM` over a file, `LittleFS` over a directory, an mDNS
responder and five FreeRTOS primitives; `String`, `Print`, `Stream` and `IPAddress` are taken
verbatim from the ESP32 core (LGPL — see [native/arduino/NOTICE.md](native/arduino/NOTICE.md)),
because a hand-written replacement would differ from the box in edge cases that matter. The
sketch is compiled with `ARDUINO` still defined — the native build is the second real target
for the same source, not a fork of it.

```bash
make -C native            # Linux binary: native/build/wifilt
make -C native win        # Windows .exe, cross-compiled with mingw-w64: native/build-win/wifilt.exe
make -C native arm64      # 64-bit Raspberry Pi OS, cross-compiled: native/build-arm64/wifilt
make -C native run        # build and run against ./native/_run as the config directory, port 8080
make -C native setcap     # grant cap_net_bind_service — redo after every rebuild, it lives on the inode
```

Requirements: `g++`/`gcc` with C++17 for the Linux target; for the Windows cross-build,
`x86_64-w64-mingw32-g++-posix` / `-gcc-posix` — the **posix** thread variant specifically,
because Debian's default `win32` variant has no `std::thread`, `std::mutex` or
`std::condition_variable`, which the FreeRTOS shim is built from; for the Raspberry Pi
cross-build, `aarch64-linux-gnu-g++`/`-gcc` (Debian/Ubuntu package `g++-aarch64-linux-gnu`).
`TRXNET_DIR` defaults to `$(HOME)/Arduino/libraries/TrxNet/src`; override it if the library
lives elsewhere.

The `arm64` binary is cross-compiled against the *build machine's* glibc (via
`libc6-dev-arm64-cross`), not the target Pi's. That has never mattered for a same-vintage
Debian/Ubuntu pair, but a release built on a much newer distro than the Pi is running could
produce a binary that asks for a glibc symbol version the Pi does not have. Verify a new
`arm64` release on real Raspberry Pi OS hardware before wide announcement — the same caution
this project already applies to anything marked "needs on-radio check".

Ports 80, 82 and 83 are all privileged, and 83 carries the audio — no `AUD1` channel means no
JS8 and no WSPR. The Windows binary needs nothing extra to bind them; on Linux the capability
above is required and is stored on the binary's inode, so it is lost on every rebuild.

```bash
make -C native dist       # all three: native/dist/wifilt-<REV>-linux-x86_64.tar.gz
                           #            native/dist/wifilt-<REV>-windows-x64.zip
                           #            native/dist/wifilt-<REV>-linux-arm64.tar.gz
                           #            + SHA256SUMS
```

`dist` builds the web assets through `tools/prepare-spiffs-tree.sh` rather than copying
`data/` — the same re-derived `?v=` tags, minified and compressed, that the ESP32 image
ships, so the PC binary serves byte-for-byte the same pages. `VERSION` is read from the same
`#define REV` the firmware carries: the binary and the box must never be able to claim
different versions of the same source.

Installing what `dist` produces:

| | Linux (`tar.gz`) | Raspberry Pi (`tar.gz`) | Windows (`.zip`) |
|---|---|---|---|
| Unpack | `tar xzf wifilt-*-linux-x86_64.tar.gz` | `tar xzf wifilt-*-linux-arm64.tar.gz` | any zip tool |
| Run without installing | `sudo ./wifilt` | `sudo ./wifilt` | double-click `wifilt.exe` |
| Install | `sudo ./install.sh` → `/opt/wifilt` | `sudo ./install.sh` → `/opt/wifilt` | — nothing to install, the `.exe` is fully static |
| Privilege | `install.sh` grants `cap_net_bind_service`; redone on every upgrade | same as Linux | none — first run, allow it through the Windows Firewall prompt |
| Autostart | a `systemd` unit is written but **not enabled** — starting a transmitter's control interface at boot is a decision, not a side effect of installing | same as Linux | — |
| Configuration | `~/.config/wifilt`; reinstalling never touches it, same guarantee as the box's `cfg` partition surviving a firmware update | same as Linux | next to the `.exe` |

Not code-signed, so Windows SmartScreen may warn on first run (*More info* → *Run anyway*);
neither archive is signed, so `SHA256SUMS` beside them is the way to check a download rather
than take it on trust.

`tools/native-integration-test.sh` runs the whole chain against a fake radio — RS-BA1
handshake, CI-V reaching `/state`, and the `AUD1` audio WebSocket when the binary can bind
port 83 — with no radio and nothing on the air. `.github/workflows/build.yml` builds all
four targets, ESP32, Linux, Linux ARM64 and Windows, on every push — the ARM64 job runs on a
real GitHub-hosted ARM64 runner and exercises the same integration test natively, not the
`arm64` cross-compile target above (which exists for `tools/release.sh`, run from an x86_64
machine — see the glibc caveat above).

---

## 5. The web installer page

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

## 6. JS8 modem (WebAssembly)

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

## 7. Tests

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

## 8. Documentation in `docs/`

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
