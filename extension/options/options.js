(async function () {
    const $ = id => document.getElementById(id);
    const { normalizeHandle, createMatcher } = XAF;
    const PAGE_SIZE = 100;

    let cfg = await XAF.store.load();
    let seed = { lists: {}, accounts: [] };
    try { seed = await XAF.store.readSeed(); } catch { /* sin lista inicial */ }
    if (!cfg.seedMeta) { await XAF.store.seed(); cfg = await XAF.store.load(); }

    let page = 0;
    let editing = null;

    const el = (tag, props = {}, ...kids) => {
        const n = Object.assign(document.createElement(tag), props);
        n.append(...kids.filter(k => k != null));
        return n;
    };
    const persist = (...keys) => XAF.store.save(Object.fromEntries(keys.map(k => [k, cfg[k]])));
    const parseTags = s => [...new Set(s.split(',').map(t => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))];
    const listLabel = t => seed.lists?.[t]?.label || t;
    const allTags = () => [...new Set([...Object.keys(seed.lists || {}), ...Object.values(cfg.accounts).flatMap(a => a.tags || [])])].sort();
    const listEnabled = t => cfg.lists[t] !== false;

    // ---------- pestañas ----------
    for (const b of document.querySelectorAll('.tabs button')) {
        b.addEventListener('click', () => {
            for (const x of document.querySelectorAll('.tabs button')) x.setAttribute('aria-selected', x === b);
            for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== 'tab-' + b.dataset.tab;
        });
    }

    // ---------- cuentas ----------
    function visibleAccounts() {
        const q = XAF.normalizeText($('q').value.trim());
        const tag = $('fTag').value, state = $('fState').value;
        return Object.entries(cfg.accounts)
            .filter(([, a]) => {
                if (tag && !(a.tags || []).includes(tag) && !(tag === '__none' && !(a.tags || []).length)) return false;
                if (state === 'on' && a.enabled === false) return false;
                if (state === 'off' && a.enabled !== false) return false;
                if (!q) return true;
                return XAF.normalizeText(`${a.handle} ${a.name} ${a.note}`).includes(q);
            })
            .sort((x, y) => (y[1].enabled !== false) - (x[1].enabled !== false) || (y[1].mentions || 0) - (x[1].mentions || 0) || x[0].localeCompare(y[0]));
    }

    function renderAccounts() {
        const sel = $('fTag').value;
        $('fTag').replaceChildren(el('option', { value: '', textContent: 'Todas las listas' }),
            ...allTags().map(t => el('option', { value: t, textContent: listLabel(t) })),
            el('option', { value: '__none', textContent: 'Sin lista' }));
        $('fTag').value = sel;
        $('tagList').replaceChildren(...allTags().map(t => el('option', { value: t })));

        const rows = visibleAccounts();
        const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
        page = Math.min(page, pages - 1);
        const slice = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const active = Object.values(cfg.accounts).filter(a => a.enabled !== false).length;
        $('count').textContent = `${rows.length} de ${Object.keys(cfg.accounts).length} cuentas · ${active} activas`;
        $('page').textContent = `Página ${page + 1} de ${pages}`;
        $('prev').disabled = page === 0;
        $('next').disabled = page >= pages - 1;
        $('rows').replaceChildren(...slice.map(([key, a]) => key === editing ? editRow(key, a) : viewRow(key, a)));
    }

    function viewRow(key, a) {
        const on = el('input', { type: 'checkbox', checked: a.enabled !== false, ariaLabel: `Activar @${a.handle}` });
        on.addEventListener('change', async () => {
            cfg.accounts[key] = { ...a, enabled: on.checked, touched: true };
            await persist('accounts');
            renderAccounts();
        });
        const tr = el('tr', { className: a.enabled === false ? 'off' : '' });
        const link = el('a', { href: `https://x.com/${a.handle}`, target: '_blank', rel: 'noopener', textContent: '@' + a.handle });
        const inactiveTags = (a.tags || []).length && !(a.tags || []).some(listEnabled);
        tr.append(
            el('td', { className: 'c-on' }, on),
            el('td', { className: 'handle' }, link, a.source === 'manual' ? el('span', { className: 'badge', textContent: 'manual' }) : null),
            el('td', {}, el('div', { textContent: a.name || '' }), el('div', { className: 'note', textContent: a.note || '', title: a.note || '' })),
            el('td', {}, ...(a.tags || []).map(t => el('span', { className: 'tag', textContent: listLabel(t) })),
                inactiveTags ? el('span', { className: 'badge', textContent: 'lista apagada', title: 'Todas sus listas están desactivadas: no se filtra' }) : null),
            el('td', {}, el('button', { textContent: 'Editar', onclick: () => { editing = key; renderAccounts(); } }),
                ' ', el('button', {
                    className: 'danger', textContent: 'Eliminar', onclick: async () => {
                        delete cfg.accounts[key];
                        await persist('accounts');
                        renderAccounts();
                    }
                }))
        );
        return tr;
    }

    function editRow(key, a) {
        const name = el('input', { type: 'text', value: a.name || '', ariaLabel: 'Nombre' });
        const tags = el('input', { type: 'text', value: (a.tags || []).join(', '), ariaLabel: 'Listas' });
        tags.setAttribute('list', 'tagList');
        const note = el('input', { type: 'text', value: a.note || '', ariaLabel: 'Nota' });
        const handle = el('input', { type: 'text', value: a.handle, ariaLabel: 'Handle' });
        const save = async () => {
            const h = normalizeHandle(handle.value);
            if (!h) return handle.focus();
            const next = { ...a, handle: handle.value.replace(/^@+/, ''), name: name.value.trim(), tags: parseTags(tags.value), note: note.value.trim(), touched: true };
            if (h !== key) delete cfg.accounts[key];
            cfg.accounts[h] = next;
            editing = null;
            await persist('accounts');
            renderAccounts();
        };
        const tr = el('tr', { className: 'edit' },
            el('td', { className: 'c-on' }),
            el('td', {}, handle),
            el('td', {}, name, note),
            el('td', {}, tags),
            el('td', {}, el('button', { className: 'primary', textContent: 'Guardar', onclick: save }), ' ',
                el('button', { textContent: 'Cancelar', onclick: () => { editing = null; renderAccounts(); } }))
        );
        tr.addEventListener('keydown', e => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { editing = null; renderAccounts(); } });
        return tr;
    }

    $('addForm').addEventListener('submit', async e => {
        e.preventDefault();
        const h = normalizeHandle($('addHandle').value);
        if (!h) { $('addHandle').setCustomValidity('Handle no válido'); $('addHandle').reportValidity(); return; }
        $('addHandle').setCustomValidity('');
        const prev = cfg.accounts[h];
        cfg.accounts[h] = {
            handle: $('addHandle').value.trim().replace(/^@+/, '').replace(/^.*(?:x|twitter)\.com\//i, '').split(/[/?#]/)[0] || h,
            name: $('addName').value.trim() || prev?.name || '',
            tags: parseTags($('addTags').value).length ? parseTags($('addTags').value) : (prev?.tags || []),
            note: prev?.note || '', mentions: prev?.mentions, enabled: true, source: prev?.source || 'manual', touched: true
        };
        cfg.allowlist = cfg.allowlist.filter(x => normalizeHandle(x) !== h);
        await persist('accounts', 'allowlist');
        $('addHandle').value = $('addName').value = $('addTags').value = '';
        renderAccounts(); renderAllow();
    });

    for (const id of ['q', 'fTag', 'fState']) $(id).addEventListener('input', () => { page = 0; renderAccounts(); });
    $('prev').addEventListener('click', () => { page--; renderAccounts(); });
    $('next').addEventListener('click', () => { page++; renderAccounts(); });

    async function bulk(fn, confirmMsg) {
        const rows = visibleAccounts();
        if (!rows.length) return;
        if (confirmMsg && !confirm(confirmMsg.replace('{n}', rows.length))) return;
        for (const [key, a] of rows) fn(key, a);
        await persist('accounts');
        renderAccounts();
    }
    $('bulkOn').addEventListener('click', () => bulk((k, a) => { cfg.accounts[k] = { ...a, enabled: true, touched: true }; }));
    $('bulkOff').addEventListener('click', () => bulk((k, a) => { cfg.accounts[k] = { ...a, enabled: false, touched: true }; }));
    $('bulkDel').addEventListener('click', () => bulk(k => { delete cfg.accounts[k]; }, '¿Eliminar {n} cuentas de la lista?'));

    // ---------- listas ----------
    function renderLists() {
        const counts = {};
        for (const a of Object.values(cfg.accounts)) for (const t of a.tags || []) counts[t] = (counts[t] || 0) + 1;
        $('lists').replaceChildren(...allTags().map(t => {
            const sw = el('input', { type: 'checkbox', checked: listEnabled(t), ariaLabel: `Lista ${listLabel(t)}` });
            sw.addEventListener('change', async () => { cfg.lists[t] = sw.checked; await persist('lists'); renderAccounts(); });
            return el('div', { className: 'listcard' },
                el('div', {}, el('strong', { textContent: `${listLabel(t)} · ${counts[t] || 0}` }), el('p', { className: 'muted', textContent: seed.lists?.[t]?.description || 'Lista personalizada.' })),
                el('label', { className: 'switch' }, sw, el('span')));
        }));
    }

    // ---------- reglas ----------
    const KIND = { handle: 'Handle', name: 'Nombre visible', bio: 'Biografía', text: 'Texto', lang: 'Idioma' };
    const MODE = { glob: 'Comodín', contains: 'Contiene', regex: 'Regex' };

    function renderRules() {
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
        sUserCells: 'filterUserCells', sPause: 'pauseOnProfile', sFocal: 'keepFocal'
    };
    const SCOPE_LABELS = { home: 'Inicio', search: 'Búsqueda', profile: 'Perfiles', status: 'Publicación abierta e hilos', list: 'Listas', notifications: 'Notificaciones', bookmarks: 'Guardados', other: 'Otras páginas' };

    function renderSettings() {
        $('enabled').checked = cfg.settings.enabled;
        $('masterLabel').textContent = cfg.settings.enabled ? 'Filtrado activo' : 'Filtrado pausado';
        $('sMode').value = cfg.settings.mode;
        for (const [id, key] of Object.entries(SETTINGS)) $(id).checked = !!cfg.settings[key];
        $('scopes').replaceChildren(...XAF.SCOPES.map(sc => {
            const box = el('input', { type: 'checkbox', checked: cfg.settings.scope[sc] !== false });
            box.addEventListener('change', async () => { cfg.settings.scope = { ...cfg.settings.scope, [sc]: box.checked }; await persist('settings'); });
            return el('label', { className: 'chk' }, box, SCOPE_LABELS[sc]);
        }));
    }
    $('enabled').addEventListener('change', async e => { cfg.settings.enabled = e.target.checked; await persist('settings'); renderSettings(); });
    $('sMode').addEventListener('change', async e => { cfg.settings.mode = e.target.value; await persist('settings'); });
    for (const [id, key] of Object.entries(SETTINGS)) $(id).addEventListener('change', async e => { cfg.settings[key] = e.target.checked; await persist('settings'); });

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
        if (!confirm('¿Reiniciar los contadores?')) return;
        await chrome.storage.local.set({ [XAF.store.STATS_KEY]: XAF.store.emptyStats() });
        renderStats();
    });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && XAF.store.STATS_KEY in ch) renderStats(); });

    // ---------- datos ----------
    const say = (t, bad) => { $('dataMsg').textContent = t; $('dataMsg').style.color = bad ? 'var(--danger)' : ''; };
    function renderData() {
        const m = cfg.seedMeta;
        $('seedInfo').textContent = m ? `Lista inicial: ${m.count} cuentas (${m.generatedAt}).` : 'Sin lista inicial cargada.';
    }
    $('reseed').addEventListener('click', async () => {
        const r = await XAF.store.seed({ force: true });
        cfg = await XAF.store.load();
        say(`Lista inicial fusionada: ${r.added} nuevas, ${r.updated} actualizadas.`);
        renderAll();
    });
    $('export').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify({ version: 1, ...Object.fromEntries(XAF.store.KEYS.map(k => [k, cfg[k]])) }, null, 1)], { type: 'application/json' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `filtro-x-${new Date().toISOString().slice(0, 10)}.json` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', async e => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
            const d = XAF.sanitizeConfig(JSON.parse(await file.text()));
            if (!Object.keys(d).length) throw new Error('formato');
            // Importar suma a lo que ya tienes (cuentas y reglas); los ajustes sí se reemplazan.
            const before = Object.keys(cfg.accounts).length;
            const next = {};
            if (d.settings) next.settings = d.settings;
            if (d.accounts) next.accounts = { ...cfg.accounts, ...d.accounts };
            if (d.lists) next.lists = { ...cfg.lists, ...d.lists };
            if (d.allowlist) next.allowlist = [...new Set([...cfg.allowlist, ...d.allowlist])];
            if (d.rules) next.rules = [...cfg.rules, ...d.rules.filter(r => !cfg.rules.some(x => x.kind === r.kind && x.mode === r.mode && x.pattern === r.pattern))];
            await XAF.store.save(next);
            cfg = await XAF.store.load();
            say(`Importado: ${Object.keys(cfg.accounts).length - before} cuentas nuevas (total ${Object.keys(cfg.accounts).length}).`);
            renderAll();
        } catch { say('Archivo no válido.', true); }
    });
    $('reset').addEventListener('click', async () => {
        if (!confirm('Se borrarán cuentas, reglas y ajustes, y se volverá a cargar la lista inicial. ¿Continuar?')) return;
        await chrome.storage.local.clear();
        await XAF.store.seed({ force: true });
        cfg = await XAF.store.load();
        say('Restablecido.');
        renderAll();
    });

    function renderAll() { renderSettings(); renderAccounts(); renderLists(); renderRules(); renderAllow(); renderData(); renderStats(); }
    renderAll();

    XAF.store.onChange(async () => {
        if (editing) return;
        cfg = await XAF.store.load();
        renderAll();
    });
})();
