# shellcheck shell=bash
#
# pi-setup step 6: power-loss protection.
#
# The Pi is switched off by pulling the plug. To survive that:
#  * the root file system (SD card) is made read-only by overlayroot -- changes
#    go to RAM and vanish at reboot -- and /boot/firmware is mounted read-only;
#  * a second card in a USB reader (ext4, label RPIDATA, mounted on /data with
#    data=journal,sync) stays writable and carries the settings of WIFILT,
#    local-trx and NetworkManager, bind-mounted to where the programs expect them;
#  * a copy of the settings stays on the SD card under the bind mounts, so the
#    station still starts with the last settings when the data card is missing.
# The fslock command locks and unlocks (an unlock needs a reboot) and keeps
# backups of the settings.

DATA_MNT=/data
DATA_LABEL=RPIDATA
FSTAB_MARK="wifilt-pi data card (fslock)"

# data-card name : target path
fslock_map() {
  printf '%s\n' "wifilt:$RUN_HOME/.config/wifilt" \
                "local-trx:$RUN_HOME/.config/local-trx" \
                "nm-connections:/etc/NetworkManager/system-connections"
}

# USB disks: "dev|size|model|label-of-first-partition"
usb_disks() {
  local name tran size model part label
  while read -r name tran size model; do
    [[ $tran == usb ]] || continue
    part=$(lsblk -lnpo NAME,TYPE "/dev/$name" | awk '$2 == "part" {print $1; exit}')
    label=""
    [[ -n $part ]] && label=$(lsblk -no LABEL "$part" 2>/dev/null | head -n1)
    printf '/dev/%s|%s|%s|%s\n' "$name" "$size" "${model:-?}" "$label"
  done < <(lsblk -dno NAME,TRAN,SIZE,MODEL 2>/dev/null)
}

ask_fslock() {
  header "Power-loss protection (fslock)"
  DO_FSLOCK=0 ANS_FORMAT_DEV="" ANS_DATA_UUID=""
  local have=0
  [[ ${HAVE_FSLOCK:-0} == 1 || -x /usr/local/sbin/fslock ]] && have=1
  if [[ $have == 1 ]]; then
    current "installed, system $([[ $LOCKED == 1 ]] && echo locked || echo unlocked), data card $(mountpoint -q $DATA_MNT && echo mounted || echo 'NOT mounted')"
  else
    current "not installed"
    say "  Makes the SD card read-only so pulling the plug cannot damage it; the"
    say "  settings live on a second card in a USB reader (any size, it gets"
    say "  formatted). Updates then go: unlock -> reboot -> update -> lock."
  fi
  local def=n
  [[ $have == 1 ]] && def=y
  ask_yn "$([[ $have == 1 ]] && echo "Update fslock?" || echo "Set up fslock?")" "$def" || return 0

  # --- data card
  local uuid
  uuid=$(blkid -L "$DATA_LABEL" 2>/dev/null | xargs -r blkid -s UUID -o value 2>/dev/null || true)
  if [[ -n $uuid ]]; then
    say "  Data card found: $(blkid -L "$DATA_LABEL") (label $DATA_LABEL), it is used as it is."
    ANS_DATA_UUID=$uuid
  elif [[ -n ${DATA_UUID:-} ]]; then
    say "  Data card UUID=$DATA_UUID from the previous setup is not connected; fstab keeps it."
    ANS_DATA_UUID=$DATA_UUID
  else
    local -a disks
    mapfile -t disks < <(usb_disks)
    if [[ ${#disks[@]} -eq 0 ]]; then
      say "  No USB disk found. Insert the data card (in a USB reader) and run this again."
      return 0
    fi
    say "  USB disks:"
    local i d sz md lb
    for i in "${!disks[@]}"; do
      IFS='|' read -r d sz md lb <<<"${disks[$i]}"
      printf '    %d) %s  %s  %s%s\n' "$((i + 1))" "$d" "$sz" "$md" "${lb:+  (label $lb)}"
    done
    interactive || { say "  (choosing and formatting a card needs a terminal -- skipped)"; return 0; }
    local n
    while :; do
      ask_str n "  Which one becomes the data card? 0 = none" "0"
      [[ $n =~ ^[0-9]+$ ]] && (( n <= ${#disks[@]} )) && break
    done
    (( n == 0 )) && return 0
    IFS='|' read -r d sz md lb <<<"${disks[$((n - 1))]}"
    printf '  %sEVERYTHING on %s (%s %s) will be erased.%s\n' "$C_RED" "$d" "$sz" "$md" "$C_0"
    local confirm
    ask_str confirm "  Type 'FORMAT $d' to confirm" ""
    [[ $confirm == "FORMAT $d" ]] || { say "  Not confirmed, fslock skipped."; return 0; }
    ANS_FORMAT_DEV=$d
  fi

  # the netplan Wi-Fi profile would be regenerated outside the data card
  if [[ $NO_NM == 0 && -n $(netplan_wifi) && ${ANS_NETPLAN:-0} != 1 ]]; then
    say "  The Wi-Fi from Raspberry Pi Imager is in netplan; it gets converted to a"
    say "  NetworkManager profile on the data card (needed, otherwise Wi-Fi changes are lost)."
    ANS_NETPLAN=1
  fi
  DO_FSLOCK=1
}

# The question at the end of the question phase: what state to end in.
ask_finish() {
  ANS_LOCK_AT_END=0 ANS_RELOCK=0 ANS_RELOCK_MIN=10
  if [[ $LOCKED == 1 ]]; then
    echo
    say "After the update the system can lock itself again (as it is now)."
    say "You get time to check the station first; the lock can be cancelled"
    say "(wifilt-pi-setup --keep-unlocked) or brought forward (sudo fslock lock)."
    if ask_yn "Lock again when the update is finished?" y; then
      ANS_RELOCK=1
      ask_str ANS_RELOCK_MIN "  Minutes to wait before locking" 10 v_minutes
    fi
  elif [[ ${DO_FSLOCK:-0} == 1 && $MODE == fresh ]]; then
    echo
    say "Lock the system right at the end? Better first reboot once and check"
    say "that everything starts (data card, Wi-Fi), then run: sudo fslock lock"
    ask_yn "Lock at the end of the installation?" n && ANS_LOCK_AT_END=1
  fi
  return 0
}

format_data_card() {
  local dev=$1 part
  [[ $(lsblk -dno TRAN "$dev") == usb ]] || die "$dev is not a USB disk -- refusing to format it"
  findmnt -rno TARGET -S "$dev" >/dev/null 2>&1 && die "$dev is mounted"
  lsblk -lnpo NAME "$dev" | tail -n +2 | while read -r part; do
    findmnt -rno TARGET -S "$part" >/dev/null 2>&1 && umount "$part"
  done
  info "formatting $dev (ext4, label $DATA_LABEL)" >&2
  wipefs -qa "$dev"
  echo 'label: dos
type=83' | sfdisk -q "$dev"
  partprobe "$dev" 2>/dev/null || true
  udevadm settle -t 10 || true
  part=$(lsblk -lnpo NAME,TYPE "$dev" | awk '$2 == "part" {print $1; exit}')
  [[ -n $part ]] || die "no partition on $dev after partitioning"
  mkfs.ext4 -q -F -L "$DATA_LABEL" -m 0 -J size=8 "$part"
  tune2fs -o journal_data -e remount-ro "$part" >/dev/null
  udevadm settle -t 10 || true
  blkid -s UUID -o value "$part"
}

run_fslock() {
  local uuid=${ANS_DATA_UUID:-} name target unit

  # --- data card and fstab
  if [[ -n ${ANS_FORMAT_DEV:-} ]]; then
    uuid=$(format_data_card "$ANS_FORMAT_DEV" | tail -n1)
    [[ -n $uuid ]] || die "formatting gave no UUID"
    ok "data card UUID=$uuid"
  fi
  [[ -n $uuid ]] || die "no data card"
  ANS_DATA_UUID=$uuid
  echo "$uuid" > "$RUN_DIR/data-uuid"

  [[ -f /etc/fstab.pre-fslock ]] || cp -a /etc/fstab /etc/fstab.pre-fslock
  # a station set up by hand has the same mounts without our markers: drop
  # those lines, or the block below would mount everything twice
  local targets=" $DATA_MNT " tmp
  while IFS=: read -r name target; do targets+="$target "; done < <(fslock_map)
  tmp=$(mktemp)
  awk -v t="$targets" -v b="# >>> $FSTAB_MARK >>>" -v e="# <<< $FSTAB_MARK <<<" '
    $0 == b { inb = 1 }
    $0 == e { inb = 0; print; next }
    !inb && $0 !~ /^[[:space:]]*#/ && NF >= 2 && index(t, " " $2 " ") { next }
    { print }' /etc/fstab > "$tmp"
  if ! cmp -s "$tmp" /etc/fstab; then
    cat "$tmp" > /etc/fstab
    say "  replaced   unmarked $DATA_MNT lines in /etc/fstab (copy: /etc/fstab.pre-fslock)"
  fi
  rm -f "$tmp"
  {
    echo "UUID=$uuid  $DATA_MNT  ext4  defaults,noatime,data=journal,sync,errors=remount-ro,nofail,x-systemd.device-timeout=10s  0  2"
    while IFS=: read -r name target; do
      printf '%s  %s  none  bind,nofail,x-systemd.requires=data.mount  0  0\n' "$DATA_MNT/$name" "$target"
    done < <(fslock_map)
  } | replace_block /etc/fstab "$FSTAB_MARK" || true

  # --- move the settings onto the card (only into empty places on the card)
  systemctl daemon-reload
  install -d "$DATA_MNT"
  mountpoint -q "$DATA_MNT" || mount "$DATA_MNT" || die "cannot mount the data card on $DATA_MNT"
  local moved=0
  while IFS=: read -r name target; do
    if mountpoint -q "$target"; then
      say "  on card    $target"
      continue
    fi
    if [[ $name == nm-connections ]]; then
      install -d -o root -g root -m 755 "$DATA_MNT/$name"
    else
      install -d -o "$RUN_USER" -g "$(id -gn "$RUN_USER")" -m 700 "$DATA_MNT/$name"
      install -d -o "$RUN_USER" -g "$(id -gn "$RUN_USER")" -m 700 "$target"
    fi
    if [[ -z $(ls -A "$DATA_MNT/$name" 2>/dev/null) ]]; then
      if [[ $moved == 0 ]]; then systemctl stop wifilt local-trx 2>/dev/null || true; moved=1; fi
      rsync -aHAX "$target/" "$DATA_MNT/$name/"
      say "  copied     $target -> $DATA_MNT/$name"
    else
      say "  kept       $DATA_MNT/$name (already has data, the card wins)"
    fi
    mount "$target"
    say "  mounted    $target"
  done < <(fslock_map)
  [[ $NO_NM == 0 ]] && nmcli connection reload || true

  # --- start order: services wait for the card (and start without it, nofail)
  for unit in wifilt local-trx NetworkManager; do
    local after="data.mount"
    while IFS=: read -r name target; do
      case "$unit:$name" in
        wifilt:wifilt|local-trx:local-trx|NetworkManager:nm-connections)
          after+=" $(systemd-escape -p --suffix=mount "$target")" ;;
      esac
    done < <(fslock_map)
    sed "s|@AFTER@|$after|" "$FILES/fslock-data.conf.in" \
      | put_text "/etc/systemd/system/$unit.service.d/fslock-data.conf" 644 || true
  done
  systemctl daemon-reload

  # --- netplan Wi-Fi must become a profile on the card
  [[ ${ANS_NETPLAN:-0} == 1 && $NO_NM == 0 ]] && convert_netplan

  # --- overlayroot
  if ! dpkg-query -W -f='${Status}' overlayroot 2>/dev/null | grep -q 'install ok installed'; then
    info "installing overlayroot"
    DEBIAN_FRONTEND=noninteractive apt-get install -y overlayroot
  fi
  local initrd
  case $(uname -r) in
    *2712*) initrd=/boot/firmware/initramfs_2712 ;;
    *v8*)   initrd=/boot/firmware/initramfs8 ;;
    *)      initrd=/boot/firmware/initramfs8 ;;
  esac
  if ! lsinitramfs "$initrd" 2>/dev/null | grep -q 'scripts/init-bottom/overlayroot'; then
    info "rebuilding the initramfs with overlayroot"
    update-initramfs -u
  fi
  lsinitramfs "$initrd" 2>/dev/null | grep -q 'scripts/init-bottom/overlayroot' \
    || die "$initrd does not contain overlayroot (is auto_initramfs=1 in config.txt?)"

  # --- the fslock command, its settings and the login notice
  put_file "$FILES/fslock" /usr/local/sbin/fslock 755 || true
  {
    echo "# fslock settings -- written by pi-setup"
    printf 'STATION_USER=%q\n' "$RUN_USER"
    echo "DATA_MAP=("
    while IFS=: read -r name target; do printf '  %q\n' "$name:$target"; done < <(fslock_map)
    echo ")"
  } | put_text /etc/fslock.conf 644 || true
  put_file "$FILES/fslock-profile.sh" /etc/profile.d/fslock.sh 644 || true

  if [[ ! -s $RUN_DIR/reboot ]]; then
    note "fslock is ready: reboot once, check 'sudo fslock status' (data card, everything 'on card'), then lock: sudo fslock lock"
  else
    note "fslock is ready: after the reboot check 'sudo fslock status', then lock: sudo fslock lock"
  fi
}

commit_fslock() {
  HAVE_FSLOCK=1
  DATA_UUID=$(cat "$RUN_DIR/data-uuid" 2>/dev/null || echo "${ANS_DATA_UUID:-}")
}
