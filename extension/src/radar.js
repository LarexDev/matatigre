/**
 * Radar de coordinación (parte pura: sin DOM, chrome.* ni IndexedDB; probada en Node con datos sintéticos de verdad conocida).
 *
 * Qué hace: agrupa las observaciones (publicaciones, reposts, citas y respuestas ya guardadas en el registro local) en EVENTOS
 * (un contenido que varias cuentas publican o amplifican) y, para cada uno, mide cuántas cuentas participaron y con qué
 * sincronía, qué indicadores se cumplen, qué cobertura tiene la muestra y qué explicaciones alternativas hay.
 *
 * Además resume por CUENTA qué señales de comportamiento coordinado se observan alrededor de las listas del usuario (ver `accountsReport`):
 * S1 texto sincronizado (≥ 2 eventos de texto de nivel E1), S2 reposts sincronizados (≥ 2 eventos de reposts E1), S3 respuestas o citas
 * repetidas a una misma cuenta de las listas (≥ 5) y S4 amplificación concentrada (≥ 8 interacciones directas con las listas y ≥ 60 % a una
 * sola cuenta). Son una lista de verificación con su evidencia, NO una puntuación ni una etiqueta: los mismos umbrales valen para cualquier bando.
 *
 * Qué NO hace: no etiqueta a nadie, no afirma intención ni que haya una sola persona o un pago detrás. Un evento o una cuenta con señales
 * es un PATRÓN COMPATIBLE con comportamiento coordinado, medido sobre una muestra parcial.
 * (Relaciones entre cuentas, significancia estadística y comunidades son de una fase posterior.)
 *
 * Tipos de evento (clave): texto (texto idéntico o casi idéntico, SimHash), url (misma dirección), hashtag (mismo conjunto de
 * ≥ 3 hashtags) y raíz (reposts y citas de una misma publicación).
 * "Casi idéntico" = SimHash de 64 bits a distancia de Hamming ≤ 6.
 * Indicadores: I1 texto idéntico (≥ 3 cuentas en 60 s) · I2 texto casi idéntico (≥ 3 cuentas en 10 min) · I3 mismo enlace con
 * texto introductorio idéntico · I4 mismo conjunto de hashtags · I5 ≥ 3 reposts/citas del mismo origen en 5 min.
 * Nivel por evento: E0 observación (rasgo compartido) o E1 coincidencia (algún indicador se cumple). E2–E3 exigen varios eventos
 * y significancia estadística (fase posterior).
 */
(function (root, factory) {
    const api = factory(root.XAF || (typeof require === 'function' ? require('./matcher.js') : {}));
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.XAF = Object.assign(root.XAF || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const VERSION = '1.0';
    const MIN = 60000;
    /** Ventanas de sincronía (ms) de cada indicador y niveles del análisis de sensibilidad. */
    const WINDOWS = Object.freeze({ I1: 1 * MIN, I2: 10 * MIN, I3: 10 * MIN, I4: 10 * MIN, I5: 5 * MIN });
    const SENSITIVITY = Object.freeze([30000, 1 * MIN, 5 * MIN, 10 * MIN, 60 * MIN]);
    const MIN_ACCOUNTS = 3;
    const MIN_CHARS = 40;
    const MIN_WORDS = 6;
    const NEAR_BITS = 6;   // distancia de Hamming máxima (de 64 bits) para considerar un texto "casi idéntico"
    const BANDS = 7;       // 7 bandas de 9-10 bits: con distancia ≤ 6 al menos una banda coincide (principio del palomar)
    const BUCKET_CAP = 300;
    const MAX_EVENTS = 300;
    const MAX_PARTICIPANTS = 300;
    const BIN_MS = 10 * MIN;
    const SELF_HOSTS = /^(x|twitter)\.com\//;

    // ---------- SimHash de 64 bits (Charikar) sobre bigramas de palabras ----------
    function h32(s, seed) {
        let h = (0x811c9dc5 ^ seed) >>> 0;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
        return h >>> 0;
    }
    const hex8 = n => (n >>> 0).toString(16).padStart(8, '0');

    /** SimHash (16 caracteres hexadecimales) de un texto ya normalizado; null si no hay palabras. */
    function simhash(norm) {
        const w = String(norm || '').split(' ').filter(x => x.length > 1);
        if (!w.length) return null;
        const toks = w.length > 1 ? w.slice(0, -1).map((x, i) => x + ' ' + w[i + 1]) : w;
        const v = new Int32Array(64);
        for (const t of toks) {
            const a = h32(t, 0), b = h32(t, 0x9e3779b9);
            for (let i = 0; i < 32; i++) { v[i] += (a >>> i) & 1 ? 1 : -1; v[32 + i] += (b >>> i) & 1 ? 1 : -1; }
        }
        let hi = 0, lo = 0;
        for (let i = 0; i < 32; i++) { if (v[32 + i] > 0) hi |= 1 << i; if (v[i] > 0) lo |= 1 << i; }
        return hex8(hi) + hex8(lo);
    }

    /** Claves de las bandas de un SimHash (para encontrar candidatos sin comparar todos con todos). */
    function bandKeys(sh) {
        const hi = parseInt(sh.slice(0, 8), 16) >>> 0, lo = parseInt(sh.slice(8, 16), 16) >>> 0;
        const bit = i => (i < 32 ? (lo >>> i) & 1 : (hi >>> (i - 32)) & 1);
        const keys = [];
        for (let b = 0, start = 0; b < BANDS; b++) {
            const len = b === BANDS - 1 ? 64 - start : 9;
            let v = 0;
            for (let i = 0; i < len; i++) v = (v << 1) | bit(start + i);
            keys.push(b + ':' + v);
            start += len;
        }
        return keys;
    }

    const popcount = x => { x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
    /** Distancia de Hamming entre dos SimHash en hexadecimal. */
    function hamming(a, b) {
        return popcount((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) + popcount((parseInt(a.slice(8, 16), 16) ^ parseInt(b.slice(8, 16), 16)) >>> 0);
    }

    /** Longitud y número de palabras de un texto normalizado (para el mínimo de 40 caracteres y 6 palabras). */
    const textStats = norm => { const s = String(norm || ''); return { tl: s.length, tw: s ? s.split(' ').filter(Boolean).length : 0 }; };

    // ---------- utilidades ----------
    class UnionFind {
        constructor(n) { this.p = Int32Array.from({ length: n }, (_, i) => i); }
        find(i) { while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]]; i = this.p[i]; } return i; }
        union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[b] = a; }
    }

    /** Primera observación de cada cuenta (por hora), en orden temporal. */
    function firstPerAuthor(members) {
        const sorted = [...members].sort((a, b) => a.t - b.t || (a.obsId < b.obsId ? -1 : 1));
        const seen = new Set(), out = [];
        for (const o of sorted) if (!seen.has(o.authorUid)) { seen.add(o.authorUid); out.push(o); }
        return out;
    }

    /** Máximo de cuentas distintas dentro de una ventana de `tau` ms (ventana deslizante sobre horas ya ordenadas). */
    function maxWithin(times, tau) {
        let best = times.length ? 1 : 0, j = 0;
        for (let i = 0; i < times.length; i++) {
            while (times[i] - times[j] > tau) j++;
            best = Math.max(best, i - j + 1);
        }
        return best;
    }

    // ---------- construcción de eventos ----------
    function buildCandidates(rows) {
        const events = [];

        // 1 · texto idéntico o casi idéntico
        const textObs = rows.filter(o => (o.kind === 'post' || o.kind === 'quote' || o.kind === 'reply') && o.th && o.tl >= MIN_CHARS && o.tw >= MIN_WORDS);
        const uf = new UnionFind(textObs.length);
        const byHash = new Map();
        textObs.forEach((o, i) => { if (byHash.has(o.th)) uf.union(byHash.get(o.th), i); else byHash.set(o.th, i); });
        const buckets = new Map();
        textObs.forEach((o, i) => {
            if (!o.sh) return;
            for (const key of bandKeys(o.sh)) (buckets.get(key) || buckets.set(key, []).get(key)).push(i);
        });
        for (const idxs of buckets.values()) {
            const cap = idxs.length > BUCKET_CAP ? idxs.slice(0, BUCKET_CAP) : idxs;
            for (let a = 0; a < cap.length; a++) for (let b = a + 1; b < cap.length; b++) {
                const x = textObs[cap[a]], y = textObs[cap[b]];
                if (uf.find(cap[a]) !== uf.find(cap[b]) && hamming(x.sh, y.sh) <= NEAR_BITS) uf.union(cap[a], cap[b]);
            }
        }
        const comps = new Map();
        textObs.forEach((o, i) => { const r = uf.find(i); (comps.get(r) || comps.set(r, []).get(r)).push(o); });
        for (const members of comps.values()) {
            const exact = members.every(m => m.th === members[0].th);
            const first = [...members].sort((a, b) => a.t - b.t)[0];
            events.push({ type: 'texto', subtype: exact ? 'exacto' : 'casi idéntico', key: members[0].th, members, label: first.textNorm || '' });
        }

        // 2 · misma dirección
        const byUrl = new Map();
        for (const o of rows) for (const u of o.urls || []) if (!SELF_HOSTS.test(u)) (byUrl.get(u) || byUrl.set(u, []).get(u)).push(o);
        for (const [u, members] of byUrl) events.push({ type: 'url', subtype: '', key: u, members, label: u });

        // 3 · mismo conjunto de ≥ 3 hashtags
        const byTags = new Map();
        for (const o of rows) { if ((o.tags || []).length >= 3) { const k = [...new Set(o.tags)].sort().join(' '); if (k.split(' ').length >= 3) (byTags.get(k) || byTags.set(k, []).get(k)).push(o); } }
        for (const [k, members] of byTags) events.push({ type: 'hashtag', subtype: '', key: k, members, label: k.split(' ').map(t => '#' + t).join(' ') });

        // 4 · reposts y citas de una misma publicación
        const byRoot = new Map();
        for (const o of rows) if ((o.kind === 'repost' || o.kind === 'quote') && o.targetId) (byRoot.get(o.targetId) || byRoot.set(o.targetId, []).get(o.targetId)).push(o);
        for (const [k, members] of byRoot) events.push({ type: 'raiz', subtype: '', key: k, members, label: 'Publicación ' + k });
        return events;
    }

    /** Contexto global de la muestra: actividad por franjas de 10 min (para detectar una tendencia que explique la coincidencia). */
    function activityBins(rows) {
        const bins = new Map();
        let lo = Infinity, hi = -Infinity;
        for (const o of rows) { const b = Math.floor(o.t / BIN_MS); bins.set(b, (bins.get(b) || 0) + 1); lo = Math.min(lo, b); hi = Math.max(hi, b); }
        const n = hi - lo + 1;
        if (!(n >= 6)) return { bins, mean: 0, std: 0, n };
        let sum = 0; for (const c of bins.values()) sum += c;
        const mean = sum / n;
        let v = 0; for (let b = lo; b <= hi; b++) v += ((bins.get(b) || 0) - mean) ** 2;
        return { bins, mean, std: Math.sqrt(v / n), n };
    }

    function analyzeEvent(ev, ctx) {
        const parts = firstPerAuthor(ev.members);
        if (parts.length < 2) return null;
        const times = parts.map(p => p.t);
        const first = times[0], last = times[times.length - 1];
        const within = Object.fromEntries(SENSITIVITY.map(t => [t, maxWithin(times, t)]));
        const ind = [];
        if (ev.type === 'texto') {
            if (ev.subtype === 'exacto' && maxWithin(times, WINDOWS.I1) >= MIN_ACCOUNTS) ind.push('I1');
            if (maxWithin(times, WINDOWS.I2) >= MIN_ACCOUNTS) ind.push('I2');
        } else if (ev.type === 'url') {
            const byText = new Map();
            for (const p of parts) if (p.th) (byText.get(p.th) || byText.set(p.th, []).get(p.th)).push(p.t);
            if ([...byText.values()].some(ts => maxWithin(ts.sort((a, b) => a - b), WINDOWS.I3) >= MIN_ACCOUNTS)) ind.push('I3');
        } else if (ev.type === 'hashtag') {
            if (maxWithin(times, WINDOWS.I4) >= MIN_ACCOUNTS) ind.push('I4');
        } else if (ev.type === 'raiz') {
            if (maxWithin(times, WINDOWS.I5) >= MIN_ACCOUNTS) ind.push('I5');
        }
        const level = ind.length ? 'E1' : 'E0';
        const holds = SENSITIVITY.filter(t => within[t] >= MIN_ACCOUNTS).length;
        const stability = level === 'E0' ? null : { holds, of: SENSITIVITY.length, label: holds / SENSITIVITY.length >= 0.8 ? 'alta' : holds / SENSITIVITY.length >= 0.4 ? 'media' : 'baja' };

        // cobertura (solo donde hay un contador total que comparar: reposts de una publicación conocida)
        let coverage = null, targetCounts = null;
        if (ev.type === 'raiz') {
            const target = ctx.postById.get(ev.key);
            targetCounts = target && target.counts ? target.counts : null;
            const reposters = new Set(ev.members.filter(m => m.kind === 'repost').map(m => m.authorUid)).size;
            const total = targetCounts && Number.isFinite(targetCounts.rt) ? targetCounts.rt : null;
            if (total) coverage = { observed: reposters, total, ratio: Math.min(1, reposters / total) };
        }

        // explicaciones alternativas
        const urlCounts = new Map();
        for (const p of parts) for (const u of p.urls || []) if (!SELF_HOSTS.test(u)) urlCounts.set(u, (urlCounts.get(u) || 0) + 1);
        const sharedUrl = Math.max(0, ...urlCounts.values()) >= Math.ceil(parts.length * 0.5);
        const firstBin = Math.floor(first / BIN_MS);
        const own = ev.members.filter(m => Math.floor(m.t / BIN_MS) === firstBin).length;   // el propio evento no cuenta como "actividad general"
        const bin = Math.max(0, (ctx.activity.bins.get(firstBin) || 0) - own);
        const z = ctx.activity.std > 0 ? (bin - ctx.activity.mean) / ctx.activity.std : null;
        const scopes = new Map();
        for (const p of parts) { const s = (p.ctx && p.ctx.scope) || '?'; scopes.set(s, (scopes.get(s) || 0) + 1); }
        const topScope = [...scopes.entries()].sort((a, b) => b[1] - a[1])[0];
        const sampleBias = parts.length >= 3 && topScope[1] / parts.length >= 0.9 && (topScope[0] === 'search' || topScope[0] === 'list');
        const alternatives = {
            fuenteComun: ev.type === 'url' || (ev.type === 'texto' && sharedUrl),
            tendencia: { z: z === null ? null : Math.round(z * 10) / 10, flag: z !== null && z >= 2 },
            raizViral: ev.type === 'raiz' ? (targetCounts && Number.isFinite(targetCounts.rt) ? targetCounts.rt >= 500 : null) : false,
            coberturaBaja: coverage ? coverage.ratio < 0.3 : null,
            artefactoMuestra: sampleBias,
            comunidadOrganica: null
        };
        const alt = [];
        if (alternatives.fuenteComun) alt.push('fuente común');
        if (alternatives.tendencia.flag) alt.push('tendencia general');
        if (alternatives.raizViral) alt.push('raíz con mucho alcance');
        if (alternatives.artefactoMuestra) alt.push('misma búsqueda o lista');
        const verdict = level === 'E0' ? 'observación'
            : alternatives.coberturaBaja ? 'no concluyente (cobertura baja)'
                : alt.length ? 'explicación alternativa plausible' : 'patrón compatible con comportamiento coordinado';

        return {
            id: ev.type + '|' + ev.subtype + '|' + ev.key,
            type: ev.type, subtype: ev.subtype, label: String(ev.label || '').slice(0, 200),
            n: parts.length, first, last, spanMs: last - first, repeats: ev.members.length - parts.length,
            indicators: ind, level, stability, within, coverage, alternatives, alt, verdict,
            participants: parts.slice(0, MAX_PARTICIPANTS).map(p => ({ uid: p.authorUid, t: p.t, obsId: p.obsId, tweetId: p.tweetId, kind: p.kind })),
            obsIds: ev.members.slice(0, 400).map(m => m.obsId)
        };
    }

    // ---------- por cuenta: señales alrededor de las listas ----------
    const DIRECT = new Set(['p', 'r', 'q']);
    const SIGNALS = Object.freeze({
        S1: { label: 'Texto sincronizado', min: 2, help: 'Participa en 2 o más eventos de texto idéntico o casi idéntico con indicador (E1)' },
        S2: { label: 'Reposts sincronizados', min: 2, help: 'Participa en 2 o más eventos de reposts de una misma publicación con indicador (E1)' },
        S3: { label: 'Respuestas repetidas al mismo objetivo', min: 5, help: '5 o más respuestas o citas a una misma cuenta de tus listas' },
        S4: { label: 'Amplificación concentrada', min: 8, share: 0.6, help: '8 o más interacciones directas con tus listas, 60 % o más dirigidas a una sola cuenta' }
    });
    const MIN_INTERACTOR = 5;

    /**
     * Resumen por cuenta: qué señales se observan y cuánto interactúa con las cuentas de las listas. Una cuenta "de la lista" es la
     * que el registro marcó como tal (rel con "a"). Devuelve { accounts, interactors }.
     */
    function accountsReport(rows, events) {
        const acc = new Map();
        const get = uid => acc.get(uid) || acc.set(uid, { uid, obs: 0, listed: false, direct: 0, mentions: 0, targets: new Map(), replyTargets: new Map(), evidence: new Map(), textEvents: [], rootEvents: [] }).get(uid);
        for (const o of rows) {
            if (!Array.isArray(o.rel) || !o.rel.length) continue;
            const a = get(o.authorUid);
            a.obs++;
            if (o.rel.includes('a')) a.listed = true;
            if (o.rel.includes('m')) a.mentions++;
            if (o.rel.some(c => DIRECT.has(c)) && o.targetAuthorUid && o.targetAuthorUid !== o.authorUid) {
                a.direct++;
                a.targets.set(o.targetAuthorUid, (a.targets.get(o.targetAuthorUid) || 0) + 1);
                if (o.kind === 'reply' || o.kind === 'quote') {
                    a.replyTargets.set(o.targetAuthorUid, (a.replyTargets.get(o.targetAuthorUid) || 0) + 1);
                    (a.evidence.get('S3:' + o.targetAuthorUid) || a.evidence.set('S3:' + o.targetAuthorUid, []).get('S3:' + o.targetAuthorUid)).push(o.tweetId);
                }
            }
        }
        for (const e of events) {
            if (e.level !== 'E1') continue;
            for (const p of e.participants) { const a = acc.get(p.uid); if (!a) continue; if (e.type === 'texto') a.textEvents.push(e.id); else if (e.type === 'raiz') a.rootEvents.push(e.id); }
        }
        const out = [], interactors = [];
        for (const a of acc.values()) {
            const top = [...a.targets.entries()].sort((x, y) => y[1] - x[1])[0];
            const topShare = a.direct && top ? top[1] / a.direct : 0;
            const signals = [];
            if (a.textEvents.length >= SIGNALS.S1.min) signals.push({ id: 'S1', n: a.textEvents.length, evidence: a.textEvents.slice(0, 5) });
            if (a.rootEvents.length >= SIGNALS.S2.min) signals.push({ id: 'S2', n: a.rootEvents.length, evidence: a.rootEvents.slice(0, 5) });
            const rep = [...a.replyTargets.entries()].sort((x, y) => y[1] - x[1])[0];
            if (rep && rep[1] >= SIGNALS.S3.min) signals.push({ id: 'S3', n: rep[1], target: rep[0], evidence: (a.evidence.get('S3:' + rep[0]) || []).slice(0, 5) });
            if (a.direct >= SIGNALS.S4.min && topShare >= SIGNALS.S4.share) signals.push({ id: 'S4', n: a.direct, target: top[0], share: Math.round(topShare * 100) / 100 });
            const row = { uid: a.uid, listed: a.listed, observations: a.obs, direct: a.direct, mentions: a.mentions, targets: a.targets.size, topTarget: top ? top[0] : null, topShare: Math.round(topShare * 100) / 100 };
            if (signals.length) out.push({ ...row, signals });
            if (!a.listed && a.direct >= MIN_INTERACTOR) interactors.push(row);
        }
        out.sort((x, y) => y.signals.length - x.signals.length || y.direct - x.direct || (x.uid < y.uid ? -1 : 1));
        interactors.sort((x, y) => y.direct - x.direct || (x.uid < y.uid ? -1 : 1));
        return { accounts: out.slice(0, 100), interactors: interactors.slice(0, 30) };
    }

    /**
     * Analiza una muestra de observaciones. `obs`: registros del almacén `obs` (con `t`, `th`, `sh`, `tl`, `tw`, `urls`, `tags`…).
     * Devuelve { version, params, sample, events } (eventos ordenados: primero los de nivel E1 y más cuentas).
     */
    function analyze(obs, opts = {}) {
        const from = Number.isFinite(opts.from) ? opts.from : -Infinity, to = Number.isFinite(opts.to) ? opts.to : Infinity;
        const rows = (obs || []).filter(o => o && Number.isFinite(o.t) && o.t >= from && o.t <= to && o.authorUid);
        const ctx = { postById: new Map(), activity: activityBins(rows) };
        for (const o of rows) if (o.kind === 'post') ctx.postById.set(o.tweetId, o);
        const events = [];
        for (const c of buildCandidates(rows)) { const e = analyzeEvent(c, ctx); if (e) events.push(e); }
        events.sort((a, b) => (b.level === 'E1') - (a.level === 'E1') || b.n - a.n || a.spanMs - b.spanMs);
        const authors = new Set(rows.map(o => o.authorUid));
        const byAccount = accountsReport(rows, events);
        return {
            version: VERSION,
            params: { from: Number.isFinite(from) ? from : null, to: Number.isFinite(to) ? to : null, windows: WINDOWS, sensitivity: SENSITIVITY, minAccounts: MIN_ACCOUNTS, minChars: MIN_CHARS, minWords: MIN_WORDS, nearBits: NEAR_BITS },
            sample: { observations: rows.length, accounts: authors.size, from: rows.length ? Math.min(...rows.map(o => o.t)) : null, to: rows.length ? Math.max(...rows.map(o => o.t)) : null },
            events: events.slice(0, MAX_EVENTS),
            truncated: events.length > MAX_EVENTS,
            accounts: byAccount.accounts, interactors: byAccount.interactors, signals: SIGNALS
        };
    }

    return { RADAR_SIGNALS: SIGNALS, RADAR_VERSION: VERSION, RADAR_WINDOWS: WINDOWS, RADAR_SENSITIVITY: SENSITIVITY, simhash, hamming, textStats, maxWithin, analyze };
});
