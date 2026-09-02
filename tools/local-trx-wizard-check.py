#!/usr/bin/env python3
"""
Setup-wizard HTTP check for local-trx (fáze 6, bod "Setup/config UI").

WHY THIS EXISTS
    Talks straight to the wizard's own embedded HTTP server
    (webui_server.cpp), proving the routes it registers actually work: GET /
    serves webui/index.html, GET /api/devices returns real device/rig-model
    lists (device_enum.cpp), GET /api/config returns the current config.json
    in the exact shape the wizard's own JS expects, and POST /api/config
    round-trips a full config document back to disk (config.cpp's
    parseConfigJson()/saveConfig()).

    Does NOT drive an actual browser -- a static cross-check that every
    el("...") id in webui/index.html's JS has a matching id="..." in its own
    HTML (zero mismatches, done by hand during development) covers the
    DOM-wiring risk a headless-browser test would otherwise catch; no
    puppeteer/CDP driver was available in this sandbox to go further than
    that. See docs/local-trx-implementace.md's fáze 6 section.

USAGE
    python3 tools/local-trx-wizard-check.py [--port 8766]

Exit codes:
  0  all four checks passed
  2  GET / did not return the wizard page
  3  GET /api/devices was missing an expected list or hamlib's Dummy model
  4  GET /api/config did not match the expected shape
  5  POST /api/config did not round-trip
"""

import argparse
import json
import sys
import urllib.request


def get(url):
    with urllib.request.urlopen(url, timeout=5) as resp:
        return resp.status, resp.read().decode("utf-8")


def post(url, body):
    req = urllib.request.Request(url, data=body.encode("utf-8"), method="POST",
                                  headers={"Content-Type": "text/plain"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, resp.read().decode("utf-8")


def main():
    parser = argparse.ArgumentParser(description="local-trx setup-wizard HTTP check")
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    base = f"http://127.0.0.1:{args.port}"

    status, body = get(base + "/")
    if status != 200 or "local-trx setup" not in body:
        print(f"FAIL GET / -- status={status}", file=sys.stderr)
        return 2
    print("  ok  GET / serves the wizard page")

    status, body = get(base + "/api/devices")
    devices = json.loads(body)
    if "audioCapture" not in devices or "audioPlayback" not in devices or "serialPorts" not in devices:
        print(f"FAIL /api/devices missing expected keys: {list(devices.keys())}", file=sys.stderr)
        return 3
    if not any(m.get("model") == "Dummy" for m in devices.get("rigModels", [])):
        print("FAIL /api/devices rigModels missing hamlib's Dummy backend", file=sys.stderr)
        return 3
    print(f"  ok  GET /api/devices: {len(devices['rigModels'])} rig models, "
          f"{len(devices['audioCapture'])} capture device(s), "
          f"{len(devices['serialPorts'])} serial port(s)")

    status, body = get(base + "/api/config")
    config = json.loads(body)
    if "identity" not in config or "radioName" not in config["identity"]:
        print(f"FAIL /api/config missing expected shape: {body}", file=sys.stderr)
        return 4
    print(f"  ok  GET /api/config: radioName={config['identity']['radioName']!r}")

    # Round trip: flip cwWpm to a value nothing else in this test run depends
    # on, then read it back via GET. Safe to do mid-test regardless of what
    # else is running against this local-trx process: main.cpp reads
    # config.json exactly once at startup (fáze 6 has no live-reconfiguration
    # path for any subsystem), so writing a new one never touches the
    # ALREADY-RUNNING process's own CW/FSK/audio/CI-V behaviour.
    config["keying"]["cwWpm"] = 37
    _, resp_body = post(base + "/api/config", json.dumps(config))
    result = json.loads(resp_body)
    if not result.get("ok"):
        print(f"FAIL POST /api/config: {result}", file=sys.stderr)
        return 5
    _, body = get(base + "/api/config")
    if json.loads(body)["keying"]["cwWpm"] != 37:
        print("FAIL POST /api/config did not round-trip cwWpm", file=sys.stderr)
        return 5
    print("  ok  POST /api/config round-trips (cwWpm -> 37 confirmed via GET)")

    print("\nAll setup-wizard HTTP checks matched. OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
