#!/usr/bin/env node
/**
 * Renderiza promo/banner.html (1080×1080) a promo/banner-1080.png y promo/banner-2160.png con un Chromium headless.
 *   node tools/make-banner.mjs        (XAF_BROWSER=ruta para elegir navegador)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROMO = join(dirname(fileURLToPath(import.meta.url)), '..', 'promo');
const BROWSER = process.env.XAF_BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
if (!BROWSER) { console.error('No se encontró Edge ni Chrome'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'mt-banner-'));
const port = 9800 + Math.floor(Math.random() * 150);
const proc = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--allow-file-access-from-files', '--no-first-run', 'about:blank'], { stdio: 'ignore' });

try {
    let targets;
    for (let i = 0; i < 60 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(250); } }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

    for (const scale of [1, 2]) {
        await send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1080, deviceScaleFactor: scale, mobile: false });
        await send('Page.navigate', { url: pathToFileURL(join(PROMO, 'banner.html')).href });
        await sleep(1200);
        const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const name = `banner-${1080 * scale}.png`;
        await writeFile(join(PROMO, name), Buffer.from(shot.data, 'base64'));
        console.log(name);
    }
    ws.close();
} finally {
    proc.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* perfil bloqueado en Windows */ }
}
