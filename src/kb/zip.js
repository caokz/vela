// 零依赖 zip 读取（docx / xlsx / pptx 都是 zip 包）：解析中央目录，按需解压单个条目。
// 支持 store(0) 与 deflate(8)；deflate 用浏览器 / Node 自带的 DecompressionStream('deflate-raw')。
// 不支持 zip64、加密与分卷——Office 文档用不到。

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const out = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/**
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {{ names: string[], has(name): boolean, bytes(name): Promise<Uint8Array>, text(name): Promise<string> }}
 */
export function openZip(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // 末尾倒找 End of Central Directory（签名 0x06054b50，注释最长 64K）
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip / Office 文件');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const entries = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = u16(b, p + 10);
    const csize = u32(b, p + 20);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const localOff = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, csize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const bytes = async (name) => {
    const e = entries.get(name);
    if (!e) throw new Error(`zip 内没有 ${name}`);
    const lh = e.localOff;
    if (u32(b, lh) !== 0x04034b50) throw new Error('zip 本地头损坏');
    const start = lh + 30 + u16(b, lh + 26) + u16(b, lh + 28);
    const data = b.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRaw(data);
    throw new Error(`不支持的 zip 压缩方式 ${e.method}`);
  };
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    bytes,
    text: async (name) => new TextDecoder().decode(await bytes(name)),
  };
}
