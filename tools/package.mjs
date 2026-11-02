#!/usr/bin/env node
/**
 * Empaqueta extension/ en dist/matatigre-v<versión>.zip para publicarlo en GitHub Releases.
 *   npm run build
 * - Sin dependencias (escribe el ZIP con zlib).
 * - Excluye siempre las listas personales (accounts.local.json) y cualquier archivo que no deba distribuirse.
 */
import { deflateRawSync } from 'node:zlib';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const EXCLUDE = [/accounts\.local\.json$/, /\.DS_Store$/, /Thumbs\.db$/, /\.map$/];

const manifest = JSON.parse(await readFile(join(EXT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`Versiones distintas: manifest ${manifest.version} / package.json ${pkg.version}`);

async function walk(dir) {
    const out = [];
    for (const name of await readdir(dir)) {
        const path = join(dir, name);
        if ((await stat(path)).isDirectory()) out.push(...await walk(path));
        else out.push(path);
    }
    return out;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

const files = (await walk(EXT)).filter(f => !EXCLUDE.some(re => re.test(f))).sort();
const parts = [], central = [];
let offset = 0;
const date = new Date('2026-01-01T00:00:00Z');
const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();

for (const file of files) {
    const name = Buffer.from(relative(EXT, file).split(sep).join(posix.sep));
    const data = await readFile(file);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(dosDate, 14); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + packed.length;
}

const cdSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);

await mkdir(join(ROOT, 'dist'), { recursive: true });
const out = join(ROOT, 'dist', `matatigre-v${manifest.version}.zip`);
await writeFile(out, Buffer.concat([...parts, ...central, end]));
console.log(`${out}\n${files.length} archivos`);
