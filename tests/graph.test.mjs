// node --test tests/   ·   Análisis relacional con datos sintéticos de VERDAD CONOCIDA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.XAF = require('../extension/src/matcher.js');
const O = require('../extension/src/observe.js');
const R = require('../extension/src/radar.js');
const G = require('../extension/src/graph.js');

const T0 = 1793500000000;
const S = 1000, MIN = 60 * S, HOUR = 60 * MIN, DAY = 24 * HOUR;
let seq = 5000;
let seed = 424242;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const WORDS = 'casa perro tiempo ciudad gobierno semana mañana verdad pueblo camino noche historia mundo trabajo familia dinero calle música cielo montaña río amigo libro viaje fuerza palabra razón futuro'.split(' ');
const sentence = (n = 16) => Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ');

function ob(author, t, text, extra = {}) {
    const norm = O.normalizeForMatch(text || '');
    const { tl, tw } = R.textStats(norm);
    const id = String(++seq);
    return {
        obsId: id + ':' + (extra.kind || 'post'), tweetId: id, kind: 'post', authorUid: 'u:' + author, t,
        th: norm ? createHash('sha256').update(norm).digest('hex').slice(0, 32) : null, sh: norm ? R.simhash(norm) : null, tl, tw, textNorm: norm.slice(0, 300),
        urls: [], tags: [], mentions: [], media: [], rel: ['a'], ctx: { op: 'HomeTimeline', scope: 'home' }, counts: null, ...extra
    };
}
const run = obs => { const r = R.analyze(obs); return { r, g: G.analyzeGraph(obs, r.events) }; };

/** Un grupo que publica el mismo texto con segundos de diferencia, varias veces a lo largo del día. */
function coordinated(prefix, n, events, obs, startT = T0, span = DAY) {
    for (let k = 0; k < events; k++) {
        const text = sentence(18), base = startT + Math.floor((k + rand() * 0.5) * (span / events));
        for (let i = 0; i < n; i++) obs.push(ob(prefix + i, base + i * 7 * S + Math.floor(rand() * 4 * S), text));
    }
}
/** Ruido orgánico: muchas cuentas que comparten enlaces a horas aleatorias (generan eventos pero no sincronía repetida). */
function organic(count, events, perEvent, obs) {
    for (let k = 0; k < events; k++) {
        const url = 'https://noticias.example/n' + k;
        for (let i = 0; i < perEvent; i++) obs.push(ob('org' + Math.floor(rand() * count), T0 + Math.floor(rand() * DAY), sentence(14), { urls: [url] }));
    }
}

/** Actividad de fondo: publicaciones sueltas (textos distintos) de muchas cuentas durante todo el periodo, como en un registro real. */
function background(obs, n = 400, startT = T0, span = DAY) {
    for (let i = 0; i < n; i++) obs.push(ob('fondo' + Math.floor(rand() * 60), startT + Math.floor(rand() * span), sentence(14)));
}

test('benjaminiHochberg: valores q monótonos y conservadores', () => {
    const q = G.benjaminiHochberg([0.001, 0.01, 0.03, 0.5, 0.9]);
    assert.deepEqual(q.map(x => Math.round(x * 1000) / 1000), [0.005, 0.025, 0.05, 0.625, 0.9]);
    assert.ok(q.every(x => x <= 1));
});

test('wilson y gini: valores de referencia', () => {
    const [lo, hi] = G.wilson(8, 10);
    assert.ok(lo > 0.47 && lo < 0.5 && hi > 0.93 && hi < 0.96, lo + ' ' + hi);
    assert.equal(G.gini([5, 5, 5, 5]), 0);
    assert.ok(G.gini([0, 0, 0, 100]) > 0.7);
});

test('verdad conocida: el núcleo coordinado sale como pares significativos y el ruido orgánico no entra', () => {
    const obs = [];
    coordinated('bod', 6, 8, obs);
    organic(60, 15, 8, obs);
    const { g } = run(obs);
    const sig = g.edges.filter(e => e.type === 'coord');
    assert.equal(sig.length, 15, 'C(6,2)=15 pares: ' + sig.length);
    assert.ok(sig.every(e => e.a.startsWith('u:bod') && e.b.startsWith('u:bod') && e.q < 0.05 && e.n >= 3), 'solo cuentas bod con q < 0,05');
    const core = g.findings.find(f => f.kind === 'nucleo');
    assert.ok(core, 'hay un hallazgo de núcleo: ' + JSON.stringify(g.findings.map(f => f.kind)));
    assert.equal(core.accounts.length, 6);
    assert.ok(core.accounts.every(a => a.startsWith('u:bod')));
    assert.ok(['E2', 'E3'].includes(core.level));
    assert.ok(core.evidence.length > 0 && core.criteria.length >= 4, 'lleva evidencia y criterios');
    assert.ok(!core.accounts.some(a => a.startsWith('u:org')), 'ninguna cuenta orgánica');
});

test('control nulo: sin coordinación real no hay pares significativos (control de falsos descubrimientos)', () => {
    const obs = [];
    organic(50, 25, 10, obs);
    const { g } = run(obs);
    assert.equal(g.sample.coordSignificant, 0, 'pares significativos: ' + g.sample.coordSignificant);
    assert.ok(!g.findings.some(f => f.kind === 'nucleo'));
});

test('una coincidencia suelta no basta: menos de 3 eventos compartidos no genera pares', () => {
    const obs = [];
    coordinated('par', 3, 2, obs);
    const { g } = run(obs);
    assert.equal(g.sample.coordPairsTested, 0);
    assert.equal(g.findings.filter(f => f.kind === 'nucleo').length, 0);
});

test('un evento masivo pesa menos que uno pequeño (c = 1/ln(1+n))', () => {
    const small = 1 / Math.log(1 + 4), big = 1 / Math.log(1 + 60);
    assert.ok(big < small / 1.8);
});

test('comunidades: dos grupos que se responden entre sí quedan separados, y el puente no los fusiona', () => {
    const obs = [];
    const reply = (a, b, k) => obs.push(ob(a, T0 + k * 3 * MIN, sentence(10), { kind: 'reply', targetAuthorUid: 'u:' + b, targetId: String(100 + k), rel: ['p'] }));
    let k = 0;
    for (let rep = 0; rep < 4; rep++) for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) if (i !== j) { reply('ga' + i, 'ga' + j, k++); reply('gb' + i, 'gb' + j, k++); }
    reply('ga0', 'gb0', k++); reply('gb0', 'ga0', k++);
    const { g } = run(obs);
    const part = Object.fromEntries(g.nodes.map(n => [n.uid, n.community]));
    const ga = new Set([0, 1, 2, 3, 4].map(i => part['u:ga' + i])), gb = new Set([0, 1, 2, 3, 4].map(i => part['u:gb' + i]));
    assert.equal(ga.size, 1, 'ga unido'); assert.equal(gb.size, 1, 'gb unido');
    assert.notEqual([...ga][0], [...gb][0], 'ga y gb separados');
    assert.ok(g.modularity > 0.3, 'modularidad ' + g.modularity);
    assert.ok(g.communities.every(c => c.stability >= 0.8));
});

test('hallazgo "apoyo": varias externas concentran sus interacciones en una misma cuenta de la lista', () => {
    const obs = [];
    obs.push(ob('lista1', T0, sentence(12), { rel: ['a'] }));
    for (let i = 0; i < 5; i++) for (let j = 0; j < 7; j++) obs.push(ob('ext' + i, T0 + (i * 40 + j * 5) * MIN, sentence(10), { kind: 'reply', targetAuthorUid: 'u:lista1', targetId: String(900 + j), rel: ['p'] }));
    // una externa que reparte sus respuestas entre muchas cuentas no es parte del patrón
    for (let j = 0; j < 12; j++) obs.push(ob('dispersa', T0 + j * 4 * MIN, sentence(10), { kind: 'reply', targetAuthorUid: 'u:lista' + (10 + j), targetId: String(950 + j), rel: ['p'] }));
    const { g } = run(obs);
    const f = g.findings.find(x => x.kind === 'apoyo');
    assert.ok(f, 'hay hallazgo de apoyo');
    assert.equal(f.target, 'u:lista1');
    assert.deepEqual(f.accounts.slice().sort(), ['u:ext0', 'u:ext1', 'u:ext2', 'u:ext3', 'u:ext4']);
    assert.ok(!f.accounts.includes('u:dispersa'));
    assert.ok(g.nodes.find(n => n.uid === 'u:lista1').role === 'lista');
    assert.ok(g.nodes.find(n => n.uid === 'u:ext0').role === 'externa');
});

test('roles: quien publica primero con constancia se identifica como inicia, con intervalo de confianza', () => {
    const obs = [];
    for (let k = 0; k < 10; k++) {
        const text = sentence(18), base = T0 + k * 2 * HOUR;
        obs.push(ob('lider', base, text));
        for (let i = 0; i < 4; i++) obs.push(ob('seg' + i, base + (20 + i * 9) * S, text));
    }
    const { r, g } = run(obs);
    const lider = g.nodes.find(n => n.uid === 'u:lider');
    assert.ok(lider.tags.includes('inicia'), JSON.stringify(lider));
    assert.equal(lider.initiator.first, 10); assert.ok(lider.initiator.lo > 0.6);
    const seg = g.nodes.find(n => n.uid === 'u:seg0');
    assert.ok(!seg.tags.includes('inicia'));
});

test('narrativas: eventos que comparten publicaciones se unen y muestran origen y concentración', () => {
    const obs = [];
    const text = sentence(18);
    // 4 cuentas muy activas publican el texto y además el mismo conjunto de hashtags; llegan 8 más después
    for (let i = 0; i < 12; i++) obs.push(ob('n' + i, T0 + i * (i < 4 ? 10 : 90) * S + (i < 4 ? 0 : 20 * MIN), text, { tags: ['uno', 'dos', 'tres'] }));
    for (let i = 0; i < 4; i++) for (let j = 0; j < 6; j++) obs.push(ob('n' + i, T0 + 30 * MIN + j * 6 * MIN, sentence(12), { tags: ['uno', 'dos', 'tres'] }));
    const { g } = run(obs);
    assert.ok(g.narratives.length >= 1);
    const n = g.narratives[0];
    assert.ok(n.events.length >= 2, 'texto y hashtags unidos: ' + n.events.length);
    assert.equal(n.accounts, 12);
    assert.ok(n.origin[0].uid.startsWith('u:n') && n.origin[0].t === T0);
    assert.ok(n.concentration.top5Share > 0.5);
    assert.equal(n.timeline.cumulative[n.timeline.cumulative.length - 1], 12);
});

test('simetría y determinismo: mismo resultado con el orden invertido y entre ejecuciones', () => {
    const obs = [];
    coordinated('bod', 5, 6, obs);
    organic(30, 10, 6, obs);
    const a = run(obs).g, b = run(obs).g, c = run([...obs].reverse()).g;
    assert.deepEqual(a.edges.filter(e => e.type === 'coord').map(e => [e.a, e.b, e.n]), b.edges.filter(e => e.type === 'coord').map(e => [e.a, e.b, e.n]));
    const key = g => g.edges.filter(e => e.type === 'coord').map(e => e.a + '|' + e.b + '|' + e.n).sort();
    assert.deepEqual(key(a), key(c));
});

test('layout: posiciones en [0,1] y las comunidades quedan agrupadas', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'];
    const edges = [['a', 'b'], ['b', 'c'], ['a', 'c'], ['d', 'e'], ['e', 'f'], ['d', 'f']].map(([a, b]) => ({ a, b, w: 2 }));
    const part = { a: 0, b: 0, c: 0, d: 1, e: 1, f: 1 };
    const pos = G.layout(nodes, edges, part, 3);
    for (const p of Object.values(pos)) assert.ok(p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1);
    const dist = (x, y) => Math.hypot(pos[x][0] - pos[y][0], pos[x][1] - pos[y][1]);
    assert.ok(dist('a', 'b') < dist('a', 'e'));
});

test('escala: 20 000 observaciones se analizan en un tiempo razonable', () => {
    const obs = [];
    coordinated('bod', 6, 10, obs);
    for (let i = 0; i < 19000; i++) obs.push(ob('x' + Math.floor(rand() * 2500), T0 + Math.floor(rand() * 3 * DAY), sentence(15), { rel: ['a'], urls: rand() < 0.03 ? ['https://enlace.example/' + Math.floor(rand() * 40)] : [] }));
    const t0 = Date.now();
    const { g } = run(obs);
    const ms = Date.now() - t0;
    assert.ok(ms < 20000, 'tardó ' + ms + ' ms');
    assert.ok(g.nodes.length <= 250);
    assert.ok(g.findings.some(f => f.kind === 'nucleo' && f.accounts.filter(a => a.startsWith('u:bod')).length >= 5), 'el núcleo se encuentra entre el ruido');
});

test('sensibilidad a la ventana: un núcleo sólido se mantiene con la mitad y el doble de ventana', () => {
    const obs = [];
    background(obs);
    coordinated('bod', 6, 8, obs);
    const { g } = run(obs);
    const co = g.edges.filter(e => e.type === 'coord');
    assert.ok(co.length && co.every(e => e.holds >= 2 && e.of === 3) && co.filter(e => e.holds === 3).length >= 0.8 * co.length, JSON.stringify(co.map(e => e.holds)));
    const core = g.findings.find(f => f.kind === 'nucleo');
    assert.equal(core.stability, 'alta');
    assert.ok(core.criteria.some(c => /mitad y el doble/.test(c.label) && /^1[2-5] de 15$/.test(c.value)));
});

test('sensibilidad a la ventana: una sincronía que solo existe con la ventana grande se marca como menos estable', () => {
    const obs = [];
    background(obs, 400, T0, 28 * HOUR);
    // 4 cuentas comparten 8 enlaces distintos con 8 min entre una y la siguiente: dentro de 10 min, fuera de 5 min
    for (let k = 0; k < 8; k++) { const base = T0 + k * 3 * HOUR + Math.floor(rand() * 2 * HOUR); for (let i = 0; i < 4; i++) obs.push(ob('lento' + i, base + i * 8 * MIN, sentence(14), { urls: ['https://fuente.example/' + k] })); }
    const { g } = run(obs);
    const core = g.findings.find(f => f.kind === 'nucleo');
    assert.ok(core, 'núcleo encontrado con la ventana normal');
    assert.notEqual(core.stability, 'alta');
    assert.ok(g.edges.filter(e => e.type === 'coord').every(e => e.holds < 3 && e.level !== 'E3'));
});

test('lista de verificación: una cuenta que cumple C1, C3 y C4 con una pareja E3 se propone para revisión; las orgánicas no', () => {
    const obs = [];
    coordinated('bod', 6, 8, obs, T0, 4 * DAY);
    obs.push(ob('lista1', T0, sentence(12), { rel: ['a'] }));
    for (let i = 0; i < 6; i++) for (let j = 0; j < 9; j++) obs.push(ob('bod' + i, T0 + (3 * HOUR + j * 5 * HOUR + i * MIN), sentence(10), { kind: 'reply', targetAuthorUid: 'u:lista1', targetId: String(900 + j), rel: ['p'] }));
    organic(40, 12, 8, obs);
    const { g } = run(obs);
    const bod = g.nodes.find(n => n.uid === 'u:bod0');
    const st = id => bod.checklist.find(c => c.id === id).status;
    assert.equal(st('C1'), 'cumple'); assert.equal(st('C3'), 'cumple'); assert.equal(st('C4'), 'cumple');
    assert.ok(['C5', 'C6'].every(id => bod.checklist.find(c => c.id === id).status !== 'cumple'), 'C5 y C6 nunca cumplen: solo contexto');
    assert.ok(bod.checklist.filter(c => c.status === 'cumple').every(c => c.detail && c.detail.length > 10));
    assert.ok(g.edges.some(e => e.type === 'coord' && e.level === 'E3'), 'hay pares E3');
    assert.equal(bod.review, true);
    const org = g.nodes.filter(n => n.uid.startsWith('u:org'));
    assert.ok(org.every(n => !n.review && n.checklist.find(c => c.id === 'C1').status !== 'cumple'));
});

test('lista de verificación: con pocos datos dice "sin datos" en vez de "no cumple"', () => {
    const obs = [ob('poca', T0, sentence(12), { kind: 'reply', targetAuthorUid: 'u:lista9', rel: ['p'] }), ob('lista9', T0, sentence(12))];
    const ck = G.checklists(obs, [], G.buildInteractions(obs), [], {}).get('u:poca');
    assert.ok(ck.items.filter(i => ['C1', 'C2', 'C4'].includes(i.id)).every(i => i.status === 'sin datos'));
    assert.equal(ck.review, false);
});

test('robustez de la narrativa: informa cuántas cuentas quedan sin las 3 más activas', () => {
    const obs = [];
    const text = sentence(18);
    for (let i = 0; i < 10; i++) obs.push(ob('n' + i, T0 + i * 20 * S, text, { tags: ['uno', 'dos', 'tres'] }));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 8; j++) obs.push(ob('n' + i, T0 + 10 * MIN + j * 3 * MIN, sentence(12), { tags: ['uno', 'dos', 'tres'] }));
    const { g } = run(obs);
    const n = g.narratives[0];
    assert.equal(n.robust.without3.accounts, 7);
    assert.ok(n.robust.without3.observations < n.observations);
});

test('términos distintivos: cada comunidad se queda con lo que la distingue, con el recuento crudo', () => {
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push(ob('a' + (i % 5), T0 + i * MIN, 'palabra común sobre el tema', { tags: ['alfa'], urls: i % 2 ? ['https://sitioa.example/x'] : [] }));
    for (let i = 0; i < 40; i++) rows.push(ob('b' + (i % 5), T0 + i * MIN, 'palabra común sobre el tema', { tags: ['beta'] }));
    const part = {}; for (let i = 0; i < 5; i++) { part['u:a' + i] = 0; part['u:b' + i] = 1; }
    const t = G.distinctive(rows, part);
    assert.ok(t[0].some(x => x.term === '#alfa' && x.count === 40 && x.kind === 'hashtag'), JSON.stringify(t[0]));
    assert.ok(t[0].some(x => x.term === 'sitioa.example' && x.kind === 'sitio'));
    assert.ok(t[1].some(x => x.term === '#beta'));
    assert.ok(!t[0].some(x => x.term === 'palabra'), 'lo que comparten no distingue');
});

test('comparación entre listas: mismo criterio para todas, sin tocar la ideología', () => {
    const nodes = [
        { uid: 'u:1', role: 'lista', observations: 10, coordLinks: 2, inWeight: 5 }, { uid: 'u:2', role: 'lista', observations: 30, coordLinks: 0, inWeight: 1 },
        { uid: 'u:3', role: 'lista', observations: 20, coordLinks: 3, inWeight: 0 }, { uid: 'u:4', role: 'externa', observations: 99, coordLinks: 9, inWeight: 0 }
    ];
    const r = G.listComparison(nodes, { 'u:1': ['x'], 'u:2': ['x'], 'u:3': ['y'], 'u:4': ['x'] });
    const x = r.find(l => l.list === 'x'), y = r.find(l => l.list === 'y');
    assert.deepEqual([x.accounts, x.inSync, x.syncShare], [2, 1, 0.5]);
    assert.deepEqual([y.accounts, y.inSync, y.syncShare], [1, 1, 1]);
});

// ---------- periodos de actividad y calibración ----------
test('periodos de actividad: los huecos largos se descartan y el eje compacto se puede recorrer en ambos sentidos', () => {
    const ts = [T0, T0 + 30 * MIN, T0 + 90 * MIN, T0 + 3 * DAY, T0 + 3 * DAY + HOUR];
    const ax = G.activitySegments(ts, 2 * HOUR);
    assert.equal(ax.segs.length, 2);
    assert.equal(ax.segs[0].len, 90 * MIN + 1);
    assert.equal(ax.total, ax.segs[0].len + ax.segs[1].len);
    for (const t of ts) assert.equal(G.fromAxis(ax, G.toAxis(ax, t)), t);
    // sin límite de hueco hay un único periodo (comportamiento clásico)
    assert.equal(G.activitySegments(ts).segs.length, 1);
    assert.deepEqual(G.activitySegments([]), { segs: [], total: 0 });
});

/** Eventos sintéticos de dos sesiones de captura de 3 h separadas por 3 días; las cuentas coinciden en el evento pero no entre sí de forma especial. */
function sessionEvents(nEvents = 700) {
    const sessions = [[T0, T0 + 3 * HOUR], [T0 + 3 * DAY, T0 + 3 * DAY + 3 * HOUR]], accs = Array.from({ length: 10 }, (_, i) => 'u:s' + i), evs = [];
    for (let k = 0; k < nEvents; k++) {
        const [a, b] = sessions[k % 2], start = a + Math.floor(rand() * (b - a - 40 * MIN)), pick = new Set();
        while (pick.size < 4) pick.add(accs[Math.floor(rand() * accs.length)]);
        const parts = [...pick].map((uid, i) => ({ uid, t: start + Math.floor(rand() * 40 * MIN), obsId: 'o' + k + '-' + i, tweetId: 't' + k + '-' + i })).sort((x, y) => x.t - y.t);
        evs.push({ id: 'ev' + k, type: 'texto', subtype: 'cercano', n: parts.length, first: parts[0].t, participants: parts, level: 'E1', alt: [] });
    }
    return evs;
}

test('modelo nulo por periodos: datos barajados dentro de las sesiones no producen falsos positivos; con un solo reloj corrido sí', () => {
    const base = sessionEvents();
    const axis = G.activitySegments(base.flatMap(e => e.participants.map(p => p.t)), 2 * HOUR);
    assert.equal(axis.segs.length, 2, 'dos sesiones');
    // una realización del modelo nulo: nada coordinado por construcción
    let k = 7; const rnd = () => { k = (k * 1103515245 + 12345) % 2147483648; return k / 2147483648; };
    const nulo = G.shuffledEvents(base, axis, rnd);
    const bien = G.coparticipation(nulo, { permutations: 300, axis });
    const ingenuo = G.coparticipation(nulo, { permutations: 300 });
    const sigBien = bien.pairs.filter(p => p.q < 0.05).length, sigIngenuo = ingenuo.pairs.filter(p => p.q < 0.05).length;
    assert.ok(bien.pairs.length >= 5, 'hay pares candidatos: ' + bien.pairs.length);
    assert.ok(sigBien <= 1, 'con periodos: ' + sigBien + ' significativos de ' + bien.pairs.length);
    assert.ok(sigIngenuo >= 5, 'sin periodos el reloj entero hace parecer significativa la sincronía de las sesiones: ' + sigIngenuo);
});

test('observado frente a esperado: una pareja coordinada supera con claridad lo esperable por azar', () => {
    const obs = [];
    background(obs);
    coordinated('bod', 6, 8, obs);
    const { g } = run(obs);
    const co = g.edges.filter(e => e.type === 'coord');
    assert.ok(co.length && co.every(e => Number.isFinite(e.expected) && e.n > e.expected * 3), JSON.stringify(co.map(e => [e.n, e.expected])));
    const core = g.findings.find(f => f.kind === 'nucleo');
    const c = core.criteria.find(x => /observadas \/ esperadas/.test(x.label));
    const [o, e] = c.value.split(' / ').map(v => parseFloat(v.replace(',', '.')));
    assert.ok(o > 3 * e, c.value);
    assert.match(core.summary, /esperables por azar/);
});

test('calibración: con datos barajados el mismo detector no encuentra nada y se informa junto al resultado real', () => {
    const obs = [];
    background(obs);
    coordinated('bod', 6, 8, obs);
    const { g } = run(obs);
    const cal = g.calibration;
    assert.ok(cal.tested > 0 && cal.significant > 0);
    assert.equal(cal.pHistogram.length, 10);
    assert.equal(cal.pHistogram.reduce((a, b) => a + b, 0), cal.tested);
    assert.equal(cal.placebo.runs, 3);
    assert.ok(cal.placebo.significant <= 1, 'falsos descubrimientos con datos barajados: ' + cal.placebo.significant);
    assert.ok(cal.significant > cal.placebo.significant);
    assert.equal(g.params.axis, undefined, 'el eje de tiempo no se expone en los parámetros');
});

test('suficiencia de datos: un día de registro es escaso y varios días con horas suficientes es suficiente', () => {
    const uno = [];
    background(uno, 300, T0, 3 * HOUR);
    coordinated('bod', 6, 4, uno, T0, 3 * HOUR);
    assert.equal(run(uno).g.sample.activity.level, 'escasa');
    const varios = [];
    for (let d = 0; d < 8; d++) background(varios, 120, T0 + d * DAY, 4 * HOUR);
    coordinated('bod', 6, 4, varios, T0, 4 * HOUR);
    const a = run(varios).g.sample.activity;
    assert.equal(a.level, 'suficiente');
    assert.ok(a.days >= 7 && a.periods >= 8 && a.coveredHours >= 24, JSON.stringify(a));
});

// ---------- temas y actividad simultánea de comunidades ----------
/** Registro mínimo para probar la actividad por comunidad sin pasar por el radar. */
function mk(uid, t, text = 'algo de fondo', extra = {}) {
    const id = String(++seq);
    return { obsId: id + ':post', tweetId: id, kind: 'post', authorUid: uid, t, textNorm: text, tags: [], urls: [], ...extra };
}
const SAY = { 0: 'reforma pensional fracaso gobierno', 1: 'ataque fiscalia magistrada corrupcion', 2: 'marcha sindicatos paro nacional' };
/** Tres comunidades de 8 cuentas que publican al azar en 6 sesiones de 5 h (separadas por un día), con picos plantados a propósito. */
function communityScenario({ both = 0, onlyC = 0, everyone = 0 } = {}) {
    const rows = [], part = {}, names = ['a', 'b', 'c'], start = d => T0 + d * DAY;
    for (const c of [0, 1, 2]) for (let i = 0; i < 8; i++) part['u:' + names[c] + i] = c;
    for (const u of Object.keys(part)) for (let k = 0; k < 12; k++) rows.push(mk(u, start(Math.floor(rand() * 6)) + Math.floor(rand() * 5 * HOUR)));
    const slot = k => start(k % 6) + (30 + 25 * Math.floor(k / 6)) * MIN;
    const burst = (comms, k) => { for (const c of comms) for (let i = 0; i < 5; i++) rows.push(mk('u:' + names[c] + i, slot(k) + Math.floor(rand() * 8 * MIN), SAY[c])); };
    let k = 0;
    for (let i = 0; i < both; i++) burst([0, 1], k++);
    for (let i = 0; i < onlyC; i++) burst([2], k++);
    for (let i = 0; i < everyone; i++) burst([0, 1, 2], k++);
    return { rows, part, axis: G.activitySegments(rows.map(o => o.t), 2 * HOUR) };
}

test('actividad simultánea: dos comunidades con picos que coinciden más que el azar se detectan aunque hablen de cosas distintas; la tercera no', () => {
    const { rows, part, axis } = communityScenario({ both: 8, onlyC: 8 });
    const res = G.crossCommunity(rows, part, axis);
    const info = JSON.stringify(res.pairs.map(p => [p.a, p.b, p.level, p.coincident, p.expected, +p.q.toFixed(3)]));
    const ab = res.pairs.find(p => p.a === 0 && p.b === 1);
    assert.ok(ab && ab.level === 'E2' && ab.coincident >= 6 && ab.coincident > ab.expected * 3, info);
    assert.ok(ab.sharedVocabulary !== null && ab.sharedVocabulary <= 0.25, 'vocabulario: ' + ab.sharedVocabulary);
    assert.ok(ab.bins[0].a.terms.includes('reforma') && ab.bins[0].b.terms.includes('fiscalia'), JSON.stringify(ab.bins[0]));
    assert.ok(ab.bins[0].a.evidence.length && ab.accounts.length >= 10);
    assert.ok(!res.pairs.some(p => p.level === 'E2' && (p.a === 2 || p.b === 2)), info);
});

test('actividad simultánea: si todas las comunidades se activan a la vez es un acontecimiento general y no se señala a ninguna pareja', () => {
    const { rows, part, axis } = communityScenario({ everyone: 8 });
    const res = G.crossCommunity(rows, part, axis);
    assert.equal(res.pairs.filter(p => p.level === 'E2').length, 0, JSON.stringify(res.pairs.map(p => [p.a, p.b, p.coincident])));
});

test('actividad simultánea: sin picos compartidos, o con muy poca actividad observada, no inventa nada', () => {
    const { rows, part, axis } = communityScenario({ onlyC: 8 });
    assert.equal(G.crossCommunity(rows, part, axis).pairs.filter(p => p.level === 'E2').length, 0);
    const few = G.crossCommunity(rows.slice(0, 20), part, G.activitySegments(rows.slice(0, 20).map(o => o.t), 2 * HOUR));
    assert.deepEqual(few.pairs, []);
});

test('temas: palabras enteras, prefijos con *, frases y hashtags; reparto por comunidad y quién entra primero', () => {
    const part = { 'u:a0': 0, 'u:a1': 0, 'u:b0': 1 };
    const rows = [mk('u:a0', T0, 'la reforma pensional fracasa'), mk('u:a1', T0 + 5 * MIN, 'otra vez las pensiones'), mk('u:b0', T0 + HOUR, 'salud mental y reforma'),
        mk('u:b0', T0 + 2 * HOUR, 'nada que ver aqui'), mk('u:a0', T0 + 3 * HOUR, 'hoy', { tags: ['Reforma'] }), mk('u:zz', T0 + 4 * HOUR, 'reformatorio de menores')];
    const [t] = G.topicStats(rows, part, [{ id: 't1', name: 'Pensiones', words: ['Reforma', 'pensión*', 'salud mental'] }]);
    assert.equal(t.observations, 4, 'la palabra entera no coincide con «reformatorio»');
    assert.equal(t.accounts, 3);
    assert.equal(t.origin[0].uid, 'u:a0');
    const c0 = t.byCommunity.find(c => c.id === 0), c1 = t.byCommunity.find(c => c.id === 1);
    assert.deepEqual([c0.accounts, c0.observations, c1.accounts, c1.observations], [2, 3, 1, 1]);
    assert.equal(Math.round(c0.share * 100), 75);
    assert.equal(t.timeline.counts.reduce((a, b) => a + b, 0), 4);
    assert.equal(G.topicStats(rows, part, [{ id: 'x', name: 'Nada', words: ['inexistente'] }])[0].observations, 0);
    assert.ok(G.compileTopic({ words: ['Reforma Tributaria'] })({ textNorm: 'la reforma tributaria llego' }));
    assert.ok(!G.compileTopic({ words: ['Reforma Tributaria'] })({ textNorm: 'la tributaria de la reforma' }));
});

test('términos compartidos: lo que usan varias comunidades a la vez, sin lo que es corriente en todo el registro', () => {
    const part = {}, rows = [];
    for (let i = 0; i < 5; i++) { part['u:a' + i] = 0; part['u:b' + i] = 1; }
    for (let i = 0; i < 5; i++) { rows.push(mk('u:a' + i, T0 + i * MIN, 'plebiscito nacional convocatoria')); rows.push(mk('u:b' + i, T0 + i * MIN, 'plebiscito urgente votacion')); rows.push(mk('u:a' + i, T0 + HOUR + i * MIN, 'solo estos hablan de aranceles')); }
    for (let i = 0; i < 120; i++) rows.push(mk('u:z' + (i % 7), T0 + i * MIN, sentence(8)));
    const terms = G.sharedTerms(rows, part);
    const pleb = terms.find(t => t.term === 'plebiscito');
    assert.ok(pleb && pleb.communities.length === 2 && pleb.communities.every(c => c.accounts === 5), JSON.stringify(terms));
    assert.ok(!terms.some(t => t.term === 'aranceles'), 'lo que usa una sola comunidad no es compartido');
});

test('el análisis completo trae temas definidos, términos compartidos y la actividad por comunidad', () => {
    const obs = [];
    background(obs);
    coordinated('bod', 6, 8, obs);
    const r = R.analyze(obs);
    const g = G.analyzeGraph(obs, r.events, { topics: [{ id: 't', name: 'Todo', words: ['casa', 'perro', 'tiempo'] }] });
    assert.equal(g.topics.length, 1);
    assert.ok(g.topics[0].observations > 0 && g.topics[0].byCommunity.length >= 1);
    assert.ok(Array.isArray(g.sharedTerms) && typeof g.crossCommunity.bins === 'number' && Array.isArray(g.crossCommunity.pairs));
    assert.deepEqual(G.analyzeGraph(obs, r.events).topics, []);
});

test('actividad simultánea, control nulo: con seis comunidades que publican al azar no salen falsos descubrimientos más allá de lo nominal', () => {
    let runsWithE2 = 0, tested = 0;
    for (let r = 0; r < 30; r++) {
        const part = {}, rows = [];
        for (let c = 0; c < 6; c++) for (let i = 0; i < 8; i++) part['u:c' + c + '_' + i] = c;
        for (const u of Object.keys(part)) for (let k = 0, n = 8 + Math.floor(rand() * 20); k < n; k++) rows.push(mk(u, T0 + Math.floor(rand() * 6) * DAY + Math.floor(rand() * 5 * HOUR), 'texto ' + Math.floor(rand() * 50)));
        const res = G.crossCommunity(rows, part, G.activitySegments(rows.map(o => o.t), 2 * HOUR));
        tested += res.tested;
        if (res.pairs.some(p => p.level === 'E2')) runsWithE2++;
    }
    assert.ok(tested > 300, 'pares comprobados: ' + tested);
    assert.ok(runsWithE2 <= 3, 'ejecuciones con algún falso positivo: ' + runsWithE2 + ' de 30');
});

test('candidatas externas: quien solo amplifica a las listas es «afín»; quien además sincroniza con otras cuentas es «sincronizada»', () => {
    const obs = [];
    background(obs);
    for (let i = 0; i < 4; i++) obs.push(ob('lista' + i, T0 + i * HOUR, sentence(14), { rel: ['a'] }));
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) obs.push(ob('afin' + i, T0 + Math.floor(rand() * DAY), sentence(12), { kind: 'reply', targetAuthorUid: 'u:lista0', targetId: '9' + j, rel: ['p'] }));
    const first = obs.length;
    coordinated('sinc', 5, 8, obs);
    for (let i = first; i < obs.length; i++) obs[i].rel = ['m'];
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) obs.push(ob('sinc' + i, T0 + Math.floor(rand() * DAY), sentence(12), { kind: 'reply', targetAuthorUid: 'u:lista0', targetId: '8' + j, rel: ['p'] }));
    const { g } = run(obs);
    const by = Object.fromEntries(g.nodes.map(n => [n.uid, n]));
    assert.equal(by['u:afin0'].candidate.kind, 'afín');
    assert.equal(by['u:afin0'].candidate.interactions, 5);
    assert.equal(by['u:sinc0'].candidate.kind, 'sincronizada', JSON.stringify(by['u:sinc0']));
    assert.ok(by['u:sinc0'].candidate.coordLinks >= 1);
    assert.equal(by['u:lista0'].candidate, null, 'las cuentas de las listas no son candidatas');
});

test('palabras vacías: no cuentan como términos (artículos, preposiciones, verbos y saludos comunes, risas, números)', () => {
    const t = [...G.tokensOf({ textNorm: 'hola gracias porque tiene hacer sobre ahora jajaja siiiiii 12345 este nuevo reforma pensional paro nacional', tags: ['Reforma'], urls: ['https://www.ejemplo.com/a'] })];
    assert.deepEqual(t.sort(), ['#Reforma', 'ejemplo.com', 'nacional', 'paro', 'pensional', 'reforma'].sort());
});

test('narrativas: las palabras clave son las que distinguen el contenido, no las vacías ni las corrientes en todo el registro', () => {
    const obs = [];
    background(obs, 300);
    const txt = 'el gobierno oculta la verdad sobre el plebiscito y la reforma pensional hoy mismo';
    for (let i = 0; i < 6; i++) obs.push(ob('bod' + i, T0 + i * 7 * S, txt));
    const r = R.analyze(obs), g = G.analyzeGraph(obs, r.events);
    const n = g.narratives.find(x => x.keywords && x.keywords.includes('plebiscito'));
    assert.ok(n, JSON.stringify(g.narratives.map(x => x.keywords)));
    assert.ok(['plebiscito', 'pensional', 'reforma'].every(w => n.keywords.includes(w)), n.keywords.join());
    assert.ok(!n.keywords.some(w => ['sobre', 'mismo'].includes(w)), n.keywords.join());
});

test('términos distintivos: lo corriente en todo el registro (el tema de fondo) no distingue a ninguna comunidad', () => {
    const rows = [], part = {};
    for (let i = 0; i < 5; i++) { part['u:a' + i] = 0; part['u:b' + i] = 1; }
    for (let i = 0; i < 60; i++) {
        rows.push(ob('a' + (i % 5), T0 + i * MIN, 'petro igual general bueno ' + (i % 3 ? 'gobierno' : 'plebiscito urgente'), {}));
        rows.push(ob('b' + (i % 5), T0 + i * MIN, 'petro igual general bueno ' + (i % 3 ? 'gobierno' : 'fiscalia magistrada'), {}));
    }
    const t = G.distinctive(rows, part), words = c => (t[c] || []).map(x => x.term);
    assert.ok(words(0).includes('plebiscito') && words(1).includes('fiscalia'), JSON.stringify(t));
    for (const c of [0, 1]) for (const w of ['petro', 'igual', 'general', 'bueno', 'gobierno']) assert.ok(!words(c).includes(w), w + ' no distingue');
});
