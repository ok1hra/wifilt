#!/usr/bin/env bash
#
# One release, nine phases, and a question before each of them.
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
# Every phase is a question. Enter takes the capitalised default. Nothing here
# writes to the device, to this computer, to git or to the web without being
# asked first.
#
#   tools/release.sh            interactive, the whole chain
#   tools/release.sh --force    bypass the pre-publish guards (see phase 9)

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKETCH="${ROOT_DIR}/wifilt.ino"
FIRMWARE_BIN="${ROOT_DIR}/wifilt.ino.esp32.bin"
DIST_DIR="${ROOT_DIR}/native/dist"
NATIVE_BIN="${ROOT_DIR}/native/build/wifilt"
RELEASE_BRANCH="main"
PAGE_URL="https://ok1hra.github.io/wifilt/"
FORCE=false

usage() {
  cat <<'EOF'
Usage: tools/release.sh [--force]

Walks the release in nine phases, asking before each one. Enter accepts the
capitalised default.

  1  REV -> today's date                     (y/N)
  2  Export compiled binary (headless)       (Y/n)
  3  make -C native dist                     (Y/n)
  4  tools/native-integration-test.sh        (y/N)
  5  run ./native/build/wifilt --data-dir data   (y/N)
  6  install this build on this computer     (Y/n)
  7  tools/upload-firmware-spiffs.sh         (y/N)
  8  git commit / git push                   (y/N, twice)
  9  tools/gh-pages.sh --publish             (y/N)

Options:
  --force   Skip the guards in front of phase 9 and allow phases 8 and 9 on a
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
  printf '\n%s%s== %s/9  %s%s\n' "$C_BOLD" "$C_CYAN" "$1" "$2" "$C_OFF"
}

# ask QUESTION DEFAULT   DEFAULT is Y or N; Enter takes it. Anything that is not
# y/Y/n/N asks again rather than guessing, because several of these phases are
# irreversible.
ask() {
  local question="$1" default="$2" prompt answer
  case "$default" in
    Y) prompt="(Y/n)" ;;
    N) prompt="(y/N)" ;;
    *) fail "internal: bad default '$default'"; exit 1 ;;
  esac
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
  exit 1
}

PHASES=(
  "1 REV"
  "2 export firmware"
  "3 make -C native dist"
  "4 integrační test"
  "5 spuštění binárky"
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
    printf '  %s  %s%*s%s%s%s\n' "$n" "$label" "$pad" "" "$colour" "$state" "$C_OFF"
  done
}

# One capability, three privileged ports, one inode that forgets it on every
# relink. Both the integration test and running the binary by hand need it, so
# the question lives in one place.
ensure_setcap() {   # ensure_setcap WHAT-BREAKS-WITHOUT-IT
  [[ -x "$NATIVE_BIN" ]] || return 1
  if getcap "$NATIVE_BIN" 2>/dev/null | grep -q cap_net_bind_service; then
    return 0
  fi
  warn "  Binárka nemá CAP_NET_BIND_SERVICE -- $1"
  if ask "Udělit ji přes sudo (vyžádá heslo)?" N; then
    make -C "${ROOT_DIR}/native" setcap && return 0
    warn "  setcap se nepovedl"
  fi
  return 1
}

# ---------------------------------------------------------------- phase 0 ----
# Preflight. A missing tool disables ONE phase, never the run: flashing a board
# on a machine without mingw-w64 is a perfectly reasonable thing to want.
phase_banner 0 "kontrola nástrojů"

declare -A BLOCKED=()      # phase -> reason it cannot run at all
DEGRADED_DIST=""           # phase 3 can still build the Linux half

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
  || { report_tool "node" 0 "chybí"; BLOCKED[3]="node chybí"; BLOCKED[7]="node chybí"; BLOCKED[9]="node chybí"; }
have 7z && report_tool "7z" 1 "$(command -v 7z)" \
  || { report_tool "7z" 0 "chybí (p7zip-full)"; BLOCKED[3]="7z chybí"; BLOCKED[7]="7z chybí"; BLOCKED[9]="7z chybí"; }
have zip && report_tool "zip" 1 "$(command -v zip)" \
  || { report_tool "zip" 0 "chybí"; DEGRADED_DIST="zip chybí"; }
have x86_64-w64-mingw32-g++ && report_tool "mingw-w64" 1 "$(command -v x86_64-w64-mingw32-g++)" \
  || { report_tool "mingw-w64" 0 "chybí -- jen linuxový archiv"; DEGRADED_DIST="mingw-w64 chybí"; }
if [[ -n "$ARDUINO15_DIR" ]]; then
  report_tool "esp32 core tools" 1 "$ARDUINO15_DIR"
else
  report_tool "esp32 core tools" 0 "nenalezeno (ARDUINO15_DIR=...)"
  BLOCKED[7]="jádro ESP32 nenalezeno"; BLOCKED[9]="jádro ESP32 nenalezeno"
fi
if git -C "$ROOT_DIR" remote get-url origin >/dev/null 2>&1; then
  report_tool "git remote origin" 1 "$(git -C "$ROOT_DIR" remote get-url origin)"
else
  report_tool "git remote origin" 0 "chybí"
  BLOCKED[8]="git remote origin chybí"; BLOCKED[9]="git remote origin chybí"
fi

BRANCH="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")"
if [[ "$BRANCH" != "$RELEASE_BRANCH" ]]; then
  if $FORCE; then
    warn "  Větev je '$BRANCH', ne '$RELEASE_BRANCH' -- --force to povoluje."
  else
    warn "  Větev je '$BRANCH', ne '$RELEASE_BRANCH': fáze 8 a 9 se nenabídnou."
    BLOCKED[8]="větev $BRANCH != $RELEASE_BRANCH"; BLOCKED[9]="větev $BRANCH != $RELEASE_BRANCH"
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

read_rev() { sed -n 's/^#define[[:space:]]\+REV[[:space:]]\+\([0-9]\+\).*/\1/p' "$SKETCH" | head -1; }

REV="$(read_rev)"
[[ -n "$REV" ]] || { fail "ERROR: v $SKETCH není #define REV"; exit 1; }
say ""
info "  REV $REV, větev $BRANCH"

# ---------------------------------------------------------------- phase 1 ----
phase_banner 1 "REV podle dnešního data"
TODAY="$(date +%Y%m%d)"
if [[ "$REV" == "$TODAY" ]]; then
  info "  REV $REV už odpovídá dnešku -- neptám se."
  mark 1 "beze změny"
elif [[ "$REV" -gt "$TODAY" ]]; then
  warn "  REV $REV je v budoucnosti (dnes $TODAY) -- nechávám být."
  mark 1 "beze změny"
else
  if ask "Zvýšit REV $REV -> $TODAY v wifilt.ino?" N; then
    sed -i "s/^\(#define[[:space:]]\+REV[[:space:]]\+\)[0-9]\+/\1$TODAY/" "$SKETCH"
    REV="$(read_rev)"
    [[ "$REV" == "$TODAY" ]] || abort "REV se nepodařilo přepsat" 1
    ok "  REV $REV"
    mark 1 "hotovo"
  else
    info "  REV zůstává $REV"
    mark 1 "přeskočeno"
  fi
fi

# ---------------------------------------------------------------- phase 2 ----
phase_banner 2 "export compiled binary"
if ! skip_if_blocked 2; then
  info "  ESP32 Dev Module | No OTA (2MB APP/2MB SPIFFS) | DIO"
  if ask "Přeložit a vyexportovat firmware?" Y; then
    if ARDUINO_IDE="$ARDUINO_BIN" "${ROOT_DIR}/tools/export-compiled-binary.sh"; then
      mark 2 "hotovo"
    else
      mark 2 "selhalo"; abort "Překlad selhal." 2
    fi
  else
    mark 2 "přeskočeno"
  fi
fi

# ---------------------------------------------------------------- phase 3 ----
phase_banner 3 "make -C native dist"
if ! skip_if_blocked 3; then
  dist_default=Y
  if [[ -n "$DEGRADED_DIST" ]]; then
    warn "  $DEGRADED_DIST -- vznikne jen linuxový archiv, stránka bude bez Windows odkazu."
    dist_default=N
  fi
  if ask "Sestavit PC balíky pro REV $REV?" "$dist_default"; then
    # Archives of other revisions have to go before make runs: its last step is
    # `sha256sum *.tar.gz *.zip > SHA256SUMS`, which would otherwise publish a
    # checksum file describing releases that are not on the page. native/dist is
    # in .gitignore, so nothing here is worth keeping.
    if [[ -d "$DIST_DIR" ]]; then
      while IFS= read -r -d '' stale; do
        info "  mažu $(basename "$stale")"
        rm -rf "$stale"
      done < <(find "$DIST_DIR" -mindepth 1 -maxdepth 1 \
                 \( -type d -o -name '*.tar.gz' -o -name '*.zip' \) \
                 ! -name "*-${REV}-*" -print0)
    fi
    if [[ -n "$DEGRADED_DIST" ]]; then
      make -C "${ROOT_DIR}/native" dist-linux
      dist_status=$?
      if [[ $dist_status -eq 0 ]]; then
        ( cd "$DIST_DIR" && sha256sum ./*.tar.gz ./*.zip >SHA256SUMS 2>/dev/null || true )
        rm -rf "${DIST_DIR}/assets"
      fi
    else
      make -C "${ROOT_DIR}/native" dist
      dist_status=$?
    fi
    if [[ $dist_status -eq 0 ]]; then
      mark 3 "hotovo"
    else
      mark 3 "selhalo"; abort "make -C native dist selhal." 3
    fi
  else
    mark 3 "přeskočeno"
  fi
fi

# ---------------------------------------------------------------- phase 4 ----
phase_banner 4 "integrační test proti falešnému rádiu"
if ask "Spustit tools/native-integration-test.sh?" N; then
  ensure_setcap "audio půlka testu se přeskočí (port 83)" || true
  if "${ROOT_DIR}/tools/native-integration-test.sh"; then
    mark 4 "hotovo"
  else
    mark 4 "selhalo"
    fail "  Integrační test skončil chybou."
    ask "Přesto pokračovat?" N || abort "Zastaveno po selhaném testu." 4
  fi
else
  mark 4 "přeskočeno"
fi

# ---------------------------------------------------------------- phase 5 ----
phase_banner 5 "spuštění linuxové binárky"
if [[ ! -x "$NATIVE_BIN" ]]; then
  info "  native/build/wifilt neexistuje -- fáze 3 neproběhla."
  mark 5 "nedostupné"
elif ask "Spustit ./native/build/wifilt --data-dir data?" N; then
  ensure_setcap "porty 80, 82 a 83 nepůjde otevřít" || true
  say ""
  info "  http://localhost/   -- Ctrl-C binárku ukončí a skript pokračuje"
  info "  hlásí se na LAN jako wifilt.local, stejně jako skutečné zařízení"
  say ""
  # Job control, and it is not decoration: without `set -m` the binary shares
  # this script's process group, so the Ctrl-C that stops it would end the whole
  # release run with it. With it the binary gets its own group and the terminal,
  # and the signal reaches only the app.
  set -m
  ( cd "$ROOT_DIR" && ./native/build/wifilt --data-dir data )
  run_status=$?
  set +m
  say ""
  if [[ $run_status -eq 0 || $run_status -eq 130 || $run_status -eq 2 ]]; then
    info "  binárka ukončena (stav $run_status)"
    mark 5 "hotovo"
  elif [[ $run_status -eq 134 ]]; then
    # Ctrl-C prints "shutting down" and then dies on `terminate called without
    # an active exception` -- a thread going out of scope unjoined in the
    # shutdown path. It is a defect of the native build, not a reason to stop a
    # release the operator ended themselves, so it is reported and not asked
    # about. The yellow line in the summary is what keeps it from being forgotten.
    warn "  Binárka po SIGINT spadla na SIGABRT (terminate without active exception)"
    warn "  -- vada úklidové cesty native buildu, ne tohoto kroku."
    mark 5 "ukončena s SIGABRT"
  else
    mark 5 "selhalo"
    fail "  Binárka skončila se stavem $run_status."
    ask "Přesto pokračovat?" N || abort "Zastaveno po selhaném běhu." 5
  fi
else
  mark 5 "přeskočeno"
fi

# ---------------------------------------------------------------- phase 6 ----
phase_banner 6 "instalace na tento počítač"
LINUX_ARCHIVE="${DIST_DIR}/wifilt-${REV}-linux-x86_64.tar.gz"
if [[ ! -f "$LINUX_ARCHIVE" ]]; then
  info "  chybí $(basename "$LINUX_ARCHIVE") -- fáze 3 neproběhla."
  mark 6 "nedostupné"
else
  info "  /opt/wifilt + systemd jednotka (neaktivovaná); ~/.config/wifilt zůstává"
  if ask "Nainstalovat wifilt-${REV} na tento počítač (sudo)?" Y; then
    # install(1) cannot write over a binary that is currently being executed, so
    # a running service has to go down first -- otherwise the install fails with
    # "Text file busy" halfway through, having already replaced data/.
    stopped_service=false
    if systemctl is-active --quiet wifilt 2>/dev/null; then
      warn "  Služba wifilt běží, instalace by přepisovala běžící binárku."
      if ask "Zastavit ji na dobu instalace?" Y; then
        sudo systemctl stop wifilt && stopped_service=true
      fi
    fi
    ( cd "$DIST_DIR" \
      && tar xzf "$(basename "$LINUX_ARCHIVE")" \
      && cd wifilt-linux-x86_64 \
      && sudo ./install.sh )
    install_status=$?
    if [[ $install_status -eq 0 ]]; then
      # The extracted tree is a by-product of installing, not of building; make
      # removes its own copy at the end of `dist` and this removes ours.
      rm -rf "${DIST_DIR}/wifilt-linux-x86_64"
      mark 6 "hotovo"
      $stopped_service && warn "  Službu jsi zastavil: sudo systemctl start wifilt"
    else
      mark 6 "selhalo"; abort "Instalace selhala." 6
    fi
  else
    mark 6 "přeskočeno"
  fi
fi

# ---------------------------------------------------------------- phase 7 ----
phase_banner 7 "flash firmware + assets do zařízení"
if ! skip_if_blocked 7; then
  declare -A PORT_LABEL=()
  if [[ -d /dev/serial/by-id ]]; then
    for link in /dev/serial/by-id/*; do
      [[ -e "$link" ]] || continue
      PORT_LABEL["$(readlink -f "$link")"]="$link"
    done
  fi
  mapfile -t PORTS < <(ls -1 /dev/ttyUSB* /dev/ttyACM* 2>/dev/null | sort)

  if [[ ${#PORTS[@]} -eq 0 ]]; then
    info "  Není připojený žádný sériový port -- fáze se přeskakuje."
    mark 7 "přeskočeno"
  elif ask "Nahrát do zařízení?" N; then
    say ""
    for i in "${!PORTS[@]}"; do
      dev="${PORTS[$i]}"
      label="${PORT_LABEL[$dev]:-}"
      printf '    %d) %-14s %s%s%s\n' "$((i + 1))" "$dev" "$C_DIM" \
        "${label:+$(basename "$label")}" "$C_OFF"
    done
    # IC-705 itself shows up as two ttyACM ports, which is exactly why the by-id
    # name is printed beside every device and why the by-id path is what gets
    # flashed: /dev/ttyUSB0 is whichever cable enumerated first.
    choice=1
    if [[ ${#PORTS[@]} -gt 1 ]]; then
      while true; do
        printf '%sPort [1-%d]:%s ' "$C_BOLD" "${#PORTS[@]}" "$C_OFF"
        IFS= read -r choice <&3 || abort "vstup uzavřen" 7
        [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#PORTS[@]} )) && break
        say "  zadej číslo 1 až ${#PORTS[@]}"
      done
    else
      info "  jediný port -- ${PORTS[0]}"
    fi
    dev="${PORTS[$((choice - 1))]}"
    port="${PORT_LABEL[$dev]:-$dev}"
    say ""
    if "${ROOT_DIR}/tools/upload-firmware-spiffs.sh" --port "$port"; then
      mark 7 "hotovo"
    else
      mark 7 "selhalo"; abort "Zápis do zařízení selhal." 7
    fi
  else
    mark 7 "přeskočeno"
  fi
fi

# ---------------------------------------------------------------- phase 8 ----
phase_banner 8 "git commit / git push"
if ! skip_if_blocked 8; then
  # Stamping before the commit, not after: gh-pages.sh runs prepare-spiffs-tree.sh
  # inside itself, and that rewrites the ?v= in the TRACKED data/*.html. Left for
  # phase 9 it would dirty the tree immediately after the commit that was meant
  # to capture it.
  if ! node "${ROOT_DIR}/tools/stamp-asset-versions.js" >/dev/null; then
    abort "stamp-asset-versions.js selhal." 8
  fi
  info "  ?v= v data/*.html přeraženy podle obsahu"

  changelog_rev="$(sed -n '/^## Working tree/,/^## REV/p' "${ROOT_DIR}/Changelog.md" \
                   | grep -o '\*\*REV [0-9]\+\.\*\*' | head -1 | grep -o '[0-9]\+' || true)"
  if [[ -z "$changelog_rev" ]]; then
    warn "  V sekci 'Working tree — not committed' není žádné **REV NNNNNNNN.**"
  elif [[ "$changelog_rev" != "$REV" ]]; then
    warn "  Changelog mluví o REV $changelog_rev, firmware nese REV $REV."
  else
    info "  Changelog a firmware se shodují na REV $REV"
  fi

  say ""
  git -C "$ROOT_DIR" status --short
  say ""
  git -C "$ROOT_DIR" diff --stat | tail -20
  say ""

  if [[ -z "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    info "  Není co commitovat."
    mark 8 "beze změny"
  elif ask "git add -A a commit?" N; then
    printf '%sZpráva commitu%s [REV %s]: ' "$C_BOLD" "$C_OFF" "$REV"
    IFS= read -r commit_msg <&3 || abort "vstup uzavřen" 8
    [[ -n "$commit_msg" ]] || commit_msg="REV $REV"
    git -C "$ROOT_DIR" add -A || abort "git add selhal" 8
    if git -C "$ROOT_DIR" commit -m "$commit_msg"; then
      mark 8 "hotovo"
    else
      mark 8 "selhalo"; abort "git commit selhal." 8
    fi
  else
    mark 8 "přeskočeno"
  fi

  if [[ "${RESULT[8]:-}" != "přeskočeno" ]]; then
    if ask "git push na origin/$BRANCH?" N; then
      if git -C "$ROOT_DIR" push origin "$BRANCH"; then
        ok "  pushnuto"
      else
        mark 8 "selhalo"; abort "git push selhal." 8
      fi
    else
      info "  nepushnuto -- fáze 9 to bude vyžadovat"
    fi
  fi
fi

# ---------------------------------------------------------------- phase 9 ----
phase_banner 9 "publikace instalační stránky"
if ! skip_if_blocked 9; then
  gate_ok=true
  gate() { fail "  ✗ $1"; gate_ok=false; }

  # A published page is the one step of this script that strangers see, and the
  # only one that cannot be taken back. Each check below is a way the page could
  # end up describing something that does not exist.
  [[ -f "$FIRMWARE_BIN" ]] || gate "chybí $(basename "$FIRMWARE_BIN") -- fáze 2 neproběhla"
  if [[ -f "$FIRMWARE_BIN" ]]; then
    while IFS= read -r -d '' source; do
      if [[ "$source" -nt "$FIRMWARE_BIN" ]]; then
        gate "export je starší než $(basename "$source") -- firmware neodpovídá zdroji"
        break
      fi
    done < <(find "$ROOT_DIR" -maxdepth 1 -type f \
             \( -name '*.ino' -o -name '*.h' -o -name '*.hpp' -o -name '*.cpp' \) -print0)
  fi

  win_archive="${DIST_DIR}/wifilt-${REV}-windows-x64.zip"
  if [[ ! -f "$LINUX_ARCHIVE" && ! -f "$win_archive" ]]; then
    gate "v native/dist není žádný archiv pro REV $REV -- fáze 3 neproběhla"
  elif [[ ! -f "$LINUX_ARCHIVE" ]]; then
    warn "  chybí linuxový archiv pro REV $REV -- stránka ho nenabídne"
  elif [[ ! -f "$win_archive" ]]; then
    warn "  chybí windowsový archiv pro REV $REV -- stránka ho nenabídne"
  fi

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

  if ! $gate_ok && $FORCE; then
    warn "  --force: publikuji přes výše uvedené závory"
    gate_ok=true
  fi

  if ! $gate_ok; then
    info "  fáze se nenabízí; obejít lze jen přes --force"
    mark 9 "nedostupné"
  elif ask "Publikovat stránku na origin/gh-pages?" N; then
    short="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "?")"
    if "${ROOT_DIR}/tools/gh-pages.sh" --publish --message "WIFILT REV ${REV} (${short})"; then
      mark 9 "hotovo"
      ok "  $PAGE_URL"
    else
      mark 9 "selhalo"; abort "Publikace selhala." 9
    fi
  else
    mark 9 "přeskočeno"
  fi
fi

print_summary
say ""
info "REV $REV | větev $BRANCH"
[[ "${RESULT[9]:-}" == "hotovo" ]] && ok "Stránka: $PAGE_URL"
exit 0
