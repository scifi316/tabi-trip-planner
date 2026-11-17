// Read the pixel size of a JPEG, PNG or WebP from its header, without decoding it.
// Returns { type: 'jpg' | 'png' | 'webp' | 'gif', width, height } or null.
export function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 30) return null;

  // PNG: signature, then the IHDR chunk
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF (chat uploads keep their animation): logical screen size right after the signature
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
    return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // JPEG: walk the markers to the first start-of-frame
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { type: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }

  // WebP: RIFF container with a VP8, VP8L or VP8X chunk first
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf[20] === 0x2f) {
      const b = buf.readUInt32LE(21);
      return { type: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return { type: 'webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
  }
  return null;
}
