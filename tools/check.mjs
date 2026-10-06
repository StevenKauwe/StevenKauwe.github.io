// check.mjs: headless checks of the site over the Chrome DevTools Protocol.
// Usage: node tools/check.mjs <baseUrl> [check…]   (needs Chrome on --remote-debugging-port=9222)
import { writeFileSync } from 'node:fs';

const base = (process.argv[2] ?? 'http://127.0.0.1:8765/').replace(/\/?$/, '/');
const only = process.argv.slice(3);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    if (bytes > 300_000) throw new Error(`${bytes} bytes before loops`);
    if (p.errors.length) throw new Error(p.errors.join('; '));
  },
  // 390 px: no horizontal scroll, readable captions
  async narrow() {
    const p = await open(base, { width: 390, height: 844 });
    const r = await p.ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      cap: parseFloat(getComputedStyle(document.querySelector('figcaption')).fontSize) })`);
    await p.screenshot('/private/tmp/claude-502/-Users-kaaikauwe-Documents-craft-craft/5f08bbdc-d5a5-497d-9b4d-1651a6829f8b/scratchpad/site-390.png');
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
      const state = () => imgs.map(i => i.getAttribute('src').endsWith('-still.webp') ? 'still' : 'anim');
      const top = state();
      document.querySelector('figure.chapter:nth-child(3)').scrollIntoView({ block: 'center' });
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
};

let failed = 0;
for (const [name, fn] of Object.entries(CHECKS)) {
  if (only.length && !only.includes(name)) continue;
  try { await fn(); console.log(`ok ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
