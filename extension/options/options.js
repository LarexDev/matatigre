(async function () {
    const $ = id => document.getElementById(id);
    const { normalizeHandle, createMatcher } = XAF;
    const PAGE_SIZE = 100;

    let cfg = await XAF.store.load();
    let meta = await XAF.store.loadMeta();
    const ask = msg => chrome.runtime.sendMessage({ type: 'xaf:lists', ...msg });

    const el = (tag, props = {}, ...kids) => {
        const n = Object.assign(document.createElement(tag), props);
        n.append(...kids.filter(k => k != null));
        return n;
    };
    const persist = (...keys) => XAF.store.save(Object.fromEntries(keys.map(k => [k, cfg[k]])));

    // ---------- pestañas ----------
    const TABS = [...document.querySelectorAll('.tabs button')].map(b => b.dataset.tab);
    function showTab(name, sub) {
        if (!TABS.includes(name) || (name === 'analysis' && !cfg.settings.analyst)) name = 'lists';
        for (const x of document.querySelectorAll('.tabs button')) x.setAttribute('aria-selected', x.dataset.tab === name);
        for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== 'tab-' + name;
        if (name === 'analysis') AnalysisTab.onShow(sub);
        return name;
    }
    for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => { history.replaceState(null, '', '#' + b.dataset.tab); showTab(b.dataset.tab); });
    // flechas izquierda y derecha cambian de pestaña, como en cualquier barra de pestañas
    document.querySelector('.tabs').addEventListener('keydown', e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const btns = [...document.querySelectorAll('.tabs button')], i = btns.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        const next = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
        next.focus(); next.click();
    });
    function route() {
        const [tab, sub] = location.hash.replace(/^#/, '').split('/');
        showTab(tab || 'lists', sub);
        if (tab === 'lists' && sub === 'new') { history.replaceState(null, '', '#lists'); ListsView.newList(); }
    }
    window.addEventListener('hashchange', route);

    // ---------- reglas ----------
    const KIND = { handle: 'Usuario (@)', name: 'Nombre visible', bio: 'Biografía', text: 'Texto', lang: 'Idioma' };
    const MODE = { glob: 'Comodín', contains: 'Contiene', regex: 'Regex' };

    function renderRules() {
        if (!cfg.rules.length) { $('ruleRows').replaceChildren(el('tr', { className: 'empty-row' }, el('td', { colSpan: 6, className: 'muted', textContent: 'Aún no tienes reglas. Las listas suelen bastar; añade una regla solo para casos concretos.' }))); return; }
        $('ruleRows').replaceChildren(...cfg.rules.map((r, i) => {
            const on = el('input', { type: 'checkbox', checked: r.enabled !== false, ariaLabel: 'Activar regla' });
            on.addEventListener('change', async () => { cfg.rules[i] = { ...r, enabled: on.checked }; await persist('rules'); });
            return el('tr', {},
                el('td', { className: 'c-on' }, on),
                el('td', { textContent: KIND[r.kind] }), el('td', { textContent: MODE[r.mode] }),
                el('td', {}, el('code', { textContent: r.pattern })), el('td', { className: 'note', textContent: r.note || '' }),
                el('td', {}, el('button', { className: 'danger', textContent: 'Eliminar', onclick: async () => { cfg.rules.splice(i, 1); await persist('rules'); renderRules(); } })));
        }));
    }

    $('ruleForm').addEventListener('submit', async e => {
        e.preventDefault();
        const mode = $('rMode').value, pattern = $('rPattern').value.trim();
        if (!XAF.compilePattern(mode, pattern)) { $('ruleMsg').textContent = 'Patrón no válido.'; $('ruleMsg').style.color = 'var(--danger)'; return; }
        cfg.rules.push({ id: crypto.randomUUID(), kind: $('rKind').value, mode, pattern, note: $('rNote').value.trim(), enabled: true });
        await persist('rules');
        $('rPattern').value = $('rNote').value = '';
        $('ruleMsg').textContent = 'Regla añadida.'; $('ruleMsg').style.color = '';
        renderRules();
    });

    $('tRun').addEventListener('click', () => {
        const m = createMatcher(cfg);
        const v = m.evaluate({ author: $('tHandle').value, authorName: $('tName').value, text: $('tText').value });
        $('tOut').textContent = v ? `Se ocultaría: ${v.label} (${v.role}).` : 'No coincide: se mostraría.';
    });

    // ---------- lista blanca ----------
    function renderAllow() {
        if (!cfg.allowlist.length) { $('allowRows').replaceChildren(el('li', { className: 'muted', textContent: 'Ninguna excepción todavía.' })); return; }
        $('allowRows').replaceChildren(...cfg.allowlist.map((h, i) => el('li', {}, '@' + h,
            el('button', { textContent: '✕', ariaLabel: `Quitar @${h}`, onclick: async () => { cfg.allowlist.splice(i, 1); await persist('allowlist'); renderAllow(); } }))));
    }
    $('allowForm').addEventListener('submit', async e => {
        e.preventDefault();
        const h = normalizeHandle($('allowHandle').value);
        if (!h || cfg.allowlist.includes(h)) return;
        cfg.allowlist.push(h);
        await persist('allowlist');
        $('allowHandle').value = '';
        renderAllow();
    });

    // ---------- ajustes ----------
    const SETTINGS = {
        sDeep: 'deepFilter', sReposters: 'filterReposters', sQuoted: 'filterQuoted', sReplies: 'filterReplies', sMentions: 'filterMentions',
        sUserCells: 'filterUserCells', sPause: 'pauseOnProfile', sFocal: 'keepFocal', sBar: 'showBar', sAddBtn: 'addButton', sObserve: 'observe', sWatch: 'watch'
    };
    const SCOPE_LABELS = { home: 'Inicio', search: 'Búsqueda', profile: 'Perfiles', status: 'Publicación abierta e hilos', list: 'Listas', notifications: 'Notificaciones', bookmarks: 'Guardados', other: 'Otras páginas' };

    function renderSettings() {
        $('enabled').checked = cfg.settings.enabled;
        $('masterLabel').textContent = cfg.settings.enabled ? 'Filtrado activo' : 'Filtrado pausado';
        $('sMode').value = cfg.settings.mode;
        $('sTextDays').value = cfg.settings.keepTextDays;
        for (const [id, key] of Object.entries(SETTINGS)) $(id).checked = !!cfg.settings[key];
        renderProfile();
        $('sAnalyst').checked = !!cfg.settings.analyst;
        $('analystOpts').hidden = !cfg.settings.analyst;
        document.querySelector('.tabs [data-tab="analysis"]').hidden = !cfg.settings.analyst;
        $('scopes').replaceChildren(...XAF.SCOPES.map(sc => {
            const box = el('input', { type: 'checkbox', checked: cfg.settings.scope[sc] !== false });
            box.addEventListener('change', async () => { cfg.settings.scope = { ...cfg.settings.scope, [sc]: box.checked }; await persist('settings'); });
            return el('label', { className: 'chk' }, box, SCOPE_LABELS[sc]);
        }));
    }
    // perfiles de un clic (ver XAF.PROFILES): lo demás de los ajustes no se toca
    const PROFILE_HINT = { strict: 'Oculta también las respuestas a las cuentas y las menciones.', moderate: 'Autor, reposts y citas: lo recomendado para empezar.', mark: 'No oculta nada: marca con color lo que se ocultaría.' };
    function renderProfile() {
        const cur = XAF.profileOf(cfg.settings);
        for (const b of document.querySelectorAll('#profileSeg button')) b.setAttribute('aria-pressed', String(b.dataset.profile === cur));
        $('profileHint').textContent = cur ? PROFILE_HINT[cur] : 'Personalizado: has cambiado ajustes a mano.';
    }
    for (const b of document.querySelectorAll('#profileSeg button')) b.addEventListener('click', async () => { Object.assign(cfg.settings, XAF.PROFILES[b.dataset.profile]); await persist('settings'); renderSettings(); });
    function renderTheme() { for (const b of document.querySelectorAll('#themeSeg button')) b.setAttribute('aria-pressed', String(b.dataset.theme === cfg.settings.theme)); }
    for (const b of document.querySelectorAll('#themeSeg button')) b.addEventListener('click', async () => { cfg.settings.theme = b.dataset.theme; MTTheme.apply(b.dataset.theme); await persist('settings'); renderTheme(); });
    $('sTextDays').addEventListener('change', async e => {
        const n = Math.min(365, Math.max(1, Math.round(Number(e.target.value)) || 14));
        e.target.value = n;
        cfg.settings.keepTextDays = n;
        await persist('settings');
    });
    // Modo analista: sin él no hay pestaña Análisis ni registro. Al activarlo se enciende el registro (para eso se activa).
    $('sAnalyst').addEventListener('change', async e => {
        cfg.settings.analyst = e.target.checked;
        if (e.target.checked) cfg.settings.observe = true;
        await persist('settings');
        renderSettings();
        if (!cfg.settings.analyst && !$('tab-analysis').hidden) { history.replaceState(null, '', '#settings'); showTab('settings'); }
    });
    $('anResume').addEventListener('click', async () => { cfg.settings.observe = true; await persist('settings'); $('anNoData').hidden = true; renderSettings(); });
    $('enabled').addEventListener('change', async e => { cfg.settings.enabled = e.target.checked; await persist('settings'); renderSettings(); });
    $('sMode').addEventListener('change', async e => { cfg.settings.mode = e.target.value; await persist('settings'); renderProfile(); });
    for (const [id, key] of Object.entries(SETTINGS)) $(id).addEventListener('change', async e => { cfg.settings[key] = e.target.checked; await persist('settings'); renderProfile(); });

    // ---------- estadísticas ----------
    const ROLE_LABELS = { author: 'Autor', reposter: 'Repost', quoted: 'Cita', replyTo: 'Respuesta', mention: 'Mención', text: 'Texto', lang: 'Idioma' };
    const row = (a, b) => el('tr', {}, el('td', { textContent: a }), el('td', { className: 'num', textContent: String(b) }));

    async function renderStats() {
        const s = await XAF.store.loadStats();
        $('statsSummary').textContent = `${s.total} publicaciones filtradas desde ${s.since}. Cuenta cada publicación una vez por carga de página, en cualquier modo.`;
        $('statsRoles').replaceChildren(...Object.entries(s.byRole).sort((x, y) => y[1] - x[1]).map(([r, n]) => row(ROLE_LABELS[r] || r, n)));
        $('statsDays').replaceChildren(...Object.entries(s.byDay).sort().slice(-10).reverse().map(([d, n]) => row(d, n)));
        $('statsTop').replaceChildren(...Object.entries(s.byHandle).sort((x, y) => y[1] - x[1]).slice(0, 25).map(([h, n]) => row('@' + h, n)));
    }
    $('statsReset').addEventListener('click', async () => {
        if (!(await MTUI.confirm({ title: 'Reiniciar los contadores', message: 'Las estadísticas de filtrado volverán a cero.', confirm: 'Reiniciar', danger: true }))) return;
        await chrome.storage.local.set({ [XAF.store.STATS_KEY]: XAF.store.emptyStats() });
        renderStats();
    });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && XAF.store.STATS_KEY in ch) renderStats(); });

    // ---------- datos ----------
    const say = (t, bad) => MTUI.toast(t, { error: !!bad });
    const BACKUP_DAYS = 30;
    /** Cuándo fue la última copia; si hay algo que perder y pasó mucho tiempo (o nunca se hizo), se avisa con un punto en la pestaña. */
    function renderBackup() {
        const has = Object.keys(cfg.accounts).length + Object.keys(cfg.myLists).length > 0;
        const days = meta.lastBackup ? Math.floor((Date.now() - meta.lastBackup) / 864e5) : null;
        const due = has && (days === null || days >= BACKUP_DAYS);
        $('backupInfo').textContent = !has ? 'Cuando tengas listas propias podrás exportar una copia.' : days === null ? 'Aún no has exportado ninguna copia.' : days === 0 ? 'Última copia: hoy.' : `Última copia: hace ${days} ${days === 1 ? 'día' : 'días'}.`;
        $('backupInfo').classList.toggle('due', due);
        document.querySelector('.tabs [data-tab="data"]').classList.toggle('due', due);
    }
    function renderData() {
        renderBackup();
        const total = cfg.subs.reduce((n, s) => n + ((cfg.listData[s.id] || { accounts: [] }).accounts.length), 0);
        $('seedInfo').textContent = `${cfg.subs.length} listas sincronizadas (${total} cuentas) · ${Object.keys(cfg.myLists).length} listas propias con ${Object.keys(cfg.accounts).length} cuentas`;
    }
    async function renderRegistry() {
        const r = await chrome.runtime.sendMessage({ type: 'xaf:data', op: 'stats' }).catch(() => null);
        const fmt = ts => new Date(ts).toLocaleDateString('es', { dateStyle: 'medium' });
        $('obsInfo').textContent = r && r.ok
            ? (r.obs ? `Registro: ${r.obs} publicaciones y ${r.profiles} cuentas (de ${fmt(r.oldest)} a ${fmt(r.newest)}).` : 'Registro vacío.')
            : '';
    }
    $('obsClear').addEventListener('click', async () => {
        if (!(await MTUI.confirm({ title: 'Borrar el registro', message: 'Se borrará todo el registro local del análisis. No se puede deshacer.', confirm: 'Borrar', danger: true }))) return;
        await chrome.runtime.sendMessage({ type: 'xaf:data', op: 'clear' }).catch(() => null);
        say('Registro borrado.');
        renderRegistry();
    });
    $('export').addEventListener('click', async () => {
        const backup = {
            version: 3, settings: cfg.settings, accounts: cfg.accounts, myLists: cfg.myLists, lists: cfg.lists, listModes: cfg.listModes, rules: cfg.rules, allowlist: cfg.allowlist, disabled: cfg.disabled,
            subs: cfg.subs.map(({ id, name, source, url }) => ({ id, name, source, ...(source === 'custom' ? { url } : {}) })),
            topics: await AnalysisTab.exportTopics()
        };
        const blob = new Blob([JSON.stringify(backup, null, 1)], { type: 'application/json' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `matatigre-${new Date().toISOString().slice(0, 10)}.json` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        meta = await XAF.store.saveMeta({ lastBackup: Date.now() });
        renderBackup();
        say('Copia exportada.');
    });
    $('diag').addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ url: ['*://x.com/*', '*://*.x.com/*', '*://twitter.com/*', '*://*.twitter.com/*'] });
        let d = null;
        if (tab) { try { d = await chrome.tabs.sendMessage(tab.id, { type: 'xaf:getDiagnostics' }); } catch { /* pestaña sin recargar */ } }
        const manifest = chrome.runtime.getManifest();
        const text = JSON.stringify({ extension: `${manifest.name} ${manifest.version}`, userAgent: navigator.userAgent, settings: cfg.settings, tab: d || 'sin datos (abre x.com y recárgalo)' }, null, 1);
        try { await navigator.clipboard.writeText(text); say('Informe copiado.'); } catch { say('No se pudo copiar.', true); }
    });
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', async e => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
            const raw = JSON.parse(await file.text());
            const d = XAF.sanitizeConfig(raw);
            const topicsAdded = await AnalysisTab.mergeTopics(raw && raw.topics);
            if (!Object.keys(d).length && !topicsAdded) throw new Error('formato');
            // Importar suma a lo que ya tienes (cuentas y reglas); los ajustes sí se reemplazan.
            const before = Object.keys(cfg.accounts).length;
            const next = {};
            if (d.settings) next.settings = d.settings;
            if (d.accounts) next.accounts = { ...cfg.accounts, ...d.accounts };
            if (d.myLists) next.myLists = { ...cfg.myLists, ...d.myLists };
            if (d.lists) next.lists = { ...cfg.lists, ...d.lists };
            if (d.listModes) next.listModes = { ...cfg.listModes, ...d.listModes };
            if (d.allowlist) next.allowlist = [...new Set([...cfg.allowlist, ...d.allowlist])];
            if (d.disabled) next.disabled = [...new Set([...cfg.disabled, ...d.disabled])];
            if (d.rules) next.rules = [...cfg.rules, ...d.rules.filter(r => !cfg.rules.some(x => x.kind === r.kind && x.mode === r.mode && x.pattern === r.pattern))];
            await XAF.store.save(next);
            const wanted = (d.catalogSubs || []).filter(id => !cfg.subs.some(s => s.id === id));
            let extra = '';
            if (wanted.length) {
                if (await MTUI.confirm({ title: 'Descargar listas', message: `El archivo incluye ${wanted.length} ${wanted.length === 1 ? 'lista sincronizada' : 'listas sincronizadas'}. ¿Descargarlas ahora?`, confirm: 'Descargar' })) {
                    const r = await ask({ op: 'subscribe', ids: wanted });
                    extra = r && r.ok && !r.failed.length ? ` ${r.added.length} listas añadidas.` : ' No se pudieron descargar las listas.';
                }
            }
            cfg = await XAF.store.load();
            say(`Importado: ${Object.keys(cfg.accounts).length - before} cuentas nuevas.${extra}`);
            renderAll();
        } catch { say('Archivo no válido.', true); }
    });
    $('reset').addEventListener('click', async () => {
        if (!(await MTUI.confirm({ title: 'Restablecer todo', message: 'Se borrarán tus listas, cuentas, reglas y ajustes y empezarás de cero.' + (meta.lastBackup ? '' : ' No has exportado ninguna copia.'), confirm: 'Restablecer', danger: true }))) return;
        await chrome.storage.local.clear();
        window.open(chrome.runtime.getURL('welcome/welcome.html'));
        cfg = await XAF.store.load();
        meta = await XAF.store.loadMeta();
        say('Restablecido.');
        renderAll();
    });

    function renderAll() { renderSettings(); renderTheme(); ListsView.render(); renderRules(); renderAllow(); renderData(); renderStats(); renderRegistry(); }
    ListsView.init({ cfg: () => cfg, meta: () => meta, persist, ask });
    await AnalysisTab.init({ cfg: () => cfg, persist, afterListChange: () => ListsView.render() });
    renderAll();
    route();

    XAF.store.onChange(async () => {
        const next = await XAF.store.load();
        if (JSON.stringify(next) === JSON.stringify(cfg)) return;   // cambio hecho desde esta misma página: ya está dibujado
        cfg = next;
        renderAll();
    });
    chrome.storage.onChanged.addListener(async (ch, area) => {
        if (area !== 'local' || !('meta' in ch)) return;
        meta = await XAF.store.loadMeta();
        ListsView.render();
    });
})();
