# Changelog

All notable changes to **WIFILT**, grouped by firmware revision (`#define REV`) and
broken down per commit.

Newest first. Dates are local (CEST). A firmware revision is the `REV` value flashed with that
commit — several commits usually share one revision, and the revision is bumped when a build is
published.

---

## Working tree — not committed

**QRPLog can drive the linear amplifier.**

* **`/pa.json` now reports what happened to the command itself** — `txOk`, `txFailed`, `txAgeMs`.
  Three rounds were spent guessing where a press was being lost, because the one fact that would
  have settled it — did this interface put the packet on the wire — was printed only to a serial
  console nobody was watching. The palette's "the amplifier did not follow" covered two faults
  needing opposite fixes: a daemon that refused the command, and an interface that never sent it.
  It now names which, by comparing `txFailed` across the command's own wait.

* **Fixed, and this was the real one: stale telemetry disabled the buttons.** Measured rather than
  guessed, layer by layer. The daemon's own `/health` said `subscribeOn: true`, so commands were
  being accepted; the operator's ESP32 answered `/pa/cmd` with 400 on a bad body, so the route was
  there; and its `/pa.json` read `ageMs: 38978070` — **10.8 hours** since the last topic. A probe
  driving that actual device then showed OPERATE, PWR and TUNE all `disabled: true`, titled "No
  telemetry from the amplifier."

  The chain: the amplifier was switched off (`dtr: false`), the daemon publishes **only** from its
  STATUS handler, so nothing was being sent at all, `ageMs` climbed past `staleMs`, and
  `whyDisabled()` greyed three of the four buttons out. A closed circle — the amplifier could not
  be operated precisely because it was off, which is the state you want ON for. ("The first version
  worked" was the same code with the amplifier switched on; versions two and three were not the
  cause.)

  Stale telemetry now disables nothing. Sending blind is safe because these are not keystrokes:
  `/s-operate 1` means "be in OPERATE" and the daemon runs its own compare-send-confirm loop, and
  it holds a command for ten seconds while no telemetry flows — documented for exactly this case,
  `/s-on` and `/s-operate` sent together with a seven-second power-up. Only "the amplifier is not
  on the network" disables anything now; the buttons instead say the state shown is the last one
  heard.

* **Fixed: a refused command could report success.** `send()` read the body but not the status
  code, so a firmware without the route — 404 with an HTML page — made `r.json()` reject, the catch
  turned it into `{}`, and a command that never existed passed as accepted. Status is now checked
  first, with 404 named for what it is.

* Both fixes are covered against the state that produced them (stale telemetry, and a 404 from an
  older firmware). `pa-panel-smoke` is 66 checks, green against the source and against the
  minified companion the firmware actually serves.

* **Fixed: the settle window made every button feel dead.** The guard added to stop a press being
  undone ran from the moment a command was *sent*. With an amplifier that is not listening — a
  daemon without `--trxnet-subscribe`, or this device missing from its `--trxnet-allow` list —
  every press was then swallowed and nothing on screen said so. A guard may only hold a button
  while something is actually happening, so it now runs from the moment the amplifier **confirms**;
  an unanswered command holds nothing, and pressing again is exactly what to try next. Two new
  checks cover it: a lapsed command leaves the button usable, and pressing again reaches the wire.

* **Fixed: TUNE is available in STANDBY.** Tuning runs at low power, so STANDBY is an ordinary
  place to do it from. Blocking it there came from reading the daemon's `"no effect - transmitting,
  or in STANDBY?"` log line as a statement about the amplifier; it is a guess the daemon makes when
  the TUNE flag fails to rise. The one state that genuinely locks it stays: the radio keying, where
  the amplifier locks the whole RF path.

* **`PA_SMOKE_MINIFIED=1` runs the smoke against `*.js.min`.** The firmware serves the minified
  companion via `.gz`, never the readable source, so a suite that only ever tested the source was
  testing a file no operator runs. It earned its keep immediately, catching a stale `.min` from a
  regeneration that had not been run yet. Both passes are green (59 checks each).

* **Fixed, from the desk: OPERATE switched on and then straight back off.** Traced on the wire,
  not guessed at — a stand-in `PA.01` with an ephemeral UDP port (the trick `trxnet_e2e.py` uses
  to share a host) recorded exactly what one press sends, and the firmware was innocent: one
  press, one `/s-operate 1`. The fault was in the palette. These are toggle keys, so a second
  press carries the *opposite* value, and the amplifier answers in well under a second — so by
  the time an operator who saw nothing happen presses again, the first command has been confirmed
  and any "one command outstanding" guard has already lifted. The second press then cleanly undid
  the first. A button now also holds the wire for 1.5 s after **sending**, confirmed or not,
  while still repainting to the new state immediately, so the panel stays responsive and only the
  command waits. Reproduced as a failing check first (`[{operate:1},{operate:0}]`), and a second
  check makes sure the settle window does not turn the button into a lockout.

* **A greyed-out button now says why.** TUNE going grey — which is what the amplifier sitting in
  STANDBY looked like — was indistinguishable from the radio keying, or from the panel having
  lost the amplifier entirely. Three different problems, one appearance. Each disabled button now
  carries the first reason that applies as its tooltip.

* **Two bars between the readings and the SWR line**, touching, no scale and no frame: forward
  power green from the left, reflected sand from the right, so the two never read as one
  continuous quantity. Full scale follows the mode the amplifier is actually in — 1200 W in FULL,
  600 W in HALF, and the exciter's 100 W in STANDBY — because a fixed scale would make a
  full-power HALF transmission look like the amplifier was loafing. Reflected power keeps a scale
  of its own (200 W, the console's `prMax`): what matters about it is how much there is, not what
  fraction of the forward power it is. The bars carry the peak, the same figure as the digits
  rather than the instantaneous value the full console's bars use — at two samples a second the
  instantaneous reading is mostly the gaps between syllables, and the bar would sit near zero
  through an entire SSB over.

* **The firmware half is no longer unverified.** Against the live network it saw the real `PA.01`
  announce itself, `PA` correctly protected as a priority prefix, and — against a stand-in on an
  isolated port — real telemetry decoded end to end (`flags:848` = ON+LINK+FULL+BEEP, the peak
  expiring to `null` on schedule) and a command arriving exactly once. Two things worth writing
  down while they were being chased: the daemon publishes **only** from its STATUS handler, so a
  switched-off amplifier sends nothing at all beyond the greeting snapshot a joining peer gets;
  and two TrxNet devices on one host fight over the UDP port, where `SO_REUSEADDR` hands one of
  them every unicast packet and the other sees a peer table but no data.

* **A latent bug found in passing, not fixed here:** `trxnetid` in `handleSet()` has no
  `requestHasArg()` guard (`wifilt.ino:8782`), so any POST to `/setup/save` that omits the field
  sets it to `0x00` and switches TrxNet off. The SETUP page always sends the whole form, so
  nothing hits it today — but it is the same shape as the `fskOutputMode` bug the file already
  warns about, and `panetid` was written with the guard from the start.

* `pa-panel-smoke` is now 58 checks.

* **A PA button appears beside the `?`, and only when there is one.** WIFILT now subscribes to the
  five topics an EXPERT 1K-FA publishes over TrxNet as `PA.xx` — `/pa-flags`, `/fwd`, `/ref`,
  `/swr`, `/band` — and serves them at **`GET /pa.json`**. The button unhides itself when that
  peer is actually in the TrxNet table, so a station without an amplifier never learns it exists.
  It follows the peer table rather than the freshness of telemetry deliberately: a peer lives 95 s
  past its last announce, so a WiFi hiccup does not make a button blink in and out mid-contest.

* **A small palette, movable, that never takes the keyboard.** It shows the forward and reflected
  power as whole watts, SWR, the band, every flag the wire carries (ALARM · TX · TUNE · CONTEST ·
  BEEP, dark ones kept in place so the row never reflows), and the four commands TrxNet accepts —
  ON/OFF, STANDBY/OPERATE, PWR-L/PWR-H, TUNE — in the console's own colours and button states,
  scaled down. Every button cancels its own `mousedown`, so the click fires but the caret never
  leaves Call or Exch. That one line is what makes a floating panel usable over a log that is
  typed into. Position and open/closed survive a reload (`localStorage`, clamped back into the
  viewport on load and resize, wrapped both ways because a private window refuses storage).

* **The peak is held in the firmware, and reading it has no side effect.** `/fwd` arrives five to
  eight times a second while transmitting and the browser reads twice a second — sampling would
  miss two readings in three, and on SSB the number on screen would sit well under what the
  amplifier is delivering. A 2 s window in `wifilt.ino` holds the extreme, which is also the
  "still readable two seconds after PTT" rule: one constant, because both are the same question.
  `fwdPk`/`refPk` come back `null` once it expires, so the browser only chooses between a number
  and a dash. Nothing is cleared on read — two QRPLog tabs open at once is ordinary here, and a
  read-clears peak would split one transmission between them.

* **A command is never reported as a confirmation.** The daemon takes commands only with
  `--trxnet-subscribe` and silently drops them from senders outside `--trxnet-allow`; neither
  refusal comes back on the wire. So each button waits for the amplifier's own flags to move —
  10 s for ON, which takes about seven to come up from DTR, 4 s for the rest — and when they do
  not, it stops waiting and names the two switches to check. The closed loop that converts one
  press into the right number of keystrokes stays in the daemon, where it belongs: `OPERATE` and
  `PWR` are toggle keys, so a blind press is as likely to switch the wrong way.

* **`PA NET_ID` in SETUP → TrxNet** (EEPROM byte 69, previously free), `00` = no amplifier, the
  same disabled sentinel `TRXNET_ID` uses. The live peer list already in that section fills it on
  a click, like the three radio NET_IDs. `PA` is added to the priority prefixes whenever one is
  configured — TrxNet `INTEGRATION.md` §9 asks a device to protect its own targets from eviction
  — as an implicit token rather than by editing the operator's `TRXNET_PRIO` string, which is
  theirs and would not fit anyway once all 71 characters are used.

* **A real bug found by the smoke test, in code this change did not add:** `const app` at the top
  level of a classic script is not a property of `window`, so a page-local widget cannot see it
  however it asks. The band-mismatch check and the TUNE-while-transmitting lockout both read it
  and would have been permanently, quietly green. `log.js` now exports `window.LogRadio`
  deliberately and narrowly — the two facts such widgets actually read, not the whole page state.

* **`tools/pa-panel-smoke.js`** is new (46 checks, real headless browser, fixture serving
  `/pa.json` and recording every `/pa/cmd` body). It asserts on rendered text, on
  `document.activeElement` and on what went on the wire — never on internal state — because the
  three ways this feature breaks are all silent: focus leaving Call, a `null` peak rendering as
  `0 W`, and a dropped command reported as success. **`tools/trxnet-subs-budget-smoke.js`** is
  new too (9 checks): `subscribe()` returns silently when the table is full, and these five topics
  put the sketch at exactly 8/8, so a ninth subscription anywhere would compile, link, run and
  quietly not work. Verified to fail on a deliberately added ninth, naming the topic that would
  vanish.

* Regression: `log-rst-smoke` 24/24, `log-hotkey-smoke` 12/12, `log-year-groups-smoke` 15/15,
  `setup-spine-smoke` 97, `state-json-budget-smoke` 64/64, `fs-partition-audit`,
  `check-page-scripts`, `make -C native`. `native-integration-test.sh` still reports its one known
  red (`TrxNet registers a peer`), confirmed present on a clean HEAD via `git stash` — not this
  change.

* **Not covered automatically, by choice:** the firmware half — the subscriptions, the peak
  window, `/pa.json` and `publishTo` — is verified by hand on the amplifier. `/pa.json`,
  `/pa/cmd`, the SETUP round-trip and the `requestHasArg()` guard were exercised against the
  native build. On the daemon side this needs `--trxnet --trxnet-subscribe`, and `705.xx` in
  `--trxnet-allow` when that list is used.

---

**QRPLog: the saved-log picker folds by year.**

* **One thin collapsible header per season, folded by default.** The LOG dialog listed every log
  ever created as one flat column, so an operator with a few seasons behind them scrolled past
  years of history to reach anything. The list now groups by the year in `createdAtUtc` — newest
  year first, each header carrying its own `N logs · N QSO` — and every year starts closed. Logs
  whose timestamp did not survive an import land in one `—` group, last.

* **The log currently in use never goes into a fold.** It is pinned above the year headers, green
  and tagged `active` as before, and it is omitted from its own year's body so it is never listed
  twice. Which log the next QSO is written into must not cost a click to find out.

* **The filter still searches every log of every year.** It opens whichever years hold a match and
  leaves the rest folded; the years it opened by itself are not remembered, so clearing the filter
  folds them back up while a year the operator opened by hand stays open across a re-render. A
  filter that matches nothing still leaves the active log on screen, with the existing `No match.`
  hint below it.

* **`tools/log-year-groups-smoke.js`** is new (15 checks, real headless browser, IndexedDB seeded
  with five logs across three seasons plus one undated). It asserts on the rows an operator can
  actually see — a row inside a closed `<details>` does not count — which is the only way to catch
  the three ways this feature breaks: years that start open, an active log buried in a fold, and a
  filter that only reaches the years already open. `tools/log-rst-smoke.js` (24/24) and
  `tools/log-hotkey-smoke.js` (12/12) stay green.

---

**M5Stack Atom Lite support, and the firmware now builds with PlatformIO.**

* **New board: M5Stack Atom Lite** (ESP32-PICO-D4, 4 MB). It runs the same `wifilt.ino` as a
  bare module — band decoder and the interface-board outputs absent, reported as revision 99.
  Its one hardware difference is the status LED: the Atom has no plain LED on GPIO 5 but a
  single addressable **SK6812 RGB on GPIO 27**. A small status-LED HAL in `wifilt.ino`
  (`statusLedBegin`/`statusLedLevel`) renders the existing LED vocabulary onto either
  indicator; the box's GPIO 5 LED behaviour is unchanged. On the Atom the colour carries the
  state — blue fade in AP mode, green steady when the station link is up — with brightness
  capped so a bare SK6812 is not dazzling. The board **selects itself**: both toolchains define
  `ARDUINO_M5Stack_ATOM`, which `platform_caps.h` turns into `WIFILT_M5ATOM_LITE`, so no build
  flag is required (the flag stays as a manual override).

* **Both boards build with `arduino-cli`** — `esp32:esp32:esp32` for the box and
  `esp32:esp32:m5stack-atom` for the Atom — as well as with **PlatformIO** (a new
  `platformio.ini` with `esp32` and `m5atom` environments). Both pin arduino-esp32 2.0.14, use
  the 4 MB `partitions.csv`, and pull TrxNet automatically. The native Linux/Windows/ARM64
  targets stay on `native/Makefile`.

* **CI** now compiles both boards with `arduino-cli` (the box and the M5Atom Lite), keeping the
  upstream toolchain. The release scripts (`tools/export-compiled-binary.sh`,
  `tools/release.sh`) still produce the shipped binaries with the Arduino IDE 1.8.

* Not a regression risk for the box: `make -C native` still builds and every board — both
  `arduino-cli` FQBNs and both `pio run` environments — compiles, links and fits `app0`
  (~73 %) with DIO flash-mode images.

* **The web installer now offers the M5Atom Lite too**, closing the gap the PR above left open
  (`HARDWARE.md`/`README.md` pointed Atom owners at a page that could only give them the box's
  image — wrong for the Atom, and a boot-loop risk via the GPIO 16 conflict). `tools/release.sh`
  phase 2 now exports both boards as one step, first-class like the box: an Atom compile failure
  aborts the release the same way a box failure does. `tools/gh-pages.sh` publishes a second,
  optional manifest (`manifest-m5atom.json`) and platform panel — sharing the box's
  bootloader/partition-table/spiffs images byte-for-byte (same `partitions.csv`, same DIO mode),
  differing only in the application image — with its own hardware description (bare module, no
  CI-V/FSK/band decoder/13.8 V) rather than a copy of the box's claims. The Atom's binary is
  optional: absent, the page renders exactly as it did before this board existed.
  The page's "new device or upgrading" gate — previously one set of ids, safe only because there
  was one flashable platform — is now wired per platform (`tools/installer-page-smoke.js` gained
  an independence check: answering the box's question must never perturb the Atom's, and vice
  versa).

---

**REV 20260817.** SETUP now names the build it is served from and the network the device is on.

* **The product name carries its platform.** The heading on SETUP reads `WIFILT-ESP32`,
  `WIFILT-LINUX`, `WIFILT-WINDOWS` or `WIFILT-MACOS`, so an operator with the box and the desktop
  binary open in two tabs can tell the pages apart. `platform_caps.h` stopped calling every
  non-ESP32 build `pc` and names the operating system instead — with a `native` fallback, because a
  platform nobody listed must not be able to claim it is Linux. The word `WIFILT` itself is in the
  HTML and is never rewritten: the suffix is an empty span that grows once `/setup-data.json`
  arrives, so a failed fetch leaves a shorter title rather than a wrong one.

* **The status line says which network the device is on**, not merely whether SoftAP is running.
  One segment with several states — `AP mode ON` in the hotspot, `AP <ssid>` when joined,
  `AP (hidden)` on a network that answers `WL_CONNECTED` with no name, `WiFi down` otherwise, and
  nothing at all on the desktop binary, which has no radio to name a network with. The name comes
  from `WiFi.SSID()` rather than from the configured profile, so the line cannot advertise a network
  the device has since dropped off — the failure it exists to make visible.

* **A fix that fell out of it:** the line was built by concatenation, so an empty first segment
  started it with an orphaned ` | `. Segments are now filtered before they are joined. This was
  invisible until the WiFi segment could be empty, which is every load of the desktop binary.

* Both halves are guarded: `tools/native-integration-test.sh` derives the expected platform from
  `uname` and checks that the WiFi segment is empty on a build with no radio, and
  `tools/setup-spine-smoke.js` reads the rendered heading and status line out of headless Chrome —
  including a device whose blob names neither platform nor network, which is what an old firmware
  and a failed answer both look like.

* Not verified on the radio: `WiFi.SSID()` under a live association, the switch to the second
  profile, and the hotspot.

### Committed earlier today

* The tree was clean at REV 20260817. What follows was the working tree of 2026-08-18 and is now
  committed.

### Still untracked

* **Design notes in `docs/`**, including `first-run-plan.md`,
  `tx-audio-gain-plan-implementace.md`, `tx-auto-gain-implementace.md`,
  `js8-skupiny-implementace.md`, `msgbox-implementace.md`, `js8-signal-stripe-plan.md`,
  `js8-rx-partial-display-plan.md`, `js8-llm-implementace.md`, `aprsis-*.md`, the `js8call-*`
  guides, `docs/agents/` and the radio CI-V manuals in PDF.
* **Agreed but not implemented:** the JS8 LLM chat (`docs/js8-llm-implementace.md`) — budget
  `clamp(frames_rx − 1, 1, 4)`, the timer initiates and the model may only veto, key in
  `localStorage`, since the page is served over an insecure origin.
* **Test harnesses** in `tools/`: `stamp-asset-versions.js`, `js8-modem-failure-smoke.js`,
  `js8-modem-init-race-smoke.js`,
  `js8-groups-smoke.js`, `js8-data-frames-smoke.js`, `js8-aprs-smoke.js`, `js8-txqueue-smoke.js`,
  `civread-smoke.js`, `check-page-scripts.js`, `fixtures/`.
* **`mercury/`** — Rhizomatica Mercury v2 evaluated as a second file-transfer modem beside JS8 and
  WSPR; the WASM build exists and passes a loopback test (~230 kB Brotli). Airtime, not flash, is the
  limiting factor. Notes in `docs/mercury-implementace.md`.
* `backups/` and `AGENTS.md`.

---

## REV 20260817 — 2026-08-18

### `21d7362` release script · `6f74d7e` release.sh · `da3e37a` fix(ci): generate the web assets the integration test serves · `11af540` `2df6079` `ce4b2ea` bugfix

Installer page and release tooling — no firmware behaviour changed.

* **A release is now one script that asks before every phase.** `tools/release.sh` walks
  the nine steps — REV, firmware export, desktop archives, integration test, a hands-on
  run of the Linux binary, installing it on this computer, flashing the board, commit and
  push, publish — and each is a question whose Enter takes the capitalised default. What it adds is not automation but order, because the phases depend on each
  other in ways that are invisible while you run them one at a time:

  `native/dist` archives are named after `REV` (the Makefile reads the same `#define` the
  firmware carries) and `tools/gh-pages.sh` looks for exactly those names, so bumping REV
  without rebuilding them publishes a download page with no desktop downloads at all —
  as a printed line, not an error. `REV` is compiled in as a number and cannot be read
  back out of the `.bin`, so file times are the only cheap check that the exported image
  is the revision everything else claims. And the page is published from a throwaway git
  repository, which means it will carry a build of source that exists nowhere: publishing
  now comes *after* the push and refuses to run unless the tree is clean and `HEAD` is
  `origin/main`.

  Three smaller things the script does because doing them by hand is exactly what gets
  forgotten. It clears archives of other revisions before `make dist`, whose last step is
  `sha256sum *.tar.gz *.zip` and would otherwise publish checksums for releases that are
  not on the page. It re-stamps the asset versions *before* the commit rather than
  leaving it to `gh-pages.sh`, which runs the same stamper inside itself and would dirty
  the tracked `data/*.html` immediately after the commit meant to capture them. And it
  offers `make -C native setcap` before the integration test, because the capability
  lives on the inode, every relink drops it, and without it ports 80/82/83 do not bind —
  so the audio half of the test reports itself as skipped on any machine whose `sudo`
  wants a password.

  Running the binary from the script (phase 5) needed job control to be turned on for
  that one command: without it the app shares the script's process group, and the Ctrl-C
  meant to stop the app would end the release with it. Doing that surfaced a defect in
  the native build worth writing down — on SIGINT it prints `shutting down` and then dies
  on `terminate called without an active exception`, a thread going out of scope
  unjoined, exit 134. The script reports it and carries on instead of asking, because the
  operator pressed that Ctrl-C on purpose.

  That phase also settled a question that has probably cost other people an evening:
  `http://wifilt.local` not loading while the binary sits there serving happily. The
  responder is right — a raw multicast query answers `10.25.100.105` — but `nsswitch.conf`
  reads `hosts: files mdns4_minimal …`, and one line of `/etc/hosts` pinning
  `wifilt.local` to the hardware's address means no mDNS query is ever made. Pointed at a
  network the machine is not on, that looks exactly like a broken web server. The script
  now prints the addresses that do work and names the offending line. It also learned that
  `getcap` is in `/sbin`, off a normal user's `PATH`: called by name alone it reported "no
  capability" for a binary that already had one, and asked for a sudo password that
  changed nothing.

* **`Sketch → Export Compiled Binary` has a headless equivalent.**
  `tools/export-compiled-binary.sh` drives the IDE's own command line and then makes the
  copy that *is* the export — `recipe.output.save_file` renames `wifilt.ino.bin` to
  `wifilt.ino.esp32.bin`, and nothing else. Checked against an IDE export of the same
  source: of 1 024 448 bytes the two images differ in 63, all of them inside the embedded
  ELF SHA-256 at `0xb0`, the checksum byte that field feeds, and the image digest at the
  end. The code is identical.

  It builds in `build/arduino/` with its own settings folder, so an open IDE cannot change
  what is built and the script cannot rewrite the IDE's preferences — `--preferences-file`
  moves Arduino's *whole* settings folder next to that file, which is why the folder needs
  a `packages` symlink back to `~/.arduino15`. It also refuses a non-DIO image, and reports
  the size against `app0` of the sketch-local `partitions.csv` (1.375 MB) instead of the
  2 MB the menu scheme promises and the IDE measures against.

* **The download page now folds into three, and opens none of them.** It had grown into one
  long scroll that laid all three roads end to end — flash an ESP32 board, install on Linux,
  install on Windows — so every reader scrolled through two that were not theirs to reach the
  one that was. The three are now collapsed sections that open on a click, and what decides
  the choice is on the outside of each: what it needs, and how big the download is. They are
  deliberately independent rather than an exclusive accordion, because comparing the Linux and
  Windows halves is a real thing to want, and they carry the anchors `#esp32`, `#linux` and
  `#windows` so a link can land in an open one.

  Folding a page changes what a reader can be assumed to have seen, and that turned out to
  matter more than the layout. Connecting the radio — `SETUP → Radio`, TRX1 to `ICOM-LAN`,
  address and credentials, **Test & identify radio** — used to live inside the ESP32 half,
  where a Linux reader met it in passing on the way down the page. Folded away, that reader
  would never have seen the one step that decides whether any of it works. It is now a section
  of its own below the three, with the address as a link that opens in its own tab. The same
  reasoning moved `SHA256SUMS` into both download blocks: it was mentioned only in the Windows
  paragraph, which a Linux reader will now never open.

  It also settled a sentence that was simply untrue. The page told anyone with *"a radio
  connected only by USB"* that they needed the interface board — a connection this project
  has never had. Radios are reached over ICOM-LAN, over the CI-V serial bus or over TrxNet,
  and what the board really adds over the PC build is exactly what `platform_caps.h` compiles
  out of it: the CI-V wire, the GPIO pins behind FSK/RTTY keying and the band decoder, the
  switched 13.8 V output and the status LED — plus running at all with no computer switched
  on. That is now the text that helps the reader choose. In the same pass, step 0 of *the
  whole road* stopped calling itself *Flash firmware*: it stands above all three platforms
  now, and two of them flash nothing.

  `tools/installer-page-smoke.js` grew the folds into its contract: the ESP32 section is
  required, the desktop two are checked only when the build actually carried their archive,
  every fold present must be closed on load and must stay open when the others are opened,
  and the flash gate is now exercised through an open fold rather than a hidden one. Four new
  regression guards refuse the USB sentence, a fold shipped `open`, the exclusive-accordion
  `name=` attribute, and a step 0 that calls itself a flash again.

---

## REV 20260816 — 2026-08-16 … 2026-08-17

### `a95011c` feat: native build for Linux and Windows from the same source

* **The interface now also runs as a PC program**, built from the same 9 000-line sketch: `native/`
  carries a small Arduino compatibility layer (`String`, `Print`, `Stream`, `IPAddress`, the
  `esp32-hal` shims) plus a Makefile that produces a Linux and a Windows binary, 7 600 lines in
  total and one line changed in `wifilt.ino`.
* **The differences between the two machines are named once**, in `platform_caps.h`, instead of
  being scattered as `#ifdef`s: the ESP32 box has a WiFi radio, a CI-V UART and seven GPIOs, the PC
  build has none of those and reaches radios purely over IP. `WIFILT_NATIVE` is defined only by
  `native/Makefile`, so the board keeps every capability and nothing about it changes.

### `14d5b62` feat(setup): hide what the running build does not physically have

* **SETUP is told what the build can do** — `platform` and `caps` in `/setup-data.json` — and hides
  the controls that cannot work on it, so the PC build does not offer a CI-V bus, GPIO keying, the
  band decoder or the switched 13.8 V output it has no hardware for.

### `15bf9a8` test: exercise every transport without a radio, and build all three targets in CI

* **Every transport can now be exercised with no radio present**: `tools/icom-lan-fake-radio.py`
  (513 lines) answers the Icom LAN protocol, `tools/dxc-fake-cluster.py` a DX cluster,
  `tools/aud1-ws-check.py` and `tools/dxc-ws-check.py` drive the two WebSocket channels, and
  `tools/native-integration-test.sh` ties them together.
* CI (`.github/workflows/build.yml`) builds all three targets — ESP32, Linux, Windows — so a change
  that compiles on one and not the others is caught before a release.

### `5179395` fix: report socket failures instead of silently claiming success

* **A failed send is reported as a failure.** The non-blocking socket layer (`net_nonblocking.h`)
  and the LAN client had paths that returned success after writing nothing, which is the worst
  possible answer: the caller believed the radio had been told something it never heard.

### `6f3a251` aprs igate · `53fc838` many bugfix + manual update

* **The station can now be an APRS-IS IGate for the JS8 band.** When any station on the
  air addresses `@APRSIS` — `GRID JN79NX` to put its position on the map, or
  `CMD :SMSGTE   :…` to reach a gateway robot — an IGate somewhere has to carry that to
  the internet or it goes nowhere. From this revision this interface can be that IGate.
  Nothing is transmitted on the radio; the traffic goes out over the network, under your
  callsign, and only while the DATA page is open, because that is where JS8 is decoded.

  Switched off by default and configured in **JS8 settings → Gate @APRSIS to the
  internet**: an APRS-IS callsign (proposed as your own with SSID `-10`, because APRS-IS
  allows one connection per callsign-SSID and a WX station or JS8Call elsewhere may
  already hold yours), the passcode, and the server. The passcode is checked against the
  callsign as you type it: a wrong one is the worst failure APRS-IS has, because the
  server accepts the connection and then drops every packet in silence. The gate refuses
  to open at all in that case and the line under the field says so.

  Each gated row in Recent traffic carries an **IGATE** badge with five states, and the
  distinction they draw is the point of the feature: `↑` means the bytes reached the
  socket, `✓` means APRS-IS answered `logresp … verified`, `✗` means it refused the login,
  `–` means the message was deliberately not gated and why. The tooltip holds the exact
  frame that was published under your callsign; a green badge links straight to the raw
  packet view on aprs.fi. The header pill counts **verified** packets against the hourly
  cap, so a gate delivering nothing can never read as a busy one.

  Four filters stand between "somebody transmitted" and "our callsign published it": a
  reception with a lost end-of-message is displayed but never gated (a truncated `JN89HK`
  becomes `JN89`, a valid locator tens of kilometres away), blocked callsigns and DXCC
  entities get no gateway either, the same station with the same content is gated once per
  ten minutes, and thirty packets an hour is the ceiling. All four survive a page reload.
  A packet that could not be sent — the interface refuses to open a socket while it is
  transmitting — is retried for five minutes and then dropped rather than delivered late,
  because a position report carries no timestamp and a late one claims to be current.

  Two deliberate differences from JS8Call, both verified against the APRS specification:

  * **The position is the centre of the locator's cell, not its south-west corner.**
    JS8Call never adds the half cell, so its spots sit about 1.2 km south and 1.6 km west
    of the station — tens of kilometres on a four-character locator. The consequence is
    honest and worth knowing: a station gated by both will appear twice on the map.
  * **The path says `qAR`, not `qAS`.** `qAR` means "an IGate received this on the radio",
    which is what happened; `qAS` claims a server injected it. The IGate callsign after it
    is yours, so a packet can be traced back to this box.

  One thing worth knowing about how it is configured: the gate lives in the JS8 profile,
  and that profile is **shared** — it is stored on the interface and read by every browser
  that opens DATA. Configuring the gate once configures it for the station, and every one
  of those browsers is then a gate in its own right. That is why the duplicate check and
  the hourly cap are enforced **on the interface** and not in the browser: two tabs, or a
  tablet and a phone, would otherwise publish the same position twice under one callsign,
  and a per-browser cap is no cap at all.

  Design, packet format and the twenty decisions behind them:
  `docs/aprsis-igate-implementace.md`.

  Verified in software only — `tools/js8-aprs-gate-smoke.js` (the filters, the queue, the
  frame and the line-injection refusal), `tools/aprsis-conversion-parity.js` (16 566
  conversions compiled out of `wifilt.ino` and compared against the browser's, hostile
  input included, so the C++ and the JavaScript cannot drift apart), fourteen new checks
  in `tools/data-browser-smoke.js`, and `tools/aprsis-fake-server.js` for pointing the
  device at a server on your own desk. **Nothing has been through a real APRS-IS server or
  off the air yet.**

* **The APRS-IS callsign field was too narrow to show a single character.** The settings
  row is a three-track grid whose last track is sized to its content and therefore takes
  what it needs first; the hint beside the field landed in it and squeezed the input down to
  the 20-pixel floor the grid allows. The hint now sits on a row of its own like every other
  description in that panel, and the three APRS-IS fields have a floor measured in
  characters — nine for the callsign, which is what `OK1ABC-10` needs. The browser harness
  now *measures* the rendered width rather than trusting the markup, and that check goes red
  against the old layout.

* **Manual.** `SOFTWARE.md` gains **section 5.7 — APRS-IS gate (IGate)**, next to the
  @APRSIS command builder it is the mirror image of: what is carried, how to switch it on,
  what the SSID and the passcode are for, what the four filters refuse, how to read the five
  badge states, and why one gate is a gate for the whole station rather than per browser.
  Sections 5.7–5.17 shift up by one. Shorter notes go where the feature is actually met:
  the SETTINGS table, the header markers, Recent traffic, *What is stored where* (the login
  is in the shared profile and therefore in the configuration backup), and *Transmit safety*
  — where it is the one automatic function whose output is a network packet rather than a
  signal, and which carries somebody else's words under your callsign.

* **Code review of the above, fifteen fixes.** Four are worth knowing about:

  * **A station on the air could have published an arbitrary APRS-IS packet under your
    callsign.** `\n` is a literal in the JS8 alphabet, and APRS-IS is a line protocol, so
    a newline inside an `@APRSIS CMD` text was not a malformed message — it was a second
    packet, chosen by whoever transmitted it, and every check the code had passed it. A
    control character in any field is now refused outright, in the browser and again in
    the firmware. The parity sweep that was supposed to catch the firmware half was
    feeding it only well-formed callsigns; it now feeds it hostile ones too.
  * **Nothing would ever have been reported as accepted.** The queue sent the next packet
    before collecting the previous one's verdict, and the interface remembers one result —
    so on a band where somebody beacons every fifteen seconds no packet ever reached
    `verified`, the hourly cap never engaged, and the header read `IGATE 0/30` while
    packets were going out. It now collects first and sends second.
  * **A busy radio dropped positions.** The interface refuses to open a socket while
    transmitting, which is routine, but the browser counted each refusal as a failed
    attempt and gave up after four — under two minutes. "Not now" no longer costs an
    attempt; the five-minute validity is what ends it.
  * **The web request no longer touches the network at all.** It used to resolve DNS and
    connect inside the handler, which runs in the same loop as the audio the radio is
    being fed — `WiFi.hostByName` blocks for seconds. The request now parks the packet and
    answers `202`; the socket work happens on later passes, guarded like every other
    blocking call in the sketch.

  Also fixed: the backoff refused everything between 24 and 49 days of uptime (a deadline
  compared against its own uninitialised value); a packet caught mid-flight by a page
  reload was stranded for ever as an amber badge; the verdict window was measured from
  when the message was decoded rather than from when the packet was sent, so exactly the
  packets that needed retries were never resolved; the 700 ms limit on the server's login
  answer was a hard deadline that made a working gate on a distant server report nothing
  as verified; the last step of the retry ladder was unreachable; and the badge is now a
  key lookup instead of two linear scans and a regex per row on every render.

* **A message for your callsign no longer unfolds the Stations table.** It opened both
  Recent traffic and Stations, because every callsign named in a frame enters the station
  table — including your own, as the addressee of somebody else's message, listed there as
  heard about only. So a directed message moved two sections and the second one had nothing
  in it the operator came for: the text is in the traffic feed. Recent traffic still pops
  open on a message for MYCALL; Stations now stays exactly where it was left.

* **A session left open over midnight shuffled yesterday's messages in among today's.**
  The TX SESSION thread was ordered by the clock printed on each bubble, and that clock is
  a time of day with no date in it — so yesterday 22:04 filed itself *after* today 07:15,
  and a day-old exchange surfaced as if it were the current one. Every row now carries the
  absolute moment it happened and the thread is ordered by that; rows restored from a
  session snapshot written before this have their stamp rebuilt from the time the snapshot
  was saved. Because the bubbles still show only an hour, the thread now draws a dividing
  line where the day changes, naming it (`yesterday`, or the date) and marking where
  `today` begins — with no line at all when everything on screen is from today.

---

## REV 20260815 — 2026-08-16

### `7f93600` NEW send MSG via + fix log hotkey, ALC, msg box, ack, reply

Browser only — no firmware behaviour changed.

* **Messages can now be routed through a station that hears the addressee.** The stations
  map already knew who copies whom; that knowledge only ever reached the automation, never
  the operator. Filling in **Recipient** now offers a list of routes under the Message
  field, best first, and clicking one sends the message as mail to that station's inbox
  (`MSG TO:<addressee> <text>`) instead of straight at somebody who cannot hear it.

  Each row carries the numbers the choice actually rests on: my own signal from the
  intermediary, what the intermediary reported hearing from the addressee, what the
  addressee reported back, whether that station has ever reacted to me, and how old the
  evidence is. The first row is **DIRECT** with the addressee's own signal, so "through
  nobody" is a visible choice rather than the absence of one.

  Three things worth knowing about how it behaves:

  * **Recipient keeps showing the addressee.** The route lives in a badge under the field,
    so the chat thread, LOG QSO and the SNR preset all stay with the person being written
    to. The send hint says where the frame is really going — `Enter sends to OK2ABC for
    OK1XYZ` — with the frame count of the whole message, prefix included.
  * **Enter sends now, SEND LATER pins the route.** A pinned message waits for that one
    station and is parked nowhere else; direct delivery to the addressee is never blocked
    by a pin.
  * **A message sent this way stays in the MSG BOX as `waiting`** until the intermediary
    acknowledges storing it, which is the only proof the protocol can produce. That ACK now
    also writes a line into the addressee's own thread, so the whole story of one message
    is in one place.

  Only hard obstacles refuse the send (blocked entity, an exchange already open with that
  station, an unaddressable callsign, a group). Evidence older than the hour turns the badge
  amber and says its age, but still sends: reports that stopped being renewed are not proof
  the path is gone. A draft that carries its own recipient (`@APRSIS`, `CQ`) wins over a
  chosen route and says out loud that it dropped it.

  Design and the fifteen decisions behind it: `docs/js8-via-cesty-plan.md`.

* **Code review of the above, seven fixes.** Worth knowing about two of them:

  * **The routes panel could never hide.** `display` on the class beat the browser's own
    `[hidden]` rule, so clearing the recipient left the previous addressee's routes on
    screen and still clickable. The check that should have caught it read the `hidden`
    property instead of the computed style; it now reads the style.
  * **The amber "evidence is getting old" warning was unreachable.** Routes are derived
    from reports younger than an hour, so a route older than an hour is not shown at all —
    the warning could never fire. It now fires at half the window, while the evidence is
    still there but ageing, which is what decision 9 was actually about.

  Also: the auto-open heuristic no longer latches after its first firing (a `<details>`
  reports a programmatic open through the same event a click does); the panel no longer
  retires a pending mail transaction as a side effect of drawing a tooltip; route
  freshness is measured on the same corrected clock as everything else on the page; an
  unusable SEND LATER pin is refused instead of silently widening back to "park it
  anywhere"; and the frame count is cached and debounced rather than re-encoding the
  message on every keystroke and every radio poll.

* **A station with its own encoding profile cannot be reached through stored mail at
  all** — neither through an intermediary nor with SEND LATER. Mail is written by the mail
  path, not the composer, so it never passes through what the module applies. And a parked
  message is stored **as it was typed** in `/msgbox.jsonl` on the device, which the
  firmware serves to anyone on the LAN without authentication — so warning the operator
  would not have helped: a warning does not un-write that file. The route list is empty for
  such a station and says why, SEND LATER is disabled with the same reason, and both
  `viaBlockReasons` and `deferMessage` refuse behind the button.

  `data.js` grows one neutral extension point (`mailPathRefusal`) that data-layer modules
  wrap; the base page never objects. Note it applies when the message is composed, not
  retroactively: anything parked before the profile existed still goes out as it was
  stored.

* **Unread mail now turns the whole status bar red.** It was announced by `1 NEW` in the MSG
  BOX section header — small, red, and inside a `<details>` that is normally collapsed, so
  the one operator who most needs it (watching the radio, not the browser) never saw it. The
  bar that starts with the `?` button now changes colour whenever the box holds mail for you,
  and carries a button naming the sender and the start of the text:
  `✉ 2 NEW MSG · OK1BT`. Clicking it opens MSG BOX and scrolls there — and does nothing else:
  the message stays unread, because reading is still confirmed by clicking the message
  itself, which is the rule that keeps mail from being lost by scrolling past it.
  ([`data.js`](data/data.js) `renderMsgBoxAlert`, [`data.css`](data/data.css) `.has-mail`,
  documented in [`SOFTWARE.md`](SOFTWARE.md) section 5.2 with a screenshot.)
* **The alert survived the message it was announcing.** Deleting the mail cleared the red
  background but left the oval on screen. `.msgbox-alert` is `display:flex`, and an author
  rule beats the browser's own `[hidden] { display:none }` whatever the specificity — so the
  `hidden` attribute the code sets did nothing, and the button was in fact visible from page
  load, before any mail existed. Every other flex element in this stylesheet carries its own
  `[hidden]` companion; this one did not. Worth more than the fix: the two smoke checks that
  should have caught it read the `hidden` **property**, which was perfectly true while the
  button sat there — they now measure computed `display`, and a third check
  (`msgBoxHeaderAlertGoneAfterDelete`) deletes an unread message rather than reading it.
* **A deferred message stayed `waiting` after its ACK had arrived.** Seen on the air
  2026-08-13: OK1BT was heard on a −22 dB heartbeat, the direct `MSG` drew no answer, and the
  message was then parked at M9LOV — which had reported OK1BT at +03 dB — as
  `MSG TO:OK1BT DELAYED MESSAGE TEST`. Its ACK came back 75 s later and was discarded. `ACK`
  carries no message id, so it is matched by a window of four slot periods (decision 12 of
  [`docs/msgbox-implementace.md`](docs/msgbox-implementace.md)) — but the window was started
  when the message was **queued**, and mail is multi-frame: that `MSG TO:` is four frames, a
  full minute of keying, so the 60 s had run out before M9LOV could key up. Not an edge case
  either — the shortest mail there is could not have made it. The window now opens when the
  transmission **ends** ([`data.js`](data/data.js) `noteMailTxSettled`), and a transmission
  that never reached the antenna closes the exchange instead of blocking the station for four
  more periods. What the bug cost was not only a wrong label: the record stayed live, so the
  hourly retry would have parked the same message again and again — the duplicates decision 5
  exists to prevent — and a real delivery ACK could never have closed a record either.
  `data-browser-smoke` gains `msgBoxAckWindowRunsFromTxEnd` (green; red with the fix backed
  out, checked both ways) plus the `txComplete` / `clockShift` / `msgBoxDelete` hooks it needs.

Audit of the whole message stack against JS8Call (`processCommandActivity.cpp`,
`Varicode.cpp`), prompted by the relayed-message and `@ALLCALL NO` findings below — same
class of bug, hunted deliberately. Seven findings, all fixed:

* **`MSG TO:` had the wrong wire shape in BOTH directions — the parked-message path never
  worked against a real JS8Call station.** On the wire the `TO:` prefix is part of the
  command token (JS8Call's regex reads `MSG TO[:]`), so the payload of a genuine frame is
  `CALL text`, no prefix. Our receiver demanded `TO:` and NACKed real frames as malformed;
  our transmitter required a space after every token, so `MSG TO:OK1BT HI` fell through to
  the plain ` MSG` command with `TO:OK1BT HI` left in the data — which a JS8Call intermediary
  files as its **own operator's** mail and never stores for the third party. Its ACK then let
  us mark the record `parked`: a false success. Invisible between two WIFILT stations,
  because both halves mirrored the same mistake ([`js8-protocol.js`](data/js8-protocol.js)
  tokenizer now takes `:`-terminated tokens without a space; [`js8-inbox.js`](data/js8-inbox.js)
  `parseMsgTo` accepts both payload forms, so frames from older WIFILT builds still store).
* **Relay forwarding attributed the originator as ` DE `, which JS8Call cannot see** — its
  `parseRelayPathCallsigns` reads only `*DE*` and `VIA`. A chain through us therefore lost
  its originator at the next JS8Call hop: the ACK died at the intermediary and the
  recipient's inbox credited the wrong station. We now write ` *DE* `, exactly what JS8Call
  writes when it forwards ([`js8-relay.js`](data/js8-relay.js)).
* **`AGN?` sent to a group is now refused**, matching upstream's `!isGroupCall`: every member
  would repeat a *different* message into the same slot — the same pile-up the `@ALLCALL
  QUERY MSGS` fix stopped, with a rarer trigger.
* **`AGN?` from a station we never wrote to is now answered** with our last transmission of
  any kind (upstream's `m_lastTxMessage` semantics) — the station that copied our CQ garbled
  and asked for a repeat used to get silence. One deliberate difference: the answer is
  addressed to the asker, not re-broadcast verbatim.
* **Machine chatter that arrived through a relay is no longer filed as mail.** The relay hop
  reduces every command to plain text, so a relayed `ACK` or `SNR +05` sailed past the
  command-based filter into the MSG BOX as an UNREAD message. A word-level filter
  (`isMachineText`) now catches it; the conversation view still shows it.
* **` CMD` and ` QSL?` joined the machine-command list** — a buffered `CMD` with a payload
  used to become mail; upstream drops it outright.
* **A portable station collects its own mail:** `OK1BT/P` asking `QUERY MSGS`/`QUERY MSG`
  now matches mail stored for `OK1BT` (longest-segment base call, upstream's
  `base_callsign` comparison). A stranger asking for somebody else's message is still
  refused.
* Verified in parity (no change needed): `NEXT MSG ID` tail, checksum table
  {5,9,10,11,12,13,24}=16 bit, HB advert `HEARTBEAT SNR ±nn MSG ID n` (our parser also
  tolerates upstream's stray `)` in the `+n` variant), `YES MSG ID n +m`, delivery format,
  `QUERY CALL` answer/silence, ACK correlation, armed gates.
* Harness: three new checks (`msgToUnprefixedStored`, `relayedMachineNotFiled`,
  `msgToWireShape` in `js8-data-frames-smoke` — a full encoder→ActivityStore round trip),
  `relayForward`/`relayHopSpace` expectations updated to `*DE*`. Chased a real harness bug
  the new checks exposed: **inbox replies carry a 30-minute TTL, so a check that provokes
  one and only clicks ABORT leaves it queued**, and it keys up at random inside a later
  timing check (`txCompleted`/`heartbeatTx` flapping) — every such block now calls
  `clearTxQueue()`; the `txCompleted` poll budget and the harness timeout grew with the run
  (110→170 tries, 90→120 s). Known reds unchanged.
* **A message relayed to us was displayed and nothing else — no ACK, no MSG BOX entry.**
  Found on real traffic: OK1BT sent mail through HB9BV, it decoded cleanly (CRC verified, EOT
  seen) and then fell between two engines. `MSG`, `MSG TO:` and the `QUERY`s are multi-frame
  commands owned by the ASSEMBLED path ([`data.js`](data/data.js) `handleInboxAssembled`), but
  `handleRelayAssembled` handed anything starting with a command token to the PER-FRAME path,
  where the only handler table is the auto-reply one — and it has no entry for `MSG`. The
  relayed command is now normalized and routed to the engine that owns it; only the
  single-frame queries still go the per-frame way. This is what upstream does too
  (`processCommandActivity.cpp` puts the relayed command back into its own RX queue, and
  ` MSG` is in `autoreply_cmds`).
* **The ACK now goes back the way the message came.** A reply is wrapped as a relay hop
  through the intermediary (`>OK1BT>ACK` to HB9BV) rather than sent to a station that is not
  on the band — upstream sends `<relayPath> ACK` for the same reason.
* **The originator was being read wrong, silently.** JS8Call writes the attribution as
  `*DE* OK1BT`; [`data.js`](data/data.js) matched a bare `DE` only (`js8-relay.js` had always
  read all three forms). The originator therefore fell back to the relay, so even a correct
  ACK would have stopped at the intermediary and the MSG BOX would have credited the message
  to a station that merely carried it. Relayed mail is now filed against the sender with the
  intermediary kept beside it — new `via` field, shown under the callsign in the MSG BOX,
  named in the REPLY tooltip because a direct answer may never arrive.
* **A broken message addressed to us is no longer dropped in silence** — and it asks the
  question that survives a collision. `QUERY MSGS` goes first, because upstream answers it
  out of the store (`getNextMessageIdForCallsign`), so the answer holds an hour later; a
  `YES MSG ID n` then hands the exchange to the existing pickup path, which fetches the
  message by id and ACKs it. `AGN?` is only the fallback for `NO` or two unanswered queries.
  The order is what matters: `AGN?` is answered with `m_lastTxMessage`, **the station's last
  transmission, whatever it was**, so a question that collides with their slot costs one turn
  in the addressed route and usually the whole message in the `AGN?` one.
* **And it no longer transmits into their turn.** The first version pushed straight onto the
  TX queue, bypassing both the QSO lock and the reassembly check — asking a station to repeat
  itself while it was mid-transmission. A question is now held while a message is still
  arriving (`hasActiveReassembly`) and during the one-minute quiet window after any directed
  frame, with the reason on the row.
* **It keeps asking, and what stops it is not a try count.** Knowing a message exists is a
  standing reason, so there is no attempt limit: 1, 2, 5, 10, 20 and then every 30 minutes,
  paused while the station is not heard and resumed when it reappears, for up to a day of
  automatic asking — driven by a 15 s scheduler job, since the retry windows are minutes long
  and a due attempt is routinely postponed by the collision guards. The "it has transmitted
  since" verdict applies **only in the `AGN?` phase**; `QUERY MSGS` is never invalidated that
  way. **ASK** overrules everything for one immediate try, and a complete message from that
  station clears the request.
* **We answered `NO` to `@ALLCALL QUERY MSGS`** — seen on the air: N0IPA canvassed the band
  and this station told it, personally, that it had nothing. Every station hearing that call
  would send the same thing in the same slot, burying the one station that does hold mail.
  `_queryMsgs` now knows which group the question arrived on and stays silent when it has
  nothing to offer; asked by callsign it still answers `NO`. Upstream draws the line only at
  `@ALLCALL` (`if (!isAllCall && reply.isEmpty())`); we draw it at every group, because the
  pile-up does not care which one it is.
* **`MSG`, `MSG TO:` and `QUERY MSG` to `@ALLCALL` are now refused**, matching upstream's
  `!isAllCall` guards. Ours accepted them because `@ALLCALL` is an always-joined group, so a
  call to the whole band could make this station store mail or hand a message over.
* **A `YES` to a group question goes out on a free offset**, through the same picker the
  auto-reply path already uses: the members that have an answer are exactly the ones that
  would otherwise collide with each other.
* **The pickup phase is driven, not just watched.** A `YES` hands the exchange to the mail
  pickup path — but a pickup can end without delivering (it gives up after five tries, and
  the operator can drop it), and a request parked in that phase would then wait for a fetch
  that is never coming. The tick now pushes the fetch along and falls back to asking for
  itself when the pickup is gone. Found by following the id-to-text chain end to end after
  the question *"does it not just get the message number instead of the content?"* — the
  chain does deliver the text (`repeatDeliversText`), but this was the hole in it.
* **A probe must not change anything.** `renderInbox()` asks each row *could this go out?*
  on every paint, and that path was allowed to change the phase — so the panel undid the
  `pickup` phase in the instant between the `YES` and the pickup being registered. Two fixes:
  the probe branch returns a reason instead of writing, and the phase change no longer
  repaints before the state it describes exists.
* The browser harness budget went 55 s → 90 s: this work added ten checks and several
  transmissions, and the run started timing out intermittently — which looks nothing like a
  failing check, it looks like the page hanging.
* **The request is visible the whole time** — its own row in the MSG BOX beside the pickups:
  *Unreadable MSG from OK1BT (bad crc) · 3 asks*, with the state naming what it is actually
  doing (`asking` / `collecting` / `asking AGN?` / `operator`) plus **ASK** / **DEL**. An
  operator who is never told assumes nothing is happening.
* **We can be an intermediary for JS8Call again.** JS8Call separates the next hop with a
  SPACE and only rewrites it to `>` when it forwards (`[> ]` in its relay regex);
  [`js8-relay.js`](data/js8-relay.js) read `>` alone, so a chain we were meant to pass on
  ended at us. The space form is read more strictly than the `>` one — after `>` the protocol
  says the token IS a callsign, after a space it is only the first word, and `isCallsign`
  alone would have hopped "MSG TEST …" to a station called `MSG`.
* Manual: `SOFTWARE.md` §5.10 gains the relayed-mail and unreadable-message sections and
  §5.12 says that arming is also what lets the station ask for a repeat;
  `ui-inventory --check` 256/256, undocumented status strings 14 → 12.
* Tests: `data-browser-smoke` gains `relayedMsgAck`, `relayedMsgFiled`, `relayedMsgShowsVia`,
  `relayHopSpace`, `repeatRequest`, `repeatOncePerWindow`, `repeatRowVisible`,
  `repeatPicksUpOnYes`, `repeatShowsCollecting`, `repeatPhaseIsPickup`, `repeatDeliversText`,
  `repeatAcksDelivery`, `repeatRowGoneAfterPickup`, `repeatFallsBackToAgn`,
  `repeatStopsWhenDisplaced`, `repeatClearedOnArrival`, `queryMsgsGroupSilent`,
  `queryMsgsDirectSaysNo`, `queryMsgsGroupAnswersWhenHolding` (all green, known reds unchanged
  — `presetStable`, `removedPagesAbsentFromNav`, `setupRemovedPagesAbsentFromNav`,
  `txSlotPauseVisual`, `setupSave`); `js8-txqueue`,
  `js8-groups`, `js8-aprs`, `js8-data-frames` unchanged. Not verified on the radio.
* **The ALC limiter went blind after the first frame of every message.** A JS8 message is
  several frames, each its own keying and its own `tx.prepare` — and `tx.prepare` nulls
  `alcSeq` and `consumed` in the firmware ([`wifilt.ino`](wifilt.ino) `aud1AlcReset()`),
  while `TxAlcGuard` brackets the whole message. From frame two on, the restarted sequence
  read as a repeat of frame one's and every ALC reading was discarded. Whatever frame one
  decided stayed on the air unwatched. Found from a two-frame `@APRSIS GRID` beacon whose
  second transmission was visibly quieter. `noteLevel()` now follows `txId` and restarts
  the evidence window — never the decision — at each frame boundary.
* **And inside one frame it could take six dB off for one gust.** JS8 bakes the level into a
  whole frame, so a reduction reaches the air only on the NEXT one; every further reading in
  the current frame still describes the level already decided against. The guard charged a
  dB for each of them. New `levelBakedPerFrame` option (on for JS8, off for the WSPR beacon,
  which is one streamed transmission where a reduction lands within the settle window) caps
  it at one reduction per frame.
* **The trim is now visible while it happens** — `ALC -1.0 dB` beside ABORT, with the reason
  in its tooltip. It used to be reported only through `calResolved`, inside a settings
  section nobody has open during a transmission, and only after two witnesses rewrote the
  table. A single-dB trim, the common case, was a quieter frame with no explanation. A clean
  message clears it, exactly as it clears the guard's witness.
* **What the table learns did NOT change**, and now says why in the code: with baked frames
  the persisted level is a step below anything that flew, because the last frame went out
  before the readings taken during it. Filing it is still right — each reduction answers a
  frame that was already transmitting one step higher and still drove the ALC, so that level
  is disproved; "untested successor" is what the two-witness rule covers. Filing only what
  flew would mean a single-frame message — a heartbeat, a CQ, most of what this station sends
  — could never teach the table anything.
* Tests: `tools/tx-gain-cal-smoke.js` 105/105 (seven new cases: the frame boundary, the
  baked-frame cap, what a two-frame and a single-frame message persist, the untouched
  streaming path, `txId`-less callers), `data-browser-smoke` `alcLimiterHearsTheSecondFrame`
  + `alcTrimIsVisibleWhileItHappens` green with its known reds unchanged, `wspr-browser-smoke`
  274/274 unchanged. Not verified on the radio.
* **The waterfall controls stopped eating four rows in a narrow window.** `TX speed`,
  `TX offset` and `Audio` need about 440 px side by side, but the row was laid out as equal
  columns — two of them below 900 px, one below 560 px — so with the browser window pulled
  in each control was stretched across the full width and pushed onto a line of its own: at
  a 560 px window the speed select alone was 423 px wide and the block was 159 px tall for
  four items. The row now wraps by content instead of being cut into columns
  ([`data/data.css`](data/data.css)): all three sit on one line down to a 440 px window with
  `HB`/`TUNE` on the line below, and from 680 px up to the 900 px breakpoint the buttons
  join them on that same line — the block is 97 px tall where it used to be 159 px, and
  59 px where it used to be 97 px. Below 560 px the resolved-speed hint (`→ A · 15 s`) gives
  way, because the slot meter directly above the row already reads `A 15 s`, and the offset
  field is capped at the width four digits need. The rules are scoped to `#js8Interface`:
  the WSPR beacon reuses the same class for a row of three read-outs and keeps its own grid.
  Measured in headless Chrome across 320–1000 px; not verified on the radio.

---

## REV 20260813 — 2026-08-14

### `e844bd8` bugfix and manual update

* Manual and screenshots brought in step with the JS8 TX-session and APRS-IS windows, and the test
  suite grew where the previous two revisions had been thin: new `tools/log-hotkey-smoke.js` (230
  lines) and `tools/tx-gain-cal-smoke.js` (110), `tools/data-browser-smoke.js` +244,
  `tools/js8-data-frames-smoke.js` +19.

---

## REV 20260812 — 2026-08-13

### `027a186` log hotkey fix

* **QRPLog keyboard shortcuts corrected** (`data/log.js`): the hotkeys that save and clear a QSO
  were reachable in states where they did the wrong thing, or not reachable at all where they
  should have been. Pinned afterwards by `tools/log-hotkey-smoke.js` in `e844bd8`.

### `7c07b99` changelog

* Documentation only.

---

## REV 20260811 — 2026-08-11 … 2026-08-12

### `a49fdde` gps vew + modem load bugfix

* **The GPS panel reached the shared topbar**, so position, time and fix age are visible from every
  page rather than only from DATA (`data/fw-version.js`, `data/data.html`).

* **`Modem loading failed` at 2 %, on a modem whose download was fine.** The worker's `init` is
  three fetches and two WASM instantiations deep — seconds, over a link that carries one HTTP
  request at a time — and an `async` message handler hands control back to the queue at its first
  await. The DATA page ticks `expire` once a second from the moment the decoder object exists, so
  the first tick was dispatched into a worker whose `runtime` was still `undefined`, threw
  `runtime is undefined`, and left through the same channel a dropped download uses. The page
  believed it, called `failModem()`, stopped the audio, and its one free retry hit the same race.
  2 % is where `init` first suspends: `loadBrotli()` posts its progress and then awaits.
* **Written on 2026-08-01 with the `expire` message itself, and invisible until 2026-08-12.**
  `ASSET_REV` was a hand-typed `20260719d` — older than the worker it versioned — so every browser
  that had opened the DATA page kept serving the *previous* `js8-worker.js` from its hour-long
  cache, and that worker simply ignored the unknown message type. The content-derived `?v=` of the
  entry above finally shipped the new worker, and the latent fault fired on the first load. The
  cache-busting fix did not cause this; it revealed it.
* **Both halves fixed.** `data/js8-worker.js` gates every non-`init` message on an init promise, so
  early messages keep their order and none is dropped, and refuses silently when `init` failed —
  one broken download must not become one failure report per second. `data/js8-adapter.js` holds
  `expire()` until the worker is ready, because there is nothing to age out before then.
* Verified by the new `tools/js8-modem-init-race-smoke.js`, which drives the real worker through
  its Node branch in the order the page produces (10/10, and 7 of them red against the previous
  worker via `JS8_WORKER=`), plus two checks in `tools/js8-modem-failure-smoke.js` (9/9).
  `data-browser-smoke` red set unchanged — a subset of the six known reds.

### `d48f42d` ic-705 gps

* **The radio's own GPS is read over CI-V and published in `/state`.** `wifilt.ino` (+307) decodes
  the `23 00` reply field by field — BCD position, altitude as
  `[0 m10000][m1000 m100][m10 m1][m0.1 sign]`, course in four BCD digits, and a UTC
  `yyyymmddHHMMSS` stamp — and treats an all-`FF` field as *absent*, which the guide allows, so a
  partial reply keeps the last known value instead of overwriting it with nonsense. Both delivery
  paths land in the same decoder: `processCivBuffer()` for TRX1 and the LAN snapshot for a radio in
  another slot. GPS belongs to whichever radio `gpsPollTick()` watches — the same one the JS8 pages
  drive.
* **Freshness is the firmware's own stamp-movement age, never the browser clock**: the question is
  whether the UTC stamp inside the reply moved between two reads. A *manual* position (radio menu
  `GPS Select = Manual`) is a valid position but not a fix, and is reported as such — the locator is
  usable, the "position came from the receiver" claim is not.
* **`@APRSIS GRID` beacon and tracking** built on it: a position beacon is a transmission, so it
  sits behind exactly the same TX gate as everything else, and every `@APRSIS GRID` leaving the
  station feeds the tracking lockout whatever composed it. The locator appears in the page's
  identity bar, and an open GPS panel follows the firmware's 5 s poll.
* `SOFTWARE.md` documents it; `tools/data-browser-smoke.js` +79 and a `/state` size check
  (`state-json-budget-smoke.js`) guard the added fields.

### `732900e` fix reply, ip stream

* **Every fetch the DATA and WSPR pages make now carries an abort deadline.** A hung request has no
  timeout of its own, and a browser allows about six connections per origin: a handful of fetches
  that never answered exhausted the pool, so the page flashed `OFFLINE`, `F5` hung, and cycling
  tabs appeared to help. The firmware was innocent. Deadlines are `AbortSignal.timeout` (8 s for
  the fast polls, 12 s for the slower ones) plus an in-flight guard of the same shape `pollRadio()`
  already used — without it every 5 s tick opened another connection. The calibration plan UI
  inherits the deadline, so `/txgain.json` cannot wedge the page either.
* **The REPLY button's layout fault fixed**: a `1fr` track with no `minmax(0, …)` let a long line
  blow the grid out sideways. Two classes now answer two different questions — whether the button
  was rendered at all, and whether it can currently be pressed.
* **The call alert transmits nothing.** It is a notification only; the station still never answers a
  CQ by itself, and `js8-autoreply.js` remains untouched. Escape and form submit close the dialog
  without touching the buttons behind it.

### `5d4e372` bugfix

#### STATUS answer: a menu, and one entry the station composes about itself

`STATUS answer` was a bare 40-character field, empty by default — so a fresh station answered
`STATUS?` with nothing at all, which is quieter than JS8Call itself (upstream ships the default
`IDLE <MYIDLE> VERSION <MYVERSION>`). The field is now a menu, which suits a page operated from a
tablet and doubles as the documentation of what is worth saying.

Upstream's answer to the same problem is a macro language expanded at send time
(`replaceMacros()` over `<MYCALL> <MYGRID4> <MYIDLE> <MYVERSION>` …). That was examined first and
rejected here: it has six consumers upstream and two here (`INFO` and `STATUS` — our CQ and
heartbeat texts are generated by the protocol, not typed), the character whitelist in
`js8-settings.js` strips `<` and `>` so a macro could not even be stored, the 40-character limit
would be enforced *before* expansion where the operator cannot see the cost, and the one macro that
would justify the machinery — `<MYIDLE>` — has no honest source in a browser that may be closed on
a tablet in another room, or open in front of nobody. One composed menu entry buys the dynamic part
without any of that.

* **The menu** (`data/data.html`, `data/js8-settings.js`): *No answer*, four presets
  (`AUTO STATION UNATTENDED`, `MONITORING`, `QRV FOR QSO`, `QRT SOON`), *Follow the station*, and
  *Custom…* which reveals the old free-text field. The stored value is still a plain string, so an
  existing profile lands on the right entry by itself and **no schema bump was needed**.
* **A fresh profile now answers**, with `AUTO STATION UNATTENDED`. An existing profile keeps what it
  has, including an empty answer: turning transmission on for a station that was silent is not a
  decision an upgrade gets to make.
* ***Follow the station* is composed when it is asked for** (`data/data.js`). Armed, it answers
  `AUTO STATION 6H LEFT` off the arming window; disarmed, `MONITORING`, because then the operator is
  the one answering. It is built where the reply context is assembled, not inside
  `js8-autoreply.js`, which is deliberately a pure decision layer with no clock — composing first
  also keeps the "needs" refusal honest, so an answer that comes out empty is refused instead of
  going out as a bare `STATUS`.
* **The line under the menu shows what will be sent and what it costs**, counted through the real
  encoder: about every fourteenth character buys another frame, and a frame is a whole slot.
  `STATUS MONITORING` is 2 frames, `STATUS MONITORING JN79 UNATTENDED 50W VERTICAL` is 4.
* **Four checks in `tools/data-browser-smoke.js`.** One of them caught a defect in the first
  version: picking a preset overwrote a hand-written answer with no way back. A session-only draft
  now restores it when *Custom…* is picked again.
* `SOFTWARE.md` 5.13 gains **What the station answers to STATUS?**. The settings screenshot still
  shows the old text field.

#### QRPLog reports: one per QSO, and only what really went out

Eight decisions from a grilling session on the two report fields added in `36c62f9`. The rules the
operator asked for read as if they were already implemented; finding out why they were not turned up
four defects, one of them silent and on the air.

* **Every S&P contact logged the report of the one before it** (`data/log.js`). In S&P the same Enter
  keys the exchange *and* writes the QSO, so the `/cmd` acknowledgement — which is what stamps "this
  is the report that went out" — lands after the form was cleared, and the IndexedDB write usually
  wins that race against the round trip to the ESP32. The late `ok:true` then belonged to a QSO
  already in the log and set the *next* one's sent report. Each QSO now carries a generation number;
  an acknowledgement that outlives its QSO is discarded. Invisible while the report never changes,
  which is why it survived a green harness.
* **In `CW-R` nothing was ever keyed, and the log said otherwise** (`wifilt.ino`). `sendCW()` keyed
  only when the mode text was exactly `CW` or `RTTY`; `CW-R`, `RTTY-R`, the data modes, `WFM` and
  `UNK` fell through and did nothing — while `/cmd` answered `{"ok":true}` regardless. So flipping to
  the reverse sideband to dodge a birdie transmitted silence, and the page recorded the report it
  believed it had sent. The reverse modes key identically (same CI-V message, same FSK bit stream)
  and are accepted now; a mode with no keying path returns **409 `mode_cannot_key`** instead of
  lying. The page refuses in those modes before it POSTs, naming the mode in the hint.
* **An abandoned QSO left its reports behind.** Emptying the Call field — backspacing away a caller
  who faded — now returns both fields to the default and forgets what was transmitted. The reset
  fires on the field going *empty*, not on the first character of the next call, so a report set
  before the callsign is typed still survives.
* **A report the operator never typed no longer reaches the log.** An unusable field (`4`, mid-edit)
  was silently replaced by the default, writing `599` into the journal where it looks correct
  forever. The received report is now logged as it stands; `N` is folded to `9` and only an empty
  field takes the default. The air is unchanged — a half-typed report still cannot be keyed.
* **Enter in a report field was a dead key** — no handler, and no `<form>` to submit to. It is now
  routed into the flow: as in Call with no callsign yet, otherwise as in EXCH, and it transmits
  exactly as it would there (the operator's call, over a variant that refused to key). `Tab` is the
  way out that keys nothing.
* **The mode vocabulary was wider than the code knew.** `applyModeState()` appends `-D` for the
  radio's data mode and also emits `WFM` and `UNK`, but `rstDefault()` listed six phone modes and let
  everything else fall through to `599` — so `WFM`, plain phone, prefilled a CW report. The default
  is decided on the base mode, `-D` means a data QSO (`599`), and `UNK` overwrites nothing.
* **`tools/log-rst-smoke.js` grew from 12 checks to 24.** The twelve that existed drove RUN mode
  only, which is exactly why the S&P defect got through. The new ones cover the two-QSO S&P sequence
  (with `/cmd` deliberately answering late, so the race is deterministic), the abandon reset, the
  verbatim received report, Enter routing, the `USB-D` and `WFM` defaults, and the refusal to key in
  a data mode. Nine of the twelve fail against the previous `data/log.js` — checked, not assumed;
  one of them passed at first for the wrong reason (a stale exchange made Enter a no-op) and was
  tightened until it bit.

#### Asset versions are derived from content, not typed by hand

* **`tools/stamp-asset-versions.js` (new, untracked) computes every `?v=` from the *content* of the
  asset it points at.** The firmware serves the two halves of a page under opposite cache policies:
  `.html` is `no-cache, no-store` and therefore always fresh off the device, while `.js` and `.css`
  are `public, max-age=3600`. For up to an hour after a flash the browser runs the **old script
  against the new page**, and the only thing preventing that was somebody remembering to bump a
  hand-written date in a `<script>` tag.
* **On 2026-08-11 that failed exactly as it had to.** An element id renamed in both `data.html` and
  `data.js`, with `data.js?v=20260808c` left untouched, gave one operator a dead DATA page
  (`dom.operatorState is null`) while the same firmware worked in a browser with a cold cache. The
  audit that followed found **21 of the 41 tags on `data.html` already pointing at a version older
  than their own source**, plus nine local assets carrying no `?v=` at all — which nothing short of
  the operator knowing about Ctrl+Shift+R could invalidate.
* A derived version cannot be forgotten, and it re-downloads only what actually changed: a flash
  that touched one 4 kB script must not cost the operator the 865 kB JSC dictionary again over a
  link that carries one HTTP request at a time. Wired into `tools/build-js8-assets.sh` and
  `tools/prepare-spiffs-tree.sh`; `tools/data-browser-smoke.js` +44 lines,
  `tools/log-rst-smoke.js` +123.
* `BUILD.md`, `SOFTWARE.md` and `HARDWARE.md` updated alongside it.

---

## REV 20260810 — 2026-08-10 … 2026-08-11

### `4476c14` docs: bring the manuals back in line with REV 20260810

* `HARDWARE.md` and `SOFTWARE.md` brought back in step with the firmware after the audit series —
  the manuals had drifted from what the code actually does. `data/log.html` and the SETUP log
  screenshot updated to match.

The six commits below come from `docs/oprava-kodu-po-auditu-manualu.md` — the list of places where
the code, not the documentation, was wrong. Verifying each item turned up three problems the audit
had not found. **Nothing in them has been checked on a radio yet.**

### `36c62f9` log: two RST fields, and the log records what was transmitted

* **The report fields were crossed.** The editable field (which the cursor skips — Enter runs
  Call → Exch) fed `RST_RCVD`, while `RST_SENT` was a constant. Overriding 599 to 579 logged
  `RST_SENT 599` / `RST_RCVD 579`, both wrong. There is a field for each now, unlabelled: the
  journal header directly below carries `Snt` and `Rcv` in the same order.
* **The sent field decides what is keyed.** Macros carried a hardcoded `5nn`/`599` in thirteen
  places, so an overridden report reached the log without ever reaching the air. A value that does
  not parse as a report is not keyed — in RUN mode the next Enter transmits immediately and the
  operator may be mid-edit.
* **The log stores what actually went out**, captured when the macro was acknowledged, so an edit
  made afterwards cannot rewrite history. The received report always comes from its field; with no
  macro sent at all (phone, S&P, *log without TX*) the sent field is what gets logged.
* **`tools/log-rst-smoke.js`** is new — `log.html` was the only page no harness drove. It asserts on
  the body of `/cmd` and on the stored QSO, not on what the page renders.

### `ed5c4d6` setup: drop three controls that nothing read, and the dead template layer

* **`RST default SSB/FM`, `RST default CW/RTTY`, `Manual mode for Phone`** were saved, survived
  updates, were served on `/log-config` — and had no consumer. Phone was manual unconditionally, so
  the checkbox had nothing to switch. Removed rather than wired: a report is either the convention
  (nothing to set) or the operator types it.
* **`setupTemplateProcessor()` + `sendTemplatedHtml()` (~120 lines) deleted.** The renderer was
  called from nowhere and not one `%KEY%` was left in `data/`; the setup page has been filled in the
  browser from `/config` for a long time. Its per-line `%` scanner would also have eaten
  `calc(100% + 5px)` and `(dots + 1) % 4` had anyone revived it.
* **A refused save now says why.** Removing that layer left five validation strings with no reader,
  which is how it came out that every refusal had been arriving as a bare 400 since the page moved
  into the browser. `/setup/save` returns the reason and the page reads it.

### `65ae237` cli: list `L`, stop the second question meaning the opposite of the first

* **`L`** — configure and test ICOM-LAN from the console, the only way to set the LAN link without
  the web page — was missing from the help.
* **The second confirmation for `E` and `@` was inverted**: `y` then `n` erased, `y` `y` aborted.
  The asymmetry protects against a held-down `y`, so it is kept and said out loud instead:
  *press E again to erase*.
* `D` and `E` answered only upper case while `A` and `L` took both. All take both now.
* The boot-time listing in AP mode was a second hand-kept copy that had already drifted (no `D`,
  no `L`); it calls `ListCommands()`.

### `9b9ddb3` led: indicate RTTY, and stop claiming a link that dropped

* **RTTY had no LED indication** — only an orphan restore at the end of the transmission, with
  nothing ever turning the LED off. It is dark for the whole transmission now. Per-bit mirroring of
  the FSK line was rejected: one bit is 22 ms, so the eye fuses it into a dimmed LED.
* **The status pin was written exactly twice in the whole sketch** — `LOW` at boot, `HIGH` on the
  first connect — so after a WiFi outage the LED kept reporting a link that was gone. One function
  owns the resting state and the WiFi watchdog drives it in both directions.

### `365cc9d` header: match the code, drop RTLE, rename what outlived its protocol

* **The `Features` block promised three things that do not exist**: an http server on port 81 for a
  PHP log, a UDP listener on port 89 for CW/RTTY, and a UDP CAT port for clearing RIT. The ports in
  use are 80, 82 (DX cluster) and 83 (audio); the only UDP socket is TrxNet. **README.md and the
  user manual copied all three straight out of here and carried them for years.**
* **The LED table was wrong in every line** — inverted polarity, an MQTT flash long after TrxNet
  replaced MQTT, and a double flash no code has ever produced.
* The per-release history appended to that block is gone; it duplicated this file.
* **RTLE removed** — 17 references to a feature whose `rtle.h` is not in the repository, so
  uncommenting the define breaks the build.
* `mqttFreqTimer` → `trxNetPublishTimer`, `UDP_TO_FSK` → `FSK_KEYING`.
* `docs/websocket-civ-proxy.md` keeps a status banner instead of being deleted: the first of its two
  recommendations *did* happen (assets in LittleFS), the second never did, and `Changelog.md`
  references it.

### `15686ba` ui: english strings, an honest element id, and a LAN pill that says something

* Three Czech strings in an English interface — the 2026-08-08 text audit walked past all three.
* `operatorState` → `stationIdentity`: it shows callsign and locator, not who holds the session.
* **`LAN 0·0·0`** was three numbers with no legend on the page, only a `title`, which a phone cannot
  show. It stays hidden while the link is clean and spells itself out when a counter moves:
  `LAN drop 2 · stall 1 · fill 3`. `AUD1` keeps its label and gains the title it never had.

### Deliberately left alone

* **The DXC regex default.** SETUP's blocked list is the log's setting, DXC has its own filter; not
  a conflict.
* `_updateExchPreview()` in the LOG modal keeps `5NN` — it previews the exchange *format*, not a QSO.
* `FREE (was MQTT_*)` comments in the EEPROM map, and `BT_NAME` for downgrade compatibility.

---

## REV 20260809 — 2026-08-09 … 2026-08-10

### `c94ebd6` add snr, show call in log, cq reply button, rx mycall beep, log radar, fix radio ui

* **`REPLY` on a CQ line** (`data/data.js`). One press answers the caller with `SNR ±nn` — the
  report *that line* was decoded at — after making them the recipient and opening TX SESSION. A CQ
  is taken from the decoder's frame kind, never from the letters "CQ" in the text. The button is
  drawn on every CQ and **carries the reason when it refuses**: older than five minutes (the same
  window as the `5m` filter), already answered since that call, a shut transmit gate, or no measured
  report. Being already in the log does not refuse it. **One press sends — no confirmation dialog,
  no second click** (a `confirm()` has already killed a session once in this project); it goes
  through the queue rather than straight to the encoder, so a press landing mid-frame waits for the
  next slot instead of colliding, which also leaves `ABORT` usable.
* **The station still never answers a CQ by itself.** `js8-autoreply.js` is untouched: it holds no
  handler for a bare `SNR`, so the only path from the traffic list to the transmitter is that click.
  This was a deliberate choice over an armed automatic follow-up.
* **A line addressed to your callsign is marked** — green border plus a `TO YOU` badge — and
  optionally beeps (**`Beep on a call to me`**, SETTINGS, **off by default**). The test is
  `directed.to == my callsign`, deliberately narrower than the existing "mentions my call": being
  listed in somebody's `HEARING` is not being called. The tone fires once per *message*, keyed on
  the channel id like `openSectionsForNewOwnCall`, so a six-frame message does not beep six times;
  the first render after a reload is silent by design. First `AudioContext` in the project — a
  browser will not sound it until the page has been clicked, and the tick itself is that click.
* **The signal report is now stated in the line**, next to speed and offset, and left blank rather
  than printed as `+0` when there is none.
* **Multi-step `HIDE`** in the filter row: `HIDE Hz` → `HIDE SPD` → `HIDE SNR` → `HIDE TIME` →
  `SHOW ALL`. The label names what the *next* press removes. Driven by one attribute on the
  container, so a press costs no re-render. The meta group is left in the grid even when fully
  collapsed — removing it would drop the text into the wrong track and re-flow the feed.
* **A callsign already in the JS8CALL log on this band reads dimmer**, from the same set the
  `LOG QSO` button uses. It never disables anything.
* **`LOG` on the stations map** — logarithmic distance, `log10(1+d)/log10(1+dmax)`: zero still maps
  to the centre, no constant to tune. Its rings become labelled decades, because at half the radius
  a log plot no longer means half the distance. Verified by measurement, not by trusting the
  formula: a 110 km station goes from a sub-pixel radius **merged into a cluster on top of the
  operator** to its own dot half way out, while the DX station stays on the rim.
* **SETUP: the radio panel had its right ~28 px cut off.** Root cause was not the panel but
  `label { grid-template-columns: 200px 1fr }` — a grid track's automatic minimum is its content's
  min-content, and an `<input>` refuses to shrink below its default size, so the row grew past its
  parent instead. Invisible until the panel moved inside a spine step, where `overflow:hidden`
  clipped it. Fixed with `minmax(0, 1fr)` (which also protects every other label on the page) plus a
  150 px label column inside the radio editor, so the fields keep the width they look like they
  have. Measured before and after in headless Chrome: `scrollWidth` 758 → 730 against a 730 px box.
* **Ten new checks in `tools/data-browser-smoke.js`** covering all of the above, and a
  `markLogged()` test hook. The known six reds are unchanged.

### `c6cb2cc` manual

* **The single `docs/user-manual.md` was replaced by three manuals** written for different
  readers: `SOFTWARE.md` (1 896 lines), `HARDWARE.md` (329) and `BUILD.md` (197), with the README
  cut down to what a visitor needs first. Screenshots of every page added under `img/`, and
  `tools/ui-inventory.js` (286 lines) enumerates the UI so the manuals can be checked against it
  rather than against memory.

### `cdb91d4` cleanup and addition of the repository

* **The repository was brought in line with what actually builds it.** The prebuilt
  `build/gh-pages/` binaries (firmware, filesystem, bootloader — over 3.5 MB of artefacts) were
  dropped from version control and `.gitignore` extended, while the test harnesses that had been
  living untracked were added: the WSPR suite alone (`wspr-browser-smoke.js` 2 182 lines,
  plus encoder, log, schedule, settings and TX-pacing smokes) and the prototype build scripts.
* Documentation followed the same rule: spent plans (`icom-lan-network-audit.md`,
  `modem-implementation.md`, `wifilt-rename-plan.md`) removed, living references
  (`docs/wspr.md`, `docs/find-device-ip.md`, `trx-http-api.md`,
  `aud1-audio-websocket-protocol.md`) written or brought up to date.

### `14139b9` hide bin

* **The BIN file-transfer mode is hidden from `TX SESSION → Mode`.** As with EMAIL before it, only
  the option is gone — `js8-file-transfer.js` still ships and stays covered by the smoke suite, so
  restoring the entry re-enables the mode.

### `54f4ed1` changelog

* Documentation only.

---

## REV 20260808 — 2026-08-09

### `d667a4a` startup

40 files, ~3 800 insertions. The first-run path, and the settings that path depends on.

* **SETUP became a five-step spine whose state is derived, never stored** (`data/setup-spine.js`,
  1 064 lines). No saved cursor: each step asks its own question of the facts — is this slot set up
  at all (deliberately stricter for LAN than for the others), has a radio ever answered, is there a
  callsign — so a device that was configured from another browser, or half-configured and left, is
  read correctly instead of resuming a fiction. A step's button is the one place where *saved* and
  *did not save* both appear, and the panels moved bodily into steps 1–2. **The transmit check
  cannot live on SETUP** (decision 8 of the plan): SETUP is where the station is described, not
  where it goes on the air. An unfinished spine is still a home page you can walk away from into
  DATA or LOGSYNC.
* **Callsign and locator now have exactly one source** (`data/station-identity.js` + a firmware
  `GET /identity`). They are a fact about the *station*, not about a browser, so they are editable
  only in SETUP → Identity and every other page displays them and re-reads after a minute — chosen
  against what the poll costs, not against how fast anyone types. A value that cannot be normalised
  is **refused, never sent as empty**: clearing on purpose is allowed, garbage is not. This is what
  uncovered that a half-typed locator on the JS8 page had been wiping the station's locator.
* **The JS8 profile moved from the browser to the device** (`data/station-profile.js`) as a blob
  endpoint, exactly like the calibration table — the browser owns the schema, the device just
  stores it. An empty answer rather than a 404: "this station has no profile yet" is a state, not a
  fault. It is deliberately its own endpoint instead of a corner of `/setup/save`.
* **Radio discovery split out** into `data/icom-discovery.js`: finding the radio on the network and
  proving the credentials work are two separate questions, and **an empty sweep is a diagnosis, not
  a failure**. A fresh device defaults to TRX1 on ICOM-LAN with no address and no model; the model
  a radio reports is kept in RAM as standing proof that a login once succeeded.
* **CW IP announcement is now off by default** — it keys the sidetone on every first connect, which
  is not what a new operator expects to hear.
* **Calibration: a ceiling is a finding, not a failure.** A search that stopped because it ran out
  of headroom used to be reported as a bare failure, which made the MOD-level correction behind it
  dead code. The flags are dropped when false rather than written as `"reachedCeiling":false` —
  measured at 195 B per record with them against 110 B without, which is 44 cells' worth of space.
* **WSPR now matches transmit errors by `txId`.** Every firmware frame carries the id it is about,
  and a `tx-error` was being applied to whatever was current — so a stale error aborted the *next*
  cell as a "client abort" — while `fail()` sent a wildcard `txId=0` abort that could stop a
  transmission it knew nothing about. WSPR also gained the red TX frame it had never had.
* **LOGSYNC says Done only when both halves are finished.** `pendingReqIds` counted requests *I*
  made, so it only ever measured what this side was still receiving: the remote finishing said
  nothing about this side, which is how one transfer could report Done mid-flight and another
  Failed after completing. Sending is now part of the completion rule, and the rule is stated where
  it can be checked rather than implied by the flow.
* **Information-text audit** across the app (`trx-help.js`, `lan-gate.js`, `js8-autoreply.js`,
  `js8-restrictions.js`, DATA and WSPR): advice is phrased as advice — without it JS8 and WSPR still
  transmit, just worse — and banners that can be dismissed are dismissed for that page view only,
  never stored.
* **Installer and partitions**: `partitions.csv` reworked (No OTA, coredump dropped, separate asset
  filesystem) and `tools/gh-pages.sh` (+316) now derives the filesystem geometry from the partition
  table and writes the installer page's hardware table from it — a hand-typed "2.56 MB" beside a
  table that can change is a number nobody re-checks. A section that was present but too big used to
  be skipped in silence.
* `tools/data-browser-smoke.js` +120.

### `438f0a6` changelog

* Documentation only.

---

## REV 20260807 — 2026-08-08

### `fcc7e41` redesign AutoTX gain

* **Calibration became a batch plan instead of one measurement at a time.** `tx-gain-plan.js` and
  `tx-gain-plan-ui.js` (1 800 lines together) drive a **band × power matrix**: every selected cell
  is visited band-major and ascending in power, each band twice — once by a coarse survey, once by
  a clean pass — and the run ends with one return to whatever the operator left unmeasured. A
  survey reading is deliberately not stored as a calibration: it was taken coarsely and says only
  where to look.
* **The radio's MOD level is set over CI-V** (`tx-gain-mod-level.js`), with the `1A 05`
  sub-addresses per model taken from wfview cross-checked against each radio's own CI-V manual —
  and where a radio does not offer the control at all (IC-705 reports `max = 0`) no command is
  emitted rather than a guessed one. A re-measured knee has to land within a stated tolerance
  before a MOD level is accepted.
* **Absence is treated as an answer.** The firmware capture (`wifilt.ino`, +109) arms on the next
  reply whose command *and* sub-address match, and no reply means the radio does not have that
  address; a value outside the documented range means the address is not what it was believed to
  be. A ceiling hit is not a measurement — a search that stopped at 0.8 because it ran out of room
  reports that, and asking for less than the floor is a finding rather than a value to write.
  Counting a stopped cell as done would have shown "13 of 10 measured".
* **Every retune spends the antenna answer** — that is the whole rule, since the antenna in use is
  what the measurement is about.
* `tools/icom-lan-login-test.py --ask` now asks the operator's CI-V questions from the PC as soon
  as data flows: everything this design rests on is an exchange that machine can make, and guessing
  from the browser costs a round trip through a transmitter.
* Plan in `docs/tx-audio-gain-plan-implementace.md`; `tools/data-browser-smoke.js` +82.

---

## REV 20260806 — 2026-08-07

### `5073568` fix @groups, show waterfall row, AutoTX gain

* **Compound and group-addressed frames are now decoded correctly.** A compound addressee arrives
  as a *pair* — `MYCALL GRID` then `@GROUP CMD` — and in a compound-directed frame the packed
  callsign is the **addressee, not the sender**, which is what had been misread. Bit 2 of the frame
  type is what tells the receiver which unpacker to use, and fast-data frames carry JSC over all
  72 bits with no prefix. A command addressed to a group this station belongs to is a command
  addressed to *us* — that is what joining means.
* **Group mail behaves like mail, not like a directed message.** It belongs to every member but
  only once each, never bounces back to the net, says which group it came from (or the member
  cannot tell it apart from private traffic), and it is the one record that survives its own
  delivery — so it is also the one with a clock on it, and it has to stop out loud when that clock
  runs out.
* **One calibration tool, hosted by two pages** (`tx-gain-cal-ui.js`). Like `lan-gate.js` and
  `wake-lock.js` it carries its own markup and CSS and reads nothing global — everything a page has
  to supply comes through the adapter — because the measurement is a property of the *radio*, not
  of the mode. Radio settings are snapshotted and restored the way `announceIpViaCw()` does in the
  firmware, and a failed restore is never allowed to turn a successful measurement into a failure.
* **A modem that cannot start now says so instead of hanging on "0%".** Reported from the
  station: opening the JS8 page stopped on *Loading JS8Call-ICOM modem 0%* and stayed there.
  0 % is the state before the worker's *first* report, so the page had heard nothing at all
  from it — and everything the startup gate shows is driven by worker messages. A worker whose
  script never arrives (a dropped connection on a web server that serves one request at a
  time, a stale or corrupt cache entry, a 404) raises `error` and posts nothing, and nobody was
  listening for `error`; a fetch the radio accepts and then never answers raises nothing
  whatsoever. Either way the operator was left on a full-screen progress bar with the RETRY
  button hidden, because the button appears only once a failure has been *declared* and no code
  path could declare one. Now: `js8-adapter.js` listens for `error` and `messageerror` and
  reports them as a modem error, buffering the message when it arrives before `onEvent()` has
  been chained on — which is the normal order, since the constructor creates the worker and the
  listener is attached afterwards. `data.js` adds a 20 s no-progress watchdog, re-armed by every
  progress report so a slow link only ever costs patience, and spends one automatic retry
  before the modem has ever been ready: the commonest cause is a single dropped asset fetch,
  which costs nothing to repeat, while a modem that broke *after* running is a fault the
  operator must see. The failure gate also comes back for a restored session, which used to
  suppress it in favour of the inline modem-state line — a line that lives in a section the
  page keeps hidden, so suppressing the gate meant a dead page with no explanation and no
  reachable RETRY. New `tools/js8-modem-failure-smoke.js` pins the adapter contract in both
  arrival orders (7 checks); `data-browser-smoke.js` +2, run last because they leave the modem
  dead on purpose. Cache-busting versions bumped for every script changed in this working tree
  (`data.js`, `js8-adapter.js`, `js8-protocol.js`, `js8-inbox.js`, `js8-settings.js`) — static
  assets are served `public, max-age=3600`, so an edit without a bump lets a browser run an
  hour on a mixture of old and new modules.

* **Work the waterfall and the band names itself.** The callsigns from Recent traffic stand up
  vertically on the waterfall at the frequency each station was last heard on. They appear the
  instant the pointer crosses the edge, stay while it is moving, and go three seconds after it
  stops — or immediately when it leaves. The timer **hides**; it took two wrong versions to get
  there, one waiting for three seconds of stillness and one for three seconds after arrival, and
  both failed for the same reason: choosing a frequency *is* continuous movement, so the labels
  have to be up **during** the movement rather than after it. Each callsign is 13 px bold on a
  solid black plate — not a tint, not a shadow. The waterfall's warm end is close to white and
  the dark end of the age ramp was unreadable on top of it, so the plate must owe nothing to
  whatever is behind it. A callsign too long for the canvas height drops to 10 px instead of
  being clipped, because a clipped callsign reads as a different callsign. No age cut-off,
  deliberately: a station that has not been heard for an hour
  still owns that frequency until somebody else takes it, and that is the thing worth knowing
  before choosing where to call. Age is carried by brightness instead — the most recent
  callsign is pure white, the oldest fades to dark grey, interpolated across whatever span is
  on screen, so a single station reads white because there is nothing for it to be older
  than. Drawn oldest first, so where two labels collide the fresher station wins. They go on
  the existing overlay canvas rather than into the DOM, and hang from the top edge so a name
  sits above the trace it belongs to; a new strip *above* the waterfall would have shoved the
  whole page down every time it appeared. Timed through the page scheduler, since `data.js`
  allows exactly one interval — and re-arming `after()` with the same id is what resets the
  dwell on every movement. `data-browser-smoke.js` +3 checks: the labels are painted on
  canvas, so they are asserted through a test hook reporting the armed delay, one entry per
  station at the right frequency, newest first, and never the operator's own callsign.

---

## REV 20260803 — 2026-08-03 … 2026-08-06

### `475c5d6` narrow the aprs.fi link, calm the histogram, add INFO to the presets

* **Three corrections after seeing the traffic feed in use.** The aprs.fi lookup now appears
  only on messages carrying `@APRSIS GRID`. aprs.fi knows a station only once it has reached
  APRS-IS, and that message is the one thing that proves it did — the sender is asking the
  gateway to put their position on the network. On any other row the link was a guess, and a
  link that lands on "no data" teaches the operator to stop trusting the underline. The
  histogram in the filter bar now behaves like the bars in the rows underneath it: a low 3 px
  ruler along the bottom edge at rest, growing to full height only while the pointer is over
  the waterfall — at rest the whole column now reads as one ruler instead of a permanently
  loud strip. And the message presets gained **INFO** without the question mark, which was
  missing: the menu could ask another station to describe itself but had no way to send this
  station's own description. It inserts exactly what the auto-reply sends for `INFO?`
  (`INFO ` + the SETTINGS text), so answering by hand and answering automatically cannot
  produce two different descriptions of the same station, and it is disabled with a reason
  until that text exists rather than sending a bare `INFO` that means nothing. 246 checks,
  same six reds as the baseline.

### `193a535` link the sender's callsign in the message text to aprs.fi

* **The sender's callsign inside a decoded message links to aprs.fi.** A row carries the
  callsign twice — once in its own column, which is the button that picks whom to answer, and
  again at the head of the decoded text (`DL8KM: @APRSIS GRID`), where it had never done
  anything. The lookup went on that second, inert copy, so the selector keeps its click and
  the underline promises a link only where there is one; opening aprs.fi never costs the
  operator their chosen station. Only the leading `CALL:` is linked, never a callsign quoted
  later in the body: aprs.fi would answer for those too, but they are stations being talked
  *about*, and a row full of underlines stops signalling anything. Colour is inherited — the
  row's palette already carries meaning and a link colour would add a fourth one — so the
  dotted underline is the whole signal, and it is the only underline in the feed. No link
  where the header frame was lost, because then the text does not begin with a sender at all,
  and none in the Stations table, where the message context that would explain the lookup is
  missing. The smoke asserts both halves: the link exists and the selector is still a plain
  element with no `href`, since breaking that would remove the page's primary interaction.

### `2a90510` preview a TX frequency against who is already on it

* **Point at the waterfall and the feed answers "is anybody already there?"** Moving the
  pointer over the waterfall now draws a thin white line where a click would put the
  transmission — and the same line runs down the whole Recent-traffic list, on the same axis,
  while every received row reveals a band showing what it occupies, shaded by SNR so a loud
  station reads as a bigger obstacle than a weak one. The line crossing a band is the
  collision, visible before keying anything. This is the question the waterfall alone cannot
  answer: it holds sixteen seconds, so it says whether a frequency is busy *now*, while the
  feed remembers who has been there for hours. The bands stay invisible until the pointer is
  actually over the waterfall, because a hundred permanently tinted rows would be wallpaper,
  and they are switched rather than faded — a transition puts the answer behind the pointer.
  Getting them behind the text without wrapping the text in a box of its own needed
  `z-index:-1` inside a row that establishes its own stacking context; that is the one layer
  painted above a row's background and below its inline content. The line is a pseudo-element
  on the list rather than a node per row, so it survives every re-render and costs nothing to
  move. Own transmissions get no band: they are not an obstacle to themselves.

* **The filter bar is now an occupancy histogram.** The same bars from every visible row,
  overlaid inside the 5 min / ALL / MYCALL / TX strip on the waterfall's axis. Nothing is
  bucketed or counted — translucent bars simply add up where stations share an offset, so a
  peak sits directly above the frequency that produced it and needs no legend. Built from the
  rows actually on screen, so changing the filter changes the histogram with it.

### `73a79e0` stop the chat progress bar leaking into the traffic feed

* **A completed TX row no longer prints red text on a green background.** Two rules met in
  the recent-traffic feed and neither knew about the other: `.tx-copy-sent` carries the chat
  thread's live progress bar (`background:#176b52`, green filling up behind the text while a
  message is genuinely on its way out of the radio), and the feed then recolours that text to
  red to say "this radiated". The green had arrived by inheritance only — the block comment
  right above the feed's own rules describes a different design entirely, red for what
  radiated and struck-through grey for what did not, with no mention of a background. The
  pairing was the loudest on the page and the one a red/green colour blind operator cannot
  read at all. The backgrounds are now switched off inside `.message-tx` only, so the chat
  thread keeps its progress bar, which is where watching a transmission leave actually
  happens; in the feed the transmission is already history. `txCopyPlainInFeed` asserts both
  halves — transparent in the feed, still filled in the thread — because deleting the bar
  outright would have been the easy wrong fix. 236 checks, the same six reds as the baseline.

### `f3983e6` quieten the signal stripe on own transmissions

* **The signal stripe under an own transmission is no longer red.** Seen on the finished
  page, the red shouted from down there. The row already says "this went on air" three
  times over — red callsign, red copy, end marker — and a fourth statement in the loudest
  colour on the page pulled the eye away from the *received* signals, which are the ones
  worth attributing to a trace in the waterfall; own transmissions are not even visible
  there, since the analyser is paused while transmitting. On air is now `#2e3d39` and not
  on air `#1c2724`, both barely above the panel, with emitted still the lighter of the two
  so "it went out" keeps the stronger mark. Received signals stay `#6b7d78` and are now
  clearly the most prominent thing in the column, which is the point. The smoke check was
  rewritten to assert the *ordering* (not on air < on air < received) instead of a literal
  colour, because these shades are a judgement tuned by eye and have now been tuned once
  already. Writing it turned up the harness's own trap a second time: the page is emitted
  from a template literal, so `\d` in a regex collapses to a bare `d` and `/\d+/g` silently
  matched nothing in `rgb(46, 61, 57)` — `[0-9]` is the form that survives. Decision 9 in
  `docs/js8-signal-stripe-plan.md` corrected to match. 235 checks, the same six reds as the
  baseline (`presetStable` among them, red before this change).

### `ce29e63` changelog

* Documentation only.

### `e63775c` MSG box

* **Deferred messages: write it now, the station sends it when the recipient turns up (stages
  E3 and E4 of `docs/msgbox-implementace.md`).** A second button beside SEND — `SEND LATER`, not
  a checkbox, because a switch that survives one message is how the next one gets parked by
  accident — holds the message in the MSG BOX instead of transmitting it. It leaves as `MSG`, so
  the recipient's station files and acknowledges it with nobody at the keyboard, and that ACK is
  the only proof of delivery this protocol can produce: it is what removes the record. What
  releases it is narrow on purpose — a heartbeat, a CQ, or a frame aimed at us, all of which mean
  "I am here and receiving"; a station heard mid-QSO with somebody else is not an invitation, and
  the trigger reads live decodes only, never the stations table (which would fire a salvo at
  everybody who was on the band an hour ago, on every reload). Sending needs arming like every
  other unattended transmission, one attempt per appearance, an hour between attempts, five and
  then it stops and says so; seven days is the outside limit, which is exactly the longest arming
  window the firmware offers. When the recipient never shows but somebody who *hears* them does —
  the same "who hears whom" evidence the map draws arrows from — the message is parked there with
  `MSG TO:`, and that intermediary's ACK ends the automation: it proves storage, never delivery,
  and further attempts would only manufacture duplicates in a network where nobody can say "I
  already have it". The same appearance also pushes mail we hold for the station that just showed
  up, instead of waiting for a `QUERY MSG` that upstream never sends. **Two traps found by the
  tests:** a callsign longer than six characters cannot be packed into a directed frame, so
  parking mail for one waited politely and then threw inside the encoder at the moment it was
  supposed to go out (`defer()` now refuses it up front); and the browser gate's signal-stripe
  check looked a stripe up by offset alone, so own transmissions at the default 1500 Hz — and
  heartbeat acks in the 500–1000 Hz band — were being measured against the fixture's width. It
  now selects received rows only. `tools/data-browser-smoke.js`: 235 checks, 23 of them MSG BOX.

* **The station now collects its own mail (stage E2 of `docs/msgbox-implementace.md`).** Three
  things that used to fall on the floor no longer do. First, an ordinary message somebody types
  at us is filed as unread mail instead of only scrolling past in the traffic feed — that feed is
  capped and CLEAR wipes it, which is exactly how a message goes unseen after three days away.
  Machine chatter (SNR, ACK, GRID, STATUS, QUERY…) is never filed, or the one line that matters
  would be buried under telemetry. Second, `MSG ID 32` inside somebody's heartbeat or `YES`
  answer is finally read: it becomes a pickup row with a FETCH button, and while unattended
  operation is armed the station sends `QUERY MSG 32` on its own. Upstream announces mail this
  way and then waits for a human to click, so mail left at a station for an unattended operator
  was never collected by anyone. Third, the delivery is unwrapped — `BRING THE ANTENNA FROM
  OK7ORIG NEXT MSG ID 33` stores the text with its origin and turns the tail into the next
  pickup, chaining at most three messages per appearance so a station holding eight cannot take
  the channel for eight exchanges. The discipline is a shared ledger (one attempt per
  opportunity, an hour between attempts on the same message, five and then it stops) that stages
  E3/E4 will reuse; fetches ride a new `msgbox` queue source at relay priority whose TTL is four
  slot periods, because a transmission made *because a station just showed up* is worthless
  twenty minutes later. Manual FETCH works with AUTO off — the operator clicking is the
  attendance — and the panel prints why a fetch is not happening rather than staying silent.
  **A trap found while testing:** a base callsign longer than six characters cannot be packed
  into a directed frame, so an advertisement from one would have thrown inside the decode path;
  pickups are only registered for addressable callsigns. `tools/data-browser-smoke.js` grows six
  checks and gains a `clearTxQueue` hook — the adverts queue real transmissions, which keyed the
  radio during the later manual-TX checks and timed them out.

* **Inbox becomes MSG BOX, and every record now says what it is (stage E1 of
  `docs/msgbox-implementace.md`).** Records carry a `type` — `STORE` for mail held for other
  stations, `UNREAD`/`READ` for mail addressed to this operator, `DELIVERED` for stock handed
  over — the same four the reference implementation keeps, plus `DEFERRED` reserved for the
  outgoing mail stages E3/E4 will add. That separation fixes a real defect rather than only
  tidying the model: `forCall()` used to search every record, so a station that sent us a bare
  `MSG` was offered **its own message back** on the next `QUERY MSGS`, and would have been given
  it on `QUERY MSG`. Upstream avoids this by answering out of `STORE` alone, and now so do we.
  Quotas split with the types (96 records, `STORE` ≤ 32, 8 undelivered per depositor, 16 unread
  per sender), and a repeated `MSG` inside 24 h is recognised as a lost ACK: de-duplicated, but
  acknowledged again. Storage moved to `/msgbox.jsonl` behind `GET`/`POST /msgbox`; the firmware
  serves the old `/inbox.jsonl` once when the new file is missing, the browser migrates it
  (a record filed against its own sender was mail for me, one filed against a third station was
  stock) and the first write-back makes the firmware delete the old file. Eviction is driven by
  **bytes**, not by the record count, because the firmware refuses an oversized body with 413 and
  the tab would otherwise keep running against a copy flash no longer has; the ladder drops
  `DELIVERED`, then `READ`, then `STORE`, then finished `DEFERRED`, oldest first, and never
  touches unread mail or a deferred message still trying — when only those are left the box
  reports FULL and refuses instead. The panel gained filters (ALL / FOR ME / WAITING / HELD), an
  age column, per-row REPLY and DEL with a 10 s UNDO that restores the *same id* (the id is what
  `NEXT MSG ID` quotes on the air), a red `N NEW` badge in the header and the same count in the
  tab title — a click on the row is what marks mail read, never the section merely being open.
  `prototype/js8-core-prototype/protocol/msgbox_smoke.js` is new (migration, ladder, byte budget,
  undo); `tools/data-browser-smoke.js` grows five checks (badge, click-marks-read, delete+undo,
  migration on the wire, durable load) and is otherwise unchanged against the baseline.

### `e00d700` implement @groups

* **`@GROUP` calls, to parity with JS8Call.** A group is a legitimate recipient but only one the
  station has **joined** — answering to a group nobody joined would put the station on the air for
  traffic that was never addressed to it. Joined groups appear in the recipient list, and a group
  that is dropped is removed from the field rather than left there pretending to still be joined.
  Gateway names (the set upstream's `Varicode::isGroupAllowed` refuses) are excluded: they are
  gateways, not nets.
* A joined group keeps a **thread of its own**, the mirror image of a station thread — but with no
  SNR line, since a group has no signal of its own to report, and with **LOG QSO disabled**: a
  group is a target, not a station on the other end, so there is nobody to have worked. File
  transfer is refused for the same reason — it needs a station that can acknowledge frames.
* **Replies to a group query are spread out.** A query addressed to a group is answered by every
  member in the same slot, so each reply picks its own offset away from the other members, derived
  from an FNV-1a hash of the station's own callsign — a pure function, so the same station always
  lands in the same place instead of piling onto one frequency.
* A refusal deliberately outlives the next render, because `renderControls()` runs on every state
  change and would otherwise wipe the explanation before it was read. Notes in
  `docs/js8-skupiny-implementace.md`; new checks in `tools/data-browser-smoke.js`.

### `adecd96` Automatic TX gain

* **The drive level is now found from the radio's own ALC, not guessed.** A calibration carrier
  (`data/tx-gain-cal.js`) walks the gain up until the ALC meter first moves — the knee — and files
  the result per band, matching `data.js` `bandOf()` so both pages file a transmission under the
  same band. At 1 % RF power the knee lands near 0.008, below the manual slider's old 0.1 floor,
  which is why the automatic path can reach settings the slider could not.
* **In service the guard only ever reduces** (`data/tx-alc-guard.js`). The response is asymmetric on
  purpose: upwards the ALC reacts at once, so 100 ms of evidence is enough to accuse; downwards the
  meter has to actually fall and its ballistics belong to the radio, so a clean reading needs 500 ms
  of corroboration — the meter falls back to zero by itself, and one zero does not prove a clean
  transmission. A clean transmission does not merely fail to accuse, it clears the accusation.
* Evidence is not carried across a page reload, and an unreadable table is never treated as licence
  to transmit at a guessed level. Because the whole feature reads `tx-level` (with an `alcSeq`
  counter) rather than `/state`, a radio that reports no ALC leaves the feature out of play
  entirely. Stored in a `/txgain.json` blob; SETUP gained the calibration UI. Notes in
  `docs/tx-auto-gain-implementace.md`.

### `2782d72` show each Recent-traffic row's place in the waterfall

* **Recent traffic now shows where in the waterfall each row's signal sat.** A dark grey bar
  under every row, on the *same axis* as the waterfall above it: 500 Hz at the left edge,
  2700 Hz at the right, as wide as that submode's modulation actually is (25–250 Hz). Read
  downwards it answers "whose is that signal", read upwards "where in the band is this
  station", and read across the list it shows at a glance who is parked next to whom. The
  alignment is not approximate — the bar is absolutely positioned, so its containing block is
  the row's *padding* box, which is exactly the width the canvas is stretched to; 1500 Hz
  therefore lands on the same screen column in both, and it stays that way if the row padding
  is ever changed. It costs no height either, living in the 7 px bottom padding that was
  always empty, sitting on the row separator which serves as its axis. The bar starts at the
  reported offset and grows right because the offset *is* the lowest tone, the same
  convention the modulator uses and the decoder reports back. Own transmissions get one too,
  drawn from the tone the encoder was actually configured with rather than from the current
  setting — a heartbeat picks its own tone inside 500–1000 Hz, and so do the email gateway
  and a file transfer, so reading `txOffsetHz` at render time would have drawn all of them
  wherever the operator last typed. Colour stays inside the feed's existing vocabulary: grey
  for a received signal, red for an own transmission that went on air, faint grey for one
  that did not. A row whose offset was never recorded draws nothing rather than invent a
  position. The hover tooltip (range, width, age, SNR) is written on hover instead of baked
  into the feed, because `renderActivity()` only runs when the decoder reports activity and a
  pre-rendered "4 min" would sit frozen on a dead band. Design and the rejected alternatives
  are in `docs/js8-signal-stripe-plan.md`. `tools/data-browser-smoke.js` grows five checks;
  the three that matter measure the bar's box and the canvas's box *on screen* and require
  them to agree within 1 px, at full width and at the 320 px minimum — a percentage computed
  against the wrong reference would look correct in the DOM and point tens of pixels away
  from the signal. 198 checks, and the only red ones are the five that were already red.

### `2555e1e` carry per-message SNR and publish the occupied width per submode

* **A received message now remembers its own SNR, and the protocol knows how wide a signal
  is.** Two additions to `js8-protocol.js` that the Recent-traffic signal stripe needs
  (`docs/js8-signal-stripe-plan.md`), landed on their own because they change the store rather
  than the page. SNR was carried by the *frame* and thrown away at reassembly: the finished
  message never had one, and the only surviving copy was the *station's* latest value in
  `calls`. Reading that at render time would stamp a two-hour-old row with the number from the
  last heartbeat, so the channel now keeps `snr` and the spread in `finalizeChannel()` carries
  it into the message, the snapshot and the live partials — no schema bump, since restore
  copies items wholesale. It is the **last** frame's SNR on purpose, not a mean: every other
  number on that row (timestamp, age) is the last slot too, and a mean would be the single
  field pointing somewhere else. `MODE_BANDWIDTH_HZ`/`bandwidthHz()` publish the occupied
  audio width per submode — 50/80/160/25/250 Hz — which until now existed only as a literal
  buried inside `drawTxMarker()`, where nothing could reuse it and nothing checked it.
  `reassembly_smoke.js` gains two checks: a rising-SNR reception must report the last frame's
  value (a channel that captured SNR at construction would report the conditions it opened
  in), and each published width must equal 8 × 12000/`samplesPerSymbol12k` from `kSubmodes` in
  `js8_core.cpp` — checked against the C++ arithmetic rather than against a second copy of the
  same table. Mirrored to `protocol/protocol_runtime.js`; `check-runtime-sync.sh` green.
  `tools/data-browser-smoke.js`: 193 checks, unchanged against the baseline.

### `9792672` take the page's own script tag as the version truth for worker assets

* **The page and its worker can no longer run two different versions of the same file.** Two of
  the files the DATA worker `importScripts()` are also loaded by the page with its own `<script>`
  tag, and each carried an independent version tag: the one written in `data.html` and the shared
  `ASSET_REV` in `data.js`. Nothing forced them to agree, and for `js8-protocol.js` they had
  already drifted apart — the page asked for `?v=20260801a`, the worker for `?v=20260719d`. With
  `Cache-Control: public, max-age=3600` on static assets that is not cosmetic: after a firmware
  update the page could spend an hour running a newer protocol module than its own worker, which
  is where `ActivityStore` actually lives, so a store-level change would appear to have no effect
  at all. `assetUrl()` now takes the page's own `<script>` tag as the single truth wherever the
  document loads the file, and falls back to `ASSET_REV` for the worker-only assets (the wasm
  blobs, the worker runtime, the JSC dictionary) which have one URL and cannot drift. Bumping
  `ASSET_REV` would have fixed the symptom at the price of re-downloading the decoder (895 kB) and
  the JSC dictionary (1.9 MB) onto every client, and would have left the mechanism able to drift
  again on the next edit. Found while planning the Recent-traffic signal stripe
  (`docs/js8-signal-stripe-plan.md`), which needs a new field to reach the store in the worker.
  `tools/data-browser-smoke.js`: 193 checks, unchanged against the baseline.

### `5433628` complete RENAME project and UI · `87363e6` · `083ad80` · `be22d0b` · `fe10107` · `caf7526` · `977ace5` · `baed480`

* **The sketch itself is now `wifilt.ino`**, the REV moved to 20260803 and the filesystem upload
  offset was corrected along with it.
* **TRX1 no longer defaults to the label `IC-705`** — it takes the model the radio reports for
  itself, so a station running a 7610 or a 9700 is not labelled after a radio it does not own.
* The SETUP network guide was generalised from one radio to **all five supported models**.
* **Gzip assets are byte-reproducible**, so a rebuild that changed nothing produces identical files
  and the release artifacts can be diffed; the pre-build consistency check now compares **content
  rather than timestamps**, which is what makes that reproducibility usable as a gate.
* Rename plan status recorded in `docs/wifilt-rename-plan.md`.

---

## REV 20260802 — 2026-08-02

### `cd33bed` generate the setup help per radio model · `0b89331` · `bf5f803`

* **The setup help now explains *your* radio, and it can be switched by hand.** This is the part
  of the rename that the operator actually sees: until now the help dialog was one hand-written
  IC-705 procedure, so an IC-7610 owner was told to open `MENU → SET → WLAN Set` — a menu that
  radio does not have — and to build a `PRESET`, a function it does not have either. The dialog
  is now generated per model from a single table, opens on whichever radio reported itself, and
  carries buttons for the other four plus **Other Icom**.
  Writing it turned up three differences that are not wording. **WLAN** (IC-705, wireless) versus
  **LAN** (everything else, Ethernet) appears in three separate menu items. Network settings live
  in **three** different places, not two: IC-705 under `WLAN Set → Remote Settings`, IC-7300MK2 and
  IC-7760 under `Network → Remote Settings`, and the IC-7610 and IC-9700 have **no Remote Settings
  submenu at all** — the items sit directly under `Network`. And `PRESET` exists on the IC-705,
  IC-7300MK2 and IC-7760 but not on the IC-7610 or IC-9700, so their guide says "note these down
  or use a memory channel" instead of silently dropping three steps and leaving the operator
  hunting for the one-touch restore that never existed. Every path was read out of that radio's
  own manual in `docs/`, and the CI-V addresses with them — the IC-7300MK2 is **B6h**, not the
  original IC-7300's 94h.
  An unrecognised radio gets the common-denominator procedure, is **named** in the dialog, and is
  told that no specific guide exists yet. It never falls back to the IC-705 steps. The generic
  guide also covers the one case where the model number is right and no menu path can be: a serial
  radio bridged onto the network by a wfview or RS-BA1 server, where the network settings live on
  the PC and the radio only reports its name.
  **Same table, one source of truth.** `RADIO_FULL_POWER_W` used to be a second, half-overlapping
  list of radios — which is how an IC-7760 ended up unable to transmit WSPR while the help text
  was confidently explaining an IC-705. Watts and setup instructions are now the same row, so a
  model cannot exist in one and be missing from the other.
  The ICOM-LAN gate card stopped saying "IC-705 is tested. Other Icom transceivers…" while no
  radio is connected. It now names the model the slot last identified itself as, or names nothing.
  The `?` button lost its `IC-705 setup help` label for the same reason.

### `cfa0001` point every URL at ok1hra/wifilt

* **The repository and the firmware installer moved to `ok1hra/wifilt`.** 33 links followed it:
  the installer page, the 13 asset links in the README, the `GitHub | Licenses` footer on all six
  pages that have one, and — the one that actually has to resolve — the *corresponding source*
  URL in `THIRD-PARTY-NOTICES.txt`, which is a GPL obligation, not a convenience. `fw-version.js`
  now checks `https://ok1hra.github.io/wifilt/manifest.json`; both that and the repository were
  confirmed serving before this was committed. Renaming a repository moves its GitHub Pages site
  without leaving a redirect behind, which is only harmless because no device is deployed against
  the old address.
  The `hw/` and `3Dprint/` **file names deliberately did not change**, so only the repository
  segment of those links moved — the enclosure still carries `IC-705` moulded into it, and
  regenerating printable STL/3MF is not part of a rename.
  Fixed along the way, because the README is the front door and it was giving instructions that
  cannot be carried out: the quick start still said to join `IC705-if`, to open `ic705.local`, and
  to pair the radio over **Bluetooth** — a transport that no longer exists. It now walks through
  Network Control and `SETUP / Radio`. POWER-OUT is described the way the firmware's own header
  has described it for a while: it follows a full-CAT primary radio, not a BT connection.

### `da98930` rename LAN transport profile IC-705-LAN → ICOM-LAN

* **The LAN transport profile is called `ICOM-LAN`, not `IC-705-LAN`.** The name never reached
  the screen — the SETUP dropdown has said `ICOM-LAN` for a long time — but internally the value
  named one model out of five, and a comment in `wspr-core.js` had to warn future readers not to
  trust it, because 100 % of the CI-V power scale is 10 W on an IC-705 and 100 W on an IC-7610.
  A name that needs a warning label is the wrong name.
  **No migration code was needed, which is worth recording:** every read path already normalises
  to the LAN value through an `else` branch — the stored string is only ever matched positively
  against `IC-7610-CI-V` and `TRXNET`, so an old `IC-705-LAN` in EEPROM or in a config backup
  falls through to the new constant on its own. Kept as its own commit so it can be reverted
  without touching the branding.
  Still wrong for the same reason, and left alone: `IC-7610-CI-V` names a generic CI-V transport
  after one radio. That one *is* matched positively, so renaming it needs real migration.

### `79d2cf5` brand as WIFILT, add trademark notice, fix IC-7760 WSPR refusal

* **The project has a name now: WIFILT — Web interface for Icom LAN Transceivers.** It had six
  before, none of them canonical: *IC-705 IP interface* on the SETUP page and the serial banner,
  *IC-705 IP Interface* in the manual, *IC-705 Interface* on the flasher and in the licence
  notices, *IC-705_Interface* in the repository, *ESP32 QRPlog for IC-705* in the README. Page
  titles were just as uneven — four carried a project name and three (`WSPR beacon`,
  `JS8Call-ICOM`, `DXC`) carried none at all.
  Every page is now **`<Page> — WIFILT`**, with the distinguishing word first on purpose: DXC and
  QRPLog open as separate windows, so three or four tabs of the same device is normal, and a
  browser truncates the title from the *end*. `WIFILT · Setup` would have produced four
  indistinguishable tabs. The full name with its tagline appears only where someone meets the
  project for the first time — SETUP heading, README, manual title, flasher heading, serial
  banner. The banner had to become two lines: one row would have run to 101 characters and
  wrapped through the middle of the name on an 80-column console.
  **Trademark notice** — *Icom is a registered trademark of Icom Incorporated. WIFILT is an
  independent software project and is not affiliated with, endorsed by, or sponsored by Icom
  Incorporated.* — is in the README, the manual, `THIRD-PARTY-NOTICES.txt` served by the device,
  and the flasher page. SETUP gained the `GitHub | Licenses` footer it never had, because it is
  the one page that shows the tagline and in AP mode the first page a new operator sees; a page
  that uses another company's trademark descriptively has to be able to say so.
  **Also fixed, because the rename exposed it: an IC-7760 could not transmit WSPR at all.** The
  full-power table had no entry for it, `fullPowerWatts()` returned null, and the page refused to
  start rather than guess — correctly, but for a radio that is simply 200 W. Added. IC-7300MK2
  needs no entry of its own; the prefix match already resolves it to 100 W. Three more UI strings
  stopped naming a radio that may not be connected: *IC-705 LAN is offline* and *Waiting for
  IC-705 LAN audio* now say **ICOM-LAN**, and the power test hook no longer defaults to `IC-705`.
  Left alone deliberately: the `IC-705` keys in the power table (they are matched against what the
  radio reports about *itself*), the default TRX1 label, every setup instruction that is genuinely
  about the radio, and the TrxNet device prefix `705.XX` — that one is on the wire and shared with
  the k3ng OI3 keyer, so renaming it would break interop with keyers already in the field.

### `34790c8` rename network identity to wifilt

* **⚠️ The device answers to a new name: `wifilt`, not `ic705`.** First step of the rename to
  **WIFILT — Web interface for Icom LAN Transceivers**; the project stopped being IC-705-only when
  radio-type autodetection landed, and a hostname that names one model out of five was actively
  lying to anyone running an IC-7610. `deviceHostname` is one constant behind three lookup paths —
  DHCP hostname (`http://wifilt/`), mDNS (`http://wifilt.local`) and the AP portal — so all three
  moved together, and the two serial hints that used to spell the name out now interpolate the
  constant instead of keeping a second copy that could drift. The fallback access point is
  **`WIFILT-AP`** (was `IC705-if`), config backups download as `wifilt-config.json`, and exported
  ADIF carries `PROGRAMID` `WIFILT-Log`.
  **Export your log before you update.** `http://ic705.local` and `http://wifilt.local` are
  different *origins* to a browser, and the QSO database lives in browser storage
  (`contestLogDb`, IndexedDB) — so after this update the log, the JS8 settings, the email
  gateways and the stored file transfers all look empty. Nothing is deleted; it is filed under
  the old name. Open **LOGSYNC** on `http://ic705.local` first and export, then import once on the
  new address. Anyone who bookmarked the device by IP address is unaffected: that was already a
  separate origin.
  Because the state is lost either way, the browser storage keys were renamed in the same pass
  (`ic705.*` → `wifilt.*`, `ic705-dxc-*` → `wifilt-dxc-*`), which is free now and would never be
  free again. Untouched on purpose: the `IC-705` power table and every other statement that is
  about *the radio* rather than about this software, and the dead Bluetooth-era identifiers.

### `1588f01` autodetect Icom type

* **The radio says which model it is, and the setting follows.** The model arrives in the LAN
  capabilities packet, so it is picked up from an ordinary session and not only when SETUP is open,
  and it is remembered per slot so a detected model is stored against the right radio. The field is
  pre-filled from what that radio reported last time rather than left blank — which matters because
  WSPR refuses to transmit on an unknown model, having no power scale to convert against.

### `1fbb9da` show uncomplete js8 msg, logo, find trx and esp32 in net · `19901bb` · `0aa2750`

* **Neither IP address has to be typed from memory any more — the radio's is scanned for, and the
  interface's is handed over.** Two addresses stood between a box on the bench and a working
  system, and both were the operator's problem.
  **Finding the radio:** the Icom LAN protocol has no discovery, and neither does wfview — its
  `discoveredRigID()` identifies the rig model over a link that is already open, and there is no
  broadcast probe anywhere in the protocol. So `icom_lan_discovery.h` uses the only unauthenticated
  primitive the handshake offers: `AreYouThere (0x03)` to UDP 50001 on every host of the local /24,
  collecting `IAmHere (0x04)`. **It stops there and never logs in**, so it cannot consume the
  IC-705's single session — a scan will not lock out a wfview that is connected at the time. It
  does have to borrow UDP 50001 from the live client, and the reason it *stops* that client rather
  than opening a second socket is that `WiFiUDP` sets `SO_REUSEADDR`: the duplicate bind would
  succeed and then silently eat the client's control packets instead of failing. 254 datagrams are
  paced 8 per loop pass so the audio-carrying loop is not disturbed, and the scan is refused while
  transmitting. **Test &amp; identify radio** does a real login and separates "radio refused the
  credentials" from "nothing answered" — it declares success at `LAN_STREAM`, before the CI-V
  channel opens, so a radio being probed never writes its frequency into the shared rig state.
  The result list is labelled *answered on UDP 50001*, not *IC-705*: a wfview or RS-BA1 server
  answers the same probe and telling them apart would require the login the scan refuses to do.
  Wire primitives moved to `icom_lan_wire.h` so scanner and client share one definition of the
  packet layout.
  **The test also identifies the radio**, which turned out to be nearly free: `maybeRequestStream()`
  gates on `haveCaps`, so reaching `LAN_STREAM` guarantees the capabilities packet — and its model
  name — has already arrived. The model is stored per slot in `/radio-config.json` (new `model`
  field, an observation rather than a setting, so it is not operator-editable), and
  `radioModelLearnTick()` refreshes it from ordinary sessions too, so swapping the radio behind an
  address corrects it without anyone pressing the button. The payoff is in `radioNameForJson()`:
  `/state.radioName` now falls back to the stored model when no session is up. WSPR refuses to
  transmit for a radio it cannot identify — correctly, since 100 % of the CI-V scale is 10 W on an
  IC-705 and 100 W on an IC-7610 — and that answer used to vanish with the link, leaving both WSPR
  and the DATA power bar on "model unknown" and dependent on WSPR's manual `modelOverride`. One
  firmware change lit up both pages: neither needed editing, they already consumed
  `state.radio.radioName`. The button was relabelled from *Test connection* accordingly, and the
  detected model is shown beside it.
  **Finding the interface:** the AP-mode "tap to open" prompt provably cannot be reproduced in
  station mode — that sheet is the client OS reacting to its connectivity probe, and it only works
  in AP mode because the device *is* the DHCP server and answers DNS for every name; on the home
  network the router owns both, and faking it would mean answering queries addressed to the router.
  What replaces it is a name and a handover. `WiFi.setHostname("ic705")` was missing entirely, so
  the router listed a generic `espressif` entry and could not publish a name; with it, `http://ic705/`
  resolves through ordinary unicast DNS on most consumer routers — the one path that also works from
  **Android**. Three separate faults explain why `ic705.local` "worked sometimes": modem power save
  was left at its default so the AP only delivered the multicast queries at DTIM beacons and dropped
  them (`WiFi.setSleep(false)`, at the cost of steady-state current), `_http._tcp` was registered in
  AP mode only so nothing could browse for the device on the real LAN, and the responder was never
  re-registered after a reconnect — `NetworkIdentityLoop()` now does it on the same edge TrxNet
  already used, kept out of `TrxNetLoop()` because that returns early when TrxNet is disabled. A
  failed `MDNS.begin()` also no longer parks the device in `while(1)` forever.
  **The handover:** saving WiFi in AP mode used to end in a blind restart that took the portal away
  and left no address behind. `/setup/wifi-try` now raises the station beside the still-running
  softAP and the portal shows the address the router handed out, as a link and as a QR code
  (`data/qrcode.min.js` restored from the old filesystem layout, loaded on demand so it costs
  nothing on normal page loads), before the operator presses restart. The address is kept in EEPROM
  132-135 — written only when it changes, because that region is a flash sector — so any later AP
  visit, including the unintended kind when the configured WiFi is out of range at boot, shows
  *"Last address on your network"*. The softAP follows the station onto its channel during the
  handover, so clients briefly drop and re-associate; the page treats a failed poll as "still
  connecting". **Both WiFi profiles are tried, and the target is chosen by scan.** The first cut of
  the handover tried only `WifiProfileConfigured(0) ? 0 : 1`, so an unreachable SSID 1 reported
  failure while SSID 2 was working — caught on the bench. `/setup/wifi-try` now matches a scan
  against both configured profiles through the new `collectVisibleWifiProfiles()` and walks them
  strongest-RSSI first with a targeted channel+BSSID `begin()` — no reason to re-sweep every
  channel for an AP we just heard. The **second** attempt at that was also wrong: an async scan
  started from the request handler right after `WiFi.mode(WIFI_AP_STA)` returns
  `WIFI_SCAN_FAILED` immediately, because the station interface has not come up yet, and the
  handover reported `not_found` without ever trying to connect (`WiFi.status()` was logging 255,
  WL_NO_SHIELD, which was the tell). The scan now runs from the main loop after a 400 ms settle
  and uses the same blocking call the boot path has always used successfully; it stalls the loop
  for a second or two, which during setup costs nothing because there is no radio link and no
  audio. An empty scan is no longer treated as proof of absence either — it may have failed, and
  hidden SSIDs never appear in one — so every configured profile is attempted anyway, blind,
  passing no BSSID rather than the all-zero one a blind candidate carries. Failure is reported
  only after all attempts, as `not_found` (a scan ran, saw nothing of ours, attempts failed too)
  or `no_connect` (the network was there but refused us). The same helper replaced the boot path's
  any-visible check in `ConnectWiFiAlternating()`, which started at profile 0 regardless of what
  the scan had just seen and burned a 20 s timeout before alternating. Six checks added to `tools/data-browser-smoke.js` (scan lists a hit, the row
  click fills the field, the credential verdict renders, the last-known hint appears in AP mode and
  stays hidden otherwise, and the handover screen reaches an address), harness timeout raised
  45→55 s to fit them. Firmware 989 833 → 994 553 B, filesystem image 1 535 693 B. Documented in
  `docs/find-device-ip.md`. **Not yet verified on a radio or a real network** — in particular
  whether the radio answers a probe from an ephemeral port, which would let the scan run without
  dropping the link at all.
* **Brand mark at the head of every menu, and an About window behind it.** The RemoteQTH icon sits
  as the first item of `nav.tabs` on all six pages that carry the bar (DATA, WSPR, QRPLog, SETUP,
  BD, LOGSYNC), 26 px tall with `padding:0` so it stays inside the row height the text tabs already
  set — the bar does not grow, not even at the 33 px mobile tab size. It is **inline SVG**, not a
  file: a separate `/logo.svg` would have cost a firmware MIME entry, an `isStatic` flag, two build
  scripts and one more HTTP request per page, and an external SVG in `<img>` cannot inherit
  `currentColor`. Carrying `class="tab"` and `fill="currentColor"`, the mark takes each page's own
  muted colour instead of a hard-coded grey, so it cannot disappear if a page's palette changes.
  The path was reduced from 3307 to 1648 characters by converting to absolute coordinates, rounding
  to two decimals — which bounds the error instead of accumulating it along the path — and baking
  the Inkscape layer transform into the coordinates; the result differs from the original by 0.67 %
  RMSE, invisible at 15× the size it is drawn. Clicking it drops an **About panel** under the mark
  — a panel anchored to its own trigger that an outside click puts away, the same behaviour and the
  same styling as the WSPR timetable, rather than a browser pop-up or a second tab. The disclosure
  is a native `<details>`, so opening and closing costs no script at all and the mark stays operable
  with keyboard and assistive technology for free; the one line of script per page exists only to
  close the panel on an outside click. The panel reads **WIFILT** over *Web interface for Icom LAN
  transceivers*, that block linking to the GitHub repository, and under it *by RemoteQTH.com*
  linking to the site — both in a new tab. Total cost **+8682 B** of the LittleFS image (806 kB
  still free). Checks added to `tools/data-browser-smoke.js` (DATA and SETUP) and
  `tools/wspr-browser-smoke.js`: the 26 px height, that the mark is no taller than a text tab, that
  `currentColor` resolves to the same colour the tabs use, and that the panel starts closed, opens
  under the mark and closes again on a click outside it. Two traps found while writing those: a
  closed `<details>` still gives its content a box, so a rect cannot tell open from closed —
  `checkVisibility()` can, but it reads cached style and needs a rect read in front of it to flush
  layout; and asserting the outside click with `body.click()` reached the page's own document
  handlers and knocked the TX sequence off course, so the click goes to the nav instead.
---

## REV 20260731 — 2026-08-01

### `023f241` @APRSIS, PWR preset, Resend

* **RESEND on failed transmissions, plus one armed automatic retry.** A row in the feed that did
  not make it to the air carries a `RESEND` button, and `RESEND` transmits — it does not merely put
  the text back in the field. Row ids are carried through the state snapshot so a rebuild of the
  feed cannot detach the button from what it resends. An **operator abort earns no RESEND**: it is
  the one failure the operator caused on purpose. Beyond the manual button, a failed slot arms
  exactly one automatic retry; a retry that runs out of time says so in the row rather than
  disappearing quietly. Found while building it: `CQ` reset the full interval on every call,
  `drainTxQueue` skipped its own `txBlockReasons`, and the outgoing log leaked across band changes.
  Plan in `docs/js8-tx-resend-plan.md`.
* **The display keeper became a dot in the shared topbar**, next to the firmware version, with the
  whole explanation in its tip — it is the only place those words live, so the tip doubles as the
  title and as the accessible name. The pop-up no longer mentions HTTPS: nobody reading it can put
  TLS in front of the firmware, so the advice was noise. A tap-opened tip can be dismissed by
  tapping away from it.
* **JS8CALL-ICOM sets the TRX power too, and heartbeats moved to 60 minutes.** The same machinery
  as WSPR, with two deliberate differences. The unit is **percent**, not the WSPR dBm grid: JS8
  announces no power in the protocol, so nothing pins it to that grid, and on a 100 W radio the
  grid would offer 10, 20, 50 and 100 W with nothing between 20 and 50. Percent is the radio's own
  display unit and its real resolution, so every value that can be typed is one the radio can be
  set to — and unlike the WSPR menu it needs no model table, so it still works on a radio the table
  does not recognise. Watts are shown beside the field when the model is known. The value is JS8's
  own (`Js8Settings.modems.js8call.rfPercent`), not shared with WSPR: that page caps at 10 W
  because it is a beacon, while 50 W on JS8 is ordinary, and one shared number would either export
  the cap or leave the beacon refusing to start.

  It is written on page open and after the radio's link returns, with the same three guards (knob
  wins, never mid-transmission, a failed `/state` fetch is not a reconnect). Two things differ,
  both because **this write can raise power** where WSPR's automatic value is always the minimum:
  only a level the operator set themselves is ever applied — a QSO mode has no safe value to invent
  — and the automatic write requires **Enable radio TX**, the one place they said the antenna is
  fine. Pressing SET needs no pledge, same as WSPR. The header power bar carries the "radio is not
  where the setting says" state, because the SETTINGS panel opens collapsed.

  Heartbeat interval default moved from 15 to 60 minutes in all four places that held it, plus a
  schema **v8→v9 migration that rewrites stored profiles**: a saved 15 cannot be told apart from
  v8's own default, so a default-only change would never reach anyone who had already opened the
  page. One selection in the menu undoes it.

  Found by the tests: the power field was rewritten from the target on every render whenever it was
  not focused, so a number typed and then left on the way to the SET button beside it was thrown
  away. Now held in an edit draft, the same shape `txGain` two settings below already uses.
  `powerCommand()` gave up `percentToLevel()` and `civLevelCommand()` so both pages share one CI-V
  encoder. Details in `docs/wspr-majak-implementace.md` ch. 24; eleven new checks in the DATA
  browser smoke (fixture gained `/commands`, `/setRfPower`, `/setConnected` and a real 14 0A
  decode) and seven in the JS8 settings smoke.

* **WSPR power menu follows the radio, and the page now applies it.** The dropdown offered every
  legal WSPR level under 10 W regardless of the transmitter, so an IC-705 was offered 17 dBm
  (50 mW = **0,5 %** of its scale) — a level the radio cannot be set to, because its smallest step
  is one percent. The list now starts at that step: seven entries on a 10 W radio, four on a 100 W
  one (1 W…10 W), three on a 200 W one. Each line names its percent (`30 dBm · 1 W · 1 %`), which
  is both the unit the radio's own display uses and the explanation for the shorter list. The floor
  is decided on the CI-V level rather than on watts: 33 dBm is 1,995 W, five thousandths *below*
  one percent of a 200 W radio, so an honest watts comparison would discard exactly the level that
  radio's smallest step produces. An unknown model empties and locks the menu instead of offering
  levels it cannot convert.

  The page also stopped waiting for SET: it writes the target on load and after the radio's link
  returns, so an unattended beacon keys at the level left in the menu rather than at whatever the
  radio remembered after a power cycle. This deliberately reverses an invariant the file defended
  in three places, so three rules bound it — the knob wins (the page remembers the percent it wrote
  and confirmed, and a different reading while the link is up stands the automation down until the
  next SET), a transmission is never interrupted (LAN drops here happen under audio load, i.e.
  mid-carrier, so the write waits for the PTT), and a failed `/state` fetch is not a reconnect
  (that is a WiFi flutter the radio knew nothing about). A stored choice the connected radio cannot
  produce is not honoured and not erased either, so swapping radios back restores it.

  Found on the way: the `±2` tolerance both agreement checks used is 0,78 % of a scale whose step
  is one percent, so it called 1 % and 2 % the same reading — 3 dB, and *the* most likely operating
  point after this change. Both now compare whole percent exactly, as does the knob detector, which
  would otherwise have fired on the radio's own rounding and switched the automation off by itself.
  Details in `docs/wspr-majak-implementace.md` ch. 23; sixteen new checks in the WSPR browser smoke
  (with `/setConnected` and `/setDialFrequency` fixture endpoints), and the schedule rotation in
  that harness is now re-armed before START instead of assuming the intervening checks fit inside
  one two-minute frame.

* **A dial off the presets is marked on both pages, and refused on WSPR.** The frequency button in
  the radio bar turns red whenever the TRX is not on one of the frequencies the pop-up offers — the
  other half of the answer the menu already gives by highlighting the matching preset, for when the
  menu is closed. On WSPR that also disables START, with the reason printed under the buttons and
  repeated in the menu footer: arming on 14.200 would look fine for ten minutes and then fail its
  first slot ten seconds before it keyed. TUNE stays available, since setting the drive level on
  whatever the radio is on is a legitimate thing to be doing at that moment, and a beacon already
  running is exempt — there the schedule tunes the radio itself before every slot, so a hand-turned
  VFO is something it corrects rather than something it stops for. WSPR keeps its ±500 Hz dial
  tolerance; JS8CALL tests the presets exactly, the same comparison that draws the highlight, so
  the button and the menu can never disagree. Seven new checks in the WSPR browser smoke (with a
  `/setDialFrequency` fixture endpoint for turning the VFO behind the page's back) and one in the
  DATA browser smoke.

* **@APRSIS command builder in the JS8CALL composer.** The `▾` menu beside the message field
  gained an `@APRSIS` entry; picking it turns the menu into the APRS-IS catalogue — `GRID` and
  `CMD`, and under `CMD` the eight destinations from `docs/aprsis-cmd.md` (SMSGTE, EMAIL-2,
  WLNK-1, APRS2SOTA, APRS2POTA, WHO-IS, WXBOT, plus a free direct callsign that remembers the
  last five). A breadcrumb walks back out. Parameters are never typed into the field as
  `{placeholders}`: each destination opens a small form with the callsign, locator and dial
  frequency already filled in from the station settings and the radio, a live preview of the exact
  radio payload, and the cost in characters, frames and seconds. The nine-character APRS addressee
  padding is computed, never typed, and recomputed before transmission — a hand-edited
  `:OK1ABC:` becomes `:OK1ABC   :` and an over-long destination is truncated at nine, matching
  `APRSISClient.cpp`. Over 67 characters of APRS text the send is refused (the gateway would
  truncate it anyway, after up to two minutes of airtime); over six frames it is only warned
  about. A half-built command cannot be transmitted at all. The group call lives in the Message
  field, never in Recipient, so an APRS spot mid-QSO leaves the selected station, its chat thread
  and its LOG QSO button untouched — the command goes to the recent-traffic feed like CQ and HB.
  Sending needs no recipient at all. Replies come back from an IGate addressed to the group rather
  than to us, so they are now recognised, kept under the MYCALL filter and marked `APRS` in the
  feed. New `data/js8-aprs.js` (catalogue, parser, padding, validation; no DOM) and
  `tools/js8-aprs-smoke.js`; sixteen new checks in the DATA browser smoke.

* **Two traps fixed while building it.** Rebuilding the preset menu through `innerHTML` detaches
  the button that was just clicked, so the global close-the-menu handler walked an orphaned
  subtree, failed to find `.message-field` and closed the menu mid-use; it now reads
  `event.composedPath()`, which is captured at dispatch. And `tools/data-browser-smoke.js` served
  its test page as `text/html` with no `charset`, so Chrome decoded the inline checks as
  windows-1252 and any literal compared against non-ASCII page text (the `·` separators the UI is
  full of) silently never matched. Escape inside a modal no longer aborts a transmission in
  progress.

---

## REV 20260730 — 2026-07-30 … 2026-07-31

### `61d6749` fix prebuffered missed slot, now 3s before

* **The TX guard window grew from 1.3 s to 3 s**, ahead of the browser's own 1.35 s stream lead.
  Besides keeping the cooperative loop off blocking work (port-80 handlers, DXC connect) around the
  key instant, the wider window gives the firmware somewhere to push scheduling opportunities to a
  **backgrounded page whose JavaScript timers have been throttled** — a hidden Chrome tab can have
  chained timers serviced as rarely as once a minute, which is what made a prebuffered WSPR slot
  miss its frame.
* While a key is imminent the firmware now emits `tx-level` status about five times a second over
  the audio WebSocket, so the WSPR pump is driven by inbound traffic instead of by the browser's
  clock. JS8 shares the socket and ignores the message.

### `81534ad` redesign WSPR time table

* **WSPR timetable simplified to ordered sequence changes.** The band × 48-half-hour matrix and
  variable/randomised period were replaced by a short 24-hour UTC list such as `08:30 20→15→10`,
  `20:00 160→80→40`. Each sequence runs until the next half-hour change, preserves the operator's
  order and wraps through midnight. The scheduler has a fixed six-minute minimum per band; one or
  two bands automatically leave unused frame positions. Existing v1–v3 schedules migrate to the
  new v4 shape. Back-to-back retuning now starts immediately on `tx-drained`, polls CAT readback at
  100 ms and overlaps the 300 ms band-relay settle interval with frequency confirmation.

### `dfc4d5b` redesign all network stream to one RealtimeAudioPump

* **One realtime audio pump for every network stream.** The TX-audio path was pulled out of
  `icomLanClient.h` into a shared `icom_lan_audio_tx.h` used by both WSPR and JS8, allocated only
  for the single LAN slot that owns audio, and driven on ESP32 by a dedicated task that owns the
  whole channel (a wedged socket task can no longer be reused by a reconnect).
* **CI-V commands got a priority queue.** Control and safety traffic — above all PTT — can evict
  the oldest strictly lower-priority entry instead of queueing behind a stale meter or frequency
  request that would hold PTT ON/OFF for half a second. PTT is treated as level state rather than
  an event stream, so an older queued PTT body is dropped instead of replayed, and a failed
  submission assumes the radio may still be keyed.
* During browser TX only `/state` and safety metering are polled; frequency and the rest stand down,
  which keeps lightweight session heartbeats alive through a long WSPR carrier. The audio-channel
  epoch (both sequence spaces) is reset as a unit, and a legacy fallback covers radios that do not
  answer the newer query.
* Firmware health smoke extended (`icom_lan_client_health_smoke.cpp`, +86).

### `02ca83b` wspr time table, js8 pwr bar

* **RF power in the JS8Call header.** A ten-segment vertical bar sits after the mode, the height of
  the TIMETABLE button, one segment per 10 % of the radio's own 0–255 CI-V power scale — so the
  count of lit segments reads back as the percentage. Beside it, that percentage against the
  transmitter's full scale in watts, resolved through the same cascade the WSPR page uses (manual
  model override first, then the model the radio reports), so the two pages can never quote
  different watts for one radio. An unrecognised model leaves the bar lit and the watts at `--`:
  percent belongs to the level alone. On phones the number gives way and the bar stays.
* **`/state` says whether the RF power level was ever read.** `rfPower` starts life as a
  fabrication — 205 on TRX1, 0 in the LAN snapshot — and until the radio answered `14 0A` there was
  no way to tell that from a reading. The new `rfPowerSeen` flag makes the difference visible, and
  the WSPR page now refuses to derive watts, a dBm level or a power mismatch from the default: it
  had been reporting a confident and entirely invented `8.00 W` for a radio that had not yet spoken.

* **WSPR time table rotates bands.** A half hour may now hold several bands, which take turns frame
  by frame: with three or more the radio keys continuously, never twice running on the same band,
  and every band still rests its `periodFrames`. The schedule became one matrix, band × half hour,
  edited by rows — chips pick the band, the 24×2 grid paints its hours, a cell counts the bands
  sharing it. `periodFrames` therefore changed meaning, from "how often the station transmits" to
  "the shortest gap on one band", and the footer derives the old figure from the busiest half hour.
  Settings migrate v2 → v3 (`slots` → `rotation` rows) with no loss.
  * **This exposed a fault in the shipping schedule.** The phase was drawn per half hour, so a band
    held across two of them could key two minutes after itself: measured over 30 days, **581 of
    4 320 transmissions (13 %)** on a single-band day at every 5th frame, worst case one frame
    apart — plus one violation per midnight whenever 720 frames is not a multiple of the period.
    The phase is now drawn per *run of half hours with the same set of bands*, and a look-back lock
    catches what is left. Over the same window that removes 2 399 violations for 73 lost frames.
  * **Band changes now fit the gap between frames.** A WSPR signal is 110,592 s of a 120 s frame, so
    a rotation has 9 s to retune: the beacon confirms the polled PTT flag instead of trusting it,
    hands `WsprTx` a 4 s lead instead of 10 s for those frames, allows 300 ms for the band-decoder
    relays, and **refuses to key on a dial it has not confirmed** by T−2 s. Three late changes in a
    row and the schedule leaves a frame free after each band change until one fits again — declared
    in the schedule itself, so the preview shows the reduced pace rather than promising frames the
    beacon has already given up on. The measured band-change time is shown in TX SESSION.
  * Activity gained band chips: with several bands in a cell the worst status wins its colour, so
    one broken 10 m frame would paint an hour in which 40 m and 30 m were perfect. A band with no
    TUNE reference at the current power is marked amber in the rotation — it still transmits, but
    its forward power is never checked.
  * Fixed alongside: changing the gap or `randomise` did not redraw the predicted tail in Activity,
    so it kept showing the previous setting until something unrelated rebuilt the grid.
* **EMAIL removed from `TX SESSION → Mode`.** Only the `<option>` is gone — the gateway composer,
  both dialogs and `js8-email.js` still ship and stay covered by `tools/data-browser-smoke.js`
  (`emailReady`), which now opens the form through a test hook. Putting the option back re-enables
  the mode.
* **JS8 AUTO countdown starts by itself again.** The arming window lives only in ESP RAM, while the
  AUTO switch is a browser setting that outlives both the tab and the radio, so after a restart the
  pill read `AUTO` with no countdown until the operator toggled the switch off and on. `data.js` now
  re-arms on a page load and on a firmware restart (seen as `upMs` dropping in `GET /unattended`);
  a window that lapsed on its own or was revoked from another device is left alone, so a forgotten
  tab still switches itself off and a remote revoke still sticks. The `armed, N min left` readout in
  SETTINGS is derived from the polled deadline instead of the last POST, so it also shows a window
  armed before this page loaded. Covered by `tools/data-browser-smoke.js`
  (`unattendedRearmAfterRestart`).

---

## REV 20260729 — 2026-07-30

### `eaf6336` some fix

WSPR beacon polish — the page's second pass after the first on-air use.

* **Time table redesigned.** The 24-hour schedule became a compact 4×6 grid of half-hour slots with
  a per-slot popover, apply-to-range filling and a single-step **UNDO** for every write wider than
  one slot (Clear included); closing the panel drops the undo snapshot with it.
* **Planned-frame preview** — the panel shows which frames actually key inside the selected window
  (frames, not half hours), and keeps showing a plan even when the beacon cannot currently carry it
  out.
* `every frame` and `every 2 frames` removed; schedules now start at *every 3rd frame*, so a
  frequency cannot be overloaded by accident.
* **`randomise` explained in place** — deterministic but different every half hour, described in the
  panel footer instead of yet another popup.
* **Bug fixed: signed XOR in `frameOffset`** silently dropped roughly 40 % of scheduled half hours.
* **Power model.** The beacon now opens at 1 % of the transmitter instead of a fixed dBm, keeps a
  per-band TUNE reference and compares it against the radio on the raw 0–255 CI-V level; a mismatch
  raises a non-blocking amber warning (`targetDbm`, `powerMismatch`, `referenceFor`,
  `storeReference`, `fullPowerWatts`).
* **Setup help offered automatically** when the radio is *both* outside a data mode *and* off any
  WSPR dial frequency — either one alone is legitimate, so both conditions must hold.
* TRX button carries the slot number and the frequency is grouped in threes, matching the JS8Call
  page.
* **SWR is shown only while transmitting** (nothing is measured on RX); both meters are polled only
  while the radio is keyed.
* Running clock next to `START/STOP`; during `TUNE` it counts down the watchdog that will end the
  tune.
* Collapsed-section summaries updated so a folded header cannot show stale state; the `TX buffer
  underrun` notice now clears on the next good transmission and the slot thermometer empties on the
  RX transition.
* Activity panel: future slots drawn dark grey instead of bright outlines, and tooltips explain the
  power meter, TUNE reference and ring values.
* REV bumped to 20260729 and the build republished to the USB-C web flasher.

### `e2f1f6e` changelog

* Documentation only.

---

## REV 20260727 — 2026-07-28

### `9d65d8f` WSPR, ICOM-LAN for all TRX1-3, WakeLock on Android os, Add RX lines to map

34 files, ~4 000 insertions. Design notes: `docs/wspr-majak-implementace.md`,
`docs/data-menu-wspr-subnav-plan.md`, `docs/wake-lock.md`, `docs/js8lan-hearing-links.md`.

* **New WSPR beacon page** (`wspr.html`, `wspr.css`, `wspr.js`) with a browser-side encoder
  (`wspr-core.js`: callsign/locator/power packing, convolutional encoder, interleaving), a transmit
  path (`wspr-tx.js`) that emits AUD1 v1 kind-3 frames byte-for-byte as `aud1AcceptTxPacket` expects,
  and its own activity log in a separate IndexedDB database (`wspr-log.js`) so WSPR never mixes into
  the QSO log.
* TX flow control is credit-based off the firmware's TX audio ring (`AUD1_TX_RING_SIZE` = 12 288 B of
  8 kHz µ-law ≈ 1.536 s) instead of browser timers, with a keepalive ping as insurance against an
  idle session. The locator field accepts a locator or a coordinate pair; six characters are kept but
  only four are transmitted. The GPS idea was dropped — the beacon has to work offline.
* **DATA menu with a sub-navigation.** JS8LAN and WSPR became sub-pages of `DATA` (later shown in the
  menu as `JS8Call` and `WSPR-Beacon`), sharing `data/lan-gate.js` — which owns the "radio is not in
  LAN mode" gate card — and `data/spectrum.js`, the waterfall lifted verbatim out of `data.js` so
  both pages render identically.
* **ICOM-LAN can now be assigned to any of TRX1/2/3.** LAN is no longer wired to slot 0: the sketch
  tracks which slot owns the LAN radio and routes through `lanCivFrameRoute()`,
  `lanRadioCivSnapshot()` and `lanRadioAudioService()`. JS8/WSPR audio, PTT and `/state` follow that
  slot, a manual reconnect targets the LAN radio wherever it sits, and a LAN radio outside slot 0
  polls the same rich CI-V schedule as TRX1. `USB` and `USB-D` are now distinguishable by JS8.
* SETUP option renamed `LAN` → **`ICOM-LAN`** (it is an Icom-only protocol); the frequency selector
  header shows the actual TRX number. TrxNet slots deliberately expose only telemetry, frequency and
  mode — `docs/trx-http-api.md` documents the HTTP contract for TRX2/TRX3 adapters.
* **Wake Lock** (`data/wake-lock.js`) keeps the display alive on both data pages: Screen Wake Lock
  API first, a muted looping inline video as fallback (12 440 B of base64, 5 235 B gzipped), and an
  honest failure message when neither works. iOS stays unfixable without TLS.
* **RX lines on the station map** — green "who hears whom" arrows derived from decoded HEARING
  traffic, behind a `LINKS` toggle. Only paths with both ends on the map are drawn, stations that
  were merely heard *about* get a hollow ring and no signal figures, and blocked entities stay hidden
  everywhere.
* Waterfall gained UTC slot boundary lines and a TX marker, and resets the analyser during TX because
  the decoder is deaf while transmitting.
* `tools/upload-firmware-spiffs.sh` reports program and SPIFFS usage prominently after each upload;
  `data/THIRD-PARTY-NOTICES.txt` added; `tools/data-browser-smoke.js` extended for the new pages.

---

## REV 20260725 — 2026-07-25

### `a19c0ef` TRX setup and small changes

* **SETUP / Radio redesign after the Bluetooth removal.** All three radios (TRX1/2/3) now use the
  same shape: label + a `Connection` dropdown with `LAN / TrxNet / CI-V`, and only the fields
  relevant to the selected interface are shown. TRX1 keeps its fixed primary role.
  Design note: `docs/setup-interfaces-architecture.md`.
* **LAN is exclusive to a single TRX.** Choosing LAN on one radio disables the option on the other
  two in the UI, with a validation backstop on save. Firmware still carries multi-LAN plumbing —
  deferred follow-up.
* **New radio transport abstraction** (`radio_transport.h`, ~978 changed lines in the sketch) plus
  contract smoke tests: `tools/setup-radio-contract-smoke.js`, `tools/radio-transport-smoke.cpp`,
  `tools/js8-session-browser-smoke.js`.
* **JS8LAN settings header.** The `AUTO` icon shows the remaining time until deactivation as
  `hh:mm`; the heartbeat icon shows time to the next HB and reflects the adaptive interval
  extension driven by band activity.
* **`Enable radio TX` is now a real master switch** — turning it off disables every service that
  needs TX and greys out the affected icons in the settings header.
* **JS8LAN top navigation** behaves like the other pages: `QRPLog`, `SETUP`, `LOGSYNC` open in a new
  tab and `DXC` in a new window, so leaving JS8LAN no longer drops the session.
* Icom LAN client and the AUD1 WebSocket session updated to match the new transport layer
  (`icomLanClient.h`, `data/js8-aud1.js`, `prototype/.../aud1_websocket_session.js`), with the
  browser and audio-source smoke tests extended accordingly.
* Firmware rebuilt and republished to the USB-C web flasher (`build/gh-pages/`, firmware.bin
  970 272 → 978 864 B).
* **This changelog added** (`Changelog.md`).
* **Known state:** the wider browser smoke suite still reports 5 red checks that were already red at
  the previous HEAD and are unrelated to the SETUP work (own-call highlight is green by design, BD
  nav is hidden rather than removed, `txSlotPauseVisual` unimplemented).

### `81c3797` update changelog

* Documentation only — first version of this file.

---

## REV 20260724 — 2026-07-24

### `62e7e94` Auto LOG QSO, TimeTable

* **Automatic QSO logging for JS8.** A dedicated, permanent JS8CALL log is created and used
  independently of `activeLogId`; a QSO is logged automatically once SNR has been exchanged in both
  directions, with per-band de-duplication. `VIEW LOG` opens `/log` in a new window.
* **FREQ TIMETABLE** on the JS8LAN page: a sparse 24-hour UTC schedule of 48 half-hour slots that
  retunes the band automatically. Browser-side, stored in the settings; a band change is deferred
  while transmitting so it can never cut a TX slot.
* `Recent traffic` gained a **TX** filter next to `5 min / ALL / MYCALL`, showing only own (red)
  transmissions.
* EMAIL session fields aligned left under each other with labels on the left, matching the
  `Gateway callsign` field.
* `HB` and `TUNE` buttons stay side by side on narrow screens instead of stacking full width.
* **`partitions.csv` added to the repo** — custom layout (app0 1.375 MB / SPIFFS 2.56 MB, no
  coredump) so builds no longer depend on the Arduino IDE partition menu.

### `f212010` remove BT and CAT, fix network TX

* **Bluetooth SPP transport removed.** Supported interfaces are now LAN, CI-V and TrxNet only;
  firmware shrank by roughly 739 kB, which is what made room for the JS8 stack. CI-V constants had
  to be moved out of the `#if defined(BLUETOOTH)` block (they were trapped inside it, 102 compile
  errors) — only the CAT layer and its includes stay guarded.
* **CAT and Band Decoder web pages dropped** from the firmware/menu to free SPIFFS; the sources are
  archived in `backups/20260724-cat-bd-pages.tar.gz`.
* **TX slot stability rework** (`docs/js8-tx-slot-stability-plan.md`): TX prebuffering starts
  earlier by the measured lead time, and from the moment a TX request is accepted competing network
  requests are held off until the slot completes. This addressed the repeated
  `TX abort: TX prebuffer missed slot` / `TXfault` entries.
* **TrxNet no longer fails to publish TRX1 frequency** after the transport refactor.
* **JS8LAN blocking + TX visibility:** the existing *Blocked DXCC* list now also fully hides blocked
  calls in JS8LAN and hard-refuses TX to them; own transmissions in `Recent traffic` are red when
  actually emitted and grey when not; a station that reacted to own TX is marked with a red dot in
  the map and table (derived from decoded *messages*, not frames, so it survives `CLEAR`).

---

## REV 20260723 — 2026-07-24 01:36

### `0e8efc4` automatic function

The unattended-operation layer. 71 files, ~4 000 insertions.

* **New JS8 automation modules:** `js8-autoreply.js`, `js8-heartbeat.js`, `js8-inbox.js`,
  `js8-relay.js`, `js8-restrictions.js`, `js8-scheduler.js`, `js8-txqueue.js`, backed by firmware
  side `js8_session.h`, `unattended_guard.h`, `unattended_events.h`.
* **Guard model changed from a hard cap to a watchdog.** A fixed transmit ceiling made continuous
  operation (e.g. long BIN transfers) impossible, so the firmware instead watches for its own stall
  and expects a liveness heartbeat from the front end to accept requests as legitimate.
* **HB ACK corrected against the JS8Call reference** — replies now use the
  `<CALL>: <CALL> HEARTBEAT SNR -NN` form seen on the air instead of a generic ACK; other automatic
  functions were re-verified against the reference implementation at the same time.
* **Settings header status shortcuts** — compact indicators on the right edge of the settings bar
  showing which automatic functions are enabled, styled after the `Recent traffic` buttons but
  signal-only.
* **DXCC country column** in the `Stations` table, reusing the prefix lookup from the LOG page.
* **Single-tab lock** — opening JS8LAN in a second browser/tab/PC shows a notice instead of
  fighting over the radio.
* **UI design pass** to make the page look less like a generated tool: restrained palette,
  emphasis only where it carries meaning, static previews prepared before applying.
* SPIFFS/asset audit: unused files removed, JSC dictionary and the Brotli decoder path explained and
  kept, and the CAT/BD page removal was costed here before being executed the next day.
* Wording pass: "unattended operation" section in SETUP renamed to *remote management of unattended
  JS8 operation*; `Modem settings` renamed to `SETTINGS`; all web GUI text in English.
* New smoke tests: `tools/js8-email-smoke.js`, `tools/js8-file-transfer-smoke.js`,
  `tools/js8-settings-smoke.js`, `tools/icom-lan-login-test.py`.

---

## REV 20260720 — 2026-07-19 … 2026-07-20

### `4f94a9e` bugfix

* CW IP announcement sequence corrected: before keying, RF gain goes to minimum and BK-IN is turned
  off, so the announcement is sidetone-only and never reaches the air; settings are restored
  afterwards.
* SETUP gained the switch that enables/disables the CW IP info.
* Documented the AP topology question (phone as AP with client isolation) that had made the
  data path unclear.

### `7d78416` IP send by CW on start up

* `announceIpViaCw()` now also runs when the radio is connected over **LAN**, not just BT. Mode,
  BK-IN, AF and RF gain are snapshotted and restored around the announcement.
* Fixed JS8LAN input fields (starting with `Recipient`) that dropped characters as they were typed.

### `44169b8` QSO Log button — not tested on radio

* `LOG QSO` button on the JS8LAN page; the TRX label always resolves to TRX1, since JS8LAN works
  only with the primary radio.

### `2c92055` Refresh js8lan data after leaving and returning — not tested on radio

* JS8LAN state is preserved in `sessionStorage` and restored when the page is re-entered, instead of
  showing stale or empty tables.
* `docs/js8call-komunikacni-funkce.md` written from the JS8Call documentation as the feature list
  for normal on-air communication (HB replies, relaying, …).

### `db4d69e` finish network audit

* Closing items of `docs/icom-lan-network-audit.md`.
* `Recent traffic` wraps long messages instead of truncating them with an ellipsis.

### `d240873` publish to web upload tool · `3de89a6` new map and net fix · `8b230b0` #2 #3 #4 #5 net fix

* **Audit item #4:** the overloaded `connected()` state was split into `sessionConnected`,
  `catHealthy` and `audioReady`, so a CAT hiccup no longer yanks power state and audio.
* **Audit item #5:** the audio sub-channel got its own no-data recovery; the console flood of
  `LAN | audio no data, reopening sub-stream` was traced and stopped.
* New polar **map preview** for decoded stations: linear rings, dots instead of callsigns at the
  ends, current radius printed in the corner (preview only — selection stays in the tables).
* Build artefacts republished to the web flasher.

### `d7d3dd7` gui update

* Responsive top menu bar — on narrow phone screens the page no longer becomes wider than the
  display.
* Waterfall vertical marker made visible again.
* SETUP / WiFi section gained a step-by-step guide for joining the IC-705 to the same AP.

### `91994de` gui update and fix

* `docs/icom-lan-network-audit.md` — full audit of the LAN sequence, plus a firmware health smoke
  test (`icom_lan_client_health_smoke.cpp` with `WiFi.h`/`WiFiUdp.h` stubs).
* Own callsign highlighted red in `Stations` and `Recent traffic` (the decoder does hear your own
  signal — the LAN stream is duplex).
* `Recipient` can no longer be your own callsign.
* Table action buttons moved inside their block, as the list header's first row.

### `2e81dd2` bugfix

* **EMAIL mode** (`data/js8-email.js`) per `docs/js8call-email-gateway-implementace.md`, with
  `Server callsign` renamed to `Gateway callsign`.
* **BIN mode** — binary file transfer (`data/js8-file-transfer.js`) per
  `docs/js8call_file_transfer_implementation_guide.md`, including size limits per selected speed and
  rejection of oversized files on import.
* `aud1_ws_parser.h` and `icom_lan_tx_history.h` extracted from the sketch; storage moved to
  **LittleFS** (`LFS | mounted used=… total=1966080`).
* Default `TX audio gain` set to 0.25 and the help text extended with
  `MENU/SET/Connectors/MOD Input/WLAN MOD Level = 25%`.
* HB no longer displays text it does not transmit (`@HB HEARTBEAT JO70` vs the transmitted
  `@HB JO70`).
* `Direction — 1000 km` column shortened to `kkm`, `Last heard` to `Last`.
* Full audit of the network sequence after repeated "we fix one thing and break another" cycles.

### `0c121ad` bugfix

* Own callsign appearing in `Stations`/`Recent traffic` turns red and auto-expands a collapsed
  block.
* With a `Recipient` selected, messages directed at someone else are hidden; undirected messages
  stay visible.
* **Per-character TX progress colouring** — the message background fills as characters are actually
  transmitted, pauses at a slot boundary and continues in the next one; waiting/failed and sent
  messages are visually distinct.
* Callsigns (own and the called station) are now included in composed messages such as
  *reply with received SNR*, and in HB — checked against the JS8Call specification.
* `My callsign` / `My grid` fields in modem settings became editable (characters no longer vanished).
* `TX abort: TX prebuffer missed slot` diagnosed and handled instead of silently dropping the
  transmission.

### `7ca05ee` fix installer

* Web installer at `https://ok1hra.github.io/wifilt/` failed with
  *Failed to initialize*; ESP Web Tools was pinned back to **10.2.1** and the published assets
  regenerated. (The board has no BOOT button; unplug/replug of the USB cable was the workaround
  during diagnosis.)

---

## REV 20260718 — 2026-07-18

### `319b074` JS8LAN – Web Client for JS8Call

The largest change in the project's history: 546 files, ~434 k insertions (most of it the vendored
JS8Call source used to build the decoder).

* **JS8Call decoder/encoder integrated** as WebAssembly built from `JS8Call-improved-master`
  (Eigen and the JS8 mode sources vendored, licences included), driven from the browser over the
  binary audio WebSocket.
* Waterfall reworked: slower, vertically compressed, recommended JS8 audio passband marked with thin
  green lines and the area outside it dimmed; decode LED bar and slot "thermometer" added so the
  background rhythm is visible.
* `Stations` table with speed letter *and* its real speed, distance column in thousands of km with
  the DXC bearing algorithm (falling back to the DXC estimate when no grid was decoded).
* `Recent traffic` in messenger style — received on the left, sent on the right; single-line rows
  except on very narrow screens.
* **TX SESSION** selector with `CHAT / EMAIL / BIN` modes, preset message dropdown (CQ, SNR
  reply, …), `TUNE` button next to `HB`, and `Enter` sending instead of a large `Send` button.
* Frequency/mode of the radio shown in the page header with a band preset popup for retuning; tables
  are cleared when the dial moves more than 2 kHz and restored on return.
* `?` help popup with the complete IC-705 preset for JS8 over WLAN
  (`MENU/SET/Connectors/MOD Input/DATA MOD = WLAN`, …).
* Menu item renamed `DATA` → `JS8CALL` → finally **`JS8LAN`** with a *Web Client for JS8Call*
  tooltip; `DEBUG` removed from the menu, `BD` shown only on supported hardware, `CAT` moved to the
  end and de-emphasised; `beforeunload` warning when leaving with a live session.
* Page shows an explanatory warning instead of the UI when TRX1 is not configured for LAN.
* **Asset pipeline**: `tools/minify-spiffs-js.sh`, gzip/Brotli generation and
  `tools/upload-firmware-spiffs.sh` (export compiled binary → build SPIFFS → upload) replacing the
  Arduino IDE data-upload menu, which could not fit the tree any more
  (`SPIFFS_write error(-10001): File system is full`).
* Web flasher page now states the required hardware (MCU type and flash size).

---

## REV 20260717 — 2026-07-17 … 2026-07-18

### `7ddfc48` new data page without any modem

* **New DATA page**, active only when the primary TRX1 runs in LAN mode: audio waterfall fed by a
  real RX stream, plus placeholders for the modem's input/output.
* **Audio over the Icom LAN protocol**: uLaw 8 kHz RX and TX sub-stream, exposed to the browser over
  a binary WebSocket on **port 83**; PTT is keyed over CI-V. The last missing piece for the first
  successful transmission was the radio's own `MOD Input = WLAN` setting.
* `docs/modem-implementation.md` written as the integration contract, and the standalone
  `prototype/js8-core-prototype/` toolchain (Emscripten, real-time factor and vector smoke tests)
  set up so modem work stayed strictly outside the firmware until integration.
* UI direction chosen: compact layout, blocks collapsible under headers, ordered by importance, all
  texts in English.

### `53a9ad4` new LAN TRX connect · `ddeab71` bugfix

* **`icomLanClient.h` — native Icom LAN client**: control/CI-V/audio UDP channels, login and
  capabilities exchange, `I am here` handshake, retransmission handling. Verified against the
  IC-705 and tried against an IC-7610. Six documented deviations from wfview were needed to make the
  IC-705 accept the session (ready on every channel, no `resetcap`, the 0x05 auth gate, fixed ports,
  0x05 open, controller `0xE1`).
* **SETUP per-radio connection type** — dropdown `Icom-BT / Icom-LAN / Icom-CIV / TrxNet` for each
  TRX with enable switches, fields shown per selection, LAN as the default choice, and the
  configuration correctly saved/restored across reboots.
* CAT page: MODE display and `FIL1-3` filter setting fixed; a frequency entered directly in the
  `FREQ` field now updates the page immediately.
* LOG band map no longer covers the last log rows and no longer toggles on/off.
* The long-running "DXC keeps dropping WS and Telnet" hunt ended as a false alarm — five DXC windows
  were open at once. CI-V/DXC handling was hardened along the way.

---

## REV 20260712 — 2026-07-12

### `5a27f6d` new Log dupe in DXC, some bugfix

* DXC spots are matched against the log and duplicates highlighted (`refreshLogDupeSet`,
  `collectVisibleRows`).
* Adaptive CAT polling cadence (`CAT_POLL_MS` / `CAT_POLL_FAST_MS` / `CAT_FAST_HOLD_MS`,
  `AUX_POLL_MS`): the fast cadence is held only while the CAT page polls `/state?fast=1`, which
  keeps the BT SPP link out of sniff mode without loading the rest of the system.
* WiFi supervision thresholds (`WIFI_RESTART_AFTER_MS`, `WIFI_HARD_RESET_AFTER_MS`) and
  `DXC_CONNECT_TIMEOUT_MS` introduced.

---

## REV 20260707 — 2026-07-10

### `775bd76` TrxNet new setPriorityPrefixes + many bugfix

* TrxNet priority prefixes configurable and persisted (EEPROM 288 flag + 289–359 string, 8 tokens ×
  8 characters), loaded into the live token buffers at boot.
* Call search: `Enter` jumps to the first match and dismisses the popup; `Enter` in any text field
  saves (except in `<select>`).
* On-screen-keyboard viewport handling for phones and tablets.

---

## 2026-06-09

### `ba18e2b` snapshot

* **CI-V serial transport for TRX2/TRX3** — a second way to reach the auxiliary radios besides
  TrxNet. Includes a CI-V framer with address filtering (frames addressed to the controller or
  broadcast), a non-blocking polling state machine and a single UART0 RX pump shared with the CLI.
* Per-TRX connection type (`CONN_TYPE`: TrxNet or CI-V) with the unused input disabled in the UI;
  CI-V addresses stored in EEPROM bytes 48/49.

---

## REV 20260523 — 2026-05-22 … 2026-05-23

### `27f70d1` tune · `20fa51e` tuning

* Analysis and mitigation of `LOOP| slow: webServer` stalls of up to 10 s observed while TrxNet and
  DXC were active.

### `fee2ee4` Band map now tunes the currently selected TRX · `d1754dd` Fix band map not showing when TRX2/3 is active · `7550835` bugfix

* Clicking the band map tunes the currently selected radio instead of always TRX1.
* The band map is displayed for TRX2/TRX3 under the same conditions as for TRX1 — it is driven by
  that radio's frequency and online state, not reserved for the primary.

---

## REV 20260522 — 2026-05-22

### `90477f0` tuning · `a2da7e7` fix DXC

* **LOGSYNC pairing regression fixed** — after the label rework the two devices stayed stuck at
  *Waiting for the other device…* because their auto-generated device labels and device IDs no
  longer matched the pairing key.
* DXC page fix.

---

## REV 20260520 — 2026-05-20

### `21e0354` tuning

* Device label in LOGSYNC generated automatically from browser name, IP and a unique suffix, and
  displayed on the page again.
* **WiFi signal strength in the top menu of every page**, grey normally and red below −70 dBm.
* SPIFFS upload failures from the Arduino IDE worked around in the asset scripts.

---

## REV 20260519 — 2026-05-19 … 2026-05-20

### `825ce67` fix TrxNet, tune html

* TrxNet `publishTo(peerName)` made mandatory, removing the broadcast publish path.
* LOG now formats CW/messages for TrxNet when TRX2/TRX3 is selected instead of sending them in the
  Bluetooth form.
* `Alt+Enter` saves a QSO without sending the macro; the shortcut list under `?` on the LOG page
  updated.
* Frequency/mode polling slowed to ~0.5–1 s outside the CAT page, relieving the BT link and the web
  server.
* The `LOOP| slow: webServer 9–19 s` stall that made SETUP unreachable (and cost the device its IP)
  was traced and fixed.

### `fcee7c0` tune html

* **Pre-compressed assets**: `tools/gzip-assets.sh` added and every page shipped as `.gz`, which is
  what made LOG and SETUP load quickly. Editing a source `.js` has no effect until the generator
  scripts are re-run — the firmware serves the compressed copies.

---

## REV 20260517 — 2026-05-17 … 2026-05-19

### `3b4e58b` custom BT name, Band Decoder for hw rev 04

* Configurable Bluetooth device name.
* **Band Decoder for hardware revision 04**: `bd.html` / `bd.js`, shift-register pins
  (`BD_CLOCK_PIN`, `BD_DATA_PIN`, `BD_LATCH_PIN`), configurable row/column ranges with red/green
  priority highlighting, and updates driven by the TRX1 frequency.

### `2453067` bugfix · `f94c271` tuning

* Crash after restoring a saved SETUP configuration analysed and fixed.

### `175e59c` remove MQTT | add TrxNet · `f30af41` fix TrxNet

* **MQTT removed and replaced by TrxNet** (`docs/trxnet.md`): `/hz` and `/mode` from any peer feed
  the TRX2/TRX3 slots, `/s-hz` sets the IC-705 VFO through CI-V. Callbacks stay short and the work
  is processed in the main loop. EEPROM 44–46 freed; `NET_ID 0x00` acts as the "TrxNet disabled"
  sentinel.

---

## REV 20260516 — 2026-05-16

### `9e7f0e2` bugfix, redesign log exch

* **Exchange redesign**: instead of the opaque `NR / JO70FD`, the setting offers `TU / NR / LOC`
  with a `?` help bubble, and `LOC` uses the locator from `My locator`.
* Documented how CW/RTTY memories are selected per operating mode, and how VHF QSOs get the locator
  format.
* Bluetooth stack crash (`ASSERT_PARAM(1024 0), in rwbt.c at line 381`) analysed and mitigated.

---

## REV 20260515 — 2026-05-15

### `a5d0e46` bugfix

* **SETUP persistence audit and rebuild.** TRX2/TRX3 label, backend IP and OI3 flag, and the
  CW/frequency memories, survived only until the next page load and were missing from the exported
  config; `Save & Restart` could fail with a network error. Storage, load and export/import were
  reworked rather than patched.
* LOG page mode mapping corrected (`1 = CW`, `2 = SSB`, `4 = RTTY`).
* Band map shown for TRX2/TRX3 as well.

### `3d0b3e4`, `6db5110`, `f558091`, `2947193`, `daa3974`…`51823e4`, `1c3f960`

* Screenshots (`docs/CAT.png`, `DXC.png`, `LOG*.png`, `SETUP.png`, `sw-block.png`), README rewrite,
  user manual update and gh-pages republish.

---

## REV 20260513 — 2026-05-13 … 2026-05-14

### `4dbfb63` bugfixing

* WiFi now scans before connecting, which removes the infinite loop that dropped the device into AP
  mode when configured SSIDs were absent.
* Clarified in the UI what the three network input ports do; the SETUP heading became
  *Network input ports*.

### `2ac2ee3` backup log database

* Log database backup with a `beforeunload` guard and a timer, so a browser-side log cannot be lost
  silently.

### `ad2ec91` DXC

* **New DXC page** — Telnet DX cluster client with band/type/direction/DX filters, zoom, column
  layout and bearing/distance computation.

### `82ade75` LOG bandmap

* SVG band map on the LOG page with live spots published from DXC
  (`publishVisibleDxccSpots`, scale and band rendering).

### `1dc02d6` fix continue

* Storage-persistence check with an explanatory popup (Firefox auto-grants when bookmarked, other
  browsers need the permission dialog).

---

## REV 20260509 — 2026-05-09 … 2026-05-11

### `6b2e5e4` redesign DATASYNC

* Pairing moved to firmware endpoints (`/pairing/offer|answer|reject` with CORS handling) and the
  sync vector rebuilt from the QSOs actually stored, so deletions no longer left a stale
  `sync_state` and partial transfers are re-requested correctly.
* Global dupe/partial search across all logs.

### `02db511` new Log import

* **Log import** with format auto-detection: ADIF, Cabrillo and EDI parsers plus normalisers and an
  import dialog.

### `e53cc4e` GitHub pages USB-C web flasher · `b506dcb` README

* `tools/gh-pages.sh` and a published `build/gh-pages/` manifest — the device can be flashed from
  the browser over USB-C, no toolchain required.

### `be12627` partial save · `42e79bb` clear code + user-manual · `7ea02a2` bugfix

* `data/fw-version.js` (firmware version shown in the UI, fetched locally or remotely),
  `docs/user-manual.md` written, TRX2/TRX3 buttons hidden when no IP is configured with a fallback
  to TRX1, serial RX buffer flushed after boot noise.

---

## REV 20260508 — 2026-05-08 … 2026-05-09

### `c72eff3` redesign structure · `94d1f87` final CAT

* CAT internals reorganised: separate frequency/RIT read pauses while the user is tuning, queued
  command posting, wheel-step handling, CW and frequency memory rendering.
* RIT set/clear (CI-V `0x21`), LSB-first BCD encoding helper, S-meter/SWR/supply sub-bar mapping and
  GPIO FSK keying.

### `d889a4a` new LOG

* **New LOG page** (3 619 insertions): QSO entry with a form state machine, DXCC lookup, exact and
  partial dupe checking, QRB/azimuth from the locator, macros, ADIF field mapping, QSO edit dialog,
  multiple logs (create/delete/activate), CW numbers, and keyboard shortcuts
  (`Alt+U` RUN/S&P, `Alt+W` clear, `Esc` close dialog).

### `1295305` new DATASYNC

* **Log synchronisation between devices** — offer/answer pairing with a QR code
  (`qrcode.min.js`), IndexedDB import/export, compressed range transfers and a device identity.

---

## REV 20260505 — 2026-05-05 … 2026-05-08

### `f6c0122` MQTT bugfix | MQTT RX freq

* Fixed the MQTT publisher that stopped after two frequency messages while the rest of the firmware
  kept running.
* The CI-V `SET` sequence is now sent only on the first connection after a reboot, not on every
  radio reconnect.
* **New MQTT RX topic**: a received frequency is written to the IC-705 VFO over CAT.
* Additional WiFi SSID slots in the web form.

### `c488f18` start WebSocket CAT proxy

* **WebSocket ↔ CI-V proxy** (design later written up in `docs/websocket-civ-proxy.md`): live rig
  state on `/ws` plus a raw CI-V console, with the web assets moved to SPIFFS to make room.
  Includes a diagnostic mode with an event log, filtering of page-generated traffic and clipboard
  copy.

### `24e2920` CAT page

* **New CAT page** (black theme, `CAT | WS-CAT | SETUP` navigation added to every page): large
  frequency display in `MHz.kHz.Hz` with a smaller Hz group, red while transmitting, fixed digit
  positions from 1 to 3 MHz digits, mouse-wheel tuning by the digit under the cursor and
  left/right click for ±1, S-meter, sliders with values, `FREQ` direct entry, radio and WiFi status
  in the bottom bar.

### `8f1a99e` CAT finish

* Key speed shown in WPM and RF power in %, SWR/supply rendered as bars matching the S-meter with a
  thin separator, sliders greyed/zeroed when the radio is off or disconnected.
* Four CW memories (30 characters each) configurable in SETUP and sendable from the CAT page.
* CI-V address and Icom model selection (`IC-705-BT`, `IC-7610-CI-V`) added to SETUP.
* Fixed the recurring `Guru Meditation Error: Core 1 panic'ed (LoadProhibited)` and
  `ERROR: Too many messages queued` crashes seen on band changes, and a `CORRUPT HEAP` after long
  idle periods.

---

## Earlier history (before the current development cycle)

| Commit | Date | Summary |
| --- | --- | --- |
| `a5be7ef` | 2026-03-22 | rev 20260322, many bugfixes |
| `38ae41d` | 2025-02-07 | DV mode added (not working) |
| `1a015c0` | 2024-12-21 | New debug setting in the CLI |
| `b2e9bae` | 2024-08-11 | Hardware revision 03 |
| `1596f7c` | 2024-02-03 | First release, 20240203 |
| `58a22c1` | 2024-01-28 | WiFi AP mode and the SETUP web form on port 80 |
| `6ab8f77` | 2024-01-16 | IP announcement in CW, CLI info |
| `a14f5c7` | 2024-01-11 | Bluetooth name moved to the config |
| `5f00f6e` | 2024-01-06 | RTTY operation fixed |
| `834341f` | 2023-12-29 | MQTT postponed |
| `c593307` | 2023-12-28 | PWR output fixed |
| `bb41c7d` | 2023-12-27 | UDP to CAT, TRX selection |
| `dafb140` | 2023-12-25 | CI-V output and mute |
| `31350c8` | 2023-12-21 | Antenna switch, mDNS, watchdog, PWR OUT |
| `0544d1d` | 2023-12-18 | 3D print model |
| `84d85df` | 2023-12-17 | FSK fixed, hardware ID and status LED |
| `b3a860e` | 2023-10-31 | FSK support (untested) |
| `f1bed1e` | 2023-10-29 | udp2cw fixed |
