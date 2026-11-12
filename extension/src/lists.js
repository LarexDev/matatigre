/**
 * Listas suscribibles: descarga, validación y copia local. Solo lo usa el service worker (único escritor);
 * las páginas de la extensión le piden las operaciones por mensajes (`xaf:lists`).
 *
 * Red: una petición GET a la URL del catálogo y una por lista suscrita, sin cookies, sin cabecera Referer y sin datos
 * del usuario. No se piden permisos de host: GitHub (y cualquier servidor que sirva JSON con CORS abierto) responde con
 * `Access-Control-Allow-Origin: *`, que basta para leer la respuesta. Si falla, se conserva la última copia buena.
 */
(function (root) {
    'use strict';
    const XAF = (root.XAF = root.XAF || {});

    const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/LarexDev/matatigre-listas/main/index.json';
    const MAX_BYTES = 2 * 1024 * 1024;
    const TIMEOUT_MS = 15000;
    const SYNC_EVERY_MIN = 720;

    // Todas las escrituras de listas pasan por aquí, de una en una.
    let queue = Promise.resolve();
    function exclusive(fn) {
        const p = queue.then(fn);
        queue = p.catch(() => { });
        return p;
    }

    const message = e => (e && e.message) || String(e);

    async function catalogUrl() {
        const v = (await chrome.storage.local.get('catalogUrl')).catalogUrl; // solo para desarrollo y pruebas
        return typeof v === 'string' && XAF.isAllowedListUrl(v) ? v : DEFAULT_CATALOG_URL;
    }

    async function getJson(url) {
        if (!XAF.isAllowedListUrl(url)) throw new Error('URL no admitida: solo https.');
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(url, { cache: 'no-cache', credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', signal: ctl.signal });
            if (!res.ok) throw new Error('El servidor respondió ' + res.status + '.');
            if (res.url && !XAF.isAllowedListUrl(res.url)) throw new Error('Redirección a una dirección no admitida.');
            if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('Archivo demasiado grande.');
            const text = await res.text();
            if (text.length > MAX_BYTES) throw new Error('Archivo demasiado grande.');
            try { return JSON.parse(text); } catch { throw new Error('El archivo no es JSON válido.'); }
        } catch (e) {
            if (e && e.name === 'AbortError') throw new Error('Tiempo de espera agotado.');
            if (e instanceof TypeError) throw new Error('No se pudo conectar (sin red o el servidor no permite la lectura).');
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    /** Descarga y valida el catálogo; lo guarda como caché para mostrarlo sin conexión. */
    async function fetchCatalog() {
        const url = await catalogUrl();
        const r = XAF.sanitizeCatalog(await getJson(url));
        if (!r.ok) throw new Error(r.error);
        await chrome.storage.local.set({ catalog: { fetchedAt: Date.now(), url, data: r.catalog } });
        return { url, data: r.catalog };
    }

    async function cachedCatalog() {
        const c = (await chrome.storage.local.get('catalog')).catalog;
        return c && c.data ? c : null;
    }

    /** Qué cambió entre dos copias de una lista: cuántas cuentas entran y salen (con una muestra) y si el cambio es grande. */
    const diffAccounts = (prev, next) => {
        const a = new Map((prev || []).map(x => [XAF.normalizeHandle(x.handle), x.handle]));
        const b = new Map(next.map(x => [XAF.normalizeHandle(x.handle), x.handle]));
        const addedList = [], removedList = [];
        for (const [k, h] of b) if (!a.has(k)) addedList.push(h);
        for (const [k, h] of a) if (!b.has(k)) removedList.push(h);
        return { added: addedList.length, removed: removedList.length, prev: a.size, addedList: addedList.slice(0, 50), removedList: removedList.slice(0, 50), big: a.size >= 20 && (addedList.length + removedList.length) / a.size >= 0.25 };
    };
    const syncedTotal = (listData, exceptId) => Object.entries(listData || {}).reduce((n, [id, d]) => n + (id === exceptId ? 0 : ((d && d.accounts) || []).length), 0);
    const overLimit = () => new Error('Superaría el límite de ' + XAF.LIMITS.syncedTotal.toLocaleString('es') + ' cuentas entre todas tus listas sincronizadas.');
    const tooMany = () => new Error('Máximo ' + XAF.LIMITS.subs + ' listas sincronizadas: deja de seguir alguna para añadir otra.');

    /** Descarga las listas indicadas (o todas) y guarda lo que cambió. No toma el cerrojo: úsese dentro de `exclusive`. */
    async function syncCore(onlyIds) {
        const cfg = await XAF.store.load();
        const meta = await XAF.store.loadMeta();
        const status = { ...(meta.status || {}) };
        const now = Date.now();
        let subs = [...cfg.subs];
        const listData = { ...cfg.listData };
        const result = { updated: 0, unchanged: 0, failed: 0, withdrawn: 0, catalogError: '' };

        let catalog = null;
        if (subs.some(s => s.source === 'catalog')) {
            try { catalog = await fetchCatalog(); } catch (e) { result.catalogError = message(e); }
        }

        if (catalog) {
            const gone = new Set(catalog.data.withdrawn);
            const kept = subs.filter(s => !(s.source === 'catalog' && gone.has(s.id)));
            for (const s of subs) if (!kept.includes(s)) { delete listData[s.id]; delete status[s.id]; result.withdrawn++; }
            subs = kept;
        }

        let subsChanged = subs.length !== cfg.subs.length;
        for (const sub of subs) {
            if (onlyIds && !onlyIds.includes(sub.id)) continue;
            if (catalog && sub.source === 'catalog') {
                const entry = catalog.data.lists.find(l => l.id === sub.id);
                const url = entry && XAF.resolveListUrl(catalog.url, entry.path);
                if (url && (url !== sub.url || entry.name !== sub.name)) { sub.url = url; sub.name = entry.name; subsChanged = true; }
            }
            try {
                const r = XAF.sanitizeList(await getJson(sub.url));
                if (!r.ok) throw new Error(r.error);
                if (syncedTotal(listData, sub.id) + r.list.accounts.length > XAF.LIMITS.syncedTotal) throw overLimit();
                const prev = listData[sub.id];
                const same = prev && prev.version === r.list.version && JSON.stringify(prev.accounts) === JSON.stringify(r.list.accounts);
                if (same) {
                    result.unchanged++;
                    status[sub.id] = { ...status[sub.id], checkedAt: now, error: '' };
                } else {
                    listData[sub.id] = { version: r.list.version, updated: r.list.updated, name: r.list.name, description: r.list.description, accounts: r.list.accounts };
                    status[sub.id] = { checkedAt: now, error: '', change: { ...diffAccounts(prev && prev.accounts, r.list.accounts), at: now, first: !prev } };
                    result.updated++;
                }
            } catch (e) {
                status[sub.id] = { ...status[sub.id], checkedAt: now, error: message(e) };
                result.failed++;
            }
        }

        const patch = {};
        if (subsChanged) patch.subs = subs;
        if (result.updated || result.withdrawn) patch.listData = listData;
        if (Object.keys(patch).length) await XAF.store.save(patch);
        await XAF.store.saveMeta({ status, lastSync: now, lastError: result.catalogError });
        return result;
    }

    const syncAll = () => exclusive(async () => {
        const { subs } = await XAF.store.load();
        return subs.length ? syncCore() : { updated: 0, unchanged: 0, failed: 0, withdrawn: 0, catalogError: '' };
    });

    /** Suscribe a listas del catálogo por id. Si una no se puede descargar, no queda suscrita. */
    const subscribeCatalog = ids => exclusive(async () => {
        const catalog = await fetchCatalog();
        const cfg = await XAF.store.load();
        const subs = [...cfg.subs];
        const lists = { ...cfg.lists };
        const added = [], failed = [];
        for (const id of ids) {
            const entry = catalog.data.lists.find(l => l.id === id);
            const url = entry && XAF.resolveListUrl(catalog.url, entry.path);
            if (!entry || !url) { failed.push({ id, error: 'No está en el catálogo.' }); continue; }
            if (subs.some(s => s.id === id)) continue;
            if (subs.length >= XAF.LIMITS.subs) { failed.push({ id, error: tooMany().message }); continue; }
            subs.push({ id, name: entry.name, url, source: 'catalog' });
            if (!(id in lists)) lists[id] = true; // elegir una lista la enciende; si el usuario ya tenía esa etiqueta, conserva su interruptor
            added.push(id);
        }
        await XAF.store.save({ subs, lists });
        await syncCore(added);
        const after = await XAF.store.load();
        const status = (await XAF.store.loadMeta()).status || {};
        const dropped = added.filter(id => !after.listData[id]);
        if (dropped.length) {
            for (const id of dropped) failed.push({ id, error: (status[id] && status[id].error) || 'No se pudo descargar.' });
            await XAF.store.save({ subs: after.subs.filter(s => !dropped.includes(s.id)) });
        }
        return { added: added.filter(id => !dropped.includes(id)), failed };
    });

    function shortHash(s) {
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        return h.toString(16).padStart(8, '0');
    }

    /** Suscribe a una lista publicada en una URL propia (el id se deriva de la URL). */
    const subscribeUrl = url => exclusive(async () => {
        url = String(url || '').trim();
        if (!XAF.isAllowedListUrl(url)) throw new Error('La URL debe empezar por https://');
        const id = 'u-' + shortHash(url);
        const cfg = await XAF.store.load();
        if (cfg.subs.some(s => s.id === id)) throw new Error('Ya estás suscrito a esa lista.');
        if (cfg.subs.length >= XAF.LIMITS.subs) throw tooMany();
        const r = XAF.sanitizeList(await getJson(url));
        if (!r.ok) throw new Error(r.error);
        if (syncedTotal(cfg.listData) + r.list.accounts.length > XAF.LIMITS.syncedTotal) throw overLimit();
        const meta = await XAF.store.loadMeta();
        await XAF.store.save({
            subs: [...cfg.subs, { id, name: r.list.name || id, url, source: 'custom' }],
            listData: { ...cfg.listData, [id]: { version: r.list.version, updated: r.list.updated, name: r.list.name, description: r.list.description, accounts: r.list.accounts } },
            lists: { ...cfg.lists, [id]: true }
        });
        await XAF.store.saveMeta({ status: { ...(meta.status || {}), [id]: { checkedAt: Date.now(), error: '', change: { added: r.list.accounts.length, removed: 0, at: Date.now(), first: true } } } });
        return { id, name: r.list.name, count: r.list.accounts.length };
    });

    const unsubscribe = id => exclusive(async () => {
        const cfg = await XAF.store.load();
        const listData = { ...cfg.listData };
        delete listData[id];
        const meta = await XAF.store.loadMeta();
        const status = { ...(meta.status || {}) };
        delete status[id];
        await XAF.store.save({ subs: cfg.subs.filter(s => s.id !== id), listData });
        await XAF.store.saveMeta({ status });
        return { ok: true };
    });

    /**
     * Migración desde la 1.x: las cuentas de la lista inicial que el usuario no tocó ya vienen de las listas suscritas;
     * se retiran de "mis cuentas" solo si su handle está en una lista ya descargada (nunca se pierde una cuenta).
     */
    const pruneLegacySeed = () => exclusive(async () => {
        const cfg = await XAF.store.load();
        const covered = new Set();
        for (const s of cfg.subs) for (const a of (cfg.listData[s.id] || { accounts: [] }).accounts) covered.add(XAF.normalizeHandle(a.handle));
        const accounts = { ...cfg.accounts };
        let removed = 0;
        for (const [k, a] of Object.entries(accounts)) {
            if (a && a.source === 'seed' && !a.touched && covered.has(k)) { delete accounts[k]; removed++; }
        }
        if (removed) await XAF.store.save({ accounts });
        return { removed };
    });

    /** Cuentas de la lista inicial 1.x sin tocar y las listas (etiquetas) que usaban. */
    async function legacySeedInfo() {
        const { accounts } = await XAF.store.load();
        const tags = new Set();
        let count = 0;
        for (const a of Object.values(accounts)) if (a && a.source === 'seed' && !a.touched) { count++; for (const t of a.tags || []) tags.add(t); }
        return { count, tags: [...tags] };
    }

    /** Atiende los mensajes `xaf:lists` de las páginas de la extensión. */
    async function handle(msg) {
        switch (msg.op) {
            case 'catalog': {
                try { const c = await fetchCatalog(); return { ok: true, catalog: c.data, fetchedAt: Date.now() }; }
                catch (e) {
                    const cached = await cachedCatalog();
                    return cached ? { ok: true, catalog: cached.data, fetchedAt: cached.fetchedAt, stale: true, error: message(e) } : { ok: false, error: message(e) };
                }
            }
            case 'subscribe': return { ok: true, ...(await subscribeCatalog((msg.ids || []).filter(id => XAF.LIST_ID_RE.test(id)))) };
            case 'subscribeUrl': return { ok: true, ...(await subscribeUrl(msg.url)) };
            case 'unsubscribe': return unsubscribe(String(msg.id));
            case 'sync': return { ok: true, ...(await syncAll()) };
            case 'prune': return { ok: true, ...(await pruneLegacySeed()) };
            case 'legacy': return { ok: true, ...(await legacySeedInfo()) };
            default: return { ok: false, error: 'Operación desconocida.' };
        }
    }

    XAF.lists = { DEFAULT_CATALOG_URL, SYNC_EVERY_MIN, fetchCatalog, syncAll, subscribeCatalog, subscribeUrl, unsubscribe, pruneLegacySeed, legacySeedInfo, handle };
})(typeof globalThis !== 'undefined' ? globalThis : this);
