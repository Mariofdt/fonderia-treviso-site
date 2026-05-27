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
});
