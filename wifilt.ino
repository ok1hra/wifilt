/*
  Based on ESP32 BT CAT for IC-705 by OK1CDJ ondra@ok1cdj.com
  https://github.com/ok1cdj/IC705-BT-CIV
  -----------------------------------------------------------
  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.
  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.
  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <http://www.gnu.org/licenses/>.
  -----------------------------------------------------------

  Firmware build dependencies
  - Arduino IDE 1.8.19 or 2.x
  - Espressif Arduino-ESP32 core 2.0.14
  - Board: "ESP32 Dev Module"
  - Partition Scheme: "No OTA (2MB APP/2MB SPIFFS)"
  - TrxNet 0.3.0: https://github.com/ok1hra/TrxNet
  EEPROM, WiFi, ESPmDNS, WebServer, FS and LittleFS are supplied by the pinned
  ESP32 core; PubSubClient is not required. Bluetooth was removed in 2026-07 --
  the transports are ICOM-LAN, CI-V and TrxNet.
  Flash mode must be DIO (not QIO) and the sketch-local partitions.csv overrides
  the Partition Scheme menu entry. See README.md "Building from source".

  DATA/JS8 asset and release dependencies (Debian 12)
    sudo apt install build-essential ca-certificates cmake dpkg-dev emscripten \
      git gzip libboost1.81-dev libfftw3-dev nodejs p7zip-full python3 \
      terser xz-utils
  Enable matching Debian deb-src entries for the pinned FFTW source build.
  Reviewed release versions: Emscripten 3.1.6, CMake 3.25.1, Node 18.20.4
  (local checks accept Node 18-20). See docs/js8call-build.md.


  ./tools/release.sh

  1. Increase REV value in this .ino
  2. Arduino IDE 1.8.19 menu: Sketch/Export compiled Binary
     Board "ESP32 Dev Module", Tools/Partition Scheme:"No OTA (2MB APP/2MB SPIFFS)",
     Tools/Flash Mode:"DIO"  <-- NOT the IDE default QIO. These boards carry a Zbit
     (0x5e) clone flash whose QIO reads are unreliable, and the flash mode is baked
     into the image header at compile time: upload-firmware-spiffs.sh passes no
     --flash_mode, so whatever is set here is what the board ends up running.
  3. make -C native dist (apt install mingw-w64)
     optional check
     tools/native-integration-test.sh
  4. ./tools/upload-firmware-spiffs.sh --port /dev/ttyUSB0
     check without write
     ./tools/upload-firmware-spiffs.sh --dry-run
    for slow comm
    ./tools/upload-firmware-spiffs.sh --port /dev/ttyUSB0 --baud 460800

  5. generate all .bin and publish to GitHub web page: $ ./tools/gh-pages.sh --publish
  6. git commit with comment Release number and push

  Manual workflow
  - after editing data/*.html/css/js, upload the filesystem alone with
    tools/upload-spiffs.sh -- it runs tools/prepare-spiffs-tree.sh for you
  - do NOT run tools/gzip-assets.sh by hand instead: on its own it skips
    tools/stamp-asset-versions.js, so every ?v= keeps pointing at the previous
    content and a browser with a warm cache never fetches the new file

  Features -- keep this list matching the code. Its previous version promised an
  http server on port 81 and a UDP listener on port 89, neither of which had
  existed for years, and both README.md and the user manual copied them from
  here. The per-release history that used to be appended below lives in
  Changelog.md, which is the only place it is maintained.
  + Three independently configured radio slots using LAN, TrxNet or CI-V
  + Web interface on http port 80 (http://wifilt.local): setup, QRPLog, DATA/JS8,
    WSPR, DXC and the band decoder
  + DX cluster telnet stream relayed on port 82, radio audio (AUD1) on WebSocket port 83
  + CW and RTTY keyed from the log over the web API (POST /cmd, type sendCw):
    CW goes out as a CI-V message, RTTY by keying the FSK and PTT outputs
    (45.45 Bd, 1.5 stop bits, mark LOW, 400 ms lead, 200 ms tail)
  + Status LED
    - Fade in/out - WiFi in AP mode
    - WiFi in client mode
      - OFF while waiting for the WiFi connection
      - ON once connected
      - 100 ms dark pulse when a CW message is sent
      - dark for as long as RTTY is being keyed
  + mDNS - to easily find IP devices in the network, using the command "ping wifilt.local"
  + Watchdog - resets the device after more than 73 seconds of inactivity
  + Output signal POWER-OUT (13.8V/0.5A) with LED activates after connecting a full-CAT primary radio
  + Galvanically isolated CI-V output for connecting PA or other devices
  + CIV-MUTE on gpio16 allow send to CI-V output only commands with frequency (not debug messages)
  + after a full-CAT primary connection, set TRX to enable CI-V transceive + RIT + BK-IN
  + Band decoder: outputs switched by frequency through an external shift register
  + Detect PCB hardware ID (HW rev 02 and 03)
  + TrxNet peer-to-peer telemetry between interfaces (replaced MQTT)
  + legacy BT configuration retained only for downgrade compatibility
  + after connect WiFi, play assigned IP address in CW on a full-CAT TRX1 as sidetone only (BK-IN forced off so it never transmits; snapshots+restores mode/BK-IN/AF/RF gain)
  + send ? in serial terminal, answer interface status
  + optional reset after TRX disconnect

  
  FYI https://github.com/Rhizomatica/mercury

//--------------------------------------------------------------------*/

String SSID         = "";
String PSWD         = "";
String SSID2        = "";
String PSWD2        = "";
// TrxNet config — NET_ID 0x00 = disabled sentinel (TrxNet not activated)
byte     TRXNET_ID      = 0x01;   // own device NET_ID → device name "705.01"
byte     TRX2_NET_ID    = 0xff;   // peer NET_ID for TRX2 Band Decoder slot (0x00 = disabled)
byte     TRX3_NET_ID    = 0x00;   // peer NET_ID for TRX3 Band Decoder slot (0x00 = disabled)
byte     TRX2_CONN_TYPE = 0x00;   // 0=TrxNet, 1=CI-V, 2=LAN (EEPROM byte 44)
byte     TRX3_CONN_TYPE = 0x00;   // 0=TrxNet, 1=CI-V, 2=LAN (EEPROM byte 47)
byte     TRX2_CIV_ADDR  = 0x00;   // CI-V address of TRX2 when CONN_TYPE=CI-V (EEPROM byte 48; 0x00=unset)
byte     TRX3_CIV_ADDR  = 0x00;   // CI-V address of TRX3 when CONN_TYPE=CI-V (EEPROM byte 49; 0x00=unset)
uint16_t TRXNET_PORT    = 5683;   // CoAP/discovery UDP port (CoAP default)
int BaudRate        = 9600;
// char* BTname        = "";
// const char* BTname  = "IC705-interface";
String BT_NAME;  // legacy EEPROM field, retained for downgrade compatibility
bool Debug          = false;
// Off by default: it keys the sidetone on every first connect, and an operator
// who has just been handed the address on screen did not ask to hear it. A
// device that already stored a choice keeps it -- EEPROM 136 only falls back to
// this when it was never written.
bool cwIpOnConnect  = false;      // announce WiFi IP via CW on first full-CAT radio connect
volatile bool cwIpSendPending = false;

// How long a single loop stage may take before it is reported. 200 ms is the
// operational threshold -- below that nothing user-visible suffers. Overridable
// from the build so the same instrumentation can be turned into a profiler
// (-DLOOP_WARN_MS=20) without touching the source: measuring which stage
// actually costs the time is the first step of any work on the cooperative
// loop, and guessing at it is how the wrong thing gets optimised.
#ifndef LOOP_WARN_MS
  #define LOOP_WARN_MS 200
#endif
#define REV 20260823
#define WIFI
#define FSK_KEYING  // RTTY by keying the FSK + PTT outputs (was UDP_TO_FSK, from when a UDP port fed it)
#define WDT         // watchdog timer
#define CIV_OUT     // send freq to CIV out with BaudRate
// #define BLUETOOTH   // legacy only; UI supports LAN, TrxNet and CI-V
// #define RESET_AFTER_DISCONNECT  // enable reset after each disconnect + short CW msg

// Which capabilities physically exist on this build (ESP32 box vs PC binary).
// Must come before anything that tests CAP_*: an undefined macro evaluates to
// zero in #if, so a missing include would silently disable WiFi on the box
// rather than failing loudly. Hence the guard immediately below.
#include "platform_caps.h"
#if !defined(CAP_WIFI) || !defined(CAP_GPIO) || !defined(CAP_CIV)
  #error "platform_caps.h did not define the capability flags"
#endif

#include "EEPROM.h"
#define EEPROM_SIZE 360
/*
  0|Byte    1|128
  1|Char    1|A
  2|UChar   1|255
  3|Short   2|-32768
  5|UShort  2|65535
  7|Int     4|-2147483648
  11|Uint    4|4294967295
  15|Long    4|-2147483648
  19|Ulong   4|4294967295
  23|Long64  8|0x00FFFF8000FF4180
  31|Ulong64 8|0x00FFFF8000FF4180
  39|Float   4|1234.1234
  43|Double  8|123456789.12345679
  51|Bool    1|1

  0 APmode
  1-20 SSID1
  22-39 PSWD1
  41 TRXNET_ID       (own NET_ID, 0x00=disabled → device name "705.XX")
  42 TRX2_NET_ID     (peer NET_ID for TRX2 BD slot, 0x00=disabled)
  43 TRX3_NET_ID     (peer NET_ID for TRX3 BD slot, 0x00=disabled)
  44 TRX2_CONN_TYPE (0=TrxNet, 1=CI-V, 2=LAN; 0xff=unprogrammed → default 0x00)
  45-46 TRXNET_PORT  (was MQTT_PORT)
  47 TRX3_CONN_TYPE (0=TrxNet, 1=CI-V, 2=LAN; 0xff=unprogrammed → default 0x00)
  48 TRX2_CIV_ADDR  (CI-V address of TRX2; 0x00/0xff = unset)
  49 TRX3_CIV_ADDR  (CI-V address of TRX3; 0x00/0xff = unset)
  50 TRX1_CONFIG_MARKER (0xa5=current; 0xff=legacy memories.cfg fallback)
  51 TRX1_TRANSPORT  (1=LAN, 2=legacy Bluetooth, 3=CI-V, 4=TrxNet)
  52 TRX1_CIV_ADDR
  53-68 TRX1_LAN_IP (16B including 0xff terminator padding)
  69 FREE            (was HTTP_CAT_PORT)
  70-71 FREE         (was udpPort)
  72-73 FREE         (was udpCatPort)
  74-75 BaudRate
  76-95 SSID2
  97-114 PSWD2
  115-131 TRX1_LAN_USER (17B including 0xff terminator padding)
  132-135 FREE       (was MQTT_TOPIC_RX)
  136 cwIpOnConnect
  137-200 DXC host (64B)
  201-202 DXC port (UShort)
  203-218 DXC callsign (16B)
  219-224 DXC locator (6B)
  225-241 TRX1_LAN_PASSWORD (17B including 0xff terminator padding)
  242-245 FREE       (was TRX2 MQTT root topic)
  246-266 FREE       (was TRX3 MQTT root topic 21B)
  267-287 BT_NAME (21B)
  288 TRXNET_PRIO flag (0xff=unprogrammed → default "OI3 ANT"; 0x01=user set → read string)
  289-359 TRXNET_PRIO priority prefixes string (space-separated, 71B; empty = priority off)

  !! Increment EEPROM_SIZE #define !!
*/

#if defined(BLUETOOTH)
  #include "BluetoothSerial.h"
  #include <esp_bt.h>
#endif
  //#define DEBUG 1
  //#define MIRRORCAT 1
  //#define MIRRORCAT_SPEED 9600
  // CI-V protocol constants and radio state below are shared by every transport
  // (Bluetooth SPP and LAN both feed processCivBuffer), so they compile
  // unconditionally. Only the BluetoothSerial object is Bluetooth-specific.
  #define BROADCAST_ADDRESS    0x00 //Broadcast address
  #define CONTROLLER_ADDRESS   0xE0 //Controller address

  #define START_BYTE           0xFE //Start byte
  #define STOP_BYTE            0xFD //Stop byte

  #define CMD_TRANS_FREQ       0x00 //Transfers operating frequency data
  #define CMD_TRANS_MODE       0x01 //Transfers operating mode data

  #define CMD_READ_FREQ        0x03 //Read operating frequency data
  #define CMD_READ_MODE        0x04 //Read operating mode data

  #define CMD_WRITE_FREQ       0x05 //Write operating frequency data
  #define CMD_WRITE_MODE       0x06 //Write operating mode data

  #define CMD_SEND_CW_MSG      0x17 //Write operating mode data

  #define IF_PASSBAND_WIDTH_WIDE   0x01
  #define IF_PASSBAND_WIDTH_MEDIUM   0x02
  #define IF_PASSBAND_WIDTH_NARROW   0x03

  const uint32_t decMulti[]    = {1000000000, 100000000, 10000000, 1000000, 100000, 10000, 1000, 100, 10, 1};

  #define BAUD_RATES_SIZE 4
  const uint16_t baudRates[BAUD_RATES_SIZE]       = {19200, 9600, 4800, 1200};

  uint8_t  radio_address;     //Transiever address
  uint16_t  baud_rate;        //Current baud speed
  uint32_t readtimeout = 2000;
  // 40, not 12: the GPS position reply (23 00) is 34 bytes on the wire, and both
  // delivery paths drop any frame that does not fit this buffer whole.
  uint8_t  read_buffer[40];   //Read buffer
  // uint8_t  read_buffer_snapshot[12];   //Buffer snapshot
  uint32_t  frequency;        //Current frequency in Hz
  uint32_t  frequencyTmp;        //Current frequency in Hz
  uint32_t  timer;

  const char* mode[] = {"LSB", "USB", "AM", "CW", "FSK", "FM", "WFM", "DV"};
  #define MODE_TYPE_LSB   0x00
  #define MODE_TYPE_USB   0x01
  #define MODE_TYPE_AM    0x02
  #define MODE_TYPE_CW    0x03
  #define MODE_TYPE_RTTY  0x04
  #define MODE_TYPE_FM    0x05
  #define MODE_TYPE_DV    0x17

  char modes[12] = "OFF";
  // btClientConnected stays declared unconditionally: state/status JSON reads it
  // even without Bluetooth (it simply remains false when BT is compiled out).
  volatile bool btClientConnected = false;
#if defined(BLUETOOTH)
  BluetoothSerial CAT;
#endif

short HardwareRev = 99;
const int HWidPin       = 34;  // analog
int HWidValue           = 0;

int pwmChannel          = 0; // Selects channel 0
int frequence           = 1000; // PWM frequency of 1 KHz
int resolution          = 8; // 8-bit resolution, 256 possible values

const int StatusPin     = 5;
const int PowerOnPin    = 4;
long powerTimer         = 0;
bool statusPower        = 0;
const int CIVmutePin    = 16;
bool TrxNeedSet         = 0;
bool TrxSetupDone       = false;
volatile bool btStateBroadcastPending = false;
volatile bool btDisconnectPending = false;
volatile bool btConnectPending = false;

#if defined(WDT)
  // 73 seconds WDT (WatchDogTimer)
  #include <esp_task_wdt.h>
  #define WDT_TIMEOUT 73
  long WdtTimer=0;
#endif

#if defined(WIFI)
  #include <WiFi.h>
  #include <esp_wifi.h>
  #include "esp_coexist.h"
  #include <FS.h>
  #include <LittleFS.h>
  #define HTTP_MAX_DATA_WAIT 1000
  #include <WebServer.h>
  #include <mbedtls/sha1.h>
  #include <lwip/sockets.h>   // raw select() to poll audio-WS writability (never block the loop)
  // Must follow the socket headers above. Gives the two raw-send hot paths one
  // meaning across lwip and Winsock -- see the header for why errno alone is not
  // portable and what it silently breaks.
  #include "net_nonblocking.h"
  // #include <ETH.h>
  // int SsidPassSize = (sizeof(SsidPass)/sizeof(char *))/2; //array size
  // int SelectSsidPass = -1;
  #define wifi_max_try 40             // Number of try
  unsigned long WifiTimer = 0;
  unsigned long WifiReconnect = 5000;
  unsigned long WifiDownSince = 0;        // 0 = station link OK
  bool WifiHardResetDone = false;         // one radio off/on per outage — repeating it wedges the driver
  bool WifiCoexPreferred = false;         // coex arbiter tilted to WiFi for the duration of an outage
  #define WIFI_HARD_RESET_AFTER_MS 10000  // radio off/on cycle when down longer than this
  #define WIFI_RESTART_AFTER_MS    60000  // ESP.restart() when down longer than this
  // Last known AP — reconnect targets channel+BSSID directly, because a full
  // scan often finds nothing while the BT Classic (SPP) link is active (coex).
  int32_t wifiLastChannel = 0;
  uint8_t wifiLastBssid[6];
  bool    wifiLastBssidValid = false;
  String  wifiLastSsid;
  unsigned long webQuietUntil = 0;
  byte ActiveWifiProfile = 0;
  String MACString;

  #include <ESPmDNS.h>
  #include <DNSServer.h>

  const char* ssidAP     = "WIFILT-AP";
  const char* passwordAP = "remoteqth";
  // One name for three lookup paths: the DHCP hostname the router registers in
  // its own DNS (http://wifilt/), the mDNS name (http://wifilt.local) and the AP
  // captive portal. Keeping them identical is the whole point -- the operator
  // types one string no matter which mechanism their network actually supports.
  const char* deviceHostname = "wifilt";
  bool APmode = false;
  // WebServer discards the client before handleClient() returns, so the slow-loop
  // diagnostic can't sample it from outside. Response writes (where stalls to a dead
  // client block the loop) go through this virtual, so capture peer+uri here.
  class DiagWebServer : public WebServer {
  public:
    using WebServer::WebServer;
    IPAddress lastPeer;
    String lastUri;
  protected:
    size_t _currentClientWrite(const char* b, size_t l) override {
      if (_currentClient.connected()) {
        lastPeer = _currentClient.remoteIP();
        lastUri = _currentUri;
      }
      return WebServer::_currentClientWrite(b, l);
    }
  };
  DiagWebServer webServer(80);
  const byte DNS_PORT = 53;
  DNSServer dnsServer;             // captive portal in AP mode
#endif


// uint8_t CwMsg[36] = "";
char CwMsg[37] = "";

#if defined(FSK_KEYING)
  #define FSK_OUT  33                      // TTL LEVEL pin OUTPUT
  #define PTT      32                      // PTT pin OUTPUT
  #define FSK_MARK_LEVEL   LOW             // FSK mark level [LOW/HIGH]
  #define FSK_SPACE_LEVEL  HIGH            // FSK space level [LOW/HIGH]
  #define BaudRateFSK 45.45                   // RTTY baud rate
  #define StopBit  1.5                     // stop bit long
  #define PTTlead  400                     // PTT lead delay ms
  #define PTTtail  200                     // PTT tail delay ms
  int     OneBit = 1/BaudRateFSK*1000;
  boolean d1;
  boolean d2;
  boolean d3;
  boolean d4;
  boolean d5;
  boolean space;
  boolean fig1;
  int     fig2;
  char    ch;
  volatile bool abortFskTransmission = false;
#endif


// TrxNet — P2P telemetry, replaces PubSubClient/MQTT
// TRXNET_ID == 0x00 acts as "disabled" sentinel — net.begin() is not called.
// NOTE: never #define TRXNET_MAX_PENDING/TRXNET_MAX_PEERS here — TrxNet.cpp is
// compiled separately without sketch defines, so the class layout would differ
// between translation units (ODR violation → global memory corruption → boot
// crash in first nvs_open). Library per-board defaults apply (ESP32: 24).
#include <WiFiUdp.h>
#include <TrxNet.h>
#include "icomLanClient.h"      // LAN CI-V transport (alternative to BT)
#include "radio_transport.h"    // shared per-slot transport/capability model
#include "aud1_tx_state.h"      // shared TX-state predicates used by native regression tests
#include "unattended_guard.h"   // shared liveness/arming rules used by native regression tests
#include "unattended_events.h"  // shared event-log formatting used by native regression tests
#include "aud1_ws_parser.h"     // incremental, non-blocking browser WebSocket framing
#include "js8_session.h"        // single-operator lock for the JS8LAN page
// See radio_transport.h's own comment on radioLanLocalControlPort(): 0 means
// "use the real default (50001)", exactly today's behavior on the real
// device and on native/ unless --lan-port-base overrides it.
uint16_t g_lanLocalPortBaseOverride = 0;
IcomLanClient lanClient;
IcomLanClient* secondaryLanClients[2] = {nullptr, nullptr};
bool    lanMode = true;         // compatibility mirror: TRX1 transport == LAN
String  lanRadioIp = "";        // radio IP for LAN mode
String  lanUser = "";           // ICOM network username
String  lanPass = "";           // ICOM network password
uint32_t lanFreqTmp = 0;        // last freq published to TrxNet (change detect)
bool    lanReconnectRequested = false;
uint32_t lanRetryAt = 0;
uint32_t lanBackoff = 3000;

// ---- LAN radio discovery (SETUP page) -------------------------------------
// The scanner and the credential test both need UDP 50001, which the live LAN
// client owns. WiFiUDP sets SO_REUSEADDR, so a second bind succeeds and then
// silently steals the client's control packets -- the live client is therefore
// stopped for the duration and reconnected afterwards, never run alongside.
#include "icom_lan_discovery.h"
IcomLanDiscovery icomScan;
enum IcomScanPhase : uint8_t {
  ISCAN_IDLE, ISCAN_SUSPEND, ISCAN_RUN,
  ISCAN_TEST_SUSPEND, ISCAN_TEST_RUN,
  ISCAN_DONE
};
IcomScanPhase icomScanPhase = ISCAN_IDLE;
bool     icomScanSuspendLan = false;   // gate honoured by the LAN service loops
bool     icomScanLanWasUp = false;     // reconnect afterwards only if we cut it
bool     icomScanFailed = false;       // scan could not start (no station link)
IcomLanClient* icomTestClient = nullptr;

#if defined(WIFILT_NATIVE)
// Called by the native platform layer before a re-exec restart and on process
// shutdown. The ESP32 reboot takes long enough for the radio to expire the old
// session by itself; the native restart is near-instant AND rebinds the same
// fixed local ports 50001-50003, so the new process would answer the dead
// session's keepalive pings and keep that ghost alive on the radio for ever --
// the radio then serves CI-V/audio to the ghost and the fresh login loops on
// "timeout in state". A clean logout here is what the reboot gap does for the
// box.
void wifiltNativeStopRadioSessions() {
  lanClient.stop();
  for (IcomLanClient* client : secondaryLanClients)
    if (client) client->stop();
  if (icomTestClient) icomTestClient->stop();
}
#endif
IPAddress icomTestIp;
String   icomTestUser, icomTestPass;
uint8_t  icomTestCivAddr = 0xA4;
uint8_t  icomTestSlot = 0;             // which TRX slot the tested address belongs to
String   icomTestModel;                // model the radio reported during the test
uint32_t icomTestDeadline = 0;
const char* icomTestResult = "idle";   // idle|running|ok|bad_credentials|no_answer

// ---- AP -> station handoff --------------------------------------------------
// Saving WiFi credentials in AP mode used to end with a blind restart: the
// portal vanished and the operator was left with no address to open. Instead
// the station is brought up alongside the still-running softAP, so the portal
// can show the address the router actually handed out before the AP goes away.
#define LAST_STA_IP_ADDR 132       // EEPROM 132-135, previously MQTT_TOPIC_RX
// One configured WiFi profile as the scan actually saw it on the air.
struct WifiScanPick {
  byte    profile = 0xFF;
  int32_t rssi = -127;
  int32_t channel = 0;
  uint8_t bssid[6] = {0};
  bool    targeted = false;   // false = no scan hit, connect the ordinary way
};
enum WifiTryState : uint8_t { WTRY_IDLE, WTRY_SCAN, WTRY_CONNECTING, WTRY_OK, WTRY_FAILED };
WifiTryState wifiTryState = WTRY_IDLE;
uint32_t  wifiTryDeadline = 0;
String    wifiTrySsid;
const char* wifiTryReason = "";    // not_found | no_connect, when state == failed
WifiScanPick wifiTryCandidates[2]; // profiles to attempt, strongest scan hit first
uint8_t   wifiTryCandidateCount = 0;
uint8_t   wifiTryCandidateIdx = 0;
bool      wifiTryScanSawNothing = false;  // a scan completed and found no configured SSID
IPAddress lastStaIp;               // survives a reboot; 0.0.0.0 when unknown

// The operator's configuration lives on its own flash partition, which no tool
// writes: the installer and both upload scripts touch app0 and the asset
// filesystem only. Before this, every firmware update replaced the filesystem
// that held the radio slots, the LOG/JS8 settings and every TX gain calibration
// -- and each of those calibrations costs a 20 s carrier on the air to measure
// again. `LittleFS` stays the web assets; everything below is on `cfgFS`.
fs::LittleFSFS cfgFS;

static const char* RADIO_CONFIG_PATH = "/radio-config.json";

struct RadioSlotConfig {
  bool enabled;
  RadioTransport transport;
  uint8_t civAddr;
  uint8_t netId;
  String lanIp;
  String lanUser;
  String lanPass;
  // Model the radio reported in its capabilities packet, remembered across
  // reboots. Not operator-editable -- it is an observation, not a setting.
  // WSPR needs it to know whether 100 % of the CI-V power scale means 10 W or
  // 100 W, and without a stored copy that answer disappears with the link.
  String model;
};

RadioSlotConfig radioSlots[3];
bool radioConfigLoaded = false;
bool primarySerialHasData = false;
bool primaryTrxNetHasData = false;
uint32_t secondaryLanRetryAt[2] = {0, 0};
uint32_t secondaryLanBackoff[2] = {3000, 3000};

// ── The LAN radio, wherever the operator put it ───────────────────────────────
// LAN may be assigned to any one of the three slots, and JS8LAN (audio, PTT, TX)
// follows it instead of assuming TRX1. The shared CAT globals (frequency, modes,
// stateTx, meters) belong to TRX1 -- /state, the log page's TRX1 tab, band
// decoder source 1 and the TrxNet publish all read them -- so a LAN radio in
// slot 1 or 2 keeps its own compact snapshot here and the JS8 page asks for it
// with /state?radio=lan. Only one slot can be LAN, hence one snapshot.
struct LanRadioSnapshot {
  uint8_t  slot = 0xFF;           // which slot this snapshot describes
  bool     tx = false;
  uint8_t  filter = 0;
  uint8_t  rfPower = 0;
  bool     rfPowerSeen = false;   // false until the radio answered 14 0A at least once
  uint16_t smeterRaw = 0;
  uint16_t powerMeterRaw = 0;
  // Raw ALC, and a counter that only moves when the radio actually answered
  // 15 13. The browser's gain search cannot tell a fresh reading from the
  // previous one repeated -- and mistaking one for the other makes it step
  // twice on a single observation -- so the sequence, not the value, is what
  // says "this is new". Deliberately absent from /state: it is only meaningful
  // while the browser is keying, and that is exactly when tx-level is flowing.
  uint16_t alcRaw = 0;
  uint32_t alcSeq = 0;
  float    swr = 1.0f;
  float    supplyVolts = 0.0f;
  char     mode[8] = "";          // includes the -D suffix, unlike g_trxMode
};
LanRadioSnapshot lanRadioSnap;
WiFiUDP trxUdp;
TrxNet  net(trxUdp);
char    trxDeviceName[TRXNET_MAX_DEVICE_NAME];
bool    trxNetEnabled = false; // set true after net.begin() succeeds

// TrxNet priority prefixes — protect these peers when the peer table fills.
// EEPROM 288 flag + 289-359 string. Limits: 8 tokens x 8 chars (see setPriorityPrefixes()).
#define TRXNET_PRIO_MAX_TOKENS 8
#define TRXNET_PRIO_MAX_TOKLEN 8
#define TRXNET_PRIO_STR_MAX    71   // 8*8 + 7 separators
String      TRXNET_PRIO = "OI3 ANT";                 // canonical (normalized) value for UI/save
char        trxPrioBuf[TRXNET_PRIO_STR_MAX + 1];     // tokenized: spaces -> '\0' (library holds a pointer)
const char* trxPrioPtrs[TRXNET_PRIO_MAX_TOKENS];     // pointers into trxPrioBuf, valid for object lifetime
uint8_t     trxPrioCount = 0;

// TrxNet pending state — set in callbacks, processed in loop()
volatile uint32_t trxPendingHz   = 0;
volatile uint8_t  trxPendingMode = 0; // CI-V byte
volatile bool     trxFreqPending = false;
volatile bool     trxModePending = false;

int incomingByte = 0;   // for incoming serial data

#if defined(WIFI)
  WiFiServer dxcRawServer(82);
  WiFiClient DxcTelnetClient;
  WiFiClient DxcWsClient;
  WiFiServer audioWsServer(83);        // AUD1 WebSocket: timed RX/TX audio for DATA page
  WiFiClient AudioWsClient;
  uint32_t audioRxPackets = 0;         // counts forwarded audio datagrams per WS session
  // RX-audio health, per WS session. The serial log used to say nothing between
  // "rx audio flowing" and the next reconnect, so every dropout investigation
  // started from a log that could not distinguish "firmware starved the stream"
  // from "WiFi ate the packets" -- these feed the once-a-minute AUD health line.
  uint32_t audioSeqGapEvents = 0;      // holes that reached the browser as silence
  uint32_t audioSeqGapPackets = 0;     // radio datagrams those holes cost (20 ms each)
  uint32_t audioWsDropFrames = 0;      // AUD1 frames dropped because wsOut was full
  uint32_t audioHealthLastMs = 0;      // last AUD health line
  uint8_t  audioTxBuf[1400];           // coalesce ~20ms radio packets into fewer WS frames
  size_t   audioTxLen = 0;
  // Outgoing browser-WS byte ring. RX audio is enqueued here (even from the LAN
  // UDP receive path) and drained with non-blocking ::send, so no WS write ever
  // blocks the cooperative loop and the LAN-UDP owner never performs a socket
  // send. ~2 s at 8 kB/s absorbs transient browser/WiFi stalls before dropping.
  // Heap-allocated in setup() — too large for the static DRAM (.bss) segment.
  static const size_t WS_OUT_SIZE = 16384;
  uint8_t* wsOut = nullptr;
  size_t   wsOutHead = 0, wsOutTail = 0, wsOutLen = 0;
  bool     audioTxKeyed = false;       // M3: PTT keyed for browser-sourced TX audio
  bool     audioPttOffPending = false; // desired OFF not yet submitted to healthy CI-V
  uint32_t audioPttRetryAt = 0;
  uint32_t audioTxLastMs = 0;          // last TX audio/keep-alive — dead-man un-key timer
  uint32_t audioStreamId = 0;          // changes for every WebSocket media epoch
  uint32_t audioRxSequence = 0;
  uint64_t audioRxFirstSample = 0;
  bool audioRxFirst = true;
  bool audioRxDiscontinuity = false;
  bool audioRadioSequenceValid = false;
  uint16_t audioRadioExpectedSequence = 0;

  Aud1TxState aud1TxState = AUD1_TX_IDLE;
  static const size_t AUD1_TX_RING_SIZE = IcomLanAudioTx::QUEUE_CAPACITY;
  size_t aud1TxUsed = 0;                    // atomic snapshot mirror for UI/state JSON
  uint32_t aud1TxId = 0, aud1TxExpectedSequence = 0, aud1TxExpectedPackets = 0;
  uint32_t aud1TxReceivedPackets = 0, aud1TxTargetMs = 0;
  uint32_t aud1TxDeadlineMs = 0, aud1TxPrebufferSamples = 0;
  uint64_t aud1TxExpectedSample = 0, aud1TxTotalSamples = 0, aud1TxConsumedUlaw = 0;
  bool aud1TxLastSeen = false;
  Aud1WsParser aud1WsParser;
  UnattendedGuard unattendedGuard;
  Js8Session js8Session;                   // which browser currently owns JS8LAN
  static const char* UNATTENDED_LOG_PATH = "/unattended.log";
  // Deferred unattended-log ring. unattendedLogEvent() is called from the audio
  // hot path (aud1TxAbort/aud1TxTick/aud1HandleControl); a synchronous LittleFS
  // append+rotate there is a multi-100 ms flash stall that can miss the very next
  // JS8 slot. Events are formatted into this RAM ring instead and flushed to flash
  // only from loop() while no TX is imminent (unattendedLogFlush). Heap-allocated
  // like wsOut; if malloc fails, the hot path records an overflow marker and
  // still never falls back to a synchronous flash write during TX.
  static const size_t UNA_LOG_QUEUE_SIZE = 2048;   // ~17 lines of <=120 B
  uint8_t* unaLogQueue = nullptr;
  size_t   unaLogHead = 0, unaLogTail = 0, unaLogLen = 0;
  bool     unaLogOverflow = false;                 // oldest lines dropped since last flush
  // MSG BOX: store-and-forward mail, unread mail for the operator and our own
  // deferred outgoing messages, one typed record per line. Decision 10 keeps it
  // here rather than in the tab so it survives a reload, a different computer
  // and a cleared browser cache, and can be read from a phone. 96 messages x
  // ~120 chars fits well inside the 256 KiB runtime reserve the deployment gate
  // keeps free.
  static const char* MSGBOX_PATH = "/msgbox.jsonl";
  // Pre-type file. Read once so mail survives the upgrade, then removed; the
  // browser is what knows how to tell the old record kinds apart.
  static const char* MSGBOX_LEGACY_PATH = "/inbox.jsonl";
  static const size_t MSGBOX_MAX_BYTES = 24576;
  bool lanLinkWasUp = false;               // LAN link-up edge for the PTT safety un-key
  uint32_t aud1TxLevelNextMs = 0;          // B3: periodic TX buffer level while streaming
  // Survives a WDT/panic reset (not power loss) so a reset that happened with
  // the radio keyed is reportable instead of silent.
  RTC_NOINIT_ATTR uint32_t rtcPttWasKeyed;
  static const size_t AUD1_WS_RX_BYTE_BUDGET = 32768; // yield even when browser continuously streams
  static const uint32_t AUD1_WS_SLOT_BACKLOG_GRACE_MS = 100;
  String DxcHost = "";
  uint16_t DxcPort = 7300;
  IPAddress DxcHostIp;                // cached resolve — hostByName blocks the loop for seconds
  String DxcHostResolved = "";        // host the cache belongs to
  #define DXC_CONNECT_TIMEOUT_MS 1500
  String DxcCallsign = "";
  String DxcLocator = "";

  static const char* LOG_CONFIG_PATH = "/log-config.json";
  static const size_t LOG_CONFIG_MAX_BYTES = 2048;

  // Measured ALC knees, one entry per model|band|percent. Deliberately opaque
  // to the firmware: it serves the file and overwrites it, and never parses a
  // byte of it. The schema belongs to the browser, which is the only party that
  // can decide what a calibration means -- and a parser here would be a second
  // opinion about it, needing RAM, a version field and a migration path for a
  // table the radio itself has no use for.
  //
  // Firmware-side rather than in localStorage because the knee is a property of
  // the station -- radio, band, power -- not of the browser that measured it. An
  // unattended beacon started from a phone must not transmit at a level that was
  // only ever calibrated on the shack PC.
  static const char* TXGAIN_CONFIG_PATH = "/txgain.json";
  static const size_t TXGAIN_MAX_BYTES = 6144;   // ~40 entries; a full band plan
  // Mercury's OWN gain table, deliberately a separate file from JS8/WSPR's
  // (docs/mercury-implementace.md ch.8): the same audio "gain" scalar means a
  // different real drive level depending on the waveform's PAPR -- a tone
  // (JS8/WSPR's TUNE, ~0 dB PAPR) vs. a real Mercury OFDM burst (measured
  // ~7.5 dB even after freedv's own clipping). Reusing one entry for the
  // other would either leave Mercury needlessly quiet or, the more dangerous
  // direction, let data overdrive ALC at a gain JS8/WSPR proved clean.
  static const char* MERCURY_TXGAIN_CONFIG_PATH = "/mercury-txgain.json";
  static const size_t MERCURY_TXGAIN_MAX_BYTES = 6144;
  // The JS8 and WSPR operating profile: speed, TX offset, heartbeat interval,
  // groups, the 24 h band schedule, the RF power percent. It used to live in
  // each browser's localStorage, which meant a second tablet ran the station
  // with a different schedule and no heartbeat and nothing said so. Same design
  // as the calibration table -- a blob the firmware stores and never reads into.
  static const char* JS8_CONFIG_PATH = "/js8-config.json";
  static const size_t JS8_CONFIG_MAX_BYTES = 4096;   // measured: 2041 B with a full 48-slot schedule

  // In-memory cache of log-config.json fields, served by /log-config.
  String g_lcTrx1Label = "TRX1";   // replaced by the radio's own model once known
  String g_lcTrx2Label = "TRX2";
  String g_lcTrx3Label = "TRX3";
  String g_lcBlockedDxcc = "Russia\nBelarus\nKaliningrad";

  // TrxNet peer cache for TRX2 (index 0) and TRX3 (index 1) — written by onHz/onMode callbacks
  static volatile long g_trxFreq[2]    = {0, 0};
  static char          g_trxMode[2][8] = {"USB", "USB"};
  static volatile bool g_trxHasData[2] = {false, false};

// Band Decoder
#define BD_CLOCK_PIN  15
#define BD_LATCH_PIN  13
#define BD_DATA_PIN   14
#define BD_ROWS       16
#define BD_CONFIG_PATH "/bd-config.json"

struct BdRow {
    uint32_t fMin;
    uint32_t fMax;
    uint16_t outputs;
};

BdRow     bdRows[BD_ROWS];
int       bdSource         = 1;
uint16_t  bdCurrentOutputs = 0;
bool      bdEnabled        = false;

  bool DxcTelnetStatus = false;
  bool DxcWsStatus = false;
  bool DxcTelnetLoginPending = false;
  unsigned long DxcReconnectTimer = 0;
#endif

#if defined(WIFI)
typedef mbedtls_sha1_context SHA1_CTX;

extern "C" void SHA1Init(SHA1_CTX* context){
  mbedtls_sha1_init(context);
  mbedtls_sha1_starts_ret(context);
}

extern "C" void SHA1Update(SHA1_CTX* context, const unsigned char* data, uint32_t len){
  mbedtls_sha1_update_ret(context, data, len);
}

extern "C" void SHA1Final(unsigned char digest[20], SHA1_CTX* context){
  mbedtls_sha1_finish_ret(context, digest);
  mbedtls_sha1_free(context);
}
#endif

#if defined(WIFI)
  const uint8_t CW_MEMORY_COUNT = 4;
  const uint8_t FREQ_MEMORY_COUNT = 10;
  const size_t CW_MEMORY_MAX_LEN = 30;
  const size_t FREQ_MEMORY_MAX_LEN = 20;
  const uint8_t CIV_ADDRESS_DEFAULT = 0xA4;
  const char *MEMORY_CONFIG_PATH = "/memories.cfg";
  const uint8_t PRIMARY_RADIO_CONFIG_MARKER = 0xA5;
  const int PRIMARY_RADIO_MARKER_ADDR = 50;
  const int PRIMARY_RADIO_TRANSPORT_ADDR = 51;
  const int PRIMARY_RADIO_CIV_ADDR = 52;
  const int PRIMARY_RADIO_LAN_IP_ADDR = 53;
  const int PRIMARY_RADIO_LAN_USER_ADDR = 115;
  const int PRIMARY_RADIO_LAN_PASS_ADDR = 225;
  // BT CAT poll cadence (used by pollRadio) — slow when idle, fast while the
  // CAT page holds it via /state?fast=1
  #define CAT_POLL_MS       1000  // slow: freq poll interval
  #define CAT_MODE_EVERY    2     // slow: mode polled every N-th freq tick (2 s)
  #define AUX_POLL_MS       160   // slow: aux round-robin step (each of 10 items every 1.6 s)
  #define CAT_POLL_FAST_MS  200   // fast: freq+mode poll interval (original cadence)
  #define AUX_POLL_FAST_MS  80    // fast: aux round-robin step
  #define CAT_FAST_HOLD_MS  3000  // fast mode lingers this long after the last ?fast=1 poll
  #define CAT_POLL_OUTAGE_MS 3000 // WiFi outage: freq-only poll — BT must go near-silent
                                  // so the SPP link can sniff and WiFi can re-associate
  unsigned long catFastUntil = 0;
  String setupSsidErr = "";
  String setupPswdErr = "";
  String setupSsid2Err = "";
  String setupPswd2Err = "";
  String setupCivAddrErr = "";
  bool setupSaveOk = false;
  String transceiverType = "ICOM-LAN";  // LAN is the recommended default (BT deprecated)
  uint8_t configuredCivAddress = CIV_ADDRESS_DEFAULT;
  String cwMemoryText[CW_MEMORY_COUNT];
  String freqMemoryText[FREQ_MEMORY_COUNT];
  portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;

  // State variables updated from CIV frames, served via /state polling
  uint32_t stateRitRaw = 0;
  uint8_t stateFilter = 1;
  uint8_t stateAfGain = 0;
  uint8_t stateKeySpeed = 138;
  // 205 is a fabricated default, not a reading. Pages that turn the level into
  // watts must not present it as one, so say plainly whether the radio has ever
  // answered 14 0A -- the snapshot below carries the same flag for TRX2/TRX3,
  // where the equally fabricated default is 0.
  uint8_t stateRfPower = 205;
  bool stateRfPowerSeen = false;
  bool stateTx = false;
  uint8_t statePreampMode = 0;  // 0=OFF, 1=AMP, 2=ATT
  uint8_t stateAttOn = 0;       // internal: tracks ATT separately for combine logic
  uint8_t stateVoxMode = 0;
  uint8_t stateRfGain = 0;      // 0x14 0x02 RF gain, needed to snapshot/restore around CW IP announce
  uint8_t stateModeId = 0x03;   // numeric operating-mode id (0x03=CW), for exact mode restore
  bool    stateDataMode = false;// DATA sub-mode flag, so USB-D/etc. restore correctly
  float stateSupplyVolts = 0.0f;
  float stateSwr = 1.0f;
  uint32_t stateSmeterRaw = 0;
  uint32_t statePowerMeterRaw = 0;
  // TRX1's ALC, with the same freshness counter as the snapshot's. Two copies
  // because a LAN radio on TRX1 feeds the shared CAT globals and never the
  // snapshot -- see lanCivFrameRoute(), which returns early for slot 0.
  uint32_t stateAlcRaw = 0;
  uint32_t stateAlcSeq = 0;

  // civ.read: the one CI-V reply a page asked for, kept as RAW HEX. Nothing here
  // decodes it -- the same discipline as /txgain.json, which this firmware stores
  // and never parses. A settings value like 1A 05 01 17 is BCD on one model and
  // an enumeration on the next, so the only honest place for the meaning is the
  // page that asked. Zero RAM for a parser, and no model knowledge in C++.
  //
  // Absence is the answer for an address the radio does not have: no reply means
  // civReadSeq never moves, and the caller reports "the radio did not confirm
  // that address" instead of writing to it. See docs/tx-audio-gain-plan-*.md.
  // 32 covers the longest reply a page has asked for so far: 23 00 MY position,
  // cmd + sub + 27 data bytes = 29.
  static const size_t CIV_READ_MAX = 32;
  uint8_t  civReadPrefix[CIV_READ_MAX] = {0};   // cmd + subaddress bytes to match
  uint8_t  civReadPrefixLen = 0;
  uint8_t  civReadReply[CIV_READ_MAX] = {0};   // cmd + payload of the matching frame
  uint8_t  civReadReplyLen = 0;
  uint32_t civReadSeq = 0;
  uint32_t civReadAtMs = 0;

  // GPS position from the radio -- CI-V 23 00 (MY position, read-only) and 23 01
  // (GPS Select), polled by gpsPollTick() on the slot the JS8 pages drive. Support
  // is probed, never configured: three unanswered 23 00 after link-up mean "this
  // model has no GPS" until the next (re)connect, so /state can omit the fields
  // entirely and a page can tell "no GPS on this radio" from "waiting for a fix".
  //
  // Freshness is "the UTC stamp inside the reply moved between reads", never a
  // comparison against anyone's clock -- the tablet running the page may be
  // minutes off NTP and the radio's stamp would still be honest. The first reply
  // after (re)connect deliberately does not count as movement: a frozen
  // last-known position must not unlock the position-beacon TX for even one poll.
  enum GpsSupport : uint8_t { GPS_UNKNOWN = 0, GPS_SUPPORTED, GPS_UNSUPPORTED };
  GpsSupport gpsSupport = GPS_UNKNOWN;
  uint8_t  gpsProbesSent = 0;
  uint8_t  gpsSel = 0;              // 23 01: 00=OFF, 01=GPS, 03=Manual
  char     gpsGrid[9] = "";         // 8-char Maidenhead locator, "" = no position yet
  uint8_t  gpsStamp[7] = {0};       // BCD UTC yyyymmddHHMMSS from the last 23 00
  uint8_t  gpsData[27] = {0};       // the full 23 00 data block, decoded on demand by /gps
  bool     gpsDataSeen = false;
  bool     gpsStampSeen = false;
  uint32_t gpsStampChangedMs = 0;   // millis() of the last stamp advance, 0 = never
  uint32_t gpsPosSentMs = 0;
  uint32_t gpsSelSentMs = 0;
  bool     gpsSelAsked = false;     // first 23 01 goes right after the probe succeeds
  bool     gpsWasLinked = false;

  String requestArg(const char *name);
  bool requestHasArg(const char *name);
  String trimMemoryValue(const String &value, size_t maxLen);
  bool parseHexByteString(const String &value, uint8_t &outValue);
  void loadMemoryConfig(void);
  bool saveMemoryConfig(void);
  bool hasPrimaryRadioConfig(void);
  void loadPrimaryRadioConfig(void);
  bool savePrimaryRadioConfig(void);
  void initLegacyRadioSlots(void);
  bool loadRadioConfig(void);
  bool saveRadioConfig(void);
  void syncLegacyRadioGlobals(void);
  bool radioSlotConnected(uint8_t slot);
  bool radioSlotSetUp(uint8_t slot);
  bool stationRadioSetUp(void);
  void radioSlotSetFrequencyState(uint8_t slot, uint32_t freq);
  void radioSlotSetModeState(uint8_t slot, const char *mode);
  IcomLanClient* radioLanClient(uint8_t slot);
  bool beginRadioLanClient(uint8_t slot);
  void secondaryLanClientsLoop(void);
  uint8_t lanRadioSlotIndex(void);
  String defaultTrxLabel(uint8_t slot);
  void adoptModelAsLabelIfUnset(uint8_t slot);
  IcomLanClient* lanRadioClient(void);
  bool lanRadioConnected(void);
  bool lanRadioSendCommand(const uint8_t *body, size_t len);
  bool lanRadioSendPriorityCommand(const uint8_t *body, size_t len, IcomLanClient::CivPriority priority);
  void lanRadioAudioService(IcomLanClient *client);
  void lanRadioCivSnapshot(const uint8_t *frame, size_t len);
  void lanCivFrameRoute(uint8_t slot, const uint8_t *frame, size_t len);
  String jsonEscape(const String &value);
  String configJsonEscape(const String &s);
  String civFrameToHex(const uint8_t *frame, size_t frameLen);
  uint32_t decodeCivFrequencyBytes(const uint8_t *bytes, size_t byteCount);
  uint32_t decodeCivBcdBytes(const uint8_t *bytes, size_t byteCount);
  String decodeModeName(uint8_t modeId);
  bool catWriteFrame(const uint8_t *frame, size_t frameLen, bool broadcastTx);
  bool catWriteFrameSlot(uint8_t slot, const uint8_t *frame, size_t frameLen);
  void setModesText(const char *value);
  void copyModesText(char *dest, size_t destSize);
  bool applyModeState(uint8_t modeId, bool dataMode);
  String extractJsonString(const String &json, const char *key);
  String extractJsonObject(const String &json, const char *key);
  bool extractJsonBool(const String &json, const char *key, bool defaultValue);
  bool parseHexPayload(const String &hex, uint8_t *buffer, size_t &bufferLen, size_t maxLen);
  bool parseModeId(const String &modeName, uint8_t &modeId);
  uint8_t parseFilterWidth(const String &filterName);
  size_t buildSimpleCatFrame(uint8_t command, const uint8_t *payload, size_t payloadLen, uint8_t *frame, size_t frameMaxLen);
  size_t buildSetFrequencyFrame(uint32_t freqHz, uint8_t *frame, size_t frameMaxLen);
  size_t buildSetModeFrame(uint8_t modeId, uint8_t modeWidth, uint8_t *frame, size_t frameMaxLen);
  size_t buildReadQuickSplitFrame(uint8_t *frame, size_t frameMaxLen);
  void buildStateJson(char *buf, size_t bufSize, bool lanView);
  void handleGetState(void);
  void handleSetupData(void);
  void handleTrxNetPeers(void);
  void handleWebServerLoop(void);
  bool handleFileFromSPIFFS(const String &path);
  void handlePostCmd(void);
  void handleSet(void);
  void renderSetupPage(void);
  void resetSetupMessages(void);
  void setupWebServer(void);
  void handleConfigDownload(void);
  void handleConfigUpload(void);
  void handleGetLogConfig(void);
  void handlePostLogConfig(void);
  void handleGetJs8Config(void);
  void handlePostJs8Config(void);
  void handleGetIdentity(void);
  void handlePostIdentity(void);
  void handleGetTxGain(void);
  void handlePostTxGain(void);
  void handleGetMercuryTxGain(void);
  void handlePostMercuryTxGain(void);
  void handleGetCivRead(void);
  uint16_t aprsisPasscode(const String &call);
  bool aprsisFieldSafe(const String &value);
  String aprsisCleanCall(const String &call);
  String aprsisSourceCall(const String &call);
  bool aprsisGridToAprs(const String &grid, String &latOut, String &lonOut);
  uint32_t aprsisHashLine(const String &line);
  void aprsisAgeMinutes(void);
  uint16_t aprsisSentLastHour(void);
  uint32_t aprsisDuplicateOf(uint32_t hash);
  void aprsisRememberSent(uint32_t hash, uint32_t seq);
  bool aprsisBackoffActive(void);
  void aprsisNoteConnectFailure(void);
  void aprsisLoop(void);
  void handleAprsisSpot(void);
  void handleAprsisStatus(void);
  void civReadArm(const uint8_t *prefix, size_t prefixLen);
  void civReadCapture(const uint8_t *frame, size_t len);
  uint8_t gpsTargetSlot(void);
  void gpsCivCapture(uint8_t slot, const uint8_t *frame, size_t len);
  void gpsPollTick(void);
  void handleGetGps(void);
  void handleOi3State(void);
  void handleOi3Send(void);
  void handleOi3SetHz(void);
  void TrxNetLoop(void);
  void onTrxHz(const char* from, const uint8_t* data, size_t len);
  void onTrxMode(const char* from, const uint8_t* data, size_t len);
  void onTrxSetHz(const char* from, const uint8_t* data, size_t len);
  static const char* trxnetModeToString(uint8_t civMode);
  void lanSecondaryCivFrameHandler(uint8_t slot, const uint8_t *frame, size_t len);
  static void civSend(uint8_t toAddr, const uint8_t* body, size_t bodyLen);
  void DxcLoop(void);
  void dxcHandleRawClient(void);
  bool DxcConfigReady(void);
  void DxcDisconnectTelnet(void);
  void DxcDisconnectWebSocket(void);
  void DxcRequestReconnect(void);
  void DxcUpdateTelnetStatus(bool connected, bool forceSend = false);
  void DxcSendTelnetStatus(void);
  bool DxcConnectTelnet(void);
  bool WiFiStationReady(void);
  // Was declared with one parameter while the definition (below) takes two, so
  // this prototype described a function that does not exist. The Arduino
  // builder hid it by generating the correct prototype above this one; a call
  // with a single argument would have compiled and then failed at link time.
  void WiFiRetryActiveProfile(const char *reason, bool hardReset);

  // ---------------------------------------------------------------------------
  // Prototypes the Arduino builder used to generate for us.
  //
  // The IDE preprocesses .ino files and inserts a prototype for every function
  // before first use, so the sketch can call things defined further down. The
  // native build compiles this same file as plain C++ with no such step, so the
  // prototypes are written out here. They are inert for the ESP32 build --
  // identical to what the builder would have produced -- and they make the file
  // valid C++ on its own, which is worth having regardless of the port.
  // ---------------------------------------------------------------------------
  void    APcliAlert();
  void    ApplyStaIdentity();
  void    chTable();
  void    civPollTick();
  void    civWriteFreq(uint8_t addr, uint32_t hz);
  uint8_t collectVisibleWifiProfiles(int found, WifiScanPick out[2]);
  void    ConnectWiFiAlternating();
  void    EnterChar();
  void    icomScanTick();
  String  IntToTenString(int NR);
  void    lanClientLoop();
  void    ListCommands();
  void    loadLastStaIp();
  void    NetworkIdentityLoop();
  byte    NextWifiProfile(byte profile);
  void    printFrequency(void);
  void    printMode(void);
  void    print_wifi_error();
  void    processCatMessages();
  bool    radioLinkUp();
  void    radioModelLearnTick();
  bool    radioSetFrequency(uint32_t freqHz);
  void    runLanCivTest();
  void    saveLastStaIp(IPAddress ip);
  bool    searchRadio();
  void    sendCatRequest(uint8_t requestCode);
  bool    sendCW();
  void    sendFsk();
  void    serialPump();
  void    SplitString(String ORIGINAL, String* SplitStrFreq);
  void    StartMdns();
  byte    stringToByte(String str);
  void    Watchdog();
  bool    WifiProfileConfigured(byte profile);
  String  WifiProfilePSWD(byte profile);
  String  WifiProfileSSID(byte profile);
  void    wifiTryTick();

  // Defined static, so the prototypes must match or they declare a second,
  // externally-linked function that is never defined.
  static void statusFlashTick();
  static bool trxIsPriorityName(const char* name);
  bool DxcSendWebSocketFrame(uint8_t opcode, const uint8_t* payload, size_t length);
  bool DxcSendWebSocketText(const char* text);
  bool DxcSendWebSocketText(const String& text);
  bool DxcHandleWebSocketUpgrade(WiFiClient& webClient, const String& request);
  void DxcHandleWebSocketClient(void);
  void DxcHandleTelnetClient(void);
  String ExtractHttpHeader(const String& request, const String& headerName);
  String DxcComputeWebSocketAccept(const String& secKey);
  String Base64Encode(const uint8_t* data, size_t length);
  bool AudioSendBinary(const uint8_t* payload, size_t length);
  bool AudioSendText(const String& text);
  void wsRingReset(void);
  void audioDrainWs(void);
  void audioFlush(void);
  void audioPttOn(void);
  void audioPttOff(void);
  void audioPttSafetyOnLink(void);
  void audioPttSafetyRetryTick(void);
  void unattendedLogEvent(uint8_t type, const String& detail);
  void unattendedLogEnqueue(const char* line, size_t n);
  void unattendedLogFlush(void);
  bool txCriticalNow(void);
  bool txRealtimeNow(void);
  void handleUnattendedGet(void);
  void handleUnattendedPost(void);
  void handleUnattendedLog(void);
  void js8SessionRespond(Js8SessionResult result, const String& token);
  String js8SessionRequestToken(void);
  void handleJs8SessionGet(void);
  void handleJs8SessionClaim(void);
  void handleJs8SessionPing(void);
  void handleJs8SessionRelease(void);
  void handleMsgboxGet(void);
  void handleMsgboxPost(void);
  void aud1TxAbort(const String& reason, bool notify = true);
  void aud1TxTick(bool deferPrebufferMiss = false);
  void AudioDisconnectWs(void);
  bool AudioHandleWsUpgrade(WiFiClient& webClient, const String& request, const String& token);
  void AudioHandleWsClient(void);
  void audioHandleRawClient(void);
#endif

//-------------------------------------------------------------------------------------------------------

#if defined(WIFI)
String requestArg(const char *name){
  return webServer.arg(name);
}

bool requestHasArg(const char *name){
  return webServer.hasArg(name);
}

String trimMemoryValue(const String &value, size_t maxLen){
  String trimmed = value;
  trimmed.trim();
  if (trimmed.length() > maxLen) {
    trimmed = trimmed.substring(0, maxLen);
    trimmed.trim();
  }
  return trimmed;
}

bool parseHexByteString(const String &value, uint8_t &outValue){
  String normalized = value;
  normalized.trim();
  normalized.toUpperCase();
  if (normalized.startsWith("0X")) {
    normalized = normalized.substring(2);
  }
  if (normalized.length() == 0 || normalized.length() > 2) {
    return false;
  }

  char buffer[3] = {0, 0, 0};
  normalized.toCharArray(buffer, sizeof(buffer));
  char *endPtr = nullptr;
  long parsed = strtol(buffer, &endPtr, 16);
  if (endPtr == nullptr || *endPtr != '\0' || parsed < 0 || parsed > 255) {
    return false;
  }
  outValue = (uint8_t)parsed;
  return true;
}

void loadMemoryConfig(void){
  for (uint8_t i = 0; i < CW_MEMORY_COUNT; i++) {
    cwMemoryText[i] = "";
  }
  for (uint8_t i = 0; i < FREQ_MEMORY_COUNT; i++) {
    freqMemoryText[i] = "";
  }

  if (!cfgFS.exists(MEMORY_CONFIG_PATH)) {
    return;
  }

  File file = cfgFS.open(MEMORY_CONFIG_PATH, FILE_READ);
  if (!file) {
    return;
  }

  for (uint8_t i = 0; i < CW_MEMORY_COUNT && file.available(); i++) {
    cwMemoryText[i] = trimMemoryValue(file.readStringUntil('\n'), CW_MEMORY_MAX_LEN);
  }
  for (uint8_t i = 0; i < FREQ_MEMORY_COUNT && file.available(); i++) {
    freqMemoryText[i] = trimMemoryValue(file.readStringUntil('\n'), FREQ_MEMORY_MAX_LEN);
  }

  if (file.available()) {
    String configuredType = trimMemoryValue(file.readStringUntil('\n'), 16);
    if (configuredType == "IC-7610-CI-V" || configuredType == "TRXNET") {
      transceiverType = configuredType;
    } else {
      // Bluetooth transport removed: any stored non-CIV value falls back to LAN.
      transceiverType = "ICOM-LAN";
    }
  }

  if (file.available()) {
    uint8_t parsedAddress = CIV_ADDRESS_DEFAULT;
    if (parseHexByteString(file.readStringUntil('\n'), parsedAddress)) {
      configuredCivAddress = parsedAddress;
    }
  }

  // LAN transport config (backward compatible: absent lines -> empty)
  if (file.available()) lanRadioIp = trimMemoryValue(file.readStringUntil('\n'), 15);
  if (file.available()) lanUser    = trimMemoryValue(file.readStringUntil('\n'), 16);
  if (file.available()) lanPass    = trimMemoryValue(file.readStringUntil('\n'), 16);

  lanMode = (transceiverType == "ICOM-LAN");

  file.close();
}

bool saveMemoryConfig(void){
  File file = cfgFS.open(MEMORY_CONFIG_PATH, "w");
  if (!file) {
    Serial.println("LFS | cannot open /memories.cfg for writing"
                   " used=" + String(LittleFS.usedBytes()) +
                   " total=" + String(LittleFS.totalBytes()));
    return false;
  }

  size_t expectedBytes = 0;
  size_t writtenBytes = 0;
  auto writeLine = [&](const String &line) {
    expectedBytes += line.length() + 2;  // println uses CRLF
    writtenBytes += file.println(line);
  };

  for (uint8_t i = 0; i < CW_MEMORY_COUNT; i++) {
    writeLine(trimMemoryValue(cwMemoryText[i], CW_MEMORY_MAX_LEN));
  }
  for (uint8_t i = 0; i < FREQ_MEMORY_COUNT; i++) {
    writeLine(trimMemoryValue(freqMemoryText[i], FREQ_MEMORY_MAX_LEN));
  }
  writeLine(transceiverType);
  String civAddressLine;
  if (configuredCivAddress < 16) {
    civAddressLine = "0";
  }
  civAddressLine += String(configuredCivAddress, HEX);
  writeLine(civAddressLine);
  writeLine(lanRadioIp);
  writeLine(lanUser);
  writeLine(lanPass);

  file.flush();
  size_t fileBytes = file.size();
  bool ok = writtenBytes == expectedBytes && fileBytes == expectedBytes;
  file.close();
  if (!ok) {
    Serial.println("LFS | write failed for /memories.cfg expected=" +
                   String(expectedBytes) + " written=" + String(writtenBytes) +
                   " size=" + String(fileBytes) +
                   " used=" + String(LittleFS.usedBytes()) +
                   " total=" + String(LittleFS.totalBytes()));
  }
  return ok;
}

// Parse log-config.json into the g_lc* cache that /log-config serves.
void loadLogConfigVars(void){
  if (!cfgFS.exists(LOG_CONFIG_PATH)) return;
  File f = cfgFS.open(LOG_CONFIG_PATH, "r");
  if (!f) return;
  String j = f.readString();
  f.close();
  j.trim();
  if (!j.startsWith("{")) return;

  String v;
  v = extractJsonString(j, "trx1Label"); if (v.length() > 0) g_lcTrx1Label = v;
  v = extractJsonString(j, "trx2Label"); if (v.length() > 0) g_lcTrx2Label = v;
  v = extractJsonString(j, "trx3Label"); if (v.length() > 0) g_lcTrx3Label = v;
  if (j.indexOf("\"blockedDxcc\"") >= 0) g_lcBlockedDxcc = extractJsonString(j, "blockedDxcc");
}

String jsonEscape(const String &value){
  String out;
  out.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); i++) {
    char c = value.charAt(i);
    switch (c) {
      case '\\': out += "\\\\"; break;
      case '"': out += "\\\""; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out += c; break;
    }
  }
  return out;
}

String civFrameToHex(const uint8_t *frame, size_t frameLen){
  String hex;
  hex.reserve(frameLen * 2);
  for (size_t i = 0; i < frameLen; i++) {
    if (frame[i] < 16) {
      hex += "0";
    }
    hex += String(frame[i], HEX);
  }
  return hex;
}

uint32_t decodeCivFrequencyBytes(const uint8_t *bytes, size_t byteCount){
  uint32_t value = 0;
  for (size_t i = 0; i < byteCount; i++) {
    size_t src = byteCount - 1 - i;
    value += (bytes[src] >> 4) * decMulti[i * 2];
    value += (bytes[src] & 0x0F) * decMulti[i * 2 + 1];
  }
  return value;
}

uint32_t decodeCivBcdBytes(const uint8_t *bytes, size_t byteCount){
  uint32_t value = 0;
  for (size_t i = 0; i < byteCount; i++) {
    value = value * 100 + ((bytes[i] >> 4) * 10) + (bytes[i] & 0x0F);
  }
  return value;
}

// LSB-first variant used for RIT (bytes[0] = least significant pair)
uint32_t decodeCivBcdBytesLsb(const uint8_t *bytes, size_t byteCount){
  uint32_t value = 0;
  uint32_t mult = 1;
  for (size_t i = 0; i < byteCount; i++) {
    value += (((bytes[i] >> 4) * 10) + (bytes[i] & 0x0F)) * mult;
    mult *= 100;
  }
  return value;
}

String decodeModeName(uint8_t modeId){
  switch (modeId) {
    case 0x00: return "LSB";
    case 0x01: return "USB";
    case 0x02: return "AM";
    case 0x03: return "CW";
    case 0x04: return "RTTY";
    case 0x05: return "FM";
    case 0x06: return "WFM";
    case 0x07: return "CW-R";
    case 0x08: return "RTTY-R";
    case 0x17: return "DV";
    default: return "UNK";
  }
}

String decodeFilterName(uint8_t filterId){
  switch (filterId) {
    case 0x01: return "FIL1";
    case 0x02: return "FIL2";
    case 0x03: return "FIL3";
    default: return "UNK";
  }
}


String extractJsonString(const String &json, const char *key){
  String token = "\"" + String(key) + "\":";
  int start = json.indexOf(token);
  if (start < 0) {
    return String();
  }
  start += token.length();
  while (start < (int)json.length() && (json.charAt(start) == ' ' || json.charAt(start) == '\t')) {
    start++;
  }
  if (start >= (int)json.length()) {
    return String();
  }

  if (json.charAt(start) == '"') {
    start++;
    String out;
    bool escaped = false;
    for (int i = start; i < (int)json.length(); i++) {
      char c = json.charAt(i);
      if (escaped) {
        switch (c) {
          case 'n':  out += '\n'; break;
          case 'r':  out += '\r'; break;
          case 't':  out += '\t'; break;
          case '\\': out += '\\'; break;
          case '"':  out += '"';  break;
          case 'u':  {
            // \uXXXX — decode 4 hex digits to char (BMP only, basic ASCII range)
            if (i + 4 < (int)json.length()) {
              char h[5] = { json.charAt(i+1), json.charAt(i+2), json.charAt(i+3), json.charAt(i+4), '\0' };
              unsigned int cp = (unsigned int)strtoul(h, nullptr, 16);
              if (cp < 0x80) out += (char)cp;
              i += 4;
            }
            break;
          }
          default:   out += c;    break;
        }
        escaped = false;
      } else if (c == '\\') {
        escaped = true;
      } else if (c == '"') {
        return out;
      } else {
        out += c;
      }
    }
    return String();
  }

  int end = start;
  while (end < (int)json.length() && json.charAt(end) != ',' && json.charAt(end) != '}') {
    end++;
  }
  String out = json.substring(start, end);
  out.trim();
  return out;
}

bool extractJsonBool(const String &json, const char *key, bool defaultValue){
  String value = extractJsonString(json, key);
  if (value.length() == 0) {
    return defaultValue;
  }
  value.toLowerCase();
  if (value == "true" || value == "1") {
    return true;
  }
  if (value == "false" || value == "0") {
    return false;
  }
  return defaultValue;
}

static String readLogConfigJson() {
  if (!cfgFS.exists(LOG_CONFIG_PATH)) {
    return String();
  }
  File f = cfgFS.open(LOG_CONFIG_PATH, "r");
  if (!f) {
    return String();
  }
  String json = f.readString();
  f.close();
  json.trim();
  return json;
}

static String buildLogConfigJson(
  const String &existingJson,
  const String &trx1Label,
  const String &trx2Label,
  const String &trx3Label,
  const String &blockedDxcc
) {
  String json;
  json.reserve(256);
  json += "{";
  json += "\"trx1Label\":\""; json += jsonEscape(trx1Label); json += "\"";
  json += ",\"trx2Label\":\""; json += jsonEscape(trx2Label); json += "\"";
  json += ",\"trx3Label\":\""; json += jsonEscape(trx3Label); json += "\"";
  json += ",\"blockedDxcc\":\""; json += jsonEscape(blockedDxcc); json += "\"";
  json += "}";
  return json;
}

static bool saveLogConfigJson(const String &json) {
  File f = cfgFS.open(LOG_CONFIG_PATH, "w");
  if (!f) {
    return false;
  }
  f.print(json);
  f.close();
  loadLogConfigVars();
  return true;
}

String extractJsonObject(const String &json, const char *key) {
  String token = "\"" + String(key) + "\":";
  int start = json.indexOf(token);
  if (start < 0) return String();
  start += token.length();
  while (start < (int)json.length() && (json[start] == ' ' || json[start] == '\t')) start++;
  if (start >= (int)json.length() || json[start] != '{') return String();
  int depth = 0, end = start;
  bool inString = false;
  bool escaped = false;
  for (; end < (int)json.length(); end++) {
    char c = json[end];
    if (inString) {
      if (escaped) escaped = false;
      else if (c == '\\') escaped = true;
      else if (c == '"') inString = false;
      continue;
    }
    if (c == '"') inString = true;
    else if (c == '{') depth++;
    else if (c == '}') { if (--depth == 0) { end++; break; } }
  }
  return json.substring(start, end);
}

int extractJsonInt(const String &j, const String &key) {
  String needle = "\"" + key + "\":";
  int idx = j.indexOf(needle);
  if (idx < 0) return 0;
  return j.substring(idx + needle.length()).toInt();
}

void bdLoadDefaults() {
  const uint32_t fMin[BD_ROWS] = {
    1810, 3500, 5351, 7000, 10100, 14000, 18068,
    21000, 24890, 28000, 50000, 70000, 144000, 430000, 0, 0
  };
  const uint32_t fMax[BD_ROWS] = {
    2000, 3800, 5367, 7200, 10150, 14350, 18168,
    21450, 24990, 29700, 54000, 70500, 146000, 440000, 0, 0
  };
  for (int i = 0; i < BD_ROWS; i++) {
    bdRows[i].fMin    = fMin[i];
    bdRows[i].fMax    = fMax[i];
    bdRows[i].outputs = (i < 14) ? (uint16_t)(1 << i) : 0;
  }
  bdSource = 1;
}

void bdLoadConfig() {
  if (!cfgFS.exists(BD_CONFIG_PATH)) { bdLoadDefaults(); return; }
  File f = cfgFS.open(BD_CONFIG_PATH, FILE_READ);
  if (!f) { bdLoadDefaults(); return; }
  String j = f.readString();
  f.close();
  int si = j.indexOf("\"source\":");
  if (si >= 0) bdSource = j.substring(si + 9).toInt();
  int arrStart = j.indexOf("\"rows\":[");
  if (arrStart < 0) { bdLoadDefaults(); return; }
  arrStart += 8;
  for (int i = 0; i < BD_ROWS; i++) {
    int ob = j.indexOf('{', arrStart);
    int cb = j.indexOf('}', ob);
    if (ob < 0 || cb < 0) break;
    String row = j.substring(ob, cb + 1);
    bdRows[i].fMin    = (uint32_t)extractJsonInt(row, "fMin");
    bdRows[i].fMax    = (uint32_t)extractJsonInt(row, "fMax");
    bdRows[i].outputs = (uint16_t)extractJsonInt(row, "outputs");
    arrStart = cb + 1;
  }
}

void bdSaveConfig() {
  File f = cfgFS.open(BD_CONFIG_PATH, "w");
  if (!f) return;
  f.print("{\"source\":"); f.print(bdSource);
  f.print(",\"rows\":[");
  for (int i = 0; i < BD_ROWS; i++) {
    if (i > 0) f.print(",");
    f.print("{\"fMin\":"); f.print(bdRows[i].fMin);
    f.print(",\"fMax\":"); f.print(bdRows[i].fMax);
    f.print(",\"outputs\":"); f.print(bdRows[i].outputs);
    f.print("}");
  }
  f.print("]}");
  f.close();
}

void bdWriteOutputs(uint16_t mask) {
  uint8_t hi = (mask >> 8) & 0xFF;
  uint8_t lo = mask & 0xFF;
  digitalWrite(BD_LATCH_PIN, LOW);
  shiftOut(BD_DATA_PIN, BD_CLOCK_PIN, MSBFIRST, hi);
  shiftOut(BD_DATA_PIN, BD_CLOCK_PIN, MSBFIRST, lo);
  digitalWrite(BD_LATCH_PIN, HIGH);
  bdCurrentOutputs = mask;
}

void bdInit() {
  if (!bdEnabled) return;
  pinMode(BD_CLOCK_PIN, OUTPUT); digitalWrite(BD_CLOCK_PIN, LOW);
  pinMode(BD_LATCH_PIN, OUTPUT); digitalWrite(BD_LATCH_PIN, HIGH);
  pinMode(BD_DATA_PIN,  OUTPUT); digitalWrite(BD_DATA_PIN,  LOW);
  bdWriteOutputs(0);
}

void bdUpdate(uint32_t freqHz) {
  if (!bdEnabled) return;
  uint32_t freqKhz = freqHz / 1000;
  uint16_t mask = 0;
  for (int i = 0; i < BD_ROWS; i++) {
    if (bdRows[i].fMin == 0 && bdRows[i].fMax == 0) continue;
    if (freqKhz >= bdRows[i].fMin && freqKhz <= bdRows[i].fMax) {
      mask |= bdRows[i].outputs;
    }
  }
  if (mask != bdCurrentOutputs) bdWriteOutputs(mask);
}

bool parseHexPayload(const String &hex, uint8_t *buffer, size_t &bufferLen, size_t maxLen){
  bufferLen = 0;
  int nibble = -1;
  for (size_t i = 0; i < hex.length(); i++) {
    char c = hex.charAt(i);
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
      continue;
    }

    int value;
    if (c >= '0' && c <= '9') {
      value = c - '0';
    } else if (c >= 'a' && c <= 'f') {
      value = 10 + c - 'a';
    } else if (c >= 'A' && c <= 'F') {
      value = 10 + c - 'A';
    } else {
      return false;
    }

    if (nibble < 0) {
      nibble = value;
    } else {
      if (bufferLen >= maxLen) {
        return false;
      }
      buffer[bufferLen++] = (uint8_t)((nibble << 4) | value);
      nibble = -1;
    }
  }
  return nibble < 0 && bufferLen > 0;
}

void setModesText(const char *value){
  portENTER_CRITICAL(&stateMux);
  snprintf(modes, sizeof(modes), "%s", value != nullptr ? value : "");
  portEXIT_CRITICAL(&stateMux);
}

void copyModesText(char *dest, size_t destSize){
  if (dest == nullptr || destSize == 0) {
    return;
  }

  portENTER_CRITICAL(&stateMux);
  snprintf(dest, destSize, "%s", modes);
  portEXIT_CRITICAL(&stateMux);
}

bool parseModeId(const String &modeName, uint8_t &modeId){
  String normalized = modeName;
  normalized.toUpperCase();
  if (normalized == "LSB") {
    modeId = MODE_TYPE_LSB;
    return true;
  }
  if (normalized == "USB") {
    modeId = MODE_TYPE_USB;
    return true;
  }
  if (normalized == "AM") {
    modeId = MODE_TYPE_AM;
    return true;
  }
  if (normalized == "CW") {
    modeId = MODE_TYPE_CW;
    return true;
  }
  if (normalized == "RTTY" || normalized == "FSK") {
    modeId = MODE_TYPE_RTTY;
    return true;
  }
  if (normalized == "FM") {
    modeId = MODE_TYPE_FM;
    return true;
  }
  if (normalized == "DV") {
    modeId = MODE_TYPE_DV;
    return true;
  }
  return false;
}

uint8_t parseFilterWidth(const String &filterName){
  String normalized = filterName;
  normalized.toUpperCase();
  if (normalized == "FIL2" || normalized == "MID" || normalized == "MEDIUM") {
    return IF_PASSBAND_WIDTH_MEDIUM;
  }
  if (normalized == "FIL3" || normalized == "NAR" || normalized == "NARROW") {
    return IF_PASSBAND_WIDTH_NARROW;
  }
  return IF_PASSBAND_WIDTH_WIDE;
}

size_t buildSimpleCatFrame(uint8_t command, const uint8_t *payload, size_t payloadLen, uint8_t *frame, size_t frameMaxLen){
  if (radio_address == 0x00 || frameMaxLen < payloadLen + 6) {
    return 0;
  }

  size_t frameLen = 0;
  frame[frameLen++] = START_BYTE;
  frame[frameLen++] = START_BYTE;
  frame[frameLen++] = radio_address;
  frame[frameLen++] = CONTROLLER_ADDRESS;
  frame[frameLen++] = command;
  for (size_t i = 0; i < payloadLen; i++) {
    frame[frameLen++] = payload[i];
  }
  frame[frameLen++] = STOP_BYTE;
  return frameLen;
}

size_t buildSetFrequencyFrame(uint32_t freqHz, uint8_t *frame, size_t frameMaxLen){
  String strFreq = IntToTenString(freqHz);
  String splitFreq[5];
  SplitString(strFreq, splitFreq);

  uint8_t payload[5] = {
    stringToByte(splitFreq[4]),
    stringToByte(splitFreq[3]),
    stringToByte(splitFreq[2]),
    stringToByte(splitFreq[1]),
    stringToByte(splitFreq[0])
  };
  return buildSimpleCatFrame(CMD_WRITE_FREQ, payload, sizeof(payload), frame, frameMaxLen);
}

size_t buildSetModeFrame(uint8_t modeId, uint8_t modeWidth, uint8_t *frame, size_t frameMaxLen){
  uint8_t payload[2] = {modeId, modeWidth};
  return buildSimpleCatFrame(CMD_WRITE_MODE, payload, sizeof(payload), frame, frameMaxLen);
}

size_t buildReadQuickSplitFrame(uint8_t *frame, size_t frameMaxLen){
  uint8_t payload[3] = {0x05, 0x00, 0x45};
  return buildSimpleCatFrame(0x1A, payload, sizeof(payload), frame, frameMaxLen);
}

void resetSetupMessages(void){
  setupSsidErr = "";
  setupPswdErr = "";
  setupSsid2Err = "";
  setupPswd2Err = "";
  setupCivAddrErr = "";
  setupSaveOk = false;
}

void renderSetupPage(){
  handleFileFromSPIFFS("/setup.html");
}

void handleSetupData(){
  char trxnetHex[3];
  snprintf(trxnetHex, sizeof(trxnetHex), "%02x", TRXNET_ID);

  int baudSelect = 3;
  if (BaudRate == 1200) baudSelect = 0;
  else if (BaudRate == 2400) baudSelect = 1;
  else if (BaudRate == 4800) baudSelect = 2;
  else if (BaudRate == 9600) baudSelect = 3;
  else if (BaudRate == 115200) baudSelect = 4;

  uint8_t ipLastOctet = APmode ? 0 : (uint8_t)WiFi.localIP()[3];
  bool trxnetidIsDefault = (EEPROM.read(41) == 0xff);

  String j;
  j.reserve(3500);
  j += "{\"fwRev\":"; j += (unsigned)REV;
  // What this build physically has. The browser hides whole SETUP sections
  // from this rather than probing for 404s: on the PC binary there is no WiFi
  // to provision, no CI-V wire and no GPIO, so the first-run wizard must not
  // present steps that can never be completed. See platform_caps.h.
  j += ",\"platform\":\""; j += CAP_PLATFORM_NAME; j += "\"";
  j += ",\"caps\":{";
  j +=   "\"wifi\":";        j += CAP_WIFI ? "true" : "false";
  j +=   ",\"civ\":";        j += CAP_CIV ? "true" : "false";
  j +=   ",\"gpio\":";       j += CAP_GPIO ? "true" : "false";
  j +=   ",\"bandDecoder\":";j += CAP_BAND_DECODER ? "true" : "false";
  j +=   ",\"cwKeying\":";   j += CAP_GPIO ? "true" : "false";
  j += "}";
  j += ",\"apMode\":"; j += APmode ? "true" : "false";
  // The first segment of SETUP's status line. One segment with several states
  // rather than a second one beside it: it answers "which network is this
  // device on", and "apMode" above already carries the SoftAP flag for anything
  // that needs to branch on it.
  //
  // The radio is the truth. WiFi.SSID() is the network actually joined, not the
  // profile that was asked for, so the line cannot name a network the device
  // has since dropped off -- which is the whole reason an operator reads it.
  // The desktop binary has no radio, so the segment is empty and the page drops
  // it instead of printing a leading separator.
  String apModeText;
  #if CAP_WIFI
    if (APmode) {
      apModeText = "AP mode ON";
    } else if (!WiFiStationReady()) {
      apModeText = "WiFi down";
    } else {
      String staSsid = WiFi.SSID();
      // A hidden network answers WL_CONNECTED with an empty name, which would
      // otherwise print a bare "AP " and read as a bug.
      apModeText = staSsid.length() > 0 ? ("AP " + staSsid) : String("AP (hidden)");
    }
  #endif
  j += ",\"apModeText\":\""; j += configJsonEscape(apModeText); j += "\"";
  j += ",\"mac\":\""; j += configJsonEscape(MACString); j += "\"";
  j += ",\"hwRev\":"; j += HardwareRev;
  j += ",\"ipLastOctet\":"; j += ipLastOctet;
  j += ",\"hostname\":\""; j += deviceHostname; j += "\"";
  // Address the router last handed out. In AP mode this is the only clue the
  // portal can offer about where the device lives on the real network.
  j += ",\"lastStaIp\":\"";
  j += ((uint32_t)lastStaIp != 0) ? lastStaIp.toString() : String("");
  j += "\"";
  j += ",\"trxnetidIsDefault\":"; j += trxnetidIsDefault ? "true" : "false";
  j += ",\"trxnetDeviceName\":\""; j += configJsonEscape(TRXNET_ID != 0x00 ? String(trxDeviceName) : String("disabled")); j += "\"";
  j += ",\"trxnetApNote\":\""; j += APmode ? "TrxNet is not active in AP mode - requires WiFi station mode." : ""; j += "\"";
  j += ",\"ssid\":\""; j += configJsonEscape(SSID); j += "\"";
  j += ",\"pswd\":\""; j += configJsonEscape(PSWD); j += "\"";
  j += ",\"ssid2\":\""; j += configJsonEscape(SSID2); j += "\"";
  j += ",\"pswd2\":\""; j += configJsonEscape(PSWD2); j += "\"";
  j += ",\"trxnetid\":\""; j += trxnetHex; j += "\"";
  j += ",\"trxnetport\":\""; j += TRXNET_PORT; j += "\"";
  j += ",\"trxnetprio\":\""; j += configJsonEscape(TRXNET_PRIO); j += "\"";
  j += ",\"baud\":\""; j += baudSelect; j += "\"";
  String labels[3] = {g_lcTrx1Label, g_lcTrx2Label, g_lcTrx3Label};
  for (uint8_t slot = 0; slot < 3; slot++) {
    char civ[3], netid[3];
    snprintf(civ, sizeof(civ), "%02X", radioSlots[slot].civAddr);
    snprintf(netid, sizeof(netid), "%02X", radioSlots[slot].netId);
    String prefix = "trx" + String(slot + 1);
    j += ",\""; j += prefix; j += "enabled\":";
    j += (slot == 0 || radioSlots[slot].enabled) ? "true" : "false";
    j += ",\""; j += prefix; j += "label\":\"";
    j += configJsonEscape(labels[slot]); j += "\"";
    j += ",\""; j += prefix; j += "transport\":\"";
    j += radioTransportName(radioSlots[slot].transport); j += "\"";
    j += ",\""; j += prefix; j += "civaddr\":\""; j += civ; j += "\"";
    j += ",\""; j += prefix; j += "netid\":\""; j += netid; j += "\"";
    j += ",\""; j += prefix; j += "lanip\":\"";
    j += configJsonEscape(radioSlots[slot].lanIp); j += "\"";
    j += ",\""; j += prefix; j += "lanuser\":\"";
    j += configJsonEscape(radioSlots[slot].lanUser); j += "\"";
    j += ",\""; j += prefix; j += "lanpass\":\"";
    j += configJsonEscape(radioSlots[slot].lanPass); j += "\"";
    j += ",\""; j += prefix; j += "model\":\"";
    j += configJsonEscape(radioSlots[slot].model); j += "\"";
  }
  // Compatibility aliases used by the current JS8 readiness check and older
  // setup backups while the unified per-slot keys become authoritative.
  { char civ[3]; snprintf(civ, sizeof(civ), "%02X", radioSlots[0].civAddr);
    j += ",\"civaddr\":\""; j += civ; j += "\""; }
  j += ",\"lanip\":\"";   j += configJsonEscape(radioSlots[0].lanIp); j += "\"";
  j += ",\"lanuser\":\""; j += configJsonEscape(radioSlots[0].lanUser); j += "\"";
  j += ",\"lanpass\":\""; j += configJsonEscape(radioSlots[0].lanPass); j += "\"";
  j += ",\"cwIpOnConnect\":"; j += cwIpOnConnect ? "true" : "false";
  j += ",\"trx2conntype\":"; j += TRX2_CONN_TYPE;
  j += ",\"trx3conntype\":"; j += TRX3_CONN_TYPE;
  j += ",\"dxchost\":\""; j += configJsonEscape(DxcHost); j += "\"";
  j += ",\"dxcport\":\""; j += DxcPort > 0 ? String(DxcPort) : ""; j += "\"";
  j += ",\"dxccall\":\""; j += configJsonEscape(DxcCallsign); j += "\"";
  j += ",\"dxclocator\":\""; j += configJsonEscape(DxcLocator); j += "\"";
  j += ",\"blockedDxcc\":\""; j += configJsonEscape(g_lcBlockedDxcc); j += "\"";
  for (uint8_t i = 0; i < CW_MEMORY_COUNT; i++) {
    j += ",\"cwmem"; j += (i + 1); j += "\":\""; j += configJsonEscape(cwMemoryText[i]); j += "\"";
  }
  for (uint8_t i = 0; i < FREQ_MEMORY_COUNT; i++) {
    j += ",\"freqmem"; j += (i + 1); j += "\":\""; j += configJsonEscape(freqMemoryText[i]); j += "\"";
  }
  j += "}";
  webServer.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  webServer.sendHeader("Pragma", "no-cache");
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  webServer.send(200, "application/json", j);
}

// Live list of visible TrxNet devices (peer table) for the setup page.
// state: "ap" (AP mode) / "disabled" (NET_ID 0x00) / "ok". prio computed server-side.
void handleTrxNetPeers(){
  String j;
  j.reserve(1024);
  j += "{";
  // "AP mode" and "the softAP is up" stopped being the same thing when the WiFi
  // handover was added: during it the station is joined AND the hotspot is still
  // running, so an operator already reading this page over their own network was
  // told the device was in AP mode. It is -- but saying so there is answering a
  // question nobody asked. The radio clients and TrxNet both start only when a
  // boot finds APmode false, so what is actually outstanding is the restart.
  if (APmode && WiFiStationReady()) {
    j += "\"state\":\"handoff\",\"self\":\"\",\"peers\":[]";
  } else if (APmode) {
    j += "\"state\":\"ap\",\"self\":\"\",\"peers\":[]";
  } else if (!trxNetEnabled) {
    j += "\"state\":\"disabled\",\"self\":\"\",\"peers\":[]";
  } else {
    j += "\"state\":\"ok\",\"self\":\""; j += configJsonEscape(String(trxDeviceName)); j += "\",\"peers\":[";
    uint32_t now = millis();
    int count = net.peerCount();
    bool first = true;
    for (int i = 0; i < count; i++) {
      const TrxPeer* p = net.peer(i);
      if (!p || !p->active) continue;
      if (!first) j += ",";
      first = false;
      uint32_t age = (now - p->lastSeen) / 1000;
      j += "{\"name\":\""; j += configJsonEscape(String(p->name)); j += "\"";
      j += ",\"ip\":\"";   j += p->ip.toString(); j += "\"";
      j += ",\"age\":";    j += age;
      j += ",\"prio\":";   j += trxIsPriorityName(p->name) ? "true" : "false";
      j += "}";
    }
    j += "]";
  }
  j += "}";
  webServer.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  webServer.send(200, "application/json", j);
}

// ---- LAN radio discovery endpoints (SETUP page) ----------------------------
// Shape follows the two existing precedents: /lan/reconnect for a fire-and-
// forget command that the main loop picks up, /trxnet-peers.json for a list the
// browser polls. Nothing long-running happens inside a handler.

static void icomScanSendJson(int code, const String &body) {
  webServer.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  webServer.send(code, "application/json", body);
}

// Refuses rather than queues: a scan borrows the radio link, so the operator
// should see why it did not run instead of it happening at some later moment.
static const char* icomScanRefusal() {
  if (APmode) return "ap";
  if (WiFi.status() != WL_CONNECTED) return "no_wifi";
  if (icomScanPhase != ISCAN_IDLE && icomScanPhase != ISCAN_DONE) return "busy";
  if (txRealtimeNow()) return "tx";
  return nullptr;
}

void handleIcomScanStart(){
  const char* refusal = icomScanRefusal();
  if (refusal) {
    icomScanSendJson(409, String("{\"ok\":false,\"error\":\"") + refusal + "\"}");
    return;
  }
  icomScanFailed = false;
  icomScanPhase = ISCAN_SUSPEND;
  icomScanSendJson(202, "{\"ok\":true}");
}

void handleIcomScanStatus(){
  String j;
  j.reserve(512);
  j += "{";
  if (APmode) {
    j += "\"state\":\"ap\",\"scanned\":0,\"total\":254,\"subnet\":\"\",\"truncated\":false,\"found\":[]";
  } else {
    const char* st = "idle";
    if (icomScanPhase == ISCAN_SUSPEND || icomScanPhase == ISCAN_RUN) st = "running";
    else if (icomScanPhase == ISCAN_DONE) st = icomScanFailed ? "failed" : "done";
    char subnet[20] = {0};
    icomScan.subnetPrefix(subnet, sizeof(subnet));
    j += "\"state\":\""; j += st; j += "\"";
    j += ",\"scanned\":"; j += icomScan.progress();
    j += ",\"total\":254";
    j += ",\"subnet\":\""; j += subnet; j += "\"";
    j += ",\"truncated\":"; j += icomScan.wasTruncated() ? "true" : "false";
    j += ",\"found\":[";
    for (uint8_t i = 0; i < icomScan.count(); i++) {
      if (i) j += ",";
      char idHex[9];
      snprintf(idHex, sizeof(idHex), "%08lx", (unsigned long)icomScan.entry(i).id);
      j += "{\"ip\":\""; j += icomScan.entry(i).ip.toString(); j += "\"";
      j += ",\"id\":\"";  j += idHex; j += "\"}";
    }
    j += "]";
  }
  j += "}";
  icomScanSendJson(200, j);
}

void handleIcomTestStart(){
  const char* refusal = icomScanRefusal();
  if (refusal) {
    icomScanSendJson(409, String("{\"ok\":false,\"error\":\"") + refusal + "\"}");
    return;
  }
  String body = webServer.arg("plain");
  String ip   = extractJsonString(body, "ip");
  String user = extractJsonString(body, "user");
  String pass = extractJsonString(body, "pass");
  String civ  = extractJsonString(body, "civaddr");
  if (!icomTestIp.fromString(ip) || user.length() == 0 || pass.length() == 0) {
    icomScanSendJson(400, "{\"ok\":false,\"error\":\"incomplete\"}");
    return;
  }
  icomTestUser = user;
  icomTestPass = pass;
  icomTestCivAddr = civ.length() ? (uint8_t)strtoul(civ.c_str(), nullptr, 16) : 0xA4;
  // The page names the slot so a detected model is stored against the right
  // one; matching by IP would fail for an address that is not saved yet.
  String slotArg = extractJsonString(body, "slot");
  long slotNum = slotArg.length() ? slotArg.toInt() : 1;
  icomTestSlot = (slotNum >= 1 && slotNum <= 3) ? (uint8_t)(slotNum - 1) : 0;
  icomTestModel = "";
  icomTestResult = "running";
  icomScanPhase = ISCAN_TEST_SUSPEND;
  icomScanSendJson(202, "{\"ok\":true}");
}

void handleIcomTestStatus(){
  const char* st = icomTestResult;
  if (icomScanPhase == ISCAN_TEST_SUSPEND || icomScanPhase == ISCAN_TEST_RUN) st = "running";
  String j = "{\"state\":\"";
  j += st;
  j += "\",\"model\":\"";
  j += configJsonEscape(icomTestModel);
  j += "\"}";
  icomScanSendJson(200, j);
}

// ---- AP -> station handoff endpoints ---------------------------------------
// Credentials are not taken from the request: /setup/save has already stored
// and validated them, so the handoff always tests exactly what will be used on
// the next boot rather than a second copy that could differ.
void handleWifiTryStart(){
  if (!APmode) {
    icomScanSendJson(409, "{\"ok\":false,\"error\":\"not_ap\"}");
    return;
  }
  if (wifiTryState == WTRY_SCAN || wifiTryState == WTRY_CONNECTING) {
    icomScanSendJson(409, "{\"ok\":false,\"error\":\"busy\"}");
    return;
  }
  if (!WifiProfileConfigured(0) && !WifiProfileConfigured(1)) {
    icomScanSendJson(400, "{\"ok\":false,\"error\":\"no_ssid\"}");
    return;
  }
  wifiTrySsid = "";
  wifiTryReason = "";
  wifiTryCandidateCount = 0;
  wifiTryCandidateIdx = 0;
  wifiTryScanSawNothing = false;
  WiFi.mode(WIFI_AP_STA);          // portal stays reachable while we associate
  WiFi.scanDelete();
  // The scan itself runs in the tick, not here: it blocks for a second or two,
  // and the STA interface needs a moment after the mode switch before it can
  // scan at all. The deadline doubles as that settle delay.
  wifiTryState = WTRY_SCAN;
  wifiTryDeadline = millis() + 400;
  Serial.println("WIFI| AP handoff: scanning for configured networks");
  icomScanSendJson(202, "{\"ok\":true}");
}

void handleWifiTryStatus(){
  const char* st = "idle";
  if (wifiTryState == WTRY_SCAN)        st = "scanning";
  else if (wifiTryState == WTRY_CONNECTING) st = "connecting";
  else if (wifiTryState == WTRY_OK)     st = "ok";
  else if (wifiTryState == WTRY_FAILED) st = "failed";
  String ip = (wifiTryState == WTRY_OK) ? WiFi.localIP().toString() : String("");
  String j = "{\"state\":\"";
  j += st;
  j += "\",\"ip\":\"";     j += ip;
  j += "\",\"ssid\":\"";   j += configJsonEscape(wifiTrySsid);
  j += "\",\"reason\":\""; j += wifiTryReason;
  j += "\",\"host\":\"";   j += deviceHostname;
  j += "\"}";
  icomScanSendJson(200, j);
}

void handleWebServerLoop(){
  // Single chokepoint for every blocking port-80 handler (flash writes, file
  // serving, EEPROM.commit): defer them out of the TX-critical window so a
  // multi-100 ms stall cannot land on a JS8 slot boundary and miss the key.
  if(txCriticalNow()) return;
  unsigned long start = millis();
  if (APmode) dnsServer.processNextRequest();   // captive portal
  webServer.handleClient();
  unsigned long elapsed = millis() - start;
  if (elapsed > LOOP_WARN_MS) {
    // lastUri/lastPeer = request whose response was written most recently; for a
    // write stall (the 10s blocks) that is exactly the connection that stalled
    Serial.print("LOOP| slow: webServer ");
    Serial.print(elapsed);
    Serial.print("ms uri=");
    Serial.print(webServer.lastUri);
    Serial.print(" peer=");
    Serial.print(webServer.lastPeer);
    Serial.print(" wifi=");
    Serial.print((int)WiFi.status());
    Serial.print(" ip=");
    Serial.println(WiFi.localIP());
  }
}

// The radio's own model name, safe to paste into the /state document.
//
// radioName is copied straight out of the capabilities datagram, so it is
// network-derived: a garbled or hostile packet could carry a quote, a backslash
// or a control byte and corrupt the JSON for every page that polls /state.
// buildStateJson uses snprintf with no escaping, so the sanitising has to happen
// here. Anything outside printable ASCII, and both JSON metacharacters, are
// dropped rather than escaped -- a model name is not worth an escape path.
static const char *radioNameForJson(IcomLanClient *client){
  static char safe[16];
  const char *source = client ? client->radioModelName() : "";
  // Fall back to what this radio reported last time. WSPR refuses to transmit
  // without a known model -- correctly, since 100 % of the CI-V scale is 10 W
  // on an IC-705 and 100 W on an IC-7610 -- and before this the answer was
  // forgotten the moment the link dropped, leaving the page dead until a live
  // session came back. A remembered observation is not a guess; a live one
  // still wins, and every successful connection refreshes it.
  if ((!source || !source[0]) && client) {
    uint8_t slot = lanRadioSlotIndex();
    if (slot != 0xFF) source = radioSlots[slot].model.c_str();
  }
  size_t out = 0;
  for (size_t i = 0; source[i] && out + 1 < sizeof(safe); i++) {
    char c = source[i];
    if (c == '"' || c == '\\' || (uint8_t)c < 0x20 || (uint8_t)c > 0x7e) continue;
    safe[out++] = c;
  }
  safe[out] = 0;
  return safe;
}

// Bus-level serial CI-V RTT (single outstanding query across TRX2/TRX3) -- last
// + max-since-boot, same shape as icomLanClient.h's link-latency fields. Declared
// here (ahead of the CI-V polling state machine further down) because
// buildStateJson() reports it and Arduino does not forward-declare globals.
static uint32_t civRttMs = 0, civRttMaxMs = 0;

// lanView answers "describe the radio JS8 is driving" instead of the default
// "describe TRX1". The two are the same document whenever LAN sits on TRX1, and
// only the JS8 page asks for the LAN view -- the log page's TRX1 tab, the band
// decoder and WSPR keep reading TRX1 exactly as before.
void buildStateJson(char *buf, size_t bufSize, bool lanView){
  uint8_t slot = 0;
  if (lanView) {
    uint8_t lanSlot = lanRadioSlotIndex();
    if (lanSlot != 0xFF) slot = lanSlot;
  }
  const bool snapView = slot != 0;   // a LAN radio outside TRX1 keeps its own state
  char modesSnapshot[sizeof(modes)];
  if (snapView) strlcpy(modesSnapshot, lanRadioSnap.mode, sizeof(modesSnapshot));
  else copyModesText(modesSnapshot, sizeof(modesSnapshot));
  char addrStr[5];
  snprintf(addrStr, sizeof(addrStr), "0x%02X",
           snapView ? radioSlots[slot].civAddr : radio_address);
  RadioTransport primaryTransport = radioSlots[slot].transport;
  bool radioLinked = radioSlotConnected(slot);
  IcomLanClient *client = primaryTransport == RADIO_LAN ? radioLanClient(slot) : nullptr;
  const char *lanStatus = !client ? "disabled" :
                          (client->connected() ? "linked" :
                          ((client->status() == IcomLanClient::LAN_IDLE || client->failed())
                           ? "disconnected" : "connecting"));
  const char *btStat = primaryTransport == RADIO_LAN ? (radioLinked ? "LAN linked" :
                       (strcmp(lanStatus, "connecting") == 0 ? "LAN connecting" : "LAN disconnected")) :
                       (primaryTransport == RADIO_CIV
                         ? (radioLinked ? "CI-V linked" : "CI-V disconnected")
                         : (radioLinked ? "TRXNET linked (limited)" : "TRXNET disconnected"));
  const char *wifiStat = APmode ? "WiFi AP" :
                         (WiFiStationReady() ? "WiFi STA" : "WiFi down");
  int rssi = (APmode || !WiFiStationReady()) ? -999 : (int)WiFi.RSSI();
  // Finer LAN health than a single "connected": CAT stream actually delivering,
  // and audio sub-stream carrying fresh payload. Audio is false outside LAN.
  bool lanCatHealthy = client ? client->catHealthy()
                              : (primaryTransport == RADIO_CIV && radioLinked);
  bool lanAudioReady = client && client->audioReady();
  bool lanAudioTxReady = client && client->audioTxReady();
  IcomLanAudioTx::Snapshot lanAudioTx = {};
  if(client) lanAudioTx = client->audioTxSnapshot();
  bool fullCat = radioHasCapability(slot, primaryTransport, RADIO_CAP_FULL_CAT);
  // Values that live in the shared globals for TRX1 and in the snapshot for a
  // LAN radio in another slot. AF gain, RIT, key speed, preamp and VOX have no
  // consumer on the JS8 path and are not kept in the snapshot -- they report 0.
  uint32_t viewFrequency = snapView ? (uint32_t)g_trxFreq[slot - 1] : (uint32_t)frequency;
  bool viewPower = snapView ? radioLinked : (statusPower != 0);
  bool viewTx = snapView ? lanRadioSnap.tx : stateTx;
  unsigned viewFilter = snapView ? lanRadioSnap.filter : stateFilter;
  unsigned viewSmeter = snapView ? lanRadioSnap.smeterRaw : stateSmeterRaw;
  unsigned viewPowerMeter = snapView ? lanRadioSnap.powerMeterRaw : statePowerMeterRaw;
  // docs/mercury-implementace.md §7: ALC now polled at idle too (icomLanClient.h's
  // sendAuxRot), not only during TX/calibration, so this stays current between
  // transmissions -- same TRX1-global/LAN-snapshot split as smeterRaw above.
  unsigned viewAlcRaw = snapView ? lanRadioSnap.alcRaw : stateAlcRaw;
  unsigned viewRfPower = snapView ? lanRadioSnap.rfPower : stateRfPower;
  bool viewRfPowerSeen = snapView ? lanRadioSnap.rfPowerSeen : stateRfPowerSeen;
  float viewSupplyVolts = snapView ? lanRadioSnap.supplyVolts : stateSupplyVolts;
  float viewSwr = snapView ? lanRadioSnap.swr : stateSwr;
  const char *viewType = snapView ? (primaryTransport == RADIO_LAN ? "ICOM-LAN" : "TRXNET")
                                  : transceiverType.c_str();
  // GPS belongs to the radio gpsPollTick() watches -- the same one the JS8 pages
  // drive -- so both views carry it, like the LAN health counters below. The
  // fields exist only when the radio has answered 23 00 at all; their absence is
  // how a page tells "no GPS on this model" from "waiting for a fix". gpsGrid is
  // computed from BCD digits and cannot carry JSON metacharacters.
  char gpsFrag[64] = "";
  if (gpsSupport == GPS_SUPPORTED) {
    uint32_t gpsAge = gpsStampChangedMs ? (millis() - gpsStampChangedMs) : 999999999u;
    if (gpsAge > 999999999u) gpsAge = 999999999u;
    snprintf(gpsFrag, sizeof(gpsFrag),
             ",\"gpsGrid\":\"%s\",\"gpsFixAgeMs\":%u,\"gpsSel\":%u",
             gpsGrid, (unsigned)gpsAge, (unsigned)gpsSel);
  }
  // lanDrops/lanStalls/lanFilled are link health since boot, reported on every
  // view rather than only the LAN one: an operator watching an unattended beacon
  // should not have to know which slot carries LAN to see whether it has been
  // dropping. Keep comments out of the snprintf call itself -- the argument
  // bounds in tools/state-json-budget-smoke.js are parsed straight from it.
  snprintf(buf, bufSize,
    "{\"connected\":%s,\"catHealthy\":%s,\"audioReady\":%s,\"audioTxReady\":%s,"
    "\"lanStatus\":\"%s\",\"btStatus\":\"%s\",\"wifiStatus\":\"%s\","
    "\"radioTransport\":\"%s\",\"fullCat\":%s,\"tuneSupported\":true,"
    "\"wifiRssi\":%d,\"fwRev\":\"%u\",\"bdSupported\":%s,\"power\":%s,"
    "\"frequency\":%u,\"mode\":\"%s\",\"filter\":%u,"
    "\"radioAddress\":\"%s\",\"transceiverType\":\"%s\",\"radioName\":\"%s\",\"tx\":%s,\"ritRaw\":%u,"
    "\"smeterRaw\":%u,\"powerMeterRaw\":%u,\"alcRaw\":%u,"
    "\"afGain\":%u,\"keySpeed\":%u,\"rfPower\":%u,\"rfPowerSeen\":%s,"
    "\"supplyVolts\":%.2f,\"swr\":%.2f,"
    "\"preamp\":%u,\"vox\":%u,"
    "\"lanDrops\":%u,\"lanStalls\":%u,\"lanFilled\":%u,"
    "\"audioTxQueued\":%u,\"audioTxPackets\":%u,\"audioTxReplays\":%u,"
    "\"audioTxReplayMisses\":%u,\"audioTxSendFailures\":%u,\"audioTxMaxLateMs\":%u,"
    "\"audioRxDropped\":%u,\"audioMaxSendUs\":%u,"
    "\"pingRttCtrlMs\":%u,\"pingRttCivMs\":%u,\"pingRttAudioMs\":%u,"
    "\"civRttLanMs\":%u,\"civRttSerialMs\":%u,\"txDefer\":%s,"
    "\"dxcConnected\":%s%s}",
    radioLinked ? "true" : "false", lanCatHealthy ? "true" : "false",
    lanAudioReady ? "true" : "false", lanAudioTxReady ? "true" : "false",
    lanStatus, btStat, wifiStat,
    radioTransportName(primaryTransport), fullCat ? "true" : "false",
    rssi, (unsigned)REV, bdEnabled ? "true" : "false", viewPower ? "true" : "false",
    (unsigned)viewFrequency, modesSnapshot, (unsigned)viewFilter,
    addrStr, viewType, radioNameForJson(client), viewTx ? "true" : "false",
    (unsigned)(snapView ? 0 : stateRitRaw),
    (unsigned)viewSmeter, (unsigned)viewPowerMeter, (unsigned)viewAlcRaw,
    (unsigned)(snapView ? 0 : stateAfGain), (unsigned)(snapView ? 0 : stateKeySpeed), (unsigned)viewRfPower,
    viewRfPowerSeen ? "true" : "false",
    viewSupplyVolts, viewSwr,
    (unsigned)(snapView ? 0 : statePreampMode), (unsigned)(snapView ? 0 : stateVoxMode),
    (unsigned)lanHealthDrops, (unsigned)lanHealthStalls, (unsigned)lanHealthFilled,
    (unsigned)lanAudioTx.queued, (unsigned)lanAudioTx.sentPackets,
    (unsigned)lanAudioTx.replayedPackets, (unsigned)lanAudioTx.replayMisses,
    (unsigned)lanAudioTx.sendFailures, (unsigned)lanAudioTx.maxLatenessMs,
    (unsigned)(client ? client->audioRxDropped() : 0),
    (unsigned)(client ? client->audioMaxSendUs() : 0),
    (unsigned)(client ? client->pingRttCtrlMs() : 0),
    (unsigned)(client ? client->pingRttCivMs() : 0),
    (unsigned)(client ? client->pingRttAudioMs() : 0),
    (unsigned)(client ? client->civReqRttMs() : 0),
    (unsigned)civRttMs,
    txRealtimeNow() ? "true" : "false",
    DxcTelnetStatus ? "true" : "false",
    gpsFrag
  );
}

void handleGetState(){
  // CAT page polls /state?fast=1 — hold the fast BT poll cadence while it's open
  if (webServer.arg("fast") == "1") catFastUntil = millis() + CAT_FAST_HOLD_MS;
  static char stateBuf[1536];
  // ?radio=lan -> the radio JS8 drives; anything else keeps meaning TRX1.
  buildStateJson(stateBuf, sizeof(stateBuf), webServer.arg("radio") == "lan");
  webServer.sendHeader("Cache-Control", "no-cache");
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  webServer.send(200, "application/json", stateBuf);
}

// ── Pairing signalling buffer ─────────────────────────────────────────────────
static String  g_pairOffer;
static String  g_pairAnswer;
static uint32_t g_pairOfferMs = 0;
const  uint32_t PAIR_TTL_MS   = 300000UL; // 5 minutes

static void pairCors() {
  webServer.sendHeader("Access-Control-Allow-Origin",  "*");
  webServer.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  webServer.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  webServer.sendHeader("Cache-Control", "no-store");
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
}

void handlePairingOptions() { pairCors(); webServer.send(204); }

void handlePairingOfferPost() {
  pairCors();
  g_pairOffer   = webServer.arg("plain");
  g_pairAnswer  = "";
  g_pairOfferMs = millis();
  webServer.send(200, "application/json", "{\"ok\":true}");
}

void handlePairingOfferGet() {
  pairCors();
  if (g_pairOffer.isEmpty() || (millis() - g_pairOfferMs) > PAIR_TTL_MS) {
    g_pairOffer = ""; g_pairAnswer = "";
    webServer.send(200, "application/json", "{\"pending\":false}");
  } else {
    webServer.send(200, "application/json", g_pairOffer);
  }
}

void handlePairingAnswerPost() {
  pairCors();
  g_pairAnswer = webServer.arg("plain");
  webServer.send(200, "application/json", "{\"ok\":true}");
}

void handlePairingAnswerGet() {
  pairCors();
  if (g_pairAnswer.isEmpty()) {
    webServer.send(200, "application/json", "{\"pending\":false}");
  } else {
    String ans = g_pairAnswer;
    g_pairOffer = ""; g_pairAnswer = "";
    webServer.send(200, "application/json", ans);
  }
}

void handlePairingReject() {
  pairCors();
  g_pairOffer = ""; g_pairAnswer = "";
  webServer.send(200, "application/json", "{\"ok\":true}");
}

bool handleFileFromSPIFFS(const String &path){
  // Keep lightweight /state and session heartbeats alive during long WSPR TX,
  // but reject flash-backed asset transfers. Flash cache stalls can pause both
  // cores, including the dedicated audio task.
  if(txRealtimeNow()){
    webServer.sendHeader("Connection", "close");
    webServer.send(503, "text/plain", "asset transfer deferred during TX");
    return true;
  }
  webQuietUntil = millis() + 1500;
  String contentType = "text/plain";
  bool isStatic = false;
  if (path.endsWith(".html")) contentType = "text/html";
  else if (path.endsWith(".css"))  { contentType = "text/css";                  isStatic = true; }
  else if (path.endsWith(".js"))   { contentType = "application/javascript";    isStatic = true; }
  else if (path.endsWith(".wasm")) { contentType = "application/wasm";          isStatic = true; }
  else if (path.endsWith(".bin"))  { contentType = "application/octet-stream";  isStatic = true; }
  else if (path.endsWith(".br"))   { contentType = "application/octet-stream";  isStatic = true; }
  else if (path.endsWith(".ico"))  { contentType = "image/x-icon";              isStatic = true; }
  else if (path.endsWith(".png"))  { contentType = "image/png";                 isStatic = true; }
  // Never send an encoding the client did not advertise. In particular,
  // browsers normally omit Brotli on plain HTTP device pages.
  String acceptEncoding = webServer.header("Accept-Encoding");
  String brPath = path + ".br";
  String gzPath = path + ".gz";
  bool useBr = acceptEncoding.indexOf("br") >= 0 && LittleFS.exists(brPath);
  bool useGz = !useBr && acceptEncoding.indexOf("gzip") >= 0 && LittleFS.exists(gzPath);
  String servePath = useBr ? brPath : (useGz ? gzPath : path);
  if (!useBr && !useGz && !LittleFS.exists(path)) return false;
  File f = LittleFS.open(servePath, "r");
  if (!f) return false;

  if (isStatic) {
    webServer.sendHeader("Cache-Control", "public, max-age=3600");
  } else {
    webServer.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    webServer.sendHeader("Pragma", "no-cache");
  }
  if (useBr) webServer.sendHeader("Content-Encoding", "br");
  else if (useGz) webServer.sendHeader("Content-Encoding", "gzip");
  webServer.sendHeader("Vary", "Accept-Encoding");
  webServer.sendHeader("Connection", "close");
  webServer.setContentLength(f.size());
  webServer.send(200, contentType, "");

  // WiFiClient::write() may wait up to ten seconds for one buffer. A large
  // modem asset therefore used to hold webServer.handleClient() for minutes,
  // starving the IC-705 UDP keepalives. Use non-blocking socket writes and
  // explicitly service the real-time connections while TCP applies backpressure.
  WiFiClient webClient = webServer.client();
  webClient.setNoDelay(true);
  const int webFd = webClient.fd();
  static uint8_t buf[4096];
  size_t buffered = 0;
  size_t sent = 0;
  uint32_t lastProgress = millis();
  bool transferOk = webFd >= 0;
  while (transferOk && (sent < buffered || f.available())) {
    if (sent == buffered) {
      buffered = f.read(buf, sizeof(buf));
      sent = 0;
      if (buffered == 0) break;
    }

    int n = netSendNonBlocking(webFd, buf + sent, buffered - sent);
    if (n > 0) {
      sent += (size_t)n;
      lastProgress = millis();
    } else if (n < 0) {
      transferOk = false;
    }

    // Do not call webServer.handleClient() recursively here. The radio, TrxNet,
    // DX cluster and an already-open audio socket still need their normal ticks.
    lanClientLoop();
    TrxNetLoop();
    DxcLoop();
    AudioHandleWsClient();
    statusFlashTick();
    #if defined(WDT)
      esp_task_wdt_reset();
    #endif
    delay(0);

    // Abandon a dead browser instead of monopolising the firmware indefinitely.
    if (millis() - lastProgress > 15000) transferOk = false;
  }
  if (!transferOk) webClient.stop();
  f.close();
  webQuietUntil = millis() + 1500;
  return true;
}

void handlePostCmd(){
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String body = webServer.arg("plain");
  if (body.length() == 0) { webServer.send(400, "application/json", "{\"error\":\"empty body\"}"); return; }
  String type = extractJsonString(body, "type");

  // ?radio=lan addresses the radio JS8 drives, which is TRX1 only when the
  // operator put LAN there. Everything else still means the primary radio.
  uint8_t targetSlot = 0;
  if (webServer.arg("radio") == "lan") {
    uint8_t lanSlot = lanRadioSlotIndex();
    if (lanSlot != 0xFF) targetSlot = lanSlot;
  }

  if (radioSlots[targetSlot].transport == RADIO_TRXNET && type != "setFrequency") {
    webServer.send(409, "application/json",
                   "{\"error\":\"unsupported_transport\",\"transport\":\"trxnet\",\"capability\":\"tune_only\"}");
    return;
  }

  if (type == "abortCw") {
    #if defined(FSK_KEYING)
    char modesSnapshot[sizeof(modes)];
    copyModesText(modesSnapshot, sizeof(modesSnapshot));
    if (strcmp(modesSnapshot, "CW") == 0 && radioLinkUp() && radio_address != 0x00) {
      uint8_t frame[] = {START_BYTE, START_BYTE, radio_address, CONTROLLER_ADDRESS,
                         CMD_SEND_CW_MSG, 0xFF, STOP_BYTE};
      catWriteFrame(frame, sizeof(frame), true);
    } else if (strcmp(modesSnapshot, "RTTY") == 0) {
      abortFskTransmission = true;
    }
    #else
    if (radioLinkUp() && radio_address != 0x00) {
      char modesSnapshot[sizeof(modes)];
      copyModesText(modesSnapshot, sizeof(modesSnapshot));
      if (strcmp(modesSnapshot, "CW") == 0) {
        uint8_t frame[] = {START_BYTE, START_BYTE, radio_address, CONTROLLER_ADDRESS,
                           CMD_SEND_CW_MSG, 0xFF, STOP_BYTE};
        catWriteFrame(frame, sizeof(frame), true);
      }
    }
    #endif
    webServer.send(200, "application/json", "{\"ok\":true}");
    return;
  }

  // radio_address is TRX1's learned CI-V address and says nothing about another
  // slot, whose address comes from its own configuration.
  bool targetReady = targetSlot == 0 ? (radioLinkUp() && radio_address != 0x00)
                                     : radioSlotConnected(targetSlot);
  if (!targetReady) {
    webServer.send(503, "application/json", "{\"error\":\"radio_disconnected\"}");
    return;
  }

  if (type == "setFrequency") {
    uint32_t freq = (uint32_t)extractJsonString(body, "frequency").toInt();
    if (freq == 0) { webServer.send(400, "application/json", "{\"error\":\"invalid_frequency\"}"); return; }
    uint8_t frame[16];
    size_t len = buildSetFrequencyFrame(freq, frame, sizeof(frame));
    if (len == 0 || !catWriteFrameSlot(targetSlot, frame, len)) { webServer.send(500, "application/json", "{\"error\":\"tx_failed\"}"); return; }
    webServer.send(200, "application/json", "{\"ok\":true}");
    return;
  }

  if (type == "setMode") {
    uint8_t modeId, modeWidth;
    if (!parseModeId(extractJsonString(body, "mode"), modeId)) { webServer.send(400, "application/json", "{\"error\":\"invalid_mode\"}"); return; }
    modeWidth = parseFilterWidth(extractJsonString(body, "filter"));
    uint8_t frame[16];
    size_t len = buildSetModeFrame(modeId, modeWidth, frame, sizeof(frame));
    if (len == 0 || !catWriteFrameSlot(targetSlot, frame, len)) { webServer.send(500, "application/json", "{\"error\":\"tx_failed\"}"); return; }
    webServer.send(200, "application/json", "{\"ok\":true}");
    return;
  }


  if (type == "sendCw") {
    String text = extractJsonString(body, "text");
    if (text.length() == 0) { webServer.send(400, "application/json", "{\"error\":\"missing_text\"}"); return; }
    text.toCharArray(CwMsg, sizeof(CwMsg));
    // mode is preserved — sendCW() routes to CW/CW-R (CI-V) or RTTY/RTTY-R (FSK
    // GPIO) by the radio's current mode, and keys nothing in any other. This used
    // to answer ok:true regardless, which is a lie every caller acted on: the log
    // page recorded the report it believed it had sent while the radio sat silent.
    if (!sendCW()) {
      webServer.send(409, "application/json", "{\"error\":\"mode_cannot_key\"}");
      return;
    }
    webServer.send(200, "application/json", "{\"ok\":true}");
    return;
  }

  if (type == "civ.raw") {
    String hexData = extractJsonString(body, "data");
    uint8_t payload[32];
    size_t payloadLen = 0;
    if (!parseHexPayload(hexData, payload, payloadLen, sizeof(payload))) { webServer.send(400, "application/json", "{\"error\":\"invalid_hex\"}"); return; }
    uint8_t frame[40];
    size_t frameLen = buildSimpleCatFrame(payload[0], payload + 1, payloadLen - 1, frame, sizeof(frame));
    if (frameLen == 0 || !catWriteFrameSlot(targetSlot, frame, frameLen)) { webServer.send(500, "application/json", "{\"error\":\"tx_failed\"}"); return; }
    webServer.send(200, "application/json", "{\"ok\":true}");
    return;
  }

  // The read half of civ.raw. Same wire operation -- a CI-V frame with no payload
  // beyond the subaddress -- but it arms the capture first, so the reply has
  // somewhere to land. `seq` in the response is the value BEFORE the read: the
  // caller polls /civread until it moves, which is what tells a real answer apart
  // from the previous one and from no answer at all.
  if (type == "civ.read") {
    String hexData = extractJsonString(body, "data");
    uint8_t payload[CIV_READ_MAX];
    size_t payloadLen = 0;
    if (!parseHexPayload(hexData, payload, payloadLen, sizeof(payload)) || payloadLen == 0) {
      webServer.send(400, "application/json", "{\"error\":\"invalid_hex\"}"); return;
    }
    uint8_t frame[40];
    size_t frameLen = buildSimpleCatFrame(payload[0], payload + 1, payloadLen - 1, frame, sizeof(frame));
    if (frameLen == 0) { webServer.send(500, "application/json", "{\"error\":\"tx_failed\"}"); return; }
    civReadArm(payload, payloadLen);
    if (!catWriteFrameSlot(targetSlot, frame, frameLen)) { webServer.send(500, "application/json", "{\"error\":\"tx_failed\"}"); return; }
    webServer.send(200, "application/json",
                   "{\"ok\":true,\"seq\":" + String((unsigned long)civReadSeq) + "}");
    return;
  }

  webServer.send(400, "application/json", "{\"error\":\"unsupported_type\"}");
}

String configJsonEscape(const String &s) {
  String out;
  out.reserve(s.length() + 4);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"')       out += "\\\"";
    else if (c == '\\') out += "\\\\";
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if (c == '\t') out += "\\t";
    else if ((uint8_t)c < 0x20) {
      char esc[7];
      snprintf(esc, sizeof(esc), "\\u%04x", (uint8_t)c);
      out += esc;
    } else {
      out += c;
    }
  }
  return out;
}

static void eepromWriteStr(const String &str, int addr, int maxLen) {
  for (int i = 0; i < maxLen; i++) {
    EEPROM.write(addr + i, (i < (int)str.length()) ? (uint8_t)str[i] : 0xff);
  }
}

static String eepromReadStr(int addr, int maxLen) {
  String out;
  out.reserve(maxLen);
  for (int i = 0; i < maxLen; i++) {
    uint8_t c = EEPROM.read(addr + i);
    if (c == 0xff || c == 0x00) break;
    out += char(c);
  }
  return out;
}

bool hasPrimaryRadioConfig(void) {
  return EEPROM.read(PRIMARY_RADIO_MARKER_ADDR) == PRIMARY_RADIO_CONFIG_MARKER;
}

void loadPrimaryRadioConfig(void) {
  if (!hasPrimaryRadioConfig()) return;

  uint8_t transport = EEPROM.read(PRIMARY_RADIO_TRANSPORT_ADDR);
  // Bluetooth transport removed: stored transport 2 (BT) now falls back to LAN.
  if (transport == 3) transceiverType = "IC-7610-CI-V";
  else if (transport == 4) transceiverType = "TRXNET";
  else transceiverType = "ICOM-LAN";

  uint8_t civAddress = EEPROM.read(PRIMARY_RADIO_CIV_ADDR);
  configuredCivAddress = civAddress == 0xff ? CIV_ADDRESS_DEFAULT : civAddress;
  lanRadioIp = trimMemoryValue(eepromReadStr(PRIMARY_RADIO_LAN_IP_ADDR, 16), 15);
  lanUser = trimMemoryValue(eepromReadStr(PRIMARY_RADIO_LAN_USER_ADDR, 17), 16);
  lanPass = trimMemoryValue(eepromReadStr(PRIMARY_RADIO_LAN_PASS_ADDR, 17), 16);
  lanMode = transceiverType == "ICOM-LAN";
  Serial.println("CFG | TRX1 loaded from EEPROM/NVS: " + transceiverType +
                 " ip=" + lanRadioIp + " user='" + lanUser +
                 "' passlen=" + String(lanPass.length()));
}

bool savePrimaryRadioConfig(void) {
  uint8_t transport = 1;  // default LAN (Bluetooth transport removed)
  if (transceiverType == "IC-7610-CI-V") transport = 3;
  else if (transceiverType == "TRXNET") transport = 4;

  EEPROM.write(PRIMARY_RADIO_TRANSPORT_ADDR, transport);
  EEPROM.write(PRIMARY_RADIO_CIV_ADDR, configuredCivAddress);
  eepromWriteStr(trimMemoryValue(lanRadioIp, 15), PRIMARY_RADIO_LAN_IP_ADDR, 16);
  eepromWriteStr(trimMemoryValue(lanUser, 16), PRIMARY_RADIO_LAN_USER_ADDR, 17);
  eepromWriteStr(trimMemoryValue(lanPass, 16), PRIMARY_RADIO_LAN_PASS_ADDR, 17);
  // Write the marker last. EEPROM.commit() stores the complete emulated EEPROM
  // as one NVS blob, so an older firmware safely keeps using memories.cfg.
  EEPROM.write(PRIMARY_RADIO_MARKER_ADDR, PRIMARY_RADIO_CONFIG_MARKER);
  if (!EEPROM.commit()) {
    Serial.println("CFG | TRX1 EEPROM/NVS commit failed");
    return false;
  }
  Serial.println("CFG | TRX1 saved to EEPROM/NVS: " + transceiverType +
                 " ip=" + lanRadioIp + " user='" + lanUser +
                 "' passlen=" + String(lanPass.length()));
  return true;
}

void initLegacyRadioSlots(void) {
  radioSlots[0].enabled = true;
  radioSlots[0].transport = transceiverType == "TRXNET" ? RADIO_TRXNET
                          : transceiverType == "IC-7610-CI-V" ? RADIO_CIV
                                                              : RADIO_LAN;
  radioSlots[0].civAddr = configuredCivAddress;
  radioSlots[0].netId = 0x00;
  radioSlots[0].lanIp = lanRadioIp;
  radioSlots[0].lanUser = lanUser;
  radioSlots[0].lanPass = lanPass;

  radioSlots[1].transport = TRX2_CONN_TYPE == RADIO_LAN ? RADIO_LAN
                          : TRX2_CONN_TYPE == RADIO_CIV ? RADIO_CIV
                                                       : RADIO_TRXNET;
  radioSlots[1].civAddr = TRX2_CIV_ADDR;
  radioSlots[1].netId = (TRX2_NET_ID == 0xff) ? 0x00 : TRX2_NET_ID;
  radioSlots[1].enabled = radioSlots[1].transport == RADIO_LAN ? false
    : radioSlots[1].transport == RADIO_CIV
      ? radioSlots[1].civAddr != 0x00 && radioSlots[1].civAddr != 0xff
      : radioSlots[1].netId != 0x00 && radioSlots[1].netId != 0xff;

  radioSlots[2].transport = TRX3_CONN_TYPE == RADIO_LAN ? RADIO_LAN
                          : TRX3_CONN_TYPE == RADIO_CIV ? RADIO_CIV
                                                       : RADIO_TRXNET;
  radioSlots[2].civAddr = TRX3_CIV_ADDR;
  radioSlots[2].netId = (TRX3_NET_ID == 0xff) ? 0x00 : TRX3_NET_ID;
  radioSlots[2].enabled = radioSlots[2].transport == RADIO_LAN ? false
    : radioSlots[2].transport == RADIO_CIV
      ? radioSlots[2].civAddr != 0x00 && radioSlots[2].civAddr != 0xff
      : radioSlots[2].netId != 0x00 && radioSlots[2].netId != 0xff;
}

void syncLegacyRadioGlobals(void) {
  radioSlots[0].enabled = true;
  configuredCivAddress = radioSlots[0].civAddr;
  lanRadioIp = radioSlots[0].lanIp;
  lanUser = radioSlots[0].lanUser;
  lanPass = radioSlots[0].lanPass;
  if (radioSlots[0].transport == RADIO_CIV) transceiverType = "IC-7610-CI-V";
  else if (radioSlots[0].transport == RADIO_TRXNET) transceiverType = "TRXNET";
  else transceiverType = "ICOM-LAN";
  lanMode = radioSlots[0].transport == RADIO_LAN;

  TRX2_CONN_TYPE = (byte)radioSlots[1].transport;
  TRX3_CONN_TYPE = (byte)radioSlots[2].transport;
  TRX2_NET_ID = radioSlots[1].enabled && radioSlots[1].transport == RADIO_TRXNET
              ? radioSlots[1].netId : 0x00;
  TRX3_NET_ID = radioSlots[2].enabled && radioSlots[2].transport == RADIO_TRXNET
              ? radioSlots[2].netId : 0x00;
  TRX2_CIV_ADDR = radioSlots[1].enabled && radioSlots[1].transport == RADIO_CIV
                ? radioSlots[1].civAddr : 0x00;
  TRX3_CIV_ADDR = radioSlots[2].enabled && radioSlots[2].transport == RADIO_CIV
                ? radioSlots[2].civAddr : 0x00;
}

bool loadRadioConfig(void) {
  initLegacyRadioSlots();
  if (!cfgFS.exists(RADIO_CONFIG_PATH)) {
    syncLegacyRadioGlobals();
    radioConfigLoaded = false;
    return false;
  }

  File f = cfgFS.open(RADIO_CONFIG_PATH, "r");
  if (!f) {
    syncLegacyRadioGlobals();
    radioConfigLoaded = false;
    return false;
  }
  String json = f.readString();
  f.close();
  json.trim();
  if (!json.startsWith("{")) {
    syncLegacyRadioGlobals();
    radioConfigLoaded = false;
    return false;
  }

  for (uint8_t slot = 0; slot < 3; slot++) {
    char key[5];
    snprintf(key, sizeof(key), "trx%u", slot + 1);
    String obj = extractJsonObject(json, key);
    if (!obj.startsWith("{")) continue;

    radioSlots[slot].enabled =
      slot == 0 ? true : extractJsonBool(obj, "enabled", radioSlots[slot].enabled);
    String connection = extractJsonString(obj, "connection");
    if (connection.length()) {
      radioSlots[slot].transport =
        radioTransportFromName(connection.c_str(), radioSlots[slot].transport);
    }
    uint8_t parsed;
    String civ = extractJsonString(obj, "civaddr");
    if (civ.length() && parseHexByteString(civ, parsed)) radioSlots[slot].civAddr = parsed;
    String netid = extractJsonString(obj, "netid");
    if (netid.length() && parseHexByteString(netid, parsed)) radioSlots[slot].netId = parsed;
    if (obj.indexOf("\"lanip\"") >= 0)
      radioSlots[slot].lanIp = trimMemoryValue(extractJsonString(obj, "lanip"), 15);
    if (obj.indexOf("\"lanuser\"") >= 0)
      radioSlots[slot].lanUser = trimMemoryValue(extractJsonString(obj, "lanuser"), 16);
    if (obj.indexOf("\"lanpass\"") >= 0)
      radioSlots[slot].lanPass = trimMemoryValue(extractJsonString(obj, "lanpass"), 16);
    if (obj.indexOf("\"model\"") >= 0)
      radioSlots[slot].model = trimMemoryValue(extractJsonString(obj, "model"), 15);
  }

  syncLegacyRadioGlobals();
  radioConfigLoaded = true;
  // A model remembered from an earlier session is enough to label the slot, so the
  // SETUP page names the operator's actual radio before any link comes up.
  for (uint8_t slot = 0; slot < 3; slot++) adoptModelAsLabelIfUnset(slot);
  Serial.println("CFG | unified radio config loaded");
  return true;
}

bool saveRadioConfig(void) {
  String json;
  json.reserve(768);
  json = "{\"version\":1";
  for (uint8_t slot = 0; slot < 3; slot++) {
    char civ[3], netid[3];
    snprintf(civ, sizeof(civ), "%02X", radioSlots[slot].civAddr);
    snprintf(netid, sizeof(netid), "%02X", radioSlots[slot].netId);
    json += ",\"trx"; json += slot + 1; json += "\":{";
    json += "\"enabled\":"; json += (slot == 0 || radioSlots[slot].enabled) ? "true" : "false";
    json += ",\"connection\":\""; json += radioTransportName(radioSlots[slot].transport); json += "\"";
    json += ",\"civaddr\":\""; json += civ; json += "\"";
    json += ",\"netid\":\""; json += netid; json += "\"";
    json += ",\"lanip\":\""; json += configJsonEscape(radioSlots[slot].lanIp); json += "\"";
    json += ",\"lanuser\":\""; json += configJsonEscape(radioSlots[slot].lanUser); json += "\"";
    json += ",\"lanpass\":\""; json += configJsonEscape(radioSlots[slot].lanPass); json += "\"";
    json += ",\"model\":\"";   json += configJsonEscape(radioSlots[slot].model);   json += "\"";
    json += "}";
  }
  json += "}";

  File f = cfgFS.open(RADIO_CONFIG_PATH, "w");
  if (!f) return false;
  size_t written = f.print(json);
  f.flush();
  bool ok = written == json.length() && f.size() == json.length();
  f.close();
  if (ok) {
    radioConfigLoaded = true;
    syncLegacyRadioGlobals();
  }
  return ok;
}

IcomLanClient* radioLanClient(uint8_t slot) {
  if (slot == 0) return &lanClient;
  if (slot > 2) return nullptr;
  return secondaryLanClients[slot - 1];
}

// Which slot owns the LAN radio, or 0xFF when none does. Only one slot may be
// LAN (the SETUP page enforces it); should a hand-edited config sneak a second
// one past, the lowest slot wins so the audio channel has one deterministic
// owner instead of two clients fighting over the single AUD1 socket.
uint8_t lanRadioSlotIndex(void) {
  for (uint8_t slot = 0; slot < 3; slot++)
    if (radioSlots[slot].transport == RADIO_LAN && (slot == 0 || radioSlots[slot].enabled))
      return slot;
  return 0xFF;
}

// The client driving that radio. Null until the session has been allocated,
// which is normal for a secondary slot during the first connect attempt.
IcomLanClient* lanRadioClient(void) {
  uint8_t slot = lanRadioSlotIndex();
  return slot == 0xFF ? nullptr : radioLanClient(slot);
}

bool lanRadioConnected(void) {
  IcomLanClient* client = lanRadioClient();
  return client && client->connected();
}

bool lanRadioSendCommand(const uint8_t *body, size_t len) {
  IcomLanClient* client = lanRadioClient();
  return client && client->connected() && client->sendCommand(body, len);
}

bool lanRadioSendPriorityCommand(const uint8_t *body, size_t len,
                                 IcomLanClient::CivPriority priority) {
  IcomLanClient* client = lanRadioClient();
  return client && client->connected() && client->sendPriorityCommand(body, len, priority);
}

bool beginRadioLanClient(uint8_t slot) {
  if (slot > 2 || !radioSlots[slot].enabled || radioSlots[slot].transport != RADIO_LAN)
    return false;
  IPAddress radioIp;
  if (!radioIp.fromString(radioSlots[slot].lanIp)
      || radioSlots[slot].lanUser.length() == 0
      || radioSlots[slot].lanPass.length() == 0) {
    Serial.printf("LAN | TRX%u configuration incomplete\n", slot + 1);
    return false;
  }
  if (slot > 0 && secondaryLanClients[slot - 1] == nullptr) {
    secondaryLanClients[slot - 1] = new IcomLanClient();
    if (secondaryLanClients[slot - 1] == nullptr) {
      Serial.printf("LAN | TRX%u client allocation failed\n", slot + 1);
      return false;
    }
  }
  IcomLanClient* client = radioLanClient(slot);
  if (!client) return false;
  uint16_t localControlPort = radioLanLocalControlPort(slot);
  // Audio goes to the slot that owns the LAN radio, not to slot 0: the JS8 page
  // drives whichever TRX the operator put LAN on.
  bool withAudio = slot == lanRadioSlotIndex();
  if (withAudio && slot != lanRadioSnap.slot) lanRadioSnap = LanRadioSnapshot{};
  if (withAudio) lanRadioSnap.slot = slot;
  client->begin(radioIp, 50001,
                radioSlots[slot].lanUser.c_str(), radioSlots[slot].lanPass.c_str(),
                radioSlots[slot].civAddr, slot, localControlPort, withAudio);
  Serial.printf("LAN | TRX%u active on local ports %u-%u%s\n",
                slot + 1, localControlPort, localControlPort + 2,
                withAudio ? " (audio)" : "");
  return true;
}

bool radioSlotConnected(uint8_t slot) {
  if (slot > 2 || !radioSlots[slot].enabled) return false;
  if (radioSlots[slot].transport == RADIO_LAN) {
    IcomLanClient* client = radioLanClient(slot);
    return client && client->connected();
  }
  if (radioSlots[slot].transport == RADIO_TRXNET)
    return slot == 0 ? primaryTrxNetHasData : g_trxHasData[slot - 1];
  return slot == 0 ? primarySerialHasData : g_trxHasData[slot - 1];
}

// Has this slot been set up at all? Deliberately stricter for LAN than for the
// other two, because LAN is the only transport that can prove itself: the radio
// answers with its own model and rememberRadioModel() writes it down, which is
// durable evidence that a login once succeeded. CI-V and TrxNet leave no such
// trace, so there a configured address is the only evidence there is.
//
// NOT "is it connected" -- a radio that is switched off has not become
// unconfigured, and this decides where the bare IP leads.
bool radioSlotSetUp(uint8_t slot) {
  if (slot > 2 || !radioSlots[slot].enabled) return false;
  switch (radioSlots[slot].transport) {
    case RADIO_LAN:    return radioSlots[slot].model.length() > 0;
    case RADIO_TRXNET: return radioSlots[slot].netId != 0x00;
    case RADIO_CIV:    return radioSlots[slot].civAddr != 0x00;
    default:           return false;
  }
}

// A fresh device defaults to TRX1 on ICOM-LAN with no address and no model, so
// this is false exactly while nothing has been configured -- it cannot come out
// false for a working CI-V or TrxNet station.
bool stationRadioSetUp() {
  for (uint8_t slot = 0; slot < 3; slot++) if (radioSlotSetUp(slot)) return true;
  return false;
}

void radioSlotSetFrequencyState(uint8_t slot, uint32_t freq) {
  if (slot > 2) return;
  if (slot == 0) {
    frequency = freq;
    if (radio_address == 0x00) radio_address = radioSlots[0].civAddr;
    if (radioSlots[0].transport == RADIO_TRXNET) primaryTrxNetHasData = true;
    if (radioSlots[0].transport == RADIO_CIV) primarySerialHasData = true;
  } else {
    g_trxFreq[slot - 1] = (long)freq;
    g_trxHasData[slot - 1] = true;
  }
  if (bdEnabled && bdSource == slot + 1) bdUpdate(freq);
}

void radioSlotSetModeState(uint8_t slot, const char *mode) {
  if (slot > 2 || !mode) return;
  if (slot == 0) {
    setModesText(mode);
    if (radio_address == 0x00) radio_address = radioSlots[0].civAddr;
    if (radioSlots[0].transport == RADIO_TRXNET) primaryTrxNetHasData = true;
    if (radioSlots[0].transport == RADIO_CIV) primarySerialHasData = true;
  } else {
    strlcpy(g_trxMode[slot - 1], mode, sizeof(g_trxMode[slot - 1]));
    g_trxHasData[slot - 1] = true;
  }
}

// Audio-side lifecycle of whichever client owns the LAN radio: the one-shot
// safety un-key on every link-up (PTT is radio-held state and outlives a reset)
// and re-opening the RX audio channel for a DATA page that is already connected.
// Shared shape with the slot-0 path in lanClientLoop(); only one of the two runs
// for a given configuration, so the single lanLinkWasUp edge flag serves both.
void lanRadioAudioService(IcomLanClient *client) {
  if (!client || !client->connected()) { lanLinkWasUp = false; return; }
  if (!lanLinkWasUp) { lanLinkWasUp = true; audioPttSafetyOnLink(); }
  if (AudioWsClient.connected() && !client->rxAudioActive()) client->startRxAudio();
}

void secondaryLanClientsLoop(void) {
  if (APmode) return;
  if (icomScanSuspendLan) return;   // see lanClientLoop(): 50001 is borrowed
  uint32_t now = millis();
  uint8_t lanSlot = lanRadioSlotIndex();
  for (uint8_t slot = 1; slot < 3; slot++) {
    uint8_t idx = slot - 1;
    if (!radioSlots[slot].enabled || radioSlots[slot].transport != RADIO_LAN) {
      if (secondaryLanClients[idx]) secondaryLanClients[idx]->stop();
      continue;
    }
    IcomLanClient* client = secondaryLanClients[idx];
    // A manual reconnect from the JS8 page targets the LAN radio wherever it is.
    if (slot == lanSlot && lanReconnectRequested) {
      lanReconnectRequested = false;
      if (client) client->stop();
      secondaryLanRetryAt[idx] = 0;
      secondaryLanBackoff[idx] = 3000;
      Serial.printf("LAN | manual reconnect requested (TRX%u)\n", slot + 1);
      if (client) { beginRadioLanClient(slot); continue; }
    }
    if (!client) {
      if (secondaryLanRetryAt[idx] == 0 || (int32_t)(now - secondaryLanRetryAt[idx]) >= 0) {
        secondaryLanRetryAt[idx] = 0;
        if (!beginRadioLanClient(slot)) secondaryLanRetryAt[idx] = now + secondaryLanBackoff[idx];
      }
      continue;
    }
    client->loop();
    if (slot == lanSlot) lanRadioAudioService(client);
    if (client->connected()) {
      secondaryLanBackoff[idx] = 3000;
    } else {
      g_trxHasData[idx] = false;
      // Never leave TX showing on a link that is gone -- the page reads this as
      // "the radio is transmitting".
      if (slot == lanSlot) lanRadioSnap.tx = false;
      if (client->failed()) {
        client->stop();
        secondaryLanRetryAt[idx] = now + secondaryLanBackoff[idx];
        if (secondaryLanBackoff[idx] < 20000) secondaryLanBackoff[idx] *= 2;
      } else if (client->status() == IcomLanClient::LAN_IDLE
                 && secondaryLanRetryAt[idx]
                 && (int32_t)(now - secondaryLanRetryAt[idx]) >= 0) {
        secondaryLanRetryAt[idx] = 0;
        beginRadioLanClient(slot);
      }
    }
  }
}

// Normalize raw space-separated priority prefixes: uppercase, whitespace-collapsed,
// clamped to TRXNET_PRIO_MAX_TOKENS tokens x TRXNET_PRIO_MAX_TOKLEN chars. No globals touched.
static String trxNormalizePrio(const String &raw) {
  String out;
  uint8_t tokens = 0;
  int i = 0, n = raw.length();
  while (i < n && tokens < TRXNET_PRIO_MAX_TOKENS) {
    while (i < n && raw[i] == ' ') i++;
    if (i >= n) break;
    String tok;
    while (i < n && raw[i] != ' ') {
      if (tok.length() < TRXNET_PRIO_MAX_TOKLEN) tok += (char)toupper((unsigned char)raw[i]);
      i++;   // overflow chars of this token are dropped
    }
    if (tok.length() == 0) continue;
    if (out.length()) out += ' ';
    out += tok;
    tokens++;
  }
  return out;
}

// Fill the live token buffers from a normalized string (boot only — the library keeps
// a pointer into trxPrioBuf, so this must not run while net is actively using it).
static void trxLoadPrioBuffers(const String &canonical) {
  strncpy(trxPrioBuf, canonical.c_str(), TRXNET_PRIO_STR_MAX);
  trxPrioBuf[TRXNET_PRIO_STR_MAX] = '\0';
  trxPrioCount = 0;
  bool inTok = false;
  for (int k = 0; trxPrioBuf[k] != '\0'; k++) {
    if (trxPrioBuf[k] == ' ') { trxPrioBuf[k] = '\0'; inTok = false; }
    else if (!inTok) {
      if (trxPrioCount < TRXNET_PRIO_MAX_TOKENS) trxPrioPtrs[trxPrioCount++] = &trxPrioBuf[k];
      inTok = true;
    }
  }
}

// True if a device name matches any active priority prefix (same strncmp
// prefix semantics as TrxNet::setPriorityPrefixes()).
static bool trxIsPriorityName(const char* name) {
  for (uint8_t i = 0; i < trxPrioCount; i++) {
    if (trxPrioPtrs[i] && strncmp(name, trxPrioPtrs[i], strlen(trxPrioPtrs[i])) == 0)
      return true;
  }
  return false;
}

// Persist a normalized prefix string: flag 0x01 + string (empty string = priority off).
static void eepromWriteTrxPrio(const String &s) {
  EEPROM.writeByte(288, 0x01);
  for (int i = 0; i < TRXNET_PRIO_STR_MAX; i++) {
    EEPROM.write(289 + i, (i < (int)s.length()) ? (uint8_t)s[i] : 0xff);
  }
}

void handleConfigDownload() {
  char civHex[3];
  snprintf(civHex, sizeof(civHex), "%02X", configuredCivAddress);
  String j;
  j.reserve(2048);
  j += "{\"fwRev\":";           j += (unsigned)REV;
  j += ",\"ssid\":\"";          j += configJsonEscape(SSID);          j += "\"";
  j += ",\"pswd\":\"";          j += configJsonEscape(PSWD);          j += "\"";
  j += ",\"ssid2\":\"";         j += configJsonEscape(SSID2);         j += "\"";
  j += ",\"pswd2\":\"";         j += configJsonEscape(PSWD2);         j += "\"";
  j += ",\"trxnetid\":";        j += (unsigned)TRXNET_ID;
  j += ",\"trxnetport\":";      j += TRXNET_PORT;
  j += ",\"trxnetprio\":\"";    j += configJsonEscape(TRXNET_PRIO); j += "\"";
  j += ",\"trx2netid\":";       j += (unsigned)TRX2_NET_ID;
  j += ",\"trx2conntype\":";    j += TRX2_CONN_TYPE;
  { char h[3]; snprintf(h, sizeof(h), "%02x", TRX2_CIV_ADDR); j += ",\"trx2civaddr\":\""; j += h; j += "\""; }
  j += ",\"trx3netid\":";       j += (unsigned)TRX3_NET_ID;
  j += ",\"trx3conntype\":";    j += TRX3_CONN_TYPE;
  { char h[3]; snprintf(h, sizeof(h), "%02x", TRX3_CIV_ADDR); j += ",\"trx3civaddr\":\""; j += h; j += "\""; }
  j += ",\"baudrate\":";        j += BaudRate;
  j += ",\"trxprofile\":\"";    j += configJsonEscape(transceiverType); j += "\"";
  j += ",\"civaddr\":\"";       j += civHex;                          j += "\"";
  j += ",\"lanip\":\"";         j += configJsonEscape(lanRadioIp);     j += "\"";
  j += ",\"lanuser\":\"";       j += configJsonEscape(lanUser);        j += "\"";
  j += ",\"lanpass\":\"";       j += configJsonEscape(lanPass);        j += "\"";
  j += ",\"cwIpOnConnect\":";  j += cwIpOnConnect ? "true" : "false";
  for (uint8_t i = 0; i < CW_MEMORY_COUNT; i++) {
    j += ",\"cwmem"; j += (i + 1); j += "\":\""; j += configJsonEscape(cwMemoryText[i]); j += "\"";
  }
  for (uint8_t i = 0; i < FREQ_MEMORY_COUNT; i++) {
    j += ",\"freqmem"; j += (i + 1); j += "\":\""; j += configJsonEscape(freqMemoryText[i]); j += "\"";
  }
  j += ",\"dxchost\":\"";    j += configJsonEscape(DxcHost);     j += "\"";
  j += ",\"dxcport\":";      j += DxcPort;
  j += ",\"dxccall\":\"";    j += configJsonEscape(DxcCallsign); j += "\"";
  j += ",\"dxclocator\":\""; j += configJsonEscape(DxcLocator);  j += "\"";
  j += ",\"btname\":\"";     j += configJsonEscape(BT_NAME);     j += "\"";
  if (cfgFS.exists(RADIO_CONFIG_PATH)) {
    File radioFile = cfgFS.open(RADIO_CONFIG_PATH, "r");
    if (radioFile) {
      String radioJson = radioFile.readString();
      radioFile.close();
      radioJson.trim();
      if (radioJson.startsWith("{")) {
        j += ",\"radioConfig\":";
        j += radioJson;
      }
    }
  }
  String lc = readLogConfigJson();
  if (lc.startsWith("{")) {
    j += ",\"logConfig\":";
    j += lc;
  }
  // Calibrations are measurements, and the first full flash wipes the
  // filesystem -- so without this a reflash silently costs every band and power
  // the operator ever calibrated, each of them a 20 s carrier on the air to get
  // back. Embedded verbatim, exactly like radioConfig and logConfig above.
  if (cfgFS.exists(TXGAIN_CONFIG_PATH)) {
    File txgainFile = cfgFS.open(TXGAIN_CONFIG_PATH, "r");
    if (txgainFile) {
      String txgainJson = txgainFile.readString();
      txgainFile.close();
      txgainJson.trim();
      if (txgainJson.startsWith("{")) {
        j += ",\"txGain\":";
        j += txgainJson;
      }
    }
  }
  // The operating profile travels with the rest. It moved out of the browser in
  // 2026-08-08 precisely so it would stop being the one thing a backup could not
  // carry, and the restore below has to know the same key.
  if (cfgFS.exists(JS8_CONFIG_PATH)) {
    File js8File = cfgFS.open(JS8_CONFIG_PATH, "r");
    if (js8File) {
      String js8Json = js8File.readString();
      js8File.close();
      js8Json.trim();
      if (js8Json.startsWith("{")) {
        j += ",\"js8Config\":";
        j += js8Json;
      }
    }
  }
  if (bdEnabled) {
    j += ",\"bd\":{\"source\":"; j += bdSource;
    j += ",\"rows\":[";
    for (int i = 0; i < BD_ROWS; i++) {
      if (i > 0) j += ",";
      j += "{\"fMin\":"; j += bdRows[i].fMin;
      j += ",\"fMax\":"; j += bdRows[i].fMax;
      j += ",\"outputs\":"; j += bdRows[i].outputs;
      j += "}";
    }
    j += "]}";
  }
  j += "}";
  webServer.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  webServer.sendHeader("Pragma", "no-cache");
  webServer.sendHeader("Content-Disposition", "attachment; filename=\"wifilt-config.json\"");
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  webServer.send(200, "application/json", j);
}

void handleConfigUpload() {
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String body = webServer.arg("plain");
  if (body.length() == 0) { webServer.send(400, "application/json", "{\"error\":\"empty\"}"); return; }

  // Strings to EEPROM
  String ssid = extractJsonString(body, "ssid");
  if (ssid.length() >= 1 && ssid.length() <= 20) { SSID = ssid; eepromWriteStr(SSID, 1, 20); }

  String pswd = extractJsonString(body, "pswd");
  if (pswd.length() >= 1 && pswd.length() <= 18) { PSWD = pswd; eepromWriteStr(PSWD, 22, 18); }

  if (body.indexOf("\"ssid2\"") >= 0) {
    String ssid2 = extractJsonString(body, "ssid2");
    if (ssid2.length() <= 20) { SSID2 = ssid2; eepromWriteStr(SSID2, 76, 20); }
  }

  if (body.indexOf("\"pswd2\"") >= 0) {
    String pswd2 = extractJsonString(body, "pswd2");
    if (pswd2.length() <= 18) { PSWD2 = pswd2; eepromWriteStr(PSWD2, 97, 18); }
  }


  String trx = extractJsonString(body, "trxprofile");
  // Bluetooth transport removed; unified backups may also select TrxNet.
  if (trx == "IC-7610-CI-V") transceiverType = trx;
  else if (trx == "TRXNET") transceiverType = trx;
  else if (trx.length() > 0) transceiverType = "ICOM-LAN";

  if (body.indexOf("\"lanip\"") >= 0) {
    lanRadioIp = trimMemoryValue(extractJsonString(body, "lanip"), 15);
  }
  if (body.indexOf("\"lanuser\"") >= 0) {
    lanUser = trimMemoryValue(extractJsonString(body, "lanuser"), 16);
  }
  if (body.indexOf("\"lanpass\"") >= 0) {
    lanPass = trimMemoryValue(extractJsonString(body, "lanpass"), 16);
  }
  lanMode = transceiverType == "ICOM-LAN";

  String civStr = extractJsonString(body, "civaddr");
  uint8_t civAddr = configuredCivAddress;
  if (parseHexByteString(civStr, civAddr)) configuredCivAddress = civAddr;

  {
    int idx = body.indexOf("\"cwIpOnConnect\"");
    if (idx >= 0) {
      int colon = body.indexOf(':', idx);
      if (colon >= 0) {
        int vs = colon + 1;
        while (vs < (int)body.length() && body[vs] == ' ') vs++;
        bool v = body.substring(vs, vs + 4) == "true";
        cwIpOnConnect = v;
        EEPROM.writeBool(136, v);
      }
    }
  }


  // Integers to EEPROM
  auto parseField = [&](const char *key, int minVal, int maxVal) -> int {
    int idx = body.indexOf(String("\"") + key + "\":");
    if (idx < 0) return -1;
    int start = body.indexOf(':', idx) + 1;
    while (start < (int)body.length() && body[start] == ' ') start++;
    int end = start;
    while (end < (int)body.length() && (isDigit(body[end]) || body[end] == '-')) end++;
    int val = body.substring(start, end).toInt();
    return (val >= minVal && val <= maxVal) ? val : -1;
  };

  int v;
  v = parseField("trxnetid",  0, 255); if (v >= 0) { TRXNET_ID   = (byte)v; EEPROM.writeByte(41, v); }
  v = parseField("trx2netid", 0, 255); if (v >= 0) { TRX2_NET_ID = (byte)v; EEPROM.writeByte(42, v); }
  v = parseField("trx3netid", 0, 255); if (v >= 0) { TRX3_NET_ID = (byte)v; EEPROM.writeByte(43, v); }
  // EEPROM 44 TRX2_CONN_TYPE
  v = parseField("trx2conntype", 0, 2); if (v >= 0) { TRX2_CONN_TYPE = (byte)v; EEPROM.writeByte(44, v); }
  v = parseField("trxnetport", 1, 65534); if (v >= 0) { TRXNET_PORT = (uint16_t)v; EEPROM.writeUShort(45, v); }
  // EEPROM 288 flag + 289-359 TRXNET_PRIO
  if (body.indexOf("\"trxnetprio\"") >= 0) {
    TRXNET_PRIO = trxNormalizePrio(extractJsonString(body, "trxnetprio"));
    eepromWriteTrxPrio(TRXNET_PRIO);
  }
  // EEPROM 47 TRX3_CONN_TYPE
  v = parseField("trx3conntype", 0, 2); if (v >= 0) { TRX3_CONN_TYPE = (byte)v; EEPROM.writeByte(47, v); }
  // EEPROM 48/49 TRX2/3 CI-V address (hex string)
  {
    uint8_t a;
    String s2 = extractJsonString(body, "trx2civaddr");
    if (s2.length() > 0 && parseHexByteString(s2, a)) { TRX2_CIV_ADDR = a; EEPROM.writeByte(48, a); }
    String s3 = extractJsonString(body, "trx3civaddr");
    if (s3.length() > 0 && parseHexByteString(s3, a)) { TRX3_CIV_ADDR = a; EEPROM.writeByte(49, a); }
  }
  v = parseField("baudrate", 1200, 115200); if (v > 0) { BaudRate = v; EEPROM.writeUShort(74, v); }

  for (uint8_t i = 0; i < CW_MEMORY_COUNT; i++) {
    char key[10]; snprintf(key, sizeof(key), "cwmem%u", i + 1);
    cwMemoryText[i] = trimMemoryValue(extractJsonString(body, key), CW_MEMORY_MAX_LEN);
  }
  for (uint8_t i = 0; i < FREQ_MEMORY_COUNT; i++) {
    char key[12]; snprintf(key, sizeof(key), "freqmem%u", i + 1);
    freqMemoryText[i] = trimMemoryValue(extractJsonString(body, key), FREQ_MEMORY_MAX_LEN);
  }

  if (body.indexOf("\"dxchost\"") >= 0) {
    String dxchost = extractJsonString(body, "dxchost");
    if(dxchost.length() <= 64){ DxcHost = dxchost; eepromWriteStr(DxcHost, 137, 64); }
  }
  v = parseField("dxcport", 1, 65534); if(v >= 0){ DxcPort = v; EEPROM.writeUShort(201, v); }
  if (body.indexOf("\"dxccall\"") >= 0) {
    String dxccall = extractJsonString(body, "dxccall");
    if(dxccall.length() <= 16){ DxcCallsign = dxccall; eepromWriteStr(DxcCallsign, 203, 16); }
  }
  if (body.indexOf("\"dxclocator\"") >= 0) {
    String dxclocator = extractJsonString(body, "dxclocator");
    if(dxclocator.length() <= 6){ DxcLocator = dxclocator; eepromWriteStr(DxcLocator, 219, 6); }
  }

  if (body.indexOf("\"btname\"") >= 0) {
    String btname = extractJsonString(body, "btname");
    if (btname.length() >= 1 && btname.length() <= 20) { BT_NAME = btname; eepromWriteStr(BT_NAME, 267, 21); }
  }

  // A section that is present but too big used to be skipped in silence, and the
  // restore still answered {"ok":true}. That is the exact failure the comment
  // below was written to prevent: everything comes back except the calibrations,
  // and nothing says so until the operator goes looking for them weeks later.
  // Refuse the whole restore instead, and name what did not fit.
  auto rejectOversize = [&](const char *section, size_t got, size_t limit) {
    String j = "{\"ok\":false,\"error\":\"too_big\",\"section\":\"";
    j += section;
    j += "\",\"bytes\":"; j += (unsigned)got;
    j += ",\"limit\":";    j += (unsigned)limit;
    j += "}";
    webServer.send(409, "application/json", j);
  };

  {
    String logCfg = extractJsonObject(body, "logConfig");
    if (logCfg.length() > LOG_CONFIG_MAX_BYTES) {
      rejectOversize("logConfig", logCfg.length(), LOG_CONFIG_MAX_BYTES);
      return;
    }
    if (logCfg.length() > 0) saveLogConfigJson(logCfg);
  }

  {
    // Same key the download writes. A mismatch here would restore everything
    // except the calibrations and say nothing about it.
    String txgainCfg = extractJsonObject(body, "txGain");
    if (txgainCfg.length() > TXGAIN_MAX_BYTES) {
      rejectOversize("txGain", txgainCfg.length(), TXGAIN_MAX_BYTES);
      return;
    }
    if (txgainCfg.length() > 0) {
      File f = cfgFS.open(TXGAIN_CONFIG_PATH, "w");
      if (!f || f.print(txgainCfg) != txgainCfg.length()) {
        if (f) f.close();
        webServer.send(500, "application/json",
          "{\"ok\":false,\"error\":\"storage\",\"section\":\"txGain\"}");
        return;
      }
      f.close();
    }
  }

  {
    String js8Cfg = extractJsonObject(body, "js8Config");
    if (js8Cfg.length() > JS8_CONFIG_MAX_BYTES) {
      rejectOversize("js8Config", js8Cfg.length(), JS8_CONFIG_MAX_BYTES);
      return;
    }
    if (js8Cfg.length() > 0) {
      File f = cfgFS.open(JS8_CONFIG_PATH, "w");
      if (!f || f.print(js8Cfg) != js8Cfg.length()) {
        if (f) f.close();
        webServer.send(500, "application/json",
          "{\"ok\":false,\"error\":\"storage\",\"section\":\"js8Config\"}");
        return;
      }
      f.close();
    }
  }

  if (bdEnabled) {
    int bdIdx = body.indexOf("\"bd\":{");
    if (bdIdx >= 0) {
      String bdSection = body.substring(bdIdx + 5);
      int si = bdSection.indexOf("\"source\":");
      if (si >= 0) bdSource = bdSection.substring(si + 9).toInt();
      int arrStart = bdSection.indexOf("\"rows\":[");
      if (arrStart >= 0) {
        arrStart += 8;
        for (int i = 0; i < BD_ROWS; i++) {
          int ob = bdSection.indexOf('{', arrStart);
          int cb = bdSection.indexOf('}', ob);
          if (ob < 0 || cb < 0) break;
          String row = bdSection.substring(ob, cb + 1);
          bdRows[i].fMin    = (uint32_t)extractJsonInt(row, "fMin");
          bdRows[i].fMax    = (uint32_t)extractJsonInt(row, "fMax");
          bdRows[i].outputs = (uint16_t)extractJsonInt(row, "outputs");
          arrStart = cb + 1;
        }
      }
      bdSaveConfig();
    }
  }

  String uploadedRadioConfig = extractJsonObject(body, "radioConfig");
  if (uploadedRadioConfig.startsWith("{")) {
    File radioFile = cfgFS.open(RADIO_CONFIG_PATH, "w");
    if (!radioFile || radioFile.print(uploadedRadioConfig) != uploadedRadioConfig.length()) {
      if (radioFile) radioFile.close();
      webServer.send(500, "application/json", "{\"error\":\"radio_config_write\"}");
      return;
    }
    radioFile.close();
    if (!loadRadioConfig()) {
      webServer.send(400, "application/json", "{\"error\":\"radio_config_invalid\"}");
      return;
    }
  } else {
    // Backward-compatible import: translate the old asymmetric fields.
    initLegacyRadioSlots();
    if (!saveRadioConfig()) {
      webServer.send(500, "application/json", "{\"error\":\"radio_config_write\"}");
      return;
    }
  }

  syncLegacyRadioGlobals();
  EEPROM.writeByte(42, TRX2_NET_ID);
  EEPROM.writeByte(43, TRX3_NET_ID);
  EEPROM.writeByte(44, TRX2_CONN_TYPE);
  EEPROM.writeByte(47, TRX3_CONN_TYPE);
  EEPROM.writeByte(48, TRX2_CIV_ADDR);
  EEPROM.writeByte(49, TRX3_CIV_ADDR);
  EEPROM.writeBool(0, false);
  bool memorySaved = saveMemoryConfig();
  bool primarySaved = savePrimaryRadioConfig();
  if (!memorySaved || !primarySaved) {
    webServer.send(500, "application/json", "{\"error\":\"storage\"}");
    return;
  }

  webServer.send(200, "application/json", "{\"ok\":true}");
}

void handleGetLogConfig() {
  String spiffsJson = "{}";
  if (cfgFS.exists(LOG_CONFIG_PATH)) {
    File f = cfgFS.open(LOG_CONFIG_PATH, "r");
    if (f) { spiffsJson = f.readString(); f.close(); spiffsJson.trim(); }
  }
  // Inject EEPROM TrxNet peer IDs + CI-V conn type so frontend can derive whether
  // TRX2/3 is a remote (non-local) TRX, regardless of transport.
  String inject;
  inject += ",\"trx2netid\":"; inject += (unsigned)TRX2_NET_ID;
  inject += ",\"trx3netid\":"; inject += (unsigned)TRX3_NET_ID;
  inject += ",\"trx2conntype\":"; inject += (unsigned)TRX2_CONN_TYPE;
  inject += ",\"trx3conntype\":"; inject += (unsigned)TRX3_CONN_TYPE;
  inject += ",\"trx2enabled\":"; inject += radioSlots[1].enabled ? "true" : "false";
  inject += ",\"trx3enabled\":"; inject += radioSlots[2].enabled ? "true" : "false";
  inject += ",\"trx2transport\":\""; inject += radioTransportName(radioSlots[1].transport); inject += "\"";
  inject += ",\"trx3transport\":\""; inject += radioTransportName(radioSlots[2].transport); inject += "\"";
  // The labels as they stand NOW, which is not what the stored document says.
  // adoptModelAsLabelIfUnset() replaces a still-neutral "TRX1" with the model a
  // LAN radio reported, deliberately in RAM only -- the model is already
  // persisted in radio-config.json and an operator-typed label must keep
  // winning. But then QRPLog read the file and put "TRX1" on a button for a
  // radio that had told us it is an IC-705. These come last on purpose: a
  // repeated key resolves to its final value in JSON.parse, so this overrides
  // the stored label without rewriting the document to change a display string.
  inject += ",\"trx1Label\":\""; inject += configJsonEscape(g_lcTrx1Label); inject += "\"";
  inject += ",\"trx2Label\":\""; inject += configJsonEscape(g_lcTrx2Label); inject += "\"";
  inject += ",\"trx3Label\":\""; inject += configJsonEscape(g_lcTrx3Label); inject += "\"";
  String out;
  out.reserve(spiffsJson.length() + inject.length() + 4);
  if (spiffsJson.startsWith("{") && spiffsJson.length() > 2) {
    out = spiffsJson.substring(0, spiffsJson.length() - 1);
    out += inject;
    out += "}";
  } else {
    out = "{"; out += inject.substring(1); out += "}";
  }
  webServer.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  webServer.sendHeader("Pragma", "no-cache");
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  webServer.send(200, "application/json", out);
}

void handlePostLogConfig() {
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String body = webServer.arg("plain");
  body.trim();
  if (body.length() == 0 || body.length() > LOG_CONFIG_MAX_BYTES) {
    webServer.send(400, "application/json", "{\"error\":\"bad_request\"}");
    return;
  }
  if (body[0] != '{' || body[body.length()-1] != '}') {
    webServer.send(400, "application/json", "{\"error\":\"not_json\"}");
    return;
  }
  File f = cfgFS.open(LOG_CONFIG_PATH, "w");
  if (!f) { webServer.send(500, "application/json", "{\"error\":\"write\"}"); return; }
  f.print(body);
  f.close();
  loadLogConfigVars();
  webServer.send(200, "application/json", "{\"ok\":true}");
}

// ---- JS8 / WSPR operating profile --------------------------------------------
//
// A blob store, exactly like the calibration table: the browser owns the schema,
// the firmware owns the bytes. Anything else would put a second opinion about
// the schedule into C++.
void handleGetJs8Config() {
  webServer.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  if (!cfgFS.exists(JS8_CONFIG_PATH)) {
    // Empty, not 404: "this station has no profile yet" is a state, not a fault,
    // and it is the state the PROMOTE button in the browser looks for.
    webServer.send(200, "application/json", "{}");
    return;
  }
  File f = cfgFS.open(JS8_CONFIG_PATH, FILE_READ);
  if (!f) { webServer.send(500, "application/json", "{}"); return; }
  webServer.streamFile(f, "application/json");
  f.close();
}

void handlePostJs8Config() {
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String body = webServer.arg("plain");
  body.trim();
  if (body.length() == 0 || body.length() > JS8_CONFIG_MAX_BYTES) {
    String j = "{\"ok\":false,\"error\":\"too_big\",\"bytes\":";
    j += (unsigned)body.length();
    j += ",\"limit\":"; j += (unsigned)JS8_CONFIG_MAX_BYTES; j += "}";
    webServer.send(body.length() == 0 ? 400 : 409, "application/json", j);
    return;
  }
  if (body[0] != '{' || body[body.length()-1] != '}') {
    webServer.send(400, "application/json", "{\"ok\":false,\"error\":\"not_an_object\"}");
    return;
  }
  File f = cfgFS.open(JS8_CONFIG_PATH, "w");
  if (!f || f.print(body) != body.length()) {
    if (f) f.close();
    webServer.send(500, "application/json", "{\"ok\":false,\"error\":\"storage\"}");
    return;
  }
  f.close();
  webServer.send(200, "application/json", "{\"ok\":true}");
}

// ---- TX gain calibration table ----------------------------------------------
//
// A blob store, not a config endpoint. See TXGAIN_CONFIG_PATH.

// Callsign and locator are a fact about the STATION, not about a browser, and
// three pages used to keep their own answer: the DX cluster fields here, the JS8
// settings panel in localStorage, and the log's own per-log station call. The
// middle one is what WSPR reads, so which callsign went on the air depended on
// which tablet was open. They read from /setup-data.json now and write back
// here, so there is exactly one stored value.
//
// Deliberately its own endpoint rather than part of /setup/save: handleSet()
// discards any post without ssid and pswd, and neither DATA nor WSPR has the
// setup form to send.

// The read side. /setup-data.json answers the same two strings, but it is two
// kilobytes and it opens THREE files off the filesystem to build them -- fine
// once at page load, wrong for a page that re-reads the identity so an open
// tablet cannot go on beaconing under a callsign that was changed in SETUP
// minutes ago. This is two strings out of EEPROM shadow copies and nothing else.
void handleGetIdentity() {
  webServer.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  webServer.sendHeader("Connection", "close");
  String out = "{\"call\":\"";
  out += configJsonEscape(DxcCallsign);
  out += "\",\"grid\":\"";
  out += configJsonEscape(DxcLocator);
  out += "\"}";
  webServer.send(200, "application/json", out);
}

void handlePostIdentity() {
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String body = webServer.arg("plain");
  if (body.length() == 0 || body.length() > 256) {
    webServer.send(400, "application/json", "{\"ok\":false,\"error\":\"body\"}");
    return;
  }
  bool callChanged = false, wrote = false;
  if (body.indexOf("\"call\"") >= 0) {
    String call = extractJsonString(body, "call");
    call.toUpperCase();
    if (call.length() > 16) {
      webServer.send(400, "application/json", "{\"ok\":false,\"error\":\"call\"}");
      return;
    }
    if (call != DxcCallsign) {
      DxcCallsign = call;
      eepromWriteStr(DxcCallsign, 203, 16);
      callChanged = true;
      wrote = true;
    }
  }
  if (body.indexOf("\"grid\"") >= 0) {
    String grid = extractJsonString(body, "grid");
    grid.toUpperCase();
    if (grid.length() > 6) {
      webServer.send(400, "application/json", "{\"ok\":false,\"error\":\"grid\"}");
      return;
    }
    if (grid != DxcLocator) {
      DxcLocator = grid;
      eepromWriteStr(DxcLocator, 219, 6);
      wrote = true;
    }
  }
  if (wrote && !EEPROM.commit()) {
    webServer.send(500, "application/json", "{\"ok\":false,\"error\":\"storage\"}");
    return;
  }
  // The cluster logs in with the callsign, so a changed one has to be carried
  // to it -- otherwise the spots keep arriving addressed to the old station.
  if (callChanged) DxcRequestReconnect();
  String out = "{\"ok\":true,\"call\":\"";
  out += configJsonEscape(DxcCallsign);
  out += "\",\"grid\":\"";
  out += configJsonEscape(DxcLocator);
  out += "\"}";
  webServer.send(200, "application/json", out);
}

void handleGetTxGain() {
  webServer.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String json;
  if (cfgFS.exists(TXGAIN_CONFIG_PATH)) {
    File f = cfgFS.open(TXGAIN_CONFIG_PATH, "r");
    if (f) { json = f.readString(); f.close(); json.trim(); }
  }
  // An empty document rather than a 404. A radio that has never been calibrated
  // is the normal first state, not an error, and every caller would otherwise
  // have to treat "missing" and "empty" as the same thing anyway -- one of them
  // eventually forgetting to.
  //
  // Bare {} and not a versioned skeleton: the schema is the browser's, and this
  // used to answer with a hardcoded "v":1 that became a lie the moment the table
  // went to v2. The reader normalises a missing shape anyway.
  if (json.length() < 2 || json[0] != '{') json = "{}";
  webServer.send(200, "application/json", json);
}

void handlePostTxGain() {
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String body = webServer.arg("plain");
  body.trim();
  if (body.length() == 0 || body.length() > TXGAIN_MAX_BYTES) {
    webServer.send(400, "application/json", "{\"error\":\"bad_request\"}");
    return;
  }
  // The only two things worth checking here. Anything deeper would be the
  // firmware forming an opinion about a schema it does not own, and the browser
  // that wrote it is the same one that will read it back.
  if (body[0] != '{' || body[body.length()-1] != '}') {
    webServer.send(400, "application/json", "{\"error\":\"not_json\"}");
    return;
  }
  File f = cfgFS.open(TXGAIN_CONFIG_PATH, "w");
  if (!f) { webServer.send(500, "application/json", "{\"error\":\"write\"}"); return; }
  f.print(body);
  f.close();
  webServer.send(200, "application/json", "{\"ok\":true}");
}

// Mercury's own gain table -- identical shape and identical "the schema is
// the browser's" contract as handleGetTxGain/handlePostTxGain above, just a
// different file (see MERCURY_TXGAIN_CONFIG_PATH's own comment for why a
// separate one). Kept as separate functions rather than a shared helper
// parameterised on path: two call sites is not enough duplication to be
// worth the indirection, and it keeps each one grep-able on its own path.
void handleGetMercuryTxGain() {
  webServer.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String json;
  if (cfgFS.exists(MERCURY_TXGAIN_CONFIG_PATH)) {
    File mf = cfgFS.open(MERCURY_TXGAIN_CONFIG_PATH, "r");
    if (mf) { json = mf.readString(); mf.close(); json.trim(); }
  }
  if (json.length() < 2 || json[0] != '{') json = "{}";
  webServer.send(200, "application/json", json);
}

void handlePostMercuryTxGain() {
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String body = webServer.arg("plain");
  body.trim();
  if (body.length() == 0 || body.length() > MERCURY_TXGAIN_MAX_BYTES) {
    webServer.send(400, "application/json", "{\"error\":\"bad_request\"}");
    return;
  }
  if (body[0] != '{' || body[body.length()-1] != '}') {
    webServer.send(400, "application/json", "{\"error\":\"not_json\"}");
    return;
  }
  File mf = cfgFS.open(MERCURY_TXGAIN_CONFIG_PATH, "w");
  if (!mf) { webServer.send(500, "application/json", "{\"error\":\"write\"}"); return; }
  mf.print(body);
  mf.close();
  webServer.send(200, "application/json", "{\"ok\":true}");
}

// ---- the last CI-V reply a page asked for ------------------------------------
//
// Raw hex out, no interpretation. Unlike /txgain.json this must NOT invent an
// empty-but-valid answer: a firmware without this endpoint 404s, and that is how
// a page tells "flash the firmware" from "the radio never answered". Substituting
// a friendly default here would erase the difference.
void handleGetCivRead() {
  webServer.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String json = "{\"seq\":" + String((unsigned long)civReadSeq) + ",\"cmd\":\"";
  for (uint8_t i = 0; i < civReadPrefixLen; i++) {
    char hex[3];
    snprintf(hex, sizeof(hex), "%02X", civReadPrefix[i]);
    json += hex;
  }
  json += "\",\"reply\":\"";
  for (uint8_t i = 0; i < civReadReplyLen; i++) {
    char hex[3];
    snprintf(hex, sizeof(hex), "%02X", civReadReply[i]);
    json += hex;
  }
  json += "\",\"ageMs\":";
  json += String(civReadReplyLen && civReadAtMs ? (unsigned long)(millis() - civReadAtMs) : 0UL);
  json += "}";
  webServer.send(200, "application/json", json);
}


void handleOi3State() {
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String trxArg = webServer.arg("trx");
  int idx = trxArg.toInt() - 2; // trx=2 → 0, trx=3 → 1
  if (idx < 0 || idx > 1) {
    webServer.send(400, "application/json", "{\"error\":\"invalid_trx\"}");
    return;
  }
  char jbuf[96];
  snprintf(jbuf, sizeof(jbuf), "{\"connected\":%s,\"frequency\":%ld,\"mode\":\"%s\",\"dxcConnected\":%s}",
    g_trxHasData[idx] ? "true" : "false", g_trxFreq[idx], g_trxMode[idx],
    DxcTelnetStatus ? "true" : "false");
  webServer.send(200, "application/json", jbuf);
}

void handleOi3Send() {
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String body = webServer.arg("plain");
  String trxArg = extractJsonString(body, "trx");
  String text   = extractJsonString(body, "text");
  if (text.length() == 0) {
    webServer.send(400, "application/json", "{\"error\":\"missing\"}");
    return;
  }
  int trxN = trxArg.toInt();  // 2 or 3
  if (trxN < 2 || trxN > 3) {
    webServer.send(400, "application/json", "{\"error\":\"invalid_trx\"}");
    return;
  }
  RadioSlotConfig &cfg = radioSlots[trxN - 1];
  byte peerNetId = cfg.netId;
  if (!cfg.enabled || cfg.transport != RADIO_TRXNET
      || peerNetId == 0x00 || !trxNetEnabled) {
    webServer.send(503, "application/json", "{\"error\":\"unavailable\"}");
    return;
  }
  char peerName[TRXNET_MAX_DEVICE_NAME];
  snprintf(peerName, sizeof(peerName), "OI3.%02x", peerNetId);
  // Legacy abort: old clients sent text='\x03' (ETX); after extractJsonString fix it
  // arrives as a single 0x03 byte — treat it as abort, not CW text.
  if (text.length() == 1 && (uint8_t)text[0] == 0x03) {
    uint8_t stopByte = 0xFF;
    net.publishTo(peerName, "/s-cw", &stopByte, 1, TRX_CON);
    webServer.send(200, "application/json", "{\"ok\":true}");
    return;
  }
  if (!net.publishTo(peerName, "/s-cw", (const uint8_t*)text.c_str(), text.length(), TRX_CON)) {
    webServer.send(503, "application/json", "{\"error\":\"peer_unavailable\"}");
    return;
  }
  webServer.send(200, "application/json", "{\"ok\":true}");
}

void handleOi3AbortCw() {
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String body = webServer.arg("plain");
  String trxArg = extractJsonString(body, "trx");
  int trxN = trxArg.toInt();  // 2 or 3
  if (trxN < 2 || trxN > 3) {
    webServer.send(400, "application/json", "{\"error\":\"invalid_trx\"}");
    return;
  }
  RadioSlotConfig &cfg = radioSlots[trxN - 1];
  byte peerNetId = cfg.netId;
  if (!cfg.enabled || cfg.transport != RADIO_TRXNET
      || peerNetId == 0x00 || !trxNetEnabled) {
    webServer.send(503, "application/json", "{\"error\":\"unavailable\"}");
    return;
  }
  char peerName[TRXNET_MAX_DEVICE_NAME];
  snprintf(peerName, sizeof(peerName), "OI3.%02x", peerNetId);
  uint8_t stopByte = 0xFF;
  if (!net.publishTo(peerName, "/s-cw", &stopByte, 1, TRX_CON)) {
    webServer.send(503, "application/json", "{\"error\":\"peer_unavailable\"}");
    return;
  }
  webServer.send(200, "application/json", "{\"ok\":true}");
}

void handleOi3SetHz() {
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  String body = webServer.arg("plain");
  String trxArg = extractJsonString(body, "trx");
  int trxN = trxArg.toInt();  // 2 or 3
  if (trxN < 2 || trxN > 3) {
    webServer.send(400, "application/json", "{\"error\":\"invalid_trx\"}");
    return;
  }
  // hz comes as a number in JSON — parse manually
  int hzIdx = body.indexOf("\"hz\":");
  if (hzIdx < 0) { webServer.send(400, "application/json", "{\"error\":\"missing\"}"); return; }
  int start = body.indexOf(':', hzIdx) + 1;
  while (start < (int)body.length() && body[start] == ' ') start++;
  int end = start;
  while (end < (int)body.length() && isDigit(body[end])) end++;
  uint32_t hz = (uint32_t)body.substring(start, end).toInt();
  if (hz == 0) { webServer.send(400, "application/json", "{\"error\":\"bad_hz\"}"); return; }

  uint8_t slot = trxN - 1;
  RadioSlotConfig &cfg = radioSlots[slot];
  if (!cfg.enabled) {
    webServer.send(503, "application/json", "{\"error\":\"unavailable\"}");
    return;
  }
  if (cfg.transport == RADIO_CIV) {
    // CI-V transport: write frequency directly on the serial bus
    uint8_t civAddr = cfg.civAddr;
    if (civAddr == 0x00) {
      webServer.send(503, "application/json", "{\"error\":\"unavailable\"}");
      return;
    }
    civWriteFreq(civAddr, hz);
    webServer.send(200, "application/json", "{\"ok\":true}");
    return;
  }

  if (cfg.transport == RADIO_LAN) {
    IcomLanClient* client = radioLanClient(slot);
    if (!client || !client->connected()) {
      webServer.send(503, "application/json", "{\"error\":\"unavailable\"}");
      return;
    }
    String digits = IntToTenString((int)hz);
    String pairs[5];
    SplitString(digits, pairs);
    uint8_t command[6] = {CMD_WRITE_FREQ, 0, 0, 0, 0, 0};
    for (int i = 0; i < 5; i++) command[i + 1] = stringToByte(pairs[4 - i]);
    if (!client->sendCommand(command, sizeof(command))) {
      webServer.send(503, "application/json", "{\"error\":\"tx_failed\"}");
      return;
    }
    webServer.send(200, "application/json", "{\"ok\":true}");
    return;
  }

  byte peerNetId = cfg.netId;
  if (peerNetId == 0x00 || !trxNetEnabled) {
    webServer.send(503, "application/json", "{\"error\":\"unavailable\"}");
    return;
  }
  char peerName[TRXNET_MAX_DEVICE_NAME];
  snprintf(peerName, sizeof(peerName), "OI3.%02x", peerNetId);
  if (!net.publishTo(peerName, "/s-hz", (const uint8_t*)&hz, sizeof(hz))) {
    webServer.send(503, "application/json", "{\"error\":\"peer_unavailable\"}");
    return;
  }
  webServer.send(200, "application/json", "{\"ok\":true}");
}

// ---- APRS-IS igate ----------------------------------------------------------
//
// The browser decodes JS8, hears somebody address @APRSIS, and asks us to put
// that station's position (or its third-party text) on APRS-IS. Which messages
// deserve that is decided up in data/js8-aprs-gate.js, because that is where the
// blocked-callsign list and the DXCC table live. What is down here is the part
// the browser cannot do -- a TCP socket -- plus the three judgements that must
// NOT live in a browser:
//
//   the frame     it carries THIS station's callsign, so it is built here. A raw
//                 line accepted over HTTP would let anything on the LAN transmit
//                 under the operator's licence.
//   the duplicate the login now travels in the shared station profile, so every
//                 browser that opens DATA is a gate. Two tabs, or a tablet and a
//                 phone, would otherwise publish the same position twice under
//                 one callsign. The device is the only place that sees all of
//                 them, so the dedup ring lives here and the browser's copy is
//                 only a way to avoid a pointless POST.
//   the hourly cap for the same reason: a per-browser cap is no cap at all.
//
// Nothing in the request path touches the network. handleAprsisSpot() validates,
// builds and parks one line; aprsisLoop() resolves, connects, writes and reads
// the server's answer on later passes through loop(). That is not tidiness:
// WiFi.hostByName blocks for seconds and connect() for its whole timeout, and a
// web handler runs inside loop(), where the audio the radio is being fed from
// also lives.
//
// data/js8-aprs-gate.js is the reference implementation of every conversion
// below; tools/aprsis-conversion-parity.js compiles these functions out of this
// file and compares 16 000 conversions against it, so the two cannot drift.
//
// See docs/aprsis-igate-implementace.md.

static const char *APRSIS_TOCALL = "APJ8CL";
static const uint16_t APRSIS_CONNECT_TIMEOUT_MS = 500;
// How long the socket stays open after the write, waiting for the server's
// "# logresp <call> verified". Generous on purpose: 700 ms was a hard deadline
// that turned a working gate on a distant server into a permanent "pending",
// which is the one outcome the five badge states exist to distinguish. Nothing
// blocks while it runs -- the socket is drained from loop().
static const uint32_t APRSIS_LINGER_MS = 3000;
static const size_t   APRSIS_RESP_MAX = 200;
static const uint8_t  APRSIS_DEDUP_SLOTS = 16;

WiFiClient AprsClient;
IPAddress  aprsHostIp(0, 0, 0, 0);
String     aprsHostResolved = "";
uint32_t   aprsSeq = 0;              // 0 = nothing has been offered since boot
uint8_t    aprsResultState = 0;      // 0 idle, 1 pending, 2 verified, 3 unverified, 4 error
String     aprsResultServer = "";
String     aprsResultLine = "";
String     aprsRespBuf = "";
// One parked packet, waiting for loop() to carry it.
String     aprsPendingLine = "", aprsPendingLogin = "", aprsPendingHost = "";
uint16_t   aprsPendingPort = 0;
uint8_t    aprsPhase = 0;            // 0 idle, 1 parked, 2 socket open
uint32_t   aprsOpenedAtMs = 0;
// Elapsed-since, never a deadline: a bare "millis() > until" with `until` still
// at its initial 0 refuses everything for the 24 days between millis() passing
// 2^31 and wrapping, and the assignment that would fix it sits behind the very
// check that is failing.
uint32_t   aprsBackoffAtMs = 0, aprsBackoffMs = 0, aprsBackoffStep = 0;
// Recent packets, so a second browser (or a retry after a timed-out POST) cannot
// publish the same position twice.
uint32_t   aprsDedupHash[APRSIS_DEDUP_SLOTS] = {0};
uint32_t   aprsDedupAtMs[APRSIS_DEDUP_SLOTS] = {0};
uint32_t   aprsDedupSeq[APRSIS_DEDUP_SLOTS] = {0};
uint8_t    aprsDedupNext = 0;
// One counter per minute for the last hour: exact to the minute and 60 bytes,
// where a ring of timestamps would have to be as long as the highest cap.
uint8_t    aprsMinuteCount[60] = {0};
uint32_t   aprsMinuteAtMs = 0;
uint8_t    aprsMinuteIndex = 0;
uint16_t   aprsDedupMinutes = 10, aprsMaxPerHour = 30;

// The aprsc passcode hash. Not a secret -- it is a checksum of the callsign --
// but an unverified connection has its packets dropped in silence, so refusing
// here is the difference between a red field and hours of wondering why nothing
// shows up on aprs.fi. Odd-length callsigns XOR their last character into the
// high byte alone (the C original pairs it with the string's NUL terminator);
// N0CALL must come out 13023.
uint16_t aprsisPasscode(const String &call) {
  String root = call;
  int dash = root.indexOf('-');
  if (dash >= 0) root = root.substring(0, dash);
  root.toUpperCase();
  uint32_t hash = 0x73E2;
  int n = root.length();
  for (int i = 0; i < n; i += 2) {
    hash ^= ((uint32_t)(uint8_t)root[i]) << 8;
    if (i + 1 < n) hash ^= (uint32_t)(uint8_t)root[i + 1];
  }
  return (uint16_t)(hash & 0x7FFF);
}

// APRS-IS is line based, so a control character anywhere in a field is not a
// formatting problem -- it is a second packet. "\n" is a literal in the JS8
// alphabet, which means a station on the air could write one into the CMD text
// and have this box publish an arbitrary frame under the operator's callsign.
// Refused rather than stripped: the intent is not recoverable, and silently
// repairing hostile input teaches nobody anything.
bool aprsisFieldSafe(const String &value) {
  for (unsigned i = 0; i < value.length(); i++) {
    uint8_t c = (uint8_t)value[i];
    if (c < 0x20 || c == 0x7f) return false;
  }
  return true;
}

// AX.25 has no room for "/P": a numeric suffix becomes an SSID, anything else is
// dropped. What gets dropped reappears at the head of the comment, so portable
// operation stays visible on aprs.fi. The character filter mirrors the
// JavaScript oracle exactly -- without it a hostile `from` reached the source
// field, and the parity sweep could not see it because it only ever fed
// well-formed callsigns.
String aprsisCleanCall(const String &call) {
  String clean = "";
  for (unsigned i = 0; i < call.length(); i++) {
    char c = call[i];
    if (c >= 'a' && c <= 'z') c = c - 'a' + 'A';
    if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '/' || c == '-')
      clean += c;
  }
  return clean;
}

String aprsisSourceCall(const String &call) {
  String clean = aprsisCleanCall(call);
  int slash = clean.indexOf('/');
  if (slash < 0) return clean.substring(0, 9);
  String base = clean.substring(0, slash);
  String suffix = clean.substring(slash + 1);
  bool numeric = suffix.length() >= 1 && suffix.length() <= 2;
  for (unsigned i = 0; numeric && i < suffix.length(); i++)
    if (!isdigit((unsigned char)suffix[i])) numeric = false;
  return (numeric ? base + "-" + suffix : base).substring(0, 9);
}

// Locator -> APRS coordinate, CENTRE of the cell, in integer thousandths of a
// minute. Both halves of that sentence are load-bearing:
//
//   centre   JS8Call's grid2deg accumulates south-west corners and never adds
//            the half cell, so its spots sit ~1.2 km south and ~1.6 km west --
//            tens of kilometres on a four-character locator.
//   integer  half of the smallest cell is 0.125', so a position can land on an
//            exact x.xx5 rounding tie (JN79NX28 does). Floating point resolves
//            such a tie by whatever the last bit holds, and this C++ and the
//            JavaScript oracle would then disagree on the last digit for some
//            locators with nobody able to say which one is right.
//
// No 60.00-minute carry is needed and none is written: every term is a multiple
// of 125 (250 for longitude) thousandths, so the remainder never exceeds 59875.
// tools/js8-aprs-gate-smoke.js sweeps the grid to keep that claim honest.
bool aprsisGridToAprs(const String &grid, String &latOut, String &lonOut) {
  String g = grid;
  g.toUpperCase();
  size_t len = g.length();
  if (len != 4 && len != 6 && len != 8) return false;
  if (g[0] < 'A' || g[0] > 'R' || g[1] < 'A' || g[1] > 'R') return false;
  if (!isdigit((unsigned char)g[2]) || !isdigit((unsigned char)g[3])) return false;
  if (len >= 6 && (g[4] < 'A' || g[4] > 'X' || g[5] < 'A' || g[5] > 'X')) return false;
  if (len >= 8 && (!isdigit((unsigned char)g[6]) || !isdigit((unsigned char)g[7]))) return false;

  long lat = (long)(g[1] - 'A') * 600000L + (long)(g[3] - '0') * 60000L;
  long lon = (long)(g[0] - 'A') * 1200000L + (long)(g[2] - '0') * 120000L;
  long latHalf = 30000L, lonHalf = 60000L;          // half a 2 deg x 1 deg square
  if (len >= 6) {
    lat += (long)(g[5] - 'A') * 2500L;
    lon += (long)(g[4] - 'A') * 5000L;
    latHalf = 1250L; lonHalf = 2500L;               // half a 5' x 2.5' subsquare
  }
  if (len >= 8) {
    lat += (long)(g[7] - '0') * 250L;
    lon += (long)(g[6] - '0') * 500L;
    latHalf = 125L; lonHalf = 250L;
  }
  lat += latHalf - 5400000L;                        // from the south pole to the equator
  lon += lonHalf - 10800000L;                       // from the antimeridian to Greenwich

  char buf[16];
  long a = lat < 0 ? -lat : lat;
  snprintf(buf, sizeof(buf), "%02ld%02ld.%02ld%c", a / 60000L,
           ((a % 60000L) + 5) / 10 / 100, ((a % 60000L) + 5) / 10 % 100, lat < 0 ? 'S' : 'N');
  latOut = buf;
  a = lon < 0 ? -lon : lon;
  snprintf(buf, sizeof(buf), "%03ld%02ld.%02ld%c", a / 60000L,
           ((a % 60000L) + 5) / 10 / 100, ((a % 60000L) + 5) / 10 % 100, lon < 0 ? 'W' : 'E');
  lonOut = buf;
  return true;
}

// FNV-1a over the finished frame. The frame is deterministic, so the same
// position from two browsers hashes the same -- which is exactly the collision
// the dedup ring is looking for.
uint32_t aprsisHashLine(const String &line) {
  uint32_t hash = 2166136261u;
  for (unsigned i = 0; i < line.length(); i++) {
    hash ^= (uint8_t)line[i];
    hash *= 16777619u;
  }
  return hash;
}

// Ages the per-minute counters. Called from loop() and before every decision, so
// the hour is a sliding window and not a bucket that empties at :00.
void aprsisAgeMinutes() {
  uint32_t now = millis();
  if (aprsMinuteAtMs == 0) { aprsMinuteAtMs = now; return; }
  uint32_t elapsed = now - aprsMinuteAtMs;
  if (elapsed >= 3600000UL) {              // idle for an hour: the whole window is stale
    memset(aprsMinuteCount, 0, sizeof(aprsMinuteCount));
    aprsMinuteAtMs = now;
    return;
  }
  while (elapsed >= 60000UL) {
    aprsMinuteAtMs += 60000UL;
    elapsed -= 60000UL;
    aprsMinuteIndex = (aprsMinuteIndex + 1) % 60;
    aprsMinuteCount[aprsMinuteIndex] = 0;
  }
}

uint16_t aprsisSentLastHour() {
  uint16_t total = 0;
  for (uint8_t i = 0; i < 60; i++) total += aprsMinuteCount[i];
  return total;
}

// Returns the seq of the earlier packet, or 0. Only packets that were actually
// written are in the ring, so a genuine retry after a failed connect is not
// mistaken for a duplicate.
uint32_t aprsisDuplicateOf(uint32_t hash) {
  uint32_t window = (uint32_t)aprsDedupMinutes * 60000UL;
  for (uint8_t i = 0; i < APRSIS_DEDUP_SLOTS; i++) {
    if (aprsDedupHash[i] != hash || aprsDedupAtMs[i] == 0) continue;
    if ((uint32_t)(millis() - aprsDedupAtMs[i]) < window) return aprsDedupSeq[i];
  }
  return 0;
}

void aprsisRememberSent(uint32_t hash, uint32_t seq) {
  aprsDedupHash[aprsDedupNext] = hash;
  aprsDedupAtMs[aprsDedupNext] = millis();
  aprsDedupSeq[aprsDedupNext] = seq;
  aprsDedupNext = (aprsDedupNext + 1) % APRSIS_DEDUP_SLOTS;
  aprsisAgeMinutes();
  if (aprsMinuteCount[aprsMinuteIndex] < 255) aprsMinuteCount[aprsMinuteIndex]++;
}

bool aprsisBackoffActive() {
  return aprsBackoffMs != 0 && (uint32_t)(millis() - aprsBackoffAtMs) < aprsBackoffMs;
}

void aprsisNoteConnectFailure() {
  // 5 s, half a minute, five minutes. A server that is down stays down for a
  // while, and the browser's own five-minute TTL drops the packet before this
  // ladder reaches its top step.
  aprsBackoffStep = aprsBackoffStep < 5000 ? 5000
                  : (aprsBackoffStep < 30000 ? 30000 : 300000);
  aprsBackoffAtMs = millis();
  aprsBackoffMs = aprsBackoffStep;
  aprsResultState = 4;
  aprsResultLine = "connect failed";
  aprsPhase = 0;
  aprsPendingLine = "";
}

// The whole network side, on a later pass through loop(). Resolve, connect,
// write, drain, close -- one step per call where it can be, and never inside a
// web handler.
void aprsisLoop() {
  aprsisAgeMinutes();

  if (aprsPhase == 2) {
    while (AprsClient.available() && aprsRespBuf.length() < APRSIS_RESP_MAX)
      aprsRespBuf += (char)AprsClient.read();
    // "unverified" contains "verified", so the refusal has to be tested first.
    if (aprsResultState == 1 && aprsRespBuf.indexOf("logresp") >= 0) {
      if (aprsRespBuf.indexOf("unverified") >= 0) aprsResultState = 3;
      else if (aprsRespBuf.indexOf("verified") >= 0) aprsResultState = 2;
      if (aprsResultState != 1) {
        int at = aprsRespBuf.indexOf("logresp");
        int end = aprsRespBuf.indexOf('\n', at);
        int from = aprsRespBuf.lastIndexOf('#', at);
        aprsResultLine = aprsRespBuf.substring(from < 0 ? at : from,
                                               end < 0 ? aprsRespBuf.length() : end);
        aprsResultLine.trim();
        int server = aprsResultLine.indexOf("server ");
        if (server >= 0) {
          aprsResultServer = aprsResultLine.substring(server + 7);
          aprsResultServer.trim();
        }
      }
    }
    // Closed as soon as the verdict is in; the linger is only the ceiling.
    if (aprsResultState != 1 || (uint32_t)(millis() - aprsOpenedAtMs) >= APRSIS_LINGER_MS) {
      AprsClient.stop();
      aprsPhase = 0;
    }
    return;
  }

  if (aprsPhase != 1) return;
  // The two blocking calls in this function are guarded exactly as the DX
  // cluster client guards its own: never while the transmitter is keyed.
  if (txRealtimeNow()) return;
  if (aprsisBackoffActive()) return;
  if (!WiFiStationReady()) return;

  if ((uint32_t)aprsHostIp == 0 || aprsHostResolved != aprsPendingHost) {
    IPAddress ip;
    if (!WiFi.hostByName(aprsPendingHost.c_str(), ip)) {
      aprsisNoteConnectFailure();
      aprsResultLine = "dns failed";
      return;
    }
    aprsHostIp = ip;
    aprsHostResolved = aprsPendingHost;
  }
  if (!AprsClient.connect(aprsHostIp, aprsPendingPort, APRSIS_CONNECT_TIMEOUT_MS)) {
    aprsHostIp = IPAddress();       // a stale address re-resolves on the next attempt
    AprsClient.stop();
    aprsisNoteConnectFailure();
    return;
  }
  AprsClient.setNoDelay(true);
  AprsClient.println(aprsPendingLogin);
  AprsClient.println(aprsPendingLine);
  // Recorded only now: a packet that never reached the socket must stay
  // retryable, and one that did must never go out twice.
  aprsisRememberSent(aprsisHashLine(aprsPendingLine), aprsSeq);
  aprsBackoffStep = 0;
  aprsBackoffMs = 0;
  aprsRespBuf = "";
  aprsOpenedAtMs = millis();
  aprsPendingLine = "";
  aprsPhase = 2;
}

void handleAprsisSpot() {
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  aprsisAgeMinutes();
  // One packet at a time. 503 is not a failure -- the browser holds it and asks
  // again, which is what its queue is for.
  if (aprsPhase != 0) {
    webServer.send(503, "application/json", "{\"ok\":false,\"error\":\"busy\"}");
    return;
  }
  if (aprsisBackoffActive()) {
    webServer.send(503, "application/json", "{\"ok\":false,\"error\":\"backoff\"}");
    return;
  }
  if (!WiFiStationReady()) {
    webServer.send(503, "application/json", "{\"ok\":false,\"error\":\"offline\"}");
    return;
  }
  String body = webServer.arg("plain");
  if (body.length() == 0 || body.length() > 1024) {
    webServer.send(400, "application/json", "{\"ok\":false,\"error\":\"body\"}");
    return;
  }
  String login = extractJsonObject(body, "login");
  String packet = extractJsonObject(body, "packet");
  String call = extractJsonString(login, "call");
  String pass = extractJsonString(login, "pass");
  String host = extractJsonString(login, "host");
  int port = extractJsonInt(login, "port");
  call.toUpperCase();
  if (call.length() < 3 || call.length() > 9 || host.length() == 0 ||
      port <= 0 || port > 65535 ||
      !aprsisFieldSafe(call) || !aprsisFieldSafe(host)) {
    webServer.send(400, "application/json", "{\"ok\":false,\"error\":\"login\"}");
    return;
  }
  // The same refusal JS8Call makes silently (APRSISClient.h:51). Said out loud
  // here, because a gate that looks busy and delivers nothing is the worst of
  // the available behaviours.
  if (pass != String(aprsisPasscode(call))) {
    webServer.send(400, "application/json", "{\"ok\":false,\"error\":\"passcode\"}");
    return;
  }
  // The operator's policy, clamped: it arrives from a browser, and the ceiling
  // it sets is the one thing standing between a hostile station and unlimited
  // traffic under this callsign.
  int dedupMinutes = extractJsonInt(login, "dedupMinutes");
  int maxPerHour = extractJsonInt(login, "maxPerHour");
  if (dedupMinutes >= 1 && dedupMinutes <= 120) aprsDedupMinutes = dedupMinutes;
  if (maxPerHour >= 1 && maxPerHour <= 240) aprsMaxPerHour = maxPerHour;

  String kind = extractJsonString(packet, "kind");
  String from = extractJsonString(packet, "from");
  String source = aprsisSourceCall(from);
  if (source.length() < 3) {
    webServer.send(400, "application/json", "{\"ok\":false,\"error\":\"from\"}");
    return;
  }
  String line = source + ">" + APRSIS_TOCALL + ",qAR," + call + ":";
  if (kind == "cmd") {
    String text = extractJsonString(packet, "text");
    // The browser normalised the nine-character addressee; this refuses what is
    // not an APRS message at all, and -- the reason this check exists -- any
    // control character, which would end the line and start a second packet.
    if (text.length() < 4 || text[0] != ':' || text.indexOf(':', 1) < 0 ||
        !aprsisFieldSafe(text)) {
      webServer.send(400, "application/json", "{\"ok\":false,\"error\":\"text\"}");
      return;
    }
    line += text;
  } else if (kind == "grid") {
    String lat, lon;
    if (!aprsisGridToAprs(extractJsonString(packet, "grid"), lat, lon)) {
      webServer.send(400, "application/json", "{\"ok\":false,\"error\":\"grid\"}");
      return;
    }
    // Identical to JS8Call's spot comment: "<MHz>MHz <SNR>dB", six decimals, the
    // frequency being dial + audio offset. A portable callsign goes in front,
    // because the source field above had to drop the suffix.
    int snr = extractJsonInt(packet, "snrDb");
    long hz = (long)extractJsonInt(packet, "freqHz");
    // The comment shows the callsign as it was heard, suffix included -- but
    // through the same character filter the source field went through, or the
    // sanitising above would be undone by the comment.
    String heard = aprsisCleanCall(from);
    String prefix = heard.indexOf('/') >= 0 ? heard + " " : String("");
    char comment[64];
    if (hz > 0)
      snprintf(comment, sizeof(comment), "%s%.6fMHz %+03ddB", prefix.c_str(), hz / 1e6, snr);
    else
      snprintf(comment, sizeof(comment), "%s%+03ddB", prefix.c_str(), snr);
    comment[42] = 0;                       // APRS comment limit, as upstream
    // String() on the front deliberately: a chain that starts with two string
    // literals is pointer arithmetic, not concatenation, and the second half of
    // this line is exactly the kind of expression where that goes unnoticed.
    line += String("=") + lat + "/" + lon + "G#JS8 " + comment;
  } else {
    webServer.send(400, "application/json", "{\"ok\":false,\"error\":\"kind\"}");
    return;
  }
  // Last line of defence, whatever the fields did on the way here.
  if (!aprsisFieldSafe(line)) {
    webServer.send(400, "application/json", "{\"ok\":false,\"error\":\"text\"}");
    return;
  }

  // Now the two judgements the browser cannot be trusted with, because there is
  // more than one browser.
  uint32_t hash = aprsisHashLine(line);
  uint32_t twin = aprsisDuplicateOf(hash);
  if (twin) {
    String out = "{\"ok\":false,\"error\":\"duplicate\",\"seq\":";
    out += twin;
    out += "}";
    webServer.send(409, "application/json", out);
    return;
  }
  if (aprsisSentLastHour() >= aprsMaxPerHour) {
    webServer.send(429, "application/json", "{\"ok\":false,\"error\":\"hourly_cap\"}");
    return;
  }

  aprsSeq++;
  aprsResultState = 1;
  aprsResultServer = "";
  aprsResultLine = "";
  aprsPendingLine = line;
  aprsPendingLogin = "user " + call + " pass " + pass + " vers wifilt " + String(REV);
  aprsPendingHost = host;
  aprsPendingPort = (uint16_t)port;
  aprsPhase = 1;
  // 202, not 200: the packet is accepted, not yet written. What became of it is
  // in /aprsis/status, which is also where the server's verdict arrives.
  String out = "{\"ok\":true,\"seq\":";
  out += aprsSeq;
  out += ",\"sent\":\"";
  out += configJsonEscape(line);
  out += "\"}";
  webServer.send(202, "application/json", out);
}

// The verdict on the LAST packet only -- hence seq. An older packet's result is
// never reported under a newer number: lying about somebody else's outcome is
// worse than admitting the answer is gone.
void handleAprsisStatus() {
  webServer.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  webServer.sendHeader("Connection", "close");
  aprsisAgeMinutes();
  const char *state = aprsResultState == 2 ? "verified"
                    : aprsResultState == 3 ? "unverified"
                    : aprsResultState == 4 ? "error"
                    : aprsResultState == 1 ? "pending" : "idle";
  String out = "{\"seq\":";
  out += aprsSeq;
  out += ",\"state\":\"";
  out += state;
  out += "\",\"server\":\"";
  out += configJsonEscape(aprsResultServer);
  out += "\",\"line\":\"";
  out += configJsonEscape(aprsResultLine);
  out += "\",\"sentLastHour\":";
  out += aprsisSentLastHour();
  out += ",\"maxPerHour\":";
  out += aprsMaxPerHour;
  out += "}";
  webServer.send(200, "application/json", out);
}

void setupWebServer(void){
  const char *requestHeaders[] = {"Accept-Encoding"};
  webServer.collectHeaders(requestHeaders, 1);
  webServer.on("/state", HTTP_GET, handleGetState);
  webServer.on("/unattended", HTTP_GET, handleUnattendedGet);
  webServer.on("/unattended", HTTP_POST, handleUnattendedPost);
  webServer.on("/unattended/log", HTTP_GET, handleUnattendedLog);
  webServer.on("/js8/session",         HTTP_GET,  handleJs8SessionGet);
  webServer.on("/js8/session/claim",   HTTP_POST, handleJs8SessionClaim);
  webServer.on("/js8/session/ping",    HTTP_POST, handleJs8SessionPing);
  webServer.on("/js8/session/release", HTTP_POST, handleJs8SessionRelease);
  // Same handlers, same js8Session record -- docs/mercury-implementace.md
  // decision 5's "own lease" is its own URL and busy-dialog wording (see
  // js8SessionRespond's mercuryName/Percent/RemainingMs fields), not a second
  // lock. AUD1 ownership is checked in exactly one place
  // (AudioHandleWsUpgrade -> js8SessionOwns(js8Session, ...)); a genuinely
  // separate record would either never get audio or need that check taught
  // about two locks, and either way risks silently taking JS8LAN/WSPR's
  // audio out from under a live operator.
  webServer.on("/mercury/session",         HTTP_GET,  handleJs8SessionGet);
  webServer.on("/mercury/session/claim",   HTTP_POST, handleJs8SessionClaim);
  webServer.on("/mercury/session/ping",    HTTP_POST, handleJs8SessionPing);
  webServer.on("/mercury/session/release", HTTP_POST, handleJs8SessionRelease);
  webServer.on("/msgbox", HTTP_GET, handleMsgboxGet);
  webServer.on("/msgbox", HTTP_POST, handleMsgboxPost);
  webServer.on("/cmd", HTTP_POST, handlePostCmd);
  webServer.on("/lan/reconnect", HTTP_POST, [](){
    webServer.sendHeader("Connection", "close");
    webServer.client().setNoDelay(true);
    // Whichever slot owns the LAN radio; the loop that services it picks the
    // request up (lanClientLoop for TRX1, secondaryLanClientsLoop otherwise).
    if (lanRadioSlotIndex() == 0xFF) {
      webServer.send(409, "application/json", "{\"ok\":false,\"error\":\"lan_not_active\"}");
      return;
    }
    lanReconnectRequested = true;
    webServer.send(202, "application/json", "{\"ok\":true}");
  });
  webServer.on("/config/download", HTTP_GET,  handleConfigDownload);
  webServer.on("/config/upload",   HTTP_POST, handleConfigUpload);
  webServer.on("/log-config", HTTP_GET,  handleGetLogConfig);
  webServer.on("/log-config", HTTP_POST, handlePostLogConfig);
  webServer.on("/identity",   HTTP_GET,  handleGetIdentity);
  webServer.on("/identity",   HTTP_POST, handlePostIdentity);
  webServer.on("/js8-config.json", HTTP_GET,  handleGetJs8Config);
  webServer.on("/js8-config.json", HTTP_POST, handlePostJs8Config);
  webServer.on("/txgain.json", HTTP_GET,  handleGetTxGain);
  webServer.on("/txgain.json", HTTP_POST, handlePostTxGain);
  webServer.on("/mercury-txgain.json", HTTP_GET,  handleGetMercuryTxGain);
  webServer.on("/mercury-txgain.json", HTTP_POST, handlePostMercuryTxGain);
  webServer.on("/aprsis/spot",   HTTP_POST, handleAprsisSpot);
  webServer.on("/aprsis/status", HTTP_GET,  handleAprsisStatus);
  webServer.on("/civread",     HTTP_GET,  handleGetCivRead);
  webServer.on("/gps",         HTTP_GET,  handleGetGps);
  webServer.on("/oi3/state",    HTTP_GET,  handleOi3State);
  webServer.on("/oi3/send",     HTTP_POST, handleOi3Send);
  webServer.on("/oi3/abort-cw", HTTP_POST, handleOi3AbortCw);
  webServer.on("/oi3/set-hz",   HTTP_POST, handleOi3SetHz);

  webServer.on("/", HTTP_GET, [](){
    // A fresh device starts in configuration AP mode.  Opening its bare IP
    // must lead directly to Setup. In station mode JS8LAN is the home page --
    // but only once there is a radio to point it at. Until then /data would
    // answer with the gate card telling the operator to go to Setup, so the
    // sequence was being carried by a refusal instead of by an instruction.
    // Setup is the home page of a station that is not set up yet; its tab bar
    // still carries QRPLog, DATA and LOGSYNC, so this leads without trapping.
    if (APmode || !stationRadioSetUp()) { renderSetupPage(); return; }
    webServer.sendHeader("Location", "/data", true);
    webServer.send(302, "text/plain", "");
  });

  webServer.on("/setup/save", HTTP_POST, [](){
    webServer.sendHeader("Connection", "close");
    webServer.client().setNoDelay(true);
    handleSet();
    if (setupSaveOk) {
      webServer.send(200, "application/json", "{\"ok\":true}");
    } else {
      // Why the save was refused. handleSet() has filled these in since the
      // server-rendered setup page existed, but that page was replaced by one
      // the browser fills from /config -- and nothing carried the reason across,
      // so every refusal arrived as a bare 400. The page reads "error".
      String err = setupSsidErr;
      if (err.length() == 0) err = setupPswdErr;
      if (err.length() == 0) err = setupSsid2Err;
      if (err.length() == 0) err = setupPswd2Err;
      if (err.length() == 0) err = setupCivAddrErr;
      String body = "{\"ok\":false,\"error\":\"";
      body += configJsonEscape(err);
      body += "\"}";
      webServer.send(400, "application/json", body);
    }
  });
  webServer.on("/setup",   HTTP_GET,  [](){ renderSetupPage(); });
  webServer.on("/setup",   HTTP_POST, [](){ handleSet(); renderSetupPage(); });
  webServer.on("/setup-data.json", HTTP_GET, handleSetupData);
  webServer.on("/icom/scan",      HTTP_POST, handleIcomScanStart);
  webServer.on("/icom/scan.json", HTTP_GET,  handleIcomScanStatus);
  webServer.on("/icom/test",      HTTP_POST, handleIcomTestStart);
  webServer.on("/icom/test.json", HTTP_GET,  handleIcomTestStatus);
  webServer.on("/setup/wifi-try",      HTTP_POST, handleWifiTryStart);
  webServer.on("/setup/wifi-try.json", HTTP_GET,  handleWifiTryStatus);
  webServer.on("/trxnet-peers.json", HTTP_GET, handleTrxNetPeers);
  webServer.on("/restart", HTTP_POST, [](){
    webServer.sendHeader("Connection", "close");
    webServer.client().setNoDelay(true);
    webServer.send(200, "application/json", "{\"ok\":true}");
    delay(500);
    ESP.restart();
  });
  webServer.on("/log",      HTTP_GET,  [](){ handleFileFromSPIFFS("/log.html"); });
  webServer.on("/datasync", HTTP_GET,  [](){ handleFileFromSPIFFS("/datasync.html"); });
  webServer.on("/data",     HTTP_GET,  [](){ handleFileFromSPIFFS("/data.html"); });

  // Band Decoder web configuration (backend runs regardless; this restores the UI).
  webServer.on("/bd", HTTP_GET, [](){
    webServer.sendHeader("Connection", "close");
    webServer.client().setNoDelay(true);
    if (!bdEnabled) {
      webServer.send(200, "text/html",
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<title>Band Decoder</title>"
        "<link rel='stylesheet' href='/app.css'></head>"
        "<body><p style='margin:2em;font-family:sans-serif'>"
        "Band Decoder is available from RemoteQTH interface HW rev 04.</p></body></html>");
      return;
    }
    handleFileFromSPIFFS("/bd.html");
  });

  webServer.on("/dxcinfo", HTTP_GET, [](){
    webServer.sendHeader("Cache-Control", "no-cache");
    webServer.sendHeader("Connection", "close");
    webServer.client().setNoDelay(true);
    // Legacy field names are kept as availability booleans for the embedded DXC
    // page; /oi3/set-hz now routes LAN/TRXNET/CI-V by the unified slot config.
    String j = "{\"locator\":\"" + DxcLocator + "\",\"callsign\":\"" + DxcCallsign
             + "\",\"trx2netid\":" + String(radioSlots[1].enabled ? 1 : 0)
             + ",\"trx3netid\":" + String(radioSlots[2].enabled ? 1 : 0) + "}";
    webServer.send(200, "application/json", j);
  });

  webServer.on("/pairing/offer",  HTTP_OPTIONS, handlePairingOptions);
  webServer.on("/pairing/offer",  HTTP_POST,    handlePairingOfferPost);
  webServer.on("/pairing/offer",  HTTP_GET,     handlePairingOfferGet);
  webServer.on("/pairing/answer", HTTP_OPTIONS, handlePairingOptions);
  webServer.on("/pairing/answer", HTTP_POST,    handlePairingAnswerPost);
  webServer.on("/pairing/answer", HTTP_GET,     handlePairingAnswerGet);
  webServer.on("/pairing/reject", HTTP_OPTIONS, handlePairingOptions);
  webServer.on("/pairing/reject", HTTP_POST,    handlePairingReject);

  // Band Decoder hardware API remains available to external controllers.
  webServer.on("/api/bd-config", HTTP_GET, [](){
    webServer.sendHeader("Connection", "close");
    webServer.client().setNoDelay(true);
    if (!bdEnabled) { webServer.send(403, "application/json", "{\"error\":\"hw\"}"); return; }
    File f = cfgFS.open(BD_CONFIG_PATH, FILE_READ);
    if (!f) { webServer.send(404, "application/json", "{}"); return; }
    webServer.streamFile(f, "application/json");
    f.close();
  });
  webServer.on("/api/bd-config", HTTP_POST, [](){
    webServer.sendHeader("Connection", "close");
    webServer.client().setNoDelay(true);
    if (!bdEnabled) { webServer.send(403, "application/json", "{\"error\":\"hw\"}"); return; }
    String body = webServer.arg("plain");
    int si = body.indexOf("\"source\":");
    if (si >= 0) bdSource = body.substring(si + 9).toInt();
    int arrStart = body.indexOf("\"rows\":[");
    if (arrStart >= 0) {
      arrStart += 8;
      for (int i = 0; i < BD_ROWS; i++) {
        int ob = body.indexOf('{', arrStart);
        int cb = body.indexOf('}', ob);
        if (ob < 0 || cb < 0) break;
        String row = body.substring(ob, cb + 1);
        bdRows[i].fMin    = (uint32_t)extractJsonInt(row, "fMin");
        bdRows[i].fMax    = (uint32_t)extractJsonInt(row, "fMax");
        bdRows[i].outputs = (uint16_t)extractJsonInt(row, "outputs");
        arrStart = cb + 1;
      }
    }
    bdSaveConfig();
    uint32_t f = (bdSource == 1) ? frequency :
                 (bdSource == 2) ? (uint32_t)g_trxFreq[0] :
                                   (uint32_t)g_trxFreq[1];
    bdUpdate(f);
    webServer.send(200, "application/json", "{\"ok\":true}");
  });
  webServer.on("/api/status", HTTP_GET, [](){
    webServer.sendHeader("Connection", "close");
    webServer.client().setNoDelay(true);
    String j = "{";
    j += "\"hwrev\":"; j += HardwareRev;
    j += ",\"trx1Label\":\""; j += g_lcTrx1Label; j += "\"";
    j += ",\"trx2Label\":\""; j += g_lcTrx2Label; j += "\"";
    j += ",\"trx3Label\":\""; j += g_lcTrx3Label; j += "\"";
    j += ",\"trx2freq\":"; j += g_trxFreq[0];
    j += ",\"trx3freq\":"; j += g_trxFreq[1];
    j += "}";
    webServer.sendHeader("Cache-Control", "no-cache");
    webServer.send(200, "application/json", j);
  });

  webServer.onNotFound([](){
    String path = webServer.uri();
    if (!handleFileFromSPIFFS(path)) {
      if (APmode) {   // captive portal: send every unknown request to the setup page
        webServer.sendHeader("Location", "http://" + WiFi.softAPIP().toString() + "/setup", true);
        webServer.send(302, "text/plain", "");
        return;
      }
      webServer.sendHeader("Connection", "close");
      webServer.client().setNoDelay(true);
      webServer.send(404, "text/plain", "Not found");
    }
  });

  webServer.begin();
}


// True when the primary radio link is up, whichever transport it uses.
bool radioLinkUp(){
  return radioSlotConnected(0);
}

// Everything that keys, tunes or polls the operator's primary radio goes here;
// it is TRX1 by definition. /cmd is the one caller that may address a different
// slot (the JS8 page tuning the LAN radio) and uses catWriteFrameSlot directly.
bool catWriteFrame(const uint8_t *frame, size_t frameLen, bool broadcastTx){
  (void)broadcastTx;
  return catWriteFrameSlot(0, frame, frameLen);
}

bool catWriteFrameSlot(uint8_t slot, const uint8_t *frame, size_t frameLen){
  if (frameLen < 6 || slot > 2) return false;
  RadioTransport transport = radioSlots[slot].transport;
  if (transport == RADIO_LAN) {
    // frame = FE FE <radio> <ctrl> <cmd> <payload> FD. Strip the wrapper and
    // hand the body (cmd+payload) to the LAN client, which re-wraps with 0xE1
    // and its own configured CI-V address -- so the address byte in the frame
    // never has to match the slot.
    IcomLanClient *client = radioLanClient(slot);
    return client && client->sendCommand(frame + 4, frameLen - 5);
  }
  if (transport == RADIO_CIV) {
    if (!radioSlotConnected(slot) && frame[4] != CMD_READ_FREQ && frame[4] != CMD_READ_MODE)
      return false;
    civSend(radioSlots[slot].civAddr, frame + 4, frameLen - 5);
    return true;
  }
  if (transport == RADIO_TRXNET) {
    // Deliberately limited transport: TrxNet exposes telemetry and frequency
    // tuning, never arbitrary CAT/CW/PTT/audio frames.
    if (frame[4] != CMD_WRITE_FREQ || frameLen < 11
        || !trxNetEnabled || radioSlots[slot].netId == 0x00)
      return false;
    uint32_t hz = decodeCivFrequencyBytes(frame + 5, 5);
    if (hz == 0) return false;
    char peerName[TRXNET_MAX_DEVICE_NAME];
    snprintf(peerName, sizeof(peerName), "OI3.%02x", radioSlots[slot].netId);
    return net.publishTo(peerName, "/s-hz", (const uint8_t*)&hz, sizeof(hz));
  }
  if (slot != 0) return false;
  #if defined(BLUETOOTH)
    if (!btClientConnected) {
      return false;
    }
    for (size_t i = 0; i < frameLen; i++) {
      CAT.write(frame[i]);
    }
    return true;
  #endif
  return false;
}

void wsClearSplitProbe(void){
  // stub retained for BT callback compatibility
}
#endif

//-------------------------------------------------------------------------------------------------------

void setup(){
  // RTC_NOINIT survives a watchdog/panic reset but is garbage after power-on.
  // Anything other than the two values we ever write means "unknown", and the
  // safety un-key on link-up runs regardless -- this only guards the log line.
  if(rtcPttWasKeyed != 0 && rtcPttWasKeyed != 1) rtcPttWasKeyed = 0;

  wsOut = (uint8_t*)malloc(WS_OUT_SIZE);   // outgoing browser-audio WS ring (heap, not .bss)
  unaLogQueue = (uint8_t*)malloc(UNA_LOG_QUEUE_SIZE);  // deferred unattended-log ring (heap; null -> sync fallback)

  if (!EEPROM.begin(EEPROM_SIZE)){
    Serial.begin(BaudRate);
    Serial.println("EEPROM failed to initialise");
    delay(1);
  }else{

    // // clear eeprom
    // if(EEPROM.read(0)==0x00){
    //   for (int i=0; i<EEPROM_SIZE; i++){
    //     EEPROM.writeByte(i, 0xff);
    //     EEPROM.commit();
    //     Serial.println("Clear eeprom with 0xff and reboot...");
    //     ESP.restart();
    //   }
    // }

    // 74-75 BaudRate
    if(EEPROM.read(74)==0xff){
      BaudRate=9600;
    }else{
      BaudRate = EEPROM.readUShort(74);
    }
    Serial.begin(BaudRate);

    // 0 APmode
    if(EEPROM.read(0)==0xff){
      APmode=true;
    }else{
      if(EEPROM.readBool(0)==1){
        APmode=true;
      }else{
        APmode=false;
      }
    }

    #if !CAP_WIFI
      // There is no radio here to raise an access point with, no captive portal
      // (UDP 53 would need root), and nothing to provision -- the operating
      // system owns the connection. An unconfigured box is right to fall back to
      // AP mode; an unconfigured PC binary would just strand the operator in a
      // portal that cannot exist, so station mode is the only sane state.
      APmode = false;
    #endif

    // 1-21 - SSID
    if(EEPROM.read(1)==0xff){
      // APmode=true;
    }else{
      for (int i=1; i<21; i++){
        if(EEPROM.read(i)!=0xff){
          SSID=SSID+char(EEPROM.read(i));
        }
      }
    }

    // 22-40 - PSWD
    if(EEPROM.read(22)==0xff){
      // nil
    }else{
      for (int i=22; i<40; i++){
        if(EEPROM.read(i)!=0xff){
          PSWD=PSWD+char(EEPROM.read(i));
        }
      }
    }

    // 76-95 SSID2
    if(EEPROM.read(76)!=0xff){
      for (int i=76; i<96; i++){
        if(EEPROM.read(i)!=0xff){
          SSID2=SSID2+char(EEPROM.read(i));
        }
      }
    }

    // 97-114 PSWD2
    if(EEPROM.read(97)!=0xff){
      for (int i=97; i<115; i++){
        if(EEPROM.read(i)!=0xff){
          PSWD2=PSWD2+char(EEPROM.read(i));
        }
      }
    }

    // 41 TRXNET_ID  (own NET_ID; 0x00=disabled; 0xff=unprogrammed → default 0x01)
    TRXNET_ID = (EEPROM.read(41) == 0xff) ? 0x01 : EEPROM.readByte(41);

    // 42 TRX2_NET_ID (peer for TRX2 BD slot; 0x00=disabled; 0xff=unprogrammed → default 0xff)
    TRX2_NET_ID = (EEPROM.read(42) == 0xff) ? 0xff : EEPROM.readByte(42);

    // 43 TRX3_NET_ID (peer for TRX3 BD slot; 0x00=disabled; 0xff=unprogrammed → default 0x00)
    TRX3_NET_ID = (EEPROM.read(43) == 0xff) ? 0x00 : EEPROM.readByte(43);

    // 44 TRX2_CONN_TYPE (0=TrxNet, 1=CI-V; 0xff=unprogrammed → default 0x00)
    TRX2_CONN_TYPE = (EEPROM.read(44) == 0xff) ? 0x00 : EEPROM.readByte(44);
    // 45-46   TRXNET_PORT
    TRXNET_PORT = (EEPROM.read(45) == 0xff) ? 5683 : EEPROM.readUShort(45);
    // 47 TRX3_CONN_TYPE (0=TrxNet, 1=CI-V; 0xff=unprogrammed → default 0x00)
    TRX3_CONN_TYPE = (EEPROM.read(47) == 0xff) ? 0x00 : EEPROM.readByte(47);
    // 48 TRX2_CIV_ADDR (CI-V address of TRX2; 0xff=unprogrammed → 0x00 unset)
    TRX2_CIV_ADDR = (EEPROM.read(48) == 0xff) ? 0x00 : EEPROM.readByte(48);
    // 49 TRX3_CIV_ADDR (CI-V address of TRX3; 0xff=unprogrammed → 0x00 unset)
    TRX3_CIV_ADDR = (EEPROM.read(49) == 0xff) ? 0x00 : EEPROM.readByte(49);
    // 50-67   FREE (was MQTT_TOPIC)
    // 115-135 FREE (was MQTT_TOPIC_RX)
    // 225-245 FREE (was TRX2_MQTT_ROOT)
    // 246-266 FREE (was TRX3_MQTT_ROOT)

    // 267-287 BT_NAME (21B)
    if(EEPROM.read(267)!=0xff){
      for (int i=267; i<288; i++){
        if(EEPROM.read(i)!=0xff){
          BT_NAME=BT_NAME+char(EEPROM.read(i));
        }
      }
    }

    // 288 TRXNET_PRIO flag / 289-359 string (0xff flag = tovární default "OI3 ANT"; else read, "" = off)
    if (EEPROM.read(288) == 0xff) {
      TRXNET_PRIO = "OI3 ANT";
    } else {
      TRXNET_PRIO = "";
      for (int i = 289; i < 360; i++) {
        uint8_t c = EEPROM.read(i);
        if (c == 0xff || c == 0x00) break;
        TRXNET_PRIO += char(c);
      }
    }
    TRXNET_PRIO = trxNormalizePrio(TRXNET_PRIO);   // canonical form
    trxLoadPrioBuffers(TRXNET_PRIO);               // fill trxPrioPtrs/trxPrioCount


    loadLastStaIp();
    if(EEPROM.read(136) != 0xff){
      cwIpOnConnect = EEPROM.readBool(136);
    }

    // 137-200 DXC host (64B)
    if(EEPROM.read(137) != 0xff){
      for(int i=137; i<201; i++){
        if(EEPROM.read(i) != 0xff) DxcHost += char(EEPROM.read(i));
      }
    }

    // 201-202 DXC port (UShort)
    if(EEPROM.read(201) != 0xff){
      DxcPort = EEPROM.readUShort(201);
      if(DxcPort < 1) DxcPort = 7300;
    }

    // 203-218 DXC callsign (16B)
    if(EEPROM.read(203) != 0xff){
      for(int i=203; i<219; i++){
        if(EEPROM.read(i) != 0xff) DxcCallsign += char(EEPROM.read(i));
      }
    }

    // 219-224 DXC locator (6B)
    if(EEPROM.read(219) != 0xff){
      for(int i=219; i<225; i++){
        if(EEPROM.read(i) != 0xff) DxcLocator += char(EEPROM.read(i));
      }
    }

  }
//------------------------------------------

  Serial.println();
  Serial.print(" FW | ");
  Serial.println(REV);
  pinMode(HWidPin, INPUT);
    // HWidValue = readADC_Cal(analogRead(HWidPin));
    HWidValue = analogRead(HWidPin);
    if(HWidValue<=150){
      HardwareRev=1;
    }else if(HWidValue>150 && HWidValue<=406){
      HardwareRev=2;  // 253
     }else if(HWidValue>406 && HWidValue<=693){
       HardwareRev=3;  // 560
    }else if(HWidValue>693 && HWidValue<=900){
      HardwareRev=4;  // 827
    }else{
      HardwareRev=99;  // above every ID window -- no divider fitted, board unidentified
    }
  Serial.print(" HW | ");
  Serial.print(HardwareRev);
  Serial.print(" [");
  Serial.print(HWidValue);
  Serial.println(" raw]");

  if(APmode==true){
    ledcSetup(pwmChannel, frequence, resolution);
    ledcAttachPin(StatusPin, pwmChannel);
    ledcWrite(pwmChannel, 0);
  }else{    
    pinMode(StatusPin, OUTPUT);
    digitalWrite(StatusPin, LOW);
  }

  pinMode(PowerOnPin, OUTPUT);
    digitalWrite(PowerOnPin, LOW);
  pinMode(CIVmutePin, OUTPUT);
    digitalWrite(CIVmutePin, HIGH);

  #if defined(WIFI)
    // The configuration partition comes up FIRST and separately. The installer
    // never writes it, which is the whole reason it exists -- but that also
    // means a brand new device arrives with it unformatted, so formatOnFail is
    // what makes the first boot work. A failure here must NOT stop the assets
    // from being served: a device that cannot show its own setup page is far
    // worse than one that has forgotten its calibrations.
    if (!cfgFS.begin(true, "/cfg", 5, "cfg")) {
      Serial.println("CFG | configuration partition mount failed - settings will not persist");
    } else {
      Serial.println("CFG | mounted used=" + String(cfgFS.usedBytes()) +
                     " total=" + String(cfgFS.totalBytes()));
    }
    if (!LittleFS.begin(true)) {
      Serial.println("LFS | mount failed");
    } else {
      Serial.println("LFS | mounted used=" + String(LittleFS.usedBytes()) +
                     " total=" + String(LittleFS.totalBytes()));
      loadMemoryConfig();
      if (hasPrimaryRadioConfig()) {
        // EEPROM/NVS is authoritative because it survives full filesystem uploads.
        loadPrimaryRadioConfig();
      } else if (cfgFS.exists(MEMORY_CONFIG_PATH)) {
        // One-time migration from firmware versions that kept TRX1 only in
        // memories.cfg. The legacy copy remains readable by older firmware.
        if (!savePrimaryRadioConfig()) {
          Serial.println("CFG | legacy TRX1 migration failed");
        }
      }
      if (!loadRadioConfig()) {
        // One-time migration of the asymmetric legacy TRX1 + TRX2/3 fields into
        // the unified per-slot model. Legacy EEPROM mirrors remain populated so
        // an older firmware can still boot with a usable configuration.
        if (!saveRadioConfig()) Serial.println("CFG | unified radio migration failed");
      }
      loadLogConfigVars();
      // 99 is the "unidentified board" sentinel, not a future revision -- BD needs
      // a positively detected rev 04+, otherwise a missing ID divider would enable it.
      bdEnabled = (HardwareRev >= 4 && HardwareRev != 99);
      if (bdEnabled) {
        bdLoadConfig();
        bdInit();
        Serial.println("BD   | enabled");
      }
    }

    if(APmode==true){
      WiFi.mode(WIFI_AP);
      WiFi.softAP(ssidAP, passwordAP, 1, 0, 4); // ch1, visible, max 4 clients
      { // WPA/WPA2 mixed mode — fixes auth failure on modern clients (Win11/Android12+/iOS16+)
        wifi_config_t conf;
        esp_wifi_get_config(WIFI_IF_AP, &conf);
        conf.ap.authmode = WIFI_AUTH_WPA_WPA2_PSK;
        esp_wifi_set_config(WIFI_IF_AP, &conf);
      }
      IPAddress IP = WiFi.softAPIP();
      MACString = WiFi.softAPmacAddress();
      Serial.print(" AP | IP address: ");
      Serial.println(IP);

      dnsServer.start(DNS_PORT, "*", IP);   // captive portal: resolve every host to us


      StartMdns();

      setupWebServer();
      Serial.println("HTTP| web server started");

      // The listing lives in one place. This used to be a second, hand-kept
      // copy that had already fallen behind: no D, no L. ListCommands() prints
      // the AP banner itself, so the explicit APcliAlert() here would double it.
      ListCommands();

    }else{
      #if CAP_WIFI
        ConnectWiFiAlternating();
      #endif
      // Remember it for the AP portal: if the operator ever lands back in AP
      // mode, that page can name the address instead of leaving them guessing.
      saveLastStaIp(WiFi.localIP());
      Serial.print("WIFI| connected with IP ");
      Serial.println(WiFi.localIP());
      Serial.print("WIFI| ");
      Serial.print(WiFi.RSSI());
      if(APmode==true){
        ledcWrite(pwmChannel, 255);
      }else{
        digitalWrite(StatusPin, HIGH);
      }
      MACString=WiFi.macAddress();
      Serial.print(" dBm, MAC ");
      Serial.println(MACString);

      // Prewarm the DXC DNS cache while nothing time-critical runs yet — the
      // first hostByName may block for seconds on a slow resolver, which would
      // otherwise freeze the loop on the first telnet connect.
      if (DxcHost.length() > 0) {
        IPAddress dxcIp;
        if (WiFi.hostByName(DxcHost.c_str(), dxcIp)) {
          DxcHostIp = dxcIp;
          DxcHostResolved = DxcHost;
          Serial.print(" DXC| resolved ");
          Serial.print(DxcHost);
          Serial.print(" to ");
          Serial.println(dxcIp);
        } else {
          Serial.print(" DXC| DNS prewarm failed for ");
          Serial.println(DxcHost);
        }
      }


      StartMdns();
      setupWebServer();
      dxcRawServer.begin();
      audioWsServer.begin();
      Serial.println("HTTP| web server started");
      Serial.println("HTTP| DXC WS server started on port 82");
      Serial.println("HTTP| Audio WS server started on port 83");
    }
  #endif

  if(APmode==false){



    #if defined(FSK_KEYING)
      pinMode(PTT,  OUTPUT);
        digitalWrite(PTT, LOW);
      pinMode(FSK_OUT,  OUTPUT);
        digitalWrite(FSK_OUT, LOW);
    #endif

    #if defined(BLUETOOTH)
      esp_bt_mem_release(ESP_BT_MODE_BLE);
    #endif

    // Start every configured LAN slot. Each instance owns a distinct local
    // 500x1/2/3 port triplet; only TRX1 advertises/opens network audio.
    for (uint8_t slot = 0; slot < 3; slot++) {
      if (radioSlots[slot].enabled && radioSlots[slot].transport == RADIO_LAN)
        beginRadioLanClient(slot);
    }
    if (radioSlots[0].transport == RADIO_CIV)
      radio_address = radioSlots[0].civAddr;

    // TrxNet init — after WiFi is up; NET_ID 0x00 = disabled
    if (TRXNET_ID != 0x00) {
      snprintf(trxDeviceName, sizeof(trxDeviceName), "705.%02x", TRXNET_ID);
      net.setPort(TRXNET_PORT);
      net.setPriorityPrefixes(trxPrioCount ? trxPrioPtrs : NULL, trxPrioCount);  // before begin()
      net.begin(trxDeviceName);
      net.subscribe("/hz",   onTrxHz);
      net.subscribe("/mode", onTrxMode);
      net.subscribe("/s-hz", onTrxSetHz);
      trxNetEnabled = true;
      Serial.print("TRXNET| begin ");
      Serial.println(trxDeviceName);
    } else {
      Serial.println("TRXNET| disabled (NET_ID=0x00)");
    }

    #if defined(WDT)
      // WDT
      esp_task_wdt_init(WDT_TIMEOUT, true); //enable panic so ESP32 restarts
      esp_task_wdt_add(NULL); //add current thread to WDT watch
      WdtTimer=millis();
    #endif

    // Flush any garbage bytes accumulated in Serial RX buffer during boot/USB re-enumeration
    while (Serial.available()) Serial.read();

  }
}
//-------------------------------------------------------------------------------------------------------
// "CW sent" indication. The status LED sits HIGH the whole time WiFi is up, so a
// short dark pulse marks the send. Scheduled rather than blinked with delay():
// sendCW() runs inside the /cmd handler, and blocking there starves the LAN idle
// keepalives (due every 100 ms) and the DXC sockets. AP mode is skipped — the PWM
// fade below owns the LED there and overwrites any blink within 3 ms anyway.
static uint32_t statusFlashStart = 0;
static bool     statusFlashOn    = false;

// The LED's resting state: lit once the station link is up, dark while waiting
// for it. Before this the pin was written exactly twice -- LOW at boot and HIGH
// on the first successful connect -- so after a WiFi outage the LED went on
// claiming a link that was gone. In AP mode the PWM fade owns the pin, so the
// only correct move is to hand it back.
static void statusLedSteady(){
  if (APmode) { ledcWrite(pwmChannel, 255); return; }
  digitalWrite(StatusPin, WiFiStationReady() ? HIGH : LOW);
}

static void statusFlashKick(){
  if (APmode) return;
  digitalWrite(StatusPin, LOW);
  statusFlashStart = millis();
  statusFlashOn = true;
}

static void statusFlashTick(){
  if (statusFlashOn && millis() - statusFlashStart >= 100) {
    digitalWrite(StatusPin, HIGH);
    statusFlashOn = false;
  }
}

//-------------------------------------------------------------------------------------------------------

void loop(){
  static bool serialFlushed = false;
  if (!serialFlushed && millis() > 2000) {
    while (Serial.available()) Serial.read();
    serialFlushed = true;
  }
  #define _TIMED(name, call) { unsigned long _t = millis(); call; unsigned long _d = millis()-_t; if(_d > LOOP_WARN_MS) { Serial.print("LOOP| slow: " name " "); Serial.print(_d); Serial.println("ms"); } }
  _TIMED("Watchdog",        Watchdog())
  _TIMED("LanClient",       lanClientLoop())
  audioPttSafetyRetryTick();
  // PTT release is checked immediately after the two radio Interfaces. The
  // dedicated audio owner advances playout independently; this early check
  // prevents unrelated CLI/web work from extending the keyed tail.
  if(aud1TxState == AUD1_TX_STREAM) aud1TxTick(false);
  _TIMED("CLI",             serialPump())
  _TIMED("CIV",             civPollTick())
  _TIMED("GpsPoll",         gpsPollTick())
  handleWebServerLoop();
  _TIMED("NetIdentity",     NetworkIdentityLoop())
  _TIMED("RadioModel",      radioModelLearnTick())
  _TIMED("WifiTry",         wifiTryTick())
  _TIMED("IcomScan",        icomScanTick())
  _TIMED("TrxNet",          TrxNetLoop())
  _TIMED("DxcLoop",         DxcLoop())
  _TIMED("AprsIs",          aprsisLoop())
  _TIMED("dxcRaw",          dxcHandleRawClient())
  _TIMED("audioRaw",        audioHandleRawClient())
  _TIMED("audioWs",         AudioHandleWsClient())
  // Persist queued unattended-log events to flash only when no slot key is near,
  // so the append/rotate never stalls the loop across a JS8 slot boundary.
  if(!txRealtimeNow()) unattendedLogFlush();

  // TrxNet: process pending /s-hz command (set TRX1 VFO via CI-V)
  if (trxFreqPending) {
    trxFreqPending = false;
    uint32_t f = trxPendingHz;
    if (f > 0) {
      if (radioSetFrequency(f)) {
        if (Debug) Serial.printf("CAT | set VFO %lu\n", (unsigned long)f);
      } else {
        if (Debug) Serial.println("CAT | set VFO skipped, TRX not connected");
      }
    }
  }

  statusFlashTick();

  // AP mode: status LED fade in/out
  if(APmode==true){
    static int PwmValue = 0;
    static bool PwmDir = true;
    static long pwmTimer = 0;
    if(millis()-pwmTimer>3){
      if(PwmDir==true){
        PwmValue++;
        if(PwmValue>254){ PwmDir=false; }
      }else{
        PwmValue--;
        if(PwmValue<1){ PwmDir=true; }
      }
      ledcWrite(pwmChannel, PwmValue);
      pwmTimer=millis();
    }
  }
}

// SUBROUTINES -------------------------------------------------------------------------------------------------------

void handleBtEvents(){
  if (btStateBroadcastPending == true) {
    btStateBroadcastPending = false;
  }

  if (btConnectPending == true) {
    btConnectPending = false;
    btClientConnected = true;
    radio_address = configuredCivAddress;
    frequency = 0;
    frequencyTmp = 0;
    if (TrxSetupDone == false) {
      TrxNeedSet = 1;
      if (cwIpOnConnect) cwIpSendPending = true;
    }
    Serial.println("    | Client Connected");
  }

  if (btDisconnectPending == true) {
    btDisconnectPending = false;
    btClientConnected = false;
    radio_address = 0x00;
    TrxNeedSet = 0;
    powerTimer = 0;
    frequency = 0;
    frequencyTmp = 0;
    setModesText("OFF");
    Serial.println("    | Client Disconnected");
    if (statusPower == 1 && trxNetEnabled) {
      uint32_t zero = 0;
      net.publish("/hz", (uint8_t*)&zero, sizeof(zero));
    }
  }
}

// CW IP announcement: values applied during the announce and restored afterward.
static const uint8_t       CW_ANNOUNCE_AF_GAIN = 102;    // ~40% of 255, audible without blasting
static const unsigned long CW_ANNOUNCE_KEY_MS  = 12000;  // max time to let the keyer finish

// Encode a 0..255 level into the IC-705's 2-byte BCD level format (e.g. 255 -> 02 55).
static inline void encodeCivLevel(uint16_t value, uint8_t out[2]){
  if (value > 255) value = 255;
  out[0] = (uint8_t)(value / 100);                              // hundreds (0..2)
  out[1] = (uint8_t)((((value / 10) % 10) << 4) | (value % 10));// tens|units BCD
}

// Blocking wait that keeps the active transport, web and TrxNet serviced. Unlike
// ServiceBackgroundTasks it also pumps lanClient, so a multi-second CW keying wait
// doesn't starve the LAN control channel (which would drop the radio session).
static void cwAnnounceService(unsigned long ms){
  unsigned long start = millis();
  while (millis() - start < ms) {
    if (radioSlots[0].transport == RADIO_LAN) lanClient.loop();
    else if (radioSlots[0].transport == RADIO_CIV) {
      serialPump();
      civPollTick();
    }
    secondaryLanClientsLoop();
    if (trxNetEnabled) net.loop();
    if (APmode) dnsServer.processNextRequest();
    webServer.handleClient();
    #if defined(WDT)
      esp_task_wdt_reset();
    #endif
    delay(5);
  }
}

// Announce the interface's WiFi IP in CW on the radio, as sidetone only: BK-IN is
// forced OFF so the keyer never keys the transmitter — nothing goes on air and no
// interference is caused. RF gain is dropped to minimum so band noise doesn't mask
// the tone. Transport-agnostic: works over BT and LAN because catWriteFrame()
// routes to whichever link is up. Snapshots every setting it touches (mode+filter+
// DATA, BK-IN, AF gain, RF gain) up front and restores them all when finished.
void announceIpViaCw(){
  if (radio_address == 0x00) return;
  uint8_t frame[16];
  size_t  n;

  // 1. Read back the settings we're about to change, so we can restore them.
  { uint8_t p[] = {0x00}; n = buildSimpleCatFrame(0x26, p, sizeof(p), frame, sizeof(frame)); catWriteFrame(frame, n, false); } // mode+data+filter
  { uint8_t p[] = {0x01}; n = buildSimpleCatFrame(0x14, p, sizeof(p), frame, sizeof(frame)); catWriteFrame(frame, n, false); } // AF gain
  { uint8_t p[] = {0x02}; n = buildSimpleCatFrame(0x14, p, sizeof(p), frame, sizeof(frame)); catWriteFrame(frame, n, false); } // RF gain
  { uint8_t p[] = {0x47}; n = buildSimpleCatFrame(0x16, p, sizeof(p), frame, sizeof(frame)); catWriteFrame(frame, n, false); } // BK-IN
  cwAnnounceService(700); // let the replies land in the state globals

  const uint8_t savedModeId = stateModeId;
  const bool    savedData   = stateDataMode;
  const uint8_t savedFilter = stateFilter;
  const uint8_t savedAf     = stateAfGain;
  const uint8_t savedRf     = stateRfGain;
  const uint8_t savedBk     = stateVoxMode;
  Serial.printf(" CW | announce IP, saved mode=0x%02X data=%d fil=%u af=%u rf=%u bk=%u\n",
                (unsigned)savedModeId, (int)savedData, (unsigned)savedFilter,
                (unsigned)savedAf, (unsigned)savedRf, (unsigned)savedBk);

  // 2. Set up a sidetone-only announcement: CW/FIL3, BK-IN OFF so the keyer never
  //    keys the transmitter (nothing goes on air, no interference), RF gain to
  //    minimum so band noise is muted, AF up so the sidetone is clearly audible.
  { uint8_t p[] = {0x00, 0x03, 0x00, 0x03}; n = buildSimpleCatFrame(0x26, p, sizeof(p), frame, sizeof(frame)); catWriteFrame(frame, n, false); } // CW, non-data, FIL3
  { uint8_t lv[2]; encodeCivLevel(CW_ANNOUNCE_AF_GAIN, lv); uint8_t p[] = {0x01, lv[0], lv[1]}; n = buildSimpleCatFrame(0x14, p, sizeof(p), frame, sizeof(frame)); catWriteFrame(frame, n, false); } // AF ~40%
  { uint8_t lv[2]; encodeCivLevel(0, lv);                   uint8_t p[] = {0x02, lv[0], lv[1]}; n = buildSimpleCatFrame(0x14, p, sizeof(p), frame, sizeof(frame)); catWriteFrame(frame, n, false); } // RF gain min -> mute band noise
  { uint8_t p[] = {0x47, 0x00}; n = buildSimpleCatFrame(0x16, p, sizeof(p), frame, sizeof(frame)); catWriteFrame(frame, n, false); } // BK-IN OFF -> never transmits
  cwAnnounceService(300);

  // 3. Play the IP (sidetone only — BK-IN is off, so this never goes on air).
  String ipStr = "IP " + WiFi.localIP().toString();
  ipStr.toCharArray(CwMsg, sizeof(CwMsg));
  setModesText("CW"); // sendCW() keys over CAT only in CW / CW-R, so say which one
  sendCW();
  cwAnnounceService(CW_ANNOUNCE_KEY_MS); // wait for the keyer to finish before touching the radio again

  // 4. Restore everything, in reverse order. saved==0 means the snapshot read never
  //    landed (LAN doesn't poll these), so fall back rather than leaving the forced
  //    announce level in place permanently:
  //      RF -> max, because we forced it to 0 and leaving it there deafens the RX
  //            (nobody operates at RF gain 0, so 0 really does mean "read failed")
  //      AF -> keep the audible level, because writing 0 back would mute the radio
  //    BK-IN needs no fallback: default 0 == OFF == what we just set, so a missed
  //    read simply leaves TX disabled, which is the safe direction.
  { uint8_t p[] = {0x47, savedBk}; n = buildSimpleCatFrame(0x16, p, sizeof(p), frame, sizeof(frame)); catWriteFrame(frame, n, false); } // BK-IN
  { uint8_t lv[2]; encodeCivLevel(savedRf > 0 ? savedRf : 255, lv); uint8_t p[] = {0x02, lv[0], lv[1]}; n = buildSimpleCatFrame(0x14, p, sizeof(p), frame, sizeof(frame)); catWriteFrame(frame, n, false); } // RF gain
  if (savedAf > 0) { uint8_t lv[2]; encodeCivLevel(savedAf, lv); uint8_t p[] = {0x01, lv[0], lv[1]}; n = buildSimpleCatFrame(0x14, p, sizeof(p), frame, sizeof(frame)); catWriteFrame(frame, n, false); } // AF gain
  { uint8_t p[] = {0x00, savedModeId, (uint8_t)(savedData ? 0x01 : 0x00), savedFilter}; n = buildSimpleCatFrame(0x26, p, sizeof(p), frame, sizeof(frame)); catWriteFrame(frame, n, false); } // mode+data+filter
  cwAnnounceService(300);
  applyModeState(savedModeId, savedData); // restore local display/state immediately
  stateFilter = savedFilter;
  Serial.println(" CW | announce IP done, settings restored");
}

// BT CAT poll cadence. Every frame keeps the SPP link out of sniff mode and the
// coex arbiter then starves WiFi (TCP stalls → AP drops us), so idle cadence is
// slow. The CAT page requests /state?fast=1, which holds the fast cadence while
// it stays open; the log page and everything else run on the slow one.
void pollRadio(){
  static unsigned long catPollTimer = 0;
  static unsigned long auxPollTimer = 0;
  static uint8_t auxPollIndex = 0;
  static uint8_t modePollDivider = 0;

  if (!btClientConnected) return;
  bool fastCat = (long)(catFastUntil - millis()) > 0;
  // During a WiFi outage every BT frame keeps the SPP link out of sniff mode and
  // re-association then never succeeds (even with ESP_COEX_PREFER_WIFI). Web and
  // TrxNet are unreachable anyway — keep only a slow freq poll for the band decoder.
  bool wifiOutage = false;
  #if defined(WIFI)
    wifiOutage = !APmode && (WifiDownSince != 0);
  #endif

  unsigned long freqInterval = wifiOutage ? CAT_POLL_OUTAGE_MS
                                          : (fastCat ? CAT_POLL_FAST_MS : CAT_POLL_MS);
  if (millis() - catPollTimer > freqInterval) {
    catPollTimer = millis();
    if (radio_address == 0x00) {
      if (Debug == true) Serial.println("CAT | searching radio...");
      searchRadio();
    } else {
      sendCatRequest(CMD_READ_FREQ);
      if (!wifiOutage && (fastCat || ++modePollDivider >= CAT_MODE_EVERY)) {
        modePollDivider = 0;
        sendCatRequest(CMD_READ_MODE);
      }
      processCatMessages();
    }
  }

  if (cwIpSendPending && radio_address != 0x00) {
    cwIpSendPending = false;
    TrxSetupDone = true;
    announceIpViaCw(); // snapshots mode/filter/BK-IN/AF/RF, keys the IP, restores them
  }

  if (!wifiOutage && radio_address != 0x00 && millis() - auxPollTimer > (fastCat ? AUX_POLL_FAST_MS : AUX_POLL_MS)) {
    auxPollTimer = millis();
    uint8_t frame[10];
    size_t frameLen = 0;
    switch (auxPollIndex % 10) {
      case 0: { uint8_t p[] = {stateTx ? (uint8_t)0x11 : (uint8_t)0x02}; frameLen = buildSimpleCatFrame(0x15, p, 1, frame, sizeof(frame)); break; } // TX=power, RX=S-meter
      case 1: { uint8_t p[] = {stateTx ? (uint8_t)0x12 : (uint8_t)0x15}; frameLen = buildSimpleCatFrame(0x15, p, 1, frame, sizeof(frame)); break; } // TX=SWR, RX=supply
      case 2: { uint8_t p[] = {0x01}; frameLen = buildSimpleCatFrame(0x14, p, 1, frame, sizeof(frame)); break; } // AF gain
      case 3: { uint8_t p[] = {0x0C}; frameLen = buildSimpleCatFrame(0x14, p, 1, frame, sizeof(frame)); break; } // key speed
      case 4: { uint8_t p[] = {0x0A}; frameLen = buildSimpleCatFrame(0x14, p, 1, frame, sizeof(frame)); break; } // RF power
      case 5: { uint8_t p[] = {0x00}; frameLen = buildSimpleCatFrame(0x1C, p, 1, frame, sizeof(frame)); break; } // TX state
      case 6: { uint8_t p[] = {0x00}; frameLen = buildSimpleCatFrame(0x21, p, 1, frame, sizeof(frame)); break; } // RIT offset (sub 0x00)
      case 7: {                        frameLen = buildSimpleCatFrame(0x11, nullptr, 0, frame, sizeof(frame)); break; } // ATT
      case 8: { uint8_t p[] = {0x02}; frameLen = buildSimpleCatFrame(0x16, p, 1, frame, sizeof(frame)); break; } // PREAMP
      case 9: { uint8_t p[] = {0x47}; frameLen = buildSimpleCatFrame(0x16, p, 1, frame, sizeof(frame)); break; } // VOX/BKIN
    }
    if (frameLen > 0) catWriteFrame(frame, frameLen, false);
    processCatMessages();
    auxPollIndex++;
  }
}

void Watchdog(){
  #if defined(BLUETOOTH)
    handleBtEvents();
    pollRadio();
  #endif

  static unsigned long trxNetPublishTimer = 0;

  // Primary LAN owns PWR/audio in lanClientLoop(). Direct serial CI-V is also a
  // full primary connection; TrxNet is intentionally telemetry+tune only and
  // must never energise PWR-OUT or arm CAT/CW/PTT side effects.
  if (radioSlots[0].transport == RADIO_CIV) {
    bool connected = radioSlotConnected(0);
    if (!connected) {
      if (statusPower == 1) {
        statusPower = 0;
        digitalWrite(PowerOnPin, LOW);
        Serial.println(" PWR| OFF (CI-V)");
      }
    } else {
      if (statusPower == 0) {
        statusPower = 1;
        digitalWrite(PowerOnPin, HIGH);
        Serial.println(" PWR| ON (CI-V)");
        if (cwIpOnConnect) cwIpSendPending = true;
      }
      if (cwIpSendPending && radio_address != 0x00) {
        cwIpSendPending = false;
        announceIpViaCw();
      }
    }

    if (connected && radio_address != 0x00 && millis() - trxNetPublishTimer > 2000
        && frequencyTmp != frequency) {
      if (trxNetEnabled) {
        uint32_t f = (uint32_t)frequency;
        net.publish("/hz", (uint8_t*)&f, sizeof(f));
      }
      frequencyTmp = frequency;
      trxNetPublishTimer = millis();
      if (bdEnabled && bdSource == 1) bdUpdate(frequency);
    }
  } else if (radioSlots[0].transport == RADIO_TRXNET) {
    if (statusPower == 1) {
      digitalWrite(PowerOnPin, LOW);
      Serial.println(" PWR| OFF (TRXNET limited)");
      statusPower = 0;
    }
  }

  // WIFI status
  #if defined(WIFI)
    unsigned long currentMillis = millis();
    // if WiFi is down, try reconnecting every CHECK_WIFI_TIME seconds
    // if ((WiFi.status() != WL_CONNECTED) && (currentMillis - WifiTimer >=WifiReconnect)) {
    //   Serial.print(millis());
    //   Serial.println("cReconnecting...");
    //   WiFi.disconnect();
    //   WiFi.reconnect();
    //   WifiTimer = currentMillis;
    // }
    if (!APmode && (currentMillis - WifiTimer >= WifiReconnect)) {
      if (WiFiStationReady()) {
        WifiDownSince = 0;
        WifiHardResetDone = false;
        if (WifiCoexPreferred) {
          esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
          WifiCoexPreferred = false;
          Serial.print(millis());
          Serial.println(" WIFI| coex back to balance");
        }
        uint8_t *bssid = WiFi.BSSID();
        if (bssid && (!wifiLastBssidValid || memcmp(wifiLastBssid, bssid, 6) != 0
                      || wifiLastChannel != WiFi.channel())) {
          memcpy(wifiLastBssid, bssid, 6);
          wifiLastChannel = WiFi.channel();
          wifiLastSsid = WiFi.SSID();
          wifiLastBssidValid = true;
        }
        WifiTimer = currentMillis;
        statusLedSteady();
      } else {
        if (WifiDownSince == 0) WifiDownSince = currentMillis;
        statusLedSteady();
        unsigned long downFor = currentMillis - WifiDownSince;
        wl_status_t st = WiFi.status();

        // With the BT link up the coex arbiter starves WiFi so badly that
        // re-association never succeeds — tilt RF time to WiFi until we are back.
        if (!WifiCoexPreferred && btClientConnected) {
          esp_coex_preference_set(ESP_COEX_PREFER_WIFI);
          WifiCoexPreferred = true;
          Serial.print(millis());
          Serial.println(" WIFI| coex prefer WiFi (BT active)");
        }

        // status 255 = driver no longer initialized; only a reboot brings it back
        if ((downFor >= WIFI_RESTART_AFTER_MS || st == WL_NO_SHIELD) && !stateTx) {
          Serial.print(millis());
          Serial.println(" WIFI| unrecoverable, restarting ESP");
          delay(100);
          ESP.restart();
        }
        // Radio off/on at most once per outage, and never while the BT SPP link is
        // up — esp_wifi_stop() then times out ("wifi un-init") and repeating the
        // cycle kills the driver (rx buffer init errors, status=255).
        bool hardReset = false;
        if (downFor >= WIFI_HARD_RESET_AFTER_MS && !WifiHardResetDone) {
          WifiHardResetDone = true;
          hardReset = !btClientConnected;
        }

        if (st == WL_DISCONNECTED || st == WL_CONNECT_FAILED || st == WL_NO_SSID_AVAIL) {
          ActiveWifiProfile = NextWifiProfile(ActiveWifiProfile);
          WiFiRetryActiveProfile("status", hardReset);
        } else {
          WiFiRetryActiveProfile("no ip", hardReset);
        }
        WifiTimer = currentMillis;
      }
    }
  #endif

  // WDT
  #if defined(WDT)
    if(millis()-WdtTimer > 5000){
      esp_task_wdt_reset();
      WdtTimer=millis();
    }
  #endif

}

//-------------------------------------------------------------------------------------------------------
// LAN transport service loop. Non-blocking; drives lanClient and mirrors the
// decoded frequency/mode into the same globals the BT path fills, so the web UI,
// TrxNet publish and band decoder work unchanged. Auto-reconnects on failure.
void lanClientLoop(){
  // A scan or credential test owns UDP 50001 right now. Letting the retry logic
  // re-open it here would put two sockets on the same port (SO_REUSEADDR makes
  // that succeed) and the probe replies would go to the wrong one.
  if (icomScanSuspendLan) return;
  secondaryLanClientsLoop();
  if (radioSlots[0].transport != RADIO_LAN) return;
  if (lanReconnectRequested) {
    lanReconnectRequested = false;
    lanClient.stop();
    lanRetryAt = 0;
    lanBackoff = 3000;
    IPAddress rip;
    if (rip.fromString(lanRadioIp) && lanUser.length() > 0 && lanPass.length() > 0) {
      Serial.println("LAN | manual reconnect requested");
      lanClient.begin(rip, 50001, lanUser.c_str(), lanPass.c_str(), configuredCivAddress);
    } else {
      Serial.println("LAN | manual reconnect skipped, configuration incomplete");
    }
  }
  lanClient.loop();
  if (!lanClient.connected()) lanLinkWasUp = false;   // re-arm the safety un-key
  // Arming lapses by itself so a forgotten tab cannot transmit for weeks;
  // unattendedExpire() fires once so the log does not repeat every loop.
  if (unattendedExpire(unattendedGuard, millis()))
    unattendedLogEvent(UEV_EXPIRE, "arming window elapsed");

  if (lanClient.connected()) {
    // Edge, not level: the unconditional safety TX OFF fires once per link-up.
    if (!lanLinkWasUp) { lanLinkWasUp = true; audioPttSafetyOnLink(); }
    lanBackoff = 3000;   // healthy link resets the reconnect backoff
    // (re)start RX audio if the DATA page is open but the audio channel isn't up
    // yet — covers WS-connected-before-LAN and LAN-reconnect-while-page-open.
    if (AudioWsClient.connected() && !lanClient.rxAudioActive()) lanClient.startRxAudio();
    if (statusPower == 0) {
      statusPower = 1;
      digitalWrite(PowerOnPin, HIGH);
      Serial.println(" PWR| ON (LAN)");
      if (cwIpOnConnect) cwIpSendPending = true; // arm CW IP announce on first link-up
    }
    // Announce the IP once the radio address is known (learned from the first
    // decoded frame). Same feature/flag as the BT path; snapshots + restores state.
    if (cwIpSendPending && radio_address != 0x00) {
      cwIpSendPending = false;
      announceIpViaCw();
    }
    // frequency/mode/meters are written directly by lanCivFrameHandler (shared
    // parser). Here we only propagate a frequency change to TrxNet + band decoder.
    if (trxNetEnabled && frequency != 0 && (uint32_t)frequency != lanFreqTmp) {
      uint32_t f = (uint32_t)frequency;
      net.publish("/hz", (uint8_t*)&f, sizeof(f));
      lanFreqTmp = (uint32_t)frequency;
      if (bdEnabled && bdSource == 1) bdUpdate(frequency);
    }
  } else {
    if (statusPower == 1) {
      statusPower = 0;
      digitalWrite(PowerOnPin, LOW);
      Serial.println(" PWR| OFF (LAN)");
      frequency = 0; frequencyTmp = 0; lanFreqTmp = 0;
      setModesText("OFF");
    }
    // On failure: release the radio session IMMEDIATELY (single-session radio
    // must free the old one before we retry), then wait an escalating backoff
    // so we don't hammer a radio that still holds a zombie session.
    if (lanClient.failed()) {
      lanClient.stop();                 // sends disconnect/token-release -> state IDLE
      lanRetryAt = millis() + lanBackoff;
      Serial.print("LAN | reconnect in "); Serial.print(lanBackoff/1000); Serial.println("s");
      if (lanBackoff < 20000) lanBackoff *= 2;
    } else if (lanClient.status() == IcomLanClient::LAN_IDLE && lanRetryAt && millis() >= lanRetryAt) {
      lanRetryAt = 0;
      IPAddress rip;
      if (rip.fromString(lanRadioIp))
        lanClient.begin(rip, 50001, lanUser.c_str(), lanPass.c_str(), configuredCivAddress);
    }
  }
}

//-------------------------------------------------------------------------------------------------------
// Last address the router gave us, kept so a later visit to the AP portal can
// still answer "where is the device". A fresh EEPROM reads 0xff everywhere.
void loadLastStaIp() {
  uint8_t a = EEPROM.read(LAST_STA_IP_ADDR + 0), b = EEPROM.read(LAST_STA_IP_ADDR + 1);
  uint8_t c = EEPROM.read(LAST_STA_IP_ADDR + 2), d = EEPROM.read(LAST_STA_IP_ADDR + 3);
  if (a == 0xff && b == 0xff && c == 0xff && d == 0xff) { lastStaIp = IPAddress(); return; }
  lastStaIp = IPAddress(a, b, c, d);
}

// Written only when the address actually changed -- this runs on every boot and
// EEPROM emulation rewrites a whole flash sector per commit.
void saveLastStaIp(IPAddress ip) {
  if ((uint32_t)ip == 0 || ip == lastStaIp) return;
  for (uint8_t i = 0; i < 4; i++) EEPROM.write(LAST_STA_IP_ADDR + i, ip[i]);
  EEPROM.commit();
  lastStaIp = ip;
}

//-------------------------------------------------------------------------------------------------------
// Drives the station link raised by /setup/wifi-try while the softAP is still
// up: scan, then try every configured profile the scan saw, strongest first.
//
// Trying only the first configured profile was wrong -- an unreachable SSID 1
// made the handoff report failure while SSID 2 was sitting there working. The
// boot path alternates between profiles for exactly this reason.
//
// Both the scan and the association move the shared radio, so clients on the
// portal see brief drops and re-associate; the page treats a failed poll as
// "still connecting".
// Every configured profile, in order, with no scan behind it. Used when the
// scan could not run or saw nothing: a scan result is an optimisation, being
// unable to scan is no reason to refuse to try the credentials the operator
// just typed. Hidden SSIDs never show up in a scan either.
uint8_t fillBlindWifiCandidates(WifiScanPick out[2]) {
  uint8_t count = 0;
  for (byte p = 0; p < 2; p++) {
    if (!WifiProfileConfigured(p)) continue;
    out[count] = WifiScanPick();
    out[count].profile = p;
    count++;
  }
  return count;
}

void wifiTryBeginCandidate() {
  const WifiScanPick &pick = wifiTryCandidates[wifiTryCandidateIdx];
  wifiTrySsid = WifiProfileSSID(pick.profile);
  String pswd = WifiProfilePSWD(pick.profile);
  ApplyStaIdentity();
  if (pick.targeted) {
    // We just heard this AP, so there is no reason to make the driver sweep
    // every channel again. Never pass the all-zero BSSID of a blind candidate
    // here -- that would ask the driver for a station that cannot exist.
    WiFi.begin(wifiTrySsid.c_str(), pswd.c_str(), pick.channel, pick.bssid);
  } else {
    WiFi.begin(wifiTrySsid.c_str(), pswd.c_str());
  }
  wifiTryState = WTRY_CONNECTING;
  wifiTryDeadline = millis() + 20000;
  Serial.print("WIFI| AP handoff: trying ");
  Serial.print(wifiTrySsid);
  if (pick.targeted) {
    Serial.print(" ch");
    Serial.print(pick.channel);
    Serial.print(" ");
    Serial.print(pick.rssi);
    Serial.println(" dBm");
  } else {
    Serial.println(" (no scan hit, connecting blind)");
  }
}

void wifiTryFail(const char* reason) {
  wifiTryState = WTRY_FAILED;
  wifiTryReason = reason;
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_AP);              // drop back to a clean portal-only AP
  Serial.print("WIFI| AP handoff failed: ");
  Serial.println(reason);
}

void wifiTryTick() {
  if (wifiTryState == WTRY_SCAN) {
    // Give the STA interface a moment to come up after WIFI_AP_STA before
    // asking it to scan.
    if ((long)(millis() - wifiTryDeadline) < 0) return;

    // Blocking scan, the same call the boot path uses successfully. The async
    // form was tried first and returned WIFI_SCAN_FAILED immediately when
    // started from the request handler right after the mode switch, which made
    // the handover give up without ever attempting a connection. Blocking here
    // stalls the loop for a second or two -- during setup there is no radio
    // link and no audio to disturb, and the portal page tolerates a lost poll.
    int found = WiFi.scanNetworks(false, false, false, 150);
    wifiTryCandidateCount = (found > 0) ? collectVisibleWifiProfiles(found, wifiTryCandidates) : 0;
    WiFi.scanDelete();
    wifiTryScanSawNothing = (found >= 0 && wifiTryCandidateCount == 0);

    if (wifiTryCandidateCount == 0) {
      // A scan that saw nothing is not proof of absence: it may have failed
      // outright, and a hidden SSID never appears in one. Try the credentials
      // anyway rather than refusing on the strength of a negative.
      Serial.print("WIFI| AP handoff: scan found no configured SSID (");
      Serial.print(found);
      Serial.println(" APs), trying every profile blind");
      wifiTryCandidateCount = fillBlindWifiCandidates(wifiTryCandidates);
    }
    if (wifiTryCandidateCount == 0) {
      wifiTryFail("no_ssid");
      return;
    }
    wifiTryCandidateIdx = 0;
    wifiTryBeginCandidate();
    return;
  }

  if (wifiTryState != WTRY_CONNECTING) return;

  if (WiFi.status() == WL_CONNECTED && (uint32_t)WiFi.localIP() != 0) {
    saveLastStaIp(WiFi.localIP());
    wifiTryState = WTRY_OK;
    Serial.print("WIFI| AP handoff: station up at ");
    Serial.println(WiFi.localIP());
    return;
  }
  if ((long)(millis() - wifiTryDeadline) >= 0) {
    wifiTryCandidateIdx++;
    if (wifiTryCandidateIdx < wifiTryCandidateCount) {
      Serial.println("WIFI| AP handoff: next configured SSID");
      WiFi.disconnect(false, false);
      wifiTryBeginCandidate();
      return;
    }
    // Every profile was attempted. Whether the scan had seen them decides which
    // of the two useful explanations the operator gets.
    wifiTryFail(wifiTryScanSawNothing ? "not_found" : "no_connect");
  }
}

//-------------------------------------------------------------------------------------------------------
// Remembers the model a radio reported in its capabilities packet. Touches
// flash only on an actual change, which in practice means once per radio.
// The label a slot falls back to when the operator has not typed one. It used to
// be the hardcoded string "IC-705", which was a fair guess while that was the only
// radio this interface spoke to and became a false claim the moment it spoke to
// five. The radio reports its own model and we keep that across reboots, so use
// it; the slot number is the only honest answer when nothing has ever answered.
String defaultTrxLabel(uint8_t slot) {
  if (slot < 3 && radioSlots[slot].model.length() > 0)
    return trimMemoryValue(radioSlots[slot].model, 10);
  return String("TRX") + String(slot + 1);
}

// Adopt a freshly learned model as the label, but only while the label is still a
// bare slot number -- anything else is the operator's own wording and outranks
// what the radio calls itself.
void adoptModelAsLabelIfUnset(uint8_t slot) {
  if (slot >= 3) return;
  String *label = slot == 0 ? &g_lcTrx1Label : slot == 1 ? &g_lcTrx2Label : &g_lcTrx3Label;
  String neutral = String("TRX") + String(slot + 1);
  if (label->length() != 0 && *label != neutral) return;
  String next = defaultTrxLabel(slot);
  if (next == *label) return;
  // In memory only. The model is already persisted in radio-config.json, so this
  // is recomputed on every boot; writing log-config.json here would mean rebuilding
  // the whole document (blockedDxcc and the RST defaults included) to change one
  // display string, and an operator-typed label must keep winning anyway.
  *label = next;
}

void rememberRadioModel(uint8_t slot, const char* model) {
  if (slot >= 3 || !model || !model[0]) return;
  String clean = trimMemoryValue(String(model), 15);
  if (clean.length() == 0 || clean == radioSlots[slot].model) return;
  radioSlots[slot].model = clean;
  Serial.print("CFG | TRX");
  Serial.print(slot + 1);
  Serial.print(" reports model ");
  Serial.println(clean);
  if (!saveRadioConfig()) Serial.println("CFG | radio model save failed");
  adoptModelAsLabelIfUnset(slot);
}

// Picks the model up from an ordinary session too, not just from the SETUP
// test: swapping the radio behind an address has to correct the stored value
// without the operator remembering to press anything.
void radioModelLearnTick() {
  if (APmode) return;
  uint8_t slot = lanRadioSlotIndex();
  if (slot == 0xFF) return;
  IcomLanClient* client = radioLanClient(slot);
  if (!client || !client->connected()) return;
  rememberRadioModel(slot, client->radioModelName());
}

//-------------------------------------------------------------------------------------------------------
// LAN radio discovery + credential test, driven from the main loop.
//
// Both need UDP 50001, which the live client owns, so both go through the same
// stop-then-restore path. Nothing here ever runs a second socket alongside the
// real one: WiFiUDP sets SO_REUSEADDR, so the duplicate bind would succeed and
// then quietly eat the client's control packets instead of failing loudly.
void icomScanStopLanClients() {
  if (icomScanSuspendLan) return;
  icomScanLanWasUp = (lanRadioSlotIndex() != 0xFF);
  lanClient.stop();
  for (uint8_t i = 0; i < 2; i++) if (secondaryLanClients[i]) secondaryLanClients[i]->stop();
  icomScanSuspendLan = true;
}

void icomScanResumeLanClients() {
  if (!icomScanSuspendLan) return;
  icomScanSuspendLan = false;
  lanRetryAt = 0;
  lanBackoff = 3000;
  if (icomScanLanWasUp) lanReconnectRequested = true;
  icomScanLanWasUp = false;
}

void icomScanTick() {
  switch (icomScanPhase) {
    case ISCAN_IDLE:
    case ISCAN_DONE:
      return;

    case ISCAN_SUSPEND:
      icomScanStopLanClients();
      if (!icomScan.start()) {
        icomScanFailed = true;
        icomScanResumeLanClients();
        icomScanPhase = ISCAN_DONE;
        return;
      }
      icomScanPhase = ISCAN_RUN;
      return;

    case ISCAN_RUN:
      icomScan.tick();
      if (icomScan.scanState() == IcomLanDiscovery::DONE) {
        Serial.print("SCAN| finished, ");
        Serial.print(icomScan.count());
        Serial.println(" radio(s) answered on 50001");
        icomScanResumeLanClients();
        icomScanPhase = ISCAN_DONE;
      }
      return;

    case ISCAN_TEST_SUSPEND: {
      icomScanStopLanClients();
      // ~30 kB per client (1500 B scratch + two replay histories), so this is
      // allocated for the test and released again, never kept resident.
      if (!icomTestClient) icomTestClient = new (std::nothrow) IcomLanClient();
      if (!icomTestClient) {
        icomTestResult = "no_answer";
        icomScanResumeLanClients();
        icomScanPhase = ISCAN_DONE;
        return;
      }
      // enableAudio=false keeps openAudioChannel() a no-op, so no audio task is
      // ever spawned and the instance can be deleted the moment we are done.
      icomTestClient->begin(icomTestIp, 50001, icomTestUser.c_str(), icomTestPass.c_str(),
                            icomTestCivAddr, 0, 50001, false);
      icomTestDeadline = millis() + 15000;
      icomScanPhase = ISCAN_TEST_RUN;
      return;
    }

    case ISCAN_TEST_RUN: {
      icomTestClient->loop();
      IcomLanClient::State st = icomTestClient->status();
      // Success is declared at LAN_STREAM -- login, token and auth are all done
      // by then, which is exactly the question the operator asked. Waiting for
      // LAN_CONNECTED would open the CI-V channel and start writing decoded
      // frequency/mode into the shared rig state of a radio we are only probing.
      bool authenticated = (st == IcomLanClient::LAN_STREAM ||
                            st == IcomLanClient::LAN_CIV_AYT ||
                            st == IcomLanClient::LAN_CIV_OPEN ||
                            st == IcomLanClient::LAN_CONNECTED);
      bool finished = false;
      if (authenticated) {
        // LAN_STREAM is only entered after the capabilities packet arrived
        // (maybeRequestStream gates on haveCaps), so the model is guaranteed
        // to be known here -- which is why the test can report and store it.
        icomTestModel = icomTestClient->radioModelName();
        rememberRadioModel(icomTestSlot, icomTestModel.c_str());
        icomTestResult = "ok";
        finished = true;
      } else if (icomTestClient->failed()) {
        icomTestResult = icomTestClient->credentialsRejected() ? "bad_credentials" : "no_answer";
        finished = true;
      } else if ((long)(millis() - icomTestDeadline) >= 0) {
        icomTestResult = "no_answer";
        finished = true;
      }
      if (finished) {
        icomTestClient->stop();     // release the radio's single session at once
        delete icomTestClient;
        icomTestClient = nullptr;
        Serial.print("SCAN| credential test -> ");
        Serial.println(icomTestResult);
        icomScanResumeLanClients();
        icomScanPhase = ISCAN_DONE;
      }
      return;
    }
  }
}

//-------------------------------------------------------------------------------------------------------

void ServiceBackgroundTasks(unsigned long waitMs) {
  unsigned long start = millis();
  while (millis() - start < waitMs) {
    if (trxNetEnabled) net.loop();
    if (APmode) dnsServer.processNextRequest();   // captive portal
    webServer.handleClient();
    #if defined(WDT)
      esp_task_wdt_reset();
    #endif
    delay(10);
  }
}

//-------------------------------------------------------------------------------------------------------
// Must run after WiFi.mode(WIFI_STA) and BEFORE WiFi.begin() -- the hostname is
// only carried in the DHCP request, so setting it later has no effect until the
// next lease. With it the router lists the device as "wifilt" and most consumer
// routers publish that in their local DNS, which is the only find-me path that
// also works from Android (plain unicast DNS, no multicast involved).
//
// setSleep(false) is not cosmetic here: with the default modem power save the AP
// only delivers multicast at DTIM beacons and routinely drops it, which is why
// mDNS answers arrive late or not at all. Costs steady-state current -- revert
// this one line if consumption or heat turns out to matter more than discovery.
void ApplyStaIdentity() {
  WiFi.setHostname(deviceHostname);
  WiFi.setSleep(false);
}

//-------------------------------------------------------------------------------------------------------
void StartMdns() {
  // A failed MDNS.begin() used to park the device in while(1) forever. A name
  // clash or a transient init error is not a reason to brick a radio interface.
  if (!MDNS.begin(deviceHostname)) {
    Serial.println("mDNS| responder failed to start (continuing without it)");
    return;
  }
  MDNS.setInstanceName("IC-705 Interface");
  // _http._tcp is what "find devices on my network" browsers actually look for.
  // It was registered in AP mode only, so on the real LAN nothing could see us.
  MDNS.addService("http", "tcp", 80);
  MDNS.addService("ws", "tcp", 80);
  Serial.print("mDNS| responder started as http://");
  Serial.print(deviceHostname);
  Serial.println(".local");
}

//-------------------------------------------------------------------------------------------------------
// The responder is bound to the interface it was started on; after a reconnect
// the registration is stale and wifilt.local quietly stops resolving -- which is
// most of the "mDNS works sometimes" experience. TrxNet already re-announces on
// this same edge, mDNS was simply forgotten. Kept out of TrxNetLoop() because
// that one returns early when TrxNet is disabled, which is unrelated to mDNS.
void NetworkIdentityLoop() {
  if (APmode) return;
  static bool prevWifiConnected = WiFiStationReady();
  bool wifiConnected = WiFiStationReady();
  if (wifiConnected && !prevWifiConnected) {
    MDNS.end();
    StartMdns();
  }
  prevWifiConnected = wifiConnected;
}

//-------------------------------------------------------------------------------------------------------
bool WiFiStationReady() {
  if (APmode) return true;
  if (WiFi.status() != WL_CONNECTED) return false;
  return (uint32_t)WiFi.localIP() != 0;
}

//-------------------------------------------------------------------------------------------------------
void WiFiRetryActiveProfile(const char *reason, bool hardReset) {
  if (WifiProfileConfigured(ActiveWifiProfile) == false) {
    ActiveWifiProfile = 0;
  }
  String wifiSsid = WifiProfileSSID(ActiveWifiProfile);
  String wifiPswd = WifiProfilePSWD(ActiveWifiProfile);
  bool targeted = !hardReset && wifiLastBssidValid && wifiSsid == wifiLastSsid;
  Serial.print(millis());
  Serial.print(" WIFI| reconnecting ");
  Serial.print(reason);
  if (hardReset) Serial.print(" [radio reset]");
  else if (targeted) { Serial.print(" [bssid ch"); Serial.print(wifiLastChannel); Serial.print("]"); }
  Serial.print(" status=");
  Serial.print((int)WiFi.status());
  Serial.print(" ip=");
  Serial.print(WiFi.localIP());
  Serial.print(" ssid ");
  Serial.println(wifiSsid);
  if (hardReset) {
    // full radio off/on clears wedged driver state, then full-scan connect
    WiFi.disconnect(true, false);
    delay(200);
    WiFi.mode(WIFI_STA);
    delay(100);
    ApplyStaIdentity();
    WiFi.begin(wifiSsid.c_str(), wifiPswd.c_str());
  } else {
    WiFi.disconnect(false, false);
    delay(100);
    ApplyStaIdentity();
    if (targeted) {
      WiFi.begin(wifiSsid.c_str(), wifiPswd.c_str(), wifiLastChannel, wifiLastBssid);
    } else {
      WiFi.begin(wifiSsid.c_str(), wifiPswd.c_str());
    }
  }
}

//-------------------------------------------------------------------------------------------------------
bool WifiProfileConfigured(byte profile) {
  if (profile == 0) {
    return SSID.length() > 0 && PSWD.length() > 0;
  }
  if (profile == 1) {
    return SSID2.length() > 0 && PSWD2.length() > 0;
  }
  return false;
}

//-------------------------------------------------------------------------------------------------------
String WifiProfileSSID(byte profile) {
  if (profile == 1) {
    return SSID2;
  }
  return SSID;
}

//-------------------------------------------------------------------------------------------------------
String WifiProfilePSWD(byte profile) {
  if (profile == 1) {
    return PSWD2;
  }
  return PSWD;
}

//-------------------------------------------------------------------------------------------------------
byte NextWifiProfile(byte profile) {
  if (profile == 0 && WifiProfileConfigured(1)) {
    return 1;
  }
  return 0;
}

//-------------------------------------------------------------------------------------------------------
bool ConnectWiFiProfile(byte profile, int maxTryCount) {
  if (WifiProfileConfigured(profile) == false) {
    return false;
  }

  String wifiSsid = WifiProfileSSID(profile);
  String wifiPswd = WifiProfilePSWD(profile);

  WiFi.disconnect(false, false);
  delay(100);
  ApplyStaIdentity();
  WiFi.begin(wifiSsid.c_str(), wifiPswd.c_str());
  Serial.print("WIFI| Connecting ssid ");
  Serial.print(wifiSsid);
  Serial.print(" ");

  for (int count_try = 0; count_try < maxTryCount; count_try++) {
    if (WiFiStationReady()) {
      Serial.println();
      ActiveWifiProfile = profile;
      return true;
    }
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  print_wifi_error();
  return WiFiStationReady();
}

//-------------------------------------------------------------------------------------------------------
void FallbackToAPmode() {
  APmode = true;
  EEPROM.writeBool(0, true);
  EEPROM.commit();
  delay(500);
  ESP.restart();
}

//-------------------------------------------------------------------------------------------------------
// Matches a finished scan against both configured profiles, strongest AP first.
// Reads scan results only -- the caller owns starting the scan and deleting it.
//
// Choosing by what is actually on the air matters more than it looks: starting
// with profile 0 because it happens to be first costs a full connect timeout
// before the alternation ever reaches the profile that was in range all along.
uint8_t collectVisibleWifiProfiles(int found, WifiScanPick out[2]) {
  uint8_t count = 0;
  for (byte p = 0; p < 2; p++) {
    if (!WifiProfileConfigured(p)) continue;
    String want = WifiProfileSSID(p);
    int best = -1;
    int32_t bestRssi = -127;
    for (int i = 0; i < found; i++) {
      if (WiFi.SSID(i) != want) continue;
      int32_t rssi = WiFi.RSSI(i);
      if (best >= 0 && rssi <= bestRssi) continue;   // same SSID, weaker AP
      best = i;
      bestRssi = rssi;
    }
    if (best < 0) continue;
    out[count].profile = p;
    out[count].rssi = bestRssi;
    out[count].channel = WiFi.channel(best);
    const uint8_t* bssid = WiFi.BSSID(best);
    if (bssid) memcpy(out[count].bssid, bssid, 6);
    count++;
  }
  if (count == 2 && out[1].rssi > out[0].rssi) {
    WifiScanPick swap = out[0];
    out[0] = out[1];
    out[1] = swap;
  }
  return count;
}

void ConnectWiFiAlternating() {
  WiFi.mode(WIFI_STA);

  if (WifiProfileConfigured(0) == false && WifiProfileConfigured(1) == false) {
    Serial.println("WIFI| no configured SSID, staying in AP mode");
    FallbackToAPmode();
  }

  // Scan before connecting — avoids infinite loop when SSIDs are configured but not in range
  Serial.println("WIFI| scanning for configured networks...");
  int n = WiFi.scanNetworks();
  WifiScanPick visible[2];
  uint8_t visibleCount = collectVisibleWifiProfiles(n, visible);
  WiFi.scanDelete();

  if (visibleCount == 0) {
    Serial.println("WIFI| no configured SSID found in scan, switching to AP mode");
    FallbackToAPmode();
  }

  // Start with the profile the scan actually saw, strongest first, instead of
  // always profile 0. The alternation below still covers the other one.
  byte wifiProfile = visible[0].profile;
  Serial.print("WIFI| ");
  Serial.print(WifiProfileSSID(wifiProfile));
  Serial.print(" visible at ");
  Serial.print(visible[0].rssi);
  Serial.println(" dBm, trying it first");

  WifiTimer = millis();
  int attempts = 0;
  const int maxAttempts = 4;
  while (!WiFiStationReady()) {
    if (ConnectWiFiProfile(wifiProfile, wifi_max_try)) {
      break;
    }
    attempts++;
    if (attempts >= maxAttempts) {
      Serial.println("WIFI| max retries reached, switching to AP mode");
      FallbackToAPmode();
    }
    Serial.println("WIFI| switching to next configured SSID");
    wifiProfile = NextWifiProfile(wifiProfile);
  }
}

//-------------------------------------------------------------------------------------------------------

String IntToTenString(int NR) {
  String str = String(NR);
  while (str.length() < 10) {
    str = "0" + str;
  }
  return str;
}

//-------------------------------------------------------------------------------------------------------
void SplitString(String ORIGINAL, String* SplitStrFreq) {
  for (int i = 0; i < 5; i++) {
    SplitStrFreq[i] = ORIGINAL.substring(i * 2, i * 2 + 2);
    // Serial.println(SplitStrFreq[i]);
  }
}

//-------------------------------------------------------------------------------------------------------

byte stringToByte(String str) {
  // Převod prvního znaku na číslo
  byte prvniZnak = str.charAt(0) - '0';

  // Převod druhého znaku na číslo a posun do vyššího číselného řádu
  byte druhyZnak = str.charAt(1) - '0';

  // Sestavení výsledné hodnoty
  byte vysledek = (prvniZnak << 4) | druhyZnak;

  return vysledek;
}

//-------------------------------------------------------------------------------------------------------
// uint32_t readADC_Cal(int ADC_Raw)
// {
//   esp_adc_cal_characteristics_t adc_chars;

//   esp_adc_cal_characterize(ADC_UNIT_1, ADC_ATTEN_DB_11, ADC_WIDTH_BIT_12, 1100, &adc_chars);
//   return(esp_adc_cal_raw_to_voltage(ADC_Raw, &adc_chars));
// }

//-------------------------------------------------------------------------------------------------------
void print_wifi_error(){
  switch(WiFi.status())
  {
    case WL_IDLE_STATUS : Serial.println("WiFi| WL_IDLE_STATUS"); break;
    case WL_NO_SSID_AVAIL : Serial.println("WiFi| WL_NO_SSID_AVAIL"); break;
    case WL_CONNECT_FAILED : Serial.println("WiFi| WL_CONNECT_FAILED"); break;
    case WL_DISCONNECTED : Serial.println("WiFi| WL_DISCONNECTED"); break;
    default : Serial.printf("WiFi| No know WiFi error"); break;
  }
}
//-------------------------------------------------------------------------------------------------------
// void processCatMessages(){
//   #if defined(BLUETOOTH)
//     /*
//       <FE FE E0 42 04 00 01 FD  - LSB
//       <FE FE E0 42 03 00 00 58 45 01 FD  -145.580.000

//       FE FE - start bytes
//       00/E0 - target address (broadcast/controller)
//       42 - source address
//       00/03 - data type
//       <data>
//       FD - stop byte
//     */

//     while (CAT.available()) {
//       uint8_t knowncommand = 1;
//       uint8_t r;
//       if (readLine() > 0) {
//         if (read_buffer[0] == START_BYTE && read_buffer[1] == START_BYTE) {
//           if (read_buffer[3] == radio_address) {
//             if (read_buffer[2] == BROADCAST_ADDRESS) {
//               switch (read_buffer[4]) {
//                 case CMD_TRANS_FREQ:
//                   printFrequency();
//                   break;
//                 case CMD_TRANS_MODE:
//                   printMode();
//                   break;
//                 default:
//                   knowncommand = false;
//               }
//             } else if (read_buffer[2] == CONTROLLER_ADDRESS) {
//               switch (read_buffer[4]) {
//                 case CMD_READ_FREQ:
//                   printFrequency();
//                   break;
//                 case CMD_READ_MODE:
//                   printMode();
//                   break;
//                 default:
//                   knowncommand = false;
//               }
//             }
//           } else {
//             // if(Debug==true){
//             //   Serial.print(read_buffer[3]);
//             //   Serial.println(" also on-line?!");
//             // }
//           }
//         }
//         powerTimer=millis(); // RX BT

//       }

//       // if(Debug==true){
//       //   if(!knowncommand){
//       //   Serial.print("<");
//       //     if(read_buffer[10] == STOP_BYTE){
//       //       memcpy(read_buffer_snapshot, read_buffer, sizeof(read_buffer));
//       //       for (uint8_t i = 0; i < sizeof(read_buffer); i++){
//       //         if (read_buffer[i] < 16)Serial.print("0");
//       //         Serial.print(read_buffer[i], HEX);
//       //         Serial.print(" ");
//       //         if (read_buffer[i] == STOP_BYTE)break;
//       //       }
//       //       Serial.println();
//       //     }
//       //   }
//       // }
//     }

//   // #ifdef MIRRORCAT
//   //   while (Serial2.available()) {
//   //     CAT.print((byte)Serial2.read());
//   //   }
//   // #endif
//   #endif
// }
void processCatMessages(){
  #if defined(BLUETOOTH)
    while (CAT.available()) {
      uint8_t len = readLine();
      if (len == 0) return;

      if (len < 6) continue;
      if (read_buffer[0] != START_BYTE || read_buffer[1] != START_BYTE) continue;
      if (read_buffer[len - 1] != STOP_BYTE) continue;
      // if (read_buffer[3] != radio_address) continue;
      if (radio_address == 0x00) {
        radio_address = read_buffer[3];
        if (Debug == true) {
          Serial.print("CAT | learned radio address 0x");
          Serial.println(radio_address, HEX);
        }
        if (TrxSetupDone == false) {
          TrxNeedSet = 1;
        }
      } else if (read_buffer[3] != radio_address) {
        continue;
      }

      processCivBuffer(len);
      powerTimer = millis();
    }
  #endif
}

//-------------------------------------------------------------------------------------------------------
// Arm the capture for the next reply whose command and subaddress match. Clearing
// the previous reply is the point: the caller polls until the sequence moves, and
// a stale value left in place would answer the new question with the old address's
// number -- exactly the confusion alcSeq exists to prevent one layer up.
void civReadArm(const uint8_t *prefix, size_t prefixLen) {
  civReadPrefixLen = (uint8_t)(prefixLen > CIV_READ_MAX ? CIV_READ_MAX : prefixLen);
  memcpy(civReadPrefix, prefix, civReadPrefixLen);
  civReadReplyLen = 0;
  civReadAtMs = 0;
}

// One capture for every transport. Called from BOTH processCivBuffer() (which is
// where a LAN radio on TRX1 lands, because lanCivFrameRoute() delegates for slot
// 0 and returns) and lanRadioCivSnapshot() (every other slot). That split already
// cost two on-radio attempts when ALC was added to only one of them, so this is
// one function called twice rather than two copies of the same rule.
void civReadCapture(const uint8_t *frame, size_t len) {
  if (!civReadPrefixLen || !frame || len < 6) return;
  const size_t bodyLen = len - 5;               // cmd + payload, without FE FE <to> <from> and FD
  if (bodyLen < civReadPrefixLen) return;
  if (memcmp(frame + 4, civReadPrefix, civReadPrefixLen) != 0) return;
  civReadReplyLen = (uint8_t)(bodyLen > CIV_READ_MAX ? CIV_READ_MAX : bodyLen);
  memcpy(civReadReply, frame + 4, civReadReplyLen);
  civReadAtMs = millis();
  civReadSeq++;
}

// Parse one CI-V frame already in read_buffer (FE FE <to> <from> <cmd> payload FD)
// into the state globals. Transport-agnostic — used by BT (processCatMessages)
// and LAN (lanCivFrameHandler). Caller ensures the frame is from the radio.
void processCivBuffer(uint8_t len) {
  civReadCapture(read_buffer, len);
  gpsCivCapture(0, read_buffer, len);
  // to-addr: broadcast (00), BT controller (0xE0) or LAN controller (0xE1).
  // LAN poll replies are addressed to 0xE1 — without it, freq/mode from a poll
  // (as opposed to a transceive broadcast) would be dropped.
  if (read_buffer[2] == BROADCAST_ADDRESS || read_buffer[2] == CONTROLLER_ADDRESS
      || read_buffer[2] == 0xE1) {
    switch (read_buffer[4]) {
      case CMD_TRANS_FREQ:
      case CMD_READ_FREQ:
        if (len >= 11) printFrequency();
        break;

      case CMD_TRANS_MODE:
      case CMD_READ_MODE:
        if (len >= 7) {
          printMode();
          if (len >= 8) stateFilter = read_buffer[6];
        }
        break;

      // IC-705 selected-mode response: 26 00 <mode> <data> <filter>.
      // Unlike legacy 04 it reports DATA mode, so JS8LAN can distinguish USB-D.
      case 0x26:
        if (len >= 10 && read_buffer[5] == 0x00) {
          applyModeState(read_buffer[6], read_buffer[7] != 0);
          stateFilter = read_buffer[8];
        }
        break;
    }
  }

  // Update state variables from decoded CIV frames
  if (len >= 7) {
    const uint8_t cmd = read_buffer[4];
    const uint8_t *pl = read_buffer + 5;
    const size_t plLen = len - 6;
    if (cmd == 0x15 && plLen >= 2) {
      uint32_t raw = decodeCivBcdBytes(pl + 1, plLen - 1);
      if (pl[0] == 0x02) stateSmeterRaw = raw;
      else if (pl[0] == 0x11) statePowerMeterRaw = raw;
      else if (pl[0] == 0x12) stateSwr = 1.0f + ((float)raw * 3.0f / 120.0f);
      else if (pl[0] == 0x13) { stateAlcRaw = raw; stateAlcSeq++; }
      else if (pl[0] == 0x15) stateSupplyVolts = ((float)raw * 16.0f) / 241.0f;
    }
    if (cmd == 0x14 && plLen >= 2) {
      uint32_t raw = decodeCivBcdBytes(pl + 1, plLen - 1);
      if (pl[0] == 0x01) stateAfGain = (uint8_t)raw;
      else if (pl[0] == 0x02) stateRfGain = (uint8_t)raw;
      else if (pl[0] == 0x0C) stateKeySpeed = (uint8_t)raw;
      else if (pl[0] == 0x0A) { stateRfPower = (uint8_t)raw; stateRfPowerSeen = true; }
    }
    if (cmd == 0x21 && plLen >= 4 && pl[0] == 0x00) {
      stateRitRaw = decodeCivBcdBytesLsb(pl + 1, 3); // LSB-first, 3 bytes only, sign byte excluded
    }
    if (cmd == 0x1C && plLen >= 2 && pl[0] == 0x00) {
      bool newTx = (pl[1] == 0x01);
      if (newTx != stateTx) { Serial.print("CIV | radio TX state -> "); Serial.println(newTx ? "TX" : "RX"); }
      stateTx = newTx;
    }
    if (cmd == 0x04 && plLen >= 2) {
      stateFilter = (uint8_t)pl[1];
    }
    if (cmd == 0x11 && plLen >= 1) {
      stateAttOn = pl[0] ? 1 : 0;
      if (stateAttOn) statePreampMode = 3;
      else if (statePreampMode == 3) statePreampMode = 0;
    }
    if (cmd == 0x16 && plLen >= 2) {
      if (pl[0] == 0x02 && !stateAttOn) {
        statePreampMode = pl[1]; // 0=OFF, 1=AMP1, 2=AMP2 direct from radio
      }
      if (pl[0] == 0x47) {
        stateVoxMode = pl[1];
      }
    }
  }
}

//-------------------------------------------------------------------------------------------------------
// LAN transport hook: route a received CI-V frame through the shared parser so
// LAN gets the same full CAT state as BT (freq, mode, S-meter, TX, power, ...).
void lanCivFrameHandler(const uint8_t *frame, size_t len) {
  if (len < 6 || len > sizeof(read_buffer)) return;
  memcpy(read_buffer, frame, len);
  if (radio_address == 0x00) radio_address = frame[3];  // from-addr = the radio
  processCivBuffer((uint8_t)len);
}

void lanSecondaryCivFrameHandler(uint8_t slot, const uint8_t *frame, size_t len) {
  if (slot < 1 || slot > 2 || !frame || len < 6) return;
  uint8_t cmd = frame[4];
  if ((cmd == CMD_READ_FREQ || cmd == CMD_TRANS_FREQ) && len >= 11) {
    radioSlotSetFrequencyState(slot, decodeCivFrequencyBytes(frame + 5, 5));
    return;
  }
  if ((cmd == CMD_READ_MODE || cmd == CMD_TRANS_MODE) && len >= 7) {
    radioSlotSetModeState(slot, trxnetModeToString(frame[5]));
    return;
  }
  if (cmd == 0x26 && len >= 10 && frame[5] == 0x00) {
    radioSlotSetModeState(slot, trxnetModeToString(frame[6]));
  }
}

// A LAN radio outside slot 0 polls the very same rich CI-V schedule as TRX1
// (meters, TX state, RF power -- see the aux rotation in icomLanClient.h), so
// the data is already on the wire; only its destination differs. Keep what the
// JS8 page needs in the snapshot. Deliberately narrower than processCivBuffer:
// AF/RIT/preamp/VOX have no consumer on this path and report as 0 in the LAN
// view of /state.
void lanRadioCivSnapshot(const uint8_t *frame, size_t len) {
  if (!frame || len < 7) return;
  // The second of the two capture sites. See civReadCapture().
  civReadCapture(frame, len);
  gpsCivCapture(lanRadioSnap.slot, frame, len);
  const uint8_t cmd = frame[4];
  const uint8_t *pl = frame + 5;
  const size_t plLen = len - 6;
  // Mode with the DATA suffix: the thin per-slot state only knows "USB", but
  // JS8 has to be able to tell USB from USB-D.
  if (cmd == 0x26 && len >= 10 && pl[0] == 0x00) {
    const char *base = trxnetModeToString(pl[1]);
    snprintf(lanRadioSnap.mode, sizeof(lanRadioSnap.mode),
             pl[2] != 0 ? "%s-D" : "%s", base);
    lanRadioSnap.filter = pl[3];
    return;
  }
  if ((cmd == CMD_READ_MODE || cmd == CMD_TRANS_MODE) && len >= 7) {
    // Legacy 04: data-mode blind, so never let it overwrite a known -D mode.
    if (strstr(lanRadioSnap.mode, "-D") == nullptr)
      strlcpy(lanRadioSnap.mode, trxnetModeToString(pl[0]), sizeof(lanRadioSnap.mode));
    if (plLen >= 2) lanRadioSnap.filter = pl[1];
    return;
  }
  if (cmd == 0x1C && plLen >= 2 && pl[0] == 0x00) {
    bool newTx = (pl[1] == 0x01);
    if (newTx != lanRadioSnap.tx) {
      Serial.print("CIV | TRX"); Serial.print(lanRadioSnap.slot + 1);
      Serial.print(" radio TX state -> "); Serial.println(newTx ? "TX" : "RX");
    }
    lanRadioSnap.tx = newTx;
    return;
  }
  if (cmd == 0x14 && plLen >= 2 && pl[0] == 0x0A) {
    lanRadioSnap.rfPower = (uint8_t)decodeCivBcdBytes(pl + 1, plLen - 1);
    lanRadioSnap.rfPowerSeen = true;
  }
  if (cmd == 0x15 && plLen >= 2) {
    uint32_t raw = decodeCivBcdBytes(pl + 1, plLen - 1);
    if (pl[0] == 0x02) lanRadioSnap.smeterRaw = (uint16_t)raw;
    else if (pl[0] == 0x11) lanRadioSnap.powerMeterRaw = (uint16_t)raw;
    else if (pl[0] == 0x12) lanRadioSnap.swr = 1.0f + ((float)raw * 3.0f / 120.0f);
    else if (pl[0] == 0x13) { lanRadioSnap.alcRaw = (uint16_t)raw; lanRadioSnap.alcSeq++; }
    else if (pl[0] == 0x15) lanRadioSnap.supplyVolts = ((float)raw * 16.0f) / 241.0f;
  }
}

// Every decoded LAN frame lands here. TRX1 owns the shared CAT globals; any
// other slot feeds the thin per-slot state that the log/BD pages read, plus the
// snapshot when it is the LAN radio driving JS8.
void lanCivFrameRoute(uint8_t slot, const uint8_t *frame, size_t len) {
  if (slot == 0) { lanCivFrameHandler(frame, len); return; }
  lanSecondaryCivFrameHandler(slot, frame, len);
  if (slot == lanRadioSnap.slot) lanRadioCivSnapshot(frame, len);
}

//-------------------------------------------------------------------------------------------------------
// call back to get info about connection
#if defined(BLUETOOTH)
void callback(esp_spp_cb_event_t event, esp_spp_cb_param_t *param){
  (void)param;
  if (event == ESP_SPP_SRV_OPEN_EVT) {
    btConnectPending = true;
    btStateBroadcastPending = true;
  }
  if (event == ESP_SPP_CLOSE_EVT) {
    btDisconnectPending = true;
    btStateBroadcastPending = true;
  }
}
#endif
//-------------------------------------------------------------------------------------------------------
// void configRadioBaud(uint16_t  baudrate){
//   #if defined(BLUETOOTH)
//     if (!CAT.begin(BTname)) //Bluetooth device name
//     {
//       Serial.println(" BT | An error occurred initializing Bluetooth");
//     } else {
//       CAT.register_callback(callback);
//       Serial.println(" BT | Initialized");
//       Serial.println("    | -----------------------------------------------------------------------------");
//       Serial.println(" BT | The device started, now you MUST PAIR it with Bluetooth name "+String(BTname));
//     }
//   #endif
// }
void configRadioBaud(uint16_t baudrate){
  #if defined(BLUETOOTH)
    static bool btInitDone = false;
    if (btInitDone) return;

    if (BT_NAME.length() == 0) {
      uint8_t mac[6];
      WiFi.macAddress(mac);
      char defName[22];
      snprintf(defName, sizeof(defName), "IC705-%02X%02X%02X", mac[3], mac[4], mac[5]);
      BT_NAME = String(defName);
    }
    if (!CAT.begin(BT_NAME)) {
      Serial.println(" BT | An error occurred initializing Bluetooth");
    } else {
      CAT.register_callback(callback);
      Serial.println(" BT | Initialized");
      Serial.println("    | -----------------------------------------------------------------------------");
      Serial.println(" BT | The device started, now you MUST PAIR it with Bluetooth name " + BT_NAME);
      Serial.println("    | -----------------------------------------------------------------------------");
      btInitDone = true;
    }
  #endif
}

//-------------------------------------------------------------------------------------------------------
uint8_t readLine(void){
  #if defined(BLUETOOTH)
    uint8_t byte;
    uint8_t counter = 0;
    uint32_t ed = readtimeout;
    read_buffer[10] = 0x00;

    while (true)
    {
      while (!CAT.available()) {
        if (--ed == 0)return 0;
      }
      ed = readtimeout;
      byte = CAT.read();
      if (byte == 0xFF)continue; //TODO skip to start byte instead
      // #ifdef MIRRORCAT
      //     Serial2.write(byte); // !byte
      // #endif

      read_buffer[counter++] = byte;
      if (STOP_BYTE == byte) break;

      if (counter >= sizeof(read_buffer))return 0;
    }
    return counter;
  #endif
}
//-------------------------------------------------------------------------------------------------------
void radioSetMode(uint8_t modeid, uint8_t modewidth){
  // catWriteFrame routes to lanClient for LAN, so this works on every transport.
  uint8_t req[] = {START_BYTE, START_BYTE, radio_address, CONTROLLER_ADDRESS, CMD_WRITE_MODE, modeid, modewidth, STOP_BYTE};
  catWriteFrame(req, sizeof(req), true);
}
//-------------------------------------------------------------------------------------------------------
bool radioSetFrequency(uint32_t freqHz){
  // Remote set-VFO (TrxNet /s-hz, OI3). catWriteFrame routes to lanClient for LAN,
  // so this must NOT be guarded by BLUETOOTH.
  bool linkUp = radioLinkUp();
  if (!linkUp || radio_address == 0x00) {
    return false;
  }

  String strFreq = IntToTenString(freqHz);
  String splitFreq[5];
  SplitString(strFreq, splitFreq);

  uint8_t req[] = {
    START_BYTE, START_BYTE, radio_address, CONTROLLER_ADDRESS, CMD_WRITE_FREQ,
    stringToByte(splitFreq[4]),
    stringToByte(splitFreq[3]),
    stringToByte(splitFreq[2]),
    stringToByte(splitFreq[1]),
    stringToByte(splitFreq[0]),
    STOP_BYTE
  };

  catWriteFrame(req, sizeof(req), true);
  return true;
}
//-------------------------------------------------------------------------------------------------------
void sendCatRequest(uint8_t requestCode){
  #if defined(BLUETOOTH)
    uint8_t req[] = {START_BYTE, START_BYTE, radio_address, CONTROLLER_ADDRESS, requestCode, STOP_BYTE};
    catWriteFrame(req, sizeof(req), true);
  #endif
}
//-------------------------------------------------------------------------------------------------------
bool searchRadio(){
  #if defined(BLUETOOTH)
    sendCatRequest(CMD_READ_FREQ);

    uint8_t len = readLine();
    if (len > 0) {
      if (read_buffer[0] == START_BYTE && read_buffer[1] == START_BYTE) {
        radio_address = read_buffer[3];
        if (Debug == true) {
          Serial.print("CAT | found radio address 0x");
          Serial.println(radio_address, HEX);
        }
        return true;
      }
    }
    return false;
  #endif
}
  
//-------------------------------------------------------------------------------------------------------
void printFrequency(void){
  // CI-V BCD frequency decode — shared by BT and LAN (lanCivFrameHandler feeds the
  // same read_buffer). Must NOT be guarded by BLUETOOTH or LAN loses its frequency.
      frequency = 0;
      //FE FE E0 42 03 <00 00 58 45 01> FD ic-820
      //FE FE 00 40 00 <00 60 06 14> FD ic-732
      for (uint8_t i = 0; i < 5; i++) {
        if (read_buffer[9 - i] == 0xFD)continue; //spike
        frequency += (read_buffer[9 - i] >> 4) * decMulti[i * 2];
        frequency += (read_buffer[9 - i] & 0x0F) * decMulti[i * 2 + 1];
      }
}
//-------------------------------------------------------------------------------------------------------
// void printMode(void){
//   #if defined(BLUETOOTH)
//     //FE FE E0 42 04 <00 01> FD
//     if(Debug==true){
//       Serial.println(mode[read_buffer[5]]);
//     }
//     modes = mode[read_buffer[5]];
//     //read_buffer[6] -> 01 - Wide, 02 - Medium, 03 - Narrow
//   #endif
// }
bool applyModeState(uint8_t modeId, bool dataMode){
  const char *base = nullptr;
  switch (modeId) {
    case 0x00: base = "LSB"; break;
    case 0x01: base = "USB"; break;
    case 0x02: base = "AM"; break;
    case 0x03: base = "CW"; break;
    case 0x04: base = "RTTY"; break;
    case 0x05: base = "FM"; break;
    case 0x06: base = "WFM"; break;
    case 0x07: base = "CW-R"; break;
    case 0x08: base = "RTTY-R"; break;
    case 0x17: base = "DV"; break;
    default: setModesText("UNK"); return false;
  }
  stateModeId = modeId;      // remember numeric id + data flag for exact restore
  stateDataMode = dataMode;
  char displayMode[sizeof(modes)];
  snprintf(displayMode, sizeof(displayMode), dataMode ? "%s-D" : "%s", base);
  setModesText(displayMode);
  return true;
}

void printMode(void){
  // CI-V mode decode — shared by BT and LAN. Must NOT be guarded by BLUETOOTH.
    uint8_t modeId = read_buffer[5];
    if (!applyModeState(modeId, false)) {
      if (Debug == true) {
        Serial.print("CAT | invalid/unknown mode id: 0x");
        if (modeId < 16) Serial.print("0");
        Serial.println(modeId, HEX);
      }
      return;
    }

    if (Debug == true) {
      char modesSnapshot[sizeof(modes)];
      copyModesText(modesSnapshot, sizeof(modesSnapshot));
      Serial.print("CAT | mode=");
      Serial.println(modesSnapshot);
    }
}
//-------------------------------------------------------------------------------------------------------
//-------------------------------------------------------------------------------------------------------
// TrxNet loop — replaces Mqtt(). Handles net.loop() and WiFi reconnect detection.
// net.begin() is re-called on WiFi reconnect to re-broadcast discovery probe.
void TrxNetLoop(){
  if (APmode || TRXNET_ID == 0x00) return;
  if ((long)(millis() - webQuietUntil) < 0) return;
  static bool prevWifiConnected = WiFiStationReady();
  bool wifiConnected = WiFiStationReady();
  if (wifiConnected && !prevWifiConnected) {
    // WiFi reconnected — re-announce to network
    net.begin(trxDeviceName);
    trxNetEnabled = true;
    Serial.print("TRXNET| reconnect begin ");
    Serial.println(trxDeviceName);
  }
  prevWifiConnected = wifiConnected;
  if (trxNetEnabled && wifiConnected) net.loop();
}

//-------------------------------------------------------------------------------------------------------
// TrxNet callbacks — called from net.loop(), must be short and non-blocking.

// Helper: match sender device name against a configured TrxNet peer.
// Returns radio slot index (0=TRX1, 1=TRX2, 2=TRX3) or -1 if no match.
static int trxnetPeerSlot(const char* from) {
  char expected[TRXNET_MAX_DEVICE_NAME];
  for (uint8_t slot = 0; slot < 3; slot++) {
    if (!radioSlots[slot].enabled || radioSlots[slot].transport != RADIO_TRXNET
        || radioSlots[slot].netId == 0x00 || radioSlots[slot].netId == 0xff)
      continue;
    snprintf(expected, sizeof(expected), "OI3.%02x", radioSlots[slot].netId);
    if (strcmp(from, expected) == 0) return slot;
  }
  return -1;
}

// Convert CI-V mode byte to display string for Band Decoder / web UI.
// Returns nullptr for unknown/ignored values.
static const char* trxnetModeToString(uint8_t civMode) {
  switch (civMode) {
    case 0x00: return "LSB";
    case 0x01: return "USB";
    case 0x02: return "AM";
    case 0x03: return "CW";
    case 0x04: return "RTTY";
    case 0x05: return "FM";
    case 0x06: return "WFM";
    case 0x07: return "CW-R";
    case 0x08: return "RTTY-R";
    case 0x17: return "DV";
    default:   return nullptr;
  }
}

// Receive /hz from a configured peer — update the matching TRX slot.
void onTrxHz(const char* from, const uint8_t* data, size_t len) {
  if (len < sizeof(uint32_t)) return;
  uint32_t freq;
  memcpy(&freq, data, sizeof(freq));
  int slot = trxnetPeerSlot(from);
  if (slot < 0) return;
  radioSlotSetFrequencyState((uint8_t)slot, freq);
  if (Debug) Serial.printf("TRXN| TRX%d freq=%lu\n", slot + 1, (unsigned long)freq);
}

// Receive /mode from a configured peer — update the matching TRX slot.
void onTrxMode(const char* from, const uint8_t* data, size_t len) {
  if (len < sizeof(uint8_t)) return;
  int slot = trxnetPeerSlot(from);
  if (slot < 0) return;
  const char* modeStr = trxnetModeToString(data[0]);
  if (modeStr != nullptr) {
    radioSlotSetModeState((uint8_t)slot, modeStr);
    if (Debug) Serial.printf("TRXN| TRX%d mode=%s\n", slot + 1, modeStr);
  }
}

// Receive /s-hz — remote command to set IC-705 VFO frequency via CI-V.
void onTrxSetHz(const char* from, const uint8_t* data, size_t len) {
  if (len < sizeof(uint32_t)) return;
  uint32_t newFreq;
  memcpy(&newFreq, data, sizeof(newFreq));
  if (newFreq == 0) return;
  trxPendingHz   = newFreq;
  trxFreqPending = true;
}

//-----------------------------------------------------------------------------------
// Serial CI-V driver for TRX1/TRX2/TRX3 (shares UART0 with CLI/debug, gated by CIVmutePin)
//
// TRX2/3 can be reached either via TrxNet (CONN_TYPE=0) or via CI-V on the serial
// bus (CONN_TYPE=1). When CI-V is selected we poll freq (03) and mode (04) and also
// passively accept Transceive broadcasts; results land in the same g_trxFreq /
// g_trxMode / g_trxHasData slots used by the TrxNet path, so band decoder, web UI
// and the PHP log (port 81) are transport-agnostic.

static const uint32_t CIV_POLL_INTERVAL_MS = 750;  // per full round (TRX2+TRX3, freq+mode)
static const uint32_t CIV_REPLY_TIMEOUT_MS = 250;  // wait for a single reply
static const uint32_t CIV_GAP_MS           = 40;   // bus turnaround between messages
static const uint8_t  CIV_MAX_MISS         = 3;    // consecutive timeouts -> slot stale

enum CivPollState { CIV_IDLE, CIV_WAIT };
static CivPollState civState   = CIV_IDLE;
static uint8_t  civSeq         = 0;        // schedule index 0..5 (see civSeqSlot/Cmd)
static uint32_t civStateT0     = 0;
static uint32_t civNextRun     = 0;
static uint8_t  civMiss[3]     = {0, 0, 0};
static uint8_t  civAwaitSlot   = 0xFF;     // slot we sent the current query to
static uint8_t  civAwaitCmd    = 0;
static bool     civGotReply    = false;
static uint32_t civReplyMs     = 0;        // millis() a matching reply arrived

// frame parser. 40, not 20: a 23 00 GPS reply carries 27 data bytes and the
// framer drops (not truncates) anything longer than this buffer.
static uint8_t  civRxBuf[40];
static uint8_t  civRxLen       = 0;
static bool     civInFrame     = false;
static uint8_t  civPreCount    = 0;        // consecutive START_BYTE seen

static inline uint8_t civSlotAddr(uint8_t idx) {
  return idx < 3 ? radioSlots[idx].civAddr : 0x00;
}
static inline bool civSlotEnabled(uint8_t idx) {
  return idx < 3 && radioSlots[idx].enabled
      && radioSlots[idx].transport == RADIO_CIV
      && radioSlots[idx].civAddr != 0x00;
}
static inline bool civAnyEnabled() {
  return civSlotEnabled(0) || civSlotEnabled(1) || civSlotEnabled(2);
}

// schedule mapping: seq 0..5 -> (slot, cmd)
static inline uint8_t civSeqSlot(uint8_t seq) { return seq >> 1; }          // 0,0,1,1,2,2
static inline uint8_t civSeqCmd(uint8_t seq)  { return (seq & 1) ? CMD_READ_MODE : CMD_READ_FREQ; }

// Send a CI-V frame: FE FE <toAddr> E0 <body...> FD, gated by MUTE so debug never
// leaks onto the bus. Synchronous and short (a few bytes).
static void civSend(uint8_t toAddr, const uint8_t* body, size_t bodyLen) {
  Serial.flush();                 // drain pending debug bytes before opening the gate
  digitalWrite(CIVmutePin, LOW);
  delay(2);
  Serial.write(START_BYTE);
  Serial.write(START_BYTE);
  Serial.write(toAddr);
  Serial.write(CONTROLLER_ADDRESS);
  for (size_t i = 0; i < bodyLen; i++) Serial.write(body[i]);
  Serial.write(STOP_BYTE);
  Serial.flush();
  delay(2);
  digitalWrite(CIVmutePin, HIGH);
}

static void civQuery(uint8_t slot, uint8_t cmd) {
  uint8_t body = cmd;
  civAwaitSlot = slot;
  civAwaitCmd  = cmd;
  civGotReply  = false;
  civSend(civSlotAddr(slot), &body, 1);
}

// Write frequency (cmd 05) to a CI-V TRX. Frequency is 5 BCD bytes, LSB-first.
void civWriteFreq(uint8_t addr, uint32_t hz) {
  if (addr == 0x00 || hz == 0) return;
  String s = IntToTenString((int)hz);     // 10 digits, MSB-first
  String pairs[5];
  SplitString(s, pairs);                   // pairs[0]=MS .. pairs[4]=LS
  uint8_t body[6];
  body[0] = CMD_WRITE_FREQ;
  for (int i = 0; i < 5; i++) body[1 + i] = stringToByte(pairs[4 - i]);  // LSB-first
  civSend(addr, body, 6);
}

// Decode a completed CI-V frame held in civRxBuf (length civRxLen, last byte = FD).
// Layout after the FE FE preamble: [0]=toAddr [1]=fromAddr [2]=cmd [payload...] [FD].
static void civHandleFrame() {
  if (civRxLen < 4) return;                          // need toAddr,fromAddr,cmd,FD
  uint8_t toAddr   = civRxBuf[0];
  uint8_t fromAddr = civRxBuf[1];
  uint8_t cmd      = civRxBuf[2];
  // Accept only frames addressed to the controller or broadcast; drop our own echo.
  if (toAddr != CONTROLLER_ADDRESS && toAddr != BROADCAST_ADDRESS) return;

  int slot = -1;
  for (uint8_t candidate = 0; candidate < 3; candidate++) {
    if (civSlotEnabled(candidate) && fromAddr == radioSlots[candidate].civAddr) {
      slot = candidate;
      break;
    }
  }
  if (slot < 0) return;

  const uint8_t* pl = civRxBuf + 3;
  size_t plLen = (size_t)civRxLen - 4;              // minus toAddr,fromAddr,cmd,FD

  if (slot == 0) {
    size_t fullLen = (size_t)civRxLen + 2;
    if (fullLen <= sizeof(read_buffer)) {
      read_buffer[0] = START_BYTE;
      read_buffer[1] = START_BYTE;
      memcpy(read_buffer + 2, civRxBuf, civRxLen);
      radio_address = fromAddr;
      processCivBuffer((uint8_t)fullLen);
      primarySerialHasData = true;
    }
  } else if ((cmd == CMD_READ_FREQ || cmd == CMD_TRANS_FREQ) && plLen >= 5) {
    radioSlotSetFrequencyState((uint8_t)slot, decodeCivFrequencyBytes(pl, 5));
  } else if ((cmd == CMD_READ_MODE || cmd == CMD_TRANS_MODE) && plLen >= 1) {
    radioSlotSetModeState((uint8_t)slot, trxnetModeToString(pl[0]));
  }

  if (cmd == CMD_READ_FREQ || cmd == CMD_TRANS_FREQ
      || cmd == CMD_READ_MODE || cmd == CMD_TRANS_MODE) {
    civMiss[slot] = 0;
    bool frequencyReply = (cmd == CMD_READ_FREQ || cmd == CMD_TRANS_FREQ)
                       && civAwaitCmd == CMD_READ_FREQ;
    bool modeReply = (cmd == CMD_READ_MODE || cmd == CMD_TRANS_MODE)
                  && civAwaitCmd == CMD_READ_MODE;
    if (civAwaitSlot == slot && (frequencyReply || modeReply)) {
      civGotReply = true;
      civReplyMs = millis();
    }
    if (Debug) Serial.printf("CIV| TRX%d reply cmd=0x%02x\n", slot + 1, cmd);
  }
}

// Feed one received byte to the CI-V framer. Returns true if the byte was consumed
// as part of a CI-V frame (FE FE .. FD); false means it belongs to the CLI.
bool civParserFeed(uint8_t b) {
  if (!civInFrame) {
    if (b == START_BYTE) {
      if (civPreCount < 2) civPreCount++;
      if (civPreCount == 2) { civInFrame = true; civRxLen = 0; }
      return true;                                  // 0xFE is never a CLI command
    }
    civPreCount = 0;
    return false;                                   // hand to CLI
  }
  // inside a frame
  if (civRxLen < sizeof(civRxBuf)) {
    civRxBuf[civRxLen++] = b;
  } else {
    civInFrame = false; civPreCount = 0; civRxLen = 0;  // overflow, drop
    return true;
  }
  if (b == STOP_BYTE) {
    civHandleFrame();
    civInFrame = false; civPreCount = 0; civRxLen = 0;
  }
  return true;
}

// Non-blocking polling state machine. Sends one query per visit and lets the parser
// (driven by serialPump) collect the reply across subsequent loop iterations.
void civPollTick() {
  if (!civAnyEnabled()) { civState = CIV_IDLE; return; }
  uint32_t now = millis();

  if (civState == CIV_WAIT) {
    if (civGotReply) {
      civRttMs = civReplyMs - civStateT0;
      if (civRttMs > civRttMaxMs) civRttMaxMs = civRttMs;
      civState   = CIV_IDLE;
      civNextRun = now + CIV_GAP_MS;
    } else if (now - civStateT0 >= CIV_REPLY_TIMEOUT_MS) {
      uint8_t slot = civAwaitSlot;
      if (slot < 3) {
        if (civMiss[slot] < 255) civMiss[slot]++;
        if (civMiss[slot] >= CIV_MAX_MISS) {
          if (slot == 0) {
            primarySerialHasData = false;
            frequency = 0;
            setModesText("OFF");
          } else if (g_trxHasData[slot - 1]) {
            g_trxHasData[slot - 1] = false;
            g_trxFreq[slot - 1] = 0;
          }
        }
      }
      civState   = CIV_IDLE;
      civNextRun = now + CIV_GAP_MS;
    }
    return;
  }

  // CIV_IDLE
  if ((int32_t)(now - civNextRun) < 0) return;

  // advance to the next enabled slot in the schedule
  for (uint8_t tries = 0; tries < 6; tries++) {
    uint8_t slot = civSeqSlot(civSeq);
    if (civSlotEnabled(slot)) break;
    civSeq = (civSeq + 1) % 6;
  }

  uint8_t slot = civSeqSlot(civSeq);
  uint8_t cmd  = civSeqCmd(civSeq);
  bool higherSlotEnabled = false;
  for (uint8_t higher = slot + 1; higher < 3; higher++)
    if (civSlotEnabled(higher)) higherSlotEnabled = true;
  bool roundEnd = (cmd == CMD_READ_MODE) && !higherSlotEnabled;

  civQuery(slot, cmd);
  civStateT0 = now;
  civState   = CIV_WAIT;

  civSeq = (civSeq + 1) % 6;
  if (roundEnd) civNextRun = now + CIV_POLL_INTERVAL_MS;  // pace whole round
}

//-------------------------------------------------------------------------------------------------------
// GPS position from the radio. 23 00 reads MY position (read-only, 27 BCD data
// bytes), 23 01 the GPS Select setting; both per the IC-705 CI-V reference
// guide p. 12/21/25 (docs/IC-705_ENG_CI-V_1_20200721.pdf). The nibble layouts
// below are transcribed from the p. 21 diagram, which is the only place the
// guide states them.

// The slot whose GPS the station reports: the LAN radio when one is configured
// -- that is the radio the JS8/WSPR pages drive -- else a serial CI-V TRX1.
// TrxNet is deliberately out: that transport carries no arbitrary CAT.
uint8_t gpsTargetSlot(void) {
  uint8_t lanSlot = lanRadioSlotIndex();
  if (lanSlot != 0xFF) return lanSlot;
  if (civSlotEnabled(0)) return 0;
  return 0xFF;
}

static void gpsReset(void) {
  gpsSupport = GPS_UNKNOWN;
  gpsProbesSent = 0;
  gpsSel = 0;
  gpsGrid[0] = 0;
  gpsDataSeen = false;
  gpsStampSeen = false;
  gpsStampChangedMs = 0;
  gpsSelAsked = false;
}

// One BCD nibble pair per byte, high nibble first. Any nibble above 9 rejects
// the block -- that is also how the FF fill of "no fix since power-on" lands
// here, so a reject is a normal answer, not corruption.
static bool gpsNibbles(const uint8_t *bytes, size_t count, uint8_t *out) {
  for (size_t i = 0; i < count; i++) {
    uint8_t hi = bytes[i] >> 4, lo = bytes[i] & 0x0F;
    if (hi > 9 || lo > 9) return false;
    out[2 * i] = hi;
    out[2 * i + 1] = lo;
  }
  return true;
}

// Latitude, 5 bytes: [d10 d1][m10 m1][m.1 m.01][m.001 0][0 N=1/S=0].
static bool gpsDecodeLat(const uint8_t *b, double *out) {
  uint8_t n[8];
  if (!gpsNibbles(b, 4, n)) return false;
  uint8_t sign = b[4] & 0x0F;
  if ((b[4] >> 4) != 0 || sign > 1) return false;
  double minutesThousandths = (n[2] * 10 + n[3]) * 1000.0
                            + n[4] * 100 + n[5] * 10 + n[6];
  double v = (n[0] * 10 + n[1]) + minutesThousandths / 60000.0;
  *out = sign ? v : -v;
  return true;
}

// Longitude, 6 bytes: [0 d100][d10 d1][m10 m1][m.1 m.01][m.001 0][0 E=1/W=0].
static bool gpsDecodeLon(const uint8_t *b, double *out) {
  uint8_t n[10];
  if (!gpsNibbles(b, 5, n)) return false;
  uint8_t sign = b[5] & 0x0F;
  if ((b[5] >> 4) != 0 || sign > 1) return false;
  double minutesThousandths = (n[4] * 10 + n[5]) * 1000.0
                            + n[6] * 100 + n[7] * 10 + n[8];
  double v = (n[1] * 100 + n[2] * 10 + n[3]) + minutesThousandths / 60000.0;
  *out = sign ? v : -v;
  return true;
}

// 8-character Maidenhead locator, uppercase throughout -- the APRS builder's
// LOCATOR_RE accepts only capitals, and the SETUP identity grid is stored the
// same way.
static void gpsLatLonToGrid(double lat, double lon, char out[9]) {
  double x = lon + 180.0, y = lat + 90.0;
  if (x < 0) x = 0; else if (x >= 360.0) x = 359.9999;
  if (y < 0) y = 0; else if (y >= 180.0) y = 179.9999;
  out[0] = 'A' + (int)(x / 20.0);
  out[1] = 'A' + (int)(y / 10.0);
  out[2] = '0' + (int)fmod(x / 2.0, 10.0);
  out[3] = '0' + (int)fmod(y, 10.0);
  out[4] = 'A' + (int)fmod(x * 12.0, 24.0);
  out[5] = 'A' + (int)fmod(y * 24.0, 24.0);
  out[6] = '0' + (int)fmod(x * 120.0, 10.0);
  out[7] = '0' + (int)fmod(y * 240.0, 10.0);
  out[8] = 0;
}

// Both delivery paths land here -- processCivBuffer() for TRX1, and
// lanRadioCivSnapshot() for a LAN radio in another slot -- one function called
// twice, for the same reason as civReadCapture(). Any 23 reply proves the model
// has GPS commands at all, which is what ends the probe.
void gpsCivCapture(uint8_t slot, const uint8_t *frame, size_t len) {
  if (slot != gpsTargetSlot()) return;
  if (len < 8 || frame[4] != 0x23) return;
  gpsSupport = GPS_SUPPORTED;
  const uint8_t sub = frame[5];
  const uint8_t *pl = frame + 6;
  const size_t plLen = len - 7;             // data between sub and FD
  if (sub == 0x01) {
    if (plLen >= 1) gpsSel = pl[0];
    return;
  }
  if (sub != 0x00 || plLen < 27) return;
  memcpy(gpsData, pl, sizeof(gpsData));     // altitude/course/speed decode on demand in /gps
  gpsDataSeen = true;
  double lat, lon;
  if (gpsDecodeLat(pl, &lat) && gpsDecodeLon(pl + 5, &lon))
    gpsLatLonToGrid(lat, lon, gpsGrid);     // FF fill decodes false -> keep last known
  // Movement of the UTC stamp (data bytes 21-27) is the freshness signal. The
  // first stored stamp is observation, not movement -- see the globals block.
  if (memcmp(gpsStamp, pl + 20, sizeof(gpsStamp)) != 0) {
    if (gpsStampSeen) gpsStampChangedMs = millis();
    memcpy(gpsStamp, pl + 20, sizeof(gpsStamp));
  }
  gpsStampSeen = true;
}

static void gpsSendQuery(uint8_t slot, uint8_t sub) {
  // Not buildSimpleCatFrame(): that helper requires TRX1's learned
  // radio_address, and the GPS target may be a LAN radio in another slot.
  // catWriteFrameSlot() re-addresses the frame per transport anyway.
  uint8_t frame[7] = { START_BYTE, START_BYTE, civSlotAddr(slot),
                       CONTROLLER_ADDRESS, 0x23, sub, STOP_BYTE };
  catWriteFrameSlot(slot, frame, sizeof(frame));
}

// One frame per 500 ms tick at most: 23 00 every 5 s once supported, 23 01
// every 60 s (the operator can flip GPS Select in the radio menu at any time).
// Three probes 2 s apart decide "no GPS" -- an NG reply is not parsed, a radio
// that answers FA simply times out into the same verdict. On the serial bus a
// query waits for the freq/mode poller's idle gap so two frames never collide;
// the LAN client queues and paces its CI-V channel internally.
void gpsPollTick(void) {
  static uint32_t lastTick = 0;
  uint32_t now = millis();
  if (now - lastTick < 500) return;
  lastTick = now;
  uint8_t slot = gpsTargetSlot();
  bool linked = slot != 0xFF && radioSlotConnected(slot);
  if (!linked) {
    if (gpsSupport != GPS_UNKNOWN || gpsStampSeen || gpsGrid[0]) gpsReset();
    gpsWasLinked = false;
    return;
  }
  if (!gpsWasLinked) { gpsReset(); gpsWasLinked = true; }  // fresh probe per link-up
  if (gpsSupport == GPS_UNSUPPORTED) return;
  if (radioSlots[slot].transport == RADIO_CIV && civState != CIV_IDLE) return;

  if (gpsSupport == GPS_UNKNOWN) {
    if (now - gpsPosSentMs < 2000) return;
    if (gpsProbesSent >= 3) {
      gpsSupport = GPS_UNSUPPORTED;
      Serial.println("GPS | no answer to 23 00 -- radio has no GPS");
      return;
    }
    gpsSendQuery(slot, 0x00);
    gpsProbesSent++;
    gpsPosSentMs = now;
    return;
  }
  if (!gpsSelAsked || now - gpsSelSentMs >= 60000) {
    gpsSendQuery(slot, 0x01);
    gpsSelAsked = true;
    gpsSelSentMs = now;
    return;
  }
  if (now - gpsPosSentMs >= 5000) {
    gpsSendQuery(slot, 0x00);
    gpsPosSentMs = now;
  }
}

// Everything the 23 00 reply carries, decoded field by field. The guide allows
// any block to arrive as FF fill (documented for altitude, observed convention
// elsewhere), so each field is null on its own rather than the document failing
// whole. 404 when the radio has no GPS: absence is the answer, exactly like the
// missing gps fields in /state -- the topbar only asks while the segment exists.
void handleGetGps() {
  webServer.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  webServer.sendHeader("Connection", "close");
  webServer.client().setNoDelay(true);
  if (gpsSupport != GPS_SUPPORTED) {
    webServer.send(404, "application/json", "{\"error\":\"no_gps\"}");
    return;
  }
  uint32_t age = gpsStampChangedMs ? (millis() - gpsStampChangedMs) : 999999999u;
  if (age > 999999999u) age = 999999999u;
  String json = "{\"grid\":\"";
  json += gpsGrid;
  json += "\",\"sel\":" + String((unsigned)gpsSel);
  json += ",\"fixAgeMs\":" + String((unsigned long)age);
  char field[40];
  double lat, lon;
  if (gpsDataSeen && gpsDecodeLat(gpsData, &lat) && gpsDecodeLon(gpsData + 5, &lon)) {
    snprintf(field, sizeof(field), ",\"lat\":%.6f,\"lon\":%.6f", lat, lon);
    json += field;
  } else {
    json += ",\"lat\":null,\"lon\":null";
  }
  // Altitude 4 B: six BCD digits counting 0.1 m steps, then a fixed 0 nibble and
  // the sign (0=+, 1=-). One number in tenths, exactly like speed below -- NOT
  // whole metres with the tenth kept in the last byte, which is how the p. 21
  // diagram first read and which made every altitude come out ten times too big.
  // Verified against a real IC-705: 00 45 99 00 is 459.9 m.
  uint8_t n[8];
  if (gpsDataSeen && gpsNibbles(gpsData + 11, 3, n)
      && (gpsData[14] >> 4) == 0 && (gpsData[14] & 0x0F) <= 1) {
    double alt = (n[0] * 100000.0 + n[1] * 10000.0 + n[2] * 1000.0
                + n[3] * 100.0 + n[4] * 10.0 + n[5]) * 0.1;
    if (gpsData[14] & 0x0F) alt = -alt;
    snprintf(field, sizeof(field), ",\"altM\":%.1f", alt);
    json += field;
  } else {
    json += ",\"altM\":null";
  }
  // Course 2 B, four BCD digits, 1-degree steps (0360 = 360).
  if (gpsDataSeen && gpsNibbles(gpsData + 15, 2, n)) {
    unsigned course = n[0] * 1000u + n[1] * 100u + n[2] * 10u + n[3];
    snprintf(field, sizeof(field), ",\"courseDeg\":%u", course);
    json += field;
  } else {
    json += ",\"courseDeg\":null";
  }
  // Speed 3 B, six BCD digits in 0.1 km/h steps.
  if (gpsDataSeen && gpsNibbles(gpsData + 17, 3, n)) {
    double speed = (n[0] * 100000.0 + n[1] * 10000.0 + n[2] * 1000.0
                  + n[3] * 100.0 + n[4] * 10.0 + n[5]) * 0.1;
    snprintf(field, sizeof(field), ",\"speedKmh\":%.1f", speed);
    json += field;
  } else {
    json += ",\"speedKmh\":null";
  }
  // Date 7 B BCD: yyyymmddHHMMSS, UTC.
  uint8_t d[14];
  if (gpsDataSeen && gpsNibbles(gpsData + 20, 7, d)) {
    snprintf(field, sizeof(field), ",\"utc\":\"%u%u%u%u-%u%u-%u%u %u%u:%u%u:%u%u\"",
             d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7],
             d[8], d[9], d[10], d[11], d[12], d[13]);
    json += field;
  } else {
    json += ",\"utc\":null";
  }
  json += "}";
  webServer.send(200, "application/json", json);
}

//-----------------------------------------------------------------------------------

//-------------------------------------------------------------------------------------------------------
// Keys CwMsg in the radio's current mode. Returns false when that mode has no
// keying path here, so a caller can tell a transmission from a silent drop --
// /cmd used to answer ok:true either way, and the log page believed it.
//
// The reverse modes key exactly like their upright twins: CW-R and RTTY-R differ
// only in which sideband the radio listens on, so the CI-V message and the FSK
// bit stream are unchanged. Leaving them out meant a contester who flipped to
// CW-R to dodge a birdie transmitted nothing at all, silently.
bool sendCW(){
  int payloadLen = strnlen(CwMsg, sizeof(CwMsg) - 1);
  char modesSnapshot[sizeof(modes)];
  copyModesText(modesSnapshot, sizeof(modesSnapshot));

  const bool cwMode   = (strcmp(modesSnapshot, "CW")   == 0 || strcmp(modesSnapshot, "CW-R")   == 0);
  const bool rttyMode = (strcmp(modesSnapshot, "RTTY") == 0 || strcmp(modesSnapshot, "RTTY-R") == 0);
  // Phone, the data modes (USB-D, LSB-D), WFM, UNK: nothing to key with.
  if(!cwMode && !rttyMode) return false;

  if(cwMode){  // CAT -----------------
    uint8_t frame[sizeof(CwMsg) + 6];
    uint8_t frameLen = 0;

    frame[frameLen++] = START_BYTE;
    frame[frameLen++] = START_BYTE;
    frame[frameLen++] = radio_address;
    frame[frameLen++] = CONTROLLER_ADDRESS;
    frame[frameLen++] = CMD_SEND_CW_MSG;
    for (int i = 0; i < payloadLen && frameLen < sizeof(frame) - 1; i++) {
      frame[frameLen++] = static_cast<uint8_t>(CwMsg[i]);
    }
    frame[frameLen++] = STOP_BYTE;

    if (Debug) {
      Serial.print("CW ");
      for (uint8_t i = 0; i < frameLen; i++) {
        Serial.print(frame[i], HEX);
        Serial.print(" ");
      }
    }
    catWriteFrame(frame, frameLen, true);
    if (Debug) Serial.println();
    statusFlashKick();
  }else{ // GPIO FSK keying -----------------
    int TheEnd = payloadLen - 1;
    if(TheEnd < 0){
      return false;
    }
    abortFskTransmission = false;
    // Dark for the whole transmission. The restore at the end of this branch had
    // no counterpart -- nothing ever turned the LED off -- so RTTY had no
    // indication at all while the header comment promised one. Per-bit keying
    // was considered and rejected: one bit is 22 ms, so the eye would fuse it
    // into a dimmed LED rather than see it blink.
    if(APmode==true){
      ledcWrite(pwmChannel, 0);
    }else{
      digitalWrite(StatusPin, LOW);
    }
    digitalWrite(PTT, HIGH);          // PTT ON
    delay(PTTlead);                   // PTT lead delay
    // ch = ' '; Serial.print(ch); chTable(); sendFsk();   // Space before sending
    // while (Serial.available()) {
    if (Debug) Serial.print("FSK ");
    bool fskAborted = false;
    for (int i = 0; i < TheEnd+1; i++) {
        if (abortFskTransmission) { fskAborted = true; break; }
        ch = toUpperCase(static_cast<char>(CwMsg[i]));
        if (Debug) { Serial.print(String(ch)); Serial.print("|"); }
        chTable();
        if(fig1 == 0 && fig2 == 1){
                d1 = 1; d2 = 1; d3 = 0; d4 = 1; d5 = 1; //FIGURES
                sendFsk();
        }else if(fig1 == 1 && fig2 == 0){
                d1 = 1; d2 = 1; d3 = 1; d4 = 1; d5 = 1; //LETTERS
                sendFsk();
        }else if(space == 1 && fig2 == 1){
                d1 = 1; d2 = 1; d3 = 0; d4 = 1; d5 = 1; //FIGURES
                sendFsk();
        }
        if(fig2 == 0 || fig2 == 1){
                space = 0;
                fig1 = fig2;
        }
        chTable();
        sendFsk();
        delay(5);
    }
    if (Debug) Serial.println();
    abortFskTransmission = false;
    // ch = ' '; Serial.print(ch); chTable(); sendFsk();   // Space after sending
    if (!fskAborted) delay(PTTtail);
    digitalWrite(PTT, LOW);
    if (Debug) Serial.println();
    digitalWrite(FSK_OUT, LOW);
    statusLedSteady();
    powerTimer=millis();
  }

//   uint8_t req[] = {START_BYTE, START_BYTE, radio_address, CONTROLLER_ADDRESS, CMD_SEND_CW_MSG, requestCode, STOP_BYTE};
// #ifdef DEBUG
//   Serial.print(">");
// #endif
//   for (uint8_t i = 0; i < sizeof(req); i++) {
//     CAT.write(req[i]);
//     #ifdef DEBUG
//       if (req[i] < 16)Serial.print("0");
//       Serial.print(req[i], HEX);
//       Serial.print(" ");
//     #endif
//     }
// #ifdef DEBUG
//   Serial.println();
// #endif
  return true;
}

//-------------------------------------------------------------------------------------------------------
void sendFsk(){
  #if defined(FSK_KEYING)
        #if defined(serialECHO )
              Serial.print(d1);Serial.print(d2);Serial.print(d3);Serial.print(d4);Serial.print(d5);Serial.print(' '); // 5bit code serial echo
        //      Serial.print(OneBit);Serial.print('|');Serial.print(OneBit*StopBit);Serial.print(' ');                  // ms
        #endif
        //--start bit
        digitalWrite(FSK_OUT, FSK_SPACE_LEVEL); delay(OneBit);
        //--bit1
        if(d1 == 1){digitalWrite(FSK_OUT, FSK_MARK_LEVEL); }
        else       {digitalWrite(FSK_OUT, FSK_SPACE_LEVEL); } delay(OneBit);
        //--bit2
        if(d2 == 1){digitalWrite(FSK_OUT, FSK_MARK_LEVEL); }
        else       {digitalWrite(FSK_OUT, FSK_SPACE_LEVEL); } delay(OneBit);
        //--bit3
        if(d3 == 1){digitalWrite(FSK_OUT, FSK_MARK_LEVEL); }
        else       {digitalWrite(FSK_OUT, FSK_SPACE_LEVEL); } delay(OneBit);
        //--bit4
        if(d4 == 1){digitalWrite(FSK_OUT, FSK_MARK_LEVEL); }
        else       {digitalWrite(FSK_OUT, FSK_SPACE_LEVEL); } delay(OneBit);
        //--bit5
        if(d5 == 1){digitalWrite(FSK_OUT, FSK_MARK_LEVEL); }
        else       {digitalWrite(FSK_OUT, FSK_SPACE_LEVEL); } delay(OneBit);
        //--stop bit
        digitalWrite(FSK_OUT, FSK_MARK_LEVEL); delay(OneBit*StopBit);
  #endif
}

void chTable(){
  #if defined(FSK_KEYING)

        fig2 = -1;
        if(ch == ' ')
        {
                d1 = 0; d2 = 0; d3 = 1; d4 = 0; d5 = 0;
                space = 1;
        }
        else if(ch == 'A'){d1 = 1; d2 = 1; d3 = 0; d4 = 0; d5 = 0; fig2 = 0;}
        else if(ch == 'B'){d1 = 1; d2 = 0; d3 = 0; d4 = 1; d5 = 1; fig2 = 0;}
        else if(ch == 'C'){d1 = 0; d2 = 1; d3 = 1; d4 = 1; d5 = 0; fig2 = 0;}
        else if(ch == 'D'){d1 = 1; d2 = 0; d3 = 0; d4 = 1; d5 = 0; fig2 = 0;}
        else if(ch == 'E'){d1 = 1; d2 = 0; d3 = 0; d4 = 0; d5 = 0; fig2 = 0;}
        else if(ch == 'F'){d1 = 1; d2 = 0; d3 = 1; d4 = 1; d5 = 0; fig2 = 0;}
        else if(ch == 'G'){d1 = 0; d2 = 1; d3 = 0; d4 = 1; d5 = 1; fig2 = 0;}
        else if(ch == 'H'){d1 = 0; d2 = 0; d3 = 1; d4 = 0; d5 = 1; fig2 = 0;}
        else if(ch == 'I'){d1 = 0; d2 = 1; d3 = 1; d4 = 0; d5 = 0; fig2 = 0;}
        else if(ch == 'J'){d1 = 1; d2 = 1; d3 = 0; d4 = 1; d5 = 0; fig2 = 0;}
        else if(ch == 'K'){d1 = 1; d2 = 1; d3 = 1; d4 = 1; d5 = 0; fig2 = 0;}
        else if(ch == 'L'){d1 = 0; d2 = 1; d3 = 0; d4 = 0; d5 = 1; fig2 = 0;}
        else if(ch == 'M'){d1 = 0; d2 = 0; d3 = 1; d4 = 1; d5 = 1; fig2 = 0;}
        else if(ch == 'N'){d1 = 0; d2 = 0; d3 = 1; d4 = 1; d5 = 0; fig2 = 0;}
        else if(ch == 'O'){d1 = 0; d2 = 0; d3 = 0; d4 = 1; d5 = 1; fig2 = 0;}
        else if(ch == 'P'){d1 = 0; d2 = 1; d3 = 1; d4 = 0; d5 = 1; fig2 = 0;}
        else if(ch == 'Q'){d1 = 1; d2 = 1; d3 = 1; d4 = 0; d5 = 1; fig2 = 0;}
        else if(ch == 'R'){d1 = 0; d2 = 1; d3 = 0; d4 = 1; d5 = 0; fig2 = 0;}
        else if(ch == 'S'){d1 = 1; d2 = 0; d3 = 1; d4 = 0; d5 = 0; fig2 = 0;}
        else if(ch == 'T'){d1 = 0; d2 = 0; d3 = 0; d4 = 0; d5 = 1; fig2 = 0;}
        else if(ch == 'U'){d1 = 1; d2 = 1; d3 = 1; d4 = 0; d5 = 0; fig2 = 0;}
        else if(ch == 'V'){d1 = 0; d2 = 1; d3 = 1; d4 = 1; d5 = 1; fig2 = 0;}
        else if(ch == 'W'){d1 = 1; d2 = 1; d3 = 0; d4 = 0; d5 = 1; fig2 = 0;}
        else if(ch == 'X'){d1 = 1; d2 = 0; d3 = 1; d4 = 1; d5 = 1; fig2 = 0;}
        else if(ch == 'Y'){d1 = 1; d2 = 0; d3 = 1; d4 = 0; d5 = 1; fig2 = 0;}
        else if(ch == 'Z'){d1 = 1; d2 = 0; d3 = 0; d4 = 0; d5 = 1; fig2 = 0;}
        else if(ch == '0'){d1 = 0; d2 = 1; d3 = 1; d4 = 0; d5 = 1; fig2 = 1;}
        else if(ch == '1'){d1 = 1; d2 = 1; d3 = 1; d4 = 0; d5 = 1; fig2 = 1;}
        else if(ch == '2'){d1 = 1; d2 = 1; d3 = 0; d4 = 0; d5 = 1; fig2 = 1;}
        else if(ch == '3'){d1 = 1; d2 = 0; d3 = 0; d4 = 0; d5 = 0; fig2 = 1;}
        else if(ch == '4'){d1 = 0; d2 = 1; d3 = 0; d4 = 1; d5 = 0; fig2 = 1;}
        else if(ch == '5'){d1 = 0; d2 = 0; d3 = 0; d4 = 0; d5 = 1; fig2 = 1;}
        else if(ch == '6'){d1 = 1; d2 = 0; d3 = 1; d4 = 0; d5 = 1; fig2 = 1;}
        else if(ch == '7'){d1 = 1; d2 = 1; d3 = 1; d4 = 0; d5 = 0; fig2 = 1;}
        else if(ch == '8'){d1 = 0; d2 = 1; d3 = 1; d4 = 0; d5 = 0; fig2 = 1;}
        else if(ch == '9'){d1 = 0; d2 = 0; d3 = 0; d4 = 1; d5 = 1; fig2 = 1;}
        else if(ch == '-'){d1 = 1; d2 = 1; d3 = 0; d4 = 0; d5 = 0; fig2 = 1;}
        else if(ch == '?'){d1 = 1; d2 = 0; d3 = 0; d4 = 1; d5 = 1; fig2 = 1;}
        else if(ch == ':'){d1 = 0; d2 = 1; d3 = 1; d4 = 1; d5 = 0; fig2 = 1;}
        else if(ch == '('){d1 = 1; d2 = 1; d3 = 1; d4 = 1; d5 = 0; fig2 = 1;}
        else if(ch == ')'){d1 = 0; d2 = 1; d3 = 0; d4 = 0; d5 = 1; fig2 = 1;}
        else if(ch == '.'){d1 = 0; d2 = 0; d3 = 1; d4 = 1; d5 = 1; fig2 = 1;}
        else if(ch == ','){d1 = 0; d2 = 0; d3 = 1; d4 = 1; d5 = 0; fig2 = 1;}
        else if(ch == '/'){d1 = 1; d2 = 0; d3 = 1; d4 = 1; d5 = 1; fig2 = 1;}
        else if(ch == '+'){d1 = 1; d2 = 0; d3 = 0; d4 = 0; d5 = 1; fig2 = 1;} //ITA2
        else if(ch == '\n'){d1 = 0; d2 = 1; d3 = 0; d4 = 0; d5 = 0;} //LF
        else if(ch == '\r'){d1 = 0; d2 = 0; d3 = 0; d4 = 1; d5 = 0;} //CR
        else
        {
                ch = ' ';
                d1 = 0; d2 = 0; d3 = 1; d4 = 0; d5 = 0;
                space = 1;
        }
  #endif
}

//-------------------------------------------------------------------------------------------------------
// Handle a single CLI command byte (driven by serialPump). 0xFE/0xFD framing bytes
// never reach here — they are consumed by the CI-V parser first.
void cliHandleByte(uint8_t b){
  {
    incomingByte = b;
    // ?
    if(incomingByte==63){
      ListCommands();

    // D
    }else if(incomingByte==68 || incomingByte==100){
      if(Debug==false){
        Debug=true;
        Serial.println("   Debug ENABLED");
      }else{
        Debug=false;
        Serial.println("   Debug DISABLED");
      }

    // A
    }else if(incomingByte==65 || incomingByte==97){
      Serial.println("   Switch to AP mode and restart? (y/n)");
      EnterChar();
      if(incomingByte==89 || incomingByte==121){
        EEPROM.writeBool(0, true);
        EEPROM.commit();
        Serial.println("** Interface will be restarted to AP mode **");
        delay(3000);
        ESP.restart();
      }else{
        Serial.println("   AP mode switch aborted");
      }
 
    // E
    }else if(incomingByte==69 || incomingByte==101){
      Serial.println("   Erase whole eeprom? (y/n)");
      EnterChar();
      if(incomingByte==89 || incomingByte==121){
        // Deliberately NOT another y/n: a held-down y must not be able to wipe
        // the device. The old second question achieved that by inverting itself
        // ("Stop erase?" -- n proceeds), which protected the operator without
        // telling them, so two identical-looking prompts meant opposites.
        Serial.println("   This deletes all settings. Press E again to erase, any other key aborts.");
        EnterChar();
        if(incomingByte==69 || incomingByte==101){
          for(int i=0; i<EEPROM_SIZE; i++){
            EEPROM.write(i, 0xff);
            Serial.print(".");
          }
          EEPROM.commit();
          Serial.println("");
          Serial.println("   Eeprom erased done");
          Serial.println("** Interface will be restarted **");
          delay(3000);
          ESP.restart();
        }else{
          Serial.println("   Erase aborted");
        }
      }else{
        Serial.println("   Erase aborted");
      }

    // B
    }else if(incomingByte==66 || incomingByte==98){
      #if defined(BLUETOOTH)
        Serial.println("   Clear all BT bonding data? (y/n)");
        EnterChar();
        if(incomingByte==89 || incomingByte==121){
          int numBonded = esp_bt_gap_get_bond_device_num();
          if(numBonded == 0){
            Serial.println("   No bonded devices found");
          } else {
            esp_bd_addr_t *bondedDevices = new esp_bd_addr_t[numBonded];
            esp_bt_gap_get_bond_device_list(&numBonded, bondedDevices);
            for(int i=0; i<numBonded; i++){
              esp_bt_gap_remove_bond_device(bondedDevices[i]);
              Serial.print("   Removed bond #");
              Serial.println(i+1);
            }
            delete[] bondedDevices;
            Serial.println("   BT bonding cleared - restart device and re-pair");
          }
        }else{
          Serial.println("   Aborted");
        }
      #else
        Serial.println("   BT not enabled");
      #endif

    // @
    }else if(incomingByte==64){
      Serial.println("   Restart Interface? (y/n)");
      EnterChar();
      if(incomingByte==89 || incomingByte==121){
        Serial.println("   Press @ again to restart, any other key aborts.");
        EnterChar();
        if(incomingByte==64){
          Serial.println("** Interface will be restarted **");
          delay(3000);
          ESP.restart();
        }else{
          Serial.println("   Restart aborted");
        }
      }else{
        Serial.println("   Restart aborted");
      }

    // L — LAN CI-V test (step 3): read "IP user pass", probe the radio over UDP
    }else if(incomingByte==76 || incomingByte==108){
      runLanCivTest();

    // CR/LF
    }else if(incomingByte==13||incomingByte==10){
      // anykey
    }else{
      // Serial.print(" [");
      // Serial.print( String(incomingByte) ); //, DEC);
      // Serial.println("] unknown command");
    }
    incomingByte=0;
  }
}

//-------------------------------------------------------------------------------------------------------
// Single RX pump for UART0: route each byte to the CI-V framer (FE FE..FD) or, if it
// is not part of a CI-V frame, to the CLI command handler.
void serialPump(){
  while (Serial.available() > 0) {
    uint8_t b = (uint8_t)Serial.read();
    if (civParserFeed(b)) continue;
    cliHandleByte(b);
  }
}

//-------------------------------------------------------------------------------------------------------
void EnterChar(){
  incomingByte = 0;
  Serial.print(" > ");
  unsigned long enterTimeout = millis();
  while (Serial.available() == 0) {
    #if defined(WDT)
      esp_task_wdt_reset();
    #endif
    if (millis() - enterTimeout > 30000) {
      Serial.println("(timeout)");
      return;
    }
    delay(10);
  }
  incomingByte = Serial.read();
  Serial.println( String(char(incomingByte)) );
}

//-------------------------------------------------------------------------------------------------------
// Blocking line reader for CLI prompts. Returns trimmed line, "" on timeout.
String EnterLine(const char* prompt){
  Serial.print(prompt);
  String s = "";
  unsigned long t0 = millis();
  while (millis() - t0 < 30000) {
    #if defined(WDT)
      esp_task_wdt_reset();
    #endif
    while (Serial.available()) {
      char c = Serial.read();
      if (c == '\r' || c == '\n') { s.trim(); if (s.length()) { Serial.println(s); return s; } }
      else { s += c; t0 = millis(); }
    }
    delay(5);
  }
  Serial.println("(timeout)");
  return "";
}

//-------------------------------------------------------------------------------------------------------
// LAN transport config menu (CLI 'L'). Enter "IP user pass" (or empty to keep
// stored values), then choose: (t)est once, (s)ave+reboot into LAN mode, or
// (b)ack. The unified radio config remains authoritative; legacy mirrors are
// updated for downgrade compatibility.
void runLanCivTest(){
  Serial.println("");
  Serial.print("-- TRX1 LAN transport -- current connection: ");
  Serial.println(radioTransportName(radioSlots[0].transport));
  if (lanRadioIp.length()) {
    Serial.println("   stored: " + lanRadioIp + " user=" + lanUser +
                   " pass=" + String(lanPass.length() ? "(set)" : "(none)"));
  }
  Serial.println("   enter <radioIP> <user> <pass>  (empty = keep stored)");
  String line = EnterLine(" LAN> ");

  String ipStr = lanRadioIp, user = lanUser, pass = lanPass;
  if (line.length() > 0) {
    int sp1 = line.indexOf(' ');
    int sp2 = line.indexOf(' ', sp1 + 1);
    if (sp1 < 0 || sp2 < 0) { Serial.println("LAN | need: IP user pass"); return; }
    ipStr = line.substring(0, sp1);
    user  = line.substring(sp1 + 1, sp2);
    pass  = line.substring(sp2 + 1);
  }
  IPAddress rip;
  if (!rip.fromString(ipStr)) { Serial.println("LAN | bad/empty IP"); return; }

  Serial.println("   action: (t)est now  (s)ave + reboot to LAN  (b)ack");
  EnterChar();
  char act = (char)incomingByte;

  if (act == 't' || act == 'T') {
    if (radioSlots[0].transport == RADIO_LAN) {
      Serial.println("LAN | TRX1 client is already active; watch the connection log");
      return;
    }
    Serial.println("LAN | testing without changing the stored connection...");
    lanClient.begin(rip, 50001, user.c_str(), pass.c_str(),
                    radioSlots[0].civAddr, 0, radioLanLocalControlPort(0), true);
    unsigned long t0 = millis();
    while (millis() - t0 < 20000) {
      lanClient.loop();
      #if defined(WDT)
        esp_task_wdt_reset();
      #endif
      if (lanClient.connected() && millis() - t0 > 2000) break;
      if (lanClient.failed()) break;
      delay(5);
    }
    if (lanClient.connected()) {
      char m[sizeof(modes)]; copyModesText(m, sizeof(m));
      Serial.println("LAN | RESULT: SUCCESS, freq " + String((unsigned long)frequency) +
                     " Hz mode " + String(m));
    } else {
      Serial.println("LAN | RESULT: FAILED (state " + String((int)lanClient.status()) + ")");
    }
    lanClient.stop();

  } else if (act == 's' || act == 'S') {
    if (user.length() == 0 || pass.length() == 0) {
      Serial.println("LAN | refusing to save: user/pass empty (type: IP user pass)");
      return;
    }
    radioSlots[0].enabled = true;
    radioSlots[0].transport = RADIO_LAN;
    radioSlots[0].lanIp = ipStr;
    radioSlots[0].lanUser = user;
    radioSlots[0].lanPass = pass;
    syncLegacyRadioGlobals();
    if (!saveRadioConfig()) {
      Serial.println("LAN | unified radio config save failed; reboot cancelled");
      return;
    }
    if (!savePrimaryRadioConfig()) {
      Serial.println("LAN | legacy EEPROM mirror save failed; reboot cancelled");
      return;
    }
    if (!saveMemoryConfig()) {
      Serial.println("LAN | warning: legacy memories.cfg copy was not updated");
    }
    Serial.println("LAN | saved (user='" + lanUser + "' passlen=" + String(lanPass.length()) +
                   "). Rebooting with TRX1 connected over LAN...");
    delay(1500);
    ESP.restart();

  } else if (act == 'b' || act == 'B') {
    Serial.println("LAN | unchanged");

  } else {
    Serial.println("LAN | aborted");
  }
}

//-------------------------------------------------------------------------------------------------------
void ListCommands(){
  Serial.println("");
  // Two lines, not one: the full name on the same row as the rule would run to 101 characters
  // and wrap in the middle of itself on an 80-column console.
  Serial.println("-------- DivaDroid International | WIFILT status --------");
  Serial.println("  WIFILT - Web interface for Icom LAN Transceivers");
  Serial.print("  Uptime: ");
  if(millis() < 60000){
    Serial.print( String(millis()/1000) );
    Serial.println(" second");
  }else if(millis() > 60000 && millis() < 3600000){
    Serial.print( String(millis()/60000) );
    Serial.println(" minutes");
  }else if(millis() > 3600000 && millis() < 86400000){
    Serial.print( String(millis()/3600000) );
    Serial.println(" hours");
  }else{
    Serial.print( String(millis()/86400000) );
    Serial.println(" days");
  }
  Serial.println("  FW "+String(REV)+" | HW "+String(HardwareRev)+" ["+String(HWidValue)+" raw]" );
  if(APmode==true){
    Serial.println("  WIFI-AP mode ON" );
    APcliAlert();
  }else{
    Serial.println("  TRX1 connection: " + String(radioTransportName(radioSlots[0].transport)));
    Serial.println("  WIFI-AP mode OFF" );
    Serial.println("  WIFI-SSID1 "+SSID );
    if (SSID2.length() > 0) {
      Serial.println("  WIFI-SSID2 "+SSID2 );
    } else {
      Serial.println("  WIFI-SSID2 DISABLE" );
    }
    Serial.print("  WIFI-status ");
    Serial.print((int)WiFi.status());
    Serial.print(" | IP ");
    Serial.println(WiFi.localIP());
    Serial.println("  WIFI-MAC "+String(MACString) );
    Serial.println("  WIFI-dBm: "+String(WiFi.RSSI()) );
    Serial.println("----------------------------------------------------------------------------" );
    Serial.println("  For setup OPEN url http://"+String(deviceHostname)+".local or http://"+String(WiFi.localIP()[0])+"."+String(WiFi.localIP()[1])+"."+String(WiFi.localIP()[2])+"."+String(WiFi.localIP()[3]) );
    Serial.println("----------------------------------------------------------------------------" );
    if(TRXNET_ID != 0x00){
      Serial.println("  TrxNet device: "+String(trxDeviceName)+" port:"+String(TRXNET_PORT));
      if(TRX2_NET_ID != 0x00) Serial.println("  TrxNet TRX2 peer: OI3."+String(TRX2_NET_ID, HEX));
      if(TRX3_NET_ID != 0x00) Serial.println("  TrxNet TRX3 peer: OI3."+String(TRX3_NET_ID, HEX));
    }else{
      Serial.println("  TrxNet DISABLE (NET_ID=0x00)" );
    }
    #if defined(RESET_AFTER_DISCONNECT)
      Serial.println("     RESET after TRX disconnect - ENABLE" );
    #endif

    char modesSnapshot[sizeof(modes)];
    copyModesText(modesSnapshot, sizeof(modesSnapshot));
    Serial.println(" CAT "+String(frequency)+"Hz "+String(modesSnapshot) );
  }
  Serial.println("Commands  press key to select");
  Serial.println("       ?  list refresh");
  Serial.println("       A  restart to AP mode");
  #if defined(BLUETOOTH)
  Serial.println("       B  clear BT bonding data (use if re-pairing fails)");
  #endif
  if(Debug==false){
    Serial.println("       D  enable serial debug");
  }else{
    Serial.println("       D  disable serial debug");
  }
  Serial.println("       E  erase whole eeprom and restart");
  Serial.println("       L  configure and test ICOM-LAN (IP, username, password)");
  Serial.println("       @  restart device");
  Serial.print( " > " );
}

//-------------------------------------------------------------------------------------------------------
void APcliAlert(){
  IPAddress IP = WiFi.softAPIP();
  Serial.println();
  Serial.println("---------------------------------------------------------------");
  Serial.println("  PLEASE connect your PC to '"+String(ssidAP)+"' WiFi access-point");
  Serial.println("  with password 'remoteqth'");
  Serial.println("  and OPEN url http://"+String(deviceHostname)+".local or http://"+String(IP[0])+"."+String(IP[1])+"."+String(IP[2])+"."+String(IP[3]) );
  Serial.println("  AP mode can be entered again only from the serial console");
  Serial.println("---------------------------------------------------------------");
  Serial.println();
}

//-------------------------------------------------------------------------------------------------------

// setup form handler
void handleSet() {
  resetSetupMessages();
  bool ERRdetect=0;

  // Whether this submission is a setup form at all. On the box that question is
  // answered by the WiFi fields, which every save carries. On a build with no
  // WiFi they carry nothing meaningful -- and this commit hides them -- so
  // asking about them there would make the whole save depend on the browser
  // still posting two inputs it has been told to ignore. Delete or disable them
  // in setup.html and every other setting (radio, TrxNet, baud, DXC, identity,
  // memories) would silently stop being stored, with setupSaveOk left false and
  // no error string to explain it: /setup/save would answer {"ok":false,
  // "error":""}. De Morgan of the original test, so the ESP32 path is unchanged.
  #if CAP_WIFI
    const bool submissionHasForm = requestHasArg("ssid") || requestHasArg("pswd");
  #else
    const bool submissionHasForm = true;
  #endif

  if ( submissionHasForm == false ) {
    // Serial.println("Form NOT valid");
  }else{
    // Serial.println("Form VALID");

    // Validated and stored only where there is a radio to join a network with.
    // Empty fields would otherwise fail the length check below and refuse the
    // whole save. Guarded rather than made conditional at runtime so the ESP32
    // build is preprocessed to exactly the code it had before.
    #if CAP_WIFI

    // 1-20 - SSID1*
    if ( requestArg("ssid").length()<1 || requestArg("ssid").length()>20){
      setupSsidErr = "Out of range 1-20 characters";
      ERRdetect=1;
    }else{
      String str = requestArg("ssid");
      if(SSID == str){
        setupSsidErr = "";
      }else{
        setupSsidErr = "Warning: SSID has changed.";
        SSID = requestArg("ssid");

        int str_len = str.length();
        if(str_len > 20){
          str_len = 20;
        }
        char char_array[str_len + 1];
        str.toCharArray(char_array, str_len+1);
        for (int i=0; i<20; i++){
          if(i < str_len){
            EEPROM.write(1+i, char_array[i]);
          }else{
            EEPROM.write(1+i, 0xff);
          }
        }
        // EEPROM.commit();
      }
    }

    // 22-39 - PSWD1*
    if ( requestArg("pswd").length()<1 || requestArg("pswd").length()>18){
      setupPswdErr = "Out of range 1-18 characters";
      ERRdetect=1;
    }else{
      String str = requestArg("pswd");
      if(PSWD == str){
        setupPswdErr = "";
      }else{
        setupPswdErr = "Warning: Password has changed.";
        PSWD = requestArg("pswd");

        int str_len = str.length();
        if(str_len > 18){
          str_len = 18;
        }
        char char_array[str_len + 1];
        str.toCharArray(char_array, str_len+1);
        for (int i=0; i<18; i++){
          if(i < str_len){
            EEPROM.write(22+i, char_array[i]);
          }else{
            EEPROM.write(22+i, 0xff);
          }
        }
        // EEPROM.commit();
      }
    }

    // 76-95 - SSID2
    if ( requestArg("ssid2").length()>20){
      setupSsid2Err = "Out of range 0-20 characters";
      ERRdetect=1;
    }else{
      String str = requestArg("ssid2");
      if(SSID2 == str){
        setupSsid2Err = "";
      }else{
        setupSsid2Err = "Warning: SSID 2 has changed.";
        SSID2 = str;

        int str_len = str.length();
        if(str_len > 20){
          str_len = 20;
        }
        char char_array[str_len + 1];
        str.toCharArray(char_array, str_len+1);
        for (int i=0; i<20; i++){
          if(i < str_len){
            EEPROM.write(76+i, char_array[i]);
          }else{
            EEPROM.write(76+i, 0xff);
          }
        }
      }
    }

    // 97-114 - PSWD2
    if ( requestArg("pswd2").length()>18){
      setupPswd2Err = "Out of range 0-18 characters";
      ERRdetect=1;
    }else{
      String str = requestArg("pswd2");
      if(PSWD2 == str){
        setupPswd2Err = "";
      }else{
        setupPswd2Err = "Warning: Password 2 has changed.";
        PSWD2 = str;

        int str_len = str.length();
        if(str_len > 18){
          str_len = 18;
        }
        char char_array[str_len + 1];
        str.toCharArray(char_array, str_len+1);
        for (int i=0; i<18; i++){
          if(i < str_len){
            EEPROM.write(97+i, char_array[i]);
          }else{
            EEPROM.write(97+i, 0xff);
          }
        }
      }
    }

    if ((SSID2.length() == 0 && PSWD2.length() > 0) || (SSID2.length() > 0 && PSWD2.length() == 0)) {
      setupSsid2Err = "SSID2 and Password2 must be both filled or both empty";
      setupPswd2Err = "";
      ERRdetect = 1;
    }

    #endif  // CAP_WIFI -- everything below is stored on every build


    // 41 TRXNET_ID (hex string "01".."ff"; 0x00 = disabled)
    { long id = strtol(requestArg("trxnetid").c_str(), nullptr, 16);
      if (id < 0 || id > 255) id = 0x01;
      if (TRXNET_ID != (byte)id) { TRXNET_ID = (byte)id; EEPROM.writeByte(41, (byte)id); } }

    // Per-TRX enable: when the box is unchecked the checkbox is absent, so we
    // zero NET_ID and CI-V address -> the slot is disabled.
    bool trx2en = requestHasArg("trx2enable");
    bool trx3en = requestHasArg("trx3enable");

    // 42 TRX2_NET_ID (hex string; 0x00 = disabled)
    { long id = trx2en ? strtol(requestArg("trx2netid").c_str(), nullptr, 16) : 0;
      if (id < 0 || id > 255) id = 0x00;
      if (TRX2_NET_ID != (byte)id) { TRX2_NET_ID = (byte)id; EEPROM.writeByte(42, (byte)id); } }

    // 43 TRX3_NET_ID (hex string; 0x00 = disabled)
    { long id = trx3en ? strtol(requestArg("trx3netid").c_str(), nullptr, 16) : 0;
      if (id < 0 || id > 255) id = 0x00;
      if (TRX3_NET_ID != (byte)id) { TRX3_NET_ID = (byte)id; EEPROM.writeByte(43, (byte)id); } }

    // 44 TRX2_CONN_TYPE (0=TrxNet, 1=CI-V)
    { int ct = requestArg("trx2conntype").toInt(); if (ct < 0 || ct > 1) ct = 0;
      if (TRX2_CONN_TYPE != (byte)ct) { TRX2_CONN_TYPE = (byte)ct; EEPROM.writeByte(44, (byte)ct); } }
    // 45-46 TRXNET_PORT
    { int p = requestArg("trxnetport").toInt(); if (p >= 1 && p <= 65534 && TRXNET_PORT != (uint16_t)p) { TRXNET_PORT = (uint16_t)p; EEPROM.writeUShort(45, p); } }
    // 47 TRX3_CONN_TYPE (0=TrxNet, 1=CI-V)
    { int ct = requestArg("trx3conntype").toInt(); if (ct < 0 || ct > 1) ct = 0;
      if (TRX3_CONN_TYPE != (byte)ct) { TRX3_CONN_TYPE = (byte)ct; EEPROM.writeByte(47, (byte)ct); } }
    // 48 TRX2_CIV_ADDR (hex string; 0x00 = unset)
    { uint8_t a = TRX2_CIV_ADDR;
      String s = trx2en ? requestArg("trx2civaddr") : String("");
      if (s.length() == 0) { if (TRX2_CIV_ADDR != 0x00) { TRX2_CIV_ADDR = 0x00; EEPROM.writeByte(48, 0x00); } }
      else if (parseHexByteString(s, a)) { if (TRX2_CIV_ADDR != a) { TRX2_CIV_ADDR = a; EEPROM.writeByte(48, a); } } }
    // 49 TRX3_CIV_ADDR (hex string; 0x00 = unset)
    { uint8_t a = TRX3_CIV_ADDR;
      String s = trx3en ? requestArg("trx3civaddr") : String("");
      if (s.length() == 0) { if (TRX3_CIV_ADDR != 0x00) { TRX3_CIV_ADDR = 0x00; EEPROM.writeByte(49, 0x00); } }
      else if (parseHexByteString(s, a)) { if (TRX3_CIV_ADDR != a) { TRX3_CIV_ADDR = a; EEPROM.writeByte(49, a); } } }
    // 48-67 FREE (was MQTT_TOPIC)
    // 115-135 FREE (was MQTT_TOPIC_RX)
    // 225-245 FREE (was TRX2_MQTT_ROOT)
    // 246-266 FREE (was TRX3_MQTT_ROOT)

    // 267-287 BT_NAME (21B)
    {
      String str = requestArg("btname");
      if (str.length() > 20) {
        ERRdetect=1;
      } else if (str.length() >= 1 && BT_NAME != str) {
        BT_NAME = str;
        eepromWriteStr(BT_NAME, 267, 21);
      }
    }

    // 74-75 BaudRate *
    static int BaudRateTmp=115200;
    switch (requestArg("baud").toInt()) {
      case 0: {BaudRateTmp= 1200; break; }
      case 1: {BaudRateTmp= 2400; break; }
      case 2: {BaudRateTmp= 4800; break; }
      case 3: {BaudRateTmp= 9600; break; }
      case 4: {BaudRateTmp= 115200; break; }
    }
    if(BaudRateTmp!=BaudRate){
      BaudRate=(int)BaudRateTmp;
      EEPROM.writeUShort(74, BaudRate);
      // MqttPubString("USB-BaudRate", String(BaudRate), true);
      Serial.println("Baudrate change to "+String(BaudRate)+"...");
      Serial.flush();
      // Serial.end();
      delay(1000);
      Serial.begin(BaudRate);
      delay(500);
      Serial.println();
      Serial.println();
      Serial.println("New Baudrate "+String(BaudRate));
    }

    // Unified per-radio model. All three slots expose the same transport menu;
    // only the selected transport's fields are required.
    RadioSlotConfig nextSlots[3] = {radioSlots[0], radioSlots[1], radioSlots[2]};
    for (uint8_t slot = 0; slot < 3; slot++) {
      String prefix = "trx" + String(slot + 1);
      nextSlots[slot].enabled = slot == 0 || requestHasArg((prefix + "enable").c_str());
      String transport = trimMemoryValue(requestArg((prefix + "transport").c_str()), 12);
      nextSlots[slot].transport =
        radioTransportFromName(transport.c_str(), nextSlots[slot].transport);

      uint8_t parsed;
      if (nextSlots[slot].transport == RADIO_LAN
          || nextSlots[slot].transport == RADIO_CIV) {
        String civ = requestArg((prefix + "civaddr").c_str());
        if (civ.length() && parseHexByteString(civ, parsed)) nextSlots[slot].civAddr = parsed;
      }
      if (nextSlots[slot].transport == RADIO_TRXNET) {
        String netid = requestArg((prefix + "netid").c_str());
        if (netid.length() && parseHexByteString(netid, parsed)) nextSlots[slot].netId = parsed;
      }
      if (nextSlots[slot].transport == RADIO_LAN) {
        nextSlots[slot].lanIp =
          trimMemoryValue(requestArg((prefix + "lanip").c_str()), 15);
        nextSlots[slot].lanUser =
          trimMemoryValue(requestArg((prefix + "lanuser").c_str()), 16);
        String password = trimMemoryValue(requestArg((prefix + "lanpass").c_str()), 16);
        if (password.length()) nextSlots[slot].lanPass = password; // blank keeps stored secret
      }

      if (!nextSlots[slot].enabled) continue;
      // A slot with NOTHING in it is not a mistake, it is a slot nobody has got
      // to yet -- which is the state every device leaves the factory in, and
      // the state AP mode cannot leave, because the radio cannot be on a
      // network this interface has not joined. TRX1 is always enabled and
      // defaults to ICOM-LAN, so refusing the whole form for it took the WiFi
      // and the callsign down with it: the one button that gets an operator out
      // of AP mode answered 400 every time. radioSlotSetUp() already calls
      // exactly these states "not set up", and the setup page says so in step 3.
      //
      // PARTLY filled is still refused. That produces a slot which will never
      // connect and never explains why, and it can only come from a mistake.
      if (nextSlots[slot].transport == RADIO_LAN) {
        bool blank = (nextSlots[slot].lanIp.length() == 0 || nextSlots[slot].lanIp == "0.0.0.0")
                  && nextSlots[slot].lanUser.length() == 0
                  && nextSlots[slot].lanPass.length() == 0;
        IPAddress parsedIp;
        if (!blank && (!parsedIp.fromString(nextSlots[slot].lanIp)
                       || nextSlots[slot].lanUser.length() == 0
                       || nextSlots[slot].lanPass.length() == 0)) {
          setupCivAddrErr = "TRX" + String(slot + 1) + " LAN needs IP, username and password";
          ERRdetect = 1;
        }
      } else if (nextSlots[slot].transport == RADIO_TRXNET) {
        if (nextSlots[slot].netId != 0x00
            && (TRXNET_ID == 0x00 || nextSlots[slot].netId == TRXNET_ID)) {
          setupCivAddrErr = "TRX" + String(slot + 1) + " needs a peer NET_ID different from Own NET_ID";
          ERRdetect = 1;
        }
      }
    }

    // One incoming peer or CI-V address must resolve to exactly one slot.
    for (uint8_t a = 0; a < 3; a++) {
      if (!nextSlots[a].enabled) continue;
      for (uint8_t b = a + 1; b < 3; b++) {
        if (!nextSlots[b].enabled || nextSlots[a].transport != nextSlots[b].transport) continue;
        bool duplicateTrxNet = nextSlots[a].transport == RADIO_TRXNET
                            && nextSlots[a].netId == nextSlots[b].netId;
        bool duplicateCiv = nextSlots[a].transport == RADIO_CIV
                         && nextSlots[a].civAddr == nextSlots[b].civAddr;
        if (duplicateTrxNet || duplicateCiv) {
          setupCivAddrErr = "Each active TRX needs a unique peer/address";
          ERRdetect = 1;
        }
      }
    }
    if (!ERRdetect) {
      for (uint8_t slot = 0; slot < 3; slot++) radioSlots[slot] = nextSlots[slot];
      syncLegacyRadioGlobals();
    }

    cwIpOnConnect = requestHasArg("cwIpOnConnect");
    EEPROM.writeBool(136, cwIpOnConnect);

    {
      String dxchost = requestArg("dxchost");
      if(dxchost.length() <= 64){ DxcHost = dxchost; eepromWriteStr(DxcHost, 137, 64); }
      String dxcportStr = requestArg("dxcport");
      if(dxcportStr.length() > 0){ int p = dxcportStr.toInt(); if(p >= 1 && p <= 65534){ DxcPort = p; EEPROM.writeUShort(201, p); } }
      String dxccall = requestArg("dxccall");
      if(dxccall.length() <= 16){ DxcCallsign = dxccall; eepromWriteStr(DxcCallsign, 203, 16); }
      String dxclocator = requestArg("dxclocator");
      if(dxclocator.length() <= 6){ DxcLocator = dxclocator; eepromWriteStr(DxcLocator, 219, 6); }
    }

    // TrxNet priority prefixes — takes effect after the restart that follows this save.
    if (requestHasArg("trxnetprio")) {
      TRXNET_PRIO = trxNormalizePrio(requestArg("trxnetprio"));
      eepromWriteTrxPrio(TRXNET_PRIO);
    }

    {
      String trx1Label = trimMemoryValue(requestArg("trx1label"), 10);
      if (trx1Label.length() == 0) trx1Label = defaultTrxLabel(0);
      String trx2Label = trimMemoryValue(requestArg("trx2label"), 10);
      if (trx2Label.length() == 0) trx2Label = "TRX2";
      String trx3Label = trimMemoryValue(requestArg("trx3label"), 10);
      if (trx3Label.length() == 0) trx3Label = "TRX3";
      String blockedDxcc = requestArg("blockedDxcc");

      g_lcTrx1Label = trx1Label;
      g_lcTrx2Label = trx2Label;
      g_lcTrx3Label = trx3Label;
      g_lcBlockedDxcc = blockedDxcc;

      String nextLogConfig = buildLogConfigJson(
        readLogConfigJson(),
        trx1Label, trx2Label, trx3Label,
        blockedDxcc
      );
      if (!saveLogConfigJson(nextLogConfig)) {
        ERRdetect = 1;
      }
    }

    // Only overwrite memories when they are actually present in the request
    // (CW/freq memory inputs live outside the EEPROM <form> — absent = empty string from requestArg).
    // The in-RAM memory arrays are loaded at boot, so calling saveMemoryConfig()
    // unconditionally below preserves them while persisting transceiverType/civaddr/LAN.
    if (requestHasArg("cwmem1")) {
      for (uint8_t i = 0; i < CW_MEMORY_COUNT; i++) {
        char fieldName[10];
        snprintf(fieldName, sizeof(fieldName), "cwmem%u", i + 1);
        cwMemoryText[i] = trimMemoryValue(requestArg(fieldName), CW_MEMORY_MAX_LEN);
      }
      for (uint8_t i = 0; i < FREQ_MEMORY_COUNT; i++) {
        char fieldName[12];
        snprintf(fieldName, sizeof(fieldName), "freqmem%u", i + 1);
        freqMemoryText[i] = trimMemoryValue(requestArg(fieldName), FREQ_MEMORY_MAX_LEN);
      }
    }
    if(ERRdetect==0){
      // // APmode
      EEPROM.writeBool(0, false);
      if (!saveRadioConfig()) {
        Serial.println("CFG | unified radio config save failed");
        return;
      }
      EEPROM.writeByte(42, TRX2_NET_ID);
      EEPROM.writeByte(43, TRX3_NET_ID);
      EEPROM.writeByte(44, TRX2_CONN_TYPE);
      EEPROM.writeByte(47, TRX3_CONN_TYPE);
      EEPROM.writeByte(48, TRX2_CIV_ADDR);
      EEPROM.writeByte(49, TRX3_CIV_ADDR);
      // TRX1 has its own EEPROM/NVS copy so a full filesystem upload cannot
      // erase the LAN credentials. This commit also persists all other fields
      // written above by this form submission.
      if (!savePrimaryRadioConfig()) {
        return;
      }
      // memories.cfg and EEPROM are backward-compatible mirrors plus CAT-page
      // memories. /radio-config.json remains authoritative for all three slots.
      if (!saveMemoryConfig()) {
        Serial.println("CFG | warning: CAT memories/legacy filesystem copy not saved");
      }
      setupSaveOk = true;
      if (requestHasArg("noRestart")) {
        return;
      }
      Serial.println("Interface will be restarted...");
      delay(3000);
      ESP.restart();
    }
    // Serial.println("ERRdetect = "+String(ERRdetect) );

  } // else form valid
}

// ---- DXC telnet proxy -------------------------------------------------------

String ExtractHttpHeader(const String& request, const String& headerName){
  String needle = "\n" + headerName + ":";
  int start = request.indexOf(needle);
  if(start < 0){
    String lowerRequest = request;
    lowerRequest.toLowerCase();
    String lowerNeedle = needle;
    lowerNeedle.toLowerCase();
    start = lowerRequest.indexOf(lowerNeedle);
    if(start < 0) return "";
  }
  start = request.indexOf(':', start);
  if(start < 0) return "";
  start++;
  int end = request.indexOf('\n', start);
  if(end < 0) end = request.length();
  String value = request.substring(start, end);
  value.trim();
  return value;
}

String Base64Encode(const uint8_t* data, size_t length){
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  String encoded = "";
  encoded.reserve(((length + 2) / 3) * 4);
  for(size_t i = 0; i < length; i += 3){
    uint32_t block = uint32_t(data[i]) << 16;
    bool hasSecond = (i + 1) < length;
    bool hasThird  = (i + 2) < length;
    if(hasSecond) block |= uint32_t(data[i + 1]) << 8;
    if(hasThird)  block |= uint32_t(data[i + 2]);
    encoded += alphabet[(block >> 18) & 0x3F];
    encoded += alphabet[(block >> 12) & 0x3F];
    encoded += hasSecond ? alphabet[(block >> 6) & 0x3F] : '=';
    encoded += hasThird  ? alphabet[block & 0x3F] : '=';
  }
  return encoded;
}

String DxcComputeWebSocketAccept(const String& secKey){
  String source = secKey;
  source += "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  uint8_t digest[20];
  mbedtls_sha1(reinterpret_cast<const unsigned char*>(source.c_str()), source.length(), digest);
  return Base64Encode(digest, sizeof(digest));
}

bool DxcConfigReady(){
  return DxcHost.length() > 0 && DxcPort > 0 && DxcCallsign.length() > 0;
}

void DxcUpdateTelnetStatus(bool connected, bool forceSend){
  if(!forceSend && DxcTelnetStatus == connected) return;
  DxcTelnetStatus = connected;
  DxcSendTelnetStatus();
}

void DxcSendTelnetStatus(){
  if(!DxcWsClient.connected()) return;
  String payload = String("{\"telnet\":") + (DxcTelnetStatus ? "true" : "false") + "}";
  DxcSendWebSocketText(payload);
}

void DxcDisconnectTelnet(){
  if(DxcTelnetClient.connected()) DxcTelnetClient.stop();
  DxcTelnetLoginPending = false;
  DxcUpdateTelnetStatus(false);
}

void DxcDisconnectWebSocket(){
  if(DxcWsClient.connected()) DxcWsClient.stop();
  DxcWsStatus = false;
  DxcDisconnectTelnet();
}

void DxcRequestReconnect(){
  DxcDisconnectTelnet();
  DxcReconnectTimer = millis() + 250;
}

bool DxcConnectTelnet(){
  if(!DxcWsClient.connected() || !DxcConfigReady()){
    DxcUpdateTelnetStatus(false);
    return false;
  }
  if(DxcTelnetClient.connected()) return true;
  // resolve once and cache — hostByName blocks for seconds when DNS packets get lost
  if((uint32_t)DxcHostIp == 0 || DxcHostResolved != DxcHost){
    IPAddress ip;
    if(!WiFi.hostByName(DxcHost.c_str(), ip)){
      DxcReconnectTimer = millis() + 5000;
      DxcUpdateTelnetStatus(false);
      return false;
    }
    DxcHostIp = ip;
    DxcHostResolved = DxcHost;
  }
  WiFiClient newClient;
  if(!newClient.connect(DxcHostIp, DxcPort, DXC_CONNECT_TIMEOUT_MS)){
    DxcHostIp = IPAddress();   // stale address? re-resolve on the next attempt
    DxcReconnectTimer = millis() + 5000;
    DxcUpdateTelnetStatus(false);
    return false;
  }
  newClient.setNoDelay(true);
  DxcTelnetClient = newClient;
  DxcTelnetLoginPending = true;
  DxcUpdateTelnetStatus(true, true);
  return true;
}

bool DxcSendWebSocketFrame(uint8_t opcode, const uint8_t* payload, size_t length){
  if(!DxcWsClient.connected()) return false;
  uint8_t header[10];
  size_t headerLen = 0;
  header[headerLen++] = 0x80 | (opcode & 0x0F);
  if(length < 126){
    header[headerLen++] = uint8_t(length);
  }else if(length <= 0xFFFF){
    header[headerLen++] = 126;
    header[headerLen++] = uint8_t((length >> 8) & 0xFF);
    header[headerLen++] = uint8_t(length & 0xFF);
  }else{
    header[headerLen++] = 127;
    for(int shift = 56; shift >= 0; shift -= 8)
      header[headerLen++] = uint8_t((uint64_t(length) >> shift) & 0xFF);
  }
  if(DxcWsClient.write(header, headerLen) != headerLen){ DxcDisconnectWebSocket(); return false; }
  if(length > 0 && payload != nullptr){
    if(DxcWsClient.write(payload, length) != length){ DxcDisconnectWebSocket(); return false; }
  }
  return true;
}

bool DxcSendWebSocketText(const char* text){
  if(text == nullptr) return DxcSendWebSocketFrame(0x1, nullptr, 0);
  return DxcSendWebSocketFrame(0x1, reinterpret_cast<const uint8_t*>(text), strlen(text));
}

bool DxcSendWebSocketText(const String& text){
  return DxcSendWebSocketFrame(0x1, reinterpret_cast<const uint8_t*>(text.c_str()), text.length());
}

bool DxcHandleWebSocketUpgrade(WiFiClient& webClient, const String& request){
  String secKey    = ExtractHttpHeader(request, "Sec-WebSocket-Key");
  String upgrade   = ExtractHttpHeader(request, "Upgrade");
  String connection = ExtractHttpHeader(request, "Connection");
  upgrade.toLowerCase();
  connection.toLowerCase();
  if(secKey.length() == 0 || upgrade != "websocket" || connection.indexOf("upgrade") < 0){
    webClient.println(F("HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n"));
    webClient.println(F("Invalid WebSocket handshake"));
    return false;
  }
  if(DxcWsClient.connected()) DxcDisconnectWebSocket();
  String accept = DxcComputeWebSocketAccept(secKey);
  webClient.println(F("HTTP/1.1 101 Switching Protocols"));
  webClient.println(F("Upgrade: websocket"));
  webClient.println(F("Connection: Upgrade"));
  webClient.print(F("Sec-WebSocket-Accept: "));
  webClient.println(accept);
  webClient.println();
  DxcWsClient = webClient;
  DxcWsClient.setNoDelay(true);
  DxcWsStatus = true;
  DxcUpdateTelnetStatus(DxcTelnetClient.connected(), true);
  DxcRequestReconnect();
  return true;
}

void DxcHandleWebSocketClient(){
  if(!DxcWsClient.connected()){
    if(DxcWsStatus){ DxcWsStatus = false; DxcDisconnectTelnet(); }
    return;
  }
  while(DxcWsClient.available() >= 2){
    uint8_t hdr[2];
    if(DxcWsClient.read(hdr, 2) != 2){ DxcDisconnectWebSocket(); return; }
    uint8_t opcode = hdr[0] & 0x0F;
    bool masked = (hdr[1] & 0x80) != 0;
    uint64_t payloadLen = hdr[1] & 0x7F;
    if(payloadLen == 126){
      uint8_t ext[2];
      while(DxcWsClient.connected() && DxcWsClient.available() < 2) delay(1);
      if(DxcWsClient.read(ext, 2) != 2){ DxcDisconnectWebSocket(); return; }
      payloadLen = (uint16_t(ext[0]) << 8) | uint16_t(ext[1]);
    }else if(payloadLen == 127){
      uint8_t ext[8];
      while(DxcWsClient.connected() && DxcWsClient.available() < 8) delay(1);
      if(DxcWsClient.read(ext, 8) != 8){ DxcDisconnectWebSocket(); return; }
      payloadLen = 0;
      for(int i = 0; i < 8; i++) payloadLen = (payloadLen << 8) | ext[i];
    }
    uint8_t maskKey[4] = {0,0,0,0};
    if(masked){
      while(DxcWsClient.connected() && DxcWsClient.available() < 4) delay(1);
      if(DxcWsClient.read(maskKey, 4) != 4){ DxcDisconnectWebSocket(); return; }
    }
    if(payloadLen > 2048){ DxcDisconnectWebSocket(); return; }
    static uint8_t payload[2048];
    size_t needed = size_t(payloadLen);
    while(DxcWsClient.connected() && DxcWsClient.available() < int(needed)) delay(1);
    if(needed > 0 && DxcWsClient.read(payload, needed) != int(needed)){ DxcDisconnectWebSocket(); return; }
    if(masked){ for(size_t i = 0; i < needed; i++) payload[i] ^= maskKey[i % 4]; }
    if(opcode == 0x8){ DxcDisconnectWebSocket(); return; }
    if(opcode == 0x9){ DxcSendWebSocketFrame(0xA, payload, needed); continue; }
    if(opcode != 0x1) continue;
    String command = "";
    command.reserve(needed + 1);
    for(size_t i = 0; i < needed; i++){ if(payload[i] != '\0') command += char(payload[i]); }
    command.trim();
    if(command.length() == 0) continue;
    if(command == "@reconnect"){ DxcRequestReconnect(); continue; }
    if(!DxcTelnetClient.connected()){ DxcRequestReconnect(); continue; }
    DxcTelnetClient.print(command);
    DxcTelnetClient.print("\r\n");
  }
}

void DxcHandleTelnetClient(){
  if(!DxcWsClient.connected()){
    if(DxcTelnetClient.connected()) DxcDisconnectTelnet();
    return;
  }
  if(!DxcTelnetClient.connected()){ DxcUpdateTelnetStatus(false); return; }
  if(DxcTelnetLoginPending && DxcCallsign.length() > 0){
    DxcTelnetClient.print(DxcCallsign);
    DxcTelnetClient.print("\r\n");
    DxcTelnetLoginPending = false;
  }
  static uint8_t telnetBuffer[1024];
  while(DxcTelnetClient.available()){
    int chunk = DxcTelnetClient.read(telnetBuffer, sizeof(telnetBuffer));
    if(chunk <= 0) break;
    if(!DxcSendWebSocketFrame(0x1, telnetBuffer, size_t(chunk))) return;
  }
}

void DxcLoop(){
  DxcHandleWebSocketClient();
  if(!DxcWsClient.connected()){ DxcDisconnectTelnet(); return; }
  // DxcConnectTelnet() blocks on connect() (and possibly DNS) for up to ~1.5 s.
  // Never start it while a slot key is imminent; an established connection keeps
  // being read below.
  if(!DxcTelnetClient.connected() && DxcConfigReady() && millis() >= DxcReconnectTimer &&
     !txRealtimeNow()) DxcConnectTelnet();
  DxcHandleTelnetClient();
}

void dxcHandleRawClient(){
  WiFiClient client = dxcRawServer.available();
  if(!client) return;
  String request = "";
  unsigned long timeout = millis() + 2000;
  while(client.connected() && millis() < timeout){
    while(client.available()){
      char c = client.read();
      request += c;
      if(request.endsWith("\r\n\r\n")) goto done;
    }
    delay(1);
  }
  done:
  // check URI is /dxcws
  int uriStart = request.indexOf(' ') + 1;
  int uriEnd   = request.indexOf(' ', uriStart);
  String uri   = request.substring(uriStart, uriEnd);
  if(uri != "/dxcws"){
    client.println(F("HTTP/1.1 404 Not Found\r\nConnection: close\r\n"));
    client.stop();
    return;
  }
  if(!DxcHandleWebSocketUpgrade(client, request)){
    client.stop();
  }
  // on success, client is stored in DxcWsClient — do NOT stop it
}

// ── DATA-page audio WebSocket (port 83, /audiows) ─────────────────────────────
// Versioned AUD1 channel carrying timed RX uLaw and paced TX PCM16 between the
// IC-705 LAN session and the browser modem Worker.

void wsRingReset(){ wsOutHead = wsOutTail = wsOutLen = 0; }

// Append bytes to the outgoing WS ring (wraparound). Caller guarantees room.
static void wsRingWrite(const uint8_t* src, size_t len){
  size_t first = WS_OUT_SIZE - wsOutHead;
  if(first > len) first = len;
  memcpy(wsOut + wsOutHead, src, first);
  if(len > first) memcpy(wsOut, src + first, len - first);
  wsOutHead = (wsOutHead + len) % WS_OUT_SIZE;
  wsOutLen += len;
}

// Enqueue one complete WS frame (header + payload) atomically. A frame is queued
// whole or dropped whole, so the byte stream the browser reads is always a clean
// sequence of frames. Returns false when the ring is full (drop -> RX gap).
static bool wsEnqueueFrame(const uint8_t* header, size_t headerLen,
                           const uint8_t* payload, size_t payloadLen){
  if(!wsOut) return false;
  if(headerLen + payloadLen > WS_OUT_SIZE - wsOutLen) return false;
  wsRingWrite(header, headerLen);
  if(payloadLen) wsRingWrite(payload, payloadLen);
  return true;
}

// Non-blocking drain of the WS ring to the browser socket. ::send with
// MSG_DONTWAIT never blocks the cooperative loop; a partial send just leaves the
// rest for the next tick (TCP keeps byte order, so a frame split across sends is
// fine). Mirrors the web-server file-stream pattern.
void audioDrainWs(){
  if(wsOutLen == 0 || !AudioWsClient.connected()) return;
  int fd = AudioWsClient.fd();
  if(fd < 0) return;
  while(wsOutLen > 0){
    size_t chunk = WS_OUT_SIZE - wsOutTail;   // contiguous run to buffer end
    if(chunk > wsOutLen) chunk = wsOutLen;
    int n = netSendNonBlocking(fd, wsOut + wsOutTail, chunk);
    if(n > 0){
      wsOutTail = (wsOutTail + (size_t)n) % WS_OUT_SIZE;
      wsOutLen -= (size_t)n;
    }else if(n == 0){
      break;                                    // socket full -> finish next tick
    }else{
      AudioDisconnectWs();                       // peer gone / hard error
      return;
    }
  }
}

bool AudioSendBinary(const uint8_t* payload, size_t length){
  if(!AudioWsClient.connected()) return false;
  uint8_t header[4]; size_t headerLen = 0;
  header[headerLen++] = 0x80 | 0x2;                 // FIN + binary opcode
  if(length < 126){
    header[headerLen++] = uint8_t(length);
  }else if(length <= 0xFFFF){
    header[headerLen++] = 126;
    header[headerLen++] = uint8_t((length >> 8) & 0xFF);
    header[headerLen++] = uint8_t(length & 0xFF);
  }else{
    return false;                                   // audio chunks are always < 64k
  }
  return wsEnqueueFrame(header, headerLen, payload, length);   // false -> ring full, drop
}

bool AudioSendText(const String& text){
  if(!AudioWsClient.connected()) return false;
  size_t length = text.length();
  uint8_t header[4]; size_t headerLen = 0;
  header[headerLen++] = 0x80 | 0x1;
  if(length < 126){ header[headerLen++] = uint8_t(length); }
  else if(length <= 0xFFFF){
    header[headerLen++] = 126;
    header[headerLen++] = uint8_t(length >> 8);
    header[headerLen++] = uint8_t(length);
  }else return false;
  return wsEnqueueFrame(header, headerLen, (const uint8_t*)text.c_str(), length);
}

static void aud1PutBE16(uint8_t* p, uint16_t value){ p[0] = uint8_t(value >> 8); p[1] = uint8_t(value); }
static void aud1PutBE32(uint8_t* p, uint32_t value){
  p[0]=uint8_t(value>>24); p[1]=uint8_t(value>>16); p[2]=uint8_t(value>>8); p[3]=uint8_t(value);
}
static void aud1PutBE64(uint8_t* p, uint64_t value){
  for(int i=7; i>=0; --i){ p[i]=uint8_t(value); value >>= 8; }
}
static uint16_t aud1GetBE16(const uint8_t* p){ return (uint16_t(p[0])<<8) | p[1]; }
static uint32_t aud1GetBE32(const uint8_t* p){ return (uint32_t(p[0])<<24)|(uint32_t(p[1])<<16)|(uint32_t(p[2])<<8)|p[3]; }
static uint64_t aud1GetBE64(const uint8_t* p){
  uint64_t value=0; for(int i=0;i<8;i++) value=(value<<8)|p[i]; return value;
}

// Which ALC the browser should be told about. The same split /state makes with
// `snapView`: a LAN radio on TRX1 feeds the shared CAT globals, because
// lanCivFrameRoute() hands slot 0 to lanCivFrameHandler and returns -- the
// per-slot snapshot is never touched. Reading only the snapshot therefore
// reported "no ALC" forever on the ordinary single-radio setup, which is exactly
// the shape of "the radio never answered".
static uint32_t aud1AlcRaw() {
  return lanRadioSlotIndex() == 0 ? stateAlcRaw : (uint32_t)lanRadioSnap.alcRaw;
}
static uint32_t aud1AlcSeq() {
  return lanRadioSlotIndex() == 0 ? stateAlcSeq : lanRadioSnap.alcSeq;
}
static void aud1AlcReset() {
  stateAlcRaw = 0; stateAlcSeq = 0;
  lanRadioSnap.alcRaw = 0; lanRadioSnap.alcSeq = 0;
}

static uint8_t aud1Pcm16ToUlaw(int16_t input){
  int32_t sample = input;
  uint8_t sign = sample < 0 ? 0x80 : 0;
  if(sample < 0) sample = -sample;
  if(sample > 32635) sample = 32635;
  sample += 0x84;
  int exponent = 7;
  for(int mask=0x4000; exponent>0 && (sample & mask)==0; --exponent, mask>>=1){}
  uint8_t mantissa = uint8_t((sample >> (exponent + 3)) & 0x0F);
  return uint8_t(~(sign | (exponent << 4) | mantissa));
}

// Flush the coalesced audio buffer as one WS frame.
void audioFlush(){
  if(audioTxLen == 0) return;
  static uint8_t wire[40 + sizeof(audioTxBuf)];
  memcpy(wire, "AUD1", 4); wire[4] = 1; wire[5] = 1; // RX_ULAW
  uint16_t flags = (audioRxFirst ? 0x0001 : 0) | (audioRxDiscontinuity ? 0x0004 : 0);
  aud1PutBE16(wire+6, flags); aud1PutBE16(wire+8, 40); aud1PutBE16(wire+10, 0);
  aud1PutBE32(wire+12, audioStreamId); aud1PutBE32(wire+16, audioRxSequence);
  aud1PutBE32(wire+20, 8000); aud1PutBE64(wire+24, audioRxFirstSample);
  aud1PutBE32(wire+32, 0); aud1PutBE32(wire+36, audioTxLen);
  memcpy(wire+40, audioTxBuf, audioTxLen);
  bool sent = AudioSendBinary(wire, 40 + audioTxLen);
  audioRxFirstSample += audioTxLen;
  if(sent){ audioRxSequence++; audioRxFirst = false; audioRxDiscontinuity = false; }
  else { audioRxDiscontinuity = true; audioWsDropFrames++; }
  audioTxLen = 0;
}



// ── MSG BOX storage ──────────────────────────────────────────────────────────
// The browser owns the protocol decisions; this is only the durable copy. It is
// written whole rather than incrementally: at this size a rewrite costs one
// flash page more than an append and removes every partial-write failure mode.
void handleMsgboxGet(){
  // Serve the current file, or the pre-type one while it is still all we have.
  // Which record was mail for the operator and which was stock held for a third
  // station is decided in the browser, so the migration is a plain read here.
  const char* path = cfgFS.exists(MSGBOX_PATH) ? MSGBOX_PATH
                   : (cfgFS.exists(MSGBOX_LEGACY_PATH) ? MSGBOX_LEGACY_PATH : nullptr);
  if(!path){ webServer.send(200, "text/plain", ""); return; }
  File f = cfgFS.open(path, FILE_READ);
  if(!f){ webServer.send(500, "text/plain", "msgbox unavailable"); return; }
  webServer.sendHeader("Cache-Control", "no-store");
  webServer.streamFile(f, "text/plain");
  f.close();
}

void handleMsgboxPost(){
  String body = webServer.hasArg("plain") ? webServer.arg("plain") : String();
  if(body.length() > MSGBOX_MAX_BYTES){
    webServer.send(413, "application/json", "{\"error\":\"msgbox too large\"}");
    unattendedLogEvent(UEV_BLOCK, "msgbox write refused: too large");
    return;
  }
  File f = cfgFS.open(MSGBOX_PATH, "w");
  if(!f){ webServer.send(500, "application/json", "{\"error\":\"write failed\"}"); return; }
  f.print(body);
  f.close();
  // The typed file now holds everything the old one did, so the old one is dead
  // weight -- and leaving it would resurrect deleted mail if the new file were
  // ever lost.
  if(cfgFS.exists(MSGBOX_LEGACY_PATH)){
    cfgFS.remove(MSGBOX_LEGACY_PATH);
    Serial.println("MSGBOX | migrated, /inbox.jsonl removed");
  }
  Serial.print("MSGBOX | stored "); Serial.print(body.length()); Serial.println(" B");
  webServer.send(200, "application/json", "{\"ok\":true}");
}

// ── Unattended operation: event log, status and remote control ───────────────
// Decision 13: no silent suppression. Every refusal, ban and expiry leaves a
// trace that survives a page reload and is readable from any device, because a
// restriction that fires at 03:00 has to be explainable at 09:00.

// The one place that touches flash: append `n1`(+`n2`) bytes, rotating first if the
// file would exceed its cap. Runs only from unattendedLogFlush (off the TX-critical
// window) or the malloc-failed sync fallback. Returns false if the append could not
// open, so the caller keeps the bytes queued and retries next flush.
static bool unattendedLogWriteToFlash(const uint8_t* data1, size_t n1,
                                      const uint8_t* data2, size_t n2, bool overflow){
  uint32_t existing = 0;
  if(cfgFS.exists(UNATTENDED_LOG_PATH)){
    File probe = cfgFS.open(UNATTENDED_LOG_PATH, FILE_READ);
    if(probe){ existing = probe.size(); probe.close(); }
  }
  size_t add = n1 + n2 + (overflow ? 24 : 0);
  if(unattendedLogNeedsRotate(existing, add)){
    // Keep the newest part; start at the next line boundary so the first
    // retained entry is a whole event and not a fragment.
    File src = cfgFS.open(UNATTENDED_LOG_PATH, FILE_READ);
    String kept;
    if(src){
      src.seek(unattendedLogRotateFrom(existing));
      kept = src.readString();
      src.close();
      int nl = kept.indexOf('\n');
      if(nl >= 0) kept.remove(0, nl + 1);
    }
    File dst = cfgFS.open(UNATTENDED_LOG_PATH, "w");
    if(dst){ dst.print(kept); dst.close(); }
  }
  File out = cfgFS.open(UNATTENDED_LOG_PATH, FILE_APPEND);
  if(!out) return false;
  if(overflow) out.print("0 BLOCK log queue overflow\n");   // decision 13: never drop silently
  if(data1 && n1) out.write(data1, n1);
  if(data2 && n2) out.write(data2, n2);
  out.close();
  return true;
}

// Append one formatted line to the RAM ring. On a full ring drop whole oldest
// lines (never a fragment) and flag the overflow so the flush records it. If the
// ring allocation failed, non-realtime calls may write synchronously, but TX
// only records the loss marker and leaves flash untouched.
void unattendedLogEnqueue(const char* line, size_t n){
  if(!unaLogQueue){
    if(txRealtimeNow()){ unaLogOverflow = true; return; }
    if(unattendedLogWriteToFlash((const uint8_t*)line, n, nullptr, 0, unaLogOverflow))
      unaLogOverflow = false;
    return;
  }
  if(n == 0 || n > UNA_LOG_QUEUE_SIZE) return;
  while(UNA_LOG_QUEUE_SIZE - unaLogLen < n){
    size_t dropped = 0;
    while(unaLogLen > 0){
      uint8_t c = unaLogQueue[unaLogHead];
      unaLogHead = (unaLogHead + 1) % UNA_LOG_QUEUE_SIZE; unaLogLen--; dropped++;
      if(c == '\n') break;
    }
    unaLogOverflow = true;
    if(dropped == 0) break;   // ring smaller than one line; guarded by n check above
  }
  for(size_t i = 0; i < n; i++){
    unaLogQueue[unaLogTail] = (uint8_t)line[i];
    unaLogTail = (unaLogTail + 1) % UNA_LOG_QUEUE_SIZE;
  }
  unaLogLen += n;
}

// Drain the whole RAM ring to flash in one open/append. Called from loop() only
// while !txCriticalNow(). No interrupt enqueues the log, so the ring is stable for
// the duration of the write; on append failure the bytes stay queued for retry.
void unattendedLogFlush(){
  if(!unaLogQueue || unaLogLen == 0) return;
  size_t n = unaLogLen;
  size_t first = UNA_LOG_QUEUE_SIZE - unaLogHead;
  if(first > n) first = n;
  if(!unattendedLogWriteToFlash(unaLogQueue + unaLogHead, first,
                                unaLogQueue, n - first, unaLogOverflow)) return;
  unaLogHead = (unaLogHead + n) % UNA_LOG_QUEUE_SIZE;
  unaLogLen -= n;
  unaLogOverflow = false;
}

// trace that survives a page reload and is readable from any device, because a
// restriction that fires at 03:00 has to be explainable at 09:00. Hot-path safe:
// formats + serial-logs immediately, enqueues to RAM, and never touches flash here.
void unattendedLogEvent(uint8_t type, const String& detail){
  char line[UNATTENDED_EVENT_LINE_MAX];
  size_t len = unattendedFormatEvent(line, sizeof(line), millis(), type, detail.c_str());
  if(len == 0) return;
  Serial.print("UNA | "); Serial.print(line);
  unattendedLogEnqueue(line, len);
}

// ── JS8LAN single-operator lock ───────────────────────────────────────────────
// One reply shape for every verb so the page can render the panel from whatever
// came back, including the 409 that locked it out. `self` is what the caller
// actually asks about; `owner` is only ever an address to show a human.
void js8SessionRespond(Js8SessionResult result, const String& token){
  uint32_t now = millis();
  bool self = js8SessionOwns(js8Session, now, token.c_str());
  bool live = js8SessionLive(js8Session, now);
  String json = "{\"ok\":" + String(result == JS8_SESSION_BUSY || result == JS8_SESSION_BAD_TOKEN ? "false" : "true");
  json += ",\"state\":\""; json += js8SessionResultName(result); json += "\"";
  json += ",\"self\":" + String(self ? "true" : "false");
  json += ",\"held\":" + String(live ? "true" : "false");
  json += ",\"owner\":\""; json += live ? IPAddress(js8Session.ownerIpV4).toString() : String(); json += "\"";
  json += ",\"ageMs\":" + String((unsigned long)(live ? js8SessionAgeMs(js8Session, now) : 0));
  json += ",\"leaseMs\":" + String((unsigned long)JS8_SESSION_LEASE_MS);
  json += ",\"takeovers\":" + String((unsigned long)js8Session.takeovers);
  json += ",\"refusals\":" + String((unsigned long)js8Session.refusals);
  // Present only while a Mercury transfer is actually running (decision 5 +
  // §6.3): a locked-out page needs this to show "Mercury transfer foto.jpg,
  // 43% done" instead of the generic busy text; JS8LAN/WSPR poll the same
  // endpoint and just never see the field.
  if(live && js8Session.mercuryName[0] != 0){
    json += ",\"mercuryName\":\""; json += jsonEscape(js8Session.mercuryName); json += "\"";
    json += ",\"mercuryPercent\":" + String((unsigned)js8Session.mercuryPercent);
    json += ",\"mercuryRemainingMs\":" + String((unsigned long)js8Session.mercuryRemainingMs);
  }
  json += "}";
  webServer.sendHeader("Cache-Control", "no-store");
  int status = result == JS8_SESSION_BUSY      ? 409
             : result == JS8_SESSION_BAD_TOKEN ? 400
                                               : 200;
  webServer.send(status, "application/json", json);
}

String js8SessionRequestToken(){
  String body = webServer.hasArg("plain") ? webServer.arg("plain") : String();
  String token = extractJsonString(body, "token");
  if(token.length() == 0) token = webServer.arg("token");   // beacon fallback
  return token;
}

// Readable without claiming anything, so a locked-out page can poll and the
// SETUP diagnostics can show who holds the radio.
void handleJs8SessionGet(){
  js8SessionRespond(js8SessionLive(js8Session, millis()) ? JS8_SESSION_BUSY : JS8_SESSION_GRANTED, String());
}

// mercuryName present in the body means "I am Mercury and this is what I'm
// sending" (docs/mercury-implementace.md §6.3/§7) -- applied only once the
// caller actually owns the lock, from claim (transfer start) or ping
// (progress updates), so a refused/busy request can never write into
// somebody else's session.
void js8SessionApplyMercuryProgress(const String &body, const String &token){
  String name = extractJsonString(body, "mercuryName");
  if(name.length() == 0) return;
  if(!js8SessionOwns(js8Session, millis(), token.c_str())) return;
  int percent = extractJsonInt(body, "mercuryPercent");
  int remainingMs = extractJsonInt(body, "mercuryRemainingMs");
  js8SessionSetMercuryProgress(js8Session, name.c_str(),
                               (uint8_t)(percent < 0 ? 0 : percent),
                               (uint32_t)(remainingMs < 0 ? 0 : remainingMs));
}

void handleJs8SessionClaim(){
  String body  = webServer.hasArg("plain") ? webServer.arg("plain") : String();
  String token = js8SessionRequestToken();
  bool   force = extractJsonString(body, "force") == "true";
  IPAddress ip = webServer.client().remoteIP();
  char previous[JS8_SESSION_TOKEN_MAX + 1];
  strncpy(previous, js8Session.token, sizeof(previous));
  Js8SessionResult result = js8SessionClaim(js8Session, millis(), token.c_str(), uint32_t(ip), force);
  // Every change of owner drops the audio socket. Leaving it open would let the
  // losing page keep streaming into a radio it no longer owns, and it is what
  // lets the rest of the firmware treat an open socket as proof of ownership.
  if(strcmp(previous, js8Session.token) != 0 && AudioWsClient.connected())
    AudioDisconnectWs();
  if(result != JS8_SESSION_RENEWED){
    Serial.print("JS8 | session "); Serial.print(js8SessionResultName(result));
    Serial.print(" from "); Serial.println(ip.toString());
  }
  js8SessionApplyMercuryProgress(body, token);
  js8SessionRespond(result, token);
}

void handleJs8SessionPing(){
  String body  = webServer.hasArg("plain") ? webServer.arg("plain") : String();
  String token = js8SessionRequestToken();
  char previous[JS8_SESSION_TOKEN_MAX + 1];
  strncpy(previous, js8Session.token, sizeof(previous));
  Js8SessionResult result = js8SessionHeartbeat(js8Session, millis(), token.c_str(),
                                                uint32_t(webServer.client().remoteIP()));
  if(strcmp(previous, js8Session.token) != 0 && AudioWsClient.connected())
    AudioDisconnectWs();
  js8SessionApplyMercuryProgress(body, token);
  js8SessionRespond(result, token);
}

void handleJs8SessionRelease(){
  String token = js8SessionRequestToken();
  bool released = js8SessionRelease(js8Session, token.c_str());
  if(released && AudioWsClient.connected()) AudioDisconnectWs();
  webServer.sendHeader("Cache-Control", "no-store");
  webServer.send(200, "application/json",
                 String("{\"ok\":true,\"released\":") + (released ? "true" : "false") + "}");
}

// Everything the remote panel needs to tell "alive and working" from "alive but
// stuck": a frozen decoder still looks healthy if you only watch liveness.
void handleUnattendedGet(){
  uint32_t now = millis();
  bool live = unattendedLivenessFresh(unattendedGuard, now);
  IcomLanClient *audioClient = lanRadioClient();
  IcomLanAudioTx::Snapshot audioTx = audioClient
      ? audioClient->audioTxSnapshot() : IcomLanAudioTx::Snapshot();
  String json = "{\"armed\":" + String(unattendedArmActive(unattendedGuard, now) ? "true" : "false");
  json += ",\"remainingMs\":" + String((unsigned long)unattendedRemainingMs(unattendedGuard, now));
  json += ",\"clientLive\":" + String(live ? "true" : "false");
  json += ",\"clientAgeMs\":" + String(unattendedGuard.clientSeen
            ? (unsigned long)(now - unattendedGuard.lastClientMs) : 0UL);
  json += ",\"clientSeen\":" + String(unattendedGuard.clientSeen ? "true" : "false");
  json += ",\"blockedLiveness\":" + String((unsigned long)unattendedGuard.blockedLiveness);
  json += ",\"blockedNotArmed\":" + String((unsigned long)unattendedGuard.blockedNotArmed);
  json += ",\"livenessTimeoutMs\":" + String((unsigned long)unattendedGuard.livenessTimeoutMs);
  json += ",\"ptt\":" + String(audioTxKeyed ? "true" : "false");
  json += ",\"txState\":" + String((int)aud1TxState);
  json += ",\"txUsed\":" + String((unsigned long)aud1TxUsed);
  json += ",\"txCapacity\":" + String((unsigned long)AUD1_TX_RING_SIZE);
  json += ",\"txPackets\":" + String((unsigned long)audioTx.sentPackets);
  json += ",\"txReplays\":" + String((unsigned long)audioTx.replayedPackets);
  json += ",\"txReplayMisses\":" + String((unsigned long)audioTx.replayMisses);
  json += ",\"txSendFailures\":" + String((unsigned long)audioTx.sendFailures);
  json += ",\"txMaxLateMs\":" + String((unsigned long)audioTx.maxLatenessMs);
  json += ",\"audioRxDropped\":" + String((unsigned long)(audioClient ? audioClient->audioRxDropped() : 0));
  json += ",\"audioMaxSendUs\":" + String((unsigned long)(audioClient ? audioClient->audioMaxSendUs() : 0));
  json += ",\"rxPackets\":" + String((unsigned long)audioRxPackets);
  json += ",\"lan\":" + String(lanRadioConnected() ? "true" : "false");
  json += ",\"upMs\":" + String((unsigned long)now);
  json += ",\"choicesH\":[";
  for(uint8_t i = 0; i < UNATTENDED_ARM_CHOICE_COUNT; i++){
    if(i) json += ",";
    json += String((unsigned long)UNATTENDED_ARM_CHOICES_H[i]);
  }
  json += "]}";
  webServer.sendHeader("Cache-Control", "no-store");
  webServer.send(200, "application/json", json);
}

void handleUnattendedLog(){
  if(!cfgFS.exists(UNATTENDED_LOG_PATH)){
    webServer.send(200, "text/plain", "");
    return;
  }
  File f = cfgFS.open(UNATTENDED_LOG_PATH, FILE_READ);
  if(!f){ webServer.send(500, "text/plain", "log unavailable"); return; }
  webServer.sendHeader("Cache-Control", "no-store");
  webServer.streamFile(f, "text/plain");
  f.close();
}

// Arm, extend and revoke are all reachable from any device on the network --
// that is the whole point of the firmware owning the state rather than the tab.
void handleUnattendedPost(){
  String body = webServer.hasArg("plain") ? webServer.arg("plain") : String();
  String action = extractJsonString(body, "action");
  uint32_t hours = (uint32_t)extractJsonString(body, "hours").toInt();

  if(action == "revoke"){
    unattendedRevoke(unattendedGuard);
    unattendedLogEvent(UEV_REVOKE, "remote revoke");
    handleUnattendedGet();
    return;
  }
  if(action == "arm" || action == "extend"){
    if(!unattendedIsArmChoiceH(hours)){
      webServer.send(400, "application/json", "{\"error\":\"unsupported duration\"}");
      return;
    }
    uint32_t ms = hours * 3600UL * 1000UL;
    bool ok = action == "arm" ? unattendedArm(unattendedGuard, ms, millis())
                              : unattendedExtend(unattendedGuard, ms, millis());
    if(!ok){ webServer.send(400, "application/json", "{\"error\":\"arm rejected\"}"); return; }
    unattendedLogEvent(action == "arm" ? UEV_ARM : UEV_EXTEND, String(hours) + " h");
    handleUnattendedGet();
    return;
  }
  webServer.send(400, "application/json", "{\"error\":\"unknown action\"}");
}

// ── M3 TX: key/un-key PTT via CI-V (LAN); dead-man safety un-keys on loss ──────
void audioPttOn(){
  if(audioTxKeyed) { audioTxLastMs = millis(); return; }
  if(audioPttOffPending){
    audioPttOff();
    Serial.println("AUD | PTT ON skipped (safety OFF was pending)");
    return;
  }
  if(!lanRadioConnected()){ Serial.println("AUD | PTT ON skipped (LAN not connected)"); return; }
  uint8_t f[] = {0x1C, 0x00, 0x01};          // TX ON (same CI-V as CAT-page PTT)
  bool ok = lanRadioSendPriorityCommand(f, 3, IcomLanClient::CIV_CONTROL);
  audioTxKeyed = ok; audioTxLastMs = millis();
  if(ok){ rtcPttWasKeyed = 1; audioPttOffPending = false; }
  Serial.print("AUD | PTT ON (TX audio) sendCommand="); Serial.println(ok ? "ok" : "FAIL");
}
void audioPttOff(){
  if(!audioTxKeyed && rtcPttWasKeyed != 1 && !audioPttOffPending) return;
  audioTxKeyed = false;
  uint8_t f[] = {0x1C, 0x00, 0x00};          // TX OFF
  bool ok = lanRadioSendPriorityCommand(f, 3, IcomLanClient::CIV_SAFETY);
  // Failed submission means the radio may still be keyed. Preserve both the
  // RTC evidence and a live retry until the CI-V Interface is healthy again.
  audioPttOffPending = !ok;
  audioPttRetryAt = millis() + 250;
  if(ok) rtcPttWasKeyed = 0;
  Serial.print("AUD | PTT OFF sendCommand="); Serial.println(ok ? "ok" : "FAIL (pending reconnect)");
}

// PTT in LAN mode is a state held by the radio, so it outlives the ESP32.
// A watchdog reset, panic or power cut while keyed leaves the IC-705
// transmitting with nothing left that knows about it. Send TX OFF on every
// link-up unconditionally -- never gated on what this boot believes it did.
void audioPttSafetyOnLink(){
  if(!lanRadioConnected()){
    Serial.println("AUD | SAFETY: skipped, LAN not connected");
    return;
  }
  uint8_t f[] = {0x1C, 0x00, 0x00};
  bool ok = lanRadioSendPriorityCommand(f, 3, IcomLanClient::CIV_SAFETY);
  audioTxKeyed = false;
  audioPttOffPending = !ok;
  audioPttRetryAt = millis() + 250;
  // Always log: without a radio on the bench this line is the only evidence the
  // safety un-key ran at all, and its absence is itself the symptom to look for.
  Serial.print("AUD | SAFETY: TX OFF on link-up sendCommand=");
  Serial.print(ok ? "ok" : "FAIL");
  Serial.print(" wasKeyedBeforeReset=");
  Serial.println(rtcPttWasKeyed == 1 ? "yes" : "no");
  if(rtcPttWasKeyed == 1)
    unattendedLogEvent(UEV_PTT_SAFETY, String("reset while keyed; TX OFF ") + (ok ? "sent" : "FAILED"));
  if(ok) rtcPttWasKeyed = 0;
}

void audioPttSafetyRetryTick(){
  if(!audioPttOffPending || (int32_t)(millis() - audioPttRetryAt) < 0) return;
  audioPttOff();
}

static void aud1TxResetState(Aud1TxState next = AUD1_TX_IDLE){
  if(IcomLanClient *client = lanRadioClient()) client->cancelAudioTx();
  aud1TxState=next; aud1TxUsed=0;
  aud1TxExpectedSequence=aud1TxExpectedPackets=aud1TxReceivedPackets=0;
  aud1TxExpectedSample=aud1TxTotalSamples=aud1TxConsumedUlaw=0;
  aud1TxTargetMs=aud1TxDeadlineMs=aud1TxPrebufferSamples=0;
  aud1TxLevelNextMs=0;
  aud1TxLastSeen=false;
}

void aud1TxAbort(const String& reason, bool notify){
  uint32_t txId = aud1TxId;
  if(IcomLanClient *client = lanRadioClient()) client->setTxTrafficActive(false);
  audioPttOff(); aud1TxResetState(reason.length() ? AUD1_TX_FAULT : AUD1_TX_IDLE);
  if(notify && AudioWsClient.connected()){
    String json = "{\"type\":\"tx-error\",\"txId\":" + String(txId) +
                  ",\"reason\":\"" + jsonEscape(reason) + "\",\"ptt\":false}";
    AudioSendText(json);
  }
  if(reason.length()){
    Serial.print("AUD1 | TX abort: "); Serial.println(reason);
    unattendedLogEvent(UEV_TX_ABORT, reason);
  }
}

// True while a scheduled audio-TX key is imminent: the whole prebuffer fill
// (PREBUFFER) and the last stretch of the wait before the slot (READY within
// the guard lead). The cooperative loop skips blocking best-effort work
// (port-80 handlers, DXC connect)
// during this window so a flash/DNS/connect stall cannot push PTT past the slot.
// Deliberately excludes STREAM: realtime playout has its own owner, while this
// guard controls cooperative-loop work around the key instant and prebuffer.
// Start before the browser's 1.35 s stream lead. Apart from protecting the
// cooperative loop, this window lets firmware push scheduling opportunities to
// a backgrounded WSPR page whose JavaScript timer may have been throttled.
static const uint32_t TX_GUARD_LEAD_MS  = 3000;
static const uint32_t TX_GUARD_TRAIL_MS = 150;    // covers the key instant itself
bool txCriticalNow(){
  if(aud1TxState == AUD1_TX_PREBUFFER) return true;
  if(aud1TxState == AUD1_TX_READY){
    int32_t toSlot = (int32_t)(aud1TxTargetMs - millis());
    return toSlot <= (int32_t)TX_GUARD_LEAD_MS && toSlot > -(int32_t)TX_GUARD_TRAIL_MS;
  }
  return false;
}

// Work which can stall flash/DNS/connect is forbidden for the full keyed
// interval. Port-80 as a whole is not blocked: WSPR /state and JS8 session
// heartbeats must remain live through a 110-second transmission.
bool txRealtimeNow(){
  return aud1TxState == AUD1_TX_STREAM || txCriticalNow();
}

void aud1TxTick(bool deferPrebufferMiss){
  uint32_t now = millis();
  IcomLanClient *txClient = lanRadioClient();
  if(!txClient && (aud1TxState == AUD1_TX_READY || aud1TxState == AUD1_TX_PREBUFFER ||
                   aud1TxState == AUD1_TX_STREAM)){
    aud1TxAbort("LAN radio gone"); return;
  }
  IcomLanAudioTx::Snapshot txSnapshot = {};
  if(txClient){
    txSnapshot = txClient->audioTxSnapshot();
    aud1TxUsed = txSnapshot.queued;
    aud1TxConsumedUlaw = txSnapshot.consumed;
  }
  if(aud1TxState == AUD1_TX_READY || aud1TxState == AUD1_TX_PREBUFFER){
    int32_t toSlot = (int32_t)(aud1TxTargetMs - now);
    if(toSlot > 0){
      // Browser timers are only a fallback clock. A hidden Chrome tab can have
      // chained timers checked as rarely as once per minute, so drive the WSPR
      // pump from inbound WebSocket traffic before its 1.35 s prebuffer point.
      // JS8 uses the same socket but safely ignores this status message.
      if(toSlot <= (int32_t)TX_GUARD_LEAD_MS &&
         (int32_t)(now - aud1TxLevelNextMs) >= 0){
        aud1TxLevelNextMs = now + 200;   // ~5/s until PTT
        AudioSendText("{\"type\":\"tx-level\",\"txId\":" + String(aud1TxId) +
                      ",\"used\":" + String((unsigned long)aud1TxUsed) +
                      ",\"capacity\":" + String((unsigned long)AUD1_TX_RING_SIZE) +
                      ",\"consumed\":" + String((unsigned long long)aud1TxConsumedUlaw) +
                      ",\"udpPackets\":" + String((unsigned long)txSnapshot.sentPackets) +
                      ",\"maxLateMs\":" + String((unsigned long)txSnapshot.maxLatenessMs) +
                      ",\"replays\":" + String((unsigned long)txSnapshot.replayedPackets) +
                      ",\"sendFailures\":" + String((unsigned long)txSnapshot.sendFailures) +
                      ",\"rxDropped\":" + String((unsigned long)txClient->audioRxDropped()) +
                      ",\"alc\":" + String((unsigned long)aud1AlcRaw()) +
                      ",\"alcSeq\":" + String((unsigned long)aud1AlcSeq()) +
                      ",\"ptt\":false}");
      }
      return;
    }
    size_t required = (aud1TxPrebufferSamples + 5) / 6;
    if(aud1TxExpectedSample < aud1TxPrebufferSamples || aud1TxUsed < required){
      // A complete packet may already be queued behind a fragmented TCP read.
      // Give the non-blocking parser a short, bounded chance to consume only
      // that backlog; never wait here and never key without the full prebuffer.
      if(deferPrebufferMiss && (int32_t)(now - aud1TxTargetMs) <= (int32_t)AUD1_WS_SLOT_BACKLOG_GRACE_MS) return;
      aud1TxAbort("TX prebuffer missed slot"); return;
    }
    // The slot may be up to 35 s after tx.prepare. Do not key the radio for a
    // browser that has gone silent in the meantime, even though the ring still
    // holds a full prebuffer from before it died.
    if(!unattendedMayKey(unattendedGuard, now)){
      Serial.print("AUD1 | refuse to key: frontend silent for ");
      Serial.print(now - unattendedGuard.lastClientMs);
      Serial.print(" ms (limit "); Serial.print(unattendedGuard.livenessTimeoutMs);
      Serial.println(" ms), ring still held a full prebuffer");
      unattendedLogEvent(UEV_BLOCK, "liveness lost before keying");
      aud1TxAbort("frontend liveness lost before keying"); return;
    }
    audioPttOn();
    if(!audioTxKeyed){ aud1TxAbort("PTT command failed"); return; }
    uint64_t totalUlaw = (aud1TxTotalSamples + 5) / 6;
    if(!txClient->startAudioTx(totalUlaw, now)){
      aud1TxAbort("audio scheduler did not start"); return;
    }
    txClient->setTxTrafficActive(true);
    aud1TxState = AUD1_TX_STREAM;
    AudioSendText("{\"type\":\"tx-state\",\"txId\":" + String(aud1TxId) + ",\"ptt\":true}");
    txSnapshot = txClient->audioTxSnapshot();
  }
  if(aud1TxState != AUD1_TX_STREAM) return;
  txSnapshot = txClient->audioTxSnapshot();
  aud1TxUsed = txSnapshot.queued;
  aud1TxConsumedUlaw = txSnapshot.consumed;
  if(txSnapshot.fault != IcomLanAudioTx::FAULT_NONE){
    aud1TxAbort(txClient->audioTxFaultName(txSnapshot.fault)); return;
  }
  if(txSnapshot.drained){
    txClient->setTxTrafficActive(false);
    audioPttOff(); aud1TxState = AUD1_TX_DRAINED;
    AudioSendText("{\"type\":\"tx-drained\",\"txId\":" + String(aud1TxId) + ",\"ptt\":false}");
    Serial.println("AUD1 | TX drained, PTT OFF");
    return;
  }
  if((int32_t)(now - aud1TxDeadlineMs) > 0){ aud1TxAbort("TX watchdog"); return; }
  if((int32_t)(now - aud1TxLevelNextMs) >= 0){
    aud1TxLevelNextMs = now + 200;   // ~5/s
    AudioSendText("{\"type\":\"tx-level\",\"txId\":" + String(aud1TxId) +
                  ",\"used\":" + String((unsigned long)aud1TxUsed) +
                  ",\"capacity\":" + String((unsigned long)AUD1_TX_RING_SIZE) +
                  ",\"consumed\":" + String((unsigned long long)aud1TxConsumedUlaw) +
                  ",\"udpPackets\":" + String((unsigned long)txSnapshot.sentPackets) +
                  ",\"maxLateMs\":" + String((unsigned long)txSnapshot.maxLatenessMs) +
                  ",\"replays\":" + String((unsigned long)txSnapshot.replayedPackets) +
                  ",\"sendFailures\":" + String((unsigned long)txSnapshot.sendFailures) +
                  ",\"rxDropped\":" + String((unsigned long)txClient->audioRxDropped()) +
                  ",\"alc\":" + String((unsigned long)aud1AlcRaw()) +
                  ",\"alcSeq\":" + String((unsigned long)aud1AlcSeq()) +
                  ",\"ptt\":true}");
  }
  audioTxLastMs = now;
}

void AudioDisconnectWs(){
  // A normal page leave while receiving is not a TX fault. Abort and log only
  // when a prepared/streaming TX or keyed PTT actually needs the safety path.
  if(aud1TxNeedsDisconnectAbort(aud1TxState, audioTxKeyed))
    aud1TxAbort("WebSocket disconnected", false);
  else
    aud1TxResetState();
  if(AudioWsClient.connected()) AudioWsClient.stop();
  wsRingReset();
  aud1WsParser.reset();
  if(IcomLanClient *client = lanRadioClient()) client->stopRxAudio();
}

// Called by the LAN client for every RX audio datagram payload (~160 B / 20 ms).
// Coalesce a few packets into one WS frame to cut the frame rate (~50/s -> ~10/s)
// and keep the single-threaded loop responsive to the port-80 /state polls.
void lanAudioHandler(const uint8_t *data, size_t len, uint16_t radioSequence){
  if(len == 0 || !AudioWsClient.connected()) return;
  if(audioRadioSequenceValid){
    int16_t delta = int16_t(radioSequence - audioRadioExpectedSequence);
    if(delta < 0) return; // duplicate or stale radio datagram
    if(delta > 0){
      audioFlush();
      audioRxFirstSample += uint64_t(uint16_t(delta)) * len;
      audioRxDiscontinuity = true;
      audioSeqGapEvents++;
      audioSeqGapPackets += uint16_t(delta);
    }
  }
  audioRadioExpectedSequence = uint16_t(radioSequence + 1);
  audioRadioSequenceValid = true;
  if(audioRxPackets == 0){ Serial.print("AUD | rx audio flowing, first packet "); Serial.print(len); Serial.println(" B"); }
  audioRxPackets++;
  if(len > sizeof(audioTxBuf)){
    audioFlush(); audioRxFirstSample += len; audioRxDiscontinuity = true;
    return; // never leak a metadata-free frame into the AUD1 stream
  }
  if(audioTxLen + len > sizeof(audioTxBuf)) audioFlush();
  memcpy(audioTxBuf + audioTxLen, data, len);
  audioTxLen += len;
  if(audioTxLen >= 512) audioFlush();                                   // keep frames < 1 MSS
}

static uint64_t aud1JsonU64(const String& json, const char* key){
  String value = extractJsonString(json, key);
  return value.length() ? strtoull(value.c_str(), nullptr, 10) : 0;
}

static void aud1HandleControl(const String& json){
  String type = extractJsonString(json, "type");
  uint32_t txId = (uint32_t)aud1JsonU64(json, "txId");
  if(type == "tx.abort"){
    if((aud1TxState == AUD1_TX_READY || aud1TxState == AUD1_TX_PREBUFFER ||
        aud1TxState == AUD1_TX_STREAM) && (!txId || txId == aud1TxId)){
      String reason = extractJsonString(json, "reason");
      aud1TxAbort(reason.length() && reason != "operator" ? String("client abort: ") + reason : "operator abort");
    }
    return;
  }
  // Diagnostic RTT probe (js8-aud1.js _schedulePing): echo the client's own clock
  // value straight back, same shape as the LAN 0x07 ping/pong. Distinct from
  // WsprTx's "wspr.ping" keepalive below, which stays a no-op here on purpose --
  // it exists only to keep the socket's dead-man timer fed, not to measure RTT.
  if(type == "ping"){
    uint32_t t = (uint32_t)aud1JsonU64(json, "t");
    AudioSendText("{\"type\":\"pong\",\"t\":" + String(t) + "}");
    return;
  }
  // Mercury's own keepalive (docs/mercury-implementace.md §3.2/§7), same idea and
  // same no-op as "wspr.ping" just above: every WS frame already refreshes both
  // the unattended dead-man and the session lease unconditionally, before this
  // function is even called (see js8SessionNoteTraffic at the frame-receive
  // site) -- so this branch changes nothing at runtime. It exists so a reader
  // (or a future "why doesn't mercury.ping do X" question) finds this type
  // named and explained here, not silently falling through with no trace.
  if(type == "mercury.ping") return;
  if(type != "tx.prepare") return;

  uint64_t slotUtcMs = aud1JsonU64(json, "slotUtcMs");
  uint64_t clientUtcMs = aud1JsonU64(json, "clientUtcMs");
  uint64_t totalSamples = aud1JsonU64(json, "samples");
  uint32_t packets = (uint32_t)aud1JsonU64(json, "packets");
  uint32_t prebuffer = (uint32_t)aud1JsonU64(json, "prebufferSamples");
  uint32_t sampleRate = (uint32_t)aud1JsonU64(json, "sampleRate");
  uint32_t packetMs = (uint32_t)aud1JsonU64(json, "packetMs");
  // Refuse a transmission the browser itself marked unattended once arming has
  // lapsed. Liveness is NOT tested here: this very frame just refreshed the
  // dead-man, so the test could never fail. It is applied at keying time
  // instead (aud1TxTick), which is where a browser can die between preparing a
  // slot and the slot arriving.
  bool wantsUnattended = extractJsonBool(json, "unattended", false);
  UnattendedBlock block = unattendedEvaluate(unattendedGuard, millis(), wantsUnattended);
  if(block != UNATTENDED_OK){
    aud1TxId = txId;
    unattendedLogEvent(UEV_BLOCK, unattendedBlockReason(block));
    aud1TxAbort(String("blocked: ") + unattendedBlockReason(block));
    return;
  }

  int64_t delayMs = int64_t(slotUtcMs) - int64_t(clientUtcMs);
  if(txId == 0 || sampleRate != 48000 || packetMs != 20 || totalSamples == 0 ||
     packets == 0 || prebuffer == 0 || prebuffer > totalSamples ||
     prebuffer > AUD1_TX_RING_SIZE * 6 || delayMs < 100 || delayMs > 35000 ||
     !lanRadioConnected() || !lanRadioClient() || !lanRadioClient()->audioTxReady()){
    aud1TxId = txId; aud1TxAbort("invalid tx.prepare"); return;
  }
  if(aud1TxState != AUD1_TX_IDLE && aud1TxState != AUD1_TX_DRAINED && aud1TxState != AUD1_TX_FAULT)
    aud1TxAbort("new TX replaced active TX", false);
  aud1TxResetState(AUD1_TX_READY);
  if(!lanRadioClient()->prepareAudioTx()){
    aud1TxId = txId; aud1TxAbort("audio channel not ready"); return;
  }
  // Fast ALC metering is opt-in per transmission and never inferred from the
  // mode: a beacon slot and a calibration carrier look identical on the wire.
  // setTxTrafficActive(false) clears it again on every ending, so an aborted
  // calibration cannot leave the rotation starved of frequency and SWR.
  lanRadioClient()->setAlcFast(extractJsonBool(json, "alcFast", false));
  // The counter belongs to this transmission. Reset it with the id rather than
  // with PTT: an abort between prepare and keying would otherwise hand the next
  // run a sequence that has already moved, and its first reading -- taken at
  // the old drive level -- would be accepted as fresh.
  aud1AlcReset();
  aud1TxId = txId; aud1TxTotalSamples = totalSamples; aud1TxExpectedPackets = packets;
  aud1TxPrebufferSamples = prebuffer; aud1TxTargetMs = millis() + uint32_t(delayMs);
  aud1TxDeadlineMs = aud1TxTargetMs + uint32_t(totalSamples / 48) + 2500;
  AudioSendText("{\"type\":\"tx-ready\",\"txId\":" + String(aud1TxId) + ",\"ptt\":false}");
  Serial.print("AUD1 | TX ready id="); Serial.print(aud1TxId);
  Serial.print(" slot in ms="); Serial.println((long)delayMs);
}

static bool aud1AcceptTxPacket(const uint8_t* wire, size_t length){
  // TCP may still contain frames which were queued before a tx-error reached
  // the browser. Drop those frames quietly; repeatedly faulting and replying
  // here used to monopolize the single-threaded audio WebSocket loop.
  if(length >= 40 && memcmp(wire, "AUD1", 4) == 0 && wire[4] == 1 && wire[5] == 3 &&
     (aud1TxState == AUD1_TX_IDLE || aud1TxState == AUD1_TX_DRAINED ||
      aud1TxState == AUD1_TX_FAULT) && aud1GetBE32(wire+32) == aud1TxId)
    return false;
  if(length < 40 || memcmp(wire, "AUD1", 4) != 0 || wire[4] != 1 || wire[5] != 3 ||
     aud1GetBE16(wire+8) != 40 || aud1GetBE16(wire+10) != 0 ||
     aud1GetBE32(wire+12) != audioStreamId || aud1GetBE32(wire+16) != aud1TxExpectedSequence ||
     aud1GetBE32(wire+20) != 48000 || aud1GetBE64(wire+24) != aud1TxExpectedSample ||
     aud1GetBE32(wire+32) != aud1TxId || aud1GetBE32(wire+36) != length-40 ||
     (length-40) == 0 || ((length-40) % 12) != 0 ||
     !(aud1TxState == AUD1_TX_READY || aud1TxState == AUD1_TX_PREBUFFER || aud1TxState == AUD1_TX_STREAM)){
    aud1TxAbort("TX packet identity/continuity failure"); return false;
  }
  uint16_t flags = aud1GetBE16(wire+6);
  bool first = (flags & 0x0001) != 0, last = (flags & 0x0002) != 0;
  size_t samples = (length-40)/2, ulawSamples = samples/6;
  IcomLanClient *txClient = lanRadioClient();
  if(!txClient){ aud1TxAbort("LAN radio gone"); return false; }
  IcomLanAudioTx::Snapshot snapshot = txClient->audioTxSnapshot();
  aud1TxUsed = snapshot.queued;
  if(aud1TxUsed + ulawSamples > AUD1_TX_RING_SIZE || ulawSamples > 192){
    aud1TxAbort("TX ring overflow before write"); return false;
  }
  if((aud1TxExpectedSequence == 0) != first || (flags & ~0x0003) != 0 ||
     aud1TxExpectedSample + samples > aud1TxTotalSamples ||
     aud1TxReceivedPackets + 1 > aud1TxExpectedPackets ||
     (last && (aud1TxExpectedSample + samples != aud1TxTotalSamples ||
               aud1TxReceivedPackets + 1 != aud1TxExpectedPackets)) ||
     (!last && aud1TxReceivedPackets + 1 == aud1TxExpectedPackets)){
    aud1TxAbort("TX FIRST/LAST/length/buffer failure"); return false;
  }
  uint8_t converted[192];
  size_t convertedLength = 0;
  for(size_t i=0; i<samples; i+=6){
    size_t at = 40 + i*2;
    int16_t pcm = int16_t(uint16_t(wire[at]) | (uint16_t(wire[at+1]) << 8));
    converted[convertedLength++] = aud1Pcm16ToUlaw(pcm);
  }
  if(!txClient->queueAudioTx(converted, convertedLength)){
    aud1TxAbort("TX ring overflow"); return false;
  }
  aud1TxUsed = txClient->audioTxSnapshot().queued;
  aud1TxExpectedSample += samples; aud1TxExpectedSequence++; aud1TxReceivedPackets++;
  aud1TxLastSeen = last;
  if(aud1TxState == AUD1_TX_READY) aud1TxState = AUD1_TX_PREBUFFER;
  audioTxLastMs = millis();
  return true;
}

bool AudioHandleWsUpgrade(WiFiClient& webClient, const String& request, const String& token){
  String secKey     = ExtractHttpHeader(request, "Sec-WebSocket-Key");
  String upgrade    = ExtractHttpHeader(request, "Upgrade");
  String connection = ExtractHttpHeader(request, "Connection");
  upgrade.toLowerCase();
  connection.toLowerCase();
  if(secKey.length() == 0 || upgrade != "websocket" || connection.indexOf("upgrade") < 0){
    webClient.println(F("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n"));
    return false;
  }
  // The hard half of the single-operator lock. The UI gate can be bypassed by
  // opening the socket directly, so ownership is checked where the audio
  // actually starts rather than only where the page decides to render.
  if(!js8SessionOwns(js8Session, millis(), token.c_str())){
    Serial.println("AUD1 | WS upgrade refused, session held elsewhere");
    webClient.println(F("HTTP/1.1 409 Conflict\r\nConnection: close\r\n"));
    return false;
  }
  if(AudioWsClient.connected()) AudioDisconnectWs();
  String accept = DxcComputeWebSocketAccept(secKey);
  webClient.println(F("HTTP/1.1 101 Switching Protocols"));
  webClient.println(F("Upgrade: websocket"));
  webClient.println(F("Connection: Upgrade"));
  webClient.print(F("Sec-WebSocket-Accept: "));
  webClient.println(accept);
  webClient.println();
  AudioWsClient = webClient;
  AudioWsClient.setNoDelay(true);
  wsRingReset();
  audioRxPackets = 0; audioTxLen = 0;
  audioSeqGapEvents = audioSeqGapPackets = audioWsDropFrames = 0;
  audioHealthLastMs = millis();
  audioStreamId = esp_random(); if(audioStreamId == 0) audioStreamId = 1;
  audioRxSequence = 0; audioRxFirstSample = 0; audioRxFirst = true; audioRxDiscontinuity = false;
  audioRadioSequenceValid = false; audioRadioExpectedSequence = 0;
  aud1WsParser.reset();
  aud1TxResetState(); aud1TxId = 0;
  String hello = "{\"type\":\"hello\",\"protocol\":\"AUD1\",\"version\":1,\"streamId\":" +
                 String(audioStreamId) + ",\"rx\":[{\"kind\":\"RX_ULAW\",\"sampleRate\":8000}]," +
                 "\"tx\":[{\"kind\":\"TX_PCM16\",\"sampleRate\":48000}],\"maxPayloadBytes\":1920}";
  if(!AudioSendText(hello)){ AudioDisconnectWs(); return false; }
  if(IcomLanClient *client = lanRadioClient()) client->startRxAudio();   // opens the LAN audio channel
  Serial.print("AUD1 | WS client connected, stream="); Serial.println(audioStreamId);
  return true;
}

void AudioHandleWsClient(){
  if(!AudioWsClient.connected()){
    if(aud1TxNeedsDisconnectAbort(aud1TxState, audioTxKeyed))
      aud1TxAbort("WebSocket disconnected", false);
    if(IcomLanClient *client = lanRadioClient(); client && client->rxAudioActive()) client->stopRxAudio();
    audioTxLen = 0;
    aud1WsParser.reset();
    return;
  }
  // Browser -> ESP32: consume only bytes which have already arrived. The old
  // parser waited for the rest of every TCP-fragmented frame and kept draining
  // an unbounded stream in one call, starving the 20 ms TX ring service.
  uint8_t chunk[512];
  size_t byteBudget = AUD1_WS_RX_BYTE_BUDGET;
  while(byteBudget > 0){
    int available = AudioWsClient.available();
    if(available <= 0) break;
    size_t take = size_t(available);
    if(take > sizeof(chunk)) take = sizeof(chunk);
    if(take > byteBudget) take = byteBudget;
    int received = AudioWsClient.read(chunk, take);
    if(received <= 0) break;
    byteBudget -= size_t(received);

    for(int index = 0; index < received; index++){
      Aud1WsParser::Result result = aud1WsParser.push(chunk[index]);
      if(result == Aud1WsParser::Error){ AudioDisconnectWs(); return; }
      if(result != Aud1WsParser::FrameReady) continue;

      uint8_t opcode = aud1WsParser.opcode();
      size_t length = aud1WsParser.payloadSize();
      uint8_t* payload = aud1WsParser.payload();
      // Any frame proves the browser is alive; during a long transfer the TX
      // audio packets alone (~50/s) keep the dead-man fresh. The same evidence
      // renews the session lease, so a page busy with audio never loses the
      // radio to a starved HTTP heartbeat.
      unattendedNoteClient(unattendedGuard, millis());
      js8SessionNoteTraffic(js8Session, millis());
      if(opcode == 0x8){ aud1WsParser.reset(); AudioDisconnectWs(); return; }
      if(opcode == 0x2){
        aud1AcceptTxPacket(payload, length);
        // Once keyed, drain according to elapsed monotonic time between every
        // received packet. Before keying, start as soon as the full prebuffer
        // is present but do not fault while queued bytes remain to be parsed.
        size_t required = (aud1TxPrebufferSamples + 5) / 6;
        if(aud1TxState == AUD1_TX_STREAM ||
           ((aud1TxState == AUD1_TX_READY || aud1TxState == AUD1_TX_PREBUFFER) &&
            aud1TxExpectedSample >= aud1TxPrebufferSamples && aud1TxUsed >= required))
          aud1TxTick(true);
      }else if(opcode == 0x1){
        payload[length] = 0;
        aud1HandleControl(String((char*)payload));
      }
      aud1WsParser.reset();
    }
  }

  // If a frame/backlog straddles the exact slot boundary, defer only the
  // missing-prebuffer decision (never PTT safety or an active-stream drain).
  bool rxPending = aud1WsParser.inProgress() || AudioWsClient.available() > 0;
  aud1TxTick(rxPending);
  // bound RX audio latency: flush the coalesce buffer at least every ~100 ms
  static uint32_t lastFlush = 0;
  if(millis() - lastFlush >= 100){ audioFlush(); lastFlush = millis(); }
  audioDrainWs();   // push queued frames (incl. those enqueued from the LAN path)
  // One health line a minute while audio flows. holes = what actually reached
  // the browser as silence after the retransmit chase; ringDrop = RX queue
  // overflow (a loop stall longer than ~1.3 s); wsDrop = browser socket
  // backpressure; rtx = the chase itself (asked outer seqs, holes healed by a
  // replay, head-of-line holds given up). All per WS session except rtx and
  // ringDrop, which reset with the LAN audio channel.
  if(millis() - audioHealthLastMs >= 60000){
    audioHealthLastMs = millis();
    if(audioRxPackets){
      IcomLanClient *healthClient = lanRadioClient();
      Serial.print("AUD | health rx="); Serial.print(audioRxPackets);
      Serial.print(" holes="); Serial.print(audioSeqGapEvents);
      Serial.print("/"); Serial.print(audioSeqGapPackets);
      Serial.print("pkt ringDrop="); Serial.print(healthClient ? healthClient->audioRxDropped() : 0);
      Serial.print(" wsDrop="); Serial.print(audioWsDropFrames);
      Serial.print(" rtx asked="); Serial.print(healthClient ? healthClient->audioRtxRequested() : 0);
      Serial.print(" got="); Serial.print(healthClient ? healthClient->audioRtxRecovered() : 0);
      Serial.print(" gaveup="); Serial.println(healthClient ? healthClient->audioRtxAbandoned() : 0);
    }
  }
}

void audioHandleRawClient(){
  WiFiClient client = audioWsServer.available();
  if(!client) return;
  String request = "";
  unsigned long timeout = millis() + 2000;
  while(client.connected() && millis() < timeout){
    while(client.available()){
      char c = client.read();
      request += c;
      if(request.endsWith("\r\n\r\n")) goto audioDone;
    }
    delay(1);
  }
  audioDone:
  int uriStart = request.indexOf(' ') + 1;
  int uriEnd   = request.indexOf(' ', uriStart);
  String uri   = request.substring(uriStart, uriEnd);
  // The session token rides in the query string: a browser cannot set headers on
  // a WebSocket handshake.
  String token;
  int queryAt = uri.indexOf('?');
  if(queryAt >= 0){
    String query = uri.substring(queryAt + 1);
    uri = uri.substring(0, queryAt);
    int keyAt = query.indexOf("token=");
    if(keyAt >= 0){
      int valueAt = keyAt + 6, endAt = query.indexOf('&', valueAt);
      token = query.substring(valueAt, endAt < 0 ? query.length() : endAt);
    }
  }
  if(uri != "/audiows"){
    client.println(F("HTTP/1.1 404 Not Found\r\nConnection: close\r\n"));
    client.stop();
    return;
  }
  if(!AudioHandleWsUpgrade(client, request, token)){
    client.stop();
  }
  // on success, client is stored in AudioWsClient — do NOT stop it
}
