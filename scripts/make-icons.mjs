// 图标生成：零依赖 PNG 编码器（zlib.deflateSync + 手写 CRC32）。
// 图形：圆角方块渐变底 + 白色 V 位图字。node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icons');
mkdirSync(OUT, { recursive: true });

// ---- PNG 编码 ----
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 图形 ----
// V 位图 7x7
const GLYPH = [
  'X...X',
  'X...X',
  'X...X',
  'X...X',
  'X...X',
  '.X.X.',
  '..X..',
].map((r) => r.split(''));
// 7 列位图存成 5 宽 → 补齐为方阵
GLYPH.forEach((r) => r.push('.', '.'));

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // 圆角半径
  const glyphBox = { x0: size * 0.24, y0: size * 0.24, x1: size * 0.76, y1: size * 0.76 };
  const cell = (glyphBox.x1 - glyphBox.x0) / 7;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // 圆角方块内测试
      const cx = Math.max(r, Math.min(px, size - r));
      const cy = Math.max(r, Math.min(py, size - r));
      const insideRect = px >= 0 && px < size && py >= 0 && py < size;
      const inCorner = (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
      if (!insideRect || !inCorner) continue;
      // 垂直渐变 #0969da → #58a6ff
      const t = y / size;
      const cr = Math.round(0x09 + (0x58 - 0x09) * t);
      const cg = Math.round(0x69 + (0xa6 - 0x69) * t);
      const cb = Math.round(0xda + (0xff - 0xda) * t);
      // M 字形
      const gx = Math.floor((px - glyphBox.x0) / cell);
      const gy = Math.floor((py - glyphBox.y0) / cell);
      const onGlyph =
        gx >= 0 && gx < 7 && gy >= 0 && gy < 7 && GLYPH[gy][gx] === 'X';
      const i = (y * size + x) * 4;
      if (onGlyph) {
        buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255;
      } else {
        buf[i] = cr; buf[i + 1] = cg; buf[i + 2] = cb; buf[i + 3] = 255;
      }
    }
  }
  return buf;
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${size}.png`), encodePng(size, draw(size)));
  console.log(`icon${size}.png`);
}
