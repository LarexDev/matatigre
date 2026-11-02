#!/usr/bin/env node
/**
 * Prueba de extremo a extremo con la extensión REAL cargada en Chrome (headless).
 *   node tests/e2e-chrome.mjs
 * Chrome sirve http://x.com:<puerto>/ desde un servidor local (host-resolver-rules), de modo que el
 * content script del manifest se inyecta de verdad. Comprueba: carga de la extensión, service worker,
 * siembra del almacenamiento, ocultamiento en la página y cambios de configuración en caliente.
 */
import { createTestServer } from './serve.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const CHROME = process.env.XAF_BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
if (!CHROME) { console.error('Chrome no encontrado'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = createTestServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const DEBUG = 9333 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'xaf-e2e-'));

const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`,
    `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
    `--host-resolver-rules=MAP x.com 127.0.0.1:${PORT}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: process.env.XAF_DEBUG ? 'inherit' : 'ignore' });

const results = [];
const problems = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

async function cdp(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map();
    ws.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        else if (m.method === 'Runtime.exceptionThrown') problems.push(`excepción: ${(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).replaceAll('\n', ' | ')}`);
        else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`console.error: ${m.params.args.map(a => a.value || a.description).join(' ')}`);
    };
    return {
        send: (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }),
        async eval(expression) {
            const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
            return r.result.result.value;
        },
        close: () => ws.close()
    };
}

let exitCode = 0;
try {
    let targets;
    for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json(); break; } catch { await sleep(250); } }
    if (!targets) throw new Error('Chrome no arrancó');
    if (process.env.XAF_DEBUG) console.log(targets.map(t => `${t.type} ${t.url}`));

    // service worker de la extensión
    let sw;
    for (let i = 0; i < 40 && !sw; i++) {
        targets = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
        sw = targets.find(t => t.type === 'service_worker' && t.url.endsWith('/background/service-worker.js'));
        if (!sw) await sleep(250);
    }
    check('la extensión carga y su service worker arranca', !!sw);
    const manifestName = await (await cdp(sw.webSocketDebuggerUrl)).eval('chrome.runtime.getManifest().name');
    check('nombre de la extensión: MATATIGRE V.1', manifestName === 'MATATIGRE V.1', manifestName);
    const extId = sw && new URL(sw.url).host;

    const swc = await cdp(sw.webSocketDebuggerUrl);
    await swc.send('Runtime.enable');
    let seedMeta = null;
    for (let i = 0; i < 40 && !seedMeta; i++) {
        seedMeta = await swc.eval(`chrome.storage.local.get('seedMeta').then(s => s.seedMeta || null)`);
        if (!seedMeta) await sleep(250);
    }
    check('onInstalled carga la lista inicial', !!seedMeta, JSON.stringify(seedMeta));
    // lista de prueba propia: el e2e no depende de ninguna lista personal
    await swc.eval(`chrome.storage.local.set({
        accounts: { listadauno: { handle: 'ListadaUno', enabled: true, tags: ['demo'] }, listadados: { handle: 'ListadaDos', enabled: true, tags: ['demo'] } },
        lists: { demo: true }
    })`);
    swc.close();

    // página "x.com" con el content script real
    const page = await (await fetch(`http://127.0.0.1:${DEBUG}/json/new?${encodeURI(`http://x.com:${PORT}/tests/x-like.html`)}`, { method: 'PUT' })).json();
    const p = await cdp(page.webSocketDebuggerUrl);
    await p.send('Runtime.enable');
    await sleep(1500);
    await p.eval('addCases()');
    await sleep(400);
    const state = await p.eval('state()');
    const by = Object.fromEntries(state.map(s => [s.handle, s.visible]));
    check('ListadaUno (lista de prueba) oculto en el DOM nuevo sin data-testid', by.ListadaUno === false, JSON.stringify(by));
    check('cuenta no listada visible', by.neutral === true);
    check('cuenta que no está en la lista, visible', by.ajenouno === true);

    // la API real (MAIN world) quita lo que corresponde antes de que la página lo reciba
    for (const via of ['fetch', 'xhr']) {
        const ids = await p.eval(`api('${via}')`);
        check(`API ${via}: se quitan autor listado, cita a listado y repost de listado`, JSON.stringify(ids) === JSON.stringify(['tweet-2', 'cursor-bottom-1']), JSON.stringify(ids));
    }
    const diag = await p.eval(`(async () => { await new Promise(r => setTimeout(r, 900)); return window.__matatigre && window.__matatigre.diag; })()`);
    check('el script de página (mundo MAIN) está activo y sin errores', diag && diag.graphql >= 2 && diag.dropped >= 6 && diag.errors === 0, JSON.stringify(diag && { g: diag.graphql, d: diag.dropped, e: diag.errors }));

    // cambio en caliente de la configuración desde el service worker (como haría el popup/opciones)
    const swc2 = await cdp(sw.webSocketDebuggerUrl);
    await swc2.eval(`chrome.storage.local.get('settings').then(s => chrome.storage.local.set({ settings: { ...(s.settings||{}), enabled: false } }))`);
    await sleep(500);
    check('desactivar desde el almacenamiento muestra todo', (await p.eval('state()')).every(s => s.visible));
    await swc2.eval(`chrome.storage.local.get('settings').then(s => chrome.storage.local.set({ settings: { ...(s.settings||{}), enabled: true } }))`);
    await sleep(500);
    check('reactivar vuelve a ocultar', (await p.eval('state()')).find(s => s.handle === 'ListadaUno').visible === false);

    // popup y opciones se cargan como páginas de la extensión sin errores
    for (const rel of ['popup/popup.html', 'options/options.html']) {
        const t = await (await fetch(`http://127.0.0.1:${DEBUG}/json/new?${encodeURI(`chrome-extension://${extId}/${rel}`)}`, { method: 'PUT' })).json();
        const c = await cdp(t.webSocketDebuggerUrl);
        await c.send('Runtime.enable');
        await sleep(1200);
        const ok = await c.eval(`document.title.length > 0 && !!document.querySelector('#enabled')`);
        const info = rel.startsWith('options') ? await c.eval(`document.getElementById('count').textContent`) : await c.eval(`document.getElementById('accounts').textContent`);
        check(`${rel} se renderiza`, ok, info);
        c.close();
    }
    p.close(); swc2.close();
} catch (e) {
    console.error('ERROR', e);
    exitCode = 1;
} finally {
    chrome.kill();
    server.close();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* perfil bloqueado en Windows */ }
}
for (const p of problems) console.log('  ! ' + p);
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} OK`);
process.exit(exitCode || (failed ? 1 : 0));
