// Flight course: seeded world, flight model, hazards, scoring.
// Every world feature -- terrain, buildings, gates, and the gust sequence --
// comes from one seed, so an IMU run and a mouse run face an identical course.

var FL = (function () {
  var G = 9.81;
  var SEED = 20260902;

  // ---------------------------------------------------------------- seeded rng
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  // Deterministic hash for value noise -- position in, [0,1) out. No state,
  // so terrain height is a pure function of (x, z) and never depends on
  // draw order or how much of the world has been visited.
  function hash2(ix, iz) {
    var h = ix * 374761393 + iz * 668265263 + SEED * 1442695040;
    h = (h ^ (h >>> 13)) | 0;
    h = Math.imul(h, 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function noise2(x, z) {
    var ix = Math.floor(x), iz = Math.floor(z);
    var fx = smooth(x - ix), fz = smooth(z - iz);
    var a = hash2(ix, iz), b = hash2(ix + 1, iz);
    var c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  }

  // ------------------------------------------------------------------ course
  var COURSE = {
    len: 6400,
    openEnd: 1500, canyonStart: 1500, canyonEnd: 3100,
    cityStart: 3100, cityEnd: 4300,
    fogStart: 4300, fogEnd: 5300,
    deadStart: 5300
  };

  // Route centreline: a gentle S so the course is not a straight line.
  function centreX(z) {
    return Math.sin(z * 0.00098) * 300 + Math.sin(z * 0.00043 + 1.7) * 180;
  }

  function terrainH(x, z, diff) {
    var h = noise2(x * 0.0016, z * 0.0016) * 62 +
            noise2(x * 0.0061, z * 0.0061) * 16;
    if (z > COURSE.canyonStart && z < COURSE.canyonEnd) {
      var d = Math.abs(x - centreX(z));
      var half = 150 / diff;                     // harder = narrower canyon
      if (d > half) {
        var over = (d - half) / 16;
        h += over * over * 34;
      }
    }
    return h;
  }

  // ------------------------------------------------------------------- world
  function buildWorld(diff) {
    var rnd = mulberry32(SEED);
    var gates = [], buildings = [], i;

    var n = 15;
    for (i = 0; i < n; i++) {
      var z = 320 + (COURSE.len - 700) * (i / (n - 1));
      var cx = centreX(z);
      var lateral = (rnd() - 0.5) * 130;
      var y = terrainH(cx, z, diff) + 70 + (rnd() - 0.5) * 46;
      // Every third gate demands a heading, which is what tests yaw.
      var heading = null;
      if (i > 1 && i % 3 === 0) {
        var ahead = centreX(z + 160);
        heading = Math.atan2(ahead - cx, 160) * 180 / Math.PI + (rnd() - 0.5) * 26;
      }
      gates.push({ i: i, x: cx + lateral, y: y, z: z, r: 26 / diff,
                   heading: heading, passed: false, missed: false });
    }

    // City: boxes clustered near the route but never on the centreline.
    for (i = 0; i < 90; i++) {
      var bz = COURSE.cityStart + rnd() * (COURSE.cityEnd - COURSE.cityStart);
      var off = (rnd() < 0.5 ? -1 : 1) * (70 + rnd() * 280);
      var bx = centreX(bz) + off;
      var w = 22 + rnd() * 44, d = 22 + rnd() * 44;
      var base = terrainH(bx, bz, diff);
      var hh = 70 + rnd() * 190 * diff;
      buildings.push({ x: bx, z: bz, w: w, d: d, base: base, top: base + hh });
    }
    return { gates: gates, buildings: buildings, diff: diff, seed: SEED };
  }

  // Wind is a pure function of elapsed TIME, not of frame index, so two runs
  // hit identical gusts even at slightly different frame rates.
  function windAt(t, z, diff) {
    var s = 1.0 * diff;
    var gx = Math.sin(t * 0.37) * 1.8 + Math.sin(t * 0.91 + 1.3) * 1.3 +
             Math.sin(t * 1.73 + 2.9) * 0.8;
    var gy = Math.sin(t * 0.53 + 0.7) * 1.0 + Math.sin(t * 1.19 + 2.1) * 0.7;
    var gz = Math.sin(t * 0.29 + 1.9) * 1.0;
    var band = (z > COURSE.canyonStart && z < COURSE.canyonEnd) ? 1.5 : 1.0;
    return { x: (2.0 + gx) * s * band, y: gy * s * band, z: gz * s };
  }
  function turbulenceAt(t, diff) {
    return { roll: Math.sin(t * 2.7) * 2.0 * diff + Math.sin(t * 5.1 + 1.1) * 1.1 * diff,
             pitch: Math.sin(t * 3.3 + 0.6) * 1.3 * diff };
  }

  // ------------------------------------------------------------------- plane
  function newPlane() {
    return { x: centreX(0), y: terrainH(centreX(0), 0, 1) + 90, z: 0,
             roll: 0, pitch: 0, yaw: 0, v: 62,
             cmdRoll: 0, cmdPitch: 0, cmdYaw: 0,
             engine: true, stalled: false, crashed: null, done: false,
             effort: 0, effortN: 0, prevCmd: null };
  }

  var TAU = 0.25;        // airframe lag: how fast it follows the command
  var V_STALL = 34, V_MAX = 105, THRUST = 7.5, DRAG = 0.0016;
  var RUDDER = 0.55;

  function step(p, world, dt, t) {
    if (p.crashed || p.done) return;
    var diff = world.diff;

    // control effort: how hard the input is working, deg/s across axes
    if (p.prevCmd) {
      var de = (Math.abs(p.cmdRoll - p.prevCmd[0]) + Math.abs(p.cmdPitch - p.prevCmd[1]) +
                Math.abs(p.cmdYaw - p.prevCmd[2])) / dt;
      p.effort += de; p.effortN++;
    }
    p.prevCmd = [p.cmdRoll, p.cmdPitch, p.cmdYaw];

    // Engine dies at the dead-stick section.
    if (p.z > COURSE.deadStart) p.engine = false;

    // Airframe follows the commanded attitude through a first-order lag.
    // Stalling costs control authority.
    var auth = p.stalled ? 0.35 : 1.0;
    var k = Math.min(1, dt / TAU) * auth;
    var turb = turbulenceAt(t, diff);
    p.roll += ((p.cmdRoll + turb.roll) - p.roll) * k;
    p.pitch += ((p.cmdPitch + turb.pitch) - p.pitch) * k;

    // Bank-to-turn, plus rudder from the third axis.
    var rollR = p.roll * Math.PI / 180;
    var yawRate = (G * Math.tan(Math.max(-1.3, Math.min(1.3, rollR))) /
                   Math.max(22, p.v)) * 180 / Math.PI;
    yawRate += p.cmdYaw * RUDDER * auth;
    p.yaw = (p.yaw + yawRate * dt + 360) % 360;

    // Speed: thrust, drag, and gravity along the flight path.
    var pitchR = p.pitch * Math.PI / 180;
    var thrust = p.engine ? THRUST : 0;
    p.v += (thrust - DRAG * p.v * p.v - G * Math.sin(pitchR)) * dt;
    p.v = Math.max(8, Math.min(V_MAX, p.v));

    p.stalled = p.v < V_STALL;
    if (p.stalled) p.pitch -= 26 * dt;      // nose drops

    var yawR = p.yaw * Math.PI / 180;
    var w = windAt(t, p.z, diff);
    p.x += (p.v * Math.sin(yawR) * Math.cos(pitchR) + w.x) * dt;
    p.y += (p.v * Math.sin(pitchR) + w.y) * dt;
    p.z += (p.v * Math.cos(yawR) * Math.cos(pitchR) + w.z) * dt;
    p.wind = w;

    // --- collisions
    if (p.y <= terrainH(p.x, p.z, diff) + 2.5) { p.crashed = "terrain"; return; }
    for (var i = 0; i < world.buildings.length; i++) {
      var b = world.buildings[i];
      if (Math.abs(p.x - b.x) < b.w / 2 && Math.abs(p.z - b.z) < b.d / 2 &&
          p.y < b.top) { p.crashed = "building"; return; }
    }
    if (p.z >= COURSE.len) p.done = true;
  }

  // Gate crossing: detect the frame where the plane passes the gate's z-plane,
  // interpolate to the exact crossing point, then test radius and heading.
  function checkGates(p, prev, world, results) {
    for (var i = 0; i < world.gates.length; i++) {
      var g = world.gates[i];
      if (g.passed || g.missed) continue;
      if (prev.z <= g.z && p.z > g.z) {
        var f = (g.z - prev.z) / Math.max(1e-6, p.z - prev.z);
        var cx = prev.x + (p.x - prev.x) * f;
        var cy = prev.y + (p.y - prev.y) * f;
        var d = Math.hypot(cx - g.x, cy - g.y);
        if (d <= g.r) {
          var hdgOk = true;
          if (g.heading != null) {
            var err = ((p.yaw - g.heading + 540) % 360) - 180;
            hdgOk = Math.abs(err) <= 15;
            g.hdgErr = err;
          }
          if (hdgOk) { g.passed = true; results.passed++; if (g.heading != null) results.hdgPassed++; }
          else { g.missed = true; results.missed++; results.hdgMissed++; }
        } else {
          g.missed = true; results.missed++;
        }
        g.dist = d;
      } else if (p.z > g.z + 30 && !g.passed && !g.missed) {
        g.missed = true; results.missed++;
      }
    }
  }

  return { COURSE: COURSE, centreX: centreX, terrainH: terrainH,
           buildWorld: buildWorld, windAt: windAt, turbulenceAt: turbulenceAt,
           newPlane: newPlane, step: step, checkGates: checkGates,
           mulberry32: mulberry32, SEED: SEED, V_STALL: V_STALL };
})();

if (typeof module !== "undefined" && module.exports) module.exports = FL;
