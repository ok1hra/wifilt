#!/usr/bin/env python3
"""
Fake DX cluster, so the telnet half of the DXC path can be exercised offline.

The chain under test is: browser WebSocket on port 82 <-> firmware <-> telnet TCP
to a cluster. Real clusters are public services with real callsigns on them, so
pointing a test at one is both rude and unrepeatable. This speaks just enough of
the protocol -- a login prompt, a greeting, and a steady trickle of DX spots in
the standard format -- for the relay to have something to relay.

  python3 tools/dxc-fake-cluster.py [--port 7300] [--interval 2] [--seconds 120]

Prints one line per client event so a test can assert the firmware logged in.
"""

import argparse
import socket
import sys
import time

# Real spot lines, in the shape every cluster emits. The relay does not parse
# these -- it forwards lines -- but the browser does, so the format matters.
SPOTS = [
    "DX de OK1ABC:     14074.0  JA1XYZ       FT8 -12 dB           1432Z JN79",
    "DX de DL2XYZ:      7035.5  OK1HRA       CW  599              1433Z JO60",
    "DX de G4ABC:      21074.0  VK3ABC       FT8 loud             1433Z IO91",
    "DX de SP9XYZ:     10136.0  W1AW         FT8 -05 dB           1434Z JO90",
    "DX de F5ABC:       3573.0  ZL1ABC       FT8 rare one         1435Z JN18",
]


def main():
    parser = argparse.ArgumentParser(description="Fake DX cluster")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7300)
    parser.add_argument("--interval", type=float, default=2.0,
                        help="seconds between spots")
    parser.add_argument("--seconds", type=float, default=0,
                        help="exit after this long (0 = run forever)")
    parser.add_argument("--call", default="TEST-DX", help="cluster node name")
    args = parser.parse_args()

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((args.host, args.port))
    server.listen(4)
    server.settimeout(0.5)
    print(f"fake DX cluster {args.call!r} on {args.host}:{args.port}", flush=True)

    clients = []          # (socket, logged_in, next_spot_time, spot_index)
    started = time.monotonic()

    while True:
        now = time.monotonic()
        if args.seconds and now - started > args.seconds:
            print("time limit reached", flush=True)
            return 0

        try:
            sock, addr = server.accept()
            sock.setblocking(False)
            # Clusters greet, then ask for a callsign and wait. The firmware's
            # login logic keys off exactly this prompt.
            sock.sendall(f"Welcome to the {args.call} DX cluster\r\n"
                         f"Please enter your call: ".encode())
            clients.append([sock, False, now + args.interval, 0])
            print(f"connect  {addr[0]}:{addr[1]}", flush=True)
        except socket.timeout:
            pass
        except OSError:
            pass

        for entry in list(clients):
            sock, logged_in, next_spot, index = entry
            try:
                data = sock.recv(4096)
                if data == b"":
                    raise ConnectionResetError
                text = data.decode(errors="replace").strip()
                if text:
                    if not logged_in:
                        entry[1] = True
                        print(f"login    {text!r}", flush=True)
                        sock.sendall(f"{text} de {args.call} >\r\n".encode())
                    else:
                        print(f"command  {text!r}", flush=True)
                        sock.sendall(f"{args.call} >\r\n".encode())
            except BlockingIOError:
                pass
            except (ConnectionResetError, BrokenPipeError, OSError):
                print("disconnect", flush=True)
                try:
                    sock.close()
                except OSError:
                    pass
                clients.remove(entry)
                continue

            if entry[1] and now >= next_spot:
                line = SPOTS[index % len(SPOTS)] + "\r\n"
                try:
                    sock.sendall(line.encode())
                except OSError:
                    continue
                entry[2] = now + args.interval
                entry[3] = index + 1
                if index == 0:
                    print("spots    streaming", flush=True)

        time.sleep(0.05)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\ninterrupted", flush=True)
