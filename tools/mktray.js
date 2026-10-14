// Writes the menu-bar template images: three stacked dots, the same glyph the
// collapsed rail uses. Template = black pixels plus alpha; macOS tints it.
const fs = require('fs');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Coverage by 4x supersampling, so the dots are not jagged at 16px.
function dots(size) {
  const S = 4;
  const u = size / 16;            // one logical pixel
  const cx = 8 * u;
  const r = 2.3 * u;
  const centres = [3.4, 8, 12.6].map((y) => y * u);
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S;
          const fy = y + (sy + 0.5) / S;
          for (const cy of centres) {
            if ((fx - cx) ** 2 + (fy - cy) ** 2 <= r * r) { hit++; break; }
          }
        }
      }
      const i = (y * size + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
      px[i + 3] = Math.round((hit / (S * S)) * 255);
    }
  }
  return px;
}

function png(size) {
  const px = dots(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = process.argv[2];
fs.writeFileSync(dir + '/trayTemplate.png', png(16));
fs.writeFileSync(dir + '/trayTemplate@2x.png', png(32));
console.log('wrote trayTemplate.png / @2x');
