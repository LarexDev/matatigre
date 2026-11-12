#!/usr/bin/env node
/**
 * Revisión estática, sin dependencias: atrapa errores que las pruebas tardan en ver.
 *   1. Todo el JavaScript de la extensión (salvo vendor/) compila.
 *   2. Cada id que un script pide al documento (\`$('id')\`, \`getElementById('id')\`) existe en el HTML de su página, o se crea en el propio
 *      código (\`id: 'x'\`), o se declara aquí como creado a propósito. Así no se quedan referencias a elementos que se quitaron.
 *   3. Cada \`<script src>\` y \`<link href>\` de las páginas apunta a un archivo que existe.
 * Uso: node tools/check.mjs   (también forma parte de \`npm test\`)
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const problems = [];

function walk(dir) {
    return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === 'vendor' ? [] : walk(p)) : [p]; });
}
const rel = p => relative(ROOT, p).split(sep).join('/');

// 1 · sintaxis
const js = walk(EXT).filter(f => f.endsWith('.js'));
for (const f of js) {
    try { new vm.Script(readFileSync(f, 'utf8'), { filename: rel(f) }); } catch (e) { problems.push(`${rel(f)}: no compila (${e.message})`); }
}

// 2 y 3 · páginas y sus scripts
const pages = walk(EXT).filter(f => f.endsWith('.html'));
const ids = src => [...src.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map(m => m[1]);
for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    const have = new Set(ids(html));
    const refs = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)].map(m => m[1]);
    const scripts = [];
    for (const r of refs) {
        if (/^https?:/.test(r)) { problems.push(`${rel(page)}: carga algo de internet (${r})`); continue; }
        const target = join(dirname(page), r);
        if (!existsSync(target)) { problems.push(`${rel(page)}: no existe ${r}`); continue; }
        if (r.endsWith('.js')) scripts.push(target);
    }
    // los ids creados desde el propio código (id: 'x', id = 'x') cuentan como existentes
    const made = new Set();
    for (const s of scripts) { const src = readFileSync(s, 'utf8'); for (const m of src.matchAll(/\bid\s*[:=]\s*'([A-Za-z][\w-]*)'/g)) made.add(m[1]); }
    for (const s of scripts) {
        const src = readFileSync(s, 'utf8');
        for (const m of src.matchAll(/(?:\$|getElementById)\(\s*'([A-Za-z][\w-]*)'\s*\)/g)) {
            if (!have.has(m[1]) && !made.has(m[1])) problems.push(`${rel(s)}: pide el elemento «${m[1]}», que no está en ${rel(page)}`);
        }
    }
}

// 4 · vocabulario: palabras de ingeniería que no deben llegar a la persona que usa la extensión (ver docs/LENGUAJE.md)
const BANNED = [[/\bHandle\b/, 'usa «nombre de usuario» o «@usuario»'], [/\(E[0-3]\)/, 'los niveles se escriben con palabras (Coincidencia, Coordinación probable…)'], [/\bWorker\b/, 'es un detalle interno'], [/\bFDR\b/, 'explica el efecto, no la sigla'], [/\bIndexedDB\b/, 'es un detalle interno'], [/\[object /, 'se pasó un objeto donde iba texto']];
const STR = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const visibleSources = [];
for (const f of walk(EXT)) {
    const r = rel(f);
    if (!/^extension\/(popup|options|welcome)\//.test(r) && r !== 'extension/src/content.js') continue;
    const src = readFileSync(f, 'utf8');
    if (f.endsWith('.html')) visibleSources.push([r, src.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]*>/g, ' ')]);
    else if (f.endsWith('.js')) visibleSources.push([r, (src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[ \t])\/\/.*$/gm, '$1').match(STR) || []).join('\n')]);
}
for (const [r, text] of visibleSources) for (const [re, why] of BANNED) { const m = text.match(re); if (m) problems.push(`${r}: el texto visible contiene «${m[0]}» (${why})`); }

if (problems.length) { console.error(problems.map(p => '✗ ' + p).join('\n')); process.exit(1); }
console.log(`Revisión estática: ${js.length} archivos JavaScript compilan y los ${pages.length} documentos HTML son coherentes con sus scripts.`);
