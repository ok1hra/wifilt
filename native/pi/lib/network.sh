# shellcheck shell=bash
#
# pi-setup step 4: network.
#
#  Ethernet  DHCP client first; when nothing answers within 20 s the Pi becomes
#            the DHCP server itself (default 192.168.50.1/24, NAT to Wi-Fi), so
#            TrxNet devices on a bare cable still get addresses.
#  Wi-Fi     wifi-fallback: no known network in range -> own access point with a
#            captive portal where Wi-Fi networks can be added from a phone.
#  netplan   Wi-Fi set in Raspberry Pi Imager lands in netplan; it is turned
#            into a NetworkManager profile (required by fslock, which keeps the
#            profiles on the data card).

ETH_IF=${PI_SETUP_ETH:-eth0}
WIFI_IF=${PI_SETUP_WIFI:-wlan0}
AP_CONF=/etc/default/wifi-fallback
STATIC_HOSTS=/etc/NetworkManager/dnsmasq-shared.d/static-hosts.conf

nm_has() { nmcli -t -f NAME connection show 2>/dev/null | grep -xF -- "$1" >/dev/null; }

# Wi-Fi profiles generated from netplan: "name|uuid"
netplan_wifi() {
  local name uuid type file
  while IFS=: read -r name uuid type file; do
    if [[ $type == 802-11-wireless && ( $file == *netplan* || $name == netplan-* ) ]]; then
      echo "$name|$uuid"
    fi
  done < <(nmcli -t -f NAME,UUID,TYPE,FILENAME connection show 2>/dev/null | sed 's/\\:/\x01/g') | tr '\001' ':'
}

ap_conf_get() {
  [[ -r $AP_CONF ]] || return 0
  sed -n "s/^$1=//p" "$AP_CONF" | tail -n1 | sed "s/^[\"']//; s/[\"']\$//"
}

v_mac_ip() {
  [[ $1 =~ ^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\ +[0-9]{1,3}(\.[0-9]{1,3}){3}(\ +[A-Za-z0-9-]+)?$ ]] \
    || [[ -z $1 ]] || { echo "Expected: MAC IP [name], e.g. de:ad:be:ef:fe:fd 192.168.50.13 oi3"; return 1; }
}

ask_network() {
  header "Network"
  DO_NETWORK=0 ANS_ETH=0 ANS_AP=0 ANS_NETPLAN=0
  if [[ $NO_NM == 1 ]]; then
    current "NetworkManager is not running -- skipped"
    return 0
  fi

  # --- Ethernet
  if [[ -d /sys/class/net/$ETH_IF ]]; then
    local active
    active=$(nmcli -t -f GENERAL.CONNECTION device show "$ETH_IF" 2>/dev/null | cut -d: -f2-)
    current "Ethernet: ${active:-not connected}$([[ ${HAVE_ETH:-0} == 1 ]] && echo ', fallback DHCP server set up')"
    plan_line "DHCP client; with no DHCP answer in 20 s act as DHCP server for the cable"
    if ask_yn "Set up Ethernet with the DHCP server fallback?" y; then
      ANS_ETH=1
      ask_str ANS_ETH_ADDR "  Address of the Pi as DHCP server" "${ETH_SERVER_ADDR:-192.168.50.1/24}" v_cidr
      ANS_ETH_HOSTS=""
      [[ -s $STATIC_HOSTS ]] && say "  Fixed addresses so far:" && sed 's/^/    /' "$STATIC_HOSTS"
      if interactive && ask_yn "  Add a fixed address for a device (MAC -> IP)?" n; then
        local line
        while :; do
          ask_str line "  MAC IP [name], empty = done" "" v_mac_ip
          [[ -z $line ]] && break
          ANS_ETH_HOSTS+="$line;"
        done
      fi
    fi
  else
    current "no $ETH_IF interface"
  fi

  # --- Wi-Fi access point
  if [[ -d /sys/class/net/$WIFI_IF ]]; then
    echo
    current "Wi-Fi fallback access point: $([[ ${HAVE_AP:-0} == 1 ]] && echo installed || echo 'not installed')"
    plan_line "no known Wi-Fi in range -> access point with a page to add networks"
    if ask_yn "Install the Wi-Fi fallback access point?" y; then
      local old_ssid old_psk
      old_ssid=$(ap_conf_get AP_SSID); old_psk=$(ap_conf_get AP_PSK)
      say "  Empty name = WIFILT-setup-<last 4 digits of the MAC>."
      ANS_AP_SSID="$old_ssid"
      if interactive; then
        while :; do
          ask_str ANS_AP_SSID "  Access point name" "${old_ssid:-}" ""
          [[ -z $ANS_AP_SSID ]] && break
          v_ssid "$ANS_AP_SSID" >/dev/null && break
          say "  An SSID has 1 to 32 bytes."
        done
      fi
      ANS_AP_PSK=""
      if [[ -n $old_psk ]] && ask_yn "  Keep the current access point password?" y; then
        :
      elif interactive; then
        say "  Anyone who knows it can change the Wi-Fi settings of this Pi."
        ask_secret ANS_AP_PSK "  Access point password (8-63 characters)" v_psk
      else
        say "  No password set and no terminal to ask -- access point skipped."
        ANS_AP_SSID=""
        ANS_AP=0
      fi
      [[ -n $old_psk || -n $ANS_AP_PSK ]] && ANS_AP=1
    fi
  fi

  # --- netplan
  local np
  np=$(netplan_wifi | cut -d'|' -f1 | tr '\n' ' ')
  if [[ -n $np ]]; then
    echo
    current "Wi-Fi from netplan (Raspberry Pi Imager): $np"
    plan_line "turn it into a NetworkManager profile (takes effect after a reboot)"
    ask_yn "Convert it?" y && ANS_NETPLAN=1
  fi

  [[ $ANS_ETH == 1 || $ANS_AP == 1 || $ANS_NETPLAN == 1 ]] && DO_NETWORK=1
  return 0
}

# --- Ethernet ------------------------------------------------------------------
nm_upsert_eth() { # name settings...
  local name=$1; shift
  if nm_has "$name"; then
    nmcli connection modify "$name" "$@"
    say "  updated    NM profile $name"
  else
    nmcli connection add type ethernet ifname "$ETH_IF" con-name "$name" "$@" >/dev/null
    say "  created    NM profile $name"
  fi
}

run_eth() {
  nm_upsert_eth eth0-dhcp \
    connection.autoconnect yes connection.autoconnect-priority 10 connection.autoconnect-retries 1 \
    ipv4.method auto ipv4.dhcp-timeout 20 ipv4.may-fail no
  nm_upsert_eth eth0-dhcp-server \
    connection.autoconnect yes connection.autoconnect-priority 0 \
    ipv4.method shared ipv4.addresses "$ANS_ETH_ADDR" ipv6.method ignore

  # NetworkManager's automatic "Wired connection 1" would compete with ours
  if printf '[main]\nno-auto-default=interface-name:%s\n' "$ETH_IF" \
       | put_text /etc/NetworkManager/conf.d/90-wifilt-no-auto-default.conf 644; then
    systemctl reload NetworkManager || true
  fi
  local name uuid type file dev
  while IFS=: read -r name uuid type file dev; do
    [[ $type == 802-3-ethernet && $name != eth0-dhcp && $name != eth0-dhcp-server ]] || continue
    if [[ $dev == "$ETH_IF" && $SSH_IFACE == "$ETH_IF" ]]; then
      # this SSH session runs over it: never cut the branch we sit on
      [[ $file == /run/* ]] || nmcli connection modify "$uuid" connection.autoconnect no
      say "  kept       '$name' (this session uses it), replaced after a reboot"
      need_reboot "Ethernet switches to the eth0-dhcp profile"
    elif [[ $file == /run/* ]]; then
      nmcli connection delete "$uuid" >/dev/null && say "  removed    automatic profile '$name'"
    else
      nmcli connection modify "$uuid" connection.autoconnect no && say "  disabled   autoconnect of '$name'"
    fi
  done < <(nmcli -t -f NAME,UUID,TYPE,FILENAME,DEVICE connection show 2>/dev/null)

  if [[ -n ${ANS_ETH_HOSTS:-} ]]; then
    local tmp entry mac ip hn
    tmp=$(mktemp)
    [[ -f $STATIC_HOSTS ]] && cat "$STATIC_HOSTS" > "$tmp"
    IFS=';' read -ra entries <<<"$ANS_ETH_HOSTS"
    for entry in "${entries[@]}"; do
      read -r mac ip hn <<<"$entry"
      [[ -n $mac ]] || continue
      sed -i "/^dhcp-host=${mac,,},/Id" "$tmp"
      echo "dhcp-host=${mac,,},$ip${hn:+,$hn}" >> "$tmp"
    done
    put_file "$tmp" "$STATIC_HOSTS" 644 || true
    rm -f "$tmp"
  fi

  if [[ $(cat /sys/class/net/"$ETH_IF"/carrier 2>/dev/null) == 1 && $SSH_IFACE != "$ETH_IF" ]]; then
    info "bringing up eth0-dhcp (falls back to the DHCP server after 20 s)"
    nmcli --wait 40 connection up eth0-dhcp >/dev/null 2>&1 \
      && ok "Ethernet: DHCP client, $(ip -4 -br addr show "$ETH_IF" | awk '{print $3}')" \
      || ok "Ethernet: no DHCP answer, the DHCP server profile takes over"
  fi
}

# --- Wi-Fi fallback ----------------------------------------------------------------
conf_set() { # file key value  (value taken literally)
  KEY=$2 VAL=$3 awk -F= '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"] }
    $1 == k { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$1" > "$1.tmp" && cat "$1.tmp" > "$1" && rm -f "$1.tmp"
}

run_ap() {
  local changed=0
  put_file "$FILES/wifi-fallback" /usr/local/sbin/wifi-fallback 755 && changed=1
  put_file "$FILES/wifi-fallback.service" /etc/systemd/system/wifi-fallback.service 644 && changed=1
  if [[ ! -f $AP_CONF ]]; then
    install -m 600 "$FILES/wifi-fallback.conf" "$AP_CONF"
    say "  written    $AP_CONF"
    changed=1
  fi
  chmod 600 "$AP_CONF"
  if [[ ${ANS_AP_SSID:-} != "$(ap_conf_get AP_SSID)" ]]; then
    conf_set "$AP_CONF" AP_SSID "${ANS_AP_SSID:-}"; changed=1
  fi
  if [[ -n ${ANS_AP_PSK:-} ]]; then
    conf_set "$AP_CONF" AP_PSK "$ANS_AP_PSK"; changed=1
    say "  password   set in $AP_CONF"
  fi
  systemctl daemon-reload
  systemctl enable wifi-fallback >/dev/null 2>&1
  if [[ $changed == 1 ]] || ! systemctl is-active --quiet wifi-fallback; then
    systemctl restart wifi-fallback
  fi
  ok "wifi-fallback running (log: journalctl -u wifi-fallback)"
  local ssid
  ssid=$(ap_conf_get AP_SSID)
  if [[ -z $ssid ]]; then
    ssid="WIFILT-setup-$(tr -d ':' < /sys/class/net/"$WIFI_IF"/address 2>/dev/null | tail -c 5 | tr 'a-f' 'A-F')"
  fi
  note "without a known Wi-Fi the Pi opens the access point '$ssid' (portal page opens by itself; WIFILT at http://192.168.4.1/)"
}

# --- netplan -> NetworkManager keyfile ----------------------------------------------
convert_netplan() {
  local entry name uuid ssid psk km prio f moved=0
  local backup=/root/netplan.pre-wifilt
  while IFS= read -r entry; do
    [[ -n $entry ]] || continue
    IFS='|' read -r name uuid <<<"$entry"
    ssid=$(nmcli -g 802-11-wireless.ssid connection show "$uuid")
    km=$(nmcli -g 802-11-wireless-security.key-mgmt connection show "$uuid" 2>/dev/null || true)
    psk=$(nmcli -s -g 802-11-wireless-security.psk connection show "$uuid" 2>/dev/null || true)
    prio=$(nmcli -g connection.autoconnect-priority connection show "$uuid" 2>/dev/null || echo 0)
    if nm_has "wifi-$ssid"; then
      say "  exists     NM profile wifi-$ssid"
    else
      local sec=()
      [[ -n $psk ]] && sec=(wifi-sec.key-mgmt "${km:-wpa-psk}" wifi-sec.psk "$psk")
      nmcli connection add type wifi ifname "$WIFI_IF" con-name "wifi-$ssid" ssid "$ssid" "${sec[@]}" \
        connection.autoconnect yes connection.autoconnect-priority "${prio:-0}" \
        ipv4.method auto ipv6.method auto >/dev/null
      say "  created    NM profile wifi-$ssid (from netplan '$name')"
    fi
    unset psk
    # the YAML NetworkManager wrote is named after the profile's UUID; Imager's
    # own file is found by the SSID it contains and moved only if it is Wi-Fi only
    install -d -m 700 "$backup"
    for f in /etc/netplan/*.yaml; do
      [[ -f $f ]] || continue
      if [[ $f == */90-NM-$uuid.yaml ]] \
         || { grep -qF -- "\"$ssid\"" "$f" && grep -q 'wifis:' "$f" && ! grep -q 'ethernets:' "$f"; }; then
        mv -f "$f" "$backup/"
        say "  moved      $f -> $backup/"
        moved=1
      fi
    done
  done < <(netplan_wifi)
  # netplan's generated profiles stay until the next boot: switching now would
  # drop the Wi-Fi under a session that may run over it
  [[ $moved == 1 ]] && need_reboot "Wi-Fi profile moved from netplan to NetworkManager"
  return 0
}

run_network() {
  [[ ${ANS_ETH:-0} == 1 ]] && run_eth
  [[ ${ANS_AP:-0} == 1 ]] && run_ap
  [[ ${ANS_NETPLAN:-0} == 1 ]] && convert_netplan
  return 0
}

commit_network() {
  [[ ${ANS_ETH:-0} == 1 ]] && { HAVE_ETH=1; ETH_SERVER_ADDR=$ANS_ETH_ADDR; }
  [[ ${ANS_AP:-0} == 1 ]] && HAVE_AP=1
  return 0
}
