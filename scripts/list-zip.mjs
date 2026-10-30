// 列 zip 条目（调试用）：node scripts/list-zip.mjs dist/xxx.zip
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const buf = readFileSync(path);
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
const count = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
const names = [];
for (let n = 0; n < count; n++) {
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const cmtLen = buf.readUInt16LE(off + 32);
  names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
  off += 46 + nameLen + extraLen + cmtLen;
}
console.log(path, names.length, 'entries');
console.log([...new Set(names.map((n) => n.split('/')[0]))].sort().join(', '));
if (process.argv.includes('-v')) console.log(names.join('\n'));
