// Tiny S3-compatible server for tests: GET/HEAD/PUT/DELETE with conditional PUT.
import http from 'node:http';
import crypto from 'node:crypto';
const store = new Map();
let down = false;
// Like Cloudflare's edge: compressible responses get a weak ETag (W/"...") when the client accepts gzip,
// and conditional writes only match strong ETags.
const WEAK = process.env.MOCK_WEAK_ETAGS !== '0';
http.createServer(async (req, res) => {
  if (req.url === '/__down') { down = true; return res.end('down'); }
  if (req.url === '/__up') { down = false; return res.end('up'); }
  if (down) { res.writeHead(503); return res.end(); }
  const key = decodeURIComponent(req.url.split('?')[0]);
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const obj = store.get(key);
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!obj) { res.writeHead(404); return res.end(); }
    const weak = WEAK && /gzip|br/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { etag: weak ? `W/${obj.etag}` : obj.etag, 'content-length': obj.body.length, ...obj.meta });
    return res.end(req.method === 'HEAD' ? undefined : obj.body);
  }
  if (req.method === 'PUT') {
    if (req.headers['if-none-match'] === '*' && obj) { res.writeHead(412); return res.end(); }
    if (req.headers['if-match'] && (!obj || obj.etag !== req.headers['if-match'])) { res.writeHead(412); return res.end(); }
    const etag = '"' + crypto.createHash('md5').update(body).update(String(Math.random())).digest('hex') + '"';
    const meta = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('x-amz-meta-')));
    store.set(key, { body, etag, meta });
    res.writeHead(200, { etag }); return res.end();
  }
  if (req.method === 'DELETE') { store.delete(key); res.writeHead(204); return res.end(); }
  res.writeHead(405); res.end();
}).listen(9500, () => console.log('mock s3 on 9500'));
