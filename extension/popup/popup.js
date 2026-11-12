(async function () {
    const $ = id => document.getElementById(id);
    const { normalizeHandle } = XAF;
    let cfg = await XAF.store.load();
    let tabId = null, pageHandle = null, recentKey = '';
    let pauseUntil = (await chrome.storage.local.get('pauseUntil')).pauseUntil || 0;

    const say = (t, bad) => { $('msg').textContent = t; $('msg').style.color = bad ? 'var(--danger)' : ''; };
    const QUICK = { qQuoted: 'filterQuoted', qReposters: 'filterReposters', qReplies: 'filterReplies', qMentions: 'filterMentions' };

    function renderAdd() {
        const own = Object.entries(cfg.myLists).sort((a, b) => a[1].name.localeCompare(b[1].name, 'es'));
        const cur = $('addList').value;
        $('addList').replaceChildren(...own.map(([id, m]) => Object.assign(document.createElement('option'), { value: id, textContent: m.name })));
        if (cur && cfg.myLists[cur]) $('addList').value = cur;
        $('add').hidden = !own.length;
        $('noLists').hidden = !!own.length;
    }

    function render() {
        renderAdd();
        $('enabled').checked = cfg.settings.enabled;
        $('mode').value = cfg.settings.mode;
        for (const [id, key] of Object.entries(QUICK)) $(id).checked = !!cfg.settings[key];
        const until = !cfg.settings.enabled && pauseUntil > Date.now() ? new Date(pauseUntil).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
        $('status').textContent = cfg.settings.enabled ? 'Filtrado activo' : until ? 'Pausado hasta las ' + until : 'Filtrado pausado';
        $('pauseFor').hidden = !cfg.settings.enabled;
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
            $('accounts').textContent = XAF.createMatcher(cfg).accountCount;
            pill.textContent = tabId == null ? '' : 'Recarga x.com (F5) para activar el filtro.';
            pill.className = 'pill warn';
            return;
        }
        $('hidden').textContent = st.hidden;
        $('accounts').textContent = st.accounts;
        const broken = st.health === 'api' || st.health === 'dom';
        pill.textContent = broken ? 'X cambió y el filtro puede fallar. Copia el informe en Opciones → Datos.' : st.api ? '' : 'Recarga x.com (F5) para activar el filtro.';
        pill.className = broken || !st.api ? 'pill warn' : 'pill ok';
        pageHandle = st.pageHandle;
        const btn = $('addPage');
        if (pageHandle && !XAF.createMatcher(cfg).matchHandle(pageHandle)) {
            btn.hidden = false;
            btn.textContent = `Añadir @${pageHandle}`;
        } else {
            btn.hidden = true;
        }
        // solo se redibuja si cambió, para no perder un clic en «Siempre mostrar»
        const recent = st.recent.slice(0, 8), key = JSON.stringify(recent.map(r => [r.handle, r.role, r.lists]));
        if (key !== recentKey) {
            recentKey = key;
            $('recent').replaceChildren(...recent.map(r => {
                const li = document.createElement('li'), main = document.createElement('div');
                const who = document.createElement('span');
                who.textContent = XAF.whyPhrase(r.role, r.handle, r.label);
                const why = document.createElement('span');
                why.className = 'muted small';
                why.textContent = r.lists && r.lists.length ? (r.lists.length === 1 ? 'lista ' : 'listas ') + r.lists.map(n => '«' + n + '»').join(', ') : (r.label && !/^@/.test(r.label) && r.label !== who.textContent ? r.label : '');
                main.append(who, why);
                li.append(main);
                if (r.handle) {
                    const b = document.createElement('button');
                    b.type = 'button'; b.className = 'link small'; b.textContent = 'Siempre mostrar'; b.title = 'Dejar de ocultar a esta cuenta';
                    b.addEventListener('click', () => alwaysShow(r.handle));
                    li.append(b);
                }
                return li;
            }));
        }
    }

    async function alwaysShow(raw) {
        const h = normalizeHandle(raw);
        if (!h) return;
        if (!cfg.allowlist.includes(h)) { cfg.allowlist = [...cfg.allowlist, h]; await XAF.store.save({ allowlist: cfg.allowlist }); }
        say(`@${h} se mostrará siempre.`);
    }

    async function addHandle(raw) {
        const h = normalizeHandle(raw);
        if (!h) return say('Escribe un @usuario o el enlace de su perfil.', true);
        const list = $('addList').value;
        if (!list || !cfg.myLists[list]) return say('Elige una de tus listas.', true);
        if (XAF.createMatcher(cfg).matchHandle(h)) return say(`@${h} ya está.`);
        XAF.myLists.addAccounts(cfg, [h], [list]);
        await XAF.store.save({ accounts: cfg.accounts, allowlist: cfg.allowlist, disabled: cfg.disabled });
        say(`@${h} añadido a «${cfg.myLists[list].name}».`);
        $('handle').value = '';
        render();
        refreshState();
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab && /^https?:\/\/(?:[^/]+\.)?(?:x|twitter)\.com\//.test(tab.url || '') ? tab.id : null;
    if (tabId == null) say('Abre x.com para usar la extensión.');

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
    // pausa con vuelta automática: la reanuda el service worker aunque cierres esto
    $('pauseFor').addEventListener('change', async e => {
        const minutes = Number(e.target.value);
        e.target.value = '';
        if (minutes) await chrome.runtime.sendMessage({ type: 'xaf:pause', minutes }).catch(() => null);
    });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && 'pauseUntil' in ch) { pauseUntil = (ch.pauseUntil.newValue) || 0; render(); } });
    $('mode').addEventListener('change', e => setSetting('mode', e.target.value));
    for (const [id, key] of Object.entries(QUICK)) $(id).addEventListener('change', e => setSetting(key, e.target.checked));
    $('add').addEventListener('submit', e => { e.preventDefault(); addHandle($('handle').value); });
    $('addPage').addEventListener('click', () => addHandle(pageHandle));
    $('options').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
    $('newList').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'xaf:openOptions', hash: '#lists/new' }).finally(() => window.close()); });
})();
