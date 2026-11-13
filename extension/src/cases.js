/**
 * Expedientes: documentar un caso con evidencia que se conserva y se puede verificar. Dos partes:
 *   1. Funciones PURAS (probadas en Node): crear el expediente, anclar evidencia, paquete JSON con huella de integridad e informe HTML.
 *   2. Operaciones sobre IndexedDB (solo donde existe `XAF.db`, es decir, en el service worker).
 *
 * Tres capas que nunca se mezclan (y que el informe etiqueta):
 *   A · Observaciones: hechos de la muestra (identificador de la publicación, hora, huella del texto…).
 *   B · Indicadores: lo que calcula el radar a partir de A, con sus parámetros y su versión.
 *   C · Notas del analista: lo que escribe una persona (hipótesis, relaciones con eventos externos…). Nunca se genera sola.
 * Lo anclado a un expediente (almacén `evidence`) NO se borra con la retención del registro.
 * Por defecto las cuentas salen seudonimizadas (una clave estable por expediente); los usuarios solo se incluyen si se pide.
 */
(function (root, factory) {
    const api = factory(root.XAF || (typeof require === 'function' ? require('./matcher.js') : {}), root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.XAF = Object.assign(root.XAF || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M, root) {
    'use strict';

    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const STATUS = ['abierto', 'cerrado'];
    const EXT_KINDS = ['político', 'judicial', 'electoral', 'noticia', 'declaración', 'otro'];
    const NOTICE = 'Patrón observado en una muestra parcial de lo que el navegador recibió; no establece la identidad de nadie, cuántas personas hay detrás de las cuentas, si hubo pago ni cuál fue la intención.';

    /** JSON canónico (claves ordenadas): la misma información da siempre el mismo texto y la misma huella. */
    function canonicalJson(v) {
        if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
        if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
        return JSON.stringify(v === undefined ? null : v);
    }

    function newId() {
        const c = root.crypto;
        if (c && c.randomUUID) return c.randomUUID();
        return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }

    function newCase({ title, question } = {}, now = Date.now()) {
        return { caseId: newId(), title: str(title, 120) || 'Expediente sin título', question: str(question, 600), status: 'abierto', createdAt: now, updatedAt: now, notes: '', events: [], external: [] };
    }

    /** Campos editables de un expediente (todo lo demás se ignora). */
    function sanitizeCasePatch(p = {}) {
        const out = {};
        if ('title' in p) out.title = str(p.title, 120) || 'Expediente sin título';
        if ('question' in p) out.question = str(p.question, 600);
        if ('notes' in p) out.notes = str(p.notes, 8000);
        if ('status' in p && STATUS.includes(p.status)) out.status = p.status;
        return out;
    }

    /** Evento externo (fecha, descripción, tipo y fuente): lo introduce una persona. */
    function sanitizeExternal(e, now = Date.now()) {
        const at = e && Number.isFinite(e.at) ? e.at : NaN;
        const title = str(e && e.title, 200);
        if (!Number.isFinite(at) || !title) return null;
        let url = str(e && e.url, 500);
        if (url && !/^https?:\/\//i.test(url)) url = '';
        return { id: str(e && e.id, 64) || newId(), at, title, kind: EXT_KINDS.includes(e && e.kind) ? e.kind : 'otro', url, addedAt: now };
    }

    /** Instantánea de un evento del radar para guardarla en el expediente (sin referencias al resto de la muestra). */
    function eventSnapshot(ev, params, version, now = Date.now()) {
        return {
            id: String(ev.id).slice(0, 300), type: ev.type, subtype: ev.subtype || '', label: str(ev.label, 200), n: ev.n, first: ev.first, last: ev.last, spanMs: ev.spanMs,
            indicators: [...ev.indicators], level: ev.level, stability: ev.stability || null, coverage: ev.coverage || null, within: ev.within || null,
            alt: [...(ev.alt || [])], alternatives: ev.alternatives || null, verdict: ev.verdict,
            participants: (ev.participants || []).slice(0, 300).map(p => ({ uid: p.uid, t: p.t, obsId: p.obsId, tweetId: p.tweetId, kind: p.kind })),
            radar: { version, params: params || null }, anchoredAt: now
        };
    }

    /** Evidencia anclada: copia mínima de una observación (sin el texto salvo que se pida un extracto). */
    function evidenceFromObs(o, caseId, { withText = false } = {}, now = Date.now()) {
        return {
            evId: caseId + ':' + o.obsId, caseId, obsId: o.obsId, tweetId: o.tweetId, uid: o.authorUid, kind: o.kind, t: o.t ?? null,
            th: o.th || null, sh: o.sh || null, urls: o.urls || [], tags: o.tags || [], counts: o.counts || null, ctx: o.ctx || {},
            ...(withText && o.textNorm ? { excerpt: String(o.textNorm).slice(0, 280) } : {}), anchoredAt: now
        };
    }

    /** Clave estable y no reversible de una cuenta DENTRO de un expediente (no sirve para cruzar expedientes). */
    function pseudonym(uid, caseId) {
        let h = 0x811c9dc5;
        const s = caseId + '|' + uid;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
        return 'C-' + (h >>> 0).toString(16).padStart(8, '0');
    }

    /**
     * Paquete del expediente: capas A/B/C separadas, parámetros del radar y huella SHA-256 de todo el contenido.
     * `handles`: { uid: usuario } solo se usa con `includeHandles`.
     */
    async function buildPackage({ case: c, evidence, handles = {}, includeHandles = false, version = '', radarVersion = '' }, now = Date.now()) {
        const acc = u => pseudonym(u, c.caseId);
        const accounts = {};
        const mapAcc = uid => { const k = acc(uid); if (includeHandles && handles[uid]) accounts[k] = handles[uid]; return k; };
        const body = {
            layers: { A: 'Observaciones: hechos de la muestra', B: 'Indicadores: calculados por el radar a partir de A', C: 'Notas del analista: escritas por una persona' },
            case: {
                caseId: c.caseId, title: c.title, question: c.question, status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt,
                notes: c.notes,
                events: c.events.map(e => ({ ...e, participants: e.participants.map(p => ({ account: mapAcc(p.uid), t: p.t, tweetId: p.tweetId, kind: p.kind })) })),
                external: c.external
            },
            evidence: evidence.map(e => { const { uid, caseId, ...rest } = e; return { ...rest, account: mapAcc(uid) }; }).sort((a, b) => (a.t ?? 0) - (b.t ?? 0) || (a.evId < b.evId ? -1 : 1)),
            accounts, notice: NOTICE
        };
        const sha256 = await M.sha256Hex(canonicalJson(body));
        return { kind: 'matatigre-case', schema: 1, exportedAt: now, software: version, radarVersion, includesHandles: !!includeHandles, ...body, integrity: { algorithm: 'SHA-256', sha256, covers: 'layers, case, evidence, accounts, notice' } };
    }

    /** Comprueba la huella de un paquete exportado. */
    async function verifyPackage(pkg) {
        if (!pkg || pkg.kind !== 'matatigre-case' || !pkg.integrity) return false;
        const { layers, case: c, evidence, accounts, notice } = pkg;
        return (await M.sha256Hex(canonicalJson({ layers, case: c, evidence, accounts, notice }))) === pkg.integrity.sha256;
    }

    const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const fmtT = t => (Number.isFinite(t) ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '–');
    const fmtSpan = ms => (ms < 1000 ? '< 1 s' : ms < 60000 ? Math.round(ms / 1000) + ' s' : ms < 3600000 ? Math.round(ms / 60000) + ' min' : (ms / 3600000).toFixed(1) + ' h');

    /** Informe HTML autocontenido (se imprime o se guarda como PDF desde el navegador). Todo texto se escapa. */
    function buildReport(pkg) {
        const c = pkg.case, ev = pkg.evidence;
        const label = a => (pkg.accounts && pkg.accounts[a] ? '@' + pkg.accounts[a] + ' (' + a + ')' : a);
        const rows = c.events.map(e => `<tr><td>${esc(e.type)}${e.subtype ? ' · ' + esc(e.subtype) : ''}</td><td>${esc(e.label || '—')}</td><td>${e.n}</td><td>${esc(fmtT(e.first))}<br>${esc(fmtSpan(e.spanMs))}</td>
            <td>${esc(e.indicators.join(', ') || '—')}</td><td>${esc(e.level)}</td><td>${e.stability ? esc(e.stability.label + ' (' + e.stability.holds + '/' + e.stability.of + ')') : '—'}</td>
            <td>${e.coverage ? Math.round(e.coverage.ratio * 100) + ' % (' + e.coverage.observed + ' de ' + e.coverage.total + ')' : 'sin estimar'}</td><td>${esc(e.alt.join(', ') || 'ninguna detectada')}</td><td>${esc(e.verdict)}</td></tr>`).join('');
        const timeline = [
            ...c.events.map(e => ({ t: e.first, kind: 'Evento observado (capa B)', text: (e.label || e.type) + ' · ' + e.n + ' cuentas' })),
            ...c.external.map(x => ({ t: x.at, kind: 'Evento externo (capa C)', text: x.title + (x.kind ? ' [' + x.kind + ']' : ''), url: x.url }))
        ].sort((a, b) => a.t - b.t);
        const evRows = ev.map(e => `<tr><td>${esc(label(e.account))}</td><td><a href="https://x.com/i/status/${esc(e.tweetId)}">${esc(e.tweetId)}</a></td><td>${esc(e.kind)}</td><td>${esc(fmtT(e.t))}</td><td>${esc((e.th || '').slice(0, 12))}</td><td>${esc((e.urls || []).join(' '))}${e.excerpt ? '<br><em>' + esc(e.excerpt) + '</em>' : ''}</td></tr>`).join('');
        const from = c.events.length ? Math.min(...c.events.map(e => e.first)) : null, to = c.events.length ? Math.max(...c.events.map(e => e.last)) : null;
        const radarParams = c.events[0] && c.events[0].radar && c.events[0].radar.params;
        return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(c.title)} · informe</title><style>
body{font:14px/1.5 system-ui,"Segoe UI",sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#111}h1{font-size:22px;margin-bottom:2px}h2{font-size:16px;border-bottom:1px solid #ccc;padding-bottom:3px;margin-top:26px}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border:1px solid #d5d5d5;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f3f3f3}.aviso{border:1px solid #b45309;background:#fff7ed;padding:8px 12px;border-radius:6px}
.capa{display:inline-block;font-size:11px;border:1px solid #888;border-radius:4px;padding:0 6px;margin-left:6px;color:#444}.muted{color:#666}pre{white-space:pre-wrap;background:#f6f6f6;padding:8px;border-radius:6px}</style></head><body>
<h1>${esc(c.title)}</h1><div class="muted">Expediente ${esc(c.caseId)} · ${esc(c.status)} · generado ${esc(fmtT(pkg.exportedAt))} · ${esc(pkg.software || 'MATATIGRE')} · radar ${esc(pkg.radarVersion || '')}</div>
<p class="aviso"><strong>Aviso.</strong> ${esc(pkg.notice || NOTICE)} Los resultados dependen de lo que el navegador recibió y de los parámetros indicados.</p>
<h2>1 · Pregunta y alcance</h2><p>${esc(c.question || '(sin pregunta definida)')}</p><p class="muted">Periodo de los eventos anclados: ${esc(fmtT(from))} a ${esc(fmtT(to))}.</p>
<h2>2 · Datos y cobertura</h2><p>${ev.length} observaciones ancladas, ${c.events.length} eventos. Cobertura = reposteros observados / contador de reposts de la publicación original cuando ambos se conocen; en los demás tipos de evento no se puede estimar.${pkg.includesHandles ? '' : ' Las cuentas aparecen seudonimizadas.'}</p>
<h2>3 · Método y parámetros <span class="capa">capa B</span></h2><p>Eventos: texto idéntico o casi idéntico (SimHash de 64 bits, distancia ≤ ${radarParams ? radarParams.nearBits : 6}), misma dirección, mismo conjunto de ≥ 3 hashtags y reposts o citas de una misma publicación. Indicadores: I1 texto idéntico (≥ 3 cuentas en 60 s), I2 casi idéntico (≥ 3 en 10 min), I3 mismo enlace con introducción idéntica, I4 mismo conjunto de hashtags, I5 ≥ 3 reposts/citas del mismo origen en 5 min. Nivel por evento: E0 observación, E1 coincidencia. La estabilidad cuenta en cuántas de 5 ventanas (30 s a 60 min) se mantiene el patrón.</p>
<h2>4 · Hallazgos observados <span class="capa">capa B</span></h2><table><tr><th>Tipo</th><th>Contenido</th><th>Cuentas</th><th>Primera · duración</th><th>Indicadores</th><th>Nivel</th><th>Estabilidad</th><th>Cobertura</th><th>Explicaciones alternativas</th><th>Lectura</th></tr>${rows || '<tr><td colspan="10">Sin eventos anclados.</td></tr>'}</table>
<h2>5 · Línea de tiempo</h2><p class="muted">La cercanía en el tiempo entre un evento externo y un evento observado no prueba una relación causal.</p><table><tr><th>Hora</th><th>Qué</th><th>Descripción</th></tr>${timeline.map(x => `<tr><td>${esc(fmtT(x.t))}</td><td>${esc(x.kind)}</td><td>${esc(x.text)}${x.url ? ' · <a href="' + esc(x.url) + '">fuente</a>' : ''}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}</table>
<h2>6 · Notas del analista <span class="capa">capa C</span></h2><pre>${esc(c.notes || '(sin notas)')}</pre>
<h2>7 · Limitaciones y explicaciones alternativas</h2><ul><li>La muestra es parcial y sesgada por lo que el algoritmo de X mostró al navegador.</li><li>El comportamiento coordinado se mide; la coordinación deliberada, la intención, el pago o la automatización <strong>no son observables</strong> con estos datos.</li><li>Cada hallazgo se contrasta con: fuente común, tendencia general, raíz con mucho alcance, cobertura baja y misma búsqueda o lista. «Comunidad orgánica» no se evalúa todavía.</li><li>Sin significancia estadística ni relaciones entre cuentas: eso exige varios eventos y llega en una fase posterior.</li></ul>
<h2>8 · Anexo de evidencia <span class="capa">capa A</span></h2><table><tr><th>Cuenta</th><th>Publicación</th><th>Tipo</th><th>Hora</th><th>Huella del texto</th><th>Enlaces / extracto</th></tr>${evRows || '<tr><td colspan="6">—</td></tr>'}</table>
<p class="muted">Integridad del paquete (${esc(pkg.integrity ? pkg.integrity.algorithm : '')}): <code>${esc(pkg.integrity ? pkg.integrity.sha256 : '')}</code></p></body></html>`;
    }

    return { CASE_STATUS: STATUS, EXTERNAL_KINDS: EXT_KINDS, CASE_NOTICE: NOTICE, canonicalJson, newCase, sanitizeCasePatch, sanitizeExternal, eventSnapshot, evidenceFromObs, pseudonym, buildPackage, verifyPackage, buildReport };
});

// ---------- operaciones sobre IndexedDB (service worker) ----------
(function (root) {
    'use strict';
    const XAF = root.XAF;
    if (!XAF || !XAF.db) return;
    const { db } = XAF;
    const exclusive = XAF.ingest && XAF.ingest.exclusive ? XAF.ingest.exclusive : fn => fn();
    const version = () => { try { const m = chrome.runtime.getManifest(); return m.name + ' ' + m.version; } catch { return 'MATATIGRE'; } };

    const light = c => ({ caseId: c.caseId, title: c.title, question: c.question, status: c.status, updatedAt: c.updatedAt, createdAt: c.createdAt, events: c.events.length, external: c.external.length });

    async function list() {
        return db.tx('cases', 'readonly', async s => {
            const out = [];
            let cur = await db.reqP(s.cases.openCursor());
            while (cur) { out.push(light(cur.value)); cur = await db.advance(cur); }
            return out.sort((a, b) => b.updatedAt - a.updatedAt);
        });
    }

    async function get(caseId) {
        return db.tx(['cases', 'evidence'], 'readonly', async s => {
            const c = await db.reqP(s.cases.get(caseId));
            if (!c) return null;
            const evidence = await db.reqP(s.evidence.index('caseId').getAll(caseId));
            return { ...c, evidence };
        });
    }

    /** Todos los hechos externos de todos los expedientes (para verlos sobre la curva de las narrativas). */
    async function externals() {
        return db.tx('cases', 'readonly', async s => {
            const out = [];
            let cur = await db.reqP(s.cases.openCursor());
            while (cur) { for (const x of cur.value.external || []) out.push({ ...x, caseId: cur.value.caseId, caseTitle: cur.value.title }); cur = await db.advance(cur); }
            return out.sort((a, b) => a.at - b.at);
        });
    }

    const touch = (s, c, now, action, extra = {}) => { c.updatedAt = now; s.cases.put(c); s.audit.add({ at: now, action: 'case:' + action, caseId: c.caseId, ...extra }); };

    const create = async (data, now = Date.now()) => db.tx(['cases', 'audit'], 'readwrite', async s => {
        const c = XAF.newCase(data, now);
        s.cases.put(c);
        s.audit.add({ at: now, action: 'case:create', caseId: c.caseId });
        return c;
    });

    const update = async (caseId, patch, now = Date.now()) => db.tx(['cases', 'audit'], 'readwrite', async s => {
        const c = await db.reqP(s.cases.get(caseId));
        if (!c) throw new Error('Expediente no encontrado.');
        const clean = XAF.sanitizeCasePatch(patch);
        Object.assign(c, clean);
        touch(s, c, now, 'update', { fields: Object.keys(clean) });
        return c;
    });

    /** Ancla un evento del radar: guarda su instantánea y copia mínima de las observaciones de sus cuentas. */
    const addEvent = async (caseId, event, { withText = false, params = null, radarVersion = '' } = {}, now = Date.now()) => db.tx(['cases', 'evidence', 'obs', 'audit'], 'readwrite', async s => {
        const c = await db.reqP(s.cases.get(caseId));
        if (!c) throw new Error('Expediente no encontrado.');
        const snap = XAF.eventSnapshot(event, params, radarVersion, now);
        c.events = [...c.events.filter(e => e.id !== snap.id), snap];
        let anchored = 0;
        for (const p of snap.participants) {
            const o = await db.reqP(s.obs.get(p.obsId));
            if (!o) continue;
            s.evidence.put(XAF.evidenceFromObs(o, caseId, { withText }, now));
            anchored++;
        }
        touch(s, c, now, 'addEvent', { eventId: snap.id, anchored });
        return { case: c, anchored };
    });

    const removeEvent = async (caseId, eventId, now = Date.now()) => db.tx(['cases', 'evidence', 'audit'], 'readwrite', async s => {
        const c = await db.reqP(s.cases.get(caseId));
        if (!c) throw new Error('Expediente no encontrado.');
        const gone = c.events.find(e => e.id === eventId);
        c.events = c.events.filter(e => e.id !== eventId);
        const keep = new Set(c.events.flatMap(e => e.participants.map(p => p.obsId)));
        for (const p of (gone ? gone.participants : [])) if (!keep.has(p.obsId)) s.evidence.delete(caseId + ':' + p.obsId);
        touch(s, c, now, 'removeEvent', { eventId });
        return c;
    });

    const addExternal = async (caseId, ext, now = Date.now()) => db.tx(['cases', 'audit'], 'readwrite', async s => {
        const c = await db.reqP(s.cases.get(caseId));
        if (!c) throw new Error('Expediente no encontrado.');
        const e = XAF.sanitizeExternal(ext, now);
        if (!e) throw new Error('Evento externo no válido: hacen falta fecha y descripción.');
        c.external = [...c.external.filter(x => x.id !== e.id), e].sort((a, b) => a.at - b.at);
        touch(s, c, now, 'addExternal', { extId: e.id });
        return c;
    });

    const removeExternal = async (caseId, extId, now = Date.now()) => db.tx(['cases', 'audit'], 'readwrite', async s => {
        const c = await db.reqP(s.cases.get(caseId));
        if (!c) throw new Error('Expediente no encontrado.');
        c.external = c.external.filter(x => x.id !== extId);
        touch(s, c, now, 'removeExternal', { extId });
        return c;
    });

    const remove = async (caseId, now = Date.now()) => db.tx(['cases', 'evidence', 'audit'], 'readwrite', async s => {
        const ids = await db.reqP(s.evidence.index('caseId').getAllKeys(caseId));
        for (const k of ids) s.evidence.delete(k);
        s.cases.delete(caseId);
        s.audit.add({ at: now, action: 'case:delete', caseId, evidence: ids.length });
        return { ok: true, evidence: ids.length };
    });

    async function handlesFor(uids) {
        const out = {};
        await db.tx('profiles', 'readonly', async s => { for (const u of uids) { const p = await db.reqP(s.profiles.get(u)); if (p && p.handle) out[u] = p.handle; else if (u.startsWith('h:')) out[u] = u.slice(2); } });
        return out;
    }

    async function exportPackage(caseId, { includeHandles = false } = {}, now = Date.now()) {
        const full = await get(caseId);
        if (!full) throw new Error('Expediente no encontrado.');
        const { evidence, ...c } = full;
        const handles = includeHandles ? await handlesFor([...new Set([...evidence.map(e => e.uid), ...c.events.flatMap(e => e.participants.map(p => p.uid))])]) : {};
        return XAF.buildPackage({ case: c, evidence, handles, includeHandles, version: version(), radarVersion: XAF.RADAR_VERSION }, now);
    }

    XAF.cases = {
        list, get, externals, create: (d, n) => exclusive(() => create(d, n)), update: (i, p, n) => exclusive(() => update(i, p, n)),
        addEvent: (i, e, o, n) => exclusive(() => addEvent(i, e, o, n)), removeEvent: (i, e, n) => exclusive(() => removeEvent(i, e, n)),
        addExternal: (i, e, n) => exclusive(() => addExternal(i, e, n)), removeExternal: (i, e, n) => exclusive(() => removeExternal(i, e, n)),
        remove: (i, n) => exclusive(() => remove(i, n)), exportPackage,
        report: async (i, o, n) => XAF.buildReport(await exportPackage(i, o, n))
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
