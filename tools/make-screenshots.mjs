#!/usr/bin/env node
/**
 * Genera las capturas de docs/img/ con Chrome REAL y la extensión REAL cargada (sin datos personales).
 *   npm run screenshots        (XAF_CHROME=ruta para elegir otro Chrome)
 *
 * - Carga una copia temporal de extension/ cuya lista inicial es de demostración (cuentas ficticias).
 * - Pasos de instalación: capturas reales de chrome://extensions (con anotaciones numeradas).
 * - Modos, popup y opciones: la extensión corriendo sobre tools/demo/feed.html, servido como "x.com".
 * Usa Extensions.loadUnpacked por tubería (Chrome ≥ 136 con --enable-unsafe-extension-debugging).
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestServer } from '../tests/serve.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMG = join(ROOT, 'docs', 'img');
const CHROME = process.env.XAF_CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(existsSync);
if (!CHROME) { console.error('No se encontró Chrome (XAF_CHROME=ruta)'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- lista de demostración (todo ficticio) ----------
const DEMO_SEED = {
    generatedAt: 'demo',
    lists: {
        ruido: { label: 'Ruido', description: 'Cuentas que prefiero no ver.', enabledByDefault: true },
        promociones: { label: 'Promociones', description: 'Sorteos, ofertas y cuentas de marketing.', enabledByDefault: true },
        'mi-lista': { label: 'Mi lista', description: 'Lista personalizada.', enabledByDefault: false }
    },
    accounts: [
        { handle: 'ejemplo_uno', name: 'Ejemplo Uno', tags: ['ruido'], enabled: true },
        { handle: 'ejemplo_dos', name: 'Ejemplo Dos', tags: ['ruido'], enabled: true },
        { handle: 'ejemplo_tres', tags: ['ruido'], enabled: false },
        { handle: 'promo_sorteos', name: 'Sorteos Hoy', tags: ['promociones'], enabled: true },
        { handle: 'tienda_demo', tags: ['promociones'], enabled: true },
        { handle: 'cuenta_ruidosa', tags: ['ruido', 'mi-lista'], enabled: true },
        { handle: 'fan_club_demo', tags: ['mi-lista'], enabled: true },
        { handle: 'viral_demo', tags: ['ruido'], enabled: true }
    ]
};
const DEMO_RULES = [
    { id: 'r1', kind: 'handle', mode: 'glob', pattern: 'bot_*', note: 'Cuentas automáticas', enabled: true },
    { id: 'r2', kind: 'text', mode: 'contains', pattern: 'sorteo urgente', note: 'Sorteos spam', enabled: true },
    { id: 'r3', kind: 'bio', mode: 'contains', pattern: 'vendo seguidores', note: 'Venta de seguidores', enabled: true },
    { id: 'r4', kind: 'lang', mode: 'glob', pattern: 'ja', note: '', enabled: false }
];
const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const DEMO_STATS = {
    since: day(12), total: 312,
    byRole: { author: 148, quoted: 83, reposter: 61, text: 12, mention: 8 },
    byDay: { [day(6)]: 31, [day(5)]: 44, [day(4)]: 38, [day(3)]: 52, [day(2)]: 47, [day(1)]: 61, [day(0)]: 39 },
    byHandle: { ejemplo_uno: 96, ejemplo_dos: 71, promo_sorteos: 58, tienda_demo: 40, cuenta_ruidosa: 29, viral_demo: 18 }
};

// ---------- infraestructura ----------
const workdir = mkdtempSync(join(tmpdir(), 'mt-shots-'));
const extDir = join(workdir, 'extension');
cpSync(join(ROOT, 'extension'), extDir, { recursive: true, filter: src => !src.endsWith('accounts.local.json') });
writeFileSync(join(extDir, 'data', 'accounts.json'), JSON.stringify(DEMO_SEED));
mkdirSync(IMG, { recursive: true });

const server = createTestServer({ '/home': 'tools/demo/feed.html' });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${join(workdir, 'profile')}`,
    `--host-resolver-rules=MAP x.com 127.0.0.1:${PORT}`, '--hide-scrollbars', '--lang=es-419', '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

let nextId = 0, buf = '';
const pending = new Map();
proc.stdio[4].on('data', d => {
    buf += d.toString();
    for (let i; (i = buf.indexOf('\0')) >= 0;) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
});
const send = (method, params = {}, sessionId) => new Promise(res => {
    const id = ++nextId;
    pending.set(id, res);
    proc.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});

/** Abre una pestaña con tamaño y escala dados y devuelve un manejador mínimo. */
async function open(url, { width = 1280, height = 720, scale = 1, before } = {}) {
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);   // necesario para addScriptToEvaluateOnNewDocument
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
    if (before) await send('Page.addScriptToEvaluateOnNewDocument', { source: before }, sessionId);
    await send('Page.navigate', { url }, sessionId);
    const tab = {
        targetId, sessionId,
        async eval(expression) {
            const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
            if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
            return r.result?.result?.value;
        },
        async shot(name, clip) {
            await send('Target.activateTarget', { targetId });   // una pestaña en segundo plano no pinta
            await sleep(250);
            const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { x: 0, y: 0, scale: 1, ...clip } } : {}) }, sessionId);
            writeFileSync(join(IMG, name), Buffer.from(r.result.data, 'base64'));
            console.log(' ', name);
        },
        reload: () => send('Page.reload', {}, sessionId),
        close: () => send('Target.closeTarget', { targetId })
    };
    return tab;
}

/** Superpone un aro rojo y una insignia numerada sobre un elemento (que puede estar en un shadow DOM). */
const annotate = (finder, n) => `(() => {
    const el = (${finder})();
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const ring = document.createElement('div');
    ring.className = '__mt_ann';
    ring.style.cssText = 'position:fixed;z-index:999999;pointer-events:none;border:4px solid #e11d2e;border-radius:14px;box-shadow:0 0 0 4px rgba(225,29,46,.25);left:' + (r.left - 8) + 'px;top:' + (r.top - 8) + 'px;width:' + (r.width + 16) + 'px;height:' + (r.height + 16) + 'px';
    const badge = document.createElement('div');
    badge.className = '__mt_ann';
    badge.textContent = '${n}';
    badge.style.cssText = 'position:fixed;z-index:999999;pointer-events:none;width:34px;height:34px;border-radius:50%;background:#e11d2e;color:#fff;font:700 20px/34px Segoe UI,system-ui,sans-serif;text-align:center;left:' + (r.left - 30) + 'px;top:' + (r.top - 30) + 'px;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    document.body.append(ring, badge);
    return true;
})()`;
const CLEAR = `document.querySelectorAll('.__mt_ann').forEach(e => e.remove())`;
const TOOLBAR = `document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-toolbar').shadowRoot`;

try {
    // ===== 1 · Instalación: Chrome real, antes de cargar la extensión =====
    console.log('Pasos de instalación');
    const ext0 = await open('chrome://extensions', { width: 1280, height: 480 });
    await sleep(2000);
    await ext0.eval(annotate(`() => ${TOOLBAR}.querySelector('#devMode')`, 1));
    await ext0.shot('instalar-1-modo-desarrollador.png', { width: 1280, height: 140 });
    await ext0.eval(CLEAR);
    await ext0.eval(`${TOOLBAR}.querySelector('#devMode').click()`);
    await sleep(900);
    await ext0.eval(annotate(`() => ${TOOLBAR}.querySelector('#loadUnpacked')`, 2));
    await ext0.shot('instalar-2-cargar-sin-empaquetar.png', { width: 1280, height: 140 });
    await ext0.close();

    // ===== 2 · Carga real de la extensión =====
    const loaded = await send('Extensions.loadUnpacked', { path: extDir });
    const EXT = loaded.result?.id;
    if (!EXT) throw new Error('No se pudo cargar la extensión: ' + JSON.stringify(loaded));
    await sleep(1500);

    const ext1 = await open('chrome://extensions', { width: 1280, height: 520 });
    await sleep(2000);
    await ext1.eval(`(() => {
        const m = document.querySelector('extensions-manager').shadowRoot;
        m.querySelector('extensions-review-panel')?.style.setProperty('display', 'none');
    })()`);
    await sleep(300);
    await ext1.eval(annotate(`() => {
        const list = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-item-list').shadowRoot;
        return [...list.querySelectorAll('extensions-item')].find(i => /MATATIGRE/.test(i.shadowRoot.textContent))?.shadowRoot.querySelector('#card') || null;
    }`, 3));
    await ext1.shot('instalar-3-extension-instalada.png', { width: 1280, height: 360 });
    await ext1.close();

    // ===== 3 · Configuración de demostración (vía una página de la propia extensión) =====
    console.log('Configuración de demostración');
    const opt = await open(`chrome-extension://${EXT}/options/options.html`, { width: 1100, height: 760 });
    await sleep(1500);
    const setStore = obj => opt.eval(`chrome.storage.local.set(${JSON.stringify(obj)})`);
    await setStore({ rules: DEMO_RULES, allowlist: ['amigo_demo'], stats: DEMO_STATS });

    // ===== 4 · Modos sobre el feed de demostración =====
    console.log('Modos');
    const feed = await open(`http://x.com:${PORT}/home`, { width: 600, height: 810 });
    await sleep(1800);
    const mode = async (enabled, m) => {
        const cur = await opt.eval(`chrome.storage.local.get('settings').then(s => s.settings || {})`);
        await setStore({ settings: { ...cur, enabled, mode: m } });
        await sleep(800);
    };
    await mode(false, 'hide');   await feed.shot('feed-sin-filtro.png');
    await mode(true, 'hide');    await feed.shot('feed-ocultar.png');
    await mode(true, 'collapse'); await feed.shot('feed-colapsar.png');
    await mode(true, 'highlight'); await feed.shot('feed-resaltar.png');
    await mode(true, 'hide');
    await sleep(800);

    // ===== 5 · Popup real (la pestaña activa se simula apuntando al feed de demostración) =====
    console.log('Popup');
    const tabId = await opt.eval(`chrome.tabs.query({ url: '*://x.com/*' }).then(t => t[0].id)`);
    const popup = await open(`chrome-extension://${EXT}/popup/popup.html`, {
        width: 360, height: 700, scale: 2,
        before: `chrome.tabs.query = async () => [{ id: ${tabId}, url: 'https://x.com/home', active: true }];`
    });
    await sleep(2600);
    const box = await popup.eval(`(() => { const r = document.body.getBoundingClientRect(); return { width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);
    await popup.shot('popup.png', box);
    await popup.close();

    // ===== 6 · Opciones =====
    console.log('Opciones');
    await opt.reload();
    await sleep(1800);
    const tabs = [['accounts', 'opciones-cuentas.png'], ['rules', 'opciones-reglas.png'], ['settings', 'opciones-ajustes.png'], ['stats', 'opciones-estadisticas.png']];
    for (const [t, file] of tabs) {
        await send('Target.activateTarget', { targetId: opt.targetId });
        await opt.eval(`document.querySelector('[data-tab="${t}"]').click()`);
        await sleep(500);
        const h = await opt.eval(`Math.min(Math.ceil(document.documentElement.getBoundingClientRect().height), 900)`);
        await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: h, deviceScaleFactor: 1, mobile: false }, opt.sessionId);
        await sleep(300);
        await opt.shot(file, { width: 1100, height: h });
    }
    await opt.close();

    // ===== 7 · Comparativa de modos =====
    console.log('Comparativa');
    const collage = await open(`http://127.0.0.1:${PORT}/tools/demo/modes.html`, { width: 1760, height: 770 });
    await sleep(1200);
    await collage.shot('modos.png');
    await collage.close();
    console.log('Listo →', IMG);
} finally {
    proc.kill();
    server.close();
    await sleep(600);
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* perfil bloqueado en Windows */ }
}
