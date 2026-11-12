(async function () {
    const $ = id => document.getElementById(id);
    const migrate = new URLSearchParams(location.search).has('migrate');
    const ask = msg => chrome.runtime.sendMessage({ type: 'xaf:lists', ...msg });
    const el = (tag, props = {}, ...kids) => {
        const n = Object.assign(document.createElement(tag), props);
        n.append(...kids.filter(k => k != null));
        return n;
    };

    let legacyTags = [];
    if (migrate) {
        $('migrateNote').hidden = false;
        const r = await ask({ op: 'legacy' });
        legacyTags = (r && r.tags) || [];
    }

    let catalog = null;
    const boxes = new Map();

    async function load() {
        $('retry').hidden = true;
        $('go').disabled = true;
        $('state').textContent = 'Cargando…';
        $('state').className = 'muted';
        $('catalog').replaceChildren();
        const r = await ask({ op: 'catalog' });
        if (!r || !r.ok) {
            $('state').textContent = 'No se pudieron cargar las listas. Revisa tu conexión e inténtalo de nuevo.';
            $('state').className = 'err';
            $('retry').hidden = false;
            return;
        }
        catalog = r.catalog;
        $('state').textContent = catalog.lists.length ? '' : 'Todavía no hay listas disponibles.';
        boxes.clear();
        for (const l of catalog.lists) {
            const box = el('input', { type: 'checkbox', checked: migrate ? legacyTags.includes(l.id) : l.recommended, ariaLabel: l.name });
            box.addEventListener('change', update);
            boxes.set(l.id, box);
            $('catalog').append(el('label', { className: 'item' }, box, el('div', {},
                el('strong', { textContent: l.name }),
                el('p', { textContent: l.description }),
                l.count != null ? el('div', { className: 'meta', textContent: `${l.count} cuentas` }) : null)));
        }
        update();
    }

    function update() { $('go').disabled = ![...boxes.values()].some(b => b.checked); }

    $('retry').addEventListener('click', load);

    $('go').addEventListener('click', async () => {
        const ids = [...boxes].filter(([, b]) => b.checked).map(([id]) => id);
        $('go').disabled = true; $('skip').disabled = true;
        $('go').textContent = 'Descargando…';
        const r = await ask({ op: 'subscribe', ids });
        const ok = r && r.ok && r.added.length;
        if (r && r.ok && migrate) await ask({ op: 'prune' });
        $('go').textContent = 'Empezar';
        if (!r || !r.ok || (!ok && r.failed.length)) {
            $('state').textContent = 'No se pudieron descargar las listas. Inténtalo de nuevo.';
            $('state').className = 'err';
            $('go').disabled = false; $('skip').disabled = false;
            return;
        }
        await XAF.store.saveMeta({ welcome: 'done' });
        const names = Object.fromEntries(catalog.lists.map(l => [l.id, l.name]));
        $('done').hidden = false;
        $('doneTitle').textContent = 'Listo';
        $('doneText').textContent = 'Recarga X (F5) para que los cambios se apliquen.';
        $('doneIssues').replaceChildren(...r.failed.map(f => el('li', { textContent: `${names[f.id] || f.id}: no se pudo descargar.` })));
        $('go').hidden = $('skip').hidden = true;
        $('done').scrollIntoView({ behavior: 'smooth' });
    });

    $('skip').addEventListener('click', async () => {
        await XAF.store.saveMeta({ welcome: 'skipped' });
        $('done').hidden = false;
        $('doneTitle').textContent = 'Sin listas por ahora';
        $('doneText').textContent = 'Puedes añadirlas cuando quieras en Opciones.';
        $('go').hidden = $('skip').hidden = true;
    });

    $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

    load();
})();
