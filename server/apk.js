// The Android app, as uploaded by an admin. An APK is a zip file; CI puts assets/tabi-app.json in it
// with the version and the fingerprint of the key that signed it. Only that one small file is read.
import zlib from 'node:zlib';

export const APK_MAX = 60 * 1024 * 1024;
export const APP_PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const CERT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

// One file out of a zip, or null. Reads the central directory at the end, then that entry.
export function readZipEntry(buf, name) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return null;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (entry !== name) continue;
    if (usize > 64 * 1024 || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) { try { return zlib.inflateRawSync(data, { maxOutputLength: 64 * 1024 }); } catch { return null; } }
    return null;
  }
  return null;
}

// { package, versionName, versionCode, cert, test, host, commit, builtAt } or an error message
export function appInfo(buf) {
  if (!buf || buf.length < 100 || buf.readUInt32LE(0) !== 0x04034b50) return { error: 'That isn’t an APK file.' };
  const raw = readZipEntry(buf, 'assets/tabi-app.json');
  if (!raw) return { error: 'That APK wasn’t built by Tabi’s build (it has no version information). Use the APK from the android-build release on GitHub.' };
  let j;
  try { j = JSON.parse(raw.toString('utf8')); } catch { return { error: 'The version information in that APK can’t be read.' }; }
  const info = {
    package: String(j.package || ''), versionName: String(j.versionName || '').slice(0, 20), versionCode: Math.floor(+j.versionCode),
    cert: String(j.cert || '').toUpperCase(), test: j.test === true, host: String(j.host || '').slice(0, 200),
    commit: String(j.commit || '').slice(0, 12), builtAt: String(j.builtAt || '').slice(0, 30),
  };
  if (!APP_PACKAGE.test(info.package) || !/^\d+(\.\d+){0,3}$/.test(info.versionName) || !(info.versionCode > 0) || !CERT.test(info.cert)) {
    return { error: 'The version information in that APK is incomplete.' };
  }
  return info;
}

// What the site publishes so Android trusts the app with its links (full screen, no address bar)
export function assetLinks(info) {
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: info.package, sha256_cert_fingerprints: [info.cert] },
  }];
}
