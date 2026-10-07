// river-look.js: what sits on top of the wash. The ink line (a smoothed marching-squares iso-contour of the displayed
// pigment), the organ sprites (eye, far eye, blush, mouth: the film's own vector drawings riding peaks of their NCA
// channels, mirrored for a croc facing left), decals tied to the mouth (teeth, nostril, freckles), current tracers.

import { prepare, draw } from './croc-render.js';

export const K = 80 / 603.8;          // grid cells per film world px (the training target's scale)
const INK_W = 4.875;                  // film ink width, world px

const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// alpha smoothed with the cubic B-spline's [1 4 1]/6 at the nodes, so the contour sits where the wash's edge is
export function smoothAlpha(src, stride, off, W, H, out) {
  const tmp = smoothAlpha.tmp && smoothAlpha.tmp.length === W * H ? smoothAlpha.tmp : (smoothAlpha.tmp = new Float32Array(W * H));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = i => src[(y * W + ((i + W) % W)) * stride + off];
    tmp[y * W + x] = (a(x - 1) + 4 * a(x) + a(x + 1)) / 6;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = j => tmp[((j + H) % H) * W + x];
    out[y * W + x] = (t(y - 1) + 4 * t(y) + t(y + 1)) / 6;
  }
  return out;
}

// Marching squares on node values f (node (x, y) at grid coords (x + 0.5, y + 0.5)); returns polylines in grid coords.
export function contour(f, W, H, iso) {
  const pts = new Map(), adj = new Map();
  const ept = (id) => {
    let p = pts.get(id);
    if (p) return p;
    const e = id >> 1, x = e % W, y = (e / W) | 0;
    if ((id & 1) === 0) { const a = f[y * W + x], b = f[y * W + x + 1]; const t = (iso - a) / (b - a); p = [x + t + 0.5, y + 0.5]; }
    else { const a = f[y * W + x], b = f[(y + 1) * W + x]; const t = (iso - a) / (b - a); p = [x + 0.5, y + t + 0.5]; }
    pts.set(id, p);
    return p;
  };
  const link = (a, b) => {
    (adj.get(a) || adj.set(a, []).get(a)).push(b);
    (adj.get(b) || adj.set(b, []).get(b)).push(a);
  };
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const v0 = f[y * W + x], v1 = f[y * W + x + 1], v2 = f[(y + 1) * W + x + 1], v3 = f[(y + 1) * W + x];
    const c = (v0 > iso ? 1 : 0) | (v1 > iso ? 2 : 0) | (v2 > iso ? 4 : 0) | (v3 > iso ? 8 : 0);
    if (c === 0 || c === 15) continue;
    const T = ((y * W + x) << 1), B = (((y + 1) * W + x) << 1), L = ((y * W + x) << 1) | 1, R = ((y * W + x + 1) << 1) | 1;
    const mid = (v0 + v1 + v2 + v3) / 4 > iso;
    switch (c) {
      case 1: case 14: link(L, T); break;
      case 2: case 13: link(T, R); break;
      case 3: case 12: link(L, R); break;
      case 4: case 11: link(R, B); break;
      case 6: case 9: link(T, B); break;
      case 7: case 8: link(L, B); break;
      case 5: if (mid) { link(L, B); link(T, R); } else { link(L, T); link(R, B); } break;
      case 10: if (mid) { link(L, T); link(R, B); } else { link(L, B); link(T, R); } break;
    }
  }
  const seen = new Set(), lines = [];
  const walk = (start) => {
    const line = [start]; seen.add(start);
    let prev = -1, cur = start;
    for (;;) {
      const nb = adj.get(cur).filter(n => n !== prev && !seen.has(n));
      if (!nb.length) break;
      prev = cur; cur = nb[0]; seen.add(cur); line.push(cur);
    }
    return line;
  };
  for (const [id, nb] of adj) if (nb.length === 1 && !seen.has(id)) lines.push({ ids: walk(id), closed: false });
  for (const id of adj.keys()) if (!seen.has(id)) lines.push({ ids: walk(id), closed: true });
  return lines.map(l => ({ closed: l.closed, pts: l.ids.map(ept) }));
}

function chaikin(pts, closed, n = 2) {
  for (let k = 0; k < n; k++) {
    const out = [], m = pts.length;
    if (m < 3) return pts;
    if (!closed) out.push(pts[0]);
    for (let i = 0; i < (closed ? m : m - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % m];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) out.push(pts[m - 1]);
    pts = out;
  }
  return pts;
}
const area = pts => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };

// a croc mid-turn is squashed about its centre: the same map the wash uses, applied to points (grid coords)
export function warpPt(p, warps) {
  for (const w of warps) {
    const [x0, y0, x1, y1] = w.rect;
    if (p[1] >= y0 && p[1] <= y1 && p[0] >= x0 && p[0] <= x1) return [w.cx + (p[0] - w.cx) * w.sx, p[1]];
  }
  return p;
}

// The ink line: clean, round-joined, no boil (the displayed field is already eased over frames, so it holds still).
// Small loops fade in by their area instead of popping.
export function drawInk(ctx, lines, view, ink, warps = []) {
  const { off, cell, dpr } = view;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = ink; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.lineWidth = INK_W * K * cell;
  for (const l of lines) {
    if (l.pts.length < 3) continue;
    const fade = l.closed ? ss(10, 40, area(l.pts)) : 1;
    if (fade < 0.02) continue;
    const p = chaikin(l.pts, l.closed, 3);
    // a line squashes with the croc it outlines, whole (point by point, a line crossing the squash box would jump)
    let w = null;
    if (warps.length) {
      let mx = 0, my = 0; for (const q of l.pts) { mx += q[0]; my += q[1]; } mx /= l.pts.length; my /= l.pts.length;
      w = warps.find(v => mx >= v.rect[0] && mx <= v.rect[2] && my >= v.rect[1] && my <= v.rect[3]) || null;
    }
    ctx.globalAlpha = fade;
    ctx.beginPath();
    p.forEach((q, i) => {
      const [x, y] = w ? [w.cx + (q[0] - w.cx) * w.sx, q[1]] : q;
      const X = off[0] + x * cell, Y = off[1] + y * cell;
      i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    });
    if (l.closed) ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

// peaks of an organ channel: get(x, y) -> value
export function peaks(get, W, H, thr = 0.3) {
  const out = [];
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    const c = get(x, y);
    if (c < thr) continue;
    let best = true;
    for (let dy = -2; dy <= 2 && best; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue;
      const n = get(x + dx, y + dy);
      if (n > c || (n === c && (dy < 0 || (dy === 0 && dx < 0)))) { best = false; break; }
    }
    if (!best) continue;
    const q = (l, m, r) => { const d = l - 2 * m + r; return d < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / d)) : 0; };
    out.push({ x: x + 0.5 + q(get(x - 1, y), c, get(x + 1, y)), y: y + 0.5 + q(get(x, y - 1), c, get(x, y + 1)), v: c });
  }
  return out;
}

// overshooting ease for a sprite appearing (the eye opens with a little pop)
const backOut = t => { const c = 1.7; t = Math.min(1, Math.max(0, t)) - 1; return 1 + (c + 1) * t * t * t + c * t * t; };

export class Organs {
  constructor(doc, rand = Math.random) {
    this.doc = doc; this.rand = rand;
    const R = prepare(doc);
    this.R = R;
    const byId = id => doc.parts.findIndex(p => p.id === id);
    const sub = ids => ({ ...R, draws: R.draws.filter(d => ids.includes(d.part)) });
    // organ channel (0 eye, 1 far eye, 2 blush, 3 mouth) -> the film's part
    this.org = [
      { ch: 1, part: byId('eyeF'), blink: true }, { ch: 0, part: byId('eye'), blink: true }, { ch: 2, part: byId('blush0') }, { ch: 3, part: byId('smile0') },
    ].map(o => ({ ...o, R: sub([o.part]), anchor: doc.parts[o.part].anchor }));
    const mouth = doc.parts[byId('smile0')].anchor;
    this.decals = doc.parts.map((p, i) => ({ p, i })).filter(({ p }) => ['tooth', 'nostril', 'freckle'].includes(doc.types[p.type]))
      .map(({ p, i }) => ({ part: i, R: sub([i]), d: [(p.anchor[0] - mouth[0]) * K, (p.anchor[1] - mouth[1]) * K], anchor: p.anchor }));
    this.P = new Float32Array(R.n * 6);
    this.tracks = {};
    this.frame = 0;
  }
  reset() { this.tracks = {}; }

  // org(ch, x, y): organ channel value at a cell; f: smoothed displayed alpha (gating); facing(x, y): +1 / -1;
  // dt: this frame's length in 30 fps frames. Returns the sprite tracks per channel.
  // a croc was mirrored (turned): its sprites mirror with it, so none has to fly across or fade and respawn
  flip({ x0, y0, x1, y1, M }) {
    for (const tr of Object.values(this.tracks)) for (const s of tr) if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) s.x = M + 1 - s.x;
  }
  // move(x, y) -> [dx, dy]: how far the water carried a point this frame; tracks ride it before matching peaks
  draw(ctx, org, f, W, H, view, facing, warps = [], dt = 1, move = null) {
    const { off, cell, dpr } = view;
    const k = K * cell;
    this.frame += dt;
    const at = (x, y) => { const xi = Math.min(W - 1, Math.max(0, Math.floor(x))), yi = Math.min(H - 1, Math.max(0, Math.floor(y))); return f[yi * W + xi]; };
    const one = (o, x, y, alpha, sx, sy) => {
      const P = this.P, i = o.part * 6;
      let wx = x, wsx = 1;
      if (warps.length) { wx = warpPt([x, y], warps)[0]; wsx = this.squash(x, y, warps); }
      P.set([wx / K, y / K, 1, 0, alpha, 1], i);
      draw(ctx, o.R, P, { k, ox: off[0], oy: off[1], dpr, boil: 0, sx: sx * wsx, sy });
      P[i + 4] = 0;
    };
    // tracked over frames: each sprite matches the nearest peak of its channel (within 4 cells) and eases toward it,
    // pops in when a peak appears and fades out when it is lost, so a sprite never hops between peaks
    const ease = 1 - Math.pow(1 - 0.35, dt), fadeK = 1 - Math.pow(1 - 0.22, dt);
    const update = (ch, ps) => {
      const tr = (this.tracks[ch] ||= []);
      const used = new Set();
      if (move) for (const s of tr) { const [dx, dy] = move(s.x, s.y); s.x += dx; s.y += dy; }
      for (const s of tr) {
        let best = -1, bd = 36;
        ps.forEach((p, i) => { if (used.has(i)) return; const d = (p.x - s.x) ** 2 + (p.y - s.y) ** 2; if (d < bd) { bd = d; best = i; } });
        if (best >= 0) { const p = ps[best]; used.add(best); s.x += (p.x - s.x) * ease; s.y += (p.y - s.y) * ease; s.goal = p.goal; }
        else s.goal = 0;
      }
      ps.forEach((p, i) => { if (!used.has(i)) tr.push({ x: p.x, y: p.y, a: 0, age: 0, goal: p.goal, blinkAt: this.frame + 40 + this.rand() * 120 }); });
      for (const s of tr) { s.a += (s.goal - s.a) * fadeK; s.age += dt * s.goal; s.f = facing(s.x, s.y); }
      this.tracks[ch] = tr.filter(s => s.a > 0.02 || s.goal > 0);
      return this.tracks[ch];
    };
    const gated = ch => peaks((x, y) => org(ch, x, y), W, H).map(p => ({ ...p, goal: ss(0.35, 0.65, p.v) * ss(0.3, 0.55, at(p.x - 0.5, p.y - 0.5)) }));
    const mouths = update(3, gated(3));
    for (const m of mouths) {
      for (const dc of this.decals) {
        const x = m.x + dc.d[0] * m.f, y = m.y + dc.d[1];
        const a = m.a * ss(0.55, 0.85, at(x - 0.5, y - 0.5));
        if (a > 0.02) one(dc, x, y, a, m.f, 1);
      }
    }
    const found = {};
    for (const o of this.org) {
      const ps = o.ch === 3 ? mouths : update(o.ch, gated(o.ch));
      found[o.ch] = ps;
      for (const p of ps) {
        if (p.a <= 0.02) continue;
        const pop = 0.75 + 0.25 * backOut(p.age / 9);
        let sy = 1;
        if (o.blink) {
          // a blink now and then: shut over 2 frames, open over 4 (30 fps frames)
          if (this.frame > p.blinkAt + 6) p.blinkAt = this.frame + 70 + this.rand() * 160;
          const b = this.frame - p.blinkAt;
          if (b >= 0 && b < 6) sy = b < 2 ? 1 - 0.85 * (b / 2) : 0.15 + 0.85 * ((b - 2) / 4);
        }
        one(o, p.x, p.y, Math.min(1, p.a), p.f * pop, pop * sy);
      }
    }
    return found;
  }
  squash(x, y, warps) {
    for (const w of warps) { const [x0, y0, x1, y1] = w.rect; if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return Math.max(0.02, w.sx); }
    return 1;
  }
}

// -- currents --------------------------------------------------------------------------------------------------------

export class Tracers {
  constructor(n, W, H, rand = Math.random) {
    this.W = W; this.H = H; this.rand = rand;
    this.p = Array.from({ length: n }, () => this.spawn({}));
  }
  spawn(t) {
    t.x = this.rand() * this.W; t.y = this.rand() * this.H; t.age = 0; t.life = 40 + this.rand() * 60; t.trail = [];
    return t;
  }
  step(flow, solid, mult) {
    const { W, H } = this;
    const sample = (x, y) => {
      const xi = Math.floor(x - 0.5), yi = Math.floor(y - 0.5), fx = x - 0.5 - xi, fy = y - 0.5 - yi;
      const g = (a, b, c) => flow[(((b + H) % H) * W + ((a + W) % W)) * 2 + c];
      const l = c => (g(xi, yi, c) * (1 - fx) + g(xi + 1, yi, c) * fx) * (1 - fy) + (g(xi, yi + 1, c) * (1 - fx) + g(xi + 1, yi + 1, c) * fx) * fy;
      return [l(0), l(1)];
    };
    for (const t of this.p) {
      const [u, v] = sample(t.x, t.y);
      t.x += u * mult; t.y += v * mult; t.age++;
      t.trail.push([t.x, t.y, Math.hypot(u, v)]);
      if (t.trail.length > 16) t.trail.shift();
      const xi = Math.floor(t.x), yi = Math.floor(t.y);
      if (t.age > t.life || t.x < 0 || t.y < 0 || t.x >= W || t.y >= H || (solid && solid(xi, yi))) this.spawn(t);
    }
  }
  draw(ctx, view, rgb = [86, 132, 168], strength = 0.24) {
    const { off, cell, dpr } = view;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    // each trail is a tapered brush flick: thin and pale at its tail, fuller at its head
    for (const t of this.p) {
      const n = t.trail.length;
      if (n < 4) continue;
      const s = t.trail.at(-1)[2];
      if (s < 0.05) continue;
      const fade = Math.min(1, t.age / 10, (t.life - t.age) / 10) * Math.min(1, (s - 0.05) * 3);
      for (let i = 1; i < n; i++) {
        const k = i / (n - 1);
        ctx.lineWidth = Math.max(0.6, cell * 0.2 * (0.3 + 0.7 * k));
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(strength * fade * k).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(off[0] + t.trail[i - 1][0] * cell, off[1] + t.trail[i - 1][1] * cell);
        ctx.lineTo(off[0] + t.trail[i][0] * cell, off[1] + t.trail[i][1] * cell);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
