// ========================================
// GOOGLE REVIEWS CAROUSEL
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    initReviewsCarousel();
});

function initReviewsCarousel() {
    const carousel = document.querySelector('.reviews-carousel');
    if (!carousel) return;
    
    const track = carousel.querySelector('.reviews-track');
    const cards = carousel.querySelectorAll('.review-card');
    const prevBtn = document.querySelector('.reviews-prev');
    const nextBtn = document.querySelector('.reviews-next');
    
    if (!track || cards.length === 0) return;
    
    let currentIndex = 0;
    let autoInterval;
    
    function getCardsPerView() {
        const w = window.innerWidth;
        if (w <= 768) return 1;
        if (w <= 1024) return 2;
        return 3;
    }
    
    function getCardWidth() {
        const gap = 24;
        const containerWidth = carousel.offsetWidth;
        const perView = getCardsPerView();
        return (containerWidth - (gap * (perView - 1))) / perView + gap;
    }
    
    function update() {
        const cardW = getCardWidth();
        track.style.transform = `translateX(-${currentIndex * cardW}px)`;
        if (prevBtn) prevBtn.disabled = currentIndex === 0;
        if (nextBtn) nextBtn.disabled = currentIndex >= cards.length - getCardsPerView();
    }
    
    function next() {
        const max = cards.length - getCardsPerView();
        currentIndex = currentIndex >= max ? 0 : currentIndex + 1;
        update();
    }
    
    function prev() {
        const max = cards.length - getCardsPerView();
        currentIndex = currentIndex <= 0 ? max : currentIndex - 1;
        update();
    }
    
    if (prevBtn) prevBtn.addEventListener('click', () => { prev(); resetAuto(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { next(); resetAuto(); });
    
    // Touch swipe
    let startX = 0;
    carousel.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
    carousel.addEventListener('touchend', e => {
        const diff = startX - e.changedTouches[0].clientX;
        if (Math.abs(diff) > 50) {
            diff > 0 ? next() : prev();
            resetAuto();
        }
    }, { passive: true });
    
    function startAuto() {
        autoInterval = setInterval(next, 5000);
    }
    
    function resetAuto() {
        clearInterval(autoInterval);
        startAuto();
    }
    
    carousel.addEventListener('mouseenter', () => clearInterval(autoInterval));
    carousel.addEventListener('mouseleave', startAuto);
    
    window.addEventListener('resize', update);
    
    update();
    startAuto();
}
