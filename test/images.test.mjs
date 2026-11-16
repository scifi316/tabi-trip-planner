import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from '../server/images.js';

const pad = (b, n = 40) => Buffer.concat([b, Buffer.alloc(n)]);

test('PNG size from IHDR', () => {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(320, 16); b.writeUInt32BE(240, 20);
  assert.deepEqual(imageSize(b), { type: 'png', width: 320, height: 240 });
});

test('JPEG size skips APP segments to the frame header', () => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, 0x01, 0x40, 0x02, 0x80, 0x03]); // progressive, 640 wide, 320 high
  assert.deepEqual(imageSize(pad(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]))), { type: 'jpg', width: 640, height: 320 });
});

test('WebP lossy, lossless and extended headers', () => {
  const riff = (chunk, body) => pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(chunk), Buffer.alloc(4), body]));
  const vp8 = Buffer.alloc(14); vp8[3] = 0x9d; vp8[4] = 0x01; vp8[5] = 0x2a; vp8.writeUInt16LE(320, 6); vp8.writeUInt16LE(320, 8);
  assert.deepEqual(imageSize(riff('VP8 ', vp8)), { type: 'webp', width: 320, height: 320 });
  const vp8l = Buffer.alloc(8); vp8l[0] = 0x2f; vp8l.writeUInt32LE((240 - 1) | ((240 - 1) << 14), 1);
  assert.deepEqual(imageSize(riff('VP8L', vp8l)), { type: 'webp', width: 240, height: 240 });
  const vp8x = Buffer.alloc(10); vp8x.writeUIntLE(639, 4, 3); vp8x.writeUIntLE(639, 7, 3);
  assert.deepEqual(imageSize(riff('VP8X', vp8x)), { type: 'webp', width: 640, height: 640 });
});

test('anything else is null', () => {
  assert.equal(imageSize(Buffer.from('hello world, this is definitely not an image')), null);
  assert.equal(imageSize(Buffer.alloc(5)), null);
  assert.equal(imageSize('nope'), null);
});
