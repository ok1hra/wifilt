#!/usr/bin/env python3
"""
The radio's TX buffer, adapted to measured jitter (lan_jitter.h, wifilt.ino
lanTxBufferTick), end to end against the native firmware and
tools/icom-lan-fake-radio.py --rx-stall, which now and then holds the RX audio
back and lets it arrive in a burst, the way Wi-Fi does:

  1. a fresh install asks the radio for 150 ms;
  2. with a page on the audio, the firmware measures the jitter and decides on
     a bigger buffer -- but does not reconnect under the page;
  3. the page leaves: one reconnect, the stream request carries the new value,
     /state reports it, and it is stored for this radio;
  4. the next page's AUD1 hello says radioTxBufferMs (a modem that times its replies adds it to its
     round trip).

Run through tools/lan-txbuffer-native-check.sh.

  python3 tools/lan-txbuffer-native-check.py HTTP_PORT RADIO_LOG CONFIG_DIR APP_LOG
"""
import importlib.util
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("aud1check", os.path.join(HERE, "aud1-16k-native-check.py"))
A = importlib.util.module_from_spec(spec)
spec.loader.exec_module(A)          # reads HTTP_PORT and RADIO_LOG from argv like this script
CONFIG_DIR, APP_LOG = sys.argv[3], sys.argv[4]
failures = 0


def check(name, ok, detail=""):
    global failures
    print(("  ok   " if ok else "  FAIL ") + name + ("  " + detail if detail else ""), flush=True)
    if not ok:
        failures += 1


def state():
    return json.loads(A.http("/state"))


def app_log():
    with open(APP_LOG, errors="replace") as f:
        return f.read()


def buffers_requested():
    return [int(v) for v in re.findall(r"txbuffer (\d+) ms", A.radio_log())]


def wired():
    """A radio with its own wire (here the fake one named IC-7610): jitter is
    measured and shown, the buffer stays 150 ms."""
    check("the radio is connected", A.wait_for(A.connected, 30))
    token, granted = A.session()
    ws = A.Ws(token)
    for _ in range(26):
        A.collect(ws, 2)
    s = state()
    check("wired radio: the jitter is measured", s.get("rxJitterMs", 0) >= 120, f"rxJitterMs {s.get('rxJitterMs')}")
    check("wired radio: the buffer stays 150", s.get("txBufferNextMs") == 150 and s.get("txBufferMs") == 150, json.dumps(
        {k: s.get(k) for k in ("txBufferMs", "txBufferNextMs")}))
    ws.close()
    A.http("/js8/session/release", {"token": token})
    time.sleep(4)
    check("wired radio: no reconnect", buffers_requested() == [150], f"{buffers_requested()}")
    print("\nLAN TX BUFFER (wired) " + ("PASS" if not failures else f"FAIL ({failures})"))
    return 1 if failures else 0


def main():
    if len(sys.argv) > 5 and sys.argv[5] == "wired":
        return wired()
    check("the radio is connected", A.wait_for(A.connected, 30))
    s = state()
    check("fresh install: 150 ms", s.get("txBufferMs") == 150 and buffers_requested()[-1:] == [150],
          f"state {s.get('txBufferMs')}, requested {buffers_requested()}")

    token, granted = A.session()
    check("the audio session is granted", granted)
    ws = A.Ws(token)
    texts, frames = A.collect(ws, 2)
    hello = next((t for t in texts if t.get("type") == "hello"), {})
    check("hello says radioTxBufferMs 150", hello.get("radioTxBufferMs") == 150, json.dumps(hello)[:160])
    # Two 20 s windows of audio before the firmware has an opinion.
    seen = 0
    for _ in range(26):
        _texts, more = A.collect(ws, 2)
        seen += sum(len(f["samples"]) for f in more)
    s = state()
    nxt, cur, jit = s.get("txBufferNextMs", 0), s.get("txBufferMs", 0), s.get("rxJitterMs", 0)
    check("RX audio flowed the whole time", seen > 45 * 8000, f"{seen / 8000:.1f} s of audio")
    check("the jitter is measured", jit >= 120, f"rxJitterMs {jit}")
    check("a bigger buffer is decided", nxt >= 250 and nxt == min(500, ((jit * 3 // 2 + 60 + 49) // 50) * 50),
          f"next {nxt} for jitter {jit}")
    check("but not applied under the page", cur == 150 and buffers_requested()[-1] == 150 and not ws.closed,
          f"active {cur}, requested {buffers_requested()}")
    check("the log says it waits for the page", "applied when the audio page closes" in app_log())
    ws.close()
    A.http("/js8/session/release", {"token": token})

    applied = A.wait_for(lambda: buffers_requested()[-1] == nxt, 25)
    check("page gone: the radio is asked for it", applied, f"requested {buffers_requested()}")
    check("one reconnect, not a storm", len(buffers_requested()) == 2, f"{buffers_requested()}")
    check("the radio is back", A.wait_for(A.connected, 20))
    check("/state reports it", A.wait_for(lambda: state().get("txBufferMs") == nxt, 10), f"{state().get('txBufferMs')}")
    stored = open(os.path.join(CONFIG_DIR, "lan-txbuffer.json")).read() if os.path.exists(os.path.join(CONFIG_DIR, "lan-txbuffer.json")) else ""
    check("stored for this radio", stored.strip().split("\n")[0] == f"127.0.0.2 {nxt}", repr(stored))

    time.sleep(1.0)
    token, granted = A.session()
    ws = A.Ws(token)
    texts, _ = A.collect(ws, 2)
    hello = next((t for t in texts if t.get("type") == "hello"), {})
    check("the next page's hello says it", hello.get("radioTxBufferMs") == nxt, json.dumps(hello)[:160])
    ws.close()

    print("\nLAN TX BUFFER " + ("PASS" if not failures else f"FAIL ({failures})"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
