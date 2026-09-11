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
    // al primo passaggio (o non essere ancora caricato) → ritenta ogni 2s
    // finché tutti i post hanno il loro iframe (max ~40s, basta per connessioni
    // lente; se un post è stato rimosso da IG il ciclo si ferma comunque).
    const grid = document.querySelector('.insta-embed-grid');
    if (!grid) return;
    let attempts = 0;
    const retry = setInterval(() => {
        attempts++;
        const pending = [...grid.querySelectorAll('blockquote.instagram-media')]
            .some(bq => !bq.querySelector('iframe'));
        const ready = window.instgrm && window.instgrm.Embeds;
        if (ready) {
            try { window.instgrm.Embeds.process(); } catch (e) { /* noop */ }
        }
        if ((ready && !pending) || attempts >= 20) clearInterval(retry);
    }, 2000);
});
