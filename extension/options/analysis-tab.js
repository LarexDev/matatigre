/**
 * Pestaña «Análisis»: presenta lo que calcula el worker (src/graph.js y src/radar.js) en seis secciones:
 *   Resumen · Mapa · Narrativas · Temas · Cuentas · Expedientes.
 * Los detalles (hallazgos, cuentas, relaciones, narrativas, eventos) se abren en un panel lateral que no tapa la sección ni la reemplaza.
 * Aquí no se calcula nada de análisis ni se hace ninguna petición de red: solo se lee el registro local (vía el worker) y los expedientes.
 * Lo que se muestra son patrones compatibles con comportamiento coordinado en una muestra parcial: nunca etiqueta a nadie ni afirma intención.
 */
(function (root) {
    'use strict';
    const { el } = root.MTUI;
    const XAF = root.XAF, AnView = root.AnView;
    const $ = id => document.getElementById(id);
    let ctx = null;
    const cfgNow = () => ctx.cfg();
    const askC = msg => chrome.runtime.sendMessage({ type: 'xaf:cases', ...msg }).catch(() => null);

    // ---------- textos y formatos ----------
    const IND = { I1: 'Texto idéntico: ≥ 3 cuentas en 60 s', I2: 'Texto casi idéntico: ≥ 3 cuentas en 10 min', I3: 'Mismo enlace con introducción idéntica', I4: 'Mismo conjunto de ≥ 3 hashtags', I5: '≥ 3 reposts o citas del mismo origen en 5 min' };
    const TYPE_LABEL = { texto: 'Texto', url: 'Enlace', hashtag: 'Hashtags', raiz: 'Reposts' };
    const PERIODS = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: null };
    const LEVEL = { E0: ['Contexto', 'Dato de contexto: no indica coordinación por sí solo'], E1: ['Coincidencia', 'Coinciden en el tiempo o en el contenido, sin que se descarte el azar'], E2: ['Coordinación probable', 'La sincronía es estadísticamente improbable por azar (q < 0,05)'], E3: ['Coordinación sostenida', 'Improbable por azar, repetida en el tiempo, con texto repetido y sin explicación alternativa dominante'] };
    const ROLE_TXT = { lista: 'de tus listas', vigilada: 'externa vigilada', externa: 'externa' };
    const EDGE_TXT = { reply: 'respuestas', quote: 'citas', repost: 'reposts', mention: 'menciones' };
    const SIG = { S1: 'Texto sincronizado', S2: 'Reposts sincronizados', S3: 'Respuestas repetidas al mismo objetivo', S4: 'Amplificación concentrada' };
    const SIG_HELP = { S1: 'Participa en 2 o más eventos de texto idéntico o casi idéntico con algún indicador', S2: 'Participa en 2 o más eventos de reposts de una misma publicación con algún indicador', S3: '5 o más respuestas o citas a una misma cuenta de tus listas', S4: '8 o más interacciones directas con tus listas, 60 % o más a una sola cuenta' };
    const fmtDT = ts => (ts ? new Date(ts).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'medium' }) : '–');
    const fmtSpanMs = ms => (ms < 1000 ? '< 1 s' : ms < 60000 ? Math.round(ms / 1000) + ' s' : ms < 3600000 ? Math.round(ms / 60000) + ' min' : (ms / 3600000).toFixed(1) + ' h');
    const pct = x => Math.round(x * 100) + ' %';
    const num1 = x => (x < 1 && x > 0 ? x.toFixed(2) : String(Math.round(x * 10) / 10)).replace('.', ',');
    const commName = id => (id === undefined || id === null || id < 0 ? 'sin comunidad' : 'C' + (id + 1));
    const dot = id => el('span', { className: 'cdot', style: 'background:' + AnView.colorOf(id) });

    // ---------- estado ----------
    const an = { result: null, graph: null, handles: {}, running: false, openCase: null, externals: [], topics: [], pane: 'summary', showAll: false, mapDirty: true, autorun: false, calibOpen: false };
    let map = null;
    const PANES = ['summary', 'map', 'narr', 'topics', 'accounts', 'cases'];
    const NEEDS_RESULT = new Set(['summary', 'map', 'narr', 'accounts']);

    const anInfo = (t, bad) => { $('anInfo').textContent = t; $('anInfo').style.color = bad ? 'var(--danger)' : ''; };
    const acct = uid => (an.handles[uid] ? '@' + an.handles[uid] : uid);
    const nodeOf = uid => (an.graph ? an.graph.nodes.find(n => n.uid === uid) : null);
    const evById = id => (an.result ? an.result.events.find(e => e.id === id) : null);
    const statusLink = id => el('a', { href: 'https://x.com/i/status/' + id, target: '_blank', rel: 'noopener', textContent: id });
    const links = ids => ids.flatMap((id, i) => [i ? ', ' : '', statusLink(id)]);

    function chip(uid) {
        const n = nodeOf(uid);
        const a = el('a', { href: '#', className: 'chip' + (n && n.role === 'lista' ? ' lista' : ''), textContent: acct(uid), title: n ? ROLE_TXT[n.role] : '' });
        a.addEventListener('click', ev => { ev.preventDefault(); openNode(uid); });
        return a;
    }
    const chips = (uids, max = 14) => el('div', {}, ...uids.slice(0, max).map(chip), uids.length > max ? el('span', { className: 'muted small', textContent: `y ${uids.length - max} más` }) : null);

    // =====================================================================================================================================
    // Navegación entre secciones y panel lateral
    // =====================================================================================================================================
    function showPane(name, { updateHash = true } = {}) {
        if (!PANES.includes(name)) name = 'summary';
        const changed = an.pane !== name;
        an.pane = name;
        for (const b of document.querySelectorAll('#anNav button')) b.setAttribute('aria-selected', String(b.dataset.pane === name));
        const ready = !!an.graph || !NEEDS_RESULT.has(name);
        for (const p of document.querySelectorAll('#tab-analysis .an-pane')) p.hidden = p.dataset.pane !== name || !ready;
        $('anEmpty').hidden = ready;
        if (updateHash && /^#analysis/.test(location.hash)) history.replaceState(null, '', '#analysis/' + name);
        if (changed) { closeDrawer(); if (name !== 'map') setFull(false); }
        if (name === 'map' && ready) requestAnimationFrame(ensureMap);
        if (name === 'cases') loadCases();
        if (name === 'topics') renderTopics();
    }

    const drawer = () => $('anDrawer');
    let drawerOpener = null;
    function openDrawer(...kids) {
        const d = drawer();
        if (d.hidden) drawerOpener = document.activeElement;
        AnView.disposeCharts(d);
        d.replaceChildren(...kids.filter(k => k != null));
        d.hidden = false;
        d.scrollTop = 0;
        d.focus({ preventScroll: true });
    }
    function closeDrawer() {
        const d = drawer();
        if (d.hidden) return;
        AnView.disposeCharts(d);
        d.hidden = true;
        d.replaceChildren();
        if (drawerOpener && drawerOpener.isConnected && typeof drawerOpener.focus === 'function') drawerOpener.focus({ preventScroll: true });
        drawerOpener = null;
    }
    const phead = (title, ...badges) => el('div', { className: 'phead' }, el('strong', { textContent: title }), ...badges, el('span', { className: 'grow' }), el('button', { textContent: '×', ariaLabel: 'Cerrar', title: 'Cerrar (Esc)', onclick: closeDrawer }));
    const levelBadge = lv => el('span', { className: 'lvl ' + lv.toLowerCase(), textContent: LEVEL[lv][0], title: LEVEL[lv][1] });

    // =====================================================================================================================================
    // Análisis (worker)
    // =====================================================================================================================================
    function run() {
        if (an.running) return;
        an.running = true;
        $('anRun').disabled = true;
        anInfo('Analizando…');
        const span = PERIODS[$('anPeriod').value];
        const w = new Worker('../analysis/worker.js');
        const id = Date.now();
        w.onmessage = e => {
            w.terminate();
            an.running = false;
            $('anRun').disabled = false;
            if (!e.data.ok) return anInfo('No se pudo analizar: ' + e.data.error, true);
            an.result = e.data.result;
            an.graph = e.data.graph;
            an.handles = e.data.handles || {};
            const s = an.result.sample;
            anInfo(s.observations ? `${s.observations} publicaciones de ${s.accounts} cuentas (${fmtDT(s.from)} a ${fmtDT(s.to)}).` : 'No hay datos en ese periodo. Activa el registro en Ajustes y navega por X.');
            onResult();
        };
        w.onerror = () => { w.terminate(); an.running = false; $('anRun').disabled = false; anInfo('No se pudo analizar.', true); };
        const lists = {};
        for (const [k, a] of Object.entries(XAF.composeConfig(cfgNow()).accounts)) if (a && (a.tags || []).length) lists[k.toLowerCase()] = a.tags;
        w.postMessage({ id, from: span ? Date.now() - span : null, to: null, lists, topics: an.topics });
    }

    async function onResult() {
        an.mapDirty = true;
        closeDrawer();
        an.externals = await loadExternals();
        renderSummary(); renderMapPane(); renderNarratives(); renderTopics(); renderAccounts();
        showPane(an.pane, { updateHash: false });
    }

    async function loadExternals() {
        const r = await askC({ op: 'externals' });
        return r && r.ok ? r.externals : [];
    }

    // =====================================================================================================================================
    // Resumen
    // =====================================================================================================================================
    function renderSummary() {
        const g = an.graph, gs = g.sample;
        const a = gs.activity;
        if (a) {
            const dias = `${a.days} ${a.days === 1 ? 'día' : 'días'}`;
            $('anSuff').replaceChildren(el('div', { className: 'suff ' + a.level, role: 'status', textContent: a.level === 'suficiente'
                ? `Base amplia: ${num1(a.coveredHours)} h de actividad observada en ${dias}.`
                : a.level === 'parcial' ? `Datos parciales: ${num1(a.coveredHours)} h de actividad observada en ${dias}. Los hallazgos pueden cambiar con más datos.`
                    : `Datos aún escasos: ${num1(a.coveredHours)} h de actividad observada en ${dias}. Los hallazgos son orientativos: sigue navegando por X para reunir más.` }));
        } else $('anSuff').replaceChildren();
        $('anKpi').replaceChildren(...[
            [gs.listed, 'cuentas de tus listas con actividad'], [gs.nodes - gs.listed, 'cuentas externas en la red'], [g.communities.length, 'comunidades'],
            [gs.coordSignificant, `pares con sincronía improbable por azar (de ${gs.coordPairsTested} comprobados)`]
        ].map(([n, t]) => el('div', { className: 'kpi' }, el('b', { textContent: String(n) }), el('span', { textContent: t }))));
        renderFindings();
        renderCalib();
    }

    function renderFindings() {
        const fs = an.graph.findings;
        const shown = an.showAll ? fs : fs.slice(0, 5);
        $('anFindings').replaceChildren(...(fs.length ? [...shown.map(f => el('div', { className: 'fcard ' + f.level.toLowerCase() },
            el('div', { className: 'fhead' }, el('h4', { textContent: f.title }), levelBadge(f.level), f.stability ? el('span', { className: 'badge', textContent: 'estabilidad ' + f.stability }) : null),
            el('p', { textContent: f.summary }),
            chips(f.accounts, 10),
            el('div', { className: 'bar' }, el('button', { textContent: 'Ver pruebas', onclick: () => openFinding(f) }), el('button', { textContent: 'Ver en el mapa', onclick: () => goMap(f.accounts) })))),
            fs.length > 5 ? el('button', { textContent: an.showAll ? 'Mostrar menos' : `Mostrar los ${fs.length - 5} restantes`, onclick: () => { an.showAll = !an.showAll; renderFindings(); } }) : null].filter(Boolean) :
            [el('p', { className: 'muted', textContent: an.graph.sample.nodes ? 'Con los datos reunidos todavía no hay hallazgos que cumplan los criterios. Sigue navegando por X: el análisis mejora con el tiempo.' : 'Aún no hay datos de las cuentas de tus listas en este periodo.' })]));
    }

    /** La prueba de control con los propios datos: mismo detector sobre horas barajadas al azar, que no debería encontrar nada. */
    function renderCalib() {
        const c = an.graph.calibration, host = $('anCalibBody');
        AnView.disposeCharts(host);
        an.calibBuilt = false;
        if (!c || !c.tested) { host.replaceChildren(el('p', { className: 'muted', textContent: 'Todavía no hay pares de cuentas con coincidencias suficientes para comprobar.' })); return; }
        const cr = an.graph.crossCommunity;
        host.replaceChildren(
            el('p', { textContent: `Se comprobaron ${c.tested} pares de cuentas que coinciden en varios eventos; ${c.significant} tienen una sincronía improbable por azar.` }),
            el('p', { textContent: `Prueba de control: se mezclan al azar las horas de cada cuenta (ahí no hay coordinación por construcción) y se pasa el mismo detector ${c.placebo.runs} veces. Resultado: ${c.placebo.significant} pares significativos de ${c.placebo.tested} comprobados. Lo esperable es ninguno o casi ninguno.` }),
            el('div', { className: 'chart', id: 'anHist', style: 'height:190px' }),
            el('p', { className: 'muted small', textContent: 'Valores p de los pares comprobados. Sin señal el reparto sería plano (línea punteada); un exceso a la izquierda indica más sincronía de la que explica el azar.' }),
            cr ? el('p', { className: 'muted small', textContent: `Actividad simultánea entre comunidades: ${cr.eligible} comunidades con picos comparables y ${cr.tested} pares comprobados.` }) : null);
    }
    function buildCalibChart() {
        if (an.calibBuilt || !an.graph || !an.graph.calibration || !$('anHist')) return;
        an.calibBuilt = true;
        AnView.histogram($('anHist'), an.graph.calibration.pHistogram);
    }

    // =====================================================================================================================================
    // Mapa, comunidades y actividad simultánea
    // =====================================================================================================================================
    function renderMapPane() {
        const g = an.graph;
        $('anLegend').replaceChildren(
            el('span', { className: 'legend' }, 'Cada burbuja es una cuenta; su tamaño es la atención que recibe y su color, la comunidad.'),
            el('span', { className: 'legend' }, 'Aro grueso: cuenta de tus listas · aro discontinuo: externa vigilada.'),
            el('span', { className: 'legend', style: 'color:var(--danger)' }, 'Línea roja: sincronía improbable por azar.'),
            el('span', { className: 'legend' }, 'Por defecto solo se dibujan las relaciones más fuertes; señala una cuenta para ver las suyas, o marca «Todas». Arrastra para mover · Ctrl + rueda para acercar.'));
        $('gComms').replaceChildren(...g.communities.map(c => el('button', { type: 'button', className: 'chipbtn commchip', title: 'Resaltar esta comunidad', onclick: () => { if (map) map.highlight(new Set(c.members)); } }, dot(c.id), ' ' + commName(c.id) + ' · ' + c.size)),
            g.communities.length ? el('button', { type: 'button', className: 'link small', textContent: 'Quitar resaltado', onclick: () => { if (map) map.reset(); } }) : null);
        $('gFindList').replaceChildren(...g.nodes.slice(0, 250).map(n => el('option', { value: acct(n.uid) })));
        renderCommunities();
        renderCross();
    }

    function ensureMap() {
        if (!an.graph || $('pane-map').hidden) return;
        if (map && !an.mapDirty) { map.resize(); applyMapFilters(); return; }
        if (map) { map.destroy(); map = null; }
        map = AnView.drawGraph($('anGraph'), $('anTip'), an.graph, { label: acct, onNode: n => openNode(n.uid), onEdge: openEdge, onCommunity: openCommunity });
        an.mapDirty = false;
        applyMapFilters();
        if ($('gMode').value === 'network' && map) map.setMode('network');
    }
    /** Pantalla completa del mapa (Esc para salir). */
    function setFull(on) {
        $('graphWrap').classList.toggle('full', on);
        $('gFull').setAttribute('aria-pressed', String(on));
        $('gFull').title = on ? 'Salir de pantalla completa (Esc)' : 'Pantalla completa (Esc para salir)';
        requestAnimationFrame(() => { if (map) map.resize(); });
    }
    function applyMapFilters() { if (map) map.setFilters({ inter: $('gInter').checked, all: $('gAll').checked, coord: $('gCoord').checked, external: $('gExt').checked }); }
    /** Va al mapa y resalta esas cuentas. */
    function goMap(uids) {
        showPane('map');
        requestAnimationFrame(() => { ensureMap(); if (map) map.highlight(new Set(uids)); });
    }

    function renderCommunities() {
        const cs = an.graph.communities;
        $('anComms').replaceChildren(...(cs.length ? cs.map(c => {
            const lista = c.members.filter(u => { const n = nodeOf(u); return n && n.role === 'lista'; });
            const ordered = [...c.members].sort((a, b) => ((nodeOf(b) || {}).pagerank || 0) - ((nodeOf(a) || {}).pagerank || 0));
            return el('div', { className: 'ccard' },
                el('div', { className: 'fhead' }, dot(c.id), el('strong', { textContent: `Comunidad ${commName(c.id)}` }),
                    el('span', { className: 'muted small', textContent: `${c.size} cuentas (${lista.length} de tus listas) · densidad ${c.density} · estabilidad ${c.stability}` })),
                chips(ordered, 12),
                c.terms && c.terms.length ? el('p', { className: 'small muted', textContent: 'Lo que la distingue: ' + c.terms.map(t => `${t.term} (${t.count} frente a ${t.outside} fuera)`).join(' · ') }) : null,
                el('div', { className: 'bar' }, el('button', { textContent: 'Ver en el mapa', onclick: () => goMap(c.members) })));
        }) : [el('p', { className: 'muted', textContent: 'Aún no hay grupos de cuentas con relaciones suficientes.' })]));
    }

    function renderCross() {
        const cr = an.graph.crossCommunity, host = $('anCross');
        if (!cr || !cr.pairs.length) {
            host.replaceChildren(el('p', { className: 'muted', textContent: cr && cr.note ? cr.note : `Ninguna pareja de comunidades coincide en sus picos de actividad más de lo esperable${cr && cr.tested ? ` (${cr.tested} ${cr.tested === 1 ? 'pareja comprobada' : 'parejas comprobadas'})` : ''}.` }));
            return;
        }
        host.replaceChildren(el('table', {},
            el('thead', {}, el('tr', {}, ...['Comunidades', 'Picos simultáneos', 'Esperados por azar', 'Vocabulario compartido', 'Nivel', ''].map((h, i) => el('th', { textContent: h, className: i && i < 4 ? 'c-n' : '' })))),
            el('tbody', {}, ...cr.pairs.map(p => el('tr', {},
                el('td', {}, dot(p.a), ' ', commName(p.a), ' ↔ ', dot(p.b), ' ', commName(p.b)),
                el('td', { className: 'num', textContent: String(p.coincident) }), el('td', { className: 'num', textContent: num1(p.expected) }),
                el('td', { className: 'num', textContent: p.sharedVocabulary === null ? '–' : pct(p.sharedVocabulary) }),
                el('td', {}, levelBadge(p.level)), el('td', {}, el('button', { textContent: 'Ver', onclick: () => openCross(p) })))))));
    }

    // =====================================================================================================================================
    // Narrativas
    // =====================================================================================================================================
    function renderNarratives() {
        AnView.disposeCharts($('anNarr'));
        const ns = an.graph.narratives;
        const hosts = [];
        $('anNarr').replaceChildren(...(ns.length ? ns.slice(0, 12).map(n => {
            const host = el('div', { className: 'chart', style: 'height:92px' });
            hosts.push([host, n]);
            return el('div', { className: 'ncard' },
                el('div', {}, el('strong', { textContent: n.label || '[texto no conservado]' }),
                    n.keywords && n.keywords.length ? el('div', { className: 'small' }, 'Palabras clave: ', ...n.keywords.map(k => el('span', { className: 'tag', textContent: k }))) : null,
                    el('div', { className: 'muted small', textContent: `${n.accounts} cuentas · ${n.observations} publicaciones · desde ${fmtDT(n.first)} · ${fmtSpanMs(n.spanMs)}` }),
                    el('div', { className: 'small' }, 'Primeras cuentas: ', ...n.origin.slice(0, 3).map(o => chip(o.uid))),
                    el('div', { className: 'small muted', textContent: `Las 5 cuentas más activas generan el ${pct(n.concentration.top5Share)} de las publicaciones` }),
                    el('div', { className: 'bar-h' }, el('i', { style: 'width:' + pct(n.concentration.top5Share) })),
                    el('button', { textContent: 'Ver detalle', onclick: () => openNarrative(n) })),
                host);
        }) : [el('p', { className: 'muted', textContent: 'No hay contenidos compartidos por varias cuentas en este periodo.' })]));
        for (const [host, n] of hosts) AnView.curve(host, n, { compact: true, externals: an.externals });
    }

    // =====================================================================================================================================
    // Temas
    // =====================================================================================================================================
    const cleanWords = text => [...new Set(String(text || '').split(/[,;\n]+/).map(w => w.trim().replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean))].slice(0, 30);
    async function loadTopics() {
        const t = (await chrome.storage.local.get('topics')).topics;
        an.topics = Array.isArray(t) ? t.filter(x => x && typeof x.id === 'string' && typeof x.name === 'string' && Array.isArray(x.words)).slice(0, 20) : [];
    }
    const saveTopics = () => chrome.storage.local.set({ topics: an.topics });

    function renderTopics() {
        const host = $('anTopics');
        AnView.disposeCharts(host);
        const stats = new Map(((an.graph && an.graph.topics) || []).map(t => [t.id, t]));
        if (!an.topics.length) { host.replaceChildren(el('p', { className: 'muted', textContent: 'Aún no has definido ningún tema. Por ejemplo: «Pensiones» con las palabras reforma, pension*, jubilacion.' })); renderShared(); return; }
        const charts = [];
        host.replaceChildren(...an.topics.map(t => {
            const s = stats.get(t.id);
            const card = el('div', { className: 'tcard' });
            const head = el('div', { className: 'fhead' }, el('strong', { textContent: t.name }), ...t.words.slice(0, 8).map(w => el('span', { className: 'tag', textContent: w })), t.words.length > 8 ? el('span', { className: 'muted small', textContent: `y ${t.words.length - 8} más` }) : null,
                el('span', { className: 'grow' }), el('button', { textContent: 'Editar', onclick: () => editTopic(t, card) }),
                el('button', { className: 'danger', textContent: 'Quitar', onclick: async () => { if (!(await root.MTUI.confirm({ title: `Quitar «${t.name}»`, message: 'Se borra la definición del tema; las publicaciones registradas no cambian.', confirm: 'Quitar', danger: true }))) return; an.topics = an.topics.filter(x => x.id !== t.id); await saveTopics(); renderTopics(); } }));
            card.append(head);
            if (!an.graph) card.append(el('p', { className: 'muted small', textContent: 'Pulsa «Analizar» para ver su actividad.' }));
            else if (!s || !s.observations) card.append(el('p', { className: 'muted small', textContent: 'Ninguna publicación registrada en este periodo menciona el tema.' }));
            else {
                const bars = el('div', { className: 'stackbar', role: 'img', ariaLabel: 'Reparto por comunidad' }, ...s.byCommunity.map(c => el('i', { style: `width:${c.share * 100}%;background:${AnView.colorOf(c.id)}`, title: `${commName(c.id)}: ${c.observations} publicaciones de ${c.accounts} cuentas (${pct(c.share)})` })));
                const chartHost = el('div', { className: 'chart', style: 'height:190px' });
                charts.push([chartHost, s]);
                card.append(
                    el('p', { className: 'small', textContent: `${s.observations} publicaciones de ${s.accounts} cuentas · desde ${fmtDT(s.first)} · ${fmtSpanMs(s.spanMs)}${s.syncedPairs ? ` · ${s.syncedPairs} ${s.syncedPairs === 1 ? 'pareja con sincronía significativa' : 'parejas con sincronía significativa'} dentro del tema` : ''}` }),
                    bars,
                    el('div', { className: 'small muted' }, ...s.byCommunity.flatMap(c => [dot(c.id), ` ${commName(c.id)}: ${c.accounts} cuentas (${pct(c.share)})  `])),
                    chartHost,
                    el('div', { className: 'small' }, 'Entran primero: ', ...s.origin.slice(0, 5).map(o => chip(o.uid))),
                    el('div', { className: 'small' }, 'Más publican: ', ...s.top.slice(0, 6).map(o => chip(o.uid))),
                    el('div', { className: 'bar' }, el('button', { textContent: 'Ver en el mapa', onclick: () => goMap(s.top.map(o => o.uid)) })),
                    s.evidence.length ? el('p', { className: 'small muted' }, 'Publicaciones: ', ...links(s.evidence.slice(0, 5))) : null);
            }
            return card;
        }));
        for (const [h, s] of charts) AnView.stacked(h, s, commName);
        renderShared();
    }

    function editTopic(t, card) {
        const name = el('input', { type: 'text', value: t.name, maxLength: 60, ariaLabel: 'Nombre del tema' });
        const words = el('input', { type: 'text', value: t.words.join(', '), maxLength: 400, className: 'grow', ariaLabel: 'Palabras del tema' });
        const form = el('form', { className: 'bar' }, name, words, el('button', { className: 'primary', type: 'submit', textContent: 'Guardar' }), el('button', { type: 'button', textContent: 'Cancelar', onclick: () => renderTopics() }));
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const w = cleanWords(words.value);
            if (!name.value.trim() || !w.length) return;
            t.name = name.value.trim().slice(0, 60); t.words = w;
            await saveTopics();
            toastSay('Tema guardado. Vuelve a analizar para ver su actividad.');
            renderTopics();
        });
        card.replaceChildren(form);
        name.focus();
    }

    function renderShared() {
        const terms = (an.graph && an.graph.sharedTerms) || [];
        $('anShared').replaceChildren(...(terms.length ? [el('div', {}, ...terms.map(t => el('button', {
            className: 'chip chipbtn', type: 'button', title: 'Crear un tema con esta palabra',
            onclick: () => { $('topicName').value = t.term.replace(/^#/, ''); $('topicWords').value = t.term.replace(/^#/, ''); $('topicWords').focus(); }
        }, t.term, el('span', { className: 'muted small', textContent: ' ' + t.communities.map(c => `${commName(c.id)} (${c.accounts})`).join(' · ') }))))]
            : [el('p', { className: 'muted', textContent: an.graph ? 'Ninguna palabra la usan a la vez varias comunidades con suficientes cuentas.' : 'Pulsa «Analizar» para ver qué palabras comparten las comunidades.' })]));
    }

    const toastSay = (t, bad) => root.MTUI.toast(t, { error: !!bad });

    // =====================================================================================================================================
    // Cuentas
    // =====================================================================================================================================
    function renderAccounts() {
        const g = an.graph;
        const cands = g.nodes.filter(n => n.candidate).sort((a, b) => (b.candidate.kind === 'sincronizada') - (a.candidate.kind === 'sincronizada') || b.candidate.interactions - a.candidate.interactions).slice(0, 30);
        $('anCand').replaceChildren(...(cands.length ? cands.map(n => el('tr', {},
            el('td', { className: 'handle', textContent: acct(n.uid) }),
            el('td', {}, el('span', { className: 'badge' + (n.candidate.kind === 'sincronizada' ? ' warn' : ''), textContent: n.candidate.kind, title: n.candidate.kind === 'sincronizada' ? 'Interactúa con tus listas y coincide en el tiempo con otras cuentas más de lo esperable por azar' : 'Interactúa a menudo con tus listas; por sí solo no indica coordinación' })),
            el('td', { className: 'num', textContent: String(n.candidate.interactions) }), el('td', { className: 'num', textContent: String(n.candidate.coordLinks) }),
            el('td', {}, el('button', { textContent: 'Ver', onclick: () => openNode(n.uid) })))) : [el('tr', { className: 'empty-row' }, el('td', { colSpan: 5, className: 'muted', textContent: 'Ninguna cuenta externa interactúa todavía lo bastante con tus listas (3 o más interacciones directas).' }))]));
        $('anNodes').replaceChildren(...g.nodes.slice(0, 30).map(n => el('tr', {},
            el('td', { className: 'handle' }, acct(n.uid), el('span', { className: 'badge', textContent: ROLE_TXT[n.role] }), n.review ? el('span', { className: 'badge warn', textContent: 'revisar', title: 'Cumple varios criterios con sincronía sostenida: conviene revisarla a mano' }) : null),
            el('td', {}, ...(n.community !== undefined && n.community >= 0 ? [dot(n.community), ' ' + commName(n.community)] : ['–'])),
            el('td', { className: 'num', textContent: (n.pagerank * 100).toFixed(1) + ' %' }),
            el('td', { className: 'num', textContent: String(n.inWeight) }), el('td', { className: 'num', textContent: String(n.outWeight) }), el('td', { className: 'num', textContent: String(n.coordLinks) }),
            el('td', {}, ...(n.tags.length ? n.tags.map(t => el('span', { className: 'tag', textContent: t })) : [el('span', { className: 'muted', textContent: '—' })])),
            el('td', {}, el('button', { textContent: 'Ver', onclick: () => openNode(n.uid) })))));
        const ls = g.listCompare || [];
        const name = id => { const s = cfgNow().subs.find(x => x.id === id); return s && s.name ? s.name : (cfgNow().myLists[id] ? cfgNow().myLists[id].name : id); };
        $('anLists').replaceChildren(...(ls.length ? ls.map(l => el('tr', {}, el('td', { textContent: name(l.list) }), el('td', { className: 'num', textContent: String(l.accounts) }), el('td', { className: 'num', textContent: String(l.inSync) }), el('td', { className: 'num', textContent: pct(l.syncShare) }), el('td', { className: 'num', textContent: String(l.perAccount) })))
            : [el('tr', {}, el('td', { colSpan: 5, className: 'muted', textContent: 'Aún no hay cuentas de tus listas con actividad registrada.' }))]));
        renderRadar();
    }

    function renderRadar() {
        const r = an.result;
        renderAccountTables();
        const only = $('anFilter').value === 'e1';
        const events = r.events.filter(e => !only || e.level === 'E1');
        $('anRows').replaceChildren(...(events.length ? events.map(e => el('tr', { className: e.level === 'E1' ? '' : 'off' },
            el('td', { textContent: TYPE_LABEL[e.type] + (e.subtype ? ' · ' + e.subtype : '') }),
            el('td', {}, el('div', { textContent: e.label || '[texto no conservado]' })),
            el('td', { className: 'num', textContent: String(e.n) }),
            el('td', {}, fmtDT(e.first), el('div', { className: 'note', textContent: 'duración ' + fmtSpanMs(e.spanMs) })),
            el('td', {}, ...e.indicators.map(i => el('span', { className: 'tag', textContent: i, title: IND[i] })), e.indicators.length ? null : el('span', { className: 'muted', textContent: '—' })),
            el('td', { textContent: e.level === 'E1' ? 'Coincidencia' : 'Observación', title: e.level === 'E1' ? 'Se cumple algún indicador' : 'Comparten un rasgo, sin indicador' }),
            el('td', { className: e.level === 'E1' && !e.alt.length && !(e.alternatives.coberturaBaja) ? '' : 'muted', textContent: e.verdict }),
            el('td', {}, el('button', { textContent: 'Ver', onclick: () => openEvent(e) })))) : [el('tr', {}, el('td', { colSpan: 8, className: 'muted', textContent: r.sample.observations ? 'No se encontraron eventos con estos criterios.' : '' }))]));
    }

    function renderAccountTables() {
        const r = an.result;
        const accRows = r ? r.accounts : [], intRows = r ? r.interactors : [];
        $('anAccWrap').hidden = !accRows.length;
        $('anAcc').replaceChildren(...accRows.map(a => el('tr', {},
            el('td', { className: 'handle' }, acct(a.uid), a.listed ? el('span', { className: 'badge', textContent: 'en una lista' }) : null),
            el('td', {}, ...a.signals.map(s => el('span', { className: 'tag', textContent: SIG[s.id], title: SIG_HELP[s.id] }))),
            el('td', { className: 'num', textContent: String(a.direct) }),
            el('td', { className: 'num', textContent: a.topTarget ? Math.round(a.topShare * 100) + ' % a ' + acct(a.topTarget) : '–' }),
            el('td', {}, el('button', { textContent: 'Ver', onclick: () => openAccount(a) })))));
        $('anIntWrap').hidden = !intRows.length;
        $('anInt').replaceChildren(...intRows.map(a => el('tr', {},
            el('td', { className: 'handle', textContent: acct(a.uid) }),
            el('td', { className: 'num', textContent: String(a.direct) }),
            el('td', { className: 'num', textContent: String(a.targets) }),
            el('td', { className: 'num', textContent: a.topTarget ? Math.round(a.topShare * 100) + ' % a ' + acct(a.topTarget) : '–' }),
            el('td', {}, el('button', { textContent: 'Ver', onclick: () => openAccount({ ...a, signals: [] }) })))));
    }

    // =====================================================================================================================================
    // Panel lateral de detalle
    // =====================================================================================================================================
    const kvTable = rows => el('table', {}, el('tbody', {}, ...rows.map(([k, v]) => el('tr', {}, el('td', { textContent: k }), el('td', { className: 'num', textContent: String(v) })))));

    /** Anclar eventos del análisis a un expediente (conservan la evidencia aunque caduque el registro). */
    function anchorBar(eventIds, defaultTitle) {
        const run = async () => {
            let caseId = sel.value;
            if (caseId === '__new') {
                const title = await root.MTUI.prompt({ title: 'Nuevo expediente', label: 'Título', value: defaultTitle.slice(0, 60), confirm: 'Crear', maxLength: 120, validate: v => (v ? '' : 'Escribe un título.') });
                if (title === null) return;
                const c = await askC({ op: 'create', data: { title } });
                if (!c || !c.ok) return anInfo('No se pudo crear el expediente.', true);
                caseId = c.case.caseId;
            }
            let n = 0;
            for (const id of eventIds) { const e = evById(id); if (!e) continue; const r = await askC({ op: 'addEvent', caseId, event: e, opts: { withText: false, params: an.result.params, radarVersion: an.result.version } }); if (r && r.ok) n += r.anchored; }
            anInfo(n ? `Anclado: ${n} observaciones guardadas en el expediente.` : 'No se pudo anclar.', !n);
            loadCases();
        };
        const sel = el('select', { ariaLabel: 'Expediente' }, el('option', { value: '__new', textContent: 'Nuevo expediente…' }));
        const bar = el('div', { className: 'bar' }, sel, el('button', { className: 'primary', textContent: 'Anclar a un expediente', onclick: run }));
        caseOptions().then(cs => { for (const c of [...cs].reverse()) sel.insertBefore(el('option', { value: c.caseId, textContent: c.title }), sel.firstChild); if (cs.length) sel.value = cs[0].caseId; });
        return bar;
    }
    async function caseOptions() {
        const r = await askC({ op: 'list' });
        return (r && r.ok ? r.cases : []).filter(c => c.status === 'abierto');
    }

    function openFinding(f) {
        const alts = f.alternatives.length ? f.alternatives : [];
        const pr = f.kind === 'cruce' ? (an.graph.crossCommunity.pairs || []).find(p => f.id === `F-cruce-${p.a}-${p.b}`) : null;
        openDrawer(
            phead(f.title, levelBadge(f.level)),
            el('p', { textContent: f.summary }),
            el('h4', { textContent: 'Por qué el sistema llegó a esta conclusión' }), el('table', {}, el('tbody', {}, ...f.criteria.map(c => el('tr', {}, el('td', { textContent: c.label }), el('td', { className: 'num', textContent: c.value }))))),
            el('h4', { textContent: 'Explicaciones alternativas' }),
            el('ul', { className: 'pinfo' }, ...(alts.length ? alts.map(a => el('li', { textContent: a })) : [el('li', { textContent: 'Ninguna de las que el sistema evalúa (fuente común, tendencia general, publicación con mucho alcance, misma búsqueda o lista).' })])),
            el('p', { className: 'muted small', textContent: 'Estabilidad: ' + (f.stability || '–') + '. El resultado depende de que la muestra cubra solo parte de lo que ocurre en X.' }),
            pr ? crossBins(pr) : null,
            el('h4', { textContent: 'Cuentas' }), chips(f.accounts, 40),
            f.evidence.length ? el('div', {}, el('h4', { textContent: 'Publicaciones de evidencia' }), el('p', { className: 'small' }, ...links(f.evidence))) : null,
            el('p', { className: 'muted small', textContent: 'Es un patrón compatible con comportamiento coordinado observado en una muestra parcial. No dice quién hay detrás, cuántas personas son ni con qué intención.' }),
            f.events && f.events.length ? anchorBar(f.events, f.title) : null,
            el('div', { className: 'bar' }, el('button', { textContent: 'Ver en el mapa', onclick: () => goMap(f.accounts) })));
    }

    /** Franjas en las que dos comunidades se activaron a la vez, con lo que decía cada una. */
    function crossBins(p) {
        return el('div', {}, el('h4', { textContent: 'Franjas en las que coinciden' }),
            el('table', {}, el('thead', {}, el('tr', {}, ...['Hora', `${commName(p.a)}: cuentas y palabras`, `${commName(p.b)}: cuentas y palabras`].map(h => el('th', { textContent: h })))),
                el('tbody', {}, ...p.bins.map(b => el('tr', {}, el('td', { textContent: fmtDT(b.t) }),
                    el('td', {}, `${b.a.accounts} cuentas · ${b.a.terms.join(', ') || '—'}`, b.a.evidence.length ? el('div', { className: 'small' }, ...links(b.a.evidence)) : null),
                    el('td', {}, `${b.b.accounts} cuentas · ${b.b.terms.join(', ') || '—'}`, b.b.evidence.length ? el('div', { className: 'small' }, ...links(b.b.evidence)) : null))))));
    }

    function openCross(p) {
        const f = an.graph.findings.find(x => x.id === `F-cruce-${p.a}-${p.b}`);
        if (f) return openFinding(f);
        openDrawer(phead(`${commName(p.a)} ↔ ${commName(p.b)}`, levelBadge(p.level)),
            el('p', { textContent: `Coinciden ${p.coincident} picos de actividad frente a ≈${num1(p.expected)} esperables por azar.` }), crossBins(p));
    }

    /** Ficha de una comunidad (se abre al pulsar su racimo en el mapa). */
    function openCommunity(id) {
        const c = an.graph.communities.find(x => x.id === id);
        if (!c) return;
        const lista = c.members.filter(u => { const n = nodeOf(u); return n && n.role === 'lista'; });
        const ordered = [...c.members].sort((a, b) => ((nodeOf(b) || {}).pagerank || 0) - ((nodeOf(a) || {}).pagerank || 0));
        openDrawer(
            phead(`Comunidad ${commName(c.id)}`, dot(c.id)),
            el('ul', { className: 'pinfo' },
                el('li', { textContent: `${c.size} cuentas (${lista.length} de tus listas) · densidad ${c.density} · estabilidad ${c.stability}` }),
                c.terms && c.terms.length ? el('li', { textContent: 'Lo que la distingue: ' + c.terms.map(t => `${t.term} (${t.count} frente a ${t.outside} fuera)`).join(' · ') }) : null),
            el('h4', { textContent: 'Cuentas' }), chips(ordered, 80),
            el('div', { className: 'bar' }, el('button', { textContent: 'Resaltar en el mapa', onclick: () => goMap(c.members) })));
    }

    function openNode(uid) {
        const n = nodeOf(uid);
        const handle = (an.handles[uid] || '').replace(/^@/, '');
        if (!n) return openDrawer(phead(acct(uid)), handle ? el('p', {}, el('a', { href: 'https://x.com/' + handle, target: '_blank', rel: 'noopener', textContent: 'Abrir el perfil en X' })) : null);
        const edges = an.graph.edges.filter(e => e.a === uid || e.b === uid).sort((a, b) => b.n - a.n);
        const rows = edges.slice(0, 14).map(e => {
            const other = e.a === uid ? e.b : e.a;
            const what = e.type === 'coord' ? `sincroniza con ${acct(other)} en ${e.n} eventos (${LEVEL[e.level][0].toLowerCase()})` : e.a === uid ? `${EDGE_TXT[e.type]} a ${acct(other)}` : `recibe ${EDGE_TXT[e.type]} de ${acct(other)}`;
            return el('div', { className: 'lrow' }, el('span', { textContent: what }), el('span', { className: 'muted', textContent: e.type === 'coord' ? 'q = ' + String(e.q).replace('.', ',') : e.n + (e.n === 1 ? ' vez' : ' veces') }), el('button', { textContent: 'Ver pruebas', onclick: () => openEdge(e) }));
        });
        openDrawer(
            phead(acct(uid), el('span', { className: 'badge', textContent: ROLE_TXT[n.role] }), n.community !== undefined && n.community >= 0 ? el('span', { className: 'badge', textContent: commName(n.community) }) : null),
            el('ul', { className: 'pinfo' },
                el('li', { textContent: `${n.observations} publicaciones registradas · atención recibida ${(n.pagerank * 100).toFixed(1)} % · ${n.degree} cuentas conectadas` }),
                el('li', { textContent: `Recibe ${n.inWeight} interacciones y emite ${n.outWeight}; sincronía significativa con ${n.coordLinks} cuentas` }),
                n.followers != null ? el('li', { textContent: `${n.followers} seguidores${n.created ? ' · cuenta creada ' + new Date(n.created).toLocaleDateString('es') : ''}` }) : null,
                n.initiator ? el('li', { textContent: `Publica primero en ${n.initiator.first} de ${n.initiator.events} eventos (${pct(n.initiator.share)}; intervalo ${pct(n.initiator.lo)} – ${pct(n.initiator.hi)})${n.medianLagMs != null ? ' · retardo mediano ' + fmtSpanMs(Math.abs(n.medianLagMs)) : ''}` }) : null,
                n.dependence ? el('li', { textContent: `${pct(n.dependence.share)} de sus ${n.dependence.total} interacciones van a ${acct(n.dependence.top)}` }) : null,
                n.tags.length ? el('li', { textContent: 'Papel observado: ' + n.tags.join(', ') }) : null),
            el('h4', { textContent: 'Lista de verificación (sin puntuación)' }),
            ...(n.checklist && n.checklist.length ? [] : [el('p', { className: 'muted small', textContent: 'Sin publicaciones propias registradas: solo se conoce lo que otras cuentas hacen hacia ella.' })]),
            ...(n.checklist || []).map(c => el('div', { className: 'lrow' }, el('span', {}, el('strong', { textContent: c.id + ' ' }), c.label), el('span', { className: c.status === 'cumple' ? '' : 'muted', textContent: c.status.toUpperCase() + ' · ' + c.detail }),
                c.evidence && c.evidence.length ? el('span', { className: 'small' }, ...links(c.evidence.filter(x => /^\d+$/.test(String(x))).slice(0, 3))) : el('span'))),
            n.review ? el('p', { className: 'small', textContent: 'Cumple al menos 3 de los criterios C1–C4 y tiene una pareja con sincronía sostenida: conviene revisarla a mano. C5 y C6 son contexto y no cuentan. La etiqueta, si procede, la pones tú.' }) : null,
            el('h4', { textContent: 'Conexiones principales' }), ...(rows.length ? rows : [el('p', { className: 'muted', textContent: 'Sin conexiones registradas.' })]),
            el('p', { className: 'muted small', textContent: 'Son rasgos observados en una muestra parcial, con los mismos criterios para cualquier cuenta. No prueban que sea una cuenta organizada ni cuál es su intención.' }),
            addControl(uid));
        if (map) map.select(uid);
    }

    function openEdge(e) {
        if (e.type !== 'coord') {
            return openDrawer(phead(`${acct(e.a)} → ${acct(e.b)}`), el('p', { textContent: `${e.n} ${EDGE_TXT[e.type]} registradas.` }), e.evidence && e.evidence.length ? el('p', { className: 'small' }, 'Publicaciones: ', ...links(e.evidence)) : null);
        }
        const evs = e.evidence.map(evById).filter(Boolean);
        const part = (ev, uid) => ev.participants.find(p => p.uid === uid);
        openDrawer(
            phead(`${acct(e.a)} ↔ ${acct(e.b)}`, levelBadge(e.level)),
            el('p', { textContent: `Coinciden en ${e.n} eventos con horas muy próximas${e.expected !== undefined ? ` (por azar se esperarían ≈${num1(e.expected)})` : ''}. Si se desplazan al azar las horas de cada cuenta, una coincidencia así o mayor ocurre con probabilidad p ajustada q = ${String(e.q).replace('.', ',')}.` }),
            el('p', { className: 'small muted', textContent: `Sensibilidad a la ventana: sigue siendo significativa en ${e.holds} de ${e.of} ventanas (la normal, la mitad y el doble).` }),
            el('h4', { textContent: 'Eventos en los que coinciden' }),
            el('table', {}, el('thead', {}, el('tr', {}, ...['Evento', 'Primera cuenta', 'Segunda cuenta', 'Diferencia'].map(h => el('th', { textContent: h })))),
                el('tbody', {}, ...evs.map(ev => { const pa = part(ev, e.a), pb = part(ev, e.b); return el('tr', {}, el('td', { textContent: `${TYPE_LABEL[ev.type]}: ${(ev.label || '').slice(0, 70)}` }), el('td', {}, pa ? el('span', {}, fmtDT(pa.t) + ' · ', statusLink(pa.tweetId)) : '–'), el('td', {}, pb ? el('span', {}, fmtDT(pb.t) + ' · ', statusLink(pb.tweetId)) : '–'), el('td', { textContent: pa && pb ? fmtSpanMs(Math.abs(pa.t - pb.t)) : '–' })); }))),
            el('p', { className: 'muted small', textContent: 'La sincronía entre dos cuentas es un patrón compatible con comportamiento coordinado; también puede deberse a seguir la misma fuente o a una tendencia general.' }),
            el('div', { className: 'bar' }, el('button', { textContent: 'Ver en el mapa', onclick: () => goMap([e.a, e.b]) })));
    }

    function openNarrative(n) {
        const chartHost = el('div', { className: 'chart', style: 'height:250px' });
        const near = an.externals.filter(x => Math.abs(x.at - n.first) <= 24 * 3600000).sort((a, b) => a.at - b.at);
        openDrawer(
            phead('Narrativa'),
            el('p', { textContent: n.label || '[texto no conservado]' }),
            n.keywords && n.keywords.length ? el('p', { className: 'small' }, 'Palabras clave: ', ...n.keywords.map(k => el('span', { className: 'tag', textContent: k }))) : null,
            chartHost,
            el('ul', { className: 'pinfo' },
                el('li', { textContent: `${n.accounts} cuentas · ${n.observations} publicaciones · primera ${fmtDT(n.first)} · duración ${fmtSpanMs(n.spanMs)}` }),
                el('li', { textContent: `${n.onset} cuentas entran en los primeros 5 minutos (línea roja) · ${pct(n.listedShare)} son cuentas de tus listas` }),
                el('li', { textContent: `Concentración: las 5 cuentas más activas generan el ${pct(n.concentration.top5Share)} (Gini ${n.concentration.gini}); sin ellas quedan ${n.concentration.remainingWithout5} cuentas` }),
                n.robust ? el('li', { textContent: `Robustez: sin las 3 cuentas más activas quedan ${n.robust.without3.accounts} cuentas y ${n.robust.without3.observations} publicaciones` }) : null,
                n.hashtags.length ? el('li', { textContent: 'Hashtags: ' + n.hashtags.map(t => '#' + t).join(' ') }) : null,
                n.alt.length ? el('li', { textContent: 'Explicaciones alternativas: ' + n.alt.join(', ') }) : null),
            el('h4', { textContent: 'Hechos externos cerca de la fecha' }),
            ...(near.length ? near.map(x => {
                const lag = n.first - x.at;
                return el('div', { className: 'lrow' }, el('span', { textContent: `${fmtDT(x.at)} · ${x.title} [${x.kind}]` }), el('span', { className: 'muted', textContent: lag >= 0 ? `la narrativa empieza ${fmtSpanMs(lag)} después` : `la narrativa empieza ${fmtSpanMs(-lag)} antes` }), x.url ? el('a', { href: x.url, target: '_blank', rel: 'noopener', textContent: 'fuente' }) : el('span'));
            }) : [el('p', { className: 'muted small', textContent: 'No hay hechos externos anotados cerca de esta fecha.' })]),
            near.length ? el('p', { className: 'muted small', textContent: 'Que una cosa venga después de otra no prueba que la cause: es solo la distancia en el tiempo.' }) : null,
            externalForm(n),
            el('h4', { textContent: 'Cómo se propagó: primeras cuentas en entrar' }),
            el('table', {}, el('thead', {}, el('tr', {}, ...['Cuenta', 'Hora', 'Desde la primera', 'Publicación'].map(h => el('th', { textContent: h })))),
                el('tbody', {}, ...n.participants.slice(0, 15).map(p => el('tr', {}, el('td', {}, chip(p.uid)), el('td', { textContent: fmtDT(p.t) }), el('td', { textContent: '+' + fmtSpanMs(p.t - n.first).replace('< 1 s', '0 s') }), el('td', {}, statusLink(p.tweetId)))))),
            n.communities.length ? el('p', { className: 'small', textContent: 'Comunidades implicadas: ' + n.communities.slice(0, 4).map(c => `${commName(c.id)} (${c.accounts})`).join(', ') }) : null,
            anchorBar(n.events, n.label || 'Narrativa'),
            el('div', { className: 'bar' }, el('button', { textContent: 'Ver en el mapa', onclick: () => goMap(n.participants.map(p => p.uid)) })));
        AnView.curve(chartHost, n, { compact: false, externals: an.externals });
    }

    /** Anotar un hecho externo (una noticia, un fallo, una declaración…) en un expediente para verlo sobre la curva de las narrativas. */
    function externalForm(n) {
        const dt = el('input', { type: 'datetime-local', ariaLabel: 'Fecha y hora del hecho', value: new Date(n.first - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) });
        const title = el('input', { type: 'text', placeholder: 'Qué pasó (hecho externo)', maxLength: 200, className: 'grow', ariaLabel: 'Descripción del hecho' });
        const kind = el('select', { ariaLabel: 'Tipo' }, ...['noticia', 'político', 'judicial', 'electoral', 'declaración', 'otro'].map(k => el('option', { value: k, textContent: k })));
        const url = el('input', { type: 'text', placeholder: 'Fuente (https://…)', maxLength: 500, ariaLabel: 'Fuente' });
        const sel = el('select', { ariaLabel: 'Expediente' }, el('option', { value: '__new', textContent: 'Nuevo expediente…' }));
        caseOptions().then(cs => { for (const c of [...cs].reverse()) sel.insertBefore(el('option', { value: c.caseId, textContent: c.title }), sel.firstChild); if (cs.length) sel.value = cs[0].caseId; });
        const add = el('button', {
            textContent: 'Anotar hecho', onclick: async () => {
                const at = dt.value ? new Date(dt.value).getTime() : NaN;
                if (!Number.isFinite(at) || !title.value.trim()) return toastSay('Pon la fecha y qué pasó.', true);
                let caseId = sel.value;
                if (caseId === '__new') {
                    const t = await root.MTUI.prompt({ title: 'Nuevo expediente', label: 'Título', value: (n.label || 'Narrativa').slice(0, 60), confirm: 'Crear', maxLength: 120, validate: v => (v ? '' : 'Escribe un título.') });
                    if (t === null) return;
                    const c = await askC({ op: 'create', data: { title: t } });
                    if (!c || !c.ok) return toastSay('No se pudo crear el expediente.', true);
                    caseId = c.case.caseId;
                }
                const x = await askC({ op: 'addExternal', caseId, ext: { at, title: title.value, kind: kind.value, url: url.value } });
                if (!x || !x.ok) return toastSay('No se pudo anotar.', true);
                an.externals = await loadExternals();
                renderNarratives();
                loadCases();
                openNarrative(n);
            }
        });
        return el('details', { className: 'extform' }, el('summary', { className: 'small', textContent: 'Anotar un hecho externo' }), el('div', { className: 'bar' }, dt, title, kind), el('div', { className: 'bar' }, url, sel, add));
    }

    /** Añadir la cuenta a una de tus listas (o a una nueva) desde el análisis. */
    function addControl(uid) {
        const handle = (an.handles[uid] || '').replace(/^@/, '');
        const own = () => Object.entries(cfgNow().myLists).sort((a, b) => a[1].name.localeCompare(b[1].name, 'es'));
        const sel = el('select', { ariaLabel: 'Lista de destino' }, ...own().map(([id, m]) => el('option', { value: id, textContent: m.name })), el('option', { value: '__new', textContent: 'Nueva lista…' }));
        if (!own().length) sel.value = '__new';
        const add = el('button', {
            className: 'primary', textContent: 'Añadir a esa lista', disabled: !handle,
            onclick: async () => {
                const c = cfgNow();
                let id = sel.value;
                if (id === '__new') {
                    const name = await root.MTUI.prompt({ title: 'Nueva lista', label: 'Nombre de la lista', value: 'Para revisar', confirm: 'Crear', validate: v => XAF.myLists.checkName(c, v) });
                    if (name === null) return;
                    id = XAF.myLists.create(c, name);
                    await ctx.persist('myLists', 'lists');
                }
                XAF.myLists.addAccounts(c, [handle], [id]);
                await ctx.persist('accounts', 'allowlist', 'disabled');
                toastSay(`@${handle} añadida a «${c.myLists[id].name}».`);
                if (ctx.afterListChange) ctx.afterListChange();
            }
        });
        return el('div', { className: 'bar' }, sel, add, handle ? null : el('span', { className: 'muted small', textContent: 'Sin nombre de usuario conocido todavía.' }));
    }

    async function openEvent(e) {
        const t0 = e.first;
        const part = el('table', {}, el('thead', {}, el('tr', {}, ...['Cuenta', 'Tipo', 'Desde la primera', 'Publicación'].map(h => el('th', { textContent: h })))),
            el('tbody', {}, ...e.participants.map(p => el('tr', {}, el('td', { textContent: acct(p.uid) }), el('td', { textContent: p.kind }), el('td', { textContent: '+' + fmtSpanMs(p.t - t0).replace('< 1 s', '0 s') }), el('td', {}, statusLink(p.tweetId))))));
        const sens = el('table', {}, el('thead', {}, el('tr', {}, el('th', { textContent: 'Ventana' }), el('th', { textContent: 'Cuentas máx.' }), el('th', { textContent: '≥ 3' }))),
            el('tbody', {}, ...Object.entries(e.within).map(([tau, n]) => el('tr', {}, el('td', { textContent: fmtSpanMs(Number(tau)) }), el('td', { className: 'num', textContent: String(n) }), el('td', { textContent: n >= 3 ? '✓' : '·' })))));
        const a = e.alternatives;
        const alts = [
            ['Fuente común (mismo enlace)', a.fuenteComun ? 'posible' : 'no'],
            ['Tendencia general', a.tendencia.z === null ? 'sin datos' : (a.tendencia.flag ? 'posible' : 'no') + ` (z = ${a.tendencia.z})`],
            ['Publicación con mucho alcance', a.raizViral === null ? 'sin datos' : a.raizViral ? 'posible' : 'no'],
            ['Cobertura baja', a.coberturaBaja === null ? 'sin estimar' : a.coberturaBaja ? 'sí: no concluyente' : 'no'],
            ['Misma búsqueda o lista', a.artefactoMuestra ? 'posible' : 'no']
        ];
        const cases = await caseOptions();
        const sel = el('select', { ariaLabel: 'Expediente' }, ...cases.map(c => el('option', { value: c.caseId, textContent: c.title })), el('option', { value: '__new', textContent: 'Nuevo expediente…' }));
        const withText = el('input', { type: 'checkbox' });
        const anchor = el('button', {
            className: 'primary', textContent: 'Anclar a un expediente',
            onclick: async () => {
                let caseId = sel.value;
                if (caseId === '__new') {
                    const title = await root.MTUI.prompt({ title: 'Nuevo expediente', label: 'Título', value: e.label ? e.label.slice(0, 60) : 'Nuevo expediente', confirm: 'Crear', maxLength: 120, validate: v => (v ? '' : 'Escribe un título.') });
                    if (title === null) return;
                    const c = await askC({ op: 'create', data: { title } });
                    if (!c || !c.ok) return anInfo('No se pudo crear el expediente.', true);
                    caseId = c.case.caseId;
                }
                const r = await askC({ op: 'addEvent', caseId, event: e, opts: { withText: withText.checked, params: an.result.params, radarVersion: an.result.version } });
                anInfo(r && r.ok ? `Anclado: ${r.anchored} observaciones guardadas en el expediente.` : 'No se pudo anclar.', !(r && r.ok));
                loadCases();
            }
        });
        openDrawer(
            phead(TYPE_LABEL[e.type] + (e.subtype ? ' · ' + e.subtype : '')),
            el('p', { textContent: e.label || '[texto no conservado]' }),
            el('ul', { className: 'pinfo' },
                el('li', { textContent: `${e.n} cuentas${e.repeats ? ` (y ${e.repeats} repeticiones de las mismas)` : ''} · primera ${fmtDT(e.first)} · duración ${fmtSpanMs(e.spanMs)}` }),
                el('li', { textContent: `Nivel ${e.level}${e.indicators.length ? ' · indicadores ' + e.indicators.join(', ') : ''}${e.stability ? ` · estabilidad ${e.stability.label} (se mantiene en ${e.stability.holds} de ${e.stability.of} ventanas)` : ''}` }),
                el('li', { textContent: e.coverage ? `Cobertura estimada ${Math.round(e.coverage.ratio * 100)} % (${e.coverage.observed} de ${e.coverage.total} reposts)` : 'Cobertura: no se puede estimar en este tipo de evento' }),
                el('li', { textContent: 'Lectura: ' + e.verdict })),
            el('h4', { textContent: 'Cuentas y orden de entrada' }), part,
            el('h4', { textContent: 'Sensibilidad a la ventana' }), sens,
            el('h4', { textContent: 'Explicaciones alternativas' }), el('ul', { className: 'pinfo' }, ...alts.map(([k, v]) => el('li', { textContent: `${k}: ${v}` }))),
            el('p', { className: 'muted small', textContent: 'Patrón observado en una muestra parcial: no dice quién hay detrás, cuántas personas son ni con qué intención.' }),
            el('div', { className: 'bar' }, sel, el('label', { className: 'chk' }, withText, 'Guardar extractos del texto'), anchor));
    }

    function openAccount(a) {
        const evid = a.signals.filter(s => s.evidence && s.evidence.length && s.id === 'S3');
        openDrawer(
            phead(acct(a.uid), a.listed ? el('span', { className: 'badge', textContent: 'en una lista' }) : null),
            el('ul', { className: 'pinfo' },
                el('li', { textContent: `${a.direct} interacciones directas con cuentas de tus listas (respuestas, citas y reposts) y ${a.mentions} menciones, en ${a.observations} registros` }),
                el('li', { textContent: a.topTarget ? `Dirigidas a ${a.targets} ${a.targets === 1 ? 'cuenta' : 'cuentas'}; la principal es ${acct(a.topTarget)} (${Math.round(a.topShare * 100)} %)` : 'Sin interacciones directas registradas' })),
            el('h4', { textContent: 'Señales observadas' }),
            ...(a.signals.length ? a.signals.map(s => el('div', { className: 'lrow' },
                el('strong', { textContent: SIG[s.id] }), el('span', { className: 'muted', textContent: SIG_HELP[s.id] }),
                el('span', { textContent: s.id === 'S1' || s.id === 'S2' ? `${s.n} eventos` : s.id === 'S3' ? `${s.n} respuestas a ${acct(s.target)}` : `${s.n} interacciones, ${Math.round(s.share * 100)} % a ${acct(s.target)}` }))) : [el('p', { className: 'muted', textContent: 'No cumple ninguna señal: solo interactúa bastante con tus listas.' })]),
            ...evid.map(s => el('p', { className: 'small' }, 'Respuestas: ', ...links(s.evidence))),
            el('p', { className: 'muted small', textContent: 'Son señales de un patrón compatible con comportamiento coordinado, con los mismos umbrales para cualquier cuenta. No prueban que sea una cuenta organizada, que haya una sola persona detrás ni cuál es su intención.' }),
            addControl(a.uid));
    }

    // =====================================================================================================================================
    // Expedientes
    // =====================================================================================================================================
    async function loadCases() {
        const r = await askC({ op: 'list' });
        const cases = r && r.ok ? r.cases : [];
        $('caseList').replaceChildren(...(cases.length ? cases.map(c => el('div', { className: 'listcard' },
            el('div', {}, el('strong', { textContent: c.title }), el('span', { className: 'badge', textContent: c.status }), el('p', { className: 'muted small', textContent: `${c.events} eventos · ${c.external} eventos externos · actualizado ${fmtDT(c.updatedAt)}` })),
            el('button', { textContent: 'Abrir', onclick: () => openCase(c.caseId) }))) : [el('p', { className: 'muted', textContent: 'Aún no hay expedientes.' })]));
        if (an.openCase) openCase(an.openCase, true);
    }

    async function openCase(caseId, keepScroll) {
        const r = await askC({ op: 'get', caseId });
        const c = r && r.ok ? r.case : null;
        if (!c) { $('caseView').hidden = true; an.openCase = null; return; }
        an.openCase = caseId;
        const title = el('input', { type: 'text', value: c.title, maxLength: 120, ariaLabel: 'Título' });
        const question = el('input', { type: 'text', value: c.question, maxLength: 600, placeholder: 'Pregunta del caso', ariaLabel: 'Pregunta' });
        const notes = el('textarea', { rows: 5, placeholder: 'Hipótesis, relaciones con eventos externos, dudas…', value: c.notes });
        const save = async patch => { const x = await askC({ op: 'update', caseId, patch }); if (!x || !x.ok) anInfo('No se pudo guardar.', true); loadCases(); };
        const dt = el('input', { type: 'datetime-local', ariaLabel: 'Fecha y hora' });
        const et = el('input', { type: 'text', placeholder: 'Qué pasó (hecho externo)', maxLength: 200, className: 'grow' });
        const ek = el('select', {}, ...['noticia', 'político', 'judicial', 'electoral', 'declaración', 'otro'].map(k => el('option', { value: k, textContent: k })));
        const eu = el('input', { type: 'text', placeholder: 'Fuente (https://…)', maxLength: 500 });
        const handles = el('input', { type: 'checkbox' });
        const dl = (name, text, type) => { const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1500); };
        const refreshExternals = async () => { an.externals = await loadExternals(); if (an.graph) renderNarratives(); };
        $('caseView').replaceChildren(
            el('div', { className: 'phead' }, el('strong', { textContent: 'Expediente' }), el('span', { className: 'badge', textContent: c.status }), el('span', { className: 'grow' }), el('button', { textContent: '×', ariaLabel: 'Cerrar', onclick: () => { $('caseView').hidden = true; an.openCase = null; } })),
            el('div', { className: 'bar' }, title, question, el('button', { textContent: 'Guardar', onclick: () => save({ title: title.value, question: question.value }) })),
            el('h4', { textContent: 'Eventos observados (capa B) y evidencia anclada (capa A)' }),
            ...(c.events.length ? c.events.map(e => el('div', { className: 'lrow' }, el('span', { textContent: `${TYPE_LABEL[e.type]} · ${e.label || e.id}`.slice(0, 90) }), el('span', { className: 'muted', textContent: `${e.n} cuentas · ${e.level} · ${fmtDT(e.first)}` }),
                el('button', { className: 'danger', textContent: 'Quitar', onclick: async () => { await askC({ op: 'removeEvent', caseId, eventId: e.id }); loadCases(); } }))) : [el('p', { className: 'muted', textContent: 'Sin eventos. Ancla uno desde el análisis.' })]),
            el('p', { className: 'muted small', textContent: `${c.evidence.length} observaciones ancladas: no se borran con la retención del registro.` }),
            el('h4', { textContent: 'Eventos externos (los pones tú)' }),
            ...c.external.map(x => el('div', { className: 'lrow' }, el('span', { textContent: fmtDT(x.at) }), el('span', { textContent: `${x.title} [${x.kind}]` }), el('button', { className: 'danger', textContent: 'Quitar', onclick: async () => { await askC({ op: 'removeExternal', caseId, extId: x.id }); await refreshExternals(); loadCases(); } }))),
            el('div', { className: 'bar' }, dt, et, ek, eu, el('button', { textContent: 'Añadir', onclick: async () => {
                const at = dt.value ? new Date(dt.value).getTime() : NaN;
                const x = await askC({ op: 'addExternal', caseId, ext: { at, title: et.value, kind: ek.value, url: eu.value } });
                if (!x || !x.ok) return anInfo('Pon fecha y descripción.', true);
                await refreshExternals();
                loadCases();
            } })),
            el('h4', { textContent: 'Notas del analista (capa C: las escribes tú)' }), notes,
            el('div', { className: 'bar' }, el('button', { textContent: 'Guardar notas', onclick: () => save({ notes: notes.value }) }),
                el('button', { textContent: c.status === 'abierto' ? 'Cerrar expediente' : 'Reabrir', onclick: () => save({ status: c.status === 'abierto' ? 'cerrado' : 'abierto' }) })),
            el('div', { className: 'bar' }, el('label', { className: 'chk' }, handles, 'Incluir los nombres de usuario (si no, las cuentas salen seudonimizadas)'),
                el('button', { className: 'primary', textContent: 'Informe', onclick: async () => { const x = await askC({ op: 'report', caseId, includeHandles: handles.checked }); if (!x || !x.ok) return anInfo('No se pudo generar el informe.', true); window.open(URL.createObjectURL(new Blob([x.html], { type: 'text/html' }))); } }),
                el('button', { textContent: 'Exportar paquete (JSON)', onclick: async () => { const x = await askC({ op: 'export', caseId, includeHandles: handles.checked }); if (!x || !x.ok) return anInfo('No se pudo exportar.', true); dl(`expediente-${caseId.slice(0, 8)}.json`, JSON.stringify(x.data, null, 1), 'application/json'); } }),
                el('span', { className: 'grow' }),
                el('button', { className: 'danger', textContent: 'Borrar expediente', onclick: async () => { if (!(await root.MTUI.confirm({ title: 'Borrar el expediente', message: 'Se borrarán el expediente y su evidencia anclada.', confirm: 'Borrar', danger: true }))) return; await askC({ op: 'remove', caseId }); an.openCase = null; $('caseView').hidden = true; await refreshExternals(); loadCases(); } })));
        $('caseView').hidden = false;
        if (!keepScroll) $('caseView').scrollIntoView({ block: 'nearest' });
    }

    // =====================================================================================================================================
    // Arranque
    // =====================================================================================================================================
    function bind() {
        $('anRun').addEventListener('click', run);
        $('anFilter').addEventListener('input', () => { if (an.result) renderRadar(); });
        for (const id of ['gInter', 'gAll', 'gCoord', 'gExt']) $(id).addEventListener('change', applyMapFilters);
        $('gReset').addEventListener('click', () => { if (map) map.reset(); });
        $('gFull').addEventListener('click', () => setFull(!$('graphWrap').classList.contains('full')));
        $('gFit').addEventListener('click', () => { if (map) map.fit(); });
        $('gZoomIn').addEventListener('click', () => { if (map) map.zoomBy(1.3); });
        $('gZoomOut').addEventListener('click', () => { if (map) map.zoomBy(1 / 1.3); });
        $('gMode').addEventListener('change', () => { if (map) map.setMode($('gMode').value); });
        $('gPng').addEventListener('click', () => { if (!map) return; const a = el('a', { href: map.png(), download: 'mapa-matatigre.png' }); a.click(); });
        const findOnMap = () => {
            if (!map || !$('gFind').value.trim()) return;
            const hit = map.find($('gFind').value);
            if (hit) openNode(hit.uid); else toastSay('No hay ninguna cuenta con ese nombre en el mapa.', true);
        };
        $('gFind').addEventListener('change', findOnMap);
        $('gFind').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findOnMap(); } });
        $('anCalib').addEventListener('toggle', () => { if ($('anCalib').open) buildCalibChart(); });
        $('caseNew').addEventListener('click', async () => {
            const t = $('caseTitle').value.trim();
            if (!t) return;
            const r = await askC({ op: 'create', data: { title: t, question: $('caseQ').value } });
            $('caseTitle').value = $('caseQ').value = '';
            if (r && r.ok) { an.openCase = r.case.caseId; loadCases(); }
        });
        $('topicForm').addEventListener('submit', async e => {
            e.preventDefault();
            const name = $('topicName').value.trim().slice(0, 60), words = cleanWords($('topicWords').value);
            if (!name || !words.length) return;
            if (an.topics.length >= 20) return toastSay('Máximo 20 temas: quita alguno para añadir otro.', true);
            an.topics = [...an.topics, { id: 't' + Date.now().toString(36), name, words }];
            await saveTopics();
            $('topicName').value = $('topicWords').value = '';
            renderTopics();
            toastSay('Tema creado. Pulsa «Analizar» para ver su actividad.');
        });
        $('anNav').addEventListener('click', e => { const b = e.target.closest('button[data-pane]'); if (b) showPane(b.dataset.pane); });
        $('anNav').addEventListener('keydown', e => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const btns = [...document.querySelectorAll('#anNav button')], i = btns.indexOf(document.activeElement);
            if (i < 0) return;
            e.preventDefault();
            e.stopPropagation();
            const next = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
            next.focus(); next.click();
        });
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
            if (!drawer().hidden) closeDrawer(); else if ($('graphWrap').classList.contains('full')) setFull(false);
        });
    }

    root.AnalysisTab = {
        /** `ctx`: { cfg: () => config actual, persist(...claves), afterListChange?() }. */
        async init(c) {
            ctx = c;
            bind();
            await loadTopics();
            renderTopics();
        },
        /** Se llama al mostrar la pestaña: `sub` es la sección pedida en la dirección (#analysis/mapa…). */
        onShow(sub) {
            $('anNoData').hidden = !!cfgNow().settings.observe;
            showPane(PANES.includes(sub) ? sub : an.pane, { updateHash: false });
            if (!an.autorun && !an.result && !an.running) { an.autorun = true; run(); }
        },
        /** Los temas definidos, para la copia de seguridad. */
        async exportTopics() { await loadTopics(); return an.topics; },
        /** Suma temas de una copia de seguridad (los que ya existen con ese nombre no se duplican). Devuelve cuántos añadió. */
        async mergeTopics(list) {
            if (!Array.isArray(list)) return 0;
            await loadTopics();
            let n = 0;
            for (const t of list.slice(0, 20)) {
                const name = String((t && t.name) || '').trim().slice(0, 60), words = cleanWords(Array.isArray(t && t.words) ? t.words.join(',') : '');
                if (!name || !words.length || an.topics.length >= 20 || an.topics.some(x => x.name.toLowerCase() === name.toLowerCase())) continue;
                an.topics.push({ id: 't' + Date.now().toString(36) + n, name, words });
                n++;
            }
            if (n) { await saveTopics(); renderTopics(); }
            return n;
        },
        /** Para las pruebas: estado interno y el mapa. */
        debug: () => ({ an, map })
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
