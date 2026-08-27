// Node-callable host bridging the ARQ FSM (unmodified: arq_fsm.c,
// arq_protocol.c, arith.c, arq_timing.c) to the real freedv modem
// (unmodified freedv sources, same trim list as build-wasm.sh) -- the
// docs/mercury-implementace.md ch.10 E1 deliverable "Node host se
// vzorkovými hodinami" (Node host with a sample clock), replacing
// mercury/tests/sim/sim_channel.c's abstract erasure-probability model with
// a real modulate/demodulate round trip through freedv_rawdatatx/rawdatarx.
//
// Reused unmodified from mercury/tests/sim/: sim_endpoint.c (FSM callback
// table + per-endpoint outframe queue/delivered-bytes buffer), sim_clock.c
// (thin wrapper over common/virtual_clock.c), sim_translate.c (wire bytes ->
// arq_event_t, including CALL/ACCEPT DST-CRC and DATA seq validation).
//
// JS owns the event loop and the (currently notional -- no packet loss/noise
// yet, see README "Next") sample clock; this file only exposes narrow,
// primitive-typed entry points so cwrap doesn't need struct marshalling.
// Frame BYTES cross the WASM boundary as pointers (JS reads/writes WASM
// linear memory directly via HEAPU8); PCM samples never cross it at all --
// host_modem_relay() encodes and decodes in the same call, entirely inside
// WASM, which is honest for proving ARQ+modem correctness end to end (this
// step's goal) without yet building the real per-sample audio transport
// that talking to a browser AUD1 socket will need (an E2 concern).
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <limits.h>
#include <emscripten.h>

#include "arq_fsm.h"
#include "sim_endpoint.h"
#include "sim_translate.h"
#include "sim_clock.h"
#include "arq_timing.h"
#include "freedv_api.h"

/* ---- one-time setup ---- */

static bool g_inited = false;
static arq_timing_ctx_t g_timing;

EMSCRIPTEN_KEEPALIVE
void host_init(void) {
  if (g_inited) return;
  arq_timing_init(&g_timing);
  arq_fsm_set_callbacks(sim_endpoint_callbacks());
  arq_fsm_set_timing(&g_timing);
  sim_clock_reset(1000); /* matches sim_core.c: never let a FSM see a 0-time deadline */
  g_inited = true;
}

/* ---- endpoints ---- */

EMSCRIPTEN_KEEPALIVE
sim_endpoint_t *host_endpoint_create(const char *my_call, const char *peer_call) {
  return sim_endpoint_create(my_call, peer_call);
}

EMSCRIPTEN_KEEPALIVE
void host_dispatch_simple(sim_endpoint_t *ep, int event_id) {
  arq_event_t ev = {0};
  ev.id = (arq_event_id_t)event_id;
  sim_endpoint_set_active(ep);
  arq_fsm_dispatch(sim_endpoint_session(ep), &ev);
}

/* ARQ_EV_APP_CONNECT needs remote_call filled (see mercury/tests/sim/
 * test_arq_sim.c's make_connected()) -- unlike LISTEN/DATA_READY/DISCONNECT,
 * which carry no payload fields. */
EMSCRIPTEN_KEEPALIVE
void host_connect(sim_endpoint_t *ep, const char *remote_call) {
  arq_event_t ev = { .id = ARQ_EV_APP_CONNECT };
  snprintf(ev.remote_call, sizeof(ev.remote_call), "%s", remote_call);
  sim_endpoint_set_active(ep);
  arq_fsm_dispatch(sim_endpoint_session(ep), &ev);
}

EMSCRIPTEN_KEEPALIVE
void host_queue_tx(sim_endpoint_t *ep, const uint8_t *data, int len) {
  sim_endpoint_queue_tx(ep, data, (size_t)len);
}

EMSCRIPTEN_KEEPALIVE
int host_delivered(sim_endpoint_t *ep, uint8_t *out, int cap) {
  return (int)sim_endpoint_delivered(ep, out, (size_t)cap);
}

EMSCRIPTEN_KEEPALIVE
int host_conn_state(sim_endpoint_t *ep) { return (int)sim_endpoint_session(ep)->conn_state; }

EMSCRIPTEN_KEEPALIVE
int host_dflow_state(sim_endpoint_t *ep) { return (int)sim_endpoint_session(ep)->dflow_state; }

EMSCRIPTEN_KEEPALIVE
int host_payload_mode(sim_endpoint_t *ep) { return sim_endpoint_session(ep)->payload_mode; }

/* The mode to set the RX demodulator to when actually expecting a DATA
 * frame (dflow_state == ARQ_DFLOW_IDLE_IRS, value 3): "mode peer last TX'd
 * in = my payload RX decoder mode when IRS; updated from ev->mode on every
 * DATA frame" (arq_fsm.h's own comment). Every OTHER dflow state expects a
 * control-mode (DATAC16) frame -- CALL, ACCEPT, ACK, the TURN and MODE
 * handshakes, and KEEPALIVE all live on control_mode, never payload_mode.
 * A Worker-side RX pump uses this plus host_dflow_state() to follow a real
 * mode-negotiated data phase instead of assuming control mode forever. */
EMSCRIPTEN_KEEPALIVE
int host_peer_tx_mode(sim_endpoint_t *ep) { return sim_endpoint_session(ep)->peer_tx_mode; }

/* doc §6.2's connection-test screen: "SNR RX +4 dB / TX +2 dB" is exactly
 * these two session fields, already tracked by the unmodified FSM --
 * local_snr_x10 is our own EMA of what we hear from the peer (their TX,
 * our RX), peer_snr_x10/peer_snr_valid is what the peer's own header told
 * us THEY measured hearing from us (our TX, their RX) -- no new tracking,
 * just exposing what arq_fsm.c already maintains. */
EMSCRIPTEN_KEEPALIVE
int host_local_snr_x10(sim_endpoint_t *ep) { return sim_endpoint_session(ep)->local_snr_x10; }

EMSCRIPTEN_KEEPALIVE
int host_peer_snr_x10(sim_endpoint_t *ep) { return sim_endpoint_session(ep)->peer_snr_x10; }

EMSCRIPTEN_KEEPALIVE
int host_peer_snr_valid(sim_endpoint_t *ep) { return sim_endpoint_session(ep)->peer_snr_valid ? 1 : 0; }

/* Diagnostic-only: the two sequence counters that decide whether an
 * incoming DATA frame gets delivered (deliver_rx_checked() in arq_fsm.c
 * requires ev->seq == rx_expected, else it silently logs a suppressed
 * "duplicate" at HLOGD -- a level this WASM build never surfaces to the
 * browser) or gets ACKed as sent (tx_seq/tx_window in arq_fsm.c's WAIT_ACK
 * handling). Added to chase a real, observed split: the ISS side declared
 * a whole file "delivered" (dflow returned to idle after backlog drained)
 * while the IRS side's own delivered-byte count never grew past the first
 * message -- these two counters are the only way to tell, from outside the
 * FSM, whether frames after that point were ever actually accepted. */
EMSCRIPTEN_KEEPALIVE
int host_rx_expected(sim_endpoint_t *ep) { return (int)sim_endpoint_session(ep)->rx_expected; }

EMSCRIPTEN_KEEPALIVE
int host_tx_seq(sim_endpoint_t *ep) { return (int)sim_endpoint_session(ep)->tx_seq; }

/* docs/mercury-implementace.md §6.5 (live STATUS panel): consecutive_retries
 * and tx_success_count are STREAKS, not cumulative session totals -- both
 * reset to 0 on the opposite outcome (record_tx_outcome() in arq_fsm.c).
 * The Worker watches these three read-only getters tick and reconstructs its
 * own session-lifetime retry/success tally from the deltas (a 0->positive
 * transition on consecutive_retries is one retry; a tx_seq advance while
 * consecutive_retries stays 0 is one clean delivery) -- deliberately no new
 * accumulator field was added to arq_session_t itself, to keep this feature
 * out of the FSM's own hot path entirely (see mercury-status-plan memory). */
EMSCRIPTEN_KEEPALIVE
int host_consecutive_retries(sim_endpoint_t *ep) { return sim_endpoint_session(ep)->consecutive_retries; }

EMSCRIPTEN_KEEPALIVE
int host_tx_success_count(sim_endpoint_t *ep) { return sim_endpoint_session(ep)->tx_success_count; }

EMSCRIPTEN_KEEPALIVE
int host_tx_retries_left(sim_endpoint_t *ep) { return sim_endpoint_session(ep)->tx_retries_left; }

/* The real caller's callsign once a CALL is accepted -- arq_session_t's own
 * remote_call, not sim_endpoint_t's construction-time peer_call (which for a
 * LISTEN role is empty until someone actually dials in, and would stay
 * wrong for the rest of the session otherwise). Needed so a receiver can key
 * its resume store (data/mercury-file.js's ResumeStore) on who the file is
 * actually coming from, not "whoever we thought we might hear from". Backed
 * by a fixed CALLSIGN_MAX_SIZE array inside the session struct, so the
 * pointer stays valid as long as `ep` does -- safe for cwrap's "string"
 * return (copies the bytes out immediately). */
EMSCRIPTEN_KEEPALIVE
const char *host_peer_call(sim_endpoint_t *ep) { return sim_endpoint_session(ep)->remote_call; }

/* arq_protocol.h's own tuning comment on ARQ_CHANNEL_GUARD_MS_DEFAULT (700):
 * "Radio needs ~340ms for TX->RX switch" -- that number is a REFERENCE
 * radio's turnaround, not ours. Real-world testing against two real ICOM
 * radios over LAN (CI-V PTT ON/OFF is an async network round trip, not a
 * direct/VOX line) found exactly the collision pattern this comment warns
 * about at insufficient guard time: real S9+ signal on both ends, yet one
 * side got stuck in ACCEPTING and the other in an endless retry, matching
 * "both radios keying at once" observed directly on the gear. These two
 * values are already meant to be tunable per-radio (arq_protocol.c's own
 * _Atomic int globals, normally set from an INI key on the native CLI) --
 * this just gives the WASM/browser host the same knob, since it has no INI
 * file of its own. Left at the upstream defaults unless a caller raises
 * them explicitly; nothing here changes behavior for anyone who doesn't. */
EMSCRIPTEN_KEEPALIVE
void host_set_channel_guard_ms(int ms) { atomic_store(&arq_channel_guard_ms, ms); }

EMSCRIPTEN_KEEPALIVE
void host_set_iss_post_ack_guard_ms(int ms) { atomic_store(&arq_iss_post_ack_guard_ms, ms); }

/* arq_protocol.h's own comment on ARQ_DATA_RETRY_JITTER_PCT has the full
 * story: the DATA-phase WAIT_ACK retry loop had the exact same missing-
 * jitter problem CALL/ACCEPT did (fixed above), just never noticed until a
 * live two-station transfer's own resume-query REPLY and the peer's real
 * DATA_TX collided on every identical, unjittered retry for the length of
 * the test. 0 (default) = off, unreachable by native unit/sim tests. */
EMSCRIPTEN_KEEPALIVE
void host_set_data_retry_jitter_pct(int pct) { atomic_store(&arq_data_retry_jitter_pct, pct); }

/* docs/mercury-implementace.md §6.6 (Settings): thin exports over atomics
 * that already exist and are already unit-tested (native `mercury`'s own
 * RETRIES/CALLINT TCP commands drive the same four fields via
 * tcp_interfaces.c -- a path this WASM build never links in, since the FSM
 * here is wired directly through this shim). No new FSM logic; each setter
 * is a direct atomic_store, applied once by mercury-worker.js before the
 * first event of a new CALL/LISTEN session (never mid-session). Values are
 * not range-checked here -- same trust boundary as host_set_channel_guard_ms
 * above; mercury.js's Settings UI is where sane ranges/defaults live. */
EMSCRIPTEN_KEEPALIVE
void host_set_retry_slots(int call_slots, int accept_slots, int data_slots, int disconnect_slots) {
  atomic_store(&arq_call_retry_slots, call_slots);
  atomic_store(&arq_accept_retry_slots, accept_slots);
  atomic_store(&arq_data_retry_slots, data_slots);
  atomic_store(&arq_disconnect_retry_slots, disconnect_slots);
}

/* seconds; 0 = table default, matching ARQ_CALLINT_DEFAULT_S. Native's own
 * CALLINT command enforces ARQ_CALLINT_MIN_S (4.0) itself on the read side
 * (arq_protocol_call_retry_interval_s()) -- a too-low override here is
 * clamped there, not here. */
EMSCRIPTEN_KEEPALIVE
void host_set_callint(float seconds) { atomic_store(&arq_callint_override_s, seconds); }

EMSCRIPTEN_KEEPALIVE
void host_set_retry_downgrade_threshold(int n) { atomic_store(&arq_retry_downgrade_threshold, n); }

/* Rank per arq_fsm.c's mode_rank(): 0=DATAC15 .. 5=QAM16C2 (arq_protocol.h's
 * own comment on ARQ_MODE_CEILING_RANK has the full mapping and the
 * DATAC17/QAM16C2 caveat -- they stay hard-blocked by
 * arq_bandwidth_allows_mode() regardless of what is set here, since this
 * WASM build's freedv modem does not have either compiled in). */
EMSCRIPTEN_KEEPALIVE
void host_set_mode_ceiling_rank(int rank) { atomic_store(&arq_mode_ceiling_rank, rank); }

/* ---- CQ (docs/mercury-implementace.md ch.10's E4 gate, last item) ----
 *
 * CQ is deliberately NOT an arq_fsm_dispatch() event: it carries no
 * session_id, has no reply, and can be sent/heard in ANY connection state
 * (LISTENING, CALLING, even mid-transfer) -- arq_protocol_build_cq()/
 * parse_cq() (arq_protocol.c, already linked, upstream-unmodified) are
 * completely independent of arq_session_t. So this bypasses
 * arq_fsm_dispatch()/host_deliver() entirely on both ends: TX builds the
 * compact 14-byte frame into its own buffer for the caller to stream
 * exactly like any other outframe; RX must be routed here BEFORE
 * host_deliver() ever sees the bytes -- sim_translate_frame() has no
 * PACKET_TYPE_ARQ_CQ case and falls through to the DATA/CONTROL 8-byte
 * header path (CQ's 14 bytes clears that length check), which would
 * decode nonsense into a real arq_event_t and feed it to the FSM. The
 * packet-type byte itself is 1 byte at frame[0] -- callers check it
 * (bits [7:5], PACKET_TYPE_ARQ_CQ=0x05, see modem/framer.h) before
 * deciding which path to take. */

static uint8_t g_cq_tx_buf[32];
static int g_cq_tx_len = 0;
static char g_cq_rx_call[CALLSIGN_MAX_SIZE];
static int g_cq_rx_bw_hz = 0;

/* Builds a CQ frame from this station's own callsign into a buffer the
 * caller streams exactly like any TX burst; returns the frame length
 * (always ARQ_CONTROL_FRAME_SIZE=14) or -1 (unencodable callsign or
 * unsupported bandwidth -- see arq_protocol_bw_token_from_hz()). */
EMSCRIPTEN_KEEPALIVE
int host_cq_tx_prepare(const char *my_call, int bw_hz) {
  g_cq_tx_len = arq_protocol_build_cq(g_cq_tx_buf, sizeof(g_cq_tx_buf), my_call, bw_hz);
  return g_cq_tx_len;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *host_cq_tx_ptr(void) { return g_cq_tx_buf; }

/* The packet_type a caller must check (frame[0] bits [7:5]) before
 * routing a decoded control-mode frame to either host_deliver() or
 * host_cq_rx_parse() below. Mirrors modem/framer.h's own
 * frame_header_packet_type() so JS never has to hand-roll the bit math. */
EMSCRIPTEN_KEEPALIVE
int host_frame_packet_type(const uint8_t *frame, int frame_len) {
  if (!frame || frame_len < 1) return -1;
  return (frame[0] >> 5) & 0x07;
}

/* Parses a decoded frame already confirmed (via host_frame_packet_type())
 * to be a CQ frame. Returns 1 on success (host_cq_rx_call()/
 * host_cq_rx_bw_hz() readable until the next call), 0 on a malformed
 * frame (corrupt decode, not this station's own echo -- callers should
 * just drop it, same as any other failed decode). */
EMSCRIPTEN_KEEPALIVE
int host_cq_rx_parse(const uint8_t *frame, int frame_len) {
  int rc = arq_protocol_parse_cq(frame, (size_t)frame_len, g_cq_rx_call, &g_cq_rx_bw_hz);
  return rc >= 0 ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
const char *host_cq_rx_call(void) { return g_cq_rx_call; }

EMSCRIPTEN_KEEPALIVE
int host_cq_rx_bw_hz(void) { return g_cq_rx_bw_hz; }

/* ---- outframe queue (FSM -> "modem") ---- */

static sim_outframe_t g_of;

/* Returns 1 if an outframe was taken (fields readable via the getters
 * below until the next call), 0 if the queue was empty. */
EMSCRIPTEN_KEEPALIVE
int host_take_outframe(sim_endpoint_t *ep) {
  return sim_endpoint_take_outframe(ep, &g_of) ? 1 : 0;
}
EMSCRIPTEN_KEEPALIVE int host_of_len(void) { return (int)g_of.len; }
EMSCRIPTEN_KEEPALIVE int host_of_mode(void) { return g_of.mode; }
EMSCRIPTEN_KEEPALIVE int host_of_packet_type(void) { return g_of.packet_type; }
EMSCRIPTEN_KEEPALIVE int host_of_burst_remaining(void) { return g_of.burst_remaining; }
EMSCRIPTEN_KEEPALIVE uint8_t *host_of_buf(void) { return g_of.buf; }

/* ---- timers ---- */

EMSCRIPTEN_KEEPALIVE
int host_timeout_ms(sim_endpoint_t *ep, int now_ms) {
  int t = arq_fsm_timeout_ms(sim_endpoint_session(ep), (uint64_t)now_ms);
  return t; /* INT_MAX = idle */
}

static int g_last_deadline_event = -1;

EMSCRIPTEN_KEEPALIVE
int host_last_deadline_event(void) { return g_last_deadline_event; }

/* Mirrors sim_core.c's per-FSM deadline firing. Returns 1 if a deadline was
 * due at now_ms and its event got dispatched, 0 otherwise. */
EMSCRIPTEN_KEEPALIVE
int host_fire_deadline_if_due(sim_endpoint_t *ep, int now_ms) {
  arq_session_t *sess = sim_endpoint_session(ep);
  int t = arq_fsm_timeout_ms(sess, (uint64_t)now_ms);
  if (t == INT_MAX || t > 0) return 0;
  sess->deadline_ms = UINT64_MAX;
  arq_event_t tev = { .id = sess->deadline_event };
  g_last_deadline_event = (int)sess->deadline_event;
  sim_endpoint_set_active(ep);
  arq_fsm_dispatch(sess, &tev);
  return 1;
}

/* ---- virtual clock (thin wrapper over sim_clock.c/common/virtual_clock.c) ---- */

EMSCRIPTEN_KEEPALIVE
int host_clock_now_ms(void) { return (int)sim_clock_now(); }

EMSCRIPTEN_KEEPALIVE
void host_clock_advance_to_ms(int abs_ms) { sim_clock_set((uint64_t)abs_ms); }

/* ---- wire bytes -> FSM event (reuses sim_translate.c unmodified) ---- */

/* rx_snr: stamped SNR (dB) as if the frame had just been decoded off the air.
 * A fixed 12.0 (matching sim_core.c's default) is fine for a clean-channel
 * bench; a future noisy-channel step would derive it from the real freedv
 * decode instead. */
EMSCRIPTEN_KEEPALIVE
int host_deliver(sim_endpoint_t *receiver_ep, const uint8_t *frame, int frame_len, float rx_snr) {
  arq_event_t ev;
  bool ok = sim_translate_frame(frame, (size_t)frame_len, rx_snr,
                                sim_endpoint_call(receiver_ep), &ev);
  if (!ok) return 0;
  sim_endpoint_set_active(receiver_ep);
  arq_fsm_dispatch(sim_endpoint_session(receiver_ep), &ev);
  return 1;
}

/* ---- real modem relay: ARQ frame bytes -> freedv TX -> freedv RX -> bytes ---- */

#define HOST_MAX_SAMPLES 200000
static short g_samples[HOST_MAX_SAMPLES];
static uint8_t g_relay_out[1280];
static int g_last_relay_samples = 0;

EMSCRIPTEN_KEEPALIVE
uint8_t *host_relay_out_ptr(void) { return g_relay_out; }

EMSCRIPTEN_KEEPALIVE
int host_last_relay_samples(void) { return g_last_relay_samples; }

/* Encodes `frame` (frame_len bytes -- must equal this mode's
 * arq_mode_table[].payload, i.e. freedv_get_bits_per_modem_frame(mode)/8 - 2)
 * through a real freedv TX context, immediately demodulates the resulting
 * samples through a second, real freedv RX context (direct in-WASM
 * handoff -- no channel impairment modelled yet), and returns the decoded
 * payload length written to host_relay_out_ptr(), or:
 *   -2  bad mode (freedv_open failed) or frame_len mismatch
 *    0  demodulator never produced a frame inside the burst window
 *   -1  decoded a frame but its length didn't match what was sent
 * host_last_relay_samples() reports the real total burst sample count
 * (silence+preamble+data+postamble) for the caller's airtime/clock math --
 * this is measured from the actual modem, not the sim's airtime formula. */
EMSCRIPTEN_KEEPALIVE
int host_modem_relay(int mode, const uint8_t *frame, int frame_len) {
  g_last_relay_samples = 0;

  struct freedv *tx = freedv_open(mode);
  struct freedv *rx = freedv_open(mode);
  if (!tx || !rx) { if (tx) freedv_close(tx); if (rx) freedv_close(rx); return -2; }
  /* See shim.c's mercury_loopback_test for why this matters: without it,
   * multi-OFDM-frame packets (DATAC15's floor mode included) sync but never
   * emit a decode. */
  freedv_set_frames_per_burst(tx, 1);
  freedv_set_frames_per_burst(rx, 1);

  int bytes_per_frame = freedv_get_bits_per_modem_frame(tx) / 8;
  int payload_bytes = bytes_per_frame - 2;
  if (frame_len != payload_bytes) { freedv_close(tx); freedv_close(rx); return -2; }

  uint8_t *wire = malloc(bytes_per_frame);
  memcpy(wire, frame, payload_bytes);
  unsigned short crc = freedv_gen_crc16((unsigned char *)wire, payload_bytes);
  wire[bytes_per_frame - 2] = (uint8_t)(crc >> 8);
  wire[bytes_per_frame - 1] = (uint8_t)(crc & 0xff);

  int n_data = freedv_get_n_tx_modem_samples(tx); /* see prototype/mercury-prototype/shim.c's
                                                       comment: NOT freedv_get_n_max_modem_samples() --
                                                       that undercounts DATAC1/DATAC3 packets. */
  int n_nom = freedv_get_n_nom_modem_samples(tx);
  int settle = 2 * n_nom;

  short *mod = malloc(sizeof(short) * 2 * n_data);
  int cap = settle + 4 * n_data + settle;
  if (cap > HOST_MAX_SAMPLES) cap = HOST_MAX_SAMPLES; /* generous headroom; DATAC1 (widest enabled mode is
                                                          DATAC3 while gear-shifting is off) fits comfortably */
  memset(g_samples, 0, sizeof(short) * cap);
  int pos = settle;

  int n_pre = freedv_rawdatapreambletx(tx, mod);
  memcpy(g_samples + pos, mod, sizeof(short) * n_pre);
  pos += n_pre;

  freedv_rawdatatx(tx, mod, wire);
  memcpy(g_samples + pos, mod, sizeof(short) * n_data);
  pos += n_data;

  int n_post = freedv_rawdatapostambletx(tx, mod);
  memcpy(g_samples + pos, mod, sizeof(short) * n_post);
  pos += n_post;

  int total = pos + settle;
  g_last_relay_samples = total;

  int result = 0;
  int nin = freedv_nin(rx);
  int off = 0;
  uint8_t rx_bytes[1280];
  while (off + nin <= total) {
    int nbytes = freedv_rawdatarx(rx, rx_bytes, g_samples + off);
    off += nin;
    nin = freedv_nin(rx);
    if (nbytes > 0) {
      if (nbytes == bytes_per_frame) {
        memcpy(g_relay_out, rx_bytes, payload_bytes);
        result = payload_bytes;
      } else {
        result = -1;
      }
      break;
    }
  }

  free(wire); free(mod);
  freedv_close(tx); freedv_close(rx);
  return result;
}

/* ---- streaming TX/RX: for bridging to a REAL external process (native
 * mercury over the -x sock lockstep transport) that exchanges audio in
 * small blocks over many calls, unlike host_modem_relay()'s one-shot
 * in-WASM round trip. See native-interop-smoke.js / run-native-transfer.js. */

#define HOST_STREAM_MAX_SAMPLES 200000

/* -- TX: pre-modulate a whole burst, then let the caller pull it out N
 * samples at a time across many blocks. No leading/trailing silence baked
 * in -- the caller's own idle (all-zero) blocks between bursts already
 * provide that, exactly as real block-by-block audio would. */
static short g_tx_stream[HOST_STREAM_MAX_SAMPLES];
static int g_tx_stream_len = 0;
static int g_tx_stream_pos = 0;

/* Payload byte length (excluding the 2-byte CRC16 host_tx_start appends) a
 * given mode needs -- lets a caller build a correctly-sized dummy frame
 * without duplicating freedv's own frame table. Used by the ch.8 drive
 * calibration to modulate a REAL representative burst (doc's own
 * "never the WSPR tune tone -- Mercury OFDM has 6-10dB more PAPR even after
 * its own clipping" warning) with no ARQ session/peer required: content
 * doesn't matter for calibration, only the mode's real OFDM waveform shape
 * does, so an arbitrary same-sized payload is exactly as valid as a real one. */
EMSCRIPTEN_KEEPALIVE
int host_mode_payload_bytes(int mode) {
  struct freedv *f = freedv_open(mode);
  if (!f) return -1;
  int bytes_per_frame = freedv_get_bits_per_modem_frame(f) / 8;
  freedv_close(f);
  return bytes_per_frame - 2;
}

EMSCRIPTEN_KEEPALIVE
int host_tx_start(int mode, const uint8_t *frame, int frame_len) {
  struct freedv *tx = freedv_open(mode);
  if (!tx) return -2;
  freedv_set_frames_per_burst(tx, 1); /* see host_modem_relay's comment */

  int bytes_per_frame = freedv_get_bits_per_modem_frame(tx) / 8;
  int payload_bytes = bytes_per_frame - 2;
  if (frame_len != payload_bytes) { freedv_close(tx); return -2; }

  uint8_t *wire = malloc(bytes_per_frame);
  memcpy(wire, frame, payload_bytes);
  unsigned short crc = freedv_gen_crc16((unsigned char *)wire, payload_bytes);
  wire[bytes_per_frame - 2] = (uint8_t)(crc >> 8);
  wire[bytes_per_frame - 1] = (uint8_t)(crc & 0xff);

  int n_data = freedv_get_n_tx_modem_samples(tx);
  short *mod = malloc(sizeof(short) * 2 * n_data);
  int pos = 0;

  int n_pre = freedv_rawdatapreambletx(tx, mod);
  memcpy(g_tx_stream + pos, mod, sizeof(short) * n_pre);
  pos += n_pre;

  freedv_rawdatatx(tx, mod, wire);
  memcpy(g_tx_stream + pos, mod, sizeof(short) * n_data);
  pos += n_data;

  int n_post = freedv_rawdatapostambletx(tx, mod);
  memcpy(g_tx_stream + pos, mod, sizeof(short) * n_post);
  pos += n_post;

  free(wire); free(mod);
  freedv_close(tx);

  g_tx_stream_len = pos;
  g_tx_stream_pos = 0;
  return pos;
}

EMSCRIPTEN_KEEPALIVE
int host_tx_remaining(void) { return g_tx_stream_len - g_tx_stream_pos; }

EMSCRIPTEN_KEEPALIVE
short *host_tx_ptr(void) { return g_tx_stream + g_tx_stream_pos; }

EMSCRIPTEN_KEEPALIVE
void host_tx_advance(int n) {
  g_tx_stream_pos += n;
  if (g_tx_stream_pos > g_tx_stream_len) g_tx_stream_pos = g_tx_stream_len;
}

/* -- RX: accumulate incoming blocks, drain via freedv_rawdatarx() whenever
 * enough samples for the current freedv_nin() are buffered. One persistent
 * freedv context, reopened only when the expected mode changes (control
 * vs. payload frames use different modes; see host_rx_set_mode). */
static struct freedv *g_rx_stream_ctx = NULL;
static int g_rx_stream_mode = -1;
static short g_rx_accum[HOST_STREAM_MAX_SAMPLES];
static int g_rx_accum_len = 0;
static uint8_t g_rx_stream_out[1280];
static int g_rx_stream_out_len = 0; /* payload bytes of the last decode, 0 = none pending */

EMSCRIPTEN_KEEPALIVE
void host_rx_set_mode(int mode) {
  if (mode == g_rx_stream_mode && g_rx_stream_ctx) return;
  if (g_rx_stream_ctx) freedv_close(g_rx_stream_ctx);
  g_rx_stream_ctx = freedv_open(mode);
  if (g_rx_stream_ctx) freedv_set_frames_per_burst(g_rx_stream_ctx, 1);
  g_rx_stream_mode = mode;
  g_rx_accum_len = 0;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *host_rx_decoded_ptr(void) { return g_rx_stream_out; }

EMSCRIPTEN_KEEPALIVE
int host_rx_decoded_len(void) { return g_rx_stream_out_len; }

EMSCRIPTEN_KEEPALIVE
void host_rx_clear_decoded(void) { g_rx_stream_out_len = 0; }

/* Real modem-measured SNR (dB) of the most recent successful decode, from
 * freedv's own demodulator -- NOT a placeholder. doc §6.2's connection-test
 * screen needs a genuine number here, not the 12.0 stand-in
 * run-native-transfer.js used for E1 (fine for a clean-channel protocol
 * bench, not for anything claiming to show the operator real link quality). */
static float g_rx_last_snr = 0.0f;

EMSCRIPTEN_KEEPALIVE
float host_rx_last_snr(void) { return g_rx_last_snr; }

/* Appends n samples (from `samples`, a pointer the caller already wrote via
 * HEAP16) to the accumulator and drains as many freedv_nin()-sized chunks
 * as are available. Returns 1 if a new decode landed in
 * host_rx_decoded_ptr()/_len() (overwriting any previous one the caller
 * hadn't cleared -- callers should drain promptly), 0 otherwise. */
EMSCRIPTEN_KEEPALIVE
int host_rx_push(const short *samples, int n) {
  if (!g_rx_stream_ctx) return 0;
  if (g_rx_accum_len + n > HOST_STREAM_MAX_SAMPLES) {
    /* Should not happen at real block sizes; drop oldest rather than overflow. */
    int drop = g_rx_accum_len + n - HOST_STREAM_MAX_SAMPLES;
    memmove(g_rx_accum, g_rx_accum + drop, sizeof(short) * (g_rx_accum_len - drop));
    g_rx_accum_len -= drop;
  }
  memcpy(g_rx_accum + g_rx_accum_len, samples, sizeof(short) * n);
  g_rx_accum_len += n;

  int decoded = 0;
  int nin = freedv_nin(g_rx_stream_ctx);
  uint8_t rx_bytes[1280];
  /* nin == 0 is a DELIBERATE state, not an error: ofdm.c sets it right after
   * a postamble confirms a packet finished ("we won't be needing any new
   * samples for a while ...."), and the reference CLI driver
   * (freedv_data_raw_rx.c) still calls freedv_rawdatarx() on every pass
   * through its loop even when its own fread() returns 0 bytes for a 0-sized
   * request -- i.e. the API expects to be PUMPED (called) through the nin==0
   * period, not skipped, so its internal "how much longer to wait" state can
   * advance. The bug this file had before: treating nin<=0 as "nothing to
   * do" and never calling freedv_rawdatarx() again left it wedged at nin=0
   * forever (confirmed live: a control-mode demodulator that decoded fine
   * twice during a CALL/ACCEPT handshake never decoded anything again for
   * the rest of a multi-minute run, while the accumulator it was no longer
   * draining grew unbounded -- 750 -> 200000 samples, hitting
   * HOST_STREAM_MAX_SAMPLES). Fix: keep calling freedv_rawdatarx() through
   * nin==0 too (it doesn't consume accumulator bytes when nin is 0), bounded
   * so a genuinely stuck case can never spin the CPU -- if nin hasn't
   * recovered within a handful of calls, stop for THIS push() and let the
   * next real audio block (host_rx_push is called once per incoming block,
   * every ~20-100ms) resume the pump, rather than busy-looping in one call. */
  for (int guard = 0; guard < 32; guard++) {
    if (nin == 0) {
      int nbytes = freedv_rawdatarx(g_rx_stream_ctx, rx_bytes, g_rx_accum);
      nin = freedv_nin(g_rx_stream_ctx);
      if (nbytes > 0) {
        int bytes_per_frame = freedv_get_bits_per_modem_frame(g_rx_stream_ctx) / 8;
        int payload_bytes = bytes_per_frame - 2;
        if (nbytes == bytes_per_frame) {
          memcpy(g_rx_stream_out, rx_bytes, payload_bytes);
          g_rx_stream_out_len = payload_bytes;
          decoded = 1;
          int sync = 0;
          freedv_get_modem_stats(g_rx_stream_ctx, &sync, &g_rx_last_snr);
        }
      }
      if (nin == 0) break; /* did not recover within this call; try again on the next push() */
      continue;
    }
    if (nin < 0 || g_rx_accum_len < nin) break;
    int nbytes = freedv_rawdatarx(g_rx_stream_ctx, rx_bytes, g_rx_accum);
    memmove(g_rx_accum, g_rx_accum + nin, sizeof(short) * (g_rx_accum_len - nin));
    g_rx_accum_len -= nin;
    nin = freedv_nin(g_rx_stream_ctx);
    if (nbytes > 0) {
      int bytes_per_frame = freedv_get_bits_per_modem_frame(g_rx_stream_ctx) / 8;
      int payload_bytes = bytes_per_frame - 2;
      if (nbytes == bytes_per_frame) {
        memcpy(g_rx_stream_out, rx_bytes, payload_bytes);
        g_rx_stream_out_len = payload_bytes;
        decoded = 1;
        int sync = 0;
        freedv_get_modem_stats(g_rx_stream_ctx, &sync, &g_rx_last_snr);
      }
    }
  }
  return decoded;
}

/* ---- second, PERMANENT control-mode (DATAC16) RX context, run in parallel
 * with the one above.
 *
 * The real upstream reference (mercury/datalink_arq/arq_modem.c's
 * arq_modem_preferred_rx_mode(): "Always receive in control mode (DATAC16)
 * to catch all frame types") plus mercury/modem/modem.c's
 * select_payload_rx_mode() (which only ever returns something other than
 * DATAC16 by falling through to peer_tx_mode) together mean the real
 * mercury runs TWO demodulators at once: one permanently on DATAC16, one
 * dynamically tuned to peer_tx_mode for the data phase. A single
 * mode-switching demodulator (this file's original design, following just
 * dflow_state) misses real traffic: IDLE_IRS covers waiting for EITHER a
 * DATA frame (peer_tx_mode) OR a MODE_REQ (always control mode) -- there is
 * no way to know which is coming next without decoding it, so both must run
 * continuously. Confirmed live: without this, a real native `mercury`
 * sender's repeated "MODE_REQ timeout" retries (docs/mercury-implementace.md
 * session notes) proved our single demodulator was silently missing every
 * MODE_REQ arriving while parked on the payload mode. */
static struct freedv *g_rx_ctrl_ctx = NULL;
static short g_rx_ctrl_accum[HOST_STREAM_MAX_SAMPLES];
static int g_rx_ctrl_accum_len = 0;
static uint8_t g_rx_ctrl_out[1280];
static int g_rx_ctrl_out_len = 0;
static float g_rx_ctrl_last_snr = 0.0f;

EMSCRIPTEN_KEEPALIVE
void host_rx_ctrl_init(int control_mode) {
  if (g_rx_ctrl_ctx) return; /* control mode never changes once opened */
  g_rx_ctrl_ctx = freedv_open(control_mode);
  if (g_rx_ctrl_ctx) freedv_set_frames_per_burst(g_rx_ctrl_ctx, 1);
  g_rx_ctrl_accum_len = 0;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *host_rx_ctrl_decoded_ptr(void) { return g_rx_ctrl_out; }

EMSCRIPTEN_KEEPALIVE
int host_rx_ctrl_decoded_len(void) { return g_rx_ctrl_out_len; }

EMSCRIPTEN_KEEPALIVE
void host_rx_ctrl_clear_decoded(void) { g_rx_ctrl_out_len = 0; }

EMSCRIPTEN_KEEPALIVE
float host_rx_ctrl_last_snr(void) { return g_rx_ctrl_last_snr; }

/* Diagnostics only, for chasing the "control demodulator stops decoding
 * after the initial handshake" symptom: is the accumulator quietly growing
 * unbounded (never actually draining down to a small, healthy size), or
 * does freedv_nin() itself go strange for this context over a long,
 * continuously-fed run? Neither of these existed on the single-context
 * design because nothing ever ran a context this long before. */
EMSCRIPTEN_KEEPALIVE
int host_rx_ctrl_accum_len(void) { return g_rx_ctrl_accum_len; }

EMSCRIPTEN_KEEPALIVE
int host_rx_ctrl_nin(void) { return g_rx_ctrl_ctx ? freedv_nin(g_rx_ctrl_ctx) : -1; }

EMSCRIPTEN_KEEPALIVE
int host_rx_ctrl_sync(void) {
  if (!g_rx_ctrl_ctx) return -1;
  int sync = 0; float snr = 0.0f;
  freedv_get_modem_stats(g_rx_ctrl_ctx, &sync, &snr);
  return sync;
}

/* Same drain logic as host_rx_push(), a separate accumulator/context so it
 * never competes with the payload-mode one for buffered samples -- both see
 * every sample, independently. */
EMSCRIPTEN_KEEPALIVE
int host_rx_push_ctrl(const short *samples, int n) {
  if (!g_rx_ctrl_ctx) return 0;
  if (g_rx_ctrl_accum_len + n > HOST_STREAM_MAX_SAMPLES) {
    int drop = g_rx_ctrl_accum_len + n - HOST_STREAM_MAX_SAMPLES;
    memmove(g_rx_ctrl_accum, g_rx_ctrl_accum + drop, sizeof(short) * (g_rx_ctrl_accum_len - drop));
    g_rx_ctrl_accum_len -= drop;
  }
  memcpy(g_rx_ctrl_accum + g_rx_ctrl_accum_len, samples, sizeof(short) * n);
  g_rx_ctrl_accum_len += n;

  int decoded = 0;
  int nin = freedv_nin(g_rx_ctrl_ctx);
  uint8_t rx_bytes[1280];
  /* Same fix as host_rx_push(): nin==0 is DELIBERATE (ofdm.c: "we won't be
   * needing any new samples for a while ....", set right after a postamble
   * confirms a packet finished), not an error -- the reference CLI driver
   * keeps calling freedv_rawdatarx() through this period too (its own
   * fread()-returns-0 loop still calls it). Skipping the call while nin==0
   * left this exact context permanently deaf after its first two real
   * decodes (confirmed live via host_rx_ctrl_nin()/host_rx_ctrl_sync()
   * instrumentation: nin stuck at 0 from ~t=40s onward for the rest of a
   * multi-minute run) -- this is the actual fix for native mercury's
   * repeated "MODE_REQ timeout", not the freedv_set_sync() attempt before
   * it (confirmed live NOT to recover nin on its own). Bounded so a
   * genuinely stuck case still cannot spin the CPU. */
  for (int guard = 0; guard < 32; guard++) {
    if (nin == 0) {
      int nbytes = freedv_rawdatarx(g_rx_ctrl_ctx, rx_bytes, g_rx_ctrl_accum);
      nin = freedv_nin(g_rx_ctrl_ctx);
      if (nbytes > 0) {
        int bytes_per_frame = freedv_get_bits_per_modem_frame(g_rx_ctrl_ctx) / 8;
        int payload_bytes = bytes_per_frame - 2;
        if (nbytes == bytes_per_frame) {
          memcpy(g_rx_ctrl_out, rx_bytes, payload_bytes);
          g_rx_ctrl_out_len = payload_bytes;
          decoded = 1;
          int sync = 0;
          freedv_get_modem_stats(g_rx_ctrl_ctx, &sync, &g_rx_ctrl_last_snr);
        }
      }
      if (nin == 0) break;
      continue;
    }
    if (nin < 0 || g_rx_ctrl_accum_len < nin) break;
    int nbytes = freedv_rawdatarx(g_rx_ctrl_ctx, rx_bytes, g_rx_ctrl_accum);
    memmove(g_rx_ctrl_accum, g_rx_ctrl_accum + nin, sizeof(short) * (g_rx_ctrl_accum_len - nin));
    g_rx_ctrl_accum_len -= nin;
    nin = freedv_nin(g_rx_ctrl_ctx);
    if (nbytes > 0) {
      int bytes_per_frame = freedv_get_bits_per_modem_frame(g_rx_ctrl_ctx) / 8;
      int payload_bytes = bytes_per_frame - 2;
      if (nbytes == bytes_per_frame) {
        memcpy(g_rx_ctrl_out, rx_bytes, payload_bytes);
        g_rx_ctrl_out_len = payload_bytes;
        decoded = 1;
        int sync = 0;
        freedv_get_modem_stats(g_rx_ctrl_ctx, &sync, &g_rx_ctrl_last_snr);
      }
    }
  }
  return decoded;
}
