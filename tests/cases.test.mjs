// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.XAF = require('../extension/src/matcher.js');
Object.assign(globalThis.XAF, require('../extension/src/observe.js'), require('../extension/src/radar.js'));
const C = require('../extension/src/cases.js');

const NOW = 1793600000000;

const event = (extra = {}) => ({
    id: 'texto|exacto|abc', type: 'texto', subtype: 'exacto', label: 'texto de <b>prueba</b> & más', n: 3, first: NOW, last: NOW + 20000, spanMs: 20000, indicators: ['I1', 'I2'], level: 'E1',
    stability: { holds: 5, of: 5, label: 'alta' }, coverage: null, within: { 60000: 3 }, alt: [], alternatives: { fuenteComun: false }, verdict: 'patrón compatible con comportamiento coordinado',
    participants: [{ uid: 'u:1', t: NOW, obsId: '10:post', tweetId: '10', kind: 'post' }, { uid: 'u:2', t: NOW + 10000, obsId: '11:post', tweetId: '11', kind: 'post' }, { uid: 'u:3', t: NOW + 20000, obsId: '12:post', tweetId: '12', kind: 'post' }], ...extra
});
const obs = (n, uid) => ({ obsId: n + ':post', tweetId: String(n), authorUid: uid, kind: 'post', t: NOW + (n - 10) * 10000, th: 'h'.repeat(32), sh: '0123456789abcdef', urls: ['e.com/x'], tags: [], counts: { rt: 5 }, ctx: { scope: 'home' }, textNorm: 'texto normalizado largo de la publicación ' + n });

async function sample(opts = {}) {
    const c = C.newCase({ title: 'Caso <uno>', question: '¿Hay patrón?' }, NOW);
    c.caseId = 'caso-fijo';   // el identificador real es aleatorio; fijo para comprobar el determinismo
    c.events = [C.eventSnapshot(event(), { nearBits: 6 }, '1.0', NOW)];
    c.external = [C.sanitizeExternal({ id: 'ext1', at: NOW - 3600000, title: 'Fallo judicial <importante>', kind: 'judicial', url: 'https://ejemplo.com/n' }, NOW)];
    c.notes = 'Mi hipótesis (capa C)';
    const evidence = [10, 11, 12].map(n => C.evidenceFromObs(obs(n, 'u:' + (n - 9)), c.caseId, opts, NOW));
    return { c, evidence, pkg: await C.buildPackage({ case: c, evidence, handles: { 'u:1': 'Alfa', 'u:2': 'Beta', 'u:3': 'Gamma' }, version: 'MATATIGRE test', radarVersion: '1.0', ...opts }, NOW) };
}

test('canonicalJson: ordena las claves y es estable', () => {
    assert.equal(C.canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }], e: undefined }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test('newCase y sanitizeCasePatch: valores por defecto y solo campos editables', () => {
    const c = C.newCase({}, NOW);
    assert.equal(c.title, 'Expediente sin título'); assert.equal(c.status, 'abierto'); assert.deepEqual(c.events, []);
    assert.deepEqual(C.sanitizeCasePatch({ title: ' T ', status: 'cerrado', caseId: 'x', events: [1], notes: 'n' }), { title: 'T', status: 'cerrado', notes: 'n' });
    assert.deepEqual(C.sanitizeCasePatch({ status: 'raro' }), {});
});

test('sanitizeExternal: exige fecha y descripción; solo URLs http(s); tipo válido', () => {
    assert.equal(C.sanitizeExternal({ at: NOW }), null);
    assert.equal(C.sanitizeExternal({ title: 'x' }), null);
    const e = C.sanitizeExternal({ at: NOW, title: 'T', kind: 'raro', url: 'javascript:alert(1)' }, NOW);
    assert.equal(e.kind, 'otro'); assert.equal(e.url, '');
    assert.equal(C.sanitizeExternal({ at: NOW, title: 'T', url: 'https://a.com/x' }, NOW).url, 'https://a.com/x');
});

test('evidencia: copia mínima; el texto solo sale como extracto si se pide', () => {
    const o = obs(10, 'u:1');
    const sin = C.evidenceFromObs(o, 'caso', {}, NOW);
    assert.ok(!('excerpt' in sin) && !('textNorm' in sin));
    assert.equal(sin.evId, 'caso:10:post'); assert.equal(sin.th.length, 32);
    assert.ok(C.evidenceFromObs(o, 'caso', { withText: true }, NOW).excerpt.startsWith('texto normalizado'));
});

test('seudónimos: estables dentro de un expediente y distintos entre expedientes', () => {
    assert.equal(C.pseudonym('u:1', 'A'), C.pseudonym('u:1', 'A'));
    assert.notEqual(C.pseudonym('u:1', 'A'), C.pseudonym('u:1', 'B'));
    assert.notEqual(C.pseudonym('u:1', 'A'), C.pseudonym('u:2', 'A'));
    assert.match(C.pseudonym('u:1', 'A'), /^C-[0-9a-f]{8}$/);
});

test('paquete: por defecto no lleva usuarios; con la opción, sí; la huella cubre todo y detecta cambios', async () => {
    const { pkg } = await sample();
    const text = JSON.stringify(pkg);
    for (const h of ['Alfa', 'Beta', 'Gamma']) assert.ok(!text.includes(h), 'no debe aparecer ' + h);
    assert.equal(pkg.includesHandles, false);
    assert.ok(await C.verifyPackage(pkg));
    const tampered = JSON.parse(text);
    tampered.evidence[0].tweetId = '999';
    assert.equal(await C.verifyPackage(tampered), false, 'cambiar un dato rompe la huella');
    const notes = JSON.parse(text); notes.case.notes = 'otra';
    assert.equal(await C.verifyPackage(notes), false);
    const con = (await sample({ includeHandles: true })).pkg;
    assert.equal(con.includesHandles, true); assert.equal(Object.values(con.accounts).sort().join(), 'Alfa,Beta,Gamma');
    assert.ok(await C.verifyPackage(con));
    assert.notEqual(con.integrity.sha256, pkg.integrity.sha256);
});

test('paquete: determinista con la misma entrada y con las capas A, B y C separadas', async () => {
    const a = (await sample()).pkg, b = (await sample()).pkg;
    assert.equal(a.integrity.sha256, b.integrity.sha256);
    assert.deepEqual(Object.keys(a.layers), ['A', 'B', 'C']);
    assert.equal(a.case.notes, 'Mi hipótesis (capa C)');
    assert.ok(a.evidence.every(e => 'tweetId' in e && 'th' in e && !('uid' in e)));
    assert.ok(a.case.events[0].participants.every(p => /^C-/.test(p.account)));
    assert.equal(a.case.events[0].radar.version, '1.0');
});

test('informe: secciones fijas, aviso, capas etiquetadas, línea de tiempo con el evento externo y todo escapado', async () => {
    const { pkg } = await sample();
    const html = C.buildReport(pkg);
    for (const s of ['1 · Pregunta y alcance', '2 · Datos y cobertura', '3 · Método y parámetros', '4 · Hallazgos observados', '5 · Línea de tiempo', '6 · Notas del analista', '7 · Limitaciones', '8 · Anexo de evidencia']) assert.ok(html.includes(s), s);
    assert.ok(html.includes('capa A') && html.includes('capa B') && html.includes('capa C'));
    assert.ok(html.includes('no establece la identidad de nadie'));
    assert.ok(html.includes('no prueba una relación causal'));
    assert.ok(html.includes('&lt;importante&gt;') && !html.includes('<importante>'), 'texto del analista escapado');
    assert.ok(html.includes('texto de &lt;b&gt;prueba&lt;/b&gt; &amp; más') && !html.includes('<b>prueba</b>'));
    assert.ok(html.includes('Caso &lt;uno&gt;'));
    assert.ok(html.indexOf('Evento externo (capa C)') < html.indexOf('Evento observado (capa B)'), 'orden cronológico');
    assert.ok(html.includes('https://x.com/i/status/10'));
    assert.ok(!/<script/i.test(html));
    assert.ok(html.includes(pkg.integrity.sha256));
    assert.ok(!html.includes('Alfa'), 'sin usuarios por defecto');
    assert.ok(C.buildReport((await sample({ includeHandles: true })).pkg).includes('@Alfa'));
});
