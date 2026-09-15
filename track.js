// ========================================
// FONDERIA TREVISO - Eventi GA4 custom (track.js)
// window.fondTrack(nome, params): no-op se gtag non c'è
// (adblocker, privacy tool) — MAI errori a video, MAI bloccante.
// Caricato PRIMA di booking/popup/newsletter in index.html.
// ========================================

window.fondTrack = function (name, params) {
    try {
        if (typeof window.gtag === 'function') window.gtag('event', name, params || {});
    } catch (e) { /* analytics non deve mai rompere il sito */ }
};

// Click su qualunque link WhatsApp (footer, contatti, ecc.) — cattura delegata.
// Il form di prenotazione apre wa.me via window.open: tracciato a parte in booking.js.
document.addEventListener('click', function (e) {
    const a = e.target && e.target.closest ? e.target.closest('a[href*="wa.me"]') : null;
    if (a) window.fondTrack('whatsapp_click', { source: 'link' });
}, true);
