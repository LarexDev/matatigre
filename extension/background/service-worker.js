/* Siembra la lista al instalar, acumula estadísticas, mantiene el contador del icono y atiende los atajos. */
importScripts('../src/matcher.js', '../src/store.js');

chrome.runtime.onInstalled.addListener(async () => {
    try { await XAF.store.seed(); } catch (e) { console.error('[matatigre] seed', e); }
});

// Las estadísticas se acumulan aquí (una sola escritora) para que varias pestañas no se pisen.
let statsQueue = Promise.resolve();
function addStats(delta) {
    statsQueue = statsQueue.then(async () => {
        const s = await XAF.store.loadStats();
        const day = new Date().toISOString().slice(0, 10);
        s.total += delta.n;
        s.byDay[day] = (s.byDay[day] || 0) + delta.n;
        for (const [h, n] of Object.entries(delta.byHandle || {})) s.byHandle[h] = (s.byHandle[h] || 0) + n;
        for (const [r, n] of Object.entries(delta.byRole || {})) s.byRole[r] = (s.byRole[r] || 0) + n;
        // acotar: conservar 90 días y las 2000 cuentas más frecuentes
        const days = Object.keys(s.byDay).sort();
        for (const d of days.slice(0, Math.max(0, days.length - 90))) delete s.byDay[d];
        const top = Object.entries(s.byHandle).sort((a, b) => b[1] - a[1]);
        if (top.length > 2000) s.byHandle = Object.fromEntries(top.slice(0, 2000));
        await chrome.storage.local.set({ [XAF.store.STATS_KEY]: s });
    }).catch(e => console.error('[matatigre] stats', e));
}

chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== 'xaf:report') return;
    if (sender.tab?.id != null) {
        const text = msg.hidden > 0 ? (msg.hidden > 999 ? '999+' : String(msg.hidden)) : '';
        chrome.action.setBadgeText({ tabId: sender.tab.id, text });
        chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#b91c1c' });
    }
    if (msg.delta && msg.delta.n > 0) addStats(msg.delta);
});

chrome.commands.onCommand.addListener(async command => {
    const cfg = await XAF.store.load();
    const settings = { ...cfg.settings };
    if (command === 'toggle-enabled') settings.enabled = !settings.enabled;
    else if (command === 'cycle-mode') settings.mode = settings.mode === 'highlight' ? 'hide' : 'highlight';
    else return;
    await XAF.store.save({ settings });
});
