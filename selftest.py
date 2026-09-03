#!/usr/bin/env python3
"""Synthetic end-to-end verification. No phone required.

Drives the real WSS transport with a fake phone whose clock is deliberately
skewed by 37 seconds, injects a known yaw drift rate and a known operator
tracking error, then checks that the analysis recovers what was injected.

The clock-skew case is the important one: if the latency estimator were
subtracting two unsynchronised clocks it would report ~37 s instead of ~1 ms.
"""

import asyncio
import json
import math
import random
import ssl
import subprocess
import sys
import time

import websockets

# ---- injected ground truth
SKEW_MS = 37000.0          # the fake phone's clock runs 37 s fast
DRIFT_DEG_MIN = 2.40       # relative alpha drifts this fast
SENSOR_NOISE = 0.12        # deg, on every axis
COMPASS_JITTER = 0.45      # deg, fused heading: jitter but no drift
RATE_HZ = 60.0
OP_TAU = 0.30              # operator first-order lag, seconds
OP_NOISE = 1.20            # operator remnant, deg

ALPHA0, BETA0, GAMMA0, COMPASS0 = 137.0, 4.0, -2.0, 137.0

# Must match web/harness.js SOS.
SOS = {
    "roll":  (22.0, [(0.0503, 0.00), (0.0829, 1.13), (0.1341, 2.31), (0.2170, 0.74)]),
    "pitch": (15.0, [(0.0619, 2.02), (0.1002, 0.41), (0.1621, 1.77), (0.2623, 2.95)]),
    "yaw":   (25.0, [(0.0387, 1.31), (0.0700, 2.63), (0.1132, 0.22), (0.1832, 1.94)]),
}
RAMP = 3.0
DIFFICULTY = 1.0     # must match the difficulty pushed to the server below


def target(axis, t):
    amp, comps = SOS[axis]
    s = sum(math.sin(2 * math.pi * f * DIFFICULTY * t + p) for f, p in comps)
    return amp * DIFFICULTY * (s / 2.5) * (t / RAMP if t < RAMP else 1.0)


def ctx():
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    return c


class FakePhone:
    """Speaks the exact protocol web/sender.html speaks, on a skewed clock."""

    def __init__(self, url):
        self.url = url
        self.ws = None
        self.seq = 0
        self.best_offset = None
        self.min_rtt = None
        self.syncs = []
        self.mode = "idle"
        self.t0 = 0.0

    def now(self):
        return time.time() * 1000.0 + SKEW_MS      # the phone's (wrong) clock

    async def connect(self):
        self.ws = await websockets.connect(self.url, ssl=ctx(), max_queue=512)
        await self.ws.send(json.dumps({"type": "hello", "ua": "selftest/synthetic"}))
        asyncio.create_task(self.reader())
        asyncio.create_task(self.pinger())

    async def reader(self):
        try:
            async for raw in self.ws:
                m = json.loads(raw)
                if m.get("type") == "pong":
                    t2 = self.now()
                    t0, t1 = m["t0"], m["t1"]
                    rtt = t2 - t0
                    off = ((t1 - t0) + (t1 - t2)) / 2.0
                    self.syncs.append((rtt, off))
                    if len(self.syncs) > 16:
                        self.syncs.pop(0)
                    best = min(self.syncs, key=lambda x: x[0])
                    self.min_rtt, self.best_offset = best[0], best[1]
                    await self.ws.send(json.dumps(
                        {"type": "sync", "t0": t0, "t1": t1, "t2": t2, "rtt": rtt,
                         "offset": off, "bestOffset": self.best_offset,
                         "minRtt": self.min_rtt}))
        except Exception:
            pass

    async def pinger(self):
        try:
            while True:
                await self.ws.send(json.dumps({"type": "ping", "t0": self.now()}))
                await asyncio.sleep(1.0)
        except Exception:
            pass

    async def stream(self, mode, secs):
        self.mode, self.t0 = mode, time.time()
        dt = 1.0 / RATE_HZ
        n = int(secs * RATE_HZ)
        for i in range(n):
            # Wall-clock elapsed, NOT i*dt: asyncio.sleep overshoots, so a
            # nominal-rate time base would drift seconds away from the
            # harness's clock and decorrelate the two forcing functions.
            t = time.time() - self.t0
            g = random.gauss
            if mode == "drift":
                alpha = ALPHA0 + (DRIFT_DEG_MIN / 60.0) * t + g(0, SENSOR_NOISE)
                beta = BETA0 + g(0, SENSOR_NOISE)
                gamma = GAMMA0 + g(0, SENSOR_NOISE)
                compass = COMPASS0 + g(0, COMPASS_JITTER)
            else:
                alpha = ALPHA0 + self.op["yaw"] + g(0, SENSOR_NOISE)
                beta = self.op["pitch"] + g(0, SENSOR_NOISE)
                gamma = self.op["roll"] + g(0, SENSOR_NOISE)
                compass = COMPASS0 + self.op["yaw"] + g(0, COMPASS_JITTER)
                self.step_operator(t, dt)
            sent = self.now()
            await self.ws.send(json.dumps({
                "type": "s", "seq": self.seq, "sentAt": sent,
                "eventTs": sent - 4.0, "handlerDelay": abs(g(4.0, 1.2)),
                "alpha": alpha % 360.0, "beta": beta, "gamma": gamma,
                "compass": compass % 360.0, "compassAcc": 12.0,
                "absolute": False, "source": "deviceorientation",
                "offset": self.best_offset, "minRtt": self.min_rtt}))
            self.seq += 1
            await asyncio.sleep(dt)

    op = {"roll": 0.0, "pitch": 0.0, "yaw": 0.0}

    def step_operator(self, t, dt):
        """First-order lag toward the target plus remnant noise."""
        k = dt / OP_TAU
        for ax in ("roll", "pitch", "yaw"):
            tgt = target(ax, t)
            self.op[ax] += k * (tgt - self.op[ax]) + random.gauss(0, OP_NOISE * math.sqrt(dt))


class FakeHarness:
    """Speaks the /ctl protocol web/harness.js speaks."""

    def __init__(self, url):
        self.url = url
        self.ws = None
        self.t0 = None
        self.recording = False
        self.last = None

    async def connect(self):
        self.ws = await websockets.connect(self.url, ssl=ctx(), max_queue=512)
        asyncio.create_task(self.reader())

    async def reader(self):
        try:
            async for raw in self.ws:
                m = json.loads(raw)
                if m.get("type") != "sample":
                    continue
                self.last = m
                if not self.recording:
                    continue
                t = time.time() - self.t0
                tr, tp, ty = target("roll", t), target("pitch", t), target("yaw", t)
                er, ep = m["roll"] - tr, m["pitch"] - tp
                ey = ((m["yaw"] - ty + 540) % 360) - 180
                mag = math.sqrt((er * er + ep * ep + ey * ey) / 3.0)
                await self.ws.send(json.dumps({
                    "type": "frame", "wallMs": time.time() * 1000.0, "t": round(t, 4),
                    "input": "imu", "tr": tr, "tp": tp, "ty": ty,
                    "ar": m["roll"], "ap": m["pitch"], "ay": m["yaw"],
                    "er": er, "ep": ep, "ey": ey,
                    "on": mag <= 5.0, "age": abs(random.gauss(9.0, 2.0))}))
        except Exception:
            pass

    async def send(self, o):
        await self.ws.send(json.dumps(o))


async def run(rig, port, secs):
    base = "wss://127.0.0.1:%d" % port
    print("\n[selftest] synthetic end-to-end verification")
    print("[selftest] injected: clock skew %+.0f ms, yaw drift %.2f deg/min, "
          "operator tau %.2f s" % (SKEW_MS, DRIFT_DEG_MIN, OP_TAU))

    saved = rig.mapper.snapshot()      # selftest must not clobber config.json
    harness = FakeHarness(base + "/ctl")
    await harness.connect()
    # Identity mapping so injected degrees survive the pipeline unchanged.
    flat = {"deadzone": 0.0, "expo": 0.0, "sensitivity": 1.0}
    await harness.send({"type": "config",
                        "patch": {"roll": dict(flat, range=60.0),
                                  "pitch": dict(flat, range=45.0),
                                  "yaw": dict(flat, range=60.0),
                                  "difficulty": DIFFICULTY,
                                  "tolerance_deg": 5.0}})

    phone = FakePhone(base + "/ws")
    await phone.connect()
    await asyncio.sleep(2.2)                     # let clock sync converge

    drift_s = max(20.0, secs * 0.45)
    track_s = max(20.0, secs * 0.55)

    print("[selftest] phase 1/2: drift, %.0f s" % drift_s)
    await harness.send({"type": "start_run", "mode": "drift", "input": "imu",
                        "duration": drift_s, "label": "selftest"})
    await asyncio.sleep(0.3)
    await phone.stream("drift", drift_s)
    await harness.send({"type": "stop_run"})
    await asyncio.sleep(0.4)

    print("[selftest] phase 2/2: tracking, %.0f s" % track_s)
    await harness.send({"type": "start_run", "mode": "track", "input": "imu",
                        "duration": track_s, "label": "selftest"})
    await asyncio.sleep(0.3)
    # Start the harness clock at the same instant the phone starts streaming,
    # or the two would evaluate the forcing function 0.3 s apart and the
    # synthetic tracking error would be dominated by that offset.
    harness.t0 = time.time()
    harness.recording = True
    await phone.stream("track", track_s)
    harness.recording = False
    await harness.send({"type": "stop_run"})
    await asyncio.sleep(0.6)

    try:
        await phone.ws.close()
        await harness.ws.close()
    except Exception:
        pass
    rig.mapper.update(saved)           # restore the mapping we came in with

    return verify()


def verify():
    import analyze
    metas = [m for m in analyze.runs() if m.get("label") == "selftest"]
    if len(metas) < 2:
        print("[selftest] FAIL: expected 2 runs, found %d" % len(metas))
        return 1
    res = [analyze.analyze_run(m) for m in metas]
    drift = next((r for r in res if r["meta"]["mode"] == "drift"), None)
    track = next((r for r in res if r["meta"]["mode"] == "track"), None)

    print("\n" + "=" * 66)
    print("  SELF-TEST: injected vs recovered")
    print("=" * 66)
    ok = True

    def check(label, injected, got, tol, unit=""):
        nonlocal ok
        good = got is not None and abs(got - injected) <= tol
        ok = ok and good
        print("  %-34s inj %9.3f%-4s got %9.3f%-4s  %s"
              % (label, injected, unit, (got if got is not None else float("nan")),
                 unit, "PASS" if good else "FAIL"))

    if drift:
        a = drift["drift"].get("alpha (relative, gyro-integrated)")
        c = drift["drift"].get("compass (fused, absolute)")
        if a:
            check("yaw drift, relative alpha", DRIFT_DEG_MIN, a["deg_per_min"], 0.35, " d/m")
        if c:
            check("yaw drift, fused compass", 0.0, c["deg_per_min"], 0.60, " d/m")
        s = drift["sync"]
        if s:
            check("clock offset (= -skew)", -SKEW_MS, s["offset_med"], 60.0, " ms")
        lat = drift["latency"].get("handler -> Mac (transport)")
        if lat is not None and lat.size:
            med = float(__import__("numpy").median(lat))
            good = -5.0 < med < 250.0
            ok = ok and good
            print("  %-34s              transport median %8.2f ms  %s"
                  % ("latency survives 37 s skew", med, "PASS" if good else "FAIL"))
        r = drift["rate"]
        if r:
            check("sample rate", RATE_HZ, r["median_hz"], 12.0, " Hz")

    if track and track["track"]:
        t = track["track"]
        print("  %-34s              combined RMS     %8.2f deg" % ("tracking metrics computed", t["combined_rms"]))
        print("  %-34s              on target        %8.1f %%" % ("", t["on_target_pct"]))
        good = 0.5 < t["combined_rms"] < 25.0 and t["axes"]
        ok = ok and good
        print("  %-34s                                          %s"
              % ("tracking pipeline", "PASS" if good else "FAIL"))
    else:
        ok = False
        print("  tracking metrics                                              FAIL")

    print("=" * 66)
    print("  %s" % ("ALL CHECKS PASSED" if ok else "SOME CHECKS FAILED"))
    print("=" * 66 + "\n")
    return 0 if ok else 1
