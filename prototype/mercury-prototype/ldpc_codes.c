/*
  FILE...: ldpc_codes.c
  AUTHOR.: David Rowe
  CREATED: July 2020

  Array of LDPC codes used for various Codec2 waveforms.

  MODIFIED 2026-10-29 by OK1HRA (LGPL-2.1, as the original): WIFILT copy of
  mercury/modem/freedv/ldpc_codes.c (upstream pin 8be5acd, see UPSTREAM.md),
  used by build-worker-wasm.sh in place of the upstream file.
  Upstream's table names all twelve codes, so the linker keeps every H matrix
  -- ~415 kB of tables this build can never reach, most of the shipped .wasm.
  Only the codes of the modes build-worker-wasm.sh enables are listed here:

    DATAC1          H_4096_8192_3d
    DATAC3, DATAC4  H_1024_2048_4f
    DATAC13         H_256_512_4
    DATAC15, DATAC16 H_256_768_22
    (ofdm_mode.c's default config) HRA_112_112

  Enabling another mode (QAM16C2/DATAC17 need H_16200_9720) means adding its
  code back here and its H_*.c back to the build. A missing code aborts in
  ldpc_codes_find(): upstream only assert()s, which NDEBUG compiles out, and
  ldpc_codes_setup() would then memcpy ldpc_codes[-1].
*/

#include "ldpc_codes.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "HRA_112_112.h"
#include "H_1024_2048_4f.h"
#include "H_256_512_4.h"
#include "H_256_768_22.h"
#include "H_4096_8192_3d.h"
#include "interldpc.h"

struct LDPC ldpc_codes[] = {
    /* short rate 1/2 code for FreeDV 700D */
    {"HRA_112_112", HRA_112_112_MAX_ITER, 0, 1, 1, HRA_112_112_CODELENGTH,
     HRA_112_112_NUMBERPARITYBITS, HRA_112_112_NUMBERROWSHCOLS,
     HRA_112_112_MAX_ROW_WEIGHT, HRA_112_112_MAX_COL_WEIGHT,
     (uint16_t *)HRA_112_112_H_rows, (uint16_t *)HRA_112_112_H_cols},

    /* rate 1/3 code, works at raw BER of 14% */
    {"H_256_768_22", H_256_768_22_MAX_ITER, 0, 1, 1, H_256_768_22_CODELENGTH,
     H_256_768_22_NUMBERPARITYBITS, H_256_768_22_NUMBERROWSHCOLS,
     H_256_768_22_MAX_ROW_WEIGHT, H_256_768_22_MAX_COL_WEIGHT,
     (uint16_t *)H_256_768_22_H_rows, (uint16_t *)H_256_768_22_H_cols},

    /* used for 4FSK/LLR experiments */
    {"H_256_512_4", H_256_512_4_MAX_ITER, 0, 1, 1, H_256_512_4_CODELENGTH,
     H_256_512_4_NUMBERPARITYBITS, H_256_512_4_NUMBERROWSHCOLS,
     H_256_512_4_MAX_ROW_WEIGHT, H_256_512_4_MAX_COL_WEIGHT,
     (uint16_t *)H_256_512_4_H_rows, (uint16_t *)H_256_512_4_H_cols},

    /* Nice long code from Bill VK5DSP - useful for HF data */
    {"H_4096_8192_3d", H_4096_8192_3d_MAX_ITER, 0, 1, 1,
     H_4096_8192_3d_CODELENGTH, H_4096_8192_3d_NUMBERPARITYBITS,
     H_4096_8192_3d_NUMBERROWSHCOLS, H_4096_8192_3d_MAX_ROW_WEIGHT,
     H_4096_8192_3d_MAX_COL_WEIGHT, (uint16_t *)H_4096_8192_3d_H_rows,
     (uint16_t *)H_4096_8192_3d_H_cols},

    /* Another fine code from Bill VK5DSP - also useful for HF data */
    {"H_1024_2048_4f", H_1024_2048_4f_MAX_ITER, 0, 1, 1,
     H_1024_2048_4f_CODELENGTH, H_1024_2048_4f_NUMBERPARITYBITS,
     H_1024_2048_4f_NUMBERROWSHCOLS, H_1024_2048_4f_MAX_ROW_WEIGHT,
     H_1024_2048_4f_MAX_COL_WEIGHT, (uint16_t *)H_1024_2048_4f_H_rows,
     (uint16_t *)H_1024_2048_4f_H_cols}};

int ldpc_codes_num(void) { return sizeof(ldpc_codes) / sizeof(struct LDPC); }

void ldpc_codes_list() {
  fprintf(stderr, "\n");
  for (int c = 0; c < ldpc_codes_num(); c++) {
    int n = ldpc_codes[c].NumberRowsHcols + ldpc_codes[c].NumberParityBits;
    int k = ldpc_codes[c].NumberRowsHcols;
    float rate = (float)k / n;
    fprintf(stderr, "%-20s rate %3.2f (%d,%d) \n", ldpc_codes[c].name,
            (double)rate, n, k);
  }
  fprintf(stderr, "\n");
}

int ldpc_codes_find(char name[]) {
  int code_index = -1;
  for (int c = 0; c < ldpc_codes_num(); c++)
    if (strcmp(ldpc_codes[c].name, name) == 0) code_index = c;
  if (code_index == -1) {
    fprintf(stderr, "ldpc_codes_find: LDPC code %s is not in this build\n",
            name);
    abort();
  }
  return code_index;
}

void ldpc_codes_setup(struct LDPC *ldpc, char name[]) {
  int code_index;
  code_index = ldpc_codes_find(name);
  memcpy(ldpc, &ldpc_codes[code_index], sizeof(struct LDPC));
  set_up_ldpc_constants(ldpc, ldpc->CodeLength, ldpc->NumberParityBits);
}
