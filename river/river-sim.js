// river-sim.js: the pigment croc and its water, all on the GPU (WebGL2).
//
// State per cell: 20 channels as 5 RGBA32F textures (0: premultiplied RGBA pigment, 1: eye, far eye, blush, mouth,
// 2-4: hidden), triple-buffered. Plus the water: pigment dissolved in it (premultiplied RGBA, alpha = the rule's 21st
// input). One step is the training step (train/pignca.py PigNCA.step) with currents in front of it:
//
//   advect the croc (Catmull-Rom, then the pigment total renormalised exactly)
//   advect the water (push form: every cell's water is carried forward and split over 4 cells, so none is made or
//     lost), drawn a little toward where the croc grew last step (the paint visibly streams in)
//   A = G * water                                    (G: the Gaussian pay kernel, sigma 5.5)
//   update: perceive (identity / Sobel / Laplacian of 20 channels + water), MLP, fire mask, growth capped by A
//   mask: alive before and after, walls, the erode field; paid = growth, lost = shrinkage (with its colour)
//   water <- water - water * (G * (paid / A)) + lost, then a conservative 5-point spread
//
// Croc + water pigment is conserved to float precision: the renormalisation is exact, push advection is exact, the
// payment removes exactly what was paid (G is normalised and symmetric) and losses are banked where they happen.
//
// Facing: the rule is mirror-equivariant up to one sign. Mirroring x negates every Sobel-x feature and nothing
// else (identity, Sobel-y and Laplacian are symmetric in x, and every channel is a scalar), so a cell with facing
// -1 runs the left-facing croc by negating its Sobel-x inputs. The page keeps one facing per croc.

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform ivec2 size;
ivec2 wrap(ivec2 q) { return (q % size + size) % size; }
`;
const S5 = `uniform sampler2D s0, s1, s2, s3, s4;\n`;
const O5 = `layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3; layout(location = 4) out vec4 o4;\n`;

// Catmull-Rom semi-Lagrangian advection of all 20 channels
const ADVECT = HEAD + S5 + O5 + `
uniform sampler2D flow; uniform float mult;
vec4 cr(float t) { float t2 = t * t, t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2); }
#define CUBIC(S, OUT) { vec4 acc = vec4(0); \
  for (int j = 0; j < 4; j++) { vec4 row = vec4(0); \
    for (int i = 0; i < 4; i++) row += wx[i] * texelFetch(S, wrap(b + ivec2(i - 1, j - 1)), 0); \
    acc += wy[j] * row; } \
  OUT = acc; }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 src = vec2(c) - texelFetch(flow, c, 0).xy * mult;
  vec2 fl = floor(src), f = src - fl;
  ivec2 b = ivec2(fl);
  vec4 wx = cr(f.x), wy = cr(f.y);
  CUBIC(s0, o0) CUBIC(s1, o1) CUBIC(s2, o2) CUBIC(s3, o3) CUBIC(s4, o4)
}`;

// an exact roll by whole cells
const SHIFT = HEAD + S5 + O5 + `
uniform ivec2 d;
void main() { ivec2 c = wrap(ivec2(gl_FragCoord.xy) - d);
  o0 = texelFetch(s0, c, 0); o1 = texelFetch(s1, c, 0); o2 = texelFetch(s2, c, 0); o3 = texelFetch(s3, c, 0); o4 = texelFetch(s4, c, 0); }`;

// sum of max(0, channel ch) over 16x16 blocks, then over the block texture into one texel
const SUM1 = HEAD + `
uniform sampler2D src; uniform int ch; out vec4 o;
void main() { ivec2 b = ivec2(gl_FragCoord.xy) * 16; float s = 0.0;
  for (int j = 0; j < 16; j++) for (int i = 0; i < 16; i++) { ivec2 q = b + ivec2(i, j);
    if (q.x < size.x && q.y < size.y) s += max(0.0, texelFetch(src, q, 0)[ch]); }
  o = vec4(s, 0, 0, 1); }`;
const SUM2 = HEAD + `
uniform sampler2D src; uniform ivec2 n; out vec4 o;
void main() { float s = 0.0;
  for (int j = 0; j < 64; j++) { if (j >= n.y) break; for (int i = 0; i < 64; i++) { if (i >= n.x) break; s += texelFetch(src, ivec2(i, j), 0).r; } }
  o = vec4(s, 0, 0, 1); }`;

// separable Gaussian (the pay kernel), x then y; mode 1 divides src.r by (src2.r + 1e-6) first
const CONV = HEAD + `
uniform sampler2D src, src2; uniform int ch, mode; uniform ivec2 dir; uniform float g[31]; out vec4 o;
float val(ivec2 q) { vec4 v = texelFetch(src, q, 0);
  return mode == 1 ? v.r / (texelFetch(src2, q, 0).r + 1e-6) : v[ch]; }
void main() { ivec2 c = ivec2(gl_FragCoord.xy); float s = 0.0;
  for (int k = 0; k < 31; k++) s += g[k] * val(wrap(c + dir * (k - 15)));
  o = vec4(s, 0, 0, 1); }`;

// the rule's weights live in uniform buffers (constant memory): 4 blocks of 32 hidden units x 25 vec4 (fc1, packed
// per unit: 24 perception groups + bias) and one of 128 x 5 vec4 (fc2); each block is under WebGL2's 16 KB minimum
const UPDATE = HEAD + S5 + O5 + `
layout(std140) uniform W1a { vec4 w1a[800]; }; layout(std140) uniform W1b { vec4 w1b[800]; };
layout(std140) uniform W1c { vec4 w1c[800]; }; layout(std140) uniform W1d { vec4 w1d[800]; };
layout(std140) uniform W2 { vec4 w2[640]; };
uniform sampler2D dis, avail, facing, kpre, kpost;
uniform float seed, fire, gate, renorm;
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031 + seed); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
#define PERC(T, S) { \
  vec4 n0 = texelFetch(S, wrap(c + ivec2(-1, -1)), 0), n1 = texelFetch(S, wrap(c + ivec2(0, -1)), 0), n2 = texelFetch(S, wrap(c + ivec2(1, -1)), 0); \
  vec4 n3 = texelFetch(S, wrap(c + ivec2(-1, 0)), 0), n4 = texelFetch(S, c, 0), n5 = texelFetch(S, wrap(c + ivec2(1, 0)), 0); \
  vec4 n6 = texelFetch(S, wrap(c + ivec2(-1, 1)), 0), n7 = texelFetch(S, wrap(c + ivec2(0, 1)), 0), n8 = texelFetch(S, wrap(c + ivec2(1, 1)), 0); \
  P[T * 4 + 0] = n4; \
  P[T * 4 + 1] = fx * (-n0 + n2 - 2.0 * n3 + 2.0 * n5 - n6 + n8) / 8.0; \
  P[T * 4 + 2] = (-n0 - 2.0 * n1 - n2 + n6 + 2.0 * n7 + n8) / 8.0; \
  P[T * 4 + 3] = (n0 + 2.0 * n1 + n2 + 2.0 * n3 - 12.0 * n4 + 2.0 * n5 + n6 + 2.0 * n7 + n8) / 16.0; \
  if (T == 0) pre = max(max(max(n0.a, n1.a), max(n2.a, n3.a)), max(max(n4.a, n5.a), max(max(n6.a, n7.a), n8.a))); }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float fx = texelFetch(facing, c, 0).r < 0.0 ? -1.0 : 1.0;
  // the pigment total after advection, put back to what it was before (exact; 1 when nothing moved)
  float k = renorm > 0.5 ? texelFetch(kpre, ivec2(0), 0).r / max(texelFetch(kpost, ivec2(0), 0).r, 1e-6) : 1.0;
  vec4 P[24]; float pre = 0.0;
  PERC(0, s0) PERC(1, s1) PERC(2, s2) PERC(3, s3) PERC(4, s4)
  for (int q = 0; q < 4; q++) P[q] *= k;
  pre *= k;
  { float pre0 = pre; PERC(5, dis) pre = pre0;
    for (int q = 0; q < 4; q++) P[20 + q] = vec4(P[20 + q].a, 0.0, 0.0, 0.0); }
  vec4 d0 = vec4(0), d1 = vec4(0), d2 = vec4(0), d3 = vec4(0), d4 = vec4(0);
#define HID(B, H0) for (int j = 0; j < 32; j++) { int o = j * 25; float a = B[o + 24].x; \
    ${Array.from({ length: 24 }, (_, q) => `a += dot(B[o + ${q}], P[${q}]);`).join(' ')} \
    a = max(a, 0.0); int h = (H0 + j) * 5; \
    d0 += a * w2[h]; d1 += a * w2[h + 1]; d2 += a * w2[h + 2]; d3 += a * w2[h + 3]; d4 += a * w2[h + 4]; }
  HID(w1a, 0) HID(w1b, 32) HID(w1c, 64) HID(w1d, 96)
  float u = hash(vec2(c)) < fire ? 1.0 : 0.0;
  float live = pre > 0.1 ? 1.0 : 0.0;
  // growth this step may not exceed the water's pigment around the cell (Gaussian-weighted), as in training
  float g = max(max(P[0].a + u * d0.a, 0.0) - max(P[0].a, 0.0), 0.0);
  if (gate > 0.5 && g > 1e-6) u *= min(1.0, texelFetch(avail, c, 0).r / (g + 1e-6));
  o0 = (P[0] + u * d0) * live; o1 = (P[4] + u * d1) * live; o2 = (P[8] + u * d2) * live;
  o3 = (P[12] + u * d3) * live; o4 = (P[16] + u * d4) * live;
}`;

// alive after the update, walls and erosion; what grew (paid) and what was lost (and its colour)
const MASK = HEAD + S5 + O5 + `
uniform sampler2D a0tex, field, kpre, kpost; uniform float renorm;
layout(location = 5) out vec4 lostOut; layout(location = 6) out vec4 paidOut;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float m = 0.0;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) m = max(m, texelFetch(s0, wrap(c + ivec2(dx, dy)), 0).a);
  vec4 fl = texelFetch(field, c, 0);                     // r: wall (solid), g: erode (0..1 per step)
  float live = (m > 0.1 ? 1.0 : 0.0) * (1.0 - fl.r) * (1.0 - fl.g);
  o0 = texelFetch(s0, c, 0) * live; o1 = texelFetch(s1, c, 0) * live; o2 = texelFetch(s2, c, 0) * live;
  o3 = texelFetch(s3, c, 0) * live; o4 = texelFetch(s4, c, 0) * live;
  float k = renorm > 0.5 ? texelFetch(kpre, ivec2(0), 0).r / max(texelFetch(kpost, ivec2(0), 0).r, 1e-6) : 1.0;
  vec4 old = texelFetch(a0tex, c, 0) * k;
  float a0 = max(old.a, 0.0), a2 = max(o0.a, 0.0);
  float lost = max(a0 - a2, 0.0);
  vec3 hue = a0 > 1e-4 ? clamp(old.rgb / a0, 0.0, 1.0) : vec3(0.45, 0.72, 0.4);
  // a body whose colour channels have collapsed (a spare body melting) banks the croc's green, not black
  float sat = max(hue.r, max(hue.g, hue.b)) - min(hue.r, min(hue.g, hue.b));
  hue = mix(vec3(0.45, 0.72, 0.4), hue, smoothstep(0.12, 0.3, dot(hue, vec3(0.3, 0.55, 0.15))) * smoothstep(0.08, 0.2, sat));
  lostOut = vec4(hue * lost, lost);
  paidOut = vec4(max(a2 - a0, 0.0), 0, 0, 1);
}`;

// the water's velocity this step: the current plus a pull up the gradient of where growth is drawing pigment from
// (only while the crocs are growing on net, as in the spike: a settled croc, whose cells trade a little pigment
// back and forth every step, gets no pull, which would otherwise feed its front and make it glide and bud)
const WVEL = HEAD + `
uniform sampler2D flow, rm, field, gpaid, glost; uniform float mult, kp, cap, netK; out vec4 o;
void main() { ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 g = vec2(texelFetch(rm, wrap(c + ivec2(1, 0)), 0).r - texelFetch(rm, wrap(c - ivec2(1, 0)), 0).r,
                texelFetch(rm, wrap(c + ivec2(0, 1)), 0).r - texelFetch(rm, wrap(c - ivec2(0, 1)), 0).r) * 0.5;
  float net = texelFetch(gpaid, ivec2(0), 0).r - texelFetch(glost, ivec2(0), 0).r;
  vec2 pl = g * kp * clamp(net * netK, 0.0, 1.0); float pm = length(pl); if (pm > 0.6) pl *= 0.6 / pm;
  vec2 v = texelFetch(flow, c, 0).xy * mult + pl;
  float s = length(v); if (s > cap) v *= cap / s;
  if (texelFetch(field, c, 0).r > 0.5) v = vec2(0);
  o = vec4(v, 0, 1); }`;

// push advection, gathered: cell c collects every source within 3 cells whose carried position lands near it,
// with bilinear weights; each source's weights sum to 1 over its 4 landing cells, so the total is exact
const ADVECT_D = HEAD + `
uniform sampler2D dis, wvel; out vec4 o;
void main() { ivec2 c = ivec2(gl_FragCoord.xy); vec4 acc = vec4(0);
  for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
    ivec2 sq = c + ivec2(i, j), s = wrap(sq);
    vec4 d = texelFetch(dis, s, 0); if (d.a <= 0.0 && d.r <= 0.0) continue;
    vec2 t = vec2(sq) + texelFetch(wvel, s, 0).xy - vec2(c);
    float w = max(0.0, 1.0 - abs(t.x)) * max(0.0, 1.0 - abs(t.y));
    acc += d * w; }
  o = acc; }`;

// pay and bank, then spread a little (conservative 5-point)
const WATER = HEAD + `
uniform sampler2D dis, rm, lost; uniform float spread; out vec4 o;
vec4 E(ivec2 q) { q = wrap(q); return texelFetch(dis, q, 0) * (1.0 - texelFetch(rm, q, 0).r) + texelFetch(lost, q, 0); }
void main() { ivec2 c = ivec2(gl_FragCoord.xy);
  o = max(E(c) * (1.0 - 4.0 * spread) + spread * (E(c + ivec2(1, 0)) + E(c - ivec2(1, 0)) + E(c + ivec2(0, 1)) + E(c - ivec2(0, 1))), vec4(0)); }`;

// knife: zero the croc in a capsule around a-b; its pigment goes into the water (KNIFE_D runs first, on the old state)
const KNIFE = HEAD + S5 + O5 + `
uniform vec2 a, b; uniform float r;
float inside() { vec2 p = vec2(gl_FragCoord.xy), ab = b - a; float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - a - ab * t) < r ? 1.0 : 0.0; }
void main() { ivec2 c = ivec2(gl_FragCoord.xy); float k = 1.0 - inside();
  o0 = texelFetch(s0, c, 0) * k; o1 = texelFetch(s1, c, 0) * k; o2 = texelFetch(s2, c, 0) * k; o3 = texelFetch(s3, c, 0) * k; o4 = texelFetch(s4, c, 0) * k; }`;
const KNIFE_D = HEAD + `
uniform sampler2D s0, dis; uniform vec2 a, b; uniform float r; out vec4 o;
void main() { ivec2 c = ivec2(gl_FragCoord.xy); vec2 p = vec2(gl_FragCoord.xy), ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  vec4 s = texelFetch(s0, c, 0);
  o = texelFetch(dis, c, 0) + (length(p - a - ab * t) < r && s.a > 0.0 ? max(s, vec4(0)) : vec4(0)); }`;

// turn: mirror the state inside a rectangle about column M/2 (an exact permutation of cells)
const TURN = HEAD + S5 + O5 + `
uniform ivec4 rect; uniform int M;
void main() { ivec2 c = ivec2(gl_FragCoord.xy), q = c;
  if (c.x >= rect.x && c.x <= rect.z && c.y >= rect.y && c.y <= rect.w) q = ivec2(M - c.x, c.y);
  q = wrap(q);
  o0 = texelFetch(s0, q, 0); o1 = texelFetch(s1, q, 0); o2 = texelFetch(s2, q, 0); o3 = texelFetch(s3, q, 0); o4 = texelFetch(s4, q, 0); }`;

// feed: add pigment to the water (a soft disc of radius r, amount = total alpha added)
const FEED = HEAD + `
uniform sampler2D dis; uniform vec2 at; uniform float r, amt; uniform vec3 hue; out vec4 o;
void main() { ivec2 c = ivec2(gl_FragCoord.xy); vec2 d = vec2(c) + 0.5 - at;
  d = mod(d + vec2(size) * 0.5, vec2(size)) - vec2(size) * 0.5;
  float w = exp(-dot(d, d) / (2.0 * r * r)) / (6.2831853 * r * r);
  o = texelFetch(dis, c, 0) + vec4(hue, 1.0) * amt * w; }`;

// what the eye sees: the croc's pigment eased over frames after being carried by the water (no lag for motion the
// current explains, and the rule's stochastic shimmer is averaged away)
const DISP = HEAD + `
uniform sampler2D disp, s0, flow; uniform float mult, ease; out vec4 o;
vec4 cr(float t) { float t2 = t * t, t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2); }
void main() { ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 src = vec2(c) - texelFetch(flow, c, 0).xy * mult; vec2 fl = floor(src), f = src - fl; ivec2 b = ivec2(fl);
  vec4 wx = cr(f.x), wy = cr(f.y), acc = vec4(0);
  for (int j = 0; j < 4; j++) { vec4 row = vec4(0); for (int i = 0; i < 4; i++) row += wx[i] * texelFetch(disp, wrap(b + ivec2(i - 1, j - 1)), 0); acc += wy[j] * row; }
  o = mix(max(acc, vec4(0)), max(texelFetch(s0, c, 0), vec4(0)), ease); }`;

const PACK = HEAD + `
uniform sampler2D disp, s0, s1, dis;
layout(location = 0) out vec4 p1; layout(location = 1) out vec4 p2;
void main() { ivec2 c = ivec2(gl_FragCoord.xy); vec4 o = texelFetch(s1, c, 0);
  p1 = vec4(texelFetch(disp, c, 0).a, texelFetch(s0, c, 0).a, o.x, o.y);
  p2 = vec4(o.z, o.w, texelFetch(dis, c, 0).a, 0.0); }`;

function compile(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'p');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

// a small seeded PRNG (mulberry32): the fire mask's seeds come from it, so a run is reproducible
export function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const SIGMA = 5.5;
const G31 = (() => { const g = []; let s = 0; for (let k = -15; k <= 15; k++) { const v = Math.exp(-k * k / (2 * SIGMA * SIGMA)); g.push(v); s += v; } return new Float32Array(g.map(v => v / s)); })();

export class RiverSim {
  constructor(gl, weights, W, H, { seed = 1 } = {}) {
    this.gl = gl; this.W = W; this.H = H;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float is not available');
    if (gl.getParameter(gl.MAX_DRAW_BUFFERS) < 7 || gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) < 7) throw new Error('needs 7 draw buffers');
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const P = (fs) => compile(gl, VS, fs);
    this.prog = { advect: P(ADVECT), shift: P(SHIFT), sum1: P(SUM1), sum2: P(SUM2), conv: P(CONV), update: P(UPDATE), mask: P(MASK),
      wvel: P(WVEL), advectD: P(ADVECT_D), water: P(WATER), knife: P(KNIFE), knifeD: P(KNIFE_D), turn: P(TURN), feed: P(FEED),
      disp: P(DISP), pack: P(PACK) };
    const up = this.prog.update.p;
    ['W1a', 'W1b', 'W1c', 'W1d', 'W2'].forEach((n, i) => gl.uniformBlockBinding(up, gl.getUniformBlockIndex(up, n), i));
    const tex = (w, h, ifmt, fmt, data = null) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, gl.FLOAT, data);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t;
    };
    this.tex = tex;
    const fbo = (ts) => {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      ts.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
      gl.drawBuffers(ts.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete');
      return fb;
    };
    const rgba = () => tex(W, H, gl.RGBA32F, gl.RGBA), red = (w = W, h = H) => tex(w, h, gl.R32F, gl.RED);
    const single = (t) => ({ t, fb: fbo([t]) });
    this.lost = rgba(); this.paid = rgba();
    this.sets = [0, 1, 2].map(() => { const ts = [0, 1, 2, 3, 4].map(rgba); return { ts, fb: fbo(ts), fbm: fbo([...ts, this.lost, this.paid]) }; });
    this.cur = 0;
    this.dis = [single(rgba()), single(rgba())]; this.dc = 0;      // water, ping-pong
    this.disp = [single(rgba()), single(rgba())]; this.pc = 0;     // the displayed pigment, ping-pong
    this.A = single(red()); this.tmp = single(red()); this.rm = single(red()); this.wv = single(tex(W, H, gl.RG32F, gl.RG));
    this.bw = Math.ceil(W / 16); this.bh = Math.ceil(H / 16);
    this.blk = single(red(this.bw, this.bh));
    this.sums = [0, 1, 2, 3].map(() => single(red(1, 1)));       // pigment before / after advection; last step's paid / lost
    this.packT = [rgba(), rgba()]; this.packFb = fbo(this.packT);
    this.flowData = new Float32Array(W * H * 2);
    this.flowTex = tex(W, H, gl.RG32F, gl.RG, this.flowData);
    this.fieldData = new Float32Array(W * H * 4);                 // r: wall (solid), g: erode, b: a stone to draw
    this.fieldTex = tex(W, H, gl.RGBA32F, gl.RGBA, this.fieldData);
    this.facingData = new Float32Array(W * H).fill(1);
    this.facingTex = tex(W, H, gl.R32F, gl.RED, this.facingData);
    this.read1 = new Float32Array(W * H * 4); this.read2 = new Float32Array(W * H * 4);
    this.setWeights(weights);
    this.rand = prng(seed);
    this.flowMax = 0; this.steps = 0;
    this.pullGain = 260; this.pullNet = 0.15; this.spread = 0.05; this.waterCap = 2.0; this.gateOn = true;
  }

  reseed(seed) { this.rand = prng(seed); }

  // the rule's weights as two float textures (fc1 packed per hidden unit, fc2 per output group)
  setWeights(weights) {
    const gl = this.gl;
    const { C, HID, fc1_w, fc1_b, fc2_w } = weights, CS = weights.CS || C;
    if (HID !== 128) throw new Error('the shader is built for 128 hidden units');
    const w1 = new Float32Array(25 * HID * 4), w2 = new Float32Array(5 * HID * 4);
    for (let h = 0; h < HID; h++) {
      for (let t = 0; t < 6; t++) for (let k = 0; k < 4; k++) for (let m = 0; m < 4; m++) {
        const c = 4 * t + m;
        if (c < CS) w1[(h * 25 + t * 4 + k) * 4 + (t < 5 ? m : 0)] = fc1_w[h * CS * 4 + c * 4 + k];
      }
      w1[(h * 25 + 24) * 4] = fc1_b[h];
      for (let t = 0; t < 5; t++) for (let m = 0; m < 4; m++) w2[(h * 5 + t) * 4 + m] = fc2_w[(4 * t + m) * HID + h];
    }
    // uniform buffers: fc1 in 4 blocks of 32 units (25 vec4 each), fc2 in one; bound to points 0-4
    if (!this.ubos) this.ubos = [0, 1, 2, 3, 4].map(() => gl.createBuffer());
    for (let b = 0; b < 4; b++) { gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubos[b]); gl.bufferData(gl.UNIFORM_BUFFER, w1.subarray(b * 32 * 25 * 4, (b + 1) * 32 * 25 * 4), gl.STATIC_DRAW); }
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubos[4]); gl.bufferData(gl.UNIFORM_BUFFER, w2, gl.STATIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    this.gated = CS > C;
    this.fire = weights.FIRE;
    this.weightsIt = weights.it;
  }

  // ---- plumbing ----
  run(name, fb, w, h, binds, set) {
    const gl = this.gl, P = this.prog[name];
    gl.useProgram(P.p);
    gl.bindVertexArray(this.vao);
    let unit = 0;
    for (const [n, t] of Object.entries(binds)) { if (!P.u[n]) continue; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(P.u[n], unit); unit++; }
    if (P.u.size) gl.uniform2i(P.u.size, this.W, this.H);
    if (set) set(gl, P.u);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w ?? this.W, h ?? this.H);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  sB(i) { const t = this.sets[i].ts; return { s0: t[0], s1: t[1], s2: t[2], s3: t[3], s4: t[4] }; }
  get D() { return this.dis[this.dc]; }
  get Dn() { return this.dis[1 - this.dc]; }
  sumInto(k, src, ch) {
    this.run('sum1', this.blk.fb, this.bw, this.bh, { src }, (gl, u) => gl.uniform1i(u.ch, ch));
    this.run('sum2', this.sums[k].fb, 1, 1, { src: this.blk.t }, (gl, u) => gl.uniform2i(u.n, this.bw, this.bh));
  }
  conv(out, src, ch, mode = 0, src2 = null) {
    const set = (dir, c, m) => (gl, u) => { gl.uniform1i(u.ch, c); gl.uniform1i(u.mode, m); gl.uniform2i(u.dir, ...dir); gl.uniform1fv(u.g, G31); };
    this.run('conv', this.tmp.fb, null, null, { src, src2: src2 || src }, set([1, 0], ch, mode));
    this.run('conv', out.fb, null, null, { src: this.tmp.t, src2: this.tmp.t }, set([0, 1], 0, 0));
  }

  // ---- inputs from the page ----
  uploadFlow() {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.flowTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.W, this.H, gl.RG, gl.FLOAT, this.flowData);
    let m = 0; for (let i = 0; i < this.flowData.length; i++) { const v = Math.abs(this.flowData[i]); if (v > m) m = v; }
    this.flowMax = m;
  }
  uploadField() { const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.fieldTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.W, this.H, gl.RGBA, gl.FLOAT, this.fieldData); }
  uploadFacing() { const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.facingTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.W, this.H, gl.RED, gl.FLOAT, this.facingData); }
  setWater(data) { const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.D.t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.W, this.H, gl.RGBA, gl.FLOAT, data); }

  clear() {
    const gl = this.gl;
    for (const s of this.sets) { gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbm); for (let i = 0; i < 7; i++) gl.clearBufferfv(gl.COLOR, i, [0, 0, 0, 0]); }
    for (const d of [...this.dis, ...this.disp, this.rm, this.A, ...this.sums]) { gl.bindFramebuffer(gl.FRAMEBUFFER, d.fb); gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]); }
    this.steps = 0;
  }

  // a seed: channels 3.. = 1 at one cell. Its unit of alpha is paid for from the water around it (taken in
  // proportion to the water there), so planting stays honest; returns what could not be paid.
  plant(x, y) {
    const gl = this.gl, { W, H } = this;
    x = ((Math.round(x) % W) + W) % W; y = ((Math.round(y) % H) + H) % H;
    const s = this.sets[this.cur];
    const one = new Float32Array([1, 1, 1, 1]);
    s.ts.forEach((t, i) => { gl.bindTexture(gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, 1, 1, gl.RGBA, gl.FLOAT, i === 0 ? new Float32Array([0, 0, 0, 1]) : one); });
    const R = 10, x0 = Math.max(0, x - R), y0 = Math.max(0, y - R), w = Math.min(W, x + R + 1) - x0, h = Math.min(H, y + R + 1) - y0;
    const d = new Float32Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.D.fb); gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.FLOAT, d);
    let S = 0; for (let i = 3; i < d.length; i += 4) S += d[i];
    const take = Math.min(1, S), f = S > 0 ? 1 - take / S : 1;
    for (let i = 0; i < d.length; i++) d[i] *= f;
    gl.bindTexture(gl.TEXTURE_2D, this.D.t); gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.FLOAT, d);
    return 1 - take;
  }

  // the full state (20 channels) of a rectangle, as 5 RGBA arrays; and writing one back (optionally mirrored in x),
  // so a grown croc can be stamped into a new scene without regrowing it
  getRegion(x0, y0, w, h) {
    const gl = this.gl, s = this.sets[this.cur];
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb);
    return [0, 1, 2, 3, 4].map(i => { const a = new Float32Array(w * h * 4); gl.readBuffer(gl.COLOR_ATTACHMENT0 + i); gl.readPixels(x0, y0, w, h, gl.RGBA, gl.FLOAT, a); return a; });
  }
  putRegion(x0, y0, w, h, data, mirror = false) {
    const gl = this.gl, s = this.sets[this.cur];
    data.forEach((a, i) => {
      let src = a;
      if (mirror) { src = new Float32Array(a.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src.set(a.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (y * w + (w - 1 - x)) * 4); }
      // rows that cross the torus seam are written in two pieces
      for (let y = 0; y < h; y++) {
        const yy = ((y0 + y) % this.H + this.H) % this.H, xs = ((x0 % this.W) + this.W) % this.W, n1 = Math.min(w, this.W - xs);
        gl.bindTexture(gl.TEXTURE_2D, s.ts[i]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, xs, yy, n1, 1, gl.RGBA, gl.FLOAT, src.subarray(y * w * 4, (y * w + n1) * 4));
        if (n1 < w) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, yy, w - n1, 1, gl.RGBA, gl.FLOAT, src.subarray((y * w + n1) * 4, (y + 1) * w * 4));
      }
    });
  }

  shift(dx, dy) {
    if (!dx && !dy) return;
    const n = (this.cur + 1) % 3;
    this.run('shift', this.sets[n].fb, null, null, this.sB(this.cur), (gl, u) => gl.uniform2i(u.d, dx, dy));
    this.cur = n;
  }

  knife(a, b, r = 1.3) {
    const n = (this.cur + 1) % 3, set = (gl, u) => { gl.uniform2f(u.a, a[0], a[1]); gl.uniform2f(u.b, b[0], b[1]); gl.uniform1f(u.r, r); };
    this.run('knifeD', this.Dn.fb, null, null, { s0: this.sets[this.cur].ts[0], dis: this.D.t }, set);
    this.dc = 1 - this.dc;
    this.run('knife', this.sets[n].fb, null, null, this.sB(this.cur), set);
    this.cur = n;
  }

  feed(x, y, r, amount, hue) {
    this.run('feed', this.Dn.fb, null, null, { dis: this.D.t }, (gl, u) => { gl.uniform2f(u.at, x, y); gl.uniform1f(u.r, r); gl.uniform1f(u.amt, amount); gl.uniform3f(u.hue, ...hue); });
    this.dc = 1 - this.dc;
  }

  // mirror the croc in columns x0..x1 (rows y0..y1) about (x0 + x1) / 2
  turn(x0, y0, x1, y1) {
    const n = (this.cur + 1) % 3;
    this.run('turn', this.sets[n].fb, null, null, this.sB(this.cur), (gl, u) => { gl.uniform4i(u.rect, x0, y0, x1, y1); gl.uniform1i(u.M, x0 + x1); });
    this.cur = n;
  }

  // ---- one sim step ----
  step() {
    const moving = this.flowMax > 1e-5;
    const X = this.cur, Y = moving ? (X + 1) % 3 : X, Z = moving ? (X + 2) % 3 : (X + 1) % 3, OUT = moving ? X : (X + 2) % 3;
    if (moving) {
      this.sumInto(0, this.sets[X].ts[0], 3);
      this.run('advect', this.sets[Y].fb, null, null, { ...this.sB(X), flow: this.flowTex }, (gl, u) => gl.uniform1f(u.mult, 1));
      this.sumInto(1, this.sets[Y].ts[0], 3);
    }
    // the water moves (current + pull toward last step's growth), exactly
    this.run('wvel', this.wv.fb, null, null, { flow: this.flowTex, rm: this.rm.t, field: this.fieldTex, gpaid: this.sums[2].t, glost: this.sums[3].t },
      (gl, u) => { gl.uniform1f(u.mult, 1); gl.uniform1f(u.kp, this.pullGain); gl.uniform1f(u.cap, this.waterCap); gl.uniform1f(u.netK, this.pullNet); });
    this.run('advectD', this.Dn.fb, null, null, { dis: this.D.t, wvel: this.wv.t });
    this.dc = 1 - this.dc;
    this.conv(this.A, this.D.t, 3);
    const ren = moving ? 1 : 0;
    for (let i = 0; i < 5; i++) this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, i, this.ubos[i]);
    this.run('update', this.sets[Z].fb, null, null, { ...this.sB(Y), dis: this.D.t, avail: this.A.t, facing: this.facingTex,
      kpre: this.sums[0].t, kpost: this.sums[1].t }, (gl, u) => {
      gl.uniform1f(u.seed, this.rand() * 1000); gl.uniform1f(u.fire, this.fire); gl.uniform1f(u.gate, this.gated && this.gateOn ? 1 : 0); gl.uniform1f(u.renorm, ren);
    });
    this.run('mask', this.sets[OUT].fbm, null, null, { ...this.sB(Z), a0tex: this.sets[Y].ts[0], field: this.fieldTex, kpre: this.sums[0].t, kpost: this.sums[1].t },
      (gl, u) => gl.uniform1f(u.renorm, ren));
    this.cur = OUT;
    // net growth this step drives next step's pull
    if (this.pullGain > 0) { this.sumInto(2, this.paid, 0); this.sumInto(3, this.lost, 3); }
    // pay for the growth from the water near it, bank the losses, spread
    this.conv(this.rm, this.paid, 0, 1, this.A.t);
    this.run('water', this.Dn.fb, null, null, { dis: this.D.t, rm: this.rm.t, lost: this.lost }, (gl, u) => gl.uniform1f(u.spread, this.spread));
    this.dc = 1 - this.dc;
    this.steps++;
  }

  // once per frame: ease the displayed pigment (advected by the current the frame applied), pack and read back
  frame(stepsThisFrame, ease = 0.5, snap = false) {
    const prev = this.disp[this.pc], next = this.disp[1 - this.pc];
    this.run('disp', next.fb, null, null, { disp: prev.t, s0: this.sets[this.cur].ts[0], flow: this.flowTex },
      (gl, u) => { gl.uniform1f(u.mult, stepsThisFrame); gl.uniform1f(u.ease, snap ? 1 : ease); });
    this.pc = 1 - this.pc;
    const s = this.sets[this.cur].ts;
    this.run('pack', this.packFb, null, null, { disp: this.disp[this.pc].t, s0: s[0], s1: s[1], dis: this.D.t });
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.packFb);
    gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.FLOAT, this.read1);
    gl.readBuffer(gl.COLOR_ATTACHMENT1); gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.FLOAT, this.read2);
  }

  // croc and water pigment totals (alpha units), from the last readback
  totals() {
    let c = 0, w = 0;
    for (let i = 0; i < this.read1.length; i += 4) { c += Math.max(0, this.read1[i + 1]); w += this.read2[i + 2]; }
    return { croc: c, water: w, total: c + w };
  }

  // exact totals straight from the GPU state (live croc and the water)
  exactTotals() {
    const gl = this.gl, { W, H } = this, a = new Float32Array(W * H * 4), d = new Float32Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sets[this.cur].fb); gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, a);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.D.fb); gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, d);
    let c = 0, w = 0; for (let i = 3; i < a.length; i += 4) { c += Math.max(0, a[i]); w += d[i]; }
    return { croc: c, water: w, total: c + w };
  }

  get dispTex() { return this.disp[this.pc].t; }
  get waterTex() { return this.D.t; }
}
