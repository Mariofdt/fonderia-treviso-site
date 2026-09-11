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
        const pending = blockquotes().some((bq) => !bq.querySelector('iframe'));
        if ((ready && !pending) || attempts >= 30) clearInterval(retry);
    }, 2000);
});
