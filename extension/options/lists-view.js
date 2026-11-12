/**
 * Pestaña «Listas»: toda la gestión de listas y cuentas en un solo lugar.
 *
 * Dos clases de lista, siempre distinguibles:
 *   · Mis listas (propias): las creas y gestionas tú; puedes añadir, quitar y editar cuentas, renombrar, exportar y borrar.
 *   · Sincronizadas (candado): vienen de fuera y su contenido no se puede modificar. Puedes encenderlas, elegir su modo, omitir cuentas
 *     solo para ti, copiarlas a una lista propia o dejar de seguirlas.
 * Más una vista «Todas las cuentas» para buscar entre todas, y «Explorar» para añadir listas sincronizadas.
 */
(function (root) {
    'use strict';
    const { el, dialog, confirm, prompt, toast } = root.MTUI;
    const L = root.XAF.myLists;
    const { normalizeHandle } = root.XAF;
    const NS = 'http://www.w3.org/2000/svg';
    const PAGE = 100;
    const MODE_LABELS = { '': 'Modo general', hide: 'Ocultar', collapse: 'Colapsar', highlight: 'Resaltar' };
    const $ = id => document.getElementById(id);

    let ctx = null, sel = { kind: 'all' }, view = null;
    const cfg = () => ctx.cfg();
    const byName = (a, b) => a[1].name.localeCompare(b[1].name, 'es');
    const subName = id => { const s = cfg().subs.find(x => x.id === id); return (s && s.name) || id; };
    const listOn = id => cfg().lists[id] !== false;

    function icon(name) {
        const PATHS = { lock: 'M8 1a3 3 0 0 0-3 3v2H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1V4a3 3 0 0 0-3-3zM6.5 4a1.5 1.5 0 0 1 3 0v2h-3V4z' };
        const s = document.createElementNS(NS, 'svg');
        s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', '12'); s.setAttribute('height', '12'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'lm-ico');
        const p = document.createElementNS(NS, 'path'); p.setAttribute('d', PATHS[name]); p.setAttribute('fill', 'currentColor'); s.append(p);
        return s;
    }
    /** Rellena un contenedor ignorando los huecos (null/false), para poder escribir condiciones dentro de la lista de hijos. */
    const fill = (host, ...kids) => host.replaceChildren(...kids.filter(k => k != null && k !== false));
    const persist = (...keys) => ctx.persist(...keys);
    const snapshot = () => { const c = cfg(); return { accounts: c.accounts, myLists: c.myLists, lists: c.lists, listModes: c.listModes, disabled: c.disabled, allowlist: c.allowlist }; };
    async function restore(snap) { Object.assign(cfg(), snap); await persist(...Object.keys(snap)); render(); }

    // ---------- datos para las vistas ----------
    function subAccounts(id) {
        const data = cfg().listData[id];
        return ((data && data.accounts) || []).map(x => ({ key: normalizeHandle(x.handle), handle: x.handle, name: x.name || '' })).filter(x => x.key);
    }
    const omitted = () => new Set(cfg().disabled);
    const ago = ts => { const m = Math.max(1, Math.round((Date.now() - ts) / 60000)), h = Math.round(m / 60), d = Math.round(m / 1440); return m < 60 ? 'hace ' + m + ' min' : m < 1440 ? 'hace ' + h + ' h' : 'hace ' + d + (d === 1 ? ' día' : ' días'); };
    /** Qué cambió la última vez que se actualizó una lista sincronizada (para que nadie la modifique sin que te enteres). */
    function changeNode(ch) {
        if (!ch || ch.first || (!ch.added && !ch.removed)) return null;
        const sum = [ch.added ? '+' + ch.added : '', ch.removed ? '−' + ch.removed : ''].filter(Boolean).join(' · ');
        const part = (title, arr, n) => (arr && arr.length ? el('p', { className: 'small' }, el('b', { textContent: title + ' ' }), arr.map(h => '@' + h).join(', ') + (n > arr.length ? ' y ' + (n - arr.length) + ' más' : '')) : null);
        return el('details', { className: 'lm-changes' + (ch.big ? ' big' : '') },
            el('summary', { className: 'small', textContent: 'Último cambio: ' + sum + ' cuentas' + (ch.big ? ' (cambio grande)' : '') + ' · ' + ago(ch.at) }),
            part('Añadidas:', ch.addedList, ch.added), part('Quitadas:', ch.removedList, ch.removed));
    }

    /** Todas las cuentas con las listas a las que pertenecen (propias y sincronizadas). */
    function allRows() {
        const c = cfg(), off = omitted();
        const own = new Map(Object.entries(c.accounts));
        const rows = new Map();
        for (const s of c.subs) for (const x of subAccounts(s.id)) {
            const r = rows.get(x.key) || rows.set(x.key, { key: x.key, handle: x.handle, name: x.name, note: '', mine: [], synced: [], enabled: true }).get(x.key);
            r.synced.push(s.id); if (!r.name && x.name) r.name = x.name;
        }
        for (const [key, a] of own) {
            const r = rows.get(key) || rows.set(key, { key, handle: a.handle, name: '', note: '', mine: [], synced: [], enabled: true }).get(key);
            r.own = a; r.handle = a.handle; r.name = a.name || r.name; r.note = a.note || '';
            r.mine = (a.tags || []).filter(t => c.myLists[t]);
        }
        for (const r of rows.values()) r.enabled = r.own ? r.own.enabled !== false && !off.has(r.key) : !off.has(r.key);
        return [...rows.values()];
    }

    function pageSlice(rows, state) {
        const pages = Math.max(1, Math.ceil(rows.length / PAGE));
        state.page = Math.min(state.page, pages - 1);
        return { slice: rows.slice(state.page * PAGE, (state.page + 1) * PAGE), pages };
    }
    function pager(state, pages, refresh) {
        if (pages <= 1) return el('div');
        return el('div', { className: 'bar pager' },
            el('button', { textContent: '← Anterior', disabled: state.page === 0, onclick: () => { state.page--; refresh(); } }),
            el('span', { className: 'muted', textContent: `Página ${state.page + 1} de ${pages}` }),
            el('button', { textContent: 'Siguiente →', disabled: state.page >= pages - 1, onclick: () => { state.page++; refresh(); } }));
    }

    const accountLink = (handle) => el('a', { href: `https://x.com/${handle}`, target: '_blank', rel: 'noopener', textContent: '@' + handle });
    const empty = (text, ...extra) => el('div', { className: 'lm-empty' }, el('p', { className: 'muted', textContent: text }), ...extra);

    function listSwitch(id, label) {
        const sw = el('input', { type: 'checkbox', checked: listOn(id), ariaLabel: label });
        sw.addEventListener('change', async () => { cfg().lists[id] = sw.checked; await persist('lists'); renderSide(); view && view.refreshHeader && view.refreshHeader(); });
        return el('label', { className: 'switch', title: 'Filtrar con esta lista' }, sw, el('span'));
    }
    function modeSelect(id) {
        const s = el('select', { ariaLabel: 'Modo de esta lista' }, ...Object.entries(MODE_LABELS).map(([v, t]) => el('option', { value: v, textContent: t })));
        s.value = cfg().listModes[id] || '';
        s.addEventListener('change', async () => { if (s.value) cfg().listModes[id] = s.value; else delete cfg().listModes[id]; await persist('listModes'); });
        return s;
    }

    // ---------- diálogos ----------
    async function newList(afterCreate) {
        const name = await prompt({ title: 'Nueva lista', message: 'Una lista propia agrupa cuentas que tú eliges.', label: 'Nombre de la lista', confirm: 'Crear', validate: v => L.checkName(cfg(), v) });
        if (name === null) return null;
        const id = L.create(cfg(), name);
        await persist('myLists', 'lists');
        select({ kind: 'own', id });
        toast(`Lista «${name}» creada.`);
        if (afterCreate) afterCreate(id);
        return id;
    }

    /** Elige una de tus listas (o crea una nueva) para copiar o asignar cuentas. Devuelve su id o null. */
    async function pickList({ title, message, confirmLabel }) {
        const own = Object.entries(cfg().myLists).sort(byName);
        const select = el('select', { ariaLabel: 'Lista de destino' }, ...own.map(([id, m]) => el('option', { value: id, textContent: m.name })), el('option', { value: '__new', textContent: 'Nueva lista…' }));
        const name = el('input', { type: 'text', placeholder: 'Nombre de la lista nueva', maxLength: 60, ariaLabel: 'Nombre de la lista nueva' });
        const sync = () => { name.hidden = select.value !== '__new'; };
        if (!own.length) select.value = '__new';
        select.addEventListener('change', sync); sync();
        const r = await dialog({
            title, message, body: el('div', { className: 'stack' }, select, name),
            actions: [{ label: 'Cancelar', value: null }, { label: confirmLabel, primary: true, value: () => ({ id: select.value, name: name.value.trim() }), validate: () => (select.value === '__new' ? L.checkName(cfg(), name.value) : '') }]
        });
        if (!r) return null;
        if (r.id !== '__new') return r.id;
        const id = L.create(cfg(), r.name);
        await persist('myLists', 'lists');
        return id;
    }

    async function editAccount(key) {
        const c = cfg(), a = c.accounts[key];
        if (!a) return;
        const name = el('input', { type: 'text', value: a.name || '', maxLength: 120, ariaLabel: 'Nombre', placeholder: 'Nombre (opcional)' });
        const note = el('input', { type: 'text', value: a.note || '', maxLength: 500, ariaLabel: 'Nota', placeholder: 'Nota (opcional)' });
        const boxes = Object.entries(c.myLists).sort(byName).map(([id, m]) => ({ id, box: el('input', { type: 'checkbox', checked: (a.tags || []).includes(id), value: id }), m }));
        const body = el('div', { className: 'stack' }, name, note, el('div', { className: 'muted small', textContent: 'Mis listas' }),
            el('div', { className: 'lm-checks' }, ...boxes.map(b => el('label', { className: 'chk' }, b.box, b.m.name))));
        const r = await dialog({
            title: '@' + a.handle, body,
            actions: [{ label: 'Eliminar cuenta', danger: true, value: 'delete' }, { label: 'Cancelar', value: null },
                { label: 'Guardar', primary: true, value: 'save', validate: () => (boxes.some(b => b.box.checked) ? '' : 'Elige al menos una lista, o elimina la cuenta.') }]
        });
        if (!r) return;
        const snap = snapshot();
        const accounts = { ...c.accounts };
        if (r === 'delete') delete accounts[key];
        else accounts[key] = { ...a, name: name.value.trim(), note: note.value.trim(), tags: [...new Set([...(a.tags || []).filter(t => !c.myLists[t]), ...boxes.filter(b => b.box.checked).map(b => b.id)])], touched: true };
        c.accounts = accounts;
        await persist('accounts');
        render();
        if (r === 'delete') toast(`@${a.handle} eliminada.`, { undo: () => restore(snap) });
    }

    async function removeFromOwn(key, listId) {
        const c = cfg(), snap = snapshot(), a = c.accounts[key];
        const res = L.removeFromList(c, key, listId);
        await persist('accounts');
        render();
        toast(res === 'deleted' ? `@${a.handle} eliminada (no estaba en ninguna otra lista).` : `@${a.handle} quitada de «${c.myLists[listId].name}».`, { undo: () => restore(snap) });
    }

    function parseHandles(text) { return String(text || '').split(/[\s,;]+/).filter(Boolean); }
    async function addHandles(text, listIds) {
        const c = cfg(), snap = snapshot();
        const r = L.addAccounts(c, parseHandles(text), listIds);
        if (!r.added && !r.existing && !r.invalid.length) return false;
        await persist('accounts', 'allowlist', 'disabled');
        render();
        const parts = [];
        if (r.added) parts.push(`${r.added} ${r.added === 1 ? 'cuenta añadida' : 'cuentas añadidas'}`);
        if (r.existing) parts.push(`${r.existing} ya ${r.existing === 1 ? 'estaba' : 'estaban'}`);
        if (r.invalid.length) parts.push(`${r.invalid.length} no ${r.invalid.length === 1 ? 'es válida' : 'son válidas'} (${r.invalid.slice(0, 2).join(', ')}${r.invalid.length > 2 ? '…' : ''})`);
        if (r.limited) parts.push(`${r.limited} sin añadir: límite de ${L.MAX_ACCOUNTS.toLocaleString('es')} cuentas propias`);
        toast(parts.join(' · ') + '.', r.added ? { undo: () => restore(snap) } : { error: !r.existing });
        return true;
    }

    // ---------- barra lateral ----------
    function item(s, name, count, opts = {}) {
        const on = s.kind === 'all' ? true : listOn(s.id);
        const b = el('button', { className: 'lm-item' + (on ? '' : ' off'), type: 'button', title: opts.title || name },
            s.kind === 'sub' ? icon('lock') : null, el('span', { className: 'lm-name', textContent: name }), el('span', { className: 'lm-count', textContent: String(count) }));
        if (sel.kind === s.kind && sel.id === s.id) b.setAttribute('aria-current', 'page');
        b.addEventListener('click', () => select(s));
        return b;
    }
    function renderSide() {
        const c = cfg();
        const total = new Set([...Object.keys(c.accounts), ...c.subs.flatMap(s => subAccounts(s.id).map(x => x.key))]).size;
        const all = $('lmAll'); fill(all, item({ kind: 'all' }, 'Todas las cuentas', total));
        const q = root.XAF.normalizeText($('lmFind').value.trim());
        const mineAll = Object.entries(c.myLists).sort(byName);
        const many = mineAll.length + c.subs.length > 10;
        $('lmFind').hidden = !many;
        const shows = name => !many || !q || root.XAF.normalizeText(name).includes(q);
        const mine = mineAll.filter(([, m]) => shows(m.name));
        fill($('lmMine'), ...(mine.length ? mine.map(([id, m]) => item({ kind: 'own', id }, m.name, L.members(c, id).length)) : [el('p', { className: 'lm-hint', textContent: mineAll.length ? 'Ninguna coincide.' : 'Aún no tienes listas propias.' })]));
        fill($('lmSubs'), ...(c.subs.length ? c.subs.filter(s => shows(s.name || s.id)).map(s => item({ kind: 'sub', id: s.id }, s.name || s.id, subAccounts(s.id).length, { title: `${s.name} · sincronizada, solo lectura` })) : [el('p', { className: 'lm-hint', textContent: 'No sigues ninguna lista sincronizada.' })]));
        const ex = $('lmExplore'); ex.classList.toggle('on', sel.kind === 'explore');
    }

    function select(s) {
        sel = s;
        renderSide();
        renderMain();
        const m = $('lmMain'); if (m.scrollIntoView && innerWidth < 800) m.scrollIntoView({ block: 'start' });
    }
    function render() {
        const c = cfg();
        if ((sel.kind === 'own' && !c.myLists[sel.id]) || (sel.kind === 'sub' && !c.subs.some(s => s.id === sel.id))) sel = { kind: 'all' };
        renderSide();
        renderMain();
    }

    function renderMain() {
        const host = $('lmMain');
        view = sel.kind === 'own' ? ownView(sel.id) : sel.kind === 'sub' ? subView(sel.id) : sel.kind === 'explore' ? exploreView() : allView();
        fill(host, ...view.nodes);
        view.refresh();
    }

    const filterBar = (state, refresh, extra = []) => {
        const q = el('input', { type: 'search', placeholder: 'Buscar por usuario, nombre o nota…', ariaLabel: 'Buscar', value: state.q });
        q.addEventListener('input', () => { state.q = q.value; state.page = 0; refresh(); });
        return { q, nodes: [q, ...extra] };
    };
    const matchQ = (r, q) => !q || root.XAF.normalizeText(`${r.handle} ${r.name} ${r.note || ''}`).includes(root.XAF.normalizeText(q.trim()));

    // ---------- lista propia ----------
    function ownView(id) {
        const st = { q: '', state: '', page: 0 };
        const head = el('div', { className: 'lm-head' }), table = el('div');
        const input = el('input', { type: 'text', placeholder: '@usuario o enlace; puedes pegar varias, separadas por comas o espacios', ariaLabel: 'Cuentas a añadir', autocomplete: 'off', spellcheck: false });
        const addForm = el('form', { className: 'bar' }, input, el('button', { className: 'primary', type: 'submit', textContent: 'Añadir' }));
        addForm.addEventListener('submit', async e => { e.preventDefault(); if (await addHandles(input.value, [id])) input.value = ''; });
        const stateSel = el('select', { ariaLabel: 'Estado' }, el('option', { value: '', textContent: 'Todas' }), el('option', { value: 'on', textContent: 'Activas' }), el('option', { value: 'off', textContent: 'Desactivadas' }));
        stateSel.addEventListener('change', () => { st.state = stateSel.value; st.page = 0; refreshRows(); });
        const fb = filterBar(st, refreshRows, [stateSel]);
        const count = el('span', { className: 'muted grow' });
        const bar = el('div', { className: 'bar' }, ...fb.nodes, count);

        function refreshHeader() {
            const c = cfg(), m = c.myLists[id]; if (!m) return;
            const keys = L.members(c, id), active = keys.filter(k => c.accounts[k].enabled !== false).length;
            fill(head, 
                el('div', { className: 'lm-title' }, el('h2', { textContent: m.name }), el('span', { className: 'badge', textContent: 'Propia' }), el('span', { className: 'grow' }),
                    el('label', { className: 'lm-inline' }, el('span', { className: 'muted small', textContent: listOn(id) ? 'Encendida' : 'Apagada' }), listSwitch(id, `Lista ${m.name}`)), modeSelect(id)),
                el('p', { className: 'muted', textContent: `${keys.length} ${keys.length === 1 ? 'cuenta' : 'cuentas'} · ${active} activas. Tú gestionas esta lista.` }),
                el('div', { className: 'bar' },
                    el('button', { textContent: 'Renombrar', onclick: async () => { const n = await prompt({ title: 'Renombrar lista', label: 'Nombre', value: m.name, confirm: 'Guardar', validate: v => L.checkName(cfg(), v, id) }); if (n === null) return; L.rename(cfg(), id, n); await persist('myLists'); render(); } }),
                    el('button', { textContent: 'Exportar', onclick: () => exportList(id) }),
                    el('button', { className: 'danger', textContent: 'Eliminar lista', onclick: () => deleteList(id) })));
        }
        function refreshRows() {
            const c = cfg();
            const rows = L.members(c, id).map(k => ({ key: k, handle: c.accounts[k].handle, name: c.accounts[k].name || '', note: c.accounts[k].note || '', enabled: c.accounts[k].enabled !== false }))
                .filter(r => matchQ(r, st.q) && (!st.state || (st.state === 'on') === r.enabled)).sort((a, b) => b.enabled - a.enabled || a.key.localeCompare(b.key));
            const { slice, pages } = pageSlice(rows, st);
            count.textContent = `${rows.length} ${rows.length === 1 ? 'cuenta' : 'cuentas'}`;
            fill(table, rows.length ? el('table', {}, el('thead', {}, el('tr', {}, el('th', { className: 'c-on', textContent: 'Activa' }), el('th', { textContent: 'Cuenta' }), el('th', { textContent: 'Nombre y nota' }), el('th'))),
                el('tbody', {}, ...slice.map(r => ownRow(r, id)))) : empty(st.q || st.state ? 'Ninguna cuenta coincide.' : 'Esta lista está vacía. Añade cuentas arriba o desde el icono de MATATIGRE en X.'), pager(st, pages, refreshRows));
        }
        return { nodes: [head, addForm, bar, table], refresh() { refreshHeader(); refreshRows(); }, refreshHeader };
    }
    function ownRow(r, listId) {
        const on = el('input', { type: 'checkbox', checked: r.enabled, ariaLabel: `Activar @${r.handle}` });
        on.addEventListener('change', async () => { cfg().accounts[r.key] = { ...cfg().accounts[r.key], enabled: on.checked, touched: true }; await persist('accounts'); render(); });
        return el('tr', { className: r.enabled ? '' : 'off' }, el('td', { className: 'c-on' }, on), el('td', { className: 'handle' }, accountLink(r.handle)),
            el('td', {}, el('div', { textContent: r.name }), el('div', { className: 'note', textContent: r.note, title: r.note })),
            el('td', {}, el('button', { textContent: 'Editar', onclick: () => editAccount(r.key) }), ' ', el('button', { textContent: 'Quitar', title: 'Quitar de esta lista', onclick: () => removeFromOwn(r.key, listId) })));
    }

    function exportList(id) {
        const c = cfg(), m = c.myLists[id];
        const data = { schema: 1, id, name: m.name, description: '', version: new Date().toISOString().slice(0, 10) + '.1', updated: new Date().toISOString().slice(0, 10),
            accounts: L.members(c, id).map(k => ({ handle: c.accounts[k].handle, ...(c.accounts[k].name ? { name: c.accounts[k].name } : {}) })) };
        const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' })), download: `${id}.json` });
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    async function deleteList(id) {
        const c = cfg(), m = c.myLists[id];
        const only = L.members(c, id).filter(k => (c.accounts[k].tags || []).filter(t => c.myLists[t]).length === 1 && (c.accounts[k].tags || []).length === 1).length;
        const ok = await confirm({ title: `Eliminar «${m.name}»`, message: only ? `${only} ${only === 1 ? 'cuenta que solo está' : 'cuentas que solo están'} en esta lista se quitarán también. Podrás deshacerlo unos segundos.` : 'Las cuentas que también están en otras listas se conservan. Podrás deshacerlo unos segundos.', confirm: 'Eliminar', danger: true });
        if (!ok) return;
        const snap = snapshot();
        L.remove(c, id);
        await persist('accounts', 'myLists', 'lists', 'listModes');
        select({ kind: 'all' });
        toast(`Lista «${m.name}» eliminada.`, { undo: () => restore(snap) });
    }

    // ---------- lista sincronizada ----------
    function subView(id) {
        const st = { q: '', state: '', page: 0 };
        const head = el('div', { className: 'lm-head' }), table = el('div');
        const stateSel = el('select', { ariaLabel: 'Estado' }, el('option', { value: '', textContent: 'Todas' }), el('option', { value: 'on', textContent: 'Filtradas' }), el('option', { value: 'off', textContent: 'Omitidas' }));
        stateSel.addEventListener('change', () => { st.state = stateSel.value; st.page = 0; refreshRows(); });
        const fb = filterBar(st, refreshRows, [stateSel]);
        const count = el('span', { className: 'muted grow' });
        const restoreBtn = el('button', { hidden: true });
        const copyBtn = el('button', { textContent: 'Copiar a una lista mía…' });
        const bar = el('div', { className: 'bar' }, ...fb.nodes, count, restoreBtn, copyBtn);
        const visible = () => {
            const off = omitted();
            return subAccounts(id).map(x => ({ ...x, note: '', enabled: !off.has(x.key) })).filter(r => matchQ(r, st.q) && (!st.state || (st.state === 'on') === r.enabled));
        };
        copyBtn.addEventListener('click', async () => {
            const rows = visible();
            if (!rows.length) return toast('No hay cuentas que copiar con este filtro.', { error: true });
            const target = await pickList({ title: 'Copiar a una lista mía', message: `Se copiarán las ${rows.length} cuentas que se ven (según la búsqueda y el filtro). La lista sincronizada no cambia.`, confirmLabel: 'Copiar' });
            if (!target) return;
            const snap = snapshot();
            const r = L.copyAccounts(cfg(), rows.map(x => x.handle), target);
            await persist('accounts', 'allowlist', 'disabled');
            render();
            toast(`${r.added} ${r.added === 1 ? 'cuenta copiada' : 'cuentas copiadas'} a «${cfg().myLists[target].name}»${r.existing ? ` (${r.existing} ya estaban)` : ''}.`, { undo: () => restore(snap) });
        });
        restoreBtn.addEventListener('click', async () => {
            const mine = new Set(subAccounts(id).map(x => x.key));
            cfg().disabled = cfg().disabled.filter(k => !mine.has(k));
            await persist('disabled'); render();
        });

        function refreshHeader() {
            const c = cfg(), s = c.subs.find(x => x.id === id); if (!s) return;
            const data = c.listData[id], status = (ctx.meta().status || {})[id] || {};
            const accs = subAccounts(id), off = omitted(), skipped = accs.filter(x => off.has(x.key)).length;
            fill(head, 
                el('div', { className: 'lm-title' }, icon('lock'), el('h2', { textContent: s.name || id }), el('span', { className: 'badge', textContent: 'Sincronizada · solo lectura' }), el('span', { className: 'grow' }),
                    el('label', { className: 'lm-inline' }, el('span', { className: 'muted small', textContent: listOn(id) ? 'Encendida' : 'Apagada' }), listSwitch(id, `Lista ${s.name}`)), modeSelect(id)),
                data && data.description ? el('p', { className: 'muted', textContent: data.description }) : null,
                el('p', { className: 'muted small', textContent: `${accs.length} cuentas${skipped ? ` · ${skipped} omitidas por ti` : ''}${data && data.updated ? ' · actualizada el ' + data.updated : ''}` }),
                changeNode(status.change),
                status.error ? el('p', { className: 'err small', textContent: status.error }) : null,
                el('div', { className: 'lm-note' }, 'Esta lista se mantiene sincronizada y no se puede modificar. Puedes omitir cuentas solo para ti, copiarlas a una lista tuya o dejar de seguirla.'),
                el('div', { className: 'bar' },
                    el('button', { textContent: 'Actualizar', onclick: async e => { e.target.disabled = true; const r = await ctx.ask({ op: 'sync' }); e.target.disabled = false; toast(!r || !r.ok || r.failed ? 'No se pudo actualizar.' : 'Lista al día.', { error: !r || !r.ok || !!r.failed }); } }),
                    el('button', { className: 'danger', textContent: 'Dejar de seguir', onclick: async () => { if (!(await confirm({ title: `Dejar de seguir «${s.name}»`, message: 'Se quitará la lista y dejarán de filtrarse sus cuentas (salvo las que ya copiaste a una lista tuya).', confirm: 'Dejar de seguir', danger: true }))) return; await ctx.ask({ op: 'unsubscribe', id }); } })));
        }
        function refreshRows() {
            const rows = visible().sort((a, b) => b.enabled - a.enabled || a.key.localeCompare(b.key));
            const off = omitted(), skipped = subAccounts(id).filter(x => off.has(x.key)).length;
            restoreBtn.hidden = !skipped; restoreBtn.textContent = skipped === 1 ? 'Restaurar la omitida' : `Restaurar las ${skipped} omitidas`;
            const { slice, pages } = pageSlice(rows, st);
            count.textContent = `${rows.length} ${rows.length === 1 ? 'cuenta' : 'cuentas'}`;
            fill(table, rows.length ? el('table', {}, el('thead', {}, el('tr', {}, el('th', { className: 'c-on', textContent: 'Filtrar' }), el('th', { textContent: 'Cuenta' }), el('th', { textContent: 'Nombre' }))),
                el('tbody', {}, ...slice.map(r => {
                    const on = el('input', { type: 'checkbox', checked: r.enabled, ariaLabel: `Filtrar @${r.handle}`, title: r.enabled ? 'Se filtra. Desmárcala para omitirla solo para ti.' : 'Omitida solo para ti. Márcala para filtrarla de nuevo.' });
                    on.addEventListener('change', async () => { const set = new Set(cfg().disabled); if (on.checked) set.delete(r.key); else set.add(r.key); cfg().disabled = [...set]; await persist('disabled'); render(); });
                    return el('tr', { className: r.enabled ? '' : 'off' }, el('td', { className: 'c-on' }, on), el('td', { className: 'handle' }, accountLink(r.handle), r.enabled ? null : el('span', { className: 'badge', textContent: 'omitida' })), el('td', { textContent: r.name }));
                }))) : empty(st.q || st.state ? 'Ninguna cuenta coincide.' : 'Esta lista aún no tiene cuentas descargadas.'), pager(st, pages, refreshRows));
        }
        return { nodes: [head, bar, table], refresh() { refreshHeader(); refreshRows(); }, refreshHeader };
    }

    // ---------- todas las cuentas ----------
    function allView() {
        const st = { q: '', state: '', list: '', page: 0 };
        const head = el('div', { className: 'lm-head' }), table = el('div'), addHost = el('div');
        const listSel = el('select', { ariaLabel: 'Filtrar por lista' });
        const stateSel = el('select', { ariaLabel: 'Estado' }, el('option', { value: '', textContent: 'Todas' }), el('option', { value: 'on', textContent: 'Filtradas' }), el('option', { value: 'off', textContent: 'Desactivadas u omitidas' }));
        listSel.addEventListener('change', () => { st.list = listSel.value; st.page = 0; refreshRows(); });
        stateSel.addEventListener('change', () => { st.state = stateSel.value; st.page = 0; refreshRows(); });
        const fb = filterBar(st, refreshRows, [listSel, stateSel]);
        const count = el('span', { className: 'muted grow' });
        const bar = el('div', { className: 'bar' }, ...fb.nodes, count);
        const bulk = el('div', { className: 'bar' });

        const rowsNow = () => allRows().filter(r => matchQ(r, st.q) && (!st.state || (st.state === 'on') === r.enabled)
            && (!st.list || (st.list === '__none' ? !r.mine.length && !r.synced.length : [...r.mine, ...r.synced].includes(st.list))));

        function refreshHeader() {
            const c = cfg(), rows = allRows(), active = rows.filter(r => r.enabled).length, orphans = L.orphans(c);
            fill(head, el('div', { className: 'lm-title' }, el('h2', { textContent: 'Todas las cuentas' })),
                el('p', { className: 'muted', textContent: `${rows.length} cuentas · ${active} se filtran. Aquí puedes buscar en todas tus listas; para cambiar el contenido de una, ábrela en la columna de la izquierda.` }),
                !rows.length && !Object.keys(c.myLists).length && !c.subs.length ? el('div', { className: 'lm-start' },
                    el('h3', { textContent: 'Empieza por una lista' }),
                    el('p', { className: 'muted', textContent: 'Una lista agrupa las cuentas que quieres ocultar. Puedes crear la tuya o seguir listas sincronizadas que se mantienen al día.' }),
                    el('div', { className: 'bar' }, el('button', { className: 'primary', textContent: 'Crear una lista', onclick: () => newList() }), el('button', { textContent: 'Explorar listas sincronizadas', onclick: () => select({ kind: 'explore' }) }))) : null,
                orphans.length ? el('div', { className: 'lm-note warn' }, `${orphans.length} ${orphans.length === 1 ? 'cuenta propia no está' : 'cuentas propias no están'} en ninguna lista (se filtran siempre). `,
                    el('button', { className: 'link', textContent: 'Asignarlas a una lista', onclick: async () => { const t = await pickList({ title: 'Asignar a una lista', message: `Las ${orphans.length} cuentas sin lista pasarán a la lista que elijas.`, confirmLabel: 'Asignar' }); if (!t) return; L.addAccounts(c, orphans, [t]); await persist('accounts'); render(); } })) : null);
            const labels = el('optgroup', { label: 'Mis listas' }, ...Object.entries(c.myLists).sort(byName).map(([id, m]) => el('option', { value: id, textContent: m.name })));
            const synced = el('optgroup', { label: 'Sincronizadas' }, ...c.subs.map(s => el('option', { value: s.id, textContent: s.name || s.id })));
            const cur = st.list;
            fill(listSel, el('option', { value: '', textContent: 'Todas las listas' }), ...(labels.children.length ? [labels] : []), ...(synced.children.length ? [synced] : []), el('option', { value: '__none', textContent: 'Sin lista' }));
            listSel.value = cur;
            const own = Object.entries(c.myLists).sort(byName);
            const input = el('input', { type: 'text', placeholder: '@usuario o enlace (varias separadas por comas)', ariaLabel: 'Cuentas a añadir', autocomplete: 'off', spellcheck: false });
            const target = el('select', { ariaLabel: 'Añadir a la lista' }, ...own.map(([id, m]) => el('option', { value: id, textContent: m.name })));
            if (st.target && c.myLists[st.target]) target.value = st.target;
            target.addEventListener('change', () => { st.target = target.value; });
            const form = el('form', { className: 'bar' }, input, el('span', { className: 'muted small', textContent: 'a' }), target, el('button', { className: 'primary', type: 'submit', textContent: 'Añadir' }));
            form.addEventListener('submit', async e => { e.preventDefault(); if (await addHandles(input.value, [target.value])) input.value = ''; });
            fill(addHost, own.length ? form : el('div', { className: 'lm-note' }, 'Para añadir cuentas primero necesitas una lista propia. ', el('button', { className: 'link', textContent: 'Crear una lista', onclick: () => newList() })));
        }
        function refreshRows() {
            const rows = rowsNow().sort((a, b) => b.enabled - a.enabled || a.key.localeCompare(b.key));
            const { slice, pages } = pageSlice(rows, st);
            count.textContent = `${rows.length} ${rows.length === 1 ? 'cuenta' : 'cuentas'}`;
            fill(bulk, rows.length ? el('button', { textContent: 'Activar las visibles', onclick: () => setVisible(rows, true) }) : null, rows.length ? el('button', { textContent: 'Desactivar las visibles', onclick: () => setVisible(rows, false) }) : null,
                rows.length ? el('span', { className: 'muted small', textContent: 'Las de listas sincronizadas se omiten solo para ti.' }) : null);
            fill(table, rows.length ? el('table', {}, el('thead', {}, el('tr', {}, el('th', { className: 'c-on', textContent: 'Filtrar' }), el('th', { textContent: 'Cuenta' }), el('th', { textContent: 'Nombre y nota' }), el('th', { textContent: 'Listas' }), el('th'))),
                el('tbody', {}, ...slice.map(r => {
                    const on = el('input', { type: 'checkbox', checked: r.enabled, ariaLabel: `Filtrar @${r.handle}` });
                    on.addEventListener('change', async () => { setAccount(r, on.checked); await persist('accounts', 'disabled'); render(); });
                    const orphan = r.own && !r.mine.length && !r.synced.length;
                    return el('tr', { className: r.enabled ? '' : 'off' }, el('td', { className: 'c-on' }, on), el('td', { className: 'handle' }, accountLink(r.handle)),
                        el('td', {}, el('div', { textContent: r.name }), el('div', { className: 'note', textContent: r.note, title: r.note })),
                        el('td', {}, ...r.mine.map(t => listChip(t, 'own')), ...r.synced.map(t => listChip(t, 'sub')), orphan ? el('span', { className: 'badge warn', textContent: 'sin lista' }) : null),
                        el('td', {}, r.own && r.mine.length ? el('button', { textContent: 'Editar', onclick: () => editAccount(r.key) }) : null));
                }))) : empty(st.q || st.state || st.list ? 'Ninguna cuenta coincide.' : 'Todavía no hay cuentas.'), pager(st, pages, refreshRows));
        }
        return { nodes: [head, addHost, bar, bulk, table], refresh() { refreshHeader(); refreshRows(); }, refreshHeader };
    }
    function listChip(id, kind) {
        const name = kind === 'sub' ? subName(id) : (cfg().myLists[id] ? cfg().myLists[id].name : id);
        const chip = el('button', { className: 'tag chipbtn', type: 'button', title: kind === 'sub' ? 'Lista sincronizada (solo lectura)' : 'Lista propia' }, kind === 'sub' ? icon('lock') : null, name);
        chip.addEventListener('click', () => select({ kind, id }));
        return chip;
    }
    function setAccount(r, on) {
        const c = cfg();
        if (r.own) c.accounts[r.key] = { ...r.own, enabled: on, touched: true };
        const set = new Set(c.disabled);
        if (on) set.delete(r.key); else if (r.synced.length || !r.own) set.add(r.key);
        c.disabled = [...set];
    }
    async function setVisible(rows, on) {
        for (const r of rows) setAccount(r, on);
        await persist('accounts', 'disabled'); render();
    }

    // ---------- explorar listas sincronizadas ----------
    let catalog = null;
    function exploreView() {
        const head = el('div', { className: 'lm-head' }), host = el('div'), msg = el('span', { className: 'muted small', role: 'status' });
        const url = el('input', { type: 'text', placeholder: 'https://…/lista.json', ariaLabel: 'Dirección de la lista', autocomplete: 'off', spellcheck: false });
        const form = el('form', { className: 'bar' }, url, el('button', { className: 'primary', type: 'submit', textContent: 'Añadir por dirección' }));
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const u = url.value.trim();
            if (!root.XAF.isAllowedListUrl(u)) return toast('La dirección debe empezar por https://', { error: true });
            if (!(await confirm({ title: 'Añadir una lista de otra persona', message: 'Quien controla una lista controla qué se oculta en tu pantalla. Añádela solo si confías en quien la publica.', confirm: 'Añadir' }))) return;
            msg.textContent = 'Descargando…';
            const r = await ctx.ask({ op: 'subscribeUrl', url: u });
            msg.textContent = '';
            if (r && r.ok) { url.value = ''; toast('Lista añadida.'); } else toast('No se pudo añadir la lista.', { error: true });
        });
        function refresh() {
            fill(head, el('div', { className: 'lm-title' }, el('h2', { textContent: 'Añadir una lista sincronizada' })),
                el('p', { className: 'muted', textContent: 'Las listas sincronizadas las mantiene al día su autor y no se pueden modificar; tú decides si filtrarlas, con qué modo y qué cuentas omitir.' }), msg);
            const followed = new Set(cfg().subs.map(s => s.id));
            if (!catalog) fill(host, empty('Cargando listas disponibles…'));
            else if (catalog.error) fill(host, el('p', { className: 'err', textContent: 'No se pudieron cargar las listas disponibles.' }), el('button', { textContent: 'Reintentar', onclick: () => { catalog = null; load(); refresh(); } }));
            else {
                const free = catalog.lists.filter(l => !followed.has(l.id));
                fill(host, ...(free.length ? free.map(l => el('div', { className: 'listcard' },
                    el('div', {}, el('strong', { textContent: `${l.name}${l.count != null ? ' · ' + l.count + ' cuentas' : ''}` }), el('p', { className: 'muted', textContent: l.description })),
                    el('button', { className: 'primary', textContent: 'Seguir', onclick: async e => { e.target.disabled = true; const r = await ctx.ask({ op: 'subscribe', ids: [l.id] }); if (!(r && r.ok && !r.failed.length)) { e.target.disabled = false; toast('No se pudo descargar la lista.', { error: true }); } else toast(`Ahora sigues «${l.name}».`); } }))) : [empty('Ya sigues todas las listas disponibles.')]));
            }
        }
        async function load() {
            const r = await ctx.ask({ op: 'catalog' });
            catalog = r && r.ok ? { lists: r.catalog.lists } : { error: true };
            if (sel.kind === 'explore') refresh();
        }
        if (!catalog) load();
        return { nodes: [head, host, el('h3', { textContent: 'Añadir por dirección' }), form], refresh };
    }

    // ---------- arranque ----------
    function init(c) {
        ctx = c;
        $('lmNew').addEventListener('click', () => newList());
        $('lmFind').addEventListener('input', renderSide);
        $('lmExplore').addEventListener('click', () => select({ kind: 'explore' }));
        render();
    }
    root.ListsView = { init, render, select, newList, current: () => sel };
})(window);
