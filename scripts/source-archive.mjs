import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const table = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
async function files(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) result.push(...await files(path)); else result.push(path);
  }
  return result;
}
export async function sourceArchive() {
  const paths = ['package.json', 'package-lock.json', 'tsconfig.json', 'electron-builder.yml', 'README.md', 'LICENSE.md', 'UPSTREAM.md'];
  for (const directory of ['src', 'scripts', 'test', 'assets', 'android']) paths.push(...await files(directory));
  const chunks = [], directory = []; let offset = 0, directorySize = 0;
  for (const path of paths.sort()) {
    const name = Buffer.from('Diary-source/' + path.replaceAll('\\', '/'));
    const bytes = await readFile(path), compressed = deflateRawSync(bytes), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); header.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    chunks.push(header, name, compressed); directory.push(central, name);
    offset += header.length + name.length + compressed.length; directorySize += central.length + name.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(paths.length, 8); end.writeUInt16LE(paths.length, 10);
  end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...chunks, ...directory, end]);
  await mkdir('../releases', { recursive: true });
  await writeFile('../releases/Diary-0.2.0-Source.zip', archive);
  await writeFile('dist/web/Diary-source.zip', archive);
  await writeFile('dist/web/LICENSE.txt', await readFile('LICENSE.md'));
}
