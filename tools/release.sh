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
# M5Stack Atom Lite -- built alongside the box in phase 2, gated alongside it in
# phase 9. Same first-class treatment as the box: a failed Atom export aborts
# the release the same way a failed box export does, see phase 2 below.
FIRMWARE_BIN_M5ATOM="${ROOT_DIR}/wifilt.ino.m5stack_atom.bin"
DIST_DIR="${ROOT_DIR}/native/dist"
NATIVE_BIN="${ROOT_DIR}/native/build/wifilt"
# getcap lives in /sbin, which is not on a normal user's PATH on Debian. Looking
# it up by name alone therefore reports "no capability" for a binary that has
# one, and asks for a sudo password that changes nothing.
GETCAP=""
for _cap_candidate in "$(command -v getcap || true)" /sbin/getcap /usr/sbin/getcap; do
  if [[ -n "$_cap_candidate" && -x "$_cap_candidate" ]]; then GETCAP="$_cap_candidate"; break; fi
done
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
  3  make -C native dist (+ bundle local-trx) (Y/n, Y/n)
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
  if [[ -n "$GETCAP" ]]; then
    if "$GETCAP" "$NATIVE_BIN" 2>/dev/null | grep -q cap_net_bind_service; then
      return 0
    fi
    warn "  Binárka nemá CAP_NET_BIND_SERVICE -- $1"
  else
    warn "  getcap nenalezen, capability nelze ověřit -- $1"
  fi
  if ask "Udělit ji přes sudo (vyžádá heslo)?" N; then
    make -C "${ROOT_DIR}/native" setcap && return 0
    warn "  setcap se nepovedl"
  fi
  return 1
}

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
  if ask "  Zkompilovat teď (řádově minuty, jednorázově -- příště se přeskočí)?" Y; then
    "${ROOT_DIR}/local-trx/third_party/build-cross-libs.sh" "$target" && return 0
    warn "  build-cross-libs.sh $target selhal"
  fi
  return 1
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
  || { report_tool "node" 0 "chybí"; BLOCKED[3]="node chybí"; BLOCKED[7]="node chybí"; BLOCKED[9]="node chybí"; }
have 7z && report_tool "7z" 1 "$(command -v 7z)" \
  || { report_tool "7z" 0 "chybí (p7zip-full)"; BLOCKED[3]="7z chybí"; BLOCKED[7]="7z chybí"; BLOCKED[9]="7z chybí"; }
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

# REV is final after phase 1 (it only ever changes there) -- defined here,
# once, so every later phase that names the Linux archive (3's local-trx
# bundling, 6's install, 9's publish gate) shares one path instead of each
# phase re-deriving it or -- as phase 3's local-trx bundling briefly did --
# using it before it was ever set at all (found by code review: a bare
# reference under `set -u` aborted the whole script mid-phase-3).
LINUX_ARCHIVE="${DIST_DIR}/wifilt-${REV}-linux-x86_64.tar.gz"

# ---------------------------------------------------------------- phase 2 ----
phase_banner 2 "export compiled binary"
if ! skip_if_blocked 2; then
  info "  ESP32 Dev Module | No OTA (2MB APP/2MB SPIFFS) | DIO"
  info "  + M5Stack Atom Lite | same partitions.csv | DIO (board default)"
  if ask "Přeložit a vyexportovat firmware (box + M5Atom Lite)?" Y; then
    if ARDUINO_IDE="$ARDUINO_BIN" "${ROOT_DIR}/tools/export-compiled-binary.sh"; then
      # Same script, same Arduino 1.8 headless path, just the other FQBN --
      # export-compiled-binary.sh names the output after the board's
      # build.variant (m5stack-atom -> m5stack_atom), so FIRMWARE_BIN_M5ATOM
      # above is exactly what this run produces.
      if ARDUINO_IDE="$ARDUINO_BIN" "${ROOT_DIR}/tools/export-compiled-binary.sh" \
          --fqbn "esp32:esp32:m5stack-atom"; then
        mark 2 "hotovo"
      else
        mark 2 "selhalo"; abort "Překlad M5Atom Lite selhal." 2
      fi
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
  # dist-linux always; dist-windows/dist-arm64 only when their cross-toolchain
  # was found in phase 0. Built as an explicit target list (not the Makefile's
  # `dist` aggregate) so a missing toolchain degrades one archive at a time
  # instead of failing the whole phase.
  dist_targets=(dist-linux)
  [[ -z "$DEGRADED_WINDOWS" ]] && dist_targets+=(dist-windows)
  [[ -z "$DEGRADED_ARM64"   ]] && dist_targets+=(dist-arm64)
  dist_default=Y
  if [[ -n "$DEGRADED_WINDOWS" || -n "$DEGRADED_ARM64" ]]; then
    [[ -n "$DEGRADED_WINDOWS" ]] && warn "  $DEGRADED_WINDOWS -- stránka bude bez Windows odkazu."
    [[ -n "$DEGRADED_ARM64"   ]] && warn "  $DEGRADED_ARM64 -- stránka bude bez Raspberry Pi odkazu."
    dist_default=N
  fi
  if ask "Sestavit PC balíky pro REV $REV (${dist_targets[*]})?" "$dist_default"; then
    # Archives of other revisions have to go before make runs: the sha256sum
    # step below would otherwise publish a checksum file describing releases
    # that are not on the page. native/dist is in .gitignore, so nothing here
    # is worth keeping.
    if [[ -d "$DIST_DIR" ]]; then
      while IFS= read -r -d '' stale; do
        info "  mažu $(basename "$stale")"
        rm -rf "$stale"
      done < <(find "$DIST_DIR" -mindepth 1 -maxdepth 1 \
                 \( -type d -o -name '*.tar.gz' -o -name '*.zip' \) \
                 ! -name "*-${REV}-*" -print0)
    fi
    make -C "${ROOT_DIR}/native" "${dist_targets[@]}"
    dist_status=$?
    if [[ $dist_status -eq 0 ]]; then
      rm -rf "${DIST_DIR}/assets"

      # local-trx bundling: same three archives, default Y -- see the helper
      # functions' own comments for why this lives here rather than in
      # native/Makefile. Off entirely when phase 0 found no hamlib/
      # libserialport -dev packages; degrades one PLATFORM at a time
      # otherwise (a Windows/ARM64 cross-lib build the operator declines
      # just means that one archive ships without local-trx, same spirit as
      # DEGRADED_WINDOWS/DEGRADED_ARM64 above).
      if [[ -n "$LOCAL_TRX_UNAVAILABLE" ]]; then
        info "  local-trx: $LOCAL_TRX_UNAVAILABLE -- balíčky bez něj."
      elif ask "Zahrnout do balíků i local-trx (PC bridge pro libovolný rig, ve výchozím stavu vypnutý)?" Y; then
        LOCAL_TRX_BUNDLED=()
        info "  make -C local-trx (Linux x86_64)"
        if make -C "${ROOT_DIR}/local-trx" >/dev/null 2>&1; then
          if bundle_local_trx_into "$LINUX_ARCHIVE" "wifilt-linux-x86_64" \
              "${ROOT_DIR}/local-trx/build/local-trx" tar; then
            LOCAL_TRX_BUNDLED+=("linux-x86_64")
          fi
        else
          warn "  make -C local-trx selhalo -- linuxový balíček bez local-trx"
        fi

        # Windows and ARM64 are the same shape end to end (gate on
        # dist_targets, cross-compile the libs, cross-build local-trx itself,
        # bundle into that platform's archive) -- unlike the Linux x86_64
        # case just above, which needs neither a dist_targets gate nor
        # ensure_local_trx_cross_libs at all (host build, not cross). One
        # data-driven loop over the two instead of two copy-pasted if blocks
        # differing only in these five values (found by code review).
        # Fields: make-target | dist_targets gate | archive path | staging
        # dir name | built binary path | tar/zip kind | display name for the
        # warn() message.
        # NOT `local` -- this whole phase runs at the script's top level, not
        # inside a function (same as dist_targets/LOCAL_TRX_BUNDLED right
        # above), so `local` here would be a bash runtime error ("can only be
        # used in a function"), not a scoping nicety.
        local_trx_cross_targets=(
          "win|dist-windows|${DIST_DIR}/wifilt-${REV}-windows-x64.zip|wifilt-windows-x64|${ROOT_DIR}/local-trx/build-win/local-trx.exe|zip|Windows"
          "arm64|dist-arm64|${DIST_DIR}/wifilt-${REV}-linux-arm64.tar.gz|wifilt-linux-arm64|${ROOT_DIR}/local-trx/build-arm64/local-trx|tar|ARM64"
        )
        for entry in "${local_trx_cross_targets[@]}"; do
          IFS='|' read -r target gate archive staging bin kind label <<< "$entry"
          [[ " ${dist_targets[*]} " == *" $gate "* ]] || continue
          if ensure_local_trx_cross_libs "$target" && make -C "${ROOT_DIR}/local-trx" "$target" >/dev/null 2>&1; then
            # staging dir name is always "wifilt-<bundled label>" (e.g.
            # wifilt-windows-x64 -> windows-x64) -- one source of truth
            # instead of a separate, driftable eighth field.
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
      fi

      # Po případném přibalení local-trx výše -- součty musí sedět na to, co
      # se skutečně publikuje, ne na mezistav před bundlováním.
      ( cd "$DIST_DIR" && sha256sum ./*.tar.gz ./*.zip >SHA256SUMS 2>/dev/null || true )
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
  local_ips="$(hostname -I 2>/dev/null) 127.0.0.1"
  info "  http://localhost/   -- Ctrl-C binárku ukončí a skript pokračuje"
  for ip in $(hostname -I 2>/dev/null); do info "  http://${ip}/"; done
  # The binary announces itself as wifilt.local, but that name is only as good
  # as whatever resolves it -- and `files` precedes `mdns4_minimal` in nsswitch,
  # so one line in /etc/hosts silences the responder completely. When that line
  # points at an address on a network this machine is not on, the result looks
  # exactly like a web server that does not work.
  resolved="$(getent hosts wifilt.local 2>/dev/null | awk '{print $1; exit}')"
  if [[ -n "$resolved" && " $local_ips " != *" $resolved "* ]]; then
    warn "  POZOR: wifilt.local ukazuje na $resolved, což není tento počítač."
    if grep -qs 'wifilt\.local' /etc/hosts; then
      warn "  Zdroj je řádek v /etc/hosts, který má přednost před mDNS:"
      warn "    $(grep -s 'wifilt\.local' /etc/hosts | head -1)"
    fi
    warn "  Otevři adresu výše, ne wifilt.local."
  elif [[ -z "$resolved" ]]; then
    info "  wifilt.local se zatím neresolvuje; responder odpovídá až po startu"
  fi
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
if [[ ! -f "$LINUX_ARCHIVE" ]]; then
  info "  chybí $(basename "$LINUX_ARCHIVE") -- fáze 3 neproběhla."
  mark 6 "nedostupné"
else
  # $LINUX_ARCHIVE existuje jen podle JMÉNA (wifilt-$REV-...) -- to samo o
  # sobě neznamená, že ho TENHLE běh skriptu doopravdy přebudoval. Fáze 3
  # přeskočená ("Sestavit PC balíky?" -> N) nechá ležet archiv ze STARŠÍHO
  # běhu se stejným REV beze změny, a tahle fáze by ho tiše nainstalovala,
  # i kdyby mezitím zdroj (třeba start-wifilt.sh) doznal opravu, co do něj
  # ještě nestihla. Nalezeno živě: operátor spustil release.sh, fáze 3
  # odmítnuta (archiv "už přece existuje"), instalace pak potichu nasadila
  # hodiny starý archiv bez čerstvé opravy.
  install_ok_to_proceed=1
  if [[ "${RESULT[3]:-}" != "hotovo" ]]; then
    warn "  $(basename "$LINUX_ARCHIVE") NEBYL přebudován v tomhle běhu (fáze 3: ${RESULT[3]:-neproběhla}) --"
    warn "  může být starší, než aktuální zdrojový strom."
    ask "Přesto nainstalovat tenhle existující archiv?" N || install_ok_to_proceed=0
  fi
  if [[ $install_ok_to_proceed -eq 0 ]]; then
    mark 6 "přeskočeno"
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
  elif ask "Nahrát do zařízení?" Y; then
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
