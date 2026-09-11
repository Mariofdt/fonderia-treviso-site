/**
 * admin.js — Area Gestionale Fonderia Treviso
 * Magic link auth + whitelist config/admin → tab Eventi / Popup / Prenotazioni /
 * Newsletter / Promozioni / Badge / Statistiche.
 * Dipende da firebase-init.js (getDb/getAuthInstance/getStorageInstance) e
 * firebase-config.js (window.FB_CONFIG), caricati da admin.html.
 */

import { getAuthInstance, getDb, getStorageInstance, getFunctionsInstance } from './firebase-init.js';
import { onAuthStateChanged, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signInWithEmailAndPassword, signOut }
    from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
         query, where, orderBy, limit, serverTimestamp, increment }
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
        promos: $('tab-promos'),
        badges: $('tab-badges'),
        stats: $('tab-stats'),
    },
};

let unsubscribe = { events: null, popups: null, bookings: null, newsletter: null, promos: null, badges: null, claims: null };
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
                <img class="adm-login-logo" src="images/logo.svg" alt="Fonderia Treviso">
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
                <img class="adm-login-logo" src="images/logo.svg" alt="Fonderia Treviso">
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
            <img class="adm-login-logo" src="images/logo.svg" alt="Fonderia Treviso">
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
    startPromosTab();
    startBadgesTab();
    startStatsTab();
}

function stopAll() {
    Object.values(unsubscribe).forEach((fn) => { if (fn) fn(); });
    unsubscribe = { events: null, popups: null, bookings: null, newsletter: null, promos: null, badges: null, claims: null };
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
                <label for="evTitle">Titolo <span class="adm-tip" tabindex="0" data-tip="Obbligatorio. È il nome dell'evento, in grande sulla card del sito e nelle email di benvenuto.">?</span></label>
                <input id="evTitle" type="text" required value="${esc(ev?.title || '')}" placeholder="Apertura Stagione">
            </div>
            <div class="adm-group">
                <label for="evTagline">Tagline <span class="adm-tip" tabindex="0" data-tip="Opzionale. Frase breve sotto il titolo. Se la lasci vuota, sul sito compare il testo della descrizione.">?</span></label>
                <input id="evTagline" type="text" value="${esc(ev?.tagline || '')}" placeholder="Una serata speciale…">
            </div>
        </div>
        <div class="adm-row--3 adm-row">
            <div class="adm-group">
                <label for="evDate">Data <span class="adm-tip" tabindex="0" data-tip="Obbligatoria. Ordina gli eventi sul sito dal più vicino al più lontano; gli eventi passati spariscono da soli.">?</span></label>
                <input id="evDate" type="date" required value="${isEdit ? toDateInputValue(ev.date) : ''}">
            </div>
            <div class="adm-group">
                <label for="evTime">Ora <span class="adm-tip" tabindex="0" data-tip="Opzionale. Mostrata accanto alla data: «sabato 4 ottobre, ore 19:00». Formato libero (es. 21:00 o «dalle 21»).">?</span></label>
                <input id="evTime" type="text" value="${esc(ev?.time || '')}" placeholder="19:00">
            </div>
            <div class="adm-group">
                <label for="evOrder">Ordine <span class="adm-tip" tabindex="0" data-tip="Serve solo se due eventi hanno la stessa data: il numero più basso compare prima. Altrimenti lascia 0.">?</span></label>
                <input id="evOrder" type="number" step="1" value="${esc(ev?.order ?? 0)}">
            </div>
        </div>
        <div class="adm-group">
            <div class="adm-label-row">
                <label for="evDescription">Descrizione <span class="adm-tip" tabindex="0" data-tip="Opzionale. Testo esteso sotto la tagline sulla card del sito. Il bottone ✨ propone un testo: rivedilo sempre prima di salvare.">?</span></label>
                <button type="button" id="evAiBtn" class="adm-btn adm-btn-ghost adm-btn-sm adm-btn-ai"
                    data-tip="Gemini (Google) propone tagline e descrizione partendo da titolo, data e ora. Solo i gestori autorizzati possono usarlo."
                    title="Proponi tagline e descrizione con l'IA">✨ Proponi con IA</button>
            </div>
            <textarea id="evDescription" rows="3">${esc(ev?.description || '')}</textarea>
        </div>
        <div class="adm-row">
            <div class="adm-group">
                <label for="evImageSelect">Immagine (galleria) <span class="adm-tip" tabindex="0" data-tip="Scegli una foto tra quelle già presenti sul sito. Se selezioni qui, il campo URL a fianco si disattiva.">?</span></label>
                <select id="evImageSelect">
                    <option value="">— scegli dalla galleria —</option>
                    ${options}
                </select>
            </div>
            <div class="adm-group">
                <label for="evImageUrl">oppure URL immagine libero <span class="adm-tip" tabindex="0" data-tip="Incolla il link diretto a un'immagine (https://…). Se compilato, vince sulla scelta dalla galleria.">?</span></label>
                <input id="evImageUrl" type="url" value="${esc(customUrl)}" placeholder="https://…" ${customUrl ? '' : 'disabled'}>
            </div>
        </div>
        <label class="adm-check">
            <input id="evActive" type="checkbox" ${!isEdit || ev.active !== false ? 'checked' : ''}>
            Attivo (visibile sul sito) <span class="adm-tip" tabindex="0" data-tip="Spuntato = l'evento compare sul sito. Senza spunta resta salvato qui ma nascosto ai visitatori.">?</span>
        </label>
        <div class="adm-live-preview">
            <span class="adm-preview-label">Anteprima sul sito (si aggiorna mentre scrivi)</span>
            <div class="event-card adm-preview-card">
                <img id="evPrevImg" src="images/gallery5.jpg" alt="Anteprima immagine evento">
                <div class="event-card-body">
                    <div class="date" id="evPrevDate">— data —</div>
                    <h3 id="evPrevTitle">Titolo evento</h3>
                    <p id="evPrevText"></p>
                </div>
            </div>
        </div>
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

    // Replica fedele di renderEventCard/formatEventDate di events.js:
    // stessa immagine di fallback (gallery5), stesso formato data, tagline||description.
    function updateEventPreview() {
        const prev = panel.querySelector('.adm-live-preview');
        if (!prev) return; // form non aperto
        const imgUrl = $('evImageUrl').value.trim() || $('evImageSelect').value || 'images/gallery5.jpg';
        const img = $('evPrevImg');
        if (img.getAttribute('src') !== imgUrl) img.src = imgUrl;
        const dateStr = $('evDate').value;
        const time = $('evTime').value.trim();
        let dateTxt = '— data —';
        if (dateStr) {
            const d = new Date(dateStr + 'T12:00:00');
            if (!isNaN(d)) dateTxt = d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }) + (time ? ', ore ' + time : '');
        }
        $('evPrevDate').textContent = dateTxt;
        $('evPrevTitle').textContent = $('evTitle').value.trim() || 'Titolo evento';
        $('evPrevText').textContent = $('evTagline').value.trim() || $('evDescription').value.trim() || '';
    }

    function openForm(ev, id) {
        editingId = id;
        formSlot.innerHTML = eventFormHTML(ev);
        updateEventPreview();
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    panel.addEventListener('input', (e) => {
        if (e.target.closest('#evForm')) updateEventPreview();
    });

    async function runAiSuggest(aiBtn) {
        const title = $('evTitle').value.trim();
        if (!title) { toast('Scrivi almeno il titolo: l’IA ne ha bisogno per proporre il testo.', true); $('evTitle').focus(); return; }
        aiBtn.disabled = true;
        const label = aiBtn.textContent;
        aiBtn.textContent = '⏳ Genero…';
        try {
            const fn = httpsCallable(await getFunctionsInstance(), 'suggestEventCopy');
            const res = await fn({ title, date: $('evDate').value, time: $('evTime').value.trim() });
            const { tagline, description } = res.data || {};
            if (description) $('evDescription').value = description;
            if (tagline && !$('evTagline').value.trim()) $('evTagline').value = tagline;
            updateEventPreview();
            toast('Proposta inserita — rivedila e adattala prima di salvare.');
        } catch (err) {
            console.error('[admin] suggestEventCopy error:', err);
            toast('Proposta non riuscita: ' + (err.code || err.message), true);
        } finally {
            aiBtn.disabled = false;
            aiBtn.textContent = label;
        }
    }

    panel.addEventListener('click', async (e) => {
        const aiBtn = e.target.closest('#evAiBtn');
        if (aiBtn) { runAiSuggest(aiBtn); return; }
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
        if (e.target.closest('#evForm')) updateEventPreview();
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

/* ------------------------------------ tab: promozioni + claim ------------------------------------ */

const ACTION_TYPES = {
    condividi_evento: 'Condividi evento',
    condividi_post: 'Condividi post',
    tag_story: 'Tag in stories',
    referral: 'Invita amici (referral)',
    custom: 'Azione personalizzata',
};

const CLAIM_STATUSES = {
    pending_review: { label: 'In verifica', cls: 'adm-badge--claim-pending' },
    issued: { label: 'Emesso', cls: 'adm-badge--claim-issued' },
    redeemed: { label: 'Riscattato', cls: 'adm-badge--claim-redeemed' },
    rejected: { label: 'Rifiutato', cls: 'adm-badge--claim-rejected' },
};

// Cache di comodo per i join (volumi bassi: getDoc puntuale al primo uso).
const memberCache = new Map(); // memberId → { name, phone, suspicious } | { missing|error: true }
const promoTitleCache = new Map(); // promoId → title
let eventsCachePromise = null; // la select eventRef del form promo è riempita una volta
// config/gamification: staffPin NON viene mai tenuto né reso in chiaro — solo il flag "impostato"
const gamConfig = { loaded: false, staffPinSet: false, prizeOptions: [] };

function getCachedEvents(db) {
    if (!eventsCachePromise) {
        eventsCachePromise = getDocs(query(collection(db, 'events'), orderBy('date', 'desc')))
            .then((snap) => snap.docs.map((d) => ({ id: d.id, data: d.data() })))
            .catch((err) => {
                console.error('[admin] events cache for promo form:', err);
                eventsCachePromise = null; // retry al prossimo form
                return [];
            });
    }
    return eventsCachePromise;
}

async function resolveMember(db, id) {
    if (memberCache.has(id)) return memberCache.get(id);
    let entry;
    try {
        const snap = await getDoc(doc(db, 'members', id));
        if (snap.exists()) {
            const m = snap.data();
            entry = { name: m.name || '', phone: m.phone || '', suspicious: m.suspiciousReferral === true };
        } else {
            entry = { missing: true };
        }
    } catch (err) {
        // Regole non ancora deployate con lettura admin members: degrada a id, mai crash
        console.error('[admin] member lookup error:', err);
        entry = { error: true };
    }
    memberCache.set(id, entry);
    return entry;
}

async function resolvePromoTitle(db, id) {
    if (promoTitleCache.has(id)) return promoTitleCache.get(id);
    let title = '';
    try {
        const snap = await getDoc(doc(db, 'promos', id));
        if (snap.exists()) title = snap.data().title || '';
    } catch (err) {
        console.error('[admin] promo lookup error:', err);
    }
    promoTitleCache.set(id, title);
    return title;
}

async function loadGamConfig() {
    try {
        const db = await getDb();
        const snap = await getDoc(doc(db, 'config', 'gamification'));
        if (snap.exists()) {
            const cfg = snap.data();
            gamConfig.staffPinSet = Boolean(String(cfg.staffPin || ''));
            gamConfig.prizeOptions = Array.isArray(cfg.prizeOptions)
                ? cfg.prizeOptions.map((x) => String(x)).filter(Boolean) : [];
        } else {
            gamConfig.staffPinSet = false;
            gamConfig.prizeOptions = [];
        }
    } catch (err) {
        console.error('[admin] config/gamification read error:', err);
    }
    gamConfig.loaded = true;
}

function prizeDatalistHTML() {
    return '<datalist id="prizeOptionsList">' +
        gamConfig.prizeOptions.map((p) => `<option value="${esc(p)}"></option>`).join('') +
        '</datalist>';
}

function promoFormHTML(promo) {
    const isEdit = Boolean(promo);
    const actionType = promo?.actionType || 'condividi_evento';
    const typeOptions = Object.entries(ACTION_TYPES).map(([v, l]) =>
        `<option value="${v}" ${actionType === v ? 'selected' : ''}>${l}</option>`).join('');
    const eventOptions = (eventsCacheList || []).map(({ id, data: ev }) =>
        `<option value="${id}" ${promo?.eventRef === id ? 'selected' : ''}>${esc(ev.title || id)} (${fmtDate(ev.date)})</option>`).join('');
    return `
    <form id="promoForm" class="adm-form" novalidate>
        <div class="adm-form-title">${isEdit ? 'Modifica promozione' : 'Nuova promozione'}</div>
        <div class="adm-row">
            <div class="adm-group">
                <label for="promoTitle">Titolo</label>
                <input id="promoTitle" type="text" required value="${esc(promo?.title || '')}" placeholder="Condividi l'evento di apertura">
            </div>
            <div class="adm-group">
                <label for="promoPrize">Premio <span class="adm-tip" tabindex="0" data-tip="Scegli tra i premi configurati in Impostazioni (in fondo al tab) o scrivi un testo libero.">?</span></label>
                <input id="promoPrize" type="text" list="prizeOptionsList" required value="${esc(promo?.prizeLabel || '')}" placeholder="Drink omaggio">
                ${prizeDatalistHTML()}
            </div>
        </div>
        <div class="adm-row">
            <div class="adm-group">
                <label for="promoAction">Azione richiesta</label>
                <select id="promoAction">${typeOptions}</select>
            </div>
            <div class="adm-group" id="promoRefTargetRow" ${actionType === 'referral' ? '' : 'hidden'}>
                <label for="promoRefTarget">Soglia referral <span class="adm-tip" tabindex="0" data-tip="Quanti amici deve aver invitato il cliente perché il premio parta in automatico.">?</span></label>
                <input id="promoRefTarget" type="number" min="1" step="1" value="${esc(promo?.refTarget ?? 3)}">
            </div>
            <div class="adm-group">
                <label for="promoEventRef">Evento collegato <span class="adm-tip" tabindex="0" data-tip="Rilevante per «Condividi evento»: indica quale evento compare nella checklist/pagina promo.">?</span></label>
                <select id="promoEventRef">
                    <option value="">— nessuno —</option>
                    ${eventOptions}
                </select>
            </div>
        </div>
        <div class="adm-group">
            <label for="promoChecklist">Checklist IA <span class="adm-tip" tabindex="0" data-tip="Le righe che Gemini deve vedere nello screenshot per approvare in automatico. Se vuota, OGNI richiesta finisce in verifica manuale qui sotto.">?</span></label>
            <textarea id="promoChecklist" rows="3" placeholder="Es. si vede l'evento condiviso nelle stories con tag @fonderiatreviso">${esc(promo?.aiChecklist || '')}</textarea>
        </div>
        <div class="adm-row">
            <div class="adm-group">
                <label for="promoStart">Visibile dal <span class="adm-optional">(opzionale)</span></label>
                <input id="promoStart" type="datetime-local" value="${isEdit ? toDatetimeLocalValue(promo.startsAt) : ''}">
            </div>
            <div class="adm-group">
                <label for="promoEnd">Fino al <span class="adm-optional">(opzionale)</span></label>
                <input id="promoEnd" type="datetime-local" value="${isEdit ? toDatetimeLocalValue(promo.endsAt) : ''}">
            </div>
        </div>
        <label class="adm-check">
            <input id="promoActive" type="checkbox" ${!isEdit || promo.active !== false ? 'checked' : ''}>
            Attiva (visibile ai clienti)
        </label>
        <div id="promoFormErr" class="adm-inline-err" hidden></div>
        <div class="adm-form-actions">
            <button class="adm-btn" type="submit">${isEdit ? 'Salva modifiche' : 'Crea promozione'}</button>
            <button class="adm-btn adm-btn-ghost" type="button" data-promo-action="cancel">Annulla</button>
        </div>
    </form>`;
}

let eventsCacheList = [];

async function startPromosTab() {
    const panel = els.panels.promos;
    let editingId = null;
    let promosCache = [];
    let claimsCache = [];
    let claimsFilter = 'all';
    let suspiciousCache = [];
    let suspiciousLoaded = false;

    panel.innerHTML = `
        <div class="adm-panel-head">
            <div>
                <h2>Promozioni</h2>
                <p class="adm-panel-lead">Le promo attive compaiono sulla pagina condivisione; ogni promo ha un link da girare ai clienti. In basso: richieste premio da approvare, referral sospetti e impostazioni.</p>
            </div>
            <button class="adm-btn" data-promo-action="new" type="button">+ Nuova promozione</button>
        </div>
        <div id="promoFormSlot"></div>
        <div id="promoList" class="adm-list"><div class="adm-empty">Caricamento promozioni…</div></div>

        <h3 class="adm-subhead">Richieste premio</h3>
        <div class="adm-toolbar">
            <label for="claimFilter">Stato</label>
            <select id="claimFilter">
                <option value="all">Tutti</option>
                <option value="pending_review">In verifica</option>
                <option value="issued">Emessi</option>
                <option value="redeemed">Riscattati</option>
                <option value="rejected">Rifiutati</option>
                <option value="sospetti">Referral sospetti</option>
            </select>
            <span class="adm-count" id="claimCount"></span>
        </div>
        <div class="adm-table-wrap adm-claims-wrap">
            <table class="adm-table">
                <thead>
                    <tr>
                        <th>Quando</th><th>Membro</th><th>Promo</th><th>Stato</th>
                        <th>Nota IA</th><th>Prova</th><th></th>
                    </tr>
                </thead>
                <tbody id="claimsTbody">
                    <tr><td colspan="7"><div class="adm-empty">Caricamento richieste…</div></td></tr>
                </tbody>
            </table>
        </div>

        <h3 class="adm-subhead">Referral sospetti</h3>
        <p class="adm-panel-lead">Membri il cui invito è stato marcato sospetto (auto-invito o codice inesistente). "Approva" conta il referral e smarca.</p>
        <div id="suspList" class="adm-list"><div class="adm-empty">Caricamento…</div></div>
        <div class="adm-toolbar">
            <button class="adm-btn adm-btn-ghost adm-btn-sm" data-susp-refresh type="button">Aggiorna</button>
        </div>

        <h3 class="adm-subhead">Impostazioni</h3>
        <form id="gamSettingsForm" class="adm-form" novalidate>
            <div class="adm-group">
                <label for="gamStaffPin">Nuovo PIN staff <span class="adm-tip" tabindex="0" data-tip="Il PIN serve al banco per bruciare i premi sulla pagina di riscatto. Viene salvato ma MAI mostrato: qui vedi solo se è impostato.">?</span></label>
                <input id="gamStaffPin" type="password" inputmode="numeric" autocomplete="new-password" placeholder="Lascia vuoto per non cambiarlo">
                <div class="adm-check-note" id="gamPinState"></div>
            </div>
            <div class="adm-group">
                <label for="gamPrizeOptions">Premi disponibili <span class="adm-optional">(uno per riga)</span></label>
                <textarea id="gamPrizeOptions" rows="4"></textarea>
            </div>
            <div id="gamSettingsErr" class="adm-inline-err" hidden></div>
            <div class="adm-form-actions">
                <button class="adm-btn" type="submit">Salva impostazioni</button>
            </div>
        </form>`;

    const formSlot = panel.querySelector('#promoFormSlot');
    const listEl = panel.querySelector('#promoList');
    const claimsTbody = panel.querySelector('#claimsTbody');
    const claimFilter = panel.querySelector('#claimFilter');
    const claimCount = panel.querySelector('#claimCount');
    const suspList = panel.querySelector('#suspList');
    const pinState = panel.querySelector('#gamPinState');

    function syncSettingsUI() {
        pinState.textContent = gamConfig.staffPinSet
            ? 'PIN impostato (••••). Scrivi un nuovo PIN sopra solo per cambiarlo.'
            : 'Nessun PIN impostato: il banco non può bruciare premi finché non ne salvi uno.';
        panel.querySelector('#gamPrizeOptions').value = gamConfig.prizeOptions.join('\n');
    }

    function renderPromos() {
        if (!promosCache.length) {
            listEl.innerHTML = '<div class="adm-empty">Nessuna promozione ancora. Crea la prima con "+ Nuova promozione".</div>';
            return;
        }
        listEl.innerHTML = promosCache.map(({ id, data: p }) => `
            <div class="adm-card${p.active === false ? ' inactive' : ''}">
                <div class="adm-card-main">
                    <div class="adm-card-title">${esc(p.title || '(senza titolo)')}</div>
                    <div class="adm-card-sub">${esc(ACTION_TYPES[p.actionType] || p.actionType || '—')} · Premio: ${esc(p.prizeLabel || '—')}${p.actionType === 'referral' && p.refTarget ? ' · soglia ' + esc(p.refTarget) : ''}${p.startsAt || p.endsAt ? '<br>' + fmtDateTime(p.startsAt) + ' → ' + fmtDateTime(p.endsAt) : ''}</div>
                </div>
                <div class="adm-card-actions">
                    <span class="adm-badge ${p.active !== false ? 'adm-badge--on' : 'adm-badge--off'}">${p.active !== false ? 'Attiva' : 'Nascosta'}</span>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-promo-action="copy" data-id="${id}" type="button">Copia link</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-promo-action="toggle" data-id="${id}" type="button">${p.active !== false ? 'Disattiva' : 'Attiva'}</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-promo-action="edit" data-id="${id}" type="button">Modifica</button>
                    <button class="adm-btn adm-btn-danger adm-btn-sm" data-promo-action="delete" data-id="${id}" type="button">Elimina</button>
                </div>
            </div>`).join('');
    }

    async function openForm(promo, id) {
        editingId = id;
        // Riempi la cache eventi per la select eventRef (una sola lettura)
        try { eventsCacheList = await getCachedEvents(await getDb()); } catch { eventsCacheList = []; }
        formSlot.innerHTML = promoFormHTML(promo);
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function claimChip(status) {
        const s = CLAIM_STATUSES[status] || { label: status || '—', cls: 'adm-badge--off' };
        return `<span class="adm-badge ${s.cls}">${esc(s.label)}</span>`;
    }

    async function renderClaims() {
        const db = await getDb();
        // join nome membro / titolo promo (getDoc puntuale con cache; volumi bassi)
        await Promise.all(claimsCache.map(({ data: c }) => Promise.all([
            c.memberId ? resolveMember(db, c.memberId) : null,
            c.promoId ? resolvePromoTitle(db, c.promoId) : null,
        ])));

        let rows = claimsCache.map((entry) => {
            const c = entry.data;
            const m = c.memberId ? memberCache.get(c.memberId) : null;
            return { ...entry, member: m, promoTitle: promoTitleCache.get(c.promoId) || '(promo eliminata)' };
        });
        // In verifica sempre in cima, poi per data discendente
        rows.sort((a, b) => {
            const pa = a.data.status === 'pending_review' ? 0 : 1;
            const pb = b.data.status === 'pending_review' ? 0 : 1;
            if (pa !== pb) return pa - pb;
            const ta = a.data.createdAt && a.data.createdAt.toMillis ? a.data.createdAt.toMillis() : 0;
            const tb = b.data.createdAt && b.data.createdAt.toMillis ? b.data.createdAt.toMillis() : 0;
            return tb - ta;
        });
        if (claimsFilter === 'sospetti') rows = rows.filter((r) => r.member && r.member.suspicious);
        else if (claimsFilter !== 'all') rows = rows.filter((r) => r.data.status === claimsFilter);

        claimCount.textContent = rows.length + ' richiest' + (rows.length === 1 ? 'a' : 'e');
        if (!rows.length) {
            claimsTbody.innerHTML = '<tr><td colspan="7"><div class="adm-empty">Nessuna richiesta con questo filtro.</div></td></tr>';
            return;
        }
        claimsTbody.innerHTML = rows.map(({ id, data: c, member, promoTitle }, i) => {
            const memberLabel = !member ? '—'
                : member.missing ? '(membro eliminato)'
                : member.error ? esc(String(c.memberId || '').slice(0, 8)) + '…'
                : esc(member.name || '(senza nome)') +
                  (member.suspicious ? ' <span class="adm-badge adm-badge--claim-suspicious">ref. sospetto</span>' : '') +
                  (member.phone ? '<br><span class="adm-cell-muted">' + esc(member.phone) + '</span>' : '');
            const actions = c.status === 'pending_review'
                ? `<button class="adm-btn adm-btn-sm" data-claim-review="${id}" data-approve="1" type="button">Approva</button>
                   <button class="adm-btn adm-btn-danger adm-btn-sm" data-claim-review="${id}" data-approve="0" type="button">Rifiuta</button>`
                : '';
            const proof = c.screenshotPath
                ? `<button class="adm-btn adm-btn-ghost adm-btn-sm" data-claim-shot="${id}" type="button">Vedi prova</button>`
                : '<span class="adm-cell-muted">—</span>';
            return `<tr>
                <td class="adm-cell-muted">${fmtDateTime(c.createdAt)}</td>
                <td class="adm-cell-strong">${memberLabel}</td>
                <td>${esc(promoTitle)}<br><span class="adm-cell-muted">${esc(c.promoId || '')}</span></td>
                <td>${claimChip(c.status)}${c.redeemedAt ? '<br><span class="adm-cell-muted">il ' + fmtDateTime(c.redeemedAt) + '</span>' : ''}</td>
                <td class="adm-cell-note"><span class="js-ai-note" data-note-i="${i}"></span></td>
                <td>${proof}</td>
                <td class="adm-cell-actions">${actions}</td>
            </tr>`;
        }).join('');
        // ruling: nota/reason Gemini SOLO via textContent (mai innerHTML)
        claimsTbody.querySelectorAll('.js-ai-note').forEach((span) => {
            const idx = Number(span.dataset.noteI);
            const note = rows[idx] && rows[idx].data.aiNote;
            span.textContent = note ? String(note) : '—';
        });
    }

    function renderSuspicious() {
        if (!suspiciousLoaded) {
            suspList.innerHTML = '<div class="adm-empty">Caricamento…</div>';
            return;
        }
        if (!suspiciousCache.length) {
            suspList.innerHTML = '<div class="adm-empty">Nessun referral sospetto al momento.</div>';
            return;
        }
        suspList.innerHTML = suspiciousCache.map(({ id, data: m }) => `
            <div class="adm-card">
                <div class="adm-card-main">
                    <div class="adm-card-title">${esc(m.name || '(senza nome)')}</div>
                    <div class="adm-card-sub">${esc(m.phone || '—')} · referral attuali: ${esc(m.referralCount ?? 0)}</div>
                </div>
                <div class="adm-card-actions">
                    <button class="adm-btn adm-btn-sm" data-susp-approve="${id}" type="button">Approva referral</button>
                </div>
            </div>`).join('');
    }

    async function loadSuspicious() {
        suspiciousLoaded = false;
        renderSuspicious();
        try {
            const db = await getDb();
            const snap = await getDocs(query(collection(db, 'members'), where('suspiciousReferral', '==', true)));
            suspiciousCache = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
            suspiciousLoaded = true;
        } catch (err) {
            console.error('[admin] suspicious referrals error:', err);
            suspList.innerHTML = '<div class="adm-inline-err">Errore nel caricamento dei referral sospetti.</div>';
            return;
        }
        renderSuspicious();
    }

    claimFilter.addEventListener('change', () => {
        claimsFilter = claimFilter.value;
        renderClaims().catch((err) => console.error('[admin] claims render error:', err));
    });

    panel.addEventListener('change', (e) => {
        if (e.target.id === 'promoAction') {
            const row = panel.querySelector('#promoRefTargetRow');
            if (row) row.hidden = e.target.value !== 'referral';
        }
    });

    panel.addEventListener('click', async (e) => {
        // Prova screenshot: le storage rules negano la lettura client di
        // claims-inbox (read:false, Task 2) → l'immagine arriva SOLO via
        // callable admin getClaimScreenshot. File orfano (Task 5 può non aver
        // caricato) → messaggio tollerante, mai crash della tabella.
        const shotBtn = e.target.closest('[data-claim-shot]');
        if (shotBtn) {
            shotBtn.disabled = true;
            try {
                const fn = httpsCallable(await getFunctionsInstance(), 'getClaimScreenshot');
                const res = await fn({ claimId: shotBtn.dataset.claimShot });
                const dataUrl = res.data && res.data.dataUrl;
                if (!dataUrl || !String(dataUrl).startsWith('data:image/')) {
                    throw new Error('risposta senza immagine');
                }
                const overlay = document.createElement('div');
                overlay.className = 'adm-shot-overlay';
                const img = document.createElement('img');
                img.src = dataUrl;
                img.alt = 'Prova caricata dal cliente';
                const hint = document.createElement('p');
                hint.className = 'adm-shot-hint';
                hint.textContent = 'Tocca fuori dall’immagine per chiudere';
                overlay.append(img, hint);
                // L'overlay vive su <body> (fuori dal panel): chiusura gestita qui
                overlay.addEventListener('click', () => overlay.remove());
                document.body.appendChild(overlay);
            } catch (err) {
                console.warn('[admin] screenshot non disponibile:', err && (err.code || err.message));
                toast('Immagine non disponibile (file rimosso o mai caricato).', true);
            } finally {
                shotBtn.disabled = false;
            }
            return;
        }

        const reviewBtn = e.target.closest('[data-claim-review]');
        if (reviewBtn) {
            const claimId = reviewBtn.dataset.claimReview;
            const approve = reviewBtn.dataset.approve === '1';
            const entry = claimsCache.find((c) => c.id === claimId);
            const label = approve ? 'Approvare' : 'Rifiutare';
            if (!confirm(`${label} la richiesta premio "${entry?.data?.promoId || claimId}"?`)) return;
            reviewBtn.disabled = true;
            try {
                const fn = httpsCallable(await getFunctionsInstance(), 'reviewClaim');
                await fn({ claimId, approve });
                toast(approve ? 'Richiesta approvata: premio emesso.' : 'Richiesta rifiutata.');
            } catch (err) {
                console.error('[admin] reviewClaim error:', err);
                toast('Operazione non riuscita: ' + ((err && (err.details || err.message)) || err), true);
                reviewBtn.disabled = false;
            }
            return;
        }

        const suspBtn = e.target.closest('[data-susp-approve]');
        if (suspBtn) {
            const memberId = suspBtn.dataset.suspApprove;
            const entry = suspiciousCache.find((s) => s.id === memberId);
            if (!confirm(`Approvare il referral di ${entry?.data?.name || memberId}? Il conteggio aumenta di 1 e il membro viene smarcato.`)) return;
            suspBtn.disabled = true;
            try {
                const fn = httpsCallable(await getFunctionsInstance(), 'approveReferral');
                await fn({ memberId });
                memberCache.delete(memberId);
                toast('Referral approvato e conteggiato.');
                loadSuspicious();
            } catch (err) {
                console.error('[admin] approveReferral error:', err);
                toast('Operazione non riuscita: ' + ((err && (err.details || err.message)) || err), true);
                suspBtn.disabled = false;
            }
            return;
        }

        if (e.target.closest('[data-susp-refresh]')) { loadSuspicious(); return; }

        const btn = e.target.closest('[data-promo-action]');
        if (!btn) return;
        const action = btn.dataset.promoAction;
        const id = btn.dataset.id;
        const entry = promosCache.find((c) => c.id === id);

        try {
            const db = await getDb();
            if (action === 'new') await openForm(null, null);
            else if (action === 'cancel') { formSlot.innerHTML = ''; editingId = null; }
            else if (action === 'edit') { if (entry) await openForm(entry.data, id); }
            else if (action === 'copy') {
                const link = location.origin + '/promo.html?p=' + id;
                try {
                    await navigator.clipboard.writeText(link);
                    toast('Link copiato: ' + link);
                } catch (clipErr) {
                    console.warn('[admin] clipboard error:', clipErr);
                    toast('Copia automatica non riuscita. Link: ' + link, true);
                }
            } else if (action === 'toggle') {
                await updateDoc(doc(db, 'promos', id), { active: entry.data.active === false, updatedAt: serverTimestamp() });
            } else if (action === 'delete') {
                if (confirm(`Eliminare la promozione "${entry?.data?.title || id}"? I claim già emessi restano riscattabili. L'azione non è reversibile.`)) {
                    await deleteDoc(doc(db, 'promos', id));
                    promoTitleCache.delete(id);
                    toast('Promozione eliminata.');
                }
            }
        } catch (err) {
            console.error('[admin] promos action error:', err);
            toast('Operazione non riuscita: ' + (err.code || err.message), true);
        }
    });

    panel.addEventListener('submit', async (e) => {
        if (e.target.id === 'gamSettingsForm') {
            e.preventDefault();
            const errBox = panel.querySelector('#gamSettingsErr');
            errBox.hidden = true;
            const pin = panel.querySelector('#gamStaffPin').value.trim();
            const prizeOptions = panel.querySelector('#gamPrizeOptions').value
                .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20);
            const update = { prizeOptions };
            if (pin) {
                if (!/^[0-9]{4,8}$/.test(pin)) {
                    errBox.textContent = 'Il PIN deve essere numerico (4-8 cifre).';
                    errBox.hidden = false;
                    return;
                }
                update.staffPin = pin;
            }
            try {
                const db = await getDb();
                await setDoc(doc(db, 'config', 'gamification'), update, { merge: true });
                gamConfig.prizeOptions = prizeOptions;
                if (pin) gamConfig.staffPinSet = true;
                panel.querySelector('#gamStaffPin').value = ''; // mai lasciare il PIN nel DOM
                syncSettingsUI();
                toast('Impostazioni salvate.');
            } catch (err) {
                console.error('[admin] gamification settings error:', err);
                errBox.textContent = 'Salvataggio non riuscito: ' + (err.code || err.message);
                errBox.hidden = false;
            }
            return;
        }

        if (e.target.id !== 'promoForm') return;
        e.preventDefault();
        const errBox = panel.querySelector('#promoFormErr');
        errBox.hidden = true;

        const title = panel.querySelector('#promoTitle').value.trim();
        const prizeLabel = panel.querySelector('#promoPrize').value.trim();
        const actionType = panel.querySelector('#promoAction').value;
        const refTargetRaw = panel.querySelector('#promoRefTarget').value;
        const eventRef = panel.querySelector('#promoEventRef').value || null;
        const aiChecklist = panel.querySelector('#promoChecklist').value.trim();
        const startStr = panel.querySelector('#promoStart').value;
        const endStr = panel.querySelector('#promoEnd').value;
        const active = panel.querySelector('#promoActive').checked;

        if (!title || !prizeLabel) {
            errBox.textContent = 'Titolo e premio sono obbligatori.';
            errBox.hidden = false;
            return;
        }
        if (!ACTION_TYPES[actionType]) {
            errBox.textContent = 'Tipo di azione non valido.';
            errBox.hidden = false;
            return;
        }
        const refTarget = actionType === 'referral' ? parseInt(refTargetRaw, 10) : null;
        if (actionType === 'referral' && (!Number.isInteger(refTarget) || refTarget < 1)) {
            errBox.textContent = 'La soglia referral deve essere un numero intero ≥ 1.';
            errBox.hidden = false;
            return;
        }
        let startsAt = null;
        let endsAt = null;
        if (startStr) {
            startsAt = new Date(startStr);
            if (isNaN(startsAt)) { errBox.textContent = 'Data di inizio non valida.'; errBox.hidden = false; return; }
        }
        if (endStr) {
            endsAt = new Date(endStr);
            if (isNaN(endsAt)) { errBox.textContent = 'Data di fine non valida.'; errBox.hidden = false; return; }
        }
        if (startsAt && endsAt && endsAt <= startsAt) {
            errBox.textContent = 'La fine deve essere successiva all\'inizio.';
            errBox.hidden = false;
            return;
        }

        const payload = {
            title, prizeLabel, actionType, refTarget, eventRef, aiChecklist,
            startsAt, endsAt, active,
            updatedAt: serverTimestamp(),
        };
        try {
            const db = await getDb();
            if (editingId) {
                await updateDoc(doc(db, 'promos', editingId), payload);
                promoTitleCache.set(editingId, title);
                toast('Promozione aggiornata.');
            } else {
                await addDoc(collection(db, 'promos'), { ...payload, createdAt: serverTimestamp() });
                toast('Promozione creata.');
            }
            formSlot.innerHTML = '';
            editingId = null;
        } catch (err) {
            console.error('[admin] save promo error:', err);
            errBox.textContent = 'Salvataggio non riuscito: ' + (err.code || err.message);
            errBox.hidden = false;
        }
    });

    await loadGamConfig();
    syncSettingsUI();
    loadSuspicious();

    try {
        const db = await getDb();
        unsubscribe.promos = onSnapshot(
            query(collection(db, 'promos'), orderBy('createdAt', 'desc')),
            (snap) => {
                promosCache = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
                promosCache.forEach(({ id, data: p }) => promoTitleCache.set(id, p.title || ''));
                renderPromos();
            },
            (err) => {
                console.error('[admin] promos snapshot error:', err);
                listEl.innerHTML = '<div class="adm-inline-err">Errore nel caricamento delle promozioni.</div>';
            }
        );
        // Claims: snapshot su tutta la collection (lettura admin consentita dalle
        // rules, volumi bassi). Render async perché risolve nomi membri.
        unsubscribe.claims = onSnapshot(
            collection(db, 'claims'),
            (snap) => {
                claimsCache = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
                renderClaims().catch((err) => {
                    console.error('[admin] claims render error:', err);
                });
            },
            (err) => {
                console.error('[admin] claims snapshot error:', err);
                claimsTbody.innerHTML = '<tr><td colspan="7"><div class="adm-inline-err">Errore nel caricamento delle richieste.</div></td></tr>';
            }
        );
    } catch (err) {
        console.error('[admin] promos init error:', err);
        listEl.innerHTML = '<div class="adm-inline-err">Impossibile connettersi al database.</div>';
    }
}

/* ------------------------------------ tab: badge ------------------------------------ */

const BADGE_METRICS = {
    totalClaims: 'Azioni totali completate',
    referralCount: 'Amici invitati (conteggio)',
    'actionsCount.condividi_evento': 'Condivisioni evento',
    'actionsCount.condividi_post': 'Condivisioni post',
    'actionsCount.tag_story': 'Tag in stories',
    'actionsCount.referral': 'Premi referral raggiunti',
    'actionsCount.custom': 'Azioni personalizzate',
};

function badgeFormHTML(badge) {
    const isEdit = Boolean(badge);
    const metric = badge?.rule?.metric || 'totalClaims';
    const metricOptions = Object.entries(BADGE_METRICS).map(([v, l]) =>
        `<option value="${v}" ${metric === v ? 'selected' : ''}>${l}</option>`).join('');
    return `
    <form id="badgeForm" class="adm-form" novalidate>
        <div class="adm-form-title">${isEdit ? 'Modifica badge' : 'Nuovo badge'}</div>
        <div class="adm-row">
            <div class="adm-group">
                <label for="badgeName">Nome</label>
                <input id="badgeName" type="text" required value="${esc(badge?.name || '')}" placeholder="Ambasciatore Fonderia">
            </div>
            <div class="adm-group">
                <label for="badgeIcon">Icona (emoji)</label>
                <input id="badgeIcon" type="text" maxlength="4" value="${esc(badge?.icon || '🏅')}" placeholder="🏅">
            </div>
        </div>
        <div class="adm-group">
            <label for="badgeDesc">Descrizione <span class="adm-optional">(opzionale)</span></label>
            <input id="badgeDesc" type="text" value="${esc(badge?.description || '')}" placeholder="Hai portato 5 amici alla Fonderia">
        </div>
        <div class="adm-row">
            <div class="adm-group">
                <label for="badgeMetric">Regola: metrica</label>
                <select id="badgeMetric">${metricOptions}</select>
            </div>
            <div class="adm-group">
                <label for="badgeThreshold">Regola: soglia <span class="adm-tip" tabindex="0" data-tip="Il badge viene assegnato in automatico quando la metrica raggiunge questo numero.">?</span></label>
                <input id="badgeThreshold" type="number" min="1" step="1" required value="${esc(badge?.rule?.threshold ?? 1)}">
            </div>
        </div>
        <label class="adm-check">
            <input id="badgeActive" type="checkbox" ${!isEdit || badge.active !== false ? 'checked' : ''}>
            Attivo (assegnabile)
        </label>
        <div id="badgeFormErr" class="adm-inline-err" hidden></div>
        <div class="adm-form-actions">
            <button class="adm-btn" type="submit">${isEdit ? 'Salva modifiche' : 'Crea badge'}</button>
            <button class="adm-btn adm-btn-ghost" type="button" data-badge-action="cancel">Annulla</button>
        </div>
    </form>`;
}

async function startBadgesTab() {
    const panel = els.panels.badges;
    let editingId = null;
    let cached = [];

    panel.innerHTML = `
        <div class="adm-panel-head">
            <div>
                <h2>Badge</h2>
                <p class="adm-panel-lead">I badge attivi vengono assegnati in automatico dalle Cloud Function quando un cliente raggiunge la soglia della metrica scelta.</p>
            </div>
            <button class="adm-btn" data-badge-action="new" type="button">+ Nuovo badge</button>
        </div>
        <div id="badgeFormSlot"></div>
        <div id="badgeList" class="adm-list"><div class="adm-empty">Caricamento badge…</div></div>`;

    const formSlot = panel.querySelector('#badgeFormSlot');
    const listEl = panel.querySelector('#badgeList');

    function renderList() {
        if (!cached.length) {
            listEl.innerHTML = '<div class="adm-empty">Nessun badge ancora.</div>';
            return;
        }
        listEl.innerHTML = cached.map(({ id, data: b }) => `
            <div class="adm-card${b.active === false ? ' inactive' : ''}">
                <div class="adm-card-main">
                    <div class="adm-card-title">${esc(b.icon || '🏅')} ${esc(b.name || '(senza nome)')}</div>
                    <div class="adm-card-sub">${esc(BADGE_METRICS[b.rule?.metric] || b.rule?.metric || '—')} ≥ ${esc(b.rule?.threshold ?? '—')}${b.description ? ' · ' + esc(b.description) : ''}</div>
                </div>
                <div class="adm-card-actions">
                    <span class="adm-badge ${b.active !== false ? 'adm-badge--on' : 'adm-badge--off'}">${b.active !== false ? 'Attivo' : 'Nascosto'}</span>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-badge-action="toggle" data-id="${id}" type="button">${b.active !== false ? 'Disattiva' : 'Attiva'}</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-badge-action="edit" data-id="${id}" type="button">Modifica</button>
                    <button class="adm-btn adm-btn-danger adm-btn-sm" data-badge-action="delete" data-id="${id}" type="button">Elimina</button>
                </div>
            </div>`).join('');
    }

    function openForm(badge, id) {
        editingId = id;
        formSlot.innerHTML = badgeFormHTML(badge);
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    panel.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-badge-action]');
        if (!btn) return;
        const action = btn.dataset.badgeAction;
        const id = btn.dataset.id;
        const entry = cached.find((c) => c.id === id);

        try {
            const db = await getDb();
            if (action === 'new') openForm(null, null);
            else if (action === 'cancel') { formSlot.innerHTML = ''; editingId = null; }
            else if (action === 'edit') { if (entry) openForm(entry.data, id); }
            else if (action === 'toggle') {
                await updateDoc(doc(db, 'badges', id), { active: entry.data.active === false, updatedAt: serverTimestamp() });
            } else if (action === 'delete') {
                if (confirm(`Eliminare il badge "${entry?.data?.name || id}"? Chi lo ha già guadagnato lo mantiene sulla tessera.`)) {
                    await deleteDoc(doc(db, 'badges', id));
                    toast('Badge eliminato.');
                }
            }
        } catch (err) {
            console.error('[admin] badges action error:', err);
            toast('Operazione non riuscita: ' + (err.code || err.message), true);
        }
    });

    panel.addEventListener('submit', async (e) => {
        if (e.target.id !== 'badgeForm') return;
        e.preventDefault();
        const errBox = panel.querySelector('#badgeFormErr');
        errBox.hidden = true;

        const name = panel.querySelector('#badgeName').value.trim();
        const icon = panel.querySelector('#badgeIcon').value.trim() || '🏅';
        const description = panel.querySelector('#badgeDesc').value.trim();
        const metric = panel.querySelector('#badgeMetric').value;
        const threshold = parseInt(panel.querySelector('#badgeThreshold').value, 10);
        const active = panel.querySelector('#badgeActive').checked;

        if (!name) { errBox.textContent = 'Il nome è obbligatorio.'; errBox.hidden = false; return; }
        if (!BADGE_METRICS[metric]) { errBox.textContent = 'Metrica non valida.'; errBox.hidden = false; return; }
        if (!Number.isInteger(threshold) || threshold < 1) {
            errBox.textContent = 'La soglia deve essere un numero intero ≥ 1.';
            errBox.hidden = false;
            return;
        }

        const payload = {
            name, icon, description,
            rule: { metric, threshold },
            active,
            updatedAt: serverTimestamp(),
        };
        try {
            const db = await getDb();
            if (editingId) {
                await updateDoc(doc(db, 'badges', editingId), payload);
                toast('Badge aggiornato.');
            } else {
                await addDoc(collection(db, 'badges'), { ...payload, createdAt: serverTimestamp() });
                toast('Badge creato.');
            }
            formSlot.innerHTML = '';
            editingId = null;
        } catch (err) {
            console.error('[admin] save badge error:', err);
            errBox.textContent = 'Salvataggio non riuscito: ' + (err.code || err.message);
            errBox.hidden = false;
        }
    });

    try {
        const db = await getDb();
        unsubscribe.badges = onSnapshot(
            query(collection(db, 'badges'), orderBy('createdAt', 'desc')),
            (snap) => {
                cached = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
                renderList();
            },
            (err) => {
                console.error('[admin] badges snapshot error:', err);
                listEl.innerHTML = '<div class="adm-inline-err">Errore nel caricamento dei badge.</div>';
            }
        );
    } catch (err) {
        console.error('[admin] badges init error:', err);
        listEl.innerHTML = '<div class="adm-inline-err">Impossibile connettersi al database.</div>';
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
