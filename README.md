# WIFILT — Web interface for Icom LAN Transceivers

> Icom is a registered trademark of Icom Incorporated. WIFILT is an independent software project
> and is not affiliated with, endorsed by, or sponsored by Icom Incorporated.

## Key features
- running on ESP32
- connects to the radio over Icom network control (LAN/WLAN) — commands and bidirectional audio, no wire to the radio
- CI-V and TrxNet transports for radios without network control; up to three transceivers (TRX1–TRX3)
- the radio model is read from the radio itself, so power limits and setup guidance follow whichever transceiver is connected
- QRPlog web based (multiplatform) logbook
- logbook database stored directly in web browser
- works decentralized/offline, without internet usable on portable
- logbook import/export function
- network synchronization between web browsers in local network - same database on multiple devices (phone, tablet, pc)
- integrated DX cluster client and band map
- option to backup settings or entire logbook database
- self-healing WiFi — escalating recovery (targeted reconnect → radio reset → automatic restart)
- red OFFLINE warning in the web page top bar when the browser loses connection to the interface

<img src="https://raw.githubusercontent.com/ok1hra/wifilt/main/docs/LOG.png" height="400"><img src="https://raw.githubusercontent.com/ok1hra/wifilt/main/docs/DXC.png" height="400">

<img src="https://raw.githubusercontent.com/ok1hra/wifilt/main/docs/SETUP.png" height="300"><img src="https://raw.githubusercontent.com/ok1hra/wifilt/main/docs/LOGSYNC.png" height="300">

## Hardware required
- an Icom transceiver with network remote control. **IC-705 is the tested model.** IC-7610, IC-9700, IC-7300MK2 and IC-7760 provide the same Network Control and LAN AF/IF audio functions and are expected to work, but have not been verified on air yet.
- any ESP32 or RemoteQTH interface for extended functions
- web client (phone/tablet/pc)

## Firmware web installer
- First plug USB-C between ESP32 and PC
- Then open the Firmware page and follow the instructions https://ok1hra.github.io/wifilt/

**Upgrading a device that already works? Save its configuration first** — ```SETUP / Download config```.
A flash replaces the filesystem, so the TRX slot configuration, the LOG and JS8 settings, **every TX
audio gain calibration**, the CW and frequency memories and the MSG BOX are lost. WiFi networks,
callsign, locator and the radio's LAN credentials live in NVS and survive. Your QSO log is stored in
the browser, not on the device, so a flash cannot touch it.

## Quick start guide
1. Upload the firmware (see above).
2. Connect a phone or PC to the WiFi network ```WIFILT-AP```, password ```remoteqth```.
3. Open http://192.168.4.1 — some phones open the setup page by themselves.
4. Restoring a backup? Do it now, with ```Upload config``` at the bottom of the setup page, before
   setting anything by hand.
5. Enter your WiFi network name and password, then save. The device joins your network while its
   hotspot is still running and **shows the address it was given, with a QR code** — scan it or write
   it down, because the hotspot closes when the device restarts.
6. On the radio, enable ```Network Control``` and set a network user and password — see
   [docs/user-manual.md](docs/user-manual.md).
7. Reconnect your phone or PC to your normal WiFi, open the address from step 5, and in
   ```SETUP / Radio``` set TRX1 to ```ICOM-LAN```, enter the radio address and credentials, and press
   ```Test & identify radio```.

Lost the address? See [Find IP address](#find-ip-address).

## Find IP address

The interface shows its own address on the handover screen right after it joins your WiFi, and
http://wifilt.local usually works from then on. Give the device a fixed lease in your router and the
address stops moving. If neither is available:

### via Arduino IDE
- Open terminal in Arduino IDE
- Set Baudrate to 9600
- Press ? and Enter
- Read IP address from terminal debug
<img src="https://raw.githubusercontent.com/ok1hra/wifilt/main/docs/cli.png" height="500">

### via Terminal
- Turn on the interface
- Wait for the Status LED to turn off, which signals the Wifi connection
- In the terminal window, use the command ```ping wifilt.local``` - the output will show the IP address that the interface received from the DHCP server

### via your router
- Look for the DHCP lease named ```wifilt``` in the router's client list

## Documentation
- [docs/user-manual.md](docs/user-manual.md) — setup, web UI, CW/RTTY, MQTT, troubleshooting
- [docs/find-device-ip.md](docs/find-device-ip.md) — every way to locate the interface on your network
- [docs/trx-http-api.md](docs/trx-http-api.md) — the HTTP API between the web log and a TRX, and what an adapter for TRX2/TRX3 must implement
- [docs/aud1-audio-websocket-protocol.md](docs/aud1-audio-websocket-protocol.md) — the versioned RX/TX audio WebSocket envelope
- [docs/wspr.md](docs/wspr.md) — the WSPR protocol as implemented by the beacon
- [docs/trxnet.md](docs/trxnet.md) — the TrxNet peer-to-peer transport
- [docs/js8call-build.md](docs/js8call-build.md) — rebuilding the JS8 modem from source

Comments in the sources and entries in [Changelog.md](Changelog.md) sometimes
cite a design note such as `docs/wspr-majak-implementace.md`. Those are the
maintainer's Czech working notes, kept out of the repository on purpose; they
record *why* a decision was taken, and the decision itself is always readable
from the code they annotate. The documents listed above are the published ones.

<img src="https://raw.githubusercontent.com/ok1hra/wifilt/main/hw/sw-block.png">

## Building from source

Everything needed to build and flash the project is in this repository. The
firmware and the web assets are built separately — a normal change to a page
does not require the WASM toolchain.

### Firmware and web assets

- Arduino IDE 1.8.19 or 2.x
- Espressif Arduino-ESP32 core **2.0.14**
- Board: **ESP32 Dev Module**, Partition Scheme **No OTA (2MB APP/2MB SPIFFS)**
  — the sketch-local `partitions.csv` overrides the menu choice and is what
  actually lands on the device
- Library: [TrxNet 0.3.0](https://github.com/ok1hra/TrxNet)
- Flash mode is **DIO**, not QIO. These interface boards ship a Zbit clone flash
  chip whose QIO reads are unreliable, and a QIO bootloader leaves the board
  unable to boot.

```bash
# 1. bump REV in wifilt.ino
# 2. Arduino IDE: Sketch → Export Compiled Binary
# 3. flash the firmware and the filesystem in one session
./tools/upload-firmware-spiffs.sh --port /dev/ttyUSB0
./tools/upload-firmware-spiffs.sh --dry-run          # check without writing

# after editing data/*.html, *.css or *.js, regenerate the served copies
./tools/gzip-assets.sh
```

### Web installer page

`tools/gh-pages.sh` builds the esp-web-tools installer published at
https://ok1hra.github.io/wifilt/ — it reads the partition geometry from
`partitions.csv`, builds the LittleFS image from `data/`, and writes
`build/gh-pages/` (a generated directory, not tracked here):

```bash
./tools/gh-pages.sh              # build only
./tools/gh-pages.sh --publish    # build and push to the gh-pages branch
```

### JS8 modem (WASM)

Only needed when the JS8 DSP sources or the pinned upstream change; the built
artifacts are committed in `data/`. Requires Debian 12 packages:

```bash
sudo apt install build-essential ca-certificates cmake dpkg-dev emscripten \
  git gzip libboost1.81-dev libfftw3-dev nodejs p7zip-full python3 \
  terser xz-utils

./tools/build-js8-assets.sh
```

Pinned versions: Emscripten 3.1.6, CMake 3.25.1, Node 18.20.4 (local checks
accept Node 18–20). See [docs/js8call-build.md](docs/js8call-build.md) and
`prototype/js8-core-prototype/toolchain/toolchain.lock`.

### Tests

The regression harnesses need no radio and no hardware:

```bash
node tools/wspr-encoder-smoke.js      # encoder vs. WSJT-X golden vectors
node tools/js8-txqueue-smoke.js       # JS8 transmit queue and retry TTL
node tools/state-json-budget-smoke.js # /state cannot overflow its buffer
```

## Hardware
- **Output signal POWER-OUT** (13.8V/0.5A) with LED activates after connecting a full-CAT primary radio (can turn on your hamshack)
- **Galvanically isolated CI-V output** for connecting PA or other devices
- Power consumption < 1W
- RTTY operation

[![RTTY + PTT keying](https://raw.githubusercontent.com/ok1hra/wifilt/main/hw/rtty-key.png)](https://youtube.com/shorts/b0uTiIwEsbw)

### Status LED
- Fade in/out - WiFi in AP mode
- WiFi in client mode
    - ON waiting connected to WiFi
    - OFF Wifi connected to AP
    - FLASH send MQTT freq
    - DOUBLE FLASH receive CW via UDP
    - FLASH+PTT receive RTTY via UDP

### Connection
<img src="https://raw.githubusercontent.com/ok1hra/wifilt/main/hw/hw-block.png" height="250">

### Connectors
- 13,8V DC jack
- KEY stereo jack
- SEND/ALC stereo jack
- USB-C
- ACC RJ45

### PCB
- [Schematic rev3 PDF](https://raw.githubusercontent.com/ok1hra/wifilt/main/hw/IC-705-interface-03.pdf)
- [BOM rev3 html](https://raw.githubusercontent.com/ok1hra/wifilt/main/hw/IC-705-interface-ibom-03.html)

### 3D prit case
<img src="https://raw.githubusercontent.com/ok1hra/wifilt/main/3Dprint/preview.png" height="200"><img src="https://raw.githubusercontent.com/ok1hra/wifilt/main/3Dprint/preview-mountpoint.png" height="200">

- [Source rev3 OpenScad](https://raw.githubusercontent.com/ok1hra/wifilt/main/3Dprint/ic-705-interface-3.scad)
- [rev3 STL](https://raw.githubusercontent.com/ok1hra/wifilt/main/3Dprint/ic-705-interface-3.stl)
- [rev3 3MF](https://raw.githubusercontent.com/ok1hra/wifilt/main/3Dprint/ic-705-interface-3.3mf)
- [With mountpoint rev3 STL](https://raw.githubusercontent.com/ok1hra/wifilt/main/3Dprint/ic-705-interface-3-mountpoint.stl)
- [With mountpoint rev3 3MF](https://raw.githubusercontent.com/ok1hra/wifilt/main/3Dprint/ic-705-interface-3-mountpoint.3mf)

## License

WIFILT is free software, distributed under the **GNU General Public License,
version 3 or later** — see [LICENSE](LICENSE). It builds on other people's GPL
work, and this repository is the corresponding source for every binary the
project distributes, including the firmware and filesystem images served by the
web installer.

The parts that came from elsewhere, with their own copyright and licence, are
listed in [data/THIRD-PARTY-NOTICES.txt](data/THIRD-PARTY-NOTICES.txt) — the
same notice the device serves from its own web UI. In short:

| Component | Origin | Licence |
|---|---|---|
| Icom LAN passcode and packet layouts in `icomLanClient.h` | [wfview](https://gitlab.com/eliggett/wfview/) — W6EL, M0VSE | GPL-3.0 |
| JS8 encoder and decoder (`data/js8-*.wasm`) | [JS8Call-improved](https://github.com/JS8Call-improved/JS8Call-improved) and its JS8/WSJT-X heritage | GPL-3.0 |
| WSPR protocol constants in `data/wspr-core.js` | WSJT-X — K1JT and the WSJT-X team | GPL-3.0 |
| FFTW 3.3.10, linked into `js8-decoder.wasm` | [fftw.org](https://fftw.org/); source vendored in `third_party/fftw/` | GPL-2.0-or-later |
| Eigen 3.4 | [libeigen/eigen](https://gitlab.com/libeigen/eigen) | MPL-2.0, plus BSD-3 and Apache-2.0 files |
| Boost 1.81 headers | [boost.org](https://www.boost.org/) | BSL-1.0 |
| Brotli decoder in `data/js8-brotli.wasm` | [google/brotli](https://github.com/google/brotli) | MIT |
| DXCC prefix engine in `data/dxcc.js` | DJ1YFK, with AD1C's `cty.dat` | GPL |
| Wake-lock media in `data/wake-lock.js` | [NoSleep.js](https://github.com/richtr/NoSleep.js) — Rich Tibbett | MIT |

Icom is a registered trademark of Icom Incorporated. WIFILT is an independent
software project and is not affiliated with, endorsed by, or sponsored by Icom
Incorporated.
