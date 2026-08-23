/* Stub implementations of arq_fsm.c's non-modem external dependencies, for
 * the real-modem host bench (host-shim.c). Modelled closely on upstream's
 * own mercury/tests/datalink_arq/arq_test_stubs.c, with two deliberate
 * differences:
 *
 *   1. No freedv_gen_crc16() stub here -- this build links the real
 *      freedv_api.c (unlike the arq-sim-only build), which already defines
 *      it; stubbing it again would be a duplicate-symbol link error.
 *
 *   2. arq_bandwidth_allows_mode() is NOT "allow everything" like the test
 *      stub. It gates DATAC1/DATAC17/QAM16C2 off, matching
 *      docs/mercury-implementace.md decision #2 ("Etapa 1 zapíná jen
 *      DATAC16 (řízení) + DATAC3 (payload) bez gear-shiftingu") — the same
 *      mechanism arq.c's real (discarded) implementation uses to gate wide
 *      modes on a narrow configured bandwidth, just pinned narrow always.
 *      Without this, select_best_mode() in arq_fsm.c would happily climb
 *      to DATAC17/QAM16C2 on a clean high-SNR bench channel, and this
 *      prototype's freedv build doesn't compile those modes in.
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <stdio.h>

#include "hermes_log.h"
#include "framer.h"
#include "arq.h"
#include "freedv_api.h"

/* ---- hermes_log stubs ---- */

/* IMPORTANT: common/virtual_clock.c's time_now_ms() -- what arq_fsm.c's
 * timers actually read -- only takes its atomic g_now_ms branch once
 * virtual_clock_enable() has been called. mercury/tests/sim/sim_clock.c
 * never calls that; it only calls mock_set_uptime_ms(), so time_now_ms()
 * falls through to hermes_uptime_ms() here. An earlier version of this
 * stub returned a hardcoded 0 from hermes_uptime_ms() and discarded
 * mock_set_uptime_ms()'s argument (wrongly assuming virtual-clock mode was
 * active) -- every FSM deadline was then computed against a clock stuck at
 * 0, so a deadline meant to be "8s from now" was already in the past the
 * instant it was armed, and retry timers refired every single event-loop
 * pass instead of every retry_interval. */
static uint64_t g_uptime_ms = 0;

uint64_t hermes_uptime_ms(void)
{
    return g_uptime_ms;
}

void mock_set_uptime_ms(uint64_t ms)
{
    g_uptime_ms = ms;
}

void hermes_logf(hermes_log_level_t level, const char *component,
                 const char *fmt, ...)
{
    (void)level; (void)component; (void)fmt;
}

/* ---- framer stubs (byte-identical to framer.h's own static inline helpers;
 * kept as real functions here since arq code calls them as such) ---- */

void write_frame_header(uint8_t *data, int packet_type, uint8_t extension)
{
    data[0] = (uint8_t)((packet_type << PACKET_TYPE_SHIFT) | (extension & FRAME_EXT_MASK));
}

int8_t parse_frame_header(const uint8_t *data_frame, uint32_t frame_size, uint8_t *extension_out)
{
    if (!data_frame || frame_size < 1) return -1;
    uint8_t ptype = frame_header_packet_type(data_frame[0]);
    if (extension_out)
        *extension_out = frame_header_extension(data_frame[0]);
    return (int8_t)ptype;
}

/* ---- arq_info global (used by arq.h) ---- */

arq_info arq_conn = {0};

/* ---- arq.c function stubs ---- */

int arq_reported_bandwidth_hz(void)
{
    return ARQ_BANDWIDTH_FULL_HZ;
}

void arq_conn_get_calls(char *my_call, char *src_addr, char *dst_addr, size_t bufsz)
{
    if (bufsz == 0) return;
    if (my_call)  { snprintf(my_call,  bufsz, "%s", arq_conn.my_call_sign); }
    if (src_addr) { snprintf(src_addr, bufsz, "%s", arq_conn.src_addr); }
    if (dst_addr) { snprintf(dst_addr, bufsz, "%s", arq_conn.dst_addr); }
}

int arq_get_bw(void)
{
    return arq_conn.bw;
}

bool arq_bandwidth_allows_mode(int mode)
{
    if (mode == FREEDV_MODE_DATAC1 ||
        mode == FREEDV_MODE_DATAC17 ||
        mode == FREEDV_MODE_QAM16C2)
        return false;
    return true;
}
