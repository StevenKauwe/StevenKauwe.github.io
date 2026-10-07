// croc-render.js: paints the croc's parts on a 2D canvas, crisp at any size. Each part is drawn with its own transform
// (position, scale, rotation), opacity, and how much of its ink is drawn so far; its outline paths come from the film.
// (River's copy of regrow-croc/web/croc-render.js, plus an extra local scale sx, sy per draw: sx < 0 mirrors a
// sprite for a croc facing left, sy < 1 shuts an eye for a blink.)
//
//   const R = prepare(partsDoc);          // once
//   draw(ctx, R, params, view);           // every frame; params: Float32Array of N × 6 (x, y, scale, rot, alpha, drawn)

const BOILS = 3;      // hand-redrawn variants of every outline, cycled like the film's boil
const BOIL_PX = 0.55; // how far a boiled vertex wanders (world px)

function hash(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function addPath(path, pts, closed, curv) {
  const n = pts.length;
  if (!(curv > 0 && n >= 3 && n <= 24)) {
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n; i++) path.lineTo(pts[i][0], pts[i][1]);
    if (closed) path.closePath();
    return;
  }
  // the film's bezier: Catmull-Rom tangents scaled by curv (bake.rs shape_path)
  const k = curv / 3, tan = [];
  for (let i = 0; i < n; i++) {
    const a = closed ? pts[(i + n - 1) % n] : pts[Math.max(0, i - 1)], b = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
    const end = !closed && (i === 0 || i === n - 1) ? 0.5 : 1;
    tan.push([(b[0] - a[0]) * k * end, (b[1] - a[1]) * k]);
  }
  path.moveTo(pts[0][0], pts[0][1]);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n, a = pts[i], b = pts[j];
    path.bezierCurveTo(a[0] + tan[i][0], a[1] + tan[i][1], b[0] - tan[j][0], b[1] - tan[j][1], b[0], b[1]);
  }
  if (closed) path.closePath();
}

const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// The boil moves a vertex by noise of its place on the croc at rest, so two parts that share an edge boil together.
const boilAt = (x, y, b) => {
  const h = Math.round(x * 2) * 12.9898 + Math.round(y * 2) * 78.233 + b * 37.719;
  return [(hash(h) - 0.5) * 2 * BOIL_PX, (hash(h + 5.1) - 0.5) * 2 * BOIL_PX];
};

function skinOf(doc) {
  const sk = new Map();
  for (const ch of doc.chains || []) ch.forEach((i, c) => sk.set(i, { prev: c > 0 ? ch[c - 1] : -1, next: c + 1 < ch.length ? ch[c + 1] : -1 }));
  return sk;
}
function skinWeights(doc, i, link, pts) {
  const A = j => doc.parts[j].anchor, a = A(i);
  const pa = link.prev >= 0 ? A(link.prev) : null, na = link.next >= 0 ? A(link.next) : null;
  const from = pa || a, to = na || a;
  let dx = to[0] - from[0], dy = to[1] - from[1];
  const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
  const lp = pa ? Math.hypot(a[0] - pa[0], a[1] - pa[1]) : 1, ln = na ? Math.hypot(na[0] - a[0], na[1] - a[1]) : 1;
  const w = new Float32Array(pts.length * 2);
  pts.forEach(([x, y], v) => {
    const t = x * dx + y * dy;
    if (t < 0 && pa) w[v * 2] = Math.min(1, -t / lp) * 0.5;
    if (t > 0 && na) w[v * 2 + 1] = Math.min(1, t / ln) * 0.5;
  });
  return w;
}

export function prepare(doc) {
  const draws = [], skin = skinOf(doc);
  doc.parts.forEach((part, i) => {
    const [ax, ay] = part.anchor;
    for (const d of part.draw) {
      const paths = [], boiled = [];
      for (let b = 0; b < BOILS; b++) {
        const path = new Path2D();
        const pts = b === 0 ? d.pts : d.pts.map(([x, y]) => { const o = boilAt(x + ax, y + ay, b); return [x + o[0], y + o[1]]; });
        addPath(path, pts, d.closed, d.curv);
        paths.push(path);
        boiled.push(pts);
      }
      const link = skin.get(i);
      const sk = link && { ...link, w: skinWeights(doc, i, link, d.pts), pts: boiled, closed: d.closed, curv: d.curv };
      let wash = d.wash && css(d.wash, d.wash[3]), fill = d.fill && css(d.fill, d.fill[3] * (d.wash ? 0.55 : 1));
      if (d.wash && d.fill && d.wash[3] >= 1) {
        const a = d.fill[3] * 0.55, m = k => Math.round(d.wash[k] + (d.fill[k] - d.wash[k]) * a);
        wash = css([m(0), m(1), m(2)]);
        fill = null;
      }
      draws.push({ part: i, z: d.z, paths, sk, len: d.len || 0, wash, fill, ink: d.ink && css(d.ink), width: d.ink ? d.ink[3] : 0 });
    }
  });
  draws.sort((a, b) => a.z - b.z);
  return { doc, draws, n: doc.parts.length, bbox: doc.bbox, edges: doc.edges, seed: doc.seed };
}

function skinned(d, P, R, b, i, s, rot) {
  const sk = d.sk, A = j => R.doc.parts[j].anchor;
  const off = j => {
    if (j < 0 || P[j * 6 + 4] < 0.1) return null;
    const aj = A(j), ai = A(i);
    return [(P[j * 6] - aj[0]) - (P[i * 6] - ai[0]), (P[j * 6 + 1] - aj[1]) - (P[i * 6 + 1] - ai[1])];
  };
  const dp = off(sk.prev), dn = off(sk.next);
  const big = v => v && Math.abs(v[0]) + Math.abs(v[1]) > 0.4;
  if (!big(dp) && !big(dn)) return d.paths[b];
  const c = Math.cos(-rot) / s, sn = Math.sin(-rot) / s;
  const loc = v => v ? [v[0] * c - v[1] * sn, v[0] * sn + v[1] * c] : [0, 0];
  const lp = loc(dp), ln = loc(dn), w = sk.w;
  const pts = sk.pts[b].map(([x, y], v) => [x + lp[0] * w[v * 2] + ln[0] * w[v * 2 + 1], y + lp[1] * w[v * 2] + ln[1] * w[v * 2 + 1]]);
  const path = new Path2D();
  addPath(path, pts, sk.closed, sk.curv);
  return path;
}

// view: { k, ox, oy, dpr, boil, sx, sy }
export function draw(ctx, R, P, view) {
  const { k, ox, oy, dpr = 1, boil = 0, sx = 1, sy = 1 } = view;
  const b = ((boil % BOILS) + BOILS) % BOILS;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const d of R.draws) {
    const o = d.part * 6, a = P[o + 4];
    if (a < 0.01) continue;
    const s = P[o + 2];
    if (s < 0.01) continue;
    const c = Math.cos(P[o + 3]) * s * k * dpr, sn = Math.sin(P[o + 3]) * s * k * dpr;
    ctx.setTransform(c * sx, sn * sx, -sn * sy, c * sy, (ox + P[o] * k) * dpr, (oy + P[o + 1] * k) * dpr);
    ctx.globalAlpha = Math.min(1, a);
    const path = d.sk ? skinned(d, P, R, b, d.part, s, P[o + 3]) : d.paths[b];
    if (d.wash) { ctx.fillStyle = d.wash; ctx.fill(path); }
    if (d.fill) { ctx.fillStyle = d.fill; ctx.fill(path); }
    if (d.ink) {
      const drawn = P[o + 5];
      if (drawn < 0.01) continue;
      ctx.strokeStyle = d.ink;
      ctx.lineWidth = d.width;
      if (drawn < 0.995 && d.len > 0) ctx.setLineDash([d.len * drawn, d.len + 1]);
      ctx.stroke(path);
      if (drawn < 0.995 && d.len > 0) ctx.setLineDash([]);
    }
  }
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
