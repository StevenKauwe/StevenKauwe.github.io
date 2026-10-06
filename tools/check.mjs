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
};

let failed = 0;
for (const [name, fn] of Object.entries(CHECKS)) {
  if (only.length && !only.includes(name)) continue;
  try { await fn(); console.log(`ok ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
