# shellcheck shell=bash
#
# pi-setup: updating a locked system (fslock).
#
# A locked root is an overlay in RAM: whatever gets installed there is gone at
# the next reboot, and unlocking only takes effect after a reboot. So:
#
#   1. all questions are asked while still locked;
#   2. the package, the answers and a one-shot service are written to the real
#      root underneath the overlay ($ROOT_RO, remounted rw for a moment -- the
#      same way fslock itself edits the real fstab);
#   3. fslock unlock, reboot;
#   4. wifilt-pi-resume.service runs pi-setup --resume with the saved answers;
#   5. on success, a timer locks the system again after the chosen delay, so it
#      ends in the state it started in. On failure it stays unlocked for repair.

RESUME_UNIT=wifilt-pi-resume.service
RELOCK_UNIT=wifilt-pi-relock

locked_handoff() {
  local lower=$ROOT_RO dst rel
  findmnt "$lower" >/dev/null 2>&1 || die "$lower is not mounted -- cannot prepare the update"
  [[ -x $PKG/wifilt || ${DO_WIFILT:-0} == 0 ]] || die "package incomplete"
  rel=${SELF#"$PKG"/}

  info "preparing the update on the real root file system"
  mount -o remount,rw "$lower" || die "cannot remount $lower for writing"
  dst=$lower$STATE_DIR
  install -d -m 700 "$dst"
  rm -rf "$dst/pkg"
  cp -a "$PKG/." "$dst/pkg/"
  {
    save_answers
    printf 'RUN_USER=%q\nFORCE=%q\nONLY=%q\n' "$RUN_USER" "$FORCE" "$ONLY"
  } > "$dst/resume.conf"
  chmod 600 "$dst/resume.conf"
  rm -f "$dst/resume-failed"

  cat > "$lower/etc/systemd/system/$RESUME_UNIT" <<EOF
[Unit]
Description=WIFILT pi-setup: finish an update started on a locked system
After=network-online.target NetworkManager.service data.mount
Wants=network-online.target
ConditionPathExists=$STATE_DIR/resume.conf

[Service]
Type=simple
ExecStart=/bin/bash $STATE_DIR/pkg/$rel --resume
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
EOF
  install -d "$lower/etc/systemd/system/multi-user.target.wants"
  ln -sfn "../$RESUME_UNIT" "$lower/etc/systemd/system/multi-user.target.wants/$RESUME_UNIT"
  sync
  mount -o remount,ro "$lower" || warn "cannot remount $lower read-only again (harmless, it reboots now)"

  info "unlocking (fslock unlock)"
  /usr/local/sbin/fslock unlock -y --no-reboot
  echo
  say "The system reboots now. The update continues by itself after the reboot;"
  say "follow it with:  journalctl -fu $RESUME_UNIT"
  say "or later read:   $LOG_FILE"
  sync
  systemctl reboot
  exit 0
}

wait_for_network() {
  local i
  for ((i = 0; i < 60; i++)); do
    curl -fsS -m 5 -o /dev/null https://github.com 2>/dev/null && return 0
    sleep 2
  done
  warn "no internet connection after 2 minutes, continuing anyway"
}

resume_main() {
  local a=$STATE_DIR/resume.conf rc=0
  [[ -r $a ]] || die "nothing to resume ($a missing)"
  # never a boot loop: disarm first
  rm -f "/etc/systemd/system/multi-user.target.wants/$RESUME_UNIT"
  systemctl daemon-reload || true
  # shellcheck disable=SC1090
  . "$a"
  mv -f "$a" "$a.done"

  echo "pi-setup: resuming the update after the unlock reboot"
  if fs_locked_now; then
    echo "$(date -Iseconds) still locked after the reboot -- the unlock did not take effect" > "$STATE_DIR/resume-failed"
    wall "pi-setup: the system is still locked, update not done. See $LOG_FILE" 2>/dev/null || true
    die "still locked after the reboot"
  fi
  load_setup_conf
  # shellcheck disable=SC1090
  . "$a.done"         # answers win over setup.conf (RUN_USER etc.)
  MODE=update LOCKED=0 SSH_IFACE=""
  NO_NM=1; systemctl is-active --quiet NetworkManager && NO_NM=0
  resolve_user
  wait_for_network

  run_all || rc=$?
  summary "$rc"

  if [[ $rc -eq 0 ]]; then
    rm -f "$STATE_DIR/resume-failed"
    if [[ ${ANS_RELOCK:-0} == 1 ]]; then
      schedule_relock "${ANS_RELOCK_MIN:-10}"
    else
      wall "pi-setup: update finished. The system stays UNLOCKED (as chosen); lock it with: sudo fslock lock" 2>/dev/null || true
    fi
  else
    echo "$(date -Iseconds) update failed, see $LOG_FILE" > "$STATE_DIR/resume-failed"
    wall "pi-setup: the update FAILED, the system stays unlocked. See $LOG_FILE" 2>/dev/null || true
  fi
  rm -rf "$STATE_DIR/pkg" "/etc/systemd/system/$RESUME_UNIT" "$a.done"
  systemctl daemon-reload || true
  return "$rc"
}

schedule_relock() {
  local min=$1
  systemctl stop "$RELOCK_UNIT.timer" 2>/dev/null || true
  systemctl reset-failed "$RELOCK_UNIT.service" 2>/dev/null || true
  systemd-run --quiet --unit="$RELOCK_UNIT" --on-active="${min}min" \
    --timer-property=AccuracySec=5s /usr/local/sbin/fslock lock -y
  echo $(( $(date +%s) + min * 60 )) > "$RUN_DIR/relock-at"
  wall "pi-setup: update finished. The system LOCKS ITSELF in $min min and reboots.
  Cancel:      wifilt-pi-setup --keep-unlocked
  Lock now:    sudo fslock lock" 2>/dev/null || true
  info "automatic lock in $min min (cancel: wifilt-pi-setup --keep-unlocked)"
}

cancel_relock() {
  if systemctl is-active --quiet "$RELOCK_UNIT.timer"; then
    systemctl stop "$RELOCK_UNIT.timer"
    rm -f "$RUN_DIR/relock-at"
    echo "Automatic lock cancelled. The system stays unlocked; lock it later with: sudo fslock lock"
  else
    rm -f "$RUN_DIR/relock-at"
    echo "No automatic lock is pending."
  fi
}
