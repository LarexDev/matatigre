/**
 * Content script (mundo aislado). Dos fuentes de verdad, combinadas:
 *   1. page-script.js (mundo MAIN) lee las respuestas de la API de X y avisa de qué publicaciones coinciden
 *      (`hits`, por id) o ya las quitó de la respuesta (`drops`). Es exacto: autor, repostero, cita, respuesta.
 *   2. Lectura del DOM *sin data-testid* (X los eliminó): enlaces /handle/status/ID y /handle. Sirve de respaldo
 *      cuando la API no pasó por el hook o la publicación llegó por otra vía.
 * El ocultamiento lo hace content.css con atributos; no se inserta HTML dentro del árbol de la página.
 *
 * El MutationObserver procesa de forma síncrona (microtarea, antes de pintar) para evitar parpadeos.
 */
(function () {
    'use strict';
    const { createMatcher, parseLocation, compactConfig } = XAF;

    const ATTR = 'data-xaf';           // en el article: hidden | collapsed | highlight | revealed
    const ITEM_ATTR = 'data-xaf-cell'; // en el contenedor de la fila: hidden
    const LABEL_ATTR = 'data-xaf-label';
    const STATUS_HREF = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\/|$)/;
    const PROFILE_HREF = /^\/([A-Za-z0-9_]{1,15})$/;
    const CFG_KEY = 'matatigre.cfg';
    const MAX_RECENT = 60;

    let config = null;
    let matcher = createMatcher();
    let loc = parseLocation(location.pathname);
    let lastPath = location.pathname;
    let marks = new WeakMap();
    let hits = new Map();              // id -> { v, author, reposters }   (desde page-script)
    const counted = new Set();         // ids ya contados en esta carga
    const stats = { hidden: 0, bar: 0, recent: [] };
    let pageDiag = null;
    let pageSchema = null;
    let pending = { n: 0, byHandle: {}, byRole: {} };
    let lastHealth = 'ok';             // 'ok' | 'api' | 'dom' (ver health())

    // ---------- lectura del DOM ----------

    const profileHandle = href => { const m = PROFILE_HREF.exec(href || ''); return m ? m[1].toLowerCase() : null; };

    /** Fila contenedora que conviene ocultar entera (li en el DOM nuevo, cellInnerDiv en el antiguo). */
    function rowOf(article) {
        const row = article.closest('li, [data-testid="cellInnerDiv"]');
        return row && row !== article && row.querySelectorAll('article').length === 1 ? row : null;
    }

    function readArticle(article) {
        const info = { id: null, author: null, authorLink: null, quoted: null, mentions: [] };
        const wrap = article.closest('[data-href]');
        const wrapMatch = wrap && STATUS_HREF.exec(wrap.getAttribute('data-href') || '');
        if (wrapMatch) { info.id = wrapMatch[2]; info.author = wrapMatch[1].toLowerCase(); }

        const seen = new Set();
        for (const a of article.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href');
            const sm = STATUS_HREF.exec(href);
            if (sm) {
                if (!info.id) { info.id = sm[2]; info.author = sm[1].toLowerCase(); }
                else if (sm[2] !== info.id && !info.quoted) info.quoted = sm[1].toLowerCase();
                continue;
            }
            const h = profileHandle(href);
            if (h && !seen.has(h)) { seen.add(h); if (!info.authorLink) info.authorLink = h; else info.mentions.push(h); }
        }
        if (!info.author) info.author = info.authorLink;
        if (!info.quoted) {
            // Tarjeta de cita sin enlaces: el @handle aparece como texto dentro de un [role=link] anidado.
            for (const card of article.querySelectorAll('[role="link"]')) {
                const m = /@([A-Za-z0-9_]{1,15})/.exec(card.textContent || '');
                if (m && m[1].toLowerCase() !== info.author) { info.quoted = m[1].toLowerCase(); break; }
            }
        }
        info.mentions = info.mentions.filter(h => h !== info.author);
        return info;
    }

    // ---------- contador "N ocultas" (solo informa) ----------
    let barEl = null, barText = '';
    function updateBar() {
        const n = config && matcher.settings.enabled && matcher.settings.showBar ? stats.bar : 0;
        const text = n ? (n === 1 ? '1 oculta' : n + ' ocultas') : '';
        if (text === barText) return;
        barText = text;
        if (!text) { if (barEl) barEl.hidden = true; return; }
        if (!barEl) {
            barEl = document.createElement('div');
            barEl.id = 'matatigre-bar';
            barEl.setAttribute('aria-hidden', 'true');
            document.documentElement.append(barEl);   // fuera del árbol de la aplicación de X
        }
        barEl.textContent = text;
        barEl.hidden = false;
    }

    // ---------- insignia «Añadir» y tarjeta de listas ----------
    // Una insignia pequeña (el icono de MATATIGRE) se coloca en la esquina superior derecha de cada publicación de una cuenta que no
    // se filtra, a la izquierda de los iconos de X (menú, Grok…). Se ve al pasar el ratón por la publicación y, al pulsarla, abre una
    // tarjeta para elegir lista. La tarjeta y el aviso son elementos propios añadidos a <html>; la insignia es lo único que se coloca
    // dentro de la página (posicionada en absoluto: no mueve nada; se vuelve a poner si X repinta).
    const BADGE = 'data-xaf-badge';
    let cardEl = null, toastEl = null, toastTimer = 0, cardAnchor = null, meta = null;

    const mk = (tag, props = {}, ...kids) => {
        const n = Object.assign(document.createElement(tag), props);
        n.append(...kids.filter(k => k != null));
        return n;
    };
    const isDark = () => {
        try {
            const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
            if (m) return 0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3] < 128;
        } catch { /* sin estilo */ }
        return matchMedia('(prefers-color-scheme: dark)').matches;
    };
    const cardOpen = () => !!cardEl && !cardEl.hidden;
    const isListed = h => !!matcher.matchHandle(h) || (config.allowlist || []).some(x => XAF.normalizeHandle(x) === h);

    function removeBadges() {
        for (const b of document.querySelectorAll(`[${BADGE}]`)) { b.parentElement?.removeAttribute('data-xaf-host'); b.remove(); }
    }

    /** Coloca la insignia arriba a la derecha, a la izquierda del icono más a la izquierda de la cabecera de X (si lo hay). */
    function placeBadge(article, b) {
        const r = article.getBoundingClientRect();
        if (!r.width) return;
        let best = null;
        for (const el of article.querySelectorAll('button, [role="button"]')) {
            if (el === b) continue;
            const er = el.getBoundingClientRect();
            if (er.width < 8 || er.height < 8 || er.height > 60 || er.top - r.top > 56 || er.left < r.left + r.width / 2) continue;
            if (!best || er.left < best.left) best = er;
        }
        b.style.right = Math.max(6, best ? r.right - best.left + 4 : 44) + 'px';
        b.style.top = Math.max(2, best ? best.top - r.top + (best.height - 22) / 2 : 8) + 'px';
    }

    /** Pone (o quita) la insignia de una publicación según el estado de su autor. */
    function syncBadge(article, info) {
        const h = info.author;
        const want = !!h && !!config && matcher.settings.enabled && matcher.settings.addButton && article.getAttribute(ATTR) !== 'hidden' && !isListed(h);
        const cur = article.querySelector(`[${BADGE}]`);
        if (!want) { if (cur) { article.removeAttribute('data-xaf-host'); cur.remove(); } return; }
        if (cur && cur.getAttribute(BADGE) === h) return;
        if (cur) cur.remove();
        const b = mk('span', { className: 'matatigre-badge', role: 'button', tabIndex: 0, title: 'Añadir @' + h + ' a una lista' });
        b.setAttribute(BADGE, h);
        b.setAttribute('aria-label', b.title);
        article.setAttribute('data-xaf-host', '');
        article.append(b);   // no se mide aquí (forzaría un reflujo por publicación): se coloca al entrar el ratón
    }

    // X pinta sus iconos después de la publicación: se recoloca al entrar el ratón en ella.
    let hoverArticle = null;
    document.addEventListener('mouseover', e => {
        const a = e.target instanceof Element ? e.target.closest('article') : null;
        if (a === hoverArticle) return;
        hoverArticle = a;
        const b = a && a.querySelector(`[${BADGE}]`);
        if (b) placeBadge(a, b);
    }, true);

    function closeCard() {
        if (cardEl) cardEl.hidden = true;
        if (cardAnchor) cardAnchor.removeAttribute('aria-expanded');
        cardAnchor = null;
    }

    /** Listas propias existentes, por nombre. Las sincronizadas son de solo lectura y no se ofrecen; las listas nuevas se crean en las opciones. */
    function ownLists() {
        return Object.entries(config.myLists || {}).sort((a, b) => a[1].name.localeCompare(b[1].name, 'es')).map(([id, m]) => ({ id, name: m.name }));
    }
    const openOptions = hash => { try { chrome.runtime.sendMessage({ type: 'xaf:openOptions', hash }).catch(() => {}); } catch { /* contexto invalidado */ } };

    function openCard(h, anchor) {
        if (!cardEl) { cardEl = mk('div', { id: 'matatigre-card', hidden: true }); document.documentElement.append(cardEl); }
        if (cardAnchor) cardAnchor.removeAttribute('aria-expanded');
        cardAnchor = anchor;
        anchor.setAttribute('aria-expanded', 'true');
        cardEl.className = isDark() ? 'dark' : 'light';
        const lists = ownLists();
        const last = (meta && meta.lastList) || '';
        const add = mk('button', { type: 'button', className: 'mt-primary', textContent: 'Añadir', disabled: true });
        const refresh = () => { add.disabled = !cardEl.querySelector('input[type=checkbox]:checked'); };
        const rows = lists.map(l => {
            const box = mk('input', { type: 'checkbox', value: l.id, checked: l.id === last });
            box.addEventListener('change', refresh);
            const row = mk('label', { className: 'mt-row' }, box, mk('span', { textContent: l.name }));
            row.dataset.name = l.name.toLowerCase();
            return row;
        });
        const find = lists.length > 8 ? mk('input', { type: 'search', className: 'mt-new', placeholder: 'Buscar lista…', spellcheck: false }) : null;
        if (find) find.addEventListener('input', () => { const q = find.value.trim().toLowerCase(); for (const r of rows) r.hidden = !!q && !r.dataset.name.includes(q); });
        const show = mk('button', { type: 'button', className: 'mt-link', textContent: 'Siempre mostrar' });
        const submit = () => { const chosen = [...cardEl.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value); if (!chosen.length) return; closeCard(); addAccount(h, chosen); };
        add.addEventListener('click', submit);
        show.addEventListener('click', () => { closeCard(); alwaysShow(h); });
        cardEl.onkeydown = e => { if (e.key === 'Enter' && e.target.type !== 'search') { e.preventDefault(); submit(); } else if (e.key === 'Escape') closeCard(); e.stopPropagation(); };
        const empty = mk('div', { className: 'mt-empty' },
            mk('p', { textContent: 'Aún no tienes listas propias.' }),
            mk('button', { type: 'button', className: 'mt-primary', textContent: 'Crear una lista', onclick: () => { closeCard(); openOptions('#lists/new'); } }));
        cardEl.replaceChildren(
            mk('div', { className: 'mt-head' }, mk('span', { className: 'mt-logo' }), mk('strong', { textContent: '@' + h }), mk('button', { type: 'button', className: 'mt-x', textContent: '×', ariaLabel: 'Cerrar', onclick: closeCard })),
            ...(lists.length
                ? [mk('div', { className: 'mt-title', textContent: 'Añadir a mis listas' }), ...(find ? [find] : []), mk('div', { className: 'mt-rows', role: 'group', ariaLabel: 'Mis listas' }, ...rows), add, show]
                : [empty, show]));
        refresh();
        cardEl.hidden = false;
        const b = anchor.getBoundingClientRect(), c = cardEl.getBoundingClientRect();
        let top = b.bottom + 6;
        if (top + c.height > innerHeight - 8) top = Math.max(8, b.top - c.height - 6);
        cardEl.style.top = top + 'px';
        cardEl.style.left = Math.max(8, Math.min(b.left, innerWidth - c.width - 8)) + 'px';
        (cardEl.querySelector('input:checked') || cardEl.querySelector('input') || cardEl.querySelector('.mt-primary')).focus({ preventScroll: true });
    }

    /** Aviso en la página. `opts`: label (texto del botón), sticky (no se cierra solo), keep (el botón no lo cierra). */
    function showToast(text, undo, opts = {}) {
        clearTimeout(toastTimer);
        if (!toastEl) { toastEl = mk('div', { id: 'matatigre-toast', hidden: true }); document.documentElement.append(toastEl); }
        toastEl.className = isDark() ? 'dark' : 'light';
        toastEl.replaceChildren(mk('span', { className: 'mt-logo' }), mk('span', { textContent: text }), undo ? mk('button', { type: 'button', textContent: opts.label || 'Deshacer', onclick: async () => { if (!opts.keep) toastEl.hidden = true; await undo(); } }) : null);
        toastEl.hidden = false;
        if (!opts.sticky) toastTimer = setTimeout(() => { toastEl.hidden = true; }, 6000);
    }

    /** Añade la cuenta a listas propias que ya existen (nunca crea listas) y deja deshacer durante unos segundos. */
    async function addAccount(h, chosen) {
        const before = await XAF.store.load();
        const cfg = { ...before };
        const res = XAF.myLists.addAccounts(cfg, [h], chosen);
        if (!res.added && !res.existing) { showToast('Elige una de tus listas.'); return; }
        await XAF.store.save({ accounts: cfg.accounts, allowlist: cfg.allowlist, disabled: cfg.disabled });
        const names = chosen.filter(id => before.myLists[id]).map(id => before.myLists[id].name);
        try { meta = await XAF.store.saveMeta({ lastList: chosen[0] }); } catch { /* sin guardar la última lista */ }
        showToast('@' + h + ' añadido a «' + names.join('», «') + '»', async () => {
            const now = await XAF.store.load();
            const back = { ...now.accounts };
            if (before.accounts[h]) back[h] = before.accounts[h]; else delete back[h];
            await XAF.store.save({ accounts: back, allowlist: before.allowlist, disabled: before.disabled });
        });
    }

    /** "Siempre mostrar": la cuenta va a la lista blanca (nunca se oculta). */
    async function alwaysShow(h) {
        const before = await XAF.store.load();
        await XAF.store.save({ allowlist: [...new Set([...before.allowlist, h])] });
        showToast('@' + h + ' se mostrará siempre', async () => { await XAF.store.save({ allowlist: before.allowlist }); });
    }

    function badgeActivate(b) {
        if (cardOpen() && cardAnchor === b) closeCard(); else openCard(b.getAttribute(BADGE), b);
    }
    document.addEventListener('click', e => {
        const b = e.target instanceof Element && e.target.closest(`[${BADGE}]`);
        if (!b) return;
        e.preventDefault();
        e.stopPropagation();      // que X no abra la publicación
        badgeActivate(b);
    }, true);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && cardOpen()) { closeCard(); return; }
        const b = e.target instanceof Element && e.target.closest(`[${BADGE}]`);
        if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); badgeActivate(b); }
    }, true);
    document.addEventListener('mousedown', e => {
        if (cardOpen() && e.target instanceof Element && !e.target.closest(`#matatigre-card, [${BADGE}]`)) closeCard();
    }, true);
    window.addEventListener('scroll', () => { if (cardOpen()) closeCard(); }, { capture: true, passive: true });
    window.addEventListener('resize', () => { if (cardOpen()) closeCard(); });

    // ---------- decisión y aplicación ----------

    function clear(article) {
        if (article.getAttribute(ATTR) === 'revealed') return;
        article.removeAttribute(ATTR);
        article.removeAttribute(LABEL_ATTR);
        const row = rowOf(article);
        if (row) row.removeAttribute(ITEM_ATTR);
    }


    /** Nombres de las listas (propias o sincronizadas) que motivaron un veredicto: el «por qué» de cada ocultación. */
    function listNames(v) {
        if (!v || !Array.isArray(v.lists) || !config) return [];
        return v.lists.map(id => (config.myLists && config.myLists[id] && config.myLists[id].name) || ((config.subs || []).find(s => s.id === id) || {}).name || id).slice(0, 3);
    }

    function count(id, verdict, via) {
        const key = id || Math.random().toString(36);
        if (counted.has(key)) return;
        counted.add(key);
        stats.hidden++;
        if (verdict.mode !== 'highlight') stats.bar++;
        const h = verdict.handle || '?';
        stats.recent.unshift({ handle: verdict.handle, role: verdict.role, label: verdict.label, lists: listNames(verdict), via, at: Date.now() });
        if (stats.recent.length > MAX_RECENT) stats.recent.length = MAX_RECENT;
        pending.n++;
        pending.byHandle[h] = (pending.byHandle[h] || 0) + 1;
        pending.byRole[verdict.role] = (pending.byRole[verdict.role] || 0) + 1;
        reportSoon();
        updateBar();
    }

    function apply(article, id, verdict) {
        const mode = verdict.mode || matcher.settings.mode;
        const names = listNames(verdict);
        // lo que se lee en la barra de una publicación colapsada o resaltada: qué ocurre y por qué lista
        const why = XAF.whyPhrase(verdict.role, verdict.handle, verdict.label);
        const label = ['MATATIGRE', why, names.length ? (names.length === 1 ? 'lista ' : 'listas ') + names.map(n => '«' + n + '»').join(', ') : (verdict.label && !/^@/.test(verdict.label) && verdict.label !== why ? verdict.label : '')].filter(Boolean).join(' · ');
        if (mode === 'highlight') {
            article.setAttribute(ATTR, 'highlight');
            article.setAttribute(LABEL_ATTR, label);
        } else if (mode === 'collapse') {
            article.setAttribute(ATTR, 'collapsed');
            article.setAttribute(LABEL_ATTR, label + ' · clic para ver');
        } else {
            article.setAttribute(ATTR, 'hidden');
            const row = rowOf(article);
            if (row) row.setAttribute(ITEM_ATTR, 'hidden');
        }
        count(id, verdict, 'dom');
    }

    function processArticle(article) {
        const info = readArticle(article);
        if (!info.author) return;
        const hit = info.id ? hits.get(info.id) : null;
        const sig = [info.id, info.author, info.quoted, hit && hit.v.label, info.mentions.length].join('|');
        if (marks.get(article) === sig) { syncBadge(article, info); return; }
        marks.set(article, sig);

        if (article.getAttribute(ATTR) === 'revealed') article.removeAttribute(ATTR);
        let verdict = hit ? hit.v : null;
        let reposters = hit ? hit.reposters : [];
        if (!verdict) {
            verdict = matcher.evaluate({ author: info.author, quoted: info.quoted, mentions: info.mentions });
        }
        const post = { id: info.id, author: info.author, reposters };
        if (verdict && !matcher.isExempt(loc, verdict, post)) apply(article, info.id, verdict);
        else clear(article);
        syncBadge(article, info);
    }

    function processUserCell(cell) {
        if (!matcher.settings.filterUserCells || cell.closest('[data-testid="HoverCard"]')) return;
        let handle = null, name = '';
        for (const a of cell.querySelectorAll('a[href^="/"]')) {
            handle = profileHandle(a.getAttribute('href'));
            if (handle) { name = a.textContent || ''; break; }
        }
        if (!handle) return;
        if (marks.get(cell) === handle) return;
        marks.set(cell, handle);
        const verdict = matcher.matchHandle(handle, name);
        if (verdict && !matcher.isExempt(loc, { ...verdict, handle: null }, { author: null })) {
            cell.setAttribute(ATTR, 'hidden');
            const row = cell.closest('[data-testid="cellInnerDiv"]');
            if (row) row.setAttribute(ITEM_ATTR, 'hidden');
        } else {
            cell.removeAttribute(ATTR);
            cell.closest('[data-testid="cellInnerDiv"]')?.removeAttribute(ITEM_ATTR);
        }
    }

    /** Un cambio dentro de un artículo ya evaluado sólo importa si añade enlaces (identidad). */
    const relevantChange = node => node.matches('a[href]') || !!node.querySelector('a[href]');

    function scan(node) {
        if (node.nodeType !== 1) return;
        const article = node.closest('article');
        if (article && (!marks.has(article) || relevantChange(node))) processArticle(article);
        const userCell = node.closest('[data-testid="UserCell"]');
        if (userCell) processUserCell(userCell);
        if (node.querySelector) {
            for (const a of node.querySelectorAll('article')) processArticle(a);
            for (const c of node.querySelectorAll('[data-testid="UserCell"]')) processUserCell(c);
        }
    }

    function clearMarks() {
        for (const el of document.querySelectorAll(`[${ATTR}],[${ITEM_ATTR}]`)) {
            el.removeAttribute(ATTR);
            el.removeAttribute(ITEM_ATTR);
            el.removeAttribute(LABEL_ATTR);
        }
        marks = new WeakMap();
        removeBadges();
    }

    function resetCounts() {
        counted.clear();
        stats.hidden = 0;
        stats.bar = 0;
        stats.recent = [];
        updateBar();
    }

    function rescan() {
        clearMarks();
        if (config && matcher.settings.enabled) scan(document.documentElement);
        reportSoon();
    }

    function navigate() {
        lastPath = location.pathname;
        loc = parseLocation(lastPath);
        resetCounts();
        rescan();
    }

    // ---------- observer / SPA ----------

    const observer = new MutationObserver(records => {
        if (location.pathname !== lastPath) { navigate(); return; }
        if (!config || !matcher.settings.enabled) return;
        const touched = new Set();
        for (const r of records) {
            for (const n of r.addedNodes) {
                if (n.nodeType === 1) touched.add(n);
                else if (n.nodeType === 3 && r.target.nodeType === 1) touched.add(r.target);
            }
        }
        for (const n of touched) scan(n);
    });

    // ---------- eventos del script de página ----------

    const parse = e => { try { return JSON.parse(e.detail); } catch { return null; } };

    document.addEventListener('matatigre:hits', e => {
        const d = parse(e);
        if (!d) return;
        if (d.full) hits = new Map();
        for (const h of d.hits || []) hits.set(h.id, h);
        if (!d.full && config && matcher.settings.enabled) scan(document.documentElement);
    });

    document.addEventListener('matatigre:drops', e => {
        const drops = parse(e) || [];
        for (const d of drops) count(d.id, { handle: d.handle, role: d.role, label: d.label, lists: d.lists, mode: 'hide' }, 'api');
    });

    document.addEventListener('matatigre:diag', e => { pageDiag = parse(e); });
    document.addEventListener('matatigre:schema', e => { pageSchema = parse(e); });
    // Pares (nombre, id) de cuentas de la lista sin id: se reenvían para que el service worker los aprenda.
    document.addEventListener('matatigre:ids', e => {
        const d = parse(e);
        if (!d || !Array.isArray(d.ids) || !d.ids.length) return;
        try { chrome.runtime.sendMessage({ type: 'xaf:ids', ids: d.ids.slice(0, 200) }).catch(() => {}); } catch { /* contexto invalidado */ }
    });

    // Registro local (solo si el usuario lo activó): se reenvía al service worker en lotes, nunca desde aquí a la red.
    let obsQueue = [], obsTimer = 0;
    function flushObs() {
        obsTimer = 0;
        const batch = obsQueue.splice(0, 200);
        if (batch.length) { try { chrome.runtime.sendMessage({ type: 'xaf:obs', batch }).catch(() => {}); } catch { /* contexto invalidado */ } }
        if (obsQueue.length) obsTimer = setTimeout(flushObs, 2000);
    }
    document.addEventListener('matatigre:obs', e => {
        if (!config || !matcher.settings.enabled || !XAF.captureOn(matcher.settings)) return;
        const d = parse(e);
        if (!d || !Array.isArray(d.obs)) return;
        obsQueue.push(...d.obs);
        if (obsQueue.length > 5000) obsQueue.splice(0, obsQueue.length - 5000);
        if (!obsTimer) obsTimer = setTimeout(flushObs, 2000);
    });
    document.addEventListener('matatigre:hello', () => { if (config) sendConfig(); });

    function sendConfig() {
        document.dispatchEvent(new CustomEvent('matatigre:config', { detail: JSON.stringify(compactConfig(config)) }));
        sendWatch();
    }
    // Cuentas vigiladas: las calcula el service worker a partir del registro y se guardan aparte (cambiarlas no recarga nada).
    let watchIds = [];
    function sendWatch() {
        document.dispatchEvent(new CustomEvent('matatigre:watch', { detail: JSON.stringify({ ids: watchIds }) }));
    }
    function loadWatch() {
        try {
            chrome.storage.local.get('watch').then(r => {
                watchIds = r && r.watch && Array.isArray(r.watch.ids) ? r.watch.ids.slice(0, 600) : [];
                sendWatch();
            }).catch(() => {});
        } catch { /* contexto invalidado */ }
    }
    try { chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.watch) loadWatch(); }); } catch { /* contexto invalidado */ }
    loadWatch();

    // ---------- comunicación con la extensión ----------

    let reportTimer = 0;
    function reportSoon() {
        clearTimeout(reportTimer);
        reportTimer = setTimeout(() => {
            const delta = pending;
            pending = { n: 0, byHandle: {}, byRole: {} };
            try { chrome.runtime.sendMessage({ type: 'xaf:report', hidden: stats.hidden, delta: delta.n ? delta : null, health: lastHealth }).catch(() => {}); } catch { /* contexto invalidado */ }
        }, 500);
    }

    /** Estructura (sin texto) del primer artículo: ayuda a ajustar selectores si X vuelve a cambiar. */
    function skeleton(el, depth = 0) {
        if (depth > 7) return null;
        const o = { t: el.tagName.toLowerCase() };
        for (const a of el.getAttributeNames()) {
            if (a === 'class' || a === 'style' || a.startsWith('aria-') || a === 'id') continue;
            const v = el.getAttribute(a) || '';
            o[a] = /href/.test(a) ? v.replace(/\d{6,}/g, 'N').replace(/\/[A-Za-z0-9_]{1,15}(?=\/status|$)/, '/@h') : v.slice(0, 24);
        }
        const kids = [...el.children].map(c => skeleton(c, depth + 1)).filter(Boolean);
        if (kids.length) o.k = kids;
        return o;
    }

    /** Rutas de campos vistas en las respuestas de X (sin valores) y las que podrían servir para el análisis. */
    function schemaSummary() {
        if (!pageSchema) return null;
        const want = /created|source|media_key|media_id|expanded|join|birth|view|bookmark|quote_count|reply_count|retweet|repost/i;
        const candidates = Object.fromEntries(Object.entries(pageSchema.paths || {}).filter(([p]) => want.test(p)));
        return { tweets: pageSchema.tweets, users: pageSchema.users, candidates, paths: pageSchema.paths };
    }

    function diagnostics() {
        const articles = [...document.querySelectorAll('article')];
        const infos = articles.slice(0, 40).map(readArticle);
        return {
            url: location.pathname.replace(/\/[A-Za-z0-9_]{1,15}(?=\/|$)/, '/@h'),
            scope: loc.scope,
            enabled: !!(config && matcher.settings.enabled),
            mode: matcher.settings.mode,
            activeAccounts: matcher.accountCount,
            rules: matcher.ruleCount,
            dom: {
                articles: articles.length,
                withTestidTweet: document.querySelectorAll('article[data-testid="tweet"]').length,
                anyTestid: document.querySelectorAll('[data-testid]').length,
                withPostId: infos.filter(i => i.id).length,
                withApiHit: infos.filter(i => i.id && hits.has(i.id)).length,
                marked: document.querySelectorAll(`article[${ATTR}]`).length,
                firstArticle: articles[0] ? skeleton(articles[0]) : null
            },
            pageScript: pageDiag || { hooked: false },
            schema: schemaSummary(),
            storedHits: hits.size,
            hiddenThisView: stats.hidden
        };
    }

    // ---------- salud de la extensión en la página ----------
    /**
     * ¿Está funcionando el filtro en esta página? Si X cambia su forma de entregar o de pintar las publicaciones, el filtro dejaría de ocultar
     * sin ningún aviso, que es el peor fallo posible. 'api': X devuelve datos pero no se reconoce ninguna publicación; 'dom': hay
     * publicaciones en pantalla y no se puede leer el id de ninguna; 'ok' también cuando no hay nada que comprobar (no es una cronología).
     */
    function health() {
        const arts = [...document.querySelectorAll('article')].filter(a => { const t = a.getAttribute('data-testid'); return !t || t === 'tweet'; });
        if (arts.length < 3) return 'ok';
        if (pageDiag && pageDiag.graphql >= 3 && pageDiag.posts === 0) return 'api';
        if (document.readyState === 'complete' && !arts.slice(0, 10).some(a => readArticle(a).id)) return 'dom';
        return 'ok';
    }
    let badTicks = 0;
    const healthTimer = setInterval(() => {
        const h = health();
        badTicks = h === 'ok' ? 0 : badTicks + 1;
        const shown = badTicks >= 2 ? h : 'ok';          // dos comprobaciones seguidas: no se avisa por una carga a medias
        if (shown !== lastHealth) { lastHealth = shown; reportSoon(); }
    }, 15000);

    // Tras actualizar o recargar la extensión, las pestañas de X que ya estaban abiertas se quedan con un script huérfano que ya no puede
    // hablar con ella: se avisa para que la persona recargue la página.
    const orphanTimer = setInterval(() => {
        let alive = false;
        try { alive = !!(chrome.runtime && chrome.runtime.id); } catch { alive = false; }
        if (alive) return;
        clearInterval(orphanTimer); clearInterval(healthTimer); observer.disconnect();
        showToast('MATATIGRE se actualizó. Recarga la página para seguir filtrando.', () => location.reload(), { label: 'Recargar', sticky: true, keep: true });
    }, 4000);

    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
        if (msg?.type === 'xaf:getState') {
            respond({
                enabled: !!(config && matcher.settings.enabled),
                mode: matcher.settings.mode,
                hidden: stats.hidden,
                recent: stats.recent,
                pageHandle: loc.kind === 'profile' || loc.kind === 'status' ? loc.handle : null,
                scope: loc.scope,
                accounts: matcher.accountCount,
                rules: matcher.ruleCount,
                api: !!(pageDiag && pageDiag.graphql),
                health: health()
            });
        } else if (msg?.type === 'xaf:menuAdd' && typeof msg.handle === 'string' && XAF.normalizeHandle(msg.handle)) {
            const h = XAF.normalizeHandle(msg.handle);
            if (msg.act === 'show') alwaysShow(h); else addAccount(h, msg.list ? [String(msg.list)] : []);
            respond({ ok: true });
        } else if (msg?.type === 'xaf:getDiagnostics') {
            respond(diagnostics());
        } else if (msg?.type === 'xaf:rescan') {
            rescan();
            respond({ ok: true });
        }
    });

    // Clic en una publicación colapsada: revelarla sin abrir la publicación.
    document.addEventListener('click', e => {
        const el = e.target instanceof Element && e.target.closest(`article[${ATTR}="collapsed"]`);
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        el.setAttribute(ATTR, 'revealed');
    }, true);

    function applyConfig(cfg) {
        config = cfg;
        matcher = createMatcher(cfg);
        hits = new Map();
        try { localStorage.setItem(CFG_KEY, JSON.stringify(compactConfig(cfg))); } catch { /* almacenamiento bloqueado */ }
        sendConfig();            // el script de página responde (síncrono) con los hits actualizados
        resetCounts();
        rescan();
    }

    window.addEventListener('popstate', () => { if (location.pathname !== lastPath) navigate(); });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    XAF.store.loadMeta().then(m => { meta = m; }).catch(() => {});
    XAF.store.load().then(applyConfig);
    XAF.store.onChange(() => XAF.store.load().then(applyConfig));
})();
