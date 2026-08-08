# Changelog

All notable changes to **WIFILT**, grouped by firmware revision (`#define REV`) and
broken down per commit.

Newest first. Dates are local (CEST). A firmware revision is the `REV` value flashed with that
commit — several commits usually share one revision, and the revision is bumped when a build is
published.

---

## Working tree — not committed

* **Design notes in `docs/`** (untracked), including `first-run-plan.md`,
  `tx-audio-gain-plan-implementace.md`, `tx-auto-gain-implementace.md`,
  `js8-skupiny-implementace.md`, `msgbox-implementace.md`, `js8-signal-stripe-plan.md`,
  `js8-rx-partial-display-plan.md`, `js8-llm-implementace.md`, `find-device-ip.md`,
  `wifilt-rename-plan.md`, `aprsis-*.md`, `wspr-*.md`, the `js8call-*` guides, `docs/agents/` and
  the radio CI-V manuals in PDF.
* **Agreed but not implemented:** the JS8 LLM chat (`docs/js8-llm-implementace.md`) — budget
  `clamp(frames_rx − 1, 1, 4)`, the timer initiates and the model may only veto, key in
  `localStorage` because `crypto.subtle` does not exist on an insecure origin.
* **Untracked test harnesses** in `tools/`: `js8-modem-failure-smoke.js`, `js8-groups-smoke.js`,
  `js8-data-frames-smoke.js`, `js8-aprs-smoke.js`, `js8-txqueue-smoke.js`, `civread-smoke.js`,
  `check-page-scripts.js`, `fixtures/`, plus most of `prototype/js8-core-prototype/`.
* **`mercury/`** — Rhizomatica Mercury v2 evaluated as a second file-transfer modem beside JS8 and
  WSPR; the WASM build exists and passes a loopback test (~230 kB Brotli). Airtime, not flash, is the
  limiting factor. Notes in `docs/mercury-implementace.md`.
* `backups/` and `AGENTS.md`.

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
