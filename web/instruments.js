// Artificial horizon, heading indicator, and a scrolling strip plot.
// Plain canvas, no libraries, no build step.

var Inst = (function () {
  var DPR = Math.max(1, window.devicePixelRatio || 1);

  function fit(cv) {
    var r = cv.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (cv.width !== w * DPR || cv.height !== h * DPR) {
      cv.width = w * DPR; cv.height = h * DPR;
    }
    var ctx = cv.getContext("2d");
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function rad(d) { return d * Math.PI / 180; }

  // --- artificial horizon -------------------------------------------------
  // roll/pitch in degrees; target* draws the attitude you are chasing.
  function horizon(cv, s) {
    var f = fit(cv), ctx = f.ctx, w = f.w, h = f.h;
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6;
    var pxPerDeg = R / 32;

    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();

    ctx.translate(cx, cy);
    ctx.rotate(rad(-s.roll));
    ctx.translate(0, s.pitch * pxPerDeg);

    var big = R * 3;
    ctx.fillStyle = "#2d6fa8"; ctx.fillRect(-big, -big, big * 2, big);
    ctx.fillStyle = "#7a5230"; ctx.fillRect(-big, 0, big * 2, big);
    ctx.fillStyle = "#e9eef5"; ctx.fillRect(-big, -1, big * 2, 2);

    // pitch ladder
    ctx.strokeStyle = "#dfe6ef"; ctx.fillStyle = "#dfe6ef";
    ctx.lineWidth = 1.4; ctx.font = "10px ui-monospace,Menlo,monospace";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (var d = -30; d <= 30; d += 10) {
      if (d === 0) continue;
      var y = -d * pxPerDeg, half = R * 0.30;
      ctx.beginPath(); ctx.moveTo(-half, y); ctx.lineTo(half, y); ctx.stroke();
      ctx.fillText(String(Math.abs(d)), -half - 5, y);
    }
    for (var d2 = -25; d2 <= 25; d2 += 10) {
      var y2 = -d2 * pxPerDeg, q = R * 0.14;
      ctx.beginPath(); ctx.moveTo(-q, y2); ctx.lineTo(q, y2); ctx.stroke();
    }
    ctx.restore();

    // target attitude marker (rides with the commanded frame)
    if (s.targetRoll != null) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rad(-(s.roll - s.targetRoll)));
      var ty = (s.pitch - s.targetPitch) * pxPerDeg;
      ctx.strokeStyle = s.onTarget ? "#3ecf72" : "#f0c24b";
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(0, -ty, R * 0.17, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-R * 0.30, -ty); ctx.lineTo(-R * 0.19, -ty);
      ctx.moveTo(R * 0.19, -ty);  ctx.lineTo(R * 0.30, -ty);
      ctx.stroke();
      ctx.restore();
    }

    // fixed aircraft symbol
    ctx.strokeStyle = "#ffd24a"; ctx.lineWidth = 3; ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - R * 0.45, cy); ctx.lineTo(cx - R * 0.14, cy);
    ctx.lineTo(cx - R * 0.06, cy + R * 0.09);
    ctx.moveTo(cx + R * 0.45, cy); ctx.lineTo(cx + R * 0.14, cy);
    ctx.lineTo(cx + R * 0.06, cy + R * 0.09);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd24a"; ctx.fill();

    // bezel + roll scale
    ctx.strokeStyle = "#3a4353"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#9aa5b5"; ctx.lineWidth = 1.5;
    [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].forEach(function (a) {
      var t = rad(a - 90), r0 = R, r1 = R - (a % 30 === 0 ? 9 : 5);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(t) * r0, cy + Math.sin(t) * r0);
      ctx.lineTo(cx + Math.cos(t) * r1, cy + Math.sin(t) * r1);
      ctx.stroke();
    });
    var tp = rad(-s.roll - 90);
    ctx.fillStyle = "#ffd24a";
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(tp) * (R - 10), cy + Math.sin(tp) * (R - 10));
    ctx.lineTo(cx + Math.cos(tp - 0.05) * (R - 20), cy + Math.sin(tp - 0.05) * (R - 20));
    ctx.lineTo(cx + Math.cos(tp + 0.05) * (R - 20), cy + Math.sin(tp + 0.05) * (R - 20));
    ctx.closePath(); ctx.fill();
  }

  // --- heading indicator --------------------------------------------------
  function heading(cv, s) {
    var f = fit(cv), ctx = f.ctx, w = f.w, h = f.h;
    var cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6;

    ctx.fillStyle = "#11151c";
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rad(-s.yaw));
    ctx.font = "bold 12px ui-monospace,Menlo,monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (var a = 0; a < 360; a += 10) {
      var t = rad(a - 90), major = (a % 30 === 0);
      ctx.strokeStyle = major ? "#e2e8f1" : "#7c8697";
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(t) * R, Math.sin(t) * R);
      ctx.lineTo(Math.cos(t) * (R - (major ? 11 : 6)), Math.sin(t) * (R - (major ? 11 : 6)));
      ctx.stroke();
      if (major) {
        var lbl = { 0: "N", 90: "E", 180: "S", 270: "W" }[a] || String(a / 10);
        ctx.fillStyle = (a % 90 === 0) ? "#ffd24a" : "#c3ccd9";
        ctx.save();
        ctx.translate(Math.cos(t) * (R - 24), Math.sin(t) * (R - 24));
        ctx.rotate(rad(s.yaw));
        ctx.fillText(lbl, 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();

    if (s.targetYaw != null) {
      var rel = ((s.targetYaw - s.yaw + 540) % 360) - 180;
      var tb = rad(rel - 90);
      ctx.fillStyle = s.onTarget ? "#3ecf72" : "#f0c24b";
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(tb) * R, cy + Math.sin(tb) * R);
      ctx.lineTo(cx + Math.cos(tb - 0.09) * (R - 15), cy + Math.sin(tb - 0.09) * (R - 15));
      ctx.lineTo(cx + Math.cos(tb + 0.09) * (R - 15), cy + Math.sin(tb + 0.09) * (R - 15));
      ctx.closePath(); ctx.fill();
    }

    ctx.strokeStyle = "#ffd24a"; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(cx, cy - R + 2); ctx.lineTo(cx, cy - R + 16); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy + 11);
    ctx.moveTo(cx - 7, cy + 4); ctx.lineTo(cx + 7, cy + 4); ctx.stroke();

    ctx.fillStyle = "#e8ecf1"; ctx.textAlign = "center";
    ctx.font = "bold 15px ui-monospace,Menlo,monospace";
    ctx.fillText(((s.yaw % 360 + 360) % 360).toFixed(0).padStart(3, "0") + "°",
                 cx, cy + R * 0.55);
    ctx.strokeStyle = "#3a4353"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  }

  // --- strip plot (drift test) -------------------------------------------
  // series: [{label, color, pts:[[tSec, deg], ...]}]
  function plot(cv, series, spanSec, title) {
    var f = fit(cv), ctx = f.ctx, w = f.w, h = f.h;
    var L = 46, Rp = 78, T = 16, B = 26;
    var pw = w - L - Rp, ph = h - T - B;

    ctx.fillStyle = "#0e1219"; ctx.fillRect(0, 0, w, h);

    var lo = -1, hi = 1;
    series.forEach(function (s) {
      s.pts.forEach(function (p) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; });
    });
    var pad = (hi - lo) * 0.12 || 1;
    lo -= pad; hi += pad;

    function X(t) { return L + (t / spanSec) * pw; }
    function Y(v) { return T + ph - ((v - lo) / (hi - lo)) * ph; }

    ctx.strokeStyle = "#1e2534"; ctx.lineWidth = 1;
    ctx.fillStyle = "#6f7a8b"; ctx.font = "10px ui-monospace,Menlo,monospace";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (var i = 0; i <= 4; i++) {
      var v = lo + (hi - lo) * i / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
      ctx.fillText(v.toFixed(1), L - 5, y);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (var k = 0; k <= 5; k++) {
      var t = spanSec * k / 5, x = X(t);
      ctx.strokeStyle = "#1e2534";
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
      ctx.fillStyle = "#6f7a8b";
      ctx.fillText((t / 60).toFixed(1) + "m", x, T + ph + 6);
    }
    ctx.strokeStyle = "#3a4353";
    ctx.beginPath(); ctx.moveTo(L, Y(0)); ctx.lineTo(L + pw, Y(0)); ctx.stroke();

    series.forEach(function (s, si) {
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.5;
      ctx.beginPath();
      var started = false;
      for (var i = 0; i < s.pts.length; i++) {
        var p = s.pts[i];
        if (p[0] > spanSec) break;
        if (!started) { ctx.moveTo(X(p[0]), Y(p[1])); started = true; }
        else ctx.lineTo(X(p[0]), Y(p[1]));
      }
      ctx.stroke();
      ctx.fillStyle = s.color; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.font = "10px ui-monospace,Menlo,monospace";
      ctx.fillText(s.label, L + pw + 8, T + 10 + si * 14);
    });

    if (title) {
      ctx.fillStyle = "#8b94a3"; ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.font = "10px ui-monospace,Menlo,monospace";
      ctx.fillText(title, L, 2);
    }
  }

  return { horizon: horizon, heading: heading, plot: plot };
})();
