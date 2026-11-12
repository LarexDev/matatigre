// node --test tests/   ·   Listas propias: entidades reales, separadas de las sincronizadas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.XAF = require('../extension/src/matcher.js');
const L = require('../extension/src/mylists.js');

const base = () => ({ accounts: {}, myLists: {}, lists: {}, listModes: {}, subs: [{ id: 'petristas', name: 'Petristas' }], allowlist: [], disabled: [] });

test('resolve: recoge las etiquetas heredadas de las cuentas propias y nunca las ids de listas sincronizadas', () => {
    const accounts = { a: { handle: 'a', tags: ['revisar', 'petristas'] }, b: { handle: 'b', tags: ['política'] }, c: { handle: 'c', tags: [] } };
    const r = L.resolve({ guardada: { name: 'Guardada', created: 5 } }, accounts, [{ id: 'petristas' }]);
    assert.deepEqual(Object.keys(r).sort(), ['guardada', 'política', 'revisar']);
    assert.equal(r.guardada.name, 'Guardada');
    assert.equal(r.revisar.name, 'revisar');
});

test('crear: nombre válido, id único y distinto de las listas sincronizadas; una lista vacía existe y se puede elegir', () => {
    const cfg = base();
    assert.equal(L.checkName(cfg, ''), 'Escribe un nombre.');
    assert.equal(L.checkName(cfg, '!!!'), 'Usa letras o números.');
    const id = L.create(cfg, 'Para revisar');
    assert.equal(id, 'para-revisar');
    assert.equal(cfg.myLists[id].name, 'Para revisar');
    assert.equal(cfg.lists[id], true);
    assert.match(L.checkName(cfg, 'para REVISAR'), /Ya tienes/);
    assert.match(L.checkName(cfg, 'Petristas'), /sincronizada/);
    const clash = L.create(cfg, 'Petristas');
    assert.notEqual(clash, 'petristas', 'no puede pisar el id de una lista sincronizada');
    assert.equal(L.create(cfg, 'Para revisar!'), 'para-revisar-2');
});

test('añadir cuentas: solo a listas propias existentes; no crea listas ni acepta ids de sincronizadas', () => {
    const cfg = base();
    const id = L.create(cfg, 'Mi lista');
    const r = L.addAccounts(cfg, ['@Uno', 'https://x.com/dos/status/1', 'no válido!!', 'uno'], [id, 'inexistente', 'petristas']);
    assert.equal(r.added, 2); assert.equal(r.existing, 1); assert.deepEqual(r.invalid, ['no válido!!']);
    assert.deepEqual(cfg.accounts.uno.tags, [id]);
    assert.equal(cfg.accounts.dos.handle, 'dos');
    assert.equal(Object.keys(cfg.myLists).length, 1, 'no se creó ninguna lista');
    assert.equal(L.addAccounts(cfg, ['tres'], ['inexistente']).added, 0);
    assert.ok(!cfg.accounts.tres);
});

test('añadir cuentas: una cuenta ya existente suma la lista sin perder datos y sale de la lista blanca y de las omitidas', () => {
    const cfg = base();
    const a = L.create(cfg, 'A'), b = L.create(cfg, 'B');
    cfg.accounts.uno = { handle: 'uno', name: 'Uno', note: 'nota', tags: [a], enabled: false };
    cfg.allowlist = ['uno']; cfg.disabled = ['uno'];
    L.addAccounts(cfg, ['uno'], [b]);
    assert.deepEqual(cfg.accounts.uno.tags, [a, b]);
    assert.equal(cfg.accounts.uno.note, 'nota'); assert.equal(cfg.accounts.uno.enabled, true);
    assert.deepEqual(cfg.allowlist, []); assert.deepEqual(cfg.disabled, []);
});

test('quitar de una lista: si era la única, la cuenta se elimina; si no, conserva el resto', () => {
    const cfg = base();
    const a = L.create(cfg, 'A'), b = L.create(cfg, 'B');
    L.addAccounts(cfg, ['uno'], [a, b]); L.addAccounts(cfg, ['dos'], [a]);
    assert.equal(L.removeFromList(cfg, 'uno', a), 'removed');
    assert.deepEqual(cfg.accounts.uno.tags, [b]);
    assert.equal(L.removeFromList(cfg, 'dos', a), 'deleted');
    assert.ok(!cfg.accounts.dos);
});

test('borrar una lista: limpia sus interruptores y modo y quita las cuentas que solo estaban en ella', () => {
    const cfg = base();
    const a = L.create(cfg, 'A'), b = L.create(cfg, 'B');
    L.addAccounts(cfg, ['uno'], [a, b]); L.addAccounts(cfg, ['dos'], [a]);
    cfg.listModes[a] = 'collapse';
    const r = L.remove(cfg, a);
    assert.equal(r.removedAccounts, 1);
    assert.ok(!cfg.myLists[a] && !(a in cfg.lists) && !(a in cfg.listModes));
    assert.deepEqual(cfg.accounts.uno.tags, [b]);
    assert.ok(!cfg.accounts.dos);
});

test('copiar desde una lista sincronizada no la modifica y deja las cuentas en una lista propia', () => {
    const cfg = base();
    cfg.listData = { petristas: { accounts: [{ handle: 'x1' }, { handle: 'x2' }] } };
    const copy = JSON.stringify(cfg.listData);
    const id = L.create(cfg, 'Mi selección');
    const r = L.copyAccounts(cfg, cfg.listData.petristas.accounts.map(a => a.handle), id);
    assert.equal(r.added, 2);
    assert.equal(JSON.stringify(cfg.listData), copy, 'el contenido sincronizado no cambia');
    assert.deepEqual(L.members(cfg, id).sort(), ['x1', 'x2']);
});

test('huérfanas: las cuentas propias sin lista se detectan para ordenarlas', () => {
    const cfg = base();
    cfg.accounts = { a: { handle: 'a', tags: [] }, b: { handle: 'b', tags: ['x'] } };
    assert.deepEqual(L.orphans(cfg), ['a']);
});

test('importar: sanitizeConfig acepta myLists y valida el tema', () => {
    const d = globalThis.XAF.sanitizeConfig({ myLists: { ok: { name: 'Ok', created: 1 }, 'con espacio': { name: 'x' }, rota: 5 }, settings: { theme: 'dark' } });
    assert.deepEqual(Object.keys(d.myLists), ['ok']);
    assert.equal(d.settings.theme, 'dark');
    assert.equal(globalThis.XAF.sanitizeConfig({ settings: { theme: 'neon' } }).settings.theme, 'auto');
});

test('límite de cuentas propias: las que no caben se cuentan como no añadidas, sin perder las existentes', () => {
    const accounts = {};
    for (let i = 0; i < L.MAX_ACCOUNTS - 1; i++) accounts['c' + i] = { handle: 'c' + i, tags: ['a'], enabled: true };
    const cfg = { myLists: { a: { name: 'A', created: 1 } }, accounts, allowlist: [], disabled: [] };
    const r = L.addAccounts(cfg, ['nueva1', 'nueva2', 'nueva3', 'c5'], ['a']);
    assert.equal(r.added, 1);
    assert.equal(r.limited, 2);
    assert.equal(r.existing, 1);
    assert.equal(Object.keys(cfg.accounts).length, L.MAX_ACCOUNTS);
});
