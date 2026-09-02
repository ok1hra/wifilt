"""
Shared wire-format helpers for the local-trx test scripts (tools/local-trx-
*-check.py). Ported byte-for-byte from tools/icom-lan-fake-radio.py, the same
proven-working reference local-trx/src/icom_lan_server.h's own header comment
names -- these are just the two pieces of that format four of those scripts
needed independently and had each copy-pasted verbatim (found by code
review).

Module name uses an underscore, not a hyphen, so it can actually be imported
(`import local_trx_wire`) -- Python's own sys.path[0] is always the directory
of the script being run, so this is found regardless of what directory the
importing script itself is invoked from.
"""

import struct


def hdr16(ptype, seq, my_id, remote_id):
    return struct.pack("<IHHII", 0x10, ptype, seq, my_id, remote_id)


def build_audio_packet(my_id, remote_id, outer_seq, inner_seq, payload):
    total = 0x18 + len(payload)
    p = bytearray(total)
    struct.pack_into("<I", p, 0, total)
    struct.pack_into("<H", p, 0x06, outer_seq)
    struct.pack_into("<I", p, 0x08, my_id)
    struct.pack_into("<I", p, 0x0C, remote_id)
    struct.pack_into(">H", p, 0x12, inner_seq)
    struct.pack_into("<H", p, 0x14, len(payload))
    p[0x18:] = payload
    return bytes(p)
