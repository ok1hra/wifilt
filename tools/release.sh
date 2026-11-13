#!/usr/bin/env bash
#
# One release, seven phases: every question first, then the whole chain at once.
#
# Everything is built without addons/, also when it is beside the sketch
# (-DWIFILT_NO_ADDONS, NO_ADDONS=1, --edition public; addon_hooks.h).
# Phase 7 publishes the page only when the source changed since the last
# publication.
#
# Extensions: when addons/release-ext.sh exists it is sourced before phase 0
# and its ext_<point> functions are called at fixed points (see ext_hook below).
# It may append phases of its own to PHASES. Without it this is the whole
# release.
#
# Everything this script does can be done by hand -- and was, for a long time.
# What it adds is not automation but ORDER: the phases depend on each other in
# ways that are invisible while you are running them one at a time, and every
# one of the guards below exists because skipping a phase used to produce a
# release that looked finished and was not:
#
#   * native/dist archives are named after REV (native/Makefile reads the same
#     #define the firmware carries), and tools/gh-pages.sh looks for exactly
#     those names. Bump REV without rebuilding them and the download page comes
#     out with no desktop downloads at all -- as a printed line, not an error.
#
#   * REV lives only in wifilt.ino and is compiled in as a number, so it cannot
#     be read back out of the .bin. File times are the only cheap check that the
#     exported image is the REV everything else claims it is.
#
#   * the page is published from a throwaway git repository, so it can carry a
#     build of source that exists nowhere. Publishing therefore comes AFTER the
#     push, and refuses to run until HEAD is what origin/main holds.
#
# All choices come FIRST, on one screen: after the tool check every phase and
# its options are listed at once (↑/↓ to move, space to switch or edit, r to
# look for serial ports again, Enter to run, q to leave). The sudo password,
# when the plan needs it, is asked right after Enter; then the whole chain runs
# without another question, and ends with the ESP32 flash map and a list of
# what was written where. Nothing here
# writes to the device, to this computer, to git or to the web unless the plan
# says so. What only the run itself can know (a failed build, a guard in front
# of phase 7) is decided by the plan's answers or by the guard, never by a
# question in the middle of the run.
#
#   tools/release.sh            plan interactively, then the whole chain
#   tools/release.sh --force    bypass the pre-publish guards (see phase 7)

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKETCH="${ROOT_DIR}/wifilt.ino"
FIRMWARE_BIN="${ROOT_DIR}/wifilt.ino.esp32.bin"
# M5Stack Atom Lite -- built alongside the box in phase 2, gated alongside it in
# phase 7. Same first-class treatment as the box: a failed Atom export aborts
# the release the same way a failed box export does, see phase 2 below.
FIRMWARE_BIN_M5ATOM="${ROOT_DIR}/wifilt.ino.m5stack_atom.bin"
DIST_DIR="${ROOT_DIR}/native/dist"                  # what gh-pages.sh publishes
RELEASE_EXT="${ROOT_DIR}/addons/release-ext.sh"
RELEASE_BRANCH="main"
PAGE_URL="https://ok1hra.github.io/wifilt/"
FORCE=false

usage() {
  cat <<'EOF'
Usage: tools/release.sh [--force]

Lists all seven phases and their options on one screen (arrows, space, Enter),
then runs them in one go without further questions. Enter accepts the capitalised default. addons/release-ext.sh,
when present, extends it.

  1  REV -> today's date                     (y/N)
     (REV already today: REV_BUILD + 1, on by default when the page already
      offers today's version -- a second release the same day, "REV.N")
  2  Export compiled binary                  (Y/n)
  3  make -C native NO_ADDONS=1 dist         (Y/n, Y/n)
  4  install this build on this computer     (Y/n)
  5  tools/upload-firmware-spiffs.sh         (Y/n)
  6  git commit / git push                   (Y/n, twice)
  7  tools/gh-pages.sh --publish             (Y/n, only if the source changed)

Options:
  --force   Skip the guards in front of phase 7 and allow phases 6 and 7 on a
            branch other than main. Everything they check is a reason not to
            publish, so use it only when you know which one you are overriding.
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- terminal ---
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_OFF=$'\033[0m'; C_BOLD=$'\033[1m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'
  C_DIM=$'\033[2m'
else
  C_OFF=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_DIM=""
fi

# Questions are read from the terminal rather than from stdin, so that the
# script still asks when its output is being piped into tee or a log.
if ! ( exec 3</dev/tty ) 2>/dev/null; then
  echo "ERROR: tools/release.sh is interactive and found no terminal to ask on" >&2
  exit 1
fi
exec 3</dev/tty

say()  { printf '%s\n' "$*"; }
info() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
warn() { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_OFF" >&2; }
fail() { printf '%s%s%s\n' "$C_RED" "$*" "$C_OFF" >&2; }
ok()   { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_OFF"; }

phase_banner() {
  printf '\n%s%s== %s/%s  %s%s\n' "$C_BOLD" "$C_CYAN" "$1" "${#PHASES[@]}" "$2" "$C_OFF"
}

# ask QUESTION DEFAULT   DEFAULT is Y or N; Enter takes it. Anything that is not
# y/Y/n/N asks again rather than guessing, because several of these phases are
# irreversible.
#
# Once the plan is confirmed (PLAN_LOCKED) nothing asks any more: a question
# that still reaches ask() -- an extension not yet moved to the plan -- takes
# its default and says so, rather than stopping a run the operator has walked
# away from.
PLAN_LOCKED=false
ask() {
  local question="$1" default="$2" prompt answer
  case "$default" in
    Y) prompt="(Y/n)" ;;
    N) prompt="(y/N)" ;;
    *) fail "internal: bad default '$default'"; exit 1 ;;
  esac
  if $PLAN_LOCKED; then
    warn "  (bez dotazu) $question -> $default"
    [[ "$default" == Y ]]
    return
  fi
  while true; do
    printf '%s%s%s %s ' "$C_BOLD" "$question" "$C_OFF" "$prompt"
    if ! IFS= read -r answer <&3; then
      printf '\n'; fail "vstup uzavřen -- končím"; print_summary; exit 1
    fi
    [[ -z "$answer" ]] && answer="$default"
    case "$answer" in
      y|Y) return 0 ;;
      n|N) return 1 ;;
      *) say "  odpověz y nebo n (Enter = ${default})" ;;
    esac
  done
}

# Phase outcomes, printed as a summary at the end. A release that stopped in the
# middle should say so in one place rather than in the scrollback.
declare -A RESULT
mark() { RESULT["$1"]="$2"; }

abort() {
  fail "$1"
  say ""
  fail "Release přerušen ve fázi $2."
  print_summary
  print_written
  exit 1
}

# The plan: what each phase will do, decided before any of them runs.
#   PLAN[n]       yes | no
#   PLAN_NOTE[n]  one line shown beside it in the plan summary
declare -A PLAN=()
declare -A PLAN_NOTE=()
want() { [[ "${PLAN[$1]:-no}" == yes ]]; }

print_plan() {
  say ""
  printf '%s%s-- plán --------------------------------------------------%s\n' "$C_BOLD" "$C_CYAN" "$C_OFF"
  local entry n label state colour note pad
  for entry in "${PHASES[@]}"; do
    n="${entry%% *}"; label="${entry#* }"
    note="${PLAN_NOTE[$n]:-}"
    if [[ -n "${BLOCKED[$n]:-}" ]]; then
      state="nedostupné"; colour="$C_DIM"; note="${BLOCKED[$n]}"
    elif want "$n"; then
      state="ANO"; colour="$C_GREEN"
    else
      state="ne"; colour="$C_DIM"
    fi
    pad=$(( 24 - ${#label} )); (( pad < 1 )) && pad=1
    printf '  %2s  %s%*s%s%-4s%s %s%s%s\n' "$n" "$label" "$pad" "" "$colour" "$state" "$C_OFF" \
      "$C_DIM" "$note" "$C_OFF"
  done
}

# ================================================================= menu ======
# The plan is one screen: every choice of the release at once, ↑/↓ to move,
# space to switch, Enter to run. It is drawn on the terminal itself (fd 4, the
# alternate screen), so a log taken with tee gets the plan summary printed
# after it and not a hundred redraws, and the tool check stays on screen.
#
# Items are added in order with menu_add; an extension adds its own at the
# ext_hook points plan_install, plan_flash, plan_commit and plan.
if [[ -z "${NO_COLOR:-}" ]]; then
  T_OFF=$'\033[0m'; T_BOLD=$'\033[1m'; T_DIM=$'\033[2m'; T_REV=$'\033[7m'
  T_GREEN=$'\033[32m'; T_YELLOW=$'\033[33m'; T_CYAN=$'\033[36m'
else
  T_OFF=""; T_BOLD=""; T_DIM=""; T_REV=""; T_GREEN=""; T_YELLOW=""; T_CYAN=""
fi

MENU_KEYS=()
MENU_VIS=()
MENU_CUR=0
MENU_TOP=0
MENU_ACTIVE=false
declare -A M_TYPE=() M_LEVEL=() M_LABEL=() M_VAL=() M_SHOW=() M_OFF=() M_NOTE=() \
           M_CHOICES=() M_DISPLAY=() M_HINT=()

# menu_add KEY TYPE LEVEL LABEL VALUE [SHOW]
#   TYPE   bool (VALUE yes|no) · choice (VALUE one of M_CHOICES, space cycles)
#          · text (space edits; empty shows M_HINT) · head (a heading)
#   SHOW   a command; the item is shown, and counts, only while it succeeds
#   M_OFF[KEY]   non-empty = unavailable, and why (counts as switched off)
#   M_NOTE[KEY]  shown dimmed after the item
menu_add() {
  local k="$1"
  MENU_KEYS+=("$k")
  M_TYPE[$k]="$2"; M_LEVEL[$k]="$3"; M_LABEL[$k]="$4"; M_VAL[$k]="${5:-}"; M_SHOW[$k]="${6:-true}"
  M_OFF[$k]=""; M_NOTE[$k]=""
}
# menu_phase N LABEL Y|N  -- the item of one phase, key pN; PLAN[N] follows it.
menu_phase() {
  local def=no
  [[ "$3" == Y ]] && def=yes
  menu_add "p$1" bool 0 "$1) $2" "$def"
  [[ -n "${BLOCKED[$1]:-}" ]] && M_OFF["p$1"]="${BLOCKED[$1]}"
  return 0
}
# menu_set_choices KEY "v1|v2" ["shown1|shown2"]
menu_set_choices() { M_CHOICES[$1]="$2"; M_DISPLAY[$1]="${3:-$2}"; }

menu_visible() { eval "${M_SHOW[$1]}"; }
# on KEY  -- the item is shown, available and switched on
on() { [[ "${M_VAL[$1]:-}" == yes && -z "${M_OFF[$1]:-}" ]] && menu_visible "$1"; }

menu_choice_shown() {
  local k="$1" i
  local -a vals shown
  IFS='|' read -r -a vals <<< "${M_CHOICES[$k]:-}"
  IFS='|' read -r -a shown <<< "${M_DISPLAY[$k]:-}"
  for i in "${!vals[@]}"; do
    if [[ "${vals[$i]}" == "${M_VAL[$k]}" ]]; then printf '%s' "${shown[$i]:-${vals[$i]}}"; return; fi
  done
  printf '%s' "${M_VAL[$k]:-—}"
}

menu_cycle() {
  local k="$1" i n
  local -a vals
  IFS='|' read -r -a vals <<< "${M_CHOICES[$k]:-}"
  n=${#vals[@]}
  (( n == 0 )) && return
  for i in "${!vals[@]}"; do
    if [[ "${vals[$i]}" == "${M_VAL[$k]}" ]]; then M_VAL[$k]="${vals[$(( (i + 1) % n ))]}"; return; fi
  done
  M_VAL[$k]="${vals[0]}"
}

# menu_line KEY SELECTED COLS
menu_line() {
  local k="$1" sel="$2" cols="$3" ind box="   " colour="" label value="" note plain room
  ind="$(printf '%*s' $(( ${M_LEVEL[$k]} * 4 )) '')"
  label="${M_LABEL[$k]}"
  note="${M_NOTE[$k]}"
  if [[ "${M_TYPE[$k]}" == head ]]; then
    printf '\n %s%s── %s%s\n' "$T_BOLD" "$T_CYAN" "$label" "$T_OFF"
    return
  fi
  case "${M_TYPE[$k]}" in
    bool)
      if [[ "${M_VAL[$k]}" == yes ]]; then box="[x]"; colour="$T_GREEN"; else box="[ ]"; fi ;;
    choice)
      box=" ▸ "; value=": ‹$(menu_choice_shown "$k")›" ;;
    text)
      box=" ✎ "
      if [[ -n "${M_VAL[$k]}" ]]; then value=": «${M_VAL[$k]}»"; else value=": «${M_HINT[$k]:-}»"; fi ;;
  esac
  if [[ -n "${M_OFF[$k]}" ]]; then
    box="[-]"; colour="$T_DIM"; note="${M_OFF[$k]}"
  fi
  # Cut the note, then the value, to the width: a wrapped line would shift
  # every line below it and the redraw with it.
  plain="  ${ind}${box} ${label}${value}"
  room=$(( cols - ${#plain} - 3 ))
  if (( room < 4 )); then
    note=""
    (( ${#plain} > cols - 1 )) && value="${value:0:$(( ${#value} - ${#plain} + cols - 2 ))}…"
  elif (( ${#note} > room )); then
    note="${note:0:$(( room - 1 ))}…"
  fi
  local nc="$T_DIM"
  [[ -z "${M_OFF[$k]}" && ( "$note" == POZOR* || "$note" == *porty* ) ]] && nc="$T_YELLOW"
  if (( sel )); then
    printf '%s▶%s %s%s%s%s %s%s%s%s  %s%s%s\n' "$T_BOLD$T_CYAN" "$T_OFF" "$ind" "$colour" "$box" "$T_OFF" \
      "$T_REV" "$label" "$value" "$T_OFF" "$nc" "$note" "$T_OFF"
  else
    printf '  %s%s%s%s %s%s%s  %s%s%s\n' "$ind" "$colour" "$box" "$T_OFF" \
      "$( [[ -n "${M_OFF[$k]}" ]] && printf '%s' "$T_DIM")" "$label" "$value$T_OFF" "$nc" "$note" "$T_OFF"
  fi
}

menu_render() {
  menu_refresh
  local rows=24 cols=80 k i body summary=()
  read -r rows cols < <(stty size <&3 2>/dev/null)
  [[ "$rows" =~ ^[0-9]+$ ]] || rows=24
  [[ "$cols" =~ ^[0-9]+$ ]] || cols=80
  MENU_VIS=()
  for k in "${MENU_KEYS[@]}"; do menu_visible "$k" && MENU_VIS+=("$k"); done
  (( MENU_CUR >= ${#MENU_VIS[@]} )) && MENU_CUR=$(( ${#MENU_VIS[@]} - 1 ))
  while [[ "${M_TYPE[${MENU_VIS[$MENU_CUR]}]}" == head ]] && (( MENU_CUR < ${#MENU_VIS[@]} - 1 )); do
    MENU_CUR=$(( MENU_CUR + 1 ))
  done
  # A heading takes two lines; the window is counted in items and kept short
  # enough for that.
  body=$(( (rows - 6) * 3 / 4 )); (( body < 3 )) && body=3
  (( MENU_CUR < MENU_TOP )) && MENU_TOP=$MENU_CUR
  (( MENU_CUR >= MENU_TOP + body )) && MENU_TOP=$(( MENU_CUR - body + 1 ))
  # Headings stay with the first item under them.
  (( MENU_TOP > 0 )) && [[ "${M_TYPE[${MENU_VIS[$((MENU_TOP - 1))]}]}" == head ]] && MENU_TOP=$(( MENU_TOP - 1 ))
  for k in "${MENU_KEYS[@]}"; do
    [[ "$k" =~ ^p([0-9]+)$ ]] && on "$k" && summary+=("${BASH_REMATCH[1]}")
  done
  {
    printf '\033[H\033[2J'
    printf '%s%s WIFILT release%s  REV %s · větev %s\n' "$T_BOLD" "$T_CYAN" "$T_OFF" "$REV" "$BRANCH"
    printf '%s ↑↓ pohyb · mezerník přepnout/upravit · r porty znovu · Enter SPUSTIT · q konec%s\n' "$T_DIM" "$T_OFF"
    (( MENU_TOP > 0 )) && printf '%s   ↑ další nahoře%s\n' "$T_DIM" "$T_OFF" || printf '\n'
    for (( i = MENU_TOP; i < ${#MENU_VIS[@]} && i < MENU_TOP + body; i++ )); do
      menu_line "${MENU_VIS[$i]}" $(( i == MENU_CUR )) "$cols"
    done
    (( i < ${#MENU_VIS[@]} )) && printf '%s   ↓ další dole%s\n' "$T_DIM" "$T_OFF" || printf '\n'
    printf '\n %sproběhne:%s %s\n' "$T_BOLD" "$T_OFF" "${summary[*]:-nic}"
  } >&4
}

menu_move() {   # menu_move +1|-1
  local i=$MENU_CUR n=${#MENU_VIS[@]}
  while :; do
    i=$(( i + $1 ))
    (( i < 0 || i >= n )) && return
    if [[ "${M_TYPE[${MENU_VIS[$i]}]}" != head ]]; then MENU_CUR=$i; return; fi
  done
}

menu_edit() {   # menu_edit KEY  -- one line, readline, at the bottom
  local k="$1" rows=24 cols new
  read -r rows cols < <(stty size <&3 2>/dev/null)
  [[ "$rows" =~ ^[0-9]+$ ]] || rows=24
  printf '\033[%d;1H\033[K' "$rows" >&4
  tput cnorm >&4 2>/dev/null
  IFS= read -r -e -i "${M_VAL[$k]}" -p "  ${M_LABEL[$k]}: " new <&3 >&4 2>&4 || new="${M_VAL[$k]}"
  tput civis >&4 2>/dev/null
  M_VAL[$k]="$new"
}

menu_toggle() {
  local k="$1"
  [[ -n "${M_OFF[$k]}" ]] && return
  case "${M_TYPE[$k]}" in
    bool)   if [[ "${M_VAL[$k]}" == yes ]]; then M_VAL[$k]=no; else M_VAL[$k]=yes; fi ;;
    choice) menu_cycle "$k" ;;
    text)   menu_edit "$k" ;;
  esac
}

menu_enter() {
  exec 4>/dev/tty
  MENU_ACTIVE=true
  tput smcup >&4 2>/dev/null
  tput civis >&4 2>/dev/null
}
menu_leave() {
  $MENU_ACTIVE || return 0
  MENU_ACTIVE=false
  tput cnorm >&4 2>/dev/null
  tput rmcup >&4 2>/dev/null
  stty echo icanon <&3 2>/dev/null || true
}

# menu_run -- returns when Enter is pressed; q leaves the script.
menu_run() {
  local key c k
  menu_enter
  while true; do
    menu_render
    IFS= read -rsn1 -u 3 key || { menu_leave; fail "vstup uzavřen -- končím"; exit 1; }
    if [[ "$key" == $'\e' ]]; then
      while IFS= read -rsn1 -t 0.03 -u 3 c; do key+="$c"; done
    fi
    k="${MENU_VIS[$MENU_CUR]}"
    case "$key" in
      $'\e[A'|$'\eOA'|k)  menu_move -1 ;;
      $'\e[B'|$'\eOB'|j)  menu_move 1 ;;
      $'\e[5~')  for _ in 1 2 3 4 5 6 7 8; do menu_move -1; done ;;
      $'\e[6~')  for _ in 1 2 3 4 5 6 7 8; do menu_move 1; done ;;
      $'\e[H'|$'\e[1~')  MENU_CUR=0 ;;
      $'\e[F'|$'\e[4~')  MENU_CUR=$(( ${#MENU_VIS[@]} - 1 )) ;;
      " ")       menu_toggle "$k" ;;
      "")        break ;;
      r|R)       detect_ports ;;
      q|Q|$'\e') menu_leave; info "Nic se neprovedlo."; exit 0 ;;
    esac
  done
  menu_leave
}

# Serial ports, found when the menu is built and again on r. The by-id path is
# what gets flashed: /dev/ttyUSB0 is whichever cable enumerated first, and an
# IC-705 alone shows up as two ttyACM ports.
PORT_VALS=()
detect_ports() {
  local link dev best="" shown=() i
  local -A lbl=()
  if [[ -d /dev/serial/by-id ]]; then
    for link in /dev/serial/by-id/*; do
      [[ -e "$link" ]] && lbl["$(readlink -f "$link")"]="$link"
    done
  fi
  PORT_VALS=()
  while IFS= read -r dev; do
    [[ -n "$dev" ]] || continue
    PORT_VALS+=("${lbl[$dev]:-$dev}")
    shown+=("${dev}${lbl[$dev]:+  $(basename "${lbl[$dev]}")}")
    # USB-UART bridges of ESP32 boards, as opposed to a radio's own ports.
    [[ -z "$best" && "${lbl[$dev]:-}" =~ CP210|Silicon_Labs|CH34|1a86|FTDI|wch ]] && best="${lbl[$dev]}"
  done < <(ls -1 /dev/ttyUSB* /dev/ttyACM* 2>/dev/null | sort)
  M_CHOICES[port]="$(IFS='|'; printf '%s' "${PORT_VALS[*]}")"
  M_DISPLAY[port]="$(IFS='|'; printf '%s' "${shown[*]}")"
  local keep=false
  for i in "${PORT_VALS[@]}"; do [[ "$i" == "${M_VAL[port]:-}" ]] && keep=true; done
  $keep || M_VAL[port]="${best:-${PORT_VALS[0]:-}}"
  if (( ${#PORT_VALS[@]} > 1 )); then
    M_NOTE[port]="${#PORT_VALS[@]} porty -- mezerníkem vyber ten s ESP32"
  else
    M_NOTE[port]=""
  fi
}

# ======================================================= what went where ====
# wrote SCOPE WHAT WHERE -- one line of the list printed at the end, grouped by
# SCOPE (the repository the output belongs to) in the order first seen.
WRITTEN=()
INSTALL_SCOPE="wifilt"
FLASH_SCOPE="wifilt"
wrote() { WRITTEN+=("$1|$2|$3"); }

fmt_num() { printf '%s' "$1" | rev | sed -E 's/([0-9]{3})/\1 /g' | rev | sed 's/^ *//'; }

# wrote_dist SCOPE DIR -- the archives of REV in DIR, and their sums.
wrote_dist() {
  local f
  for f in "$2"/wifilt-"$REV"-*.tar.gz "$2"/wifilt-"$REV"-*.zip "$2"/SHA256SUMS; do
    [[ -f "$f" ]] && wrote "$1" "PC balík" "${f#"${ROOT_DIR}"/} ($(fmt_num "$(stat -c %s "$f")") B)"
  done
  return 0
}

print_written() {
  say ""
  printf '%s%s-- co se kam zapsalo --------------------------------------%s\n' "$C_BOLD" "$C_CYAN" "$C_OFF"
  if [[ ${#WRITTEN[@]} -eq 0 ]]; then
    info "  nic"
    return
  fi
  local scopes=() e s scope what where pad
  for e in "${WRITTEN[@]}"; do
    scope="${e%%|*}"
    [[ " ${scopes[*]} " == *" $scope "* ]] || scopes+=("$scope")
  done
  for s in "${scopes[@]}"; do
    say "  ${C_BOLD}${s}${C_OFF}"
    for e in "${WRITTEN[@]}"; do
      IFS='|' read -r scope what where <<< "$e"
      [[ "$scope" == "$s" ]] || continue
      pad=$(( 12 - ${#what} )); (( pad < 1 )) && pad=1
      printf '    %s%*s%s\n' "$what" "$pad" "" "$where"
    done
  done
}

# ========================================================= ESP32 flash map ===
# Rows of the table: firmware images against app0, asset trees against the
# spiffs partition (--edition VALUE|label). An extension appends its own.
ESP_APP_ROWS=("box|${FIRMWARE_BIN}" "M5Atom|${FIRMWARE_BIN_M5ATOM}")
ESP_FS_ROWS=("public|assets")
declare -A FS_MEASURED=()     # --edition value -> "bytes files"
RUN_START="$(date +%s)"
PARTITION_CSV="${ROOT_DIR}/partitions.csv"

part_field() {   # part_field NAME COLUMN(4=offset, 5=size)
  awk -F, -v wanted="$1" -v column="$2" '
    $1 ~ "^[[:space:]]*" wanted "[[:space:]]*$" { gsub(/[[:space:]]/, "", $column); print $column; exit }' \
    "$PARTITION_CSV"
}

# fs_record EDITION DIR -- an asset tree already staged by this run
fs_record() {
  [[ -d "$2" ]] || return 1
  FS_MEASURED[$1]="$(du -sb "$2" | awk '{print $1}') $(find "$2" -type f | wc -l)"
}

# fs_measure EDITION -- stage the tree only to measure it (about a minute: every
# asset is compressed the way the device gets it).
fs_measure() {
  local dir="${ROOT_DIR}/build/release-usage/$1" noaddons=1
  [[ "$1" == public ]] || noaddons=0
  rm -rf "$dir"; mkdir -p "$(dirname "$dir")"
  WIFILT_NO_ADDONS=$noaddons "${ROOT_DIR}/tools/prepare-spiffs-tree.sh" "${ROOT_DIR}/data" "$dir" >/dev/null 2>&1 \
    || { rm -rf "$dir"; return 1; }
  fs_record "$1" "$dir"
  rm -rf "$dir"
  rmdir "$(dirname "$dir")" 2>/dev/null || true
}

usage_row() {   # usage_row LABEL USED TOTAL EXTRA
  local pct filled colour bar="" i width=24
  pct="$(awk -v u="$2" -v t="$3" 'BEGIN { printf "%.1f", (t > 0 ? u * 100 / t : 0) }')"
  filled=$(awk -v p="$pct" -v w="$width" 'BEGIN { f = int(p * w / 100); if (f > w) f = w; print f }')
  if   awk -v p="$pct" 'BEGIN { exit !(p >= 90) }'; then colour="$C_RED"
  elif awk -v p="$pct" 'BEGIN { exit !(p >= 75) }'; then colour="$C_YELLOW"
  else colour="$C_GREEN"; fi
  for (( i = 0; i < width; i++ )); do (( i < filled )) && bar+="#" || bar+="."; done
  local pad=$(( 16 - ${#1} )); (( pad < 1 )) && pad=1
  printf '      %s%*s%11s B %s%5s %%%s %s%s%s volno %9s B  %s%s%s\n' "$1" "$pad" "" "$(fmt_num "$2")" \
    "$colour" "$pct" "$C_OFF" "$colour" "$bar" "$C_OFF" "$(fmt_num $(( $3 - $2 )))" "$C_DIM" "$4" "$C_OFF"
}

print_esp_usage() {
  say ""
  printf '%s%s-- obsazenost ESP32 (partitions.csv, 4 MB flash) ----------%s\n' "$C_BOLD" "$C_CYAN" "$C_OFF"
  local name off size row label file age
  for name in nvs otadata app0 spiffs cfg; do
    off="$(part_field "$name" 4)"; size="$(part_field "$name" 5)"
    [[ -n "$off" && -n "$size" ]] || continue
    printf '  %s%-8s%s %-9s %11s B  ' "$C_BOLD" "$name" "$C_OFF" "$off" "$(fmt_num $(( size )))"
    case "$name" in
      app0)
        say "${C_DIM}program${C_OFF}"
        for row in "${ESP_APP_ROWS[@]}"; do
          label="${row%%|*}"; file="${row#*|}"
          if [[ ! -f "$file" ]]; then
            printf '      %s%*s%s chybí %s%s\n' "$label" $(( 17 - ${#label} )) "" "$C_DIM" "$(basename "$file")" "$C_OFF"
            continue
          fi
          if (( $(stat -c %Y "$file") >= RUN_START )); then age="tento běh"
          else age="starší, $(date -r "$file" '+%-d.%-m. %H:%M')"; fi
          usage_row "$label" "$(stat -c %s "$file")" $(( size )) "$age"
        done ;;
      spiffs)
        # The gate, not the partition: 256 KiB stay free for what the device
        # writes, 64 KiB for LittleFS metadata (upload-firmware-spiffs.sh).
        local gate=$(( size - 256 * 1024 - 64 * 1024 ))
        say "${C_DIM}web assets; limit $(fmt_num $gate) B = oddíl − 256 KiB rezerva − 64 KiB metadata${C_OFF}"
        for row in "${ESP_FS_ROWS[@]}"; do
          local ed="${row%%|*}" m
          label="${row#*|}"
          m="${FS_MEASURED[$ed]:-}"
          if [[ -n "$m" ]]; then
            usage_row "$label" "${m%% *}" "$gate" "${m##* } souborů"
          else
            printf '      %s%*s%s neměřeno%s\n' "$label" $(( 17 - ${#label} )) "" "$C_DIM" "$C_OFF"
          fi
        done ;;
      cfg)     say "${C_DIM}konfigurace operátora -- release nezapisuje${C_OFF}" ;;
      *)       say "${C_DIM}systém${C_OFF}" ;;
    esac
  done
}

# sudo once, before the run, and kept fresh while it lasts: phase 4 needs it
# after builds that can take longer than sudo's own timeout.
SUDO_KEEPALIVE_PID=""
sudo_prime() {
  info "  sudo: heslo teď, ať se release během běhu na nic neptá"
  sudo -v || return 1
  ( while sleep 50; do sudo -n -v 2>/dev/null || exit 0; done ) &
  SUDO_KEEPALIVE_PID=$!
  return 0
}

cleanup() {
  [[ -n "$SUDO_KEEPALIVE_PID" ]] && kill "$SUDO_KEEPALIVE_PID" 2>/dev/null
  menu_leave
}
trap cleanup EXIT

PHASES=(
  "1 REV"
  "2 export firmware"
  "3 make -C native dist"
  "6 instalace na PC"
  "7 flash do zařízení"
  "8 git commit/push"
  "9 publikace stránky"
)

print_summary() {
  say ""
  printf '%s%s-- souhrn ------------------------------------------------%s\n' "$C_BOLD" "$C_CYAN" "$C_OFF"
  local entry n label state colour
  for entry in "${PHASES[@]}"; do
    n="${entry%% *}"; label="${entry#* }"
    state="${RESULT[$n]:-neproběhlo}"
    case "$state" in
      hotovo)      colour="$C_GREEN" ;;
      selhalo)     colour="$C_RED" ;;
      přeskočeno|nedostupné|neproběhlo) colour="$C_DIM" ;;
      *)           colour="$C_YELLOW" ;;
    esac
    # %-24s pads by bytes, and half these labels are Czech: "integrační test"
    # is 15 characters and 17 bytes, so the column would drift by two per accent.
    local pad=$(( 24 - ${#label} ))
    (( pad < 1 )) && pad=1
    printf '  %2s  %s%*s%s%s%s\n' "$n" "$label" "$pad" "" "$colour" "$state" "$C_OFF"
  done
}

PLAN_STOP_SERVICES=yes  # phase 4: stop wifilt/local-trx while installing
PLAN_PORT=""            # phase 5: the port to flash, by-id path when there is one
declare -A PLAN_LTX_CROSS=()  # phase 3: win|arm64 -> yes/no, build cross libs

# local-trx bundling (fáze 3, docs/local-trx-implementace.md bod 1/12: local-trx/
# Makefile zůstává mimo native/Makefile's all/dist cíle, takže tohle žije tady,
# ne tam -- smazání local-trx/ nechá `make -C native dist` beze změny).
#
# Cross-kompilovaný hamlib+libserialport (Windows/ARM64) je jednorázová, řádově
# minutová práce, jejíž výsledek third_party/build-cross-libs.sh sám ukládá pro
# příště -- proto se ptá, ne mlčky staví, ale i mlčky nepřeskakuje.
ensure_local_trx_cross_libs() {   # ensure_local_trx_cross_libs win|arm64
  local target="$1"
  local hamlib_lib="${ROOT_DIR}/local-trx/third_party/cross/hamlib-${target}/lib/libhamlib.a"
  local serial_lib="${ROOT_DIR}/local-trx/third_party/cross/libserialport-${target}/lib/libserialport.a"
  [[ -f "$hamlib_lib" && -f "$serial_lib" ]] && return 0
  warn "  local-trx's cross-zkompilovaný hamlib/libserialport pro $target chybí."
  if [[ "${PLAN_LTX_CROSS[$target]:-no}" == yes ]]; then
    "${ROOT_DIR}/local-trx/third_party/build-cross-libs.sh" "$target" && return 0
    warn "  build-cross-libs.sh $target selhal"
  else
    info "  jejich kompilace nebyla v plánu"
  fi
  return 1
}
cross_libs_missing() {   # cross_libs_missing win|arm64
  [[ ! -f "${ROOT_DIR}/local-trx/third_party/cross/hamlib-$1/lib/libhamlib.a" \
  || ! -f "${ROOT_DIR}/local-trx/third_party/cross/libserialport-$1/lib/libserialport.a" ]]
}

# bundle_local_trx_into ARCHIVE STAGING_DIR_NAME LOCAL_TRX_BIN KIND(tar|zip)
#
# native/Makefile's own dist-* targets create+tar+delete their staging
# directory in one atomic `make` step, so there is no window to inject an
# extra file into that same archive from here -- this instead unpacks the
# already-finished archive, adds local-trx (+ its webui/, sibling to the
# binary so main.cpp's own "webui/ next to the executable" default just
# works with no extra flag needed), and re-packs in place.
bundle_local_trx_into() {
  local archive="$1" staging_name="$2" ltx_bin="$3" kind="$4"
  [[ -f "$archive" ]] || { warn "  $(basename "$archive") neexistuje"; return 1; }
  [[ -f "$ltx_bin"  ]] || { warn "  $(basename "$ltx_bin") neexistuje -- build selhal?"; return 1; }

  local work; work="$(mktemp -d)"
  if [[ "$kind" == "tar" ]]; then
    tar xzf "$archive" -C "$work" || { warn "  rozbalení $(basename "$archive") selhalo"; rm -rf "$work"; return 1; }
  else
    ( cd "$work" && unzip -q "$archive" ) || { warn "  rozbalení $(basename "$archive") selhalo"; rm -rf "$work"; return 1; }
  fi

  local dest="${work}/${staging_name}"
  if [[ ! -d "$dest" ]]; then
    warn "  $staging_name nenalezen uvnitř $(basename "$archive")"
    rm -rf "$work"
    return 1
  fi
  cp "$ltx_bin" "$dest/" || { rm -rf "$work"; return 1; }
  cp -r "${ROOT_DIR}/local-trx/webui" "${dest}/webui" || { rm -rf "$work"; return 1; }

  # Re-pack to a NEW path and only replace the original once that succeeded --
  # the previous version deleted the original archive first and never checked
  # the repack's own exit status, so a failed tar/zip (disk full, permission)
  # left NO archive at all while still reporting success (found by code
  # review). A real release archive is worth more than the disk space this
  # briefly doubles.
  local rebuilt="${archive}.new"
  local pack_status
  if [[ "$kind" == "tar" ]]; then
    ( cd "$work" && tar czf "$rebuilt" "$staging_name" )
    pack_status=$?
  else
    ( cd "$work" && zip -qr "$rebuilt" "$staging_name" )
    pack_status=$?
  fi
  rm -rf "$work"
  if [[ $pack_status -ne 0 || ! -s "$rebuilt" ]]; then
    warn "  přebalení $(basename "$archive") s local-trx selhalo -- původní archiv beze změny"
    rm -f "$rebuilt"
    return 1
  fi
  mv -f "$rebuilt" "$archive"
  return 0
}

# ext_hook POINT  -- calls ext_POINT when an extension defined it. The points,
# in the order they come:
#   preflight      phase 0, after the tools are reported (may set BLOCKED
#                  and append to ESP_APP_ROWS / ESP_FS_ROWS)
#   plan_install   menu, after the phase 4 item (menu_add its own items)
#   plan_flash     menu, after the phase 5 port item
#   plan_commit    menu, after this repository (plan_commit_repo)
#   plan           menu, after phase 7 (its own phases: menu_phase N ...)
#   menu_refresh   before every redraw (may set INSTALL_ARCHIVE, M_OFF, M_NOTE)
#   plan_resolve   after Enter, choices -> plan (may set FLASH_ARGS,
#                  INSTALL_SCOPE, FLASH_SCOPE, PLAN_NOTE)
#   firmware       phase 2, after the export succeeded
#   dist           phase 3, after the archives were built (dist_targets,
#                  want_ltx and dist_build are there to reuse)
#   install        phase 4, before the archive is checked
#   flash          phase 5, before flashing
#   stamp         phase 6, after data/*.html got its ?v=
#   commit         phase 6, after this repository (commit_repo is there)
#   end            after phase 7, before the summary and the tables
# An extension shares this shell: its failures go through abort like ours, and
# what it writes goes into the list at the end through wrote SCOPE WHAT WHERE.
# Nothing after the menu asks: ask() then takes its default.
ext_hook() {
  declare -F "ext_$1" >/dev/null || return 0
  "ext_$1"
}

# build_oi3_hex  -- native/dist-oi3 for the Linux archives (once per run): the
# OI3 firmware the web updater flashes (tools/build-oi3-hex.sh). A missing
# OI3 checkout or a failed build is not fatal: the archives then carry no
# oi3/ and the updater leaves the OI3 alone.
OI3_HEX_DONE=false
build_oi3_hex() {
  $OI3_HEX_DONE && return 0
  OI3_HEX_DONE=true
  local out="${ROOT_DIR}/native/dist-oi3" log="${ROOT_DIR}/native/dist-oi3.log"
  rm -rf "$out"
  if [[ ! -f "${OI3_DIR:-$HOME/Arduino/hra/ok1hra/oi3}/oi3.ino" ]]; then
    warn "  zdroj OI3 nenalezen (OI3_DIR) -- balíčky bez firmwaru OI3"
    return 0
  fi
  if "${ROOT_DIR}/tools/build-oi3-hex.sh" "$out" >"$log" 2>&1; then
    info "  firmware OI3 $(cat "$out/VERSION") ($(cat "$out/SOURCE")) -> oi3/ v linuxových balíčcích"
    grep -- '-dirty' "$out/SOURCE" >/dev/null && warn "  OI3 má necommitnuté změny"
    rm -f "$log"
  else
    rm -rf "$out"
    warn "  build OI3 selhal (viz $log) -- balíčky bez firmwaru OI3"
  fi
  return 0
}

# dist_build DIR [MAKE-VARIABLE...]  -- the archives of REV into DIR: stale
# revisions out, make, local-trx in (when wanted), SHA256SUMS last.
dist_build() {
  local dir="$1"; shift
  build_oi3_hex
  # Archives of other revisions go before make runs: SHA256SUMS would otherwise
  # describe releases that are not published. native/dist* is in .gitignore.
  if [[ -d "$dir" ]]; then
    local stale
    while IFS= read -r -d '' stale; do
      info "  mažu $(basename "$stale")"
      rm -rf "$stale"
    done < <(find "$dir" -mindepth 1 -maxdepth 1 \
               \( -type d -o -name '*.tar.gz' -o -name '*.zip' \) \
               ! -name "*-${REV}-*" -print0)
  fi
  make -C "${ROOT_DIR}/native" "$@" "${dist_targets[@]}" || return 1
  rm -rf "${dir}/assets"
  $want_ltx && bundle_local_trx_set "$dir"
  # After local-trx: the sums must describe what is actually published.
  ( cd "$dir" && sha256sum ./*.tar.gz ./*.zip >SHA256SUMS 2>/dev/null || true )
  return 0
}

# plan_commit_repo DIR LABEL  -- the menu items of one repository under phase 6:
# commit (with its message) and push, keyed by its index in REPO_LABELS. The
# tree is shown as it is now; by the time phase 6 runs, phases 1 and 6 itself
# may have changed it, so the answer means "commit whatever is there then".
declare -A COMMIT_PLAN=() COMMIT_MSG=() PUSH_PLAN=()
REPO_LABELS=()
plan_commit_repo() {
  local dir="$1" label="$2" branch dirty i=${#REPO_LABELS[@]}
  REPO_LABELS+=("$label")
  branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")"
  dirty="$(git -C "$dir" status --porcelain | wc -l)"
  menu_add "c$i" bool 1 "commit ${label} (${branch})" yes "on p6"
  M_NOTE["c$i"]="teď ${dirty} změněných souborů; git add -A"
  menu_add "m$i" text 2 "zpráva" "" "on c$i"
  M_HINT["m$i"]="prázdná = REV <rev>"
  menu_add "u$i" bool 1 "push ${label} -> origin/${branch}" yes "on p6"
}

# commit_repo DIR LABEL PHASE [SCOPE]  -- status, commit, push for one
# repository, as planned by plan_commit_repo; PHASE is the one that needs the
# push, SCOPE the group in the list of what went where (default wifilt).
# Appends hotovo / beze změny / přeskočeno to REPO_RESULTS.
REPO_RESULTS=()
commit_repo() {
  local dir="$1" label="$2" needs="$3" scope="${4:-wifilt}" branch msg result
  branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")"
  say ""
  say "${C_BOLD}-- ${label} (${branch})${C_OFF}"
  result="přeskočeno"
  if [[ -z "$(git -C "$dir" status --porcelain)" ]]; then
    info "  Není co commitovat."
    result="beze změny"
  else
    git -C "$dir" status --short
    git -C "$dir" diff --stat | tail -20
    if [[ "${COMMIT_PLAN[$label]:-no}" == yes ]]; then
      msg="${COMMIT_MSG[$label]:-REV $REV}"
      info "  commit: $msg"
      git -C "$dir" add -A || abort "git add ($label) selhal" 6
      git -C "$dir" commit -m "$msg" || { mark 6 "selhalo"; abort "git commit ($label) selhal." 6; }
      wrote "$scope" "commit" "${label} ${branch} $(git -C "$dir" rev-parse --short HEAD) \"${msg}\""
      result="hotovo"
    else
      info "  commit nebyl v plánu"
    fi
  fi
  REPO_RESULTS+=("$result")
  # Push whatever is ahead of the remote, committed now or earlier.
  git -C "$dir" fetch --quiet origin "$branch" 2>/dev/null || true
  local ahead
  ahead="$(git -C "$dir" rev-list --count "origin/${branch}..HEAD" 2>/dev/null || echo 0)"
  if [[ "$ahead" != 0 ]]; then
    if [[ "${PUSH_PLAN[$label]:-no}" == yes ]]; then
      info "  git push ${label} na origin/${branch} (${ahead} commitů)"
      git -C "$dir" push origin "$branch" || { mark 6 "selhalo"; abort "git push ($label) selhal." 6; }
      wrote "$scope" "push" "${label} -> $(git -C "$dir" remote get-url origin 2>/dev/null) ${branch} (${ahead} commitů)"
      ok "  pushnuto"
    else
      info "  nepushnuto -- fáze ${needs} to bude vyžadovat"
    fi
  fi
}

# archives_missing_ltx DIR  -- the archives of REV in DIR that do not carry
# local-trx, one name per line. Such an archive must never be published: the
# web updater installs it with install.sh, which removes a local-trx it does
# not find in the archive -- REV 20261113 went out like that and took
# local-trx away from the station that updated.
archives_missing_ltx() {
  local dir="$1" a
  for a in "${dir}/wifilt-${REV}-linux-x86_64.tar.gz" "${dir}/wifilt-${REV}-linux-arm64.tar.gz"; do
    [[ -f "$a" ]] || continue
    tar tzf "$a" 2>/dev/null | grep -E '^[^/]+/local-trx$' >/dev/null || basename "$a"
  done
  a="${dir}/wifilt-${REV}-windows-x64.zip"
  if [[ -f "$a" ]]; then
    unzip -Z1 "$a" 2>/dev/null | grep -E '^[^/]+/local-trx\.exe$' >/dev/null || basename "$a"
  fi
  return 0
}

# bundle_local_trx_set DIST  -- local-trx into the three archives in DIST
# (dist_targets decides which exist). Called again for another DIST, make
# finds local-trx already built.
# ltx_make LOG [TARGET]  -- make -C local-trx into LOG; on failure the end of
# the log is shown, so the reason is on screen and not only "failed".
ltx_make() {
  local log="$1"; shift
  mkdir -p "$(dirname "$log")"   # local-trx/build/ is in .gitignore
  if make -C "${ROOT_DIR}/local-trx" "$@" >"$log" 2>&1; then return 0; fi
  warn "  make -C local-trx $* selhalo, konec $log:"
  tail -n 15 "$log" | sed 's/^/    /' >&2
  return 1
}

bundle_local_trx_set() {
  local dir="$1" entry target gate archive staging bin kind label
  LOCAL_TRX_BUNDLED=()
  info "  make -C local-trx (Linux x86_64)"
  if ltx_make "${ROOT_DIR}/local-trx/build/release-linux.log"; then
    if bundle_local_trx_into "${dir}/wifilt-${REV}-linux-x86_64.tar.gz" "wifilt-linux-x86_64" \
        "${ROOT_DIR}/local-trx/build/local-trx" tar; then
      LOCAL_TRX_BUNDLED+=("linux-x86_64")
    fi
  else
    warn "  make -C local-trx selhalo -- linuxový balíček bez local-trx"
  fi
  # Windows and ARM64: gate on dist_targets, cross-compile the libs, cross-build
  # local-trx, bundle. Fields: make-target | dist_targets gate | archive |
  # staging dir | built binary | tar/zip | display name.
  local cross=(
    "win|dist-windows|${dir}/wifilt-${REV}-windows-x64.zip|wifilt-windows-x64|${ROOT_DIR}/local-trx/build-win/local-trx.exe|zip|Windows"
    "arm64|dist-arm64|${dir}/wifilt-${REV}-linux-arm64.tar.gz|wifilt-linux-arm64|${ROOT_DIR}/local-trx/build-arm64/local-trx|tar|ARM64"
  )
  for entry in "${cross[@]}"; do
    IFS='|' read -r target gate archive staging bin kind label <<< "$entry"
    [[ " ${dist_targets[*]} " == *" $gate "* ]] || continue
    if ensure_local_trx_cross_libs "$target" && ltx_make "${ROOT_DIR}/local-trx/build/release-${target}.log" "$target"; then
      if bundle_local_trx_into "$archive" "$staging" "$bin" "$kind"; then
        LOCAL_TRX_BUNDLED+=("${staging#wifilt-}")
      fi
    else
      warn "  local-trx pro $label se nepodařilo přidat"
    fi
  done
  if [[ ${#LOCAL_TRX_BUNDLED[@]} -gt 0 ]]; then
    ok "  local-trx přibalen do: ${LOCAL_TRX_BUNDLED[*]}"
  else
    warn "  local-trx se nepodařilo přibalit do žádného balíku"
  fi
}

# shellcheck source=/dev/null
[[ -f "$RELEASE_EXT" ]] && source "$RELEASE_EXT"

# ---------------------------------------------------------------- phase 0 ----
# Preflight. A missing tool disables ONE phase, never the run: flashing a board
# on a machine without mingw-w64 is a perfectly reasonable thing to want.
phase_banner 0 "kontrola nástrojů"

declare -A BLOCKED=()      # phase -> reason it cannot run at all
DEGRADED_WINDOWS=""        # phase 3 skips the Windows archive when set
DEGRADED_ARM64=""          # phase 3 skips the Raspberry Pi archive when set

have() { command -v "$1" >/dev/null 2>&1; }

ARDUINO_BIN=""
if [[ -n "${ARDUINO_IDE:-}" && -x "${ARDUINO_IDE}/arduino" ]]; then
  ARDUINO_BIN="${ARDUINO_IDE}/arduino"
elif [[ -n "${ARDUINO_IDE:-}" && -x "${ARDUINO_IDE:-}" ]]; then
  ARDUINO_BIN="$ARDUINO_IDE"
else
  for candidate in "$HOME/inst/arduino-1.8.19/arduino" "$HOME/arduino-1.8.19/arduino" \
                   "/opt/arduino-1.8.19/arduino" "$(command -v arduino || true)"; do
    [[ -n "$candidate" && -x "$candidate" ]] && { ARDUINO_BIN="$candidate"; break; }
  done
fi

ARDUINO15_DIR="${ARDUINO15_DIR:-}"
if [[ -z "$ARDUINO15_DIR" ]]; then
  for candidate in "$HOME/Arduino/libraries/.arduino15" "$HOME/.arduino15"; do
    [[ -d "$candidate/packages/esp32" ]] && { ARDUINO15_DIR="$candidate"; break; }
  done
fi

report_tool() {  # report_tool LABEL OK DETAIL
  if [[ "$2" == "1" ]]; then
    printf '  %s✓%s %-22s %s%s%s\n' "$C_GREEN" "$C_OFF" "$1" "$C_DIM" "$3" "$C_OFF"
  else
    printf '  %s✗%s %-22s %s%s%s\n' "$C_RED" "$C_OFF" "$1" "$C_YELLOW" "$3" "$C_OFF"
  fi
}

[[ -n "$ARDUINO_BIN" ]] && report_tool "arduino 1.8.x" 1 "$ARDUINO_BIN" \
  || { report_tool "arduino 1.8.x" 0 "nenalezeno (ARDUINO_IDE=...)"; BLOCKED[2]="Arduino 1.8.x nenalezeno"; }
have node && report_tool "node" 1 "$(command -v node)" \
  || { report_tool "node" 0 "chybí"; BLOCKED[3]="node chybí"; BLOCKED[5]="node chybí"; BLOCKED[7]="node chybí"; }
have 7z && report_tool "7z" 1 "$(command -v 7z)" \
  || { report_tool "7z" 0 "chybí (p7zip-full)"; BLOCKED[3]="7z chybí"; BLOCKED[5]="7z chybí"; BLOCKED[7]="7z chybí"; }
have zip && report_tool "zip" 1 "$(command -v zip)" \
  || { report_tool "zip" 0 "chybí"; DEGRADED_WINDOWS="zip chybí"; }
have x86_64-w64-mingw32-g++ && report_tool "mingw-w64" 1 "$(command -v x86_64-w64-mingw32-g++)" \
  || { report_tool "mingw-w64" 0 "chybí -- bez Windows archivu"; DEGRADED_WINDOWS="mingw-w64 chybí"; }
have aarch64-linux-gnu-g++ && report_tool "aarch64 cross g++" 1 "$(command -v aarch64-linux-gnu-g++)" \
  || { report_tool "aarch64 cross g++" 0 "chybí -- bez Raspberry Pi archivu"; DEGRADED_ARM64="aarch64-linux-gnu-g++ chybí"; }

# local-trx bundling (fáze 3, volitelné, default Y) -- Linux x86_64 potřebuje
# jen systémové -dev balíčky (stejně jako `make -C local-trx test`); Windows/
# ARM64 potřebují navíc local-trx/third_party/build-cross-libs.sh's vlastní
# cross-zkompilovaný hamlib+libserialport, což se řeší (nabídkou postavit)
# přímo ve fázi 3, ne tady -- tady se jen zjišťuje, jestli local-trx pro
# Linux x86_64 vůbec jde postavit, a jestli je čím rozbalit/zabalit .zip.
LOCAL_TRX_UNAVAILABLE=""
if [[ ! -d "${ROOT_DIR}/local-trx" ]]; then
  LOCAL_TRX_UNAVAILABLE="local-trx/ neexistuje"
elif ! pkg-config --exists hamlib libserialport 2>/dev/null; then
  LOCAL_TRX_UNAVAILABLE="libhamlib-dev/libserialport-dev chybí"
fi
if [[ -z "$LOCAL_TRX_UNAVAILABLE" ]]; then
  report_tool "local-trx deps" 1 "hamlib + libserialport (pkg-config)"
else
  report_tool "local-trx deps" 0 "$LOCAL_TRX_UNAVAILABLE -- balíčky budou bez local-trx"
fi
have unzip && report_tool "unzip" 1 "$(command -v unzip)" \
  || { report_tool "unzip" 0 "chybí -- Windows balíček nepůjde local-trx přidat"; }
if [[ -n "$ARDUINO15_DIR" ]]; then
  report_tool "esp32 core tools" 1 "$ARDUINO15_DIR"
else
  report_tool "esp32 core tools" 0 "nenalezeno (ARDUINO15_DIR=...)"
  BLOCKED[5]="jádro ESP32 nenalezeno"; BLOCKED[7]="jádro ESP32 nenalezeno"
fi
if git -C "$ROOT_DIR" remote get-url origin >/dev/null 2>&1; then
  report_tool "git remote origin" 1 "$(git -C "$ROOT_DIR" remote get-url origin)"
else
  report_tool "git remote origin" 0 "chybí"
  BLOCKED[6]="git remote origin chybí"; BLOCKED[7]="git remote origin chybí"
fi

ext_hook preflight

BRANCH="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")"
if [[ "$BRANCH" != "$RELEASE_BRANCH" ]]; then
  if $FORCE; then
    warn "  Větev je '$BRANCH', ne '$RELEASE_BRANCH' -- --force to povoluje."
  else
    warn "  Větev je '$BRANCH', ne '$RELEASE_BRANCH': fáze 6 a 7 se nenabídnou."
    BLOCKED[6]="větev $BRANCH != $RELEASE_BRANCH"; BLOCKED[7]="větev $BRANCH != $RELEASE_BRANCH"
  fi
fi

skip_if_blocked() {  # skip_if_blocked N  -> 0 when the phase must be skipped
  local n="$1"
  if [[ -n "${BLOCKED[$n]:-}" ]]; then
    info "  přeskočeno: ${BLOCKED[$n]}"
    mark "$n" "nedostupné"
    return 0
  fi
  return 1
}

# REV_DATE = #define REV (the date), REV_BUILD = #define REV_BUILD (same-day
# release number, 0 = first of the day). REV = the version everything is
# named after: "20261113", or "20261113.1" -- what native/Makefile calls
# VERSION and gh-pages.sh FW_REV.
read_rev_date()  { sed -n 's/^#define[[:space:]]\+REV[[:space:]]\+\([0-9]\+\).*/\1/p' "$SKETCH" | head -1; }
read_rev_build() { sed -n 's/^#define[[:space:]]\+REV_BUILD[[:space:]]\+\([0-9]\+\).*/\1/p' "$SKETCH" | head -1; }
version_of() { if [[ "${2:-0}" -gt 0 ]]; then echo "$1.$2"; else echo "$1"; fi; }
read_rev() {
  REV_DATE="$(read_rev_date)"
  REV_BUILD="$(read_rev_build)"; REV_BUILD="${REV_BUILD:-0}"
  REV="$(version_of "$REV_DATE" "$REV_BUILD")"
}

read_rev
[[ -n "$REV_DATE" ]] || { fail "ERROR: v $SKETCH není #define REV"; exit 1; }
say ""
info "  REV $REV, větev $BRANCH"

# ================================================================== plán ====
# Every choice of the release on one screen (menu_run above). Nothing between
# here and the Enter writes anything anywhere.
TODAY="$(date +%Y%m%d)"
REV_PLAN="$REV"
# The version on the published page (gh-pages latest.json): when it is already
# today's REV, another release today needs REV_BUILD + 1 -- otherwise no
# updater would ever see it as newer.
PUBLISHED_VERSION=""
if git -C "$ROOT_DIR" fetch --quiet origin gh-pages 2>/dev/null; then
  _pub="$(git -C "$ROOT_DIR" show FETCH_HEAD:latest.json 2>/dev/null || true)"
  PUBLISHED_VERSION="$(sed -n 's/.*"version": *"\([0-9.]*\)".*/\1/p' <<<"$_pub" | head -1)"
  [[ -n "$PUBLISHED_VERSION" ]] || PUBLISHED_VERSION="$(sed -n 's/.*"rev": *"\([0-9]\{8\}\)".*/\1/p' <<<"$_pub" | head -1)"
fi

# dist-linux always; dist-windows/dist-arm64 only when their cross-toolchain
# was found in phase 0. Built as an explicit target list (not the Makefile's
# `dist` aggregate) so a missing toolchain degrades one archive at a time
# instead of failing the whole phase.
dist_targets=(dist-linux)
[[ -z "$DEGRADED_WINDOWS" ]] && dist_targets+=(dist-windows)
[[ -z "$DEGRADED_ARM64"   ]] && dist_targets+=(dist-arm64)
want_ltx=false

menu_add h_build head 0 "sestavení"
# ---- 1 REV
if [[ "$REV_DATE" == "$TODAY" ]]; then
  # Same day: the choice is another release of today, REV_BUILD + 1. On by
  # default when today's version is what the page already offers.
  _p1_default=N
  [[ -n "$PUBLISHED_VERSION" && "$PUBLISHED_VERSION" == "$REV" ]] && _p1_default=Y
  menu_phase 1 "další vydání dnes: $REV -> $(version_of "$REV_DATE" $((REV_BUILD + 1)))" "$_p1_default"
  if [[ "$_p1_default" == Y ]]; then M_NOTE[p1]="$REV už je na stránce"
  else M_NOTE[p1]="na stránce ${PUBLISHED_VERSION:-nic / nezjištěno}"; fi
else
  menu_phase 1 "REV -> dnešní datum ($TODAY)" N
  if [[ "$REV_DATE" -gt "$TODAY" ]]; then
    M_OFF[p1]="REV $REV je v budoucnosti -- nechává se"
  else
    M_NOTE[p1]="teď $REV"
  fi
fi

# ---- 2 firmware
menu_phase 2 "export firmware (box + M5Atom Lite)" Y

# ---- 3 native dist
dist_default=Y
[[ -n "$DEGRADED_WINDOWS" || -n "$DEGRADED_ARM64" ]] && dist_default=N
menu_phase 3 "PC balíky (make -C native dist)" "$dist_default"
_degraded="${DEGRADED_WINDOWS:+bez Windows ($DEGRADED_WINDOWS) }${DEGRADED_ARM64:+bez Raspberry Pi ($DEGRADED_ARM64)}"
M_NOTE[p3]="${dist_targets[*]}${_degraded:+ -- $_degraded}"
menu_add ltx bool 1 "přibalit local-trx (PC bridge pro libovolný rig)" yes "on p3"
[[ -n "$LOCAL_TRX_UNAVAILABLE" ]] && M_OFF[ltx]="$LOCAL_TRX_UNAVAILABLE"
# Cross-compiled hamlib+libserialport (Windows/ARM64) is a one-off job of
# minutes whose result build-cross-libs.sh keeps for next time.
for _t in win arm64; do
  _gate="dist-windows"; [[ "$_t" == arm64 ]] && _gate="dist-arm64"
  [[ " ${dist_targets[*]} " == *" $_gate "* ]] || continue
  cross_libs_missing "$_t" || continue
  menu_add "ltx_$_t" bool 2 "zkompilovat chybějící cross hamlib/libserialport ($_t)" yes "on ltx"
  M_NOTE["ltx_$_t"]="řádově minuty, jednorázově"
done

menu_add h_deploy head 0 "nasazení"
# ---- 6 install on this computer
menu_phase 4 "instalace na tento počítač (sudo, /opt/wifilt)" Y
ext_hook plan_install
_running=()
for _svc in wifilt local-trx; do
  systemctl is-active --quiet "$_svc" 2>/dev/null && _running+=("$_svc")
done
if [[ ${#_running[@]} -gt 0 ]]; then
  # install(1) cannot write over a binary that is being executed: the install
  # would fail with "Text file busy" halfway, having already replaced data/.
  menu_add stopsvc bool 1 "zastavit běžící ${_running[*]} na dobu instalace" yes "on p4"
fi

# ---- 7 flash the device
menu_phase 5 "flash firmware + assets do zařízení" Y
menu_add port choice 1 "port" "" "on p5"
ext_hook plan_flash
detect_ports

menu_add h_pub head 0 "zveřejnění"
# ---- 8 git
menu_phase 6 "git commit / push" Y
M_NOTE[p6]="před commitem se přerazí ?v= v data/*.html"
plan_commit_repo "$ROOT_DIR" "wifilt"
ext_hook plan_commit

# ---- 9 publish
menu_phase 7 "publikace instalační stránky (gh-pages)" Y
M_NOTE[p7]="jen změnil-li se zdroj a projdou-li závory"

ext_hook plan

menu_add h_end head 0 "na konci"
menu_add fsm bool 0 "obsazenost ESP32: přeměřit LittleFS, které běh nezměřil" yes
M_NOTE[fsm]="~1 min na edici"

# menu_refresh -- what changes with the other choices; before every redraw.
menu_refresh() {
  REV_PLAN="$REV"
  if on p1; then
    if [[ "$REV_DATE" == "$TODAY" ]]; then REV_PLAN="$(version_of "$REV_DATE" $((REV_BUILD + 1)))"
    else REV_PLAN="$TODAY"; fi
  fi
  INSTALL_ARCHIVE="${DIST_DIR}/wifilt-${REV_PLAN}-linux-x86_64.tar.gz"
  # An extension may point INSTALL_ARCHIVE elsewhere, or mark its items here.
  ext_hook menu_refresh
  if [[ -z "${BLOCKED[4]:-}" ]]; then
    if on p3; then
      M_OFF[p4]=""; M_NOTE[p4]="${INSTALL_ARCHIVE#"${ROOT_DIR}"/}"
    elif [[ -f "$INSTALL_ARCHIVE" ]]; then
      # The archive exists by NAME (wifilt-$REV-...) -- that alone does not
      # mean THIS run rebuilt it. Found live: phase 3 declined ("the archive is
      # already there"), then the install quietly deployed an hours-old archive
      # without a fix made to start-wifilt.sh in the meantime.
      M_OFF[p4]=""; M_NOTE[p4]="POZOR: $(basename "$INSTALL_ARCHIVE") nebude přebudován -- může být starší než zdroj"
    else
      M_OFF[p4]="chybí $(basename "$INSTALL_ARCHIVE") a fáze 3 je vypnutá"
    fi
  fi
  if [[ -z "${BLOCKED[5]:-}" ]]; then
    if [[ ${#PORT_VALS[@]} -gt 0 ]]; then M_OFF[p5]=""
    else M_OFF[p5]="žádný sériový port (r = hledat znovu)"; fi
  fi
}

menu_run

# ---- the choices -> the plan
menu_refresh
for _k in "${MENU_KEYS[@]}"; do
  [[ "$_k" =~ ^p([0-9]+)$ ]] || continue
  _n="${BASH_REMATCH[1]}"
  if on "$_k"; then PLAN[$_n]=yes; else PLAN[$_n]=no; fi
  if [[ -n "${M_OFF[$_k]}" ]]; then PLAN_NOTE[$_n]="${M_OFF[$_k]}"
  elif [[ -n "${M_NOTE[$_k]}" ]]; then PLAN_NOTE[$_n]="${M_NOTE[$_k]}"; fi
done
if [[ "$REV_DATE" == "$TODAY" ]]; then
  want 1 && PLAN_NOTE[1]="$REV -> $(version_of "$REV_DATE" $((REV_BUILD + 1)))"
else
  want 1 && PLAN_NOTE[1]="$REV -> $TODAY"
fi
on ltx && want_ltx=true
want 3 && $want_ltx && PLAN_NOTE[3]+=" + local-trx"
for _t in win arm64; do on "ltx_$_t" && PLAN_LTX_CROSS[$_t]=yes; done
if [[ -n "${M_TYPE[stopsvc]:-}" ]] && ! on stopsvc; then PLAN_STOP_SERVICES=no; fi
PLAN_PORT="${M_VAL[port]:-}"
FLASH_ARGS=(--edition public)
# Phase 6 runs (and stamps ?v=) only when it is to commit or push something:
# stamping alone would leave the tree dirty in front of phase 7.
_notes=()
for _i in "${!REPO_LABELS[@]}"; do
  _label="${REPO_LABELS[$_i]}"
  COMMIT_PLAN[$_label]=no; PUSH_PLAN[$_label]=no
  on "c$_i" && COMMIT_PLAN[$_label]=yes
  on "u$_i" && PUSH_PLAN[$_label]=yes
  COMMIT_MSG[$_label]="${M_VAL[m$_i]:-}"
  _n=""
  [[ "${COMMIT_PLAN[$_label]}" == yes ]] && _n="commit"
  [[ "${PUSH_PLAN[$_label]}" == yes ]] && _n="${_n:+$_n+}push"
  [[ -n "$_n" ]] && _notes+=("$_label: $_n")
done
if want 6; then
  if [[ ${#_notes[@]} -gt 0 ]]; then PLAN_NOTE[6]="$(IFS=,; echo "${_notes[*]}")"
  else PLAN[6]=no; PLAN_NOTE[6]="ani commit, ani push"; fi
fi
# An extension turns its own items into FLASH_ARGS, INSTALL_SCOPE, ...
ext_hook plan_resolve
want 5 && PLAN_NOTE[5]="$(basename "$PLAN_PORT") ${FLASH_ARGS[*]}"

print_plan

# sudo goes first, while someone is still at the keyboard.
if want 4; then
  sudo_prime || { fail "sudo selhalo -- nic se neprovedlo."; exit 1; }
fi
PLAN_LOCKED=true

# ---------------------------------------------------------------- phase 1 ----
phase_banner 1 "REV podle dnešního data"
# set_rev DATE BUILD -- both #defines in wifilt.ino
set_rev() {
  sed -i -e "s/^\(#define[[:space:]]\+REV[[:space:]]\+\)[0-9]\+/\1$1/" \
         -e "s/^\(#define[[:space:]]\+REV_BUILD[[:space:]]\+\)[0-9]\+/\1$2/" "$SKETCH"
  read_rev
  [[ "$REV_DATE" == "$1" && "$REV_BUILD" == "$2" ]] || abort "REV / REV_BUILD se nepodařilo přepsat" 1
  ok "  REV $REV"
  wrote "wifilt" "REV" "wifilt.ino: #define REV $REV_DATE, #define REV_BUILD $REV_BUILD"
}
if [[ "$REV_DATE" == "$TODAY" ]] && want 1; then
  set_rev "$REV_DATE" $((REV_BUILD + 1))
  mark 1 "hotovo"
elif [[ "$REV_DATE" == "$TODAY" ]]; then
  info "  REV $REV už odpovídá dnešku."
  [[ -n "$PUBLISHED_VERSION" && "$PUBLISHED_VERSION" == "$REV" ]] \
    && warn "  $REV už je na stránce -- bez REV_BUILD + 1 ho žádný updater nenabídne"
  mark 1 "beze změny"
elif [[ "$REV_DATE" -gt "$TODAY" ]]; then
  warn "  REV $REV je v budoucnosti (dnes $TODAY) -- nechávám být."
  mark 1 "beze změny"
elif want 1; then
  set_rev "$TODAY" 0
  mark 1 "hotovo"
else
  info "  REV zůstává $REV"
  mark 1 "přeskočeno"
fi

# REV is final after phase 1 (it only ever changes there) -- defined here,
# once, so every later phase that names the Linux archive (3's local-trx
# bundling, 4's install, 7's publish gate) shares one path instead of each
# phase re-deriving it or -- as phase 3's local-trx bundling briefly did --
# using it before it was ever set at all (found by code review: a bare
# reference under `set -u` aborted the whole script mid-phase-3).
LINUX_ARCHIVE="${DIST_DIR}/wifilt-${REV}-linux-x86_64.tar.gz"

# ---------------------------------------------------------------- phase 2 ----
phase_banner 2 "export compiled binary"
if ! skip_if_blocked 2; then
  if want 2; then
    info "  ESP32 Dev Module | No OTA (2MB APP/2MB SPIFFS) | DIO"
    info "  + M5Stack Atom Lite | same partitions.csv | DIO (board default)"
    # export-compiled-binary.sh names the output after the board's build.variant
    # (m5stack-atom -> m5stack_atom), which is exactly what FIRMWARE_BIN* above
    # expect.
    info "  -- box"
    ARDUINO_IDE="$ARDUINO_BIN" "${ROOT_DIR}/tools/export-compiled-binary.sh" --edition public \
      || { mark 2 "selhalo"; abort "Překlad selhal." 2; }
    info "  -- M5Atom Lite"
    ARDUINO_IDE="$ARDUINO_BIN" "${ROOT_DIR}/tools/export-compiled-binary.sh" --edition public \
        --fqbn "esp32:esp32:m5stack-atom" \
      || { mark 2 "selhalo"; abort "Překlad M5Atom Lite selhal." 2; }
    for _f in "$FIRMWARE_BIN" "$FIRMWARE_BIN_M5ATOM"; do
      wrote "wifilt" "firmware" "$(basename "$_f") ($(fmt_num "$(stat -c %s "$_f")") B)"
    done
    ext_hook firmware
    mark 2 "hotovo"
  else
    mark 2 "přeskočeno"
  fi
fi

# ---------------------------------------------------------------- phase 3 ----
phase_banner 3 "make -C native dist"
if ! skip_if_blocked 3; then
  if want 3; then
    info "  REV $REV: ${dist_targets[*]}$($want_ltx && echo " + local-trx")"
    # NO_ADDONS=1: native/dist is built without addons/ whatever is beside the
    # sketch -- it is what phase 7 publishes.
    dist_build "$DIST_DIR" NO_ADDONS=1 || { mark 3 "selhalo"; abort "make -C native dist selhal." 3; }
    missing_ltx="$(archives_missing_ltx "$DIST_DIR" | tr '\n' ' ')"
    if [[ -n "$missing_ltx" ]]; then
      if $FORCE; then
        warn "  --force: balíky BEZ local-trx: ${missing_ltx}-- update z webu by local-trx odinstaloval"
      else
        mark 3 "bez local-trx"
        abort "balíky bez local-trx: ${missing_ltx}-- update z webu by local-trx odinstaloval (zapni 'přibalit local-trx', oprav build local-trx, nebo --force)" 3
      fi
    fi
    wrote_dist "wifilt" "$DIST_DIR"
    ext_hook dist
    mark 3 "hotovo"
  else
    mark 3 "přeskočeno"
  fi
fi

# ---------------------------------------------------------------- phase 4 ----
phase_banner 4 "instalace na tento počítač"
if ! want 4; then
  mark 4 "přeskočeno"
else
  # The plan named the archive after REV_PLAN, which phase 1 made REV.
  ext_hook install
  INSTALL_DIST="$(dirname "$INSTALL_ARCHIVE")"
  info "  ${INSTALL_ARCHIVE#"${ROOT_DIR}"/}"
  if [[ ! -f "$INSTALL_ARCHIVE" ]]; then
    info "  chybí $(basename "$INSTALL_ARCHIVE") -- fáze 3 neproběhla."
    mark 4 "nedostupné"
  else
    info "  /opt/wifilt + systemd jednotka (neaktivovaná); ~/.config/wifilt zůstává"
    # local-trx.service the same as wifilt: install.sh overwrites its binary too.
    stopped_services=()
    for svc in wifilt local-trx; do
      if systemctl is-active --quiet "$svc" 2>/dev/null; then
        if [[ "$PLAN_STOP_SERVICES" == yes ]]; then
          info "  zastavuji $svc na dobu instalace"
          sudo systemctl stop "$svc" && stopped_services+=("$svc")
        else
          warn "  Služba $svc běží a podle plánu se nezastavuje -- instalace může selhat."
        fi
      fi
    done
    ( cd "$INSTALL_DIST" \
      && tar xzf "$(basename "$INSTALL_ARCHIVE")" \
      && cd wifilt-linux-x86_64 \
      && sudo ./install.sh )
    install_status=$?
    if [[ $install_status -eq 0 ]]; then
      # The extracted tree is a by-product of installing, not of building; make
      # removes its own copy at the end of `dist` and this removes ours.
      rm -rf "${INSTALL_DIST}/wifilt-linux-x86_64"
      wrote "$INSTALL_SCOPE" "instalace" "/opt/wifilt + systemd jednotka <- ${INSTALL_ARCHIVE#"${ROOT_DIR}"/}"
      mark 4 "hotovo"
      [[ ${#stopped_services[@]} -gt 0 ]] && warn "  Služby jsi zastavil: sudo systemctl start ${stopped_services[*]}"
    else
      mark 4 "selhalo"; abort "Instalace selhala." 4
    fi
  fi
fi

# ---------------------------------------------------------------- phase 5 ----
phase_banner 5 "flash firmware + assets do zařízení"
if ! skip_if_blocked 5; then
  if ! want 5; then
    mark 5 "přeskočeno"
  elif [[ ! -e "$PLAN_PORT" ]]; then
    mark 5 "selhalo"; abort "Port $PLAN_PORT z plánu už neexistuje (odpojeno?)." 5
  else
    ext_hook flash
    info "  ${PLAN_PORT} ${FLASH_ARGS[*]}"
    if "${ROOT_DIR}/tools/upload-firmware-spiffs.sh" --port "$PLAN_PORT" "${FLASH_ARGS[@]}"; then
      _ed=public
      for (( _i = 0; _i < ${#FLASH_ARGS[@]}; _i++ )); do
        [[ "${FLASH_ARGS[$_i]}" == --edition ]] && _ed="${FLASH_ARGS[$((_i + 1))]}"
      done
      # upload-firmware-spiffs.sh leaves the tree it staged; measured for the
      # table at the end.
      fs_record "$_ed" "${ROOT_DIR}/build/release-upload/data" || true
      wrote "$FLASH_SCOPE" "zařízení" "$(basename "$PLAN_PORT"): app0 @$(part_field app0 4) + spiffs @$(part_field spiffs 4) (${_ed}); cfg beze změny"
      mark 5 "hotovo"
    else
      mark 5 "selhalo"; abort "Zápis do zařízení selhal." 5
    fi
  fi
fi

# ---------------------------------------------------------------- phase 6 ----
phase_banner 6 "git commit / git push"
if ! skip_if_blocked 6; then
  if ! want 6; then
    mark 6 "přeskočeno"
  else
    # Stamping before the commit, not after: gh-pages.sh runs prepare-spiffs-tree.sh
    # inside itself, and that rewrites the ?v= in the TRACKED data/*.html. Left for
    # phase 7 it would dirty the tree immediately after the commit that was meant
    # to capture it.
    if ! node "${ROOT_DIR}/tools/stamp-asset-versions.js" >/dev/null; then
      abort "stamp-asset-versions.js selhal." 6
    fi
    info "  ?v= v data/*.html přeraženy podle obsahu"

    changelog_rev="$(sed -n '/^## Working tree/,/^## REV/p' "${ROOT_DIR}/Changelog.md" \
                     | grep -oE '\*\*REV [0-9]+(\.[0-9]+)?\.\*\*' | head -1 | grep -oE '[0-9]+(\.[0-9]+)?' || true)"
    if [[ -z "$changelog_rev" ]]; then
      warn "  V sekci 'Working tree — not committed' není žádné **REV NNNNNNNN.**"
    elif [[ "$changelog_rev" != "$REV" ]]; then
      warn "  Changelog mluví o REV $changelog_rev, firmware nese REV $REV."
    else
      info "  Changelog a firmware se shodují na REV $REV"
    fi

    ext_hook stamp

    commit_repo "$ROOT_DIR" "wifilt" 7
    ext_hook commit
    if [[ " ${REPO_RESULTS[*]} " == *" hotovo "* ]]; then
      mark 6 "hotovo"
    elif [[ " ${REPO_RESULTS[*]} " != *" přeskočeno "* ]]; then
      mark 6 "beze změny"
    else
      mark 6 "přeskočeno"
    fi
  fi
fi

# ---------------------------------------------------------------- phase 7 ----
phase_banner 7 "publikace instalační stránky"
if skip_if_blocked 7; then
  :
elif ! want 7; then
  mark 7 "přeskočeno"
else
  gate_ok=true
  gate() { fail "  ✗ $1"; gate_ok=false; }

  # A published page is the one step of this script that strangers see, and the
  # only one that cannot be taken back. Each check below is a way the page could
  # end up describing something that does not exist.
  [[ -f "$FIRMWARE_BIN" ]] || gate "chybí $(basename "$FIRMWARE_BIN") -- fáze 2 neproběhla"
  [[ -f "$FIRMWARE_BIN_M5ATOM" ]] || gate "chybí $(basename "$FIRMWARE_BIN_M5ATOM") -- fáze 2 neproběhla"
  check_export_fresh() {  # check_export_fresh BIN
    local bin="$1" source
    while IFS= read -r -d '' source; do
      if [[ "$source" -nt "$bin" ]]; then
        gate "export $(basename "$bin") je starší než $(basename "$source") -- neodpovídá zdroji"
        return
      fi
    done < <(find "$ROOT_DIR" -maxdepth 1 -type f \
             \( -name '*.ino' -o -name '*.h' -o -name '*.hpp' -o -name '*.cpp' \) -print0)
  }
  [[ -f "$FIRMWARE_BIN" ]] && check_export_fresh "$FIRMWARE_BIN"
  [[ -f "$FIRMWARE_BIN_M5ATOM" ]] && check_export_fresh "$FIRMWARE_BIN_M5ATOM"

  win_archive="${DIST_DIR}/wifilt-${REV}-windows-x64.zip"
  arm64_archive="${DIST_DIR}/wifilt-${REV}-linux-arm64.tar.gz"
  if [[ ! -f "$LINUX_ARCHIVE" && ! -f "$win_archive" && ! -f "$arm64_archive" ]]; then
    gate "v native/dist není žádný archiv pro REV $REV -- fáze 3 neproběhla"
  else
    [[ -f "$LINUX_ARCHIVE"   ]] || warn "  chybí linuxový archiv pro REV $REV -- stránka ho nenabídne"
    [[ -f "$win_archive"     ]] || warn "  chybí windowsový archiv pro REV $REV -- stránka ho nenabídne"
    [[ -f "$arm64_archive"   ]] || warn "  chybí Raspberry Pi archiv pro REV $REV -- stránka ho nenabídne"
  fi

  missing_ltx="$(archives_missing_ltx "$DIST_DIR" | tr '\n' ' ')"
  [[ -z "$missing_ltx" ]] || gate "balíky bez local-trx: ${missing_ltx}-- update z webu by local-trx odinstaloval"

  if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    gate "pracovní strom není čistý -- publikoval bys necommitnutý stav"
  fi
  git -C "$ROOT_DIR" fetch --quiet origin "$RELEASE_BRANCH" 2>/dev/null || true
  head_sha="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo "")"
  origin_sha="$(git -C "$ROOT_DIR" rev-parse "origin/${RELEASE_BRANCH}" 2>/dev/null || echo "")"
  if [[ -z "$origin_sha" ]]; then
    gate "origin/$RELEASE_BRANCH není známá -- nelze ověřit, že je zdroj vydaný"
  elif [[ "$head_sha" != "$origin_sha" ]]; then
    gate "HEAD není origin/$RELEASE_BRANCH -- zdroj té stránky by na GitHubu nebyl"
  fi

  # Published only when the source changed: every page commit is
  # "WIFILT REV <rev> (<sha>)", the sha of the source it was built from.
  published_sha=""
  if git -C "$ROOT_DIR" fetch --quiet origin gh-pages 2>/dev/null; then
    published_sha="$(git -C "$ROOT_DIR" log -1 --format=%s FETCH_HEAD \
                     | sed -n 's/.*(\([0-9a-f]\{7,40\}\)).*/\1/p')"
  fi
  public_changed=true
  if [[ -n "$published_sha" ]] \
     && [[ "$(git -C "$ROOT_DIR" rev-parse --verify --quiet "${published_sha}^{commit}" 2>/dev/null)" == "$(git -C "$ROOT_DIR" rev-parse HEAD)" ]]; then
    public_changed=false
  fi

  if ! $gate_ok && $FORCE; then
    warn "  --force: publikuji přes výše uvedené závory"
    gate_ok=true
  fi

  if ! $public_changed && ! $FORCE; then
    info "  Zdroj se od poslední publikace (${published_sha}) nezměnil -- stránka zůstává."
    mark 7 "beze změny"
  elif ! $gate_ok; then
    info "  publikace zastavena závorami; obejít lze jen přes --force"
    mark 7 "nedostupné"
  else
    info "  Zdroj se změnil (stránka: ${published_sha:-žádná}) -- publikuji na origin/gh-pages"
    short="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "?")"
    if "${ROOT_DIR}/tools/gh-pages.sh" --publish --message "WIFILT REV ${REV} (${short})"; then
      mark 7 "hotovo"
      wrote "wifilt" "stránka" "origin/gh-pages \"WIFILT REV ${REV} (${short})\" -> $PAGE_URL"
      ok "  $PAGE_URL"
    else
      mark 7 "selhalo"; abort "Publikace selhala." 7
    fi
  fi
fi

ext_hook end

if on fsm; then
  for _row in "${ESP_FS_ROWS[@]}"; do
    _ed="${_row%%|*}"
    [[ -n "${FS_MEASURED[$_ed]:-}" ]] && continue
    info "  měřím LittleFS ($_ed) pro tabulku obsazenosti..."
    fs_measure "$_ed" || warn "  měření LittleFS ($_ed) selhalo"
  done
fi

print_summary
print_esp_usage
print_written
say ""
info "REV $REV | větev $BRANCH"
[[ "${RESULT[7]:-}" == "hotovo" ]] && ok "Stránka: $PAGE_URL"
exit 0
