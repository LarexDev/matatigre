#!/usr/bin/env node
/**
 * Genera las capturas de docs/img/ con Chrome REAL y la extensión REAL cargada (sin datos personales).
 *   npm run screenshots        (XAF_CHROME=ruta para elegir otro Chrome)
 *
 * - Carga una copia temporal de extension/ y un catálogo de listas de demostración (cuentas ficticias) servido en local.
 * - Pasos de instalación: capturas reales de chrome://extensions (con anotaciones numeradas).
 * - Modos, popup y opciones: la extensión corriendo sobre tools/demo/feed.html, servido como "x.com".
 * Usa Extensions.loadUnpacked por tubería (Chrome ≥ 136 con --enable-unsafe-extension-debugging).
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
const DEMO_LISTS = {
    ruido: {
        name: 'Ruido', description: 'Cuentas que prefiero no ver.', recommended: true,
        accounts: [{ handle: 'ejemplo_uno', name: 'Ejemplo Uno' }, { handle: 'ejemplo_dos', name: 'Ejemplo Dos' }, { handle: 'ejemplo_tres' }, { handle: 'cuenta_ruidosa' }, { handle: 'viral_demo' }]
    },
    promociones: {
        name: 'Promociones', description: 'Sorteos, ofertas y cuentas de marketing.', recommended: true,
        accounts: [{ handle: 'promo_sorteos', name: 'Sorteos Hoy' }, { handle: 'tienda_demo' }]
    },
    'mi-lista': {
        name: 'Mi lista', description: 'Cuentas de ejemplo.', recommended: false,
        accounts: [{ handle: 'cuenta_ruidosa' }, { handle: 'fan_club_demo' }]
    }
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
cpSync(join(ROOT, 'extension'), extDir, { recursive: true });
mkdirSync(IMG, { recursive: true });

// Catálogo de demostración con CORS abierto, como lo serviría GitHub.
const listsServer = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', 'application/json');
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/index.json') {
        return res.end(JSON.stringify({
            schema: 1, name: 'Catálogo de demostración', updated: '2026-11-08', withdrawn: [],
            lists: Object.entries(DEMO_LISTS).map(([id, l]) => ({ id, name: l.name, description: l.description, path: 'listas/' + id + '.json', count: l.accounts.length, recommended: l.recommended }))
        }));
    }
    const id = (/^\/listas\/([a-z-]+)\.json$/.exec(path) || [])[1];
    if (id && DEMO_LISTS[id]) return res.end(JSON.stringify({ schema: 1, id, name: DEMO_LISTS[id].name, description: DEMO_LISTS[id].description, version: '2026-11-08.1', updated: '2026-11-08', accounts: DEMO_LISTS[id].accounts }));
    res.writeHead(404); res.end('{}');
});
await new Promise(r => listsServer.listen(0, '127.0.0.1', r));
const LPORT = listsServer.address().port;

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
        // el panel lateral de Chrome con avisos propios (agentes, tienda…) no pinta nada en la captura: se oculta
        const RE = /agentes de programaci/i;
        const hide = root => { for (const e of root.querySelectorAll('*')) { if (e.shadowRoot) hide(e.shadowRoot); if (RE.test(e.textContent || '') && ![...e.children].some(c => RE.test(c.textContent || ''))) e.style.setProperty('display', 'none', 'important'); } };
        hide(m);
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
    await setStore({ catalogUrl: `http://127.0.0.1:${LPORT}/index.json` });

    // Bienvenida (catálogo de demostración) y suscripción real a las listas
    console.log('Bienvenida');
    const welcome = await open(`chrome-extension://${EXT}/welcome/welcome.html`, { width: 760, height: 900 });
    await sleep(2200);
    const wh = await welcome.eval(`Math.min(Math.ceil(document.documentElement.getBoundingClientRect().height), 1100)`);
    await send('Emulation.setDeviceMetricsOverride', { width: 760, height: wh, deviceScaleFactor: 1, mobile: false }, welcome.sessionId);
    await sleep(300);
    await welcome.shot('bienvenida.png', { width: 760, height: wh });
    await welcome.eval(`document.querySelectorAll('.item input')[2].click(); document.getElementById('go').click()`);
    await sleep(2500);
    await welcome.close();
    await setStore({ lists: { ruido: true, promociones: true, 'mi-lista': false }, rules: DEMO_RULES, allowlist: ['amigo_demo'], stats: DEMO_STATS, disabled: ['ejemplo_tres'], myLists: { favoritas: { name: 'Favoritas', created: 1 }, sorteos: { name: 'Sorteos', created: 2 }, 'para-revisar': { name: 'Para revisar', created: 3 } },
        accounts: {
            cuenta_antigua_demo: { handle: 'cuenta_antigua_demo', name: '', tags: ['favoritas', 'sorteos'], note: 'Ya no publica', enabled: false, source: 'manual', touched: true },
            tienda_ofertas: { handle: 'tienda_ofertas', name: 'Tienda Ofertas', tags: ['sorteos'], note: '', enabled: true, source: 'manual', touched: true },
            fan_club_viral: { handle: 'fan_club_viral', name: 'Fan Club Viral', tags: ['favoritas'], note: 'Siempre responde a lo mismo', enabled: true, source: 'manual', touched: true },
            noticias_falsas_demo: { handle: 'noticias_falsas_demo', name: '', tags: ['favoritas'], note: '', enabled: true, source: 'manual', touched: true },
            cuenta_sin_lista_demo: { handle: 'cuenta_sin_lista_demo', name: '', tags: [], note: '', enabled: true, source: 'manual', touched: true }
        } });

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
    // la insignia se muestra con el ratón sobre la publicación (se simula con una clase para la captura)
    await feed.eval(`(() => { const a = [...document.querySelectorAll('article')].filter(x => x.getClientRects().length)[1]; const st = document.createElement('style'); st.textContent = '.matatigre-badge{opacity:.9!important}'; document.head.append(st); a.querySelector('[data-xaf-badge]').click(); document.querySelector('#matatigre-card input[type=checkbox]') && document.querySelector('#matatigre-card input[type=checkbox]').click(); })()`);
    await sleep(300);
    await feed.shot('feed-anadir.png');
    await feed.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

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
    // observaciones de demostración (todo ficticio) para el radar: un grupo que publica el mismo texto en segundos y ruido orgánico
    {
        const targets = (await send('Target.getTargets')).result.targetInfos;
        const swT = targets.find(t => t.type === 'service_worker' && t.url.includes('/background/service-worker.js'));
        const att = await send('Target.attachToTarget', { targetId: swT.targetId, flatten: true });
        const swSession = att.result.sessionId;
        const base = Date.now() - 3 * 3600000;
        const TXT = 'Oferta increíble solo por hoy: el nuevo producto que todo el mundo quiere ya está disponible, entra al enlace y no te quedes sin el tuyo';
        const WORDS = 'casa perro tiempo ciudad semana mañana verdad pueblo camino noche historia mundo trabajo familia dinero calle música cielo montaña río amigo libro viaje fuerza palabra razón futuro'.split(' ');
        let seed = 11;
        const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
        const batch = [];
        for (let i = 0; i < 5; i++) batch.push({ k: 'post', id: String(8000 + i), t: base + i * 7000, a: { id: String(5000 + i), h: 'voz_demo_' + (i + 1) }, tx: TXT, lg: 'es', rel: ['m'] });
        for (let i = 0; i < 30; i++) batch.push({ k: 'post', id: String(8100 + i), t: base + Math.floor(rnd() * 150) * 60000, a: { id: String(6000 + i), h: 'persona_demo_' + (i + 1) }, tx: Array.from({ length: 14 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' '), lg: 'es', rel: ['m'] });
        // las mismas 5 cuentas responden 9 veces cada una a una misma cuenta de la lista de demostración
        for (let i = 0; i < 5; i++) for (let j = 0; j < 9; j++) batch.push({ k: 'reply', id: String(8300 + i * 20 + j), t: base + (12 + j * 11 + i) * 60000, a: { id: String(5000 + i), h: 'voz_demo_' + (i + 1) }, tid: '8200', tau: { id: '7001', h: 'ejemplo_uno' }, rh: 'ejemplo_uno', tx: Array.from({ length: 12 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' '), lg: 'es', rel: ['p'] });
        // escenario ficticio más amplio: dos grupos que se coordinan en horas distintas, cuentas de las listas y ruido orgánico
        const sentence = n => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
        const base2 = Date.now() - 46 * 3600000, HOUR = 3600000;
        const LISTED = [['7001', 'ejemplo_uno'], ['7002', 'ejemplo_dos'], ['7003', 'ejemplo_tres']];
        let nid = 20000;
        for (const [id, h] of LISTED) for (let k = 0; k < 6; k++) batch.push({ k: 'post', id: String(nid++), t: base2 + k * 7 * HOUR + Math.floor(rnd() * HOUR), a: { id, h }, tx: sentence(15), lg: 'es', rel: ['a'] });
        const group = (prefix, firstId, n, events, startOffset, gap, step) => {
            for (let e = 0; e < events; e++) {
                const text = sentence(18), t0 = base2 + startOffset + e * step;
                for (let i = 0; i < n; i++) batch.push({ k: 'post', id: String(nid++), t: t0 + i * gap + Math.floor(rnd() * 3000), a: { id: String(firstId + i), h: prefix + (i + 1) }, tx: text, lg: 'es', rel: ['m'], tags: e % 2 ? ['pais', 'verdad', 'ahora'] : [] });
            }
        };
        group('voz_demo_', 5000, 5, 7, 1 * HOUR, 8000, 6 * HOUR);
        group('eco_demo_', 5100, 6, 6, 4 * HOUR, 11000, 7 * HOUR);
        for (let i = 0; i < 6; i++) for (let j = 0; j < 8; j++) batch.push({ k: 'reply', id: String(nid++), t: base2 + (3 + j * 5 + i * 0.4) * HOUR, a: { id: String(5100 + i), h: 'eco_demo_' + (i + 1) }, tid: '8300', tau: { id: '7002', h: 'ejemplo_dos' }, rh: 'ejemplo_dos', tx: sentence(12), lg: 'es', rel: ['p'] });
        for (let i = 0; i < 40; i++) for (let j = 0; j < 1 + Math.floor(rnd() * 3); j++) batch.push({ k: 'reply', id: String(nid++), t: base2 + Math.floor(rnd() * 44 * HOUR), a: { id: String(6000 + i % 30), h: 'persona_demo_' + ((i % 30) + 1) }, tid: String(8400 + i), tau: { id: LISTED[i % 3][0], h: LISTED[i % 3][1] }, rh: LISTED[i % 3][1], tx: sentence(13), lg: 'es', rel: ['p'] });
        for (let j = 0; j < 5; j++) batch.push({ k: 'reply', id: String(nid++), t: base2 + (10 + j) * HOUR, a: { id: '5000', h: 'voz_demo_1' }, tid: '8500', tau: { id: '5100', h: 'eco_demo_1' }, rh: 'eco_demo_1', tx: sentence(12), lg: 'es', rel: ['w'] });
        await send('Runtime.evaluate', { expression: `XAF.ingest.ingestBatch(${JSON.stringify(batch)}, Date.now())`, awaitPromise: true }, swSession);
        await send('Runtime.evaluate', { expression: "chrome.storage.local.set({ settings: { enabled: true, mode: 'hide', observe: true } }); chrome.storage.local.set({ topics: [{ id: 't1', name: 'Oferta y producto', words: ['oferta', 'producto*', 'enlace'] }, { id: 't2', name: 'Familia y trabajo', words: ['familia', 'trabajo', 'dinero'] }] })", awaitPromise: true }, swSession);
    }
    await opt.reload();
    await sleep(1800);
    const tabs = [['lists:own', 'opciones-listas.png'], ['lists:sub', 'opciones-sincronizada.png'], ['lists:all', 'opciones-cuentas.png'], ['analysis:summary', 'opciones-analisis.png'], ['analysis:map', 'opciones-mapa.png'], ['analysis:narr', 'opciones-narrativas.png'], ['analysis:detail', 'opciones-detalle.png'], ['analysis:topics', 'opciones-temas.png'], ['rules', 'opciones-reglas.png'], ['settings', 'opciones-ajustes.png'], ['stats', 'opciones-estadisticas.png']];
    let analyzed = false;
    for (const [t, file] of tabs) {
        await send('Target.activateTarget', { targetId: opt.targetId });
        const [tabName, view] = t.split(':');
        await opt.eval(`document.querySelector('[data-tab="${tabName}"]').click()`);
        await sleep(500);
        if (tabName === 'lists' && view) {
            const pick = view === 'own' ? "{ kind: 'own', id: 'favoritas' }" : view === 'sub' ? "{ kind: 'sub', id: 'ruido' }" : "{ kind: 'all' }";
            await opt.eval(`ListsView.select(${pick})`);
            await sleep(400);
        }
        if (tabName === 'analysis') {
            // al abrir la pestaña el análisis arranca solo; se espera a que termine
            for (let i = 0; i < 60 && !analyzed; i++) { await sleep(300); analyzed = await opt.eval(`/publicaciones de/.test(document.getElementById('anInfo').textContent)`); }
            await opt.eval(`document.querySelector('#anNav [data-pane="${view === 'detail' ? 'map' : view}"]').click()`);
            await sleep(view === 'map' || view === 'detail' ? 1500 : 900);
            if (view === 'detail') await opt.eval(`(() => { const i = document.getElementById('gFind'); i.value = '@voz_demo_1'; i.dispatchEvent(new Event('change')); })()`);
            if (view === 'map') await opt.eval(`(async () => { const m = AnalysisTab.debug().map; if (m) { m.reset(); await new Promise(r => setTimeout(r, 600)); } })()`);
            await sleep(500);
            await opt.eval(`window.scrollTo(0, 0)`);
        }
        const cap = tabName === 'analysis' ? (view === 'map' ? 1750 : view === 'detail' ? 900 : 1500) : 900;
        const h = await opt.eval(`Math.min(Math.ceil(document.documentElement.getBoundingClientRect().height), ${cap})`);
        await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: h, deviceScaleFactor: 1, mobile: false }, opt.sessionId);
        await sleep(400);
        await opt.shot(file, { width: 1100, height: h });
        if (tabName === 'analysis') await opt.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    }
    // modo oscuro: la misma pantalla con la apariencia forzada
    await send('Target.activateTarget', { targetId: opt.targetId });
    await opt.eval(`document.querySelector('[data-tab="lists"]').click(); ListsView.select({ kind: 'own', id: 'favoritas' }); document.querySelector('#themeSeg [data-theme="dark"]').click()`);
    await sleep(700);
    const hd = await opt.eval(`Math.min(Math.ceil(document.documentElement.getBoundingClientRect().height), 900)`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: hd, deviceScaleFactor: 1, mobile: false }, opt.sessionId);
    await sleep(300);
    await opt.shot('opciones-oscuro.png', { width: 1100, height: hd });
    // y el análisis en oscuro: el mapa y los gráficos toman los colores del tema
    await opt.eval(`document.querySelector('[data-tab="analysis"]').click(); document.querySelector('#anNav [data-pane="topics"]').click()`);
    await sleep(1200);
    const ha = await opt.eval(`Math.min(Math.ceil(document.documentElement.getBoundingClientRect().height), 1100)`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: ha, deviceScaleFactor: 1, mobile: false }, opt.sessionId);
    await sleep(500);
    await opt.shot('opciones-oscuro-analisis.png', { width: 1100, height: ha });
    await opt.eval(`document.querySelector('#themeSeg [data-theme="auto"]').click()`);
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
    listsServer.close();
    await sleep(600);
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* perfil bloqueado en Windows */ }
}
