// Las librerías incluidas no se han tocado: su huella debe coincidir con la que figura en extension/vendor/README.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const dir = new URL('../extension/vendor/', import.meta.url);
const readme = readFileSync(new URL('README.md', dir), 'utf8');
const rows = [...readme.matchAll(/\|\s*\`([^\`]+\.js)\`\s*\|[^\n]*\|\s*\`([0-9a-f]{64})\`\s*\|/g)].map(m => [m[1], m[2]]);

test('vendor: el README lista las dos librerías con su huella SHA-256', () => {
    assert.deepEqual(rows.map(r => r[0]).sort(), ['cytoscape.min.js', 'echarts.common.min.js']);
});

for (const [file, hash] of rows) {
    test('vendor: ' + file + ' no ha cambiado', () => {
        assert.equal(createHash('sha256').update(readFileSync(new URL(file, dir))).digest('hex'), hash);
    });
    test('vendor: ' + file + ' no usa eval ni new Function (política de seguridad de las extensiones)', () => {
        const src = readFileSync(new URL(file, dir), 'utf8');
        assert.ok(!/\beval\s*\(/.test(src) && !/new Function\(/.test(src));
    });
}

test('vendor: cada librería lleva su licencia', () => {
    for (const f of ['LICENSE-cytoscape.txt', 'LICENSE-echarts.txt', 'NOTICE-echarts.txt']) assert.ok(readFileSync(new URL(f, dir), 'utf8').length > 100, f);
});
