// Minimal Emscripten entry point over freedv_api, scoped to the DATAC
// data modes Mercury actually uses (docs/mercury-implementace.md, ch. 2.2).
//
// mercury_loopback_test() mirrors the reference usage in freedv_data_raw_tx.c
// / freedv_data_raw_rx.c (same freedv/ tree): silence, preamble, one raw data
// frame with an appended CRC16, postamble, silence -- modulated by one
// freedv instance and demodulated by a second, entirely in memory (WASM has
// no filesystem here). This is deliberately real TX+RX, not just
// freedv_open()/freedv_close(): a shim that never modulates or demodulates
// lets -Oz/-flto strip most of the OFDM/LDPC code paths, which is why an
// earlier open/close-only version of this file measured well under
// docs/mercury-implementace.md ch. 2.2's numbers.
//
// Not the ARQ FSM or the real Mercury frame header yet -- that is the next
// prototype step.
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>
#include "freedv_api.h"

typedef struct { int mode; const char *name; } mode_entry;

static const mode_entry MODES[] = {
#ifdef FREEDV_MODE_DATAC16_EN
  { FREEDV_MODE_DATAC16, "DATAC16" },
#endif
#ifdef FREEDV_MODE_DATAC15_EN
  { FREEDV_MODE_DATAC15, "DATAC15" },
#endif
#ifdef FREEDV_MODE_DATAC4_EN
  { FREEDV_MODE_DATAC4, "DATAC4" },
#endif
#ifdef FREEDV_MODE_DATAC3_EN
  { FREEDV_MODE_DATAC3, "DATAC3" },
#endif
#ifdef FREEDV_MODE_DATAC1_EN
  { FREEDV_MODE_DATAC1, "DATAC1" },
#endif
};
static const int N_MODES = sizeof(MODES) / sizeof(MODES[0]);

EMSCRIPTEN_KEEPALIVE
int mercury_mode_count(void) { return N_MODES; }

// Byte length of the payload (excluding the 2-byte CRC16) for mode_index,
// so the JS driver can report it without duplicating freedv's frame table.
EMSCRIPTEN_KEEPALIVE
int mercury_mode_payload_bytes(int mode_index) {
  if (mode_index < 0 || mode_index >= N_MODES) return -1;
  struct freedv *f = freedv_open(MODES[mode_index].mode);
  if (!f) return -1;
  int bytes_per_frame = freedv_get_bits_per_modem_frame(f) / 8;
  freedv_close(f);
  return bytes_per_frame - 2;
}

// Returns: 1 = payload decoded and matched exactly, 0 = frame never decoded
// within the burst window, -1 = decoded but payload/CRC mismatched,
// -2 = bad mode_index or freedv_open() failed.
EMSCRIPTEN_KEEPALIVE
int mercury_loopback_test(int mode_index) {
  if (mode_index < 0 || mode_index >= N_MODES) return -2;
  int mode = MODES[mode_index].mode;

  struct freedv *tx = freedv_open(mode);
  struct freedv *rx = freedv_open(mode);
  if (!tx || !rx) { if (tx) freedv_close(tx); if (rx) freedv_close(rx); return -2; }
  /* freedv_open() leaves packetsperburst at 0 ("never lose OFDM sync", per
   * ofdm.c's own comment) -- but for the raw-data API that ALSO skips the
   * "packet_count >= packetsperburst -> next_state = search" transition in
   * ofdm.c, so a mode whose packet spans multiple OFDM frames (DATAC15: one
   * 32-byte packet takes ~34 frames) never gets flagged complete and
   * freedv_rawdatarx() never returns a decode -- silently, no error, sync
   * achieved, just no packet, forever. freedv_data_raw_tx.c/rx.c always call
   * this; a shim that skips it works for single-OFDM-frame packets (DATAC16/
   * DATAC4/DATAC3/DATAC1 in this build all happened to) and then silently
   * hangs on the first multi-frame one. */
  freedv_set_frames_per_burst(tx, 1);
  freedv_set_frames_per_burst(rx, 1);

  int bits_per_frame = freedv_get_bits_per_modem_frame(tx);
  int bytes_per_frame = bits_per_frame / 8;   /* DATAC modes: always a multiple of 8, per freedv_data_raw_tx.c */
  int payload_bytes = bytes_per_frame - 2;    /* last 2 bytes are CRC16 */

  unsigned char *tx_bytes = malloc(bytes_per_frame);
  unsigned char *rx_bytes = malloc(bytes_per_frame);
  for (int i = 0; i < payload_bytes; i++) tx_bytes[i] = (unsigned char)(i * 7 + mode_index);
  unsigned short crc = freedv_gen_crc16(tx_bytes, payload_bytes);
  tx_bytes[bytes_per_frame - 2] = (unsigned char)(crc >> 8);
  tx_bytes[bytes_per_frame - 1] = (unsigned char)(crc & 0xff);

  int n_data = freedv_get_n_tx_modem_samples(tx); /* f->n_nat_modem_samples: a full packet, which for
                                                       DATAC1/DATAC3 spans MORE OFDM frames than the "2 *
                                                       one frame" freedv_get_n_max_modem_samples() gives --
                                                       that mismatch is what freedv_data_raw_tx.c avoids by
                                                       sizing its TX scratch buffer off this accessor, not
                                                       off n_max (n_max is a RX/demod-side bound). Using
                                                       n_max here for TX overflowed the buffer inside
                                                       freedv_rawdatatx() for exactly those two modes. */
  int n_nom = freedv_get_n_nom_modem_samples(tx);
  int settle = 2 * n_nom; /* matches freedv_data_raw_tx.c's default inter-burst silence */

  short *mod = malloc(sizeof(short) * 2 * n_data); /* 2x headroom, matching freedv_data_raw_tx.c's
                                                        send_preamble/send_modulated_data/send_postamble,
                                                        which all reuse one `mod_out_short[2 * n_mod_out]`. */
  /* Deliberately over-allocated vs. the exact preamble+data+postamble sum so a
     size assumption that turns out wrong for one mode corrupts nothing. */
  int cap = settle + 4 * n_data + settle;
  short *burst = calloc(cap, sizeof(short));
  int pos = settle; /* leading silence already zeroed by calloc */

  int n_pre = freedv_rawdatapreambletx(tx, mod);
  memcpy(burst + pos, mod, sizeof(short) * n_pre);
  pos += n_pre;

  freedv_rawdatatx(tx, mod, tx_bytes);
  memcpy(burst + pos, mod, sizeof(short) * n_data);
  pos += n_data;

  int n_post = freedv_rawdatapostambletx(tx, mod);
  memcpy(burst + pos, mod, sizeof(short) * n_post);
  pos += n_post;

  int total = pos + settle; /* trailing silence already zeroed by calloc */

  int result = 0;
  int nin = freedv_nin(rx);
  int off = 0;
  while (off + nin <= total) {
    int nbytes = freedv_rawdatarx(rx, rx_bytes, burst + off);
    off += nin;
    nin = freedv_nin(rx);
    if (nbytes > 0) {
      result = (nbytes == bytes_per_frame && memcmp(rx_bytes, tx_bytes, bytes_per_frame) == 0) ? 1 : -1;
      break;
    }
  }

  free(tx_bytes); free(rx_bytes); free(mod); free(burst);
  freedv_close(tx); freedv_close(rx);
  return result;
}
