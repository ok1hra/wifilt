#!/usr/bin/env bash
#
# pi-setup -- guided installer for a WIFILT station on a Raspberry Pi (64-bit).
#
# Works on a freshly imaged Raspberry Pi OS Lite (64-bit) and on an existing
# installation (update). It first asks every question, shows the plan, and only
# then does the work, so a long run (OI3 firmware build) needs no babysitting.
#
#   ./pi-setup.sh                 install or update, asking questions
#   ./pi-setup.sh --yes           no questions: saved answers / defaults
#   ./pi-setup.sh --only LIST     only these steps, comma separated:
#                                 packages,wifilt,serial,network,oi3,fslock
#   ./pi-setup.sh --force         reinstall WIFILT / reflash OI3 even when
#                                 they are already up to date
#   ./pi-setup.sh --dry-run       ask the questions, print the plan, change nothing
#   ./pi-setup.sh --keep-unlocked cancel a pending automatic re-lock (fslock)
#
# Steps:
#   1 System packages        always (missing tools, groups audio + dialout)
#   2 WIFILT + local-trx     the programs from this package, systemd services
#   3 Serial port aliases    /dev/ttyUSB.cat, .cw, .panel by USB serial number
#   4 Network                Ethernet: DHCP client, else own DHCP server;
#                            Wi-Fi: setup access point with a captive portal
#   5 Open Interface III     firmware built from source and flashed (default: no)
#   6 Power-loss protection  read-only root (fslock) + USB data card for settings
#
# On a locked system (fslock) it unlocks, reboots, finishes the update by
# itself and locks again, so the system ends in the state it started in.
#
# The usual way to run it is the bootstrap, which downloads the newest package:
#   curl -fsSL https://ok1hra.github.io/wifilt/pi-setup | bash
# Once installed, the same thing is available as: wifilt-pi-setup

set -Eeuo pipefail
# a silent errexit would just end the installer mid-sentence
trap 'printf "pi-setup: unexpected failure at %s:%s: %s\n" "${BASH_SOURCE[0]##*/}" "$LINENO" "$BASH_COMMAND" >&2' ERR

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$HERE/$(basename "${BASH_SOURCE[0]}")"
ORIG_ARGS=("$@")

# --- arguments -----------------------------------------------------------------
ASSUME_YES=0 DRY_RUN=0 FORCE=0 RESUME=0 KEEP_UNLOCKED=0 ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)        ASSUME_YES=1 ;;
    --dry-run)       DRY_RUN=1 ;;
    -f|--force)      FORCE=1 ;;
    --only)          ONLY="${2:?--only needs a list}"; shift ;;
    --only=*)        ONLY="${1#--only=}" ;;
    --resume)        RESUME=1; ASSUME_YES=1 ;;
    --keep-unlocked) KEEP_UNLOCKED=1 ;;
    --from-bootstrap) ;;
    -h|--help)       sed -n '2,/^set -euo/p' "$SELF" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *)               echo "unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done

# --- package layout --------------------------------------------------------------
# In the release archive: pi-setup.sh next to install.sh/wifilt, helpers in pi/.
# In the source tree (native/pi/): helpers next to this script, no programs.
if [[ -d "$HERE/pi/lib" ]]; then
  PI_DIR="$HERE/pi"; PKG="$HERE"
elif [[ -d "$HERE/lib" ]]; then
  PI_DIR="$HERE"; PKG="$(dirname "$HERE")"
else
  echo "pi-setup: helper files (pi/lib) not found next to this script" >&2; exit 1
fi
LIB="$PI_DIR/lib"
FILES="$PI_DIR/files"

# --- root ------------------------------------------------------------------------
# Runs as root; the station user (whose ~/.config holds the settings) comes from
# sudo or the saved answers. SSH_CONNECTION is passed through so the network
# step knows which interface this session depends on.
RUN_DIR=/run/wifilt-pi
STATE_DIR=/var/lib/wifilt-pi
LOG_FILE=/var/log/wifilt-pi-setup.log
if [[ $EUID -ne 0 && $DRY_RUN -eq 1 ]]; then
  # questions only: no root needed, nothing written outside a temp directory
  RUN_DIR=$(mktemp -d); LOG_FILE=$RUN_DIR/pi-setup.log
  PI_SETUP_SSH=${SSH_CONNECTION:-}
  trap 'rm -rf "$RUN_DIR"' EXIT
elif [[ $EUID -ne 0 ]]; then
  command -v sudo >/dev/null || { echo "pi-setup needs root and sudo is missing" >&2; exit 1; }
  exec sudo env PI_SETUP_SSH="${SSH_CONNECTION:-}" bash "$SELF" "${ORIG_ARGS[@]}"
else
  mkdir -p "$RUN_DIR" "$STATE_DIR"
fi
: > "$RUN_DIR/notes"; : > "$RUN_DIR/reboot"

for f in common preflight packages wifilt serial network oi3 fslock resume; do
  # shellcheck disable=SC1090
  . "$LIB/$f.sh"
done

if [[ $KEEP_UNLOCKED -eq 1 ]]; then
  cancel_relock
  exit 0
fi

# Everything also goes to the log; passwords are read silently and never printed.
exec > >(tee -a "$LOG_FILE") 2>&1
echo
echo "----- pi-setup $(date -Iseconds) ${ORIG_ARGS[*]:-} -----"

STEPS=(packages wifilt serial network oi3 fslock)
STEP_TOTAL=${#STEPS[@]}
step_selected() { [[ -z $ONLY ]] || [[ ",$ONLY," == *",$1,"* ]]; }

# --- run phase -------------------------------------------------------------------
# Each step runs in a subshell with errexit, so a failure stops that step
# cleanly; the remaining steps are skipped (fslock must never be set up on top
# of a half-finished install). Successful steps are committed to setup.conf.
run_all() {
  local s rc var failed=""
  for s in "${STEPS[@]}"; do
    var="DO_${s^^}"
    [[ ${!var:-0} == 1 ]] || continue
    printf '\n%s==> %s%s\n' "$C_B" "$(step_title "$s")" "$C_0"
    set +e
    ( set -e; "run_$s" )
    rc=$?
    set -e
    if [[ $rc -ne 0 ]]; then
      err "step '$(step_title "$s")' failed (exit $rc) -- remaining steps skipped. Log: $LOG_FILE"
      failed=$s
      break
    fi
    "commit_$s"
    save_setup_conf
  done
  [[ -z $failed ]]
}

step_title() {
  case $1 in
    packages) echo "System packages" ;;
    wifilt)   echo "WIFILT + local-trx" ;;
    serial)   echo "Serial port aliases" ;;
    network)  echo "Network" ;;
    oi3)      echo "Open Interface III firmware" ;;
    fslock)   echo "Power-loss protection (fslock)" ;;
  esac
}

summary() {
  local rc=$1
  echo
  if [[ $rc -eq 0 ]]; then
    printf '%sFinished.%s\n' "$C_GRN" "$C_0"
  else
    printf '%sFinished with an error.%s See %s\n' "$C_RED" "$C_0" "$LOG_FILE"
  fi
  if [[ -s $RUN_DIR/notes ]]; then
    echo; echo "Notes:"; sed 's/^/  - /' "$RUN_DIR/notes"
  fi
  final_checks
  if [[ -s $RUN_DIR/reboot ]]; then
    echo
    printf '%sA reboot is needed%s for:\n' "$C_YEL" "$C_0"
    sort -u "$RUN_DIR/reboot" | sed 's/^/  - /'
  fi
}

# --- resumed after the unlock reboot ------------------------------------------------
if [[ $RESUME -eq 1 ]]; then
  resume_main
  exit $?
fi

# --- question phase -------------------------------------------------------------------
preflight
load_setup_conf
resolve_user
detect_existing

printf '\n%sWIFILT station setup%s  (%s, package %s)\n' "$C_B" "$C_0" "$MODE_TEXT" "$(pkg_version)"
[[ $DRY_RUN -eq 1 ]] && say "Dry run: questions only, nothing will be changed."
if [[ $LOCKED -eq 1 ]]; then
  echo
  say "This system is LOCKED (fslock): the root file system is read-only and"
  say "changes would be lost at the next reboot. To update it, pi-setup will:"
  say "  1. ask all questions now,"
  say "  2. unlock the system and reboot,"
  say "  3. finish the update by itself after the reboot (log: $LOG_FILE),"
  say "  4. lock it again (you get time to decide), so it ends as it started."
  ask_yn "Continue?" y || exit 0
fi

for i in "${!STEPS[@]}"; do
  s=${STEPS[$i]}
  STEP_NO=$((i + 1))
  if step_selected "$s"; then
    "ask_$s"
  else
    printf -v "DO_${s^^}" 0
  fi
done
ask_finish

echo
printf '%sPlan%s\n' "$C_B" "$C_0"
any=0
for s in "${STEPS[@]}"; do
  var="DO_${s^^}"
  if [[ ${!var:-0} == 1 ]]; then printf '  %s[x]%s %s\n' "$C_GRN" "$C_0" "$(step_title "$s")"; any=1
  else printf '  [ ] %s\n' "$(step_title "$s")"; fi
done
[[ ${ANS_LOCK_AT_END:-0} == 1 ]] && say "  then lock the system (fslock) and reboot"
[[ ${ANS_RELOCK:-0} == 1 ]] && say "  then lock again ${ANS_RELOCK_MIN} min after the update (can be cancelled)"
if [[ $any -eq 0 ]]; then say "Nothing to do."; exit 0; fi
[[ $DRY_RUN -eq 1 ]] && { say "Dry run: stopping here."; exit 0; }
ask_yn "Start?" y || exit 0

if [[ $LOCKED -eq 1 ]]; then
  locked_handoff     # stages everything, unlocks and reboots; does not return
fi

rc=0
run_all || rc=$?
[[ $rc -eq 0 ]] && rm -f "$STATE_DIR/resume-failed"
summary "$rc"
if [[ $rc -eq 0 && ${ANS_LOCK_AT_END:-0} == 1 ]]; then
  echo
  info "Locking the system (fslock lock), it will reboot"
  /usr/local/sbin/fslock lock -y
fi
exit "$rc"
