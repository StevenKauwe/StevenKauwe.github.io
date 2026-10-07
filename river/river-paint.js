// river-paint.js: what the croc and its water look like. One full-screen pass composes the plate (paper for the
// toy, a painted river for the film), the pigment dissolved in the water (a wet-in-wet wash that dries with a tide
// mark) and the croc's pigment (a cubic B-spline of the displayed field, cut crisply at the ink iso, pooled darker at
// the rim, granulated). The grid never shows: every field is sampled with a smooth kernel at screen resolution.

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const WASH = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D pig, dis, field, plate;
uniform ivec2 size;
uniform vec2 res, off; uniform float cell, iso, time, dark; uniform vec3 paperCol;
uniform vec4 warpR[4]; uniform vec2 warpC[4]; uniform int nWarp;
in vec2 uv; out vec4 o;
float h2(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
vec4 bs(float t) { float t2 = t * t, t3 = t2 * t;
  return vec4((1.0 - 3.0 * t + 3.0 * t2 - t3), (4.0 - 6.0 * t2 + 3.0 * t3), (1.0 + 3.0 * t + 3.0 * t2 - 3.0 * t3), t3) / 6.0; }
ivec2 wr(ivec2 q) { return (q % size + size) % size; }
vec4 bspl(sampler2D S, vec2 g) {
  g -= 0.5; vec2 fl = floor(g), f = g - fl; ivec2 b = ivec2(fl);
  vec4 wx = bs(f.x), wy = bs(f.y); vec4 s = vec4(0);
  for (int j = 0; j < 4; j++) { vec4 row = vec4(0);
    for (int i = 0; i < 4; i++) row += wx[i] * texelFetch(S, wr(b + ivec2(i - 1, j - 1)), 0);
    s += wy[j] * row; }
  return s;
}
float bilA(vec2 g) {
  g -= 0.5; vec2 fl = floor(g), f = g - fl; ivec2 b = ivec2(fl);
  return mix(mix(texelFetch(pig, wr(b), 0).a, texelFetch(pig, wr(b + ivec2(1, 0)), 0).a, f.x),
             mix(texelFetch(pig, wr(b + ivec2(0, 1)), 0).a, texelFetch(pig, wr(b + ivec2(1, 1)), 0).a, f.x), f.y);
}
// a croc mid-turn is squashed horizontally about its centre (a classic sprite turn)
vec2 warp(vec2 g, out float gone) {
  gone = 0.0;
  for (int i = 0; i < 4; i++) { if (i >= nWarp) break;
    vec4 r = warpR[i]; vec2 c = warpC[i];
    if (g.x >= r.x && g.x <= r.z && g.y >= r.y && g.y <= r.w) {
      float x = c.x + (g.x - c.x) / max(c.y, 0.02);
      if (x < r.x || x > r.z) gone = 1.0;
      g.x = x; } }
  return g;
}
void main() {
  vec2 px = vec2(uv.x, 1.0 - uv.y) * res;
  vec2 g = (px - off) / cell;
  vec3 base = texture(plate, uv).rgb;
  // paper: fibres and a faint tooth over the plate
  float fib = fbm(px * vec2(0.9, 0.12)) * 0.6 + fbm(px * 0.35) * 0.4;
  float tooth = vnoise(px * 0.7) * 0.5 + vnoise(px * 1.9) * 0.5;
  float grainF = 0.968 + 0.045 * fib + 0.025 * tooth;
  vec3 paper = base * grainF;
  float gran = vnoise(px * 0.45) * 0.55 + vnoise(px * 0.13 + 3.1) * 0.45;
  float bloom = fbm(g * 0.18 + vec2(time * 0.01, 0.0));
  bool inside = all(greaterThanEqual(g, vec2(0.0))) && all(lessThan(g, vec2(size)));
  vec3 col = paper;
  // pigment dissolved in the water: a wet-in-wet wash that dries like a puddle (crisp edge, darker tide mark)
  vec4 dw = inside ? bspl(dis, g) : vec4(0);
  float da = clamp(dw.a, 0.0, 1.0);
  vec3 dh = clamp(dw.rgb / max(da, 1e-4), 0.0, 1.0);
  dh = max(dh, vec3(0.3));
  dh = mix(vec3(0.45, 0.72, 0.4), dh, smoothstep(0.12, 0.3, dot(dh, vec3(0.3, 0.55, 0.15))) * smoothstep(0.08, 0.2, max(dh.r, max(dh.g, dh.b)) - min(dh.r, min(dh.g, dh.b))));
  float t0 = 0.03 + 0.02 * vnoise(g * 0.3 + 7.0);
  float shape = smoothstep(t0 - 0.003, t0 + 0.003, da);
  float tide = shape * (1.0 - smoothstep(t0, t0 * 3.5, da));
  float dd = shape * (0.08 + 0.42 * (1.0 - exp(-da * 3.0)) + 0.22 * tide) * (0.7 + 0.6 * gran) * (0.8 + 0.4 * bloom);
  // the croc
  float gone; vec2 gw = warp(g, gone);
  vec4 pg = (inside && gone < 0.5) ? bspl(pig, gw) : vec4(0);
  float a = clamp(pg.a, 0.0, 1.2);
  vec3 hue = clamp(pg.rgb / max(a, 1e-3), 0.0, 1.0);
  // where the rule's colour channels collapse (a spare body melting in a fuse) the hue would go near-black: pull
  // it back toward the croc's green (only the look; alpha, which the budget counts, is untouched)
  // and the croc's own palette never goes below ~0.3 in any channel: deeper (over-saturated) greens are the rule's
  // colour channels drifting in a melting spare body, so they are lifted back into the palette
  hue = max(hue, vec3(0.3));
  float lum = dot(hue, vec3(0.3, 0.55, 0.15));
  float sat = max(hue.r, max(hue.g, hue.b)) - min(hue.r, min(hue.g, hue.b));
  hue = mix(vec3(0.47, 0.74, 0.42), hue, smoothstep(0.12, 0.3, lum) * smoothstep(0.06, 0.18, sat));
  float body = smoothstep(iso - 0.025, iso + 0.025, a);
  float water = smoothstep(0.07, 0.10, a) * (1.0 - body) * (0.22 + 0.25 * smoothstep(0.1, iso, a));
  // the rim and thin-feature rings only matter on the croc's body (most pixels are bare paper or water)
  float ring = 10.0;
  if (body > 0.0) { ring = 0.0; for (int i = 0; i < 10; i++) { float th = float(i) * 0.6283 + 0.3; ring += clamp(bilA(gw + 2.4 * vec2(cos(th), sin(th))), 0.0, 1.0); } }
  float rim = smoothstep(0.0, 0.55, body * clamp(1.0 - ring / 10.0, 0.0, 1.0));
  float dens = (body * (0.66 + 0.18 * bloom) + water) * (0.80 + 0.34 * gran);
  // pooled darker at the rim, but never near-black: a thin or overfull feature (a spare body melting into a fuse)
  // is all rim, and the square of a saturated green would read as a dark blot
  // thin features (bare paper within 1.4 cells on most sides) pool much less: there everything is rim
  float near = 8.0;
  if (body > 0.0) { near = 0.0; for (int i = 0; i < 8; i++) { float th = float(i) * 0.7854 + 0.2; near += step(iso, bilA(gw + 1.4 * vec2(cos(th), sin(th)))); } }
  float thin = smoothstep(0.35, 0.7, 1.0 - near / 8.0);
  float pool = (0.75 * rim + 0.15 * gran) * (1.0 - 0.7 * smoothstep(1.05, 1.3, pg.a)) * (1.0 - 0.75 * thin);
  vec3 pc = max(mix(hue, hue * hue * 0.82, pool), hue * 0.6);
  dens = clamp(dens + 0.30 * rim * body * (1.0 - 0.7 * smoothstep(1.05, 1.3, pg.a)) * (1.0 - 0.75 * thin), 0.0, 1.0);
  dd *= (1.0 - body);
  if (dark < 0.5) {
    col = mix(col, col * dh * 1.05, clamp(dd, 0.0, 0.72));
    // the croc is painted as on bare paper (its colour does not depend on what is behind it)
    col = mix(col, paperCol * grainF * pc * 1.05, dens);
  } else {
    // night paper: the paint sits on dark card like gouache, the colour it would have on light paper
    vec3 lp = vec3(0.95, 0.93, 0.88) * grainF;
    col = mix(col, lp * dh * 0.9, clamp(dd * 0.8, 0.0, 0.8));
    col = mix(col, lp * pc * 0.98, dens);
  }
  // stones: a cool grey wash
  if (inside) {
    float st = texelFetch(field, ivec2(clamp(floor(g), vec2(0), vec2(size) - 1.0)), 0).b;
    if (st > 0.5) col = mix(col, (dark < 0.5 ? paper * vec3(0.72, 0.74, 0.76) : vec3(0.42, 0.42, 0.46)) * (0.92 + 0.12 * gran), 0.9);
  }
  o = vec4(col, 1.0);
}`;

function compile(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
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

export class Painter {
  constructor(gl, sim) {
    this.gl = gl; this.sim = sim;
    this.wash = compile(gl, VS, WASH);
    this.plateTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.plateTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([243, 235, 220, 255]));
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.warps = [];
  }
  // the plate: any canvas (drawn by the page) uploaded as the base layer
  setPlate(canvas) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.plateTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }
  // view: { off: [x, y] device px, cell: device px per cell, w, h device px }
  draw(view, { iso = 0.35, time = 0, dark = false, paper = [0.953, 0.922, 0.863] } = {}) {
    const gl = this.gl, P = this.wash, sim = this.sim;
    gl.useProgram(P.p);
    gl.bindVertexArray(sim.vao);
    const bind = (name, t, unit) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(P.u[name], unit); };
    bind('pig', sim.dispTex, 0); bind('dis', sim.waterTex, 1); bind('field', sim.fieldTex, 2); bind('plate', this.plateTex, 3);
    gl.uniform2i(P.u.size, sim.W, sim.H);
    gl.uniform2f(P.u.res, view.w, view.h);
    gl.uniform2f(P.u.off, view.off[0], view.off[1]);
    gl.uniform1f(P.u.cell, view.cell); gl.uniform1f(P.u.iso, iso); gl.uniform1f(P.u.time, time); gl.uniform1f(P.u.dark, dark ? 1 : 0);
    gl.uniform3f(P.u.paperCol, ...paper);
    const R = new Float32Array(16), C = new Float32Array(8);
    this.warps.slice(0, 4).forEach((w, i) => { R.set(w.rect, i * 4); C.set([w.cx, w.sx], i * 2); });
    gl.uniform4fv(P.u.warpR, R); gl.uniform2fv(P.u.warpC, C); gl.uniform1i(P.u.nWarp, Math.min(4, this.warps.length));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, view.w, view.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
