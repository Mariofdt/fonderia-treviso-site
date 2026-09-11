// ========================================
// FONDERIA TREVISO - Popup promozionale da Firestore
// Mostra il primo popup attivo nella finestra startDate..endDate.
// Dismissal per-versione in localStorage: se l'admin modifica il
// popup (bump di `version`), il popup torna visibile a tutti.
// Fallback: se nessun popup evento è attivo, mostra la promo gamification
// attiva (priorità: evento > promo; dismissal separato per promo-<id>).
// ========================================

import { getDb, getFsMod } from './firebase-init.js';

const DISMISS_PREFIX = 'fond.popup.dismissed.';
const SHOW_DELAY_MS = 1800; // attende la fine del loader

document.addEventListener('DOMContentLoaded', () => {
    initPopup();
});

async function initPopup() {
    try {
        const db = await getDb();
        const fs = await getFsMod();
        const q = fs.query(
            fs.collection(db, 'popups'),
            fs.where('active', '==', true),
            fs.orderBy('startDate', 'desc')
        );
        const snap = await fs.getDocs(q);

        const now = new Date();
        const popup = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .find(p =>
                p.startDate && p.endDate &&
                p.startDate.toDate() <= now &&
                p.endDate.toDate() >= now &&
                !isDismissed(p)
            );

        if (!popup) {
            // Fallback: nessun popup evento valido → prova la promo attiva
            await initPromoPopup(fs, db);
            return;
        }
        setTimeout(() => showPopup(popup), SHOW_DELAY_MS);
    } catch (err) {
        // Firestore non disponibile: nessun popup, il sito resta identico
        console.warn('[popup] Firestore non disponibile, popup non mostrato.', err);
    }
}

function isDismissed(popup) {
    try {
        return localStorage.getItem(DISMISS_PREFIX + popup.id) === String(popup.version ?? 1);
    } catch {
        return false; // storage bloccato: mostra comunque
    }
}

function markDismissed(popup) {
    try {
        localStorage.setItem(DISMISS_PREFIX + popup.id, String(popup.version ?? 1));
    } catch {
        // storage bloccato: il popup si rimostra alla prossima visita
    }
}

function showPopup(popup) {
    if (document.getElementById('fondPopup')) return;

    const overlay = document.createElement('div');
    overlay.className = 'fond-popup-overlay';
    overlay.id = 'fondPopup';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'fond-popup-card';

    if (popup.imageUrl) {
        const media = document.createElement('div');
        media.className = 'fond-popup-media';
        media.style.backgroundImage = `url("${popup.imageUrl}")`;
        card.appendChild(media);
    }

    const body = document.createElement('div');
    body.className = 'fond-popup-body';

    if (popup.title) {
        const h = document.createElement('h3');
        h.textContent = popup.title;
        body.appendChild(h);
    }
    if (popup.body) {
        const p = document.createElement('p');
        p.textContent = popup.body;
        body.appendChild(p);
    }

    if (popup.ctaType === 'booking') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary fond-popup-cta';
        btn.textContent = popup.ctaLabel || 'Prenota ora';
        btn.addEventListener('click', () => {
            close(popup);
            if (window.FonderiaBooking) {
                window.FonderiaBooking.open({
                    service: popup.ctaBookingType || 'Cena',
                    eventTitle: popup.title || '',
                    source: `popup:${popup.id}`
                });
            } else {
                window.location.hash = '#contact';
            }
        });
        body.appendChild(btn);
    } else if (popup.ctaType === 'link' && popup.ctaUrl) {
        const a = document.createElement('a');
        a.className = 'btn btn-primary fond-popup-cta';
        a.href = popup.ctaUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = popup.ctaLabel || 'Scopri di più';
        a.addEventListener('click', () => close(popup));
        body.appendChild(a);
    }

    card.appendChild(body);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'fond-popup-close';
    closeBtn.setAttribute('aria-label', 'Chiudi');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => close(popup));

    card.appendChild(closeBtn);
    overlay.appendChild(card);

    function close(p) {
        markDismissed(p);
        overlay.classList.remove('active');
        setTimeout(() => overlay.remove(), 400);
        document.removeEventListener('keydown', onEsc);
    }

    function onEsc(e) {
        if (e.key === 'Escape') close(popup);
    }

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(popup);
    });
    document.addEventListener('keydown', onEsc);

    document.body.appendChild(overlay);
    // Forza il reflow per far partire la transition
    requestAnimationFrame(() => overlay.classList.add('active'));
}

// ========================================
// Fallback: popup della promo gamification attiva
// (mostrato solo se nessun popup evento è stato mostrato)
// ========================================
async function initPromoPopup(fs, db) {
    try {
        const q = fs.query(
            fs.collection(db, 'promos'),
            fs.where('active', '==', true), // obbligatorio: rules pubbliche promos
            fs.orderBy('createdAt', 'desc'), // richiede indice promos(active,createdAt desc)
            fs.limit(1)
        );
        const snap = await fs.getDocs(q);
        if (snap.empty) return;
        const p = { id: snap.docs[0].id, ...snap.docs[0].data() };
        const now = new Date();
        if (p.startsAt && p.startsAt.toDate() > now) return;
        if (p.endsAt && p.endsAt.toDate() < now) return;
        const dismissKey = DISMISS_PREFIX + 'promo-' + p.id;
        try { if (localStorage.getItem(dismissKey)) return; } catch { /* mostra comunque */ }
        setTimeout(() => showPromoPopup(p, dismissKey), SHOW_DELAY_MS);
    } catch (err) {
        // Indice non ancora deployato o query rifiutata: degrada in silenzio
        console.warn('[popup] Promo popup non mostrato.', err);
    }
}

function showPromoPopup(p, dismissKey) {
    if (document.getElementById('fondPopup')) return;

    const overlay = document.createElement('div');
    overlay.className = 'fond-popup-overlay';
    overlay.id = 'fondPopup';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'fond-popup-card';

    const body = document.createElement('div');
    body.className = 'fond-popup-body';

    if (p.title) {
        const h = document.createElement('h3');
        h.textContent = '🎁 ' + p.title;
        body.appendChild(h);
    }
    const desc = p.description || p.prizeLabel;
    if (desc) {
        const par = document.createElement('p');
        par.textContent = desc;
        body.appendChild(par);
    }

    const a = document.createElement('a');
    a.className = 'btn btn-primary fond-popup-cta';
    a.href = '/promo.html?p=' + encodeURIComponent(p.id);
    a.textContent = 'Partecipa';
    a.addEventListener('click', () => close());
    body.appendChild(a);

    card.appendChild(body);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'fond-popup-close';
    closeBtn.setAttribute('aria-label', 'Chiudi');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => close());

    card.appendChild(closeBtn);
    overlay.appendChild(card);

    function close() {
        try {
            localStorage.setItem(dismissKey, '1');
        } catch {
            // storage bloccato: il popup si rimostra alla prossima visita
        }
        overlay.classList.remove('active');
        setTimeout(() => overlay.remove(), 400);
        document.removeEventListener('keydown', onEsc);
    }

    function onEsc(e) {
        if (e.key === 'Escape') close();
    }

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onEsc);

    document.body.appendChild(overlay);
    // Forza il reflow per far partire la transition
    requestAnimationFrame(() => overlay.classList.add('active'));
}
