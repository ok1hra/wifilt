#!/usr/bin/env bash
#
# Convenience launcher: starts wifilt (and local-trx, if it is sitting right
# next to this script -- see BUILD.md § 5) and opens both web interfaces in
# the browser. Not a required step -- systemd (`systemctl start wifilt`) or
# running either binary directly work exactly as before; this just saves an
# operator from having to know there are two separate programs at all.
#
# Usage:
#   start-wifilt.sh        (re)start both -- a stale copy of either one
#                           already running is stopped first, see below
#   start-wifilt.sh stop   stop both, do not start anything
#
# wifilt.ino/native/ itself stays completely unaware of local-trx (bod 1/12's
# "zero diff" -- see docs/local-trx-implementace.md): this script is the
# thing that knows about both, not either binary.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# $HERE is /opt/wifilt for a `sudo ./install.sh` install -- root-owned, so an
# operator running this script as themselves (correctly: wifilt only ever
# needs root for the one-time setcap, already done at install time) cannot
# create files there. XDG_STATE_HOME is the standard sibling of paths.cpp's
# own XDG_CONFIG_HOME use for exactly this kind of transient, per-user,
# not-configuration data. Found live: real install, "Operace zamítnuta"
# on both log files, nothing started.
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wifilt"
mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR=/tmp
WIFILT_LOG="$LOG_DIR/wifilt.launcher.log"
LOCAL_TRX_LOG="$LOG_DIR/local-trx.launcher.log"

# `open`/`xdg-open` hand off to the system's own default-browser resolution,
# same technique and same reasoning as local-trx's own openInBrowser()
# (main.cpp) -- best-effort, a headless box with neither installed just
# leaves the process running with no tab opened rather than failing outright.
open_url() {
  local url="$1"
  case "$(uname -s)" in
    Darwin) open "$url" >/dev/null 2>&1 & ;;
    *)      command -v xdg-open >/dev/null 2>&1 && xdg-open "$url" >/dev/null 2>&1 & ;;
  esac
}

# Bash's own /dev/tcp pseudo-device -- a connect() with no extra dependency
# (no curl/nc assumed installed).
port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# Finds PIDs whose argv[0] (from /proc/$pid/cmdline, canonicalized) is
# exactly $1. This is what lets both `stop` and the kill-stale-copy-before-
# start logic below act only on copies of THIS binary, never on some
# unrelated process that happens to share a name or a port.
#
# Deliberately reads cmdline, NOT /proc/$pid/exe: wifilt is installed with
# cap_net_bind_service (`make -C native setcap`) so it can bind port 80
# without running as root, and the kernel marks a process non-dumpable the
# moment it execs a binary carrying file capabilities beyond its caller's --
# which makes /proc/$pid/exe unreadable to this script even when run by the
# very same user, every single time (found live: a real restart attempt
# silently could not identify wifilt's own pid at all, only local-trx's,
# and fell back to the "can't identify" branch below for wifilt on every
# run). cmdline carries no such restriction and is exactly as reliable for
# this purpose.
#
# Silently finds nothing (not an error) on a system with no /proc (e.g.
# macOS) -- the port_open check further down is what still protects
# against a double start there.
find_pids_for_bin() {
  local bin_real="" pid="" argv0="" argv0_real=""
  bin_real="$(readlink -f "$1" 2>/dev/null)" || return 0
  [[ -n "$bin_real" ]] || return 0
  for pid in /proc/[0-9]*; do
    pid="${pid#/proc/}"
    # 2>/dev/null must precede the input redirection: bash applies
    # redirections left-to-right, so a `< file 2>/dev/null` order still
    # prints "No such file or directory" to the real stderr when the PID
    # exits between the /proc/[0-9]* glob and this read (a normal race,
    # e.g. found live: a short-lived process vanishing mid-scan spammed
    # three such lines on an ordinary restart) -- the suppression has to
    # already be in effect before the failing open is attempted.
    argv0="$(tr '\0' '\n' 2>/dev/null < "/proc/$pid/cmdline" | head -n1)"
    [[ -n "$argv0" ]] || continue
    argv0_real="$(readlink -f "$argv0" 2>/dev/null)" || continue
    [[ "$argv0_real" == "$bin_real" ]] && echo "$pid"
  done
}

# SIGTERM first (so wifilt/local-trx get to close sockets/serial ports
# cleanly), escalating to SIGKILL only if a process is still alive a few
# seconds later -- same reasoning as the orphaned-Chrome incident this
# project already hit once (mercury-orphaned-chrome-tx-incident): a process
# still holding a real radio's audio/CAT/keying lines should get a real
# chance to let go of them before being forced.
kill_pid() {
  local pid="$1" name="$2" i=0
  kill -TERM "$pid" 2>/dev/null || return 0
  for ((i = 0; i < 10; i++)); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  echo "$name: pid $pid still alive after SIGTERM, sending SIGKILL"
  kill -KILL "$pid" 2>/dev/null
}

stop_bin() {
  local bin="$1" name="$2" pid="" found=0
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    found=1
    echo "$name: stopping pid $pid"
    kill_pid "$pid" "$name"
  done < <(find_pids_for_bin "$bin")
  [[ "$found" -eq 1 ]] || echo "$name: not running"
}

WIFILT_BIN="$HERE/wifilt"
WIFILT_PORT=80
LOCAL_TRX_BIN="$HERE/local-trx"
LOCAL_TRX_PORT=8765

if [[ "${1:-}" == "stop" ]]; then
  stop_bin "$WIFILT_BIN" "wifilt"
  [[ -x "$LOCAL_TRX_BIN" ]] && stop_bin "$LOCAL_TRX_BIN" "local-trx"
  exit 0
fi

# Stops a stale copy of $bin found via find_pids_for_bin, then starts a
# fresh one -- unless the port is still held by something this script could
# NOT identify (no /proc, or a process it lacks permission to inspect, e.g.
# a root-owned wifilt.service): in that one case it falls back to the old
# "don't start a second copy" behavior rather than guessing.
start_or_restart() {
  local bin="$1" name="$2" port="$3" log="$4" pid=""; shift 4
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    echo "$name: already running as pid $pid -- stopping it before starting the new copy"
    kill_pid "$pid" "$name"
  done < <(find_pids_for_bin "$bin")

  if port_open "$port"; then
    echo "$name: port $port is still in use by a process this script could not identify/stop -- not starting a second copy"
    return 0
  fi
  echo "$name: starting... (log: $log)"
  "$bin" "$@" >"$log" 2>&1 &
  sleep 1
}

start_or_restart "$WIFILT_BIN" "wifilt" "$WIFILT_PORT" "$WIFILT_LOG" --data-dir "$HERE/data"
open_url "http://127.0.0.1:${WIFILT_PORT}/"

if [[ -x "$LOCAL_TRX_BIN" ]]; then
  # Suppresses local-trx's own openBrowserOnStart (main.cpp) -- this script
  # opens both tabs itself below, so local-trx's own copy of that logic
  # firing too (if the operator has also turned it on in local-trx's
  # config) would open the wizard tab a second time.
  LOCAL_TRX_SKIP_AUTO_OPEN=1 start_or_restart "$LOCAL_TRX_BIN" "local-trx" "$LOCAL_TRX_PORT" "$LOCAL_TRX_LOG"
  open_url "http://127.0.0.1:${LOCAL_TRX_PORT}/"
fi
