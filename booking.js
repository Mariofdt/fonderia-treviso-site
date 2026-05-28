// ========================================
// FONDERIA TREVISO - Booking via WhatsApp
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    initBooking();
});

function initBooking() {
    const overlay = document.getElementById('bookingOverlay');
    const closeBtn = document.getElementById('bookingClose');
    const form = document.getElementById('bookingForm');

    if (!overlay || !form) return;

    // Open modal from any booking link/button
    document.querySelectorAll('[data-booking], .btn[href="#contact"], a[href="#contact"]').forEach(el => {
        // Only hijack "prenota" buttons
        const txt = el.textContent.toLowerCase();
        if (txt.includes('prenota') || txt.includes('tavolo') || el.hasAttribute('data-booking')) {
            el.addEventListener('click', (e) => {
                if (el.getAttribute('href') === '#contact') {
                    e.preventDefault();
                }
                openBooking();
            });
        }
    });

    function openBooking() {
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
        // Set min date to today
        const dateInput = document.getElementById('bkDate');
        if (dateInput) {
            const today = new Date().toISOString().split('T')[0];
            dateInput.min = today;
        }
    }

    function closeBooking() {
        overlay.classList.remove('active');
        document.body.style.overflow = '';
    }

    if (closeBtn) closeBtn.addEventListener('click', closeBooking);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeBooking();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('active')) closeBooking();
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('bkName').value.trim();
        const date = document.getElementById('bkDate').value;
        const time = document.getElementById('bkTime').value;
        const guests = document.getElementById('bkGuests').value;
        const type = document.getElementById('bkType').value;
        const phone = document.getElementById('bkPhone').value.trim();
        const note = document.getElementById('bkNote').value.trim();

        const msg = `Ciao Fonderia! Vorrei prenotare un tavolo.

📋 Dati richiesta:
• Nome: ${name}
• Data: ${date}
• Ora: ${time}
• Persone: ${guests}
• Tipo: ${type}
• Tel: ${phone}
${note ? '• Note: ' + note : ''}

Attendo conferma, grazie! 🔥`;

        const waUrl = 'https://wa.me/393204137183?text=' + encodeURIComponent(msg);
        window.open(waUrl, '_blank');
        closeBooking();
    });
}
