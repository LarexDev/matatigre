/**
 * Script de página (mundo MAIN, document_start). X no expone autor/cita/repost de forma estable en el DOM
 * (y su DOM actual ya no trae data-testid), pero sí lo entrega completo en las respuestas GraphQL que usa para
 * pintar el timeline. Aquí:
 *   1. se interceptan XHR y fetch hacia /graphql/;
 *   2. de cada tuit se extraen autor, repostero, cita, respuesta, menciones, texto e idioma;
 *   3. se decide con el mismo matcher que el resto de la extensión;
 *   4. en modo "ocultar" las publicaciones coincidentes se QUITAN de la respuesta (nunca llegan a pintarse);
 *      en los demás modos se avisa al content script (hits) para que las colapse o resalte en el DOM.
 * Todo error devuelve la respuesta original intacta: este script nunca debe romper X.
 *
 * Comunicación con el content script (mundo aislado): CustomEvent en `document` con `detail` en JSON string.
 *   ← matatigre:config   configuración compacta
 *   → matatigre:hello    "ya estoy escuchando, envíame la configuración"
 *   → matatigre:hits     { full, hits:[{ id, author, reposters, v:{handle,role,label} }] }
 *   → matatigre:drops    [{ id, handle, role, label }]
 *   → matatigre:diag     contadores y operaciones vistas
 */
(function () {
    'use strict';
    if (window.__matatigre) return;

    const { createMatcher, parseLocation } = window.XAF;
    const CFG_KEY = 'matatigre.cfg';
    const MAX_POSTS = 8000;
    const MAX_NODES = 400000;
    const MAX_BODY = 12 * 1024 * 1024;
    const GRAPHQL = /\/graphql\/[^/]+\/([A-Za-z0-9_]+)/;

    const diag = { version: 1, hooked: true, xhr: 0, fetch: 0, graphql: 0, posts: 0, hits: 0, dropped: 0, errors: 0, lastError: '', ops: {}, configured: false, seen: { quoted: 0, retweets: 0, replies: 0 }, tweetKeys: [], tweetLegacyKeys: [] };
    window.__matatigre = Object.freeze({ diag });

    let matcher = createMatcher({});
    let settings = matcher.settings;
    const store = new Map();   // id -> post efectivo (para reevaluar al cambiar la configuración)

    // ---------- comunicación ----------
    const emit = (name, payload) => {
        try { document.dispatchEvent(new CustomEvent('matatigre:' + name, { detail: JSON.stringify(payload) })); } catch { /* sin documento aún */ }
    };
    let diagTimer = 0;
    const emitDiagSoon = () => {
        if (diagTimer) return;
        diagTimer = setTimeout(() => { diagTimer = 0; emit('diag', diag); }, 700);
    };
    const fail = (where, e) => { diag.errors++; diag.lastError = `${where}: ${e && e.message || e}`; emitDiagSoon(); };

    function setConfig(cfg) {
        try {
            matcher = createMatcher(cfg || {});
            settings = matcher.settings;
            diag.configured = true;
            emitHits(true);
            emitDiagSoon();
        } catch (e) { fail('config', e); }
    }

    try { const raw = localStorage.getItem(CFG_KEY); if (raw) setConfig(JSON.parse(raw)); } catch { /* sin caché */ }
    document.addEventListener('matatigre:config', e => { try { setConfig(JSON.parse(e.detail)); } catch (err) { fail('config', err); } });

    // ---------- proyección de tuits ----------
    // El esquema de X cambia con frecuencia (comprobado en vivo: `legacy` ya casi no trae nada; el texto está en
    // `details.full_text` y las menciones en `mention_entities`). Por eso se buscan los campos por nombre, de forma
    // tolerante, y se complementan con el texto: nunca se depende de una única ruta.
    const isId = v => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v);
    const handleOf = v => (typeof v === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(v)) ? v : undefined;

    function unwrap(node) {
        for (let i = 0; i < 4 && node && node.__typename === 'TweetWithVisibilityResults'; i++) node = node.tweet;
        return node && typeof node === 'object' && !Array.isArray(node) ? node : null;
    }

    /** Un Tweet de verdad (no un User: los usuarios también tienen rest_id y core). */
    const isTweet = n => !!n && typeof n === 'object' && isId(n.rest_id) &&
        (!!n.core?.user_results || n.legacy?.full_text !== undefined || n.details?.full_text !== undefined);

    function userOf(node) {
        const u = node.core?.user_results?.result ?? node.user ?? null;
        if (!u) return {};
        return {
            handle: handleOf(u.core?.screen_name ?? u.legacy?.screen_name ?? u.screen_name),
            name: u.core?.name ?? u.legacy?.name ?? u.name,
            bio: u.profile_bio?.description ?? u.legacy?.description ?? u.description
        };
    }

    /** Tuits anidados (cita, retweet) con la ruta de claves que los separa del nodo. */
    function nestedTweets(node) {
        const found = [];
        const stack = [[node, '', 0]];
        while (stack.length) {
            const [obj, path, depth] = stack.pop();
            if (depth > 3) continue;
            for (const k in obj) {
                if (k === 'core' || k === 'user' || k === 'legacy_user') continue;
                const v = obj[k];
                if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
                const t = unwrap(v.result ?? v);
                if (t && t !== node && isTweet(t)) found.push({ path: path + '.' + k, node: t });
                else stack.push([v, path + '.' + k, depth + 1]);
            }
        }
        return found;
    }

    /** Primer string bajo una clave que cumpla `keyTest` en el propio tuit (sin entrar en tuits anidados ni en el usuario). */
    function ownString(node, keyTest, depth = 3) {
        const stack = [[node, 0]];
        while (stack.length) {
            const [obj, d] = stack.pop();
            for (const k in obj) {
                if (k === 'core' || k === 'user') continue;
                const v = obj[k];
                if (typeof v === 'string' && keyTest.test(k)) return v;
                if (v && typeof v === 'object' && !Array.isArray(v) && d < depth && !isTweet(unwrap(v.result ?? v))) stack.push([v, d + 1]);
            }
        }
        return undefined;
    }

    const REPLY_KEY = /^(in_)?reply(_to)?(_user)?_screen_name$/i;
    const QUOTE_PATH = /quot/i;
    const RETWEET_PATH = /retweet|repost/i;

    function mentionsOf(node, text) {
        const set = new Set();
        const add = arr => { for (const m of Array.isArray(arr) ? arr : []) { const h = handleOf(m && m.screen_name); if (h) set.add(h); } };
        add(node.mention_entities);
        add(node.legacy?.entities?.user_mentions);
        add(node.entities?.user_mentions);
        add(node.note_tweet?.note_tweet_results?.result?.entity_set?.user_mentions);
        for (const m of String(text).matchAll(/(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g)) set.add(m[1]);
        return [...set];
    }

    /** Proyección de un nodo Tweet; devuelve null si no lo es. */
    function project(raw, withNested = true) {
        const node = unwrap(raw);
        if (!isTweet(node)) return null;
        const u = userOf(node);
        const text = node.note_tweet?.note_tweet_results?.result?.text ?? node.details?.full_text ?? node.legacy?.full_text ?? node.legacy?.text ?? '';
        const post = {
            id: node.rest_id, author: u.handle, authorName: u.name, authorBio: u.bio, text,
            lang: node.legacy?.lang ?? node.lang, replyTo: handleOf(ownString(node, REPLY_KEY)),
            mentions: mentionsOf(node, text), reposters: [], quoted: null
        };
        if (!withNested) return post;
        let retweeted = null;
        for (const { path, node: child } of nestedTweets(node)) {
            const inner = project(child, false);
            if (!inner) continue;
            if (QUOTE_PATH.test(path)) {
                if (!post.quoted && inner.author) post.quoted = { author: inner.author, name: inner.authorName, bio: inner.authorBio };
            } else if (RETWEET_PATH.test(path)) {
                retweeted = child;
            }
        }
        if (retweeted) {
            const original = project(retweeted, true);
            if (original) return { ...original, reposters: u.handle ? [u.handle] : [], wrapperId: post.id };
        }
        return post;
    }

    function verdictRaw(post) {
        return matcher.evaluate({
            author: post.author, authorName: post.authorName, authorBio: post.authorBio, lang: post.lang, text: post.text,
            reposters: post.reposters, quoted: post.quoted?.author, quotedName: post.quoted?.name, quotedBio: post.quoted?.bio,
            replyTo: post.replyTo, mentions: post.mentions
        });
    }

    function remember(post) {
        const prev = store.get(post.id);
        if (prev) {
            for (const r of post.reposters) if (!prev.reposters.includes(r)) prev.reposters.push(r);
            post = { ...post, reposters: prev.reposters, quoted: post.quoted || prev.quoted };
            store.delete(post.id);
        } else {
            diag.posts++;
            if (post.quoted) diag.seen.quoted++;
            if (post.reposters.length) diag.seen.retweets++;
            if (post.replyTo) diag.seen.replies++;
        }
        store.set(post.id, post);
        if (store.size > MAX_POSTS) store.delete(store.keys().next().value);
        return post;
    }

    // ---------- avisos al content script ----------
    const hitRecord = (post, v) => ({ id: post.id, author: post.author, reposters: post.reposters, v: { handle: v.handle, role: v.role, label: v.label } });

    function emitHits(full, posts) {
        const hits = [];
        for (const post of full ? store.values() : posts) {
            const v = verdictRaw(post);
            if (v) hits.push(hitRecord(post, v));
        }
        diag.hits = hits.length;
        if (full || hits.length) emit('hits', { full, hits });
    }

    // ---------- filtrado de una respuesta ----------
    const currentLoc = () => parseLocation(location.pathname);

    function shouldDrop(raw, loc) {
        const wrapper = project(raw);
        if (!wrapper) return null;
        const v = verdictRaw(wrapper);
        if (!v || matcher.isExempt(loc, v, wrapper)) return null;
        return { id: wrapper.id, handle: v.handle, role: v.role, label: v.label };
    }

    /** Resultado de tuit de una entrada de timeline o item de módulo, tolerando envoltorios nuevos (profundidad ≤ 5). */
    function tweetResultOf(e) {
        const stack = [[e?.content ?? e?.item ?? e, 0]];
        while (stack.length) {
            const [o, d] = stack.pop();
            if (!o || typeof o !== 'object' || d > 5 || Array.isArray(o)) continue;
            const r = o.tweet_results?.result ?? o.tweet_result?.result;
            if (r) return r;
            if (o.itemContent) stack.push([o.itemContent, d + 1]);
            if (o.item) stack.push([o.item, d + 1]);
        }
        return undefined;
    }
    const isEntry = e => !!e && typeof e === 'object' && ('entryId' in e || 'entry_id' in e);

    /**
     * Recorre la respuesta: registra los tuits y, si `drop`, quita de las listas de entradas los que coinciden.
     * Devuelve true si modificó `data`.
     */
    function processData(data, drop) {
        const loc = currentLoc();
        const posts = [];
        const drops = [];
        const stack = [data];
        let nodes = 0, changed = false;

        const dropped = entry => {
            const hit = shouldDrop(tweetResultOf(entry), loc);
            if (hit) drops.push(hit);
            return !!hit;
        };

        while (stack.length && nodes++ < MAX_NODES) {
            const x = stack.pop();
            if (!x || typeof x !== 'object') continue;

            if (Array.isArray(x)) {
                if (drop && x.length && x.some(isEntry)) {
                    for (let i = x.length - 1; i >= 0; i--) {
                        const e = x[i];
                        if (!e || typeof e !== 'object') continue;
                        let remove = false;
                        if (tweetResultOf(e)) remove = dropped(e);
                        else if (Array.isArray(e.content?.items)) {
                            const before = e.content.items.length;
                            e.content.items = e.content.items.filter(it => !(tweetResultOf(it) && dropped(it)));
                            if (e.content.items.length !== before) { changed = true; if (!e.content.items.length) remove = true; }
                        }
                        if (remove) { x.splice(i, 1); changed = true; }
                    }
                }
                for (let i = 0; i < x.length; i++) if (x[i] && typeof x[i] === 'object') stack.push(x[i]);
                continue;
            }

            if (isTweet(x)) {
                const post = project(x);
                if (post && post.author) {
                    if (!diag.tweetKeys.length) { diag.tweetKeys = Object.keys(x).slice(0, 40); diag.tweetLegacyKeys = Object.keys(x.legacy || {}).slice(0, 40); }
                    posts.push(remember(post));
                }
            }
            for (const k in x) { const v = x[k]; if (v && typeof v === 'object') stack.push(v); }
        }

        if (drops.length) { diag.dropped += drops.length; emit('drops', drops); }
        if (posts.length) emitHits(false, posts.filter(p => !drops.some(d => d.id === p.id)));
        diag.graphql++;
        emitDiagSoon();
        return changed;
    }

    const dropEnabled = () => settings.enabled && settings.mode === 'hide' && settings.deepFilter;
    const opOf = url => { const m = GRAPHQL.exec(url || ''); return m ? m[1] : null; };
    const noteOp = op => { diag.ops[op] = (diag.ops[op] || 0) + 1; };

    /** Procesa un cuerpo de respuesta ya parseado; devuelve true si cambió. */
    function handle(url, data) {
        const op = opOf(url);
        if (!op || !data || typeof data !== 'object') return false;
        noteOp(op);
        try { return processData(data, dropEnabled()); } catch (e) { fail('process ' + op, e); return false; }
    }

    // ---------- XHR ----------
    const xhrInfo = new WeakMap();
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    XHR.open = function (method, url) {
        try { if (opOf(String(url))) xhrInfo.set(this, { url: String(url), done: false, text: null }); else xhrInfo.delete(this); } catch { /* ignorar */ }
        return origOpen.apply(this, arguments);
    };

    const origSend = XHR.send;
    XHR.send = function () {
        if (xhrInfo.has(this)) diag.xhr++;
        return origSend.apply(this, arguments);
    };

    const respDesc = Object.getOwnPropertyDescriptor(XHR, 'response');
    const textDesc = Object.getOwnPropertyDescriptor(XHR, 'responseText');

    function transformed(xhr, getRaw) {
        const raw = getRaw.call(xhr);
        const info = xhrInfo.get(xhr);
        if (!info || xhr.readyState !== 4 || xhr.status !== 200 || raw == null) return raw;
        try {
            if (typeof raw === 'object') {                       // responseType = 'json': ya parseado, se muta en sitio
                if (xhr.responseType !== 'json') return raw;
                if (!info.done) { info.done = true; handle(info.url, raw); }
                return raw;
            }
            if (typeof raw !== 'string' || raw.length > MAX_BODY || !/^\s*[{[]/.test(raw)) return raw;
            if (!info.done) {
                info.done = true;
                const data = JSON.parse(raw);
                info.text = handle(info.url, data) ? JSON.stringify(data) : null;
            }
            return info.text ?? raw;
        } catch (e) { fail('xhr', e); return raw; }
    }

    if (respDesc && respDesc.get) Object.defineProperty(XHR, 'response', { ...respDesc, get() { return transformed(this, respDesc.get); } });
    if (textDesc && textDesc.get) Object.defineProperty(XHR, 'responseText', { ...textDesc, get() { return transformed(this, textDesc.get); } });

    // ---------- fetch ----------
    const origFetch = window.fetch;
    window.fetch = function (input) {
        const promise = origFetch.apply(this, arguments);
        let url;
        try { url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url; } catch { /* ignorar */ }
        if (!opOf(url)) return promise;
        diag.fetch++;
        return promise.then(async res => {
            try {
                if (!res.ok) return res;
                const text = await res.clone().text();
                if (text.length > MAX_BODY) return res;
                const data = JSON.parse(text);
                if (!handle(url, data)) return res;
                return new Response(JSON.stringify(data), { status: res.status, statusText: res.statusText, headers: res.headers });
            } catch (e) { fail('fetch', e); return res; }
        });
    };

    emit('hello', { version: diag.version });
    emitDiagSoon();
})();
