/**
 * admin.js — Area Gestionale Fonderia Treviso
 * Magic link auth + whitelist config/admin → tab Eventi / Popup / Prenotazioni / Newsletter.
 * Dipende da firebase-init.js (getDb/getAuthInstance/getStorageInstance) e
 * firebase-config.js (window.FB_CONFIG), caricati da admin.html.
 */

import { getAuthInstance, getDb, getStorageInstance, getFunctionsInstance } from './firebase-init.js';
import { onAuthStateChanged, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signInWithEmailAndPassword, signOut }
    from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { collection, doc, getDoc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
         query, orderBy, limit, serverTimestamp, increment }
    from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { ref as storageRef, uploadBytes, getDownloadURL }
    from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import { httpsCallable }
    from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';

// Diagnostica avvio: __admMark è definito in admin.html (script classico,
// presente anche se questo modulo non dovesse essere valutato affatto).
const admMark = (m) => { if (window.__admMark) window.__admMark(m); };
admMark('admin.js caricato');

const EMAIL_LS_KEY = 'fond.emailForSignIn';
const LOCAL_IMAGES = ['images/hero-bg.jpg', 'images/birre.jpg', ...Array.from({ length: 11 }, (_, i) => `images/gallery${i + 1}.jpg`)];
const SERVICES = { cena: 'Cena', 'after-cena': 'After-Cena', evento: 'Evento' };
const BOOKING_STATUSES = { new: 'Nuova', confirmed: 'Confermata', cancelled: 'Annullata' };

const $ = (id) => document.getElementById(id);
const els = {
    boot: $('admBoot'),
    login: $('admLogin'),
    shell: $('admShell'),
    userEmail: $('admUserEmail'),
    logout: $('admLogout'),
    tabs: $('admTabs'),
    toast: $('admToast'),
    panels: {
        events: $('tab-events'),
        popups: $('tab-popups'),
        bookings: $('tab-bookings'),
        newsletter: $('tab-newsletter'),
        stats: $('tab-stats'),
    },
};

let unsubscribe = { events: null, popups: null, bookings: null, newsletter: null };
let bookingsCache = [];
let bookingsFilter = 'all';
let toastTimer = null;

/* ------------------------------------ utils ------------------------------------ */

function esc(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, isErr) {
    els.toast.textContent = msg;
    els.toast.classList.toggle('adm-toast--err', Boolean(isErr));
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4000);
}

function fmtDate(d) {
    if (!d) return '—';
    const date = d.toDate ? d.toDate() : new Date(d);
    if (isNaN(date)) return '—';
    return date.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(d) {
    if (!d) return '—';
    const date = d.toDate ? d.toDate() : new Date(d);
    if (isNaN(date)) return '—';
    return date.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' +
           date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function toDateInputValue(d) {
    if (!d) return '';
    const date = d.toDate ? d.toDate() : new Date(d);
    if (isNaN(date)) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function toDatetimeLocalValue(d) {
    if (!d) return '';
    const date = d.toDate ? d.toDate() : new Date(d);
    if (isNaN(date)) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sanitizeFilename(name) {
    return name.toLowerCase().replace(/[^a-z0-9.\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'immagine';
}

/* ------------------------------------ login ------------------------------------ */

function showBoot() {
    els.boot.hidden = false;
    els.login.hidden = true;
    els.shell.hidden = true;
}

function showLogin(state, email) {
    els.boot.hidden = true;
    els.shell.hidden = true;
    els.login.hidden = false;

    if (state === 'sent') {
        els.login.innerHTML = `
            <div class="adm-login-card">
                <h2>Controlla la tua email</h2>
                <p class="adm-login-sub">Abbiamo inviato un link di accesso a <strong>${esc(email)}</strong>.
                Aprilo <strong>da questo stesso dispositivo e browser</strong> per entrare.</p>
                <button class="adm-btn adm-btn-ghost" data-login-action="reset" type="button">Usa un'altra email</button>
            </div>`;
        return;
    }

    if (state === 'confirm') {
        els.login.innerHTML = `
            <div class="adm-login-card">
                <h2>Conferma la tua email</h2>
                <p class="adm-login-sub">Stai aprendo il link di accesso da un dispositivo diverso:
                per sicurezza inserisci di nuovo la tua email.</p>
                <form id="admConfirmForm" class="booking-form" novalidate>
                    <div class="adm-group">
                        <label for="admConfirmEmail">Email</label>
                        <input id="admConfirmEmail" type="email" required autocomplete="email" placeholder="nome@esempio.it">
                    </div>
                    <button class="adm-btn" type="submit">Continua</button>
                    <div id="admConfirmErr" class="adm-inline-err" hidden></div>
                </form>
            </div>`;
        $('admConfirmForm').addEventListener('submit', onConfirmEmailSubmit);
        return;
    }

    els.login.innerHTML = `
        <div class="adm-login-card">
            <h2>Area Gestionale</h2>
            <p class="adm-login-sub">Inserisci email e password per entrare.
            Se lasci la password vuota ti inviamo un link di accesso via email.
            L'accesso è riservato ai gestori autorizzati.</p>
            <form id="admLoginForm" class="booking-form" novalidate>
                <div class="adm-group">
                    <label for="admEmail">Email</label>
                    <input id="admEmail" type="email" required autocomplete="email" placeholder="nome@esempio.it">
                </div>
                <div class="adm-group">
                    <label for="admPassword">Password <span class="adm-optional">(opzionale)</span></label>
                    <input id="admPassword" type="password" autocomplete="current-password" placeholder="Lascia vuoto per il link via email">
                </div>
                <button class="adm-btn" type="submit" data-label-empty="Inviami il link di accesso">Accedi</button>
                <div id="admLoginErr" class="adm-inline-err" hidden></div>
            </form>
        </div>`;
    // Il bottone cambia etichetta in base alla presenza della password
    const pwInput = $('admPassword');
    const submitBtn = els.login.querySelector('button[type="submit"]');
    pwInput.addEventListener('input', () => {
        submitBtn.textContent = pwInput.value ? 'Accedi' : submitBtn.dataset.labelEmpty;
    });
    $('admLoginForm').addEventListener('submit', onLoginSubmit);
}

function showUnauthorized(email) {
    els.boot.hidden = true;
    els.shell.hidden = true;
    els.login.hidden = false;
    els.login.innerHTML = `
        <div class="adm-login-card">
            <h2>Account non autorizzato</h2>
            <p class="adm-login-sub"><strong>${esc(email)}</strong> non è tra i gestori autorizzati di Fonderia.
            Chiedi al titolare di aggiungerla in Firestore: <code>config/admin → allowedEmails</code>.</p>
            <button class="adm-btn adm-btn-ghost" data-login-action="logout" type="button">Esci</button>
        </div>`;
}

async function onLoginSubmit(e) {
    e.preventDefault();
    const email = $('admEmail').value.trim();
    const password = $('admPassword') ? $('admPassword').value : '';
    const errBox = $('admLoginErr');
    const btn = e.target.querySelector('button[type="submit"]');
    errBox.hidden = true;
    if (!email) { errBox.textContent = 'Inserisci un indirizzo email.'; errBox.hidden = false; return; }
    btn.disabled = true;
    try {
        const auth = await getAuthInstance();
        if (password) {
            // Login con password: la whitelist viene controllata da onAuthStateChanged
            await signInWithEmailAndPassword(auth, email, password);
            return; // la shell si apre dal listener; il bottone non serve più
        }
        await sendSignInLinkToEmail(auth, email, {
            url: location.origin + location.pathname,
            handleCodeInApp: true,
        });
        localStorage.setItem(EMAIL_LS_KEY, email);
        showLogin('sent', email);
    } catch (err) {
        console.error('[admin] login error:', err);
        if (err && (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found')) {
            errBox.textContent = 'Email o password non corrette.';
        } else if (err && err.code === 'auth/too-many-requests') {
            errBox.textContent = 'Troppi tentativi. Attendi qualche minuto e riprova.';
        } else if (password) {
            errBox.textContent = 'Accesso non riuscito (' + (err.code || err.message) + ').';
        } else {
            errBox.textContent = 'Invio non riuscito (' + (err.code || err.message) + '). Controlla la connessione e riprova.';
        }
        errBox.hidden = false;
        btn.disabled = false;
    }
}

async function onConfirmEmailSubmit(e) {
    e.preventDefault();
    const email = $('admConfirmEmail').value.trim();
    const errBox = $('admConfirmErr');
    errBox.hidden = true;
    if (!email) { errBox.textContent = 'Inserisci la tua email.'; errBox.hidden = false; return; }
    localStorage.setItem(EMAIL_LS_KEY, email);
    await completeEmailLinkSignIn();
}

async function completeEmailLinkSignIn() {
    try {
        const auth = await getAuthInstance();
        let email = localStorage.getItem(EMAIL_LS_KEY);
        if (!email) { showLogin('confirm'); return; }
        await signInWithEmailLink(auth, email, window.location.href);
        localStorage.removeItem(EMAIL_LS_KEY);
        history.replaceState(null, document.title, location.pathname);
    } catch (err) {
        console.error('[admin] signInWithEmailLink error:', err);
        history.replaceState(null, document.title, location.pathname);
        showLogin();
        toast('Link non valido o scaduto. Richiedi un nuovo link di accesso.', true);
    }
}

/* ------------------------------------ shell ------------------------------------ */

async function initShell(user) {
    els.boot.hidden = true;
    els.login.hidden = true;
    els.shell.hidden = false;
    els.userEmail.textContent = user.email || '';

    els.tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.adm-tab');
        if (!btn) return;
        els.tabs.querySelectorAll('.adm-tab').forEach((t) => t.classList.toggle('active', t === btn));
        Object.entries(els.panels).forEach(([k, el]) => { el.hidden = k !== btn.dataset.tab; });
    });

    startEventsTab();
    startPopupsTab();
    startBookingsTab();
    startNewsletterTab();
    startStatsTab();
}

function stopAll() {
    Object.values(unsubscribe).forEach((fn) => { if (fn) fn(); });
    unsubscribe = { events: null, popups: null, bookings: null, newsletter: null };
}

/* ------------------------------------ tab: eventi ------------------------------------ */

function eventFormHTML(ev) {
    const isEdit = Boolean(ev);
    const options = LOCAL_IMAGES.map((src) => {
        const sel = isEdit && ev.image === src ? ' selected' : '';
        return `<option value="${src}"${sel}>${src.replace('images/', '')}</option>`;
    }).join('');
    const customUrl = isEdit && ev.image && !LOCAL_IMAGES.includes(ev.image) ? ev.image : '';
    return `
    <form id="evForm" class="adm-form" novalidate>
        <div class="adm-form-title">${isEdit ? 'Modifica evento' : 'Nuovo evento'}</div>
        <div class="adm-row">
            <div class="adm-group">
                <label for="evTitle">Titolo</label>
                <input id="evTitle" type="text" required value="${esc(ev?.title || '')}" placeholder="Apertura Stagione">
            </div>
            <div class="adm-group">
                <label for="evTagline">Tagline</label>
                <input id="evTagline" type="text" value="${esc(ev?.tagline || '')}" placeholder="Una serata speciale…">
            </div>
        </div>
        <div class="adm-row--3 adm-row">
            <div class="adm-group">
                <label for="evDate">Data</label>
                <input id="evDate" type="date" required value="${isEdit ? toDateInputValue(ev.date) : ''}">
            </div>
            <div class="adm-group">
                <label for="evTime">Ora</label>
                <input id="evTime" type="text" value="${esc(ev?.time || '')}" placeholder="19:00">
            </div>
            <div class="adm-group">
                <label for="evOrder">Ordine</label>
                <input id="evOrder" type="number" step="1" value="${esc(ev?.order ?? 0)}">
            </div>
        </div>
        <div class="adm-group">
            <label for="evDescription">Descrizione</label>
            <textarea id="evDescription" rows="3">${esc(ev?.description || '')}</textarea>
        </div>
        <div class="adm-row">
            <div class="adm-group">
                <label for="evImageSelect">Immagine (galleria)</label>
                <select id="evImageSelect">
                    <option value="">— scegli dalla galleria —</option>
                    ${options}
                </select>
            </div>
            <div class="adm-group">
                <label for="evImageUrl">oppure URL immagine libero</label>
                <input id="evImageUrl" type="url" value="${esc(customUrl)}" placeholder="https://…" ${customUrl ? '' : 'disabled'}>
            </div>
        </div>
        <label class="adm-check">
            <input id="evActive" type="checkbox" ${!isEdit || ev.active !== false ? 'checked' : ''}>
            Attivo (visibile sul sito)
        </label>
        <div id="evFormErr" class="adm-inline-err" hidden></div>
        <div class="adm-form-actions">
            <button class="adm-btn" type="submit">${isEdit ? 'Salva modifiche' : 'Crea evento'}</button>
            <button class="adm-btn adm-btn-ghost" type="button" data-ev-action="cancel">Annulla</button>
        </div>
    </form>`;
}

async function startEventsTab() {
    const panel = els.panels.events;
    let editingId = null;
    let cached = [];

    panel.innerHTML = `
        <div class="adm-panel-head">
            <div>
                <h2>Eventi</h2>
                <p class="adm-panel-lead">Gli eventi attivi compaiono nella sezione Eventi del sito, in ordine di data.</p>
            </div>
            <button class="adm-btn" data-ev-action="new" type="button">+ Nuovo evento</button>
        </div>
        <div id="evFormSlot"></div>
        <div id="evList" class="adm-list"><div class="adm-empty">Caricamento eventi…</div></div>`;

    const formSlot = panel.querySelector('#evFormSlot');
    const listEl = panel.querySelector('#evList');

    function renderList() {
        if (!cached.length) {
            listEl.innerHTML = '<div class="adm-empty">Nessun evento ancora. Crea il primo con "+ Nuovo evento".</div>';
            return;
        }
        listEl.innerHTML = cached.map(({ id, data: ev }) => `
            <div class="adm-card${ev.active === false ? ' inactive' : ''}">
                <div class="adm-card-main">
                    <div class="adm-card-title">${esc(ev.title || '(senza titolo)')}</div>
                    <div class="adm-card-sub">${fmtDate(ev.date)}${ev.time ? ' · ' + esc(ev.time) : ''}</div>
                </div>
                <div class="adm-card-actions">
                    <span class="adm-badge ${ev.active !== false ? 'adm-badge--on' : 'adm-badge--off'}">${ev.active !== false ? 'Attivo' : 'Nascosto'}</span>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-ev-action="toggle" data-id="${id}" type="button">${ev.active !== false ? 'Disattiva' : 'Attiva'}</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-ev-action="edit" data-id="${id}" type="button">Modifica</button>
                    <button class="adm-btn adm-btn-danger adm-btn-sm" data-ev-action="delete" data-id="${id}" type="button">Elimina</button>
                </div>
            </div>`).join('');
    }

    function openForm(ev, id) {
        editingId = id;
        formSlot.innerHTML = eventFormHTML(ev);
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    panel.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-ev-action]');
        if (!btn) return;
        const action = btn.dataset.evAction;
        const id = btn.dataset.id;
        const entry = cached.find((c) => c.id === id);

        try {
            const db = await getDb();
            if (action === 'new') openForm(null, null);
            else if (action === 'cancel') { formSlot.innerHTML = ''; editingId = null; }
            else if (action === 'edit') { if (entry) openForm(entry.data, id); }
            else if (action === 'toggle') {
                await updateDoc(doc(db, 'events', id), { active: entry.data.active === false, updatedAt: serverTimestamp() });
            } else if (action === 'delete') {
                if (confirm(`Eliminare l'evento "${entry?.data?.title || id}"? L'azione non è reversibile.`)) {
                    await deleteDoc(doc(db, 'events', id));
                    toast('Evento eliminato.');
                }
            }
        } catch (err) {
            console.error('[admin] events action error:', err);
            toast('Operazione non riuscita: ' + (err.code || err.message), true);
        }
    });

    panel.addEventListener('change', (e) => {
        if (e.target.id === 'evImageSelect') {
            const urlInput = $('evImageUrl');
            if (e.target.value) { urlInput.value = ''; urlInput.disabled = true; }
            else urlInput.disabled = false;
        }
        if (e.target.id === 'evImageUrl' && e.target.value) $('evImageSelect').value = '';
    });

    panel.addEventListener('submit', async (e) => {
        if (e.target.id !== 'evForm') return;
        e.preventDefault();
        const errBox = $('evFormErr');
        errBox.hidden = true;

        const title = $('evTitle').value.trim();
        const tagline = $('evTagline').value.trim();
        const dateStr = $('evDate').value;
        const time = $('evTime').value.trim();
        const description = $('evDescription').value.trim();
        const selImage = $('evImageSelect').value;
        const urlImage = $('evImageUrl').value.trim();
        const image = urlImage || selImage || '';
        const active = $('evActive').checked;
        const order = Number($('evOrder').value) || 0;

        if (!title || !dateStr) {
            errBox.textContent = 'Titolo e data sono obbligatori.';
            errBox.hidden = false;
            return;
        }
        const date = new Date(dateStr + 'T12:00:00');
        if (isNaN(date)) {
            errBox.textContent = 'Data non valida.';
            errBox.hidden = false;
            return;
        }

        const payload = { title, tagline, date, time, description, image, active, order, updatedAt: serverTimestamp() };

        try {
            const db = await getDb();
            if (editingId) {
                await updateDoc(doc(db, 'events', editingId), payload);
                toast('Evento aggiornato.');
            } else {
                await addDoc(collection(db, 'events'), { ...payload, createdAt: serverTimestamp() });
                toast('Evento creato.');
            }
            formSlot.innerHTML = '';
            editingId = null;
        } catch (err) {
            console.error('[admin] save event error:', err);
            errBox.textContent = 'Salvataggio non riuscito: ' + (err.code || err.message);
            errBox.hidden = false;
        }
    });

    try {
        const db = await getDb();
        unsubscribe.events = onSnapshot(
            query(collection(db, 'events'), orderBy('date', 'desc')),
            (snap) => {
                cached = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
                renderList();
            },
            (err) => {
                console.error('[admin] events snapshot error:', err);
                listEl.innerHTML = '<div class="adm-inline-err">Errore nel caricamento degli eventi.</div>';
            }
        );
    } catch (err) {
        console.error('[admin] events init error:', err);
        listEl.innerHTML = '<div class="adm-inline-err">Impossibile connettersi al database.</div>';
    }
}

/* ------------------------------------ tab: popup ------------------------------------ */

function popupFormHTML(pop) {
    const isEdit = Boolean(pop);
    const ctaType = pop?.ctaType || 'booking';
    const imageSource = pop?.imageSource || 'local';
    const imageUrl = pop?.imageUrl || '';
    const grid = LOCAL_IMAGES.map((src) => {
        const selected = imageSource === 'local' && (imageUrl === src || (!isEdit && src === LOCAL_IMAGES[0]));
        return `
        <button type="button" class="adm-img-cell${selected ? ' selected' : ''}" data-pop-img="${src}">
            <img src="${src}" alt="${src}" loading="lazy">
            <span class="adm-img-name">${src.replace('images/', '')}</span>
            <input type="radio" name="popBg" value="${src}" ${selected ? 'checked' : ''} hidden>
        </button>`;
    }).join('');
    const storagePreview = imageSource === 'storage' && imageUrl
        ? `<img class="adm-img-preview" src="${esc(imageUrl)}" alt="immagine caricata">` : '';
    return `
    <form id="popForm" class="adm-form" novalidate>
        <div class="adm-form-title">${isEdit ? 'Modifica popup' : 'Nuovo popup'}</div>
        <div class="adm-row">
            <div class="adm-group">
                <label for="popTitle">Titolo</label>
                <input id="popTitle" type="text" required value="${esc(pop?.title || '')}" placeholder="Apertura stagione">
            </div>
            <div class="adm-group">
                <label for="popBody">Testo</label>
                <input id="popBody" type="text" value="${esc(pop?.body || '')}" placeholder="Venerdì 3 ottobre riapriamo…">
            </div>
        </div>
        <div class="adm-row">
            <div class="adm-group">
                <label for="popStart">Visibile da</label>
                <input id="popStart" type="datetime-local" required value="${isEdit ? toDatetimeLocalValue(pop.startDate) : ''}">
            </div>
            <div class="adm-group">
                <label for="popEnd">Fino a</label>
                <input id="popEnd" type="datetime-local" required value="${isEdit ? toDatetimeLocalValue(pop.endDate) : ''}">
            </div>
        </div>
        <fieldset class="adm-fieldset">
            <legend>Call to action</legend>
            <div class="adm-radio-row">
                <label class="adm-check">
                    <input type="radio" name="popCtaType" value="booking" ${ctaType === 'booking' ? 'checked' : ''}>
                    Prenotazione
                </label>
                <label class="adm-check">
                    <input type="radio" name="popCtaType" value="link" ${ctaType === 'link' ? 'checked' : ''}>
                    Link esterno
                </label>
            </div>
            <div id="popCtaBooking" ${ctaType === 'booking' ? '' : 'hidden'}>
                <div class="adm-row">
                    <div class="adm-group">
                        <label for="popCtaBookingType">Tipo prenotazione</label>
                        <select id="popCtaBookingType">
                            <option value="cena" ${pop?.ctaBookingType === 'cena' ? 'selected' : ''}>Cena</option>
                            <option value="after-cena" ${pop?.ctaBookingType === 'after-cena' ? 'selected' : ''}>After-Cena</option>
                            <option value="evento" ${pop?.ctaBookingType === 'evento' ? 'selected' : ''}>Evento</option>
                        </select>
                    </div>
                    <div class="adm-group">
                        <label for="popEventTitle">Titolo evento (se tipo = Evento)</label>
                        <input id="popEventTitle" type="text" value="${esc(pop?.eventTitle || '')}" placeholder="Apertura Stagione 2026">
                    </div>
                </div>
            </div>
            <div id="popCtaLink" ${ctaType === 'link' ? '' : 'hidden'}>
                <div class="adm-row">
                    <div class="adm-group">
                        <label for="popCtaUrl">URL</label>
                        <input id="popCtaUrl" type="url" value="${esc(ctaType === 'link' ? (pop?.ctaUrl || '') : '')}" placeholder="https://…">
                    </div>
                    <div class="adm-group">
                        <label for="popCtaLabel">Etichetta bottone</label>
                        <input id="popCtaLabel" type="text" value="${esc(pop?.ctaLabel || 'Scopri di più')}" placeholder="Scopri di più">
                    </div>
                </div>
            </div>
        </fieldset>
        <fieldset class="adm-fieldset">
            <legend>Sfondo</legend>
            <div class="adm-img-grid">${grid}</div>
            <div class="adm-group" style="margin-top:10px;">
                <label for="popUpload">Carica nuova immagine (Storage)</label>
                <input id="popUpload" type="file" accept="image/*">
                <div id="popUploadPreview">${storagePreview}</div>
            </div>
        </fieldset>
        <label class="adm-check">
            <input id="popActive" type="checkbox" ${!isEdit || pop.active !== false ? 'checked' : ''}>
            Attivo
        </label>
        <label class="adm-check">
            <input id="popKeepDismissal" type="checkbox">
            Mantieni dismissal di chi l'ha già visto
            <span class="adm-check-note">— altrimenti il salvataggio rimostra il popup a tutti</span>
        </label>
        <div id="popFormErr" class="adm-inline-err" hidden></div>
        <div class="adm-form-actions">
            <button class="adm-btn" type="submit">${isEdit ? 'Salva modifiche' : 'Crea popup'}</button>
            <button class="adm-btn adm-btn-ghost" type="button" data-pop-action="cancel">Annulla</button>
        </div>
    </form>`;
}

async function startPopupsTab() {
    const panel = els.panels.popups;
    let editingId = null;
    let cached = [];
    let uploadedImage = null; // { imageUrl, imageSource: 'storage' }

    panel.innerHTML = `
        <div class="adm-panel-head">
            <div>
                <h2>Popup</h2>
                <p class="adm-panel-lead">Il popup attivo e nel suo intervallo di date viene mostrato ai visitatori del sito. Ogni salvataggio (salvo la spunta "mantieni dismissal") lo rimostra a tutti.</p>
            </div>
            <button class="adm-btn" data-pop-action="new" type="button">+ Nuovo popup</button>
        </div>
        <div id="popFormSlot"></div>
        <div id="popList" class="adm-list"><div class="adm-empty">Caricamento popup…</div></div>`;

    const formSlot = panel.querySelector('#popFormSlot');
    const listEl = panel.querySelector('#popList');

    function renderList() {
        if (!cached.length) {
            listEl.innerHTML = '<div class="adm-empty">Nessun popup ancora.</div>';
            return;
        }
        listEl.innerHTML = cached.map(({ id, data: p }) => `
            <div class="adm-card${p.active === false ? ' inactive' : ''}">
                <div class="adm-card-main">
                    <div class="adm-card-title">${esc(p.title || '(senza titolo)')} <span class="adm-cell-muted">v${p.version || 1}</span></div>
                    <div class="adm-card-sub">${fmtDateTime(p.startDate)} → ${fmtDateTime(p.endDate)} · CTA: ${esc(p.ctaType || 'booking')}</div>
                </div>
                <div class="adm-card-actions">
                    <span class="adm-badge ${p.active !== false ? 'adm-badge--on' : 'adm-badge--off'}">${p.active !== false ? 'Attivo' : 'Nascosto'}</span>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-pop-action="toggle" data-id="${id}" type="button">${p.active !== false ? 'Disattiva' : 'Attiva'}</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-pop-action="edit" data-id="${id}" type="button">Modifica</button>
                    <button class="adm-btn adm-btn-danger adm-btn-sm" data-pop-action="delete" data-id="${id}" type="button">Elimina</button>
                </div>
            </div>`).join('');
    }

    function openForm(pop, id) {
        editingId = id;
        uploadedImage = null;
        formSlot.innerHTML = popupFormHTML(pop);
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function handleUpload(file) {
        const errBox = $('popFormErr');
        errBox.hidden = true;
        if (file.size > 3 * 1024 * 1024) {
            errBox.textContent = 'Immagine troppo grande (max 3 MB).';
            errBox.hidden = false;
            return;
        }
        try {
            const storage = await getStorageInstance();
            const path = 'popup-images/' + Date.now() + '-' + sanitizeFilename(file.name);
            await uploadBytes(storageRef(storage, path), file);
            const url = await getDownloadURL(storageRef(storage, path));
            uploadedImage = { imageUrl: url, imageSource: 'storage' };
            // deseleziona radio locali
            panel.querySelectorAll('#popForm .adm-img-cell').forEach((c) => c.classList.remove('selected'));
            const r = panel.querySelector('#popForm input[name="popBg"]:checked');
            if (r) r.checked = false;
            $('popUploadPreview').innerHTML = `<img class="adm-img-preview" src="${url}" alt="immagine caricata">`;
            toast('Immagine caricata. Salva il popup per usarla.');
        } catch (err) {
            console.error('[admin] storage upload error:', err);
            errBox.hidden = false;
            errBox.textContent = err.code === 'storage/unauthorized'
                ? 'Upload non consentito: Firebase Storage non è ancora attivo o le regole lo bloccano. Per ora usa le immagini della galleria.'
                : 'Upload non riuscito: ' + (err.code || err.message);
        }
    }

    panel.addEventListener('click', async (e) => {
        const imgCell = e.target.closest('.adm-img-cell');
        if (imgCell) {
            panel.querySelectorAll('.adm-img-cell').forEach((c) => c.classList.remove('selected'));
            imgCell.classList.add('selected');
            imgCell.querySelector('input[type="radio"]').checked = true;
            uploadedImage = null;
            const prev = $('popUploadPreview');
            if (prev) prev.innerHTML = '';
            return;
        }

        const btn = e.target.closest('[data-pop-action]');
        if (!btn) return;
        const action = btn.dataset.popAction;
        const id = btn.dataset.id;
        const entry = cached.find((c) => c.id === id);

        try {
            const db = await getDb();
            if (action === 'new') openForm(null, null);
            else if (action === 'cancel') { formSlot.innerHTML = ''; editingId = null; uploadedImage = null; }
            else if (action === 'edit') { if (entry) openForm(entry.data, id); }
            else if (action === 'toggle') {
                await updateDoc(doc(db, 'popups', id), { active: entry.data.active === false, updatedAt: serverTimestamp() });
            } else if (action === 'delete') {
                if (confirm(`Eliminare il popup "${entry?.data?.title || id}"? L'azione non è reversibile.`)) {
                    await deleteDoc(doc(db, 'popups', id));
                    toast('Popup eliminato.');
                }
            }
        } catch (err) {
            console.error('[admin] popups action error:', err);
            toast('Operazione non riuscita: ' + (err.code || err.message), true);
        }
    });

    panel.addEventListener('change', (e) => {
        if (e.target.name === 'popCtaType') {
            const isBooking = e.target.value === 'booking';
            $('popCtaBooking').hidden = !isBooking;
            $('popCtaLink').hidden = isBooking;
        }
        if (e.target.id === 'popUpload' && e.target.files[0]) {
            handleUpload(e.target.files[0]);
        }
    });

    panel.addEventListener('submit', async (e) => {
        if (e.target.id !== 'popForm') return;
        e.preventDefault();
        const errBox = $('popFormErr');
        errBox.hidden = true;

        const title = $('popTitle').value.trim();
        const body = $('popBody').value.trim();
        const startStr = $('popStart').value;
        const endStr = $('popEnd').value;
        const ctaType = (panel.querySelector('#popForm input[name="popCtaType"]:checked') || {}).value || 'booking';
        const active = $('popActive').checked;
        const keepDismissal = $('popKeepDismissal').checked;

        const startDate = new Date(startStr);
        const endDate = new Date(endStr);
        if (!title) { errBox.textContent = 'Il titolo è obbligatorio.'; errBox.hidden = false; return; }
        if (!startStr || !endStr || isNaN(startDate) || isNaN(endDate)) {
            errBox.textContent = 'Date di visibilità non valide.'; errBox.hidden = false; return;
        }
        if (endDate <= startDate) {
            errBox.textContent = 'La fine deve essere successiva all\'inizio.'; errBox.hidden = false; return;
        }

        let imageUrl, imageSource;
        if (uploadedImage) {
            ({ imageUrl, imageSource } = uploadedImage);
        } else {
            const sel = panel.querySelector('#popForm input[name="popBg"]:checked');
            const entry = editingId ? cached.find((c) => c.id === editingId) : null;
            if (sel) {
                imageUrl = sel.value;
                imageSource = 'local';
            } else if (entry?.data?.imageSource === 'storage' && entry?.data?.imageUrl) {
                imageUrl = entry.data.imageUrl;
                imageSource = 'storage';
            } else {
                errBox.textContent = 'Scegli uno sfondo dalla galleria o carica un\'immagine.';
                errBox.hidden = false;
                return;
            }
        }

        const payload = {
            title, body, startDate, endDate, active,
            imageUrl, imageSource,
            ctaType,
            updatedAt: serverTimestamp(),
        };
        if (ctaType === 'booking') {
            payload.ctaBookingType = $('popCtaBookingType').value;
            payload.eventTitle = $('popEventTitle').value.trim();
            payload.ctaLabel = 'Prenota';
            payload.ctaUrl = null;
        } else {
            payload.ctaUrl = $('popCtaUrl').value.trim();
            payload.ctaLabel = $('popCtaLabel').value.trim() || 'Scopri di più';
            payload.ctaBookingType = null;
            payload.eventTitle = null;
            if (!payload.ctaUrl) { errBox.textContent = 'Inserisci l\'URL del link.'; errBox.hidden = false; return; }
        }

        try {
            const db = await getDb();
            if (editingId) {
                if (!keepDismissal) payload.version = increment(1);
                await updateDoc(doc(db, 'popups', editingId), payload);
                toast(keepDismissal ? 'Popup aggiornato (dismissal mantenuto).' : 'Popup aggiornato: verrà ri-mostrato a tutti.');
            } else {
                await addDoc(collection(db, 'popups'), { ...payload, version: 1, createdAt: serverTimestamp() });
                toast('Popup creato.');
            }
            formSlot.innerHTML = '';
            editingId = null;
            uploadedImage = null;
        } catch (err) {
            console.error('[admin] save popup error:', err);
            errBox.textContent = 'Salvataggio non riuscito: ' + (err.code || err.message);
            errBox.hidden = false;
        }
    });

    try {
        const db = await getDb();
        unsubscribe.popups = onSnapshot(
            query(collection(db, 'popups'), orderBy('startDate', 'desc')),
            (snap) => {
                cached = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
                renderList();
            },
            (err) => {
                console.error('[admin] popups snapshot error:', err);
                listEl.innerHTML = '<div class="adm-inline-err">Errore nel caricamento dei popup.</div>';
            }
        );
    } catch (err) {
        console.error('[admin] popups init error:', err);
        listEl.innerHTML = '<div class="adm-inline-err">Impossibile connettersi al database.</div>';
    }
}

/* ------------------------------------ tab: prenotazioni ------------------------------------ */

function bookingsBadge(status) {
    const cls = status === 'confirmed' ? 'adm-badge--confirmed' : status === 'cancelled' ? 'adm-badge--cancelled' : 'adm-badge--new';
    return `<span class="adm-badge ${cls}">${esc(BOOKING_STATUSES[status] || status || 'new')}</span>`;
}

async function startBookingsTab() {
    const panel = els.panels.bookings;

    panel.innerHTML = `
        <div class="adm-panel-head">
            <div>
                <h2>Prenotazioni</h2>
                <p class="adm-panel-lead">Ultime 200 richieste dal sito. Il badge email indica se la notifica automatica è partita.</p>
            </div>
        </div>
        <div class="adm-toolbar">
            <label for="bkFilter">Stato</label>
            <select id="bkFilter">
                <option value="all">Tutte</option>
                <option value="new">Nuove</option>
                <option value="confirmed">Confermate</option>
                <option value="cancelled">Annullate</option>
            </select>
            <span class="adm-count" id="bkCount"></span>
        </div>
        <div class="adm-table-wrap">
            <table class="adm-table">
                <thead>
                    <tr>
                        <th>Data/Ora</th><th>Nome</th><th>Servizio</th><th>Persone</th>
                        <th>Telefono</th><th>Email</th><th>Fonte</th><th>Email inviata</th>
                        <th>Stato</th><th></th>
                    </tr>
                </thead>
                <tbody id="bkTbody">
                    <tr><td colspan="10"><div class="adm-empty">Caricamento prenotazioni…</div></td></tr>
                </tbody>
            </table>
        </div>`;

    const tbody = panel.querySelector('#bkTbody');
    const filterSel = panel.querySelector('#bkFilter');
    const countEl = panel.querySelector('#bkCount');

    function render() {
        const rows = bookingsFilter === 'all' ? bookingsCache : bookingsCache.filter((b) => (b.data.status || 'new') === bookingsFilter);
        countEl.textContent = rows.length + ' prenotazion' + (rows.length === 1 ? 'e' : 'i');
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="10"><div class="adm-empty">Nessuna prenotazione ancora.</div></td></tr>';
            return;
        }
        tbody.innerHTML = rows.map(({ id, data: b }) => `
            <tr>
                <td class="adm-cell-strong">${esc(b.date || '—')}<br><span class="adm-cell-muted">${esc(b.time || '')}</span></td>
                <td class="adm-cell-strong">${esc(b.name || '—')}</td>
                <td>${esc(SERVICES[b.service] || b.service || '—')}${b.eventTitle ? '<br><span class="adm-cell-muted">' + esc(b.eventTitle) + '</span>' : ''}</td>
                <td>${esc(b.guests ?? '—')}</td>
                <td>${esc(b.phone || '—')}</td>
                <td>${esc(b.email || '—')}</td>
                <td class="adm-cell-muted">${esc(b.source || 'site')}</td>
                <td><span class="adm-badge ${b.emailed ? 'adm-badge--mail-ok' : 'adm-badge--mail-pending'}">${b.emailed ? 'Inviata' : 'In attesa'}</span></td>
                <td>
                    <select class="adm-select-status" data-bk-id="${id}">
                        ${Object.entries(BOOKING_STATUSES).map(([v, l]) =>
                            `<option value="${v}" ${(b.status || 'new') === v ? 'selected' : ''}>${l}</option>`).join('')}
                    </select>
                </td>
                <td><button class="adm-btn adm-btn-danger adm-btn-sm" data-bk-del="${id}" type="button">Elimina</button></td>
            </tr>`).join('');
    }

    filterSel.addEventListener('change', () => { bookingsFilter = filterSel.value; render(); });

    panel.addEventListener('change', async (e) => {
        if (!e.target.matches('.adm-select-status')) return;
        const id = e.target.dataset.bkId;
        const status = e.target.value;
        try {
            const db = await getDb();
            await updateDoc(doc(db, 'bookings', id), { status, updatedAt: serverTimestamp() });
            toast('Stato aggiornato: ' + BOOKING_STATUSES[status]);
        } catch (err) {
            console.error('[admin] booking status error:', err);
            toast('Aggiornamento non riuscito: ' + (err.code || err.message), true);
        }
    });

    panel.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-bk-del]');
        if (!btn) return;
        const id = btn.dataset.bkDel;
        const entry = bookingsCache.find((c) => c.id === id);
        if (!confirm(`Eliminare la prenotazione di ${entry?.data?.name || id}? L'azione non è reversibile.`)) return;
        try {
            const db = await getDb();
            await deleteDoc(doc(db, 'bookings', id));
            toast('Prenotazione eliminata.');
        } catch (err) {
            console.error('[admin] booking delete error:', err);
            toast('Eliminazione non riuscita: ' + (err.code || err.message), true);
        }
    });

    try {
        const db = await getDb();
        unsubscribe.bookings = onSnapshot(
            query(collection(db, 'bookings'), orderBy('createdAt', 'desc'), limit(200)),
            (snap) => {
                bookingsCache = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
                render();
            },
            (err) => {
                console.error('[admin] bookings snapshot error:', err);
                tbody.innerHTML = '<tr><td colspan="10"><div class="adm-inline-err">Errore nel caricamento delle prenotazioni.</div></td></tr>';
            }
        );
    } catch (err) {
        console.error('[admin] bookings init error:', err);
        tbody.innerHTML = '<tr><td colspan="10"><div class="adm-inline-err">Impossibile connettersi al database.</div></td></tr>';
    }
}

/* ------------------------------------ tab: newsletter ------------------------------------ */

function csvCell(v) {
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function startNewsletterTab() {
    const panel = els.panels.newsletter;
    let cached = [];

    panel.innerHTML = `
        <div class="adm-panel-head">
            <div>
                <h2>Newsletter</h2>
                <p class="adm-panel-lead">Iscrizioni con consenso esplicito dal form nel footer. La cancellazione di una riga è definitiva (diritto all'oblio GDPR).</p>
            </div>
            <button class="adm-btn" data-nl-action="csv" type="button">Esporta CSV</button>
        </div>
        <div class="adm-table-wrap">
            <table class="adm-table">
                <thead>
                    <tr><th>Email</th><th>Telefono</th><th>Fonte</th><th>Consenso il</th><th></th></tr>
                </thead>
                <tbody id="nlTbody">
                    <tr><td colspan="5"><div class="adm-empty">Caricamento iscritti…</div></td></tr>
                </tbody>
            </table>
        </div>`;

    const tbody = panel.querySelector('#nlTbody');

    function render() {
        if (!cached.length) {
            tbody.innerHTML = '<tr><td colspan="5"><div class="adm-empty">Nessun iscritto ancora.</div></td></tr>';
            return;
        }
        tbody.innerHTML = cached.map(({ id, data: n }) => `
            <tr>
                <td class="adm-cell-strong">${esc(n.email || id)}</td>
                <td>${esc(n.phone || '—')}</td>
                <td class="adm-cell-muted">${esc(n.source || 'site')}</td>
                <td>${fmtDateTime(n.consentAt)}</td>
                <td><button class="adm-btn adm-btn-danger adm-btn-sm" data-nl-del="${id}" type="button">Elimina</button></td>
            </tr>`).join('');
    }

    panel.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-nl-action], [data-nl-del]');
        if (!btn) return;

        if (btn.dataset.nlAction === 'csv') {
            if (!cached.length) { toast('Nessun iscritto da esportare.', true); return; }
            const d = new Date();
            const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
            const rows = ['email;telefono;fonte;consenso_il']
                .concat(cached.map(({ id, data: n }) =>
                    [csvCell(n.email || id), csvCell(n.phone || ''), csvCell(n.source || ''), csvCell(fmtDateTime(n.consentAt))].join(';')));
            const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'newsletter-fonderia-' + stamp + '.csv';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            toast('CSV esportato: ' + cached.length + ' iscritti.');
            return;
        }

        const id = btn.dataset.nlDel;
        if (!id) return;
        const entry = cached.find((c) => c.id === id);
        if (!confirm(`Cancellare definitivamente ${entry?.data?.email || id} dalla newsletter? (richiesta GDPR)`)) return;
        try {
            const db = await getDb();
            await deleteDoc(doc(db, 'newsletter', id));
            toast('Iscrizione cancellata.');
        } catch (err) {
            console.error('[admin] newsletter delete error:', err);
            toast('Cancellazione non riuscita: ' + (err.code || err.message), true);
        }
    });

    try {
        const db = await getDb();
        unsubscribe.newsletter = onSnapshot(
            query(collection(db, 'newsletter'), orderBy('consentAt', 'desc')),
            (snap) => {
                cached = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
                render();
            },
            (err) => {
                console.error('[admin] newsletter snapshot error:', err);
                tbody.innerHTML = '<tr><td colspan="5"><div class="adm-inline-err">Errore nel caricamento degli iscritti.</div></td></tr>';
            }
        );
    } catch (err) {
        console.error('[admin] newsletter init error:', err);
        tbody.innerHTML = '<tr><td colspan="5"><div class="adm-inline-err">Impossibile connettersi al database.</div></td></tr>';
    }
}

/* ------------------------------------ bootstrap ------------------------------------ */

els.login.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-login-action]');
    if (!btn) return;
    if (btn.dataset.loginAction === 'reset') showLogin();
    if (btn.dataset.loginAction === 'logout') {
        try {
            const auth = await getAuthInstance();
            await signOut(auth);
        } catch (err) {
            console.error('[admin] logout error:', err);
        }
        showLogin();
    }
});

els.logout.addEventListener('click', async () => {
    try {
        const auth = await getAuthInstance();
        await signOut(auth);
    } catch (err) {
        console.error('[admin] logout error:', err);
    }
});

async function checkAuthorized(user) {
    try {
        const db = await getDb();
        const snap = await getDoc(doc(db, 'config', 'admin'));
        if (snap.exists()) {
            const list = snap.data().allowedEmails;
            const emailLc = (user.email || '').toLowerCase();
            if (Array.isArray(list) && list.map((x) => String(x).toLowerCase()).includes(emailLc)) return true;
        }
    } catch (err) {
        console.error('[admin] whitelist check error (trattato come non autorizzato):', err);
    }
    return false;
}

/* ------------------------------------ tab: statistiche (GA4) ------------------------------------ */

const fmtNum = (n) => Number(n || 0).toLocaleString('it-IT');

function startStatsTab() {
    const panel = els.panels.stats;
    if (!panel) return;

    panel.innerHTML = `
        <div class="adm-panel-head">
            <div>
                <h2>Statistiche sito</h2>
                <p class="adm-panel-lead">Dati Google Analytics degli ultimi 7 e 30 giorni. Google li aggiorna con qualche ora di ritardo.</p>
            </div>
            <button class="adm-btn" data-stats-refresh type="button">Aggiorna</button>
        </div>
        <div id="statsBody"><div class="adm-empty">Caricamento statistiche…</div></div>`;

    const body = panel.querySelector('#statsBody');

    function kpi(label, v7, v30) {
        return `
        <div class="adm-kpi">
            <div class="adm-kpi-label">${label}</div>
            <div class="adm-kpi-value">${fmtNum(v7)}</div>
            <div class="adm-kpi-sub">ultimi 7 giorni · ${fmtNum(v30)} in 30 gg</div>
        </div>`;
    }

    function bars(title, rows, formatLabel) {
        if (!rows || !rows.length) {
            return `<div class="adm-stats-block"><h3>${title}</h3><div class="adm-empty">Nessun dato nel periodo.</div></div>`;
        }
        const max = Math.max(...rows.map((r) => r.value), 1);
        const items = rows.map((r) => `
            <div class="adm-bar-row">
                <span class="adm-bar-label" title="${esc(r.label)}">${esc(formatLabel ? formatLabel(r.label) : r.label)}</span>
                <span class="adm-bar-track"><span class="adm-bar-fill" style="width:${Math.max(2, Math.round((r.value / max) * 100))}%"></span></span>
                <span class="adm-bar-value">${fmtNum(r.value)}</span>
            </div>`).join('');
        return `<div class="adm-stats-block"><h3>${title}</h3>${items}</div>`;
    }

    function trend(daily) {
        if (!daily || !daily.length) return '';
        const max = Math.max(...daily.map((d) => d.sessions), 1);
        const cells = daily.map((d) => {
            const label = d.date ? `${d.date.slice(6, 8)}/${d.date.slice(4, 6)}` : '';
            return `<div class="adm-trend-col" title="${label}: ${fmtNum(d.sessions)} sessioni">
                <span class="adm-trend-bar" style="height:${Math.max(3, Math.round((d.sessions / max) * 100))}%"></span>
            </div>`;
        }).join('');
        return `<div class="adm-stats-block"><h3>Sessioni giornaliere (30 gg)</h3><div class="adm-trend">${cells}</div></div>`;
    }

    function render(s) {
        body.innerHTML = `
            <div class="adm-kpi-grid">
                ${kpi('Visite (sessioni)', s.last7.sessions, s.last30.sessions)}
                ${kpi('Visitatori', s.last7.users, s.last30.users)}
                ${kpi('Pagine viste', s.last7.pageviews, s.last30.pageviews)}
            </div>
            ${trend(s.daily)}
            ${bars('Pagine pi&ugrave; viste (30 gg)', s.topPages)}
            ${bars('Da dove arrivano (30 gg)', s.topSources)}`;
    }

    async function load() {
        body.innerHTML = '<div class="adm-empty">Caricamento statistiche…</div>';
        try {
            const fns = await getFunctionsInstance();
            const { data } = await httpsCallable(fns, 'getGaStats')();
            render(data);
        } catch (err) {
            // callable errors: il messaggio utile e' in details per gli HttpsError,
            // err.message resta il generico "INTERNAL"/"FAILED_PRECONDITION"
            const msg = (err && (err.details || err.message)) || String(err);
            body.innerHTML = `<div class="adm-empty">Statistiche non disponibili.<br><span class="adm-stats-err">${esc(msg)}</span></div>`;
        }
    }

    panel.addEventListener('click', (e) => {
        if (e.target.closest('[data-stats-refresh]')) load();
    });

    load();
}

async function startAuthFlow() {
    showBoot();
    const auth = await getAuthInstance();
    admMark('Firebase Auth pronta');
    if (isSignInWithEmailLink(auth, window.location.href)) {
        admMark('link di accesso rilevato');
        await completeEmailLinkSignIn();
    }
    onAuthStateChanged(auth, async (user) => {
        // try/catch: un errore qui dentro era una promise rejection non
        // gestita → la pagina restava sul boot all'infinito, senza errori visibili
        try {
            if (!user) {
                admMark('nessun utente loggato → login');
                stopAll();
                showLogin();
                return;
            }
            admMark('utente: ' + (user.email || user.uid));
            const ok = await checkAuthorized(user);
            if (!ok) {
                admMark('email non in whitelist → schermata "non autorizzato"');
                stopAll();
                showUnauthorized(user.email);
                return;
            }
            admMark('whitelist OK → apro la shell');
            initShell(user);
        } catch (err) {
            console.error('[admin] errore nel flusso auth:', err);
            if (window.__admBootFail) {
                window.__admBootFail('Errore: ' + (err && (err.code || err.message)) || err);
            }
        }
    });
}

startAuthFlow().catch((err) => {
    console.error('[admin] bootstrap error:', err);
    if (window.__admBootFail) {
        window.__admBootFail('Errore di inizializzazione: ' + (err && (err.code || err.message)) || err);
    } else {
        els.boot.innerHTML = '<p class="adm-inline-err">Errore di inizializzazione: ' + esc(err.message || err) + '</p>';
    }
});
