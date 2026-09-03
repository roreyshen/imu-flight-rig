// Test harness: tracking task, drift test, mouse baseline, live mapping.
(function () {
var $ = function (id) { return document.getElementById(id); };
var nowMs = function () { return performance.timeOrigin + performance.now(); };

// ---------------------------------------------------------------- forcing fn
// Sum-of-sines, the standard forcing function in manual-control research:
// exactly repeatable with no seed handling, and its frequency content will not
// accidentally coincide with the operator's own control bandwidth the way a
// random-walk path can. Frequencies are non-harmonic on purpose.
var SOS = {
  roll:  { amp: 22, c: [[0.0503, 0.00], [0.0829, 1.13], [0.1341, 2.31], [0.2170, 0.74]] },
  pitch: { amp: 15, c: [[0.0619, 2.02], [0.1002, 0.41], [0.1621, 1.77], [0.2623, 2.95]] },
  yaw:   { amp: 25, c: [[0.0387, 1.31], [0.0700, 2.63], [0.1132, 0.22], [0.1832, 1.94]] }
};
var RAMP = 3.0;   // seconds; avoids a step at t=0 polluting the minute-1 stats

// Difficulty scales amplitude and bandwidth together. It is stored in the
// server config, so it is snapshotted into every run's metadata -- comparing
// two runs recorded at different difficulties would be meaningless.
function target(axis, t) {
  var s = SOS[axis], d = st.difficulty, sum = 0;
  for (var i = 0; i < s.c.length; i++) {
    sum += Math.sin(2 * Math.PI * s.c[i][0] * d * t + s.c[i][1]);
  }
  var ramp = t < RAMP ? (t / RAMP) : 1;
  return s.amp * d * (sum / 2.5) * ramp;
}

// ---------------------------------------------------------------------- state
var st = {
  mode: "track", input: "imu", duration: 90,
  running: false, t0: 0, runid: null,
  roll: 0, pitch: 0, yaw: 0,          // live commanded attitude
  lastSample: null, age: null, tol: 5, difficulty: 1.0,
  cfg: null, rateHz: 0, source: "—",
  mouse: { x: 0.5, y: 0.5, active: false },
  fps: [], lowFps: false, lostFocus: false,
  acc: null, plot: null
};

function resetAccum() {
  st.acc = { n: 0, se: { roll: 0, pitch: 0, yaw: 0 }, on: 0,
             sum: { roll: 0, pitch: 0, yaw: 0 } };
  st.plot = { roll: [], pitch: [], alpha: [], compass: [], base: null };
}
resetAccum();

// ------------------------------------------------------------------ websocket
var ws = null;
function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ctl");
  ws.onopen = function () { $("conn").textContent = "connected"; $("dot").className = "dot g"; };
  ws.onclose = function () {
    $("conn").textContent = "disconnected"; $("dot").className = "dot r";
    setTimeout(connect, 1000);
  };
  ws.onmessage = function (ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === "sample") onSample(m);
    else if (m.type === "status") onStatus(m);
    else if (m.type === "run_started") { st.runid = m.runid; }
  };
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

function onSample(m) {
  st.lastSample = m;
  // Date.now(), NOT performance.timeOrigin+now(): the latter is monotonic
  // from page load and drifts from wall clock across sleep and NTP steps,
  // which made this read as tens of seconds NEGATIVE. The server stamps
  // arrival with time.time(), so this must be the same clock family.
  st.age = Date.now() - m.arrivalWallMs;
  st.rateHz = m.rateHz;
  st.source = m.source || "—";
  if (st.input === "imu") { st.roll = m.roll; st.pitch = m.pitch; st.yaw = m.yaw; }
  if (st.running && st.mode === "drift") recordDrift(m);
}

function onStatus(m) {
  st.cfg = m.config;
  st.tol = (m.config && m.config.tolerance_deg) || 5;
  if (m.config && m.config.difficulty) st.difficulty = m.config.difficulty;
  $("rate").textContent = (m.rate_hz || 0) + " Hz";
  $("srcpill").textContent = m.senders ? ("phone ×" + m.senders) : "no phone";
  if (!m.run && st.running) finish();
  buildSliders();
}

// ------------------------------------------------------------------ drift log
function recordDrift(m) {
  var t = (nowMs() - st.t0) / 1000;
  var p = st.plot;
  if (!p.base) {
    p.base = { alpha: m.raw.alpha, compass: m.raw.compass,
               beta: m.raw.beta, gamma: m.raw.gamma };
  }
  function dev(cur, base) {
    if (cur == null || base == null) return null;
    return ((cur - base + 540) % 360) - 180;
  }
  var da = dev(m.raw.alpha, p.base.alpha);
  var dc = dev(m.raw.compass, p.base.compass);
  var db = dev(m.raw.beta, p.base.beta);
  var dg = dev(m.raw.gamma, p.base.gamma);
  if (p.alpha.length === 0 || t - p.alpha[p.alpha.length - 1][0] > 0.2) {
    if (da != null) p.alpha.push([t, da]);
    if (dc != null) p.compass.push([t, dc]);
    if (db != null) p.pitch.push([t, db]);
    if (dg != null) p.roll.push([t, dg]);
  }
}

// ------------------------------------------------------------------ main loop
function warn(text) {
  var el = $("warn");
  if (!text) { el.style.display = "none"; return; }
  el.textContent = text; el.style.display = "block";
}

// Chrome throttles requestAnimationFrame hard in unfocused or occluded
// windows -- to ~1 Hz. That silently turns a tracking run into garbage, so
// detect it and say so rather than logging a corrupt run.
function checkFps(wall) {
  st.fps.push(wall);
  while (st.fps.length && wall - st.fps[0] > 1000) st.fps.shift();
  if (!st.running) return;
  if (st.fps.length < 30 && (wall - st.t0) > 2000) st.lowFps = true;
  if (st.lowFps || st.lostFocus) {
    warn("Frame rate dropped to " + st.fps.length + " Hz" +
         (st.lostFocus ? " and this window lost focus" : "") +
         " during the run. Keep the harness window focused and in front — " +
         "this run's tracking numbers are not trustworthy.");
  }
}

function frame() {
  requestAnimationFrame(frame);
  var wall = nowMs();
  checkFps(wall);
  var t = st.running ? (wall - st.t0) / 1000 : 0;

  if (st.running && st.mode === "track" && st.input === "mouse") {
    // Absolute pointer position -> attitude. A positional analogue of
    // orientation control, minus the drift and the proprioceptive ambiguity.
    st.roll  = (st.mouse.x * 2 - 1) * SOS.roll.amp * 1.6;
    st.pitch = -(st.mouse.y * 2 - 1) * SOS.pitch.amp * 1.6;
    st.yaw   = null;   // mouse has no third axis; comparison is 2-axis
  }

  var tr = null, tp = null, ty = null, on = false;
  if (st.running && st.mode === "track") {
    tr = target("roll", t); tp = target("pitch", t);
    ty = (st.input === "mouse") ? null : target("yaw", t);

    var er = st.roll - tr, ep = st.pitch - tp;
    var ey = (ty == null || st.yaw == null) ? null : (((st.yaw - ty + 540) % 360) - 180);
    var errs = [er, ep]; if (ey != null) errs.push(ey);
    var mag = Math.sqrt(errs.reduce(function (a, v) { return a + v * v; }, 0) / errs.length);
    on = mag <= st.tol;

    if (t > 5) {   // discard settling + ramp
      var a = st.acc;
      a.n++;
      a.se.roll += er * er; a.se.pitch += ep * ep;
      a.sum.roll += st.roll; a.sum.pitch += st.pitch;
      if (ey != null) { a.se.yaw += ey * ey; a.sum.yaw += st.yaw; }
      if (on) a.on++;
    }

    send({ type: "frame", wallMs: Date.now(), t: +t.toFixed(4), input: st.input,
           tr: r3(tr), tp: r3(tp), ty: r3(ty),
           ar: r3(st.roll), ap: r3(st.pitch), ay: r3(st.yaw),
           er: r3(er), ep: r3(ep), ey: r3(ey),
           on: on, age: st.age == null ? null : +st.age.toFixed(2) });

    if (t >= st.duration) { send({ type: "stop_run" }); finish(); }
  } else if (st.running && st.mode === "drift") {
    if (t >= st.duration) { send({ type: "stop_run" }); finish(); }
  }

  Inst.horizon($("ah"), { roll: st.roll || 0, pitch: st.pitch || 0,
                          targetRoll: tr, targetPitch: tp, onTarget: on });
  Inst.heading($("hi"), { yaw: st.yaw == null ? 0 : st.yaw, targetYaw: ty, onTarget: on });
  paintPlot();
  paintMetrics(t);
}

function r3(v) { return v == null ? null : +v.toFixed(3); }

function paintPlot() {
  var p = st.plot, span = Math.max(30, st.duration);
  var series;
  if (st.mode === "drift") {
    series = [
      { label: "alpha (rel)", color: "#e35d55", pts: p.alpha },
      { label: "compass",     color: "#3ecf72", pts: p.compass },
      { label: "beta",        color: "#5b9cf6", pts: p.pitch },
      { label: "gamma",       color: "#c07ae0", pts: p.roll }
    ];
    Inst.plot($("plot"), series, span, "deviation from t=0, degrees");
  } else {
    Inst.plot($("plot"), [
      { label: "alpha (rel)", color: "#e35d55", pts: p.alpha },
      { label: "compass",     color: "#3ecf72", pts: p.compass }
    ], span, "drift mode plots here");
  }
}

function paintMetrics(t) {
  var a = st.acc;
  $("mEl").innerHTML = (st.running ? t.toFixed(1) : "—") + "<small> s</small>";
  $("agepill").textContent = "age " + (st.age == null ? "—" : st.age.toFixed(0)) + " ms";
  if (a.n > 0) {
    var parts = [a.se.roll, a.se.pitch]; if (a.se.yaw) parts.push(a.se.yaw);
    var rms = Math.sqrt(parts.reduce(function (x, y) { return x + y; }, 0) / (a.n * parts.length));
    $("mRms").innerHTML = rms.toFixed(2) + "<small>°</small>";
    $("mOt").innerHTML = (100 * a.on / a.n).toFixed(1) + "<small> %</small>";
    var nb = Math.sqrt(Math.pow(a.sum.roll / a.n, 2) + Math.pow(a.sum.pitch / a.n, 2));
    $("mNb").innerHTML = nb.toFixed(2) + "<small>°</small>";
  } else {
    $("mRms").innerHTML = "—<small>°</small>";
    $("mOt").innerHTML = "—<small> %</small>";
    $("mNb").innerHTML = "—<small>°</small>";
  }
}

// -------------------------------------------------------------------- controls
function pick(ids, active) {
  ids.forEach(function (id) { $(id).className = (id === active) ? "on" : ""; });
}
$("mTrack").onclick = function () { st.mode = "track"; pick(["mTrack","mDrift"],"mTrack"); syncUI(); };
$("mDrift").onclick = function () { st.mode = "drift"; pick(["mTrack","mDrift"],"mDrift"); syncUI(); };
$("iImu").onclick  = function () { st.input = "imu";  pick(["iImu","iMouse"],"iImu"); syncUI(); };
$("iMouse").onclick= function () { st.input = "mouse";pick(["iImu","iMouse"],"iMouse"); syncUI(); };
$("dQuick").onclick= function () { st.duration = 90;  pick(["dQuick","dEnd"],"dQuick"); syncUI(); };
$("dEnd").onclick  = function () { st.duration = 300; pick(["dQuick","dEnd"],"dEnd"); syncUI(); };
$("zero").onclick  = function () { send({ type: "zero" }); };

$("go").onclick = function () {
  if (st.running) { send({ type: "stop_run" }); finish(); return; }
  resetAccum();
  if (st.mode === "drift") { st.duration = 300; pick(["dQuick","dEnd"],"dEnd"); }
  st.t0 = nowMs(); st.running = true;
  st.fps = []; st.lowFps = false; st.lostFocus = false; warn(null);
  $("go").textContent = "Stop run"; $("go").className = "stop";
  $("runpill").textContent = "recording";
  send({ type: "start_run", mode: st.mode,
         input: st.mode === "drift" ? "imu" : st.input,
         duration: st.duration, label: "" });
};

function finish() {
  if (!st.running) return;
  st.running = false;
  $("go").textContent = "Start run"; $("go").className = "go";
  $("runpill").textContent = st.runid ? ("done · " + st.runid) : "idle";
}

function syncUI() {
  var mouse = (st.mode === "track" && st.input === "mouse");
  $("mousepad").style.display = mouse ? "block" : "none";
  if (st.mode === "drift") {
    $("hint").textContent = "Phone flat on a table, untouched, 5 minutes. " +
      "Set Auto-Lock to Never first.";
  } else if (mouse) {
    $("hint").textContent = "Move the pointer over the horizon. 2-axis baseline " +
      "(roll + pitch) — the mouse has no third axis.";
  } else {
    $("hint").textContent = "Hold the aircraft symbol on the target for " +
      st.duration + " s. Zero the attitude first, in your normal holding posture.";
  }
}

var pad = $("mousepad");
pad.addEventListener("mousemove", function (e) {
  var r = pad.getBoundingClientRect();
  st.mouse.x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  st.mouse.y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
});

// ------------------------------------------------------------------- sliders
var SPEC = [
  ["range", 10, 120, 1], ["deadzone", 0, 0.4, 0.005],
  ["expo", 0, 1, 0.01], ["sensitivity", 0.2, 3, 0.01]
];
var built = false;
function buildSliders() {
  if (built || !st.cfg) return;
  built = true;
  var host = $("sliders"), html = "";
  ["roll", "pitch", "yaw"].forEach(function (ax) {
    html += '<div class="axhead">' + ax + '</div>';
    SPEC.forEach(function (s) {
      var v = st.cfg[ax][s[0]];
      html += '<div class="sl"><span>' + s[0].slice(0, 7) + '</span>' +
        '<input type="range" data-ax="' + ax + '" data-k="' + s[0] + '" min="' + s[1] +
        '" max="' + s[2] + '" step="' + s[3] + '" value="' + v + '">' +
        '<span class="n" id="n_' + ax + '_' + s[0] + '">' + fmt(v) + '</span></div>';
    });
  });
  html += '<div class="axhead">task</div>' +
    '<div class="sl"><span>toleran</span><input type="range" data-k="tolerance_deg" ' +
    'min="1" max="20" step="0.5" value="' + st.tol + '">' +
    '<span class="n" id="n_tol">' + fmt(st.tol) + '</span></div>' +
    '<div class="sl"><span>difficu</span><input type="range" data-k="difficulty" ' +
    'min="0.5" max="2.5" step="0.05" value="' + st.difficulty + '">' +
    '<span class="n" id="n_diff">' + fmt(st.difficulty) + '</span></div>';
  host.innerHTML = html;

  host.addEventListener("input", function (e) {
    var el = e.target; if (el.tagName !== "INPUT") return;
    var k = el.dataset.k, ax = el.dataset.ax, v = parseFloat(el.value);
    if (ax) {
      $("n_" + ax + "_" + k).textContent = fmt(v);
      st.cfg[ax][k] = v;
      var patch = {}; patch[ax] = {}; patch[ax][k] = v;
      send({ type: "config", patch: patch });
    } else if (k === "difficulty") {
      $("n_diff").textContent = fmt(v); st.difficulty = v;
      send({ type: "config", patch: { difficulty: v } });
    } else {
      $("n_tol").textContent = fmt(v); st.tol = v;
      send({ type: "config", patch: { tolerance_deg: v } });
    }
  });
}
function fmt(v) { return (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")); }

window.addEventListener("blur", function () { if (st.running) st.lostFocus = true; });
document.addEventListener("visibilitychange", function () {
  if (st.running && document.visibilityState !== "visible") st.lostFocus = true;
});

connect();
syncUI();
requestAnimationFrame(frame);
})();
