# WIFILT — TRX HTTP API

The communication protocol between the web log and a TRX device. This document
is the reference specification for implementing an API adapter for TRX2 and
TRX3.

---

## 1. Architecture overview

```
  Browser (log.html)
       │
       │ HTTP over WiFi (port 80)
       ▼
  ESP32 firmware  ←── web server on port 80 ──→  radio (ICOM-LAN / CI-V / TrxNet)

  For TRX2 / TRX3:
  Browser (log.html)
       │
       │ HTTP over WiFi (any port)
       ▼
  Your own device / adapter  ←──→  second/third TRX (any transport)
```

The web log talks over **HTTP on port 80** to the ESP32's IP address and
nothing else. For TRX2 and TRX3 each device must implement an **identical HTTP
API** on its own IP address. Switching happens entirely in the browser — the
active TRX selects the base URL of the requests.

---

## 2. API endpoints

### 2.1 `GET /state` — TRX state (polling)

The client polls every **250 ms** while connected and every **1000 ms** after
an error.

**Request:**
```
GET /state HTTP/1.1
Host: <device-ip>
```

**Which TRX the endpoint describes:** with no parameter, always **TRX1** (the
primary radio) — that is how the log, the band decoder and WSPR read it. The
optional `?radio=lan` returns the same document for the **radio connected over
LAN**, whichever of TRX1, TRX2 or TRX3 it sits on. The DATA/JS8LAN page uses
this, because the operator may assign LAN to any slot. When no slot carries
LAN the parameter is ignored and the answer describes TRX1.

For a LAN radio outside TRX1 the answer carries a more compact state:
`frequency`, `mode` (including `-D`), `tx`, `filter`, `rfPower`, `smeterRaw`,
`powerMeterRaw`, `swr` and `supplyVolts` are valid; `ritRaw`, `afGain`,
`keySpeed`, `preamp` and `vox` are not tracked on this path and return `0`.

**Response:** `200 OK`, `Content-Type: application/json`

```json
{
  "connected":           true,
  "catHealthy":          true,
  "audioReady":          true,
  "audioTxReady":        true,
  "lanStatus":           "LAN linked",
  "btStatus":            "",
  "wifiStatus":          "WiFi STA",
  "radioTransport":      "ICOM-LAN",
  "fullCat":             true,
  "tuneSupported":       true,
  "wifiRssi":            -67,
  "fwRev":               "20260809",
  "bdSupported":         true,
  "power":               true,
  "frequency":           14074000,
  "mode":                "USB",
  "filter":              1,
  "radioAddress":        "0xA4",
  "transceiverType":     "ICOM-LAN",
  "radioName":           "IC-705",
  "tx":                  false,
  "ritRaw":              0,
  "smeterRaw":           0,
  "powerMeterRaw":       0,
  "afGain":              0,
  "keySpeed":            138,
  "rfPower":             0,
  "rfPowerSeen":         false,
  "supplyVolts":         13.80,
  "swr":                 1.0,
  "preamp":              0,
  "vox":                 0,
  "lanDrops":            0,
  "lanStalls":           0,
  "lanFilled":           0,
  "audioTxQueued":       0,
  "audioTxPackets":      0,
  "audioTxReplays":      0,
  "audioTxReplayMisses": 0,
  "audioTxSendFailures": 0,
  "audioTxMaxLateMs":    0,
  "audioRxDropped":      0,
  "audioMaxSendUs":      0,
  "dxcConnected":        false
}
```

An adapter for TRX2/TRX3 does not have to produce every field. The log reads
the ones listed below; anything it does not find it treats as absent, not as
an error. `btStatus` is a legacy field retained for older clients — the
Bluetooth transport itself has been removed.

#### Key fields for the log

| Field | Type | Description |
|------|-----|-------|
| `connected` | bool | The TRX is reachable and answering CI-V/CAT |
| `frequency` | uint32 | Current frequency in Hz |
| `mode` | string | Current mode (see the list below) |
| `tx` | bool | The TRX is transmitting right now |
| `fwRev` | string | Firmware revision — shown in the top bar |
| `power` | bool | The TRX is switched on |

#### Valid `mode` values

`LSB`, `USB`, `AM`, `CW`, `CW-R`, `RTTY`, `RTTY-R`, `FM`, `DV`

#### Client behaviour

- If the request fails (network error or non-2xx), the log goes *disconnected*
  and keeps the last manually entered frequency and mode.
- `connected: false` from a server that does answer means the TRX is wired to
  the adapter but the radio is not responding.

---

### 2.2 `POST /cmd` — commands to the TRX

**Request:**
```
POST /cmd HTTP/1.1
Host: <device-ip>
Content-Type: application/json

{ "type": "<type>", ... }
```

**Command target:** with no parameter the command goes to **TRX1**. As with
`/state`, adding `?radio=lan` sends it to the radio on LAN whichever slot it
occupies — this is how the DATA/JS8LAN page tunes and changes mode.
`setFrequency`, `setMode` and `civ.raw` honour the target; `sendCw` and
`abortCw` stay with TRX1.

**Success:** `200 OK`
```json
{ "ok": true }
```

**Success for an unsupported command:** `200 OK`
```json
{ "ok": true }
```

An adapter returns `{"ok": true}` even for commands it does not support or
silently ignores — see [2.5 Unsupported commands](#25-unsupported-commands--adapter-and-client-behaviour).

**Error responses:**

| HTTP status | JSON | Situation |
|------------|------|---------|
| 503 | `{"error":"radio_disconnected"}` | TRX not connected or not responding |
| 400 | `{"error":"invalid_frequency"}` | Frequency out of range or zero |
| 400 | `{"error":"invalid_mode"}` | Unknown mode name |
| 400 | `{"error":"invalid_hex"}` | Bad hex payload in `civ.raw` |
| 400 | `{"error":"missing_text"}` | `sendCw` without text |
| 400 | `{"error":"empty body"}` | Empty request body |
| 500 | `{"error":"tx_failed"}` | The command could not be sent to the TRX |

---

#### `abortCw` — stop CW or RTTY/FSK transmission immediately

```json
{ "type": "abortCw" }
```

- **This command does not require a live radio link** — it is processed even in
  the `radio_disconnected` state, because aborting RTTY depends on direct GPIO,
  not on CI-V.
- Mode `CW` / `CW-R` → CI-V command `0x17 0xFF` (the data byte `FF` stops the
  IC-705 CW keyer per the documentation: *"FF stops sending CW messages"*);
  frame: `FE FE A4 E0 17 FF FD`
- Mode `RTTY` / `RTTY-R` → sets the volatile `abortFskTransmission` flag; the
  FSK loop notices it at the end of the current character (165 ms at most),
  drops PTT immediately and skips the tail delay
- Other modes → the command is accepted and silently ignored (`{"ok": true}`)
- A TRX2/3 adapter should support it; if it does not, it returns `{"ok": true}`
  and ignores it
- The log sends it when `Esc` is pressed with no dialog open

---

#### `sendCw` — send CW or RTTY/FSK text

```json
{ "type": "sendCw", "text": "CQ TEST DE OK1HRA" }
```

- The firmware routes automatically by the current mode:
  - mode `CW` / `CW-R` → CI-V command `0x17` (CW keyer)
  - mode `RTTY` / `RTTY-R` → FSK keying over GPIO + PTT
- The text is ASCII; the maximum length depends on the device buffer (ESP32
  implementation: `sizeof(CwMsg) - 1`)
- Empty text → `400 missing_text`

Examples of what the log sends:
```
CQ TEST DE OK1HRA OK1HRA TEST    ← CQ macro
OK1ABC 5nn TT1                   ← TXEXCH macro (QSO number)
tu OK1HRA                        ← TU macro
```

---

#### `setFrequency` — set the VFO frequency

```json
{ "type": "setFrequency", "frequency": 14074000 }
```

- `frequency` — integer in Hz, positive and non-zero
- ESP32 implementation: CI-V command `0x05` with 5-byte BCD encoding

---

#### `setMode` — set mode and filter width

```json
{ "type": "setMode", "mode": "USB", "filter": "FIL1" }
```

| Parameter | Values | Description |
|----------|---------|-------|
| `mode` | `LSB`, `USB`, `AM`, `CW`, `CW-R`, `RTTY`, `RTTY-R`, `FM`, `DV` | Requested mode |
| `filter` | `FIL1` (default), `FIL2`, `FIL3` | Filter width |

- ESP32 implementation: CI-V command `0x06`; `FIL1` = wide, `FIL2` = medium,
  `FIL3` = narrow

---

#### `setRitClear` — clear RIT

```json
{ "type": "setRitClear" }
```

Sent automatically after every logged QSO (see [log.js:1854](../data/log.js#L1854)).

- ESP32 implementation: CI-V command `0x21 00 00 00 00 00` (RIT clear)

---

#### `civ.raw` — raw CI-V passthrough (optional)

```json
{
  "type":        "civ.raw",
  "data":        "03",
  "framed":      false,
  "expectReply": true,
  "expectAck":   false
}
```

| Field | Type | Description |
|------|-----|-------|
| `data` | hex string | CI-V payload without the frame; the ESP32 adds `FE FE <addr> E0 ... FD` |
| `framed` | bool (opt.) | `true` = `data` already contains a complete CI-V frame including `FE FE ... FD` |
| `expectReply` | bool (opt.) | Wait for a data reply from the TRX |
| `expectAck` | bool (opt.) | Wait for ACK/NACK |

This is the extended interface for direct CI-V work. A basic log only needs
`sendCw`, `setFrequency`, `setMode` and `setRitClear`.

---

### 2.5 Unsupported commands — adapter and client behaviour

Different devices have different capabilities. The rule is simple:

**An adapter returns `HTTP 200` + `{"ok": true}` for every command it silently
ignores.**

The client does not distinguish "done" from "ignored" — it carries on
normally in both cases. An adapter **must not** return an error status for an
unsupported command, because that would break the client's behaviour.

#### Client behaviour per command

| Command | What the client does on `r.ok === false` | Recommendation for the adapter |
|--------|--------------------------------------|------------------------|
| `sendCw` | shows the hint **"Send failed"** | return `{"ok": true}` and drop the text |
| `abortCw` | silently ignores (`.catch(() => {})`) | return `{"ok": true}`; ideally stop the active TX |
| `setRitClear` | silently ignores (`.catch(() => {})`) | return `{"ok": true}` |
| `setFrequency` | silently ignores | return `{"ok": true}` |
| `setMode` | silently ignores | return `{"ok": true}` |
| `civ.raw` | silently ignores | return `{"ok": true}` |

#### A minimal adapter handler

```python
# Python / Flask example
@app.post("/cmd")
def cmd():
    body = request.get_json(silent=True) or {}
    t = body.get("type", "")

    if t == "sendCw":
        text = body.get("text", "")
        if not text:
            return {"error": "missing_text"}, 400
        my_keyer_send(text)          # your own implementation
        return {"ok": True}

    if t == "setRitClear":
        my_rit_clear()               # or nothing, if unsupported
        return {"ok": True}

    # Every other type — accept silently, do nothing
    return {"ok": True}
```

#### When to return an error

An error status (`4xx`, `5xx`) is only appropriate when:
- the request body is empty or invalid JSON → `400 empty body`
- the TRX is physically unreachable and the command cannot be honoured even
  partially → `503 radio_disconnected`
- the adapter hit an internal error → `500 tx_failed`

**Never return `400 unsupported_type`** for a command the adapter does not
know — the client would show an error hint.

---

### 2.3 `GET /log-config` — log configuration

```
GET /log-config HTTP/1.1
```

**Response:** `200 OK`, `Content-Type: application/json`
Body: any JSON object the client stored (or `{}` when empty).

The fields the log writes and reads (not exhaustive — the device round-trips
whatever object was last stored, whole; see the warning under 2.4 below):
```json
{
  "trx1Label": "IC-705",
  "trx2Label": "FT-991",
  "trx3Label": "SDR",
  "blockedDxcc": "Russia\nBelarus\nKaliningrad",
  "fskOutputMode": "internal",
  "fskNetId": "00"
}
```

---

### 2.4 `POST /log-config` — store the log configuration

```
POST /log-config HTTP/1.1
Content-Type: application/json

{ "trx1Label": "IC-705", "trx2Label": "FT-991", "trx3Label": "SDR" }
```

**Response:** `{"ok": true}`

- The device stores the JSON as-is (the ESP32 puts it in `/log-config.json` on
  the filesystem) — this is a **replace, not a merge**: any field present in
  the previously stored object but missing from this POST's body is dropped,
  not carried over. A caller that wants to change one field (say, just
  `trx1Label`) must `GET /log-config` first, edit that field in the object it
  gets back, and `POST` the whole merged object — posting `{"trx1Label":
  "IC-705"}` alone would silently erase `blockedDxcc`/`fskOutputMode`/anything
  else already stored. (In-app writes never hit this endpoint at all: the
  Setup page's own save path merges by construction, since it always POSTs
  every field it owns together — see `/setup/save`, not documented here.)
- Validation: a non-empty JSON object, 2048 B maximum

---

### 2.6 `POST /log-config/fsk` — set FSK output mode

```
POST /log-config/fsk HTTP/1.1
Content-Type: application/x-www-form-urlencoded

fskOutputMode=trxnet&fskNetId=07
```

**Response:** `{"ok": true}`

Grilled 2026-08-28 (item 5 follow-up): the narrow write path for exactly
`fskOutputMode`/`fskNetId`, added when the RTTY-ICOM page's SETTINGS panel took
over editing this from the Setup page. Neither `/log-config` above (replace-
whole, meant for the config backup/restore round trip) nor `/setup/save`
(merge-by-construction, but not documented here, and refuses the whole post
unless `ssid`+`pswd` are both present) fit a page with no WiFi fields to send.
This endpoint merges just these two fields into the stored document, leaving
`trx1Label`/`trx2Label`/`trx3Label`/`blockedDxcc` exactly as they were.

- `fskOutputMode`: `"internal"` or `"trxnet"` — anything else is stored as
  `"internal"`
- `fskNetId`: 2 hex digits, normalized to uppercase; anything unparsable is
  stored as `"00"` (unset)

---

## 3. Legacy interfaces (kept for compatibility)

### 3.1 HTTP CAT port (default 81)

A simple HTTP server for external loggers (N1MM+, Win-Test):

```
GET http://<ip>:81/ HTTP/1.1
```

**Response:** plain text
```
14074000|USB|
```
or, with the TRX switched off:
```
0|OFF|
```

Format: `<frequency_Hz>|<mode>|`

---

### 3.2 UDP CW/FSK port (default 89)

Accepts ASCII text and sends it as CW or FSK.

```bash
echo -n "cq de ok1hra;" | nc -u -w1 192.168.1.x 89
```

- One packet = one CW/FSK text to send
- The trailing `;` is not required but is customary (the N1MM+ convention)
- CW vs. FSK routing follows the TRX's current mode (the same as `sendCw`)

---

### 3.3 UDP CAT port (default 90)

Accepts raw CI-V bytes (binary). For safety only the clear-RIT command is
implemented:

```
Byte[0] = 0x21  →  send clear RIT to the TRX
```

---

## 4. Minimum implementation for TRX2 / TRX3

For the web log to work fully with a second or third device, the adapter has to
implement these endpoints:

| Endpoint | Method | Priority |
|----------|--------|----------|
| `/state` | GET | **required** — without it the log knows nothing about the TRX |
| `/cmd` with `sendCw` | POST | **required** — the CQ, TXEXCH and TU macros |
| `/cmd` with `setRitClear` | POST | recommended — sent after every QSO |
| `/cmd` with `setFrequency` | POST | optional — only if the device can set the VFO |
| `/cmd` with `setMode` | POST | optional |
| `/log-config` | GET + POST | optional — may return `{}` |

---

## 5. Extending the client to several TRX

In the current implementation (`data/log.js`) `activeTrx` is only a UI label —
all HTTP traffic always goes to the same IP (the ESP32). Real TRX switching
needs:

1. A TRX → IP address map in `/log-config`:
   ```json
   {
     "trx1Label": "IC-705",  "trx1Url": "",
     "trx2Label": "FT-991",  "trx2Url": "http://192.168.1.50",
     "trx3Label": "SDR",     "trx3Url": "http://192.168.1.51"
   }
   ```
   An empty `trxUrl` means "use the local ESP32" (the default behaviour).

2. `pollState()` and `handlePostCmd()` in `log.js` targeting `trxBaseUrl()`
   derived from `app.activeTrx`.

3. Switching the TRX triggering an immediate fresh `/state` poll against the
   new address.

---

## 6. CI-V commands implemented in the ESP32

| CI-V cmd | Hex | Function |
|----------|-----|--------|
| Read frequency | `0x03` | Read the current VFO frequency |
| Read mode | `0x04` | Read the current mode and filter |
| Set frequency | `0x05` | Set the VFO frequency (5 BCD bytes) |
| Set mode | `0x06` | Set the mode and filter |
| Send CW | `0x17` | Send CW text through the keyer buffer |
| Stop CW | `0x17 0xFF` | Abort the CW message being sent (`FF` = stop) |
| RIT clear | `0x21 00 00 00 00 00` | Zero the RIT offset |
| CI-V transceive | `1A 05 01 31 01` | Enable push notifications from the radio |
| Quick split | `1A 05 00 45` | Read the split state |

A CI-V frame is structured as `FE FE <radio_addr> E0 <cmd> [<payload>] FD`

- `FE FE` = start bytes
- `<radio_addr>` = the radio's address, typically `0xA4` (configured in SETUP)
- `E0` = the controller address (the ESP32)
- `FD` = stop byte

---

## 7. SETUP API fields

### `/setup-data.json`

| Field | Type | Description |
|------|-----|-------|
| `ipLastOctet` | uint8 | Last octet of the device IP address (0 in AP mode). Used to suggest the `Own NET_ID` value in the TrxNet section. |
| `trxnetidIsDefault` | bool | `true` when EEPROM byte 41 has never been written (factory default) — the frontend then fills `trxnetid` from `ipLastOctet`. |
| `trx2conntype` | uint8 | TRX2 connection type: `0` = TrxNet, `1` = CI-V. Stored in EEPROM byte 44. |
| `trx3conntype` | uint8 | TRX3 connection type: `0` = TrxNet, `1` = CI-V. Stored in EEPROM byte 47. |

### `/config/download` and `/config/upload`

| Field | Type | Description |
|------|-----|-------|
| `trx2conntype` | uint8 | TRX2 connection type (0=TrxNet, 1=CI-V). |
| `trx3conntype` | uint8 | TRX3 connection type (0=TrxNet, 1=CI-V). |
