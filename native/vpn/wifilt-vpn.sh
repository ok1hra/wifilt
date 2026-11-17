#!/usr/bin/env bash
#
# wifilt-vpn -- the root side of SETUP -> Remote access: the n2n 3 edge to the
# supernode on remoteqth.com (docs/vpn-n2n-implementace.md, SOFTWARE.md).
#
#   wifilt-vpn condition       ExecCondition of wifilt-vpn.service (0 = start the edge)
#   wifilt-vpn run             ExecStart of wifilt-vpn.service: exec the edge
#   wifilt-vpn --from-request  wifilt-vpn-apply.service: one request from wifilt
#   wifilt-vpn install         build and install n2n 3.1.1 (wifilt-vpn-build)
#   wifilt-vpn status          print the last action's status.json
#
# wifilt runs as an ordinary user. It writes vpn.json into its config directory
# and drops req/apply.json; this script reads both as root and trusts neither:
# every field must match a strict pattern, the files are parsed with sed and
# never sourced, only an action name and an IPv4 address are taken from the
# request, and files in the user's directory are written as that user.
#
# The edge is its own service on purpose: remote access is the lifeline while
# wifilt restarts, crashes or is being updated. wifilt-vpn.service stays
# enabled for good (install.sh, always on an unlocked system); whether the edge
# really runs is decided at every start by "condition" from vpn.json, which on
# a locked Raspberry Pi lives on the data card. Nothing here has to survive in
# /etc.
#
# Test overrides (tools/vpn-helper-check.sh): WIFILT_VPN_CONF, WIFILT_VPN_STATE,
# WIFILT_VPN_EDGE, WIFILT_VPN_BUILD, WIFILT_VPN_MACHINE_ID, WIFILT_VPN_MGMT_PORT,
# WIFILT_VPN_WATCH_SECONDS, WIFILT_VPN_EDGE_EXTRA, WIFILT_VPN_AS_SELF=1.

set -uo pipefail

CONF="${WIFILT_VPN_CONF:-/etc/wifilt-vpn.conf}"
STATE_DIR="${WIFILT_VPN_STATE:-/var/lib/wifilt-vpn}"
EDGE="${WIFILT_VPN_EDGE:-/usr/local/sbin/edge}"
MACHINE_ID="${WIFILT_VPN_MACHINE_ID:-/etc/machine-id}"
MGMT_PORT="${WIFILT_VPN_MGMT_PORT:-5644}"
WATCH_SECONDS="${WIFILT_VPN_WATCH_SECONDS:-120}"
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
BUILD="${WIFILT_VPN_BUILD:-$HERE/wifilt-vpn-build}"
TAP=wlvpn0
UNIT=wifilt-vpn.service
REQ_DIR="$STATE_DIR/req"
STATUS="$STATE_DIR/status.json"
EDGE_STATE="$STATE_DIR/edge.json"
LOG_FILE="$STATE_DIR/last.log"

# ---- settings ----------------------------------------------------------------

RUN_USER="" CONF_DIR="" ERR=""
ENABLED="" COMMUNITY="" KEY="" DESC="" SUPERNODE=""

conf_value() { sed -n "s/^$1=//p" "$CONF" 2>/dev/null | head -n1; }

load_conf() {
  [[ -f "$CONF" ]] || { ERR="$CONF is missing"; return 1; }
  RUN_USER="$(conf_value RUN_USER)"
  CONF_DIR="$(conf_value CONF_DIR)"
  [[ "$RUN_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { ERR="bad RUN_USER in $CONF"; return 1; }
  [[ "$CONF_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || { ERR="bad CONF_DIR in $CONF"; return 1; }
  return 0
}

json_str()  { sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p' "$1" 2>/dev/null | head -n1; }
json_bool() { sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$1" 2>/dev/null | head -n1; }

# vpn.json, checked field by field. 1 = no usable settings (ERR says why).
load_settings() {
  local f="$CONF_DIR/vpn.json"
  ENABLED="false" COMMUNITY="" KEY="" DESC="" SUPERNODE=""
  [[ -f "$f" && ! -L "$f" ]] || { ERR="no VPN settings yet"; return 1; }
  [[ "$(stat -c %s "$f" 2>/dev/null || echo 99999)" -le 4096 ]] || { ERR="vpn.json is too big"; return 1; }
  ENABLED="$(json_bool "$f" enabled)"
  COMMUNITY="$(json_str "$f" community)"
  KEY="$(json_str "$f" key)"
  DESC="$(json_str "$f" desc)"
  SUPERNODE="$(json_str "$f" supernode)"
  [[ "$ENABLED" == "true" ]] || ENABLED="false"
  [[ -n "$COMMUNITY" ]] || { ERR="not paired"; return 1; }
  [[ "$COMMUNITY" =~ ^wl-[0-9a-z]{8}$ ]] || { ERR="bad community in vpn.json"; return 1; }
  [[ "$KEY" =~ ^[0-9A-Z]{20}$ ]] || { ERR="bad key in vpn.json"; return 1; }
  [[ "$DESC" =~ ^[A-Z0-9/._-]{1,15}$ ]] || DESC="WIFILT"
  [[ "$SUPERNODE" =~ ^[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$ ]] || { ERR="bad supernode in vpn.json"; return 1; }
  return 0
}

# Locally administered, stable across restarts (the peers' ARP caches stay
# right) and different on every machine, even when vpn.json was restored from
# another one's backup.
machine_mac() {
  local seed h
  seed="$(cat "$MACHINE_ID" 2>/dev/null || hostname)"
  h="$(printf 'wifilt-vpn:%s' "$seed" | sha256sum | cut -c1-10)"
  printf '02:%s:%s:%s:%s:%s\n' "${h:0:2}" "${h:2:2}" "${h:4:2}" "${h:6:2}" "${h:8:2}"
}

# The banner is on the second line: edge -h starts with an empty one.
# n2n 3.1.1 built without pthread looks a supernode NAME up again before every
# registration and then drops the answers ("wrong or old cookie" -- found
# against remoteqth.com:82). build-n2n.sh builds with --enable-pthread; for an
# edge built by hand without it, the address goes to the edge instead of the
# name (a later address change then needs a restart of the service).
supernode_arg() {
  local host="${SUPERNODE%:*}" port="${SUPERNODE##*:}" ip
  if [[ "$host" =~ ^[0-9.]+$ ]] || grep -a pthread_create "$EDGE" >/dev/null 2>&1; then
    echo "$SUPERNODE"
    return 0
  fi
  ip="$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR == 1 { print $1 }')"
  [[ -n "$ip" ]] || { echo "wifilt-vpn: cannot resolve $host (retrying)" >&2; return 1; }
  echo "wifilt-vpn: $EDGE has no resolver thread, using $ip for $host" >&2
  echo "$ip:$port"
}

edge_is_v3() { case "$("$EDGE" -h 2>&1 | head -n3 | tr '\n' ' ')" in *"n2n v.3."*) return 0 ;; esac; return 1; }

# Files in the user's config directory are written as that user: root writing
# into a directory someone else controls is how symlink tricks start.
as_user() {
  if [[ -n "${WIFILT_VPN_AS_SELF:-}" ]]; then "$@"; else runuser -u "$RUN_USER" -- "$@"; fi
}

# ---- status for the page -------------------------------------------------------

json_escape() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/ }"
  printf '%s' "$s" | tr -d '\000-\037'
}

ST_ID="" ST_ACTION="" ST_STATE="idle" ST_PHASE="" ST_MSG="" ST_ERROR="" ST_STARTED=0

write_status() {
  local log="" line first=1
  if [[ -f "$LOG_FILE" ]]; then
    while IFS= read -r line; do
      [[ $first -eq 1 ]] || log+=","
      log+="\"$(json_escape "$line")\""
      first=0
    done < <(tail -n 20 "$LOG_FILE")
  fi
  local tmp="$STATUS.tmp"
  printf '{"id":"%s","action":"%s","state":"%s","phase":"%s","msg":"%s","error":"%s","startedAt":%s,"ts":%s,"log":[%s]}\n' \
    "$ST_ID" "$ST_ACTION" "$ST_STATE" "$(json_escape "$ST_PHASE")" "$(json_escape "$ST_MSG")" \
    "$(json_escape "$ST_ERROR")" "$ST_STARTED" "$(date +%s)" "$log" > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$STATUS"
}

log() { echo "$(date '+%H:%M:%S') $*" >> "$LOG_FILE"; }
phase() { ST_PHASE="$1"; ST_MSG="$2"; log "$2"; write_status; }
finish() { ST_STATE="$1"; ST_MSG="$2"; ST_ERROR="${3:-}"; [[ -n "$ST_ERROR" ]] && log "ERROR: $ST_ERROR"; log "$2"; write_status; }

# What stopped the edge from starting, for SETUP (condition runs before the
# edge, so its errors cannot be in the edge's own output).
edge_error() {
  local tmp="$EDGE_STATE.tmp"
  printf '{"error":"%s","ts":%s}\n' "$(json_escape "$1")" "$(date +%s)" > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$EDGE_STATE"
}

# ---- commands --------------------------------------------------------------------

cmd_condition() {
  load_conf || exit 1
  if ! load_settings; then rm -f "$EDGE_STATE"; exit 1; fi
  if [[ "$ENABLED" != "true" ]]; then rm -f "$EDGE_STATE"; exit 1; fi
  [[ -x "$EDGE" ]] || { edge_error "n2n is not installed ($EDGE)"; exit 1; }
  edge_is_v3 || { edge_error "$EDGE is not n2n 3.x"; exit 1; }
  rm -f "$EDGE_STATE"
  exit 0
}

cmd_run() {
  load_conf || { echo "wifilt-vpn: $ERR" >&2; exit 1; }
  load_settings || { echo "wifilt-vpn: $ERR" >&2; exit 1; }
  local mac sn
  mac="$(machine_mac)"
  sn="$(supernode_arg)" || exit 1   # systemd starts it again in 10 s
  # The key never goes on the command line (ps shows that to every user). The
  # edge drops to nobody/nogroup by itself once wlvpn0 is up.
  export N2N_KEY="$KEY"
  # shellcheck disable=SC2086  # WIFILT_VPN_EDGE_EXTRA is a word list on purpose (tests: -u 0 -g 0)
  exec "$EDGE" -d "$TAP" -c "$COMMUNITY" -l "$sn" -A4 -I "$DESC" -m "$mac" \
       -t "$MGMT_PORT" -f ${WIFILT_VPN_EDGE_EXTRA:-}
}

svc_active() { systemctl is-active --quiet "$UNIT" 2>/dev/null; }

# Back to the settings from before the change, as the user.
revert_settings() {
  local prev="$CONF_DIR/vpn.prev.json"
  [[ -f "$prev" && ! -L "$prev" ]] || return 1
  as_user cp -f "$prev" "$CONF_DIR/vpn.json"
}

do_apply() {
  local watch="$1"
  if ! load_settings || [[ "$ENABLED" != "true" ]]; then
    phase stop "switching the VPN off"
    systemctl stop "$UNIT" 2>/dev/null || true
    finish "done" "VPN off"
    return 0
  fi

  phase start "starting the n2n edge ($DESC -> $SUPERNODE)"
  systemctl restart "$UNIT" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do svc_active && break; sleep 1; done
  if ! svc_active; then
    local why="the edge did not start"
    [[ -f "$EDGE_STATE" ]] && why="$(sed -n 's/.*"error":"\([^"]*\)".*/\1/p' "$EDGE_STATE")"
    if [[ -n "$watch" ]] && revert_settings; then
      systemctl restart "$UNIT" 2>/dev/null || true
      finish reverted "previous settings restored" "$why"
    else
      finish failed "VPN not running" "$why"
    fi
    return 1
  fi

  if [[ -z "$watch" ]]; then
    finish "done" "VPN running"
    return 0
  fi

  # Changed from inside the VPN: the requester must come back through the new
  # settings, or the station would be cut off from the one person working on it.
  phase watch "waiting for $watch to answer through the VPN (${WATCH_SECONDS} s)"
  local deadline=$(( $(date +%s) + WATCH_SECONDS ))
  while (( $(date +%s) < deadline )); do
    if ping -c 1 -W 2 -I "$TAP" "$watch" >/dev/null 2>&1; then
      finish "done" "VPN running, $watch answers"
      return 0
    fi
    sleep 3
  done
  if revert_settings; then
    systemctl restart "$UNIT" 2>/dev/null || true
    finish reverted "previous settings restored" "$watch did not answer through the new settings"
  else
    finish failed "VPN running, $watch does not answer" "no previous settings to restore"
  fi
  return 1
}

do_install() {
  phase build "building n2n 3.1.1 (a few minutes)"
  if [[ ! -x "$BUILD" ]]; then
    finish failed "n2n not installed" "$BUILD is missing"
    return 1
  fi
  local rc line rcfile="$STATE_DIR/build.rc"
  rm -f "$rcfile"
  # The subshell writes the exit status before it closes the pipe, so the file
  # is there by the time the loop sees the end of the output.
  while IFS= read -r line; do
    if [[ "$line" == PHASE\ * ]]; then
      line="${line#PHASE }"
      phase "${line%% *}" "${line#* }"
    else
      log "$line"
    fi
  done < <("$BUILD" 2>&1; echo "$?" > "$rcfile")
  rc="$(cat "$rcfile" 2>/dev/null || echo 1)"
  rm -f "$rcfile"
  if [[ "$rc" != "0" ]]; then
    finish failed "n2n not installed" "the build failed (exit $rc), see the log"
    return 1
  fi
  if load_settings && [[ "$ENABLED" == "true" ]]; then
    systemctl restart "$UNIT" 2>/dev/null || true
  fi
  finish "done" "n2n 3.1.1 installed"
}

cmd_from_request() {
  local req="$REQ_DIR/apply.json" raw action id watch
  [[ -f "$req" && ! -L "$req" ]] || exit 0
  raw="$(head -c 512 "$req")"
  rm -f "$req"
  action="$(sed -n 's/.*"action":"\([a-z]*\)".*/\1/p' <<<"$raw" | head -n1)"
  id="$(sed -n 's/.*"id":"\([A-Za-z0-9]\{1,32\}\)".*/\1/p' <<<"$raw" | head -n1)"
  watch="$(sed -n 's/.*"watch":"\([0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\)".*/\1/p' <<<"$raw" | head -n1)"
  if [[ -n "$watch" ]]; then
    local o
    IFS=. read -r -a o <<<"$watch"
    for i in "${o[@]}"; do (( 10#$i <= 255 )) || watch=""; done
  fi

  mkdir -p "$STATE_DIR"
  exec 9>"$STATE_DIR/lock"
  flock -w 1800 9 || exit 0

  : > "$LOG_FILE"
  ST_ID="$id" ST_ACTION="$action" ST_STATE="running" ST_PHASE="" ST_MSG="" ST_ERROR=""
  ST_STARTED="$(date +%s)"
  if ! load_conf; then finish failed "nothing done" "$ERR"; exit 1; fi
  case "$action" in
    apply)   do_apply "$watch" ;;
    install) do_install ;;
    *)       finish failed "nothing done" "unknown action" ;;
  esac
  exit 0
}

case "${1:-}" in
  condition)      cmd_condition ;;
  run)            cmd_run ;;
  --from-request) cmd_from_request ;;
  install)
    load_conf || true
    mkdir -p "$STATE_DIR"; : > "$LOG_FILE"
    ST_ACTION=install ST_STATE=running ST_STARTED="$(date +%s)"
    do_install ;;
  status)         cat "$STATUS" 2>/dev/null || echo '{"state":"idle"}' ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \?//'; exit 2 ;;
esac
