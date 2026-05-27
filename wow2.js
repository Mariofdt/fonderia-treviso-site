// ========================================
// WOW 2.0 - PARALLAX, REVEALS, TILT, COUNTERS
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    initNoiseOverlay();
    initScrollReveal();
    initSplitText();
    initParallaxImages();
    initTiltCards();
    initMagneticButtons();
    initAnimatedCounters();
    initSpotlightCards();
    initParallaxSections();
    initSmoothAnchorScroll();
    initHeroParallax();
});

// ----------------------------------------
// 1. NOISE OVERLAY
// ----------------------------------------
function initNoiseOverlay() {
    const div = document.createElement('div');
    div.className = 'noise-overlay';
    document.body.appendChild(div);
}

// ----------------------------------------
// 2. SCROLL REVEAL (IntersectionObserver)
// ----------------------------------------
function initScrollReveal() {
    const revealElements = document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale, .stagger-children');
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
                // Once revealed, keep it revealed (no unobserve for re-entrance)
            }
        });
    }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });
    
    revealElements.forEach(el => observer.observe(el));
}

// ----------------------------------------
// 3. SPLIT TEXT (letter-by-letter reveal)
// ----------------------------------------
function initSplitText() {
    document.querySelectorAll('.split-text').forEach(el => {
        const text = el.textContent;
        el.innerHTML = '';
        text.split('').forEach((char, i) => {
            const span = document.createElement('span');
            span.className = 'char';
            span.textContent = char === ' ' ? '\u00A0' : char;
            span.style.transitionDelay = `${i * 0.03}s`;
            el.appendChild(span);
        });
    });
    
    // Trigger on scroll
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
            }
        });
    }, { threshold: 0.3 });
    
    document.querySelectorAll('.split-text').forEach(el => observer.observe(el));
}

// ----------------------------------------
// 4. PARALLAX IMAGES
// ----------------------------------------
function initParallaxImages() {
    const images = document.querySelectorAll('.parallax-img img');
    
    function update() {
        const scrolled = window.pageYOffset;
        images.forEach(img => {
            const parent = img.closest('.parallax-img');
            if (!parent) return;
            const rect = parent.getBoundingClientRect();
            const speed = parseFloat(parent.dataset.speed) || 0.15;
            const offset = (scrolled - parent.offsetTop + window.innerHeight) * speed;
            img.style.transform = `translateY(${offset}px) scale(1.1)`;
        });
    }
    
    let ticking = false;
    window.addEventListener('scroll', () => {
        if (!ticking) {
            requestAnimationFrame(() => {
                update();
                ticking = false;
            });
            ticking = true;
        }
    });
}

// ----------------------------------------
// 5. 3D TILT CARDS
// ----------------------------------------
function initTiltCards() {
    document.querySelectorAll('.tilt-card').forEach(card => {
        card.addEventListener('mousemove', (e) => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const cx = rect.width / 2;
            const cy = rect.height / 2;
            const dx = (x - cx) / cx;
            const dy = (y - cy) / cy;
            card.style.transform = `perspective(800px) rotateY(${dx * 8}deg) rotateX(${-dy * 8}deg) translateZ(20px) scale(1.02)`;
        });
        
        card.addEventListener('mouseleave', () => {
            card.style.transform = 'perspective(800px) rotateY(0) rotateX(0) translateZ(0) scale(1)';
        });
    });
}

// ----------------------------------------
// 6. MAGNETIC BUTTONS
// ----------------------------------------
function initMagneticButtons() {
    document.querySelectorAll('.magnetic-btn').forEach(btn => {
        btn.addEventListener('mousemove', (e) => {
            const rect = btn.getBoundingClientRect();
            const x = e.clientX - rect.left - rect.width / 2;
            const y = e.clientY - rect.top - rect.height / 2;
            btn.style.transform = `translate(${x * 0.3}px, ${y * 0.3}px)`;
        });
        
        btn.addEventListener('mouseleave', () => {
            btn.style.transform = 'translate(0, 0)';
        });
    });
}

// ----------------------------------------
// 7. ANIMATED COUNTERS
// ----------------------------------------
function initAnimatedCounters() {
    const counters = document.querySelectorAll('.counter');
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting && !entry.target.dataset.counted) {
                entry.target.dataset.counted = 'true';
                animateCounter(entry.target);
            }
        });
    }, { threshold: 0.5 });
    
    counters.forEach(c => observer.observe(c));
    
    function animateCounter(el) {
        const target = parseFloat(el.dataset.target) || 0;
        const suffix = el.dataset.suffix || '';
        const prefix = el.dataset.prefix || '';
        const duration = 2000;
        const start = performance.now();
        
        function step(now) {
            const progress = Math.min((now - start) / duration, 1);
            const ease = 1 - Math.pow(1 - progress, 3);
            const current = Math.floor(target * ease);
            el.textContent = prefix + current.toLocaleString() + suffix;
            if (progress < 1) requestAnimationFrame(step);
        }
        
        requestAnimationFrame(step);
    }
}

// ----------------------------------------
// 8. SPOTLIGHT CARD (mouse-following glow)
// ----------------------------------------
function initSpotlightCards() {
    document.querySelectorAll('.spotlight-card').forEach(card => {
        card.addEventListener('mousemove', (e) => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            card.style.setProperty('--spotlight-x', x + 'px');
            card.style.setProperty('--spotlight-y', y + 'px');
            const before = card.querySelector('::before') || card;
            card.style.cssText += `--spotlight-x: ${x}px; --spotlight-y: ${y}px;`;
        });
    });
}

// ----------------------------------------
// 9. PARALLAX SECTION BACKGROUNDS
// ----------------------------------------
function initParallaxSections() {
    const sections = document.querySelectorAll('[data-parallax-bg]');
    
    function update() {
        const scrolled = window.pageYOffset;
        sections.forEach(sec => {
            const speed = parseFloat(sec.dataset.parallaxBg) || 0.1;
            const offset = scrolled * speed;
            sec.style.backgroundPositionY = `${offset}px`;
        });
    }
    
    let ticking = false;
    window.addEventListener('scroll', () => {
        if (!ticking) {
            requestAnimationFrame(() => { update(); ticking = false; });
            ticking = true;
        }
    });
}

// ----------------------------------------
// 10. SMOOTH ANCHOR SCROLL (lenis-like)
// ----------------------------------------
function initSmoothAnchorScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(a => {
        a.addEventListener('click', (e) => {
            const href = a.getAttribute('href');
            if (href === '#') return;
            const target = document.querySelector(href);
            if (!target) return;
            e.preventDefault();
            const y = target.getBoundingClientRect().top + window.pageYOffset - 80;
            window.scrollTo({ top: y, behavior: 'smooth' });
        });
    });
}

// ----------------------------------------
// 11. HERO PARALLAX (video + content)
// ----------------------------------------
function initHeroParallax() {
    const hero = document.getElementById('hero');
    if (!hero) return;
    
    const video = hero.querySelector('video');
    const content = hero.querySelector('.hero-content');
    
    window.addEventListener('scroll', () => {
        const scrolled = window.pageYOffset;
        const heroHeight = hero.offsetHeight;
        if (scrolled < heroHeight) {
            if (video) {
                video.style.transform = `translateY(${scrolled * 0.2}px) scale(1.15)`;
            }
            if (content) {
                // Only fade, no translateY to avoid overlay on navbar
                const fade = Math.max(0, 1 - (scrolled / (heroHeight * 0.7)));
                content.style.opacity = fade;
                if (fade <= 0) {
                    content.style.visibility = 'hidden';
                } else {
                    content.style.visibility = 'visible';
                }
            }
        }
    });
}
