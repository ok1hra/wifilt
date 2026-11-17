# Supernode n2n v3 pro vzdálený přístup wifilt (remoteqth.com:82)

Návod pro správce VPS. Nahradí stávající supernode **n2n v1** na portu 82 supernodem **n2n 3.1.1** postaveným ze zdrojáků. Uživatelská strana (párování, SETUP, sestavení n2n na stanici) je v manuálu, [SOFTWARE.md § 1.9](../../SOFTWARE.md#19-remote-access-over-the-internet-pc-and-raspberry-pi).

Server: Debian nebo Ubuntu, root. Všechny příkazy se spouštějí jako root.

**Co supernode vidí:** názvy komunit (`wl-…`), veřejné IP zařízení a jejich popisy (např. `OK1HRA-RPI`). Obsah provozu nevidí, je šifrovaný klíčem, který znají jen zařízení uživatele.

> **Pozor: přechod odřízne uživatele v1.** n2n v1 a v3 spolu nekomunikují. Kdo dnes používá `remoteqth.com:82` se starým n2n v1, po přechodu se nepřipojí.

## 1. Najít a zastavit supernode v1

Zjistit, co drží port 82 a jak se spouští:

```sh
ss -lunp | grep ':82 '
ss -ltnp | grep ':82 '
systemctl list-units --all | grep -i -E 'n2n|supernode'
ps -ef | grep -i '[s]upernode'
dpkg -S "$(command -v supernode)" 2>/dev/null   # z balíku "n2n" = distribuční v1
```

Než ho zastavíte, podívejte se do jeho logu, jestli na něm někdo je: v1 píše `Registered new node … [community=…]`.

Zastavit a vypnout podle toho, jak běží:
- systemd: `systemctl disable --now <unit>`
- jinak proces ukončit a odstranit spouštění z `rc.local`, cronu nebo `screen`

Distribuční balík `n2n` (v1) může zůstat, v3 jde do `/usr/local/sbin` a nekoliduje s ním. Po ověření v3 ho lze odebrat: `apt purge n2n`.

## 2. Postavit n2n 3.1.1

```sh
apt update
apt install -y build-essential autoconf automake libtool git
cd /usr/local/src
git clone https://github.com/ntop/n2n.git
cd n2n
git checkout 3.1.1
git rev-parse HEAD
```

`git rev-parse HEAD` musí vypsat přesně `ce998b986c633bc563835d8a3cc8f72a017b53d1`. Pokud vypíše něco jiného, **nepokračujte**: tag se změnil nebo jde o jiný zdroj.

```sh
./autogen.sh
./configure --enable-pthread
make
make PREFIX=/usr/local install
/usr/local/sbin/supernode -h | head -3
```

Poslední příkaz má vypsat prázdný řádek a pod ním `Welcome to n2n v.3.1.1 for Linux`.

`--enable-pthread` je stejný build jako na stanicích (SOFTWARE.md § 1.9). Supernode ho nutně nepotřebuje, edge bez něj se se jménem `remoteqth.com` nezaregistruje.

> **Nikdy jen `make install`.** Výchozí `PREFIX` je `/usr`, takže by binárky zapsal do `/usr/sbin`, přes soubory distribučního balíku n2n. `apt` by je pak při aktualizaci vrátil na v1.

## 3. Konfigurace

```sh
install -d -m 755 /etc/n2n
cat > /etc/n2n/community.list <<'EOF'
# wifilt: povolené jen komunity z párovacího kódu, "wl-" + 8 znaků.
# Smí tu být JEN JEDEN regex a jen \w: knihovna regexů v n2n má na znakové
# třídy [..] buffer 40 B, s [0-9a-z] x8 by supernode tiše odmítl všechny.
wl-\w\w\w\w\w\w\w\w
EOF
chmod 644 /etc/n2n/community.list

( umask 077
  printf 'N2N_FEDERATION=%s\n' "$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')" > /etc/n2n/supernode.env )
```

Název federace je tajný (16 hex znaků, n2n jich přijme nejvýš 17). Bez něj supernode použije veřejný výchozí `*Federation` a cizí supernode by se k němu mohl připojit jako člen federace. Do `ps` se nedostane, protože se předává přes prostředí.

## 4. Služba systemd

```sh
cat > /etc/systemd/system/n2n-supernode.service <<'EOF'
[Unit]
Description=n2n 3.1.1 supernode for wifilt remote access (UDP/TCP 82)
Documentation=https://github.com/ok1hra/wifilt/tree/main/server/supernode
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/n2n/supernode.env
# Port 82 si otevře jako root, pak sám shodí práva na nobody (65534).
ExecStart=/usr/local/sbin/supernode -p 82 -c /etc/n2n/community.list -f
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now n2n-supernode
journalctl -u n2n-supernode -n 30 --no-pager
```

V logu má být:
- `loaded 0 fixed-name communities` a `loaded 1 regular expressions`
- `supernode is listening on UDP 82 (main)` a `… TCP 82 (aux)`
- `supernode is listening on UDP 5645 (management)`; management poslouchá jen na `127.0.0.1`
- `dropping privileges to uid=65534, gid=65534`
- **žádné** `WARNING: using default federation name`

## 5. Firewall

Otevřít UDP 82 (hlavní provoz) a TCP 82 (záložní TCP). Port 5645 neotevírat.

```sh
ufw allow 82/udp
ufw allow 82/tcp
```

S nftables nebo iptables přidejte ekvivalentní pravidla do své sady. Pokud má VPS firewall i u poskytovatele, otevřete porty i tam.

## 6. Ověření

**Na serveru:**

```sh
apt install -y netcat-openbsd     # pokud chybí nc
echo "r 1 communities" | nc -u -w1 127.0.0.1 5645
```

Ukáže `begin` / `row` / `end`. Bez připojených zařízení je tam jen řádek federace.

**Z jiného počítače s n2n 3.1.1** (Linux, root kvůli rozhraní TAP):

```sh
sudo N2N_KEY=TESTTESTTESTTESTTEST /usr/local/sbin/edge \
     -d n2ntest -c wl-test0001 -l remoteqth.com:82 -A4 -I TEST -f
```

- Očekávané hlášky: `[OK] edge <<< ================ >>> supernode` a `created local tap device IP: 10.x.y.z`. Ukončit Ctrl+C.
- Na serveru teď `r 1 communities` ukáže `wl-test0001` s podsítí.
- **Negativní test:** s `-c foo` edge jen opakuje `send REGISTER_SUPER …` a `r 1 communities` na serveru `foo` neukáže. Hláška `discarded registration with unallowed community 'foo'` se do journalu dostane jen s `-v` (úroveň INFO).

Návod je ověřený v síťových namespacech s postaveným 3.1.1: `community.list` přesně z kroku 3, `N2N_FEDERATION` z `supernode.env` (bez varování o výchozí federaci), `wl-test0001` přijato, `foo` odmítnuto.

## 7. Údržba

- **Restart supernode přeruší všechny VPN** asi na 15 s; zařízení se samy znovu zaregistrují. Když supernode neběží déle, přestane do ~40 s fungovat i přímý provoz mezi zařízeními.
- **Aktualizace na novější tag:**

  ```sh
  cd /usr/local/src/n2n
  git fetch --tags
  git checkout <tag>
  git rev-parse HEAD                     # porovnat s commitem tagu na GitHubu
  ./autogen.sh && ./configure --enable-pthread && make
  cp /usr/local/sbin/supernode /usr/local/sbin/supernode.prev
  make PREFIX=/usr/local install
  systemctl restart n2n-supernode
  ```

  Návrat: `cp /usr/local/sbin/supernode.prev /usr/local/sbin/supernode && systemctl restart n2n-supernode`.

- **Bezpečnostní opravy nepřijdou přes `apt`.** Sledujte https://github.com/ntop/n2n (releases, security advisories).
- **Logy:** bez `-v` jsou řídké. Přehled komunit a jejich podsítí dává `r 1 communities`, viz výše.
- **Zneužití:** supernode přijme libovolnou komunitu tvaru `wl-` + 8 znaků. Když se objeví cizí provoz, sledujte zátěž (`r 1 communities`, `iftop`) a případně omezte rychlost na IP v nftables.
