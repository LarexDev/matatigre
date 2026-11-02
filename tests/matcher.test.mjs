// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeHandle, createMatcher, parseLocation, mergeSeed, compilePattern, compactConfig, sanitizeConfig } = require('../extension/src/matcher.js');

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

test('mergeSeed añade, actualiza lo no tocado y respeta ediciones del usuario', () => {
    const existing = {
        a: { handle: 'a', name: 'viejo', tags: ['x'], enabled: true, source: 'seed', touched: false },
        b: { handle: 'b', name: 'mío', tags: ['mía'], enabled: false, source: 'seed', touched: true },
        c: { handle: 'c', name: 'manual', tags: [], enabled: true, source: 'manual', touched: true }
    };
    const { accounts, added, updated } = mergeSeed(existing, [
        { handle: 'a', name: 'nuevo', tags: ['y'] }, { handle: 'B', name: 'pisado', tags: ['z'] },
        { handle: 'C', name: 'pisado' }, { handle: 'd', name: 'D', tags: ['t'], enabled: false }, { handle: '!!', name: 'basura' }
    ]);
    assert.equal(added, 1); assert.equal(updated, 1);
    assert.equal(accounts.a.name, 'nuevo'); assert.deepEqual(accounts.a.tags, ['y']);
    assert.equal(accounts.b.name, 'mío'); assert.equal(accounts.b.enabled, false);
    assert.equal(accounts.c.name, 'manual');
    assert.equal(accounts.d.enabled, false);
});

for (const file of ['accounts.json', 'accounts.local.json']) {
    test(`la lista inicial ${file} (si existe) es válida y coherente`, async () => {
        const { readFile } = await import('node:fs/promises');
        let seed;
        try { seed = JSON.parse(await readFile(new URL('../extension/data/' + file, import.meta.url), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
        assert.ok(Array.isArray(seed.accounts));
        const seen = new Set();
        for (const a of seed.accounts) {
            const h = normalizeHandle(a.handle);
            assert.ok(h, `handle inválido: ${a.handle}`);
            assert.ok(!seen.has(h), `duplicado: ${a.handle}`);
            seen.add(h);
            for (const t of a.tags || []) assert.ok(seed.lists && seed.lists[t], `lista desconocida ${t}`);
        }
    });
}

test('la lista pública es mínima: sin notas, URLs ni grupos ajenos', async () => {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(new URL('../extension/data/accounts.json', import.meta.url), 'utf8');
    const seed = JSON.parse(raw);
    assert.ok(seed.accounts.length > 0 && seed.accounts.length <= 100);
    assert.ok(!raw.includes('http'), 'sin URLs');
    for (const a of seed.accounts) {
        assert.deepEqual(Object.keys(a).filter(k => !['handle', 'name', 'tags', 'enabled'].includes(k)), [], `campos no permitidos en ${a.handle}`);
        assert.ok(!a.tags.includes('citada'), 'el grupo "citada" no se publica');
    }
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
