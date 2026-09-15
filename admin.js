/**
 * admin.js — Area Gestionale Fonderia Treviso
 * Magic link auth + registro adminUsers/<email> (owner/editor) → tab Eventi /
 * Popup / Prenotazioni / Newsletter / Promozioni / Badge / Statistiche /
 * Utenti (solo owner).
 * Dipende da firebase-init.js (getDb/getAuthInstance/getStorageInstance) e
 * firebase-config.js (window.FB_CONFIG), caricati da admin.html.
 */

import { getAuthInstance, getDb, getStorageInstance, getFunctionsInstance } from './firebase-init.js';
import { onAuthStateChanged, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signInWithEmailAndPassword, signOut }
    from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
         query, where, orderBy, limit, serverTimestamp, increment }
    from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject }
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
        users: $('tab-users'),
        social: $('tab-social'),
        marketing: $('tab-marketing'),
    },
};

let unsubscribe = { events: null, popups: null, bookings: null, newsletter: null, promos: null, badges: null, claims: null, users: null, social: null, campaigns: null, marketing: null };

// Ponte tab Marketing → tab Social: la tab marketing ha bisogno dell'editor
// media (che vive nella closure di startSocialTab) per aggiungere logo/testi
// agli asset del wizard. Popolato da startSocialTab all'avvio della shell.
const marketingBridge = { openEditor: null };
let bookingsCache = [];
let bookingsFilter = 'all';
let toastTimer = null;
// Chi è loggato (da adminUsers/<email>): email per l'audit updatedBy/createdBy,
// role per mostrare la tab Utenti solo agli owner.
let currentUserEmail = '';
let currentUserRole = 'editor';

// Campi audit su ogni scrittura: updatedBy/updatedAt sempre; createdBy/
// createdAt sui create. L'email viene dal registro adminUsers, non dal token.
function auditUpdate() {
    return { updatedAt: serverTimestamp(), updatedBy: currentUserEmail };
}
function auditCreate() {
    return { ...auditUpdate(), createdAt: serverTimestamp(), createdBy: currentUserEmail };
}
function auditBy(d) {
    return d && d.updatedBy ? ' · da ' + esc(d.updatedBy) : '';
}

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

/* ---------------- generazione immagini IA (callable generateImage) ----------------
 * Blocco riusabile (tab Eventi e Popup): prompt modificabile precompilato,
 * chiama la callable admin-only generateImage (gemini image su Vertex AI,
 * cap 20/ora lato server) → URL Storage pubblico passato a onUrl. */
function aiImageBlockHTML(prefix, defaultPrompt) {
    return `
    <div class="adm-group adm-ai-img">
        <label for="${prefix}AiPrompt">🎨 Genera immagine con IA
            <span class="adm-tip" tabindex="0" data-tip="Gemini (Google) genera un'immagine in stile Fonderia partendo dalla descrizione. Puoi modificare il testo prima di generare. Max 20 immagini/ora. L'immagine generata vince sulle altre scelte quando salvi.">?</span>
        </label>
        <textarea id="${prefix}AiPrompt" rows="2" placeholder="Descrivi l'immagine da creare, es: tavolata di amici con birre artigianali e musica dal vivo">${esc(defaultPrompt || '')}</textarea>
        <div class="adm-ai-img-actions">
            <button type="button" id="${prefix}AiGenBtn" class="adm-btn adm-btn-ghost adm-btn-sm adm-btn-ai">🎨 Genera immagine</button>
            <span id="${prefix}AiStatus" class="adm-cell-muted" role="status"></span>
        </div>
    </div>`;
}

/* La miniatura .adm-img-preview (popup/eventi, upload e IA) è piccola: al click si
 * apre a tutto schermo. Riutilizza lo stesso overlay .adm-shot-overlay delle prove
 * screenshot claim — un solo pattern, chiusura toccando fuori. */
document.addEventListener('click', (e) => {
    const prev = e.target.closest && e.target.closest('.adm-img-preview');
    if (!prev || !prev.src) return;
    const overlay = document.createElement('div');
    overlay.className = 'adm-shot-overlay';
    const img = document.createElement('img');
    img.src = prev.src;
    img.alt = prev.alt || 'Anteprima immagine';
    const hint = document.createElement('p');
    hint.className = 'adm-shot-hint';
    hint.textContent = 'Tocca fuori dall’immagine per chiudere';
    overlay.append(img, hint);
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
});

async function runAiImage(prefix, onUrl) {
    const promptEl = $(prefix + 'AiPrompt');
    const statusEl = $(prefix + 'AiStatus');
    const btn = $(prefix + 'AiGenBtn');
    if (!promptEl || !btn) return;
    const prompt = promptEl.value.trim();
    if (prompt.length < 10) {
        toast('Descrivi l’immagine in almeno 10 caratteri (o scrivi prima il titolo).', true);
        promptEl.focus();
        return;
    }
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '⏳ Genero (può richiedere 30 s)…';
    if (statusEl) statusEl.textContent = '';
    try {
        const fn = httpsCallable(await getFunctionsInstance(), 'generateImage');
        const res = await fn({ prompt });
        const url = res && res.data && res.data.url;
        if (!url) throw new Error('risposta senza URL');
        onUrl(url);
        if (statusEl) statusEl.textContent = 'Immagine generata ✓ rivedila nell’anteprima, poi salva.';
    } catch (err) {
        console.error('[admin] generateImage error:', err);
        const msg = (err && (err.details || err.message)) || String(err);
        if (statusEl) statusEl.textContent = 'Non riuscita: ' + msg;
        toast('Generazione immagine non riuscita: ' + msg, true);
    } finally {
        btn.disabled = false;
        btn.textContent = label;
    }
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

async function initShell(user, authz) {
    els.boot.hidden = true;
    els.login.hidden = true;
    els.shell.hidden = false;
    currentUserEmail = authz.email;
    currentUserRole = authz.role;
    els.userEmail.textContent = (user.email || '') + (authz.role === 'owner' ? ' · owner' : '');

    // Tab Utenti: solo owner (le rules impediscono comunque le scritture
    // ai non-owner; qui nascondiamo proprio la tab).
    const usersTabBtn = $('admTabUsers');
    if (usersTabBtn) usersTabBtn.hidden = authz.role !== 'owner';

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
    startSocialTab();
    startMarketingTab();
    if (authz.role === 'owner') startUsersTab();
}

function stopAll() {
    Object.values(unsubscribe).forEach((fn) => { if (fn) fn(); });
    unsubscribe = { events: null, popups: null, bookings: null, newsletter: null, promos: null, badges: null, claims: null, users: null, social: null, campaigns: null, marketing: null, mkEvents: null, mkPopups: null, mkPosts: null, mkCampaigns: null };
}

/* ------------------------------------ tab: eventi ------------------------------------ */

function eventFormHTML(ev) {
    const isEdit = Boolean(ev);
    const options = LOCAL_IMAGES.map((src) => {
        const sel = isEdit && ev.image === src ? ' selected' : '';
        return `<option value="${src}"${sel}>${src.replace('images/', '')}</option>`;
    }).join('');
    const customUrl = isEdit && ev.image && !LOCAL_IMAGES.includes(ev.image) ? ev.image : '';
    // Prompt IA precompilato da titolo+tagline (modificabile prima di generare)
    const defaultAiPrompt = isEdit && ev.title
        ? ev.title + (ev.tagline ? ' — ' + ev.tagline : '')
        : '';
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
                <label for="evImageUrl">oppure URL immagine libero <span class="adm-tip" tabindex="0" data-tip="Incolla il link diretto a un'immagine (https://…). Se compilato, vince sulla scelta dalla galleria. Upload e generazione IA compilano questo campo da soli.">?</span></label>
                <input id="evImageUrl" type="url" value="${esc(customUrl)}" placeholder="https://…" ${customUrl ? '' : 'disabled'}>
            </div>
        </div>
        <div class="adm-row">
            <div class="adm-group">
                <label for="evUpload">oppure carica dal computer <span class="adm-tip" tabindex="0" data-tip="JPG/PNG/WebP fino a 3 MB. Viene caricata su Firebase Storage (event-images/) e usata come immagine dell'evento.">?</span></label>
                <input id="evUpload" type="file" accept="image/*">
            </div>
            ${aiImageBlockHTML('ev', defaultAiPrompt)}
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
                    <div class="adm-card-sub">${fmtDate(ev.date)}${ev.time ? ' · ' + esc(ev.time) : ''}${auditBy(ev)}</div>
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

    // Upload locale o generazione IA → compilano evImageUrl (vince in save).
    function applyEventImageUrl(url) {
        const urlInput = $('evImageUrl');
        urlInput.disabled = false;
        urlInput.value = url;
        $('evImageSelect').value = '';
        updateEventPreview();
    }

    async function handleEventUpload(file) {
        const errBox = $('evFormErr');
        errBox.hidden = true;
        if (file.size > 3 * 1024 * 1024) {
            errBox.textContent = 'Immagine troppo grande (max 3 MB).';
            errBox.hidden = false;
            return;
        }
        try {
            const storage = await getStorageInstance();
            const path = 'event-images/' + Date.now() + '-' + sanitizeFilename(file.name);
            await uploadBytes(storageRef(storage, path), file);
            const url = await getDownloadURL(storageRef(storage, path));
            applyEventImageUrl(url);
            toast('Immagine caricata. Salva l’evento per usarla.');
        } catch (err) {
            console.error('[admin] event upload error:', err);
            errBox.hidden = false;
            errBox.textContent = 'Upload non riuscito: ' + (err.code || err.message);
        }
    }

    panel.addEventListener('click', async (e) => {
        const aiBtn = e.target.closest('#evAiBtn');
        if (aiBtn) { runAiSuggest(aiBtn); return; }
        const aiImgBtn = e.target.closest('#evAiGenBtn');
        if (aiImgBtn) {
            // precompila il prompt da titolo+tagline se l'admin non l'ha toccato
            const promptEl = $('evAiPrompt');
            if (promptEl && !promptEl.value.trim()) {
                promptEl.value = [$('evTitle').value.trim(), $('evTagline').value.trim()].filter(Boolean).join(' — ');
            }
            runAiImage('ev', applyEventImageUrl);
            return;
        }
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
                await updateDoc(doc(db, 'events', id), { active: entry.data.active === false, ...auditUpdate() });
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
        if (e.target.id === 'evUpload' && e.target.files[0]) handleEventUpload(e.target.files[0]);
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

        const payload = { title, tagline, date, time, description, image, active, order, ...auditUpdate() };

        try {
            const db = await getDb();
            if (editingId) {
                await updateDoc(doc(db, 'events', editingId), payload);
                toast('Evento aggiornato.');
            } else {
                await addDoc(collection(db, 'events'), { ...payload, ...auditCreate() });
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
            ${aiImageBlockHTML('pop', isEdit && pop.title ? pop.title + (pop.body ? ' — ' + pop.body : '') : '')}
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
                    <div class="adm-card-sub">${fmtDateTime(p.startDate)} → ${fmtDateTime(p.endDate)} · CTA: ${esc(p.ctaType || 'booking')}${auditBy(p)}</div>
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

    // Immagine generata via IA → conta come upload Storage (stesso salva-flusso).
    function applyAiImage(url) {
        uploadedImage = { imageUrl: url, imageSource: 'storage' };
        panel.querySelectorAll('#popForm .adm-img-cell').forEach((c) => c.classList.remove('selected'));
        const r = panel.querySelector('#popForm input[name="popBg"]:checked');
        if (r) r.checked = false;
        $('popUploadPreview').innerHTML = `<img class="adm-img-preview" src="${url}" alt="immagine generata">`;
    }

    panel.addEventListener('click', async (e) => {
        const aiImgBtn = e.target.closest('#popAiGenBtn');
        if (aiImgBtn) {
            const promptEl = $('popAiPrompt');
            if (promptEl && !promptEl.value.trim()) {
                promptEl.value = [$('popTitle').value.trim(), $('popBody').value.trim()].filter(Boolean).join(' — ');
            }
            runAiImage('pop', applyAiImage);
            return;
        }

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
                await updateDoc(doc(db, 'popups', id), { active: entry.data.active === false, ...auditUpdate() });
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
            ...auditUpdate(),
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
                await addDoc(collection(db, 'popups'), { ...payload, version: 1, ...auditCreate() });
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
            await updateDoc(doc(db, 'bookings', id), { status, ...auditUpdate() });
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
                    <div class="adm-card-sub">${esc(ACTION_TYPES[p.actionType] || p.actionType || '—')} · Premio: ${esc(p.prizeLabel || '—')}${p.actionType === 'referral' && p.refTarget ? ' · soglia ' + esc(p.refTarget) : ''}${p.startsAt || p.endsAt ? '<br>' + fmtDateTime(p.startsAt) + ' → ' + fmtDateTime(p.endsAt) : ''}${auditBy(p)}</div>
                </div>
                <div class="adm-card-actions">
                    <span class="adm-badge ${p.active !== false ? 'adm-badge--on' : 'adm-badge--off'}">${p.active !== false ? 'Attiva' : 'Nascosta'}</span>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-promo-action="copy" data-id="${esc(id)}" type="button">Copia link</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-promo-action="toggle" data-id="${esc(id)}" type="button">${p.active !== false ? 'Disattiva' : 'Attiva'}</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-promo-action="edit" data-id="${esc(id)}" type="button">Modifica</button>
                    <button class="adm-btn adm-btn-danger adm-btn-sm" data-promo-action="delete" data-id="${esc(id)}" type="button">Elimina</button>
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
                ? `<button class="adm-btn adm-btn-sm" data-claim-review="${esc(id)}" data-approve="1" type="button">Approva</button>
                   <button class="adm-btn adm-btn-danger adm-btn-sm" data-claim-review="${esc(id)}" data-approve="0" type="button">Rifiuta</button>`
                : '';
            const proof = c.screenshotPath
                ? `<button class="adm-btn adm-btn-ghost adm-btn-sm" data-claim-shot="${esc(id)}" type="button">Vedi prova</button>`
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
                    <button class="adm-btn adm-btn-sm" data-susp-approve="${esc(id)}" type="button">Approva referral</button>
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
                await updateDoc(doc(db, 'promos', id), { active: entry.data.active === false, ...auditUpdate() });
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
                await setDoc(doc(db, 'config', 'gamification'), { ...update, ...auditUpdate() }, { merge: true });
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
        // Object.hasOwn: la lookup su chiavi da Firestore non deve accettare
        // chiavi di prototype chain (es. 'toString') come valide (M2, R1 Task 11).
        if (!Object.hasOwn(ACTION_TYPES, actionType)) {
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
            ...auditUpdate(),
        };
        try {
            const db = await getDb();
            if (editingId) {
                await updateDoc(doc(db, 'promos', editingId), payload);
                promoTitleCache.set(editingId, title);
                toast('Promozione aggiornata.');
            } else {
                await addDoc(collection(db, 'promos'), { ...payload, ...auditCreate() });
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
                    <div class="adm-card-sub">${esc(BADGE_METRICS[b.rule?.metric] || b.rule?.metric || '—')} ≥ ${esc(b.rule?.threshold ?? '—')}${b.description ? ' · ' + esc(b.description) : ''}${auditBy(b)}</div>
                </div>
                <div class="adm-card-actions">
                    <span class="adm-badge ${b.active !== false ? 'adm-badge--on' : 'adm-badge--off'}">${b.active !== false ? 'Attivo' : 'Nascosto'}</span>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-badge-action="toggle" data-id="${esc(id)}" type="button">${b.active !== false ? 'Disattiva' : 'Attiva'}</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-badge-action="edit" data-id="${esc(id)}" type="button">Modifica</button>
                    <button class="adm-btn adm-btn-danger adm-btn-sm" data-badge-action="delete" data-id="${esc(id)}" type="button">Elimina</button>
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
                await updateDoc(doc(db, 'badges', id), { active: entry.data.active === false, ...auditUpdate() });
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
        if (!Object.hasOwn(BADGE_METRICS, metric)) { errBox.textContent = 'Metrica non valida.'; errBox.hidden = false; return; }
        if (!Number.isInteger(threshold) || threshold < 1) {
            errBox.textContent = 'La soglia deve essere un numero intero ≥ 1.';
            errBox.hidden = false;
            return;
        }

        const payload = {
            name, icon, description,
            rule: { metric, threshold },
            active,
            ...auditUpdate(),
        };
        try {
            const db = await getDb();
            if (editingId) {
                await updateDoc(doc(db, 'badges', editingId), payload);
                toast('Badge aggiornato.');
            } else {
                await addDoc(collection(db, 'badges'), { ...payload, ...auditCreate() });
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

/* --------------------------- tab: utenti (solo owner) --------------------------- *
 * Registro adminUsers/<email-lowercase>. Gli owner (👑) sono seminati via
 * Admin SDK e non compaiono con azioni (immutabili anche lato rules).
 * L'aggiunta non crea l'account Firebase: il nuovo utente richiede il magic
 * link dalla pagina di login con la sua email e diventa operativo subito. */
function startUsersTab() {
    const panel = els.panels.users;
    if (!panel) return;
    let cached = [];

    panel.innerHTML = `
        <div class="adm-panel-head">
            <div>
                <h2>Utenti gestionale</h2>
                <p class="adm-panel-lead">Chi può accedere a quest’area. Solo gli owner possono aggiungere, sospendere o eliminare utenti; gli owner (👑) non sono modificabili. Il nuovo utente accede richiedendo il link email dalla pagina di login con il suo indirizzo.</p>
            </div>
        </div>
        <form id="usAddForm" class="adm-form" novalidate>
            <div class="adm-form-title">Aggiungi utente</div>
            <div class="adm-row">
                <div class="adm-group">
                    <label for="usName">Nome</label>
                    <input id="usName" type="text" required placeholder="Nome e cognome" autocomplete="off">
                </div>
                <div class="adm-group">
                    <label for="usEmail">Email</label>
                    <input id="usEmail" type="email" required placeholder="nome@esempio.it" autocomplete="off">
                </div>
            </div>
            <div id="usAddErr" class="adm-inline-err" hidden></div>
            <div class="adm-form-actions">
                <button class="adm-btn" type="submit">+ Aggiungi utente</button>
            </div>
        </form>
        <div id="usList" class="adm-list"><div class="adm-empty">Caricamento utenti…</div></div>`;

    const listEl = panel.querySelector('#usList');

    function renderList() {
        if (!cached.length) {
            listEl.innerHTML = '<div class="adm-empty">Nessun utente registrato.</div>';
            return;
        }
        listEl.innerHTML = cached.map(({ id, data: u }) => {
            const ownerRow = u.role === 'owner';
            return `
            <div class="adm-card${u.status !== 'active' ? ' inactive' : ''}">
                <div class="adm-card-main">
                    <div class="adm-card-title">${ownerRow ? '👑 ' : ''}${esc(u.name || '(senza nome)')} <span class="adm-cell-muted">${esc(id)}</span></div>
                    <div class="adm-card-sub">${ownerRow ? 'Owner' : 'Editor'}${auditBy(u)}</div>
                </div>
                <div class="adm-card-actions">
                    <span class="adm-badge ${u.status === 'active' ? 'adm-badge--on' : 'adm-badge--off'}">${u.status === 'active' ? 'Attivo' : 'Sospeso'}</span>
                    ${ownerRow ? '' : `
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-us-action="toggle" data-id="${esc(id)}" type="button">${u.status === 'active' ? 'Sospendi' : 'Riattiva'}</button>
                    <button class="adm-btn adm-btn-danger adm-btn-sm" data-us-action="delete" data-id="${esc(id)}" type="button">Elimina</button>`}
                </div>
            </div>`;
        }).join('');
    }

    panel.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-us-action]');
        if (!btn) return;
        const id = btn.dataset.id;
        const entry = cached.find((c) => c.id === id);
        // doppia barriera oltre le Firestore rules: gli owner non si toccano
        if (!entry || entry.data.role === 'owner') return;
        try {
            const db = await getDb();
            if (btn.dataset.usAction === 'toggle') {
                const next = entry.data.status === 'active' ? 'suspended' : 'active';
                await updateDoc(doc(db, 'adminUsers', id), { status: next, ...auditUpdate() });
                toast(next === 'active' ? 'Utente riattivato.' : 'Utente sospeso: non può più accedere.');
            } else if (btn.dataset.usAction === 'delete') {
                if (confirm(`Eliminare l'utente ${id}? Non potrà più accedere al gestionale. L'azione non è reversibile.`)) {
                    await deleteDoc(doc(db, 'adminUsers', id));
                    toast('Utente eliminato.');
                }
            }
        } catch (err) {
            console.error('[admin] users action error:', err);
            toast('Operazione non riuscita: ' + (err.code || err.message), true);
        }
    });

    panel.addEventListener('submit', async (e) => {
        if (e.target.id !== 'usAddForm') return;
        e.preventDefault();
        const errBox = $('usAddErr');
        errBox.hidden = true;
        const name = $('usName').value.trim();
        const emailLc = $('usEmail').value.trim().toLowerCase();
        if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailLc)) {
            errBox.textContent = 'Servono nome e un indirizzo email valido.';
            errBox.hidden = false;
            return;
        }
        if (cached.some((c) => c.id === emailLc)) {
            errBox.textContent = 'Questo indirizzo è già registrato.';
            errBox.hidden = false;
            return;
        }
        try {
            const db = await getDb();
            await setDoc(doc(db, 'adminUsers', emailLc), {
                name, email: emailLc, role: 'editor', status: 'active', ...auditCreate(),
            });
            $('usName').value = '';
            $('usEmail').value = '';
            toast('Utente aggiunto: può accedere dalla pagina di login con la sua email.');
        } catch (err) {
            console.error('[admin] add user error:', err);
            errBox.textContent = 'Aggiunta non riuscita: ' + (err.code || err.message);
            errBox.hidden = false;
        }
    });

    getDb().then((db) => {
        unsubscribe.users = onSnapshot(
            query(collection(db, 'adminUsers'), orderBy('name')),
            (snap) => {
                cached = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
                renderList();
            },
            (err) => {
                console.error('[admin] users snapshot error:', err);
                listEl.innerHTML = '<div class="adm-inline-err">Errore nel caricamento degli utenti.</div>';
            }
        );
    }).catch((err) => {
        console.error('[admin] users init error:', err);
        listEl.innerHTML = '<div class="adm-inline-err">Impossibile connettersi al database.</div>';
    });
}

/* ------------------------------------ tab: social ------------------------------------
 * Tre viste: Crea (brief → testi IA per FB/IG/WA/TT, immagine base, ritagli
 * canvas nei formati, reel animato browser oppure video IA Veo), Campagna
 * (programmazione con stato, link UTM e metriche), Galleria (tutti gli asset
 * prodotti, scaricabili e riusabili). Dati: campaigns/ e socialPosts/
 * (solo admin, vedi firestore.rules), file su Storage social/.
 * Costo video IA indicato sul bottone: Veo 3.1 Fast 8s ≈ 1,20 $ lato Google. */

const SOC_PLATFORMS = { fb: 'Facebook', ig: 'Instagram', wa: 'WhatsApp', tt: 'TikTok' };
const SOC_STATUSES = { draft: 'Bozza', scheduled: 'Programmato', published: 'Pubblicato' };
// Ritagli prodotti dal canvas partendo dall'immagine base (center-crop).
const SOC_CROPS = [
    { label: '16:9 — post Facebook', w: 1200, h: 675 },
    { label: '1:1 — post Instagram', w: 1080, h: 1080 },
    { label: '9:16 — stories / TikTok', w: 1080, h: 1920 },
];

function socSlug(s) {
    return String(s || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'campagna';
}

function socUtmLink(platform, utmCampaign) {
    return 'https://fonderia-treviso.web.app/?utm_source=' + encodeURIComponent(platform) +
        '&utm_medium=social&utm_campaign=' + encodeURIComponent(utmCampaign);
}

// Scarica un file da un URL pubblico: fetch → objectURL (nome pulito);
// se CORS/rete bloccano, fallback aprendo l'URL in una nuova scheda.
async function socDownload(url, filename) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename || 'file';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (err) {
        console.warn('[admin] download via fetch fallito, apro in nuova scheda:', err);
        window.open(url, '_blank', 'noopener');
    }
}

async function socLoadImage(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error('immagine non caricabile'));
        img.src = url;
    });
    return img;
}

// Center-crop con cover: canvas WxH dal img caricato. Ritorna un Blob PNG.
// Richiede CORS Attivo sul bucket Storage (Access-Control-Allow-Origin).
function socCropToBlob(img, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const sw = w / scale;
    const sh = h / scale;
    const sx = (img.naturalWidth - sw) / 2;
    const sy = (img.naturalHeight - sh) / 2;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    return new Promise((res, rej) => {
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('canvas vuoto'))), 'image/png');
    });
}

// Reel "Ken Burns": 8s verticali (720x1280) con zoom lento sull'immagine
// base, fascia scura in basso con titolo + logo testuale. Registrato con
// MediaRecorder → .webm (IG/TT preferiscono mp4: il bottone lo segnala).
function socRenderReel(img, title) {
    const W = 720;
    const H = 1280;
    const DUR = 8000;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
    const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 5000000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => {
        rec.onstop = () => res(new Blob(chunks, { type: 'video/webm' }));
    });
    // cover 9:16 sull'immagine sorgente
    const baseScale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    const start = performance.now();
    function frame(now) {
        const t = Math.min(1, (now - start) / DUR);
        const zoom = 1 + 0.14 * t; // zoom-in continuo
        const dw = img.naturalWidth * baseScale * zoom;
        const dh = img.naturalHeight * baseScale * zoom;
        const dx = (W - dw) / 2 - dw * 0.02 * t; // lieve pan orizzontale
        const dy = (H - dh) / 2;
        ctx.fillStyle = '#141210';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(img, dx, dy, dw, dh);
        // fascia inferiore con titolo
        const grad = ctx.createLinearGradient(0, H - 420, 0, H);
        grad.addColorStop(0, 'rgba(10,8,6,0)');
        grad.addColorStop(1, 'rgba(10,8,6,0.88)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, H - 420, W, 420);
        ctx.fillStyle = '#f5efe4';
        ctx.textAlign = 'center';
        ctx.font = '700 52px "Space Grotesk", sans-serif';
        const words = String(title || '').split(' ');
        const lines = [];
        let line = '';
        words.forEach((wd) => {
            if ((line + ' ' + wd).trim().length > 22) { lines.push(line.trim()); line = wd; }
            else line += ' ' + wd;
        });
        if (line.trim()) lines.push(line.trim());
        const shown = lines.slice(0, 3);
        shown.forEach((l, i) => ctx.fillText(l, W / 2, H - 170 - (shown.length - 1 - i) * 62));
        ctx.fillStyle = '#d9a441';
        ctx.font = '500 30px "Space Grotesk", sans-serif';
        ctx.fillText('FONDERIA TREVISO', W / 2, H - 84);
        if (t < 1) requestAnimationFrame(frame);
        else rec.stop();
    }
    rec.start(250);
    requestAnimationFrame(frame);
    return done;
}

async function startSocialTab() {
    const panel = els.panels.social;
    if (!panel) return;

    let view = 'create'; // create | campagna | galleria
    let campaigns = [];
    let posts = [];
    let editingId = null;      // post in modifica nella vista Crea
    let baseImageUrl = '';     // immagine base scelta (URL Storage pubblico)
    let gaCampaignSessions = null; // { slug: sessions } da getGaStats, una volta

    const db = await getDb();

    function campaignName(id) {
        const c = campaigns.find((x) => x.id === id);
        return c ? c.data.name : '';
    }

    /* ------------------------------- vista: crea ------------------------------- */

    function createHTML() {
        const p = editingId ? posts.find((x) => x.id === editingId) : null;
        const d = p ? p.data : {};
        const copy = d.copy || {};
        const plats = d.platforms || [];
        const campOpts = ['<option value="">— nessuna campagna —</option>']
            .concat(campaigns.map((c) =>
                `<option value="${esc(c.id)}"${d.campaignId === c.id ? ' selected' : ''}>${esc(c.data.name)}</option>`))
            .join('');
        return `
        <div class="adm-panel-head">
            <div>
                <h2>Social — Crea</h2>
                <p class="adm-panel-lead">Un brief, tutti i formati: l'IA propone i testi per Facebook, Instagram, WhatsApp e TikTok; tu scegli l'immagine base e produci ritagli e reel da scaricare e pubblicare a mano sulle piattaforme. Salvando, il post va in <strong>Campagna</strong> con data e stato; gli asset restano in <strong>Galleria</strong>.</p>
            </div>
        </div>
        <div class="adm-form">
            <div class="adm-form-title">${editingId ? 'Modifica post' : 'Nuovo post'}</div>
            <div class="adm-row">
                <div class="adm-group">
                    <label for="socTitle">Titolo interno <span class="adm-tip" tabindex="0" data-tip="Serve a riconoscere il post qui dentro: non viene pubblicato. Lo slug (nome semplificato) diventa il nome campagna nei link UTM.">?</span></label>
                    <input id="socTitle" type="text" value="${esc(d.title || '')}" placeholder="Es. Apertura stagione — teaser">
                </div>
                <div class="adm-group">
                    <label for="socCampaign">Campagna <span class="adm-tip" tabindex="0" data-tip="Raggruppa i post nella vista Campagna. Le nuove campagne si creano nella vista Campagna stessa.">?</span></label>
                    <select id="socCampaign">${campOpts}</select>
                </div>
            </div>
            <div class="adm-group">
                <label for="socBrief">Brief del contenuto <span class="adm-tip" tabindex="0" data-tip="Descrivi cosa vuoi comunicare: cosa succede, quando, perché venire. Il bottone ✨ lo trasforma in 4 testi pronti (uno per piattaforma) che poi puoi modificare.">?</span></label>
                <textarea id="socBrief" rows="3" placeholder="Es. Venerdì 3 ottobre riapriamo: live dei Radiofonic, taglieri e birra della casa in lancio, ingresso libero dalle 19">${esc(d.brief || '')}</textarea>
            </div>
            <div class="adm-group">
                <span class="adm-label-row">
                    <label>Piattaforme</label>
                </span>
                <div class="adm-checks">
                    ${Object.entries(SOC_PLATFORMS).map(([k, label]) => `
                    <label class="adm-check"><input type="checkbox" class="soc-plat" value="${k}" ${plats.includes(k) ? 'checked' : ''}> ${label}</label>`).join('')}
                </div>
            </div>
            <div class="adm-group">
                <div class="adm-label-row">
                    <label>Testi per piattaforma <span class="adm-tip" tabindex="0" data-tip="Gemini scrive una bozza per piattaforma dal brief (hashtag su IG/TT, tono diretto su WA). Modificabili liberamente prima di salvare.">?</span></label>
                    <button type="button" id="socCopyBtn" class="adm-btn adm-btn-ghost adm-btn-sm adm-btn-ai"
                        title="Proponi i 4 testi con l'IA">✨ Proponi testi con IA</button>
                </div>
                <div class="adm-soc-copy">
                    ${Object.entries(SOC_PLATFORMS).map(([k, label]) => `
                    <div class="adm-soc-copy-item">
                        <label for="socCopy_${k}">${label}</label>
                        <textarea id="socCopy_${k}" rows="3">${esc(copy[k] || '')}</textarea>
                        <button type="button" class="adm-btn adm-btn-ghost adm-btn-sm" data-soc-action="copy-text" data-plat="${k}">Copia testo</button>
                    </div>`).join('')}
                </div>
                <span id="socCopyStatus" class="adm-cell-muted" role="status"></span>
            </div>

            <div class="adm-group">
                <label>Immagine base <span class="adm-tip" tabindex="0" data-tip="Da qui nascono i ritagli 16:9 / 1:1 / 9:16 e il reel animato. Generata con IA, caricata dal computer o ripresa dalla Galleria.">?</span></label>
                ${aiImageBlockHTML('soc', d.brief || '')}
                <div class="adm-ai-img-actions">
                    <input id="socUpload" type="file" accept="image/*">
                    <span id="socUploadStatus" class="adm-cell-muted" role="status"></span>
                </div>
                <div id="socBasePreview" class="adm-soc-base" hidden>
                    <img id="socBaseImg" alt="Immagine base">
                    <span id="socBaseLabel" class="adm-cell-muted"></span>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-soc-action="edit-base" type="button"
                        title="Apri l'editor: aggiungi logo, asset grafici e testi">✏️ Logo/Testi</button>
                </div>
            </div>

            <div class="adm-group" id="socCropsBlock" hidden>
                <label>Ritagli pronti <span class="adm-tip" tabindex="0" data-tip="Ritaglio centrale automatico nei tre formati social. «Scarica» salva il file sul computer; «Salva in galleria» lo conserva su Storage per riusarlo dopo.">?</span></label>
                <div id="socCrops" class="adm-soc-crops"></div>
            </div>

            <div class="adm-group" id="socReelBlock" hidden>
                <label>Reel verticale 8 secondi <span class="adm-tip" tabindex="0" data-tip="Due strade: reel animato fatto dal browser (gratis, formato webm — per IG/TikTok conviene il video IA o una conversione in mp4) oppure video vero generato da Veo 3.1 Fast (Google): circa 1,50 € a video, addebitati sul progetto. Con ✏️ Editor aggiungi logo e testi animati a entrambi.">?</span></label>
                <div class="adm-row">
                    <div class="adm-group">
                        <button type="button" id="socReelWebmBtn" class="adm-btn adm-btn-ghost">🎞 Reel animato (gratis, .webm)</button>
                        <div class="adm-cell-note">Zoom cinematografico sulla tua immagine con titolo e logo. Attendi ~10 s.</div>
                    </div>
                    <div class="adm-group">
                        <button type="button" id="socReelVeoBtn" class="adm-btn adm-btn-ghost adm-btn-ai">🎬 Video IA Veo 8s — costo ≈ 1,50 €</button>
                        <div class="adm-cell-note">Video vero da descrizione + immagine base come primo frame. Max 4 video/ora. Attendi 1-3 min.</div>
                        <input id="socVeoPrompt" type="text" placeholder="Movimento del video, es: camera lenta sul bancone con spillatura della birra">
                    </div>
                </div>
                <div class="adm-row">
                    <div class="adm-group">
                        <label for="socVideoUpload">oppure carica un video tuo (mp4, max 50 MB)</label>
                        <input id="socVideoUpload" type="file" accept="video/*">
                    </div>
                </div>
                <span id="socReelStatus" class="adm-cell-muted" role="status"></span>
                <div id="socReels" class="adm-soc-crops"></div>
            </div>

            <div class="adm-row">
                <div class="adm-group">
                    <label for="socScheduled">Pubblicazione prevista <span class="adm-tip" tabindex="0" data-tip="Data e ora in cui intendi pubblicare: la vista Campagna li usa per ordinare la programmazione. La pubblicazione vera resta manuale sulle piattaforme.">?</span></label>
                    <input id="socScheduled" type="datetime-local" value="${esc(d.scheduledFor || '')}">
                </div>
                <div class="adm-group">
                    <label for="socStatus">Stato</label>
                    <select id="socStatus">
                        ${Object.entries(SOC_STATUSES).map(([k, label]) =>
                            `<option value="${k}"${(d.status || 'draft') === k ? ' selected' : ''}>${label}</option>`).join('')}
                    </select>
                </div>
            </div>
            <div id="socErr" class="adm-inline-err" hidden></div>
            <div class="adm-form-actions">
                <button class="adm-btn" type="button" id="socSaveBtn">${editingId ? 'Salva modifiche' : 'Salva post in campagna'}</button>
                ${editingId ? '<button class="adm-btn adm-btn-ghost" type="button" data-soc-action="new-post">Annulla modifica</button>' : ''}
            </div>
        </div>`;
    }

    /* ----------------------------- vista: campagna ----------------------------- */

    function campagnaHTML() {
        const campRows = campaigns.map((c) => `
            <div class="adm-card${c.data.status === 'archived' ? ' inactive' : ''}">
                <div class="adm-card-main">
                    <div class="adm-card-title">${esc(c.data.name)}</div>
                    <div class="adm-card-sub">${c.data.status === 'archived' ? 'Archiviata' : 'Attiva'}${auditBy(c.data)}</div>
                </div>
                <div class="adm-card-actions">
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-soc-action="toggle-campaign" data-id="${esc(c.id)}" type="button">
                        ${c.data.status === 'archived' ? 'Riattiva' : 'Archivia'}</button>
                </div>
            </div>`).join('');

        const sorted = posts.slice().sort((a, b) =>
            String(a.data.scheduledFor || '9999').localeCompare(String(b.data.scheduledFor || '9999')));
        const postRows = sorted.map((p) => {
            const d = p.data;
            const slug = socSlug(d.title);
            const sessions = gaCampaignSessions && gaCampaignSessions[slug] != null
                ? gaCampaignSessions[slug] : null;
            const stats = d.manualStats || {};
            const plats = (d.platforms || []).map((k) => SOC_PLATFORMS[k] || k).join(', ') || '—';
            const utmLinks = (d.platforms || []).map((k) => `
                <div class="adm-soc-utm">
                    <code>${esc(socUtmLink(k, slug))}</code>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-soc-action="copy-utm" data-plat="${k}" data-slug="${esc(slug)}" type="button">Copia link ${SOC_PLATFORMS[k]}</button>
                </div>`).join('');
            const assets = (d.assets || []).map((a) => `
                <span class="adm-soc-asset">
                    ${a.kind === 'video' ? '🎬' : '🖼'} ${esc(a.label)}
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-soc-action="download" data-url="${esc(a.url)}" data-label="${esc(a.label)}" type="button">Scarica</button>
                </span>`).join('');
            return `
            <div class="adm-card adm-card--post">
                <div class="adm-card-main">
                    <div class="adm-card-title">${d.scheduledFor ? '📅 ' + esc(new Date(d.scheduledFor).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) + ' — ' : ''}${esc(d.title || '(senza titolo)')}</div>
                    <div class="adm-card-sub">${campaignName(d.campaignId) ? esc(campaignName(d.campaignId)) + ' · ' : ''}${esc(plats)}${auditBy(d)}</div>
                    <div class="adm-soc-assets">${assets || '<span class="adm-cell-muted">Nessun asset salvato — aprilo in modifica dalla vista Crea.</span>'}</div>
                    ${utmLinks ? `<div class="adm-soc-utms">${utmLinks}</div>` : ''}
                    <div class="adm-soc-metrics">
                        <span class="adm-chip">GA4: ${sessions == null ? '—' : fmtNum(sessions) + ' sessioni'}</span>
                        <label>Visualizzazioni <input type="number" min="0" class="adm-input-sm" data-soc-stat="views" data-id="${esc(p.id)}" value="${esc(stats.views ?? '')}"></label>
                        <label>Interazioni <input type="number" min="0" class="adm-input-sm" data-soc-stat="likes" data-id="${esc(p.id)}" value="${esc(stats.likes ?? '')}"></label>
                        <span class="adm-cell-muted">I numeri GA4 arrivano dai link UTM (serve il ${sessions == null ? 'collegamento GA attivo' : 'link pubblicato'}); visualizzazioni e interazioni le annoti tu dalle app.</span>
                    </div>
                </div>
                <div class="adm-card-actions">
                    <select data-soc-action="status" data-id="${esc(p.id)}" class="adm-input-sm">
                        ${Object.entries(SOC_STATUSES).map(([k, label]) =>
                            `<option value="${k}"${d.status === k ? ' selected' : ''}>${label}</option>`).join('')}
                    </select>
                    ${(d.platforms || []).includes('wa') && d.copy && d.copy.wa
                        ? `<a class="adm-btn adm-btn-ghost adm-btn-sm" href="https://wa.me/?text=${encodeURIComponent(d.copy.wa)}" target="_blank" rel="noopener">Invia su WA</a>` : ''}
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-soc-action="edit" data-id="${esc(p.id)}" type="button">Modifica</button>
                    <button class="adm-btn adm-btn-danger adm-btn-sm" data-soc-action="delete" data-id="${esc(p.id)}" type="button">Elimina</button>
                </div>
            </div>`;
        }).join('');

        return `
        <div class="adm-panel-head">
            <div>
                <h2>Social — Campagna</h2>
                <p class="adm-panel-lead">La programmazione: cosa esce, quando e dove. Per ogni post trovi i <strong>link con UTM</strong> da incollare nelle pubblicazioni (le visite che portano si leggono sotto «GA4»), i download degli asset e i campi per annotare visualizzazioni/interazioni.</p>
            </div>
        </div>
        <form id="socCampForm" class="adm-form" novalidate>
            <div class="adm-form-title">Nuova campagna</div>
            <div class="adm-row">
                <div class="adm-group">
                    <label for="socCampName">Nome campagna</label>
                    <input id="socCampName" type="text" required placeholder="Es. Apertura stagione 2026">
                </div>
            </div>
            <div class="adm-form-actions">
                <button class="adm-btn adm-btn-ghost" type="submit">+ Crea campagna</button>
            </div>
        </form>
        <h3 class="adm-subhead">Campagne</h3>
        <div class="adm-list">${campRows || '<div class="adm-empty">Nessuna campagna: creane una qui sopra.</div>'}</div>
        <h3 class="adm-subhead">Programmazione (${posts.length} post)</h3>
        <div class="adm-list">${postRows || '<div class="adm-empty">Nessun post ancora. Crealo dalla vista Crea.</div>'}</div>`;
    }

    /* ----------------------------- vista: galleria ----------------------------- */

    function galleriaHTML() {
        const seen = new Set();
        const assets = [];
        posts.forEach((p) => {
            (p.data.assets || []).forEach((a) => {
                if (a && a.url && !seen.has(a.url)) {
                    seen.add(a.url);
                    assets.push({ ...a, postTitle: p.data.title || '' });
                }
            });
            if (p.data.baseImageUrl && !seen.has(p.data.baseImageUrl)) {
                seen.add(p.data.baseImageUrl);
                assets.push({ kind: 'image', label: 'immagine base', url: p.data.baseImageUrl, postTitle: p.data.title || '' });
            }
        });
        const cells = assets.map((a) => `
            <div class="adm-gal-cell">
                ${a.kind === 'video'
                    ? `<video src="${esc(a.url)}" controls muted playsinline></video>`
                    : `<img src="${esc(a.url)}" alt="${esc(a.label)}" loading="lazy">`}
                <div class="adm-gal-meta">
                    <span>${esc(a.label)}${a.postTitle ? ' · ' + esc(a.postTitle) : ''}</span>
                </div>
                <div class="adm-gal-actions">
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-soc-action="download" data-url="${esc(a.url)}" data-label="${esc(a.label)}" type="button">Scarica</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-soc-action="open-editor" data-url="${esc(a.url)}" data-kind="${a.kind === 'video' ? 'video' : 'image'}" type="button">✏️ Editor</button>
                    ${a.kind === 'image'
                        ? `<button class="adm-btn adm-btn-ghost adm-btn-sm" data-soc-action="reuse" data-url="${esc(a.url)}" type="button">Riusa come base</button>` : ''}
                </div>
            </div>`).join('');
        return `
        <div class="adm-panel-head">
            <div>
                <h2>Social — Galleria</h2>
                <p class="adm-panel-lead">Tutti gli asset prodotti (immagini, ritagli, reel). Scaricali per pubblicarli o riusa un'immagine come base di un nuovo post.</p>
            </div>
        </div>
        <div class="adm-gallery">${cells || '<div class="adm-empty">Ancora nessun asset. Genera immagini e reel dalla vista Crea.</div>'}</div>`;
    }

    /* ----------------------------- vista: asset grafici ----------------------------- */

    // Libreria riutilizzabile per l'editor (logo, sticker, cornici): file su
    // Storage social/gfx/, metadati in graphicAssets/ (solo admin, vedi rules).
    let gfxAssets = null; // cache on-demand: [{ id, data }]

    async function loadGfxAssets(force) {
        if (gfxAssets && !force) return;
        try {
            const snap = await getDocs(query(collection(db, 'graphicAssets'), orderBy('name')));
            gfxAssets = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
        } catch (err) {
            console.error('[admin] graphicAssets load error:', err);
            toast('Libreria asset non caricabile: ' + (err.code || err.message), true);
            if (!gfxAssets) gfxAssets = [];
        }
    }

    function gfxListHTML() {
        if (!gfxAssets) return '<div class="adm-empty">Caricamento libreria…</div>';
        if (!gfxAssets.length) {
            return '<div class="adm-empty">Libreria vuota: carica il logo e gli altri elementi grafici qui sopra. Ideali PNG/SVG con sfondo trasparente.</div>';
        }
        return gfxAssets.map((a) => `
            <div class="adm-gal-cell adm-gfx-cell">
                <span class="adm-gfx-preview"><img src="${esc(a.data.url)}" alt="${esc(a.data.name || '')}" loading="lazy"></span>
                <input class="adm-input-sm adm-gfx-name" data-gfx-name="${esc(a.id)}" value="${esc(a.data.name || '')}">
                <div class="adm-gal-actions">
                    <button class="adm-btn adm-btn-danger adm-btn-sm" data-soc-action="gfx-delete" data-id="${esc(a.id)}" type="button">Elimina</button>
                </div>
            </div>`).join('');
    }

    function assetHTML() {
        return `
        <div class="adm-panel-head">
            <div>
                <h2>Social — Asset grafici</h2>
                <p class="adm-panel-lead">Libreria riutilizzabile dell'<strong>editor media</strong>: logo, sticker, cornici, badge. Caricali una volta e li trovi pronti da sovrapporre a qualunque immagine o video (pulsante ✏️ Editor). Ideali PNG/SVG con sfondo trasparente.</p>
            </div>
        </div>
        <div class="adm-form">
            <div class="adm-form-title">Nuovo asset grafico</div>
            <div class="adm-row">
                <div class="adm-group">
                    <label for="gfxName">Nome</label>
                    <input id="gfxName" type="text" maxlength="60" placeholder="Es. Logo oro">
                </div>
                <div class="adm-group">
                    <label for="gfxUpload">File (PNG, SVG o WebP, max 3 MB)</label>
                    <input id="gfxUpload" type="file" accept="image/png,image/svg+xml,image/webp">
                    <span id="gfxStatus" class="adm-cell-muted" role="status"></span>
                </div>
            </div>
        </div>
        <h3 class="adm-subhead">Libreria (${gfxAssets ? gfxAssets.length : '…'})</h3>
        <div id="gfxList" class="adm-gallery">${gfxListHTML()}</div>`;
    }

    async function onGfxUpload(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const st = $('gfxStatus');
        if (!/^image\/(png|svg\+xml|webp)$/.test(file.type)) { toast('Formato non supportato: usa PNG, SVG o WebP.', true); return; }
        if (file.size > 3 * 1024 * 1024) { toast('File troppo grande (max 3 MB).', true); return; }
        try {
            st.textContent = 'Carico…';
            const storage = await getStorageInstance();
            const name = ($('gfxName').value.trim() || file.name.replace(/\.[a-z0-9]+$/i, '')).slice(0, 60);
            const ext = file.type === 'image/svg+xml' ? '.svg' : file.type === 'image/webp' ? '.webp' : '.png';
            const path = 'social/gfx/' + socSlug(name) + '-' + Date.now() + ext;
            await uploadBytes(storageRef(storage, path), file, { contentType: file.type });
            const url = await getDownloadURL(storageRef(storage, path));
            await addDoc(collection(db, 'graphicAssets'), { name, url, path, ...auditCreate() });
            gfxAssets = null;
            st.textContent = 'Caricato ✓';
            toast('Asset aggiunto alla libreria.');
            render();
        } catch (err) {
            console.error('[admin] gfx upload error:', err);
            st.textContent = 'Upload non riuscito: ' + (err.code || err.message);
        }
    }

    /* ----------------------------- editor media (logo + testi) ----------------------------- */

    // Layer sovrapposti a immagine o video. Coordinate/dimensioni in frazione
    // del canvas (centro del layer) → l'export resta corretto a ogni risoluzione.
    // Effetti animati solo su base video; su immagine l'export usa lo stato finale.
    // Tutto client-side (canvas + drawImage + MediaRecorder): zero costi server.
    const ED_EFFECTS = { none: 'Nessuno', fade: 'Comparsa', rise: 'Salita dal basso', pop: 'Zoom-pop', type: 'Macchina da scrivere' };
    const ED_FONTS = { display: '"Space Grotesk", sans-serif', body: '"Inter", sans-serif' };

    let ed = null; // sessione: { baseUrl, baseKind, returnView, onSaved, media, W, H, layers, selId, drag, preview, saving, exporting }

    // onSaved(asset) opzionale: usata dalla tab Marketing (wizard) per ricevere
    // subito l'asset editato anche se il post non è ancora stato salvato.
    // returnView '__marketing' = alla chiusura si torna alla tab Marketing.
    function openEditor(url, kind, returnView, onSaved) {
        edCleanup();
        ed = {
            baseUrl: url, baseKind: kind, returnView: returnView || 'create',
            onSaved: typeof onSaved === 'function' ? onSaved : null,
            media: null, W: 0, H: 0, layers: [], selId: null,
            drag: null, preview: null, saving: false, exporting: false,
        };
        view = 'editor';
        render();
    }

    // Ponte per la tab Marketing: apre l'editor qui (tab Social) e al Chiudi
    // riporta l'utente alla tab Marketing con l'asset salvato consegnato via callback.
    marketingBridge.openEditor = (url, kind, onSaved) => {
        const tabBtn = els.tabs.querySelector('.adm-tab[data-tab="social"]');
        if (tabBtn) tabBtn.click();
        openEditor(url, kind, '__marketing', onSaved);
    };

    function edCleanup() {
        if (!ed) return;
        if (ed.preview) cancelAnimationFrame(ed.preview);
        if (ed.media && ed.media.tagName === 'VIDEO') { try { ed.media.pause(); } catch (e) { /* noop */ } }
        ed = null;
    }

    function editorHTML() {
        if (!ed) return '';
        const isVideo = ed.baseKind === 'video';
        return `
        <div class="adm-panel-head">
            <div>
                <h2>Editor — ${isVideo ? 'video' : 'immagine'}</h2>
                <p class="adm-panel-lead">Aggiungi <strong>asset grafici dalla libreria</strong> e <strong>testi</strong>, poi trascinali dove vuoi sull'anteprima. ${isVideo ? 'Assegna un effetto di entrata a ogni layer e guarda l\'anteprima animata: il salvataggio registra un video .webm con tutto incorporato (gratis, registrato dal browser).' : 'Il salvataggio esporta un PNG ad alta risoluzione.'} Il risultato finisce in <strong>Galleria</strong> e si collega al post quando lo salvi.</p>
            </div>
            <button class="adm-btn adm-btn-ghost" data-soc-action="close-editor" type="button">✕ Chiudi editor</button>
        </div>
        <div class="adm-editor">
            <div class="adm-ed-stage">
                <canvas id="edCanvas"></canvas>
                <div class="adm-cell-muted">Trascina i layer dove vuoi · clicca un layer per modificarlo nel pannello</div>
            </div>
            <div class="adm-ed-panel">
                <div class="adm-form-title">Aggiungi</div>
                <div class="adm-ed-add">
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" id="edAddText" type="button">🔤 Testo</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" id="edAddGfx" type="button">🧩 Asset dalla libreria</button>
                </div>
                <div id="edGfxPicker" class="adm-ed-picker" hidden></div>
                <div class="adm-form-title">Layer <span id="edLayerCount"></span></div>
                <div id="edLayers" class="adm-ed-layers"><div class="adm-empty">Preparo l'editor…</div></div>
                <div id="edSelPanel"></div>
                <div class="adm-ed-actions">
                    ${isVideo ? '<button class="adm-btn adm-btn-ghost adm-btn-sm" id="edPreviewBtn" type="button">▶️ Anteprima animata</button>' : ''}
                    <button class="adm-btn" id="edSaveBtn" type="button">${isVideo ? '💾 Registra e salva (.webm)' : '💾 Salva PNG in galleria'}</button>
                    <span id="edStatus" class="adm-cell-muted" role="status"></span>
                </div>
            </div>
        </div>`;
    }

    function edNewId() {
        return 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    // Misure di un layer in pixel canvas [w, h] (testo misurato col font reale)
    function edLayerSize(l, W, H) {
        if (l.type === 'gfx') {
            const ar = l.img && l.img.naturalWidth ? l.img.naturalHeight / l.img.naturalWidth : 1;
            const w = l.w * W;
            return [w, w * ar];
        }
        const fs = l.size * W;
        const mctx = document.createElement('canvas').getContext('2d');
        mctx.font = (l.weight === '700' ? '700 ' : '400 ') + fs + 'px ' + (ED_FONTS[l.font] || ED_FONTS.display);
        let maxW = fs;
        const lines = String(l.text || 'Testo').split('\n');
        lines.forEach((ln) => { maxW = Math.max(maxW, mctx.measureText(ln).width); });
        return [maxW, fs * 1.25 * lines.length];
    }

    // Stato di animazione di un layer al tempo tMs (null = stato finale)
    function edLayerFx(l, idx, tMs) {
        const st = { alpha: 1, dy: 0, scale: 1, chars: Infinity };
        if (tMs == null || ed.baseKind !== 'video' || !l.effect || l.effect === 'none') return st;
        const start = 400 + idx * 700; // entrata scalare per ordine layer
        const c = Math.max(0, Math.min(1, (tMs - start) / 500));
        const ease = 1 - Math.pow(1 - c, 3);
        if (l.effect === 'fade') {
            st.alpha = ease;
        } else if (l.effect === 'rise') {
            st.alpha = ease;
            st.dy = (1 - ease) * 0.08;
        } else if (l.effect === 'pop') {
            st.alpha = c;
            st.scale = 0.3 + 0.7 * ease;
        } else if (l.effect === 'type') {
            if (tMs < start) { st.chars = 0; } else {
                const total = String(l.text || '').length;
                st.chars = Math.floor(total * Math.min(1, (tMs - start) / Math.max(700, total * 45)));
            }
        }
        return st;
    }

    function edDrawLayer(ctx, l, idx, W, H, tMs) {
        const fx = edLayerFx(l, idx, tMs);
        if (fx.alpha <= 0) { if (fx.chars === Infinity) return; }
        ctx.save();
        ctx.globalAlpha = fx.alpha;
        ctx.translate(l.x * W, (l.y + fx.dy) * H);
        ctx.rotate((l.rot * Math.PI) / 180);
        if (l.type === 'gfx') {
            const size = edLayerSize(l, W, H);
            const w = size[0] * fx.scale;
            const h = size[1] * fx.scale;
            ctx.drawImage(l.img, -w / 2, -h / 2, w, h);
        } else {
            const fs = l.size * fx.scale * W;
            ctx.font = (l.weight === '700' ? '700 ' : '400 ') + fs + 'px ' + (ED_FONTS[l.font] || ED_FONTS.display);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const lines = String(l.text || 'Testo').split('\n');
            let budget = fx.chars; // typewriter: caratteri totali mostrati
            const lh = fs * 1.25;
            const y0 = -((lines.length - 1) * lh) / 2;
            lines.forEach((ln, li) => {
                let shown = ln;
                if (budget !== Infinity) {
                    shown = ln.slice(0, Math.max(0, Math.min(ln.length, budget)));
                    budget -= ln.length;
                }
                if (!shown) return;
                if (l.outline !== false) {
                    ctx.lineWidth = Math.max(1.5, fs / 10);
                    ctx.lineJoin = 'round';
                    ctx.strokeStyle = 'rgba(16,12,8,0.9)';
                    ctx.strokeText(shown, 0, y0 + li * lh);
                }
                ctx.fillStyle = l.color || '#f5efe4';
                ctx.fillText(shown, 0, y0 + li * lh);
            });
        }
        ctx.restore();
    }

    // Frame completo: base in "contain" su sfondo scuro + tutti i layer.
    // tMs === null → stato finale (editing ed export immagine; il bordo di
    // selezione si vede solo qui, mai in anteprima video o export).
    function edDrawFrame(ctx, tMs, W, H) {
        ctx.fillStyle = '#141210';
        ctx.fillRect(0, 0, W, H);
        const m = ed.media;
        if (m) {
            const mw = ed.baseKind === 'video' ? (m.videoWidth || W) : (m.naturalWidth || W);
            const mh = ed.baseKind === 'video' ? (m.videoHeight || H) : (m.naturalHeight || H);
            const sc = Math.min(W / mw, H / mh);
            ctx.drawImage(m, (W - mw * sc) / 2, (H - mh * sc) / 2, mw * sc, mh * sc);
        }
        ed.layers.forEach((l, i) => edDrawLayer(ctx, l, i, W, H, tMs));
        if (tMs === null && !ed.exporting && ed.selId) {
            const l = ed.layers.find((x) => x.id === ed.selId);
            if (l) {
                const size = edLayerSize(l, W, H);
                ctx.save();
                ctx.translate(l.x * W, l.y * H);
                ctx.rotate((l.rot * Math.PI) / 180);
                ctx.strokeStyle = '#d9a441';
                ctx.lineWidth = Math.max(2, W * 0.004);
                ctx.setLineDash([W * 0.012, W * 0.009]);
                ctx.strokeRect(-size[0] / 2 - 6, -size[1] / 2 - 6, size[0] + 12, size[1] + 12);
                ctx.restore();
            }
        }
    }

    function edDrawFinal() {
        if (!ed) return;
        const canvas = $('edCanvas');
        if (!canvas || !canvas.width) return;
        edDrawFrame(canvas.getContext('2d'), null, ed.W, ed.H);
    }

    function edHitTest(px, py) {
        for (let i = ed.layers.length - 1; i >= 0; i--) {
            const l = ed.layers[i];
            const cx = l.x * ed.W;
            const cy = l.y * ed.H;
            const rad = (-l.rot * Math.PI) / 180;
            const dx = px - cx;
            const dy = py - cy;
            const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
            const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
            const size = edLayerSize(l, ed.W, ed.H);
            if (Math.abs(lx) <= size[0] / 2 + 4 && Math.abs(ly) <= size[1] / 2 + 4) return l;
        }
        return null;
    }

    function edPaintLayersUI() {
        const box = $('edLayers');
        if (!box || !ed) return;
        const cnt = $('edLayerCount');
        if (cnt) cnt.textContent = ed.layers.length ? '(' + ed.layers.length + ')' : '';
        box.innerHTML = ed.layers.length
            ? ed.layers.map((l) => `
                <button type="button" class="adm-ed-layer${l.id === ed.selId ? ' active' : ''}" data-ed-sel="${l.id}">
                    ${l.type === 'gfx' ? '🧩' : '🔤'} ${esc(l.type === 'gfx' ? (l.label || 'asset') : (l.text || 'Testo').replace(/\n/g, ' ').slice(0, 24))}
                    ${ed.baseKind === 'video' && l.effect && l.effect !== 'none' ? ' <span class="adm-chip">' + esc(ED_EFFECTS[l.effect]) + '</span>' : ''}
                </button>`).join('')
            : '<div class="adm-cell-muted">Nessun layer: aggiungi un testo o un asset qui sopra.</div>';
        edPaintSelPanel();
    }

    function edPaintSelPanel() {
        const box = $('edSelPanel');
        if (!box) return;
        const l = ed && ed.layers.find((x) => x.id === ed.selId);
        if (!l) { box.innerHTML = ''; return; }
        const isVideo = ed.baseKind === 'video';
        const effectOpts = Object.entries(ED_EFFECTS)
            .filter(([k]) => l.type === 'text' || k !== 'type')
            .map(([k, label]) => `<option value="${k}"${(l.effect || 'none') === k ? ' selected' : ''}>${label}</option>`).join('');
        box.innerHTML = `
            <div class="adm-form-title">Layer selezionato</div>
            ${l.type === 'text' ? `
            <div class="adm-group"><label>Testo</label><textarea id="edTxtText" rows="2">${esc(l.text)}</textarea></div>
            <div class="adm-row">
                <div class="adm-group"><label>Grandezza <span class="adm-cell-muted">${Math.round(l.size * 100)}%</span></label>
                    <input id="edTxtSize" type="range" min="20" max="160" value="${Math.round(l.size * 1000)}"></div>
                <div class="adm-group"><label>Colore</label><input id="edTxtColor" type="color" value="${esc(l.color || '#f5efe4')}"></div>
            </div>
            <div class="adm-row">
                <div class="adm-group"><label>Font</label><select id="edTxtFont">
                    <option value="display"${(l.font || 'display') === 'display' ? ' selected' : ''}>Space Grotesk (brand)</option>
                    <option value="body"${l.font === 'body' ? ' selected' : ''}>Inter</option>
                </select></div>
                <div class="adm-group"><label>Grassetto</label><select id="edTxtWeight">
                    <option value="700"${l.weight === '700' ? ' selected' : ''}>Sì</option>
                    <option value="400"${l.weight !== '700' ? ' selected' : ''}>No</option>
                </select></div>
            </div>
            <div class="adm-checks"><label class="adm-check"><input id="edTxtOutline" type="checkbox"${l.outline !== false ? ' checked' : ''}> Contorno scuro (leggibilità su foto)</label></div>
            ` : `
            <div class="adm-group"><label>Dimensione <span class="adm-cell-muted">${Math.round(l.w * 100)}% della larghezza</span></label>
                <input id="edGfxSize" type="range" min="5" max="90" value="${Math.round(l.w * 100)}"></div>
            `}
            <div class="adm-group"><label>Rotazione <span class="adm-cell-muted">${Math.round(l.rot)}°</span></label>
                <input id="edRot" type="range" min="-180" max="180" value="${Math.round(l.rot)}"></div>
            ${isVideo ? `<div class="adm-group"><label>Effetto di entrata</label><select id="edEffect">${effectOpts}</select></div>` : ''}
            <div class="adm-ed-layer-actions">
                <button class="adm-btn adm-btn-ghost adm-btn-sm" data-ed-order="up" type="button">↑ Sopra</button>
                <button class="adm-btn adm-btn-ghost adm-btn-sm" data-ed-order="down" type="button">↓ Sotto</button>
                <button class="adm-btn adm-btn-danger adm-btn-sm" data-ed-delete="1" type="button">🗑 Elimina layer</button>
            </div>`;
    }

    async function edUpload(blob, contentType, ext, st) {
        st.textContent = 'Carico in galleria…';
        const storage = await getStorageInstance();
        let base = 'grafica';
        if (editingId) {
            const p = posts.find((x) => x.id === editingId);
            if (p && p.data.title) base = p.data.title;
        }
        const path = 'social/edit-' + socSlug(base) + '-' + Date.now() + ext;
        await uploadBytes(storageRef(storage, path), blob, { contentType });
        const url = await getDownloadURL(storageRef(storage, path));
        return { url, path };
    }

    async function edSaveImage(st) {
        st.textContent = 'Esporto il PNG…';
        const out = document.createElement('canvas');
        out.width = ed.W;
        out.height = ed.H;
        ed.exporting = true; // niente bordo selezione nell'export
        edDrawFrame(out.getContext('2d'), null, ed.W, ed.H);
        ed.exporting = false;
        const blob = await new Promise((res, rej) =>
            out.toBlob((b) => (b ? res(b) : rej(new Error('export vuoto'))), 'image/png'));
        const saved = await edUpload(blob, 'image/png', '.png', st);
        const asset = { kind: 'image', label: 'grafica editor (png)', url: saved.url, path: saved.path };
        pendingAssets.push(asset);
        if (ed.onSaved) { try { ed.onSaved(asset); } catch (e) { console.error('[admin] onSaved editor:', e); } }
        st.textContent = 'PNG salvato ✓ in galleria (si collega al post quando lo salvi).';
        toast('Grafica salvata in galleria.');
    }

    async function edSaveVideo(st) {
        const v = ed.media;
        if (ed.preview) {
            cancelAnimationFrame(ed.preview);
            ed.preview = null;
            const pb = $('edPreviewBtn');
            if (pb) pb.textContent = '▶️ Anteprima animata';
        }
        v.pause();
        v.loop = false;
        const dur = Math.min(v.duration || 8, 15); // cap di sicurezza 15s
        st.textContent = 'Registro il video con le sovrapposizioni…';
        const out = document.createElement('canvas');
        out.width = ed.W;
        out.height = ed.H;
        const ctx = out.getContext('2d');
        const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9' : 'video/webm';
        const rec = new MediaRecorder(out.captureStream(30), { mimeType: mime, videoBitsPerSecond: 6000000 });
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        const stopped = new Promise((res) => { rec.onstop = () => res(); });
        try { v.currentTime = 0; } catch (e) { /* noop */ }
        await v.play();
        rec.start(250);
        await new Promise((resolve) => {
            const tick = () => {
                edDrawFrame(ctx, v.currentTime * 1000, ed.W, ed.H);
                st.textContent = 'Registro… ' + Math.min(100, Math.round((v.currentTime / dur) * 100)) + '%';
                if (v.ended || v.currentTime >= dur - 0.05) resolve();
                else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        rec.stop();
        await stopped;
        v.pause();
        const blob = new Blob(chunks, { type: 'video/webm' });
        if (!blob.size) throw new Error('registrazione vuota');
        const saved = await edUpload(blob, 'video/webm', '.webm', st);
        const asset = { kind: 'video', label: 'video editato (webm)', url: saved.url, path: saved.path };
        pendingAssets.push(asset);
        if (ed.onSaved) { try { ed.onSaved(asset); } catch (e) { console.error('[admin] onSaved editor:', e); } }
        st.textContent = 'Video salvato ✓ in galleria (si collega al post quando lo salvi). Nota: formato webm.';
        toast('Video salvato in galleria.');
        edDrawFinal();
    }

    async function initEditor() {
        if (!ed) return;
        const canvas = $('edCanvas');
        const st = $('edStatus');
        try {
            st.textContent = 'Carico la base…';
            if (ed.baseKind === 'video') {
                const v = document.createElement('video');
                v.crossOrigin = 'anonymous'; // senza CORS il canvas diventa "tainted" e l'export fallisce
                v.muted = true;
                v.playsInline = true;
                v.loop = true;
                v.preload = 'auto';
                v.src = ed.baseUrl;
                await new Promise((res, rej) => {
                    v.onloadeddata = res;
                    v.onerror = () => rej(new Error('video non caricabile (rete o CORS)'));
                });
                try { v.currentTime = 0; } catch (e) { /* noop */ }
                ed.media = v;
                const vw = v.videoWidth || 720;
                const vh = v.videoHeight || 1280;
                ed.W = Math.min(720, vw);
                ed.H = Math.round((ed.W * vh) / vw);
            } else {
                const img = await socLoadImage(ed.baseUrl);
                ed.media = img;
                const iw = img.naturalWidth || 1400;
                const ih = img.naturalHeight || iw;
                ed.W = Math.min(1400, iw);
                ed.H = Math.round((ed.W * ih) / iw);
            }
            canvas.width = ed.W;
            canvas.height = ed.H;
            st.textContent = '';
        } catch (err) {
            console.error('[admin] editor init error:', err);
            toast('Editor non apribile: ' + (err.code || err.message), true);
            const rv = ed.returnView;
            edCleanup();
            view = rv;
            render();
            return;
        }

        edDrawFinal();
        edPaintLayersUI();

        const canvasPoint = (e) => {
            const r = canvas.getBoundingClientRect();
            return [(e.clientX - r.left) * (ed.W / r.width), (e.clientY - r.top) * (ed.H / r.height)];
        };
        canvas.addEventListener('pointerdown', (e) => {
            if (!ed || ed.saving) return;
            const pt = canvasPoint(e);
            const hit = edHitTest(pt[0], pt[1]);
            ed.selId = hit ? hit.id : null;
            if (hit) {
                ed.drag = { id: hit.id, sx: pt[0], sy: pt[1], ox: hit.x, oy: hit.y };
                try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
            }
            edPaintLayersUI();
            edDrawFinal();
        });
        canvas.addEventListener('pointermove', (e) => {
            if (!ed || !ed.drag) return;
            const l = ed.layers.find((x) => x.id === ed.drag.id);
            if (!l) return;
            const pt = canvasPoint(e);
            l.x = Math.min(1.2, Math.max(-0.2, ed.drag.ox + (pt[0] - ed.drag.sx) / ed.W));
            l.y = Math.min(1.2, Math.max(-0.2, ed.drag.oy + (pt[1] - ed.drag.sy) / ed.H));
            edDrawFinal();
        });
        canvas.addEventListener('pointerup', () => { if (ed) ed.drag = null; });

        $('edAddText').addEventListener('click', () => {
            if (!ed) return;
            const id = edNewId();
            ed.layers.push({
                id, type: 'text', text: 'Scrivi qui', x: 0.5, y: 0.5, rot: 0,
                size: 0.06, color: '#f5efe4', weight: '700', outline: true, font: 'display',
                effect: ed.baseKind === 'video' ? 'rise' : 'none',
            });
            ed.selId = id;
            edPaintLayersUI();
            edDrawFinal();
        });

        $('edAddGfx').addEventListener('click', async () => {
            const box = $('edGfxPicker');
            if (!box) return;
            if (!box.hidden) { box.hidden = true; return; }
            box.hidden = false;
            box.innerHTML = '<div class="adm-cell-muted">Caricamento libreria…</div>';
            await loadGfxAssets();
            if (!box.isConnected || !ed) return;
            box.innerHTML = gfxAssets.length
                ? gfxAssets.map((a) => `
                    <button type="button" class="adm-ed-pick" data-ed-addgfx="${esc(a.id)}" title="${esc(a.data.name || '')}">
                        <img src="${esc(a.data.url)}" alt="${esc(a.data.name || '')}" loading="lazy">
                        <span>${esc(a.data.name || '')}</span>
                    </button>`).join('')
                : '<div class="adm-cell-muted">Libreria vuota: carica logo e grafiche nella vista 🧩 Asset.</div>';
        });
        $('edGfxPicker').addEventListener('click', async (e) => {
            const b = e.target.closest('[data-ed-addgfx]');
            if (!b || !ed) return;
            const a = gfxAssets.find((x) => x.id === b.dataset.edAddgfx);
            if (!a) return;
            try {
                const img = await socLoadImage(a.data.url);
                const id = edNewId();
                ed.layers.push({ id, type: 'gfx', label: a.data.name || 'asset', img, x: 0.5, y: 0.5, rot: 0, w: 0.3, effect: 'none' });
                ed.selId = id;
                $('edGfxPicker').hidden = true;
                edPaintLayersUI();
                edDrawFinal();
            } catch (err) {
                toast('Asset non caricabile: ' + err.message, true);
            }
        });

        $('edLayers').addEventListener('click', (e) => {
            const b = e.target.closest('[data-ed-sel]');
            if (!b || !ed) return;
            ed.selId = b.dataset.edSel;
            edPaintLayersUI();
            edDrawFinal();
        });

        $('edSelPanel').addEventListener('input', (e) => {
            if (!ed) return;
            const l = ed.layers.find((x) => x.id === ed.selId);
            if (!l) return;
            const t = e.target;
            if (t.id === 'edTxtText') l.text = t.value;
            else if (t.id === 'edTxtSize') l.size = Number(t.value) / 1000;
            else if (t.id === 'edTxtColor') l.color = t.value;
            else if (t.id === 'edTxtFont') l.font = t.value;
            else if (t.id === 'edTxtWeight') l.weight = t.value;
            else if (t.id === 'edTxtOutline') l.outline = t.checked;
            else if (t.id === 'edGfxSize') l.w = Number(t.value) / 100;
            else if (t.id === 'edRot') l.rot = Number(t.value);
            else if (t.id === 'edEffect') l.effect = t.value;
            else return;
            edDrawFinal();
        });
        $('edSelPanel').addEventListener('click', (e) => {
            if (!ed) return;
            const ord = e.target.closest('[data-ed-order]');
            const del = e.target.closest('[data-ed-delete]');
            if (!ord && !del) return;
            const i = ed.layers.findIndex((x) => x.id === ed.selId);
            if (i < 0) return;
            if (del) {
                ed.layers.splice(i, 1);
                ed.selId = null;
            } else if (ord.dataset.edOrder === 'up' && i < ed.layers.length - 1) {
                const tmp = ed.layers[i];
                ed.layers[i] = ed.layers[i + 1];
                ed.layers[i + 1] = tmp;
            } else if (ord.dataset.edOrder === 'down' && i > 0) {
                const tmp = ed.layers[i];
                ed.layers[i] = ed.layers[i - 1];
                ed.layers[i - 1] = tmp;
            }
            edPaintLayersUI();
            edDrawFinal();
        });

        const prevBtn = $('edPreviewBtn');
        if (prevBtn) prevBtn.addEventListener('click', () => {
            if (!ed || ed.baseKind !== 'video') return;
            const v = ed.media;
            if (ed.preview) {
                cancelAnimationFrame(ed.preview);
                ed.preview = null;
                v.pause();
                prevBtn.textContent = '▶️ Anteprima animata';
                edDrawFinal();
                return;
            }
            try { v.currentTime = 0; } catch (e) { /* noop */ }
            v.loop = true;
            v.play().then(() => {
                if (!ed) return;
                prevBtn.textContent = '⏹ Ferma anteprima';
                const tick = () => {
                    if (!ed || !ed.preview) return;
                    edDrawFrame(canvas.getContext('2d'), v.currentTime * 1000, ed.W, ed.H);
                    ed.preview = requestAnimationFrame(tick);
                };
                ed.preview = requestAnimationFrame(tick);
            }).catch((err) => {
                toast('Anteprima non avviabile: ' + (err.message || err), true);
            });
        });

        $('edSaveBtn').addEventListener('click', async () => {
            if (!ed || ed.saving) return;
            if (ed.preview) {
                cancelAnimationFrame(ed.preview);
                ed.preview = null;
                try { ed.media.pause(); } catch (e) { /* noop */ }
            }
            ed.saving = true;
            const btn = $('edSaveBtn');
            btn.disabled = true;
            try {
                if (ed.baseKind === 'video') await edSaveVideo(st);
                else await edSaveImage(st);
            } catch (err) {
                console.error('[admin] editor save error:', err);
                st.textContent = 'Salvataggio non riuscito: ' + (err.code || err.message);
                toast('Salvataggio non riuscito: ' + (err.code || err.message), true);
            } finally {
                ed.saving = false;
                ed.exporting = false;
                btn.disabled = false;
            }
        });
    }

    /* ------------------------------- render + stato ------------------------------- */

    function render() {
        panel.querySelectorAll('.adm-subtab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
        const body = $('socBody');
        if (!body) {
            panel.innerHTML = `
                <div class="adm-subtabs">
                    <button class="adm-subtab" data-view="create" type="button">✏️ Crea</button>
                    <button class="adm-subtab" data-view="campagna" type="button">📅 Campagna</button>
                    <button class="adm-subtab" data-view="galleria" type="button">🖼 Galleria</button>
                    <button class="adm-subtab" data-view="asset" type="button">🧩 Asset</button>
                </div>
                <div id="socBody"></div>`;
        }
        const target = $('socBody');
        target.innerHTML = view === 'create' ? createHTML()
            : view === 'campagna' ? campagnaHTML()
            : view === 'galleria' ? galleriaHTML()
            : view === 'asset' ? assetHTML()
            : editorHTML();
        if (view === 'create') {
            // ripristina immagine base e ritagli se già prodotti in questa sessione
            if (baseImageUrl) setBaseImage(baseImageUrl, true);
            $('socCopyBtn').addEventListener('click', onCopyAI);
            $('socSaveBtn').addEventListener('click', onSave);
            const genBtn = $('socAiGenBtn');
            if (genBtn) genBtn.addEventListener('click', () => runAiImage('soc', (url) => setBaseImage(url)));
            $('socUpload').addEventListener('change', onUploadImage);
            $('socReelWebmBtn') && $('socReelWebmBtn').addEventListener('click', onReelWebm);
            $('socReelVeoBtn') && $('socReelVeoBtn').addEventListener('click', onReelVeo);
            $('socVideoUpload') && $('socVideoUpload').addEventListener('change', onUploadVideo);
        }
        if (view === 'asset') {
            // IMPORTANTE: caricare SOLO a cache vuota. Se gfxAssets e' gia' valorizzata
            // loadGfxAssets() ritorna una promise gia' risolta: .then → render() →
            // .then → render() … = microtask loop infinito che CONGELA la pagina.
            if (!gfxAssets) loadGfxAssets().then(() => { if (view === 'asset') render(); });
            $('gfxUpload').addEventListener('change', onGfxUpload);
        }
        if (view === 'editor') {
            // evita doppia init se un render arriva da uno snapshot mentre edito
            if (!$('edCanvas').width) initEditor();
        }
        if (view === 'campagna') loadGaCampaigns();
    }

    function setBaseImage(url, silent) {
        baseImageUrl = url;
        const prev = $('socBasePreview');
        if (prev) {
            prev.hidden = false;
            $('socBaseImg').src = url;
            $('socBaseLabel').textContent = url.split('/o/')[1]
                ? decodeURIComponent(url.split('/o/')[1].split('?')[0])
                : url;
        }
        const cropsBlock = $('socCropsBlock');
        const reelBlock = $('socReelBlock');
        if (cropsBlock) cropsBlock.hidden = false;
        if (reelBlock) reelBlock.hidden = false;
        if (cropsBlock && !cropsBlock.dataset.ready) {
            cropsBlock.dataset.ready = '1';
            buildCrops(url).catch((err) => {
                console.warn('[admin] crops falliti:', err);
                toast('Ritagli non riusciti: ' + err.message, true);
            });
        }
        if (!silent) toast('Immagine base impostata.');
    }

    // Ritagli canvas nei 3 formati + anteprime con scarica / salva in galleria
    async function buildCrops(url) {
        const img = await socLoadImage(url);
        const box = $('socCrops');
        if (!box) return;
        box.innerHTML = '<div class="adm-empty">Preparo i ritagli…</div>';
        const out = [];
        for (const c of SOC_CROPS) {
            const blob = await socCropToBlob(img, c.w, c.h);
            const objUrl = URL.createObjectURL(blob);
            out.push({ ...c, blob, objUrl });
        }
        box.innerHTML = out.map((c, i) => `
            <div class="adm-soc-crop">
                <img src="${c.objUrl}" alt="${esc(c.label)}">
                <div class="adm-cell-muted">${esc(c.label)} (${c.w}×${c.h})</div>
                <div class="adm-gal-actions">
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-crop-dl="${i}" type="button">Scarica PNG</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-crop-save="${i}" type="button">Salva in galleria</button>
                </div>
            </div>`).join('');
        box.addEventListener('click', async (e) => {
            const dl = e.target.closest('[data-crop-dl]');
            const sv = e.target.closest('[data-crop-save]');
            if (!dl && !sv) return;
            const i = Number((dl || sv).dataset.cropDl ?? (dl || sv).dataset.cropSave);
            const c = out[i];
            const fname = 'fonderia-' + c.label.split(' ')[0] + '-' + socSlug($('socTitle').value || 'post') + '.png';
            if (dl) {
                const a = document.createElement('a');
                a.href = c.objUrl;
                a.download = fname;
                a.click();
            } else {
                sv.disabled = true;
                sv.textContent = '⏳ Salvo…';
                try {
                    const storage = await getStorageInstance();
                    const path = 'social/' + socSlug($('socTitle').value || 'post') + '-' + c.w + 'x' + c.h + '-' + Date.now() + '.png';
                    await uploadBytes(storageRef(storage, path), c.blob, { contentType: 'image/png' });
                    const savedUrl = await getDownloadURL(storageRef(storage, path));
                    pendingAssets.push({ kind: 'image', label: 'ritaglio ' + c.label.split(' — ')[0], url: savedUrl, path });
                    sv.textContent = '✓ In galleria';
                    toast('Ritaglio salvato in galleria (si collega al post quando salvi).');
                } catch (err) {
                    console.error('[admin] save crop error:', err);
                    sv.disabled = false;
                    sv.textContent = 'Salva in galleria';
                    toast('Salvataggio non riuscito: ' + (err.code || err.message), true);
                }
            }
        }, { once: false });
    }

    const pendingAssets = []; // asset prodotti dopo l'ultimo render di Crea

    async function onUploadImage(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const st = $('socUploadStatus');
        if (file.size > 3 * 1024 * 1024) { toast('Immagine troppo grande (max 3 MB).', true); return; }
        try {
            st.textContent = 'Carico…';
            const storage = await getStorageInstance();
            const path = 'social/upload-' + Date.now() + '-' + sanitizeFilename(file.name);
            await uploadBytes(storageRef(storage, path), file, { contentType: file.type });
            const url = await getDownloadURL(storageRef(storage, path));
            st.textContent = 'Caricata ✓';
            setBaseImage(url);
        } catch (err) {
            console.error('[admin] upload social image error:', err);
            st.textContent = 'Upload non riuscito: ' + (err.code || err.message);
        }
    }

    function reelEntryHTML(label, url, isVideo) {
        return `
        <div class="adm-soc-crop">
            ${isVideo ? `<video src="${esc(url)}" controls muted playsinline></video>` : `<img src="${esc(url)}" alt="${esc(label)}">`}
            <div class="adm-cell-muted">${esc(label)}</div>
            <div class="adm-gal-actions">
                <button class="adm-btn adm-btn-ghost adm-btn-sm" data-soc-action="download" data-url="${esc(url)}" data-label="${esc(label)}" type="button">Scarica</button>
                <button class="adm-btn adm-btn-ghost adm-btn-sm" data-soc-action="open-editor" data-url="${esc(url)}" data-kind="${isVideo ? 'video' : 'image'}" type="button">✏️ Editor</button>
            </div>
        </div>`;
    }

    async function onReelWebm() {
        if (!baseImageUrl) { toast('Prima scegli l’immagine base.', true); return; }
        const btn = $('socReelWebmBtn');
        const st = $('socReelStatus');
        btn.disabled = true;
        st.textContent = 'Registro l’animazione (circa 10 secondi)…';
        try {
            const img = await socLoadImage(baseImageUrl);
            const blob = await socRenderReel(img, $('socTitle').value || 'Fonderia Treviso');
            const storage = await getStorageInstance();
            const path = 'social/reel-webm-' + socSlug($('socTitle').value || 'post') + '-' + Date.now() + '.webm';
            await uploadBytes(storageRef(storage, path), blob, { contentType: 'video/webm' });
            const url = await getDownloadURL(storageRef(storage, path));
            pendingAssets.push({ kind: 'video', label: 'reel animato (webm)', url, path });
            $('socReels').insertAdjacentHTML('beforeend', reelEntryHTML('reel animato (webm)', url, true));
            st.textContent = 'Reel pronto ✓ scaricalo per pubblicarlo (salvato in galleria quando salvi il post). Nota: IG/TikTok preferiscono mp4.';
        } catch (err) {
            console.error('[admin] reel webm error:', err);
            st.textContent = 'Reel non riuscito: ' + (err.message || err);
            toast('Reel non riuscito: ' + (err.message || err), true);
        } finally {
            btn.disabled = false;
        }
    }

    async function onReelVeo() {
        if (!baseImageUrl) { toast('Prima scegli l’immagine base (sarà il primo frame del video).', true); return; }
        const prompt = ($('socVeoPrompt').value || $('socBrief').value || '').trim();
        if (prompt.length < 10) { toast('Descrivi il video nel campo sotto il bottone (o nel brief).', true); return; }
        const btn = $('socReelVeoBtn');
        const st = $('socReelStatus');
        btn.disabled = true;
        st.textContent = 'Veo sta generando il video (1-3 minuti, costo ≈ 1,50 € addebitato al progetto)…';
        try {
            const fn = httpsCallable(await getFunctionsInstance(), 'generateReelVideo');
            const res = await fn({ prompt, imageUrl: baseImageUrl });
            const url = res && res.data && res.data.url;
            if (!url) throw new Error('risposta senza URL');
            pendingAssets.push({ kind: 'video', label: 'video IA Veo (mp4)', url, path: res.data.path || '' });
            $('socReels').insertAdjacentHTML('beforeend', reelEntryHTML('video IA Veo (mp4)', url, true));
            st.textContent = 'Video pronto ✓ pronto da scaricare in formato mp4.';
        } catch (err) {
            console.error('[admin] reel veo error:', err);
            const msg = (err && (err.details || err.message)) || String(err);
            st.textContent = 'Non riuscito: ' + msg;
            toast('Generazione video non riuscita: ' + msg, true);
        } finally {
            btn.disabled = false;
        }
    }

    async function onUploadVideo(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const st = $('socReelStatus');
        if (file.size > 50 * 1024 * 1024) { toast('Video troppo grande (max 50 MB).', true); return; }
        try {
            st.textContent = 'Carico il video…';
            const storage = await getStorageInstance();
            const path = 'social/upload-video-' + Date.now() + '-' + sanitizeFilename(file.name);
            await uploadBytes(storageRef(storage, path), file, { contentType: file.type });
            const url = await getDownloadURL(storageRef(storage, path));
            pendingAssets.push({ kind: 'video', label: 'video caricato', url, path });
            $('socReels').insertAdjacentHTML('beforeend', reelEntryHTML('video caricato', url, true));
            st.textContent = 'Video caricato ✓';
        } catch (err) {
            console.error('[admin] upload video error:', err);
            st.textContent = 'Upload non riuscito: ' + (err.code || err.message);
        }
    }

    async function onCopyAI() {
        const brief = $('socBrief').value.trim();
        if (brief.length < 10) { toast('Scrivi prima il brief (almeno 10 caratteri).', true); $('socBrief').focus(); return; }
        const btn = $('socCopyBtn');
        const st = $('socCopyStatus');
        btn.disabled = true;
        btn.textContent = '⏳ Scrivo i 4 testi…';
        st.textContent = '';
        try {
            const fn = httpsCallable(await getFunctionsInstance(), 'generateSocialCopy');
            const res = await fn({ brief });
            const d = (res && res.data) || {};
            Object.keys(SOC_PLATFORMS).forEach((k) => {
                if (d[k]) $('socCopy_' + k).value = d[k];
            });
            st.textContent = 'Testi pronti ✓ rivedili prima di salvare.';
        } catch (err) {
            console.error('[admin] generateSocialCopy error:', err);
            const msg = (err && (err.details || err.message)) || String(err);
            st.textContent = 'Non riuscita: ' + msg;
            toast('Generazione testi non riuscita: ' + msg, true);
        } finally {
            btn.disabled = false;
            btn.textContent = '✨ Proponi testi con IA';
        }
    }

    async function onSave() {
        const errBox = $('socErr');
        errBox.hidden = true;
        const title = $('socTitle').value.trim();
        if (title.length < 3) {
            errBox.textContent = 'Dai un titolo interno al post (almeno 3 caratteri).';
            errBox.hidden = false;
            return;
        }
        const platforms = Array.from(panel.querySelectorAll('.soc-plat:checked')).map((c) => c.value);
        const copy = {};
        Object.keys(SOC_PLATFORMS).forEach((k) => { copy[k] = $('socCopy_' + k).value.trim(); });
        const btn = $('socSaveBtn');
        btn.disabled = true;
        try {
            const existing = editingId ? posts.find((x) => x.id === editingId) : null;
            const prevAssets = existing ? (existing.data.assets || []) : [];
            const payload = {
                title,
                brief: $('socBrief').value.trim(),
                campaignId: $('socCampaign').value || '',
                platforms,
                copy,
                baseImageUrl: baseImageUrl || (existing ? existing.data.baseImageUrl : '') || '',
                assets: prevAssets.concat(pendingAssets.filter((a) => !prevAssets.some((p) => p.url === a.url))),
                scheduledFor: $('socScheduled').value || '',
                status: $('socStatus').value,
                ...auditUpdate(),
            };
            if (editingId) {
                await updateDoc(doc(db, 'socialPosts', editingId), payload);
                toast('Post aggiornato.');
            } else {
                await addDoc(collection(db, 'socialPosts'), { ...payload, manualStats: {}, ...auditCreate() });
                toast('Post salvato: lo trovi nella vista Campagna.');
            }
            pendingAssets.length = 0;
            editingId = null;
            baseImageUrl = '';
            view = 'campagna';
            render();
        } catch (err) {
            console.error('[admin] save post error:', err);
            errBox.textContent = 'Salvataggio non riuscito: ' + (err.code || err.message);
            errBox.hidden = false;
        } finally {
            btn.disabled = false;
        }
    }

    /* --------------------------- metriche GA4 per UTM --------------------------- */

    async function loadGaCampaigns() {
        if (gaCampaignSessions) return;
        try {
            const fn = httpsCallable(await getFunctionsInstance(), 'getGaStats');
            const res = await fn({});
            gaCampaignSessions = {};
            (((res && res.data) || {}).campaigns || []).forEach((r) => {
                gaCampaignSessions[String(r.label)] = r.value;
            });
            if (view === 'campagna') render();
        } catch (err) {
            console.warn('[admin] GA4 campaigns non disponibili:', err && err.message);
            gaCampaignSessions = {}; // non riprovare a ogni render
        }
    }

    /* ----------------------------- delega eventi panel ----------------------------- */

    panel.addEventListener('click', async (e) => {
        const sub = e.target.closest('.adm-subtab');
        if (sub) {
            if (ed) edCleanup(); // uscire dall'editor ferma anteprima e video
            view = sub.dataset.view;
            render();
            return;
        }
        const btn = e.target.closest('[data-soc-action]');
        if (!btn) return;
        const action = btn.dataset.socAction;
        const id = btn.dataset.id;
        try {
            if (action === 'copy-text') {
                const t = $('socCopy_' + btn.dataset.plat);
                await navigator.clipboard.writeText(t.value);
                toast('Testo ' + SOC_PLATFORMS[btn.dataset.plat] + ' copiato.');
            } else if (action === 'copy-utm') {
                await navigator.clipboard.writeText(socUtmLink(btn.dataset.plat, btn.dataset.slug));
                toast('Link UTM copiato: incollalo nel post ' + SOC_PLATFORMS[btn.dataset.plat] + '.');
            } else if (action === 'download') {
                const ext = btn.dataset.url.includes('.webm') ? '.webm' : btn.dataset.url.includes('.mp4') ? '.mp4' : '.png';
                await socDownload(btn.dataset.url, 'fonderia-' + socSlug(btn.dataset.label || 'asset') + ext);
            } else if (action === 'reuse') {
                editingId = null;
                pendingAssets.length = 0;
                view = 'create';
                render();
                setBaseImage(btn.dataset.url);
            } else if (action === 'edit') {
                editingId = id;
                baseImageUrl = '';
                pendingAssets.length = 0;
                const p = posts.find((x) => x.id === id);
                if (p && p.data.baseImageUrl) baseImageUrl = p.data.baseImageUrl;
                view = 'create';
                render();
            } else if (action === 'new-post') {
                editingId = null;
                baseImageUrl = '';
                pendingAssets.length = 0;
                render();
            } else if (action === 'delete') {
                if (confirm('Eliminare questo post dalla programmazione? Gli asset restano in Galleria finché non rimuovi i file da Storage.')) {
                    await deleteDoc(doc(db, 'socialPosts', id));
                    toast('Post eliminato.');
                }
            } else if (action === 'toggle-campaign') {
                const c = campaigns.find((x) => x.id === id);
                if (!c) return;
                const next = c.data.status === 'archived' ? 'active' : 'archived';
                await updateDoc(doc(db, 'campaigns', id), { status: next, ...auditUpdate() });
                toast(next === 'archived' ? 'Campagna archiviata.' : 'Campagna riattivata.');
            } else if (action === 'edit-base') {
                if (!baseImageUrl) { toast('Prima genera o carica un\'immagine base.', true); return; }
                openEditor(baseImageUrl, 'image', 'create');
            } else if (action === 'open-editor') {
                openEditor(btn.dataset.url, btn.dataset.kind === 'video' ? 'video' : 'image', view);
            } else if (action === 'close-editor') {
                const rv = ed ? ed.returnView : 'create';
                edCleanup();
                if (rv === '__marketing') {
                    view = 'galleria'; // vista di riserva sensata se si torna a Social
                    render();
                    const mkTab = els.tabs.querySelector('.adm-tab[data-tab="marketing"]');
                    if (mkTab) mkTab.click();
                } else {
                    view = rv;
                    render();
                }
            } else if (action === 'gfx-delete') {
                const a = gfxAssets && gfxAssets.find((x) => x.id === id);
                if (!a) return;
                if (!confirm('Eliminare l\'asset "' + (a.data.name || '') + '" dalla libreria? Il file viene rimosso anche da Storage.')) return;
                await deleteDoc(doc(db, 'graphicAssets', id));
                // il file può essere già sparito da Storage (eliminato a mano): non bloccare
                if (a.data.path) {
                    try { await deleteObject(storageRef(await getStorageInstance(), a.data.path)); }
                    catch (err) { if (!/object-not-found/.test(err.code || '')) throw err; }
                }
                gfxAssets = null;
                render();
                toast('Asset eliminato dalla libreria.');
            }
        } catch (err) {
            console.error('[admin] social action error:', err);
            toast('Operazione non riuscita: ' + (err.code || err.message), true);
        }
    });

    // cambio stato post + metriche manuali (delega su change/input)
    panel.addEventListener('change', async (e) => {
        const sel = e.target.closest('select[data-soc-action="status"]');
        if (sel) {
            try {
                const patch = { status: sel.value, ...auditUpdate() };
                if (sel.value === 'published') patch.publishedAt = serverTimestamp();
                await updateDoc(doc(db, 'socialPosts', sel.dataset.id), patch);
                toast('Stato aggiornato: ' + SOC_STATUSES[sel.value] + '.');
            } catch (err) {
                toast('Cambio stato non riuscito: ' + (err.code || err.message), true);
            }
        }
    });
    panel.addEventListener('focusout', async (e) => {
        const gfxName = e.target.closest('[data-gfx-name]');
        if (gfxName) {
            const name = gfxName.value.trim().slice(0, 60);
            try {
                await updateDoc(doc(db, 'graphicAssets', gfxName.dataset.gfxName), { name, ...auditUpdate() });
                gfxAssets = null; // invalida cache; il rename si vede al prossimo render
                toast('Nome asset salvato.');
            } catch (err) {
                toast('Rinomina non riuscita: ' + (err.code || err.message), true);
            }
            return;
        }
        const inp = e.target.closest('[data-soc-stat]');
        if (!inp) return;
        const key = inp.dataset.socStat; // views | likes
        const val = inp.value === '' ? null : Math.max(0, Number(inp.value) || 0);
        try {
            await updateDoc(doc(db, 'socialPosts', inp.dataset.id), {
                ['manualStats.' + key]: val,
                ...auditUpdate(),
            });
            toast('Metrica salvata.');
        } catch (err) {
            toast('Salvataggio metrica non riuscito: ' + (err.code || err.message), true);
        }
    });

    panel.addEventListener('submit', async (e) => {
        if (e.target.id !== 'socCampForm') return;
        e.preventDefault();
        const name = $('socCampName').value.trim();
        if (name.length < 3) { toast('Nome campagna troppo corto.', true); return; }
        try {
            await addDoc(collection(db, 'campaigns'), { name, status: 'active', ...auditCreate() });
            $('socCampName').value = '';
            toast('Campagna creata.');
        } catch (err) {
            toast('Creazione campagna non riuscita: ' + (err.code || err.message), true);
        }
    });

    /* ------------------------------ snapshot dati ------------------------------ */

    unsubscribe.campaigns = onSnapshot(
        query(collection(db, 'campaigns'), orderBy('name')),
        (snap) => { campaigns = snap.docs.map((d) => ({ id: d.id, data: d.data() })); if (view === 'campagna') render(); },
        (err) => { console.error('[admin] campaigns snapshot error:', err); }
    );
    unsubscribe.social = onSnapshot(
        query(collection(db, 'socialPosts'), orderBy('scheduledFor')),
        // ridisegna SOLO nelle viste che leggono `posts`: in Crea cancellerebbe il
        // form mentre scrivi, in Editor distruggerebbe canvas e layer in lavorazione
        (snap) => { posts = snap.docs.map((d) => ({ id: d.id, data: d.data() })); if (view === 'campagna' || view === 'galleria') render(); },
        (err) => {
            console.error('[admin] socialPosts snapshot error:', err);
            panel.innerHTML = '<div class="adm-inline-err">Errore nel caricamento dei post social.</div>';
        }
    );

    render();
}

/* ------------------------------------ tab: marketing ------------------------------------ */

// Superficie UNICA di generazione (richiesta Mario 15/09/26): un grande bottone
// "Generazione grafiche" apre un wizard multi-step (tipo attivita' → contenuto →
// grafica → riepilogo) che orchestra i pezzi esistenti (immagine IA Gemini, reel
// webm, video Veo, editor logo/testi via marketingBridge) e salva in events/,
// popups/ o socialPosts/ con gli stessi payload delle tab storiche. Le tab
// Eventi/Popup/Social restano per la gestione avanzata. Sotto al bottone la
// lista unificata di tutto cio' che e' stato generato, tutto modificabile.
async function startMarketingTab() {
    const panel = els.panels.marketing;
    if (!panel) return;
    const db = await getDb();

    let mkEvents = [];
    let mkPopups = [];
    let mkPosts = [];
    let mkCampaigns = [];
    let mkGfx = []; // libreria asset grafici (logo/sticker)
    let filter = 'all'; // all|post|evento|popup|media
    let wiz = null; // sessione wizard, vedi mkNewWizard()

    /* ------------------------------ lista unificata ------------------------------ */

    function mkDateStr(v) {
        if (!v) return '';
        const d = v.toDate ? v.toDate() : new Date(v);
        return isNaN(d) ? '' : d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
    }

    function campaignName(id) {
        const c = mkCampaigns.find((x) => x.id === id);
        return c ? c.data.name : '';
    }

    function mkShellHTML() {
        return `
        <div class="adm-panel-head">
            <div>
                <h2>Marketing</h2>
                <p class="adm-panel-lead">Genera grafiche e contenuti per <strong>social, eventi e popup</strong> da un unico punto: il pulsante qui sotto apre un percorso guidato passo passo. Sotto trovi <strong>tutto ciò che hai generato</strong>, sempre modificabile. (Le tab Eventi/Popup/Social restano disponibili per la gestione avanzata.)</p>
            </div>
        </div>
        <div class="mk-hero">
            <button class="adm-btn mk-hero-btn" data-mk-action="open-wizard" type="button">✨ Generazione grafiche</button>
            <span class="adm-cell-muted">Post social, reel e video IA, immagini eventi, sfondi popup — con logo e testi animati.</span>
        </div>
        <div class="adm-subtabs">
            ${[['all', 'Tutto'], ['post', '📱 Post social'], ['evento', '🎪 Eventi'], ['popup', '🪟 Popup'], ['media', '🖼 Media']]
                .map(([k, l]) => `<button class="adm-subtab${filter === k ? ' active' : ''}" data-mk-action="filter" data-filter="${k}" type="button">${l}</button>`).join('')}
        </div>
        <div id="mkList"></div>
        <div id="mkWizardHost"></div>`;
    }

    function mkPostCellHTML(p) {
        const d = p.data;
        const assets = (d.assets || []).map((a) => `
            <div class="mk-asset">
                ${a.kind === 'video'
                    ? `<video src="${esc(a.url)}" muted playsinline preload="metadata"></video>`
                    : `<img src="${esc(a.url)}" alt="" loading="lazy">`}
                <span class="mk-asset-label">${esc(a.label || (a.kind === 'video' ? 'video' : 'immagine'))}</span>
                <div class="adm-gal-actions">
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="edit-media" data-url="${esc(a.url)}" data-kind="${a.kind === 'video' ? 'video' : 'image'}" type="button">✏️ Editor</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="download" data-url="${esc(a.url)}" data-label="${esc(a.label || 'media')}" type="button">Scarica</button>
                </div>
            </div>`).join('');
        return `
        <div class="mk-item" data-type="post">
            <div class="mk-item-head">
                <span class="adm-chip">📱 Social</span>
                <strong>${esc(d.title || '(senza titolo)')}</strong>
                <span class="adm-cell-muted">${mkDateStr(d.scheduledFor)}${d.campaignId ? ' · ' + esc(campaignName(d.campaignId)) : ''} · ${esc(SOC_STATUSES[d.status] || d.status || 'Bozza')}</span>
            </div>
            ${assets ? `<div class="mk-assets">${assets}</div>` : '<div class="adm-cell-muted">Nessun asset collegato.</div>'}
            <div class="adm-gal-actions">
                <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="edit-item" data-type="post" data-id="${esc(p.id)}" type="button">Modifica nel wizard</button>
                <button class="adm-btn adm-btn-danger adm-btn-sm" data-mk-action="del-item" data-type="post" data-id="${esc(p.id)}" data-label="${esc(d.title || '')}" type="button">Elimina</button>
            </div>
        </div>`;
    }

    function mkEventCellHTML(ev) {
        const d = ev.data;
        return `
        <div class="mk-item" data-type="evento">
            <div class="mk-item-head">
                <span class="adm-chip">🎪 Evento</span>
                <strong>${esc(d.title || '')}</strong>
                <span class="adm-cell-muted">${mkDateStr(d.date)}${d.time ? ' ' + esc(d.time) : ''} · ${d.active ? 'attivo' : 'spento'}</span>
            </div>
            ${d.image ? `<div class="mk-assets"><div class="mk-asset"><img src="${esc(d.image)}" alt="" loading="lazy"><span class="mk-asset-label">immagine evento</span>
                <div class="adm-gal-actions">
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="edit-media" data-url="${esc(d.image)}" data-kind="image" type="button">✏️ Editor</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="download" data-url="${esc(d.image)}" data-label="${esc(d.title || 'evento')}" type="button">Scarica</button>
                </div></div></div>` : ''}
            <div class="adm-gal-actions">
                <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="edit-item" data-type="evento" data-id="${esc(ev.id)}" type="button">Modifica nel wizard</button>
                <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="toggle-active" data-type="evento" data-id="${esc(ev.id)}" type="button">${d.active ? 'Spegni' : 'Accendi'}</button>
                <button class="adm-btn adm-btn-danger adm-btn-sm" data-mk-action="del-item" data-type="evento" data-id="${esc(ev.id)}" data-label="${esc(d.title || '')}" type="button">Elimina</button>
            </div>
        </div>`;
    }

    function mkPopupCellHTML(pp) {
        const d = pp.data;
        return `
        <div class="mk-item" data-type="popup">
            <div class="mk-item-head">
                <span class="adm-chip">🪟 Popup</span>
                <strong>${esc(d.title || '')}</strong>
                <span class="adm-cell-muted">${mkDateStr(d.startDate)} → ${mkDateStr(d.endDate)} · ${d.active ? 'attivo' : 'spento'}</span>
            </div>
            ${d.imageUrl ? `<div class="mk-assets"><div class="mk-asset"><img src="${esc(d.imageUrl)}" alt="" loading="lazy"><span class="mk-asset-label">sfondo popup</span>
                <div class="adm-gal-actions">
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="edit-media" data-url="${esc(d.imageUrl)}" data-kind="image" type="button">✏️ Editor</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="download" data-url="${esc(d.imageUrl)}" data-label="${esc(d.title || 'popup')}" type="button">Scarica</button>
                </div></div></div>` : ''}
            <div class="adm-gal-actions">
                <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="edit-item" data-type="popup" data-id="${esc(pp.id)}" type="button">Modifica nel wizard</button>
                <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="toggle-active" data-type="popup" data-id="${esc(pp.id)}" type="button">${d.active ? 'Spegni' : 'Accendi'}</button>
                <button class="adm-btn adm-btn-danger adm-btn-sm" data-mk-action="del-item" data-type="popup" data-id="${esc(pp.id)}" data-label="${esc(d.title || '')}" type="button">Elimina</button>
            </div>
        </div>`;
    }

    // Tutti i media prodotti, deduplicati per URL: asset dei post + libreria grafica.
    function mkMediaCellsHTML() {
        const seen = new Set();
        const cells = [];
        mkPosts.forEach((p) => (p.data.assets || []).forEach((a) => {
            if (seen.has(a.url)) return;
            seen.add(a.url);
            cells.push({ label: (a.label || 'media') + ' · ' + (p.data.title || ''), url: a.url, kind: a.kind === 'video' ? 'video' : 'image' });
        }));
        mkGfx.forEach((g) => {
            if (seen.has(g.data.url)) return;
            seen.add(g.data.url);
            cells.push({ label: '🧩 libreria: ' + (g.data.name || ''), url: g.data.url, kind: 'image' });
        });
        if (!cells.length) return '<div class="adm-empty">Ancora nessun media: genera qualcosa con il pulsante qui sopra.</div>';
        return `<div class="adm-gallery">${cells.map((c) => `
            <div class="adm-gal-cell">
                ${c.kind === 'video' ? `<video src="${esc(c.url)}" muted playsinline preload="metadata"></video>` : `<img src="${esc(c.url)}" alt="" loading="lazy">`}
                <div class="adm-gal-label">${esc(c.label)}</div>
                <div class="adm-gal-actions">
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="edit-media" data-url="${esc(c.url)}" data-kind="${c.kind}" type="button">✏️ Editor</button>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="download" data-url="${esc(c.url)}" data-label="${esc(c.label.replace(/^🧩 libreria: /, 'gfx-'))}" type="button">Scarica</button>
                </div>
            </div>`).join('')}</div>`;
    }

    function mkListHTML() {
        const parts = [];
        if (filter === 'all' || filter === 'post') {
            parts.push('<h3 class="adm-subhead">📱 Post social (' + mkPosts.length + ')</h3>');
            parts.push(mkPosts.length ? mkPosts.map(mkPostCellHTML).join('') : '<div class="adm-empty">Nessun post: crealo dal pulsante Generazione grafiche.</div>');
        }
        if (filter === 'all' || filter === 'evento') {
            parts.push('<h3 class="adm-subhead">🎪 Eventi (' + mkEvents.length + ')</h3>');
            parts.push(mkEvents.length ? mkEvents.map(mkEventCellHTML).join('') : '<div class="adm-empty">Nessun evento.</div>');
        }
        if (filter === 'all' || filter === 'popup') {
            parts.push('<h3 class="adm-subhead">🪟 Popup (' + mkPopups.length + ')</h3>');
            parts.push(mkPopups.length ? mkPopups.map(mkPopupCellHTML).join('') : '<div class="adm-empty">Nessun popup.</div>');
        }
        if (filter === 'all' || filter === 'media') {
            parts.push('<h3 class="adm-subhead">🖼 Tutti i media</h3>');
            parts.push(mkMediaCellsHTML());
        }
        return parts.join('');
    }

    function mkRenderList() {
        const host = $('mkList');
        if (host) host.innerHTML = mkListHTML();
    }

    function render() {
        panel.innerHTML = mkShellHTML();
        mkRenderList();
        if (wiz) mkPaintWizard();
    }

    /* ------------------------------ wizard multi-step ------------------------------ */

    // Sessione wizard. step: 1 tipo → 2 contenuto → 3 grafica → 4 riepilogo.
    // type: 'post' | 'evento' | 'popup'. editId valorizzato = modifica.
    function mkNewWizard(prefill) {
        return {
            step: 1, type: null, editId: null, statusLine: '',
            title: '', brief: '', campaignId: '', newCampaign: '', platforms: ['ig', 'fb'], scheduled: '',
            evTagline: '', evDate: '', evTime: '', evDesc: '', evActive: true,
            popBody: '', popStart: '', popEnd: '', popCtaType: 'booking', popBookingType: 'cena', popEventTitle: '', popActive: true,
            imageUrl: '', assets: [],
            ...prefill,
        };
    }

    function mkToInputDate(v) {
        if (!v) return '';
        const d = v.toDate ? v.toDate() : new Date(v);
        if (isNaN(d)) return '';
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    function mkOpenWizard(type, editId) {
        const w = mkNewWizard();
        if (type) {
            w.type = type;
            w.step = 2;
        }
        if (editId && type === 'post') {
            const p = mkPosts.find((x) => x.id === editId);
            if (!p) { toast('Post non trovato (forse eliminato).', true); return; }
            const d = p.data;
            w.editId = editId;
            w.title = d.title || '';
            w.brief = (d.copy && (d.copy.ig || d.copy.fb || d.copy.tt)) || d.brief || '';
            w.campaignId = d.campaignId || '';
            w.platforms = (d.platforms && d.platforms.length) ? d.platforms.slice() : ['ig', 'fb'];
            w.scheduled = d.scheduledFor || '';
            w.imageUrl = d.baseImageUrl || '';
            w.assets = (d.assets || []).slice();
        } else if (editId && type === 'evento') {
            const ev = mkEvents.find((x) => x.id === editId);
            if (!ev) { toast('Evento non trovato.', true); return; }
            const d = ev.data;
            w.editId = editId;
            w.title = d.title || '';
            w.evTagline = d.tagline || '';
            w.evDate = mkToInputDate(d.date);
            w.evTime = d.time || '';
            w.evDesc = d.description || '';
            w.evActive = d.active !== false;
            w.imageUrl = d.image || '';
        } else if (editId && type === 'popup') {
            const pp = mkPopups.find((x) => x.id === editId);
            if (!pp) { toast('Popup non trovato.', true); return; }
            const d = pp.data;
            w.editId = editId;
            w.title = d.title || '';
            w.popBody = d.body || '';
            w.popStart = mkToInputDate(d.startDate);
            w.popEnd = mkToInputDate(d.endDate);
            w.popCtaType = d.ctaType || 'booking';
            w.popBookingType = d.ctaBookingType || 'cena';
            w.popEventTitle = d.eventTitle || '';
            w.popActive = d.active !== false;
            w.imageUrl = d.imageUrl || '';
        }
        wiz = w;
        render();
    }

    function mkCloseWizard() {
        wiz = null;
        render();
    }

    // Raccoglie i valori dei campi dello step corrente prima di cambiare step
    // (il repainting distrugge il DOM, quindi nulla si perde solo se leggiamo qui).
    function mkHarvestStep() {
        if (!wiz) return;
        const q = (id) => $(id);
        if (wiz.step === 2 && wiz.type === 'post') {
            if (q('mkPostTitle')) {
                wiz.title = q('mkPostTitle').value.trim();
                wiz.brief = q('mkPostBrief').value.trim();
                wiz.campaignId = q('mkPostCampaign').value;
                wiz.newCampaign = q('mkNewCampaign').value.trim();
                wiz.platforms = Array.from(panel.querySelectorAll('.mk-plat:checked')).map((c) => c.value);
                wiz.scheduled = q('mkPostScheduled').value;
            }
        } else if (wiz.step === 2 && wiz.type === 'evento') {
            if (q('mkEvTitle')) {
                wiz.title = q('mkEvTitle').value.trim();
                wiz.evTagline = q('mkEvTagline').value.trim();
                wiz.evDate = q('mkEvDate').value;
                wiz.evTime = q('mkEvTime').value.trim();
                wiz.evDesc = q('mkEvDesc').value.trim();
                wiz.evActive = q('mkEvActive').checked;
            }
        } else if (wiz.step === 2 && wiz.type === 'popup') {
            if (q('mkPopTitle')) {
                wiz.title = q('mkPopTitle').value.trim();
                wiz.popBody = q('mkPopBody').value.trim();
                wiz.popStart = q('mkPopStart').value;
                wiz.popEnd = q('mkPopEnd').value;
                wiz.popCtaType = (panel.querySelector('input[name="mkPopCta"]:checked') || {}).value || 'booking';
                wiz.popBookingType = q('mkPopBookingType').value;
                wiz.popEventTitle = q('mkPopEventTitle').value.trim();
                wiz.popActive = q('mkPopActive').checked;
            }
        } else if (wiz.step === 3) {
            if (q('mkAiPrompt')) wiz.aiPrompt = q('mkAiPrompt').value;
            if (q('mkVeoPrompt')) wiz.veoPrompt = q('mkVeoPrompt').value;
        }
    }

    function mkValidateStep2() {
        if (wiz.type === 'post') {
            if (wiz.title.length < 3) return 'Dai un titolo interno al post (almeno 3 caratteri).';
        } else if (wiz.type === 'evento') {
            if (!wiz.title) return 'Il titolo è obbligatorio.';
            if (!wiz.evDate || isNaN(new Date(wiz.evDate + 'T12:00:00'))) return 'Data evento non valida.';
        } else if (wiz.type === 'popup') {
            if (!wiz.title) return 'Il titolo è obbligatorio.';
            const s = new Date(wiz.popStart + 'T00:00:00');
            const e = new Date(wiz.popEnd + 'T23:59:59');
            if (!wiz.popStart || !wiz.popEnd || isNaN(s) || isNaN(e)) return 'Date di visibilità non valide.';
            if (e <= s) return 'La fine deve essere successiva all\'inizio.';
        }
        return '';
    }

    const MK_STEPS = ['Tipo', 'Contenuto', 'Grafica', 'Riepilogo'];

    function mkTypeCard(kind, icon, title, desc) {
        return `
        <button class="mk-type-card" data-mk-action="wiz-type" data-type="${kind}" type="button">
            <span class="mk-type-icon">${icon}</span>
            <strong>${title}</strong>
            <span>${desc}</span>
        </button>`;
    }

    function mkWizardStepHTML() {
        const w = wiz;
        if (w.step === 1) {
            return `
            <p class="mk-step-title">Cosa vuoi generare?</p>
            <div class="mk-type-grid">
                ${mkTypeCard('post', '📱', 'Post social + reel/video', 'Immagini, reel animati e video IA per Facebook, Instagram, WhatsApp e TikTok — con logo e testi animati.')}
                ${mkTypeCard('evento', '🎪', 'Evento', 'Appare nella homepage del sito con immagine, data e descrizione.')}
                ${mkTypeCard('popup', '🪟', 'Popup', 'Annuncio che si apre sul sito in un periodo scelto, con sfondo generato e invito all\'azione.')}
            </div>`;
        }
        if (w.step === 2 && w.type === 'post') {
            return `
            <p class="mk-step-title">Contenuto del post</p>
            <div class="adm-group">
                <label for="mkPostTitle">Titolo interno <span class="adm-tip" tabindex="0" data-tip="Solo per riconoscerlo in lista: non compare nei social.">?</span></label>
                <input id="mkPostTitle" type="text" maxlength="80" value="${esc(w.title)}" placeholder="Es. Apertura stagione — annuncio">
            </div>
            <div class="adm-group">
                <label for="mkPostBrief">Didascalia <span class="adm-tip" tabindex="0" data-tip="Il testo del post; vale per tutte le piattaforme selezionate.">?</span></label>
                <textarea id="mkPostBrief" rows="4" placeholder="Venerdì 3 ottobre riapre la Fonderia…">${esc(w.brief)}</textarea>
                <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="wiz-copyai" type="button">🪄 Scrivila con l'IA</button>
                <span id="mkCopyStatus" class="adm-cell-muted" role="status"></span>
            </div>
            <div class="adm-row">
                <div class="adm-group">
                    <label for="mkPostCampaign">Campagna <span class="adm-tip" tabindex="0" data-tip="Opzionale: raggruppa i post per analizzarne il traffico. Puoi crearla al volo qui sotto o saltare.">?</span></label>
                    <select id="mkPostCampaign">
                        <option value="">— Nessuna —</option>
                        ${mkCampaigns.map((c) => `<option value="${esc(c.id)}"${w.campaignId === c.id ? ' selected' : ''}>${esc(c.data.name)}</option>`).join('')}
                    </select>
                    <input id="mkNewCampaign" type="text" maxlength="60" value="${esc(w.newCampaign)}" placeholder="…oppure scrivi un nome per crearla al volo">
                </div>
                <div class="adm-group">
                    <label for="mkPostScheduled">Data pubblicazione <span class="adm-tip" tabindex="0" data-tip="Opzionale: solo promemoria interno, la pubblicazione la fai tu dalle app social.">?</span></label>
                    <input id="mkPostScheduled" type="date" value="${esc(w.scheduled)}">
                </div>
            </div>
            <div class="adm-group">
                <label>Piattaforme</label>
                <div class="adm-checks">
                    ${Object.entries(SOC_PLATFORMS).map(([k, l]) => `
                        <label class="adm-check"><input class="mk-plat" type="checkbox" value="${k}"${w.platforms.includes(k) ? ' checked' : ''}> ${l}</label>`).join('')}
                </div>
            </div>`;
        }
        if (w.step === 2 && w.type === 'evento') {
            return `
            <p class="mk-step-title">Contenuto dell'evento</p>
            <div class="adm-row">
                <div class="adm-group">
                    <label for="mkEvTitle">Titolo</label>
                    <input id="mkEvTitle" type="text" value="${esc(w.title)}" placeholder="Apertura Stagione">
                </div>
                <div class="adm-group">
                    <label for="mkEvTagline">Tagline</label>
                    <input id="mkEvTagline" type="text" value="${esc(w.evTagline)}" placeholder="Una serata speciale…">
                </div>
            </div>
            <div class="adm-row">
                <div class="adm-group"><label for="mkEvDate">Data</label><input id="mkEvDate" type="date" value="${esc(w.evDate)}"></div>
                <div class="adm-group"><label for="mkEvTime">Ora</label><input id="mkEvTime" type="text" value="${esc(w.evTime)}" placeholder="21:00"></div>
            </div>
            <div class="adm-group">
                <label for="mkEvDesc">Descrizione</label>
                <textarea id="mkEvDesc" rows="4">${esc(w.evDesc)}</textarea>
            </div>
            <div class="adm-checks"><label class="adm-check"><input id="mkEvActive" type="checkbox"${w.evActive ? ' checked' : ''}> Visibile sul sito</label></div>`;
        }
        if (w.step === 2 && w.type === 'popup') {
            return `
            <p class="mk-step-title">Contenuto del popup</p>
            <div class="adm-group">
                <label for="mkPopTitle">Titolo</label>
                <input id="mkPopTitle" type="text" value="${esc(w.title)}" placeholder="Apertura Stagione — 3 ottobre">
            </div>
            <div class="adm-group">
                <label for="mkPopBody">Testo</label>
                <textarea id="mkPopBody" rows="3">${esc(w.popBody)}</textarea>
            </div>
            <div class="adm-row">
                <div class="adm-group"><label for="mkPopStart">Visibile dal</label><input id="mkPopStart" type="date" value="${esc(w.popStart)}"></div>
                <div class="adm-group"><label for="mkPopEnd">Fino al</label><input id="mkPopEnd" type="date" value="${esc(w.popEnd)}"></div>
            </div>
            <div class="adm-group">
                <label>Invito all'azione</label>
                <div class="adm-checks">
                    <label class="adm-check"><input type="radio" name="mkPopCta" value="booking"${w.popCtaType === 'booking' ? ' checked' : ''}> Prenotazione</label>
                    <label class="adm-check"><input type="radio" name="mkPopCta" value="link"${w.popCtaType === 'link' ? ' checked' : ''}> Nessuna (solo annuncio)</label>
                </div>
            </div>
            <div class="adm-row">
                <div class="adm-group"><label for="mkPopBookingType">Tipo prenotazione</label>
                    <select id="mkPopBookingType">
                        <option value="cena"${w.popBookingType === 'cena' ? ' selected' : ''}>Cena</option>
                        <option value="after-cena"${w.popBookingType === 'after-cena' ? ' selected' : ''}>After-Cena</option>
                        <option value="evento"${w.popBookingType === 'evento' ? ' selected' : ''}>Evento</option>
                    </select>
                </div>
                <div class="adm-group"><label for="mkPopEventTitle">Nome evento (se tipo Evento)</label>
                    <input id="mkPopEventTitle" type="text" value="${esc(w.popEventTitle)}" placeholder="Apertura Stagione">
                </div>
            </div>
            <div class="adm-checks"><label class="adm-check"><input id="mkPopActive" type="checkbox"${w.popActive ? ' checked' : ''}> Attivo</label></div>`;
        }
        if (w.step === 3) {
            const isPost = w.type === 'post';
            return `
            <p class="mk-step-title">${isPost ? 'Grafica e video del post' : 'Immagine'}</p>
            <div class="adm-group">
                <label for="mkAiPrompt">Genera con IA <span class="adm-tip" tabindex="0" data-tip="Gemini genera un'immagine dal testo: descrivi scena, colori, atmosfera. Circa 30 secondi.">?</span></label>
                <textarea id="mkAiPrompt" rows="2" placeholder="Es. Interno industriale della Fonderia, luci calde, spritz in primo piano…">${esc(w.aiPrompt || (w.title + (w.evTagline ? ' — ' + w.evTagline : '')))}</textarea>
                <button class="adm-btn adm-btn-ghost adm-btn-sm" id="mkAiGenBtn" type="button" data-mk-action="wiz-aigen">🎨 Genera immagine con IA</button>
                <span id="mkAiStatus" class="adm-cell-muted" role="status"></span>
            </div>
            <div class="adm-row">
                <div class="adm-group">
                    <label for="mkUpload">Oppure carica un file</label>
                    <input id="mkUpload" type="file" accept="image/*">
                </div>
                <div class="adm-group">
                    <label>Oppure scegli dai media già generati</label>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="wiz-picktoggle" type="button" id="mkPickToggle">🖼 Apri scelta media</button>
                </div>
            </div>
            <div id="mkPicker" class="adm-ed-picker" hidden></div>
            ${w.imageUrl ? `
            <div class="mk-chosen">
                <img src="${esc(w.imageUrl)}" alt="Immagine scelta">
                <div>
                    <div class="adm-cell-muted">Immagine scelta</div>
                    <div class="adm-gal-actions">
                        <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="wiz-edit-base" type="button">✏️ Logo/Testi (editor)</button>
                        <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="wiz-clearimg" type="button">Rimuovi</button>
                    </div>
                </div>
            </div>` : '<div class="adm-cell-muted">Nessuna immagine scelta ancora.</div>'}
            ${isPost ? `
            <div class="adm-form-title" style="margin-top:14px">Video</div>
            <div class="adm-row">
                <div class="adm-group">
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="wiz-reel" type="button"${w.imageUrl ? '' : ' disabled'}>🎬 Reel animato 8s (gratis, webm)</button>
                </div>
                <div class="adm-group">
                    <label for="mkVeoPrompt">Video IA Veo 8s — costo ≈ 1,50 €</label>
                    <textarea id="mkVeoPrompt" rows="2" placeholder="Es. La camera avanza lentamente tra i tavoli…">${esc(w.veoPrompt || w.brief || '')}</textarea>
                    <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="wiz-veo" type="button"${w.imageUrl ? '' : ' disabled'}>🎬 Genera video Veo</button>
                </div>
            </div>` : ''}
            <span id="mkMediaStatus" class="adm-cell-muted" role="status">${esc(w.statusLine || '')}</span>
            ${w.assets.length ? '<div class="adm-form-title" style="margin-top:14px">Media prodotti (' + w.assets.length + ')</div>' : ''}
            <div class="mk-assets">
                ${w.assets.map((a, i) => `
                <div class="mk-asset">
                    ${a.kind === 'video' ? `<video src="${esc(a.url)}" muted playsinline preload="metadata"></video>` : `<img src="${esc(a.url)}" alt="" loading="lazy">`}
                    <span class="mk-asset-label">${esc(a.label)}</span>
                    <div class="adm-gal-actions">
                        <button class="adm-btn adm-btn-ghost adm-btn-sm" data-mk-action="wiz-edit-asset" data-idx="${i}" type="button">✏️ Logo/Testi</button>
                        <button class="adm-btn adm-btn-danger adm-btn-sm" data-mk-action="wiz-del-asset" data-idx="${i}" type="button">Rimuovi</button>
                    </div>
                </div>`).join('')}
            </div>`;
        }
        // step 4: riepilogo
        const typeLabel = { post: '📱 Post social', evento: '🎪 Evento', popup: '🪟 Popup' }[w.type];
        const rows = [['Tipo', typeLabel], ['Titolo', w.title || '—']];
        if (w.type === 'post') {
            rows.push(['Piattaforme', w.platforms.map((k) => SOC_PLATFORMS[k]).join(', ') || '—']);
            rows.push(['Campagna', w.newCampaign ? w.newCampaign + ' (nuova)' : (campaignName(w.campaignId) || 'nessuna')]);
            if (w.scheduled) rows.push(['Pubblicazione', w.scheduled]);
        } else if (w.type === 'evento') {
            rows.push(['Data', w.evDate + (w.evTime ? ' ' + w.evTime : '')]);
        } else if (w.type === 'popup') {
            rows.push(['Periodo', w.popStart + ' → ' + w.popEnd]);
        }
        rows.push(['Immagine', w.imageUrl ? 'sì ✓' : 'nessuna']);
        if (w.type === 'post') rows.push(['Media prodotti', String(w.assets.length)]);
        return `
        <p class="mk-step-title">Riepilogo — controlla e salva</p>
        <dl class="mk-summary">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        ${w.imageUrl ? `<div class="mk-chosen"><img src="${esc(w.imageUrl)}" alt=""><div class="adm-cell-muted">Anteprima immagine</div></div>` : ''}
        <div id="mkSaveErr" class="adm-inline-err" hidden></div>`;
    }

    function mkPaintWizard() {
        const host = $('mkWizardHost');
        if (!host || !wiz) return;
        const w = wiz;
        const canNext = w.step === 1 ? Boolean(w.type)
            : w.step === 2 ? true
            : w.step === 3 ? true : false;
        host.innerHTML = `
        <div class="mk-overlay">
            <div class="mk-modal" role="dialog" aria-modal="true" aria-label="Generazione grafiche">
                <div class="mk-modal-head">
                    <div>
                        <div class="mk-modal-title">${w.editId ? 'Modifica' : 'Generazione grafiche'}</div>
                        <div class="mk-steps">${MK_STEPS.map((s, i) => `<span class="mk-step-dot${w.step === i + 1 ? ' active' : ''}${w.step > i + 1 ? ' done' : ''}">${i + 1}. ${s}</span>`).join('')}</div>
                    </div>
                    <button class="adm-btn adm-btn-ghost" data-mk-action="close-wizard" type="button">✕ Chiudi</button>
                </div>
                <div class="mk-modal-body">${mkWizardStepHTML()}</div>
                <div class="mk-modal-foot">
                    ${w.step > 1 ? '<button class="adm-btn adm-btn-ghost" data-mk-action="wiz-back" type="button">← Indietro</button>' : '<span></span>'}
                    ${w.step < 4 ? `<button class="adm-btn" data-mk-action="wiz-next" type="button"${canNext ? '' : ' disabled'}>Avanti →</button>` : '<button class="adm-btn" data-mk-action="wiz-save" type="button" id="mkSaveBtn">💾 Salva</button>'}
                </div>
            </div>
        </div>`;
    }

    // Upload file scelto nel wizard (immagine → social/upload-…), poi la mostra come scelta.
    async function mkUploadImage(file) {
        if (!file) return;
        if (file.size > 50 * 1024 * 1024) { toast('File troppo grande (max 50 MB).', true); return; }
        try {
            const storage = await getStorageInstance();
            const path = 'social/upload-' + Date.now() + '-' + sanitizeFilename(file.name);
            await uploadBytes(storageRef(storage, path), file, { contentType: file.type });
            wiz.imageUrl = await getDownloadURL(storageRef(storage, path));
            mkHarvestStep();
            mkPaintWizard();
            toast('Immagine caricata.');
        } catch (err) {
            console.error('[admin] mk upload error:', err);
            toast('Upload non riuscito: ' + (err.code || err.message), true);
        }
    }

    // Reel webm dall'immagine scelta (Ken Burns), come nella tab Social.
    async function mkMakeReel() {
        if (!wiz || !wiz.imageUrl) { toast('Prima scegli l\'immagine base.', true); return; }
        const st = $('mkMediaStatus');
        try {
            if (st) st.textContent = 'Registro l\'animazione (circa 10 secondi)…';
            const img = await socLoadImage(wiz.imageUrl);
            const blob = await socRenderReel(img, wiz.title || 'Fonderia Treviso');
            const storage = await getStorageInstance();
            const path = 'social/reel-webm-' + socSlug(wiz.title || 'post') + '-' + Date.now() + '.webm';
            await uploadBytes(storageRef(storage, path), blob, { contentType: 'video/webm' });
            const url = await getDownloadURL(storageRef(storage, path));
            wiz.assets.push({ kind: 'video', label: 'reel animato (webm)', url, path });
            mkHarvestStep();
            wiz.statusLine = 'Reel pronto ✓ (IG/TikTok preferiscono mp4, ma accettano webm).';
            mkPaintWizard();
        } catch (err) {
            console.error('[admin] mk reel error:', err);
            wiz.statusLine = 'Reel non riuscito: ' + (err.message || err);
            mkPaintWizard();
        }
    }

    // Video Veo 8s dall'immagine scelta (callable generateReelVideo, ~1,50 €).
    async function mkMakeVeo() {
        if (!wiz || !wiz.imageUrl) { toast('Prima scegli l\'immagine base (sarà il primo frame).', true); return; }
        mkHarvestStep();
        const prompt = (wiz.veoPrompt || wiz.brief || wiz.title || '').trim();
        if (prompt.length < 10) { toast('Descrivi il video (almeno 10 caratteri) nel campo sotto il bottone.', true); return; }
        wiz.statusLine = 'Veo sta generando il video (1-3 minuti, costo ≈ 1,50 € addebitato al progetto)…';
        mkPaintWizard();
        try {
            const fn = httpsCallable(await getFunctionsInstance(), 'generateReelVideo');
            const res = await fn({ prompt, imageUrl: wiz.imageUrl });
            const url = res && res.data && res.data.url;
            if (!url) throw new Error('risposta senza URL');
            wiz.assets.push({ kind: 'video', label: 'video IA Veo (mp4)', url, path: res.data.path || '' });
            wiz.statusLine = 'Video pronto ✓ formato mp4.';
        } catch (err) {
            console.error('[admin] mk veo error:', err);
            wiz.statusLine = 'Video non riuscito: ' + ((err && (err.details || err.message)) || String(err));
        }
        mkPaintWizard();
    }

    // Didascalia scritta da Gemini (callable generateSocialCopy già usato in Social).
    async function mkCopyAI() {
        if (!wiz) return;
        mkHarvestStep();
        const btn = panel.querySelector('[data-mk-action="wiz-copyai"]');
        const st = $('mkCopyStatus');
        if ((wiz.brief || wiz.title || '').trim().length < 5) { toast('Scrivi prima qualche parola nel campo didascalia (anche solo l\'idea).', true); return; }
        if (btn) btn.disabled = true;
        if (st) st.textContent = 'L\'IA scrive…';
        try {
            const fn = httpsCallable(await getFunctionsInstance(), 'generateSocialCopy');
            const res = await fn({ brief: wiz.brief || wiz.title });
            const data = (res && res.data) || {};
            // generateSocialCopy risponde per piattaforma {fb, ig, wa, tt}: prendiamo ig (la piu' completa)
            const text = data.ig || data.fb || data.tt || data.wa || '';
            if (!text) throw new Error('risposta senza testo');
            wiz.brief = String(text);
            if (st) st.textContent = 'Fatto ✓';
            mkPaintWizard();
        } catch (err) {
            console.error('[admin] mk copyai error:', err);
            const msg = (err && (err.details || err.message)) || String(err);
            if (st) st.textContent = 'Non riuscita: ' + msg;
            toast('Copia IA non riuscita: ' + msg, true);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // Salvataggio finale: payload identici alle tab storiche (events/popups/socialPosts).
    async function mkSave() {
        if (!wiz) return;
        const errBox = $('mkSaveErr');
        const btn = $('mkSaveBtn');
        if (btn) btn.disabled = true;
        try {
            if (wiz.type === 'post') {
                let campaignId = wiz.campaignId;
                if (wiz.newCampaign && wiz.newCampaign.length >= 3) {
                    const refDoc = await addDoc(collection(db, 'campaigns'), { name: wiz.newCampaign, status: 'active', ...auditCreate() });
                    campaignId = refDoc.id;
                }
                const copy = {};
                Object.keys(SOC_PLATFORMS).forEach((k) => { copy[k] = wiz.platforms.includes(k) ? wiz.brief : ''; });
                // in modifica wiz.assets e' gia' precompilato con gli asset esistenti:
                // salvarlo cosi' com'e' copre aggiunte e rimozioni fatte nel wizard
                const existing = wiz.editId ? mkPosts.find((x) => x.id === wiz.editId) : null;
                const payload = {
                    title: wiz.title,
                    brief: wiz.brief,
                    campaignId,
                    platforms: wiz.platforms,
                    copy,
                    baseImageUrl: wiz.imageUrl || (existing ? existing.data.baseImageUrl : '') || '',
                    assets: wiz.assets,
                    scheduledFor: wiz.scheduled || '',
                    status: existing ? (existing.data.status || 'draft') : 'draft',
                    ...auditUpdate(),
                };
                if (wiz.editId) {
                    await updateDoc(doc(db, 'socialPosts', wiz.editId), payload);
                    toast('Post aggiornato.');
                } else {
                    await addDoc(collection(db, 'socialPosts'), { ...payload, manualStats: {}, ...auditCreate() });
                    toast('Post creato.');
                }
            } else if (wiz.type === 'evento') {
                const payload = {
                    title: wiz.title,
                    tagline: wiz.evTagline,
                    date: new Date(wiz.evDate + 'T12:00:00'),
                    time: wiz.evTime,
                    description: wiz.evDesc,
                    image: wiz.imageUrl || '',
                    active: wiz.evActive,
                    order: 0,
                    ...auditUpdate(),
                };
                if (wiz.editId) {
                    await updateDoc(doc(db, 'events', wiz.editId), payload);
                    toast('Evento aggiornato.');
                } else {
                    await addDoc(collection(db, 'events'), { ...payload, ...auditCreate() });
                    toast('Evento creato.');
                }
            } else if (wiz.type === 'popup') {
                const payload = {
                    title: wiz.title,
                    body: wiz.popBody,
                    startDate: new Date(wiz.popStart + 'T00:00:00'),
                    endDate: new Date(wiz.popEnd + 'T23:59:59'),
                    active: wiz.popActive,
                    imageUrl: wiz.imageUrl || '',
                    imageSource: wiz.imageUrl ? 'storage' : 'local',
                    ctaType: wiz.popCtaType,
                    ...auditUpdate(),
                };
                if (wiz.popCtaType === 'booking') {
                    payload.ctaBookingType = wiz.popBookingType;
                    payload.eventTitle = wiz.popEventTitle;
                    payload.ctaLabel = 'Prenota';
                    payload.ctaUrl = null;
                } else {
                    payload.ctaUrl = null;
                    payload.ctaLabel = 'Chiudi';
                    payload.ctaBookingType = null;
                    payload.eventTitle = null;
                }
                if (wiz.editId) {
                    // come la tab Popup: ogni modifica ripresenta il popup a chi l'aveva chiuso
                    payload.version = increment(1);
                    await updateDoc(doc(db, 'popups', wiz.editId), payload);
                    toast('Popup aggiornato (verrà ri-mostrato a tutti).');
                } else {
                    await addDoc(collection(db, 'popups'), { ...payload, version: 1, ...auditCreate() });
                    toast('Popup creato.');
                }
            }
            mkCloseWizard();
        } catch (err) {
            console.error('[admin] mk save error:', err);
            if (errBox) {
                errBox.textContent = 'Salvataggio non riuscito: ' + (err.code || err.message);
                errBox.hidden = false;
            }
            if (btn) btn.disabled = false;
        }
    }

    /* ------------------------------ delega eventi ------------------------------ */

    panel.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-mk-action]');
        if (!btn) return;
        const action = btn.dataset.mkAction;
        try {
            if (action === 'open-wizard') {
                mkOpenWizard(null, null);
            } else if (action === 'close-wizard') {
                mkHarvestStep();
                mkCloseWizard();
            } else if (action === 'filter') {
                filter = btn.dataset.filter;
                render();
            } else if (action === 'edit-item') {
                mkOpenWizard(btn.dataset.type, btn.dataset.id);
            } else if (action === 'del-item') {
                const label = btn.dataset.label || '';
                const coll = { post: 'socialPosts', evento: 'events', popup: 'popups' }[btn.dataset.type];
                if (!coll) return;
                if (!confirm('Eliminare "' + label + '"? I file media su Storage restano disponibili.')) return;
                await deleteDoc(doc(db, coll, btn.dataset.id));
                toast('Eliminato.');
            } else if (action === 'toggle-active') {
                const coll = btn.dataset.type === 'evento' ? 'events' : 'popups';
                const list = btn.dataset.type === 'evento' ? mkEvents : mkPopups;
                const item = list.find((x) => x.id === btn.dataset.id);
                if (!item) return;
                const payload = { active: item.data.active === false, ...auditUpdate() };
                if (coll === 'popups') payload.version = increment(1);
                await updateDoc(doc(db, coll, btn.dataset.id), payload);
                toast(payload.active ? 'Attivato.' : 'Spento.');
            } else if (action === 'download') {
                const ext = btn.dataset.url.includes('.webm') ? '.webm' : btn.dataset.url.includes('.mp4') ? '.mp4' : '.png';
                await socDownload(btn.dataset.url, 'fonderia-' + socSlug(btn.dataset.label || 'media') + ext);
            } else if (action === 'edit-media') {
                if (!marketingBridge.openEditor) { toast('Editor non disponibile.', true); return; }
                marketingBridge.openEditor(btn.dataset.url, btn.dataset.kind === 'video' ? 'video' : 'image');
            } else if (action === 'wiz-type') {
                wiz.type = btn.dataset.type;
                mkPaintWizard();
            } else if (action === 'wiz-back') {
                mkHarvestStep();
                wiz.step = Math.max(1, wiz.step - 1);
                mkPaintWizard();
            } else if (action === 'wiz-next') {
                mkHarvestStep();
                if (wiz.step === 2) {
                    const msg = mkValidateStep2();
                    if (msg) { toast(msg, true); return; }
                }
                wiz.step = Math.min(4, wiz.step + 1);
                mkPaintWizard();
            } else if (action === 'wiz-save') {
                mkHarvestStep();
                await mkSave();
            } else if (action === 'wiz-copyai') {
                await mkCopyAI();
            } else if (action === 'wiz-aigen') {
                mkHarvestStep();
                // runAiImage chiama onUrl(url) a generazione riuscita: assegniamo
                // e ridisegniamo lo step per mostrare l'immagine scelta
                await runAiImage('mk', (url) => {
                    if (!wiz) return;
                    wiz.imageUrl = url;
                    mkPaintWizard();
                });
            } else if (action === 'wiz-picktoggle') {
                const box = $('mkPicker');
                if (!box) return;
                if (!box.hidden) { box.hidden = true; return; }
                const seen = new Set();
                const urls = [];
                mkPosts.forEach((p) => (p.data.assets || []).forEach((a) => {
                    if (!seen.has(a.url)) { seen.add(a.url); urls.push(a.url); }
                }));
                mkGfx.forEach((g) => {
                    if (!seen.has(g.data.url)) { seen.add(g.data.url); urls.push(g.data.url); }
                });
                LOCAL_IMAGES.forEach((src) => { if (!seen.has(src)) urls.push(src); });
                box.hidden = false;
                box.innerHTML = urls.length
                    ? urls.slice(0, 48).map((u) => `
                        <button type="button" class="adm-ed-pick" data-mk-action="wiz-pick" data-url="${esc(u)}">
                            <img src="${esc(u)}" alt="" loading="lazy"><span>scegli</span>
                        </button>`).join('')
                    : '<div class="adm-cell-muted">Ancora nessun media: genera o carica un\'immagine.</div>';
            } else if (action === 'wiz-pick') {
                wiz.imageUrl = btn.dataset.url;
                mkHarvestStep();
                mkPaintWizard();
            } else if (action === 'wiz-clearimg') {
                wiz.imageUrl = '';
                mkHarvestStep();
                mkPaintWizard();
            } else if (action === 'wiz-reel') {
                await mkMakeReel();
            } else if (action === 'wiz-veo') {
                await mkMakeVeo();
            } else if (action === 'wiz-edit-base') {
                if (!wiz || !wiz.imageUrl || !marketingBridge.openEditor) return;
                const w = wiz;
                marketingBridge.openEditor(wiz.imageUrl, 'image', (asset) => {
                    if (!wiz || wiz !== w) return;
                    if (w.type === 'post') {
                        w.assets.push(asset);
                    } else {
                        // evento/popup: l'immagine editata diventa LA grafica dell'elemento
                        w.imageUrl = asset.url;
                    }
                    w.statusLine = 'Grafica con logo/testi salvata ✓';
                });
            } else if (action === 'wiz-edit-asset') {
                const a = wiz && wiz.assets[Number(btn.dataset.idx)];
                if (!a || !marketingBridge.openEditor) return;
                const w = wiz;
                marketingBridge.openEditor(a.url, a.kind === 'video' ? 'video' : 'image', (asset) => {
                    if (!wiz || wiz !== w) return;
                    w.assets.push(asset); // la versione editata si aggiunge; l'originale resta rimovibile
                    w.statusLine = 'Versione con logo/testi salvata ✓';
                });
            } else if (action === 'wiz-del-asset') {
                wiz.assets.splice(Number(btn.dataset.idx), 1);
                mkHarvestStep();
                mkPaintWizard();
            }
        } catch (err) {
            console.error('[admin] marketing action error:', err);
            toast('Operazione non riuscita: ' + (err.code || err.message), true);
        }
    });

    // upload immagine dal wizard (input file viene ricreato a ogni repaint → delega su change)
    panel.addEventListener('change', (e) => {
        if (e.target.id === 'mkUpload' && e.target.files && e.target.files[0]) {
            mkUploadImage(e.target.files[0]);
        }
    });

    /* ------------------------------ snapshot dati ------------------------------ */

    // Il repaint non avviene mentre il wizard e' aperto (altrimenti perderebbe lo stato);
    // la lista sotto si aggiorna alla chiusura del wizard.
    const refreshIfIdle = () => { if (!wiz) render(); };
    unsubscribe.mkEvents = onSnapshot(
        query(collection(db, 'events'), orderBy('date', 'desc')),
        (snap) => { mkEvents = snap.docs.map((d) => ({ id: d.id, data: d.data() })); refreshIfIdle(); },
        (err) => console.error('[admin] mk events snapshot error:', err)
    );
    unsubscribe.mkPopups = onSnapshot(
        query(collection(db, 'popups'), orderBy('startDate', 'desc')),
        (snap) => { mkPopups = snap.docs.map((d) => ({ id: d.id, data: d.data() })); refreshIfIdle(); },
        (err) => console.error('[admin] mk popups snapshot error:', err)
    );
    unsubscribe.mkPosts = onSnapshot(
        query(collection(db, 'socialPosts'), orderBy('scheduledFor')),
        (snap) => { mkPosts = snap.docs.map((d) => ({ id: d.id, data: d.data() })); refreshIfIdle(); },
        (err) => console.error('[admin] mk posts snapshot error:', err)
    );
    unsubscribe.mkCampaigns = onSnapshot(
        query(collection(db, 'campaigns'), orderBy('name')),
        (snap) => { mkCampaigns = snap.docs.map((d) => ({ id: d.id, data: d.data() })); refreshIfIdle(); },
        (err) => console.error('[admin] mk campaigns snapshot error:', err)
    );
    try {
        // libreria grafica: lettura one-shot (non serve live)
        const gfxSnap = await getDocs(query(collection(db, 'graphicAssets'), orderBy('name')));
        mkGfx = gfxSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
    } catch (err) {
        console.error('[admin] mk graphicAssets load error:', err);
    }

    render();
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

// Autorizzazione via registro adminUsers/<email-lowercase> (status active).
// Un utente NON registrato non può nemmeno leggere adminUsers (rules) →
// il getDoc fallisce con permission-denied e viene trattato come non autorizzato.
// Ritorna { email, role } oppure false.
async function checkAuthorized(user) {
    try {
        const db = await getDb();
        const emailLc = (user.email || '').toLowerCase();
        const snap = await getDoc(doc(db, 'adminUsers', emailLc));
        if (snap.exists() && snap.data().status === 'active') {
            return { email: emailLc, role: snap.data().role === 'owner' ? 'owner' : 'editor' };
        }
    } catch (err) {
        console.error('[admin] adminUsers check error (trattato come non autorizzato):', err);
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
            const authz = await checkAuthorized(user);
            if (!authz) {
                admMark('email non in adminUsers → schermata "non autorizzato"');
                stopAll();
                showUnauthorized(user.email);
                return;
            }
            admMark('adminUsers OK (' + authz.role + ') → apro la shell');
            initShell(user, authz);
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
