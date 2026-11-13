#!/usr/bin/env node
/**
 * Servidor estático mínimo para las pruebas en navegador. Además de servir archivos, hace "eco" de
 * cualquier POST (devuelve el cuerpo tal cual): las pruebas lo usan para simular respuestas GraphQL de X.
 *   node tests/serve.mjs [puerto]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css', '.json': 'application/json' };

/** `routes`: { '/ruta': 'archivo/relativo/a/la/raíz' } para servir páginas de demostración en rutas "de X" (p. ej. /home). */
export function createTestServer(routes = {}) {
    return createServer(async (req, res) => {
        try {
            if (req.method === 'POST') {
                const chunks = [];
                for await (const c of req) chunks.push(c);
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(Buffer.concat(chunks));
                return;
            }
            const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
            const path = join(ROOT, routes[pathname] || pathname);
            if (!path.startsWith(ROOT)) throw new Error('fuera de la raíz');
            const body = await readFile(path);
            res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
            res.end(body);
        } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const port = Number(process.argv[2]) || 8765;
    createTestServer().listen(port, '127.0.0.1', () => {
        console.log(`http://127.0.0.1:${port}/tests/dom-fixture.html   (resultado en el título: PASS n/n)`);
        console.log(`http://127.0.0.1:${port}/tests/ui-harness.html?page=options|popup`);
    });
}
