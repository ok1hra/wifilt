#!/usr/bin/env bash
#
# Build n2n 3.1.1 from source and install it into /usr/local
# (docs/vpn-n2n-implementace.md, SOFTWARE.md "Remote access").
#
#   sudo ./build-n2n.sh           build unless 3.1.1 is already installed
#   sudo ./build-n2n.sh --force   build anyway
#
# Installed by install.sh as $PREFIX/wifilt-vpn-build; run by the root helper
# (SETUP -> Remote access -> INSTALL n2n) and by pi-setup's "vpn" step.
#
# Why from source: Debian ships only n2n 1.3.1 (protocol v1, 2008). The tag is
# pinned AND its commit checked, so a moved tag never gets built.
# Why PREFIX=/usr/local: n2n's Makefile defaults to /usr, i.e. /usr/sbin/edge --
# the very file of Debian's n2n package, which apt would later put back to v1.
# Why --enable-pthread: without the resolver thread, edge 3.1.1 looks the
# supernode NAME up again before every registration and then throws the
# supernode's answers away ("Rx REGISTER_SUPER_ACK with wrong or old cookie",
# then "supernode not responding") -- found against remoteqth.com:82 on
# 2026-11-17. With an IP address it works either way; with a name only so.
#
# Progress goes to stdout as "PHASE <name> <text>" lines for the helper.
# Test overrides: WIFILT_N2N_REPO, WIFILT_N2N_PREFIX, WIFILT_N2N_SRC,
# WIFILT_N2N_SKIP_APT=1, WIFILT_N2N_SKIP_ROOT=1.

set -euo pipefail

N2N_TAG="3.1.1"
N2N_COMMIT="ce998b986c633bc563835d8a3cc8f72a017b53d1"
REPO="${WIFILT_N2N_REPO:-https://github.com/ntop/n2n.git}"
PREFIX="${WIFILT_N2N_PREFIX:-/usr/local}"
SRC="${WIFILT_N2N_SRC:-/var/tmp/wifilt-n2n}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

say() { echo "PHASE $1 ${2:-}"; }
die() { echo "ERROR: $*" >&2; exit "${CODE:-1}"; }

# "Welcome to n2n v.3.1.1 for Linux" -- on the SECOND line, edge -h starts with
# an empty one. Never `| grep -q` at the end of a pipe under pipefail (SIGPIPE
# turns a match into a failure).
installed_banner() { "$PREFIX/sbin/edge" -h 2>&1 | head -n3 | tr '\n' ' ' || true; }
is_installed() { case "$(installed_banner)" in *"n2n v.$N2N_TAG "*) return 0 ;; esac; return 1; }

if [[ $FORCE -eq 0 ]] && is_installed; then
  say "done" "n2n $N2N_TAG is already installed in $PREFIX/sbin"
  exit 0
fi

if [[ -z "${WIFILT_N2N_SKIP_ROOT:-}" && $EUID -ne 0 ]]; then
  CODE=2 die "needs root (apt-get and make install)"
fi

# A locked Raspberry Pi (fslock) keeps / in RAM: whatever gets installed now
# would be gone after the next reboot.
if [[ "$(findmnt -n -o FSTYPE / 2>/dev/null || true)" == "overlay" ]]; then
  CODE=3 die "the root filesystem is locked (fslock) -- unlock it first"
fi

say deps "installing the build tools"
if [[ -z "${WIFILT_N2N_SKIP_APT:-}" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || echo "apt-get update failed, trying the cached package lists" >&2
  apt-get install -y -qq build-essential autoconf automake libtool git
fi

say clone "downloading n2n $N2N_TAG"
rm -rf "$SRC"
git clone --quiet --depth 1 --branch "$N2N_TAG" "$REPO" "$SRC"

say verify "checking the source"
got="$(git -C "$SRC" rev-parse HEAD)"
[[ "$got" == "$N2N_COMMIT" ]] || CODE=4 die "tag $N2N_TAG of $REPO is $got, expected $N2N_COMMIT -- not building it"

say build "compiling (a minute or two on a Raspberry Pi)"
( cd "$SRC" && ./autogen.sh && ./configure --enable-pthread && make -j"$(nproc 2>/dev/null || echo 2)" )

say install "installing into $PREFIX/sbin"
make -C "$SRC" PREFIX="$PREFIX" install

is_installed || CODE=5 die "$PREFIX/sbin/edge does not report n2n $N2N_TAG after installing"
grep -a pthread_create "$PREFIX/sbin/edge" >/dev/null || CODE=5 die "$PREFIX/sbin/edge was built without the resolver thread"
rm -rf "$SRC"
say "done" "n2n $N2N_TAG installed in $PREFIX/sbin"
