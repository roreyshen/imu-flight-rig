// Minimal 3D pipeline drawn with canvas 2D primitives. No dependencies.
//
// World axes: +X east, +Y up, +Z north. Camera looks down its local -Z.
// Everything is depth-sorted and drawn far-to-near (painter's algorithm).

var R3 = (function () {
  var DPR = Math.max(1, window.devicePixelRatio || 1);
  var NEAR = 0.6;                 // near plane, world units (metres)

  function fit(cv) {
    var r = cv.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (cv.width !== w * DPR || cv.height !== h * DPR) {
      cv.width = w * DPR; cv.height = h * DPR;
    }
    var ctx = cv.getContext("2d");
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  // --- camera -------------------------------------------------------------
  // Builds the world->camera basis from the aircraft's yaw/pitch/roll.
  // Rows of the returned basis are the camera's right/up/back vectors, so
  // transforming a world point is three dot products.
  function camera(pos, yawDeg, pitchDeg, rollDeg, fovDeg, w, h) {
    var cy = Math.cos(yawDeg * Math.PI / 180), sy = Math.sin(yawDeg * Math.PI / 180);
    var cp = Math.cos(pitchDeg * Math.PI / 180), sp = Math.sin(pitchDeg * Math.PI / 180);
    var cr = Math.cos(rollDeg * Math.PI / 180), sr = Math.sin(rollDeg * Math.PI / 180);

    // Forward (heading 0 = +Z north, yaw increases clockwise toward +X east)
    var fx = sy * cp, fy = sp, fz = cy * cp;
    // World up projected perpendicular to forward, then rolled
    var ux = -sy * sp, uy = cp, uz = -cy * sp;
    // Right = up x forward. (forward x up points WEST for X-east/Y-up/Z-north
    // and mirrors the whole scene left-to-right.)
    var rx = uy * fz - uz * fy, ry = uz * fx - ux * fz, rz = ux * fy - uy * fx;
    // Roll about the forward axis. Signs chosen so a positive (right) bank
    // rotates the world counter-clockwise on screen, matching the artificial
    // horizon convention already used in instruments.js.
    var Rx = rx * cr - ux * sr, Ry = ry * cr - uy * sr, Rz = rz * cr - uz * sr;
    var Ux = ux * cr + rx * sr, Uy = uy * cr + ry * sr, Uz = uz * cr + rz * sr;

    var f = (h / 2) / Math.tan(fovDeg * Math.PI / 360);
    return { p: pos, R: [Rx, Ry, Rz], U: [Ux, Uy, Uz], F: [fx, fy, fz],
             f: f, cx: w / 2, cy: h / 2, w: w, h: h };
  }

  // World point -> camera space {x right, y up, z forward-depth}
  function toCam(c, p) {
    var dx = p[0] - c.p[0], dy = p[1] - c.p[1], dz = p[2] - c.p[2];
    return [dx * c.R[0] + dy * c.R[1] + dz * c.R[2],
            dx * c.U[0] + dy * c.U[1] + dz * c.U[2],
            dx * c.F[0] + dy * c.F[1] + dz * c.F[2]];
  }

  function project(c, v) {
    var s = c.f / v[2];
    return [c.cx + v[0] * s, c.cy - v[1] * s, v[2]];
  }

  // Clip a camera-space segment against the near plane. Without this, points
  // behind the camera project to inverted coordinates and geometry streaks
  // across the screen -- the classic symptom of a missing near clip.
  function clipNear(a, b) {
    var an = a[2] > NEAR, bn = b[2] > NEAR;
    if (an && bn) return [a, b];
    if (!an && !bn) return null;
    var t = (NEAR - a[2]) / (b[2] - a[2]);
    var m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR];
    return an ? [a, m] : [m, b];
  }

  // Sutherland-Hodgman against the near plane, for filled polygons.
  function clipPolyNear(pts) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      var ain = a[2] > NEAR, bin = b[2] > NEAR;
      if (ain) out.push(a);
      if (ain !== bin) {
        var t = (NEAR - a[2]) / (b[2] - a[2]);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
      }
    }
    return out.length >= 3 ? out : null;
  }

  // --- draw list ----------------------------------------------------------
  // Collects primitives with a depth key, then paints far to near.
  function Scene(ctx, cam, fog) {
    this.ctx = ctx; this.cam = cam; this.items = [];
    this.fog = fog || null;   // {start, end, color:[r,g,b]}
  }

  // Fog blends the COLOUR toward the fog colour. For solid surfaces the alpha
  // must stay at 1 -- fading it makes terrain and buildings translucent, so
  // you see gates and geometry straight through solid rock. Only line work
  // (gates, wireframe) fades its alpha, where the softening reads correctly.
  Scene.prototype._fade = function (rgb, depth, alpha, opaque) {
    var a = alpha == null ? 1 : alpha;
    if (!this.fog) return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + a + ")";
    var t = (depth - this.fog.start) / (this.fog.end - this.fog.start);
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var f = this.fog.color;
    return "rgba(" + Math.round(rgb[0] + (f[0] - rgb[0]) * t) + "," +
                     Math.round(rgb[1] + (f[1] - rgb[1]) * t) + "," +
                     Math.round(rgb[2] + (f[2] - rgb[2]) * t) + "," +
                     (opaque ? a : a * (1 - t * 0.85)).toFixed(3) + ")";
  };

  Scene.prototype.line = function (p0, p1, rgb, width, alpha) {
    var a = toCam(this.cam, p0), b = toCam(this.cam, p1);
    var seg = clipNear(a, b);
    if (!seg) return;
    var A = project(this.cam, seg[0]), B = project(this.cam, seg[1]);
    var d = (seg[0][2] + seg[1][2]) / 2;
    if (this.fog && d > this.fog.end) return;
    this.items.push({ d: d, kind: 0, A: A, B: B, c: this._fade(rgb, d, alpha),
                      w: width || 1 });
  };

  // Filled convex polygon. Backface-culled by winding unless twoSided.
  Scene.prototype.poly = function (pts, rgb, alpha, twoSided, edge) {
    var cam = [], i;
    for (i = 0; i < pts.length; i++) cam.push(toCam(this.cam, pts[i]));
    var cl = clipPolyNear(cam);
    if (!cl) return;
    var scr = [], dsum = 0;
    for (i = 0; i < cl.length; i++) { scr.push(project(this.cam, cl[i])); dsum += cl[i][2]; }
    var area = 0;
    for (i = 0; i < scr.length; i++) {
      var p = scr[i], q = scr[(i + 1) % scr.length];
      area += p[0] * q[1] - q[0] * p[1];
    }
    if (!twoSided && area >= 0) return;          // backface
    var d = dsum / cl.length;
    if (this.fog && d > this.fog.end) return;
    this.items.push({ d: d, kind: 1, P: scr, c: this._fade(rgb, d, alpha, true),
                      e: edge ? this._fade(edge, d, alpha, true) : null });
  };

  // Ring in the plane whose normal is `normal`, centred at c.
  Scene.prototype.ring = function (c, radius, normal, rgb, width, segments) {
    var n = segments || 28;
    // Build two axes perpendicular to the normal
    var nx = normal[0], ny = normal[1], nz = normal[2];
    var ax, ay, az;
    if (Math.abs(ny) < 0.9) { ax = -nz; ay = 0; az = nx; }
    else { ax = 1; ay = 0; az = 0; }
    var al = Math.hypot(ax, ay, az); ax /= al; ay /= al; az /= al;
    var bx = ny * az - nz * ay, by = nz * ax - nx * az, bz = nx * ay - ny * ax;
    var prev = null, first = null;
    for (var i = 0; i <= n; i++) {
      var t = i / n * Math.PI * 2, ct = Math.cos(t) * radius, st = Math.sin(t) * radius;
      var p = [c[0] + ax * ct + bx * st, c[1] + ay * ct + by * st, c[2] + az * ct + bz * st];
      if (prev) this.line(prev, p, rgb, width);
      else first = p;
      prev = p;
    }
  };

  // Axis-aligned box from min/max corners. Faces are culled by winding.
  Scene.prototype.box = function (min, max, rgb, edgeRgb, alpha) {
    var x0 = min[0], y0 = min[1], z0 = min[2], x1 = max[0], y1 = max[1], z1 = max[2];
    var v = [[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1],
             [x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]];
    var faces = [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
    for (var i = 0; i < faces.length; i++) {
      var f = faces[i];
      this.poly([v[f[0]], v[f[1]], v[f[2]], v[f[3]]], rgb, alpha, false, edgeRgb);
    }
  };

  Scene.prototype.paint = function () {
    var ctx = this.ctx;
    this.items.sort(function (a, b) { return b.d - a.d; });   // far first
    for (var i = 0; i < this.items.length; i++) {
      var it = this.items[i];
      if (it.kind === 0) {
        ctx.strokeStyle = it.c; ctx.lineWidth = it.w;
        ctx.beginPath(); ctx.moveTo(it.A[0], it.A[1]); ctx.lineTo(it.B[0], it.B[1]);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(it.P[0][0], it.P[0][1]);
        for (var j = 1; j < it.P.length; j++) ctx.lineTo(it.P[j][0], it.P[j][1]);
        ctx.closePath();
        ctx.fillStyle = it.c; ctx.fill();
        if (it.e) { ctx.strokeStyle = it.e; ctx.lineWidth = 1; ctx.stroke(); }
      }
    }
  };

  return { fit: fit, camera: camera, Scene: Scene, toCam: toCam,
           project: project, clipNear: clipNear, NEAR: NEAR };
})();

if (typeof module !== "undefined" && module.exports) module.exports = R3;
