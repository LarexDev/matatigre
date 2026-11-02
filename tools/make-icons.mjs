#!/usr/bin/env node
/**
 * Renderiza extension/icons/logo.svg a icon{16,32,48,128}.png con un Chromium headless (fondo transparente).
 *   node tools/make-icons.mjs        (XAF_BROWSER=ruta para elegir navegador; Edge o Chrome)
 * Sin dependencias: habla CDP por WebSocket (Node ≥ 22).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const OUT = process.env.XAF_OUT || ICONS;                                   // carpeta de salida (vista previa)
const SIZES = (process.env.XAF_SIZES || '16,32,48,128').split(',').map(Number);
const BROWSER = process.env.XAF_BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
if (!BROWSER) { console.error('No se encontró Edge ni Chrome'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const svg = await readFile(join(ICONS, 'logo.svg'), 'utf8');
const profile = mkdtempSync(join(tmpdir(), 'mt-icons-'));
const port = 9800 + Math.floor(Math.random() * 150);
const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });

try {
    let targets;
    for (let i = 0; i < 60 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(250); } }
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

    for (const size of SIZES) {
        await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
        await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        const html = `<!doctype html><body style="margin:0;background:transparent">${svg.replace(/width="128" height="128"/, `width="${size}" height="${size}"`)}</body>`;
        await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
        await sleep(400);
        const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
        await writeFile(join(OUT, `icon${size}.png`), Buffer.from(shot.data, 'base64'));
        console.log(`icon${size}.png`);
    }
    ws.close();
} finally {
    proc.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* perfil bloqueado en Windows */ }
}
