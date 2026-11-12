// node --test tests/   ·   Datos sintéticos de VERDAD CONOCIDA: se sabe qué está coordinado y qué no.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.XAF = require('../extension/src/matcher.js');
const O = require('../extension/src/observe.js');
const R = require('../extension/src/radar.js');

const T0 = 1793500000000;
const S = 1000, MIN = 60 * S;
let seq = 1000;

/** Observación sintética (el texto se normaliza como en la ingesta real). */
function ob(author, t, text, extra = {}) {
    const norm = O.normalizeForMatch(text);
    const { tl, tw } = R.textStats(norm);
    const id = String(++seq);
    return {
        obsId: id + ':' + (extra.kind || 'post'), tweetId: id, kind: 'post', authorUid: 'u:' + author, t,
        th: norm ? createHash('sha256').update(norm).digest('hex').slice(0, 32) : null, sh: norm ? R.simhash(norm) : null, tl, tw, textNorm: norm.slice(0, 300),
        urls: [], tags: [], mentions: [], media: [], ctx: { op: 'HomeTimeline', scope: 'home' }, counts: null, ...extra
    };
}

const WORDS = 'casa perro tiempo ciudad gobierno semana mañana verdad pueblo camino noche historia pueblo mundo trabajo familia dinero calle música cielo montaña río amigo libro viaje fuerza palabra razón futuro'.split(' ');
let rnd = 12345;
const rand = () => { rnd = (rnd * 1664525 + 1013904223) % 4294967296; return rnd / 4294967296; };
const sentence = (n = 14) => Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ');

const TEXT = 'Atención a todos los colombianos: el gobierno oculta información clave sobre este tema y nadie quiere hablar del asunto en los medios tradicionales hoy';

test('simhash: igual para textos iguales, cercano para casi iguales y lejano para distintos', () => {
    const a = R.simhash(O.normalizeForMatch(TEXT));
    assert.equal(a.length, 16);
    assert.equal(R.simhash(O.normalizeForMatch(TEXT)), a);
    assert.equal(R.hamming(a, a), 0);
    const near = R.simhash(O.normalizeForMatch(TEXT.replace('hoy', 'ahora')));
    assert.ok(R.hamming(a, near) <= 6, 'un cambio al final: ' + R.hamming(a, near));
    const far = R.simhash(O.normalizeForMatch(sentence(25)));
    assert.ok(R.hamming(a, far) > 12, 'textos distintos: ' + R.hamming(a, far));
});

test('maxWithin: máximo de cuentas dentro de una ventana', () => {
    assert.equal(R.maxWithin([0, 10, 20, 500], 30), 3);
    assert.equal(R.maxWithin([0, 100, 200], 50), 1);
    assert.equal(R.maxWithin([], 50), 0);
});

test('verdad conocida: un grupo que publica el mismo texto en segundos se detecta (I1, E1) y el ruido orgánico no', () => {
    const obs = [];
    for (let i = 0; i < 6; i++) obs.push(ob('bod' + i, T0 + i * 8 * S, TEXT));
    for (let i = 0; i < 80; i++) obs.push(ob('org' + i, T0 + Math.floor(rand() * 3 * 60) * MIN, sentence(14 + (i % 6))));
    const r = R.analyze(obs);
    const coord = r.events.filter(e => e.level === 'E1');
    assert.equal(coord.length, 1, 'solo un evento E1: ' + JSON.stringify(r.events.map(e => [e.type, e.n, e.level])));
    const e = coord[0];
    assert.equal(e.type, 'texto'); assert.equal(e.subtype, 'exacto'); assert.equal(e.n, 6);
    assert.ok(e.indicators.includes('I1') && e.indicators.includes('I2'));
    assert.equal(e.verdict, 'patrón compatible con comportamiento coordinado');
    assert.equal(e.stability.label, 'alta');
    assert.deepEqual(e.participants.map(p => p.uid), ['bod0', 'bod1', 'bod2', 'bod3', 'bod4', 'bod5'].map(x => 'u:' + x));
    assert.equal(e.spanMs, 40 * S);
    assert.equal(r.sample.accounts, 86);
});

test('casi idéntico: pequeñas variaciones se agrupan (I2) pero no cuentan como texto idéntico (sin I1)', () => {
    const variants = [TEXT, TEXT.replace('hoy', 'ahora'), TEXT.replace('hoy', 'ya'), TEXT.replace('hoy', 'aquí')];   // distancias 6, 3 y 5 respecto al original
    const obs = variants.map((v, i) => ob('v' + i, T0 + i * 90 * S, v));
    const e = R.analyze(obs).events[0];
    assert.equal(e.type, 'texto'); assert.equal(e.subtype, 'casi idéntico'); assert.equal(e.n, 4);
    assert.ok(e.indicators.includes('I2') && !e.indicators.includes('I1'));
});

test('sensibilidad a la ventana: tres cuentas con 20 minutos de diferencia no son E1 (solo observación)', () => {
    const obs = [0, 1, 2].map(i => ob('lento' + i, T0 + i * 20 * MIN, TEXT));
    const e = R.analyze(obs).events[0];
    assert.equal(e.level, 'E0'); assert.deepEqual(e.indicators, []); assert.equal(e.verdict, 'observación');
    assert.equal(e.within[60 * MIN], 3); assert.equal(e.within[10 * MIN], 1); assert.equal(e.stability, null);
});

test('prueba nula: textos todos distintos y repartidos no producen ningún evento de nivel E1', () => {
    const obs = Array.from({ length: 300 }, (_, i) => ob('n' + i, T0 + Math.floor(rand() * 600) * MIN, sentence(12 + (i % 9))));
    const r = R.analyze(obs);
    assert.equal(r.events.filter(e => e.level === 'E1').length, 0);
});

test('textos cortos y frases hechas no forman eventos (mínimo 40 caracteres y 6 palabras)', () => {
    const obs = Array.from({ length: 12 }, (_, i) => ob('c' + i, T0 + i * S, 'Muy de acuerdo con todo esto'));
    obs.push(...Array.from({ length: 8 }, (_, i) => ob('d' + i, T0 + i * S, 'Gracias a todos por todo')));
    assert.equal(R.analyze(obs).events.length, 0);
});

test('una cuenta que se repite no es un evento: cuenta una sola vez', () => {
    const obs = Array.from({ length: 5 }, (_, i) => ob('solita', T0 + i * S, TEXT));
    assert.equal(R.analyze(obs).events.length, 0);
    const mixto = [...obs, ob('otra', T0 + 10 * S, TEXT)];
    const e = R.analyze(mixto).events[0];
    assert.equal(e.n, 2); assert.equal(e.repeats, 4); assert.equal(e.level, 'E0');
});

test('misma dirección: sin texto común es observación y se anota la fuente común; con introducción idéntica cumple I3', () => {
    const URL = 'noticias.ejemplo.com/nota-1';
    const distinto = Array.from({ length: 5 }, (_, i) => ob('u' + i, T0 + i * 20 * S, sentence(12), { urls: [URL] }));
    let e = R.analyze(distinto).events.find(x => x.type === 'url');
    assert.equal(e.level, 'E0'); assert.equal(e.alternatives.fuenteComun, true);
    const igual = Array.from({ length: 4 }, (_, i) => ob('w' + i, T0 + i * 20 * S, TEXT, { urls: [URL] }));
    e = R.analyze(igual).events.find(x => x.type === 'url');
    assert.ok(e.indicators.includes('I3')); assert.equal(e.verdict, 'explicación alternativa plausible', 'un enlace compartido sigue siendo una explicación alternativa');
});

test('los enlaces a X mismo no forman eventos', () => {
    const obs = Array.from({ length: 5 }, (_, i) => ob('x' + i, T0 + i * S, sentence(12), { urls: ['x.com/algo/status/1'] }));
    assert.equal(R.analyze(obs).events.filter(e => e.type === 'url').length, 0);
});

test('mismo conjunto de hashtags (I4)', () => {
    const obs = Array.from({ length: 4 }, (_, i) => ob('h' + i, T0 + i * 30 * S, sentence(12), { tags: ['alfa', 'beta', 'gamma'] }));
    obs.push(ob('h9', T0, sentence(12), { tags: ['alfa', 'beta'] }));
    const e = R.analyze(obs).events.find(x => x.type === 'hashtag');
    assert.equal(e.n, 4); assert.deepEqual(e.indicators, ['I4']); assert.equal(e.label, '#alfa #beta #gamma');
});

test('reposts de una raíz: I5 y cobertura = reposteros observados / contador de reposts', () => {
    const root = ob('origen', T0 - 5 * MIN, sentence(15), { counts: { rt: 50 } });
    const reps = Array.from({ length: 5 }, (_, i) => ob('rp' + i, T0 + i * 20 * S, '', { kind: 'repost', targetId: root.tweetId, obsId: 'r' + i + ':repost' }));
    let e = R.analyze([root, ...reps]).events.find(x => x.type === 'raiz');
    assert.deepEqual(e.indicators, ['I5']);
    assert.equal(e.coverage.observed, 5); assert.equal(e.coverage.total, 50); assert.equal(Math.round(e.coverage.ratio * 100), 10);
    assert.equal(e.alternatives.coberturaBaja, true); assert.equal(e.verdict, 'no concluyente (cobertura baja)');
    root.counts = { rt: 6 };
    e = R.analyze([root, ...reps]).events.find(x => x.type === 'raiz');
    assert.equal(e.alternatives.coberturaBaja, false); assert.equal(e.verdict, 'patrón compatible con comportamiento coordinado');
    root.counts = { rt: 4000 };
    e = R.analyze([root, ...reps]).events.find(x => x.type === 'raiz');
    assert.equal(e.alternatives.raizViral, true);
    const sinRaiz = R.analyze(reps).events.find(x => x.type === 'raiz');
    assert.equal(sinRaiz.coverage, null, 'sin la publicación original observada no se estima cobertura');
});

test('tendencia general: si toda la muestra se dispara a la vez, la coincidencia tiene una explicación alternativa', () => {
    const obs = [];
    for (let i = 0; i < 60; i++) obs.push(ob('base' + i, T0 - 600 * MIN + i * 10 * MIN, sentence(14)));              // actividad de fondo baja y pareja
    for (let i = 0; i < 70; i++) obs.push(ob('pico' + i, T0 + (i % 10) * S, sentence(14)));                           // pico enorme en la misma franja
    for (let i = 0; i < 4; i++) obs.push(ob('copia' + i, T0 + i * 5 * S, TEXT));
    const e = R.analyze(obs).events.find(x => x.type === 'texto');
    assert.equal(e.alternatives.tendencia.flag, true);
    assert.equal(e.verdict, 'explicación alternativa plausible');
});

test('artefacto de muestra: todo capturado desde la misma búsqueda se anota', () => {
    const obs = Array.from({ length: 4 }, (_, i) => ob('s' + i, T0 + i * S, TEXT, { ctx: { op: 'SearchTimeline', scope: 'search' } }));
    const e = R.analyze(obs).events[0];
    assert.equal(e.alternatives.artefactoMuestra, true); assert.equal(e.verdict, 'explicación alternativa plausible');
});

test('filtro por periodo, y resultados idénticos con la misma entrada', () => {
    const obs = Array.from({ length: 4 }, (_, i) => ob('p' + i, T0 + i * S, TEXT));
    assert.equal(R.analyze(obs, { from: T0 + 10 * MIN }).events.length, 0);
    assert.equal(R.analyze(obs, { from: T0, to: T0 + MIN }).events.length, 1);
    assert.deepEqual(R.analyze(obs), R.analyze(obs));
});

test('sin datos o con registros inválidos no falla', () => {
    assert.equal(R.analyze([]).events.length, 0);
    assert.equal(R.analyze([null, {}, { t: 'x' }, { t: T0 }]).sample.observations, 0);
});

test('a escala: 20 000 observaciones aleatorias se analizan en pocos segundos, sin falsos E1, y se encuentra el grupo inyectado', () => {
    const obs = Array.from({ length: 20000 }, (_, i) => ob('m' + (i % 4000), T0 + Math.floor(rand() * 2880) * MIN, sentence(12 + (i % 11))));
    for (let i = 0; i < 5; i++) obs.push(ob('grupo' + i, T0 + 1000 * MIN + i * 12 * S, TEXT));
    const t0 = Date.now();
    const r = R.analyze(obs);
    const ms = Date.now() - t0;
    const e1 = r.events.filter(e => e.level === 'E1');
    assert.ok(ms < 8000, 'tardó ' + ms + ' ms');
    assert.equal(e1.length, 1, JSON.stringify(e1.map(e => [e.type, e.n, e.label.slice(0, 40)])));
    assert.equal(e1[0].n, 5);
});

// ---------- por cuenta: señales alrededor de las listas ----------
const L = n => 'u:L' + n;   // cuentas de las listas
const TEXT2 = 'Urgente: lo que están ocultando sobre la reforma que afecta a todas las familias del país y que ningún canal quiere explicar con claridad hoy';

function reply(author, t, targetN, extra = {}) {
    return ob(author, t, sentence(13), { kind: 'reply', targetAuthorUid: L(targetN), rel: ['p'], ...extra });
}

function scenario() {
    const obs = [];
    for (let n = 1; n <= 20; n++) obs.push(ob('L' + n, T0 + n * 7 * MIN, sentence(15), { authorUid: L(n), rel: ['a'] }));
    // red planteada: 6 cuentas que responden 10 veces a la misma cuenta de la lista y publican el mismo texto en dos ocasiones
    for (let p = 1; p <= 6; p++) {
        for (let i = 0; i < 10; i++) obs.push(reply('red' + p, T0 + (i * 37 + p * 3) * MIN, 1));
        // (cada oleada usa un texto distinto: el mismo texto publicado dos veces por las mismas cuentas sería un solo evento)
        [[T0 + 100 * MIN, TEXT], [T0 + 900 * MIN, TEXT2]].forEach(([base, txt]) => obs.push(ob('red' + p, base + p * 6 * S, txt, { rel: ['m'] })));
    }
    // ruido orgánico: 60 cuentas que interactúan 1-3 veces con cuentas al azar de las listas
    for (let o = 1; o <= 60; o++) for (let i = 0; i < 1 + (o % 3); i++) obs.push(reply('org' + o, T0 + Math.floor(rand() * 1200) * MIN, 1 + Math.floor(rand() * 20), i % 2 ? { kind: 'quote', rel: ['q'] } : {}));
    // una persona muy aficionada a una cuenta: 12 respuestas repartidas en días
    for (let i = 0; i < 12; i++) obs.push(reply('fan', T0 + i * 150 * MIN, 2));
    return obs;
}

test('por cuenta (verdad conocida): la red planteada acumula las señales y el ruido orgánico no aparece', () => {
    const r = R.analyze(scenario());
    const names = r.accounts.map(a => a.uid.replace('u:', ''));
    const red = r.accounts.filter(a => a.uid.startsWith('u:red'));
    assert.equal(red.length, 6, 'las 6 cuentas de la red: ' + names.join());
    for (const a of red) assert.deepEqual(a.signals.map(s => s.id).sort(), ['S1', 'S3', 'S4'], a.uid);
    assert.equal(r.accounts.filter(a => a.uid.startsWith('u:org')).length, 0, 'ninguna cuenta orgánica');
    assert.equal(r.accounts.filter(a => a.listed).length, 0, 'las cuentas de las listas no tienen señales');
});

test('por cuenta: una persona muy aficionada a una cuenta aparece, pero con menos señales que la red', () => {
    const r = R.analyze(scenario());
    const fan = r.accounts.find(a => a.uid === 'u:fan');
    assert.deepEqual(fan.signals.map(s => s.id).sort(), ['S3', 'S4']);
    const red = r.accounts.find(a => a.uid.startsWith('u:red'));
    assert.ok(red.signals.length > fan.signals.length);
    assert.ok(r.accounts.indexOf(fan) > r.accounts.indexOf(red), 'la red va antes');
    assert.equal(fan.signals.find(s => s.id === 'S4').share, 1);
    assert.equal(fan.signals.find(s => s.id === 'S3').target, L(2));
});

test('por cuenta: cuentas que más interactúan con las listas (sin etiquetas), solo las que no son de la lista', () => {
    const r = R.analyze(scenario());
    const top = r.interactors.slice(0, 7).map(a => a.uid);
    assert.ok(top.includes('u:fan') && top.filter(u => u.startsWith('u:red')).length === 6, top.join());
    assert.ok(r.interactors.every(a => !a.listed));
    assert.ok(r.interactors.every(a => a.direct >= 5));
    const red = r.interactors.find(a => a.uid === 'u:red1');
    assert.equal(red.topTarget, L(1)); assert.equal(red.topShare, 1); assert.equal(red.targets, 1);
});

test('por cuenta: los mismos umbrales para cualquier bando (simetría) y sin datos de relación no hay señales de interacción', () => {
    const a = scenario();
    const swapped = a.map(o => ({ ...o, authorUid: o.authorUid.replace('red', 'rojo'), targetAuthorUid: o.targetAuthorUid }));
    assert.equal(R.analyze(swapped).accounts.filter(x => x.uid.startsWith('u:rojo')).length, 6);
    const sinRel = a.map(({ rel, ...o }) => o);
    const r = R.analyze(sinRel);
    assert.equal(r.accounts.length, 0); assert.equal(r.interactors.length, 0);
});

test('por cuenta: una sola señal no hace "patrón"; el mínimo de 8 interacciones y de 5 respuestas se respeta', () => {
    const obs = [];
    for (let i = 0; i < 4; i++) obs.push(reply('poco', T0 + i * MIN, 3));
    for (let i = 0; i < 7; i++) obs.push(reply('casi', T0 + i * MIN, 3));
    const r = R.analyze(obs);
    assert.equal(r.accounts.find(a => a.uid === 'u:poco'), undefined);
    const casi = r.accounts.find(a => a.uid === 'u:casi');
    assert.deepEqual(casi.signals.map(s => s.id), ['S3'], 'S3 (≥ 5) sí; S4 (≥ 8) no');
});
