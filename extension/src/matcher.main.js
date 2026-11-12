/**
 * Lógica pura de coincidencia (sin DOM ni chrome.*), compartida por el content script, el script de
 * página (mundo MAIN), las páginas de la extensión y las pruebas en Node.
 *
 * Modelo de configuración (chrome.storage.local):
 *   settings   { enabled, mode, deepFilter, filterReposters, filterQuoted, filterReplies, filterMentions,
 *                filterUserCells, pauseOnProfile, keepFocal, scope:{home,search,...} }
 *   accounts   { [handleLower]: { handle, name, tags[], note, enabled, source } }
 *   lists      { [tag]: boolean }            // listas (etiquetas) activas
 *   listModes  { [tag]: 'hide'|'collapse'|'highlight' }   // modo propio de una lista (si falta, rige settings.mode)
 *   rules      [{ id, kind, mode, pattern, enabled, note }]
 *   allowlist  [handle]                      // nunca se ocultan, tiene prioridad
 *   subs / listData / disabled               // listas suscritas y su copia local (ver composeConfig)
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.XAF = Object.assign(root.XAF || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
    const USER_ID_RE = /^[1-9][0-9]{0,19}$/;

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
        showBar: true,           // contador "N ocultas" (solo informa) en la página
        addButton: true,         // botón "Añadir @usuario" al pasar el ratón sobre una publicación
        observe: false,          // registro local de publicaciones y cuentas vistas (para análisis); apagado por defecto
        analyst: false,          // modo analista: muestra la pestaña Análisis y deja que el registro funcione (ver captureOn)
        watch: true,             // con el registro activo, seguir también a las cuentas externas que interactúan a menudo con las listas
        theme: 'auto',           // apariencia de las pantallas de la extensión: auto (la del sistema), light, dark
        keepTextDays: 14,        // días que se conserva el texto del registro (después solo queda su huella)
        scope: Object.freeze({ home: true, search: true, profile: true, status: true, list: true, notifications: true, bookmarks: true, other: true })
    });

    /** Perfiles de un clic: qué se oculta y cómo. Todo lo demás de los ajustes queda como está. */
    const PROFILES = Object.freeze({
        strict: Object.freeze({ mode: 'hide', filterReposters: true, filterQuoted: true, filterReplies: true, filterMentions: true, filterUserCells: true }),
        moderate: Object.freeze({ mode: 'hide', filterReposters: true, filterQuoted: true, filterReplies: false, filterMentions: false, filterUserCells: true }),
        mark: Object.freeze({ mode: 'highlight', filterReposters: true, filterQuoted: true, filterReplies: false, filterMentions: false, filterUserCells: true })
    });
    /** Perfil que coincide con los ajustes actuales, o null si están personalizados. */
    const profileOf = s => Object.keys(PROFILES).find(k => Object.entries(PROFILES[k]).every(([key, v]) => s && s[key] === v)) || null;

    /**
     * El «por qué» de una ocultación, en una frase que dice qué está ocurriendo con la cuenta de la lista: «Citando a @x», «Respondiendo a @x»,
     * «Mencionando a @x»; y, cuando la cuenta es la que actúa, «Publicación de @x» o «Reposteado por @x».
     */
    function whyPhrase(role, handle, label) {
        const who = handle ? '@' + handle : (label || 'esa cuenta');
        switch (role) {
            case 'author': return 'Publicación de ' + who;
            case 'reposter': return 'Reposteado por ' + who;
            case 'quoted': return 'Citando a ' + who;
            case 'replyTo': return 'Respondiendo a ' + who;
            case 'mention': return 'Mencionando a ' + who;
            case 'text': return 'Su texto coincide con una regla';
            case 'lang': return 'Su idioma coincide con una regla';
            default: return label || '';
        }
    }

    const THEMES = ['auto', 'light', 'dark'];
    /** Fusiona ajustes guardados con los valores por defecto (incluido `scope`). */
    function resolveSettings(stored) {
        const s = stored || {};
        const days = Number(s.keepTextDays);
        return { ...DEFAULT_SETTINGS, ...s, analyst: typeof s.analyst === 'boolean' ? s.analyst : !!s.observe, theme: THEMES.includes(s.theme) ? s.theme : 'auto', keepTextDays: Number.isFinite(days) ? Math.min(365, Math.max(1, Math.round(days))) : DEFAULT_SETTINGS.keepTextDays, scope: { ...DEFAULT_SETTINGS.scope, ...(s.scope || {}) } };
    }

    /** ¿Debe correr el registro local? Solo con el modo analista activo y el registro encendido. */
    const captureOn = s => !!(s && s.observe && s.analyst);

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
    const MODES = ['hide', 'collapse', 'highlight'];
    const MODE_SET = new Set(MODES);
    const MODE_RANK = Object.freeze({ highlight: 1, collapse: 2, hide: 3 });
    const withRole = (v, role) => (v ? { ...v, role } : null);

    /**
     * Capas de cuentas. Una configuración puede traer, además de `accounts` (las cuentas propias del usuario),
     *   subs      [{ id, name, url, source }]       listas a las que está suscrito
     *   listData  { [id]: { accounts:[{handle,name}] } }   última copia buena de cada lista (solo lectura)
     *   disabled  [handle]                           cuentas de listas suscritas que el usuario desactivó
 *   uids      { [handle]: id de usuario }        ids aprendidos de las respuestas de X (una cuenta se reconoce por id aunque cambie de nombre)
     * `composeConfig` las aplana en { settings, accounts, lists, rules, allowlist }, que es lo único que
     * entienden el matcher y el script de página. La etiqueta de cada cuenta de una suscripción es el id de la lista,
     * así que el interruptor `lists[id]` la enciende o apaga entera.
     * Precedencia: lista blanca > cuenta propia desactivada > cuenta propia > suscripciones.
     */
    function composeConfig(cfg = {}) {
        const accounts = {};
        const disabled = new Set((cfg.disabled || []).map(normalizeHandle).filter(Boolean));
        for (const sub of cfg.subs || []) {
            const data = cfg.listData && cfg.listData[sub.id];
            if (!data || !Array.isArray(data.accounts)) continue;
            for (const a of data.accounts) {
                const key = normalizeHandle(a && a.handle);
                if (!key || disabled.has(key)) continue;
                const e = accounts[key] || (accounts[key] = { handle: a.handle, name: a.name || '', tags: [], enabled: true, source: 'list' });
                if (!e.uid && USER_ID_RE.test(String(a.id || ''))) e.uid = String(a.id);
                if (!e.tags.includes(sub.id)) e.tags.push(sub.id);
                if (!e.name && a.name) e.name = a.name;
            }
        }
        for (const [rawKey, u] of Object.entries(cfg.accounts || {})) {
            if (!u) continue;
            const key = rawKey.toLowerCase();
            const e = accounts[key];
            if (!e) { accounts[key] = u; continue; }
            if (u.enabled === false) accounts[key] = { ...e, enabled: false };
            else if (!(u.tags || []).length) accounts[key] = { ...e, tags: [], name: u.name || e.name };
            else accounts[key] = { ...e, tags: [...new Set([...e.tags, ...u.tags])], name: u.name || e.name };
        }
        // Ids aprendidos (solo para cuentas que no traen el suyo).
        const uids = cfg.uids || {};
        for (const [key, acc] of Object.entries(accounts)) {
            const id = uids[key];
            if (id && !acc.uid && USER_ID_RE.test(String(id))) accounts[key] = { ...acc, uid: String(id) };
        }
        return { settings: cfg.settings, accounts, lists: cfg.lists || {}, listModes: cfg.listModes || {}, rules: cfg.rules || [], allowlist: cfg.allowlist || [] };
    }

    /**
     * Construye un matcher inmutable a partir de la configuración.
     * `evaluate(ctx)` admite: author, authorName, authorBio, lang, text, reposter | reposters[],
     * quoted, quotedName, quotedBio, replyTo, mentions[].
     */
    function createMatcher(rawConfig = {}) {
        const config = composeConfig(rawConfig);
        const settings = resolveSettings(config.settings);
        const lists = config.lists || {};
        const accounts = config.accounts || {};
        const allow = new Set((config.allowlist || []).map(normalizeHandle).filter(Boolean));

        const listModes = config.listModes || {};
        // Modo efectivo de una cuenta: el más restrictivo entre sus listas encendidas (cada una con su modo o el general).
        const active = new Map();
        const byUid = new Map();   // id de usuario -> { key, mode }
        for (const [key, acc] of Object.entries(accounts)) {
            if (!acc || acc.enabled === false) continue;
            const tags = acc.tags || [];
            const on = tags.filter(t => lists[t] !== false);
            if (tags.length && !on.length) continue;
            let mode = settings.mode;
            if (on.length) mode = on.map(t => (MODE_SET.has(listModes[t]) ? listModes[t] : settings.mode)).reduce((a, b) => (MODE_RANK[b] > MODE_RANK[a] ? b : a));
            active.set(key.toLowerCase(), { acc, mode, uid: acc.uid || null, on });
            if (acc.uid) byUid.set(String(acc.uid), { key: key.toLowerCase(), mode, on });
        }

        // Cuentas "seguidas": las de cualquier lista (propia o suscrita), tengan la lista encendida o no. Son las que el análisis observa.
        const tracked = new Map();
        const trackedIds = new Set();
        for (const [key, acc] of Object.entries(accounts)) {
            if (!acc || acc.enabled === false) continue;
            tracked.set(key.toLowerCase(), acc.uid ? String(acc.uid) : null);
            if (acc.uid) trackedIds.add(String(acc.uid));
        }
        /** ¿Pertenece la cuenta a alguna lista? Por id si se conoce; si el nombre figura con otro id, ya es de otra persona. */
        function isTracked(handle, uid) {
            const id = uid && USER_ID_RE.test(String(uid)) ? String(uid) : null;
            if (id && trackedIds.has(id)) return true;
            const h = normalizeHandle(handle);
            if (!h || !tracked.has(h)) return false;
            const known = tracked.get(h);
            return !(known && id && known !== id);
        }

        const rules = Object.fromEntries(RULE_KINDS.map(k => [k, []]));
        for (const r of config.rules || []) {
            if (!r || r.enabled === false || !rules[r.kind]) continue;
            const test = compilePattern(r.mode, r.pattern);
            if (test) rules[r.kind].push({ rule: r, test });
        }

        /**
         * Coincidencia por cuenta. Con id de usuario (`uid`) se reconoce a la cuenta aunque haya cambiado de nombre; y si el nombre
         * de usuario de una cuenta de la lista aparece ahora con OTRO id, el nombre ha pasado a otra persona y no se filtra.
         * Si coincide por nombre y la cuenta aún no tiene id, el veredicto trae `learn: { h, id }` para que se aprenda.
         */
        function matchHandle(handle, displayName, bio, uid) {
            const h = normalizeHandle(handle);
            const id = uid && USER_ID_RE.test(String(uid)) ? String(uid) : null;
            if (id && byUid.has(id)) {
                const b = byUid.get(id);
                if (h && allow.has(h)) return null;
                const cur = h || b.key;
                return { type: 'account', handle: cur, label: '@' + cur, mode: b.mode, uid: id, renamed: !!h && h !== b.key, lists: b.on };
            }
            if (!h || allow.has(h)) return null;
            const a = active.get(h);
            if (a && id && a.uid && a.uid !== id) return null;          // reasignado: ese nombre ya es de otra persona
            if (a) return { type: 'account', handle: h, label: '@' + h, mode: a.mode, lists: a.on, ...(id && !a.uid ? { learn: { h, id } } : {}) };
            for (const { rule, test } of rules.handle) if (test(h)) return { type: 'rule', handle: h, rule, mode: settings.mode, label: `regla "${rule.pattern}"` };
            if (displayName) for (const { rule, test } of rules.name) if (test(displayName)) return { type: 'rule', handle: h, rule, mode: settings.mode, label: `nombre "${rule.pattern}"` };
            if (bio) for (const { rule, test } of rules.bio) if (test(bio)) return { type: 'rule', handle: h, rule, mode: settings.mode, label: `bio "${rule.pattern}"` };
            return null;
        }

        /**
         * Evalúa todos los roles de una publicación y devuelve el veredicto de modo más restrictivo
         * (ocultar > colapsar > resaltar); a igualdad gana el primero en este orden: autor, idioma, texto, repost, cita, respuesta, mención.
         */
        function evaluate(ctx) {
            const author = normalizeHandle(ctx.author);
            if (author && allow.has(author)) return null;     // la lista blanca del autor gana siempre

            let best = null;
            const consider = v => {
                if (v && (!best || MODE_RANK[v.mode] > MODE_RANK[best.mode])) best = v;
                return !!best && best.mode === 'hide';          // ya no puede haber nada más restrictivo
            };

            if (consider(withRole(matchHandle(ctx.author, ctx.authorName, ctx.authorBio, ctx.authorId), 'author'))) return best;

            if (ctx.lang) for (const { rule, test } of rules.lang) if (test(String(ctx.lang))) { if (consider({ type: 'rule', handle: author, rule, role: 'lang', mode: settings.mode, label: `idioma "${rule.pattern}"` })) return best; break; }
            if (ctx.text) for (const { rule, test } of rules.text) if (test(ctx.text)) { if (consider({ type: 'rule', handle: author, rule, role: 'text', mode: settings.mode, label: `texto "${rule.pattern}"` })) return best; break; }

            if (settings.filterReposters) {
                const rs = ctx.reposters || (ctx.reposter ? [ctx.reposter] : []);
                for (let i = 0; i < rs.length; i++) if (consider(withRole(matchHandle(rs[i], undefined, undefined, (ctx.reposterIds || [])[i]), 'reposter'))) return best;
            }
            if (settings.filterQuoted && (ctx.quoted || ctx.quotedId) && consider(withRole(matchHandle(ctx.quoted, ctx.quotedName, ctx.quotedBio, ctx.quotedId), 'quoted'))) return best;
            if (settings.filterReplies && ctx.replyTo && consider(withRole(matchHandle(ctx.replyTo), 'replyTo'))) return best;
            if (settings.filterMentions) {
                for (const m of ctx.mentions || []) if (consider(withRole(matchHandle(m), 'mention'))) return best;
            }
            return best;
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
            isTracked,
            trackedCount: tracked.size,
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
    function compactConfig(raw) {
        const cfg = composeConfig(raw);
        const accounts = {};
        for (const [k, a] of Object.entries(cfg.accounts)) if (a && a.enabled !== false) accounts[k] = { tags: a.tags || [], ...(a.uid ? { uid: a.uid } : {}) };
        return { settings: resolveSettings(cfg.settings), accounts, lists: cfg.lists, listModes: cfg.listModes, rules: cfg.rules.filter(r => r && r.enabled !== false), allowlist: cfg.allowlist };
    }

    // ---------- listas suscribibles (formato de los archivos descargados) ----------
    const LIST_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
    /** Límites para que la extensión no se sature: por lista, entre todas las sincronizadas, número de listas y cuentas propias. */
    const LIMITS = Object.freeze({ listAccounts: 5000, syncedTotal: 25000, subs: 30, ownAccounts: 20000 });
    const MAX_LIST_ACCOUNTS = LIMITS.listAccounts;
    const MAX_CATALOG_LISTS = 100;

    /** https siempre; http solo hacia la propia máquina (desarrollo y pruebas). Sin credenciales en la URL. */
    function isAllowedListUrl(value) {
        let u;
        try { u = new URL(String(value)); } catch { return false; }
        if (String(value).length > 500 || u.username || u.password) return false;
        if (u.protocol === 'https:') return true;
        return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    }

    /** Resuelve la ruta de una lista respecto a la URL del catálogo y comprueba que sea admisible. */
    function resolveListUrl(base, path) {
        try {
            const href = new URL(String(path), String(base)).href;
            return isAllowedListUrl(href) ? href : null;
        } catch { return null; }
    }

    /**
     * Valida un archivo de lista descargado ({ schema:1, id, name, description, version, updated, accounts[] }).
     * Devuelve { ok:true, list } con datos normalizados y sin duplicados, o { ok:false, error }.
     */
    function sanitizeList(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'No es un objeto JSON.' };
        if (input.schema !== 1) return { ok: false, error: 'Versión de formato no admitida (se esperaba schema 1).' };
        if (!Array.isArray(input.accounts)) return { ok: false, error: 'Falta la lista de cuentas.' };
        const seen = new Set();
        const accounts = [];
        for (const a of input.accounts.slice(0, MAX_LIST_ACCOUNTS)) {
            const raw = typeof a === 'string' ? a : a && a.handle;
            const key = normalizeHandle(raw);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const url = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#\s]+)/i.exec(String(raw).trim());
            const bare = (url ? url[1] : String(raw).trim()).replace(/^@+/, '');
            const entry = { handle: HANDLE_RE.test(bare) ? bare : key, name: typeof a === 'object' ? str(a.name, 120) : '' };
            if (typeof a === 'object' && USER_ID_RE.test(String(a.id || ''))) entry.id = String(a.id);
            accounts.push(entry);
        }
        const id = typeof input.id === 'string' && LIST_ID_RE.test(input.id) ? input.id : '';
        return {
            ok: true,
            list: { schema: 1, id, name: str(input.name, 80) || id, description: str(input.description, 300), version: str(String(input.version ?? ''), 40), updated: str(String(input.updated ?? ''), 30), accounts }
        };
    }

    /** Valida el catálogo ({ schema:1, lists:[{ id, name, description, path, recommended, count }], withdrawn:[id] }). */
    function sanitizeCatalog(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'No es un objeto JSON.' };
        if (input.schema !== 1 || !Array.isArray(input.lists)) return { ok: false, error: 'Catálogo con formato no admitido.' };
        const seen = new Set();
        const lists = [];
        for (const l of input.lists.slice(0, MAX_CATALOG_LISTS)) {
            if (!l || typeof l.id !== 'string' || !LIST_ID_RE.test(l.id) || seen.has(l.id) || typeof l.path !== 'string' || !l.path || l.path.length > 300) continue;
            seen.add(l.id);
            lists.push({
                id: l.id, name: str(l.name, 80) || l.id, description: str(l.description, 300), path: l.path,
                recommended: l.recommended === true,
                count: Number.isInteger(l.count) && l.count >= 0 ? l.count : null
            });
        }
        const withdrawn = (Array.isArray(input.withdrawn) ? input.withdrawn : []).filter(id => typeof id === 'string' && LIST_ID_RE.test(id)).slice(0, 200);
        return { ok: true, catalog: { schema: 1, name: str(input.name, 80), updated: str(String(input.updated ?? ''), 30), lists, withdrawn } };
    }

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
                else if (k === 'theme') { if (THEMES.includes(v)) s.theme = v; }
                else if (typeof v === typeof def) s[k] = v;
            }
            out.settings = resolveSettings(s);
        }

        if (input.accounts && typeof input.accounts === 'object') {
            const list = Array.isArray(input.accounts) ? input.accounts : Object.values(input.accounts);
            const accounts = {};
            for (const a of list.slice(0, LIMITS.ownAccounts)) {
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

        if (input.myLists && typeof input.myLists === 'object' && !Array.isArray(input.myLists)) {
            out.myLists = Object.fromEntries(Object.entries(input.myLists).filter(([k, v]) => k.length <= 40 && !/s/.test(k) && v && typeof v === 'object').slice(0, 200).map(([k, v]) => [k, { name: str(v.name, 60) || k, created: Number(v.created) || 0 }]));
        }

        if (input.lists && typeof input.lists === 'object' && !Array.isArray(input.lists)) {
            out.lists = Object.fromEntries(Object.entries(input.lists).filter(([k, v]) => typeof v === 'boolean' && k.length <= 40).slice(0, 200));
        }

        if (Array.isArray(input.rules)) {
            out.rules = input.rules.slice(0, 500).filter(r => r && RULE_KINDS.includes(r.kind) && RULE_MODES.includes(r.mode) && compilePattern(r.mode, str(r.pattern, 300)))
                .map(r => ({ id: str(r.id, 64) || Math.random().toString(36).slice(2), kind: r.kind, mode: r.mode, pattern: str(r.pattern, 300), note: str(r.note, 200), enabled: r.enabled !== false }));
        }

        if (input.listModes && typeof input.listModes === 'object' && !Array.isArray(input.listModes)) {
            out.listModes = Object.fromEntries(Object.entries(input.listModes).filter(([k, v]) => k.length <= 40 && MODE_SET.has(v)).slice(0, 200));
        }

        if (Array.isArray(input.allowlist)) out.allowlist = [...new Set(input.allowlist.map(normalizeHandle).filter(Boolean))].slice(0, 20000);
        if (Array.isArray(input.disabled)) out.disabled = [...new Set(input.disabled.map(normalizeHandle).filter(Boolean))].slice(0, 20000);

        // Suscripciones: de un archivo ajeno solo se aceptan ids del catálogo (la URL se obtiene del catálogo, nunca del archivo),
        // para que importar una copia de seguridad no pueda hacer que la extensión descargue de un sitio arbitrario.
        if (Array.isArray(input.subs)) {
            out.catalogSubs = [...new Set(input.subs.filter(s => s && s.source === 'catalog' && typeof s.id === 'string' && LIST_ID_RE.test(s.id)).map(s => s.id))].slice(0, MAX_CATALOG_LISTS);
        }
        return out;
    }

    return { DEFAULT_SETTINGS, SCOPES, RULE_KINDS, LIST_ID_RE, USER_ID_RE, composeConfig, isAllowedListUrl, resolveListUrl, sanitizeList, sanitizeCatalog, sanitizeConfig, resolveSettings, captureOn, LIMITS, PROFILES, profileOf, whyPhrase, normalizeHandle, normalizeText, compilePattern, createMatcher, parseLocation, compactConfig };
});
