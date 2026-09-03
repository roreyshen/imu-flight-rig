// Flight course: rendering, input, game loop, and run logging.
(function () {
var $ = function (id) { return document.getElementById(id); };
var C = FL.COURSE;

var st = {
  input: "imu", running: false, t: 0, acc: 0, last: 0,
  world: null, plane: null, results: null, diff: 1.0,
  cmd: { roll: 0, pitch: 0, yaw: 0 },
  mouse: { x: 0.5, y: 0.5 }, rudder: 0,
  zeroed: false, armStart: false, armStop: false,
  fps: [], lowFps: false, lostFocus: false, sampleAge: null
};

// --------------------------------------------------------------- connection
var ws = null;
function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") +
                     location.host + "/ctl");
  ws.onclose = function () { setTimeout(connect, 1000); };
  ws.onmessage = function (ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === "sample") {
      st.sampleAge = Date.now() - m.arrivalWallMs;
      if (st.input === "imu") {
        st.cmd.roll = m.roll; st.cmd.pitch = m.pitch; st.cmd.yaw = m.yaw;
      }
    } else if (m.type === "status") {
      st.zeroed = !!m.zeroed;
      if (m.config && m.config.difficulty) st.diff = m.config.difficulty;
      if (!m.run && st.running) finish("disconnected");
    }
  };
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

function warn(text) {
  var el = $("warn");
  if (!text) { el.style.display = "none"; return; }
  el.textContent = text; el.style.display = "block";
}

// -------------------------------------------------------------------- input
document.addEventListener("mousemove", function (e) {
  st.mouse.x = e.clientX / window.innerWidth;
  st.mouse.y = e.clientY / window.innerHeight;
});
document.addEventListener("keydown", function (e) {
  if (e.key === "a" || e.key === "A" || e.key === "ArrowLeft") st.rudder = -1;
  if (e.key === "d" || e.key === "D" || e.key === "ArrowRight") st.rudder = 1;
});
document.addEventListener("keyup", function (e) {
  if ("aAdD".indexOf(e.key) >= 0 || e.key === "ArrowLeft" || e.key === "ArrowRight") st.rudder = 0;
});

function readMouseInput() {
  // Same positional control law as the harness's mouse baseline.
  st.cmd.roll = (st.mouse.x * 2 - 1) * 60;
  st.cmd.pitch = -(st.mouse.y * 2 - 1) * 30;
  st.cmd.yaw = st.rudder * 45;
}

// ------------------------------------------------------------------ sections
function sectionOf(z) {
  if (z < C.canyonStart) return { name: "open", fog: 1400, night: false };
  if (z < C.canyonEnd)   return { name: "canyon", fog: 1200, night: false };
  if (z < C.cityEnd)     return { name: "city", fog: 1100, night: false };
  if (z < C.fogEnd)      return { name: "fog", fog: 320, night: false };
  return { name: "dead stick", fog: 900, night: true };
}

// ------------------------------------------------------------------- render
function draw() {
  var cv = $("sky"), f = R3.fit(cv), ctx = f.ctx, w = f.w, h = f.h;
  var p = st.plane, world = st.world;
  var sec = sectionOf(p.z);

  var sky = sec.night ? [12, 16, 30] : [96, 140, 190];
  var fogC = sec.night ? [10, 13, 24] : [150, 172, 196];
  var grd = sec.night ? [16, 22, 26] : [86, 104, 74];

  var g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "rgb(" + sky.join(",") + ")");
  g.addColorStop(1, "rgb(" + fogC.join(",") + ")");
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  var cam = R3.camera([p.x, p.y, p.z], p.yaw, p.pitch, p.roll, 78, w, h);
  var scene = new R3.Scene(ctx, cam, { start: 60, end: sec.fog, color: fogC });

  // --- terrain, as filled quads on a coarse grid around the aircraft
  var STEP = 80, AHEAD = Math.min(sec.fog, 1200), SIDE = 560;
  var yawR = p.yaw * Math.PI / 180;
  var gx0 = Math.floor((p.x - SIDE) / STEP) * STEP;
  var gz0 = Math.floor((p.z - 240) / STEP) * STEP;
  for (var zz = gz0; zz < p.z + AHEAD; zz += STEP) {
    for (var xx = gx0; xx < p.x + SIDE; xx += STEP) {
      var d = Math.hypot(xx - p.x, zz - p.z);
      if (d > AHEAD) continue;
      var h00 = FL.terrainH(xx, zz, st.diff),
          h10 = FL.terrainH(xx + STEP, zz, st.diff),
          h11 = FL.terrainH(xx + STEP, zz + STEP, st.diff),
          h01 = FL.terrainH(xx, zz + STEP, st.diff);
      var avg = (h00 + h10 + h11 + h01) / 4;
      var lit = Math.max(0, Math.min(1, (h10 - h00) / 40 + 0.5));
      var shade = 0.72 + lit * 0.5;
      var col = [Math.round(grd[0] * shade), Math.round(grd[1] * shade),
                 Math.round(grd[2] * shade)];
      scene.poly([[xx, h00, zz], [xx, h01, zz + STEP],
                  [xx + STEP, h11, zz + STEP], [xx + STEP, h10, zz]],
                 col, 1, true, [col[0] + 14, col[1] + 14, col[2] + 14]);
    }
  }

  // --- buildings
  var bcol = sec.night ? [26, 30, 42] : [92, 96, 108];
  var bedge = sec.night ? [70, 96, 150] : [140, 146, 160];
  for (var i = 0; i < world.buildings.length; i++) {
    var b = world.buildings[i];
    if (b.z < p.z - 120 || b.z > p.z + AHEAD) continue;
    if (Math.abs(b.x - p.x) > SIDE) continue;
    scene.box([b.x - b.w / 2, b.base, b.z - b.d / 2],
              [b.x + b.w / 2, b.top, b.z + b.d / 2], bcol, bedge, 1);
  }

  // --- gates
  for (i = 0; i < world.gates.length; i++) {
    var gt = world.gates[i];
    if (gt.z < p.z - 40 || gt.z > p.z + AHEAD) continue;
    var col = gt.passed ? [62, 207, 114] : (gt.missed ? [120, 70, 70] : [255, 196, 64]);
    if (gt.heading != null && !gt.passed && !gt.missed) col = [120, 170, 255];
    scene.ring([gt.x, gt.y, gt.z], gt.r, [0, 0, 1], col, gt.passed ? 2 : 3.4, 30);
    scene.ring([gt.x, gt.y, gt.z], gt.r * 0.10, [0, 0, 1], col, 2, 10);
    // Heading gates get an arrow showing the demanded direction.
    if (gt.heading != null && !gt.passed && !gt.missed) {
      var hr = gt.heading * Math.PI / 180, L = gt.r * 1.5;
      scene.line([gt.x, gt.y + gt.r * 1.25, gt.z],
                 [gt.x + Math.sin(hr) * L, gt.y + gt.r * 1.25, gt.z + Math.cos(hr) * L],
                 col, 2.6);
    }
  }

  scene.paint();
  drawReticle(ctx, w, h, p);
}

// Fixed aircraft reticle plus a commanded-vs-actual indicator.
function drawReticle(ctx, w, h, p) {
  var cx = w / 2, cy = h / 2;
  ctx.strokeStyle = "rgba(255,214,74,.95)"; ctx.lineWidth = 2.4; ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - 34, cy); ctx.lineTo(cx - 12, cy); ctx.lineTo(cx - 6, cy + 7);
  ctx.moveTo(cx + 34, cy); ctx.lineTo(cx + 12, cy); ctx.lineTo(cx + 6, cy + 7);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,214,74,.95)"; ctx.fill();

  // Ghost of the commanded attitude: the gap is the airframe lag you feel.
  var dr = (st.cmd.roll - p.roll), dp = (st.cmd.pitch - p.pitch);
  ctx.save(); ctx.translate(cx, cy + dp * 3.2); ctx.rotate(-dr * Math.PI / 180 * 0.5);
  ctx.strokeStyle = "rgba(120,170,255,.5)"; ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.moveTo(-24, 0); ctx.lineTo(24, 0); ctx.stroke();
  ctx.restore();
}

// --------------------------------------------------------------------- HUD
function hud() {
  var p = st.plane, sec = sectionOf(p.z);
  var agl = p.y - FL.terrainH(p.x, p.z, st.diff);
  $("hSpd").innerHTML = p.v.toFixed(0) + "<small> m/s</small>";
  $("hAlt").innerHTML = p.y.toFixed(0) + "<small> m</small>";
  $("hAgl").innerHTML = agl.toFixed(0) + "<small> m</small>";
  $("hHdg").textContent = ((p.yaw % 360 + 360) % 360).toFixed(0).padStart(3, "0") + "°";
  $("hGates").textContent = st.results.passed + " / " + st.world.gates.length;
  $("hSec").textContent = sec.name + (p.engine ? "" : " · NO ENGINE");
  $("hTime").innerHTML = st.t.toFixed(1) + "<small> s</small>";
  $("hEff").innerHTML = (p.effortN ? (p.effort / p.effortN).toFixed(1) : "—") +
                        "<small> °/s</small>";

  var nxt = null;
  for (var i = 0; i < st.world.gates.length; i++) {
    var g = st.world.gates[i];
    if (!g.passed && !g.missed && g.z > p.z) { nxt = g; break; }
  }
  if (nxt) {
    var dz = nxt.z - p.z;
    var txt = "#" + (nxt.i + 1) + "  " + dz.toFixed(0) + " m";
    if (nxt.heading != null) {
      var err = ((p.yaw - nxt.heading + 540) % 360) - 180;
      txt += "  hdg " + ((nxt.heading % 360 + 360) % 360).toFixed(0) +
             "° (" + (err > 0 ? "+" : "") + err.toFixed(0) + "°)";
    }
    $("hNext").textContent = txt;
  } else $("hNext").textContent = "—";

  var w = p.wind || { x: 0, y: 0, z: 0 };
  $("hWind").textContent = Math.hypot(w.x, w.z).toFixed(1) + " m/s";

  var alert = "";
  if (p.stalled) alert = "STALL";
  else if (agl < 30) alert = "TERRAIN";
  else if (!p.engine) alert = "GLIDE";
  $("hAlert").textContent = alert;
}

// ------------------------------------------------------------------- loop
var DT = 1 / 120;   // fixed physics step: identical trajectories run to run

function loop(now) {
  requestAnimationFrame(loop);
  var wall = Date.now();
  st.fps.push(wall);
  while (st.fps.length && wall - st.fps[0] > 1000) st.fps.shift();
  if (st.running && st.t > 2 && st.fps.length < 30) st.lowFps = true;
  if (st.running && (st.lowFps || st.lostFocus)) {
    warn("Frame rate dropped to " + st.fps.length + " Hz" +
         (st.lostFocus ? " and this window lost focus" : "") +
         ". Keep this window focused and in front — this run is not trustworthy.");
  }

  if (!st.plane) { st.world = FL.buildWorld(st.diff); st.plane = FL.newPlane(); resetResults(); }

  var dt = st.last ? Math.min(0.25, (now - st.last) / 1000) : 0;
  st.last = now;

  if (st.running) {
    if (st.input === "mouse") readMouseInput();
    st.plane.cmdRoll = st.cmd.roll;
    st.plane.cmdPitch = st.cmd.pitch;
    st.plane.cmdYaw = st.cmd.yaw;

    st.acc += dt;
    var steps = 0;
    while (st.acc >= DT && steps < 40) {
      var prev = { x: st.plane.x, y: st.plane.y, z: st.plane.z };
      FL.step(st.plane, st.world, DT, st.t);
      FL.checkGates(st.plane, prev, st.world, st.results);
      st.t += DT; st.acc -= DT; steps++;
      if (st.plane.crashed || st.plane.done) break;
    }
    logFrame(wall);
    if (st.plane.crashed) finish("crash:" + st.plane.crashed);
    else if (st.plane.done) finish("complete");
  }

  draw();
  hud();
}

var logAcc = 0;
function logFrame(wall) {
  logAcc++;
  if (logAcc % 2) return;             // ~30 Hz is plenty for a flight track
  var p = st.plane, w = p.wind || { x: 0, y: 0, z: 0 };
  send({ type: "flight_frame", wallMs: wall, t: +st.t.toFixed(3), input: st.input,
         x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
         v: +p.v.toFixed(2), hdg: +p.yaw.toFixed(2),
         pitch: +p.pitch.toFixed(2), roll: +p.roll.toFixed(2),
         cr: +p.cmdRoll.toFixed(2), cp: +p.cmdPitch.toFixed(2), cy: +p.cmdYaw.toFixed(2),
         wx: +w.x.toFixed(2), wy: +w.y.toFixed(2), wz: +w.z.toFixed(2),
         gates: st.results.passed, miss: st.results.missed,
         eff: p.effortN ? +(p.effort / p.effortN).toFixed(2) : 0,
         stall: p.stalled ? 1 : 0, eng: p.engine ? 1 : 0,
         age: st.sampleAge == null ? null : +st.sampleAge.toFixed(1) });
}

function resetResults() {
  st.results = { passed: 0, missed: 0, hdgPassed: 0, hdgMissed: 0 };
}

// ------------------------------------------------------------------ control
function pick(a, b, on) { $(a).className = on === a ? "on" : ""; $(b).className = on === b ? "on" : ""; }
$("iImu").onclick = function () { st.input = "imu"; pick("iImu", "iMouse", "iImu"); };
$("iMouse").onclick = function () { st.input = "mouse"; pick("iImu", "iMouse", "iMouse"); };
$("zero").onclick = function () { send({ type: "zero" }); st.armStart = false; warn(null); };

$("go").onclick = function () {
  if (st.running) {
    if (!st.armStop) {
      st.armStop = true;
      warn("Ending the course early makes the run unscorable. Click again to abort.");
      setTimeout(function () { st.armStop = false; }, 8000);
      return;
    }
    send({ type: "stop_run" }); finish("aborted"); return;
  }
  if (st.input === "imu" && !st.zeroed && !st.armStart) {
    st.armStart = true;
    warn("Zero attitude has not been set. Hold the phone the way you will fly it, " +
         "tap Zero attitude, then start. Click Start again to go anyway.");
    setTimeout(function () { st.armStart = false; }, 8000);
    return;
  }
  start();
};

function start() {
  warn(null); $("msg").style.display = "none";
  st.armStart = false;
  st.world = FL.buildWorld(st.diff);
  st.plane = FL.newPlane();
  resetResults();
  st.t = 0; st.acc = 0; st.last = 0; st.running = true;
  st.fps = []; st.lowFps = false; st.lostFocus = false;
  $("go").textContent = "Abort"; $("go").className = "stop";
  send({ type: "start_run", mode: "flight", input: st.input,
         duration: 0, label: "course", seed: FL.SEED });
}

function finish(why) {
  if (!st.running) return;
  st.running = false;
  $("go").textContent = "Start course"; $("go").className = "go";
  send({ type: "stop_run" });
  var r = st.results, p = st.plane, n = st.world.gates.length;
  var title = why === "complete" ? "Course complete"
            : (why.indexOf("crash") === 0 ? "Crashed — " + why.split(":")[1] : "Run ended");
  $("msg").innerHTML = "<h2 class='" + (why === "complete" ? "ok" : "") + "'>" + title + "</h2>" +
    "<p>Gates <b>" + r.passed + " / " + n + "</b>" +
    (r.hdgPassed + r.hdgMissed ? "  ·  heading gates <b>" + r.hdgPassed + " / " +
      (r.hdgPassed + r.hdgMissed) + "</b>" : "") + "</p>" +
    "<p>Time <b>" + st.t.toFixed(1) + " s</b>  ·  distance <b>" + p.z.toFixed(0) + " m</b></p>" +
    "<p>Control effort <b>" + (p.effortN ? (p.effort / p.effortN).toFixed(1) : "—") +
      " °/s</b></p>" +
    "<p style='margin-top:12px;color:#7d8798'>Logged. Run <code>python3 analyze.py</code> " +
    "for the full comparison.</p>";
  $("msg").style.display = "block";
}

window.addEventListener("blur", function () { if (st.running) st.lostFocus = true; });
document.addEventListener("visibilitychange", function () {
  if (st.running && document.visibilityState !== "visible") st.lostFocus = true;
});

// Debug handle: lets you inspect or reposition the aircraft from the console,
// e.g. FLIGHT.plane.z = 3400 to jump to the city section and look around.
window.FLIGHT = st;

connect();
requestAnimationFrame(loop);
})();
