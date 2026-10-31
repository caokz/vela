// 扩展图标生成：assets/icons/icon{16,32,48,128}.png（另可 --preview 出 512 预览图到 dist/）。
// 图形取自 src/ui/brand.js（船帆 logo 单一来源）：对角渐变圆角方块底 + 白色船帆。
// 零依赖：路径解析（M/L/C/Z，三次贝塞尔细分成折线）+ 偶奇规则多边形填充 + 4x4 超采样抗锯齿 +
// 手写 PNG 编码（zlib deflate + CRC32）。
// 16px 去掉四角星（小尺寸下只剩一两个灰像素，像脏点），并整体放大、下移半格居中。
// 运行：node scripts/make-icons.mjs [--preview]
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGO_SAIL_MAIN, LOGO_SAIL_JIB, LOGO_HULL, LOGO_STAR, BRAND_GRADIENT } from '../src/ui/brand.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];
const CORNER = 0.23; // 圆角半径占边长比例
const MARK_SCALE = 0.8; // 标识在 24 视口内的缩放：四周留白，避免贴边
const MARK_SCALE_16 = 1.0; // 16px 工具栏图标：去星后标识放大占满，否则帆与帆的缝糊成一片
const SS = 4;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const [C0, C1] = BRAND_GRADIENT.map(hex);

// ---- 路径 → 折线多边形 ----
function parsePath(d) {
  const tok = d.match(/[MLCZ]|-?\d*\.?\d+/g);
  const polys = [];
  let cur = null;
  let i = 0;
  let x = 0;
  let y = 0;
  const num = () => Number(tok[i++]);
  while (i < tok.length) {
    const c = tok[i++];
    if (c === 'M') { x = num(); y = num(); cur = [[x, y]]; polys.push(cur); }
    else if (c === 'L') { x = num(); y = num(); cur.push([x, y]); }
    else if (c === 'C') {
      const [x1, y1, x2, y2, x3, y3] = [num(), num(), num(), num(), num(), num()];
      for (let k = 1; k <= 24; k++) {
        const t = k / 24;
        const u = 1 - t;
        cur.push([
          u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
      x = x3; y = y3;
    } else if (c === 'Z') { /* 多边形天然闭合 */ }
  }
  return polys;
}

function inside(px, py, poly) {
  let hit = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a];
    const [xb, yb] = poly[b];
    if ((ya > py) !== (yb > py) && px < ((xb - xa) * (py - ya)) / (yb - ya) + xa) hit = !hit;
  }
  return hit;
}

// ---- 渲染 ----
function render(size) {
  const paths = size <= 16 ? [LOGO_SAIL_MAIN, LOGO_SAIL_JIB, LOGO_HULL] : [LOGO_SAIL_MAIN, LOGO_SAIL_JIB, LOGO_HULL, LOGO_STAR];
  const polys = paths.flatMap(parsePath);
  const scale = size <= 16 ? MARK_SCALE_16 : MARK_SCALE;
  const dy = size <= 16 ? -0.6 : 0; // 去星后标识重心偏下，上提居中
  const u = size / 24;
  const r = size * CORNER;
  const half = size / 2;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const qx = Math.abs(px - half) - (half - r);
          const qy = Math.abs(py - half) - (half - r);
          const inBg = (qx <= 0 || qy <= 0) ? (qx <= r && qy <= r) : qx * qx + qy * qy <= r * r;
          if (!inBg) continue;
          bg++;
          // 像素 → 24 视口（以中心缩放 MARK_SCALE）
          const vx = (px / u - 12) / scale + 12;
          const vy = (py / u - 12) / scale + 12 - dy;
          if (polys.some((p) => inside(vx, vy, p))) fg++;
        }
      }
      const o = (y * size + x) * 4;
      if (!bg) continue;
      const t = Math.min(1, Math.max(0, (x + y) / (2 * size))); // 左上 → 右下
      const base = C0.map((c, k) => c + (C1[k] - c) * t);
      const f = fg / bg;
      rgba[o] = Math.round(base[0] + (255 - base[0]) * f);
      rgba[o + 1] = Math.round(base[1] + (255 - base[1]) * f);
      rgba[o + 2] = Math.round(base[2] + (255 - base[2]) * f);
      rgba[o + 3] = Math.round((255 * bg) / (SS * SS));
    }
  }
  return encodePng(size, rgba);
}

// ---- PNG 编码 ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
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
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv.includes('--preview')) {
  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  const f = join(ROOT, 'dist', 'icon-preview-512.png');
  writeFileSync(f, render(512));
  console.log(f);
} else {
  const out = join(ROOT, 'assets', 'icons');
  mkdirSync(out, { recursive: true });
  for (const size of SIZES) {
    const png = render(size);
    writeFileSync(join(out, `icon${size}.png`), png);
    console.log(`icon${size}.png  ${png.length} bytes`);
  }
}
