#!/usr/bin/env bash
# wifilt-update -- updates an installed WIFILT (Linux, x86_64 or Raspberry Pi)
# to the newest published build, reporting every step to the web interface.
#
#   wifilt-update check               fetch latest.json, write check.json
#   wifilt-update update [--dry-run]  download, verify, install, restart, check
#   wifilt-update --from-request      what wifilt-update.service runs: reads
#                                     req/request.json written by wifilt
#
# Why a separate root program: the wifilt service runs as an ordinary user and
# installing (/opt/wifilt, setcap, systemd units, unlocking a locked Pi) needs
# root. wifilt therefore only drops a request file into a directory it owns;
# wifilt-update.path notices it and starts this script as root. The request is
# untrusted input: only the action name and an id are taken from it. Version,
# URL and paths always come from the configured channel and from this host --
# the web interface can ask for "update to the newest official build" and for
# nothing else.
#
# Progress goes to status.json (atomic tmp+mv), which wifilt serves as
# /update/status. It lives on disk, so it survives the wifilt restart in the
# middle of the update -- the page reconnects and carries on.
#
# On failure after the old version was stopped, the previous installation is
# restored from $PREFIX.prev and started again.

set -uo pipefail
umask 022

SELF_NAME="wifilt-update"
CONF=/etc/wifilt-update.conf
STATE_DIR="${WIFILT_UPDATE_STATE:-/var/lib/wifilt-update}"
REQ_DIR="$STATE_DIR/req"
STATUS="$STATE_DIR/status.json"
CHECK="$STATE_DIR/check.json"
LOG="$STATE_DIR/update.log"
DL_DIR="$STATE_DIR/dl"
LOCK="$STATE_DIR/lock"
DEFAULT_BASE="https://ok1hra.github.io/wifilt/"

PREFIX=/opt/wifilt
RUN_USER=""
# shellcheck disable=SC1090
[[ -r "$CONF" ]] && . "$CONF"
PREFIX="${WIFILT_UPDATE_PREFIX:-$PREFIX}"

# The extension mark, assembled so this script itself never contains it: the
# page publisher refuses any public archive in which the literal appears.
EDITION_MARK="WIFILT-""ADDONS"

DRY_RUN=0
REQ_ID=""

die_usage() { sed -n '2,8p' "$0" | sed 's/^# \?//'; exit 2; }

# ---------------------------------------------------------------- helpers ---

now() { date +%s; }

# Seconds since boot. Every timeout is measured with this, never with the wall
# clock: a Raspberry Pi has no RTC, comes back from the unlock reboot with the
# time it saved before (hours old) and jumps when NTP syncs -- with date +%s
# that jump made a 90 s health wait "expire" after a few seconds (2026-11-13).
uptime_s() { local u; read -r u _ < /proc/uptime; echo "${u%%.*}"; }

json_str() {  # json_str TEXT -> "escaped"
  local s
  s="$(printf '%s' "$1" | tr -d '\000-\010\013-\037')"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\t'/ }"; s="${s//$'\n'/ }"
  printf '"%s"' "$s"
}

log() {
  local line
  line="$(date '+%H:%M:%S') $*"
  printf '%s\n' "$line" >> "$LOG"
  printf '%s\n' "$line"
}

platform_id() {
  case "$(uname -m)" in
    x86_64|amd64)  echo linux-x86_64 ;;
    aarch64|arm64) echo linux-arm64 ;;
    *)             echo "linux-$(uname -m)" ;;
  esac
}

installed_rev() {
  local v=""
  [[ -r "$PREFIX/VERSION" ]] && v="$(tr -dc '0-9' < "$PREFIX/VERSION")"
  echo "$v"
}

# Same-day release number (REV_BUILD in wifilt.ino, file BUILD next to
# VERSION); 0 for the first release of a day and for packages from before it.
# VERSION itself stays the 8-digit date: updaters older than this read exactly
# eight digits there.
installed_build() {
  local b=""
  [[ -r "$PREFIX/BUILD" ]] && b="$(tr -dc '0-9' < "$PREFIX/BUILD")"
  echo "$((10#${b:-0}))"
}

# version_str REV BUILD -> "20261113" or "20261113.1"
version_str() { if [[ -n "$1" && "${2:-0}" -gt 0 ]]; then echo "$1.$2"; else echo "$1"; fi; }

installed_version() { version_str "$(installed_rev)" "$(installed_build)"; }

# newer REV BUILD THAN_REV THAN_BUILD -> 0 when the first is newer
newer() {
  (( 10#$1 > 10#$3 )) && return 0
  (( 10#$1 == 10#$3 && ${2:-0} > ${4:-0} ))
}

run_user() {
  if [[ -n "$RUN_USER" ]]; then echo "$RUN_USER"; return; fi
  systemctl show -p User --value wifilt 2>/dev/null || true
}

user_home() { getent passwd "$1" 2>/dev/null | cut -d: -f6; }

# The ports wifilt may answer on, as a list: 80, 8080 (where it moves when it
# cannot bind 80), and whatever ~/.config/wifilt/http-port says. That file is
# NOT the port wifilt listens on: it is the "home" port, where the browser
# keeps the QSO log, and it keeps the first port the configuration ever served
# on (native/main.cpp rememberHttpPort). A Pi that ran on 8080 before setcap
# keeps 8080 there while wifilt is on 80 -- taking it for the listener made
# every health check of the 2026-11-13 updates wait 90 s on a dead port.
http_ports() {
  [[ -n "${WIFILT_UPDATE_HTTP_PORT:-}" ]] && { echo "$WIFILT_UPDATE_HTTP_PORT"; return; }   # tests only
  local u h p="" out="80 8080"
  u="$(run_user)"; h="$(user_home "$u")"
  [[ -n "$h" && -r "$h/.config/wifilt/http-port" ]] && p="$(tr -dc '0-9' < "$h/.config/wifilt/http-port")"
  [[ -n "$p" && " $out " != *" $p "* ]] && out="$out $p"
  echo "$out"
}

is_locked_pi() { [[ "$(findmnt -no FSTYPE / 2>/dev/null)" == overlay ]]; }

mode_id() {
  # Testing override, for dry runs of the locked-Pi phases on a PC.
  if [[ -n "${WIFILT_UPDATE_MODE:-}" && $DRY_RUN -eq 1 ]]; then echo "$WIFILT_UPDATE_MODE"; return; fi
  if [[ -f /etc/wifilt-pi/setup.conf ]]; then
    if is_locked_pi; then echo pi-locked; else echo pi; fi
  else
    echo systemd
  fi
}

# --------------------------------------------------------------- channel ---
# $PREFIX/update-channel.conf (shipped in the archive), KEY=VALUE lines:
#   KIND=pages            BASE=<url ending in />    (default: the public page)
#   KIND=gh-release       REPO=<owner/name>  TOKEN=required|none
# Parsed, not sourced: it comes from a download.

CH_KIND=pages CH_BASE="$DEFAULT_BASE" CH_REPO="" CH_TOKEN=none
load_channel() {
  local f="$PREFIX/update-channel.conf" k v
  if [[ -r "$f" ]]; then
    while IFS='=' read -r k v; do
      v="${v%$'\r'}"
      case "$k" in
        KIND)  [[ "$v" =~ ^(pages|gh-release)$ ]] && CH_KIND="$v" ;;
        BASE)  [[ "$v" =~ ^https?://[A-Za-z0-9._:/~-]+/$ ]] && CH_BASE="$v" ;;
        REPO)  [[ "$v" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] && CH_REPO="$v" ;;
        TOKEN) [[ "$v" =~ ^(required|none)$ ]] && CH_TOKEN="$v" ;;
      esac
    done < "$f"
  fi
  # Testing override (a local http.server with an N+1 archive); never set by
  # the units.
  if [[ -n "${WIFILT_UPDATE_BASE:-}" ]]; then CH_KIND=pages; CH_BASE="$WIFILT_UPDATE_BASE"; fi
}

channel_token() {
  local h; h="$(user_home "$(run_user)")"
  [[ -n "$h" && -r "$h/.config/wifilt/update-token" ]] && tr -d ' \r\n' < "$h/.config/wifilt/update-token"
}

CURL=(curl -fsSL --connect-timeout 20 --retry 3 --retry-delay 2)

# fetch_latest OUT -- latest.json of the channel into OUT
GH_ASSETS=""   # gh-release: "name<TAB>api-url" lines of the latest release
fetch_latest() {
  local out="$1" tok
  if [[ "$CH_KIND" == pages ]]; then
    "${CURL[@]}" -o "$out" "${CH_BASE}latest.json"
    return
  fi
  [[ -n "$CH_REPO" ]] || { echo "channel has no REPO" >&2; return 1; }
  command -v python3 >/dev/null || { echo "python3 is needed for this channel" >&2; return 1; }
  tok="$(channel_token)"
  if [[ "$CH_TOKEN" == required && -z "$tok" ]]; then echo "TOKEN_MISSING" >&2; return 3; fi
  local hdr=(-H "Accept: application/vnd.github+json")
  [[ -n "$tok" ]] && hdr+=(-H "Authorization: Bearer $tok")
  local rel="$DL_DIR/release.json"
  "${CURL[@]}" "${hdr[@]}" -o "$rel" "https://api.github.com/repos/${CH_REPO}/releases/latest" || return 1
  GH_ASSETS="$(python3 -I -c 'import json,sys
for a in json.load(open(sys.argv[1])).get("assets",[]):
    print(a["name"]+"\t"+a["url"])' "$rel")" || return 1
  local url; url="$(printf '%s\n' "$GH_ASSETS" | awk -F'\t' '$1=="latest.json"{print $2}')"
  [[ -n "$url" ]] || { echo "release has no latest.json" >&2; return 1; }
  gh_download "$url" "$out"
}

gh_download() {  # gh_download API_URL OUT [extra curl args...]
  local url="$1" out="$2"; shift 2
  local tok; tok="$(channel_token)"
  local hdr=(-H "Accept: application/octet-stream")
  [[ -n "$tok" ]] && hdr+=(-H "Authorization: Bearer $tok")
  curl -fL --connect-timeout 20 --retry 3 "${hdr[@]}" "$@" -o "$out" "$url"
}

asset_url() {  # asset_url NAME
  if [[ "$CH_KIND" == pages ]]; then echo "${CH_BASE}$1"; return; fi
  printf '%s\n' "$GH_ASSETS" | awk -F'\t' -v n="$1" '$1==n{print $2}'
}

# latest.json is written by tools/update-manifest.sh, one asset per line.
manifest_rev()   { sed -n 's/.*"rev": *"\([0-9]\{8\}\)".*/\1/p' "$1" | head -n1; }
manifest_build() {  # 0 for a latest.json from before REV_BUILD
  local b
  b="$(sed -n 's/.*"build": *\([0-9]\{1,4\}\).*/\1/p' "$1" | head -n1)"
  echo "$((10#${b:-0}))"
}
manifest_oi3()   { sed -n 's/.*"oi3": *{ *"fw": *"\([0-9]\{8\}\)".*/\1/p' "$1" | head -n1; }
manifest_field() {  # manifest_field FILE PLATFORM name|size|sha256
  local line
  line="$(grep -F "\"$2\":" "$1" | head -n1)"
  case "$3" in
    size) printf '%s' "$line" | sed -n 's/.*"size": *\([0-9]*\).*/\1/p' ;;
    *)    printf '%s' "$line" | sed -n "s/.*\"$3\": *\"\\([A-Za-z0-9._-]*\\)\".*/\\1/p" ;;
  esac
}

# ---------------------------------------------------------------- status ---

PHASES=()
WEIGHTS=()
PH_IDX=0 PH_PCT=0
ST_STATE=idle ST_MSG="" ST_ERR="" ST_FROM="" ST_TO="" ST_BYTES=0 ST_TOTAL=0
# ST_FROM / ST_TO are versions for people ("20261113.1"); TO_REV / TO_BUILD
# are what the package and the new wifilt are checked against.
TO_REV="" TO_BUILD=0
ST_STARTED=0 ST_MODE=""

set_phases() {
  case "$1" in
    pi-locked)
      PHASES=(check download verify unlock backup stop install oi3 start health relock "done")
      WEIGHTS=(2 25 6 10 3 3 15 5 4 12 15 0) ;;
    *)
      PHASES=(check download verify backup stop install oi3 start health "done")
      WEIGHTS=(2 35 8 5 5 20 5 5 15 0) ;;
  esac
}

overall_pct() {
  local i sum=0 done_w=0
  for i in "${!WEIGHTS[@]}"; do sum=$((sum + WEIGHTS[i])); done
  for ((i = 0; i < PH_IDX && i < ${#WEIGHTS[@]}; i++)); do done_w=$((done_w + WEIGHTS[i])); done
  done_w=$((done_w * 100 + ${WEIGHTS[PH_IDX]:-0} * PH_PCT))
  (( sum > 0 )) || sum=1
  local p=$((done_w / sum))
  [[ "$ST_STATE" == "done" ]] && p=100
  (( p > 100 )) && p=100
  echo "$p"
}

write_status() {
  local tmp="$STATUS.tmp" ph="" i first=1
  for i in "${PHASES[@]}"; do
    [[ $first -eq 1 ]] && first=0 || ph+=","
    ph+="\"$i\""
  done
  local lg="" line
  first=1
  if [[ -r "$LOG" ]]; then
    while IFS= read -r line; do
      [[ $first -eq 1 ]] && first=0 || lg+=","
      lg+="$(json_str "$line")"
    done < <(tail -n 30 "$LOG")
  fi
  {
    printf '{"id":%s,"from":"%s","to":"%s","platform":"%s","mode":"%s",' \
      "$(json_str "$REQ_ID")" "$ST_FROM" "$ST_TO" "$(platform_id)" "$ST_MODE"
    printf '"state":"%s","dry":%d,"phase":"%s","phaseIdx":%d,"phases":[%s],' \
      "$ST_STATE" "$DRY_RUN" "${PHASES[PH_IDX]:-}" "$PH_IDX" "$ph"
    printf '"phasePct":%d,"pct":%d,"bytes":%d,"total":%d,' \
      "$PH_PCT" "$(overall_pct)" "$ST_BYTES" "$ST_TOTAL"
    printf '"msg":%s,"error":%s,"startedAt":%d,"ts":%d,"log":[%s]}\n' \
      "$(json_str "$ST_MSG")" "$(json_str "$ST_ERR")" "$ST_STARTED" "$(now)" "$lg"
  } > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$STATUS"
}

phase() {  # phase NAME MESSAGE
  local i
  for i in "${!PHASES[@]}"; do [[ "${PHASES[i]}" == "$1" ]] && PH_IDX=$i; done
  PH_PCT=0; ST_MSG="$2"
  log "[$1] $2"
  write_status
}

progress() { PH_PCT="$1"; [[ $# -gt 1 ]] && ST_MSG="$2"; write_status; }

cancel_requested() { [[ -e "$REQ_DIR/cancel" ]]; }

fail() {
  ST_STATE=failed; ST_ERR="$1"
  log "ERROR: $1"
  write_status
}

# ----------------------------------------------------------------- check ---

do_check() {
  load_channel
  mkdir -p "$DL_DIR"
  local tmp="$DL_DIR/latest.json" err="" rc=0 rev="" build=0 name="" size=0 sum=""
  fetch_latest "$tmp" 2> "$DL_DIR/check.err" || rc=$?
  if [[ $rc -eq 0 ]]; then
    rev="$(manifest_rev "$tmp")"
    build="$(manifest_build "$tmp")"
    name="$(manifest_field "$tmp" "$(platform_id)" name)"
    size="$(manifest_field "$tmp" "$(platform_id)" size)"
    sum="$(manifest_field "$tmp" "$(platform_id)" sha256)"
    [[ -n "$rev" ]] || err="latest.json without rev"
    [[ -z "$err" && -z "$name" ]] && err="no build for $(platform_id) in REV $rev"
  elif [[ $rc -eq 3 ]]; then
    err="token-missing"
  else
    err="$(tail -n1 "$DL_DIR/check.err" 2>/dev/null)"; err="${err:-download failed}"
  fi
  local out="$CHECK.tmp" oi3="null"
  # The page shows whether the update also brings the OI3 new firmware. Only
  # this root program can read pi-setup's answers (mode 600).
  if oi3_configured; then
    oi3="$(printf '{"have":true,"board":"%s","installed":"%s","latest":"%s"}' \
      "$OI3_REV_CONF" "$(oi3_installed_fw)" "$([[ $rc -eq 0 ]] && manifest_oi3 "$tmp")")"
  fi
  # rev / installed stay the 8-digit dates older pages compare; build and the
  # version strings carry the same-day release number.
  printf '{"rev":"%s","build":%d,"version":"%s","installed":"%s","installedBuild":%d,"installedVersion":"%s","platform":"%s","asset":%s,"size":%d,"sha256":"%s","channel":"%s","tokenNeeded":%s,"oi3":%s,"checkedAt":%d,"error":%s}\n' \
    "$rev" "$build" "$(version_str "$rev" "$build")" \
    "$(installed_rev)" "$(installed_build)" "$(installed_version)" \
    "$(platform_id)" "$(json_str "$name")" "${size:-0}" "$sum" \
    "$CH_KIND" "$([[ "$CH_TOKEN" == required ]] && echo true || echo false)" \
    "$oi3" "$(now)" "$(json_str "$err")" > "$out"
  chmod 644 "$out"; mv -f "$out" "$CHECK"
  [[ -z "$err" ]]
}

# ------------------------------------------------------------------- OI3 ---
# A Raspberry Pi set up by pi-setup with "Open Interface III firmware" has the
# OI3 on a USB serial port. The arm64 package carries prebuilt images of its
# firmware (oi3/, made by tools/build-oi3-hex.sh), so an update brings the
# board up to date in the same run -- without the toolchain and the minutes of
# compiling that pi-setup step 5 needs. Flashed between install and start,
# while wifilt and local-trx are stopped and the port is free. Never fatal: the
# new wifilt works with the old OI3 firmware, and the board's bootloader
# survives a failed upload, so the next update simply tries again.

PI_CONF="${WIFILT_PI_CONF:-/etc/wifilt-pi/setup.conf}"
OI3_STATE="${WIFILT_OI3_STATE:-/var/lib/wifilt-pi/oi3-flashed}"
OI3_REV_CONF="" OI3_PORT_CONF="" OI3_WARN=""

# One KEY=value line of pi-setup's answers (written with printf %q; the values
# read here are plain words and paths). Parsed rather than sourced.
conf_value() {
  sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n1
}

# true when pi-setup flashed an OI3 here; sets OI3_REV_CONF / OI3_PORT_CONF
oi3_configured() {
  [[ -r "$PI_CONF" ]] || return 1
  [[ "$(conf_value "$PI_CONF" HAVE_OI3)" == 1 ]] || return 1
  OI3_REV_CONF="$(conf_value "$PI_CONF" OI3_REV)"
  OI3_PORT_CONF="$(conf_value "$PI_CONF" OI3_PORT)"
  [[ "$OI3_REV_CONF" == 3_1415 || "$OI3_REV_CONF" == 3_141 ]] || return 1
  [[ -n "$OI3_PORT_CONF" ]]
}

# the firmware REV last flashed from this Pi (4th field of pi-setup's record)
oi3_installed_fw() {
  local fw=""
  [[ -r "$OI3_STATE" ]] && read -r _ _ _ fw < "$OI3_STATE"
  printf '%s' "$fw" | tr -dc '0-9'
}

oi3_skip() {
  log "[oi3] $1"
  progress 100 "$1"
}

oi3_warn() {
  OI3_WARN="$1"
  log "WARNING: $1"
  progress 100 "$1"
}

oi3_flash() {  # oi3_flash PKG -- always returns 0
  local pkg="$1" new inst hex port dev u rc=0
  phase oi3 "checking the OI3 firmware"
  if ! oi3_configured; then oi3_skip "no OI3 set up on this machine"; return 0; fi
  new="$(tr -dc '0-9' < "$pkg/oi3/VERSION" 2>/dev/null)"
  hex="$pkg/oi3/PCB_${OI3_REV_CONF}_oi3.ino.hex"
  if [[ -z "$new" || ! -s "$hex" ]]; then
    oi3_skip "the package carries no OI3 firmware for board ${OI3_REV_CONF//_/.}"; return 0
  fi
  inst="$(oi3_installed_fw)"
  if [[ -n "$inst" && "$new" -le "$inst" ]]; then
    oi3_skip "OI3 firmware $inst is up to date"; return 0
  fi
  port="$OI3_PORT_CONF"
  log "OI3 firmware ${inst:-unknown} -> $new (board ${OI3_REV_CONF//_/.}, $port)"
  if [[ $DRY_RUN -eq 1 ]]; then
    progress 50 "dry run: would flash OI3 firmware $new to $port"
    sleep 2
    progress 100 "dry run: OI3 not flashed"
    return 0
  fi
  [[ -e "$port" ]] || { oi3_warn "$port does not exist -- the OI3 keeps its firmware ${inst:-}"; return 0; }
  dev="$(readlink -f "$port")"
  if fuser "$dev" >/dev/null 2>&1; then
    oi3_warn "$port is used by another program -- the OI3 keeps its firmware ${inst:-}"; return 0
  fi
  progress 20 "flashing OI3 firmware $new to $port (about half a minute)"
  u="$(run_user)"
  if command -v arduino-cli >/dev/null 2>&1 && [[ -n "$u" ]]; then
    # As the station user: pi-setup installed the arduino:avr core in its ~/.arduino15.
    runuser -u "$u" -- arduino-cli upload -b arduino:avr:mega -p "$port" --input-file "$hex" \
      >> "$LOG" 2>&1 || rc=$?
  elif command -v avrdude >/dev/null 2>&1; then
    avrdude -p atmega2560 -c wiring -P "$port" -b 115200 -D -U "flash:w:$hex:i" >> "$LOG" 2>&1 || rc=$?
  else
    oi3_warn "neither arduino-cli nor avrdude is installed -- the OI3 keeps its firmware ${inst:-}"
    return 0
  fi
  if [[ $rc -ne 0 ]]; then
    oi3_warn "flashing the OI3 failed (exit $rc) -- it keeps its firmware ${inst:-}; replug its USB and update again, or run pi-setup step 5"
    return 0
  fi
  install -d -m 755 "$(dirname "$OI3_STATE")"
  echo "pkg-$ST_TO - $OI3_REV_CONF $new" > "$OI3_STATE"
  log "OI3 firmware $new flashed to $port"
  progress 100 "OI3 firmware $new flashed"
  return 0
}

# ---------------------------------------------------------------- update ---

PREV="$PREFIX.prev"
UNIT_DIR="${WIFILT_UPDATE_UNIT_DIR:-/etc/systemd/system}"   # override: tests only
WAS_ACTIVE=()

svc_active() { systemctl is-active --quiet "$1" 2>/dev/null; }

restore_previous() {
  [[ -d "$PREV" ]] || { log "no previous installation to restore"; return 1; }
  log "restoring the previous installation from $PREV"
  systemctl stop wifilt local-trx 2>/dev/null || true
  rm -rf "$PREFIX" && mv "$PREV" "$PREFIX" || return 1
  local u
  for u in wifilt.service local-trx.service; do
    [[ -f "$STATE_DIR/units/$u" ]] && cp -f "$STATE_DIR/units/$u" "$UNIT_DIR/$u"
  done
  setcap cap_net_bind_service=+ep "$PREFIX/wifilt" 2>/dev/null || true
  systemctl daemon-reload
  for u in wifilt.service local-trx.service; do
    if [[ -f "$STATE_DIR/units/$u.enabled" ]]; then
      systemctl enable "$u" >/dev/null 2>&1 || log "cannot enable $u again"
    elif [[ -f "$STATE_DIR/units/$u" ]]; then
      systemctl disable "$u" >/dev/null 2>&1 || true
    fi
  done
  local s
  for s in "${WAS_ACTIVE[@]}"; do systemctl start "$s" || true; done
}

# health_is BODY REV BUILD -> 0 when /health.json is that version. A wifilt
# from before REV_BUILD reports no "build" at all, which counts as 0.
health_is() {
  local body="$1" rev="$2" build="${3:-0}"
  [[ "$body" == *"\"rev\":\"$rev\""* || "$body" == *"\"rev\":$rev,"* ]] || return 1
  if [[ "$body" == *"\"build\":"* ]]; then
    [[ "$body" == *"\"build\":$build,"* || "$body" == *"\"build\":$build}"* ]]
  else
    [[ "$build" -eq 0 ]]
  fi
}

wait_health() {  # wait_health REV BUILD SECONDS -> 0 when /health.json reports that version
  local rev="$1" build="$2" limit="$3" ports port t0 body
  ports="$(http_ports)"; t0="$(uptime_s)"
  while (( $(uptime_s) - t0 < limit )); do
    for port in $ports; do
      body="$(curl -fsS --max-time 2 "http://127.0.0.1:${port}/health.json" 2>/dev/null || true)"
      if health_is "$body" "$rev" "$build"; then
        log "WIFILT $(version_str "$rev" "$build") answers on port $port"
        return 0
      fi
    done
    progress $(( ($(uptime_s) - t0) * 100 / limit )) "waiting for WIFILT $(version_str "$rev" "$build") (ports ${ports// /, })"
    sleep 1
  done
  return 1
}

do_update() {
  ST_MODE="$(mode_id)"
  set_phases "$ST_MODE"
  ST_STATE=running ST_STARTED="$(now)" ST_FROM="$(installed_version)" ST_ERR=""
  rm -f "$REQ_DIR/cancel"
  : > "$LOG"
  log "----- $SELF_NAME $(date -Iseconds) mode=$ST_MODE dry=$DRY_RUN -----"

  # check
  phase check "looking for the newest build"
  load_channel
  mkdir -p "$DL_DIR"
  if ! do_check; then fail "check failed: $(sed -n 's/.*"error":"\([^"]*\)".*/\1/p' "$CHECK")"; return 1; fi
  local latest="$DL_DIR/latest.json" plat name size sum
  plat="$(platform_id)"
  TO_REV="$(manifest_rev "$latest")"
  TO_BUILD="$(manifest_build "$latest")"
  ST_TO="$(version_str "$TO_REV" "$TO_BUILD")"
  name="$(manifest_field "$latest" "$plat" name)"
  size="$(manifest_field "$latest" "$plat" size)"
  sum="$(manifest_field "$latest" "$plat" sha256)"
  if [[ ! "$sum" =~ ^[0-9a-f]{64}$ ]]; then fail "latest.json has no valid SHA256 for $plat"; return 1; fi
  if [[ $DRY_RUN -eq 0 && -n "$(installed_rev)" ]] \
     && ! newer "$TO_REV" "$TO_BUILD" "$(installed_rev)" "$(installed_build)"; then
    fail "$ST_TO is not newer than the installed $ST_FROM"; return 1
  fi
  log "installed ${ST_FROM:-?}, newest $ST_TO ($name, $size B)"

  # download
  phase download "downloading $name"
  local file="$DL_DIR/$name" url
  rm -f "$DL_DIR"/wifilt-*.tar.gz "$DL_DIR"/wifilt-*.zip
  url="$(asset_url "$name")"
  [[ -n "$url" ]] || { fail "no download URL for $name"; return 1; }
  ST_TOTAL="${size:-0}" ST_BYTES=0
  # A dry run is for trying the page out; pace it so the progress bar is seen.
  local pace=()
  [[ $DRY_RUN -eq 1 ]] && pace=(--limit-rate 1M)
  if [[ "$CH_KIND" == pages ]]; then
    curl -fL --connect-timeout 20 --retry 3 -s "${pace[@]}" -o "$file" "$url" &
  else
    gh_download "$url" "$file" -s "${pace[@]}" &
  fi
  local pid=$! rc
  while kill -0 "$pid" 2>/dev/null; do
    ST_BYTES="$(stat -c%s "$file" 2>/dev/null || echo 0)"
    (( ST_TOTAL > 0 )) && PH_PCT=$(( ST_BYTES * 100 / ST_TOTAL ))
    (( PH_PCT > 99 )) && PH_PCT=99
    write_status
    if cancel_requested; then kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
      ST_STATE=cancelled; log "cancelled during download"; write_status; return 1; fi
    sleep 1
  done
  wait "$pid"; rc=$?
  ST_BYTES="$(stat -c%s "$file" 2>/dev/null || echo 0)"
  [[ $rc -eq 0 ]] || { fail "download failed (curl exit $rc)"; return 1; }
  log "downloaded $ST_BYTES B"

  # verify
  phase verify "checking SHA256 and the package"
  local got
  got="$(sha256sum "$file" | awk '{print $1}')"
  [[ "$got" == "$sum" ]] || { fail "SHA256 mismatch: got $got, expected $sum"; return 1; }
  progress 40 "SHA256 ok"
  local work="$DL_DIR/pkg"
  rm -rf "$work"; mkdir -p "$work"
  tar xzf "$file" -C "$work" || { fail "cannot unpack $name"; return 1; }
  local pkg
  pkg="$(find "$work" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  [[ -x "$pkg/wifilt" && -x "$pkg/install.sh" && -d "$pkg/data" ]] || { fail "package is incomplete"; return 1; }
  local pkgrev pkgbuild=""
  pkgrev="$(tr -dc '0-9' < "$pkg/VERSION" 2>/dev/null)"
  [[ -r "$pkg/BUILD" ]] && pkgbuild="$(tr -dc '0-9' < "$pkg/BUILD")"
  pkgbuild="$((10#${pkgbuild:-0}))"
  if [[ "$pkgrev" != "$TO_REV" || "$pkgbuild" != "$TO_BUILD" ]]; then
    fail "package $(version_str "$pkgrev" "$pkgbuild") does not match $ST_TO"; return 1
  fi
  # install.sh removes a local-trx it does not find in the archive (an archive
  # built without it). Here that would take local-trx away from a station that
  # uses it, so such a package is refused -- REV 20261113 went out like that.
  if [[ -x "$PREFIX/local-trx" && ! -x "$pkg/local-trx" ]]; then
    fail "the package has no local-trx, but local-trx is installed here -- refused (it would be removed)"
    return 1
  fi
  local ed_old=0 ed_new=0
  LC_ALL=C grep -a -q "$EDITION_MARK" "$PREFIX/wifilt" 2>/dev/null && ed_old=1
  LC_ALL=C grep -a -q "$EDITION_MARK" "$pkg/wifilt" && ed_new=1
  if [[ $ed_old -ne $ed_new ]]; then
    fail "the package is a different edition than the installed one -- refused"; return 1
  fi
  progress 100 "package ok"
  if cancel_requested; then ST_STATE=cancelled; log "cancelled"; write_status; return 1; fi

  if [[ "$ST_MODE" == pi-locked ]]; then
    pi_locked_handoff "$pkg"
    return $?
  fi

  install_package "$pkg" || return 1
  finish_ok
}

# The part shared by the plain and the Pi paths: backup, stop, install, start,
# health; rollback on any failure from "stop" on.
install_package() {
  local pkg="$1"

  phase backup "saving the current installation"
  if [[ $DRY_RUN -eq 1 ]]; then sleep 1; else
    rm -rf "$PREV"
    if [[ -d "$PREFIX" ]]; then cp -a "$PREFIX" "$PREV" || { fail "backup failed"; return 1; }; fi
    mkdir -p "$STATE_DIR/units"
    local u
    for u in wifilt.service local-trx.service; do
      rm -f "$STATE_DIR/units/$u" "$STATE_DIR/units/$u.enabled"
      [[ -f "$UNIT_DIR/$u" ]] && cp -f "$UNIT_DIR/$u" "$STATE_DIR/units/$u"
      # install.sh may disable a unit (local-trx when the archive lacks it);
      # a rollback has to switch it back on, not just put the file back.
      systemctl is-enabled --quiet "$u" 2>/dev/null && : > "$STATE_DIR/units/$u.enabled"
    done
  fi
  # No way back from here without the rollback.
  rm -f "$REQ_DIR/cancel"

  phase stop "stopping WIFILT (the page will reconnect)"
  WAS_ACTIVE=()
  local s
  for s in wifilt local-trx; do svc_active "$s" && WAS_ACTIVE+=("$s"); done
  log "running before: ${WAS_ACTIVE[*]:-none}"
  ST_STATE=offline; write_status
  if [[ $DRY_RUN -eq 1 ]]; then sleep 2; else
    systemctl stop wifilt local-trx 2>/dev/null || true
  fi

  phase install "installing $ST_TO"
  if [[ $DRY_RUN -eq 1 ]]; then sleep 3; else
    local u; u="$(run_user)"
    if ! SUDO_USER="$u" "$pkg/install.sh" --prefix "$PREFIX" >> "$LOG" 2>&1; then
      fail "install.sh failed"; restore_previous; write_status; return 1
    fi
  fi

  oi3_flash "$pkg"

  phase start "starting ${WAS_ACTIVE[*]:-nothing (no service was running)}"
  if [[ $DRY_RUN -eq 0 ]]; then
    for s in "${WAS_ACTIVE[@]}"; do systemctl start "$s" || log "start $s failed"; done
  fi

  phase health "waiting for the new version to answer"
  local expect="$TO_REV" expect_build="$TO_BUILD"
  [[ $DRY_RUN -eq 1 ]] && { expect="$(installed_rev)"; expect_build="$(installed_build)"; }
  if [[ " ${WAS_ACTIVE[*]} " == *" wifilt "* ]]; then
    if ! wait_health "$expect" "$expect_build" 90; then
      fail "the new version did not answer within 90 s"
      [[ $DRY_RUN -eq 0 ]] && restore_previous
      write_status; return 1
    fi
  fi
  if [[ " ${WAS_ACTIVE[*]} " == *" local-trx "* ]]; then
    sleep 3
    if [[ $DRY_RUN -eq 0 ]] && ! svc_active local-trx; then
      fail "local-trx did not stay running"; restore_previous; write_status; return 1
    fi
  fi
  ST_STATE=running
  [[ " ${WAS_ACTIVE[*]} " == *" wifilt "* ]] || log "wifilt.service was not running, nothing to check"
  return 0
}

finish_ok() {
  ST_STATE="done"
  phase "done" "$([[ $DRY_RUN -eq 1 ]] && echo "dry run finished, nothing was changed" || echo "updated to $ST_TO")${OI3_WARN:+ -- but the OI3 was not updated: $OI3_WARN}"
  rm -rf "$DL_DIR/pkg" "$DL_DIR"/wifilt-*.tar.gz
  [[ $DRY_RUN -eq 0 ]] && do_check >/dev/null 2>&1
  return 0
}

# ------------------------------------------------------- locked Raspberry Pi
# A locked root (fslock / overlayroot) is an overlay in RAM: an install there
# vanishes at the next reboot, and unlocking only takes effect after one. So:
#   1. download + verify run in the overlay (above);
#   2. the verified package, this script, the status and a one-shot unit are
#      written to the real root underneath ($ROOT_RO, remounted rw briefly --
#      what fslock and pi-setup do too);
#   3. fslock unlock, reboot;
#   4. wifilt-update-resume.service runs "wifilt-update --resume": backup,
#      stop, install, start, health (rollback on failure);
#   5. fslock lock, reboot -- in both cases, so the machine ends locked, as it
#      started. The status file is on the real root by then, so the page reads
#      "relock" after the last reboot and wifilt reports it as finished.

ROOT_RO=/media/root-ro
RESUME_UNIT=wifilt-update-resume.service
FSLOCK=/usr/local/sbin/fslock

pi_locked_handoff() {
  local pkg="$1" lower="$ROOT_RO" dst
  phase unlock "preparing the update on the real root file system"
  if [[ $DRY_RUN -eq 1 ]]; then
    log "dry run: would remount $lower rw, copy the package, unlock and reboot"
    sleep 2
    install_package "$pkg" || return 1
    phase relock "dry run: would lock again and reboot"
    sleep 2
    finish_ok
    return 0
  fi
  [[ -x "$FSLOCK" ]] || { fail "fslock not found"; return 1; }
  findmnt "$lower" >/dev/null 2>&1 || { fail "$lower is not mounted -- cannot prepare the update"; return 1; }
  mount -o remount,rw "$lower" || { fail "cannot remount $lower for writing"; return 1; }
  dst="$lower$STATE_DIR"
  install -d -m 0755 "$dst"
  rm -rf "$dst/pkg"
  cp -a "$pkg" "$dst/pkg" || { mount -o remount,ro "$lower"; fail "cannot copy the package"; return 1; }
  cp -f "$0" "$dst/resume-$SELF_NAME" && chmod 755 "$dst/resume-$SELF_NAME"
  printf 'REQ_ID=%q\nST_FROM=%q\nST_TO=%q\nTO_REV=%q\nTO_BUILD=%q\nST_STARTED=%q\n' \
    "$REQ_ID" "$ST_FROM" "$ST_TO" "$TO_REV" "$TO_BUILD" "$ST_STARTED" > "$dst/resume.conf"
  chmod 600 "$dst/resume.conf"
  cp -f "$LOG" "$dst/update.log" 2>/dev/null || true

  cat > "$lower/etc/systemd/system/$RESUME_UNIT" <<EOF
[Unit]
Description=WIFILT web updater: finish an update started on a locked system
After=network-online.target NetworkManager.service data.mount
Wants=network-online.target
ConditionPathExists=$STATE_DIR/resume.conf

[Service]
Type=oneshot
ExecStart=/bin/bash $STATE_DIR/resume-$SELF_NAME --resume
KillMode=process
TimeoutStartSec=infinity

[Install]
WantedBy=multi-user.target
EOF
  install -d "$lower/etc/systemd/system/multi-user.target.wants"
  ln -sfn "../$RESUME_UNIT" "$lower/etc/systemd/system/multi-user.target.wants/$RESUME_UNIT"

  # The status the page will see while the machine reboots, written to the real
  # root so it is still there after the reboot.
  ST_STATE=offline
  ST_MSG="unlocking and rebooting -- the update continues by itself"
  log "[unlock] $ST_MSG"
  write_status
  cp -f "$STATUS" "$dst/status.json"
  cp -f "$LOG" "$dst/update.log" 2>/dev/null || true
  sync
  mount -o remount,ro "$lower" || log "cannot remount $lower read-only again (harmless, it reboots now)"

  if ! "$FSLOCK" unlock -y --no-reboot >> "$LOG" 2>&1; then
    # Undo the arming on the real root, or the next ordinary boot would try.
    mount -o remount,rw "$lower" && rm -f "$lower/etc/systemd/system/multi-user.target.wants/$RESUME_UNIT" \
      "$dst/resume.conf" && mount -o remount,ro "$lower"
    ST_STATE=running; fail "fslock unlock failed"; return 1
  fi
  sync
  systemctl reboot
  return 0
}

# Second half, on the unlocked boot: run from the real root by the resume unit.
pi_resume() {
  local a="$STATE_DIR/resume.conf"
  [[ -f "$a" ]] || exit 0
  # Disarm first, whatever happens next: never a boot loop.
  rm -f "/etc/systemd/system/multi-user.target.wants/$RESUME_UNIT"
  mv -f "$a" "$a.done"
  systemctl daemon-reload || true

  # shellcheck disable=SC1090
  . "$a.done"
  # A resume.conf without TO_REV/TO_BUILD: take them from the version string.
  if [[ -z "$TO_REV" ]]; then
    TO_REV="${ST_TO%%.*}"
    TO_BUILD=0
    [[ "$ST_TO" == *.* ]] && TO_BUILD="$((10#${ST_TO#*.}))"
  fi
  ST_MODE=pi-locked
  set_phases "$ST_MODE"
  ST_STATE=running
  DRY_RUN=0
  log "----- resumed after the unlock reboot $(date -Iseconds) -----"

  if is_locked_pi; then
    fail "the system is still locked after the reboot -- nothing was changed"
    rm -f "$a.done"
    return 1
  fi

  local pkg="$STATE_DIR/pkg" ok=0
  if [[ -x "$pkg/wifilt" ]]; then
    install_package "$pkg" && ok=1
  else
    fail "the saved package is missing"
  fi

  # The unit file stays: this very script runs as that unit, and deleting its
  # file plus any daemon-reload (restore_previous and install.sh do one too)
  # leaves systemd with no TimeoutStartSec=30min, only the 90 s default --
  # already over by then, so the run was killed between "[relock]" and
  # "fslock lock" and the Pi stayed unlocked (2026-11-13). Disarmed is enough:
  # its wants-link is gone and ConditionPathExists=resume.conf no longer holds.
  rm -rf "$pkg" "$a.done"

  # Lock again in both cases: the machine ends as it started. On failure the
  # previous version is back by now (install_package rolled it back).
  if [[ $ok -eq 1 ]]; then
    ST_ERR=""
    log "updated to $ST_TO"
  fi
  PH_PCT=0
  local i
  for i in "${!PHASES[@]}"; do [[ "${PHASES[i]}" == relock ]] && PH_IDX=$i; done
  ST_MSG="locking the system again and rebooting${OI3_WARN:+ (the OI3 was not updated: $OI3_WARN)}"
  log "[relock] $ST_MSG"
  ST_STATE=offline
  write_status
  sync
  if ! "$FSLOCK" lock -y >> "$LOG" 2>&1; then
    ST_STATE=failed
    ST_ERR="${ST_ERR:+$ST_ERR; }fslock lock failed -- the system stays UNLOCKED, lock it with: sudo fslock lock"
    write_status
    return 1
  fi
  # fslock lock reboots; nothing below runs normally.
  return 0
}

# ----------------------------------------------------------------- main ---

main() {
  local cmd="${1:-}"; shift || true
  local a
  for a in "$@"; do
    case "$a" in
      --dry-run) DRY_RUN=1 ;;
      *) die_usage ;;
    esac
  done

  mkdir -p "$STATE_DIR" "$DL_DIR"

  if [[ "$cmd" == --resume ]]; then
    exec 9> "$LOCK"; flock -n 9 || exit 1
    pi_resume
    exit $?
  fi

  if [[ "$cmd" == --from-request ]]; then
    local req="$REQ_DIR/request.json" body=""
    [[ -f "$req" ]] || exit 0
    body="$(head -c 512 "$req")"
    rm -f "$req"
    cmd="$(printf '%s' "$body" | sed -n 's/.*"action" *: *"\([a-z]*\)".*/\1/p')"
    REQ_ID="$(printf '%s' "$body" | sed -n 's/.*"id" *: *"\([A-Za-z0-9]\{1,32\}\)".*/\1/p')"
    printf '%s' "$body" | grep -Eq '"dry" *: *(1|true)' && DRY_RUN=1
  fi

  # One at a time: the 12-hour check must not race an update.
  exec 9> "$LOCK"
  if ! flock -n 9; then
    echo "another $SELF_NAME is running" >&2
    exit 1
  fi

  case "$cmd" in
    check)  do_check ;;
    update)
      if [[ $EUID -ne 0 && $DRY_RUN -eq 0 ]]; then
        # Say so where the page looks, or it waits for a run that never starts.
        set_phases "$(mode_id)"; ST_STARTED="$(now)"; ST_FROM="$(installed_version)"
        fail "the updater must run as root (wifilt-update.service)"
        exit 1
      fi
      do_update ;;
    *) die_usage ;;
  esac
}

# bash reads a script as it runs; install.sh replaces this very file in the
# middle of an update. Run from a private copy so the replacement cannot
# change the code under our feet.
if [[ "${WIFILT_UPDATE_COPY:-}" != 1 ]]; then
  mkdir -p "$STATE_DIR"
  copy="$STATE_DIR/.run-$SELF_NAME"
  cp -f "$0" "$copy" 2>/dev/null && chmod 755 "$copy" && \
    WIFILT_UPDATE_COPY=1 exec "$copy" "$@"
fi
main "$@"
