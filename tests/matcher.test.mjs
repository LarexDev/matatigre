// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XAF = require('../extension/src/matcher.js');
const { normalizeHandle, createMatcher, parseLocation, compilePattern, compactConfig, sanitizeConfig } = XAF;

const acc = (handle, extra = {}) => ({ handle, enabled: true, tags: [], ...extra });
const cfg = (accounts, extra = {}) => ({ accounts: Object.fromEntries(accounts.map(a => [a.handle.toLowerCase(), a])), ...extra });

test('normalizeHandle acepta @, URLs y mayúsculas; rechaza basura', () => {
    assert.equal(normalizeHandle('@ListadaDos'), 'listadados');
    assert.equal(normalizeHandle(' https://x.com/ListadaUno/status/123 '), 'listadauno');
    assert.equal(normalizeHandle('twitter.com/Foo?s=20'), 'foo');
    assert.equal(normalizeHandle('mobile.twitter.com/Foo'), 'foo');
    for (const bad of ['', '@', 'a b', 'demasiado_largo_handle_x', 'ñandú', null, undefined, 42]) assert.equal(normalizeHandle(bad), null, String(bad));
});

test('sólo coinciden cuentas listadas (sin falsos positivos por subcadena)', () => {
    const m = createMatcher(cfg([acc('ListadaUno')]));
    assert.ok(m.evaluate({ author: 'listadauno' }));
    assert.ok(m.evaluate({ author: 'LISTADAUNO' }));
    assert.equal(m.evaluate({ author: 'ListadaUnoid' }), null);
    assert.equal(m.evaluate({ author: 'xListadaUno' }), null);
    assert.equal(m.evaluate({ author: 'alguien', text: 'hola @ListadaUno' }), null);
    assert.equal(m.evaluate({}), null);
});

test('cuentas desactivadas no filtran', () => {
    const m = createMatcher(cfg([acc('a', { enabled: false })]));
    assert.equal(m.evaluate({ author: 'a' }), null);
    assert.equal(m.accountCount, 0);
});

test('listas: se filtra si al menos una etiqueta está activa; sin etiquetas siempre', () => {
    const accounts = [acc('uno', { tags: ['grupoa'] }), acc('dos', { tags: ['grupob'] }), acc('tres', { tags: ['grupob', 'grupoa'] }), acc('cuatro')];
    const m = createMatcher(cfg(accounts, { lists: { grupoa: true, grupob: false } }));
    assert.ok(m.evaluate({ author: 'uno' }));
    assert.equal(m.evaluate({ author: 'dos' }), null);
    assert.ok(m.evaluate({ author: 'tres' }));
    assert.ok(m.evaluate({ author: 'cuatro' }));
    // lista sin entrada explícita = activa
    assert.ok(createMatcher(cfg(accounts, { lists: {} })).evaluate({ author: 'dos' }));
});

test('reposters y citas obedecen sus ajustes; el autor siempre cuenta', () => {
    const accounts = [acc('malo')];
    let m = createMatcher(cfg(accounts, { settings: { filterReposters: true, filterQuoted: false } }));
    assert.equal(m.evaluate({ author: 'ok', reposter: 'malo' }).role, 'reposter');
    assert.equal(m.evaluate({ author: 'ok', quoted: 'malo' }), null);
    m = createMatcher(cfg(accounts, { settings: { filterReposters: false, filterQuoted: true } }));
    assert.equal(m.evaluate({ author: 'ok', reposter: 'malo' }), null);
    assert.equal(m.evaluate({ author: 'ok', quoted: 'malo' }).role, 'quoted');
    assert.equal(m.evaluate({ author: 'malo' }).role, 'author');
});

test('lista blanca gana sobre cuentas, reglas y reposts', () => {
    const m = createMatcher({
        ...cfg([acc('malo')]), allowlist: ['@Malo'],
        rules: [{ kind: 'handle', mode: 'glob', pattern: '*alo', enabled: true }]
    });
    assert.equal(m.evaluate({ author: 'malo' }), null);
    assert.equal(m.matchHandle('malo'), null);
    const m2 = createMatcher({ ...cfg([acc('malo')]), allowlist: ['bueno'] });
    assert.equal(m2.evaluate({ author: 'bueno', reposter: 'malo' }), null, 'autor exceptuado no se oculta por repost');
});

test('reglas: glob, contains (sin tildes/mayúsculas) y regex', () => {
    const m = createMatcher({
        rules: [
            { kind: 'handle', mode: 'glob', pattern: '*promo*', enabled: true },
            { kind: 'name', mode: 'contains', pattern: 'vendo seguidores', enabled: true },
            { kind: 'text', mode: 'regex', pattern: '\\bcompra ya\\b', enabled: true },
            { kind: 'text', mode: 'contains', pattern: 'desactivada', enabled: false }
        ]
    });
    assert.equal(m.evaluate({ author: 'fan_promo01' }).type, 'rule');
    assert.equal(m.evaluate({ author: 'otro', authorName: 'Juan 🇨🇴 Vendo Seguidores' }).type, 'rule');
    assert.ok(m.evaluate({ author: 'otro', text: '¡Compra YA!' }));
    assert.equal(m.evaluate({ author: 'otro', text: 'compra yate' }), null);
    assert.equal(m.evaluate({ author: 'otro', text: 'regla desactivada' }), null);
    assert.equal(m.evaluate({ author: 'neutral', authorName: 'Neutral', text: 'nada' }), null);
    assert.ok(m.usesText);
});

test('reglas inválidas se ignoran sin romper', () => {
    const m = createMatcher({ rules: [{ kind: 'text', mode: 'regex', pattern: '(', enabled: true }, { kind: 'raro', mode: 'glob', pattern: 'x', enabled: true }, null] });
    assert.equal(m.ruleCount, 0);
    assert.equal(compilePattern('regex', '('), null);
    assert.equal(compilePattern('glob', '   '), null);
});

test('glob escapa metacaracteres de regex', () => {
    const t = compilePattern('glob', 'a.b*');
    assert.ok(t('a.bcd'));
    assert.ok(!t('axbcd'));
});

test('parseLocation distingue perfil, publicación, ámbito y otras rutas', () => {
    assert.deepEqual(parseLocation('/'), { kind: 'other', scope: 'home' });
    assert.deepEqual(parseLocation('/home'), { kind: 'other', scope: 'home' });
    assert.deepEqual(parseLocation('/Foo'), { kind: 'profile', handle: 'foo', scope: 'profile' });
    assert.deepEqual(parseLocation('/Foo/with_replies'), { kind: 'profile', handle: 'foo', scope: 'profile' });
    assert.deepEqual(parseLocation('/Foo/status/123'), { kind: 'status', handle: 'foo', statusId: '123', scope: 'status' });
    assert.deepEqual(parseLocation('/Foo/status/123/photo/1'), { kind: 'status', handle: 'foo', statusId: '123', scope: 'status' });
    assert.deepEqual(parseLocation('/i/lists/1'), { kind: 'other', scope: 'list' });
    assert.deepEqual(parseLocation('/Foo/lists/bar'), { kind: 'other', scope: 'list' });
    assert.deepEqual(parseLocation('/search'), { kind: 'other', scope: 'search' });
    assert.deepEqual(parseLocation('/notifications'), { kind: 'other', scope: 'notifications' });
    assert.deepEqual(parseLocation('/i/bookmarks'), { kind: 'other', scope: 'bookmarks' });
    assert.deepEqual(parseLocation('/messages'), { kind: 'other', scope: 'other' });
});

test('roles nuevos: respuestas y menciones obedecen sus ajustes', () => {
    const accounts = [acc('malo')];
    let m = createMatcher(cfg(accounts, { settings: { filterReplies: false, filterMentions: false } }));
    assert.equal(m.evaluate({ author: 'ok', replyTo: 'malo', mentions: ['malo'] }), null);
    m = createMatcher(cfg(accounts, { settings: { filterReplies: true, filterMentions: false } }));
    assert.equal(m.evaluate({ author: 'ok', replyTo: 'malo' }).role, 'replyTo');
    m = createMatcher(cfg(accounts, { settings: { filterReplies: false, filterMentions: true } }));
    assert.equal(m.evaluate({ author: 'ok', mentions: ['otro', 'MALO'] }).role, 'mention');
});

test('por defecto se filtran citas y reposts pero no respuestas ni menciones', () => {
    const m = createMatcher(cfg([acc('malo')]));
    assert.equal(m.evaluate({ author: 'ok', quoted: 'malo' }).role, 'quoted');
    assert.equal(m.evaluate({ author: 'ok', reposters: ['x', 'malo'] }).role, 'reposter');
    assert.equal(m.evaluate({ author: 'ok', replyTo: 'malo' }), null);
    assert.equal(m.evaluate({ author: 'ok', mentions: ['malo'] }), null);
});

test('reglas de biografía, nombre de la cuenta grupob e idioma', () => {
    const m = createMatcher({
        rules: [
            { kind: 'bio', mode: 'contains', pattern: 'vendo seguidores', enabled: true },
            { kind: 'lang', mode: 'glob', pattern: 'ja', enabled: true }
        ],
        settings: { filterQuoted: true }
    });
    assert.equal(m.evaluate({ author: 'a', authorBio: 'Aquí VENDO seguidores 🇨🇴' }).role, 'author');
    assert.equal(m.evaluate({ author: 'b', quoted: 'c', quotedBio: 'vendo seguidores' }).role, 'quoted');
    assert.equal(m.evaluate({ author: 'd', lang: 'ja' }).role, 'lang');
    assert.equal(m.evaluate({ author: 'd', lang: 'es' }), null);
});

test('isExempt: ámbito apagado, perfil propio y publicación abierta', () => {
    const m = createMatcher(cfg([acc('malo')], { settings: { scope: { search: false } } }));
    const v = { handle: 'malo', role: 'author' };
    assert.equal(m.isExempt(parseLocation('/search'), v, { author: 'malo' }), true);
    assert.equal(m.isExempt(parseLocation('/home'), v, { author: 'malo' }), false);
    assert.equal(m.isExempt(parseLocation('/malo'), v, { author: 'malo' }), true);
    assert.equal(m.isExempt(parseLocation('/otro'), v, { author: 'malo' }), false);
    assert.equal(m.isExempt(parseLocation('/malo'), { handle: 'ok', role: 'reposter' }, { author: 'ok', reposters: ['malo'] }), true);
    assert.equal(m.isExempt(parseLocation('/malo/status/5'), v, { id: '5', author: 'malo' }), true);
    assert.equal(m.isExempt(parseLocation('/malo/status/5'), v, { id: '6', author: 'malo' }), false);
    const strict = createMatcher(cfg([acc('malo')], { settings: { pauseOnProfile: false, keepFocal: false } }));
    assert.equal(strict.isExempt(parseLocation('/malo'), v, { author: 'malo' }), false);
    assert.equal(strict.isExempt(parseLocation('/malo/status/5'), v, { id: '5', author: 'malo' }), false);
});

test('compactConfig conserva el comportamiento con menos datos', () => {
    const full = cfg([acc('uno', { tags: ['a'], note: 'larga nota' }), acc('dos', { enabled: false }), acc('tres', { tags: ['b'] })], {
        lists: { a: true, b: false }, allowlist: ['x'], rules: [{ kind: 'handle', mode: 'glob', pattern: 'zz*', enabled: true }, { kind: 'handle', mode: 'glob', pattern: 'no*', enabled: false }]
    });
    const compact = compactConfig(full);
    assert.ok(!('dos' in compact.accounts));
    assert.ok(!('note' in compact.accounts.uno));
    assert.equal(compact.rules.length, 1);
    const [m1, m2] = [createMatcher(full), createMatcher(JSON.parse(JSON.stringify(compact)))];
    for (const h of ['uno', 'dos', 'tres', 'zz1', 'no1', 'x']) assert.equal(!!m1.evaluate({ author: h }), !!m2.evaluate({ author: h }), h);
});

test('el paquete es neutro: no incluye cuentas públicas', async () => {
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(new URL('../extension/data/accounts.json', import.meta.url)), { code: 'ENOENT' });
});

// ---------- capas y suscripciones ----------
const subCfg = (extra = {}) => ({
    subs: [{ id: 'uno', name: 'Uno', url: 'https://e.x/uno.json', source: 'catalog' }, { id: 'dos', name: 'Dos', url: 'https://e.x/dos.json', source: 'custom' }],
    listData: { uno: { accounts: [{ handle: 'Alfa', name: 'Alfa A' }, { handle: 'beta' }] }, dos: { accounts: [{ handle: 'beta' }, { handle: 'gamma' }] } },
    ...extra
});

test('composeConfig: cada cuenta de una suscripción lleva el id de su lista como etiqueta', () => {
    const c = XAF.composeConfig(subCfg());
    assert.deepEqual(c.accounts.alfa.tags, ['uno']);
    assert.deepEqual(c.accounts.beta.tags, ['uno', 'dos']);
    assert.equal(c.accounts.alfa.name, 'Alfa A');
});

test('suscripciones: el interruptor de lista apaga o enciende sus cuentas; una cuenta en dos listas sigue si una está activa', () => {
    const on = createMatcher(subCfg());
    for (const h of ['alfa', 'beta', 'gamma']) assert.ok(on.evaluate({ author: h }), h);
    assert.equal(on.accountCount, 3);
    const off = createMatcher(subCfg({ lists: { uno: false } }));
    assert.equal(off.evaluate({ author: 'alfa' }), null);
    assert.ok(off.evaluate({ author: 'beta' }), 'beta sigue en "dos"');
    assert.ok(off.evaluate({ author: 'gamma' }));
});

test('suscripciones: "disabled" apaga una cuenta de lista solo para el usuario', () => {
    const m = createMatcher(subCfg({ disabled: ['@Beta'] }));
    assert.equal(m.evaluate({ author: 'beta' }), null);
    assert.ok(m.evaluate({ author: 'alfa' }));
});

test('suscripciones: lista blanca > cuenta propia desactivada > suscripción; cuenta propia sin etiquetas siempre filtra', () => {
    assert.equal(createMatcher(subCfg({ allowlist: ['alfa'] })).evaluate({ author: 'alfa' }), null);
    const propiaOff = createMatcher(subCfg({ accounts: { alfa: acc('Alfa', { enabled: false }) } }));
    assert.equal(propiaOff.evaluate({ author: 'alfa' }), null, 'desactivada por el usuario aunque la lista la traiga');
    const propiaSinEtiqueta = createMatcher(subCfg({ lists: { uno: false, dos: false }, accounts: { beta: acc('beta') } }));
    assert.ok(propiaSinEtiqueta.evaluate({ author: 'beta' }), 'sin etiquetas: siempre activa');
    assert.equal(propiaSinEtiqueta.evaluate({ author: 'alfa' }), null);
    const mezcla = XAF.composeConfig(subCfg({ accounts: { alfa: acc('Alfa', { tags: ['mía'] }) } }));
    assert.deepEqual(mezcla.accounts.alfa.tags.sort(), ['mía', 'uno']);
});

test('suscripciones: sin copia local de una lista no se filtra nada de ella y no falla', () => {
    const m = createMatcher({ subs: [{ id: 'x', name: 'X', url: 'https://e.x/x.json', source: 'catalog' }], listData: {} });
    assert.equal(m.accountCount, 0);
    assert.equal(m.evaluate({ author: 'alfa' }), null);
});

test('compactConfig con suscripciones equivale al matcher completo y no arrastra los datos de las listas', () => {
    const full = subCfg({ lists: { dos: false }, disabled: ['alfa'], accounts: { propia: acc('propia') }, rules: [{ id: 'r', kind: 'handle', mode: 'glob', pattern: 'bot_*', enabled: true }] });
    const compact = compactConfig(full);
    assert.ok(!('listData' in compact) && !('subs' in compact));
    const [m1, m2] = [createMatcher(full), createMatcher(JSON.parse(JSON.stringify(compact)))];
    for (const h of ['alfa', 'beta', 'gamma', 'propia', 'bot_1', 'otro']) assert.equal(!!m1.evaluate({ author: h }), !!m2.evaluate({ author: h }), h);
});

// ---------- validación de listas descargadas ----------
test('sanitizeList: normaliza, quita duplicados y descarta lo inválido', () => {
    const r = XAF.sanitizeList({
        schema: 1, id: 'mi-lista', name: ' Mi lista ', description: 'd', version: 3, updated: '2026-11-08', extra: 'se ignora',
        accounts: [{ handle: '@Alfa', name: 'A' }, { handle: 'alfa' }, 'Beta', { handle: 'https://x.com/Gamma' }, { handle: 'no valido!' }, null, 5, { handle: 'x'.repeat(16) }]
    });
    assert.ok(r.ok);
    assert.equal(r.list.id, 'mi-lista'); assert.equal(r.list.name, 'Mi lista'); assert.equal(r.list.version, '3');
    assert.deepEqual(r.list.accounts.map(a => a.handle), ['Alfa', 'Beta', 'Gamma']);
    assert.equal(r.list.accounts[0].name, 'A');
    assert.ok(!('extra' in r.list));
});

test('sanitizeList rechaza formatos no admitidos', () => {
    for (const bad of [null, [], 'x', {}, { schema: 2, accounts: [] }, { schema: 1 }, { schema: 1, accounts: 'no' }]) assert.equal(XAF.sanitizeList(bad).ok, false, JSON.stringify(bad));
    assert.equal(XAF.sanitizeList({ schema: 1, id: 'MAL ID', accounts: [] }).list.id, '');
});

test('sanitizeList acota el tamaño (5000 cuentas) y el texto', () => {
    const accounts = Array.from({ length: 6000 }, (_, i) => ({ handle: 'u' + i, name: 'n'.repeat(500) }));
    const r = XAF.sanitizeList({ schema: 1, id: 'grande', name: 'N'.repeat(500), accounts });
    assert.equal(r.list.accounts.length, 5000);
    assert.equal(r.list.accounts[0].name.length, 120);
    assert.equal(r.list.name.length, 80);
});

test('sanitizeCatalog: valida entradas, ids repetidos y retiradas', () => {
    const r = XAF.sanitizeCatalog({
        schema: 1, name: 'Cat', updated: '2026-11-08',
        lists: [
            { id: 'a', name: 'A', description: 'd', path: 'listas/a.json', recommended: true, count: 3 },
            { id: 'a', name: 'repetida', path: 'listas/a2.json' }, { id: 'MAL', path: 'x.json' }, { id: 'sin-path', name: 'x' }, null,
            { id: 'b', name: 'B', path: 'https://e.x/b.json', recommended: 'sí', count: -1 }
        ],
        withdrawn: ['vieja', 'MAL ID', 5]
    });
    assert.ok(r.ok);
    assert.deepEqual(r.catalog.lists.map(l => l.id), ['a', 'b']);
    assert.equal(r.catalog.lists[0].recommended, true);
    assert.equal(r.catalog.lists[1].recommended, false, 'solo true estricto');
    assert.equal(r.catalog.lists[1].count, null);
    assert.deepEqual(r.catalog.withdrawn, ['vieja']);
    assert.equal(XAF.sanitizeCatalog({ schema: 2, lists: [] }).ok, false);
});

test('isAllowedListUrl / resolveListUrl: https siempre; http solo en la propia máquina; sin credenciales', () => {
    for (const ok of ['https://raw.githubusercontent.com/a/b/main/index.json', 'http://127.0.0.1:8080/x.json', 'http://localhost/x.json']) assert.ok(XAF.isAllowedListUrl(ok), ok);
    for (const bad of ['http://example.com/x.json', 'ftp://x/y', 'javascript:alert(1)', 'file:///c:/x.json', 'https://user:pw@e.x/x.json', 'no es url', '', null, 'https://e.x/' + 'a'.repeat(600)]) assert.equal(XAF.isAllowedListUrl(bad), false, String(bad));
    assert.equal(XAF.resolveListUrl('https://e.x/repo/index.json', 'listas/a.json'), 'https://e.x/repo/listas/a.json');
    assert.equal(XAF.resolveListUrl('https://e.x/repo/index.json', 'https://otro.x/b.json'), 'https://otro.x/b.json');
    assert.equal(XAF.resolveListUrl('https://e.x/repo/index.json', 'http://malo.x/b.json'), null);
});

test('sanitizeConfig: de un archivo ajeno solo se aceptan ids de suscripciones del catálogo, nunca URLs', () => {
    const c = sanitizeConfig({ subs: [{ id: 'petrista', source: 'catalog', url: 'https://malo.x/robo' }, { id: 'u-1234', source: 'custom', url: 'https://malo.x/robo' }, { id: 'MAL', source: 'catalog' }], disabled: ['@Foo', 'foo', '!!'] });
    assert.deepEqual(c.catalogSubs, ['petrista']);
    assert.deepEqual(c.disabled, ['foo']);
    assert.ok(!('subs' in c));
});

test('examples/lista-ejemplo.json se importa completo tras el saneado', async () => {
    const { readFile } = await import('node:fs/promises');
    const clean = sanitizeConfig(JSON.parse(await readFile(new URL('../examples/lista-ejemplo.json', import.meta.url), 'utf8')));
    assert.equal(Object.keys(clean.accounts).length, 3);
    assert.equal(clean.accounts.ejemplo_tres.enabled, false);
    assert.equal(clean.rules.length, 2);
    assert.deepEqual(clean.allowlist, ['mi_amigo']);
    assert.equal(clean.settings.mode, 'hide');
    assert.equal(clean.settings.scope.home, true);
});

// ---------- modo por lista ----------
const modeCfg = (extra = {}) => ({
    settings: { mode: 'collapse' },
    accounts: { uno: acc('uno', { tags: ['a'] }), dos: acc('dos', { tags: ['b'] }), ambas: acc('ambas', { tags: ['a', 'b'] }), libre: acc('libre') },
    lists: { a: true, b: true },
    listModes: { a: 'highlight', b: 'hide' },
    ...extra
});

test('modo por lista: cada cuenta usa el modo de su lista; sin modo propio rige el general', () => {
    const m = createMatcher(modeCfg());
    assert.equal(m.evaluate({ author: 'uno' }).mode, 'highlight');
    assert.equal(m.evaluate({ author: 'dos' }).mode, 'hide');
    assert.equal(m.evaluate({ author: 'libre' }).mode, 'collapse', 'cuenta sin lista: modo general');
    const sinModos = createMatcher(modeCfg({ listModes: {} }));
    assert.equal(sinModos.evaluate({ author: 'uno' }).mode, 'collapse', 'lista sin modo propio: general');
});

test('modo por lista: una cuenta en varias listas toma el modo más restrictivo de las que están encendidas', () => {
    assert.equal(createMatcher(modeCfg()).evaluate({ author: 'ambas' }).mode, 'hide');
    assert.equal(createMatcher(modeCfg({ lists: { a: true, b: false } })).evaluate({ author: 'ambas' }).mode, 'highlight', 'la lista apagada no cuenta');
});

test('modo por lista: entre varios roles gana el más restrictivo (ocultar > colapsar > resaltar)', () => {
    const m = createMatcher(modeCfg());
    const v = m.evaluate({ author: 'uno', quoted: 'dos' });
    assert.equal(v.mode, 'hide'); assert.equal(v.role, 'quoted');
    const empate = createMatcher(modeCfg({ listModes: { a: 'hide', b: 'hide' } })).evaluate({ author: 'uno', quoted: 'dos' });
    assert.equal(empate.role, 'author', 'a igualdad gana el primer rol');
    const resalta = m.evaluate({ author: 'uno', quoted: 'libre' });
    assert.equal(resalta.mode, 'collapse', 'colapsar (cita a cuenta libre) supera a resaltar (autor)');
});

test('modo por lista: las reglas usan el modo general', () => {
    const m = createMatcher(modeCfg({ rules: [{ id: 'r', kind: 'handle', mode: 'glob', pattern: 'bot_*', enabled: true }] }));
    assert.equal(m.evaluate({ author: 'bot_1' }).mode, 'collapse');
});

test('modo por lista: llega al script de página por compactConfig y se valida al importar', () => {
    const compact = JSON.parse(JSON.stringify(compactConfig(modeCfg())));
    assert.equal(createMatcher(compact).evaluate({ author: 'dos' }).mode, 'hide');
    const clean = sanitizeConfig({ listModes: { a: 'hide', b: 'explotar', ['x'.repeat(50)]: 'hide', c: 5 } });
    assert.deepEqual(clean.listModes, { a: 'hide' });
});

// ---------- filtrado por id de usuario ----------
const idCfg = (extra = {}) => ({ accounts: { vieja: acc('Vieja', { uid: '111' }), sinid: acc('SinId') }, ...extra });

test('por id: una cuenta que cambió de nombre se reconoce igualmente', () => {
    const m = createMatcher(idCfg());
    const v = m.evaluate({ author: 'nombre_nuevo', authorId: '111' });
    assert.ok(v); assert.equal(v.handle, 'nombre_nuevo'); assert.equal(v.renamed, true); assert.equal(v.uid, '111');
    assert.equal(m.evaluate({ author: 'otro', authorId: '999' }), null);
});

test('por id: si el nombre de una cuenta de la lista llega con OTRO id, ya es de otra persona y no se filtra', () => {
    const m = createMatcher(idCfg());
    assert.equal(m.evaluate({ author: 'vieja', authorId: '222' }), null, 'reasignado');
    assert.ok(m.evaluate({ author: 'vieja', authorId: '111' }), 'mismo id: sí');
    assert.ok(m.evaluate({ author: 'vieja' }), 'sin id (DOM): se sigue por nombre');
});

test('por id: sin id conocido se filtra por nombre y se pide aprender el par (nombre, id)', () => {
    const m = createMatcher(idCfg());
    const v = m.evaluate({ author: 'sinid', authorId: '333' });
    assert.ok(v); assert.deepEqual(v.learn, { h: 'sinid', id: '333' });
    assert.equal(m.evaluate({ author: 'vieja', authorId: '111' }).learn, undefined, 'ya conocida: nada que aprender');
    assert.equal(m.evaluate({ author: 'sinid' }).learn, undefined, 'sin id en la respuesta: nada que aprender');
});

test('por id: cita y repost también se reconocen por id; la lista blanca (por nombre) gana', () => {
    const m = createMatcher(idCfg());
    assert.equal(m.evaluate({ author: 'x', quoted: 'otro_nombre', quotedId: '111' }).role, 'quoted');
    assert.equal(m.evaluate({ author: 'x', reposters: ['otro_nombre'], reposterIds: ['111'] }).role, 'reposter');
    assert.equal(createMatcher(idCfg({ allowlist: ['nombre_nuevo'] })).evaluate({ author: 'nombre_nuevo', authorId: '111' }), null);
});

test('por id: los ids aprendidos (uids) y los de las listas se incorporan; los ids inválidos se ignoran', () => {
    const c = XAF.composeConfig({ accounts: { a: acc('a'), b: acc('b', { uid: '5' }) }, uids: { a: '42', b: '7', c: 'x' } });
    assert.equal(c.accounts.a.uid, '42'); assert.equal(c.accounts.b.uid, '5', 'el propio de la cuenta manda');
    const l = XAF.composeConfig({ subs: [{ id: 'l', name: 'L', url: 'https://e.x/l.json', source: 'custom' }], listData: { l: { accounts: [{ handle: 'zeta', id: '900' }, { handle: 'eta', id: 'no' }] } } });
    assert.equal(l.accounts.zeta.uid, '900'); assert.equal(l.accounts.eta.uid, undefined);
    const m = createMatcher({ accounts: { a: acc('a') }, uids: { a: '42' } });
    assert.ok(m.evaluate({ author: 'renombrada', authorId: '42' }));
    const compact = JSON.parse(JSON.stringify(compactConfig({ accounts: { a: acc('a') }, uids: { a: '42' } })));
    assert.equal(compact.accounts.a.uid, '42');
    assert.ok(createMatcher(compact).evaluate({ author: 'renombrada', authorId: '42' }));
});

test('sanitizeList conserva el id de usuario opcional de cada cuenta', () => {
    const r = XAF.sanitizeList({ schema: 1, id: 'x', accounts: [{ handle: 'a', id: '123' }, { handle: 'b', id: 'abc' }, { handle: 'c' }] });
    assert.deepEqual(r.list.accounts.map(a => a.id), ['123', undefined, undefined]);
});

test('sanitizeConfig descarta tipos y valores no válidos', () => {
    const clean = sanitizeConfig({
        settings: { mode: 'explotar', enabled: 'sí', filterQuoted: false, scope: { home: false, cosa: true } },
        accounts: [{ handle: '@Bueno', tags: ['A B', 7, ''] }, { handle: 'no válido!' }, null, { handle: 'x'.repeat(40) }],
        lists: { ok: true, mal: 'x' },
        rules: [{ kind: 'text', mode: 'regex', pattern: '(' }, { kind: 'raro', mode: 'glob', pattern: 'a' }, { kind: 'text', mode: 'contains', pattern: 'ok' }],
        allowlist: ['@Amigo', 'nada!!', 3],
        __proto__: { x: 1 }, polluted: 1
    });
    assert.deepEqual(Object.keys(clean.accounts), ['bueno']);
    assert.deepEqual(clean.accounts.bueno.tags, ['a-b']);
    assert.equal(clean.settings.mode, 'hide');
    assert.equal(clean.settings.enabled, true);
    assert.equal(clean.settings.filterQuoted, false);
    assert.equal(clean.settings.scope.home, false);
    assert.ok(!('cosa' in clean.settings.scope));
    assert.deepEqual(clean.lists, { ok: true });
    assert.equal(clean.rules.length, 1);
    assert.deepEqual(clean.allowlist, ['amigo']);
    assert.ok(!('polluted' in clean));
    assert.deepEqual(sanitizeConfig('basura'), {});
    assert.deepEqual(sanitizeConfig([1, 2]), {});
    assert.deepEqual(sanitizeConfig({}), {});
});

test('matcher.main.js (copia para el mundo MAIN) es idéntico a matcher.js', async () => {
    const { readFile } = await import('node:fs/promises');
    const [a, b] = await Promise.all(['matcher.js', 'matcher.main.js'].map(f => readFile(new URL('../extension/src/' + f, import.meta.url), 'utf8')));
    assert.equal(a, b, 'ejecuta: npm run sync');
});

test('modo analista: apagado por defecto, y el registro solo corre con el modo activo y el registro encendido', () => {
    const d = XAF.resolveSettings({});
    assert.equal(d.analyst, false);
    assert.equal(d.observe, false);
    assert.equal(XAF.captureOn(d), false);
    assert.equal(XAF.captureOn({ observe: true, analyst: false }), false);
    assert.equal(XAF.captureOn({ observe: false, analyst: true }), false);
    assert.equal(XAF.captureOn({ observe: true, analyst: true }), true);
    assert.equal(XAF.captureOn(null), false);
});

test('modo analista: quien ya tenía el registro encendido (versiones anteriores) conserva el análisis', () => {
    assert.equal(XAF.resolveSettings({ observe: true }).analyst, true);
    assert.equal(XAF.resolveSettings({ observe: false }).analyst, false);
    assert.equal(XAF.resolveSettings({ observe: true, analyst: false }).analyst, false);
    // también al importar una copia antigua
    assert.equal(sanitizeConfig({ settings: { observe: true } }).settings.analyst, true);
    assert.equal(sanitizeConfig({ settings: { observe: true, analyst: false } }).settings.analyst, false);
    // y el script de página recibe el ajuste resuelto
    assert.equal(compactConfig({ settings: { observe: true, analyst: false } }).settings.analyst, false);
});

test('el veredicto dice qué lista lo motivó (solo las encendidas), también por id de usuario', () => {
    const m = createMatcher({
        accounts: { uno: { handle: 'uno', tags: ['a', 'b'], enabled: true }, dos: { handle: 'dos', tags: ['a'], enabled: true, uid: '77' } },
        lists: { a: true, b: false }
    });
    assert.deepEqual(m.evaluate({ author: 'uno' }).lists, ['a']);
    assert.deepEqual(m.evaluate({ author: 'renombrada', authorId: '77' }).lists, ['a']);
    // una regla no pertenece a ninguna lista: su etiqueta ya explica el motivo
    const r = createMatcher({ accounts: {}, rules: [{ kind: 'handle', mode: 'glob', pattern: 'bot_*', enabled: true }] }).evaluate({ author: 'bot_1' });
    assert.equal(r.lists, undefined);
    assert.match(r.label, /regla/);
});

test('límites: valores conocidos y la importación respeta el tope de cuentas propias', () => {
    assert.deepEqual({ ...XAF.LIMITS }, { listAccounts: 5000, syncedTotal: 25000, subs: 30, ownAccounts: 20000 });
    const many = Array.from({ length: XAF.LIMITS.ownAccounts + 50 }, (_, i) => ({ handle: 'c' + i }));
    assert.equal(Object.keys(sanitizeConfig({ accounts: many }).accounts).length, XAF.LIMITS.ownAccounts);
});

test('perfiles de un clic: cada uno se reconoce a sí mismo y «personalizado» no coincide con ninguno', () => {
    const base = XAF.resolveSettings({});
    assert.equal(XAF.profileOf(base), 'moderate', 'los valores por defecto son el perfil moderado');
    for (const k of Object.keys(XAF.PROFILES)) assert.equal(XAF.profileOf({ ...base, ...XAF.PROFILES[k] }), k);
    assert.equal(XAF.profileOf({ ...base, ...XAF.PROFILES.moderate, filterMentions: true }), null, 'mezclar a mano ya es personalizado');
    assert.equal(XAF.profileOf({ ...base, filterQuoted: false }), null);
    assert.equal(XAF.PROFILES.strict.filterReplies && XAF.PROFILES.strict.filterMentions, true);
    assert.equal(XAF.PROFILES.mark.mode, 'highlight');
});

test('el «por qué» de una ocultación dice qué está ocurriendo con la cuenta de la lista', () => {
    assert.equal(XAF.whyPhrase('quoted', 'ana'), 'Citando a @ana');
    assert.equal(XAF.whyPhrase('replyTo', 'ana'), 'Respondiendo a @ana');
    assert.equal(XAF.whyPhrase('mention', 'ana'), 'Mencionando a @ana');
    assert.equal(XAF.whyPhrase('reposter', 'ana'), 'Reposteado por @ana');
    assert.equal(XAF.whyPhrase('author', 'ana'), 'Publicación de @ana');
    assert.match(XAF.whyPhrase('text', null, 'texto "x"'), /regla/);
    assert.equal(XAF.whyPhrase(undefined, null, 'regla "bot_*"'), 'regla "bot_*"');
});
