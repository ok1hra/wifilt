# shellcheck shell=bash
#
# pi-setup: platform checks, station user, what is already installed.

PREFIX=/opt/wifilt
ROOT_RO=/media/root-ro          # where overlayroot mounts the real root
CMDLINE=/boot/firmware/cmdline.txt

fs_locked_now()  { [[ $(findmnt -no FSTYPE / 2>/dev/null) == overlay ]]; }
fs_locked_conf() { grep -q 'overlayroot=tmpfs' "$CMDLINE" 2>/dev/null; }

pkg_version() { cat "$PKG/VERSION" 2>/dev/null || echo "unknown"; }
installed_version() { cat "$PREFIX/VERSION" 2>/dev/null || { [[ -x $PREFIX/wifilt ]] && echo "unknown"; } || echo "none"; }

preflight() {
  local arch id ver
  arch=$(uname -m)
  case $arch in
    aarch64|arm64) ;;
    armv7l|armv6l) die "this is a 32-bit system ($arch). WIFILT needs the 64-bit Raspberry Pi OS -- re-image the card with 'Raspberry Pi OS Lite (64-bit)'." ;;
    *) [[ ${PI_SETUP_ALLOW_ARCH:-0} == 1 ]] || die "unsupported architecture $arch: this installer is for a 64-bit Raspberry Pi" ;;
  esac

  read -r id ver < <(
    # shellcheck disable=SC1091
    . /etc/os-release && echo "${ID:-?} ${VERSION_CODENAME:-?}")
  case $ver in
    bookworm|trixie) ;;
    *) warn "tested on Raspberry Pi OS bookworm and trixie, this is ${id:-?} ${ver:-?}" ;;
  esac

  [[ -d /run/systemd/system ]] || die "systemd is not running"
  if ! systemctl is-active --quiet NetworkManager; then
    warn "NetworkManager is not running -- the network step will not be offered"
    NO_NM=1
  else
    NO_NM=0
  fi

  LOCKED=0
  if fs_locked_now; then
    fs_locked_conf || die "the system is locked, but already set to unlock at the next boot. Reboot first, then run pi-setup again."
    [[ -x /usr/local/sbin/fslock ]] || die "the root file system is an overlay, but fslock is not installed -- unlock it manually (remove overlayroot= from $CMDLINE) and reboot"
    LOCKED=1
  elif fs_locked_conf; then
    die "the system is set to lock at the next boot (fslock). Reboot first, or cancel with 'sudo fslock unlock'."
  fi

  if ! curl -fsS -m 10 -o /dev/null https://github.com 2>/dev/null; then
    warn "no connection to github.com -- packages and the OI3 firmware cannot be downloaded"
  fi

  # The interface this SSH session runs over (from the client's view: server IP)
  SSH_IFACE=""
  local sip
  sip=$(awk '{print $3}' <<<"${PI_SETUP_SSH:-}")
  if [[ -n $sip ]]; then
    SSH_IFACE=$(ip -o addr show 2>/dev/null | awk -v ip="$sip" '{split($4, a, "/"); if (a[1] == ip) {print $2; exit}}')
  fi
}

# The user the services run as and whose ~/.config holds the settings.
resolve_user() {
  local def=${RUN_USER:-}
  [[ -z $def && -n ${SUDO_USER:-} && $SUDO_USER != root ]] && def=$SUDO_USER
  [[ -z $def ]] && def=$(getent passwd 1000 | cut -d: -f1)
  if [[ -z ${RUN_USER:-} ]] && interactive && [[ $RESUME -eq 0 ]]; then
    echo
    say "WIFILT and local-trx run as an ordinary user; their settings live in that"
    say "user's ~/.config."
    ask_str RUN_USER "Station user" "$def" v_user
  else
    RUN_USER=$def
  fi
  getent passwd "$RUN_USER" >/dev/null || die "user '$RUN_USER' does not exist"
  RUN_HOME=$(getent passwd "$RUN_USER" | cut -d: -f6)
}
v_user() { getent passwd "$1" >/dev/null && [[ $1 != root ]] || { echo "No such (non-root) user."; return 1; }; }

# What is on the system already. setup.conf answers this after the first run;
# before that (a station set up by hand) it is read from the system itself, so
# an update never duplicates what is there.
detect_existing() {
  if [[ -r $SETUP_CONF ]]; then
    MODE=update; MODE_TEXT="update"
    return
  fi
  if [[ -x $PREFIX/wifilt ]]; then MODE=update; MODE_TEXT="update of an existing installation"
  else MODE=fresh; MODE_TEXT="new installation"; fi

  HAVE_SERIAL=0 HAVE_ETH=0 HAVE_AP=0 HAVE_OI3=0 HAVE_FSLOCK=0
  # serial aliases made by hand count as "kept as they are" (see serial.sh)
  [[ $NO_NM == 0 ]] && nmcli -t -f NAME connection show 2>/dev/null | grep -qx 'eth0-dhcp-server' && HAVE_ETH=1
  [[ -x /usr/local/sbin/wifi-fallback ]] && HAVE_AP=1
  [[ -x /usr/local/sbin/fslock ]] && HAVE_FSLOCK=1
  local legacy="$RUN_HOME/.local/state/oi3/flashed" o t r
  if [[ -r $legacy ]]; then
    HAVE_OI3=1
    read -r o t r _ < "$legacy" || true
    OI3_REV=${r:-3_1415}
    [[ $DRY_RUN -eq 1 ]] || install -m 644 "$legacy" "$STATE_DIR/oi3-flashed" 2>/dev/null || true
  fi
  DATA_UUID=$(awk '$2 == "/data" && $1 ~ /^UUID=/ {sub(/^UUID=/, "", $1); print $1; exit}' /etc/fstab 2>/dev/null || true)
  if [[ $MODE == update ]]; then
    local found=()
    [[ $HAVE_ETH == 1 ]] && found+=("ethernet fallback")
    [[ $HAVE_AP == 1 ]] && found+=("wifi-fallback")
    [[ $HAVE_OI3 == 1 ]] && found+=("OI3 firmware state")
    [[ $HAVE_FSLOCK == 1 ]] && found+=("fslock")
    [[ ${#found[@]} -gt 0 ]] && MODE_TEXT+=", found: $(IFS=,; echo "${found[*]}" | sed 's/,/, /g')"
  fi
  return 0
}

final_checks() {
  local s
  echo
  echo "Status:"
  for s in wifilt local-trx wifi-fallback NetworkManager; do
    systemctl cat "$s" >/dev/null 2>&1 || continue
    printf '  %-16s %-10s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || true)" \
      "$(systemctl is-enabled "$s" 2>/dev/null || true)"
  done
  [[ -x $PREFIX/wifilt ]] && printf '  %-16s %s\n' "WIFILT version" "$(installed_version)"
  if [[ -x $PREFIX/wifilt ]] && ! getcap "$PREFIX/wifilt" 2>/dev/null | grep -q cap_net_bind_service; then
    printf '  %sWIFILT has no permission for port 80%s -- run pi-setup again\n' "$C_RED" "$C_0"
  fi
  local links
  links=$(ls /dev/ttyUSB.* 2>/dev/null | tr '\n' ' ' || true)
  [[ -n $links ]] && printf '  %-16s %s\n' "serial aliases" "$links"
  if [[ -x /usr/local/sbin/fslock ]]; then
    printf '  %-16s %s, data card %s\n' "fslock" \
      "$(fs_locked_now && echo locked || echo unlocked)" \
      "$(mountpoint -q /data && echo mounted || echo 'NOT mounted')"
  fi
  local host ip
  host=$(hostname)
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo
  echo "Open in a browser:"
  echo "  WIFILT     http://$host.local/      http://${ip:-<ip>}/"
  [[ -x $PREFIX/local-trx ]] && echo "  local-trx  http://$host.local:8765/  http://${ip:-<ip>}:8765/"
  return 0
}
