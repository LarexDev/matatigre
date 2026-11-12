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
 *   → matatigre:hits     { full, hits:[{ id, author, reposters, v:{handle,role,label,lists} }] }
 *   → matatigre:drops    [{ id, handle, role, label, lists }]
 *   → matatigre:diag     contadores y operaciones vistas
 *   ← matatigre:watch    { ids:[id] } cuentas externas vigiladas (interactúan a menudo con las listas)
 *   → matatigre:obs      { obs:[registro compacto] }  solo si el usuario activó el registro local (ver observe.js)
 *   → matatigre:ids      { ids:[{ h, id }] }  pares (nombre de usuario, id) de cuentas de la lista que aún no tenían id: se aprenden para reconocerlas aunque cambien de nombre
 *   → matatigre:schema   rutas de campos vistas en tuits y usuarios (sin valores): sondeo del esquema real de X
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
    // Cuentas externas vigiladas (ids): las que interactúan a menudo con las listas. Las envía el content script desde el registro.
    let watch = new Set();
    document.addEventListener('matatigre:watch', e => { try { const d = JSON.parse(e.detail); watch = new Set(Array.isArray(d && d.ids) ? d.ids.map(String) : []); } catch { watch = new Set(); } });
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
            id: isId(u.rest_id) ? u.rest_id : undefined,
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
            id: node.rest_id, author: u.handle, authorId: u.id, authorName: u.name, authorBio: u.bio, text,
            lang: node.legacy?.lang ?? node.lang, replyTo: handleOf(ownString(node, REPLY_KEY)),
            mentions: mentionsOf(node, text), reposters: [], reposterIds: [], quoted: null
        };
        if (!withNested) return post;
        let retweeted = null;
        for (const { path, node: child } of nestedTweets(node)) {
            const inner = project(child, false);
            if (!inner) continue;
            if (QUOTE_PATH.test(path)) {
                if (!post.quoted && (inner.author || inner.authorId)) post.quoted = { author: inner.author, id: inner.authorId, name: inner.authorName, bio: inner.authorBio };
            } else if (RETWEET_PATH.test(path)) {
                retweeted = child;
            }
        }
        if (retweeted) {
            const original = project(retweeted, true);
            if (original) return { ...original, reposters: u.handle ? [u.handle] : [], reposterIds: u.handle ? [u.id] : [], wrapperId: post.id };
        }
        return post;
    }

    // ---------- observación (solo si el usuario activó el registro local) ----------
    const num = v => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : undefined; };
    const clip = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
    const compact = o => { for (const k of Object.keys(o)) if (o[k] === undefined || (Array.isArray(o[k]) && !o[k].length)) delete o[k]; return o; };

    /** Datos del usuario de un tuit, buscando cada campo en las rutas conocidas (el esquema cambia). */
    function userInfo(node) {
        const u = node.core?.user_results?.result ?? node.user ?? null;
        if (!u || typeof u !== 'object') return null;
        const id = isId(u.rest_id) ? u.rest_id : undefined;
        const h = handleOf(u.core?.screen_name ?? u.legacy?.screen_name ?? u.screen_name);
        if (!id && !h) return null;
        const lg = u.legacy ?? {}, rc = u.relationship_counts ?? {}, tc = u.tweet_counts ?? {};
        return compact({
            id, h, n: clip(u.core?.name ?? lg.name ?? u.name, 100), b: clip(u.profile_bio?.description ?? lg.description ?? u.description, 400),
            f: num(rc.followers ?? lg.followers_count), g: num(rc.following ?? lg.friends_count), p: num(tc.tweets ?? tc.posts ?? lg.statuses_count),
            bl: typeof (u.verification?.is_blue_verified ?? u.is_blue_verified) === 'boolean' ? (u.verification?.is_blue_verified ?? u.is_blue_verified) : undefined,
            pl: typeof u.parody_commentary_fan_label === 'string' ? u.parody_commentary_fan_label : undefined,
            pr: typeof (u.privacy?.protected ?? lg.protected) === 'boolean' ? (u.privacy?.protected ?? lg.protected) : undefined,
            cr: typeof (u.core?.created_at ?? lg.created_at) === 'string' ? (u.core?.created_at ?? lg.created_at) : undefined
        });
    }
    const userMini = node => { const u = userInfo(node); return u ? compact({ id: u.id, h: u.h }) : undefined; };

    function timeOf(node) {
        const ms = num(node.details?.created_at_ms) ?? num(node.created_at_ms);
        if (ms !== undefined) return ms;
        const s = node.legacy?.created_at ?? node.created_at;
        const t = typeof s === 'string' ? Date.parse(s) : NaN;
        return Number.isFinite(t) ? t : undefined;
    }

    function countsOf(node) {
        const c = node.counts ?? node.legacy ?? {};
        const pick = re => { for (const k in c) if (re.test(k)) { const v = num(c[k]); if (v !== undefined) return v; } return undefined; };
        return compact({ f: pick(/^(favorite|like)/i), rt: pick(/^(retweet|repost)/i), q: pick(/^quote/i), r: pick(/^reply/i), bm: pick(/^bookmark/i), v: num(node.views?.count ?? node.ext_views?.count) });
    }

    const listOf = (...arrs) => { for (const a of arrs) if (Array.isArray(a) && a.length) return a; return []; };
    // En los textos largos (note_tweet) las entidades completas vienen en entity_set; las de legacy están recortadas.
    const noteSet = node => node.note_tweet?.note_tweet_results?.result?.entity_set;
    const urlsOf = node => listOf(node.url_entities, noteSet(node)?.urls, node.legacy?.entities?.urls, node.entities?.urls).slice(0, 8)
        .map(e => e && (e.expanded_url ?? e.expanded ?? e.url)).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u) && u.length < 500);
    const hashtagsOf = (node, text) => {
        const fromApi = listOf(node.hashtag_entities, noteSet(node)?.hashtags, node.legacy?.entities?.hashtags, node.entities?.hashtags).map(e => e && e.text).filter(t => typeof t === 'string');
        if (fromApi.length) return fromApi.slice(0, 12);
        return [...String(text).matchAll(/(?:^|\s)#([\p{L}\p{N}_]{1,60})/gu)].map(m => m[1]).slice(0, 12);
    };
    const mentionsWithIds = node => {
        const seen = new Map();
        for (const e of listOf(node.mention_entities, noteSet(node)?.user_mentions, node.legacy?.entities?.user_mentions, node.entities?.user_mentions).slice(0, 20)) {
            const h = handleOf(e && e.screen_name);
            if (!h || seen.has(h.toLowerCase())) continue;
            const id = e.id_str ?? e.id ?? e.rest_id;
            seen.set(h.toLowerCase(), compact({ h, id: isId(String(id)) ? String(id) : undefined }));
        }
        return [...seen.values()];
    };
    const mediaOf = node => listOf(node.media_entities2, node.legacy?.extended_entities?.media, node.legacy?.entities?.media, node.entities?.media).slice(0, 4)
        .map(e => e && compact({ id: e.media_key ?? e.id_str ?? (e.id !== undefined ? String(e.id) : undefined), t: clip(e.type, 20), s: isId(e.source_status_id_str) ? e.source_status_id_str : undefined })).filter(e => e && e.id);
    const sourceOf = node => { const s = ownString(node, /^source$/); return s ? s.replace(/<[^>]*>/g, '').slice(0, 40) : undefined; };

    /** Registro compacto de un tuit: tipo (post, repost, cita o respuesta), autor, hora, contadores, enlaces, hashtags, menciones y medios. */
    function describe(raw) {
        const node = unwrap(raw);
        if (!isTweet(node)) return null;
        const a = userInfo(node);
        if (!a) return null;
        let kind = 'post', target = null;
        for (const { path, node: child } of nestedTweets(node)) {
            const inner = unwrap(child);
            if (!inner) continue;
            if (RETWEET_PATH.test(path)) { kind = 'repost'; target = inner; break; }
            if (QUOTE_PATH.test(path) && !target) { kind = 'quote'; target = inner; }
        }
        // Una cita puede venir solo como referencia (quoted_status_id_str / quotedRefResult) sin el tuit citado completo.
        const quotedId = ownString(node, /^quoted_status_id_str$/);
        if (kind === 'post' && isId(quotedId)) kind = 'quote';
        const replyId = ownString(node, /^in_reply_to_status_id(_str)?$/);
        if (kind === 'post' && isId(replyId)) kind = 'reply';
        const replyUser = ownString(node, /^in_reply_to_user_id(_str)?$/);
        const replyHandle = handleOf(ownString(node, REPLY_KEY));
        const text = node.note_tweet?.note_tweet_results?.result?.text ?? node.details?.full_text ?? node.legacy?.full_text ?? node.legacy?.text ?? '';
        return compact({
            k: kind, id: node.rest_id, t: timeOf(node), a,
            tid: target ? target.rest_id : (kind === 'quote' ? quotedId : kind === 'reply' ? replyId : undefined),
            tau: target ? userMini(target) : (kind === 'reply' && (isId(replyUser) || replyHandle) ? compact({ id: isId(replyUser) ? replyUser : undefined, h: replyHandle }) : undefined),
            rh: kind === 'reply' ? replyHandle : undefined, cv: (() => { const c = ownString(node, /^conversation_id(_str)?$/); return isId(c) ? c : undefined; })(),
            tx: kind === 'repost' ? undefined : clip(text, 600), lg: clip(node.legacy?.lang ?? node.lang, 8),
            c: countsOf(node), u: urlsOf(node), tg: hashtagsOf(node, text), m: mentionsWithIds(node), md: mediaOf(node), src: sourceOf(node)
        });
    }

    let currentOp = '';
    const obsSeen = new Set();
    let obsBuf = [];
    let obsTimer = 0;
    /**
     * Qué registrar: solo lo que toca a las cuentas de las listas. a = lo publica (o reposta) una cuenta de la lista; p, r, q = alguien
     * responde, reposta o cita a una cuenta de la lista; m = la menciona; t = es la publicación a la que alguien de la lista respondió,
     * reposteó o citó. Lo demás no se guarda.
     */
    function relevance(rec) {
        const rel = [];
        if (matcher.isTracked(rec.a.h, rec.a.id)) rel.push('a');
        if (rec.tau && matcher.isTracked(rec.tau.h, rec.tau.id)) rel.push(rec.k === 'reply' ? 'p' : rec.k === 'repost' ? 'r' : 'q');
        if ((rec.m || []).some(m => matcher.isTracked(m.h, m.id))) rel.push('m');
        if (settings.watch !== false && !rel.includes('a') && rec.a.id && watch.has(String(rec.a.id))) rel.push('w');
        return rel;
    }

    function emitObs(rec) {
        rec.op = currentOp;
        rec.sc = currentLoc().scope;
        obsBuf.push(rec);
        if (!obsTimer) obsTimer = setTimeout(() => {
            obsTimer = 0;
            const buf = obsBuf; obsBuf = [];
            for (let i = 0; i < buf.length; i += 100) emit('obs', { obs: buf.slice(i, i + 100) });
        }, 1500);
    }

    function observe(x) {
        if (!(settings.observe && settings.analyst)) return;
        const node = unwrap(x);
        if (!node || obsSeen.has(node.rest_id)) return;
        const rec = describe(node);
        if (!rec) return;
        const rel = relevance(rec);
        if (!rel.length) return;
        if (obsSeen.size > 30000) obsSeen.clear();
        obsSeen.add(node.rest_id);
        rec.rel = rel;
        emitObs(rec);
        // la publicación original a la que respondió, reposteó o citó alguien de la lista también se registra (contadores, hora, autor)
        if (rel.includes('a') && rec.tid && (rec.k === 'repost' || rec.k === 'quote')) {
            for (const { path, node: child } of nestedTweets(node)) {
                const inner = unwrap(child);
                if (!inner || inner.rest_id !== rec.tid || obsSeen.has(inner.rest_id)) continue;
                const innerRec = describe(inner);
                if (!innerRec) break;
                obsSeen.add(inner.rest_id);
                innerRec.rel = ['t'];
                emitObs(innerRec);
                break;
            }
        }
    }

    /** Registra todos los tuits que contiene un fragmento de respuesta (por ejemplo, una entrada que se va a quitar). */
    function observeTree(root) {
        const stack = [root];
        let n = 0;
        while (stack.length && n++ < 5000) {
            const x = stack.pop();
            if (!x || typeof x !== 'object') continue;
            if (!Array.isArray(x) && isTweet(x)) observe(x);
            for (const k in x) { const v = x[k]; if (v && typeof v === 'object') stack.push(v); }
        }
    }

    // ---------- sondeo del esquema real (solo rutas de campos y cuántas veces aparecen; nunca valores) ----------
    const schema = { tweets: 0, users: 0, paths: {} };
    const SCHEMA_EMIT_AT = new Set([20, 100, 300]);
    function probe(obj, root) {
        const stack = [[obj, root, 0]];
        let n = 0;
        const add = p => { if (p in schema.paths) schema.paths[p]++; else if (Object.keys(schema.paths).length < 600) schema.paths[p] = 1; };
        while (stack.length && n++ < 3000) {
            const [o, p, d] = stack.pop();
            if (d > 4 || !o || typeof o !== 'object') continue;
            for (const k in o) {
                const v = o[k];
                const path = p + '.' + k;
                if (v && typeof v === 'object') {
                    if (Array.isArray(v)) { add(path + '[]'); if (v[0] && typeof v[0] === 'object') stack.push([v[0], path + '[]', d + 1]); }
                    else if (/status_result$|^retweeted_status|^quoted_status/.test(k)) add(path);
                    else stack.push([v, path, d + 1]);
                } else add(path);
            }
        }
    }
    function probeTweet(x) {
        const node = unwrap(x);
        if (!node || schema.tweets >= 300) return;
        schema.tweets++;
        probe(node, 'tweet');
        const u = node.core?.user_results?.result;
        if (u && typeof u === 'object') { schema.users++; probe(u, 'user'); }
        if (SCHEMA_EMIT_AT.has(schema.tweets)) emit('schema', schema);
    }

    // Pares (nombre, id) de cuentas de la lista que aún no tienen id: se envían una vez para que la extensión los aprenda.
    const learnSent = new Set();
    let learnBuf = [], learnTimer = 0;
    function noteLearn(l) {
        const key = l.h + ':' + l.id;
        if (learnSent.has(key)) return;
        learnSent.add(key);
        learnBuf.push(l);
        if (!learnTimer) learnTimer = setTimeout(() => { learnTimer = 0; const ids = learnBuf; learnBuf = []; emit('ids', { ids }); }, 1000);
    }

    function verdictRaw(post) {
        const v = matcher.evaluate({
            author: post.author, authorId: post.authorId, authorName: post.authorName, authorBio: post.authorBio, lang: post.lang, text: post.text,
            reposters: post.reposters, reposterIds: post.reposterIds, quoted: post.quoted?.author, quotedId: post.quoted?.id, quotedName: post.quoted?.name, quotedBio: post.quoted?.bio,
            replyTo: post.replyTo, mentions: post.mentions
        });
        if (v && v.learn) noteLearn(v.learn);
        return v;
    }

    function remember(post) {
        const prev = store.get(post.id);
        if (prev) {
            post.reposters.forEach((r, i) => { if (!prev.reposters.includes(r)) { prev.reposters.push(r); (prev.reposterIds ||= []).push(post.reposterIds?.[i]); } });
            post = { ...post, reposters: prev.reposters, reposterIds: prev.reposterIds ?? post.reposterIds, quoted: post.quoted || prev.quoted };
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
    const hitRecord = (post, v) => ({ id: post.id, author: post.author, reposters: post.reposters, v: { handle: v.handle, role: v.role, label: v.label, mode: v.mode, lists: v.lists } });

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
        if (!v || v.mode !== 'hide' || matcher.isExempt(loc, v, wrapper)) return null;   // solo se quita lo que va en modo ocultar
        return { id: wrapper.id, handle: v.handle, role: v.role, label: v.label, lists: v.lists };
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

        // Lo que se quita de la respuesta (modo ocultar) se registra ANTES de quitarlo: el análisis de las cuentas de las listas necesita
        // justamente lo que el usuario ya no ve.
        const dropped = entry => {
            const hit = shouldDrop(tweetResultOf(entry), loc);
            if (hit) { drops.push(hit); if (settings.observe && settings.analyst) observeTree(entry); }
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
                probeTweet(x);
                observe(x);
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

    const dropEnabled = () => settings.enabled && settings.deepFilter;
    const opOf = url => { const m = GRAPHQL.exec(url || ''); return m ? m[1] : null; };
    const noteOp = op => { diag.ops[op] = (diag.ops[op] || 0) + 1; };

    /** Procesa un cuerpo de respuesta ya parseado; devuelve true si cambió. */
    function handle(url, data) {
        const op = opOf(url);
        if (!op || !data || typeof data !== 'object') return false;
        noteOp(op);
        currentOp = op;
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
