// ========================================
// FONDERIA TREVISO - Booking via WhatsApp + Firestore
// Dual write: wa.me istantaneo (immutato) + addDoc su
// Firestore con timeout 3s, MAI bloccante per l'utente.
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    initBooking();
});

// API pubblica usata da popup.js (e altri ingressi futuri)
window.FonderiaBooking = {
    open({ service, eventTitle, source } = {}) {
        const overlay = document.getElementById('bookingOverlay');
        if (!overlay) { window.location.hash = '#contact'; return; }

        const serviceSel = document.getElementById('bkServiceType');
        const eventInput = document.getElementById('bkEventName');
        const sourceInput = document.getElementById('bkSource');

        if (serviceSel && service) {
            // Match case-insensitive sulle option (cena/after-cena/evento da popup)
            const match = [...serviceSel.options].find(o => o.value.toLowerCase() === String(service).toLowerCase());
            serviceSel.value = match ? match.value : 'Cena';
        }
        if (eventInput && eventTitle) eventInput.value = eventTitle;
        if (sourceInput && source) sourceInput.value = source;
        toggleEventField();

        openBookingModal();
    }
};

function openBookingModal() {
    const overlay = document.getElementById('bookingOverlay');
    if (!overlay) return;
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    // Set min date to today
    const dateInput = document.getElementById('bkDate');
    if (dateInput) {
        const today = new Date().toISOString().split('T')[0];
        dateInput.min = today;
    }
}

function closeBookingModal() {
    const overlay = document.getElementById('bookingOverlay');
    if (!overlay) return;
    overlay.classList.remove('active');
    document.body.style.overflow = '';
}

// Mostra il campo "Nome evento" solo se il servizio e' "Evento"
function toggleEventField() {
    const serviceSel = document.getElementById('bkServiceType');
    const eventGroup = document.getElementById('bkEventGroup');
    if (!serviceSel || !eventGroup) return;
    eventGroup.hidden = serviceSel.value !== 'Evento';
}

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
                openBookingModal();
            });
        }
    });

    if (closeBtn) closeBtn.addEventListener('click', closeBookingModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeBookingModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('active')) closeBookingModal();
    });

    const serviceSel = document.getElementById('bkServiceType');
    if (serviceSel) {
        serviceSel.addEventListener('change', toggleEventField);
        toggleEventField();
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('bkName').value.trim();
        const date = document.getElementById('bkDate').value;
        const time = document.getElementById('bkTime').value;
        const guests = document.getElementById('bkGuests').value;
        const type = document.getElementById('bkType').value;
        const phone = document.getElementById('bkPhone').value.trim();
        const note = document.getElementById('bkNote').value.trim();
        const service = serviceSel ? serviceSel.value : '';
        const eventInput = document.getElementById('bkEventName');
        const eventTitle = eventInput ? eventInput.value.trim() : '';
        const emailInput = document.getElementById('bkEmail');
        const email = emailInput ? emailInput.value.trim() : '';
        const sourceInput = document.getElementById('bkSource');
        const source = sourceInput && sourceInput.value ? sourceInput.value : 'site';

        const msg = `Ciao Fonderia! Vorrei prenotare un tavolo.

📋 Dati richiesta:
• Nome: ${name}
• Data: ${date}
• Ora: ${time}
• Persone: ${guests}
• Servizio: ${service}
• Tipo: ${type}
${service === 'Evento' && eventTitle ? '• Evento: ' + eventTitle + '\n' : ''}• Tel: ${phone}
${email ? '• Email: ' + email + '\n' : ''}${note ? '• Note: ' + note : ''}

Attendo conferma, grazie! 🔥`;

        // Salvataggio su Firestore in parallelo: non blocca mai l'apertura di WhatsApp
        saveBookingToFirestore({ name, date, time, guests, service, type, eventTitle, email, phone, note, source });

        const waUrl = 'https://wa.me/393204137183?text=' + encodeURIComponent(msg);
        window.open(waUrl, '_blank');
        closeBookingModal();
    });
}

// Dual write: addDoc con timeout 3s via Promise.race.
// Il flusso WhatsApp resta il canale primario e immediato.
function saveBookingToFirestore({ name, date, time, guests, service, type, eventTitle, email, phone, note, source }) {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 3s')), 3000));

    const write = (async () => {
        const { getDb, getFsMod } = await import('./firebase-init.js');
        const db = await getDb();
        const fs = await getFsMod();
        return fs.addDoc(fs.collection(db, 'bookings'), {
            name,
            date,
            time,
            guests: Number(guests),
            // le rules accettano solo enum minuscoli: cena | after-cena | evento
            service: String(service).toLowerCase(),
            tableType: type,
            ...(service === 'Evento' && eventTitle ? { eventTitle } : {}),
            ...(email ? { email } : {}),
            phone,
            note,
            source,
            status: 'new',
            createdAt: fs.serverTimestamp()
        });
    })();

    Promise.race([write, timeout]).catch(err => {
        console.warn('[booking] salvataggio Firestore saltato:', err);
    });
}
