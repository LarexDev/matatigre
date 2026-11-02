/**
 * Acceso a chrome.storage.local con valores por defecto. Se usa desde el service worker
 * (importScripts), el content script, el popup y la página de opciones.
 */
(function (root) {
    'use strict';
    const XAF = (root.XAF = root.XAF || {});
    const KEYS = ['settings', 'accounts', 'lists', 'rules', 'allowlist', 'seedMeta'];

    const DEFAULTS = () => ({
        settings: XAF.resolveSettings(),
        accounts: {},
        lists: {},
        rules: [],
        allowlist: [],
        seedMeta: null
    });

    async function load() {
        const stored = await chrome.storage.local.get(KEYS);
        const d = DEFAULTS();
        return {
            settings: XAF.resolveSettings(stored.settings),
            accounts: stored.accounts || d.accounts,
            lists: stored.lists || d.lists,
            rules: stored.rules || d.rules,
            allowlist: stored.allowlist || d.allowlist,
            seedMeta: stored.seedMeta || d.seedMeta
        };
    }

    function save(partial) {
        return chrome.storage.local.set(partial);
    }

    // data/accounts.json va en el repositorio; data/accounts.local.json es opcional y personal (no se publica).
    const SEED_FILES = ['data/accounts.json', 'data/accounts.local.json'];

    /** Lee y combina los archivos de lista inicial que existan. */
    async function readSeed() {
        const out = { generatedAt: '', lists: {}, accounts: [] };
        for (const file of SEED_FILES) {
            try {
                const res = await fetch(chrome.runtime.getURL(file));
                if (!res.ok) continue;
                const d = await res.json();
                Object.assign(out.lists, d.lists || {});
                out.accounts.push(...(Array.isArray(d.accounts) ? d.accounts : []));
                out.generatedAt += (out.generatedAt ? '|' : '') + (d.generatedAt || '');
            } catch { /* archivo opcional ausente */ }
        }
        return out;
    }

    /** Fusiona la lista inicial con la configuración sin pisar ediciones del usuario. */
    async function seed({ force = false } = {}) {
        const data = await readSeed();
        const cfg = await load();
        if (!force && cfg.seedMeta && cfg.seedMeta.generatedAt === data.generatedAt) return { added: 0, updated: 0, skipped: true };

        const { accounts, added, updated } = XAF.mergeSeed(cfg.accounts, data.accounts);
        // Listas nuevas aparecen según el estado por defecto declarado en la semilla.
        const lists = { ...cfg.lists };
        for (const [tag, def] of Object.entries(data.lists || {})) if (!(tag in lists)) lists[tag] = !!def.enabledByDefault;
        await save({ accounts, lists, seedMeta: { generatedAt: data.generatedAt, count: data.accounts.length } });
        return { added, updated, skipped: false };
    }

    function onChange(cb) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && KEYS.some(k => k in changes)) cb(changes);
        });
    }

    const STATS_KEY = 'stats';
    const emptyStats = () => ({ since: new Date().toISOString().slice(0, 10), total: 0, byHandle: {}, byRole: {}, byDay: {} });

    /** Estadísticas de filtrado (clave aparte: no debe disparar recargas de configuración). */
    async function loadStats() {
        const s = (await chrome.storage.local.get(STATS_KEY))[STATS_KEY];
        return s && typeof s === 'object' ? { ...emptyStats(), ...s } : emptyStats();
    }

    XAF.store = { KEYS, STATS_KEY, load, save, seed, readSeed, onChange, loadStats, emptyStats };
})(typeof globalThis !== 'undefined' ? globalThis : this);
