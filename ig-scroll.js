document.addEventListener('DOMContentLoaded', () => {
    const viewport = document.getElementById('igViewport');
    const prevBtn = document.getElementById('igPrev');
    const nextBtn = document.getElementById('igNext');
    if (!viewport || !prevBtn || !nextBtn) return;

    const scrollAmount = 360; // card width + gap

    prevBtn.addEventListener('click', () => {
        viewport.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
    });

    nextBtn.addEventListener('click', () => {
        viewport.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    });

    // Instagram embeds: embed.js è async e può mancare parte dei blockquote
    // al primo passaggio. Inoltre marca data-instgrm-processed PRIMA di iniettare
    // l'iframe: se un embed fallisce (rete lenta, cookie di terze parti bloccati)
    // il blockquote resta marcato ma vuoto e process() lo salta per sempre →
    // qui la marca viene tolta per forzare il riprocessamento.
    // Retry ogni 2s fino a ~60s; oltre, restano i link fallback "Vedi post".
    const grid = document.querySelector('.insta-embed-grid');
    if (!grid) return;
    let attempts = 0;
    const blockquotes = () => [...grid.querySelectorAll('blockquote.instagram-media')];

    // Se embed.js non carica affatto (ad-blocker / privacy tool nel browser del
    // visitatore: caso reale visto in produzione) i blockquote restano blocchi
    // vuoti "Vedi post su Instagram". Dopo ~16s senza window.instgrm sostituiamo
    // con card statiche brandizzate + link diretto al post/profilo.
    function igFallback(bq) {
        const link =
            bq.getAttribute('data-instgrm-permalink') ||
            (bq.querySelector('a') && bq.querySelector('a').href) ||
            'https://www.instagram.com/fonderiatreviso/';
        bq.outerHTML =
            '<div class="ig-fallback">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="0.9" fill="currentColor" stroke="none"/></svg>' +
            '<span>Questo contenuto è bloccato dal tuo browser<br>(ad-blocker o protezione privacy attiva)</span>' +
            '<a href="' + link + '" target="_blank" rel="noopener">Apri il post su Instagram</a>' +
            '</div>';
    }

    function showBlockedNote() {
        if (grid.parentNode.querySelector('.ig-blocked-note')) return;
        const note = document.createElement('p');
        note.className = 'ig-blocked-note';
        note.innerHTML =
            'I post non si caricano? Alcuni plugin del browser bloccano Instagram. ' +
            '<a href="https://www.instagram.com/fonderiatreviso/" target="_blank" rel="noopener">Vai al profilo @fonderiatreviso</a>';
        grid.parentNode.appendChild(note);
    }

    const retry = setInterval(() => {
        attempts++;
        const ready = window.instgrm && window.instgrm.Embeds;
        if (ready) {
            blockquotes().forEach((bq) => {
                if (!bq.querySelector('iframe') && bq.hasAttribute('data-instgrm-processed')) {
                    bq.removeAttribute('data-instgrm-processed');
                }
            });
            try { window.instgrm.Embeds.process(); } catch (e) { /* noop */ }
        }

        const pending = blockquotes().filter((bq) => !bq.querySelector('iframe'));
        if (ready && !pending.length) { clearInterval(retry); return; }

        // Timeout per-embed: embed presente ma questo post non renderizza
        if (ready && attempts >= 25) pending.forEach(igFallback);

        // embed.js mai caricato → sicuramente bloccato da estensione/rete
        if (!ready && attempts >= 8) {
            pending.forEach(igFallback);
            showBlockedNote();
        }
        if (attempts >= 30) clearInterval(retry);
    }, 2000);
});
