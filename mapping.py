"""Orientation -> flight axis mapping.

Pipeline per axis, in this order:
    raw angle -> zero reference -> normalize to [-1,1] -> deadzone (rescaled)
              -> expo -> sensitivity -> clamp -> output degrees

The deadzone is *rescaled*, not subtractive-with-a-step: output stays
continuous at the deadzone edge, so there is no jump as you leave centre.
"""

import json
import math
import os
import threading

AXES = ("roll", "pitch", "yaw")

DEFAULTS = {
    # gamma = left/right tilt, beta = front/back tilt, alpha = compass rotation
    "roll":  {"source": "gamma", "range": 60.0, "deadzone": 0.05, "expo": 0.30,
              "sensitivity": 1.0, "invert": False},
    "pitch": {"source": "beta",  "range": 45.0, "deadzone": 0.05, "expo": 0.30,
              "sensitivity": 1.0, "invert": False},
    "yaw":   {"source": "alpha", "range": 60.0, "deadzone": 0.08, "expo": 0.30,
              "sensitivity": 1.0, "invert": False},
    "tolerance_deg": 5.0,
    "difficulty": 1.0,
}


def wrap180(x):
    """Wrap degrees into (-180, 180]."""
    return (x + 180.0) % 360.0 - 180.0


def deadzone(x, dz):
    """Rescaled deadzone: continuous at the edge."""
    if dz <= 0.0:
        return x
    a = abs(x)
    if a <= dz:
        return 0.0
    return math.copysign((a - dz) / (1.0 - dz), x)


def expo(x, k):
    """k=0 linear, k=1 pure cubic. Monotonic for k in [0,1]."""
    return k * x * x * x + (1.0 - k) * x


def clamp(x, lo=-1.0, hi=1.0):
    return lo if x < lo else (hi if x > hi else x)


def apply_axis(raw_deg, cfg):
    """Raw degrees (already zero-referenced) -> (normalized [-1,1], degrees)."""
    rng = float(cfg.get("range", 60.0)) or 60.0
    x = clamp(raw_deg / rng)
    if cfg.get("invert"):
        x = -x
    x = deadzone(x, float(cfg.get("deadzone", 0.0)))
    x = expo(x, float(cfg.get("expo", 0.0)))
    x = clamp(x * float(cfg.get("sensitivity", 1.0)))
    return x, x * rng


class Mapper:
    """Thread-safe live-adjustable mapper. Config edits apply immediately."""

    def __init__(self, path=None):
        self.path = path
        self.lock = threading.Lock()
        self.cfg = json.loads(json.dumps(DEFAULTS))
        # Zero reference captured by zero(); yaw especially needs one, since
        # alpha is 0..360 and "centre" is wherever you declare it.
        self.ref = {"alpha": None, "beta": 0.0, "gamma": 0.0, "compass": None}
        self.zeroed = False   # did the user ever press Zero attitude?
        if path and os.path.exists(path):
            try:
                with open(path) as f:
                    self.update(json.load(f), persist=False)
            except (OSError, ValueError):
                pass

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self.cfg))

    def update(self, patch, persist=True):
        with self.lock:
            for k, v in (patch or {}).items():
                if k in AXES and isinstance(v, dict):
                    self.cfg.setdefault(k, {}).update(v)
                elif k in self.cfg or k in ("tolerance_deg", "difficulty"):
                    self.cfg[k] = v
            cfg = json.loads(json.dumps(self.cfg))
        if persist and self.path:
            try:
                tmp = self.path + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(cfg, f, indent=2)
                os.replace(tmp, self.path)
            except OSError:
                pass
        return cfg

    def zero(self, sample):
        """Capture the current attitude as neutral."""
        with self.lock:
            self.zeroed = True
            for key, field in (("alpha", "alpha"), ("beta", "beta"),
                               ("gamma", "gamma"), ("compass", "compass")):
                v = sample.get(field)
                if v is not None:
                    self.ref[key] = float(v)
            return dict(self.ref)

    def zero_ref(self):
        with self.lock:
            return dict(self.ref)

    def _referenced(self, sample):
        """Raw angles relative to the captured neutral, in degrees."""
        ref = self.ref
        out = {}
        a = sample.get("alpha")
        if a is not None:
            # Latch a reference on the first sample: alpha is 0..360 with no
            # inherent zero, so without this yaw would read 0 until zeroed.
            if ref["alpha"] is None:
                ref["alpha"] = float(a)
            out["alpha"] = wrap180(float(a) - ref["alpha"])
        c = sample.get("compass")
        if c is not None:
            if ref["compass"] is None:
                ref["compass"] = float(c)
            out["compass"] = wrap180(float(c) - ref["compass"])
        b = sample.get("beta")
        if b is not None:
            out["beta"] = wrap180(float(b) - (ref["beta"] or 0.0))
        g = sample.get("gamma")
        if g is not None:
            out["gamma"] = wrap180(float(g) - (ref["gamma"] or 0.0))
        return out

    def map(self, sample):
        """Sample dict -> {'roll':{'n':..,'deg':..}, ...} plus the referenced raws."""
        with self.lock:
            cfg = self.cfg
            rel = self._referenced(sample)
            out = {"rel": rel}
            for axis in AXES:
                src = cfg[axis].get("source", "gamma")
                raw = rel.get(src)
                if raw is None:
                    out[axis] = {"n": 0.0, "deg": 0.0, "raw": None}
                    continue
                n, deg = apply_axis(raw, cfg[axis])
                out[axis] = {"n": n, "deg": deg, "raw": raw}
            out["tolerance_deg"] = float(cfg.get("tolerance_deg", 5.0))
            return out
