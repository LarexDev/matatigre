/**
 * Acceso a chrome.storage.local con valores por defecto. Se usa desde el service worker
 * (importScripts), el content script, el popup, la página de opciones y la de bienvenida.
 *
 * Claves de configuración (disparan recargas en las pestañas de X):
 *   settings, accounts (cuentas propias), myLists (listas propias: { id: { name, created } }), lists (interruptores por lista/etiqueta), listModes (modo propio de cada lista), rules, allowlist,
 *   subs (listas suscritas), listData (última copia buena de cada una), disabled (cuentas de listas que el usuario apagó), uids (ids de usuario aprendidos por nombre de cuenta)
 * Claves de estado (no disparan recargas): stats, meta, catalog
 */
(function (root) {
    'use strict';
    const XAF = (root.XAF = root.XAF || {});
    const KEYS = ['settings', 'accounts', 'myLists', 'lists', 'listModes', 'rules', 'allowlist', 'subs', 'listData', 'disabled', 'uids'];
    const STATE_KEYS = ['meta', 'catalog'];

    const DEFAULTS = () => ({
        settings: XAF.resolveSettings(),
        accounts: {},
        myLists: {},
        lists: {},
        listModes: {},
        rules: [],
        allowlist: [],
        subs: [],
        listData: {},
        disabled: [],
        uids: {}
    });

    async function load() {
        const stored = await chrome.storage.local.get(KEYS);
        const d = DEFAULTS();
        const accounts = stored.accounts || d.accounts, subs = stored.subs || d.subs;
        return {
            settings: XAF.resolveSettings(stored.settings),
            accounts,
            // listas propias: las guardadas más las que solo existían como etiqueta de una cuenta (versiones anteriores)
            myLists: XAF.myLists ? XAF.myLists.resolve(stored.myLists, accounts, subs) : (stored.myLists || d.myLists),
            lists: stored.lists || d.lists,
            listModes: stored.listModes || d.listModes,
            rules: stored.rules || d.rules,
            allowlist: stored.allowlist || d.allowlist,
            subs,
            listData: stored.listData || d.listData,
            disabled: stored.disabled || d.disabled,
            uids: stored.uids || d.uids
        };
    }

    function save(partial) {
        return chrome.storage.local.set(partial);
    }

    // ---------- estado de la extensión (bienvenida, última sincronización) ----------
    // welcome: 'pending' (aún no vista) | 'done' | 'skipped'
    async function loadMeta() {
        const m = (await chrome.storage.local.get('meta')).meta;
        return { welcome: 'pending', lastSync: 0, lastError: '', ...(m && typeof m === 'object' ? m : {}) };
    }
    async function saveMeta(patch) {
        const meta = { ...(await loadMeta()), ...patch };
        await chrome.storage.local.set({ meta });
        return meta;
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

    XAF.store = { KEYS, STATE_KEYS, STATS_KEY, load, save, loadMeta, saveMeta, onChange, loadStats, emptyStats };
})(typeof globalThis !== 'undefined' ? globalThis : this);
