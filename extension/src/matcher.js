/**
 * Lógica pura de coincidencia (sin DOM ni chrome.*), compartida por el content script, el script de
 * página (mundo MAIN), las páginas de la extensión y las pruebas en Node.
 *
 * Modelo de configuración (chrome.storage.local):
 *   settings   { enabled, mode, deepFilter, filterReposters, filterQuoted, filterReplies, filterMentions,
 *                filterUserCells, pauseOnProfile, keepFocal, scope:{home,search,...} }
 *   accounts   { [handleLower]: { handle, name, tags[], note, enabled, source } }
 *   lists      { [tag]: boolean }            // listas (etiquetas) activas
 *   rules      [{ id, kind, mode, pattern, enabled, note }]
 *   allowlist  [handle]                      // nunca se ocultan, tiene prioridad
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.XAF = Object.assign(root.XAF || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

    const SCOPES = Object.freeze(['home', 'search', 'profile', 'status', 'list', 'notifications', 'bookmarks', 'other']);

    const DEFAULT_SETTINGS = Object.freeze({
        enabled: true,
        mode: 'hide',            // 'hide' | 'collapse' (barra con opción de revelar) | 'highlight' (sólo resalta)
        deepFilter: true,        // en modo "hide": quitar las publicaciones de las respuestas de la API antes de que X las pinte
        filterReposters: true,   // reposts/actividad hechos por cuentas listadas
        filterQuoted: true,      // publicaciones que citan a una cuenta listada
        filterReplies: false,    // respuestas dirigidas a una cuenta listada
        filterMentions: false,   // publicaciones que mencionan a una cuenta listada
        filterUserCells: true,   // listados de personas (sugerencias, búsqueda)
        pauseOnProfile: true,    // no filtrar dentro del perfil de la propia cuenta listada
        keepFocal: true,         // no ocultar la publicación abierta explícitamente
        scope: Object.freeze({ home: true, search: true, profile: true, status: true, list: true, notifications: true, bookmarks: true, other: true })
    });

    /** Fusiona ajustes guardados con los valores por defecto (incluido `scope`). */
    function resolveSettings(stored) {
        const s = stored || {};
        return { ...DEFAULT_SETTINGS, ...s, scope: { ...DEFAULT_SETTINGS.scope, ...(s.scope || {}) } };
    }

    /** "@Foo", "https://x.com/Foo/status/1", " foo " → "foo"; null si no es un handle válido. */
    function normalizeHandle(input) {
        if (typeof input !== 'string') return null;
        let s = input.trim();
        const url = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#\s]+)/i.exec(s);
        if (url) s = url[1];
        s = s.replace(/^@+/, '');
        return HANDLE_RE.test(s) ? s.toLowerCase() : null;
    }

    function normalizeText(s) {
        return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    }

    function escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /** Compila una regla a un predicado sobre un string; devuelve null si es inválida. */
    function compilePattern(mode, pattern) {
        const p = String(pattern ?? '').trim();
        if (!p) return null;
        try {
            if (mode === 'regex') {
                const re = new RegExp(p, 'iu');
                return s => re.test(s);
            }
            if (mode === 'glob') {
                const re = new RegExp('^' + normalizeText(p).split('*').map(escapeRegex).join('.*') + '$', 'u');
                return s => re.test(normalizeText(s));
            }
            const needle = normalizeText(p);
            return s => normalizeText(s).includes(needle);
        } catch {
            return null;
        }
    }

    const RULE_KINDS = ['handle', 'name', 'bio', 'text', 'lang'];

    /**
     * Construye un matcher inmutable a partir de la configuración.
     * `evaluate(ctx)` admite: author, authorName, authorBio, lang, text, reposter | reposters[],
     * quoted, quotedName, quotedBio, replyTo, mentions[].
     */
    function createMatcher(config = {}) {
        const settings = resolveSettings(config.settings);
        const lists = config.lists || {};
        const accounts = config.accounts || {};
        const allow = new Set((config.allowlist || []).map(normalizeHandle).filter(Boolean));

        const active = new Map();
        for (const [key, acc] of Object.entries(accounts)) {
            if (!acc || acc.enabled === false) continue;
            const tags = acc.tags || [];
            if (tags.length && !tags.some(t => lists[t] !== false)) continue;
            active.set(key.toLowerCase(), acc);
        }

        const rules = Object.fromEntries(RULE_KINDS.map(k => [k, []]));
        for (const r of config.rules || []) {
            if (!r || r.enabled === false || !rules[r.kind]) continue;
            const test = compilePattern(r.mode, r.pattern);
            if (test) rules[r.kind].push({ rule: r, test });
        }

        function matchHandle(handle, displayName, bio) {
            const h = normalizeHandle(handle);
            if (!h || allow.has(h)) return null;
            if (active.has(h)) return { type: 'account', handle: h, label: '@' + h };
            for (const { rule, test } of rules.handle) if (test(h)) return { type: 'rule', handle: h, rule, label: `regla "${rule.pattern}"` };
            if (displayName) for (const { rule, test } of rules.name) if (test(displayName)) return { type: 'rule', handle: h, rule, label: `nombre "${rule.pattern}"` };
            if (bio) for (const { rule, test } of rules.bio) if (test(bio)) return { type: 'rule', handle: h, rule, label: `bio "${rule.pattern}"` };
            return null;
        }

        function evaluate(ctx) {
            const author = normalizeHandle(ctx.author);
            if (author && allow.has(author)) return null;     // la lista blanca del autor gana siempre

            let hit = matchHandle(ctx.author, ctx.authorName, ctx.authorBio);
            if (hit) return { ...hit, role: 'author' };

            if (ctx.lang) for (const { rule, test } of rules.lang) if (test(String(ctx.lang))) return { type: 'rule', handle: author, rule, role: 'lang', label: `idioma "${rule.pattern}"` };
            if (ctx.text) for (const { rule, test } of rules.text) if (test(ctx.text)) return { type: 'rule', handle: author, rule, role: 'text', label: `texto "${rule.pattern}"` };

            if (settings.filterReposters) {
                for (const r of ctx.reposters || (ctx.reposter ? [ctx.reposter] : [])) {
                    hit = matchHandle(r);
                    if (hit) return { ...hit, role: 'reposter' };
                }
            }
            if (settings.filterQuoted && ctx.quoted) {
                hit = matchHandle(ctx.quoted, ctx.quotedName, ctx.quotedBio);
                if (hit) return { ...hit, role: 'quoted' };
            }
            if (settings.filterReplies && ctx.replyTo) {
                hit = matchHandle(ctx.replyTo);
                if (hit) return { ...hit, role: 'replyTo' };
            }
            if (settings.filterMentions) {
                for (const m of ctx.mentions || []) {
                    hit = matchHandle(m);
                    if (hit) return { ...hit, role: 'mention' };
                }
            }
            return null;
        }

        /**
         * ¿Debe respetarse este veredicto en la ubicación actual?
         * (ámbito apagado, perfil de la propia cuenta listada, publicación abierta)
         */
        function isExempt(loc, verdict, post = {}) {
            if (settings.scope[loc.scope || 'other'] === false) return true;
            if (loc.kind === 'profile' && settings.pauseOnProfile &&
                (verdict.handle === loc.handle || normalizeHandle(post.author) === loc.handle || (post.reposters || [post.reposter]).some(r => normalizeHandle(r) === loc.handle))) return true;
            if (loc.kind === 'status' && settings.keepFocal && post.id && post.id === loc.statusId) return true;
            return false;
        }

        return {
            settings,
            matchHandle,
            evaluate,
            isExempt,
            accountCount: active.size,
            ruleCount: RULE_KINDS.reduce((n, k) => n + rules[k].length, 0),
            usesText: rules.text.length > 0
        };
    }

    /** Parsea la ruta de X: perfil propio, publicación abierta, u otra, más el ámbito (`scope`). */
    function parseLocation(pathname) {
        const parts = String(pathname || '/').split('/').filter(Boolean);
        const first = (parts[0] || '').toLowerCase();
        if (!parts.length || first === 'home') return { kind: 'other', scope: 'home' };
        if (first === 'search' || first === 'explore') return { kind: 'other', scope: 'search' };
        if (first === 'notifications') return { kind: 'other', scope: 'notifications' };
        if (first === 'i' && (parts[1] === 'bookmarks' || parts[1] === 'bookmark')) return { kind: 'other', scope: 'bookmarks' };
        if (first === 'i' && parts[1] === 'lists') return { kind: 'other', scope: 'list' };
        const RESERVED = new Set(['messages', 'i', 'settings', 'compose', 'tos', 'privacy', 'login', 'logout', 'jobs', 'communities']);
        if (RESERVED.has(first)) return { kind: 'other', scope: 'other' };
        const handle = normalizeHandle(parts[0]);
        if (!handle) return { kind: 'other', scope: 'other' };
        if (parts[1] === 'status' && /^\d+$/.test(parts[2] || '')) return { kind: 'status', handle, statusId: parts[2], scope: 'status' };
        if (parts[1] === 'lists') return { kind: 'other', scope: 'list' };
        const PROFILE_TABS = new Set(['with_replies', 'media', 'likes', 'highlights', 'articles', 'followers', 'following', 'verified_followers']);
        if (parts.length === 1 || PROFILE_TABS.has(parts[1])) return { kind: 'profile', handle, scope: 'profile' };
        return { kind: 'other', scope: 'other' };
    }

    /** Configuración mínima para el script de página: sólo lo necesario para decidir. */
    function compactConfig(cfg) {
        const accounts = {};
        for (const [k, a] of Object.entries(cfg.accounts || {})) if (a && a.enabled !== false) accounts[k] = { tags: a.tags || [] };
        return { settings: resolveSettings(cfg.settings), accounts, lists: cfg.lists || {}, rules: (cfg.rules || []).filter(r => r && r.enabled !== false), allowlist: cfg.allowlist || [] };
    }

    /** Fusiona la semilla nueva sin pisar ediciones del usuario. */
    function mergeSeed(existing, seedAccounts) {
        const out = { ...existing };
        let added = 0, updated = 0;
        for (const a of seedAccounts) {
            const key = normalizeHandle(a.handle);
            if (!key) continue;
            const prev = out[key];
            if (!prev) {
                out[key] = { handle: a.handle, name: a.name || '', tags: a.tags || [], note: a.note || '', enabled: a.enabled !== false, source: 'seed', touched: false };
                added++;
            } else if (prev.source === 'seed' && !prev.touched) {
                out[key] = { ...prev, name: a.name || prev.name, tags: a.tags || prev.tags, note: a.note || prev.note, enabled: a.enabled !== false };
                updated++;
            }
        }
        return { accounts: out, added, updated };
    }

    const MODES = ['hide', 'collapse', 'highlight'];
    const RULE_MODES = ['glob', 'contains', 'regex'];
    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

    /**
     * Valida y normaliza datos importados (JSON ajeno): sólo tipos y valores conocidos, con límites de tamaño.
     * Devuelve únicamente las claves presentes. `accounts` admite un mapa o una lista de { handle, ... }.
     */
    function sanitizeConfig(input) {
        const out = {};
        if (!input || typeof input !== 'object' || Array.isArray(input)) return out;

        if (input.settings && typeof input.settings === 'object') {
            const s = {};
            for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
                const v = input.settings[k];
                if (k === 'scope') { if (v && typeof v === 'object') s.scope = Object.fromEntries(SCOPES.filter(sc => typeof v[sc] === 'boolean').map(sc => [sc, v[sc]])); }
                else if (k === 'mode') { if (MODES.includes(v)) s.mode = v; }
                else if (typeof v === typeof def) s[k] = v;
            }
            out.settings = resolveSettings(s);
        }

        if (input.accounts && typeof input.accounts === 'object') {
            const list = Array.isArray(input.accounts) ? input.accounts : Object.values(input.accounts);
            const accounts = {};
            for (const a of list.slice(0, 20000)) {
                const key = a && normalizeHandle(a.handle);
                if (!key) continue;
                accounts[key] = {
                    handle: str(a.handle, 15).replace(/^@+/, '') || key,
                    name: str(a.name, 120),
                    tags: (Array.isArray(a.tags) ? a.tags : []).map(t => str(t, 40).toLowerCase().replace(/\s+/g, '-')).filter(Boolean).slice(0, 20),
                    note: str(a.note, 500),
                    enabled: a.enabled !== false,
                    source: 'import',
                    touched: true
                };
            }
            out.accounts = accounts;
        }

        if (input.lists && typeof input.lists === 'object' && !Array.isArray(input.lists)) {
            out.lists = Object.fromEntries(Object.entries(input.lists).filter(([k, v]) => typeof v === 'boolean' && k.length <= 40).slice(0, 200));
        }

        if (Array.isArray(input.rules)) {
            out.rules = input.rules.slice(0, 500).filter(r => r && RULE_KINDS.includes(r.kind) && RULE_MODES.includes(r.mode) && compilePattern(r.mode, str(r.pattern, 300)))
                .map(r => ({ id: str(r.id, 64) || Math.random().toString(36).slice(2), kind: r.kind, mode: r.mode, pattern: str(r.pattern, 300), note: str(r.note, 200), enabled: r.enabled !== false }));
        }

        if (Array.isArray(input.allowlist)) out.allowlist = [...new Set(input.allowlist.map(normalizeHandle).filter(Boolean))].slice(0, 20000);
        return out;
    }

    return { DEFAULT_SETTINGS, SCOPES, RULE_KINDS, sanitizeConfig, resolveSettings, normalizeHandle, normalizeText, compilePattern, createMatcher, parseLocation, compactConfig, mergeSeed };
});
