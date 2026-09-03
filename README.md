# IMU Flight-Control Test Rig — Phase 0

Measure whether orientation-only (IMU) input is actually usable for
flight-sim-style control **before buying any hardware.**

Your phone's IMU stands in for a controller. It streams raw orientation to your
Mac over WebSocket; the Mac maps it to flight axes and runs a tracking task and
a drift test. No microcontroller, no USB HID, no virtual joystick.

The two known objections get measured, not argued:

- **(a) no self-centering force** → neutral bias, and the minute-1 vs minute-5
  degradation over a 5-minute run
- **(b) yaw drift** → deg/min, measured separately for the drifting relative
  `alpha` and the fused `webkitCompassHeading`

Everything runs locally. Raw samples go to CSV so you can re-analyze without
re-running.

---

## Quick start

```bash
cd ~/imu-flight-rig
./run.sh
```

That prints a QR code and two URLs:

```
PHONE   https://192.168.2.54:8443/
MAC     http://localhost:8480/harness   (no cert warning)
```

The harness opens on your Mac automatically. Scan the QR with your iPhone
camera, or type the `PHONE` URL into Safari.

**On the phone, once:**

1. Safari says the certificate is not trusted. Tap **Show Details** →
   **visit this website** → **Visit Website**. This is your own self-signed
   certificate; the exception is remembered.
2. Tap the big **Start streaming** button.
3. Tap **Allow** on the motion-access prompt.

The sender page then shows a live rate in Hz. If it reads ~60, you are good.

> The phone must use HTTPS — iOS only grants motion access in a secure context.
> The Mac harness is served over plain HTTP on **loopback only**, because
> `localhost` is already a secure context and this saves you clicking through a
> browser certificate warning every session.

---

## Running the three measurements

Do them in this order. Each writes CSVs into `logs/`.

### 1. Drift test — 5 minutes

Set **Settings → Display & Brightness → Auto-Lock → Never** first.
Wave the phone in a figure-8 a few times to calibrate the magnetometer.
Put the phone flat on a table and **do not touch it**.

In the harness: **Drift** → **Start run**. Walk away for 5 minutes.

### 2. Mouse baseline — 5 minutes

This is what makes the IMU numbers mean anything. An RMS error of 4.2° tells
you nothing until you know what the same task scores with a different input on
the same day.

**Tracking** → **Mouse baseline** → **endurance 300s** → **Start run**, then
keep the aircraft symbol on the target ring using the pointer.

### 3. IMU tracking — 5 minutes

Hold the phone the way you would hold a controller, then press **Zero
attitude** — that posture becomes neutral. **Tracking** → **IMU** →
**endurance 300s** → **Start run**.

### Then

```bash
python3 analyze.py
```

This writes `REPORT.md` with every acceptance number, recomputed from the CSVs.

---

## Calibrating task difficulty

The **difficulty** slider scales the target path's amplitude and bandwidth
together. It is stored in the run's metadata, and `analyze.py` refuses to
compare two runs recorded at different difficulties.

Use the mouse baseline to calibrate:

- mouse baseline above ~90% on-target → task is saturating and cannot resolve
  degradation. **Raise difficulty**, re-run both conditions.
- mouse baseline below ~20% → too hard to resolve anything. **Lower it.**
- aim for the mouse landing around **60–80%** on-target.

`analyze.py` tells you which of these you are in.

---

## Keep the harness window focused

Chrome throttles `requestAnimationFrame` to about 1 Hz in an unfocused or
occluded window. That silently turns a tracking run into garbage. The harness
detects this and shows a red banner, and `analyze.py` marks such runs
**rejected** rather than reporting bogus numbers — but the fix is simply to
leave the harness window in front for the whole run.

---

## Verifying the rig without a phone

```bash
python3 server.py --selftest
```

Drives the real WSS transport with a synthetic phone whose clock is
deliberately skewed by 37 seconds, injects a known yaw drift rate and a known
operator tracking error, then checks that the analysis recovers what was
injected. It restores your saved mapping config afterwards.

The clock-skew check is the important one. Phone and Mac clocks are unrelated,
so latency **cannot** be measured by subtracting them. The rig runs an
NTP-style handshake over the same socket and uses the offset from the
minimum-RTT exchange. If that were broken, the self-test would report ~37 000 ms
of latency instead of ~1 ms.

---

## What gets logged

| file | contents |
|---|---|
| `logs/raw_<runid>.csv` | every sample: both clocks, both yaw sources, mapped axes |
| `logs/sync_<runid>.csv` | every clock-sync exchange: RTT and offset |
| `logs/run_<runid>.csv` | per-frame target vs actual vs error, on-target flag |
| `logs/meta_<runid>.json` | mapping config, difficulty, device, mode, duration |

`analyze.py --list` lists recorded runs; `analyze.py --run <runid>` reports one.

---

## Mapping

Per axis, in order: normalize to ±range → **deadzone** (rescaled, so output is
continuous at the edge rather than stepping) → **expo** (`k·x³ + (1−k)·x`) →
**sensitivity** → clamp.

Roll comes from `gamma`, pitch from `beta`, yaw from `alpha`. Every parameter is
adjustable live from the harness and is snapshotted into each run's metadata, so
a result is always traceable to the mapping that produced it.

**Zero attitude** captures your current posture as neutral. Yaw needs this:
`alpha` is 0–360 with no inherent zero, so "centre" is wherever you declare it.
This is objection (a) in miniature — there is no mechanical zero to return to.

---

## The tracking task

The target follows a **sum of sines** — four non-harmonic frequencies per axis
with fixed phases. This is the standard forcing function in manual-control
research: exactly repeatable across runs with no seed handling, and its
frequency content will not accidentally coincide with your own control
bandwidth the way a random-walk path can. A 3-second ramp-in avoids a step at
t=0, and the first 5 seconds are discarded from the statistics.

The mouse baseline is **2-axis** (roll + pitch) — a mouse has no third axis, so
the head-to-head comparison uses those two axes only. Yaw is reported for the
IMU alone.

---

## Troubleshooting

| symptom | cause |
|---|---|
| Motion prompt never appears | Page must be HTTPS and the button tapped directly. `requestPermission()` only works from a real user gesture. |
| Permission granted, no data | **Settings → Safari → Motion & Orientation Access** must be on. |
| Rate well below 60 Hz | Low Power Mode, or the tab is backgrounded. Safari throttles background tabs. |
| Compass reads `n/a` | Not an iPhone, or no magnetometer. Yaw falls back to relative `alpha`. |
| `webkitCompassAccuracy` is −1 | Magnetometer uncalibrated — figure-8 the phone. |
| Phone can't load the URL | Different Wi-Fi network, or the router has client isolation on. |
| Drift run ends early | Auto-Lock. Set it to Never. |
| Port already in use | The rig is already running: `pkill -f server.py` |

---

## Deliberately not done

No virtual HID device or joystick. macOS has no vJoy equivalent and `foohid` is
unmaintained. **The harness is the target** — this rig does not try to drive a
real simulator, and it does not need to in order to answer the question.
