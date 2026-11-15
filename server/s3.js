// Minimal S3-compatible client (Cloudflare R2, AWS S3, MinIO, Backblaze B2) using signed fetch.
import { AwsClient } from 'aws4fetch';

export function s3FromEnv(env = process.env) {
  if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) return null;
  return new S3(env);
}

export class S3 {
  constructor(env) {
    this.base = `${env.S3_ENDPOINT.replace(/\/+$/, '')}/${env.S3_BUCKET}`;
    this.prefix = (env.S3_PREFIX ?? 'tabi/').replace(/^\/+/, '');
    this.client = new AwsClient({
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      region: env.S3_REGION || 'auto',
      service: 's3',
      retries: 0, // callers decide; the lease logic must never be stuck in hidden retries
    });
  }

  url(key) {
    return `${this.base}/${this.prefix}${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async req(method, key, { body, headers = {}, timeout = 20000 } = {}) {
    return this.client.fetch(this.url(key), { method, body, headers, signal: AbortSignal.timeout(timeout) });
  }

  // Returns { body: Buffer, etag, meta } or null when missing
  async get(key, { timeout = 120000 } = {}) {
    const r = await this.req('GET', key, { timeout });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S3 GET ${key}: ${r.status}`);
    return { body: Buffer.from(await r.arrayBuffer()), etag: r.headers.get('etag'), meta: metaFrom(r.headers) };
  }

  async head(key) {
    const r = await this.req('HEAD', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S3 HEAD ${key}: ${r.status}`);
    return { etag: r.headers.get('etag'), meta: metaFrom(r.headers), size: +r.headers.get('content-length') };
  }

  // Conditional put: ifMatch = etag (replace only that version), ifNoneMatch = true (create only).
  // Returns { ok, etag, conflict }
  async put(key, body, { contentType = 'application/octet-stream', meta = {}, ifMatch, ifNoneMatch, timeout } = {}) {
    const headers = { 'content-type': contentType };
    for (const [k, v] of Object.entries(meta)) headers[`x-amz-meta-${k}`] = String(v);
    if (ifMatch) headers['if-match'] = ifMatch;
    if (ifNoneMatch) headers['if-none-match'] = '*';
    const r = await this.req('PUT', key, { body, headers, timeout: timeout || 120000 });
    if (r.status === 412 || r.status === 409) return { ok: false, conflict: true };
    if (!r.ok) throw new Error(`S3 PUT ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return { ok: true, etag: r.headers.get('etag') };
  }

  async del(key) {
    const r = await this.req('DELETE', key);
    if (!r.ok && r.status !== 404) throw new Error(`S3 DELETE ${key}: ${r.status}`);
  }
}

function metaFrom(h) {
  const meta = {};
  h.forEach((v, k) => { if (k.startsWith('x-amz-meta-')) meta[k.slice(11)] = v; });
  return meta;
}
