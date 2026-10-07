// river-crocs.js: which pigment is which croc, and which way each one faces.
//
// Every frame the live pigment (alpha > 0.1, the rule's own alive threshold) is split into connected pieces. Pieces
// keep their identity across frames by overlap: a piece that splits gives its facing to both halves, two that merge
// keep the bigger one's. The facing field the rule reads is each piece's facing spread 6 cells around it.
// A piece turns when the water under it keeps flowing the other way: its state is mirrored about its own centroid
// (an exact permutation of cells, so no pigment is made or lost) halfway through a short horizontal squash.

const ALIVE = 0.1, BODY = 0.35;

export class Crocs {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.label = new Int32Array(W * H); this.prev = new Int32Array(W * H);
    this.pieces = []; this.nextId = 1; this.byTag = new Map();
    this.queue = new Int32Array(W * H); this.dist = new Uint8Array(W * H);
    this.turns = [];                 // active turns: { id, t, dur, flipped }
    this.autoTurn = true; this.turnThr = 0.035; this.turnHold = 8; this.turnCool = 30; this.turnDur = 9;
    this.frame = 0;
    this.pending = [];               // seeds waiting to be seen: { x, y, face }
  }
  reset() { this.prev.fill(0); this.label.fill(0); this.pieces = []; this.turns = []; this.pending = []; this.byTag = new Map(); }
  seedFacing(x, y, face) { this.pending.push({ x, y, face }); }

  // alpha(i): live alpha at cell i; flow: Float32Array (W*H*2) the frame's current; returns the pieces
  update(alpha, flow, facingData) {
    const { W, H, label, queue } = this;
    this.frame++;
    label.fill(0);
    const pieces = [];
    for (let i = 0; i < W * H; i++) {
      if (label[i] || alpha(i) <= ALIVE) continue;
      const tag = pieces.length + 1;
      let qh = 0, qt = 0; queue[qt++] = i; label[i] = tag;
      const pc = { tag, cells: 0, mass: 0, body: 0, sx: 0, sy: 0, x0: W, x1: -1, y0: H, y1: -1, vx: 0, vy: 0, seam: false };
      while (qh < qt) {
        const j = queue[qh++], x = j % W, y = (j / W) | 0, a = alpha(j);
        pc.cells++; pc.mass += a; if (a > BODY) pc.body++;
        pc.sx += a * (x + 0.5); pc.sy += a * (y + 0.5);
        pc.vx += a * flow[j * 2]; pc.vy += a * flow[j * 2 + 1];
        if (x < pc.x0) pc.x0 = x; if (x > pc.x1) pc.x1 = x; if (y < pc.y0) pc.y0 = y; if (y > pc.y1) pc.y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          let xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= W || yy < 0 || yy >= H) { pc.seam = true; xx = (xx + W) % W; yy = (yy + H) % H; }
          const k = yy * W + xx;
          if (!label[k] && alpha(k) > ALIVE) { label[k] = tag; queue[qt++] = k; }
        }
      }
      pc.cx = pc.sx / pc.mass; pc.cy = pc.sy / pc.mass; pc.vx /= pc.mass; pc.vy /= pc.mass;
      pieces.push(pc);
    }
    // identity by overlap with last frame's labels
    const prevPieces = this.byTag;
    const votes = pieces.map(() => new Map());
    for (let i = 0; i < W * H; i++) { const a = label[i], b = this.prev[i]; if (a && b) { const v = votes[a - 1]; v.set(b, (v.get(b) || 0) + 1); } }
    const claimed = new Set();
    const order = pieces.map((p, i) => i).sort((a, b) => pieces[b].mass - pieces[a].mass);
    for (const i of order) {
      const p = pieces[i];
      let best = 0, bv = 0;
      for (const [b, v] of votes[i]) { const pp = prevPieces.get(b); const w = v * (pp ? 1 + pp.mass * 1e-4 : 1); if (w > bv) { bv = w; best = b; } }
      const old = best ? prevPieces.get(best) : null;
      if (old && !claimed.has(old.id)) { p.id = old.id; claimed.add(old.id); p.facing = old.facing; p.against = old.against; p.lastTurn = old.lastTurn; p.born = old.born; }
      else if (old) { p.id = this.nextId++; p.facing = old.facing; p.against = 0; p.lastTurn = old.lastTurn; p.born = this.frame; p.parent = old.id; }
      else {
        p.id = this.nextId++; p.against = 0; p.lastTurn = -1e9; p.born = this.frame;
        // a planted seed may say which way its croc will face
        const k = this.pending.findIndex(s => label[Math.floor(s.y) * W + Math.floor(s.x)] === p.tag);
        p.facing = k >= 0 ? this.pending.splice(k, 1)[0].face : 1;
      }
    }
    this.byTag = new Map(pieces.map(p => [p.tag, p]));
    this.prev.set(label);
    this.pieces = pieces;
    this.fillFacing(facingData);
    return pieces;
  }

  // each piece's facing, spread 6 cells around it (nearest piece wins); elsewhere +1
  fillFacing(out) {
    const { W, H, label, queue, dist } = this;
    // seeds not yet seen keep their facing around them
    out.fill(1); dist.fill(255);
    let qh = 0, qt = 0;
    for (let i = 0; i < W * H; i++) if (label[i]) { out[i] = this.byTag.get(label[i]).facing; dist[i] = 0; queue[qt++] = i; }
    for (const s of this.pending) { const i = Math.floor(s.y) * W + Math.floor(s.x); if (!label[i]) { out[i] = s.face; dist[i] = 0; queue[qt++] = i; } }
    while (qh < qt) {
      const j = queue[qh++], d = dist[j];
      if (d >= 6) continue;
      const x = j % W, y = (j / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = ((y + dy + H) % H) * W + ((x + dx + W) % W);
        if (dist[k] > d + 1) { dist[k] = d + 1; out[k] = out[j]; queue[qt++] = k; }
      }
    }
  }

  // decide and advance turns; sim.turn mirrors the state; returns the active warps for drawing
  stepTurns(sim, facingData) {
    this.flips = [];                 // mirrors done this frame: { x0, y0, x1, y1 (grid coords), M (cell c -> M - c) }
    if (this.autoTurn) for (const p of this.pieces) {
      if (p.mass < 40 || p.seam || this.turns.some(t => t.id === p.id)) continue;
      const against = p.vx * p.facing < -this.turnThr;
      p.against = against ? (p.against || 0) + 1 : 0;
      if (p.against >= this.turnHold && this.frame - p.lastTurn > this.turnCool) this.startTurn(p);
    }
    const warps = [];
    for (const t of this.turns) {
      t.t++;
      const p = this.pieces.find(q => q.id === t.id);
      const u = t.t / t.dur;
      if (!t.flipped && u >= 0.5) {
        t.flipped = true;
        if (p && !p.seam) {
          const xc = Math.round(p.cx - 0.5), hw = Math.max(xc - p.x0, p.x1 - xc) + 3;
          const x0 = xc - hw, x1 = xc + hw, y0 = Math.max(0, p.y0 - 3), y1 = Math.min(this.H - 1, p.y1 + 3);
          if (x0 >= 0 && x1 < this.W) {
            sim.turn(x0, y0, x1, y1);
            this.flips.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, M: x0 + x1 });
            p.facing = -p.facing; p.lastTurn = this.frame;
            // the cells around it read the new facing straight away
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) facingData[y * this.W + x] = p.facing;
            sim.uploadFacing();
          }
        }
      }
      const sx = Math.max(0.06, Math.abs(Math.cos(Math.PI * Math.min(1, u))));
      if (p) {
        const hw = Math.max(p.cx - p.x0, p.x1 + 1 - p.cx) + 4;
        warps.push({ rect: [p.cx - hw, p.y0 - 4, p.cx + hw, p.y1 + 5], cx: p.cx, sx });
      }
    }
    this.turns = this.turns.filter(t => t.t < t.dur);
    return warps;
  }
  startTurn(p) { this.turns.push({ id: p.id, t: 0, dur: this.turnDur, flipped: false }); p.against = 0; p.lastTurn = this.frame; }
  // turn every piece (or the ones given) to face dir
  face(dir, ids = null) { for (const p of this.pieces) if ((!ids || ids.includes(p.id)) && p.facing !== dir && p.mass >= 10 && !this.turns.some(t => t.id === p.id)) this.startTurn(p); }

  // crocs worth counting: pieces with a real body
  count(minBody = 150) { return this.pieces.filter(p => p.body >= minBody).length; }
}
