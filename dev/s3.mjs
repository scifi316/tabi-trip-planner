// Stand-in for Cloudflare R2, for the dev stack: a small S3-compatible store that keeps objects on
// disk, so data survives restarts like the real bucket does.
//
// It behaves like R2 where Tabi relies on it:
// - conditional writes (If-Match / If-None-Match: *), which the leader lease depends on
// - weak ETags (W/"...") on downloads when the client accepts gzip, as Cloudflare's edge does;
//   conditional writes only match the strong ETag
// - any access key is accepted (requests are signed, but not checked)
//
// Extras for testing: GET /__down makes it fail every request with 503 (an outage), /__up ends
// that, /__list shows what's stored, and PUT /__corrupt/<bucket>/<key> replaces an object's
// bytes without changing its name (to test that damaged copies are caught).
//
// node dev/s3.mjs [--port 9000] [--dir dev/.data/s3]
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const PORT = +arg('port', process.env.PORT || 9000);
const DIR = path.resolve(arg('dir', process.env.S3_DIR || 'dev/.data/s3'));
fs.mkdirSync(DIR, { recursive: true });
let down = false;

// One file per object, named by the hash of its key, with a small JSON file beside it for the ETag and metadata
const fileOf = (key) => path.join(DIR, crypto.createHash('sha256').update(key).digest('hex'));
const read = (key) => {
  try { return { ...JSON.parse(fs.readFileSync(fileOf(key) + '.json', 'utf8')), body: fs.readFileSync(fileOf(key)) }; } catch { return null; }
};
const write = (key, body, meta) => {
  const etag = '"' + crypto.createHash('md5').update(body).update(crypto.randomBytes(8)).digest('hex') + '"';
  fs.writeFileSync(fileOf(key) + '.tmp', body);
  fs.renameSync(fileOf(key) + '.tmp', fileOf(key));
  fs.writeFileSync(fileOf(key) + '.json', JSON.stringify({ key, etag, meta, size: body.length, at: new Date().toISOString() }));
  return etag;
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__down') { down = true; console.log('[s3] now failing every request (R2 outage)'); return res.end('down\n'); }
  if (url.pathname === '/__up') { down = false; console.log('[s3] back up'); return res.end('up\n'); }
  if (url.pathname.startsWith('/__corrupt/') && req.method === 'PUT') {
    const key = decodeURIComponent(url.pathname.slice('/__corrupt'.length));
    const obj = read(key);
    if (!obj) { res.writeHead(404); return res.end(); }
    const bad = Buffer.from(obj.body); bad[bad.length >> 1] ^= 0xff;
    fs.writeFileSync(fileOf(key), bad);
    return res.end('corrupted\n');
  }
  if (url.pathname === '/__list') {
    const items = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(items.sort((a, b) => a.key.localeCompare(b.key)).map((o) => `${o.at}  ${String(o.size).padStart(9)}  ${o.key}`).join('\n') + '\n');
  }
  if (down) { res.writeHead(503); return res.end(); }
  // ListObjectsV2 on a bucket: GET /<bucket>?list-type=2&prefix=...
  if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
    const bucket = url.pathname.split('/').filter(Boolean)[0];
    const want = `/${bucket}/${url.searchParams.get('prefix') || ''}`;
    const items = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
      .filter((o) => o.key.startsWith(want)).sort((a, b) => a.key.localeCompare(b.key));
    const esc = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    res.writeHead(200, { 'content-type': 'application/xml' });
    return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${items.map((o) =>
      `<Contents><Key>${esc(o.key.slice(bucket.length + 2))}</Key><Size>${o.size}</Size></Contents>`).join('')}</ListBucketResult>`);
  }
  // Path style: /<bucket>/<key...>. A PUT of the bucket itself (no key) just succeeds.
  const key = decodeURIComponent(url.pathname);
  if (key.split('/').filter(Boolean).length < 2) { res.writeHead(200); return res.end(); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const obj = read(key);
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!obj) { res.writeHead(404); return res.end(); }
    const weak = /gzip|br/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { etag: weak ? `W/${obj.etag}` : obj.etag, 'content-length': obj.body.length, ...obj.meta });
    return res.end(req.method === 'HEAD' ? undefined : obj.body);
  }
  if (req.method === 'PUT') {
    if (req.headers['if-none-match'] === '*' && obj) { res.writeHead(412); return res.end(); }
    if (req.headers['if-match'] && (!obj || obj.etag !== req.headers['if-match'])) { res.writeHead(412); return res.end(); }
    const meta = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('x-amz-meta-') || k === 'content-type'));
    const etag = write(key, body, meta);
    res.writeHead(200, { etag }); return res.end();
  }
  if (req.method === 'DELETE') {
    for (const f of [fileOf(key), fileOf(key) + '.json']) fs.rmSync(f, { force: true });
    res.writeHead(204); return res.end();
  }
  res.writeHead(405); res.end();
}).listen(PORT, () => console.log(`[s3] stand-in for R2 on http://localhost:${PORT} (data in ${path.relative(process.cwd(), DIR) || DIR})`));
