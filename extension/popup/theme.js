/* Apariencia (automática, clara u oscura): se aplica antes de pintar y sigue el ajuste guardado. Compartido por popup, opciones y bienvenida. */
(function () {
    'use strict';
    const root = document.documentElement;
    function apply(t) {
        t = t === 'light' || t === 'dark' ? t : 'auto';
        if (t === 'auto') delete root.dataset.theme; else root.dataset.theme = t;
        try { localStorage.setItem('mt-theme', t); } catch { /* sin almacenamiento */ }
        return t;
    }
    try { apply(localStorage.getItem('mt-theme')); } catch { /* sin caché */ }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get('settings').then(r => apply(r.settings && r.settings.theme)).catch(() => { });
        chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) apply(ch.settings.newValue && ch.settings.newValue.theme); });
    }
    window.MTTheme = { apply };
})();
