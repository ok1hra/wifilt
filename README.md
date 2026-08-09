# WIFILT — Web interface for Icom LAN Transceivers

Operate an Icom transceiver from any browser on your network — logbook, DX cluster, JS8Call
and a WSPR beacon — with nothing installed on the phone, tablet or PC, and no internet.

**All you need is any ESP32 WROOM module with 4 MB of flash.**
Flash it straight from the web installer: **<https://ok1hra.github.io/wifilt/>**
(plug in USB-C first, then open the page in Chrome, Edge or Opera on a desktop).

![Two radios operated from one interface](img/wifilt-two-radio-operation.png)

## Manuals

- **[SOFTWARE.md](SOFTWARE.md)** — the web interface: first run, QRPLog, DXC, JS8Call, the
  WSPR beacon, SETUP, LOGSYNC and the band decoder.
- **[HARDWARE.md](HARDWARE.md)** — the ESP32 and the RemoteQTH interface board: which radios
  work, flashing, connectors, Status LED, schematic and 3D-printed case.

Building from source: [BUILD.md](BUILD.md).

## License

WIFILT is free software, distributed under the **GNU General Public License, version 3 or
later** — see [LICENSE](LICENSE). This repository is the corresponding source for every
binary the project distributes, including the images served by the web installer. The
licences of the individual third-party components are listed in
[SOFTWARE.md § 11](SOFTWARE.md#11-component-licences) and in
[data/THIRD-PARTY-NOTICES.txt](data/THIRD-PARTY-NOTICES.txt).

Icom is a registered trademark of Icom Incorporated. WIFILT is an independent software
project and is not affiliated with, endorsed by, or sponsored by Icom Incorporated.
