#!/usr/bin/env bash
#
# wifilt-pi-setup -- download the newest WIFILT package for Raspberry Pi
# (64-bit) and run its guided installer (pi-setup.sh).
#
#   curl -fsSL https://ok1hra.github.io/wifilt/pi-setup | bash
#   wifilt-pi-setup                      the same, once installed
#   wifilt-pi-setup --version 20261107   a specific package version
#   wifilt-pi-setup --archive FILE       a package already downloaded
#   wifilt-pi-setup --keep-unlocked      cancel a pending automatic re-lock
#
# Every other option is passed to pi-setup.sh (--yes, --only, --force,
# --dry-run; see wifilt-pi-setup --help-setup).
#
# The download is checked against the published SHA256SUMS.

# Everything is inside main(), so a download cut short by `curl | bash` runs nothing.
main() {
  set -euo pipefail
  local base=${WIFILT_BASE_URL:-https://ok1hra.github.io/wifilt}
  local arch=linux-arm64 version="" archive="" pass=() a

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version)   version="${2:?--version needs a value}"; shift ;;
      --archive)   archive="${2:?--archive needs a file}"; shift ;;
      --keep-unlocked)
        # no download needed just to cancel a timer
        if systemctl is-active --quiet wifilt-pi-relock.timer; then
          sudo systemctl stop wifilt-pi-relock.timer
          echo "Automatic lock cancelled. Lock later with: sudo fslock lock"
        else
          echo "No automatic lock is pending."
        fi
        sudo rm -f /run/wifilt-pi/relock-at
        return 0 ;;
      -h|--help)   sed -n '2,/^# The download/p' "${BASH_SOURCE[0]:-/usr/local/sbin/wifilt-pi-setup}" 2>/dev/null \
                     | sed 's/^# \{0,1\}//' || echo "see https://ok1hra.github.io/wifilt/"; return 0 ;;
      --help-setup) pass+=(--help) ;;
      *)           pass+=("$1") ;;
    esac
    shift
  done

  case $(uname -m) in
    aarch64|arm64) ;;
    armv7l|armv6l) echo "This is a 32-bit system. WIFILT needs Raspberry Pi OS (64-bit) -- re-image the card." >&2; return 1 ;;
    *) [[ ${PI_SETUP_ALLOW_ARCH:-0} == 1 ]] || { echo "This installer is for a 64-bit Raspberry Pi ($(uname -m) found)." >&2; return 1; } ;;
  esac
  for a in curl tar sha256sum sudo; do
    command -v "$a" >/dev/null 2>&1 || { echo "missing program: $a" >&2; return 1; }
  done

  local work
  work=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT

  if [[ -z $archive ]]; then
    if [[ -z $version ]]; then
      echo "Looking for the newest version on $base ..."
      version=$(curl -fsSL "$base/" | grep -oE "wifilt-[0-9]{8}-${arch}\.tar\.gz" | head -n1 \
        | sed -E 's/^wifilt-([0-9]{8})-.*/\1/') || true
      [[ -n $version ]] || { echo "no $arch package found on $base" >&2; return 1; }
    fi
    local name="wifilt-${version}-${arch}.tar.gz" expected=""
    echo "Downloading $name ..."
    curl -fL --progress-bar -o "$work/$name" "$base/$name" || { echo "download of $base/$name failed" >&2; return 1; }
    if curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS"; then
      expected=$(grep -E "[ */.]${name}\$" "$work/SHA256SUMS" | awk '{print $1}' | head -n1)
    fi
    if [[ -n $expected ]]; then
      [[ $(sha256sum "$work/$name" | awk '{print $1}') == "$expected" ]] \
        || { echo "checksum mismatch -- download damaged or tampered with" >&2; return 1; }
      echo "SHA256 ok."
    else
      echo "WARNING: $name is not listed in SHA256SUMS, checksum not verified." >&2
    fi
    archive="$work/$name"
  fi

  mkdir "$work/x"
  tar xzf "$archive" -C "$work/x"
  local setup
  setup=$(find "$work/x" -maxdepth 2 -name pi-setup.sh -type f | head -n1)
  [[ -n $setup ]] || { echo "this package has no pi-setup.sh (too old?)" >&2; return 1; }

  # stdin is this script when piped from curl; pi-setup.sh reads the terminal itself
  local rc=0
  if [[ $EUID -eq 0 || " ${pass[*]:-} " == *" --dry-run "* ]]; then
    bash "$setup" --from-bootstrap "${pass[@]}" || rc=$?
  else
    sudo env PI_SETUP_SSH="${SSH_CONNECTION:-}" bash "$setup" --from-bootstrap "${pass[@]}" || rc=$?
  fi
  return "$rc"
}

main "$@"
