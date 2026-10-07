// The Flow page: wires the engine (escher-web, WebGPU or the Canvas 2D fallback) to the controls, the pointer and the
// overlay. Query parameters for screenshots and checks: ?seed=<u32> opens on that surprise, ?group=<id> on that group
// with no strokes.
import init, { Flow } from './pkg/escher_web.js';
import { Overlay, GROUPS, byId, LATTICES, rotationCentres, hasMirrors } from './overlay.js';

const $ = id => document.getElementById(id);
const canvas = $('canvas'), ov = $('overlay'), stage = $('stage'), statusEl = $('status'), hint = $('hint');
const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const order = [...document.querySelectorAll('#groups [data-id]')].map(b => b.dataset.id);
const MAX_CROCS = 4;
// first visits open on one of these surprise seeds, picked by eye from a survey of seeds 0-23 (full, varied patterns)
const FIRST_SEEDS = [1, 6, 9, 10, 12, 13, 18, 21];

// read by the site's checks: playback speed, and how many strokes the engine holds
window.flowDebug = { speed: 1, strokes: 0 };

let flow = null, group = 'p4', brush = 2, crocs = 0;
// strokes the visitor painted (they sit after any generated ones, so undo removes them first): while there are any,
// "surprise me" keeps the drawing and restyles it instead of generating new currents
let drawn = 0;
const overlay = new Overlay(ov);

// ---------------------------------------------------------------- engine-mirroring helpers
// flow::surprise's hash, so the page knows how many strokes a surprise laid and whether it turned marbling on
function hash01(x) {
  const M = (1n << 64n) - 1n;
  x &= M; x ^= x >> 33n; x = (x * 0xff51afd7ed558ccdn) & M; x ^= x >> 33n;
  return Number(x % 1000003n) / 1000003;
}
const dpr = () => Math.min(2, window.devicePixelRatio || 1);

// ---------------------------------------------------------------- view
function setStatus() {
  if (!flow) return;
  statusEl.textContent = `flowing · ${group} · ${flow.particle_count()} particles · ${flow.gpu ? 'gpu' : 'cpu'}`;
}
function showInfo(id) {
  const g = byId[id];
  $('info').innerHTML = `<div><span class="hm">${id}</span> <span class="muted">· orbifold</span> <span class="orb">${g.orb}</span></div>
    <p>${LATTICES[g.latt].name} lattice, ${g.ops.length} operation${g.ops.length === 1 ? '' : 's'} per cell. ${rotationCentres(g).length ? 'The current must stop dead at every rotation centre' : 'No rotation centres, so nothing forces the current to stop'}${hasMirrors(g) ? ', and it can only slide along mirrors, never cross them.' : '.'}</p>`;
}
function setFrame(transition = false) { overlay.setFrame(byId[group], flow.lattice(), flow.cell_px(), { transition }); }
function sketch() { overlay.setSketch(flow.sketch()); }
function fit() {
  if (!flow) return;
  const r = stage.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const d = dpr();
  flow.resize(r.width, r.height, d);
  overlay.resize(r.width, r.height, d);
  setFrame();
  setStatus();
}
const pressed = (el, on) => el.setAttribute('aria-pressed', on ? 'true' : 'false');
function markGroup() { document.querySelectorAll('#groups [data-id]').forEach(b => pressed(b, b.dataset.id === group)); }

// ---------------------------------------------------------------- actions
function pick(id) {
  if (!flow || !byId[id]) return;
  flow.set_group(id);
  group = id;
  markGroup(); showInfo(id);
  setFrame(true);
  sketch();
  setStatus();
}
// What flow::surprise(seed) will pick: the group (escher-core lists the groups in the same order as GROUPS) and
// whether it turns marbling on.
const predict = s => ({ id: GROUPS[Math.floor(hash01(BigInt(s)) * GROUPS.length) % GROUPS.length].id, marbling: hash01(BigInt(s) + 2n) < 0.5 });
// "surprise me": a random seed on a different group; for generated currents, skip the unmarbled low-order ones, whose
// few short strokes leave most of the paper still
function freshSeed(generating) {
  let s = 0;
  for (let k = 0; k < 40; k++) {
    s = (Math.random() * 2 ** 32) >>> 0;
    const p = predict(s);
    if (p.id !== group && (!generating || p.marbling || byId[p.id].ops.length > 3)) break;
  }
  return s;
}
function surpriseMe() {
  if (drawn > 0) surprise(freshSeed(false), true);
  else surprise(freshSeed(true));
}
// keep = false: new random currents (the engine's surprise); keep = true: the same strokes, restyled
function surprise(seed, keep = false) {
  const s = seed >>> 0, id = keep ? flow.restyle(s) : flow.surprise(s);
  if (id !== predict(s).id) console.warn(`surprise(${s}): the engine picked ${id}, the page expected ${predict(s).id}`);
  group = id;
  if (!keep) { window.flowDebug.strokes = 2 + Math.floor(hash01(BigInt(s) + 1n) * 3); drawn = 0; }
  pressed($('marbling'), predict(s).marbling);
  markGroup(); showInfo(id);
  setFrame(true);
  sketch();
  setStatus();
}
function addCroc() {
  if (!flow || crocs >= MAX_CROCS) return;
  // drop it where the current runs fastest among a few random spots near the middle, as mockup D does
  const r = stage.getBoundingClientRect();
  let best = [r.width / 2, r.height / 2], bs = -1;
  for (let k = 0; k < 40; k++) {
    const x = r.width * (0.2 + 0.6 * Math.random()), y = r.height * (0.2 + 0.6 * Math.random()), v = flow.sample(x, y), s = Math.hypot(v[0], v[1]);
    if (s > bs) { bs = s; best = [x, y]; }
  }
  if (flow.add_croc(best[0], best[1]) >= 0) crocs++;
  $('addcroc').disabled = crocs >= MAX_CROCS;
}
function clearAll() {
  flow.clear();
  crocs = 0; $('addcroc').disabled = false;
  window.flowDebug.strokes = 0; drawn = 0;
  overlay.clearSketch();
}
function undo() {
  if (window.flowDebug.strokes === 0) return;
  flow.undo();
  window.flowDebug.strokes--;
  if (drawn > 0) drawn--;
  sketch();
}
function applyReduced() {
  const on = reduceMQ.matches;
  flow.set_speed(on ? 0.5 : 1);
  flow.set_swimming(!on);
  overlay.reduced = on;
  overlay.speed = on ? 0.5 : 1;
  window.flowDebug.speed = on ? 0.5 : 1;
}
const forceLabel = v => {
  const word = v > 0.05 ? 'repel' : v < -0.05 ? 'attract' : 'off';
  $('forceval').textContent = word;
  $('crocforce').setAttribute('aria-valuetext', word === 'off' ? 'off' : `${word}, ${Math.round(Math.abs(v) * 100)}%`);
};

// ---------------------------------------------------------------- pointer: paint, or grab a croc
const touches = new Set();
let painting = null, grab = null;
const xy = e => { const r = ov.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
const hideHint = () => hint.classList.add('gone');
function cancelGesture() {
  if (painting) { overlay.endStroke(false); painting = null; }
  if (grab) { grab = null; ov.classList.remove('grabbing'); }
  overlay.lens = null;
}
ov.addEventListener('pointerdown', e => {
  if (!flow) return;
  if (e.pointerType === 'touch') touches.add(e.pointerId);
  // a second finger means a pinch or a two-finger scroll: drop whatever the first finger started
  if (!e.isPrimary || touches.size > 1) { cancelGesture(); return; }
  if (e.button > 0) return;
  ov.setPointerCapture(e.pointerId);
  const [x, y] = xy(e);
  hideHint();
  const hit = overlay.crocAt(x, y, 18);
  if (hit) {
    grab = { id: e.pointerId, orbit: hit.orbit, dx: hit.x - x, dy: hit.y - y };
    overlay.lens = null;
    ov.classList.add('grabbing');
    return;
  }
  painting = { id: e.pointerId, pts: [[x, y]] };
  overlay.beginStroke(x, y, brush);
  overlay.lens = { x, y };
});
ov.addEventListener('pointermove', e => {
  if (!flow) return;
  if (!e.isPrimary || touches.size > 1) return;
  const [x, y] = xy(e);
  if (grab && e.pointerId === grab.id) { flow.move_croc(grab.orbit, x + grab.dx, y + grab.dy); return; }
  if (painting && e.pointerId === painting.id) {
    overlay.lens = { x, y };
    const l = painting.pts[painting.pts.length - 1];
    if (Math.hypot(x - l[0], y - l[1]) < 3) return;
    painting.pts.push([x, y]);
    overlay.extendStroke(x, y);
    return;
  }
  if (e.pointerType === 'mouse') {
    overlay.lens = { x, y };
    ov.classList.toggle('over-croc', !!overlay.crocAt(x, y, 18));
  }
});
function endPointer(e) {
  touches.delete(e.pointerId);
  if (grab && e.pointerId === grab.id) { grab = null; ov.classList.remove('grabbing'); }
  if (painting && e.pointerId === painting.id) {
    const pts = painting.pts;
    painting = null;
    if (e.type === 'pointerup' && pts.length >= 2) {
      flow.stroke(new Float32Array(pts.flat()), brush, +$('strength').value);
      window.flowDebug.strokes++;
      drawn++;
      overlay.endStroke(true);
      sketch();
    } else overlay.endStroke(false);
  }
  if (e.pointerType !== 'mouse') overlay.lens = null;
}
ov.addEventListener('pointerup', endPointer);
ov.addEventListener('pointercancel', endPointer);
ov.addEventListener('pointerleave', () => { if (!painting && !grab) overlay.lens = null; });

// ---------------------------------------------------------------- controls
document.getElementById('groups').addEventListener('click', e => { const b = e.target.closest('[data-id]'); if (b) pick(b.dataset.id); });
document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  if (e.target instanceof HTMLInputElement) return;   // arrows move a focused slider
  const i = order.indexOf(group), n = order.length;
  pick(order[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n]);
});
document.querySelectorAll('[data-brush]').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('[data-brush]').forEach(x => pressed(x, x === b));
  brush = +b.dataset.brush;
}));
const toggle = (id, fn) => $(id).addEventListener('click', e => {
  if (!flow) return;
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  pressed(e.currentTarget, on); fn(on);
});
toggle('marbling', on => { flow.set_marbling(on); sketch(); });
toggle('byspeed', on => flow.set_colour_by_speed(on));
toggle('elements', on => { overlay.showElements = on; overlay.drawStatic(); });
$('trails').addEventListener('input', e => flow && flow.set_trails(+e.target.value));
$('crocforce').addEventListener('input', e => {
  const v = +e.target.value;
  forceLabel(v); overlay.crocForce = v;
  if (flow) flow.set_croc_force(v);
});
$('addcroc').addEventListener('click', addCroc);
$('surprise').addEventListener('click', () => flow && surpriseMe());
$('undo').addEventListener('click', () => flow && undo());
$('clear').addEventListener('click', () => flow && clearAll());
forceLabel(+$('crocforce').value);

// ---------------------------------------------------------------- start
async function start() {
  try {
    await init();
    flow = await Flow.create(canvas, darkMQ.matches);
  } catch (err) {
    statusEl.textContent = `the flow could not start: ${err?.message ?? err}`;
    throw err;
  }
  fit();
  flow.set_trails(+$('trails').value);
  const force = +$('crocforce').value;
  flow.set_croc_force(force); overlay.crocForce = force;
  applyReduced();
  reduceMQ.addEventListener('change', applyReduced);
  darkMQ.addEventListener('change', () => { flow.set_dark(darkMQ.matches); overlay.setTheme(); });
  const q = new URLSearchParams(location.search);
  if (q.get('group') && byId[q.get('group')]) { pick(q.get('group')); overlay.clearSketch(); }
  else surprise(q.has('seed') ? +q.get('seed') : FIRST_SEEDS[Math.floor(Math.random() * FIRST_SEEDS.length)]);
  new ResizeObserver(fit).observe(stage);
  let last = performance.now();
  // the next frame is booked first, so one throwing draw cannot stop the flow for good
  const tick = now => {
    requestAnimationFrame(tick);
    flow.frame((now - last) / 1000); last = now;
    overlay.copies = flow.copies();
    overlay.draw(now, flow);
  };
  requestAnimationFrame(tick);
  window.flowPage = { flow, overlay, pick, surprise: s => surprise(s), addCroc, crocCopy: () => overlay.copies.slice(0, 5) };
}
start();
