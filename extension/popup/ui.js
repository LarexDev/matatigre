/* Ventanas de diálogo y avisos propios (en lugar de confirm/prompt del navegador): coherentes con el tema, accesibles y sin bloquear la página. */
(function () {
    'use strict';
    const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.flat(Infinity).filter(k => k != null && k !== false)); return n; };

    /**
     * Diálogo genérico. `body` es un nodo con el contenido; `actions` [{ label, primary, danger, value, validate }] (validate → texto de error o '').
     * Devuelve una promesa con el `value` de la acción pulsada (null si se cierra).
     */
    function dialog({ title, message, body, actions, onOpen }) {
        return new Promise(resolve => {
            const dlg = el('dialog', { className: 'mt-dialog' });
            const err = el('div', { className: 'err', role: 'alert' });
            const done = v => { dlg.close(); dlg.remove(); resolve(v); };
            const buttons = actions.map(a => el('button', {
                type: 'button', className: a.primary ? 'primary' : a.danger ? 'danger' : '', textContent: a.label,
                onclick: () => { const bad = a.validate ? a.validate() : ''; if (bad) { err.textContent = bad; return; } done(typeof a.value === 'function' ? a.value() : a.value); }
            }));
            dlg.append(el('h2', { textContent: title }), message ? el('p', { textContent: message }) : null, body || null, err, el('div', { className: 'actions' }, ...buttons));
            dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
            dlg.addEventListener('keydown', e => {
                if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'SELECT') { e.preventDefault(); (buttons[buttons.length - 1]).click(); }
            });
            document.body.append(dlg);
            dlg.showModal();
            if (onOpen) onOpen(dlg);
            (dlg.querySelector('input,select,textarea') || buttons[buttons.length - 1]).focus();
        });
    }

    /** Pregunta de sí/no. Devuelve true o false. */
    async function confirm({ title, message, confirm: ok = 'Aceptar', danger = false }) {
        const r = await dialog({ title, message, actions: [{ label: 'Cancelar', value: false }, { label: ok, primary: !danger, danger, value: true }] });
        return r === true;
    }

    /** Pide un texto. `validate(valor)` devuelve el motivo si no vale. Devuelve el texto o null. */
    async function prompt({ title, message, label, value = '', confirm: ok = 'Aceptar', validate, maxLength = 60 }) {
        const input = el('input', { type: 'text', value, maxLength, ariaLabel: label || title, autocomplete: 'off', spellcheck: false });
        return dialog({
            title, message, body: input,
            actions: [{ label: 'Cancelar', value: null }, { label: ok, primary: true, value: () => input.value.trim(), validate: () => (validate ? validate(input.value.trim()) : '') }],
            onOpen: () => input.select()
        });
    }

    let toastEl = null, toastTimer = 0;
    /** Aviso breve abajo en el centro; con `undo` ofrece deshacer. */
    function toast(text, { undo, error = false, ms = 5000 } = {}) {
        clearTimeout(toastTimer);
        toastEl?.remove();
        toastEl = el('div', { className: 'mt-toast' + (error ? ' err' : ''), role: 'status' }, el('span', { textContent: text }),
            undo ? el('button', { type: 'button', textContent: 'Deshacer', onclick: async () => { toastEl.remove(); await undo(); } }) : null);
        document.body.append(toastEl);
        toastTimer = setTimeout(() => toastEl && toastEl.remove(), undo ? Math.max(ms, 7000) : ms);
    }

    window.MTUI = { dialog, confirm, prompt, toast, el };
})();
