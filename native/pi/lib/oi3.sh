# shellcheck shell=bash
#
# pi-setup step 5: Open Interface III firmware, built from source and flashed.
#
# The firmware is compiled here from github.com/ok1hra/oi3 (board 3.1415 also
# needs the TrxNet library from github.com/ok1hra/TrxNet) with arduino-cli and
# uploaded through the board's USB port. It is flashed only when one of the two
# repositories has a new commit or the board revision changed.

OI3_REPO=ok1hra/oi3
TRXNET_REPO=ok1hra/TrxNet
OI3_FQBN=arduino:avr:mega
OI3_STATE=$STATE_DIR/oi3-flashed

# gh_head owner/repo -- SHA of the newest commit of the default branch (empty on error)
gh_head() {
  curl -fsSL -m 15 -H 'Accept: application/vnd.github.sha' \
    "https://api.github.com/repos/$1/commits/HEAD" 2>/dev/null | grep -xE '[0-9a-f]{40}' || true
}

short() { if [[ -n $1 && $1 != - ]]; then echo "${1:0:12}"; else echo "$2"; fi; }

ask_oi3() {
  header "Open Interface III firmware"
  local inst_oi3="" inst_trx="" inst_rev="" inst_fw=""
  [[ -r $OI3_STATE ]] && read -r inst_oi3 inst_trx inst_rev inst_fw < "$OI3_STATE"
  if [[ -n $inst_oi3 ]]; then
    current "flashed: oi3 ${inst_oi3:0:7}, board ${inst_rev//_/.}, firmware ${inst_fw}"
  else
    current "never flashed from this Pi"
  fi
  plan_line "build the firmware from github.com/$OI3_REPO and upload it over USB"
  DO_OI3=0
  ask_yn "Build and flash the Open Interface III firmware?" n || return 0

  say "  Board revision:"
  say "    1) 3.1415 -- with Ethernet / TrxNet"
  say "    2) 3.141  -- without Ethernet"
  local def=1 r
  [[ ${OI3_REV:-} == 3_141 ]] && def=2
  while :; do
    ask_str r "  Choice" "$def"
    case $r in 1) ANS_OI3_REV=3_1415; break ;; 2) ANS_OI3_REV=3_141; break ;; *) say "  1 or 2." ;; esac
  done
  local defport=${OI3_PORT:-/dev/ttyUSB.cw}
  [[ -n ${ANS_SERIAL_CW:-${SERIAL_CW:-}} ]] && defport=/dev/ttyUSB.cw
  ask_str ANS_OI3_PORT "  Serial port of the board" "$defport" v_nonempty

  local oc tc
  oc=$(gh_head "$OI3_REPO"); tc=$(gh_head "$TRXNET_REPO")
  say "  oi3 on GitHub: $(short "$oc" unknown), flashed: $(short "$inst_oi3" never)"
  [[ $ANS_OI3_REV == 3_1415 ]] && say "  TrxNet on GitHub: $(short "$tc" unknown), used: $(short "$inst_trx" never)"
  if [[ $FORCE -eq 0 && -n $oc && $oc == "$inst_oi3" && $ANS_OI3_REV == "$inst_rev" ]] \
     && [[ $ANS_OI3_REV == 3_141 || ( -n $tc && $tc == "$inst_trx" ) ]]; then
    say "  The board already runs this source."
    ask_yn "Flash anyway?" n || return 0
  fi
  DO_OI3=1
}

run_oi3() {
  local port=$ANS_OI3_PORT rev=$ANS_OI3_REV
  local oc tc cli_arch cli_ver work src hex fw dev stopped=() svc
  oc=$(gh_head "$OI3_REPO"); tc=$(gh_head "$TRXNET_REPO")

  # --- arduino-cli (not in apt: the official build from GitHub)
  if ! command -v arduino-cli >/dev/null 2>&1; then
    case $(uname -m) in
      aarch64|arm64) cli_arch=Linux_ARM64 ;;
      x86_64|amd64)  cli_arch=Linux_64bit ;;
      *) die "no arduino-cli build for $(uname -m)" ;;
    esac
    # the newest stable release (downloads.arduino.cc ..._latest_ may return a release candidate)
    cli_ver=$(curl -fsSI https://github.com/arduino/arduino-cli/releases/latest \
      | grep -i '^location:' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1) || true
    [[ -n $cli_ver ]] || die "cannot find the arduino-cli version"
    info "installing arduino-cli $cli_ver to /usr/local/bin"
    work=$(mktemp -d)
    curl -fL --progress-bar \
      "https://github.com/arduino/arduino-cli/releases/download/v${cli_ver}/arduino-cli_${cli_ver}_${cli_arch}.tar.gz" \
      | tar xz -C "$work" arduino-cli
    install -m 755 "$work/arduino-cli" /usr/local/bin/arduino-cli
    rm -rf "$work"
  fi
  as_user arduino-cli version

  # --- everything below runs as the station user, in their ~/.arduino15
  info "updating the arduino:avr core and libraries"
  as_user arduino-cli core update-index >/dev/null
  as_user arduino-cli core install arduino:avr
  as_user arduino-cli core upgrade arduino:avr >/dev/null 2>&1 || true
  as_user arduino-cli lib update-index >/dev/null
  as_user arduino-cli lib install LiquidCrystal SD Ethernet

  work=$(as_user mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT

  # TrxNet is not in the Library Manager -- always the exact commit from GitHub
  info "downloading the TrxNet library (github.com/$TRXNET_REPO)"
  local libdir="$RUN_HOME/Arduino/libraries"
  as_user mkdir -p "$libdir" "$work/TrxNet"
  curl -fsSL "https://codeload.github.com/$TRXNET_REPO/tar.gz/${tc:-HEAD}" \
    | as_user tar xz -C "$work/TrxNet" --strip-components=1
  rm -rf "$libdir/TrxNet"
  as_user mv "$work/TrxNet" "$libdir/TrxNet"

  # the sketch directory has to be named like oi3.ino
  info "downloading the firmware source (github.com/$OI3_REPO)"
  src="$work/oi3"
  as_user mkdir "$src"
  curl -fsSL "https://codeload.github.com/$OI3_REPO/tar.gz/${oc:-HEAD}" \
    | as_user tar xz -C "$src" --strip-components=1
  fw=$(grep -m1 -oE 'REV = "[0-9]+"' "$src/oi3.ino" | grep -oE '[0-9]+' || true)
  say "  firmware version in the source: ${fw:-unknown}"

  info "compiling (build.sh from the repository, several minutes)"
  ( cd "$src" && as_user bash "$src/build.sh" )
  hex="$src/out/$rev/PCB_${rev}_oi3.ino.hex"
  [[ -s $hex ]] || die "the build did not produce $hex"

  # --- free the port
  [[ -e $port ]] || die "$port does not exist (is the board connected? see step 'Serial port aliases')"
  dev=$(readlink -f "$port")
  if fuser "$dev" >/dev/null 2>&1; then
    info "$port is in use, stopping WIFILT / local-trx"
    for svc in wifilt local-trx; do
      systemctl is-active --quiet "$svc" && stopped+=("$svc")
    done
    systemctl stop wifilt local-trx 2>/dev/null || true
    [[ -x $PREFIX/start-wifilt.sh ]] && as_user "$PREFIX/start-wifilt.sh" stop >/dev/null 2>&1 || true
    sleep 1
    if fuser -v "$dev" 2>&1; then
      [[ ${#stopped[@]} -eq 0 ]] || systemctl start "${stopped[@]}" || true
      die "$port is still used by another program (see above)"
    fi
  fi

  # --- upload (avrdude from arduino:avr, wiring protocol at 115200 Bd)
  info "uploading PCB_${rev}_oi3.ino.hex to $port"
  local rc=0
  as_user arduino-cli upload -b "$OI3_FQBN" -p "$port" --input-file "$hex" || rc=$?
  if [[ ${#stopped[@]} -gt 0 ]]; then
    info "starting again: ${stopped[*]}"
    systemctl start "${stopped[@]}" || warn "starting the services failed"
  fi
  if [[ $rc -ne 0 ]]; then
    note "OI3 upload failed: 'stk500v2_getsync() failed' means the bootloader did not answer -- unplug and replug the board's USB and check that $port really leads to the OI3 (ls -l /dev/serial/by-id/)"
    die "firmware upload failed"
  fi
  echo "${oc:--} ${tc:--} $rev ${fw:--}" > "$OI3_STATE"
  ok "OI3 firmware ${fw:-?} (board ${rev//_/.}) uploaded to $port"
}

commit_oi3() { HAVE_OI3=1; OI3_REV=$ANS_OI3_REV; OI3_PORT=$ANS_OI3_PORT; }
