#!/usr/bin/env python3
"""Offline analysis of logged runs. Recomputes every metric from the CSVs, so
results can be re-derived without re-running anything.

Usage:
    python3 analyze.py                # report on every run, write REPORT.md
    python3 analyze.py --run <runid>
    python3 analyze.py --list
"""

import argparse
import csv
import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
LOGS = os.path.join(HERE, "logs")

SETTLE_S = 10.0     # drift: discard the first 10 s while the sensor settles
TRACK_SKIP_S = 5.0  # tracking: discard ramp-in


# --------------------------------------------------------------------- helpers

def read_csv(path):
    if not os.path.exists(path):
        return {}
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return {}
    cols = {}
    for k in rows[0].keys():
        vals = []
        for r in rows:
            v = r.get(k, "")
            if v is None or v == "" or v == "None":
                vals.append(np.nan)
            else:
                try:
                    vals.append(float(v))
                except ValueError:
                    vals.append(np.nan)
        cols[k] = np.array(vals, dtype=float)
    cols["_str"] = {k: [r.get(k, "") for r in rows] for k in rows[0].keys()}
    cols["_n"] = len(rows)
    return cols


def finite(a):
    return a[np.isfinite(a)] if a is not None and a.size else np.array([])


def pct(a, q):
    a = finite(a)
    return float(np.percentile(a, q)) if a.size else float("nan")


def fmt(v, n=2, unit=""):
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return "n/a"
    return ("%." + str(n) + "f%s") % (v, unit)


def runs():
    out = []
    for p in sorted(glob.glob(os.path.join(LOGS, "meta_*.json"))):
        try:
            with open(p) as f:
                out.append(json.load(f))
        except (OSError, ValueError):
            pass
    return out


# ----------------------------------------------------------------------- drift

def drift_axis(t, deg):
    """Least-squares slope of the unwrapped angle. Returns deg/min + shape."""
    ok = np.isfinite(t) & np.isfinite(deg)
    t, deg = t[ok], deg[ok]
    if t.size < 30:
        return None
    t = t - t[0]
    keep = t >= SETTLE_S
    if keep.sum() < 30:
        keep = np.ones_like(t, dtype=bool)
    t, deg = t[keep], deg[keep]

    # A sensor that stops updating produces a perfect zero slope, which reads
    # as "no drift" but is really "no data". iOS does exactly this with
    # webkitCompassHeading when the device is perfectly still. Catch it.
    uniq = int(np.unique(deg).size)
    if uniq <= 1:
        return {"frozen": True, "value": float(deg[0]), "n": int(deg.size),
                "span_s": float(t[-1] - t[0])}
    stale_frac = uniq / float(deg.size)

    u = np.unwrap(deg, period=360.0)
    u = u - u[0]
    slope, _ = np.polyfit(t, u, 1)          # deg per second
    # Excursion on a ~1 Hz decimation: summing |diff| at full rate just
    # integrates sensor noise and tells you nothing about actual wander.
    nbin = max(2, int(round(t[-1] - t[0])))
    idx = np.clip(((t - t[0]) / (t[-1] - t[0] + 1e-9) * nbin).astype(int), 0, nbin - 1)
    coarse = np.array([u[idx == b].mean() for b in range(nbin) if np.any(idx == b)])
    resid = u - np.polyval([slope, np.mean(u) - slope * np.mean(t)], t)
    return {
        "deg_per_min": slope * 60.0,
        "span_s": float(t[-1] - t[0]),
        "max_abs_dev": float(np.max(np.abs(u))),
        "total_excursion": float(np.sum(np.abs(np.diff(coarse)))),
        "resid_std": float(np.std(resid)),
        "n": int(t.size),
        "stale_frac": stale_frac,
    }


def drift_disturbed(out):
    """A stationary phone holds pitch and roll to well under a degree. If it
    did not, the phone was handled and the run is not a drift measurement --
    the yaw slope it produces will look plausible and mean nothing."""
    worst = 0.0
    for name, d in out.items():
        if d.get("frozen"):
            continue
        if name.startswith("beta") or name.startswith("gamma"):
            worst = max(worst, d["max_abs_dev"])
    return worst if worst > 5.0 else None


def analyze_drift(raw):
    t = raw.get("arrival_wall_ms")
    if t is None:
        return {}
    t = t / 1000.0
    out = {}
    for name, col in (("alpha (relative, gyro-integrated)", "alpha"),
                      ("compass (fused, absolute)", "compass"),
                      ("beta (pitch)", "beta"),
                      ("gamma (roll)", "gamma")):
        if col in raw:
            d = drift_axis(t, raw[col])
            if d:
                out[name] = d
    return out


# --------------------------------------------------------------------- latency

def analyze_latency(raw, run):
    out = {}
    hd = finite(raw.get("handler_delay_ms", np.array([])))
    # iOS Safari stamps DeviceOrientationEvent.timeStamp at dispatch, not at
    # sensor acquisition, so this reads a hard zero. That is a missing
    # measurement, not a 0 ms measurement -- do not report it as one.
    if hd.size and float(np.mean(hd == 0)) < 0.95:
        out["sensor -> handler"] = hd
    elif hd.size:
        out["!unmeasurable sensor -> handler"] = hd

    sent = raw.get("sent_at_ms")
    arr = raw.get("arrival_wall_ms")
    off = raw.get("clock_offset_ms")
    if sent is not None and arr is not None and off is not None:
        # Clock-corrected one-way transport. offset = MacClock - PhoneClock,
        # so the sample's send instant in Mac time is (sent_at + offset).
        transport = arr - (sent + off)
        out["handler -> Mac (transport)"] = finite(transport)

    if run and "sample_age_ms" in run:
        age = finite(run["sample_age_ms"])
        # A negative render latency is physically impossible: it means the
        # harness clock and the server clock disagree. Flag it rather than
        # reporting a nonsense number.
        if age.size and np.median(age) < -1.0:
            out["!Mac arrival -> render"] = age
        elif age.size:
            out["Mac arrival -> render"] = age

    if ("sensor -> handler" in out and "handler -> Mac (transport)" in out):
        n = min(out["sensor -> handler"].size, out["handler -> Mac (transport)"].size)
        tot = out["sensor -> handler"][:n] + out["handler -> Mac (transport)"][:n]
        if out.get("Mac arrival -> render") is not None and out["Mac arrival -> render"].size:
            tot = tot + float(np.median(out["Mac arrival -> render"]))
        out["END-TO-END (sensor -> pixels)"] = tot
    return out


def analyze_rate(raw):
    arr = finite(raw.get("arrival_wall_ms", np.array([])))
    if arr.size < 10:
        return None
    dt = np.diff(arr) / 1000.0
    dt = dt[(dt > 0) & (dt < 1.0)]
    if not dt.size:
        return None
    return {"mean_hz": 1.0 / float(np.mean(dt)),
            "median_hz": 1.0 / float(np.median(dt)),
            "n": int(arr.size),
            "duration_s": float((arr[-1] - arr[0]) / 1000.0),
            "worst_gap_ms": float(np.max(np.diff(arr)))}


# -------------------------------------------------------------------- tracking

def analyze_track(run):
    if not run or "elapsed_s" not in run:
        return None
    t = run["elapsed_s"]
    keep = np.isfinite(t) & (t >= TRACK_SKIP_S)
    if keep.sum() < 30:
        # Do not silently drop it -- a run this short is almost always a
        # throttled harness loop, and the user needs to be told.
        n = int(np.isfinite(t).sum())
        dur = float(np.nanmax(t)) if t.size else 0.0
        return {"rejected": True, "frames": n, "duration_s": dur,
                "fps": (n / dur) if dur > 0 else None}

    axes = {}
    for ax, ecol, acol in (("roll", "err_roll", "act_roll"),
                           ("pitch", "err_pitch", "act_pitch"),
                           ("yaw", "err_yaw", "act_yaw")):
        e = run.get(ecol)
        if e is None:
            continue
        ek = e[keep]
        ek = ek[np.isfinite(ek)]
        if ek.size < 30:
            continue
        a = run.get(acol)
        ak = finite(a[keep]) if a is not None else np.array([])
        axes[ax] = {
            "rms": float(np.sqrt(np.mean(ek ** 2))),
            "mean_abs": float(np.mean(np.abs(ek))),
            "p95_abs": float(np.percentile(np.abs(ek), 95)),
            # Neutral bias: mean commanded deflection. A self-centring stick
            # averages ~0; a hand-held phone accumulates postural offset.
            "neutral_bias": float(np.mean(ak)) if ak.size else float("nan"),
            "n": int(ek.size),
        }

    if not axes:
        return None

    allsq = []
    for ax in axes:
        e = run["err_" + ax][keep]
        allsq.append(e[np.isfinite(e)] ** 2)
    combined = float(np.sqrt(np.mean(np.concatenate(allsq))))

    ot = run.get("on_target")
    on_pct = float(100.0 * np.nanmean(ot[keep])) if ot is not None else float("nan")

    # minute 1 vs the final minute
    tk = t[keep]
    tmax = float(tk[-1])
    # Harness frame rate. A run recorded at a throttled rAF (unfocused window)
    # is not a valid measurement, so it must be visible in the report.
    # Effective rate (frames / elapsed), not the median interval: a run that
    # stalls for 10 s and then bursts still has a healthy-looking median.
    tk_all = t[np.isfinite(t)]
    span = float(tk_all[-1] - tk_all[0]) if tk_all.size > 1 else 0.0
    fps = (tk_all.size / span) if span > 0 else None

    res = {"axes": axes, "combined_rms": combined, "on_target_pct": on_pct,
           "duration_s": tmax, "fatigue": None, "fps": fps}
    if tmax >= 180:
        def window_rms(lo, hi):
            m = keep & (t >= lo) & (t < hi)
            sq = []
            for ax in axes:
                e = run["err_" + ax][m]
                e = e[np.isfinite(e)]
                if e.size:
                    sq.append(e ** 2)
            return float(np.sqrt(np.mean(np.concatenate(sq)))) if sq else float("nan")
        m1 = window_rms(TRACK_SKIP_S, 65.0)
        m5 = window_rms(max(TRACK_SKIP_S, tmax - 60.0), tmax + 1)
        res["fatigue"] = {"minute1_rms": m1, "final_minute_rms": m5,
                          "delta": m5 - m1,
                          "pct": (100.0 * (m5 - m1) / m1) if m1 else float("nan"),
                          "final_window": [max(0.0, tmax - 60.0), tmax]}
    return res


# ---------------------------------------------------------------------- flight

def analyze_flight(fl, meta):
    """Course run: gates, crashes, time, path, and control effort."""
    if not fl or "t" not in fl:
        return None
    t = finite(fl["t"])
    if t.size < 30:
        return None
    gates = finite(fl.get("gates", np.array([])))
    missed = finite(fl.get("missed", np.array([])))
    z = finite(fl.get("z", np.array([])))
    eff = finite(fl.get("effort", np.array([])))
    v = finite(fl.get("v", np.array([])))
    stall = finite(fl.get("stall", np.array([])))
    eng = finite(fl.get("engine", np.array([])))

    # Effective frame rate of the flight loop; a paused tab shows up here.
    span = float(t[-1] - t[0]) if t.size > 1 else 0.0
    hz = (t.size / span) if span > 0 else None

    # Path efficiency: distance actually flown vs straight-line course length.
    x = finite(fl.get("x", np.array([])))
    y = finite(fl.get("y", np.array([])))
    n = min(x.size, y.size, z.size)
    flown = float(np.sum(np.sqrt(np.diff(x[:n]) ** 2 + np.diff(y[:n]) ** 2 +
                                 np.diff(z[:n]) ** 2))) if n > 1 else 0.0
    reached = float(z[-1]) if z.size else 0.0

    return {
        "gates": int(gates[-1]) if gates.size else 0,
        "missed": int(missed[-1]) if missed.size else 0,
        "time_s": float(t[-1]),
        "reached_m": reached,
        "flown_m": flown,
        "efficiency": (reached / flown) if flown > 0 else float("nan"),
        # Control effort: how hard the input works, deg/s. With no spring to
        # hold neutral you pay continuously just to stay put -- this is
        # objection (a) as a single number.
        "effort": float(eff[-1]) if eff.size else float("nan"),
        "mean_speed": float(np.mean(v)) if v.size else float("nan"),
        "stall_pct": float(100.0 * np.mean(stall)) if stall.size else 0.0,
        "glide_pct": float(100.0 * np.mean(eng == 0)) if eng.size else 0.0,
        "hz": hz,
        "seed": meta.get("seed"),
        "difficulty": (meta.get("config") or {}).get("difficulty", 1.0),
    }


# ------------------------------------------------------------------ per-run job

def analyze_run(meta):
    rid = meta["runid"]
    raw = read_csv(os.path.join(LOGS, "raw_%s.csv" % rid))
    run = read_csv(os.path.join(LOGS, "run_%s.csv" % rid))
    sync = read_csv(os.path.join(LOGS, "sync_%s.csv" % rid))
    fl = read_csv(os.path.join(LOGS, "flight_%s.csv" % rid))
    r = {"flight": analyze_flight(fl, meta) if fl else None,
         "meta": meta, "rate": analyze_rate(raw) if raw else None,
         "latency": analyze_latency(raw, run) if raw else {},
         "drift": analyze_drift(raw) if raw else {},
         "track": analyze_track(run) if run else None,
         "sync": None}
    if sync and "offset_ms" in sync:
        o = finite(sync["offset_ms"]); rr = finite(sync.get("rtt_ms", np.array([])))
        if o.size:
            r["sync"] = {"n": int(o.size), "offset_med": float(np.median(o)),
                         "offset_spread": float(np.std(o)),
                         "rtt_med": float(np.median(rr)) if rr.size else float("nan"),
                         "rtt_min": float(np.min(rr)) if rr.size else float("nan")}
    return r


# ---------------------------------------------------------------------- report

def render(results):
    L = []
    w = L.append
    w("# IMU Flight-Control Rig — Measured Results\n")
    w("Hypothesis under test: *orientation-only (IMU) input is acceptable for "
      "flight-sim-style control.*\n")
    w("Every number below is recomputed from the CSVs in `logs/`.\n")

    drift_runs = [r for r in results if r["meta"]["mode"] == "drift"]
    def usable(r):
        return r["track"] and not r["track"].get("rejected")

    imu_runs = [r for r in results if r["meta"]["mode"] == "track"
                and r["meta"]["input"] == "imu" and r["track"]]
    mouse_runs = [r for r in results if r["meta"]["mode"] == "track"
                  and r["meta"]["input"] == "mouse" and r["track"]]
    ok_imu = [r for r in imu_runs if usable(r)]
    ok_mouse = [r for r in mouse_runs if usable(r)]

    # -- 1. drift
    w("\n## 1. Yaw drift (objection b)\n")
    if not drift_runs:
        w("_No drift run recorded yet._\n")
    for r in drift_runs:
        w("\n**`%s`** — %s s, %d samples\n" % (
            r["meta"]["runid"], fmt(r["meta"].get("elapsed_s"), 0),
            (r["rate"] or {}).get("n", 0)))
        moved = drift_disturbed(r["drift"])
        if moved is not None:
            w("> **Rejected — the phone was moved.** Pitch/roll deviated by up to "
              "%s during the run; a phone lying untouched holds both to well under "
              "a degree. Any yaw slope from this run is measuring your hand, not "
              "sensor drift. Re-run with the phone flat on a table and do not "
              "touch it.\n" % fmt(moved, 1, "°"))
            continue
        w("\n| axis | drift (deg/min) | max deviation | excursion | residual sd |")
        w("|---|---|---|---|---|")
        frozen = []
        for name, d in r["drift"].items():
            if d.get("frozen"):
                frozen.append((name, d))
                w("| %s | _no data_ | _no data_ | _no data_ | _no data_ |" % name)
                continue
            w("| %s | **%s** | %s | %s | %s |%s" % (
                name, fmt(d["deg_per_min"], 3), fmt(d["max_abs_dev"], 2, "°"),
                fmt(d["total_excursion"], 1, "°"), fmt(d["resid_std"], 2, "°"),
                "  <!-- stale -->" if d.get("stale_frac", 1) < 0.01 else ""))
        w("")
        for name, d in frozen:
            w("> **`%s` produced no usable data.** The value was frozen at %s° for "
              "all %d samples over %s s — the sensor stopped updating, which is "
              "not the same as not drifting. On iOS this is expected for "
              "`webkitCompassHeading`: CoreLocation suppresses heading updates "
              "when the device is perfectly still, so a phone lying untouched on "
              "a table reports one constant heading forever. **Drift of this "
              "source cannot be measured by a stationary test.**\n"
              % (name, fmt(d["value"], 4), d["n"], fmt(d["span_s"], 0)))
        a = r["drift"].get("alpha (relative, gyro-integrated)")
        c = r["drift"].get("compass (fused, absolute)")
        if (a and c and not a.get("frozen") and not c.get("frozen")
                and drift_disturbed(r["drift"]) is None):
            w("> Relative `alpha` drifts at **%s deg/min**; fused compass heading at "
              "**%s deg/min**. The compass residual sd of %s is jitter, not drift — "
              "which is the distinction that decides whether objection (b) is a real "
              "blocker or a filtering problem.\n" % (
                  fmt(a["deg_per_min"], 3), fmt(c["deg_per_min"], 3),
                  fmt(c["resid_std"], 2, "°")))

    # -- 2. latency
    w("\n## 2. End-to-end latency\n")
    lat_runs = [r for r in results if r["latency"]]
    if not lat_runs:
        w("_No latency data yet._\n")
    for r in lat_runs[-3:]:
        w("\n**`%s`**\n" % r["meta"]["runid"])
        if r["sync"]:
            w("Clock sync: %d exchanges, offset median %s ms (sd %s ms), "
              "min RTT %s ms.\n" % (r["sync"]["n"], fmt(r["sync"]["offset_med"], 1),
                                    fmt(r["sync"]["offset_spread"], 2),
                                    fmt(r["sync"]["rtt_min"], 2)))
        w("| stage | median (ms) | p95 (ms) | n |")
        w("|---|---|---|---|")
        notes = []
        for stage, arr in r["latency"].items():
            if not arr.size:
                continue
            if stage.startswith("!"):
                notes.append(stage)
                continue
            w("| %s | **%s** | %s | %d |" % (stage, fmt(pct(arr, 50)),
                                             fmt(pct(arr, 95)), arr.size))
        for nstage in notes:
            if "unmeasurable" in nstage:
                w("\n> `sensor -> handler` is **not measurable on iOS**: Safari "
                  "stamps `DeviceOrientationEvent.timeStamp` at dispatch rather "
                  "than at sensor acquisition, so it reads a hard zero. The "
                  "true sensor-to-handler time is unknown and is *not* included "
                  "in the totals below.\n")
            else:
                med = float(np.median(r["latency"][nstage]))
                w("\n> `Mac arrival -> render` came out **%s ms** -- negative, so "
                  "physically impossible. The harness and server clocks "
                  "disagreed on this run. Fixed; re-run to get this stage.\n"
                  % fmt(med, 0))
        if r["rate"]:
            w("\nSample rate: %s Hz median (%s Hz mean), worst gap %s ms.\n" % (
                fmt(r["rate"]["median_hz"], 1), fmt(r["rate"]["mean_hz"], 1),
                fmt(r["rate"]["worst_gap_ms"], 1)))

    # -- 3. tracking
    w("\n## 3. Tracking performance\n")
    if not ok_imu:
        w("_No usable IMU tracking run recorded yet._\n")

    def track_table(r):
        t = r["track"]
        if t.get("rejected"):
            w("\n**`%s`** — **rejected.** Only %d frames over %s s (%s Hz). The "
              "browser throttled the harness control loop, which happens when the "
              "window is unfocused or occluded. Re-run with the harness window "
              "focused and in front.\n" % (
                  r["meta"]["runid"], t["frames"], fmt(t["duration_s"], 0),
                  fmt(t.get("fps"), 1)))
            return
        diff = (r["meta"].get("config") or {}).get("difficulty", 1.0)
        w("\n**`%s`** — %s s, difficulty %s, combined RMS **%s°**, on-target **%s%%**\n" % (
            r["meta"]["runid"], fmt(t["duration_s"], 0), fmt(diff, 2),
            fmt(t["combined_rms"]), fmt(t["on_target_pct"], 1)))
        if t["duration_s"] < 60:
            w("> **Too short to interpret.** %s s of data. The slowest component "
              "of the forcing function has a 26 s period, so a run under ~60 s "
              "does not cover even two cycles — the score depends mostly on which "
              "part of the path you happened to catch. Use the full run length.\n"
              % fmt(t["duration_s"], 0))
        if t.get("fps") is not None:
            if t["fps"] < 30:
                w("> **This run is not trustworthy.** The harness logged only %s "
                  "frames/s — the browser throttled the control loop, which happens "
                  "when the window is unfocused or occluded. Re-run with the harness "
                  "window focused and in front.\n" % fmt(t["fps"], 1))
            else:
                w("Harness frame rate: %s Hz.\n" % fmt(t["fps"], 1))
        w("| axis | RMS error | mean abs | p95 abs | neutral bias |")
        w("|---|---|---|---|---|")
        for ax, d in t["axes"].items():
            w("| %s | **%s** | %s | %s | %s |" % (
                ax, fmt(d["rms"], 2, "°"), fmt(d["mean_abs"], 2, "°"),
                fmt(d["p95_abs"], 2, "°"), fmt(d["neutral_bias"], 2, "°")))
        w("")

    for r in imu_runs:
        track_table(r)
    if mouse_runs:
        w("\n### Mouse baseline (2-axis: roll + pitch)\n")
        for r in mouse_runs:
            track_table(r)

    if ok_imu and ok_mouse:
        i, m = ok_imu[-1]["track"], ok_mouse[-1]["track"]
        def two_axis(t):
            sq = [t["axes"][a]["rms"] ** 2 for a in ("roll", "pitch") if a in t["axes"]]
            return float(np.sqrt(np.mean(sq))) if sq else float("nan")
        ir, mr = two_axis(i), two_axis(m)
        di = (ok_imu[-1]["meta"].get("config") or {}).get("difficulty", 1.0)
        dm = (ok_mouse[-1]["meta"].get("config") or {}).get("difficulty", 1.0)
        w("\n### Head-to-head (roll + pitch only)\n")
        if abs(di - dm) > 1e-6:
            w("> **Not comparable.** These runs used different task difficulties "
              "(%s vs %s). Re-run both at the same difficulty.\n" % (fmt(di, 2), fmt(dm, 2)))
        w("| input | RMS error | on-target % | neutral bias (roll) |")
        w("|---|---|---|---|")
        for lbl, t, rr in (("IMU (phone)", i, ir), ("Mouse", m, mr)):
            w("| %s | **%s°** | %s | %s |" % (
                lbl, fmt(rr, 2), fmt(t["on_target_pct"], 1),
                fmt(t["axes"].get("roll", {}).get("neutral_bias", float("nan")), 2, "°")))
        if np.isfinite(ir) and np.isfinite(mr) and mr > 0:
            w("\n> IMU tracking error is **%.2f×** the mouse baseline on the same "
              "task and the same forcing function.\n" % (ir / mr))
        if m["on_target_pct"] > 90:
            w("\n> **Calibration note:** the mouse baseline is on-target %s%% of the "
              "time. The task is saturating, so it cannot resolve degradation. Raise "
              "`difficulty` until the mouse baseline lands around 60-80%%, then re-run "
              "both conditions.\n" % fmt(m["on_target_pct"], 1))
        elif m["on_target_pct"] < 20:
            w("\n> **Calibration note:** the mouse baseline is only on-target %s%% of "
              "the time — the task is too hard to resolve anything. Lower `difficulty`.\n"
              % fmt(m["on_target_pct"], 1))

    # -- 4. fatigue
    w("\n## 4. Degradation, minute 1 -> minute 5 (objection a)\n")
    fat = [r for r in results if usable(r) and r["track"]["fatigue"]]
    if not fat:
        w("_Needs an `endurance` (300 s) run — a 90 s `quick` run has no minute 5._\n")
    for r in fat:
        f = r["track"]["fatigue"]
        w("\n**`%s`** (%s)\n" % (r["meta"]["runid"], r["meta"]["input"]))
        w("| window | RMS error |")
        w("|---|---|")
        w("| minute 1 (%.0f–65 s) | %s |" % (TRACK_SKIP_S, fmt(f["minute1_rms"], 2, "°")))
        w("| final minute (%.0f–%.0f s) | %s |" % (f["final_window"][0],
                                                   f["final_window"][1],
                                                   fmt(f["final_minute_rms"], 2, "°")))
        w("| change | **%s° (%s%%)** |" % (fmt(f["delta"], 2), fmt(f["pct"], 1)))
        w("")

    # -- course flight
    w("\n## 5. Course flight\n")
    fruns = [r for r in results if r.get("flight")]
    if not fruns:
        w("_No course runs yet. Fly one at `/flight`._\n")
    else:
        w("A gated course with a canyon, buildings, wind, a fog section and a "
          "dead-stick finish. Terrain, gate positions and the gust sequence all "
          "come from one seed, so every run faces the same course and the same "
          "gusts at the same moments.\n")
        w("| run | input | gates | crashed | reached | time | effort (°/s) | path eff. |")
        w("|---|---|---|---|---|---|---|---|")
        for r in fruns:
            f = r["flight"]
            crashed = "—" if f["reached_m"] >= 6300 else "yes"
            w("| `%s` | %s | **%d**/15 | %s | %s m | %s s | **%s** | %s |" % (
                r["meta"]["runid"], r["meta"]["input"], f["gates"], crashed,
                fmt(f["reached_m"], 0), fmt(f["time_s"], 1),
                fmt(f["effort"], 1), fmt(f["efficiency"], 3)))
        w("")
        for r in fruns:
            f = r["flight"]
            if f["hz"] is not None and f["hz"] < 20:
                w("> **`%s` ran at only %s frames/s.** The browser paused or "
                  "throttled the flight loop, so this run is not comparable.\n"
                  % (r["meta"]["runid"], fmt(f["hz"], 1)))

        fi = [r for r in fruns if r["meta"]["input"] == "imu"]
        fm = [r for r in fruns if r["meta"]["input"] == "mouse"]
        if fi and fm:
            a, b = fi[-1]["flight"], fm[-1]["flight"]
            if a["seed"] != b["seed"] or abs(a["difficulty"] - b["difficulty"]) > 1e-9:
                w("> **Not comparable.** Different seed or difficulty "
                  "(seed %s/%s, difficulty %s/%s). Re-fly both on the same "
                  "settings.\n" % (a["seed"], b["seed"],
                                    fmt(a["difficulty"], 2), fmt(b["difficulty"], 2)))
            else:
                w("\n### Head-to-head — same seed, same gusts\n")
                w("| | IMU | mouse |")
                w("|---|---|---|")
                w("| gates | **%d**/15 | **%d**/15 |" % (a["gates"], b["gates"]))
                w("| distance reached | %s m | %s m |" % (fmt(a["reached_m"], 0),
                                                          fmt(b["reached_m"], 0)))
                w("| control effort | **%s °/s** | **%s °/s** |" % (fmt(a["effort"], 1),
                                                                    fmt(b["effort"], 1)))
                w("| path efficiency | %s | %s |" % (fmt(a["efficiency"], 3),
                                                     fmt(b["efficiency"], 3)))
                w("| time in stall | %s%% | %s%% |" % (fmt(a["stall_pct"], 1),
                                                       fmt(b["stall_pct"], 1)))
                if np.isfinite(a["effort"]) and np.isfinite(b["effort"]) and b["effort"] > 0:
                    w("\n> Flying with the phone costs **%.2f×** the control "
                      "activity of the mouse on an identical course. That "
                      "multiplier is the price of having no spring to hold "
                      "neutral.\n" % (a["effort"] / b["effort"]))
                w("\n> One asymmetry, stated plainly: the mouse gets rudder on the "
                  "A/D keys while the phone gets it as a third tilt axis. The "
                  "heading gates are the one place the two inputs are not "
                  "strictly equivalent.\n")

    w("\n## 6. Neutral bias — the cost of no self-centring\n")
    nb = [r for r in results if usable(r)]
    if not nb:
        w("_No tracking runs yet._\n")
    else:
        w("A self-centring stick returns to a mechanical zero, so mean commanded "
          "deflection over a run is ~0. Orientation control has no such zero: any "
          "postural drift shows up here directly.\n")
        w("| run | input | roll bias | pitch bias | yaw bias |")
        w("|---|---|---|---|---|")
        for r in nb:
            ax = r["track"]["axes"]
            w("| `%s` | %s | %s | %s | %s |" % (
                r["meta"]["runid"], r["meta"]["input"],
                fmt(ax.get("roll", {}).get("neutral_bias", float("nan")), 2, "°"),
                fmt(ax.get("pitch", {}).get("neutral_bias", float("nan")), 2, "°"),
                fmt(ax.get("yaw", {}).get("neutral_bias", float("nan")), 2, "°")))
        w("")
    return "\n".join(L)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run", default=None)
    p.add_argument("--list", action="store_true")
    p.add_argument("--out", default=os.path.join(HERE, "REPORT.md"))
    p.add_argument("--quiet", action="store_true")
    a = p.parse_args()

    metas = runs()
    if a.list:
        for m in metas:
            print("%-42s mode=%-6s input=%-5s %ss  raw=%s" % (
                m["runid"], m["mode"], m["input"], m.get("elapsed_s", "?"),
                (m.get("counts") or {}).get("raw", "?")))
        return 0
    if a.run:
        metas = [m for m in metas if m["runid"] == a.run]
    if not metas:
        print("no runs found in %s" % LOGS)
        return 1

    results = [analyze_run(m) for m in metas]
    text = render(results)
    with open(a.out, "w") as f:
        f.write(text)
    if not a.quiet:
        print(text)
    print("\n[analyze] wrote %s  (%d run(s))" % (a.out, len(results)), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
