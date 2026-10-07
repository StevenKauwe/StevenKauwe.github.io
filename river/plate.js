// plate.js: painted backgrounds, drawn once on a 2D canvas and handed to the wash pass as its base layer.
//   paperPlate: plain paper (the toy)
//   riverPlate: a side-on river (the film): sky, a far bank, the water, a sandy bed with pebbles, reeds rising from
//   the bed and breaking the surface, lily pads on the surface. Pale, so the croc's paint reads over it.

import { prng } from './river-sim.js';

export function paperPlate(w, h, paper) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = paper; g.fillRect(0, 0, w, h);
  return c;
}

// surface and bed: y positions in px of a w x h frame
export function riverPlate(w, h, { surface, bed, seed = 3 } = {}) {
  const R = prng(seed), c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), s = w / 1920;
  const INK = 'rgba(42,42,38,', wob = (x, a, f, ph) => a * Math.sin(x * f + ph) + a * 0.5 * Math.sin(x * f * 2.3 + ph * 1.7);
  g.fillStyle = '#f3ebdc'; g.fillRect(0, 0, w, h);
  // sky: a pale warm wash, bluer at the top, with a few soft blooms
  let gr = g.createLinearGradient(0, 0, 0, surface);
  gr.addColorStop(0, '#dfe6e6'); gr.addColorStop(1, '#f1e9d8');
  g.fillStyle = gr; g.fillRect(0, 0, w, surface);
  for (let i = 0; i < 7; i++) {
    const x = R() * w, y = R() * surface * 0.6, r = (120 + R() * 200) * s;
    const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, 'rgba(250,246,238,0.55)'); rg.addColorStop(1, 'rgba(250,246,238,0)');
    g.fillStyle = rg; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  // far bank: a soft olive band with rounded tree blobs, its lower edge at the surface
  g.fillStyle = 'rgba(150,163,118,0.55)';
  g.beginPath(); g.moveTo(0, surface);
  for (let x = 0; x <= w; x += 20 * s) g.lineTo(x, surface - 26 * s - wob(x, 6 * s, 0.006 / s, 1.3));
  g.lineTo(w, surface); g.closePath(); g.fill();
  for (let i = 0; i < 22; i++) {
    const x = R() * w, r = (22 + R() * 38) * s, y = surface - 22 * s - r * 0.6;
    g.fillStyle = `rgba(${120 + R() * 30 | 0},${140 + R() * 25 | 0},${100 + R() * 20 | 0},0.45)`;
    g.beginPath(); g.ellipse(x, y, r * 1.2, r, 0, 0, 7); g.fill();
  }
  // the water: pale aqua, a little deeper with depth, laid in soft horizontal bands
  gr = g.createLinearGradient(0, surface, 0, bed);
  gr.addColorStop(0, '#e6eee9'); gr.addColorStop(0.5, '#dce8e4'); gr.addColorStop(1, '#d2e0dc');
  g.fillStyle = gr; g.fillRect(0, surface, w, bed - surface + 40 * s);
  for (let i = 0; i < 26; i++) {
    const y = surface + R() * (bed - surface), x = R() * w, rw = (200 + R() * 500) * s, rh = (10 + R() * 26) * s;
    g.fillStyle = R() < 0.5 ? 'rgba(196,216,212,0.35)' : 'rgba(240,244,238,0.4)';
    g.beginPath(); g.ellipse(x, y, rw, rh, 0, 0, 7); g.fill();
  }
  // glints near the surface, fewer and fainter with depth
  g.lineCap = 'round';
  for (let i = 0; i < 46; i++) {
    const d = Math.pow(R(), 1.8), y = surface + 14 * s + d * (bed - surface) * 0.8, x = R() * w, l = (30 + R() * 110) * s * (1 - d * 0.5);
    g.strokeStyle = `rgba(250,252,248,${(0.75 - d * 0.55).toFixed(2)})`; g.lineWidth = (1.2 + 1.6 * (1 - d)) * s;
    g.beginPath(); g.moveTo(x - l, y); g.lineTo(x + l, y); g.stroke();
  }
  // the surface line
  g.strokeStyle = 'rgba(120,150,150,0.8)'; g.lineWidth = 2.2 * s;
  g.beginPath(); for (let x = 0; x <= w; x += 8 * s) { const y = surface + wob(x, 1.2 * s, 0.02 / s, 0.4); x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
  // the bed: sand with a wavy lip, pebbles
  const lip = x => bed + wob(x, 10 * s, 0.004 / s, 2.1);
  g.fillStyle = '#ddcba6';
  g.beginPath(); g.moveTo(0, h); for (let x = 0; x <= w; x += 12 * s) g.lineTo(x, lip(x)); g.lineTo(w, h); g.closePath(); g.fill();
  gr = g.createLinearGradient(0, bed, 0, h); gr.addColorStop(0, 'rgba(160,130,90,0)'); gr.addColorStop(1, 'rgba(160,130,90,0.35)');
  g.fillStyle = gr; g.fillRect(0, bed - 20 * s, w, h - bed + 20 * s);
  g.strokeStyle = INK + '0.55)'; g.lineWidth = 2.4 * s;
  g.beginPath(); for (let x = 0; x <= w; x += 12 * s) { x ? g.lineTo(x, lip(x)) : g.moveTo(x, lip(x)); } g.stroke();
  for (let i = 0; i < 70; i++) {
    const x = R() * w, y = lip(x) + 14 * s + R() * (h - bed) * 0.9, rx = (8 + R() * 22) * s, ry = rx * (0.55 + R() * 0.2);
    g.fillStyle = `rgba(${150 + R() * 40 | 0},${130 + R() * 30 | 0},${100 + R() * 30 | 0},0.75)`;
    g.beginPath(); g.ellipse(x, y, rx, ry, (R() - 0.5) * 0.5, 0, 7); g.fill();
    if (R() < 0.6) { g.strokeStyle = INK + '0.45)'; g.lineWidth = 1.3 * s; g.stroke(); }
  }
  // reeds: clumps at both ends of the frame, rising from the bed; some break the surface and end in a cattail
  const reed = (x0, hh, lean, col) => {
    const y0 = lip(x0) + 10 * s, tip = [x0 + lean, y0 - hh], mid = [x0 + lean * 0.35, y0 - hh * 0.55], wd = (11 + R() * 7) * s;
    g.fillStyle = col; g.strokeStyle = INK + '0.55)'; g.lineWidth = 1.4 * s;
    g.beginPath(); g.moveTo(x0 - wd / 2, y0);
    g.quadraticCurveTo(mid[0] - wd * 0.4, mid[1], tip[0], tip[1]);
    g.quadraticCurveTo(mid[0] + wd * 0.4, mid[1], x0 + wd / 2, y0);
    g.closePath(); g.fill(); g.stroke();
    if (tip[1] < surface - 10 * s && R() < 0.5) {
      const cx = x0 + lean * 0.86, cy = y0 - hh * 0.86;
      g.fillStyle = '#8a5e3e'; g.beginPath(); g.ellipse(cx, cy, 9 * s, 30 * s, Math.atan2(lean, hh), 0, 7); g.fill(); g.stroke();
    }
  };
  const clump = (xa, xb, n) => {
    for (let i = 0; i < n; i++) {
      const x = xa + (xb - xa) * (i + R() * 0.8) / n;
      const hh = (bed - surface) * (0.55 + R() * 0.65), lean = (R() - 0.5) * 120 * s;
      reed(x, hh, lean, R() < 0.33 ? 'rgba(92,128,74,0.85)' : 'rgba(128,160,96,0.8)');
    }
  };
  clump(-30 * s, 230 * s, 11);
  clump(1700 * s, 1950 * s, 10);
  // lily pads on the surface (side-on: flat ellipses), one with a flower
  const lily = (x, r, flower) => {
    g.fillStyle = 'rgba(104,150,84,0.9)'; g.strokeStyle = INK + '0.6)'; g.lineWidth = 1.6 * s;
    g.beginPath(); g.ellipse(x, surface + 2 * s, r, r * 0.22, 0, 0.15, Math.PI * 2 - 0.15); g.lineTo(x, surface + 2 * s); g.closePath(); g.fill(); g.stroke();
    if (flower) {
      for (let k = 0; k < 5; k++) {
        const a = -Math.PI / 2 + (k - 2) * 0.42; g.fillStyle = '#f3c9cf';
        g.beginPath(); g.ellipse(x + Math.cos(a) * 9 * s, surface - 8 * s + Math.sin(a) * 9 * s, 6 * s, 13 * s, a + Math.PI / 2, 0, 7); g.fill(); g.stroke();
      }
    }
  };
  lily(420 * s, 60 * s, false); lily(520 * s, 38 * s, true); lily(1240 * s, 54 * s, false); lily(1520 * s, 44 * s, false);
  return c;
}
