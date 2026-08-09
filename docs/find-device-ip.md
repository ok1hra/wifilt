# Finding IP addresses — the interface and the radio

Two addresses stand between a box on the bench and a working system: the one the router gave the
WIFILT, and the one it gave the radio. Neither is knowable in advance, and both used
to be the operator's problem. This is what the firmware does about it.

---

## Why the AP-mode "tap to open" trick cannot work on your home network

In AP mode the device is the whole network: it runs the DHCP server, it answers DNS for every
name (`dnsServer.start(DNS_PORT, "*", IP)`, [IC-705_Interface.ino](../IC-705_Interface.ino)), and
its catch-all handler answers the operating system's connectivity probe with a redirect instead of
the expected `204`. Android, iOS and Windows all read that as "this network wants you to sign in"
and pop the link. It works beautifully and it costs nothing, because we own the network.

On your home network the router owns DHCP and DNS. The interface is one client among many; it is
never asked to resolve a name and never sees the probe. Reproducing the effect would mean
answering DNS queries that were addressed to the router — that is an attack on the network, not a
feature, and this firmware will not do it.

What replaces it is a **name** that works without any of that, and a **handover** at the one moment
the address changes.

---

## Finding the interface — in order of what to try

### 1. The handover screen (first run, and any later AP-mode visit)

Save WiFi credentials in AP mode and the portal no longer disappears into a blind restart. The
device brings the station link up *next to* the still-running hotspot and shows you the address the
router handed out — as a link, and as a QR code for a phone. Write it down or scan it before you
press **Restart into normal mode**.

It scans before it connects and then tries **every configured profile**, the ones the scan actually
heard first and strongest signal first among those. An SSID 1 that is out of range no longer makes
the handover report failure while SSID 2 sits there working.

A scan that comes back empty is **not** treated as proof: it may have failed outright, and a hidden
SSID never appears in one either. In that case the device still tries every configured profile the
ordinary way. Only after all of them have been attempted is failure reported, as one of two things,
because they need different fixes: *neither network was found* (a scan ran, saw nothing of yours,
and the attempts also failed) or *could not join* (the network was there but would not let us in —
usually a wrong password).

The scan runs from the main loop rather than from the HTTP handler, and it is the blocking form.
The asynchronous one returns `WIFI_SCAN_FAILED` immediately when started right after the switch to
`WIFI_AP_STA` — the station interface is not up yet — which made the first version of this give up
without ever attempting a connection.

While all this happens the shared radio moves — first for the scan, then because the softAP follows
the station onto its channel — so the phone briefly drops and re-associates. The page expects that
and keeps polling.

The same scan-first rule applies at boot: the device starts with whichever configured network the
scan saw, strongest first, instead of always trying SSID 1 and waiting out its timeout.

The address is also remembered in EEPROM. Any later visit to the AP portal — including the
unintended kind, when the configured WiFi is out of range at boot and the device falls back to AP
mode by itself — shows **"Last address on your network"** at the top of the WiFi section.

### 2. `http://wifilt/`

The device registers `wifilt` as its DHCP hostname. Most consumer routers publish that in their own
local DNS, so a plain unicast lookup resolves it — no multicast, no Bonjour, which means this is the
path that also works from **Android**. Depending on the router the fully qualified form may be
`wifilt.lan`, `wifilt.home` or `wifilt.fritz.box`.

Not every router does this. When yours does not, fall through to the next one.

### 3. `http://wifilt.local/`

mDNS. Works on iOS, macOS, Windows 10+ and Linux with Avahi; Chrome on Android generally does not
resolve `.local`.

If mDNS has been unreliable for you in the past, three specific faults were fixed in this firmware:

- WiFi modem power save was left at the default, so the access point only delivered multicast at
  DTIM beacons and routinely dropped the queries. `WiFi.setSleep(false)` now runs on every station
  connect.
- The `_http._tcp` service was registered in AP mode only. Browsers and "find devices on my
  network" tools look for exactly that, so on the real LAN nothing could see the device.
- The responder was started once at boot and never re-registered. After any WiFi reconnect the
  registration was stale and `wifilt.local` quietly stopped resolving.

### 4. The router's client list

With the DHCP hostname set, the device appears as **`wifilt`** rather than as a generic
`espressif`/`esp32-xxxxxx` entry. This is the fallback that always works, because the router cannot
not know.

### 5. Give it a fixed lease — then stop looking

While you are in the router's client list, add a DHCP reservation for `wifilt`. The address stops
moving and every step above becomes unnecessary.

### 6. CW and the serial console

Still there, unchanged: **Announce WiFi IP via CW on first connect** keys the address into the
radio's sidetone (BK-IN off, RF gain at minimum — it never reaches the air), and the USB serial
console prints it at every boot. Both remain the last resort for a network that cooperates with
nothing else.

---

## Finding the radio — SETUP → Scan

The Icom LAN protocol has no discovery. Neither does wfview: its `discoveredRigID()` identifies the
rig *model* over a link that is already open, and there is no broadcast probe anywhere in the
protocol. So the scan uses the only unauthenticated primitive the handshake offers.

**SETUP → TRX*n* → Radio IP address → Scan** sweeps the interface's own /24, sending
`AreYouThere (0x03)` to UDP 50001 on every host and collecting the `IAmHere (0x04)` replies. Roughly
254 datagrams, paced so the loop that carries JS8/WSPR audio is not disturbed, plus a two-second
listening tail. Anything that answers is listed; click a row to fill the address in.

Three properties worth knowing:

- **It never logs in.** The sweep stops at `IAmHere` and never sends `AreYouReady` or `Login`, so
  it does not consume the IC-705's single session. A scan will not lock out a wfview instance that
  is connected at the time.
- **It briefly drops your own radio link.** The scanner needs UDP 50001, which the live client
  owns, and `WiFiUDP` sets `SO_REUSEADDR` — a second bind would succeed and then silently steal the
  client's control packets. So the client is stopped for the few seconds the scan runs and
  reconnected afterwards. The scan is refused outright while the radio is transmitting.
- **The list says "answered on UDP 50001", not "IC-705".** A wfview server or an RS-BA1 server
  answers the same probe. Identifying the model would require logging in, which is exactly what the
  scan refuses to do.

Networks wider than /24 are only partially covered; the panel says so rather than implying the
sweep was exhaustive.

### Test & identify radio

Beside the username and password fields. It performs a real login against the address in the form
and reports one of three things: the radio accepted the credentials, the radio refused them, or
nothing answered at that address. It stops as soon as authentication succeeds — before the CI-V
channel opens — so a radio you are only probing never writes its frequency into the shared rig
state, and the session is released immediately.

Unlike the scan, this one *does* take the radio's single session for a moment.

**It also learns what the radio is.** The Icom login handshake carries a capabilities packet with
the radio's own model name, and it arrives *before* the login completes — so the moment the test
succeeds, the model is known. It is shown next to the button and stored per slot in
`/radio-config.json`.

That matters beyond cosmetics. WSPR has to know whether 100 % of the CI-V power scale means 10 W
(IC-705) or 100 W (IC-7610, IC-9700, IC-7300) — getting it wrong is a factor-of-ten error on the
air — so it refuses to transmit for a radio it cannot identify. Until now that answer lived only in
a live session and was forgotten the instant the link dropped, leaving the WSPR and JS8 pages
showing *model unknown* and relying on the manual override in WSPR settings. The stored model now
fills `/state.radioName` whenever no session is up, so both pages know the radio before it is even
switched on.

A live session always wins over the stored value, and every successful connection refreshes it —
swap the radio behind an address and the stored model corrects itself without anyone pressing the
button again.

---

## Related

- [icom-lan-implementace.md](icom-lan-implementace.md) — the LAN handshake and the six IC-705
  deviations from the wfview flow
- [setup-interfaces-architecture.md](setup-interfaces-architecture.md) — radios × interfaces, and
  why LAN may be on only one slot
- [user-manual.md](user-manual.md)
