// river-flow.js: the currents, as sums of simple elements. Cells/step; the grid is a torus.
//
//   drift    uniform (u, v)
//   strain   the tear: u = s tanh(X/L), v = -s Y/L sech^2(X/L) along an axis; divergence-free
//   squeeze  u = s tanh(X/L) along an axis, nothing across: presses two things together (s < 0). Not
//            divergence-free (water converging on a line), which is fine: the croc's total is renormalised
//            exactly and the water is advected in push form.
//   vortex   a Gaussian vortex: tangential speed w (r/R) exp((1 - r^2/R^2)/2), peak w at r = R; divergence-free
//   psi      painted strokes: a stream function field whose curl is the current (discretely divergence-free)
//
// Near walls the current fades to zero over 4 cells.

const sech2 = x => { const c = Math.cosh(x); return 1 / (c * c); };

export class Flow {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.psi = new Float32Array(W * H);
    this.paintCap = Infinity;          // the toy sets a cap on painted currents (cells/step)
    this.taper = new Float32Array(W * H).fill(1);
  }
  // distance to the nearest wall cell, as a 0..1 taper over 4 cells
  setWalls(solid) {
    const { W, H } = this, N = W * H, d = new Float32Array(N).fill(99), q = [];
    for (let i = 0; i < N; i++) if (solid[i]) { d[i] = 0; q.push(i); }
    for (let h = 0; h < q.length; h++) {
      const j = q[h], x = j % W, y = (j / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = (x + dx + W) % W, yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        const k = yy * W + xx;
        if (d[k] > d[j] + 1) { d[k] = d[j] + 1; if (d[k] < 6) q.push(k); }
      }
    }
    for (let i = 0; i < N; i++) { const t = Math.min(1, Math.max(0, (d[i] - 0.5) / 4)); this.taper[i] = t * t * (3 - 2 * t); }
  }
  // the painted current's velocity at a point (curl of psi, central differences)
  painted(x, y) {
    const { W, H, psi } = this, xi = ((Math.floor(x) % W) + W) % W, yi = Math.min(H - 2, Math.max(1, Math.floor(y)));
    const P = (xx, yy) => psi[yy * W + ((xx + W) % W)];
    return [(P(xi, yi + 1) - P(xi, yi - 1)) / 2, -(P(xi + 1, yi) - P(xi - 1, yi)) / 2];
  }
  // a painted dab: velocity s along unit (dx, dy), Gaussian across (radius r), fading along over 1.5 r.
  // With a cap, a dab only adds what the water there is still missing along its direction, so painting over the
  // same spot again and again never builds past the cap (painted currents persist; they must not run away).
  dab(px, py, dx, dy, s, r, cap = Infinity) {
    if (cap < Infinity) {
      const [u, v] = this.painted(px, py), along = u * dx + v * dy;
      s = Math.max(0, Math.min(s, (cap - along) / 16));      // ~16 overlapping dabs make up a stroke's speed
      if (s <= 0) return;
    }
    const { W, H, psi } = this, nx = -dy, ny = dx, R = Math.ceil(r * 4);
    for (let yy = Math.floor(py - R); yy <= py + R; yy++) {
      if (yy < 0 || yy >= H) continue;
      for (let x0 = Math.floor(px - R); x0 <= px + R; x0++) {
        const ox = x0 + 0.5 - px, oy = yy + 0.5 - py;
        const across = (ox * nx + oy * ny) / r, along = (ox * dx + oy * dy) / (1.5 * r);
        const win = Math.exp(-along * along);
        if (win < 1e-3) continue;
        // a smooth erf: the integral of exp(-z^2), so the speed across the stroke is about s exp(-z^2)
        const z = Math.max(-3, Math.min(3, across));
        const erfi = 0.886227 * Math.tanh(1.2025 * z + 0.0886 * z * z * z);
        psi[yy * W + ((x0 % W) + W) % W] += s * r * erfi * win;
      }
    }
  }
  decay(k) { const p = this.psi; for (let i = 0; i < p.length; i++) p[i] *= k; }

  // out (W*H*2) = sum of the elements + curl(psi), tapered at walls, speed capped
  compose(out, elements, cap = 1.6, withPsi = true) {
    const { W, H, psi, taper } = this;
    out.fill(0);
    for (const e of elements) {
      const a = e.amp ?? 1;
      if (!a) continue;
      if (e.type === 'drift') { for (let i = 0; i < W * H; i++) { out[i * 2] += (e.u || 0) * a; out[i * 2 + 1] += (e.v || 0) * a; } continue; }
      if (e.type === 'strain' || e.type === 'squeeze') {
        const c = Math.cos(e.angle || 0), sn = Math.sin(e.angle || 0), L = e.L || 9, s = e.s * a, across = e.type === 'strain';
        const reach = e.reach ?? (e.lenY != null && e.lenY !== Infinity ? 40 : W / 2 - 34);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const dx = ((x + 0.5 - e.x + W * 1.5) % W) - W / 2, dy = ((y + 0.5 - e.y + H * 1.5) % H) - H / 2;
          const X = dx * c + dy * sn, Y = -dx * sn + dy * c;
          let win = 1 - Math.min(1, Math.max(0, (Math.abs(X) - reach) / 30));
          if (e.lenY != null && e.lenY !== Infinity) { const q = Math.min(1, Math.max(0, (Math.abs(Y) - e.lenY) / 12)); win *= 1 - q * q * (3 - 2 * q); }
          if (win <= 0) continue;
          const U = s * Math.tanh(X / L) * win, V = across ? Math.max(-1.5, Math.min(1.5, -s * Y / L * sech2(X / L) * win)) : 0;
          out[(y * W + x) * 2] += U * c - V * sn; out[(y * W + x) * 2 + 1] += U * sn + V * c;
        }
        continue;
      }
      if (e.type === 'push') {
        // a soft box of moving water (half sizes hw, hh) carrying whatever is in it at (u, v): directs one croc.
        // Not divergence-free at its edges, which the exact renormalisation and push-form water advection absorb.
        const hw = e.hw ?? 55, hh = e.hh ?? 26, soft = e.soft ?? 8;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const dx = Math.abs(((x + 0.5 - e.x + W * 1.5) % W) - W / 2), dy = Math.abs(((y + 0.5 - e.y + H * 1.5) % H) - H / 2);
          const k = Math.min(1, Math.max(0, (hw - dx) / soft)) * Math.min(1, Math.max(0, (hh - dy) / soft));
          if (k <= 0) continue;
          const s = k * k * (3 - 2 * k) * a;
          out[(y * W + x) * 2] += (e.u || 0) * s; out[(y * W + x) * 2 + 1] += (e.v || 0) * s;
        }
        continue;
      }
      if (e.type === 'eddy') {
        // an elliptical eddy: stream function psi = A exp(-q/2), q = (x/rx)^2 + (y/ry)^2, so the water circles
        // along ellipses (divergence-free); peak speed about w at (rx, 0)
        const rx = e.rx, ry = e.ry, A = e.w * a * rx * Math.exp(0.5);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const dx = ((x + 0.5 - e.x + W * 1.5) % W) - W / 2, dy = ((y + 0.5 - e.y + H * 1.5) % H) - H / 2;
          const q = (dx / rx) ** 2 + (dy / ry) ** 2;
          if (q > 25) continue;
          const g = A * Math.exp(-q / 2);
          out[(y * W + x) * 2] += g * dy / (ry * ry); out[(y * W + x) * 2 + 1] -= g * dx / (rx * rx);
        }
        continue;
      }
      if (e.type === 'vortex') {
        const R = e.r, w = e.w * a;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const dx = ((x + 0.5 - e.x + W * 1.5) % W) - W / 2, dy = ((y + 0.5 - e.y + H * 1.5) % H) - H / 2;
          const r2 = (dx * dx + dy * dy) / (R * R);
          if (r2 > 16) continue;
          const f = w / R * Math.exp(0.5 * (1 - r2));          // speed / r
          out[(y * W + x) * 2] += -dy * f; out[(y * W + x) * 2 + 1] += dx * f;
        }
        continue;
      }
    }
    // painted currents, each cell's speed capped at paintCap (whatever was painted, however often)
    if (withPsi) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const P = (xx, yy) => psi[Math.min(H - 1, Math.max(0, yy)) * W + ((xx + W) % W)];
      const i = y * W + x;
      let u = (P(x, y + 1) - P(x, y - 1)) / 2, v = -(P(x + 1, y) - P(x - 1, y)) / 2;
      const sp = Math.hypot(u, v); if (sp > this.paintCap) { u *= this.paintCap / sp; v *= this.paintCap / sp; }
      out[i * 2] += u; out[i * 2 + 1] += v;
    }
    for (let i = 0; i < W * H; i++) {
      let u = out[i * 2] * taper[i], v = out[i * 2 + 1] * taper[i];
      const s = Math.hypot(u, v); if (s > cap) { u *= cap / s; v *= cap / s; }
      out[i * 2] = u; out[i * 2 + 1] = v;
    }
  }
}
