// Stand-in for Cloudflare's edge, for the dev stack.
//
// In production each Tabi node starts its Cloudflare Tunnel only while it holds the leader lease,
// so the public address always reaches whichever node is serving. This does the same locally: it
// asks every node's /healthz each second and sends all traffic, WebSockets included, to the one
// that says it's the leader. Like Cloudflare it:
// - sets CF-Connecting-IP to the visitor's address (any CF-Connecting-IP the visitor sent is replaced)
// - answers 530 with an error page while no node is serving (during a failover)
//
// GET /__edge shows which node is serving and what each one reports.
//
// node dev/edge.mjs [--port 8080] [--nodes primary=http://localhost:8101,backup=http://localhost:8102]
import http from 'node:http';
import net from 'node:net';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const PORT = +arg('port', process.env.EDGE_PORT || 8080);
const NODES = String(arg('nodes', process.env.EDGE_NODES || 'primary=http://localhost:8101,backup=http://localhost:8102'))
  .split(',').map((s) => { const [name, url] = s.split('='); return { name, url: new URL(url), health: null, at: 0 }; });

let leader = null;
let lastLeader;
async function poll() {
  await Promise.all(NODES.map(async (n) => {
    try {
      const r = await fetch(new URL('/healthz', n.url), { signal: AbortSignal.timeout(900) });
      n.health = await r.json();
    } catch { n.health = null; }
    n.at = Date.now();
  }));
  // A node serving on its own (no failover) reports "single"
  leader = NODES.find((n) => n.health && ['leader', 'single'].includes(n.health.role)) || null;
  if ((leader?.name || null) !== lastLeader) {
    console.log(`[edge] ${leader ? `traffic now goes to ${leader.name}` : 'no node is serving: visitors get a 530 until one takes over'}`);
    lastLeader = leader?.name || null;
  }
}
setInterval(poll, 1000);
await poll();

const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const forwardHeaders = (req) => {
  const h = { ...req.headers };
  for (const k of Object.keys(h)) if (k.startsWith('cf-')) delete h[k];
  h['cf-connecting-ip'] = clientIp(req);
  h['x-forwarded-for'] = clientIp(req);
  h['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'http';
  return h;
};
const noLeader = (res) => {
  res.writeHead(530, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '5' });
  res.end(`<!doctype html><meta charset="utf-8"><title>No server is serving</title>
<body style="font:16px system-ui;margin:3rem;max-width:40rem;color:#1a1d21">
<h1 style="font-size:1.3rem">No Tabi server is serving right now</h1>
<p>This is the dev stack's stand-in for Cloudflare. Neither node holds the leader lease, which happens for
a few seconds during a failover. Production shows Cloudflare's own 530 page here.</p>
<p><a href="/__edge">See what each node reports</a>. This page reloads itself.</p>
<script>setTimeout(()=>location.reload(),3000)</script>`);
};

const server = http.createServer((req, res) => {
  if (req.url === '/__edge') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ serving: leader?.name || null, nodes: NODES.map((n) => ({ name: n.name, url: n.url.href, health: n.health })) }, null, 2));
  }
  const to = leader;
  if (!to) return noLeader(res);
  const up = http.request({ host: to.url.hostname, port: to.url.port, method: req.method, path: req.url, headers: forwardHeaders(req) }, (r) => {
    res.writeHead(r.statusCode, { ...r.headers, 'x-tabi-dev-node': to.name });
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) noLeader(res); else res.destroy(); });
  req.pipe(up);
});

// WebSockets: pass the upgrade through untouched, with the same headers
server.on('upgrade', (req, socket, head) => {
  const to = leader;
  if (!to) return socket.destroy();
  const upstream = net.connect(+to.url.port, to.url.hostname, () => {
    const h = forwardHeaders(req);
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  const end = () => { upstream.destroy(); socket.destroy(); };
  upstream.on('error', end); socket.on('error', end);
  upstream.on('close', () => socket.destroy()); socket.on('close', () => upstream.destroy());
});

server.listen(PORT, () => console.log(`[edge] stand-in for Cloudflare on http://localhost:${PORT} (nodes: ${NODES.map((n) => n.name).join(', ')})`));
