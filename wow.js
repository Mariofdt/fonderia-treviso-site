// ========================================
// WOW EFFECTS - Loader, Particles, Cursor, Sound
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    initLoader();
    initParticles();
    initCustomCursor();
    initSoundToggle();
    initGlitchEffect();
    initSmoothScrollEnhanced();
});

// ----------------------------------------
// 1. LOADING SCREEN
// ----------------------------------------
function initLoader() {
    const loader = document.getElementById('loader');
    if (!loader) return;
    
    // Hide loader after everything loads
    window.addEventListener('load', () => {
        setTimeout(() => {
            loader.classList.add('hidden');
            // Trigger glitch effect after loader disappears
            setTimeout(() => {
                triggerGlitch();
            }, 400);
        }, 1800);
    });
    
    // Fallback: hide loader after 4s max
    setTimeout(() => {
        loader.classList.add('hidden');
    }, 4000);
}

// ----------------------------------------
// 2. FLOATING PARTICLES (Canvas)
// ----------------------------------------
function initParticles() {
    const canvas = document.getElementById('particles');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    let particles = [];
    let animationId;
    
    function resize() {
        const hero = document.getElementById('hero');
        if (!hero) return;
        canvas.width = hero.offsetWidth;
        canvas.height = hero.offsetHeight;
    }
    
    resize();
    window.addEventListener('resize', resize);
    
    class Particle {
        constructor() {
            this.reset();
        }
        
        reset() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.size = Math.random() * 2 + 0.5;
            this.speedX = (Math.random() - 0.5) * 0.3;
            this.speedY = (Math.random() - 0.5) * 0.3 - 0.2;
            this.opacity = Math.random() * 0.5 + 0.1;
            this.life = Math.random() * 100 + 100;
            this.maxLife = this.life;
        }
        
        update() {
            this.x += this.speedX;
            this.y += this.speedY;
            this.life--;
            
            if (this.life <= 0 || this.y < 0 || this.x < 0 || this.x > canvas.width) {
                this.reset();
                this.y = canvas.height + 10;
            }
        }
        
        draw() {
            const alpha = (this.life / this.maxLife) * this.opacity;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(201, 162, 39, ${alpha})`;
            ctx.fill();
        }
    }
    
    // Create particles
    const particleCount = Math.min(80, Math.floor(canvas.width / 15));
    for (let i = 0; i < particleCount; i++) {
        particles.push(new Particle());
    }
    
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => {
            p.update();
            p.draw();
        });
        animationId = requestAnimationFrame(animate);
    }
    
    animate();
    
    // Pause when not visible
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                if (!animationId) animate();
            } else {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
        });
    });
    observer.observe(canvas);
}

// ----------------------------------------
// 3. CUSTOM CURSOR
// ----------------------------------------
function initCustomCursor() {
    // Skip on touch devices
    if (window.matchMedia('(pointer: coarse)').matches) return;
    
    const cursor = document.createElement('div');
    cursor.className = 'custom-cursor';
    document.body.appendChild(cursor);
    
    let mouseX = 0, mouseY = 0;
    let cursorX = 0, cursorY = 0;
    
    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });
    
    function updateCursor() {
        cursorX += (mouseX - cursorX) * 0.15;
        cursorY += (mouseY - cursorY) * 0.15;
        cursor.style.left = cursorX + 'px';
        cursor.style.top = cursorY + 'px';
        requestAnimationFrame(updateCursor);
    }
    updateCursor();
    
    // Hover effect on interactive elements
    const interactives = document.querySelectorAll('a, button, .insta-slide, .exp-card, .faq-question');
    interactives.forEach(el => {
        el.addEventListener('mouseenter', () => cursor.classList.add('hover'));
        el.addEventListener('mouseleave', () => cursor.classList.remove('hover'));
    });
}

// ----------------------------------------
/* SOUND TOGGLE REPLACED BY music.js */
// // 4. SOUND TOGGLE (Procedural ambient)
// // ----------------------------------------
// function initSoundToggle() {
//     const btn = document.getElementById('soundToggle');
//     if (!btn) return;
//     let audioCtx = null;
//     let isPlaying = false;
//     let nodes = [];
//     btn.addEventListener('click', () => {
//         if (!isPlaying) {
//             startAmbient();
//             btn.classList.add('active');
//             document.getElementById('soundIconOff').style.display = 'none';
//             document.getElementById('soundIconOn').style.display = 'block';
//             isPlaying = true;
//         } else {
//             stopAmbient();
//             btn.classList.remove('active');
//             document.getElementById('soundIconOff').style.display = 'block';
//             document.getElementById('soundIconOn').style.display = 'none';
//             isPlaying = false;
//         }
//     });
//     function startAmbient() {
//         audioCtx = new (window.AudioContext || window.webkitAudioContext)();
//         // Create a deep bass drone
//         const osc1 = audioCtx.createOscillator();
//         const gain1 = audioCtx.createGain();
//         osc1.type = 'sine';
//         osc1.frequency.value = 55;
//         gain1.gain.value = 0.03;
//         osc1.connect(gain1);
//         gain1.connect(audioCtx.destination);
//         osc1.start();
//         nodes.push(osc1, gain1);
//         // Create a higher harmonic
//         const osc2 = audioCtx.createOscillator();
//         const gain2 = audioCtx.createGain();
//         osc2.type = 'triangle';
//         osc2.frequency.value = 110;
//         gain2.gain.value = 0.01;
//         osc2.connect(gain2);
//         gain2.connect(audioCtx.destination);
//         osc2.start();
//         nodes.push(osc2, gain2);
//         // Very subtle noise for texture
//         const bufferSize = audioCtx.sampleRate * 2;
//         const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
//         const data = buffer.getChannelData(0);
//         for (let i = 0; i < bufferSize; i++) {
//             data[i] = (Math.random() * 2 - 1) * 0.005;
//         }
//         const noise = audioCtx.createBufferSource();
//         noise.buffer = buffer;
//         noise.loop = true;
//         const noiseGain = audioCtx.createGain();
//         noiseGain.gain.value = 0.02;
//         const filter = audioCtx.createBiquadFilter();
//         filter.type = 'lowpass';
//         filter.frequency.value = 200;
//         noise.connect(filter);
//         filter.connect(noiseGain);
//         noiseGain.connect(audioCtx.destination);
//         noise.start();
//         nodes.push(noise, noiseGain, filter);
//     }
//     function stopAmbient() {
//         nodes.forEach(n => {
//             try { n.stop(); } catch(e) {}
//             try { n.disconnect(); } catch(e) {}
//         });
//         nodes = [];
//         if (audioCtx) {
//             audioCtx.close();
//             audioCtx = null;
//         }
//     }
// }
// // ----------------------------------------

// 5. GLITCH TEXT EFFECT
// ----------------------------------------
function initGlitchEffect() {
    const lines = document.querySelectorAll('.hero-title .line');
    lines.forEach(line => {
        line.setAttribute('data-text', line.textContent);
    });
}

function triggerGlitch() {
    const lines = document.querySelectorAll('.hero-title .line');
    lines.forEach((line, i) => {
        setTimeout(() => {
            line.classList.add('glitch');
            setTimeout(() => line.classList.remove('glitch'), 400);
        }, i * 200);
    });
}

// ----------------------------------------
// 6. ENHANCED SMOOTH SCROLL
// ----------------------------------------
function initSmoothScrollEnhanced() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const href = this.getAttribute('href');
            if (href === '#') return;
            
            e.preventDefault();
            const target = document.querySelector(href);
            if (!target) return;
            
            const navHeight = document.getElementById('navbar')?.offsetHeight || 0;
            const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - navHeight;
            
            window.scrollTo({
                top: targetPosition,
                behavior: 'smooth'
            });
        });
    });
}
