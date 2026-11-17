# shellcheck shell=bash
#
# pi-setup step 1: system packages and group membership.

BASE_PKGS=(curl ca-certificates tar rsync libcap2-bin python3 nftables dnsmasq-base iw ethtool psmisc)
# for working on the Pi over SSH; WIFILT itself does not need them
ADMIN_PKGS=(tmux htop mc vim)

missing_pkgs() {
  local p
  for p in "$@"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep 'install ok installed' >/dev/null || echo "$p"
  done
}

ask_packages() {
  header "System packages"
  local miss
  miss=$(missing_pkgs "${BASE_PKGS[@]}" "${ADMIN_PKGS[@]}" | tr '\n' ' ')
  if [[ -n $miss ]]; then current "missing: $miss"; else current "all needed packages present"; fi
  plan_line "install what is missing (also ${ADMIN_PKGS[*]}), add $RUN_USER to the groups audio and dialout"
  plan_line "tmux status bar with the fslock state, Wi-Fi signal or AP and eth/Wi-Fi traffic (/etc/tmux.conf)"
  DO_PACKAGES=1          # not optional: every later step relies on these tools
  local def=n
  [[ $MODE == fresh ]] && def=y
  ANS_UPGRADE=0
  ask_yn "Also upgrade the whole system now (apt full-upgrade)?" "$def" && ANS_UPGRADE=1
  return 0
}

run_packages() {
  local miss kernels_before
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
  local apt_opts=(-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
  info "apt-get update"
  apt-get update -qq
  if [[ ${ANS_UPGRADE:-0} == 1 ]]; then
    kernels_before=$(ls /lib/modules 2>/dev/null | tr '\n' ' ')
    info "apt-get full-upgrade (can take a while)"
    apt-get "${apt_opts[@]}" full-upgrade
    if [[ -e /var/run/reboot-required || $(ls /lib/modules 2>/dev/null | tr '\n' ' ') != "$kernels_before" ]]; then
      need_reboot "new kernel / system libraries from the upgrade"
    fi
  fi
  mapfile -t miss < <(missing_pkgs "${BASE_PKGS[@]}" "${ADMIN_PKGS[@]}")
  if [[ ${#miss[@]} -gt 0 ]]; then
    info "installing: ${miss[*]}"
    apt-get "${apt_opts[@]}" install "${miss[@]}"
  else
    ok "all needed packages present"
  fi

  local g add=()
  for g in audio dialout; do
    id -nG "$RUN_USER" | tr ' ' '\n' | grep -x -- "$g" >/dev/null || add+=("$g")
  done
  if [[ ${#add[@]} -gt 0 ]]; then
    usermod -aG "$(IFS=,; echo "${add[*]}")" "$RUN_USER"
    ok "$RUN_USER added to: ${add[*]}"
    note "$RUN_USER is now in the groups ${add[*]} -- valid from the next login (the services do not need it)"
  else
    ok "$RUN_USER is in audio and dialout"
  fi

  # tmux status bar: fslock state, Wi-Fi signal or AP, eth/Wi-Fi traffic.
  # A block in /etc/tmux.conf, so a user's own ~/.tmux.conf still wins.
  put_file "$FILES/wifilt-tmux-status" /usr/local/bin/wifilt-tmux-status 755 || true
  replace_block /etc/tmux.conf "wifilt-pi-setup tmux" < "$FILES/tmux.conf" || true

  # the bootstrap stays installed: future updates are just "wifilt-pi-setup"
  if [[ -f $PI_DIR/pi-bootstrap.sh ]]; then
    put_file "$PI_DIR/pi-bootstrap.sh" /usr/local/sbin/wifilt-pi-setup 755 || true
  fi
}

commit_packages() { :; }
