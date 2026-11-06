#!/usr/bin/env python3
"""Compare the partition table on a device with the one a release expects.

The upload scripts read the table off the device (esptool read_flash 0x8000)
before writing anything. When the two differ, this decides whether the device
can be moved to the new layout without losing the operator's configuration:

  plan DEVICE.bin EXPECTED.bin
      prints one line:
        match                         the tables are identical, write as usual
        migrate OLD_OFF SIZE NEW_OFF  read cfg at OLD_OFF, write it back at NEW_OFF
                                      together with the new table, app and assets
        refuse <reason>               nothing can be done safely from here
  cfg IMAGE.bin
      prints "littlefs" (a filesystem to carry over), "empty" (erased flash,
      nothing to carry) or "unknown" (neither: refuse rather than guess)
  selftest
      checks the above against tables built in memory

Migration needs a device whose nvs and otadata stay where they are (WiFi
credentials, callsign and the boot selection live there), whose app0 starts
where the new one does, and which already has a cfg partition of the new size.
A pre-cfg device (releases before REV 20260808) kept its configuration inside
the asset filesystem and cannot be migrated: the answer is refuse.

Standard library only; the format is ESP-IDF's: 32-byte entries
<magic 0x50AA, type, subtype, offset, size, label[16], flags>, then an MD5
entry (magic 0xEBEB) and 0xFF padding.
"""
import struct
import sys

ENTRY = struct.Struct("<HBBII16sI")
MAGIC = 0x50AA
BLOCK = 4096


def parse(blob):
    rows = {}
    for at in range(0, len(blob) - ENTRY.size + 1, ENTRY.size):
        magic, ptype, subtype, offset, size, label, _flags = ENTRY.unpack_from(blob, at)
        if magic != MAGIC:
            break
        name = label.split(b"\0", 1)[0].decode("ascii", "replace")
        rows[name] = (ptype, subtype, offset, size)
    return rows


def plan(device_blob, expected_blob):
    if device_blob == expected_blob:
        return "match"
    dev, exp = parse(device_blob), parse(expected_blob)
    if not dev:
        return "refuse no partition table on the device"
    for name in ("nvs", "otadata"):
        if name in exp and dev.get(name) != exp[name]:
            return "refuse %s would move (it holds WiFi and boot settings)" % name
    if "app0" not in dev or dev["app0"][2] != exp["app0"][2]:
        return "refuse app0 starts elsewhere on the device"
    if "cfg" not in exp:
        return "refuse the new layout has no cfg partition"
    if "cfg" not in dev:
        return "refuse the device has no cfg partition (release older than 20260808)"
    dtype, dsub, doff, dsize = dev["cfg"]
    etype, esub, eoff, esize = exp["cfg"]
    if (dtype, dsub) != (etype, esub):
        return "refuse cfg changed type"
    if dsize != esize:
        return "refuse cfg changed size (0x%X -> 0x%X)" % (dsize, esize)
    return "migrate 0x%X 0x%X 0x%X" % (doff, dsize, eoff)


def cfg_kind(image):
    if image.count(0xFF) == len(image):
        return "empty"
    # LittleFS keeps its superblock in a metadata pair at blocks 0 and 1; the
    # name "littlefs" follows the 4-byte revision count and the 4-byte tag.
    for block in (0, 1):
        if image[block * BLOCK + 8:block * BLOCK + 16] == b"littlefs":
            return "littlefs"
    return "unknown"


def table(rows):
    out = b""
    for name, ptype, subtype, offset, size in rows:
        out += ENTRY.pack(MAGIC, ptype, subtype, offset, size, name.encode().ljust(16, b"\0"), 0)
    return out + b"\xEB\xEB" + b"\xFF" * 14 + b"\0" * 16 + b"\xFF" * (3072 - len(out) - 32)


def selftest():
    old = table([("nvs", 1, 2, 0x9000, 0x5000), ("otadata", 1, 0, 0xE000, 0x2000),
                 ("app0", 0, 0x10, 0x10000, 0x160000), ("cfg", 1, 0x82, 0x170000, 0x20000),
                 ("spiffs", 1, 0x82, 0x190000, 0x270000)])
    new = table([("nvs", 1, 2, 0x9000, 0x5000), ("otadata", 1, 0, 0xE000, 0x2000),
                 ("app0", 0, 0x10, 0x10000, 0x130000), ("spiffs", 1, 0x82, 0x140000, 0x2A0000),
                 ("cfg", 1, 0x82, 0x3E0000, 0x20000)])
    precfg = table([("nvs", 1, 2, 0x9000, 0x5000), ("otadata", 1, 0, 0xE000, 0x2000),
                    ("app0", 0, 0x10, 0x10000, 0x160000), ("spiffs", 1, 0x82, 0x170000, 0x290000)])
    movednvs = table([("nvs", 1, 2, 0xA000, 0x5000), ("otadata", 1, 0, 0xE000, 0x2000),
                      ("app0", 0, 0x10, 0x10000, 0x160000), ("cfg", 1, 0x82, 0x170000, 0x20000)])
    small = table([("nvs", 1, 2, 0x9000, 0x5000), ("otadata", 1, 0, 0xE000, 0x2000),
                   ("app0", 0, 0x10, 0x10000, 0x160000), ("cfg", 1, 0x82, 0x170000, 0x10000)])
    lfs = bytearray(b"\xFF" * 0x20000)
    lfs[BLOCK + 8:BLOCK + 16] = b"littlefs"
    junk = bytearray(b"\xFF" * 0x20000)
    junk[100] = 0
    cases = [
        (plan(new, new), "match"),
        (plan(old, new), "migrate 0x170000 0x20000 0x3E0000"),
        (plan(precfg, new).split()[0], "refuse"),
        (plan(movednvs, new).split()[0], "refuse"),
        (plan(small, new).split()[0], "refuse"),
        (plan(b"\xFF" * 3072, new).split()[0], "refuse"),
        (cfg_kind(bytes(lfs)), "littlefs"),
        (cfg_kind(b"\xFF" * 0x20000), "empty"),
        (cfg_kind(bytes(junk)), "unknown"),
    ]
    bad = [(i, got, want) for i, (got, want) in enumerate(cases) if got != want]
    for i, got, want in bad:
        print("FAIL case %d: %r != %r" % (i, got, want))
    print("flash-layout selftest: %d/%d" % (len(cases) - len(bad), len(cases)))
    return 1 if bad else 0


def main(argv):
    if len(argv) == 4 and argv[1] == "plan":
        print(plan(open(argv[2], "rb").read(), open(argv[3], "rb").read()))
        return 0
    if len(argv) == 3 and argv[1] == "cfg":
        print(cfg_kind(open(argv[2], "rb").read()))
        return 0
    if len(argv) == 2 and argv[1] == "selftest":
        return selftest()
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
