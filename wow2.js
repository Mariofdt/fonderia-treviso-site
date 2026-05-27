// ========================================
// WOW 2.0 - PARALLAX, REVEALS, TILT, COUNTERS, SPARKS
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    initNoiseOverlay();
    initScrollReveal();
    initForgeReveal();
    initSplitText();
    initParallaxImages();
    initTiltCards();
    initMagneticButtons();
    initAnimatedCounters();
    initSpotlightCards();
    initParallaxSections();
    initSmoothAnchorScroll();
    initHeroParallax();
    initSparkCanvas();
    initGlobalSpotlight();
    initMarqueeSkew();
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
// 2. SCROLL REVEAL
// ----------------------------------------
function initScrollReveal() {
    const revealElements = document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale, .stagger-children');
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
            }
        });
    }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });
    revealElements.forEach(el => observer.observe(el));
}

// ----------------------------------------
// 3. FORGE REVEAL (blur glow fade-in)
// ----------------------------------------
function initForgeReveal() {
    const elements = document.querySelectorAll('.forge-reveal');
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
            }
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    elements.forEach(el => observer.observe(el));
}

// ----------------------------------------
// 4. SPLIT TEXT
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
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) entry.target.classList.add('active');
        });
    }, { threshold: 0.3 });
    document.querySelectorAll('.split-text').forEach(el => observer.observe(el));
}

// ----------------------------------------
// 5. PARALLAX IMAGES
// ----------------------------------------
function initParallaxImages() {
    const images = document.querySelectorAll('.parallax-img img');
    function update() {
        const scrolled = window.pageYOffset;
        images.forEach(img => {
            const parent = img.closest('.parallax-img');
            if (!parent) return;
            const speed = parseFloat(parent.dataset.speed) || 0.15;
            const offset = (scrolled - parent.offsetTop + window.innerHeight) * speed;
            img.style.transform = `translateY(${offset}px) scale(1.1)`;
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
// 6. 3D TILT CARDS
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
// 7. MAGNETIC BUTTONS
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
// 8. ANIMATED COUNTERS
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
// 9. SPOTLIGHT CARDS
// ----------------------------------------
function initSpotlightCards() {
    document.querySelectorAll('.spotlight-card').forEach(card => {
        card.addEventListener('mousemove', (e) => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            card.style.setProperty('--spotlight-x', x + 'px');
            card.style.setProperty('--spotlight-y', y + 'px');
        });
    });
}

// ----------------------------------------
// 10. PARALLAX SECTION BACKGROUNDS
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
// 11. SMOOTH ANCHOR SCROLL
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
// 12. HERO PARALLAX
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
                const fade = Math.max(0, 1 - (scrolled / (heroHeight * 0.7)));
                content.style.opacity = fade;
                content.style.visibility = fade <= 0 ? 'hidden' : 'visible';
            }
        }
    });
}

// ----------------------------------------
// 13. SPARK CANVAS (scintelle fuoco)
// ----------------------------------------
function initSparkCanvas() {
    const canvas = document.getElementById('particles');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let width, height;
    const sparks = [];
    const maxSparks = 80;

    function resize() {
        width = canvas.width = canvas.offsetWidth;
        height = canvas.height = canvas.offsetHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    class Spark {
        constructor() {
            this.reset();
        }
        reset() {
            this.x = Math.random() * width;
            this.y = height + Math.random() * 100;
            this.size = Math.random() * 2.5 + 0.5;
            this.speedY = Math.random() * 1.5 + 0.5;
            this.speedX = (Math.random() - 0.5) * 0.6;
            this.life = Math.random() * 0.6 + 0.4;
            this.opacity = Math.random() * 0.8 + 0.2;
            this.decay = Math.random() * 0.005 + 0.002;
            this.hue = Math.random() * 40 + 10; // orange-red range
        }
        update() {
            this.y -= this.speedY;
            this.x += this.speedX + Math.sin(this.y * 0.02) * 0.3;
            this.life -= this.decay;
            this.opacity = this.life * (Math.random() * 0.5 + 0.5);
            if (this.life <= 0 || this.y < -20) {
                this.reset();
            }
        }
        draw() {
            ctx.save();
            ctx.globalAlpha = this.opacity;
            ctx.fillStyle = `hsl(${this.hue}, 100%, 60%)`;
            ctx.shadowBlur = this.size * 4;
            ctx.shadowColor = `hsl(${this.hue}, 100%, 50%)`;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    for (let i = 0; i < maxSparks; i++) {
        sparks.push(new Spark());
    }

    function animate() {
        ctx.clearRect(0, 0, width, height);
        sparks.forEach(spark => {
            spark.update();
            spark.draw();
        });
        requestAnimationFrame(animate);
    }
    animate();
}

// ----------------------------------------
// 14. GLOBAL SPOTLIGHT CURSOR
// ----------------------------------------
function initGlobalSpotlight() {
    if (window.matchMedia('(pointer: coarse)').matches) return; // skip on touch
    const div = document.createElement('div');
    div.className = 'spotlight-cursor';
    document.body.appendChild(div);
    let mx = '50%', my = '50%';
    document.addEventListener('mousemove', (e) => {
        mx = e.clientX + 'px';
        my = e.clientY + 'px';
        div.style.setProperty('--mouse-x', mx);
        div.style.setProperty('--mouse-y', my);
    });
}

// ----------------------------------------
// 15. MARQUEE SKEW VELOCITY
// ----------------------------------------
function initMarqueeSkew() {
    const track = document.querySelector('.marquee-track');
    if (!track) return;
    let lastScroll = 0;
    let currentSkew = 0;
    window.addEventListener('scroll', () => {
        const diff = window.pageYOffset - lastScroll;
        lastScroll = window.pageYOffset;
        const target = Math.max(-12, Math.min(12, diff * 0.4));
        currentSkew += (target - currentSkew) * 0.1;
        track.style.transform = `skewX(${currentSkew}deg)`;
    }, { passive: true });
}
