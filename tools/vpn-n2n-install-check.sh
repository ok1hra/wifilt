#!/usr/bin/env bash
#
# native/vpn/build-n2n.sh -- which n2n ends up in /usr/local/sbin, without root,
# network or compiler: fake edges are shell scripts that print n2n's banner
# (the "pthread_create" comment stands for a build with the resolver thread),
# the prefix is a temporary directory, and the source build is pointed at a
# repository that does not exist, so reaching it shows as "PHASE clone" and a
# failure.
#
#   tools/vpn-n2n-install-check.sh

# shellcheck disable=SC2016  # bash -c with positional arguments, on purpose
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/native/vpn/build-n2n.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
PASS=0 FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL $*"; }
check() { local what="$1"; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }

fake() {   # fake FILE VERSION [resolver]
  mkdir -p "$(dirname "$1")"
  {
    echo '#!/bin/sh'
    [[ "${3:-}" == resolver ]] && echo '# pthread_create'
    echo "if [ \"\$1\" = -h ]; then echo; echo 'Welcome to n2n v.$2 for Linux'; exit 1; fi"
    echo "echo 'fake edge $2'"
  } > "$1"
  chmod 0755 "$1"
}

# run MODE-ARG -- build-n2n.sh against $T/p (prefix) and $T/b/edge (bundled copy)
run() {
  OUT="$(WIFILT_N2N_PREFIX="$T/p" WIFILT_N2N_BUNDLED="$T/b/edge" WIFILT_N2N_SRC="$T/src" \
         WIFILT_N2N_REPO="$T/no-such-repo" WIFILT_N2N_SKIP_ROOT=1 WIFILT_N2N_SKIP_APT=1 \
         "$SCRIPT" "$@" 2>&1)"
  RC=$?
}
reset() { rm -rf "$T/p" "$T/b" "$T/src"; }
installed_is() { cmp -s "$T/p/sbin/edge" "$1"; }
says() { grep -F -- "$1" <<<"$OUT" >/dev/null; }

echo "== --bundled-only (install.sh)"
reset; fake "$T/b/edge" 3.1.1 resolver
run --bundled-only
check "nothing installed: the bundled copy goes in" installed_is "$T/b/edge"
check "... and says so" says "installed in $T/p/sbin (the copy built for this release)"
check "... exit 0" test "$RC" -eq 0
check "... no temporary file left" test ! -e "$T/p/sbin/.edge.wifilt-new"

reset; fake "$T/b/edge" 3.1.1 resolver; fake "$T/p/sbin/edge" 3.1.1 resolver
echo '# the operator s own good build' >> "$T/p/sbin/edge"; cp "$T/p/sbin/edge" "$T/own"
run --bundled-only
check "a good 3.1.1 stays" installed_is "$T/own"
check "... already installed" says "already installed"

reset; fake "$T/b/edge" 3.1.1 resolver; fake "$T/p/sbin/edge" 3.1.1
ino_before="$(stat -c %i "$T/p/sbin/edge")"
run --bundled-only
check "a 3.1.1 without the resolver thread is replaced" installed_is "$T/b/edge"
check "... by a new file, not written into (a running edge keeps its own)" \
  test "$(stat -c %i "$T/p/sbin/edge")" != "$ino_before"

reset; fake "$T/b/edge" 3.1.1 resolver; fake "$T/p/sbin/edge" 3.2.0 resolver; cp "$T/p/sbin/edge" "$T/other"
run --bundled-only
check "another version is left alone" installed_is "$T/other"
check "... and named" says "is another n2n (Welcome to n2n v.3.2.0 for Linux) -- left alone"
check "... exit 0" test "$RC" -eq 0

reset
run --bundled-only
check "no bundled copy: nothing installed" test ! -e "$T/p/sbin/edge"
check "... points to INSTALL n2n" says "INSTALL n2n builds it"
check "... exit 0, and no build" bash -c '[[ $0 -eq 0 ]] && ! grep -q "PHASE clone" <<<"$1"' "$RC" "$OUT"

reset; mkdir -p "$T/b"; printf '#!/bin/sh\nexit 127\n# pthread_create\n' > "$T/b/edge"; chmod 755 "$T/b/edge"
run --bundled-only
check "a bundled copy that does not run here is not installed" test ! -e "$T/p/sbin/edge"

reset; fake "$T/b/edge" 3.1.1
run --bundled-only
check "a bundled copy without the resolver thread is not installed" test ! -e "$T/p/sbin/edge"

echo "== default (INSTALL n2n, pi-setup)"
reset; fake "$T/b/edge" 3.1.1 resolver
run
check "the bundled copy, no build" installed_is "$T/b/edge"
check "... no clone" bash -c '! grep -q "PHASE clone" <<<"$0"' "$OUT"
check "... exit 0" test "$RC" -eq 0

reset; fake "$T/b/edge" 3.1.1 resolver; fake "$T/p/sbin/edge" 3.2.0 resolver
run
check "asked for explicitly, another version gives way" installed_is "$T/b/edge"

reset; fake "$T/b/edge" 3.1.1 resolver; fake "$T/p/sbin/edge" 3.1.1 resolver; cp "$T/p/sbin/edge" "$T/own"
run
check "a good one installed: nothing to do" installed_is "$T/own"

reset; mkdir -p "$T/b"; printf '#!/bin/sh\nexit 127\n' > "$T/b/edge"; chmod 755 "$T/b/edge"
run
check "bundled copy unusable: falls back to the source build" says "PHASE clone"
check "... which fails here (no repository): non-zero" test "$RC" -ne 0

echo "== --force"
reset; fake "$T/b/edge" 3.1.1 resolver; fake "$T/p/sbin/edge" 3.1.1 resolver
run --force
check "builds from source even with a good one and a bundled copy" says "PHASE clone"

echo "== where the bundled copy is looked for"
reset; mkdir -p "$T/pkg/n2n"; cp "$SCRIPT" "$T/pkg/build-n2n.sh"; fake "$T/pkg/n2n/edge" 3.1.1 resolver
OUT="$(WIFILT_N2N_PREFIX="$T/p" WIFILT_N2N_SKIP_ROOT=1 WIFILT_N2N_SKIP_APT=1 \
       WIFILT_N2N_REPO="$T/no-such-repo" "$T/pkg/build-n2n.sh" --bundled-only 2>&1)"
check "n2n/edge next to the script (archive layout, \$PREFIX/n2n installed)" installed_is "$T/pkg/n2n/edge"
mkdir -p "$T/opt/n2n"; cp "$SCRIPT" "$T/opt/wifilt-vpn-build"; fake "$T/opt/n2n/edge" 3.1.1 resolver
ln -s "$T/opt/wifilt-vpn-build" "$T/link-to-build"; rm -rf "$T/p"
OUT="$(WIFILT_N2N_PREFIX="$T/p" WIFILT_N2N_SKIP_ROOT=1 WIFILT_N2N_SKIP_APT=1 \
       WIFILT_N2N_REPO="$T/no-such-repo" "$T/link-to-build" --bundled-only 2>&1)"
check "... also when called through a symlink" installed_is "$T/opt/n2n/edge"

echo "== usage"
run --bogus
check "an unknown option is refused" test "$RC" -eq 2

echo
echo "$PASS checks passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
