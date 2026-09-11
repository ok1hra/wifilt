# WIFILT — Web interface for Icom LAN Transceivers

Operate a transceiver from any browser on your network — logbook, DX cluster, JS8Call, RTTY,
a WSPR beacon and Mercury file transfer — with nothing installed on the phone, tablet or PC,
and no internet.

**Runs on any ESP32 WROOM module with 4 MB of flash — or on a ready-cased M5Stack Atom Lite
(built from source, see [BUILD.md](BUILD.md#1-firmware)) — or, if the radio is already on
your network, as a native program on a Linux, Windows or Raspberry Pi PC with no extra
hardware at all.** Get the WROOM image or the desktop program from the web installer page:
**<https://ok1hra.github.io/wifilt/>** (flashing the ESP32 needs Chrome, Edge or Opera on a
desktop, plugged in over USB-C first; the Linux/Raspberry Pi/Windows downloads are plain
archives — the Atom Lite is not on this page yet, see BUILD.md).

**A radio that is not an Icom — or an Icom with no network port — can be used too**, on the PC
route. The desktop archives carry a second program, **local-trx**, which pretends to be a
LAN-networked Icom and translates for whatever the computer's sound card, CAT adapter and
DTR/RTS keying adapter are wired to, over [hamlib](https://hamlib.github.io/)'s full rig list.
It ships switched off; a setup page of its own turns it on. See
[SOFTWARE.md § 1.6](SOFTWARE.md#16-local-trx--any-radio-on-a-pc).

![Two radios operated from one interface](img/wifilt-two-radio-operation.png)

## Quick start

Three ways in. Pick the row that matches what you have; each one ends at the same interface,
at the same address, with the same pages.

| | You have | Go to |
|---|---|---|
| **A** | an Icom with Network Control, and an ESP32 board | [A — the ESP32 box](#a--the-esp32-box) |
| **B** | an Icom with Network Control, and a PC always on | [B — on a PC, no extra hardware](#b--on-a-pc-no-extra-hardware) |
| **C** | any other rig — a Kenwood, a Yaesu, an Icom without LAN — and a PC | [C — on a PC, through local-trx](#c--on-a-pc-through-local-trx) |

Routes **B** and **C** are the same download. `local-trx` is already inside it; route B simply
never starts it.

### First, on the radio (A and B)

In the transceiver's own menu set **Network Control** to **ON**, and invent a network user
name and password there. You will type them into WIFILT in a moment; they are the radio's,
not an account with anybody.

### A — the ESP32 box

1. Open **<https://ok1hra.github.io/wifilt/>** in Chrome, Edge or Opera on a desktop, with the
   board plugged in over USB-C, and flash it. (The page asks whether this is a new device or
   an upgrade, and explains the *Erase device* checkbox — leave it unticked to keep your
   configuration.)
2. The board raises its own hotspot, **`WIFILT-AP`** / `remoteqth`. Join it and open
   **<http://192.168.4.1>**.
3. SETUP walks you through the rest. Give it your WiFi, then reach it at
   **<http://wifilt.local>** from then on.

Wiring, connectors, the Status LED and the case are [HARDWARE.md](HARDWARE.md).

### B — on a PC, no extra hardware

Download the archive for your system from the same page.

**Linux and Raspberry Pi** (64-bit Raspberry Pi OS — a 32-bit one cannot run it):

```sh
tar xzf wifilt-<rev>-linux-x86_64.tar.gz     # or -linux-arm64
cd wifilt-linux-x86_64
sudo ./install.sh
```

The installer copies the program to `/opt/wifilt` and grants it permission to bind ports 80,
82 and 83 — **port 83 carries the audio**, so without that permission JS8, RTTY, WSPR and
Mercury cannot work at all. It installs a `systemd` service but deliberately does **not**
enable it: starting a transmitter's control interface at boot should be your decision. Then:

```sh
/opt/wifilt/start-wifilt.sh      # starts it and opens the browser
# or
sudo systemctl start wifilt      # this boot only
sudo systemctl enable --now wifilt   # and at every boot
```

**Windows** — unpack the ZIP anywhere and run **`start-wifilt.bat`** (or `wifilt.exe`
directly). Nothing is installed and there is no runtime to add. Windows asks once whether to
allow it through the firewall — say yes, or nothing else on your network will reach it.
Because the file is not code-signed, SmartScreen may warn on first run: *More info* → *Run
anyway*.

Then open **<http://wifilt.local>** and go to **SETUP → Radio**: set TRX1 to **ICOM-LAN**,
enter the radio's address and the user name and password you invented in its menu, and press
**Test & identify radio**. The radio reports its own model back, and from there the power
limits and setup guidance follow whichever transceiver actually answered.

### C — on a PC, through local-trx

Same download and the same install as **B** — `local-trx` comes with it and lands in the same
place. What is different is that a second program now has to be told about your hardware, and
that WIFILT is pointed at *it* instead of at a radio.

You need, physically: the PC's **sound card** wired to the rig's audio in and out, a **CAT
adapter** on its control port, and a **second serial adapter** whose DTR and RTS lines go to
the rig's **KEY** and **PTT** jacks. Two separate adapters — CAT and keying are never the same
port.

1. **Start both.** `/opt/wifilt/start-wifilt.sh` on Linux, `start-wifilt.bat` on Windows.
   Both web pages open by themselves. (Running `local-trx` on its own works too; it is just
   one more thing to remember.)
2. **Set up local-trx**, on **<http://localhost:8765>**. It ships doing nothing at all. Its
   page asks for three things, each with a test button beside it so you can prove the wiring
   before going on the air:
   - **Audio** — capture and playback device, with a live input meter and a test tone.
   - **CAT** — serial port, baud rate and which rig it is, from hamlib's full model list;
     *Test read freq* reads the dial back.
   - **Keying** — the *other* serial port, the CW speed, and which of DTR/RTS is the key line
     and which is PTT; *Test KEY* and *Test PTT* assert each one on its own.

   Switch it from **Configure** to **Run** and press **Save**. Saving restarts `local-trx`
   itself — nothing is applied while it runs.
3. **Point WIFILT at it.** On **<http://wifilt.local>**, go to **SETUP → Radio**, set TRX1 to
   **ICOM-LAN** and tick **LOCAL-TRX**. On a PC install that fills in `127.0.0.1` and the rest;
   if WIFILT is on the ESP32 box instead, type the PC's LAN address by hand. A *local-trx
   detected* link appears when it answers.

What you give up is only what is reached by model-specific Icom commands — the network
MOD-level TX-gain calibration, GPS position, the radio's own waterfall. Everything else,
including the transmit-gain calibration through the ordinary audio path, works.
[SOFTWARE.md § 1.6](SOFTWARE.md#16-local-trx--any-radio-on-a-pc) has the detail.

### Then

SETUP's first-run guide works out on its own what is already done and asks only for what is
missing: your callsign and locator, the transmit check, the DX cluster, this browser's own
settings. Start at [SOFTWARE.md § 2](SOFTWARE.md#2-first-run).

## Manuals

- **[SOFTWARE.md](SOFTWARE.md)** — the web interface: first run, QRPLog, DXC, JS8Call,
  RTTY-ICOM, the WSPR beacon, Mercury file transfer, SETUP, LOGSYNC and the band decoder.
- **[HARDWARE.md](HARDWARE.md)** — the ESP32 and the RemoteQTH interface board: which radios
  work, flashing, connectors, Status LED, schematic and 3D-printed case — and, for the
  Linux/Raspberry Pi/Windows route that needs none of it,
  [§ 11](HARDWARE.md#11-running-without-the-esp32-board).

Building from source: [BUILD.md](BUILD.md) — the firmware in § 1, the native builds in § 4,
`local-trx` in § 5.

## License

WIFILT is free software, distributed under the **GNU General Public License, version 3 or
later** — see [LICENSE](LICENSE). This repository is the corresponding source for every
binary the project distributes, including the images served by the web installer. The
licences of the individual third-party components are listed in
[SOFTWARE.md § 13](SOFTWARE.md#13-component-licences) and in
[data/THIRD-PARTY-NOTICES.txt](data/THIRD-PARTY-NOTICES.txt).

Icom is a registered trademark of Icom Incorporated. WIFILT is an independent software
project and is not affiliated with, endorsed by, or sponsored by Icom Incorporated.
