/**
 * IndexedDB de la extensión: perfiles y observaciones (el filtrado sigue usando chrome.storage; esto solo guarda el registro local
 * que el usuario activa). Esquema versionado con una cadena de migraciones: añadir algo después = añadir una función al final de MIGRATIONS.
 *
 * Almacenes (v1; la v2 añadió y la v3 quitó un índice por etiqueta de perfil):
 *   profiles   uid ('u:<rest_id>' o 'h:<handle>')   identidad observada de cada cuenta: handle actual e historial, métricas y avisos (reasignación)
 *   handles    handle (minúsculas)                 handle → uid (resuelve alias y detecta reasignaciones)
 *   obs        obsId ('<tuit>:<tipo>')             publicaciones, reposts, citas y respuestas observados
 *   meta       k                                    valores sueltos (taxonomía, versión de esquema…)
 *   runs       runId                                ejecuciones de análisis (parámetros y versión): reproducibilidad (uso futuro)
 *   cases      caseId                               expedientes (uso futuro)
 *   evidence   evId                                 evidencia anclada a un expediente: NO se borra con la retención
 *   audit      seq                                  bitácora de cambios de juicios y etiquetas (solo se añade)
 */
(function (root) {
    'use strict';
    const XAF = (root.XAF = root.XAF || {});
    const DB_NAME = 'matatigre';

    const MIGRATIONS = [
        // v1
        db => {
            const profiles = db.createObjectStore('profiles', { keyPath: 'uid' });
            profiles.createIndex('handle', 'handle');
            profiles.createIndex('lastSeen', 'lastSeen');
            db.createObjectStore('handles', { keyPath: 'handle' });
            const obs = db.createObjectStore('obs', { keyPath: 'obsId' });
            obs.createIndex('authorT', ['authorUid', 't']);
            obs.createIndex('t', 't');
            obs.createIndex('seenAt', 'seenAt');
            obs.createIndex('targetId', 'targetId');
            obs.createIndex('tag', 'tags', { multiEntry: true });
            obs.createIndex('url', 'urls', { multiEntry: true });
            obs.createIndex('th', 'th');
            db.createObjectStore('meta', { keyPath: 'k' });
            db.createObjectStore('runs', { keyPath: 'runId' });
            db.createObjectStore('cases', { keyPath: 'caseId' }).createIndex('updatedAt', 'updatedAt');
            const ev = db.createObjectStore('evidence', { keyPath: 'evId' });
            ev.createIndex('caseId', 'caseId');
            ev.createIndex('obsId', 'obsId');
            db.createObjectStore('audit', { keyPath: 'seq', autoIncrement: true }).createIndex('at', 'at');
        },
        // v2: índice por etiqueta en los perfiles (consultar "todas las cuentas con la etiqueta X")
        (db, t) => {
            const profiles = t.objectStore('profiles');
            profiles.createIndex('labelIds', 'labelIds', { multiEntry: true });
            profiles.openCursor().onsuccess = e => {
                const cur = e.target.result;
                if (!cur) return;
                const v = cur.value;
                v.labelIds = (v.labels || []).map(l => l.id);
                cur.update(v);
                cur.continue();
            };
        },
        // v3: los perfiles ya no llevan etiquetas ni notas escritas a mano (solo identidad observada): se quita el índice y esos campos
        (db, t) => {
            const profiles = t.objectStore('profiles');
            if (profiles.indexNames.contains('labelIds')) profiles.deleteIndex('labelIds');
            profiles.openCursor().onsuccess = e => {
                const cur = e.target.result;
                if (!cur) return;
                const v = cur.value;
                for (const k of ['labels', 'labelIds', 'attrs', 'notes', 'publicFigure']) delete v[k];
                cur.update(v);
                cur.continue();
            };
        }
    ];
    const VERSION = MIGRATIONS.length;
    const STORES = ['profiles', 'handles', 'obs', 'meta', 'runs', 'cases', 'evidence', 'audit'];

    let opening = null;
    function open() {
        if (opening) return opening;
        opening = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, VERSION);
            req.onupgradeneeded = e => { for (let v = e.oldVersion; v < VERSION; v++) MIGRATIONS[v](req.result, req.transaction); };
            req.onsuccess = () => {
                const db = req.result;
                db.onversionchange = () => { db.close(); opening = null; };
                resolve(db);
            };
            req.onerror = () => { opening = null; reject(req.error); };
            req.onblocked = () => { opening = null; reject(new Error('base de datos bloqueada')); };
        });
        return opening;
    }

    /** Envuelve una petición de IndexedDB en una promesa. */
    const reqP = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

    /**
     * Ejecuta `fn(stores)` en una transacción y resuelve cuando ésta termina (commit). Dentro de `fn` solo se deben esperar
     * peticiones de IndexedDB (otra espera cerraría la transacción). Si `fn` lanza, se cancela todo.
     */
    async function tx(names, mode, fn) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const t = db.transaction(names, mode);
            const stores = Object.fromEntries([].concat(names).map(n => [n, t.objectStore(n)]));
            let out;
            t.oncomplete = () => resolve(out);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error || new Error('transacción cancelada'));
            Promise.resolve().then(() => fn(stores, t)).then(v => { out = v; }, e => { try { t.abort(); } catch { /* ya cerrada */ } reject(e); });
        });
    }

    /** Avanza un cursor y devuelve el siguiente (o null al terminar): `cursor.continue()` no devuelve nada, responde la petición original. */
    const advance = cur => new Promise((resolve, reject) => { const r = cur.request; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); cur.continue(); });

    const count = (store, query) => tx(store, 'readonly', s => reqP(s[store].count(query)));

    /** Borra todo el contenido (el esquema se conserva). */
    async function clearAll() {
        await tx(STORES, 'readwrite', s => Promise.all(STORES.map(n => reqP(s[n].clear()))));
    }

    XAF.db = { DB_NAME, VERSION, STORES, MIGRATIONS, open, tx, reqP, advance, count, clearAll };
})(typeof globalThis !== 'undefined' ? globalThis : this);
