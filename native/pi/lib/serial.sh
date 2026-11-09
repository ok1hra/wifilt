# shellcheck shell=bash
#
# pi-setup step 3: fixed names for the USB serial adapters.
#
# /dev/ttyUSB0, 1, 2 swap places with every reboot or replug; local-trx and the
# OI3 flash need names that do not. A udev rule matches each adapter by its USB
# serial number (or, for chips without one, by the USB port it is plugged into)
# and adds a symlink /dev/ttyUSB.<role>.

SERIAL_RULES=/etc/udev/rules.d/99-wifilt-serial.rules
SERIAL_ROLES=(cat cw panel)
declare -A ROLE_TEXT=(
  [cat]="CAT to the transceiver (local-trx)"
  [cw]="Open Interface III (CW/PTT, firmware upload)"
  [panel]="control panel"
)

# serial_devices -> lines "key|tty|description"; key = vid:pid:serial or path:ID_PATH
serial_devices() {
  local link dev props vid pid ser path desc key
  for link in /dev/serial/by-id/*; do
    [[ -e $link ]] || continue
    dev=$(readlink -f "$link")
    props=$(udevadm info -q property -n "$dev" 2>/dev/null) || continue
    vid=$(sed -n 's/^ID_VENDOR_ID=//p' <<<"$props")
    pid=$(sed -n 's/^ID_MODEL_ID=//p' <<<"$props")
    ser=$(sed -n 's/^ID_SERIAL_SHORT=//p' <<<"$props")
    path=$(sed -n 's/^ID_PATH=//p' <<<"$props")
    desc="$(sed -n 's/^ID_VENDOR_FROM_DATABASE=//p' <<<"$props" | head -c 30) $(sed -n 's/^ID_MODEL=//p' <<<"$props")"
    if [[ -n $ser ]]; then key="$vid:$pid:$ser"; desc+=", serial $ser"
    else key="path:$path"; desc+=", no serial number (matched by USB port)"; fi
    printf '%s|%s|%s\n' "$key" "$dev" "$desc"
  done
}

# aliases currently pointing at a tty
aliases_of() {
  local l out=()
  for l in /dev/ttyUSB.*; do
    [[ -L $l && $(readlink -f "$l") == "$1" ]] && out+=("${l#/dev/}")
  done
  echo "${out[*]}"
}

foreign_serial_rules() {
  grep -l 'SYMLINK+="ttyUSB\.' /etc/udev/rules.d/*.rules 2>/dev/null | grep -vx "$SERIAL_RULES" || true
}

ask_serial() {
  header "Serial port aliases"
  local -a devs
  mapfile -t devs < <(serial_devices)
  local foreign
  foreign=$(foreign_serial_rules | tr '\n' ' ')
  DO_SERIAL=0

  if [[ ${#devs[@]} -eq 0 ]]; then
    current "no USB serial adapter connected"
    say "  Connect the adapters and run 'wifilt-pi-setup --only serial' later."
    return 0
  fi
  local i key dev desc al
  say "  Connected adapters:"
  for i in "${!devs[@]}"; do
    IFS='|' read -r key dev desc <<<"${devs[$i]}"
    al=$(aliases_of "$dev")
    printf '    %d) %-13s %s%s\n' "$((i + 1))" "${dev#/dev/}" "$desc" "${al:+   -> $al}"
  done
  [[ -n $foreign ]] && current "aliases defined by hand in: $foreign"
  [[ ${HAVE_SERIAL:-0} == 1 ]] && current "aliases from the previous run in $SERIAL_RULES"

  local def=y q="Assign the aliases now?"
  if [[ -n $foreign || ${HAVE_SERIAL:-0} == 1 ]]; then def=n; q="Change the assignment?"; fi
  ask_yn "$q" "$def" || return 0
  interactive || { say "  (needs a terminal, kept as it is)"; return 0; }

  say "  For each alias type the adapter number, Enter keeps the current one, 0 = none."
  local role cur curn n var
  for role in "${SERIAL_ROLES[@]}"; do
    var="SERIAL_${role^^}"; cur=${!var:-}
    curn=""
    for i in "${!devs[@]}"; do
      IFS='|' read -r key dev desc <<<"${devs[$i]}"
      if [[ $key == "$cur" ]] || { [[ -z $cur ]] && [[ " $(aliases_of "$dev") " == *" ttyUSB.$role "* ]]; }; then
        curn=$((i + 1))
      fi
    done
    while :; do
      ask_str n "ttyUSB.$role  ${ROLE_TEXT[$role]}" "${curn:-0}"
      [[ $n =~ ^[0-9]+$ ]] && (( n <= ${#devs[@]} )) && break
      say "  Enter 0 to ${#devs[@]}."
    done
    if (( n == 0 )); then
      if [[ -n $cur && -z $curn ]]; then
        # saved adapter not connected right now: keep it unless explicitly cleared
        ask_yn "Forget the saved (not connected) adapter for ttyUSB.$role?" n || { printf -v "ANS_$var" '%s' "$cur"; continue; }
      fi
      printf -v "ANS_$var" '%s' ""
    else
      IFS='|' read -r key dev desc <<<"${devs[$((n - 1))]}"
      printf -v "ANS_$var" '%s' "$key"
    fi
  done
  ANS_SERIAL_DISABLE="$foreign"
  DO_SERIAL=1
}

serial_rule_line() { # key role
  local key=$1 role=$2 vid pid ser
  if [[ $key == path:* ]]; then
    printf 'SUBSYSTEM=="tty", ENV{ID_PATH}=="%s", SYMLINK+="ttyUSB.%s"\n' "${key#path:}" "$role"
  else
    IFS=: read -r vid pid ser <<<"$key"
    printf 'SUBSYSTEM=="tty", ATTRS{idVendor}=="%s", ATTRS{idProduct}=="%s", ATTRS{serial}=="%s", SYMLINK+="ttyUSB.%s"\n' \
      "$vid" "$pid" "$ser" "$role"
  fi
}

run_serial() {
  local role var key f
  {
    echo "# Fixed names for USB serial adapters -- written by pi-setup (wifilt-pi-setup --only serial)"
    for role in "${SERIAL_ROLES[@]}"; do
      var="ANS_SERIAL_${role^^}"; key=${!var:-}
      [[ -n $key ]] || continue
      echo "# ${ROLE_TEXT[$role]}"
      serial_rule_line "$key" "$role"
    done
  } | put_text "$SERIAL_RULES" 644 || true

  # rules written by hand for the same aliases would fight with ours
  for f in ${ANS_SERIAL_DISABLE:-}; do
    [[ -f $f ]] || continue
    mv -f "$f" "$f.disabled-by-pi-setup"
    say "  disabled   $f (renamed to $f.disabled-by-pi-setup)"
  done

  udevadm control --reload
  udevadm trigger --subsystem-match=tty --action=change
  udevadm settle -t 5 || true
  for role in "${SERIAL_ROLES[@]}"; do
    var="ANS_SERIAL_${role^^}"
    [[ -n ${!var:-} ]] || continue
    if [[ -e /dev/ttyUSB.$role ]]; then ok "/dev/ttyUSB.$role -> $(readlink -f "/dev/ttyUSB.$role")"
    else warn "/dev/ttyUSB.$role did not appear (adapter unplugged?)"; fi
  done
}

commit_serial() {
  HAVE_SERIAL=1
  SERIAL_CAT=${ANS_SERIAL_CAT:-} SERIAL_CW=${ANS_SERIAL_CW:-} SERIAL_PANEL=${ANS_SERIAL_PANEL:-}
}
