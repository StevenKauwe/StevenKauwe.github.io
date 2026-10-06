// check.mjs: headless checks of the site over the Chrome DevTools Protocol.
// Usage: node tools/check.mjs <baseUrl> [check…]   (needs Chrome on --remote-debugging-port=9222)
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = (process.argv[2] ?? 'http://127.0.0.1:8765/').replace(/\/?$/, '/');
const only = process.argv.slice(3);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SITE_DIR = fileURLToPath(new URL('..', import.meta.url));
const FILMS_DIR = process.env.FILMS_DIR ?? join(SITE_DIR, '..', 'films');
// the gallery's films, in page order; the potato is served from /films/ too but lives at /potato/ only
const FILMS = ['creepy-crawly', 'im-not-pdoom-rsi', 'spider', 'made-for-the-night', 'oh-brassica', 'pray'];
const POTATO = 'this-is-the-whole-website';
const probe = url => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags:stream=codec_name,width,height:stream_tags', '-of', 'json', url], { encoding: 'utf8' }));
// top-level MP4 boxes in file order, read with Range requests (faststart puts moov before mdat)
async function boxes(url) {
  const size = +(await fetch(url, { method: 'HEAD' })).headers.get('content-length'), out = [];
  for (let off = 0; off < size && out.length < 16;) {
    const b = Buffer.from(await (await fetch(url, { headers: { Range: `bytes=${off}-${off + 15}` } })).arrayBuffer());
    let len = b.readUInt32BE(0); if (len === 1) len = Number(b.readBigUInt64BE(8));
    out.push(b.toString('latin1', 4, 8)); if (len < 8) break; off += len;
  }
  return out;
}

export async function open(url, { width = 1440, height = 900, reduce = false, dark = false, wait = 2500 } = {}) {
  const tab = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0;
  const pending = new Map(), requests = new Map(), errors = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id) { pending.get(d.id)?.(d); pending.delete(d.id); return; }
    if (d.method === 'Network.responseReceived') requests.set(d.params.requestId, { url: d.params.response.url, status: d.params.response.status, bytes: 0 });
    if (d.method === 'Network.loadingFinished' && requests.has(d.params.requestId)) requests.get(d.params.requestId).bytes = d.params.encodedDataLength;
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value).join(' '));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push(d.params.entry.text + ' ' + (d.params.entry.url ?? ''));
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  for (const d of ['Runtime', 'Network', 'Page', 'Log']) await send(`${d}.enable`);
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  const features = [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }, { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }];
  await send('Emulation.setEmulatedMedia', { features });
  await send('Page.navigate', { url });
  await sleep(wait);
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result?.value;
  const screenshot = async path => writeFileSync(path, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  const close = async () => { ws.close(); await fetch(`http://127.0.0.1:9222/json/close/${tab.id}`); };
  return { ev, requests: [...requests.values()], live: requests, errors, screenshot, close, send };
}

const status = async url => (await fetch(url, { method: 'HEAD' })).status;

export const CHECKS = {
  // the potato lives on at /potato/, and its old URLs keep working
  async potato() {
    const p = await open(base + 'potato/');
    const v = await p.ev(`(async () => { const v = document.querySelector('video'); if (!v) return null; if (v.readyState < 1) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true })); return { d: v.duration, w: v.videoWidth }; })()`);
    await p.close();
    if (!v || !(v.d > 70) || v.w !== 1920) throw new Error(`video ${JSON.stringify(v)}`);
    for (const u of ['this-is-the-whole-website.mp4', 'poster.webp']) if ((await status(base + u)) !== 200) throw new Error(`${u} not 200`);
    if (p.errors.length) throw new Error(p.errors.join('; '));
  },
  // the page reads right and stays light before any loop loads
  async shell() {
    const p = await open(base, { wait: 1500 });
    const r = await p.ev(`({
      h1: document.querySelector('h1')?.textContent.trim(),
      lede: document.querySelector('.lede')?.textContent.trim(),
      chapters: [...document.querySelectorAll('figure.chapter figcaption')].map(f => f.textContent.trim()),
      papers: [...document.querySelectorAll('.papers li a')].map(a => a.href),
      hat: document.querySelector('footer a[href="potato/"]') !== null,
      noContact: !/@|\\(801\\)|tel:/.test(document.body.innerHTML),
    })`);
    const bytes = p.requests.filter(q => !/\.webp$/.test(q.url) || /-still\.webp$/.test(q.url)).reduce((s, q) => s + q.bytes, 0);
    const bad = p.requests.filter(q => q.status !== 200 && q.status !== 304).map(q => `${q.status} ${q.url}`);
    await p.close();
    if (r.h1 !== 'Steven Kauwe') throw new Error(`h1 ${r.h1}`);
    if (r.lede !== 'Machine-learning engineer. PhD in materials science. At night, I direct coding agents that build films and Rust.') throw new Error(`lede ${r.lede}`);
    if (r.chapters.length !== 5) throw new Error(`${r.chapters.length} chapters`);
    if (r.papers.length !== 4 || !r.papers.every(h => h.startsWith('https://doi.org/'))) throw new Error(`papers ${r.papers}`);
    if (!r.hat) throw new Error('no top-hat link to potato/');
    if (!r.noContact) throw new Error('contact details on the page');
    if (bad.length) throw new Error(bad.join(', '));
    // the real page is ~53 KB; near zero means the weight came from cache and measured nothing
    if (bytes < 10_000) throw new Error(`${bytes} bytes before loops: implausibly small, cache not bypassed`);
    if (bytes > 300_000) throw new Error(`${bytes} bytes before loops`);
    if (p.errors.length) throw new Error(p.errors.join('; '));
  },
  // 390 px: no horizontal scroll, readable captions
  async narrow() {
    const p = await open(base, { width: 390, height: 844 });
    const r = await p.ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      cap: parseFloat(getComputedStyle(document.querySelector('figcaption')).fontSize) })`);
    const shot = join(process.env.SITE_SHOTS ?? tmpdir(), 'site-390.png');
    await p.screenshot(shot);
    console.log(`  screenshot ${shot}`);
    await p.close();
    if (r.sw > r.cw) throw new Error(`horizontal scroll: ${r.sw} > ${r.cw}`);
    if (r.cap < 15) throw new Error(`caption ${r.cap}px`);
  },
  // night paper: body text keeps 7:1 contrast
  async dark() {
    const p = await open(base, { dark: true });
    const r = await p.ev(`(() => {
      const rgb = s => s.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number);
      const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
      const fg = rgb(getComputedStyle(document.querySelector('.lede')).color), bg = rgb(getComputedStyle(document.body).backgroundColor);
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x); return (a + .05) / (b + .05);
    })()`);
    await p.close();
    if (!(r >= 7)) throw new Error(`contrast ${r.toFixed(2)}:1`);
  },
  // only on-screen loops animate; nothing animated is fetched until scrolled to
  async loops() {
    const p = await open(base, { wait: 2000 });
    const animatedFirst = p.requests.filter(q => /\/loops\/(?!.*-still)[a-z]+\.webp$/.test(q.url)).map(q => q.url);
    const r = await p.ev(`(async () => {
      const imgs = [...document.querySelectorAll('img.loop')];
      const state = () => imgs.map(i => i.getAttribute('src') === i.dataset.loop ? 'anim' : 'still');
      const top = state();
      document.querySelector('figure.chapter:nth-of-type(3)').scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 600));
      return { top, mid: state() };
    })()`);
    await p.close();
    // at the top: the hero animates; chapters 2-5 (imgs 2..5) do not (chapter 1 may, it is within the margin)
    if (r.top[0] !== 'anim') throw new Error(`hero ${r.top[0]}`);
    if (r.top.slice(2).some(s => s === 'anim')) throw new Error(`below-fold animating at top: ${r.top}`);
    if (animatedFirst.some(u => !/hero\.webp$/.test(u) && !/byu\.webp$/.test(u))) throw new Error(`fetched early: ${animatedFirst}`);
    // scrolled to chapter 3: it animates, the hero is back to still
    if (r.mid[3] !== 'anim' || r.mid[0] !== 'still') throw new Error(`after scroll ${r.mid}`);
  },
  // reduced motion: no animated loop is ever requested
  async reduced() {
    const p = await open(base, { reduce: true, wait: 1500 });
    await p.ev(`(async () => { for (const f of document.querySelectorAll('figure.chapter')) { f.scrollIntoView(); await new Promise(r => setTimeout(r, 250)); } })()`);
    const anim = [...p.live.values()].filter(q => /\/loops\/(?!.*-still)[a-z]+\.webp$/.test(q.url));
    await p.close();
    if (anim.length) throw new Error(`animated loops fetched: ${anim.map(q => q.url)}`);
  },
  // every chapter's painting is the same size, whichever side it sits on
  async layout() {
    const p = await open(base, { wait: 1200 });
    const ws = await p.ev(`[...document.querySelectorAll('figure.chapter img')].map(i => Math.round(i.getBoundingClientRect().width))`);
    await p.close();
    if (Math.max(...ws) - Math.min(...ws) > 2) throw new Error(`chapter image widths ${ws}`);
  },
  // the footer hat stays visible on night paper (3:1 against the page)
  async hat() {
    const p = await open(base, { dark: true, wait: 1200 });
    const r = await p.ev(`(() => {
      const rgb = s => s.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number);
      const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
      const h = document.querySelector('footer .hat-mark'); if (!h) return null;
      const [a, b] = [lum(rgb(getComputedStyle(h).backgroundColor)), lum(rgb(getComputedStyle(document.body).backgroundColor))].sort((x, y) => y - x);
      return (a + .05) / (b + .05);
    })()`);
    await p.close();
    if (!(r >= 3)) throw new Error(`hat contrast ${r}`);
  },
  // each poster still (all a reduced-motion visitor ever sees) shows the story, not the loop's empty first frame
  async posters() {
    const p = await open(base, { reduce: true, wait: 800 });
    const r = await p.ev(`(async () => {
      const out = {};
      for (const n of ['hero', 'byu', 'utah', 'verana', 'citrine', 'nights']) {
        const img = new Image(); img.src = 'img/loops/' + n + '-still.webp'; await img.decode();
        const c = document.createElement('canvas'); c.width = 240; c.height = 135;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, 240, 135);
        const d = g.getImageData(0, 0, 240, 135).data;
        let inked = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 60) inked++;
        out[n] = +(inked / (d.length / 4)).toFixed(3);
      }
      return out;
    })()`);
    await p.close();
    console.log(`  ${Object.entries(r).map(([n, v]) => `${n} ${v}`).join(' | ')}`);
    // share of strongly coloured pixels (max-min channel > 60); the empty first frames are paper and pencil only (0%),
    // the sparest story frame (verana's highlighter strokes) is ~1.3%
    const flat = Object.entries(r).filter(([, v]) => v < 0.005).map(([n]) => n);
    if (flat.length) throw new Error(`empty-looking posters: ${flat}`);
  },
  // every loop and still exists; each loop is 1-2 MB, each still under 60 KB
  async budget() {
    for (const n of ['hero', 'byu', 'utah', 'verana', 'citrine', 'nights']) {
      const a = await fetch(base + `img/loops/${n}.webp`), s = await fetch(base + `img/loops/${n}-still.webp`);
      if (a.status !== 200 || s.status !== 200) throw new Error(`${n}: ${a.status}/${s.status}`);
      const [ab, sb] = [(await a.arrayBuffer()).byteLength, (await s.arrayBuffer()).byteLength];
      if (ab > 2_100_000) throw new Error(`${n}.webp ${ab} bytes`);
      if (sb > 60_000) throw new Error(`${n}-still.webp ${sb} bytes`);
      if (Buffer.from(await (await fetch(base + `img/loops/${n}.webp`)).arrayBuffer()).indexOf('ANIM') < 0) throw new Error(`${n}.webp is not animated`);
    }
  },
  // the films repo, as served at /films/: web-sized faststart MP4s with no tags, a preview loop and a poster each
  async filmfiles() {
    for (const s of [...FILMS, POTATO]) {
      const u = base + `films/${s}.mp4`, h = await fetch(u, { method: 'HEAD' });
      if (h.status !== 200) throw new Error(`${s}.mp4 ${h.status}`);
      const bytes = +h.headers.get('content-length');
      if (bytes > 80_000_000) throw new Error(`${s}.mp4 ${bytes} bytes`);
      const r = await fetch(u, { headers: { Range: 'bytes=0-1' } });
      if (r.status !== 206) throw new Error(`${s}.mp4 range ${r.status}`);
      const p = probe(u), v = p.streams.find(x => x.codec_name === 'h264'), a = p.streams.find(x => x.codec_name === 'aac');
      if (!v || !a || v.width !== 1920 || v.height !== 1080) throw new Error(`${s}.mp4 streams ${JSON.stringify(p.streams)}`);
      if (p.format.tags?.title) throw new Error(`${s}.mp4 has a title tag`);
      if (!(+p.format.duration > 60)) throw new Error(`${s}.mp4 duration ${p.format.duration}`);
      const b = await boxes(u);
      if (!(b.indexOf('moov') >= 0 && b.indexOf('moov') < b.indexOf('mdat'))) throw new Error(`${s}.mp4 not faststart: ${b}`);
      const pv = await fetch(base + `films/${s}.webp`), po = await fetch(base + `films/${s}-poster.webp`);
      if (pv.status !== 200 || po.status !== 200) throw new Error(`${s}: preview ${pv.status}, poster ${po.status}`);
      const [pvb, pob] = [Buffer.from(await pv.arrayBuffer()), Buffer.from(await po.arrayBuffer())];
      if (pvb.indexOf('ANIM') < 0 || pvb.length > 1_500_000) throw new Error(`${s}.webp ${pvb.length} bytes, animated ${pvb.indexOf('ANIM') >= 0}`);
      if (pob.indexOf('ANIM') >= 0 || pob.length > 80_000) throw new Error(`${s}-poster.webp ${pob.length} bytes`);
      console.log(`  ${s}: mp4 ${(bytes / 1e6).toFixed(1)} MB ${(+p.format.duration).toFixed(1)} s, preview ${(pvb.length / 1e6).toFixed(2)} MB, poster ${(pob.length / 1e3).toFixed(0)} KB`);
    }
  },
  // Creepy Crawly is published under its own name only: its source folder's name appears nowhere public
  async hiddenname() {
    const bad = /c[o]co/i; // the bracket keeps this file from matching itself
    const hits = [];
    for (const u of ['', 'potato/', 'films/']) { const r = await fetch(base + u); if (r.ok && bad.test(await r.text())) hits.push(base + u); }
    for (const s of [...FILMS, POTATO]) {
      const u = base + `films/${s}.mp4`;
      if ((await status(u)) === 200 && bad.test(JSON.stringify(probe(u)))) hits.push(`${s}.mp4 tags`);
    }
    // local repos: every tracked or unignored file's name, the text of the text files, and the commit messages
    // (the media's bytes are compressed noise that matches any short pattern by chance; names and tags are checked instead)
    for (const dir of [SITE_DIR, FILMS_DIR]) {
      if (!existsSync(join(dir, '.git'))) { console.log(`  no repo at ${dir}: skipped`); continue; }
      const files = execFileSync('git', ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
      for (const f of files) {
        if (bad.test(f)) hits.push(`${dir}: name ${f}`);
        else if (/\.(html|css|js|mjs|md|json|svg|txt)$/.test(f) && existsSync(join(dir, f)) && bad.test(readFileSync(join(dir, f), 'utf8'))) hits.push(`${dir}: text ${f}`);
      }
      let log = ''; try { log = execFileSync('git', ['-C', dir, 'log', '--format=%B'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
      if (bad.test(log)) hits.push(`${dir}: commit messages`);
    }
    if (hits.length) throw new Error(hits.join(', '));
  },
  // six film cards, in order, each linking to a film that exists, with its preview and poster
  async films() {
    const p = await open(base, { wait: 1200 });
    const cards = await p.ev(`[...document.querySelectorAll('section.films a.film')].map(a => ({
      href: a.getAttribute('href'), name: a.querySelector('.film-name')?.textContent.trim(),
      len: a.querySelector('.film-len')?.textContent.trim(),
      loop: a.querySelector('img.loop')?.dataset.loop, src: a.querySelector('img.loop')?.getAttribute('src') }))`);
    await p.close();
    const got = (cards ?? []).map(c => c.href);
    const want = FILMS.map(s => `/films/${s}.mp4`);
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`cards ${got}`);
    for (const [i, c] of cards.entries()) {
      const s = FILMS[i];
      if (!c.name || !/^\d:\d\d$/.test(c.len ?? '')) throw new Error(`${s}: name ${c.name}, length ${c.len}`);
      if (c.loop !== `/films/${s}.webp` || c.src !== `/films/${s}-poster.webp`) throw new Error(`${s}: loop ${c.loop}, src ${c.src}`);
      for (const u of [c.href, c.loop, c.src]) if ((await status(new URL(u, base).href)) !== 200) throw new Error(`${u} not 200`);
    }
  },
  // a card opens the player; the film streams, seeks (a 206) and stops when the player closes
  async player() {
    const p = await open(base, { wait: 1200 });
    // a real click carries user activation, which lets films.js's play() start the film; a plain el.click() would not
    await p.send('Runtime.evaluate', { userGesture: true, expression: `(() => {
      const a = document.querySelector('a.film[href="/films/spider.mp4"]');
      if (a && document.querySelector('dialog.player')) { a.scrollIntoView({ block: 'center' }); a.click(); } })()` });
    const r = await p.ev(`(async () => {
      const dlg = document.querySelector('dialog.player'), v = dlg?.querySelector('video');
      if (!v || !dlg.open && !v.getAttribute('src')) return { missing: true };
      const until = (event, ms) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(event + ' never fired (readyState ' + v.readyState + ', networkState ' + v.networkState + ', paused ' + v.paused + ')')), ms);
        v.addEventListener(event, () => { clearTimeout(t); res(); }, { once: true });
      });
      try {
        const opened = dlg.open, title = dlg.querySelector('.player-title')?.textContent;
        if (v.paused) await until('playing', 15000);
        await new Promise(r => setTimeout(r, 1500));
        const played = v.currentTime, target = v.duration * 0.6;
        const seeked = until('seeked', 15000); v.currentTime = target; await seeked;
        const after = v.currentTime, d = v.duration, w = v.videoWidth;
        dlg.close(); await new Promise(r => setTimeout(r, 100));
        return { opened, title, d, w, played, target, after, closed: !dlg.open, paused: v.paused, src: v.getAttribute('src') };
      } catch (e) { return { fail: e.message }; }
    })()`);
    const ranged = [...p.live.values()].filter(q => q.url.endsWith('/films/spider.mp4') && q.status === 206).length;
    await p.close();
    if (!r || r.missing) throw new Error('no film card or player');
    if (r.fail) throw new Error(r.fail);
    if (!r.opened || r.title !== 'Spider') throw new Error(`dialog open ${r.opened}, title ${r.title}`);
    if (!(r.d > 160) || r.w !== 1920) throw new Error(`video ${r.d} s, ${r.w} px`);
    if (!(r.played > 0.3)) throw new Error(`did not play (${r.played})`);
    if (Math.abs(r.after - r.target) > 1) throw new Error(`seek to ${r.target} landed at ${r.after}`);
    if (!ranged) throw new Error('no 206 response for the film');
    if (!r.closed || !r.paused || r.src !== null) throw new Error(`after close: open ${!r.closed}, paused ${r.paused}, src ${r.src}`);
    if (p.errors.length) throw new Error(p.errors.join('; '));
  },
  // the gallery costs nothing at the top of the page, and no film is downloaded without a click
  async filmsweight() {
    const p = await open(base, { wait: 2000 });
    const early = p.requests.filter(q => q.url.includes('/films/')).map(q => q.url);
    await p.ev(`(async () => { document.querySelector('section.films').scrollIntoView(); await new Promise(r => setTimeout(r, 2000)); })()`);
    const later = [...p.live.values()].filter(q => q.url.includes('/films/'));
    await p.close();
    if (early.length) throw new Error(`fetched at the top: ${early}`);
    const mp4 = later.filter(q => /\.mp4$/.test(q.url)).map(q => q.url);
    if (mp4.length) throw new Error(`MP4 fetched without a click: ${mp4}`);
    if (!later.length) throw new Error('nothing from /films/ after scrolling to the gallery');
    console.log(`  after scrolling to the gallery: ${later.length} files, ${(later.reduce((s, q) => s + q.bytes, 0) / 1e6).toFixed(2)} MB`);
  },
  // reduced motion: the gallery shows posters only
  async filmsreduced() {
    const p = await open(base, { reduce: true, wait: 1200 });
    const srcs = await p.ev(`(async () => { document.querySelector('section.films').scrollIntoView(); await new Promise(r => setTimeout(r, 1500));
      return [...document.querySelectorAll('section.films img')].map(i => i.getAttribute('src')); })()`);
    const previews = [...p.live.values()].filter(q => /\/films\/[a-z-]+\.webp$/.test(q.url) && !/-poster\.webp$/.test(q.url));
    const posters = [...p.live.values()].filter(q => /-poster\.webp$/.test(q.url) && q.status === 200);
    await p.close();
    if (previews.length) throw new Error(`previews fetched: ${previews.map(q => q.url)}`);
    if (!srcs?.length || !srcs.every(s => s.endsWith('-poster.webp'))) throw new Error(`srcs ${srcs}`);
    if (!posters.length) throw new Error('no poster loaded');
  },
  // 390 px: the gallery fits, one card per row, readable text
  async filmsnarrow() {
    const p = await open(base, { width: 390, height: 844 });
    const r = await p.ev(`(async () => { const s = document.querySelector('section.films'); s.scrollIntoView(); await new Promise(r => setTimeout(r, 800));
      const cards = [...s.querySelectorAll('a.film')].map(a => a.getBoundingClientRect());
      return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        maxRight: Math.max(...cards.map(c => c.right)), lefts: new Set(cards.map(c => Math.round(c.left))).size,
        text: parseFloat(getComputedStyle(s.querySelector('li p')).fontSize) }; })()`);
    const shot = join(process.env.SITE_SHOTS ?? tmpdir(), 'films-390.png');
    await p.screenshot(shot); console.log(`  screenshot ${shot}`);
    await p.close();
    if (!r) throw new Error('no films section');
    if (r.sw > r.cw) throw new Error(`horizontal scroll: ${r.sw} > ${r.cw}`);
    if (r.maxRight > r.cw) throw new Error(`card overflows: ${r.maxRight} > ${r.cw}`);
    if (r.lefts !== 1) throw new Error(`${r.lefts} columns at 390 px`);
    if (r.text < 15) throw new Error(`description ${r.text}px`);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(CHECKS)) {
  if (only.length && !only.includes(name)) continue;
  try { await fn(); console.log(`ok ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
