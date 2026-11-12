/**
 * Worker de análisis: lee el registro local (IndexedDB, solo lectura) y ejecuta el radar y el análisis relacional fuera del hilo de la página.
 * Mensaje de entrada: { id, from, to }  ·  Salida: { id, ok, result, graph, handles } o { id, ok:false, error }.
 * No hace ninguna petición de red y no escribe nada.
 */
importScripts('../src/matcher.js', '../src/observe.js', '../src/radar.js', '../src/graph.js');

const DB_NAME = 'matatigre';
const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

async function exists() {
    try { return (await indexedDB.databases()).some(d => d.name === DB_NAME); } catch { return true; }
}

async function load(from, to) {
    if (!(await exists())) return { obs: [], handles: {} };
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open(DB_NAME); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
        const range = IDBKeyRange.bound(Number.isFinite(from) ? from : 0, Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER);
        const obs = await new Promise((resolve, reject) => {
            const t = db.transaction('obs', 'readonly');
            const r = t.objectStore('obs').index('t').getAll(range);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
        return { obs, db };
    } catch (e) { db.close(); throw e; }
}

/** Cuentas que aparecen en cualquier parte del resultado. */
function collectUids(result, graph) {
    const uids = new Set();
    for (const e of result.events) for (const p of e.participants) uids.add(p.uid);
    for (const a of [...(result.accounts || []), ...(result.interactors || [])]) { uids.add(a.uid); if (a.topTarget) uids.add(a.topTarget); for (const sg of a.signals || []) if (sg.target) uids.add(sg.target); }
    if (graph) {
        for (const n of graph.nodes) { uids.add(n.uid); if (n.dependence && n.dependence.top) uids.add(n.dependence.top); }
        for (const f of graph.findings) { for (const a of f.accounts || []) uids.add(a); if (f.target) uids.add(f.target); }
        for (const nr of graph.narratives) for (const p of nr.participants) uids.add(p.uid);
        for (const c of graph.communities) for (const m of c.members) uids.add(m);
    }
    return uids;
}

async function profilesOf(db, uids) {
    const handles = {}, attrs = {};
    const store = db.transaction('profiles', 'readonly').objectStore('profiles');
    for (const u of [...uids].slice(0, 6000)) {
        const p = await req(store.get(u));
        if (p && p.handle) handles[u] = p.handle; else if (u.startsWith('h:')) handles[u] = u.slice(2);
        if (p) attrs[u] = { followers: p.metrics ? p.metrics.followers : null, created: p.accountCreated || null };
    }
    return { handles, attrs };
}

onmessage = async e => {
    const { id, from, to, lists, topics } = e.data || {};
    try {
        const { obs, db } = await load(from, to);
        const result = XAF.analyze(obs, { from, to });
        let attrs = {};
        // los atributos (seguidores, fecha de alta) solo enriquecen los nodos; se leen para las cuentas más presentes
        if (db) {
            const counts = new Map();
            for (const o of obs) counts.set(o.authorUid, (counts.get(o.authorUid) || 0) + 1);
            const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1500).map(([u]) => u);
            attrs = (await profilesOf(db, top)).attrs;
        }
        const graph = XAF.analyzeGraph(obs, result.events, { attrs, topics: Array.isArray(topics) ? topics : [] });
        const { handles } = db ? await profilesOf(db, collectUids(result, graph)) : { handles: {} };
        if (db) db.close();
        // comparación entre listas con el mismo criterio: pertenencia por nombre de usuario (la manda la página de opciones)
        const membership = {};
        for (const n of graph.nodes) { const h = (handles[n.uid] || '').toLowerCase(); if (h && lists && lists[h]) membership[n.uid] = lists[h]; }
        graph.listCompare = XAF.listComparison(graph.nodes, membership);
        postMessage({ id, ok: true, result, graph, handles });
    } catch (err) {
        postMessage({ id, ok: false, error: (err && err.message) || String(err) });
    }
};
