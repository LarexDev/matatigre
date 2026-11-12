/**
 * Listas propias (puro: sin DOM ni chrome.*; se prueba en Node).
 *
 * Hay dos clases de listas y no se mezclan:
 *   · SINCRONIZADAS (cfg.subs + cfg.listData): vienen de fuera y su contenido es de solo lectura. El usuario solo ajusta cómo se usan
 *     (encenderlas, su modo, omitir cuentas para sí, copiarlas a una lista propia).
 *   · PROPIAS (cfg.myLists): las crea y gestiona el usuario. Una cuenta propia pertenece a una o varias listas propias mediante sus `tags`.
 *
 * Antes las listas propias solo existían como etiquetas sueltas de las cuentas: una lista vacía no existía y no podía elegirse al añadir.
 * Ahora son entidades: { [id]: { name, created } }. \`resolve\` también recoge las etiquetas heredadas de versiones anteriores.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else (root.XAF = root.XAF || {}).myLists = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';
    const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,39}$/u;   // los nuevos ids son ASCII; se admiten etiquetas heredadas con acentos
    const MAX_LISTS = 200;
    const norm = h => (root.XAF && root.XAF.normalizeHandle ? root.XAF.normalizeHandle(h) : String(h || '').replace(/^@+/, '').toLowerCase());

    const slug = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
    const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);

    /** Listas propias válidas: las guardadas más las que solo existían como etiqueta de una cuenta propia. Nunca coinciden con una sincronizada. */
    function resolve(stored, accounts, subs) {
        const subIds = new Set((subs || []).map(s => s.id));
        const out = {};
        for (const [id, m] of Object.entries(stored && typeof stored === 'object' ? stored : {})) {
            if (!ID_RE.test(id) || subIds.has(id) || !m || typeof m !== 'object') continue;
            out[id] = { name: cleanName(m.name) || id, created: Number(m.created) || 0 };
        }
        for (const a of Object.values(accounts || {})) {
            for (const t of (a && a.tags) || []) if (ID_RE.test(t) && !subIds.has(t) && !out[t]) out[t] = { name: t, created: 0 };
        }
        return out;
    }

    function uniqueId(name, cfg) {
        const base = slug(name) || 'lista';
        const taken = id => !!cfg.myLists[id] || (cfg.subs || []).some(s => s.id === id);
        if (!taken(base)) return base;
        for (let i = 2; i < 1000; i++) { const id = (base.slice(0, 36) + '-' + i); if (!taken(id)) return id; }
        return base + '-' + Date.now().toString(36);
    }

    /** ¿Se puede usar este nombre? Devuelve el motivo si no. */
    function checkName(cfg, name, exceptId) {
        const n = cleanName(name);
        if (!n) return 'Escribe un nombre.';
        if (!slug(n)) return 'Usa letras o números.';
        const key = n.toLowerCase();
        for (const [id, m] of Object.entries(cfg.myLists || {})) if (id !== exceptId && m.name.toLowerCase() === key) return 'Ya tienes una lista con ese nombre.';
        for (const s of cfg.subs || []) if ((s.name || '').toLowerCase() === key) return 'Ya existe una lista sincronizada con ese nombre.';
        if (!exceptId && Object.keys(cfg.myLists || {}).length >= MAX_LISTS) return 'Has llegado al máximo de listas.';
        return '';
    }

    /** Crea una lista propia (encendida). Devuelve su id. */
    function create(cfg, name) {
        const id = uniqueId(name, cfg);
        cfg.myLists = { ...(cfg.myLists || {}), [id]: { name: cleanName(name), created: Date.now() } };
        cfg.lists = { ...(cfg.lists || {}), [id]: true };
        return id;
    }

    function rename(cfg, id, name) {
        if (!cfg.myLists[id]) return false;
        cfg.myLists = { ...cfg.myLists, [id]: { ...cfg.myLists[id], name: cleanName(name) } };
        return true;
    }

    /** Cuentas propias que pertenecen a la lista. */
    const members = (cfg, id) => Object.entries(cfg.accounts || {}).filter(([, a]) => ((a && a.tags) || []).includes(id)).map(([k]) => k);

    /** Borra la lista. Las cuentas que solo estaban en ella se quitan también. Devuelve cuántas. */
    function remove(cfg, id) {
        if (!cfg.myLists[id]) return { removedAccounts: 0 };
        const accounts = { ...cfg.accounts };
        let removedAccounts = 0;
        for (const [k, a] of Object.entries(accounts)) {
            if (!((a && a.tags) || []).includes(id)) continue;
            const tags = a.tags.filter(t => t !== id);
            if (tags.length) accounts[k] = { ...a, tags };
            else { delete accounts[k]; removedAccounts++; }
        }
        const myLists = { ...cfg.myLists }; delete myLists[id];
        const lists = { ...cfg.lists }; delete lists[id];
        const listModes = { ...cfg.listModes }; delete listModes[id];
        Object.assign(cfg, { accounts, myLists, lists, listModes });
        return { removedAccounts };
    }

    /**
     * Añade cuentas a listas propias existentes (ignora ids que no existen: no se crean listas desde aquí). \`handles\` admite @usuario, enlaces
     * o nombres sueltos; se descartan los no válidos. Devuelve { added, existing, invalid }.
     */
    /** Tope de cuentas propias (el mismo que al importar una copia). */
    const MAX_ACCOUNTS = 20000;

    function addAccounts(cfg, handles, listIds, extra = {}) {
        const ids = (listIds || []).filter(id => cfg.myLists && cfg.myLists[id]);
        const res = { added: 0, existing: 0, invalid: [], limited: 0 };
        if (!ids.length) return res;
        const accounts = { ...cfg.accounts };
        let size = Object.keys(accounts).length;
        for (const raw of handles) {
            const key = norm(raw);
            if (!key) { if (String(raw).trim()) res.invalid.push(String(raw).trim()); continue; }
            const prev = accounts[key];
            const tags = [...new Set([...((prev && prev.tags) || []), ...ids])];
            if (prev && ids.every(i => (prev.tags || []).includes(i))) { res.existing++; continue; }
            if (!prev && size >= MAX_ACCOUNTS) { res.limited++; continue; }
            if (!prev) size++;
            accounts[key] = prev ? { ...prev, tags, enabled: true, touched: true }
                : { handle: String(raw).trim().replace(/^@+/, '').replace(/^.*(?:x|twitter)\.com\//i, '').split(/[/?#\s]/)[0] || key, name: extra.name || '', tags, note: '', enabled: true, source: 'manual', touched: true };
            res.added++;
        }
        cfg.accounts = accounts;
        if (cfg.allowlist) cfg.allowlist = cfg.allowlist.filter(x => !handles.some(h => norm(h) === norm(x)));
        if (cfg.disabled) cfg.disabled = cfg.disabled.filter(x => !handles.some(h => norm(h) === norm(x)));
        return res;
    }

    /** Quita la cuenta de una lista. Si era su única lista, la cuenta se elimina (una cuenta propia siempre pertenece a alguna lista). */
    function removeFromList(cfg, key, id) {
        const a = cfg.accounts[key];
        if (!a) return 'none';
        const tags = (a.tags || []).filter(t => t !== id);
        const accounts = { ...cfg.accounts };
        if (tags.length) { accounts[key] = { ...a, tags, touched: true }; cfg.accounts = accounts; return 'removed'; }
        delete accounts[key]; cfg.accounts = accounts; return 'deleted';
    }

    /** Copia cuentas (p. ej. de una lista sincronizada) a una lista propia sin alterar la original. */
    function copyAccounts(cfg, handles, listId) { return addAccounts(cfg, handles, [listId]); }

    /** Cuentas propias sin ninguna lista (datos de versiones anteriores): se filtran siempre y conviene ordenarlas. */
    const orphans = cfg => Object.entries(cfg.accounts || {}).filter(([, a]) => !((a && a.tags) || []).length).map(([k]) => k);

    return { ID_RE, MAX_ACCOUNTS, slug, cleanName, resolve, checkName, create, rename, remove, members, addAccounts, removeFromList, copyAccounts, orphans };
});
