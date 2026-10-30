// 一次性：生成扩展签名密钥并把公钥写进 manifest.json 的 key 字段。
// 未打包安装的扩展 ID 默认由源码目录绝对路径哈希而来——目录改名/搬家后 ID 变，
// chrome.storage.local 里的设置（供应商 API key 等）全部丢失。manifest 带 key 后
// ID 固定为公钥哈希，换目录重装仍是同一扩展，storage 保留。
// 私钥存 scripts/dev-key.pem（已 .gitignore，绝不能进仓库/发布包）。
// 不能放仓库根目录：扩展以根目录整体加载，Chrome 扫描扩展根下的 .pem 会告警
//「此扩展程序包含密钥文件」，子目录不扫描。
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.key) {
  console.log('manifest 已有 key，不重复生成。当前 ID 由既有 key 决定。');
  process.exit(0);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
// 扩展 ID = SHA256(SPKI DER) 前 16 字节映射 a-p（Chrome 算法）
const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey)));
const id = hash.slice(0, 16).map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 0xf))).join('');

manifest.key = Buffer.from(publicKey).toString('base64');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(root, 'scripts', 'dev-key.pem'), privateKey);
console.log('已写入 manifest.key，固定扩展 ID =', id);
console.log('私钥已存 scripts/dev-key.pem（.gitignore 排除，勿外传勿删除——丢了 ID 就变）');
