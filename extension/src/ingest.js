/**
 * Ingesta del registro de observaciones (solo el service worker escribe). Recibe lotes de registros compactos del script
 * de página (vía el content script), los valida (`XAF.toRecord`) y actualiza perfiles y observaciones en IndexedDB.
 *
 * Reglas de perfiles (ver propuesta): clave por id de usuario ('u:<rest_id>'); el handle puede cambiar sin perder el perfil
 * (se guarda el historial); si un handle ya registrado llega con un id distinto se marca `flags.reassignedFrom` en el nuevo
 * perfil y `flags.handleLostTo` en el anterior. No se hace ninguna petición a X: solo se guarda lo que el navegador ya recibió.
 *
 * Retención: el texto normalizado se conserva `textDays` días y después solo queda su huella (SHA-256 truncado);
 * las observaciones se borran pasados `maxDays` días o si hay más de `maxObs`, salvo las ancladas a un expediente (almacén `evidence`).
 */
(function (root) {
    'use strict';
    const XAF = (root.XAF = root.XAF || {});
    const DAY = 86400000;
    const MAX_BATCH = 500;

    // Una sola escritora a la vez.
    let queue = Promise.resolve();
    const exclusive = fn => { const p = queue.then(fn); queue = p.catch(() => { }); return p; };

    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    function newProfile(id, now) {
        return {
            uid: 'u:' + id, restId: id, handle: '', handleHistory: [], displayName: '', bio: '', metrics: null, flags: {},
            firstSeen: now, lastSeen: now, seenCount: 0, schema: 1, rev: 0, updatedAt: now
        };
    }

    async function ingestBatch(batch, now = Date.now()) {
        const recs = (Array.isArray(batch) ? batch : []).slice(0, MAX_BATCH).map(r => XAF.toRecord(r, now)).filter(Boolean);
        if (!recs.length) return { obs: 0, profiles: 0 };
        // Las huellas se calculan antes de abrir la transacción (una espera ajena la cerraría).
        // (SHA-256 truncado para reconocer textos idénticos; SimHash para casi idénticos; longitud y palabras para el mínimo del radar.)
        await Promise.all(recs.map(async r => {
            if (!r.textFull) return;
            r.th = (await XAF.sha256Hex(r.textFull)).slice(0, 32);
            r.sh = XAF.simhash(r.textFull);
            Object.assign(r, XAF.textStats(r.textFull));
        }));

        let profilesTouched = 0;
        await XAF.db.tx(['profiles', 'handles', 'obs'], 'readwrite', async s => {
            const cache = new Map();   // uid -> perfil
            const dirty = new Set();
            const handleCache = new Map();

            const getProfile = async uid => {
                if (cache.has(uid)) return cache.get(uid);
                const p = (await XAF.db.reqP(s.profiles.get(uid))) || null;
                cache.set(uid, p);
                return p;
            };
            const getHandle = async h => {
                if (handleCache.has(h)) return handleCache.get(h);
                const v = (await XAF.db.reqP(s.handles.get(h))) || null;
                handleCache.set(h, v);
                return v;
            };

            /** Actualiza (o crea) el perfil de un usuario observado y devuelve su uid ('u:<id>' o 'h:<handle>' si no hay id). */
            const upsertUser = async (u, seenAt) => {
                if (!u) return null;
                const lower = u.h ? u.h.toLowerCase() : null;
                if (!u.id) return lower ? ((await getHandle(lower))?.uid || 'h:' + lower) : null;
                const uid = 'u:' + u.id;
                let p = await getProfile(uid);
                const isNew = !p;
                if (isNew) p = newProfile(u.id, now);
                let structural = isNew;

                if (lower) {
                    const current = p.handle.toLowerCase();
                    const entry = p.handleHistory.find(e => e.h.toLowerCase() === lower);
                    if (entry) { entry.last = seenAt; } else { p.handleHistory.push({ h: u.h, first: seenAt, last: seenAt }); structural = true; }
                    if (current !== lower) { p.handle = u.h; structural = true; }
                    const hr = await getHandle(lower);
                    if (hr && hr.uid !== uid) {
                        // El handle ya pertenecía a otro perfil: posible reasignación (no se hereda nada).
                        if (p.flags.reassignedFrom !== hr.uid) { p.flags.reassignedFrom = hr.uid; structural = true; }
                        const old = hr.uid.startsWith('u:') ? await getProfile(hr.uid) : null;
                        if (old && old.handle.toLowerCase() === lower && old.flags.handleLostTo !== uid) { old.flags.handleLostTo = uid; old.updatedAt = now; dirty.add(old.uid); }
                    }
                    const rec = { handle: lower, uid, first: hr && hr.uid === uid ? hr.first : seenAt, last: seenAt };
                    handleCache.set(lower, rec);
                    s.handles.put(rec);
                }
                if (u.n !== undefined && u.n !== p.displayName) { p.displayName = u.n; structural = true; }
                if (u.b !== undefined && u.b !== p.bio) { p.bio = u.b; structural = true; }
                if (u.f !== undefined || u.g !== undefined || u.p !== undefined) {
                    p.metrics = { followers: u.f ?? p.metrics?.followers ?? null, following: u.g ?? p.metrics?.following ?? null, posts: u.p ?? p.metrics?.posts ?? null, at: seenAt };
                }
                const flags = { ...p.flags };
                if (u.bl !== undefined) flags.blue = u.bl;
                if (u.pl !== undefined) flags.parodyLabel = u.pl;
                if (u.pr !== undefined) flags.protected = u.pr;
                if (!same(flags, p.flags)) { p.flags = flags; structural = true; }
                if (u.cr !== undefined && p.accountCreated !== u.cr) p.accountCreated = u.cr;

                p.lastSeen = Math.max(p.lastSeen, seenAt);
                p.seenCount++;
                p.updatedAt = now;
                if (structural) p.rev++;
                cache.set(uid, p);
                dirty.add(uid);
                return uid;
            };

            for (const r of recs) {
                const authorUid = await upsertUser(r.author, r.seenAt);
                const targetAuthorUid = r.tau ? await upsertUser(r.tau, r.seenAt) : undefined;
                if (!authorUid) continue;
                const obsId = `${r.tweetId}:${r.kind}`;
                const prev = await XAF.db.reqP(s.obs.get(obsId));
                const rec = {
                    obsId, tweetId: r.tweetId, kind: r.kind, authorUid, t: r.t ?? prev?.t ?? null, seenAt: now, firstSeen: prev?.firstSeen ?? now,
                    targetId: r.targetId ?? null, targetAuthorUid: targetAuthorUid ?? null, replyTo: r.replyTo ?? null, convId: r.convId ?? prev?.convId ?? null,
                    textNorm: r.textNorm ?? prev?.textNorm ?? null, th: r.th ?? prev?.th ?? null, sh: r.sh ?? prev?.sh ?? null, tl: r.tl ?? prev?.tl ?? null, tw: r.tw ?? prev?.tw ?? null,
                    urls: r.urls, tags: r.tags, mentions: r.mentions, media: r.media, lang: r.lang ?? prev?.lang ?? null,
                    rel: [...new Set([...(prev?.rel || []), ...(r.rel || [])])], counts: r.counts ?? prev?.counts ?? null, counts0: prev?.counts0 ?? prev?.counts ?? r.counts ?? null, src: r.src ?? prev?.src ?? null, ctx: r.ctx
                };
                s.obs.put(rec);
            }
            for (const uid of dirty) s.profiles.put(cache.get(uid));
            profilesTouched = dirty.size;
        });
        return { obs: recs.length, profiles: profilesTouched };
    }

    /** Resumen del registro para la interfaz. */
    async function stats() {
        const [profiles, obs] = await Promise.all([XAF.db.count('profiles'), XAF.db.count('obs')]);
        const range = await XAF.db.tx('obs', 'readonly', async s => {
            const first = await XAF.db.reqP(s.obs.index('seenAt').openCursor(null, 'next'));
            const last = await XAF.db.reqP(s.obs.index('seenAt').openCursor(null, 'prev'));
            return { oldest: first ? first.value.seenAt : null, newest: last ? last.value.seenAt : null };
        });
        return { profiles, obs, ...range };
    }

    /**
     * Retención. 1) Quita el texto de lo visto hace más de `textDays` días (queda la huella). 2) Borra lo visto hace más de
     * `maxDays` días y, si aún hay más de `maxObs`, lo más antiguo. Nada anclado a un expediente se borra ni pierde su texto.
     */
    async function purge({ textDays = 14, maxDays = 180, maxObs = 200000 } = {}, now = Date.now()) {
        const out = { textStripped: 0, deleted: 0 };
        const anchored = async (s, obsId) => (await XAF.db.reqP(s.evidence.index('obsId').count(obsId))) > 0;
        await XAF.db.tx(['obs', 'evidence'], 'readwrite', async s => {
            const textCut = now - Math.max(1, textDays) * DAY;
            const delCut = now - Math.max(1, maxDays) * DAY;
            let total = await XAF.db.reqP(s.obs.count());
            let cur = await XAF.db.reqP(s.obs.index('seenAt').openCursor(null, 'next'));
            while (cur) {
                const v = cur.value;
                if (v.seenAt >= textCut && total <= maxObs) break;       // el resto es más reciente y cabe: nada más que hacer
                const keep = await anchored(s, v.obsId);
                if (!keep && (v.seenAt < delCut || total > maxObs)) { cur.delete(); out.deleted++; total--; }
                else if (!keep && v.seenAt < textCut && v.textNorm) { v.textNorm = null; cur.update(v); out.textStripped++; }
                cur = await XAF.db.advance(cur);
            }
        });
        return out;
    }

    /**
     * Segundo anillo: cuentas externas (que no son de las listas) con 3 o más interacciones directas con ellas (responden, repostean o citan).
     * Se recalcula desde el registro, así que al caducar las observaciones dejan de vigilarse solas. Máximo 300, las más activas primero.
     */
    async function computeWatch({ min = 3, cap = 300 } = {}) {
        const direct = new Map(), listed = new Set();
        await XAF.db.tx('obs', 'readonly', async s => {
            let cur = await XAF.db.reqP(s.obs.openCursor());
            while (cur) {
                const v = cur.value, rel = v.rel || [];
                if (rel.includes('a')) listed.add(v.authorUid);
                else if (rel.some(c => c === 'p' || c === 'r' || c === 'q')) direct.set(v.authorUid, (direct.get(v.authorUid) || 0) + 1);
                cur = await XAF.db.advance(cur);
            }
        });
        const ids = [...direct.entries()].filter(([u, n]) => n >= min && !listed.has(u) && /^u:\d+$/.test(u)).sort((a, b) => b[1] - a[1]).slice(0, cap).map(([u]) => u.slice(2));
        return ids;
    }

    const clear = () => exclusive(() => XAF.db.clearAll());

    XAF.ingest = { exclusive, ingestBatch: (b, now) => exclusive(() => ingestBatch(b, now)), stats, purge: (o, now) => exclusive(() => purge(o, now)), computeWatch: o => exclusive(() => computeWatch(o)), clear };
})(typeof globalThis !== 'undefined' ? globalThis : this);
