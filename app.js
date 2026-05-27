// ========================================
// FONDERIA TREVISO - Main JavaScript
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    initLoader();
    initNavbar();
    initScrollAnimations();
    initSmoothScroll();
    initGalleryLightbox();
});

function initLoader() {
    const loader = document.getElementById('loader');
    if (!loader) return;
    window.addEventListener('load', () => {
        setTimeout(() => {
            loader.classList.add('hidden');
            setTimeout(() => { loader.style.display = 'none'; }, 800);
        }, 600);
    });
}

// ----------------------------------------
// Navbar scroll effect + mobile toggle
// ----------------------------------------
function initNavbar() {
    const navbar = document.getElementById('navbar');
    const navToggle = document.getElementById('navToggle');
    const navMenu = document.getElementById('navMenu');
    
    // Scroll effect
    let lastScroll = 0;
    window.addEventListener('scroll', () => {
        const currentScroll = window.pageYOffset;
        
        if (currentScroll > 80) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
        
        lastScroll = currentScroll;
    });
    
    // Mobile toggle
    if (navToggle && navMenu) {
        navToggle.addEventListener('click', () => {
            navMenu.classList.toggle('active');
            navToggle.classList.toggle('active');
        });
        
        // Close menu on link click
        navMenu.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                navMenu.classList.remove('active');
                navToggle.classList.remove('active');
            });
        });
    }
}

// ----------------------------------------
// Scroll-triggered animations (AOS replacement)
// ----------------------------------------
function initScrollAnimations() {
    const animatedElements = document.querySelectorAll('[data-aos]');
    
    const observerOptions = {
        root: null,
        rootMargin: '0px 0px -80px 0px',
        threshold: 0.1
    };
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                // Add stagger delay if specified
                const delay = entry.target.dataset.aosDelay;
                if (delay) {
                    setTimeout(() => {
                        entry.target.classList.add('aos-animate');
                    }, parseInt(delay));
                } else {
                    entry.target.classList.add('aos-animate');
                }
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);
    
    animatedElements.forEach(el => observer.observe(el));
}

// ----------------------------------------
// Smooth scroll for anchor links
// ----------------------------------------
function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const href = this.getAttribute('href');
            if (href === '#') return;
            
            e.preventDefault();
            const target = document.querySelector(href);
            if (target) {
                const navHeight = document.getElementById('navbar').offsetHeight;
                const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - navHeight;
                
                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });
}

// ----------------------------------------
// Gallery lightbox
// ----------------------------------------
function initGalleryLightbox() {
    const galleryItems = document.querySelectorAll('.gallery-item');
    if (galleryItems.length === 0) return;
    
    // Create lightbox elements
    const lightbox = document.createElement('div');
    lightbox.className = 'lightbox';
    lightbox.innerHTML = `
        <div class="lightbox-overlay"></div>
        <div class="lightbox-content">
            <button class="lightbox-close" aria-label="Chiudi">&times;</button>
            <button class="lightbox-prev" aria-label="Precedente">&lsaquo;</button>
            <img src="" alt="" class="lightbox-img">
            <button class="lightbox-next" aria-label="Successiva">&rsaquo;</button>
        </div>
    `;
    document.body.appendChild(lightbox);
    
    // Add lightbox styles dynamically
    const lightboxStyles = document.createElement('style');
    lightboxStyles.textContent = `
        .lightbox {
            position: fixed;
            inset: 0;
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            visibility: hidden;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .lightbox.active {
            opacity: 1;
            visibility: visible;
        }
        .lightbox-overlay {
            position: absolute;
            inset: 0;
            background: rgba(10, 10, 10, 0.95);
            backdrop-filter: blur(10px);
        }
        .lightbox-content {
            position: relative;
            z-index: 2;
            max-width: 90vw;
            max-height: 90vh;
        }
        .lightbox-img {
            max-width: 90vw;
            max-height: 85vh;
            object-fit: contain;
            border-radius: 8px;
            box-shadow: 0 30px 60px rgba(0, 0, 0, 0.5);
        }
        .lightbox-close,
        .lightbox-prev,
        .lightbox-next {
            position: absolute;
            background: none;
            border: none;
            color: #e8e0d4;
            font-size: 36px;
            cursor: pointer;
            z-index: 3;
            transition: color 0.3s ease;
            padding: 10px;
        }
        .lightbox-close:hover,
        .lightbox-prev:hover,
        .lightbox-next:hover {
            color: #c9a227;
        }
        .lightbox-close { top: -50px; right: 0; font-size: 40px; }
        .lightbox-prev { left: -60px; top: 50%; transform: translateY(-50%); }
        .lightbox-next { right: -60px; top: 50%; transform: translateY(-50%); }
        @media (max-width: 768px) {
            .lightbox-close { top: -40px; right: 0; }
            .lightbox-prev { left: 10px; }
            .lightbox-next { right: 10px; }
            .lightbox-prev, .lightbox-next {
                background: rgba(10, 10, 10, 0.8);
                border-radius: 50%;
                width: 44px;
                height: 44px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
        }
    `;
    document.head.appendChild(lightboxStyles);
    
    const lightboxImg = lightbox.querySelector('.lightbox-img');
    const closeBtn = lightbox.querySelector('.lightbox-close');
    const prevBtn = lightbox.querySelector('.lightbox-prev');
    const nextBtn = lightbox.querySelector('.lightbox-next');
    let currentIndex = 0;
    
    const images = Array.from(galleryItems).map(item => item.querySelector('img').src);
    
    galleryItems.forEach((item, index) => {
        item.addEventListener('click', () => {
            currentIndex = index;
            showImage(currentIndex);
            lightbox.classList.add('active');
            document.body.style.overflow = 'hidden';
        });
    });
    
    function showImage(index) {
        lightboxImg.src = images[index];
    }
    
    function closeLightbox() {
        lightbox.classList.remove('active');
        document.body.style.overflow = '';
    }
    
    function nextImage() {
        currentIndex = (currentIndex + 1) % images.length;
        showImage(currentIndex);
    }
    
    function prevImage() {
        currentIndex = (currentIndex - 1 + images.length) % images.length;
        showImage(currentIndex);
    }
    
    closeBtn.addEventListener('click', closeLightbox);
    nextBtn.addEventListener('click', (e) => { e.stopPropagation(); nextImage(); });
    prevBtn.addEventListener('click', (e) => { e.stopPropagation(); prevImage(); });
    
    lightbox.querySelector('.lightbox-overlay').addEventListener('click', closeLightbox);
    
    document.addEventListener('keydown', (e) => {
        if (!lightbox.classList.contains('active')) return;
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowRight') nextImage();
        if (e.key === 'ArrowLeft') prevImage();
    });
}

// ----------------------------------------
    }
});

// ========================================
// INSTAGRAM CAROUSEL
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    initInstagramCarousel();
});

function initInstagramCarousel() {
    const carousel = document.getElementById('instaCarousel');
    if (!carousel) return;
    
    const track = carousel.querySelector('.carousel-track');
    const slides = carousel.querySelectorAll('.insta-slide');
    const prevBtn = document.querySelector('.carousel-prev');
    const nextBtn = document.querySelector('.carousel-next');
    const dotsContainer = document.getElementById('carouselDots');
    
    if (!track || slides.length === 0) return;
    
    let currentIndex = 0;
    let slidesPerView = getSlidesPerView();
    let maxIndex = Math.max(0, slides.length - slidesPerView);
    let autoScrollInterval;
    
    // Create dots
    if (dotsContainer) {
        const totalDots = Math.ceil(slides.length / slidesPerView);
        for (let i = 0; i < totalDots; i++) {
            const dot = document.createElement('button');
            dot.className = 'carousel-dot' + (i === 0 ? ' active' : '');
            dot.setAttribute('aria-label', `Vai a pagina ${i + 1}`);
            dot.addEventListener('click', () => goToSlide(i * slidesPerView));
            dotsContainer.appendChild(dot);
        }
    }
    
    function getSlidesPerView() {
        const width = window.innerWidth;
        if (width <= 480) return 1;
        if (width <= 768) return 2;
        if (width <= 1024) return 3;
        return 4;
    }
    
    function updateSlidesPerView() {
        slidesPerView = getSlidesPerView();
        maxIndex = Math.max(0, slides.length - slidesPerView);
        currentIndex = Math.min(currentIndex, maxIndex);
        updateCarousel();
    }
    
    function updateCarousel() {
        const slideWidth = slides[0].offsetWidth + 16; // including gap
        track.style.transform = `translateX(-${currentIndex * slideWidth}px)`;
        
        // Update buttons
        if (prevBtn) prevBtn.disabled = currentIndex === 0;
        if (nextBtn) nextBtn.disabled = currentIndex >= maxIndex;
        
        // Update dots
        const dots = dotsContainer?.querySelectorAll('.carousel-dot');
        if (dots) {
            dots.forEach((dot, i) => {
                dot.classList.toggle('active', i === Math.floor(currentIndex / slidesPerView));
            });
        }
    }
    
    function goToSlide(index) {
        currentIndex = Math.max(0, Math.min(index, maxIndex));
        updateCarousel();
    }
    
    function nextSlide() {
        if (currentIndex >= maxIndex) {
            currentIndex = 0; // Loop back to start
        } else {
            currentIndex++;
        }
        updateCarousel();
    }
    
    function prevSlide() {
        if (currentIndex <= 0) {
            currentIndex = maxIndex; // Loop to end
        } else {
            currentIndex--;
        }
        updateCarousel();
    }
    
    // Button events
    if (prevBtn) prevBtn.addEventListener('click', () => { prevSlide(); resetAutoScroll(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { nextSlide(); resetAutoScroll(); });
    
    // Touch/swipe support
    let touchStartX = 0;
    let touchEndX = 0;
    
    carousel.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });
    
    carousel.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    }, { passive: true });
    
    function handleSwipe() {
        const diff = touchStartX - touchEndX;
        if (Math.abs(diff) > 50) {
            if (diff > 0) nextSlide();
            else prevSlide();
            resetAutoScroll();
        }
    }
    
    // Auto-scroll
    function startAutoScroll() {
        autoScrollInterval = setInterval(nextSlide, 4000);
    }
    
    function resetAutoScroll() {
        clearInterval(autoScrollInterval);
        startAutoScroll();
    }
    
    // Pause on hover
    carousel.addEventListener('mouseenter', () => clearInterval(autoScrollInterval));
    carousel.addEventListener('mouseleave', startAutoScroll);
    
    // Resize handler
    window.addEventListener('resize', () => {
        updateSlidesPerView();
    });
    
    // Init
    updateCarousel();
    startAutoScroll();
}

// ========================================
// FAQ ACCORDION
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    initFaqAccordion();
});

function initFaqAccordion() {
    const faqItems = document.querySelectorAll('.faq-item');
    if (faqItems.length === 0) return;
    
    faqItems.forEach(item => {
        const question = item.querySelector('.faq-question');
        if (!question) return;
        
        question.addEventListener('click', () => {
            const isActive = item.classList.contains('active');
            
            // Close all others
            faqItems.forEach(other => {
                if (other !== item) {
                    other.classList.remove('active');
                    other.querySelector('.faq-question')?.setAttribute('aria-expanded', 'false');
                }
            });
            
            // Toggle current
            item.classList.toggle('active');
            question.setAttribute('aria-expanded', !isActive);
        });
    });
}
