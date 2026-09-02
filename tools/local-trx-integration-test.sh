#!/usr/bin/env bash
#
# End-to-end test of local-trx (Dávka 1: fáze 0+1+4 + FSK-over-TrxNet's bod
# 15; Dávka 2: fáze 2 RX audio + fáze 3 TX audio/PTT + fáze 7 CI-V extras +
# fáze 6 setup wizard), same shape as tools/native-integration-test.sh.
#
# Starts local-trx against hamlib's "Dummy" backend (no hardware needed),
# starts the UNMODIFIED native wifilt binary pointed at it via
# radio-config.json's "lan" connection, and asserts the whole ICOM-LAN-server
# impersonation actually works: handshake, login, CI-V frequency reaching
# /state, synthetic identity ("LOCAL-TRX", not a real model number), CW text
# over CI-V 0x17 reaching the keying subsystem, FSK text over a TrxNet
# "/s-cw" message reaching the SAME keying subsystem via trxnet_peer.h, and
# real captured audio streaming out the audio channel in the correct wire
# format (tools/local-trx-audio-check.py, run directly against local-trx --
# wifilt's own AUD1 forwarding needs `sudo setcap` on port 83, not exercised
# here, see that script's own header for why).
# Both keying paths key/PTT through main.cpp's LoggingKeyLine (a stand-in for
# serial_key.h until 2026-08-31); serial_key.h now exists and is used instead
# whenever keying.port is configured and actually opens (see docs/
# local-trx-implementace.md) -- this test still uses the logging fallback
# (keying.port:"") since there is no DTR/RTS adapter on this box either.
#
# Runs close to two minutes: CW needs wifilt's own CI-V mode-poll rotation to
# catch up (up to 30s) and FSK needs wifilt's TrxNet to discover local-trx as
# a peer (up to ~30s, TrxNet's own announce cycle -- confirmed real protocol
# behaviour live 2026-08-31, not a local-trx bug).
#
#   tools/local-trx-integration-test.sh
#
# Exit 0 on success. See docs/local-trx-implementace.md for the design this
# proves.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIFILT_BIN="$ROOT/native/build/wifilt"
# Overridable so this SAME test can also prove the Windows cross-build
# (bod 13, Dávka 3) actually runs, not just compiles: LOCAL_TRX_BIN=
# local-trx/build-win/local-trx.exe LOCAL_TRX_WRAPPER=wine
# tools/local-trx-integration-test.sh. Everything below is unaware of which
# binary/wrapper it is -- wifilt itself is always the native Linux build
# (only local-trx is under test here), and the two talk over real loopback
# UDP/TCP regardless of which side wine is translating.
LOCAL_TRX_BIN="${LOCAL_TRX_BIN:-$ROOT/local-trx/build/local-trx}"
LOCAL_TRX_WRAPPER="${LOCAL_TRX_WRAPPER:-}"
RADIO_IP="${RADIO_IP:-127.0.0.3}"   # distinct from icom-lan-fake-radio.py's 127.0.0.2 --
                                     # overridable because wine's WinSock emulation was found
                                     # (2026-09-01, Dávka 3) to silently wildcard-bind any
                                     # loopback ALIAS other than 127.0.0.1 itself, breaking
                                     # wifilt's own fromRadio() sender-IP check; the Windows
                                     # cross-build run of this script uses RADIO_IP=127.0.0.1
HTTP_PORT=8081
WORK="$(mktemp -d)"
LTX_PID=""
APP_PID=""
FAILURES=0

# ALWAYS kills the two background processes, pass/fail/crash/Ctrl-C alike --
# an orphaned wifilt+local-trx pair left running (both still wildcard/
# specific-bound to the same UDP ports) silently mimics "LAN instability" for
# the NEXT run of this script, which is a much more confusing failure than
# this one ever is. Only $WORK's fate (kept vs removed) depends on FAILURES.
cleanup() {
  [[ -n "$APP_PID" ]] && kill -TERM "$APP_PID" 2>/dev/null
  [[ -n "$LTX_PID" ]] && kill -TERM "$LTX_PID" 2>/dev/null
  wait "$APP_PID" "$LTX_PID" 2>/dev/null
  if [[ -n "$LOCAL_TRX_WRAPPER" ]]; then
    # See the launch site's own comment: $LTX_PID is wine's short-lived
    # launcher, not the actual local-trx.exe process or wineserver -- sweep
    # both by name so a wine-hosted run never leaves either behind.
    pkill -9 -f "$(basename "$LOCAL_TRX_BIN")" 2>/dev/null
    wineserver -k 2>/dev/null
  fi
  if [[ $FAILURES -eq 0 ]]; then
    rm -rf "$WORK"
  else
    echo "logs kept in $WORK for a post-mortem"
  fi
}
trap cleanup EXIT

check() {
  local name="$1" ok="$2"
  if [[ "$ok" == "1" ]]; then
    echo "  ok   $name"
  else
    echo "  FAIL $name"
    FAILURES=$((FAILURES + 1))
  fi
}

if [[ -z "$LOCAL_TRX_WRAPPER" ]]; then
  echo "== building local-trx =="
  make -C "$ROOT/local-trx" >/dev/null || { echo "local-trx build failed"; exit 1; }
else
  # Cross-build target (arm64/win) -- built by `make -C local-trx arm64|win`
  # beforehand (needs third_party/build-cross-libs.sh's libs first), not
  # rebuilt here: this script does not know which cross target LOCAL_TRX_BIN
  # actually is, and rebuilding the WRONG one for whatever this happens to
  # point at would silently test stale bits.
  [[ -x "$LOCAL_TRX_BIN" ]] || { echo "$LOCAL_TRX_BIN not found or not executable -- build it first"; exit 1; }
  echo "== using prebuilt $LOCAL_TRX_BIN via '$LOCAL_TRX_WRAPPER' =="
fi

echo "== building native wifilt =="
make -C "$ROOT/native" >/dev/null || { echo "native build failed"; exit 1; }

mkdir -p "$WORK/local-trx-cfg"
cat > "$WORK/local-trx-cfg/config.json" <<EOF
{
  "enabled": true,
  "listenIp": "$RADIO_IP",
  "audio": {"inputDevice": "default", "outputDevice": "default"},
  "cat": {"port": "", "baud": 19200, "rigModel": 1},
  "keying": {"port": "", "baud": 1200, "keyLine": "dtr", "pttLine": "rts", "cwWpm": 20, "fskNetId": 16},
  "identity": {"radioName": "LOCAL-TRX", "civAddress": "A6"}
}
EOF

echo "== starting local-trx on $RADIO_IP =="
# --web-port on a non-default port (8766) purely to stay clear of anything
# else on the dev machine's 8765; --web-root pointed explicitly at the repo's
# own webui/ -- the default (next to the BINARY, i.e. local-trx/build/) is
# right for a packaged dist/ layout (matches wifilt's own "data/ beside the
# executable" default, native/main.cpp) but not this dev build tree.
$LOCAL_TRX_WRAPPER "$LOCAL_TRX_BIN" --config-dir "$WORK/local-trx-cfg" --web-port 8766 \
  --web-root "$ROOT/local-trx/webui" -v > "$WORK/local-trx.log" 2>&1 &
LTX_PID=$!
# wine's own PID (LTX_PID above) is a short-lived launcher, NOT the actual
# local-trx.exe process wine execs into -- killing only LTX_PID would leave
# the real process (and wineserver) running. cleanup() below always sweeps
# for it by name when LOCAL_TRX_WRAPPER is set, same "always check by name,
# not just by PID" discipline as every other live-radio driver in this repo
# (see mercury-orphaned-chrome-tx-incident in project memory).
sleep 1

echo "== setup wizard: checking local-trx's own HTTP server (fáze 6) =="
python3 "$ROOT/tools/local-trx-wizard-check.py" --port 8766
WIZARD_STATUS=$?

# RX+TX audio (bod 2/fáze 2 + bod: fáze 3): talks straight to local-trx's own
# audio port, bypassing wifilt entirely -- wifilt's LAN client only opens ITS
# OWN audio channel once a browser is attached to AUD1 (needs
# CAP_NET_BIND_SERVICE on port 83, i.e. `sudo setcap`, not available on every
# dev machine), which tells us nothing about whether local-trx's own
# streaming is correct. This checks exactly that, independent of wifilt and
# of setcap. ONE connection tests BOTH directions (--check-tx-gap) --
# AudioChannel's peer_ latches onto the first client it hears from and never
# re-targets it (ported from tools/icom-lan-fake-radio.py's own behaviour,
# see local-trx-audio-check.py's header), so a second independent script
# could not get its own handshake answered once this one has connected.
echo "== Audio: checking local-trx's own audio channel (RX + TX gap) =="
AUDIO_STATUS=1
if grep -q "RX audio capturing from" "$WORK/local-trx.log" 2>/dev/null || \
   { sleep 1; grep -q "RX audio capturing from" "$WORK/local-trx.log" 2>/dev/null; }; then
  python3 "$ROOT/tools/local-trx-audio-check.py" --ip "$RADIO_IP" --packets 5 --check-tx-gap
  AUDIO_STATUS=$?
else
  echo "  (no capture device available in this environment -- see local-trx.log)"
  AUDIO_STATUS=2
fi

# PTT (CI-V 0x1C, bod: fáze 3) -- own channel (CI-V), no capture/playback
# device needed. Must run before wifilt itself connects below: the SAME
# peer-latching behaviour above applies to the CI-V channel too, and wifilt
# is about to become its one and only client for the rest of this test.
echo "== PTT: checking local-trx's CI-V 0x1C handling =="
python3 "$ROOT/tools/local-trx-ptt-check.py" --ip "$RADIO_IP" --civaddr A6
PTT_STATUS=$?

# Category (b)/(d) extras (bod 11, fáze 7): RF power/meters/ATT/VOX + the
# transceive-broadcast push. Same "own channel, before wifilt claims it"
# reasoning as the PTT check just above -- this too talks CI-V directly.
echo "== CI-V extras: RF power/meters/ATT/VOX + transceive broadcast (fáze 7) =="
python3 "$ROOT/tools/local-trx-civ-extras-check.py" --ip "$RADIO_IP" --civaddr A6
CIV_EXTRAS_STATUS=$?

cat > "$WORK/radio-config.json" <<EOF
{"version":1,
 "trx1":{"enabled":true,"connection":"lan","civaddr":"A6","netid":"FF",
         "lanip":"$RADIO_IP","lanuser":"tester","lanpass":"secret","model":""},
 "trx2":{"enabled":false,"connection":"trxnet","civaddr":"00","netid":"FF",
         "lanip":"","lanuser":"","lanpass":"","model":""},
 "trx3":{"enabled":false,"connection":"trxnet","civaddr":"00","netid":"FF",
         "lanip":"","lanuser":"","lanpass":"","model":""}}
EOF
cp "$WORK/radio-config.json" "$WORK/radio-config.json.bak"

# FSK-over-TrxNet (bod 15): wifilt reads this once at startup, no HTTP setter
# exists for it (loadLogConfigVars(), wifilt.ino:1270-1289). fskNetId "10"
# matches local-trx-cfg/config.json's keying.fskNetId=16 (0x10) above.
cat > "$WORK/log-config.json" <<'EOF'
{"fskOutputMode":"trxnet","fskNetId":"10"}
EOF

echo "== starting wifilt (unmodified native build) =="
"$WIFILT_BIN" --port "$HTTP_PORT" --data-dir "$ROOT/data" --config-dir "$WORK" \
  > "$WORK/app.log" 2>&1 &
APP_PID=$!
sleep 1
# First run overwrites radio-config.json with EEPROM-derived defaults; restore
# the "lan" pointer at local-trx before wifilt's own poll loop reads it back,
# same trick native-integration-test.sh does not need (its fake radio is
# python, started before this race matters) -- kept here since local-trx is
# still coming up in parallel with wifilt's own first-run bootstrap.
cp "$WORK/radio-config.json.bak" "$WORK/radio-config.json"

echo "== waiting for the LAN link =="
STATE=""
for _ in $(seq 1 20); do
  sleep 1
  STATE=$(curl -s -m 3 "http://127.0.0.1:$HTTP_PORT/state" 2>/dev/null)
  echo "$STATE" | grep -q '"catHealthy":true' && break
done

# CW-over-CI-V (bod 7/17, key_runner.h): set CW mode, wait for wifilt's own
# poll rotation to read it back (rig_set_mode is instant on the hamlib side,
# but wifilt's cached `modes` state only updates on its NEXT 0x04 poll -- a
# same-second sendCw would 409 "mode_cannot_key" against stale state, not a
# real bug), then send text. LoggingKeyLine (main.cpp) stands in for
# serial_key.h (blocked on libserialport-dev, see docs/local-trx-implementace.md);
# this checks the PTT/keying WIRING end to end, not real DTR/RTS timing --
# that needs the socat PTY test the Testy section describes, once
# serial_key.h exists.
echo "== CW-over-CI-V: setting mode CW =="
curl -s -m 3 -X POST "http://127.0.0.1:$HTTP_PORT/cmd" -H "Content-Type: application/json" \
  -d '{"type":"setMode","mode":"CW","filter":"FIL1"}' >/dev/null
# wifilt's own icomLanClient.h polls mode via a 16-step rotation at 100ms/step
# (auxRot, icomLanClient.h:541-556) -- civ_router.cpp only answers the legacy
# 0x04 fallback in that rotation (auxRot==2), not the preferred 0x26 0x00
# extended read (auxRot==1, which tools/icom-lan-fake-radio.py's own reference
# implementation does not answer either) -- so catching up can take a few
# rotations. 30s is a generous margin over the ~1.6s/rotation worst case.
MODE_OK=0
for _ in $(seq 1 30); do
  sleep 1
  curl -s -m 2 "http://127.0.0.1:$HTTP_PORT/state" 2>/dev/null | grep -q '"mode":"CW"' && { MODE_OK=1; break; }
done
[[ $MODE_OK -eq 1 ]] || echo "  (mode never caught up to CW -- sendCw below will 409, see local-trx.log)"
echo "== CW-over-CI-V: sending text =="
# Baseline BEFORE sending: the earlier PTT-check step above already produced
# its own [ptt] ON/off pair on this exact same log, so "count > 0" alone
# would trivially pass even if CW's own release did nothing -- track the
# delta instead.
PRE_CW_PTT_COUNT=$(grep -c '^\[ptt\] off$' "$WORK/local-trx.log")
curl -s -m 3 -X POST "http://127.0.0.1:$HTTP_PORT/cmd" -H "Content-Type: application/json" \
  -d '{"type":"sendCw","text":"TEST"}' >/dev/null
# PTTlead(400ms) + "TEST"'s dits/dahs + PTTtail(200ms) at cwWpm=20 is under 2s;
# poll instead of a fixed sleep so a slow/loaded CI runner does not flake.
for _ in $(seq 1 15); do
  sleep 1
  [[ $(grep -c '^\[ptt\] off$' "$WORK/local-trx.log") -gt $PRE_CW_PTT_COUNT ]] && break
done
CW_PTT_COUNT=$(grep -c '^\[ptt\] off$' "$WORK/local-trx.log")

# FSK-over-TrxNet (bod 15): wifilt's sendCw only reaches trxNetSendCwText()'s
# net.publishTo() once wifilt's OWN TrxNet has this process ("OI3.10") in its
# peer table -- learned from local-trx's one-shot startup broadcast probe
# (TrxNet::begin(), sent before wifilt's TrxNet was even listening in this
# script's own startup order) or, failing that, only on TrxNet's own ~30s
# periodic announce cycle (TRXNET_ANNOUNCE_MS). Confirmed live 2026-08-31:
# this is real TrxNet protocol behaviour, not a local-trx bug -- retry
# sendCw itself (its {"error":"mode_cannot_key"} is the same response for
# "wrong mode" and "peer not yet known"; mode is already confirmed RTTY
# below, so a retry here is purely waiting out peer discovery).
echo "== setting mode RTTY for FSK-over-TrxNet =="
curl -s -m 3 -X POST "http://127.0.0.1:$HTTP_PORT/cmd" -H "Content-Type: application/json" \
  -d '{"type":"setMode","mode":"RTTY","filter":"FIL1"}' >/dev/null
for _ in $(seq 1 30); do
  sleep 1
  curl -s -m 2 "http://127.0.0.1:$HTTP_PORT/state" 2>/dev/null | grep -q '"mode":"RTTY"' && break
done
echo "== FSK-over-TrxNet: sending text (retrying until the peer is discovered) =="
FSK_SENT=0
for _ in $(seq 1 40); do
  sleep 1
  RESP=$(curl -s -m 3 -X POST "http://127.0.0.1:$HTTP_PORT/cmd" -H "Content-Type: application/json" \
    -d '{"type":"sendCw","text":"RY"}')
  echo "$RESP" | grep -q '"ok":true' && { FSK_SENT=1; break; }
done
[[ $FSK_SENT -eq 1 ]] || echo "  (sendCw for FSK never succeeded -- see local-trx.log's [oi3] lines)"
for _ in $(seq 1 15); do
  sleep 1
  [[ $(grep -c '^\[ptt\] off$' "$WORK/local-trx.log") -gt $CW_PTT_COUNT ]] && break
done

echo
echo "== results =="
check "HTTP answers /state"          "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HTTP_PORT/state" | grep -q 200 && echo 1 || echo 0)"
check "catHealthy true"              "$(echo "$STATE" | grep -q '"catHealthy":true' && echo 1 || echo 0)"
check "lanStatus linked"             "$(echo "$STATE" | grep -q '"lanStatus":"linked"' && echo 1 || echo 0)"
check "frequency from hamlib Dummy"  "$(echo "$STATE" | grep -q '"frequency":145000000' && echo 1 || echo 0)"
check "synthetic identity, not a real model" "$(grep -q 'TRX1 reports model LOCAL-TRX' "$WORK/app.log" && echo 1 || echo 0)"
check "local-trx logged CONNECTED"   "$(grep -q '^CONNECTED$' "$WORK/local-trx.log" && echo 1 || echo 0)"
check "wifilt logged LAN CONNECTED"  "$(grep -q 'LAN | CONNECTED' "$WORK/app.log" && echo 1 || echo 0)"
check "CW 0x17 reached the keying subsystem (PTT ON)"  "$(grep -q '^\[ptt\] ON$' "$WORK/local-trx.log" && echo 1 || echo 0)"
check "CW keyed at least one dit/dah (KEY DOWN)"       "$(grep -q '^\[key\] DOWN$' "$WORK/local-trx.log" && echo 1 || echo 0)"
check "CW released PTT afterward"                      "$([[ $CW_PTT_COUNT -gt $PRE_CW_PTT_COUNT ]] && echo 1 || echo 0)"
check "wifilt's TrxNet discovered local-trx as OI3.10" "$([[ $FSK_SENT -eq 1 ]] && echo 1 || echo 0)"
check "FSK-over-TrxNet reached the /s-cw subscription" "$(grep -q '\[oi3\] <- /s-cw' "$WORK/local-trx.log" && echo 1 || echo 0)"
check "FSK keyed and released PTT"                     "$([[ $(grep -c '^\[ptt\] off$' "$WORK/local-trx.log") -gt $CW_PTT_COUNT ]] && echo 1 || echo 0)"
check "PTT (CI-V 0x1C) matches audioPttOn/Off's own bytes"    "$([[ $PTT_STATUS -eq 0 ]] && echo 1 || echo 0)"
check "CI-V extras: RF power/meters/ATT/VOX + transceive broadcast (fáze 7)" "$([[ $CIV_EXTRAS_STATUS -eq 0 ]] && echo 1 || echo 0)"
check "Setup wizard HTTP server: page + devices + config round-trip (fáze 6)" "$([[ $WIZARD_STATUS -eq 0 ]] && echo 1 || echo 0)"
if [[ $AUDIO_STATUS -eq 2 ]]; then
  echo "  SKIP RX+TX audio -- no capture/playback device in this environment"
else
  check "RX audio real + TX gap->retransmit, byte-exact wire format" "$([[ $AUDIO_STATUS -eq 0 ]] && echo 1 || echo 0)"
fi

echo
if [[ $FAILURES -eq 0 ]]; then
  echo "ALL OK"
  exit 0
else
  echo "$FAILURES check(s) failed"   # cleanup() above already decided $WORK's fate
  exit 1
fi
