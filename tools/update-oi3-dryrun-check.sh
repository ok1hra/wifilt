#!/usr/bin/env bash
#
# The web updater's OI3 phase, as a dry run against a local channel -- no root,
# nothing installed, nothing flashed.
#
#   tools/update-oi3-dryrun-check.sh
#
# Builds a fake release (an x86_64 archive with oi3/ firmware 20261112),
# writes latest.json with tools/update-manifest.sh, serves it on 127.0.0.1
# and runs native/update/wifilt-update.sh against it with the test overrides
# (WIFILT_UPDATE_*, WIFILT_PI_CONF, WIFILT_OI3_STATE). Checked:
#   - latest.json names the OI3 firmware the archive carries
#   - check.json tells the page: OI3 set up, installed vs. latest
#   - the update has an "oi3" phase between install and start
#   - older OI3 firmware -> "would flash"; same -> "up to date";
#     no pi-setup OI3 -> "no OI3 set up"; archive without oi3/ -> "carries no"
# A systemctl shim keeps the machine's own services out of it.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
HTTP_PID=""
cleanup() {
  [[ -n "$HTTP_PID" ]] && kill "$HTTP_PID" 2>/dev/null
  wait 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

PASS=0 FAIL=0
check() {  # check NAME CONDITION-EXIT-CODE [DETAIL]
  if [[ "$2" -eq 0 ]]; then PASS=$((PASS + 1)); echo "  ok   $1"
  else FAIL=$((FAIL + 1)); echo "  FAIL $1${3:+ -- $3}"; fi
}

REV_OLD=20261101 REV_NEW=20261112
mkdir -p "$WORK/bin" "$WORK/prefix" "$WORK/channel" "$WORK/pkg"

# systemctl shim: every service inactive, everything else succeeds.
cat > "$WORK/bin/systemctl" <<'EOF'
#!/bin/sh
[ "$1" = is-active ] && exit 3
[ "$1" = show ] && exit 0
exit 0
EOF
chmod +x "$WORK/bin/systemctl"

# The installed "version".
echo "$REV_OLD" > "$WORK/prefix/VERSION"
printf '#!/bin/sh\n' > "$WORK/prefix/wifilt"; chmod +x "$WORK/prefix/wifilt"

make_archive() {  # make_archive WITH_OI3(0/1)
  local d="$WORK/pkg/wifilt-linux-x86_64"
  rm -rf "$WORK/pkg"/* "$WORK/channel"/*
  mkdir -p "$d/data"
  printf '#!/bin/sh\n' > "$d/wifilt"; chmod +x "$d/wifilt"
  printf '#!/bin/sh\n' > "$d/install.sh"; chmod +x "$d/install.sh"
  echo "$REV_NEW" > "$d/VERSION"
  if [[ "$1" -eq 1 ]]; then
    mkdir -p "$d/oi3"
    echo ":00000001FF" > "$d/oi3/PCB_3_1415_oi3.ino.hex"
    echo ":00000001FF" > "$d/oi3/PCB_3_141_oi3.ino.hex"
    echo "$REV_NEW" > "$d/oi3/VERSION"
  fi
  tar czf "$WORK/channel/wifilt-$REV_NEW-linux-x86_64.tar.gz" -C "$WORK/pkg" wifilt-linux-x86_64
  "$ROOT/tools/update-manifest.sh" "$WORK/channel" "$REV_NEW" "$WORK/channel/latest.json" >/dev/null
}

PORT=$((20000 + RANDOM % 20000))
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$WORK/channel" >/dev/null 2>&1 &
HTTP_PID=$!
sleep 0.5

set_pi() {  # set_pi HAVE_OI3 INSTALLED_FW
  printf 'RUN_USER=nobody\nHAVE_OI3=%s\nOI3_REV=3_1415\nOI3_PORT=/dev/ttyUSB.cw\n' "$1" > "$WORK/setup.conf"
  if [[ -n "$2" ]]; then echo "abc123 def456 3_1415 $2" > "$WORK/oi3-flashed"; else rm -f "$WORK/oi3-flashed"; fi
}

run_updater() {  # run_updater ACTION [--dry-run] -> $WORK/state/
  rm -rf "$WORK/state"
  PATH="$WORK/bin:$PATH" \
  WIFILT_UPDATE_STATE="$WORK/state" WIFILT_UPDATE_PREFIX="$WORK/prefix" \
  WIFILT_UPDATE_BASE="http://127.0.0.1:$PORT/" \
  WIFILT_PI_CONF="$WORK/setup.conf" WIFILT_OI3_STATE="$WORK/oi3-flashed" \
    bash "$ROOT/native/update/wifilt-update.sh" "$@" > "$WORK/run.out" 2>&1
}

has()   { grep -F -- "$2" "$1" >/dev/null 2>&1; }
hasnt() { ! has "$@"; }
same()  { [[ "$1" == "$2" ]]; }

# -- manifest + check -----------------------------------------------------------
make_archive 1
has "$WORK/channel/latest.json" "\"oi3\": { \"fw\": \"$REV_NEW\" }"
check "latest.json names the OI3 firmware in the archive" $? "$(cat "$WORK/channel/latest.json")"

set_pi 1 20261031
run_updater check
has "$WORK/state/check.json" "\"oi3\":{\"have\":true,\"board\":\"3_1415\",\"installed\":\"20261031\",\"latest\":\"$REV_NEW\"}"
check "check.json: OI3 set up, installed 20261031, latest $REV_NEW" $? "$(cat "$WORK/state/check.json" 2>/dev/null)"

set_pi 0 ""
run_updater check
has "$WORK/state/check.json" '"oi3":null'
check "check.json: no OI3 set up -> null" $?

# -- update, dry run -------------------------------------------------------------
set_pi 1 20261031
run_updater update --dry-run
has "$WORK/state/status.json" '"phases":["check","download","verify","backup","stop","install","oi3","start","health","done"]'
check "the update has an oi3 phase between install and start" $? "$(grep -o '"phases":\[[^]]*\]' "$WORK/state/status.json")"
has "$WORK/state/update.log" "OI3 firmware 20261031 -> $REV_NEW (board 3.1415, /dev/ttyUSB.cw)"
check "older OI3 firmware: planned" $? "$(tail -n 5 "$WORK/state/update.log")"
has "$WORK/state/status.json" '"state":"done"'
check "  and the dry run finishes" $? "$(tail -n 3 "$WORK/run.out")"
same "$(cat "$WORK/oi3-flashed")" "abc123 def456 3_1415 20261031"
check "  a dry run does not touch pi-setup's record" $?

set_pi 1 "$REV_NEW"
run_updater update --dry-run
has "$WORK/state/update.log" "[oi3] OI3 firmware $REV_NEW is up to date"
check "same OI3 firmware: up to date" $? "$(grep -F '[oi3]' "$WORK/state/update.log")"

set_pi 0 ""
run_updater update --dry-run
has "$WORK/state/update.log" "[oi3] no OI3 set up on this machine"
check "no OI3 set up: skipped" $? "$(grep -F '[oi3]' "$WORK/state/update.log")"

set_pi 1 20261031
make_archive 0
run_updater update --dry-run
has "$WORK/state/update.log" "[oi3] the package carries no OI3 firmware for board 3.1415"
check "archive without oi3/: skipped" $? "$(grep -F '[oi3]' "$WORK/state/update.log")"
has "$WORK/state/status.json" '"state":"done"'
check "  and the update still finishes" $?
hasnt "$WORK/channel/latest.json" '"oi3"'
check "  latest.json without an oi3 key" $?

# -- "wifilt-update oi3": the firmware install.sh left in the prefix --------------
mkdir -p "$WORK/prefix/oi3"
echo ":00000001FF" > "$WORK/prefix/oi3/PCB_3_1415_oi3.ino.hex"
echo "20261112" > "$WORK/prefix/oi3/VERSION"
printf "RUN_USER=nobody\nHAVE_OI3=1\nOI3_REV=3_1415\nOI3_PORT=''\n" > "$WORK/setup.conf"   # as on wifilt-pi
echo "abc123 def456 3_1415 20261031" > "$WORK/oi3-flashed"
run_updater oi3 --dry-run
has "$WORK/state/oi3.log" "OI3 firmware 20261031 -> 20261112 (board 3.1415, /dev/ttyUSB.cw)"
check "oi3 command: planned from the prefix, OI3_PORT='' -> /dev/ttyUSB.cw" $? "$(cat "$WORK/state/oi3.log" 2>/dev/null; tail -3 "$WORK/run.out")"
hasnt "$WORK/state/status.json" '"phase"'
check "  and it leaves the page's status.json alone" $?
echo "abc123 def456 3_1415 20261112" > "$WORK/oi3-flashed"
run_updater oi3 --dry-run
has "$WORK/state/oi3.log" "[oi3] OI3 firmware 20261112 is up to date"
check "oi3 command: same firmware -> up to date" $?
run_updater oi3 --dry-run --force
has "$WORK/state/oi3.log" "OI3 firmware 20261112 -> 20261112"
check "oi3 --force: flashes the same firmware again" $?

echo "$PASS/$((PASS + FAIL)) checks passed"
[[ $FAIL -eq 0 ]]
