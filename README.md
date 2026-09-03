# IMU Flight-Control Test Rig — Phase 0

**Question:** is orientation-only input (tilting a phone) good enough to fly with?

**Approach:** measure it before buying any hardware. Your phone's IMU stands in
for a controller. It streams raw orientation to a Mac over WebSocket; the Mac
maps it to flight axes and runs a tracking task and a drift test. No
microcontroller, no USB HID, no virtual joystick.

Two objections get measured instead of argued:

- **(a) no self-centering force** — there is no spring pulling back to neutral.
  Measured as *neutral bias* and as degradation from minute 1 to minute 5.
- **(b) yaw drift** — measured in degrees per minute.

Everything runs locally. Raw samples land in CSV so results can be re-derived
without re-running anything.

---

## What you need

- A Mac and an iPhone **on the same Wi-Fi**
- Python 3 (already on macOS)
- About 20 minutes

---

## Start it

```bash
cd ~/imu-flight-rig
./run.sh
```

You'll get a QR code and two addresses:

```
PHONE   https://192.168.x.x:8443/
MAC     http://localhost:8480/harness   (no cert warning)
COURSE  http://localhost:8480/flight
```

The harness opens on the Mac by itself. On the phone, scan the QR with the
Camera app or type the `PHONE` address into Safari.

**On the phone, once:**

1. Safari warns about the certificate. Tap **Show Details** → **visit this
   website** → **Visit Website**. It's your own self-signed certificate, made
   on your Mac 30 seconds ago. Safari remembers the exception.
2. Tap **Start streaming**.
3. Tap **Allow** on the motion prompt.

The page then shows a live rate. **If it reads about 60 Hz you're good.** If it
doesn't, see Troubleshooting.

---

## Run the tests

The harness has a **Protocol** panel listing four steps and ticking them off as
you complete them. Follow it top to bottom. It exists because every one of
these is easy to get wrong, and a wrong run produces a plausible-looking number
rather than an obvious error.

### 1. Calibrate difficulty — Mouse baseline, quick 90s

Chase the target ring with the mouse pointer for the **full 90 seconds**.
Look at ON TARGET:

- above 90% → task is too easy to detect anything. Raise **difficulty**, repeat.
- below 20% → too hard. Lower it.
- **60–80% → correct.** Stop adjusting and don't touch the slider again.

Both later tracking runs must use this same difficulty. The analysis refuses to
compare runs recorded at different settings.

### 2. Mouse baseline — endurance 300s

Same thing for 5 minutes. This is your control condition. Without it, an IMU
error of 9° means nothing, because you don't know what *any* input scores on
this task.

### 3. IMU tracking — endurance 300s

Hold the phone the way you'd actually fly it. **Press Zero attitude.** That
posture is now neutral. Then start, and fly for 5 minutes.

If you skip zeroing, the rig treats *flat on a table* as neutral and you spend
the whole run fighting a constant offset. The harness will stop you and make
you confirm.

### 4. Drift test — 300s

Wave the phone in a figure-8 a few times to calibrate the magnetometer. Set
**Settings → Display & Brightness → Auto-Lock → Never**. Put the phone flat on
a table and **do not touch it for 5 minutes.** Not even once.

### 5 and 6. Fly the course — mouse, then IMU

Open **http://localhost:8480/flight**.

A 6.4 km course with 15 gates: open country, then a canyon, then a city, then a
fog bank, then the engine quits and you glide the last kilometre. Fly it once
with the mouse and once with the phone.

This is the part that actually answers the question. Chasing a ring on an
artificial horizon measures a narrow thing well; flying a course measures
whether tilt control is *usable*, which is what you wanted to know.

**Controls** — the phone's tilt is a *commanded* attitude, and the airframe
follows it through a lag, so the plane has inertia and you can overshoot. The
faint blue bar near the reticle shows what you're commanding versus what the
aircraft is actually doing; the gap between them is the lag you're flying
against. Banking turns you. Pull up too steeply and you stall.

For the mouse baseline: pointer position steers, `A`/`D` are the rudder.

**Gates** — yellow rings you fly through. **Blue** rings additionally demand a
heading: you must cross within 15° of the arrow, which is what puts the yaw
axis under test. Miss a gate and it turns red.

**Hazards, and what each one is testing:**

| hazard | why it's there |
|---|---|
| Gates and canyon walls | sustained precise holding — where the missing spring hurts most |
| Buildings | tight lateral precision at speed, with a hard fail |
| Wind and turbulence | no force feedback: with a stick you *feel* the correction, with tilt you don't |
| Heading gates | the yaw axis specifically |
| Fog and night | long concentration with a degraded visual reference |
| Engine failure | a dead-stick glide, no throttle, one approach |

**The course is identical every run.** Terrain, gate positions, building
placement and the gust sequence all come from a single seed, and gusts are
indexed by elapsed time rather than by frame, so two runs hit the same gust at
the same second even at different frame rates. That is what makes the IMU and
mouse runs comparable. `analyze.py` refuses to compare runs recorded on
different seeds or difficulties.

### Then

```bash
python3 analyze.py
```

Writes `REPORT.md` with every number, recomputed from the CSVs.

---

## Four ways to waste a run

The rig detects all of these and says so, rather than reporting a number that
looks fine. Every one of them happened during the first real session.

| mistake | what it does | how you find out |
|---|---|---|
| **Stopping early** | The slowest part of the target path has a 26-second period. A 20-second run scores on whichever piece you happened to catch. | Stop asks for a second click; report marks runs under 60 s as uninterpretable |
| **Not zeroing** | You fight a constant offset all run. One real run showed a 9.9° pitch bias from this alone. | Start refuses the first click and tells you |
| **Touching the phone during a drift test** | Yaw slope measures your hand, not the sensor. One run drifted "0.108 deg/min" while pitch swung 49°. | Report rejects the run if pitch or roll moved more than 5° |
| **Letting the window lose focus** | Chrome throttles the control loop to about 1 Hz — and pauses it entirely in a hidden tab. One run logged 8 frames in 20 seconds. | Red banner during the run; report marks it rejected |

---

## Two things iOS will not tell you

Both were discovered by running this, not by reading documentation.

**`webkitCompassHeading` freezes when the phone is still.** iOS suppresses
heading updates from a stationary device, so a phone lying untouched reports
one constant value forever. A constant series fits a *perfect zero slope*,
which reads as "no drift" but actually means "no data." **Compass drift cannot
be measured by a stationary test.** The report says so instead of printing a
zero. It matters less than it sounds, since in real use the phone is always
moving.

**Sensor-to-handler latency is not observable.** Safari stamps
`DeviceOrientationEvent.timeStamp` at dispatch, not at sensor acquisition, so
that stage reads a hard zero. It's reported as unmeasurable and excluded from
the totals rather than contributing a fake 0 ms.

---

## Why the design is the way it is

**One TLS port for the phone.** iOS grants self-signed certificate exceptions
per host:port. A WebSocket on a second port fails its TLS check *silently* —
no error visible on the phone. So the page and both sockets share 8443.

**A separate plain-HTTP port for the Mac.** `localhost` is already a secure
context, so the harness doesn't need TLS, and serving it over HTTP on loopback
saves clicking through a browser certificate warning every session. Bound to
127.0.0.1, never reachable from the network.

**Clock sync, not subtraction.** The phone's clock and the Mac's are unrelated
and can differ by minutes. Latency comes from an NTP-style handshake over the
same socket, using the offset from the minimum-RTT exchange. `--selftest`
proves it: with a phone clock deliberately skewed 37 seconds, it still reports
sub-millisecond transport latency.

**Canvas, not WebGL, for the course.** The world is real 3D — perspective
projection, near-plane clipping, depth-sorted painter's algorithm — drawn with
canvas 2D primitives. No dependency to vendor, no build step, and a predictable
frame rate, which matters in a rig whose whole job is measuring latency. The
tradeoff is per-primitive rather than per-pixel depth, so a gate ring can
occasionally show through a building edge.

**Sum-of-sines target path.** Four non-harmonic frequencies per axis with fixed
phases — the standard forcing function in manual-control research. Exactly
repeatable with no seed handling, and its frequency content won't accidentally
line up with your own control bandwidth the way a random walk can.

---

## Verify the rig without a phone

```bash
python3 server.py --selftest
```

Drives the real encrypted transport with a synthetic phone on a 37-second-skewed
clock, injects a known drift rate and a known tracking error, and checks the
analysis recovers them. Restores your saved config afterwards. Takes about a
minute.

---

## What gets logged

| file | contents |
|---|---|
| `logs/raw_<runid>.csv` | every sample: both clocks, both yaw sources, mapped axes |
| `logs/sync_<runid>.csv` | every clock-sync exchange: RTT and offset |
| `logs/run_<runid>.csv` | per-frame target vs actual vs error, on-target flag |
| `logs/flight_<runid>.csv` | course runs: position, attitude, commanded attitude, wind, gates, effort |
| `logs/meta_<runid>.json` | mapping config, difficulty, seed, mode, duration, zero reference |

`analyze.py --list` lists runs. `analyze.py --run <runid>` reports just one.

---

## Mapping

Per axis, in order: normalize to ±range → **deadzone** (rescaled, so the output
is continuous at the edge instead of stepping) → **expo** (`k·x³ + (1−k)·x`) →
**sensitivity** → clamp.

Roll from `gamma`, pitch from `beta`, yaw from `alpha`. Every parameter is
adjustable live and is snapshotted into the run metadata, so a result always
traces back to the mapping that produced it.

---

## Troubleshooting

| symptom | fix |
|---|---|
| Motion prompt never appears | Must be HTTPS, and the button tapped directly. `requestPermission()` only works from a real tap. |
| Allowed it, still no data | **Settings → Safari → Motion & Orientation Access** must be on. |
| Rate well under 60 Hz | Low Power Mode off; keep the Safari tab in the foreground. |
| Compass shows `n/a` | Not an iPhone, or no magnetometer. Yaw falls back to relative `alpha`. |
| `webkitCompassAccuracy` is −1 | Magnetometer uncalibrated — figure-8 the phone. |
| Phone can't load the page | Different Wi-Fi, or the router has client isolation on. |
| Drift run dies partway | Auto-Lock. Set it to Never. |
| `port already in use` | Already running. `pkill -f server.py` |

---

## Deliberately not built

No virtual HID device or joystick. macOS has no vJoy equivalent and `foohid` is
unmaintained. **The harness is the target** — this rig does not drive a real
simulator, and doesn't need to in order to answer the question.
