(async function () {
    const $ = id => document.getElementById(id);
    const { normalizeHandle } = XAF;
    let cfg = await XAF.store.load();
    let tabId = null, pageHandle = null;

    const say = (t, bad) => { $('msg').textContent = t; $('msg').style.color = bad ? 'var(--danger)' : ''; };
    const QUICK = { qQuoted: 'filterQuoted', qReposters: 'filterReposters', qReplies: 'filterReplies', qMentions: 'filterMentions' };

    function render() {
        $('enabled').checked = cfg.settings.enabled;
        $('mode').value = cfg.settings.mode;
        for (const [id, key] of Object.entries(QUICK)) $(id).checked = !!cfg.settings[key];
        $('status').textContent = cfg.settings.enabled ? 'Filtrado activo' : 'Filtrado pausado';
    }

    async function ask(type) {
        if (tabId == null) return null;
        try { return await chrome.tabs.sendMessage(tabId, { type }); } catch { return null; }
    }

    async function refreshState() {
        const st = await ask('xaf:getState');
        const pill = $('apiState');
        if (!st) {
            $('hidden').textContent = '–';
            $('accounts').textContent = Object.values(cfg.accounts).filter(a => a.enabled !== false).length;
            pill.textContent = tabId == null ? '' : 'La página no responde: recarga x.com (F5).';
            pill.className = 'pill warn';
            return;
        }
        $('hidden').textContent = st.hidden;
        $('accounts').textContent = st.accounts;
        pill.textContent = st.api ? `Lectura de la API de X activa · ámbito: ${st.scope}` : 'Aún sin datos de la API de X (se usa solo el DOM). Recarga x.com si no cambia.';
        pill.className = st.api ? 'pill ok' : 'pill warn';
        pageHandle = st.pageHandle;
        const btn = $('addPage');
        if (pageHandle && !cfg.accounts[pageHandle]) {
            btn.hidden = false;
            btn.textContent = `Añadir @${pageHandle} (perfil abierto)`;
        } else {
            btn.hidden = true;
        }
        const ROLE = { reposter: 'repost', quoted: 'cita', replyTo: 'respuesta', mention: 'mención', text: 'texto', lang: 'idioma' };
        $('recent').replaceChildren(...st.recent.slice(0, 8).map(r => {
            const li = document.createElement('li');
            const who = document.createElement('span');
            who.textContent = r.handle ? '@' + r.handle : r.label;
            const how = document.createElement('span');
            how.textContent = ROLE[r.role] || '';
            li.append(who, how);
            return li;
        }));
    }

    async function addHandle(raw) {
        const h = normalizeHandle(raw);
        if (!h) return say('Handle no válido.', true);
        const existing = cfg.accounts[h];
        if (existing && existing.enabled !== false) return say(`@${h} ya está en la lista.`);
        cfg.accounts[h] = existing
            ? { ...existing, enabled: true, touched: true }
            : { handle: h, name: '', tags: [], note: '', enabled: true, source: 'manual', touched: true };
        cfg.allowlist = cfg.allowlist.filter(x => normalizeHandle(x) !== h);
        await XAF.store.save({ accounts: cfg.accounts, allowlist: cfg.allowlist });
        say(`@${h} añadido.`);
        $('handle').value = '';
        render();
        refreshState();
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab && /^https?:\/\/(?:[^/]+\.)?(?:x|twitter)\.com\//.test(tab.url || '') ? tab.id : null;
    if (tabId == null) say('Abre x.com para ver el estado de la página.');

    render();
    refreshState();
    setInterval(refreshState, 1500);
    XAF.store.onChange(async () => { cfg = await XAF.store.load(); render(); });

    const setSetting = async (key, value) => {
        cfg.settings[key] = value;
        await XAF.store.save({ settings: cfg.settings });
        render();
    };
    $('enabled').addEventListener('change', e => setSetting('enabled', e.target.checked));
    $('mode').addEventListener('change', e => setSetting('mode', e.target.value));
    for (const [id, key] of Object.entries(QUICK)) $(id).addEventListener('change', e => setSetting(key, e.target.checked));
    $('add').addEventListener('submit', e => { e.preventDefault(); addHandle($('handle').value); });
    $('addPage').addEventListener('click', () => addHandle(pageHandle));
    $('options').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
    $('diag').addEventListener('click', async () => {
        const d = await ask('xaf:getDiagnostics');
        const manifest = chrome.runtime.getManifest();
        const text = JSON.stringify({ extension: `${manifest.name} ${manifest.version}`, userAgent: navigator.userAgent, settings: cfg.settings, tab: d || 'sin respuesta del content script (¿pestaña de x.com recargada?)' }, null, 1);
        try { await navigator.clipboard.writeText(text); say('Diagnóstico copiado al portapapeles.'); }
        catch { say('No se pudo copiar.', true); }
    });
})();
