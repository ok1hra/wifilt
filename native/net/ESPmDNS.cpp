#include "ESPmDNS.h"

#include "WiFi.h"
#include "socket_compat.h"

#include <string.h>

#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

MDNSResponder MDNS;

// ---------------------------------------------------------------------------
// A small multicast-DNS responder.
//
// WHY THIS IS NOT OPTIONAL
//   IndexedDB is scoped per origin, so http://wifilt.local is the only address
//   at which an operator's QSO log, settings and localStorage survive the move
//   from the hardware box to this binary. Without a working name the binary is
//   reachable only by IP -- a different origin, and an empty logbook.
//
// COEXISTING WITH THE SYSTEM RESPONDER
//   Linux desktops normally run Avahi, which already holds UDP 5353. Both
//   SO_REUSEADDR and SO_REUSEPORT are set so this can bind alongside it and
//   still receive the multicast group; Avahi answers for names it owns, this
//   answers for wifilt.local, and neither sees the other's names. macOS behaves
//   the same way with mDNSResponder. Windows has no system responder to share
//   with, and none is needed.
//
// SCOPE
//   Answers A queries for <hostname>.local and the service records for the
//   ports registered with addService(). It does not do probing or conflict
//   resolution: if two WIFILT instances run on one network they will both claim
//   the name, which is why a collision is worth detecting elsewhere rather than
//   silently renaming.
// ---------------------------------------------------------------------------

namespace {

const char *MDNS_GROUP = "224.0.0.251";
const uint16_t MDNS_PORT = 5353;
const uint32_t RECORD_TTL = 120;

// DNS record types.
const uint16_t TYPE_A = 1;
const uint16_t TYPE_PTR = 12;
const uint16_t TYPE_TXT = 16;
const uint16_t TYPE_SRV = 33;
const uint16_t TYPE_ANY = 255;

// Class IN, with the cache-flush bit set on answers so stale entries elsewhere
// are replaced rather than merged.
const uint16_t CLASS_IN = 1;
const uint16_t CLASS_IN_FLUSH = 0x8001;

// RFC 6762 section 6.7: a reply to a legacy (one-shot, unicast) query must look
// like conventional DNS. The cache-flush bit is an mDNS invention -- to an
// ordinary resolver class 0x8001 simply is not IN, so it drops the record and
// the name fails to resolve, which is the very thing the unicast path exists to
// fix. The same section caps the TTL at ten seconds, because a legacy client
// has no way to hear the goodbye or the next announcement; at 120 s a DHCP
// change would leave the name pointing at a dead address for two minutes.
const uint32_t LEGACY_TTL = 10;

struct AnswerStyle {
  uint16_t flushClass;   // for records that own their name
  uint16_t sharedClass;  // for shared records (PTR)
  uint32_t ttl;
};
const AnswerStyle MULTICAST_ANSWER{CLASS_IN_FLUSH, CLASS_IN, RECORD_TTL};
const AnswerStyle LEGACY_ANSWER{CLASS_IN, CLASS_IN, LEGACY_TTL};

struct Service {
  std::string type;      // "_http._tcp.local"
  uint16_t    port;
};

std::mutex              stateLock;
std::string             gHostname;        // "wifilt"
std::string             gInstance;        // "IC-705 Interface"
std::vector<Service>    gServices;
std::atomic<bool>       gRunning{false};
std::thread             gThread;
wifilt_socket_t         gSocket = WIFILT_INVALID_SOCKET;

// --- name encoding ---------------------------------------------------------

void appendName(std::vector<uint8_t> &out, const std::string &dotted) {
  size_t start = 0;
  while (start < dotted.size()) {
    size_t dot = dotted.find('.', start);
    if (dot == std::string::npos) dot = dotted.size();
    const size_t length = dot - start;
    if (length == 0 || length > 63) break;
    out.push_back((uint8_t)length);
    out.insert(out.end(), dotted.begin() + start, dotted.begin() + dot);
    start = dot + 1;
  }
  out.push_back(0);
}

// Reads a (possibly compressed) name into dotted form. Returns the offset just
// past the name in the packet, or 0 on a malformed one.
size_t readName(const uint8_t *packet, size_t length, size_t offset,
                std::string &out) {
  size_t cursor = offset;
  size_t afterPointer = 0;
  int hops = 0;

  while (cursor < length) {
    const uint8_t label = packet[cursor];
    if (label == 0) {
      cursor++;
      return afterPointer ? afterPointer : cursor;
    }
    if ((label & 0xC0) == 0xC0) {
      if (cursor + 1 >= length || ++hops > 8) return 0;
      if (!afterPointer) afterPointer = cursor + 2;
      cursor = ((size_t)(label & 0x3F) << 8) | packet[cursor + 1];
      continue;
    }
    if (cursor + 1 + label > length) return 0;
    if (!out.empty()) out += '.';
    out.append((const char *)packet + cursor + 1, label);
    cursor += 1 + label;
  }
  return 0;
}

bool sameName(const std::string &a, const std::string &b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); i++) {
    char x = a[i], y = b[i];
    if (x >= 'A' && x <= 'Z') x += 32;
    if (y >= 'A' && y <= 'Z') y += 32;
    if (x != y) return false;
  }
  return true;
}

// --- answer building -------------------------------------------------------

void appendRecordHeader(std::vector<uint8_t> &out, const std::string &name,
                        uint16_t type, uint16_t klass, uint32_t ttl) {
  appendName(out, name);
  out.push_back(type >> 8);  out.push_back(type & 0xFF);
  out.push_back(klass >> 8); out.push_back(klass & 0xFF);
  out.push_back(ttl >> 24);  out.push_back((ttl >> 16) & 0xFF);
  out.push_back((ttl >> 8) & 0xFF); out.push_back(ttl & 0xFF);
}

void appendA(std::vector<uint8_t> &out, const std::string &host, uint32_t ip,
             const AnswerStyle &style) {
  appendRecordHeader(out, host, TYPE_A, style.flushClass, style.ttl);
  out.push_back(0); out.push_back(4);
  out.push_back(ip & 0xFF);
  out.push_back((ip >> 8) & 0xFF);
  out.push_back((ip >> 16) & 0xFF);
  out.push_back((ip >> 24) & 0xFF);
}

void appendPtr(std::vector<uint8_t> &out, const std::string &service,
               const std::string &instance, const AnswerStyle &style) {
  appendRecordHeader(out, service, TYPE_PTR, style.sharedClass, style.ttl);
  std::vector<uint8_t> target;
  appendName(target, instance);
  out.push_back(target.size() >> 8); out.push_back(target.size() & 0xFF);
  out.insert(out.end(), target.begin(), target.end());
}

void appendSrv(std::vector<uint8_t> &out, const std::string &instance,
               uint16_t port, const std::string &host,
               const AnswerStyle &style) {
  appendRecordHeader(out, instance, TYPE_SRV, style.flushClass, style.ttl);
  std::vector<uint8_t> body;
  body.push_back(0); body.push_back(0);            // priority
  body.push_back(0); body.push_back(0);            // weight
  body.push_back(port >> 8); body.push_back(port & 0xFF);
  appendName(body, host);
  out.push_back(body.size() >> 8); out.push_back(body.size() & 0xFF);
  out.insert(out.end(), body.begin(), body.end());
}

void appendTxt(std::vector<uint8_t> &out, const std::string &instance,
               const AnswerStyle &style) {
  appendRecordHeader(out, instance, TYPE_TXT, style.flushClass, style.ttl);
  out.push_back(0); out.push_back(1);
  out.push_back(0);                                 // one empty string
}

std::string hostFqdn() { return gHostname + ".local"; }

std::string instanceFqdn(const Service &service) {
  const std::string label = gInstance.empty() ? gHostname : gInstance;
  return label + "." + service.type;
}

// unicastTo == nullptr sends to the multicast group; otherwise straight back to
// the asker. Both are needed -- see the legacy-query note in handleQuery().
void sendPacket(const std::vector<uint8_t> &packet,
                const struct sockaddr_in *unicastTo = nullptr) {
  if (gSocket == WIFILT_INVALID_SOCKET || packet.empty()) return;

  // Zeroed on every path, not only the multicast one: the unicast copy comes
  // from a sockaddr filled in by recvfrom, and nothing here guarantees it wrote
  // the whole struct. Handing stack residue to sendto is not worth saving a
  // memset.
  struct sockaddr_in destination;
  memset(&destination, 0, sizeof(destination));
  if (unicastTo) {
    destination.sin_family = AF_INET;
    destination.sin_port = unicastTo->sin_port;
    destination.sin_addr = unicastTo->sin_addr;
  } else {
    destination.sin_family = AF_INET;
    destination.sin_port = htons(MDNS_PORT);
    destination.sin_addr.s_addr = inet_addr(MDNS_GROUP);
  }
  ::sendto(gSocket, (const char *)packet.data(), (int)packet.size(), 0,
           (struct sockaddr *)&destination, sizeof(destination));
}

// Builds every record we own -- used both for answers and for the unsolicited
// announcement sent at startup.
std::vector<uint8_t> buildAnnouncement(uint32_t ip) {
  std::vector<uint8_t> body;
  uint16_t answers = 0;

  appendA(body, hostFqdn(), ip, MULTICAST_ANSWER);
  answers++;
  for (const Service &service : gServices) {
    const std::string instance = instanceFqdn(service);
    appendPtr(body, service.type, instance, MULTICAST_ANSWER);
    appendSrv(body, instance, service.port, hostFqdn(), MULTICAST_ANSWER);
    appendTxt(body, instance, MULTICAST_ANSWER);
    answers += 3;
  }

  std::vector<uint8_t> packet;
  packet.push_back(0); packet.push_back(0);          // transaction id
  packet.push_back(0x84); packet.push_back(0x00);    // response, authoritative
  packet.push_back(0); packet.push_back(0);          // questions
  packet.push_back(answers >> 8); packet.push_back(answers & 0xFF);
  packet.push_back(0); packet.push_back(0);          // authority
  packet.push_back(0); packet.push_back(0);          // additional
  packet.insert(packet.end(), body.begin(), body.end());
  return packet;
}

// A "legacy" (one-shot) query is one whose source port is not 5353: an ordinary
// resolver asking from an ephemeral port, which is what glibc's nss-mdns does
// for every getent/curl/browser lookup. RFC 6762 section 6.7 is the rule for
// those: answer UNICAST to that port, and make the reply look like conventional
// DNS -- same transaction ID, question section echoed, no cache-flush bit, TTL
// capped at ten seconds.
//
// NOT section 5.4, which is the QU (unicast-response-requested) bit in the top
// of the question's class field. This code does not read that bit, so a
// conformant querier on port 5353 asking for a unicast answer -- what a first
// query after joining a network does -- still gets a multicast one. That is
// merely suboptimal rather than broken, since it is listening on the group.
//
// Answering only on multicast, as this did at first, is invisible to such a
// client: it never joined the group. The name still resolved eventually, from a
// periodic announcement that happened to land, which is why the symptom was
// "wifilt.local works but takes ten to twenty seconds" rather than "does not
// resolve" -- far more confusing than a clean failure.
void handleQuery(const uint8_t *packet, size_t length, uint32_t ip,
                 const struct sockaddr_in *from) {
  if (length < 12) return;
  const uint16_t flags = (packet[2] << 8) | packet[3];
  if (flags & 0x8000) return;                        // a response, not a query
  const uint16_t questions = (packet[4] << 8) | packet[5];
  if (!questions) return;

  // RFC 6762 section 11: anything not from a directly attached link is ignored
  // outright. Without this the unicast reply path below turns the responder
  // into an off-path reflector -- a small spoofed query becomes a much larger
  // reply aimed at whoever the source address named. The multicast path never
  // had that exposure because its answer could not leave the link.
  if (from && !nativeAddressIsOnLocalLink(from->sin_addr.s_addr)) return;

  const bool legacy = from && ntohs(from->sin_port) != MDNS_PORT;
  const uint16_t transactionId = legacy ? ((packet[0] << 8) | packet[1]) : 0;
  const AnswerStyle &style = legacy ? LEGACY_ANSWER : MULTICAST_ANSWER;

  std::vector<uint8_t> body;
  uint16_t answers = 0;
  size_t offset = 12;
  // Counted, not assumed: the loop can stop early on a truncated packet, and a
  // legacy reply echoes the questions it actually parsed. Copying the query's
  // QDCOUNT instead produced a header claiming more questions than the body
  // carried, which walks the reader straight into the answer section.
  uint16_t parsed = 0;

  for (uint16_t i = 0; i < questions && offset < length; i++) {
    std::string name;
    const size_t next = readName(packet, length, offset, name);
    // break, not return: answers already matched for earlier questions are
    // still valid and worth sending. Returning threw them away and left the
    // querier with silence.
    if (!next || next + 4 > length) break;
    offset = next;
    const uint16_t type = (packet[offset] << 8) | packet[offset + 1];
    offset += 4;                                     // type + class
    parsed++;

    if ((type == TYPE_A || type == TYPE_ANY) && sameName(name, hostFqdn())) {
      appendA(body, hostFqdn(), ip, style);
      answers++;
      continue;
    }
    for (const Service &service : gServices) {
      const std::string instance = instanceFqdn(service);
      if ((type == TYPE_PTR || type == TYPE_ANY) && sameName(name, service.type)) {
        appendPtr(body, service.type, instance, style);
        appendSrv(body, instance, service.port, hostFqdn(), style);
        appendTxt(body, instance, style);
        appendA(body, hostFqdn(), ip, style);
        answers += 4;
      } else if ((type == TYPE_SRV || type == TYPE_ANY) && sameName(name, instance)) {
        appendSrv(body, instance, service.port, hostFqdn(), style);
        appendA(body, hostFqdn(), ip, style);
        answers += 2;
      }
    }
  }

  if (!answers) return;

  std::vector<uint8_t> response;
  response.push_back(transactionId >> 8);
  response.push_back(transactionId & 0xFF);
  response.push_back(0x84); response.push_back(0x00);
  // A legacy reply repeats the question it answers; a multicast one carries no
  // question section at all.
  const uint16_t echoed = legacy ? parsed : 0;
  response.push_back(echoed >> 8); response.push_back(echoed & 0xFF);
  response.push_back(answers >> 8); response.push_back(answers & 0xFF);
  response.push_back(0); response.push_back(0);
  response.push_back(0); response.push_back(0);
  if (legacy) response.insert(response.end(), packet + 12, packet + offset);
  response.insert(response.end(), body.begin(), body.end());

  sendPacket(response, legacy ? from : nullptr);
}

void responderThread() {
  uint32_t announcedIp = 0;
  int announcementsLeft = 3;                          // repeat, as RFC 6762 asks
  uint32_t nextAnnounce = 0;

  while (gRunning.load()) {
    const uint32_t ip = (uint32_t)WiFi.localIP();

    // Re-announce when the address changes: a stale registration is most of the
    // "mDNS works sometimes" experience.
    if (ip && ip != announcedIp) {
      announcedIp = ip;
      announcementsLeft = 3;
      nextAnnounce = 0;
    }

    if (ip && announcementsLeft > 0 && millis() >= nextAnnounce) {
      std::lock_guard<std::mutex> guard(stateLock);
      sendPacket(buildAnnouncement(ip));
      announcementsLeft--;
      nextAnnounce = millis() + 1000;
    }

    fd_set readable;
    FD_ZERO(&readable);
    FD_SET(gSocket, &readable);
    struct timeval timeout;
    timeout.tv_sec = 0;
    timeout.tv_usec = 250 * 1000;
    if (select((int)gSocket + 1, &readable, nullptr, nullptr, &timeout) <= 0)
      continue;

    uint8_t packet[1500];
    struct sockaddr_in from;
    memset(&from, 0, sizeof(from));
    socklen_t fromLength = sizeof(from);
    const int received = (int)::recvfrom(gSocket, (char *)packet, sizeof(packet), 0,
                                         (struct sockaddr *)&from, &fromLength);
    if (received <= 0 || !ip) continue;

    std::lock_guard<std::mutex> guard(stateLock);
    handleQuery(packet, (size_t)received, ip, &from);
  }
}

}  // namespace

bool MDNSResponder::begin(const char *name) {
  end();

  hostname = name ? name : "";
  if (hostname.length() == 0) return false;

  gSocket = ::socket(AF_INET, SOCK_DGRAM, 0);
  if (gSocket == WIFILT_INVALID_SOCKET) return false;

  // Both options, deliberately: SO_REUSEADDR alone is not enough on the BSDs
  // and macOS to share 5353 with the system responder, and SO_REUSEPORT does
  // not exist on Windows.
  int reuse = 1;
  setsockopt(gSocket, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuse, sizeof(reuse));
#ifdef SO_REUSEPORT
  setsockopt(gSocket, SOL_SOCKET, SO_REUSEPORT, (const char *)&reuse, sizeof(reuse));
#endif

  struct sockaddr_in local;
  memset(&local, 0, sizeof(local));
  local.sin_family = AF_INET;
  local.sin_addr.s_addr = htonl(INADDR_ANY);
  local.sin_port = htons(MDNS_PORT);
  if (::bind(gSocket, (struct sockaddr *)&local, sizeof(local)) != 0) {
    WIFILT_CLOSE_SOCKET(gSocket);
    gSocket = WIFILT_INVALID_SOCKET;
    return false;
  }

  struct ip_mreq group;
  memset(&group, 0, sizeof(group));
  group.imr_multiaddr.s_addr = inet_addr(MDNS_GROUP);
  group.imr_interface.s_addr = htonl(INADDR_ANY);
  if (setsockopt(gSocket, IPPROTO_IP, IP_ADD_MEMBERSHIP, (const char *)&group,
                 sizeof(group)) != 0) {
    WIFILT_CLOSE_SOCKET(gSocket);
    gSocket = WIFILT_INVALID_SOCKET;
    return false;
  }

  unsigned char ttl = 255;                            // RFC 6762 requires 255
  setsockopt(gSocket, IPPROTO_IP, IP_MULTICAST_TTL, (const char *)&ttl, sizeof(ttl));

  {
    std::lock_guard<std::mutex> guard(stateLock);
    gHostname = hostname.c_str();
    gInstance.clear();
    gServices.clear();
  }

  gRunning.store(true);
  gThread = std::thread(responderThread);
  publishing = true;
  return true;
}

void MDNSResponder::end() {
  if (!gRunning.load() && gSocket == WIFILT_INVALID_SOCKET) return;
  gRunning.store(false);
  if (gThread.joinable()) gThread.join();
  if (gSocket != WIFILT_INVALID_SOCKET) {
    WIFILT_CLOSE_SOCKET(gSocket);
    gSocket = WIFILT_INVALID_SOCKET;
  }
  publishing = false;
}

void MDNSResponder::setInstanceName(const String &name) {
  instanceName = name;
  std::lock_guard<std::mutex> guard(stateLock);
  gInstance = name.c_str();
}

bool MDNSResponder::addService(const char *service, const char *protocol,
                               uint16_t port) {
  if (!service || !protocol) return false;
  std::string type = std::string("_") + service + "._" + protocol + ".local";
  std::lock_guard<std::mutex> guard(stateLock);
  for (const Service &existing : gServices)
    if (existing.type == type && existing.port == port) return true;
  gServices.push_back({type, port});
  return true;
}
