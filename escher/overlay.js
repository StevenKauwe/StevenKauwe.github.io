// The 2D overlay above the flow: the lattice and fundamental domain, the symmetry elements, croc copies, the live
// stroke's arrow trail and its ghost copies, the current lens and the streamline sketch.
// Everything here works in CSS pixels in the engine's frame: origin at the canvas's top-left, y down, one lattice
// cell edge = flow.lattice(). The group tables, drawCroc, glyph and themeColours are ported from mockup D's
// wallpaper.js; the operations are the same International Tables lists the engine (escher-core) uses.

const H3 = Math.sqrt(3) / 2;

// ---------------------------------------------------------------- maths
const m2 = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
const inv2 = A => { const d = A[0] * A[3] - A[1] * A[2]; return [A[3] / d, -A[1] / d, -A[2] / d, A[0] / d]; };
const ap2 = (A, v) => [A[0] * v[0] + A[1] * v[1], A[2] * v[0] + A[3] * v[1]];
const det2 = A => A[0] * A[3] - A[1] * A[2];
const mod1 = x => { const r = x - Math.floor(x); return r > 1 - 1e-9 ? 0 : r; };

function frac(s) { if (s.includes('/')) { const [a, b] = s.split('/'); return +a / +b; } return +s; }
function parseOp(str) {
  const M = [], t = [];
  str.split(',').forEach(c => {
    const row = [0, 0]; let tr = 0;
    (c.replace(/\s+/g, '').match(/[+-]?[^+-]+/g) || []).forEach(term => {
      const sg = term[0] === '-' ? -1 : 1, body = term.replace(/^[+-]/, ''), v = body[body.length - 1];
      if (v === 'x' || v === 'y') { const k = body.slice(0, -1); row[v === 'x' ? 0 : 1] += sg * (k ? frac(k) : 1); }
      else tr += sg * frac(body);
    });
    M.push(...row); t.push(tr);
  });
  return { M, t };
}
function polyArea(P) { let s = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
function polyCentroid(P) {
  let cx = 0, cy = 0, A = 0;
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length], c = a[0] * b[1] - b[0] * a[1]; A += c; cx += (a[0] + b[0]) * c; cy += (a[1] + b[1]) * c; }
  return [cx / (3 * A), cy / (3 * A)];
}

// ---------------------------------------------------------------- the 17 groups
export const LATTICES = {
  oblique: { name: 'oblique', B: [1, 0.34, 0, 0.88] },
  rect: { name: 'rectangular', B: [1, 0, 0, 0.74] },
  crect: { name: 'rhombic (centred cell)', B: [1, 0, 0, 1.5] },
  square: { name: 'square', B: [1, 0, 0, 1] },
  hex: { name: 'hexagonal', B: [1, -0.5, 0, H3] },
};
const PMM = ['x,y', '-x,-y', '-x,y', 'x,-y'];
const P4 = ['x,y', '-x,-y', '-y,x', 'y,-x'];
const P3 = ['x,y', '-y,x-y', '-x+y,-x'];
const P6 = P3.concat(['-x,-y', 'y,-x+y', 'x-y,x']);
const M31 = ['-y,-x', '-x+y,y', 'x,x-y'];
const M13 = ['y,x', 'x-y,-y', '-x,-x+y'];
const centred = ops => ops.concat(ops.map(o => o.split(',').map(c => c + '+1/2').join(',')));
const T = 1 / 3, T2 = 2 / 3;

export const GROUPS = [
  { id: 'p1', orb: 'o', latt: 'oblique', ops: ['x,y'], fd: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  { id: 'p2', orb: '2222', latt: 'oblique', ops: ['x,y', '-x,-y'], fd: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]] },
  { id: 'pm', orb: '**', latt: 'rect', ops: ['x,y', '-x,y'], fd: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]] },
  { id: 'pg', orb: '××', latt: 'rect', ops: ['x,y', '-x,y+1/2'], fd: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]] },
  { id: 'cm', orb: '*×', latt: 'crect', ops: centred(['x,y', '-x,y']), fd: [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]] },
  { id: 'pmm', orb: '*2222', latt: 'rect', ops: PMM, fd: [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]] },
  { id: 'pmg', orb: '22*', latt: 'rect', ops: ['x,y', '-x,-y', '-x+1/2,y', 'x+1/2,-y'], fd: [[0, 0], [0.25, 0], [0.25, 1], [0, 1]] },
  { id: 'pgg', orb: '22×', latt: 'rect', ops: ['x,y', '-x,-y', '-x+1/2,y+1/2', 'x+1/2,-y+1/2'], fd: [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]] },
  { id: 'cmm', orb: '2*22', latt: 'crect', ops: centred(PMM), fd: [[0, 0], [0.25, 0], [0.25, 0.5], [0, 0.5]] },
  { id: 'p4', orb: '442', latt: 'square', ops: P4, fd: [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]] },
  { id: 'p4m', orb: '*442', latt: 'square', ops: P4.concat(['-x,y', 'x,-y', 'y,x', '-y,-x']), fd: [[0, 0], [0.5, 0.5], [0, 0.5]] },
  { id: 'p4g', orb: '4*2', latt: 'square', ops: P4.concat(['-x+1/2,y+1/2', 'x+1/2,-y+1/2', 'y+1/2,x+1/2', '-y+1/2,-x+1/2']), fd: [[0, 0], [0.5, 0], [0, 0.5]] },
  { id: 'p3', orb: '333', latt: 'hex', ops: P3, fd: [[0, 0], [T2, T], [1, 1], [T, T2]] },
  { id: 'p3m1', orb: '*333', latt: 'hex', ops: P3.concat(M31), fd: [[0, 0], [T2, T], [T, T2]] },
  { id: 'p31m', orb: '3*3', latt: 'hex', ops: P3.concat(M13), fd: [[0, 0], [1, 0], [T2, T]] },
  { id: 'p6', orb: '632', latt: 'hex', ops: P6, fd: [[0, 0], [0.5, 0], [T2, T], [0.5, 0.5]] },
  { id: 'p6m', orb: '*632', latt: 'hex', ops: P6.concat(M31, M13), fd: [[0, 0], [0.5, 0], [T2, T]] },
];
export const byId = {};
GROUPS.forEach(g => {
  byId[g.id] = g;
  g.opsP = g.ops.map(parseOp);
  g.B = LATTICES[g.latt].B;
  g.Binv = inv2(g.B);
  // the linear part of each operation in Cartesian space, the same in any uniformly scaled frame
  g.L = g.opsP.map(o => m2(m2(g.B, o.M), g.Binv));
  g.fdArea = Math.abs(polyArea(g.fd.map(p => ap2(g.B, p))));
});

// Rotation centres in one cell (fractional), with their order.
export function rotationCentres(g) {
  if (g._centres) return g._centres;
  const out = new Map();
  g.L.forEach((L, k) => {
    if (det2(L) < 0) return;
    if (Math.abs(L[0] - 1) < 1e-9 && Math.abs(L[3] - 1) < 1e-9 && Math.abs(L[1]) < 1e-9) return;
    const n = Math.round(2 * Math.PI / Math.abs(Math.atan2(L[2], L[0])));
    const A = inv2([1 - L[0], -L[1], -L[2], 1 - L[3]]);
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const f = ap2(g.Binv, ap2(A, ap2(g.B, [g.opsP[k].t[0] + i, g.opsP[k].t[1] + j]))).map(mod1);
      const key = f.map(v => Math.round(v * 1e6) % 1e6).join(',');
      if (!out.has(key) || out.get(key).n < n) out.set(key, { f, n });
    }
  });
  return (g._centres = [...out.values()]);
}
export const hasMirrors = g => g.L.some((L, k) => det2(L) < 0 && mirrorKinds(g)[k] === 'mirror');
// whether each improper operation is a mirror (its translation along the line is a lattice period) or a glide
function mirrorKinds(g) {
  if (g._kinds) return g._kinds;
  g._kinds = g.L.map((L, k) => {
    if (det2(L) > 0) return null;
    const { d } = lineDir(L), P = lattPeriod(g.B, d);
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const tau = ap2(g.B, [g.opsP[k].t[0] + i, g.opsP[k].t[1] + j]);
      let r = (((tau[0] * d[0] + tau[1] * d[1]) % P) + P) % P; if (r > P - 1e-7) r = 0;
      if (r < 1e-7) return 'mirror';
    }
    return 'glide';
  });
  return g._kinds;
}
function lineDir(L) {
  let d = [1 + L[0], L[2]];
  if (Math.hypot(d[0], d[1]) < 1e-6) d = [L[1], 1 + L[3]];
  let ang = Math.atan2(d[1], d[0]); if (ang < -1e-9) ang += Math.PI; if (ang >= Math.PI - 1e-9) ang -= Math.PI;
  return { ang, d: [Math.cos(ang), Math.sin(ang)] };
}
function lattPeriod(B, d) {
  let best = Infinity;
  for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) {
    if (!i && !j) continue;
    const v = ap2(B, [i, j]);
    if (Math.abs(v[0] * d[1] - v[1] * d[0]) < 1e-7 * Math.hypot(v[0], v[1])) best = Math.min(best, Math.hypot(v[0], v[1]));
  }
  return best;
}
// Mirror and glide lines in the frame whose cell edges are Bs (screen px), for lattice shifts i, j in [-R, R].
function mirrorLines(g, Bs, R) {
  const out = new Map();
  g.L.forEach((L, k) => {
    if (det2(L) > 0) return;
    const { ang, d } = lineDir(L), nrm = [-d[1], d[0]], P = lattPeriod(Bs, d);
    for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
      const tau = ap2(Bs, [g.opsP[k].t[0] + i, g.opsP[k].t[1] + j]);
      const gl = tau[0] * d[0] + tau[1] * d[1], off = (tau[0] * nrm[0] + tau[1] * nrm[1]) / 2;
      let r = ((gl % P) + P) % P; if (r > P - 1e-4) r = 0;
      const kind = r < 1e-4 ? 'mirror' : 'glide';
      const key = Math.round(ang * 1e4) + ':' + Math.round(off * 10);
      const prev = out.get(key);
      if (!prev || (prev.kind === 'glide' && kind === 'mirror')) out.set(key, { p: [nrm[0] * off, nrm[1] * off], d, kind });
    }
  });
  return [...out.values()];
}

// ---------------------------------------------------------------- the croc (from wallpaper.js)
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let CROC = null;
function crocGeometry() {
  if (CROC) return CROC;
  const R = mulberry32(11), j = a => (R() - 0.5) * a;
  const h = x => {
    if (x < -0.12) return 0.012 + 0.105 * Math.pow((x + 0.5) / 0.38, 1.15);
    if (x < 0.13) return 0.117 + 0.022 * Math.sin(Math.PI * (x + 0.12) / 0.25);
    if (x < 0.2) return 0.117 - (x - 0.13) / 0.07 * 0.022;
    let v = 0.095 - 0.028 * (x - 0.2) / 0.3;
    if (x > 0.45) v *= Math.sqrt(Math.max(0, 1 - ((x - 0.45) / 0.05) ** 2));
    return v;
  };
  const N = 96, top = [], bot = [];
  for (let k = 0; k <= N; k++) {
    const x = -0.5 + k / N;
    const bump = (x > -0.42 && x < 0.12) ? 0.022 * Math.abs(Math.sin((x + 0.42) * Math.PI / 0.054)) : 0;
    top.push([x, h(x) + bump + j(0.005)]);
    bot.push([x, -h(x) * 0.92 + j(0.005)]);
  }
  const body = new Path2D();
  body.moveTo(top[0][0], top[0][1]);
  top.forEach(p => body.lineTo(p[0], p[1]));
  for (let k = N; k >= 0; k--) body.lineTo(bot[k][0], bot[k][1]);
  body.closePath();
  const belly = new Path2D();
  const bs = bot.filter(p => p[0] > -0.3 && p[0] < 0.44);
  belly.moveTo(bs[0][0], bs[0][1]);
  bs.forEach(p => belly.lineTo(p[0], p[1]));
  for (let k = bs.length - 1; k >= 0; k--) belly.lineTo(bs[k][0], bs[k][1] * 0.45);
  belly.closePath();
  const legs = new Path2D();
  [[0.09, 1], [-0.11, 1], [0.09, -1], [-0.11, -1]].forEach(([x, s]) => {
    const y0 = s * h(x) * 0.8;
    legs.moveTo(x, y0); legs.lineTo(x - 0.06, y0 + s * 0.085); legs.lineTo(x - 0.02, y0 + s * 0.1);
  });
  const smile = new Path2D();
  smile.moveTo(0.272, -0.012); smile.quadraticCurveTo(0.28, -0.035, 0.3, -0.032);
  smile.quadraticCurveTo(0.39, -0.068, 0.478, -0.014);
  CROC = { body, belly, legs, smile };
  return CROC;
}
// Draws a croc of unit length along local +x (head at +x, eye on local +y); `px` is its length in device pixels.
export function drawCroc(ctx, px, alpha, C) {
  const g = crocGeometry(), lw = 1.6 / px;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = C.ink; ctx.lineWidth = 0.06; ctx.stroke(g.legs);
  ctx.strokeStyle = C.crocLight; ctx.lineWidth = Math.max(0.01, 0.06 - 2.4 * lw); ctx.stroke(g.legs);
  ctx.globalAlpha = alpha * 0.92; ctx.fillStyle = C.croc; ctx.fill(g.body);
  ctx.globalAlpha = alpha * 0.55; ctx.fillStyle = C.belly; ctx.fill(g.belly);
  ctx.globalAlpha = alpha * 0.45; ctx.strokeStyle = C.crocDark; ctx.lineWidth = 0.022; ctx.stroke(g.body);
  ctx.globalAlpha = alpha; ctx.strokeStyle = C.ink; ctx.lineWidth = lw; ctx.stroke(g.body);
  ctx.beginPath(); ctx.arc(0.26, 0.105, 0.068, 0, 7); ctx.fillStyle = '#fbf6ec'; ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(0.276, 0.11, 0.037, 0, 7); ctx.fillStyle = '#2b2233'; ctx.fill();
  ctx.beginPath(); ctx.arc(0.288, 0.124, 0.012, 0, 7); ctx.fillStyle = '#fbf6ec'; ctx.fill();
  ctx.lineWidth = lw * 1.1; ctx.strokeStyle = C.ink; ctx.stroke(g.smile);
  ctx.beginPath(); ctx.arc(0.478, 0.032, 0.008, 0, 7); ctx.fillStyle = C.ink; ctx.fill();
  ctx.globalAlpha = alpha * 0.5; ctx.beginPath(); ctx.arc(0.33, -0.058, 0.022, 0, 7); ctx.fillStyle = C.rose; ctx.fill();
  ctx.globalAlpha = 1;
}

// A rotation-centre mark: lens for 2-fold, square for 4, triangle for 3, hexagon for 6.
export function glyph(o, x, y, n, r, ang, C, lw = 1.5) {
  o.save(); o.translate(x, y); o.rotate(ang);
  o.beginPath();
  if (n === 2) o.ellipse(0, 0, r * 0.95, r * 0.5, 0, 0, Math.PI * 2);
  else if (n === 4) o.rect(-r * 0.68, -r * 0.68, r * 1.36, r * 1.36);
  else { const k = n === 3 ? 3 : 6, rr = n === 3 ? r * 1.05 : r * 0.92; for (let i = 0; i < k; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / k; i ? o.lineTo(rr * Math.cos(a), rr * Math.sin(a)) : o.moveTo(rr * Math.cos(a), rr * Math.sin(a)); } o.closePath(); }
  o.fillStyle = C.accent; o.fill();
  o.lineWidth = lw; o.strokeStyle = C.paper; o.stroke();
  o.restore();
}

export function themeColours() {
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return { ink: v('--ink'), paper: v('--paper'), accent: v('--accent'), soft: v('--ink-soft'),
    croc: dark ? '#6f9e5c' : '#86b56e', crocLight: dark ? '#86b56e' : '#a9cc8e', crocDark: '#3f6b33', belly: '#e3e7a0',
    ochre: v('--ochre'), rose: v('--rose'), blue: v('--blue'), dark };
}
// brush colours in the engine's order: ink, green, rose, blue
export const brushColours = C => [C.ink, C.dark ? '#86b56e' : '#5f9a4c', C.rose, C.blue];

// ---------------------------------------------------------------- drawing helpers
function arrowLine(ctx, pts, every, size) {
  if (pts.length < 2) return;
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
  ctx.stroke();
  let acc = every * 0.6;
  ctx.beginPath();
  for (let k = 1; k < pts.length; k++) {
    const dx = pts[k][0] - pts[k - 1][0], dy = pts[k][1] - pts[k - 1][1], L = Math.hypot(dx, dy); if (!L) continue;
    acc += L;
    if (acc >= every || k === pts.length - 1) {
      acc = 0;
      const ux = dx / L, uy = dy / L, x = pts[k][0], y = pts[k][1];
      ctx.moveTo(x - ux * size - uy * size * 0.6, y - uy * size + ux * size * 0.6); ctx.lineTo(x, y); ctx.lineTo(x - ux * size + uy * size * 0.6, y - uy * size - ux * size * 0.6);
    }
  }
  ctx.stroke();
}
const LENS_R = 62;      // CSS px
const GHOST_MS = 800;
const SKETCH_MS = 600;
const SKETCH_HOLD_REDUCED_MS = 1500;
const REACH_CSS = 28;   // the engine's croc reach σ (before its per-group cap)

export class Overlay {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.W = 0; this.H = 0; this.dpr = 1;
    this.C = themeColours();
    this.g = byId.p4; this.Bs = [100, 0, 0, 100]; this.cell = 100;
    this.showElements = true; this.reduced = false;
    this.staticLayer = document.createElement('canvas');
    this.sketchLayer = document.createElement('canvas');
    this.sketchT0 = -1e9; this.elemT0 = -1e9;
    this.ghosts = [];     // { pts (screen px), col, live, t0 }
    this.live = null;     // the stroke being painted: { pts, col }
    this.lens = null;     // { x, y }
    this.copies = new Float32Array(0);
    this.crocForce = 0.6;
    this.crocPx = 32;
    this.speed = 1;       // playback speed: the lens reads the current at normal speed whatever it is
  }
  resize(w, h, dpr) {
    this.W = w; this.H = h; this.dpr = dpr;
    for (const c of [this.cv, this.staticLayer, this.sketchLayer]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    this.sketchT0 = -1e9;
  }
  // the group and its cell on screen, straight from the engine
  setFrame(g, lattice, cell, { transition = false } = {}) {
    this.g = g; this.cell = cell;
    this.Bs = [lattice[0], lattice[2], lattice[1], lattice[3]];
    this.BsInv = inv2(this.Bs);
    this.K = cell * Math.sqrt(g.fdArea);              // CSS px per sqrt(domain area), as in mockup D's setView
    this.US = 1.4 * this.K;                            // mockup D's unit speed on screen (px/s)
    this.crocPx = Math.max(24, Math.min(32, 0.36 * this.K));   // croc length: mockup D's 32 px, smaller on phones' smaller cells
    const spacing = Math.abs(det2(this.Bs)) / Math.max(Math.hypot(this.Bs[0], this.Bs[2]), Math.hypot(this.Bs[1], this.Bs[3]));
    this.reach = Math.min(REACH_CSS, spacing / 3);     // the engine caps σ the same way
    this.spacing = spacing;
    this.drawStatic();
    this.elemT0 = transition && !this.reduced ? performance.now() : -1e9;
  }
  setTheme() { this.C = themeColours(); this.drawStatic(); }

  // ---------- the static layer: lattice, fundamental domain, symmetry elements
  drawStatic() {
    const o = this.staticLayer.getContext('2d'), { W, H, dpr, C, g, Bs, BsInv } = this;
    if (!W || !BsInv) return;
    o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, this.staticLayer.width, this.staticLayer.height);
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(p => ap2(BsInv, p));
    const i0 = Math.floor(Math.min(...corners.map(p => p[0]))) - 1, i1 = Math.ceil(Math.max(...corners.map(p => p[0]))) + 1;
    const j0 = Math.floor(Math.min(...corners.map(p => p[1]))) - 1, j1 = Math.ceil(Math.max(...corners.map(p => p[1]))) + 1;
    const scr = f => ap2(Bs, f);
    // lattice
    o.strokeStyle = C.ink; o.globalAlpha = 0.13; o.lineWidth = 1;
    o.beginPath();
    for (let i = i0; i <= i1; i++) { const a = scr([i, j0]), b = scr([i, j1]); o.moveTo(a[0], a[1]); o.lineTo(b[0], b[1]); }
    for (let j = j0; j <= j1; j++) { const a = scr([i0, j]), b = scr([i1, j]); o.moveTo(a[0], a[1]); o.lineTo(b[0], b[1]); }
    o.stroke();
    // the fundamental domain nearest the middle of the stage, with its cell a touch darker
    const fc = ap2(BsInv, [W / 2, H / 2]), dc = polyCentroid(g.fd);
    const n = [Math.round(fc[0] - dc[0]), Math.round(fc[1] - dc[1])];
    o.globalAlpha = 0.3; o.beginPath();
    [[0, 0], [1, 0], [1, 1], [0, 1]].map(p => scr([p[0] + n[0], p[1] + n[1]])).forEach((p, i) => i ? o.lineTo(p[0], p[1]) : o.moveTo(p[0], p[1]));
    o.closePath(); o.stroke();
    o.beginPath(); g.fd.map(p => scr([p[0] + n[0], p[1] + n[1]])).forEach((p, i) => i ? o.lineTo(p[0], p[1]) : o.moveTo(p[0], p[1])); o.closePath();
    o.globalAlpha = 0.24; o.fillStyle = C.ochre; o.fill();
    o.globalAlpha = 0.35; o.strokeStyle = C.ochre; o.lineWidth = 5; o.stroke();
    o.globalAlpha = 0.75; o.strokeStyle = C.ink; o.lineWidth = 1.2; o.setLineDash([3, 4]); o.stroke(); o.setLineDash([]);
    o.globalAlpha = 1;
    this.fdShift = n;
    if (!this.showElements) return;
    // mirrors (solid) and glides (dashed), drawn at 0.42 like mockup D's overlay canvas
    const diag = Math.hypot(W, H);
    const R = Math.min(40, Math.ceil(diag / this.spacing) + 2);
    o.strokeStyle = C.accent; o.globalAlpha = 0.85 * 0.42;
    mirrorLines(g, Bs, R).forEach(ln => {
      // skip lines that miss the stage
      const dist = Math.abs((W / 2 - ln.p[0]) * ln.d[1] - (H / 2 - ln.p[1]) * ln.d[0]);
      if (dist > diag / 2 + 4) return;
      const tc = (W / 2 - ln.p[0]) * ln.d[0] + (H / 2 - ln.p[1]) * ln.d[1];
      const a = [ln.p[0] + ln.d[0] * (tc - diag), ln.p[1] + ln.d[1] * (tc - diag)], b = [ln.p[0] + ln.d[0] * (tc + diag), ln.p[1] + ln.d[1] * (tc + diag)];
      o.lineWidth = ln.kind === 'mirror' ? 1.3 : 0.9;
      o.setLineDash(ln.kind === 'mirror' ? [] : [4, 3]);
      o.beginPath(); o.moveTo(a[0], a[1]); o.lineTo(b[0], b[1]); o.stroke();
    });
    o.setLineDash([]);
    o.globalAlpha = 0.95 * 0.42;
    const centres = rotationCentres(g);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) centres.forEach(c => {
      const p = scr([c.f[0] + i, c.f[1] + j]);
      if (p[0] < -10 || p[1] < -10 || p[0] > W + 10 || p[1] > H + 10) return;
      glyph(o, p[0], p[1], c.n, 3.5, 0, C, 0.75);
    });
    o.globalAlpha = 1;
  }

  // ---------- every on-screen image of a stroke (screen px) under the group: [{L, t}] with p' = L p + t
  imagesOf(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const c = [(x0 + x1) / 2, (y0 + y1) / 2], r = Math.hypot(x1 - x0, y1 - y0) / 2 + 8;
    const { g, Bs, BsInv, W, H } = this, out = [];
    const corners = [[-r, -r], [W + r, -r], [-r, H + r], [W + r, H + r]].map(p => ap2(BsInv, p));
    const pad = 1 + Math.ceil(r / this.spacing);
    g.L.forEach((L, k) => {
      const t0 = ap2(Bs, g.opsP[k].t), q = ap2(L, c); q[0] += t0[0]; q[1] += t0[1];
      const fq = ap2(BsInv, q);
      const i0 = Math.floor(Math.min(...corners.map(p => p[0])) - fq[0]) - pad, i1 = Math.ceil(Math.max(...corners.map(p => p[0])) - fq[0]) + pad;
      const j0 = Math.floor(Math.min(...corners.map(p => p[1])) - fq[1]) - pad, j1 = Math.ceil(Math.max(...corners.map(p => p[1])) - fq[1]) + pad;
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const s = ap2(Bs, [i, j]), cx = q[0] + s[0], cy = q[1] + s[1];
        if (cx < -r || cy < -r || cx > W + r || cy > H + r) continue;
        out.push({ L, t: [t0[0] + s[0], t0[1] + s[1]] });
      }
    });
    return out;
  }

  // ---------- the streamline sketch (NaN-separated polylines from flow.sketch())
  setSketch(lines) {
    const o = this.sketchLayer.getContext('2d'), { dpr, C } = this;
    o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, this.sketchLayer.width, this.sketchLayer.height);
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.lineCap = 'round'; o.lineJoin = 'round';
    const path = new Path2D();
    let pen = false;
    for (let k = 0; k + 1 < lines.length; k += 2) {
      const x = lines[k], y = lines[k + 1];
      if (Number.isNaN(x)) { pen = false; continue; }
      if (pen) path.lineTo(x, y); else { path.moveTo(x, y); pen = true; }
    }
    // a paper halo under each line keeps the sketch readable over dense ink
    o.strokeStyle = C.paper; o.globalAlpha = 0.55; o.lineWidth = 3.2; o.stroke(path);
    o.strokeStyle = C.ink; o.globalAlpha = C.dark ? 0.7 : 0.62; o.lineWidth = 1.2; o.stroke(path);
    o.globalAlpha = 1;
    this.sketchT0 = performance.now();
  }
  clearSketch() { this.sketchT0 = -1e9; }
  // live stroke and ghosts
  beginStroke(x, y, col) { this.live = { pts: [[x, y]], col }; this.ghosts.push({ pts: this.live.pts, col, live: true, t0: 0 }); }
  extendStroke(x, y) { if (this.live) this.live.pts.push([x, y]); }
  endStroke(keep) {
    if (!this.live) return;
    const gh = this.ghosts.find(g => g.pts === this.live.pts);
    if (gh) { if (keep && !this.reduced) { gh.live = false; gh.t0 = performance.now(); } else this.ghosts.splice(this.ghosts.indexOf(gh), 1); }
    this.live = null;
  }

  // ---------- one frame
  draw(now, flow) {
    const o = this.ctx, { dpr, W, H, C } = this;
    o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, this.cv.width, this.cv.height);
    // static layer, faded in after a group switch
    const ea = Math.min(1, (now - this.elemT0) / 350);
    o.globalAlpha = ea; o.drawImage(this.staticLayer, 0, 0); o.globalAlpha = 1;
    // sketch: fades out over SKETCH_MS (ease-in, so it reads as a hold then a fade); reduced motion holds then drops it
    const st = now - this.sketchT0;
    let sa = 0;
    if (this.reduced) sa = st < SKETCH_HOLD_REDUCED_MS ? 1 : 0;
    else if (st < SKETCH_MS) { const u = st / SKETCH_MS; sa = 1 - u * u; }
    if (sa > 0) { o.globalAlpha = sa; o.drawImage(this.sketchLayer, 0, 0); o.globalAlpha = 1; }
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawCrocs(o);
    this.drawGhosts(o, now);
    if (this.live && this.live.pts.length > 1) {
      o.globalAlpha = 0.95; o.strokeStyle = C.ink; o.lineWidth = 2.8; o.lineCap = 'round'; o.lineJoin = 'round';
      arrowLine(o, this.live.pts, 30, 9);
      o.globalAlpha = 1;
    }
    if (this.lens) this.drawLens(o, flow);
  }
  drawCrocs(o) {
    const cp = this.copies, { C, W, H, dpr } = this, f = this.crocForce, k = this.crocPx;
    if (!cp.length) return;
    // a faint ring shows each croc's reach: rose dashes when it repels, blue dots when it attracts
    if (Math.abs(f) > 0.05) {
      o.globalAlpha = 0.35 * Math.abs(f); o.strokeStyle = f > 0 ? C.rose : C.blue; o.lineWidth = 1;
      o.setLineDash(f > 0 ? [3, 3] : [1.2, 2]);
      const rr = 2.2 * this.reach;
      o.beginPath();
      for (let i = 0; i < cp.length; i += 5) { o.moveTo(cp[i] + rr, cp[i + 1]); o.arc(cp[i], cp[i + 1], rr, 0, 7); }
      o.stroke(); o.setLineDash([]); o.globalAlpha = 1;
    }
    for (let i = 0; i < cp.length; i += 5) {
      const x = cp[i], y = cp[i + 1], a = cp[i + 2], s = cp[i + 3] > 0.5 ? -1 : 1;
      if (x < -k || y < -k || x > W + k || y > H + k) continue;
      const c = Math.cos(a) * k * dpr, sn = Math.sin(a) * k * dpr;
      o.setTransform(c, sn, s * sn, -s * c, x * dpr, y * dpr);
      drawCroc(o, k * dpr, 1, C);
    }
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  drawGhosts(o, now) {
    for (let k = this.ghosts.length - 1; k >= 0; k--) if (!this.ghosts[k].live && now - this.ghosts[k].t0 > GHOST_MS) this.ghosts.splice(k, 1);
    const cols = brushColours(this.C);
    o.lineCap = 'round'; o.lineJoin = 'round'; o.lineWidth = 1.6;
    for (const gh of this.ghosts) {
      if (gh.pts.length < 2) continue;
      o.globalAlpha = gh.live ? 0.5 : 0.5 * Math.max(0, 1 - (now - gh.t0) / GHOST_MS);
      o.strokeStyle = cols[gh.col];
      for (const im of this.imagesOf(gh.pts)) {
        const { L, t } = im;
        // the identity image sits under the live trail; skip it while painting
        if (gh.live && Math.abs(L[0] - 1) < 1e-9 && Math.abs(L[3] - 1) < 1e-9 && Math.abs(t[0]) < 1e-6 && Math.abs(t[1]) < 1e-6) continue;
        arrowLine(o, gh.pts.map(p => [L[0] * p[0] + L[1] * p[1] + t[0], L[2] * p[0] + L[3] * p[1] + t[1]]), 46, 6);
      }
    }
    o.globalAlpha = 1;
  }
  // the current lens: arrows of the local current (plus croc force), a swirl arc, and a one-word reading
  drawLens(o, flow) {
    const { x: X, y: Y } = this.lens, R = LENS_R, C = this.C, US = this.US;
    o.beginPath(); o.arc(X, Y, R, 0, 7);
    o.globalAlpha = 0.72; o.fillStyle = C.paper; o.fill();
    o.globalAlpha = 0.6; o.strokeStyle = C.ink; o.lineWidth = 1.2; o.stroke();
    const step = 17;
    o.globalAlpha = 0.9; o.lineWidth = 1.6; o.lineCap = 'round';
    o.beginPath();
    for (let gy = -R; gy <= R; gy += step) for (let gx = -R; gx <= R; gx += step) {
      if (gx * gx + gy * gy > (R - 9) ** 2) continue;
      const cx = X + gx, cy = Y + gy, v = flow.sample(cx, cy), vx = v[0], vy = v[1], sp = Math.hypot(vx, vy), s = sp / US / this.speed;
      if (s < 0.04) { o.moveTo(cx + 1.2, cy); o.arc(cx, cy, 1.2, 0, 7); continue; }
      const L = (0.35 + 0.65 * Math.min(1, s)) * step * 0.85, ux = vx / sp, uy = vy / sp, hd = 3.5;
      const x1 = cx + ux * L / 2, y1 = cy + uy * L / 2;
      o.moveTo(cx - ux * L / 2, cy - uy * L / 2); o.lineTo(x1, y1);
      o.moveTo(x1 - ux * hd - uy * hd * 0.7, y1 - uy * hd + ux * hd * 0.7); o.lineTo(x1, y1); o.lineTo(x1 - ux * hd + uy * hd * 0.7, y1 - uy * hd - ux * hd * 0.7);
    }
    o.stroke();
    const c = flow.sample(X, Y), spC = Math.hypot(c[0], c[1]) / US / this.speed;
    // swirl: vorticity (rad/s, + = counter-clockwise on screen) scaled as mockup D's omega * sigma / U
    const sw = c[2] / 7 / this.speed;
    let label = spC < 0.05 ? 'calm' : spC < 0.5 ? 'gentle' : spC < 1.2 ? 'brisk' : 'fast';
    if (Math.abs(sw) > 0.08) {
      const ccw = sw > 0, span = Math.PI * (0.5 + 1.1 * Math.min(1, Math.abs(sw))), a0 = -Math.PI / 2, a1 = ccw ? a0 - span : a0 + span, rr = R + 7;
      o.globalAlpha = 0.8; o.strokeStyle = C.accent; o.lineWidth = 2 + 2.5 * Math.min(1, Math.abs(sw));
      o.beginPath(); o.arc(X, Y, rr, a0, a1, ccw); o.stroke();
      const tx = ccw ? Math.sin(a1) : -Math.sin(a1), ty = ccw ? -Math.cos(a1) : Math.cos(a1), ex = X + rr * Math.cos(a1), ey = Y + rr * Math.sin(a1), hd = 8;
      o.beginPath(); o.moveTo(ex - tx * hd - ty * hd * 0.6, ey - ty * hd + tx * hd * 0.6); o.lineTo(ex, ey); o.lineTo(ex - tx * hd + ty * hd * 0.6, ey - ty * hd - tx * hd * 0.6); o.stroke();
      label += ccw ? ' · swirl ↺' : ' · swirl ↻';
    }
    o.font = 'italic 13px "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif'; o.textAlign = 'center';
    const ty = Y + R + 20, tw = o.measureText(label).width;
    o.globalAlpha = 0.75; o.fillStyle = C.paper; o.beginPath();
    // roundRect is missing before Safari 16 and Firefox 112, which take the CPU path
    if (o.roundRect) o.roundRect(X - tw / 2 - 6, ty - 12, tw + 12, 17, 8); else o.rect(X - tw / 2 - 6, ty - 12, tw + 12, 17);
    o.fill();
    o.globalAlpha = 0.95; o.fillStyle = C.ink; o.fillText(label, X, ty);
    o.textAlign = 'start'; o.globalAlpha = 1;
  }
  // the croc copy within `r` CSS px of (x, y), nearest first: { x, y, orbit }, or null
  crocAt(x, y, r = 18) {
    const cp = this.copies; let best = null, bd = r;
    for (let i = 0; i < cp.length; i += 5) { const d = Math.hypot(cp[i] - x, cp[i + 1] - y); if (d < bd) { bd = d; best = { x: cp[i], y: cp[i + 1], orbit: cp[i + 4] }; } }
    return best;
  }
}
