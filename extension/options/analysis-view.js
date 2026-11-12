/**
 * Visualización del análisis. Solo dibuja lo que ya calculó el worker: no hace cálculos de análisis ni peticiones.
 *   · drawGraph: mapa de burbujas con Cytoscape.js (racimos por comunidad, resaltado de vecinos, filtros, búsqueda, imagen).
 *   · curve / stacked / histogram: gráficos con Apache ECharts (propagación de una narrativa con hechos externos, actividad por tema y
 *     comunidad, distribución de valores p).
 * Ambas librerías van incluidas en la extensión (vendor/): no se carga nada de internet. Los colores salen de las variables de la hoja de
 * estilos, así que el mapa y los gráficos siguen el tema claro/oscuro, también si se cambia con la página abierta.
 */
(function (root) {
    'use strict';
    const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#b07aa1', '#76b7b2', '#edc948', '#9c755f', '#e15759', '#86bcb6', '#d37295'];
    const NEUTRAL = '#8b98a5';
    /** Con «reducir movimiento» en el sistema no se anima nada (mapa ni gráficos). */
    const reduceMotion = () => !!(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const dur = ms => (reduceMotion() ? 0 : ms);
    const commName = id => (id === undefined || id === null || id < 0 ? 'sin comunidad' : 'C' + (id + 1));
    const colorOf = c => (c === undefined || c === null || c < 0 ? NEUTRAL : PALETTE[c % PALETTE.length]);
    const css = (name, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
    const palette = () => ({
        fg: css('--fg', '#0f1419'), bg: css('--bg', '#fff'), muted: css('--muted', '#536471'), line: css('--line', '#e1e8ed'), card: css('--card', '#f7f9fa'),
        accent: css('--accent', '#1479c9'), danger: css('--danger', '#c4271b'), warn: css('--warn', '#b45309'), font: getComputedStyle(document.body).fontFamily
    });

    // ---------- cambio de tema con la página abierta ----------
    const themeListeners = new Set();
    let watching = false;
    function watchTheme() {
        if (watching) return;
        watching = true;
        const fire = () => themeListeners.forEach(fn => { try { fn(); } catch { /* un visor ya destruido */ } });
        new MutationObserver(fire).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        if (matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', fire);
    }

    const fmtTime = (v, long) => new Date(v).toLocaleString('es', long ? { dateStyle: 'medium', timeStyle: 'short' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const fmtClock = v => new Date(v).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

    // ---------- empaquetado de burbujas ----------
    /**
     * Coloca círculos de los radios dados lo más juntos posible y sin solaparse (cada uno tangente a dos ya colocados, el más cercano al
     * centro). Devuelve las posiciones (mismo orden) y el radio que los envuelve. Es lo que hace que cada comunidad quede como un racimo compacto.
     */
    function packCircles(rs, gap) {
        const pos = new Array(rs.length), placed = [];
        const fits = (x, y, r) => placed.every(p => Math.hypot(p.x - x, p.y - y) >= p.r + r + gap - 0.01);
        for (const i of rs.map((r, k) => k).sort((a, b) => rs[b] - rs[a])) {
            const r = rs[i];
            let c = [0, 0];
            if (placed.length === 1) c = [placed[0].r + r + gap, 0];
            else if (placed.length > 1) {
                let best = null, bestD = Infinity;
                const near = [...placed].sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y)).slice(0, 16);
                for (let a = 0; a < near.length; a++) for (let b = a + 1; b < near.length; b++) {
                    const A = near[a], B = near[b], da = A.r + r + gap, db = B.r + r + gap, dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
                    if (!d || d > da + db || d < Math.abs(da - db)) continue;
                    const t = (da * da - db * db + d * d) / (2 * d), h = Math.sqrt(Math.max(0, da * da - t * t)), mx = A.x + t * dx / d, my = A.y + t * dy / d;
                    for (const s of [1, -1]) {
                        const x = mx + s * h * dy / d, y = my - s * h * dx / d;
                        if (!fits(x, y, r)) continue;
                        const dist = Math.hypot(x, y);
                        if (dist < bestD) { bestD = dist; best = [x, y]; }
                    }
                }
                c = best || [Math.max(...placed.map(p => Math.hypot(p.x, p.y) + p.r)) + r + gap, 0];
            }
            placed.push({ x: c[0], y: c[1], r });
            pos[i] = c;
        }
        return { pos, R: placed.length ? Math.max(...placed.map(p => Math.hypot(p.x, p.y) + p.r)) : 0 };
    }

    /** Racimos por comunidad (como un mapa de burbujas): cada grupo se empaqueta y luego los grupos se empaquetan entre sí. */
    function bubbleLayout(nodes, radiusOf, groupOf) {
        const groups = new Map();
        for (const n of nodes) { const g = groupOf(n); (groups.get(g) || groups.set(g, []).get(g)).push(n); }
        const list = [...groups.entries()].map(([g, ns]) => { const p = packCircles(ns.map(radiusOf), 11); return { g, ns, p, R: p.R + 22 }; });
        const top = packCircles(list.map(c => c.R), 40);
        const pos = new Map(), halos = [];
        list.forEach((c, k) => {
            const [cx, cy] = top.pos[k];
            halos.push({ g: c.g, x: cx, y: cy, R: c.R, n: c.ns.length });
            c.ns.forEach((n, j) => pos.set(n.uid, { x: cx + c.p.pos[j][0], y: cy + c.p.pos[j][1] }));
        });
        return { pos, halos };
    }

    // =====================================================================================================================================
    // Mapa de relaciones (Cytoscape.js)
    // =====================================================================================================================================
    function graphStyle() {
        const p = palette();
        return [
            { selector: 'node, edge', style: { 'z-index-compare': 'manual' } },
            { selector: 'node.acct', style: { 'background-color': 'data(color)', 'background-opacity': 0.94, width: 'data(size)', height: 'data(size)', 'border-width': 1.5, 'border-color': p.bg, label: '', color: p.fg, 'font-size': 11, 'font-family': p.font, 'text-valign': 'bottom', 'text-margin-y': 4, 'text-background-color': p.bg, 'text-background-opacity': 0.82, 'text-background-padding': 2, 'text-background-shape': 'roundrectangle', 'min-zoomed-font-size': 6, 'overlay-opacity': 0, 'z-index': 10 } },
            { selector: 'node.acct[role = "lista"]', style: { 'border-color': p.fg, 'border-width': 3.5 } },
            { selector: 'node.acct[role = "vigilada"]', style: { 'border-style': 'dashed', 'border-color': p.fg, 'border-width': 2 } },
            { selector: 'node.acct[?top], node.acct.show', style: { label: 'data(label)' } },
            { selector: 'node.halo', style: { shape: 'ellipse', 'background-color': 'data(color)', 'background-opacity': 0.07, 'border-width': 1.5, 'border-color': 'data(color)', 'border-opacity': 0.5, 'border-style': 'dashed', width: 'data(size)', height: 'data(size)', label: 'data(label)', 'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -8, 'font-size': 13, 'font-weight': 600, 'font-family': p.font, color: p.muted, 'text-outline-color': p.bg, 'text-outline-width': 3, 'overlay-opacity': 0, 'z-index': 0 } },
            { selector: 'edge', style: { width: 'data(w)', 'line-color': p.muted, 'target-arrow-color': p.muted, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.7, 'curve-style': 'bezier', opacity: 0.38, 'overlay-opacity': 0, 'z-index': 5 } },
            { selector: 'edge[coord = 1]', style: { 'line-color': p.danger, 'target-arrow-shape': 'none', opacity: 0.8, 'curve-style': 'straight', 'z-index': 6 } },
            { selector: 'edge.focus', style: { opacity: 0.95, 'z-index': 8 } },
            { selector: '.dim', style: { opacity: 0.07, 'text-opacity': 0 } },
            { selector: 'node.acct.sel', style: { 'border-color': p.accent, 'border-width': 5 } },
            { selector: '.hidden', style: { display: 'none' } }
        ];
    }

    /**
     * Mapa de relaciones en burbujas: cada cuenta es una burbuja (el tamaño es la atención que recibe), las comunidades forman racimos con su
     * halo, y por defecto solo se dibujan las relaciones más fuertes y la sincronía; las demás aparecen al señalar una cuenta.
     * `graph`: { nodes, edges, communities }. Opciones: label(uid) → texto, onNode(node), onEdge(edge), onCommunity(id).
     * Devuelve { setFilters, setMode, highlight, select, reset, find, zoomBy, fit, resize, png, stats, destroy, nodeCount } o null si no hay librería.
     * El contenedor debe estar visible al dibujar (si no, no tiene tamaño): se llama con resize() al mostrar la sección.
     */
    function drawGraph(container, tip, graph, opts = {}) {
        container.replaceChildren();
        if (typeof root.cytoscape !== 'function') {
            container.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No se pudo cargar el visor del mapa. Las cuentas siguen disponibles en la sección «Cuentas».' }));
            return null;
        }
        const label = opts.label || (u => u);
        const nodes = graph.nodes;
        const byUid = new Map(nodes.map(n => [n.uid, n]));
        const maxPr = Math.max(1e-9, ...nodes.map(n => n.pagerank));
        const radiusOf = n => (7 + 26 * Math.sqrt(n.pagerank / maxPr) + (n.role === 'lista' ? 2 : 0));
        const shown = new Set((graph.communities || []).map(c => c.id));
        const groupOf = n => (n.community !== undefined && n.community >= 0 && shown.has(n.community) ? n.community : -1);
        const lay = bubbleLayout(nodes, radiusOf, groupOf);
        const netPos = new Map(nodes.map(n => [n.uid, n.pos ? { x: n.pos[0] * 1000, y: n.pos[1] * 640 } : lay.pos.get(n.uid)]));
        const big = new Set([...nodes].sort((a, b) => b.pagerank - a.pagerank).slice(0, 12).map(n => n.uid));
        for (const n of nodes.filter(x => x.role === 'lista').slice(0, 10)) big.add(n.uid);
        const commSize = new Map((graph.communities || []).map(c => [c.id, c.size]));
        const els = [];
        for (const h of lay.halos) els.push({ group: 'nodes', classes: 'halo', grabbable: false, data: { id: 'halo:' + h.g, group: h.g, size: Math.round(h.R * 2), color: colorOf(h.g), label: h.g < 0 ? `Sin grupo · ${h.n}` : `${commName(h.g)} · ${commSize.get(h.g) || h.n} cuentas` }, position: { x: h.x, y: h.y } });
        for (const n of nodes) {
            els.push({ group: 'nodes', classes: 'acct', data: { id: n.uid, label: label(n.uid), role: n.role, community: n.community === undefined ? -1 : n.community, color: colorOf(groupOf(n)), size: Math.round(radiusOf(n) * 2), top: big.has(n.uid) ? 1 : 0 }, position: { ...lay.pos.get(n.uid) } });
        }
        const edgeOf = new Map();
        const inter = graph.edges.filter(e => e.type !== 'coord' && byUid.has(e.a) && byUid.has(e.b)).sort((a, b) => b.n - a.n);
        const major = new Set(inter.slice(0, Math.max(30, Math.round(nodes.length * 0.9))));
        graph.edges.forEach((e, i) => {
            if (!byUid.has(e.a) || !byUid.has(e.b)) return;
            const id = 'e' + i, coord = e.type === 'coord';
            edgeOf.set(id, e);
            els.push({ group: 'edges', data: { id, source: e.a, target: e.b, coord: coord ? 1 : 0, major: major.has(e) ? 1 : 0, w: coord ? 2 + Math.min(3, Math.log2(1 + e.n)) * (e.level === 'E3' ? 1.2 : 1) : 0.8 + Math.min(2.4, e.n * 0.3) } });
        });
        container.setAttribute('role', 'img');
        container.setAttribute('aria-label', `Mapa de relaciones: ${nodes.length} cuentas agrupadas por comunidad y ${edgeOf.size} relaciones. La misma información está en la sección Cuentas.`);
        const cy = root.cytoscape({ container, elements: els, style: graphStyle(), layout: { name: 'preset' }, minZoom: 0.15, maxZoom: 6, userZoomingEnabled: false, boxSelectionEnabled: false });
        const state = { inter: true, coord: true, external: true, all: false, mode: 'bubbles', sel: null, hi: null, highlight: null };
        let alive = true, frame = 0;
        const accts = () => cy.nodes('.acct');

        function paint() {
            cy.batch(() => {
                cy.elements().removeClass('dim').removeClass('focus');
                accts().removeClass('show').removeClass('sel');
                const hl = state.highlight, focus = state.hi || state.sel;
                accts().forEach(n => n.toggleClass('hidden', !(state.external || n.data('role') === 'lista')));
                cy.edges().forEach(e => {
                    const coord = e.data('coord') === 1, a = e.data('source'), b = e.data('target');
                    let on = coord ? state.coord : state.inter;
                    if (on && !coord && !state.all && !e.data('major') && !(focus && (a === focus || b === focus)) && !(hl && hl.has(a) && hl.has(b))) on = false;
                    e.toggleClass('hidden', !(on && !e.source().hasClass('hidden') && !e.target().hasClass('hidden')));
                });
                if (hl) {
                    cy.elements().filter(x => (x.isEdge() ? !(hl.has(x.data('source')) && hl.has(x.data('target'))) : x.hasClass('acct') && !hl.has(x.id()))).addClass('dim');
                    accts().filter(n => hl.has(n.id())).addClass('show');
                } else if (focus) {
                    const near = cy.getElementById(focus).closedNeighborhood();
                    cy.elements().filter(x => !x.hasClass('halo')).not(near).addClass('dim');
                    near.edges().addClass('focus');
                    near.nodes('.acct').addClass('show');
                }
                if (state.sel) cy.getElementById(state.sel).addClass('sel');
                if (cy.zoom() > 1.8) accts().not('.dim').addClass('show');
            });
        }
        const paintSoon = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (alive) paint(); }); };

        function showTip(lines, pos) {
            tip.replaceChildren(...lines.filter(Boolean).map((t, i) => { const d = document.createElement(i ? 'div' : 'strong'); d.textContent = t; if (i) d.className = 'muted small'; return d; }));
            tip.hidden = false;
            moveTip(pos);
        }
        function moveTip(pos) {
            tip.style.left = Math.max(0, Math.min(container.clientWidth - 210, pos.x + 16)) + 'px';
            tip.style.top = Math.max(0, Math.min(container.clientHeight - 90, pos.y + 16)) + 'px';
        }
        const nodeLines = n => [label(n.uid), n.role === 'lista' ? 'cuenta de tus listas' : n.role === 'vigilada' ? 'cuenta externa vigilada' : 'cuenta externa',
            n.community !== undefined && n.community >= 0 ? `comunidad ${commName(n.community)}` : '', `${n.observations} publicaciones registradas`, `atención recibida ${(n.pagerank * 100).toFixed(1).replace('.', ',')} %`, 'Clic para ver el detalle'];
        const EDGE = { reply: 'respuestas', quote: 'citas', repost: 'reposts', mention: 'menciones' };
        const edgeLines = e => (e.type === 'coord'
            ? [`${label(e.a)} ↔ ${label(e.b)}`, `${e.n} eventos en común (${e.level})`, 'sincronía improbable por azar']
            : [`${label(e.a)} → ${label(e.b)}`, `${e.n} ${EDGE[e.type] || e.type}`]);

        cy.on('mouseover', 'node.acct', ev => { state.hi = ev.target.id(); paint(); showTip(nodeLines(byUid.get(state.hi)), ev.renderedPosition); container.style.cursor = 'pointer'; });
        cy.on('mousemove', 'node.acct, edge', ev => { if (!tip.hidden) moveTip(ev.renderedPosition); });
        cy.on('mouseout', 'node.acct', () => { state.hi = null; paint(); tip.hidden = true; container.style.cursor = ''; });
        cy.on('mouseover', 'edge', ev => { showTip(edgeLines(edgeOf.get(ev.target.id())), ev.renderedPosition); container.style.cursor = 'pointer'; });
        cy.on('mouseout', 'edge', () => { tip.hidden = true; container.style.cursor = ''; });
        cy.on('mouseover', 'node.halo', () => { container.style.cursor = 'pointer'; });
        cy.on('mouseout', 'node.halo', () => { container.style.cursor = ''; });
        cy.on('tap', 'node.acct', ev => { state.sel = ev.target.id(); paint(); if (opts.onNode) opts.onNode(byUid.get(state.sel)); });
        cy.on('tap', 'node.halo', ev => { if (opts.onCommunity) opts.onCommunity(ev.target.data('group')); });
        cy.on('tap', 'edge', ev => { if (opts.onEdge) opts.onEdge(edgeOf.get(ev.target.id())); });
        cy.on('tap', ev => { if (ev.target === cy) { state.sel = null; paint(); } });
        cy.on('zoom', paintSoon);

        // zoom con Ctrl (o el gesto de pellizco) + rueda: así la rueda sola sigue desplazando la página
        const onWheel = ev => {
            if (!(ev.ctrlKey || ev.metaKey)) return;
            ev.preventDefault();
            const r = container.getBoundingClientRect();
            cy.zoom({ level: Math.min(6, Math.max(0.15, cy.zoom() * (ev.deltaY < 0 ? 1.15 : 1 / 1.15))), renderedPosition: { x: ev.clientX - r.left, y: ev.clientY - r.top } });
        };
        const hint = Object.assign(document.createElement('div'), { className: 'ghint', textContent: 'Ctrl + rueda para acercar', hidden: true });
        container.parentNode.append(hint);
        let hintTimer = 0;
        const onWheelHint = ev => { if (ev.ctrlKey || ev.metaKey) return; hint.hidden = false; clearTimeout(hintTimer); hintTimer = setTimeout(() => { hint.hidden = true; }, 1100); };
        container.addEventListener('wheel', onWheel, { passive: false });
        container.addEventListener('wheel', onWheelHint, { passive: true });

        const restyle = () => { if (alive) cy.style(graphStyle()); };
        themeListeners.add(restyle);
        watchTheme();

        const fitTo = (eles, pad = 34) => { if (eles && eles.nonempty && eles.nonempty()) cy.animate({ fit: { eles, padding: pad }, duration: dur(340) }); };
        const haloPos = new Map(lay.halos.map(h => ['halo:' + h.g, { x: h.x, y: h.y }]));
        /** Pares de burbujas que se tocan o solapan (en el modo por comunidades debe ser 0). */
        const overlaps = () => { const a = accts().toArray().map(n => ({ p: n.position(), r: n.data('size') / 2 })); let k = 0; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (Math.hypot(a[i].p.x - a[j].p.x, a[i].p.y - a[j].p.y) < a[i].r + a[j].r - 0.5) k++; return k; };
        /** Coloca cada burbuja en su sitio según el modo. Se entregan copias de las posiciones: Cytoscape modifica el objeto que recibe al mover el nodo. */
        const place = () => cy.layout({ name: 'preset', positions: n => { const p = n.hasClass('halo') ? haloPos.get(n.id()) : (state.mode === 'network' ? netPos : lay.pos).get(n.id()); return { x: p.x, y: p.y }; }, animate: !reduceMotion(), animationDuration: dur(600), fit: true, padding: 34 }).run();
        paint();
        cy.fit(undefined, 34);
        return {
            nodeCount: nodes.length,
            /** Lo que se ve ahora (para las pruebas y para el lector de pantalla). */
            stats() { return { nodes: accts().filter(n => !n.hasClass('hidden')).length, edges: cy.edges().filter(e => !e.hasClass('hidden')).length, selected: state.sel, dimmed: cy.elements('.dim').length, zoom: cy.zoom(), mode: state.mode, halos: cy.nodes('.halo').length, overlaps: overlaps() }; },
            /** Posición de cada cuenta (para comprobar que volver a un modo las deja donde estaban). */
            positions() { return Object.fromEntries(accts().toArray().map(n => [n.id(), [Math.round(n.position('x')), Math.round(n.position('y'))]])); },
            setFilters(f) { Object.assign(state, f); paint(); },
            /** 'bubbles': racimos por comunidad; 'network': distribución por fuerzas según las relaciones. */
            setMode(m) {
                state.mode = m === 'network' ? 'network' : 'bubbles';
                cy.nodes('.halo').toggleClass('hidden', state.mode === 'network');
                place();
                paint();
            },
            highlight(uids) { state.highlight = uids && uids.size ? uids : null; paint(); if (state.highlight) fitTo(accts().filter(n => state.highlight.has(n.id()) && !n.hasClass('hidden')), 90); else fitTo(cy.elements()); },
            select(uid) { state.sel = byUid.has(uid) ? uid : null; paint(); if (state.sel) cy.animate({ center: { eles: cy.getElementById(uid) }, duration: dur(300) }); },
            /** Quita el resaltado y devuelve cada burbuja a su sitio (también las que se hayan arrastrado). */
            reset() { state.sel = null; state.hi = null; state.highlight = null; paint(); place(); },
            find(q) {
                const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
                const needle = norm(q).replace(/^@/, '');
                if (!needle) return null;
                const hit = nodes.find(n => norm(label(n.uid)).replace(/^@/, '').includes(needle));
                if (!hit) return null;
                state.sel = hit.uid; paint();
                cy.animate({ center: { eles: cy.getElementById(hit.uid) }, zoom: Math.max(cy.zoom(), 1.6), duration: dur(350) });
                return hit;
            },
            zoomBy(f) { cy.zoom({ level: Math.min(6, Math.max(0.15, cy.zoom() * f)), renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 } }); },
            fit() { fitTo(cy.elements()); },
            resize() { if (!alive) return; cy.resize(); cy.fit(undefined, 34); },
            png() { return cy.png({ full: true, scale: 2, bg: palette().bg }); },
            destroy() { alive = false; themeListeners.delete(restyle); container.removeEventListener('wheel', onWheel); container.removeEventListener('wheel', onWheelHint); clearTimeout(hintTimer); hint.remove(); cy.destroy(); }
        };
    }

    // =====================================================================================================================================
    // Gráficos (Apache ECharts)
    // =====================================================================================================================================
    const charts = new Map();

    /** Crea un gráfico que se redibuja solo al cambiar de tamaño o de tema. `build(p)` devuelve las opciones con la paleta actual. */
    function makeChart(host, build) {
        host.replaceChildren();
        if (typeof root.echarts === 'undefined') return null;
        const c = root.echarts.init(host, null, { renderer: 'canvas' });
        const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { try { c.resize(); } catch { /* ya destruido */ } }) : null;
        if (ro) ro.observe(host);
        charts.set(c, { host, build, ro });
        c.setOption(build(palette()));
        watchTheme();
        return c;
    }
    themeListeners.add(() => { for (const [c, e] of charts) { try { c.setOption(e.build(palette()), true); } catch { /* ya destruido */ } } });

    /** Libera los gráficos que cuelgan de `scope` (o todos). */
    function disposeCharts(scope) {
        for (const [c, e] of [...charts]) {
            if (scope && !scope.contains(e.host)) continue;
            if (e.ro) e.ro.disconnect();
            try { c.dispose(); } catch { /* ya destruido */ }
            charts.delete(c);
        }
    }

    const base = (p, compact) => ({
        animation: !reduceMotion(), animationDuration: 450, textStyle: { fontFamily: p.font, color: p.fg },
        tooltip: { trigger: 'axis', backgroundColor: p.card, borderColor: p.line, textStyle: { color: p.fg, fontFamily: p.font, fontSize: 12 }, confine: true },
        grid: compact ? { left: 4, right: 4, top: 6, bottom: 4 } : { left: 46, right: 46, top: 34, bottom: 56 }
    });
    const timeAxis = (p, compact, min, max) => ({
        type: 'time', min, max, axisLine: { lineStyle: { color: p.line } }, splitLine: { show: false }, axisTick: { show: !compact },
        axisLabel: { show: !compact, color: p.muted, hideOverlap: true, formatter: v => fmtTime(v) }
    });

    /**
     * Cómo entraron las cuentas a una narrativa: curva acumulada de cuentas nuevas y publicaciones por franja, con una línea en los primeros
     * 5 minutos y, si los hay, los hechos externos que la persona anotó (con sus textos al pasar el ratón).
     * opts: { compact, externals: [{ at, title, kind }] }.
     */
    function curve(host, n, opts = {}) {
        const compact = !!opts.compact, t = n.timeline, m = t.cumulative.length;
        const xs = Array.from({ length: m }, (_, i) => t.start + i * t.binMs);
        const near = (opts.externals || []).filter(e => e.at >= xs[0] - 12 * 3600000 && e.at <= xs[m - 1] + 12 * 3600000);
        const min = Math.min(xs[0], ...near.map(e => e.at)), max = Math.max(xs[m - 1] + t.binMs, ...near.map(e => e.at));
        return makeChart(host, p => {
            const marks = [{ xAxis: t.start + 5 * 60000, name: 'primeros 5 min', lineStyle: { color: p.danger, type: 'dashed', width: 1 }, label: { show: !compact, formatter: 'primeros 5 min', color: p.danger, fontSize: 10, position: 'insideEndTop' } }];
            for (const e of near) marks.push({ xAxis: e.at, name: e.title, lineStyle: { color: p.warn, width: 1.5 }, label: { show: !compact, formatter: () => (e.title.length > 28 ? e.title.slice(0, 27) + '…' : e.title), color: p.warn, fontSize: 10, rotate: 90, position: 'insideEndTop' } });
            return {
                ...base(p, compact),
                tooltip: { ...base(p, compact).tooltip, formatter: ps => {
                    const when = fmtTime(ps[0].value[0], true);
                    return `<b>${when}</b>` + ps.map(s => `<div>${s.marker} ${s.seriesName}: <b>${s.value[1]}</b></div>`).join('');
                } },
                legend: compact ? { show: false } : { top: 0, right: 0, textStyle: { color: p.muted, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
                xAxis: timeAxis(p, compact, min, max),
                yAxis: [
                    { type: 'value', minInterval: 1, show: !compact, axisLabel: { color: p.muted }, splitLine: { lineStyle: { color: p.line, opacity: 0.5 } }, name: compact ? '' : 'cuentas', nameTextStyle: { color: p.muted, fontSize: 10 } },
                    { type: 'value', minInterval: 1, show: false, splitLine: { show: false } }
                ],
                dataZoom: compact ? [] : [{ type: 'inside', throttle: 40 }, { type: 'slider', height: 16, bottom: 8, borderColor: p.line, fillerColor: 'rgba(120,120,120,.15)', textStyle: { color: p.muted, fontSize: 10 } }],
                series: [
                    { name: 'publicaciones por franja', type: 'bar', yAxisIndex: 1, data: xs.map((x, i) => [x, t.volume[i]]), itemStyle: { color: p.muted, opacity: 0.32 }, barMaxWidth: 12 },
                    { name: 'cuentas que ya entraron', type: 'line', step: 'end', showSymbol: false, data: xs.map((x, i) => [x, t.cumulative[i]]), lineStyle: { width: 2, color: p.accent }, itemStyle: { color: p.accent }, areaStyle: { color: p.accent, opacity: 0.14 }, markLine: { symbol: 'none', silent: false, animation: false, data: marks, tooltip: { formatter: x => x.name } } }
                ]
            };
        });
    }

    /** Actividad de un tema por comunidad a lo largo del tiempo (áreas apiladas). `topic`: ficha de topicStats; `nameOf(id)` rotula cada comunidad. */
    function stacked(host, topic, nameOf, opts = {}) {
        const t = topic.timeline, m = t.counts.length, xs = Array.from({ length: m }, (_, i) => t.start + i * t.binMs);
        const comms = topic.byCommunity.slice(0, 6);
        return makeChart(host, p => ({
            ...base(p, false),
            tooltip: { ...base(p, false).tooltip, formatter: ps => `<b>${fmtTime(ps[0].value[0], true)}</b>` + ps.filter(s => s.value[1] > 0).map(s => `<div>${s.marker} ${s.seriesName}: <b>${s.value[1]}</b></div>`).join('') },
            grid: { left: 40, right: 12, top: 30, bottom: opts.compact ? 24 : 54 },
            legend: { top: 0, left: 0, textStyle: { color: p.muted, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
            xAxis: timeAxis(p, false, xs[0], xs[m - 1] + t.binMs),
            yAxis: { type: 'value', minInterval: 1, axisLabel: { color: p.muted }, splitLine: { lineStyle: { color: p.line, opacity: 0.5 } } },
            dataZoom: opts.compact ? [] : [{ type: 'inside', throttle: 40 }, { type: 'slider', height: 16, bottom: 6, borderColor: p.line, textStyle: { color: p.muted, fontSize: 10 } }],
            series: comms.map(c => ({ name: nameOf(c.id), type: 'line', stack: 'tema', showSymbol: false, smooth: false, areaStyle: { opacity: 0.55 }, lineStyle: { width: 1 }, itemStyle: { color: colorOf(c.id) }, color: colorOf(c.id), data: xs.map((x, i) => [x, c.series[i]]) }))
        }));
    }

    /** Distribución de los valores p de todos los pares comprobados: sin coordinación debería ser plana; un exceso a la izquierda indica señal. */
    function histogram(host, counts) {
        const total = counts.reduce((a, b) => a + b, 0), flat = total / counts.length;
        return makeChart(host, p => ({
            ...base(p, false), grid: { left: 36, right: 12, top: 20, bottom: 36 },
            tooltip: { ...base(p, false).tooltip, trigger: 'axis', formatter: ps => `p entre ${ps[0].name}: <b>${ps[0].value}</b> pares` },
            xAxis: { type: 'category', data: counts.map((_, i) => `${(i / counts.length).toFixed(1).replace('.', ',')}–${((i + 1) / counts.length).toFixed(1).replace('.', ',')}`), axisLabel: { color: p.muted, fontSize: 10, interval: 0, rotate: 0 }, axisLine: { lineStyle: { color: p.line } } },
            yAxis: { type: 'value', minInterval: 1, axisLabel: { color: p.muted }, splitLine: { lineStyle: { color: p.line, opacity: 0.5 } } },
            series: [{ type: 'bar', data: counts, itemStyle: { color: p.accent, opacity: 0.8 }, barMaxWidth: 28, markLine: { symbol: 'none', silent: true, animation: false, data: [{ yAxis: flat, lineStyle: { color: p.muted, type: 'dashed' }, label: { formatter: 'si no hubiera señal', color: p.muted, fontSize: 10, position: 'insideEndTop' } }] } }]
        }));
    }

    root.AnView = { drawGraph, curve, stacked, histogram, disposeCharts, colorOf, PALETTE, NEUTRAL, palette };
})(typeof globalThis !== 'undefined' ? globalThis : this);
