// river-world.js: one river, shared by the film player and the toy. It owns the GPU sim, the currents, the crocs'
// identities and facings, tears, walls and the look, and steps and draws them together.
//
// Everything the croc does comes from the rule and the water. The world only offers ways to act on the water:
// currents (elements + painted strokes), tears (the training's tear: a strain current plus a wash-out band, on a
// schedule in sim steps), the knife (cut, then the same tear across the cut), pigment (fed into the water), seeds,
// stones.

import { RiverSim, prng } from './river-sim.js';
import { Painter } from './river-paint.js';
import { smoothAlpha, contour, drawInk, Organs, Tracers } from './river-look.js';
import { Crocs } from './river-crocs.js';
import { Flow } from './river-flow.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// the training tear's schedule, in sim steps since it began (train/river_train.py tear_env)
export const tearEnv = s => smooth(0, 10, s) * (1 - smooth(35, 55, s));
export const CROC_HUE = [0.45, 0.72, 0.4];

export class World {
  constructor(gl, weights, doc, W, H, { seed = 1, tracers = 220 } = {}) {
    this.gl = gl; this.W = W; this.H = H;
    this.sim = new RiverSim(gl, weights, W, H, { seed });
    this.painter = new Painter(gl, this.sim);
    this.flow = new Flow(W, H);
    this.crocs = new Crocs(W, H);
    this.organs = new Organs(doc, prng(seed + 11));
    this.tracers = new Tracers(tracers, W, H, prng(seed + 23));
    this.solid = new Uint8Array(W * H);
    this.calm = new Float32Array(W * H).fill(1);
    this.elements = [];               // the caller's currents for this frame (Flow elements)
    this.field = null; this.fieldAmp = 0;   // a fixed current field (W*H*2), e.g. potential flow through a slit
    this.tears = [];
    this.base = new Float32Array(W * H * 2); this.tearFlow = new Float32Array(W * H * 2); this.motion = new Float32Array(W * H * 2);
    this.alphaS = new Float32Array(W * H);
    this.warps = []; this.found = {};
    this.added = 0; this.total0 = null;
    this.psiDecay = 0.985;
    this.glide = 0;                     // a number (x along facing) or [x along facing, y]
    this.events = [];                  // what happened this frame: { type: 'cut' | 'merge' | 'split' | 'eye', ... }
    this.flowDirty = true;
    this.erodeOn = false;
  }

  // ---- setup ----
  reset() {
    this.sim.clear(); this.crocs.reset(); this.organs.reset(); this.tears = []; this.flow.psi.fill(0); this.calm.fill(1);
    this.added = 0; this.total0 = null; this.flowDirty = true; this.sim.facingData.fill(1); this.sim.uploadFacing();
    this.field = null; this.fieldAmp = 0;
    for (let i = 0; i < this.W * this.H; i++) this.sim.fieldData[i * 4 + 1] = 0;
    this.sim.uploadField();
    this.lastCount = 0; this.lastEyes = 0;
  }
  // solid: Uint8Array W*H (1 = wall); stones: which of those to draw as stone (the rest the plate draws)
  setSolid(solid, stones = null) {
    this.solid.set(solid);
    for (let i = 0; i < this.W * this.H; i++) { this.sim.fieldData[i * 4] = solid[i]; this.sim.fieldData[i * 4 + 2] = stones ? stones[i] : 0; }
    this.flow.setWalls(solid); this.sim.uploadField(); this.flowDirty = true;
  }
  setStone(i, on) { this.solid[i] = on; this.sim.fieldData[i * 4] = on; this.sim.fieldData[i * 4 + 2] = on; }
  commitStones() { this.flow.setWalls(this.solid); this.sim.uploadField(); this.flowDirty = true; }
  // the water's pigment: a list of bands / blobs (the croc's hue unless given)
  water(list) {
    const { W, H } = this, D = new Float32Array(W * H * 4);
    for (const b of list) {
      const hue = b.hue || CROC_HUE;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (this.solid[y * W + x]) continue;
        let a = 0;
        if (b.type === 'band') a = b.level * Math.exp(-(((y + 0.5 - b.y) / b.h) ** 4)) * (0.75 + 0.5 * Math.sin(x * 0.07 + Math.sin(y * 0.11) * 2) ** 2);
        if (b.type === 'blob') { const dx = x + 0.5 - b.x, dy = y + 0.5 - b.y; a = b.level * Math.exp(-(dx * dx + dy * dy) / (2 * b.r * b.r)); }
        if (b.type === 'even') a = b.level;
        const i = (y * W + x) * 4; D[i] += hue[0] * a; D[i + 1] += hue[1] * a; D[i + 2] += hue[2] * a; D[i + 3] += a;
      }
    }
    this.sim.setWater(D);
  }

  // ---- acting on the river ----
  // a seed at the croc's would-be centre (cx, cy): the eye cell, 20 cells toward its face
  seed(cx, cy, face = 1) {
    const { W, H, sim } = this;
    const ex = cx + face * 20.2 - 0.5, ey = cy - 9.5 - 0.5;
    sim.plant(ex, ey);
    this.crocs.seedFacing(ex + 0.5, ey + 0.5, face);
    for (let y = Math.floor(ey) - 6; y <= ey + 6; y++) for (let x = Math.floor(ex) - 6; x <= ex + 6; x++) if (y >= 0 && y < H) sim.facingData[y * W + ((x + W) % W)] = face;
    sim.uploadFacing();
  }
  // the training's tear through (x, y): halves pulled apart along angle; len limits it across (Infinity = the
  // training's, which reaches the whole column)
  tear({ x, y, angle = 0, s = 0.75, L = 9, erode = 0.22, len = Infinity, follow = false }) {
    this.tears.push({ x, y, angle, s, L, erode, len, follow, start: this.sim.steps });
  }
  // the knife: cut along a polyline (grid coords), then tear across the cut so the halves come apart
  cut(pts, r = 1.4) {
    for (let i = 1; i < pts.length; i++) this.sim.knife(pts[i - 1], pts[i], r);
    this.tearAcross(pts);
  }
  // the training's tear, across a cut: halves pulled apart perpendicular to the line from its first to last point
  tearAcross(pts) {
    if (pts.length < 2) return;
    const a = pts[0], b = pts.at(-1), dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    if (len < 3) return;
    this.tear({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, angle: Math.atan2(dy, dx) - Math.PI / 2, len: len / 2 + 6, follow: true });
    this.events.push({ type: 'cut', at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  feed(x, y, r, amount, hue = CROC_HUE) { this.sim.feed(x, y, r, amount, hue); this.added += amount; }

  centroid(which = 'all') {
    const ps = this.crocs.pieces.filter(p => p.mass > 30);
    if (!ps.length) return [this.W / 2, this.H / 2];
    if (which === 'biggest') { const p = ps.reduce((a, b) => (b.mass > a.mass ? b : a)); return [p.cx, p.cy]; }
    let m = 0, x = 0, y = 0; for (const p of ps) { m += p.mass; x += p.mass * p.cx; y += p.mass * p.cy; } return [x / m, y / m];
  }

  // ---- stepping ----
  // the current for the step about to run: the frame's elements and painted strokes (fixed within a frame) plus
  // tears, whose schedule runs in sim steps
  compose(newFrame) {
    const { W, H, sim } = this;
    if (newFrame) {
      this.flow.compose(this.base, this.elements, this.cap ?? 1.6);
      if (this.field && this.fieldAmp > 1e-4) for (let i = 0; i < this.base.length; i++) this.base[i] += this.field[i] * this.fieldAmp;
      for (let i = 0; i < W * H; i++) { const c = this.calm[i]; if (c < 1) { this.base[i * 2] *= c; this.base[i * 2 + 1] *= c; } }
      this.flowDirty = true;
    }
    const te = [];
    let er = null;
    for (const tr of this.tears) {
      const s = sim.steps - tr.start, a = tearEnv(s);
      if (a > 1e-4) te.push({ type: 'strain', x: tr.x, y: tr.y, angle: tr.angle, s: tr.s, L: tr.L, amp: a, lenY: tr.len });
      // then a gentle, wide follow-on stretch, so the twins drift far enough apart to each regrow a whole body
      // without nose meeting tail
      if (tr.follow) { const b = smooth(45, 70, s) * (1 - smooth(200, 260, s)); if (b > 1e-4) te.push({ type: 'strain', x: tr.x, y: tr.y, angle: tr.angle, s: 0.14, L: 26, amp: b, lenY: tr.len === Infinity ? Infinity : tr.len + 10 }); }
      if (s >= 8 && s < 30) er = tr;
    }
    this.tears = this.tears.filter(tr => sim.steps - tr.start < (tr.follow ? 270 : 60));
    if (te.length || this.flowDirty) {
      if (te.length) {
        this.flow.compose(this.tearFlow, te, 99, false);
        for (let i = 0; i < this.base.length; i++) sim.flowData[i] = this.base[i] + this.tearFlow[i];
      } else sim.flowData.set(this.base);
      // what the water itself does (the crocs turn by this, not by the glide correction below)
      this.motion.set(sim.flowData);
      // a settled croc's residual glide (along its facing in x, and in y), cancelled under it
      const [gx, gy] = Array.isArray(this.glide) ? this.glide : [this.glide || 0, 0];
      if (gx || gy) for (let i = 0; i < W * H; i++) if (this.crocs.label[i]) { sim.flowData[i * 2] -= gx * sim.facingData[i]; sim.flowData[i * 2 + 1] -= gy; }
      sim.uploadFlow();
      this.flowDirty = te.length > 0;
    }
    // the tear's wash-out band (the training tear's: 0.22 exp(-(X/1.8)^2), steps 8-30)
    if (er || this.erodeOn) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let e = 0;
        if (er) {
          const c = Math.cos(er.angle), sn = Math.sin(er.angle), dx = ((x + 0.5 - er.x + W * 1.5) % W) - W / 2, dy = ((y + 0.5 - er.y + H * 1.5) % H) - H / 2;
          const X = dx * c + dy * sn, Y = -dx * sn + dy * c;
          e = er.erode * Math.exp(-((X / 1.8) ** 2)) * (er.len === Infinity ? 1 : 1 - smooth(er.len, er.len + 6, Math.abs(Y)));
        }
        sim.fieldData[(y * W + x) * 4 + 1] = e;
      }
      sim.uploadField();
      this.erodeOn = !!er;
    }
  }

  // run spf sim steps, then read back, track crocs and facings, advance turns and tracers
  step(spf, { ease = 0.5, snap = false } = {}) {
    const { sim } = this;
    this.events = this.events.filter(e => e.type === 'cut');
    for (let s = 0; s < spf; s++) { this.compose(s === 0); sim.step(); }
    if (this.psiDecay < 1) this.flow.decay(Math.pow(this.psiDecay, spf));
    for (let i = 0; i < this.calm.length; i++) if (this.calm[i] < 1) this.calm[i] = Math.min(1, this.calm[i] + 0.004 * spf);
    sim.frame(spf, ease, snap);
    const before = this.crocs.pieces.filter(p => p.body >= 150).map(p => p.id);
    this.crocs.update(i => sim.read1[i * 4 + 1], this.motion, sim.facingData);
    sim.uploadFacing();
    this.warps = this.crocs.stepTurns(sim, sim.facingData);
    for (const fl of this.crocs.flips) this.organs.flip(fl);
    this.lastSpf = spf;
    const solid = this.solid, W = this.W, H = this.H;
    this.tracers.step(sim.flowData, (x, y) => solid[Math.min(H - 1, Math.max(0, y)) * W + ((x % W) + W) % W], spf);
    // events for sound and hints: a body that vanished into another (merge), one that appeared from a split
    const after = this.crocs.pieces.filter(p => p.body >= 150);
    const ids = new Set(after.map(p => p.id));
    if (before.length > after.length && before.some(id => !ids.has(id)) && after.length > 0) this.events.push({ type: 'merge' });
    if (after.length > before.length) this.events.push({ type: 'split' });
  }

  // draw: GL wash into the default framebuffer, then the overlay (tracers, ink, organ sprites) on ctx
  // view: { off: [x, y] css px, cell: css px per cell, dpr, w, h (device px) }
  render(ctx, view, { dark = false, paper = [0.962, 0.944, 0.902], ink = 'rgb(42,42,38)', tracer = [70, 120, 150], tracerStrength = 0.3, time = 0, dt = 1 } = {}) {
    const { W, H, sim } = this;
    this.painter.warps = this.warps;
    this.painter.draw({ off: [view.off[0] * view.dpr, view.off[1] * view.dpr], cell: view.cell * view.dpr, w: view.w, h: view.h }, { iso: 0.35, time, dark, paper });
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (tracerStrength > 0) this.tracers.draw(ctx, view, tracer, tracerStrength);
    smoothAlpha(sim.read1, 4, 0, W, H, this.alphaS);
    drawInk(ctx, contour(this.alphaS, W, H, 0.35), view, ink, this.warps);
    const org = (ch, x, y) => { const i = y * W + x; return ch < 2 ? sim.read1[i * 4 + 2 + ch] : sim.read2[i * 4 + ch - 2]; };
    const facingAt = (x, y) => sim.facingData[Math.min(H - 1, Math.max(0, Math.floor(y))) * W + ((Math.floor(x) % W) + W) % W];
    // the water's carry this frame at a point (the sprites ride it), bilinear in the flow the frame used
    const fl = sim.flowData, k = this.lastSpf || 1;
    const move = (x, y) => {
      const xi = Math.floor(x - 0.5), yi = Math.floor(y - 0.5), fx = x - 0.5 - xi, fy = y - 0.5 - yi;
      const g = (a, b, c) => fl[(Math.min(H - 1, Math.max(0, b)) * W + ((a % W) + W) % W) * 2 + c];
      const l = c => (g(xi, yi, c) * (1 - fx) + g(xi + 1, yi, c) * fx) * (1 - fy) + (g(xi, yi + 1, c) * (1 - fx) + g(xi + 1, yi + 1, c) * fx) * fy;
      return [l(0) * k, l(1) * k];
    };
    this.found = this.organs.draw(ctx, org, this.alphaS, W, H, view, facingAt, this.warps, dt, move);
    const eyes = (this.found[0] || []).filter(s => s.goal > 0).length;
    if (eyes > (this.lastEyes || 0)) this.events.push({ type: 'eye' });
    this.lastEyes = eyes;
  }

  stats() {
    const tot = this.sim.totals();
    if (this.total0 == null && this.sim.steps > 0) this.total0 = tot.total - this.added;
    return {
      steps: this.sim.steps, crocs: this.crocs.count(),
      pieces: this.crocs.pieces.filter(p => p.mass > 30).map(p => ({ id: p.id, m: Math.round(p.mass), body: p.body, x: +p.cx.toFixed(1), y: +p.cy.toFixed(1), face: p.facing })),
      eyes: (this.found[0] || []).filter(s => s.goal > 0).length,
      croc: +tot.croc.toFixed(2), water: +tot.water.toFixed(2), total: +tot.total.toFixed(2), added: +this.added.toFixed(2),
      drift: this.total0 == null ? 0 : +(tot.total - this.total0 - this.added).toFixed(3),
    };
  }
}
