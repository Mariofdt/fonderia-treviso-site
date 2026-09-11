// ========================================
// FONDERIA TREVISO - Eventi dinamici da Firestore
// Rendera `#events .events-grid` da Firestore.
// FALLBACK: se la query fallisce o non ci sono eventi
// attivi futuri, le card statiche in index.html restano.
// ========================================

import { getDb, getFsMod } from './firebase-init.js';

document.addEventListener('DOMContentLoaded', () => {
    initEvents();
});

async function initEvents() {
    const grid = document.querySelector('#events .events-grid');
    if (!grid) return;

    try {
        const db = await getDb();
        const fs = await getFsMod();
        const q = fs.query(
            fs.collection(db, 'events'),
            fs.where('active', '==', true),
            fs.orderBy('date', 'asc')
        );
        const snap = await fs.getDocs(q);

        // Solo eventi da oggi in avanti, ordinati per `order` poi per data
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const events = snap.docs
            .map(d => d.data())
            .filter(ev => ev.date && ev.date.toDate() >= today)
            .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

        if (!events.length) return; // fallback: card statiche

        grid.innerHTML = '';
        events.forEach(ev => grid.appendChild(renderEventCard(ev)));
    } catch (err) {
        // Rete off / Firestore non raggiungibile: le card statiche restano
        console.warn('[events] Firestore non disponibile, uso le card statiche.', err);
    }
}

// Card nel markup esistente (.event-card). Classe `active` gia' applicata:
// l'observer forge-reveal gira solo su elementi presenti al DOMContentLoaded.
function renderEventCard(ev) {
    const card = document.createElement('div');
    card.className = 'event-card forge-reveal active';

    const img = document.createElement('img');
    img.src = ev.image || 'images/gallery5.jpg';
    img.alt = ev.title || 'Evento Fonderia';
    img.loading = 'lazy';
    card.appendChild(img);

    const body = document.createElement('div');
    body.className = 'event-card-body';

    const date = document.createElement('div');
    date.className = 'date';
    date.textContent = formatEventDate(ev);
    body.appendChild(date);

    const title = document.createElement('h3');
    title.textContent = ev.title || '';
    body.appendChild(title);

    if (ev.tagline || ev.description) {
        const p = document.createElement('p');
        p.textContent = ev.tagline || ev.description;
        body.appendChild(p);
    }

    card.appendChild(body);
    return card;
}

function formatEventDate(ev) {
    const d = ev.date.toDate();
    const day = d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    return ev.time ? `${day}, ore ${ev.time}` : day;
}
