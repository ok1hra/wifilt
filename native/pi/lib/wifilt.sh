# shellcheck shell=bash
#
# pi-setup step 2: WIFILT + local-trx from this package (via its install.sh).

ask_wifilt() {
  header "WIFILT + local-trx"
  WIFILT_ENABLE=${WIFILT_ENABLE:-1}
  if [[ ! -x $PKG/wifilt || ! -x $PKG/install.sh ]]; then
    current "this copy of pi-setup has no WIFILT programs next to it (source tree?)"
    DO_WIFILT=0
    return 0
  fi
  local pv iv ph ih
  pv=$(pkg_version); iv=$(installed_version)
  ph=$(tree_hash "$PKG"); ih=$(tree_hash "$PREFIX")
  local ltx="without local-trx"
  [[ -x $PKG/local-trx ]] && ltx="with local-trx"
  current "installed: $iv, this package: $pv ($ltx)"
  if [[ $ph == "$ih" && $FORCE -eq 0 ]]; then
    say "  The installed programs are identical to this package."
    DO_WIFILT=0
    ask_yn "Reinstall anyway?" n && DO_WIFILT=1
  else
    plan_line "install to $PREFIX, systemd services wifilt$([[ -x $PKG/local-trx ]] && echo ' and local-trx') running as $RUN_USER"
    DO_WIFILT=0
    ask_yn "$([[ $iv == none ]] && echo Install || echo Update) WIFILT?" y && DO_WIFILT=1
  fi
  if [[ $DO_WIFILT == 1 ]]; then
    local def=y
    [[ $WIFILT_ENABLE == 0 ]] && def=n
    ANS_WIFILT_ENABLE=0
    ask_yn "Start the services at every boot (headless station)?" "$def" && ANS_WIFILT_ENABLE=1
  fi
  return 0
}

run_wifilt() {
  local svcs=(wifilt) bin libs
  [[ -x $PKG/local-trx ]] && svcs+=(local-trx)

  info "stopping running copies"
  systemctl stop wifilt local-trx 2>/dev/null || true
  # a copy started by hand (start-wifilt.sh) would hold port 80 and the serial ports
  [[ -x $PREFIX/start-wifilt.sh ]] && as_user "$PREFIX/start-wifilt.sh" stop >/dev/null 2>&1 || true

  info "installing to $PREFIX"
  # install.sh takes the service user from SUDO_USER; its own hints about
  # enabling are for a desktop and go to the log only
  SUDO_USER=$RUN_USER "$PKG/install.sh" --prefix "$PREFIX" >> "$LOG_FILE" 2>&1
  [[ -f $PKG/VERSION ]] && install -m 644 "$PKG/VERSION" "$PREFIX/VERSION"
  if [[ -f $PKG/BUILD ]]; then install -m 644 "$PKG/BUILD" "$PREFIX/BUILD"; else rm -f "$PREFIX/BUILD"; fi
  getcap "$PREFIX/wifilt" | grep cap_net_bind_service >/dev/null \
    || die "setcap failed: WIFILT would fall back to port 8080"
  ok "installed $(installed_version)"

  systemctl daemon-reload
  if [[ ${ANS_WIFILT_ENABLE:-1} == 1 ]]; then
    systemctl enable "${svcs[@]}" >/dev/null 2>&1
    systemctl restart "${svcs[@]}"
    ok "services ${svcs[*]} enabled and running"
  else
    systemctl disable "${svcs[@]}" >/dev/null 2>&1 || true
    ok "services installed, not enabled (start: sudo systemctl start ${svcs[*]})"
  fi

  for bin in wifilt local-trx; do
    [[ -x $PREFIX/$bin ]] || continue
    if libs=$(ldd "$PREFIX/$bin" 2>/dev/null | grep 'not found'); then
      warn "$bin is missing libraries:"; echo "$libs"
    fi
  done

  if [[ $MODE == fresh ]]; then
    note "first setup of local-trx: http://$(hostname).local:8765/ -- its 'Listen IP' must be a number (127.0.0.1 when WIFILT runs on this Pi), a host name makes it fail after 'Save and restart'"
    note "in WIFILT SETUP the ICOM-LAN address of the radio is then 127.0.0.1"
    note "every TrxNet device needs its own name -- pick one for WIFILT that nothing else on the network uses"
  fi
}

commit_wifilt() { WIFILT_ENABLE=${ANS_WIFILT_ENABLE:-1}; }
