/**
 * Registro de observaciones (parte pura, sin DOM ni chrome.*): normalización de textos y enlaces, y conversión del
 * registro compacto que emite el script de página en el registro que se guarda. Lo usan el service worker y las pruebas.
 *
 * Registro compacto del script de página (claves cortas para pesar poco por el canal de eventos):
 *   k  tipo: post | repost | quote | reply          id  id del tuit (en un repost, el del envoltorio)
 *   t  hora (ms) | undefined                         a   autor (en un repost, quien reposta)  { id, h, n, b, f, g, p, bl, pl, pr, cr }
 *   tid  id del tuit objetivo (repost, cita, respuesta)   tau  autor del objetivo { id, h }   rh  handle al que se responde
 *   rel por qué se registró (a, p, r, q, m, t, w: ver REL_CODES)   cv  id de la conversación (hilo)
 *   tx  texto (≤ 600)  lg idioma  c contadores { f, rt, q, r, bm, v }  u enlaces  tg hashtags  m menciones [{ h, id }]
 *   md  medios [{ id, t, s }] (s = tuit de origen si el medio se reutiliza)  src aplicación de origen  op operación GraphQL  sc ámbito de la página
 */
(function (root, factory) {
    const api = factory(root.XAF || (typeof require === 'function' ? require('./matcher.js') : {}));
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.XAF = Object.assign(root.XAF || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
    'use strict';

    const KINDS = ['post', 'repost', 'quote', 'reply'];
    const ID_RE = /^[1-9][0-9]{0,19}$/;
    const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
    const TRACKING = /^(utm_[a-z]+|fbclid|gclid|igshid|mc_cid|mc_eid|ref|ref_src|s|t|si)$/i;
    const MAX_TEXT_NORM = 300;
    /** Por qué se registró: a (la publica o reposta una cuenta de las listas), p/r/q (responde, reposta o cita a una), m (la menciona), t (es la publicación original). */
    const REL_CODES = ['a', 'p', 'r', 'q', 'm', 't', 'w'];

    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
    const int = v => (Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
    const clean = o => { for (const k of Object.keys(o)) if (o[k] === undefined || (Array.isArray(o[k]) && !o[k].length)) delete o[k]; return o; };

    /** Texto normalizado para comparar y para huella: sin tildes, en minúsculas, sin enlaces, menciones como "@". */
    function normalizeForMatch(text) {
        return M.normalizeText(String(text ?? ''))
            .replace(/https?:\/\/\S+/g, ' ')
            .replace(/@[a-z0-9_]{1,15}/g, '@')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** Enlace canónico: sin parámetros de seguimiento, sin fragmento ni "www."; null si no sirve (acortador sin resolver, no http). */
    function canonicalUrl(value) {
        let u;
        try { u = new URL(String(value)); } catch { return null; }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        if (host === 't.co') return null;
        for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
        u.searchParams.sort();
        const q = u.searchParams.toString();
        const path = u.pathname.replace(/\/+$/, '');
        const out = host + path + (q ? '?' + q : '');
        return out.length <= 300 ? out : null;
    }

    const handleKey = h => (typeof h === 'string' && HANDLE_RE.test(h) ? h.toLowerCase() : null);

    /** Perfil compacto → datos de perfil validados (o null si no hay ni id ni handle). */
    function cleanUser(a) {
        if (!a || typeof a !== 'object') return null;
        const id = typeof a.id === 'string' && ID_RE.test(a.id) ? a.id : undefined;
        const h = typeof a.h === 'string' && HANDLE_RE.test(a.h) ? a.h : undefined;
        if (!id && !h) return null;
        return clean({
            id, h, n: str(a.n, 100), b: str(a.b, 400), f: int(a.f), g: int(a.g), p: int(a.p),
            bl: typeof a.bl === 'boolean' ? a.bl : undefined, pl: str(typeof a.pl === 'string' ? a.pl : undefined, 40),
            pr: typeof a.pr === 'boolean' ? a.pr : undefined, cr: typeof a.cr === 'string' || Number.isFinite(a.cr) ? String(a.cr).slice(0, 40) : undefined
        });
    }

    /**
     * Registro compacto → registro de observación listo para guardar (sin huella de texto: la calcula la ingesta).
     * Devuelve null si no es válido. `now` es la hora de captura.
     */
    function toRecord(raw, now = Date.now()) {
        if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.k) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
        const author = cleanUser(raw.a);
        if (!author) return null;
        const tau = cleanUser(raw.tau);
        const full = raw.k === 'repost' ? '' : normalizeForMatch(str(raw.tx, 600));
        const urls = [...new Set((Array.isArray(raw.u) ? raw.u : []).slice(0, 8).map(canonicalUrl).filter(Boolean))];
        const tags = [...new Set((Array.isArray(raw.tg) ? raw.tg : []).slice(0, 12).map(t => String(t).toLowerCase().slice(0, 60)).filter(Boolean))];
        const mentions = [];
        for (const m of (Array.isArray(raw.m) ? raw.m : []).slice(0, 20)) {
            const id = m && typeof m.id === 'string' && ID_RE.test(m.id) ? m.id : null;
            const h = m && handleKey(m.h);
            if (id || h) mentions.push(id ? 'u:' + id : 'h:' + h);
        }
        const media = (Array.isArray(raw.md) ? raw.md : []).slice(0, 4).map(x => clean({ id: str(x && x.id ? String(x.id) : undefined, 60), t: str(x && x.t, 20), s: x && typeof x.s === 'string' && ID_RE.test(x.s) ? x.s : undefined })).filter(x => x.id);
        const c = raw.c && typeof raw.c === 'object' ? clean({ f: int(raw.c.f), rt: int(raw.c.rt), q: int(raw.c.q), r: int(raw.c.r), bm: int(raw.c.bm), v: int(raw.c.v) }) : undefined;
        const t = Number.isFinite(raw.t) && raw.t > 946684800000 && raw.t < now + 86400000 ? Math.round(raw.t) : undefined;
        return {
            tweetId: raw.id, kind: raw.k, author, tau, t, seenAt: now,
            targetId: typeof raw.tid === 'string' && ID_RE.test(raw.tid) ? raw.tid : undefined,
            replyTo: handleKey(raw.rh) || undefined, convId: typeof raw.cv === 'string' && ID_RE.test(raw.cv) ? raw.cv : undefined,
            textFull: full || undefined, textNorm: full ? full.slice(0, MAX_TEXT_NORM) : undefined,
            urls, tags, mentions, media,
            rel: [...new Set((Array.isArray(raw.rel) ? raw.rel : []).filter(c => REL_CODES.includes(c)))],
            lang: typeof raw.lg === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$|^und$/.test(raw.lg) ? raw.lg : undefined,
            counts: c && Object.keys(c).length ? c : undefined,
            src: str(raw.src, 40), ctx: clean({ op: str(raw.op, 40), scope: str(raw.sc, 20) })
        };
    }

    /** SHA-256 en hexadecimal (WebCrypto; existe en el service worker, en páginas y en Node ≥ 20). */
    async function sha256Hex(text) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
        return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    return { OBS_KINDS: KINDS, MAX_TEXT_NORM, normalizeForMatch, canonicalUrl, cleanUser, toRecord, sha256Hex };
});
