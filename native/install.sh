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

# start-wifilt.sh (native/Makefile's dist-linux/dist-arm64 targets, next to
# this script) -- the shared launcher that starts wifilt (and local-trx, if
# also installed below) and opens both web interfaces, for an operator who
# would otherwise have no way to know there even are two separate programs.
[[ -f "$HERE/start-wifilt.sh" ]] && install -m 0755 "$HERE/start-wifilt.sh" "$PREFIX/start-wifilt.sh"

# The one privileged step. It is a property of the file, so it has to be redone
# after every upgrade -- which is why upgrading means re-running this script.
setcap cap_net_bind_service=+ep "$PREFIX/wifilt"

# local-trx (docs/local-trx-implementace.md) is optional and bundled into the
# release archive by tools/release.sh's own separate step, sitting right next
# to $BINARY -- but until now nothing here ever looked for it, so it was
# silently left behind in the extracted archive instead of reaching $PREFIX
# (found live: `sudo ./install.sh` then `/opt/wifilt/wifilt` produced no
# local-trx to run at all). Copy it across the same way, but do not start,
# enable or auto-open anything -- local-trx's own config.json "enabled"
# switch already defaults to off (bod: master switch) until an operator has
# walked through its setup wizard, the same caution wifilt.service's own
# "installed but not enabled" gets below.
LOCAL_TRX_BIN="$HERE/local-trx"
LOCAL_TRX_WEBUI="$HERE/webui"
if [[ -x "$LOCAL_TRX_BIN" && -d "$LOCAL_TRX_WEBUI" ]]; then
  install -m 0755 "$LOCAL_TRX_BIN" "$PREFIX/local-trx"
  rm -rf "$PREFIX/webui"
  cp -r "$LOCAL_TRX_WEBUI" "$PREFIX/webui"
  INSTALLED_LOCAL_TRX=1
else
  INSTALLED_LOCAL_TRX=0
fi

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

# start-wifilt.sh (copied above, if this archive has it) starts wifilt AND
# local-trx (if also installed) and opens both web interfaces -- the
# recommended manual alternative to systemd once both are actually wanted
# running. Falls back to naming the raw binary for an older extracted
# archive that predates the launcher.
if [[ -f "$PREFIX/start-wifilt.sh" ]]; then
  RUN_LINE="  or just run it     $PREFIX/start-wifilt.sh  (opens the browser itself)"
else
  RUN_LINE="  or just run it     $PREFIX/wifilt"
fi

cat <<EOF

installed to $PREFIX

  start now          sudo systemctl start wifilt
  start at boot      sudo systemctl enable --now wifilt
$RUN_LINE

then open            http://wifilt.local

The service is installed but NOT enabled -- starting a transmitter's control
interface at boot should be a decision, not a side effect of installing.
EOF

if [[ $INSTALLED_LOCAL_TRX -eq 1 ]]; then
  cat <<EOF

local-trx (PC bridge for a non-Icom radio, see BUILD.md § 5) was also found
next to this script and installed to $PREFIX/local-trx.
It has NO systemd unit and is disabled by default until its own setup
wizard is used once to turn it on -- $PREFIX/start-wifilt.sh above starts
it alongside wifilt and opens both wizards' pages; running
$PREFIX/local-trx directly works too, just on its own.
EOF
fi
