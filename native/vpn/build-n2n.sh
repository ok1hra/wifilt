#!/usr/bin/env bash
#
# Install n2n 3.1.1 into /usr/local: the copy built for this release of WIFILT
# when there is one and it runs here, otherwise built from source
# (docs/vpn-n2n-implementace.md, SOFTWARE.md "Remote access").
#
#   sudo ./build-n2n.sh                 unless a good 3.1.1 is installed: the
#                                       bundled copy, or a build from source
#   sudo ./build-n2n.sh --force         build from source anyway
#   sudo ./build-n2n.sh --bundled-only  install.sh: the bundled copy or nothing
#
# Installed by install.sh as $PREFIX/wifilt-vpn-build; run by the root helper
# (SETUP -> Remote access -> INSTALL n2n), by pi-setup's "vpn" step and, with
# --bundled-only, by install.sh itself (so by the web update too).
#
# "Good" is n2n 3.1.1 WITH the resolver thread. The bundled copy is n2n/edge
# next to this script (in the archive: n2n/ beside build-n2n.sh; installed:
# $PREFIX/n2n/), built by native/vpn/build-n2n-dist.sh at release time.
# --bundled-only never builds and never replaces an n2n of another version --
# that one may be the operator's own, for another network; it replaces only a
# missing edge or a 3.1.1 without the resolver thread.
#
# Why from source as the fallback: Debian ships only n2n 1.3.1 (protocol v1,
# 2008). The tag is pinned AND its commit checked, so a moved tag never gets built.
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
# WIFILT_N2N_BUNDLED, WIFILT_N2N_SKIP_APT=1, WIFILT_N2N_SKIP_ROOT=1.

set -euo pipefail

N2N_TAG="3.1.1"
N2N_COMMIT="ce998b986c633bc563835d8a3cc8f72a017b53d1"
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO="${WIFILT_N2N_REPO:-https://github.com/ntop/n2n.git}"
PREFIX="${WIFILT_N2N_PREFIX:-/usr/local}"
SRC="${WIFILT_N2N_SRC:-/var/tmp/wifilt-n2n}"
BUNDLED="${WIFILT_N2N_BUNDLED:-$HERE/n2n/edge}"
EDGE="$PREFIX/sbin/edge"
MODE=auto
case "${1:-}" in
  --force)        MODE=force ;;
  --bundled-only) MODE=bundled ;;
  "") ;;
  *) echo "usage: $0 [--force|--bundled-only]" >&2; exit 2 ;;
esac

say() { echo "PHASE $1 ${2:-}"; }
die() { echo "ERROR: $*" >&2; exit "${CODE:-1}"; }

# "Welcome to n2n v.3.1.1 for <distribution>" ("Debian 13.7" on a Raspberry Pi,
# "Linux" elsewhere) -- on the SECOND line, edge -h starts with
# an empty one. Never `| grep -q` at the end of a pipe under pipefail (SIGPIPE
# turns a match into a failure). Running the file is also what tells whether a
# bundled copy works here at all (its glibc, its architecture).
banner()       { [[ -x "$1" ]] || return 0; "$1" -h 2>&1 | head -n3 | tr '\n' ' ' || true; }
is_tag()       { case "$(banner "$1")" in *"n2n v.$N2N_TAG "*) return 0 ;; esac; return 1; }
has_resolver() { grep -a pthread_create "$1" >/dev/null 2>&1; }
good()         { is_tag "$1" && has_resolver "$1"; }

# A new file renamed over the old one: an edge that is running keeps its own
# (install(1) would fail on it with "Text file busy"), the next start takes this.
install_bundled() {
  install -d -m 0755 "$PREFIX/sbin"
  install -m 0755 "$BUNDLED" "$PREFIX/sbin/.edge.wifilt-new"
  mv -f "$PREFIX/sbin/.edge.wifilt-new" "$EDGE"
  good "$EDGE"
}

locked() { [[ "$(findmnt -n -o FSTYPE / 2>/dev/null || true)" == "overlay" ]]; }

if [[ $MODE != force ]] && good "$EDGE"; then
  say "done" "n2n $N2N_TAG is already installed in $PREFIX/sbin"
  exit 0
fi

if [[ $MODE == bundled ]]; then
  if [[ -e "$EDGE" ]] && ! is_tag "$EDGE"; then
    say "done" "$EDGE is another n2n ($(banner "$EDGE" | sed 's/^ *//; s/ *$//')) -- left alone"
    exit 0
  fi
  if ! good "$BUNDLED"; then
    say "done" "no n2n $N2N_TAG for this computer in this package -- SETUP -> Remote access -> INSTALL n2n builds it"
    exit 0
  fi
  if locked; then
    say "done" "the root filesystem is locked (fslock) -- n2n not installed"
    exit 0
  fi
  install_bundled || die "$EDGE does not work after installing the bundled n2n $N2N_TAG"
  say "done" "n2n $N2N_TAG installed in $PREFIX/sbin (the copy built for this release)"
  exit 0
fi

if [[ -z "${WIFILT_N2N_SKIP_ROOT:-}" && $EUID -ne 0 ]]; then
  CODE=2 die "needs root (apt-get and make install)"
fi

# A locked Raspberry Pi (fslock) keeps / in RAM: whatever gets installed now
# would be gone after the next reboot.
if locked; then
  CODE=3 die "the root filesystem is locked (fslock) -- unlock it first"
fi

# The copy built for this release first: seconds instead of minutes, and no
# compiler on the station. Not with --force, and not when it does not run here.
if [[ $MODE == auto ]] && good "$BUNDLED"; then
  say install "installing the n2n $N2N_TAG built for this release of WIFILT"
  if install_bundled; then
    say "done" "n2n $N2N_TAG installed in $PREFIX/sbin"
    exit 0
  fi
  echo "the bundled n2n does not work here -- building from source" >&2
fi

say deps "installing the build tools"
if [[ -z "${WIFILT_N2N_SKIP_APT:-}" ]]; then
  # NEEDRESTART_MODE=l: list, never restart. This runs from SETUP too (the root
  # helper), and needrestart's automatic mode (Ubuntu's default) would restart
  # wifilt -- the very service that asked for the install -- mid-request.
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
  apt-get update -qq || echo "apt-get update failed, trying the cached package lists" >&2
  apt-get install -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
    build-essential autoconf automake libtool git
fi

say clone "downloading n2n $N2N_TAG"
rm -rf "$SRC"
# A tag checkout is a detached HEAD; git explains that at length even with
# --quiet, which only clutters the helper's log in SETUP.
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$N2N_TAG" "$REPO" "$SRC"

say verify "checking the source"
got="$(git -C "$SRC" rev-parse HEAD)"
[[ "$got" == "$N2N_COMMIT" ]] || CODE=4 die "tag $N2N_TAG of $REPO is $got, expected $N2N_COMMIT -- not building it"

say build "compiling (a minute or two on a Raspberry Pi)"
( cd "$SRC" && ./autogen.sh && ./configure --enable-pthread && make -j"$(nproc 2>/dev/null || echo 2)" )

say install "installing into $PREFIX/sbin"
make -C "$SRC" PREFIX="$PREFIX" install

is_tag "$EDGE" || CODE=5 die "$EDGE does not report n2n $N2N_TAG after installing"
has_resolver "$EDGE" || CODE=5 die "$EDGE was built without the resolver thread"
rm -rf "$SRC"
say "done" "n2n $N2N_TAG installed in $PREFIX/sbin"
