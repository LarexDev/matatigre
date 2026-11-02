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
    const stats = { hidden: 0, recent: [] };
    let pageDiag = null;
    let pending = { n: 0, byHandle: {}, byRole: {} };

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

    // ---------- decisión y aplicación ----------

    function clear(article) {
        if (article.getAttribute(ATTR) === 'revealed') return;
        article.removeAttribute(ATTR);
        article.removeAttribute(LABEL_ATTR);
        const row = rowOf(article);
        if (row) row.removeAttribute(ITEM_ATTR);
    }

    const roleText = { reposter: ' (repost)', quoted: ' (cita)', replyTo: ' (respuesta)', mention: ' (mención)' };

    function count(id, verdict, via) {
        const key = id || Math.random().toString(36);
        if (counted.has(key)) return;
        counted.add(key);
        stats.hidden++;
        const h = verdict.handle || '?';
        stats.recent.unshift({ handle: verdict.handle, role: verdict.role, label: verdict.label, via, at: Date.now() });
        if (stats.recent.length > MAX_RECENT) stats.recent.length = MAX_RECENT;
        pending.n++;
        pending.byHandle[h] = (pending.byHandle[h] || 0) + 1;
        pending.byRole[verdict.role] = (pending.byRole[verdict.role] || 0) + 1;
        reportSoon();
    }

    function apply(article, id, verdict) {
        const mode = matcher.settings.mode;
        const label = `MATATIGRE · ${verdict.label}${roleText[verdict.role] || ''}`;
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
        if (marks.get(article) === sig) return;
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
    }

    function resetCounts() {
        counted.clear();
        stats.hidden = 0;
        stats.recent = [];
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
        for (const d of drops) count(d.id, { handle: d.handle, role: d.role, label: d.label }, 'api');
    });

    document.addEventListener('matatigre:diag', e => { pageDiag = parse(e); });
    document.addEventListener('matatigre:hello', () => { if (config) sendConfig(); });

    function sendConfig() {
        document.dispatchEvent(new CustomEvent('matatigre:config', { detail: JSON.stringify(compactConfig(config)) }));
    }

    // ---------- comunicación con la extensión ----------

    let reportTimer = 0;
    function reportSoon() {
        clearTimeout(reportTimer);
        reportTimer = setTimeout(() => {
            const delta = pending;
            pending = { n: 0, byHandle: {}, byRole: {} };
            try { chrome.runtime.sendMessage({ type: 'xaf:report', hidden: stats.hidden, delta: delta.n ? delta : null }).catch(() => {}); } catch { /* contexto invalidado */ }
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
            storedHits: hits.size,
            hiddenThisView: stats.hidden
        };
    }

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
                api: !!(pageDiag && pageDiag.graphql)
            });
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
    XAF.store.load().then(applyConfig);
    XAF.store.onChange(() => XAF.store.load().then(applyConfig));
})();
