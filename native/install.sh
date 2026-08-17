#!/usr/bin/env bash
#
# Install WIFILT on Linux.
#
#   sudo ./install.sh              install to /opt/wifilt
#   sudo ./install.sh --prefix DIR install somewhere else
#   sudo ./install.sh --uninstall
#
# What it does and why:
#
#   * copies the binary and the data/ tree to $PREFIX
#   * grants CAP_NET_BIND_SERVICE, without which ports 80, 82 and 83 cannot be
#     bound -- and 83 carries the audio, so JS8 and WSPR do not work at all
#   * installs a systemd unit that is NOT enabled by default
#
# It deliberately does not touch the configuration directory. That lives in the
# user's ~/.config/wifilt and holds callsign, radio credentials and the TX-gain
# calibration; reinstalling must never disturb it, exactly as a firmware flash
# on the hardware box must not wipe the config partition.

set -euo pipefail

PREFIX="/opt/wifilt"
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)    PREFIX="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)   sed -n '2,22p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "needs root -- the capability and the unit file both do" >&2
  exit 1
fi

UNIT=/etc/systemd/system/wifilt.service

if [[ $UNINSTALL -eq 1 ]]; then
  systemctl disable --now wifilt 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload 2>/dev/null || true
  rm -rf "$PREFIX"
  echo "removed $PREFIX and the service."
  echo "your configuration in ~/.config/wifilt was left alone."
  exit 0
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY="$HERE/wifilt"
ASSETS="$HERE/data"
[[ -x "$BINARY" ]] || { echo "wifilt not found next to this script" >&2; exit 1; }
[[ -d "$ASSETS" ]] || { echo "data/ not found next to this script" >&2; exit 1; }

install -d "$PREFIX"
install -m 0755 "$BINARY" "$PREFIX/wifilt"
rm -rf "$PREFIX/data"
cp -r "$ASSETS" "$PREFIX/data"

# The one privileged step. It is a property of the file, so it has to be redone
# after every upgrade -- which is why upgrading means re-running this script.
setcap cap_net_bind_service=+ep "$PREFIX/wifilt"

# Runs as the invoking user, not root: the config lives in their home directory,
# and nothing here needs root once the capability is granted.
RUN_USER="${SUDO_USER:-$USER}"
cat > "$UNIT" <<EOF
[Unit]
Description=WIFILT - web interface for networked transceivers
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
ExecStart=$PREFIX/wifilt --data-dir $PREFIX/data
Restart=on-failure
RestartSec=5
# stdin is not a terminal under systemd; the binary handles that (its serial
# console latches EOF instead of spinning), but there is nothing to read either.
StandardInput=null

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

cat <<EOF

installed to $PREFIX

  start now          sudo systemctl start wifilt
  start at boot      sudo systemctl enable --now wifilt
  or just run it     $PREFIX/wifilt

then open            http://wifilt.local

The service is installed but NOT enabled -- starting a transmitter's control
interface at boot should be a decision, not a side effect of installing.
EOF
