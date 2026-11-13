#!/usr/bin/env bash
#
# The web updater for real (not --dry-run), in a user namespace, against a
# local channel -- nothing on this machine is touched.
#
#   tools/update-rollback-check.sh
#
# What went wrong on 2026-11-13, each as a check:
#   - the wall clock jumps by hours during the health wait (a Pi without RTC
#     syncing NTP after the unlock reboot) -> the update still succeeds
#   - a package without local-trx, local-trx installed -> refused before
#     anything is stopped
#   - install.sh fails -> rollback puts the old files back AND enables the
#     units that were enabled before (install.sh had disabled local-trx)
# And the same-day release number (REV_BUILD):
#   - installed 20261113 (no BUILD file), offered 20261113.1 -> installed,
#     and the health wait insists on "build":1
#   - installed 20261113.1, offered 20261113.1 -> "not newer"
# Shims: systemctl (logs every call), date (+%s jumps 5000 s per call),
# setcap. Overrides: WIFILT_UPDATE_{STATE,PREFIX,BASE,UNIT_DIR,HTTP_PORT}.

set -uo pipefail

if [[ $(id -u) -ne 0 ]]; then
  exec unshare -r "$0" "$@"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  wait 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

PASS=0 FAIL=0
check() {
  if [[ "$2" -eq 0 ]]; then PASS=$((PASS + 1)); echo "  ok   $1"
  else FAIL=$((FAIL + 1)); echo "  FAIL $1${3:+ -- $3}"; fi
}
has()   { grep -F -- "$2" "$1" >/dev/null 2>&1; }
more()  { [[ "$1" -gt "$2" ]]; }
hasnt() { ! has "$@"; }

REV_OLD=20261112 REV_NEW=20261113
mkdir -p "$WORK/bin" "$WORK/units" "$WORK/channel" "$WORK/pkg"

cat > "$WORK/bin/systemctl" <<EOF
#!/bin/sh
echo "\$*" >> "$WORK/systemctl.log"
case "\$1" in
  is-active)  exit 0 ;;                       # wifilt and local-trx run
  is-enabled) exit 0 ;;                       # ...and start at boot
  show)       echo root; exit 0 ;;
esac
exit 0
EOF
# date +%s jumps 5000 s on every call, like an NTP sync after a reboot would
# once; anything else is the real date.
cat > "$WORK/bin/date" <<EOF
#!/bin/sh
if [ "\$1" = "+%s" ]; then
  n=\$(cat "$WORK/date.n" 2>/dev/null || echo 0); n=\$((n + 1)); echo \$n > "$WORK/date.n"
  echo \$(( \$(/bin/date +%s) + n * 5000 ))
else
  exec /bin/date "\$@"
fi
EOF
printf '#!/bin/sh\nexit 0\n' > "$WORK/bin/setcap"
chmod +x "$WORK/bin/"*

reset_prefix() {
  rm -rf "$WORK/prefix" "$WORK/prefix.prev"
  mkdir -p "$WORK/prefix/data"
  echo "$REV_OLD" > "$WORK/prefix/VERSION"
  printf '#!/bin/sh\n# old\n' > "$WORK/prefix/wifilt"
  printf '#!/bin/sh\n# old\n' > "$WORK/prefix/local-trx"
  chmod +x "$WORK/prefix/wifilt" "$WORK/prefix/local-trx"
  echo "[Service]" > "$WORK/units/wifilt.service"
  echo "[Service]" > "$WORK/units/local-trx.service"
  : > "$WORK/systemctl.log"
}

make_archive() {  # make_archive WITH_LTX INSTALL_EXIT [BUILD]
  local d="$WORK/pkg/wifilt-linux-x86_64" build="${3:-0}" version="$REV_NEW"
  (( build > 0 )) && version="$REV_NEW.$build"
  rm -rf "$WORK/pkg"/* "$WORK/channel"/*
  mkdir -p "$d/data"
  printf '#!/bin/sh\n# new\n' > "$d/wifilt"; chmod +x "$d/wifilt"
  [[ "$1" -eq 1 ]] && { printf '#!/bin/sh\n# new\n' > "$d/local-trx"; chmod +x "$d/local-trx"; }
  # install.sh: copies itself over the prefix, then exits as told.
  cat > "$d/install.sh" <<EOF
#!/bin/sh
here=\$(dirname "\$0")
prefix="\$2"
cp -f "\$here/wifilt" "\$here/VERSION" "\$here/BUILD" "\$prefix/"
exit $2
EOF
  chmod +x "$d/install.sh"
  echo "$REV_NEW" > "$d/VERSION"
  echo "$build" > "$d/BUILD"
  tar czf "$WORK/channel/wifilt-$version-linux-x86_64.tar.gz" -C "$WORK/pkg" wifilt-linux-x86_64
  "$ROOT/tools/update-manifest.sh" "$WORK/channel" "$version" "$WORK/channel/latest.json" >/dev/null
}

CH_PORT=$((20000 + RANDOM % 10000))
python3 -m http.server "$CH_PORT" --bind 127.0.0.1 --directory "$WORK/channel" >/dev/null 2>&1 &
PIDS+=("$!")
# The "new wifilt": /health.json with the new REV, answering only after 3 s.
HP=$((30000 + RANDOM % 10000))
mkdir -p "$WORK/health"
echo "{\"rev\":\"$REV_NEW\"}" > "$WORK/health/health.json"
sleep 0.5

run_updater() {
  rm -rf "$WORK/state"
  PATH="$WORK/bin:$PATH" \
  WIFILT_UPDATE_STATE="$WORK/state" WIFILT_UPDATE_PREFIX="$WORK/prefix" \
  WIFILT_UPDATE_BASE="http://127.0.0.1:$CH_PORT/" WIFILT_UPDATE_UNIT_DIR="$WORK/units" \
  WIFILT_UPDATE_HTTP_PORT="$HP" \
  WIFILT_PI_CONF="$WORK/none.conf" WIFILT_OI3_STATE="$WORK/none" \
    bash "${UPDATER:-$ROOT/native/update/wifilt-update.sh}" update > "$WORK/run.out" 2>&1
}

# -- 1. clock jumps during the health wait ----------------------------------------
reset_prefix
make_archive 1 0
( sleep 3; exec python3 -m http.server "$HP" --bind 127.0.0.1 --directory "$WORK/health" ) >/dev/null 2>&1 &
PIDS+=("$!")
run_updater
has "$WORK/state/status.json" '"state":"done"'
check "the wall clock jumping by hours does not fail the health wait" $? \
  "$(grep -o '"error":"[^"]*"' "$WORK/state/status.json"); $(tail -n 3 "$WORK/state/update.log")"
more "$(cat "$WORK/date.n" 2>/dev/null || echo 0)" 3
check "  (date +%s really was called and jumped)" $?
has "$WORK/prefix/VERSION" "$REV_NEW"
check "  new version installed" $?

# -- 2. package without local-trx, local-trx installed -----------------------------
reset_prefix
make_archive 0 0
run_updater
has "$WORK/state/status.json" 'the package has no local-trx, but local-trx is installed here'
check "a package without local-trx is refused when local-trx is installed" $? \
  "$(grep -o '"error":"[^"]*"' "$WORK/state/status.json")"
hasnt "$WORK/systemctl.log" "stop"
check "  before anything is stopped" $?
has "$WORK/prefix/VERSION" "$REV_OLD"
check "  the old version stays" $?

# -- 3. install.sh fails -> rollback restores enablement ---------------------------
reset_prefix
make_archive 1 1
run_updater
has "$WORK/state/status.json" '"error":"install.sh failed"'
check "install.sh fails -> failed" $?
has "$WORK/prefix/VERSION" "$REV_OLD" && has "$WORK/prefix/wifilt" "# old"
check "  rollback puts the old files back" $?
has "$WORK/systemctl.log" "enable local-trx.service" && has "$WORK/systemctl.log" "enable wifilt.service"
check "  and enables the units that were enabled before" $? "$(tr '\n' ';' < "$WORK/systemctl.log")"
has "$WORK/systemctl.log" "start wifilt" && has "$WORK/systemctl.log" "start local-trx"
check "  and starts both again" $?

# -- 4. a second release the same day ---------------------------------------------
reset_prefix
echo "$REV_NEW" > "$WORK/prefix/VERSION"          # today's first release, no BUILD file
make_archive 1 0 1
has "$WORK/channel/latest.json" "\"rev\": \"$REV_NEW\", \"build\": 1, \"version\": \"$REV_NEW.1\""
check "latest.json: rev stays 8 digits, build and version beside it" $? "$(head -3 "$WORK/channel/latest.json")"
echo "{\"platform\":\"linux\",\"rev\":\"$REV_NEW\",\"build\":0,\"homeHttp\":80}" > "$WORK/health/health.json"
( sleep 4; echo "{\"platform\":\"linux\",\"rev\":\"$REV_NEW\",\"build\":1,\"homeHttp\":80}" > "$WORK/health/health.json" ) &
run_updater
has "$WORK/state/status.json" '"state":"done"'
check "installed $REV_NEW, offered $REV_NEW.1 -> updated" $? \
  "$(grep -o '"error":"[^"]*"' "$WORK/state/status.json"); $(tail -n 3 "$WORK/state/update.log")"
has "$WORK/state/status.json" "\"from\":\"$REV_NEW\",\"to\":\"$REV_NEW.1\""
check "  status says $REV_NEW -> $REV_NEW.1" $? "$(grep -o '"from":"[^"]*","to":"[^"]*"' "$WORK/state/status.json")"
# /health.json says build 0 for the first 4 s: the wait must outlast that.
secs() { local t; t="$(grep -F "$1" "$WORK/state/update.log" | head -1 | cut -c1-8)"; [[ -n "$t" ]] && date -d "$t" +%s; }
h0="$(secs "[health]")"; h1="$(secs "WIFILT $REV_NEW.1 answers")"
more "$(( ${h1:-0} - ${h0:-0} ))" 2
check "  the health wait waited for build 1, not just the date" $? "health at ${h0:-?}, answered at ${h1:-?}"
has "$WORK/prefix/BUILD" "1"
check "  BUILD installed" $?

make_archive 1 0 1
run_updater
has "$WORK/state/status.json" "$REV_NEW.1 is not newer than the installed $REV_NEW.1"
check "installed $REV_NEW.1, offered $REV_NEW.1 -> not newer" $? "$(grep -o '"error":"[^"]*"' "$WORK/state/status.json")"
run_updater_check() {
  PATH="$WORK/bin:$PATH" WIFILT_UPDATE_STATE="$WORK/state" WIFILT_UPDATE_PREFIX="$WORK/prefix" \
  WIFILT_UPDATE_BASE="http://127.0.0.1:$CH_PORT/" WIFILT_PI_CONF="$WORK/none.conf" \
    bash "${UPDATER:-$ROOT/native/update/wifilt-update.sh}" check > "$WORK/run.out" 2>&1
}
run_updater_check
has "$WORK/state/check.json" "\"rev\":\"$REV_NEW\",\"build\":1,\"version\":\"$REV_NEW.1\",\"installed\":\"$REV_NEW\",\"installedBuild\":1,\"installedVersion\":\"$REV_NEW.1\""
check "check.json carries build and both versions" $? "$(cat "$WORK/state/check.json")"

echo "$PASS/$((PASS + FAIL)) checks passed"
[[ $FAIL -eq 0 ]]
