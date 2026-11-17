# shellcheck shell=bash
#
# pi-setup step 5: remote access over the internet (SETUP -> Remote access).
#
# Installs n2n 3.1.1 (wifilt-vpn-build, i.e. native/vpn/build-n2n.sh: the copy
# built for this release when it runs here -- the wifilt step has usually put it
# in place already -- otherwise from source: pinned tag, checked commit,
# --enable-pthread, /usr/local) and pairs this
# station with the VPN through the supernode on remoteqth.com: a new network
# (this is the first device) or one joined with the code from another device.
# The edge itself is wifilt-vpn.service, installed and enabled by install.sh in
# the wifilt step; this step only gives it n2n and the settings. Runs before
# fslock, so n2n lands on the real root file system and vpn.json in the user's
# config directory, which fslock keeps on the data card.
#
# Unattended: PI_SETUP_VPN_CODE=<code> joins that network without asking (the
# bootstrap passes it through sudo).

vpn_json() { echo "$RUN_HOME/.config/wifilt/vpn.json"; }

vpn_paired_desc() {   # the device name of an existing pairing, empty when none
  local f
  f=$(vpn_json)
  [[ -r $f ]] || return 0
  grep -E '"code":"WL-' "$f" >/dev/null 2>&1 || return 0
  sed -n 's/.*"desc":"\([^"]*\)".*/\1/p' "$f" | head -n1
}

# Format only (29 symbols of Crockford base32 after normalising); the check
# symbol itself is verified by `wifilt --vpn-pair`, which refuses a typo.
v_vpn_code() {
  local c=${1^^}
  c=${c//[ -]/}
  [[ $c == WL* && ${#c} -eq 31 ]] && c=${c:2}
  [[ ${#c} -eq 29 && $c =~ ^[0-9A-HJKMNP-TV-Z]+$ ]] && return 0
  echo "A pairing code looks like WL-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-X."
  return 1
}

ask_vpn() {
  header "Remote access (VPN)"
  local desc edge_banner=""
  desc=$(vpn_paired_desc)
  [[ -x /usr/local/sbin/edge ]] && edge_banner=$(/usr/local/sbin/edge -h 2>&1 | head -n3 | tr '\n' ' ' || true)
  if [[ -n $desc ]]; then
    current "paired as $desc; n2n: ${edge_banner:+installed}${edge_banner:-not installed}"
  else
    current "not paired; n2n: ${edge_banner:+installed}${edge_banner:-not installed}"
  fi
  # n2n itself arrives with WIFILT (install.sh, step 2) whatever is answered here
  plan_line "pair this station with the VPN via remoteqth.com (n2n comes with WIFILT and runs only once paired)"
  DO_VPN=0
  ANS_VPN_MODE="" ANS_VPN_CODE=""

  if [[ -n ${PI_SETUP_VPN_CODE:-} ]]; then
    v_vpn_code "$PI_SETUP_VPN_CODE" >/dev/null || die "PI_SETUP_VPN_CODE is not a pairing code"
    say "  Joining the network of PI_SETUP_VPN_CODE."
    ANS_VPN_MODE=join ANS_VPN_CODE=$PI_SETUP_VPN_CODE DO_VPN=1
    return 0
  fi

  local def=n
  [[ ${HAVE_VPN:-0} == 1 || -n $desc ]] && def=y
  ask_yn "Remote access over the internet (n2n VPN via remoteqth.com)?" "$def" || return 0
  if [[ -n $desc ]] && ask_yn "Keep the current pairing ($desc)?" y; then
    ANS_VPN_MODE=keep
  else
    say "  1) create a new network -- this is the first device"
    say "  2) join a network with the pairing code from another device"
    local r
    while :; do
      ask_str r "  Choice" 1
      case $r in 1) ANS_VPN_MODE="new"; break ;; 2) ANS_VPN_MODE="join"; break ;; *) say "  1 or 2." ;; esac
    done
    if [[ $ANS_VPN_MODE == join ]]; then
      interactive || die "joining a VPN needs the code: run interactively or set PI_SETUP_VPN_CODE"
      ask_str ANS_VPN_CODE "  Pairing code" "" v_vpn_code
    fi
  fi
  DO_VPN=1
}

run_vpn() {
  local build=$PREFIX/wifilt-vpn-build
  [[ -x $build ]] || build=$PKG/build-n2n.sh
  [[ -x $build ]] || die "the n2n build script is missing (wifilt step not run?)"
  info "n2n 3.1.1 (a build from source takes a few minutes)"
  "$build"

  local code=""
  case $ANS_VPN_MODE in
    new)
      code=$(as_user "$PREFIX/wifilt" --vpn-pair new --vpn-enable) || die "pairing failed"
      ;;
    join)
      as_user "$PREFIX/wifilt" --vpn-pair "$ANS_VPN_CODE" --vpn-enable >/dev/null \
        || die "the pairing code was refused (a typo? its last symbol is a check)"
      ;;
    keep) ;;
  esac

  systemctl enable wifilt-vpn.service >/dev/null 2>&1 || true
  systemctl restart wifilt-vpn.service || true

  local ip="" _
  for _ in $(seq 1 20); do
    ip=$(ip -4 -br addr show wlvpn0 2>/dev/null | awk '{print $3}' | cut -d/ -f1 || true)
    [[ -n $ip ]] && break
    sleep 1
  done
  if [[ -n $ip ]]; then
    info "in the VPN as $ip"
    note "Remote access: this station is $ip in its VPN (SETUP -> Remote access lists the devices)."
  else
    note "Remote access: the VPN is not connected yet -- see SETUP -> Remote access."
  fi

  # A new code goes to the screen only, never into the log: it is the key.
  if [[ -n $code ]]; then
    if (exec </dev/tty) 2>/dev/null; then
      {
        printf '\n%s  Pairing code of the new VPN -- write it down, it is also in SETUP -> Remote access:%s\n' "$C_B" "$C_0"
        printf '\n      %s%s%s\n\n' "$C_B" "$code" "$C_0"
      } > /dev/tty
    fi
    note "Remote access: a new VPN was created; its pairing code is in SETUP -> Remote access."
  fi
}

commit_vpn() { HAVE_VPN=1; }
