# shellcheck shell=bash
#
# pi-setup: shared helpers -- output, questions, saved answers, small file utils.
# Sourced by pi-setup.sh; never run directly.

# --- output -------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_B=$'\e[1m' C_DIM=$'\e[2m' C_RED=$'\e[1;31m' C_GRN=$'\e[1;32m' C_YEL=$'\e[1;33m' C_CYN=$'\e[36m' C_0=$'\e[0m'
else
  C_B="" C_DIM="" C_RED="" C_GRN="" C_YEL="" C_CYN="" C_0=""
fi

say()  { printf '%s\n' "$*"; }
info() { printf '%s==>%s %s\n' "$C_CYN" "$C_0" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$C_GRN" "$C_0" "$*"; }
warn() { printf '%sWARNING:%s %s\n' "$C_YEL" "$C_0" "$*" >&2; }
err()  { printf '%sERROR:%s %s\n' "$C_RED" "$C_0" "$*" >&2; }
die()  { err "$*"; exit 1; }

STEP_NO=0
STEP_TOTAL=7
header() {   # STEP_NO is set by the caller (pi-setup.sh), so --only keeps the real numbers
  printf '\n%s[%d/%d] %s%s\n' "$C_B" "$STEP_NO" "$STEP_TOTAL" "$1" "$C_0"
}
current() { printf '  %sCurrent:%s %s\n' "$C_DIM" "$C_0" "$*"; }
plan_line() { printf '  %sWill do:%s %s\n' "$C_DIM" "$C_0" "$*"; }

# Notes collected during the run and printed in the final summary. Steps run in
# subshells, so they live in files, not variables.
note()        { printf '%s\n' "$*" >> "$RUN_DIR/notes"; }
need_reboot() { printf '%s\n' "$*" >> "$RUN_DIR/reboot"; }

# --- questions ----------------------------------------------------------------
# Everything is read from /dev/tty, so the installer also works when it arrives
# through `curl ... | bash` (stdin is the script itself then). Without a
# terminal, or with --yes, every question takes its default.
interactive() { [[ "${ASSUME_YES:-0}" != 1 ]] && (exec </dev/tty) 2>/dev/null; }

# ask_yn "question" y|n  -> 0 = yes
ask_yn() {
  local q=$1 def=$2 ans hint
  [[ $def == y ]] && hint="[Y/n]" || hint="[y/N]"
  if ! interactive; then
    printf '  %s %s %s(default: %s)%s\n' "$q" "$hint" "$C_DIM" "$def" "$C_0"
    [[ $def == y ]]; return
  fi
  while :; do
    printf '  %s %s ' "$q" "$hint"
    read -r ans </dev/tty || ans=""
    ans=${ans,,}
    [[ -z $ans ]] && ans=$def
    case $ans in
      y|yes) return 0 ;;
      n|no)  return 1 ;;
      *)     say "  Please answer y or n." ;;
    esac
  done
}

# ask_str VAR "prompt" "default" [validator_fn]
# The validator gets the value and prints a reason on failure.
ask_str() {
  local __var=$1 q=$2 def=${3:-} check=${4:-} ans why
  if ! interactive; then
    printf -v "$__var" '%s' "$def"
    printf '  %s: %s %s(default)%s\n' "$q" "$def" "$C_DIM" "$C_0"
    return
  fi
  while :; do
    if [[ -n $def ]]; then printf '  %s [%s]: ' "$q" "$def"; else printf '  %s: ' "$q"; fi
    read -r ans </dev/tty || ans=""
    [[ -z $ans ]] && ans=$def
    if [[ -n $check ]] && ! why=$("$check" "$ans"); then
      say "  ${why:-invalid value}"
      continue
    fi
    printf -v "$__var" '%s' "$ans"
    return
  done
}

# ask_secret VAR "prompt" validator_fn  -- typed twice, never echoed or logged
ask_secret() {
  local __var=$1 q=$2 check=$3 a b why
  interactive || die "$q: needs an interactive terminal (no saved value to use)"
  while :; do
    printf '  %s: ' "$q"; read -rs a </dev/tty || a=""; echo
    if ! why=$("$check" "$a"); then say "  $why"; continue; fi
    printf '  Again: '; read -rs b </dev/tty || b=""; echo
    [[ $a == "$b" ]] && break
    say "  The two entries differ, try again."
  done
  printf -v "$__var" '%s' "$a"
}

# --- saved answers ------------------------------------------------------------
# /etc/wifilt-pi/setup.conf remembers what was installed and the answers given,
# so the next run (an update) can offer them as defaults. Shell syntax, written
# with printf %q, read back by sourcing.
SETUP_CONF=/etc/wifilt-pi/setup.conf
SAVED_VARS=(RUN_USER HAVE_SERIAL HAVE_ETH HAVE_AP HAVE_OI3 HAVE_FSLOCK
            SERIAL_CAT SERIAL_CW SERIAL_PANEL ETH_SERVER_ADDR OI3_REV OI3_PORT
            DATA_UUID WIFILT_ENABLE)

load_setup_conf() {
  # shellcheck disable=SC1090
  [[ -r $SETUP_CONF ]] && . "$SETUP_CONF"
  return 0
}

save_setup_conf() {
  local v
  install -d -m 755 "$(dirname "$SETUP_CONF")"
  {
    echo "# written by pi-setup $(date -Iseconds) -- answers reused by the next run"
    for v in "${SAVED_VARS[@]}"; do
      printf '%s=%q\n' "$v" "${!v-}"
    done
  } > "$SETUP_CONF.tmp"
  chmod 600 "$SETUP_CONF.tmp"
  mv -f "$SETUP_CONF.tmp" "$SETUP_CONF"
}

# Decisions of the question phase (DO_* and their parameters), saved for the
# run phase. In a locked update they survive a reboot this way.
save_answers() { # -> stdout
  local v
  for v in $(compgen -v | grep -E '^(DO_|ANS_)'); do
    printf '%s=%q\n' "$v" "${!v-}"
  done
}

# --- files --------------------------------------------------------------------
# put_file SRC DEST MODE -- install only when the content differs; prints what
# happened and returns 0 if the file changed, 1 if it was already identical.
put_file() {
  local src=$1 dest=$2 mode=$3
  if [[ -f $dest ]] && cmp -s "$src" "$dest"; then
    chmod "$mode" "$dest"
    say "  unchanged  $dest"
    return 1
  fi
  install -D -m "$mode" "$src" "$dest"
  say "  written    $dest"
  return 0
}

# put_text DEST MODE  (content on stdin)
put_text() {
  local tmp
  tmp=$(mktemp)
  cat > "$tmp"
  local rc=0
  put_file "$tmp" "$1" "$2" || rc=$?
  rm -f "$tmp"
  return $rc
}

# replace_block FILE MARKER  (block content on stdin)
# Keeps everything outside "# >>> MARKER >>>" ... "# <<< MARKER <<<" and puts
# the new block at the end, so running twice never duplicates lines.
replace_block() {
  local f=$1 m=$2 tmp
  tmp=$(mktemp)
  if [[ -f $f ]]; then
    awk -v b="# >>> $m >>>" -v e="# <<< $m <<<" '
      $0 == b { skip = 1; next }
      $0 == e { skip = 0; next }
      !skip { print }' "$f" > "$tmp"
  fi
  # one blank line before the block, never a growing stack of them
  sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$tmp"
  {
    [[ -s $tmp ]] && echo
    echo "# >>> $m >>>"
    cat
    echo "# <<< $m <<<"
  } >> "$tmp"
  if [[ -f $f ]] && cmp -s "$tmp" "$f"; then
    rm -f "$tmp"; say "  unchanged  $f"; return 1
  fi
  cat "$tmp" > "$f"
  rm -f "$tmp"
  say "  updated    $f"
}

# as_user CMD... -- run as the station user with their own HOME
as_user() { sudo -u "$RUN_USER" -H -- "$@"; }

# tree_hash DIR -- one hash over the files a WIFILT install consists of, so the
# package and /opt/wifilt can be compared without any stored state
tree_hash() {
  local d=$1
  [[ -x $d/wifilt ]] || { echo none; return; }
  # find complains about the parts a package does not have (no local-trx)
  ( cd "$d" && { find wifilt local-trx start-wifilt.sh data webui -type f 2>/dev/null || true; } \
      | LC_ALL=C sort | xargs -r -d '\n' sha256sum | sha256sum | cut -c1-16 )
}

# --- validators (print a reason, return 1) ------------------------------------
v_nonempty() { [[ -n $1 ]] || { echo "Must not be empty."; return 1; }; }
v_psk() {
  local n=${#1}
  if (( n >= 8 && n <= 63 )); then return 0; fi
  if (( n == 64 )) && [[ $1 =~ ^[0-9a-fA-F]+$ ]]; then return 0; fi
  echo "A WPA2 password has 8 to 63 characters."; return 1
}
v_ssid() {
  local n
  n=$(printf '%s' "$1" | wc -c)
  (( n >= 1 && n <= 32 )) || { echo "An SSID has 1 to 32 bytes."; return 1; }
}
v_cidr() {
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/(8|16|24)$ ]] \
    || { echo "Expected an address with prefix, e.g. 192.168.50.1/24 (prefix 8, 16 or 24)."; return 1; }
}
v_minutes() { [[ $1 =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 1440 )) || { echo "Minutes, 1 to 1440."; return 1; }; }
