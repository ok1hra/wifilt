# TrxNet — Configuration and Usage

**Applies to:** WIFILT firmware rev 20260517+

TrxNet replaces the MQTT broker dependency with a **broker-free, P2P UDP network** built into the firmware. Devices discover each other automatically via UDP broadcast — no router configuration, no broker, no static addresses required.

---

## How it works

The WIFILT publishes its frequency and mode to all devices on the local network and subscribes to frequency and mode data from configured peers. All communication is UDP on port **5683**.

```
IC-705 (Bluetooth CI-V)
    │
    └── WIFILT (ESP32)
            │  publishes /hz, /mode
            │  subscribes /hz, /mode  ← from OI3 keyer(s) for Band Decoder
            │  subscribes /s-hz       ← remote VFO set command
            │  subscribes 6 PA topics ← from a linear amplifier, for the PA palette
            │
            └── WiFi LAN (UDP broadcast port 5683)
                    │
                    ├── OI3.ff  (k3ng keyer, TRX2 slot)
                    ├── OI3.01  (k3ng keyer, TRX3 slot)
                    └── PA.xx   (EXPERT 1K-FA daemon, SETUP → TrxNet → PA NET_ID)
```

### Published topics (WIFILT → network)

| Topic | Type | Description |
|-------|------|-------------|
| `/hz` | `uint32_t` LE | IC-705 VFO frequency in Hz. Published on change, max every 2 s. Value `0` is sent when the radio disconnects. |
| `/mode` | `uint8_t` | ICOM CI-V mode byte (see table below). Published on mode change. |

### Subscribed topics (network → WIFILT)

| Topic | Type | Source | Description |
|-------|------|--------|-------------|
| `/hz` | `uint32_t` LE | OI3 peers | Frequency from a peer radio. Used to drive the Band Decoder when TRX2 or TRX3 is selected as the BD source. |
| `/mode` | `uint8_t` | OI3 peers | Mode from a peer radio. Stored for display in Band Decoder status. |
| `/s-hz` | `uint32_t` LE | any device | Remote command: set IC-705 VFO to this frequency via CI-V. |
| `/pa-flags` | `uint16_t` LE | `PA.xx` only | Linear amplifier state: TUNE/OPERATE/TX/ALARM/FULL/CONTEST/BEEP in the low byte (the amplifier's own FLAGS, bit 7 masked), then ON (bit 8), LINK (bit 9), REV2 (bit 10). |
| `/fwd` | `uint16_t` LE | `PA.xx` only | Forward power, W × 10, instantaneous. Peak-held here for 2 s — see `PA_PEAK_WINDOW_MS`. |
| `/ref` | `uint16_t` LE | `PA.xx` only | Reflected power, W × 10, instantaneous. Peak-held the same way. |
| `/swr` | `uint16_t` LE | `PA.xx` only | SWR × 100; `0` = no answer, `65535` = infinite. |
| `/band` | `uint8_t` | `PA.xx` only | Band in metres. Compared against the radio's own frequency; a mismatch is what the palette draws in red. |
| `/pa-temp` | `int16_t` LE | `PA.xx` only | Heatsink temperature, °C × 100 — always °C, converted by the daemon from whichever scale the amplifier reports in. |

The six PA topics are accepted **only** from the peer named `PA.xx`, where `xx`
is the `PA NET_ID` set in SETUP → TrxNet; with it at `00` they are not
subscribed at all. `/pa-temp` is a separate topic from the WX node's `/temp`
even though the encoding is identical: one name for both would have a heatsink
reported as the weather.

### Mode byte values (ICOM CI-V standard)

All devices in the network use the same ICOM CI-V mode byte encoding. No conversion is needed on the WIFILT side — the byte read from the radio is published directly.

| Byte | Mode |
|------|------|
| `0x00` | LSB |
| `0x01` | USB |
| `0x02` | AM |
| `0x03` | CW |
| `0x04` | RTTY / FSK |
| `0x05` | FM |
| `0x06` | WFM |
| `0x07` | CW-R |
| `0x08` | RTTY-R |
| `0x17` | DV (D-STAR) |

---

## Network requirements

- All devices must be on the **same Layer-2 broadcast domain** (same switch or VLAN).
- Discovery uses UDP broadcast `255.255.255.255` — does **not** cross routers or subnet boundaries.
- All devices must use **UDP port 5683** (TrxNet default, not configurable per-device).
- WiFi networks with **AP client isolation**, guest VLANs, or mesh systems may silently block UDP broadcast between clients. If discovery fails on WiFi, test with a wired Ethernet connection.
- TrxNet is **inactive in AP mode** — the device must be connected to a WiFi station network.

---

## Web configuration

Open **`http://wifilt.local/setup`** and find the **TrxNet** section.

| Field | Format | Default | Description |
|-------|--------|---------|-------------|
| **Device NET_ID** | 2-digit hex `01`–`ff` | `01` | Own device identifier. Forms the device name **`705.01`** (or `705.XX` for other values). Set `00` to disable TrxNet entirely. |
| **TRX2 peer NET_ID** | 2-digit hex | `ff` | NET_ID of the k3ng keyer assigned to the **TRX2** Band Decoder slot. Set `00` to disable. |
| **TRX3 peer NET_ID** | 2-digit hex | `00` | NET_ID of the k3ng keyer assigned to the **TRX3** Band Decoder slot. Set `00` to disable. |

The read-only **Device name** field shows the assembled device name (e.g. `705.01`) that will be broadcast to the network after save & restart.

### Choosing NET_ID values

- `NET_ID = 0x00` is a **reserved sentinel** meaning *disabled*. Never assign it as a real device ID.
- Each device type (`705`, `OI3`, `ROT`, …) has its own ID space. IDs only need to be unique within a type — `705.01` and `OI3.01` can coexist.
- The WIFILT uses the prefix `705`. OI3 keyesr (k3ng) use the prefix `OI3`.

---

## Connecting with an OI3 keyer (k3ng)

The OI3 Open Interface running the k3ng firmware uses TrxNet to share frequency and mode with other stations on the network. Each keyer is identified by its **NET_ID**, configured in the keyer's own EEPROM settings.

### Step-by-step setup

**1. Note the NET_ID of each OI3 keyer.**

On the keyer, the NET_ID is displayed on the LCD during boot and is set via the keyer's setup menu. It is shown as a hex byte (e.g. `ff`, `01`).

**2. Configure TrxNet peers on the WIFILT.**

In the SETUP page TrxNet section:

- Set **TRX2 peer NET_ID** to the hex NET_ID of the first k3ng keyer (e.g. `ff`).
- Set **TRX3 peer NET_ID** to the hex NET_ID of the second keyer, or `00` if there is only one.

**3. Set the Band Decoder source.**

On the **BD** page, set the frequency source for each band decoder row:

| BD Source | Frequency used |
|-----------|---------------|
| `1` (default) | IC-705 (local, via Bluetooth CI-V) |
| `2` | TRX2 peer (received via TrxNet `/hz`) |
| `3` | TRX3 peer (received via TrxNet `/hz`) |

**4. Save & Restart.**

After restart the WIFILT will broadcast a discovery probe. The k3ng keyer will respond within ~100 ms. The BD source indicator on the BD page will show the peer as connected once the first `/hz` message arrives.

### What the OI3 keyer publishes

| Topic | Type | Description |
|-------|------|-------------|
| `/hz` | `uint32_t` LE | Frequency from the keyer's own CAT interface |
| `/mode` | `uint8_t` | CI-V mode byte (mapped from keyer's internal mode) |

### What the OI3 keyer subscribes to

| Topic | Type | Description |
|-------|------|-------------|
| `/s-hz` | `uint32_t` LE | Set VFO frequency command |
| `/s-mode` | `uint8_t` | Set mode command |
| `/s-cw` | `char[]` | CW text to key (reliable delivery, CON) |

The WIFILT sends `/s-cw` and `/s-hz` to the configured OI3 peer when LOG/DXC controls target TRX2 or TRX3. It does not publish `/s-mode`.

---

## Remote VFO control (`/s-hz`)

Any device on the network can set the IC-705's VFO by publishing a `uint32_t` frequency (Hz, little-endian) on the `/s-hz` topic. The WIFILT will forward it to the radio via Bluetooth CI-V.

Example using a Linux command-line tool that can send raw UDP CoAP packets, or from another TrxNet-enabled device:

```cpp
// From another ESP32 with TrxNet
uint32_t freq = 14074000UL;  // 14.074 MHz (FT8)
net.publish("/s-hz", (uint8_t*)&freq, sizeof(freq));
```

The command is ignored if:
- The IC-705 is not connected via Bluetooth.
- The frequency is `0`.

---

## Peer discovery timing

| Parameter | Value |
|-----------|-------|
| Discovery probe on boot | Immediate |
| Keepalive broadcast interval | 30 s |
| Peer timeout (no keepalive) | ~95 s (~3 missed keepalives) |
| Time to first peer visible | < 100 ms (normal conditions) |

After a WiFi reconnect, the WIFILT automatically re-broadcasts a discovery probe and re-establishes peer connections without a reboot.

---

## Disabling TrxNet

Set **Device NET_ID** to `00` in the SETUP page and save. The firmware will not call `net.begin()` and no UDP traffic will be generated. All other features (Bluetooth, web UI, Band Decoder with IC-705 as source) remain fully functional.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Peer never appears | WiFi AP isolation | Use wired Ethernet on the peer, or check router settings |
| Peer appears then disappears after ~95 s | Keepalive not reaching peer | Verify both devices are on the same L2 segment; check for VLAN separation |
| Band Decoder source TRX2/3 shows `0 Hz` | Wrong peer NET_ID configured | Check NET_ID on the keyer LCD; update TRX2/TRX3 NET_ID in SETUP |
| TrxNet inactive after WiFi reconnect | `net.begin()` not re-called | Firmware handles this automatically; if not, power-cycle the device |
| Device name shows `disabled` | NET_ID set to `00` | Set NET_ID to any non-zero value (e.g. `01`) in SETUP |
| Remote `/s-hz` has no effect | Radio not connected via BT | Check the TRX1 connection status in JS8LAN or SETUP |
