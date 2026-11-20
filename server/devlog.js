// In-memory debug event log for the developer console. Nothing here is written to disk:
// it holds the most recent events of each kind and streams new ones to open consoles.
const LIMITS = { log: 800, loc: 1000, owntracks: 300, op: 400, net: 400, ws: 200, client: 300 };
const buffers = Object.fromEntries(Object.keys(LIMITS).map((k) => [k, []]));
const subscribers = new Set();
let seq = 0;
export const startedAt = Date.now();

export function devPush(kind, data) {
  const item = { id: ++seq, ts: Date.now(), kind, ...data };
  const buf = buffers[kind];
  if (!buf) return;
  buf.push(item);
  if (buf.length > LIMITS[kind]) buf.splice(0, buf.length - LIMITS[kind]);
  if (subscribers.size) {
    const line = `id: ${item.id}\nevent: ${kind}\ndata: ${JSON.stringify(item)}\n\n`;
    for (const res of subscribers) { try { res.write(line); } catch { subscribers.delete(res); } }
  }
}

export function devRecent(kind, { since = 0, limit = 500 } = {}) {
  const buf = buffers[kind] || [];
  return buf.filter((x) => x.id > since).slice(-limit);
}

// Server-Sent Events stream for live consoles
export function devSubscribe(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`retry: 3000\n\n`);
  subscribers.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20000);
  req.on('close', () => { clearInterval(ping); subscribers.delete(res); });
}

// Keys and tokens from the server's settings never reach the console: some services take their key
// in the address (KLIPY puts it in the path), and an error message can quote a setting. Any setting
// whose name says it's a key, token, secret or password is blanked out, as typed and URL-encoded.
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD)/i;
let secretValues = null;
function secrets() {
  if (!secretValues) {
    const vals = new Set();
    for (const [k, v] of Object.entries(process.env)) {
      if (!SECRET_NAME.test(k) || !v || v.length < 8) continue; // short values are placeholders, and would blank ordinary text
      vals.add(v);
      vals.add(encodeURIComponent(v));
    }
    secretValues = [...vals].sort((a, b) => b.length - a.length);
  }
  return secretValues;
}
export function redact(s) {
  let out = String(s);
  for (const v of secrets()) if (out.includes(v)) out = out.split(v).join('…');
  return out;
}

// Capture console output and outbound HTTP calls (search, link lookups, R2, exchange rates…).
let installed = false;
export function installDevCapture() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      const msg = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      devPush('log', { level, msg: redact(msg).slice(0, 2000) });
    };
  }
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    const method = (init.method || input?.method || 'GET').toUpperCase();
    const t0 = Date.now();
    let u;
    try { u = new URL(url); } catch { u = null; }
    const where = u ? { host: u.host, path: redact(u.pathname + u.search).slice(0, 240) } : { host: '?', path: redact(url).slice(0, 240) };
    try {
      const r = await origFetch(input, init);
      devPush('net', { method, ...where, status: r.status, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      devPush('net', { method, ...where, status: 0, error: e.name === 'TimeoutError' ? 'timeout' : redact(e.message), ms: Date.now() - t0 });
      throw e;
    }
  };
}
