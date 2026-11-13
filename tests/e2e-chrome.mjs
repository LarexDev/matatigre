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
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const CHROME = process.env.XAF_BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
if (!CHROME) { console.error('Chrome no encontrado'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Responde al diálogo propio de la página (en lugar de confirm/prompt): escribe `text` si lo hay y pulsa el último botón (o el que lleve `label`). */
const answerDialog = (page, text = null, label = null) => page.eval(`(async () => { for (let i = 0; i < 40 && !document.querySelector('dialog.mt-dialog[open]'); i++) await new Promise(r => setTimeout(r, 100)); const d = document.querySelector('dialog.mt-dialog[open]'); if (!d) return false; const inp = d.querySelector('input[type=text]'); if (inp && ${JSON.stringify(text)} !== null) inp.value = ${JSON.stringify(text)}; const bs = [...d.querySelectorAll('button')]; (${JSON.stringify(label)} ? bs.find(b => b.textContent === ${JSON.stringify(label)}) : bs[bs.length - 1]).click(); await new Promise(r => setTimeout(r, 150)); return true; })()`);
const server = createTestServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
// Servidor de listas (con CORS abierto, como GitHub) para probar suscripciones, actualizaciones y errores.
const fx = { mode: 'ok', demoB: ['ListadaDos'], versionB: '1', withdrawn: [] };
const listFile = (id, handles, version) => ({ schema: 1, id, name: 'Lista ' + id, description: 'Lista de prueba ' + id, version, updated: '2026-11-08', accounts: handles.map(handle => ({ handle })) });
const listServer = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    const path = new URL(req.url, 'http://x').pathname;
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
    if (path === '/index.json') return json({
        schema: 1, name: 'Catálogo de prueba', updated: '2026-11-08', withdrawn: fx.withdrawn,
        lists: [
            { id: 'demo-a', name: 'Lista demo-a', description: 'Primera', path: 'listas/demo-a.json', count: 1, recommended: true },
            { id: 'demo-b', name: 'Lista demo-b', description: 'Segunda', path: 'listas/demo-b.json', count: 1, recommended: true }
        ]
    });
    if (fx.mode === 'down') return json({}, 500);
    if (fx.mode === 'bad') return json('{no es json');
    const gen = /^\/gen\/(\d+)\/([a-z0-9]+)\.json$/.exec(path);
    if (gen) return json(listFile('gen-' + gen[2], Array.from({ length: Number(gen[1]) }, (_, i) => gen[2] + 'cuenta' + i), '1'));
    if (path === '/listas/demo-a.json') return json(listFile('demo-a', ['ListadaUno'], '1'));
    if (path === '/listas/demo-b.json') return json(listFile('demo-b', fx.demoB, fx.versionB));
    json({}, 404);
});
await new Promise(r => listServer.listen(0, '127.0.0.1', r));
const LPORT = listServer.address().port;
const DEBUG = 9333 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'xaf-e2e-'));
// Se prueba una copia de la extensión: el perfil y los archivos del repositorio no se tocan.
const EXT_COPY = join(profile, 'extension');
cpSync(EXT, EXT_COPY, { recursive: true });

const chrome = spawn(CHROME, [
    ...(process.env.XAF_NO_SANDBOX ? ['--no-sandbox'] : []),
    '--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`,
    `--load-extension=${EXT_COPY}`, `--disable-extensions-except=${EXT_COPY}`,
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
    check('nombre de la extensión: MATATIGRE', manifestName === 'MATATIGRE', manifestName);
    const extId = sw && new URL(sw.url).host;

    const swc = await cdp(sw.webSocketDebuggerUrl);
    await swc.send('Runtime.enable');
    const openExt = async rel => {
        const t = await (await fetch(`http://127.0.0.1:${DEBUG}/json/new?${encodeURI(`chrome-extension://${extId}/${rel}`)}`, { method: 'PUT' })).json();
        const c = await cdp(t.webSocketDebuggerUrl);
        await c.send('Runtime.enable');
        return c;
    };
    const getStore = keys => swc.eval(`chrome.storage.local.get(${JSON.stringify(keys)})`);
    const until = async (fn, tries = 40) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(250); } return null; };

    // 1. El paquete es neutro: tras instalar no hay cuentas ni suscripciones
    const fresh = await getStore(['accounts', 'subs', 'meta']);
    check('instalación limpia: sin cuentas ni suscripciones', !Object.keys(fresh.accounts || {}).length && !(fresh.subs || []).length, JSON.stringify(fresh.subs));

    // 2. Bienvenida: catálogo, listas recomendadas marcadas, "Activar y empezar" descarga y suscribe
    await swc.eval(`chrome.storage.local.set({ catalogUrl: 'http://127.0.0.1:${LPORT}/index.json' })`);
    const w = await openExt('welcome/welcome.html');
    const marks = await until(async () => { const m = await w.eval(`[...document.querySelectorAll('.item input')].map(b => b.checked)`); return m.length ? m : null; });
    check('la bienvenida muestra el catálogo con las listas recomendadas marcadas', marks && marks.length === 2 && marks.every(Boolean), JSON.stringify(marks));
    await w.eval(`document.getElementById('go').click()`);
    const st = await until(async () => { const v = await getStore(['subs', 'listData', 'lists', 'meta']); return v.subs && v.subs.length === 2 && v.meta?.welcome === 'done' ? v : null; });
    check('"Empezar" suscribe y descarga las dos listas', !!st && st.listData['demo-a']?.accounts.length === 1 && st.listData['demo-b']?.accounts.length === 1, JSON.stringify(st && st.subs));
    check('las listas elegidas quedan encendidas', st && st.lists['demo-a'] === true && st.lists['demo-b'] === true, JSON.stringify(st && st.lists));
    check('la pantalla de bienvenida confirma el resultado', await w.eval(`!document.getElementById('done').hidden`));
    w.close();

    // 3. Para las pruebas de la página se encienden las dos listas
    await swc.eval(`chrome.storage.local.set({ lists: { 'demo-a': true, 'demo-b': true } })`);
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
        const info = rel.startsWith('options') ? await c.eval(`document.getElementById('lmMain').innerText.slice(0, 40)`) : await c.eval(`document.getElementById('accounts').textContent`);
        check(`${rel} se renderiza`, ok, info);
        c.close();
    }

    // aviso de salud: con X reconocible el estado es correcto; si hay publicaciones y ninguna se puede leer, se avisa
    const tabIdOf = frag => swc2.eval(`chrome.tabs.query({}).then(ts => (ts.find(t => (t.url || '').includes('${frag}')) || {}).id)`);
    const healthOf = async frag => { const id = await tabIdOf(frag); return id == null ? null : (await swc2.eval(`chrome.tabs.sendMessage(${id}, { type: 'xaf:getState' })`)).health; };
    check('salud: con publicaciones reconocibles el filtro se declara en orden', (await healthOf('x-like.html')) === 'ok');
    const hp = await (await fetch(`http://127.0.0.1:${DEBUG}/json/new?${encodeURI(`http://x.com:${PORT}/tests/health-like.html`)}`, { method: 'PUT' })).json();
    await sleep(1500);
    check('salud: si X cambia y no se puede leer ninguna publicación, el estado es «dom» (el popup avisa)', (await healthOf('health-like.html')) === 'dom');
    await fetch(`http://127.0.0.1:${DEBUG}/json/close/${hp.id}`).catch(() => {});

    // ---------- ciclo de vida de las listas ----------
    const sync = () => swc2.eval(`XAF.lists.handle({ op: 'sync' })`);
    const visible = async h => (await p.eval('state()')).find(s => s.handle === h).visible;
    const dosShown = async () => (await p.eval("api('fetch')")).includes('tweet-5'); // ListadaDos sólo aparece en la respuesta de la API de prueba
    const setLists = lists => swc2.eval(`chrome.storage.local.set({ lists: ${JSON.stringify(lists)} })`);
    const swGet = keys => swc2.eval(`chrome.storage.local.get(${JSON.stringify(keys)})`);

    // insignia «Añadir» de la extensión real: junto al @usuario, tarjeta con listas, guarda y se puede deshacer
    const badge = await p.eval(`(() => { const a = [...document.querySelectorAll('article')].find(x => x.innerHTML.includes('/ajenouno')); const b = a && a.querySelector('[data-xaf-badge]'); return b ? { h: b.getAttribute('data-xaf-badge'), title: b.title, w: Math.round(b.getBoundingClientRect().width) } : null; })()`);
    check('insignia (extensión real): junto al usuario de una cuenta no listada', badge && badge.h === 'ajenouno' && badge.w === 22 && /ajenouno/.test(badge.title), JSON.stringify(badge));
    await swc2.eval(`chrome.storage.local.set({ myLists: { favoritas: { name: 'Favoritas', created: 1 }, vacia: { name: 'Vacía', created: 2 } }, accounts: { semilla: { handle: 'semilla', tags: ['favoritas'], enabled: true, source: 'manual', touched: true } } })`);
    await sleep(600);
    await p.eval(`[...document.querySelectorAll('article')].find(x => x.innerHTML.includes('/ajenouno')).querySelector('[data-xaf-badge]').click()`);
    const lists = await p.eval(`[...document.querySelectorAll('#matatigre-card input[type=checkbox]')].map(i => i.value)`);
    check('tarjeta: ofrece las listas propias existentes, también una lista vacía recién creada', lists.includes('favoritas') && lists.includes('vacia'), JSON.stringify(lists));
    check('tarjeta: no permite crear listas (sin campo de texto) y «Añadir» espera a que elijas una', await p.eval(`!document.querySelector('#matatigre-card input[type=text]') && document.querySelector('#matatigre-card .mt-primary').disabled === true`));
    check('tarjeta: solo muestra listas propias (no las sincronizadas, que son de solo lectura)', await p.eval(`[...document.querySelectorAll('#matatigre-card .mt-row span')].every(s => ['Favoritas', 'Vacía'].includes(s.textContent))`));
    await p.eval(`document.querySelector('#matatigre-card input[type=checkbox]').click(); document.querySelector('#matatigre-card .mt-primary').click()`);
    await sleep(500);
    const added = (await swGet(['accounts'])).accounts || {};
    check('insignia: guarda la cuenta en la lista elegida y la publicación desaparece', !!added.ajenouno && added.ajenouno.tags.join() === 'favoritas' && (await visible('ajenouno')) === false, JSON.stringify(added.ajenouno));
    await p.eval(`document.querySelector('#matatigre-toast button').click()`);
    await sleep(500);
    check('Deshacer: la cuenta vuelve a mostrarse', !((await swGet(['accounts'])).accounts || {}).ajenouno && (await visible('ajenouno')) === true);
    await swc2.eval(`chrome.storage.local.set({ accounts: {} })`);

    await setLists({ 'demo-a': true, 'demo-b': false });
    await sleep(500);
    check('apagar una lista deja de filtrar sus cuentas (ListadaDos visible, ListadaUno sigue oculta)', (await dosShown()) === true && (await visible('ListadaUno')) === false);
    await setLists({ 'demo-a': true, 'demo-b': true });
    await sleep(500);
    check('encenderla la vuelve a filtrar', (await dosShown()) === false);

    await swc2.eval(`chrome.storage.local.set({ listModes: { 'demo-a': 'highlight' } })`);
    await sleep(500);
    const modeIds = await p.eval(`api('fetch')`);
    check('modo por lista: la lista en "resaltar" se conserva y la otra (ocultar) se quita', JSON.stringify(modeIds) === JSON.stringify(['tweet-1', 'tweet-2', 'cursor-bottom-1']), JSON.stringify(modeIds));
    await swc2.eval(`chrome.storage.local.set({ listModes: {} })`);
    await sleep(400);

    fx.demoB = ['OtraCuenta']; fx.versionB = '2';
    let r = await sync();
    await sleep(500);
    check('una actualización de la lista reemplaza su contenido y el filtro lo aplica en caliente', r.updated === 1 && (await dosShown()) === true && (await swGet(['listData'])).listData['demo-b'].version === '2', JSON.stringify(r));
    const chg = (await swGet(['meta'])).meta.status['demo-b'].change;
    check('al actualizar se anota qué cambió: cuentas añadidas y quitadas', chg && chg.added === 1 && chg.removed === 1 && chg.addedList[0] === 'OtraCuenta' && chg.removedList[0] === 'ListadaDos' && chg.big === false, JSON.stringify(chg));
    r = await sync();
    check('sin cambios en el servidor, no se reescribe nada', r.updated === 0 && r.unchanged === 2, JSON.stringify(r));

    fx.demoB = ['ListadaDos']; fx.versionB = '3'; fx.mode = 'down';
    r = await sync();
    const meta2 = await swGet(['meta', 'listData']);
    check('servidor caído: se conserva la última copia buena y se anota el error', r.failed === 2 && meta2.listData['demo-b'].version === '2' && !!meta2.meta.status['demo-a'].error && (await visible('ListadaUno')) === false, JSON.stringify(r));
    fx.mode = 'bad';
    r = await sync();
    check('JSON inválido: se rechaza y se conserva la copia anterior', r.failed === 2 && (await swGet(['listData'])).listData['demo-b'].version === '2', JSON.stringify(r));
    fx.mode = 'ok';
    r = await sync();
    check('al volver el servidor, se recupera', r.updated === 1 && r.failed === 0 && (await dosShown()) === false, JSON.stringify(r));
    check('el error anterior se limpia', !(await swGet(['meta'])).meta.status['demo-a'].error);

    // migración desde 1.x: solo se retira lo que ya viene de una lista descargada y no fue tocado
    await swc2.eval(`chrome.storage.local.set({ accounts: {
        listadauno: { handle: 'ListadaUno', tags: ['demo-a'], enabled: true, source: 'seed', touched: false },
        editada: { handle: 'Editada', tags: ['demo-a'], enabled: true, source: 'seed', touched: true },
        sinlista: { handle: 'SinLista', tags: ['demo-a'], enabled: true, source: 'seed', touched: false },
        mia: { handle: 'Mia', tags: [], enabled: true, source: 'manual', touched: true } } })`);
    const legacy = await swc2.eval(`XAF.lists.handle({ op: 'legacy' })`);
    check('se detectan las cuentas de la lista inicial 1.x sin tocar', legacy.count === 2 && legacy.tags.join() === 'demo-a', JSON.stringify(legacy));
    const pr = await swc2.eval(`XAF.lists.handle({ op: 'prune' })`);
    const left = Object.keys((await swGet(['accounts'])).accounts).sort().join();
    check('la migración retira solo lo cubierto por la lista descargada (nunca pierde cuentas)', pr.removed === 1 && left === 'editada,mia,sinlista', left);
    await swc2.eval(`chrome.storage.local.set({ accounts: {} })`);

    // retirada de una lista del catálogo y baja voluntaria
    fx.withdrawn = ['demo-b'];
    r = await sync();
    const after = await swGet(['subs', 'listData']);
    check('una lista retirada del catálogo se elimina del usuario (suscripción y copia)', r.withdrawn === 1 && after.subs.length === 1 && !after.listData['demo-b'], JSON.stringify(r));
    await swc2.eval(`XAF.lists.handle({ op: 'unsubscribe', id: 'demo-a' })`);
    await sleep(500);
    check('dejar de seguir una lista vuelve visibles sus cuentas', (await visible('ListadaUno')) === true && (await swGet(['subs'])).subs.length === 0);

    // suscripción por URL propia
    const sr = await swc2.eval(`XAF.lists.handle({ op: 'subscribeUrl', url: 'http://127.0.0.1:${LPORT}/listas/demo-a.json' })`);
    check('suscripción por URL propia: descarga, valida y activa', sr.ok && /^u-[0-9a-f]{8}$/.test(sr.id) && sr.count === 1, JSON.stringify(sr));
    const bad = await swc2.eval(`XAF.lists.handle({ op: 'subscribeUrl', url: 'http://ejemplo.invalid/lista.json' }).catch(e => ({ ok: false, error: e.message }))`);
    check('una URL http que no es de la propia máquina se rechaza', bad.ok === false, JSON.stringify(bad));
    await sleep(400);
    check('la lista por URL se filtra en la página', (await visible('ListadaUno')) === false);

    // bienvenida en modo migración: marca solo las listas que el usuario ya usaba
    await swc2.eval(`chrome.storage.local.set({ accounts: { x1: { handle: 'x1', tags: ['demo-b'], enabled: true, source: 'seed', touched: false } } })`);
    const wm = await openExt('welcome/welcome.html?migrate=1');
    const mm = await until(async () => { const m = await wm.eval(`[...document.querySelectorAll('.item input')].map(b => b.checked)`); return m.length ? m : null; });
    check('bienvenida de migración: aviso visible y solo marcada la lista que ya tenías', mm && mm.join() === 'false,true' && await wm.eval(`!document.getElementById('migrateNote').hidden`), JSON.stringify(mm));
    wm.close();

    // ---------- registro local (IndexedDB) ----------
    const dbNames = () => swc2.eval(`indexedDB.databases().then(d => d.map(x => x.name))`);
    check('registro local: apagado por defecto, no se crea ninguna base de datos', !(await dbNames()).includes('matatigre'));

    await swc2.eval(`chrome.storage.local.set({ settings: { observe: true } })`);
    await sleep(500);
    await p.eval(`api('fetch')`);
    let reg = null;
    for (let i = 0; i < 20 && !(reg && reg.obs > 0); i++) { await sleep(500); reg = await swc2.eval(`registryExists().then(ok => ok ? XAF.ingest.stats() : { obs: 0 })`); }
    check('registro local (extensión real): con el registro activado, lo que X entrega llega a IndexedDB', reg && reg.obs > 0, JSON.stringify(reg));

    const DAY = 86400000;
    const ingest = (batch, now) => swc2.eval(`XAF.ingest.ingestBatch(${JSON.stringify(batch)}, ${now})`);
    const read = (store, key) => swc2.eval(`XAF.db.tx('${store}', 'readonly', s => XAF.db.reqP(s['${store}'].get(${JSON.stringify(key)})))`);
    const total = () => swc2.eval(`XAF.ingest.stats()`);
    await swc2.eval(`XAF.ingest.clear()`);
    const T0 = Date.now();

    await ingest([{ k: 'post', id: '100', t: T0 - 1000, a: { id: '1', h: 'Alfa', n: 'Alfa A', f: 5, g: 2, p: 9, bl: true }, tx: 'Texto UNO con tildes: ñandú', c: { f: 1, rt: 2 }, u: ['https://www.e.com/x?utm_source=a'], tg: ['Tema'], m: [{ h: 'Otro', id: '9' }] }], T0);
    const pa = await read('profiles', 'u:1');
    const ob = await read('obs', '100:post');
    check('ingesta: crea el perfil por id de usuario con su handle, historial y métricas', pa && pa.handle === 'Alfa' && pa.handleHistory.length === 1 && pa.metrics.followers === 5 && pa.flags.blue === true, JSON.stringify(pa));
    check('ingesta: guarda la observación con texto normalizado, huella, enlaces canónicos y menciones por id', ob && ob.textNorm === 'texto uno con tildes: nandu' && ob.th && ob.th.length === 32 && ob.urls[0] === 'e.com/x' && ob.mentions[0] === 'u:9' && ob.authorUid === 'u:1' && ob.t === T0 - 1000, JSON.stringify(ob));

    await ingest([{ k: 'post', id: '100', t: T0 - 1000, a: { id: '1', h: 'Alfa' }, tx: 'Texto UNO con tildes: ñandú', c: { f: 50, rt: 20 } }], T0 + 1000);
    const ob2 = await read('obs', '100:post');
    check('ingesta idempotente: la misma publicación no se duplica y conserva los primeros contadores', (await total()).obs === 1 && ob2.counts.f === 50 && ob2.counts0.f === 1 && ob2.firstSeen === T0, JSON.stringify(ob2.counts0));

    await ingest([{ k: 'post', id: '101', a: { id: '1', h: 'AlfaNuevo' }, tx: 'otro' }], T0 + 2000);
    const prn = await read('profiles', 'u:1');
    check('cambio de nombre: el perfil sigue siendo el mismo y se guarda el historial de handles', prn.handle === 'AlfaNuevo' && prn.handleHistory.map(h => h.h).join() === 'Alfa,AlfaNuevo' && (await total()).profiles === 1, JSON.stringify(prn.handleHistory));

    await ingest([{ k: 'post', id: '102', a: { id: '3', h: 'Beta' }, tx: 'x' }], T0 + 3000);
    await ingest([{ k: 'post', id: '103', a: { id: '4', h: 'beta' }, tx: 'y' }], T0 + 4000);
    const [p3, p4] = [await read('profiles', 'u:3'), await read('profiles', 'u:4')];
    check('reasignación: si un handle llega con otro id, se marca en ambos perfiles y no se hereda nada', p4.flags.reassignedFrom === 'u:3' && p3.flags.handleLostTo === 'u:4' && (await read('handles', 'beta')).uid === 'u:4', JSON.stringify([p3.flags, p4.flags]));

    await ingest([
        { k: 'repost', id: '104', t: T0, a: { id: '5', h: 'Repostero' }, tid: '105', tau: { id: '6', h: 'Original' }, tx: 'RT ignorado' },
        { k: 'reply', id: '106', a: { h: 'Solo_Handle' }, tid: '555', rh: 'Otro', tx: 'respuesta' }
    ], T0 + 5000);
    const rp = await read('obs', '104:repost');
    const rl = await read('obs', '106:reply');
    check('ingesta: un repost no guarda texto y enlaza con el autor original', rp && rp.targetId === '105' && rp.targetAuthorUid === 'u:6' && rp.textNorm === null && !!(await read('profiles', 'u:6')), JSON.stringify(rp));
    check('ingesta: sin id de usuario se usa un perfil provisional por handle (no se crea perfil falso)', rl && rl.authorUid === 'h:solo_handle' && rl.replyTo === 'otro' && !(await read('profiles', 'h:solo_handle')), JSON.stringify(rl));
    check('ingesta: descarta registros inválidos sin romper el lote', (await ingest([{ k: 'nada' }, null, { k: 'post', id: 'abc', a: { h: 'x' } }], T0)).obs === 0);

    // retención: texto a los N días, borrado a los M días; lo anclado a un expediente se conserva
    await ingest([{ k: 'post', id: '200', a: { id: '1', h: 'Alfa' }, tx: 'viejo de veinte dias' }], T0 - 20 * DAY);
    await ingest([{ k: 'post', id: '201', a: { id: '1', h: 'Alfa' }, tx: 'muy viejo' }], T0 - 200 * DAY);
    await ingest([{ k: 'post', id: '202', a: { id: '1', h: 'Alfa' }, tx: 'muy viejo pero anclado' }], T0 - 200 * DAY);
    await swc2.eval(`XAF.db.tx('evidence', 'readwrite', s => XAF.db.reqP(s.evidence.put({ evId: 'e1', caseId: 'c1', obsId: '202:post' })))`);
    const pg = await swc2.eval(`XAF.ingest.purge({ textDays: 14, maxDays: 180 }, ${T0})`);
    const [o200, o201, o202, o100] = [await read('obs', '200:post'), await read('obs', '201:post'), await read('obs', '202:post'), await read('obs', '100:post')];
    check('retención: el texto de lo visto hace más de N días se quita y queda la huella', pg.textStripped >= 1 && o200 && o200.textNorm === null && o200.th && o200.th.length === 32, JSON.stringify(pg));
    check('retención: lo visto hace más de M días se borra', pg.deleted >= 1 && !o201);
    check('retención: lo anclado a un expediente no se borra ni pierde su texto', o202 && o202.textNorm === 'muy viejo pero anclado');
    check('retención: lo reciente no se toca', o100 && o100.textNorm && o100.textNorm.startsWith('texto uno'));
    const cap = await swc2.eval(`XAF.ingest.purge({ textDays: 14, maxDays: 1000, maxObs: 3 }, ${T0})`);
    const remaining = await total();
    check('retención: el tope de observaciones borra lo más antiguo salvo lo anclado', remaining.obs <= 4 && !!(await read('obs', '202:post')), JSON.stringify([cap, remaining.obs]));

    // interfaz: el ajuste se activa desde Opciones y se puede borrar el registro
    const optPage = await openExt('options/options.html');
    await sleep(1200);
    await optPage.eval(`document.querySelector('[data-tab="settings"]').click(); document.getElementById('sObserve').checked = false; document.getElementById('sObserve').click();`);
    await sleep(500);
    check('opciones: el registro se activa desde Ajustes y el plazo del texto se guarda', (await swGet(['settings'])).settings.observe === true && (await swGet(['settings'])).settings.keepTextDays === 14);
    await optPage.eval(`document.querySelector('[data-tab="data"]').click(); document.getElementById('obsClear').click()`);
    check('borrar el registro pide confirmación con un diálogo propio', await answerDialog(optPage));
    await sleep(800);
    check('opciones: "Borrar registro" deja el registro vacío', (await total()).obs === 0 && (await total()).profiles === 0);
    optPage.close();
    await swc2.eval(`chrome.storage.local.set({ settings: { observe: false } })`);

    // pausa con vuelta automática
    const pz = await swc2.eval(`pauseFilter(30)`);
    const pst = await swGet(['settings', 'pauseUntil']);
    check('pausa: el filtrado se pausa y queda programada su vuelta', pz.until > Date.now() && pst.settings.enabled === false && pst.pauseUntil === pz.until && !!(await swc2.eval(`chrome.alarms.get('matatigre-resume')`)), JSON.stringify(pst.pauseUntil));
    await swc2.eval(`chrome.storage.local.set({ pauseUntil: Date.now() - 1000 })`);
    const back = await swc2.eval(`resumeIfDue()`);
    const pst2 = await swGet(['settings', 'pauseUntil']);
    check('pausa: al vencer vuelve a activarse sola', back === true && pst2.settings.enabled === true && pst2.pauseUntil === undefined);
    await swc2.eval(`pauseFilter(30)`);
    await swc2.eval(`XAF.store.load().then(c => XAF.store.save({ settings: { ...c.settings, enabled: true } }))`);
    await sleep(600);
    check('pausa: encender el filtrado a mano cancela la pausa', (await swGet(['pauseUntil'])).pauseUntil === undefined && !(await swc2.eval(`chrome.alarms.get('matatigre-resume')`)));
    const pop = await openExt('popup/popup.html');
    await sleep(900);
    check('popup: ofrece pausar el filtrado un tiempo (10 min, 1 h, 12 h)', await pop.eval(`!document.getElementById('pauseFor').hidden && [...document.getElementById('pauseFor').options].map(o => o.value).join() === ',10,60,720'`));
    await pop.eval(`(() => { const s = document.getElementById('pauseFor'); s.value = '60'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(900);
    check('popup: al pausar dice hasta qué hora y oculta el selector', await pop.eval(`/Pausado hasta las [0-9]{2}:[0-9]{2}/.test(document.getElementById('status').textContent) && document.getElementById('pauseFor').hidden`), await pop.eval(`document.getElementById('status').textContent + '|' + document.getElementById('pauseFor').hidden + '|' + document.getElementById('enabled').checked`));
    pop.close();
    await swc2.eval(`resumeIfDue(); chrome.storage.local.set({ pauseUntil: Date.now() - 1 }).then(() => resumeIfDue())`);
    await sleep(600);

    // perfiles de un clic en Ajustes
    const pf = await openExt('options/options.html');
    await sleep(1200);
    await pf.eval(`document.querySelector('[data-tab="settings"]').click(); document.querySelector('#profileSeg [data-profile="strict"]').click()`);
    await sleep(500);
    const strict = (await swGet(['settings'])).settings;
    check('perfiles: «Estricto» oculta también respuestas y menciones', strict.mode === 'hide' && strict.filterReplies === true && strict.filterMentions === true && await pf.eval(`document.querySelector('#profileSeg [data-profile="strict"]').getAttribute('aria-pressed') === 'true'`), JSON.stringify([strict.mode, strict.filterReplies, strict.filterMentions]));
    await pf.eval(`document.querySelector('#profileSeg [data-profile="mark"]').click()`);
    await sleep(500);
    check('perfiles: «Solo marcar» resalta en lugar de ocultar', (await swGet(['settings'])).settings.mode === 'highlight');
    await pf.eval(`document.getElementById('sMentions').click()`);
    await sleep(500);
    check('perfiles: tocar un ajuste a mano lo deja como «Personalizado»', /Personalizado/.test(await pf.eval(`document.getElementById('profileHint').textContent`)));
    await pf.eval(`document.querySelector('#profileSeg [data-profile="moderate"]').click()`);
    await sleep(500);
    pf.close();
    await swc2.eval(`chrome.storage.local.get('settings').then(s => chrome.storage.local.set({ settings: { ...(s.settings || {}), mode: 'hide', enabled: true } }))`);
    await sleep(400);

    // modo analista: la pestaña Análisis y los ajustes del registro solo existen cuando se activa
    const ap = await openExt('options/options.html');
    await sleep(1200);
    check('modo analista apagado: no hay pestaña Análisis ni ajustes del registro', await ap.eval(`document.querySelector('[data-tab="analysis"]').hidden === true && document.getElementById('analystOpts').hidden === true && document.getElementById('sAnalyst').checked === false`));
    await ap.eval(`location.hash = '#analysis'`);
    await sleep(400);
    check('modo analista apagado: abrir #analysis lleva a Listas', await ap.eval(`!document.getElementById('tab-lists').hidden && document.getElementById('tab-analysis').hidden`));
    await ap.eval(`document.querySelector('[data-tab="settings"]').click(); document.getElementById('sAnalyst').click()`);
    await sleep(500);
    const asettings = (await swGet(['settings'])).settings;
    check('modo analista: al activarlo aparece Análisis y se enciende el registro', asettings.analyst === true && asettings.observe === true && await ap.eval(`!document.querySelector('[data-tab="analysis"]').hidden && !document.getElementById('analystOpts').hidden`), JSON.stringify(asettings));
    check('modo analista: el registro solo corre con el modo activo (aunque el registro quede encendido)', await swc2.eval(`XAF.captureOn({ observe: true, analyst: false }) === false && XAF.captureOn({ observe: true, analyst: true }) === true`));
    ap.close();
    await swc2.eval(`chrome.storage.local.set({ settings: { observe: false } })`);

    // límites de las listas sincronizadas: tamaño total y número de listas
    const genUrl = (n, tag) => `http://127.0.0.1:${LPORT}/gen/${n}/${tag}`.concat('.json');
    const subscribe = url => swc2.eval(`XAF.lists.handle({ op: 'subscribeUrl', url: ${JSON.stringify(url)} }).then(x => ({ ok: true, count: x.count })).catch(e => ({ ok: false, error: e.message }))`);
    await swc2.eval(`chrome.storage.local.set({ subs: [], listData: {}, lists: {} })`);
    const big = [];
    for (let i = 0; i < 5; i++) big.push(await subscribe(genUrl(5000, 'g' + i)));
    check('límites: caben cinco listas de 5 000 cuentas (25 000 en total)', big.every(x => x.ok && x.count === 5000), JSON.stringify(big));
    const over = await subscribe(genUrl(100, 'extra'));
    check('límites: una lista que supera el total de cuentas sincronizadas se rechaza con un mensaje claro', !over.ok && /límite de 25.000/.test(over.error) && (await swGet(['subs'])).subs.length === 5, JSON.stringify(over));
    await swc2.eval(`chrome.storage.local.set({ subs: [], listData: {}, lists: {} })`);
    let lastSub = null;
    for (let i = 0; i < 31; i++) lastSub = await subscribe(genUrl(2, 't' + i));
    check('límites: no se pueden seguir más de 30 listas sincronizadas', !lastSub.ok && /Máximo 30/.test(lastSub.error) && (await swGet(['subs'])).subs.length === 30, JSON.stringify(lastSub));
    await swc2.eval(`chrome.storage.local.set({ subs: [], listData: {}, lists: {}, meta: { welcome: 'done', lastSync: 0, lastError: '' } })`);

    // ---------- gestión de listas: propias frente a sincronizadas ----------
    await swc2.eval(`chrome.storage.local.set({ meta: { welcome: 'done', lastSync: 0, lastError: '', status: { 'demo-s': { checkedAt: Date.now(), error: '', change: { added: 2, removed: 1, prev: 30, big: true, at: Date.now() - 3 * 3600000, addedList: ['sync1', 'sync2'], removedList: ['vieja'] } } } }, accounts: {}, myLists: {}, lists: {}, listModes: {}, disabled: [], allowlist: [], subs: [{ id: 'demo-s', name: 'Sincronizada demo', source: 'catalog' }], listData: { 'demo-s': { id: 'demo-s', name: 'Sincronizada demo', description: 'Lista de prueba', updated: '2026-11-08', accounts: [{ handle: 'sync1' }, { handle: 'sync2' }] } } })`);
    const lp = await openExt('options/options.html');
    await sleep(1200);
    const side = await lp.eval(`document.getElementById('lmMine').innerText + '|' + document.getElementById('lmSubs').innerText`);
    check('listas: la columna separa «Mis listas» (vacía al empezar) de las sincronizadas, que llevan candado', /Aún no tienes listas propias/.test(side) && /Sincronizada demo/.test(side) && await lp.eval(`!!document.querySelector('#lmSubs .lm-item svg.lm-ico')`), side);
    await lp.eval(`document.getElementById('lmNew').click()`);
    await answerDialog(lp, '');
    const nameErr = await lp.eval(`document.querySelector('dialog.mt-dialog .err').textContent`);
    await answerDialog(lp, 'Mi lista');
    await sleep(600);
    const st1 = await swGet(['myLists', 'lists']);
    check('listas: la lista propia exige un nombre, se crea encendida y queda seleccionada como «Propia»', /Escribe un nombre/.test(nameErr) && !!st1.myLists['mi-lista'] && st1.lists['mi-lista'] === true && /Propia/.test(await lp.eval(`document.getElementById('lmMain').innerText`)), JSON.stringify(st1));
    await lp.eval(`(() => { const i = document.querySelector('#lmMain form input'); i.value = '@Uno, https://x.com/dos, no-valida!!'; document.querySelector('#lmMain form').requestSubmit(); })()`);
    await sleep(700);
    const st2 = await swGet(['accounts']);
    check('listas: se pueden pegar varias cuentas a la vez; las no válidas se ignoran', !!st2.accounts.uno && !!st2.accounts.dos && st2.accounts.uno.tags.join() === 'mi-lista' && Object.keys(st2.accounts).length === 2, JSON.stringify(Object.keys(st2.accounts)));
    check('listas: en una lista propia cada cuenta se puede editar y quitar', await lp.eval(`[...document.querySelectorAll('#lmMain tbody tr')].length === 2 && [...document.querySelectorAll('#lmMain tbody tr')].every(r => [...r.querySelectorAll('button')].map(b => b.textContent).join() === 'Editar,Quitar')`));
    await lp.eval(`document.querySelector('#lmSubs .lm-item').click()`);
    await sleep(400);
    const subTxt = await lp.eval(`document.getElementById('lmMain').innerText`);
    const chText = await lp.eval(`(() => { const d = document.querySelector('#lmMain details.lm-changes'); if (d) d.open = true; return d ? d.innerText : ''; })()`);
    check('listas: la sincronizada muestra qué cambió en la última actualización, avisando si fue grande', /Último cambio: \+2 · −1 cuentas \(cambio grande\) · hace 3 h/.test(chText) && /@sync1/.test(chText) && /@vieja/.test(chText) && await lp.eval(`document.querySelector('#lmMain details.lm-changes').classList.contains('big')`), chText);
    check('listas: la sincronizada se presenta como solo lectura, sin formulario para añadir ni botones de edición', /Sincronizada · solo lectura/.test(subTxt) && /no se puede modificar/.test(subTxt) && await lp.eval(`!document.querySelector('#lmMain form') && ![...document.querySelectorAll('#lmMain button')].some(b => /^(Editar|Quitar|Renombrar|Eliminar lista)$/.test(b.textContent))`), subTxt.slice(0, 200));
    const listDataBefore = JSON.stringify((await swGet(['listData'])).listData);
    await lp.eval(`document.querySelector('#lmMain tbody input[type=checkbox]').click()`);
    await sleep(500);
    const st3 = await swGet(['disabled', 'listData']);
    check('listas: omitir una cuenta sincronizada solo la apaga para ti y no toca el contenido original', st3.disabled.length === 1 && JSON.stringify(st3.listData) === listDataBefore, JSON.stringify(st3.disabled));
    await lp.eval(`[...document.querySelectorAll('#lmMain button')].find(b => /Copiar a una lista mía/.test(b.textContent)).click()`);
    await answerDialog(lp);
    await sleep(700);
    const st4 = await swGet(['accounts', 'listData']);
    check('listas: copiar una lista sincronizada a una propia añade las cuentas y deja intacta la original', !!st4.accounts.sync1 && !!st4.accounts.sync2 && st4.accounts.sync1.tags.includes('mi-lista') && JSON.stringify(st4.listData) === listDataBefore);
    await lp.eval(`document.querySelector('#lmAll .lm-item').click()`);
    await sleep(400);
    const allTxt = await lp.eval(`document.getElementById('lmMain').innerText`);
    check('listas: «Todas las cuentas» reúne propias y sincronizadas con sus listas', /@uno/i.test(allTxt) && /@sync1/.test(allTxt) && /Mi lista/.test(allTxt) && /Sincronizada demo/.test(allTxt), allTxt.split(String.fromCharCode(10)).join(' | ').slice(0, 600));
    await lp.eval(`document.querySelector('#lmMine .lm-item').click()`);
    await sleep(300);
    await lp.eval(`[...document.querySelectorAll('#lmMain button')].find(b => b.textContent === 'Eliminar lista').click()`);
    await answerDialog(lp);
    await sleep(700);
    check('listas: eliminar una lista propia quita sus cuentas exclusivas y ofrece deshacer', Object.keys((await swGet(['myLists'])).myLists).length === 0 && Object.keys((await swGet(['accounts'])).accounts).length === 0 && await lp.eval(`!!document.querySelector('.mt-toast button')`));
    await lp.eval(`document.querySelector('.mt-toast button').click()`);
    await sleep(700);
    check('listas: deshacer devuelve la lista y sus cuentas', !!(await swGet(['myLists'])).myLists['mi-lista'] && Object.keys((await swGet(['accounts'])).accounts).length === 4);

    // ---------- apariencia (modo oscuro) ----------
    await lp.eval(`document.querySelector('#themeSeg [data-theme="dark"]').click()`);
    await sleep(500);
    const dark = await lp.eval(`(() => { document.querySelector('[data-tab="settings"]').click(); const num = document.getElementById('sTextDays'), cs = getComputedStyle(num); return { theme: document.documentElement.dataset.theme, scheme: getComputedStyle(document.documentElement).colorScheme, body: getComputedStyle(document.body).backgroundColor, num: cs.backgroundColor, numColor: cs.color }; })()`);
    check('modo oscuro: el ajuste fuerza el tema y los controles (número, selectores) también se oscurecen', dark.theme === 'dark' && dark.scheme === 'dark' && dark.body === 'rgb(11, 15, 20)' && dark.num === 'rgb(11, 15, 20)' && dark.numColor === 'rgb(231, 233, 234)' && (await swGet(['settings'])).settings.theme === 'dark', JSON.stringify(dark));
    await lp.eval(`document.querySelector('#themeSeg [data-theme="light"]').click()`);
    await sleep(400);
    check('modo claro: el ajuste lo fuerza aunque el sistema sea oscuro', (await lp.eval(`getComputedStyle(document.body).backgroundColor`)) === 'rgb(255, 255, 255)');
    await lp.eval(`document.querySelector('#themeSeg [data-theme="auto"]').click()`);
    await sleep(300);
    lp.close();
    await swc2.eval(`chrome.storage.local.set({ accounts: {}, myLists: {}, lists: {}, subs: [], listData: {}, disabled: [] })`);

    // ---------- ids de usuario aprendidos ----------
    await swc2.eval(`chrome.storage.local.set({ accounts: { listadauno: { handle: 'ListadaUno', tags: [], enabled: true, source: 'manual', touched: true } }, uids: { fantasma: '9' } })`);
    await swc2.eval(`learnIds([{ h: 'ListadaUno', id: '7001' }, { h: 'NoConfigurada', id: '5' }, { h: 'ListadaUno', id: 'abc' }])`);
    const ids1 = (await swGet(['uids'])).uids;
    check('ids: se aprende el id de una cuenta configurada, se ignoran las no configuradas y se poda lo que ya no existe', ids1.listadauno === '7001' && !('noconfigurada' in ids1) && !('fantasma' in ids1), JSON.stringify(ids1));
    await swc2.eval(`learnIds([{ h: 'ListadaUno', id: '8888' }])`);
    check('ids: un id ya conocido no se sobrescribe', (await swGet(['uids'])).uids.listadauno === '7001');
    await swc2.eval(`chrome.storage.local.set({ accounts: {}, uids: {} })`);

    // ---------- identidad observada, menú contextual y limpieza ----------
    const ev = expr => swc2.eval(expr);
    await ev(`XAF.ingest.clear()`);
    // migración v1 → v3: una base de una versión anterior, con campos escritos a mano que ya no existen
    // (otras páginas de la extensión pueden reabrir la base entre el borrado y la creación en versión 1: se reintenta)
    await ev(`XAF.ingest.exclusive(async () => {
        for (let intento = 0; intento < 8; intento++) {
            await new Promise((res, rej) => { const r = indexedDB.deleteDatabase('matatigre'); r.onsuccess = res; r.onerror = rej; });
            const hecho = await new Promise(res => { const r = indexedDB.open('matatigre', 1); r.onupgradeneeded = () => XAF.db.MIGRATIONS[0](r.result); r.onsuccess = () => { const t = r.result.transaction('profiles', 'readwrite'); t.objectStore('profiles').put({ uid: 'u:9', handle: 'vieja', labels: [{ id: 'x', at: 1, confidence: 'alta' }], notes: 'n', attrs: {}, handleHistory: [], lastSeen: 1 }); t.oncomplete = () => { r.result.close(); res(true); }; }; r.onerror = () => res(false); });
            if (hecho) return;
            await new Promise(r => setTimeout(r, 200));
        }
        throw new Error('no se pudo crear la base en versión 1');
    })`);
    const mig = await ev(`XAF.db.tx('profiles', 'readonly', async s => ({ idx: [...s.profiles.indexNames], p: await XAF.db.reqP(s.profiles.get('u:9')) }))`);
    check('migración v1 → v3: se quitan el índice y los campos escritos a mano; la identidad observada se conserva', !mig.idx.includes('labelIds') && mig.p.handle === 'vieja' && !('labels' in mig.p) && !('notes' in mig.p), JSON.stringify(mig));
    await ev(`XAF.ingest.clear()`);

    // un nombre de usuario que pasa a otra cuenta se marca; no se hereda nada
    await ev(`XAF.ingest.ingestBatch([{ k: 'post', id: '901', a: { id: '555', h: 'Alguien' }, tx: 'primero' }], Date.now())`);
    await ev(`XAF.ingest.ingestBatch([{ k: 'post', id: '902', a: { id: '666', h: 'Alguien' }, tx: 'otra persona' }], Date.now())`);
    const [pOld, pNew] = [await ev(`XAF.db.tx('profiles', 'readonly', s => XAF.db.reqP(s.profiles.get('u:555')))`), await ev(`XAF.db.tx('profiles', 'readonly', s => XAF.db.reqP(s.profiles.get('u:666')))`)];
    check('reasignación: si un nombre de usuario llega con otro id, se marca en ambas cuentas', pNew.flags.reassignedFrom === 'u:555' && pOld.flags.handleLostTo === 'u:666');
    await ev(`XAF.ingest.clear()`);

    // menú contextual (el clic se simula llamando al manejador del service worker)
    const tabId = await ev(`chrome.tabs.query({ url: '*://x.com/*' }).then(t => t[0] && t[0].id)`);
    await ev(`chrome.storage.local.set({ myLists: { favoritas: { name: 'Favoritas', created: 1 } }, accounts: { semilla: { handle: 'semilla', tags: ['favoritas'], enabled: true, source: 'manual', touched: true } } })`);
    await sleep(300);
    await ev(`buildMenu()`);
    const m1 = await ev(`handleMenuClick({ menuItemId: 'mt-list:favoritas', linkUrl: 'https://x.com/ajenouno' }, { id: ${tabId} })`);
    await sleep(600);
    const accM = (await swGet(['accounts'])).accounts || {};
    check('menú contextual: "Añadir a «lista»" sobre un enlace a un perfil añade la cuenta a esa lista', m1.ok && m1.handle === 'ajenouno' && accM.ajenouno && accM.ajenouno.tags.join() === 'favoritas', JSON.stringify([m1, accM.ajenouno]));
    await ev(`handleMenuClick({ menuItemId: 'mt-show', linkUrl: 'https://x.com/ajenouno/status/123' }, { id: ${tabId} })`);
    await sleep(600);
    check('menú contextual: "Siempre mostrar" funciona también sobre un enlace a una publicación', ((await swGet(['allowlist'])).allowlist || []).includes('ajenouno'));
    const m3 = await ev(`handleMenuClick({ menuItemId: 'mt-add', linkUrl: 'https://x.com/home' }, { id: ${tabId} })`);
    const m4 = await ev(`handleMenuClick({ menuItemId: 'mt-add', linkUrl: 'https://ejemplo.com/otra' }, { id: ${tabId} })`);
    check('menú contextual: enlaces que no son de una cuenta se ignoran', m3.ok === false && m4.ok === false);
    await ev(`chrome.storage.local.set({ accounts: {}, myLists: {}, allowlist: [] })`);

    // limpieza de la lista local «citada» de versiones anteriores
    await ev(`chrome.storage.local.set({ seedMeta: { count: 2 }, lists: { citada: false, petrista: true }, accounts: {
        c1: { handle: 'c1', tags: ['citada'], enabled: false, source: 'seed', touched: false },
        c2: { handle: 'c2', tags: ['citada'], enabled: true, source: 'seed', touched: true },
        mia: { handle: 'mia', tags: [], enabled: true, source: 'manual', touched: true } } })`);
    await ev(`cleanupLegacy()`);
    const cl = await swGet(['accounts', 'lists', 'seedMeta']);
    check('limpieza: se quitan las cuentas sin editar de la lista «citada»; lo que tocaste se conserva (y su interruptor)', !('c1' in cl.accounts) && 'c2' in cl.accounts && 'mia' in cl.accounts && 'citada' in cl.lists && !cl.seedMeta, JSON.stringify(cl));
    await ev(`chrome.storage.local.set({ accounts: { c1: { handle: 'c1', tags: ['citada'], enabled: false, source: 'seed', touched: false } } })`);
    await ev(`cleanupLegacy()`);
    check('limpieza: si ya no queda ninguna cuenta de «citada», también se quita su interruptor', !('citada' in ((await swGet(['lists'])).lists || {})));
    await ev(`chrome.storage.local.set({ accounts: {}, lists: {} })`);

    // ---------- radar de coordinación y expedientes ----------
    {
        await swc2.eval(`XAF.ingest.clear()`);
        await swc2.eval(`chrome.storage.local.set({ settings: { observe: true } })`);
        const askCase = () => swc2.eval(`XAF.cases.externals().then(e => ({ ok: true, externals: e }))`);
        const nowR = Date.now();
        const base = nowR - 2 * 3600000;
        const LONG = 'Atención a todos los colombianos: el gobierno oculta información clave sobre este tema y nadie quiere hablar del asunto en los medios tradicionales';
        const WORDS = 'casa perro tiempo ciudad gobierno semana mañana verdad pueblo camino noche historia mundo trabajo familia dinero calle música cielo montaña río amigo libro viaje fuerza palabra razón futuro'.split(' ');
        let seed = 7;
        const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
        const sentence = () => Array.from({ length: 14 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
        const batch = [];
        for (let i = 0; i < 5; i++) batch.push({ k: 'post', id: String(7000 + i), t: base + i * 8000, a: { id: String(3000 + i), h: 'cuentabodega' + i }, tx: LONG, lg: 'es', rel: ['m'] });
        for (let i = 0; i < 40; i++) batch.push({ k: 'post', id: String(7100 + i), t: base + Math.floor(rnd() * 100) * 60000, a: { id: String(4000 + i), h: 'organica' + i }, tx: sentence(), lg: 'es', rel: ['m'] });
        // las mismas 5 cuentas responden 9 veces cada una a una misma cuenta de las listas
        for (let i = 0; i < 5; i++) for (let j = 0; j < 9; j++) batch.push({ k: 'reply', id: String(7500 + i * 20 + j), t: base + (10 + j * 9 + i) * 60000, a: { id: String(3000 + i), h: 'cuentabodega' + i }, tid: '6100', tau: { id: '900', h: 'cuentalista1' }, rh: 'cuentalista1', tx: sentence(), lg: 'es', rel: ['p'] });
        await swc2.eval(`XAF.ingest.ingestBatch(${JSON.stringify(batch)}, ${nowR})`);
        const stored = await swc2.eval(`XAF.db.tx('obs', 'readonly', s => XAF.db.reqP(s.obs.get('7000:post')))`);
        check('ingesta: guarda la huella SimHash, la longitud y las palabras del texto', stored && stored.sh && stored.sh.length === 16 && stored.tl > 100 && stored.tw > 15 && stored.th.length === 32, JSON.stringify(stored && [stored.sh, stored.tl, stored.tw]));

        // segundo anillo: las 5 cuentas externas con 9 interacciones directas cada una pasan a vigilarse; las orgánicas (sin interacción) no
        const watchIds = await swc2.eval(`XAF.ingest.computeWatch()`);
        check('anillo vigilado: las externas con ≥ 3 interacciones directas con las listas se vigilan y las demás no', JSON.stringify([...watchIds].sort()) === JSON.stringify(['3000', '3001', '3002', '3003', '3004']), JSON.stringify(watchIds));
        await swc2.eval(`refreshWatch(true)`);
        const wStored = await swc2.eval(`chrome.storage.local.get('watch')`);
        check('anillo vigilado: el service worker guarda la lista aparte (sin recargar la configuración)', wStored.watch && wStored.watch.ids.length === 5, JSON.stringify(wStored));

        const an = await openExt('options/options.html');
        await sleep(1200);
        await an.eval(`document.querySelector('[data-tab="analysis"]').click()`);
        await sleep(500);
        const pane = name => an.eval(`document.querySelector('#anNav [data-pane="${name}"]').click()`);
        const dtext = () => an.eval(`document.getElementById('anDrawer').hidden ? '' : document.getElementById('anDrawer').innerText`);
        check('análisis: con el registro activado no sale el aviso de pausa', await an.eval(`document.getElementById('anNoData').hidden`));
        check('análisis: seis secciones (resumen, mapa, narrativas, temas, cuentas y expedientes)', (await an.eval(`[...document.querySelectorAll('#anNav button')].map(b => b.textContent).join()`)) === 'Resumen,Mapa,Narrativas,Temas,Cuentas,Expedientes');
        const waitInfo = async re => { let t = ''; for (let i = 0; i < 60; i++) { t = await an.eval(`document.getElementById('anInfo').textContent`); if (re.test(t)) return t; await sleep(300); } return t; };
        const infoTxt = await waitInfo(/publicaciones de/);
        check('radar: informa de cuántas observaciones y cuentas analizó (el análisis arranca al abrir la pestaña)', /90 publicaciones de 45 cuentas/.test(infoTxt), infoTxt);
        const suff = await an.eval(`(document.querySelector('#anSuff .suff') || { className: '', textContent: '' }).className + '|' + (document.querySelector('#anSuff .suff') || { textContent: '' }).textContent`);
        check('resumen: avisa de que los datos son escasos (solo 2 horas de registro)', /escasa/.test(suff) && /Datos aún escasos/.test(suff), suff);

        // análisis relacional: hallazgo, mapa y detalle con criterios y pruebas
        const fnd = await an.eval(`document.getElementById('anFindings').innerText`);
        check('hallazgos: las 5 externas que concentran su actividad en una cuenta de las listas salen como hallazgo concreto', /5 cuentas externas concentran su actividad/.test(fnd) && /@cuentabodega0/.test(fnd) && !/@organica/.test(fnd), fnd.slice(0, 240));
        await an.eval(`document.getElementById('anCalib').open = true`);
        await sleep(300);
        const calib = await an.eval(`document.getElementById('anCalibBody').innerText`);
        check('resumen: la sección «Cómo de fiable es este análisis» explica la prueba de control con los propios datos', /Prueba de control|Todavía no hay pares/.test(calib), calib.slice(0, 200));
        await pane('map');
        await sleep(900);
        const st0 = await an.eval(`AnalysisTab.debug().map ? AnalysisTab.debug().map.stats() : null`);
        check('mapa de relaciones (Cytoscape): dibuja las cuentas y las relaciones del análisis', !!st0 && st0.nodes >= 6 && st0.edges >= 5 && await an.eval(`!!document.querySelector('#anGraph canvas')`), JSON.stringify(st0));
        check('mapa: por defecto agrupa las cuentas en racimos por comunidad, sin burbujas encimadas', st0.mode === 'bubbles' && st0.halos >= 1 && st0.overlaps === 0, JSON.stringify(st0));
        const pos0 = await an.eval(`AnalysisTab.debug().map.positions()`);
        await an.eval(`(() => { const s = document.getElementById('gMode'); s.value = 'network'; s.dispatchEvent(new Event('change')); })()`);
        await sleep(900);
        check('mapa: se puede cambiar a la red de relaciones', (await an.eval(`AnalysisTab.debug().map.stats().mode`)) === 'network');
        await an.eval(`(() => { const s = document.getElementById('gMode'); s.value = 'bubbles'; s.dispatchEvent(new Event('change')); })()`);
        await sleep(900);
        check('mapa: al volver a agrupar por comunidad cada burbuja vuelve exactamente a su sitio', JSON.stringify(await an.eval(`AnalysisTab.debug().map.positions()`)) === JSON.stringify(pos0) && (await an.eval(`AnalysisTab.debug().map.stats().mode`)) === 'bubbles');
        await an.eval(`document.getElementById('gReset').click()`);
        await sleep(900);
        check('mapa: Restablecer vuelve a colocar las burbujas en su sitio', (await an.eval(`AnalysisTab.debug().map.stats()`)).overlaps === 0);
        await an.eval(`document.getElementById('gInter').click()`);
        const st1 = await an.eval(`AnalysisTab.debug().map.stats()`);
        check('mapa: el filtro de interacciones oculta las relaciones', st1.edges === 0, JSON.stringify(st1));
        await an.eval(`document.getElementById('gInter').click(); document.getElementById('gExt').click()`);
        const st2 = await an.eval(`AnalysisTab.debug().map.stats()`);
        check('mapa: ocultar las cuentas externas deja solo las de tus listas', st2.nodes >= 1 && st2.nodes < st0.nodes, JSON.stringify(st2));
        await an.eval(`document.getElementById('gExt').click()`);
        check('mapa: se puede descargar como imagen', (await an.eval(`AnalysisTab.debug().map.png()`)).startsWith('data:image/png'));
        check('mapa: todos los controles (zoom, ajustar, restablecer, pantalla completa, imagen, búsqueda, capas y modo) están dentro del cuadro', await an.eval(`['gZoomIn', 'gZoomOut', 'gFit', 'gReset', 'gFull', 'gPng', 'gFind', 'gMode', 'gInter', 'gAll', 'gCoord', 'gExt', 'gComms'].every(id => document.getElementById('graphWrap').contains(document.getElementById(id)))`));
        const z0 = await an.eval(`AnalysisTab.debug().map.stats().zoom`);
        await an.eval(`document.getElementById('gZoomIn').click()`);
        await sleep(300);
        check('mapa: el botón + acerca', (await an.eval(`AnalysisTab.debug().map.stats().zoom`)) > z0);
        await an.eval(`document.getElementById('gFull').click()`);
        await sleep(400);
        const fs = await an.eval(`(() => { const e = document.getElementById('graphWrap'), r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), iw: innerWidth, ih: innerHeight, pos: getComputedStyle(e).position }; })()`);
        check('mapa: pantalla completa ocupa toda la ventana', fs.w >= fs.iw - 24 && fs.h >= fs.ih - 2 && fs.pos === 'fixed', JSON.stringify(fs));
        await an.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await sleep(300);
        check('mapa: Esc sale de la pantalla completa', await an.eval(`!document.getElementById('graphWrap').classList.contains('full')`));
        await an.eval(`(() => { const i = document.getElementById('gFind'); i.value = '@cuentabodega0'; i.dispatchEvent(new Event('change')); })()`);
        await sleep(500);
        const ndet = await dtext();
        const st3 = await an.eval(`AnalysisTab.debug().map.stats()`);
        check('nodo: al buscar una cuenta en el mapa se abre su ficha con su lista de verificación (sin puntuación) y sus conexiones', /Conexiones principales/.test(ndet) && /publicaciones registradas/.test(ndet) && /Lista de verificación/.test(ndet) && /C1 /.test(ndet) && /C6 /.test(ndet) && !/puntuación:/i.test(ndet), ndet.slice(0, 300));
        check('mapa: la cuenta elegida queda seleccionada y el resto atenuado', !!st3.selected && st3.dimmed > 0, JSON.stringify(st3));
        await an.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        check('el panel de detalle se cierra con Esc', (await dtext()) === '');
        await pane('summary');
        await an.eval(`[...document.querySelectorAll('#anFindings button')].find(b => b.textContent === 'Ver pruebas').click()`);
        await sleep(400);
        const fdet = await dtext();
        check('hallazgo: el detalle trae los criterios, las explicaciones alternativas, las cuentas y las publicaciones de evidencia', /Por qué el sistema llegó a esta conclusión/.test(fdet) && /Explicaciones alternativas/.test(fdet) && /Interacciones totales hacia ese destino/.test(fdet) && /@cuentabodega0/.test(fdet) && /No dice quién hay detrás/.test(fdet) && /status\//.test(await an.eval(`document.getElementById('anDrawer').innerHTML`)), fdet.slice(0, 240));
        await an.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

        // narrativas: la curva de entrada con ECharts
        await pane('narr');
        await sleep(600);
        check('narrativas: cada una trae su curva de cuentas que van entrando (ECharts)', (await an.eval(`document.querySelectorAll('#anNarr .ncard').length`)) >= 1 && await an.eval(`!!document.querySelector('#anNarr .ncard canvas')`));

        // temas: definidos por la persona, con reparto por comunidad
        await pane('topics');
        await an.eval(`(() => { document.getElementById('topicName').value = 'Casa y perros'; document.getElementById('topicWords').value = 'casa, perro*, familia'; document.getElementById('topicForm').requestSubmit(); })()`);
        await sleep(600);
        check('temas: un tema nuevo se guarda con sus palabras', ((await swGet(['topics'])).topics || []).some(t => t.name === 'Casa y perros' && t.words.join() === 'casa,perro*,familia'), JSON.stringify((await swGet(['topics'])).topics));
        await an.eval(`document.getElementById('anRun').click()`);
        await sleep(2500);
        await waitInfo(/publicaciones de/);
        const topicTxt = await an.eval(`document.getElementById('anTopics').innerText`);
        check('temas: tras analizar muestra cuántas publicaciones y cuentas lo mencionan, con su gráfico', /Casa y perros/.test(topicTxt) && /publicaciones de \d+ cuentas/.test(topicTxt) && await an.eval(`!!document.querySelector('#anTopics .stackbar') && !!document.querySelector('#anTopics canvas')`), topicTxt.slice(0, 200));

        // cuentas
        await pane('accounts');
        check('comparación entre listas: la tabla está y explica el mismo criterio para todas', await an.eval(`!!document.getElementById('anLists') && /mismos umbrales/.test(document.getElementById('tab-analysis').innerText)`));
        const nodesTxt = await an.eval(`document.getElementById('anNodes').innerText`);
        check('cuentas relevantes: tabla con papel y atención recibida (y sin textos rotos)', /@cuentalista1/.test(nodesTxt) && /%/.test(nodesTxt) && !nodesTxt.includes('[object'), nodesTxt.slice(0, 160));
        await an.eval(`document.getElementById('anTech').open = true`);
        let rowsText = null;
        for (let i = 0; i < 40 && !rowsText; i++) { await sleep(300); rowsText = await an.eval(`document.querySelectorAll('#anRows tr td').length > 3 ? document.getElementById('anRows').innerText : null`); }
        check('radar (extensión real, en un Worker): encuentra el grupo que publicó el mismo texto en segundos', rowsText && /Texto · exacto/.test(rowsText) && /Coincidencia/.test(rowsText) && /I1/.test(rowsText) && /patrón compatible con comportamiento coordinado/.test(rowsText), String(rowsText).slice(0, 300));
        const nE1 = await an.eval(`[...document.querySelectorAll('#anRows tr')].filter(r => r.children[5] && r.children[5].textContent === 'Coincidencia').length`);
        check('radar: el resto de la muestra orgánica no genera ningún otro evento de nivel E1', nE1 === 1, String(nE1));

        // cuentas con señales: las 5 que responden en masa a la misma cuenta de la lista, y no las orgánicas
        const accTxt = await an.eval(`document.getElementById('anAcc').innerText`);
        check('radar: "Cuentas con señales" muestra las que responden en masa a una cuenta de las listas', /@cuentabodega0/.test(accTxt) && /@cuentabodega4/.test(accTxt) && /Respuestas repetidas al mismo objetivo/.test(accTxt) && /Amplificación concentrada/.test(accTxt) && !/@organica/.test(accTxt), accTxt.slice(0, 200));
        const intTxt = await an.eval(`document.getElementById('anInt').innerText`);
        check('radar: "Cuentas que más interactúan con tus listas" las recuenta, sin etiquetarlas', /@cuentabodega0/.test(intTxt) && /100 % a @cuentalista1/.test(intTxt), intTxt.slice(0, 160));
        await an.eval(`[...document.querySelectorAll('#anAcc button')].find(b => b.textContent === 'Ver').click()`);
        await sleep(500);
        const accDet = await dtext();
        check('cuenta con señales: detalle con las señales, la evidencia y el aviso de que no prueban intención', /Señales observadas/.test(accDet) && /No prueban que sea una cuenta organizada/.test(accDet) && /status\//.test(await an.eval(`document.getElementById('anDrawer').innerHTML`)), accDet.slice(0, 200));
        await an.eval(`(() => { const d = document.getElementById('anDrawer'); d.querySelector('select').value = '__new'; [...d.querySelectorAll('button')].find(b => b.textContent === 'Añadir a esa lista').click(); })()`);
        await answerDialog(an, 'revisar');
        await sleep(700);
        const addedAcc = (await swGet(['accounts', 'lists']));
        const cb = Object.values(addedAcc.accounts || {}).find(a => /^cuentabodega/.test(a.handle));
        check('cuenta con señales: se puede añadir a una lista propia desde el propio análisis', cb && cb.tags.includes('revisar') && addedAcc.lists.revisar === true, JSON.stringify(cb));
        await swc2.eval(`chrome.storage.local.set({ accounts: {}, myLists: {}, lists: {} })`);
        await an.eval(`[...document.querySelectorAll('#anRows button')].find(b => b.textContent === 'Ver').click()`);
        await sleep(600);
        const det = await dtext();
        check('detalle: cuentas con su orden de entrada, sensibilidad a la ventana, alternativas y aviso', /@cuentabodega0/.test(det) && /@cuentabodega4/.test(det) && /Sensibilidad a la ventana/.test(det) && /Explicaciones alternativas/.test(det) && /no dice quién hay detrás/.test(det), det.slice(0, 200));

        await an.eval(`(() => { const d = document.getElementById('anDrawer'); const sel = d.querySelector('select'); sel.value = '__new'; [...d.querySelectorAll('button')].find(b => b.textContent === 'Anclar a un expediente').click(); })()`);
        await answerDialog(an, 'Caso e2e');
        await sleep(1200);
        const cases = await swc2.eval(`XAF.cases.list()`);
        const cid = cases[0] && cases[0].caseId;
        const evN = await swc2.eval(`XAF.db.count('evidence')`);
        check('expediente: anclar un evento crea el expediente y guarda la evidencia de sus 5 cuentas', cases.length === 1 && cases[0].events === 1 && evN === 5, JSON.stringify(cases));

        // lo anclado no se borra con la retención; lo demás sí
        const pur = await swc2.eval(`XAF.ingest.purge({ textDays: 14, maxDays: 180 }, ${nowR + 400 * 86400000})`);
        const left = await swc2.eval(`XAF.db.count('obs')`);
        check('retención: pasados los días, solo sobreviven las observaciones ancladas al expediente', pur.deleted === 85 && left === 5, JSON.stringify([pur, left]));

        // evento externo, paquete e informe
        await swc2.eval(`XAF.cases.addExternal('${cid}', { at: ${nowR - 3 * 3600000}, title: 'Fallo judicial', kind: 'judicial', url: 'https://ejemplo.com/n' })`);
        await swc2.eval(`XAF.cases.update('${cid}', { notes: 'Hipótesis mía (capa C)', question: '¿Hubo coordinación?' })`);

        // los hechos externos de los expedientes salen sobre la curva de las narrativas y en su detalle, con la distancia en el tiempo
        const extAll = await askCase();
        check('hechos externos: el service worker los reúne de todos los expedientes', extAll.ok && extAll.externals.length === 1 && extAll.externals[0].title === 'Fallo judicial' && extAll.externals[0].caseId === cid, JSON.stringify(extAll));
        await an.eval(`document.getElementById('anRun').click()`);
        await sleep(500);
        for (let i = 0; i < 60 && await an.eval(`document.getElementById('anRun').disabled`); i++) await sleep(300);
        await pane('narr');
        await sleep(500);
        await an.eval(`[...document.querySelectorAll('#anNarr button')].find(b => b.textContent === 'Ver detalle').click()`);
        await sleep(600);
        const ntxt = await dtext();
        check('narrativa: el detalle muestra el hecho externo cercano y a qué distancia empieza la narrativa, sin afirmar causa', /Fallo judicial/.test(ntxt) && /la narrativa empieza/.test(ntxt) && /no prueba que la cause/.test(ntxt), ntxt.slice(0, 400));
        await an.eval(`(() => { const d = document.getElementById('anDrawer'); d.querySelector('.extform').open = true; const t = d.querySelector('.extform input[placeholder^="Qué pasó"]'); t.value = 'Declaración del ministro'; [...d.querySelectorAll('button')].find(b => b.textContent === 'Anotar hecho').click(); })()`);
        await sleep(900);
        const extAfter = await askCase();
        check('narrativa: se puede anotar un hecho externo desde su detalle (queda en el expediente)', extAfter.externals.some(x => x.title === 'Declaración del ministro' && x.caseId === cid), JSON.stringify(extAfter.externals.map(x => x.title)));
        await an.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        const pkg = await swc2.eval(`XAF.cases.exportPackage('${cid}')`);
        const ok = await swc2.eval(`XAF.cases.exportPackage('${cid}').then(p => XAF.verifyPackage(p))`);
        const pkgText = JSON.stringify(pkg);
        check('paquete: lleva IDs, huellas, parámetros del radar y huella SHA-256 verificable', pkg.kind === 'matatigre-case' && pkg.evidence.length === 5 && pkg.evidence.every(e => e.tweetId && e.th) && pkg.case.events[0].radar.version && pkg.case.events[0].radar.params && ok === true && /^[0-9a-f]{64}$/.test(pkg.integrity.sha256));
        check('paquete: por defecto las cuentas salen seudonimizadas (sin nombres de usuario)', !pkgText.includes('cuentabodega') && pkg.includesHandles === false && pkg.evidence.every(e => /^C-/.test(e.account)));
        const pkg2 = await swc2.eval(`XAF.cases.exportPackage('${cid}', { includeHandles: true })`);
        check('paquete: con la opción explícita incluye los nombres de usuario', pkg2.includesHandles === true && Object.values(pkg2.accounts).includes('cuentabodega0'));
        const html = await swc2.eval(`XAF.cases.report('${cid}')`);
        check('informe: secciones, capas, línea de tiempo con el evento externo y aviso', /1 · Pregunta y alcance/.test(html) && /8 · Anexo de evidencia/.test(html) && /Evento externo \(capa C\)/.test(html) && /Fallo judicial/.test(html) && /Hipótesis mía/.test(html) && /no establece la identidad de nadie/.test(html) && !html.includes('cuentabodega'));

        // interfaz del expediente
        await pane('cases');
        await sleep(700);
        await an.eval(`[...document.querySelectorAll('#caseList button')].find(b => b.textContent === 'Abrir').click()`);
        await sleep(700);
        const view = await an.eval(`document.getElementById('caseView').innerText`);
        check('interfaz del expediente: eventos anclados, evidencia, eventos externos y notas separados por capa', /capa B/.test(view) && /capa A/.test(view) && /Fallo judicial/.test(view) && /capa C/.test(view) && /5 observaciones ancladas/.test(view), view.slice(0, 200));
        const url = await an.eval(`(async () => { let u = null; window.open = x => { u = x; }; [...document.querySelectorAll('#caseView button')].find(b => b.textContent === 'Informe').click(); for (let i = 0; i < 30 && !u; i++) await new Promise(r => setTimeout(r, 100)); return u ? await (await fetch(u)).text() : null; })()`);
        check('interfaz del expediente: el botón Informe genera el informe', url && /5 · Línea de tiempo/.test(url));

        await swc2.eval(`XAF.cases.remove('${cid}')`);
        check('borrar el expediente libera su evidencia anclada', (await swc2.eval(`XAF.db.count('evidence')`)) === 0 && (await swc2.eval(`XAF.cases.list()`)).length === 0);
        an.close();
        await swc2.eval(`chrome.storage.local.remove('topics')`);
        await swc2.eval(`XAF.ingest.clear()`);
        await swc2.eval(`chrome.storage.local.set({ settings: { observe: false } })`);
    }

    p.close(); swc2.close();
} catch (e) {
    console.error('ERROR', e);
    exitCode = 1;
} finally {
    chrome.kill();
    server.close();
    listServer.close();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* perfil bloqueado en Windows */ }
}
for (const p of problems) console.log('  ! ' + p);
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} OK`);
process.exit(exitCode || (failed ? 1 : 0));
