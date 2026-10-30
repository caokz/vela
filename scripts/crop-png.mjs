// 裁剪 + 整数倍放大 PNG（无依赖：zlib inflate 解码 / deflate 编码，最近邻放大）。
// 用法：node scripts/crop-png.mjs <in.png> <out.png> <x0> <y0> <x1> <y1> [scale]
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

const [inPath, outPath, x0s, y0s, x1s, y1s, scaleS] = process.argv.slice(2);
const x0 = +x0s, y0 = +y0s, x1 = +x1s, y1 = +y1s, scale = +(scaleS ?? 1);

function decode(buf) {
  let off = 8, idat = [], w = 0, h = 0, ch = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    const d = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ch = d[9] === 6 ? 4 : 3; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch, px = Buffer.alloc(w * h * ch);
  let in_ = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[in_++], row = raw.subarray(in_, (in_ += stride)), prev = y ? px.subarray((y - 1) * w * ch, y * w * ch) : null, dst = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? dst[x - ch] : 0, b = prev ? prev[x] : 0, c = prev && x >= ch ? prev[x - ch] : 0;
      dst[x] = f === 0 ? row[x] : f === 1 ? row[x] + a : f === 2 ? row[x] + b : f === 3 ? row[x] + ((a + b) >> 1) : row[x] + paeth(a, b, c);
    }
  }
  return { w, h, ch, px };
  function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
}

const tbl = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = tbl[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

const src = decode(readFileSync(inPath));
const cw = x1 - x0, chh = y1 - y0;
const W = cw * scale, H = chh * scale, ch = src.ch;
const stride = W * ch;
const rows = Buffer.alloc((stride + 1) * H);
for (let y = 0; y < H; y++) {
  rows[y * (stride + 1)] = 0;
  const sy = y0 + Math.floor(y / scale);
  for (let x = 0; x < W; x++) {
    const sx = x0 + Math.floor(x / scale);
    const so = (sy * src.w + sx) * ch, do_ = y * (stride + 1) + 1 + x * ch;
    for (let k = 0; k < ch; k++) rows[do_ + k] = src.px[so + k];
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = ch === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
writeFileSync(outPath, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(rows, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log(`已写 ${outPath} ${W}x${H}`);
