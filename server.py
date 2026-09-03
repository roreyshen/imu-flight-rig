#!/usr/bin/env python3
"""Phase 0 IMU flight-control test rig -- Mac-side server.

Serves the phone sender page, the harness page, and BOTH WebSocket endpoints
on a single TLS port. That is not a stylistic choice: iOS grants a
self-signed-certificate exception per host:port, so a WebSocket on a second
port would fail its TLS check silently, with no error visible on the phone.
"""

import argparse
import asyncio
import csv
import json
import os
import socket
import ssl
import subprocess
import sys
import time
import webbrowser
from datetime import datetime, timezone

from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
LOGS = os.path.join(HERE, "logs")
CERTS = os.path.join(HERE, "certs")
CONFIG = os.path.join(HERE, "config.json")

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json",
        ".svg": "image/svg+xml", ".ico": "image/x-icon"}

RAW_HEADER = [
    "seq", "sent_at_ms", "arrival_wall_ms", "arrival_mono_s", "event_ts_ms",
    "handler_delay_ms", "alpha", "beta", "gamma", "compass", "compass_acc",
    "absolute", "source", "clock_offset_ms", "min_rtt_ms",
    "rel_alpha", "rel_compass", "rel_beta", "rel_gamma",
    "roll_n", "pitch_n", "yaw_n", "roll_deg", "pitch_deg", "yaw_deg",
]
SYNC_HEADER = ["wall_ms", "t0", "t1", "t2", "rtt_ms", "offset_ms",
               "best_offset_ms", "min_rtt_ms"]
RUN_HEADER = ["wall_ms", "elapsed_s", "input",
              "tgt_roll", "tgt_pitch", "tgt_yaw",
              "act_roll", "act_pitch", "act_yaw",
              "err_roll", "err_pitch", "err_yaw",
              "on_target", "sample_age_ms"]


# ----------------------------------------------------------------- csv logging

class CsvLog:
    """Buffered CSV writer. Flushed on a timer so the hot path adds no jitter."""

    def __init__(self, path, header):
        self.path = path
        self.f = open(path, "w", newline="")
        self.w = csv.writer(self.f)
        self.w.writerow(header)
        self.n = 0

    def row(self, values):
        self.w.writerow(values)
        self.n += 1

    def flush(self):
        try:
            self.f.flush()
        except (OSError, ValueError):
            pass

    def close(self):
        try:
            self.f.flush()
            self.f.close()
        except (OSError, ValueError):
            pass


class Run:
    """One recording session: raw samples, clock-sync samples, harness frames."""

    def __init__(self, runid, mode, inp, duration, label, cfg):
        self.id = runid
        self.mode = mode
        self.input = inp
        self.duration = duration
        self.label = label
        self.started_wall = time.time()
        self.raw = CsvLog(os.path.join(LOGS, "raw_%s.csv" % runid), RAW_HEADER)
        self.sync = CsvLog(os.path.join(LOGS, "sync_%s.csv" % runid), SYNC_HEADER)
        self.frames = CsvLog(os.path.join(LOGS, "run_%s.csv" % runid), RUN_HEADER)
        self.meta_path = os.path.join(LOGS, "meta_%s.json" % runid)
        self.meta = {
            "runid": runid, "mode": mode, "input": inp,
            "duration_s": duration, "label": label,
            "started_utc": datetime.fromtimestamp(self.started_wall, timezone.utc).isoformat(),
            "config": cfg, "user_agent": None, "zero_ref": None,
        }
        self.write_meta()

    def write_meta(self):
        with open(self.meta_path, "w") as f:
            json.dump(self.meta, f, indent=2)

    def flush(self):
        self.raw.flush(); self.sync.flush(); self.frames.flush()

    def close(self):
        self.meta["ended_utc"] = datetime.now(timezone.utc).isoformat()
        self.meta["elapsed_s"] = round(time.time() - self.started_wall, 3)
        self.meta["counts"] = {"raw": self.raw.n, "sync": self.sync.n,
                               "frames": self.frames.n}
        self.write_meta()
        self.raw.close(); self.sync.close(); self.frames.close()


# ----------------------------------------------------------------------- state

class Rig:
    def __init__(self, mapper):
        self.mapper = mapper
        self.run = None
        self.ctl = set()          # harness connections
        self.senders = set()      # phone connections
        self.seq_seen = 0
        self.rate_window = []
        self.last_sample = None

    # -- run control -------------------------------------------------------
    def start_run(self, mode, inp, duration, label, ua=None):
        if self.run:
            self.stop_run()
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        runid = "%s_%s_%s" % (stamp, mode, inp)
        self.run = Run(runid, mode, inp, duration, label, self.mapper.snapshot())
        self.run.meta["user_agent"] = ua
        self.run.meta["zero_ref"] = self.mapper.zero_ref()
        self.run.write_meta()
        log("run started: %s (%ss)" % (runid, duration))
        return self.run

    def stop_run(self):
        if not self.run:
            return None
        r = self.run
        r.close()
        self.run = None
        log("run stopped: %s  raw=%d sync=%d frames=%d"
            % (r.id, r.raw.n, r.sync.n, r.frames.n))
        return r

    def status(self):
        return {
            "type": "status",
            "run": ({"id": self.run.id, "mode": self.run.mode,
                     "input": self.run.input, "duration": self.run.duration,
                     "elapsed": round(time.time() - self.run.started_wall, 2),
                     "raw": self.run.raw.n, "frames": self.run.frames.n}
                    if self.run else None),
            "config": self.mapper.snapshot(),
            "zero_ref": self.mapper.zero_ref(),
            "senders": len(self.senders),
            "rate_hz": self.rate_hz(),
        }

    def rate_hz(self):
        now = time.monotonic()
        self.rate_window = [t for t in self.rate_window if now - t < 1.0]
        return len(self.rate_window)

    async def broadcast(self, payload):
        if not self.ctl:
            return
        msg = json.dumps(payload)
        dead = []
        for ws in list(self.ctl):
            try:
                await ws.send(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.ctl.discard(ws)


def log(msg):
    print("[rig] %s" % msg, flush=True)


# ------------------------------------------------------------- sample handling

async def handle_sample(rig, m, arrival_wall, arrival_mono):
    rig.rate_window.append(time.monotonic())
    mapped = rig.mapper.map({
        "alpha": m.get("alpha"), "beta": m.get("beta"),
        "gamma": m.get("gamma"), "compass": m.get("compass"),
    })
    rel = mapped["rel"]

    if rig.run:
        rig.run.raw.row([
            m.get("seq"), m.get("sentAt"), round(arrival_wall, 3), round(arrival_mono, 6),
            m.get("eventTs"), m.get("handlerDelay"),
            m.get("alpha"), m.get("beta"), m.get("gamma"),
            m.get("compass"), m.get("compassAcc"),
            1 if m.get("absolute") else 0, m.get("source"),
            m.get("offset"), m.get("minRtt"),
            rel.get("alpha"), rel.get("compass"), rel.get("beta"), rel.get("gamma"),
            mapped["roll"]["n"], mapped["pitch"]["n"], mapped["yaw"]["n"],
            mapped["roll"]["deg"], mapped["pitch"]["deg"], mapped["yaw"]["deg"],
        ])

    out = {
        "type": "sample", "seq": m.get("seq"),
        "arrivalWallMs": arrival_wall,
        "roll": mapped["roll"]["deg"], "pitch": mapped["pitch"]["deg"],
        "yaw": mapped["yaw"]["deg"],
        "rollN": mapped["roll"]["n"], "pitchN": mapped["pitch"]["n"],
        "yawN": mapped["yaw"]["n"],
        "rel": rel, "raw": {"alpha": m.get("alpha"), "beta": m.get("beta"),
                            "gamma": m.get("gamma"), "compass": m.get("compass"),
                            "compassAcc": m.get("compassAcc")},
        "offset": m.get("offset"), "minRtt": m.get("minRtt"),
        "rateHz": rig.rate_hz(), "source": m.get("source"),
    }
    rig.last_sample = out
    await rig.broadcast(out)


async def sender_handler(rig, ws):
    rig.senders.add(ws)
    log("sender connected (%s)" % (ws.remote_address,))
    await rig.broadcast(rig.status())
    try:
        async for raw in ws:
            arrival_wall = time.time() * 1000.0
            arrival_mono = time.perf_counter()
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            t = m.get("type")
            if t == "s":
                await handle_sample(rig, m, arrival_wall, arrival_mono)
            elif t == "ping":
                # t1 must be the SAME epoch-ms basis the phone uses.
                await ws.send(json.dumps({"type": "pong", "t0": m.get("t0"),
                                          "t1": time.time() * 1000.0}))
            elif t == "sync":
                if rig.run:
                    rig.run.sync.row([round(arrival_wall, 3), m.get("t0"), m.get("t1"),
                                      m.get("t2"), m.get("rtt"), m.get("offset"),
                                      m.get("bestOffset"), m.get("minRtt")])
            elif t == "hello":
                if rig.run and not rig.run.meta.get("user_agent"):
                    rig.run.meta["user_agent"] = m.get("ua")
                    rig.run.write_meta()
                await ws.send(json.dumps({"type": "hello_ack"}))
    except Exception as e:
        log("sender error: %r" % (e,))
    finally:
        rig.senders.discard(ws)
        log("sender disconnected")
        await rig.broadcast(rig.status())


async def ctl_handler(rig, ws):
    rig.ctl.add(ws)
    await ws.send(json.dumps(rig.status()))
    try:
        async for raw in ws:
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            t = m.get("type")
            if t == "frame":
                if rig.run:
                    rig.run.frames.row([
                        round(m.get("wallMs", 0.0), 3), m.get("t"), m.get("input"),
                        m.get("tr"), m.get("tp"), m.get("ty"),
                        m.get("ar"), m.get("ap"), m.get("ay"),
                        m.get("er"), m.get("ep"), m.get("ey"),
                        1 if m.get("on") else 0, m.get("age"),
                    ])
            elif t == "start_run":
                r = rig.start_run(m.get("mode", "track"), m.get("input", "imu"),
                                  float(m.get("duration", 90)), m.get("label", ""))
                await rig.broadcast({"type": "run_started", "runid": r.id})
                await rig.broadcast(rig.status())
            elif t == "stop_run":
                r = rig.stop_run()
                await rig.broadcast({"type": "run_stopped",
                                     "runid": r.id if r else None})
                await rig.broadcast(rig.status())
            elif t == "config":
                rig.mapper.update(m.get("patch") or {})
                await rig.broadcast(rig.status())
            elif t == "zero":
                s = rig.last_sample
                if s:
                    rig.mapper.zero({"alpha": s["raw"].get("alpha"),
                                     "beta": s["raw"].get("beta"),
                                     "gamma": s["raw"].get("gamma"),
                                     "compass": s["raw"].get("compass")})
                await rig.broadcast(rig.status())
            elif t == "status":
                await ws.send(json.dumps(rig.status()))
    except Exception:
        pass
    finally:
        rig.ctl.discard(ws)


# ---------------------------------------------------------------- static files

def static_response(path):
    if path in ("/", "/sender", "/index.html"):
        rel = "sender.html"
    elif path in ("/harness", "/harness.html"):
        rel = "harness.html"
    else:
        rel = path.lstrip("/")
    target = os.path.abspath(os.path.join(WEB, rel))
    if not target.startswith(os.path.abspath(WEB) + os.sep) or not os.path.isfile(target):
        body = b"not found"
        return Response(404, "Not Found",
                        Headers([("Content-Type", "text/plain"),
                                 ("Content-Length", str(len(body)))]), body)
    with open(target, "rb") as f:
        body = f.read()
    ext = os.path.splitext(target)[1]
    return Response(200, "OK", Headers([
        ("Content-Type", MIME.get(ext, "application/octet-stream")),
        ("Content-Length", str(len(body))),
        ("Cache-Control", "no-store"),
    ]), body)


# ----------------------------------------------------------------------- setup

def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):
    cert = os.path.join(CERTS, "cert.pem")
    key = os.path.join(CERTS, "key.pem")
    marker = os.path.join(CERTS, ".cert_ip")
    have = os.path.exists(cert) and os.path.exists(key)
    same = have and os.path.exists(marker) and open(marker).read().strip() == ip
    if not same:
        log("generating certificate for %s ..." % ip)
        subprocess.check_call([os.path.join(CERTS, "gen_cert.sh"), ip])
    return cert, key


def print_banner(ip, port, http_port):
    url = "https://%s:%d/" % (ip, port)
    print()
    print("=" * 58)
    print("  IMU flight-control test rig")
    print("=" * 58)
    try:
        import segno
        segno.make(url, error="m").terminal(compact=True, border=2)
    except ImportError:
        print("  (install `segno` for a QR code)")
    print("  PHONE   %s" % url)
    print("  MAC     http://localhost:%d/harness   (no cert warning)" % http_port)
    print()
    print("  Safari will warn about the certificate. Tap")
    print("    Show Details -> visit this website -> Visit Website")
    print("=" * 58)
    print(flush=True)


async def flusher(rig):
    while True:
        await asyncio.sleep(2.0)
        if rig.run:
            rig.run.flush()


async def main_async(args):
    os.makedirs(LOGS, exist_ok=True)
    import mapping
    rig = Rig(mapping.Mapper(CONFIG))

    ip = args.host_ip or lan_ip()
    cert, key = ensure_cert(ip)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)

    async def router(ws):
        path = (ws.request.path or "/").split("?")[0]
        if path == "/ws":
            await sender_handler(rig, ws)
        elif path == "/ctl":
            await ctl_handler(rig, ws)
        else:
            await ws.close()

    def process_request(connection, request):
        path = (request.path or "/").split("?")[0]
        if path in ("/ws", "/ctl"):
            return None            # let the WebSocket handshake proceed
        return static_response(path)

    # The phone needs HTTPS (iOS grants motion access only in a secure
    # context). The Mac harness does not: localhost is already a secure
    # context over plain HTTP, so serving it on loopback avoids making you
    # click through a certificate interstitial every single session.
    # Bound to 127.0.0.1, so it is never reachable from the LAN.
    async with serve(router, "0.0.0.0", args.port, ssl=ctx,
                     process_request=process_request,
                     ping_interval=20, ping_timeout=20,
                     max_queue=256, compression=None), \
               serve(router, "127.0.0.1", args.http_port,
                     process_request=process_request,
                     ping_interval=20, ping_timeout=20,
                     max_queue=256, compression=None):
        print_banner(ip, args.port, args.http_port)
        asyncio.create_task(flusher(rig))
        if args.selftest:
            import selftest
            code = await selftest.run(rig, args.port, args.selftest_secs)
            rig.stop_run()
            return code
        if not args.no_open:
            webbrowser.open("http://localhost:%d/harness" % args.http_port)
        await asyncio.Future()
    return 0


def main():
    p = argparse.ArgumentParser(description="IMU flight-control test rig")
    p.add_argument("--port", type=int, default=8443,
                   help="HTTPS/WSS port for the phone (LAN)")
    p.add_argument("--http-port", type=int, default=8480,
                   help="plain HTTP port for the Mac harness (loopback only)")
    p.add_argument("--host-ip", default=None, help="override detected LAN IP")
    p.add_argument("--no-open", action="store_true")
    p.add_argument("--selftest", action="store_true",
                   help="run a synthetic end-to-end verification and exit")
    p.add_argument("--selftest-secs", type=float, default=45.0)
    args = p.parse_args()
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("\n[rig] bye")
        return 0
    except OSError as e:
        if e.errno == 48:
            print("\n[rig] port %d or %d is already in use -- the rig is probably\n"
                  "      already running. Stop it with:  pkill -f 'server.py'\n"
                  "      or start this one on other ports:  ./run.sh --port 9443 "
                  "--http-port 9480" % (args.port, args.http_port), file=sys.stderr)
            return 2
        raise


if __name__ == "__main__":
    sys.exit(main() or 0)
