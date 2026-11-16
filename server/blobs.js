// Content-addressed blob storage for receipts and screenshots.
// Always keeps a local copy; when S3/R2 is configured it is the durable copy shared by all nodes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createBlobStore(dataDir, s3) {
  const dir = path.join(dataDir, 'blobs');
  fs.mkdirSync(dir, { recursive: true });
  const local = (key) => path.join(dir, key.replace(/[^a-f0-9.]/g, ''));

  return {
    durable: !!s3,
    async put(buf, ext = 'jpg') {
      const key = `${crypto.createHash('sha256').update(buf).digest('hex')}.${ext}`;
      const file = local(key);
      if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
      if (s3) {
        const exists = await s3.head(`blobs/${key}`).catch(() => null);
        if (!exists) await s3.put(`blobs/${key}`, buf, { contentType: ext === 'png' ? 'image/png' : 'image/jpeg' });
      }
      return key;
    },
    async get(key) {
      const file = local(key);
      if (fs.existsSync(file)) return fs.readFileSync(file);
      if (!s3) return null;
      const r = await s3.get(`blobs/${key}`);
      if (!r) return null;
      fs.writeFileSync(file, r.body);
      return r.body;
    },
  };
}
