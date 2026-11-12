/**
 * Análisis relacional (parte pura: sin DOM, chrome.* ni IndexedDB; probada en Node con datos sintéticos de verdad conocida).
 *
 * Parte de lo que el registro guarda alrededor de las listas del usuario (las cuentas de las listas, las externas que interactúan con
 * ellas y las externas "vigiladas" por interactuar a menudo) y construye:
 *   · el GRAFO de relaciones: interacciones observadas (respuesta, cita, repost, mención) y COORDINACIÓN (cuentas que participan en los
 *     mismos eventos con horas muy próximas), esta última con modelo nulo (desplazamiento circular de las horas de cada cuenta) y control
 *     de falsos descubrimientos (Benjamini–Hochberg), de modo que una coincidencia solo cuenta si es improbable por azar;
 *   · las COMUNIDADES (Louvain con consenso entre varias ejecuciones: solo se conserva lo estable) y los NODOS relevantes (PageRank,
 *     grado ponderado, y roles: quién inicia, quién sigue, quién depende de una sola cuenta);
 *   · las NARRATIVAS (eventos unidos por compartir publicaciones), con sus primeras cuentas observadas, su arranque, su concentración y
 *     su robustez al quitar a las cuentas más activas;
 *   · los HALLAZGOS: conclusiones concretas, cada una con las cuentas, las relaciones y los criterios numéricos que la sustentan, su nivel
 *     de evidencia (E1 coincidencia, E2 coordinación probable, E3 coordinación sostenida), su estabilidad y las explicaciones alternativas.
 *
 * Qué NO hace: no etiqueta a nadie como "bodeguero", no afirma intención, pago, automatización ni que haya una sola persona detrás.
 * Describe un PATRÓN COMPATIBLE con comportamiento coordinado, medido sobre una muestra parcial, con los mismos criterios para cualquier bando.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.XAF = Object.assign(root.XAF || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const VERSION = '1.1';
    const MIN = 60000;
    const HOUR = 3600000;
    /** Ventana de coparticipación según el tipo de evento. */
    const TAU = Object.freeze({ textoExacto: 1 * MIN, texto: 10 * MIN, url: 10 * MIN, hashtag: 10 * MIN, raiz: 5 * MIN });
    const PARAMS = Object.freeze({ permutations: 400, q: 0.05, minSupport: 3, maxEventParticipants: 60, maxNodes: 250, coordWeight: 2, sensPermutations: 150, consensusRuns: 10, consensusMin: 0.8, seed: 1337, activityGapMs: 2 * HOUR, placeboRuns: 3, burstBinMs: 10 * MIN, crossPermutations: 500 });

    // ---------- utilidades ----------
    function rng(seed) {
        let a = seed >>> 0;
        return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }
    const shuffle = (arr, rnd) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

    /** Intervalo de confianza de Wilson (95 %) para una proporción k/n. */
    function wilson(k, n, z = 1.96) {
        if (!n) return [0, 0];
        const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
        return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
    }
    function gini(values) {
        const v = values.filter(x => x >= 0).sort((a, b) => a - b), n = v.length, s = v.reduce((a, b) => a + b, 0);
        if (n < 2 || !s) return 0;
        let acc = 0; for (let i = 0; i < n; i++) acc += (2 * (i + 1) - n - 1) * v[i];
        return acc / (n * s);
    }
    const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

    /** Benjamini–Hochberg: devuelve los valores q (p ajustados) en el mismo orden. */
    function benjaminiHochberg(p) {
        const m = p.length, idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]), q = new Array(m);
        let prev = 1;
        for (let r = m - 1; r >= 0; r--) { const i = idx[r]; prev = Math.min(prev, p[i] * m / (r + 1)); q[i] = prev; }
        return q;
    }

    // ---------- grafo de interacciones ----------
    /**
     * Interacciones observadas entre cuentas. `rows`: observaciones. Una cuenta "de la lista" es la que el registro marcó así (rel "a") o
     * la destinataria de una interacción directa registrada por tocar a las listas; "vigilada" es una externa seguida por interactuar a menudo (rel "w").
     */
    function buildInteractions(rows) {
        const authorOf = new Map();
        for (const o of rows) if (o.kind !== 'repost') authorOf.set(o.tweetId, o.authorUid);
        const listed = new Set(), watched = new Set(), edges = new Map(), obsCount = new Map(), times = new Map();
        const bump = (type, a, b, o) => {
            const k = type + '|' + a + '|' + b;
            const e = edges.get(k) || edges.set(k, { type, a, b, n: 0, evidence: [], first: o.t, last: o.t }).get(k);
            e.n++; e.first = Math.min(e.first, o.t); e.last = Math.max(e.last, o.t);
            if (e.evidence.length < 8) e.evidence.push(o.tweetId);
        };
        for (const o of rows) {
            const rel = o.rel || [];
            obsCount.set(o.authorUid, (obsCount.get(o.authorUid) || 0) + 1);
            if (rel.includes('a')) listed.add(o.authorUid); else if (rel.includes('w')) watched.add(o.authorUid);
            const target = o.targetAuthorUid || (o.targetId && authorOf.get(o.targetId)) || null;
            if ((o.kind === 'reply' || o.kind === 'quote' || o.kind === 'repost') && target && target !== o.authorUid) {
                bump(o.kind, o.authorUid, target, o);
                if (rel.some(c => c === 'p' || c === 'r' || c === 'q')) listed.add(target);
            }
        }
        for (const o of rows) for (const m of o.mentions || []) if (m !== o.authorUid && listed.has(m)) bump('mention', o.authorUid, m, o);
        return { edges: [...edges.values()], listed, watched, obsCount, authorOf };
    }

    // ---------- eje de tiempo con periodos de actividad ----------
    /**
     * Los eventos solo pueden existir donde hubo actividad observada: si el usuario navega unas horas al día, el resto del reloj es un hueco
     * en el que no se captura nada. El modelo nulo debe barajar las horas SOLO dentro de esos periodos (si no, desplaza cuentas a huecos donde
     * nadie podía coincidir y toda sincronía parece significativa). Se unen los periodos en un eje compacto: [start, end] reales -> [offset, offset+len).
     * Un hueco mayor que gapMs separa dos periodos; con gapMs = Infinity hay un único periodo (comportamiento clásico).
     */
    function activitySegments(times, gapMs = Infinity) {
        const ts = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b);
        if (!ts.length) return { segs: [], total: 0 };
        const raw = [];
        let s = ts[0], e = ts[0];
        for (let i = 1; i < ts.length; i++) { if (ts[i] - e > gapMs) { raw.push([s, e]); s = ts[i]; } e = ts[i]; }
        raw.push([s, e]);
        let off = 0;
        const segs = raw.map(([a, b]) => { const len = b - a + 1; const r = { start: a, end: b, len, offset: off }; off += len; return r; });
        return { segs, total: off };
    }
    function segmentAt(axis, key, v) {
        let lo = 0, hi = axis.segs.length - 1, r = 0;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (axis.segs[m][key] <= v) { r = m; lo = m + 1; } else hi = m - 1; }
        return axis.segs[r];
    }
    /** Hora real -> posición en el eje compacto (una hora en un hueco se pega al final del periodo anterior). */
    const toAxis = (axis, t) => { const s = segmentAt(axis, 'start', t); return s.offset + Math.min(Math.max(0, t - s.start), s.len - 1); };
    /** Posición en el eje compacto -> hora real. */
    const fromAxis = (axis, c) => { const s = segmentAt(axis, 'offset', c); return s.start + (c - s.offset); };

    /** Cuánta observación hay detrás del análisis: sin ella, un hallazgo puede parecer más sólido de lo que es. */
    function sufficiency(axis, rows) {
        const days = new Set();
        for (const s of axis.segs) for (let d = Math.floor(s.start / DAY_MS); d <= Math.floor(s.end / DAY_MS); d++) days.add(d);
        const coveredHours = Math.round(axis.total / HOUR * 10) / 10;
        const level = days.size >= 7 && coveredHours >= 24 ? 'suficiente' : days.size >= 3 && coveredHours >= 6 ? 'parcial' : 'escasa';
        return { level, days: days.size, periods: axis.segs.length, coveredHours, observations: rows.length };
    }

    // ---------- coparticipación con modelo nulo ----------
    const tauOf = e => (e.type === 'texto' ? (e.subtype === 'exacto' ? TAU.textoExacto : TAU.texto) : TAU[e.type]);

    /**
     * Pares de cuentas que participan en los mismos eventos con horas dentro de la ventana del evento. Peso w = Σ c_e (c_e = 1/ln(1+n_e):
     * coincidir en un evento masivo cuenta menos que en uno pequeño). Significancia: se desplaza al azar (circularmente, sobre el eje de
     * periodos de actividad) el conjunto de horas de cada cuenta, se recalcula y se compara; q = p ajustado por Benjamini–Hochberg.
     * Cada par trae también cuántas coincidencias serían de esperar solo por azar (media de las permutaciones): `expectedSupport`.
     */
    function coparticipation(events, opts = {}) {
        const P = { ...PARAMS, ...opts };
        const evs = events.filter(e => e.participants && e.participants.length >= 2).map(e => ({ e, tau: tauOf(e) * (P.tauScale || 1), c: 1 / Math.log(1 + e.n), parts: e.participants.slice(0, P.maxEventParticipants) }));
        let T0 = Infinity, T1 = -Infinity;
        for (const x of evs) for (const p of x.parts) { T0 = Math.min(T0, p.t); T1 = Math.max(T1, p.t); }
        const axis = P.axis || activitySegments(evs.flatMap(x => x.parts.map(p => p.t)));
        const W = Math.max(1, axis.total);
        const pair = new Map();
        const key = (a, b) => (a < b ? a + '\u0001' + b : b + '\u0001' + a);
        evs.forEach((x, ei) => {
            const ps = [...x.parts].sort((a, b) => a.t - b.t);
            for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length && ps[j].t - ps[i].t <= x.tau; j++) {
                const k = key(ps[i].uid, ps[j].uid);
                const r = pair.get(k) || pair.set(k, { a: ps[i].uid < ps[j].uid ? ps[i].uid : ps[j].uid, b: ps[i].uid < ps[j].uid ? ps[j].uid : ps[i].uid, w: 0, support: 0, events: [], lags: [] }).get(k);
                r.w += x.c; r.support++; r.events.push(ei); r.lags.push(Math.abs(ps[j].t - ps[i].t));
            }
        });
        const cand = [...pair.values()].filter(r => r.support >= P.minSupport);
        if (!cand.length) return { pairs: [], pValues: [], periodMs: W, events: evs.map(x => x.e), T0, T1, axis };
        const candIdx = new Map(cand.map((r, i) => [key(r.a, r.b), i]));
        const accounts = [...new Set(cand.flatMap(r => [r.a, r.b]))];
        const rnd = rng(P.seed);
        const ge = new Int32Array(cand.length), wSum = new Float64Array(cand.length), sSum = new Float64Array(cand.length);
        const shift = new Map();
        // solo importan los eventos que contienen al menos dos cuentas candidatas
        const accSet = new Set(accounts);
        const relevant = evs.map(x => ({ tau: x.tau, c: x.c, parts: x.parts.filter(p => accSet.has(p.uid)).map(p => ({ uid: p.uid, c: toAxis(axis, p.t) })) })).filter(x => x.parts.length >= 2);
        for (let it = 0; it < P.permutations; it++) {
            for (const a of accounts) shift.set(a, rnd() * W);
            const wStar = new Float64Array(cand.length), sStar = new Int32Array(cand.length);
            for (const x of relevant) {
                const ps = x.parts.map(p => ({ uid: p.uid, t: fromAxis(axis, (p.c + shift.get(p.uid)) % W) })).sort((a, b) => a.t - b.t);
                for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length && ps[j].t - ps[i].t <= x.tau; j++) {
                    const ci = candIdx.get(key(ps[i].uid, ps[j].uid));
                    if (ci !== undefined) { wStar[ci] += x.c; sStar[ci]++; }
                }
            }
            for (let i = 0; i < cand.length; i++) { wSum[i] += wStar[i]; sSum[i] += sStar[i]; if (wStar[i] >= cand[i].w - 1e-9) ge[i]++; }
        }
        const p = cand.map((r, i) => (1 + ge[i]) / (1 + P.permutations));
        const q = benjaminiHochberg(p);
        cand.forEach((r, i) => { r.p = p[i]; r.q = q[i]; r.expectedW = wSum[i] / P.permutations; r.expectedSupport = sSum[i] / P.permutations; });
        return { pairs: cand, pValues: p, periodMs: W, events: evs.map(x => x.e), T0, T1, axis };
    }

    /** Una realización del modelo nulo sobre los propios datos: cada cuenta desplaza todas sus horas, con un desfase propio, dentro del eje de actividad. */
    function shuffledEvents(events, axis, rnd) {
        const W = Math.max(1, axis.total), shift = new Map();
        const off = u => (shift.has(u) ? shift.get(u) : shift.set(u, rnd() * W).get(u));
        return events.map(e => ({ ...e, participants: (e.participants || []).map(p => ({ ...p, t: fromAxis(axis, (toAxis(axis, p.t) + off(p.uid)) % W) })).sort((a, b) => a.t - b.t) }));
    }
    /**
     * Comprobación del procedimiento con los datos de quien analiza: se barajan las horas (ahí NO hay coordinación por construcción) y se pasa el
     * mismo detector. Debe encontrar (casi) ningún par significativo; si encontrara muchos, el análisis no sería fiable con estos datos.
     */
    function placebo(events, opts = {}) {
        const P = { ...PARAMS, ...opts };
        const axis = P.axis || activitySegments(events.flatMap(e => (e.participants || []).map(p => p.t)));
        let tested = 0, significant = 0, below05 = 0;
        for (let r = 0; r < P.placeboRuns; r++) {
            const res = coparticipation(shuffledEvents(events, axis, rng(P.seed + 5003 + r)), { ...P, axis, permutations: P.sensPermutations, seed: P.seed + 700 + r });
            tested += res.pairs.length; significant += res.pairs.filter(x => x.q < P.q).length; below05 += res.pairs.filter(x => x.p < 0.05).length;
        }
        return { runs: P.placeboRuns, tested, significant, below05 };
    }
    const histogram = (values, bins = 10) => { const h = new Array(bins).fill(0); for (const v of values) h[Math.min(bins - 1, Math.floor(v * bins))]++; return h; };

    // ---------- comunidades: Louvain con consenso ----------
    function louvain(n, adj, rnd) {
        let level = adj.map(m => new Map(m));
        let self = new Array(n).fill(0);
        let map = Array.from({ length: n }, (_, i) => i);   // nodo original -> nodo del nivel actual
        for (let guard = 0; guard < 20; guard++) {
            const N = level.length;
            const k = level.map((m, i) => { let s = 2 * self[i]; for (const w of m.values()) s += w; return s; });
            const m2 = k.reduce((a, b) => a + b, 0);
            if (!m2) break;
            const comm = Int32Array.from({ length: N }, (_, i) => i);
            const tot = Float64Array.from(k);
            let moved = true, any = false;
            for (let sweep = 0; moved && sweep < 30; sweep++) {
                moved = false;
                for (const i of shuffle(Array.from({ length: N }, (_, x) => x), rnd)) {
                    const ci = comm[i], nw = new Map();
                    for (const [j, w] of level[i]) nw.set(comm[j], (nw.get(comm[j]) || 0) + w);
                    tot[ci] -= k[i];
                    let best = ci, bestGain = (nw.get(ci) || 0) - tot[ci] * k[i] / m2;
                    for (const [c, w] of nw) { const gain = w - tot[c] * k[i] / m2; if (gain > bestGain + 1e-12) { bestGain = gain; best = c; } }
                    tot[best] += k[i];
                    if (best !== ci) { comm[i] = best; moved = true; any = true; }
                }
            }
            if (!any) break;
            const ids = new Map(); let next = 0;
            for (let i = 0; i < N; i++) if (!ids.has(comm[i])) ids.set(comm[i], next++);
            map = map.map(x => ids.get(comm[x]));
            const agg = Array.from({ length: next }, () => new Map()), aself = new Array(next).fill(0);
            for (let i = 0; i < N; i++) {
                const ci = ids.get(comm[i]);
                aself[ci] += self[i];
                for (const [j, w] of level[i]) { const cj = ids.get(comm[j]); if (ci === cj) aself[ci] += w / 2; else agg[ci].set(cj, (agg[ci].get(cj) || 0) + w); }
            }
            level = agg; self = aself;
        }
        return map;
    }

    function modularity(part, adj) {
        let m2 = 0; const tot = new Map(), inn = new Map();
        adj.forEach((m, i) => { let k = 0; for (const [j, w] of m) { k += w; if (part[i] === part[j]) inn.set(part[i], (inn.get(part[i]) || 0) + w); } m2 += k; tot.set(part[i], (tot.get(part[i]) || 0) + k); });
        if (!m2) return 0;
        let q = 0; for (const c of tot.keys()) q += (inn.get(c) || 0) / m2 - ((tot.get(c) || 0) / m2) ** 2;
        return q;
    }

    /** Comunidades estables: se ejecuta Louvain varias veces y solo se mantienen unidas las cuentas que casi siempre quedan juntas. */
    function communities(nodes, edges, opts = {}) {
        const P = { ...PARAMS, ...opts };
        const idx = new Map(nodes.map((u, i) => [u, i]));
        const adj = nodes.map(() => new Map());
        for (const e of edges) {
            const i = idx.get(e.a), j = idx.get(e.b);
            if (i === undefined || j === undefined || i === j) continue;
            adj[i].set(j, (adj[i].get(j) || 0) + e.w); adj[j].set(i, (adj[j].get(i) || 0) + e.w);
        }
        const rnd = rng(P.seed + 17);
        const runs = Array.from({ length: P.consensusRuns }, () => louvain(nodes.length, adj, rnd));
        const co = (i, j) => runs.filter(r => r[i] === r[j]).length / runs.length;
        const uf = Int32Array.from({ length: nodes.length }, (_, i) => i);
        const find = x => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
        adj.forEach((m, i) => { for (const j of m.keys()) if (j > i && co(i, j) >= P.consensusMin) uf[find(j)] = find(i); });
        const groups = new Map();
        nodes.forEach((u, i) => { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(i); });
        const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
        const part = new Array(nodes.length);
        ordered.forEach((g, ci) => g.forEach(i => { part[i] = ci; }));
        const out = ordered.map((g, ci) => {
            const set = new Set(g);
            let inW = 0, outW = 0, pairs = 0, stab = 0, n = 0;
            for (const i of g) for (const [j, w] of adj[i]) { if (set.has(j)) { inW += w / 2; if (j > i) { pairs++; stab += co(i, j); n++; } } else outW += w; }
            const possible = g.length * (g.length - 1) / 2;
            return { id: ci, members: g.map(i => nodes[i]), size: g.length, density: possible ? Math.round(pairs / possible * 100) / 100 : 0, internal: Math.round(inW * 100) / 100, external: Math.round(outW * 100) / 100, stability: n ? Math.round(stab / n * 100) / 100 : 1 };
        });
        return { communities: out, partition: Object.fromEntries(nodes.map((u, i) => [u, part[i]])), modularity: Math.round(modularity(part, adj) * 1000) / 1000 };
    }

    // ---------- centralidad ----------
    /** PageRank sobre las interacciones dirigidas (peso logarítmico): quién recibe más atención de la red observada. */
    function pagerank(nodes, edges, d = 0.85, iters = 60) {
        const idx = new Map(nodes.map((u, i) => [u, i])), n = nodes.length;
        if (!n) return {};
        const out = Array.from({ length: n }, () => []), outSum = new Float64Array(n);
        for (const e of edges) { const i = idx.get(e.a), j = idx.get(e.b); if (i === undefined || j === undefined || i === j) continue; out[i].push([j, e.w]); outSum[i] += e.w; }
        let pr = new Float64Array(n).fill(1 / n);
        for (let it = 0; it < iters; it++) {
            const next = new Float64Array(n).fill((1 - d) / n);
            let dangling = 0;
            for (let i = 0; i < n; i++) { if (!outSum[i]) dangling += pr[i]; else for (const [j, w] of out[i]) next[j] += d * pr[i] * w / outSum[i]; }
            for (let i = 0; i < n; i++) next[i] += d * dangling / n;
            pr = next;
        }
        return Object.fromEntries(nodes.map((u, i) => [u, pr[i]]));
    }

    /** Roles descriptivos por cuenta, a partir de los eventos y de las interacciones salientes. */
    function roles(events, interactions) {
        const byAcc = new Map();
        const get = u => byAcc.get(u) || byAcc.set(u, { events: 0, first: 0, lags: [] }).get(u);
        for (const e of events) {
            if (e.n < 3 || !e.participants.length) continue;
            const t0 = e.participants[0].t;
            e.participants.forEach((p, i) => { const r = get(p.uid); r.events++; if (i === 0) r.first++; else r.lags.push(p.t - t0); });
        }
        const outBy = new Map();
        for (const e of interactions) { const m = outBy.get(e.a) || outBy.set(e.a, new Map()).get(e.a); m.set(e.b, (m.get(e.b) || 0) + e.n); }
        const res = new Map();
        for (const [u, r] of byAcc) {
            const [lo, hi] = wilson(r.first, r.events);
            const out = {};
            if (r.events >= 4) out.initiator = { events: r.events, first: r.first, share: Math.round(r.first / r.events * 100) / 100, lo: Math.round(lo * 100) / 100, hi: Math.round(hi * 100) / 100 };
            if (r.lags.length >= 3) out.medianLagMs = median(r.lags);
            res.set(u, out);
        }
        for (const [u, m] of outBy) {
            const tot = [...m.values()].reduce((a, b) => a + b, 0);
            if (tot < 8) continue;
            const hhi = [...m.values()].reduce((a, v) => a + (v / tot) ** 2, 0);
            const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
            const o = res.get(u) || res.set(u, {}).get(u);
            o.dependence = { total: tot, hhi: Math.round(hhi * 100) / 100, top: top[0], share: Math.round(top[1] / tot * 100) / 100 };
        }
        for (const o of res.values()) {
            const tags = [];
            if (o.initiator && o.initiator.share >= 0.5 && o.initiator.lo >= 0.3) tags.push('inicia');
            if (o.initiator && o.medianLagMs !== undefined && o.initiator.share <= 0.2 && o.medianLagMs <= 2 * MIN) tags.push('sigue de cerca');
            if (o.dependence && o.dependence.share >= 0.6) tags.push('depende de una cuenta');
            o.tags = tags;
        }
        return res;
    }

    // ---------- narrativas ----------
    /** Une eventos que comparten alguna publicación (un mismo tuit puede ser a la vez texto repetido, hashtag y enlace). */
    function narratives(events, rows, communityOf, listed) {
        const evs = events.filter(e => e.n >= 3);
        const df = new Map();
        for (const o of rows) for (const w of tokensOf(o)) df.set(w, (df.get(w) || 0) + 1);
        /** Palabras clave: frecuencia dentro de la narrativa por rareza en el registro (tf·idf), solo palabras con contenido y repetidas. */
        const keywordsOf = obs => {
            const tf = new Map();
            for (const o of obs) for (const w of tokensOf(o)) if (w[0] !== '#' && !/\.[a-z]{2,}$/.test(w)) tf.set(w, (tf.get(w) || 0) + 1);
            return [...tf.entries()].filter(([, n]) => n >= Math.max(2, Math.ceil(obs.length * 0.3))).map(([w, n]) => [w, n * Math.log((rows.length + 1) / (1 + (df.get(w) || 0)))])
                .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
        };
        const uf = Int32Array.from({ length: evs.length }, (_, i) => i);
        const find = x => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
        const owner = new Map();
        evs.forEach((e, i) => { for (const id of e.obsIds || e.participants.map(p => p.obsId)) { if (owner.has(id)) uf[find(i)] = find(owner.get(id)); else owner.set(id, i); } });
        const groups = new Map();
        evs.forEach((e, i) => { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(e); });
        const byObs = new Map(rows.map(o => [o.obsId, o]));
        const out = [];
        for (const g of groups.values()) {
            const obsIds = [...new Set(g.flatMap(e => e.obsIds || e.participants.map(p => p.obsId)))];
            const obs = obsIds.map(id => byObs.get(id)).filter(Boolean).sort((a, b) => a.t - b.t);
            if (!obs.length) continue;
            const first = new Map(); for (const o of obs) if (!first.has(o.authorUid)) first.set(o.authorUid, o);
            const accounts = [...first.values()];
            if (accounts.length < 3) continue;
            const counts = new Map(); for (const o of obs) counts.set(o.authorUid, (counts.get(o.authorUid) || 0) + 1);
            const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
            const top5 = sorted.slice(0, 5).reduce((s, [, c]) => s + c, 0) / obs.length;
            const t0 = accounts[0].t, t1 = accounts[accounts.length - 1].t;
            const span = Math.max(10 * MIN, (t1 - t0) * 1.1);
            const bins = 24, bw = Math.max(10000, Math.ceil(span / bins));
            const curve = Array.from({ length: bins + 1 }, () => 0), vol = Array.from({ length: bins + 1 }, () => 0);
            for (const a of accounts) curve[Math.min(bins, Math.floor((a.t - t0) / bw))]++;
            for (const o of obs) vol[Math.min(bins, Math.floor((o.t - t0) / bw))]++;
            for (let i = 1; i < curve.length; i++) curve[i] += curve[i - 1];
            const comm = new Map(); for (const a of accounts) { const c = communityOf[a.authorUid]; if (c !== undefined) comm.set(c, (comm.get(c) || 0) + 1); }
            const lab = (g.find(e => e.label) || {}).label || '';
            const head = obs.find(o => o.textNorm);
            const tags = new Map(); for (const o of obs) for (const t of o.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
            const topTag = [...tags.entries()].sort((a, b) => b[1] - a[1])[0];
            out.push({
                keywords: keywordsOf(obs),
                id: 'N' + g.map(e => e.id).sort()[0].slice(0, 40), label: (head && head.textNorm ? clip(head.textNorm, 140) : lab) || (topTag ? '#' + topTag[0] : 'Narrativa'),
                events: g.map(e => e.id), eventTypes: [...new Set(g.map(e => e.type))], accounts: accounts.length, observations: obs.length, first: t0, last: obs[obs.length - 1].t, spanMs: obs[obs.length - 1].t - t0,
                origin: accounts.slice(0, 5).map(a => ({ uid: a.authorUid, t: a.t, tweetId: a.tweetId })),
                onset: accounts.filter(a => a.t - t0 <= 5 * MIN).length,
                robust: { without3: { accounts: Math.max(0, accounts.length - 3), observations: obs.length - sorted.slice(0, 3).reduce((a, [, c]) => a + c, 0) } },
                concentration: { top5Share: Math.round(top5 * 100) / 100, gini: Math.round(gini([...counts.values()]) * 100) / 100, remainingWithout5: Math.max(0, accounts.length - 5) },
                listedShare: Math.round(accounts.filter(a => listed.has(a.authorUid)).length / accounts.length * 100) / 100,
                communities: [...comm.entries()].map(([c, n]) => ({ id: c, accounts: n })).sort((a, b) => b.accounts - a.accounts),
                timeline: { start: t0, binMs: bw, cumulative: curve, volume: vol }, hashtags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t),
                participants: accounts.slice(0, 200).map(a => ({ uid: a.authorUid, t: a.t, tweetId: a.tweetId })),
                alt: [...new Set(g.flatMap(e => e.alt || []))], level: g.some(e => e.level === 'E1') ? 'E1' : 'E0'
            });
        }
        return out.sort((a, b) => b.accounts - a.accounts || a.first - b.first).slice(0, 60);
    }

    // ---------- distribución en el plano (fuerzas) ----------
    /** Posiciones (0-1) con repulsión entre nodos y atracción por aristas; las comunidades parten agrupadas. Determinista con la misma semilla. */
    function layout(nodes, edges, partition, seed = 1) {
        const rnd = rng(seed), n = nodes.length;
        if (!n) return {};
        const comms = [...new Set(nodes.map(u => partition[u] ?? -1))];
        const cpos = new Map(comms.map((c, i) => [c, [0.5 + 0.33 * Math.cos(2 * Math.PI * i / comms.length), 0.5 + 0.33 * Math.sin(2 * Math.PI * i / comms.length)]]));
        const x = new Float64Array(n), y = new Float64Array(n);
        nodes.forEach((u, i) => { const c = cpos.get(partition[u] ?? -1); x[i] = c[0] + (rnd() - 0.5) * 0.12; y[i] = c[1] + (rnd() - 0.5) * 0.12; });
        const idx = new Map(nodes.map((u, i) => [u, i]));
        const links = edges.map(e => [idx.get(e.a), idx.get(e.b), Math.log2(1 + e.w)]).filter(l => l[0] !== undefined && l[1] !== undefined && l[0] !== l[1]);
        const deg = new Float64Array(n).fill(0);
        for (const [i, j] of links) { deg[i]++; deg[j]++; }
        const k = 0.9 / Math.sqrt(n), minD = Math.min(0.16, 1.6 / Math.sqrt(n) * 0.8);
        let temp = 0.14;
        for (let it = 0; it < 300; it++) {
            const dx = new Float64Array(n), dy = new Float64Array(n);
            for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
                let ex = x[i] - x[j], ey = y[i] - y[j], d2 = ex * ex + ey * ey + 1e-6; const d = Math.sqrt(d2);
                const f = k * k / d + (d < minD ? (minD - d) * 12 : 0); ex /= d; ey /= d;
                dx[i] += ex * f; dy[i] += ey * f; dx[j] -= ex * f; dy[j] -= ey * f;
            }
            for (const [i, j, w] of links) {
                let ex = x[i] - x[j], ey = y[i] - y[j]; const d = Math.sqrt(ex * ex + ey * ey + 1e-6);
                const f = d * d / k * Math.min(1.2, w) * 0.6 / Math.sqrt(Math.max(1, deg[i] * deg[j])); ex /= d; ey /= d;
                dx[i] -= ex * f; dy[i] -= ey * f; dx[j] += ex * f; dy[j] += ey * f;
            }
            for (let i = 0; i < n; i++) {
                dx[i] += (0.5 - x[i]) * 0.08; dy[i] += (0.5 - y[i]) * 0.08;
                const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) + 1e-9, s = Math.min(d, temp) / d;
                x[i] += dx[i] * s; y[i] += dy[i] * s;
            }
            temp *= 0.988;
        }
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < n; i++) { x0 = Math.min(x0, x[i]); x1 = Math.max(x1, x[i]); y0 = Math.min(y0, y[i]); y1 = Math.max(y1, y[i]); }
        const sx = x1 - x0 || 1, sy = y1 - y0 || 1;
        return Object.fromEntries(nodes.map((u, i) => [u, [Math.round(((x[i] - x0) / sx) * 1000) / 1000, Math.round(((y[i] - y0) / sy) * 1000) / 1000]]));
    }

    // ---------- análisis completo ----------
    const logW = n => Math.log2(1 + n);
    /** Cifra para el texto: coma decimal y dos decimales si es menor que 1 (0,02 en vez de 0,0). */
    const fmtN = x => (x < 1 ? x.toFixed(2) : x.toFixed(1)).replace('.', ',');
    const fmtQ = q => q.toFixed(3).replace('.', ',');
    /** Recorta en límite de palabra y añade … si hace falta. */
    function clip(t, n) { t = String(t || ''); if (t.length <= n) return t; const c = t.slice(0, n); return c.slice(0, Math.max(20, c.lastIndexOf(' '))).trim() + '…'; }

    /**
     * `rows`: observaciones; `events`: eventos del radar (con participantes y `obsIds`). Devuelve el grafo, las comunidades, los nodos relevantes,
     * las narrativas y los hallazgos. `opts.attrs` ({ uid: { followers, created } }) enriquece los nodos (solo como contexto).
     */
    function analyzeGraph(rows, events, opts = {}) {
        const P = { ...PARAMS, ...opts };
        // periodos en los que hubo actividad observada: el modelo nulo baraja solo dentro de ellos
        const axis = activitySegments([...rows.map(o => o.t), ...events.flatMap(e => (e.participants || []).map(p => p.t))], P.activityGapMs);
        P.axis = axis;
        const inter = buildInteractions(rows);
        const co = coparticipation(events, P);
        const coordEdges = co.pairs.map(r => ({ type: 'coord', a: r.a, b: r.b, n: r.support, w: r.w, p: r.p, q: r.q, expected: Math.round(r.expectedSupport * 100) / 100, evidence: r.events.slice(0, 8).map(i => co.events[i].id), lags: r.lags, evIdx: r.events }));

        // nivel de cada par: E1 coincidencia; E2 q < 0,05; E3 además persistente, con texto repetido y sin explicación alternativa dominante
        const half = co.T0 !== undefined ? co.T0 + (co.T1 - co.T0) / 2 : 0;
        for (const e of coordEdges) {
            const evs = e.evIdx.map(i => co.events[i]);
            const times = evs.map(x => x.first);
            const persistent = (Math.max(...times) - Math.min(...times) >= 6 * HOUR) || (times.some(t => t <= half) && times.some(t => t > half));
            const textual = evs.filter(x => x.type === 'texto').length >= 2;
            const altShare = evs.filter(x => (x.alt || []).length).length / evs.length;
            e.persistent = persistent; e.textual = textual; e.altShare = Math.round(altShare * 100) / 100;
            e.level = e.q < P.q ? (persistent && textual && altShare <= 1 / 3 ? 'E3' : 'E2') : 'E1';
            e.medianLagMs = median(e.lags);
        }
        // sensibilidad a la ventana: el par debe seguir siendo significativo con la mitad y con el doble de ventana (menos permutaciones)
        const pairKey = e => e.a + '\u0001' + e.b;
        const sigAt = scale => { const r = coparticipation(events, { ...P, tauScale: scale, permutations: P.sensPermutations }); return new Set(r.pairs.filter(x => x.q < P.q).map(pairKey)); };
        const sensSets = coordEdges.some(e => e.q < P.q) ? [sigAt(0.5), sigAt(2)] : [];
        for (const e of coordEdges) {
            e.holds = e.q < P.q ? 1 + sensSets.filter(set => set.has(pairKey(e))).length : 0;
            e.of = 3;
            if (e.level === 'E3' && e.holds < 3) e.level = 'E2';
        }
        const sig = coordEdges.filter(e => e.level !== 'E1');

        // aristas del grafo y comunidades (interacciones + coordinación significativa)
        const agg = new Map();
        const add = (a, b, w) => { const k = a < b ? a + '\u0001' + b : b + '\u0001' + a; const r = agg.get(k) || agg.set(k, { a: a < b ? a : b, b: a < b ? b : a, w: 0 }).get(k); r.w += w; };
        for (const e of inter.edges) add(e.a, e.b, logW(e.n) * (e.type === 'mention' ? 0.5 : 1));
        for (const e of sig) add(e.a, e.b, P.coordWeight * (1 + Math.log2(e.n)));
        const involved = new Set([...agg.values()].flatMap(r => [r.a, r.b]));
        const nodeIds = [...involved];
        const comm = communities(nodeIds, [...agg.values()], P);
        const prAll = pagerank(nodeIds, inter.edges.map(e => ({ a: e.a, b: e.b, w: logW(e.n) })));
        const rl = roles(events, inter.edges);

        // nodos
        const deg = new Map();
        const d = u => deg.get(u) || deg.set(u, { inW: 0, outW: 0, inN: 0, outN: 0, coord: 0, links: new Set() }).get(u);
        for (const e of inter.edges) { d(e.a).outW += e.n; d(e.a).outN++; d(e.b).inW += e.n; d(e.b).inN++; d(e.a).links.add(e.b); d(e.b).links.add(e.a); }
        for (const e of sig) { d(e.a).coord++; d(e.b).coord++; d(e.a).links.add(e.b); d(e.b).links.add(e.a); }
        const attrs = opts.attrs || {};
        // cuentas externas que interactúan a menudo con las de las listas: «afín» (amplifica, como cualquier persona convencida) o
        // «sincronizada» (además coincide en el tiempo con otras cuentas más de lo esperable por azar). Solo describe; no etiqueta.
        const toListed = new Map();
        for (const e of inter.edges) if (e.type !== 'mention' && inter.listed.has(e.b) && !inter.listed.has(e.a)) toListed.set(e.a, (toListed.get(e.a) || 0) + e.n);
        const nodeList = nodeIds.map(u => {
            const g = d(u), r = rl.get(u) || {}, a = attrs[u] || {};
            return { uid: u, role: inter.listed.has(u) ? 'lista' : inter.watched.has(u) ? 'vigilada' : 'externa', community: comm.partition[u], observations: inter.obsCount.get(u) || 0,
                inWeight: g.inW, outWeight: g.outW, degree: g.links.size, coordLinks: g.coord, pagerank: Math.round(prAll[u] * 100000) / 100000, tags: r.tags || [], initiator: r.initiator || null, medianLagMs: r.medianLagMs ?? null, dependence: r.dependence || null,
                followers: a.followers ?? null, created: a.created ?? null,
                candidate: !inter.listed.has(u) && (toListed.get(u) || 0) >= 3 ? { kind: g.coord > 0 ? 'sincronizada' : 'afín', interactions: toListed.get(u), coordLinks: g.coord } : null };
        });
        const importance = n => (n.role === 'lista' ? 2 : 0) + n.pagerank * 50 + n.degree * 0.1 + n.coordLinks * 0.5;
        nodeList.sort((a, b) => importance(b) - importance(a));
        const keep = new Set(nodeList.slice(0, P.maxNodes).map(n => n.uid));
        const nodes = nodeList.filter(n => keep.has(n.uid));

        // aristas a mostrar (solo entre nodos mostrados)
        const edges = [];
        for (const e of inter.edges) if (keep.has(e.a) && keep.has(e.b)) edges.push({ type: e.type, a: e.a, b: e.b, n: e.n, w: Math.round(logW(e.n) * 100) / 100, evidence: e.evidence });
        for (const e of sig) if (keep.has(e.a) && keep.has(e.b)) edges.push({ type: 'coord', a: e.a, b: e.b, n: e.n, expected: e.expected, w: Math.round(e.w * 100) / 100, q: Math.round(e.q * 10000) / 10000, level: e.level, holds: e.holds, of: e.of, evidence: e.evidence, medianLagMs: e.medianLagMs });
        const pos = layout(nodes.map(n => n.uid), edges.map(e => ({ a: e.a, b: e.b, w: e.type === 'coord' ? P.coordWeight * (1 + Math.log2(e.n)) : e.w })), comm.partition, P.seed);
        for (const n of nodes) n.pos = pos[n.uid];

        const narr = narratives(events, rows, comm.partition, inter.listed);
        const ck = checklists(rows, events, inter, sig, attrs);
        for (const n of nodes) { const c = ck.get(n.uid); n.checklist = c ? c.items : []; n.review = c ? c.review : false; }
        const terms = distinctive(rows, comm.partition);
        for (const c of comm.communities) c.terms = terms[c.id] || [];
        const cross = crossCommunity(rows, comm.partition, axis, P);
        const findings = buildFindings({ inter, coordEdges, sig, comm, events, narr, nodes: nodeList, rl, P, cross });
        const topics = topicStats(rows, comm.partition, opts.topics, sig);
        const shared = sharedTerms(rows, comm.partition);
        const review = nodes.filter(n => n.review);
        if (review.length) findings.unshift({
            id: 'F-revision', kind: 'revision', level: 'E3', title: `${review.length} ${review.length === 1 ? 'cuenta cumple' : 'cuentas cumplen'} varios criterios con sincronía sostenida`,
            summary: 'Cumplen al menos 3 de los 4 criterios de comportamiento coordinado (texto repetido en ventana corta, ráfagas, respuestas en masa a un mismo objetivo, amplificación concentrada) y tienen una pareja con sincronía sostenida. Conviene revisarlas a mano: la lista de verificación de cada cuenta muestra su evidencia.',
            accounts: review.map(n => n.uid), evidence: [], criteria: [{ label: 'Cuentas', value: String(review.length) }, { label: 'Criterios que exige cada una', value: '3 de C1–C4 + una pareja E3' }, { label: 'Criterios de contexto (C5, C6)', value: 'no cuentan' }],
            alternatives: [], stability: 'media', strength: 10000
        });
        const { axis: _axis, ...pub } = P;
        const calibration = {
            tested: coordEdges.length, significant: coordEdges.filter(e => e.q < P.q).length, pHistogram: histogram(co.pValues || []),
            placebo: coordEdges.length ? placebo(events, P) : { runs: 0, tested: 0, significant: 0, below05: 0 }
        };
        return {
            version: VERSION, params: { ...pub, tau: TAU },
            sample: { accounts: new Set(rows.map(o => o.authorUid)).size, nodes: nodeList.length, listed: nodeList.filter(n => n.role === 'lista').length, watched: nodeList.filter(n => n.role === 'vigilada').length, edges: inter.edges.length, coordPairsTested: coordEdges.length, coordSignificant: sig.length, activity: sufficiency(axis, rows) },
            nodes, edges, communities: comm.communities.filter(c => c.size >= 2).slice(0, 30), modularity: comm.modularity, narratives: narr, findings, review: nodes.filter(n => n.review).map(n => n.uid), calibration, crossCommunity: cross, topics, sharedTerms: shared
        };
    }

    // ---------- lista de verificación por cuenta (C1–C6: sin puntuación ni etiqueta) ----------
    const SPAN_MIN_DAYS = 3;
    /**
     * Para cada cuenta: qué criterios de comportamiento coordinado cumple, con su evidencia, o si faltan datos. C5 y C6 son solo contexto y
     * no cuentan para proponer una revisión. `review` solo dice "conviene revisarla a mano": la etiqueta la pone siempre una persona.
     */
    function checklists(rows, events, inter, sig, nodeAttrs) {
        const byAuthor = new Map();
        for (const o of rows) (byAuthor.get(o.authorUid) || byAuthor.set(o.authorUid, []).get(o.authorUid)).push(o);
        const textE1 = new Map(), sigBy = new Map(), outBy = new Map();
        for (const e of events) if (e.level === 'E1' && e.type === 'texto') for (const p of e.participants) (textE1.get(p.uid) || textE1.set(p.uid, []).get(p.uid)).push(e.id);
        for (const e of sig) for (const u of [e.a, e.b]) (sigBy.get(u) || sigBy.set(u, []).get(u)).push(e);
        for (const e of inter.edges) {
            if (e.type === 'mention') continue;
            const m = outBy.get(e.a) || outBy.set(e.a, new Map()).get(e.a);
            const r = m.get(e.b) || m.set(e.b, { n: 0, direct: 0, ev: [] }).get(e.b);
            r.n += e.n; if (e.type !== 'repost') r.direct += e.n; r.ev.push(...e.evidence);
        }
        const followers = Object.values(nodeAttrs).map(a => a && a.followers).filter(x => Number.isFinite(x)).sort((a, b) => a - b);
        const pctile = v => (followers.length >= 8 ? followers.filter(x => x <= v).length / followers.length : null);
        const out = new Map();
        for (const [u, list] of byAuthor) {
            const items = [];
            const st = (id, label, status, detail, evidence = []) => items.push({ id, label, status, detail, evidence: evidence.slice(0, 8) });
            // C1 texto idéntico o casi idéntico entre cuentas en ventana corta
            const t = textE1.get(u) || [], sg = sigBy.get(u) || [];
            if (list.length < 5) st('C1', 'Texto idéntico o casi idéntico en ventana corta', 'sin datos', 'Menos de 5 publicaciones observadas.');
            else if (new Set(t).size >= 2 && sg.length) st('C1', 'Texto idéntico o casi idéntico en ventana corta', 'cumple', `En ${new Set(t).size} eventos de texto con indicador y sincronía significativa con ${sg.length} cuentas.`, [...new Set(t)]);
            else st('C1', 'Texto idéntico o casi idéntico en ventana corta', 'no cumple', `${new Set(t).size} eventos de texto con indicador; ${sg.length} pares con sincronía significativa.`);
            // C2 activación en ráfagas respecto a su actividad habitual
            const ts = list.map(o => o.t), span = Math.max(...ts) - Math.min(...ts);
            if (list.length < 8 || span < SPAN_MIN_DAYS * DAY_MS) st('C2', 'Actividad concentrada en ráfagas', 'sin datos', `Hacen falta 8 publicaciones y ${SPAN_MIN_DAYS} días observados.`);
            else {
                const bins = new Map(); for (const x of ts) bins.set(Math.floor(x / (6 * HOUR)), (bins.get(Math.floor(x / (6 * HOUR))) || 0) + 1);
                const top2 = [...bins.values()].sort((a, b) => b - a).slice(0, 2).reduce((a, b) => a + b, 0) / list.length;
                st('C2', 'Actividad concentrada en ráfagas', top2 >= 0.8 ? 'cumple' : 'no cumple', `${Math.round(top2 * 100)} % de lo observado cae en 2 franjas de 6 h (de ${bins.size}).`);
            }
            // C3 respuestas en masa contra un mismo objetivo
            const tg = [...(outBy.get(u) || new Map()).entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.direct - a.direct);
            const tot = tg.reduce((a, x) => a + x.n, 0);
            if (!tg.length) st('C3', 'Respuestas en masa contra un mismo objetivo', 'sin datos', 'Sin respuestas, citas o reposts observados.');
            else if (tg[0].direct >= 5 && inter.listed.has(tg[0].k)) st('C3', 'Respuestas en masa contra un mismo objetivo', 'cumple', `${tg[0].direct} respuestas o citas a la misma cuenta de tus listas.`, tg[0].ev);
            else st('C3', 'Respuestas en masa contra un mismo objetivo', 'no cumple', `Máximo ${tg[0].direct} respuestas o citas a una misma cuenta.`);
            // C4 amplificación concentrada en pocas fuentes
            if (tot < 8) st('C4', 'Amplificación concentrada en pocas fuentes', 'sin datos', `Solo ${tot} interacciones observadas (mínimo 8).`);
            else {
                const hhi = tg.reduce((a, x) => a + (x.n / tot) ** 2, 0);
                st('C4', 'Amplificación concentrada en pocas fuentes', tg[0].n / tot >= 0.6 && hhi >= 0.4 ? 'cumple' : 'no cumple', `${Math.round(tg[0].n / tot * 100)} % de ${tot} interacciones va a una sola cuenta (índice de concentración ${hhi.toFixed(2).replace('.', ',')}).`, tg[0].ev);
            }
            // C5 y C6: contexto, nunca cuentan para el umbral
            const a = nodeAttrs[u] || {};
            const pc = Number.isFinite(a.followers) ? pctile(a.followers) : null;
            st('C5', 'Contexto de la cuenta (seguidores, antigüedad)', a.followers == null && !a.created ? 'sin datos' : 'contexto', [a.followers != null ? `${a.followers} seguidores${pc !== null ? ' (percentil ' + Math.round(pc * 100) + ' de la muestra)' : ''}` : '', a.created ? 'creada ' + new Date(a.created).toLocaleDateString('es') : ''].filter(Boolean).join(' · ') || 'Sin datos del perfil.');
            st('C6', 'Actividad casi exclusivamente política con poca respuesta', 'sin datos', 'No se evalúa: exigiría juzgar el contenido.');
            const met = items.filter(i => ['C1', 'C2', 'C3', 'C4'].includes(i.id) && i.status === 'cumple').length;
            out.set(u, { items, met, review: met >= 3 && sg.some(e => e.level === 'E3') });
        }
        return out;
    }
    const DAY_MS = 86400000;

    // ---------- términos distintivos de cada comunidad (razón de probabilidades logarítmica con prior informativo) ----------
    /** Palabras vacías (artículos, preposiciones, pronombres, verbos y adverbios comunes, saludos y ruido de redes) que no distinguen ninguna narrativa. Sin tildes. */
    const STOP = new Set('abajo about actualmente ademas ahi ahora algo alguien algun alguna algunas algunos alla alli also amp ano anos ante antes apenas aquel aquella aquellas aquello aquellos aqui arriba asi aun aunque ayer bajo basicamente bastante been bien buena buenas bueno buenos busca buscan buscar cada casi caso casos cerca cierta ciertas cierto ciertos clara claramente claras claro claros como completamente con contar contra cosa cosas cree creemos creen creer creo cual cuales cualquier cualquiera cuando cuanta cuantas cuanto cuantos cuenta cuentan cuya cuyo dado dar debajo decir definitivamente deja dejan dejar del delante demas demasiado dentro desde despues detras dia dias dice dicen diciendo dieron diferente diferentes diga digan digo dijeron dijo dio distinta distintas distinto distintos donde doy durante ella ellas ellos encima entonces entra entran entrar entre era eran eres esa esas ese eso esos especialmente espera esperan esperar esta estaba estaban estado estados estamos estan estar estas este esto estos estoy evidentemente exactamente existe existen existir favor finalmente forma formas from fue fuera fueron general generales generalmente gente gracias gran grande grandes haber habia habian habido habla hablado hablan hablando hablar hace hacen hacer hacia haciendo haga hagan han has hasta have hay haya hecho hicieron hilo hizo hola hoy http https hubo iba iban igual iguales importante importantes into jaja jajaja jajajaja jamas jeje jejeje junta juntas junto juntos just las lejos les like llama llamado llaman llamar llega llegan llegar lleva llevan llevar los luego lugar lugares mal mala malas malo malos manana manera maneras mas mayor mayores mediante mejor menor menores menos mientras mira miran mirar mis misma mismas mismo mismos momento momentos more mucha muchas mucho muchos muy nada nadie necesaria necesario necesita necesitan necesitar ningun ninguna ninguno ningunos noche noches nos nuestra nuestras nuestro nuestros nueva nuevas nuevo nuevos nunca obvia obviamente obvio ocurre ocurren ocurrir only other otra otras otro otros over para parece parecen parecer parte partes pasa pasado pasan pasar paso pasos pensar peor pero persona personas piensa piensan pienso poca pocas poco pocos podemos poder podria podrian pone ponen poner por porque posible posibles primer primera primeras primeros principal principales probablemente pudo pueda puedan puede pueden puedo pues puso que queda quedan quedar quedo queremos querer quien quienes quiera quieran quiere quieren quiero quiso quiza quizas real reales realmente resulta resultan retweet sabe sabemos saben saber sale salen salir sea seamos sean seguimos seguir segun segura seguramente seguro seguros sepa sepan ser sera seran seria serian servir sido siempre siendo sigue siguen simplemente sino sirve sirven sobre solamente solo some somos son such supo sus suya suyas suyo suyos tal tales tambien tampoco tanta tantas tanto tantos tarde tardes tema temas tenemos tener tenga tengan tengo tenia tenian teniendo than that their them then there these they this those thread tiene tienen tipo tipos toda todas todavia todo todos toma tomado toman tomar totalmente tras trata tratan tratar tus tuvieron tuvo tuya tuyo twitter ultima ultimas ultimo ultimos una unas uno unos usted ustedes vamos van varias varios vaya vayan vea veamos vean veces vemos venir veo ver verdad verdades very vez viene vienen vieron vino vio visto voy vuestra vuestro were what when which will with would www your'.split(' '));
    /** ¿Es una palabra con contenido? Longitud mínima 4, fuera las vacías, los números, las risas («jajaja») y los alargamientos («siiiii»). */
    const isContent = w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w) && !/^(?:ja|je|ji|jo|ju|ha|he|hi|ho|hu)+$/.test(w) && !/(.)\1{2,}/.test(w);
    function distinctive(rows, partition, { minCount = 4, z = 2.5, top = 6, alpha0 = 100 } = {}) {
        const tokens = tokensOf;
        const total = new Map(), byC = new Map(), nC = new Map();
        let N = 0;
        for (const o of rows) {
            const c = partition[o.authorUid];
            if (c === undefined || c < 0) continue;
            for (const w of tokens(o)) { total.set(w, (total.get(w) || 0) + 1); const m = byC.get(c) || byC.set(c, new Map()).get(c); m.set(w, (m.get(w) || 0) + 1); nC.set(c, (nC.get(c) || 0) + 1); N++; }
        }
        const res = {};
        for (const [c, m] of byC) {
            const n = nC.get(c);
            if (n < 20 || N - n < 20) continue;
            const arr = [];
            for (const [w, y] of m) {
                if (y < minCount) continue;
                const f = total.get(w), a = alpha0 * f / N, yo = f - y;
                // fuera lo que apenas se concentra: debe ser al menos 3 veces más frecuente dentro de la comunidad que fuera (lo corriente en todo el registro, como el tema de fondo, no distingue)
                if ((y / n) / (Math.max(yo, 0.5) / (N - n)) < 3) continue;
                const d = Math.log((y + a) / (n + alpha0 - y - a)) - Math.log((yo + a) / (N - n + alpha0 - yo - a));
                const zz = d / Math.sqrt(1 / (y + a) + 1 / (yo + a));
                if (zz >= z) arr.push({ term: w, kind: w[0] === '#' ? 'hashtag' : w.includes('.') && !w.includes(' ') && /\.[a-z]{2,}$/.test(w) ? 'sitio' : 'palabra', count: y, outside: yo, z: Math.round(zz * 10) / 10 });
            }
            if (arr.length) res[c] = arr.sort((a, b) => b.z - a.z).slice(0, top);
        }
        return res;
    }

    // ---------- comparación entre listas con los mismos criterios (simetría) ----------
    /** membership: { uid: [id de lista] }. Mismo detector para todas: cuántas de sus cuentas activas tienen sincronía significativa y cuánta. */
    function listComparison(nodes, membership) {
        const by = new Map();
        for (const n of nodes) {
            if (n.role !== 'lista') continue;
            for (const l of membership[n.uid] || []) {
                const r = by.get(l) || by.set(l, { list: l, accounts: 0, inSync: 0, coordLinks: 0, observations: 0, replied: 0 }).get(l);
                r.accounts++; r.observations += n.observations; r.coordLinks += n.coordLinks; if (n.coordLinks > 0) r.inSync++; r.replied += n.inWeight;
            }
        }
        return [...by.values()].map(r => ({ ...r, syncShare: r.accounts ? Math.round(r.inSync / r.accounts * 100) / 100 : 0, perAccount: r.accounts ? Math.round(r.observations / r.accounts * 10) / 10 : 0 })).sort((a, b) => b.accounts - a.accounts);
    }

    /** Palabras (≥ 5 letras), hashtags y sitios de una publicación, sin repetir: la base de los términos distintivos y de los temas compartidos. */
    function tokensOf(o) {
        const t = new Set();
        for (const x of o.tags || []) t.add('#' + x);
        for (const u of o.urls || []) { const m = /^https?:\/\/([^\/?#]+)/i.exec(u); if (m) t.add(m[1].replace(/^www\./, '')); }
        for (const w of String(o.textNorm || '').split(/[^a-z0-9ñ]+/)) if (isContent(w)) t.add(w);
        return t;
    }

    // ---------- temas y actividad simultánea de comunidades ----------
    /** Texto sin tildes ni mayúsculas, como el que guarda el registro. */
    const fold = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const termKind = w => (w[0] === '#' ? 'hashtag' : /\.[a-z]{2,}$/.test(w) ? 'sitio' : 'palabra');

    /**
     * Un tema lo define quien analiza con una lista de palabras: «reforma, pension*, salud mental». Una palabra suelta coincide con la palabra
     * entera (o con un hashtag igual), «pension*» con cualquier palabra que empiece así y una frase con ese texto seguido. Sin modelos
     * ni IA: se ve exactamente por qué una publicación cuenta para un tema.
     */
    function compileTopic(t) {
        const words = new Set(), prefixes = [], phrases = [];
        for (const raw of (t && t.words) || []) {
            const w = fold(raw).replace(/^#/, '');
            if (!w) continue;
            if (/\s/.test(w)) phrases.push(w);
            else if (w.endsWith('*') && w.length > 3) prefixes.push(w.slice(0, -1));
            else words.add(w);
        }
        const hit = w => words.has(w) || prefixes.some(p => w.startsWith(p));
        return o => {
            for (const tg of o.tags || []) if (hit(fold(tg))) return true;
            const text = o.textNorm || '';
            if (!text) return false;
            if (phrases.some(p => text.includes(p))) return true;
            for (const w of text.split(/[^a-z0-9]+/)) if (w && hit(w)) return true;
            return false;
        };
    }

    /**
     * Fichas por tema: cuánta actividad hay, de cuántas cuentas, cómo se reparte entre comunidades, cuándo y quién entró primero.
     * `sig`: pares con sincronía significativa (cuántos de ellos participan en el tema).
     */
    function topicStats(rows, partition, topics, sig = []) {
        const out = [];
        for (const t of (topics || []).slice(0, 30)) {
            const match = compileTopic(t);
            const obs = rows.filter(match).sort((a, b) => a.t - b.t);
            const base = { id: t.id, name: t.name, words: t.words || [] };
            if (!obs.length) { out.push({ ...base, observations: 0, accounts: 0 }); continue; }
            const accounts = new Set(obs.map(o => o.authorUid));
            const t0 = obs[0].t, t1 = obs[obs.length - 1].t, bins = 24, binMs = Math.max(10000, Math.ceil(Math.max(10 * MIN, (t1 - t0) * 1.1) / bins));
            const counts = new Array(bins + 1).fill(0), byC = new Map(), perAcc = new Map(), firstSeen = new Map();
            for (const o of obs) {
                const bin = Math.min(bins, Math.floor((o.t - t0) / binMs));
                counts[bin]++;
                perAcc.set(o.authorUid, (perAcc.get(o.authorUid) || 0) + 1);
                if (!firstSeen.has(o.authorUid)) firstSeen.set(o.authorUid, o);
                const c = partition[o.authorUid] === undefined ? -1 : partition[o.authorUid];
                const r = byC.get(c) || byC.set(c, { id: c, uids: new Set(), observations: 0, series: new Array(bins + 1).fill(0) }).get(c);
                r.uids.add(o.authorUid); r.observations++; r.series[bin]++;
            }
            out.push({
                ...base, observations: obs.length, accounts: accounts.size, first: t0, last: t1, spanMs: t1 - t0,
                byCommunity: [...byC.values()].map(r => ({ id: r.id, accounts: r.uids.size, observations: r.observations, share: Math.round(r.observations / obs.length * 100) / 100, series: r.series })).sort((a, b) => b.observations - a.observations),
                timeline: { start: t0, binMs, counts },
                top: [...perAcc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([uid, n]) => ({ uid, n })),
                origin: [...firstSeen.values()].slice(0, 5).map(o => ({ uid: o.authorUid, t: o.t, tweetId: o.tweetId })),
                evidence: obs.slice(0, 8).map(o => o.tweetId),
                syncedPairs: sig.filter(e => accounts.has(e.a) && accounts.has(e.b)).length
            });
        }
        return out;
    }

    /** Palabras, hashtags y sitios que usan a la vez varias comunidades y que no son corrientes en el registro (sin definir temas antes). */
    function sharedTerms(rows, partition, { minAccounts = 3, minCommunities = 2, maxShare = 0.08, top = 12 } = {}) {
        const size = new Map();
        for (const c of Object.values(partition)) if (c >= 0) size.set(c, (size.get(c) || 0) + 1);
        const df = new Map(), by = new Map();
        for (const o of rows) {
            const c = partition[o.authorUid];
            for (const w of tokensOf(o)) {
                df.set(w, (df.get(w) || 0) + 1);
                if (c === undefined || c < 0) continue;
                const m = by.get(w) || by.set(w, new Map()).get(w);
                (m.get(c) || m.set(c, new Set()).get(c)).add(o.authorUid);
            }
        }
        const res = [];
        for (const [w, m] of by) {
            if (df.get(w) / Math.max(1, rows.length) > maxShare) continue;
            const cs = [...m.entries()].filter(([c, set]) => set.size >= minAccounts && (size.get(c) || 0) >= 4).map(([c, set]) => ({ id: c, accounts: set.size })).sort((a, b) => b.accounts - a.accounts);
            if (cs.length >= minCommunities) res.push({ term: w, kind: termKind(w), posts: df.get(w), communities: cs.slice(0, 4), total: cs.reduce((s, x) => s + x.accounts, 0) });
        }
        return res.sort((a, b) => b.communities.length - a.communities.length || b.total - a.total).slice(0, top);
    }

    /**
     * ¿Aumentan su actividad a la vez dos comunidades distintas, aunque hablen de cosas distintas? Se mide sobre la actividad, no sobre el
     * contenido: en franjas de 10 min de los periodos observados, un «pico» de una comunidad es una franja con muchas más cuentas distintas
     * activas de lo habitual en ella. Se cuentan los picos que coinciden y se compara con el azar desplazando una de las dos series (conserva
     * el ritmo de cada comunidad). Para no confundir con un acontecimiento que mueve a todo el mundo, se descartan las franjas en las que
     * se activan la mitad o más de las comunidades. Control de falsos descubrimientos (Benjamini–Hochberg) entre todos los pares.
     */
    function crossCommunity(rows, partition, axis, opts = {}) {
        const P = { ...PARAMS, ...opts };
        const BIN = P.burstBinMs;
        const NB = axis && axis.total ? Math.ceil(axis.total / BIN) : 0;
        const res = { binMs: BIN, bins: NB, eligible: 0, tested: 0, pairs: [], note: '' };
        if (NB < 24) { res.note = 'Hay poca actividad observada para comparar comunidades.'; return res; }
        const binOf = t => Math.min(NB - 1, Math.floor(toAxis(axis, t) / BIN));
        const members = new Map();
        for (const [u, c] of Object.entries(partition)) if (c >= 0) (members.get(c) || members.set(c, new Set()).get(c)).add(u);
        const comm = new Map(), rowBin = new Int32Array(rows.length).fill(-1);
        rows.forEach((o, i) => {
            const c = partition[o.authorUid];
            if (c === undefined || c < 0) return;
            const b = binOf(o.t);
            rowBin[i] = b;
            const m = comm.get(c) || comm.set(c, new Map()).get(c);
            (m.get(b) || m.set(b, new Set()).get(b)).add(o.authorUid);
        });
        // fase 1: picos de cada comunidad. Una franja en la que se activan muchas comunidades a la vez es un acontecimiento general, no una pareja
        const cand = [];
        for (const [c, mem] of members) {
            const m = comm.get(c);
            if (mem.size < 4 || !m) continue;
            const vals = [...m.entries()].map(([b, s]) => [b, s.size]);
            if (vals.length < 8) continue;
            const sorted = vals.map(v => v[1]).sort((a, b) => a - b);
            const thr = Math.max(3, sorted[Math.floor(0.9 * (sorted.length - 1))]);
            const bursts = vals.filter(([, n]) => n >= thr).map(([b]) => b);
            if (bursts.length >= 3) cand.push({ c, size: mem.size, bursts });
        }
        const nb = new Map();
        for (const x of cand) for (const b of x.bursts) nb.set(b, (nb.get(b) || 0) + 1);
        const general = Math.max(3, Math.ceil(0.5 * cand.length));
        const masked = b => (nb.get(b) || 0) >= general;
        const elig = cand.map(x => { const bursts = x.bursts.filter(b => !masked(b)).sort((a, b) => a - b); return { ...x, bursts, set: new Set(bursts) }; }).filter(x => x.bursts.length >= 3);
        res.eligible = elig.length;
        const rnd = rng(P.seed + 31), tests = [];
        for (let i = 0; i < elig.length; i++) for (let j = i + 1; j < elig.length; j++) {
            const A = elig[i], B = elig[j];
            const both = A.bursts.filter(b => B.set.has(b));
            let p = 1, expected = 0;
            if (both.length >= 2) {
                let ge = 0, sum = 0;
                for (let it = 0; it < P.crossPermutations; it++) {
                    const s = 1 + Math.floor(rnd() * (NB - 1));
                    let k = 0;
                    for (const b of A.bursts) if (B.set.has((b + s) % NB)) k++;
                    sum += k; if (k >= both.length) ge++;
                }
                p = (1 + ge) / (1 + P.crossPermutations); expected = sum / P.crossPermutations;
            }
            tests.push({ A, B, both, p, expected });
        }
        res.tested = tests.length;
        const q = benjaminiHochberg(tests.map(t => t.p));
        const keep = tests.map((t, i) => ({ ...t, q: q[i] })).filter(t => t.both.length >= 3);
        // lo que dijo cada comunidad en las franjas que coinciden (un solo recorrido por los registros)
        const need = new Set();
        for (const t of keep) for (const b of t.both) { need.add(t.A.c + '|' + b); need.add(t.B.c + '|' + b); }
        const cell = new Map();
        rows.forEach((o, i) => {
            const b = rowBin[i];
            if (b < 0) return;
            const k = partition[o.authorUid] + '|' + b;
            if (need.has(k)) (cell.get(k) || cell.set(k, []).get(k)).push(o);
        });
        const topTerms = (list, n = 5) => {
            const cnt = new Map();
            for (const o of list) for (const w of tokensOf(o)) cnt.set(w, (cnt.get(w) || 0) + 1);
            return [...cnt.entries()].filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
        };
        res.pairs = keep.map(t => {
            const bins = t.both.map(b => {
                const ra = cell.get(t.A.c + '|' + b) || [], rb = cell.get(t.B.c + '|' + b) || [];
                return { t: fromAxis(axis, b * BIN), a: { accounts: new Set(ra.map(o => o.authorUid)).size, terms: topTerms(ra), evidence: ra.slice(0, 2).map(o => o.tweetId) }, b: { accounts: new Set(rb.map(o => o.authorUid)).size, terms: topTerms(rb), evidence: rb.slice(0, 2).map(o => o.tweetId) } };
            });
            const ta = new Set(bins.flatMap(x => x.a.terms)), tb = new Set(bins.flatMap(x => x.b.terms));
            const union = new Set([...ta, ...tb]);
            const shared = [...ta].filter(w => tb.has(w)).length;
            const accounts = [...new Set(t.both.flatMap(b => [...(cell.get(t.A.c + '|' + b) || []), ...(cell.get(t.B.c + '|' + b) || [])].map(o => o.authorUid)))];
            return {
                a: t.A.c, b: t.B.c, sizeA: t.A.size, sizeB: t.B.size, burstsA: t.A.bursts.length, burstsB: t.B.bursts.length,
                coincident: t.both.length, expected: Math.round(t.expected * 100) / 100, p: t.p, q: t.q,
                level: t.q < P.q ? 'E2' : 'E1', othersShare: Math.round(t.both.filter(b => (nb.get(b) || 0) >= 3).length / t.both.length * 100) / 100,
                sharedVocabulary: union.size ? Math.round(shared / union.size * 100) / 100 : null,
                accounts: accounts.slice(0, 40), bins: bins.slice(0, 12)
            };
        }).sort((x, y) => (y.level === 'E2') - (x.level === 'E2') || x.q - y.q || y.coincident - x.coincident);
        return res;
    }

    // ---------- hallazgos ----------
    const LEVEL_RANK = { E3: 3, E2: 2, E1: 1, E0: 0 };

    function buildFindings({ inter, coordEdges, sig, comm, events, narr, nodes, rl, P, cross }) {
        const out = [];
        const nodeBy = new Map(nodes.map(n => [n.uid, n]));
        const evById = new Map(events.map(e => [e.id, e]));

        // 1 · núcleos con coordinación estadísticamente significativa (componentes conexos de aristas E2/E3)
        {
            const adj = new Map();
            for (const e of sig) { (adj.get(e.a) || adj.set(e.a, []).get(e.a)).push(e); (adj.get(e.b) || adj.set(e.b, []).get(e.b)).push(e); }
            const seen = new Set();
            for (const start of adj.keys()) {
                if (seen.has(start)) continue;
                const members = new Set([start]), stack = [start], edges = [];
                seen.add(start);
                while (stack.length) { const u = stack.pop(); for (const e of adj.get(u)) { edges.push(e); const v = e.a === u ? e.b : e.a; if (!seen.has(v)) { seen.add(v); members.add(v); stack.push(v); } } }
                if (members.size < 3) continue;
                const uniq = [...new Set(edges)];
                const evIds = new Set(uniq.flatMap(e => e.evidence)), evs = [...evIds].map(id => evById.get(id)).filter(Boolean);
                const lvl = uniq.every(e => e.level === 'E3') ? 'E3' : 'E2';
                const listedIn = [...members].filter(u => inter.listed.has(u));
                const lags = uniq.map(e => e.medianLagMs).filter(x => x != null);
                const obsN = uniq.reduce((s, e) => s + e.n, 0), expN = uniq.reduce((s, e) => s + (e.expected || 0), 0);
                out.push({
                    id: 'F-core-' + [...members].sort()[0], kind: 'nucleo', level: lvl,
                    title: `Núcleo de ${members.size} cuentas que publican en sincronía`,
                    summary: `${members.size} cuentas coinciden en ${evs.length} eventos distintos con horas muy próximas: ${obsN} coincidencias frente a ≈${fmtN(expN)} esperables por azar (q máx. ${fmtQ(Math.max(...uniq.map(e => e.q)))} en ${uniq.length} pares).`,
                    accounts: [...members], listedAccounts: listedIn, evidence: [...new Set(evs.flatMap(e => e.participants.slice(0, 5).map(p => p.tweetId)))].slice(0, 12), events: [...evIds].slice(0, 20),
                    criteria: [
                        { label: 'Pares con coparticipación significativa', value: `${uniq.length} (q < ${P.q})` },
                        { label: 'Coincidencias observadas / esperadas por azar', value: `${obsN} / ${fmtN(expN)}` },
                        { label: 'Eventos distintos', value: String(evs.length) },
                        { label: 'Eventos de texto repetido', value: String(evs.filter(e => e.type === 'texto').length) },
                        { label: 'Retardo mediano entre cuentas', value: lags.length ? Math.round(median(lags) / 1000) + ' s' : '–' },
                        { label: 'Persistencia (≥ 6 h o ambas mitades del periodo)', value: uniq.some(e => e.persistent) ? 'sí' : 'no' },
                        { label: 'Pares que se mantienen con la mitad y el doble de ventana', value: `${uniq.filter(e => e.holds === 3).length} de ${uniq.length}` }
                    ],
                    alternatives: [...new Set(evs.flatMap(e => e.alt || []))], stability: uniq.every(e => e.holds >= 2) && uniq.filter(e => e.holds === 3).length >= 0.8 * uniq.length ? 'alta' : uniq.every(e => e.holds >= 2) ? 'media' : 'baja',
                    strength: LEVEL_RANK[lvl] * 100 + members.size * 5 + evs.length
                });
            }
        }

        // 2 · red de apoyo a una cuenta de la lista: varias externas responden o amplifican de forma concentrada a la misma cuenta
        {
            const byTarget = new Map();
            const outTot = new Map();
            for (const e of inter.edges) outTot.set(e.a, (outTot.get(e.a) || 0) + e.n);
            const per = new Map();
            for (const e of inter.edges) if (e.type !== 'mention') { const k = e.a + '\u0001' + e.b; const r = per.get(k) || per.set(k, { a: e.a, b: e.b, n: 0, ev: [], types: new Set() }).get(k); r.n += e.n; r.ev.push(...e.evidence); r.types.add(e.type); }
            for (const r of per.values()) {
                if (inter.listed.has(r.a) || r.n < 5 || r.n / (outTot.get(r.a) || 1) < 0.6 || !inter.listed.has(r.b)) continue;
                (byTarget.get(r.b) || byTarget.set(r.b, []).get(r.b)).push(r);
            }
            for (const [target, list] of byTarget) {
                if (list.length < 3) continue;
                const members = list.map(r => r.a);
                const coordIn = sig.filter(e => members.includes(e.a) && members.includes(e.b));
                const lvl = coordIn.length ? (coordIn.every(e => e.level === 'E3') ? 'E3' : 'E2') : 'E1';
                const total = list.reduce((s, r) => s + r.n, 0);
                out.push({
                    id: 'F-apoyo-' + target, kind: 'apoyo', level: lvl,
                    title: `${list.length} cuentas externas concentran su actividad en una misma cuenta de la lista`,
                    summary: `${list.length} cuentas que no están en las listas dirigen ${total} interacciones (respuestas, citas y reposts) a la misma cuenta, cada una con al menos el 60 % de sus interacciones.${coordIn.length ? ` Además, ${coordIn.length} de sus pares coinciden en sincronía de forma significativa.` : ''}`,
                    accounts: members, target, evidence: [...new Set(list.flatMap(r => r.ev))].slice(0, 12),
                    criteria: [
                        { label: 'Cuentas externas con ≥ 5 interacciones y ≥ 60 % hacia el mismo destino', value: String(list.length) },
                        { label: 'Interacciones totales hacia ese destino', value: String(total) },
                        { label: 'Pares con coparticipación significativa', value: String(coordIn.length) }
                    ],
                    alternatives: [], stability: list.length >= 5 ? 'alta' : 'media', strength: LEVEL_RANK[lvl] * 100 + list.length * 5 + total * 0.1
                });
            }
        }

        // 3 · narrativas concentradas en pocas cuentas (si un núcleo ya las explica, no se repiten)
        const nuclei = out.filter(f => f.kind === 'nucleo').map(f => new Set(f.accounts));
        for (const n of narr) {
            if (n.accounts < 6 || n.concentration.top5Share < 0.7) continue;
            if (nuclei.some(set => n.participants.filter(p => set.has(p.uid)).length / n.participants.length >= 0.8)) continue;
            const coordIn = sig.filter(e => n.participants.some(p => p.uid === e.a) && n.participants.some(p => p.uid === e.b));
            const lvl = coordIn.length ? 'E2' : 'E1';
            out.push({
                id: 'F-narr-' + n.id, kind: 'narrativa', level: lvl,
                title: 'Narrativa impulsada por pocas cuentas',
                summary: `«${clip(n.label, 90)}»: ${n.accounts} cuentas, pero 5 de ellas generan el ${Math.round(n.concentration.top5Share * 100)} % de las publicaciones; ${n.onset >= 3 ? `${n.onset} cuentas arrancan en los primeros 5 minutos` : 'sin arranque simultáneo claro'}.`,
                accounts: n.participants.slice(0, 12).map(p => p.uid), evidence: n.participants.slice(0, 12).map(p => p.tweetId), narrative: n.id,
                criteria: [
                    { label: 'Cuentas / publicaciones', value: `${n.accounts} / ${n.observations}` },
                    { label: 'Cuota de las 5 cuentas más activas', value: Math.round(n.concentration.top5Share * 100) + ' %' },
                    { label: 'Cuentas que quedan sin esas 5', value: String(n.concentration.remainingWithout5) },
                    { label: 'Arranque (cuentas en los primeros 5 min)', value: String(n.onset) }
                ],
                alternatives: n.alt, stability: 'media', strength: LEVEL_RANK[lvl] * 100 + n.accounts
            });
        }

        // 4 · cuentas puente entre comunidades
        {
            const byComm = new Map();
            for (const e of inter.edges) for (const [u, v] of [[e.a, e.b], [e.b, e.a]]) { const cv = comm.partition[v]; if (cv === undefined) continue; const m = byComm.get(u) || byComm.set(u, new Map()).get(u); m.set(cv, (m.get(cv) || 0) + e.n); }
            for (const [u, m] of byComm) {
                const tot = [...m.values()].reduce((a, b) => a + b, 0);
                const big = [...m.entries()].filter(([, v]) => v >= 3 && v / tot >= 0.25).sort((a, b) => b[1] - a[1]);
                if (big.length < 2 || tot < 10) continue;
                out.push({
                    id: 'F-puente-' + u, kind: 'puente', level: 'E0', title: 'Cuenta que conecta dos comunidades',
                    summary: `Reparte sus ${tot} interacciones entre ${big.length} comunidades distintas (${big.map(([c, v]) => 'C' + (c + 1) + ': ' + Math.round(v / tot * 100) + ' %').join(', ')}).`,
                    accounts: [u], evidence: [], criteria: [{ label: 'Comunidades con ≥ 25 % de sus interacciones', value: String(big.length) }, { label: 'Interacciones', value: String(tot) }],
                    alternatives: [], stability: 'media', strength: 10 + tot * 0.05
                });
            }
        }

        // 5 · contexto: cuentas creadas en fechas muy cercanas dentro de una comunidad (solo contexto, nunca prueba)
        {
            for (const c of comm.communities) {
                const withDate = c.members.map(u => nodeBy.get(u)).filter(n => n && n.created && Number.isFinite(Date.parse(n.created)));
                if (withDate.length < 4) continue;
                const ts = withDate.map(n => Date.parse(n.created)).sort((a, b) => a - b);
                let best = [];
                for (let i = 0; i < ts.length; i++) { const grp = ts.filter(t => t >= ts[i] && t - ts[i] <= 14 * 86400000); if (grp.length > best.length) best = grp; }
                if (best.length < 4 || best.length / withDate.length < 0.5) continue;
                out.push({
                    id: 'F-oleada-' + c.id, kind: 'contexto', level: 'E0', title: 'Contexto: cuentas creadas en fechas muy cercanas',
                    summary: `${best.length} de ${withDate.length} cuentas de la comunidad C${c.id + 1} con fecha de alta conocida se crearon en un lapso de 14 días. Es solo contexto: no prueba nada por sí mismo.`,
                    accounts: withDate.filter(n => { const t = Date.parse(n.created); return t >= best[0] && t <= best[best.length - 1]; }).map(n => n.uid), evidence: [],
                    criteria: [{ label: 'Cuentas creadas en 14 días', value: `${best.length} de ${withDate.length}` }], alternatives: ['migración masiva a la plataforma o campaña de registro abierta'], stability: 'baja', strength: 5
                });
            }
        }
        // 6 · actividad simultánea de dos comunidades distintas (picos de actividad que coinciden más de lo esperable)
        for (const pr of (cross && cross.pairs) || []) {
            const fmt1 = fmtN;
            const mins = Math.round(cross.binMs / MIN);
            out.push({
                id: 'F-cruce-' + pr.a + '-' + pr.b, kind: 'cruce', level: pr.level,
                title: `Las comunidades C${pr.a + 1} y C${pr.b + 1} aumentan su actividad a la vez`,
                summary: `Coinciden ${pr.coincident} picos de actividad (franjas de ${mins} min) frente a ≈${fmt1(pr.expected)} esperables por azar${pr.level === 'E2' ? ` (q = ${fmtQ(pr.q)})` : ', sin llegar a ser improbable por azar'}.${pr.sharedVocabulary !== null && pr.sharedVocabulary <= 0.25 ? ' En esos picos hablan de cosas distintas: solo comparten el ' + Math.round(pr.sharedVocabulary * 100) + ' % del vocabulario.' : ''}`,
                accounts: pr.accounts.slice(0, 24), evidence: [...new Set(pr.bins.flatMap(b => [...b.a.evidence, ...b.b.evidence]))].slice(0, 12),
                criteria: [
                    { label: 'Picos de C' + (pr.a + 1) + ' / de C' + (pr.b + 1), value: `${pr.burstsA} / ${pr.burstsB}` },
                    { label: 'Picos simultáneos observados / esperados por azar', value: `${pr.coincident} / ${fmt1(pr.expected)}` },
                    { label: 'Vocabulario compartido en esos picos', value: pr.sharedVocabulary === null ? '–' : Math.round(pr.sharedVocabulary * 100) + ' %' },
                    { label: 'Picos en los que otras comunidades también se activan', value: Math.round(pr.othersShare * 100) + ' %' }
                ],
                alternatives: pr.othersShare >= 0.5 ? ['varias comunidades se activan a la vez: puede ser un acontecimiento general'] : [], stability: 'media',
                strength: LEVEL_RANK[pr.level] * 100 + pr.coincident * 3
            });
        }
        return out.sort((a, b) => b.strength - a.strength).slice(0, 40);
    }

    return { GRAPH_VERSION: VERSION, GRAPH_PARAMS: PARAMS, wilson, gini, benjaminiHochberg, buildInteractions, coparticipation, activitySegments, toAxis, fromAxis, placebo, shuffledEvents, tokensOf, compileTopic, topicStats, sharedTerms, crossCommunity, louvain, communities, pagerank, roles, narratives, layout, checklists, distinctive, listComparison, analyzeGraph };
});
