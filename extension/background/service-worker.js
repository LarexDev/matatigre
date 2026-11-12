/* Bienvenida y migración, sincronización de listas, estadísticas, contador del icono y atajos. */
importScripts('../src/matcher.js', '../src/mylists.js', '../src/store.js', '../src/lists.js', '../src/observe.js', '../src/db.js', '../src/radar.js', '../src/ingest.js', '../src/cases.js');

const WELCOME = chrome.runtime.getURL('welcome/welcome.html');
const SYNC_ALARM = 'matatigre-sync';
const PURGE_ALARM = 'matatigre-purge';
const RESUME_ALARM = 'matatigre-resume';
const X_URLS = ['*://x.com/*', '*://*.x.com/*', '*://twitter.com/*', '*://*.twitter.com/*'];

// ---------- menú contextual: clic derecho en un enlace a una cuenta de X ----------
let menuBuilding = Promise.resolve();
/** Reconstruye el menú con tus listas propias (las sincronizadas son de solo lectura y no se ofrecen). */
function buildMenu() {
    menuBuilding = menuBuilding.then(async () => {
        const cfg = await XAF.store.load();
        const own = Object.entries(cfg.myLists).sort((a, b) => a[1].name.localeCompare(b[1].name, 'es')).slice(0, 15);
        await chrome.contextMenus.removeAll();
        const base = { contexts: ['link'], targetUrlPatterns: X_URLS };
        chrome.contextMenus.create({ id: 'mt', title: 'MATATIGRE', ...base });
        for (const [id, m] of own) chrome.contextMenus.create({ id: 'mt-list:' + id, parentId: 'mt', title: 'Añadir a «' + m.name + '»', ...base });
        if (!own.length) chrome.contextMenus.create({ id: 'mt-new', parentId: 'mt', title: 'Crear una lista propia…', ...base });
        chrome.contextMenus.create({ id: 'mt-show', parentId: 'mt', title: 'Siempre mostrar', ...base });
    }).catch(e => console.error('[matatigre] menú', e));
    return menuBuilding;
}

/** Atiende un clic del menú: la acción la ejecuta la pestaña (mismo código que la tarjeta de la página, con aviso y "Deshacer"). */
async function handleMenuClick(info, tab) {
    if (info.menuItemId === 'mt-new') { await openOptions('#lists/new'); return { ok: true }; }
    const m = /^mt-(add|show|list)(?::(.*))?$/.exec(String(info.menuItemId));
    if (!m) return { ok: false };
    let url;
    try { url = new URL(info.linkUrl); } catch { return { ok: false, error: 'Enlace no válido.' }; }
    if (!/^(?:[a-z0-9-]+\.)*(?:x|twitter)\.com$/i.test(url.hostname)) return { ok: false, error: 'El enlace no es de X.' };
    const loc = XAF.parseLocation(url.pathname);
    if (loc.kind !== 'profile' && loc.kind !== 'status') return { ok: false, error: 'El enlace no es de una cuenta.' };
    const target = tab && tab.id != null ? tab : (await chrome.tabs.query({ url: X_URLS, active: true }))[0];
    if (!target) return { ok: false, error: 'Sin pestaña de X.' };
    await chrome.tabs.sendMessage(target.id, { type: 'xaf:menuAdd', handle: loc.handle, act: m[1] === 'show' ? 'show' : 'add', list: m[1] === 'list' ? m[2] : '' });
    return { ok: true, handle: loc.handle };
}
chrome.contextMenus.onClicked.addListener((info, tab) => { handleMenuClick(info, tab).catch(e => console.error('[matatigre] menú', e)); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && ('accounts' in changes || 'subs' in changes || 'myLists' in changes)) buildMenu(); });

/** Abre las opciones (o enseña la pestaña que ya está abierta) en una sección: #lists, #lists/new… */
async function openOptions(hash) {
    const url = chrome.runtime.getURL('options/options.html');
    const suffix = /^#[a-z0-9/-]{0,40}$/i.test(hash || '') ? hash : '';
    const [t] = await chrome.tabs.query({ url: url + '*' });
    if (t) { await chrome.tabs.update(t.id, { url: url + suffix, active: true }); await chrome.windows.update(t.windowId, { focused: true }); }
    else await chrome.tabs.create({ url: url + suffix });
}

// ---------- pausa con vuelta automática ----------
/** Pausa el filtrado `minutes` minutos y programa su vuelta (sobrevive a cerrar el navegador: se comprueba al arrancar). */
async function pauseFilter(minutes) {
    const m = Math.max(1, Math.min(7 * 1440, Math.round(Number(minutes) || 0)));
    const cfg = await XAF.store.load();
    const until = Date.now() + m * 60000;
    await chrome.storage.local.set({ pauseUntil: until });
    await XAF.store.save({ settings: { ...cfg.settings, enabled: false } });
    chrome.alarms.create(RESUME_ALARM, { when: until });
    return { until };
}
async function clearPause() {
    await chrome.alarms.clear(RESUME_ALARM);
    await chrome.storage.local.remove('pauseUntil');
}
/** Reanuda si la pausa ya venció (o vuelve a programar la alarma si aún falta). */
async function resumeIfDue() {
    const { pauseUntil } = await chrome.storage.local.get('pauseUntil');
    if (!pauseUntil) return false;
    if (Date.now() < pauseUntil) { chrome.alarms.create(RESUME_ALARM, { when: pauseUntil }); return false; }
    const cfg = await XAF.store.load();
    await clearPause();
    await XAF.store.save({ settings: { ...cfg.settings, enabled: true } });
    return true;
}
// quien enciende el filtrado a mano cancela la pausa
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings && changes.settings.newValue && changes.settings.newValue.enabled) clearPause().catch(() => { }); });

function ensureAlarm() {
    chrome.alarms.get(SYNC_ALARM, a => {
        if (!a) chrome.alarms.create(SYNC_ALARM, { delayInMinutes: 5, periodInMinutes: XAF.lists.SYNC_EVERY_MIN });
    });
    chrome.alarms.get(PURGE_ALARM, a => {
        if (!a) chrome.alarms.create(PURGE_ALARM, { delayInMinutes: 30, periodInMinutes: 1440 });
    });
}

/** ¿Existe ya el registro local? (para no crearlo en equipos donde nunca se activó). */
async function registryExists() {
    try { return (await indexedDB.databases()).some(d => d.name === XAF.db.DB_NAME); } catch { return true; }
}

/** Recalcula las cuentas vigiladas (a lo sumo cada 10 min mientras llegan lotes; siempre en la limpieza diaria). */
let watchAt = 0;
async function refreshWatch(force = false) {
    if (!force && Date.now() - watchAt < 10 * 60000) return;
    watchAt = Date.now();
    if (!(await registryExists())) return;
    const { settings } = await XAF.store.load();
    const ids = XAF.captureOn(settings) && settings.watch !== false ? await XAF.ingest.computeWatch() : [];
    const prev = (await chrome.storage.local.get('watch')).watch;
    if (!prev || JSON.stringify(prev.ids) !== JSON.stringify(ids)) await chrome.storage.local.set({ watch: { ids, at: Date.now() } });
}

async function purgeRegistry() {
    if (!(await registryExists())) return;
    const { settings } = await XAF.store.load();
    await XAF.ingest.purge({ textDays: settings.keepTextDays });
    await refreshWatch(true);
}

/**
 * Limpieza de versiones anteriores: una lista local de pruebas («citada», cuentas sin evidencia) que se cargaba desde un archivo del equipo
 * ya no existe. Se quitan sus cuentas sin editar y su interruptor; lo que el usuario tocó se conserva.
 */
async function cleanupLegacy() {
    const cfg = await XAF.store.load();
    const accounts = { ...cfg.accounts };
    let changed = false;
    for (const [k, a] of Object.entries(accounts)) {
        if (a && a.source === 'seed' && !a.touched && (a.tags || []).includes('citada')) { delete accounts[k]; changed = true; }
    }
    const lists = { ...cfg.lists };
    const stillUsed = Object.values(accounts).some(a => (a.tags || []).includes('citada'));
    if ('citada' in lists && !stillUsed) { delete lists.citada; changed = true; }
    const stored = await chrome.storage.local.get('seedMeta');
    if (stored.seedMeta) { await chrome.storage.local.remove('seedMeta'); }
    if (changed) await XAF.store.save({ accounts, lists });
    // las etiquetas sueltas de versiones anteriores pasan a ser listas propias guardadas
    const mine = (await chrome.storage.local.get('myLists')).myLists;
    const resolved = XAF.myLists.resolve(mine, accounts, cfg.subs);
    if (JSON.stringify(mine || {}) !== JSON.stringify(resolved)) await XAF.store.save({ myLists: resolved });
}

chrome.runtime.onInstalled.addListener(async details => {
    try {
        await cleanupLegacy();
        ensureAlarm();
        buildMenu();
        const meta = await XAF.store.loadMeta();
        if (details.reason === 'install') {
            await chrome.tabs.create({ url: WELCOME });
        } else if (details.reason === 'update' && meta.welcome === 'pending') {
            // Venimos de la 1.x: sus cuentas siguen funcionando; la bienvenida ofrece pasar a listas que se actualizan solas.
            const legacy = await XAF.lists.legacySeedInfo();
            if (legacy.count > 0) await chrome.tabs.create({ url: WELCOME + '?migrate=1' });
        }
    } catch (e) { console.error('[matatigre] onInstalled', e); }
});

chrome.runtime.onStartup.addListener(async () => {
    ensureAlarm();
    resumeIfDue().catch(() => { });
    cleanupLegacy().catch(() => { });
    buildMenu();
    try {
        const meta = await XAF.store.loadMeta();
        if (Date.now() - (meta.lastSync || 0) > XAF.lists.SYNC_EVERY_MIN * 60000) await XAF.lists.syncAll();
    } catch (e) { console.error('[matatigre] sync inicial', e); }
});

chrome.alarms.onAlarm.addListener(async alarm => {
    try {
        if (alarm.name === SYNC_ALARM) await XAF.lists.syncAll();
        else if (alarm.name === PURGE_ALARM) await purgeRegistry();
        else if (alarm.name === RESUME_ALARM) await resumeIfDue();
    } catch (e) { console.error('[matatigre] alarma', alarm.name, e); }
});

// Las estadísticas se acumulan aquí (una sola escritora) para que varias pestañas no se pisen.
let statsQueue = Promise.resolve();
function addStats(delta) {
    statsQueue = statsQueue.then(async () => {
        const s = await XAF.store.loadStats();
        const day = new Date().toISOString().slice(0, 10);
        s.total += delta.n;
        s.byDay[day] = (s.byDay[day] || 0) + delta.n;
        for (const [h, n] of Object.entries(delta.byHandle || {})) s.byHandle[h] = (s.byHandle[h] || 0) + n;
        for (const [r, n] of Object.entries(delta.byRole || {})) s.byRole[r] = (s.byRole[r] || 0) + n;
        // acotar: conservar 90 días y las 2000 cuentas más frecuentes
        const days = Object.keys(s.byDay).sort();
        for (const d of days.slice(0, Math.max(0, days.length - 90))) delete s.byDay[d];
        const top = Object.entries(s.byHandle).sort((a, b) => b[1] - a[1]);
        if (top.length > 2000) s.byHandle = Object.fromEntries(top.slice(0, 2000));
        await chrome.storage.local.set({ [XAF.store.STATS_KEY]: s });
    }).catch(e => console.error('[matatigre] stats', e));
}

let idsQueue = Promise.resolve();
/** Guarda el id de usuario de las cuentas configuradas que aún no lo tienen y poda los de cuentas que ya no están. */
function learnIds(pairs) {
    idsQueue = idsQueue.then(async () => {
        const cfg = await XAF.store.load();
        const effective = XAF.composeConfig(cfg).accounts;
        const uids = { ...cfg.uids };
        let changed = false;
        for (const p of pairs.slice(0, 200)) {
            const key = XAF.normalizeHandle(p && p.h);
            const id = p && String(p.id);
            if (!key || !XAF.USER_ID_RE.test(id) || !effective[key] || effective[key].uid) continue;
            uids[key] = id;
            changed = true;
        }
        for (const k of Object.keys(uids)) if (!effective[k]) { delete uids[k]; changed = true; }
        if (changed) await XAF.store.save({ uids });
    }).catch(e => console.error('[matatigre] ids', e));
    return idsQueue;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'xaf:report') {
        if (sender.tab?.id != null) {
            // '!' en ámbar cuando el filtro no reconoce las publicaciones de X (ver health() en content.js); si no, el contador
            const bad = msg.health === 'api' || msg.health === 'dom';
            const text = bad ? '!' : msg.hidden > 0 ? (msg.hidden > 999 ? '999+' : String(msg.hidden)) : '';
            chrome.action.setBadgeText({ tabId: sender.tab.id, text });
            chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: bad ? '#b45309' : '#b91c1c' });
        }
        if (msg.delta && msg.delta.n > 0) addStats(msg.delta);
        return;
    }
    if ((msg?.type === 'xaf:pause' || msg?.type === 'xaf:resume') && sender.id === chrome.runtime.id && (sender.url || '').startsWith(chrome.runtime.getURL(''))) {
        (msg.type === 'xaf:pause' ? pauseFilter(msg.minutes) : (async () => { const cfg = await XAF.store.load(); await clearPause(); await XAF.store.save({ settings: { ...cfg.settings, enabled: true } }); return {}; })())
            .then(r => sendResponse({ ok: true, ...r })).catch(() => sendResponse({ ok: false }));
        return true;
    }
    if (msg?.type === 'xaf:openOptions' && sender.id === chrome.runtime.id) {
        openOptions(String(msg.hash || '')).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
        return true;
    }
    // Ids de usuario aprendidos de las respuestas de X: solo se guardan para cuentas que ya están en la configuración.
    if (msg?.type === 'xaf:ids' && sender.id === chrome.runtime.id && sender.tab && Array.isArray(msg.ids)) {
        learnIds(msg.ids).catch(e => console.error('[matatigre] ids', e));
        return;
    }
    // Registro local: lotes del content script (solo si el usuario lo activó).
    if (msg?.type === 'xaf:obs' && sender.id === chrome.runtime.id && sender.tab && Array.isArray(msg.batch)) {
        XAF.store.load()
            .then(({ settings }) => (XAF.captureOn(settings) ? XAF.ingest.ingestBatch(msg.batch).then(() => refreshWatch()) : null))
            .catch(e => console.error('[matatigre] registro', e));
        return;
    }
    // Expedientes: solo desde páginas de la propia extensión.
    if (msg?.type === 'xaf:cases' && sender.id === chrome.runtime.id && (sender.url || '').startsWith(chrome.runtime.getURL(''))) {
        (async () => {
            const K = XAF.cases;
            const exists = await registryExists();
            switch (msg.op) {
                case 'list': return { ok: true, cases: exists ? await K.list() : [] };
                case 'get': return { ok: true, case: exists ? await K.get(String(msg.caseId)) : null };
                case 'externals': return { ok: true, externals: exists ? await K.externals() : [] };
                case 'create': return { ok: true, case: await K.create(msg.data || {}) };
                case 'update': return { ok: true, case: await K.update(String(msg.caseId), msg.patch || {}) };
                case 'addEvent': return { ok: true, ...(await K.addEvent(String(msg.caseId), msg.event || {}, msg.opts || {})) };
                case 'removeEvent': return { ok: true, case: await K.removeEvent(String(msg.caseId), String(msg.eventId)) };
                case 'addExternal': return { ok: true, case: await K.addExternal(String(msg.caseId), msg.ext || {}) };
                case 'removeExternal': return { ok: true, case: await K.removeExternal(String(msg.caseId), String(msg.extId)) };
                case 'remove': return K.remove(String(msg.caseId));
                case 'export': return { ok: true, data: await K.exportPackage(String(msg.caseId), { includeHandles: !!msg.includeHandles }) };
                case 'report': return { ok: true, html: await K.report(String(msg.caseId), { includeHandles: !!msg.includeHandles }) };
                default: return { ok: false, error: 'Operación desconocida.' };
            }
        })().then(sendResponse).catch(e => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
        return true;
    }
    // Operaciones sobre el registro: solo desde páginas de la propia extensión.
    if (msg?.type === 'xaf:data' && sender.id === chrome.runtime.id && (sender.url || '').startsWith(chrome.runtime.getURL(''))) {
        (async () => {
            if (msg.op === 'stats') return (await registryExists()) ? { ok: true, ...(await XAF.ingest.stats()) } : { ok: true, profiles: 0, obs: 0, oldest: null, newest: null };
            if (msg.op === 'clear') { await XAF.ingest.clear(); await chrome.storage.local.remove('watch'); return { ok: true }; }
            if (msg.op === 'purge') { await purgeRegistry(); return { ok: true }; }
            return { ok: false, error: 'Operación desconocida.' };
        })().then(sendResponse).catch(e => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
        return true;
    }
    // Operaciones de listas: solo desde páginas de la propia extensión (no desde content scripts en x.com).
    if (msg?.type === 'xaf:lists' && sender.id === chrome.runtime.id && (sender.url || '').startsWith(chrome.runtime.getURL(''))) {
        XAF.lists.handle(msg)
            .then(sendResponse)
            .catch(e => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
        return true; // respuesta asíncrona
    }
});

chrome.commands.onCommand.addListener(async command => {
    const cfg = await XAF.store.load();
    const settings = { ...cfg.settings };
    if (command === 'toggle-enabled') settings.enabled = !settings.enabled;
    else if (command === 'cycle-mode') settings.mode = settings.mode === 'highlight' ? 'hide' : 'highlight';
    else return;
    await XAF.store.save({ settings });
});
