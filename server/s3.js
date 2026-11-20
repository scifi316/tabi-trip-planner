// Minimal S3-compatible client (Cloudflare R2, AWS S3, MinIO, Backblaze B2) using signed fetch.
import { AwsClient } from 'aws4fetch';

const clean = (v) => String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();

// Accepts common paste mistakes: missing https://, quotes, a trailing slash, or the bucket on the end.
export function normalizeEndpoint(raw, bucket) {
  let v = clean(raw);
  if (!v) return { error: 'S3_ENDPOINT is empty.' };
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  let u;
  try { u = new URL(v); } catch { return { error: `S3_ENDPOINT "${clean(raw)}" isn't a web address. It should look like https://<account-id>.r2.cloudflarestorage.com` }; }
  const path = u.pathname.replace(/\/+$/, '');
  if (path && path !== '/') {
    if (bucket && path === `/${bucket}`) return { endpoint: u.origin, note: `S3_ENDPOINT included the bucket name; using ${u.origin}` };
    return { error: `S3_ENDPOINT should end at the domain (${u.origin}), with the bucket in S3_BUCKET.` };
  }
  return { endpoint: u.origin };
}

export function s3FromEnv(env = process.env) {
  const bucket = clean(env.S3_BUCKET);
  if (!clean(env.S3_ENDPOINT) || !bucket || !clean(env.S3_ACCESS_KEY_ID) || !clean(env.S3_SECRET_ACCESS_KEY)) return null;
  const ep = normalizeEndpoint(env.S3_ENDPOINT, bucket);
  if (ep.error) throw new Error(ep.error);
  if (ep.note) console.log(ep.note);
  return new S3({ ...env, S3_ENDPOINT: ep.endpoint, S3_BUCKET: bucket, S3_ACCESS_KEY_ID: clean(env.S3_ACCESS_KEY_ID), S3_SECRET_ACCESS_KEY: clean(env.S3_SECRET_ACCESS_KEY) });
}

// The second, colder store (Backblaze B2, or any S3-compatible service): COLD_S3_* settings, same
// meaning as S3_*. Old full-size pictures and old backups move there; everything is copied there.
export function coldFromEnv(env = process.env) {
  const ep = clean(env.COLD_S3_ENDPOINT);
  if (!ep) return null;
  // Backblaze signs with the region in its address (s3.us-west-004.backblazeb2.com)
  const region = clean(env.COLD_S3_REGION) || /s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(ep)?.[1] || 'auto';
  const store = s3FromEnv({ S3_ENDPOINT: ep, S3_BUCKET: env.COLD_S3_BUCKET, S3_ACCESS_KEY_ID: env.COLD_S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: env.COLD_S3_SECRET_ACCESS_KEY, S3_REGION: region, S3_PREFIX: env.COLD_S3_PREFIX ?? env.S3_PREFIX });
  if (!store) throw new Error('COLD_S3_ENDPOINT is set, but COLD_S3_BUCKET, COLD_S3_ACCESS_KEY_ID and COLD_S3_SECRET_ACCESS_KEY are not all set.');
  store.name = /backblazeb2/i.test(ep) ? 'B2' : 'cold storage';
  return store;
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
    return this.client.fetch(this.url(key), { method, body, headers: { 'accept-encoding': 'identity', ...headers }, signal: AbortSignal.timeout(timeout) });
  }

  // Returns { body: Buffer, etag, meta } or null when missing
  async get(key, { timeout = 120000 } = {}) {
    const r = await this.req('GET', key, { timeout });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S3 GET ${key}: ${r.status}`);
    return { body: Buffer.from(await r.arrayBuffer()), etag: strongTag(r.headers.get('etag')), meta: metaFrom(r.headers) };
  }

  async head(key) {
    const r = await this.req('HEAD', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S3 HEAD ${key}: ${r.status}`);
    return { etag: strongTag(r.headers.get('etag')), meta: metaFrom(r.headers), size: +r.headers.get('content-length') };
  }

  // Conditional put: ifMatch = etag (replace only that version), ifNoneMatch = true (create only).
  // Returns { ok, etag, conflict }
  async put(key, body, { contentType = 'application/octet-stream', meta = {}, ifMatch, ifNoneMatch, timeout } = {}) {
    const headers = { 'content-type': contentType };
    for (const [k, v] of Object.entries(meta)) headers[`x-amz-meta-${k}`] = String(v);
    if (ifMatch) headers['if-match'] = strongTag(ifMatch);
    if (ifNoneMatch) headers['if-none-match'] = '*';
    const r = await this.req('PUT', key, { body, headers, timeout: timeout || 120000 });
    if (r.status === 412 || r.status === 409) return { ok: false, conflict: true, status: r.status };
    if (!r.ok) throw new Error(`S3 PUT ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return { ok: true, etag: strongTag(r.headers.get('etag')) };
  }

  async del(key) {
    const r = await this.req('DELETE', key);
    if (!r.ok && r.status !== 404) throw new Error(`S3 DELETE ${key}: ${r.status}`);
  }

  // Every object whose key starts with prefix: [{ key, size }] (ListObjectsV2, page by page)
  async list(prefix, { timeout = 30000 } = {}) {
    const out = [];
    let token = null;
    do {
      const q = new URLSearchParams({ 'list-type': '2', prefix: this.prefix + prefix, ...(token ? { 'continuation-token': token } : {}) });
      const r = await this.client.fetch(`${this.base}?${q}`, { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error(`S3 LIST ${prefix}: ${r.status}`);
      const xml = await r.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = unxml(/<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1] || '');
        if (key.startsWith(this.prefix)) out.push({ key: key.slice(this.prefix.length), size: +(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] || 0) });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] || '') || null : null;
    } while (token);
    return out;
  }
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Cloudflare's edge marks ETags weak (W/"…") when it compresses a response, but conditional writes
// only match the strong form. We ask for uncompressed responses and strip the W/ just in case.
const strongTag = (t) => (t ? String(t).replace(/^W\//, '') : t);

function metaFrom(h) {
  const meta = {};
  h.forEach((v, k) => { if (k.startsWith('x-amz-meta-')) meta[k.slice(11)] = v; });
  return meta;
}
