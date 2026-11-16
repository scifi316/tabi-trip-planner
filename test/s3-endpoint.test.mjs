import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEndpoint } from '../server/s3.js';

const ok = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
test('accepts common paste mistakes', () => {
  for (const v of [ok, `${ok}/`, `"${ok}"`, `  ${ok}  `, ok.replace('https://', ''), `${ok}/tabi`]) {
    assert.equal(normalizeEndpoint(v, 'tabi').endpoint, ok, v);
  }
});
test('explains real problems', () => {
  assert.match(normalizeEndpoint('', 'tabi').error, /empty/);
  assert.match(normalizeEndpoint(`${ok}/other/path`, 'tabi').error, /end at the domain/);
  assert.match(normalizeEndpoint('https://<account-id>.r2.cloudflarestorage.com', 'tabi').error, /isn't a web address/);
});
