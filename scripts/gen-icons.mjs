// 重新生成扩展图标 assets/icons/icon{16,32,48,128}.png：紫底圆角方块 + 白色 V。
// 零依赖：手写 PNG 编码（IHDR/IDAT/IEND + zlib deflate + CRC32）。
// V 笔画与 src/ui/shell.js ICONS.logo 同形（24 视口两段斜线底部收尖，纯 V，
// 不带外侧竖线——旧字形两根通高竖线 + 中间下尖，视觉上是字母 M）。
// 右笔末端甩出一颗收笔圆点：通用字母 V 变成独有字形，规避与 Venmo/Vimeo
// 等纯 V 图标的近似。两处（生成器 + shell.js）必须同步改。
// 运行：node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZES = [16, 32, 48, 128];
const BG = [0x68, 0x41, 0xea];
const FG = [0xff, 0xff, 0xff];
const CORNER = 0.22; // 圆角半径占边长比例
const SS = 4;        // 每像素 4x4 超采样抗锯齿

// CRC32（PNG chunk 用），多项式 0xedb88320
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

// 24 单位视口里的 V：两段斜线在 (12,18) 底部收尖，圆头（stroke 距离场判定）
const STROKE = 2.8;
const SEGS = [
  [5, 6, 12, 18],
  [12, 18, 19, 6],
];
// 收笔圆点：沿右笔方向甩出，与笔端留 ~0.7 单位缺口；已核在圆角内侧
const DOT = { x: 20.9, y: 2.7, r: 1.7 };

function segDist(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
}

function render(size) {
  const u = size / 24; // 视口单位 → 像素
  const r = size * CORNER;
  const half = size / 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      let bgHit = 0;
      let fgHit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          // 圆角方块：角外为透明
          const qx = Math.abs(px - half) - (half - r);
          const qy = Math.abs(py - half) - (half - r);
          const inBg = qx <= 0 && qy <= 0 ? true : qx > 0 && qy > 0 && qx * qx + qy * qy <= r * r;
          if (!inBg) continue;
          bgHit++;
          const vx = px / u;
          const vy = py / u;
          if (Math.min(...SEGS.map((s) => segDist(vx, vy, s))) <= STROKE / 2) fgHit++;
          if (Math.hypot(vx - DOT.x, vy - DOT.y) <= DOT.r) fgHit++;
        }
      }
      const o = 1 + x * 4;
      if (bgHit === 0) {
        row.fill(0, o, o + 4);
        continue;
      }
      const a = bgHit / (SS * SS);
      const f = fgHit / bgHit; // V 覆盖占比（在方块内混合白）
      row[o] = Math.round(BG[0] + (FG[0] - BG[0]) * f);
      row[o + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * f);
      row[o + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * f);
      row[o + 3] = Math.round(255 * a);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icons');
for (const size of SIZES) {
  const png = render(size);
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`${file}  ${png.length} bytes`);
}
