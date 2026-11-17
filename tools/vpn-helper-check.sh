#!/usr/bin/env bash
#
# Regression test for the remote access root helper (native/vpn/wifilt-vpn.sh)
# without root: systemctl, ping, the n2n edge and the n2n build are shims, the
# helper's paths come from its WIFILT_VPN_* overrides.
#
#   tools/vpn-helper-check.sh
#
# What it holds the helper to: it starts the edge only from a valid, enabled,
# paired vpn.json and an n2n 3 edge; the key never reaches argv; a request can
# carry only an action and an IPv4 address; a change made from inside the VPN
# is undone when the requester does not come back; the build's progress and
# failure reach status.json.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$HERE/native/vpn/wifilt-vpn.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/vpn-helper-check.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0 FAIL=0
ok()  { echo "  ok   $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $*"; FAIL=$((FAIL + 1)); }
check() { local what="$1"; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }
has() { grep -F -- "$2" "$1" >/dev/null 2>&1; }

mkdir -p "$WORK/bin" "$WORK/cfg" "$WORK/state/req"

# --- shims ---------------------------------------------------------------------
cat > "$WORK/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$WORK/systemctl.log"
case "\$1" in
  is-active) [[ -f "$WORK/active" ]] ;;
  *) exit 0 ;;
esac
EOF
cat > "$WORK/bin/ping" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$WORK/ping.log"
[[ -f "$WORK/ping-ok" ]]
EOF
cat > "$WORK/edge3" <<EOF
#!/usr/bin/env bash
# Like the real one: an empty line first, the banner second. "pthread_create"
# marks a build with the resolver thread (build-n2n.sh --enable-pthread).
: pthread_create
if [[ "\$1" == "-h" ]]; then echo; echo "Welcome to n2n v.3.1.1 for Linux"; exit 1; fi
printf '%s\n' "\$@" > "$WORK/edge.argv"
echo "\${N2N_KEY:-}" > "$WORK/edge.key"
EOF
cat > "$WORK/edge1" <<EOF
#!/usr/bin/env bash
echo; echo "Welcome to n2n v.1.3.2 for unknown"
EOF
cat > "$WORK/build-ok" <<EOF
#!/usr/bin/env bash
echo "PHASE deps installing the build tools"
echo "some compiler noise"
echo "PHASE done n2n 3.1.1 installed"
EOF
cat > "$WORK/build-fail" <<EOF
#!/usr/bin/env bash
echo "PHASE verify checking the source"
echo "ERROR: tag moved" >&2
exit 4
EOF
chmod +x "$WORK"/bin/* "$WORK"/edge3 "$WORK"/edge1 "$WORK"/build-ok "$WORK"/build-fail

printf 'PREFIX=/opt/wifilt\nRUN_USER=%s\nCONF_DIR=%s\n' "$(id -un | tr 'A-Z' 'a-z')" "$WORK/cfg" > "$WORK/vpn.conf"
echo "0123456789abcdef0123456789abcdef" > "$WORK/machine-id"

export PATH="$WORK/bin:$PATH"
export WIFILT_VPN_CONF="$WORK/vpn.conf" WIFILT_VPN_STATE="$WORK/state"
export WIFILT_VPN_EDGE="$WORK/edge3" WIFILT_VPN_BUILD="$WORK/build-ok"
export WIFILT_VPN_MACHINE_ID="$WORK/machine-id" WIFILT_VPN_AS_SELF=1 WIFILT_VPN_WATCH_SECONDS=4

COMM='wl-abcdefgh' KEY='ABCDEFGHJKMNPQRSTVWX'
settings() {   # enabled community key desc supernode
  printf '{"enabled":%s,"code":"x","community":"%s","key":"%s","desc":"%s","supernode":"%s"}\n' \
    "$1" "$2" "$3" "$4" "$5" > "$WORK/cfg/vpn.json"
}
request() {    # action watch [id]
  printf '{"action":"%s","id":"%s","watch":"%s"}\n' "$1" "${3:-abc123}" "$2" > "$WORK/state/req/apply.json"
  "$HELPER" --from-request
}
status_has() { has "$WORK/state/status.json" "$1"; }
reset_logs() { rm -f "$WORK/systemctl.log" "$WORK/ping.log" "$WORK/edge.argv" "$WORK/edge.key"; }

echo "== condition"
rm -f "$WORK/cfg/vpn.json"
"$HELPER" condition; check "no vpn.json -> skip" test $? -eq 1
settings false "$COMM" "$KEY" OK1HRA-RPI remoteqth.com:82
"$HELPER" condition; check "switched off -> skip" test $? -eq 1
settings true "$COMM" "$KEY" OK1HRA-RPI remoteqth.com:82
"$HELPER" condition; check "paired and on -> start" test $? -eq 0
settings true 'wl-abc;rm -rf' "$KEY" OK1HRA-RPI remoteqth.com:82
"$HELPER" condition; check "community with shell characters -> skip" test $? -eq 1
settings true "$COMM" "$KEY" OK1HRA-RPI 'evil host:82'
"$HELPER" condition; check "bad supernode -> skip" test $? -eq 1
settings true "$COMM" "short" OK1HRA-RPI remoteqth.com:82
"$HELPER" condition; check "bad key -> skip" test $? -eq 1
settings true "$COMM" "$KEY" OK1HRA-RPI remoteqth.com:82
WIFILT_VPN_EDGE="$WORK/missing" "$HELPER" condition
check "no edge binary -> skip" test $? -eq 1
check "  ... and says why (edge.json)" has "$WORK/state/edge.json" "n2n is not installed"
WIFILT_VPN_EDGE="$WORK/edge1" "$HELPER" condition
check "n2n v1 edge -> skip" test $? -eq 1
check "  ... and says why" has "$WORK/state/edge.json" "is not n2n 3.x"
"$HELPER" condition
check "a good start clears the old reason" test ! -f "$WORK/state/edge.json"
mv "$WORK/cfg/vpn.json" "$WORK/cfg/real.json"; ln -s "$WORK/cfg/real.json" "$WORK/cfg/vpn.json"
"$HELPER" condition; check "vpn.json as a symlink -> skip" test $? -eq 1
rm -f "$WORK/cfg/vpn.json"; mv "$WORK/cfg/real.json" "$WORK/cfg/vpn.json"

echo "== run"
reset_logs
"$HELPER" run
check "edge started on wlvpn0" has "$WORK/edge.argv" "wlvpn0"
check "with the community" has "$WORK/edge.argv" "$COMM"
check "with the supernode" has "$WORK/edge.argv" "remoteqth.com:82"
check "with ChaCha20 (-A4)" has "$WORK/edge.argv" "-A4"
check "with the device name" has "$WORK/edge.argv" "OK1HRA-RPI"
check "in the foreground (-f)" has "$WORK/edge.argv" "-f"
check "key in N2N_KEY" has "$WORK/edge.key" "$KEY"
check "key NOT in argv" bash -c "! grep -F '$KEY' '$WORK/edge.argv' >/dev/null"
mac="$(grep -E '^02(:[0-9a-f]{2}){5}$' "$WORK/edge.argv")"
check "locally administered MAC from machine-id ($mac)" test -n "$mac"
reset_logs; "$HELPER" run
check "same MAC on the next start" has "$WORK/edge.argv" "$mac"
settings true "$COMM" "$KEY" 'bad name!' remoteqth.com:82
reset_logs; "$HELPER" run
check "an unusable device name falls back to WIFILT" has "$WORK/edge.argv" "WIFILT"

cp "$WORK/edge3" "$WORK/edge3-nothread"; sed -i '/pthread_create/d' "$WORK/edge3-nothread"
settings true "$COMM" "$KEY" OK1HRA-RPI localhost:82
reset_logs; WIFILT_VPN_EDGE="$WORK/edge3-nothread" "$HELPER" run 2>/dev/null
check "an edge without the resolver thread gets the address, not the name" has "$WORK/edge.argv" "127.0.0.1:82"
# Absolute (trailing dot): a search domain with a wildcard record would
# otherwise make even an .invalid name resolve.
settings true "$COMM" "$KEY" OK1HRA-RPI no-such-host.invalid.:82
reset_logs; WIFILT_VPN_EDGE="$WORK/edge3-nothread" "$HELPER" run 2>/dev/null
check "  ... and is not started while the name does not resolve" test $? -eq 1 -a ! -f "$WORK/edge.argv"
settings true "$COMM" "$KEY" OK1HRA-RPI no-such-host.invalid:82
reset_logs; "$HELPER" run
check "a normal edge gets the name as it is" has "$WORK/edge.argv" "no-such-host.invalid:82"

echo "== apply"
settings true "$COMM" "$KEY" OK1HRA-RPI remoteqth.com:82
reset_logs; touch "$WORK/active"
request apply ""
check "restart of wifilt-vpn.service" has "$WORK/systemctl.log" "restart wifilt-vpn.service"
check "status done, VPN running" status_has '"state":"done"'
check "request consumed" test ! -f "$WORK/state/req/apply.json"

settings false "$COMM" "$KEY" OK1HRA-RPI remoteqth.com:82
reset_logs
request apply ""
check "switched off -> stop" has "$WORK/systemctl.log" "stop wifilt-vpn.service"
check "status says VPN off" status_has 'VPN off'

echo "== a change from inside the VPN"
settings true "$COMM" "$KEY" OK1HRA-RPI remoteqth.com:82
cp "$WORK/cfg/vpn.json" "$WORK/cfg/vpn.prev.json"
settings true "$COMM" "$KEY" OK1HRA-RPI broken.example:82
reset_logs; rm -f "$WORK/ping-ok"
request apply "10.128.1.7"
check "pinged the requester through wlvpn0" has "$WORK/ping.log" "-I wlvpn0 10.128.1.7"
check "status reverted" status_has '"state":"reverted"'
check "previous settings back in vpn.json" has "$WORK/cfg/vpn.json" "remoteqth.com:82"
check "edge restarted with them" test "$(grep -c 'restart wifilt-vpn.service' "$WORK/systemctl.log")" -ge 2

settings true "$COMM" "$KEY" OK1HRA-RPI other.example:82
reset_logs; touch "$WORK/ping-ok"
request apply "10.128.1.7"
check "requester answers -> kept" status_has '"state":"done"'
check "new settings stay" has "$WORK/cfg/vpn.json" "other.example:82"

echo "== request hygiene"
reset_logs; rm -f "$WORK/ping-ok"
request apply "999.1.1.1"
check "an impossible address is not watched" test ! -f "$WORK/ping.log"
request 'rm -rf /' ""
check "an action that is not a word does nothing" status_has 'unknown action'
printf '{"action":"apply","id":"$(reboot)","watch":""}' > "$WORK/state/req/apply.json"
"$HELPER" --from-request
check "an id with shell characters is dropped" status_has '"id":""'

echo "== edge does not come up"
settings true "$COMM" "$KEY" OK1HRA-RPI remoteqth.com:82
rm -f "$WORK/active"
printf '{"error":"n2n is not installed (/usr/local/sbin/edge)","ts":1}\n' > "$WORK/state/edge.json"
reset_logs
request apply ""
check "status failed" status_has '"state":"failed"'
check "with the reason from edge.json" status_has 'n2n is not installed'
touch "$WORK/active"; rm -f "$WORK/state/edge.json"

echo "== install"
reset_logs
request install ""
check "build phases reach status.json" status_has '"state":"done"'
check "  ... with the build's own words in the log" status_has 'some compiler noise'
check "  ... and the enabled edge restarted" has "$WORK/systemctl.log" "restart wifilt-vpn.service"
WIFILT_VPN_BUILD="$WORK/build-fail" request install ""
check "a failed build says failed" status_has '"state":"failed"'
check "  ... with its exit status" status_has 'exit 4'
check "  ... and its error in the log" status_has 'tag moved'

echo
echo "$PASS checks passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
