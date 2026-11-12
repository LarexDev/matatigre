// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XAF = Object.assign(require('../extension/src/matcher.js'), {});
globalThis.XAF = XAF;
const O = require('../extension/src/observe.js');

const NOW = 1793600000000;
const raw = (extra = {}) => ({ k: 'post', id: '2116000000000000001', t: NOW - 60000, a: { id: '1994191217530425345', h: 'Cana_Triste', n: 'Caña', f: 1133 }, tx: 'Hola @Mundo, mira https://t.co/abc  ESTO', lg: 'es', ...extra });

test('normalizeForMatch: sin tildes ni enlaces, menciones como "@" y espacios colapsados', () => {
    assert.equal(O.normalizeForMatch('Ñandú   LLEGÓ a https://x.com/a/b?c=1 con @Alguien_1 y #Tag'), 'nandu llego a con @ y #tag');
    assert.equal(O.normalizeForMatch(null), '');
});

test('canonicalUrl: quita seguimiento, www, fragmento y barra final; descarta acortadores y esquemas raros', () => {
    assert.equal(O.canonicalUrl('https://www.Ejemplo.com/Nota/?utm_source=x&b=2&a=1&fbclid=zz#frag'), 'ejemplo.com/Nota?a=1&b=2');
    assert.equal(O.canonicalUrl('http://ejemplo.com/'), 'ejemplo.com');
    for (const bad of ['https://t.co/AbC123', 'javascript:alert(1)', 'ftp://x.y/z', 'no es url', '']) assert.equal(O.canonicalUrl(bad), null, bad);
});

test('toRecord: registro válido → campos normalizados; el texto largo se recorta y la huella se calcula aparte', () => {
    const r = O.toRecord(raw({ tx: 'a'.repeat(900), u: ['https://www.e.com/x?utm_medium=a', 'https://t.co/zzz'], tg: ['Tag', 'tag', 'OTRO'], m: [{ h: 'Mundo', id: '5' }, { h: 'sin_id' }, { h: 'no válido!' }], c: { f: 10, rt: 3.6, q: -1, v: 'x' }, md: [{ id: 'm1', t: 'photo' }, {}] }), NOW);
    assert.equal(r.kind, 'post'); assert.equal(r.tweetId, '2116000000000000001'); assert.equal(r.seenAt, NOW);
    assert.equal(r.author.id, '1994191217530425345'); assert.equal(r.author.h, 'Cana_Triste');
    assert.equal(r.textNorm.length, 300); assert.ok(r.textFull.length > 300 && r.textFull.length <= 600);
    assert.deepEqual(r.urls, ['e.com/x']);
    assert.deepEqual(r.tags, ['tag', 'otro']);
    assert.deepEqual(r.mentions, ['u:5', 'h:sin_id']);
    assert.deepEqual(r.counts, { f: 10, rt: 4 });
    assert.deepEqual(r.media, [{ id: 'm1', t: 'photo' }]);
    assert.equal(r.t, NOW - 60000); assert.equal(r.lang, 'es');
});

test('toRecord: un repost no guarda texto; cita y respuesta guardan el objetivo', () => {
    const rp = O.toRecord(raw({ k: 'repost', tid: '2000000000000000002', tau: { id: '77', h: 'Original' } }), NOW);
    assert.equal(rp.textNorm, undefined); assert.equal(rp.targetId, '2000000000000000002'); assert.equal(rp.tau.h, 'Original');
    const rep = O.toRecord(raw({ k: 'reply', tid: '2000000000000000003', rh: 'Otro' }), NOW);
    assert.equal(rep.replyTo, 'otro'); assert.equal(rep.kind, 'reply');
});

test('toRecord rechaza lo inválido y descarta horas imposibles', () => {
    for (const bad of [null, 5, {}, raw({ k: 'otro' }), raw({ id: 'abc' }), raw({ id: '0' }), raw({ a: null }), raw({ a: { n: 'sin id ni handle' } }), raw({ a: { h: 'demasiado_largo_para_x' } })]) assert.equal(O.toRecord(bad, NOW), null, JSON.stringify(bad).slice(0, 60));
    assert.equal(O.toRecord(raw({ t: 5 }), NOW).t, undefined, 'antes del año 2000');
    assert.equal(O.toRecord(raw({ t: NOW + 10 * 86400000 }), NOW).t, undefined, 'en el futuro');
    assert.equal(O.toRecord(raw({ lg: '<script>' }), NOW).lang, undefined);
    assert.ok(O.toRecord(raw({ a: { h: 'Solo_Handle' } }), NOW), 'con solo handle es válido (perfil provisional)');
});

test('sha256Hex: huella estable de 64 caracteres hexadecimales', async () => {
    assert.equal(await O.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
