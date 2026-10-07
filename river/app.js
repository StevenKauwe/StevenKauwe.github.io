// app.js: River, the toy. A little croc made of watercolour pigment, living in a stream.
// Tools act on the water (currents, the knife, pigment, stones, calm); the croc does the rest.

import { World, CROC_HUE } from './river-world.js';
import { paperPlate } from './plate.js';

const Q = new URLSearchParams(location.search);
const $ = s => document.querySelector(s);
const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)'), darkMQ = matchMedia('(prefers-color-scheme: dark)');
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const fail = e => { window.failed = String(e && (e.stack || e)); console.error(e); };

function fallback(why) {
  window.fallback = why;
  $('#stage').hidden = true; $('.dock').hidden = true; $('.corner').hidden = true;
  const fb = $('.fallback'); fb.hidden = false;
  const img = fb.querySelector('img');
  img.src = !reduceMQ.matches && img.dataset.loop ? img.dataset.loop : img.dataset.still;
  window.ready = true;
}

// ---- boot ----
const glc = $('#gl'), ov = $('#ov'), ctx = ov.getContext('2d');
const gl = glc.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: Q.has('shots') });
let weights, doc;
try {
  if (!gl || !gl.getExtension('EXT_color_buffer_float') || gl.getParameter(gl.MAX_DRAW_BUFFERS) < 7) throw new Error('no WebGL2 float render targets');
  [weights, doc] = await Promise.all([fetch(Q.get('w') || 'river-weights.json').then(r => r.json()), fetch('parts.json').then(r => r.json())]);
} catch (e) { fallback(String(e.message || e)); throw e; }

// ---- layout: the grid is sized from the viewport (a croc about 40% of a wide screen), within a cell budget ----
const coarse = matchMedia('(pointer: coarse)').matches;
let quality = +(Q.get('q') ?? (coarse ? 1 : 2));           // 0 low, 1 phone, 2 desktop
const BUDGET = [14000, 26000, 34000];
const PAINT_CAP = 0.6;           // the fastest a painted current can be, cells/step
const V = { off: [0, 0], cell: 8, dpr: 1, w: 0, h: 0 };
let W = 0, H = 0, world = null, dprCap = 2;
function gridFor(w, h) {
  let cell = Math.max(w / 200, Math.sqrt(w * h / BUDGET[quality]), 3);
  if (h > w) cell = Math.min(cell, Math.max(3, w / 112));   // portrait: keep a croc inside the width
  return { cell, W: Math.ceil(w / cell), H: Math.ceil(h / cell) };
}
function layout() {
  const w = innerWidth, h = innerHeight;
  V.dpr = Math.min(dprCap, devicePixelRatio || 1);
  glc.width = ov.width = Math.round(w * V.dpr); glc.height = ov.height = Math.round(h * V.dpr);
  V.w = glc.width; V.h = glc.height;
  // the grid covers the window (cropped a little on the long side if the window has changed shape)
  V.cell = Math.max(w / W, h / H);
  V.off = [(w - W * V.cell) / 2, (h - H * V.cell) / 2];
  if (world) world.painter.setPlate(paperPlate(16, 16, getComputedStyle(document.body).backgroundColor));
}
function build() {
  const g = gridFor(innerWidth, innerHeight);
  W = g.W; H = g.H;
  world = new World(gl, weights, doc, W, H, { seed: Q.has('seed') ? +Q.get('seed') : (Math.random() * 1e9) | 0, tracers: Math.round(W * H / 150) });
  window.world = world;
  // painted currents persist until cleared (Clear, or the Calm brush where it passes), capped so they never run away
  world.psiDecay = 1; world.flow.paintCap = PAINT_CAP;
  if (weights.glide) world.glide = weights.glide;      // the rule's measured residual glide, cancelled under each croc
  layout();
}
build();
let resizeT = 0;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    const g = gridFor(innerWidth, innerHeight);
    // a big change of shape (a phone turned) gets a new river; anything else is refitted
    if (Math.abs(Math.log((g.W / g.H) / (W / H))) > 0.45) { build(); start(scene.name); } else layout();
  }, 150);
});
darkMQ.addEventListener?.('change', layout);

// ---- the stamp: one croc, grown once from a seed, copied into scenes ----
let stamp = null;
function captureStamp() {
  const p = world.crocs.pieces.filter(q => q.mass > 200).sort((a, b) => b.mass - a.mass)[0];
  if (!p || p.seam) return false;
  const x0 = p.x0 - 3, y0 = Math.max(0, p.y0 - 3), w = p.x1 - p.x0 + 7, h = Math.min(H, p.y1 + 4) - y0;
  stamp = { w, h, data: world.sim.getRegion(x0, y0, w, h), dx: p.cx - x0, dy: p.cy - y0, face: p.facing };
  return true;
}
function place(cx, cy, face = 1) {
  const s = stamp, mirror = face !== s.face;
  const dx = mirror ? s.w - s.dx : s.dx;
  const x0 = Math.round(cx - dx), y0 = Math.round(cy - s.dy);
  world.sim.putRegion(x0, y0, s.w, s.h, s.data, mirror);
  world.crocs.seedFacing(((Math.round(cx) % W) + W) % W, Math.min(H - 1, Math.max(0, Math.round(cy))), face);
  for (let y = Math.max(0, y0 - 4); y < Math.min(H, y0 + s.h + 4); y++) for (let x = x0 - 4; x < x0 + s.w + 4; x++) world.sim.facingData[y * W + ((x % W) + W) % W] = face;
  world.sim.uploadFacing();
}

// ---- scenes ----
const timed = [];                 // transient currents: { el, t0, dur } in frames
function addTimed(el, dur, rampIn = 12, rampOut = 30) { timed.push({ el, t0: frame, dur, rampIn, rampOut }); }
function potentialFlow(solid) {
  // potential flow left -> right around walls (SOR, Neumann at walls and banks), unit far-field speed
  const phi = new Float32Array(W * H);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) phi[y * W + x] = 1 - x / (W - 1);
  const sol = (x, y) => y < 0 || y >= H || solid[y * W + x];
  for (let it = 0; it < 900; it++) for (let y = 0; y < H; y++) for (let x = 1; x < W - 1; x++) {
    if (sol(x, y)) continue;
    let s = 0, n = 0;
    if (!sol(x + 1, y)) { s += phi[y * W + x + 1]; n++; } if (!sol(x - 1, y)) { s += phi[y * W + x - 1]; n++; }
    if (!sol(x, y + 1)) { s += phi[(y + 1) * W + x]; n++; } if (!sol(x, y - 1)) { s += phi[(y - 1) * W + x]; n++; }
    if (n) phi[y * W + x] += 1.85 * (s / n - phi[y * W + x]);
  }
  const f = new Float32Array(W * H * 2);
  for (let y = 0; y < H; y++) for (let x = 1; x < W - 1; x++) {
    if (sol(x, y)) continue;
    const p = (xx, yy) => sol(xx, yy) ? phi[y * W + x] : phi[yy * W + xx];
    f[(y * W + x) * 2] = -(p(x + 1, y) - p(x - 1, y)) / 2 * (W - 1);
    f[(y * W + x) * 2 + 1] = -(p(x, y + 1) - p(x, y - 1)) / 2 * (W - 1);
  }
  for (let y = 0; y < H; y++) { f[(y * W) * 2] = f[(y * W + 1) * 2]; f[(y * W + W - 1) * 2] = f[(y * W + W - 2) * 2]; }
  return f;
}

const SCENES = {
  free: { label: 'Free play', setup() { world.water([{ type: 'band', y: H / 2, h: H * 0.2, level: 0.1 }, { type: 'even', level: 0.012 }]); place(W / 2, H / 2, 1); } },
  twins: {
    label: 'Twins',
    setup() { world.water([{ type: 'band', y: H / 2, h: Math.max(20, H * 0.2), level: 0.17 }]); place(W / 2, H / 2, 1); },
    script(f) { if (f === 50) { const [x, y] = world.centroid('biggest'); world.tear({ x, y, follow: true }); } },
  },
  fuse: {
    label: 'Fuse',
    setup() {
      world.water([{ type: 'even', level: 0.03 }]);
      if (W >= 190) { place(W / 2 - 50, H / 2 - 2, 1); place(W / 2 + 50, H / 2 + 2, -1); this.axis = 0; }
      else { place(W / 2, H / 2 - 26, 1); place(W / 2, H / 2 + 26, 1); this.axis = Math.PI / 2; }
      this.stop = -1;
    },
    script(f) {
      if (f === 30) { const [x, y] = world.centroid(); this.el = { type: 'squeeze', x, y, angle: this.axis, s: -0.5, L: 6, amp: 0 }; }
      if (!this.el) return;
      if (this.stop < 0 && f > 60 && world.crocs.pieces.filter(p => p.mass > 100).length === 1) this.stop = f;
      this.el.amp = smooth(30, 45, f) * (this.stop < 0 ? 1 : 1 - smooth(this.stop + 6, this.stop + 20, f));
      if (this.el.amp > 1e-3) world.elements.push(this.el);
    },
  },
  slit: {
    label: 'Slit',
    setup() {
      const solid = new Uint8Array(W * H), xw = Math.round(W * 0.6), cy = Math.round(H / 2);
      for (let y = 0; y < H; y++) for (let x = xw; x < xw + 4; x++) if (Math.abs(y + 0.5 - cy) > 3.5) solid[y * W + x] = 1;
      world.setSolid(solid, solid);
      world.water([{ type: 'even', level: 0.02 }]);
      place(xw - 52, cy, 1);
      const ff = potentialFlow(solid);
      for (let i = 0; i < ff.length; i += 2) { ff[i] *= 0.3; ff[i + 1] *= 0.3; const s = Math.hypot(ff[i], ff[i + 1]); if (s > 0.9) { ff[i] *= 0.9 / s; ff[i + 1] *= 0.9 / s; } }
      world.field = ff;
      this.xw = xw; this.passed = -1;
    },
    script(f) {
      // the current runs until nearly all the pigment is past the wall, then the water calms
      if (this.passed < 0 && f > 40) {
        let a = 0, b = 0; const r = world.sim.read1;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = Math.max(0, r[(y * W + x) * 4 + 1]); b += v; if (x < this.xw + 2) a += v; }
        if (b > 0 && a / b < 0.12) this.passed = f;
      }
      world.fieldAmp = this.passed < 0 ? smooth(0, 25, f) : 1 - smooth(this.passed, this.passed + 30, f);
    },
  },
  dissolve: {
    label: 'Dissolve',
    setup() { world.water([{ type: 'band', y: H / 2, h: H * 0.2, level: 0.06 }]); place(W / 2, H / 2, 1); },
    script(f) {
      // a swirl through the croc that dies away by itself, then the water stills and it gathers itself back
      if (f === 15) { const [x, y] = world.centroid('biggest'); addTimed({ type: 'vortex', x, y, r: Math.min(22, H * 0.18), w: 0.34 }, 75, 10, 30); }
    },
  },
};
let scene = { name: 'intro' }, frame = 0, sceneFrame = 0, introDone = false;

function start(name) {
  if (!stamp) { pendingScene = name; return; }
  name = SCENES[name] ? name : 'free';
  timed.length = 0;
  world.reset();
  world.setSolid(new Uint8Array(W * H));
  scene = Object.assign(Object.create(SCENES[name]), { name });
  scene.setup();
  world.sim.frame(0, 1, true);
  world.crocs.update(i => world.sim.read1[i * 4 + 1], world.sim.flowData, world.sim.facingData);
  world.sim.uploadFacing();
  world.total0 = null;
  sceneFrame = 0;
  for (const b of document.querySelectorAll('#scenes button')) b.setAttribute('aria-current', String(b.dataset.scene === name));
  idleSince = performance.now();
}
let pendingScene = Q.get('scene');

// the intro: a seed in a bloom of pigment grows the first croc in front of you; it becomes the stamp
function intro() {
  world.reset();
  world.setSolid(new Uint8Array(W * H));
  world.water([{ type: 'blob', x: W / 2, y: H / 2, r: 16, level: 1.1 }, { type: 'band', y: H / 2, h: H * 0.2, level: 0.06 }]);
  world.seed(W / 2, H / 2, 1);
  scene = { name: 'intro' };
}
intro();

// ---- tools ----
let tool = 'current';
const strokes = new Map();      // pointerId -> { pts, last, erase, t }
const cutMarks = [];            // fading ink slashes where the knife went
const toGrid = e => { const r = glc.getBoundingClientRect(); return [(e.clientX - r.left - V.off[0]) / V.cell, (e.clientY - r.top - V.off[1]) / V.cell]; };
const stage = $('#stage');
stage.addEventListener('pointerdown', e => {
  if (e.button > 0) return;
  stage.setPointerCapture(e.pointerId);
  const p = toGrid(e), i = Math.floor(p[1]) * W + ((Math.floor(p[0]) % W) + W) % W;
  strokes.set(e.pointerId, { pts: [p], last: p, erase: tool === 'rock' && world.solid[i] === 1, t: performance.now() });
  idleSince = performance.now();
  act(strokes.get(e.pointerId), p, true);
  e.preventDefault();
});
stage.addEventListener('pointermove', e => {
  const s = strokes.get(e.pointerId);
  if (!s) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ce of evs.length ? evs : [e]) { const p = toGrid(ce); act(s, p, false); s.pts.push(p); s.last = p; }
  idleSince = performance.now();
});
const end = e => {
  const s = strokes.get(e.pointerId);
  if (!s) return;
  strokes.delete(e.pointerId);
  if (tool === 'knife' && s.pts.length > 1) world.tearAcross(s.pts);
  if (tool === 'rock') world.commitStones();
};
stage.addEventListener('pointerup', end);
stage.addEventListener('pointercancel', end);

function act(s, p, first) {
  const a = s.last;
  if (tool === 'current') {
    if (first) return;
    const dx = p[0] - a[0], dy = p[1] - a[1], l = Math.hypot(dx, dy);
    if (l < 0.3) return;
    // a stroke's speed follows the drag's, gently capped
    const sp = Math.min(1.1, l * 0.12 * (reduceMQ.matches ? 0.5 : 1));
    // (measured: a steady drag of 3 cells a frame makes about 0.4 cells/step under the brush, fading over a second;
    // overlapping dabs add up along the stroke, hence the small gain)
    for (let k = 1, n = Math.ceil(l / 2); k <= n; k++) world.flow.dab(a[0] + dx * k / n, a[1] + dy * k / n, dx / l, dy / l, sp / n * 0.048, 9, PAINT_CAP);
    hintDone('current');
  } else if (tool === 'knife') {
    if (first) return;
    world.sim.knife(a, p, 1.4);
    cutMarks.push({ a, b: p, life: 1 });
  } else if (tool === 'pigment') {
    world.feed(p[0], p[1], 5, first ? 18 : 6);
    if (first) sound.drip();
    // an empty river: a drop of pigment becomes a seed
    if (first && world.crocs.count() === 0 && !world.crocs.pieces.length) world.seed(p[0] - 20, p[1] + 9.5, 1);
  } else if (tool === 'rock') {
    const r = 3.2, live = world.sim.read1;
    const steps = Math.max(1, Math.ceil(Math.hypot(p[0] - a[0], p[1] - a[1]) / 1.5));
    for (let k = 0; k <= steps; k++) {
      const cx = a[0] + (p[0] - a[0]) * k / steps, cy = a[1] + (p[1] - a[1]) * k / steps;
      for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (y < 1 || y >= H - 1 || (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
        const i = y * W + ((x % W) + W) % W;
        if (s.erase) world.setStone(i, 0);
        else if (live[i * 4 + 1] < 0.05) world.setStone(i, 1);      // stones grow around a croc, never through it
      }
    }
    world.sim.uploadField();
  } else if (tool === 'calm') {
    const r = 12;
    for (let y = Math.floor(p[1] - 2 * r); y <= p[1] + 2 * r; y++) for (let x = Math.floor(p[0] - 2 * r); x <= p[0] + 2 * r; x++) {
      if (y < 0 || y >= H) continue;
      const g = Math.exp(-((x + 0.5 - p[0]) ** 2 + (y + 0.5 - p[1]) ** 2) / (2 * r * r)), i = y * W + ((x % W) + W) % W;
      world.calm[i] = Math.min(world.calm[i], 1 - 0.95 * g);
      world.flow.psi[i] *= 1 - 0.6 * g;
    }
  }
}
function setTool(t) {
  tool = t; document.body.dataset.tool = t;
  for (const b of document.querySelectorAll('.dock button[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
}
for (const b of document.querySelectorAll('.dock button[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
// clear every painted current at once (the Calm brush clears them where it passes)
function clearCurrents() { world.flow.psi.fill(0); world.calm.fill(1); world.flowDirty = true; }
document.querySelector('#clear').addEventListener('click', clearCurrents);
setTool('current');

// ---- surprise ----
function surprise() {
  const ps = world.crocs.pieces.filter(p => p.body >= 150).sort((a, b) => b.mass - a.mass);
  const options = [];
  if (ps.length) options.push('tear', 'swirl', 'bloom');
  if (ps.length >= 2) options.push('press', 'press');
  if (ps.length === 0) options.push('seed');
  const pick = options[Math.floor(Math.random() * options.length)];
  if (pick === 'tear') { const p = ps[0]; world.tear({ x: p.cx, y: p.cy, angle: (Math.random() - 0.5) * 0.4, len: 30, follow: true }); sound.tear(); }
  if (pick === 'swirl') { const p = ps[Math.floor(Math.random() * ps.length)]; addTimed({ type: 'vortex', x: p.cx, y: p.cy, r: 26, w: (Math.random() < 0.5 ? 1 : -1) * 0.45 }, 70, 10, 25); }
  if (pick === 'bloom') { const p = ps[ps.length - 1]; world.feed(p.cx + (Math.random() - 0.5) * 30, p.cy + (Math.random() - 0.5) * 16, 9, 350); sound.drip(); }
  if (pick === 'press') {
    const [a, b] = ps, ang = Math.atan2(b.cy - a.cy, b.cx - a.cx);
    addTimed({ type: 'squeeze', x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2, angle: ang, s: -0.5, L: 6, lenY: 30 }, 150, 12, 20);
  }
  if (pick === 'seed') { world.feed(W / 2, H / 2, 14, 900); world.seed(W / 2, H / 2, 1); }
  idleSince = performance.now();
  return pick;
}
$('#surprise').addEventListener('click', () => surprise());

// ---- scenes menu ----
const sb = $('#scenes-btn'), sl = $('#scenes');
const menu = open => { sl.hidden = !open; sb.setAttribute('aria-expanded', String(open)); };
sb.addEventListener('click', () => menu(sl.hidden));
for (const b of sl.querySelectorAll('button')) b.addEventListener('click', () => { menu(false); start(b.dataset.scene); });
addEventListener('pointerdown', e => { if (!sl.hidden && !e.target.closest('.menu')) menu(false); });

// ---- keys ----
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const tools = ['current', 'knife', 'pigment', 'rock', 'calm'];
  if (k >= '1' && k <= '5') setTool(tools[+k - 1]);
  if (k === 's') surprise();
  if (k === 'c' || k === '0') clearCurrents();
  if (k === 'm') toggleSound();
  if (k === 'escape') menu(false);
});

// ---- sound: soft, synthesised, off until asked for ----
const sound = {
  on: false, ac: null,
  ensure() { if (!this.ac) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) { this.ac = new AC(); this.out = this.ac.createGain(); this.out.gain.value = 0.9; this.out.connect(this.ac.destination); } } return this.ac; },
  env(node, t, a, d, peak) { const g = this.ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(1e-4, t + a + d); node.connect(g); g.connect(this.out); return g; },
  tone(f0, f1, dur, peak, type = 'sine') {
    if (!this.on || !this.ensure()) return;
    const t = this.ac.currentTime, o = this.ac.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    this.env(o, t, 0.01, dur, peak); o.start(t); o.stop(t + dur + 0.05);
  },
  tear() {
    if (!this.on || !this.ensure()) return;
    const t = this.ac.currentTime, n = this.ac.sampleRate * 0.2, b = this.ac.createBuffer(1, n, this.ac.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = this.ac.createBufferSource(); s.buffer = b;
    const f = this.ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.8; s.connect(f);
    this.env(f, t, 0.005, 0.18, 0.09); s.start(t);
  },
  merge() { this.tone(240, 120, 0.45, 0.07); },
  eye() { this.tone(660, 640, 0.5, 0.025); setTimeout(() => this.tone(990, 980, 0.45, 0.018), 70); },
  drip() { this.tone(500, 820, 0.09, 0.03); },
};
function toggleSound() {
  sound.on = !sound.on; if (sound.on) { sound.ensure(); sound.ac?.resume(); }
  $('#sound').setAttribute('aria-pressed', String(sound.on));
  store.set('river-sound', sound.on ? '1' : '0');
}
$('#sound').addEventListener('click', toggleSound);

// ---- hints: three, once, dismissible ----
const HINTS = [['current', 'Drag on the water to make a current'], ['cut', 'Pick the knife and slice through the croc'], ['merge', 'Push two crocs together']];
let hintAt = Math.min(HINTS.length, +(store.get('river-hints') ?? 0)), hintShown = -1;
if (store.get('river-hints') === 'off') hintAt = HINTS.length;
const hintEl = $('.hint');
function showHint() {
  if (hintAt >= HINTS.length || !introDone) { hintEl.hidden = true; return; }
  if (hintShown === hintAt) return;
  hintShown = hintAt; hintEl.querySelector('p').textContent = HINTS[hintAt][1];
  hintEl.hidden = false; hintEl.classList.add('out'); requestAnimationFrame(() => hintEl.classList.remove('out'));
}
function hintDone(key) {
  if (hintAt < HINTS.length && HINTS[hintAt][0] === key) { hintAt++; store.set('river-hints', String(hintAt)); hintEl.classList.add('out'); setTimeout(showHint, 500); }
}
hintEl.querySelector('button').addEventListener('click', () => { hintAt = HINTS.length; store.set('river-hints', 'off'); hintEl.hidden = true; });

// ---- the loop ----
let autoEvents = 0, spf = reduceMQ.matches ? 1 : 2, idleSince = performance.now(), lastCount = 1, workEMA = 10, slowFor = 0, fastFor = 0;
const countEl = $('.count');
function themeOpts() {
  const dark = darkMQ.matches && !Q.has('light');
  return dark ? { dark: true, paper: [0.122, 0.106, 0.149], ink: 'rgb(241,232,216)', tracer: [150, 182, 210], tracerStrength: 0.28 }
    : { dark: false, paper: [0.953, 0.922, 0.863], ink: 'rgb(42,42,38)', tracer: [70, 120, 150], tracerStrength: 0.28 };
}
function tick() {
  const t0 = performance.now();
  // currents for this frame: the scene's script, transient currents, a fixed field (the slit's)
  world.elements = [];
  if (scene.script) scene.script(sceneFrame);
  for (const tm of timed) { const k = frame - tm.t0; const a = smooth(0, tm.rampIn, k) * (1 - smooth(tm.dur - tm.rampOut, tm.dur, k)); if (a > 1e-3) world.elements.push({ ...tm.el, amp: a }); }
  for (let i = timed.length - 1; i >= 0; i--) if (frame - timed[i].t0 > timed[i].dur) timed.splice(i, 1);
  world.step(spf, { ease: 0.5 });
  frame++; sceneFrame++;
  if (scene.name === 'intro' && !introDone) {
    const p = world.crocs.pieces[0];
    if (world.sim.steps > 380 && p && p.mass > 900 && (world.found[0] || []).some(s => s.goal > 0) && captureStamp()) {
      introDone = true;
      scene = { name: 'free' };
      if (pendingScene) { start(pendingScene); pendingScene = null; }
      setTimeout(showHint, 1200);
    }
  }
  // events: sound, hints, the counter
  for (const ev of world.events) {
    if (ev.type === 'cut') sound.tear();
    if (ev.type === 'merge') { sound.merge(); hintDone('merge'); }
    if (ev.type === 'split') hintDone('cut');
    if (ev.type === 'eye') sound.eye();
  }
  world.events = [];
  const n = world.crocs.count();
  if (n !== lastCount) {
    countEl.querySelector('b').textContent = n; countEl.querySelector('span').textContent = n === 1 ? 'croc' : 'crocs';
    countEl.classList.add('bump'); setTimeout(() => countEl.classList.remove('bump'), 260); lastCount = n;
  }
  // idle: after a while with nothing to do, the river does something on its own (never with reduced motion)
  if (!reduceMQ.matches && introDone && performance.now() - idleSince > 40000) { surprise(); autoEvents++; }
  return performance.now() - t0;
}
function draw() {
  const o = themeOpts();
  world.render(ctx, V, { ...o, time: frame / 60, dt: 0.5 });
  ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  for (const m of cutMarks) {
    ctx.strokeStyle = o.ink; ctx.globalAlpha = m.life * 0.8; ctx.lineWidth = Math.max(1, V.cell * 0.35); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(V.off[0] + m.a[0] * V.cell, V.off[1] + m.a[1] * V.cell); ctx.lineTo(V.off[0] + m.b[0] * V.cell, V.off[1] + m.b[1] * V.cell); ctx.stroke();
    m.life -= 0.06;
  }
  ctx.globalAlpha = 1;
  for (let i = cutMarks.length - 1; i >= 0; i--) if (cutMarks[i].life <= 0) cutMarks.splice(i, 1);
}
// the frame budget: fewer steps per frame, then fewer pixels, when frames run long; more steps when there is room.
// It never shrinks the grid: that means a new world, and it would wipe the river the visitor has made.
function adapt(work) {
  workEMA += (work - workEMA) * 0.05;
  if (workEMA > 15) { slowFor++; fastFor = 0; } else if (workEMA < 8) { fastFor++; slowFor = 0; } else { slowFor = fastFor = 0; }
  if (slowFor > 90) {
    slowFor = 0;
    if (spf > 1) spf--;
    else if (dprCap > 1) { dprCap = Math.max(1, dprCap - 0.5); layout(); }
  }
  if (fastFor > 240 && spf < (reduceMQ.matches ? 1 : 3)) { fastFor = 0; spf++; }
}
let running = !Q.has('paused');
function loop() {
  if (running && !document.hidden) {
    try { const w = tick(); draw(); adapt(w + 2); } catch (e) { fail(e); running = false; }
  }
  requestAnimationFrame(loop);
}
draw();
window.ready = true;
requestAnimationFrame(loop);
if (store.get('river-sound') === '1') { /* sound needs a gesture to start; the toggle remembers the choice */ $('#sound').setAttribute('aria-pressed', 'false'); }

// ---- hooks for the checks ----
window.river = {
  get introDone() { return introDone; },
  stats() { return { ...world.stats(), scene: scene.name, spf, quality, dpr: V.dpr, grid: [W, H], frame, workMs: +workEMA.toFixed(2), introDone, reduced: reduceMQ.matches, autoEvents }; },
  idle() { idleSince = -1e9; },
  start(name) { start(name); return this.stats(); },
  advance(n) { for (let i = 0; i < n; i++) { tick(); draw(); } return this.stats(); },
  pause() { running = false; }, resume() { running = true; },
  // the knife through the biggest croc, top to bottom, as a visitor would cut it
  cutCroc() {
    const p = world.crocs.pieces.filter(q => q.body >= 150).sort((a, b) => b.mass - a.mass)[0];
    if (!p) return null;
    const pts = []; for (let y = p.y0 - 4; y <= p.y1 + 4; y += 2) pts.push([p.cx, y]);
    for (let i = 1; i < pts.length; i++) world.sim.knife(pts[i - 1], pts[i], 1.4);
    world.tearAcross(pts);
    return [p.cx, p.cy];
  },
  surprise, clearCurrents,
  // the fastest the painted current is anywhere right now (cells/step)
  paintedMax() { const f = new Float32Array(W * H * 2); world.flow.compose(f, [], 99); let m = 0; for (let i = 0; i < f.length; i += 2) m = Math.max(m, Math.hypot(f[i], f[i + 1])); return +m.toFixed(3); },
};
